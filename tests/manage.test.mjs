import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { STATUS_LINE } from '../lib/installation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const backupName = 'codex-hud-statusline.json';
const transactionName = '.codex-hud-transaction.json';
const sharedLockNames = ['.codex-hub-runtime.lock', 'codex-hub-statusline.json.lock'];
const legacyStatusLine = [
  'model-with-reasoning', 'project-name', 'git-branch', 'context-used',
  'five-hour-limit', 'weekly-limit', 'task-progress',
];
const mockServer = String.raw`
const { createReadStream, mkdirSync, readFileSync, writeFileSync, writeSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const file = join(process.env.CODEX_HOME, 'config.toml');
createInterface({ input: createReadStream(null, { fd: 0 }) }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  const reply = (body) => writeSync(1, JSON.stringify({ id, ...body }) + '\n');
  if (method === 'initialize') reply({ result: {} });
  if (method === 'config/read') {
    if (process.env.CODEX_HUD_TEST_CREATE_RUNTIME) {
      mkdirSync(join(process.env.CODEX_HOME, 'codex-hud'), { recursive: true });
    }
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const layer = { name: { type: 'user', file }, version: '1', config };
    reply({ result: { config, layers: [layer] } });
  }
  if (method === 'config/value/write') {
    if (process.env.CODEX_HUD_TEST_REJECT_WRITE) {
      reply({ error: { code: -32600, message: 'fixture refused footer write' } });
      return;
    }
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (params.value === null) delete config.tui.status_line;
    else config.tui.status_line = params.value;
    writeFileSync(file, JSON.stringify(config));
    reply({ result: { status: 'ok' } });
  }
});
`;

async function fixture(t, homeName = 'custom home') {
  const temp = await mkdtemp(join(tmpdir(), 'codex hud 安装测试 '));
  t.after(() => rm(temp, { force: true, recursive: true }));
  const home = join(temp, homeName);
  const runtime = join(home, 'codex-hud');
  const config = join(home, 'config.toml');
  const backup = join(home, backupName);
  const original = { tui: { theme: 'custom', status_line: ['model'] } };
  await mkdir(home);
  await writeFile(config, JSON.stringify(original));
  const tools = join(temp, 'test path');
  await mkdir(tools);
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...process.env, [pathKey]: tools, CODEX_HOME: homeName, CODEX_HUD_SHELL: 'none' };
  if (process.platform === 'win32') {
    const bin = join(tools, 'node_modules', '@openai', 'codex', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(tools, 'codex.cmd'), '@exit /b 17\r\n');
    await writeFile(join(bin, 'codex.js'), mockServer);
  } else {
    env.CODEX_HUD_TEST_SERVER = join(tools, 'app-server.cjs');
    env.CODEX_HUD_TEST_NODE = process.execPath;
    await writeFile(env.CODEX_HUD_TEST_SERVER, mockServer);
    await writeFile(join(tools, 'codex'), '#!/bin/sh\nexec "$CODEX_HUD_TEST_NODE" "$CODEX_HUD_TEST_SERVER" "$@"\n', { mode: 0o700 });
  }

  function run(path, args, additionalEnv = {}, nodeArgs = []) {
    const output = join(temp, 'output');
    const log = openSync(output, 'w');
    try {
      const result = spawnSync(process.execPath, [...nodeArgs, path, ...args], {
        cwd: temp, env: { ...env, ...additionalEnv }, stdio: ['ignore', log, log], timeout: 20_000,
      });
      if (result.error) throw result.error;
      return { status: result.status, output: readFileSync(output, 'utf8') };
    } finally {
      closeSync(log);
    }
  }

  function manage(command, { source = root, additionalEnv } = {}) {
    return run(join(source, 'scripts', 'manage.mjs'), [command], additionalEnv);
  }

  return { temp, home, runtime, config, backup, original, manage, run };
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.output);
}

const bundledHost = ['linux', 'darwin', 'win32'].includes(process.platform)
  && ['x64', 'arm64'].includes(process.arch);

for (const [state, contents] of [
  ['codex-hub-statusline.json', '{"version":1,"original":["model"],"applied":["project-name"]}'],
  ['codex-hub-statusline.json.lock', null],
  ['.codex-hub-runtime.lock', null],
  ['.codex-hub-transaction.json', '{"version":1}'],
  ['.codex-hub-shell.json', '{"version":1}'],
  [join('codex-hub', '.codex-hub-managed'), 'codex-hub-runtime-v1\npackage.json\n'],
]) {
  test(`blocks migration while ${state} remains`, async t => {
    const { home, runtime, config, backup, original, manage } = await fixture(t);
    const path = join(home, state);
    await mkdir(dirname(path), { recursive: true });
    if (contents === null) await mkdir(path);
    else await writeFile(path, contents);

    const result = manage('install');
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /README/u);
    assert.ok(result.output.includes(state), result.output);
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    await assert.rejects(lstat(backup), { code: 'ENOENT' });
    await assert.rejects(lstat(join(home, transactionName)), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
    if (contents === null) assert.deepEqual(await readdir(path), []);
    else assert.equal(await readFile(path, 'utf8'), contents);
    for (const name of sharedLockNames.filter(name => name !== state)) {
      await assert.rejects(lstat(join(home, name)), { code: 'ENOENT' });
    }
  });
}

