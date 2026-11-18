import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readHudMetrics } from '../lib/hud-metrics.mjs';

const id = '1d6c11c9-f1c6-4d02-ae28-a8748071da01';
const meta = JSON.stringify({ type: 'session_meta', payload: { id } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-hub metrics '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const sessions = join(home, 'sessions', '2026', '11', '18');
  const project = join(root, 'project');
  const cwd = join(project, 'child');
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(cwd, { recursive: true })]);
  return { root, cwd, home, project, path: join(sessions, `rollout-2026-11-18T19-10-00-${id}.jsonl`) };
}

function tokenEvent(info, rate_limits) {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info, rate_limits } });
}

test('reports local context and cumulative token usage without waiting for a model request', async t => {
  const { cwd, home, path } = await fixture(t);
  const resetsAt = Math.floor(Date.now() / 1000) + 900;
  const expiredAt = resetsAt - 1000;
  const latest = tokenEvent({
    model_context_window: 125000,
    last_token_usage: { total_tokens: 40000 },
    total_token_usage: { total_tokens: 19000, input_tokens: 18000, output_tokens: 1000, cached_input_tokens: 14000 },
  }, {
    primary: { used_percent: 35.5, window_minutes: 300, resets_at: resetsAt },
    secondary: { used_percent: 1, window_minutes: 10080, resets_at: expiredAt },
  });
  await writeFile(path, [meta, JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(700000) } }),
    latest, '{"type":"event_msg","pay'].join('\n'));
  const metrics = await readHudMetrics(null, { id, path }, { cwd, home });
  assert.equal(metrics.contextPercent, 25);
  assert.deepEqual(metrics.tokens, { total: 19000, input: 4000, output: 1000, cached: 14000 });
  assert.deepEqual(metrics.limits, { fiveHour: { remainingPercent: 65, resetsAt } });
  assert.ok(metrics.memory.total > 0);
  assert.ok(metrics.memory.used >= 0 && metrics.memory.used <= metrics.memory.total);
});

test('rounds the context percentage like the native Codex footer', async t => {
  const { cwd, home, path } = await fixture(t);
  for (const [window, used, expected] of [[52000, 25000, 32], [125000, 11000, 0], [10000, 4000, 100]]) {
    const count = tokenEvent({ model_context_window: window, last_token_usage: { total_tokens: used } }, null);
    await writeFile(path, `${meta}\n${count}\n`);
    const metrics = await readHudMetrics(null, { id, path }, { cwd, home });
    assert.equal(metrics.contextPercent, expected);
  }
});

test('keeps confirmed usage through large output while each cached limit expires on time', async t => {
  const { cwd, home, path } = await fixture(t);
  const thread = { id, path };
  let now = 1795000000;
  t.mock.method(Date, 'now', () => now * 1000);
  const event = tokenEvent({
    model_context_window: 52000,
    last_token_usage: { total_tokens: 21200 },
    total_token_usage: { total_tokens: 50000 },
  }, {
    primary: { used_percent: 45, window_minutes: 300, resets_at: now + 60 },
    secondary: { used_percent: 8, window_minutes: 10080, resets_at: now + 3600 },
  });
  await writeFile(path, meta + '\n' + event + '\n');
  const initial = await readHudMetrics(null, thread, { cwd, home });
  assert.equal(initial.contextPercent, 23);
  const tools = JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(530000) } });
  await appendFile(path, tools + '\n');
  const next = await readHudMetrics(null, thread, { cwd, home });
  assert.equal(next.contextPercent, 23);
  assert.equal(next.tokens.total, 50000);
  assert.equal(next.limits.fiveHour.remainingPercent, 55);

  now += 60;
  const afterReset = await readHudMetrics(null, thread, { cwd, home });
  assert.equal(afterReset.tokens.total, 50000);
  assert.equal(afterReset.limits.fiveHour, undefined);
  assert.equal(afterReset.limits.weekly.remainingPercent, 92);
});

test('drops cached usage when a rollout is rewritten or replaced', async t => {
  const { cwd, home, path } = await fixture(t);
  const thread = { id, path };
  const event = tokenEvent({ total_token_usage: { total_tokens: 50000 } }, null);
  const withUsage = meta + '\n' + event + '\n';
  const tools = JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(530000) } }) + '\n';
  await writeFile(path, withUsage);
  assert.equal((await readHudMetrics(null, thread, { cwd, home })).tokens.total, 50000);
  await writeFile(path, meta + '\n' + tools);
  assert.equal((await readHudMetrics(null, thread, { cwd, home })).tokens, undefined);

  await writeFile(path, withUsage);
  assert.equal((await readHudMetrics(null, thread, { cwd, home })).tokens.total, 50000);
  const replacement = path + '.replacement';
  await writeFile(replacement, withUsage + tools);
  await rename(replacement, path);
  assert.equal((await readHudMetrics(null, thread, { cwd, home })).tokens, undefined);
});

