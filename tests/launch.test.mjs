import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { createLaunchHud, interactiveOptions } from '../lib/launch.mjs';
import { closePtyHandle } from '../lib/terminal-host.mjs';
import { runCli } from './run-cli.mjs';

const firstThread = '01a1ee97-bbc8-7382-995e-b80b8d24ad74';
const secondThread = '01a1ee98-bbc8-7382-995e-b80b8d24ad75';
const require = createRequire(import.meta.url);

test('launch distinguishes interactive arguments from native commands and display overrides', () => {
  const cwd = process.cwd();
  for (const args of [[], ['--', 'exec'], ['Use the default model'], ['Use the default model', 'resume']]) {
    assert.deepEqual(interactiveOptions(args, cwd), { workspace: cwd, configArgs: [] }, JSON.stringify(args));
  }
  for (const args of [['resume', '--last'], ['fork', firstThread], ['-mquiet', 'resume']]) {
    assert.deepEqual(interactiveOptions(args, cwd), { workspace: cwd, configArgs: [], resumesThread: true }, JSON.stringify(args));
  }
  const args = ['--profile=team', '-C', 'workspace folder', 'resume', '-c', 'model_reasoning_effort="high"'];
  assert.deepEqual(interactiveOptions(args, cwd), {
    workspace: join(cwd, 'workspace folder'), profile: 'team', configArgs: ['--config', 'model_reasoning_effort="high"'], resumesThread: true,
  });
  for (const args of [
    ['exec', '--json', 'prompt'], ['-pteam', 'app-server'], ['--help'], ['resume', '-h'], ['-V'],
    ['agents'], ['--remote=unix:///somewhere'], ['--no-alt-screen'], ['-c', 'tui.status_line=[]'], ['--new-option'],
  ]) {
    assert.equal(interactiveOptions(args, cwd), undefined, JSON.stringify(args));
  }
  for (const args of [['--oss', 'resume'], ['--local-provider=ollama']]) {
    assert.equal(interactiveOptions(args, cwd).useAccountQuota, false, JSON.stringify(args));
  }
  const overrides = ['model_providers.alternate.name="Alternate provider"', 'model_provider="alternate"', 'model_provider="openai"'];
  assert.deepEqual(interactiveOptions(overrides.flatMap(value => ['-c', value]), cwd), {
    workspace: cwd, configArgs: overrides.flatMap(value => ['--config', value]),
  });
});

async function nativeFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud launch with spaces '));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = cwd;
  const code = `
if (process.argv[2] === 'signal-fixture') process.kill(process.pid, 'SIGTERM');
else {
  process.stdout.write(JSON.stringify(process.argv.slice(2)));
  process.exitCode = 23;
}
`;
  if (process.platform === 'win32') {
    const bin = join(cwd, 'node_modules', '@openai', 'codex', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'codex.js'), code);
    await writeFile(join(cwd, 'codex.cmd'), '@exit /b 17\r\n');
  } else {
    const file = join(cwd, 'fixture.cjs');
    const executable = join(cwd, 'codex');
    env.CODEX_HUD_TEST_NODE = process.execPath;
    env.CODEX_HUD_TEST_SCRIPT = file;
    await writeFile(file, code);
    await writeFile(executable, '#!/bin/sh\nexec "$CODEX_HUD_TEST_NODE" "$CODEX_HUD_TEST_SCRIPT" "$@"\n');
    await chmod(executable, 0o700);
  }
  return { cwd, env };
}

test('the CLI passes non-interactive arguments and exit status to the native Codex command', async t => {
  const { cwd, env } = await nativeFixture(t);
  const nativeArgs = ['--profile', 'team', 'exec', '--', '命令 & with "quotes"'];
  const result = runCli(cwd, ['launch', '--', ...nativeArgs], { env, cwd, timeout: 5000 });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), nativeArgs);
  if (process.platform !== 'win32') {
    const cli = fileURLToPath(new URL('../bin/codex-hud.mjs', import.meta.url));
    const signalled = spawnSync(process.execPath, [cli, 'launch', '--', 'signal-fixture'], { env, cwd, stdio: 'ignore', timeout: 5000 });
    assert.equal(signalled.signal, 'SIGTERM');
  }
});

