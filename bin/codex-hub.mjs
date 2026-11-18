#!/usr/bin/env node
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const usage = `Codex Hub

node ./bin/codex-hub.mjs <命令>

  install    配置 Codex CLI 原生状态栏
  uninstall 还原安装前的状态栏设置
  doctor     检查当前状态栏设置
  preview    离线预览活动视图
  status     查看活动快照
  watch      持续查看活动，按 Ctrl+C 退出

status 和 watch 接受 --cwd <目录> 或 --thread <会话 ID>。
全局选项为 --help 和 --version。`;

const commands = new Set(['install', 'uninstall', 'doctor', 'preview', 'status', 'watch']);
const terminal = process.stdout.isTTY && process.env.TERM !== 'dumb';
const noFooterToRestore = '当前无需还原状态栏设置。';

function outputOptions() {
  return { color: Boolean(terminal && process.stdout.hasColors()), width: process.stdout.columns };
}

function printDoctor({ installed, overridden, statusLine } = {}) {
  console.log(installed ? 'Codex Hub 状态栏已配置。' : 'Codex Hub 状态栏待配置。');
  console.log(`tui.status_line = ${statusLine == null ? '（未设置）' : JSON.stringify(statusLine)}`);
  if (overridden) console.log('当前生效的状态栏由其他配置层覆盖。');
}

async function watch(connect, readFrame) {
  const stopSignal = new AbortController();
  const { signal } = stopSignal;
  let client;
  const restore = () => process.stdout.write('\u001b[?1049l');
  const stop = () => {
    if (signal.aborted) return;
    stopSignal.abort();
    restore();
    client?.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.write('\u001b[?1049h');
  try {
    while (!signal.aborted) {
      client ??= await connect(signal);
      if (signal.aborted) break;
      const frame = await readFrame(client);
      if (signal.aborted) break;
      process.stdout.write(`\u001b[H\u001b[J${frame}\n`);
      await delay(2500, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    if (!signal.aborted) restore();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    client?.close();
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      cwd: { type: 'string' },
      thread: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (values.help || process.argv.length === 2) {
    console.log(usage);
    return;
  }
  if (values.version) {
    const metadata = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    console.log(JSON.parse(metadata).version);
    return;
  }
  if (positionals.length !== 1 || !commands.has(command)) throw new Error('请指定一个有效命令。运行 --help 查看用法。');

  const isActivity = command === 'status' || command === 'watch';
  const hasQuery = values.cwd !== undefined || values.thread !== undefined;
  if (hasQuery && !isActivity) throw new Error('--cwd 和 --thread 仅用于 status 或 watch。');
  if (values.cwd === '' || values.thread?.trim() === '') throw new Error('--cwd 和 --thread 需要非空值。');

  if (command === 'preview') {
    const { previewActivity, renderActivity } = await import('../lib/activity.mjs');
    console.log(renderActivity(previewActivity(), outputOptions()));
    return;
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  if (values.cwd !== undefined && !(await stat(cwd)).isDirectory()) throw new Error('--cwd 必须指向目录。');
  const configuredHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  if (command === 'install') await mkdir(configuredHome, { recursive: true, mode: 0o700 });
  const locateHome = () => realpath(configuredHome).catch(error => {
    if (error.code !== 'ENOENT' || command === 'install') throw error;
    return null;
  });
  const home = await locateHome();
  const connect = async (targetHome) => {
    const { openClient } = await import('../lib/app-server.mjs');
    return openClient({ cwd, env: { ...process.env, CODEX_HOME: targetHome }, experimentalApi: isActivity });
  };

  if (isActivity) {
    const threadId = values.thread?.trim() ?? (values.cwd === undefined ? process.env.CODEX_THREAD_ID?.trim() : undefined);
    if (home === null && threadId) throw new Error('无法读取指定的 Codex 会话。');
    const { readActivity, renderActivity } = await import('../lib/activity.mjs');
    const readFrame = async (client) => {
      const snapshot = client ? await readActivity(client, { cwd, threadId }) : { workspace: '当前工作区' };
      return renderActivity(snapshot, outputOptions());
    };
    if (command === 'watch' && terminal) {
      await watch(async (signal) => {
        const targetHome = home ?? await locateHome();
        if (targetHome !== null && !signal.aborted) return connect(targetHome);
      }, readFrame);
    } else {
      const client = home === null ? null : await connect(home);
      try {
        console.log(await readFrame(client));
      } finally {
        client?.close();
      }
    }
    return;
  }

  if (home === null) {
    if (command === 'doctor') printDoctor();
    else console.log(noFooterToRestore);
    return;
  }

  const client = await connect(home);
  try {
    const { install, uninstall, doctor } = await import('../lib/installation.mjs');
    if (command === 'install') {
      const { changed } = await install(client, home);
      console.log(changed ? '已配置 Codex Hub 状态栏。请重新打开 Codex。' : 'Codex Hub 状态栏已配置。');
    } else if (command === 'uninstall') {
      const { changed, preserved } = await uninstall(client, home);
      if (changed) console.log('已还原安装前的状态栏。请重新打开 Codex。');
      else if (preserved) console.log('已卸载。继续使用您后来设置的状态栏。');
      else console.log(noFooterToRestore);
    } else {
      printDoctor(await doctor(client, home));
    }
  } finally {
    client.close();
  }
}

try {
  await main();
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  console.error(`codex-hub: ${message}`);
  process.exitCode = 1;
}
