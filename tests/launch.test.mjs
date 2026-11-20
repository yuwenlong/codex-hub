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
import { runCli } from './run-cli.mjs';

const firstThread = '01a1ee97-bbc8-7382-995e-b80b8d24ad74';
const secondThread = '01a1ee98-bbc8-7382-995e-b80b8d24ad75';
const require = createRequire(import.meta.url);

test('launch distinguishes interactive arguments from native commands and display overrides', () => {
  const cwd = process.cwd();
  for (const args of [[], ['resume', '--last'], ['fork', firstThread], ['--', 'exec'], ['Use the default model'], ['-mquiet', 'resume']]) {
    assert.deepEqual(interactiveOptions(args, cwd), { workspace: cwd, configArgs: [] }, JSON.stringify(args));
  }
  const args = ['--profile=team', '-C', 'workspace folder', 'resume', '-c', 'model_reasoning_effort="high"'];
  assert.deepEqual(interactiveOptions(args, cwd), {
    workspace: join(cwd, 'workspace folder'), profile: 'team', configArgs: ['--config', 'model_reasoning_effort="high"'],
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
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hub launch with spaces '));
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
    env.CODEX_HUB_TEST_NODE = process.execPath;
    env.CODEX_HUB_TEST_SCRIPT = file;
    await writeFile(file, code);
    await writeFile(executable, '#!/bin/sh\nexec "$CODEX_HUB_TEST_NODE" "$CODEX_HUB_TEST_SCRIPT" "$@"\n');
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
    const cli = fileURLToPath(new URL('../bin/codex-hub.mjs', import.meta.url));
    const signalled = spawnSync(process.execPath, [cli, 'launch', '--', 'signal-fixture'], { env, cwd, stdio: 'ignore', timeout: 5000 });
    assert.equal(signalled.signal, 'SIGTERM');
  }
});

test('an unavailable PTY dependency falls back before changing Codex arguments or input', async t => {
  const { cwd, env: fixtureEnv } = await nativeFixture(t);
  const env = { ...fixtureEnv, NODE_PATH: '', TERM: 'xterm-256color', CODEX_HUB_BYPASS: '0' };
  for (const name of ['bin', 'lib']) {
    await cp(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(cwd, name), { recursive: true });
  }
  const cli = join(cwd, 'bin', 'codex-hub.mjs');
  const nativeArgs = ['-C', 'folder with spaces', '命令 & with "quotes"'];
  const { spawn } = require('node-pty');
  async function launchFixture() {
    const pty = spawn(process.execPath, [cli, 'launch', '--', ...nativeArgs], { cwd, env, name: env.TERM, cols: 100, rows: 24 });
    let output = '';
    pty.onData(data => { output += data; });
    const exit = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => {
        pty.kill();
        reject(new Error('Codex did not exit under the terminal'));
      }, 7000);
      pty.onExit(event => { clearTimeout(timer); resolveExit(event); });
    });
    return { ...exit, output };
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
  const root = await mkdtemp(join(tmpdir(), 'codex-hub initial '));
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
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hub isolated launch '));
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
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hub weekly quota '));
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

test('the interactive footer cannot relabel another account quota or leak it to a custom provider', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-hub quota source '));
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
  assert.doesNotMatch(grouped, /5h 剩余|89%|90%/u);
  const local = await hud.readHud({ ...input, threadId: secondThread });
  assert.match(local, /5h 剩余 89% │ 7d 剩余 90%/u);
  assert.doesNotMatch(local, /Spark|24%|20m|57%/u);
  assert.equal(accountReads, 1);
});

test('the HUD prefers the selected Git worktree over the branch saved in the thread', async t => {
  if (spawnSync('git', ['--version']).error?.code === 'ENOENT') return t.skip('Git is unavailable');
  const root = await mkdtemp(join(tmpdir(), 'codex-hub isolated git '));
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
