import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { readHudMetrics } from './hud-metrics.mjs';

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
    case 'mcpToolCall': return [field(item.server), field(item.tool)].filter(Boolean).join('/');
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
  const skills = new Set();
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
    if (item.type === 'userMessage' && Array.isArray(item.content)) {
      for (const input of item.content) {
        if (input?.type !== 'skill') continue;
        const name = field(input.name);
        if (name) skills.add(name);
      }
      continue;
    }
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
    const server = item.type === 'mcpToolCall' ? field(item.server) : '';
    const key = `${server}\0${name}`;
    const counts = tools.get(key) ?? { name, server, running: 0, done: 0, failed: 0 };
    if (status === 'inProgress') counts.running++;
    else if (status === 'completed') counts.done++;
    else if (['failed', 'declined', 'interrupted'].includes(status)) counts.failed++;
    else continue;
    tools.set(key, counts);
  }

  return { tools: [...tools.values()], agents: [...agents.values()], skills: [...skills], plan };
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

export async function readActivity(client, { cwd = process.cwd(), threadId, home, waitForCost = false } = {}) {
  const workspace = resolve(cwd);
  let thread;
  try {
    if (client) thread = await findThread(client, workspace, threadId);
  } catch {
    throw new Error(threadId ? '无法读取指定的 Codex 会话。' : '无法读取 Codex 会话列表。');
  }

  const threadWorkspace = thread?.cwd || workspace;
  const cliVersion = field(client?.codexVersion) || field(thread?.cliVersion);
  const metrics = readHudMetrics(client, thread, { cwd: threadWorkspace, home, waitForCost });
  if (!thread) return { workspace: field(workspace), cliVersion, ...await metrics };
  try {
    const [activity, hud] = await Promise.all([readTurn(client, thread), metrics]);
    return {
      workspace: field(threadWorkspace),
      id: field(thread.id),
      model: field(thread.model),
      reasoning: field(thread.reasoningEffort),
      branch: field(thread.gitInfo?.branch),
      cliVersion,
      createdAt: thread.createdAt,
      ...activity,
      ...hud,
    };
  } catch {
    throw new Error('无法读取 Codex 会话活动。');
  }
}

export function previewActivity() {
  const now = Math.floor(Date.now() / 1000);
  return {
    preview: true, workspace: 'codex-hub', id: 'preview', model: 'GPT-6.2-Astra', reasoning: 'max', branch: 'main',
    cliVersion: '0.170.0', createdAt: now - 6960, estimatedCostUsd: 34.95, contextPercent: 32,
    limits: {
      fiveHour: { remainingPercent: 53, resetsAt: now + 3240 },
      weekly: { remainingPercent: 39, resetsAt: now + 568800 },
    },
    memory: { used: 10.3e9, total: 22.5e9 }, environment: { agentsMd: 2, mcps: 6, hooks: 1 },
    turn: 'inProgress', tools: [
      { name: 'Shell', done: 20 },
      { name: 'codegraph/search', server: 'codegraph', done: 2 },
      { name: 'chrome-devtools/list_pages', server: 'chrome-devtools', done: 1 },
    ],
    skills: ['superpowers:systematic-debugging', 'ponytail:ponytail'],
    agents: [{ name: 'reviewer', model: 'gpt-6.2', reasoning: 'medium', status: 'running' }], plan: true,
    tokens: { total: 9909000, input: 678000, output: 31000, cached: 9200000 },
  };
}

const statusLabels = new Map([
  ['inProgress', '进行中'], ['running', '进行中'], ['completed', '完成'], ['interrupted', '已中断'],
  ['failed', '失败'], ['errored', '失败'], ['pendingInit', '等待启动'], ['shutdown', '已关闭'],
]);

const separator = ' │ ';
const wide = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Yi}\p{Extended_Pictographic}\p{Regional_Indicator}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;
const cjkLocale = /^(zh|ja|ko)(?:[_.-]|$)/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
const ambiguous = /[×…\u2190-\u27bf]/u;

function cellWidth(segment) {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  return wide.test(segment) || (cjkLocale && ambiguous.test(segment)) ? 2 : 1;
}

function textWidth(text) {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += cellWidth(segment);
  return width;
}

function modelLabel({ model, reasoning }) {
  return [field(model), field(reasoning)].filter(Boolean).join(' ● ');
}

