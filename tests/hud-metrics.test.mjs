import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readActivity } from '../lib/activity.mjs';
import { confirmedRecord, readHudMetrics } from '../lib/hud-metrics.mjs';

const id = '1d6c11c9-f1c6-4d02-ae28-a8748071da01';
const meta = JSON.stringify({ type: 'session_meta', payload: { id } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-hud metrics '));
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

function timedReply(turnId, { start = 10_000, end = 11_000, messageId = 'msg-final', threadId = id, phase } = {}) {
  const text = 'Fixture answer';
  return [rateEvent(end, 'item_completed', {
    turn_id: turnId, thread_id: threadId, started_at_ms: rateEpoch + start, completed_at_ms: rateEpoch + end,
    item: { type: 'AgentMessage', id: messageId, content: [{ type: 'Text', text }] },
  }), rateRecord(end + 1, 'response_item', {
    type: 'message', role: 'assistant', status: 'completed', id: messageId, content: [{ type: 'output_text', text }],
    ...(phase && { phase }),
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  })];
}

function responseUsage(turnId, { responseId = 'resp-final', start = 11_005, output = 50, reasoning = 10, threadId = id } = {}) {
  return rateRecord(start, 'token_usage_record', {
    thread_id: threadId, turn_id: turnId, response_id: responseId,
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
  assert.equal((await activity('turn-2')).outputTokensPerSecond, 40);

  const next = 'turn-2';
  await appendFile(path, [rateEvent(12_000, 'task_started', { turn_id: next }),
    rateRecord(12_001, 'response_item', { type: 'additional_tools', role: 'developer', tools: [] }), ''].join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, expected);
  await appendFile(path, [
    ...timedReply(next, { start: 12_100, end: 12_200, messageId: 'msg-tool-commentary', phase: 'commentary' }),
    rateRecord(12_205, 'response_item', { type: 'function_call' }),
    responseUsage(next, { responseId: 'resp-tool-2', start: 12_210, output: 120, reasoning: 0 }),
    rateRecord(12_300, 'response_item', { type: 'function_call_output' }),
    rateRecord(12_350, 'response_item', { type: 'reasoning' }), ''].join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, expected);
  await appendFile(path, [...timedReply(next, { start: 12_500, end: 13_250 }), ''].join('\n'));
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);
  await appendFile(path, responseUsage(next, { start: 13_255, output: 6, reasoning: 0 }) + '\n');
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId: next, tokensPerSecond: 8 });
  assert.equal((await activity(next)).outputTokensPerSecond, 8);
});

