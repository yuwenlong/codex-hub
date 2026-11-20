import { execFile, spawn } from 'node:child_process';
import { constants, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { openClient, resolveCodex } from './app-server.mjs';
import { readActivity, renderActivity } from './activity.mjs';
import { readHudMetrics, readMemoryUsage } from './hud-metrics.mjs';

const nativeCommands = new Set([
  'a', 'agents', 'app-server', 'apply', 'archive', 'cloud', 'completion', 'debug', 'delete', 'doctor', 'e', 'exec',
  'exec-server', 'features', 'help', 'login', 'logout', 'mcp', 'mcp-server', 'migrate-nfs-db', 'migrate-rollouts',
  'plugin', 'queue', 'remote-control', 'review', 'sandbox', 'unarchive', 'update',
]);
const shortOptions = new Map([
  ['-a', '--ask-for-approval'], ['-c', '--config'], ['-C', '--cd'], ['-i', '--image'], ['-m', '--model'],
  ['-p', '--profile'], ['-s', '--sandbox'],
]);
const valueOptions = new Set([
  ...shortOptions.values(), '--add-dir', '--disable', '--enable', '--local-provider',
]);
const switchOptions = new Set([
  '--all', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
  '--include-non-interactive', '--last', '--no-daemon', '--oss', '--search', '--strict-config', '--worktree',
]);
const configOptions = new Set(['--config', '--disable', '--enable']);
const footerKeys = new Set(['tui', 'tui.alternate_screen', 'tui.status_line', 'tui.terminal_title']);
const displayArgs = [
  '-c', 'tui.alternate_screen="always"',
  '-c', 'tui.status_line=["thread-id","model-with-reasoning","context-used","task-progress","five-hour-limit","weekly-limit","codex-version"]',
  '-c', 'tui.terminal_title=["thread-id"]',
];
const idPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const requestTimeout = 1500;

export function interactiveOptions(args, cwd = process.cwd()) {
  let workspace = cwd;
  let seenPosition = false;
  let profile;
  let useAccountQuota = true;
  const configArgs = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') break;
    if (!argument.startsWith('-') || argument === '-') {
      if (!seenPosition && nativeCommands.has(argument)) return undefined;
      seenPosition = true;
      continue;
    }
    const short = shortOptions.get(argument.slice(0, 2));
    const equal = argument.indexOf('=');
    const option = short ?? (equal < 0 ? argument : argument.slice(0, equal));
    if (switchOptions.has(option) && equal < 0) {
      if (option === '--oss') useAccountQuota = false;
      continue;
    }
    if (!valueOptions.has(option)) return undefined;
    let value = short && argument.length > 2 ? argument.slice(2).replace(/^=/u, '') : undefined;
    if (value === undefined) value = equal >= 0 ? argument.slice(equal + 1) : args[++index];
    if (!value) return undefined;
    if (option === '--config') {
      const setting = value.split('=', 1)[0].trim().replace(/['"]/gu, '');
      if (footerKeys.has(setting)) return undefined;
    }
    if (option === '--local-provider') useAccountQuota = false;
    if (option === '--cd') workspace = resolve(cwd, value);
    if (option === '--profile') profile = value;
    if (configOptions.has(option)) configArgs.push(option, value);
  }
  return { workspace, configArgs, ...(profile && { profile }), ...(!useAccountQuota && { useAccountQuota }) };
}

async function passthrough(file, args, cwd, env) {
  if (process.platform !== 'win32' && typeof process.execve === 'function') process.execve(file, [file, ...args], env);
  const child = spawn(file, args, { cwd, env, stdio: 'inherit' });
  const forwards = new Map(['SIGHUP', 'SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, forward] of forwards) process.on(signal, forward);
  let result;
  try {
    result = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code, signal) => done({ code, signal }));
    });
  } finally {
    for (const [signal, forward] of forwards) process.off(signal, forward);
  }
  if (!result.signal) return result.code;
  if (process.platform !== 'win32') process.kill(process.pid, result.signal);
  return 128 + (constants.signals[result.signal] ?? 1);
}

