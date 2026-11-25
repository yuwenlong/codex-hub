import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { closePtyHandle, inspectFooter, isDefaultProcessTitle, resolveObservedTitle } from '../lib/terminal-host.mjs';

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
    end: 4,
    hint: '⚠ 1 warning · F2 to view',
    hintRow: 3,
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
  for (const [firstPart, secondPart] of [['Tasks 1/', '  3'], ['Tasks 1', '  /3'], ['Ta', '  sks 1/3']]) {
    const folded = inspectFooter([
      '› Ask Codex to do anything',
      '',
      `  ${firstId} · GPT-6.2-Astra high · Context 25% used · ${firstPart}`,
      `${secondPart} · 0.170.0`,
      '  ← for agents · ? for shortcuts',
    ], abbreviated(firstId), 0);
    assert.deepEqual(folded?.taskProgress, { completed: 1, total: 3 });
    assert.equal(folded?.contextPercent, 25);
    assert.equal(folded?.version, '0.170.0');
  }
  assert.equal(inspectFooter([
    '› Ask Codex to do anything',
    '',
    `  ${firstId} · GPT-6.2-Astra high · Tasks 1/`,
    '  unknown · 0.170.0',
  ], abbreviated(firstId), 0), undefined);
});

test('keeps the live input and HUD together through typing, picker, thread change and resize', { timeout: 15000 }, async t => {
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
  const workspaceLink = '\x1b]8;;file:///tmp/hud%20workspace\x1b\\';
  const closedLink = '\x1b]8;;\x1b\\';
  const invalidLinks = ['https://example.invalid', 'file://example.invalid/share', 'file:////example.invalid/share', 'file:///%5C%5Cexample.invalid'].map(
    href => `\x1b]8;;${href}\x1b\\ignored${closedLink}`,
  ).join(' ');
  const idleHud = `\x1b[34m[one]\x1b[0m │ ${invalidLinks} ${workspaceLink}project\n上下文 ░░░ 0%\n内存 ▓░░ 30%`;
  // A Windows pseudoconsole can re-encode the display and drop OSC 8.
  const traceDirectory = await mkdtemp(join(tmpdir(), 'codex-hud terminal trace '));
  const trace = join(traceDirectory, 'stdout');
  const { outer, screen, result, rows, observe } = hostFixture(t, fixture, `
    async readHud({ threadId }) {
      if (threadId === ${JSON.stringify(secondId)}) await new Promise(resolve => setTimeout(resolve, 160));
      return threadId === ${JSON.stringify(firstId)} ? ${JSON.stringify(idleHud)} : '[two] │ project\\n◐ agent running';
    }
  `, 100, 24, trace);
  t.after(() => rm(traceDirectory, { force: true, recursive: true }));

  const idle = await observe(lines => lines.some(line => line.startsWith('[one]')));
  const prompt = idle.findIndex(line => line.includes('Ask Codex'));
  const hud = idle.findIndex(line => line.startsWith('[one]'));
  assert.ok(prompt >= 0 && hud === prompt + 2, idle.join('\n'));
  assert.match(idle[hud], /\bproject\b/u);
  assert.match(idle[hud + 3], /for shortcuts/u);
  assert.doesNotMatch(idle.join('\n'), new RegExp(firstId, 'u'));
  assert.equal(screen.buffer.active.getLine(hud).getCell(0).getFgColor(), 4);
  const written = await readFile(trace, 'utf8');
  assert.ok(written.includes(workspaceLink + 'project' + closedLink));
  assert.doesNotMatch(written, /example\.invalid/u);

  const mouse = '\x1b[<0;3;';
  const promptClick = (prompt + 1) + 'M';
  // The outer Windows ConPTY discards an incomplete SGR packet sent in a separate write.
  if (process.platform === 'win32') outer.write(mouse + promptClick);
  else {
    outer.write(mouse);
    outer.write(promptClick);
  }
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

const basicHud = `
  initialHud({ model }) { return (model ? '[' + model + '] │ ' : '') + 'workspace\\n内存 30%'; },
  async readHud({ threadId }) {
    if (threadId !== ${JSON.stringify(firstId)}) process.stdout.write('premature thread query');
    await new Promise(resolve => setTimeout(resolve, 500));
    return '[enriched] │ workspace\\n上下文 0%\\n内存 30%';
  },
`;

function frameFixture(firstFrame = 'composer()') {
  return String.raw`
    const esc = '\x1b';
    const bottom = process.stdout.rows;
    const columns = process.stdout.columns;
    const draw = (row, line) => esc + '[' + row + ';1H' + line;
    const cursor = row => esc + '[' + row + ';3H';
    const title = ${JSON.stringify('\x1b]2;' + abbreviated(firstId) + '\x07')};
    const id = ${JSON.stringify(firstId)};
    const footer = ${JSON.stringify('  ' + firstId + ' · GPT-6.2-Sol default · Context 0% used · 0.171.0')};
    const shortcuts = '  ← for agents · ? for shortcuts';
    const blank = esc + '[48;5;236m ' + esc + '[0m';
    function composer(prompt = bottom - 3, hint = '') {
      const input = Array.from({ length: bottom - 3 - prompt }, (_, index) => draw(prompt + index + 1, '  continued input'));
      return title + esc + '[2J' + draw(prompt, '› Ask Codex to do anything') + input.join('') + draw(bottom - 2, blank) + draw(bottom - 1, footer + hint)
        + draw(bottom, shortcuts) + cursor(bottom - 3) + esc + '[?25h';
    }
    function startup() {
      return esc + '[2J' + draw(bottom - 2, '› Ask Codex to do anything')
        + draw(bottom - 1, blank) + draw(bottom, '  ? for shortcuts') + cursor(bottom - 2) + esc + '[?25h';
    }
    function startupMetrics(typed = false) {
      const controls = typed ? '                          ' : columns < 60 ? '  ← for agents' : shortcuts;
      const gap = columns < 60 ? '           ' : '     ';
      return startup() + esc + '[2J' + draw(bottom - 3, typed ? '› hello' : '› Ask Codex to do anything') + draw(bottom - 2, blank)
        + draw(bottom - 1, '  gpt-5.4 default · Context 0% used · 0.171.0')
        + draw(bottom, controls + gap + '⚠ 1 warning · f2 to view')
        + (typed ? esc + '[' + (bottom - 3) + ';8H' : cursor(bottom - 3));
    }
    function folded(text = 'Ask Codex to do anything', working = false, shutdown = false, queue = false) {
      const chunks = columns <= 42 ? (queue ? ['  ' + id + ' ·', '  gpt-5.4 high · Context 0% used · 0.171.0']
        : ['  ' + id, '  gpt-5.4 high · Context 0% used ·', '  0.171.0'])
        : columns <= 51 ? ['  ' + id + ' · gpt-5.4', '  high · Context 0% used · 0.171.0']
        : ['  ' + id + ' · gpt-5.4 high · Tasks 1/', '  3 · Context 0% used · 0.171.0'];
      const controls = queue ? '  tab to queue message'
        : columns <= 42 ? '  ? for shortcuts' : columns <= 51 ? '  ← for agents' : shortcuts;
      const first = bottom - chunks.length + Number(shutdown);
      const prompt = first - 2;
      return title + esc + '[?2026h' + esc + '[2J'
        + (working ? draw(prompt - 3, '• Working (2m • esc to interrupt)') : '')
        + draw(prompt, '› ' + (shutdown ? 'Shutting down...' : text)) + draw(prompt + 1, blank)
        + chunks.map((chunk, index) => draw(first + index, chunk)).join('')
        + (shutdown ? '' : draw(bottom, controls))
        + (working || shutdown ? cursor(bottom) + esc + '[?25l' : cursor(prompt) + esc + '[?25h') + esc + '[?2026l';
    }
    process.stdin.setRawMode(true);
    process.stdout.write(esc + '[?1049h' + esc + '[>1u' + ${firstFrame});
    process.stdin.on('data', bytes => {
      const command = String(bytes);
      if (command === 'n') process.stdout.write(composer());
      if (command === 'd') process.stdout.write(startupMetrics());
      if (command === 'hello') process.stdout.write(esc + '[2J' + draw(bottom - 1, '› hello') + draw(bottom, blank) + esc + '[' + (bottom - 1) + ';8H');
      if (command === 'b') process.stdout.write(startupMetrics(true));
      if (command === 'a') process.stdout.write(esc + '[2J' + draw(bottom - 2, '› 1. Yes, proceed')
        + draw(bottom, '  enter select · esc cancel') + cursor(bottom - 2));
      const pointer = command.match(/^\x1b\[<0;3;(\d+)M$/);
      if (pointer) process.stdout.write(folded('mouse ' + pointer[1]));
      if (command === 'v') process.stdout.write(folded(undefined, true));
      if (command === 'k') process.stdout.write(folded('hello', false, false, true));
      if (command === 'o') process.stdout.write(title + draw(1, 'Title arrived') + cursor(bottom - 3));
      if (command === 'u') process.stdout.write(esc + ']2;Unrelated title\x07' + startupMetrics());
      if (command === 's') {
        process.stdout.write(esc + '[?2026h' + esc + '[?25l' + draw(1, 'Running hooks')
          + cursor(bottom) + '\x07');
      }
      if (command === 'e') {
        process.stdout.write(cursor(bottom - 3) + esc + '[?25h' + esc + '[?2026l');
      }
      if (command === 'w') {
        process.stdout.write(esc + '[?2026h' + esc + '[?25l'
          + draw(bottom - 6, '◦ Working (2m • esc to interrupt) · Running hooks')
          + draw(bottom, shortcuts + '     ⚠ 1 warning · f2 to view') + cursor(bottom) + esc + '[?2026l');
      }
      if (command === 'z') {
        process.stdout.write(draw(bottom - 3, '› queued message') + esc + '[K'
          + draw(bottom, '  tab to queue message') + esc + '[K' + cursor(bottom - 3));
      }
      if (command === 'm') {
        process.stdout.write(draw(bottom - 3, '› Select model') + esc + '[K'
          + draw(bottom, '  enter select · esc back') + esc + '[K' + esc + '[?25l');
      }
      if (command === 't') {
        process.stdout.write(draw(bottom - 3, '› Shutting down...') + esc + '[K' + cursor(bottom - 3));
      }
      if (command === 'p') {
        process.stdout.write(esc + '[?2026h' + esc + '[2J' + draw(bottom - 3, '› Select model')
          + draw(bottom, '  enter select · esc back') + esc + '[?25l');
      }
      if (command === '\x03') {
        process.stdout.write(columns <= 76 ? folded(undefined, false, true)
          : esc + '[?2026h' + esc + '[?25l' + esc + '[2J' + draw(bottom - 2, '› Shutting down...')
            + draw(bottom - 1, blank) + draw(bottom, footer) + cursor(bottom) + esc + '[?2026l');
        setTimeout(() => process.stdout.write(esc + '[2J' + esc + '[?1049l' + 'fixture exited\r\n'), 350);
        setTimeout(() => process.exit(7), 600);
      }
    });
  `;
}

test('shows a local HUD on the titleless startup composer and keeps its shortcuts', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture('startup()'), basicHud);
  const startup = await terminal.observe(lines => lines.includes('workspace'));
  assert.ok(startup.indexOf('› Ask Codex to do anything') >= 0);
  assert.ok(startup.indexOf('› Ask Codex to do anything') < startup.indexOf('workspace'));
  assert.ok(startup.includes('? for shortcuts'));
  assert.ok(startup.includes('内存 30%'));
  terminal.outer.write('d');
  const model = await terminal.observe(lines => lines.includes('[gpt-5.4] │ workspace'));
  assert.ok(model.some(line => line.includes('⚠ 1 warning · f2 to view')));
  terminal.outer.write('o');
  const arrived = await terminal.observe(lines => lines.includes('Title arrived'));
  assert.ok(arrived.includes('[gpt-5.4] │ workspace'));
  terminal.outer.write('u');
  await terminal.observe(lines => lines.includes('gpt-5.4 default · Context 0% used · 0.171.0'));
  assert.ok(!terminal.rows().includes('[gpt-5.4] │ workspace'));
  terminal.outer.write('n');
  await terminal.observe(lines => lines.includes('[GPT-6.2-Sol] │ workspace'));
  assert.ok(!terminal.painted().includes(firstId));
  terminal.outer.write('d');
  await terminal.observe(lines => lines.includes('gpt-5.4 default · Context 0% used · 0.171.0'));
  assert.doesNotMatch(terminal.painted(), /premature thread query/u);
});

