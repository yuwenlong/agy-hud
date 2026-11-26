import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getAntigravityRoots, resolveAntigravityPath, resolveSafeExecutable } from '../runtime/paths.mjs';
import { detectUnicodeSupport } from '../runtime/encoding.mjs';
import { isRemoteVersionNewer } from '../runtime/update-checker.mjs';
import { buildCmdShimContents, buildCommand, buildShShimContents, createStatusLineCommand, ensureWindowsShShim, install, LEGACY_SH_SHIM_BODY, writeCmdShim } from '../install.mjs';
import { bundledDependencyFiles, hasHostDependencies, hostDependencyFiles, stageDependencies } from '../runtime/pty-deps.mjs';
import { clearStatusLine, removeExtraFiles, removeRuntimeDir, removeWindowsShShims, uninstall } from '../runtime/uninstall.mjs';
import { buildAuthDiagnostic } from '../scripts/diagnose-auth.js';
import { detectHudRender, renderTerminalScreen, resolveNoAuthStatusLineSpawn, stripAnsi } from '../scripts/verify-display.js';
import { buildNpmDepsSpawn, cleanStalePluginFiles, installRuntime, RUNTIME_FILES } from '../scripts/bootstrap.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(snapshot)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

describe('runtime / paths', () => {
  test('getAntigravityRoots starts with home/.gemini/antigravity-cli and includes env fallbacks', () => {
    withEnv({ AGY_HUD_DATA_DIR: undefined, XDG_DATA_HOME: undefined, APPDATA: undefined, LOCALAPPDATA: undefined }, () => {
      const roots = getAntigravityRoots();
      assert.equal(roots.length, 1);
      assert.equal(roots[0], path.join(os.homedir(), '.gemini', 'antigravity-cli'));
    });

    withEnv({ AGY_HUD_DATA_DIR: undefined, XDG_DATA_HOME: '/xdg/home', APPDATA: 'C:\\AppData\\Roaming', LOCALAPPDATA: 'C:\\AppData\\Local' }, () => {
      const roots = getAntigravityRoots();
      assert.ok(roots.includes(path.join('/xdg/home', 'antigravity-cli')));
      assert.ok(roots.includes(path.join('C:\\AppData\\Roaming', 'antigravity-cli')));
      assert.ok(roots.includes(path.join('C:\\AppData\\Local', 'antigravity-cli')));
    });
  });

  test('resolveAntigravityPath returns existing candidate or falls back to primary root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
    try {
      const fakeAppdata = path.join(tmp, 'Roaming');
      const fakeRoot = path.join(fakeAppdata, 'antigravity-cli');
      fs.mkdirSync(fakeRoot, { recursive: true });
      fs.writeFileSync(path.join(fakeRoot, 'settings.json'), '{}');

      withEnv({
        AGY_HUD_DATA_DIR: undefined,
        XDG_DATA_HOME: undefined,
        APPDATA: fakeAppdata,
        LOCALAPPDATA: undefined,
        HOME: path.join(tmp, 'nonexistent-home'),
        USERPROFILE: path.join(tmp, 'nonexistent-home'),
      }, () => {
        assert.equal(resolveAntigravityPath('settings.json'), path.join(fakeRoot, 'settings.json'));
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('resolveSafeExecutable resolves absolute node path and skips relative entries', () => {
    const nodePath = resolveSafeExecutable('node');
    assert.ok(nodePath && path.isAbsolute(nodePath));
    withEnv({ PATH: ['.', 'relative_dir', path.dirname(nodePath)].join(path.delimiter) }, () => {
      assert.equal(resolveSafeExecutable('node'), nodePath);
    });
  });
});

describe('runtime / encoding', () => {
  test('honors env overrides, Windows codepage, Linux LANG, and macOS defaults', () => {
    assert.equal(detectUnicodeSupport({ env: { AGY_HUD_FORCE_ASCII: '1' }, platform: 'darwin' }), false);
    assert.equal(detectUnicodeSupport({ env: { AGY_HUD_FORCE_UNICODE: '1' }, platform: 'win32', readCodepage: () => '936' }), true);
    assert.equal(detectUnicodeSupport({ env: {}, platform: 'win32', readCodepage: () => '936' }), false);
    assert.equal(detectUnicodeSupport({ env: { WT_SESSION: 'abc' }, platform: 'win32', readCodepage: () => '936' }), false);
    assert.equal(detectUnicodeSupport({ env: {}, platform: 'win32', readCodepage: () => '65001' }), true);
    assert.equal(detectUnicodeSupport({ env: { LANG: 'en_US.UTF-8' }, platform: 'linux' }), true);
    assert.equal(detectUnicodeSupport({ env: { LANG: 'POSIX' }, platform: 'linux' }), false);
    assert.equal(detectUnicodeSupport({ env: {}, platform: 'darwin' }), true);
  });
});

describe('runtime / update-checker & verify-display', () => {
  test('isRemoteVersionNewer compares semver numerically without downgrades', () => {
    assert.equal(isRemoteVersionNewer('0.4.0', '0.3.8'), true);
    assert.equal(isRemoteVersionNewer('0.3.10', '0.3.9'), true);
    assert.equal(isRemoteVersionNewer('v1.0.0', '0.9.9'), true);
    assert.equal(isRemoteVersionNewer('0.4.0', '0.4.0'), false);
    assert.equal(isRemoteVersionNewer('0.3.9', '0.4.0'), false);
    assert.equal(isRemoteVersionNewer(null, '0.4.0'), false);
  });

  test('detectHudRender validates v0.4 minimal 2-line and ZH/ASCII HUDs', () => {
    const enHud = '\x1b[36m[Gemini 3 Pro (High)]\x1b[0m │ \x1b[33magy-hud\x1b[0m\n\x1b[32mContext\x1b[0m ███░░░░░░░ 25% │ Usage ██░░░░░░░░ 15%';
    const zhHud = '[Gemini 3 Pro] │ proj\n上下文 ███░░░░░░░ 42% │ 用量 ██░░░░░░░░ 20%';
    assert.equal(detectHudRender(enHud, renderTerminalScreen(enHud), stripAnsi(enHud)), true);
    assert.equal(detectHudRender(zhHud), true);
    assert.equal(detectHudRender('', 'random output', 'Usage of agy:'), false);
  });

  test('resolveNoAuthStatusLineSpawn avoids shell: true and preserves spaced/% Windows statusLine.command paths', () => {
    const winEnv = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    const spacedCmd = 'C:\\Users\\John Doe\\.gemini\\antigravity-cli\\agy-hud\\statusline.cmd';
    assert.deepEqual(
      resolveNoAuthStatusLineSpawn(spacedCmd, winEnv, 'win32', 'C:\\Program Files\\nodejs\\node.exe'),
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', `""${spacedCmd}""`],
        options: { shell: false, windowsVerbatimArguments: true },
      },
    );
    assert.deepEqual(
      resolveNoAuthStatusLineSpawn(`"${spacedCmd}"`, winEnv, 'win32', 'C:\\Program Files\\nodejs\\node.exe'),
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', `""${spacedCmd}""`],
        options: { shell: false, windowsVerbatimArguments: true },
      },
    );

    const pctCmd = 'C:\\Users\\100% legit\\agy-hud\\statusline.cmd';
    const pctSpawn = resolveNoAuthStatusLineSpawn(pctCmd, winEnv, 'win32');
    assert.deepEqual(pctSpawn, {
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Users\\100^%^ legit\\agy-hud\\statusline.cmd"'],
      options: { shell: false, windowsVerbatimArguments: true },
    });
    assert.equal(pctSpawn.args[3].includes('^^^"'), false);

    assert.deepEqual(
      resolveNoAuthStatusLineSpawn(spacedCmd, { ComSpec: 'C:\\Program Files\\cmd\\cmd.exe' }, 'win32'),
      {
        file: 'C:\\Program Files\\cmd\\cmd.exe',
        args: ['/d', '/s', '/c', `""${spacedCmd}""`],
        options: {
          shell: false,
          windowsVerbatimArguments: true,
          argv0: '"C:\\Program Files\\cmd\\cmd.exe"',
        },
      },
    );

    assert.deepEqual(
      resolveNoAuthStatusLineSpawn('C:\\Users\\John Doe\\statusline.mjs', winEnv, 'win32', 'C:\\Program Files\\nodejs\\node.exe'),
      {
        file: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\Users\\John Doe\\statusline.mjs'],
        options: { shell: false },
      },
    );

    const posixCmd = "'/usr/bin/node' '/home/user/.gemini/antigravity-cli/agy-hud/statusline.mjs'";
    assert.deepEqual(resolveNoAuthStatusLineSpawn(posixCmd, {}, 'linux'), {
      file: '/bin/sh',
      args: ['-c', posixCmd],
      options: { shell: false },
    });

    const verifyDisplaySource = fs.readFileSync(path.join(projectRoot, 'scripts', 'verify-display.js'), 'utf8');
    assert.equal(/\bshell\s*:\s*true\b/.test(verifyDisplaySource), false);
  });
});

describe('scripts / diagnose-auth', () => {
  test('summarizes file, Linux keyring, and macOS keychain tokens without leaking secrets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-diag-'));
    try {
      const home = path.join(tmp, 'home');
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({
        access_token: 'secret-access-token',
        refresh_token: 'secret-refresh-token',
        expiry_date: Date.parse('2026-12-20T12:10:00Z'),
      }));

      withEnv({ HOME: home, USERPROFILE: home, XDG_DATA_HOME: undefined, APPDATA: undefined, LOCALAPPDATA: undefined }, () => {
        const d1 = buildAuthDiagnostic({
          resolveAgyInfo: () => ({ found: false, candidates: [] }),
          platform: 'linux',
          keyringReader: () => null,
          keyringProbe: () => ({ available: false, reason: 'secret-tool-missing' }),
        });
        assert.equal(d1.readToken.found, true);
        assert.equal(d1.readToken.sourceFormat, 'oauth-creds');
        assert.equal(d1.keyringProbe.reason, 'secret-tool-missing');
        assert.doesNotMatch(JSON.stringify(d1), /secret-access-token|secret-refresh-token/);

        const d2 = buildAuthDiagnostic({
          resolveAgyInfo: () => ({ found: false, candidates: [] }),
          platform: 'darwin',
          keychainReader: () => ({ accessToken: 'secret-kc', sourceFormat: 'macos-keychain', email: 'u@example.com', all: [{ accessToken: 'secret-kc' }] }),
          keychainProbe: () => ({ available: true, security: '/usr/bin/security' }),
        });
        assert.equal(d2.readToken.sourceFormat, 'macos-keychain');
        assert.equal(d2.readToken.hasEmail, true);
        assert.doesNotMatch(JSON.stringify(d2), /secret-kc|u@example\.com/);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('runtime / uninstall & windows shims', () => {
  test('removeExtraFiles, clearStatusLine, writeCmdShim, and removeWindowsShShims clean cleanly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-test-'));
    try {
      const payloadFile = path.join(tmp, 'agy-hud-payload.json');
      const shellManifest = path.join(tmp, '.agy-hud-shell.json');
      const hostTemp = path.join(tmp, 'agy-hud-host-12345');
      const hudDir = path.join(tmp, 'agy-hud');
      const keepFile = path.join(tmp, 'other.json');
      fs.writeFileSync(payloadFile, '{}');
      fs.writeFileSync(shellManifest, '{}');
      fs.mkdirSync(hostTemp, { recursive: true });
      fs.writeFileSync(path.join(hostTemp, 'state.json'), '{}');
      fs.mkdirSync(hudDir, { recursive: true });
      fs.writeFileSync(path.join(hudDir, 'statusline.mjs'), 'x');
      fs.writeFileSync(keepFile, '{}');

      const removed = removeExtraFiles(tmp);
      assert.ok(removed.includes(payloadFile));
      assert.ok(removed.includes(shellManifest));
      assert.ok(removed.includes(hostTemp));
      assert.ok(removed.includes(hudDir));
      assert.equal(fs.existsSync(keepFile), true);

      const settingsPath = path.join(tmp, 'settings.json');
      const runtimeDir = path.join(tmp, 'agy-hud-runtime');
      fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: `node "${tmp}/agy-hud/statusline.mjs"` }, theme: 'dark' }));
      assert.equal(clearStatusLine(settingsPath, runtimeDir).changed, true);
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, undefined);
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).theme, 'dark');

      fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'echo other' } }));
      assert.equal(clearStatusLine(settingsPath, runtimeDir).reason, 'foreign_status_line');

      const shim = writeCmdShim(path.join(tmp, 'statusline.mjs'), 'win32');
      assert.ok(shim && shim.endsWith('.cmd') && fs.readFileSync(shim, 'utf8').includes('statusline.mjs'));
      assert.equal(createStatusLineCommand('C:\\x\\statusline.mjs', 'node.exe', 'win32'), 'C:\\x\\statusline.cmd');
      assert.match(buildCmdShimContents('C:\\x\\statusline.mjs', 'D:\\nodejs\\node.exe'), /if exist "D:\\nodejs\\node\.exe"/);
      assert.equal(
        buildCommand('powershell', 'C:\\Users\\Administrator\\.gemini\\antigravity-cli\\agy-hud\\statusline.mjs'),
        'C:\\Users\\Administrator\\.gemini\\antigravity-cli\\agy-hud\\statusline.cmd',
      );
      assert.equal(
        buildCommand('powershell', 'C:\\Users\\John Doe\\.gemini\\antigravity-cli\\agy-hud\\statusline.mjs'),
        'C:\\Users\\John Doe\\.gemini\\antigravity-cli\\agy-hud\\statusline.cmd',
      );

      const shShim = buildShShimContents();
      assert.ok(shShim.includes('set "CMDLINE=%CMDLINE:\\"="%"'));
      assert.match(shShim, /cmd\.exe \/d \/s \/c "%CMDLINE%"/);

      // Upgrades legacy v0.4.0-v0.4.3 sh.cmd while leaving genuine third-party sh.cmd untouched
      const localApp = path.join(tmp, 'localapp');
      const agyBin = path.join(localApp, 'agy', 'bin');
      fs.mkdirSync(agyBin, { recursive: true });
      fs.writeFileSync(path.join(agyBin, 'sh.cmd'), LEGACY_SH_SHIM_BODY);
      fs.writeFileSync(path.join(agyBin, 'sh.bat'), '@echo third-party\r\n');
      const upgraded = ensureWindowsShShim('win32', { LOCALAPPDATA: localApp, PATH: '' });
      assert.deepEqual(upgraded, [path.join(agyBin, 'sh.cmd')]);
      assert.equal(fs.readFileSync(path.join(agyBin, 'sh.cmd'), 'utf8'), shShim);
      assert.equal(fs.readFileSync(path.join(agyBin, 'sh.bat'), 'utf8'), '@echo third-party\r\n');
      assert.deepEqual(removeWindowsShShims('linux', {}), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('runtime/bin/agy-hud.cmd and buildCmdShimContents preserve stderr, probe with where node, and avoid double execution', () => {
    const binCmd = fs.readFileSync(path.join(projectRoot, 'runtime', 'bin', 'agy-hud.cmd'), 'utf8');
    const pinnedCmd = buildCmdShimContents('C:\\x\\statusline.mjs', 'D:\\nodejs\\node.exe');
    const fallbackOnlyCmd = buildCmdShimContents('C:\\x\\statusline.mjs', '/usr/bin/node');

    for (const [label, content] of [
      ['runtime/bin/agy-hud.cmd', binCmd],
      ['pinned buildCmdShimContents', pinnedCmd],
      ['fallback buildCmdShimContents', fallbackOnlyCmd],
    ]) {
      const lines = content.split(/\r?\n/);
      assert.ok(lines.includes('where node >nul 2>nul'), `${label} must probe PATH with where node`);
      assert.ok(lines.includes('exit /b %ERRORLEVEL%'), `${label} must exit with child ERRORLEVEL`);
      assert.ok(lines.includes('exit /b 9009'), `${label} must fail explicitly when node is missing`);
      assert.doesNotMatch(content, /if\s+%ERRORLEVEL%==0\s+exit\s+\/b\s+0/i, `${label} must not retry on non-zero exit`);
      assert.doesNotMatch(content, /\([\s\S]*exit\s+\/b\s+%ERRORLEVEL%/i, `${label} must not evaluate ERRORLEVEL inside parenthesized block`);

      const execLines = lines.filter((line) => /%\*$/.test(line.trim()));
      assert.ok(execLines.length >= 2, `${label} must include PATH and ProgramFiles execution lines`);
      for (const execLine of execLines) {
        assert.equal(execLine.includes('2>nul'), false, `${label} execution line must preserve stderr: ${execLine}`);
      }
    }

    if (process.platform === 'win32') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-shim-exec-'));
      try {
        const script = path.join(tmp, 'target.mjs');
        const logFile = path.join(tmp, 'calls.log');
        const shimPath = path.join(tmp, 'target.cmd');
        fs.writeFileSync(script, [
          'import fs from "node:fs";',
          `fs.appendFileSync(${JSON.stringify(logFile)}, "run\\n");`,
          'process.stderr.write("STDERR_VISIBLE\\n");',
          'process.exit(3);',
        ].join('\n'));
        // Omit pinned nodePath so execution exercises the `where node` branch directly
        fs.writeFileSync(shimPath, buildCmdShimContents(script, '/nonexistent/node'), 'utf8');
        const res = spawnSync(
          process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
          ['/d', '/s', '/c', `""${shimPath}" --flag"`],
          {
            env: {
              ...process.env,
              PATH: `${path.dirname(process.execPath)};${process.env.PATH || process.env.Path || ''}`,
            },
            encoding: 'utf8',
            windowsVerbatimArguments: true,
          },
        );
        assert.equal(res.status, 3);
        assert.match(res.stderr, /STDERR_VISIBLE/);
        assert.deepEqual(fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/), ['run']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
  });

  test('uninstall continues clearing settings.json and other artifacts when removeRuntimeDir fails due to lock/permission', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-locked-'));
    try {
      const home = path.join(tmp, 'home');
      const root = path.join(home, '.gemini', 'antigravity-cli');
      const runtimeDir = path.join(root, 'agy-hud-runtime');
      const settingsPath = path.join(root, 'settings.json');
      const payloadFile = path.join(root, 'agy-hud-payload.json');
      const psProfile = path.join(home, 'Documents', 'PowerShell', 'profile.ps1');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.mkdirSync(path.dirname(psProfile), { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, 'conpty.node'), 'locked');
      fs.writeFileSync(payloadFile, '{}');
      fs.writeFileSync(psProfile, '# user profile\r\n');
      fs.writeFileSync(settingsPath, JSON.stringify({
        statusLine: { type: 'command', command: `${root}\\agy-hud\\statusline.cmd` },
        theme: 'dark',
      }));

      // Direct removeRuntimeDir checks retries and structured failure result
      let capturedOpts = null;
      const okRm = removeRuntimeDir(runtimeDir, {
        existsSync: () => true,
        rmSync: (_p, opts) => { capturedOpts = opts; },
      });
      assert.deepEqual(okRm, { removed: true });
      assert.deepEqual(capturedOpts, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

      const failedRm = removeRuntimeDir(runtimeDir, {
        existsSync: () => true,
        rmSync: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
      });
      assert.deepEqual(failedRm, { removed: false, reason: 'EPERM' });

      // Full uninstall continues despite EBUSY on runtimeDir
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGY_HUD_DATA_DIR: root,
        AGY_HUD_SHELL: 'powershell',
        AGY_HUD_PS_PROFILE: psProfile,
      };
      const result = uninstall({
        env,
        homeDir: home,
        platform: 'linux',
        rmSync: (target, opts) => {
          if (target === runtimeDir) {
            throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
          }
          return fs.rmSync(target, opts);
        },
      });

      assert.deepEqual(result.runtimes, [{ runtimeDir, removed: false, reason: 'EBUSY' }]);
      assert.deepEqual(result.statusLine, { changed: true });
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine, undefined);
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).theme, 'dark');
      assert.equal(fs.existsSync(payloadFile), false);
      assert.equal(fs.existsSync(runtimeDir), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('scripts / bootstrap win32 npm spawn', () => {
  test('prefers npm-cli.js via execPath and quotes ^ specs with windowsVerbatimArguments in cmd.exe fallback', () => {
    const targetDir = 'C:\\Users\\John Doe\\.gemini\\antigravity-cli\\agy-hud-runtime.tmp-1';
    const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
    const siblingCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const env = {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATH: 'C:\\Program Files\\nodejs',
    };

    const viaPosix = buildNpmDepsSpawn('/tmp/agy-hud-runtime.tmp-1', env, { platform: 'linux' });
    assert.deepEqual(viaPosix.options.stdio, ['ignore', 'ignore', 'pipe']);

    const viaCli = buildNpmDepsSpawn(targetDir, env, {
      platform: 'win32',
      execPath: nodeExe,
      existsSync: (p) => p === siblingCli,
    });
    assert.equal(viaCli.cmd, nodeExe);
    assert.equal(viaCli.args[0], siblingCli);
    assert.ok(viaCli.args.includes('@xterm/headless@^6.0.0'));
    assert.ok(viaCli.args.includes(targetDir));
    assert.equal(viaCli.options.windowsVerbatimArguments, undefined);
    assert.deepEqual(viaCli.options.stdio, ['ignore', 'ignore', 'pipe']);

    const viaCmd = buildNpmDepsSpawn(targetDir, env, {
      platform: 'win32',
      execPath: nodeExe,
      existsSync: (p) => p === 'C:\\Program Files\\nodejs\\npm.cmd',
    });
    assert.equal(viaCmd.cmd, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(viaCmd.options.windowsVerbatimArguments, true);
    assert.deepEqual(viaCmd.options.stdio, ['ignore', 'ignore', 'pipe']);
    assert.deepEqual(viaCmd.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(viaCmd.args[3].startsWith('"') && viaCmd.args[3].endsWith('"'));
    assert.ok(viaCmd.args[3].includes('"C:\\Program Files\\nodejs\\npm.cmd"'));
    assert.ok(viaCmd.args[3].includes(`"${targetDir}"`));
    assert.ok(viaCmd.args[3].includes('"@xterm/headless@^6.0.0"'));

    const pctEnv = {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATH: 'C:\\Users\\100% legit\\nodejs',
    };
    const viaPctCmd = buildNpmDepsSpawn(targetDir, pctEnv, {
      platform: 'win32',
      execPath: nodeExe,
      existsSync: (p) => p === 'C:\\Users\\100% legit\\nodejs\\npm.cmd',
    });
    assert.equal(viaPctCmd.cmd, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(viaPctCmd.options.windowsVerbatimArguments, true);
    assert.deepEqual(viaPctCmd.options.stdio, ['ignore', 'ignore', 'pipe']);
    assert.deepEqual(viaPctCmd.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(viaPctCmd.args[3].startsWith('"C:\\Users\\100^%^ legit\\nodejs\\npm.cmd '));
    assert.equal(viaPctCmd.args[3].includes('^^^"'), false);
    assert.ok(viaPctCmd.args[3].includes(`"${targetDir}"`));
    assert.ok(viaPctCmd.args[3].includes('"@xterm/headless@^6.0.0"'));
  });
});

describe('scripts / bootstrap', () => {
  test('installs complete ESM/TS runtime and statusline launcher into isolated HOME', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-boot-home-'));
    try {
      const result = spawnSync(process.execPath, ['scripts/bootstrap.js'], {
        cwd: projectRoot,
        env: { ...process.env, HOME: home, USERPROFILE: home, AGY_HUD_SETUP_SOURCE_DIR: projectRoot, AGY_HUD_DATA_DIR: '', APPDATA: '', LOCALAPPDATA: '', XDG_DATA_HOME: '' },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const base = path.join(home, '.gemini', 'antigravity-cli');
      const runtime = path.join(base, 'agy-hud-runtime');
      const settings = JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8'));

      for (const rel of RUNTIME_FILES) {
        assert.equal(fs.existsSync(path.join(runtime, ...rel.split('/'))), true, `Missing runtime file: ${rel}`);
      }
      assert.equal(settings.statusLine.type, 'command');
      assert.ok(settings.statusLine.command.includes(home));
      assert.match(settings.statusLine.command, /agy-hud[/\\]statusline\.(?:mjs|cmd)/);
      assert.match(result.stdout, /AGY-HUD bootstrap complete/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('refreshes quota cache when active token exists, skips expired tokens, cleans stale plugin files, and swaps atomically', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-boot-quota-'));
    const incompleteSource = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-incomplete-'));
    const previousFetch = globalThis.fetch;
    try {
      const base = path.join(home, '.gemini', 'antigravity-cli');
      const tokenPath = path.join(base, 'antigravity-oauth-token');
      const pluginDir = path.join(home, '.gemini', 'config', 'plugins', 'agy-hud');
      fs.mkdirSync(base, { recursive: true });
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'hooks.json'), '{}');

      // 1. Expired token skips network calls
      fs.writeFileSync(tokenPath, JSON.stringify({ token: { access_token: 'exp', expiry: '2000-01-01T00:00:00.000Z' } }));
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls += 1; return { ok: false, status: 401, json: async () => ({}) }; };

      const expiredRes = await installRuntime({
        homeDir: home,
        sourceDir: projectRoot,
        platform: 'linux',
        keyringReader: () => null,
        env: { ...process.env, HOME: home, USERPROFILE: home, AGY_HUD_DATA_DIR: '' },
      });
      assert.deepEqual(expiredRes.quotaRefresh, { status: 'skipped', reason: 'expired_token' });
      assert.equal(fetchCalls, 0);
      assert.equal(fs.existsSync(path.join(pluginDir, 'hooks.json')), false);

      // 2. Valid token refreshes quota cache cleanly
      fs.writeFileSync(tokenPath, JSON.stringify({ token: { access_token: 'valid', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
      globalThis.fetch = async (url) => {
        if (String(url).includes('loadCodeAssist')) {
          return { ok: true, status: 200, json: async () => ({ paidTier: { name: 'Google AI Pro' } }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: { 'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)', quotaInfo: { remainingFraction: 0.77, resetTime: new Date(Date.now() + 3600_000).toISOString() } } },
          }),
        };
      };
      const okRes = await installRuntime({
        homeDir: home,
        sourceDir: projectRoot,
        platform: 'linux',
        keyringReader: () => null,
        env: { ...process.env, HOME: home, USERPROFILE: home, AGY_HUD_DATA_DIR: '' },
      });
      assert.deepEqual(okRes.quotaRefresh, { status: 'refreshed', count: 1, tier: 'Google AI Pro' });
      const { readCache } = await import(`${pathToFileURL(path.join(okRes.runtimeDir, 'runtime', 'quota.mjs')).href}?t=${Date.now()}`);
      const cached = readCache({ accessToken: 'rotated', sourcePath: tokenPath }, path.join(base, 'agy-hud-quota-cache.json'));
      assert.equal(cached?.[0]?.remainingFraction, 0.77);

      // 3. Atomic failure preserves existing runtime
      const sentinel = path.join(okRes.runtimeDir, 'hud.mjs');
      assert.ok(cleanStalePluginFiles(base, { homeDir: home }).length === 0);
      await assert.rejects(
        () => installRuntime({ homeDir: home, sourceDir: incompleteSource, env: { ...process.env, HOME: home, USERPROFILE: home, AGY_HUD_DATA_DIR: '' } }),
        /ENOENT/,
      );
      assert.equal(fs.existsSync(sentinel), true);

      // 4. Remote download recovers cleanly from transient HTTP 503 bursts with backoff
      const attemptsByPath = new Map();
      const server = http.createServer((req, res) => {
        const rel = String(req.url || '').replace(/^\/+/, '');
        const count = (attemptsByPath.get(rel) || 0) + 1;
        attemptsByPath.set(rel, count);
        if (count <= 2) {
          res.writeHead(503);
          res.end('Service Unavailable');
          return;
        }
        const filePath = path.join(projectRoot, ...rel.split('/'));
        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        fs.createReadStream(filePath).pipe(res);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const retryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-boot-503-'));
      try {
        const port = server.address().port;
        const retryRes = await installRuntime({
          homeDir: retryHome,
          sourceBase: `http://127.0.0.1:${port}`,
          platform: 'linux',
          retryBaseMs: 5,
          env: { ...process.env, HOME: retryHome, USERPROFILE: retryHome, AGY_HUD_DATA_DIR: '' },
        });
        assert.equal(fs.existsSync(path.join(retryRes.runtimeDir, 'dist', 'index.js')), true);
        assert.equal(attemptsByPath.get('dist/index.js'), 3);
        assert.deepEqual(retryRes.depsStatus, { status: 'skipped', reason: 'local_test_server' });
      } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(retryHome, { recursive: true, force: true });
      }
    } finally {
      globalThis.fetch = previousFetch;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(incompleteSource, { recursive: true, force: true });
    }
  });
});

describe('runtime / pty-deps staging, install --shell-wrap, depsInstaller & full uninstall', () => {
  test('stageDependencies and scripts/stage-deps.mjs copy host and 6-platform bundled dependencies without .pdb', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-stage-'));
    try {
      assert.equal(hasHostDependencies(projectRoot), true);
      const hostDir = path.join(tmp, 'host');
      const hostRes = stageDependencies(projectRoot, hostDir, { hostOnly: true });
      assert.deepEqual(hostRes.files.filter((f) => !f.includes('LICENSE') || hostDependencyFiles().includes(f)), hostDependencyFiles());
      assert.equal(fs.existsSync(path.join(hostDir, 'node_modules', 'node-pty', 'LICENSE')), true);
      assert.equal(fs.existsSync(path.join(hostDir, 'node_modules', 'node-addon-api', 'LICENSE.md')), true);

      const bundledDir = path.join(tmp, 'bundled');
      const cliRes = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'stage-deps.mjs'), bundledDir, '--bundled'], {
        cwd: projectRoot,
        encoding: 'utf8',
      });
      assert.equal(cliRes.status, 0, cliRes.stderr);
      for (const rel of bundledDependencyFiles) {
        assert.equal(fs.existsSync(path.join(bundledDir, ...rel.split('/'))), true, `Missing bundled file: ${rel}`);
      }
      const allStaged = fs.readdirSync(bundledDir, { recursive: true });
      assert.equal(allStaged.some((f) => String(f).endsWith('.pdb')), false);
      if (process.platform !== 'win32') {
        const helperMode = fs.statSync(path.join(bundledDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper')).mode;
        assert.notEqual(helperMode & 0o111, 0, 'darwin spawn-helper must keep executable bit');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('installRuntime stages host deps, supports depsInstaller success/fallback, and uninstall cleans shell integration', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-stage-boot-'));
    try {
      // 1. Local sourceDir with node_modules auto-stages native deps + installs bash wrapper, then uninstalls cleanly
      const homeA = path.join(tmp, 'home-a');
      fs.mkdirSync(homeA, { recursive: true });
      fs.writeFileSync(path.join(homeA, '.bashrc'), '# user bashrc\n');
      const envA = { ...process.env, HOME: homeA, USERPROFILE: homeA, SHELL: '/bin/bash', AGY_HUD_SHELL: 'bash', AGY_HUD_DATA_DIR: '', XDG_DATA_HOME: '', APPDATA: '', LOCALAPPDATA: '' };
      const resA = await installRuntime({ homeDir: homeA, sourceDir: projectRoot, platform: 'linux', env: envA });
      assert.equal(resA.depsStatus.status, 'staged');
      assert.equal(resA.shellIntegration.shell, 'bash');
      for (const rel of hostDependencyFiles('linux')) {
        assert.equal(fs.existsSync(path.join(resA.runtimeDir, ...rel.split('/'))), true, `Missing staged dep: ${rel}`);
      }
      assert.match(fs.readFileSync(path.join(homeA, '.bashrc'), 'utf8'), /# >>> agy-hud /);
      assert.equal(fs.existsSync(path.join(resA.antigravityRoot, '.agy-hud-shell.json')), true);
      fs.writeFileSync(path.join(resA.antigravityRoot, 'agy-hud-host-999'), 'stale');

      const unRes = uninstall({ env: envA, homeDir: homeA, platform: 'linux' });
      assert.equal(unRes.statusLine.changed, true);
      assert.equal(fs.readFileSync(path.join(homeA, '.bashrc'), 'utf8'), '# user bashrc\n');
      assert.equal(fs.existsSync(path.join(resA.antigravityRoot, '.agy-hud-shell.json')), false);
      assert.equal(fs.existsSync(path.join(resA.antigravityRoot, 'agy-hud-host-999')), false);
      assert.equal(fs.existsSync(resA.runtimeDir), false);

      // 1b. Host-platform installRuntime stages native deps for process.platform (including Windows ConPTY files)
      const homeHost = path.join(tmp, 'home-host');
      fs.mkdirSync(homeHost, { recursive: true });
      const envHost = {
        ...process.env,
        HOME: homeHost,
        USERPROFILE: homeHost,
        AGY_HUD_SHELL: 'none',
        AGY_HUD_DATA_DIR: '',
        XDG_DATA_HOME: '',
        APPDATA: '',
        LOCALAPPDATA: '',
        PATH: '',
        Path: '',
      };
      const resHost = await installRuntime({
        homeDir: homeHost,
        sourceDir: projectRoot,
        platform: process.platform,
        env: envHost,
      });
      assert.equal(resHost.depsStatus.status, 'staged');
      for (const rel of hostDependencyFiles(process.platform)) {
        assert.equal(fs.existsSync(path.join(resHost.runtimeDir, ...rel.split('/'))), true, `Missing host staged dep: ${rel}`);
      }
      if (process.platform === 'win32') {
        const prebuildDir = path.join(resHost.runtimeDir, 'node_modules', 'node-pty', 'prebuilds', `win32-${process.arch}`);
        assert.equal(fs.existsSync(path.join(prebuildDir, 'conpty.node')), true);
        assert.equal(fs.existsSync(path.join(prebuildDir, 'conpty', 'conpty.dll')), true);
        assert.equal(fs.existsSync(path.join(prebuildDir, 'conpty', 'OpenConsole.exe')), true);
      }
      const unHost = uninstall({ env: envHost, homeDir: homeHost, platform: process.platform });
      assert.equal(unHost.statusLine.changed, true);
      assert.equal(fs.existsSync(resHost.runtimeDir), false);

      // 2. sourceDir without node_modules invokes depsInstaller and degrades gracefully on failure
      const cloneDir = path.join(tmp, 'git-clone');
      for (const rel of RUNTIME_FILES) {
        const dest = path.join(cloneDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(projectRoot, ...rel.split('/')), dest);
      }

      const homeB = path.join(tmp, 'home-b');
      fs.mkdirSync(homeB, { recursive: true });
      const envB = { ...process.env, HOME: homeB, USERPROFILE: homeB, AGY_HUD_SHELL: 'none', AGY_HUD_DATA_DIR: '', XDG_DATA_HOME: '', APPDATA: '', LOCALAPPDATA: '' };
      let installerTarget = null;
      const resB = await installRuntime({
        homeDir: homeB,
        sourceDir: cloneDir,
        env: envB,
        depsInstaller: async (dir) => {
          installerTarget = dir;
          fs.mkdirSync(path.join(dir, 'node_modules', 'dummy'), { recursive: true });
        },
      });
      assert.ok(installerTarget);
      assert.deepEqual(resB.depsStatus, { status: 'installed', source: 'custom' });
      assert.equal(resB.shellIntegration.status, 'skipped');
      assert.equal(fs.existsSync(path.join(resB.runtimeDir, 'node_modules', 'dummy')), true);
      assert.equal(fs.existsSync(path.join(homeB, '.bashrc')), false);

      const resFail = await installRuntime({
        homeDir: homeB,
        sourceDir: cloneDir,
        env: envB,
        depsInstaller: async () => {
          throw new Error('simulated network offline');
        },
      });
      assert.equal(resFail.depsStatus.status, 'failed');
      assert.match(resFail.depsStatus.reason, /simulated network offline/);
      assert.equal(fs.existsSync(resFail.settingsPath), true);

      // 3. install.mjs without --shell-wrap skips shell; with --shell-wrap configures shell
      const homeC = path.join(tmp, 'home-c');
      const cfgC = path.join(homeC, '.gemini', 'antigravity-cli');
      fs.mkdirSync(cfgC, { recursive: true });
      const bashWrapEnv = { HOME: homeC, SHELL: '/bin/bash', ...(process.platform === 'win32' ? { AGY_HUD_SHELL: 'bash' } : {}) };
      install({ configDir: cfgC, argv: [], env: bashWrapEnv });
      assert.equal(fs.existsSync(path.join(homeC, '.bashrc')), false);
      const wrapReport = install({ configDir: cfgC, argv: ['--replace', '--shell-wrap'], env: bashWrapEnv });
      assert.equal(wrapReport.shellIntegration.shell, 'bash');
      assert.match(fs.readFileSync(path.join(homeC, '.bashrc'), 'utf8'), /# >>> agy-hud /);

      // 4. install.mjs --shell-wrap configures PowerShell profile across platforms
      const homeD = path.join(tmp, 'home-d');
      const cfgD = path.join(homeD, '.gemini', 'antigravity-cli');
      const psProfilePath = path.join(homeD, 'Documents', 'PowerShell', 'profile.ps1');
      fs.mkdirSync(cfgD, { recursive: true });
      const psReport = install({
        configDir: cfgD,
        argv: ['--replace', '--shell-wrap'],
        env: { HOME: homeD, USERPROFILE: homeD, AGY_HUD_SHELL: 'powershell', AGY_HUD_PS_PROFILE: psProfilePath },
      });
      assert.equal(psReport.shellIntegration.shell, 'powershell');
      assert.equal(fs.existsSync(psProfilePath), true);
      const psProfileContent = fs.readFileSync(psProfilePath, 'utf8');
      assert.match(psProfileContent, /# >>> agy-hud /);
      assert.match(psProfileContent, /function global:agy/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