export function createLaunchHud({ cwd, home, connect, color = true, showEnvironment = true, useAccountQuota = true }) {
  const lifetime = new AbortController();
  let connection;
  let client;
  let connecting = false;
  let retryAt = 0;
  let gitBranch;

  function currentBranch(workspace) {
    const now = Date.now();
    if (gitBranch?.workspace === workspace && gitBranch.expires > now) return gitBranch.result;
    const result = new Promise(resolveBranch => {
      execFile('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: workspace, timeout: 500, maxBuffer: 1024, signal: lifetime.signal, windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' },
      }, (error, stdout, stderr) => {
        if (error?.code === 1 || (error?.code === 128 && stderr.startsWith('fatal: not a git repository'))) {
          return resolveBranch(null);
        }
        const name = stdout.trim();
        resolveBranch(!error && name && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? name : undefined);
      });
    });
    gitBranch = { workspace, expires: now + 15_000, result };
    return result;
  }

  function connectInBackground() {
    if (connection?.closed) {
      connection = undefined;
      client = undefined;
    }
    if (client || connecting || Date.now() < retryAt) return;
    connecting = true;
    void Promise.resolve().then(() => connect(lifetime.signal)).then(ready => {
      if (lifetime.signal.aborted) {
        ready.close();
        return;
      }
      connection = ready;
      client = {
        codexVersion: ready.codexVersion,
        request: (method, params, options) => ready.request(method, params, { timeoutMs: requestTimeout, ...options }),
      };
    }).catch(() => { retryAt = Date.now() + 5000; }).finally(() => { connecting = false; });
  }

  function renderHud(snapshot, { model, reasoning, contextPercent, limits, version, columns, rows, taskProgress }) {
    const now = Date.now() / 1000;
    const quota = { ...snapshot.limits };
    // The native footer reads the Codex bucket. Keep independently reported account groups intact.
    for (const [period, native] of Object.entries(limits ?? {})) {
      const resetsAt = snapshot.rolloutLimitId === 'codex' ? quota[period]?.resetsAt : undefined;
      quota[period] = { ...(Number.isFinite(resetsAt) && resetsAt > now && { resetsAt }), ...native };
    }
    return renderActivity({
      ...snapshot, limits: quota, taskProgress,
      model: model ?? snapshot.model, reasoning: reasoning ?? snapshot.reasoning,
      contextPercent: contextPercent ?? snapshot.contextPercent,
      cliVersion: version ?? snapshot.cliVersion,
      environment: showEnvironment ? snapshot.environment : undefined,
    }, { embedded: true, color, width: columns, height: rows, now });
  }

  function initialHud(metrics) {
    if (lifetime.signal.aborted) return '';
    return renderHud({ workspace: cwd, memory: readMemoryUsage() }, metrics);
  }

  async function readHud(metrics) {
    const { threadId, signal } = metrics;
    if (signal?.aborted || lifetime.signal.aborted) return '';
    connectInBackground();
    const current = client;
    const recorded = current && idPattern.test(threadId)
      ? await readActivity(current, { cwd, home, threadId, useAccountQuota }).catch(() => undefined) : undefined;
    const snapshot = recorded ?? {
      workspace: cwd, cliVersion: current?.codexVersion, ...await readHudMetrics(current, undefined, { cwd, home }),
    };
    const liveBranch = await currentBranch(snapshot.workspace || cwd);
    const branch = liveBranch === undefined ? snapshot.branch : liveBranch;
    if (signal?.aborted || lifetime.signal.aborted) return '';
    return renderHud({ ...snapshot, branch }, metrics);
  }

  function close() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    connection?.close();
  }

  return { initialHud, readHud, close };
}

export async function launchCodex(args) {
  const { stdin, stdout, env } = process;
  const cwd = process.cwd();
  const codex = await resolveCodex({ cwd, env });
  const [file, launcherArgs] = codex;
  const interactive = stdin.isTTY && stdout.isTTY && env.TERM !== 'dumb' && env.CODEX_HUB_BYPASS !== '1'
    && interactiveOptions(args, cwd);
  if (!interactive) return passthrough(file, [...launcherArgs, ...args], cwd, env);

  const { runTerminal, TerminalDependencyError } = await import('./terminal-host.mjs');
  const { workspace, configArgs, profile, useAccountQuota } = interactive;
  const home = resolve(env.CODEX_HOME || join(homedir(), '.codex'));
  const hud = createLaunchHud({
    // The local app-server cannot apply the CLI's --profile overlay.
    cwd: workspace, home, color: !env.NO_COLOR && stdout.hasColors(), showEnvironment: !profile,
    useAccountQuota: !profile && useAccountQuota !== false,
    connect: signal => openClient({ cwd: workspace, env, codex, configArgs, signal, experimentalApi: true }),
  });
  try {
    return await runTerminal({
      file, args: [...launcherArgs, ...displayArgs, ...args], env, cwd, initialHud: hud.initialHud, readHud: hud.readHud,
    });
  } catch (error) {
    if (!(error instanceof TerminalDependencyError)) throw error;
    process.stderr.write('codex-hub: terminal dependencies unavailable, launching Codex directly.\n');
  } finally {
    hud.close();
  }
  return passthrough(file, [...launcherArgs, ...args], cwd, env);
}
