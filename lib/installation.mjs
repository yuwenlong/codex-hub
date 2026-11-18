import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const STATUS_LINE = Object.freeze([
  'model-with-reasoning',
  'project-name',
  'git-branch',
  'context-used',
  'five-hour-limit',
  'weekly-limit',
  'task-progress',
]);

const keyPath = 'tui.status_line';
const backupName = 'codex-hub-statusline.json';
const isStatusLine = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function locationKey(path) {
  const normalized = normalize(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function readConfig(client, home, cwd) {
  const filePath = join(home, 'config.toml');
  const { layers, config } = await client.request('config/read', { includeLayers: true, cwd });
  const user = layers?.find(layer =>
    layer.name.type === 'user' && locationKey(layer.name.file) === locationKey(filePath),
  );
  if (!user || typeof user.version !== 'string') throw new Error('Codex did not report the expected user config layer.');
  const statusLine = user.config?.tui?.status_line ?? null;
  if (statusLine !== null && !isStatusLine(statusLine)) throw new Error('Invalid tui.status_line in the Codex user config.');
  return { filePath, version: user.version, statusLine, effective: config?.tui?.status_line ?? null };
}

async function readBackup(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let backup;
  try {
    backup = JSON.parse(raw);
  } catch {
    throw new Error('Codex Hub status line backup is invalid: ' + path);
  }
  if (backup?.version !== 1 || !isStatusLine(backup.applied)
    || (backup.original !== null && !isStatusLine(backup.original))) {
    throw new Error('Codex Hub status line backup is invalid: ' + path);
  }
  return backup;
}

async function writeBackup(path, original) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    const backup = JSON.stringify({ version: 1, original, applied: STATUS_LINE });
    await writeFile(temp, backup + '\n', { flag: 'wx', mode: 0o600, flush: true });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function withLock(home, action) {
  const backupPath = join(home, backupName);
  const lockPath = backupPath + '.lock';
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // shortcut: forced interruption may leave an empty lock, remove it after any installer has exited.
    throw new Error('A Codex Hub configuration change is in progress. If all installers have exited, remove the empty lock directory: ' + lockPath);
  }
  try {
    return await action(backupPath);
  } finally {
    await rmdir(lockPath);
  }
}

async function setStatusLine(client, config, value) {
  const response = await client.request('config/value/write', {
    filePath: config.filePath,
    keyPath,
    value,
    mergeStrategy: 'replace',
    expectedVersion: config.version,
  });
  if (!['ok', 'okOverridden'].includes(response?.status)) {
    throw new Error('Codex did not confirm the status line change.');
  }
}

export async function install(client, home) {
  return withLock(home, async backupPath => {
    const config = await readConfig(client, home);
    const backup = await readBackup(backupPath);
    if (isDeepStrictEqual(config.statusLine, STATUS_LINE) || isDeepStrictEqual(config.statusLine, backup?.applied)) {
      return { changed: false, statusLine: config.statusLine };
    }
    await writeBackup(backupPath, config.statusLine);
    await setStatusLine(client, config, STATUS_LINE);
    return { changed: true, statusLine: STATUS_LINE };
  });
}

export async function uninstall(client, home) {
  return withLock(home, async backupPath => {
    const backup = await readBackup(backupPath);
    const config = await readConfig(client, home);
    if (!backup) return { changed: false, statusLine: config.statusLine };

    const changed = isDeepStrictEqual(config.statusLine, backup.applied);
    if (changed) await setStatusLine(client, config, backup.original);
    await rm(backupPath);
    return {
      changed,
      statusLine: changed ? backup.original : config.statusLine,
      ...(!changed && { preserved: true }),
    };
  });
}

export async function doctor(client, home) {
  const config = await readConfig(client, home, process.cwd());
  const backup = await readBackup(join(home, backupName));
  return {
    statusLine: config.effective,
    installed: isDeepStrictEqual(config.effective, STATUS_LINE) || isDeepStrictEqual(config.effective, backup?.applied),
    overridden: !isDeepStrictEqual(config.statusLine, config.effective),
  };
}