test('keeps both shared locks from migration preflight through profile publication', {
  skip: !bundledHost,
}, async t => {
  const { temp, home, config, original, run, manage } = await fixture(t);
  const resolvedHome = await realpath(home);
  const profile = join(temp, '.zshrc');
  const preload = join(temp, 'observe locks.cjs');
  const paths = sharedLockNames.map(name => join(resolvedHome, name));
  await writeFile(preload, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { lstat } = fs.promises;
const { linkSync } = fs;
function checkLocks() {
  for (const path of ${JSON.stringify(paths)}) {
    assert.ok(fs.lstatSync(path, { throwIfNoEntry: false })?.isDirectory(), 'expected lock: ' + path);
  }
}
fs.promises.lstat = (path, options) => {
  if (path === ${JSON.stringify(join(resolvedHome, 'codex-hub-statusline.json'))}) checkLocks();
  return lstat(path, options);
};
fs.linkSync = (from, to) => {
  if (to === ${JSON.stringify(profile)}) checkLocks();
  return linkSync(from, to);
};
require('node:module').syncBuiltinESMExports();
`);
  const additionalEnv = { HOME: temp, ZDOTDIR: temp, CODEX_HUD_SHELL: 'zsh' };
  assertSuccess(run(join(root, 'scripts', 'manage.mjs'), ['install'], additionalEnv, ['--require', preload]));
  assert.match(await readFile(profile, 'utf8'), /^# >>> codex-hud /mu);
  for (const path of paths) await assert.rejects(lstat(path), { code: 'ENOENT' });

  assertSuccess(manage('uninstall'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  for (const path of paths) await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('installs and uninstalls with user files left in the old runtime', { skip: !bundledHost }, async t => {
  const { home, config, original, manage } = await fixture(t);
  const legacyRuntime = join(home, 'codex-hub');
  const userFile = join(legacyRuntime, 'scripts', 'manage.mjs');
  const marker = join(legacyRuntime, '.codex-hub-managed');
  await mkdir(dirname(userFile), { recursive: true });
  await writeFile(userFile, 'user data');
  for (const contents of [null, 'codex-hub-runtime-v1\n']) {
    if (contents) await writeFile(marker, contents);
    assertSuccess(manage('install'));
    assertSuccess(manage('uninstall'));
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
    assert.equal(await readFile(userFile, 'utf8'), 'user data');
    if (contents) assert.equal(await readFile(marker, 'utf8'), contents);
  }
});

test('blocks migration when a launcher block remains without its legacy shell record', async t => {
  const { temp, home, runtime, config, original, manage } = await fixture(t);
  const powerShellProfile = join(temp, 'profile.ps1');
  const block = '# site settings\n# >>> codex-hub 1234567890abcdef >>>\n# old launcher\n# <<< codex-hub 1234567890abcdef <<<\n';
  for (const [profile, bytes, additionalEnv] of [
    [join(temp, '.zshrc'), Buffer.from(block), { HOME: temp, ZDOTDIR: temp, CODEX_HUD_SHELL: 'zsh' }],
    [powerShellProfile, Buffer.from('\uFEFF' + block.replaceAll('\n', '\r\n'), 'utf16le'),
      { CODEX_HUD_PS_PROFILE: powerShellProfile, CODEX_HUD_SHELL: 'powershell' }],
  ]) {
    await writeFile(profile, bytes);
    const result = manage('install', { additionalEnv });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /README/u);
    assert.ok(result.output.includes(profile), result.output);
    assert.deepEqual(await readFile(profile), bytes);
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    await assert.rejects(lstat(join(home, '.codex-hud-shell.json')), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  }
});

test('an old launcher owned by a second home can stay in a shared Zsh profile', { skip: !bundledHost }, async t => {
  const { temp, home, runtime, config, original, manage } = await fixture(t);
  const profile = join(temp, '.zshrc');
  const peer = join(temp, 'another Codex home');
  const record = join(peer, '.codex-hub-shell.json');
  const marker = '1234567890abcdef';
  const block = `# >>> codex-hub ${marker} >>>\n# other launcher\n# <<< codex-hub ${marker} <<<\n`;
  const bytes = '# user settings\n' + block;
  const state = JSON.stringify({ version: 1, entries: [{ path: profile, block }] });
  const additionalEnv = { HOME: temp, ZDOTDIR: temp, CODEX_HUD_SHELL: 'zsh' };
  await mkdir(peer);
  await writeFile(record, state);
  await writeFile(profile, bytes);
  await assert.rejects(lstat(join(home, '.codex-hub-shell.json')), { code: 'ENOENT' });

  const result = manage('install', { additionalEnv });
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(marker), result.output);
  assert.match(result.output, /CODEX_HOME.*CODEX_HUD_SHELL=none/u);
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
  assert.equal(await readFile(profile, 'utf8'), bytes);

  assertSuccess(manage('install', { additionalEnv: { ...additionalEnv, CODEX_HUD_SHELL: 'none' } }));
  assertSuccess(manage('uninstall'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  assert.equal(await readFile(profile, 'utf8'), bytes);
  assert.equal(await readFile(record, 'utf8'), state);
});

test('installs the pinned terminal modules from the local package', { skip: !bundledHost }, async (t) => {
  const { runtime, manage, run } = await fixture(t);
  assertSuccess(manage('install'));
  const result = run('--eval', [
    'const requireFromHud = require("node:module").createRequire(process.argv[1]);'
    + 'console.log(typeof requireFromHud("node-pty").spawn, typeof requireFromHud("@xterm/headless").Terminal);',
    join(runtime, 'lib', 'terminal-host.mjs'),
  ]);
  assertSuccess(result);
  assert.equal(result.output.trim(), 'function function');
});

test('install and reinstall explain activation when invoked from a subprocess', { skip: !bundledHost || process.platform === 'win32' }, async t => {
  const { temp, manage } = await fixture(t);
  const additionalEnv = { HOME: temp, ZDOTDIR: temp, CODEX_HUD_SHELL: 'zsh' };
  for (let run = 0; run < 2; run++) {
    const installed = manage('install', { additionalEnv });
    assertSuccess(installed);
    assert.match(installed.output, /新开.*(?:Zsh|Bash)/u);
    assert.match(installed.output, /当前终端也使用 Zsh/u);
    assert.match(installed.output, /^  \[ .* -ef .*\] && \. .*\/scripts\/activate\.sh'$/mu);
    assert.doesNotMatch(installed.output, /请重新打开 Codex/u);
  }
  const profile = join(temp, '.zshrc');
  const edited = (await readFile(profile, 'utf8')).replace('launch --', 'launch -- edited');
  await writeFile(profile, edited);
  const skipped = manage('install', { additionalEnv });
  assertSuccess(skipped);
  assert.match(skipped.output, /显式启动/u);
  assert.doesNotMatch(skipped.output, /scripts\/activate\.sh/u);
  assert.equal(await readFile(profile, 'utf8'), edited);
});

test('printed activation stays bound to the installed home despite another local CODEX_HOME', {
  skip: !bundledHost || process.platform === 'win32',
}, async t => {
  const { temp, home, runtime, manage } = await fixture(t, "custom 'home'");
  const receipt = manage('install', { additionalEnv: { HOME: temp, ZDOTDIR: temp, CODEX_HUD_SHELL: 'zsh' } });
  assertSuccess(receipt);
  const activate = receipt.output.split('\n').find(line => line.startsWith('  ') && line.includes('/scripts/activate.sh'));
  assert.ok(activate, receipt.output);
  await writeFile(join(runtime, 'scripts', 'activate.sh'), 'printf "INSTALLED HOME\\n"\n');
  const explicit = receipt.output.split('\n').find(line => line.startsWith('  command env '));
  assert.ok(explicit, receipt.output);
  await writeFile(join(runtime, 'bin', 'codex-hud.mjs'), 'import { writeSync } from "node:fs"; writeSync(1, process.env.CODEX_HOME + " " + JSON.stringify(process.argv.slice(2)) + "\\n");');

  const other = join(temp, 'unrelated home');
  const otherScripts = join(other, 'codex-hud', 'scripts');
  await mkdir(otherScripts, { recursive: true });
  await writeFile(join(otherScripts, 'activate.sh'), 'printf "INCORRECT HOME\\n"\n');
  const linked = join(temp, 'linked home');
  await symlink(home, linked);
  function runInShell(shell, command, choice) {
    return spawnSync(shell, ['-c', `unset CODEX_HOME\nCODEX_HOME="$CHOSEN_CODEX_HOME"\n${command}`], {
      env: { ...process.env, CHOSEN_CODEX_HOME: choice }, encoding: 'utf8',
    });
  }

  for (const shell of ['/bin/bash', '/bin/zsh']) {
    try { await lstat(shell); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const mismatched = runInShell(shell, activate, other);
    assert.equal(mismatched.status, 1, mismatched.stderr);
    assert.equal(mismatched.stdout, '');
    const same = runInShell(shell, activate, linked);
    assert.equal(same.status, 0, same.stderr);
    assert.equal(same.stdout, 'INSTALLED HOME\n');

    const launched = runInShell(shell, explicit, other);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stdout.trim(), `${await realpath(home)} ["launch","--"]`);
  }
});

test('preserves a nested user file after upgrade and interrupted removal of bundled dependencies', {
  skip: !bundledHost,
}, async (t) => {
  const { temp, home, runtime, backup, manage, run } = await fixture(t);
  const localFile = join('node_modules', '@xterm', 'headless', 'lib-headless', 'notes.txt');
  const metadata = join(runtime, 'node_modules', '@xterm', 'headless', 'package.json');
  assertSuccess(manage('install'));
  await writeFile(join(runtime, localFile), 'local note');
  assertSuccess(manage('install'));
  assert.equal(await readFile(join(runtime, localFile), 'utf8'), 'local note');

  const checkpoint = await interruptRuntimeRename(temp, home, 'uninstall', localFile);
  assert.equal(run(join(runtime, 'scripts', 'manage.mjs'), ['uninstall'], {}, checkpoint).status, 86);
  await clearInterruptedLocks(home);
  assertSuccess(manage('uninstall'));
  assert.equal(await readFile(join(runtime, localFile), 'utf8'), 'local note');
  await assert.rejects(lstat(metadata), { code: 'ENOENT' });
  assert.equal((await readdir(home)).some(name => name.startsWith('.codex-hud-runtime-')), false);

  assertSuccess(manage('install'));
  assert.equal(await readFile(join(runtime, localFile), 'utf8'), 'local note');
  assert.equal(JSON.parse(await readFile(metadata, 'utf8')).version, '6.0.0');
});

test('does not import a substituted configuration module during uninstall', {
  skip: !bundledHost || process.platform === 'win32',
}, async t => {
  const { runtime, manage, temp } = await fixture(t);
  assertSuccess(manage('install'));
  const modulePath = join(runtime, 'lib', 'installation.mjs');
  const external = join(temp, 'unrelated.mjs');
  await writeFile(external, '// user file\n');
  await rm(modulePath);
  await symlink(external, modulePath);

  const result = manage('uninstall', { source: runtime });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /非 Codex HUD 运行文件.*installation\.mjs/u);
  assert.equal((await lstat(modulePath)).isSymbolicLink(), true);
});

test('does not follow a substituted terminal dependency directory during uninstall', { skip: !bundledHost }, async (t) => {
  const { runtime, manage, temp } = await fixture(t);
  assertSuccess(manage('install'));
  const owned = join(runtime, 'node_modules', '@xterm', 'headless', 'lib-headless');
  const original = join(temp, 'original package directory');
  const other = join(temp, 'unrelated directory');
  await rename(owned, original);
  await mkdir(other);
  const unrelated = join(other, 'xterm-headless.js');
  await writeFile(unrelated, 'other data');
  await symlink(other, owned, 'junction');

  const result = manage('uninstall');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /非 Codex HUD 运行文件/u);
  assert.equal((await lstat(owned)).isSymbolicLink(), true);
  assert.equal(await readFile(unrelated, 'utf8'), 'other data');
});

async function interruptRuntimeRename(temp, home, command, extra) {
  const runtime = join(await realpath(home), 'codex-hud');
  const checkpoint = join(temp, 'interrupt.cjs');
  const condition = extra
    ? `to.endsWith(${JSON.stringify(join('next', extra))})`
    : `${command === 'install' ? 'to' : 'from'} === ${JSON.stringify(runtime)}`;
  await writeFile(checkpoint, `
const fs = require('node:fs');
const { renameSync } = fs;
fs.renameSync = (from, to) => {
  renameSync(from, to);
  if (${condition}) process.exit(86);
};
require('node:module').syncBuiltinESMExports();
`);
  return ['--require', checkpoint];
}

async function clearInterruptedLocks(home) {
  for (const name of sharedLockNames) await rmdir(join(home, name));
}

async function legacyInstallation(t) {
  const installed = await fixture(t);
  const { runtime, config, backup, original, manage } = installed;
  await writeFile(config, JSON.stringify({ tui: { ...original.tui, status_line: legacyStatusLine } }));
  assertSuccess(manage('install'));
  const metadata = join(runtime, 'package.json');
  await writeFile(metadata, JSON.stringify({ ...JSON.parse(await readFile(metadata, 'utf8')), version: '0.1.1' }));
  return {
    ...installed,
    async saveLegacyBackup() {
      await writeFile(backup, JSON.stringify({ version: 1, original: original.tui.status_line, applied: legacyStatusLine }));
    },
  };
}

async function installBeforeTerminalDependencies(t) {
  const installed = await fixture(t);
  const { runtime, config, backup, original } = installed;
  const files = [
    'package.json', 'LICENSE', 'bin/codex-hud.mjs', 'scripts/manage.mjs',
    'lib/activity.mjs', 'lib/app-server.mjs', 'lib/hud-metrics.mjs', 'lib/installation.mjs',
  ];
  // The v0.1.2 marker owned only the original files, with no dependency or license directories.
  for (const directory of ['bin', 'lib', 'scripts']) await mkdir(join(runtime, directory), { recursive: true });
  for (const file of files) await cp(join(root, file), join(runtime, file));
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'codex-hud', version: '0.1.2' }));
  await writeFile(join(runtime, '.codex-hud-managed'), ['codex-hud-runtime-v1', ...files, ''].join('\n'));
  await writeFile(config, JSON.stringify({ tui: { ...original.tui, status_line: STATUS_LINE } }));
  await writeFile(backup, JSON.stringify({ version: 1, original: original.tui.status_line, applied: STATUS_LINE }));
  return installed;
}

