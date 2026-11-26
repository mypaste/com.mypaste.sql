/**
 * The SQL workspace page.
 *
 * The host opens this surface for a text entity and delivers its text. From
 * then on the page owns everything: it paints the syntax colours from its own
 * dialect vocabularies, and hands the buffer to sqlriver — a zero-dependency
 * parser and formatter that implements the SQL Style Guide — for the grammar.
 * sqlriver lays the SQL out (keywords upper-cased, clauses right-aligned) and
 * reports what it could not parse; the page keeps the unparseable statements
 * exactly as written and, only when there is something to report, lists the
 * findings beside the editor.
 *
 * Nothing is executed, no process runs and no request leaves the frame.
 * Copying is a host action; the page posts `copy` and never touches the
 * clipboard itself. Every value reaches the DOM through text nodes or
 * `textarea.value`, never HTML, so SQL that contains markup stays text.
 */

import { connectSurface } from "./bridge";
import { compressSql } from "./compress";
import { DIALECTS, dialectById } from "./dialect";
import { formatSql, scanSql, type SqlProblem } from "./engine";
import { positionOf, tokenizeSql, type SqlToken } from "./tokenize";

/** Above this size the grammar check would stall typing; the rail says so. */
const MAX_CHECK_CHARS = 200_000;
/** Long enough that a burst of typing is one parse, short enough to feel live. */
const CHECK_DELAY = 220;

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`缺少元素 ${selector}`);
  return element;
}

const docTitle = one<HTMLHeadingElement>("#doc-title");
const dialectSelect = one<HTMLSelectElement>("#dialect");
const widthSelect = one<HTMLSelectElement>("#width");
const counts = one<HTMLSpanElement>("#counts");
const gutter = one<HTMLDivElement>("#gutter");
const gutterInner = one<HTMLDivElement>("#gutter-inner");
const highlight = one<HTMLPreElement>("#highlight");
const editor = one<HTMLTextAreaElement>("#editor");
const status = one<HTMLSpanElement>("#status");
const finding = one<HTMLSpanElement>("#finding");
const position = one<HTMLSpanElement>("#position");
const problemCount = one<HTMLSpanElement>("#problem-count");
const problemEmpty = one<HTMLParagraphElement>("#problem-empty");
const problemList = one<HTMLDivElement>("#problem-list");
const problemNote = one<HTMLParagraphElement>("#problem-note");
const workspace = one<HTMLElement>("#workspace");
const problemsRail = one<HTMLElement>("#problems");
const idle = one<HTMLDivElement>("#idle");
const idleTitle = one<HTMLParagraphElement>("#idle-title");
const idleHint = one<HTMLParagraphElement>("#idle-hint");
const formatButton = one<HTMLButtonElement>("#format");
const compressButton = one<HTMLButtonElement>("#compress");
const copyButton = one<HTMLButtonElement>("#copy");
const wrapToggle = one<HTMLButtonElement>("#wrap-toggle");
const closeButton = one<HTMLButtonElement>("#close");

const bridge = connectSurface();

for (const dialect of DIALECTS) {
  const option = document.createElement("option");
  option.value = dialect.id;
  option.textContent = dialect.label;
  dialectSelect.append(option);
}

/** The tokens of the text being shown; painting and compression read them. */
let tokens: SqlToken[] = [];
/** What the last grammar check found. */
let problems: readonly SqlProblem[] = [];
/** Statements sqlriver does not model, left verbatim. */
let unsupported = 0;
/** The buffer was too large to scan; the rail says so instead of lying. */
let skipped = false;
let previousText: string | null = null;
let scheduled = 0;
let checkTimer = 0;
let renderedLines = 0;
let renderedOccupancy = "";

/** Whether long lines wrap inside the pane; on by default. */
let wrapping = true;