test('ignores a rollout outside the selected Codex home or belonging to another thread', async t => {
  const { root, cwd, home, path } = await fixture(t);
  const otherPath = join(root, `rollout-2026-11-18T19-10-00-${id}.jsonl`);
  const record = tokenEvent({ total_token_usage: { total_tokens: 100 } }, null);
  await Promise.all([
    writeFile(otherPath, `${meta}\n${record}\n`),
    writeFile(path, `{"type":"session_meta","payload":{"id":"different"}}\n${record}\n`),
  ]);
  for (const invalidPath of [otherPath, path]) {
    const metrics = await readHudMetrics(null, { id, path: invalidPath }, { cwd, home });
    assert.equal(metrics.tokens, undefined);
    assert.ok(metrics.memory.total > 0);
  }
});

test('counts enabled local configuration before the first turn', async t => {
  const { root, cwd, home, project } = await fixture(t);
  await Promise.all([
    mkdir(join(project, '.git')),
    writeFile(join(home, 'AGENTS.md'), 'global'),
    writeFile(join(project, 'AGENTS.md'), 'project'),
    writeFile(join(cwd, 'AGENTS.md'), 'ignored by override'),
    writeFile(join(cwd, 'AGENTS.override.md'), 'child override'),
    writeFile(join(root, 'AGENTS.md'), 'outside the workspace'),
  ]);
  const client = {
    async request(method, params) {
      if (method === 'config/read' && params.cwd === cwd) return { config: {
        project_root_markers: ['.git'], project_doc_max_bytes: 32768,
        mcp_servers: { one: { enabled: true }, two: { enabled: false } },
        agents: {
          enabled: null, max_concurrent_threads_per_session: 6, max_depth: 2,
          reviewer: { description: 'Reviews changes', config_file: null, nickname_candidates: null },
          explorer: { description: 'Finds implementation paths', config_file: 'explorer.toml', nickname_candidates: ['Explorer'] },
        },
      } };
      if (method === 'hooks/list' && params.cwds[0] === cwd) return { data: [{
        cwd, hooks: [{ enabled: true, trustStatus: 'untrusted' }, { enabled: false }], errors: [],
      }] };
      throw new Error('Unsupported fixture request');
    },
  };
  const metrics = await readHudMetrics(client, undefined, { cwd, home });
  assert.deepEqual(metrics.environment, { agentsMd: 3, mcps: 1, hooks: 1, agents: 2 });
});

test('adds a reported thread cost without making other metrics wait', { timeout: 1500 }, async t => {
  const { cwd, home, path } = await fixture(t);
  const release = Promise.withResolvers();
  let requests = 0;
  const client = {
    async request(method, params) {
      if (method === 'account/usage/read' && params.threadId === id) {
        requests++;
        return release.promise;
      }
      throw new Error('Unsupported fixture request');
    },
  };
  await writeFile(path, `${meta}\n${tokenEvent({
    total_token_usage: { total_tokens: 19000 },
  }, { plan_type: 'enterprise' })}\n`);
  const thread = { id, path };
  const initial = await readHudMetrics(client, thread, { cwd, home });
  assert.equal(initial.tokens.total, 19000);
  assert.equal(initial.estimatedCostUsd, undefined);
  release.resolve({ threadUsage: { threadId: id, estimatedUsageUsdMicros: 12340000 } });
  const updated = await readHudMetrics(client, thread, { cwd, home });
  assert.equal(updated.estimatedCostUsd, 12.34);
  assert.equal(requests, 1);
});

test('includes an available thread cost in a one-shot snapshot', async t => {
  const { cwd, home, path } = await fixture(t);
  const client = {
    async request(method, params, options) {
      if (method === 'account/usage/read' && params.threadId === id && options.timeoutMs === 1500) {
        return { threadUsage: { threadId: id, estimatedUsageUsdMicros: 12340000 } };
      }
      throw new Error('Unsupported fixture request');
    },
  };
  await writeFile(path, meta + '\n' + tokenEvent(null, { plan_type: 'enterprise' }) + '\n');
  const snapshot = await readHudMetrics(client, { id, path }, { cwd, home, waitForCost: true });
  assert.equal(snapshot.estimatedCostUsd, 12.34);
});
