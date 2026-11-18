import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHudMetrics } from './hud-metrics.mjs';

const pageSize = 32;
// shortcut: at most 64 paginated items per poll, use incremental history if full long turns are needed.
const maxPages = 2;
const legacySnapshots = new WeakMap();
const agentHistories = new WeakMap();
const agentRefreshMs = 5000;
const finishedAgentLifetimeMs = 60_000;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const activeAgentStatuses = new Set(['running', 'inProgress', 'pendingInit']);
const agentActivityStatuses = new Map([['started', 'running'], ['completed', 'completed'], ['interrupted', 'interrupted']]);

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

async function recentTurns(client, thread, paginated, cursor) {
  try {
    return await client.request('thread/turns/list', {
      threadId: thread.id, limit: 1, cursor, sortDirection: 'desc', itemsView: paginated ? 'notLoaded' : 'full',
    });
  } catch (error) {
    if (error.code === -32600 && /not materialized yet/.test(error.message)) return { data: [] };
    throw error;
  }
}

async function recentItems(client, threadId, turnId, cursor) {
  const items = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, nextCursor } = await client.request('thread/items/list', {
      threadId, turnId, cursor, limit: pageSize, sortDirection: 'desc',
      deferOutput: { commandExecution: true, mcpToolCall: true },
    });
    items.push(...data.map(({ item, startedAtMs, completedAtMs }) => ({
      ...item,
      startedAtMs: item?.startedAtMs ?? startedAtMs,
      completedAtMs: item?.completedAtMs ?? completedAtMs,
    })));
    if (cursor === nextCursor) break;
    cursor = nextCursor;
    if (!cursor) break;
  }
  return { items: items.reverse(), nextCursor: cursor };
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

function mergeAgent(agents, next) {
  const previous = agents.get(next.id) ?? {};
  if (next.observedAtMs < previous.observedAtMs || (next.parentEvent && next.parentEvent === previous.parentEvent)) return;
  const lastRun = previous.run ?? {};
  const sameStart = next.startEventId && next.startEventId === lastRun.startEventId;
  const newStart = next.startEventId && lastRun.startEventId && !sameStart;
  const status = sameStart ? previous.status : next.status || previous.status;
  const active = activeAgentStatuses.has(status);
  const restarted = active && (newStart || !activeAgentStatuses.has(previous.status));
  const run = restarted ? {
    hasPredecessor: Boolean(previous.id),
    precedingStartAtMs: lastRun.parentStartedAtMs ?? previous.startedAtMs,
    precedingEndAtMs: previous.completedAtMs,
    precedingChild: lastRun.child,
  } : { ...lastRun };
  if (next.startEventId) {
    run.startEventId = next.startEventId;
    run.parentStartedAtMs = next.startedAtMs ?? run.parentStartedAtMs;
  }
  if (next.child) run.child = next.child;
  if (next.precedingChild && (!run.precedingChild || next.precedingChild.id === run.precedingChild.id)) {
    run.precedingChild = next.precedingChild;
  }
  agents.set(next.id, {
    id: next.id, status,
    name: next.name || previous.name,
    model: next.model || previous.model,
    reasoning: next.reasoning || previous.reasoning,
    startedAtMs: next.startedAtMs ?? (restarted ? undefined : previous.startedAtMs),
    completedAtMs: next.completedAtMs ?? (!restarted && status === previous.status ? previous.completedAtMs : undefined),
    observedAtMs: next.observedAtMs ?? previous.observedAtMs,
    parentEvent: next.parentEvent ?? previous.parentEvent,
    run,
  });
}