test('keeps the startup HUD while typing before a thread ID arrives and yields to confirmation', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture('startup()'), basicHud, 112);
  await terminal.observe(lines => lines.includes('workspace'));
  terminal.outer.write('hello');
  const typed = await terminal.observe(lines => lines.includes('› hello'));
  assert.ok(typed.includes('workspace'));
  assert.equal(terminal.screen.buffer.active.cursorX, 7);
  terminal.outer.write('b');
  const metrics = await terminal.observe(lines => lines.some(line => line.includes('⚠ 1 warning')));
  assert.ok(metrics.includes('[gpt-5.4] │ workspace'));
  assert.ok(metrics.includes('› hello'));
  terminal.outer.write('a');
  const confirm = await terminal.observe(lines => lines.includes('› 1. Yes, proceed'));
  assert.ok(confirm.includes('enter select · esc cancel'));
  assert.ok(!confirm.some(line => line.includes('workspace')));
  assert.doesNotMatch(terminal.painted(), /premature thread query/u);
});

test('keeps the startup HUD when a narrow terminal shows only the agents shortcut', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture('startup()'), basicHud, 51, 17);
  await terminal.observe(lines => lines.includes('workspace'));
  terminal.outer.write('d');
  const metrics = await terminal.observe(lines => lines.some(line => line.includes('⚠ 1 warning')));
  assert.ok(metrics.includes('[gpt-5.4] │ workspace'));
  assert.ok(metrics.some(line => line.startsWith('← for agents')));
  assert.doesNotMatch(terminal.painted(), /gpt-5\.4 default · Context/u);
});

const foldedHud = `
  initialHud({ model, reasoning, contextPercent, version, taskProgress }) {
    const tasks = taskProgress ? ' │ Tasks ' + taskProgress.completed + '/' + taskProgress.total : '';
    return model + ' ' + reasoning + ' │ v' + version + tasks + '\\nContext: ' + contextPercent + '%\\nMemory 30%\\nWorkspace';
  },
  async readHud() { return ''; },
`;

