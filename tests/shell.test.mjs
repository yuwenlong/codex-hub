import assert from 'node:assert/strict';
import { spawn as subprocess, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { shellInit, updateShellIntegration } from '../lib/shell.mjs';

const require = createRequire(import.meta.url);
const posix = { skip: process.platform === 'win32' };

function fixture(t, shell = '/bin/bash') {
  const root = mkdtempSync(join(tmpdir(), "codex shell ' 字 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, '.codex');
  const bin = join(root, 'fake bin');
  mkdirSync(home);
  mkdirSync(bin);
  const cli = join(home, 'codex-hud', 'bin', 'codex-hud.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(join(home, 'codex-hud', 'lib'));
  writeFileSync(cli, 'console.log("HUD " + JSON.stringify(process.argv.slice(2)))\n');
  writeFileSync(join(home, 'codex-hud', 'lib', 'launch.mjs'), '');
  writeFileSync(join(bin, 'codex'), "#!/bin/sh\nprintf 'NATIVE %s %s\\n' \"$1\" \"$2\"\n", { mode: 0o755 });
  const env = { HOME: root, USERPROFILE: root, CODEX_HOME: home, SHELL: shell, PATH: [bin, process.env.PATH].join(delimiter), TERM: 'xterm-256color' };
  const change = (action = 'install', overrides) => updateShellIntegration(home, action, { ...env, ...overrides });
  return { root, home, cli, env, change };
}

test('activates the selected Bash profiles and removes only its own bytes', posix, t => {
  const { root, home, change } = fixture(t);
  const rc = join(root, '.bashrc');
  const login = join(root, '.bash_login');
  const profile = join(root, '.profile');
  writeFileSync(rc, '# user rc without a line ending');
  writeFileSync(login, '# preferred login\r\n');
  writeFileSync(profile, '# untouched when .bash_login exists\n');
  chmodSync(rc, 0o640);
  change();
  assert.match(readFileSync(rc, 'utf8'), /^# user rc.*\n# >>> codex-hud/u);
  assert.match(readFileSync(login, 'utf8'), /^# preferred login\r\n\n# >>> codex-hud/u);
  assert.equal(statSync(rc).mode & 0o777, 0o640);
  assert.equal(readFileSync(profile, 'utf8'), '# untouched when .bash_login exists\n');
  const first = readFileSync(rc);
  change();
  assert.deepEqual(readFileSync(rc), first);

  const extra = Buffer.from("printf 'user update\\n'\n");
  writeFileSync(login, Buffer.concat([readFileSync(login), extra]));
  change('uninstall');
  assert.equal(readFileSync(rc, 'utf8'), '# user rc without a line ending');
  assert.deepEqual(readFileSync(login), Buffer.concat([Buffer.from('# preferred login\r\n'), extra]));
  assert.equal(existsSync(join(home, '.codex-hud-shell.json')), false);
});

test('uses ZDOTDIR and preserves an edited block, then removes an untouched new file on opt-out', posix, t => {
  const { root, home, change } = fixture(t, '/usr/bin/zsh');
  const config = join(root, 'shell config');
  const rc = join(config, '.zshrc');
  mkdirSync(config);
  change('install', { ZDOTDIR: config });
  assert.equal(existsSync(join(root, '.zshrc')), false);
  const owned = readFileSync(rc, 'utf8');
  assert.match(owned, />>> codex-hud/u);
  const edited = owned.replace('launch --', 'launch -- "edited"');
  writeFileSync(rc, edited);
  change('install', { ZDOTDIR: config });
  assert.equal(readFileSync(rc, 'utf8'), edited);
  change('uninstall');
  assert.equal(readFileSync(rc, 'utf8'), edited);
  assert.equal(existsSync(join(home, '.codex-hud-shell.json')), true);
  writeFileSync(rc, owned);
  change('install', { CODEX_HUD_SHELL: 'none' });
  assert.equal(existsSync(rc), false);
  assert.equal(existsSync(join(home, '.codex-hud-shell.json')), false);
});

test('PowerShell profile preserves a UTF-16 BOM and its exact existing bytes', t => {
  const { root, change } = fixture(t);
  const file = join(root, 'profile.ps1');
  const user = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# 用户配置\r\nWrite-Output 'keep'", 'utf16le')]);
  writeFileSync(file, user);
  change('install', { CODEX_HUD_PS_PROFILE: file });
  const installed = readFileSync(file);
  assert.deepEqual(installed.subarray(0, user.length), user);
  assert.match(installed.subarray(2).toString('utf16le'), /function global:codex/u);
  assert.match(installed.subarray(2).toString('utf16le'), /Get-Command codex -CommandType Application/u);
  change('uninstall');
  assert.deepEqual(readFileSync(file), user);
});

test('PowerShell launcher transports resume and fork arguments without native quoting changes', t => {
  const { root } = fixture(t);
  const helper = join(root, 'bridge', 'shell.mjs');
  const output = join(root, 'observed.json');
  mkdirSync(dirname(helper), { recursive: true });
  copyFileSync(new URL('../lib/shell.mjs', import.meta.url), helper);
  writeFileSync(join(dirname(helper), 'launch.mjs'), 'import { writeFileSync } from "node:fs";\nexport function launchCodex(args) { writeFileSync(process.env.FIXTURE_ARGV_OUT, JSON.stringify({args, inherited: process.env.CODEX_HUD_SHELL_ARGS})); return 3; }');
  for (const args of [['resume', '--last'], ['-C', 'C:\\path with spaces\\', 'fork', '-p', "user's profile", 'a "quoted" prompt', '']]) {
    const pass = spawnSync(process.execPath, [helper, 'launch'], {
      env: { ...process.env, CODEX_HUD_SHELL_ARGS: JSON.stringify(args), FIXTURE_ARGV_OUT: output }, encoding: 'utf8',
    });
    assert.equal(pass.status, 3, pass.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { args });
  }
});

test('PowerShell dispatches its object pipeline to native Codex instead of the HUD', t => {
  const { cli } = fixture(t);
  const script = shellInit('powershell', cli);
  assert.match(script, /\$codexHudPipeline = \$MyInvocation\.ExpectingInput/u);
  assert.match(script, /if \(-not \$codexHudPipeline -and \$/u);
  assert.match(script, /if \(\$codexHudPipeline\) \{\n\s*\$input \| & \$codexHudNative @args\n\s*\} else \{\n\s*& \$codexHudNative @args/u);
});

test('updates exactly the recorded PowerShell block without changing the surrounding profile', t => {
  const { root, home, change } = fixture(t);
  const profile = join(root, 'profile.ps1');
  const statePath = join(home, '.codex-hud-shell.json');
  const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# 用户\r\n'old setting'", 'utf16le')]);
  writeFileSync(profile, original);
  change('install', { CODEX_HUD_PS_PROFILE: profile });
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const currentBlock = state.entries[0].block;
  const oldBlock = currentBlock.replace('        $codexHudPipeline = $MyInvocation.ExpectingInput', '        $codexHudPipeline = $false');
  assert.notEqual(currentBlock, oldBlock);
  const separator = Buffer.from('\r\n', 'utf16le');
  const later = Buffer.from("# user added after the block\r\n'new setting'\r\n", 'utf16le');
  const config = block => Buffer.concat([original, separator, Buffer.from(block, 'utf16le'), later]);
  writeFileSync(profile, config(oldBlock));
  state.entries[0].block = oldBlock;
  writeFileSync(statePath, JSON.stringify(state));
  change('install', { CODEX_HUD_PS_PROFILE: profile });
  assert.deepEqual(readFileSync(profile), config(currentBlock));
  const finished = JSON.parse(readFileSync(statePath, 'utf8')).entries[0];
  assert.equal(finished.block, currentBlock);
  assert.equal(finished.priorBlock, undefined);
  change('uninstall');
  assert.deepEqual(readFileSync(profile), Buffer.concat([original, separator, later]));
  assert.equal(existsSync(statePath), false);
});

test('recovers either side of an interrupted shell block replacement', t => {
  const { root, home, change } = fixture(t);
  const profile = join(root, 'profile.ps1');
  const statePath = join(home, '.codex-hud-shell.json');
  const original = '# previous profile contents\n';
  writeFileSync(profile, original);
  change('install', { CODEX_HUD_PS_PROFILE: profile });
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const entry = state.entries[0];
  entry.priorBlock = entry.block.replace('$MyInvocation.ExpectingInput', '$false');
  assert.notEqual(entry.block, entry.priorBlock);
  const prefix = original + (entry.addedSeparator ? entry.eol : '');
  for (const present of [entry.priorBlock, entry.block]) {
    writeFileSync(profile, prefix + present);
    writeFileSync(statePath, JSON.stringify(state));
    change('install', { CODEX_HUD_PS_PROFILE: profile });
    assert.equal(readFileSync(profile, 'utf8'), prefix + entry.block);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).entries[0].priorBlock, undefined);

    writeFileSync(profile, prefix + present);
    writeFileSync(statePath, JSON.stringify(state));
    change('uninstall');
    assert.equal(readFileSync(profile, 'utf8'), original);
    assert.equal(existsSync(statePath), false);
  }
});

function installerFixture(t, root, env, profile) {
  const script = join(root, 'intercept-install.mjs');
  const module = new URL('../lib/shell.mjs', import.meta.url).href;
  const source = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const rename = fs.renameSync;',
    'fs.renameSync = (from, to) => {',
    '  if (to === process.env.FIXTURE_PROFILE && process.env.FIXTURE_HOLD) {',
    '    fs.writeFileSync(process.env.FIXTURE_HOLD, "paused");',
    '    const stop = Date.now() + 5000;',
    '    const wake = new Int32Array(new SharedArrayBuffer(4));',
    '    while (!fs.existsSync(process.env.FIXTURE_GO) && Date.now() < stop) Atomics.wait(wake, 0, 0, 10);',
    '  }',
    '  return rename(from, to);',
    '};',
    'syncBuiltinESMExports();',
    'const { updateShellIntegration } = await import(' + JSON.stringify(module) + ');',
    'fs.writeFileSync(process.env.FIXTURE_READY, "started");',
    'updateShellIntegration(process.env.CODEX_HOME, "install");',
  ].join('\n');
  writeFileSync(script, source);
  const go = join(root, 'resume-install');
  return {
    go,
    async start(home, tag, pause = false) {
      const ready = join(root, 'install-' + tag);
      const held = pause ? ready + '-held' : '';
      const child = subprocess(process.execPath, [script], {
        stdio: 'ignore',
        env: { ...env, CODEX_HOME: home, FIXTURE_PROFILE: profile, FIXTURE_READY: ready, FIXTURE_HOLD: held, FIXTURE_GO: go },
      });
      const exit = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
      for (let i = 0; !existsSync(held || ready); i++) {
        assert.ok(i < 300, 'fixture process did not reach the expected step');
        await delay(10);
      }
      return { child, exit };
    },
  };
}

test('serializes two Codex homes sharing one profile and routes the active home', { ...posix, timeout: 10000 }, async t => {
  const { root, home, env, change } = fixture(t);
  const second = join(root, 'other home');
  const secondCli = join(second, 'codex-hud', 'bin', 'codex-hud.mjs');
  const secondLauncher = join(second, 'codex-hud', 'lib', 'launch.mjs');
  mkdirSync(dirname(secondCli), { recursive: true });
  mkdirSync(dirname(secondLauncher));
  writeFileSync(secondCli, 'console.log("SECOND " + JSON.stringify(process.argv.slice(2)))');
  writeFileSync(secondLauncher, '');
  const profile = join(root, '.bashrc');
  writeFileSync(profile, '# existing settings');
  const workers = installerFixture(t, root, env, profile);
  const first = await workers.start(home, 'one', true);
  const peer = await workers.start(second, 'two');
  await delay(250);
  writeFileSync(workers.go, 'go');
  assert.deepEqual(await first.exit, { status: 0, signal: null });
  assert.deepEqual(await peer.exit, { status: 0, signal: null });
  const owned = readFileSync(profile, 'utf8');
  assert.equal([...owned.matchAll(/^# >>> codex-hud /gmu)].length, 2);

  const { spawn } = require('node-pty');
  const args = ['--noprofile', '--rcfile', profile, '-ic', 'codex resume --last'];
  assert.match(await runPty(spawn, '/bin/bash', args, env), /HUD \["launch","--","resume","--last"\]/u);
  assert.match(await runPty(spawn, '/bin/bash', args, { ...env, CODEX_HOME: second }), /SECOND \["launch","--","resume","--last"\]/u);
  rmSync(secondLauncher);
  assert.match(await runPty(spawn, '/bin/bash', args, { ...env, CODEX_HOME: second }), /NATIVE resume --last/u);
  writeFileSync(secondLauncher, '');
  change('uninstall');
  assert.equal([...readFileSync(profile, 'utf8').matchAll(/^# >>> codex-hud /gmu)].length, 1);
  assert.match(await runPty(spawn, '/bin/bash', args, { ...env, CODEX_HOME: second }), /SECOND /u);
  updateShellIntegration(second, 'uninstall', env);
  assert.equal(readFileSync(profile, 'utf8'), '# existing settings');
});

test('reclaims a profile ticket after a forced installer termination', { ...posix, timeout: 10000 }, async t => {
  const { root, home, env, change } = fixture(t);
  const profile = join(root, '.bashrc');
  const queue = profile + '.codex-hud-tickets';
  writeFileSync(profile, '# existing settings\n');
  const workers = installerFixture(t, root, env, profile);
  const interrupted = await workers.start(home, 'interrupted', true);
  interrupted.child.kill('SIGKILL');
  assert.deepEqual(await interrupted.exit, { status: null, signal: 'SIGKILL' });
  assert.equal(existsSync(queue), true);
  assert.equal(readFileSync(profile, 'utf8'), '# existing settings\n');
  change();
  assert.match(readFileSync(profile, 'utf8'), /^# >>> codex-hud /mu);
  assert.equal(existsSync(queue), false);
  change('uninstall');
  assert.equal(readFileSync(profile, 'utf8'), '# existing settings\n');
});

test('restores a shared profile to its original existence in either uninstall order', posix, async t => {
  for (const existed of [true, false]) {
    for (const creatorGoesFirst of [true, false]) {
      await t.test((existed ? 'initially empty' : 'initially absent') + ', creator goes ' +
        (creatorGoesFirst ? 'first' : 'last'), sub => {
        const { root, home, env } = fixture(sub, '/bin/zsh');
        const profile = join(root, '.zshrc');
        const other = join(root, 'other');
        mkdirSync(other);
        if (existed) writeFileSync(profile, '');
        for (const configured of [home, other]) updateShellIntegration(configured, 'install', { ...env, CODEX_HOME: configured });
        const first = creatorGoesFirst ? home : other;
        const last = creatorGoesFirst ? other : home;
        updateShellIntegration(first, 'uninstall', { ...env, CODEX_HOME: first });
        assert.equal([...readFileSync(profile, 'utf8').matchAll(/^# >>> codex-hud /gmu)].length, 1);
        updateShellIntegration(last, 'uninstall', { ...env, CODEX_HOME: last });
        assert.equal(existsSync(profile), existed);
        if (existed) assert.equal(readFileSync(profile).length, 0);
      });
    }
  }
});

test('keeps user bytes added to an originally absent shared profile', posix, t => {
  const { root, home, env } = fixture(t, '/bin/zsh');
  const other = join(root, 'other');
  const profile = join(root, '.zshrc');
  mkdirSync(other);
  updateShellIntegration(home, 'install', env);
  updateShellIntegration(other, 'install', { ...env, CODEX_HOME: other });
  const prefix = Buffer.from('# added ahead of the managed entries\n');
  const suffix = Buffer.from("# user's added content, without a final newline");
  writeFileSync(profile, Buffer.concat([prefix, readFileSync(profile), suffix]));
  updateShellIntegration(home, 'uninstall', env);
  updateShellIntegration(other, 'uninstall', { ...env, CODEX_HOME: other });
  assert.deepEqual(readFileSync(profile), Buffer.concat([prefix, suffix]));
});

test('inherits profile creation from an installed 0.2.1 launcher block', posix, t => {
  const { root, home, env } = fixture(t, '/bin/zsh');
  const profile = join(root, '.zshrc');
  const statePath = join(home, '.codex-hud-shell.json');
  updateShellIntegration(home, 'install', env);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const current = state.entries[0].block;
  const prior = current.replaceAll('command env "CODEX_HOME=${CODEX_HOME:-${HOME-}/.codex}" ', 'command ');
  assert.notEqual(prior, current);
  state.entries[0].block = prior;
  writeFileSync(profile, prior);
  writeFileSync(statePath, JSON.stringify(state));

  const other = join(root, 'other');
  mkdirSync(other);
  updateShellIntegration(other, 'install', { ...env, CODEX_HOME: other });
  updateShellIntegration(home, 'uninstall', env);
  updateShellIntegration(other, 'uninstall', { ...env, CODEX_HOME: other });
  assert.equal(existsSync(profile), false);
});

test('does not inherit profile creation from an incomplete marker block', posix, t => {
  const { root, home, change } = fixture(t, '/bin/zsh');
  const profile = join(root, '.zshrc');
  const existing = '# >>> codex-hud 1234567890abcdef >>>\n# codex-hud: created this startup profile\n# user content';
  writeFileSync(profile, existing);
  change();
  const record = JSON.parse(readFileSync(join(home, '.codex-hud-shell.json'), 'utf8')).entries[0];
  assert.equal(record.created, false);
  change('uninstall');
  assert.equal(readFileSync(profile, 'utf8'), existing);
});

test('refuses to replace a profile link and does not change its target', { ...posix }, t => {
  const { root, change } = fixture(t, '/bin/zsh');
  const target = join(root, 'user-managed settings');
  writeFileSync(target, '# real dotfile\n');
  symlinkSync(target, join(root, '.zshrc'));
  change();
  assert.equal(readFileSync(target, 'utf8'), '# real dotfile\n');
});

test('dispatches an ordinary interactive Bash or Zsh command and preserves argv and aliases', { ...posix, timeout: 10000 }, async t => {
  const { spawn } = require('node-pty');
  for (const shell of ['/bin/bash', '/bin/zsh']) {
    if (!existsSync(shell)) continue;
    const { root, cli, env, change } = fixture(t, shell);
    const dialect = shell.endsWith('/bash') ? 'bash' : 'zsh';
    const file = join(root, dialect === 'bash' ? '.bashrc' : '.zshrc');
    change();
    const command = 'codex "argument with spaces" "it' + "'s ok" + '"; CODEX_HUD_BYPASS=1 codex direct native';
    const args = dialect === 'bash'
      ? ['--noprofile', '--rcfile', file, '-ic', command]
      : ['-ic', command];
    const output = await runPty(spawn, shell, args, { ...env, ZDOTDIR: root });
    assert.match(output, /HUD \["launch","--","argument with spaces","it's ok"\]/u);
    assert.match(output, /NATIVE direct native/u);
    const noTty = spawnSync(shell, args, { env: { ...env, ZDOTDIR: root }, encoding: 'utf8' });
    assert.doesNotMatch(noTty.stdout, /HUD /u);
    const protectedContent = "alias codex='printf user-codex'\n" + readFileSync(file, 'utf8');
    writeFileSync(file, protectedContent);
    assert.match(await runPty(spawn, shell, [...args.slice(0, -1), 'codex'], { ...env, ZDOTDIR: root }), /user-codex/u);
    const temporary = join(root, 'temporary-loader');
    writeFileSync(temporary, shellInit(dialect, cli));
    assert.match(await runPty(spawn, shell, [...args.slice(0, -1), 'unalias codex; . "$1"; eval "codex check path"', 'verify', temporary], { ...env, ZDOTDIR: root }),
      /HUD \["launch","--","check","path"\]/u);
  }
});

async function runPty(spawn, file, args, env) {
  const terminal = spawn(file, args, { env, name: 'xterm-256color', cols: 90, rows: 25 });
  let output = '';
  const stream = terminal.onData(data => { output += data; });
  try {
    const status = await new Promise(resolve => {
      const timeout = setTimeout(() => terminal.kill(), 4000);
      terminal.onExit(value => { clearTimeout(timeout); resolve(value); });
    });
    assert.equal(status.exitCode, 0, output);
    return output;
  } finally {
    stream.dispose();
  }
}
