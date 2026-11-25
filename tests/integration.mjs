import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from './run-cli.mjs';

function createWorkspace(t, { linkedHome = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'codex hud 验证 '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'Codex 配置');
  const cwd = join(temp, '测试 项目');
  mkdirSync(home);
  mkdirSync(cwd);
  const homePath = linkedHome ? join(temp, '配置 链接') : home;
  if (linkedHome) symlinkSync(home, homePath, process.platform === 'win32' ? 'junction' : 'dir');
  const env = { ...process.env, CODEX_HOME: homePath };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_AUTH_JSON;

  return {
    config: join(home, 'config.toml'),
    cwd,
    run(...args) {
      const result = runCli(temp, args, { cwd, env, timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
  };
}

test('native Codex config preserves settings and restores the status line in a linked Codex home', (t) => {
  const { config, run } = createWorkspace(t, { linkedHome: true });
  writeFileSync(config, '# 原有配置\r\n[tui]\r\nnotifications = false\r\nstatus_line = ["model"]\r\n');

  run('install');
  run('install');
  const installed = readFileSync(config, 'utf8');
  assert.match(installed, /status_line\s*=\s*\[[^\]]*"model-with-reasoning"[^\]]*"context-used"[^\]]*\]/s);
  assert.match(run('doctor'), /tui\.status_line = \[[^\]]*"model-with-reasoning"/);

  run('uninstall');
  const restored = readFileSync(config, 'utf8');
  assert.match(restored, /status_line\s*=\s*\[\s*"model"\s*,?\s*\]/);
  assert.match(restored, /notifications\s*=\s*false/);
  assert.match(restored, /# 原有配置/);
});

test('uninstall removes a status line introduced by Codex HUD', (t) => {
  const { config, run } = createWorkspace(t);
  writeFileSync(config, '[tui]\nnotifications = false\n');
  run('install');
  run('uninstall');
  const restored = readFileSync(config, 'utf8');
  assert.doesNotMatch(restored, /status_line/);
  assert.match(restored, /notifications\s*=\s*false/);
});

test('redirected watch prints one snapshot for the requested workspace', (t) => {
  const { cwd, run } = createWorkspace(t);
  for (const command of ['status', 'watch']) {
    const snapshot = run(command, '--cwd', cwd);
    assert.equal(snapshot.match(/测试 项目.*没有已记录的会话/g)?.length, 1);
    assert.equal(snapshot.match(/^内存/gm)?.length, 1);
    assert.doesNotMatch(snapshot, /\u001b/);
  }
});
