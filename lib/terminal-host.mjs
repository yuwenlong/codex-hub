import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

const require = createRequire(import.meta.url);
const titleId = /^([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{5,12})(?:\.{3}|…)?$/iu;
const footerId = /^\s{0,3}([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}) · (.+)$/iu;
const effortName = / (default|minimal|low|medium|high|xhigh|max|none|ultra)$/iu;
const composerPrompt = /^\s{0,3}[›❯](?: |$)/u;
const hintStart = / {2,}(?=(?:←|⚠|\? for |(?:Ctrl|Alt|Shift)[+-]))/u;
const sgr = /\x1b\[[\d;]{0,40}m|[\p{Cc}\p{Cf}]/gu;
const hudCommands = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[\d;]{0,40}m|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const closeLink = '\x1b]8;;\x1b\\';
const inputSequence = /\x1b\[(200~|201~|<(\d{1,4});(\d{1,4});(\d{1,4})([Mm]))/gu;
const unfinishedInput = /\x1b(?:\[(?:<(?:\d{1,4};){0,2}\d{0,4}|2(?:0[01]?)?)?)?$/u;
const reset = '\x1b[0m';
const paintDelay = 24;
const pollDelay = 1000;
const nativeLoadError = /^Failed to load native module: (?:pty|conpty)\.node, checked: /u;

export class TerminalDependencyError extends Error {
  constructor(cause) {
    super('Could not load terminal dependencies.', { cause });
  }
}

function terminalDependency(name) {
  try {
    return require(name);
  } catch (error) {
    if (['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(error.code) || nativeLoadError.test(error.message)) {
      throw new TerminalDependencyError(error);
    }
    throw error;
  }
}

export function inspectFooter(lines, title, cursorRow, cursorVisible = true) {
  const prefix = titleId.exec(title)?.[1].toLowerCase();
  if (!prefix || !cursorVisible) return;
  const prompt = lines.findLastIndex((line, row) => row <= cursorRow && composerPrompt.test(line));
  if (prompt === -1) return;
  for (let row = lines.length - 1; row >= Math.max(cursorRow + 1, lines.length - 4); row--) {
    const match = footerId.exec(lines[row]);
    if (!match || !match[1].toLowerCase().startsWith(prefix)) continue;
    const [fields, hint] = match[2].split(hintStart, 2);
    const [label, ...rest] = fields.trim().split(' · ');
    if (!label || /^Context \d|% left$/u.test(label)) continue;
    const effort = effortName.exec(label);
    const result = {
      row, hint, threadId: match[1].toLowerCase(),
    };
    if (!/(?:…|\.{3})$/u.test(label)) {
      result.model = effort ? label.slice(0, effort.index) : label;
      result.reasoning = effort?.[1];
    }
    for (const value of rest) {
      const context = /^Context (\d{1,3})% used$/u.exec(value);
      const limit = /^(5h|five-hour|weekly|7d) (\d{1,3})% left$/u.exec(value);
      if (context && Number(context[1]) <= 100) result.contextPercent = Number(context[1]);
      if (limit && Number(limit[2]) <= 100) {
        result.limits ??= {};
        const period = /^(?:weekly|7d)$/u.test(limit[1]) ? 'weekly' : 'fiveHour';
        result.limits[period] = { remainingPercent: Number(limit[2]) };
      }
      if (/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(value)) result.version = value;
      const progress = /^Tasks (\d+)\/(\d+)$/u.exec(value);
      if (progress) {
        const [, completedText, totalText] = progress;
        const completed = Number(completedText);
        const total = Number(totalText);
        if (Number.isSafeInteger(total) && total > 0 && completed <= total) {
          result.taskProgress = { completed, total };
        }
      }
    }
    return result;
  }
}

function cellStyle(cell) {
  const style = [];
  if (cell.isBold()) style.push(1);
  if (cell.isDim()) style.push(2);
  if (cell.isItalic()) style.push(3);
  if (cell.isUnderline()) style.push(4);
  if (cell.isBlink()) style.push(5);
  if (cell.isInverse()) style.push(7);
  if (cell.isInvisible()) style.push(8);
  if (cell.isStrikethrough()) style.push(9);
  if (cell.isOverline?.()) style.push(53);
  const foreground = cell.getFgColor();
  const background = cell.getBgColor();
  if (cell.isFgPalette()) style.push(38, 5, foreground);
  if (cell.isBgPalette()) style.push(48, 5, background);
  if (cell.isFgRGB()) style.push(38, 2, foreground >> 16 & 255, foreground >> 8 & 255, foreground & 255);
  if (cell.isBgRGB()) style.push(48, 2, background >> 16 & 255, background >> 8 & 255, background & 255);
  return style.join(';');
}

function renderRow(line, cell) {
  let result = '';
  let previous = '';
  let blanks = 0;
  for (let column = 0; line && column < line.length; column++) {
    if (!line.getCell(column, cell)?.getWidth()) continue;
    const chars = cell.getChars();
    const style = cellStyle(cell);
    if (!chars && !style) {
      blanks++;
      continue;
    }
    if (blanks) {
      if (previous) result += reset;
      previous = '';
      result += ' '.repeat(blanks);
      blanks = 0;
    }
    if (style !== previous) {
      result += style ? '\x1b[0;' + style + 'm' : reset;
      previous = style;
    }
    result += chars || ' ';
  }
  return previous ? result + reset : result;
}

const move = (row, column = 0) => '\x1b[' + (row + 1) + ';' + (column + 1) + 'H';
const decMode = (mode, enabled) => '\x1b[?' + mode + (enabled ? 'h' : 'l');
const mouseModes = { x10: 9, vt200: 1000, drag: 1002, any: 1003 };

function hudRows(value, height) {
  return typeof value === 'string'
    ? value.slice(0, 20_000).split('\n').slice(0, height)
      .map(cleanHudLine)
      .filter(line => line.trim())
    : [];
}

function localFileLink(href) {
  if (!/^file:\/\/\/(?!\/)[\x21-\x7e]*$/u.test(href) || /\\|%(?:2f|5c)/iu.test(href)) return false;
  try {
    const url = new URL(href);
    return url.href === href && !url.host && !url.search && !url.hash
      && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

function cleanHudLine(line) {
  let linked = false;
  const cleaned = line.replace(hudCommands, (command, params, href) => {
    if (params === undefined) return command.startsWith('\x1b[') ? command : '';
    if (params || !command.endsWith('\x1b\\')) return '';
    if (!href) {
      const closing = linked ? closeLink : '';
      linked = false;
      return closing;
    }
    if (!localFileLink(href)) return '';
    const opening = (linked ? closeLink : '') + command;
    linked = true;
    return opening;
  });
  return cleaned + (linked ? closeLink : '');
}

function readScreen(terminal, cursorVisible, title) {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const lines = Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row));
  const plain = lines.map(line => line?.translateToString(true) ?? '');
  return {
    plain,
    rendered: lines.map(line => renderRow(line, cell)),
    cursorRow: buffer.cursorY,
    cursorColumn: buffer.cursorX,
    footer: buffer.type === 'alternate' && inspectFooter(plain, title, buffer.cursorY, cursorVisible),
  };
}

function withHud({ plain, rendered, cursorRow, footer }, overlay, height) {
  const composed = rendered.slice();
  const rowMap = rendered.map((_, row) => row);
  composed.splice(footer.row, 1, ...overlay);
  rowMap.splice(footer.row, 1, ...overlay.map(() => null));

  // Codex can wait for input before redrawing after SIGWINCH. Keep the child viewport steady
  // when the HUD grows, using blank space first and then old visible transcript rows.
  const prompt = plain.findLastIndex((line, row) => row <= cursorRow && composerPrompt.test(line));
  const beforeInput = (prompt === -1 ? cursorRow : prompt) - 1;
  const removable = Math.max(0, beforeInput);
  const excess = composed.length - height;
  if (excess > removable) return;
  const removed = new Set();
  for (let row = removable - 1; row >= 0 && removed.size < excess; row--) {
    if (!plain[row].trim()) removed.add(row);
  }
  for (let row = 0; removed.size < excess; row++) removed.add(row);
  const newMap = rowMap.filter((_, row) => !removed.has(row));
  return {
    lines: composed.filter((_, row) => !removed.has(row)),
    rowMap: newMap,
    cursorRow: newMap.indexOf(cursorRow),
  };
}

export async function runTerminal({ file, args = [], env = process.env, cwd = process.cwd(), readHud }) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('The embedded HUD requires an interactive terminal.');
  const { Terminal } = terminalDependency('@xterm/headless');
  const { spawn } = terminalDependency('node-pty');
  const dimensions = () => ({
    columns: Math.min(500, stdout.columns || 80),
    rows: Math.min(200, stdout.rows || 24),
  });
  let { columns, rows } = dimensions();
  const terminal = new Terminal({ cols: columns, rows, scrollback: 200, allowProposedApi: true });
  let child;
  try {
    child = spawn(file, args, { cwd, env, name: 'xterm-256color', cols: columns, rows });
  } catch (error) {
    terminal.dispose();
    // node-pty loads its Windows native module before opening the ConPTY session.
    if (process.platform === 'win32' && nativeLoadError.test(error.message)) throw new TerminalDependencyError(error);
    throw error;
  }

  const wasRaw = Boolean(stdin.isRaw);
  const wasFlowing = stdin.readableFlowing === true;
  const subscriptions = [];
  const inputDecoder = new StringDecoder('utf8');
  let bufferedBytes = 0;
  let paused = false;
  let blockedOutput = false;
  let title = '';
  let session;
  let refreshPending = false;
  let frozen;
  let rowMap;
  let inPaste = false;
  let pendingInput = '';
  let inputTimer;
  let painted = [];
  let terminalModes = '';
  let terminalCursor = '';
  let cursorVisible = true;
  let cursorStyle = 0;
  let keyboardStack = 0;
  let frameTimer;
  let tick;
  let stopped = false;
  let closing = false;
  let outputFailure = false;

  const hudHeight = () => Math.max(0, Math.min(12, Math.floor((rows - 6) / 2)));
  function resize() {
    const next = dimensions();
    if (columns === next.columns && rows === next.rows) return;
    const current = frozen ?? readScreen(terminal, cursorVisible, title);
    frozen = current.footer ? current : undefined;
    ({ columns, rows } = next);
    terminal.resize(columns, rows);
    child.resize(columns, rows);
    if (session) session.refreshAt = 0;
    painted = [];
    queuePaint();
  }

  function listenFooter(footer) {
    if (session?.threadId !== footer.threadId) {
      session?.controller.abort();
      session = { threadId: footer.threadId, controller: new AbortController(), value: '', refreshAt: 0 };
    }
    if (refreshPending || session.refreshAt > Date.now()) return;
    const requested = session;
    const { row, hint, ...metrics } = footer;
    requested.refreshAt = Date.now() + pollDelay;
    refreshPending = true;
    void Promise.resolve().then(() => readHud({
      ...metrics, columns, rows: hudHeight(), signal: requested.controller.signal,
    })).then(value => {
      if (session === requested && !stopped) requested.value = value;
    }).catch(() => {}).finally(() => {
      refreshPending = false;
      queuePaint();
    });
  }

  function queuePaint() {
    if (!stopped && !frameTimer && !blockedOutput) frameTimer = setTimeout(paint, paintDelay);
  }

  function paint() {
    frameTimer = undefined;
    if (stopped || blockedOutput) return;
    const screen = frozen ?? readScreen(terminal, cursorVisible, title);
    const footer = columns >= 42 && hudHeight() && screen.footer;
    let overlay = [];
    if (footer) {
      listenFooter(footer);
      overlay = hudRows(session.value, hudHeight());
      if (overlay.length && footer.hint) {
        overlay = overlay.slice(0, Math.max(1, hudHeight() - 1));
        overlay.push('\x1b[2m  ' + footer.hint.replace(sgr, '') + reset);
      }
    }
    const altered = overlay.length ? withHud(screen, overlay, rows) : undefined;
    rowMap = frozen ? [] : altered?.rowMap;
    const composed = altered?.lines ?? screen.rendered;
    const modes = terminal.modes;
    const mouse = mouseModes[modes.mouseTrackingMode];
    const nextModes = decMode(1, modes.applicationCursorKeysMode)
      + (modes.applicationKeypadMode ? '\x1b=' : '\x1b>')
      + decMode(1004, modes.sendFocusMode) + decMode(2004, modes.bracketedPasteMode)
      + [9, 1000, 1002, 1003].map(mode => decMode(mode, false)).join('')
      + decMode(1006, Boolean(mouse)) + (mouse ? decMode(mouse, true) : '');
    let frame = nextModes === terminalModes ? '' : nextModes;
    terminalModes = nextModes;
    let changes = '';
    for (let row = 0; row < rows; row++) {
      const line = composed[row] ?? '';
      if (line === painted[row]) continue;
      changes += move(row) + reset + '\x1b[2K' + line;
      painted[row] = line;
    }
    const physicalRow = Math.min(rows - 1, altered?.cursorRow ?? screen.cursorRow);
    const cursor = move(physicalRow, Math.min(columns - 1, screen.cursorColumn))
      + '\x1b[' + cursorStyle + ' q' + decMode(25, cursorVisible);
    if (changes) frame += decMode(25, false) + decMode(7, false) + changes + reset + decMode(7, true);
    if (changes || cursor !== terminalCursor) frame += cursor;
    terminalCursor = cursor;
    if (frame) blockedOutput = !stdout.write(frame);
  }

  function input(chunk) {
    clearTimeout(inputTimer);
    const decoded = typeof chunk === 'string' ? chunk : inputDecoder.write(chunk);
    const bytes = pendingInput + decoded;
    pendingInput = unfinishedInput.exec(bytes)?.[0] || '';
    if (pendingInput) {
      inputTimer = setTimeout(() => {
        if (!closing) child.write(pendingInput);
        pendingInput = '';
      }, paintDelay);
    }
    const ready = bytes.slice(0, bytes.length - pendingInput.length)
      .replace(inputSequence, (full, kind, button, column, y, action) => {
        if (kind === '200~' || kind === '201~') {
          inPaste = kind === '200~';
          return full;
        }
        if (inPaste || !rowMap) return full;
        const row = rowMap[Number(y) - 1];
        return row == null ? '' : '\x1b[<' + button + ';' + column + ';' + (row + 1) + action;
      });
    if (ready && !closing) child.write(ready);
  }

  function drained() {
    blockedOutput = false;
    queuePaint();
  }

  const stopChild = signal => {
    if (closing || stopped) return;
    closing = true;
    try {
      if (process.platform === 'win32') child.kill();
      else child.kill(signal);
    } catch { /* The exit callback can already be pending. */ }
  };
  const onInterrupt = () => stopChild('SIGINT');
  const onHangup = () => stopChild('SIGHUP');
  const onTerminate = () => stopChild('SIGTERM');
  const onResize = () => resize();
  const onOutputError = () => { outputFailure = true; stopChild('SIGHUP'); };

  const completed = new Promise(resolve => {
    subscriptions.push(child.onExit(({ exitCode, signal }) => {
      closing = true;
      terminal.write('', () => resolve(signal ? 128 + signal : exitCode));
    }));
  });
  try {
    stdin.setRawMode(true);
    stdout.on('error', onOutputError);
    stdout.write(decMode(1049, true) + '\x1b[2J' + move(0));
    stdin.on('data', input);
    stdin.resume();
    stdout.on('resize', onResize);
    stdout.on('drain', drained);
    process.on('SIGINT', onInterrupt);
    process.on('SIGHUP', onHangup);
    process.on('SIGTERM', onTerminate);
    subscriptions.push(
      terminal.onTitleChange(next => {
        title = next;
        if (session && !session.threadId.startsWith(titleId.exec(next)?.[1].toLowerCase() || '/')) {
          session.controller.abort();
          session = undefined;
        }
      }),
      terminal.onData(data => { if (!closing) child.write(data); }),
      terminal.onBell(() => stdout.write('\x07')),
      ...['h', 'l'].map(final => terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(25)) cursorVisible = final === 'h';
        return false;
      })),
      terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, ([value]) => {
        if (Number.isInteger(value) && value >= 0 && value <= 6) cursorStyle = value;
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
        stdout.write('\x1b[?u');
        return true;
      }),
      terminal.parser.registerCsiHandler({ prefix: '>', final: 'u' }, ([value]) => {
        if (keyboardStack < 8 && Number.isInteger(value) && value >= 0 && value <= 31) {
          stdout.write('\x1b[>' + value + 'u');
          keyboardStack++;
        }
        return true;
      }),
      terminal.parser.registerCsiHandler({ prefix: '<', final: 'u' }, ([number]) => {
        const count = Math.min(keyboardStack, Number.isInteger(number) && number > 0 ? number : 1);
        if (count) stdout.write('\x1b[<' + count + 'u');
        keyboardStack -= count;
        return true;
      }),
      terminal.parser.registerOscHandler(52, data => {
        if (/^[cps0-7]*;[\w+/=]{1,1048576}$/u.test(data)) stdout.write('\x1b]52;' + data + '\x1b\\');
        return true;
      }),
      child.onData(data => {
        bufferedBytes += data.length;
        if (bufferedBytes >= 512 * 1024 && !paused) {
          paused = true;
          child.pause();
        }
        terminal.write(data, () => {
          frozen = undefined;
          bufferedBytes -= data.length;
          if (paused && bufferedBytes < 256 * 1024 && !closing) {
            paused = false;
            child.resume();
          }
          queuePaint();
        });
      }),
    );
    tick = setInterval(queuePaint, 250);
    return await completed;
  } finally {
    if (!closing) stopChild('SIGTERM');
    stopped = true;
    session?.controller.abort();
    clearInterval(tick);
    clearTimeout(frameTimer);
    clearTimeout(inputTimer);
    for (const subscription of subscriptions) subscription.dispose();
    stdin.off('data', input);
    if (!wasFlowing) stdin.pause();
    stdin.setRawMode(wasRaw);
    stdout.off('resize', onResize);
    stdout.off('drain', drained);
    process.off('SIGINT', onInterrupt);
    process.off('SIGHUP', onHangup);
    process.off('SIGTERM', onTerminate);
    if (!outputFailure) {
      const restore = [1, 9, 1000, 1002, 1003, 1004, 1006, 2004].map(mode => decMode(mode, false)).join('');
      stdout.write(restore + (keyboardStack ? '\x1b[<' + keyboardStack + 'u' : '')
        + '\x1b>' + reset + '\x1b[0 q' + decMode(7, true) + decMode(25, true) + decMode(1049, false));
      const normal = terminal.buffer.normal;
      const cell = normal.getNullCell();
      const output = Array.from({ length: normal.length }, (_, row) => renderRow(normal.getLine(row), cell));
      while (output.length && !output.at(-1)) output.pop();
      if (output.length) stdout.write(output.join('\n') + '\n');
    }
    stdout.off('error', onOutputError);
    terminal.dispose();
  }
}
