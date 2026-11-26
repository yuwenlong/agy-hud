import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isHudDisabled,
  isInteractiveAgyInvocation,
  launchAgy,
  NON_INTERACTIVE_FLAGS,
  NON_INTERACTIVE_SUBCOMMANDS,
  passthrough,
  resolveAgyBinary,
  resolveSpawnCommand,
} from '../runtime/launch.mjs';
import { TerminalDependencyError } from '../runtime/pty-host.mjs';

const require = createRequire(import.meta.url);
const { argsToCommandLine } = require('../node_modules/node-pty/lib/windowsPtyAgent.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('runtime / launch invocation classification', () => {
  const ttyIn = { isTTY: true };
  const ttyOut = { isTTY: true };
  const baseEnv = { TERM: 'xterm-256color' };

  test('detects all non-interactive subcommands and flags as passthrough', () => {
    for (const sub of NON_INTERACTIVE_SUBCOMMANDS) {
      assert.equal(isInteractiveAgyInvocation([sub], baseEnv, ttyIn, ttyOut), false, `subcommand ${sub} should passthrough`);
    }
    for (const flag of NON_INTERACTIVE_FLAGS) {
      assert.equal(isInteractiveAgyInvocation([flag], baseEnv, ttyIn, ttyOut), false, `flag ${flag} should passthrough`);
    }

    assert.equal(isInteractiveAgyInvocation(['--output-format=stream-json'], baseEnv, ttyIn, ttyOut), false);
    assert.equal(isInteractiveAgyInvocation(['--input-format', 'stream-json'], baseEnv, ttyIn, ttyOut), false);
    assert.equal(isInteractiveAgyInvocation(['--settings', '{}', 'plugin', 'list'], baseEnv, ttyIn, ttyOut), false);
  });

  test('detects bypass env, disabled env, dumb TERM, and non-TTY as passthrough', () => {
    assert.equal(isHudDisabled({ AGY_HUD_DISABLE: '1' }), true);
    assert.equal(isHudDisabled({ CLAUDE_HUD_DISABLE: 'true' }), true);
    assert.equal(isHudDisabled({ AGY_HUD_DISABLE: '0' }), false);
    assert.equal(isInteractiveAgyInvocation([], { ...baseEnv, AGY_HUD_BYPASS: '1' }, ttyIn, ttyOut), false);
    assert.equal(isInteractiveAgyInvocation([], { ...baseEnv, AGY_HUD_DISABLE: '1' }, ttyIn, ttyOut), false);
    assert.equal(isInteractiveAgyInvocation([], { TERM: 'dumb' }, ttyIn, ttyOut), false);
    assert.equal(isInteractiveAgyInvocation([], baseEnv, { isTTY: false }, ttyOut), false);
    assert.equal(isInteractiveAgyInvocation([], baseEnv, ttyIn, { isTTY: false }), false);
  });

  test('treats normal interactive invocations and value-option collisions as interactive', () => {
    assert.equal(isInteractiveAgyInvocation([], baseEnv, ttyIn, ttyOut), true);
    assert.equal(isInteractiveAgyInvocation(['--model', 'gemini-3-pro', 'fix the bug'], baseEnv, ttyIn, ttyOut), true);
    assert.equal(isInteractiveAgyInvocation(['--project', 'mcp', 'hello'], baseEnv, ttyIn, ttyOut), true);
    assert.equal(isInteractiveAgyInvocation(['--', 'help'], baseEnv, ttyIn, ttyOut), true);
  });
});

