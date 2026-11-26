import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildOverlayWrite,
  closePtyHandle,
  createInputBuffer,
  enterRawOutputMode,
  findHudSlots,
  runPtyHost,
  stripWin32InputMode,
  TerminalDependencyError,
  truncateAnsiToWidth,
  visibleDisplayWidth,
} from '../runtime/pty-host.mjs';
import { bundledDependencyFiles, hostDependencyFiles } from '../runtime/pty-deps.mjs';
import { computeNextRefreshDelay, createRenderWorker, stripAnsiAndNbsp } from '../hud.mjs';
import { createChannel } from '../src/channel.ts';
import * as collector from '../collector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('runtime / pty-deps', () => {
  test('lists @xterm/headless and node-pty across 6 platforms without .pdb debug symbols', () => {
    assert.ok(bundledDependencyFiles.includes('node_modules/@xterm/headless/lib-headless/xterm-headless.js'));
    assert.ok(bundledDependencyFiles.includes('node_modules/node-pty/lib/index.js'));

    for (const triple of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']) {
      assert.ok(
        bundledDependencyFiles.some((f) => f.includes(`/prebuilds/${triple}/`)),
        `Missing prebuild for ${triple}`,
      );
    }
    assert.equal(bundledDependencyFiles.some((f) => f.endsWith('.pdb')), false);

    const hostFiles = hostDependencyFiles();
    for (const rel of hostFiles) {
      assert.equal(fs.existsSync(path.join(ROOT, ...rel.split('/'))), true, `Missing host dependency file: ${rel}`);
    }
    assert.deepEqual(hostDependencyFiles('freebsd', 'x64'), []);
    assert.ok(hostDependencyFiles('win32', 'arm64').includes('node_modules/node-pty/prebuilds/win32-arm64/conpty/conpty.dll'));
  });
});

describe('runtime / pty-host stream filters & input buffer', () => {
  test('stripWin32InputMode strips 9001 across chunk splits and preserves compound modes', () => {
    const state = { pending: '' };
    assert.equal(stripWin32InputMode('hello\x1b[?9001hworld', state), 'helloworld');
    assert.equal(stripWin32InputMode('\x1b[?9001l', state), '');
    assert.equal(stripWin32InputMode('\x1b[?1004;9001h', state), '\x1b[?1004h');
    assert.equal(stripWin32InputMode('\x1b[?9001;1004;2004l', state), '\x1b[?1004;2004l');
    assert.equal(stripWin32InputMode('\x1b[?90011h\x1b[?9001$p\x1b[?25l', state), '\x1b[?90011h\x1b[?9001$p\x1b[?25l');

    // Cross-chunk split without blocking unrelated normal text
    assert.equal(stripWin32InputMode('normal ', state), 'normal ');
    assert.equal(stripWin32InputMode('abc\x1b[?900', state), 'abc');
    assert.equal(stripWin32InputMode('1hdef\x1b[?1004;', state), 'def');
    assert.equal(stripWin32InputMode('9001l!', state), '\x1b[?1004l!');
    assert.equal(stripWin32InputMode('tail\x1b', state), 'tail');
    assert.equal(stripWin32InputMode('[?25h', state), '\x1b[?25h');
    assert.equal(state.pending, '');
  });

  test('createInputBuffer reassembles split CSI/SGR mouse/Kitty/win32/paste and flushes lone ESC', async () => {
    const sent = [];
    const buf = createInputBuffer((d) => sent.push(d), 20);
    try {
      // Split UTF-8 + SGR 5-digit mouse + Kitty + win32-input-mode + bracketed paste
      const utf8Buf = Buffer.from('中', 'utf8');
      buf.push(utf8Buf.subarray(0, 1));
      assert.deepEqual(sent, []);
      buf.push(utf8Buf.subarray(1));
      assert.deepEqual(sent, ['中']);

      sent.length = 0;
      buf.push('\x1b[<35;120');
      buf.push(';45678M');
      assert.deepEqual(sent, ['\x1b[<35;120;45678M']);

      sent.length = 0;
      buf.push('\x1b[97;5');
      buf.push('u\x1b[65;30;65;1;0;');
      buf.push('1_\x1b[20');
      buf.push('0~paste\x1b[201');
      buf.push('~');
      assert.deepEqual(sent, ['\x1b[97;5u', '\x1b[65;30;65;1;0;1_', '\x1b[200~paste', '\x1b[201~']);

      // Lone ESC flushes after delay
      sent.length = 0;
      buf.push('\x1b');
      assert.deepEqual(sent, []);
      await new Promise((r) => setTimeout(r, 45));
      assert.deepEqual(sent, ['\x1b']);
    } finally {
      buf.dispose();
    }
  });

  test('truncateAnsiToWidth preserves visible width and closes SGR and OSC 8 hyperlinks', () => {
    const linked = '\x1b[36m\x1b]8;;file:///tmp/repo\x1b\\ProjectNameLong\x1b]8;;\x1b\\\x1b[0m';
    const cut = truncateAnsiToWidth(linked, 8);
    assert.ok(visibleDisplayWidth(cut) <= 8);
    assert.ok(cut.includes('\x1b]8;;\x1b\\'));
    assert.ok(cut.endsWith('\x1b[0m'));
  });
});

