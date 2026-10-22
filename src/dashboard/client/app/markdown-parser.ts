/**
 * The dashboard's Markdown parser, for release notes (the CHANGELOG) and for thread prompts and replies, as data.
 *
 * Blocks: ATX and setext headings, paragraphs, bullet / ordered / task lists with nesting by indentation (lenient: two
 * spaces nest under `1.`), fenced code (backticks or tildes), blockquotes (nested, lazy continuation), GFM tables with
 * alignment, thematic breaks. Inline: `code`, `**strong**`/`__strong__`, `*em*`/`_em_`, `~~strike~~`, `[links](url)`,
 * `![images](url)`, `<https://autolinks>`, `<br>`, backslash escapes.
 * Left as text: indented code blocks, reference links and definitions, bare URLs, footnotes, and all other HTML.
 *
 * Safety: this never produces HTML. The renderer builds React elements from these nodes, which escape all text. A link
 * node exists only for an absolute http(s) URL (`safeHref`); any other target keeps its label as text. An image node is
 * never fetched by the renderer (it shows a link); an image whose URL is not http(s) is its alt text.
 *
 * Input may be a cut-off document (a prompt is truncated to a byte budget with no marker): an unclosed fence runs to
 * the end, a half table or half link stays text, an unclosed marker stays literal. Nothing here throws.
 */

export type Inline =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "strong"; children: Inline[] }
	| { kind: "em"; children: Inline[] }
	| { kind: "strike"; children: Inline[] }
	/** `href` always passed `safeHref` (absolute http/https). */
	| { kind: "link"; href: string; children: Inline[] }
	/** `![alt](url)` with an http(s) URL. Never loaded: the renderer shows it as a link. `alt` is plain text (may be ""). */
	| { kind: "image"; href: string; alt: string }
	/** A literal `<br>`, `<br/>` or `<br />` (any case); no other HTML is recognised. */
	| { kind: "break" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
	/** Task-list state: true for `[x]`/`[X]`, false for `[ ]`, null for an ordinary item. */
	checked: boolean | null;
	children: Block[];
}