for (const columns of [42, 51, 76]) {
  test(`replaces all folded footer rows at ${columns} columns through mouse input and shutdown`, { timeout: 6000 }, async t => {
    const expectedHeader = columns === 76 ? 'gpt-5.4 high │ v0.171.0 │ Tasks 1/3' : 'gpt-5.4 high │ v0.171.0';
    const terminal = hostFixture(t, frameFixture('folded()'), foldedHud, columns, 17);
    const initial = await terminal.observe(lines => lines.some(line => line.includes('for agents') || line.includes('for shortcuts')));
    assert.ok(initial.includes(expectedHeader));
    assert.ok(initial.includes('Context: 0%'));
    assert.ok(!initial.some(line => /^(?:high · Context|0\.171\.0$|3 · Context)/u.test(line)));
    const prompt = initial.indexOf('› Ask Codex to do anything');
    const innerPrompt = columns === 42 ? 12 : 13;
    terminal.outer.write('\x1b[<0;3;' + (prompt + 1) + 'M');
    await terminal.observe(lines => lines.includes('› mouse ' + innerPrompt));
    terminal.outer.write('k');
    const queued = await terminal.observe(lines => lines.includes('tab to queue message'));
    assert.ok(queued.includes(expectedHeader));
    assert.ok(queued.includes('› hello'));
    terminal.outer.write('v');
    const working = await terminal.observe(lines => lines.some(line => line.includes('Working (2m')));
    assert.ok(working.includes(expectedHeader));
    assert.ok(!working.some(line => /^(?:high · Context|0\.171\.0$|3 · Context)/u.test(line)));
    terminal.outer.write('\x03');
    const shutdown = await terminal.observe(lines => lines.includes('› Shutting down...'));
    assert.ok(shutdown.includes(expectedHeader));
    assert.ok(!shutdown.some(line => /^(?:high · Context|0\.171\.0$|3 · Context)/u.test(line)));
    assert.equal((await terminal.result).exitCode, 7);
    assert.ok(!terminal.painted().includes(firstId));
  });
}

test('covers the first native thread footer before activity loads', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture(), basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  assert.match(terminal.painted(), /\[GPT-6\.2-Sol\] │ workspace/u);
  terminal.outer.write('z');
  const queued = await terminal.observe(lines => lines.includes('› queued message'));
  assert.ok(queued.includes('[enriched] │ workspace'));
  assert.ok(queued.includes('tab to queue message'));
  assert.ok(!terminal.painted().includes(firstId));
});

test('holds a split synchronized update until its complete composer frame', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture(), basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  const before = terminal.painted().length;
  terminal.outer.write('s');
  await terminal.observe(() => terminal.painted().slice(before).includes('\x07'));
  await delay(120);
  const during = terminal.painted().slice(before);
  assert.doesNotMatch(during, /Running hooks/u);
  assert.ok(!during.includes(firstId));
  assert.ok(terminal.rows().includes('[enriched] │ workspace'));
  terminal.outer.write('e');
  const after = await terminal.observe(lines => lines.includes('Running hooks'));
  assert.ok(after.includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));
});

test('recovers when a picker leaves synchronized output open', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture(), basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  terminal.outer.write('p');
  const picker = await terminal.observe(lines => lines.includes('› Select model'));
  assert.ok(picker.includes('enter select · esc back'));
  assert.ok(!picker.includes('[enriched] │ workspace'));
});

test('recognizes a committed Working composer with a hidden cursor and yields to the model picker', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture(), basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  terminal.outer.write('w');
  const working = await terminal.observe(lines => lines.some(line => line.includes('Working (2m')));
  assert.ok(working.includes('› Ask Codex to do anything'));
  assert.ok(working.includes('[enriched] │ workspace'));
  assert.ok(!working.some(line => line.includes(firstId)));
  terminal.outer.write('m');
  const picker = await terminal.observe(lines => lines.includes('› Select model'));
  assert.ok(picker.includes('enter select · esc back'));
  assert.ok(!picker.includes('[enriched] │ workspace'));
});

test('shrinks the HUD when composer input fills the terminal and keeps native shortcuts', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture("composer(1, '    ⚠ 1 warning')"), basicHud, 120);
  const lines = await terminal.observe(lines => lines.some(line => line.includes('[enriched] │ workspace')));
  assert.equal(lines[0], '› Ask Codex to do anything');
  assert.equal(lines.filter(line => line === 'continued input').length, 20);
  assert.ok(lines.some(line => line.includes('⚠ 1 warning')));
  assert.ok(lines.includes('← for agents · ? for shortcuts'));
  assert.ok(!terminal.painted().includes(firstId));
});

test('treats typed shutdown text in the composer as ordinary input', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture(), basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  terminal.outer.write('t');
  await terminal.observe(lines => lines.includes('› Shutting down...'));
  terminal.outer.write('n');
  await terminal.observe(lines => lines.includes('› Ask Codex to do anything'));
});

