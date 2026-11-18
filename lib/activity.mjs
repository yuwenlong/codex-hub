import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const pageSize = 32;
// shortcut: at most 64 paginated items per poll, use incremental history if full long turns are needed.
const maxPages = 2;
const legacySnapshots = new WeakMap();
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function field(value) {
  return typeof value === 'string' ? value.slice(0, 300).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim() : '';
}

function pathKey(value) {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function findThread(client, cwd, threadId) {
  if (threadId) {
    const result = await client.request('thread/read', { threadId, includeTurns: false });
    if (result.thread?.id !== threadId) throw new Error('缺少指定会话。');
    return result.thread;
  }

  const canonical = await realpath(cwd).catch(() => cwd);
  const paths = [...new Set([cwd, canonical])];
  const keys = new Set(paths.map(pathKey));
  const { data } = await client.request('thread/list', {
    cwd: paths.length === 1 ? cwd : paths,
    currentAccountOnly: true,
    limit: 10,
    modelProviders: [],
    sortKey: 'updated_at',
    sourceKinds: ['cli', 'exec', 'appServer', 'vscode'],
    useStateDbOnly: true,
  });
  return data.find(thread => typeof thread?.cwd === 'string' && keys.has(pathKey(thread.cwd)) &&
    typeof thread.id === 'string' && !thread.parentThreadId && !thread.source?.subAgent);
}

async function latestTurn(client, thread, paginated) {
  try {
    const { data } = await client.request('thread/turns/list', {
      threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: paginated ? 'notLoaded' : 'full',
    });
    return data[0];
  } catch (error) {
    if (error.code === -32600 && /not materialized yet/.test(error.message)) return undefined;
    throw error;
  }
}

async function recentItems(client, threadId, turnId) {
  const items = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const { data, nextCursor } = await client.request('thread/items/list', {
      threadId, turnId, cursor, limit: pageSize, sortDirection: 'desc',
      deferOutput: { commandExecution: true, mcpToolCall: true },
    });
    items.push(...data.map(entry => entry.item));
    if (cursor === nextCursor) break;
    cursor = nextCursor;
    if (!cursor) break;
  }
  return { items: items.reverse(), windowSize: cursor ? items.length : undefined };
}

function toolName(item) {
  switch (item.type) {
    case 'commandExecution': return 'Shell';
    case 'fileChange': return '文件变更';
    case 'mcpToolCall': return `MCP ${[field(item.server), field(item.tool)].filter(Boolean).join('/')}`.trim();
    case 'dynamicToolCall': return [field(item.namespace), field(item.tool)].filter(Boolean).join('/') || '工具';
    case 'collabAgentToolCall': return '子代理工具';
    case 'webSearch': return '网页搜索';
    case 'imageView': return '查看图片';
    case 'imageGeneration': return '图片生成';
    default: return '';
  }
}

function summarize(items) {
  const tools = new Map();
  const agents = new Map();
  const seen = new Set();
  let plan = false;

  function updateAgent(id, status, details = {}) {
    if (typeof id !== 'string' || !id) return;
    const previous = agents.get(id);
    agents.set(id, {
      name: field(details.agentPath).split('/').at(-1) || previous?.name || `子代理 ${field(id.slice(-8))}`,
      model: field(details.model) || previous?.model,
      reasoning: field(details.reasoningEffort) || previous?.reasoning,
      status: status || previous?.status,
    });
  }

  for (const item of items) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.type === 'plan' && typeof item.text === 'string' && item.text.trim()) plan = true;
    if (item.type === 'subAgentActivity') {
      const statuses = { started: 'running', completed: 'completed', interrupted: 'interrupted' };
      updateAgent(item.agentThreadId, Object.hasOwn(statuses, item.kind) ? statuses[item.kind] : undefined, item);
    }
    if (item.type === 'collabAgentToolCall') {
      for (const [id, agent] of Object.entries(item.agentsStates ?? {})) {
        updateAgent(id, field(agent?.status), item.tool === 'spawnAgent' ? item : undefined);
      }
    }

    const name = toolName(item);
    if (!name) continue;
    const status = item.status ?? (item.type === 'webSearch' || item.type === 'imageView' ? 'completed' : '');
    const counts = tools.get(name) ?? { name, running: 0, done: 0, failed: 0 };
    if (status === 'inProgress') counts.running++;
    else if (status === 'completed') counts.done++;
    else if (['failed', 'declined', 'interrupted'].includes(status)) counts.failed++;
    else continue;
    tools.set(name, counts);
  }

  return { tools: [...tools.values()], agents: [...agents.values()], plan };
}

