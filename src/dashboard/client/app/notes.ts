/**
 * The Markdown the CHANGELOG uses, as data: headings, paragraphs, `-`/`*` bullet lists (continuation lines included),
 * fenced code, and inline `**bold**`, `*em*`, `` `code` `` and `[text](url)`. Release notes come from a remote feed, so
 * this never produces HTML: the renderer builds React elements from these nodes, and only http(s) links become anchors.
 * Not Markdown: nested lists, ordered lists, tables, images, raw HTML (all of it stays text).
 */

export type Inline =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "strong"; children: Inline[] }
	| { kind: "em"; children: Inline[] }
	| { kind: "link"; href: string; children: Inline[] };

export type Block =
	| { kind: "heading"; level: number; children: Inline[] }
	| { kind: "paragraph"; children: Inline[] }
	| { kind: "list"; items: Inline[][] }
	| { kind: "code"; text: string };

const CODE = /`([^`]+)`/y;
const LINK = /\[([^\]]+)\]\(([^()\s]+)\)/y;
const STRONG = /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/y;
const EM = /\*(?=[^\s*])([^*]+?)(?<=\S)\*/y;
const ESCAPABLE = "\\`*[]()#-_";

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

export function parseInline(text: string): Inline[] {
	const out: Inline[] = [];
	let at = 0;
	while (at < text.length) {
		const char = text[at];
		if (char === "\\" && at + 1 < text.length && ESCAPABLE.includes(text[at + 1] as string)) {
			pushText(out, text[at + 1] as string);
			at += 2;
			continue;
		}
		let match: RegExpExecArray | null = null;
		if (char === "`" && (match = matchAt(CODE, text, at))) {
			out.push({ kind: "code", text: match[1] as string });
		} else if (char === "[" && (match = matchAt(LINK, text, at))) {
			const children = parseInline(match[1] as string);
			const href = safeHref(match[2] as string);
			// Anything but an http(s) URL keeps its label as text: a `javascript:` target is never made clickable.
			if (href === null) for (const child of children) out.push(child);
			else out.push({ kind: "link", href, children });
		} else if (char === "*" && text[at + 1] === "*" && (match = matchAt(STRONG, text, at))) {
			out.push({ kind: "strong", children: parseInline(match[1] as string) });
		} else if (char === "*" && (match = matchAt(EM, text, at))) {
			out.push({ kind: "em", children: parseInline(match[1] as string) });
		}
		if (match === null) {
			pushText(out, char as string);
			at += 1;
		} else {
			at += match[0].length;
		}
	}
	return out;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^\s*[-*][ \t]+(.*)$/;
const FENCE = /^ {0,3}```/;

export function parseMarkdown(source: string): Block[] {
	const blocks: Block[] = [];
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let paragraph: string[] = [];
	let list: string[][] | null = null;
	/** A blank line came after the last list line: only an indented line or a bullet still belongs to the list. */
	let gap = false;

	const endParagraph = (): void => {
		if (paragraph.length > 0) blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) });
		paragraph = [];
	};
	const endList = (): void => {
		if (list !== null) blocks.push({ kind: "list", items: list.map(item => parseInline(item.join(" "))) });
		list = null;
		gap = false;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (FENCE.test(line)) {
			endParagraph();
			endList();
			const body: string[] = [];
			for (i++; i < lines.length && !FENCE.test(lines[i] as string); i++) body.push(lines[i] as string);
			blocks.push({ kind: "code", text: body.join("\n") });
			continue;
		}
		if (line.trim() === "") {
			endParagraph();
			if (list !== null) gap = true;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			endParagraph();
			endList();
			blocks.push({ kind: "heading", level: (heading[1] as string).length, children: parseInline(heading[2] as string) });
			continue;
		}
		const bullet = BULLET.exec(line);
		if (bullet !== null) {
			endParagraph();
			list ??= [];
			list.push([(bullet[1] as string).trim()]);
			gap = false;
			continue;
		}
		if (list !== null && (!gap || /^\s/.test(line))) {
			(list[list.length - 1] as string[]).push(line.trim());
			gap = false;
			continue;
		}
		endList();
		paragraph.push(line.trim());
	}
	endParagraph();
	endList();
	return blocks;
}
