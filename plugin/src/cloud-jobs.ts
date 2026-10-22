/**
 * The running turn of a followed cloud thread as one of omp's own background jobs: it shows in the dock pill, its hover
 * card, `/jobs` and `proc://`, and the model can block on it with `wait`.
 *
 * A job exists from the moment a turn is queued or running on a thread this session follows until the turn ends. It is
 * registered in the host's `AsyncJobManager` (a plugin reaches it only through static imports; the manager exists from
 * `session_start` on) as a `task` job registered the way omp registers a subagent (`label` and `agentId` are the thread's
 * agent id, see `CloudAgents`, owned by the main agent), so omp draws it as a task tile and nests what it owns under it. What omp
 * draws is the job's own view ({@link cloudJobLiveWidget}, put in front of omp's widget registry by {@link cloudJobViews}).
 * `reportProgress` carries the live tail of the turn, which the panel's Output box shows.
 *
 * Delivery: a thread the model started has its result delivered by omp itself. The run returns `{text, structured}`, so omp's
 * `async-result` names `agent://<id>` and its fields, and no turn card follows ({@link JobSettled.native}); a failed turn
 * fails the job with the same structured data. A thread the user started has its delivery acknowledged at registration (the
 * inbox and the cards are its channel, and a running job must never hold the local session open), and so does a turn an IRC
 * message woke (its reply goes back to the sender as a wake relay): never both channels for one turn. A model blocked in
 * `wait` on the job gets the result from `wait` itself. A job cancelled from omp's own surfaces (the jobs panel, `/jobs`,
 * `proc://<id>/kill`) stops the cloud turn like a native kill. omp's own cleanup (`/clear`, a branch, a switch) cancels
 * the job with the same reason, and must not stop it: a cancel within the session switch window is that cleanup.
 * No manager, a full one or a host without one: no job, nothing else changes.
 *
 * What the cloud agent itself starts in its VM (a background command, a subagent) is registered as jobs owned by this job's
 * `agentId`, so omp nests them under it as it nests a native subagent's own jobs (`cloud-children.ts`).
 */

import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, type AsyncJobDetails, AsyncJobError, type AsyncJobRunResult, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AgentProgress, StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import { turnPayload } from "./cloud-agents";
import { CloudChildren, freeId, isChildEvent } from "./cloud-children";
import { cloudJobId, cloudJobLiveWidget, cloudJobStage } from "./cloud-job";
import { shortName } from "./commands";
import { EventLog, runningText } from "./event-lines";
import { clip, metricsLine, spanBetween, threadHeading } from "./format";
import { cloudJobViews } from "./job-widgets";
import { TurnProgress } from "./turn-progress";
import type { ThreadActivity, ThreadDetail, ThreadEvent, ThreadMetrics, ThreadTurn } from "./types";
import { taskResultText } from "./task-result";

/** The part of omp's event bus the frames use. */
export interface SubagentBus {
	emit(channel: string, data: unknown): void;
}

/** What of omp's job manager the live jobs use; the real manager satisfies it. */
export type JobManager = Pick<AsyncJobManager, "atCapacity" | "register" | "cancel" | "acknowledgeDeliveries" | "isDeliverySuppressed" | "getJob" | "widgets">;

/** A turn that ended as a job: its id, whether a `wait` was blocked on it (which returned the result itself), and whether omp delivers its result. */
export interface JobSettled {
	id: string;
	waited: boolean;
	/** The job's own delivery carries the result (omp's `async-result` with the structured payload, or `wait`'s return): no card tells the model again. */
	native: boolean;
}

