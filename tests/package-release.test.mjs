import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bundledDependencyFiles, dependencyLicenses } from '../lib/runtime-deps.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

test('release ZIP adds the locked prebuilds for all six platforms to a Git tree', async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), 'codex hud release '));
  t.after(() => rm(checkout, { force: true, recursive: true }));
  const releaseScript = 'scripts/package-release.mjs';
  const tracked = ['lib/runtime-deps.mjs', 'package.json', 'package-lock.json', ...dependencyLicenses];
  for (const name of [...tracked, ...bundledDependencyFiles]) {
    const destination = join(checkout, name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, name), destination);
  }
  const run = async (command, args) => (await exec(command, args, { cwd: checkout })).stdout.trim();

  await run('git', ['init', '-q']);
  await run('git', ['add', '--', ...tracked]);
  const tree = await run('git', ['write-tree']);
  const archive = join(checkout, 'codex-hud.zip');
  await run(process.execPath, [join(root, releaseScript), archive, tree]);
  const zip = await readFile(archive);
  for (const path of [
    'node_modules/@xterm/headless/lib-headless/xterm-headless.js',
    'node_modules/node-addon-api/LICENSE.md',
    'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
    'node_modules/node-pty/prebuilds/linux-arm64/pty.node',
    'node_modules/node-pty/prebuilds/linux-x64/pty.node',
    'node_modules/node-pty/prebuilds/win32-arm64/conpty/conpty.dll',
    'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
    'licenses/xterm-headless.txt',
  ]) assert.ok(zip.includes(`codex-hud/${path}`), path);
  assert.ok(!zip.includes('.pdb'));
});