test('upgrades a v0.1.2 runtime with user dependency and license directories after an interrupted move', {
  skip: !bundledHost,
}, async (t) => {
  const { temp, home, runtime, config, backup, original, manage, run } = await installBeforeTerminalDependencies(t);
  const files = new Map([
    [join('node_modules', 'unrelated', 'notes.txt'), 'user dependency note'],
    [join('node_modules', '@xterm', 'headless', 'lib-headless', 'local.txt'), 'nested note'],
    [join('licenses', 'another-project.txt'), 'user license'],
  ]);
  for (const [file, content] of files) {
    const target = join(runtime, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const checkpoint = await interruptRuntimeRename(temp, home, 'install', join('node_modules', 'unrelated'));
  const interrupted = run(join(root, 'scripts', 'manage.mjs'), ['install'], {}, checkpoint);
  assert.equal(interrupted.status, 86, interrupted.output);
  await clearInterruptedLocks(home);
  assertSuccess(manage('install'));
  for (const [file, content] of files) assert.equal(await readFile(join(runtime, file), 'utf8'), content);
  const nativePackage = join(runtime, 'node_modules', 'node-pty', 'package.json');
  assert.equal(JSON.parse(await readFile(nativePackage, 'utf8')).version, '1.2.0-beta.18');
  assert.equal((await readdir(home)).some(name => name.startsWith('.codex-hud-runtime-')), false);

  assertSuccess(manage('uninstall', { source: runtime }));
  await assert.rejects(lstat(nativePackage), { code: 'ENOENT' });
  for (const [file, content] of files) assert.equal(await readFile(join(runtime, file), 'utf8'), content);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  await assert.rejects(lstat(join(home, transactionName)), { code: 'ENOENT' });
});

for (const [kind, path] of [
  ['same file', join('licenses', 'xterm-headless.txt')],
  ['different type', 'node_modules'],
  ['directory link', join('node_modules', '@xterm')],
]) {
  test(`rejects a v0.1.2 upgrade with a ${kind} conflict without altering old files`, {
    skip: !bundledHost,
  }, async (t) => {
    const { temp, home, runtime, config, backup, manage } = await installBeforeTerminalDependencies(t);
    const target = join(runtime, path);
    const oldMarker = await readFile(join(runtime, '.codex-hud-managed'), 'utf8');
    const oldConfig = await readFile(config, 'utf8');
    const oldBackup = await readFile(backup, 'utf8');
    await mkdir(dirname(target), { recursive: true });
    const outside = join(temp, 'outside');
    if (kind === 'directory link') {
      await mkdir(outside);
      await writeFile(join(outside, 'notes.txt'), 'outside data');
      await symlink(outside, target, 'junction');
    } else {
      await writeFile(target, 'user data');
    }

    const upgraded = manage('install');
    assert.equal(upgraded.status, 1, upgraded.output);
    assert.ok(upgraded.output.includes(target), upgraded.output);
    assert.equal(await readFile(join(runtime, '.codex-hud-managed'), 'utf8'), oldMarker);
    assert.equal(await readFile(config, 'utf8'), oldConfig);
    assert.equal(await readFile(backup, 'utf8'), oldBackup);
    await assert.rejects(lstat(join(home, transactionName)), { code: 'ENOENT' });
    if (kind === 'directory link') {
      assert.ok((await lstat(target)).isSymbolicLink());
      assert.equal(await readFile(join(outside, 'notes.txt'), 'utf8'), 'outside data');
    } else {
      assert.equal(await readFile(target, 'utf8'), 'user data');
    }
  });
}

test('installs a relocatable runtime and preserves extra files through upgrade and removal', async (t) => {
  const { temp, runtime, config, backup, original, manage, run } = await fixture(t);
  const cli = join(runtime, 'bin', 'codex-hud.mjs');
  assertSuccess(manage('install'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, STATUS_LINE);
  const firstBackup = await readFile(backup, 'utf8');
  const extra = join(runtime, 'lib', 'user-note.mjs');
  await writeFile(extra, 'user data');

  const next = join(temp, 'new package');
  await mkdir(next);
  for (const name of ['bin', 'lib', 'licenses', 'node_modules', 'scripts', 'package.json', 'LICENSE']) {
    await cp(join(root, name), join(next, name), { recursive: true });
  }
  await writeFile(join(next, 'package.json'), JSON.stringify({ name: 'codex-hud', version: '9.8.7' }));
  assertSuccess(manage('install', { source: next }));
  assert.equal(run(cli, ['--version']).output.trim(), '9.8.7');
  assert.equal(await readFile(backup, 'utf8'), firstBackup);
  assert.equal(await readFile(extra, 'utf8'), 'user data');

  assertSuccess(manage('uninstall', { source: runtime }));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  await assert.rejects(lstat(backup), { code: 'ENOENT' });
  await assert.rejects(lstat(cli), { code: 'ENOENT' });
  assert.equal(await readFile(extra, 'utf8'), 'user data');
});

test('retries upgrading an owned v0.1.1 footer after the app-server rejects the write', async (t) => {
  const { runtime, config, backup, original, manage, run, saveLegacyBackup } = await legacyInstallation(t);
  await saveLegacyBackup();

  const rejected = manage('install', { additionalEnv: { CODEX_HUD_TEST_REJECT_WRITE: '1' } });
  assert.equal(rejected.status, 1, rejected.output);
  assert.match(rejected.output, /fixture refused footer write/);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, legacyStatusLine);
  const cli = join(runtime, 'bin', 'codex-hud.mjs');
  assert.equal(run(cli, ['--version']).output.trim(), '0.1.1');

  assertSuccess(manage('install'));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(run(cli, ['--version']).output.trim(), version);
  assert.ok(JSON.parse(await readFile(config, 'utf8')).tui.status_line.includes('codex-version'));
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')).original, original.tui.status_line);
  assertSuccess(manage('uninstall', { source: runtime }));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
});

test('uninstall restores the original footer when upgrade is interrupted at runtime publication', async (t) => {
  const { temp, home, runtime, config, backup, original, manage, run, saveLegacyBackup } = await legacyInstallation(t);
  await saveLegacyBackup();
  const checkpoint = await interruptRuntimeRename(temp, home, 'install');
  const interrupted = run(join(root, 'scripts', 'manage.mjs'), ['install'], {}, checkpoint);
  assert.equal(interrupted.status, 86, interrupted.output);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, legacyStatusLine);

  await clearInterruptedLocks(home);
  assertSuccess(manage('uninstall'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  await assert.rejects(lstat(backup), { code: 'ENOENT' });
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
});

test('keeps an unowned v0.1.1 footer during an upgrade', async (t) => {
  const { config, backup, original, manage } = await legacyInstallation(t);
  assertSuccess(manage('install'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, legacyStatusLine);
  await assert.rejects(lstat(backup), { code: 'ENOENT' });
  assertSuccess(manage('uninstall'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { tui: { ...original.tui, status_line: legacyStatusLine } });
});

test('preserves footer edits and the first backup across repeated installs', async (t) => {
  const { config, backup, original, manage } = await fixture(t);
  assertSuccess(manage('install'));
  const firstBackup = await readFile(backup, 'utf8');
  const custom = { ...original, tui: { theme: 'different', status_line: ['project-name'] } };
  await writeFile(config, JSON.stringify(custom));
  assertSuccess(manage('install'));
  assert.equal(await readFile(backup, 'utf8'), firstBackup);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), custom);
  assertSuccess(manage('uninstall'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), custom);
});

test('an upgrade preserves footer edits when the first install needed no backup', async (t) => {
  const { runtime, config, backup, original, manage } = await fixture(t);
  await writeFile(config, JSON.stringify({ tui: { ...original.tui, status_line: STATUS_LINE } }));
  assertSuccess(manage('install'));
  await assert.rejects(lstat(backup), { code: 'ENOENT' });

  const custom = { tui: { ...original.tui, status_line: ['project-name'] } };
  await writeFile(config, JSON.stringify(custom));
  assertSuccess(manage('install'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), custom);
  await assert.rejects(lstat(backup), { code: 'ENOENT' });
  assertSuccess(manage('uninstall'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), custom);
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
});

test('rejects a malformed legacy backup and preserves its bytes', async (t) => {
  const { runtime, config, backup, original, manage } = await fixture(t);
  await writeFile(backup, '{}\n');
  const result = manage('install');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /status line backup is invalid/);
  assert.equal(await readFile(backup, 'utf8'), '{}\n');
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
});

test('rejects a package missing the HUD metrics before applying the footer', async (t) => {
  const { temp, config, backup, original, manage } = await fixture(t);
  const badPackage = join(temp, 'missing metrics');
  await mkdir(badPackage);
  for (const path of ['bin', 'lib', 'licenses', 'node_modules', 'scripts', 'package.json', 'LICENSE']) {
    await cp(join(root, path), join(badPackage, path), { recursive: true });
  }
  await rm(join(badPackage, 'lib', 'hud-metrics.mjs'));

  const result = manage('install', { source: badPackage });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /lib\/hud-metrics\.mjs/u);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  await assert.rejects(lstat(backup), { code: 'ENOENT' });
});

test('restores a legacy footer backup without removing a manual copy', async (t) => {
  const { runtime, config, backup, original, manage } = await fixture(t);
  await mkdir(runtime);
  await writeFile(join(runtime, 'package.json'), 'manual copy');
  await writeFile(config, JSON.stringify({ tui: { ...original.tui, status_line: STATUS_LINE } }));
  await writeFile(backup, JSON.stringify({ version: 1, original: original.tui.status_line, applied: STATUS_LINE }));
  const result = manage('install');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /codex-hud/);
  assertSuccess(manage('uninstall'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  assert.equal(await readFile(join(runtime, 'package.json'), 'utf8'), 'manual copy');
});

test('does not follow a runtime directory link', async (t) => {
  const { temp, runtime, manage } = await fixture(t);
  const other = join(temp, 'other directory');
  await mkdir(other);
  await writeFile(join(other, 'package.json'), 'other data');
  await symlink(other, runtime, 'junction');
  const result = manage('install');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /codex-hud/);
  assertSuccess(manage('uninstall'));
  assert.equal((await lstat(runtime)).isSymbolicLink(), true);
  assert.equal(await readFile(join(other, 'package.json'), 'utf8'), 'other data');
});

test('failed footer configuration leaves install retryable and uninstall keeps the runtime', async (t) => {
  const { home, runtime, config, backup, original, manage } = await fixture(t);
  const reject = { additionalEnv: { CODEX_HUD_TEST_REJECT_WRITE: '1' } };
  const install = manage('install', reject);
  assert.equal(install.status, 1, install.output);
  assert.match(install.output, /fixture refused footer write/);
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')).original, original.tui.status_line);

  assertSuccess(manage('install'));
  const firstBackup = JSON.stringify(JSON.parse(await readFile(backup, 'utf8')), null, 2) + '\n\n';
  await writeFile(backup, firstBackup);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, STATUS_LINE);
  const uninstall = manage('uninstall', { ...reject, source: runtime });
  assert.equal(uninstall.status, 1, uninstall.output);
  assert.match(uninstall.output, /fixture refused footer write/);
  assert.equal(await readFile(backup, 'utf8'), firstBackup);
  assert.equal((await lstat(join(runtime, 'bin', 'codex-hud.mjs'))).isFile(), true);
  assert.equal((await readdir(home)).some(name => name.startsWith('.codex-hud-runtime-')), false);
  assertSuccess(manage('uninstall'));
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
});

