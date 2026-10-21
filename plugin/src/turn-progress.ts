/**
 * What a running cloud turn has done so far, kept the way omp keeps it for a native subagent: the call in flight and the
 * last five, the tool count, the requests, the tokens and cost and the context in use. It is read off the events the service
 * writes to the thread's log: the structured ones (`tool_start`, `tool_end`, `usage`; capability `events.live`). The plain
 * `tool` and `tool_error` lines the service writes beside them are the same calls and are ignored here. The thread's `metrics`
 * sum finished turns only, so {@link TurnProgress.metrics} adds the running
 * turn to them: the job's widget and its `AgentProgress` then move with every request, as a native subagent's do.
 */

import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { previewArgument } from "./cloud-job";
import { eventPayload, isRecord } from "./guards";
import type { ThreadEvent, ThreadMetrics } from "./types";

/** Calls `recentTools` keeps, as omp's own executor does. */
const RECENT_CALLS = 5;

/** A tool call in flight, with what omp previews of it. */
interface Call {
	tool: string;
	intent?: string;
	args?: string;
	argsKey?: string;
	startMs: number;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function timeOf(e: ThreadEvent, fallback: number): number {
	const t = Date.parse(e.at);
	return Number.isFinite(t) ? t : fallback;
}

/** The progress of one turn: feed it the turn's events in order. */
export class TurnProgress {
	readonly #now: () => number;
	#started = 0;
	readonly #active = new Map<string, Call>();
	#recent: AgentProgress["recentTools"] = [];
	#lastIntent: string | undefined;
	#requests = 0;
	#input = 0;
	#output = 0;
	#cacheRead = 0;
	#cacheWrite = 0;
	#cost = 0;
	#context: { tokens: number; window: number; at: string } | undefined;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Takes one event of the turn; events of other kinds change nothing. */
	note(e: ThreadEvent): void {
		switch (e.kind) {
			case "tool_start":
				return this.#start(e);
			case "tool_end":
				return this.#end(e);
			case "usage":
				return this.#usage(e);
		}
	}

	#start(e: ThreadEvent): void {
		const p = eventPayload(e);
		const tool = text(p?.tool);
		if (!p || tool === "") return;
		this.#started++;
		const intent = text(p.intent).trim();
		const arg = previewArgument(text(p.args), tool);
		this.#lastIntent = intent === "" ? this.#lastIntent : intent;
		this.#active.set(text(p.id) || `${this.#started}`, {
			tool,
			...(intent === "" ? {} : { intent }),
			...(arg ? { args: arg.value, argsKey: arg.key } : {}),
			startMs: timeOf(e, this.#now()),
		});
	}

	#end(e: ThreadEvent): void {
		const p = eventPayload(e);
		const tool = text(p?.tool);
		if (!p || tool === "") return;
		const id = text(p.id);
		const call = this.#active.get(id);
		this.#active.delete(id);
		this.#recent.unshift({
			tool,
			args: call?.args ?? "",
			...(call?.argsKey ? { argsKey: call.argsKey } : {}),
			...(call?.intent ? { intent: call.intent } : {}),
			isError: p.ok === false,
			endMs: timeOf(e, this.#now()),
		});
		if (this.#recent.length > RECENT_CALLS) this.#recent.length = RECENT_CALLS;
	}

	#usage(e: ThreadEvent): void {
		const p = eventPayload(e);
		if (!p) return;
		this.#requests++;
		this.#input += num(p.input);
		this.#output += num(p.output);
		this.#cacheRead += num(p.cacheRead);
		this.#cacheWrite += num(p.cacheWrite);
		this.#cost += num(p.cost);
		const context = isRecord(p.context) ? p.context : undefined;
		if (context) {
			const window = num(context.window);
			this.#context = { tokens: num(context.tokens), window: window > 0 ? window : (this.#context?.window ?? 0), at: e.at };
		}
	}

	/** Tool calls of the turn so far. */
	get tools(): number {
		return this.#started;
	}

	/** The call the service says is in flight (its `tool_start` came and its `tool_end` has not), as `tool: detail` with when it began; undefined without one. */
	running(): { label: string; startMs: number } | undefined {
		const call = this.#active.values().next().value;
		if (!call) return undefined;
		const detail = call.intent ?? call.args ?? "";
		return { label: detail === "" ? call.tool : `${call.tool}: ${detail}`, startMs: call.startMs };
	}

	/**
	 * The thread's metrics with this turn added: they sum finished turns only. `base` itself when the turn has shown nothing
	 * yet.
	 */
	metrics(base: ThreadMetrics | null): ThreadMetrics | null {
		if (this.tools === 0 && this.#requests === 0) return base;
		const usage = base?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
		const context = this.#context
			? { tokens: this.#context.tokens, window: this.#context.window > 0 ? this.#context.window : (base?.context?.window ?? 0), at: this.#context.at }
			: (base?.context ?? null);
		return {
			usage: {
				inputTokens: usage.inputTokens + this.#input,
				outputTokens: usage.outputTokens + this.#output,
				cacheReadTokens: usage.cacheReadTokens + this.#cacheRead,
				cacheWriteTokens: usage.cacheWriteTokens + this.#cacheWrite,
				cost: usage.cost + this.#cost,
			},
			requests: (base?.requests ?? 0) + this.#requests,
			tools: (base?.tools ?? 0) + this.tools,
			workMs: base?.workMs ?? 0,
			context,
			turns: base?.turns ?? [],
		};
	}

	/**
	 * The call state of an `AgentProgress`: what omp's Subagents strip, its live preview row and the panel read of a native
	 * subagent (`currentTool` and its intent or argument preview, `recentTools`, `lastIntent`).
	 */
	calls(): Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolArgsKey" | "currentToolIntent" | "currentToolStartMs" | "lastIntent" | "recentTools"> {
		const call = this.#active.values().next().value;
		return {
			recentTools: this.#recent.map(r => ({ ...r })),
			...(this.#lastIntent ? { lastIntent: this.#lastIntent } : {}),
			...(call
				? {
						currentTool: call.tool,
						currentToolStartMs: call.startMs,
						...(call.intent ? { currentToolIntent: call.intent } : {}),
						...(call.args ? { currentToolArgs: call.args, ...(call.argsKey ? { currentToolArgsKey: call.argsKey } : {}) } : {}),
					}
				: {}),
		};
	}
}
