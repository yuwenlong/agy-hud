import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = '.agy-hud-shell.json';
const KINDS = new Set(['bash', 'zsh', 'powershell']);
const BASENAMES = new Set(['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', 'profile.ps1']);
const PROFILE_LIMIT = 4 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
const TICKET_NAME_RE = /^([1-9]\d{0,9})-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;
const WAKE = new Int32Array(new SharedArrayBuffer(4));

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function powershellLiteral(value) {
  if (/^[\x20-\x7e]*$/u.test(value)) return `'${value.replaceAll("'", "''")}'`;
  // PowerShell 5.1 can read an existing profile in an ANSI code page.
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;
}

function resolvePsHelperPath(cli) {
  if (!cli) return null;
  if (basename(cli) === 'shell.mjs') return cli;
  if (basename(dirname(cli)) === 'bin') return join(dirname(dirname(cli)), 'shell.mjs');
  return join(dirname(cli), 'shell.mjs');
}

export function shellInit(shell, cli) {
  if (!KINDS.has(shell)) throw new Error(`Unsupported shell: ${shell}`);

  if (shell === 'powershell') {
    const helperOverride = resolvePsHelperPath(cli);
    const pathLines = helperOverride
      ? [`        $agyHudHelper = ${powershellLiteral(helperOverride)}`]
      : [
          '        $agyHudHelper = $null',
          '        if ($env:AGY_HUD_DATA_DIR) {',
          '            $agyHudHelper = Join-Path $env:AGY_HUD_DATA_DIR "agy-hud-runtime/runtime/shell.mjs"',
          '        } else {',
          '            $agyHudHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }',
          '            $agyHudCandidates = @(',
          '                (Join-Path $agyHudHome ".gemini/antigravity-cli/agy-hud-runtime/runtime/shell.mjs")',
          '            )',
          '            if ($env:XDG_DATA_HOME) { $agyHudCandidates += (Join-Path $env:XDG_DATA_HOME "antigravity-cli/agy-hud-runtime/runtime/shell.mjs") }',
          '            if ($env:APPDATA) { $agyHudCandidates += (Join-Path $env:APPDATA "antigravity-cli/agy-hud-runtime/runtime/shell.mjs") }',
          '            if ($env:LOCALAPPDATA) { $agyHudCandidates += (Join-Path $env:LOCALAPPDATA "antigravity-cli/agy-hud-runtime/runtime/shell.mjs") }',
          '            foreach ($agyHudCandidate in $agyHudCandidates) {',
          '                if (Test-Path -LiteralPath $agyHudCandidate -PathType Leaf) {',
          '                    $agyHudHelper = $agyHudCandidate',
          '                    break',
          '                }',
          '            }',
          '            if (-not $agyHudHelper) { $agyHudHelper = $agyHudCandidates[0] }',
          '        }',
        ];
    return [
      'if (-not (Get-Command agy -CommandType Alias,Function -ErrorAction SilentlyContinue)) {',
      '    function global:agy {',
      '        $agyHudPipeline = $MyInvocation.ExpectingInput',
      ...pathLines,
      '        $agyHudNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
      '        if (-not $agyHudPipeline -and $env:AGY_HUD_BYPASS -ne "1" -and $env:TERM -ne "dumb" -and',
      '            -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected -and',
      '            $agyHudNode -and $agyHudHelper -and (Test-Path -LiteralPath $agyHudHelper -PathType Leaf)) {',
      '            $agyHudArguments = ConvertTo-Json -InputObject @($args | ForEach-Object { [string]$_ }) -Compress',
      '            if ($agyHudArguments.Length -lt 30000) {',
      '                $agyHudPrevious = $env:AGY_HUD_SHELL_ARGS',
      '                $agyHudManagedPrevious = $env:AGY_HUD_SHELL_MANAGED',
      '                try {',
      '                    $env:AGY_HUD_SHELL_ARGS = $agyHudArguments',
      '                    $env:AGY_HUD_SHELL_MANAGED = "1"',
      '                    & $agyHudNode.Source $agyHudHelper launch',
      '                } finally {',
      '                    $env:AGY_HUD_SHELL_ARGS = $agyHudPrevious',
      '                    $env:AGY_HUD_SHELL_MANAGED = $agyHudManagedPrevious',
      '                }',
      '                return',
      '            }',
      '        }',
      '        $agyHudNative = Get-Command agy -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1',
      '        if ($agyHudPipeline) {',
      '            $input | & $agyHudNative @args',
      '        } else {',
      '            & $agyHudNative @args',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
  }

  const cliResolution = cli
    ? [`  local agy_hud_cli=${shellQuote(cli)}`]
    : [
        '  local agy_hud_cli="${AGY_HUD_DATA_DIR:-${HOME-}/.gemini/antigravity-cli}/agy-hud-runtime/runtime/bin/agy-hud.js"',
        '  if [ -z "${AGY_HUD_DATA_DIR-}" ] && [ ! -f "$agy_hud_cli" ] && [ -n "${XDG_DATA_HOME-}" ]; then',
        '    agy_hud_cli="${XDG_DATA_HOME}/antigravity-cli/agy-hud-runtime/runtime/bin/agy-hud.js"',
        '  fi',
      ];

  const definition = [
    'agy() {',
    ...cliResolution,
    '  if [ -t 0 ] && [ -t 1 ] && [ "${TERM-}" != dumb ] && [ "${AGY_HUD_BYPASS-}" != 1 ] &&',
    '     [ -f "$agy_hud_cli" ] && command -v node >/dev/null 2>&1; then',
    '    command env "AGY_HUD_SHELL_MANAGED=1" node "$agy_hud_cli" launch -- "$@"',
    '  else',
    '    command agy "$@"',
    '  fi',
    '}',
  ].join('\n');

  // The outer guard must parse in POSIX sh when Bash falls back to ~/.profile.
  return [
    'if [ -n "${BASH_VERSION-}${ZSH_VERSION-}" ]; then',
    '  case "$-" in',
    '    *i*)',
    '      if ! alias agy >/dev/null 2>&1 && ! typeset -f agy >/dev/null 2>&1; then',
    `        eval ${shellQuote(definition)}`,
    '      fi ;;',
    '  esac',
    'fi',
    '',
  ].join('\n');
}

function isAbsoluteAny(value) {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function resolveHomeRoot(env, platform, homeDir) {
  if (homeDir) return homeDir;
  if (platform === 'win32') return env.USERPROFILE || env.HOME || homedir();
  return env.HOME || env.USERPROFILE || homedir();
}

function targets(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  if (env.AGY_HUD_SHELL === 'none') return [];

  const psProfile = env.AGY_HUD_PS_PROFILE;
  const choice = env.AGY_HUD_SHELL || (psProfile || platform === 'win32'
    ? 'powershell'
    : basename(env.SHELL || 'bash'));

  if (choice === 'powershell') {
    if (psProfile) {
      return isAbsoluteAny(psProfile) && basename(psProfile).toLowerCase() === 'profile.ps1'
        ? [{ path: resolve(psProfile), shell: choice }]
        : [];
    }
    if (platform === 'win32') {
      const homeRoot = resolveHomeRoot(env, platform, options.homeDir);
      return [{ path: resolve(homeRoot, 'Documents', 'PowerShell', 'profile.ps1'), shell: choice }];
    }
    return [];
  }

  const homeRoot = resolveHomeRoot(env, platform, options.homeDir);
  if (choice === 'zsh') {
    return [{ path: resolve(homeRoot, env.ZDOTDIR || '.', '.zshrc'), shell: choice }];
  }
  if (choice === 'bash') {
    const login = ['.bash_profile', '.bash_login', '.profile']
      .map((name) => resolve(homeRoot, name))
      .find((candidate) => fs.lstatSync(candidate, { throwIfNoEntry: false }));
    return [
      { path: resolve(homeRoot, '.bashrc'), shell: choice },
      { path: login || resolve(homeRoot, '.profile'), shell: choice },
    ];
  }
  return [];
}

function inspect(filePath) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > PROFILE_LIMIT) {
    throw new Error('Not a regular startup file of supported size.');
  }
  return {
    bytes: fs.readFileSync(filePath, { flag: NO_FOLLOW }),
    mode: stat.mode & 0o777,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function sameFile(filePath, previous) {
  const actual = inspect(filePath);
  if (!actual && !previous) return;
  if (
    !actual
    || !previous
    || actual.dev !== previous.dev
    || actual.ino !== previous.ino
    || !actual.bytes.equals(previous.bytes)
  ) {
    throw new Error('The startup file changed during installation.');
  }
}

function publish(filePath, bytes, previous, tmp = join(dirname(filePath), `.agy-hud-${randomUUID()}.tmp`), platform = process.platform) {
  const fd = fs.openSync(tmp, 'wx', previous?.mode ?? 0o600);
  try {
    try {
      if (previous && platform !== 'win32') fs.fchmodSync(fd, previous.mode);
      fs.writeFileSync(fd, bytes, { flush: true });
    } finally {
      fs.closeSync(fd);
    }
    sameFile(filePath, previous);
    if (previous) fs.renameSync(tmp, filePath);
    else fs.linkSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function removeTicket(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function otherTickets(queue, owner) {
  const peers = [];
  for (const file of fs.readdirSync(queue)) {
    const name = file.replace(/\.pending$/u, '');
    const match = TICKET_NAME_RE.exec(name);
    if (!match || name === owner) continue;
    const ticketPath = join(queue, name);
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        removeTicket(`${ticketPath}.pending`);
        removeTicket(ticketPath);
        continue;
      }
      if (error.code !== 'EPERM') throw error;
    }
    if (file !== name) continue;
    let number;
    try {
      number = fs.readFileSync(ticketPath, { encoding: 'utf8', flag: NO_FOLLOW });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (number && !/^[1-9]\d{0,14}$/u.test(number)) {
      throw new Error('Invalid startup profile ticket.');
    }
    peers.push({ name, number: Number(number) });
  }
  return peers;
}

function withProfileTicket(profile, action, platform = process.platform) {
  const file = basename(profile);
  const queue = join(
    fs.realpathSync(dirname(profile)),
    `${platform === 'win32' ? file.toLowerCase() : file}.agy-hud-tickets`,
  );
  const owner = `${process.pid}-${randomUUID()}`;
  const ticketPath = join(queue, owner);
  const pending = `${ticketPath}.pending`;
  const deadline = Date.now() + 5000;

  for (;;) {
    try {
      fs.mkdirSync(queue, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const folder = fs.lstatSync(queue, { throwIfNoEntry: false });
    if (!folder && Date.now() < deadline) continue;
    if (!folder?.isDirectory()) {
      throw new Error('The startup profile lock is not a regular directory.');
    }
    try {
      fs.writeFileSync(ticketPath, '', { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
    }
  }

  try {
    // Lamport's bakery lock: an empty ticket announces that its owner is choosing a number.
    const number = Math.max(0, ...otherTickets(queue, owner).map((peer) => peer.number)) + 1;
    if (number >= 1e15) throw new Error('Startup profile ticket limit reached.');
    publish(ticketPath, Buffer.from(String(number)), inspect(ticketPath), pending, platform);
    while (otherTickets(queue, owner).some((peer) => (
      !peer.number || peer.number < number || (peer.number === number && peer.name < owner)
    ))) {
      if (Date.now() >= deadline) {
        throw new Error('Another installation is changing this startup profile.');
      }
      Atomics.wait(WAKE, 0, 0, 20);
    }
    return action(pending);
  } finally {
    removeTicket(pending);
    removeTicket(ticketPath);
    try {
      fs.rmdirSync(queue);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
    }
  }
}

function encode(text, encoding) {
  if (encoding === 'utf16be') return Buffer.from(text, 'utf16le').swap16();
  return Buffer.from(text, encoding);
}

function profileEncoding(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf16be';
  return 'utf8';
}

function markerId(configDir, platform = process.platform) {
  const normalized = platform === 'win32' ? configDir.toLowerCase() : configDir;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

const startMarker = (marker) => `# >>> agy-hud ${marker} >>>`;
const endMarker = (marker) => `# <<< agy-hud ${marker} <<<`;
const CREATED_PROFILE_COMMENT = '# agy-hud: created this startup profile';

function readRecords(manifestPath, marker) {
  const previous = inspect(manifestPath);
  if (!previous) return [];
  const data = JSON.parse(previous.bytes.toString('utf8'));
  const validBlock = (block, eol) => typeof block === 'string'
    && block.startsWith(startMarker(marker) + eol)
    && block.endsWith(endMarker(marker) + eol);

  if (
    data.version !== 1
    || !Array.isArray(data.entries)
    || data.entries.length > 32
    || data.entries.some((entry) => (
      !entry
      || typeof entry.path !== 'string'
      || !isAbsoluteAny(entry.path)
      || !BASENAMES.has(basename(entry.path).toLowerCase())
      || !KINDS.has(entry.shell)
      || !['utf8', 'utf16le', 'utf16be'].includes(entry.encoding)
      || !['\n', '\r\n'].includes(entry.eol)
      || typeof entry.addedSeparator !== 'boolean'
      || typeof entry.created !== 'boolean'
      || !validBlock(entry.block, entry.eol)
      || (entry.priorBlock !== undefined && !validBlock(entry.priorBlock, entry.eol))
    ))
  ) {
    throw new Error('Invalid AGY HUD shell integration record.');
  }
  return data.entries;
}

function profileBlock(shell, marker, eol, created, cliPath) {
  const header = created ? [startMarker(marker), CREATED_PROFILE_COMMENT] : [startMarker(marker)];
  return [...header, shellInit(shell, cliPath).trimEnd(), endMarker(marker), ''].join('\n').replaceAll('\n', eol);
}

function profileText(bytes, encoding) {
  return new TextDecoder(encoding.replace(/^utf(8|16)/u, 'utf-$1')).decode(bytes);
}

function hudCreatedProfile(bytes, encoding, shell, cliPath) {
  const text = profileText(bytes, encoding);
  for (const match of text.matchAll(/^# >>> agy-hud ([a-f0-9]{16}) >>>(\r?\n)# agy-hud: created this startup profile\r?$/gmu)) {
    const [, marker, eol] = match;
    const block = profileBlock(shell, marker, eol, true, cliPath);
    if (text.startsWith(block, match.index) && bytes.includes(encode(block, encoding))) {
      return true;
    }
  }
  return false;
}

function recordFor(target, file, marker, cliPath) {
  const bytes = file?.bytes ?? Buffer.alloc(0);
  const encoding = profileEncoding(bytes);
  const eol = target.shell === 'powershell' && (!file || bytes.includes(encode('\r\n', encoding))) ? '\r\n' : '\n';
  const skippedBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : encoding === 'utf8' ? 0 : 2;
  // Each installer owns its separator, so removing one of two blocks leaves the other separated.
  const addedSeparator = bytes.length > skippedBom;
  const created = !file || hudCreatedProfile(bytes, encoding, target.shell, cliPath);
  const block = profileBlock(target.shell, marker, eol, created, cliPath);
  return { ...target, encoding, eol, block, addedSeparator, created };
}

function findBlock(record, bytes, marker) {
  let match;
  for (const text of new Set([record.block, record.priorBlock])) {
    if (text === undefined) continue;
    const block = encode(text, record.encoding);
    const start = bytes.indexOf(block);
    if (start < 0) continue;
    if (match || bytes.indexOf(block, start + block.length) >= 0) {
      throw new Error('Multiple copies of the AGY HUD block were found.');
    }
    match = { text, start, finish: start + block.length };
  }
  const encodings = new Set([record.encoding, profileEncoding(bytes)]);
  const remaining = match ? [bytes.subarray(0, match.start), bytes.subarray(match.finish)] : [bytes];
  for (const encoding of encodings) {
    const start = encode(startMarker(marker), encoding);
    const end = encode(endMarker(marker), encoding);
    if (remaining.some((part) => part.includes(start) || part.includes(end))) {
      throw new Error('The AGY HUD block has been edited.');
    }
  }
  return match;
}

function applyProfile(record, previous, match, installing, pending, platform) {
  const bytes = previous?.bytes ?? Buffer.alloc(0);
  const block = encode(record.block, record.encoding);
  const separator = encode(record.eol, record.encoding);
  if (installing) {
    if (match?.text === record.block) return false;
    const before = match ? bytes.subarray(0, match.start) : bytes;
    const after = match ? bytes.subarray(match.finish) : Buffer.alloc(0);
    const prefix = !match && record.addedSeparator ? separator : Buffer.alloc(0);
    publish(record.path, Buffer.concat([before, prefix, block, after]), previous, pending, platform);
    return true;
  }
  if (!match) return false;

  const { start, finish } = match;
  const boundary = start - separator.length;
  const precededBySeparator = bytes.subarray(boundary, start).equals(separator);
  const newline = encode('\n', record.encoding);
  const hasPreviousSeparator = boundary >= newline.length
    && bytes.subarray(boundary - newline.length, boundary).equals(newline);
  const after = bytes.subarray(finish);
  const hasNextSeparator = ['\n', '\r\n'].some((eol) => {
    const next = encode(eol, record.encoding);
    return after.subarray(0, next.length).equals(next);
  });
  const before = record.addedSeparator && precededBySeparator && (!after.length || hasNextSeparator || hasPreviousSeparator)
    ? boundary
    : start;
  const remaining = Buffer.concat([bytes.subarray(0, before), after]);
  if (record.created && !remaining.length) {
    sameFile(record.path, previous);
    fs.unlinkSync(record.path);
  } else {
    publish(record.path, remaining, previous, pending, platform);
  }
  return true;
}

export function updateShellIntegration(configDir, command, env = process.env, options = {}) {
  if (command !== 'install' && command !== 'uninstall') {
    throw new Error(`Unsupported shell integration command: ${command}`);
  }
  const platform = options.platform || process.platform;
  const manifestPath = join(configDir, MANIFEST_NAME);
  const marker = markerId(configDir, platform);
  const entries = new Map();
  const configured = [];
  const removed = [];
  const skipped = [];

  const warn = (file, error) => {
    skipped.push({ file, reason: error.message });
    console.warn(`agy-hud: shell integration skipped for ${file}. ${error.message}`);
  };

  const save = () => {
    const previous = inspect(manifestPath);
    if (!entries.size) {
      if (previous) fs.unlinkSync(manifestPath);
    } else {
      fs.mkdirSync(configDir, { recursive: true });
      const next = Buffer.from(`${JSON.stringify({ version: 1, entries: [...entries.values()] })}\n`);
      if (!previous?.bytes.equals(next)) publish(manifestPath, next, previous, undefined, platform);
    }
  };

  try {
    for (const entry of readRecords(manifestPath, marker)) {
      entries.set(entry.path, entry);
    }
    const installing = command === 'install' && env.AGY_HUD_SHELL !== 'none';
    const profiles = installing ? targets(env, options) : [...entries.values()];
    for (const target of profiles) {
      try {
        if (installing) {
          fs.mkdirSync(dirname(target.path), { recursive: true });
        } else if (!fs.lstatSync(dirname(target.path), { throwIfNoEntry: false })) {
          entries.delete(target.path);
          continue;
        }
        withProfileTicket(target.path, (pending) => {
          const previous = inspect(target.path);
          const known = entries.get(target.path);
          let record = known ?? recordFor(target, previous, marker, options.cliPath);
          const match = findBlock(record, previous?.bytes ?? Buffer.alloc(0), marker);
          if (installing) {
            if (match) {
              const created = record.created || hudCreatedProfile(previous.bytes, record.encoding, target.shell, options.cliPath);
              const block = profileBlock(target.shell, marker, record.eol, created, options.cliPath);
              record = {
                ...record,
                block,
                created,
                addedSeparator: known?.addedSeparator ?? false,
                priorBlock: match.text !== block ? match.text : undefined,
              };
            } else {
              record = recordFor(target, previous, marker, options.cliPath);
            }
            entries.set(target.path, record);
          }
          let changed;
          try {
            if (installing) {
              // Either version can be present if installation was interrupted at the rename.
              save();
            }
            changed = applyProfile(record, previous, match, installing, pending, platform);
          } catch (error) {
            if (installing) {
              if (known) entries.set(target.path, known);
              else entries.delete(target.path);
            }
            throw error;
          }
          if (installing) {
            delete record.priorBlock;
            configured.push({ path: target.path, shell: target.shell, changed });
          } else {
            entries.delete(target.path);
            if (changed) removed.push(target.path);
          }
        }, platform);
      } catch (error) {
        warn(target.path, error);
      }
    }
    save();
  } catch (error) {
    warn(manifestPath, error);
  }

  return {
    command,
    shell: configured[0]?.shell ?? null,
    configured,
    removed,
    skipped,
    manifestPath,
  };
}

export function configuredShell(configDir, env = process.env, options = {}) {
  try {
    const platform = options.platform || process.platform;
    const profiles = targets(env, options);
    if (!profiles.length) return undefined;
    const marker = markerId(configDir, platform);
    const records = readRecords(join(configDir, MANIFEST_NAME), marker);
    const configured = profiles.every(({ path: filePath, shell }) => {
      const record = records.find((entry) => entry.path === filePath && entry.shell === shell);
      const file = record && inspect(filePath);
      if (!file) return false;
      const block = profileBlock(shell, marker, record.eol, record.created, options.cliPath);
      return record.block === block && findBlock(record, file.bytes, marker)?.text === block;
    });
    if (configured) return profiles[0].shell;
  } catch {
    // A missing or changed profile must not activate the launcher in the current shell.
  }
  return undefined;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (import.meta.main ?? invokedDirectly()) {
  const [, , action, shell] = process.argv;
  if (action === 'init' && KINDS.has(shell)) {
    const cli = fileURLToPath(new URL('./bin/agy-hud.js', import.meta.url));
    process.stdout.write(shellInit(shell, cli));
  } else if (action === 'activate' && !shell) {
    const derivedRoot = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
    let configDir = derivedRoot;
    if (!fs.existsSync(join(configDir, MANIFEST_NAME))) {
      const { getAntigravityRoots } = await import('./paths.mjs');
      const found = getAntigravityRoots(process.env).find((root) => fs.existsSync(join(root, MANIFEST_NAME)));
      if (found) configDir = found;
    }
    const configured = configuredShell(configDir, process.env);
    if (configured === 'bash' || configured === 'zsh') {
      process.stdout.write(shellInit(configured));
    } else if (process.env.AGY_HUD_SHELL !== 'none') {
      console.error('agy-hud: No managed startup file matches this shell. Run the installer or invoke runtime/bin/agy-hud.js launch directly.');
      process.exitCode = 1;
    }
  } else if (action === 'launch') {
    // PowerShell 5.1's native argument handling loses literal quotes and empty arguments.
    const data = process.env.AGY_HUD_SHELL_ARGS;
    delete process.env.AGY_HUD_SHELL_ARGS;
    try {
      let args;
      try {
        args = JSON.parse(data);
      } catch {
        throw new Error('Invalid launcher arguments.');
      }
      if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
        throw new Error('Invalid launcher arguments.');
      }
      const { launchAgy } = await import('./launch.mjs');
      const code = await launchAgy(args);
      if (typeof code === 'number') process.exitCode = code;
    } catch (error) {
      console.error(`agy-hud: ${String(error?.message ?? error).replace(/[\p{Cc}\p{Cf}]/gu, ' ')}`);
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: node runtime/shell.mjs init bash|zsh|powershell | activate | launch');
    process.exitCode = 1;
  }
}
