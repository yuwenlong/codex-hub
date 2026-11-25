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
  assert.equal(snapshot.agents.length, 1);
  assert.deepEqual(
    {
      id: snapshot.agents[0].id, name: snapshot.agents[0].name, model: snapshot.agents[0].model,
      reasoning: snapshot.agents[0].reasoning, status: snapshot.agents[0].status,
    },
    { id: 'agent', name: 'worker', model: 'gpt-6.2', reasoning: 'low', status: 'completed' },
  );
  assert.match(output, /◐ Shell │ ✓ Shell/);
  assert.match(output, /^MCPs \(1\) ✗ repo$/m);
  assert.doesNotMatch(output, /✓ worker|worker/u);
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
  assert.match(lines[1], /^上下文 ███░░░░░░░ 32% │ 5h 剩余 53% \(54m\) │ 7d 剩余 39% \(6d 14h 0m\)/);
  assert.match(lines[2], /^内存 +█████░░░░░ 46% \(10\.3 GB \/ 22\.5 GB\)$/);
  assert.match(lines[3], /^2 AGENTS\.md │ 6 MCPs │ 1 钩子/);
  assert.match(output, /✓ Shell ×20\n▸ Skills \(2\) 已选 superpowers:systematic-debugging, ponytail:ponytail\nMCPs \(2\)/);
  assert.match(lines[4], /^词元 9\.9M \(输入 678k, 输出 31k, 缓存 9\.2M\) │ 最近输出 ≈7\.7 tok\/s$/);
  const colored = renderActivity(previewActivity(), { color: true }).split('\n');
  const sgr = (tone, value) => `\u001b[${tone}m${value}\u001b[0m`;
  assert.deepEqual(colored[0].split(' │ ').slice(0, 3), [
    sgr(36, '[GPT-6.2-Astra ● max]'),
    sgr(33, 'codex-hud') + sgr(35, ' git:(') + sgr(36, 'main') + sgr(35, ')'),
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

test('shows a measured text output rate on the token row in the HUD and activity view', () => {
  const snapshot = { id: thread.id, workspace: cwd, tokens: { total: 2400, output: 100 }, outputTokensPerSecond: 7.684 };
  for (const embedded of [false, true]) {
    assert.match(renderActivity(snapshot, { embedded }), /^词元 2\.4k \(输出 100\) │ 最近输出 ≈7\.7 tok\/s$/m);
    const narrow = renderActivity(snapshot, { embedded, width: 25 });
    assert.match(narrow, /^最近输出 ≈7\.7 tok\/s$/m);
    assert.doesNotMatch(renderActivity({ ...snapshot, outputTokensPerSecond: 0 }, { embedded }), /tok\/s/);
  }
  assert.match(renderActivity({ ...snapshot, tokens: undefined }), /^最近输出 ≈7\.7 tok\/s$/m);
});

test('keeps the token and output rate row visible near the top when long activity lists overflow terminal height', () => {
  const sample = previewActivity();
  const now = sample.createdAt + 6960;
  const snapshot = {
    ...sample,
    tools: [
      { name: 'Shell', done: 12 },
      { name: '文件变更', done: 4 },
      { name: '网页搜索', done: 2 },
      { name: '查看图片', done: 1 },
      { name: '图片生成', done: 1 },
      { name: 'codegraph/search', server: 'codegraph', done: 3 },
      { name: 'chrome-devtools/list_pages', server: 'chrome-devtools', done: 2 },
      { name: 'amap-maps/maps_geo', server: 'amap-maps', done: 1 },
      { name: 'drawio-mcp/list_pages', server: 'drawio-mcp', done: 1 },
      { name: 'tavily-remote-mcp/tavily_search', server: 'tavily-remote-mcp', done: 1 },
      { name: 'context7/query-docs', server: 'context7', running: 1 },
      { name: 'extra/tool', server: 'extra', done: 1 },
    ],
    skills: ['skill-one', 'skill-two', 'skill-three', 'skill-four', 'skill-five'],
    agents: Array.from({ length: 14 }, (_, index) => ({
      id: `agent-${index}`, name: `worker-${index}`, model: 'gpt-6.2', reasoning: 'high', status: 'running',
      startedAtMs: (now - 10 - index) * 1000,
      task: `检查长任务列表并保持顶部词元与输出速率可见 第${index + 1}号子代理`,
      activity: '读取 rollout 文件并核对终端面板高度裁剪行数',
    })),
    taskProgress: { completed: 2, total: 5, current: '核对面板高度裁剪' },
  };
  const tokenLine = /^词元 9\.9M \(输入 678k, 输出 31k, 缓存 9\.2M\) │ 最近输出 ≈7\.7 tok\/s$/m;
  for (const width of [84, 120]) {
    const full = renderActivity(snapshot, { now, width }).split('\n');
    assert.ok(full.length >= 24);
    for (const height of [9, 12]) {
      const output = renderActivity(snapshot, { now, width, height });
      const cropped = output.split('\n');
      assert.equal(cropped.length, height);
      assert.match(output, tokenLine);
      if (width === 120) assert.match(cropped[4], tokenLine);
      assert.match(cropped.at(-1), /^… 另有 \d+ 行$/);
    }
  }
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
  assert.match(view({ width: 24 }), /^Codex 5h .*100% \(1h 0m\)$/m);
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

test('an embedded active session shows verified tool, skill and active agent rows', async () => {
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
  assert.deepEqual(
    snapshot.agents.map(({ id, status, startedAtMs, completedAtMs }) => ({ id, status, startedAtMs, completedAtMs })),
    [
      { id: 'stale', status: 'completed', startedAtMs: timestamp(180), completedAtMs: timestamp(70) },
      { id: 'third-completion', status: 'completed', startedAtMs: timestamp(60), completedAtMs: timestamp(50) },
      { id: 'recent-a', status: 'completed', startedAtMs: timestamp(50), completedAtMs: timestamp(25) },
      { id: 'recent-b', status: 'completed', startedAtMs: timestamp(48), completedAtMs: timestamp(12) },
      { id: 'running', status: 'running', startedAtMs: timestamp(10), completedAtMs: undefined },
    ],
  );
  const frame = renderActivity({ ...snapshot, taskProgress: { completed: 1, total: 3, current: '检查布局' } }, { embedded: true, now });
  assert.match(frame, /✓ Shell\n▸ Skills \(1\) 已选 terminal-layout\nMCPs \(1\) ✗ repo\n/);
  assert.match(frame, /◐ running.*gpt-6\.2 ◕ xhigh.*10s/);
  assert.match(frame, /▸ 检查布局 \(1\/3\)/);
  assert.match(frame, /最近回合压缩 1 次/);
  assert.doesNotMatch(frame, /stale|third-completion|recent-[ab]|✓ recent|requested-model|repo\/|范围|暂无/);

  const later = renderActivity(snapshot, { embedded: true, now: now + 61 });
  assert.match(later, /◐ running/);
  assert.doesNotMatch(later, /✓ recent|recent-[ab]|▸ 检查布局/);
});

test('child rows use distinct dispatches for the exact recipients and retain the latest task after completion', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const start = name => ({
    id: `${name}-start`, type: 'subAgentActivity', kind: 'started', agentThreadId: name,
    agentPath: `/root/${name}`, model: 'gpt-child', reasoningEffort: 'high', startedAtMs: (now - 10) * 1000,
  });
  const dispatch = (id, tool, child, prompt, extra = {}) => ({
    id, type: 'collabAgentToolCall', tool, senderThreadId: thread.id, receiverThreadIds: [child],
    prompt, status: 'completed', model: null, reasoningEffort: null, agentsStates: {}, ...extra,
  });
  const opening = [
    start('alpha'), dispatch('dispatch-alpha', 'spawnAgent', 'alpha', '检查启动入口', { agentsStates: { beta: { status: 'running' } } }),
    start('beta'), dispatch('dispatch-beta', 'spawnAgent', 'beta', '核对额度窗口'),
    dispatch('unrelated-sender', 'sendInput', 'alpha', 'wrong-sender', { senderThreadId: 'other-parent' }),
    dispatch('message', 'sendMessage', 'alpha', 'ordinary-message'),
    dispatch('failed', 'sendInput', 'alpha', 'failed-dispatch', { status: 'failed' }),
  ];
  let items = opening;
  const client = {
    async request(method) {
      if (method === 'thread/read') return { thread: { ...thread, historyMode: 'legacy' } };
      if (method === 'thread/turns/list') return { data: [{ ...turn, items }] };
      return { data: [] };
    },
  };
  const read = () => readActivity(client, { threadId: thread.id });
  const frame = snapshot => renderActivity(snapshot, { embedded: true, now });
  const original = frame(await read());
  assert.match(original, /^◐ alpha.*gpt-child ◑ high.*10s │ 任务 检查启动入口$/m);
  assert.match(original, /^◐ beta.*10s │ 任务 核对额度窗口$/m);
  assert.doesNotMatch(original, /wrong-sender|ordinary-message|failed-dispatch/);

  items = [
    ...opening,
    dispatch('follow-up-beta', 'sendInput', 'beta', '复核周额度'),
    dispatch('follow-up-alpha', 'followupTask', 'alpha', '验证导出结果'),
    {
      id: 'alpha-end', type: 'subAgentActivity', kind: 'completed',
      agentThreadId: 'alpha', agentPath: '/root/alpha', completedAtMs: (now - 1) * 1000,
    },
    dispatch('outcome', 'wait', 'alpha', 'wait-result', {
      agentsStates: { alpha: { status: 'completed', message: 'completion-message' } },
    }),
  ];
  const updatedSnapshot = await read();
  const alphaUpdated = updatedSnapshot.agents.find(agent => agent.id === 'alpha');
  assert.equal(alphaUpdated?.status, 'completed');
  assert.equal(alphaUpdated?.model, 'gpt-child');
  assert.equal(alphaUpdated?.reasoning, 'high');
  assert.equal(alphaUpdated?.startedAtMs, (now - 10) * 1000);
  assert.equal(alphaUpdated?.completedAtMs, (now - 1) * 1000);
  assert.equal(alphaUpdated?.task, '验证导出结果');
  const updated = frame(updatedSnapshot);
  assert.match(updated, /^◐ beta.*10s │ 任务 复核周额度$/m);
  assert.doesNotMatch(updated, /alpha|✓ alpha|检查启动入口|核对额度窗口|验证导出结果|wait-result|completion-message/);

  items = opening;
  const retainedSnapshot = await read();
  const alphaRetained = retainedSnapshot.agents.find(agent => agent.id === 'alpha');
  assert.equal(alphaRetained?.status, 'completed');
  assert.equal(alphaRetained?.task, '验证导出结果');
  const retained = frame(retainedSnapshot);
  assert.match(retained, /^◐ beta.*10s │ 任务 复核周额度$/m);
  assert.doesNotMatch(retained, /alpha|✓ alpha/u);
});

for (const [scenario, prompt] of [['empty', null], ['sealed', 'a'.repeat(90)], ['unpublished', undefined]]) {
  test(`a new child run replaces the old task in warm and cold HUDs when the assignment is ${scenario}`, async t => {
    const now = 1760007000;
    const base = now * 1000;
    t.mock.timers.enable({ apis: ['Date'], now: base });
    const child = { id: 'reused', parentThreadId: thread.id, status: { type: 'notLoaded' }, updatedAt: now };
    const dispatch = (id, tool, prompt, ms) => ({
      item: {
        id, type: 'collabAgentToolCall', tool, prompt, status: 'completed', senderThreadId: thread.id,
        receiverThreadIds: [child.id], agentsStates: {},
      },
      completedAtMs: ms,
    });
    const event = (id, kind, ms) => ({
      item: { id, type: 'subAgentActivity', kind, agentThreadId: child.id, agentPath: '/root/reused' },
      [kind === 'started' ? 'startedAtMs' : 'completedAtMs']: ms,
    });
    let parentItems = [
      dispatch('original-task', 'spawnAgent', '核对旧版脚本', base - 10_050),
      event('first-start', 'started', base - 10_000),
      event('first-finish', 'completed', base - 500),
    ];
    let childTurn = { id: 'first-child-turn', status: 'completed', startedAt: now - 10, completedAt: now - 1 };
    const itemReads = [];
    const client = {
      async request(method, params) {
        if (method === 'thread/read') return { thread };
        if (method === 'thread/list') return { data: [child] };
        if (method === 'thread/turns/list') return { data: [params.threadId === child.id ? childTurn : turn] };
        if (method === 'thread/items/list' && params.threadId === thread.id) return { data: parentItems.toReversed() };
        if (method === 'thread/items/list') {
          itemReads.push(params.turnId);
          return { data: [{
            turnId: childTurn.id,
            item: { type: 'fileChange', id: 'new-file', status: 'completed',
              changes: [{ path: childTurn.id === 'first-child-turn' ? 'first.md' : 'second.md' }] },
          }] };
        }
        return { data: [] };
      },
    };
    const read = (activityClient = client) => readActivity(activityClient, { threadId: thread.id });
    const frame = async (activityClient = client) => renderActivity(await read(activityClient),
      { embedded: true, now: Date.now() / 1000 });
    const firstSnapshot = await read();
    const firstAgent = firstSnapshot.agents.find(agent => agent.id === 'reused');
    assert.equal(firstAgent?.status, 'completed');
    assert.equal(firstAgent?.task, '核对旧版脚本');
    assert.doesNotMatch(renderActivity(firstSnapshot, { embedded: true, now: Date.now() / 1000 }), /reused|✓ reused/u);
    assert.deepEqual(itemReads, []);

    parentItems = [...parentItems, event('second-start', 'started', base + 1050),
      ...(prompt === undefined ? [] : [dispatch('next-task', 'followupTask', prompt, base + 1100)]),
      dispatch('out-of-order-old-task', 'sendInput', '乱序旧派单', base - 1000),
    ];
    childTurn = { id: 'second-child-turn', status: 'interrupted', startedAt: now + 1, completedAt: null };
    t.mock.timers.tick(5001);
    const warm = await frame();
    const cold = await frame({ ...client });
    for (const output of [warm, cold]) {
      assert.match(output, /^◐ reused.*最近活动 修改 second\.md$/m);
      assert.doesNotMatch(output, /核对旧版脚本|乱序旧派单|a{64}/u);
    }
    assert.deepEqual(itemReads, ['second-child-turn', 'second-child-turn']);
  });
}

test('a same-second child completion marks children completed without refreshing hidden rows', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 + 300 });
  const children = ['empty', 'stale'].map(id => ({ id, parentThreadId: thread.id, status: { type: 'notLoaded' }, updatedAt: now }));
  const event = (id, kind, ms) => ({
    item: { id: `${id}-${kind}`, type: 'subAgentActivity', kind, agentThreadId: id, agentPath: `/root/${id}` },
    [kind === 'started' ? 'startedAtMs' : 'completedAtMs']: now * 1000 + ms,
  });
  let parentItems = children.map(({ id }) => event(id, 'started', 100));
  let finished = false;
  const itemReads = [];
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') return { data: children };
      if (method === 'thread/turns/list') return { data: [params.threadId === thread.id ? turn : {
        id: `${params.threadId}-turn`, status: finished ? 'completed' : 'interrupted', startedAt: now, completedAt: finished ? now : null,
      }] };
      if (method === 'thread/items/list' && params.threadId === thread.id) return { data: parentItems.toReversed() };
      if (method === 'thread/items/list') {
        itemReads.push(params.turnId);
        const path = finished ? `${params.threadId}-final.md` : params.threadId === 'stale' ? 'draft.md' : undefined;
        return { data: path ? [{
          turnId: params.turnId, item: { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path }] },
        }] : [] };
      }
      return { data: [] };
    },
  };
  const read = (activityClient = client) => readActivity(activityClient, { threadId: thread.id });
  const render = snapshot => renderActivity(snapshot, { embedded: true, now: Date.now() / 1000 });
  const active = render(await read());
  assert.match(active, /^◐ stale.*修改 draft\.md$/m);
  assert.match(active, /^◐ empty(?!.*最近活动).*$/m);
  parentItems = [...parentItems, ...children.map(({ id }) => event(id, 'completed', 800))];
  finished = true;
  t.mock.timers.tick(5001);
  const warmSnapshot = await read();
  const coldSnapshot = await read({ ...client });
  for (const snapshot of [warmSnapshot, coldSnapshot]) {
    for (const id of ['empty', 'stale']) {
      const agent = snapshot.agents.find(entry => entry.id === id);
      assert.equal(agent?.status, 'completed');
      assert.equal(agent?.startedAtMs, now * 1000 + 100);
      assert.equal(agent?.completedAtMs, now * 1000 + 800);
    }
    assert.doesNotMatch(render(snapshot), /empty|stale|✓ (?:empty|stale)|draft\.md|final\.md/u);
  }
  t.mock.timers.tick(17000);
  assert.doesNotMatch(render(await read()), /empty|stale|✓ (?:empty|stale)/u);
  assert.deepEqual(itemReads.toSorted(), ['empty-turn', 'stale-turn']);
});