describe('runtime / findHudSlots & buildOverlayWrite & closePtyHandle', () => {
  const border = '─'.repeat(60);
  const snap = [
    '[Gemini 3 Pro] │ my-repo │ agy v1.5.17',
    'Context ██░░░░░░░░ 20% │ Usage ██░░░░░░░░ 20% (59m 42s)',
  ];

  test('locks inline slots below double border when slotStart > cursorY (single and multiline)', () => {
    const plain = new Array(24).fill('');
    plain[17] = border;
    plain[18] = ' > line one';
    plain[19] = '   line two';
    plain[20] = border;
    plain[21] = '[Gemini 3 Pro] | my-repo | agy v1.5.17';
    plain[22] = 'Context ##-------- 20% | Usage ##-------- 20% (59m 41s)';

    const slot = findHudSlots(
      { plain, rows: 24, cols: 80, cursorY: 19, alternate: false },
      { snapshotLines: snap },
    );
    assert.ok(slot);
    assert.equal(slot.slotStart, 21);
    assert.equal(slot.slotCount, 2);
    assert.equal(slot.stacked, false);
    assert.equal(slot.alternate, false);
  });

  test('supports stack_with_default (gap of 1 native status row below bottom border)', () => {
    const plain = new Array(24).fill('');
    plain[16] = border;
    plain[17] = ' > prompt';
    plain[18] = border;
    plain[19] = '  ~/my-repo (main)   ? for shortcuts';
    plain[20] = '[Gemini 3 Pro] | my-repo | agy v1.5.17';
    plain[21] = 'Context ##-------- 20% | Usage ##-------- 20% (59m 42s)';

    const slot = findHudSlots(
      { plain, rows: 24, cols: 80, cursorY: 17, alternate: false },
      { snapshotLines: snap },
    );
    assert.ok(slot);
    assert.equal(slot.slotStart, 20);
    assert.equal(slot.slotCount, 2);
    assert.equal(slot.stacked, true);
  });

  test('ignores quota-table internal divider rule and locks input bottom border', () => {
    const tableSnap = [
      '[Gemini 3 Pro] │ my-repo',
      'Context ██░░░░░░░░ 20%',
      `  ${'─'.repeat(50)}`,
      '  Google 5h   [██████] 100.00% ~5h',
    ];
    const plain = new Array(24).fill('');
    plain[15] = border;
    plain[16] = ' > ask';
    plain[17] = border;
    plain[18] = tableSnap[0];
    plain[19] = tableSnap[1];
    plain[20] = tableSnap[2];
    plain[21] = tableSnap[3];

    const slot = findHudSlots(
      { plain, rows: 24, cols: 80, cursorY: 16, alternate: false },
      { snapshotLines: tableSnap },
    );
    assert.ok(slot);
    assert.equal(slot.slotStart, 18);
    assert.equal(slot.slotCount, 4);
    assert.equal(slot.bottomBorder, 17);
  });

  test('guards against cursorY >= slotStart in inline mode and rejects welcome/modals', () => {
    const plain = new Array(24).fill('');
    plain[17] = border;
    plain[18] = ' > prompt';
    plain[19] = border;
    plain[20] = snap[0];
    plain[21] = snap[1];

    // cursorY out of bounds (on or below slotStart)
    assert.equal(
      findHudSlots({ plain, rows: 24, cols: 80, cursorY: 20, alternate: false }, { snapshotLines: snap }),
      null,
    );
    assert.equal(
      findHudSlots({ plain, rows: 24, cols: 80, cursorY: 22, alternate: false }, { snapshotLines: snap }),
      null,
    );

    // alternate screen still locates slots safely even if cursorY is hidden/moved
    const altSlot = findHudSlots(
      { plain, rows: 24, cols: 80, cursorY: 18, cursorVisible: false, alternate: true },
      { snapshotLines: snap },
    );
    assert.equal(altSlot?.slotStart, 20);
    assert.equal(altSlot?.alternate, true);

    // Welcome screen rejected
    const welcome = new Array(24).fill('');
    welcome[5] = ' Welcome to the Antigravity CLI. You are currently not signed in.';
    welcome[7] = ' Select login method:';
    welcome[8] = ' > 1. Google OAuth';
    assert.equal(
      findHudSlots({ plain: welcome, rows: 24, cols: 80, cursorY: 8, alternate: true }, { snapshotLines: snap }),
      null,
    );

    // Modal overlay covering bottom rows rejected
    const modal = plain.slice();
    modal[20] = '╭────────────────────────────╮';
    modal[21] = '│ Select model               │';
    assert.equal(
      findHudSlots({ plain: modal, rows: 24, cols: 80, cursorY: 18, alternate: false }, { snapshotLines: snap }),
      null,
    );
  });

  test('buildOverlayWrite emits relative cursor moves in inline mode, CUP in alt mode, diffs cleanly, and restores ?7/?25', () => {
    // 1. Identical content -> 0 bytes
    const unchanged = buildOverlayWrite({
      slotStart: 20,
      slotCount: 2,
      targetLines: ['line-a', 'line-b'],
      currentLines: ['line-a', 'line-b'],
      cursorY: 18,
      alternate: false,
      cols: 80,
    });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.sequence, '');

    // 2. Inline mode with only row 1 changed, cursorVisible=false, wraparound=false
    const inlineDiff = buildOverlayWrite({
      slotStart: 20,
      slotCount: 2,
      targetLines: ['line-a', 'line-b-new'],
      currentLines: ['line-a', 'line-b'],
      cursorY: 18,
      alternate: false,
      cols: 80,
      cursorVisible: false,
      wraparound: false,
    });
    assert.equal(inlineDiff.changed, true);
    assert.doesNotMatch(inlineDiff.sequence, /\x1b\[\d+;\d+H/);
    assert.equal(
      inlineDiff.sequence,
      '\x1b[?25l\x1b7\x1b[?7l\x1b[3B\r\x1b[2Kline-b-new\x1b[0m\x1b8\x1b[?7l\x1b[?25l',
    );

    // 3. Inline safety invariant: slotStart <= cursorY returns 0 bytes
    const unsafe = buildOverlayWrite({
      slotStart: 18,
      slotCount: 2,
      targetLines: ['a', 'b'],
      currentLines: ['x', 'y'],
      cursorY: 18,
      alternate: false,
      cols: 80,
    });
    assert.equal(unsafe.changed, false);
    assert.equal(unsafe.sequence, '');

    // 4. Shrink (clears surplus slot) and Grow (clamps to slotCount) + altscreen CUP
    const shrunk = buildOverlayWrite({
      slotStart: 20,
      slotCount: 3,
      targetLines: ['only-one'],
      currentLines: ['only-one', 'stale-2', 'stale-3'],
      cursorY: 18,
      alternate: true,
      cols: 80,
      cursorVisible: true,
      wraparound: true,
    });
    assert.equal(
      shrunk.sequence,
      '\x1b[?25l\x1b7\x1b[?7l\x1b[22;1H\x1b[2K\x1b[23;1H\x1b[2K\x1b[0m\x1b8\x1b[?7h\x1b[?25h',
    );
    assert.deepEqual(shrunk.writtenLines, ['only-one', '', '']);

    const grown = buildOverlayWrite({
      slotStart: 20,
      slotCount: 2,
      targetLines: ['r0', 'r1', 'r2-overflow'],
      currentLines: ['old0', 'old1'],
      cursorY: 18,
      alternate: false,
      cols: 80,
    });
    assert.deepEqual(grown.writtenLines, ['r0', 'r1']);
    assert.doesNotMatch(grown.sequence, /r2-overflow/);
  });

  test('closePtyHandle cleans all Windows ConPTY timers, sockets, and workers safely', () => {
    const calls = [];
    const timerA = setTimeout(() => {}, 60_000);
    const timerB = setTimeout(() => {}, 60_000);
    const fakePty = {
      _agent: {
        _connectionTimeout: timerA,
        _closeTimeout: timerB,
        _inSocket: { destroy: () => calls.push('inSocket') },
        _outSocket: { destroy: () => calls.push('outSocket') },
        _conoutSocketWorker: {
          dispose: () => calls.push('workerDispose'),
          _drainTimeout: { unref: () => calls.push('drainUnref') },
          _worker: { unref: () => calls.push('workerUnref') },
        },
      },
    };
    closePtyHandle(fakePty, 'linux');
    assert.deepEqual(calls, []);
    closePtyHandle(fakePty, 'win32');
    assert.deepEqual(calls, ['inSocket', 'outSocket', 'workerDispose', 'drainUnref', 'workerUnref']);
    clearTimeout(timerA);
    clearTimeout(timerB);
  });
});