test('keeps the HUD through idle Ctrl+C shutdown and prints final shell output once', { timeout: 6000 }, async t => {
  const terminal = hostFixture(t, frameFixture(), basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  const before = terminal.painted().length;
  terminal.outer.write('\x03');
  const shutdown = await terminal.observe(lines => lines.some(line => line.includes('Shutting down...')));
  assert.ok(shutdown.includes('[enriched] │ workspace'));
  assert.equal((await terminal.result).exitCode, 7);
  await onceWrite(terminal.screen);
  assert.equal(terminal.screen.buffer.active.type, 'normal');
  assert.equal(terminal.painted().slice(before).match(/fixture exited/gu)?.length, 1);
  assert.equal(terminal.painted().slice(before).match(/\x1b\[<1u/gu)?.length, 1);
  assert.match(terminal.rows().join('\n'), /fixture exited/u);
  assert.ok(!terminal.painted().slice(before).includes(firstId));
});

test('accepts mouse selection and history shortcut hints and rejects modal footers in inspectFooter', () => {
  const base = [
    '› Ask Codex to do anything',
    '',
    `  ${firstId} · GPT-6.2-Astra max · Context 40% used · 0.172.0`,
    '  ctrl+c copy · enter copy & follow · esc clear',
  ];
  for (const hint of [
    '  ctrl+c copy · enter copy & follow · esc clear',
    '  Ctrl+C copy · enter copy & follow · esc clear     ⚠ 1 warning · F2 to view',
    '  ^c copy · enter copy & follow · esc clear',
    '  ^C copy · enter copy & follow · esc clear  ⚠ notice',
    '  esc latest',
    '  esc latest                                                                                  ⚠ 2 warnings · f2 to view',
    '  enter/esc latest',
    '  enter/esc latest · ? shortcuts',
    '  enter/esc latest · ? shortcuts  ⚠ 1 warning · f2 to view',
    '  enter/esc latest · ? for shortcuts',
    '  esc again to edit previous message',
    '  esc again to edit previous message     ⚠ 1 warning · f2 to view',
    '  esc to edit previous message',
  ]) {
    const matched = inspectFooter(base.toSpliced(3, 1, hint), abbreviated(firstId), 0);
    assert.equal(matched?.threadId, firstId);
    assert.equal(matched?.end, 3);
  }
  for (const modalHint of [
    '  enter select · esc back',
    '  enter select · esc cancel',
    '  enter copy & latest · esc clear · q close',
    '  esc latest · q close',
    '  enter/esc latest · q close',
  ]) {
    assert.equal(inspectFooter(base.toSpliced(3, 1, modalHint), abbreviated(firstId), 0), undefined);
  }
});

function codex172Fixture() {
  return String.raw`
    const esc = '\x1b';
    const draw = (row, line) => esc + '[' + row + ';1H' + line;
    const id = ${JSON.stringify(firstId)};
    const title = ${JSON.stringify('\x1b]2;' + abbreviated(firstId) + '\x07')};
    const native = '  ' + id + ' · GPT-6.2-Sol default · Context 12% used · 0.172.0';
    const shortcuts = '  ← for agents · ? for shortcuts';
    const blank = esc + '[48;5;236m ' + esc + '[0m';
    let currentView = 'idle';

    function drawFrame({
      body = [],
      promptLines = ['› Ask Codex to do anything'],
      includeFooter = true,
      hint = shortcuts,
      hideCursor = false,
      parkBottom = false,
      useTitle = true,
      cursorRowOffset = 0,
    } = {}) {
      const bottom = process.stdout.rows;
      const cols = process.stdout.columns;
      const footerRows = includeFooter ? 1 : 0;
      const hintRows = hint === null ? 0 : 1;
      const firstPrompt = bottom - hintRows - footerRows - 1 - promptLines.length + 1;
      const bodyStart = Math.max(1, firstPrompt - body.length);
      let out = (useTitle ? title : '') + esc + '[2J';
      body.forEach((line, index) => { out += draw(bodyStart + index, line); });
      promptLines.forEach((line, index) => { out += draw(firstPrompt + index, line); });
      out += draw(firstPrompt + promptLines.length, blank);
      if (includeFooter) out += draw(bottom - hintRows, native);
      if (hint !== null) out += draw(bottom, hint);
      const cursorRow = parkBottom ? bottom : firstPrompt + cursorRowOffset;
      const cursorCol = parkBottom ? cols : 3;
      out += esc + '[' + cursorRow + ';' + cursorCol + 'H' + esc + (hideCursor ? '[?25l' : '[?25h');
      return out;
    }

    process.stdin.setRawMode(true);
    process.stdout.on('resize', () => {
      if (currentView === 'split-resize') {
        process.stdout.write('');
        process.stdout.write(title);
        process.stdout.write(esc + '[2J');
        setTimeout(() => {
          process.stdout.write(drawFrame({ body: ['Resized cleanly'] }));
        }, 60);
      } else {
        process.stdout.write(drawFrame());
      }
    });

    process.stdin.on('data', bytes => {
      const bottom = process.stdout.rows;
      const cmd = String(bytes);
      if (cmd === '1') {
        // ConPTY split: ?2026h -> ?25l -> ?2026l with bottom-parked cursor, delayed ?25h
        process.stdout.write(esc + '[?2026h' + esc + '[?25l'
          + drawFrame({ promptLines: ['› line 1', '  line 2'], hideCursor: true, parkBottom: true })
          + esc + '[?2026l');
        setTimeout(() => {
          process.stdout.write(esc + '[' + (bottom - 3) + ';9H' + esc + '[?25h');
        }, 80);
      } else if (cmd === '2') {
        process.stdout.write(drawFrame({
          body: ['AI output for selection'],
          hint: '  ctrl+c copy · enter copy & follow · esc clear  ⚠ 1 warning',
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === '3') {
        process.stdout.write(drawFrame({
          body: ['AI output unix selection'],
          hint: '  ^c copy · enter copy & follow · esc clear',
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === 'h') {
        process.stdout.write(drawFrame({
          body: ['↓ Back to bottom · esc', 'Earlier history message'],
          hint: '  esc latest',
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === 'H') {
        process.stdout.write(drawFrame({
          body: ['↓ Back to bottom · esc', 'Earlier history message with warnings'],
          hint: '  esc latest                                                   ⚠ 2 warnings · f2 to view',
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === 'l') {
        process.stdout.write(drawFrame({
          body: ['↓ Back to bottom · esc', 'Empty composer history view'],
          hint: '  enter/esc latest · ? shortcuts',
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === 'L') {
        process.stdout.write(drawFrame({
          body: ['↓ Back to bottom · esc', 'Narrow empty composer history'],
          hint: '  enter/esc latest',
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === 'e') {
        process.stdout.write(drawFrame({
          body: ['Previous message'],
          hint: '  esc again to edit previous message',
        }));
      } else if (cmd === 'E') {
        process.stdout.write(drawFrame({
          body: ['Previous message with warning'],
          hint: '  esc to edit previous message  ⚠ 1 warning',
        }));
      } else if (cmd === '4') {
        process.stdout.write(drawFrame({
          body: ['• Checking status line behavior... (2s • esc to interrupt)'],
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === '5') {
        process.stdout.write(drawFrame({
          body: ['◦ Summarizing diff... (5s • esc to interrupt) · Running tests'],
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === '6') {
        process.stdout.write(drawFrame({
          body: ['Streaming delta line without status row'],
          hideCursor: true,
          parkBottom: true,
        }));
      } else if (cmd === '7') {
        process.stdout.write(drawFrame({
          promptLines: ['› line 1', '  line 2', '  line 3'],
          cursorRowOffset: 0,
        }));
      } else if (cmd === '8') {
        // A3 overflow: Codex itself drops the native UUID footer
        const lines = ['› line 1', ...Array.from({ length: 18 }, (_, i) => '  overflow ' + i)];
        process.stdout.write(drawFrame({
          promptLines: lines,
          includeFooter: false,
          hint: shortcuts,
          cursorRowOffset: 0,
        }));
      } else if (cmd === '9') {
        process.stdout.write(drawFrame({ body: ['Recovered after overflow'] }));
      } else if (cmd === 'b') {
        // Split blank 2J before next frame
        process.stdout.write(esc + '[2J');
        setTimeout(() => {
          process.stdout.write(drawFrame({ body: ['After split clear'] }));
        }, 60);
      } else if (cmd === 'r') {
        currentView = 'split-resize';
        process.stdout.write(drawFrame({ body: ['Ready for resize'] }));
      } else if (cmd === 'm') {
        process.stdout.write(draw(bottom - 3, '› Select model') + esc + '[K'
          + draw(bottom, '  enter select · esc back') + esc + '[K' + esc + '[?25l');
      } else if (cmd === 'c') {
        process.stdout.write(esc + '[2J' + draw(bottom - 2, '› Copy transcript')
          + draw(bottom, '  enter copy & latest · esc clear · q close') + esc + '[?25l');
      } else if (cmd === 'q') {
        process.stdout.write(esc + '[?1049lfirm exit\r\n');
        process.exit(0);
      }
    });

    process.stdout.write(esc + '[?1049h' + drawFrame());
  `;
}

test('keeps the HUD through ConPTY split ?2026h/?25l/?2026l, mouse selection hints, reasoning status and streaming deltas', { timeout: 10000 }, async t => {
  const terminal = hostFixture(t, codex172Fixture(), basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  if (process.platform !== 'win32') assert.ok(!terminal.painted().includes('9001'));
  const before = terminal.painted().length;

  // 1. ConPTY split ?2026h -> ?25l -> ?2026l with bottom-parked cursor and delayed ?25h
  terminal.outer.write('1');
  await terminal.observe(lines => lines.includes('line 2'));
  await delay(60);
  assert.ok(terminal.rows().includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));

  // 2. Windows & Unix selection hints with ?25l and bottom-row cursor
  terminal.outer.write('2');
  const winSel = await terminal.observe(lines => lines.some(line => line.includes('ctrl+c copy · enter copy & follow · esc clear')));
  assert.ok(winSel.includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));

  terminal.outer.write('3');
  const unixSel = await terminal.observe(lines => lines.some(line => line.includes('^c copy · enter copy & follow · esc clear')));
  assert.ok(unixSel.includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));

  for (const [key, bodyText, hintText] of [
    ['h', 'Earlier history message', 'esc latest'],
    ['H', 'Earlier history message with warnings', '⚠ 2 warnings · f2 to view'],
    ['l', 'Empty composer history view', 'enter/esc latest · ? shortcuts'],
    ['L', 'Narrow empty composer history', 'enter/esc latest'],
    ['e', 'Previous message', 'esc again to edit previous message'],
    ['E', 'Previous message with warning', 'esc to edit previous message'],
  ]) {
    terminal.outer.write(key);
    const historyView = await terminal.observe(lines => lines.some(line => line.includes(bodyText)) && lines.some(line => line.includes(hintText)));
    assert.ok(historyView.includes('[enriched] │ workspace'));
    assert.ok(!terminal.painted().slice(before).includes(firstId));
  }

  // 3. Reasoning summaries and blank streaming status frames with ?25l
  terminal.outer.write('4');
  const reason1 = await terminal.observe(lines => lines.some(line => line.includes('Checking status line behavior')));
  assert.ok(reason1.includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));

  terminal.outer.write('5');
  const reason2 = await terminal.observe(lines => lines.some(line => line.includes('Summarizing diff...')));
  assert.ok(reason2.includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));

  terminal.outer.write('6');
  const streamed = await terminal.observe(lines => lines.includes('Streaming delta line without status row'));
  await delay(60);
  assert.ok(streamed.includes('[enriched] │ workspace'));
  assert.ok(terminal.rows().includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));

  // 4. Yields cleanly to modals ('m' and copy modal 'enter copy & latest · esc clear · q close')
  terminal.outer.write('m');
  const picker = await terminal.observe(lines => lines.includes('› Select model'));
  assert.ok(picker.includes('enter select · esc back'));
  assert.ok(!picker.includes('[enriched] │ workspace'));

  terminal.outer.write('c');
  const copyModal = await terminal.observe(lines => lines.includes('› Copy transcript'));
  assert.ok(copyModal.includes('enter copy & latest · esc clear · q close'));
  assert.ok(!copyModal.includes('[enriched] │ workspace'));

  terminal.outer.write('q');
  assert.equal((await terminal.result).exitCode, 0);
});