test('omits output rates for incomplete, mixed, and uncorrelated response records', async t => {
  const { cwd, home, path } = await fixture(t);
  const turnId = 'turn-1';
  const reply = timedReply(turnId);
  const usage = responseUsage(turnId);
  const tool = rateRecord(9700, 'response_item', { type: 'function_call' });
  const aborted = rateEvent(12_000, 'turn_aborted', { turn_id: turnId });
  const untimedMsg = rateRecord(8600, 'response_item', {
    type: 'message', role: 'assistant', status: 'completed', id: 'msg-untimed',
    content: [{ type: 'output_text', text: 'Fixture answer' }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  const cases = [
    ['aggregated usage only', ...reply, tokenEvent({ total_token_usage: { output_tokens: 50 } }, null)],
    ['mixed tool call', tool, ...reply, usage],
    ['overlapping assistant items', ...timedReply(turnId, { start: 8500, end: 10_500, messageId: 'msg-first' }), ...reply, usage],
    ['out-of-order assistant items', ...reply, ...timedReply(turnId, { start: 8500, end: 9000, messageId: 'msg-earlier' }), usage],
    ['untimed assistant item in multi-segment', untimedMsg, ...reply, usage],
    ['tool output between assistant items', ...timedReply(turnId, { start: 8500, end: 9000, messageId: 'msg-first' }),
      rateRecord(9500, 'response_item', { type: 'function_call_output' }), ...reply, usage],
    ['mixed tool call across multiple assistant items',
      ...timedReply(turnId, { start: 8500, end: 9000, messageId: 'msg-first', phase: 'commentary' }), tool, ...reply, usage],
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

test('measures combined commentary and final_answer segments within a single API response', async t => {
  const { cwd, home, path } = await fixture(t);
  const turnId = 'turn-1';
  const records = [
    meta,
    rateEvent(0, 'task_started', { turn_id: turnId }),
    rateRecord(8000, 'response_item', { type: 'reasoning' }),
    ...timedReply(turnId, { start: 8500, end: 9000, messageId: 'msg-commentary', phase: 'commentary' }),
    ...timedReply(turnId, { start: 10_000, end: 11_000, messageId: 'msg-final', phase: 'final_answer' }),
    responseUsage(turnId, { start: 11_005, output: 40, reasoning: 10 }),
    rateEvent(11_100, 'task_complete', { turn_id: turnId }),
    '',
  ];
  await writeFile(path, records.join('\n'));
  assert.deepEqual((await readHudMetrics(null, { id, path }, { cwd, home })).outputRate, { turnId, tokensPerSecond: 20 });

  const adjacent = [
    meta,
    rateEvent(0, 'task_started', { turn_id: turnId }),
    ...timedReply(turnId, { start: 8500, end: 10_000, messageId: 'msg-commentary', phase: 'commentary' }),
    ...timedReply(turnId, { start: 10_000, end: 11_000, messageId: 'msg-final', phase: 'final_answer' }),
    responseUsage(turnId, { start: 11_005, output: 40, reasoning: 10 }),
    '',
  ];
  await writeFile(path, adjacent.join('\n'));
  assert.deepEqual((await readHudMetrics(null, { id, path }, { cwd, home })).outputRate, { turnId, tokensPerSecond: 12 });
});

test('retains output rate across trailing subagent notifications, aborted follow-up turns, and large tool outputs beyond 512 KiB', async t => {
  const { cwd, home, path } = await fixture(t);
  const turnId = 'turn-1';
  const thread = { id, path };
  const opts = { cwd, home };
  const initial = [
    meta,
    rateEvent(0, 'task_started', { turn_id: turnId }),
    ...timedReply(turnId),
    responseUsage(turnId),
    tokenEvent({ total_token_usage: { output_tokens: 500 } }, null),
    rateEvent(11_200, 'task_complete', { turn_id: turnId }),
    rateRecord(11_300, 'response_item', {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<subagent_notification>done</subagent_notification>' }],
    }),
    rateRecord(11_310, 'response_item', { type: 'reasoning' }),
    rateEvent(11_320, 'item_completed', { turn_id: turnId, thread_id: id, item: { type: 'CommandExecution', id: 'cmd-1' } }),
    tokenEvent({ total_token_usage: { output_tokens: 500 } }, null),
    '',
  ];
  await writeFile(path, initial.join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId, tokensPerSecond: 40 });

  await appendFile(path, [
    rateEvent(12_000, 'task_started', { turn_id: 'turn-2' }),
    ...timedReply('turn-2', { start: 12_100, end: 12_200, messageId: 'msg-aborted' }),
    rateEvent(12_300, 'turn_aborted', { turn_id: 'turn-2' }),
    '',
  ].join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId, tokensPerSecond: 40 });

  const hugeOutput = rateRecord(13_000, 'response_item', { type: 'function_call_output', output: 'x'.repeat(540_000) });
  await appendFile(path, [rateEvent(12_900, 'task_started', { turn_id: 'turn-3' }), hugeOutput, ''].join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId, tokensPerSecond: 40 });

  await appendFile(path, [...timedReply('turn-3', { start: 13_100, end: 13_600 }), ''].join('\n'));
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);

  await writeFile(path, initial.join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId, tokensPerSecond: 40 });
  await appendFile(path, [hugeOutput, rateEvent(13_500, 'turn_aborted', { turn_id: turnId }), ''].join('\n'));
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);

  await writeFile(path, initial.join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId, tokensPerSecond: 40 });
  const replacement = path + '.replacement';
  await writeFile(replacement, [meta, hugeOutput, ''].join('\n'));
  await rename(replacement, path);
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);
});