test('a cold HUD recovers a running child task from an older parent turn when recent messages only establish its status', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const child = { id: 'recover-task', parentThreadId: thread.id, agentNickname: 'worker', status: { type: 'notLoaded' }, updatedAt: now };
  const dispatch = (id, tool, prompt) => ({
    item: {
      id, type: 'collabAgentToolCall', tool, prompt, status: 'completed', senderThreadId: thread.id,
      receiverThreadIds: [child.id], agentsStates: { [child.id]: { status: 'running' } },
    },
  });
  const opening = dispatch('original-task', 'spawnAgent', '核对入口');
  const later = dispatch('sender-status', 'sendMessage', '普通消息');
  const start = (id, at) => ({
    item: { id, type: 'subAgentActivity', kind: 'started', agentThreadId: child.id, agentPath: '/root/worker' },
    startedAtMs: at * 1000,
  });
  let currentTurn = { ...turn, id: 'dispatch-turn' };
  let restarted = false;
  const cursors = [];
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') return { data: [child] };
      if (method === 'thread/turns/list') {
        if (params.threadId === child.id) return { data: [restarted
          ? { id: 'next-child-turn', status: 'interrupted', startedAt: now + 11, completedAt: null }
          : { id: 'child-turn', status: 'interrupted', startedAt: now - 10, completedAt: null }] };
        if (params.cursor === 'prior') {
          cursors.push(params.cursor);
          return { data: [{ ...turn, id: 'dispatch-turn' }] };
        }
        return { data: [currentTurn], nextCursor: currentTurn === turn ? 'prior' : undefined };
      }
      if (method === 'thread/items/list' && params.threadId === thread.id) {
        if (params.turnId === 'dispatch-turn') return { data: [start('first-start', now - 10), opening] };
        return { data: restarted ? [start('next-start', now + 11), later] : [later] };
      }
      return { data: [] };
    },
  };
  const frame = async activityClient => renderActivity(await readActivity(activityClient, { threadId: thread.id }),
    { embedded: true, now: Date.now() / 1000 });
  assert.match(await frame(client), /任务 核对入口/u);
  currentTurn = turn;
  t.mock.timers.tick(5001);
  assert.match(await frame(client), /任务 核对入口/u);
  const freshClient = { ...client };
  assert.match(await frame(freshClient), /任务 核对入口/u);
  t.mock.timers.tick(5001);
  assert.match(await frame(freshClient), /任务 核对入口/u);
  restarted = true;
  t.mock.timers.tick(5001);
  const next = await frame(freshClient);
  assert.match(next, /^◐ worker/m);
  assert.doesNotMatch(next, /任务 核对入口/u);
  assert.deepEqual(cursors, ['prior']);
});