test('keeps the HUD through Shift+Enter multiline and cursor navigation, and hides synchronously on A3 native overflow', { timeout: 10000 }, async t => {
  await t.test('startup multiline and cursor navigation', async t => {
    // Part A: startup multiline + arrow navigation + ?25l flicker
    const startupFixture = String.raw`
      const esc = '\x1b';
      const bottom = process.stdout.rows;
      const draw = (row, line) => esc + '[' + row + ';1H' + line;
      const blank = esc + '[48;5;236m ' + esc + '[0m';
      process.stdin.setRawMode(true);
      process.stdout.write(esc + '[?1049h' + esc + '[2J'
        + draw(bottom - 2, '› Ask Codex to do anything')
        + draw(bottom - 1, blank)
        + draw(bottom, '  ? for shortcuts')
        + esc + '[' + (bottom - 2) + ';3H' + esc + '[?25h');
      process.stdin.on('data', bytes => {
        const cmd = String(bytes);
        if (cmd === '1') {
          process.stdout.write(esc + '[2J'
            + draw(bottom - 4, '› line 1')
            + draw(bottom - 3, '  line 2')
            + draw(bottom - 2, '  line 3')
            + draw(bottom - 1, blank)
            + draw(bottom, '  ? for shortcuts')
            + esc + '[' + (bottom - 4) + ';5H' + esc + '[?25l');
        } else if (cmd === '2') {
          process.stdout.write(esc + '[2J'
            + draw(bottom - 4, '› line 1')
            + draw(bottom - 3, '  line 2')
            + draw(bottom - 2, blank)
            + draw(bottom - 1, '  gpt-5.4 default · Context 0% used · 0.172.0')
            + draw(bottom, '  ← for agents · ? for shortcuts')
            + esc + '[' + bottom + ';80H' + esc + '[?25l');
        } else if (cmd === 'q') {
          process.stdout.write(esc + '[?1049l');
          process.exit(0);
        }
      });
    `;
    const startup = hostFixture(t, startupFixture, basicHud);
    await startup.observe(lines => lines.includes('workspace'));
    startup.outer.write('1');
    const multiStartup = await startup.observe(lines => lines.includes('line 3'));
    assert.ok(multiStartup.includes('workspace'));
    assert.ok(multiStartup.includes('? for shortcuts'));
    startup.outer.write('2');
    const multiMetrics = await startup.observe(lines => lines.includes('line 2') && lines.includes('[gpt-5.4] │ workspace'));
    assert.ok(multiMetrics.includes('← for agents · ? for shortcuts'));
    startup.outer.write('q');
    assert.equal((await startup.result).exitCode, 0);
  });

  await t.test('active thread multiline and A3 native overflow sync hide', async t => {
    // Part B: active thread multiline + A3 native overflow sync hide
    const terminal = hostFixture(t, codex172Fixture(), basicHud);
    await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
    const before = terminal.painted().length;
    terminal.outer.write('7');
    const multiThread = await terminal.observe(lines => lines.includes('line 3'));
    assert.ok(multiThread.includes('[enriched] │ workspace'));
    assert.ok(!terminal.painted().slice(before).includes(firstId));

    terminal.outer.write('8');
    const overflow = await terminal.observe(lines => lines.includes('overflow 17'));
    assert.ok(!overflow.some(line => line.includes('workspace')));

    terminal.outer.write('9');
    const recovered = await terminal.observe(lines => lines.includes('Recovered after overflow'));
    assert.ok(recovered.includes('[enriched] │ workspace'));
    terminal.outer.write('q');
    assert.equal((await terminal.result).exitCode, 0);
  });
});

test('prevents blank 2J flash and holds frozen frame through empty, title-only, and blank resize chunks', { timeout: 10000 }, async t => {
  const terminal = hostFixture(t, codex172Fixture(), basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  const before = terminal.painted().length;

  // Split blank \x1b[2J followed by delayed redraw (60ms)
  terminal.outer.write('b');
  await delay(35);
  assert.ok(terminal.rows().includes('[enriched] │ workspace'), 'blank 2J split must not flash a black screen');
  const afterClear = await terminal.observe(lines => lines.includes('After split clear'));
  assert.ok(afterClear.includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));

  // Resize freeze resilience against '', title OSC, and blank 2J
  terminal.outer.write('r');
  await terminal.observe(lines => lines.includes('Ready for resize'));
  terminal.screen.resize(92, 22);
  terminal.outer.resize(92, 22);
  await delay(35);
  assert.ok(terminal.rows().includes('[enriched] │ workspace'), 'frozen frame must not thaw on empty/title/blank 2J');
  const resized = await terminal.observe(lines => lines.includes('Resized cleanly'));
  assert.ok(resized.includes('[enriched] │ workspace'));
  assert.ok(!terminal.painted().slice(before).includes(firstId));

  terminal.outer.write('q');
  assert.equal((await terminal.result).exitCode, 0);
});