test('an unavailable PTY dependency falls back before changing Codex arguments or input', async t => {
  const { cwd, env: fixtureEnv } = await nativeFixture(t);
  const env = { ...fixtureEnv, NODE_PATH: '', TERM: 'xterm-256color', CODEX_HUD_BYPASS: '0' };
  for (const name of ['bin', 'lib']) {
    await cp(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(cwd, name), { recursive: true });
  }
  const cli = join(cwd, 'bin', 'codex-hud.mjs');
  const nativeArgs = ['-C', 'folder with spaces', '命令 & with "quotes"'];
  const { spawn } = require('node-pty');
  async function launchFixture() {
    const pty = spawn(process.execPath, [cli, 'launch', '--', ...nativeArgs], { cwd, env, name: env.TERM, cols: 100, rows: 24 });
    let output = '';
    const dataSubscription = pty.onData(data => { output += data; });
    let timer;
    let exitSubscription;
    try {
      const exit = await new Promise((resolveExit, reject) => {
        exitSubscription = pty.onExit(resolveExit);
        timer = setTimeout(() => {
          try { pty.kill(); } catch {}
          reject(new Error('Codex did not exit under the terminal'));
        }, 7000);
      });
      return { ...exit, output };
    } finally {
      clearTimeout(timer);
      exitSubscription?.dispose();
      dataSubscription.dispose();
      closePtyHandle(pty);
    }
  }
  const xterm = join(cwd, 'node_modules', '@xterm', 'headless');
  const pty = join(cwd, 'node_modules', 'node-pty');
  for (const [index, brokenDependency] of [
    undefined,
    'throw Object.assign(new Error("Native ABI mismatch"), { code: "ERR_DLOPEN_FAILED" });',
    'throw new Error("Failed to load native module: pty.node, checked: prebuilds/linux-x64: Incompatible ELF");',
  ].entries()) {
    if (index === 1) {
      await mkdir(xterm, { recursive: true });
      await mkdir(pty, { recursive: true });
      await writeFile(join(xterm, 'index.js'), 'module.exports = { Terminal: class { dispose() {} } };');
    }
    if (brokenDependency) await writeFile(join(pty, 'index.js'), brokenDependency);
    const result = await launchFixture();
    assert.equal(result.exitCode, 23, result.output);
    assert.equal(result.output.match(/launching Codex directly/g)?.length, 1, result.output);
    assert.ok(result.output.includes(JSON.stringify(nativeArgs)), result.output);
    assert.doesNotMatch(result.output, /tui\.status_line|tui\.alternate_screen/u);
  }
  await writeFile(join(pty, 'index.js'), 'module.exports.spawn = () => { throw new Error("Ordinary PTY error"); };');
  const failure = await launchFixture();
  assert.equal(failure.exitCode, 1, failure.output);
  assert.match(failure.output, /Ordinary PTY error/u);
  assert.doesNotMatch(failure.output, /launching Codex directly/u);
});

