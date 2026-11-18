import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { previewActivity, readActivity, renderActivity } from '../lib/activity.mjs';

const cwd = resolve('测试 工作区');
const thread = {
  id: '01a1edf5-2874-73b1-8315-cd718563165b', cwd, source: 'cli', historyMode: 'paginated',
  status: { type: 'notLoaded' }, model: 'gpt-6.2', reasoningEffort: 'high', modelProvider: 'openai',
  cliVersion: '0.170.0', createdAt: 1760000000,
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
  const output = renderActivity(await readActivity(client, { cwd }), { now: 1760006960 });
  assert.match(output, /^\[gpt-6\.2 ◑ high\] │ 测试 工作区 git:\(main\) │ Codex v0\.170\.0 │ ⏱ 1h 56m\n/);
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
  assert.match(output, /◐ Shell │ ✓ Shell/);
  assert.match(output, /^MCPs \(1\) ✗ repo$/m);
  assert.match(output, /worker.*gpt-6\.2.*low.*完成/);
  assert.match(output, /计划/);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-|\\u001b/);
  assert.doesNotMatch(output, /secret-|\u001b/);
});

test('activity shows explicitly selected skills without implying they ran', async () => {
  const selected = ['terminal-layout\u001b', 'terminal-layout', 'process-monitor', 'tidy-checks', 'quick-diff', 'another-skill'];
  const items = [{ id: 'u1', type: 'userMessage', content: [
    { type: 'text', text: 'secret-prompt', text_elements: [] },
    { type: 'mention', name: 'ordinary-mention', path: '/tmp/secret-mention-path' },
    ...selected.map(name => ({ type: 'skill', name, path: '/tmp/secret-skill-path' })),
  ] }];
  const client = {
    async request(method) {
      if (method === 'thread/read') return { thread: { ...thread, historyMode: 'legacy' } };
      assert.equal(method, 'thread/turns/list');
      return { data: [{ ...turn, items }] };
    },
  };
  const snapshot = await readActivity(client, { threadId: thread.id });
  const output = renderActivity(snapshot);
  assert.match(output, /^▸ Skills \(5\) 已选 terminal-layout, process-monitor, tidy-checks, quick-diff, \+1 项$/m);
  assert.doesNotMatch(output, /暂无已记录活动|another-skill|ordinary-mention|secret-|\u001b/);
  assert.doesNotMatch(JSON.stringify(snapshot), /ordinary-mention|secret-|\\u001b/);
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
  assert.match(output, /✓ 文件变更/);
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
  assert.match(activeWindow, /范围 最近 64 项\n✓ Shell/);
  assert.match(activeWindow, /此范围有已保存计划/);
  assert.doesNotMatch(activeWindow, /暂无|最近回合有已保存计划/);
});

test('activity renders an empty workspace, a narrow preview, and server failure safely', async () => {
  const client = { codexVersion: '0.170.0', request: async () => ({ data: [] }) };
  const empty = renderActivity(await readActivity(client, { cwd }));
  assert.match(empty, /没有.*会话。 │ Codex v0\.170\.0\n内存/);
  assert.doesNotMatch(empty, /上下文|词元|5h/);
  const narrow = renderActivity({ ...previewActivity(), workspace: resolve('超长项目中测试目录') }, { width: 16 });
  assert.ok(narrow.split('\n').every(line => [...line].reduce((size, part) => size + (/\p{Script=Han}|\p{Extended_Pictographic}/u.test(part) ? 2 : 1), 0) <= 16));
  assert.match(narrow, /上下文 .*32%\n5h 剩余 53%/);
  assert.doesNotMatch(narrow, /\u001b/);
  const failing = { request: async () => { throw new Error('secret-protocol-text'); } };
  await assert.rejects(readActivity(failing, { cwd }), /^Error: 无法读取 Codex 会话列表。$/);
});

