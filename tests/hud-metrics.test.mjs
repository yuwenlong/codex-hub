import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readActivity } from '../lib/activity.mjs';
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
  assert.deepEqual(metrics.limits, { fiveHour: { remainingPercent: 64.5, usedPercent: 35.5, resetsAt } });
  assert.ok(metrics.memory.total > 0);
  assert.ok(metrics.memory.used >= 0 && metrics.memory.used <= metrics.memory.total);
});

const rateEpoch = Date.UTC(2026, 10, 18, 19, 10);
const rateRecord = (time, type, payload) => JSON.stringify({ timestamp: new Date(rateEpoch + time).toISOString(), type, payload });
const rateEvent = (time, type, payload) => rateRecord(time, 'event_msg', { type, ...payload });

function timedReply(turnId, { start = 10_000, end = 11_000, messageId = 'msg-final', threadId = id } = {}) {
  const text = 'Fixture answer';
  return [rateEvent(end, 'item_completed', {
    turn_id: turnId, thread_id: threadId, started_at_ms: rateEpoch + start, completed_at_ms: rateEpoch + end,
    item: { type: 'AgentMessage', id: messageId, content: [{ type: 'Text', text }] },
  }), rateRecord(end + 1, 'response_item', {
    type: 'message', role: 'assistant', status: 'completed', id: messageId, content: [{ type: 'output_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  })];
}

function responseUsage(turnId, { responseId = 'resp-final', start = 11_005, output = 50, reasoning = 10 } = {}) {
  return rateRecord(start, 'token_usage_record', {
    thread_id: id, turn_id: turnId, response_id: responseId,
    usage: { input_tokens: 1800, cached_input_tokens: 1000, output_tokens: output, reasoning_output_tokens: reasoning },
    turn_token_usage: { output_tokens: 560 }, thread_token_usage: { output_tokens: 8000 },
  });
}

test('measures the final text response using its own output and item duration after a tool wait', async t => {
  const { cwd, home, path } = await fixture(t);
  const turnId = 'turn-1';
  const thread = { id, path, cwd };
  const opts = { cwd, home };
  const activity = latestId => readActivity({
    async request(method) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/turns/list') return { data: [{ id: latestId, status: 'completed' }] };
      return { data: [] };
    },
  }, { ...opts, threadId: id });
  const records = [meta, rateEvent(0, 'task_started', { turn_id: turnId }),
    ...timedReply(turnId, { start: 100, end: 200, messageId: 'msg-commentary' }),
    rateRecord(205, 'response_item', { type: 'function_call' }),
    responseUsage(turnId, { responseId: 'resp-tool', start: 208, output: 510, reasoning: 0 }),
    rateRecord(9500, 'response_item', { type: 'function_call_output' }),
    tokenEvent({ total_token_usage: { output_tokens: 7950 } }, null),
    rateRecord(9505, 'response_item', { type: 'agent_message', author: 'worker', recipient: 'parent',
      content: [{ type: 'input_text', text: 'Fixture context' }] }),
    rateRecord(9600, 'response_item', { type: 'reasoning' }),
    ...timedReply(turnId), responseUsage(turnId),
    tokenEvent({ total_token_usage: { output_tokens: 8000 } }, null),
    rateEvent(11_300, 'task_complete', { turn_id: turnId, duration_ms: 11_300, time_to_first_token_ms: 100 }), ''];
  await writeFile(path, records.join('\n'));

  const expected = { turnId, tokensPerSecond: 40 };
  const sample = await readHudMetrics(null, thread, opts);
  assert.equal(sample.tokens.output, 8000);
  assert.deepEqual(sample.outputRate, expected);
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, expected);
  assert.equal((await activity(turnId)).outputTokensPerSecond, 40);
  assert.equal((await activity('turn-2')).outputTokensPerSecond, undefined);

  const next = 'turn-2';
  await appendFile(path, [rateEvent(12_000, 'task_started', { turn_id: next }),
    rateRecord(12_001, 'response_item', { type: 'additional_tools', role: 'developer', tools: [] }), ''].join('\n'));
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);
  await appendFile(path, [...timedReply(next, { start: 12_500, end: 13_250 }), ''].join('\n'));
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);
  await appendFile(path, responseUsage(next, { start: 13_255, output: 6, reasoning: 0 }) + '\n');
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId: next, tokensPerSecond: 8 });
});

