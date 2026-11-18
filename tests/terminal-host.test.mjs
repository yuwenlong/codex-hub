import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { inspectFooter } from '../lib/terminal-host.mjs';

const require = createRequire(import.meta.url);
const firstId = '01a1ee97-bbc8-7382-995e-b80b8d24ad74';
const secondId = '01a1ee98-bbc8-7382-995e-b80b8d24ad75';
const abbreviated = id => id.slice(0, 29) + '...';

test('matches the live Codex footer to its terminal title and composer', () => {
  const lines = [
    `  ${firstId} · transcript xhigh · Context 2% used`,
    '› Ask Codex to do anything',
    '',
    `  ${firstId} · GPT-6.2-Astra max · Context 67% used · 5h 29% left · weekly 90% left · 0.170.0    ⚠ 1 warning · F2 to view`,
    '  ← for agents · ? for shortcuts',
  ];
  assert.deepEqual(inspectFooter(lines, abbreviated(firstId), 1), {
    row: 3,
    hint: '⚠ 1 warning · F2 to view',
    threadId: firstId,
    model: 'GPT-6.2-Astra',
    reasoning: 'max',
    contextPercent: 67,
    limits: { fiveHour: { remainingPercent: 29 }, weekly: { remainingPercent: 90 } },
    version: '0.170.0',
  });
  assert.equal(inspectFooter(lines, abbreviated(secondId), 1), undefined);
  assert.equal(inspectFooter(lines, abbreviated(firstId), 4), undefined);
  assert.equal(inspectFooter(lines, abbreviated(firstId), 1, false), undefined);
  assert.equal(inspectFooter(lines, '01a1...', 1), undefined);
  assert.equal(inspectFooter(lines.toSpliced(3, 1, '  enter select · esc back'), abbreviated(firstId), 1), undefined);
  assert.equal(inspectFooter(lines.toSpliced(1, 1, 'Select model'), abbreviated(firstId), 1), undefined);
  const narrow = lines.toSpliced(3, 1, '  ' + firstId + ' · GPT-6.2-As…');
  assert.equal(inspectFooter(narrow, abbreviated(firstId), 1).threadId, firstId);
  assert.equal(inspectFooter(narrow, abbreviated(firstId), 1).model, undefined);
});

test('passes through only valid native task progress counts', () => {
  const lines = task => ['› Ask Codex to do anything', '', '  ' + firstId + ' · GPT-6.2-Astra high · ' + task];
  const valid = inspectFooter(lines('Tasks 2/3'), abbreviated(firstId), 0);
  assert.deepEqual(valid.taskProgress, { completed: 2, total: 3 });
  for (const invalid of ['Tasks 0/0', 'Tasks 4/3', 'Tasks 1/9999999999999999999']) {
    assert.equal(inspectFooter(lines(invalid), abbreviated(firstId), 0).taskProgress, undefined);
  }
});