test('the full preview draws the same compact progress, environment, activity, and token rows', () => {
  const output = renderActivity(previewActivity());
  const lines = output.split('\n');
  assert.match(lines[0], /^\[.+ ● .+\] │ .+ git:\(main\) │ Codex v\d+\.\d+\.\d+ .*费用 \$34\.95 │ 示例/);
  assert.match(lines[1], /^上下文 ███░░░░░░░ 32% │ 5h 剩余 53% \(54m\) │ 7d 剩余 39% \(6d 14h\)/);
  assert.match(lines[2], /^内存 +█████░░░░░ 46% \(10\.3 GB \/ 22\.5 GB\)$/);
  assert.match(lines[3], /^2 AGENTS\.md │ 6 MCPs │ 1 钩子/);
  assert.match(output, /✓ Shell ×20\n▸ Skills \(2\) 已选 superpowers:systematic-debugging, ponytail:ponytail\nMCPs \(2\)/);
  assert.match(lines.at(-1), /^词元 9\.9M \(输入 678k, 输出 31k, 缓存 9\.2M\)$/);
  const colored = renderActivity(previewActivity(), { color: true }).split('\n');
  const sgr = (tone, value) => `\u001b[${tone}m${value}\u001b[0m`;
  assert.deepEqual(colored[0].split(' │ ').slice(0, 3), [
    sgr(36, '[GPT-6.2-Astra ● max]'),
    sgr(33, 'codex-hub') + sgr(35, ' git:(') + sgr(36, 'main') + sgr(35, ')'),
    sgr(2, 'Codex v0.170.0'),
  ]);
  assert.equal(colored[1].split(' │ ')[0],
    sgr(2, '上下文 ') + sgr(32, '███') + sgr('32;2', '░'.repeat(7)) + sgr(32, ' 32%'));
  assert.equal(colored[2],
    sgr(2, '内存   ') + sgr(94, '█'.repeat(5)) + sgr('94;2', '░'.repeat(5)) + sgr(32, ' 46%') + sgr(2, ' (10.3 GB / 22.5 GB)'));
  assert.equal(colored[3], ['2 AGENTS.md', '6 MCPs', '1 钩子'].map(label => sgr(2, label)).join(' │ '));
});

test('a short interactive frame retains the header and reports hidden rows', () => {
  const snapshot = previewActivity();
  const full = renderActivity(snapshot, { width: 24 }).split('\n');
  assert.ok(full.length > 10);
  const cropped = renderActivity(snapshot, { width: 24, height: 10 }).split('\n');
  assert.deepEqual(cropped.slice(0, -1), full.slice(0, 9));
  assert.equal(cropped.at(-1), `… 另有 ${full.length - 9} 行`);
  assert.equal(renderActivity(snapshot, { width: 24, height: 1 }), full[0]);
});