test('ignores ?9001h win32-input-mode, forwards no-arg >u, split win32/SGR input, and restores modes on exit', { timeout: 10000 }, async t => {
  const winFixture = String.raw`
    const esc = '\x1b';
    const bottom = process.stdout.rows;
    const draw = (row, line) => esc + '[' + row + ';1H' + line;
    const id = ${JSON.stringify(firstId)};
    const title = ${JSON.stringify('\x1b]2;' + abbreviated(firstId) + '\x07')};
    const footer = '  ' + id + ' · GPT-6.2-Sol default · Context 0% used · 0.172.0';
    let status = 'ready';
    const paint = () => {
      process.stdout.write(title + esc + '[2J'
        + draw(bottom - 3, '› ' + status)
        + draw(bottom - 2, ' ')
        + draw(bottom - 1, footer)
        + draw(bottom, '  ← for agents · ? for shortcuts')
        + esc + '[' + (bottom - 3) + ';3H' + esc + '[?25h');
    };
    process.stdin.setRawMode(true);
    let win32Buffer = '';
    let conptyBuffer = '';
    let vtBuffer = '';
    const decodeConpty = chunk => {
      if (process.platform !== 'win32') return chunk;
      conptyBuffer += chunk;
      let decoded = '';
      while (conptyBuffer.length) {
        const match = /^\x1b\[(\d+);(\d+);(\d+);([01]);\d+;\d+_/u.exec(conptyBuffer);
        if (match) {
          conptyBuffer = conptyBuffer.slice(match[0].length);
          if (match[4] === '1' && Number(match[3]) > 0) decoded += String.fromCharCode(Number(match[3]));
          continue;
        }
        if (/^\x1b(?:\[[\d;]*)?$/u.test(conptyBuffer)) break;
        decoded += conptyBuffer[0];
        conptyBuffer = conptyBuffer.slice(1);
      }
      vtBuffer += decoded;
      const tail = /\x1b(?:\[(?:<[\d;]*)?)?$/u.exec(vtBuffer)?.[0] ?? '';
      const ready = vtBuffer.slice(0, vtBuffer.length - tail.length);
      vtBuffer = tail;
      return ready;
    };
    process.stdin.on('data', bytes => {
      const input = decodeConpty(String(bytes));
      if (!input) return;
      if (input === 'q') {
        process.stdout.write(esc + '[?1049lbye\r\n');
        process.exit(0);
      }
      if (input === esc + '[A') {
        status = 'arrow-ok';
        paint();
        return;
      }
      if (input === esc + '\r') {
        status = 'shift-enter-ok';
        paint();
        return;
      }
      if (input.includes(esc + '[65;30;')) {
        win32Buffer += input;
        if (win32Buffer === esc + '[65;30;97;1;0;1_') {
          status = 'win32-ok';
          win32Buffer = '';
          paint();
        }
        return;
      }
      const mouse = input.match(/\x1b\[<0;10000;(\d+)M/);
      if (mouse) {
        status = 'mouse-' + mouse[1];
        paint();
      }
    });
    process.stdout.write(esc + '[?1049h' + esc + '[?9001h' + esc + '[>u' + esc + '[?1003h' + esc + '[?1006h');
    paint();
  `;
  const terminal = hostFixture(t, winFixture, basicHud);
  const initial = await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  if (process.platform !== 'win32') assert.ok(!terminal.painted().includes('\x1b[?9001h'));
  assert.ok(terminal.painted().includes('\x1b[>0u'));

  const promptRow = initial.findIndex(line => line.includes('› ready'));
  const hudRow = initial.findIndex(line => line.includes('[enriched] │ workspace'));
  assert.ok(promptRow >= 0 && hudRow > promptRow);

  // Split win32-input-mode sequence (outer ConPTY translates win32-input-mode before host stdin on Windows)
  await t.test('passes split win32-input-mode sequence', {
    skip: process.platform === 'win32' && 'outer ConPTY translates win32-input-mode before host stdin',
  }, async () => {
    terminal.outer.write('\x1b[65;30;');
    await delay(4);
    terminal.outer.write('97;1;0;1_');
    await terminal.observe(lines => lines.includes('› win32-ok'));
  });

  // Immediate arrow key and \x1b\r without delay
  terminal.outer.write('\x1b[A');
  await terminal.observe(lines => lines.includes('› arrow-ok'));
  terminal.outer.write('\x1b\r');
  await terminal.observe(lines => lines.includes('› shift-enter-ok'));

  // 5-digit SGR mouse coordinate: HUD click dropped, prompt click remapped
  terminal.outer.write('\x1b[<0;10000;' + (hudRow + 1) + 'M');
  await delay(50);
  assert.ok(terminal.rows().includes('› shift-enter-ok'));
  terminal.outer.write('\x1b[<0;10000;' + (promptRow + 1) + 'M');
  await terminal.observe(lines => lines.some(line => /^› mouse-\d+$/u.test(line)));

  const beforeExit = terminal.painted().length;
  terminal.outer.write('q');
  assert.equal((await terminal.result).exitCode, 0);
  await onceWrite(terminal.screen);
  const exitSeq = terminal.painted().slice(beforeExit);
  if (process.platform !== 'win32') assert.ok(!exitSeq.includes('\x1b[?9001l'));
  assert.ok(exitSeq.includes('\x1b[<1u'));
});

test('closePtyHandle isolates throwing _agent properties and methods', () => {
  closePtyHandle(null);
  closePtyHandle(undefined);
  const throwingAgent = { get _agent() { throw new Error('bad agent'); } };
  closePtyHandle(throwingAgent, 'win32');

  let calledNonWin = false;
  closePtyHandle({ _agent: { _inSocket: { destroy() { calledNonWin = true; } } } }, 'linux');
  assert.equal(calledNonWin, false);

  const calls = [];
  const brokenWorker = {
    dispose() { calls.push('dispose'); throw new Error('dispose fail'); },
    get _drainTimeout() { calls.push('drainGetter'); throw new Error('drain getter fail'); },
    _worker: { unref() { calls.push('workerUnref'); } },
  };
  closePtyHandle({
    _agent: {
      get _connectionTimeout() { throw new Error('conn timeout fail'); },
      _closeTimeout: setTimeout(() => {}, 1000),
      _inSocket: { destroy() { calls.push('inDestroy'); throw new Error('in fail'); } },
      _outSocket: { destroy() { calls.push('outDestroy'); } },
      _conoutSocketWorker: brokenWorker,
    },
  }, 'win32');
  assert.deepEqual(calls, ['inDestroy', 'outDestroy', 'dispose', 'drainGetter', 'workerUnref']);
});

test('isDefaultProcessTitle and resolveObservedTitle match default Windows exe titles and lock on custom titles', () => {
  const winNode = 'C:\\Program Files\\nodejs\\node.exe';
  for (const [title, file] of [
    [winNode, winNode],
    ['  "C:\\Program Files\\codex\\codex.exe"  ', 'C:\\Program Files\\codex\\codex.exe'],
    ['C:/Program Files/nodejs/NODE.EXE', winNode],
    ['C:\\Tools\\codex.exe', 'C:\\Tools\\codex'],
    ['C:\\Users\\Administrator\\.npm-global\\codex.exe', 'codex'],
    ['node.exe', winNode],
    ['node', winNode],
  ]) {
    assert.equal(isDefaultProcessTitle(title, file), true, `${title} vs ${file}`);
  }
  for (const [title, file] of [
    ['D:\\other\\node.exe', winNode],
    ['D:\\other\\codex.exe', 'bin\\codex.exe'],
    ['D:\\other\\codex.exe', 'C:codex.exe'],
    ['C:\\Windows\\System32\\cmd.exe', 'codex'],
    ['Unrelated title', winNode],
    ['', winNode],
    [winNode, ''],
  ]) {
    assert.equal(isDefaultProcessTitle(title, file), false, `${title} vs ${file}`);
  }

  assert.deepEqual(resolveObservedTitle(winNode, winNode, false, 'win32'), { title: '', sawCustomTitle: false });
  assert.deepEqual(resolveObservedTitle('', winNode, false, 'win32'), { title: '', sawCustomTitle: false });
  assert.deepEqual(resolveObservedTitle('D:\\other\\node.exe', winNode, false, 'win32'), {
    title: 'D:\\other\\node.exe', sawCustomTitle: true,
  });
  assert.deepEqual(resolveObservedTitle('Unrelated title', winNode, false, 'win32'), {
    title: 'Unrelated title', sawCustomTitle: true,
  });
  assert.deepEqual(resolveObservedTitle(winNode, winNode, true, 'win32'), {
    title: winNode, sawCustomTitle: true,
  });
  assert.deepEqual(resolveObservedTitle(winNode, winNode, false, 'linux'), {
    title: winNode, sawCustomTitle: true,
  });
});

