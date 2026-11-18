import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { previewActivity, readActivity, renderActivity } from '../lib/activity.mjs';

const cwd = resolve('测试 工作区');
const thread = {
  id: '01a1edf5-2874-73b1-8315-cd718563165b', cwd, source: 'cli', historyMode: 'paginated',
  status: { type: 'notLoaded' }, model: 'gpt-6.2', reasoningEffort: 'high', modelProvider: 'openai',
  gitInfo: { branch: 'main', originUrl: 'secret-remote' }, preview: 'secret-prompt',
};
const turn = { id: 'turn-1', items: [], status: 'completed' };

test('activity selects the newest main session in the exact workspace', async () => {
  const client = {
    async request(method, params) {
      if (method === 'thread/list') {
        assert.equal(params.cwd, cwd);
        assert.equal(params.sortKey, 'updated_at');
        return { data: [
          { ...thread, id: 'wrong-workspace', cwd: resolve(cwd, 'nested') },
          { ...thread, id: 'child', source: { subAgent: 'review' }, parentThreadId: thread.id },
          thread,
        ] };
      }
      assert.equal(params.threadId, thread.id);
      return { data: [] };
    },
  };
  const output = renderActivity(await readActivity(client, { cwd }));
  assert.match(output, /gpt-6\.2.*high/);
  assert.match(output, /main/);
  assert.doesNotMatch(output, /secret-|wrong-workspace|child/);
});

test('activity pages the latest turn and emits only sanitized activity metadata', async () => {
  const client = {
    async request(method, params) {
      assert.equal(params.threadId, thread.id);
      if (method === 'thread/read') return { thread };
      if (method === 'thread/turns/list') return { data: [turn] };
      assert.equal(method, 'thread/items/list');
      assert.equal(params.turnId, turn.id);
      assert.equal(params.deferOutput.commandExecution, true);
      if (params.cursor === 'more') return { data: [
        { item: { id: 'a1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'agent', agentPath: '/root/worker', model: 'gpt-6.2', reasoningEffort: 'low' } },
        { item: { id: 'p1', type: 'plan', text: 'secret-plan' } },
      ] };
      return { nextCursor: 'more', data: [
        { item: { id: 'c1', type: 'commandExecution', status: 'inProgress', command: 'secret-command' } },
        { item: { id: 'c2', type: 'commandExecution', status: 'completed', aggregatedOutput: 'secret-output' } },
        { item: { id: 'm1', type: 'mcpToolCall', server: 'repo\u001b', tool: 'status', status: 'failed' } },
        { item: { id: 'a2', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'agent', agentPath: '/root/worker' } },
      ] };
    },
  };
  const snapshot = await readActivity(client, { threadId: thread.id });
  const output = renderActivity(snapshot);
  assert.match(output, /Shell.*1 进行中.*1 完成/);
  assert.match(output, /MCP repo\/status.*1 失败/);
  assert.match(output, /worker.*gpt-6\.2.*low.*完成/);
  assert.match(output, /计划/);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-|\\u001b/);
  assert.doesNotMatch(output, /secret-|\u001b/);
});

test('legacy history uses the latest full turn and reuses an unchanged snapshot', async () => {
  let reads = 0;
  const items = [
    { id: 'f1', type: 'fileChange', status: 'completed', changes: [{ path: 'secret-file' }] },
    { id: 'p1', type: 'plan', text: 'secret-plan' },
    ...Array.from({ length: 65 }, (_, index) => ({ id: `message-${index}`, type: 'agentMessage' })),
  ];
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread: { ...thread, historyMode: 'legacy', updatedAt: 1234 } };
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.itemsView, 'full');
      reads++;
      return { data: [{ ...turn, items }] };
    },
  };
  const options = { threadId: thread.id };
  const output = renderActivity(await readActivity(client, options));
  assert.match(output, /文件变更.*1 完成/);
  assert.match(output, /最近回合有已保存计划/);
  assert.doesNotMatch(output, /范围|secret-/);
  await readActivity(client, options);
  assert.equal(reads, 1);
});

test('a bounded paginated turn distinguishes an empty recent window from the full turn', async () => {
  const messages = Array.from({ length: 64 }, (_, index) => ({ type: 'agentMessage', id: `message-${index}` }));
  const remaining = [
    { id: 'c1', type: 'commandExecution', status: 'completed' },
    { id: 'p1', type: 'plan', text: 'older-plan' },
  ];
  const pages = new Map([
    [undefined, { data: messages.slice(0, 32), nextCursor: 'second' }],
    ['second', { data: messages.slice(32), nextCursor: 'old' }],
    ['old', { data: remaining }],
  ]);
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/turns/list') return { data: [turn] };
      assert.equal(method, 'thread/items/list');
      assert.notEqual(params.cursor, 'old');
      const { data, nextCursor } = pages.get(params.cursor);
      return { data: data.map(item => ({ item })), nextCursor };
    },
  };

  const options = { threadId: thread.id };
  const emptyWindow = renderActivity(await readActivity(client, options));
  assert.match(emptyWindow, /范围 最近 64 项/);
  assert.match(emptyWindow, /此范围暂无已记录活动/);
  assert.doesNotMatch(emptyWindow, /最近回合暂无已记录活动/);

  pages.get('second').data.splice(0, 2, ...remaining);
  const activeWindow = renderActivity(await readActivity(client, options));
  assert.match(activeWindow, /范围 最近 64 项\n工具 Shell \| 1 完成/);
  assert.match(activeWindow, /此范围有已保存计划/);
  assert.doesNotMatch(activeWindow, /暂无|最近回合有已保存计划/);
});

test('activity renders an empty workspace, a narrow preview, and server failure safely', async () => {
  const client = { request: async () => ({ data: [] }) };
  assert.match(renderActivity(await readActivity(client, { cwd })), /没有.*会话/);
  const narrow = renderActivity(previewActivity(), { width: 16 });
  assert.ok(narrow.split('\n').every(line => [...line].reduce((size, part) => size + (part.codePointAt(0) > 127 ? 2 : 1), 0) <= 16));
  assert.doesNotMatch(narrow, /\u001b/);
  const failing = { request: async () => { throw new Error('secret-protocol-text'); } };
  await assert.rejects(readActivity(failing, { cwd }), /^Error: 无法读取 Codex 会话列表。$/);
});