test('grouped quotas show remaining meters, omit invalid or expired data, and preserve activity on small screens', () => {
  const now = 1795000000;
  const snapshot = {
    id: 'active', workspace: cwd, model: 'gpt-live', contextPercent: 32,
    memory: { used: 16 * 1024 ** 3, total: 32 * 1024 ** 3 }, environment: { agentsMd: 2 },
    agents: [{ name: 'reviewer', status: 'running' }],
    quotaGroups: [
      { id: 'codex', name: 'Codex', windows: [
        { minutes: 300, remainingPercent: 100, usedPercent: 0, resetsAt: now + 3600 },
        { minutes: 10_080, remainingPercent: 0, usedPercent: 100 },
      ] },
      { id: 'spark', name: 'Spark', windows: [{ minutes: 120, remainingPercent: 99.99, usedPercent: 0.001 }] },
      { id: 'expired', name: 'Expired', windows: [{ minutes: 300, remainingPercent: 55, usedPercent: 45, resetsAt: now }] },
      { id: 'empty', name: 'Empty', windows: [] },
    ],
  };
  const view = options => renderActivity(snapshot, { embedded: true, now, ...options });
  assert.match(view(), /^Codex 5h █{6} 100% \(1h 0m\) │ Codex 7d ░{6} 0%\nSpark 2h █{6} 99\.99%$/m);
  assert.doesNotMatch(view(), /Expired|Empty|Google|Claude|Argon/u);
  assert.match(view({ color: true }), /\u001b\[94m█{6}\u001b\[0m[\s\S]*\u001b\[31;2m░{6}\u001b\[0m/u);
  assert.equal(view({ height: 5 }), renderActivity({ ...snapshot, quotaGroups: undefined }, { embedded: true, now, height: 5 }));
  assert.match(view({ width: 18 }), /^Codex 5h .*100%\nCodex 7d .*0%\nSpark 2h .*99\.99%$/m);
  assert.ok(view({ width: 18 }).split('\n').every(line => [...line].reduce((width, char) => width + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0) <= 18));
});

test('a single known quota group leaves only compact windows alongside context', () => {
  const now = 1795000000;
  const snapshot = {
    ...previewActivity(), contextPercent: 32, limits: { fiveHour: { remainingPercent: 99 }, weekly: { remainingPercent: 99 } },
    quotaGroups: [{ id: 'codex', name: 'Regional', windows: [
      { minutes: 300, remainingPercent: 5.27, usedPercent: 94.73 },
      { minutes: 10_080, remainingPercent: 100, usedPercent: 0, resetsAt: now + 3600 },
    ] }],
  };
  const output = renderActivity(snapshot, { now });
  assert.match(output, /^上下文 ███░░░░░░░ 32% │ 5h 剩余 5\.27% │ 7d 剩余 100% \(1h 0m\)$/m);
  assert.doesNotMatch(output, /Regional|99%/u);
});

test('repeated quota names show distinct IDs and keep them legible beside both windows', () => {
  const quotaGroup = (id, name, remainingFiveHour, remainingWeek) => ({ id, name, windows: [
    { minutes: 300, remainingPercent: remainingFiveHour, usedPercent: 100 - remainingFiveHour },
    { minutes: 10_080, remainingPercent: remainingWeek, usedPercent: 100 - remainingWeek },
  ] });
  const snapshot = { model: 'fixture', quotaGroups: [
    quotaGroup('common_quota_prefix_alpha', 'Base', 32, 91),
    quotaGroup('common_quota_prefix_beta', 'Base', 72, 18),
    quotaGroup('unique-plan', 'Trial', 99, 76),
  ] };
  const wide = renderActivity(snapshot, { embedded: true, width: 112 });
  assert.match(wide, /^Base \(common_quota_prefix_alpha\) 5h .*32% │ Base \(common_quota_prefix_alpha\) 7d .*91%$/m);
  assert.match(wide, /^Base \(common_quota_prefix_beta\) 5h .*72% │ Base \(common_quota_prefix_beta\) 7d .*18%$/m);
  assert.match(wide, /^Trial 5h .*99% │ Trial 7d .*76%$/m);
  assert.doesNotMatch(wide, /unique-plan/u);
  const narrow = renderActivity(snapshot, { embedded: true, width: 19 });
  assert.match(narrow, /^alpha 5h .*32%\nalpha 7d .*91%\nbeta 5h .*72%\nbeta 7d .*18%$/m);
});

test('three repeated quota names remain distinct after clipping at 52 columns', () => {
  const render = (ids, additional = []) => renderActivity({ model: 'fixture', quotaGroups: [
    ...ids.map((id, index) => ({ id, name: 'Base', windows: [{ minutes: 300, remainingPercent: (index + 1) * 11 }] })),
    ...additional,
  ] }, { embedded: true, width: 52 });
  const prefix = 'codex-extended-family-organization-long-shared-';
  const result = render([`${prefix}alpha`, `${prefix}beta`, 'spark']);
  assert.match(result, /^alpha 5h .*11%\nbeta 5h .*22%\nBase \(spark\) 5h .*33%$/m);

  const head = 'commonprefix'.repeat(6);
  const tail = 'commonsuffix'.repeat(6);
  const varied = render([`${head}alpha${tail}`, `${head}bravo${tail}`, 'spark']);
  assert.match(varied, /^alpha 5h .*11%\nbravo 5h .*22%\nBase \(spark\) 5h .*33%$/m);

  const visibleDuplicate = { id: 'standalone', name: 'alpha', windows: [{ minutes: 300, remainingPercent: 77 }] };
  const collision = render([`${prefix}alpha`, `${prefix}beta`, 'spark'], [visibleDuplicate]);
  assert.match(collision, /^#1 5h .*11%$/m);
  assert.match(collision, /^#4 5h .*77%$/m);
  const reversed = render(['spark', `${prefix}beta`, `${prefix}alpha`], [visibleDuplicate]);
  assert.match(reversed, /^#1 5h .*33%$/m);
  assert.match(reversed, /^#4 5h .*77%$/m);
});

test('an embedded idle session shows measured rows even before the history is available', () => {
  const snapshot = {
    workspace: cwd, model: 'gpt-6.2', reasoning: 'high', cliVersion: '0.170.0', contextPercent: 0,
    memory: { used: 10.3 * 1024 ** 3, total: 22.5 * 1024 ** 3 },
    environment: { agentsMd: 2, mcps: 6, hooks: 1 },
    turn: 'inProgress', windowSize: 64, plan: true, tokens: { total: 0, input: 0, output: 0, cached: 0 },
  };
  const frame = renderActivity(snapshot, { embedded: true, color: true });
  const lines = stripVTControlCharacters(frame).split('\n');
  assert.deepEqual(lines, [
    '[gpt-6.2 ◑ high] │ 测试 工作区 │ Codex v0.170.0',
    '上下文 ░░░░░░░░░░ 0%',
    '内存   █████░░░░░ 46% (10.3 GB / 22.5 GB)',
    '2 AGENTS.md │ 6 MCPs │ 1 钩子',
  ]);
  assert.match(frame, /\u001b\[32;2m░{10}\u001b\[0m/);
  assert.match(frame, /\u001b\[94m█{5}\u001b\[0m/);

  const narrow = renderActivity({ ...snapshot, contextPercent: undefined }, { embedded: true, width: 12 });
  assert.match(narrow, /^内存 .*46%$/m);
  assert.doesNotMatch(narrow, /上下文|暂无|范围|\u001b/);
});

test('links the terminal project name to its encoded local workspace', () => {
  const workspace = resolve('项目 with # and %');
  const snapshot = { workspace, model: 'gpt-live', contextPercent: 0 };
  const link = `\u001b]8;;${pathToFileURL(workspace).href}\u001b\\`;
  const close = '\u001b]8;;\u001b\\';
  const output = renderActivity(snapshot, { embedded: true, color: true });
  assert.ok(output.includes(`${link}\u001b[33m项目 with # and %\u001b[0m${close}`));
  const narrow = renderActivity(snapshot, { embedded: true, color: true, width: 10 });
  assert.ok(narrow.includes(link));
  assert.ok(narrow.includes(close));
  assert.ok(stripVTControlCharacters(narrow).split('\n').every(line => line.length <= 10));
  assert.doesNotMatch(renderActivity(snapshot, { embedded: true }), /\u001b\]8;/u);
  assert.doesNotMatch(renderActivity({ ...snapshot, preview: true }, { embedded: true, color: true }), /\u001b\]8;/u);
  assert.doesNotMatch(renderActivity({ ...snapshot, workspace: `${workspace}\u001b[0m` }, { embedded: true, color: true }), /\u001b\]8;/u);
});

test('an embedded active session shows verified tool, skill and recent agent rows', async () => {
  const now = 1760007000;
  const timestamp = (secondsAgo) => (now - secondsAgo) * 1000;
  const entry = (item, timing = {}) => ({ item, ...timing });
  const start = (name, secondsAgo) => entry({
    id: `${name}-start`, type: 'subAgentActivity', kind: 'started', agentThreadId: name,
    agentPath: `/root/${name}`, model: 'gpt-6.2', reasoningEffort: 'xhigh',
  }, { startedAtMs: timestamp(secondsAgo) });
  const end = (name, secondsAgo) => entry({
    id: `${name}-end`, type: 'subAgentActivity', kind: 'completed', agentThreadId: name, agentPath: `/root/${name}`,
  }, { completedAtMs: timestamp(secondsAgo) });
  const items = [
    start('stale', 180), end('stale', 70),
    start('third-completion', 60), end('third-completion', 50),
    start('recent-a', 50), end('recent-a', 25),
    start('recent-b', 48), end('recent-b', 12),
    start('running', 10),
    entry({ id: 'collab', type: 'collabAgentToolCall', tool: 'spawnAgent', model: 'requested-model', reasoningEffort: 'low', agentsStates: { running: { status: 'running' } } }),
    entry({ id: 'shell', type: 'commandExecution', status: 'completed' }),
    entry({ id: 'skill', type: 'userMessage', content: [{ type: 'skill', name: 'terminal-layout' }] }),
    entry({ id: 'mcp-1', type: 'mcpToolCall', server: 'repo', tool: 'status', status: 'completed' }),
    entry({ id: 'mcp-2', type: 'mcpToolCall', server: 'repo', tool: 'diff', status: 'failed' }),
    entry({ id: 'compact', type: 'contextCompaction' }),
  ];
  const client = {
    async request(method) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/turns/list') return { data: [turn] };
      assert.equal(method, 'thread/items/list');
      return { data: items.toReversed() };
    },
  };
  const snapshot = await readActivity(client, { threadId: thread.id });
  const frame = renderActivity({ ...snapshot, taskProgress: { completed: 1, total: 3, current: '检查布局' } }, { embedded: true, now });
  assert.match(frame, /✓ Shell\n▸ Skills \(1\) 已选 terminal-layout\nMCPs \(1\) ✗ repo\n/);
  assert.match(frame, /◐ running.*gpt-6\.2 ◕ xhigh.*10s\n✓ recent-b.*36s\n✓ recent-a.*25s/);
  assert.match(frame, /▸ 检查布局 \(1\/3\)/);
  assert.match(frame, /最近回合压缩 1 次/);
  assert.doesNotMatch(frame, /stale|third-completion|requested-model|repo\/|范围|暂无/);

  const later = renderActivity(snapshot, { embedded: true, now: now + 61 });
  assert.match(later, /◐ running/);
  assert.doesNotMatch(later, /✓ recent|▸ 检查布局/);
});

test('a running child survives a long parent turn and the next parent turn until confirmed finished', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const childId = 'observed-child';
  const started = {
    item: { id: 'actual-start', type: 'subAgentActivity', kind: 'started', agentThreadId: childId, agentPath: '/root/observed', model: 'gpt-child' },
    startedAtMs: (now - 12) * 1000,
  };
  const busyPages = Array.from({ length: 2 }, (_, page) => Array.from({ length: 32 }, (_, offset) => ({
    item: { id: `${page}-${offset}`, type: 'agentMessage' },
  })));
  let step = 'start';
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') {
        assert.equal(params.parentThreadId, thread.id);
        return { data: [{ id: childId, parentThreadId: thread.id, status: { type: 'notLoaded' } }] };
      }
      if (method === 'thread/turns/list') {
        if (params.threadId === childId) {
          // An independent app-server replays an unloaded running turn as interrupted without an end time.
          return { data: [step === 'finished'
            ? { status: 'completed', startedAt: now - 12, completedAt: now + 5 }
            : { status: 'interrupted', startedAt: now - 12, completedAt: null }] };
        }
        return { data: [step === 'start' || step === 'busy' ? turn : { ...turn, id: 'next-turn' }] };
      }
      if (method === 'thread/items/list') {
        if (step === 'start') return { data: [started] };
        if (step === 'busy' && !params.cursor) return { data: busyPages[0], nextCursor: 'more' };
        if (step === 'busy' && params.cursor === 'more') return { data: busyPages[1], nextCursor: 'tail' };
        if (step === 'completion-burst') return {
          data: busyPages[params.cursor ? 1 : 0].map(({ item }) => ({ item: {
            ...item, type: 'subAgentActivity', kind: 'completed', agentThreadId: `finished-${item.id}`,
          }, completedAtMs: now * 1000 })),
          nextCursor: params.cursor ? undefined : 'more',
        };
      }
      return { data: [] };
    },
  };
  const frame = async when => renderActivity(await readActivity(client, { threadId: thread.id }), { now: when, embedded: true });
  assert.match(await frame(now), /◐ observed.*gpt-child.*12s/u);
  step = 'busy';
  assert.match(await frame(now + 1), /◐ observed.*gpt-child.*13s/u);
  step = 'next';
  assert.match(await frame(now + 2), /◐ observed.*gpt-child.*14s/u);
  step = 'completion-burst';
  assert.match(await frame(now + 3), /◐ observed.*gpt-child.*15s/u);
  step = 'finished';
  t.mock.timers.tick(7000);
  assert.match(await frame(now + 7), /✓ observed.*gpt-child.*17s/u);
  assert.doesNotMatch(await frame(now + 66), /observed/u);
});

test('a cold HUD recovers child evidence from its exact parent without marking unloaded threads as running', async () => {
  const other = { ...thread, id: 'other-parent' };
  const child = (parent, name, type = 'notLoaded') => ({
    id: name, agentNickname: name, parentThreadId: parent.id, status: { type },
  });
  const known = child(thread, 'from-prior-turn');
  const unknown = child(thread, 'unloaded-without-evidence');
  const active = child(other, 'reported-active', 'active');
  const reads = new Set();
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread: params.threadId === thread.id ? thread : other };
      if (method === 'thread/list') {
        assert.equal(params.currentAccountOnly, true);
        assert.deepEqual(params.sourceKinds, ['subAgentThreadSpawn']);
        reads.add(params.parentThreadId);
        return { data: params.parentThreadId === thread.id ? [known, unknown, active] : [active, known] };
      }
      if (method === 'thread/turns/list') {
        if (params.threadId === thread.id) return params.cursor
          ? { data: [{ ...turn, id: 'earlier-turn' }] } : { data: [turn], nextCursor: 'older' };
        if (params.threadId === other.id) return { data: [turn] };
        return { data: [{ status: 'interrupted', completedAt: null }] };
      }
      if (method === 'thread/items/list' && params.threadId === thread.id && params.turnId === 'earlier-turn') {
        return { data: [{ item: {
          type: 'subAgentActivity', id: 'earlier-start', kind: 'started', agentThreadId: known.id, agentPath: '/root/from-prior-turn',
        } }] };
      }
      return { data: [] };
    },
  };
  const render = async parent => renderActivity(await readActivity(client, { threadId: parent.id }), { embedded: true });
  const [first, second] = await Promise.all([render(thread), render(other)]);
  assert.match(first, /◐ from-prior-turn/u);
  assert.doesNotMatch(first, /reported-active|unloaded-without-evidence/u);
  assert.match(second, /◐ reported-active/u);
  assert.doesNotMatch(second, /from-prior-turn|unloaded-without-evidence/u);
  assert.deepEqual(reads, new Set([thread.id, other.id]));
});

test('the cold child scan continues from older turn cursors and stops once it finds evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const child = { id: 'old-child', parentThreadId: thread.id, status: { type: 'notLoaded' } };
  const cursors = [];
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') return { data: [child] };
      if (method === 'thread/turns/list') {
        if (params.threadId === child.id) return { data: [{ status: 'interrupted', completedAt: null }] };
        if (!params.cursor) return { data: [turn], nextCursor: 'prior-1' };
        cursors.push(params.cursor);
        const index = Number(params.cursor.slice(-1));
        return { data: [{ ...turn, id: params.cursor }], nextCursor: `prior-${index + 1}` };
      }
      if (method === 'thread/items/list' && params.turnId === 'prior-4') return { data: [{ item: {
        id: 'old-start', type: 'subAgentActivity', kind: 'started', agentThreadId: child.id, agentPath: '/root/recovered',
      } }] };
      return { data: [] };
    },
  };
  const frame = async () => renderActivity(await readActivity(client, { threadId: thread.id }), { embedded: true });
  assert.doesNotMatch(await frame(), /recovered/u);
  assert.deepEqual(cursors, ['prior-1', 'prior-2']);
  t.mock.timers.tick(5001);
  assert.match(await frame(), /◐ recovered/u);
  assert.deepEqual(cursors, ['prior-1', 'prior-2', 'prior-3', 'prior-4']);
  t.mock.timers.tick(5001);
  assert.match(await frame(), /◐ recovered/u);
  assert.deepEqual(cursors, ['prior-1', 'prior-2', 'prior-3', 'prior-4']);
});

