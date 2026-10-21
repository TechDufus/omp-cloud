/**
 * Pure mapping of omp's session events to the progress events the runner appends to a thread's log, and the
 * accounting the runner reads off the same events. Events arrive as parsed JSON, so everything is guarded.
 */
import { isRecord } from "../guards";
import type { Usage } from "../store/types";

/** One event for `Store.appendEvent`; the store cuts the text to its limit. */
export interface Progress {
	kind: "assistant" | "tool" | "tool_error" | "notice";
	text: string;
}

/** The longest compact argument list a `tool` event shows. */
const MAX_ARGS_CHARS = 200;

/** Text of an omp `AgentMessage`: `content` is a string or an array of `{type: "text", text}` blocks. */
export function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

/** Whitespace-collapsed JSON of tool arguments, cut to `MAX_ARGS_CHARS`; `""` for none. */
function compactArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	let json: string | undefined;
	try {
		json = JSON.stringify(args);
	} catch {
		return "";
	}
	if (json === undefined || json === "{}") return "";
	const flat = json.replace(/\s+/g, " ");
	return flat.length > MAX_ARGS_CHARS ? `${flat.slice(0, MAX_ARGS_CHARS)}…` : flat;
}

/** The first non-empty line of a tool result's text blocks. */
function resultSummary(result: unknown): string {
	if (!isRecord(result)) return "";
	const text = messageText(result);
	return text.split("\n").find(line => line.trim() !== "")?.trim() ?? "";
}

/** The progress event of one omp session event; null for events the thread log does not show. */
export function progressOf(event: unknown): Progress | null {
	if (!isRecord(event)) return null;
	switch (event.type) {
		case "message_end": {
			if (!isRecord(event.message) || event.message.role !== "assistant") return null;
			const text = messageText(event.message).trim();
			return text === "" ? null : { kind: "assistant", text };
		}
		case "tool_execution_start": {
			if (typeof event.toolName !== "string") return null;
			const intent = typeof event.intent === "string" ? event.intent.trim() : "";
			const detail = intent !== "" ? intent : compactArgs(event.args);
			return { kind: "tool", text: detail === "" ? event.toolName : `${event.toolName} ${detail}` };
		}
		case "tool_execution_end": {
			if (event.isError !== true || typeof event.toolName !== "string") return null;
			const summary = resultSummary(event.result);
			return { kind: "tool_error", text: summary === "" ? event.toolName : `${event.toolName}: ${summary}` };
		}
		case "auto_retry_start": {
			const message = typeof event.errorMessage === "string" ? event.errorMessage : "";
			return { kind: "notice", text: `retry ${String(event.attempt)}/${String(event.maxAttempts)}: ${message}` };
		}
		case "auto_compaction_start": {
			const reason = typeof event.reason === "string" ? event.reason : "";
			const action = typeof event.action === "string" ? event.action : "";
			return { kind: "notice", text: `compacting the context (${[action, reason].filter(part => part !== "").join(", ")})` };
		}
		case "notice": {
			if (typeof event.message !== "string") return null;
			return { kind: "notice", text: typeof event.source === "string" && event.source !== "" ? `${event.source}: ${event.message}` : event.message };
		}
		default:
			return null;
	}
}