export type Block =
	/** level 1..6 */
	| { kind: "heading"; level: number; children: Inline[] }
	| { kind: "paragraph"; children: Inline[] }
	/** `start` is the first item's number for an ordered list, 1 for a bullet list. */
	| { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
	| { kind: "code"; text: string }
	| { kind: "quote"; children: Block[] }
	/** Every row in `rows` and `head` has exactly `align.length` cells. */
	| { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
	| { kind: "rule" };

const PUNCT = /[!-/:-@[-`{-~]/;
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
const ALNUM = /[\p{L}\p{N}]/u;
const BREAK = /<br[ \t]*\/?>/iy;
const AUTOLINK = /<(https?:\/\/[^\s<>]*)>/iy;

/** `url` when it is an absolute http(s) URL, else null: the only links that become anchors. */
export function safeHref(url: string): string | null {
	if (!/^https?:\/\/[^/?#]/i.test(url)) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

/** Matches `re` (sticky) at `at`, or null. */
function matchAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
	re.lastIndex = at;
	return re.exec(text);
}

/** Appends `text` to the last node when that is plain text, so runs of characters stay one node. */
function pushText(out: Inline[], text: string): void {
	const last = out[out.length - 1];
	if (last?.kind === "text") last.text += text;
	else out.push({ kind: "text", text });
}

/** Appends `nodes`, merging adjacent text. */
function pushAll(out: Inline[], nodes: Inline[]): void {
	for (const node of nodes) {
		if (node.kind === "text") pushText(out, node.text);
		else out.push(node);
	}
}

/** Length of the run of `char` starting at `at`. */
function runLength(text: string, at: number, char: string): number {
	let end = at;
	while (text[end] === char) end++;
	return end - at;
}

/**
 * Search state for one text. Replies are untrusted and can be a wall of unclosed markers, so a closer search that has
 * failed once is never repeated: a search that reached the end without a closer fails from every later start too.
 */
interface Scan {
	text: string;
	/** Backtick run size → smallest start from which no run of exactly that size follows. */
	codeFailed: Map<number, number>;
	/** Emphasis marker, length and nesting depth → smallest start from which no closer follows. */
	closeFailed: Map<string, number>;
	/** `[` index → index of its matching `]`, built on first use. */
	brackets: Map<number, number> | null;
}

/** Nesting limit for inline content inside emphasis or link labels: deeper content stays literal. */
const MAX_INLINE_DEPTH = 16;

function newScan(text: string): Scan {
	return { text, codeFailed: new Map(), closeFailed: new Map(), brackets: null };
}

/** Index of the next backtick run of exactly `size` at or after `from`, or -1. */
function findCodeClose(scan: Scan, from: number, size: number): number {
	const failed = scan.codeFailed.get(size);
	if (failed !== undefined && from >= failed) return -1;
	const { text } = scan;
	let at = text.indexOf("`", from);
	while (at >= 0) {
		const run = runLength(text, at, "`");
		if (run === size) return at;
		at = text.indexOf("`", at + run);
	}
	scan.codeFailed.set(size, from);
	return -1;
}

/** Matches every `[` with its `]` in one pass, skipping escapes and code spans. */
function matchBrackets(scan: Scan): Map<number, number> {
	const { text } = scan;
	const matches = new Map<number, number>();
	const open: number[] = [];
	for (let at = 0; at < text.length; ) {
		const char = text[at] as string;
		if (char === "\\") {
			at += 2;
		} else if (char === "`") {
			const run = runLength(text, at, "`");
			const close = findCodeClose(scan, at + run, run);
			at = close < 0 ? at + run : close + run;
		} else {
			if (char === "[") {
				open.push(at);
			} else if (char === "]") {
				const start = open.pop();
				if (start !== undefined) matches.set(start, at);
			}
			at++;
		}
	}
	return matches;
}

/** Index of the `]` matching the `[` at `open`, or -1. */
function labelEnd(scan: Scan, open: number): number {
	scan.brackets ??= matchBrackets(scan);
	return scan.brackets.get(open) ?? -1;
}

/** Parses `(destination "title")` at `open` (the `(`): the destination, and the index after the `)`; null when malformed. */
function linkTail(text: string, open: number): { dest: string; end: number } | null {
	let at = open + 1;
	while (text[at] === " " || text[at] === "\t") at++;
	let dest: string;
	if (text[at] === "<") {
		let close = at + 1;
		while (close < text.length && text[close] !== ">" && text[close] !== "<" && text[close] !== "\n") close++;
		if (text[close] !== ">") return null;
		dest = text.slice(at + 1, close);
		at = close + 1;
	} else {
		const start = at;
		let depth = 0;
		while (at < text.length) {
			const char = text[at] as string;
			if (char === "\\") at += 2;
			else if (/\s/.test(char)) break;
			// Nesting is capped as in cmark, so a run of `(` cannot make every link attempt rescan the rest of the text.
			else if (char === "(") {
				if (++depth > 32) return null;
				at++;
			}
			else if (char === ")" && depth > 0) depth--, at++;
			else if (char === ")") break;
			else at++;
		}
		if (depth !== 0) return null;
		dest = text.slice(start, at);
	}
	const gap = at;
	while (text[at] === " " || text[at] === "\t") at++;
	const quote = text[at];
	if (at > gap && (quote === '"' || quote === "'")) {
		let close = at + 1;
		while (close < text.length && text[close] !== quote) close += text[close] === "\\" ? 2 : 1;
		if (close >= text.length) return null;
		at = close + 1;
		while (text[at] === " " || text[at] === "\t") at++;
	}
	if (text[at] !== ")") return null;
	return { dest: dest.replace(ESCAPED, "$1"), end: at + 1 };
}

/** `[label](url)` at `at`: a link for an http(s) URL, else its label as text. Returns the end index, or -1. */
function linkAt(scan: Scan, at: number, out: Inline[], inLink: boolean, depth: number): number {
	const { text } = scan;
	const close = labelEnd(scan, at);
	if (close < 0 || text[close + 1] !== "(") return -1;
	const label = text.slice(at + 1, close);
	const tail = label === "" ? null : linkTail(text, close + 1);
	if (tail === null) return -1;
	// A link inside a link label keeps only its label: anchors never nest.
	const children = parseInlineIn(label, true, depth + 1);
	const href = inLink ? null : safeHref(tail.dest);
	// Anything but an http(s) URL keeps its label as text: a `javascript:` target is never made clickable.
	if (href === null) pushAll(out, children);
	else out.push({ kind: "link", href, children });
	return tail.end;
}

/** `![alt](url)` at `at` (the `!`): an image for an http(s) URL, else its alt text. Returns the end index, or -1. */
function imageAt(scan: Scan, at: number, out: Inline[]): number {
	const { text } = scan;
	const close = labelEnd(scan, at + 1);
	if (close < 0 || text[close + 1] !== "(") return -1;
	const tail = linkTail(text, close + 1);
	if (tail === null) return -1;
	const alt = text.slice(at + 2, close).replace(ESCAPED, "$1");
	const href = safeHref(tail.dest);
	if (href !== null) out.push({ kind: "image", href, alt });
	else if (alt !== "") pushText(out, alt);
	return tail.end;
}

/** `<br>` and `<https://autolink>` at `at`; any other `<` is text. Returns the end index, or -1. */
function angleAt(text: string, at: number, out: Inline[], inLink: boolean): number {
	const br = matchAt(BREAK, text, at);
	if (br !== null) {
		out.push({ kind: "break" });
		return at + br[0].length;
	}
	const auto = inLink ? null : matchAt(AUTOLINK, text, at);
	if (auto === null) return -1;
	const href = safeHref(auto[1] as string);
	if (href === null) return -1;
	out.push({ kind: "link", href, children: [{ kind: "text", text: auto[1] as string }] });
	return at + auto[0].length;
}

/** Whether a run of `len` `char`s at `at` can open emphasis: followed by non-space, and `_` not glued to a word. */
function canOpen(text: string, at: number, char: string, len: number): boolean {
	const after = text[at + len];
	if (after === undefined || /\s/.test(after)) return false;
	if (len === 1 && after === char) return false;
	return !(char === "_" && ALNUM.test(text[at - 1] ?? ""));
}

/** Whether the run of `run` `char`s at `at` can close emphasis: preceded by non-space, and `_` not glued to a word. */
function canClose(text: string, at: number, char: string, run: number): boolean {
	const before = text[at - 1];
	if (before === undefined || /\s/.test(before)) return false;
	return !(char === "_" && ALNUM.test(text[at + run] ?? ""));
}

/**
 * Index of the run closing an opener of `len` `char`s whose content starts at `from`, or -1. Escapes and code spans are
 * skipped; a shorter or longer run that can open (`*em*` inside `**strong**`) is matched with its own closer first.
 */
function findClose(scan: Scan, from: number, char: string, len: number, depth: number): number {
	const key = `${char}${len}${depth}`;
	const failed = scan.closeFailed.get(key);
	if (failed !== undefined && from >= failed) return -1;
	const { text } = scan;
	let at = from;
	while (at < text.length) {
		const current = text[at] as string;
		if (current === "\\") {
			at += 2;
		} else if (current === "`") {
			const run = runLength(text, at, "`");
			const close = findCodeClose(scan, at + run, run);
			at = close < 0 ? at + run : close + run;
		} else if (current !== char) {
			at++;
		} else {
			const run = runLength(text, at, char);
			if (at > from && run >= len && canClose(text, at, char, run)) return at;
			if (run !== len && run <= 2 && depth < 2 && canOpen(text, at, char, run)) {
				const nested = findClose(scan, at + run, char, run, depth + 1);
				if (nested >= 0) {
					at = nested + run;
					continue;
				}
			}
			at += run;
		}
	}
	scan.closeFailed.set(key, from);
	return -1;
}

/** `***x***`, `**x**`, `*x*`, `___x___`, `__x__`, `_x_` and `~~x~~` at `at`. Returns the end index, or -1. */
function emphasisAt(scan: Scan, at: number, out: Inline[], inLink: boolean, depth: number): number {
	const { text } = scan;
	const char = text[at] as string;
	for (const len of char === "~" ? [2] : [3, 2, 1]) {
		if (!text.startsWith(char.repeat(len), at) || !canOpen(text, at, char, len)) continue;
		const close = findClose(scan, at + len, char, len, 0);
		if (close < 0) continue;
		const children = parseInlineIn(text.slice(at + len, close), inLink, depth + 1);
		if (char === "~") out.push({ kind: "strike", children });
		else if (len === 1) out.push({ kind: "em", children });
		else if (len === 2) out.push({ kind: "strong", children });
		else out.push({ kind: "strong", children: [{ kind: "em", children }] });
		return close + len;
	}
	return -1;
}

/** `inLink`: inside a link label, where further links (and autolinks) are not made. */
function parseInlineIn(text: string, inLink: boolean, depth: number): Inline[] {
	if (depth > MAX_INLINE_DEPTH) return text === "" ? [] : [{ kind: "text", text }];
	const scan = newScan(text);
	const out: Inline[] = [];
	let at = 0;
	while (at < text.length) {
		const char = text[at] as string;
		let end = -1;
		if (char === "\\") {
			const next = text[at + 1];
			if (next !== undefined && PUNCT.test(next)) {
				pushText(out, next);
				end = at + 2;
			}
		} else if (char === "`") {
			const run = runLength(text, at, "`");
			const close = findCodeClose(scan, at + run, run);
			if (close < 0) {
				pushText(out, "`".repeat(run));
			} else {
				const content = text.slice(at + run, close);
				const padded = content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "";
				out.push({ kind: "code", text: padded ? content.slice(1, -1) : content });
			}
			end = close < 0 ? at + run : close + run;
		} else if (char === "[") {
			end = linkAt(scan, at, out, inLink, depth);
		} else if (char === "!" && text[at + 1] === "[") {
			end = imageAt(scan, at, out);
		} else if (char === "<") {
			end = angleAt(text, at, out, inLink);
		} else if (char === "*" || char === "_" || char === "~") {
			end = emphasisAt(scan, at, out, inLink, depth);
		}
		if (end < 0) {
			pushText(out, char);
			at += 1;
		} else {
			at = end;
		}
	}
	return out;
}

export function parseInline(text: string): Inline[] {
	return parseInlineIn(text, false, 0);
}

// No optional or lazy tail after `(.*)`: a long run of spaces must not backtrack. The closing `#` run is cut by `headingText`.
// `(.*)$` takes the `s` flag: without it `.` stops at U+2028/U+2029 and the `[ \t]+` before it backtracks quadratically.
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/s;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/s;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_MARKER = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/s;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
// Each cell's `[ \t]*` already takes trailing blanks, so the tail is only an optional pipe and its blanks: two adjacent
// `[ \t]*` would backtrack quadratically on a long run of spaces.
const DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*(?:\|[ \t]*)?$/;

interface Fence {
	char: string;
	size: number;
	indent: number;
}

interface Marker {
	indent: number;
	ordered: boolean;
	number: number;
	/** Column where the item's content starts (the marker, then 1-4 spaces). */
	content: number;
	/** The first line of the item's content. */
	rest: string;
}

/** Replaces tabs in the leading whitespace with spaces, to 4-column stops. */
function expandTabs(line: string): string {
	if (!line.includes("\t")) return line;
	const lead = (/^[ \t]*/.exec(line) as RegExpExecArray)[0];
	let column = 0;
	for (const char of lead) column += char === "\t" ? 4 - (column % 4) : 1;
	return " ".repeat(column) + line.slice(lead.length);
}

function openFence(line: string): Fence | null {
	const match = FENCE_OPEN.exec(line);
	if (match === null) return null;
	const marks = match[2] as string;
	// A backtick fence's info string may not hold a backtick: that line is inline code, not a fence.
	if (marks.startsWith("`") && (match[3] as string).includes("`")) return null;
	return { char: marks[0] as string, size: marks.length, indent: (match[1] as string).length };
}

function closesFence(line: string, fence: Fence): boolean {
	const match = FENCE_CLOSE.exec(line);
	return match !== null && (match[1] as string)[0] === fence.char && (match[1] as string).length >= fence.size;
}

function listMarker(line: string): Marker | null {
	const match = LIST_MARKER.exec(line);
	if (match === null) return null;
	const indent = (match[1] as string).length;
	const mark = match[2] as string;
	const spaces = (match[3] as string | undefined)?.length ?? 0;
	let rest = (match[4] as string | undefined) ?? "";
	let gap = spaces;
	if (rest.trim() === "") {
		rest = "";
		gap = 1;
	} else if (spaces > 4) {
		rest = " ".repeat(spaces - 1) + rest;
		gap = 1;
	}
	const ordered = mark.length > 1;
	return { indent, ordered, number: ordered ? Number.parseInt(mark, 10) : 1, content: indent + mark.length + gap, rest };
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** Splits a table row on unescaped pipes outside code spans; `\|` becomes `|`. Cells are trimmed; outer pipes dropped. */
function splitRow(line: string): { cells: string[]; pipes: number } {
	const text = line.trim();
	const scan = newScan(text);
	const cells: string[] = [];
	let cell = "";
	let pipes = 0;
	let endedWithPipe = false;
	let at = 0;
	while (at < text.length) {
		const char = text[at] as string;
		endedWithPipe = false;
		if (char === "\\" && at + 1 < text.length) {
			const next = text[at + 1] as string;
			cell += next === "|" ? "|" : char + next;
			at += 2;
		} else if (char === "`") {
			const run = runLength(text, at, "`");
			const close = findCodeClose(scan, at + run, run);
			if (close < 0) {
				cell += "`".repeat(run);
				at += run;
			} else {
				cell += text.slice(at, close + run).replaceAll("\\|", "|");
				at = close + run;
			}
		} else if (char === "|") {
			cells.push(cell);
			cell = "";
			pipes++;
			endedWithPipe = true;
			at++;
		} else {
			cell += char;
			at++;
		}
	}
	cells.push(cell);
	if (pipes > 0 && text.startsWith("|")) cells.shift();
	if (endedWithPipe) cells.pop();
	return { cells: cells.map(value => value.trim()), pipes };
}

/** The column alignments when `lines[at]` and `lines[at + 1]` are a table header and its delimiter row, else null. */
function tableAt(lines: string[], at: number): { align: Align[]; head: string[] } | null {
	const delimiter = lines[at + 1];
	if (delimiter === undefined || !DELIMITER.test(delimiter)) return null;
	const head = splitRow(lines[at] as string);
	if (head.pipes === 0) return null;
	const marks = splitRow(delimiter).cells;
	if (marks.length !== head.cells.length) return null;
	const align = marks.map((mark): Align => {
		const left = mark.startsWith(":");
		const right = mark.endsWith(":");
		if (left && right) return "center";
		if (left) return "left";
		return right ? "right" : null;
	});
	return { align, head: head.cells };
}

/** A heading's text without its optional closing run of `#`. */
function headingText(rest: string): string {
	const text = rest.trimEnd();
	let end = text.length;
	while (end > 0 && text[end - 1] === "#") end--;
	const closing = end > 0 && end < text.length && (text[end - 1] === " " || text[end - 1] === "\t");
	return closing ? text.slice(0, end).trimEnd() : text;
}

/** Whether `line` on its own starts a block other than a paragraph. */
function startsBlockLine(line: string): boolean {
	return HEADING.test(line) || openFence(line) !== null || RULE.test(line) || QUOTE.test(line) || listMarker(line) !== null;
}

/** Whether `lines[at]` starts a block other than a paragraph, so it cannot be a lazy continuation line. */
function startsBlock(lines: string[], at: number, tables: boolean): boolean {
	return startsBlockLine(lines[at] as string) || (tables && tableAt(lines, at) !== null);
}

/** Whether the last content of `blocks` is paragraph text, which a lazy continuation line may extend. */
function endsInParagraph(blocks: Block[]): boolean {
	const last = blocks[blocks.length - 1];
	if (last === undefined) return false;
	if (last.kind === "paragraph") return true;
	if (last.kind === "quote") return endsInParagraph(last.children);
	if (last.kind === "list") return endsInParagraph(last.items[last.items.length - 1]?.children ?? []);
	return false;
}

/** Nesting limit for quotes and lists: deeper markers stay text, which bounds recursion and re-parsing. */
const MAX_BLOCK_DEPTH = 16;

/**
 * Where a parse is: how deep inside quotes and lists, and the shared allowances for the whole document: lines that
 * lazy-continuation checks may re-parse, and empty cells that tables may add to pad short rows.
 */
interface Level {
	depth: number;
	budget: { lines: number; cells: number };
}

/**
 * Empty cells all tables of a document may add to pad short rows (cmark-gfm's `MAX_AUTOCOMPLETED_CELLS` idea). Every
 * non-blank line under a table is a row, so a wide header over many one-word lines would otherwise make millions of
 * cells from a few kilobytes; a table that runs out ends there and the rest is text.
 */
const MAX_PADDED_CELLS = 10_000;

/** The stripped lines of a quote or list item, and whether they are known to end in an open paragraph (null: unknown). */
interface Gathered {
	lines: string[];
	open: boolean | null;
}

function gather(into: Gathered, line: string): void {
	into.lines.push(line);
	// A plain text line keeps an open paragraph open; any other line may change what the content ends in.
	const plain = line.trim() !== "" && !SETEXT.test(line) && !DELIMITER.test(line) && !startsBlockLine(line);
	into.open = into.open === true && plain ? true : null;
}

/** Whether a lazy continuation line may join `from`: its content, parsed at `level`, ends in paragraph text. */
function continuesParagraph(from: Gathered, level: Level): boolean {
	if (from.open === null) {
		// Every check re-parses what was gathered so far; the allowance keeps pathological nesting from compounding.
		if (level.budget.lines < from.lines.length) return false;
		level.budget.lines -= from.lines.length;
		from.open = endsInParagraph(parseBlocks(from.lines, level));
	}
	return from.open;
}

/** The block quote starting at `lines[start]`: its stripped lines, parsed as blocks, and the index after it. */
function parseQuote(lines: string[], start: number, level: Level): { block: Block; next: number } {
	const child: Level = { depth: level.depth + 1, budget: level.budget };
	const inner: Gathered = { lines: [], open: null };
	let at = start;
	while (at < lines.length) {
		const line = lines[at] as string;
		if (QUOTE.test(line)) {
			gather(inner, line.replace(/^ {0,3}> ?/, ""));
		} else if (line.trim() === "" || startsBlock(lines, at, true) || !continuesParagraph(inner, child)) {
			break;
		} else {
			gather(inner, line);
		}
		at++;
	}
	return { block: { kind: "quote", children: parseBlocks(inner.lines, child) }, next: at };
}

function makeItem(lines: string[], level: Level): ListItem {
	const task = TASK.exec(lines[0] as string);
	if (task === null) return { checked: null, children: parseBlocks(lines, level) };
	return { checked: task[1] !== " ", children: parseBlocks([(lines[0] as string).slice(task[0].length), ...lines.slice(1)], level) };
}

/** The list whose first item's marker is on `lines[start]`, and the index after it. */
function parseList(lines: string[], start: number, first: Marker, level: Level): { block: Block; next: number } {
	const child: Level = { depth: level.depth + 1, budget: level.budget };
	const items: ListItem[] = [];
	let marker = first;
	let at = start;
	for (;;) {
		// Lenient on purpose: two spaces nest under `1.` (agents write that), a one-space marker stays a sibling.
		const threshold = Math.min(marker.content, marker.indent + 2);
		const item: Gathered = { lines: [], open: null };
		gather(item, marker.rest);
		let next: Marker | null = null;
		let j = at + 1;
		while (j < lines.length) {
			let line = lines[j] as string;
			let afterBlank = false;
			if (line.trim() === "") {
				let k = j + 1;
				while (k < lines.length && (lines[k] as string).trim() === "") k++;
				if (k >= lines.length) {
					j = k;
					break;
				}
				if (indentOf(lines[k] as string) >= threshold) {
					for (; j < k; j++) gather(item, "");
					continue;
				}
				j = k;
				line = lines[k] as string;
				afterBlank = true;
			}
			const indent = indentOf(line);
			if (indent >= threshold) {
				gather(item, line.slice(Math.min(indent, marker.content)));
				j++;
				continue;
			}
			if (RULE.test(line)) break;
			const sibling = listMarker(line);
			if (sibling !== null && sibling.ordered === first.ordered) {
				next = sibling;
				break;
			}
			if (afterBlank || startsBlock(lines, j, true) || !continuesParagraph(item, child)) break;
			gather(item, line);
			j++;
		}
		items.push(makeItem(item.lines, child));
		at = j;
		if (next === null) break;
		marker = next;
	}
	return { block: { kind: "list", ordered: first.ordered, start: first.number, items }, next: at };
}

/** Pads or cuts `cells` to `count` and parses each. */
function fitRow(cells: string[], count: number): Inline[][] {
	return Array.from({ length: count }, (_, column) => parseInline(cells[column] ?? ""));
}

/** Paragraph lines joined with spaces. A trailing unescaped `\` is a hard break, shown as that space, so it is dropped. */
function joinLines(lines: string[]): string {
	return lines
		.map((line, index) => {
			if (index === lines.length - 1) return line;
			let run = 0;
			while (line[line.length - 1 - run] === "\\") run++;
			return run % 2 === 1 ? line.slice(0, -1) : line;
		})
		.join(" ");
}

/** Parses already newline-split `input` lines; list items and quotes call this on their stripped lines. */
function parseBlocks(input: string[], level: Level): Block[] {
	const lines = input.map(expandTabs);
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	const endParagraph = (): void => {
		if (paragraph.length > 0) blocks.push({ kind: "paragraph", children: parseInline(joinLines(paragraph)) });
		paragraph = [];
	};
	const nests = level.depth < MAX_BLOCK_DEPTH;

	let at = 0;
	while (at < lines.length) {
		const line = lines[at] as string;
		if (line.trim() === "") {
			endParagraph();
			at++;
			continue;
		}
		const fence = openFence(line);
		if (fence !== null) {
			endParagraph();
			const body: string[] = [];
			for (at++; at < lines.length && !closesFence(lines[at] as string, fence); at++) {
				const text = lines[at] as string;
				body.push(text.slice(Math.min(fence.indent, indentOf(text))));
			}
			at++;
			blocks.push({ kind: "code", text: body.join("\n") });
			continue;
		}
		const setext = paragraph.length > 0 ? SETEXT.exec(line) : null;
		if (setext !== null) {
			blocks.push({ kind: "heading", level: (setext[1] as string).startsWith("=") ? 1 : 2, children: parseInline(joinLines(paragraph)) });
			paragraph = [];
			at++;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			endParagraph();
			blocks.push({ kind: "heading", level: (heading[1] as string).length, children: parseInline(headingText(heading[2] as string)) });
			at++;
			continue;
		}
		if (RULE.test(line)) {
			endParagraph();
			blocks.push({ kind: "rule" });
			at++;
			continue;
		}
		if (nests && QUOTE.test(line)) {
			endParagraph();
			const quote = parseQuote(lines, at, level);
			blocks.push(quote.block);
			at = quote.next;
			continue;
		}
		const marker = nests ? listMarker(line) : null;
		// A bullet interrupts a paragraph, an ordered item only when it starts at 1; an empty item never does.
		if (marker !== null && (paragraph.length === 0 || (marker.rest !== "" && (!marker.ordered || marker.number === 1)))) {
			endParagraph();
			const list = parseList(lines, at, marker, level);
			blocks.push(list.block);
			at = list.next;
			continue;
		}
		const table = tableAt(lines, at);
		if (table !== null) {
			endParagraph();
			const rows: Inline[][][] = [];
			for (at += 2; at < lines.length && (lines[at] as string).trim() !== "" && !startsBlock(lines, at, false); at++) {
				const { cells } = splitRow(lines[at] as string);
				const missing = Math.max(0, table.align.length - cells.length);
				if (missing > level.budget.cells) break;
				level.budget.cells -= missing;
				rows.push(fitRow(cells, table.align.length));
			}
			blocks.push({ kind: "table", align: table.align, head: fitRow(table.head, table.align.length), rows });
			continue;
		}
		paragraph.push(line.trim());
		at++;
	}
	endParagraph();
	return blocks;
}

export function parseMarkdown(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	return parseBlocks(lines, { depth: 0, budget: { lines: 2 * lines.length + 64, cells: MAX_PADDED_CELLS } });
}