test('resumes a pending footer after the first install is interrupted at publication', async (t) => {
  const { temp, home, runtime, config, backup, original, manage, run } = await fixture(t);
  const checkpoint = await interruptRuntimeRename(temp, home, 'install');
  const interrupted = run(join(root, 'scripts', 'manage.mjs'), ['install'], {}, checkpoint);
  assert.equal(interrupted.status, 86, interrupted.output);
  assert.equal((await lstat(runtime)).isDirectory(), true);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')).original, original.tui.status_line);

  await clearInterruptedLocks(home);
  assertSuccess(manage('install'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, STATUS_LINE);
  assertSuccess(manage('uninstall', { source: runtime }));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
});

for (const withBackup of [true, false]) {
  test(`an interrupted local uninstall restores files ${withBackup ? 'from the previous directory' : 'split across staging'}`, async (t) => {
    const { temp, home, runtime, config, backup, original, manage, run } = await fixture(t);
    const installed = { tui: { ...original.tui, status_line: STATUS_LINE } };
    if (!withBackup) await writeFile(config, JSON.stringify(installed));
    assertSuccess(manage('install'));
    const first = 'root note.txt';
    const files = new Map([
      [first, Buffer.from([0x00, 0xff, 0x11, 0x0a])],
      [join('lib', '设置.txt'), Buffer.from('lib file')],
      [join('scripts', 'personal.txt'), Buffer.from('script file')],
    ]);
    for (const [file, contents] of files) await writeFile(join(runtime, file), contents);
    const originalBackup = withBackup ? await readFile(backup, 'utf8') : null;
    const checkpoint = await interruptRuntimeRename(temp, home, 'uninstall', withBackup ? undefined : first);
    const interrupted = run(join(runtime, 'scripts', 'manage.mjs'), ['uninstall'], {}, checkpoint);
    assert.equal(interrupted.status, 86, interrupted.output);
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    assert.equal((await lstat(join(home, transactionName))).isFile(), true);
    if (withBackup) {
      const { uninstallId, ...footer } = JSON.parse(await readFile(backup, 'utf8'));
      assert.deepEqual(footer, JSON.parse(originalBackup));
      assert.equal(uninstallId, JSON.parse(await readFile(join(home, transactionName), 'utf8')).backupId);
    } else await assert.rejects(lstat(backup), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), installed);

    await clearInterruptedLocks(home);
    assertSuccess(manage('uninstall'));
    for (const [file, contents] of files) assert.deepEqual(await readFile(join(runtime, file)), contents);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), withBackup ? original : installed);
    await assert.rejects(lstat(backup), { code: 'ENOENT' });
    await assert.rejects(lstat(join(home, transactionName)), { code: 'ENOENT' });
    assert.equal((await readdir(home)).some(name => name.startsWith('.codex-hud-runtime-')), false);
  });
}