test('reads context-window rotated rollout filenames and enforces strict ownership validation', async t => {
  const { home, cwd } = await fixture(t);
  const sessions = join(home, 'sessions', '2026', '11', '20');
  await mkdir(sessions, { recursive: true });
  const windowId = '2d6c11c9-f1c6-4d02-ae28-a8748071da02';
  const otherId = '3d6c11c9-f1c6-4d02-ae28-a8748071da03';
  const rotatedPath = join(sessions, `rollout-2026-11-20T11-29-36-${id.toUpperCase()}_${windowId.toUpperCase()}.jsonl`);
  const usageEvent = tokenEvent({ total_token_usage: { total_tokens: 1200, output_tokens: 300 } }, null);
  await writeFile(rotatedPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: windowId.toUpperCase(), session_id: id } }),
    rateEvent(0, 'task_started', { turn_id: 'turn-1' }),
    ...timedReply('turn-1', { threadId: windowId.toUpperCase() }),
    responseUsage('turn-1', { threadId: id }),
    usageEvent,
    '',
  ].join('\n'));
  const rotatedMetrics = await readHudMetrics(null, { id, path: rotatedPath }, { cwd, home });
  assert.equal(rotatedMetrics.tokens?.total, 1200);
  assert.deepEqual(rotatedMetrics.outputRate, { turnId: 'turn-1', tokensPerSecond: 40 });

  await writeFile(rotatedPath, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: id } }),
    usageEvent,
    '',
  ].join('\n'));
  assert.equal((await readHudMetrics(null, { id, path: rotatedPath }, { cwd, home })).tokens?.total, 1200);

  const foreignRotated = join(sessions, `rollout-2026-11-20T11-29-36-${otherId}_${windowId}.jsonl`);
  for (const payload of [{ id: windowId, session_id: id }, { session_id: id }]) {
    await writeFile(foreignRotated, [JSON.stringify({ type: 'session_meta', payload }), usageEvent, ''].join('\n'));
    assert.equal((await readHudMetrics(null, { id, path: foreignRotated }, { cwd, home })).tokens, undefined);
  }

  for (const session_id of [otherId, '', 123]) {
    await writeFile(rotatedPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: windowId.toUpperCase(), session_id } }),
      rateEvent(0, 'task_started', { turn_id: 'turn-1' }),
      ...timedReply('turn-1', { threadId: windowId.toUpperCase() }),
      responseUsage('turn-1', { threadId: id }),
      usageEvent,
      '',
    ].join('\n'));
    const rejected = await readHudMetrics(null, { id, path: rotatedPath }, { cwd, home });
    assert.equal(rejected.tokens, undefined);
    assert.equal(rejected.outputRate, undefined);
  }

  await writeFile(rotatedPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: windowId.toUpperCase() } }),
    rateEvent(0, 'task_started', { turn_id: 'turn-1' }),
    ...timedReply('turn-1', { threadId: windowId.toUpperCase() }),
    responseUsage('turn-1', { threadId: id }),
    usageEvent,
    '',
  ].join('\n'));
  const windowOnly = await readHudMetrics(null, { id, path: rotatedPath }, { cwd, home });
  assert.equal(windowOnly.tokens?.total, 1200);
  assert.deepEqual(windowOnly.outputRate, { turnId: 'turn-1', tokensPerSecond: 40 });
});

