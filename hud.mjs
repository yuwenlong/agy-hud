import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as collector from './collector.mjs';
import { isHudDisabled } from './runtime/paths.mjs';

export { isHudDisabled };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOGIC = path.join(ROOT, 'src', 'main.ts');
const FENCE = pathToFileURL(path.join(ROOT, 'fence.mjs')).href;
const MAX_OUTPUT_BYTES = 64 * 1024;
const WALL_MS = 10_000;

const upgradeLine = (runtime) => `agy-hud needs Node 22.18+ (this is ${runtime}). Type /hud to fix it.`;

// Whole escape sequences (CSI, OSC, other ESC), then single control and bidi characters.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]?|[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;
const UNSAFE_LINK_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const SGR = /^\x1b\[[0-9;]*m$/;
const OSC8 = /^\x1b\]8;;(.*)\x1b\\$/s;
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

export function terminalFilter(stdin, fallbackRepo = null) {
  const repo = stdin?.workspace?.repo ?? fallbackRepo;
  const pages = repo?.host === 'github.com' && GITHUB_NAME.test(repo.owner ?? '') && GITHUB_NAME.test(repo.name ?? '')
    ? `https://github.com/${repo.owner}/${repo.name}/`
    : null;
  const linkAllowed = (target) => {
    if (target === '') return true;
    if (UNSAFE_LINK_CHARS.test(target)) return false;
    try {
      const url = new URL(target);
      return url.protocol === 'file:' || (pages !== null && url.href === target && target.startsWith(pages));
    } catch {
      return false;
    }
  };
  const keep = (sequence) => {
    const link = OSC8.exec(sequence);
    return SGR.test(sequence) || (link !== null && linkAllowed(link[1]));
  };
  return (line) => String(line).replace(ESCAPES, (sequence) => (keep(sequence) ? sequence : ''));
}

export function stripAnsiAndNbsp(line) {
  return String(line).replace(ESCAPES, '').replace(/\u00A0/g, ' ');
}

function materializeStdinQuotaResets(stdin, capturedAt = Date.now()) {
  const quota = stdin?.quota;
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return stdin;
  let nextQuota = null;
  for (const [key, bucket] of Object.entries(quota)) {
    if (!bucket || typeof bucket !== 'object') continue;
    if (typeof bucket.reset_time === 'string' && bucket.reset_time) continue;
    if (typeof bucket.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds) && bucket.reset_in_seconds > 0) {
      if (!nextQuota) nextQuota = { ...quota };
      nextQuota[key] = {
        ...bucket,
        reset_time: new Date(capturedAt + bucket.reset_in_seconds * 1000).toISOString(),
      };
    }
  }
  return nextQuota ? { ...stdin, quota: nextQuota } : stdin;
}