test('v2 child rows show evidence from visible child turns and reuse unchanged activity', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const children = ['hidden', 'left', 'right', 'settled'].map(id => ({
    id, parentThreadId: thread.id, historyMode: 'paginated', status: { type: 'notLoaded' },
    updatedAt: now - 1, preview: 'inherited-thread-preview',
  }));
  Object.assign(children[2], {
    agentRole: 'coder',
    source: { subAgent: { thread_spawn: {
      agent_path: '/root/fix_rendering', parent_thread_id: thread.id, depth: 1,
    } } },
  });
  const tasks = { left: '核对入口', right: 'a'.repeat(128), settled: '检查布局' };
  let starts = children.flatMap(({ id }) => [
    { item: { id: `${id}-start`, type: 'subAgentActivity', kind: 'started', agentThreadId: id,
      agentPath: `/root/${id === 'right' ? 'fix_rendering' : id}` },
      startedAtMs: (now - 10) * 1000 },
    ...(tasks[id] ? [{ item: {
      id: `${id}-dispatch`, type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
      senderThreadId: thread.id, receiverThreadIds: [id], prompt: tasks[id], agentsStates: {},
    }, completedAtMs: (now - 10) * 1000 }] : []),
  ]);
  // All running children are shown without a three-row limit; finished children are hidden.
  const settled = {
    item: { id: 'settled-end', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'settled' },
    completedAtMs: (now - 1) * 1000,
  };
  const childTurns = new Map(children.map(({ id }) => [id, {
    id: `${id}-turn`, status: 'interrupted', startedAt: now - 10, completedAt: null,
  }]));
  const entries = (items, turnId) => items.map(item => ({ item, turnId }));
  const itemsByChild = new Map([
    ['left', [
      ...Array.from({ length: 13 }, (_, index) => ({ id: `thought-${index}`, type: 'reasoning', summary: ['private-reasoning'] })),
      { id: 'msg', type: 'agentMessage', text: 'ordinary-final-answer' },
      { id: 'cmd', type: 'commandExecution', command: 'raw-command', status: 'completed', aggregatedOutput: 'raw-output',
        commandActions: [{ type: 'unknown', command: 'raw-action' }] },
      { id: 'read', type: 'commandExecution', command: 'raw-read', status: 'completed',
        commandActions: [{ type: 'read', name: 'terminal-host.mjs', path: '/private/root/terminal-host.mjs' }] },
      { id: 'inherited', type: 'userMessage', content: [{ type: 'text', text: 'inherited-user-prompt' }] },
    ]],
    ['right', [{
      id: 'edit', type: 'fileChange', status: 'completed',
      changes: [{ path: 'C:\\private\\activity.mjs', diff: 'private-diff', kind: { type: 'update' } }],
    }]],
    ['settled', [{ id: 'plan', type: 'plan', text: '核对状态栏布局\n计划细节不进入 HUD' }]],
  ]);
  const itemReads = [];
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') return { data: children };
      if (method === 'thread/turns/list') return { data: [childTurns.get(params.threadId) ?? turn] };
      if (method === 'thread/items/list' && params.threadId === thread.id) return { data: starts.toReversed() };
      if (method === 'thread/items/list') {
        itemReads.push(params.threadId);
        assert.equal(params.turnId, childTurns.get(params.threadId).id);
        assert.equal(params.sortDirection, 'desc');
        assert.equal(params.deferOutput.commandExecution, true);
        assert.ok(params.limit <= 24);
        return { data: entries((itemsByChild.get(params.threadId) ?? []).slice(0, params.limit), params.turnId) };
      }
      return {};
    },
  };
  const read = () => readActivity(client, { threadId: thread.id });
  const render = snapshot => renderActivity(snapshot, { now: Date.now() / 1000, embedded: true });
  const running = render(await read());
  assert.match(running, /^◐ settled.*任务 检查布局 │ 最近活动 计划 核对状态栏布局$/m);
  assert.match(running, /^◐ left.*任务 核对入口 │ 最近活动 读取 terminal-host\.mjs$/m);
  assert.match(running, /^◐ coder.*任务名 fix_rendering │ 最近活动 修改 activity\.mjs$/m);
  assert.match(running, /^◐ hidden │ 进行中 │ 10s$/m);
  assert.doesNotMatch(running, /raw-|private-|inherited-|ordinary-final-answer|计划细节|a{64}/);
  assert.deepEqual(itemReads.toSorted(), ['hidden', 'left', 'right', 'settled']);

  Object.assign(children[2], { agentNickname: 'Flora', agentRole: 'fix_rendering' });
  children[1].agentNickname = 'Ivy';
  t.mock.timers.tick(5001);
  const withNicknames = render(await read());
  assert.match(withNicknames, /^◐ Ivy.*任务 核对入口 │ 最近活动 读取 terminal-host\.mjs$/m);
  assert.match(withNicknames, /^◐ Flora.*任务名 fix_rendering │ 最近活动 修改 activity\.mjs$/m);
  assert.equal(itemReads.length, 4);

  starts = [...starts, {
    item: { id: 'hidden-end', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'hidden' },
    completedAtMs: (now - 2) * 1000,
  }, settled, {
    item: { id: 'left-restart', type: 'subAgentActivity', kind: 'started', agentThreadId: 'left', agentPath: '/root/left' },
    startedAtMs: now * 1000 + 5500,
  }];
  t.mock.timers.tick(5001);
  const restartedSnapshot = await read();
  const settledAgent = restartedSnapshot.agents.find(agent => agent.id === 'settled');
  assert.equal(settledAgent?.status, 'completed');
  assert.equal(settledAgent?.task, '检查布局');
  assert.equal(settledAgent?.activity, '计划 核对状态栏布局');
  assert.equal(restartedSnapshot.agents.find(agent => agent.id === 'hidden')?.status, 'completed');
  const restarted = render(restartedSnapshot);
  assert.match(restarted, /^◐ Ivy/m);
  assert.match(restarted, /^◐ Flora.*任务名 fix_rendering │ 最近活动 修改 activity\.mjs$/m);
  assert.doesNotMatch(restarted, /核对入口|读取 terminal-host\.mjs|settled|✓ settled|hidden|✓ hidden|计划细节/u);
});

