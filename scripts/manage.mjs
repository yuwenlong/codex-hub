import {
  constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundledDependencyFiles, dependencyLicenses, hostDependencyFiles } from '../lib/runtime-deps.mjs';
import { updateShellIntegration } from '../lib/shell.mjs';

const source = resolve(fileURLToPath(new URL('../', import.meta.url)));
const cli = 'bin/codex-hub.mjs';
const marker = '.codex-hub-managed';
const owner = 'codex-hub-runtime-v1';
const transactionName = '.codex-hub-transaction.json';
const stagingPrefix = '.codex-hub-runtime-';
const folders = ['bin', 'lib', 'scripts'];
const baseFiles = ['package.json', 'LICENSE', cli, 'scripts/manage.mjs'];
const required = [
  ...baseFiles, 'lib/activity.mjs', 'lib/app-server.mjs', 'lib/hud-metrics.mjs', 'lib/installation.mjs',
  'lib/launch.mjs', 'lib/runtime-deps.mjs', 'lib/shell.mjs', 'lib/terminal-host.mjs', ...hostDependencyFiles(),
];
const library = /^lib\/[\w.-]+\.mjs$/u;
const dependencyFiles = new Set([...bundledDependencyFiles, ...dependencyLicenses]);
const managedFile = file => baseFiles.includes(file) || library.test(file) || dependencyFiles.has(file);
const inspect = path => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const fileKey = name => process.platform === 'win32' ? name.toLowerCase() : name;

function conflict(path) {
  return new Error(`路径已有非 Codex Hub 运行文件，请移走冲突路径后重试：${path}`);
}

function isManagedFileList(files) {
  return Array.isArray(files) && files.every(file => typeof file === 'string' && managedFile(file))
    && new Set(files.map(fileKey)).size === files.length
    && (!files.length || baseFiles.every(file => files.includes(file)));
}

function ownedFiles(runtime) {
  if (!inspect(runtime)?.isDirectory()) return null;
  const path = join(runtime, marker);
  const entry = inspect(path);
  if (!entry) return null;
  if (!entry.isFile()) throw conflict(path);

  const [header, ...files] = readFileSync(path, 'utf8').trimEnd().split('\n');
  if (header !== owner || !isManagedFileList(files)) {
    throw new Error(`无法验证 Codex Hub 安装标记：${path}`);
  }
  return files;
}

function writeMarker(directory, files) {
  writeFileSync(join(directory, marker), [owner, ...files, ''].join('\n'), { flag: 'wx' });
}

function packageFileList() {
  for (const folder of folders) {
    if (!inspect(join(source, folder))?.isDirectory()) throw new Error(`安装包缺少目录：${folder}`);
  }
  const files = new Set(required);
  for (const name of readdirSync(join(source, 'lib'))) {
    if (name.endsWith('.mjs')) files.add(`lib/${name}`);
  }
  return [...files];
}

function managedDirectories(files) {
  const directories = new Set(folders);
  for (const file of files) {
    for (let parent = posix.dirname(file); parent !== '.'; parent = posix.dirname(parent)) {
      directories.add(parent);
    }
  }
  return [...directories].sort();
}

function copyPackage(next, files) {
  const directories = managedDirectories(files);
  for (const folder of directories) {
    const from = join(source, folder);
    if (!inspect(from)?.isDirectory()) throw new Error(`安装包缺少有效的目录：${folder}`);
    mkdirSync(join(next, folder));
  }
  for (const file of files) {
    const path = join(source, file);
    if (!managedFile(file) || !inspect(path)?.isFile()) {
      throw new Error(`安装包缺少有效的运行文件：${file}`);
    }
    copyFileSync(path, join(next, file), constants.COPYFILE_EXCL);
  }
  writeMarker(next, files);
}

