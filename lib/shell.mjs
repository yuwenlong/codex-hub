import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestName = '.codex-hud-shell.json';
const kinds = new Set(['bash', 'zsh', 'powershell']);
const basenames = new Set(['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', 'profile.ps1']);
const profileLimit = 4 * 1024 * 1024;
const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const ticketName = /^([1-9]\d{0,9})-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;
const wake = new Int32Array(new SharedArrayBuffer(4));
export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const posixLaunch = 'command env "CODEX_HOME=${CODEX_HOME:-${HOME-}/.codex}" ';

function powershellLiteral(value) {
  if (/^[\x20-\x7e]*$/u.test(value)) return "'" + value.replaceAll("'", "''") + "'";
  // PowerShell 5.1 can read an existing profile in an ANSI code page.
  return "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(value).toString('base64') + "'))";
}

export function shellInit(shell, cli) {
  if (!kinds.has(shell)) throw new Error('Unsupported shell: ' + shell);
  if (shell === 'powershell') {
    const pathLines = cli ? ['        $codexHudHelper = ' + powershellLiteral(join(dirname(dirname(cli)), 'lib', 'shell.mjs'))] : [
      '        $codexHudRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
      '        $codexHudHelper = Join-Path $codexHudRoot "codex-hud/lib/shell.mjs"',
    ];
    return [
      'if (-not (Get-Command codex -CommandType Alias,Function -ErrorAction SilentlyContinue)) {',
      '    function global:codex {',
      '        $codexHudPipeline = $MyInvocation.ExpectingInput',
      ...pathLines,
      '        $codexHudNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
      '        if (-not $codexHudPipeline -and $env:CODEX_HUD_BYPASS -ne "1" -and $env:TERM -ne "dumb" -and',
      '            -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected -and',
      '            $codexHudNode -and (Test-Path -LiteralPath $codexHudHelper -PathType Leaf)) {',
      '            $codexHudArguments = ConvertTo-Json -InputObject @($args | ForEach-Object { [string]$_ }) -Compress',
      '            if ($codexHudArguments.Length -lt 30000) {',
      '                $codexHudPrevious = $env:CODEX_HUD_SHELL_ARGS',
      '                try {',
      '                    $env:CODEX_HUD_SHELL_ARGS = $codexHudArguments',
      '                    & $codexHudNode.Source $codexHudHelper launch',
      '                } finally { $env:CODEX_HUD_SHELL_ARGS = $codexHudPrevious }',
      '                return',
      '            }',
      '        }',
      '        $codexHudNative = Get-Command codex -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1',
      '        if ($codexHudPipeline) {',
      '            $input | & $codexHudNative @args',
      '        } else {',
      '            & $codexHudNative @args',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
  }
  const definition = [
    'codex() {',
    '  local codex_hud_cli=' + (cli ? shellQuote(cli) : '"${CODEX_HOME:-${HOME-}/.codex}/codex-hud/bin/codex-hud.mjs"'),
    '  if [ -t 0 ] && [ -t 1 ] && [ "${TERM-}" != dumb ] && [ "${CODEX_HUD_BYPASS-}" != 1 ] &&',
    '     [ -f "$codex_hud_cli" ] && [ -f "${codex_hud_cli%/bin/codex-hud.mjs}/lib/launch.mjs" ] &&',
    '     command -v node >/dev/null 2>&1; then',
    `    ${posixLaunch}node "$codex_hud_cli" launch -- "$@"`,
    '  else',
    `    ${posixLaunch}codex "$@"`,
    '  fi',
    '}',
  ].join('\n');
  // The same outer guard must parse in POSIX sh when Bash uses ~/.profile.
  return [
    'if [ -n "${BASH_VERSION-}${ZSH_VERSION-}" ]; then',
    '  case "$-" in',
    '    *i*)',
    '      if ! alias codex >/dev/null 2>&1 && ! typeset -f codex >/dev/null 2>&1; then',
    '        eval ' + shellQuote(definition),
    '      fi ;;',
    '  esac',
    'fi',
    '',
  ].join('\n');
}

function targets(env) {
  const choice = env.CODEX_HUD_SHELL || (env.CODEX_HUD_PS_PROFILE || process.platform === 'win32'
    ? 'powershell' : basename(env.SHELL || 'bash'));
  if (choice === 'powershell') {
    const path = env.CODEX_HUD_PS_PROFILE;
    return path && isAbsolute(path) && basename(path).toLowerCase() === 'profile.ps1'
      ? [{ path: resolve(path), shell: choice }] : [];
  }
  const root = env.HOME || homedir();
  if (choice === 'zsh') return [{ path: resolve(root, env.ZDOTDIR || '.', '.zshrc'), shell: choice }];
  if (choice === 'bash') {
    const login = ['.bash_profile', '.bash_login', '.profile']
      .map(name => resolve(root, name)).find(path => lstatSync(path, { throwIfNoEntry: false }));
    return [{ path: resolve(root, '.bashrc'), shell: choice }, { path: login || resolve(root, '.profile'), shell: choice }];
  }
  return [];
}

function inspect(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.size > profileLimit) throw new Error('Not a regular startup file of supported size.');
  return { bytes: readFileSync(path, { flag: noFollow }), mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
}

function sameFile(path, previous) {
  const actual = inspect(path);
  if (!actual && !previous) return;
  if (!actual || !previous || actual.dev !== previous.dev || actual.ino !== previous.ino
    || !actual.bytes.equals(previous.bytes)) throw new Error('The startup file changed during installation.');
}

function publish(path, bytes, previous, tmp = join(dirname(path), '.codex-hud-' + randomUUID() + '.tmp')) {
  const fd = openSync(tmp, 'wx', previous?.mode ?? 0o600);
  try {
    try {
      if (previous && process.platform !== 'win32') fchmodSync(fd, previous.mode);
      writeFileSync(fd, bytes, { flush: true });
    } finally {
      closeSync(fd);
    }
    sameFile(path, previous);
    if (previous) renameSync(tmp, path);
    else linkSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function removeTicket(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function otherTickets(queue, owner) {
  const peers = [];
  for (const file of readdirSync(queue)) {
    const name = file.replace(/\.pending$/u, '');
    const match = ticketName.exec(name);
    if (!match || name === owner) continue;
    const path = join(queue, name);
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        removeTicket(path + '.pending');
        removeTicket(path);
        continue;
      }
      if (error.code !== 'EPERM') throw error;
    }
    if (file !== name) continue;
    let number;
    try { number = readFileSync(path, { encoding: 'utf8', flag: noFollow }); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (number && !/^[1-9]\d{0,14}$/u.test(number)) throw new Error('Invalid startup profile ticket.');
    peers.push({ name, number: Number(number) });
  }
  return peers;
}

function withProfileTicket(profile, action) {
  const file = basename(profile);
  const queue = join(realpathSync(dirname(profile)), (process.platform === 'win32' ? file.toLowerCase() : file) + '.codex-hud-tickets');
  const owner = process.pid + '-' + randomUUID();
  const path = join(queue, owner);
  const pending = path + '.pending';
  const deadline = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(queue, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const folder = lstatSync(queue, { throwIfNoEntry: false });
    if (!folder && Date.now() < deadline) continue;
    if (!folder?.isDirectory()) {
      throw new Error('The startup profile lock is not a regular directory.');
    }
    try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); break; } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
    }
  }
  try {
    // Lamport's bakery lock. An empty ticket announces that its owner is choosing a number.
    const number = Math.max(0, ...otherTickets(queue, owner).map(peer => peer.number)) + 1;
    if (number >= 1e15) throw new Error('Startup profile ticket limit reached.');
    publish(path, Buffer.from(String(number)), inspect(path), pending);
    while (otherTickets(queue, owner).some(peer =>
      !peer.number || peer.number < number || (peer.number === number && peer.name < owner))) {
      if (Date.now() >= deadline) throw new Error('Another installation is changing this startup profile.');
      Atomics.wait(wake, 0, 0, 20);
    }
    return action(pending);
  } finally {
    removeTicket(pending);
    removeTicket(path);
    try { rmdirSync(queue); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
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

function markerId(home) {
  return createHash('sha256').update(process.platform === 'win32' ? home.toLowerCase() : home).digest('hex').slice(0, 16);
}

const startMarker = marker => '# >>> codex-hud ' + marker + ' >>>';
const endMarker = marker => '# <<< codex-hud ' + marker + ' <<<';
const createdProfileComment = '# codex-hud: created this startup profile';

function readRecords(path, marker) {
  const previous = inspect(path);
  if (!previous) return [];
  const data = JSON.parse(previous.bytes.toString('utf8'));
  const validBlock = (block, eol) => typeof block === 'string'
    && block.startsWith(startMarker(marker) + eol) && block.endsWith(endMarker(marker) + eol);
  if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 32 || data.entries.some(entry => {
    return !entry || typeof entry.path !== 'string' || !isAbsolute(entry.path)
      || !basenames.has(basename(entry.path).toLowerCase()) || !kinds.has(entry.shell)
      || !['utf8', 'utf16le', 'utf16be'].includes(entry.encoding) || !['\n', '\r\n'].includes(entry.eol)
      || typeof entry.addedSeparator !== 'boolean' || typeof entry.created !== 'boolean'
      || !validBlock(entry.block, entry.eol)
      || (entry.priorBlock !== undefined && !validBlock(entry.priorBlock, entry.eol));
  })) throw new Error('Invalid Codex HUD shell integration record.');
  return data.entries;
}

function profileBlock(shell, marker, eol, created) {
  const header = created ? [startMarker(marker), createdProfileComment] : [startMarker(marker)];
  return [...header, shellInit(shell).trimEnd(), endMarker(marker), ''].join('\n').replaceAll('\n', eol);
}

function profileText(bytes, encoding) {
  return new TextDecoder(encoding.replace(/^utf(8|16)/u, 'utf-$1')).decode(bytes);
}

function assertNoLegacyBlock(path, file) {
  if (!file) return;
  const { bytes } = file;
  const marker = /^[ \t]*# (?:>>> codex-hub [a-f0-9]{16} >>>|<<< codex-hub [a-f0-9]{16} <<<)[ \t]*\r?$/mu;
  if (marker.test(profileText(bytes, profileEncoding(bytes)))) {
    throw new Error('A Codex Hub launcher block remains in ' + path + '. See the migration steps in the README.');
  }
}

export function assertNoLegacyShellIntegration(env = process.env) {
  let profiles;
  try { profiles = targets(env); } catch { return; }
  for (const { path } of profiles) {
    let file;
    try { file = inspect(path); } catch { continue; }
    assertNoLegacyBlock(path, file);
  }
}

function hudCreatedProfile(bytes, encoding, shell) {
  const text = profileText(bytes, encoding);
  // Only inherit the origin from a complete, recognized HUD block.
  for (const match of text.matchAll(/^# >>> codex-hud ([a-f0-9]{16}) >>>(\r?\n)# codex-hud: created this startup profile\r?$/gmu)) {
    const [, marker, eol] = match;
    const current = profileBlock(shell, marker, eol, true);
    const blocks = shell === 'powershell' ? [current] : [current, current.replaceAll(posixLaunch, 'command ')];
    if (blocks.some(block => text.startsWith(block, match.index) && bytes.includes(encode(block, encoding)))) return true;
  }
  return false;
}

function recordFor(target, file, marker) {
  const bytes = file?.bytes ?? Buffer.alloc(0);
  const encoding = profileEncoding(bytes);
  const eol = target.shell === 'powershell' && (!file || bytes.includes(encode('\r\n', encoding))) ? '\r\n' : '\n';
  const skippedBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : encoding === 'utf8' ? 0 : 2;
  // Each installer owns its separator, so removing one of two blocks leaves the other separated.
  const addedSeparator = bytes.length > skippedBom;
  const created = !file || hudCreatedProfile(bytes, encoding, target.shell);
  const block = profileBlock(target.shell, marker, eol, created);
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
      throw new Error('Multiple copies of the Codex HUD block were found.');
    }
    match = { text, start, finish: start + block.length };
  }
  const encodings = new Set([record.encoding, profileEncoding(bytes)]);
  const remaining = match ? [bytes.subarray(0, match.start), bytes.subarray(match.finish)] : [bytes];
  for (const encoding of encodings) {
    const start = encode(startMarker(marker), encoding);
    const end = encode(endMarker(marker), encoding);
    if (remaining.some(part => part.includes(start) || part.includes(end))) {
      throw new Error('The Codex HUD block has been edited.');
    }
  }
  return match;
}

function applyProfile(record, previous, match, installing, pending) {
  const bytes = previous?.bytes ?? Buffer.alloc(0);
  const block = encode(record.block, record.encoding);
  const separator = encode(record.eol, record.encoding);
  if (installing) {
    if (match?.text === record.block) return;
    const before = match ? bytes.subarray(0, match.start) : bytes;
    const after = match ? bytes.subarray(match.finish) : Buffer.alloc(0);
    const prefix = !match && record.addedSeparator ? separator : Buffer.alloc(0);
    publish(record.path, Buffer.concat([before, prefix, block, after]), previous, pending);
  } else if (match) {
    const { start, finish } = match;
    const boundary = start - separator.length;
    const precededBySeparator = bytes.subarray(boundary, start).equals(separator);
    const newline = encode('\n', record.encoding);
    const hasPreviousSeparator = boundary >= newline.length
      && bytes.subarray(boundary - newline.length, boundary).equals(newline);
    const after = bytes.subarray(finish);
    const hasNextSeparator = ['\n', '\r\n'].some(eol => {
      const next = encode(eol, record.encoding);
      return after.subarray(0, next.length).equals(next);
    });
    const before = record.addedSeparator && precededBySeparator && (!after.length || hasNextSeparator || hasPreviousSeparator)
      ? boundary : start;
    const remaining = Buffer.concat([bytes.subarray(0, before), after]);
    if (record.created && !remaining.length) {
      sameFile(record.path, previous);
      unlinkSync(record.path);
    } else {
      publish(record.path, remaining, previous, pending);
    }
  }
}

export function updateShellIntegration(home, command, env = process.env) {
  const manifest = join(home, manifestName);
  const marker = markerId(home);
  const entries = new Map();
  const warn = (file, error) => console.warn('codex-hud: shell integration skipped for ' + file + '. ' + error.message);
  const save = () => {
    const previous = inspect(manifest);
    if (!entries.size) {
      if (previous) unlinkSync(manifest);
    } else {
      const next = Buffer.from(JSON.stringify({ version: 1, entries: [...entries.values()] }) + '\n');
      if (!previous?.bytes.equals(next)) publish(manifest, next, previous);
    }
  };
  try {
    for (const entry of readRecords(manifest, marker)) entries.set(entry.path, entry);
    const installing = command === 'install' && env.CODEX_HUD_SHELL !== 'none';
    const profiles = installing ? targets(env) : [...entries.values()];
    for (const target of profiles) {
      try {
        if (installing && target.shell === 'powershell') mkdirSync(dirname(target.path), { recursive: true });
        if (!installing && !lstatSync(dirname(target.path), { throwIfNoEntry: false })) {
          entries.delete(target.path);
          continue;
        }
        withProfileTicket(target.path, pending => {
          const previous = inspect(target.path);
          if (installing) assertNoLegacyBlock(target.path, previous);
          const known = entries.get(target.path);
          let record = known ?? recordFor(target, previous, marker);
          const match = findBlock(record, previous?.bytes ?? Buffer.alloc(0), marker);
          if (installing) {
            if (match) {
              const created = record.created || hudCreatedProfile(previous.bytes, record.encoding, target.shell);
              const block = profileBlock(target.shell, marker, record.eol, created);
              record = { ...record, block, created, addedSeparator: known?.addedSeparator ?? false,
                priorBlock: match.text !== block ? match.text : undefined };
            } else {
              record = recordFor(target, previous, marker);
            }
            entries.set(target.path, record);
            try {
              // Either version can be present if installation was interrupted at the rename.
              save();
            } catch (error) {
              if (known) entries.set(target.path, known);
              else entries.delete(target.path);
              throw error;
            }
          }
          applyProfile(record, previous, match, installing, pending);
          if (installing) delete record.priorBlock;
          else entries.delete(target.path);
        });
      } catch (error) { warn(target.path, error); }
    }
    save();
  } catch (error) { warn(manifest, error); }
}

export function configuredShell(home, env = process.env) {
  try {
    const profiles = targets(env);
    if (!profiles.length) return;
    const marker = markerId(home);
    const records = readRecords(join(home, manifestName), marker);
    const configured = profiles.every(({ path, shell }) => {
      const record = records.find(entry => entry.path === path && entry.shell === shell);
      const file = record && inspect(path);
      if (!file) return false;
      const block = profileBlock(shell, marker, record.eol, record.created);
      return record.block === block && findBlock(record, file.bytes, marker)?.text === block;
    });
    if (configured) return profiles[0].shell;
  } catch {
    // A missing or changed profile must not activate the launcher in the current shell.
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (import.meta.main ?? invokedDirectly()) {
  const [, , action, shell] = process.argv;
  if (action === 'init' && kinds.has(shell)) {
    const cli = fileURLToPath(new URL('../bin/codex-hud.mjs', import.meta.url));
    process.stdout.write(shellInit(shell, cli));
  } else if (action === 'activate' && !shell) {
    const configured = configuredShell(realpathSync(fileURLToPath(new URL('../../', import.meta.url))));
    if (configured === 'bash' || configured === 'zsh') {
      process.stdout.write(shellInit(configured));
    } else if (process.env.CODEX_HUD_SHELL !== 'none') {
      console.error('codex-hud: No managed startup file matches this shell. Use the current README installer or the explicit launcher.');
      process.exitCode = 1;
    }
  } else if (action === 'launch') {
    // PowerShell 5.1's native argument handling loses literal quotes and empty arguments.
    const data = process.env.CODEX_HUD_SHELL_ARGS;
    delete process.env.CODEX_HUD_SHELL_ARGS;
    try {
      let args;
      try { args = JSON.parse(data); } catch { throw new Error('Invalid launcher arguments.'); }
      if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Invalid launcher arguments.');
      const { launchCodex } = await import('./launch.mjs');
      process.exitCode = await launchCodex(args);
    } catch (error) {
      console.error('codex-hud: ' + error.message.replace(/[\p{Cc}\p{Cf}]/gu, ' '));
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: node lib/shell.mjs init bash|zsh|powershell | activate');
    process.exitCode = 1;
  }
}
