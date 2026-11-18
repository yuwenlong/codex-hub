import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/codex-hub.mjs', import.meta.url));

export function runCli(directory, args, options) {
  const stdoutFile = join(directory, 'stdout');
  const stderrFile = join(directory, 'stderr');
  const stdout = openSync(stdoutFile, 'w');
  let stderr;
  let result;
  try {
    stderr = openSync(stderrFile, 'w');
    // File redirection also works where a child cannot use Node's stdio sockets.
    result = spawnSync(process.execPath, [cli, ...args], { ...options, stdio: ['ignore', stdout, stderr] });
  } finally {
    closeSync(stdout);
    if (stderr !== undefined) closeSync(stderr);
  }
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: readFileSync(stdoutFile, 'utf8'),
    stderr: readFileSync(stderrFile, 'utf8'),
  };
}