test('interrupted recovery preserves external entries that conflict with a move', async (t) => {
  const { temp, home, runtime, backup, manage, run } = await fixture(t);
  assertSuccess(manage('install'));
  const note = 'note.txt';
  await writeFile(join(runtime, note), 'user data');
  const checkpoint = await interruptRuntimeRename(temp, home, 'uninstall', note);
  assert.equal(run(join(runtime, 'scripts', 'manage.mjs'), ['uninstall'], {}, checkpoint).status, 86);
  await clearInterruptedLocks(home);
  await mkdir(runtime);
  await writeFile(join(runtime, note), 'outside data');
  const result = manage('uninstall');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /非 Codex HUD 运行文件/);
  assert.equal(await readFile(join(runtime, note), 'utf8'), 'outside data');
  assert.equal((await lstat(join(home, transactionName))).isFile(), true);
  const outside = join(home, 'outside');
  await rename(runtime, outside);

  const [staging] = (await readdir(home)).filter(name => name.startsWith('.codex-hud-runtime-'));
  const conflict = join(home, staging, 'previous', note);
  await writeFile(conflict, 'a second external file');
  const blocked = manage('uninstall');
  assert.equal(blocked.status, 1, blocked.output);
  assert.equal(await readFile(conflict, 'utf8'), 'a second external file');
  assert.equal(await readFile(join(home, staging, 'next', note), 'utf8'), 'user data');
  await rename(conflict, join(outside, 'second note.txt'));

  assertSuccess(manage('uninstall'));
  assert.equal(await readFile(join(runtime, note), 'utf8'), 'user data');
  assert.equal(await readFile(join(outside, note), 'utf8'), 'outside data');
});

