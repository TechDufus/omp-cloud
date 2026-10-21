/**
 * The background jobs and subagents a cloud agent starts inside its own VM, as children of the cloud agent's job in omp.
 *
 * omp nests a native subagent's own background work by `ownerId`: a bash command the subagent runs in the background is a
 * `bash` job registered with the subagent's registry id as `ownerId` (label: the command, id: the manager's `bg_N`), and a
 * subagent it spawns is a `task` job whose id, label and `agentId` are the child's agent id. `getAsyncJobTree` collects every
 * job whose owner chain reaches the session's agent; the jobs panel (Tern), `/jobs` and the dock pill draw a job under the
 * agent that owns it, with its own row (type icon, label, elapsed clock) and view.
 *
 * Cloud children are registered exactly so, with the cloud agent's `agentId` (what the cloud job is registered under, see
 * `CloudJobs`) as `ownerId`: from the service's `child_start` event (capability `events.children`) until its `child_end`,
 * which settles the job with the status the VM's omp reported. A child that is itself the parent of others (`parent` names its
 * agent) owns them. A child outliving the turn that started it stays registered until its own end arrives; a service without
 * the capability sends no child events, and nothing is registered.
 *
 * Each child's view is what the service reports: its label and, for a subagent, the stage, tool counts, tokens, cost and
 * context its `child_progress` events carry; the job row's clock is omp's own. Nothing is invented: a bash child has no
 * progress beyond running or ended.
 *
 * A child cannot be cancelled from omp: the service has no remote cancel for it. omp refuses a cancel of a nested job on
 * every surface for a native subagent's child as well (the jobs panel offers Cancel only for the jobs of the session's own
 * agent, `/jobs kill` and `proc://<id>/kill` answer that they could not cancel it), and a child of a cloud agent is nested
 * the same way, so it gets the same refusal. A cancel that reaches the job anyway (a caller of the manager that does not
 * filter by owner) is declined: the user is told the child keeps running in the cloud, and the child is registered again.
 * Cancelling a child never stops the cloud turn. omp's own cleanup (a session switch, shutdown) ends the rows silently, and the
 * next event of the thread registers the still-running ones again.
 *
 * The result of a child is never delivered to a model: it is acknowledged at registration, as the delivery of a quiet cloud
 * job is, because the cloud agent (not a local session) is the one that gets it.
 */