export interface CloudJobsOptions {
	/** The host's manager now; omp's global one by default, undefined before `session_start` and in hosts without one. */
	manager?: () => JobManager | undefined;
	/** Whether the turn's result is delivered to the model: the thread was started by the model's `cloud` tool and no message woke the turn; only then is the job's result delivered by omp. */
	wakes: (thread: string, turn: ThreadTurn) => boolean;
	/** The registry id of the agent `thread` is (`CloudAgents.agentId`): the job's label and `agentId`; the job's own id when absent. */
	agentId?: (thread: string) => string | undefined;
	/** Whether `id` names an agent of omp's registry: a child's job id and `agentId` never take one (the VM's agents are named from the same pool as omp's own). Absent: none is. */
	taken?: (id: string) => boolean;
	/** Tells the user about something that happens off the command path. */
	warn: (message: string) => void;
	/** The job of a thread was cancelled from omp (not by a session switch): the cloud turn must stop. */
	stop: (thread: string) => void;
	/** The job of a thread the model started was cancelled from omp: the model is told its turn was stopped. */
	aside: (thread: string, label: string) => void;
	/** Whether the session that owns the jobs is in the middle of a transition (`/clear`, a new session, a fork, a switch, a branch): omp then cancels its jobs itself, and a cancel is not the user's. Absent where the host's session has no such state. */
	transitioning?: () => boolean;
	/** Where omp's session events go (`pi.events`): the cloud agent's lifecycle and progress frames for the Subagents strip are published here, as the task tool publishes a native subagent's. Absent where the host has no bus. */
	events?: () => SubagentBus | undefined;
	now?: () => number;
}

/** What the widget author is told is worth watching. */
const WATCH_HINT = "context use against the window and cost, on the `·` lines; tool calls on the `»` lines";
/** The assignment shown on the tile is cut to this. */
const TASK_MAX = 500;
/** How long after a session switch or branch begins a cancel counts as omp's own cleanup. */
const TRANSITION_MS = 5000;
const REPLY_MAX = 1500;
/** Lines of the output `proc://<id>` shows while the job runs (omp reads it from the progress text the run reports). */
const OUTPUT_LINES = 40;
/** Lines of the turn's live tail, which the panel's Output box shows (it follows the tail of 16 lines). */
const TAIL_LINES = 16;
/** Notes (`·` lines: context, cost, the end of the turn) ahead of the activity in the output `proc://<id>` shows. */
const OUTPUT_NOTES = 3;
/** Longest stage line the final views carry, as the stage of a live one. */
const STAGE_MAX = 200;
/** The task text the strip row shows is cut to this (omp cuts the row to the terminal's width). */
const DESCRIPTION_MAX = 200;
/** The agent type of a cloud agent's rows and frames in omp's Subagents strip (the badge after its id). */
const SUBAGENT_ROLE = "cloud";
/** The stage of a job whose thread the session lost contact with. */
export const STALE_STAGE = "lost contact with the cloud; retrying";

/** One registered job: a turn of a thread. */
interface Live {
	id: string;
	thread: string;
	label: string;
	turn: number;
	task: string;
	startedAt: number;
	/** The last metrics line written to the output. */
	metrics: string;
	stage: string;
	/** `reportProgress` of the manager's run context. */
	report: (text: string, details?: AsyncJobDetails) => Promise<void>;
	outcome: PromiseWithResolvers<string | AsyncJobRunResult>;
	/** The session no longer follows the thread: the job ends without a notice. */
	released: boolean;
	/** Nobody is delivered this job's result (its card does not wake the model): its delivery was acknowledged at registration. */
	quiet: boolean;
	/** The thread became the model's after the job was registered as quiet: its result goes through the card only. */
	adopted: boolean;
	/** The session lost contact with the thread: its stage says so until contact returns. */
	stale: boolean;
	/** The newest lines of the job's output (activity lines and `·` notes), which `proc://<id>` shows. */
	recent: string[];
	/** The turn's events folded into lines (a call is one line with its outcome; `usage` has none): the Output box's tail is the newest of them. */
	log: EventLog;
	/** The view the job's tile and panel last drew from: its final one once the job ends. */
	view: JobWidgetView | undefined;
	/** The agent id the job stands for (`id` of its Subagents row and of its progress frames). */
	agent: string;
	/** What the turn has done so far: its calls, requests, tokens and context. */
	progress: TurnProgress;
	/** The job's end was announced to omp's Subagents strip. */
	ended: boolean;
}

/** The turn a job stands for: the running one, else the first queued. */
function activeTurn(d: ThreadDetail): ThreadTurn | undefined {
	return d.turns.find(t => t.state === "running") ?? d.turns.find(t => t.state === "queued");
}

