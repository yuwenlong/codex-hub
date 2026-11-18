import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from './run-cli.mjs';

test('help and preview run without Codex on PATH or a Codex home', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex hub '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  const env = { PATH: '', CODEX_HOME: home };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  const run = (command) => {
    const result = runCli(temp, [command], { env, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  const help = run('--help');
  for (const command of ['install', 'uninstall', 'doctor', 'preview', 'status', 'watch']) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }
  assert.match(run('--version').trim(), /^\d+\.\d+\.\d+$/);
  const preview = run('preview');
  assert.match(preview, /\S/);
  assert.doesNotMatch(preview, /\u001b/);
  assert.equal(existsSync(home), false);
});

test('invalid command lines fail before opening a Codex connection', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex hub '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const args of [['status', '--thread'], ['install', '--cwd', '.'], ['unknown']]) {
    const result = runCli(temp, args, { timeout: 5000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^codex-hub: /);
  }
});

test('fresh Codex home reports empty state without creating the directory', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex hub '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'first run', 'Codex 配置');
  const env = { PATH: '', CODEX_HOME: home };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  const run = (args, extraEnv = {}) => runCli(temp, args, { env: { ...env, ...extraEnv }, timeout: 5000 });

  for (const [command, message] of [
    ['status', /没有.*会话/],
    ['watch', /没有.*会话/],
    ['doctor', /tui\.status_line = （未设置）/],
    ['uninstall', /无需还原/],
  ]) {
    const result = run([command]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, message);
  }
  const threadId = '01234567-89ab-4cde-8123-456789abcdef';
  for (const result of [run(['status', '--thread', threadId]), run(['watch'], { CODEX_THREAD_ID: threadId })]) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /无法读取指定的 Codex 会话/);
  }
  assert.equal(existsSync(home), false);
});