function agentEvent(id, status, item = {}) {
  if (typeof id !== 'string' || !id || !status) return;
  const startedAtMs = item.kind === 'started' ? item.startedAtMs ?? item.completedAtMs : undefined;
  const observedAtMs = startedAtMs ?? item.completedAtMs ?? item.startedAtMs;
  return {
    id, status, observedAtMs,
    parentEvent: JSON.stringify([item.id, status, observedAtMs]),
    startEventId: item.kind === 'started' ? item.id : undefined,
    name: field(item.agentPath).split(/[\\/]/u).at(-1),
    model: field(item.model), reasoning: field(item.reasoningEffort),
    startedAtMs,
    completedAtMs: item.kind === 'completed' || item.kind === 'interrupted' ? observedAtMs : undefined,
  };
}

function summarize(items) {
  const tools = new Map();
  const agentEvents = [];
  const skills = new Set();
  const seen = new Set();
  let plan = false;
  let compactions = 0;

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
    if (item.type === 'contextCompaction') compactions++;
    if (item.type === 'subAgentActivity') {
      const event = agentEvent(item.agentThreadId, agentActivityStatuses.get(item.kind), item);
      if (event) agentEvents.push(event);
    }
    if (item.type === 'collabAgentToolCall') {
      for (const [id, agent] of Object.entries(item.agentsStates ?? {})) {
        const event = agentEvent(id, field(agent?.status), { id: item.id, completedAtMs: item.completedAtMs, startedAtMs: item.startedAtMs });
        if (event) agentEvents.push(event);
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

  return { tools: [...tools.values()], agentEvents, skills: [...skills], plan, compactions };
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

  const { data: [turn], nextCursor: turnCursor } = await recentTurns(client, thread, paginated);
  const { items, nextCursor } = turn && paginated
    ? await recentItems(client, thread.id, turn.id)
    : { items: turn?.items ?? [] };
  const activity = { turn: field(turn?.status), turnId: turn?.id, nextCursor, turnCursor,
    windowSize: nextCursor ? items.length : undefined, ...summarize(items) };
  if (key) legacySnapshots.set(client, { key, activity });
  return activity;
}

function rememberParent(client, threadId) {
  let parents = agentHistories.get(client);
  if (!parents) agentHistories.set(client, parents = new Map());
  const parent = parents.get(threadId) ?? {
    agents: new Map(), seenAgentEvents: new Set(), unresolvedChildren: new Map(), pollAt: 0, revision: 0, appliedRevision: 0,
  };
  parents.delete(threadId);
  parents.set(threadId, parent);
  if (parents.size > 8) parents.delete(parents.keys().next().value);
  return parent;
}

function applyAgentEvents(parent, events) {
  for (const event of events) {
    const key = `${event.id}\0${event.parentEvent}`;
    if (parent.seenAgentEvents.has(key)) continue;
    parent.seenAgentEvents.add(key);
    mergeAgent(parent.agents, event);
  }
  while (parent.seenAgentEvents.size > 1024) parent.seenAgentEvents.delete(parent.seenAgentEvents.values().next().value);
}

async function recoverParentAgents(client, thread, { turnId, nextCursor, turnCursor }, parent, missing) {
  if (!missing.length) return;
  if (!parent.recovery || missing.some(child => !parent.recovery.childIds.has(child.id))) {
    parent.recovery = {
      childIds: new Set(missing.map(child => child.id)), turnCursor,
      itemsTurn: nextCursor ? { id: turnId, cursor: nextCursor } : undefined,
    };
  }
  const scan = parent.recovery;
  const paginated = thread.historyMode === 'paginated';
  // Walk backward from the current parent history, keeping the cursor across refreshes.
  for (let batch = 0; batch < 2 && (scan.itemsTurn || scan.turnCursor); batch++) {
    const candidates = missing.filter(child => !parent.agents.has(child.id));
    if (!candidates.length) return;
    const ids = new Set(candidates.map(child => child.id));
    if (!scan.itemsTurn) {
      const { data: [turn], nextCursor: olderCursor } = await recentTurns(client, thread, paginated, scan.turnCursor);
      scan.turnCursor = olderCursor === scan.turnCursor ? undefined : olderCursor;
      const earliest = Math.min(...candidates.map(child => child.createdAt ?? -Infinity));
      if (!turn || (Number.isFinite(turn.completedAt) && turn.completedAt < earliest)) {
        scan.turnCursor = undefined;
        return;
      }
      scan.itemsTurn = { id: turn.id, items: turn.items };
    }
    const { id, cursor, items: legacyItems } = scan.itemsTurn;
    const history = paginated ? await recentItems(client, thread.id, id, cursor) : { items: legacyItems ?? [] };
    scan.itemsTurn = history.nextCursor && history.nextCursor !== cursor ? { id, cursor: history.nextCursor } : undefined;
    applyAgentEvents(parent, summarize(history.items).agentEvents.filter(event => ids.has(event.id) && !parent.agents.has(event.id)));
  }
}

function reconcileChildTurn(agents, observed, metadata, status, turn) {
  const { run = {} } = observed ?? {};
  const startedAtMs = Number.isFinite(turn?.startedAt) ? turn.startedAt * 1000 : undefined;
  const completedAtMs = Number.isFinite(turn?.completedAt) ? turn.completedAt * 1000 : undefined;
  const turnId = turn?.id;
  const child = turnId ? { id: turnId, finished: completedAtMs !== undefined } : undefined;
  const associated = Boolean(child && turnId === run.child?.id);
  const isPrecedingChild = child && turnId === run.precedingChild?.id;

  // An app-server turn's timestamps describe a whole second. Use the parent's precise run boundaries.
  const beforeStart = startedAtMs + 999 < run.parentStartedAtMs || completedAtMs + 999 < run.parentStartedAtMs;
  if (!associated && (isPrecedingChild || beforeStart)) {
    if (child && (!run.precedingChild || child.finished)) mergeAgent(agents, { ...metadata, precedingChild: child });
    return;
  }
  const matchesNewStart = startedAtMs > run.parentStartedAtMs ||
    (startedAtMs <= run.parentStartedAtMs && startedAtMs > run.precedingStartAtMs);
  const belongsToRun = associated || (!run.child && (!run.hasPredecessor ||
    (child && run.precedingChild?.finished) || matchesNewStart || startedAtMs > run.precedingEndAtMs ||
    (startedAtMs !== undefined && completedAtMs > run.precedingEndAtMs)));
  if (!belongsToRun) return;

  if (turn?.status === 'inProgress' || status === 'active') {
    if (associated && Number.isFinite(observed?.completedAtMs)) return;
    mergeAgent(agents, { ...metadata, status: 'running', startedAtMs: observed?.startedAtMs ?? startedAtMs,
      child: turn?.status === 'inProgress' ? child : undefined });
  } else if (completedAtMs !== undefined) {
    if (completedAtMs + 999 < observed?.observedAtMs) return;
    const finished = Math.max(completedAtMs, observed?.observedAtMs ?? completedAtMs);
    mergeAgent(agents, { ...metadata, status: turn.status, observedAtMs: finished, completedAtMs: finished,
      startedAtMs: observed?.startedAtMs ?? startedAtMs, child });
  } else if (observed) {
    // A separate app-server may replay an unloaded running turn as interrupted without an end time.
    // The matching ID identifies the turn for this run but that replay does not settle its status.
    const idle = !run.startEventId && (status === 'idle' || status === 'systemError');
    mergeAgent(agents, { ...metadata, status: idle ? 'idle' : undefined, child: startedAtMs === undefined ? undefined : child });
  }
}

async function refreshAgents(client, thread, activity, parent) {
  const { agents, unresolvedChildren, childCursor } = parent;
  const { data, nextCursor } = await client.request('thread/list', {
    parentThreadId: thread.id, currentAccountOnly: true, useStateDbOnly: true,
    sortKey: 'updated_at', limit: 16, cursor: childCursor, sourceKinds: ['subAgentThreadSpawn'],
  }).catch(error => {
    parent.childCursor = undefined;
    throw error;
  });
  parent.childCursor = nextCursor === childCursor ? undefined : nextCursor || undefined;
  const isChild = child => child?.parentThreadId === thread.id && typeof child.id === 'string' && child.id !== thread.id;
  const children = new Map(data.filter(isChild).map(child => [child.id, child]));
  for (const child of children.values()) {
    if (!agents.has(child.id) && child.status?.type === 'notLoaded') {
      unresolvedChildren.set(child.id, { id: child.id, createdAt: child.createdAt });
    } else unresolvedChildren.delete(child.id);
  }
  await recoverParentAgents(client, thread, activity, parent, [...unresolvedChildren.values()]).catch(() => {});

  // Recheck the displayed running agents even when their roster page is elsewhere.
  const visible = shownAgents([...agents.values()], Date.now(), false)
    .filter(agent => activeAgentStatuses.has(agent.status) && !children.has(agent.id));
  await Promise.all(visible.map(async ({ id }) => {
    const { thread: child } = await client.request('thread/read', { threadId: id, includeTurns: false }).catch(() => ({}));
    if (child?.id === id && isChild(child)) children.set(id, child);
  }));

  await Promise.all([...children.values()].map(async child => {
    const status = child.status?.type;
    const observed = agents.get(child.id);
    const unreconciled = !observed && Date.now() - child.updatedAt * 1000 <= finishedAgentLifetimeMs;
    if (status !== 'active' && !activeAgentStatuses.has(observed?.status) && !unreconciled) return;
    const { data: [turn] } = await recentTurns(client, child, true).catch(() => ({ data: [] }));
    if (agents.get(child.id) !== observed) return;
    const metadata = {
      id: child.id,
      name: observed?.name || field(child.agentNickname) || field(child.agentRole),
      model: observed?.model || field(child.model),
      reasoning: observed?.reasoning || field(child.reasoningEffort),
    };
    reconcileChildTurn(agents, observed, metadata, status, turn);
  }));
  for (const id of unresolvedChildren.keys()) if (agents.has(id)) unresolvedChildren.delete(id);
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
  const parent = rememberParent(client, thread.id);
  const revision = ++parent.revision;
  try {
    const [{ agentEvents, turnId, nextCursor, turnCursor, ...activity }, hud] = await Promise.all([readTurn(client, thread), metrics]);
    if (revision > parent.appliedRevision) {
      parent.appliedRevision = revision;
      applyAgentEvents(parent, agentEvents);
      if (!parent.pending && Date.now() >= parent.pollAt) {
        parent.pollAt = Date.now() + agentRefreshMs;
        parent.pending = refreshAgents(client, thread, { turnId, nextCursor, turnCursor }, parent)
          .catch(() => {}).finally(() => { parent.pending = undefined; });
      }
    }
    await parent.pending;
    if (parent.agents.size > 64) {
      for (const [id, agent] of parent.agents) {
        if (!activeAgentStatuses.has(agent.status)) parent.agents.delete(id);
        if (parent.agents.size <= 64) break;
      }
    }
    while (parent.agents.size > 64) parent.agents.delete(parent.agents.keys().next().value);
    return {
      workspace: field(threadWorkspace),
      id: field(thread.id),
      model: field(thread.model),
      reasoning: field(thread.reasoningEffort),
      branch: field(thread.gitInfo?.branch),
      cliVersion,
      createdAt: thread.createdAt,
      ...activity,
      agents: [...parent.agents.values()].map(({ parentEvent, observedAtMs, run, ...agent }) => (
        { ...agent, id: field(agent.id) }
      )),
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
    memory: { used: 10.3 * 1024 ** 3, total: 22.5 * 1024 ** 3 }, environment: { agentsMd: 2, mcps: 6, hooks: 1 },
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
const labelTone = 2;
const effortSymbols = new Map([
  ['minimal', '·'], ['low', '○'], ['medium', '◔'], ['high', '◑'], ['xhigh', '◕'], ['max', '●'],
]);
const contextTone = percent => percent >= 85 ? 31 : percent >= 70 ? 33 : 32;
const usageTone = percent => percent >= 90 ? 31 : percent >= 75 ? 95 : 94;
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
  const effort = field(reasoning);
  return [field(model), effortSymbols.get(effort.toLowerCase()), effort].filter(Boolean).join(' ');
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

function formatMemory(bytes) {
  const gibibytes = bytes / 1024 ** 3;
  return gibibytes >= 1 ? `${gibibytes.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function activityCells(tools) {
  const ordered = tools.toSorted((first, second) => (second.running ?? 0) - (first.running ?? 0));
  const cells = ordered.slice(0, 4).flatMap(({ name, running, done, failed }) => [
    [running, '◐', 33], [done, '✓', 32], [failed, '✗', 31],
  ].filter(([count]) => count > 0).map(([count, icon, tone]) => [
    [`${icon} `, tone], [field(name)], [count > 1 ? ` ×${count}` : '', labelTone],
  ]));
  if (tools.length > 4) cells.push([[`+${tools.length - 4} 类`, labelTone]]);
  return cells;
}

function mcpCells(tools) {
  const servers = new Map();
  for (const { server, running, done, failed } of tools) {
    const name = field(server);
    if (!name || !(running > 0 || done > 0 || failed > 0)) continue;
    const status = failed > 0 ? 2 : running > 0 ? 1 : 0;
    servers.set(name, Math.max(servers.get(name) ?? 0, status));
  }
  const ordered = [...servers].toSorted((a, b) => b[1] - a[1]);
  const cells = ordered.slice(0, 6).map(([name, status]) => {
    const [icon, tone] = [['✓', 32], ['◐', 33], ['✗', 31]][status];
    return [[`${icon} `, tone], [name, status === 2 ? 31 : labelTone]];
  });
  if (cells.length) cells[0].unshift([`MCPs (${servers.size}) `, labelTone]);
  if (servers.size > 6) cells.push([[`+${servers.size - 6} 个`, labelTone]]);
  return cells;
}

function shownAgents(agents, nowMs, allowUndated) {
  const active = agents.toReversed().filter(agent => activeAgentStatuses.has(agent.status))
    .toSorted((a, b) => Number(a.status === 'pendingInit') - Number(b.status === 'pendingInit')).slice(0, 3);
  const recent = agents.filter(({ status, completedAtMs }) => (
    !activeAgentStatuses.has(status) && statusLabels.has(status)
    && (Number.isFinite(completedAtMs)
      ? completedAtMs <= nowMs && nowMs - completedAtMs <= finishedAgentLifetimeMs
      : allowUndated)
  )).toSorted((a, b) => (b.completedAtMs ?? 0) - (a.completedAtMs ?? 0));
  return [...active, ...recent.slice(0, Math.min(2, 3 - active.length))];
}

export function renderActivity(snapshot, { color = false, width, height, embedded = false, now = Date.now() / 1000 } = {}) {
  const lines = [];
  const columns = Number.isFinite(width) && width >= 1 ? Math.floor(width) : Infinity;
  function paint(text, tone, href) {
    if (!color || !text) return text;
    const colored = tone ? `\u001b[${tone}m${text}\u001b[0m` : text;
    return href ? `\u001b]8;;${href}\u001b\\${colored}\u001b]8;;\u001b\\` : colored;
  }
  const ellipsis = columns >= textWidth('…') ? '…' : '.';
  const separatorWidth = textWidth(separator);

  function drawCell(parts, size) {
    if (size <= columns) return parts.map(([text, tone, href]) => paint(text, tone, href)).join('');
    let remaining = columns - textWidth(ellipsis);
    let cell = '';
    for (const [text, tone, href] of parts) {
      for (const { segment, index } of graphemes.segment(text)) {
        remaining -= cellWidth(segment);
        if (remaining < 0) return cell + paint(text.slice(0, index), tone, href) + paint(ellipsis, labelTone);
      }
      cell += paint(text, tone, href);
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
        line += separator;
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
      row([[`… 另有 ${hidden} 行`, labelTone]]);
    }
    return lines.join('\n');
  }

  function meter(label, percent, tone, detail = '') {
    const value = `${Math.round(percent)}%`;
    const suffix = textWidth(`${label} ${value}${detail}`) <= columns ? detail : '';
    const barSpace = columns - textWidth(`${label}  ${value}${suffix}`);
    const length = Math.max(0, Math.min(10, Math.floor(barSpace / textWidth('█'))));
    const filled = Math.round(percent * length / 100);
    return [[`${label} `, labelTone], ['█'.repeat(filled), tone], ['░'.repeat(length - filled), `${tone};2`],
      [`${length ? ' ' : ''}${value}`, contextTone(percent)], [suffix, labelTone]];
  }

  function quota(label, limit) {
    const remaining = limit?.remainingPercent;
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) return [];
    const reset = Number.isFinite(limit.resetsAt) && limit.resetsAt > now
      ? ` (${duration(Math.ceil((limit.resetsAt - now) / 60) * 60)})` : '';
    const prefix = `${label} 剩余 `;
    const value = `${Math.round(remaining)}%`;
    return [[prefix, labelTone], [value, usageTone(100 - remaining)], [textWidth(prefix + value + reset) <= columns ? reset : '', labelTone]];
  }

  const workspace = field(snapshot.workspace);
  const project = basename(workspace) || workspace;
  const version = field(snapshot.cliVersion);
  if (snapshot.id || embedded) {
    const model = modelLabel(snapshot);
    const branch = field(snapshot.branch);
    const age = Number.isFinite(snapshot.createdAt) && snapshot.createdAt > 0 && now >= snapshot.createdAt
      ? `⏱ ${duration(now - snapshot.createdAt)}` : '';
    const cost = Number.isFinite(snapshot.estimatedCostUsd) && snapshot.estimatedCostUsd >= 0
      ? `费用 $${snapshot.estimatedCostUsd.toFixed(2)}` : '';
    const url = color && !snapshot.preview && workspace === snapshot.workspace && isAbsolute(workspace)
      ? pathToFileURL(workspace) : undefined;
    const projectParts = [[project, 33, url?.host === '' ? url.href : undefined]];
    if (branch) projectParts.push([' git:(', 35], [branch, 36], [')', 35]);
    row([[model && `[${model}]`, 36]], projectParts,
      [[version && `Codex v${version}`, labelTone]], [[age, labelTone]], [[cost, labelTone]], [[snapshot.preview ? '示例' : '', labelTone]]);
  } else {
    row([['Codex Hub ', 36], [`${project} 没有已记录的会话。`]], [[version && `Codex v${version}`, labelTone]]);
  }

  const { contextPercent, limits, memory, environment, tokens } = snapshot;
  const hasContext = Number.isFinite(contextPercent) && contextPercent >= 0 && contextPercent <= 100;
  row(hasContext ? meter('上下文', contextPercent, contextTone(contextPercent)) : [],
    quota('5h', limits?.fiveHour), quota('7d', limits?.weekly));
  if (Number.isFinite(memory?.used) && Number.isFinite(memory.total) && memory.total > 0 && memory.used >= 0 && memory.used <= memory.total) {
    const percent = memory.used * 100 / memory.total;
    const detail = ` (${formatMemory(memory.used)} / ${formatMemory(memory.total)})`;
    row(meter(hasContext ? '内存  ' : '内存', percent, usageTone(percent), detail));
  }
  row(...[[environment?.agentsMd, 'AGENTS.md'], [environment?.mcps, 'MCPs'], [environment?.hooks, '钩子'], [environment?.agents, 'Agents']]
    .filter(([count]) => Number.isSafeInteger(count) && count > 0).map(([count, label]) => [[`${count} ${label}`, labelTone]]));
  if (!snapshot.id && !embedded) return frame();

  const turnStatus = statusLabels.get(snapshot.turn);
  if (!embedded && turnStatus && snapshot.turn !== 'completed') row([[`最近回合 ${turnStatus}`, labelTone]]);
  const scope = snapshot.windowSize === undefined ? '最近回合' : '此范围';
  if (!embedded && snapshot.windowSize !== undefined) row([[`范围 最近 ${snapshot.windowSize} 项`, labelTone]]);
  const toolActivity = snapshot.tools ?? [];
  const tools = toolActivity.filter(tool => !tool.server);
  row(...activityCells(tools));
  const skills = snapshot.skills ?? [];
  if (skills.length) {
    const names = skills.slice(0, 4).map(field);
    if (skills.length > 4) names.push(`+${skills.length - 4} 项`);
    row([[`▸ Skills (${skills.length}) 已选 `, labelTone], [names.join(', ')]]);
  }
  row(...mcpCells(toolActivity));
  const nowMs = now * 1000;
  const agents = shownAgents(snapshot.agents ?? [], nowMs, !embedded);
  for (const agent of agents) {
    const active = activeAgentStatuses.has(agent.status);
    const [icon, tone] = active ? ['◐', 33] : agent.status === 'completed' ? ['✓', 32] : ['✗', 31];
    const endedAt = active ? nowMs : agent.completedAtMs;
    const elapsed = endedAt - agent.startedAtMs;
    const name = field(agent.name) || `子代理 ${field(agent.id?.slice(-8))}`;
    row([[`${icon} `, tone], [name, 36]],
      [[modelLabel(agent)]], [[statusLabels.get(agent.status), labelTone]],
      [[Number.isFinite(elapsed) && elapsed >= 0 ? (elapsed >= 1000 ? duration(elapsed / 1000) : '<1s') : '', labelTone]]);
  }

  const { completed, total, current } = snapshot.taskProgress ?? {};
  const hasProgress = Number.isSafeInteger(completed) && Number.isSafeInteger(total)
    && completed >= 0 && total > 0 && completed <= total;
  if (hasProgress) {
    const finished = completed === total;
    const label = finished ? '任务全部完成' : field(current) || '任务进度';
    row([[finished ? '✓ ' : '▸ ', finished ? 32 : 33], [label], [` (${completed}/${total})`, labelTone]]);
  } else if (!embedded && snapshot.plan) row([[`▸ 计划 ${scope}有已保存计划`, labelTone]]);
  if (!embedded && !toolActivity.length && !agents.length && !skills.length && !snapshot.plan && !hasProgress && !snapshot.compactions) {
    row([[`${scope}暂无已记录活动`, labelTone]]);
  }

  const tokenCounts = [[tokens?.input, '输入'], [tokens?.output, '输出'], [tokens?.cached, '缓存']];
  const hasTokenTotal = Number.isFinite(tokens?.total) && tokens.total > 0;
  if (hasTokenTotal || tokenCounts.some(([count]) => Number.isFinite(count) && count > 0)) {
    const counts = tokenCounts.filter(([count, label]) => Number.isFinite(count) && (label === '缓存' ? count > 0 : count >= 0))
      .map(([count, label]) => `${label} ${compactCount(count)}`);
    const totalLabel = hasTokenTotal ? ` ${compactCount(tokens.total)}` : '';
    if (textWidth(`词元${totalLabel} (${counts.join(', ')})`) <= columns) {
      row([[`词元${totalLabel}`, labelTone], [counts.length ? ` (${counts.join(', ')})` : '']]);
    } else {
      row([[`词元${totalLabel}`, labelTone]], ...counts.map(count => [[count]]));
    }
  }
  if (snapshot.compactions > 0) {
    const observed = snapshot.windowSize === undefined ? '最近回合' : `最近 ${snapshot.windowSize} 项`;
    row([[`${observed}压缩 ${snapshot.compactions} 次`, labelTone]]);
  }
  return frame();
}