function listExtras(runtime, files, next, relatedFiles = []) {
  const managed = new Set(files.map(fileKey));
  const directories = managedDirectories([...files, ...relatedFiles]);
  const directoryKeys = new Set(directories.map(fileKey));
  const extras = [];
  for (const folder of ['', ...directories]) {
    const path = join(runtime, folder);
    const entry = inspect(path);
    if (!entry) continue;
    if (!entry.isDirectory()) throw conflict(path);
    for (const name of readdirSync(path)) {
      const file = folder ? `${folder}/${name}` : name;
      const key = fileKey(file);
      if (key === marker || directoryKeys.has(key)) continue;
      if (managed.has(key)) {
        if (!inspect(join(runtime, file))?.isFile()) throw conflict(join(runtime, file));
      } else {
        if (next && inspect(join(next, file))) throw conflict(join(runtime, file));
        extras.push(file);
      }
    }
  }
  return extras;
}

async function configure(directory, home, command, { publish, upgrade = false, expectedBackupId } = {}) {
  const libraryDirectory = join(directory, 'lib');
  if (!inspect(libraryDirectory)?.isDirectory()) throw conflict(libraryDirectory);
  const installationModule = join(libraryDirectory, 'installation.mjs');
  const appServerModule = join(libraryDirectory, 'app-server.mjs');
  for (const file of [installationModule, appServerModule, join(directory, 'package.json')]) {
    if (!inspect(file)?.isFile()) throw conflict(file);
  }
  const [installation, { openClient }] = await Promise.all([
    import(pathToFileURL(installationModule)),
    import(pathToFileURL(appServerModule)),
  ]);
  let connection;
  const client = {
    async request(method, params) {
      connection ??= await openClient({ env: { ...process.env, CODEX_HOME: home } });
      return connection.request(method, params);
    },
  };
  try {
    const result = await installation[command](client, home, {
      upgrade, publish: publish ?? (() => {}), trackBackup: command === 'uninstall' && Boolean(publish), expectedBackupId,
    });
    if (result.changed) {
      console.log(command === 'install'
        ? '已配置 Codex Hub 状态栏。请重新打开 Codex。'
        : '已还原安装前的状态栏。请重新打开 Codex。');
    } else if (result.preserved) {
      console.log('继续使用您后来设置的状态栏。');
    }
  } finally {
    connection?.close();
  }
}

function directoryId(path) {
  const entry = inspect(path);
  if (!entry) return null;
  if (!entry.isDirectory()) throw conflict(path);
  return `${entry.dev}:${entry.ino}`;
}

function moveToUnoccupiedPath(from, to) {
  if (inspect(to)) throw conflict(to);
  renameSync(from, to);
}

function removeTransactionScratch(staging) {
  const path = join(staging, 'transaction.json');
  const entry = inspect(path);
  if (!entry) return;
  if (!entry.isFile()) throw conflict(path);
  unlinkSync(path);
}