/** The newest tool or assistant event of `turn`, as the service's own `activity` reads. */
function latestActivity(events: readonly ThreadEvent[], turn: number): ThreadActivity | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (!e || (e.kind !== "tool" && e.kind !== "assistant") || (e.turn !== null && e.turn !== turn) || e.text.trim() === "") continue;
		return { kind: e.kind, text: e.kind === "assistant" ? (e.text.trim().split("\n")[0] ?? "") : e.text.trim(), at: e.at };
	}
	return undefined;
}

/** What the Subagents strip shows after the agent's id, as for a native subagent: the task it was given (the turn's prompt), the thread's name when the turn has no text. */
function taskDescription(live: Live): string {
	return live.task === "" ? live.label : clip(live.task, DESCRIPTION_MAX);
}

/** What a settled turn leaves as its job's stage: its title, its error, or that it was stopped. */
function endStage(turn: ThreadTurn, detail: ThreadDetail): string {
	if (turn.state === "cancelled") return "stopped";
	if (turn.state === "failed") return clip(turn.error || detail.error || "failed", STAGE_MAX);
	return clip(turn.title || detail.title || "done", STAGE_MAX);
}

/** Registers, feeds and settles the jobs of the threads a session follows. One instance per watcher. */
export class CloudJobs {
	readonly #opts: CloudJobsOptions;
	readonly #live = new Map<string, Live>();
	readonly #now: () => number;
	/** What the threads' own background jobs and subagents are in omp's job manager: children of the cloud agent's job. */
	readonly #children: CloudChildren;
	#quietUntil = 0;
	/** Thread to the turn whose job the user cancelled: it is not registered again. */
	readonly #declined = new Map<string, number>();

