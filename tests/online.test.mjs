import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { shellInit } from '../lib/shell.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const rawBase = 'https://raw.githubusercontent.com/yuwenlong/codex-hud/main';
const legacyRelease = 'https://github.com/yuwenlong/codex-hud/releases/download/v0.2.6/codex-hub.zip';
const legacyChecksum = '27827ac50e32e7752096e64ffb4133f0d2feb26c9481801c08147c46ffb613da';
const bashOnly = { skip: process.platform === 'win32' };
const marker = '.codex-hud-managed';
const transaction = '.codex-hud-transaction.json';
const ownership = 'codex-hud-runtime-v1\n';
const manifest = `${ownership}package.json\nLICENSE\nbin/codex-hud.mjs\nscripts/manage.mjs\nlib/activity.mjs\nlib/app-server.mjs\nlib/installation.mjs\n`;
const manager = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(process.argv.slice(1)) + '\\n');
process.exit(Number(process.env.FIXTURE_STATUS ?? 0));
`;

function managedRuntime(home) {
  const runtime = join(home, 'codex-hud');
  for (const name of manifest.trim().split('\n').slice(1)) {
    const path = join(runtime, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, name === 'scripts/manage.mjs' ? manager : '');
  }
  writeFileSync(join(runtime, marker), manifest);
  return runtime;
}

function readmeCommand(snippet, readme = 'README.md') {
  const docs = readFileSync(new URL(`../${readme}`, import.meta.url), 'utf8');
  const command = [...docs.matchAll(/^```bash\r?\n([\s\S]*?)\r?\n```$/gmu)]
    .find(([, body]) => body.includes(snippet))?.[1];
  assert.ok(command, `Missing Bash command in ${readme}`);
  return command;
}

async function fixture(t, { managedShell = false, legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-hud online 中文 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const temp = join(root, 'temp');
  const home = join(root, '.codex');
  const release = join(root, 'release');
  for (const path of [bin, temp, home, join(release, 'scripts')]) mkdirSync(path, { recursive: true });
  if (managedShell) {
    mkdirSync(join(release, 'lib'));
    copyFileSync(new URL('../lib/shell.mjs', import.meta.url), join(release, 'lib', 'shell.mjs'));
    copyFileSync(new URL('../scripts/activate.sh', import.meta.url), join(release, 'scripts', 'activate.sh'));
  }
  writeFileSync(join(release, 'scripts', 'manage.mjs'), managedShell ? `
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateShellIntegration } from '../lib/shell.mjs';
const home = realpathSync(process.env.CODEX_HOME || join(process.env.HOME, '.codex'));
const runtime = join(home, 'codex-hud');
for (const part of ['lib', 'bin', 'scripts']) mkdirSync(join(runtime, part), { recursive: true });
copyFileSync(new URL('../lib/shell.mjs', import.meta.url), join(runtime, 'lib', 'shell.mjs'));
copyFileSync(new URL('./activate.sh', import.meta.url), join(runtime, 'scripts', 'activate.sh'));
writeFileSync(join(runtime, 'lib', 'launch.mjs'), '');
writeFileSync(join(runtime, 'bin', 'codex-hud.mjs'), 'console.log("HUD " + import.meta.url + " " + JSON.stringify(process.argv.slice(2)) + " HOME " + JSON.stringify(process.env.CODEX_HOME));');
updateShellIntegration(home, 'install');
` : manager);
  const archiveName = legacy ? 'codex-hub' : 'codex-hud';
  const archive = join(root, archiveName + '.zip');
  const git = async (...args) => (await exec('git', args, { cwd: release })).stdout.trim();
  await git('init', '-q');
  await git('add', '.');
  await git('archive', '--format=zip', `--prefix=${archiveName}/`, '--output', archive, await git('write-tree'));

  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
args=()
if [[ -n "$FIXTURE_CURL_CALLS" ]]; then
  printf '%s\\0' "$@" '' >> "$FIXTURE_CURL_CALLS"
fi
partial=false
simulated=false
output=''
previous=''
retries=0
source_script=''
for arg; do
  if [[ "$previous" == -o ]]; then output="$arg"; fi
  if [[ "$previous" == --retry ]]; then retries="$arg"; fi
  case "$arg" in
    ${rawBase}/scripts/install.sh)
      source_script=${JSON.stringify(fileURLToPath(new URL('../scripts/install.sh', import.meta.url)))}
      arg="$FIXTURE_INSTALL_URL"
      ;;
    ${rawBase}/uninstall.sh)
      source_script=${JSON.stringify(fileURLToPath(new URL('../uninstall.sh', import.meta.url)))}
      arg="$FIXTURE_UNINSTALL_URL"
      ;;
    https://github.com/yuwenlong/codex-hud/releases/latest/download/codex-hud.zip) arg="$FIXTURE_ARCHIVE_URL" ;;
    ${legacyRelease}) arg="$FIXTURE_ARCHIVE_URL" ;;
  esac
  if [[ "$arg" == fixture:partial ]]; then partial=true; fi
  if [[ "$arg" == fixture:http ]]; then
    simulated=true
    arg="$FIXTURE_RESPONSE_URL"
  fi
  args+=("$arg")
  previous="$arg"
done
if "$partial"; then
  prefix='printf ran > "$CODEX_HOME/partial-ran"'
  if [[ -n "$source_script" ]]; then
    prefix="$(head -n 8 "$source_script")"$'\\n'"  $prefix"
  fi
  if [[ -n "$output" ]]; then printf '%s\\n' "$prefix" > "$output"; else printf '%s\\n' "$prefix"; fi
  exit 18
fi
if "$simulated"; then
  # Replay a curl transfer without opening a socket in the sandbox.
  IFS=, read -ra responses <<< "$FIXTURE_HTTP_SEQUENCE"
  attempt=0
  for status in "\${responses[@]}"; do
    printf '%s\\n' "$status" >> "$FIXTURE_HTTP_CALLS"
    if [[ "$status" == 200 ]]; then break; fi
    printf '%s' 'incomplete transfer' > "$output"
    if [[ "$status" != 503 || "$attempt" -ge "$retries" ]]; then exit 22; fi
    ((attempt += 1))
  done
fi
exec "$FIXTURE_CURL" "\${args[@]}"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'codex'), managedShell ? '#!/bin/sh\nprintf "NATIVE %s %s\\n" "$1" "$2"\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const log = join(root, 'calls');
  const curlLog = join(root, 'curl-calls');
  const env = {
    ...process.env,
    CODEX_HOME: home,
    HOME: root,
    PATH: [bin, process.env.PATH].join(delimiter),
    TMPDIR: temp,
    FIXTURE_ARCHIVE_URL: pathToFileURL(archive).href,
    FIXTURE_CALLS: log,
    FIXTURE_CURL_CALLS: curlLog,
    FIXTURE_HTTP_CALLS: join(root, 'http-calls'),
    FIXTURE_CURL: (await exec('bash', ['-c', 'command -v curl'])).stdout.trim(),
    FIXTURE_INSTALL_URL: new URL('../scripts/install.sh', import.meta.url).href,
    FIXTURE_UNINSTALL_URL: new URL('../uninstall.sh', import.meta.url).href,
  };
  async function launchCommand(command, overrides, shell = 'bash') {
    try {
      const args = shell.endsWith('/zsh') ? ['-f', '-c', command] : ['-c', command];
      const { stderr } = await exec(shell, args, {
        cwd: root, env: { ...env, ...overrides }, timeout: 20_000,
      });
      return { status: 0, stderr };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { status: error.code, stderr: error.stderr };
    }
  }
  return {
    archive, env, home, root, temp, launchCommand,
    launch(entry, overrides, readme = 'README.md') {
      const command = readmeCommand(`curl -fsSL ${rawBase}/${entry}`, readme);
      return launchCommand(command, overrides);
    },
    calls() {
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    },
    downloads() {
      if (!existsSync(curlLog)) return [];
      return readFileSync(curlLog, 'utf8').split('\0\0').slice(0, -1).map(call => call.split('\0'));
    },
  };
}

async function interactiveShell(shell, cwd, env, command) {
  const { spawn } = require('node-pty');
  const args = shell.endsWith('/bash') ? ['--noprofile', '--norc', '-ic'] : ['-fic'];
  const terminal = spawn(shell, [...args, command], { cwd, env, name: 'xterm-256color' });
  let output = '';
  const stream = terminal.onData(bytes => { output += bytes; });
  const status = await new Promise(resolve => {
    const timer = setTimeout(() => terminal.kill('SIGKILL'), 10000);
    terminal.onExit(result => {
      clearTimeout(timer);
      stream.dispose();
      resolve(result.exitCode);
    });
  });
  assert.equal(status, 0, output);
  return output;
}

for (const readme of ['README.md', 'README_zh.md']) {
  test(`${readme} migration runs the verified release manager and preserves an unmanaged namesake`, bashOnly, async t => {
    const run = await fixture(t, { legacy: true });
    const unmanaged = join(run.home, 'codex-hub', 'scripts', 'manage.mjs');
    mkdirSync(dirname(unmanaged), { recursive: true });
    writeFileSync(unmanaged, manager);
    const command = readmeCommand('/codex-hub/scripts/manage.mjs" uninstall', readme);
    for (const shell of ['/bin/bash', '/bin/zsh']) {
      if (!existsSync(shell)) continue;
      for (const guarded of [command, `if ${command}; then exit 0; else exit 1; fi`, `${command} || exit 1`]) {
        const changedArchive = await run.launchCommand(guarded, {}, shell);
        assert.equal(changedArchive.status, 1, `${shell} ran an unverified manager: ${changedArchive.stderr}`);
        assert.match(changedArchive.stderr, /SHA-256/u);
        assert.deepEqual(run.calls(), []);
      }
    }

    const checksum = createHash('sha256').update(readFileSync(run.archive)).digest('hex');
    const result = await run.launchCommand(command.replace(legacyChecksum, checksum));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(run.calls().length, 1);
    const [[script, action]] = run.calls();
    assert.equal(action, 'uninstall');
    assert.ok(script.startsWith(run.temp + '/') && script.endsWith('/codex-hub/scripts/manage.mjs'), script);
    assert.equal(readFileSync(unmanaged, 'utf8'), manager);
    assert.deepEqual(readdirSync(run.temp), []);
  });
}

test('Bash and Zsh online install commands activate Codex in the shell that ran them', { ...bashOnly, timeout: 25000 }, async t => {
  const readmes = [['/bin/bash', 'README.md'], ['/bin/zsh', 'README_zh.md']];
  const session = '12345678-1234-4321-9234-123456789012';
  const activate = '. "${CODEX_HOME:-$HOME/.codex}/codex-hud/scripts/activate.sh"';
  for (const [shell, readme] of readmes) {
    if (!existsSync(shell)) continue;
    const { root, env } = await fixture(t, { managedShell: true });
    const install = readmeCommand(`curl -fsSL ${rawBase}/scripts/install.sh`, readme);
    const bash = shell.endsWith('/bash');
    const zshConfig = join(root, 'zsh config');
    mkdirSync(zshConfig);
    const customHome = join(root, 'custom home');
    mkdirSync(customHome);
    const linkedHome = join(root, 'linked home');
    symlinkSync(customHome, linkedHome);
    const output = await interactiveShell(shell, root, {
      ...env, SHELL: bash ? '/bin/zsh' : '/bin/bash', CODEX_HUD_SHELL: '', FIXTURE_LINKED_HOME: linkedHome,
    }, `
      unset ZDOTDIR
      ZDOTDIR="$HOME/zsh config"
      readonly codex_hud_activation='user value'
      export codex_hud_activation
      unset CODEX_HOME
      CODEX_HOME="$FIXTURE_LINKED_HOME"
      codex before install
      ZDOTDIR="$ZDOTDIR" CODEX_HOME="$CODEX_HOME" ${install}
      ${activate}
      codex resume ${session}
      ZDOTDIR="$ZDOTDIR" CODEX_HOME="$CODEX_HOME" ${install}
      ${activate}
      codex after reinstall
      mkdir -p "$HOME/alternate home"
      cp -R "$CODEX_HOME/codex-hud" "$HOME/alternate home/"
      CODEX_HOME="$HOME/alternate home"
      codex switched home
      if printenv CODEX_HOME >/dev/null; then printf 'EXPORTED\\n'; fi
      printf 'KEPT %s\\n' "$codex_hud_activation"
      printf '\\nDONE\\n'
    `);
    assert.match(output, /NATIVE before install/u);
    const launcher = pathToFileURL(join(realpathSync(customHome), 'codex-hud', 'bin', 'codex-hud.mjs')).href;
    assert.ok(output.includes(`HUD ${launcher} ["launch","--","resume","${session}"] HOME ${JSON.stringify(linkedHome)}`), output);
    assert.ok(output.includes(`HUD ${launcher} ["launch","--","after","reinstall"] HOME ${JSON.stringify(linkedHome)}`), output);
    const alternateHome = join(root, 'alternate home');
    const alternate = pathToFileURL(join(realpathSync(alternateHome), 'codex-hud', 'bin', 'codex-hud.mjs')).href;
    assert.ok(output.includes(`HUD ${alternate} ["launch","--","switched","home"] HOME ${JSON.stringify(alternateHome)}`), output);
    assert.doesNotMatch(output, /EXPORTED/u);
    assert.equal(existsSync(join(root, '.codex', 'codex-hud')), false);
    assert.match(output, /KEPT user value/u);
    assert.match(output, /\bDONE\b/u);
    assert.ok(existsSync(bash ? join(root, '.bashrc') : join(zshConfig, '.zshrc')));
    assert.equal(existsSync(bash ? join(zshConfig, '.zshrc') : join(root, '.bashrc')), false);
  }
});

test('activation reports a legacy installation configured for a different shell', { ...bashOnly, timeout: 10000 }, async t => {
  const { env, root } = await fixture(t, { managedShell: true });
  const install = readmeCommand(`curl -fsSL ${rawBase}/scripts/install.sh`);
  const output = await interactiveShell('/bin/bash', root, { ...env, SHELL: '/bin/zsh', ZDOTDIR: root, CODEX_HUD_SHELL: '' }, `
    CODEX_HUD_SHELL=zsh ${install}
    . "$CODEX_HOME/codex-hud/scripts/activate.sh"
    printf 'ACTIVATION %s\\n' "$?"
    codex from bash
  `);
  assert.match(output, /current README installer.*explicit launcher/u);
  assert.match(output, /ACTIVATION 1/u);
  assert.match(output, /NATIVE from bash/u);
});

test('exporting a custom home also works with a launcher already loaded before upgrade', { ...bashOnly, timeout: 15000 }, async t => {
  const { env, root } = await fixture(t, { managedShell: true });
  const home = join(root, 'legacy custom home');
  mkdirSync(home);
  const oldProfile = join(root, 'legacy profile');
  const install = readmeCommand(`curl -fsSL ${rawBase}/scripts/install.sh`);
  for (const dialect of ['bash', 'zsh']) {
    const shell = `/bin/${dialect}`;
    if (!existsSync(shell)) continue;
    writeFileSync(oldProfile, shellInit(dialect).replaceAll('command env "CODEX_HOME=${CODEX_HOME:-${HOME-}/.codex}" ', 'command '));
    const output = await interactiveShell(shell, root, { ...env, SHELL: shell, ZDOTDIR: root, FIXTURE_OLD_PROFILE: oldProfile, FIXTURE_LEGACY_HOME: home }, `
      unset CODEX_HOME
      CODEX_HOME="$FIXTURE_LEGACY_HOME"
      . "$FIXTURE_OLD_PROFILE"
      CODEX_HOME="$CODEX_HOME" ${install}
      codex before-export
      export CODEX_HOME
      codex after-export
    `);
    assert.match(output, /\["launch","--","before-export"\] HOME undefined/u);
    assert.ok(output.includes(`["launch","--","after-export"] HOME ${JSON.stringify(home)}`), output);
  }
});

test('online activation preserves custom shell commands and honors skipped integration', { ...bashOnly, timeout: 25000 }, async t => {
  const shell = '/bin/bash';
  const run = await fixture(t, { managedShell: true });
  const env = { ...run.env, SHELL: shell, CODEX_HUD_SHELL: '' };
  const install = readmeCommand(`curl -fsSL ${rawBase}/scripts/install.sh`);
  const activate = '. "${CODEX_HOME:-$HOME/.codex}/codex-hud/scripts/activate.sh"';
  const custom = await interactiveShell(shell, run.root, env, `
    codex() { printf 'CUSTOM %s\\n' "$1"; }
    ${install}
    ${activate}
    codex existing-function
    unset -f codex
    alias codex='printf "CUSTOM ALIAS\\n"'
    ${install}
    ${activate}
    eval 'codex'
    unalias codex
    codex still native
  `);
  assert.match(custom, /CUSTOM existing-function/u);
  assert.match(custom, /CUSTOM ALIAS/u);
  assert.match(custom, /NATIVE still native/u);

  const noIntegration = await interactiveShell(shell, run.root, { ...env, CODEX_HUD_SHELL: 'none' },
    `${install}\n${activate}\ncodex opted out`);
  assert.match(noIntegration, /NATIVE opted out/u);
  const failed = await interactiveShell(shell, run.root, { ...env, FIXTURE_ARCHIVE_URL: 'fixture:partial' },
    `${install} && ${activate}\ncodex after failure`);
  assert.match(failed, /NATIVE after failure/u);
  assert.equal(existsSync(join(run.home, 'partial-ran')), false);
  const startup = join(run.root, '.bashrc');
  writeFileSync(startup, 'export CODEX_HUD_TEST_PROFILE=untouched\n');
  const edited = await interactiveShell(shell, run.root, env, `
    ${install}
    ${activate}
    unset -f codex
    node -e 'const fs = require("fs"); const p = process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("launch --", "launch -- edited"))' "$HOME/.bashrc"
    ${install}
    ${activate}
    codex after conflict
    printf '%s\\n' "\${CODEX_HUD_TEST_PROFILE-unread}"
  `);
  assert.match(edited, /NATIVE after conflict/u);
  assert.match(edited, /\bunread\b/u);
  assert.match(readFileSync(startup, 'utf8'), /launch -- edited/u);

  const activatePath = join(run.home, 'codex-hud', 'scripts', 'activate.sh');
  writeFileSync(join(run.home, 'codex-hud', 'lib', 'shell.mjs'), `
    process.stdout.write('codex() { printf "PARTIAL\\\\n"; }\\n');
    process.exitCode = 9;
  `);
  const partialActivation = await interactiveShell(shell, run.root, { ...env, FIXTURE_ACTIVATE: activatePath },
    '. "$FIXTURE_ACTIVATE"\ncode=$?\nprintf "ACTIVATE %s\\n" "$code"\ncodex after partial');
  assert.match(partialActivation, /ACTIVATE 1/u);
  assert.match(partialActivation, /NATIVE after partial/u);
});

test('Bash README commands skip missing and empty entry scripts and reject truncated ones', bashOnly, async t => {
  const run = await fixture(t);
  const empty = join(run.root, 'empty.sh');
  writeFileSync(empty, '');
  const missing = pathToFileURL(join(run.root, 'missing.sh')).href;
  const emptyUrl = pathToFileURL(empty).href;
  for (const readme of ['README.md', 'README_zh.md']) {
    for (const entry of ['scripts/install.sh', 'uninstall.sh']) {
      const entryUrl = entry === 'uninstall.sh' ? 'FIXTURE_UNINSTALL_URL' : 'FIXTURE_INSTALL_URL';
      for (const url of [missing, emptyUrl]) {
        await run.launch(entry, { [entryUrl]: url }, readme);
        assert.equal(existsSync(join(run.home, 'partial-ran')), false);
        assert.deepEqual(readdirSync(run.home), []);
        assert.deepEqual(readdirSync(run.temp), []);
      }
      const truncated = await run.launch(entry, { [entryUrl]: 'fixture:partial' }, readme);
      assert.notEqual(truncated.status, 0, `${readme} ${entry} accepted truncated stream`);
      assert.equal(existsSync(join(run.home, 'partial-ran')), false);
      assert.deepEqual(readdirSync(run.home), []);
      assert.deepEqual(readdirSync(run.temp), []);
    }
  }
  assert.deepEqual(run.calls(), []);
});

test('Bash online install runs the manager from a release ZIP and cleans up', bashOnly, async t => {
  const run = await fixture(t);
  const result = await run.launch('scripts/install.sh');
  assert.equal(result.status, 0, result.stderr);
  const [[script, action]] = run.calls();
  assert.equal(action, 'install');
  assert.ok(script.startsWith(`${run.temp}/`) && script.endsWith('/codex-hud/scripts/manage.mjs'), script);
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash online recovery enables bounded curl retries with replaceable output files', bashOnly, async t => {
  const run = await fixture(t);
  writeFileSync(join(run.home, transaction), '{}');
  assert.equal((await run.launch('uninstall.sh')).status, 0);
  const [, bootstrap, archive] = run.downloads();
  for (const args of [bootstrap, archive]) {
    assert.equal(args[args.indexOf('--retry') + 1], '3');
    assert.ok(args.includes('--retry-connrefused'));
    assert.ok(args.includes('--retry-max-time') && args.includes('--max-time'));
    assert.ok(args.includes('-o') && args[args.indexOf('-o') + 1].startsWith(`${run.temp}/`));
  }
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash uninstall recovery discards a truncated bootstrap before it can run', bashOnly, async t => {
  const run = await fixture(t);
  const config = join(run.home, 'config.toml');
  writeFileSync(config, 'unchanged\n');
  writeFileSync(join(run.home, transaction), '{}');
  const result = await run.launch('uninstall.sh', { FIXTURE_INSTALL_URL: 'fixture:partial' });
  assert.equal(result.status, 18);
  assert.equal(existsSync(join(run.home, 'partial-ran')), false);
  assert.equal(readFileSync(config, 'utf8'), 'unchanged\n');
  assert.deepEqual(run.calls(), []);
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash installer uses a complete retry response and preserves the installation when downloads fail', bashOnly, async t => {
  const run = await fixture(t);
  const runtime = managedRuntime(run.home);
  const marked = join(runtime, marker);
  const config = join(run.home, 'config.toml');
  const httpLog = join(run.root, 'http-calls');
  writeFileSync(config, '[tui]\nstatus_line = ["model"]\n');
  for (const { sequence, expected, status } of [
    { sequence: '503,503,200', expected: '503\n503\n200\n', status: 0 },
    { sequence: '404,200', expected: '404\n', status: 22 },
    { sequence: '503,503,503,503,200', expected: '503\n503\n503\n503\n', status: 22 },
  ]) {
    writeFileSync(httpLog, '');
    const previousCalls = run.calls().length;
    const result = await run.launch('scripts/install.sh', {
      FIXTURE_ARCHIVE_URL: 'fixture:http',
      FIXTURE_HTTP_SEQUENCE: sequence,
      FIXTURE_RESPONSE_URL: pathToFileURL(run.archive).href,
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(readFileSync(httpLog, 'utf8'), expected);
    assert.equal(run.calls().length - previousCalls, status === 0 ? 1 : 0);
    assert.equal(readFileSync(marked, 'utf8'), manifest);
    assert.equal(readFileSync(config, 'utf8'), '[tui]\nstatus_line = ["model"]\n');
    assert.deepEqual(readdirSync(run.temp), []);
  }
});

test('Bash release download recovers from HTTP 503 and stops on permanent or exhausted failures', bashOnly, async t => {
  const run = await fixture(t);
  const archive = readFileSync(run.archive);
  let statuses;
  let requests = 0;
  const server = createServer((_request, response) => {
    const status = statuses[Math.min(requests++, statuses.length - 1)];
    if (status === 200) response.writeHead(status).end(archive);
    else response.writeHead(status, { 'Retry-After': '1' }).end('Temporary or permanent failure');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Loopback sockets are unavailable in this sandbox');
      return;
    }
    throw error;
  }
  t.after(() => server.close());
  const override = { FIXTURE_ARCHIVE_URL: `http://127.0.0.1:${server.address().port}/release.zip`, NO_PROXY: '*', no_proxy: '*' };
  const config = join(run.home, 'config.toml');
  writeFileSync(config, 'unchanged\n');
  for (const { sequence, attempts, installed } of [
    { sequence: [503, 503, 200], attempts: 3, installed: true },
    { sequence: [404], attempts: 1, installed: false },
    { sequence: [503], attempts: 4, installed: false },
  ]) {
    requests = 0;
    statuses = sequence;
    const previousCalls = run.calls().length;
    const result = await run.launch('scripts/install.sh', override);
    assert.equal(result.status === 0, installed, result.stderr);
    assert.equal(requests, attempts);
    assert.equal(run.calls().length - previousCalls, Number(installed));
    assert.equal(readFileSync(config, 'utf8'), 'unchanged\n');
    assert.deepEqual(readdirSync(run.temp), []);
  }
});