test('ignores empty thread IDs and malformed confirmedRecord positions or lengths', async t => {
  const { cwd, home, path } = await fixture(t);
  const sessions = join(home, 'sessions', '2026', '11', '18');
  const emptyIdPath = join(sessions, 'rollout-2026-11-18T19-10-00-.jsonl');
  const usageEvent = tokenEvent({ total_token_usage: { total_tokens: 900, output_tokens: 150 } }, null);
  await writeFile(emptyIdPath, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: '' } }),
    rateEvent(0, 'task_started', { turn_id: 'turn-1' }),
    ...timedReply('turn-1', { threadId: '' }),
    responseUsage('turn-1', { threadId: '' }),
    usageEvent,
    '',
  ].join('\n'));
  await writeFile(path, `${meta}\n${usageEvent}\n`);
  for (const target of [emptyIdPath, path]) {
    const metrics = await readHudMetrics(null, { id: '', path: target }, { cwd, home });
    assert.equal(metrics.tokens, undefined);
    assert.equal(metrics.outputRate, undefined);
  }

  const spyFile = { async read() { assert.fail('readFragment should not be called for invalid record bounds'); } };
  for (const badRecord of [
    null,
    undefined,
    { position: 0, length: 4, digest: 'x' },
    { position: -1, length: 4, digest: 'x' },
    { position: 1.5, length: 4, digest: 'x' },
    { position: 1, length: -1, digest: 'x' },
    { position: 1, length: Number.NaN, digest: 'x' },
    { position: 1, length: Number.MAX_SAFE_INTEGER, digest: 'x' },
    { position: 1, length: Number.MAX_SAFE_INTEGER - 1, digest: 'x' },
    { position: 1, length: 512 * 1024 + 1, digest: 'x' },
    { position: Number.MAX_SAFE_INTEGER, length: 11, digest: 'x' },
  ]) {
    assert.equal(await confirmedRecord(spyFile, badRecord), undefined);
  }

  const realPath = join(sessions, 'confirmed-bounds.jsonl');
  await writeFile(realPath, '\n{"ok":true}\n');
  const handle = await open(realPath, 'r');
  t.after(() => handle.close());
  const validDigest = createHash('sha256').update('{"ok":true}').digest('base64');
  const validRecord = { position: 1, length: 11, digest: validDigest };
  assert.equal(await confirmedRecord(handle, validRecord), validRecord);
  assert.equal(await confirmedRecord(handle, { position: 1, length: 11, digest: 'wrong-digest' }), undefined);
  assert.equal(await confirmedRecord(handle, {
    position: 2, length: 10, digest: createHash('sha256').update('"ok":true}').digest('base64'),
  }), undefined);
  assert.equal(await confirmedRecord(handle, { position: 0, length: 11, digest: validDigest }), undefined);

  const truncatedPath = join(sessions, 'confirmed-truncated.jsonl');
  await writeFile(truncatedPath, '\n{"ok":true}');
  const truncatedHandle = await open(truncatedPath, 'r');
  t.after(() => truncatedHandle.close());
  assert.equal(await confirmedRecord(truncatedHandle, validRecord), undefined);
});

test('allows Reasoning item_completed between commentary and final_answer while rejecting trailing Reasoning', async t => {
  const { cwd, home, path } = await fixture(t);
  const turnId = 'turn-1';
  const interleaved = [
    meta,
    rateEvent(0, 'task_started', { turn_id: turnId }),
    rateEvent(8000, 'item_completed', { turn_id: turnId, thread_id: id, item: { type: 'Reasoning', id: 'rs-0' } }),
    ...timedReply(turnId, { start: 8500, end: 9000, messageId: 'msg-commentary', phase: 'commentary' }),
    rateEvent(9500, 'item_completed', { turn_id: turnId, thread_id: id, item: { type: 'Reasoning', id: 'rs-1' } }),
    ...timedReply(turnId, { start: 10_000, end: 11_000, messageId: 'msg-final', phase: 'final_answer' }),
    responseUsage(turnId, { start: 11_005, output: 40, reasoning: 10 }),
    rateEvent(11_100, 'task_complete', { turn_id: turnId }),
    '',
  ];
  await writeFile(path, interleaved.join('\n'));
  assert.deepEqual((await readHudMetrics(null, { id, path }, { cwd, home })).outputRate, { turnId, tokensPerSecond: 20 });

  const trailingReasoning = [
    meta,
    rateEvent(0, 'task_started', { turn_id: turnId }),
    ...timedReply(turnId, { start: 10_000, end: 11_000, messageId: 'msg-final', phase: 'final_answer' }),
    rateEvent(11_003, 'item_completed', { turn_id: turnId, thread_id: id, item: { type: 'Reasoning', id: 'rs-late' } }),
    responseUsage(turnId, { start: 11_005, output: 40, reasoning: 10 }),
    '',
  ];
  await writeFile(path, trailingReasoning.join('\n'));
  assert.equal((await readHudMetrics(null, { id, path }, { cwd, home })).outputRate, undefined);

  const interleavedCommand = [
    meta,
    rateEvent(0, 'task_started', { turn_id: turnId }),
    ...timedReply(turnId, { start: 8500, end: 9000, messageId: 'msg-commentary', phase: 'commentary' }),
    rateEvent(9500, 'item_completed', { turn_id: turnId, thread_id: id, item: { type: 'CommandExecution', id: 'cmd-1' } }),
    ...timedReply(turnId, { start: 10_000, end: 11_000, messageId: 'msg-final', phase: 'final_answer' }),
    responseUsage(turnId, { start: 11_005, output: 40, reasoning: 10 }),
    '',
  ];
  await writeFile(path, interleavedCommand.join('\n'));
  assert.equal((await readHudMetrics(null, { id, path }, { cwd, home })).outputRate, undefined);
});