test('the initial HUD renders local and native fields synchronously without starting a connection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-hud initial '));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cwd = join(root, 'fixture workspace');
  await mkdir(cwd);
  const connection = Promise.withResolvers();
  let connectionAttempts = 0;
  const hud = createLaunchHud({ cwd, color: false, connect() {
    connectionAttempts++;
    return connection.promise;
  } });
  t.after(hud.close);
  const dimensions = { columns: 100, rows: 12 };
  const first = hud.initialHud?.(dimensions);
  assert.equal(typeof first, 'string');
  assert.match(first, /^fixture workspace\n内存 [^\n]+$/u);
  assert.doesNotMatch(first, /\u001b/u);
  await nextTick();
  assert.equal(connectionAttempts, 0);

  const native = {
    ...dimensions, threadId: firstThread, model: 'gpt-live', reasoning: 'high', contextPercent: 0, version: '0.170.0',
    limits: { fiveHour: { remainingPercent: 80 } }, taskProgress: { completed: 1, total: 2 },
  };
  const refresh = hud.readHud(native);
  await nextTick();
  assert.equal(connectionAttempts, 1);
  const pending = hud.initialHud(native);
  assert.match(pending, /^\[gpt-live ◑ high\].*fixture workspace.*Codex v0\.170\.0\n上下文 .*0% │ 5h 剩余 80%\n内存 [^\n]+\n▸ 任务进度 \(1\/2\)$/u);
  connection.resolve({ close() {} });
  await refresh;
});

test('the HUD presents live data before initialization and only reads the currently visible thread', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud isolated launch '));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const connection = Promise.withResolvers();
  let closed = false;
  let heldRead;
  const reads = [];
  const hud = createLaunchHud({ cwd, home: cwd, connect: () => connection.promise, color: false });
  t.after(hud.close);
  const native = { model: 'gpt-live', reasoning: 'high', contextPercent: 0, version: '0.170.0', columns: 100, rows: 12 };
  const idle = await hud.readHud({ ...native, threadId: firstThread });
  assert.match(idle, /^\[gpt-live ◑ high\].*Codex v0\.170\.0\n上下文 .*0%\n内存/u);
  assert.doesNotMatch(idle, /暂无|费用|缓存/u);
  connection.resolve({
    close() { closed = true; },
    async request(method, params) {
      if (method === 'thread/read') {
        reads.push(params.threadId);
        if (params.threadId === secondThread) throw new Error('not stored');
        if (heldRead) await heldRead.promise;
        return { thread: { id: firstThread, cwd, model: 'previous-model', historyMode: 'legacy' } };
      }
      if (method === 'thread/turns/list') return { data: [{
        id: 'turn', status: 'completed', items: [{ id: 'shell', type: 'commandExecution', status: 'completed' }],
      }] };
      if (method === 'config/read') return { config: { project_doc_max_bytes: 0, mcp_servers: { git: { enabled: true } } } };
      if (method === 'hooks/list') return { data: [] };
      assert.fail(method);
    },
  });
  await nextTick();
  const active = await hud.readHud({ ...native, threadId: firstThread, contextPercent: 37 });
  assert.match(active, /gpt-live[\s\S]*37%[\s\S]*1 MCPs[\s\S]*✓ Shell/u);
  assert.doesNotMatch(active, /previous-model/u);
  heldRead = Promise.withResolvers();
  const session = new AbortController();
  const oldFrame = hud.readHud({ ...native, threadId: firstThread, signal: session.signal });
  session.abort();
  const initial = hud.initialHud({ ...native, threadId: secondThread });
  assert.match(initial, /上下文 .*0%/u);
  assert.doesNotMatch(initial, /37%|✓ Shell/u);
  const switched = await hud.readHud({ ...native, threadId: secondThread });
  assert.match(switched, /上下文 .*0%/u);
  assert.doesNotMatch(switched, /37%|✓ Shell|暂无/u);
  heldRead.resolve();
  assert.equal(await oldFrame, '');
  assert.deepEqual(reads, [firstThread, firstThread, secondThread]);
  hud.close();
  assert.equal(closed, true);
  assert.equal(await hud.readHud({ ...native, threadId: firstThread }), '');
});

test('closing the HUD during initialization closes a late connection', async () => {
  const connection = Promise.withResolvers();
  let starting;
  let closed = 0;
  const hud = createLaunchHud({ cwd: process.cwd(), connect: signal => {
    starting = signal;
    return connection.promise;
  } });
  await hud.readHud({ model: 'gpt-live' });
  hud.close();
  assert.equal(starting.aborted, true);
  connection.resolve({ close() { closed++; } });
  await nextTick();
  assert.equal(closed, 1);
});