test('Bash online install leaves existing configuration intact after a failed download or invalid ZIP', bashOnly, async t => {
  const run = await fixture(t);
  const config = join(run.home, 'config.toml');
  writeFileSync(config, '[tui]\nstatus_line = ["model"]\n');
  writeFileSync(run.archive, 'Not a ZIP archive');
  for (const archive of [join(run.root, 'missing.zip'), run.archive]) {
    const result = await run.launch('scripts/install.sh', { FIXTURE_ARCHIVE_URL: pathToFileURL(archive).href });
    assert.notEqual(result.status, 0, result.stderr);
    assert.deepEqual(run.calls(), []);
    assert.equal(readFileSync(config, 'utf8'), '[tui]\nstatus_line = ["model"]\n');
    assert.deepEqual(readdirSync(run.temp), []);
  }
});

test('Bash online install preserves the manager exit code and cleans up', bashOnly, async t => {
  const run = await fixture(t);
  const result = await run.launch('scripts/install.sh', { FIXTURE_STATUS: '23' });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(run.calls()[0][1], 'install');
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash online install rejects Node before version 22', bashOnly, async t => {
  const run = await fixture(t);
  const override = join(run.root, 'node version.cjs');
  writeFileSync(override, "Object.defineProperty(process.versions, 'node', { value: '21.0.0' });\n");
  const result = await run.launch('scripts/install.sh', { NODE_OPTIONS: `--require "${override}"` });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /Node\.js 22/);
  assert.deepEqual(run.calls(), []);
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash online uninstall uses the owned runtime in the default Codex home', bashOnly, async t => {
  const run = await fixture(t);
  const runtime = managedRuntime(run.home);
  const script = join(runtime, 'scripts', 'manage.mjs');
  writeFileSync(join(run.home, 'codex-hud-statusline.json'), '{}');
  const result = await run.launch('uninstall.sh', { CODEX_HOME: '', FIXTURE_ARCHIVE_URL: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(run.calls(), [[script, 'uninstall']]);
});

test('Bash online uninstall uses the release if local runtime files are missing', bashOnly, async t => {
  const run = await fixture(t);
  const backup = join(run.home, 'codex-hud-statusline.json');
  for (const name of ['bin/codex-hud.mjs', 'lib/app-server.mjs', 'lib/installation.mjs', 'package.json', 'lib']) {
    const runtime = managedRuntime(run.home);
    if (name === 'bin/codex-hud.mjs') writeFileSync(backup, '{}');
    else rmSync(backup, { force: true });
    rmSync(join(runtime, name), { recursive: true });
    const result = await run.launch('uninstall.sh');
    assert.equal(result.status, 0, result.stderr);
    const [script, action] = run.calls().at(-1);
    assert.equal(action, 'uninstall');
    assert.ok(script.startsWith(`${run.temp}/`), script);
    assert.deepEqual(readdirSync(run.temp), []);
  }
});

test('Bash online uninstall uses the release for a pending transaction without a runtime or backup', bashOnly, async t => {
  const run = await fixture(t);
  writeFileSync(join(run.home, transaction), '{}');
  const result = await run.launch('uninstall.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run.calls().length, 1);
  const [[script, action]] = run.calls();
  assert.equal(action, 'uninstall');
  assert.ok(script.startsWith(`${run.temp}/`), script);
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash online uninstall uses the release for a pending transaction with a complete runtime', bashOnly, async t => {
  const run = await fixture(t);
  managedRuntime(run.home);
  writeFileSync(join(run.home, transaction), '{}');
  const result = await run.launch('uninstall.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run.calls().length, 1);
  const [[script, action]] = run.calls();
  assert.equal(action, 'uninstall');
  assert.ok(script.startsWith(`${run.temp}/`), script);
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash online uninstall uses the release for a pending footer migration with a legacy runtime', bashOnly, async t => {
  const run = await fixture(t);
  managedRuntime(run.home);
  writeFileSync(join(run.home, 'codex-hud-statusline.json'), JSON.stringify({
    version: 2, original: ['model'], applied: ['model-with-reasoning', 'codex-version'],
    pending: true, previous: ['model-with-reasoning'],
  }));
  const result = await run.launch('uninstall.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run.calls().length, 1);
  const [[script, action]] = run.calls();
  assert.equal(action, 'uninstall');
  assert.ok(script.startsWith(`${run.temp}/`), script);
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash online uninstall preserves errors from the complete local runtime', bashOnly, async t => {
  const run = await fixture(t);
  const runtime = managedRuntime(run.home);
  writeFileSync(join(run.home, 'codex-hud-statusline.json'), '{}');
  const result = await run.launch('uninstall.sh', { FIXTURE_STATUS: '23' });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(run.calls(), [[join(runtime, 'scripts', 'manage.mjs'), 'uninstall']]);
});

test('Bash online uninstall downloads the release for a legacy backup and ignores a linked manager', bashOnly, async t => {
  const run = await fixture(t);
  const runtime = join(run.home, 'codex-hud');
  const linkedManager = join(run.root, 'unrelated.mjs');
  mkdirSync(join(runtime, 'scripts'), { recursive: true });
  writeFileSync(linkedManager, 'process.exit(24);');
  symlinkSync(linkedManager, join(runtime, 'scripts', 'manage.mjs'));
  writeFileSync(join(runtime, marker), manifest);
  writeFileSync(join(run.home, 'codex-hud-statusline.json'), '{}');
  const result = await run.launch('uninstall.sh');
  assert.equal(result.status, 0, result.stderr);
  const [[script, action]] = run.calls();
  assert.equal(action, 'uninstall');
  assert.ok(script.startsWith(`${run.temp}/`), script);
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash online uninstall ignores a manager absent from the ownership manifest', bashOnly, async t => {
  const run = await fixture(t);
  const runtime = join(run.home, 'codex-hud');
  const script = join(runtime, 'scripts', 'manage.mjs');
  mkdirSync(join(runtime, 'scripts'), { recursive: true });
  writeFileSync(script, manager);
  for (const content of [null, ownership]) {
    if (content !== null) writeFileSync(join(runtime, marker), content);
    const result = await run.launch('uninstall.sh', { FIXTURE_ARCHIVE_URL: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(run.calls(), []);
  }
  assert.equal((await run.launch('uninstall.sh', { CODEX_HOME: join(run.root, 'absent') })).status, 0);
  assert.equal(readFileSync(script, 'utf8'), manager);
});

test('PowerShell online entry points are ASCII for Windows PowerShell 5.1', () => {
  for (const name of ['../scripts/install.ps1', '../uninstall.ps1']) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    assert.ok(readFileSync(path).every(byte => byte < 128), path);
  }
});