test('a child on the next roster page is recovered and checked again when the parent switches turns', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const child = { id: 'next-page-child', parentThreadId: thread.id, status: { type: 'notLoaded' } };
  const finished = Array.from({ length: 16 }, (_, index) => ({
    id: `ended-child-${index}`, parentThreadId: thread.id, updatedAt: now - 10, status: { type: 'notLoaded' },
  }));
  const decoy = { id: 'decoy-child', agentNickname: 'decoy', parentThreadId: 'different-parent', status: { type: 'active' } };
  const cursors = [];
  const childReads = [];
  let current = turn;
  let completed = false;
  const client = {
    async request(method, params) {
      if (method === 'thread/read') {
        if (params.threadId === thread.id) return { thread };
        childReads.push(params.threadId);
        return { thread: child };
      }
      if (method === 'thread/list') {
        assert.equal(params.parentThreadId, thread.id);
        assert.equal(params.currentAccountOnly, true);
        assert.equal(params.limit, 16);
        cursors.push(params.cursor);
        return params.cursor === 'next-page' ? { data: [child, decoy] } : { data: finished, nextCursor: 'next-page' };
      }
      if (method === 'thread/turns/list') {
        if (params.threadId === thread.id) return params.cursor
          ? { data: [{ ...turn, id: 'older' }] } : { data: [current], nextCursor: 'parent-prior' };
        if (params.threadId === child.id) return { data: [{
          id: 'actual-child-turn', status: completed ? 'completed' : 'interrupted',
          startedAt: now - 20, completedAt: completed ? now + 12 : null,
        }] };
        if (finished.some(entry => entry.id === params.threadId)) return { data: [{ status: 'completed', completedAt: now - 10 }] };
        childReads.push(params.threadId);
      }
      if (method === 'thread/items/list' && params.turnId === 'older') return { data: [{
        item: { id: 'earlier-start', type: 'subAgentActivity', kind: 'started', agentThreadId: child.id, agentPath: '/root/page-two' },
        startedAtMs: (now - 20) * 1000,
      }] };
      return { data: [] };
    },
  };
  const frame = async () => renderActivity(await readActivity(client, { threadId: thread.id }), { embedded: true });
  assert.doesNotMatch(await frame(), /◐/u);
  t.mock.timers.tick(5001);
  assert.match(await frame(), /◐ page-two/u);
  current = { ...turn, id: 'new-parent-turn' };
  t.mock.timers.tick(5001);
  assert.match(await frame(), /◐ page-two/u);
  t.mock.timers.tick(5001);
  assert.match(await frame(), /◐ page-two/u);
  completed = true;
  t.mock.timers.tick(5001);
  assert.match(await frame(), /✓ page-two/u);
  assert.deepEqual(cursors, [undefined, 'next-page', undefined, 'next-page', undefined]);
  assert.deepEqual(childReads, [child.id, child.id]);
});