test('renders all active subagents without a three-row limit and hides inactive ones', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const activeSpecs = [
    ['active-1', 'running', '一号任务'],
    ['active-2', 'pendingInit', '二号等待'],
    ['active-3', 'inProgress', '三号任务'],
    ['active-4', 'running', '四号任务'],
    ['active-5', 'pendingInit', '五号等待'],
    ['active-6', 'inProgress', '六号任务'],
  ];
  const inactiveSpecs = [
    ['done-child', 'completed', '已完成任务'],
    ['fail-child', 'failed', '失败任务'],
    ['stop-child', 'interrupted', '中断任务'],
  ];
  const children = [...activeSpecs, ...inactiveSpecs].map(([id]) => ({
    id, parentThreadId: thread.id, agentNickname: id, status: { type: 'notLoaded' }, updatedAt: now - 1,
  }));
  const parentItems = [];
  activeSpecs.forEach(([id, status, prompt], index) => {
    const at = (now - 20 + index) * 1000;
    if (status !== 'pendingInit') {
      parentItems.push({
        item: { id: `${id}-start`, type: 'subAgentActivity', kind: 'started', agentThreadId: id, agentPath: `/root/${id}` },
        startedAtMs: at,
      });
    }
    parentItems.push({
      item: {
        id: `${id}-dispatch`, type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
        senderThreadId: thread.id, receiverThreadIds: [id], prompt,
        agentsStates: { [id]: { status } },
      },
      completedAtMs: at + 1,
    });
  });
  parentItems.push(
    { item: { id: 'done-start', type: 'subAgentActivity', kind: 'started', agentThreadId: 'done-child', agentPath: '/root/done-child' }, startedAtMs: (now - 10) * 1000 },
    { item: { id: 'done-end', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'done-child' }, completedAtMs: (now - 2) * 1000 },
    { item: { id: 'fail-dispatch', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: thread.id, receiverThreadIds: ['fail-child'], prompt: '失败任务', agentsStates: { 'fail-child': { status: 'failed' } } }, completedAtMs: (now - 5) * 1000 },
    { item: { id: 'stop-start', type: 'subAgentActivity', kind: 'started', agentThreadId: 'stop-child', agentPath: '/root/stop-child' }, startedAtMs: (now - 10) * 1000 },
    { item: { id: 'stop-end', type: 'subAgentActivity', kind: 'interrupted', agentThreadId: 'stop-child' }, completedAtMs: (now - 1) * 1000 },
  );
  const client = {
    async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') return { data: children };
      if (method === 'thread/turns/list') {
        if (params.threadId === thread.id) return { data: [turn] };
        const spec = activeSpecs.find(([id]) => id === params.threadId);
        if (!spec || spec[1] === 'pendingInit') return { data: [] };
        return { data: [{ id: `${params.threadId}-turn`, status: 'interrupted', startedAt: now - 10, completedAt: null }] };
      }
      if (method === 'thread/items/list' && params.threadId === thread.id) return { data: parentItems.toReversed() };
      if (method === 'thread/items/list') {
        return { data: [{
          turnId: `${params.threadId}-turn`,
          item: { id: `${params.threadId}-file`, type: 'fileChange', status: 'completed', changes: [{ path: `${params.threadId}.mjs` }] },
        }] };
      }
      return { data: [] };
    },
  };
  const snapshot = await readActivity(client, { threadId: thread.id });
  assert.deepEqual(
    snapshot.agents.map(({ id, status }) => [id, status]),
    [...activeSpecs.map(([id, status]) => [id, status]), ...inactiveSpecs.map(([id, status]) => [id, status])],
  );
  const output = renderActivity(snapshot, { embedded: true, now });
  const agentLines = output.split('\n').filter(line => line.startsWith('◐ '));
  assert.equal(agentLines.length, 6);
  assert.deepEqual(
    agentLines.map(line => line.match(/^◐ (\S+) │ ([^│]+) │/u).slice(1).map(part => part.trim())),
    [
      ['active-6', '进行中'],
      ['active-4', '进行中'],
      ['active-3', '进行中'],
      ['active-1', '进行中'],
      ['active-5', '等待启动'],
      ['active-2', '等待启动'],
    ],
  );
  assert.match(agentLines[0], /任务 六号任务 │ 最近活动 修改 active-6\.mjs$/u);
  assert.deepEqual(
    output.split('\n').filter(line => /^[◐✓✗] /u.test(line) && !line.startsWith('✓ 子代理工具')),
    agentLines,
  );
  assert.doesNotMatch(output, /done-child|fail-child|stop-child|失败|已中断|已关闭|(?:^|\n)[✓✗] (?!子代理工具)/u);

  const direct = renderActivity({
    id: thread.id,
    agents: [
      { name: 'live-1', status: 'running', startedAtMs: (now - 5) * 1000 },
      { name: 'done-1', status: 'completed', startedAtMs: (now - 5) * 1000, completedAtMs: (now - 1) * 1000 },
      { name: 'wait-1', status: 'pendingInit', startedAtMs: (now - 4) * 1000 },
      { name: 'live-2', status: 'inProgress', startedAtMs: (now - 3) * 1000 },
      { name: 'err-1', status: 'errored', startedAtMs: (now - 5) * 1000, completedAtMs: (now - 1) * 1000 },
      { name: 'live-3', status: 'running', startedAtMs: (now - 2) * 1000 },
      { name: 'shut-1', status: 'shutdown', startedAtMs: (now - 5) * 1000, completedAtMs: (now - 1) * 1000 },
      { name: 'wait-2', status: 'pendingInit', startedAtMs: (now - 1) * 1000 },
      { name: 'stop-1', status: 'interrupted', startedAtMs: (now - 5) * 1000, completedAtMs: (now - 1) * 1000 },
      { name: 'fail-1', status: 'failed', startedAtMs: (now - 5) * 1000, completedAtMs: (now - 1) * 1000 },
    ],
  }, { embedded: true, now });
  assert.deepEqual(
    direct.split('\n').filter(line => line.startsWith('◐ ')).map(line => line.split(' │ ')[0].slice(2)),
    ['live-3', 'live-2', 'live-1', 'wait-2', 'wait-1'],
  );
  assert.doesNotMatch(direct, /done-1|err-1|shut-1|stop-1|fail-1|完成|失败|已中断|已关闭|[✓✗]/u);
});