test('omits output rates for incomplete, mixed, and uncorrelated response records', async t => {
  const { cwd, home, path } = await fixture(t);
  const turnId = 'turn-1';
  const reply = timedReply(turnId);
  const usage = responseUsage(turnId);
  const tool = rateRecord(9700, 'response_item', { type: 'function_call' });
  const aborted = rateEvent(12_000, 'turn_aborted', { turn_id: turnId });
  const cases = [
    ['aggregated usage only', ...reply, tokenEvent({ total_token_usage: { output_tokens: 50 } }, null)],
    ['mixed tool call', tool, ...reply, usage],
    ['multiple assistant items', ...timedReply(turnId, { start: 8500, end: 9000, messageId: 'msg-first' }), ...reply, usage],
    ['later usage with no matching text', ...reply, tokenEvent({ total_token_usage: { output_tokens: 50 } }, null), usage],
    ['later reasoning response', ...reply, rateRecord(11_003, 'response_item', { type: 'reasoning' }), usage],
    ['duplicate usage', ...reply, usage, usage],
    ['missing message', usage],
    ['invalid receipt timestamp', ...reply, JSON.stringify({ ...JSON.parse(usage), timestamp: { toString: null } })],
    ['latest receipt missing payload', ...reply, usage, rateRecord(12_000, 'token_usage_record', null)],
    ['untimed message', ...timedReply(turnId, { start: 11_000 }), usage],
    ['no text tokens', ...reply, responseUsage(turnId, { output: 10 })],
    ['incorrect thread', ...timedReply(turnId, { threadId: 'other' }), usage],
    ['incorrect turn', ...reply, responseUsage('other')],
    ['later message missing usage', ...reply, usage, ...timedReply(turnId, { start: 12_000, end: 12_500 })],
    ['aborted turn', ...reply, usage, aborted],
  ];
  for (const [name, ...records] of cases) {
    const cumulative = tokenEvent({ total_token_usage: { output_tokens: 8000 } }, null);
    await writeFile(path, [meta, rateEvent(0, 'task_started', { turn_id: turnId }), ...records, cumulative, ''].join('\n'));
    const metrics = await readHudMetrics(null, { id, path }, { cwd, home });
    assert.equal(metrics.outputRate, undefined, name);
    assert.equal(metrics.tokens?.output, 8000, name);
  }
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

test('fetches measured account quota groups once in the background for related official sessions', { timeout: 1500 }, async t => {
  const { cwd, home, path } = await fixture(t);
  const now = 1795000000;
  t.mock.method(Date, 'now', () => now * 1000);
  const release = Promise.withResolvers();
  const windows = (usedPercent, windowDurationMins, resetsAt = null) => ({ usedPercent, windowDurationMins, resetsAt });
  let reads = 0;
  const client = { async request(method, params, options) {
    if (method === 'config/read') return { config: { model_provider: 'openai' } };
    if (method !== 'account/rateLimits/read') throw new Error('Unsupported fixture request');
    assert.deepEqual(params, {});
    assert.equal(options.timeoutMs, 1500);
    reads++;
    return release.promise;
  } };
  const local = tokenEvent(null, { primary: { used_percent: 15, window_minutes: 300, resets_at: now + 100 } });
  await writeFile(path, `${meta}\n${local}\n`);
  const thread = { id, path, modelProvider: 'openai' };
  const options = { cwd, home };
  const [initial, other] = await Promise.all([readHudMetrics(client, thread, options), readHudMetrics(client, { ...thread, id: 'another' }, options)]);
  assert.equal(initial.limits.fiveHour.remainingPercent, 85);
  assert.equal(initial.quotaGroups, undefined);
  assert.equal(other.quotaGroups, undefined);
  assert.equal(reads, 1);
  release.resolve({
    rateLimitsByLimitId: {
      alias: { limitId: 'codex', limitName: 'Alias', primary: windows(2, 300), secondary: windows(0.07, 10_080) },
      codex: { limitId: 'codex', limitName: 'Codex', primary: windows(93, 300, now + 300), secondary: windows(100, 10_080) },
      spark: { limitId: 'spark', primary: windows(0.001, 300), secondary: windows(50, null) },
      trial: { limitId: 'trial', limitName: 'Trial', primary: windows(0.07, 120) },
      expired: { primary: windows(2, 300, now) },
      invalid: { primary: windows(101, 300), secondary: windows(50, -1) },
    },
    rateLimits: { limitId: 'codex', limitName: 'Legacy', primary: windows(90, 300, now + 600) },
  });
  const current = await readHudMetrics(client, thread, { ...options, waitForCost: true });
  assert.deepEqual(current.quotaGroups, [
    { id: 'codex', name: 'Codex', windows: [
      { minutes: 300, usedPercent: 93, remainingPercent: 7, resetsAt: now + 300 },
      { minutes: 10_080, usedPercent: 100, remainingPercent: 0, resetsAt: undefined },
    ] },
    { id: 'spark', name: undefined, windows: [{ minutes: 300, usedPercent: 0.001, remainingPercent: 99.99, resetsAt: undefined }] },
    { id: 'trial', name: 'Trial', windows: [{ minutes: 120, usedPercent: 0.07, remainingPercent: 99.93, resetsAt: undefined }] },
  ]);
  const custom = await readHudMetrics(client, { ...thread, modelProvider: 'local' }, options);
  assert.equal(custom.quotaGroups, undefined);
  assert.equal(custom.limits.fiveHour.remainingPercent, 85);
  assert.equal((await readHudMetrics(client, undefined, options)).quotaGroups, undefined);
  assert.equal(reads, 1);
});

test('uses official legacy quotas and falls back to local data after a failed refresh', async t => {
  const { cwd, home, path } = await fixture(t);
  let now = 1795000000;
  t.mock.method(Date, 'now', () => now * 1000);
  let reads = 0;
  const client = { async request(method) {
    if (method === 'config/read') return { config: {} };
    if (method !== 'account/rateLimits/read') throw new Error('Unsupported fixture request');
    reads++;
    if (reads > 1) throw new Error('offline');
    return { rateLimitsByLimitId: {}, rateLimits: {
      limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: now + 90 },
    } };
  } };
  const local = tokenEvent(null, { primary: { used_percent: 90.01, window_minutes: 300, resets_at: now + 600 } });
  await writeFile(path, `${meta}\n${local}\n`);
  const thread = { id, path, modelProvider: 'openai' };
  const options = { cwd, home, waitForCost: true };
  const initial = await readHudMetrics(client, thread, options);
  assert.equal(initial.quotaGroups[0].windows[0].remainingPercent, 99);
  assert.equal(initial.limits.fiveHour.remainingPercent, 9.99);
  now += 90;
  const offline = await readHudMetrics(client, thread, options);
  assert.equal(offline.quotaGroups, undefined);
  assert.equal(offline.limits.fiveHour.remainingPercent, 9.99);
  await readHudMetrics(client, thread, options);
  assert.equal(reads, 2);
});

test('a configured custom provider suppresses account quotas on an old OpenAI thread', async t => {
  const { cwd, home, path } = await fixture(t);
  let accountReads = 0;
  const client = { async request(method) {
    if (method === 'config/read') return { config: { model_provider: 'local_provider' } };
    if (method === 'account/rateLimits/read') accountReads++;
    return {};
  } };
  await writeFile(path, `${meta}\n${tokenEvent(null, { primary: { used_percent: 23, window_minutes: 300 } })}\n`);
  const thread = { id, path, modelProvider: 'openai' };
  const local = await readHudMetrics(client, thread, { cwd, home, waitForCost: true });
  assert.equal(local.limits.fiveHour.remainingPercent, 77);
  assert.equal(local.quotaGroups, undefined);
  assert.equal(accountReads, 0);
});

test('account quotas wait for a known effective provider and follow a provider switch in either direction', async t => {
  const { cwd, home, path } = await fixture(t);
  let now = 1795000000;
  t.mock.method(Date, 'now', () => now * 1000);
  let provider;
  let configReads = 0;
  let accountReads = 0;
  const client = { async request(method) {
    if (method === 'config/read') {
      configReads++;
      if (provider === undefined) throw new Error('Codex config/read timed out');
      return { config: { model_provider: provider, model_providers: { alternate: { name: 'Alternate' } } } };
    }
    if (method === 'account/rateLimits/read') {
      accountReads++;
      return { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 } } };
    }
    return { data: [] };
  } };
  await writeFile(path, `${meta}\n${tokenEvent(null, { primary: { used_percent: 23, window_minutes: 300 } })}\n`);
  const thread = { id, path, modelProvider: 'openai' };
  const read = () => readHudMetrics(client, thread, { cwd, home, waitForCost: true });
  const unconfirmed = await read();
  assert.equal(unconfirmed.quotaGroups, undefined);
  assert.equal(unconfirmed.limits.fiveHour.remainingPercent, 77);
  assert.equal(accountReads, 0);
  await read();
  assert.equal(configReads, 1);
  provider = null;
  now += 31;
  assert.equal((await read()).quotaGroups[0].windows[0].remainingPercent, 97);
  assert.equal(accountReads, 1);
  provider = 'alternate';
  now += 31;
  assert.equal((await read()).quotaGroups, undefined);
  assert.equal(accountReads, 1);
  provider = 'openai';
  now += 31;
  assert.equal((await read()).quotaGroups[0].windows[0].remainingPercent, 97);
  assert.equal(accountReads, 2);
  assert.equal(configReads, 4);
});

