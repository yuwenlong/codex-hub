import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const rolloutTailBytes = 512 * 1024;
const rolloutHeaderBytes = 256 * 1024;
const configRefreshMs = 30_000;
const costRefreshMs = 60_000;
const optionalRequestTimeout = { timeoutMs: 1500 };
const rollouts = new WeakMap();
const environments = new WeakMap();
const costs = new WeakMap();
const enterprisePlans = new Set(['enterprise', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based']);
const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const exists = path => stat(path).catch(() => null);
const validNumber = value => Number.isFinite(value) && value >= 0;

function json(line) {
  try { return JSON.parse(line); } catch { return null; }
}

async function readFragment(file, length, position = 0) {
  const { buffer, bytesRead } = await file.read({
    buffer: Buffer.alloc(length), length, position,
  });
  return buffer.subarray(0, bytesRead);
}

function tokenMetrics(info) {
  const metrics = {};
  const last = info.last_token_usage?.total_tokens;
  const window = info.model_context_window;
  if (validNumber(last) && validNumber(window) && window > 0) {
    // shortcut: mirror the native 12,000-token reserve until Codex exposes its display percentage.
    const usable = window - 12_000;
    const remaining = usable > 0 ? 100 * (window - last) / usable : 0;
    metrics.contextPercent = 100 - Math.round(Math.max(0, Math.min(100, remaining)));
  }

  const usage = info.total_token_usage;
  const input = usage?.input_tokens;
  const cached = usage?.cached_input_tokens;
  const tokens = Object.fromEntries(Object.entries({
    total: usage?.total_tokens,
    input: !validNumber(cached) || !validNumber(input) ? input : Math.max(0, input - cached),
    output: usage?.output_tokens,
    cached,
  }).filter(([, value]) => validNumber(value)));
  if (Object.keys(tokens).length) metrics.tokens = tokens;
  return metrics;
}

function quotaWindows(snapshot) {
  const windows = {};
  for (const window of [snapshot.primary, snapshot.secondary]) {
    const duration = window?.window_minutes ?? window?.window_duration_mins;
    const label = duration === 300 ? 'fiveHour' : duration === 10_080 ? 'weekly' : null;
    if (!label || !validNumber(window.used_percent) || window.used_percent > 100) continue;
    const resetsAt = validNumber(window.resets_at) ? window.resets_at : undefined;
    windows[label] = { remainingPercent: Math.round(100 - window.used_percent), resetsAt };
  }
  return windows;
}

const digest = bytes => createHash('sha256').update(bytes).digest('base64');

function tailRecords(bytes, offset) {
  const latest = {};
  let end = bytes.lastIndexOf(10);
  while (end > 0 && (!latest.usage || !latest.quota)) {
    const start = bytes.lastIndexOf(10, end - 1);
    if (start < 0) break;
    const line = bytes.subarray(start + 1, end);
    end = start;
    if (!line.includes('"token_count"')) continue;
    const event = json(line.toString('utf8'));
    if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
    const location = { position: offset + start + 1, length: line.length, digest: digest(line) };
    const { info, rate_limits: limits } = event.payload;
    if (info && !latest.usage) latest.usage = { ...location, value: tokenMetrics(info) };
    if (limits && !latest.quota) {
      latest.quota = {
        ...location, value: quotaWindows(limits), enterprise: enterprisePlans.has(limits.plan_type),
      };
    }
  }
  return latest;
}

async function confirmedRecord(file, record) {
  if (!record) return undefined;
  const line = await readFragment(file, record.length + 2, record.position - 1);
  return line[0] === 10 && line[record.length + 1] === 10
    && digest(line.subarray(1, -1)) === record.digest ? record : undefined;
}

async function rolloutMetrics(client, thread, home) {
  if (!home || typeof thread?.path !== 'string' || !isAbsolute(thread.path) || typeof thread.id !== 'string') return {};
  const [root, path] = await Promise.all([realpath(home), realpath(thread.path)]);
  const [directory] = relative(root, path).split(sep);
  const filename = basename(path);
  if (!['sessions', 'archived_sessions'].includes(directory)
    || !filename.startsWith('rollout-') || !filename.endsWith('-' + thread.id + '.jsonl')) return {};
  const key = client ?? thread;
  const file = await open(path, readFlags | (constants.O_NOFOLLOW ?? 0));
  try {
    const entry = await file.stat({ bigint: true });
    const size = Number(entry.size);
    if (!entry.isFile() || !size || !Number.isSafeInteger(size)) {
      rollouts.delete(key);
      return {};
    }
    const offset = Math.max(0, size - rolloutTailBytes);
    const tail = await readFragment(file, size - offset, offset);
    const head = offset ? await readFragment(file, Math.min(size, rolloutHeaderBytes)) : tail;
    const newline = head.indexOf(10);
    const header = newline < 0 ? null : json(head.toString('utf8', 0, newline));
    if (header?.type !== 'session_meta' || (header.payload?.id ?? header.payload?.session_id) !== thread.id) {
      rollouts.delete(key);
      return {};
    }

    // shortcut: on a cold start, omit metrics outside the recent 512 KiB until a new event arrives.
    const latest = tailRecords(tail, offset);
    const identity = entry.dev + ':' + entry.ino + ':' + entry.birthtimeNs;
    const cached = rollouts.get(key);
    const previous = cached?.path === path && cached.threadId === thread.id && cached.identity === identity
      && cached.size <= size ? cached : undefined;
    // The old event may have been overwritten even when the file regained its original size.
    const [usage, quota] = await Promise.all([
      latest.usage ?? confirmedRecord(file, previous?.usage),
      latest.quota ?? confirmedRecord(file, previous?.quota),
    ]);
    rollouts.set(key, { path, threadId: thread.id, identity, size, usage, quota });

    const now = Math.floor(Date.now() / 1000);
    const limits = Object.fromEntries(Object.entries(quota?.value ?? {})
      .filter(([, limit]) => limit.resetsAt === undefined || limit.resetsAt > now));
    return { ...usage?.value, ...(Object.keys(limits).length && { limits }), enterprise: quota?.enterprise };
  } finally {
    await file.close();
  }
}

const baseInstructions = ['AGENTS.override.md', 'AGENTS.md'];
const localFilename = name => typeof name === 'string' && name !== '.' && name !== '..' && basename(name) === name;

async function activeInstructions(cwd, home, config) {
  const allowance = config.project_doc_max_bytes;
  if (!Number.isSafeInteger(allowance) || allowance < 0 || allowance > rolloutHeaderBytes) return undefined;
  const markers = (config.project_root_markers ?? ['.git']).filter(localFilename);
  const fallbacks = (config.project_doc_fallback_filenames ?? []).filter(localFilename);
  const directories = [cwd];
  for (let path = cwd; markers.length && dirname(path) !== path; path = dirname(path)) {
    if ((await Promise.all(markers.map(marker => exists(join(path, marker))))).some(Boolean)) break;
    directories.unshift(dirname(path));
  }

  const included = new Set();
  async function docsAt(path, candidates, remaining) {
    for (const name of candidates) {
      const doc = join(path, name);
      const entry = await exists(doc);
      if (!entry?.isFile()) continue;
      const file = await open(doc, readFlags);
      try {
        const contents = await readFragment(file, Math.min(entry.size, remaining));
        if (contents.toString('utf8').trim() && baseInstructions.includes(name)) included.add(doc);
        return Math.min(entry.size, remaining);
      } finally {
        await file.close();
      }
    }
    return 0;
  }

  await docsAt(home, baseInstructions, rolloutHeaderBytes);
  let remaining = allowance;
  for (const path of directories) {
    if (!remaining) break;
    remaining -= await docsAt(path, [...baseInstructions, ...fallbacks], remaining);
  }
  return included.size;
}

async function readEnvironment(client, cwd, home) {
  const [{ value: settings }, { value: listed }] = await Promise.allSettled([
    client.request('config/read', { cwd, includeLayers: false }, optionalRequestTimeout),
    client.request('hooks/list', { cwds: [cwd] }, optionalRequestTimeout),
  ]);
  const config = settings?.config;
  const environment = {};
  if (config) {
    if (config.mcp_servers && typeof config.mcp_servers === 'object') {
      environment.mcps = Object.values(config.mcp_servers).filter(server => server?.enabled === true).length;
    }
    const count = await activeInstructions(cwd, home, config).catch(() => undefined);
    if (count !== undefined) environment.agentsMd = count;
  }
  const hookScope = Array.isArray(listed?.data) ? listed.data[0] : undefined;
  if (Array.isArray(hookScope?.hooks) && !hookScope.errors?.length) {
    environment.hooks = hookScope.hooks.filter(hook => hook?.enabled === true).length;
  }
  return environment;
}

function cachedEnvironment(client, cwd, home) {
  if (!client || !home || !cwd) return {};
  const now = Date.now();
  const cached = environments.get(client);
  if (cached?.cwd === cwd && cached.home === home && cached.expires > now) return cached.result;
  const result = readEnvironment(client, cwd, home).catch(() => ({}));
  environments.set(client, { cwd, home, expires: now + configRefreshMs, result });
  return result;
}

function cachedCost(client, threadId) {
  const now = Date.now();
  const cached = costs.get(client);
  if (cached?.threadId === threadId && cached.expires > now) return cached;
  const next = { threadId, expires: now + costRefreshMs };
  costs.set(client, next);
  // Billing is optional, so keep the first frame and the next activity query responsive.
  next.result = Promise.resolve().then(() => client.request('account/usage/read', { threadId }, optionalRequestTimeout))
    .then(({ threadUsage }) => {
      const micros = threadUsage?.estimatedUsageUsdMicros;
      if (threadUsage?.threadId === threadId && validNumber(micros)) next.usd = micros / 1_000_000;
    }).catch(() => {});
  return next;
}

export async function readHudMetrics(client, thread, { cwd, home, waitForCost = false } = {}) {
  const total = totalmem();
  const [{ enterprise, ...rollout }, environment] = await Promise.all([
    rolloutMetrics(client, thread, home).catch(() => ({})),
    cachedEnvironment(client, cwd, home),
  ]);
  const cost = client && enterprise ? cachedCost(client, thread.id) : undefined;
  if (cost && waitForCost) await cost.result;
  const estimatedCostUsd = cost?.usd;
  return {
    ...rollout,
    memory: { used: Math.max(0, total - freemem()), total },
    ...(Object.keys(environment).length && { environment }),
    ...(estimatedCostUsd !== undefined && { estimatedCostUsd }),
  };
}