test('the native weekly quota keeps a matching reset time and follows the clock while idle', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud weekly quota '));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const sessions = join(cwd, 'sessions');
  await mkdir(sessions);
  const path = join(sessions, `rollout-fixture-${firstThread}.jsonl`);
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: firstThread } });
  let now = 1795000000;
  t.mock.method(Date, 'now', () => now * 1000);
  const reset = now + 2 * 86400 + 3 * 3600 + 5 * 60 + 1;
  const writeQuota = limit_id => writeFile(path, `${meta}\n${JSON.stringify({ type: 'event_msg', payload: {
    type: 'token_count', info: null,
    rate_limits: { limit_id, secondary: { used_percent: 93, window_minutes: 10_080, resets_at: reset } },
  } })}\n`);
  await writeQuota('codex');
  const hud = createLaunchHud({ cwd, home: cwd, connect: async () => ({
    close() {},
    async request(method) {
      if (method === 'thread/read') return { thread: { id: firstThread, cwd, path } };
      if (method === 'config/read') return { config: { project_doc_max_bytes: 0 } };
      return { data: [] };
    },
  }) });
  t.after(hud.close);
  const native = { threadId: firstThread, limits: { weekly: { remainingPercent: 90 } } };
  const frame = async (input = native) => stripVTControlCharacters(await hud.readHud(input));
  await frame();
  await nextTick();
  const initial = await hud.readHud(native);
  assert.match(initial, /\u001b\[94m90%\u001b\[0m/u);
  assert.match(stripVTControlCharacters(initial), /7d 剩余 90% \(2d 3h 6m\)/u);
  now++;
  assert.match(await frame(), /7d 剩余 90% \(2d 3h 5m\)/u);
  await writeQuota('spark');
  assert.match(await frame(), /7d 剩余 90%\n/u);
  assert.match(await frame({ threadId: firstThread }), /7d 剩余 7% \(2d 3h 5m\)/u);
  await writeQuota();
  assert.match(await frame(), /7d 剩余 90% \(2d 3h 5m\)/u);
  now = reset - 1;
  assert.match(await frame(), /7d 剩余 90% \(1m\)/u);
  now = reset;
  assert.match(await frame(), /7d 剩余 90%\n/u);
});

test('a restored thread accepts both windows from the rollout registered under a different filename', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud rotated quota '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const sessions = join(cwd, 'sessions');
  await mkdir(sessions);
  let path = join(sessions, 'rollout-2026-11-20T11-29-36-' + secondThread + '.jsonl');
  let now = 1795000000;
  t.mock.method(Date, 'now', () => now * 1000);
  const quota = { limit_id: 'codex',
    primary: { used_percent: 31, window_minutes: 10_080, resets_at: now + 241 },
    secondary: { used_percent: 7, window_minutes: 300, resets_at: now + 61 },
  };
  const event = { type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: quota } };
  const writeQuota = async payload => writeFile(path, [
    { type: 'session_meta', payload }, event,
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  await writeQuota({ id: firstThread, session_id: firstThread });

  const hud = createLaunchHud({ cwd, home: cwd, useAccountQuota: false, color: false, connect: async () => ({
    close() {},
    async request(method) {
      if (method === 'thread/read') return { thread: { id: firstThread, cwd, path, modelProvider: 'openai' } };
      return { data: [] };
    },
  }) });
  t.after(hud.close);
  const frame = () => hud.readHud({ threadId: firstThread, limits: {
    fiveHour: { remainingPercent: 93 }, weekly: { remainingPercent: 69 },
  } });
  await frame();
  await nextTick();
  assert.match(await frame(), /5h 剩余 93% \(2m\) │ 7d 剩余 69% \(5m\)/u);
  now += 61;
  assert.match(await frame(), /5h 剩余 93% │ 7d 剩余 69% \(3m\)/u);
  await writeQuota({ id: secondThread, session_id: firstThread });
  assert.match(await frame(), /5h 剩余 93% │ 7d 剩余 69%\n/u);
  await writeQuota({ session_id: firstThread });
  assert.match(await frame(), /5h 剩余 93% │ 7d 剩余 69%\n/u);
  path = join(sessions, 'rollout-2026-11-20T11-29-36-' + firstThread + '.jsonl');
  await writeQuota({ session_id: firstThread });
  assert.match(await frame(), /5h 剩余 93% │ 7d 剩余 69% \(3m\)/u);
});