function writeTransaction(home, record) {
  const path = join(home, transactionName);
  const staging = join(home, record.staging);
  const temp = join(staging, 'transaction.json');
  if (!validTransaction(record)) {
    throw new Error(`无法验证 Codex Hub 事务：${path}`);
  }
  const preceding = record.phase === 'switching' ? 'preparing' : 'switching';
  if (record.phase !== 'preparing') {
    const existing = readTransaction(home);
    if (existing?.stageId !== record.stageId || existing.phase !== preceding) throw conflict(path);
  }
  removeTransactionScratch(staging);
  writeFileSync(temp, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  if (record.phase === 'preparing') moveToUnoccupiedPath(temp, path);
  else renameSync(temp, path);
}

function removeEmptyDirectory(path) {
  if (!inspect(path)?.isDirectory()) return;
  try {
    rmdirSync(path);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function discardRuntime(directory, files, relatedFiles = []) {
  if (!inspect(directory)?.isDirectory()) return;
  const directories = managedDirectories([...files, ...relatedFiles]);
  const verified = new Set(['.']);
  for (const folder of directories) {
    if (verified.has(posix.dirname(folder)) && inspect(join(directory, folder))?.isDirectory()) verified.add(folder);
  }
  for (const file of [...files, marker]) {
    const path = join(directory, file);
    if (verified.has(posix.dirname(file)) && inspect(path)?.isFile()) unlinkSync(path);
  }
  for (const folder of directories.reverse()) {
    if (verified.has(folder)) removeEmptyDirectory(join(directory, folder));
  }
  removeEmptyDirectory(directory);
}

function validTransaction(record) {
  const validId = id => typeof id === 'string' && /^\d+:\d+$/u.test(id);
  const hasBackupId = record?.command === 'uninstall' && record.phase !== 'preparing';
  const validBackupId = id => typeof id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(id);
  return record?.version === 1 && typeof record.staging === 'string'
    && /^\.codex-hub-runtime-[A-Za-z0-9]{6}$/u.test(record.staging)
    && ['install', 'uninstall'].includes(record.command)
    && ['preparing', 'switching', 'committed'].includes(record.phase)
    && isManagedFileList(record.files) && Boolean(record.files.length) === (record.command === 'install')
    && (hasBackupId ? record.backupId === null || validBackupId(record.backupId) : record.backupId === undefined)
    && validId(record.stageId) && [record.original, record.candidate].every(id => id === null || validId(id))
    && new Set([record.stageId, record.original, record.candidate]).size === 3
    && (record.phase === 'preparing' ? record.original === null && record.candidate !== null
      : record.command === 'install' ? record.candidate !== null : record.original !== null);
}

function readTransaction(home) {
  const path = join(home, transactionName);
  const entry = inspect(path);
  if (!entry) return null;
  const invalid = () => new Error(`无法验证 Codex Hub 事务：${path}`);
  if (!entry.isFile()) throw invalid();
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw invalid();
  }
  if (!validTransaction(record) || directoryId(join(home, record.staging)) !== record.stageId) throw invalid();
  return record;
}

function restoreRuntime(runtime, previous, next, original, candidate, files) {
  const originalFiles = original ? ownedFiles(original) : [];
  const candidateFiles = candidate ? ownedFiles(candidate) : null;
  if (originalFiles === null) throw conflict(original);
  if (candidate && (candidateFiles?.join('\n') !== files.join('\n'))
      && (candidateFiles || original === previous || candidate === runtime)) throw conflict(candidate);

  if (original) listExtras(original, originalFiles, undefined, files);
  const extras = candidateFiles && candidate ? listExtras(candidate, candidateFiles, original, originalFiles) : [];
  for (const file of extras) {
    if (!original) throw conflict(join(candidate, file));
    const destination = dirname(join(original, file));
    if (!inspect(destination)?.isDirectory()) throw conflict(destination);
  }

  if (candidate === runtime) moveToUnoccupiedPath(runtime, next);
  for (const file of extras) moveToUnoccupiedPath(join(next, file), join(original, file));
  if (original === previous) moveToUnoccupiedPath(previous, runtime);
  discardRuntime(next, files, originalFiles);
}

async function recoverRuntimeChange(home, record, previous, next, rollback) {
  const { original, candidate, files } = record;
  const runtime = join(home, 'codex-hub');
  const current = directoryId(runtime);
  const oldLocation = directoryId(previous);
  const newLocation = directoryId(next);
  if (current && current !== original && current !== candidate) throw conflict(runtime);
  if (oldLocation && (oldLocation !== original || current === original)) throw conflict(previous);
  if (newLocation && (newLocation !== candidate || current === candidate)) throw conflict(next);

  const published = current === candidate && !newLocation;
  let committed = record.phase === 'committed';
  if (!rollback && !committed && record.command === 'uninstall' && published && oldLocation === original) {
    if (current && ownedFiles(runtime)?.join('\n') !== files.join('\n')) throw conflict(runtime);
    await configure(source, home, 'uninstall', { expectedBackupId: record.backupId });
    writeTransaction(home, { ...record, phase: 'committed' });
    committed = true;
  }
  if (committed) {
    if (!published || (current && ownedFiles(runtime)?.join('\n') !== files.join('\n'))) throw conflict(runtime);
    if (oldLocation) discardRuntime(previous, ownedFiles(previous) ?? [], files);
    return;
  }

  const originalPath = oldLocation ? previous : current && current === original ? runtime : null;
  const candidatePath = newLocation ? next : current && current === candidate ? runtime : null;
  if (original && !originalPath) throw conflict(previous);
  if (candidate && !candidatePath && originalPath === previous) throw conflict(next);
  restoreRuntime(runtime, previous, next, originalPath, candidatePath, files);
}

async function recoverTransaction(home, { rollback = false } = {}) {
  const record = readTransaction(home);
  if (!record) return;
  const staging = join(home, record.staging);
  const previous = join(staging, 'previous');
  const next = join(staging, 'next');
  if (record.phase === 'preparing') {
    const candidate = directoryId(next);
    if (inspect(previous) || (candidate && candidate !== record.candidate)) throw conflict(staging);
    discardRuntime(next, record.files);
  } else {
    await recoverRuntimeChange(home, record, previous, next, rollback);
  }

  if (inspect(previous) || inspect(next)) console.error(`暂存目录中的其他文件保存在 ${staging}。`);
  removeTransactionScratch(staging);
  unlinkSync(join(home, transactionName));
  removeEmptyDirectory(staging);
}

async function manage(home, command) {
  await recoverTransaction(home);
  const runtime = join(home, 'codex-hub');
  const files = ownedFiles(runtime);
  const installing = command === 'install';
  if (installing && files === null && inspect(runtime)) throw conflict(runtime);
  if (!installing && !files?.length) {
    await configure(source, home, command);
    console.log('Codex Hub 已卸载。');
    return;
  }

  const stagedFiles = installing ? packageFileList() : [];
  const staging = mkdtempSync(join(home, stagingPrefix));
  const next = join(staging, 'next');
  const previous = join(staging, 'previous');
  let record;
  try {
    mkdirSync(next, { mode: 0o700 });
    const preparing = {
      version: 1, phase: 'preparing', command, staging: basename(staging), stageId: directoryId(staging),
      original: null, candidate: directoryId(next), files: stagedFiles,
    };
    writeTransaction(home, preparing);
    record = preparing;
    if (installing) copyPackage(next, stagedFiles);
    await configure(installing ? next : source, home, command, {
      upgrade: installing && Boolean(files?.length),
      publish(backupId) {
        const extras = files === null ? [] : listExtras(runtime, files, next, stagedFiles);
        if (!installing && !extras.length) rmdirSync(next);
        else if (!installing) writeMarker(next, []);
        const original = directoryId(runtime);
        if (files === null ? original !== null : ownedFiles(runtime)?.join('\n') !== files.join('\n')) {
          throw conflict(runtime);
        }
        const candidate = directoryId(next);
        const switching = { ...record, phase: 'switching', original, candidate, backupId };
        writeTransaction(home, switching);
        record = switching;
        if (original) moveToUnoccupiedPath(runtime, previous);
        for (const file of extras) {
          const destination = join(next, file);
          mkdirSync(dirname(destination), { recursive: true });
          moveToUnoccupiedPath(join(previous, file), destination);
        }
        if (candidate) moveToUnoccupiedPath(next, runtime);
      },
    });
  } catch (error) {
    if (record) {
      try {
        await recoverTransaction(home, { rollback: true });
      } catch (rollbackError) {
        throw new Error(`${error.message}。恢复原运行目录失败：${rollbackError.message}。事务保存在 ${staging}。`, { cause: error });
      }
    }
    throw error;
  } finally {
    if (!record) {
      removeTransactionScratch(staging);
      removeEmptyDirectory(next);
      removeEmptyDirectory(staging);
    }
  }
  writeTransaction(home, { ...record, phase: 'committed' });
  await recoverTransaction(home);
  console.log(installing ? `Codex Hub 已安装至 ${runtime}` : 'Codex Hub 已卸载。');
}

async function main() {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['install', 'uninstall'].includes(command)) {
    throw new Error('用法：node scripts/manage.mjs install|uninstall');
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本。');
  const configuredHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  if (command === 'install') mkdirSync(configuredHome, { recursive: true, mode: 0o700 });
  else if (!inspect(configuredHome)) return;
  const home = realpathSync(configuredHome);
  const lock = join(home, '.codex-hub-runtime.lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // shortcut: forced interruption may leave an empty lock directory.
    throw new Error(`另一项 Codex Hub 安装或卸载正在进行。确认进程已退出后可删除空锁目录：${lock}`);
  }
  try {
    await manage(home, command);
    updateShellIntegration(home, command);
  } finally {
    rmdirSync(lock);
  }
}

try {
  await main();
} catch (error) {
  console.error(`codex-hub: ${error.message.replace(/[\p{Cc}\p{Cf}]/gu, ' ')}`);
  process.exitCode = 1;
}
