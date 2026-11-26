import assert from 'node:assert/strict';
import { spawn as subprocess, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs, {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { configuredShell, shellInit, updateShellIntegration } from '../runtime/shell.mjs';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const posix = { skip: process.platform === 'win32' };
const findShell = (name) => [`/bin/${name}`, `/usr/bin/${name}`].find((p) => existsSync(p));

function fixture(t, shell = '/bin/bash') {
  const root = mkdtempSync(join(tmpdir(), "agy shell ' 字 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, '.gemini', 'antigravity-cli');
  const bin = join(root, 'fake bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(bin);
  const cli = join(configDir, 'agy-hud-runtime', 'runtime', 'bin', 'agy-hud.js');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(
    cli,
    'console.log("HUD " + process.env.AGY_HUD_SHELL_MANAGED + " " + JSON.stringify(process.argv.slice(2)))\n',
  );
  writeFileSync(join(bin, 'agy'), "#!/bin/sh\nprintf 'NATIVE %s %s\\n' \"$1\" \"$2\"\n", { mode: 0o755 });
  const env = {
    HOME: root,
    USERPROFILE: root,
    AGY_HUD_DATA_DIR: configDir,
    SHELL: shell,
    PATH: [bin, process.env.PATH].join(delimiter),
    TERM: 'xterm-256color',
  };
  const change = (action = 'install', overrides = {}, options = {}) =>
    updateShellIntegration(configDir, action, { ...env, ...overrides }, { homeDir: root, ...options });
  return { root, configDir, cli, env, change };
}

test('activates selected Bash profiles and removes only its own bytes', posix, (t) => {
  const { root, configDir, change } = fixture(t);
  const rc = join(root, '.bashrc');
  const login = join(root, '.bash_login');
  const profile = join(root, '.profile');
  writeFileSync(rc, '# user rc without a line ending');
  writeFileSync(login, '# preferred login\r\n');
  writeFileSync(profile, '# untouched when .bash_login exists\n');
  chmodSync(rc, 0o640);

  const installRes = change('install');
  assert.equal(installRes.shell, 'bash');
  assert.match(readFileSync(rc, 'utf8'), /^# user rc.*\n# >>> agy-hud/u);
  assert.match(readFileSync(login, 'utf8'), /^# preferred login\r\n\n# >>> agy-hud/u);
  assert.equal(statSync(rc).mode & 0o777, 0o640);
  assert.equal(readFileSync(profile, 'utf8'), '# untouched when .bash_login exists\n');

  const firstBytes = readFileSync(rc);
  change('install');
  assert.deepEqual(readFileSync(rc), firstBytes);

  const extra = Buffer.from("printf 'user update\\n'\n");
  writeFileSync(login, Buffer.concat([readFileSync(login), extra]));
  change('uninstall');
  assert.equal(readFileSync(rc, 'utf8'), '# user rc without a line ending');
  assert.deepEqual(readFileSync(login), Buffer.concat([Buffer.from('# preferred login\r\n'), extra]));
  assert.equal(existsSync(join(configDir, '.agy-hud-shell.json')), false);
});

test('uses ZDOTDIR and preserves an edited block, then removes untouched new file on opt-out', posix, (t) => {
  const { root, configDir, change } = fixture(t, '/usr/bin/zsh');
  const config = join(root, 'shell config');
  const rc = join(config, '.zshrc');
  mkdirSync(config);

  change('install', { ZDOTDIR: config });
  assert.equal(existsSync(join(root, '.zshrc')), false);
  const owned = readFileSync(rc, 'utf8');
  const expectedMarker = createHash('sha256').update(configDir).digest('hex').slice(0, 16);
  assert.ok(owned.includes(`# >>> agy-hud ${expectedMarker} >>>`));
  assert.ok(owned.includes(`# <<< agy-hud ${expectedMarker} <<<`));

  const edited = owned.replace('launch --', 'launch -- "edited"');
  writeFileSync(rc, edited);
  const resSkipped = change('install', { ZDOTDIR: config });
  assert.equal(resSkipped.skipped.length, 1);
  assert.equal(readFileSync(rc, 'utf8'), edited);

  change('uninstall');
  assert.equal(readFileSync(rc, 'utf8'), edited);
  assert.equal(existsSync(join(configDir, '.agy-hud-shell.json')), true);

  writeFileSync(rc, owned);
  change('install', { ZDOTDIR: config, AGY_HUD_SHELL: 'none' });
  assert.equal(existsSync(rc), false);
  assert.equal(existsSync(join(configDir, '.agy-hud-shell.json')), false);
});

test('PowerShell profile preserves UTF-16LE/UTF-16BE/UTF-8 BOM, CRLF, and exact existing bytes', (t) => {
  for (const encoding of ['utf16le', 'utf16be', 'utf8']) {
    const { root, configDir, change } = fixture(t);
    const file = join(root, 'profile.ps1');
    const text = "# 用户配置\r\nWrite-Output 'keep'";
    const bom = encoding === 'utf16le'
      ? Buffer.from([0xff, 0xfe])
      : encoding === 'utf16be'
        ? Buffer.from([0xfe, 0xff])
        : Buffer.from([0xef, 0xbb, 0xbf]);
    const body = encoding === 'utf16be'
      ? Buffer.from(text, 'utf16le').swap16()
      : Buffer.from(text, encoding);
    const user = Buffer.concat([bom, body]);
    writeFileSync(file, user);

    change('install', { AGY_HUD_PS_PROFILE: file });
    const installed = readFileSync(file);
    assert.deepEqual(installed.subarray(0, user.length), user);
    const decoded = encoding === 'utf16be'
      ? installed.subarray(2).swap16().toString('utf16le')
      : encoding === 'utf16le'
        ? installed.subarray(2).toString('utf16le')
        : installed.subarray(3).toString('utf8');
    assert.match(decoded, /function global:agy/u);
    assert.match(decoded, /Get-Command agy -CommandType Application/u);
    assert.equal(configuredShell(configDir, { HOME: root, AGY_HUD_PS_PROFILE: file }), 'powershell');

    change('uninstall', { AGY_HUD_PS_PROFILE: file });
    assert.deepEqual(readFileSync(file), user);
  }
});

test('win32 defaults PowerShell profile to homeDir/Documents/PowerShell/profile.ps1 and ignores non-profile targets', (t) => {
  const { root, configDir, env, change } = fixture(t);
  const psDefault = join(root, 'Documents', 'PowerShell', 'profile.ps1');
  change('install', { AGY_HUD_SHELL: undefined, AGY_HUD_PS_PROFILE: undefined }, { platform: 'win32' });
  assert.equal(existsSync(psDefault), true);
  assert.equal(
    configuredShell(configDir, { ...env, AGY_HUD_SHELL: undefined, AGY_HUD_PS_PROFILE: undefined }, { homeDir: root, platform: 'win32' }),
    'powershell',
  );
  change('uninstall', {}, { platform: 'win32' });
  assert.equal(existsSync(psDefault), false);

  // Rejects non-profile.ps1 or relative AGY_HUD_PS_PROFILE
  const bad = join(root, 'evil.ps1');
  const resBad = change('install', { AGY_HUD_PS_PROFILE: bad });
  assert.equal(resBad.configured.length, 0);
  assert.equal(existsSync(bad), false);
});

test('PowerShell wrapper is pure ASCII and dispatches pipeline vs interactive args cleanly', (t) => {
  const { cli } = fixture(t);
  const script = shellInit('powershell', cli);
  for (let i = 0; i < script.length; i++) {
    assert.ok(script.charCodeAt(i) <= 0x7f, `Non-ASCII char at ${i}: ${script[i]}`);
  }
  assert.match(script, /\$agyHudPipeline = \$MyInvocation\.ExpectingInput/u);
  assert.match(script, /-not \$agyHudPipeline -and \$env:AGY_HUD_BYPASS -ne "1" -and \$env:TERM -ne "dumb" -and/u);
  assert.match(script, /-not \[Console\]::IsInputRedirected -and -not \[Console\]::IsOutputRedirected/u);
  assert.match(script, /if \(\$agyHudPipeline\) \{\n\s*\$input \| & \$agyHudNative @args\n\s*\} else \{\n\s*& \$agyHudNative @args/u);
});

test('shell.mjs launch parses and deletes AGY_HUD_SHELL_ARGS and rejects invalid JSON', (t) => {
  const { root } = fixture(t);
  const helper = join(root, 'bridge', 'shell.mjs');
  const output = join(root, 'observed.json');
  mkdirSync(dirname(helper), { recursive: true });
  copyFileSync(new URL('../runtime/shell.mjs', import.meta.url), helper);
  writeFileSync(
    join(dirname(helper), 'launch.mjs'),
    [
      'import { writeFileSync } from "node:fs";',
      'export function launchAgy(args) {',
      '  writeFileSync(process.env.FIXTURE_ARGV_OUT, JSON.stringify({ args, inherited: process.env.AGY_HUD_SHELL_ARGS }));',
      '  return 7;',
      '}',
    ].join('\n'),
  );

  for (const args of [
    [],
    ['resume', '--last'],
    ['-C', 'C:\\path with spaces\\', '-p', "user's profile", 'a "quoted" prompt', ''],
  ]) {
    const pass = spawnSync(process.execPath, [helper, 'launch'], {
      env: { ...process.env, AGY_HUD_SHELL_ARGS: JSON.stringify(args), FIXTURE_ARGV_OUT: output },
      encoding: 'utf8',
    });
    assert.equal(pass.status, 7, pass.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { args });
  }

  for (const bad of ['', 'not-json', '{"a":1}', '[123]']) {
    const fail = spawnSync(process.execPath, [helper, 'launch'], {
      env: { ...process.env, AGY_HUD_SHELL_ARGS: bad },
      encoding: 'utf8',
    });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /Invalid launcher arguments/);
  }
});

test('updates only the recorded PowerShell block and recovers interrupted block replacement', (t) => {
  const { root, configDir, change } = fixture(t);
  const profile = join(root, 'profile.ps1');
  const statePath = join(configDir, '.agy-hud-shell.json');
  const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# 用户\r\n'old setting'", 'utf16le')]);
  writeFileSync(profile, original);
  change('install', { AGY_HUD_PS_PROFILE: profile });

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const currentBlock = state.entries[0].block;
  const oldBlock = currentBlock.replace('        $agyHudPipeline = $MyInvocation.ExpectingInput', '        $agyHudPipeline = $false');
  assert.notEqual(currentBlock, oldBlock);

  const separator = Buffer.from('\r\n', 'utf16le');
  const later = Buffer.from("# user added after the block\r\n'new setting'\r\n", 'utf16le');
  const config = (block) => Buffer.concat([original, separator, Buffer.from(block, 'utf16le'), later]);
  writeFileSync(profile, config(oldBlock));
  state.entries[0].block = oldBlock;
  writeFileSync(statePath, JSON.stringify(state));

  change('install', { AGY_HUD_PS_PROFILE: profile });
  assert.deepEqual(readFileSync(profile), config(currentBlock));
  const finished = JSON.parse(readFileSync(statePath, 'utf8')).entries[0];
  assert.equal(finished.block, currentBlock);
  assert.equal(finished.priorBlock, undefined);

  // Interrupted replacement recovery (both priorBlock and block present states)
  const utf8Prefix = '# previous\n';
  writeFileSync(profile, utf8Prefix);
  change('install', { AGY_HUD_PS_PROFILE: profile });
  const utf8Entry = JSON.parse(readFileSync(statePath, 'utf8')).entries[0];
  utf8Entry.priorBlock = utf8Entry.block.replace('$MyInvocation.ExpectingInput', '$false');
  assert.notEqual(utf8Entry.block, utf8Entry.priorBlock);
  const recoveryPrefix = utf8Prefix + (utf8Entry.addedSeparator ? utf8Entry.eol : '');
  for (const present of [utf8Entry.priorBlock, utf8Entry.block]) {
    writeFileSync(profile, recoveryPrefix + present);
    writeFileSync(statePath, JSON.stringify({ version: 1, entries: [utf8Entry] }));
    change('install', { AGY_HUD_PS_PROFILE: profile });
    assert.equal(readFileSync(profile, 'utf8'), recoveryPrefix + utf8Entry.block);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).entries[0].priorBlock, undefined);

    writeFileSync(profile, recoveryPrefix + present);
    writeFileSync(statePath, JSON.stringify({ version: 1, entries: [utf8Entry] }));
    change('uninstall', { AGY_HUD_PS_PROFILE: profile });
    assert.equal(readFileSync(profile, 'utf8'), utf8Prefix);
    assert.equal(existsSync(statePath), false);
  }
});

function installerFixture(t, root, env, profile) {
  const script = join(root, 'intercept-install.mjs');
  const moduleUrl = new URL('../runtime/shell.mjs', import.meta.url).href;
  const source = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const rename = fs.renameSync;',
    'fs.renameSync = (from, to) => {',
    '  if (to === process.env.FIXTURE_PROFILE && process.env.FIXTURE_HOLD) {',
    '    fs.writeFileSync(process.env.FIXTURE_HOLD, "paused");',
    '    const stop = Date.now() + 5000;',
    '    const wake = new Int32Array(new SharedArrayBuffer(4));',
    '    while (!fs.existsSync(process.env.FIXTURE_GO) && Date.now() < stop) Atomics.wait(wake, 0, 0, 10);',
    '  }',
    '  return rename(from, to);',
    '};',
    'syncBuiltinESMExports();',
    `const { updateShellIntegration } = await import(${JSON.stringify(moduleUrl)});`,
    'fs.writeFileSync(process.env.FIXTURE_READY, "started");',
    'updateShellIntegration(process.env.AGY_HUD_DATA_DIR, "install", process.env, { homeDir: process.env.HOME });',
  ].join('\n');
  writeFileSync(script, source);
  const go = join(root, 'resume-install');
  return {
    go,
    async start(configDir, tag, pause = false) {
      const ready = join(root, `install-${tag}`);
      const held = pause ? `${ready}-held` : '';
      const child = subprocess(process.execPath, [script], {
        stdio: 'ignore',
        env: { ...env, AGY_HUD_DATA_DIR: configDir, FIXTURE_PROFILE: profile, FIXTURE_READY: ready, FIXTURE_HOLD: held, FIXTURE_GO: go },
      });
      const exit = new Promise((resolve) => child.once('close', (status, signal) => resolve({ status, signal })));
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
      for (let i = 0; !existsSync(held || ready); i++) {
        assert.ok(i < 300, 'fixture process did not reach the expected step');
        await delay(10);
      }
      return { child, exit };
    },
  };
}

test('serializes concurrent installers via Lamport bakery lock and routes active AGY_HUD_DATA_DIR', { ...posix, timeout: 10000 }, async (t) => {
  const { root, configDir, env, change } = fixture(t);
  const second = join(root, 'other data');
  const secondCli = join(second, 'agy-hud-runtime', 'runtime', 'bin', 'agy-hud.js');
  mkdirSync(dirname(secondCli), { recursive: true });
  writeFileSync(secondCli, 'console.log("SECOND " + JSON.stringify(process.argv.slice(2)))');
  const profile = join(root, '.bashrc');
  writeFileSync(profile, '# existing settings');

  const workers = installerFixture(t, root, env, profile);
  const first = await workers.start(configDir, 'one', true);
  const peer = await workers.start(second, 'two');
  await delay(250);
  writeFileSync(workers.go, 'go');
  assert.deepEqual(await first.exit, { status: 0, signal: null });
  assert.deepEqual(await peer.exit, { status: 0, signal: null });

  const owned = readFileSync(profile, 'utf8');
  assert.equal([...owned.matchAll(/^# >>> agy-hud /gmu)].length, 2);

  const bash = findShell('bash');
  assert.ok(bash);
  const { spawn } = require('node-pty');
  const args = ['--noprofile', '--rcfile', profile, '-ic', 'agy resume --last'];
  assert.match(await runPty(spawn, bash, args, env), /HUD 1 \["launch","--","resume","--last"\]/u);
  assert.match(await runPty(spawn, bash, args, { ...env, AGY_HUD_DATA_DIR: second }), /SECOND \["launch","--","resume","--last"\]/u);

  rmSync(secondCli);
  assert.match(await runPty(spawn, bash, args, { ...env, AGY_HUD_DATA_DIR: second }), /NATIVE resume --last/u);

  change('uninstall');
  assert.equal([...readFileSync(profile, 'utf8').matchAll(/^# >>> agy-hud /gmu)].length, 1);
  updateShellIntegration(second, 'uninstall', env, { homeDir: root });
  assert.equal(readFileSync(profile, 'utf8'), '# existing settings');
});

test('reclaims stale .agy-hud-tickets lock after forced installer crash and refuses symlinks', { ...posix, timeout: 10000 }, async (t) => {
  const { root, configDir, env, change } = fixture(t);
  const profile = join(root, '.bashrc');
  const queue = `${profile}.agy-hud-tickets`;
  writeFileSync(profile, '# existing settings\n');

  const workers = installerFixture(t, root, env, profile);
  const interrupted = await workers.start(configDir, 'interrupted', true);
  interrupted.child.kill('SIGKILL');
  assert.deepEqual(await interrupted.exit, { status: null, signal: 'SIGKILL' });
  assert.equal(existsSync(queue), true);
  assert.equal(readFileSync(profile, 'utf8'), '# existing settings\n');

  change('install');
  assert.match(readFileSync(profile, 'utf8'), /^# >>> agy-hud /mu);
  assert.equal(existsSync(queue), false);
  change('uninstall');
  assert.equal(readFileSync(profile, 'utf8'), '# existing settings\n');

  // Refuses symlinks
  const target = join(root, 'real-zshrc');
  const link = join(root, '.zshrc');
  writeFileSync(target, '# keep symlink target\n');
  symlinkSync(target, link);
  const zshRes = change('install', { SHELL: '/bin/zsh' });
  assert.equal(zshRes.skipped.length, 1);
  assert.equal(readFileSync(target, 'utf8'), '# keep symlink target\n');

  // Refuses oversized file (> 4 MiB)
  const big = join(root, '.profile');
  writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 10, 'a'));
  const bigRes = change('install', { SHELL: '/bin/bash' });
  assert.ok(bigRes.skipped.some((s) => s.file === big));
});

test('restores shared profile to original existence regardless of uninstall order', posix, async (t) => {
  for (const existed of [true, false]) {
    for (const creatorGoesFirst of [true, false]) {
      await t.test(`${existed ? 'initially empty' : 'initially absent'}, creator ${creatorGoesFirst ? 'first' : 'last'}`, (sub) => {
        const { root, configDir, env } = fixture(sub, '/bin/zsh');
        const profile = join(root, '.zshrc');
        const other = join(root, 'other-data');
        mkdirSync(other);
        if (existed) writeFileSync(profile, '');
        for (const cfg of [configDir, other]) {
          updateShellIntegration(cfg, 'install', { ...env, AGY_HUD_DATA_DIR: cfg }, { homeDir: root });
        }
        const first = creatorGoesFirst ? configDir : other;
        const last = creatorGoesFirst ? other : configDir;
        updateShellIntegration(first, 'uninstall', env, { homeDir: root });
        assert.equal([...readFileSync(profile, 'utf8').matchAll(/^# >>> agy-hud /gmu)].length, 1);
        updateShellIntegration(last, 'uninstall', env, { homeDir: root });
        assert.equal(existsSync(profile), existed);
        if (existed) assert.equal(readFileSync(profile).length, 0);
      });
    }
  }
});

test('init, activate, scripts/activate.sh, and interactive Bash/Zsh PTY dispatch work end to end', { ...posix, timeout: 10000 }, async (t) => {
  const { spawn } = require('node-pty');
  const shellJs = join(ROOT, 'runtime', 'shell.mjs');
  const activateSh = join(ROOT, 'scripts', 'activate.sh');

  // init CLI
  for (const kind of ['bash', 'zsh', 'powershell']) {
    const out = spawnSync(process.execPath, [shellJs, 'init', kind], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes('agy'));
  }
  const badInit = spawnSync(process.execPath, [shellJs, 'init', 'fish'], { encoding: 'utf8' });
  assert.equal(badInit.status, 1);

  for (const name of ['bash', 'zsh']) {
    const shell = findShell(name);
    if (!shell) continue;
    const { root, configDir, cli, env, change } = fixture(t, shell);
    const runtimeShellJs = join(configDir, 'agy-hud-runtime', 'runtime', 'shell.mjs');
    copyFileSync(shellJs, runtimeShellJs);
    copyFileSync(join(ROOT, 'runtime', 'paths.mjs'), join(configDir, 'agy-hud-runtime', 'runtime', 'paths.mjs'));

    const file = join(root, name === 'bash' ? '.bashrc' : '.zshrc');
    change('install', { ZDOTDIR: root });

    // activate CLI succeeds when configured
    const actOk = spawnSync(process.execPath, [runtimeShellJs, 'activate'], {
      env: { ...env, ZDOTDIR: root },
      encoding: 'utf8',
    });
    assert.equal(actOk.status, 0, actOk.stderr);
    assert.match(actOk.stdout, /agy\(\)/);

    const command = 'agy "argument with spaces" "it' + "'s ok" + '"; AGY_HUD_BYPASS=1 agy direct native';
    const args = name === 'bash'
      ? ['--noprofile', '--rcfile', file, '-ic', command]
      : ['-ic', command];
    const output = await runPty(spawn, shell, args, { ...env, ZDOTDIR: root });
    assert.match(output, /HUD 1 \["launch","--","argument with spaces","it's ok"\]/u);
    assert.match(output, /NATIVE direct native/u);

    // Non-TTY passthrough
    const noTty = spawnSync(shell, args, { env: { ...env, ZDOTDIR: root }, encoding: 'utf8' });
    assert.doesNotMatch(noTty.stdout, /HUD /u);

    // Existing alias is never overwritten
    writeFileSync(file, `alias agy='printf user-agy'\n${readFileSync(file, 'utf8')}`);
    assert.match(await runPty(spawn, shell, [...args.slice(0, -1), 'agy'], { ...env, ZDOTDIR: root }), /user-agy/u);

    // Activate fails when the managed block itself is tampered
    const originalFile = readFileSync(file, 'utf8');
    writeFileSync(file, originalFile.replace('launch --', 'launch -- --tampered'));
    const actTampered = spawnSync(process.execPath, [runtimeShellJs, 'activate'], {
      env: { ...env, ZDOTDIR: root },
      encoding: 'utf8',
    });
    assert.equal(actTampered.status, 1);

    // Restore clean profile and test scripts/activate.sh in fresh interactive shell without rcfile
    writeFileSync(file, '');
    change('install', { ZDOTDIR: root });
    const freshArgs = name === 'bash'
      ? ['--noprofile', '--norc', '-ic', `. "${activateSh}" && agy check path`]
      : ['-f', '-ic', `. "${activateSh}" && agy check path`];
    const actOut = await runPty(spawn, shell, freshArgs, { ...env, ZDOTDIR: root });
    assert.match(actOut, /HUD 1 \["launch","--","check","path"\]/u);

    // Temporary init loader
    const temporary = join(root, 'temporary-loader');
    writeFileSync(temporary, shellInit(name, cli));
    const loaderArgs = name === 'bash'
      ? ['--noprofile', '--norc', '-ic', '. "$1"; eval "agy loader arg"', 'verify', temporary]
      : ['-f', '-ic', '. "$1"; eval "agy loader arg"', 'verify', temporary];
    assert.match(await runPty(spawn, shell, loaderArgs, env), /HUD 1 \["launch","--","loader","arg"\]/u);
  }
});

async function runPty(spawn, file, args, env) {
  const terminal = spawn(file, args, { env, name: 'xterm-256color', cols: 90, rows: 25 });
  let output = '';
  const stream = terminal.onData((data) => { output += data; });
  try {
    const status = await new Promise((resolve) => {
      const timeout = setTimeout(() => terminal.kill(), 4000);
      terminal.onExit((value) => { clearTimeout(timeout); resolve(value); });
    });
    assert.equal(status.exitCode, 0, output);
    return output;
  } finally {
    stream.dispose();
  }
}

test('rolls back .agy-hud-shell.json manifest cleanly when applyProfile fails and tolerates locked ticket dir cleanup', (t) => {
  const { root, configDir, env } = fixture(t);
  const profile = join(root, 'profile.ps1');
  const manifestPath = join(configDir, '.agy-hud-shell.json');
  const originalProfile = "# existing settings\r\nWrite-Output 'ok'\r\n";
  writeFileSync(profile, originalProfile);

  const moduleUrl = new URL('../runtime/shell.mjs', import.meta.url).href;
  const driver = join(root, 'fail-apply-driver.mjs');
  writeFileSync(driver, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const origRename = fs.renameSync;',
    'const origRmdir = fs.rmdirSync;',
    'fs.renameSync = (from, to) => {',
    '  if (to === process.env.FIXTURE_PROFILE) {',
    '    throw Object.assign(new Error("EACCES: simulated read-only profile"), { code: "EACCES" });',
    '  }',
    '  return origRename(from, to);',
    '};',
    'fs.rmdirSync = (dir) => {',
    '  if (String(dir).endsWith(".agy-hud-tickets") && process.env.FIXTURE_RMDIR_ERR) {',
    '    throw Object.assign(new Error("EBUSY: simulated locked ticket dir"), { code: process.env.FIXTURE_RMDIR_ERR });',
    '  }',
    '  return origRmdir(dir);',
    '};',
    'syncBuiltinESMExports();',
    `const { updateShellIntegration } = await import(${JSON.stringify(moduleUrl)});`,
    'const res = updateShellIntegration(process.env.AGY_HUD_DATA_DIR, "install", process.env, {',
    '  homeDir: process.env.HOME,',
    '  cliPath: process.env.FIXTURE_CLI_PATH || undefined,',
    '});',
    'process.stdout.write(JSON.stringify(res));',
  ].join('\n'));

  // 1. Fresh install failure: manifest must not persist phantom entry
  const freshFail = spawnSync(process.execPath, [driver], {
    env: {
      ...env,
      AGY_HUD_PS_PROFILE: profile,
      FIXTURE_PROFILE: profile,
    },
    encoding: 'utf8',
  });
  assert.equal(freshFail.status, 0, freshFail.stderr);
  const freshRes = JSON.parse(freshFail.stdout);
  assert.equal(freshRes.skipped.length, 1);
  assert.match(freshRes.skipped[0].reason, /simulated read-only profile/);
  assert.equal(readFileSync(profile, 'utf8'), originalProfile);
  assert.equal(existsSync(manifestPath), false);

  // 2. Upgrade failure with existing manifest entry: must restore known entry and drop unapplied priorBlock
  const cliV1 = join(root, 'v1', 'agy-hud.js');
  const cliV2 = join(root, 'v2', 'agy-hud.js');
  const okInstall = updateShellIntegration(
    configDir,
    'install',
    { ...env, AGY_HUD_PS_PROFILE: profile },
    { homeDir: root, cliPath: cliV1 },
  );
  assert.equal(okInstall.configured.length, 1);
  const beforeManifest = readFileSync(manifestPath, 'utf8');
  const beforeParsed = JSON.parse(beforeManifest);
  assert.equal(beforeParsed.entries.length, 1);
  assert.equal(beforeParsed.entries[0].priorBlock, undefined);
  const installedProfile = readFileSync(profile, 'utf8');

  const upgradeFail = spawnSync(process.execPath, [driver], {
    env: {
      ...env,
      AGY_HUD_PS_PROFILE: profile,
      FIXTURE_PROFILE: profile,
      FIXTURE_CLI_PATH: cliV2,
    },
    encoding: 'utf8',
  });
  assert.equal(upgradeFail.status, 0, upgradeFail.stderr);
  const upgradeRes = JSON.parse(upgradeFail.stdout);
  assert.equal(upgradeRes.skipped.length, 1);
  assert.equal(readFileSync(profile, 'utf8'), installedProfile);
  assert.equal(readFileSync(manifestPath, 'utf8'), beforeManifest);

  // 3. Locked ticket dir cleanup (EPERM / EBUSY / EACCES) must not fail profile update
  for (const errCode of ['EPERM', 'EBUSY', 'EACCES']) {
    const lockedRes = spawnSync(process.execPath, [driver], {
      env: {
        ...env,
        AGY_HUD_PS_PROFILE: profile,
        FIXTURE_PROFILE: join(root, 'no-intercept.ps1'),
        FIXTURE_CLI_PATH: cliV2,
        FIXTURE_RMDIR_ERR: errCode,
      },
      encoding: 'utf8',
    });
    assert.equal(lockedRes.status, 0, lockedRes.stderr);
    const parsedLocked = JSON.parse(lockedRes.stdout);
    assert.equal(parsedLocked.skipped.length, 0);
    assert.equal(parsedLocked.configured.length, 1);
  }
});