test('retry finishes cleaning a committed uninstall before reinstalling the footer', async (t) => {
  const { temp, home, runtime, config, backup, original, manage, run } = await fixture(t);
  assertSuccess(manage('install'));
  const note = join(runtime, 'note.txt');
  await writeFile(note, 'user data');
  const preload = join(temp, 'interrupt after commit.cjs');
  await writeFile(preload, `
const fs = require('node:fs');
const { renameSync } = fs;
fs.renameSync = (from, to) => {
  renameSync(from, to);
  if (require('node:path').basename(to) === ${JSON.stringify(transactionName)} &&
      JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'committed') process.exit(86);
};
require('node:module').syncBuiltinESMExports();
`);
  const interrupted = run(join(runtime, 'scripts', 'manage.mjs'), ['uninstall'], {}, ['--require', preload]);
  assert.equal(interrupted.status, 86, interrupted.output);
  await assert.rejects(lstat(backup), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);

  await clearInterruptedLocks(home);
  assertSuccess(manage('install'));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, STATUS_LINE);
  assert.equal(await readFile(note, 'utf8'), 'user data');
  assert.equal((await readdir(home)).some(name => name.startsWith('.codex-hud-runtime-')), false);
});

for (const withExtras of [true, false]) {
  test(`reinstall finishes the prior uninstall ${withExtras ? 'before' : 'after'} its backup was removed`, async (t) => {
    const { temp, home, runtime, config, backup, original, manage, run } = await fixture(t);
    assertSuccess(manage('install'));
    const note = join(runtime, 'lib', 'note.txt');
    if (withExtras) await writeFile(note, 'user data');
    const preload = join(temp, 'interrupt after footer.cjs');
    await writeFile(preload, `
const fs = require('node:fs');
const { rm } = fs.promises;
fs.promises.rm = async (path, options) => {
  const isBackup = require('node:path').basename(path) === ${JSON.stringify(backupName)};
  if (isBackup && ${withExtras}) process.exit(86);
  await rm(path, options);
  if (isBackup) process.exit(86);
};
require('node:module').syncBuiltinESMExports();
`);
    const interrupted = run(join(runtime, 'scripts', 'manage.mjs'), ['uninstall'], {}, ['--require', preload]);
    assert.equal(interrupted.status, 86, interrupted.output);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
    if (withExtras) {
      assert.equal(await readFile(note, 'utf8'), 'user data');
      assert.equal((await lstat(backup)).isFile(), true);
    } else {
      await assert.rejects(lstat(backup), { code: 'ENOENT' });
      await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    }

    await clearInterruptedLocks(home);
    if (withExtras) {
      const interruptedAgain = run(join(root, 'scripts', 'manage.mjs'), ['install'], {}, ['--require', preload]);
      assert.equal(interruptedAgain.status, 86, interruptedAgain.output);
      assert.equal((await lstat(join(home, transactionName))).isFile(), true);
      await clearInterruptedLocks(home);
    }
    assertSuccess(manage('install'));
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, STATUS_LINE);
    assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')).original, original.tui.status_line);
    if (withExtras) assert.equal(await readFile(note, 'utf8'), 'user data');
    assert.equal((await readdir(home)).some(name => name.startsWith('.codex-hud-runtime-')), false);
  });
}

