import { randomFillSync } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ompCommand, run } from "./exec";
import { isRecord } from "./guards";

export const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;
/** `customType` of the cards this extension adds to the transcript; never uploaded. */
export const CARD_TYPE = "omp-cloud";

const NL = 0x0a;
const PARENT_RE = /"parentId":"([^"]+)"/;

/** A UUIDv7: 48-bit millisecond timestamp, version 7, RFC 4122 variant, 74 random bits. */
export function uuidv7(now: number = Date.now()): string {
	const b = new Uint8Array(16);
	randomFillSync(b);
	let ms = now;
	for (let i = 5; i >= 0; i--) {
		b[i] = ms % 256;
		ms = Math.floor(ms / 256);
	}
	b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
	b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
	const h = Buffer.from(b).toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface RewriteOptions {
	/**
	 * The id of the pending `cloud` tool call of a delegation started by the tool. The assistant
	 * message carrying it, and every entry after it, is dropped so the cloud omp never sees a
	 * tool call without a result.
	 */
	dropFromToolCall?: string;
}

export interface RewrittenConversation {
	/** Original filename with its session id replaced by the new one. */
	filename: string;
	data: Buffer;
	oldId: string;
	newId: string;
	/** Cards (`custom_message` entries of type `omp-cloud`) left out of the fork. */
	droppedCards: number;
	/** Entries cut from the pending tool call on. */
	droppedForToolCall: number;
}

interface Line {
	buf: Buffer;
	/** Whether a newline followed the line in the original file. */
	nl: boolean;
}

function splitLines(data: Buffer): Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start < data.length) {
		const end = data.indexOf(NL, start);
		if (end < 0) {
			lines.push({ buf: data.subarray(start), nl: false });
			break;
		}
		lines.push({ buf: data.subarray(start, end), nl: true });
		start = end + 1;
	}
	return lines;
}

function joinLines(lines: Line[]): Buffer {
	const parts: Buffer[] = [];
	const nl = Buffer.from([NL]);
	for (const l of lines) {
		parts.push(l.buf);
		if (l.nl) parts.push(nl);
	}
	return Buffer.concat(parts);
}

