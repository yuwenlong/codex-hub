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
  const { outer, screen, result, rows, observe, painted } = hostFixture(t, fixture, `
    async readHud({ threadId }) {
      if (threadId === ${JSON.stringify(secondId)}) await new Promise(resolve => setTimeout(resolve, 160));
      return threadId === ${JSON.stringify(firstId)} ? ${JSON.stringify(idleHud)} : '[two] │ project\\n◐ agent running';
    }
  `);

  const idle = await observe(lines => lines.some(line => line.startsWith('[one]')));
  const prompt = idle.findIndex(line => line.includes('Ask Codex'));
  const hud = idle.findIndex(line => line.startsWith('[one]'));
  assert.ok(prompt >= 0 && hud === prompt + 2, idle.join('\n'));
  assert.match(idle[hud + 3], /for shortcuts/u);
  assert.doesNotMatch(idle.join('\n'), new RegExp(firstId, 'u'));
  assert.equal(screen.buffer.active.getLine(hud).getCell(0).getFgColor(), 4);
  assert.ok(painted().includes(workspaceLink + 'project' + closedLink));
  assert.doesNotMatch(painted(), /example\.invalid/u);

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

function hostFixture(t, fixture, readers, cols = 100, height = 24) {
  const { spawn } = require('node-pty');
  const { Terminal } = require('@xterm/headless');
  const url = new URL('../lib/terminal-host.mjs', import.meta.url).href;
  const outerCode = `
    import { runTerminal } from ${JSON.stringify(url)};
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
  return { outer, screen, result, rows, observe, painted: () => painted };
}

function onceWrite(screen) {
  return new Promise(resolve => screen.write('', resolve));
}
