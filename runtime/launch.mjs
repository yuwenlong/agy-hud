import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHudDisabled } from './paths.mjs';

export { isHudDisabled };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_FILES = new Set([
  path.join(ROOT, 'hud.mjs'),
  path.join(ROOT, 'runtime', 'bin', 'agy-hud.js'),
  path.join(ROOT, 'runtime', 'bin', 'agy-hud.cmd'),
  path.join(ROOT, 'runtime', 'launch.mjs'),
]);

export const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'acp',
  'agent',
  'agents',
  'changelog',
  'help',
  'install',
  'mcp',
  'mic-serve',
  'models',
  'plugin',
  'plugins',
  'remote-control',
  'update',
]);

export const NON_INTERACTIVE_FLAGS = new Set([
  '-p',
  '--print',
  '--prompt',
  '-h',
  '--help',
  '-v',
  '--version',
  '--input-format',
  '--output-format',
]);

const VALUE_OPTIONS = new Set([
  '--add-dir',
  '--agent',
  '--conversation',
  '-r',
  '--resume',
  '--effort',
  '--input-format',
  '--json-schema',
  '--log-file',
  '--mode',
  '--model',
  '--output-format',
  '--print-timeout',
  '--project',
  '--prompt-interactive',
  '-i',
  '--settings',
]);

function isTruthyEnv(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

export function isInteractiveAgyInvocation(
  args = [],
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
) {
  if (isTruthyEnv(env?.AGY_HUD_BYPASS) || isHudDisabled(env)) return false;
  if (!stdin?.isTTY || !stdout?.isTTY) return false;
  if (env?.TERM === 'dumb') return false;

  const list = Array.isArray(args) ? args : [];
  let seenPositional = false;
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i]);
    if (arg === '--') break;
    if (arg.startsWith('-') && arg !== '-') {
      const eq = arg.indexOf('=');
      const opt = eq >= 0 ? arg.slice(0, eq) : arg;
      if (NON_INTERACTIVE_FLAGS.has(opt)) return false;
      if (eq < 0 && VALUE_OPTIONS.has(opt)) {
        i += 1;
      }
      continue;
    }
    if (!seenPositional) {
      seenPositional = true;
      if (NON_INTERACTIVE_SUBCOMMANDS.has(arg)) return false;
    }
  }
  return true;
}

function defaultFsOps() {
  return {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    accessSync: fs.accessSync,
    realpathSync: fs.realpathSync,
    homedir: os.homedir,
  };
}

function resolveWithNative(target, realpathSync, fallback) {
  if (typeof realpathSync?.native === 'function') {
    try { return realpathSync.native(target); } catch {}
  }
  try { return realpathSync(target); } catch { return fallback; }
}

function isSelfWrapper(candidate, realpathSync, pathMod = path) {
  const resolved = resolveWithNative(candidate, realpathSync, pathMod.resolve(candidate));
  for (const selfFile of SELF_FILES) {
    const realSelf = resolveWithNative(selfFile, realpathSync, selfFile);
    if (resolved === realSelf) return true;
  }
  return false;
}

function isExecutableFile(candidate, platform, ops, checkSelf = true, pathMod = platform === 'win32' ? path.win32 : path.posix) {
  try {
    const st = ops.statSync(candidate);
    if (!st.isFile()) return false;
    if (platform !== 'win32') {
      ops.accessSync(candidate, fs.constants.X_OK);
    }
    if (checkSelf && isSelfWrapper(candidate, ops.realpathSync, pathMod)) return false;
    return true;
  } catch {
    return false;
  }
}

export function resolveAgyBinary(
  env = process.env,
  platform = process.platform,
  fsOps = {},
) {
  const ops = { ...defaultFsOps(), ...fsOps };
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const names = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat'] : ['agy'];

  const override = typeof env?.AGY_BIN === 'string' ? env.AGY_BIN.trim() : '';
  if (override) {
    if (override.includes('/') || override.includes('\\') || pathMod.isAbsolute(override)) {
      const resolved = pathMod.resolve(override);
      if (isExecutableFile(resolved, platform, ops, false, pathMod)) return resolved;
      throw new Error(`Configured AGY_BIN does not exist or is not executable: ${override}`);
    }
    names.unshift(override);
  }

  const pathKey = Object.keys(env ?? {}).find((k) => k.toLowerCase() === 'path');
  const pathEntries = (pathKey ? env[pathKey] : '')?.split(platform === 'win32' ? ';' : ':') ?? [];

  for (const rawEntry of pathEntries) {
    const dir = rawEntry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || dir === '.' || !pathMod.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = pathMod.join(dir, name);
      if (isExecutableFile(candidate, platform, ops, true, pathMod)) return candidate;
    }
  }

  const home = (platform === 'win32' ? env?.USERPROFILE : env?.HOME) || ops.homedir();
  const standardCandidates = platform === 'win32'
    ? [
        env?.LOCALAPPDATA ? pathMod.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : null,
        home ? pathMod.join(home, '.local', 'bin', 'agy.exe') : null,
        env?.ProgramFiles ? pathMod.join(env.ProgramFiles, 'agy', 'agy.exe') : null,
      ]
    : [
        home ? pathMod.join(home, '.local', 'bin', 'agy') : null,
        '/usr/local/bin/agy',
        '/opt/homebrew/bin/agy',
      ];

  for (const candidate of standardCandidates.filter(Boolean)) {
    if (isExecutableFile(candidate, platform, ops)) return candidate;
  }

  throw new Error('Antigravity CLI (agy) binary was not found on PATH or standard install locations.');
}