for (const withBackup of [true, false]) {
  test(`a recovered uninstall preserves a newer manual backup ${withBackup ? 'with identical original bytes' : 'when it never owned a backup'}`, async (t) => {
    const { temp, home, runtime, config, backup, original, manage, run } = await fixture(t);
    if (!withBackup) {
      await writeFile(config, JSON.stringify({ tui: { ...original.tui, status_line: STATUS_LINE } }));
    }
    assertSuccess(manage('install'));
    const firstBackup = withBackup ? await readFile(backup, 'utf8') : null;
    const preload = join(temp, 'interrupt before uninstall commit.cjs');
    await writeFile(preload, `
const fs = require('node:fs');
const { basename } = require('node:path');
const { renameSync } = fs;
fs.renameSync = (from, to) => {
  if (basename(to) === ${JSON.stringify(transactionName)} &&
      JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'committed') process.exit(86);
  renameSync(from, to);
};
require('node:module').syncBuiltinESMExports();
`);
    const interrupted = run(join(runtime, 'scripts', 'manage.mjs'), ['uninstall'], {}, ['--require', preload]);
    assert.equal(interrupted.status, 86, interrupted.output);
    await assert.rejects(lstat(backup), { code: 'ENOENT' });
    await clearInterruptedLocks(home);

    if (!withBackup) await writeFile(config, JSON.stringify(original));
    assertSuccess(run(join(root, 'bin', 'codex-hud.mjs'), ['install']));
    const manualBackup = await readFile(backup, 'utf8');
    if (withBackup) assert.equal(manualBackup, firstBackup);
    const edited = { tui: { ...original.tui, status_line: ['project-name'] } };
    await writeFile(config, JSON.stringify(edited));

    assertSuccess(manage('install'));
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), edited);
    assert.equal(await readFile(backup, 'utf8'), manualBackup);
    await assert.rejects(lstat(join(home, transactionName)), { code: 'ENOENT' });
  });
}