import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, type AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { JobWidgetBlock, JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { getContextMeterThresholds } from "@oh-my-pi/pi-tui/chrome/context-thresholds";
import { clip, formatCost, formatDuration, formatTokens } from "./format";
import { eventPayload, isRecord } from "./guards";
import { cloudJobViews } from "./job-widgets";
import type { ThreadEvent } from "./types";

/** What of omp's job manager the children use; the real manager satisfies it. */
export type ChildJobManager = Pick<AsyncJobManager, "atCapacity" | "register" | "cancel" | "acknowledgeDeliveries" | "getJob" | "widgets">;

export interface ChildrenOptions {
	/** The host's manager now; undefined before `session_start` and in hosts without one. */
	manager: () => ChildJobManager | undefined;
	/** Whether `id` names an agent of omp's registry that is not a child's: a child's id and `agentId` never take it. */
	taken: (id: string) => boolean;
	/** Whether omp is cleaning up its session (a transition or the switch window): its cancels of the rows are not the user's. */
	lifecycle: () => boolean;
	/** Tells the user about something that happens off the command path. */
	warn: (message: string) => void;
	now: () => number;
}

/** Event kinds of the children's lifecycle. */
const CHILD_KINDS: Record<string, true> = { child_start: true, child_progress: true, child_end: true };

/** Whether `kind` is one of the children's events. */
export function isChildEvent(kind: string): boolean {
	return Object.hasOwn(CHILD_KINDS, kind);
}

/** The label omp gives a command's row: the command, cut to 120 characters. */
const LABEL_MAX = 120;
const TITLE_MAX = 60;
const STAGE_MAX = 200;
/** Children one thread keeps track of: the oldest ended ones are forgotten beyond it. */
const TRACKED_MAX = 256;

/** What a `child_progress` event reports of a subagent child. */
interface ChildProgress {
	tools: number;
	requests: number;
	tokens: number;
	cost: number;
	tool: string;
	args: string;
	intent: string;
	stage: string;
	context: { tokens: number; window: number } | undefined;
}

type ChildKind = "task" | "bash" | "eval";

/** One child of a cloud agent, from its start to its end. */
interface Child {
	/** The service's id of the job: what its later events name. */
	key: string;
	kind: ChildKind;
	/** The child's agent id (a subagent), else "". */
	agent: string;
	label: string;
	description: string;
	/** The registry id of the agent that owns it: the cloud agent, or the subagent child that started it. */
	owner: string;
	/** The id of its row in the manager while registered: also its `agentId` for a subagent. */
	local: string | undefined;
	/** Settles the row: set while it is registered. */
	outcome: PromiseWithResolvers<string> | undefined;
	/** `reportProgress` of the row's run context. */
	report: ((text: string) => Promise<void>) | undefined;
	progress: ChildProgress | undefined;
	/** The child ended in the cloud: its row is settling, or it never had one. */
	ended: boolean;
	/** Why this module is cancelling the row (the child ended as cancelled, or the thread is no longer followed): the cancel is not a user's. */
	ending: string | undefined;
	startedAt: number;
}

interface ThreadChildren {
	/** The newest child event handled: a replayed stream (the thread followed again) is not handled twice. */
	lastSeq: number;
	children: Map<string, Child>;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function kindOf(value: unknown): ChildKind {
	return value === "bash" || value === "eval" ? value : "task";
}

/** `base`, else `base-2`, `base-3`…: the first id neither the manager's jobs nor omp's agents hold, as the manager would resolve a taken one. */
export function freeId(manager: Pick<ChildJobManager, "getJob">, base: string, taken: (id: string) => boolean = () => false): string {
	let id = base;
	for (let n = 2; manager.getJob(id) || taken(id); n++) id = `${base}-${n}`;
	return id;
}

/** What a child's row and panel draw: its label, and what the VM's omp reported of it. */
function childView(child: Child, stage: string, now: number): JobWidgetView {
	const p = child.progress;
	const blocks: JobWidgetBlock[] = [];
	if (p?.context && p.context.window > 0) {
		const share = p.context.tokens / p.context.window;
		const { warn, bad } = getContextMeterThresholds(p.context.window);
		blocks.push({
			kind: "meter",
			label: "context",
			value: Math.min(1, share),
			text: `${formatTokens(p.context.tokens)} / ${formatTokens(p.context.window)}`,
			...(share >= bad ? { tone: "error" as const } : share >= warn ? { tone: "warning" as const } : {}),
		});
	}
	if (p) {
		const cost = formatCost(p.cost);
		const items = [
			...(p.tools > 0 ? [{ label: "tools", text: String(p.tools) }] : []),
			...(p.requests > 0 ? [{ label: "requests", text: String(p.requests) }] : []),
			...(p.tokens > 0 ? [{ label: "tokens", text: formatTokens(p.tokens) }] : []),
			...(cost === "" ? [] : [{ label: "cost", text: cost }]),
		];
		if (items.length > 0) blocks.push({ kind: "stat", items });
	}
	if (child.description !== "") blocks.push({ kind: "text", text: clip(child.description, STAGE_MAX) });
	return { title: clip(child.kind === "task" && child.agent !== "" ? child.agent : child.label, TITLE_MAX), stage: clip(stage, STAGE_MAX), blocks, state: "live", updatedAt: now };
}

/** The tool a subagent child is running, as `tool: detail`. */
function callText(p: ChildProgress): string {
	const detail = p.intent !== "" ? p.intent : p.args;
	return detail === "" ? p.tool : `${p.tool}: ${detail}`;
}

/** The children of the cloud agents a session follows. One instance per watcher. */
export class CloudChildren {
	readonly #opts: ChildrenOptions;
	readonly #threads = new Map<string, ThreadChildren>();

	constructor(opts: ChildrenOptions) {
		this.#opts = opts;
	}

	/** Whether `thread` has a child that has not ended: its event stream has more to say. */
	hasOpen(thread: string): boolean {
		for (const child of this.#threads.get(thread)?.children.values() ?? []) if (!child.ended) return true;
		return false;
	}

	/** One `child_start`, `child_progress` or `child_end` of `thread`, whose cloud agent is `owner`. */
	event(thread: string, owner: string, e: ThreadEvent): void {
		let t = this.#threads.get(thread);
		if (!t) {
			t = { lastSeq: 0, children: new Map() };
			this.#threads.set(thread, t);
		}
		if (e.seq <= t.lastSeq) return;
		t.lastSeq = e.seq;
		const p = eventPayload(e);
		const key = str(p?.job);
		if (!p || key === "") return;
		switch (e.kind) {
			case "child_start":
				return this.#start(t, owner, key, p, e);
			case "child_progress":
				return this.#progress(t, key, p);
			case "child_end":
				return this.#end(t, key, p);
		}
	}

	/** Registers the children of `thread` that omp's own cleanup ended while they ran, or that found the manager full or absent. */
	ensure(thread: string): void {
		for (const child of this.#threads.get(thread)?.children.values() ?? []) this.#register(child);
	}

	/** The session no longer follows the thread: its rows end without a notice, and the children are forgotten (following again replays them). */
	release(thread: string): void {
		const t = this.#threads.get(thread);
		if (!t) return;
		this.#threads.delete(thread);
		for (const child of t.children.values()) {
			child.ended = true;
			this.#cancel(child);
		}
	}

	releaseAll(): void {
		for (const thread of [...this.#threads.keys()]) this.release(thread);
	}

	/** The thread is over (it failed, was deleted, lost its VM) and its open children did not say how they ended: they fail with `message`. */
	close(thread: string, message: string): void {
		const t = this.#threads.get(thread);
		if (!t) return;
		this.#threads.delete(thread);
		for (const child of t.children.values()) if (!child.ended) this.#settle(child, "failed", message, 0);
	}

	#start(t: ThreadChildren, owner: string, key: string, p: Record<string, unknown>, e: ThreadEvent): void {
		const prior = t.children.get(key);
		if (prior && !prior.ended) return;
		const kind = kindOf(p.kind);
		const agent = str(p.agent);
		const label = str(p.label);
		const parent = str(p.parent);
		// A child that a subagent child started belongs to that subagent's row, as a native subagent's jobs belong to it.
		const parentRow = parent === "" ? undefined : [...t.children.values()].find(c => !c.ended && c.agent === parent && c.local !== undefined);
		const startedAt = Date.parse(e.at);
		const child: Child = {
			key,
			kind,
			agent,
			label: kind === "task" ? clip(agent === "" ? label : agent, LABEL_MAX) : label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 3)}...` : label,
			description: str(p.description),
			owner: parentRow?.local ?? owner,
			local: undefined,
			outcome: undefined,
			report: undefined,
			progress: undefined,
			ended: false,
			ending: undefined,
			startedAt: Number.isFinite(startedAt) ? startedAt : this.#opts.now(),
		};
		t.children.delete(key);
		t.children.set(key, child);
		if (t.children.size > TRACKED_MAX) {
			for (const [k, c] of t.children) {
				if (t.children.size <= TRACKED_MAX) break;
				if (c.ended) t.children.delete(k);
			}
		}
		this.#register(child);
	}

	#progress(t: ThreadChildren, key: string, p: Record<string, unknown>): void {
		const child = t.children.get(key);
		if (!child || child.ended) return;
		const context = isRecord(p.context) ? { tokens: num(p.context.tokens), window: num(p.context.window) } : undefined;
		child.progress = { tools: num(p.tools), requests: num(p.requests), tokens: num(p.tokens), cost: num(p.cost), tool: str(p.tool), args: str(p.args), intent: str(p.intent), stage: str(p.stage), context };
		const stage = this.#stage(child);
		this.#publish(child, stage);
		const call = child.progress.tool === "" ? "" : `» ${callText(child.progress)}`;
		void child.report?.(call === "" ? stage : call);
	}

	/** The child's row as the VM's omp last said it is: the call in flight, else its stage, else that it runs. */
	#stage(child: Child): string {
		const p = child.progress;
		if (p?.tool) return callText(p);
		return p?.stage || "running in the cloud";
	}

	#end(t: ThreadChildren, key: string, p: Record<string, unknown>): void {
		const child = t.children.get(key);
		if (!child || child.ended) return;
		const status = p.status === "failed" || p.status === "cancelled" ? p.status : "completed";
		this.#settle(child, status, str(p.error), num(p.ms));
	}

	/** The child ended: its row gets its last view and settles with `status`. A child with no row has nothing to settle. */
	#settle(child: Child, status: "completed" | "failed" | "cancelled", error: string, ms: number): void {
		child.ended = true;
		const outcome = child.outcome;
		if (child.local === undefined || !outcome) return;
		const took = formatDuration(ms);
		const text = status === "completed" ? `${child.label} completed${took === "" ? "" : ` in ${took}`}` : status === "cancelled" ? `${child.label} cancelled in the cloud${error === "" ? "" : `: ${error}`}` : (error === "" ? `${child.label} failed` : error);
		this.#publish(child, clip(text, STAGE_MAX));
		if (status === "completed") {
			outcome.resolve(text);
		} else if (status === "failed") {
			outcome.reject(new Error(text));
		} else {
			// The manager records a cancelled row only by cancelling it; the abort is this module's own.
			child.ending = text;
			if (this.#opts.manager()?.cancel(child.local) !== true) {
				child.outcome = undefined;
				outcome.reject(new Error(text));
			}
		}
	}

	/** Ends the row without a notice: the session no longer follows the thread. */
	#cancel(child: Child): void {
		child.ending = "cancelled";
		const outcome = child.outcome;
		if (child.local === undefined || !outcome) return;
		if (this.#opts.manager()?.cancel(child.local) === true) return;
		child.outcome = undefined;
		child.local = undefined;
		outcome.reject(new Error("cancelled"));
	}

	#register(child: Child): void {
		if (child.local !== undefined || child.ended) return;
		const manager = this.#opts.manager();
		if (!manager || manager.atCapacity) return;
		const outcome = Promise.withResolvers<string>();
		const id = child.kind === "task" && child.agent !== "" ? freeId(manager, child.agent, this.#opts.taken) : undefined;
		try {
			child.local = manager.register(
				child.kind,
				child.label,
				async ({ signal, reportProgress }) => {
					child.report = text => reportProgress(text, { output: text });
					signal.addEventListener("abort", () => this.#aborted(child, signal), { once: true });
					return outcome.promise;
				},
				{ ...(id === undefined ? {} : { id, agentId: id }), ownerId: child.owner },
			);
		} catch {
			// The manager filled up (or was disposed) since the capacity check: the next event of the thread tries again.
			return;
		}
		child.outcome = outcome;
		// A child's result belongs to the cloud agent: with no session to deliver to, omp would drop it with a warning, and a running job holds the session open.
		manager.acknowledgeDeliveries([child.local]);
		this.#publish(child, this.#stage(child));
	}

	/**
	 * The child's row was cancelled. By this module (the child ended, the thread is no longer followed), by omp's own cleanup
	 * (a transition, shutdown) or by a caller of the manager that does not filter by owner: only the last is a user's cancel, and
	 * the child cannot be stopped from omp. The user is told, and the child, still running in the cloud, gets a row again.
	 */
	#aborted(child: Child, signal: AbortSignal): void {
		const outcome = child.outcome;
		child.outcome = undefined;
		child.local = undefined;
		child.report = undefined;
		outcome?.reject(new Error(child.ending ?? "cancelled"));
		const cleanup = signal.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON || this.#opts.lifecycle();
		if (child.ending !== undefined || child.ended || cleanup) return;
		this.#opts.warn(`☁ ${child.label} runs in the cloud and cannot be cancelled from omp: it keeps running there`);
		this.#register(child);
	}

	/** Hands the child's view to omp's tiles and panel; the wrapper registry is put in place the first time omp has one. */
	#publish(child: Child, stage: string): void {
		const manager = this.#opts.manager();
		if (!manager || child.local === undefined) return;
		cloudJobViews(manager)?.set(child.local, childView(child, stage, this.#opts.now()));
	}
}
