import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as collector from '../collector.mjs';
import { computeNextRefreshDelay, createRenderWorker, stripAnsiAndNbsp } from '../hud.mjs';
import { resolveSpawnCommand } from './launch.mjs';
import { resolveQuotaCachePath } from './quota.mjs';

const require = createRequire(import.meta.url);
const NATIVE_LOAD_ERROR_RE = /^Failed to load native module: (?:pty|conpty)\.node, checked: /u;
const UNFINISHED_INPUT_RE = /\x1b(?:\[[0-?]*[ -/]*|O)?$/u;
const ANSI_TOKEN_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/y;
const SGR_RE = /^\x1b\[([0-9;]*)m$/;
const OSC8_RE = /^\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)$/;
const BORDER_LINE_RE = /^\s{0,4}[╭╰┌└├]?[─━-]{10,}[╮╯┐┘┤]?\s*$/u;
const WELCOME_SCREEN_RE = /Welcome to (?:the )?Antigravity CLI|Select login method:/i;
const MODAL_BOX_LINE_RE = /^\s*[╭╰┌└│].*[╮╯┐┘│]\s*$/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const DEFAULT_ESC_FLUSH_MS = 24;
const SILENCE_THRESHOLD_MS = 100;
const SYNC_LOCK_TIMEOUT_MS = 1000;
const MAX_PTY_BUFFER_BYTES = 512 * 1024;
const RESUME_PTY_BUFFER_BYTES = 256 * 1024;
const MAX_WIN32_PENDING_PARAM_LEN = 64;
const STTY_TIMEOUT_MS = 1000;
const SAFE_STTY_STATE_RE = /^[A-Za-z0-9][A-Za-z0-9:=._+-]*$/;

export class TerminalDependencyError extends Error {
  constructor(cause) {
    super('Could not load terminal dependencies.', { cause });
    this.name = 'TerminalDependencyError';
  }
}

function loadTerminalDependency(name) {
  try {
    return require(name);
  } catch (error) {
    if (['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(error?.code) || NATIVE_LOAD_ERROR_RE.test(error?.message ?? '')) {
      throw new TerminalDependencyError(error);
    }
    throw error;
  }
}

export function closePtyHandle(ptyProcess, platform = process.platform) {
  if (platform !== 'win32' || !ptyProcess) return;
  let agent;
  try { agent = ptyProcess._agent; } catch { return; }
  if (!agent) return;
  let worker;
  try { worker = agent._conoutSocketWorker; } catch {}
  for (const step of [
    () => clearTimeout(agent._connectionTimeout),
    () => clearTimeout(agent._closeTimeout),
    () => agent._inSocket?.destroy?.(),
    () => agent._outSocket?.destroy?.(),
    () => worker?.dispose?.(),
    () => worker?._drainTimeout?.unref?.(),
    () => worker?._worker?.unref?.(),
  ]) {
    try { step(); } catch {}
  }
}

/**
 * Enters raw stdin mode and disables POSIX OPOST/ONLCR output post-processing so
 * bare LF cursor moves from inner Bubble Tea / Ultraviolet TUIs are not expanded to CRLF.
 */
export function enterRawOutputMode({
  platform = process.platform,
  stdin = process.stdin,
  stdout = process.stdout,
  wasRaw = Boolean(stdin?.isRaw),
  fd = stdin?.fd,
  execFileSyncFn = execFileSync,
} = {}) {
  const canControlOpost = platform !== 'win32'
    && Boolean(stdin?.isTTY && stdout?.isTTY)
    && Number.isInteger(fd)
    && fd >= 0
    && typeof execFileSyncFn === 'function';

  const setSttyMode = (args) => {
    try {
      execFileSyncFn('stty', args, {
        stdio: [fd, 'ignore', 'ignore'],
        timeout: STTY_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  };

  let savedState = '';
  if (canControlOpost) {
    try {
      const raw = execFileSyncFn('stty', ['-g'], {
        stdio: [fd, 'pipe', 'ignore'],
        encoding: 'utf8',
        timeout: STTY_TIMEOUT_MS,
      });
      const rawStr = typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : '';
      const trimmed = rawStr.replace(/(?:\r?\n)+$/u, '');
      if (SAFE_STTY_STATE_RE.test(trimmed)) {
        savedState = trimmed;
      }
    } catch {}
  }

  stdin?.setRawMode?.(true);

  const opostDisabled = canControlOpost ? setSttyMode(['-opost']) : false;

  let restored = false;
  return function restoreRawOutputMode() {
    if (restored) return;
    restored = true;
    try { stdin?.setRawMode?.(wasRaw); } catch {}
    if (canControlOpost && opostDisabled) {
      setSttyMode([savedState || 'opost']);
    }
  };
}

export function stripWin32InputMode(chunk, pendingState = { pending: '' }) {
  const text = typeof chunk === 'string'
    ? chunk
    : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
      ? Buffer.from(chunk).toString('utf8')
      : String(chunk ?? '');
  const input = (pendingState.pending || '') + text;
  pendingState.pending = '';
  if (!input) return '';

  let out = '';
  let i = 0;
  while (i < input.length) {
    const esc = input.indexOf('\x1b', i);
    if (esc === -1) {
      out += input.slice(i);
      break;
    }
    if (esc > i) {
      out += input.slice(i, esc);
      i = esc;
    }
    if (i + 1 === input.length) {
      pendingState.pending = '\x1b';
      break;
    }
    if (input[i + 1] !== '[') {
      out += '\x1b';
      i += 1;
      continue;
    }
    if (i + 2 === input.length) {
      pendingState.pending = '\x1b[';
      break;
    }
    if (input[i + 2] !== '?') {
      out += '\x1b[';
      i += 2;
      continue;
    }
    let j = i + 3;
    while (
      j < input.length
      && j - (i + 3) < MAX_WIN32_PENDING_PARAM_LEN
      && ((input[j] >= '0' && input[j] <= '9') || input[j] === ';')
    ) {
      j += 1;
    }
    if (j === input.length && j - (i + 3) < MAX_WIN32_PENDING_PARAM_LEN) {
      pendingState.pending = input.slice(i);
      break;
    }
    if (j - (i + 3) >= MAX_WIN32_PENDING_PARAM_LEN) {
      out += input.slice(i, j);
      i = j;
      continue;
    }
    const final = input[j];
    if (final === 'h' || final === 'l') {
      const params = input.slice(i + 3, j).split(';');
      if (params.includes('9001')) {
        const kept = params.filter((p) => p !== '9001' && p !== '');
        if (kept.length > 0) {
          out += `\x1b[?${kept.join(';')}${final}`;
        }
        i = j + 1;
        continue;
      }
    }
    out += input.slice(i, j + 1);
    i = j + 1;
  }
  return out;
}

export function createInputBuffer(onWrite, escFlushDelayMs = DEFAULT_ESC_FLUSH_MS) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let timer = null;
  let disposed = false;

  const flushPending = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!disposed && pending) {
      const data = pending;
      pending = '';
      onWrite(data);
    }
  };

  return {
    push(chunk) {
      if (disposed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const decoded = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (!decoded && !pending) return;
      const combined = pending + decoded;
      const tail = UNFINISHED_INPUT_RE.exec(combined)?.[0] ?? '';
      pending = tail;
      const ready = tail ? combined.slice(0, combined.length - tail.length) : combined;
      if (ready) onWrite(ready);
      if (pending) {
        timer = setTimeout(flushPending, escFlushDelayMs);
      }
    },
    flush: flushPending,
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = '';
      try { decoder.end(); } catch {}
    },
  };
}

function isWideCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeDisplayWidth(grapheme) {
  if (/^\p{Control}$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  let width = 0;
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0) ?? 0;
    const isModifier = /^\p{Mark}$/u.test(ch)
      || ch === '\u200d'
      || (cp >= 0xfe00 && cp <= 0xfe0f)
      || (cp >= 0xe0100 && cp <= 0xe01ef);
    if (isModifier) continue;
    width = Math.max(width, isWideCodePoint(cp) ? 2 : 1);
  }
  return width;
}

function tokenizeAnsi(str) {
  const tokens = [];
  let start = 0;
  let idx = str.indexOf('\x1b');
  while (idx !== -1) {
    ANSI_TOKEN_RE.lastIndex = idx;
    const match = ANSI_TOKEN_RE.exec(str);
    if (!match) {
      idx = str.indexOf('\x1b', idx + 1);
      continue;
    }
    if (idx > start) tokens.push({ text: str.slice(start, idx), escape: false });
    tokens.push({ text: match[0], escape: true });
    start = idx + match[0].length;
    idx = str.indexOf('\x1b', start);
  }
  if (start < str.length) tokens.push({ text: str.slice(start), escape: false });
  return tokens;
}

export function visibleDisplayWidth(str) {
  let width = 0;
  for (const token of tokenizeAnsi(str)) {
    if (token.escape) continue;
    for (const { segment } of GRAPHEMES.segment(token.text)) {
      width += graphemeDisplayWidth(segment);
    }
  }
  return width;
}

export function truncateAnsiToWidth(str, maxWidth) {
  const clean = String(str ?? '').replace(/\u00A0/g, ' ').replace(/[\r\n]/g, '');
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return '';
  if (visibleDisplayWidth(clean) <= maxWidth) {
    let sgrOpen = false;
    let inLink = false;
    for (const token of tokenizeAnsi(clean)) {
      if (!token.escape) continue;
      const sgr = SGR_RE.exec(token.text);
      if (sgr) {
        const params = sgr[1];
        sgrOpen = !(params === '' || params === '0');
        continue;
      }
      const osc = OSC8_RE.exec(token.text);
      if (osc) inLink = osc[1] !== '';
    }
    let out = clean;
    if (inLink) out += '\x1b]8;;\x1b\\';
    if (sgrOpen) out += '\x1b[0m';
    return out;
  }

  const suffix = maxWidth >= 2 ? '…' : '';
  const budget = maxWidth - suffix.length;
  let out = '';
  let used = 0;
  let sgrOpen = false;
  let inLink = false;

  outer: for (const token of tokenizeAnsi(clean)) {
    if (token.escape) {
      const sgr = SGR_RE.exec(token.text);
      if (sgr) {
        sgrOpen = !(sgr[1] === '' || sgr[1] === '0');
        out += token.text;
        continue;
      }
      const osc = OSC8_RE.exec(token.text);
      if (osc) {
        inLink = osc[1] !== '';
        out += token.text;
      }
      continue;
    }
    for (const { segment } of GRAPHEMES.segment(token.text)) {
      const w = graphemeDisplayWidth(segment);
      if (used + w > budget) break outer;
      used += w;
      out += segment;
    }
  }

  if (inLink) out += '\x1b]8;;\x1b\\';
  if (suffix) out += suffix;
  if (sgrOpen || out.includes('\x1b[')) out += '\x1b[0m';
  return out;
}

function normalizeHudFingerprint(line) {
  return stripAnsiAndNbsp(line)
    .trim()
    .replace(/│/g, '|')
    .replace(/\s+/g, ' ')
    .replace(/[█░]{2,}/g, 'BAR')
    .replace(/[#-]{3,}/g, 'BAR')
    .replace(/\d+/g, '#');
}

function isBorderLine(plainLine) {
  return BORDER_LINE_RE.test(String(plainLine ?? ''));
}

function isWelcomeViewport(plain) {
  const joined = plain.join('\n');
  return WELCOME_SCREEN_RE.test(joined);
}

function matchesLineFingerprint(screenLine, refLine) {
  const sTrim = stripAnsiAndNbsp(screenLine).trim();
  const rTrim = stripAnsiAndNbsp(refLine).trim();
  if (!rTrim) return sTrim === '';
  if (!sTrim) return false;
  if (sTrim === rTrim) return true;
  if (isBorderLine(sTrim) && isBorderLine(rTrim)) return true;

  const sNorm = normalizeHudFingerprint(sTrim);
  const rNorm = normalizeHudFingerprint(rTrim);
  if (sNorm === rNorm) return true;
  if (sNorm.length >= 10 && rNorm.length >= 10) {
    const minPrefix = Math.min(18, Math.floor(Math.min(sNorm.length, rNorm.length) * 0.75));
    if (sNorm.slice(0, minPrefix) === rNorm.slice(0, minPrefix)) return true;
  }

  const badgeRe = /^(\[[^\]]{2,}\])/;
  const sb = badgeRe.exec(sNorm)?.[1];
  const rb = badgeRe.exec(rNorm)?.[1];
  if (sb && rb && sb === rb) return true;

  return false;
}

function matchCandidateAt(plain, start, refsList, { alternate, cursorY, previousSlot, rows, strictFallback = false }) {
  if (!alternate && start <= cursorY) return null;
  if (start < 0 || start >= rows) return null;

  for (const refLines of refsList) {
    if (!Array.isArray(refLines) || refLines.length === 0) continue;
    const prevCount = previousSlot?.slotStart === start ? previousSlot.slotCount : 0;
    const maxCheck = Math.min(rows - start, Math.max(refLines.length, prevCount));
    if (maxCheck <= 0) continue;

    if (!matchesLineFingerprint(plain[start], refLines[0])) {
      continue;
    }

    let matchedCount = 1;
    let nonEmptyRefs = stripAnsiAndNbsp(refLines[0]).trim() ? 1 : 0;
    let slotCount = 1;
    let blockedByForeign = false;

    for (let i = 1; i < maxCheck; i++) {
      const sLine = plain[start + i] ?? '';
      const sTrim = stripAnsiAndNbsp(sLine).trim();
      const hasRef = i < refLines.length;
      const rLine = hasRef ? refLines[i] : '';
      const rTrim = stripAnsiAndNbsp(rLine).trim();
      if (rTrim) nonEmptyRefs += 1;

      if (hasRef && rTrim && matchesLineFingerprint(sLine, rLine)) {
        matchedCount += 1;
        slotCount = i + 1;
      } else if (!sTrim && (prevCount > i || !hasRef)) {
        if (prevCount > i) slotCount = i + 1;
      } else if (!sTrim && hasRef && i < refLines.length) {
        // Screen cleared trailing line below matched HUD rows
        slotCount = i + 1;
      } else if (sTrim) {
        // Non-empty line that doesn't match refLines[i]
        const matchesOtherRef = refsList.some((alt) => alt !== refLines && alt[i] && matchesLineFingerprint(sLine, alt[i]));
        if (matchesOtherRef) {
          matchedCount += 1;
          slotCount = i + 1;
        } else {
          blockedByForeign = true;
          break;
        }
      }
    }

    if (strictFallback && nonEmptyRefs >= 2 && matchedCount < 2) continue;
    if (strictFallback && nonEmptyRefs === 1 && MODAL_BOX_LINE_RE.test(plain[start] ?? '')) continue;
    if (blockedByForeign && matchedCount === 1 && nonEmptyRefs > 1) continue;

    if (prevCount > slotCount && !blockedByForeign) {
      slotCount = Math.min(prevCount, rows - start);
    }
    return { slotStart: start, slotCount, matchedCount };
  }
  return null;
}

export function findHudSlots(screen, options = {}) {
  const plain = Array.isArray(screen?.plain) ? screen.plain : [];
  const rows = Number.isInteger(screen?.rows) ? screen.rows : plain.length;
  const cursorY = Number.isInteger(screen?.cursorY) ? screen.cursorY : 0;
  const alternate = Boolean(screen?.alternate);
  const { snapshotLines = [], previousLines = [], previousSlot = null } = options;

  const refsList = [snapshotLines, previousLines].filter((arr) => Array.isArray(arr) && arr.length > 0);
  if (refsList.length === 0 || rows <= 0) return null;

  const borderRows = [];
  for (let r = 0; r < rows; r++) {
    if (isBorderLine(plain[r])) borderRows.push(r);
  }

  const maxBoxHeight = Math.max(20, Math.floor(rows * 0.75));
  const cursorPairedBottoms = [];
  const otherPairedBottoms = [];

  for (let b = borderRows.length - 1; b >= 0; b--) {
    const bottom = borderRows[b];
    let hasTopAroundCursor = false;
    let hasAnyTop = false;
    for (let t = b - 1; t >= 0; t--) {
      const top = borderRows[t];
      const height = bottom - top;
      if (height < 2) continue;
      if (height > maxBoxHeight) break;
      hasAnyTop = true;
      if (top < cursorY && cursorY < bottom) {
        hasTopAroundCursor = true;
        break;
      }
    }
    if (hasTopAroundCursor) cursorPairedBottoms.push(bottom);
    else if (hasAnyTop) otherPairedBottoms.push(bottom);
  }

  const candidateBottoms = alternate
    ? [...cursorPairedBottoms, ...otherPairedBottoms]
    : cursorPairedBottoms;

  for (const bottomBorder of candidateBottoms) {
    const direct = matchCandidateAt(plain, bottomBorder + 1, refsList, {
      alternate,
      cursorY,
      previousSlot,
      rows,
    });
    if (direct) {
      return { ...direct, stacked: false, bottomBorder, alternate };
    }

    const gapLine = plain[bottomBorder + 1] ?? '';
    const gapTrim = stripAnsiAndNbsp(gapLine).trim();
    if (gapTrim && !isBorderLine(gapLine) && !MODAL_BOX_LINE_RE.test(gapLine)) {
      const stacked = matchCandidateAt(plain, bottomBorder + 2, refsList, {
        alternate,
        cursorY,
        previousSlot,
        rows,
      });
      if (stacked) {
        return { ...stacked, stacked: true, bottomBorder, alternate };
      }
    }
  }

  if (isWelcomeViewport(plain)) return null;

  // Fallback for borderless or single-border themes when HUD fingerprint matches cleanly
  const minRow = alternate ? 0 : Math.max(0, cursorY + 1);
  for (let start = rows - 1; start >= minRow; start--) {
    if (MODAL_BOX_LINE_RE.test(plain[start] ?? '')) continue;
    const hit = matchCandidateAt(plain, start, refsList, {
      alternate,
      cursorY,
      previousSlot,
      rows,
      strictFallback: true,
    });
    if (hit) {
      return { ...hit, stacked: false, bottomBorder: -1, alternate };
    }
  }

  return null;
}

export function buildOverlayWrite({
  slotStart,
  slotCount,
  targetLines,
  currentLines = [],
  cursorY,
  alternate = false,
  cols = 80,
  cursorVisible = true,
  wraparound = true,
}) {
  if (!Number.isInteger(slotStart) || slotStart < 0 || !Number.isInteger(slotCount) || slotCount <= 0) {
    return { sequence: '', writtenLines: [], changed: false };
  }
  if (!alternate && (!Number.isInteger(cursorY) || slotStart <= cursorY)) {
    return { sequence: '', writtenLines: [], changed: false };
  }

  const rawTarget = Array.isArray(targetLines) ? targetLines : [];
  const desiredLines = [];
  for (let i = 0; i < slotCount; i++) {
    if (i < rawTarget.length) {
      desiredLines.push(truncateAnsiToWidth(rawTarget[i], cols));
    } else {
      desiredLines.push('');
    }
  }

  const changedIndices = [];
  for (let i = 0; i < slotCount; i++) {
    const cur = currentLines[i];
    if (cur !== desiredLines[i]) {
      changedIndices.push(i);
    }
  }

  if (changedIndices.length === 0) {
    return { sequence: '', writtenLines: desiredLines, changed: false };
  }

  let body = '';
  if (alternate) {
    for (const i of changedIndices) {
      const row = slotStart + i;
      body += `\x1b[${row + 1};1H\x1b[2K${desiredLines[i]}`;
    }
  } else {
    let cur = cursorY;
    for (const i of changedIndices) {
      const targetRow = slotStart + i;
      const step = targetRow - cur;
      body += `\x1b[${step}B\r\x1b[2K${desiredLines[i]}`;
      cur = targetRow;
    }
  }

  const restoreWrap = wraparound ? '\x1b[?7h' : '\x1b[?7l';
  const restoreCursor = cursorVisible ? '\x1b[?25h' : '\x1b[?25l';
  const sequence = `\x1b[?25l\x1b7\x1b[?7l${body}\x1b[0m\x1b8${restoreWrap}${restoreCursor}`;
  return { sequence, writtenLines: desiredLines, changed: true };
}

function readMirrorScreen(terminal, cursorVisible) {
  const buffer = terminal.buffer.active;
  const plain = [];
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    plain.push(line ? line.translateToString(true) : '');
  }
  return {
    plain,
    rows: terminal.rows,
    cols: terminal.cols,
    cursorY: buffer.cursorY,
    cursorX: buffer.cursorX,
    cursorVisible,
    alternate: buffer.type === 'alternate',
  };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getFileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function watchFileInDirectory(targetPath, onChange) {
  if (!targetPath) return null;
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, (_eventType, filename) => {
      if (!filename || String(filename) === base) onChange();
    });
    watcher.on('error', () => {});
    return watcher;
  } catch {
    return null;
  }
}