test('a launch name without a distinct nickname or role uses the child id on its row', async () => {
  const child = { id: '019af525-e5ce-489a-8a62-42409356abef', parentThreadId: thread.id, agentRole: 'reviewer' };
  const started = { item: {
    id: 'started', type: 'subAgentActivity', kind: 'started', agentThreadId: child.id, agentPath: '/root/reviewer',
  } };
  const frame = async () => {
    const client = { async request(method, params) {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/list') return { data: [child] };
      if (method === 'thread/turns/list') return { data: [params.threadId === child.id ? { ...turn, id: 'child-turn' } : turn] };
      if (params?.threadId === thread.id) return { data: [started] };
      return { data: [{ turnId: 'child-turn', item: { id: 'plan', type: 'plan', text: '核对额度' } }] };
    } };
    return renderActivity(await readActivity(client, { threadId: thread.id }), { embedded: true });
  };
  assert.match(await frame(), /^◐ reviewer.*最近活动 计划 核对额度$/m);
  child.source = { subAgent: { thread_spawn: {
    agent_path: '/root/reviewer', parent_thread_id: 'other-thread', depth: 1,
  } } };
  assert.doesNotMatch(await frame(), /任务名 reviewer/u);
  child.source.subAgent.thread_spawn.parent_thread_id = thread.id;
  assert.match(await frame(), /^◐ 子代理 9356abef.*任务名 reviewer │ 最近活动 计划 核对额度$/m);
});