/** What an assistant `message_end` event adds up: its token usage and how the message ended. */
export interface AssistantEnd {
	usage: Usage | null;
	stopReason: string;
	errorMessage: string;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The token usage and stop information of an assistant message; null when `message` is not one. */
export function assistantEnd(message: unknown): AssistantEnd | null {
	if (!isRecord(message) || message.role !== "assistant") return null;
	let usage: Usage | null = null;
	if (isRecord(message.usage)) {
		usage = {
			inputTokens: count(message.usage.input),
			outputTokens: count(message.usage.output),
			cacheReadTokens: count(message.usage.cacheRead),
			cacheWriteTokens: count(message.usage.cacheWrite),
			cost: isRecord(message.usage.cost) ? count(message.usage.cost.total) : 0,
		};
	}
	return {
		usage,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : "",
		errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : "",
	};
}

/** `total` plus `more`; a null side is the other side. */
export function addUsage(total: Usage | null, more: Usage | null): Usage | null {
	if (total === null) return more;
	if (more === null) return total;
	return {
		inputTokens: total.inputTokens + more.inputTokens,
		outputTokens: total.outputTokens + more.outputTokens,
		cacheReadTokens: total.cacheReadTokens + more.cacheReadTokens,
		cacheWriteTokens: total.cacheWriteTokens + more.cacheWriteTokens,
		cost: total.cost + more.cost,
	};
}

// ---- structured events: `usage`, `tool_start`, `tool_end` (the `text` of each is one JSON object, `STRUCTURED_EVENT_KINDS`)

/** The longest id, name or error a structured event carries; the most jobs a `tool_end` lists. Keeps every event under `MAX_STRUCTURED_EVENT_CHARS`. */
export const MAX_FIELD_CHARS = 200;
export const MAX_ID_CHARS = 64;
const MAX_SPAWNED = 16;

/** A job or agent a tool call started: `agent` is the subagent's id (`""` for a job that is no agent, a bash job), `job` the job id. */
export interface Spawned {
	agent: string;
	job: string;
}

/** One structured progress event for `Store.appendEvent`: `text` is `JSON.stringify` of the shape the kind documents in `docs/api.md`. */
export interface StructuredProgress {
	kind: "usage" | "tool_start" | "tool_end";
	text: string;
}

export function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function textField(value: unknown, max: number): string {
	return typeof value === "string" ? clip(value.trim(), max) : "";
}

/**
 * The `usage` event of an assistant `message_end`, one per model request: `{input, output, cacheRead, cacheWrite, cost, model,
 * stopReason, context}`. `context` is the context the request ended with, `tokens` the request's input, cache and output tokens
 * (what omp's own estimate adds up) and `window` the model's context window as omp last reported it (`0` when it has not); null
 * when the message carries no usage. `window` is whatever the runner last read from omp's `get_state`.
 */
export function usageEventOf(event: unknown, window: number): StructuredProgress | null {
	if (!isRecord(event) || event.type !== "message_end") return null;
	const end = assistantEnd(event.message);
	if (end === null || end.usage === null || !isRecord(event.message)) return null;
	const { usage } = end;
	const provider = textField(event.message.provider, 80);
	const model = textField(event.message.model, 120);
	return {
		kind: "usage",
		text: JSON.stringify({
			input: usage.inputTokens,
			output: usage.outputTokens,
			cacheRead: usage.cacheReadTokens,
			cacheWrite: usage.cacheWriteTokens,
			cost: usage.cost,
			model: provider !== "" && model !== "" ? `${provider}/${model}` : model,
			stopReason: end.stopReason,
			context: { tokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, window },
		}),
	};
}

/** The `tool_start` event of a `tool_execution_start`: `{id, tool, intent, args}` (`args` the compact, clipped argument JSON, `intent` omp's one-line intent; either `""`). */
export function toolStartEventOf(event: unknown): StructuredProgress | null {
	if (!isRecord(event) || event.type !== "tool_execution_start" || typeof event.toolName !== "string") return null;
	return {
		kind: "tool_start",
		text: JSON.stringify({
			id: textField(event.toolCallId, MAX_ID_CHARS),
			tool: clip(event.toolName, MAX_FIELD_CHARS),
			intent: textField(event.intent, MAX_FIELD_CHARS),
			args: compactArgs(event.args),
		}),
	};
}

// omp's task tool reports a spawned job only as text ("Spawned agent `X` (job `Y`)." and a list of "- `X` (job `Y`)" lines), so
// finding the ids parses that wording: a change of it in omp stops the match, and `details.async`/`details.started` (below) are the structured fallback.
const SPAWN_AGENT = /Spawned agent `([^`]+)` \(job `([^`]+)`\)/g;
const SPAWN_LISTED = /^- `([^`]+)` \(job `([^`]+)`\)/gm;

/**
 * The background jobs a finished tool call started and left running: a task call's spawned agents (omp's spawn feedback names
 * each `agent` and `job`) and a background bash job (`details.async` still `running`, or the ids a result's details list).
 */
export function spawnedOf(result: unknown): Spawned[] {
	if (!isRecord(result)) return [];
	const found = new Map<string, Spawned>();
	const add = (agent: unknown, job: unknown): void => {
		const jobId = textField(job, MAX_ID_CHARS);
		if (jobId === "" || found.has(jobId)) return;
		found.set(jobId, { agent: textField(agent, MAX_ID_CHARS), job: jobId });
	};
	const text = messageText(result);
	for (const match of text.matchAll(SPAWN_AGENT)) add(match[1], match[2]);
	for (const match of text.matchAll(SPAWN_LISTED)) add(match[1], match[2]);
	const { details } = result;
	if (isRecord(details)) {
		if (isRecord(details.async) && details.async.state === "running") add("", details.async.jobId);
		if (Array.isArray(details.started)) {
			for (const entry of details.started) if (isRecord(entry)) add(entry.agentId, entry.jobId);
		}
	}
	return [...found.values()].slice(0, MAX_SPAWNED);
}

/** The jobs a `tool_execution_end` event left running ({@link spawnedOf}); none for another event or a failed call. */
export function spawnedBy(event: unknown): Spawned[] {
	if (!isRecord(event) || event.type !== "tool_execution_end" || event.isError === true) return [];
	return spawnedOf(event.result);
}

/**
 * The `tool_end` event of a `tool_execution_end`: `{id, tool, ok, ms, error, async, detached, spawned}`. `ms` is the call's duration
 * as the runner measured it between the two events (`null` when it never saw the start); `error` the first line of a failed
 * call's result, `""` when ok; `spawned` the jobs the call started and left running ({@link spawnedOf}); `detached` is true when
 * there are any (the call returned while they run); `async` is true for those and for a call that asked for background execution
 * (`args.async`; `args` is what `tool_start` saw, undefined when unknown).
 */
export function toolEndEventOf(event: unknown, startedMs: number | null, nowMs: number, args: unknown): StructuredProgress | null {
	if (!isRecord(event) || event.type !== "tool_execution_end" || typeof event.toolName !== "string") return null;
	const failed = event.isError === true;
	const spawned = spawnedBy(event);
	const asked = isRecord(args) && args.async === true;
	return {
		kind: "tool_end",
		text: JSON.stringify({
			id: textField(event.toolCallId, MAX_ID_CHARS),
			tool: clip(event.toolName, MAX_FIELD_CHARS),
			ok: !failed,
			ms: startedMs === null ? null : Math.max(0, Math.round(nowMs - startedMs)),
			error: failed ? clip(resultSummary(event.result), MAX_FIELD_CHARS) : "",
			async: asked || spawned.length > 0,
			detached: spawned.length > 0,
			spawned,
		}),
	};
}