test('keeps the live input and HUD together through typing, picker, thread change and resize', { timeout: 15000 }, async t => {
  const { spawn } = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const fixture = `
    const ids = ${JSON.stringify([firstId, secondId])};
    let index = 0;
    let typed = '';
    process.stdin.setRawMode(true);
    const ansi = String.fromCharCode(27);
    let modal = false;
    const draw = () => {
      const last = process.stdout.rows;
      const title = ids[index].slice(0, 29) + '...';
      process.stdout.write(ansi + ']2;' + title + String.fromCharCode(7) + ansi + '[2J');
      if (modal) {
        process.stdout.write(ansi + '[' + (last - 1) + ';1Hselect model' + ansi + '[?25l');
        return;
      }
      process.stdout.write(ansi + '[' + (last - 3) + ';1H› ' + (typed || 'Ask Codex to do anything') +
        ansi + '[' + (last - 1) + ';1H  ' + ids[index] + ' · GPT-6.2-Astra high · Context 0% used' +
        ansi + '[' + last + ';1H  ← for agents · ? for shortcuts' +
        ansi + '[' + (last - 3) + ';5H' + ansi + '[?25h');
    };
    process.stdout.on('resize', () => draw());
    process.stdin.on('data', bytes => {
      const input = String(bytes);
      const pointer = input.match(/([0-9]+)M/);
      if (input === 'q') {
        process.stdout.write(ansi + '[?1049lfixture exited' + String.fromCharCode(13, 10));
        process.exit(7);
      } else if (input === 'm') {
        modal = true;
        draw();
      } else if (input === 'n') {
        modal = false;
        index = 1;
        draw();
      } else if (pointer) {
        typed = (input.startsWith(ansi + '[200~') ? 'paste ' : 'mouse ') + pointer[1];
        draw();
      } else {
        typed = input;
        draw();
      }
    });
    process.stdout.write(ansi + '[?1049h' + ansi + '[?1003h' + ansi + '[?1006h' + ansi + '[?2004h');
    draw();
  `;
  const url = new URL('../lib/terminal-host.mjs', import.meta.url).href;
  const workspaceLink = '\x1b]8;;file:///tmp/hud%20workspace\x1b\\';
  const closedLink = '\x1b]8;;\x1b\\';
  const invalidLinks = ['https://example.invalid', 'file://example.invalid/share', 'file:////example.invalid/share', 'file:///%5C%5Cexample.invalid'].map(
    href => `\x1b]8;;${href}\x1b\\ignored${closedLink}`,
  ).join(' ');
  const idleHud = `\x1b[34m[one]\x1b[0m │ ${invalidLinks} ${workspaceLink}project\n上下文 ░░░ 0%\n内存 ▓░░ 30%`;
  const outerCode = `
    import { runTerminal } from ${JSON.stringify(url)};
    process.exitCode = await runTerminal({
      file: process.execPath,
      args: ['-e',${JSON.stringify(fixture)}],
      cwd: process.cwd(),
      env: process.env,
      async readHud({ threadId }) {
        if (threadId === ${JSON.stringify(secondId)}) await new Promise(resolve => setTimeout(resolve, 160));
        return threadId === ${JSON.stringify(firstId)} ? ${JSON.stringify(idleHud)} : '[two] │ project\\n◐ agent running';
      }
    });
  `;
  const screen = new Terminal({ cols: 100, rows: 24, allowProposedApi: true, scrollback: 0 });
  const outer = spawn(process.execPath, ['--input-type=module', '-e', outerCode], {
    cols: 100, rows: 24, env: process.env, name: 'xterm-256color',
  });
  const result = new Promise(resolve => outer.onExit(resolve));
  let exited = false;
  void result.then(() => { exited = true; });
  let painted = '';
  const output = outer.onData(data => { painted += data; screen.write(data); });
  t.after(() => { if (!exited) outer.kill(); output.dispose(); screen.dispose(); });
  const rows = () => Array.from({ length: screen.rows }, (_, index) => screen.buffer.active.getLine(index)?.translateToString(true).trim() ?? '');
  async function observe(predicate) {
    for (let elapsed = 0; elapsed < 4000 && !exited; elapsed += 20) {
      const lines = rows();
      if (predicate(lines)) return lines;
      await delay(20);
    }
    assert.fail(rows().join('\n'));
  }

  const idle = await observe(lines => lines.some(line => line.startsWith('[one]')));
  const prompt = idle.findIndex(line => line.includes('Ask Codex'));
  const hud = idle.findIndex(line => line.startsWith('[one]'));
  assert.ok(prompt >= 0 && hud === prompt + 2, idle.join('\n'));
  assert.match(idle[hud + 3], /for shortcuts/u);
  assert.doesNotMatch(idle.join('\n'), new RegExp(firstId, 'u'));
  assert.equal(screen.buffer.active.getLine(hud).getCell(0).getFgColor(), 4);
  assert.ok(painted.includes(workspaceLink + 'project' + closedLink));
  assert.doesNotMatch(painted, /example\.invalid/u);

  outer.write('\x1b[<0;3;');
  outer.write((prompt + 1) + 'M');
  await observe(lines => lines.some(line => line === '› mouse 21'));
  outer.write('\x1b[<0;3;' + (hud + 1) + 'M');
  await delay(50);
  assert.ok(rows().includes('› mouse 21'), 'the HUD is not a clickable control of the inner terminal');
  outer.write('\x1b[200~\x1b[<0;3;2M\x1b[201~');
  await observe(lines => lines.some(line => line === '› paste 2'));
  outer.write('中文');
  await observe(lines => lines.some(line => line === '› 中文') && lines.some(line => line.startsWith('[one]')));
  outer.write('m');
  await observe(lines => lines.some(line => line === 'select model') && !lines.some(line => line.startsWith('[one]')));
  outer.write('n');
  await observe(lines => lines.some(line => line.startsWith('[two]')) && !lines.some(line => line.startsWith('[one]')));

  screen.resize(88, 20);
  outer.resize(88, 20);
  const resized = await observe(lines => lines.some(line => line === '◐ agent running') && lines.at(-1)?.includes('for shortcuts'));
  assert.match(resized.at(-3), /^\[two\]/u);
  outer.write('q');
  assert.equal((await result).exitCode, 7);
  await onceWrite(screen);
  assert.match(rows().join('\n'), /fixture exited/u);
});

function onceWrite(screen) {
  return new Promise(resolve => screen.write('', resolve));
}