describe('runtime / resolveAgyBinary', () => {
  test('resolves AGY_BIN override, PATH executables, and standard ~/.local/bin and Windows LOCALAPPDATA locations', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-resolve-test-'));
    try {
      // 1. Simulated POSIX ('linux') lookup using pure POSIX mock paths & fsOps (safe on Windows too)
      const linuxFiles = new Set([
        '/mock/custom-agy',
        '/mock/path-bin/agy',
        '/mock/home/.local/bin/agy',
      ]);
      const linuxFsOps = {
        statSync: (p) => {
          if (!linuxFiles.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
          return { isFile: () => true };
        },
        accessSync: (p) => {
          if (!linuxFiles.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        },
        realpathSync: (p) => p,
        homedir: () => '/mock/home',
      };
      assert.equal(resolveAgyBinary({ AGY_BIN: '/mock/custom-agy', PATH: '' }, 'linux', linuxFsOps), '/mock/custom-agy');

      assert.throws(
        () => resolveAgyBinary({ AGY_BIN: '/mock/missing-agy', PATH: '' }, 'linux', linuxFsOps),
        /AGY_BIN/,
      );

      // Search PATH and skip relative entries
      assert.equal(
        resolveAgyBinary({ PATH: ['.', 'rel', '/mock/path-bin'].join(':'), HOME: '/mock/nohome' }, 'linux', linuxFsOps),
        '/mock/path-bin/agy',
      );

      // Fallback to ~/.local/bin/agy
      assert.equal(
        resolveAgyBinary({ PATH: '', HOME: '/mock/home' }, 'linux', linuxFsOps),
        '/mock/home/.local/bin/agy',
      );

      // 2. Real host filesystem resolution using native path.delimiter
      const isWin = process.platform === 'win32';
      const realCustom = path.join(tmp, isWin ? 'custom-agy.cmd' : 'custom-agy');
      fs.writeFileSync(realCustom, isWin ? '@echo ok\r\n' : '#!/bin/sh\necho ok\n', { mode: 0o755 });
      assert.equal(resolveAgyBinary({ AGY_BIN: realCustom, PATH: '' }), realCustom);

      const realPathDir = path.join(tmp, 'path-bin');
      fs.mkdirSync(realPathDir, { recursive: true });
      const realPathAgy = path.join(realPathDir, isWin ? 'agy.cmd' : 'agy');
      fs.writeFileSync(realPathAgy, isWin ? '@echo path\r\n' : '#!/bin/sh\necho path\n', { mode: 0o755 });
      assert.equal(
        resolveAgyBinary({
          PATH: ['.', 'rel', realPathDir].join(path.delimiter),
          HOME: path.join(tmp, 'nohome'),
          USERPROFILE: path.join(tmp, 'nohome'),
        }),
        realPathAgy,
      );

      // 3. Simulated Windows %LOCALAPPDATA%\agy\bin\agy.exe and .cmd fallback lookup
      const winLocalApp = 'C:\\Users\\Alice\\AppData\\Local';
      const winExpected = 'C:\\Users\\Alice\\AppData\\Local\\agy\\bin\\agy.exe';
      const resolvedWin = resolveAgyBinary(
        { PATH: '', LOCALAPPDATA: winLocalApp, USERPROFILE: 'C:\\Users\\Alice' },
        'win32',
        {
          statSync: (p) => ({ isFile: () => p === winExpected }),
          realpathSync: (p) => p,
          homedir: () => 'C:\\Users\\Alice',
        },
      );
      assert.equal(resolvedWin, winExpected);

      const winCmdPath = 'C:\\Tools\\agy\\agy.cmd';
      const winCmdFsOps = {
        statSync: (p) => {
          if (p !== winCmdPath) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
          return { isFile: () => true };
        },
        realpathSync: (p) => p,
        homedir: () => 'C:\\Users\\Alice',
      };
      assert.equal(
        resolveAgyBinary({ PATH: ['.', 'C:\\Tools\\agy'].join(';'), USERPROFILE: 'C:\\Users\\Alice' }, 'win32', winCmdFsOps),
        winCmdPath,
      );
      assert.equal(
        resolveAgyBinary({ AGY_BIN: winCmdPath, PATH: '' }, 'win32', winCmdFsOps),
        winCmdPath,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('runtime / launchAgy routing, fallback & cleanup', () => {
  test('passes through non-interactive invocations without creating temp host state', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-nonint-'));
    try {
      let hostCalled = false;
      let passthroughArgs = null;
      const code = await launchAgy(['--version'], {
        env: { TERM: 'xterm-256color' },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        tmpdir: tmp,
        resolveBinary: () => '/usr/bin/agy',
        runHost: async () => {
          hostCalled = true;
          return 0;
        },
        passthroughFn: async (file, args) => {
          passthroughArgs = { file, args };
          return 0;
        },
      });
      assert.equal(code, 0);
      assert.equal(hostCalled, false);
      assert.deepEqual(passthroughArgs, { file: '/usr/bin/agy', args: ['--version'] });
      assert.deepEqual(fs.readdirSync(tmp), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('injects unique temp AGY_HUD_HOST_STATE in interactive mode and cleans up on normal exit and TerminalDependencyError fallback', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-int-'));
    try {
      // 1. Normal interactive run
      let capturedStatePath = null;
      const normalCode = await launchAgy(['--model', 'gemini-3-pro'], {
        env: { TERM: 'xterm-256color' },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        tmpdir: tmp,
        resolveBinary: () => '/usr/bin/agy',
        runHost: async ({ hostStatePath }) => {
          capturedStatePath = hostStatePath;
          fs.writeFileSync(hostStatePath, '{}');
          return 7;
        },
        passthroughFn: async () => 0,
      });
      assert.equal(normalCode, 7);
      assert.ok(capturedStatePath);
      assert.equal(fs.existsSync(capturedStatePath), false);
      assert.deepEqual(fs.readdirSync(tmp), []);

      // 2. Fallback on TerminalDependencyError
      const warnings = [];
      let passthroughCalled = false;
      const fallbackCode = await launchAgy([], {
        env: { TERM: 'xterm-256color' },
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        stderr: { write: (msg) => warnings.push(msg) },
        tmpdir: tmp,
        resolveBinary: () => '/usr/bin/agy',
        runHost: async ({ hostStatePath }) => {
          fs.writeFileSync(hostStatePath, '{}');
          throw new TerminalDependencyError(new Error('missing pty.node'));
        },
        passthroughFn: async (file, args) => {
          passthroughCalled = true;
          assert.equal(file, '/usr/bin/agy');
          assert.deepEqual(args, []);
          return 42;
        },
      });
      assert.equal(fallbackCode, 42);
      assert.equal(passthroughCalled, true);
      assert.match(warnings.join(''), /terminal dependencies unavailable/i);
      assert.deepEqual(fs.readdirSync(tmp), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('adapts Windows .mjs/.js/.cjs scripts to process.execPath and .cmd/.bat to cmd.exe in passthrough and launchAgy', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-win-'));
    try {
      const fakeNode = 'C:\\Program Files\\nodejs\\node.exe';
      const winEnv = { TERM: 'xterm-256color', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };

      // 1. resolveSpawnCommand normalization across extensions and platforms
      for (const ext of ['.mjs', '.js', '.cjs', '.MJS']) {
        const script = `C:\\Users\\Alice\\mock-agy${ext}`;
        assert.deepEqual(
          resolveSpawnCommand(script, ['--model', 'gemini-3-pro'], { env: winEnv, platform: 'win32', execPath: fakeNode }),
          { file: fakeNode, args: [script, '--model', 'gemini-3-pro'] },
        );
      }
      for (const ext of ['.cmd', '.bat', '.CMD']) {
        const batch = `C:\\Users\\Alice\\agy${ext}`;
        assert.deepEqual(
          resolveSpawnCommand(batch, ['--version'], { env: winEnv, platform: 'win32', execPath: fakeNode }),
          {
            file: 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/s', '/c', `""${batch}" --version"`],
            windowsVerbatimArguments: true,
          },
        );
      }
      assert.deepEqual(
        resolveSpawnCommand('C:\\Users\\Alice\\agy.exe', ['--version'], { env: winEnv, platform: 'win32', execPath: fakeNode }),
        { file: 'C:\\Users\\Alice\\agy.exe', args: ['--version'] },
      );
      assert.deepEqual(
        resolveSpawnCommand('/tmp/mock-agy.mjs', ['--version'], { env: winEnv, platform: 'linux', execPath: fakeNode }),
        { file: '/tmp/mock-agy.mjs', args: ['--version'] },
      );

      // 1b. Windows .cmd/.bat with spaces in path and spaces/special characters in args
      const spacedBatch = 'C:\\Users\\John Doe\\AppData\\Local\\agy.cmd';
      const spacedBat = 'C:\\Users\\John Doe\\AppData\\Local\\agy.bat';
      const specialArgs = ['fix bug', '@xterm/headless@^6.0.0', 'C:\\dir with spaces\\', 'a&b(c)', ''];
      const expectedPayload = '""C:\\Users\\John Doe\\AppData\\Local\\agy.cmd" "fix bug" "@xterm/headless@^6.0.0" "C:\\dir with spaces\\\\" "a&b(c)" """';
      assert.deepEqual(
        resolveSpawnCommand(spacedBatch, specialArgs, { env: winEnv, platform: 'win32', execPath: fakeNode }),
        {
          file: 'C:\\Windows\\System32\\cmd.exe',
          args: ['/d', '/s', '/c', expectedPayload],
          windowsVerbatimArguments: true,
        },
      );
      const ptyTarget = resolveSpawnCommand(spacedBat, ['fix bug', '@xterm/headless@^6.0.0'], {
        env: winEnv,
        platform: 'win32',
        execPath: fakeNode,
        verbatimString: true,
      });
      assert.deepEqual(ptyTarget, {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: '/d /s /c ""C:\\Users\\John Doe\\AppData\\Local\\agy.bat" "fix bug" "@xterm/headless@^6.0.0""',
      });
      assert.equal(
        argsToCommandLine(ptyTarget.file, ptyTarget.args),
        'C:\\Windows\\System32\\cmd.exe /d /s /c ""C:\\Users\\John Doe\\AppData\\Local\\agy.bat" "fix bug" "@xterm/headless@^6.0.0""',
      );
      // Re-normalizing an array cmd target for node-pty also yields a valid command line string
      const arrayTarget = resolveSpawnCommand(spacedBatch, ['fix bug'], { env: winEnv, platform: 'win32', execPath: fakeNode });
      assert.deepEqual(
        resolveSpawnCommand(arrayTarget.file, arrayTarget.args, { env: winEnv, platform: 'win32', verbatimString: true }),
        {
          file: 'C:\\Windows\\System32\\cmd.exe',
          args: '/d /s /c ""C:\\Users\\John Doe\\AppData\\Local\\agy.cmd" "fix bug""',
        },
      );

      // 1c. Windows .cmd/.bat paths containing `%` and spaces must use single-layer `^` escaping without `^^^"`
      const pctBatch = 'C:\\Users\\100% legit\\agy.cmd';
      const pctTarget = resolveSpawnCommand(pctBatch, ['fix bug', '@xterm/headless@^6.0.0'], {
        env: winEnv,
        platform: 'win32',
        execPath: fakeNode,
      });
      assert.deepEqual(pctTarget, {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', '"C:\\Users\\100^%^ legit\\agy.cmd "fix bug" "@xterm/headless@^6.0.0""'],
        windowsVerbatimArguments: true,
      });
      assert.equal(pctTarget.args[3].includes('^^^"'), false);

      const pctMetaBat = 'C:\\Users\\%TEMP%&(1)!^\\agy.bat';
      const pctMetaTarget = resolveSpawnCommand(pctMetaBat, ['ok'], {
        env: winEnv,
        platform: 'win32',
        execPath: fakeNode,
      });
      assert.deepEqual(pctMetaTarget, {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', '"C:\\Users\\^%TEMP^%^&^(1^)^!^^\\agy.bat ok"'],
        windowsVerbatimArguments: true,
      });
      assert.equal(pctMetaTarget.args[3].includes('^^^"'), false);

      const ptyPctTarget = resolveSpawnCommand(pctBatch, ['fix bug', '@xterm/headless@^6.0.0'], {
        env: winEnv,
        platform: 'win32',
        execPath: fakeNode,
        verbatimString: true,
      });
      assert.deepEqual(ptyPctTarget, {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: '/d /s /c "C:\\Users\\100^%^ legit\\agy.cmd "fix bug" "@xterm/headless@^6.0.0""',
      });
      assert.equal(ptyPctTarget.args.includes('^^^"'), false);

      // Rejects CR/LF/NUL control characters and double quotes in Windows batch command path, while allowing \n in .exe/.mjs
      for (const bad of ['line1\nline2', 'line1\rline2', 'null\0byte']) {
        assert.throws(() => resolveSpawnCommand(spacedBatch, [bad], { env: winEnv, platform: 'win32' }), /CR, LF, or NUL/);
        assert.throws(() => resolveSpawnCommand(`C:\\Users\\${bad}\\agy.cmd`, ['ok'], { env: winEnv, platform: 'win32' }), /CR, LF, or NUL/);
      }
      assert.throws(() => resolveSpawnCommand('C:\\Users\\bad"path\\agy.cmd', ['ok'], { env: winEnv, platform: 'win32' }), /double quote/);
      assert.deepEqual(
        resolveSpawnCommand('C:\\Users\\Alice\\agy.exe', ['line1\nline2'], { env: winEnv, platform: 'win32' }),
        { file: 'C:\\Users\\Alice\\agy.exe', args: ['line1\nline2'] },
      );

      // 2. passthrough uses resolved command and windowsVerbatimArguments on win32
      const spawnCalls = [];
      const mockSpawn = (cmd, spawnArgs, opts) => {
        spawnCalls.push({ cmd, spawnArgs, opts });
        const child = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit('exit', 5, null));
        return child;
      };
      const passJsCode = await passthrough('C:\\Users\\Alice\\mock-agy.mjs', ['--version'], {
        cwd: tmp,
        env: winEnv,
        platform: 'win32',
        execPath: fakeNode,
        spawnFn: mockSpawn,
      });
      assert.equal(passJsCode, 5);
      const passCmdCode = await passthrough(spacedBatch, ['fix bug', '@xterm/headless@^6.0.0'], {
        cwd: tmp,
        env: { ...winEnv, ComSpec: undefined },
        platform: 'win32',
        execPath: fakeNode,
        spawnFn: mockSpawn,
      });
      assert.equal(passCmdCode, 5);
      assert.deepEqual(spawnCalls.map((c) => [c.cmd, c.spawnArgs, Boolean(c.opts.windowsVerbatimArguments)]), [
        [fakeNode, ['C:\\Users\\Alice\\mock-agy.mjs', '--version'], false],
        ['cmd.exe', ['/d', '/s', '/c', '""C:\\Users\\John Doe\\AppData\\Local\\agy.cmd" "fix bug" "@xterm/headless@^6.0.0""'], true],
      ]);

      // 3. launchAgy adapts binary before runHost (including string args for .cmd/.bat in PTY mode) and falls back cleanly
      const hostCalls = [];
      const fallbackSpawnCalls = [];
      const hostCode = await launchAgy(['--model', 'gemini-3-pro'], {
        env: winEnv,
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        stderr: { write: () => {} },
        tmpdir: tmp,
        platform: 'win32',
        execPath: fakeNode,
        resolveBinary: () => 'C:\\Users\\Alice\\mock-agy.cjs',
        runHost: async ({ file, args }) => {
          hostCalls.push({ file, args });
          throw new TerminalDependencyError(new Error('missing conpty.node'));
        },
        passthroughFn: (file, args, opts) =>
          passthrough(file, args, { ...opts, spawnFn: (cmd, spawnArgs, spawnOpts) => {
            fallbackSpawnCalls.push({ cmd, spawnArgs, windowsVerbatimArguments: Boolean(spawnOpts?.windowsVerbatimArguments) });
            const child = new EventEmitter();
            child.kill = () => {};
            queueMicrotask(() => child.emit('exit', 9, null));
            return child;
          } }),
      });
      assert.equal(hostCode, 9);
      assert.deepEqual(hostCalls, [{ file: fakeNode, args: ['C:\\Users\\Alice\\mock-agy.cjs', '--model', 'gemini-3-pro'] }]);
      assert.deepEqual(fallbackSpawnCalls, [{
        cmd: fakeNode,
        spawnArgs: ['C:\\Users\\Alice\\mock-agy.cjs', '--model', 'gemini-3-pro'],
        windowsVerbatimArguments: false,
      }]);

      const cmdHostCalls = [];
      const cmdFallbackCalls = [];
      const cmdHostCode = await launchAgy(['fix bug', '@xterm/headless@^6.0.0'], {
        env: winEnv,
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        stderr: { write: () => {} },
        tmpdir: tmp,
        platform: 'win32',
        execPath: fakeNode,
        resolveBinary: () => spacedBatch,
        runHost: async ({ file, args }) => {
          cmdHostCalls.push({ file, args });
          throw new TerminalDependencyError(new Error('missing conpty.node'));
        },
        passthroughFn: (file, args, opts) =>
          passthrough(file, args, { ...opts, spawnFn: (cmd, spawnArgs, spawnOpts) => {
            cmdFallbackCalls.push({ cmd, spawnArgs, windowsVerbatimArguments: Boolean(spawnOpts?.windowsVerbatimArguments) });
            const child = new EventEmitter();
            child.kill = () => {};
            queueMicrotask(() => child.emit('exit', 11, null));
            return child;
          } }),
      });
      assert.equal(cmdHostCode, 11);
      assert.deepEqual(cmdHostCalls, [{
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: '/d /s /c ""C:\\Users\\John Doe\\AppData\\Local\\agy.cmd" "fix bug" "@xterm/headless@^6.0.0""',
      }]);
      assert.deepEqual(cmdFallbackCalls, [{
        cmd: 'C:\\Windows\\System32\\cmd.exe',
        spawnArgs: ['/d', '/s', '/c', '""C:\\Users\\John Doe\\AppData\\Local\\agy.cmd" "fix bug" "@xterm/headless@^6.0.0""'],
        windowsVerbatimArguments: true,
      }]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('routes agy-hud.js launch -- ... and hud.mjs launch -- ... cleanly to launchAgy', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-cli-'));
    try {
      const mockBin = path.join(tmp, 'mock-agy.mjs');
      const markerFile = path.join(tmp, 'invocations.log');
      fs.writeFileSync(mockBin, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(markerFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('MOCK_AGY ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(3);
`, { mode: 0o755 });

      const env = { ...process.env, AGY_BIN: mockBin };

      const rBin = spawnSync(
        process.execPath,
        [path.join(ROOT, 'runtime', 'bin', 'agy-hud.js'), 'launch', '--', '--version'],
        { env, encoding: 'utf8' },
      );
      assert.equal(rBin.status, 3, rBin.stderr);
      assert.equal(rBin.stdout.trim(), 'MOCK_AGY --version');

      const rHud = spawnSync(
        process.execPath,
        [path.join(ROOT, 'hud.mjs'), 'launch', '--', 'help'],
        { env, encoding: 'utf8' },
      );
      assert.equal(rHud.status, 3, rHud.stderr);
      assert.equal(rHud.stdout.trim(), 'MOCK_AGY help');

      // Verify neither entrypoint ran launchAgy twice
      const lines = fs.readFileSync(markerFile, 'utf8').trim().split(/\r?\n/);
      assert.deepEqual(lines, ['["--version"]', '["help"]']);

      if (process.platform === 'win32') {
        const spacedDir = path.join(tmp, 'dir with spaces');
        fs.mkdirSync(spacedDir, { recursive: true });
        const mockCmd = path.join(spacedDir, 'mock agy.cmd');
        fs.writeFileSync(mockCmd, `@echo off\r\n"${process.execPath}" "${mockBin}" %*\r\n`, 'utf8');
        const rCmd = spawnSync(
          process.execPath,
          [path.join(ROOT, 'runtime', 'bin', 'agy-hud.js'), 'launch', '--', 'fix bug', '@xterm/headless@^6.0.0', 'C:\\path with spaces\\', 'a "quoted" & safe'],
          { env: { ...process.env, AGY_BIN: mockCmd }, encoding: 'utf8' },
        );
        assert.equal(rCmd.status, 3, rCmd.stderr);
        const recorded = JSON.parse(fs.readFileSync(markerFile, 'utf8').trim().split(/\r?\n/).pop());
        assert.deepEqual(recorded, ['fix bug', '@xterm/headless@^6.0.0', 'C:\\path with spaces\\', 'a "quoted" & safe']);

        const pctDir = path.join(tmp, '100% legit');
        fs.mkdirSync(pctDir, { recursive: true });
        const mockPctCmd = path.join(pctDir, 'mock%agy.cmd');
        fs.writeFileSync(mockPctCmd, `@echo off\r\n"${process.execPath}" "${mockBin}" %*\r\n`, 'utf8');
        const rPctCmd = spawnSync(
          process.execPath,
          [path.join(ROOT, 'runtime', 'bin', 'agy-hud.js'), 'launch', '--', 'fix bug', '@xterm/headless@^6.0.0', 'C:\\path with spaces\\', 'a "quoted" & safe'],
          { env: { ...process.env, AGY_BIN: mockPctCmd }, encoding: 'utf8' },
        );
        assert.equal(rPctCmd.status, 3, rPctCmd.stderr);
        const recordedPct = JSON.parse(fs.readFileSync(markerFile, 'utf8').trim().split(/\r?\n/).pop());
        assert.deepEqual(recordedPct, ['fix bug', '@xterm/headless@^6.0.0', 'C:\\path with spaces\\', 'a "quoted" & safe']);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