describe('runtime / POSIX raw output mode (stty -opost)', () => {
  test('saves stty state before setRawMode(true), disables opost after, and restores in order idempotently', () => {
    for (const { platform, rawOutput, expectedSaved } of [
      { platform: 'linux', rawOutput: '6d02:5:f04bf:8a3b:3\r\n', expectedSaved: '6d02:5:f04bf:8a3b:3' },
      { platform: 'darwin', rawOutput: 'gfmt1:cflag=4b00:iflag=6b02:lflag=200005cf:oflag=3\n', expectedSaved: 'gfmt1:cflag=4b00:iflag=6b02:lflag=200005cf:oflag=3' },
    ]) {
      const events = [];
      const stdin = {
        isTTY: true,
        isRaw: false,
        fd: 7,
        setRawMode: (raw) => events.push(['setRawMode', raw]),
      };
      const stdout = { isTTY: true };
      const execFileSyncFn = (cmd, args, opts) => {
        events.push(['exec', cmd, args, opts]);
        if (args[0] === '-g') return rawOutput;
        return '';
      };

      const restore = enterRawOutputMode({ platform, stdin, stdout, execFileSyncFn });
      assert.deepEqual(events, [
        ['exec', 'stty', ['-g'], { stdio: [7, 'pipe', 'ignore'], encoding: 'utf8', timeout: 1000 }],
        ['setRawMode', true],
        ['exec', 'stty', ['-opost'], { stdio: [7, 'ignore', 'ignore'], timeout: 1000 }],
      ]);

      restore();
      restore(); // idempotent second call must be a no-op
      assert.deepEqual(events.slice(3), [
        ['setRawMode', false],
        ['exec', 'stty', [expectedSaved], { stdio: [7, 'ignore', 'ignore'], timeout: 1000 }],
      ]);
    }
  });

  test('skips stty on win32, non-TTY streams, and mock TTY streams lacking a valid numeric fd', () => {
    const cases = [
      { platform: 'win32', stdin: { isTTY: true, isRaw: false, fd: 0 }, stdout: { isTTY: true } },
      { platform: 'linux', stdin: { isTTY: true, isRaw: false }, stdout: { isTTY: true } },
      { platform: 'linux', stdin: { isTTY: true, isRaw: false, fd: -1 }, stdout: { isTTY: true } },
      { platform: 'linux', stdin: { isTTY: true, isRaw: false, fd: Number.NaN }, stdout: { isTTY: true } },
      { platform: 'linux', stdin: { isTTY: true, isRaw: false, fd: 1.5 }, stdout: { isTTY: true } },
      { platform: 'linux', stdin: { isTTY: true, isRaw: false, fd: '0' }, stdout: { isTTY: true } },
      { platform: 'linux', stdin: { isTTY: false, isRaw: false, fd: 0 }, stdout: { isTTY: true } },
      { platform: 'linux', stdin: { isTTY: true, isRaw: false, fd: 0 }, stdout: { isTTY: false } },
    ];

    for (const c of cases) {
      const execCalls = [];
      const rawCalls = [];
      const stdin = { ...c.stdin, setRawMode: (v) => rawCalls.push(v) };
      const restore = enterRawOutputMode({
        platform: c.platform,
        stdin,
        stdout: c.stdout,
        execFileSyncFn: (...args) => execCalls.push(args),
      });
      restore();
      assert.deepEqual(execCalls, []);
      assert.deepEqual(rawCalls, [true, false]);
    }

    // Explicit fd injection allows testing mock streams without .fd property
    const injectedCalls = [];
    const restoreInjected = enterRawOutputMode({
      platform: 'linux',
      stdin: { isTTY: true, isRaw: true, setRawMode: (v) => injectedCalls.push(['raw', v]) },
      stdout: { isTTY: true },
      fd: 9,
      execFileSyncFn: (_cmd, args, opts) => {
        injectedCalls.push(['stty', args, opts.stdio[0]]);
        return '6d02:5:bf\n';
      },
    });
    restoreInjected();
    assert.deepEqual(injectedCalls, [
      ['stty', ['-g'], 9],
      ['raw', true],
      ['stty', ['-opost'], 9],
      ['raw', true],
      ['stty', ['6d02:5:bf'], 9],
    ]);
  });

  test('falls back to stty opost when saved state is missing/unsafe and degrades silently when stty fails or is missing', () => {
    // 1. Unsafe or failing stty -g falls back to ['opost'] on restore
    for (const badState of ['', '   \n', '-opost\n', '6d02;rm -rf\n', 'bad state\n', new Error('no -g')]) {
      const events = [];
      const stdin = { isTTY: true, isRaw: false, fd: 4, setRawMode: (v) => events.push(['raw', v]) };
      const stdout = { isTTY: true };
      const restore = enterRawOutputMode({
        platform: 'linux',
        stdin,
        stdout,
        execFileSyncFn: (_cmd, args) => {
          events.push(['stty', args]);
          if (args[0] === '-g') {
            if (badState instanceof Error) throw badState;
            return badState;
          }
          return '';
        },
      });
      restore();
      assert.deepEqual(events, [
        ['stty', ['-g']],
        ['raw', true],
        ['stty', ['-opost']],
        ['raw', false],
        ['stty', ['opost']],
      ]);
    }

    // 2. Missing stty binary (ENOENT on all calls) never throws on enter or restore
    const rawCalls = [];
    const restoreMissing = enterRawOutputMode({
      platform: 'linux',
      stdin: { isTTY: true, isRaw: false, fd: 5, setRawMode: (v) => rawCalls.push(v) },
      stdout: { isTTY: true },
      execFileSyncFn: () => {
        const err = new Error('spawnSync stty ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    });
    restoreMissing();
    assert.deepEqual(rawCalls, [true, false]);

    // 3. Restore failure on stty does not throw
    const restoreThrows = enterRawOutputMode({
      platform: 'linux',
      stdin: { isTTY: true, isRaw: false, fd: 5, setRawMode: (v) => rawCalls.push(v) },
      stdout: { isTTY: true },
      execFileSyncFn: (_cmd, args) => {
        if (args[0] === '-g') return '6d02:5:bf\n';
        if (args[0] === '6d02:5:bf') throw new Error('EIO');
        return '';
      },
    });
    assert.doesNotThrow(() => restoreThrows());

    // 4. If setRawMode(true) throws, stty -opost is not applied
    const failEvents = [];
    assert.throws(() => enterRawOutputMode({
      platform: 'linux',
      stdin: {
        isTTY: true,
        isRaw: false,
        fd: 5,
        setRawMode: () => {
          failEvents.push('raw-throw');
          throw new Error('EIO');
        },
      },
      stdout: { isTTY: true },
      execFileSyncFn: (_cmd, args) => {
        failEvents.push(['stty', args]);
        return '6d02:5:bf\n';
      },
    }), /EIO/);
    assert.deepEqual(failEvents, [['stty', ['-g']], 'raw-throw']);
  });

  test('runPtyHost invokes enterRawOutputMode before streaming and restores stty state in finally', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-pty-stty-'));
    try {
      const script = path.join(tmp, 'quick-exit.mjs');
      fs.writeFileSync(script, 'process.stdout.write("line1\\nline2\\n", () => setTimeout(() => process.exit(0), 30));\n');

      const events = [];
      const fakeStdin = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: false,
        fd: 11,
        setRawMode: (raw) => events.push(['setRawMode', raw]),
      });
      const chunks = [];
      const fakeStdout = Object.assign(new EventEmitter(), {
        isTTY: true,
        columns: 80,
        rows: 24,
        write: (d) => {
          chunks.push(String(d));
          return true;
        },
      });

      const code = await runPtyHost({
        file: process.execPath,
        args: [script],
        cwd: tmp,
        stdin: fakeStdin,
        stdout: fakeStdout,
        platform: 'linux',
        execFileSyncFn: (cmd, args, opts) => {
          events.push(['stty', cmd, args, opts.stdio[0]]);
          if (args[0] === '-g') return '6d02:5:bf\n';
          return '';
        },
      });

      assert.equal(code, 0);
      assert.match(chunks.join(''), /line1/);
      assert.deepEqual(events, [
        ['stty', 'stty', ['-g'], 11],
        ['setRawMode', true],
        ['stty', 'stty', ['-opost'], 11],
        ['setRawMode', false],
        ['stty', 'stty', ['6d02:5:bf'], 11],
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 });
    }
  });
});

describe('hud / computeNextRefreshDelay, channel persistence & createRenderWorker', () => {
  test('computeNextRefreshDelay aligns <1h to seconds+20ms, >=1h to minutes+30ms capped at 30s, and triggers fast recheck after expiry', () => {
    const now = 1_700_000_000_000;

    // 1. Sub-hour active countdown: 42_350ms -> ((42350-1)%1000)+1+20 = 370ms
    const subHour = computeNextRefreshDelay({
      stdin: {
        quota: {
          'gemini-5h': { remaining_fraction: 0.5, reset_time: new Date(now + 42_350).toISOString() },
        },
      },
    }, now);
    assert.equal(subHour, 370);

    // Sub-hour exact second boundary: 5000ms -> 1020ms
    const exactSec = computeNextRefreshDelay({
      transcript: { imageExhausted: { exhausted: true, resetTime: new Date(now + 5_000).toISOString() } },
    }, now);
    assert.equal(exactSec, 1020);

    // 2. >= 1h countdown (e.g. 162h 3m 12s -> 12_030ms; 162h 3m 45s -> capped at 30_000ms)
    const weekly12s = computeNextRefreshDelay({
      agyQuota: {
        providerQuota: {
          google: { weekly: { remainingFraction: 0.4, resetTime: new Date(now + 162 * 3_600_000 + 3 * 60_000 + 12_000).toISOString() } },
        },
      },
    }, now);
    assert.equal(weekly12s, 12_030);

    const weekly45s = computeNextRefreshDelay({
      agyQuota: {
        providerQuota: {
          google: { weekly: { remainingFraction: 0.4, resetTime: new Date(now + 162 * 3_600_000 + 3 * 60_000 + 45_000).toISOString() } },
        },
      },
    }, now);
    assert.equal(weekly45s, 30_000);

    // 3. Recently crossed resetTime <= now without newer refresh schedules fast recheck
    const crossedNoRefresh = computeNextRefreshDelay({
      lastRefreshed: now - 5_000,
      agyQuota: {
        providerQuota: {
          google: { fiveHour: { remainingFraction: 0, resetTime: new Date(now - 200).toISOString() } },
        },
      },
    }, now);
    assert.equal(crossedNoRefresh, 1_000);

    const crossedInDebounce = computeNextRefreshDelay({
      lastRefreshed: now - 800,
      agyQuota: {
        providerQuota: {
          google: { fiveHour: { remainingFraction: 0, resetTime: new Date(now - 100).toISOString() } },
        },
      },
    }, now);
    assert.equal(crossedInDebounce, 1_250);
  });

  test('createChannel handles persistent multi-request loops with interleaved probe answers until EOF', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    let closed = false;
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) outLines.push(JSON.parse(line));
      }
    });
    output.on('close', () => { closed = true; });

    const { init, ask, reply, nextRequest } = createChannel(input, output);
    input.write(`${JSON.stringify({ stdin: { cwd: '/a' }, now: 100, paths: {}, persistent: true })}\n`);
    const first = await init;
    assert.equal(first.persistent, true);

    const p1 = ask(['agy.unicode']);
    input.write(`${JSON.stringify({ id: 1, answers: { 'agy.unicode': true } })}\n`);
    assert.deepEqual(await p1, { 'agy.unicode': true });
    reply({ lines: ['r1'] });
    assert.equal(closed, false);

    input.write(`${JSON.stringify({ stdin: { cwd: '/b' }, now: 200, paths: {}, persistent: true })}\n`);
    const second = await nextRequest();
    assert.equal(second?.now, 200);
    reply({ lines: ['r2'] });

    input.end();
    assert.equal(await nextRequest(), null);
    assert.equal(outLines.filter((m) => Array.isArray(m.lines)).length, 2);
  });

  test('hud.mjs writes AGY_HUD_HOST_STATE atomically and createRenderWorker reuses cage across renders, caches slow probes 15s, and restarts on grant changes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-worker-test-'));
    try {
      const home = path.join(tmp, 'home');
      const cwdA = path.join(tmp, 'proj-a');
      const cwdB = path.join(tmp, 'proj-b');
      const hostStatePath = path.join(tmp, 'session', 'state.json');
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.mkdirSync(cwdA, { recursive: true });
      fs.mkdirSync(cwdB, { recursive: true });

      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGY_HUD_DATA_DIR: path.join(home, '.gemini', 'antigravity-cli'),
        AGY_HUD_HOST_STATE: hostStatePath,
        COLUMNS: '100',
        TZ: 'UTC',
        LANG: 'en_US.UTF-8',
      };

      // 1. Real statusLine execution writes AGY_HUD_HOST_STATE atomically without leftover .tmp files
      const stdinPayload = {
        cwd: cwdA,
        model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
        context_window: { context_window_size: 200_000, used_percentage: 25 },
      };
      const cliRes = spawnSync(process.execPath, [path.join(ROOT, 'hud.mjs')], {
        input: JSON.stringify(stdinPayload),
        env,
        encoding: 'utf8',
      });
      assert.equal(cliRes.status, 0, cliRes.stderr);
      assert.equal(fs.existsSync(hostStatePath), true);
      const sessionFiles = fs.readdirSync(path.dirname(hostStatePath));
      assert.deepEqual(sessionFiles, ['state.json']);
      const savedState = JSON.parse(fs.readFileSync(hostStatePath, 'utf8'));
      assert.ok(savedState.lines.length >= 2);
      assert.equal(savedState.plainLines.length, savedState.lines.length);
      assert.equal(savedState.cols, 100);
      assert.equal(stripAnsiAndNbsp(savedState.lines[0]), savedState.plainLines[0]);

      // 2. Persistent RenderWorker: reuses single caged process, caches slow probes 15_000ms, refreshes agy.quota/memory, restarts on grant change
      const probeCalls = { git: 0, quota: 0, memory: 0 };
      const now0 = 1_700_000_000_000;
      let currentQuotaSeconds = 42;
      const worker = createRenderWorker({
        env,
        paths: collector.agyPaths(env),
        createProbesFn: () => async (names) => {
          const out = {};
          for (const n of names) {
            if (n === 'git.status') {
              probeCalls.git += 1;
              out[n] = null;
            } else if (n === 'agy.quota') {
              probeCalls.quota += 1;
              out[n] = {
                models: [],
                providerQuota: {
                  google: {
                    fiveHour: { remainingFraction: 0.5, resetTime: new Date(now0 + currentQuotaSeconds * 1000).toISOString() },
                  },
                },
                unavailableReason: null,
                tierName: null,
                accountEmail: null,
                updateInfo: null,
              };
            } else if (n === 'memory') {
              probeCalls.memory += 1;
              out[n] = {};
            } else if (n === 'agy.unicode') {
              out[n] = true;
            }
          }
          return out;
        },
      });

      try {
        const stdinWithQuota = {
          cwd: cwdA,
          model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
          context_window: { context_window_size: 200_000, used_percentage: 25 },
          quota: { 'gemini-5h': { remaining_fraction: 0.5, reset_time: new Date(now0 + 42_000).toISOString() } },
        };

        const r1 = await worker.renderSnapshot(stdinWithQuota, { now: now0, cols: 100 });
        assert.equal(worker.isAlive(), true);
        const pid1 = worker.pid();
        assert.ok(Number.isInteger(pid1));
        assert.match(r1.plainLines.join('\n'), /42s/);
        assert.equal(probeCalls.git, 1);
        assert.equal(probeCalls.quota, 1);

        // Second render within 15s reuses the SAME worker pid & slow git cache, updates countdown via live now & realigns cols
        currentQuotaSeconds = 42;
        const r2 = await worker.renderSnapshot(stdinWithQuota, { now: now0 + 5_000, cols: 50 });
        assert.equal(worker.pid(), pid1, 'same path fingerprint must reuse persistent worker pid');
        assert.match(r2.plainLines.join('\n'), /37s/);
        assert.equal(probeCalls.git, 1, 'slow git probe must stay cached within 15s');
        assert.equal(probeCalls.quota, 2, 'agy.quota probe must run on every snapshot');

        // Third render past 15_000ms refreshes slow git probe on same pid
        await worker.renderSnapshot(stdinWithQuota, { now: now0 + 16_000, cols: 100 });
        assert.equal(worker.pid(), pid1);
        assert.equal(probeCalls.git, 2, 'slow git probe must expire after 15s');

        // Unexpected worker crash respawns automatically on next renderSnapshot
        process.kill(pid1, 'SIGKILL');
        await new Promise((r) => setTimeout(r, 40));
        const rCrash = await worker.renderSnapshot(stdinWithQuota, { now: now0 + 16_500, cols: 100 });
        const pidAfterCrash = worker.pid();
        assert.ok(pidAfterCrash && pidAfterCrash !== pid1, 'crashed worker must auto-respawn');
        assert.match(rCrash.plainLines.join('\n'), /proj-a/);

        // Changing cwd changes logicPaths & grants -> worker restarts cleanly with new grants
        const r4 = await worker.renderSnapshot({ ...stdinWithQuota, cwd: cwdB }, { now: now0 + 17_000, cols: 100 });
        assert.notEqual(worker.pid(), pidAfterCrash, 'changed grant fingerprint must restart worker');
        assert.match(r4.plainLines.join('\n'), /proj-b/);
        assert.equal(probeCalls.git, 3);
      } finally {
        worker.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 });
    }
  });

  function assertDecreasingSeconds(output, maxExclusiveSeconds, message) {
    const plain = stripAnsiAndNbsp(output);
    const readings = [...plain.matchAll(/\((?:resets in )?(\d+)s(?:\s*[后後]重置)?\)/g)]
      .map((m) => Number.parseInt(m[1], 10))
      .filter((s) => s > 0 && s < maxExclusiveSeconds);
    const distinct = [];
    for (const s of readings) {
      if (distinct[distinct.length - 1] !== s) distinct.push(s);
    }
    assert.ok(
      distinct.length >= 2 && distinct.every((s, i) => i === 0 || s < distinct[i - 1]),
      `${message} (captured seconds < ${maxExclusiveSeconds}s: ${JSON.stringify(distinct)})`,
    );
  }

  test('runPtyHost strips ?9001h, mirrors output, overlays updates after 100ms silence, and restores altscreen on kill', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-pty-e2e-'));
    try {
      const home = path.join(tmp, 'home');
      const cwd = path.join(tmp, 'repo');
      const stateDir = path.join(tmp, 'session');
      const hostStatePath = path.join(stateDir, 'state.json');
      const mockAgyScript = path.join(tmp, 'mock-agy.mjs');
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });

      const now = Date.now();
      const resetIso = new Date(now + 45_450).toISOString();
      const snapshotStdin = {
        cwd,
        model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
        context_window: { context_window_size: 200_000, used_percentage: 25 },
        quota: { 'gemini-5h': { remaining_fraction: 0.5, reset_time: resetIso } },
      };
      const cfgDir = path.join(home, '.gemini', 'antigravity-cli', 'agy-hud');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
        presets: 'minimal',
        display: { quotaStyle: 'minimal', showMemoryUsage: false },
      }));

      fs.writeFileSync(mockAgyScript, `
        import fs from 'node:fs';
        import { execFileSync } from 'node:child_process';
        const statePath = process.env.AGY_HUD_HOST_STATE;
        const hudOut = execFileSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'hud.mjs'))}], {
          input: ${JSON.stringify(JSON.stringify(snapshotStdin))},
          env: process.env,
          encoding: 'utf8',
        });
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const border = '─'.repeat(50);
        process.stdout.write('\\x1b[?9001h\\x1b[?1049h\\x1b[H\\x1b[2J' + border + '\\r\\n > prompt\\r\\n' + border + '\\r\\n' + state.lines.join('\\r\\n') + '\\x1b[2;10H');
        setTimeout(() => process.exit(0), 2500);
      `);

      const fakeStdin = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: false,
        setRawMode: () => {},
      });
      const chunks = [];
      const fakeStdout = Object.assign(new EventEmitter(), {
        isTTY: true,
        columns: 100,
        rows: 24,
        write: (d) => {
          chunks.push(String(d));
          return true;
        },
      });

      const code = await runPtyHost({
        file: process.execPath,
        args: [mockAgyScript],
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AGY_HUD_DATA_DIR: path.join(home, '.gemini', 'antigravity-cli'),
          TZ: 'UTC',
          LANG: 'en_US.UTF-8',
        },
        cwd,
        hostStatePath,
        stdin: fakeStdin,
        stdout: fakeStdout,
      });

      assert.equal(code, 0);
      const output = chunks.join('');
      assert.equal(output.includes('\x1b[?9001h'), false, 'must strip win32-input-mode ?9001h');
      assert.ok(output.includes('\x1b[?1049h'), 'must preserve child altscreen');
      assert.ok(output.includes('\x1b[?1049l'), 'must restore altscreen when child exited without leaving ?1049l');
      assert.ok(output.includes('\x1b[4;1H\x1b[2K') || output.includes('\x1b[5;1H\x1b[2K'), 'must paint HUD overlay after silence');
      assertDecreasingSeconds(output, 46, 'must display refreshed countdown seconds during silence');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 });
    }
  });

  test('runPtyHost preserves inline normal buffer without forcing altscreen and paints relative updates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-pty-inline-'));
    try {
      const home = path.join(tmp, 'home');
      const cwd = path.join(tmp, 'repo');
      const stateDir = path.join(tmp, 'session');
      const hostStatePath = path.join(stateDir, 'state.json');
      const mockAgyScript = path.join(tmp, 'mock-inline-agy.mjs');
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'agy-hud'), { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'agy-hud', 'config.json'), JSON.stringify({
        presets: 'minimal',
        display: { quotaStyle: 'minimal', showMemoryUsage: false },
      }));

      const now = Date.now();
      const snapshotStdin = {
        cwd,
        model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
        context_window: { context_window_size: 200_000, used_percentage: 25 },
        quota: { 'gemini-5h': { remaining_fraction: 0.5, reset_time: new Date(now + 45_350).toISOString() } },
      };

      fs.writeFileSync(mockAgyScript, `
        import fs from 'node:fs';
        import { execFileSync } from 'node:child_process';
        const statePath = process.env.AGY_HUD_HOST_STATE;
        execFileSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'hud.mjs'))}], {
          input: ${JSON.stringify(JSON.stringify(snapshotStdin))},
          env: process.env,
          encoding: 'utf8',
        });
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const border = '─'.repeat(50);
        // Draw in normal buffer with cursor left inside input box (row 2 above bottom border at row 3), then exit after silence refresh
        process.stdout.write('\\x1b[H\\x1b[2J' + border + '\\r\\n > hello\\r\\n' + border + '\\r\\n' + state.lines.join('\\r\\n') + '\\x1b[2;9H');
        setTimeout(() => process.exit(0), 2500);
      `);

      const fakeStdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => {} });
      const chunks = [];
      const fakeStdout = Object.assign(new EventEmitter(), {
        isTTY: true,
        columns: 100,
        rows: 24,
        write: (d) => { chunks.push(String(d)); return true; },
      });

      const code = await runPtyHost({
        file: process.execPath,
        args: [mockAgyScript],
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AGY_HUD_DATA_DIR: path.join(home, '.gemini', 'antigravity-cli'),
          TZ: 'UTC',
          LANG: 'en_US.UTF-8',
        },
        cwd,
        hostStatePath,
        stdin: fakeStdin,
        stdout: fakeStdout,
      });

      assert.equal(code, 0);
      const output = chunks.join('');
      assert.equal(output.includes('\x1b[?1049h'), false, 'inline mode must never force altscreen');
      assert.match(output, /\x1b\[\?25l\x1b7\x1b\[\?7l\x1b\[\d+B\r\x1b\[2K/, 'inline mode must paint via relative cursor down');
      assertDecreasingSeconds(output, 46, 'inline mode must update live countdown');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 });
    }
  });

  test('runPtyHost picks up pre-existing AGY_HUD_HOST_STATE and polling fallback when watcher misses initial write', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-pty-poll-'));
    try {
      const home = path.join(tmp, 'home');
      const cwd = path.join(tmp, 'repo');
      const stateDir = path.join(tmp, 'session');
      const hostStatePath = path.join(stateDir, 'state.json');
      const mockAgyScript = path.join(tmp, 'mock-preexisting-agy.mjs');
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'agy-hud'), { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'agy-hud', 'config.json'), JSON.stringify({
        presets: 'minimal',
        display: { quotaStyle: 'minimal', showMemoryUsage: false },
      }));

      const now = Date.now();
      const snapshotStdin = {
        cwd,
        model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
        context_window: { context_window_size: 200_000, used_percentage: 25 },
        quota: { 'gemini-5h': { remaining_fraction: 0.5, reset_time: new Date(now + 45_350).toISOString() } },
      };

      // Pre-populate state.json BEFORE runPtyHost sets up fs.watch (no fs.watch event will fire for it)
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGY_HUD_DATA_DIR: path.join(home, '.gemini', 'antigravity-cli'),
        AGY_HUD_HOST_STATE: hostStatePath,
        TZ: 'UTC',
        LANG: 'en_US.UTF-8',
      };
      spawnSync(process.execPath, [path.join(ROOT, 'hud.mjs')], {
        input: JSON.stringify(snapshotStdin),
        env,
        encoding: 'utf8',
      });
      const preState = JSON.parse(fs.readFileSync(hostStatePath, 'utf8'));

      fs.writeFileSync(mockAgyScript, `
        const border = '─'.repeat(50);
        process.stdout.write('\\x1b[?1049h\\x1b[H\\x1b[2J' + border + '\\r\\n > prompt\\r\\n' + border + '\\r\\n' + ${JSON.stringify(preState.lines.join('\r\n'))} + '\\x1b[2;10H');
        setTimeout(() => process.exit(0), 2500);
      `);

      const fakeStdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => {} });
      const chunks = [];
      const fakeStdout = Object.assign(new EventEmitter(), {
        isTTY: true,
        columns: 100,
        rows: 24,
        write: (d) => { chunks.push(String(d)); return true; },
      });

      const code = await runPtyHost({
        file: process.execPath,
        args: [mockAgyScript],
        env,
        cwd,
        hostStatePath,
        stdin: fakeStdin,
        stdout: fakeStdout,
        initialStatePollMs: 50,
      });

      assert.equal(code, 0);
      const output = chunks.join('');
      assertDecreasingSeconds(output, 46, 'must overlay refreshed countdown from pre-existing host state');

      // Also verify polling fallback recovers when fs.watch returns null/misses write
      const origWatch = fs.watch;
      const pollStatePath = path.join(stateDir, 'poll-state.json');
      fs.rmSync(hostStatePath, { force: true, maxRetries: 15, retryDelay: 80 });
      const mockPollScript = path.join(tmp, 'mock-poll-agy.mjs');
      fs.writeFileSync(mockPollScript, `
        import fs from 'node:fs';
        const border = '─'.repeat(50);
        process.stdout.write('\\x1b[?1049h\\x1b[H\\x1b[2J' + border + '\\r\\n > prompt\\r\\n' + border + '\\r\\n' + ${JSON.stringify(preState.lines.join('\r\n'))} + '\\x1b[2;10H');
        setTimeout(() => {
          fs.writeFileSync(process.env.AGY_HUD_HOST_STATE, ${JSON.stringify(JSON.stringify(preState))});
        }, 80);
        setTimeout(() => process.exit(0), 2500);
      `);
      const chunksPoll = [];
      const fakeStdoutPoll = Object.assign(new EventEmitter(), {
        isTTY: true,
        columns: 100,
        rows: 24,
        write: (d) => { chunksPoll.push(String(d)); return true; },
      });
      fs.watch = () => { throw new Error('watch disabled'); };
      try {
        const pollCode = await runPtyHost({
          file: process.execPath,
          args: [mockPollScript],
          env,
          cwd,
          hostStatePath: pollStatePath,
          stdin: fakeStdin,
          stdout: fakeStdoutPoll,
          initialStatePollMs: 40,
        });
        assert.equal(pollCode, 0);
        assertDecreasingSeconds(chunksPoll.join(''), 46, 'polling fallback must recover initial state when fs.watch is unavailable');
      } finally {
        fs.watch = origWatch;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 });
    }
  });
});

