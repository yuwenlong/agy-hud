#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAntigravityPath, getAntigravityRoots } from './paths.mjs';
import { getWindowsAgyBinDirs, isOurShShimContents } from '../install.mjs';
import { updateShellIntegration } from './shell.mjs';

export function isOurStatusLineCommand(command, runtimeDir) {
  if (!command) return false;
  return command.includes(runtimeDir) || command.includes('agy-hud');
}

export function clearStatusLine(settingsPath, runtimeDir) {
  if (!fs.existsSync(settingsPath)) return { changed: false, reason: 'no_settings' };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { changed: false, reason: 'parse_error' };
  }
  const current = settings?.statusLine?.command;
  if (!current) return { changed: false, reason: 'no_status_line' };
  if (!isOurStatusLineCommand(current, runtimeDir)) return { changed: false, reason: 'foreign_status_line' };
  fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
  delete settings.statusLine;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { changed: true };
}

export function removeRuntimeDir(runtimeDir, { rmSync = fs.rmSync, existsSync = fs.existsSync } = {}) {
  if (!existsSync(runtimeDir)) return { removed: false, reason: 'not_present' };
  try {
    rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return { removed: true };
  } catch (error) {
    return { removed: false, reason: error?.code || error?.message || 'remove_failed' };
  }
}

export function removeTokenMirrors() {
  const removed = [];
  for (const file of [
    path.join(os.tmpdir(), 'agy-hud-token.json'),
    path.join(os.tmpdir(), 'agy-hud-quota-cache.json'),
  ]) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        removed.push(file);
      } catch {}
    }
  }
  return removed;
}

export function removeExtraFiles(root) {
  const removed = [];
  const targets = [
    path.join(root, 'agy-hud-payload.json'),
    path.join(root, 'agy-hud-token.json'),
    path.join(root, 'agy-hud-quota-cache.json'),
    path.join(root, 'agy-hud-update-status.json'),
    path.join(root, 'agy-hud-error.log'),
    path.join(root, 'daily-cost.json'),
    path.join(root, 'speed-cache'),
    path.join(root, 'hud'),
    path.join(root, 'agy-hud'),
    path.join(root, 'agy-hud.json'),
    path.join(root, '.agy-hud-shell.json'),
  ];
  try {
    for (const entry of fs.readdirSync(root)) {
      if (entry.startsWith('agy-hud-host-')) {
        targets.push(path.join(root, entry));
      }
    }
  } catch {}
  for (const target of targets) {
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch {}
    }
  }
  return removed;
}

export function removeWindowsShShims(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [];
  try {
    const dirs = getWindowsAgyBinDirs(env);
    const removed = [];
    for (const dir of dirs) {
      for (const name of ['sh.cmd', 'sh.bat']) {
        const target = path.join(dir, name);
        try {
          if (fs.existsSync(target) && isOurShShimContents(fs.readFileSync(target, 'utf8'))) {
            fs.unlinkSync(target);
            removed.push(target);
          }
        } catch {}
      }
    }
    return removed;
  } catch {
    return [];
  }
}

export function uninstall(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const roots = options.roots || getAntigravityRoots(env, homeDir);
  const settingsPath = options.settingsPath || resolveAntigravityPath('settings.json', env, homeDir);

  const results = {
    settingsPath,
    statusLine: null,
    runtimes: [],
    tokenMirrors: [],
    extraFiles: [],
    shellIntegrations: [],
  };

  for (const root of roots) {
    results.shellIntegrations.push({
      root,
      ...updateShellIntegration(root, 'uninstall', env, { homeDir, platform }),
    });
    const runtimeDir = path.join(root, 'agy-hud-runtime');
    const runtimeResult = removeRuntimeDir(runtimeDir, options.rmSync ? { rmSync: options.rmSync } : undefined);
    results.runtimes.push({ runtimeDir, ...runtimeResult });
    const rootSettings = path.join(root, 'settings.json');
    if (rootSettings !== settingsPath) {
      results.runtimes.push({ runtimeDir: rootSettings, ...clearStatusLine(rootSettings, runtimeDir) });
    }
    results.extraFiles.push(...removeExtraFiles(root));
  }

  const activeRuntimeDir = path.join(path.dirname(settingsPath), 'agy-hud-runtime');
  results.statusLine = clearStatusLine(settingsPath, activeRuntimeDir);
  results.tokenMirrors = removeTokenMirrors();
  results.shShims = removeWindowsShShims(platform, env);

  return results;
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const result = uninstall();
  process.stdout.write('AGY-HUD uninstall complete\n');
  process.stdout.write(`settings: ${result.settingsPath} (${result.statusLine.changed ? 'cleared' : result.statusLine.reason})\n`);
  for (const r of result.runtimes) {
    if (r.removed) process.stdout.write(`runtime removed: ${r.runtimeDir}\n`);
  }
  for (const s of result.shellIntegrations) {
    for (const file of s.removed || []) process.stdout.write(`shell integration removed: ${file}\n`);
  }
  for (const f of result.tokenMirrors) process.stdout.write(`token mirror removed: ${f}\n`);
  for (const f of result.extraFiles) process.stdout.write(`extra file removed: ${f}\n`);
  for (const f of result.shShims) process.stdout.write(`Windows sh shim removed: ${f}\n`);
}
