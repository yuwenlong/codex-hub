import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const rolloutTailBytes = 512 * 1024;
const rolloutHeaderBytes = 256 * 1024;
const configRefreshMs = 30_000;
const costRefreshMs = 60_000;
const rateLimitRefreshMs = 60_000;
const rateLimitRetryMs = 30_000;
const optionalRequestTimeout = { timeoutMs: 1500 };
const rollouts = new WeakMap();
const environments = new WeakMap();
const costs = new WeakMap();
const accountRateLimits = new WeakMap();
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

function remainingPercent(used) {
  if (used === 0) return 100;
  if (used < 0.01) return 99.99;
  // Subtract decimal hundredths before converting, avoiding binary subtraction artifacts like 9.98999.
  const [whole, fraction = ''] = String(used).split('.');
  const hundredths = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  return (10_000 - hundredths - Number(/[1-9]/u.test(fraction.slice(2)))) / 100;
}

function quotaWindow(minutes, usedPercent, reset) {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || !validNumber(usedPercent) || usedPercent > 100) return undefined;
  const resetsAt = Number.isSafeInteger(reset) && reset >= 0 ? reset : undefined;
  return { minutes, usedPercent, remainingPercent: remainingPercent(usedPercent), resetsAt };
}

function rolloutQuotaWindows(snapshot) {
  const windows = {};
  for (const window of [snapshot.primary, snapshot.secondary]) {
    const duration = window?.window_minutes ?? window?.window_duration_mins;
    const label = duration === 300 ? 'fiveHour' : duration === 10_080 ? 'weekly' : null;
    if (!label) continue;
    const normalized = quotaWindow(duration, window.used_percent, window.resets_at);
    if (normalized) {
      const { minutes, ...limit } = normalized;
      windows[label] = limit;
    }
  }
  return windows;
}

const bucketText = value => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim() || undefined : undefined;

function officialEndpoint(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  try {
    const { protocol, hostname, port, username, password, search, hash, pathname } = new URL(value);
    if (protocol !== 'https:' || port || username || password || search || hash) return false;
    const path = pathname.replace(/\/+$/u, '');
    if (hostname === 'api.openai.com') return path === '' || path === '/v1';
    return (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') &&
      (path === '/backend-api' || path === '/backend-api/codex');
  } catch {
    return false;
  }
}

function quotaCandidate(key, bucket) {
  if (!bucket || typeof bucket !== 'object') return undefined;
  const windows = [bucket.primary, bucket.secondary]
    .map(window => quotaWindow(window?.windowDurationMins, window?.usedPercent, window?.resetsAt)).filter(Boolean);
  if (!windows.length) return undefined;
  return { id: bucketText(bucket.limitId) ?? key, name: bucketText(bucket.limitName), windows };
}

function quotaCandidates(response) {
  const grouped = response?.rateLimitsByLimitId;
  const entries = grouped && typeof grouped === 'object' && !Array.isArray(grouped) ? Object.entries(grouped) : [];
  entries.sort(([first, a], [second, b]) => Number(second === b?.limitId) - Number(first === a?.limitId));
  const identified = entries.map(([key, bucket]) => {
    const id = bucketText(key);
    return id ? quotaCandidate(id, bucket) : undefined;
  }).filter(Boolean);
  return { identified, legacy: quotaCandidate(undefined, response?.rateLimits) };
}

function activeQuotaGroups(candidates, now) {
  if (!candidates) return [];
  const groups = new Map();
  function collect(candidate) {
    const live = candidate.windows.filter(window => window.resetsAt === undefined || window.resetsAt > now);
    if (!live.length) return;
    const { id, name } = candidate;
    const group = groups.get(id) ?? { id, name, windows: new Map() };
    group.name ??= name;
    for (const window of live) if (!group.windows.has(window.minutes)) group.windows.set(window.minutes, window);
    groups.set(id, group);
  }
  // Resolve duplicate IDs only after removing expired windows, including between network refreshes.
  for (const candidate of candidates.identified) collect(candidate);
  if (!groups.size && candidates.legacy) collect(candidates.legacy);
  return [...groups.values()].sort((first, second) => (first.id ?? '').localeCompare(second.id ?? ''))
    .map(group => ({ ...group, windows: [...group.windows.values()].sort((first, second) => first.minutes - second.minutes) }));
}

function cachedRateLimits(client) {
  const now = Date.now();
  const current = accountRateLimits.get(client) ?? { refreshAt: 0 };
  if (current.result || current.refreshAt > now) return current;
  accountRateLimits.set(client, current);
  current.result = Promise.resolve().then(() => client.request('account/rateLimits/read', {}, optionalRequestTimeout))
    .then(response => {
      current.candidates = quotaCandidates(response);
      current.refreshAt = Date.now() + rateLimitRefreshMs;
    }).catch(() => {
      current.candidates = undefined;
      current.refreshAt = Date.now() + rateLimitRetryMs;
    }).finally(() => { current.result = undefined; });
  return current;
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
        ...location, value: rolloutQuotaWindows(limits), enterprise: enterprisePlans.has(limits.plan_type),
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
  const candidate = settings?.config;
  const config = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : undefined;
  const environment = {};
  if (config) {
    if (config.mcp_servers && typeof config.mcp_servers === 'object') {
      environment.mcps = Object.values(config.mcp_servers).filter(server => server?.enabled === true).length;
    }
    const roles = Object.values(config.agents ?? {}).filter(role =>
      role && typeof role === 'object' && Object.hasOwn(role, 'config_file'));
    if (roles.length) environment.agents = roles.length;
    const count = await activeInstructions(cwd, home, config).catch(() => undefined);
    if (count !== undefined) environment.agentsMd = count;
  }
  const hookScope = Array.isArray(listed?.data) ? listed.data[0] : undefined;
  if (Array.isArray(hookScope?.hooks) && !hookScope.errors?.length) {
    environment.hooks = hookScope.hooks.filter(hook => hook?.enabled === true).length;
  }
  // Codex 0.170 does not resolve OPENAI_BASE_URL as a model override. Use its effective config.
  const officialProvider = config && (config.model_provider ?? 'openai') === 'openai' &&
    officialEndpoint(config.openai_base_url) && officialEndpoint(config.chatgpt_base_url);
  return { environment, officialProvider };
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

export async function readHudMetrics(client, thread, { cwd, home, waitForCost = false, useAccountQuota = true } = {}) {
  const total = totalmem();
  const [{ enterprise, ...rollout }, { environment = {}, officialProvider }] = await Promise.all([
    rolloutMetrics(client, thread, home).catch(() => ({})),
    cachedEnvironment(client, cwd, home),
  ]);
  // A resumed thread can still report its previous provider until the new session updates its metadata.
  const account = useAccountQuota && client && officialProvider && thread?.modelProvider === 'openai'
    ? cachedRateLimits(client) : undefined;
  const cost = client && enterprise ? cachedCost(client, thread.id) : undefined;
  if (waitForCost) await Promise.all([cost?.result, account?.result]);
  const quotaGroups = activeQuotaGroups(account?.candidates, Date.now() / 1000);
  const estimatedCostUsd = cost?.usd;
  return {
    ...rollout,
    memory: { used: Math.max(0, total - freemem()), total },
    ...(quotaGroups.length && { quotaGroups }),
    ...(Object.keys(environment).length && { environment }),
    ...(estimatedCostUsd !== undefined && { estimatedCostUsd }),
  };
}