test('a same-second child completion ends the current run without ending a newer run', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 + 500 });
  const child = { id: 'precise-child', parentThreadId: thread.id, status: { type: 'notLoaded' } };
  let start = { id: 'parent-first-start', ms: now * 1000 + 350 };
  let childTurn = { id: 'first-run', status: 'completed', startedAt: now, completedAt: now };
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') return { data: [child] };
      if (method === 'thread/turns/list') return { data: [params.threadId === child.id ? childTurn : turn] };
      if (method === 'thread/items/list') return { data: [{
        item: { id: start.id, type: 'subAgentActivity', kind: 'started', agentThreadId: child.id, agentPath: '/root/fast' },
        startedAtMs: start.ms,
      }] };
      return { data: [] };
    },
  };
  const frame = async () => renderActivity(await readActivity(client, { threadId: thread.id }), { embedded: true });
  assert.match(await frame(), /✓ fast.*<1s/u);
  start = { id: 'parent-next-start', ms: now * 1000 + 850 };
  t.mock.timers.tick(5001);
  assert.match(await frame(), /◐ fast/u);
  childTurn = { id: 'next-run', status: 'completed', startedAt: now, completedAt: now + 1 };
  t.mock.timers.tick(5001);
  assert.match(await frame(), /✓ fast/u);
});