const raf: (callback: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function"
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => window.setTimeout(() => callback(0), 16);

function currentDialect() {
  return dialectById(dialectSelect.value);
}

function selectedWidth(): number {
  const value = Number(widthSelect.value);
  return Number.isFinite(value) && value >= 40 && value <= 400 ? value : 80;
}

function setStatus(message: string, tone: "ok" | "bad" | "" = ""): void {
  status.textContent = message;
  status.className = tone === "" ? "status" : `status ${tone}`;
}

/** What the empty pane says; each mount explains its own way in and out. */
function setIdle(title: string, hint: string): void {
  idleTitle.textContent = title;
  idleHint.textContent = hint;
}

function caretPosition(): void {
  const at = positionOf(editor.value, editor.selectionStart);
  position.textContent = `${at.line}:${at.column}`;
}

function tokenClass(token: SqlToken): string {
  if (token.error) return "tok-error";
  if (token.kind === "") return "";
  return `tok-${token.kind}`;
}

/** Paints the token stream into spans; the textarea above stays transparent. */
function renderHighlight(): void {
  const fragment = document.createDocumentFragment();
  let pending = "";
  let pendingClass: string | null = null;

  const flush = (): void => {
    if (pending === "") return;
    if (pendingClass === null || pendingClass === "") {
      fragment.append(document.createTextNode(pending));
    } else {
      const span = document.createElement("span");
      span.className = pendingClass;
      span.textContent = pending;
      fragment.append(span);
    }
    pending = "";
  };

  for (const token of tokens) {
    const className = tokenClass(token);
    if (className !== pendingClass) {
      flush();
      pendingClass = className;
    }
    pending += token.text;
  }
  flush();
  fragment.append(document.createTextNode("\n"));
  highlight.replaceChildren(fragment);
}

/**
 * How many visual rows each logical line occupies once the pane wraps.
 *
 * The painted copy is the same text in the same box as the textarea, so its
 * line boxes are the pane's: a Range over one logical line reports a rect per
 * visual row, and rects that share a top belong to spans on the same row. The
 * gutter prints a number on the first row and stretches it over the rest, so
 * the numbers stay beside the lines they name. Without layout (a test stub, a
 * hidden pane) each line counts once.
 */
function wrappedRows(target: HTMLElement, text: string): number[] {
  const lines = text.split("\n");
  const rows = lines.map(() => 1);
  if (typeof document.createRange !== "function" || lines.length > 4000) {
    return rows;
  }
  const nodes: Node[] = [];
  const collect = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) nodes.push(child);
      else collect(child);
    });
  };
  collect(target);
  if (nodes.length === 0) return rows;

  const locate = (offset: number): { node: Node; offset: number } | null => {
    let remaining = offset;
    for (const node of nodes) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
    }
    return null;
  };

  const range = document.createRange();
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const length = lines[index]!.length;
    const start = locate(cursor);
    const end = locate(cursor + length);
    cursor += length + 1; // the newline belongs to no line
    if (start === null || end === null) continue;
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      continue;
    }
    const tops = new Set<number>();
    const rects = range.getClientRects();
    for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
      const rect = rects.item(rectIndex);
      if (rect !== null) tops.add(Math.round(rect.top));
    }
    if (tops.size > 1) rows[index] = tops.size;
  }
  return rows;
}

function errorLines(): Set<number> {
  return new Set(problems.map((entry) => entry.line));
}

function renderGutter(text: string): void {
  const lineCount = text.split("\n").length;
  const marks = errorLines();
  const occupancy = wrapping
    ? wrappedRows(highlight, text).join(",")
    : "";
  if (lineCount !== renderedLines || occupancy !== renderedOccupancy) {
    const rows = wrapping ? wrappedRows(highlight, text) : null;
    const fragment = document.createDocumentFragment();
    for (let line = 1; line <= lineCount; line += 1) {
      const row = document.createElement("div");
      row.className = marks.has(line) ? "gutter-line error" : "gutter-line";
      row.textContent = String(line);
      if (rows !== null && rows[line - 1]! > 1) {
        row.style.height = `${rows[line - 1]! * 21}px`;
      }
      fragment.append(row);
    }
    gutterInner.replaceChildren(fragment);
    renderedLines = lineCount;
    renderedOccupancy = occupancy;
  } else {
    const gutterRows = gutterInner.children;
    for (let line = 1; line <= lineCount; line += 1) {
      const row = gutterRows.item(line - 1);
      if (row === null) continue;
      row.className = marks.has(line) ? "gutter-line error" : "gutter-line";
    }
  }
  counts.textContent = `${lineCount} 行 · ${[...text].length} 字符`;
}

/**
 * The rail exists only when it has something to report; a clean or empty
 * document hands the whole width back to the editor instead of an empty card.
 */
function syncRail(): void {
  const hasFindings = problems.length > 0 || unsupported > 0 || skipped;
  problemsRail.hidden = !hasFindings;
  workspace.dataset.rail = hasFindings ? "open" : "closed";
}

/** The findings rail: one card row per problem, clickable to reveal it. */
function renderProblems(): void {
  problemCount.textContent = String(problems.length);
  problemCount.classList.toggle("bad", problems.length > 0);

  const fragment = document.createDocumentFragment();
  for (const problem of problems) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "problem-row";
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-label", `跳转到第 ${problem.line} 行第 ${problem.column} 列`);

    const where = document.createElement("span");
    where.className = "problem-where";
    where.textContent = `${problem.line}:${problem.column}`;

    const message = document.createElement("span");
    message.className = "problem-message";
    message.textContent = problem.message;

    row.append(where, message);
    row.addEventListener("click", () => reveal(problem));
    fragment.append(row);
  }
  problemList.replaceChildren(fragment);

  syncRail();

  problemEmpty.hidden = problems.length > 0 || unsupported > 0;
  if (problems.length === 0) {
    problemEmpty.textContent = skipped
      ? "内容过长，未做语法检查"
      : "没有发现语法问题";
  }
  problemNote.hidden = unsupported === 0;
  if (unsupported > 0) {
    problemNote.textContent = `${unsupported} 条语句未识别，已原样保留`;
  }
}