test('a cached response reselects a live alias or the legacy bucket as windows expire', async t => {
  const { cwd, home } = await fixture(t);
  const start = 1795000000;
  let now = start;
  t.mock.method(Date, 'now', () => now * 1000);
  let requests = 0;
  const bucket = (limitId, usedPercent, offset) => ({ limitId, primary: {
    usedPercent, windowDurationMins: 300, resetsAt: start + offset,
  } });
  const client = { async request(method) {
    if (method === 'config/read') return { config: { model_provider: 'openai' } };
    if (method === 'account/rateLimits/read') {
      requests++;
      return { rateLimitsByLimitId: {
        canonical: bucket('canonical', 1, 10), alias: bucket('canonical', 5, 30), other: bucket('other', 10, 25),
      }, rateLimits: bucket('legacy', 40, 120) };
    }
    return {};
  } };
  const read = () => readHudMetrics(client, { id, modelProvider: 'openai' }, { cwd, home, waitForCost: true });
  const values = async () => (await read()).quotaGroups.map(({ id, windows: [window] }) => [id, window.remainingPercent, window.resetsAt - start]);
  assert.deepEqual(await values(), [['canonical', 99, 10], ['other', 90, 25]]);
  now = start + 10;
  assert.deepEqual(await values(), [['canonical', 95, 30], ['other', 90, 25]]);
  now = start + 25;
  assert.deepEqual(await values(), [['canonical', 95, 30]]);
  now = start + 30;
  assert.deepEqual(await values(), [['legacy', 60, 120]]);
  assert.equal(requests, 1);
});