function parseLine(l: Line): Record<string, unknown> | undefined {
	try {
		const v: unknown = JSON.parse(l.buf.toString("utf8"));
		return isRecord(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

function carriesToolCall(entry: Record<string, unknown>, toolCallId: string): boolean {
	if (entry.type !== "message") return false;
	const msg = entry.message;
	if (!isRecord(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) return false;
	return msg.content.some(block => isRecord(block) && block.type === "toolCall" && block.id === toolCallId);
}

/**
 * Cuts the pending tool call: the first assistant message that carries it and every line after
 * it (descendants are always later in the file). Returns the number of lines dropped.
 */
function dropFromToolCall(lines: Line[], toolCallId: string): number {
	const needle = Buffer.from(toolCallId);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line || !line.buf.includes(needle)) continue;
		const entry = parseLine(line);
		if (entry && carriesToolCall(entry, toolCallId)) {
			const dropped = lines.length - i;
			lines.length = i;
			// descendants are always later in the file, so nothing left refers to a dropped entry
			return dropped;
		}
	}
	return 0;
}

/** Drops the cards and re-links their children to the nearest surviving ancestor. Returns the cards dropped. */
function dropCards(lines: Line[]): { lines: Line[]; dropped: number } {
	const parentOf = new Map<string, string | null>();
	for (const l of lines) {
		if (!l.buf.includes("custom_message") || !l.buf.includes(CARD_TYPE)) continue;
		const e = parseLine(l);
		if (e?.type !== "custom_message" || e.customType !== CARD_TYPE || typeof e.id !== "string") continue;
		parentOf.set(e.id, typeof e.parentId === "string" ? e.parentId : null);
	}
	if (parentOf.size === 0) return { lines, dropped: 0 };

	const resolve = (id: string | null): string | null => {
		let cur = id;
		const seen = new Set<string>();
		while (cur !== null && parentOf.has(cur) && !seen.has(cur)) {
			seen.add(cur);
			cur = parentOf.get(cur) ?? null;
		}
		return cur;
	};

	const kept: Line[] = [];
	let dropped = 0;
	for (const l of lines) {
		const isCardLine = l.buf.includes("custom_message") && l.buf.includes(CARD_TYPE);
		const parent = PARENT_RE.exec(l.buf.toString("utf8"))?.[1];
		if (!isCardLine && !(parent && parentOf.has(parent))) {
			kept.push(l);
			continue;
		}
		const e = parseLine(l);
		if (!e) {
			kept.push(l);
		} else if (e.type === "custom_message" && e.customType === CARD_TYPE) {
			dropped++;
		} else if (typeof e.parentId === "string" && parentOf.has(e.parentId)) {
			kept.push({ buf: Buffer.from(JSON.stringify({ ...e, parentId: resolve(e.parentId) }), "utf8"), nl: l.nl });
		} else {
			kept.push(l);
		}
	}
	return { lines: kept, dropped };
}

/**
 * Forks a session file for the cloud: the `"type":"session"` header line (not always the first
 * line; a `title` entry can precede it) gets a new `id` and `parentSession` set to the original
 * path; cards of this extension are removed and their children re-linked; a pending tool call is
 * cut. Every other line, including the title slot, stays byte-identical.
 */
export function rewriteConversation(
	original: Buffer,
	originalPath: string,
	newId: string = uuidv7(),
	opts: RewriteOptions = {},
): RewrittenConversation {
	let lines = splitLines(original);
	let headerAt = -1;
	let header: Record<string, unknown> | undefined;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (!l || !l.buf.includes('"session"')) continue;
		const v = parseLine(l);
		if (v?.type === "session") {
			headerAt = i;
			header = v;
			break;
		}
	}
	if (!header || headerAt < 0) throw new Error("conversation has no session header line");

	const oldId = typeof header.id === "string" ? header.id : "";
	const headerLine = lines[headerAt];
	if (headerLine) {
		lines[headerAt] = { buf: Buffer.from(JSON.stringify({ ...header, id: newId, parentSession: originalPath }), "utf8"), nl: headerLine.nl };
	}

	let droppedForToolCall = 0;
	if (opts.dropFromToolCall) droppedForToolCall = dropFromToolCall(lines, opts.dropFromToolCall);
	const cards = dropCards(lines);
	lines = cards.lines;

	const data = joinLines(lines);
	const stem = basename(originalPath).replace(/\.jsonl$/, "");
	const filename = oldId && stem.endsWith(`_${oldId}`) ? `${stem.slice(0, -oldId.length)}${newId}.jsonl` : `${stem}_${newId}.jsonl`;
	return { filename, data, oldId, newId, droppedCards: cards.dropped, droppedForToolCall };
}

export type ConversationResult =
	| { kind: "none" }
	| { kind: "too-large"; bytes: number }
	| ({ kind: "ok"; path: string; bytes: number } & Omit<RewrittenConversation, "data">);

export interface PackOptions extends RewriteOptions {
	sessionFile: string | undefined;
	/** An existing scratch directory; the fork, its artifacts and the archive are written here. */
	tmpDir: string;
	env?: Record<string, string | undefined>;
}

/**
 * Forks the current session (new session id, cards dropped, pending tool call cut), writes the fork
 * and a copy of the session's artifacts directory into `tmpDir`, and packs it with the local
 * `omp session pack`. Packing a fork is what makes the archive possible: omp refuses to pack a session
 * that a live process is writing, and the lock is keyed by session id.
 */
export async function packConversation(opts: PackOptions): Promise<ConversationResult> {
	const { sessionFile } = opts;
	if (!sessionFile) return { kind: "none" };
	let size: number;
	try {
		size = (await stat(sessionFile)).size;
	} catch {
		return { kind: "none" };
	}
	if (size > MAX_CONVERSATION_BYTES) return { kind: "too-large", bytes: size };

	const fork = rewriteConversation(await readFile(sessionFile), sessionFile, undefined, { dropFromToolCall: opts.dropFromToolCall });
	const dir = join(opts.tmpDir, "conversation");
	await mkdir(dir, { recursive: true });
	const forkPath = join(dir, fork.filename);
	await writeFile(forkPath, fork.data);
	const artifacts = sessionFile.replace(/\.jsonl$/, "");
	if (await stat(artifacts).then(s => s.isDirectory(), () => false)) {
		await cp(artifacts, forkPath.replace(/\.jsonl$/, ""), { recursive: true });
	}

	const archive = join(opts.tmpDir, "conversation.tar");
	const [omp = "omp", ...prefix] = ompCommand();
	const r = await run(omp, [...prefix, "session", "pack", forkPath, archive], { cwd: dir, env: opts.env, timeoutMs: 120_000 });
	if (r.code !== 0) {
		throw new Error(`cannot pack the conversation with omp session pack: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
	}
	const bytes = (await stat(archive)).size;
	if (bytes > MAX_CONVERSATION_BYTES) return { kind: "too-large", bytes };
	const { data: _data, ...rest } = fork;
	return { kind: "ok", path: archive, bytes, ...rest };
}
