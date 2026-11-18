import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

const args = ['app-server', '--listen', 'stdio://'];
const timeoutMs = 8_000;
const missingCodex = 'Codex CLI was not found on PATH. Install Codex CLI and reopen the terminal.';

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function windowsCommand(env) {
  const pathKey = Object.keys(env).sort().find(key => key.toUpperCase() === 'PATH');
  for (const entry of (env[pathKey] ?? '').split(';')) {
    const directory = entry.replace(/^"(.*)"$/u, '$1');
    if (!isAbsolute(directory)) continue;

    const binary = join(directory, 'codex.exe');
    if (await isFile(binary)) return [binary, args];

    if (!(await isFile(join(directory, 'codex.cmd')))) continue;
    // Use the official npm launcher directly so paths never pass through cmd.exe.
    for (const root of [join(directory, 'node_modules'), join(directory, '..')]) {
      const launcher = join(root, '@openai', 'codex', 'bin', 'codex.js');
      if (await isFile(launcher)) return [process.execPath, [launcher, ...args]];
    }
  }
  throw new Error(missingCodex);
}

function rpcError(method, error) {
  const detail = typeof error.message === 'string'
    ? stripVTControlCharacters(error.message).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 400)
    : 'Request failed';
  return Object.assign(new Error('Codex ' + method + ': ' + detail), { code: error.code });
}

export async function openClient({ cwd = process.cwd(), env = process.env, experimentalApi = false } = {}) {
  const [command, argv] = process.platform === 'win32' ? await windowsCommand(env) : ['codex', args];
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const child = spawn(command, argv, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 0;
  let closed;

  function stop(error) {
    if (closed) return;
    closed = error;
    lines.close();
    child.stdin.end();

    const rejectPending = () => {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      pending.clear();
    };
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      rejectPending();
      return;
    }
    // A caller may release its config lock when the request settles.
    const kill = setTimeout(() => child.kill('SIGKILL'), 500);
    kill.unref();
    child.once('exit', () => {
      clearTimeout(kill);
      rejectPending();
    });
  }

  child.on('error', error => stop(new Error(
    error.code === 'ENOENT' ? missingCodex : 'Unable to start Codex app-server: ' + error.message,
  )));
  child.stdin.on('error', () => stop(new Error('Codex app-server input closed.')));
  child.once('close', (code, signal) => {
    stop(new Error('Codex app-server exited (' + (signal ?? code) + ').'));
  });
  lines.on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stop(new Error('Codex app-server returned an invalid JSON response.'));
      return;
    }
    const request = pending.get(message?.id);
    if (!request || message.method) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(rpcError(request.method, message.error));
    else request.resolve(message.result);
  });

  function request(method, params) {
    if (closed) return Promise.reject(closed);
    const id = ++nextId;
    const line = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop(new Error('Codex ' + method + ' timed out.'));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      child.stdin.write(line);
    });
  }

  const close = () => stop(new Error('Codex app-server client closed.'));
  try {
    const initialize = { clientInfo: { name: 'codex_hub', title: 'Codex Hub', version } };
    if (experimentalApi) initialize.capabilities = { experimentalApi: true };
    await request('initialize', initialize);
    child.stdin.write('{"method":"initialized"}\n');
    return { request, close };
  } catch (error) {
    close();
    throw error;
  }
}