async function readTurn(client, thread) {
  const paginated = thread.historyMode === 'paginated';
  let key;
  if (!paginated) {
    // Codex replays the full legacy rollout. Reuse its summary until the rollout changes.
    const file = typeof thread.path === 'string' ? await stat(thread.path).catch(() => undefined) : undefined;
    if (file || Number.isFinite(thread.updatedAt)) {
      key = JSON.stringify([thread.id, thread.updatedAt, file?.size, file?.mtimeMs]);
      const cached = legacySnapshots.get(client);
      if (cached?.key === key) return cached.activity;
    }
  }

  const turn = await latestTurn(client, thread, paginated);
  const { items, windowSize } = turn && paginated
    ? await recentItems(client, thread.id, turn.id)
    : { items: turn?.items ?? [] };
  const activity = { turn: field(turn?.status), windowSize, ...summarize(items) };
  if (key) legacySnapshots.set(client, { key, activity });
  return activity;
}

export async function readActivity(client, { cwd = process.cwd(), threadId } = {}) {
  const workspace = resolve(cwd);
  let thread;
  try {
    thread = await findThread(client, workspace, threadId);
  } catch {
    throw new Error(threadId ? '无法读取指定的 Codex 会话。' : '无法读取 Codex 会话列表。');
  }
  if (!thread) return { workspace: field(workspace) };

  try {
    return {
      workspace: field(thread.cwd || workspace),
      id: field(thread.id),
      model: field(thread.model),
      reasoning: field(thread.reasoningEffort),
      branch: field(thread.gitInfo?.branch),
      ...await readTurn(client, thread),
    };
  } catch {
    throw new Error('无法读取 Codex 会话活动。');
  }
}

export function previewActivity() {
  return {
    preview: true, workspace: 'codex-hub', id: 'preview', model: 'gpt-6.2', reasoning: 'high', branch: 'main',
    turn: 'inProgress', tools: [{ name: 'Shell', running: 1, done: 2, failed: 0 }],
    agents: [{ name: 'reviewer', model: 'gpt-6.2', reasoning: 'medium', status: 'running' }], plan: true,
  };
}

function fit(line, width) {
  if (!Number.isFinite(width) || width < 1) return line;
  let used = 0;
  let end = 0;
  for (const { segment, index } of graphemes.segment(line)) {
    const size = segment.codePointAt(0) < 128 ? 1 : 2;
    used += size;
    if (used > width) return `${line.slice(0, end)}.`;
    if (used < width) end = index + segment.length;
  }
  return line;
}

const statusLabels = new Map([
  ['inProgress', '进行中'], ['running', '进行中'], ['completed', '完成'], ['interrupted', '已中断'],
  ['failed', '失败'], ['errored', '失败'], ['pendingInit', '等待启动'], ['shutdown', '已关闭'],
]);

function modelLabel({ model, reasoning }) {
  return model && reasoning ? `${model} (${reasoning})` : model || reasoning;
}

export function renderActivity(snapshot, { color = false, width } = {}) {
  const lines = [];
  function line(label, value) {
    const text = fit(`${label} ${value}`, width);
    const labelEnd = Math.min(label.length, text.length);
    lines.push(color ? `\u001b[36m${text.slice(0, labelEnd)}\u001b[0m${text.slice(labelEnd)}` : text);
  }

  if (!snapshot.id) {
    line('Codex Hub', `${snapshot.workspace} 没有已记录的会话。`);
    return lines.join('\n');
  }

  const project = basename(snapshot.workspace) || snapshot.workspace;
  line(snapshot.preview ? 'Codex Hub 示例' : 'Codex Hub',
    [project, modelLabel(snapshot), snapshot.branch && `git:${snapshot.branch}`].filter(Boolean).join(' | '));
  line('会话', `${snapshot.id}${statusLabels.has(snapshot.turn) ? ` | 最近回合 ${statusLabels.get(snapshot.turn)}` : ''}`);
  const scope = snapshot.windowSize === undefined ? '最近回合' : '此范围';
  if (snapshot.windowSize !== undefined) line('范围', `最近 ${snapshot.windowSize} 项`);
  for (const tool of snapshot.tools.slice(0, 4)) {
    const counts = [tool.running && `${tool.running} 进行中`, tool.done && `${tool.done} 完成`, tool.failed && `${tool.failed} 失败`];
    line('工具', `${tool.name} | ${counts.filter(Boolean).join(' · ')}`);
  }
  if (snapshot.tools.length > 4) line('工具', `另有 ${snapshot.tools.length - 4} 类`);
  for (const agent of snapshot.agents.slice(0, 4)) {
    line('代理', [agent.name, modelLabel(agent), statusLabels.get(agent.status)].filter(Boolean).join(' | '));
  }
  if (snapshot.agents.length > 4) line('代理', `另有 ${snapshot.agents.length - 4} 个`);
  if (snapshot.plan) line('计划', `${scope}有已保存计划`);
  if (!snapshot.tools.length && !snapshot.agents.length && !snapshot.plan) line('活动', `${scope}暂无已记录活动`);
  return lines.join('\n');
}