for (const startDelay of [850, 1850]) {
  test(`a late completion from the preceding child turn cannot finish a restart ${startDelay}ms into the timeline`, async t => {
    const now = 1760007000;
    const second = now * 1000;
    t.mock.timers.enable({ apis: ['Date'], now: second + 2500 });
    const child = { id: 'reused-child', parentThreadId: thread.id, status: { type: 'notLoaded' } };
    const activity = (id, kind, ms) => ({
      item: { id, type: 'subAgentActivity', kind, agentThreadId: child.id, agentPath: '/root/reused' },
      [kind === 'started' ? 'startedAtMs' : 'completedAtMs']: ms,
    });
    const opening = activity('first-start', 'started', second - 20_000);
    let parentItems = [opening];
    // The standalone app-server cannot confirm that an unloaded turn is still running.
    let childTurn = { id: 'old-child-turn', status: 'interrupted', startedAt: now - 20, completedAt: null };
    let childReads = 0;
    const client = {
      async request(method, params) {
        if (method === 'thread/read') return { thread };
        if (method === 'thread/list') return { data: [child] };
        if (method === 'thread/turns/list') {
          if (params.threadId === child.id) childReads++;
          return { data: [params.threadId === child.id ? childTurn : turn] };
        }
        if (method === 'thread/items/list') return { data: parentItems };
        return { data: [] };
      },
    };
    const frame = async () => renderActivity(await readActivity(client, { threadId: thread.id }), { embedded: true });
    assert.match(await frame(), /◐ reused/u);
    parentItems = [activity('next-start', 'started', second + startDelay), activity('first-end', 'completed', second + 100), opening];
    childTurn = { ...childTurn, status: 'completed', completedAt: now };
    t.mock.timers.tick(5001);
    assert.match(await frame(), /◐ reused/u);
    childTurn = { id: 'new-child-turn', status: 'interrupted', startedAt: now + Math.floor(startDelay / 1000), completedAt: null };
    t.mock.timers.tick(5001);
    assert.match(await frame(), /◐ reused/u);
    childTurn = { ...childTurn, status: 'completed', completedAt: now + Math.floor(startDelay / 1000) };
    t.mock.timers.tick(5001);
    assert.match(await frame(), /✓ reused.*<1s/u);
    t.mock.timers.tick(5001);
    assert.match(await frame(), /✓ reused/u);
    assert.equal(childReads, 4);
  });
}