function duration(seconds) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${Math.floor(seconds)}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function compactCount(count) {
  for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (count >= size) return `${Number((count / size).toFixed(1))}${suffix}`;
  }
  return String(count);
}

function activityCells(tools) {
  const ordered = tools.toSorted((first, second) => (second.running ?? 0) - (first.running ?? 0));
  const cells = ordered.slice(0, 4).flatMap(({ name, running, done, failed }) => [
    [running, '◐', 33], [done, '✓', 32], [failed, '✗', 31],
  ].filter(([count]) => count > 0).map(([count, icon, tone]) => [
    [`${icon} `, tone], [field(name)], [count > 1 ? ` ×${count}` : '', 90],
  ]));
  if (tools.length > 4) cells.push([[`+${tools.length - 4} 类`, 90]]);
  return cells;
}

export function renderActivity(snapshot, { color = false, width, height, now = Date.now() / 1000 } = {}) {
  const lines = [];
  const columns = Number.isFinite(width) && width >= 1 ? Math.floor(width) : Infinity;
  const paint = (text, tone) => color && tone && text ? `\u001b[${tone}m${text}\u001b[0m` : text;
  const ellipsis = columns >= textWidth('…') ? '…' : '.';
  const separatorWidth = textWidth(separator);

  function drawCell(parts, size) {
    if (size <= columns) return parts.map(([text, tone]) => paint(text, tone)).join('');
    let remaining = columns - textWidth(ellipsis);
    let cell = '';
    for (const [text, tone] of parts) {
      for (const { segment, index } of graphemes.segment(text)) {
        remaining -= cellWidth(segment);
        if (remaining < 0) return cell + paint(text.slice(0, index), tone) + paint(ellipsis, 90);
      }
      cell += paint(text, tone);
    }
    return cell;
  }

  function row(...cells) {
    let line = '';
    let used = 0;
    for (const parts of cells) {
      const size = parts.reduce((total, [text]) => total + textWidth(text), 0);
      if (!size) continue;
      if (used && used + separatorWidth + size > columns) {
        lines.push(line);
        line = '';
        used = 0;
      }
      if (used) {
        line += paint(separator, 90);
        used += separatorWidth;
      }
      line += drawCell(parts, size);
      used += size;
    }
    if (line) lines.push(line);
  }

  function frame() {
    if (Number.isInteger(height) && height > 0 && lines.length > height) {
      if (height === 1) return lines[0];
      const hidden = lines.length - height + 1;
      lines.length = height - 1;
      row([[`… 另有 ${hidden} 行`, 90]]);
    }
    return lines.join('\n');
  }

  function meter(label, percent, detail = `${Math.round(percent)}%`) {
    const value = textWidth(`${label} ${detail}`) <= columns ? detail : `${Math.round(percent)}%`;
    const length = Math.max(0, Math.min(10, Math.floor((columns - textWidth(`${label}  ${value}`)) / textWidth('█'))));
    const filled = Math.round(Math.max(0, Math.min(100, percent)) * length / 100);
    const tone = percent >= 85 ? 31 : percent >= 70 ? 33 : 32;
    return [[`${label} `, 90], ['█'.repeat(filled), tone], ['░'.repeat(length - filled), 90], [`${length ? ' ' : ''}${value}`]];
  }

  function quota(label, limit) {
    if (!Number.isFinite(limit?.remainingPercent)) return [];
    const used = 100 - limit.remainingPercent;
    const reset = Number.isFinite(limit.resetsAt) && limit.resetsAt > now
      ? ` (${duration(Math.ceil((limit.resetsAt - now) / 60) * 60)})` : '';
    const text = `${label} 剩余 ${Math.round(limit.remainingPercent)}%`;
    return [[text, used >= 90 ? 31 : used >= 75 ? 35 : 94], [textWidth(text + reset) <= columns ? reset : '', 90]];
  }

  const workspace = field(snapshot.workspace);
  const project = basename(workspace) || workspace;
  const version = field(snapshot.cliVersion);
  if (snapshot.id) {
    const model = modelLabel(snapshot);
    const branch = field(snapshot.branch);
    const age = Number.isFinite(snapshot.createdAt) && snapshot.createdAt > 0 && now >= snapshot.createdAt
      ? `⏱ ${duration(now - snapshot.createdAt)}` : '';
    const cost = Number.isFinite(snapshot.estimatedCostUsd) && snapshot.estimatedCostUsd >= 0
      ? `费用 $${snapshot.estimatedCostUsd.toFixed(2)}` : '';
    row([[model && `[${model}]`, 36]], [[project, 33], [branch && ` git:(${branch})`, 35]],
      [[version && `Codex v${version}`, 90]], [[age, 90]], [[cost]], [[snapshot.preview ? '示例' : '', 90]]);
  } else {
    row([['Codex Hub ', 36], [`${project} 没有已记录的会话。`]], [[version && `Codex v${version}`, 90]]);
  }

  const { contextPercent, limits, memory, environment, tokens } = snapshot;
  row(Number.isFinite(contextPercent) ? meter('上下文', contextPercent) : [],
    quota('5h', limits?.fiveHour), quota('7d', limits?.weekly));
  if (Number.isFinite(memory?.used) && Number.isFinite(memory.total) && memory.total > 0) {
    const percent = memory.used * 100 / memory.total;
    const detail = `${(memory.used / 1e9).toFixed(1)} GB / ${(memory.total / 1e9).toFixed(1)} GB (${Math.round(percent)}%)`;
    row(meter(Number.isFinite(contextPercent) ? '内存  ' : '内存', percent, detail));
  }
  row(...[[environment?.agentsMd, 'AGENTS.md'], [environment?.mcps, 'MCPs'], [environment?.hooks, '钩子']]
    .filter(([count]) => count > 0).map(([count, label]) => [[`${count} ${label}`, 90]]));
  if (!snapshot.id) return frame();

  const turnStatus = statusLabels.get(snapshot.turn);
  if (turnStatus && snapshot.turn !== 'completed') row([[`最近回合 ${turnStatus}`, 90]]);
  const scope = snapshot.windowSize === undefined ? '最近回合' : '此范围';
  if (snapshot.windowSize !== undefined) row([[`范围 最近 ${snapshot.windowSize} 项`, 90]]);
  const tools = snapshot.tools.filter(tool => !tool.server);
  row(...activityCells(tools));
  const skills = snapshot.skills ?? [];
  if (skills.length) {
    const names = skills.slice(0, 4).map(field);
    if (skills.length > 4) names.push(`+${skills.length - 4} 项`);
    row([[`▸ Skills (${skills.length}) 已选 `, 90], [names.join(', ')]]);
  }
  const mcpTools = snapshot.tools.filter(tool => tool.server);
  if (mcpTools.length) {
    const count = new Set(mcpTools.map(tool => tool.server)).size;
    const cells = activityCells(mcpTools);
    cells[0].unshift([`MCPs (${count}) `, 90]);
    row(...cells);
  }
  for (const agent of snapshot.agents.slice(0, 4)) {
    const active = agent.status === 'running' || agent.status === 'inProgress';
    const icon = active ? '◐' : agent.status === 'completed' ? '✓' : '▸';
    row([[`${icon} ${field(agent.name)}`, active ? 33 : 36]],
      [[modelLabel(agent)]], [[statusLabels.get(agent.status) ?? '', 90]]);
  }
  if (snapshot.agents.length > 4) row([[`+${snapshot.agents.length - 4} 个代理`, 90]]);
  if (snapshot.plan) row([[`▸ 计划 ${scope}有已保存计划`, 90]]);
  if (!snapshot.tools.length && !snapshot.agents.length && !skills.length && !snapshot.plan) {
    row([[`${scope}暂无已记录活动`, 90]]);
  }

  const counts = [[tokens?.input, '输入'], [tokens?.output, '输出'], [tokens?.cached, '缓存']]
    .filter(([count]) => Number.isFinite(count)).map(([count, label]) => `${label} ${compactCount(count)}`);
  if (Number.isFinite(tokens?.total) || counts.length) {
    const total = Number.isFinite(tokens?.total) ? ` ${compactCount(tokens.total)}` : '';
    if (textWidth(`词元${total} (${counts.join(', ')})`) <= columns) {
      row([[`词元${total}`, 90], [counts.length ? ` (${counts.join(', ')})` : '']]);
    } else {
      row([[`词元${total}`, 90]], ...counts.map(count => [[count]]));
    }
  }
  return frame();
}
