import fs from 'node:fs';
import path from 'node:path';

const XTERM_ROOT = 'node_modules/@xterm/headless';
const NODE_PTY_ROOT = 'node_modules/node-pty';

export const sharedDependencyFiles = [
  `${XTERM_ROOT}/package.json`,
  `${XTERM_ROOT}/lib-headless/xterm-headless.js`,
  `${NODE_PTY_ROOT}/package.json`,
  `${NODE_PTY_ROOT}/LICENSE`,
  'node_modules/node-addon-api/LICENSE.md',
  ...[
    'conpty_console_list_agent',
    'eventEmitter2',
    'index',
    'interfaces',
    'shared/conout',
    'terminal',
    'types',
    'unixTerminal',
    'utils',
    'windowsConoutConnection',
    'windowsPtyAgent',
    'windowsTerminal',
    'worker/conoutSocketWorker',
  ].map((name) => `${NODE_PTY_ROOT}/lib/${name}.js`),
];

export const nativePrebuildFiles = {
  linux: ['pty.node'],
  darwin: ['pty.node', 'spawn-helper'],
  win32: ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'],
};

const SUPPORTED_ARCHS = ['x64', 'arm64'];
const OPTIONAL_LICENSE_FILES = [
  `${XTERM_ROOT}/LICENSE`,
  `${XTERM_ROOT}/LICENSE.md`,
];

function prebuildFiles(platform, arch) {
  return nativePrebuildFiles[platform].map((file) => `${NODE_PTY_ROOT}/prebuilds/${platform}-${arch}/${file}`);
}

export const bundledDependencyFiles = [
  ...sharedDependencyFiles,
  ...Object.keys(nativePrebuildFiles).flatMap((platform) =>
    SUPPORTED_ARCHS.flatMap((arch) => prebuildFiles(platform, arch))),
];

export function hostDependencyFiles(platform = process.platform, arch = process.arch) {
  if (!Object.hasOwn(nativePrebuildFiles, platform) || !SUPPORTED_ARCHS.includes(arch)) {
    return [];
  }
  return [...sharedDependencyFiles, ...prebuildFiles(platform, arch)];
}

function validateRelativeDepPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
    throw new Error(`Invalid dependency relative path: ${rel}`);
  }
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe dependency path traversal: ${rel}`);
  }
  if (rel.toLowerCase().endsWith('.pdb')) {
    throw new Error(`Refusing to stage debug symbol file: ${rel}`);
  }
  return parts;
}

function isInsideDir(targetPath, rootDir) {
  const rel = path.relative(rootDir, targetPath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function hasHostDependencies(sourceRoot, platform = process.platform, arch = process.arch) {
  if (!sourceRoot) return false;
  const absSource = path.resolve(sourceRoot);
  const files = hostDependencyFiles(platform, arch);
  if (files.length === 0) return false;
  return files.every((rel) => {
    const parts = validateRelativeDepPath(rel);
    const src = path.join(absSource, ...parts);
    const stat = fs.lstatSync(src, { throwIfNoEntry: false });
    return Boolean(stat?.isFile());
  });
}

export function stageDependencies(
  sourceRoot,
  targetDir,
  { hostOnly = true, platform = process.platform, arch = process.arch } = {},
) {
  if (!sourceRoot || !targetDir) {
    throw new Error('stageDependencies requires both sourceRoot and targetDir');
  }
  const absSource = path.resolve(sourceRoot);
  const absTarget = path.resolve(targetDir);
  const required = hostOnly ? hostDependencyFiles(platform, arch) : bundledDependencyFiles;
  if (required.length === 0) {
    return { targetDir: absTarget, files: [], hostOnly, platform, arch };
  }

  const plan = [];
  for (const rel of required) {
    const parts = validateRelativeDepPath(rel);
    const src = path.join(absSource, ...parts);
    const dest = path.resolve(absTarget, ...parts);
    if (!isInsideDir(dest, absTarget)) {
      throw new Error(`Target dependency path escaped targetDir: ${rel}`);
    }
    const stat = fs.lstatSync(src, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      throw new Error(`Missing or non-regular dependency file: ${rel}`);
    }
    plan.push({ rel, src, dest, mode: stat.mode & 0o777 });
  }

  const requiredSet = new Set(required);
  for (const rel of OPTIONAL_LICENSE_FILES) {
    if (requiredSet.has(rel)) continue;
    const parts = validateRelativeDepPath(rel);
    const src = path.join(absSource, ...parts);
    const stat = fs.lstatSync(src, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      const dest = path.resolve(absTarget, ...parts);
      if (isInsideDir(dest, absTarget)) {
        plan.push({ rel, src, dest, mode: stat.mode & 0o777 });
      }
    }
  }

  for (const item of plan) {
    fs.mkdirSync(path.dirname(item.dest), { recursive: true });
    const existing = fs.lstatSync(item.dest, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) {
      throw new Error(`Refusing to overwrite non-regular target file: ${item.rel}`);
    }
    fs.copyFileSync(item.src, item.dest);
    if (process.platform !== 'win32') {
      fs.chmodSync(item.dest, item.mode);
    }
  }

  return {
    targetDir: absTarget,
    files: plan.map((item) => item.rel),
    hostOnly,
    platform,
    arch,
  };
}