test('restores cached output rate beyond 512 KiB after an unbilled reply aborts, while dropping rewritten rollouts', async t => {
  const { cwd, home, path } = await fixture(t);
  const turnId = 'turn-1';
  const thread = { id, path };
  const opts = { cwd, home };
  const initial = [
    meta,
    rateEvent(0, 'task_started', { turn_id: turnId }),
    ...timedReply(turnId),
    responseUsage(turnId),
    rateEvent(11_200, 'task_complete', { turn_id: turnId }),
    '',
  ];
  const hugeOutput = rateRecord(13_000, 'response_item', { type: 'function_call_output', output: 'x'.repeat(540_000) });
  await writeFile(path, initial.join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId, tokensPerSecond: 40 });

  await appendFile(path, [rateEvent(12_900, 'task_started', { turn_id: 'turn-2' }), hugeOutput, ''].join('\n'));
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId, tokensPerSecond: 40 });

  await appendFile(path, [...timedReply('turn-2', { start: 13_100, end: 13_600 }), ''].join('\n'));
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);

  await appendFile(path, rateEvent(13_700, 'turn_aborted', { turn_id: 'turn-2' }) + '\n');
  assert.deepEqual((await readHudMetrics(null, thread, opts)).outputRate, { turnId, tokensPerSecond: 40 });

  await appendFile(path, [
    rateEvent(14_000, 'task_started', { turn_id: 'turn-3' }),
    ...timedReply('turn-3', { start: 14_100, end: 14_500 }),
    '',
  ].join('\n'));
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);

  await writeFile(path, [
    meta,
    rateRecord(14_600, 'response_item', { type: 'function_call_output', output: 'y'.repeat(560_000) }),
    rateEvent(14_700, 'turn_aborted', { turn_id: 'turn-3' }),
    '',
  ].join('\n'));
  assert.equal((await readHudMetrics(null, thread, opts)).outputRate, undefined);
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
  let now = 1795000000;
  t.mock.method(Date, 'now', () => now * 1000);
  const weeklyReset = now + 45;
  const release = Promise.withResolvers();
  const windows = (usedPercent, windowDurationMins, resetsAt = null) => ({ usedPercent, windowDurationMins, resetsAt });
  let reads = 0;
  const client = { async request(method, params, options) {
    if (method === 'config/read') return { config: { model_provider: 'openai' } };
    if (method !== 'account/rateLimits/read') throw new Error('Unsupported fixture request');
    assert.deepEqual(params, {});
    assert.equal(options.timeoutMs, 15_000);
    reads++;
    return release.promise;
  } };
  const local = tokenEvent(null, {
    primary: { used_percent: 15, window_minutes: 300, resets_at: now + 100 },
    secondary: { used_percent: 100, window_minutes: 10_080, resets_at: weeklyReset },
  });
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
      { minutes: 10_080, usedPercent: 100, remainingPercent: 0, resetsAt: weeklyReset },
    ] },
    { id: 'spark', name: undefined, windows: [{ minutes: 300, usedPercent: 0.001, remainingPercent: 99.99, resetsAt: undefined }] },
    { id: 'trial', name: 'Trial', windows: [{ minutes: 120, usedPercent: 0.07, remainingPercent: 99.93, resetsAt: undefined }] },
  ]);
  const custom = await readHudMetrics(client, { ...thread, modelProvider: 'local' }, options);
  assert.equal(custom.quotaGroups, undefined);
  assert.equal(custom.limits.fiveHour.remainingPercent, 85);
  assert.equal((await readHudMetrics(client, undefined, options)).quotaGroups, undefined);
  now = weeklyReset;
  const afterReset = await readHudMetrics(client, thread, options);
  assert.equal(afterReset.quotaGroups[0].windows[1].resetsAt, undefined);
  assert.equal(reads, 2);
  now = weeklyReset + 5;
  await readHudMetrics(client, thread, options);
  assert.equal(reads, 2);
});