test('inspectFooter rejects folded modal continuations ending in ellipsis after a complete metric', () => {
  const base = (rowLine, nextLine) => [
    '› Ask Codex to do anything',
    '',
    `  ${firstId} · GPT-6.2-Astra max · ${rowLine}`,
    nextLine,
  ];
  for (const [metric, continuation] of [
    ['0.172.0', '  Select a model to switch…'],
    ['Context 25% used', '  Select…'],
    ['5h 50% left', '  Select…'],
    ['Tasks 1/2', '  Select…'],
  ]) {
    assert.equal(inspectFooter(base(metric, continuation), abbreviated(firstId), 0), undefined);
  }
});

test('startup HUD yields to blank-bottom modals, hides on startup A3 overflow, and rejects non-empty spacer modals', { timeout: 10000 }, async t => {
  const fixture = String.raw`
    const esc = '\x1b';
    const draw = (row, line) => esc + '[' + row + ';1H' + line;
    const id = ${JSON.stringify(firstId)};
    const title = ${JSON.stringify('\x1b]2;' + abbreviated(firstId) + '\x07')};
    const blank = esc + '[48;5;236m ' + esc + '[0m';
    process.stdin.setRawMode(true);
    process.stdout.write(esc + '[?1049h' + esc + '[2J'
      + draw(process.stdout.rows - 2, '› Ask Codex to do anything')
      + draw(process.stdout.rows - 1, blank)
      + draw(process.stdout.rows, '  ? for shortcuts')
      + esc + '[' + (process.stdout.rows - 2) + ';3H' + esc + '[?25h');
    process.stdin.on('data', bytes => {
      const b = process.stdout.rows;
      const cmd = String(bytes);
      if (cmd === 'm') {
        // Blank-bottom centered modal with hidden cursor and › line above blank spacer
        process.stdout.write(esc + '[2J'
          + draw(b - 2, '› Select theme')
          + draw(b - 1, ' ')
          + draw(b, ' ')
          + esc + '[1;1H' + esc + '[?25l');
      } else if (cmd === 'd') {
        process.stdout.write(esc + '[2J'
          + draw(b - 3, '› Ask Codex to do anything')
          + draw(b - 2, blank)
          + draw(b - 1, '  gpt-5.4 default · Context 0% used · 0.172.0')
          + draw(b, '  ← for agents · ? for shortcuts')
          + esc + '[' + (b - 3) + ';3H' + esc + '[?25h');
      } else if (cmd === 'o') {
        const rows = ['› line 1', ...Array.from({ length: 18 }, (_, i) => '  overflow ' + i)];
        const start = Math.max(1, b - 1 - rows.length);
        let out = esc + '[2J';
        rows.forEach((line, idx) => { out += draw(start + idx, line); });
        out += draw(b - 1, blank) + draw(b, '  ← for agents · ? for shortcuts')
          + esc + '[' + start + ';3H' + esc + '[?25h';
        process.stdout.write(out);
      } else if (cmd === 'n') {
        process.stdout.write(title + esc + '[2J'
          + draw(b - 3, '› Prompt')
          + draw(b - 2, blank)
          + draw(b - 1, '  ' + id + ' · GPT-6.2-Sol default · Context 10% used · 0.172.0')
          + draw(b, '  ← for agents · ? for shortcuts')
          + esc + '[' + (b - 3) + ';3H' + esc + '[?25h');
      } else if (cmd === 's') {
        // Non-empty spacer above UUID footer with visible cursor on › Prompt
        process.stdout.write(title + esc + '[2J'
          + draw(b - 3, '› Prompt')
          + draw(b - 2, '  Non-empty spacer modal row')
          + draw(b - 1, '  ' + id + ' · GPT-6.2-Sol default · Context 10% used · 0.172.0')
          + draw(b, '  ← for agents · ? for shortcuts')
          + esc + '[' + (b - 3) + ';3H' + esc + '[?25h');
      } else if (cmd === 'q') {
        process.exit(0);
      }
    });
  `;
  const terminal = hostFixture(t, fixture, basicHud);
  await terminal.observe(lines => lines.includes('workspace'));

  terminal.outer.write('m');
  const modal = await terminal.observe(lines => lines.includes('› Select theme'));
  assert.ok(!modal.some(line => line.includes('workspace')));

  terminal.outer.write('d');
  await terminal.observe(lines => lines.includes('[gpt-5.4] │ workspace'));
  terminal.outer.write('o');
  const overflow = await terminal.observe(lines => lines.includes('overflow 17'));
  assert.ok(!overflow.some(line => line.includes('workspace')));

  terminal.outer.write('n');
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));
  terminal.outer.write('s');
  const badSpacer = await terminal.observe(lines => lines.includes('Non-empty spacer modal row'));
  assert.ok(!badSpacer.some(line => line.includes('workspace')));

  terminal.outer.write('q');
  assert.equal((await terminal.result).exitCode, 0);
});