test('the built-in provider needs an official effective endpoint before reading account quotas', async t => {
  const { cwd, home } = await fixture(t);
  const saved = process.env.OPENAI_BASE_URL;
  t.after(() => {
    if (saved === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved;
  });
  const official = 'https://api.openai.com/v1';
  const httpProxy = 'http://127.0.0.1:9/private-model';
  const thread = { id, modelProvider: 'openai' };
  const cases = [
    [{}, undefined, true],
    [{ openai_base_url: official }, undefined, true],
    [{ openai_base_url: 'https://api.openai.com:443/v1/' }, undefined, true],
    [{ openai_base_url: 'https://chatgpt.com/backend-api/codex/' }, undefined, true],
    [{ chatgpt_base_url: 'https://chatgpt.com/backend-api/' }, undefined, true],
    [{ openai_base_url: httpProxy }, undefined, false],
    [{ openai_base_url: 'https://api.openai.com.example.invalid/v1' }, undefined, false],
    [{ openai_base_url: 'https://api.openai.com@alternate.invalid/v1' }, undefined, false],
    [{ openai_base_url: 'https://api.openai.com:8443/v1' }, undefined, false],
    [{ chatgpt_base_url: httpProxy }, undefined, false],
    [{}, httpProxy, true],
    [{}, official, true],
    [{ openai_base_url: official }, httpProxy, true],
    [{ openai_base_url: httpProxy }, official, false],
  ];
  for (const [index, [config, env, enabled]] of cases.entries()) {
    if (env === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = env;
    let requests = 0;
    const client = { async request(method) {
      if (method === 'config/read') return { config: { model_provider: 'openai', ...config } };
      if (method === 'account/rateLimits/read') {
        requests++;
        return { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 } } };
      }
      return {};
    } };
    const result = await readHudMetrics(client, thread, { cwd, home, waitForCost: true });
    assert.equal(requests, enabled ? 1 : 0, `endpoint scenario ${index}`);
    assert.equal(result.quotaGroups?.[0].windows[0].remainingPercent, enabled ? 97 : undefined);
  }
});