test('a fresh official launch reads the account windows before the first message', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud cold quota '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const start = 1795000000;
  let now = start;
  t.mock.method(Date, 'now', () => now * 1000);
  const account = Promise.withResolvers();
  let reads = 0;
  const hud = createLaunchHud({ cwd, home: cwd, startsNewThread: true, color: false, connect: async () => ({
    close() {},
    async request(method, params) {
      if (method === 'thread/read') throw Object.assign(new Error('Codex thread/read: thread not loaded: ' + params.threadId), { code: -32600 });
      if (method === 'config/read') return { config: { model_provider: 'openai' } };
      if (method === 'account/rateLimits/read') {
        reads++;
        return account.promise;
      }
      return { data: [] };
    },
  }) });
  t.after(hud.close);
  const frame = options => hud.readHud({ model: 'gpt-live', columns: 110, rows: 12, ...options });
  const thread = { threadId: firstThread };
  assert.doesNotMatch(await frame(), /5h 剩余|7d 剩余/u);
  await nextTick();
  assert.doesNotMatch(await frame(thread), /5h 剩余|7d 剩余/u);
  account.resolve({ rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 32, windowDurationMins: 10_080, resetsAt: start + 180 },
      secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: start + 60 } },
    spark: { limitId: 'spark', primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: start + 900 } },
  } });
  await nextTick();
  assert.match(await frame(thread), /5h 剩余 90% \(1m\) │ 7d 剩余 68% \(3m\)/u);
  assert.equal(reads, 1);
  const live = { ...thread, limits: { fiveHour: { remainingPercent: 89 }, weekly: { remainingPercent: 69 } } };
  assert.match(await frame(live), /5h 剩余 89% \(1m\) │ 7d 剩余 69% \(3m\)/u);
  now += 60;
  assert.match(await frame(live), /5h 剩余 89% │ 7d 剩余 69% \(2m\)/u);
  const weeklyOnly = await frame(thread);
  assert.match(weeklyOnly, /7d 剩余 68% \(2m\)/u);
  assert.doesNotMatch(weeklyOnly, /5h 剩余/u);
  assert.match(await frame({ ...live, threadId: secondThread }), /5h 剩余 89% │ 7d 剩余 69%\n/u);
  now = start + 180;
  assert.match(await frame(live), /5h 剩余 89% │ 7d 剩余 69%\n/u);
});

test('a fresh launch keeps unnamed legacy quotas as their own measured windows', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud legacy cold quota '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const now = 1795000000;
  t.mock.method(Date, 'now', () => now * 1000);
  const hud = createLaunchHud({ cwd, home: cwd, startsNewThread: true, color: false, connect: async () => ({
    close() {},
    async request(method) {
      if (method === 'thread/read') throw Object.assign(new Error('Thread not loaded'), { code: -32600 });
      if (method === 'config/read') return { config: {} };
      if (method === 'account/rateLimits/read') return {
        rateLimitsByLimitId: null,
        rateLimits: { limitId: null, primary: {
          usedPercent: 11, windowDurationMins: 300, resetsAt: now + 120,
        }, secondary: {
          usedPercent: 28, windowDurationMins: 10_080, resetsAt: now + 600,
        } },
      };
      return { data: [] };
    },
  }) });
  t.after(hud.close);
  const frame = options => hud.readHud({ threadId: firstThread, ...options });
  await frame();
  await nextTick();
  await frame();
  await nextTick();
  assert.match(await frame(), /5h 剩余 89% \(2m\) │ 7d 剩余 72% \(10m\)/u);
  const native = { fiveHour: { remainingPercent: 44 }, weekly: { remainingPercent: 55 } };
  assert.match(await frame({ limits: native }), /5h 剩余 89% \(2m\) │ 7d 剩余 72% \(10m\)/u);
});

