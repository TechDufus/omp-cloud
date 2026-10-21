/**
 * A thread's event log as the lines a person reads, shared by every surface that lists events (the turn card's fold, the hub's
 * Live list, the cloud job's Output tail).
 *
 * The service writes one tool call as several events: the plain `tool` line (its intent or compact arguments), then `tool_start`,
 * and when it ends `tool_end` (and a `tool_error` line first when it failed); each model request also writes a `usage` event.
 * Read raw they print as JSON and one call takes up to four lines. Folded here, a call is one line the way omp's own task
 * progress names it (`bash: for i in …`), with its outcome and duration once it ends; `usage` has no line of its own (it feeds
 * the stats, see `turn-progress.ts`), nor do the `child_*` events (each child is a job of its own, see `cloud-children.ts`); an
 * assistant message is its first line; every other kind is its text as it is. A service without the structured events sends only
 * the plain lines, which then stand for their calls.
 */

import { previewArgument, toolLabel } from "./cloud-job";
import { clip, formatDuration } from "./format";
import { eventPayload, isRecord } from "./guards";
import type { ThreadEvent } from "./types";

/** One line of the folded log. */
export interface EventLine {
	/** The event the line stands at: a call's `tool` line or its `tool_start`. */
	seq: number;
	kind: string;
	text: string;
	/** When the call began, in ms, while it is in flight: its `tool_start` came and its `tool_end` has not. */
	running?: number;
}

interface Entry extends EventLine {
	/** The call's id from `tool_start`; undefined for a plain line. */
	id?: string;
	tool?: string;
	/** A plain `tool` (`tool`) or `tool_error` (`error`) line that the structured events of its call may still replace. */
	plain?: "tool" | "error";
}

const LINE_MAX = 300;

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The tool a plain `tool` or `tool_error` line names: its first word without a trailing colon. */
function plainTool(text: string): string {
	const head = text.trim().split(/\s/, 1)[0] ?? "";
	return head.endsWith(":") ? head.slice(0, -1) : head;
}

/** When the event happened, in ms. */
function timeOf(e: ThreadEvent): number {
	const t = Date.parse(e.at);
	return Number.isFinite(t) ? t : Date.now();
}

/** `850ms`, `4s`, `1m05s`. */
function took(ms: unknown): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms);
}

/** The log folded as events arrive: `push` each event in order, read `lines`; at most `cap` lines are kept (the oldest go first). */
export class EventLog {
	readonly #entries: Entry[] = [];
	readonly #cap: number;

	constructor(cap = Number.POSITIVE_INFINITY) {
		this.#cap = cap;
	}

	get lines(): readonly EventLine[] {
		return this.#entries;
	}

	push(e: ThreadEvent): void {
		switch (e.kind) {
			case "usage":
			case "child_start":
			case "child_progress":
			case "child_end":
				return;
			case "tool":
				return this.#plain(e, "tool");
			case "tool_error":
				return this.#plain(e, "error");
			case "tool_start":
				return this.#start(e);
			case "tool_end":
				return this.#end(e);
			case "assistant": {
				const first = e.text.trim().split("\n", 1)[0] ?? "";
				if (first.trim() !== "") this.#add({ seq: e.seq, kind: "assistant", text: clip(first, LINE_MAX) });
				return;
			}
			default:
				if (e.text.trim() !== "") this.#add({ seq: e.seq, kind: e.kind, text: clip(e.text, LINE_MAX) });
		}
	}

	#add(entry: Entry): void {
		this.#entries.push(entry);
		if (this.#entries.length > this.#cap) this.#entries.splice(0, this.#entries.length - this.#cap);
	}