for (const duringCopy of [true, false]) {
  test(`an interrupted preparation is cleaned ${duringCopy ? 'mid-copy' : 'before the app-server starts'}`, async (t) => {
    const { temp, home, runtime, config, backup, original, manage, run } = await fixture(t);
    const preload = join(temp, 'interrupt preparation.cjs');
    await writeFile(preload, `
const fs = require('node:fs');
const { copyFileSync, writeFileSync } = fs;
fs.copyFileSync = (...args) => {
  copyFileSync(...args);
  if (${duringCopy}) process.exit(86);
};
fs.writeFileSync = (path, ...args) => {
  writeFileSync(path, ...args);
  if (require('node:path').basename(path) === '.codex-hud-managed') process.exit(86);
};
require('node:module').syncBuiltinESMExports();
`);
    const interrupted = run(join(root, 'scripts', 'manage.mjs'), ['install'], {}, ['--require', preload]);
    assert.equal(interrupted.status, 86, interrupted.output);
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    await assert.rejects(lstat(backup), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);

    const marker = join(home, transactionName);
    const { staging } = JSON.parse(await readFile(marker, 'utf8'));
    const next = join(home, staging, 'next');
    const personal = join(next, 'untracked note.txt');
    if (duringCopy) await writeFile(personal, 'personal data');

    await clearInterruptedLocks(home);
    assertSuccess(manage('uninstall'));
    await assert.rejects(lstat(marker), { code: 'ENOENT' });
    if (duringCopy) {
      assert.deepEqual(await readdir(next), ['untracked note.txt']);
      assert.equal(await readFile(personal, 'utf8'), 'personal data');
    } else {
      assert.equal((await readdir(home)).some(name => name.startsWith('.codex-hud-runtime-')), false);
    }
  });
}

test('rejects a transaction marker pointing outside a managed staging directory', async (t) => {
  const { home, runtime, manage } = await fixture(t);
  const marker = join(home, transactionName);
  const untrusted = JSON.stringify({ version: 1, staging: '../untrusted' });
  await writeFile(marker, untrusted);
  const result = manage('uninstall');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /无法验证 Codex HUD 事务/);
  assert.equal(await readFile(marker, 'utf8'), untrusted);
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
});

test('a read-only runtime folder preserves the footer when user files cannot be moved', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const { home, runtime, config, backup, original, manage } = await fixture(t);
  assertSuccess(manage('install'));
  const originalBackup = await readFile(backup, 'utf8');
  const lib = join(runtime, 'lib');
  const note = join(lib, 'note.txt');
  await writeFile(note, 'user data');
  await chmod(lib, 0o500);
  try {
    const result = manage('uninstall', { source: runtime });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /EACCES|EPERM/);
  } finally {
    await chmod(lib, 0o700);
  }
  assert.equal(await readFile(note, 'utf8'), 'user data');
  assert.equal(await readFile(backup, 'utf8'), originalBackup);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, STATUS_LINE);

  const rejected = manage('uninstall', {
    source: runtime, additionalEnv: { CODEX_HUD_TEST_REJECT_WRITE: '1' },
  });
  assert.equal(rejected.status, 1, rejected.output);
  assert.match(rejected.output, /fixture refused footer write/);
  assert.equal(await readFile(note, 'utf8'), 'user data');
  assert.equal(await readFile(backup, 'utf8'), originalBackup);
  assert.equal((await readdir(home)).some(name => name.startsWith('.codex-hud-runtime-')), false);

  assertSuccess(manage('uninstall', { source: runtime }));
  assert.equal(await readFile(note, 'utf8'), 'user data');
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
});

test('leaves a manual directory created during configuration intact', async (t) => {
  const { runtime, config, original, manage } = await fixture(t);
  const result = manage('install', { additionalEnv: { CODEX_HUD_TEST_CREATE_RUNTIME: '1' } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /非 Codex HUD 运行文件/);
  assert.deepEqual(await readdir(runtime), []);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
});

test('a failed online publication preserves a previously installed manual backup', async t => {
  const { temp, home, runtime, config, backup, original, run } = await fixture(t);
  const cli = join(root, 'bin', 'codex-hud.mjs');
  assertSuccess(run(cli, ['install']));
  const saved = await readFile(backup, 'utf8');

  const preload = join(temp, 'create runtime during preparation.cjs');
  const transaction = join(await realpath(home), transactionName);
  await writeFile(preload, `
const fs = require('node:fs');
const { renameSync } = fs;
fs.renameSync = (from, to) => {
  renameSync(from, to);
  if (to === ${JSON.stringify(transaction)} && JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'preparing') {
    fs.mkdirSync(${JSON.stringify(runtime)});
  }
};
require('node:module').syncBuiltinESMExports();
`);
  const result = run(join(root, 'scripts', 'manage.mjs'), ['install'], {}, ['--require', preload]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /非 Codex HUD 运行文件/u);
  assert.deepEqual(await readdir(runtime), []);
  assert.equal(await readFile(backup, 'utf8'), saved);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).tui.status_line, STATUS_LINE);
  assertSuccess(run(cli, ['uninstall']));
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
});