function renderFinding(): void {
  // Every finding has a home in the rail, which opens whenever there is one;
  // the bar speaks only for a clean, non-empty document, so the size and caret
  // keep their room. An empty buffer says nothing here — the pane says it.
  const clean = !skipped && problems.length === 0 && unsupported === 0;
  finding.textContent = clean && editor.value.trim() !== "" ? "没有语法问题" : "";
  finding.className = "finding clean";
}

function syncScroll(): void {
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
  gutter.scrollTop = editor.scrollTop;
}

function render(): void {
  scheduled = 0;
  tokens = tokenizeSql(editor.value, currentDialect());
  renderHighlight();
  renderGutter(editor.value);
  syncRail();
  renderFinding();
  caretPosition();
  syncScroll();
  // The empty pane's invitation belongs to an empty buffer: the first word
  // takes it away, and deleting back to empty brings it back. Whitespace does
  // not count as content — a blank entry still says it is blank.
  idle.hidden = editor.value.trim() !== "";
  const empty = editor.value.trim() === "";
  formatButton.disabled = empty;
  compressButton.disabled = empty;
  copyButton.disabled = empty;
  scheduleCheck();
}

function scheduleRender(): void {
  if (scheduled !== 0) return;
  scheduled = raf(() => render());
}

/** The grammar check is debounced: typing stays ahead of the parser. */
function scheduleCheck(): void {
  if (checkTimer !== 0) clearTimeout(checkTimer);
  checkTimer = window.setTimeout(runCheck, CHECK_DELAY);
}

function runCheck(): void {
  checkTimer = 0;
  const text = editor.value;
  skipped = text.length > MAX_CHECK_CHARS;
  if (skipped) {
    problems = [];
    unsupported = 0;
  } else {
    const scan = scanSql(text, currentDialect().id);
    problems = scan.problems;
    unsupported = scan.unsupported;
  }
  renderProblems();
  renderFinding();
  renderGutter(text);
}

function replaceText(next: string, message: string): void {
  const caret = Math.min(editor.selectionStart, next.length);
  previousText = editor.value;
  editor.value = next;
  editor.setSelectionRange(caret, caret);
  skipped = false;
  render();
  renderProblems();
  setStatus(message, problems.length === 0 ? "ok" : "");
}

/** Moves the caret onto a finding and selects the token it names. */
function reveal(problem: SqlProblem): void {
  const start = offsetOf(problem.line, problem.column);
  const end = advance(start, problem.length);
  editor.focus();
  editor.setSelectionRange(start, end);
  caretPosition();
  const lineHeight = 21;
  editor.scrollTop = Math.max(0, (problem.line - 3) * lineHeight);
  syncScroll();
}

/** The UTF-16 offset reached by advancing `count` runes from `offset`. */
function advance(offset: number, count: number): number {
  let index = offset;
  let remaining = count;
  while (index < editor.value.length && remaining > 0) {
    const code = editor.value.codePointAt(index);
    if (code === undefined) break;
    index += code > 0xffff ? 2 : 1;
    remaining -= 1;
  }
  return Math.min(editor.value.length, index);
}

/** The UTF-16 offset of a 1-based rune line and column. */
function offsetOf(line: number, column: number): number {
  let currentLine = 1;
  let index = 0;
  while (index < editor.value.length && currentLine < line) {
    if (editor.value.charAt(index) === "\n") currentLine += 1;
    index += 1;
  }
  let remaining = Math.max(0, column - 1);
  while (index < editor.value.length && remaining > 0) {
    const code = editor.value.codePointAt(index);
    if (code === undefined) break;
    index += code > 0xffff ? 2 : 1;
    remaining -= 1;
  }
  return index;
}

/**
 * Applies the wrap state: the textarea's `wrap` attribute, the root's
 * `data-wrap` (which the stylesheet keys the painted copy to) and a fresh
 * render, because the gutter's rows now occupy a different height.
 */
function setWrapping(next: boolean): void {
  wrapping = next;
  wrapToggle.setAttribute("aria-pressed", String(next));
  document.documentElement.dataset.wrap = next ? "on" : "off";
  editor.setAttribute("wrap", next ? "soft" : "off");
  renderedLines = 0;
  renderedOccupancy = "";
  render();
}

