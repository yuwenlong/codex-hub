import { execFile } from 'node:child_process';
import { constants, copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { bundledDependencyFiles, dependencyLicenses } from '../lib/runtime-deps.mjs';

const run = promisify(execFile);
const git = async (...args) => (await run('git', args, { encoding: 'buffer' })).stdout;

async function archive(output, tree) {
  const object = (await git('rev-parse', '--verify', '--end-of-options', tree)).toString().trim();
  const lock = JSON.parse(await git('show', `${object}:package-lock.json`));
  const manifest = (await git('show', `${object}:lib/runtime-deps.mjs`)).toString().replaceAll('\r\n', '\n');
  const working = readFileSync(new URL('../lib/runtime-deps.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  if (manifest !== working) {
    throw new Error('依赖文件清单与要打包的 Git 树不一致。');
  }
  for (const path of dependencyLicenses) await git('cat-file', '-e', `${object}:${path}`);
  for (const path of ['node_modules/node-pty', 'node_modules/@xterm/headless']) {
    const installed = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'));
    const pinned = lock.packages?.[path];
    if (!pinned?.integrity || pinned.version !== installed.version) {
      throw new Error(`依赖 ${path} 与锁文件不符。请先运行 npm ci --ignore-scripts。`);
    }
  }

  const added = bundledDependencyFiles.flatMap(file => {
    const path = resolve(file);
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || relative(path, realpathSync(path))) {
      throw new Error(`发行包缺少有效的依赖文件：${file}`);
    }
    return [`--prefix=codex-hub/${posix.dirname(file)}/`, `--add-file=${file}`];
  });
  const scratch = mkdtempSync(join(tmpdir(), 'codex-hub-release-'));
  try {
    const zipped = join(scratch, 'codex-hub.zip');
    await git('archive', '--format=zip', ...added, '--prefix=codex-hub/', `--output=${zipped}`, object);
    copyFileSync(zipped, output, constants.COPYFILE_EXCL);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  const [output, tree = 'HEAD', ...extra] = process.argv.slice(2);
  if (!output?.endsWith('.zip') || extra.length) {
    throw new Error('用法：node scripts/package-release.mjs <输出.zip> [Git 提交或树]');
  }
  await archive(output, tree);
} catch (error) {
  console.error(`codex-hub: ${error.message.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim()}`);
  process.exitCode = 1;
}