test('duplicates of an account bucket supplement only the live reset of an identical window', async t => {
  const { cwd, home } = await fixture(t);
  const start = 1795000000;
  let now = start;
  t.mock.method(Date, 'now', () => now * 1000);
  const hour = (usedPercent, resetsAt) => ({ windowDurationMins: 300, usedPercent, resetsAt });
  const week = (usedPercent, resetsAt) => ({ windowDurationMins: 10_080, usedPercent, resetsAt });
  const client = { async request(method) {
    if (method === 'config/read') return { config: {} };
    if (method === 'account/rateLimits/read') return {
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: hour(22), secondary: week(31) },
        alias: { limitId: 'codex', primary: hour(22, start + 20), secondary: week(32, start + 40) },
        spark: { limitId: 'spark', primary: hour(22, start + 40) },
      },
      rateLimits: { limitId: 'codex', primary: hour(23, start + 40), secondary: week(31, start + 30) },
    };
    return { data: [] };
  } };
  const options = { cwd, home, waitForCost: true };
  const thread = { id, modelProvider: 'openai' };
  const startup = await readHudMetrics(client, undefined, { ...options, startsNewThread: true });
  const recorded = () => readHudMetrics(client, thread, options);
  assert.deepEqual(startup.limits, {
    fiveHour: { usedPercent: 22, remainingPercent: 78, resetsAt: start + 20 },
    weekly: { usedPercent: 31, remainingPercent: 69, resetsAt: start + 30 },
  });
  assert.deepEqual((await recorded()).quotaGroups[0].windows.map(window => window.resetsAt), [start + 20, start + 30]);
  now = start + 20;
  assert.deepEqual((await recorded()).quotaGroups[0].windows.map(window => window.resetsAt), [undefined, start + 30]);
  now = start + 30;
  assert.deepEqual((await recorded()).quotaGroups[0].windows.map(window => window.resetsAt), [undefined, undefined]);
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
  assert.equal(requests, 4);
  now = start + 31;
  assert.deepEqual(await values(), [['legacy', 60, 120]]);
  assert.equal(requests, 4);
});

test('refreshes account quotas immediately when a window crosses resetsAt before the 60s cache expires', async t => {
  const { cwd, home } = await fixture(t);
  const start = 1795000000;
  let now = start;
  t.mock.method(Date, 'now', () => now * 1000);
  let requests = 0;
  let delayed = true;
  const client = { async request(method) {
    if (method === 'config/read') return { config: { model_provider: 'openai' } };
    if (method === 'account/rateLimits/read') {
      requests++;
      const expired = now < start + 15 || delayed;
      return { rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          primary: {
            usedPercent: expired ? 100 : 0,
            windowDurationMins: 300,
            resetsAt: expired ? start + 15 : start + 18_015,
          },
          secondary: {
            usedPercent: 20,
            windowDurationMins: 10_080,
            resetsAt: start + 86_400,
          },
        },
      } };
    }
    return {};
  } };
  const thread = { id, modelProvider: 'openai' };
  const read = () => readHudMetrics(client, thread, { cwd, home, waitForCost: true });

  const initial = await read();
  assert.equal(requests, 1);
  assert.deepEqual(initial.quotaGroups[0].windows.map(w => [w.minutes, w.remainingPercent, w.resetsAt]), [
    [300, 0, start + 15],
    [10_080, 80, start + 86_400],
  ]);

  now = start + 14;
  await read();
  assert.equal(requests, 1);

  // At resetsAt (15s < 60s refreshAt), the expired 5h window triggers an immediate refresh.
  now = start + 15;
  await read();
  assert.equal(requests, 2);

  // Within the 2s minRetryAt window, a delayed server reset does not spam requests.
  now = start + 16;
  await read();
  assert.equal(requests, 2);

  // After minRetryAt (2s), the next poll immediately fetches the newly reset 5h quota window.
  delayed = false;
  now = start + 17;
  const refreshed = await read();
  assert.equal(requests, 3);
  assert.deepEqual(refreshed.quotaGroups[0].windows.map(w => [w.minutes, w.remainingPercent, w.resetsAt]), [
    [300, 100, start + 18_015],
    [10_080, 80, start + 86_400],
  ]);

  // If the server still returns a stale resetsAt after the +2s retry, or includes a historical bucket
  // already expired by >= 2s when fetched, it honors the 60s refreshAt instead of polling every 2s.
  delayed = true;
  now = start + 100;
  await read();
  assert.equal(requests, 4);
  for (const offset of [103, 110, 130, 159]) {
    now = start + offset;
    await read();
    assert.equal(requests, 4);
  }
  delayed = false;
  now = start + 160;
  await read();
  assert.equal(requests, 5);
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
