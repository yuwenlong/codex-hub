import { createRequire } from 'node:module';
import { win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const require = createRequire(import.meta.url);
const titleId = /^([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{5,12})(?:\.{3}|…)?$/iu;
const footerId = /^ {0,3}([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})(?: ·(?: (.*))?)?$/iu;
const effortName = / (default|minimal|low|medium|high|xhigh|max|none|ultra)$/iu;
const composerPrompt = /^\s{0,3}[›❯](?: |$)/u;
const initialPrompt = '› Ask Codex to do anything';
const shutdownPrompt = '› Shutting down...';
const composerShortcuts = /^(?: {2}(?:← for agents(?: · \? for shortcuts)?|\? for shortcuts|tab to queue message|esc(?: again)? to edit previous message|(?:enter\/)?esc latest(?: · \? (?:for )?shortcuts)?|(?:[Cc]trl\+[Cc]|\^[Cc]) copy · enter copy & follow · esc clear)(?: {2,}⚠.*)?| +⚠.*) *$/u;
const workingStatus = /^ {0,3}[•◦] .*\([^)\n]* • esc to interrupt\)(?: · .*|$)/u;
const hintStart = / {2,}(?=(?:←|⚠|\? for |(?:Ctrl|Alt|Shift)[+-]))/u;
const sgr = /\x1b\[[\d;]{0,40}m|[\p{Cc}\p{Cf}]/gu;
const hudCommands = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[\d;]{0,40}m|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const closeLink = '\x1b]8;;\x1b\\';
const inputSequence = /\x1b\[(200~|201~|<(\d{1,5});(\d{1,5});(\d{1,5})([Mm]))/gu;
const unfinishedInput = /\x1b(?:\[(?:<(?:\d{1,5};){0,2}\d{0,5}|\d{0,5}(?:[;:]\d{0,5}){0,5})?)?$/u;
const completedMetricPrefix = /^(?:Context \d{1,3}% used|(?:5h|five-hour|weekly|7d) \d{1,3}% left|\d+\.\d+\.\d+(?:-[\w.]+)?|T ?a ?s ?k ?s \d+(?: \d+)? *\/ *\d+(?: \d+)?) /u;
const nonModifyingControl = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[ABCDEFGHIZacdefhlmnqsu]|[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]/gu;
const reset = '\x1b[0m';
const paintDelay = 24;
const blankTimeout = 120;
const frozenTimeout = 200;
const pollDelay = 1000;
const syncTimeout = 1000;
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

export function closePtyHandle(ptyProcess, platform = process.platform) {
  if (platform !== 'win32' || !ptyProcess) return;
  let agent;
  try { agent = ptyProcess._agent; } catch { return; }
  if (!agent) return;
  let worker;
  try { worker = agent._conoutSocketWorker; } catch {}
  for (const step of [
    () => clearTimeout(agent._connectionTimeout),
    () => clearTimeout(agent._closeTimeout),
    () => agent._inSocket?.destroy?.(),
    () => agent._outSocket?.destroy?.(),
    () => worker?.dispose?.(),
    () => worker?._drainTimeout?.unref?.(),
    () => worker?._worker?.unref?.(),
  ]) {
    try { step(); } catch {}
  }
}

const hasVisibleOrEraseContent = data => Boolean(data && data.replace(nonModifyingControl, '').length);

const stripEdgeQuotes = text => text.trim().replace(/^(["'])(.*)\1$/u, '$2').trim();

export function isDefaultProcessTitle(title, file) {
  if (typeof title !== 'string' || typeof file !== 'string') return false;
  const cleanTitle = stripEdgeQuotes(title);
  const cleanFile = stripEdgeQuotes(file);
  if (!cleanTitle || !cleanFile) return false;
  const normalizedTitle = win32.normalize(cleanTitle).toLowerCase();
  const normalizedFile = win32.normalize(cleanFile).toLowerCase();
  const base = win32.basename(normalizedFile);
  const stem = base.endsWith('.exe') ? base.slice(0, -4) : base;
  const exeName = `${stem}.exe`;
  if (normalizedTitle === normalizedFile || (!base.endsWith('.exe') && normalizedTitle === `${normalizedFile}.exe`)
      || normalizedTitle === base || normalizedTitle === exeName || normalizedTitle === stem) {
    return true;
  }
  return normalizedFile === base && win32.isAbsolute(cleanTitle) && win32.basename(normalizedTitle) === exeName;
}

export function resolveObservedTitle(next, file, sawCustomTitle, platform = process.platform) {
  const raw = typeof next === 'string' ? next : '';
  const title = platform === 'win32' && !sawCustomTitle && isDefaultProcessTitle(raw, file) ? '' : raw;
  return { title, sawCustomTitle: Boolean(sawCustomTitle || title) };
}

const composerRow = (lines, cursorRow) => lines.findLastIndex((line, row) => row <= cursorRow && composerPrompt.test(line));

function footerMetrics(lines, row, end, first = lines[row]) {
  const fields = [];
  let hint;
  let hintRow = row;
  for (let current = row; current < end; current++) {
    const line = current === row ? first : lines[current];
    if (current !== row && (!line.startsWith('  ') || !line.trim())) return;
    const [field, inlineHint] = line.split(hintStart, 2);
    if (field.trim()) fields.push(field.trim());
    if (inlineHint) {
      hint = inlineHint;
      hintRow = current;
    }
  }
  const [label, ...rest] = fields.join(' ').split(/ ·(?: |$)/u);
  if (!label || /^Context \d|% left$/u.test(label)) return;
  const effort = effortName.exec(label);
  const result = { row, end, hint, hintRow };
  if (!/(?:…|\.{3})$/u.test(label)) {
    result.model = effort ? label.slice(0, effort.index) : label;
    result.reasoning = effort?.[1];
  }
  for (const value of rest) {
    const context = /^Context (\d{1,3})% used$/u.exec(value);
    const limit = /^(5h|five-hour|weekly|7d) (\d{1,3})% left$/u.exec(value);
    const version = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(value);
    const progress = (end > row + 1
      ? /^T ?a ?s ?k ?s (\d+(?: \d+)?) *\/ *(\d+(?: \d+)?)$/u
      : /^Tasks (\d+)\/(\d+)$/u).exec(value);
    if (end > row + 1 && value && !context && !limit && !version && !progress
        && (completedMetricPrefix.test(value) || !/(?:…|\.{3})$/u.test(value))) return;
    if (context && Number(context[1]) <= 100) result.contextPercent = Number(context[1]);
    if (limit && Number(limit[2]) <= 100) {
      result.limits ??= {};
      const period = /^(?:weekly|7d)$/u.test(limit[1]) ? 'weekly' : 'fiveHour';
      result.limits[period] = { remainingPercent: Number(limit[2]) };
    }
    if (version) result.version = value;
    if (progress) {
      const completed = Number(progress[1].replaceAll(' ', ''));
      const total = Number(progress[2].replaceAll(' ', ''));
      if (Number.isSafeInteger(total) && total > 0 && completed <= total) {
        result.taskProgress = { completed, total };
      }
    }
  }
  return result;
}

function statusEnd(lines) {
  const last = lines.findLastIndex(line => line.trim());
  return last + 1 - Number(composerShortcuts.test(lines[last] ?? ''));
}

function nativeFooter(lines, title, end) {
  const prefix = titleId.exec(title)?.[1].toLowerCase();
  if (!prefix) return;
  for (let row = end - 1; row >= 0 && lines[row].trim(); row--) {
    const match = footerId.exec(lines[row].trimEnd());
    if (!match || !match[1].toLowerCase().startsWith(prefix)) continue;
    const metrics = footerMetrics(lines, row, end, match[2] ?? '');
    if (metrics) return { threadId: match[1].toLowerCase(), ...metrics };
  }
}

export function inspectFooter(lines, title, cursorRow, cursorVisible = true) {
  if (!cursorVisible || composerRow(lines, cursorRow) === -1) return;
  const footer = nativeFooter(lines, title, statusEnd(lines));
  if (footer?.row > cursorRow) return footer;
}

function provisionalFooter(lines, cursorRow, cursorColumn, end, seenStartup, cursorVisible = true, seenStartupMetrics = false) {
  const last = lines.length - 1;
  const insert = composerShortcuts.test(lines[last]) ? last : last + 1;
  const prompt = composerRow(lines, seenStartup && !cursorVisible ? insert - 2 : cursorRow);
  if (prompt < 0 || (cursorVisible && cursorRow === prompt && cursorColumn < 2)) return;
  const firstPrompt = prompt === cursorRow && cursorColumn === 2 && lines[prompt].trimEnd() === initialPrompt;
  if (!firstPrompt && !seenStartup) return;

  if (!seenStartupMetrics && !lines[insert - 1]?.trim()) {
    if (insert === last) {
      if (composerRow(lines, insert - 2) >= 0
          && (seenStartup || (cursorRow === insert - 2 && lines[last].trimEnd() === '  ? for shortcuts'))) {
        return { row: insert, end: insert };
      }
    } else if (cursorVisible && cursorRow === insert - 2 && composerPrompt.test(lines[cursorRow])) {
      // Allow shortcut-less startup input frames while rejecting blank-bottom modals.
      return { row: insert, end: insert };
    }
  }
  const spacer = lines.findLastIndex((line, row) => row > prompt && row < end && !line.trim());
  if (spacer < 0 || spacer + 1 >= end) return;
  const row = spacer + 1;
  if (!lines[row].startsWith('  ') || footerId.test(lines[row].trimEnd())) return;
  const metrics = footerMetrics(lines, row, end);
  if (metrics?.model && metrics.version && metrics.contextPercent !== undefined) return metrics;
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

function readScreen(terminal, cursorVisible, title, { allowStartup, seenStartup, seenStartupMetrics, shutdownOnly } = {}) {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const lines = Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row));
  const plain = lines.map(line => line?.translateToString(true) ?? '');
  const { cursorY: cursorRow, cursorX: cursorColumn } = buffer;
  let footer;
  let shuttingDown = false;
  let hintColumn = 0;
  const alternate = buffer.type === 'alternate';
  if (alternate) {
    const end = statusEnd(plain);
    const candidate = nativeFooter(plain, title, end);
    if (candidate) {
      const spacer = candidate.row - 1;
      const prompt = composerRow(plain, spacer - 1);
      if (spacer > 0 && !plain[spacer]?.trim()) {
        shuttingDown = cursorRow >= candidate.row && plain[spacer - 1]?.trimEnd() === shutdownPrompt;
        if (shuttingDown || prompt >= 0 || plain.some((line, row) => row < spacer && workingStatus.test(line))) {
          footer = candidate;
        }
      }
    } else if (allowStartup && (cursorVisible || seenStartup) && (!title || titleId.test(title))) {
      footer = provisionalFooter(plain, cursorRow, cursorColumn, end, seenStartup, cursorVisible, seenStartupMetrics);
    }
    if (shutdownOnly && !shuttingDown) return;
    if (footer?.hint) {
      let index = plain[footer.hintRow].lastIndexOf(footer.hint);
      const line = lines[footer.hintRow];
      while (index > 0 && hintColumn < line.length) {
        line.getCell(hintColumn++, cell);
        if (cell.getWidth()) index -= cell.getChars().length || 1;
      }
    }
  }
  return {
    plain,
    rendered: lines.map(line => renderRow(line, cell)),
    alternate, cursorRow, cursorColumn, cursorVisible, footer, shuttingDown, hintColumn,
  };
}

function withHud({ plain, rendered, cursorRow, footer, hintColumn }, overlay, height, maxRows) {
  // Codex can wait for input before redrawing after SIGWINCH. Keep the child viewport steady
  // when the HUD grows, using blank space first and then old visible transcript rows.
  const removable = Math.max(0, composerRow(plain, footer.row - 1) - 1);
  const replaced = footer.end - footer.row;
  const available = Math.min(maxRows, height - rendered.length + replaced + removable);
  if (available < 1) return;
  const panel = overlay.slice(0, Math.max(1, available - Number(Boolean(footer.hint))));
  if (footer.hint) {
    const hint = '\x1b[2m  ' + footer.hint.replace(sgr, '') + reset;
    if (available > 1) panel.push(hint);
    else panel[0] += reset + '\x1b[' + Math.max(1, hintColumn - 1) + 'G\x1b[K' + hint;
  }
  const composed = rendered.slice();
  const rowMap = rendered.map((_, row) => row);
  composed.splice(footer.row, replaced, ...panel);
  rowMap.splice(footer.row, replaced, ...panel.map(() => null));
  const excess = composed.length - height;
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

export async function runTerminal({ file, args = [], env = process.env, cwd = process.cwd(), initialHud, readHud }) {
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
  let sawCustomTitle = false;
  let seenStartup = false;
  let seenStartupMetrics = false;
  let seenThread = false;
  let session;
  let refreshPending = false;
  let frozen;
  let frozenUntil = 0;
  let frozenTimer;
  let frozenSyncDirty = false;
  let shutdownScreen;
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
  let syncUntil = 0;
  let blankUntil = 0;
  let frameTimer;
  let tick;
  let stopped = false;
  let closing = false;
  let outputFailure = false;

  const hudHeight = () => Math.max(1, Math.min(12, Math.floor((rows - 6) / 2)));
  const liveScreen = () => readScreen(terminal, cursorVisible, title, {
    allowStartup: initialHud && !seenThread, seenStartup, seenStartupMetrics,
  });
  function clearFrozen() {
    frozen = undefined;
    frozenUntil = 0;
    frozenSyncDirty = false;
    clearTimeout(frozenTimer);
    frozenTimer = undefined;
  }

  function scheduleThaw(delayMs) {
    if (stopped || closing) return;
    clearTimeout(frozenTimer);
    frozenTimer = setTimeout(() => {
      frozenTimer = undefined;
      if (!frozen || stopped || closing) return;
      clearFrozen();
      queuePaint();
    }, delayMs);
  }

  function settleFrozen(data) {
    if (stopped || closing || !frozen) return;
    if (Date.now() >= frozenUntil) {
      clearFrozen();
      return;
    }
    const contentful = hasVisibleOrEraseContent(data);
    if (terminal.modes.synchronizedOutputMode && syncUntil > Date.now()) {
      if (contentful) frozenSyncDirty = true;
      return;
    }
    if (!frozenSyncDirty && !contentful) return;
    frozenSyncDirty = false;
    const screen = liveScreen();
    const nonBlank = screen.plain.some(line => line.trim());
    if (nonBlank && (screen.footer || !screen.alternate || screen.shuttingDown)) {
      clearFrozen();
      return;
    }
    const remaining = Math.max(0, frozenUntil - Date.now());
    scheduleThaw(nonBlank ? Math.min(paintDelay * 2, remaining) : remaining);
  }

  function resize() {
    if (stopped || closing) return;
    const next = dimensions();
    if (columns === next.columns && rows === next.rows) return;
    const live = liveScreen();
    const liveModal = live.plain.some(line => line.trim()) && !live.footer && !live.shuttingDown;
    const current = frozen && !liveModal ? frozen : live;
    frozen = current.footer ? current : undefined;
    if (frozen) {
      frozenUntil = Date.now() + frozenTimeout;
      scheduleThaw(frozenTimeout);
    } else {
      clearFrozen();
    }
    ({ columns, rows } = next);
    terminal.resize(columns, rows);
    child.resize(columns, rows);
    if (session) session.refreshAt = 0;
    painted = [];
    queuePaint();
  }

  function initialValue(options) {
    try { return initialHud?.(options); } catch { return ''; }
  }

  function listenFooter(footer, height) {
    const { row, end, hint, hintRow, ...metrics } = footer;
    const options = { ...metrics, columns, rows: height };
    if (!footer.threadId) return initialValue(options);
    if (session?.threadId !== footer.threadId) {
      session?.controller.abort();
      const controller = new AbortController();
      session = { threadId: footer.threadId, controller, value: initialValue({ ...options, signal: controller.signal }), refreshAt: 0 };
    }
    if (refreshPending || session.refreshAt > Date.now()) return session.value;
    const requested = session;
    requested.refreshAt = Date.now() + pollDelay;
    refreshPending = true;
    void Promise.resolve().then(() => readHud({ ...options, signal: requested.controller.signal })).then(value => {
      if (session === requested && !stopped && typeof value === 'string' && value.trim()) requested.value = value;
    }).catch(() => {}).finally(() => {
      refreshPending = false;
      queuePaint();
    });
    return session.value;
  }

  function queuePaint() {
    if (!stopped && !closing && !frameTimer && !blockedOutput) frameTimer = setTimeout(paint, paintDelay);
  }

  function paint() {
    frameTimer = undefined;
    if (stopped || closing || blockedOutput) return;
    const modes = terminal.modes;
    if (!shutdownScreen && modes.synchronizedOutputMode && syncUntil > Date.now()) return;
    if (frozen && Date.now() >= frozenUntil) clearFrozen();
    let screen = shutdownScreen ?? frozen ?? liveScreen();
    const isBlank = screen.plain.every(line => !line.trim());
    if (!shutdownScreen && !frozen && screen.alternate && (seenThread || seenStartup) && isBlank) {
      if (!blankUntil) blankUntil = Date.now() + blankTimeout;
      if (blankUntil > Date.now()) {
        queuePaint();
        return;
      }
    } else {
      blankUntil = 0;
    }
    const markScreenState = target => {
      if (target.shuttingDown) shutdownScreen = target;
      if (target.footer?.threadId) seenThread = true;
      else if (target.footer) {
        seenStartup = true;
        if (target.footer.version) seenStartupMetrics = true;
      }
    };
    markScreenState(screen);
    const height = hudHeight();
    const buildLayout = target => {
      const overlay = columns >= 42 && target.footer ? hudRows(listenFooter(target.footer, height), height) : [];
      const altered = overlay.length ? withHud(target, overlay, rows, height) : undefined;
      return { overlay, altered };
    };
    let { overlay, altered } = buildLayout(screen);
    if (!shutdownScreen && frozen && !altered && (overlay.length || screen.rendered.length > rows)) {
      const live = liveScreen();
      if (live.footer || live.shuttingDown || !live.alternate || Date.now() >= frozenUntil) {
        clearFrozen();
        screen = live;
        markScreenState(screen);
        ({ overlay, altered } = buildLayout(screen));
      }
    }
    const crop = !altered && !shutdownScreen && frozen && screen.rendered.length > rows
      ? screen.rendered.length - rows
      : 0;
    rowMap = frozen || shutdownScreen ? [] : altered?.rowMap;
    const composed = altered?.lines ?? (crop ? screen.rendered.slice(crop) : screen.rendered.slice());
    if (crop && columns >= 42 && screen.footer && overlay.length) {
      const visibleStart = Math.max(crop, screen.footer.row);
      const visibleEnd = Math.min(screen.rendered.length, screen.footer.end);
      for (let row = visibleStart; row < visibleEnd; row++) {
        composed[row - crop] = overlay[row - visibleStart] ?? '';
      }
    }
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
    const fallbackCursorRow = crop ? screen.cursorRow - crop : screen.cursorRow;
    const mappedCursorRow = altered?.cursorRow ?? fallbackCursorRow;
    const physicalRow = Math.max(0, Math.min(rows - 1, mappedCursorRow < 0 ? fallbackCursorRow : mappedCursorRow));
    const cursor = move(physicalRow, Math.min(columns - 1, screen.cursorColumn))
      + '\x1b[' + cursorStyle + ' q' + decMode(25, screen.cursorVisible && mappedCursorRow >= 0);
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
        ({ title, sawCustomTitle } = resolveObservedTitle(next, file, sawCustomTitle));
        const prefix = titleId.exec(title)?.[1].toLowerCase();
        if (session && !session.threadId.startsWith(prefix || '/')) {
          session.controller.abort();
          session = undefined;
        }
      }),
      terminal.onData(data => { if (!closing) child.write(data); }),
      terminal.onBell(() => stdout.write('\x07')),
      ...['h', 'l'].map(final => terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(25)) cursorVisible = final === 'h';
        if (params.includes(2026)) {
          if (final === 'h' && !terminal.modes.synchronizedOutputMode) syncUntil = Date.now() + syncTimeout;
          if (final === 'l') {
            syncUntil = 0;
            const buffer = terminal.buffer.active;
            // Capture a completed shutdown before the child clears and leaves its alternate screen.
            if (!shutdownScreen && buffer.type === 'alternate' && buffer.cursorY === terminal.rows - 1) {
              shutdownScreen = readScreen(terminal, cursorVisible, title, { shutdownOnly: true });
            }
          }
        }
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
        const flags = value ?? 0;
        if (keyboardStack < 8 && Number.isInteger(flags) && flags >= 0 && flags <= 31) {
          stdout.write('\x1b[>' + flags + 'u');
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
          settleFrozen(data);
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
    clearTimeout(frozenTimer);
    clearTimeout(inputTimer);
    for (const subscription of subscriptions) {
      try { subscription.dispose(); } catch {}
    }
    stdin.off('data', input);
    if (!wasFlowing) try { stdin.pause(); } catch {}
    try { stdin.setRawMode(wasRaw); } catch {}
    stdout.off('resize', onResize);
    stdout.off('drain', drained);
    process.off('SIGINT', onInterrupt);
    process.off('SIGHUP', onHangup);
    process.off('SIGTERM', onTerminate);
    if (!outputFailure) {
      try {
        const restore = [1, 9, 1000, 1002, 1003, 1004, 1006, 2004].map(mode => decMode(mode, false)).join('');
        stdout.write(restore + (keyboardStack ? '\x1b[<' + keyboardStack + 'u' : '')
          + '\x1b>' + reset + '\x1b[0 q' + decMode(7, true) + decMode(25, true) + decMode(1049, false));
        const normal = terminal.buffer.normal;
        const cell = normal.getNullCell();
        const output = Array.from({ length: normal.length }, (_, row) => renderRow(normal.getLine(row), cell));
        while (output.length && !output.at(-1)) output.pop();
        if (output.length) stdout.write(output.join('\n') + '\n');
      } catch {}
    }
    stdout.off('error', onOutputError);
    try { terminal.dispose(); } catch {}
    try { closePtyHandle(child); } catch {}
  }
}