describe('runtime / pty-host regression guards', () => {
  function createFakePty({ onWrite, onResize, onKill, _agent } = {}) {
    const dataListeners = new Set();
    const exitListeners = new Set();
    return {
      pid: 4242,
      _agent,
      onData(fn) {
        dataListeners.add(fn);
        return { dispose: () => dataListeners.delete(fn) };
      },
      onExit(fn) {
        exitListeners.add(fn);
        return { dispose: () => exitListeners.delete(fn) };
      },
      write(data) { onWrite?.(data); },
      resize(cols, rows) { onResize?.(cols, rows); },
      kill(signal) { onKill?.(signal); },
      pause() {},
      resume() {},
      emitData(data) {
        for (const fn of [...dataListeners]) fn(data);
      },
      emitExit(exitCode = 0, signal) {
        for (const fn of [...exitListeners]) fn({ exitCode, signal });
      },
    };
  }

  test('repaints fresh HUD when child redraws stale buffer and when snapshot leads child output', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-pty-redraw-'));
    try {
      const home = path.join(tmp, 'home');
      const cwd = path.join(tmp, 'repo');
      const stateDir = path.join(tmp, 'session');
      const hostStatePath = path.join(stateDir, 'state.json');
      const cfgDir = path.join(home, '.gemini', 'antigravity-cli', 'agy-hud');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
        presets: 'minimal',
        display: { quotaStyle: 'minimal', showMemoryUsage: false },
      }));

      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGY_HUD_DATA_DIR: path.join(home, '.gemini', 'antigravity-cli'),
        AGY_HUD_HOST_STATE: hostStatePath,
        COLUMNS: '100',
        TZ: 'UTC',
        LANG: 'en_US.UTF-8',
      };

      // 1. Deterministic check: snapshot already leads child screen by 1s (strict text mismatch),
      //    then child redraws identical stale screen (childOutputSeq !== paintedOutputSeq) within the same second.
      const snapshotStdin = {
        cwd,
        model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
        context_window: { context_window_size: 200_000, used_percentage: 25 },
        quota: { 'gemini-5h': { remaining_fraction: 0.5, reset_time: new Date(Date.now() + 44_700).toISOString() } },
      };
      const initRes = spawnSync(process.execPath, [path.join(ROOT, 'hud.mjs')], {
        input: JSON.stringify(snapshotStdin),
        env,
        encoding: 'utf8',
      });
      assert.equal(initRes.status, 0, initRes.stderr);
      const saved = JSON.parse(fs.readFileSync(hostStatePath, 'utf8'));
      const initialSecMatch = saved.plainLines.join('\n').match(/\((?:resets in )?(\d+)s(?:\s*[后後]重置)?\)/);
      assert.ok(initialSecMatch, `Expected seconds in snapshot: ${saved.plainLines.join('\n')}`);
      const snapSec = Number.parseInt(initialSecMatch[1], 10);
      const staleSec = snapSec + 1;
      const staleLines = saved.lines.map((line) => line.replace(`${snapSec}s`, `${staleSec}s`));
      const border = '─'.repeat(50);

      let fakePty;
      const fakeStdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => {} });
      const chunks = [];
      const fakeStdout = Object.assign(new EventEmitter(), {
        isTTY: true,
        columns: 100,
        rows: 24,
        write: (d) => { chunks.push(String(d)); return true; },
      });

      const hostPromise = runPtyHost({
        file: 'mock-agy',
        args: [],
        env,
        cwd,
        hostStatePath,
        stdin: fakeStdin,
        stdout: fakeStdout,
        platform: 'linux',
        execFileSyncFn: () => '',
        spawnPty: () => {
          fakePty = createFakePty();
          return fakePty;
        },
      });

      const drawFrame = (marker) => `\x1b[?1049h\x1b[H\x1b[2J${border}\r\n > ${marker}\r\n${border}\r\n${staleLines.join('\r\n')}\x1b[2;12H`;
      const extractSeconds = (text) => [...text.matchAll(/\((?:resets in )?(\d+)s(?:\s*[后後]重置)?\)/g)]
        .map((m) => Number.parseInt(m[1], 10));
      const waitFor = async (pred, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          if (pred()) return true;
          if (Date.now() >= deadline) return false;
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      try {
        fakePty.emitData(drawFrame('first'));
        await waitFor(
          () => extractSeconds(stripAnsiAndNbsp(chunks.join(''))).some((s) => s < staleSec),
          8000,
        );
        const firstPassSecs = extractSeconds(stripAnsiAndNbsp(chunks.join('')));
        assert.ok(
          firstPassSecs.some((s) => s < staleSec),
          `Host must overwrite leading stale ${staleSec}s line: ${JSON.stringify(firstPassSecs)}`,
        );

        const beforeRedrawOffset = chunks.join('').length;
        const readAfterRedraw = () => {
          const plain = stripAnsiAndNbsp(chunks.join('').slice(beforeRedrawOffset));
          const redrawIdx = plain.indexOf('redrawn');
          const tail = redrawIdx >= 0 ? plain.slice(redrawIdx) : '';
          return { plain, hasRedrawn: redrawIdx >= 0, secs: extractSeconds(tail) };
        };
        fakePty.emitData(drawFrame('redrawn'));
        await waitFor(() => {
          const { hasRedrawn, secs } = readAfterRedraw();
          return hasRedrawn && secs.some((s) => s < staleSec);
        }, 6000);
        const afterRedraw = readAfterRedraw();
        assert.ok(
          afterRedraw.hasRedrawn && afterRedraw.secs.some((s) => s < staleSec),
          `Host must re-overlay after child redraws stale ${staleSec}s buffer (captured: ${JSON.stringify(afterRedraw.plain)})`,
        );
        fakePty.emitExit(0);
        assert.equal(await hostPromise, 0);
      } finally {
        fakePty?.emitExit(0);
        await hostPromise.catch(() => {});
      }

      // 2. Real PTY end-to-end verification of stale buffer redraw recovery
      const e2eStatePath = path.join(stateDir, 'e2e-state.json');
      const e2eScript = path.join(tmp, 'redraw-agy.mjs');
      const e2eStdinPayload = {
        cwd,
        model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
        context_window: { context_window_size: 200_000, used_percentage: 25 },
        quota: { 'gemini-5h': { remaining_fraction: 0.5, reset_time: new Date(Date.now() + 45_500).toISOString() } },
      };
      fs.writeFileSync(e2eScript, `
        import fs from 'node:fs';
        import { execFileSync } from 'node:child_process';
        const statePath = process.env.AGY_HUD_HOST_STATE;
        execFileSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'hud.mjs'))}], {
          input: ${JSON.stringify(JSON.stringify(e2eStdinPayload))},
          env: process.env,
          encoding: 'utf8',
        });
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const border = '─'.repeat(50);
        const frame = (tag) => '\\x1b[?1049h\\x1b[H\\x1b[2J' + border + '\\r\\n > ' + tag + '\\r\\n' + border + '\\r\\n' + state.lines.join('\\r\\n') + '\\x1b[2;12H';
        process.stdout.write(frame('initial'));
        setTimeout(() => {
          process.stdout.write(frame('redrawn'));
          setTimeout(() => process.exit(0), 800);
        }, 1350);
      `);
      const e2eFakeStdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => {} });
      const e2eChunks = [];
      const e2eStdout = Object.assign(new EventEmitter(), {
        isTTY: true,
        columns: 100,
        rows: 24,
        write: (d) => { e2eChunks.push(String(d)); return true; },
      });
      const e2eHostPromise = runPtyHost({
        file: process.execPath,
        args: [e2eScript],
        env: { ...env, AGY_HUD_HOST_STATE: e2eStatePath },
        cwd,
        hostStatePath: e2eStatePath,
        stdin: e2eFakeStdin,
        stdout: e2eStdout,
        initialStatePollMs: 50,
      });
      let e2eWatchdog;
      let e2eTimedOut = false;
      try {
        const e2eCode = await Promise.race([
          e2eHostPromise,
          new Promise((resolve) => {
            e2eWatchdog = setTimeout(() => {
              e2eTimedOut = true;
              try { e2eFakeStdin.push('\x03'); } catch {}
              resolve(-1);
            }, 15_000);
            e2eWatchdog.unref?.();
          }),
        ]);
        assert.equal(e2eTimedOut, false, 'Real PTY redraw E2E timed out');
        assert.equal(e2eCode, 0);
        const e2ePlain = stripAnsiAndNbsp(e2eChunks.join(''));
        const redrawOffset = e2ePlain.indexOf('redrawn');
        assert.ok(redrawOffset >= 0, `Expected "redrawn" frame in E2E output: ${JSON.stringify(e2ePlain)}`);
        const readingsAfterRedraw = extractSeconds(e2ePlain.slice(redrawOffset));
        assert.ok(
          readingsAfterRedraw.length >= 2 && readingsAfterRedraw.some((s) => s < readingsAfterRedraw[0]),
          `Expected fresh overlay repaint < stale ${readingsAfterRedraw[0]}s after redraw: ${JSON.stringify(readingsAfterRedraw)}`,
        );
      } finally {
        clearTimeout(e2eWatchdog);
        if (!e2eTimedOut) {
          await e2eHostPromise.catch(() => {});
        } else {
          let settleWaitTimer;
          await Promise.race([
            e2eHostPromise.catch(() => {}),
            new Promise((resolve) => {
              settleWaitTimer = setTimeout(resolve, 1000);
              settleWaitTimer.unref?.();
            }),
          ]);
          clearTimeout(settleWaitTimer);
        }
        try { e2eFakeStdin.destroy(); } catch {}
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 });
    }
  });

  test('protects child.resize and child.write during exit transition and restores raw mode, stty, and altscreen', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-pty-exit-guard-'));
    try {
      for (const platform of ['win32', 'linux']) {
        let fakePty;
        let exiting = false;
        let exitedEmitted = false;
        let resizeBeforeExit = 0;
        let resizeAfterExit = 0;
        let writeBeforeExit = 0;
        let writeAfterExit = 0;
        const events = [];

        const fakeStdin = Object.assign(new PassThrough(), {
          isTTY: true,
          isRaw: false,
          fd: 12,
          setRawMode: (raw) => events.push(['setRawMode', raw]),
        });
        const chunks = [];
        const fakeStdout = Object.assign(new EventEmitter(), {
          isTTY: true,
          columns: 80,
          rows: 24,
          write: (d) => { chunks.push(String(d)); return true; },
        });

        const hostPromise = runPtyHost({
          file: 'mock-agy',
          args: [],
          env: { ...process.env, HOME: tmp, USERPROFILE: tmp, AGY_HUD_DATA_DIR: tmp },
          cwd: tmp,
          stdin: fakeStdin,
          stdout: fakeStdout,
          platform,
          execFileSyncFn: (_cmd, args) => {
            events.push(['stty', args]);
            return args[0] === '-g' ? '6d02:5:bf\n' : '';
          },
          spawnPty: () => {
            fakePty = createFakePty({
              onResize: () => {
                if (exitedEmitted) resizeAfterExit += 1;
                else resizeBeforeExit += 1;
                if (exiting) throw new Error('Cannot resize a pty that has already exited');
              },
              onWrite: () => {
                if (exitedEmitted) writeAfterExit += 1;
                else writeBeforeExit += 1;
                if (exiting) throw new Error('write EIO');
              },
            });
            return fakePty;
          },
        });

        fakePty.emitData('\x1b[?1049hactive');
        exiting = true; // Simulate ConPTY FLUSH_DATA_INTERVAL / dead master fd before onExit fires

        fakeStdout.columns = 100;
        fakeStdout.rows = 30;
        fakeStdout.emit('resize');
        fakeStdin.push('abc');
        fakeStdin.push('\x1b');
        await new Promise((r) => setTimeout(r, 45));

        exitedEmitted = true;
        fakePty.emitExit(0);
        fakeStdout.columns = 110;
        fakeStdout.rows = 32;
        fakeStdout.emit('resize');
        fakeStdin.push('after-exit');
        await new Promise((r) => setTimeout(r, 20));

        assert.equal(await hostPromise, 0);
        assert.equal(resizeBeforeExit, 1);
        assert.equal(resizeAfterExit, 0);
        assert.equal(writeBeforeExit, 2);
        assert.equal(writeAfterExit, 0);
        assert.ok(chunks.join('').includes('\x1b[?1049l'), `${platform}: must restore altscreen`);
        assert.deepEqual(events.filter(([kind]) => kind === 'setRawMode'), [
          ['setRawMode', true],
          ['setRawMode', false],
        ]);
        if (platform === 'linux') {
          assert.deepEqual(events.filter(([kind]) => kind === 'stty'), [
            ['stty', ['-g']],
            ['stty', ['-opost']],
            ['stty', ['6d02:5:bf']],
          ]);
        } else {
          assert.deepEqual(events.filter(([kind]) => kind === 'stty'), []);
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 });
    }
  });

  test('continues forwarding SIGINT and escalated SIGTERM to child without blocking write or resize', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-pty-signals-'));
    try {
      const driver = path.join(tmp, 'signal-driver.mjs');
      const ptyHostUrl = new URL('../runtime/pty-host.mjs', import.meta.url).href;
      fs.writeFileSync(driver, `
        import { EventEmitter } from 'node:events';
        import { PassThrough } from 'node:stream';
        import { runPtyHost } from ${JSON.stringify(ptyHostUrl)};

        const kills = [];
        const writes = [];
        const resizes = [];
        let fakePty;

        const fakeStdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => {} });
        const fakeStdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: () => true });

        const hostPromise = runPtyHost({
          file: 'mock-agy',
          args: [],
          env: { ...process.env, HOME: ${JSON.stringify(tmp)}, USERPROFILE: ${JSON.stringify(tmp)}, AGY_HUD_DATA_DIR: ${JSON.stringify(tmp)} },
          cwd: ${JSON.stringify(tmp)},
          stdin: fakeStdin,
          stdout: fakeStdout,
          platform: 'linux',
          execFileSyncFn: () => '',
          spawnPty: () => {
            const dataListeners = new Set();
            const exitListeners = new Set();
            fakePty = {
              pid: 5151,
              onData: (fn) => { dataListeners.add(fn); return { dispose: () => dataListeners.delete(fn) }; },
              onExit: (fn) => { exitListeners.add(fn); return { dispose: () => exitListeners.delete(fn) }; },
              write: (d) => writes.push(d),
              resize: (c, r) => resizes.push([c, r]),
              kill: (sig) => kills.push(sig ?? 'NO_SIGNAL'),
              pause: () => {},
              resume: () => {},
              emitExit: (exitCode, signal) => { for (const fn of [...exitListeners]) fn({ exitCode, signal }); },
            };
            return fakePty;
          },
        });

        process.emit('SIGINT');
        fakeStdin.push('y');
        fakeStdout.columns = 120;
        fakeStdout.rows = 30;
        fakeStdout.emit('resize');
        process.emit('SIGINT');
        process.emit('SIGTERM');
        fakePty.emitExit(0, 15);
        const code = await hostPromise;

        let winKilledWith = null;
        let winPtyClosed = false;
        let winPty;
        const winPromise = runPtyHost({
          file: 'mock-agy',
          args: [],
          env: { ...process.env, HOME: ${JSON.stringify(tmp)}, USERPROFILE: ${JSON.stringify(tmp)}, AGY_HUD_DATA_DIR: ${JSON.stringify(tmp)} },
          cwd: ${JSON.stringify(tmp)},
          stdin: fakeStdin,
          stdout: fakeStdout,
          platform: 'win32',
          execFileSyncFn: () => '',
          spawnPty: () => {
            const exitListeners = new Set();
            winPty = {
              pid: 5152,
              _agent: { _conoutSocketWorker: { dispose: () => { winPtyClosed = true; } } },
              onData: () => ({ dispose: () => {} }),
              onExit: (fn) => { exitListeners.add(fn); return { dispose: () => exitListeners.delete(fn) }; },
              write: () => {},
              resize: () => {},
              kill: (sig) => { winKilledWith = sig === undefined ? 'NO_ARG' : sig; },
              pause: () => {},
              resume: () => {},
              emitExit: (exitCode) => { for (const fn of [...exitListeners]) fn({ exitCode }); },
            };
            return winPty;
          },
        });
        process.emit('SIGINT');
        winPty.emitExit(0);
        const winCode = await winPromise;

        process.stdout.write(JSON.stringify({ kills, writes, resizes, code, winKilledWith, winPtyClosed, winCode }));
      `);

      const res = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      const parsed = JSON.parse(res.stdout);
      assert.deepEqual(parsed.kills, ['SIGINT', 'SIGINT', 'SIGTERM']);
      assert.deepEqual(parsed.writes, ['y']);
      assert.deepEqual(parsed.resizes, [[120, 30]]);
      assert.equal(parsed.code, 143);
      assert.equal(parsed.winKilledWith, 'NO_ARG');
      assert.equal(parsed.winPtyClosed, true);
      assert.equal(parsed.winCode, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 });
    }
  });
});