test('cold account quotas stay hidden for a restored, custom, or unconfirmed session', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud cold quota scope '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [label, options, config, recordedInitially] of [
    ['restored thread', { startsNewThread: false }, {}],
    ['account disabled', { useAccountQuota: false }, {}],
    ['custom provider', {}, { model_provider: 'local' }],
    ['custom endpoint', {}, { chatgpt_base_url: 'https://local.example/backend-api' }],
    ['unreadable config', {}, undefined],
    ['previously recorded custom thread', {}, {}, true],
    ['previously recorded custom thread with unavailable activity', {}, {}, true],
  ]) await t.test(label, async t => {
    let accountReads = 0;
    let threadReads = 0;
    const hud = createLaunchHud({ cwd, home: cwd, startsNewThread: true, ...options, color: false, connect: async () => ({
      close() {},
      async request(method, params) {
        if (method === 'thread/read') {
          if (recordedInitially && threadReads++ === 0) {
            return { thread: { cwd, id: params.threadId, modelProvider: 'local' } };
          }
          throw Object.assign(new Error('Codex thread/read: thread not loaded: ' + params.threadId), { code: -32600 });
        }
        if (method === 'thread/turns/list' && label.endsWith('unavailable activity')) throw new Error('Unavailable activity');
        if (method === 'config/read') return { config };
        if (method === 'account/rateLimits/read') {
          accountReads++;
          return { rateLimits: { limitId: 'codex', primary: {
            usedPercent: 1, windowDurationMins: 10_080, resetsAt: Math.floor(Date.now() / 1000) + 60,
          } } };
        }
        return { data: [] };
      },
    }) });
    t.after(hud.close);
    const native = { threadId: firstThread, limits: { weekly: { remainingPercent: 69 } } };
    await hud.readHud(native);
    await nextTick();
    await hud.readHud(native);
    await nextTick();
    await hud.readHud(native);
    await nextTick();
    assert.match(await hud.readHud(native), /7d 剩余 69%\n/u);
    assert.equal(accountReads, 0);
  });
});

test('the interactive footer cannot relabel another account quota or leak it to a custom provider', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud quota source '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const deferred = Promise.withResolvers();
  let accountReads = 0;
  const hud = createLaunchHud({ cwd, home: cwd, color: false, connect: async () => ({
    close() {},
    async request(method, params) {
      if (method === 'thread/read') return { thread: {
        id: params.threadId, cwd, modelProvider: params.threadId === firstThread ? 'openai' : 'local',
      } };
      if (method === 'config/read') return { config: { model_provider: 'openai' } };
      if (method === 'account/rateLimits/read') {
        accountReads++;
        return deferred.promise;
      }
      return { data: [] };
    },
  }) });
  t.after(hud.close);
  const input = {
    model: 'fixture', contextPercent: 0, columns: 96, rows: 12,
    limits: { fiveHour: { remainingPercent: 89 }, weekly: { remainingPercent: 90 } },
  };
  assert.match(await hud.readHud({ ...input, threadId: firstThread }), /5h 剩余 89%/u);
  await nextTick();
  assert.match(await hud.readHud({ ...input, threadId: firstThread }), /7d 剩余 90%/u);
  assert.equal(accountReads, 1);
  const resetsAt = Math.floor(Date.now() / 1000) + 1199;
  deferred.resolve({ rateLimitsByLimitId: {
    codex: { limitName: 'Codex', primary: { usedPercent: 76, windowDurationMins: 300, resetsAt } },
    spark: { limitName: 'Spark', primary: { usedPercent: 43, windowDurationMins: 300 } },
  } });
  await nextTick();
  const grouped = await hud.readHud({ ...input, threadId: firstThread });
  assert.match(grouped, /Codex 5h .*24% \(20m\)\nSpark 5h .*57%/u);
  assert.doesNotMatch(grouped, /(?:5h|7d) 剩余/u);
  const local = await hud.readHud({ ...input, threadId: secondThread });
  assert.match(local, /5h 剩余 89% │ 7d 剩余 90%/u);
  assert.doesNotMatch(local, /^(?:Codex|Spark) 5h /mu);
  assert.equal(accountReads, 1);
});

