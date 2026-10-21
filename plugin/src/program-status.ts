/**
 * The inbox as OSC 7501 child records (the Program Status Protocol): a terminal such as Tern lists one entry per pane from
 * them, shows a record's `msg`, and marks the pane. One record per thread with something unread: `blocked` while a question
 * is open, else `done` or `error` for the newest unread turn; `clear` once everything of the thread is read. The pane's own
 * state (working, idle) stays omp's: no `working` records and no root record are written here.
 */

import type { TerminalNotification } from "@oh-my-pi/pi-tui";
import { controlFree } from "./format";
import type { Inbox, InboxEntry } from "./inbox";

/** Where the plugin talks to the terminal: desktop notifications and OSC 7501 records. */
export interface TerminalSink {
	notify: (notification: TerminalNotification) => void;
	/** Writes one sequence to the terminal. */
	write: (sequence: string) => void;
}

const OSC_7501 = "\x1b]7501;";
const ST = "\x1b\\";
/** Every child of this plugin: a record id is a path, and `clear` removes the addressed record and everything beneath it. */
const ROOT_ID = "omp-cloud";
/** The protocol's decoded limits: `msg` 2048 bytes, `title` 192. */
const MSG_MAX_BYTES = 2048;
const TITLE_MAX_BYTES = 192;
/** A record id segment. */
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
/** Base64 of `text` as one control-free line of at most `max` UTF-8 bytes, cut at a character; undefined when nothing is left. */
export function encodeText(text: string, max: number): string | undefined {
	const line = controlFree(text);
	if (line === "") return undefined;
	let bytes = 0;
	let kept = "";
	for (const char of line) {
		const size = Buffer.byteLength(char);
		if (bytes + size > max) break;
		bytes += size;
		kept += char;
	}
	return kept === "" ? undefined : Buffer.from(kept).toString("base64");
}

/** The report that makes `thread`'s record say what `entries` (its unread entries, oldest first) say; undefined when it has none or its id is not a legal segment. */
export function reportFor(thread: string, entries: readonly InboxEntry[]): string | undefined {
	if (!SEGMENT.test(thread)) return undefined;
	const question = entries.findLast(e => e.kind === "question");
	const newest = question ?? entries.at(-1);
	if (!newest) return undefined;
	const head = newest.kind === "question" ? `state=blocked:kind=${newest.permission ? "permission" : "question"}` : newest.kind === "failure" ? "state=error" : "state=done";
	const text =
		newest.kind === "question"
			? `${newest.label} asks: ${newest.line}`
			: `${newest.label} · turn ${newest.turn} ${newest.kind === "failure" ? "failed" : "done"}${newest.line === "" ? "" : `: ${newest.line}`}`;
	const title = encodeText(newest.label, TITLE_MAX_BYTES);
	const msg = encodeText(text, MSG_MAX_BYTES);
	return `${OSC_7501}${head}:id=${ROOT_ID}/${thread}:app=omp-cloud${title ? `:title=${title}` : ""}${msg ? `:msg=${msg}` : ""}${ST}`;
}

/** The report that removes `thread`'s record, or every record of the plugin without a thread. */
export function clearReport(thread?: string): string {
	return `${OSC_7501}state=clear:id=${thread === undefined ? ROOT_ID : `${ROOT_ID}/${thread}`}${ST}`;
}

export interface ProgramStatusOptions {
	inbox: Pick<Inbox, "entries">;
	/** Writes one sequence to the terminal. */
	write: (sequence: string) => void;
	/** Whether the terminal's program status is on (omp's `terminal.programStatus`); read on every change. */
	enabled: () => boolean;
	/** Hears the setting change; returns the way to stop. Called at the first sync, not at construction. */
	onEnabledChange?: (listener: (enabled: boolean) => void) => () => void;
}

/** Keeps the terminal's records in line with the inbox: writes what changed, never what the terminal already has. */
export class ProgramStatus {
	readonly #o: ProgramStatusOptions;
	/** The report last written per thread. */
	readonly #sent = new Map<string, string>();
	/** Stops listening to the setting; set at the first sync, when omp's settings are initialized. */
	#unsubscribe: (() => void) | undefined;
	#disposed = false;
	#started = false;
	readonly #resumed = (): void => {
		// A suspend's shell prompt drops the terminal's `blocked` records, and omp re-sends only its own: send ours again.
		for (const [thread, report] of this.#sent) if (report.includes("state=blocked")) this.#sent.delete(thread);
		this.sync();
	};

	constructor(options: ProgramStatusOptions) {
		this.#o = options;
	}

	/** Writes the reports of the threads whose record changed, and clears the records of the threads that are read. */
	sync(): void {
		if (this.#disposed) return;
		if (!this.#started) {
			// Not at construction: omp's settings are not initialized while extensions load.
			this.#started = true;
			process.on("SIGCONT", this.#resumed);
		}
		this.#unsubscribe ??= this.#o.onEnabledChange?.(enabled => {
			// Turning it off makes omp clear every record on the terminal, ours included: forget them, so turning it on writes them again.
			if (enabled) this.sync();
			else this.#sent.clear();
		});
		if (!this.#o.enabled()) {
			this.clearAll();
			return;
		}
		const unreadByThread = new Map<string, InboxEntry[]>();
		for (const e of this.#o.inbox.entries) {
			if (e.read) continue;
			const list = unreadByThread.get(e.thread);
			if (list) list.push(e);
			else unreadByThread.set(e.thread, [e]);
		}
		for (const thread of [...this.#sent.keys()]) {
			if (unreadByThread.has(thread)) continue;
			this.#sent.delete(thread);
			this.#o.write(clearReport(thread));
		}
		for (const [thread, entries] of unreadByThread) {
			const next = reportFor(thread, entries);
			if (next === undefined) continue;
			const before = this.#sent.get(thread);
			if (before === next) continue;
			this.#sent.set(thread, next);
			// A terminal treats a report that keeps the record's state as an update of what it already shows, not as a new arrival, and
			// a record written while its pane is focused counts as seen. Clearing first, in the same write, makes a changed event arrive.
			this.#o.write(before === undefined ? next : `${clearReport(thread)}${next}`);
		}
	}

	/** Removes every record of the plugin (a switch): nothing it wrote outlives the session. */
	clearAll(): void {
		if (this.#sent.size === 0) return;
		this.#sent.clear();
		this.#o.write(clearReport());
	}

	/** The session is over: the records go and nothing listens any more. */
	dispose(): void {
		this.clearAll();
		this.#disposed = true;
		process.off("SIGCONT", this.#resumed);
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}
}
