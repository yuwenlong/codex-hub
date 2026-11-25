import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

const appServerArgs = ['app-server', '--listen', 'stdio://'];
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
    if (await isFile(binary)) return [binary, []];

    if (!(await isFile(join(directory, 'codex.cmd')))) continue;
    // Use the official npm launcher directly so paths never pass through cmd.exe.
    for (const root of [join(directory, 'node_modules'), join(directory, '..')]) {
      const launcher = join(root, '@openai', 'codex', 'bin', 'codex.js');
      if (await isFile(launcher)) return [process.execPath, [launcher]];
    }
  }
  throw new Error(missingCodex);
}

export async function resolveCodex({ cwd = process.cwd(), env = process.env } = {}) {
  if (process.platform === 'win32') return windowsCommand(env);
  for (const directory of (env.PATH ?? '/usr/bin:/bin').split(':')) {
    const file = resolve(cwd, directory, 'codex');
    try {
      if (!(await isFile(file))) continue;
      await access(file, constants.X_OK);
      return [file, []];
    } catch (error) {
      if (!['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
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

export async function openClient({ cwd = process.cwd(), env = process.env, experimentalApi = false, codex, configArgs = [], signal } = {}) {
  signal?.throwIfAborted();
  const [command, launcherArgs] = codex ?? await resolveCodex({ cwd, env });
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  signal?.throwIfAborted();
  const argv = [...launcherArgs, ...configArgs, ...appServerArgs];
  const child = spawn(command, argv, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 0;
  let closed;

  function stop(error) {
    if (closed) return;
    closed = error;
    signal?.removeEventListener('abort', close);
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
  const finished = new Promise(resolve => {
    child.once('close', (code, signal) => {
      stop(new Error('Codex app-server exited (' + (signal ?? code) + ').'));
      resolve();
    });
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

  function request(method, params, { timeoutMs: optionalTimeout } = {}) {
    if (closed) return Promise.reject(closed);
    const id = ++nextId;
    const line = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Codex ' + method + ' timed out.');
        if (optionalTimeout !== undefined) {
          pending.delete(id);
          reject(error);
        } else {
          stop(error);
        }
      }, optionalTimeout ?? timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      child.stdin.write(line);
    });
  }

  const close = () => {
    stop(new Error('Codex app-server client closed.'));
    return finished;
  };
  signal?.addEventListener('abort', close, { once: true });
  try {
    const initialize = { clientInfo: { name: 'codex_hud', title: 'Codex HUD', version } };
    if (experimentalApi) initialize.capabilities = { experimentalApi: true };
    const initialized = await request('initialize', initialize);
    const codexVersion = typeof initialized?.userAgent === 'string'
      ? /^codex_hud\/(\d+\.\d+\.\d+(?:[-+][\dA-Za-z.+-]+)?)(?=\s|$)/u.exec(initialized.userAgent)?.[1]
      : undefined;
    child.stdin.write('{"method":"initialized"}\n');
    return { request, close, codexVersion, get closed() { return Boolean(closed); } };
  } catch (error) {
    await close();
    throw error;
  }
}
