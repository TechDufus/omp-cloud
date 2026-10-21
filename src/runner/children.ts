/**
 * The background jobs and subagents a cloud agent starts inside its VM, as the `child_start`, `child_progress` and
 * `child_end` events of the thread (`docs/api.md`, "Child events"). omp has no job list on its RPC; a child is known from:
 *
 * - `subagent_lifecycle` / `subagent_progress` frames (after `set_subagent_subscription`): the start, progress and end of
 *   every detached `task` subagent, nested ones included (omp's session-tree bus);
 * - a finished tool call's spawn feedback (`tool_end.spawned`, {@link spawnedBy}): the start of a background `bash` or
 *   `eval` job, and of a task job before its subagent starts;
 * - the `async-result` message omp injects when a job's result is delivered (`details.jobs[{jobId, type, status, agentId, label, durationMs}]`):
 *   the end of a bash or eval job. When the agent read a job's result itself no `async-result` arrives;
 * - `session_settled` / `get_state.isSettled` (with `hasPendingAsyncWork`): omp has no background work left, so a child it never reported ended
 *   (its result was read inline, or it was cancelled): closed as completed, `inferred`; a completed job cannot be told from a cancelled one that way.
 *
 * An omp without `set_subagent_subscription` sends no subagent frames, so its task children are known only from the spawn
 * text and end by delivery or settled state. omp coalesces `subagent_progress` at 150 ms, and a nested subagent is named
 * `<parent>.<name>`, which is where a child's `parent` comes from. Output omp writes while nobody is attached (a paused or
 * reconnecting VM) is lost, so a real end may be missed and then shows as inferred.
 *
 * A child stays open across turns: its events carry the turn that spawned it, whether or not that turn still runs. Events
 * go through `sink`; the tracker keeps no other state than the open children.
 */
import { isRecord } from "../guards";
import type { ThreadEvent } from "../store/types";
import { clip, MAX_FIELD_CHARS, MAX_ID_CHARS, spawnedBy, textField } from "./progress";

export type ChildKind = "task" | "bash" | "eval";
export type ChildStatus = "completed" | "failed" | "cancelled";
export type ChildEventKind = "child_start" | "child_progress" | "child_end";

/** Appends one child event: `text` is `JSON.stringify` of the shape `docs/api.md` documents for `kind`. */
export type ChildSink = (kind: ChildEventKind, text: string, turn: number | null) => void;

/** A child's `child_progress` is written at most this often, and only when something it shows changed. */
const PROGRESS_MIN_MS = 2000;
/** Ids of ended children remembered, so a late `async-result` of a task that already ended is not taken for a new child. */
const MAX_ENDED = 256;
const TASK_FAILED = "the subagent failed";
const TASK_ABORTED = "the subagent was aborted";

/** What starts a child: `job` and `agent` as {@link Child} names them. */
interface ChildStart {
	turn: number | null;
	job: string;
	agent: string;
	kind: ChildKind;
	label: string;
	parentCall: string;
	description: string;
}

interface Child {
	/** What `child_start` said and every later event repeats; for a task, the agent's id (omp's job id is an alias, see {@link ChildTracker.#aliases}). */
	job: string;
	agent: string;
	kind: ChildKind;
	turn: number | null;
	startedMs: number;
	lastProgressMs: number;
	lastProgress: string;
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One line of at most `MAX_FIELD_CHARS` characters. */
function oneLine(text: unknown): string {
	return typeof text === "string" ? clip(text.replace(/\s+/g, " ").trim(), MAX_FIELD_CHARS) : "";
}

/** The label of a background job the way omp names it: a bash job's command, an eval job's title or first line of code. */
function jobLabel(tool: string, args: unknown): string {
	if (!isRecord(args)) return "";
	if (tool === "bash") return oneLine(args.command);
	if (tool !== "eval") return "";
	const title = oneLine(args.title);
	if (title !== "") return title;
	return typeof args.code === "string" ? oneLine(args.code.trim().split("\n", 1)[0]) : "";
}

function kindOf(type: unknown): ChildKind | null {
	return type === "task" || type === "bash" || type === "eval" ? type : null;
}

function statusOf(status: unknown): ChildStatus | null {
	return status === "completed" || status === "failed" || status === "cancelled" ? status : null;
}

export class ChildTracker {
	readonly #sink: ChildSink;
	readonly #now: () => number;
	/** The running children by `job`. */
	readonly #open = new Map<string, Child>();
	/** Other names of an open child: the job id omp gave a task whose id differs from its agent's. */
	readonly #aliases = new Map<string, string>();
	/** The `job` and `agent` of children that ended lately. */
	readonly #ended = new Set<string>();

