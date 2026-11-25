import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from './run-cli.mjs';

test('help and preview run without Codex on PATH or a Codex home', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex hud '));
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
  assert.match(preview, /^\[.+ ● .+\] │ .*示例/);
  assert.match(preview, /上下文 ███░░░░░░░ 32%/);
  assert.doesNotMatch(preview, /\u001b/);
  assert.equal(existsSync(home), false);
});

test('invalid command lines fail before opening a Codex connection', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex hud '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const args of [['status', '--thread'], ['install', '--cwd', '.'], ['unknown']]) {
    const result = runCli(temp, args, { timeout: 5000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^codex-hud: /);
  }
});

test('native status line install detects a legacy backup before opening Codex', t => {
  const home = mkdtempSync(join(tmpdir(), 'codex hud migration '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const backup = join(home, 'codex-hub-statusline.json');
  writeFileSync(backup, '{"version":1,"original":["model"],"applied":["project-name"]}');
  const env = { PATH: '', CODEX_HOME: home };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;

  const result = runCli(home, ['install'], { env, timeout: 5000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /codex-hub-statusline\.json.*README/u);
  assert.equal(existsSync(join(home, 'codex-hud-statusline.json')), false);
});

test('fresh Codex home reports empty state without creating the directory', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex hud '));
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

test('status and redirected watch include a reported cost in the first snapshot', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'codex hud cost '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  const id = '01234567-89ab-4cde-8123-456789abcdef';
  const path = join(home, 'sessions', `rollout-2026-11-18T12-00-00-${id}.jsonl`);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(path, [
    { type: 'session_meta', payload: { id } },
    { type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'enterprise' } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');

  const server = `
const { createReadStream, writeSync } = require('node:fs');
require('node:readline').createInterface({ input: createReadStream(null, { fd: 0 }) }).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  const thread = ${JSON.stringify({ id, path, cwd: temp, model: 'fixture-model' })};
  const reply = result => writeSync(1, JSON.stringify({ id, result }) + '\\n');
  if (method === 'account/usage/read') {
    setTimeout(() => reply({ threadUsage: { threadId: thread.id, estimatedUsageUsdMicros: 12340000 } }), 40);
  } else {
    reply(method === 'thread/read' ? { thread } : { data: [] });
  }
});`;
  const env = { ...process.env, PATH: temp, CODEX_HOME: home, CODEX_HUD_TEST_NODE: process.execPath };
  if (process.platform === 'win32') {
    const bin = join(temp, 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(temp, 'codex.cmd'), '@exit /b 17\r\n');
    writeFileSync(join(bin, 'codex.js'), server);
  } else {
    env.CODEX_HUD_TEST_SERVER = join(temp, 'fixture.cjs');
    writeFileSync(env.CODEX_HUD_TEST_SERVER, server);
    writeFileSync(join(temp, 'codex'), '#!/bin/sh\nexec "$CODEX_HUD_TEST_NODE" "$CODEX_HUD_TEST_SERVER" "$@"\n', { mode: 0o700 });
  }

  for (const command of ['status', 'watch']) {
    const result = runCli(temp, [command, '--thread', id], { cwd: temp, env, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\[fixture-model\].*费用 \$12\.34$/m);
  }
});