function runFormat(): void {
  const text = editor.value;
  if (text.trim() === "") return;
  const result = formatSql(text, currentDialect().id, selectedWidth());
  problems = result.problems;
  unsupported = result.unsupported;
  skipped = false;
  if (result.text === text) {
    renderProblems();
    renderFinding();
    renderGutter(text);
    if (problems.length > 0) {
      const first = problems[0]!;
      setStatus(`第 ${first.line} 行第 ${first.column} 列：${first.message}`, "bad");
      reveal(first);
    } else {
      setStatus("已经是风格指南的样子");
    }
    return;
  }
  replaceText(
    result.text,
    problems.length > 0 ? `已美化 · ${problems.length} 个问题仍待修正` : "已美化",
  );
}

function runCompress(): void {
  const text = editor.value;
  if (text.trim() === "") return;
  const current = tokenizeSql(text, currentDialect());
  if (current.some((token) => token.error)) {
    const lexical = problems[0];
    if (lexical !== undefined) {
      setStatus(`第 ${lexical.line} 行第 ${lexical.column} 列：${lexical.message}`, "bad");
      reveal(lexical);
    } else {
      setStatus("存在未闭合的字符串或注释，无法压缩", "bad");
    }
    return;
  }
  const result = compressSql(current);
  if (!result.ok) {
    setStatus(result.message, "bad");
    return;
  }
  if (result.text === text) {
    setStatus("已经是压缩后的样子");
    return;
  }
  replaceText(result.text, "已压缩为一行");
}

async function runCopy(): Promise<void> {
  const text = editor.value;
  if (text.trim() === "") {
    setStatus("没有可复制的内容", "bad");
    return;
  }
  const result = await bridge.copy(text);
  // A menu page's copy is also the record (D-1234); a surface's copy of an
  // item that already exists is just the clipboard.
  const done = bridge.menu ? "已复制，并记成一条新记录" : "已复制到剪贴板";
  if (result.ok) setStatus(done, "ok");
  else setStatus(result.message ?? "复制失败", "bad");
}

formatButton.addEventListener("click", runFormat);
compressButton.addEventListener("click", runCompress);
copyButton.addEventListener("click", () => {
  void runCopy();
});
wrapToggle.addEventListener("click", () => setWrapping(!wrapping));
closeButton.addEventListener("click", () => bridge.close());

dialectSelect.addEventListener("change", () => {
  setStatus("");
  renderedLines = 0;
  renderedOccupancy = "";
  render();
});
widthSelect.addEventListener("change", () => {
  setStatus(`目标行宽 ${selectedWidth()} 列`);
});

editor.addEventListener("input", () => {
  previousText = null;
  setStatus("");
  scheduleRender();
});
editor.addEventListener("scroll", syncScroll);
editor.addEventListener("keyup", caretPosition);
editor.addEventListener("click", caretPosition);
editor.addEventListener("select", caretPosition);

editor.addEventListener("keydown", (event) => {
  const command = event.metaKey || event.ctrlKey;
  if (command && !event.shiftKey && event.key.toLowerCase() === "z" && previousText !== null) {
    event.preventDefault();
    const restored = previousText;
    previousText = null;
    editor.value = restored;
    editor.setSelectionRange(restored.length, restored.length);
    render();
    setStatus("已还原上一次排版", "ok");
    return;
  }
  if (command && event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    runFormat();
  }
});

// A menu page has no entry (D-1234): the reader types or pastes SQL and the
// copy writes both the clipboard and a new record. The host tab already names
// the page (D-1231), so the identity block gives way to the start state.
bridge.onMenu(() => {
  document.body.dataset.mode = "menu";
  docTitle.textContent = "SQL";
  document.title = "SQL";
  setIdle("粘贴或输入 SQL", "在页面里高亮与检查语法，⌘⇧F 按 SQL Style Guide 美化；复制会写入剪贴板，并记成一条新记录。");
  setStatus("");
  editor.focus();
});

bridge.onItem(({ item }) => {
  docTitle.textContent = item.title.trim() === "" ? "未命名 SQL" : item.title;
  document.title = `${item.title.trim() === "" ? "SQL" : item.title} · SQL`;
  setIdle("这条条目是空的", "粘贴或输入 SQL，⌘⇧F 美化；复制只写入剪贴板。");
  editor.value = item.text;
  previousText = null;
  renderedLines = 0;
  render();
  if (item.text.trim() !== "") editor.focus();
});

// The host never sees a key pressed inside this frame, so Esc is the page's
// own: it closes the surface through the bridge (D-1097).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  bridge.close();
});

setStatus("");
setWrapping(true);