	#plain(e: ThreadEvent, plain: "tool" | "error"): void {
		const text = e.text.trim();
		if (text === "") return;
		const tool = plainTool(text);
		this.#add({ seq: e.seq, kind: plain === "tool" ? "tool" : "tool_error", text: clip(plain === "tool" ? toolLabel(text) : text, LINE_MAX), tool, plain });
	}

	#start(e: ThreadEvent): void {
		const p = eventPayload(e);
		const tool = str(p?.tool);
		if (!p || tool === "") return;
		const intent = str(p.intent).trim();
		const detail = intent !== "" ? intent : (previewArgument(str(p.args), tool)?.value ?? "");
		const text = clip(detail === "" ? tool : `${tool}: ${detail}`, LINE_MAX);
		const last = this.#entries.at(-1);
		// The plain line of this very call came just before.
		if (last?.plain === "tool" && last.tool === tool) {
			last.text = text;
			last.id = str(p.id) || undefined;
			last.running = timeOf(e);
			delete last.plain;
			return;
		}
		this.#add({ seq: e.seq, kind: "tool", text, tool, ...(str(p.id) === "" ? {} : { id: str(p.id), running: timeOf(e) }) });
	}

	#end(e: ThreadEvent): void {
		const p = eventPayload(e);
		const tool = str(p?.tool);
		if (!p || tool === "") return;
		const ok = p.ok !== false;
		const spawned = Array.isArray(p.spawned) ? p.spawned.flatMap(s => (isRecord(s) && str(s.agent) !== "" ? [str(s.agent)] : [])) : [];
		const outcome = [ok ? "✓" : `✕ ${str(p.error) || "failed"}`, took(p.ms), spawned.length > 0 ? `agent ${spawned.join(", ")}` : ""].filter(part => part !== "");
		const suffix = ` · ${outcome.join(" · ")}`;
		const id = str(p.id);
		const call = id === "" ? undefined : this.#entries.findLast(x => x.id === id);
		if (call) {
			call.text += suffix;
			delete call.id;
			delete call.running;
			// The failed call's plain error line, which came just before this event, says the same.
			const last = this.#entries.at(-1);
			if (!ok && last?.plain === "error" && last.tool === tool) this.#entries.pop();
			return;
		}
		// The error line of a call whose start the log never saw (after a reconnect) says the same as this event.
		if (!ok && this.#entries.at(-1)?.plain === "error" && this.#entries.at(-1)?.tool === tool) this.#entries.pop();
		// A plain line that stands for this call (its start was missed) takes the outcome; else the call is a line of its own.
		const plain = this.#entries.at(-1);
		if (plain?.plain === "tool" && plain.tool === tool) {
			plain.text += suffix;
			delete plain.plain;
			return;
		}
		this.#add({ seq: e.seq, kind: "tool", text: `${tool}${suffix}`, tool });
	}
}

/** How long a call runs before omp's task progress shows its elapsed time. */
const ELAPSED_MIN_MS = 5000;

/**
 * A call still in flight as omp's task progress draws a running tool: the tree hook (`└`) before it, and once it has run more than
 * five seconds its elapsed time after a dot (`└ bash: sleep 40 · 40s`). `now` is left out where nothing ticks (no elapsed time).
 */
export function runningText(text: string, startedAt: number, now?: number): string {
	const elapsed = now === undefined ? 0 : now - startedAt;
	return `└ ${text}${elapsed > ELAPSED_MIN_MS ? ` · ${formatDuration(elapsed)}` : ""}`;
}

/** What {@link eventLines} reads besides the events. */
export interface EventLinesOptions {
	/** The log is of a finished turn: a call with no `tool_end` is lost (its end was not seen), not running. */
	finished?: boolean;
}

/**
 * The events folded into the lines to show, oldest first. A call still in flight reads as omp draws a running tool
 * ({@link runningText}); in the log of a finished turn ({@link EventLinesOptions.finished}) one with no end says so instead.
 */
export function eventLines(events: readonly ThreadEvent[], opts: EventLinesOptions = {}): EventLine[] {
	const log = new EventLog();
	for (const e of events) log.push(e);
	return log.lines.map(({ seq, kind, text, running }) => ({ seq, kind, text: running === undefined ? text : opts.finished ? `${text} · no end seen` : runningText(text, running) }));
}

/**
 * The name a line is shown under: none for a tool call, whose text already names the tool (`bash: …`) as omp's own lines do;
 * any other kind under its own, a plain `tool_error` line included, so an error never reads as a call.
 */
export function lineLabel(line: { kind: string }): string | undefined {
	return line.kind === "tool" ? undefined : line.kind;
}

/** A line as plain text, under its {@link lineLabel}. */
export function lineText(line: { kind: string; text: string }): string {
	const label = lineLabel(line);
	return label === undefined ? line.text : `${label}: ${line.text}`;
}