test('warm and cold HUDs omit the launch name on a later run of the same child', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const child = { id: 'reused', parentThreadId: thread.id, agentNickname: 'Flora', createdAt: now, updatedAt: now,
    source: { subAgent: { thread_spawn: { agent_path: '/root/check_logs', parent_thread_id: thread.id, depth: 1 } } } };
  const start = (id, startedAtMs) => ({
    item: { id, type: 'subAgentActivity', kind: 'started', agentThreadId: child.id, agentPath: '/root/check_logs' },
    startedAtMs,
  });
  const dispatch = (id, tool, completedAtMs) => ({
    item: { id, type: 'collabAgentToolCall', tool, status: 'completed',
      senderThreadId: thread.id, receiverThreadIds: [child.id], prompt: 'a'.repeat(128) },
    completedAtMs,
  });
  const spawn = dispatch('spawn', 'spawnAgent', now * 1000 + 35);
  let parentItems = [start('launch', now * 1000 + 30), spawn];
  let childTurn = { id: 'first-turn', status: 'inProgress', startedAt: now, completedAt: null };
  const client = { async request(method, params) {
    if (method === 'thread/read') return { thread };
    if (method === 'thread/list') return { data: [child] };
    if (method === 'thread/turns/list') return { data: [params.threadId === child.id ? childTurn : turn] };
    if (params?.threadId === thread.id) return { data: parentItems.toReversed() };
    return { data: [{ turnId: childTurn.id, item: {
      id: 'change', type: 'fileChange', status: 'completed',
      changes: [{ path: childTurn.id === 'first-turn' ? 'logs.mjs' : 'deploy.mjs' }],
    } }] };
  } };
  const frame = async (reader = client) => renderActivity(await readActivity(reader, { threadId: thread.id }),
    { now: Date.now() / 1000, embedded: true });
  assert.match(await frame(), /^◐ Flora.*任务名 check_logs │ 最近活动 修改 logs\.mjs$/m);

  t.mock.timers.tick(3000);
  parentItems = [spawn, start('launch', (now + 3) * 1000 + 30)];
  childTurn = { ...childTurn, startedAt: now + 3 };
  assert.match(await frame({ ...client }), /^◐ Flora.*任务名 check_logs │ 最近活动 修改 logs\.mjs$/m);

  const twoHoursLater = now + 7200;
  child.updatedAt = twoHoursLater;
  childTurn = { id: 'next-turn', status: 'inProgress', startedAt: twoHoursLater, completedAt: null };
  parentItems = [start('restart', twoHoursLater * 1000 + 50)];
  t.mock.timers.tick(7_198_000);
  const later = await Promise.all([frame(), frame({ ...client })]);
  assert.doesNotMatch(later[1], /任务名 check_logs/u);

  child.createdAt = twoHoursLater;
  const followup = dispatch('follow-up', 'followupTask', twoHoursLater * 1000 + 55);
  parentItems.push(followup);
  const dispatchAfterStart = await frame({ ...client });
  parentItems = [{ ...followup, completedAtMs: twoHoursLater * 1000 + 45 }, parentItems[0]];
  for (const output of [...later, dispatchAfterStart, await frame({ ...client })]) {
    assert.match(output, /^◐ Flora.*最近活动 修改 deploy\.mjs$/m);
    assert.doesNotMatch(output, /任务名 check_logs|a{64}/u);
  }
});

test('child notes stay on their metadata row and clip different-width characters safely', () => {
  const now = 1760007000;
  const activity = {
    id: thread.id, agents: [{
      name: 'worker', status: 'running', startedAtMs: (now - 10) * 1000,
      task: '\u001b[31m验证\u001b[0m\u202e\t布局' + '详情'.repeat(90) + '\nsecond-line',
    }],
  };
  const wide = renderActivity(activity, { now, embedded: true });
  const narrow = stripVTControlCharacters(renderActivity(activity, { now, width: 48, color: true, embedded: true }));
  assert.match(wide, /^◐ worker │ 进行中 │ 10s │ 任务 验证 布局[详情]+…$/m);
  assert.match(narrow, /^◐ worker │ 进行中 │ 10s │ 任务 验证 布局[详情]*…$/m);
  assert.doesNotMatch(wide + narrow, /second-line|\u202e|\u001b/u);
  assert.ok(narrow.split('\n').every(line => [...line].reduce((cells, part) => cells + (/\p{Script=Han}/u.test(part) ? 2 : 1), 0) <= 48));
});