function quoteWin32BatchCommand(filePath) {
  const str = String(filePath);
  if (/[\r\n\0]/.test(str)) {
    throw new Error('Windows batch commands cannot contain CR, LF, or NUL characters.');
  }
  if (str.includes('"')) {
    throw new Error('Windows batch commands cannot contain double quote characters.');
  }
  if (!str.includes('%')) {
    return `"${str}"`;
  }
  // cmd.exe processes `^` escapes only outside quotes, so command paths with `%`
  // stay unquoted with single-layer `^` escaping to avoid literal `"` in argv[0].
  return str.replace(/[\s"&|<>()^;%!`,=]/g, '^$&');
}

function quoteWin32BatchArg(value) {
  const str = String(value);
  if (/[\r\n\0]/.test(str)) {
    throw new Error('Windows batch arguments cannot contain CR, LF, or NUL characters.');
  }
  if (str.length > 0 && !/[\s"&|<>()^;%!`,=]/.test(str)) {
    return str;
  }
  if (!str.includes('"') && !str.includes('%')) {
    return `"${str.replace(/(\\+)$/, '$1$1')}"`;
  }
  const msvc = `"${str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  return msvc.replace(/(\^)|([ \t"&|<>();,=!])|(%)/g, (_, caret, meta, pct) => {
    if (caret) return '^^^^';
    if (meta) return `^^^${meta}`;
    return '^%';
  });
}

export function resolveSpawnCommand(
  file,
  args = [],
  { env = process.env, platform = process.platform, execPath = process.execPath, verbatimString = false } = {},
) {
  if (platform === 'win32' && typeof args === 'string') {
    return { file, args };
  }
  if (
    platform === 'win32'
    && verbatimString
    && typeof file === 'string'
    && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(file)
    && Array.isArray(args)
    && args.length === 4
    && args[0] === '/d'
    && args[1] === '/s'
    && args[2] === '/c'
    && typeof args[3] === 'string'
    && args[3].startsWith('"')
    && args[3].endsWith('"')
  ) {
    return { file, args: args.join(' ') };
  }
  const list = Array.isArray(args) ? args : [];
  if (platform === 'win32' && typeof file === 'string') {
    if (/\.(?:mjs|js|cjs)$/i.test(file)) {
      return { file: execPath, args: [file, ...list] };
    }
    if (/\.(?:cmd|bat)$/i.test(file)) {
      const cmdExe = env?.ComSpec || env?.COMSPEC || 'cmd.exe';
      const inner = [
        quoteWin32BatchCommand(file),
        ...list.map((arg) => quoteWin32BatchArg(arg)),
      ].join(' ');
      const payload = `"${inner}"`;
      if (verbatimString) {
        return { file: cmdExe, args: `/d /s /c ${payload}` };
      }
      return {
        file: cmdExe,
        args: ['/d', '/s', '/c', payload],
        windowsVerbatimArguments: true,
      };
    }
  }
  return { file, args: list };
}

export async function passthrough(
  file,
  args = [],
  {
    cwd = process.cwd(),
    env = process.env,
    platform = process.platform,
    execPath = process.execPath,
    spawnFn = spawn,
  } = {},
) {
  const target = resolveSpawnCommand(file, args, { env, platform, execPath });
  const spawnOptions = {
    cwd,
    env,
    stdio: 'inherit',
  };
  if (target.windowsVerbatimArguments) {
    spawnOptions.windowsVerbatimArguments = true;
    if (platform === 'win32' && /[\s\t]/.test(target.file) && !target.file.startsWith('"')) {
      spawnOptions.argv0 = `"${target.file}"`;
    }
  }
  const child = spawnFn(target.file, target.args, spawnOptions);

  const forwards = new Map(
    ['SIGHUP', 'SIGINT', 'SIGTERM'].map((sig) => [
      sig,
      () => {
        try { child.kill(sig); } catch {}
      },
    ]),
  );
  for (const [sig, handler] of forwards) process.on(sig, handler);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (!result.signal) return result.code ?? 0;
    return 128 + (os.constants.signals[result.signal] ?? 1);
  } finally {
    for (const [sig, handler] of forwards) process.off(sig, handler);
  }
}

export async function launchAgy(args = [], options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    platform = process.platform,
    execPath = process.execPath,
    resolveBinary = resolveAgyBinary,
    passthroughFn = passthrough,
    runHost,
    tmpdir = os.tmpdir(),
  } = options;

  const binary = resolveBinary(env, platform);

  if (!isInteractiveAgyInvocation(args, env, stdin, stdout)) {
    return passthroughFn(binary, args, { cwd, env, platform, execPath });
  }

  const stateDir = fs.mkdtempSync(path.join(tmpdir, 'agy-hud-session-'));
  const hostStatePath = path.join(stateDir, 'state.json');

  try {
    let hostRunner = runHost;
    let depErrorClass = null;
    if (!hostRunner) {
      const mod = await import('./pty-host.mjs');
      hostRunner = mod.runPtyHost;
      depErrorClass = mod.TerminalDependencyError;
    }

    const hostTarget = resolveSpawnCommand(binary, args, { env, platform, execPath, verbatimString: true });
    try {
      return await hostRunner({
        file: hostTarget.file,
        args: hostTarget.args,
        env,
        cwd,
        hostStatePath,
        stdin,
        stdout,
        platform,
      });
    } catch (error) {
      const isDepError = (depErrorClass && error instanceof depErrorClass)
        || error?.name === 'TerminalDependencyError';
      if (!isDepError) throw error;
      try {
        stderr?.write?.('agy-hud: terminal dependencies unavailable, launching agy directly.\n');
      } catch {}
      return await passthroughFn(binary, args, { cwd, env, platform, execPath });
    }
  } finally {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
}
