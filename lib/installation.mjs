import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const legacyStatusLine = [
  'model-with-reasoning', 'project-name', 'git-branch', 'context-used',
  'five-hour-limit', 'weekly-limit', 'task-progress',
];

export const STATUS_LINE = Object.freeze([
  'model-with-reasoning',
  'project-name',
  'git-branch',
  'codex-version',
  'context-used',
  'five-hour-limit',
  'weekly-limit',
  'total-input-tokens',
  'total-output-tokens',
  'estimated-thread-cost',
  'task-progress',
]);

const keyPath = 'tui.status_line';
const backupName = 'codex-hub-statusline.json';
const isStatusLine = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const isPreset = value => isDeepStrictEqual(value, STATUS_LINE) || isDeepStrictEqual(value, legacyStatusLine);

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
  const invalid = () => new Error('Codex Hub status line backup is invalid: ' + path);
  let raw;
  try {
    if (!(await lstat(path)).isFile()) throw invalid();
    raw = await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let backup;
  try {
    backup = JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalid();
  }
  const supported = (backup?.version === 1 && backup.previous === undefined)
    || (backup?.version === 2 && backup.pending === true && isDeepStrictEqual(backup.previous, legacyStatusLine));
  if (!supported || !isStatusLine(backup.applied) || (backup.original !== null && !isStatusLine(backup.original))) {
    throw invalid();
  }
  return { backup, raw };
}

async function replaceBackup(path, raw) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, raw, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function writeBackup(path, { original, applied, pending, previous }) {
  // Older uninstallers must reject an unfinished migration before modifying it.
  const version = previous === undefined ? 1 : 2;
  return replaceBackup(path, JSON.stringify({ version, original, applied, pending, previous }) + '\n');
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

async function finishInstall(client, config, backupPath, { original, applied, previous }) {
  const changed = isDeepStrictEqual(config.statusLine, previous ?? original);
  if (changed) await setStatusLine(client, config, applied);
  await writeBackup(backupPath, { original, applied });
  return { changed, statusLine: changed ? applied : config.statusLine };
}

export async function install(client, home, { publish, upgrade = false } = {}) {
  return withLock(home, async backupPath => {
    const saved = await readBackup(backupPath);
    const backup = saved?.backup;
    const pending = backup?.pending === true;
    const legacy = isDeepStrictEqual(backup?.applied, legacyStatusLine);
    if (!pending && !legacy && (upgrade || backup)) {
      publish?.();
      return { changed: false };
    }

    const config = await readConfig(client, home);
    const ownsLegacy = legacy && isDeepStrictEqual(config.statusLine, backup.applied);
    const resumesLegacy = legacy && pending && isDeepStrictEqual(config.statusLine, backup.original);
    const migrate = ownsLegacy || resumesLegacy;
    if (pending && !migrate) {
      publish?.();
      return finishInstall(client, config, backupPath, backup);
    }
    if (!migrate && (backup || isPreset(config.statusLine))) {
      publish?.();
      return { changed: false, statusLine: config.statusLine };
    }

    // Keep the uninstall value and the upgrade source across a crash or an ambiguous write failure.
    const next = {
      original: backup ? backup.original : config.statusLine,
      applied: STATUS_LINE,
      pending: true,
      previous: ownsLegacy ? backup.applied : undefined,
    };
    await writeBackup(backupPath, next);
    try {
      publish?.();
    } catch (error) {
      if (saved) await replaceBackup(backupPath, saved.raw);
      else await rm(backupPath);
      throw error;
    }
    return finishInstall(client, config, backupPath, next);
  });
}

export async function uninstall(client, home, { publish, trackBackup = false, expectedBackupId } = {}) {
  return withLock(home, async backupPath => {
    if (expectedBackupId === null) return { changed: false };
    const saved = await readBackup(backupPath);
    const backup = saved?.backup;
    if (expectedBackupId !== undefined && backup?.uninstallId !== expectedBackupId) return { changed: false };
    const config = backup || !publish ? await readConfig(client, home) : null;
    // Legacy installers replace the backup without this marker, even when its footer values are identical.
    const uninstallId = trackBackup && backup ? randomUUID() : null;
    if (uninstallId) await replaceBackup(backupPath, JSON.stringify({ ...backup, uninstallId }) + '\n');
    try {
      publish?.(uninstallId);
      if (!backup) return { changed: false, statusLine: config?.statusLine };

      const changed = isDeepStrictEqual(config.statusLine, backup.applied)
        || (backup.previous !== undefined && isDeepStrictEqual(config.statusLine, backup.previous));
      if (changed) await setStatusLine(client, config, backup.original);
      await rm(backupPath);
      return {
        changed,
        statusLine: changed ? backup.original : config.statusLine,
        ...(!changed && { preserved: true }),
      };
    } catch (error) {
      if (uninstallId && (await readBackup(backupPath))?.backup.uninstallId === uninstallId) {
        await replaceBackup(backupPath, saved.raw);
      }
      throw error;
    }
  });
}

export async function doctor(client, home) {
  const config = await readConfig(client, home, process.cwd());
  const backup = (await readBackup(join(home, backupName)))?.backup;
  return {
    statusLine: config.effective,
    installed: isPreset(config.effective) || isDeepStrictEqual(config.effective, backup?.applied),
    overridden: !isDeepStrictEqual(config.statusLine, config.effective),
  };
}