test('child notes continue below tight metadata without taking another agent slot', () => {
  const now = 1760007000;
  const activity = {
    id: thread.id,
    agents: [{
      name: 'reviewer', model: 'gpt-6.2-astra', reasoning: 'max', status: 'running',
      startedAtMs: (now - 10) * 1000, task: '核对启动入口和终端布局',
    }],
  };
  const frame = (width, height) => renderActivity(activity, { now, width, height, embedded: true });
  for (const width of [42, 51, 76]) {
    const output = frame(width, 4);
    assert.match(output, /◐ reviewer.*gpt-6\.2-astra ● max/);
    assert.match(output, /进行中[\s\S]*10s[\s\S]*任务 核对启动/u);
    assert.equal(output.match(/◐/gu).length, 1);
    assert.ok(output.split('\n').every(line => [...line].reduce((cells, part) => cells + (/\p{Script=Han}/u.test(part) ? 2 : 1), 0) <= width));
  }
  assert.match(frame(55, 4), /进行中 │ 10s\n  任务 核对启动入口和终端布局$/u);
  assert.match(frame(55, 1), /◐ reviewer.*进行中 │ 10s$/u);
});

test('long child tasks leave room for recent activity and precede it across narrow continuations', () => {
  const now = 1760007000;
  const snapshot = {
    id: thread.id,
    agents: [{ name: 'worker', status: 'running', startedAtMs: (now - 3) * 1000 }, {
      name: 'reviewer', model: 'gpt-6.2-astra', reasoning: 'max', status: 'running',
      startedAtMs: (now - 10) * 1000, task: '核对启动入口和终端布局'.repeat(5), activity: '读取 HUD 文件',
    }],
  };
  const frame = (width, height) => renderActivity(snapshot, { now, width, height, embedded: true });
  assert.match(frame(112, 4), /^◐ reviewer.*任务 核对启动.*… │ 最近活动 读取 HUD 文件$/m);
  const narrow = frame(52, 7);
  assert.match(narrow, /^◐ reviewer.*\n  任务 核对启动.*…\n  最近活动 读取 HUD 文件\n◐ worker/m);
  assert.ok(narrow.split('\n').every(line => [...line].reduce((cells, part) => cells + (/\p{Script=Han}/u.test(part) ? 2 : 1), 0) <= 52));

  // Verify bounded height accounting when agent continuations overflow (B=3 with header, C=2, total=5).
  const boundedSnapshot = {
    ...snapshot,
    workspace: cwd,
    model: 'gpt-6.2',
  };
  const renderBounded = height => renderActivity(boundedSnapshot, { now, width: 52, height, embedded: true }).split('\n');
  const fullLines = renderBounded(undefined);
  assert.equal(fullLines.length, 5);

  // B < height < B + C (B=3, C=2, height=4 -> limit=3, spare=0, hidden=2)
  const height4 = renderBounded(4);
  assert.equal(height4.length, 4);
  assert.equal(height4.at(-1), '… 另有 2 行');

  // With two continuations on one agent and B=2 (no header), test B < height < B + C with spare > 0 (B=2, C=2, total=4)
  const noHeader = height => renderActivity(snapshot, { now, width: 52, height, embedded: true }).split('\n');
  assert.equal(noHeader(undefined).length, 4);
  const b2h3 = noHeader(3);
  assert.equal(b2h3.length, 3);
  assert.equal(b2h3.at(-1), '… 另有 2 行');

  // B === height && C > 0 (B=3, C=2, height=3 -> limit=2, spare=0, hidden=3)
  const height3 = renderBounded(3);
  assert.equal(height3.length, 3);
  assert.equal(height3.at(-1), '… 另有 3 行');

  // B > height && C > 0 (B=3, C=2, height=2 -> limit=1, spare=0, hidden=4)
  const height2 = renderBounded(2);
  assert.equal(height2.length, 2);
  assert.equal(height2[0], fullLines[0]);
  assert.equal(height2[1], '… 另有 4 行');

  // height === 1
  const height1 = renderBounded(1);
  assert.deepEqual(height1, [fullLines[0]]);
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
  const finishedSnapshot = await readActivity(client, { threadId: thread.id });
  const observedAgent = finishedSnapshot.agents.find(agent => agent.id === childId);
  assert.equal(observedAgent?.status, 'completed');
  assert.equal(observedAgent?.model, 'gpt-child');
  assert.equal(observedAgent?.startedAtMs, (now - 12) * 1000);
  assert.equal(observedAgent?.completedAtMs, (now + 5) * 1000);
  assert.doesNotMatch(renderActivity(finishedSnapshot, { now: now + 7, embedded: true }), /observed|✓ observed/u);
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
  let followedUp = false;
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
          type: 'collabAgentToolCall', id: 'earlier-dispatch', status: 'completed', tool: 'spawnAgent',
          senderThreadId: thread.id, receiverThreadIds: ['unrelated-child', known.id],
          prompt: '检查旧版会话恢复', model: null, reasoningEffort: null, agentsStates: {},
        } }, { item: {
          type: 'subAgentActivity', id: 'earlier-start', kind: 'started', agentThreadId: known.id, agentPath: '/root/from-prior-turn',
        } }] };
      }
      if (method === 'thread/items/list' && followedUp && params.threadId === thread.id && params.turnId === turn.id) {
        return { data: [{ item: {
          type: 'collabAgentToolCall', id: 'new-dispatch', status: 'completed', tool: 'followupTask',
          senderThreadId: thread.id, receiverThreadIds: [known.id],
          prompt: '检查新任务恢复', model: null, reasoningEffort: null, agentsStates: {},
        } }] };
      }
      return { data: [] };
    },
  };
  const render = async parent => renderActivity(await readActivity(client, { threadId: parent.id }), { embedded: true });
  const [first, second] = await Promise.all([render(thread), render(other)]);
  assert.match(first, /◐ from-prior-turn.*任务 检查旧版会话恢复/u);
  assert.doesNotMatch(first, /reported-active|unloaded-without-evidence/u);
  assert.match(second, /◐ reported-active/u);
  assert.doesNotMatch(second, /from-prior-turn|unloaded-without-evidence|检查旧版会话恢复/u);
  assert.deepEqual(reads, new Set([thread.id, other.id]));
  followedUp = true;
  const fresh = renderActivity(await readActivity({ ...client }, { threadId: thread.id }), { embedded: true });
  assert.match(fresh, /◐ from-prior-turn.*任务 检查新任务恢复/u);
  assert.doesNotMatch(fresh, /检查旧版会话恢复/u);
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
  const finalSnapshot = await readActivity(client, { threadId: thread.id });
  const pageTwoAgent = finalSnapshot.agents.find(agent => agent.id === child.id);
  assert.equal(pageTwoAgent?.status, 'completed');
  assert.equal(pageTwoAgent?.startedAtMs, (now - 20) * 1000);
  assert.equal(pageTwoAgent?.completedAtMs, (now + 12) * 1000);
  assert.doesNotMatch(renderActivity(finalSnapshot, { embedded: true }), /page-two|✓ page-two/u);
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
  const read = () => readActivity(client, { threadId: thread.id });
  const render = snapshot => renderActivity(snapshot, { embedded: true });
  const firstSnapshot = await read();
  const firstFast = firstSnapshot.agents.find(agent => agent.id === child.id);
  assert.equal(firstFast?.status, 'completed');
  assert.equal(firstFast?.startedAtMs, now * 1000 + 350);
  assert.equal(firstFast?.completedAtMs, now * 1000 + 350);
  assert.doesNotMatch(render(firstSnapshot), /fast|✓ fast/u);
  start = { id: 'parent-next-start', ms: now * 1000 + 850 };
  t.mock.timers.tick(5001);
  assert.match(render(await read()), /◐ fast/u);
  childTurn = { id: 'next-run', status: 'completed', startedAt: now, completedAt: now + 1 };
  t.mock.timers.tick(5001);
  const thirdSnapshot = await read();
  const thirdFast = thirdSnapshot.agents.find(agent => agent.id === child.id);
  assert.equal(thirdFast?.status, 'completed');
  assert.equal(thirdFast?.completedAtMs, (now + 1) * 1000);
  assert.doesNotMatch(render(thirdSnapshot), /fast|✓ fast/u);
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
    const read = () => readActivity(client, { threadId: thread.id });
    const frame = async () => renderActivity(await read(), { embedded: true });
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
    const doneSnapshot = await read();
    const doneAgent = doneSnapshot.agents.find(agent => agent.id === child.id);
    assert.equal(doneAgent?.status, 'completed');
    assert.ok(doneAgent.completedAtMs >= doneAgent.startedAtMs && doneAgent.completedAtMs - doneAgent.startedAtMs < 1000);
    assert.doesNotMatch(renderActivity(doneSnapshot, { embedded: true }), /reused|✓ reused/u);
    t.mock.timers.tick(5001);
    const settledSnapshot = await read();
    assert.equal(settledSnapshot.agents.find(agent => agent.id === child.id)?.status, 'completed');
    assert.doesNotMatch(renderActivity(settledSnapshot, { embedded: true }), /reused|✓ reused/u);
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
  const coldSnapshot = await readActivity(distinctStart, { threadId: thread.id });
  const coldAgent = coldSnapshot.agents.find(agent => agent.id === child.id);
  assert.equal(coldAgent?.status, 'completed');
  assert.ok(coldAgent.completedAtMs >= coldAgent.startedAtMs && coldAgent.completedAtMs - coldAgent.startedAtMs < 1000);
  assert.doesNotMatch(renderActivity(coldSnapshot, { embedded: true }), /resumed|✓ resumed/u);
  t.mock.timers.tick(5001);
  const laterSnapshot = await readActivity(distinctStart, { threadId: thread.id });
  assert.equal(laterSnapshot.agents.find(agent => agent.id === child.id)?.status, 'completed');
  assert.doesNotMatch(renderActivity(laterSnapshot, { embedded: true }), /resumed|✓ resumed/u);
  const ambiguousStart = clientFor(second + 20);
  assert.match(await frame(ambiguousStart), /◐ resumed/u);
  assert.doesNotMatch(await frame(ambiguousStart), /✓ resumed/u);
});

