import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const rawBase = 'https://raw.githubusercontent.com/yuwenlong/codex-hub/main';
const bashOnly = { skip: process.platform === 'win32' };
const marker = '.codex-hub-managed';
const transaction = '.codex-hub-transaction.json';
const ownership = 'codex-hub-runtime-v1\n';
const manifest = `${ownership}package.json\nLICENSE\nbin/codex-hub.mjs\nscripts/manage.mjs\nlib/activity.mjs\nlib/app-server.mjs\nlib/installation.mjs\n`;
const manager = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(process.argv.slice(1)) + '\\n');
process.exit(Number(process.env.FIXTURE_STATUS ?? 0));
`;

function managedRuntime(home) {
  const runtime = join(home, 'codex-hub');
  for (const name of manifest.trim().split('\n').slice(1)) {
    const path = join(runtime, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, name === 'scripts/manage.mjs' ? manager : '');
  }
  writeFileSync(join(runtime, marker), manifest);
  return runtime;
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-hub online 中文 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const temp = join(root, 'temp');
  const home = join(root, '.codex');
  const release = join(root, 'release');
  for (const path of [bin, temp, home, join(release, 'scripts')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(release, 'scripts', 'manage.mjs'), manager);
  const archive = join(root, 'codex-hub.zip');
  const git = async (...args) => (await exec('git', args, { cwd: release })).stdout.trim();
  await git('init', '-q');
  await git('add', 'scripts/manage.mjs');
  await git('archive', '--format=zip', '--prefix=codex-hub/', '--output', archive, await git('write-tree'));

  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
args=()
for arg; do
  case "$arg" in
    ${rawBase}/scripts/install.sh) arg="$FIXTURE_INSTALL_URL" ;;
    ${rawBase}/uninstall.sh) arg="$FIXTURE_UNINSTALL_URL" ;;
    https://github.com/yuwenlong/codex-hub/releases/latest/download/codex-hub.zip) arg="$FIXTURE_ARCHIVE_URL" ;;
  esac
  if [[ "$arg" == fixture:partial ]]; then
    printf '%s\\n' 'printf ran > "$CODEX_HOME/partial-ran"'
    exit 18
  fi
  args+=("$arg")
done
exec "$FIXTURE_CURL" "\${args[@]}"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const log = join(root, 'calls');
  const env = {
    ...process.env,
    CODEX_HOME: home,
    HOME: root,
    PATH: [bin, process.env.PATH].join(delimiter),
    TMPDIR: temp,
    FIXTURE_ARCHIVE_URL: pathToFileURL(archive).href,
    FIXTURE_CALLS: log,
    FIXTURE_CURL: (await exec('bash', ['-c', 'command -v curl'])).stdout.trim(),
    FIXTURE_INSTALL_URL: new URL('../scripts/install.sh', import.meta.url).href,
    FIXTURE_UNINSTALL_URL: new URL('../uninstall.sh', import.meta.url).href,
  };
  return {
    archive, home, root, temp,
    async launch(entry, overrides, readme = 'README.md') {
      const docs = readFileSync(new URL(`../${readme}`, import.meta.url), 'utf8');
      const command = docs.split(/\r?\n/u).find(line => line.includes(`curl -fsSL ${rawBase}/${entry}`));
      assert.ok(command, `Missing Bash command for ${entry} in ${readme}`);
      try {
        const { stderr } = await exec('bash', ['-c', command], {
          cwd: root, env: { ...env, ...overrides }, timeout: 20_000,
        });
        return { status: 0, stderr };
      } catch (error) {
        if (typeof error.code !== 'number') throw error;
        return { status: error.code, stderr: error.stderr };
      }
    },
    calls() {
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    },
  };
}

test('Bash README commands reject missing, empty, and truncated entry scripts', bashOnly, async t => {
  const run = await fixture(t);
  const empty = join(run.root, 'empty.sh');
  writeFileSync(empty, '');
  for (const readme of ['README.md', 'README_zh.md']) {
    for (const entry of ['scripts/install.sh', 'uninstall.sh']) {
      const entryUrl = entry === 'uninstall.sh' ? 'FIXTURE_UNINSTALL_URL' : 'FIXTURE_INSTALL_URL';
      for (const url of [pathToFileURL(join(run.root, 'missing.sh')).href, pathToFileURL(empty).href, 'fixture:partial']) {
        const result = await run.launch(entry, { [entryUrl]: url }, readme);
        assert.notEqual(result.status, 0, `${readme} ${entry} accepted ${url}`);
        assert.equal(existsSync(join(run.home, 'partial-ran')), false);
      }
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
  assert.ok(script.startsWith(`${run.temp}/`) && script.endsWith('/codex-hub/scripts/manage.mjs'), script);
  assert.deepEqual(readdirSync(run.temp), []);
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
  writeFileSync(join(run.home, 'codex-hub-statusline.json'), '{}');
  const result = await run.launch('uninstall.sh', { CODEX_HOME: '', FIXTURE_ARCHIVE_URL: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(run.calls(), [[script, 'uninstall']]);
});

test('Bash online uninstall uses the release if local runtime files are missing', bashOnly, async t => {
  const run = await fixture(t);
  const backup = join(run.home, 'codex-hub-statusline.json');
  for (const name of ['bin/codex-hub.mjs', 'lib/app-server.mjs', 'lib/installation.mjs', 'package.json', 'lib']) {
    const runtime = managedRuntime(run.home);
    if (name === 'bin/codex-hub.mjs') writeFileSync(backup, '{}');
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
  writeFileSync(join(run.home, 'codex-hub-statusline.json'), JSON.stringify({
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
  writeFileSync(join(run.home, 'codex-hub-statusline.json'), '{}');
  const result = await run.launch('uninstall.sh', { FIXTURE_STATUS: '23' });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(run.calls(), [[join(runtime, 'scripts', 'manage.mjs'), 'uninstall']]);
});

test('Bash online uninstall downloads the release for a legacy backup and ignores a linked manager', bashOnly, async t => {
  const run = await fixture(t);
  const runtime = join(run.home, 'codex-hub');
  const linkedManager = join(run.root, 'unrelated.mjs');
  mkdirSync(join(runtime, 'scripts'), { recursive: true });
  writeFileSync(linkedManager, 'process.exit(24);');
  symlinkSync(linkedManager, join(runtime, 'scripts', 'manage.mjs'));
  writeFileSync(join(runtime, marker), manifest);
  writeFileSync(join(run.home, 'codex-hub-statusline.json'), '{}');
  const result = await run.launch('uninstall.sh');
  assert.equal(result.status, 0, result.stderr);
  const [[script, action]] = run.calls();
  assert.equal(action, 'uninstall');
  assert.ok(script.startsWith(`${run.temp}/`), script);
  assert.deepEqual(readdirSync(run.temp), []);
});

test('Bash online uninstall ignores a manager absent from the ownership manifest', bashOnly, async t => {
  const run = await fixture(t);
  const runtime = join(run.home, 'codex-hub');
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