	constructor(opts: CloudJobsOptions) {
		this.#opts = opts;
		this.#now = opts.now ?? Date.now;
		this.#children = new CloudChildren({
			manager: () => this.#manager(),
			taken: opts.taken ?? (() => false),
			lifecycle: () => this.#now() < this.#quietUntil || opts.transitioning?.() === true,
			warn: opts.warn,
			now: this.#now,
		});
	}

	/** The host's manager. `AsyncJobManager.instance()` is undefined while an extension loads and defined from `session_start` on. */
	#manager(): JobManager | undefined {
		return this.#opts.manager ? this.#opts.manager() : AsyncJobManager.instance();
	}

	/** The id of `thread`'s running job, when it has one. */
	jobId(thread: string): string | undefined {
		return this.#live.get(thread)?.id;
	}

	has(thread: string): boolean {
		return this.#live.has(thread);
	}

	/** The host is switching sessions or branching: omp cancels the session's jobs on the way, and the next event registers them again. */
	beginTransition(): void {
		this.#quietUntil = this.#now() + TRANSITION_MS;
	}

	/** The switch or branch is over: omp's cancels are done, a later cancel is the user's. */
	endTransition(): void {
		this.#quietUntil = 0;
	}

	/** Brings the thread's job in line with its detail: registers one while a turn is active and none is, and reports its progress. */
	sync(detail: ThreadDetail, events: readonly ThreadEvent[]): void {
		this.#children.ensure(detail.id);
		const turn = activeTurn(detail);
		if (!turn) return;
		let live = this.#live.get(detail.id);
		if (live && live.turn !== turn.id) {
			this.#end(live, "completed");
			live.outcome.resolve(`Turn ${live.turn} ended.`);
			this.#acknowledge(live);
			live = undefined;
		}
		if (this.#declined.get(detail.id) === turn.id) return;
		const fresh = live === undefined;
		live ??= this.#register(detail, turn);
		if (!live) return;
		// A job registered mid-turn (omp restarted, a session switch) starts with what the turn already did, not an empty Output box.
		if (fresh) {
			const mine = events.filter(e => e.turn === null || e.turn === turn.id);
			for (const e of mine) {
				live.log.push(e);
				live.progress.note(e);
			}
		}
		const metrics = metricsLine(detail.metrics);
		if (metrics !== "" && metrics !== live.metrics) {
			live.metrics = metrics;
			this.#line(live, `· ${metrics}\n`);
		}
		this.#report(live, detail, events);
	}

	/**
	 * One event of the thread's stream: its line goes into the job's tap and its stage is reported. A child's event
	 * (`child_start`, `child_progress`, `child_end`) is handled by {@link CloudChildren}, which owns the child's job.
	 */
	event(detail: ThreadDetail, events: readonly ThreadEvent[], e: ThreadEvent): void {
		const live = this.#live.get(detail.id);
		// Children omp's own cleanup ended while they ran are registered again by the thread's next event.
		this.#children.ensure(detail.id);
		if (isChildEvent(e.kind)) {
			this.#children.event(detail.id, this.#opts.agentId?.(detail.id) ?? cloudJobId(detail), e);
			if (!live) this.sync(detail, events);
			return;
		}
		// A job omp cancelled on a session switch is registered again by the thread's next event.
		if (!live) return this.sync(detail, events);
		if (e.turn !== null && e.turn !== live.turn) return;
		live.log.push(e);
		live.progress.note(e);
		this.#report(live, detail, events);
	}

	/**
	 * A turn of the thread ended: the job settles with its result (done) or its error (failed, stopped), both carrying the
	 * structured payload `agent://<id>` serves. Undefined when the turn had no job. A turn the model started is delivered by
	 * omp's own `async-result` ({@link JobSettled.native}); a stopped one is acknowledged, as the model stopped it.
	 */
	settle(detail: ThreadDetail, turn: ThreadTurn): JobSettled | undefined {
		const live = this.#live.get(detail.id);
		if (!live || live.turn !== turn.id) return undefined;
		const head = `Turn ${turn.id} ${turn.state === "cancelled" ? "stopped" : turn.state}${turn.title ? `: ${turn.title}` : ""}`;
		const waited = !live.quiet && this.#manager()?.isDeliverySuppressed(live.id) === true;
		const native = !live.quiet && turn.state !== "cancelled";
		if (!waited && !native) this.#acknowledge(live);
		this.#line(live, `· ${head}\n`);
		this.#end(live, turn.state === "done" ? "completed" : turn.state === "failed" ? "failed" : "aborted");
		this.#publish(live, cloudJobLiveWidget({ ...detail, activity: null, turns: detail.turns.map(t => (t.id === turn.id ? turn : t)) }, this.#now(), endStage(turn, detail), live.id));
		if (live.adopted) {
			// A wait blocked on this job cannot be told apart from the acknowledgement made while the thread was the user's: the card is the one that carries the result.
			const pointer = `${head}. The full result arrives as a [cloud] message from this thread, not through this job.`;
			if (turn.state === "done") live.outcome.resolve(pointer);
			else live.outcome.reject(new Error(pointer));
		} else {
			const structured: StructuredSubagentOutput = { source: "none", mode: "permissive", status: "valid", data: turnPayload(detail, turn, REPLY_MAX) };
			const text = taskResultText({
				id: live.agent,
				status: turn.state === "done" ? "completed" : turn.state === "failed" ? "failed" : "cancelled",
				duration: spanBetween(turn.startedAt, turn.completedAt),
				reply: turn.reply,
				error: turn.state === "done" ? "" : turn.error,
				thread: detail.id,
				turn: turn.id,
				result: detail.result,
				pr: detail.pr?.url ?? "",
			});
			if (turn.state === "done") live.outcome.resolve({ text, structured });
			else live.outcome.reject(new AsyncJobError(text, structured));
		}
		return { id: live.id, waited, native };
	}

	/**
	 * The thread, which the user started, is now the model's: its cards wake the model. A job registered while the thread was the
	 * user's had its own delivery acknowledged and cannot get it back, so its settled result is only a pointer to the card: the
	 * model gets the result once, from the card, whether or not a `wait` is blocked on the job.
	 */
	adopt(thread: string): void {
		const live = this.#live.get(thread);
		if (live?.quiet) live.adopted = true;
	}

	/** Whether children of the thread still run in its VM: its stream stays followed for their ends after the turn is over (a dead or paused VM runs none). */
	keeps(detail: ThreadDetail): boolean {
		return this.#children.hasOpen(detail.id) && detail.phase !== "failed" && detail.vm?.state === "running";
	}

	/** The thread is no longer active and no turn ended it (it failed outside a turn): a job still open fails with the thread's error, and so do the children that did not end. */
	finish(detail: ThreadDetail): void {
		if (!this.keeps(detail)) this.#children.close(detail.id, detail.error || "the thread ended");
		const live = this.#live.get(detail.id);
		if (!live) return;
		this.#acknowledge(live);
		this.#end(live, "failed");
		this.#close(live, clip(detail.error || "the thread ended", STAGE_MAX));
		live.outcome.reject(new Error(detail.error || "the thread ended"));
	}

	/** The thread is gone from the service (deleted): its job fails with `message`. Undefined when the thread had no job. */
	fail(thread: string, message: string): JobSettled | undefined {
		this.#children.close(thread, message);
		const live = this.#live.get(thread);
		if (!live) return undefined;
		const waited = !live.quiet && this.#manager()?.isDeliverySuppressed(live.id) === true;
		if (!waited) this.#acknowledge(live);
		this.#line(live, `· ${message}\n`);
		this.#end(live, "failed");
		this.#close(live, clip(message, STAGE_MAX));
		live.outcome.reject(new Error(message));
		return { id: live.id, waited, native: false };
	}

	/** The session lost contact with the thread (`stale`) or got it back: the job's stage says which. Without a job, nothing. */
	markStale(detail: ThreadDetail, events: readonly ThreadEvent[], stale: boolean): void {
		const live = this.#live.get(detail.id);
		if (!live || live.stale === stale) return;
		live.stale = stale;
		this.#report(live, detail, events);
	}

	/** Ends the job of `thread` without stopping its cloud turn: the session no longer follows it. */
	release(thread: string): void {
		this.#children.release(thread);
		const live = this.#live.get(thread);
		if (!live) return;
		live.released = true;
		this.#cancel(live);
	}

	releaseAll(): void {
		this.#children.releaseAll();
		for (const thread of [...this.#live.keys()]) this.release(thread);
	}

	#register(detail: ThreadDetail, turn: ThreadTurn): Live | undefined {
		const manager = this.#manager();
		if (!manager || manager.atCapacity) return undefined;
		const live: Live = {
			id: "",
			thread: detail.id,
			label: threadHeading(detail, 120),
			turn: turn.id,
			task: clip(turn.text, TASK_MAX),
			startedAt: this.#now(),
			metrics: "",
			stage: "",
			report: async () => {},
			outcome: Promise.withResolvers<string | AsyncJobRunResult>(),
			released: false,
			quiet: false,
			adopted: false,
			stale: false,
			recent: [],
			log: new EventLog(TAIL_LINES * 4),
			view: undefined,
			agent: "",
			progress: new TurnProgress(this.#now),
			ended: false,
		};
		// The label and the job's `agentId` (what links the jobs it owns to it, and `agent://<id>` to its output) are the thread's agent id, held for the life of the thread; the job's own id is the first the manager does not hold (the manager itself suffixes a reused id with `-<n>` while an earlier row with that id is retained).
		// omp 18.12.3 has no extension API for jobs, so this registers through the exported manager and so depends on `register`'s options, the manager's `widgets` slot and the `AgentProgress` shape. The job's clock starts here, at registration, not at the cloud turn's start. omp writes the widget of its own jobs with a cheap `widget`-role model from the job's text; a cloud job's view comes from the plugin ({@link cloudJobViews}) instead.
		const label = this.#opts.agentId?.(detail.id) ?? cloudJobId(detail);
		live.agent = label;
		const id = freeId(manager, label);
		try {
			live.id = manager.register(
				"task",
				label,
				async ({ signal, reportProgress }) => {
					live.report = reportProgress;
					signal.addEventListener("abort", () => this.#aborted(live, signal), { once: true });
					return live.outcome.promise;
				},
				{ id, agentId: label, ownerId: MAIN_AGENT_ID },
			);
		} catch {
			// The manager filled up (or was disposed) since the capacity check: this turn stays a widget row.
			return undefined;
		}
		// A card that does not wake the model leaves the job no one to deliver to: an unsuppressed running job would hold every
		// local turn open as "awaiting async work". `wait` still returns the result of a suppressed job.
		if (!this.#opts.wakes(detail.id, turn)) {
			live.quiet = true;
			manager.acknowledgeDeliveries([live.id]);
		}
		this.#live.set(detail.id, live);
		this.#lifecycle(live, "started");
		return live;
	}

	/**
	 * The job was cancelled: `/jobs`, `proc://<id>/kill`, or omp's own cleanup (`/clear`, a new session, a fork, a branch, a session
	 * switch, shutdown). omp gives them all the same abort reason, so they are told apart by state: the owning session reports
	 * `isSessionTransitioning` while it cancels its jobs for any of those (`resetSessionContext`, `newSession`, `fork`,
	 * `switchSession`, branching; checked in omp's source), which `transitioning` reads; the manager's shutdown reason covers
	 * shutdown; and the switch window ({@link beginTransition}, from the session events) covers an omp whose session lacks the getter.
	 * The user's cancel stops the cloud turn like a native kill and tells the model; the turn stays declined (the job is not
	 * registered again). Omp's cleanup leaves the turn running: the next event registers the job again.
	 */
	#aborted(live: Live, signal: AbortSignal): void {
		const mine = this.#live.get(live.thread) === live;
		this.#end(live);
		const lifecycle = signal.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON || this.#now() < this.#quietUntil || this.#opts.transitioning?.() === true;
		if (mine && !live.released && !lifecycle) {
			this.#declined.set(live.thread, live.turn);
			this.#opts.stop(live.thread);
			this.#opts.warn(`☁ ${live.label} was cancelled in omp: its cloud turn is being stopped (${shortName(live.thread)})`);
			this.#opts.aside(live.thread, live.label);
		}
		live.outcome.reject(new Error("cancelled"));
	}

	/** Cancels the job through the manager, which aborts its run; the job is ended here too when the manager no longer knows it. */
	#cancel(live: Live): void {
		const cancelled = this.#manager()?.cancel(live.id) === true;
		if (cancelled) return;
		this.#end(live);
		live.outcome.reject(new Error("cancelled"));
	}

	/** The job leaves the live set, and its row leaves the Subagents strip (once) with the outcome of its turn. */
	#end(live: Live, status: "completed" | "failed" | "aborted" = "aborted"): void {
		if (this.#live.get(live.thread) === live) this.#live.delete(live.thread);
		if (live.ended) return;
		live.ended = true;
		this.#lifecycle(live, status);
	}

	/** The job's result is delivered some other way (the turn card, the wake relay, or `wait` itself): omp's `async-result` would repeat it. */
	#acknowledge(live: Live): void {
		this.#manager()?.acknowledgeDeliveries([live.id]);
	}

	/** Keeps the newest lines for `proc://<id>`, which reads a running job's `output` detail. */
	#line(live: Live, text: string): void {
		const lines = text.split("\n").filter(l => l !== "");
		if (lines.length === 0) return;
		live.recent.push(...lines);
		if (live.recent.length > OUTPUT_LINES) live.recent.splice(0, live.recent.length - OUTPUT_LINES);
	}

	#report(live: Live, detail: ThreadDetail, events: readonly ThreadEvent[]): void {
		const activity = latestActivity(events, live.turn) ?? detail.activity;
		// The thread's metrics sum finished turns: the running turn's own requests, tools, tokens and context are added to them.
		const metrics = live.progress.metrics(detail.metrics);
		const thread = { ...detail, activity, metrics };
		const calling = live.progress.running();
		// A call in flight is the stage as omp draws a running tool; a finished one stays `» tool: detail`.
		const inFlight = calling && (detail.phase === "working" || detail.phase === "starting") ? runningText(clip(calling.label, STAGE_MAX), calling.startMs, this.#now()) : undefined;
		const stage = live.stale ? STALE_STAGE : (inFlight ?? cloudJobStage(thread));
		live.stage = stage;
		this.#publish(live, cloudJobLiveWidget(thread, this.#now(), stage, live.id));
		const progress = this.#progress(live, detail, stage, metrics);
		this.#emit(TASK_SUBAGENT_PROGRESS_CHANNEL, { index: 0, agent: SUBAGENT_ROLE, agentSource: "user", task: live.task, assignment: live.task, progress, detached: true });
		const output = [...live.recent.slice(-OUTPUT_NOTES), ...this.#activity(live)].slice(-OUTPUT_LINES);
		void live.report(this.#tail(live, detail, stage), { progress: [progress], output: output.join("\n") });
	}

	/**
	 * The live tail of the turn, which the panel's Output box shows in place of the last one: the newest tool calls (`» bash: bun
	 * test`), the agent's own lines and tool errors, then the question it waits on, then the lost-contact note; the stage while
	 * nothing happened yet. Each line is already cut to one line, and at most {@link TAIL_LINES} are kept.
	 */
	#tail(live: Live, detail: ThreadDetail, stage: string): string {
		const after = [...(detail.question ? [`? ${clip(detail.question.text, STAGE_MAX)}`] : []), ...(live.stale ? [STALE_STAGE] : [])];
		const lines = [...this.#activity(live).slice(-(TAIL_LINES - after.length)), ...after];
		return lines.length === 0 ? stage : lines.join("\n");
	}

	/** The turn's activity as lines: a finished call as `» tool: detail · ✓ · 1s`, one in flight as omp draws a running tool (`└ tool: detail · 40s`), the agent's own lines and tool errors as they are. */
	#activity(live: Live): string[] {
		const now = this.#now();
		return live.log.lines.flatMap(l => {
			if (l.kind === "tool") return [l.running === undefined ? `» ${l.text}` : runningText(l.text, l.running, now)];
			return l.kind === "tool_error" ? [`! ${l.text}`] : l.kind === "assistant" ? [l.text] : [];
		});
	}

	/** Hands the job's view to omp's tiles and panel; the wrapper registry is put in place the first time omp has one. */
	#publish(live: Live, view: JobWidgetView): void {
		live.view = view;
		const manager = this.#manager();
		if (manager) cloudJobViews(manager)?.set(live.id, view);
	}

	/** The job ended outside a turn: its last view stays, with `stage` as what happened. */
	#close(live: Live, stage: string): void {
		if (live.view) this.#publish(live, { ...live.view, stage, updatedAt: this.#now() });
	}

	/** The job's progress as omp's task executor shapes a native subagent's: the call in flight and the last five, the counts, the context and the cost. */
	#progress(live: Live, detail: ThreadDetail, stage: string, metrics: ThreadMetrics | null): AgentProgress {
		const m = metrics;
		return {
			index: 0,
			id: live.agent,
			agent: SUBAGENT_ROLE,
			agentSource: "user",
			status: "running",
			task: live.task,
			assignment: live.task,
			description: taskDescription(live),
			...live.progress.calls(),
			recentOutput: [],
			toolCount: m?.tools ?? 0,
			requests: m?.requests ?? 0,
			tokens: m ? m.usage.inputTokens + m.usage.outputTokens + m.usage.cacheWriteTokens : 0,
			...(m?.context ? { contextTokens: m.context.tokens, ...(m.context.window > 0 ? { contextWindow: m.context.window } : {}) } : {}),
			cost: m?.usage.cost ?? 0,
			durationMs: Math.max(0, this.#now() - live.startedAt),
			...(detail.model === "" ? {} : { resolvedModel: detail.model }),
			stage,
			watch: WATCH_HINT,
		};
	}

	/**
	 * One frame on omp's session bus (`ExtensionAPI.events`), which the Subagents strip and the agent hub listen to; a host without the bus, or a listener that throws, costs the job nothing.
	 * omp's "Subagents · N running" strip is fed only by `task:subagent:lifecycle` and `task:subagent:progress` frames on this bus (the one the interactive mode's observer subscribes to); the footer count reads the agent registry instead (`CloudAgents`).
	 */
	#emit(channel: string, payload: unknown): void {
		try {
			this.#opts.events?.()?.emit(channel, payload);
		} catch {
			// a surface that cannot take the frame must not stop the job
		}
	}

	/** Tells the Subagents strip the agent started (or, with `status`, ended): it lists active subagents only. */
	#lifecycle(live: Live, status: "started" | "completed" | "failed" | "aborted"): void {
		this.#emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: live.agent, agent: SUBAGENT_ROLE, agentSource: "user", status, index: 0, description: taskDescription(live), detached: true });
	}
}