	constructor(sink: ChildSink, now: () => number = Date.now) {
		this.#sink = sink;
		this.#now = now;
	}

	/** How many children are open. */
	get size(): number {
		return this.#open.size;
	}

	/** Rebuilds the open children from the thread's stored `child_start` and `child_end` events (after a restart of the service); the events of a thread's earlier runs are replayed in order. */
	restore(events: readonly ThreadEvent[]): void {
		this.#open.clear();
		this.#aliases.clear();
		for (const event of events) {
			let body: unknown;
			try {
				body = JSON.parse(event.text);
			} catch {
				continue;
			}
			if (!isRecord(body) || typeof body.job !== "string") continue;
			if (event.kind === "child_end") {
				this.#open.delete(body.job);
				continue;
			}
			const kind = kindOf(body.kind);
			if (event.kind !== "child_start" || kind === null) continue;
			const startedMs = Date.parse(event.at);
			this.#open.set(body.job, {
				job: body.job,
				agent: typeof body.agent === "string" ? body.agent : "",
				kind,
				turn: event.turn,
				startedMs: Number.isNaN(startedMs) ? this.#now() : startedMs,
				lastProgressMs: 0,
				lastProgress: "",
			});
		}
	}

	/**
	 * A tool call ended: its spawn feedback names the jobs it started. A job already open (a task's subagent that started
	 * before the call returned) keeps its start; omp's job id of it is remembered as another name.
	 */
	toolEnded(turn: number | null, event: unknown, args: unknown): void {
		const spawned = spawnedBy(event);
		if (spawned.length === 0 || !isRecord(event)) return;
		const call = textField(event.toolCallId, MAX_ID_CHARS);
		const tool = typeof event.toolName === "string" ? event.toolName : "";
		for (const { agent, job } of spawned) {
			const known = this.#find(job, agent);
			if (known !== undefined) {
				if (job !== known.job) this.#aliases.set(job, known.job);
				continue;
			}
			const kind: ChildKind = agent !== "" || tool === "task" ? "task" : tool === "eval" ? "eval" : "bash";
			if (kind === "task") {
				const name = agent !== "" ? agent : job;
				this.#begin({ turn, job: name, agent: name, kind, label: name, parentCall: call, description: "" });
			} else this.#begin({ turn, job, agent: "", kind, label: jobLabel(tool, args) || kind, parentCall: call, description: "" });
		}
	}

	/** A `subagent_lifecycle` payload: a detached subagent started (a job), or an open child's subagent ended. */
	lifecycle(turn: number | null, payload: unknown): void {
		if (!isRecord(payload) || typeof payload.id !== "string" || payload.id === "") return;
		const id = textField(payload.id, MAX_ID_CHARS);
		if (payload.status === "started") {
			if (payload.detached !== true || this.#find(id, id) !== undefined) return;
			this.#begin({
				turn,
				job: id,
				agent: id,
				kind: "task",
				label: id,
				parentCall: textField(payload.parentToolCallId, MAX_ID_CHARS),
				description: oneLine(payload.description),
			});
			return;
		}
		const child = this.#find(id, id);
		if (child === undefined) return;
		if (payload.status === "completed") this.#end(child, "completed", "", null, false);
		else if (payload.status === "failed") this.#end(child, "failed", TASK_FAILED, null, false);
		else if (payload.status === "aborted") this.#end(child, "cancelled", TASK_ABORTED, null, false);
	}

	/** A `subagent_progress` payload of an open child; written when it changed and the last one is old enough. */
	progress(payload: unknown): void {
		if (!isRecord(payload) || !isRecord(payload.progress) || typeof payload.progress.id !== "string") return;
		const { progress } = payload;
		const child = this.#find(textField(payload.progress.id, MAX_ID_CHARS), "");
		if (child === undefined || progress.status === "completed" || progress.status === "failed" || progress.status === "aborted") return;
		const now = this.#now();
		const window = numberField(progress.contextWindow);
		const body = {
			job: child.job,
			agent: child.agent,
			tools: numberField(progress.toolCount),
			requests: numberField(progress.requests),
			tokens: numberField(progress.tokens),
			cost: numberField(progress.cost),
			tool: textField(progress.currentTool, MAX_FIELD_CHARS),
			args: oneLine(progress.currentToolArgs),
			intent: oneLine(progress.currentToolIntent ?? progress.lastIntent),
			stage: oneLine(progress.stage),
			percent: typeof progress.completionPercent === "number" && Number.isFinite(progress.completionPercent) ? Math.round(progress.completionPercent) : null,
			context: window > 0 ? { tokens: numberField(progress.contextTokens), window } : null,
			ms: 0,
		};
		const shown = JSON.stringify({ ...body, ms: 0 });
		if (shown === child.lastProgress || now - child.lastProgressMs < PROGRESS_MIN_MS) return;
		child.lastProgress = shown;
		child.lastProgressMs = now;
		const reported = numberField(progress.durationMs);
		body.ms = Math.round(reported > 0 ? reported : now - child.startedMs);
		this.#sink("child_progress", JSON.stringify(body), child.turn);
	}

	/**
	 * A session event: the `async-result` message omp injects when background jobs' results are delivered ends each of its
	 * `details.jobs`. A job never seen start (an eval job, a bash job whose call the runner missed) is started and ended at once.
	 */
	delivered(turn: number | null, event: unknown): void {
		if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return;
		const { message } = event;
		if (message.role !== "custom" || message.customType !== "async-result" || !isRecord(message.details) || !Array.isArray(message.details.jobs)) return;
		for (const entry of message.details.jobs) {
			if (!isRecord(entry) || typeof entry.jobId !== "string") continue;
			const job = textField(entry.jobId, MAX_ID_CHARS);
			const agent = textField(entry.agentId, MAX_ID_CHARS);
			let child = this.#find(job, agent);
			if (child === undefined) {
				const kind = kindOf(entry.type);
				if (kind === null || this.#ended.has(job) || (agent !== "" && this.#ended.has(agent))) continue;
				child = this.#begin({ turn, job: kind === "task" && agent !== "" ? agent : job, agent: kind === "task" ? agent : "", kind, label: oneLine(entry.label) || kind, parentCall: "", description: "" });
			}
			const status = statusOf(entry.status);
			const reported = numberField(entry.durationMs);
			this.#end(child, status ?? "completed", status === "failed" ? "the job failed" : status === "cancelled" ? "the job was cancelled" : "", reported > 0 ? reported : null, status === null);
		}
	}

	/** omp reports it has no background work left: whatever is still open ended without a word. */
	settled(): void {
		for (const child of [...this.#open.values()]) this.#end(child, "completed", "", null, true);
	}

	/** The children cannot go on (the VM was paused, released or lost, omp exited): ends the open ones as cancelled with `reason`. */
	cancel(reason: string): void {
		for (const child of [...this.#open.values()]) this.#end(child, "cancelled", reason, null, true);
	}

	/** The open child called `job`, or whose agent is `agent` (a subagent is known by its id, a job also by omp's job id). */
	#find(job: string, agent: string): Child | undefined {
		const direct = this.#open.get(job) ?? this.#open.get(this.#aliases.get(job) ?? "");
		if (direct !== undefined || agent === "") return direct;
		return this.#open.get(agent) ?? this.#open.get(this.#aliases.get(agent) ?? "");
	}

	/** The agent id of the open child a nested subagent `agent` (`parent.name`) was spawned by; `""` for a top-level one. */
	#parentOf(agent: string): string {
		for (let dot = agent.lastIndexOf("."); dot > 0; dot = agent.lastIndexOf(".", dot - 1)) {
			const parent = this.#open.get(agent.slice(0, dot));
			if (parent !== undefined) return parent.agent;
		}
		return "";
	}

	#begin(start: ChildStart): Child {
		const child: Child = { job: start.job, agent: start.agent, kind: start.kind, turn: start.turn, startedMs: this.#now(), lastProgressMs: 0, lastProgress: "" };
		this.#open.set(child.job, child);
		this.#ended.delete(child.job);
		this.#ended.delete(child.agent);
		this.#sink(
			"child_start",
			JSON.stringify({
				job: child.job,
				agent: child.agent,
				kind: child.kind,
				label: start.label,
				parentCall: start.parentCall,
				parent: this.#parentOf(child.agent),
				description: start.description,
			}),
			child.turn,
		);
		return child;
	}

	/** Ends `child`; `ms` is its duration when omp reported one, else the time since it started. */
	#end(child: Child, status: ChildStatus, error: string, ms: number | null, inferred: boolean): void {
		this.#open.delete(child.job);
		for (const [alias, job] of this.#aliases) if (job === child.job) this.#aliases.delete(alias);
		for (const name of [child.job, child.agent]) {
			if (name === "") continue;
			this.#ended.delete(name);
			this.#ended.add(name);
		}
		while (this.#ended.size > MAX_ENDED) {
			const oldest = this.#ended.values().next();
			if (oldest.done) break;
			this.#ended.delete(oldest.value);
		}
		this.#sink(
			"child_end",
			JSON.stringify({
				job: child.job,
				agent: child.agent,
				kind: child.kind,
				status,
				ms: Math.max(0, Math.round(ms ?? this.#now() - child.startedMs)),
				error: clip(error, MAX_FIELD_CHARS),
				inferred,
			}),
			child.turn,
		);
	}
}