function writeHostStateSnapshot(hostStatePath, state) {
  if (!hostStatePath) return;
  const normalizedState = state && typeof state === 'object' && state.stdin
    ? {
        ...state,
        stdin: materializeStdinQuotaResets(
          state.stdin,
          Number.isFinite(state.seq) ? state.seq : Number.isFinite(state.updatedAt) ? state.updatedAt : Date.now(),
        ),
      }
    : state;
  const dir = path.dirname(hostStatePath);
  const tmp = path.join(dir, `.${path.basename(hostStatePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(normalizedState)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, hostStatePath);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function resolveEffectiveCols(env, stdin) {
  const parseCol = (val) => {
    const n = typeof val === 'string' ? Number.parseInt(val, 10) : val;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(1000, Math.floor(n)) : null;
  };
  return parseCol(env?.COLUMNS)
    ?? parseCol(process.stdout?.columns)
    ?? parseCol(process.stderr?.columns)
    ?? parseCol(stdin?.terminal_width);
}

function printFiltered(filteredLines) {
  if (filteredLines.length === 0) return;
  process.stdout.write(filteredLines.map((line) => `${line}\n`).join(''));
}

function print(lines, stdin = null, fallbackRepo = null) {
  if (lines.length === 0) return;
  const filter = terminalFilter(stdin, fallbackRepo);
  printFiltered(lines.map((line) => filter(line)));
}

const NO_DATA_TIMEOUT_MS = 250;
const IDLE_TIMEOUT_MS = 250;
const MAX_STDIN_BYTES = 256 * 1024;

export function readStdin(stream = process.stdin) {
  if (stream.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    let idleTimer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(noDataTimer);
      clearTimeout(idleTimer);
      stream.pause();
      resolve(value);
    };
    const parse = () => {
      try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    };
    const noDataTimer = setTimeout(() => {
      if (!raw) finish(null);
    }, NO_DATA_TIMEOUT_MS);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_STDIN_BYTES) return finish(null);
      const parsed = parse();
      if (parsed) return finish(parsed);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(parse()), IDLE_TIMEOUT_MS);
    });
    stream.on('end', () => finish(parse()));
    stream.on('error', () => finish(null));
  });
}

const PASSED_ENV = [
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'LC_MESSAGES',
  'COLUMNS', 'DEBUG', 'CLAUDE_CONFIG_DIR', 'AGY_CONFIG_DIR', 'AGY_HUD_DATA_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'AGY_HUD_FORCE_ASCII', 'AGY_HUD_FORCE_UNICODE', 'AGY_HUD_BASELINE_ON_EMPTY',
];

export function cageEnv(env = process.env) {
  const caged = { PATH: '' };
  for (const name of PASSED_ENV) if (typeof env[name] === 'string') caged[name] = env[name];
  if (env.ANTHROPIC_API_KEY?.trim()) caged.ANTHROPIC_API_KEY = 'set';
  for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE_URL']) {
    try {
      const url = new URL(env[name]?.trim() ?? '');
      caged[name] = `${url.origin}${url.pathname}`;
    } catch {}
  }
  return caged;
}

export function cageArgs({ grants, dataDir, entry = LOGIC, audit = false }) {
  return [
    audit ? '--permission-audit' : '--permission',
    ...grants.map((grant) => `--allow-fs-read=${grant}`),
    ...(dataDir ? [`--allow-fs-write=${dataDir}`] : []),
    '--disallow-code-generation-from-strings',
    `--import=${FENCE}`,
    entry,
  ];
}

const isInside = (file, dir) => {
  const relative = path.relative(dir, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

function prepareCageContext({ stdin = null, command = null, env = process.env, paths = collector.agyPaths(env) }) {
  let dataDir = null;
  try {
    dataDir = collector.prepareDataDir(paths);
  } catch {}
  if (dataDir) {
    try {
      if (isInside(collector.realpathNative(dataDir), collector.realpathNative(ROOT))) dataDir = null;
    } catch {}
  }

  const named = collector.logicPaths(paths, command ? { ...stdin, cwd: command.facts.cwd } : stdin);
  if (dataDir) named.data = dataDir;
  const stripped = collector.stripLogic(paths.strippedDir, ROOT);
  const grants = collector.readGrants(ROOT, { ...named, stripped: stripped?.dir });
  return { paths, dataDir, named, stripped, grants };
}

export async function runCage({ stdin = null, now = Date.now(), probes = async () => ({}), env = process.env, entry = LOGIC, audit = false, command }) {
  const { dataDir, named, stripped, grants } = prepareCageContext({ stdin, command, env });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cageArgs({ grants, dataDir, entry, audit }), {
      env: {
        ...cageEnv(env),
        ...(stripped ? { AGY_HUD_STRIPPED: JSON.stringify({ dir: path.join(stripped.dir, path.sep), files: stripped.files }) } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let output = null;
    let stderr = '';
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => settle(new Error('timed out')), WALL_MS);
    const send = (message) => {
      if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    let buffered = '';
    let bytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) return settle(new Error('output too large'));
      buffered += chunk;
      for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
        let message;
        try {
          message = JSON.parse(buffered.slice(0, newline));
        } catch {
          return settle(new Error('unreadable output'));
        }
        buffered = buffered.slice(newline + 1);
        if (Array.isArray(message?.lines)) {
          output = { lines: message.lines.map(String), snapshot: message.snapshot, config: message.config, failed: message.failed === true };
          if (audit) child.stdin.end();
          else return settle(null, output);
        } else if (Number.isSafeInteger(message?.id)) {
          Promise.resolve().then(() => probes(message.ask)).catch(() => ({})).then((answers) => send({ id: message.id, answers }));
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (audit) stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES);
      if (env.DEBUG) process.stderr.write(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => settle(error));
    child.on('close', (code) => {
      if (!output) return settle(new Error(`logic exited with code ${code}`));
      const report = stderr.split('\n').findLast((line) => line.startsWith('agy-hud audit '));
      settle(null, audit ? { ...output, outside: report ? JSON.parse(report.slice('agy-hud audit '.length)) : ['no audit report'] } : output);
    });
    probes.start?.();
    send({ stdin, now, paths: named, ...(command ? { command } : {}) });
  });
}

const SLOW_PROBES = new Set([
  'git.status', 'git.numstat', 'git.branch', 'git.describe', 'git.hooks', 'git.repo', 'jj', 'extra',
]);
const PROBE_CACHE_TTL_MS = 15_000;
const ONE_HOUR_MS = 3_600_000;
const QUOTA_CHECK_INTERVAL_MS = 30_000;
const SECOND_MARGIN_MS = 20;
const MINUTE_MARGIN_MS = 30;
const RECENT_EXPIRY_WINDOW_MS = 60_000;
const RESET_EXPIRY_DEBOUNCE_MS = 2_000;

export function computeNextRefreshDelay(state, now = Date.now()) {
  const timestamps = [];
  const pushIso = (value) => {
    if (typeof value !== 'string' || !value) return;
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) timestamps.push(ts);
  };
  const pushEpoch = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
    timestamps.push(value < 1e12 ? value * 1000 : value);
  };

  const baseTime = Number.isFinite(state?.seq)
    ? state.seq
    : Number.isFinite(state?.updatedAt)
      ? state.updatedAt
      : now;

  const stdinQuota = state?.stdin?.quota;
  if (stdinQuota && typeof stdinQuota === 'object') {
    for (const bucket of Object.values(stdinQuota)) {
      if (!bucket || typeof bucket !== 'object') continue;
      if (typeof bucket.reset_time === 'string' && bucket.reset_time) {
        pushIso(bucket.reset_time);
      } else if (typeof bucket.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds) && bucket.reset_in_seconds > 0) {
        timestamps.push(baseTime + bucket.reset_in_seconds * 1000);
      }
    }
  }

  const rateLimits = state?.stdin?.rate_limits;
  if (rateLimits && typeof rateLimits === 'object') {
    pushEpoch(rateLimits.five_hour?.resets_at);
    pushEpoch(rateLimits.seven_day?.resets_at);
    pushEpoch(rateLimits.spend_limit?.resets_at);
  }

  const inspectQuotaSource = (src) => {
    if (!src || typeof src !== 'object') return;
    const models = Array.isArray(src.models) ? src.models : Array.isArray(src.data) ? src.data : [];
    for (const m of models) {
      if (!m || typeof m !== 'object') continue;
      pushIso(m.resetTime);
      pushIso(m.windows?.fiveHour?.resetTime);
      pushIso(m.windows?.weekly?.resetTime);
    }
    const pq = src.providerQuota || src.data?.providerQuota;
    if (pq && typeof pq === 'object') {
      for (const group of Object.values(pq)) {
        if (!group || typeof group !== 'object') continue;
        pushIso(group.fiveHour?.resetTime);
        pushIso(group.weekly?.resetTime);
      }
    }
  };

  inspectQuotaSource(state?.agyQuota);
  inspectQuotaSource(state?.quotaCache);

  const img = state?.transcript?.imageExhausted ?? state?.imageExhausted;
  if (img && typeof img === 'object' && img.exhausted !== false) {
    pushIso(img.resetTime);
  }

  const expiresAt = [state?.expiresAt, state?.quotaCache?.expiresAt, state?.agyQuota?.expiresAt]
    .find((v) => typeof v === 'number' && Number.isFinite(v));
  const lastRefreshed = [state?.lastRefreshed, state?.quotaCache?.lastRefreshed, state?.agyQuota?.lastRefreshed]
    .find((v) => typeof v === 'number' && Number.isFinite(v)) ?? null;

  const futureResets = timestamps.filter((ts) => ts > now);
  const expiredPending = timestamps.filter((ts) => {
    if (ts > now) return false;
    if (now - ts > RECENT_EXPIRY_WINDOW_MS) return false;
    return lastRefreshed === null || lastRefreshed < ts;
  });

  let baseDelay;
  const subHour = futureResets.filter((ts) => ts - now <= ONE_HOUR_MS);
  if (subHour.length > 0) {
    baseDelay = Math.min(...subHour.map((ts) => {
      const rem = ts - now;
      return ((rem - 1) % 1000) + 1 + SECOND_MARGIN_MS;
    }));
  } else if (futureResets.length > 0) {
    const minuteDelay = Math.min(...futureResets.map((ts) => {
      const rem = ts - now;
      return ((rem - 1) % 60_000) + 1 + MINUTE_MARGIN_MS;
    }));
    const checkCap = Number.isFinite(expiresAt) && expiresAt > now
      ? Math.min(QUOTA_CHECK_INTERVAL_MS, Math.max(500, expiresAt - now + MINUTE_MARGIN_MS))
      : QUOTA_CHECK_INTERVAL_MS;
    baseDelay = Math.min(minuteDelay, checkCap);
  } else if (Number.isFinite(expiresAt) && expiresAt > now) {
    baseDelay = Math.min(QUOTA_CHECK_INTERVAL_MS, Math.max(500, expiresAt - now + MINUTE_MARGIN_MS));
  } else {
    baseDelay = QUOTA_CHECK_INTERVAL_MS;
  }

  if (expiredPending.length > 0) {
    const sinceRefresh = lastRefreshed !== null ? Math.max(0, now - lastRefreshed) : Infinity;
    const fastRecheckDelay = sinceRefresh < RESET_EXPIRY_DEBOUNCE_MS
      ? RESET_EXPIRY_DEBOUNCE_MS - sinceRefresh + 50
      : 1_000;
    baseDelay = Math.min(baseDelay, fastRecheckDelay);
  }

  return Math.max(20, Math.round(baseDelay));
}

export function createRenderWorker({
  env = process.env,
  paths = collector.agyPaths(env),
  entry = LOGIC,
  wallMs = WALL_MS,
  probeCacheTtlMs = PROBE_CACHE_TTL_MS,
  createProbesFn = collector.createProbes,
} = {}) {
  let disposed = false;
  let activeWorker = null;
  let requestChain = Promise.resolve();
  const slowCache = new Map();
  let lastQuotaKey = null;
  let materializedQuota = null;

  const stabilizeStdinQuota = (rawStdin, capturedAt) => {
    const quota = rawStdin?.quota;
    if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
      lastQuotaKey = null;
      materializedQuota = null;
      return rawStdin;
    }
    const hasRelativeOnly = Object.values(quota).some(
      (b) => b && typeof b === 'object'
        && !(typeof b.reset_time === 'string' && b.reset_time)
        && typeof b.reset_in_seconds === 'number'
        && Number.isFinite(b.reset_in_seconds)
        && b.reset_in_seconds > 0,
    );
    if (!hasRelativeOnly) {
      lastQuotaKey = null;
      materializedQuota = null;
      return rawStdin;
    }
    const key = JSON.stringify(quota);
    if (key !== lastQuotaKey || !materializedQuota) {
      lastQuotaKey = key;
      materializedQuota = materializeStdinQuotaResets(rawStdin, capturedAt).quota;
    }
    return { ...rawStdin, quota: materializedQuota };
  };

  const destroyWorker = (worker) => {
    if (!worker || worker.destroyed) return;
    worker.destroyed = true;
    worker.alive = false;
    if (worker.pending) {
      clearTimeout(worker.pending.timer);
      const reject = worker.pending.reject;
      worker.pending = null;
      reject(new Error('render worker closed'));
    }
    try { worker.child.stdin.end(); } catch {}
    try { worker.child.kill('SIGKILL'); } catch {}
    try { worker.child.unref?.(); } catch {}
    if (activeWorker === worker) activeWorker = null;
  };

  const spawnWorker = ({ dataDir, grants, stripped, fingerprint }) => {
    const child = spawn(process.execPath, cageArgs({ grants, dataDir, entry }), {
      env: {
        ...cageEnv(env),
        ...(stripped ? { AGY_HUD_STRIPPED: JSON.stringify({ dir: path.join(stripped.dir, path.sep), files: stripped.files }) } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const worker = {
      child,
      fingerprint,
      alive: true,
      destroyed: false,
      buffered: '',
      responseBytes: 0,
      pending: null,
    };

    const failWorker = (error) => {
      worker.alive = false;
      if (activeWorker === worker) activeWorker = null;
      if (worker.pending) {
        const current = worker.pending;
        worker.pending = null;
        clearTimeout(current.timer);
        current.reject(error);
      }
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
      try { child.unref?.(); } catch {}
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (worker.destroyed) return;
      worker.responseBytes += Buffer.byteLength(chunk);
      if (worker.responseBytes > MAX_OUTPUT_BYTES) {
        failWorker(new Error('output too large'));
        return;
      }
      worker.buffered += chunk;
      for (let newline = worker.buffered.indexOf('\n'); newline !== -1; newline = worker.buffered.indexOf('\n')) {
        const line = worker.buffered.slice(0, newline);
        worker.buffered = worker.buffered.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          failWorker(new Error('unreadable output'));
          return;
        }
        const current = worker.pending;
        if (!current) continue;
        if (Array.isArray(message?.lines)) {
          worker.pending = null;
          worker.responseBytes = Buffer.byteLength(worker.buffered);
          clearTimeout(current.timer);
          current.resolve({
            lines: message.lines.map(String),
            snapshot: message.snapshot ?? null,
            config: message.config,
            failed: message.failed === true,
          });
        } else if (Number.isSafeInteger(message?.id)) {
          Promise.resolve()
            .then(() => current.probes(message.ask))
            .catch(() => ({}))
            .then((answers) => {
              if (!worker.destroyed && worker.alive && worker.pending === current) {
                try {
                  child.stdin.write(`${JSON.stringify({ id: message.id, answers })}\n`);
                } catch {}
              }
            });
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (env.DEBUG) process.stderr.write(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => failWorker(error));
    child.on('close', (code) => {
      failWorker(new Error(`logic exited with code ${code}`));
    });

    return worker;
  };

  const makeScopedProbes = ({ cwd, argv, usage, now }) => {
    const liveProbes = createProbesFn({ cwd, argv, env, paths, usage });
    const cwdKey = typeof cwd === 'string' ? cwd : '';
    for (const key of slowCache.keys()) {
      if (!key.startsWith(`${cwdKey}\0`)) slowCache.delete(key);
    }

    return async (names) => {
      const unique = [...new Set(Array.isArray(names) ? names : [])];
      const freshNames = [];
      const result = {};
      const slowTasks = [];

      for (const name of unique) {
        if (SLOW_PROBES.has(name)) {
          const cacheKey = `${cwdKey}\0${name}`;
          const hit = slowCache.get(cacheKey);
          if (hit && now >= hit.cachedAt && now < hit.expiresAt) {
            slowTasks.push(hit.promise.then((val) => { result[name] = val; }));
            continue;
          }
          const promise = Promise.resolve()
            .then(() => liveProbes([name]).then((ans) => ans?.[name]))
            .catch((err) => {
              if (slowCache.get(cacheKey)?.promise === promise) slowCache.delete(cacheKey);
              throw err;
            });
          slowCache.set(cacheKey, { cachedAt: now, expiresAt: now + probeCacheTtlMs, promise });
          slowTasks.push(promise.then((val) => { result[name] = val; }));
        } else {
          freshNames.push(name);
        }
      }

      await Promise.all([
        ...slowTasks,
        freshNames.length > 0
          ? liveProbes(freshNames).then((fresh) => { Object.assign(result, fresh); })
          : Promise.resolve(),
      ]);
      return result;
    };
  };

  const executeRender = async (stdin, { now = Date.now(), cols = null, argv = [] } = {}) => {
    if (disposed) throw new Error('render worker closed');
    if (!stdin || typeof stdin !== 'object') {
      return { lines: [], plainLines: [], snapshot: null, failed: false, fallbackRepo: null, cols, now };
    }

    const effectiveStdin = stabilizeStdinQuota(stdin, now);
    const setting = collector.userSettings(paths);
    const usage = collector.usagePaths(paths, env, setting);
    const cwd = effectiveStdin.workspace?.current_dir ?? effectiveStdin.cwd ?? null;
    const probes = makeScopedProbes({ cwd, argv, usage, now });
    const repoPromise = cwd && !effectiveStdin.workspace?.repo
      ? probes(['git.repo']).then((r) => r['git.repo'] ?? null).catch(() => null)
      : Promise.resolve(null);

    const { dataDir, named, stripped, grants } = prepareCageContext({ stdin: effectiveStdin, env, paths });
    const fingerprint = JSON.stringify({
      entry,
      dataDir,
      named,
      grants: [...grants].sort(),
      strippedDir: stripped?.dir ?? null,
    });

    if (!activeWorker || !activeWorker.alive || activeWorker.destroyed || activeWorker.fingerprint !== fingerprint) {
      if (activeWorker) destroyWorker(activeWorker);
      activeWorker = spawnWorker({ dataDir, grants, stripped, fingerprint });
    }

    const worker = activeWorker;
    const output = await new Promise((resolve, reject) => {
      if (disposed || !worker.alive || worker.destroyed) {
        return reject(new Error('render worker unavailable'));
      }
      const timer = setTimeout(() => {
        if (worker.pending?.reject === reject) {
          worker.pending = null;
          destroyWorker(worker);
          reject(new Error('timed out'));
        }
      }, wallMs);
      worker.pending = { resolve, reject, timer, probes };
      worker.responseBytes = Buffer.byteLength(worker.buffered);
      try {
        worker.child.stdin.write(`${JSON.stringify({ stdin: effectiveStdin, now, cols, paths: named, persistent: true })}\n`);
      } catch (err) {
        clearTimeout(timer);
        worker.pending = null;
        destroyWorker(worker);
        reject(err);
      }
    });

    if (output.snapshot) collector.writeUsageSnapshot(usage.write, output.snapshot);
    const fallbackRepo = await repoPromise;
    const filter = terminalFilter(effectiveStdin, fallbackRepo);
    const filteredLines = output.lines.map((line) => filter(line));
    const plainLines = filteredLines.map(stripAnsiAndNbsp);
    return {
      lines: filteredLines,
      plainLines,
      snapshot: output.snapshot,
      config: output.config,
      failed: output.failed,
      fallbackRepo,
      cols,
      now,
    };
  };

  return {
    renderSnapshot(stdin, options = {}) {
      const task = requestChain.then(() => executeRender(stdin, options));
      requestChain = task.catch(() => {});
      return task;
    },
    isAlive() {
      return Boolean(activeWorker && activeWorker.alive && !activeWorker.destroyed);
    },
    pid() {
      return activeWorker && activeWorker.alive && !activeWorker.destroyed ? activeWorker.child.pid : null;
    },
    close() {
      disposed = true;
      slowCache.clear();
      lastQuotaKey = null;
      materializedQuota = null;
      if (activeWorker) destroyWorker(activeWorker);
    },
  };
}

function relayToNode(argv) {
  const node = process.platform === 'win32' ? collector.resolveWindowsExecutable('node') : 'node';
  return new Promise((resolve) => {
    if (!node) {
      print([upgradeLine(`Bun ${process.versions.bun}`)]);
      return resolve();
    }
    const child = spawn(node, [path.join(ROOT, 'hud.mjs'), ...argv.slice(2)], { stdio: 'inherit' });
    child.on('error', () => resolve(print([upgradeLine(`Bun ${process.versions.bun}`)])));
    child.on('close', (code) => {
      if (code) process.exitCode = code;
      resolve();
    });
  });
}

async function handleSelfUpdate() {
  console.log('Checking for latest installer...');
  const bootstrapUrl = 'https://raw.githubusercontent.com/yuwenlong/agy-hud/main/scripts/bootstrap.js';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-update-'));
  const tempPath = path.join(tempDir, 'bootstrap.mjs');
  try {
    await new Promise((resolve, reject) => {
      https.get(bootstrapUrl, (response) => {
        if (response.statusCode !== 200) return reject(new Error(`Failed to fetch bootstrap: ${response.statusCode}`));
        const fileStream = fs.createWriteStream(tempPath);
        response.pipe(fileStream);
        fileStream.on('finish', () => { fileStream.close(); resolve(); });
        fileStream.on('error', reject);
      }).on('error', reject);
    });
    console.log('Spawning update process in background...');
    const child = spawn(process.execPath, [tempPath, '--delay-start'], {
      detached: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.unref();
    process.exit(0);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(`Update failed: ${err.message}`);
    process.exit(1);
  }
}

function maybeCheckUpdates(paths) {
  const updateStatusPath = paths.updateStatusPath;
  let lastCheck = 0;
  let status = {};
  try {
    if (fs.existsSync(updateStatusPath)) {
      status = JSON.parse(fs.readFileSync(updateStatusPath, 'utf8'));
      lastCheck = status.lastCheck || 0;
    }
  } catch {}
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  if (Date.now() - lastCheck > ONE_DAY_MS) {
    status.lastCheck = Date.now();
    try {
      fs.mkdirSync(path.dirname(updateStatusPath), { recursive: true });
      fs.writeFileSync(updateStatusPath, JSON.stringify(status, null, 2));
    } catch {}
    const checkerPath = path.join(ROOT, 'runtime', 'update-checker.mjs');
    if (fs.existsSync(checkerPath)) {
      const checker = spawn(process.execPath, [checkerPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
      });
      checker.unref();
    }
  }
}

const COMMANDS = ['doctor', 'schema', 'preview', 'set', 'preset', 'report', 'install'];
const FACTS = ['doctor', 'report'];

export function asJson(lines) {
  let value;
  try {
    value = JSON.parse(lines.join('\n'));
  } catch {
    value = lines;
  }
  return JSON.stringify(value, null, 2).split('\n');
}

async function runCommand(name, args, { paths, env }) {
  const facts = collector.commandFacts({ root: ROOT, paths, env });
  const printJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (!facts.runtime.supported) {
    if (name === 'doctor') {
      const { runtime, plugin, runtimes, heartbeat } = facts;
      return printJson({
        runtime,
        plugin,
        runtimes,
        lastRender: heartbeat && { at: heartbeat.at, runtime: heartbeat.runtime, path: heartbeat.path, outcome: heartbeat.outcome },
        findings: [`This is ${runtime.name} ${runtime.version}; the HUD needs Node 22.18+. Fix: rerun with a supported runtime from runtimes, or install one.`],
      });
    }
    process.exitCode = 1;
    return print([upgradeLine(process.version)]);
  }
  try {
    if (name === 'install') {
      const { install } = await import('./install.mjs');
      return printJson(install({ configDir: paths.configDir, hudDir: paths.hudDir, argv: args, env }));
    }
    if (name === 'set' && args[0] === '--undo') {
      collector.undoConfig(paths);
      return print(['Restored config.json from before the last `hud set`.']);
    }
    const stdin = facts.heartbeat?.stdin ?? null;
    const probes = collector.createProbes({ cwd: stdin?.workspace?.current_dir ?? stdin?.cwd, argv: [], env, paths, usage: collector.usagePaths(paths, env) });
    const output = await runCage({ stdin, env, probes, command: { name, args, facts } });
    if ((name === 'set' || name === 'preset') && output.config) collector.writeConfig(paths, output.config);
    if (output.failed) process.exitCode = 1;
    print(FACTS.includes(name) ? asJson(output.lines) : output.lines, stdin);
  } catch (error) {
    process.exitCode = 1;
    print([`agy-hud ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`]);
  }
}

export async function main({ argv = process.argv, env = process.env } = {}) {
  if (argv[2] === 'launch') {
    const rawArgs = argv.slice(3);
    const launchArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
    const { launchAgy } = await import('./runtime/launch.mjs');
    const code = await launchAgy(launchArgs, { env });
    if (typeof code === 'number') process.exitCode = code;
    return;
  }
  if (argv.includes('--update')) {
    await handleSelfUpdate();
    return;
  }
  if (argv.includes('--config')) {
    const { startWizard } = await import('./runtime/config-wizard.mjs');
    await startWizard();
    return;
  }

  const command = COMMANDS.includes(argv[2]) ? argv[2] : null;
  if (!command && isHudDisabled(env)) return;
  if (process.versions.bun) return relayToNode(argv);
  const paths = collector.agyPaths(env);
  if (command) return runCommand(command, argv.slice(3), { paths, env });
  if (!collector.isNodeSupported(process.versions.node)) {
    collector.writeHeartbeat(paths, { outcome: 'upgrade', env });
    return print([upgradeLine(process.version)]);
  }

  const now = Date.now();
  let stdin = null;
  try {
    stdin = await readStdin();
    const effectiveStdin = stdin ?? (env.AGY_HUD_BASELINE_ON_EMPTY === '1' ? { cwd: process.cwd() } : null);
    const setting = collector.userSettings(paths);
    const usage = collector.usagePaths(paths, env, setting);
    const cwd = effectiveStdin?.workspace?.current_dir ?? effectiveStdin?.cwd ?? null;
    const probes = collector.createProbes({
      cwd,
      argv,
      env,
      paths,
      usage,
      early: collector.probesToStart(setting),
    });
    const repoPromise = cwd && !effectiveStdin?.workspace?.repo ? probes(['git.repo']).then((r) => r['git.repo']).catch(() => null) : Promise.resolve(null);
    const output = await runCage({ stdin: effectiveStdin, now, probes, env });
    if (output.snapshot) collector.writeUsageSnapshot(usage.write, output.snapshot);
    const fallbackRepo = await repoPromise;
    const filter = terminalFilter(effectiveStdin, fallbackRepo);
    const filteredLines = output.lines.map((line) => filter(line));
    printFiltered(filteredLines);
    const hostStatePath = env.AGY_HUD_HOST_STATE?.trim();
    if (hostStatePath && (effectiveStdin !== null || filteredLines.length > 0)) {
      writeHostStateSnapshot(hostStatePath, {
        seq: now,
        updatedAt: Date.now(),
        cols: resolveEffectiveCols(env, effectiveStdin),
        stdin: effectiveStdin,
        lines: filteredLines,
        plainLines: filteredLines.map(stripAnsiAndNbsp),
        fallbackRepo,
      });
    }
    if (stdin) collector.writeHeartbeat(paths, { outcome: output.failed ? output.lines[0] ?? 'failed' : 'ok', stdin, now, env });
    maybeCheckUpdates(paths);
  } catch (error) {
    const message = `[agy-hud] Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    print([`${message}. Type /hud to fix it.`]);
    collector.writeHeartbeat(paths, { outcome: message, stdin, now, env });
    try {
      const errorLogPath = path.join(paths.configDir, 'agy-hud-error.log');
      fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
      fs.writeFileSync(errorLogPath, error?.stack || String(error), { mode: 0o600 });
    } catch {}
  }
}

const ENTRIES = [
  path.join(ROOT, 'hud.mjs'),
  path.join(ROOT, 'dist', 'index.js'),
  path.join(ROOT, 'src', 'index.ts'),
];
if (process.argv[1] && ENTRIES.some((entry) => collector.samePath(process.argv[1], entry))) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