export async function runPtyHost({
  file,
  args = [],
  env = process.env,
  cwd = process.cwd(),
  hostStatePath,
  stdin = process.stdin,
  stdout = process.stdout,
  initialStatePollMs = 1000,
  platform = process.platform,
  execFileSyncFn = execFileSync,
  spawnPty,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY) {
    throw new Error('Interactive PTY host requires a TTY.');
  }

  const { Terminal } = loadTerminalDependency('@xterm/headless');
  const spawn = spawnPty ?? loadTerminalDependency('node-pty').spawn;
  const ptyPlatform = spawnPty ? platform : process.platform;

  const getDimensions = () => ({
    columns: Math.max(20, Math.min(500, stdout.columns || 80)),
    rows: Math.max(5, Math.min(200, stdout.rows || 24)),
  });

  let { columns, rows } = getDimensions();
  const terminal = new Terminal({ cols: columns, rows, scrollback: 200, allowProposedApi: true });
  const childEnv = {
    ...env,
    ...(hostStatePath ? { AGY_HUD_HOST_STATE: hostStatePath } : {}),
  };

  const spawnTarget = resolveSpawnCommand(file, args, { env, platform: ptyPlatform, verbatimString: true });
  let child;
  try {
    child = spawn(spawnTarget.file, spawnTarget.args, {
      cwd,
      env: childEnv,
      name: env.TERM || 'xterm-256color',
      cols: columns,
      rows,
    });
  } catch (error) {
    terminal.dispose();
    if (ptyPlatform === 'win32' && NATIVE_LOAD_ERROR_RE.test(error?.message ?? '')) {
      throw new TerminalDependencyError(error);
    }
    throw error;
  }

  const paths = collector.agyPaths(env);
  const quotaCachePath = resolveQuotaCachePath(env, paths.home);
  const renderWorker = createRenderWorker({ env, paths });

  const wasRaw = Boolean(stdin.isRaw);
  const wasFlowing = stdin.readableFlowing === true;
  const win32StripState = { pending: '' };
  const subscriptions = [];
  const watchers = [];

  let cursorVisible = true;
  let syncUntil = 0;
  let bufferedBytes = 0;
  let paused = false;
  let lastOutputAt = 0;
  let stopped = false;
  let exited = false;
  let signaling = false;
  let outputFailure = false;
  let refreshInFlight = false;
  let refreshQueued = false;

  let latestState = null;
  let previousStatePlain = [];
  let latestStateTerminalCols = columns;
  let lastStateMtimeMs = 0;
  let lastQuotaMtimeMs = getFileMtimeMs(quotaCachePath);

  let activeSlot = null;
  let mirrorBaseline = null;
  let paintedLines = null;
  let childOutputSeq = 0;
  let paintedOutputSeq = 0;

  let refreshTimer = null;
  let silenceTimer = null;
  let watchDebounceTimer = null;
  let initialStatePollTimer = null;

  const clearInitialStatePoll = () => {
    if (!initialStatePollTimer) return;
    clearInterval(initialStatePollTimer);
    initialStatePollTimer = null;
  };

  const inputBuffer = createInputBuffer((data) => {
    if (exited || stopped) return;
    try {
      child.write(data);
    } catch {}
  });

  const scheduleNextTick = (delayMs) => {
    if (stopped || exited) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void requestRefresh();
    }, Math.max(20, delayMs));
  };

  const syncHostStateFromDisk = () => {
    if (!hostStatePath) return false;
    const mtime = getFileMtimeMs(hostStatePath);
    if (!mtime || mtime === lastStateMtimeMs) return false;
    const next = readJsonSafe(hostStatePath);
    if (!next || typeof next !== 'object') return false;
    lastStateMtimeMs = mtime;
    if (latestState?.plainLines) previousStatePlain = latestState.plainLines;
    latestState = next;
    latestStateTerminalCols = columns;
    clearInitialStatePoll();
    return true;
  };

  const scheduleByState = (now = Date.now()) => {
    const quotaCache = readJsonSafe(quotaCachePath);
    const delay = computeNextRefreshDelay({
      ...latestState,
      quotaCache,
      expiresAt: quotaCache?.expiresAt,
      lastRefreshed: quotaCache?.lastRefreshed,
    }, now);
    scheduleNextTick(delay);
  };

  const requestRefresh = async () => {
    if (stopped || exited) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    syncHostStateFromDisk();
    if (!latestState?.stdin) return;

    const now = Date.now();
    if (terminal.modes.synchronizedOutputMode && now < syncUntil) {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => { void requestRefresh(); }, Math.min(200, Math.max(20, syncUntil - now)));
      return;
    }

    const sinceOutput = now - lastOutputAt;
    if (sinceOutput < SILENCE_THRESHOLD_MS) {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => { void requestRefresh(); }, SILENCE_THRESHOLD_MS - sinceOutput + 5);
      return;
    }

    refreshInFlight = true;
    try {
      const margin = typeof latestState.cols === 'number' && latestState.cols > 0 && latestStateTerminalCols > latestState.cols
        ? Math.min(16, latestStateTerminalCols - latestState.cols)
        : 0;
      const workerCols = Math.max(1, columns - margin);
      const renderNow = Date.now();
      const rendered = await renderWorker.renderSnapshot(latestState.stdin, { now: renderNow, cols: workerCols });
      if (stopped || exited) return;

      const { screen, screenOutputSeq } = await new Promise((resolve) => {
        terminal.write('', () => resolve({
          screen: readMirrorScreen(terminal, cursorVisible),
          screenOutputSeq: childOutputSeq,
        }));
      });
      if (stopped || exited) return;

      // Recheck silence/sync after async render
      if ((terminal.modes.synchronizedOutputMode && Date.now() < syncUntil) || Date.now() - lastOutputAt < SILENCE_THRESHOLD_MS) {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => { void requestRefresh(); }, SILENCE_THRESHOLD_MS);
        return;
      }

      const slot = findHudSlots(screen, {
        snapshotLines: latestState.plainLines ?? [],
        previousLines: previousStatePlain,
        previousSlot: activeSlot,
      });

      if (!slot) {
        activeSlot = null;
        mirrorBaseline = null;
        paintedLines = null;
      } else {
        const currentMirrorSlice = screen.plain
          .slice(slot.slotStart, slot.slotStart + slot.slotCount)
          .map((l) => stripAnsiAndNbsp(l).trimEnd());

        const mirrorChanged = !activeSlot
          || activeSlot.slotStart !== slot.slotStart
          || activeSlot.slotCount !== slot.slotCount
          || !mirrorBaseline
          || currentMirrorSlice.some((line, i) => line !== mirrorBaseline[i]);

        let currentLines;
        if (
          !mirrorChanged
          && screenOutputSeq === paintedOutputSeq
          && Array.isArray(paintedLines)
          && paintedLines.length === slot.slotCount
        ) {
          currentLines = paintedLines;
        } else {
          // Initialize from the latest snapshot lines only on strict plain-text match, else plain slice
          const snapLines = Array.isArray(latestState.lines) ? latestState.lines : [];
          currentLines = Array.from({ length: slot.slotCount }, (_, i) => {
            if (
              i < snapLines.length
              && stripAnsiAndNbsp(currentMirrorSlice[i] ?? '').trimEnd()
                === stripAnsiAndNbsp(truncateAnsiToWidth(snapLines[i], columns)).trimEnd()
            ) {
              return truncateAnsiToWidth(snapLines[i], columns);
            }
            return currentMirrorSlice[i] ?? '';
          });
        }

        const overlay = buildOverlayWrite({
          slotStart: slot.slotStart,
          slotCount: slot.slotCount,
          targetLines: rendered.lines,
          currentLines,
          cursorY: screen.cursorY,
          alternate: slot.alternate,
          cols: columns,
          cursorVisible: screen.cursorVisible,
          wraparound: terminal.modes.wraparoundMode,
        });

        activeSlot = { slotStart: slot.slotStart, slotCount: slot.slotCount };
        mirrorBaseline = currentMirrorSlice;
        paintedLines = overlay.writtenLines;

        if (overlay.changed && overlay.sequence && !outputFailure) {
          stdout.write(overlay.sequence);
          paintedOutputSeq = screenOutputSeq;
        }
      }

      scheduleByState(Date.now());
    } catch {
      scheduleByState(Date.now());
    } finally {
      refreshInFlight = false;
      if (refreshQueued && !stopped && !exited) {
        refreshQueued = false;
        void requestRefresh();
      }
    }
  };

  const triggerWatchedChange = (immediate = false) => {
    if (stopped || exited) return;
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(() => {
      const stateChanged = syncHostStateFromDisk();
      const quotaMtime = getFileMtimeMs(quotaCachePath);
      const quotaChanged = quotaMtime !== lastQuotaMtimeMs;
      if (quotaChanged) lastQuotaMtimeMs = quotaMtime;
      if (stateChanged || quotaChanged || immediate) {
        void requestRefresh();
      }
    }, immediate ? 10 : 30);
  };

  const onStdinData = (chunk) => inputBuffer.push(chunk);

  const onResize = () => {
    if (stopped || exited) return;
    const next = getDimensions();
    if (next.columns === columns && next.rows === rows) return;
    ({ columns, rows } = next);
    try { terminal.resize(columns, rows); } catch {}
    try { child.resize(columns, rows); } catch {}
    activeSlot = null;
    mirrorBaseline = null;
    paintedLines = null;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => { void requestRefresh(); }, 150);
  };

  const stopChild = (signal) => {
    if (exited || stopped || signaling) return;
    signaling = true;
    try {
      if (ptyPlatform === 'win32') child.kill();
      else child.kill(signal);
    } catch {} finally {
      signaling = false;
    }
  };

  const onInterrupt = () => stopChild('SIGINT');
  const onHangup = () => stopChild('SIGHUP');
  const onTerminate = () => stopChild('SIGTERM');
  const onOutputError = () => {
    outputFailure = true;
    stopChild('SIGHUP');
  };

  const completed = new Promise((resolve) => {
    subscriptions.push(child.onExit(({ exitCode, signal }) => {
      exited = true;
      inputBuffer.dispose();
      terminal.write('', () => {
        const trailing = win32StripState.pending;
        win32StripState.pending = '';
        if (trailing && !outputFailure) {
          try { stdout.write(trailing); } catch {}
        }
        resolve(signal ? 128 + signal : (exitCode ?? 0));
      });
    }));
  });

  let restoreRawMode = () => {
    try { stdin.setRawMode?.(wasRaw); } catch {}
  };

  try {
    restoreRawMode = enterRawOutputMode({
      platform,
      stdin,
      stdout,
      wasRaw,
      execFileSyncFn,
    });
    stdout.on('error', onOutputError);
    stdin.on('data', onStdinData);
    stdin.resume();
    stdout.on('resize', onResize);
    process.on('SIGINT', onInterrupt);
    process.on('SIGHUP', onHangup);
    process.on('SIGTERM', onTerminate);

    subscriptions.push(
      ...['h', 'l'].map((final) => terminal.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(25)) cursorVisible = final === 'h';
        if (params.includes(2026)) {
          if (final === 'h') {
            syncUntil = Date.now() + SYNC_LOCK_TIMEOUT_MS;
          } else {
            syncUntil = 0;
            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => { void requestRefresh(); }, SILENCE_THRESHOLD_MS + 5);
          }
        }
        return false;
      })),
      child.onData((data) => {
        lastOutputAt = Date.now();
        const out = stripWin32InputMode(data, win32StripState);
        if (out && !outputFailure) {
          try {
            stdout.write(out);
            childOutputSeq += 1;
          } catch {
            onOutputError();
          }
        }

        bufferedBytes += data.length;
        if (bufferedBytes >= MAX_PTY_BUFFER_BYTES && !paused) {
          paused = true;
          try { child.pause(); } catch {}
        }
        terminal.write(data, () => {
          bufferedBytes = Math.max(0, bufferedBytes - data.length);
          if (paused && bufferedBytes < RESUME_PTY_BUFFER_BYTES && !exited && !stopped) {
            paused = false;
            try { child.resume(); } catch {}
          }
        });

        if (latestState?.stdin) {
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => { void requestRefresh(); }, SILENCE_THRESHOLD_MS + 5);
        }
      }),
    );

    if (hostStatePath) {
      const wState = watchFileInDirectory(hostStatePath, () => triggerWatchedChange(false));
      if (wState) watchers.push(wState);

      if (syncHostStateFromDisk()) {
        scheduleByState(Date.now());
        void requestRefresh();
      } else if (!latestState) {
        const pollMs = Math.max(20, initialStatePollMs);
        initialStatePollTimer = setInterval(() => {
          if (stopped || exited) {
            clearInitialStatePoll();
            return;
          }
          if (syncHostStateFromDisk()) {
            scheduleByState(Date.now());
            void requestRefresh();
          }
        }, pollMs);
        initialStatePollTimer.unref?.();
      }
    }
    if (quotaCachePath) {
      const wQuota = watchFileInDirectory(quotaCachePath, () => triggerWatchedChange(true));
      if (wQuota) watchers.push(wQuota);
    }

    return await completed;
  } finally {
    if (!exited) stopChild('SIGTERM');
    stopped = true;
    clearTimeout(refreshTimer);
    clearTimeout(silenceTimer);
    clearTimeout(watchDebounceTimer);
    clearInitialStatePoll();
    inputBuffer.dispose();
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
    for (const sub of subscriptions) {
      try { sub.dispose(); } catch {}
    }
    stdin.off('data', onStdinData);
    if (!wasFlowing) try { stdin.pause(); } catch {}
    restoreRawMode();
    stdout.off('resize', onResize);
    process.off('SIGINT', onInterrupt);
    process.off('SIGHUP', onHangup);
    process.off('SIGTERM', onTerminate);

    if (!outputFailure) {
      try {
        const wasAlternate = terminal.buffer.active.type === 'alternate';
        const resetMouseAndModes = [1, 9, 1000, 1002, 1003, 1004, 1006, 2004]
          .map((m) => `\x1b[?${m}l`)
          .join('');
        const leaveAlt = wasAlternate ? '\x1b[?1049l' : '';
        if (
          wasAlternate
          || !cursorVisible
          || !terminal.modes.wraparoundMode
          || terminal.modes.mouseTrackingMode !== 'none'
          || terminal.modes.sendFocusMode
          || terminal.modes.bracketedPasteMode
          || terminal.modes.applicationCursorKeysMode
        ) {
          stdout.write(`${resetMouseAndModes}\x1b[0m${leaveAlt}\x1b[?7h\x1b[?25h`);
        }
      } catch {}
    }

    stdout.off('error', onOutputError);
    try { renderWorker.close(); } catch {}
    try { terminal.dispose(); } catch {}
    try { closePtyHandle(child, ptyPlatform); } catch {}
  }
}