test('inactive and evicted (>64) subagents do not re-trigger child RPCs on subsequent polls', async t => {
  const now = 1760007000;
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const totalChildren = 70;
  const allChildren = Array.from({ length: totalChildren }, (_, index) => ({
    id: `done-child-${index}`,
    parentThreadId: thread.id,
    status: { type: 'notLoaded' },
    updatedAt: now - 5,
  }));
  const parentItems = allChildren.flatMap(({ id }, index) => [
    {
      item: { id: `${id}-start`, type: 'subAgentActivity', kind: 'started', agentThreadId: id, agentPath: `/root/${id}` },
      startedAtMs: (now - 30) * 1000 + index,
    },
    {
      item: { id: `${id}-end`, type: 'subAgentActivity', kind: 'completed', agentThreadId: id, agentPath: `/root/${id}` },
      completedAtMs: (now - 10) * 1000 + index,
    },
  ]);
  const childTurnCalls = [];
  const childReadCalls = [];
  const childItemCalls = [];
  const client = {
    async request(method, params) {
      if (method === 'thread/read') {
        if (params.threadId === thread.id) return { thread };
        childReadCalls.push(params.threadId);
        return {};
      }
      if (method === 'thread/list') {
        // Return the earliest finished children (which will be evicted by the >64 cap) on the first roster page.
        return { data: allChildren.slice(0, 16) };
      }
      if (method === 'thread/turns/list') {
        if (params.threadId === thread.id) return { data: [turn] };
        childTurnCalls.push(params.threadId);
        return { data: [{ id: `${params.threadId}-turn`, status: 'completed', startedAt: now - 30, completedAt: now - 10 }] };
      }
      if (method === 'thread/items/list') {
        if (params.threadId === thread.id) return { data: parentItems.toReversed() };
        childItemCalls.push(params.threadId);
        return { data: [] };
      }
      return { data: [] };
    },
  };

  const first = await readActivity(client, { threadId: thread.id });
  assert.equal(first.agents.length, 64);
  assert.equal(first.agents.some(agent => agent.id === 'done-child-0'), false);
  assert.deepEqual(childTurnCalls, []);
  assert.deepEqual(childReadCalls, []);
  assert.deepEqual(childItemCalls, []);

  // Poll again after 5s while the evicted children are still within the 60s finishedAgentLifetimeMs window.
  t.mock.timers.tick(5001);
  const second = await readActivity(client, { threadId: thread.id });
  assert.equal(second.agents.length, 64);
  assert.deepEqual(childTurnCalls, []);
  assert.deepEqual(childReadCalls, []);
  assert.deepEqual(childItemCalls, []);
});