test('settleFrozen ignores pure CSI, thaws on consecutive resize to modal, and crops bottom on steep shrink', { timeout: 10000 }, async t => {
  const fixture = String.raw`
    const esc = '\x1b';
    const draw = (row, line) => esc + '[' + row + ';1H' + line;
    const id = ${JSON.stringify(firstId)};
    const title = ${JSON.stringify('\x1b]2;' + abbreviated(firstId) + '\x07')};
    const native = '  ' + id + ' · GPT-6.2-Sol default · Context 12% used · 0.172.0';
    const shortcuts = '  ← for agents · ? for shortcuts';
    const blank = esc + '[48;5;236m ' + esc + '[0m';
    let mode = 'normal';
    function frame(body) {
      const b = process.stdout.rows;
      return title + esc + '[2J' + draw(b - 4, body) + draw(b - 3, '› Bottom composer')
        + draw(b - 2, blank) + draw(b - 1, native) + draw(b, shortcuts)
        + esc + '[' + (b - 3) + ';3H' + esc + '[?25h';
    }
    function tallComposer() {
      const b = process.stdout.rows;
      let out = title + esc + '[2J' + draw(1, '› line 0');
      for (let r = 2; r <= b - 3; r++) out += draw(r, '  line ' + (r - 1));
      return out + draw(b - 2, blank) + draw(b - 1, native) + draw(b, shortcuts)
        + esc + '[3;3H' + esc + '[?25h';
    }
    process.stdin.setRawMode(true);
    process.stdout.on('resize', () => {
      if (mode === 'hold-csi') {
        process.stdout.write(esc + '[2J' + esc + '[?2026h' + esc + '[?25l' + esc + '[1;1H');
      } else if (mode === 'sync-modal') {
        process.stdout.write(esc + '[?2026h' + esc + '[2J' + draw(process.stdout.rows - 2, '› Select model')
          + draw(process.stdout.rows, '  enter select · esc back') + esc + '[?25l' + esc + '[?2026l');
      } else if (mode === 'steep-shrink') {
        // Delay redraw beyond paint so frozen bottom-cropping is observed first (< frozenTimeout 200ms)
        process.stdout.write(esc + '[2J');
        setTimeout(() => process.stdout.write(frame('Adapted short')), 150);
      }
    });
    process.stdin.on('data', bytes => {
      const cmd = String(bytes);
      if (cmd === '1') mode = 'hold-csi';
      else if (cmd === '2') { mode = 'sync-modal'; process.stdout.write(frame('Before modal resize')); }
      else if (cmd === '3') { mode = 'steep-shrink'; process.stdout.write(tallComposer()); }
      else if (cmd === 'q') process.exit(0);
    });
    process.stdout.write(esc + '[?1049h' + frame('Initial'));
  `;
  const terminal = hostFixture(t, fixture, basicHud);
  await terminal.observe(lines => lines.includes('[enriched] │ workspace'));

  // 1. Pure CSI after blank 2J must not early-thaw frozen frame within 70ms (< frozenTimeout 200ms)
  terminal.outer.write('1');
  terminal.screen.resize(96, 23);
  terminal.outer.resize(96, 23);
  await delay(75);
  assert.ok(terminal.rows().includes('[enriched] │ workspace'));

  // 2. Consecutive resize after child opens a modal must immediately clear stale frozen frame
  terminal.outer.write('2');
  await terminal.observe(lines => lines.includes('Before modal resize'));
  terminal.screen.resize(94, 22);
  terminal.outer.resize(94, 22);
  await delay(40);
  terminal.screen.resize(92, 21);
  terminal.outer.resize(92, 21);
  const modal = await terminal.observe(lines => lines.includes('› Select model'));
  assert.ok(!modal.some(line => line.includes('workspace')));

  // 3. Steep shrink when withHud returns undefined crops frozen bottom, masks native UUID, and guards cursor row
  terminal.outer.write('3');
  await terminal.observe(lines => lines.includes('line 17'));
  const beforeShrink = terminal.painted().length;
  terminal.screen.resize(92, 7);
  terminal.outer.resize(92, 7);
  const croppedRows = await terminal.observe(lines => lines.some(line => line.includes('line 17')) && lines.includes('[enriched] │ workspace'));
  assert.ok(!croppedRows.some(line => line.includes(firstId)));
  const shrinkPainted = terminal.painted().slice(beforeShrink);
  assert.ok(shrinkPainted.includes('line 17'));
  assert.ok(shrinkPainted.includes('[enriched] │ workspace'));
  assert.ok(!shrinkPainted.includes(firstId));
  assert.doesNotMatch(shrinkPainted, /\x1b\[-\d+/u);
  const adapted = await terminal.observe(lines => lines.includes('Adapted short'));
  assert.ok(adapted.includes('[enriched] │ workspace'));

  terminal.outer.write('q');
  assert.equal((await terminal.result).exitCode, 0);
});

test('flushes lone Esc after paintDelay and buffers split bracketed paste sequences', { timeout: 10000 }, async t => {
  const { Terminal } = require('@xterm/headless');
  const url = new URL('../lib/terminal-host.mjs', import.meta.url).href;
  const childFixture = String.raw`
    const esc = '\x1b';
    const bottom = process.stdout.rows;
    const draw = (row, line) => esc + '[' + row + ';1H' + line;
    const id = ${JSON.stringify(firstId)};
    const title = ${JSON.stringify('\x1b]2;' + abbreviated(firstId) + '\x07')};
    const footer = '  ' + id + ' · GPT-6.2-Sol default · Context 0% used · 0.172.0';
    let status = 'ready';
    const paint = () => {
      process.stdout.write(title + esc + '[2J'
        + draw(bottom - 3, '› ' + status)
        + draw(bottom - 2, ' ')
        + draw(bottom - 1, footer)
        + draw(bottom, '  ← for agents · ? for shortcuts')
        + esc + '[' + (bottom - 3) + ';3H' + esc + '[?25h');
    };
    process.stdin.setRawMode(true);
    let pasteBuf = '';
    process.stdin.on('data', bytes => {
      const s = String(bytes);
      if (s === 'q') process.exit(0);
      if (s === esc) { status = 'lone-esc'; paint(); return; }
      pasteBuf += s;
      const m = pasteBuf.match(/\x1b\[200~[\s\S]*?([0-9]+)M[\s\S]*?\x1b\[201~/);
      if (m) { status = 'paste-' + m[1]; pasteBuf = ''; paint(); }
    });
    process.stdout.write(esc + '[?1049h');
    paint();
  `;
  const hostCode = `
    import { runTerminal } from ${JSON.stringify(url)};
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    process.stdin.setRawMode = () => {};
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.stdout.columns = 100;
    process.stdout.rows = 24;
    process.exitCode = await runTerminal({
      file: process.execPath,
      args: ['-e', ${JSON.stringify(childFixture)}],
      ${basicHud}
    });
  `;
  const proc = spawnChild(process.execPath, ['--input-type=module', '-e', hostCode], { stdio: ['pipe', 'pipe', 'pipe'] });
  const screen = new Terminal({ cols: 100, rows: 24, allowProposedApi: true, scrollback: 0 });
  let exited = false;
  const done = new Promise(resolve => proc.once('exit', code => { exited = true; resolve(code); }));
  proc.stdout.on('data', d => screen.write(d));
  t.after(() => { if (!exited) proc.kill(); screen.dispose(); });
  const rows = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true).trim() ?? '');
  const observe = async predicate => {
    for (let e = 0; e < 4000 && !exited; e += 20) {
      const l = rows();
      if (predicate(l)) return l;
      await delay(20);
    }
    assert.fail(rows().join('\n'));
  };

  await observe(lines => lines.includes('[enriched] │ workspace'));
  proc.stdin.write('\x1b');
  await observe(lines => lines.includes('› lone-esc'));

  // Split \x1b[200~ ... \x1b[201~ bracketed paste around a HUD-row SGR mouse sequence
  proc.stdin.write('\x1b[20');
  await delay(4);
  proc.stdin.write('0~\x1b[<0;3;23M\x1b[20');
  await delay(4);
  proc.stdin.write('1~');
  await observe(lines => lines.includes('› paste-23'));

  proc.stdin.write('q');
  assert.equal(await done, 0);
});

function hostFixture(t, fixture, readers, cols = 100, height = 24, trace) {
  const { spawn } = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const url = new URL('../lib/terminal-host.mjs', import.meta.url).href;
  const outerCode = `
    import { runTerminal } from ${JSON.stringify(url)};
    ${trace ? `
      import { appendFileSync } from 'node:fs';
      const write = process.stdout.write;
      process.stdout.write = function (chunk, ...args) {
        appendFileSync(${JSON.stringify(trace)}, chunk);
        return write.call(this, chunk, ...args);
      };
    ` : ''}
    process.exitCode = await runTerminal({
      file: process.execPath,
      args: ['-e',${JSON.stringify(fixture)}],
      ${readers}
    });
  `;
  const screen = new Terminal({ cols, rows: height, allowProposedApi: true, scrollback: 0 });
  const outer = spawn(process.execPath, ['--input-type=module', '-e', outerCode], {
    cols, rows: height, env: process.env, name: 'xterm-256color',
  });
  const result = new Promise(resolve => outer.onExit(resolve));
  let exited = false;
  void result.then(() => { exited = true; });
  let painted = '';
  const output = outer.onData(data => { painted += data; screen.write(data); });
  t.after(() => {
    if (!exited) outer.kill();
    closePtyHandle(outer);
    output.dispose();
    screen.dispose();
  });
  const rows = () => Array.from({ length: screen.rows }, (_, index) => screen.buffer.active.getLine(index)?.translateToString(true).trim() ?? '');
  async function observe(predicate) {
    for (let elapsed = 0; elapsed < 4000 && !exited; elapsed += 20) {
      const lines = rows();
      if (predicate(lines)) return lines;
      await delay(20);
    }
    assert.fail(rows().join('\n'));
  }
  return { outer, screen, result, rows, observe, painted: () => painted };
}

function onceWrite(screen) {
  return new Promise(resolve => screen.write('', resolve));
}