test('a cold HUD can match an already-finished child turn to the new parent start', async t => {
  const now = 1760007000;
  const second = now * 1000;
  t.mock.timers.enable({ apis: ['Date'], now: second + 1500 });
  const child = { id: 'resumed-child', parentThreadId: thread.id, status: { type: 'notLoaded' } };
  const event = (id, kind, timing) => ({
    item: { id, type: 'subAgentActivity', kind, agentThreadId: child.id, agentPath: '/root/resumed' }, ...timing,
  });
  const clientFor = earlierStart => ({
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') return { data: [child] };
      if (method === 'thread/turns/list') return { data: [params.threadId === child.id
        ? { id: 'new-child-turn', status: 'completed', startedAt: now, completedAt: now }
        : turn] };
      if (method === 'thread/items/list') return { data: [
        event('new-start', 'started', { startedAtMs: second + 850 }),
        event('old-end', 'completed', { completedAtMs: second + 100 }),
        event('old-start', 'started', { startedAtMs: earlierStart }),
      ] };
      return { data: [] };
    },
  });
  const frame = async client => renderActivity(await readActivity(client, { threadId: thread.id }), { embedded: true });
  const distinctStart = clientFor(second - 20_000);
  assert.match(await frame(distinctStart), /✓ resumed.*<1s/u);
  t.mock.timers.tick(5001);
  assert.match(await frame(distinctStart), /✓ resumed/u);
  const ambiguousStart = clientFor(second + 20);
  assert.match(await frame(ambiguousStart), /◐ resumed/u);
  assert.doesNotMatch(await frame(ambiguousStart), /✓ resumed/u);
});