test('the HUD prefers the selected Git worktree over the branch saved in the thread', async t => {
  if (spawnSync('git', ['--version']).error?.code === 'ENOENT') return t.skip('Git is unavailable');
  const root = await mkdtemp(join(tmpdir(), 'codex-hud isolated git '));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repo = join(root, 'repo');
  const linked = join(root, 'linked worktree');
  await mkdir(repo);
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  };
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', `core.hooksPath=${join(root, 'no-hooks')}`, 'commit', '--quiet', '--allow-empty', '-m', 'Initial fixture');
  git(repo, 'worktree', 'add', '--quiet', '-b', 'hud-fixture', linked);
  const coldFrame = async cwd => {
    const hud = createLaunchHud({ cwd, connect: async () => { throw new Error('App-server unavailable'); }, color: false });
    try {
      return await hud.readHud({ model: 'fixture', contextPercent: 0 });
    } finally {
      hud.close();
    }
  };
  assert.match(await coldFrame(repo), /repo git:\(main\)/u);
  assert.match(await coldFrame(linked), /linked worktree git:\(hud-fixture\)/u);

  t.mock.timers.enable({ apis: ['Date'] });
  let workspace = linked;
  const hud = createLaunchHud({ cwd: linked, home: root, color: false, connect: async () => ({
    close() {},
    async request(method) {
      if (method === 'thread/read') return { thread: {
        id: firstThread, cwd: workspace, gitInfo: { branch: 'recorded-branch' },
      } };
      if (method === 'config/read') return { config: { project_doc_max_bytes: 0 } };
      return { data: [] };
    },
  }) });
  t.after(hud.close);
  const frame = extra => hud.readHud({ threadId: firstThread, model: 'fixture', contextPercent: 0, ...extra });
  await frame();
  await nextTick();
  assert.match(await frame(), /linked worktree git:\(hud-fixture\)/u);
  git(linked, 'switch', '--quiet', '-c', 'fixture-switched');
  t.mock.timers.tick(15_001);
  assert.match(await frame(), /linked worktree git:\(fixture-switched\)/u);
  git(linked, 'checkout', '--quiet', '--detach', 'HEAD');
  t.mock.timers.tick(15_001);
  assert.doesNotMatch(await frame(), /git:\(/u);
  workspace = root;
  assert.doesNotMatch(await frame(), /git:\(/u);
  workspace = join(root, 'workspace-unavailable');
  assert.match(await frame(), /git:\(recorded-branch\)/u);
});

test('preserves local rollout metrics and output rate when readTurn fails for a resolved thread', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hud fallback rollout '));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const launchCwd = join(cwd, 'launch-workspace');
  const threadWorkspace = join(cwd, 'remote-thread-workspace');
  await mkdir(launchCwd, { recursive: true });
  const sessions = join(cwd, 'sessions', '2026', '11', '20');
  await mkdir(sessions, { recursive: true });
  const path = join(sessions, `rollout-2026-11-20T11-29-36-${firstThread}.jsonl`);
  const epoch = Date.UTC(2026, 10, 20, 11, 29, 36);
  const record = (ms, type, payload) => JSON.stringify({ timestamp: new Date(epoch + ms).toISOString(), type, payload });
  const event = (ms, type, payload) => record(ms, 'event_msg', { type, ...payload });
  const text = 'Fallback answer';
  await writeFile(path, [
    JSON.stringify({ type: 'session_meta', payload: { id: firstThread } }),
    event(0, 'task_started', { turn_id: 'turn-1' }),
    event(1000, 'item_completed', {
      turn_id: 'turn-1', thread_id: firstThread, started_at_ms: epoch + 500, completed_at_ms: epoch + 1000,
      item: { type: 'AgentMessage', id: 'msg-1', content: [{ type: 'Text', text }] },
    }),
    record(1001, 'response_item', {
      type: 'message', role: 'assistant', status: 'completed', id: 'msg-1',
      content: [{ type: 'output_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    }),
    record(1005, 'token_usage_record', {
      thread_id: firstThread, turn_id: 'turn-1', response_id: 'resp-1',
      usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 25, reasoning_output_tokens: 5 },
    }),
    event(1010, 'token_count', {
      info: { total_token_usage: { total_tokens: 5400, input_tokens: 5300, output_tokens: 100, cached_input_tokens: 2000 } },
      rate_limits: { plan_type: 'enterprise' },
    }),
    '',
  ].join('\n'));

  let accountUsageReads = 0;
  let configReads = 0;
  let usageRequested = Promise.withResolvers();
  let holdTurns;
  const hud = createLaunchHud({ cwd: launchCwd, home: cwd, useAccountQuota: false, color: false, connect: async () => ({
    close() {},
    async request(method, params) {
      if (method === 'thread/read') {
        if (params.threadId === secondThread) throw new Error('missing second thread');
        return { thread: {
          id: firstThread, cwd: threadWorkspace, path, model: 'gpt-6.2-thread', reasoningEffort: 'xhigh',
          gitInfo: { branch: 'thread-branch' }, historyMode: 'paginated',
        } };
      }
      if (method === 'thread/turns/list') {
        if (holdTurns) return holdTurns.promise;
        await usageRequested.promise;
        await rm(path);
        throw new Error('missing source rollout');
      }
      if (method === 'account/usage/read') {
        accountUsageReads++;
        usageRequested.resolve();
        return {};
      }
      if (method === 'config/read') {
        configReads++;
        return { config: { project_doc_max_bytes: 0 } };
      }
      return { data: [] };
    },
  }) });
  t.after(hud.close);

  await hud.readHud({ threadId: firstThread, columns: 100, rows: 12 });
  await nextTick();
  const output = await hud.readHud({ threadId: firstThread, columns: 100, rows: 12 });
  assert.match(output, /^\[gpt-6\.2-thread ◕ xhigh\].*remote-thread-workspace git:\(thread-branch\)/mu);
  assert.match(output, /^词元 5\.4k \(输入 3\.3k, 输出 100, 缓存 2k\) │ 最近输出 ≈40\.0 tok\/s$/m);
  assert.equal(accountUsageReads, 1);
  assert.equal(configReads, 1);

  const switched = await hud.readHud({ threadId: secondThread, columns: 100, rows: 12 });
  assert.match(switched, /launch-workspace/u);
  assert.doesNotMatch(switched, /gpt-6\.2-thread|xhigh|thread-branch|remote-thread-workspace|5\.4k|40\.0 tok\/s/u);

  holdTurns = Promise.withResolvers();
  const aborted = new AbortController();
  const pending = hud.readHud({ threadId: firstThread, signal: aborted.signal, columns: 100, rows: 12 });
  await nextTick();
  aborted.abort();
  holdTurns.reject(new Error('missing source rollout'));
  assert.equal(await pending, '');
  assert.equal(await hud.readHud({ threadId: firstThread, signal: aborted.signal, columns: 100, rows: 12 }), '');
});
