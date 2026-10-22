/**
 * Cloud threads as omp agents.
 *
 * Each thread this session follows is one ref of omp's agent registry (`kind: "sub"`, the id omp shows for its job, parented
 * by the local agent that started or last wrote to it), whose `session` is a {@link CloudSession}: the members omp's paths
 * read of an agent's session (the IRC bus, `wait`, `agent://`, `history://`, `proc://`, job control, the Agent Hub, the
 * IRC roster), answered from the thread. omp's own paths then do the rest:
 *
 * - `write agent://<id>` reaches {@link CloudSession.deliverIrcMessage}, which posts the message to the service's IRC endpoint
 *   and answers omp's receipt (`injected`, `woken`, `revived`); an error is the bus's `failed` receipt.
 * - A message the cloud agent sends out (an `irc` event of the thread) is handed to its local recipient's session, which
 *   draws omp's own `irc:incoming` message, wakes the recipient or ends its interruptible `wait`.
 * - When a turn that a message woke ends, its final reply goes back to the sender as an IRC message with `replyTo` and
 *   `wakeRelay`, as omp's task executor does for a woken subagent. That message is the turn's one delivery: no card.
 * - `agent://<id>` and `agent://<id>/result/branch` read `<id>.md` and `<id>.json` from a directory registered with omp
 *   ({@link CloudAgents.dir}), rewritten as each turn ends; `history://<id>` reads {@link CloudSession.messages}, which is the
 *   conversation of the last exported turn, or what the events say while a turn runs.
 * - A user's cancel of the cloud job reaches {@link CloudSession.abort}, which stops the cloud turn like a native kill.
 *
 * Everything omp-internal is reached through modules a compiled omp serves to extensions (`registry/*`, `internal-urls/*`,
 * `session/*`), and every member is feature-detected: an omp that lacks one gets today's behaviour, never a throw.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as registryHelpers from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as internalRouter from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CloudClient } from "./api";
import { AGENT_IDS, threadBranch } from "./cards";
import { cloudJobId } from "./cloud-job";
import { CloudError, cloudErrorText } from "./errors";
import { IRC_OUT_KIND } from "./events";
import { clip, spanBetween } from "./format";
import { isRecord } from "./guards";
import { readArchiveJournal } from "./session-sync";
import { taskResultText } from "./task-result";
import type { IrcReceiptKind, ThreadDetail, ThreadEvent, ThreadMetrics, ThreadResult, ThreadTurn } from "./types";
import { parseIrcPayload } from "./wire";

/** The service capability that serves `POST /threads/{id}/irc`; a service without it gets the message as a queued turn. */
export const IRC_CAPABILITY = "threads.irc";

/**
 * What the runner's cut marker (`boundedIrcBody`, `src/runner/irc.ts`) says in place of the sending agent's id, which only the
 * plugin knows: the plugin puts the real `history://<agent id>` there, so the receiver can follow it. `plugin/test/irc-marker.test.ts`
 * reads the runner's source and fails when this literal drifts.
 */
export const IRC_CUT_PLACEHOLDER = "history://<the sending agent's id>";

/** Lines kept of one running turn's events for `history://`. */
const LOG_LINES = 200;
/** How long a message that queued a turn counts the agent as running before the thread's own detail says so. */
const AWAIT_MS = 30_000;
/** Delivered message ids remembered. */
const SEEN_MAX = 2000;
/** The sender the service accepts: letters, digits, `.`, `_`, `-`, 1 to 64. */
const SENDER_RE = /[^A-Za-z0-9._-]/g;

/** What of the cloud client the agents use; the real client satisfies it. */
export type AgentsClient = Pick<CloudClient, "irc" | "sendMessage" | "stop" | "requireCapability" | "downloadConversation">;

/** What of omp's agent registry the agents use; `AgentRegistry` satisfies it. */
export interface AgentRegistryLike {
	register(input: { id: string; displayName: string; kind: string; parentId?: string; session: object | null; sessionFile?: string | null; status?: string }): unknown;
	get(id: string): { id: string; parentId?: string; status: string; session: unknown } | undefined;
	unregister(id: string, expected?: unknown): boolean;
	setStatus(id: string, status: "running" | "idle"): boolean;
	setActivity?(id: string, activity: string): void;
}

export interface CloudAgentsOptions {
	/** A client of the current connection; rejects when the plugin has none (not configured). */
	client: () => Promise<AgentsClient>;
	/** The thread has work the session must follow (a message woke it): its events and turns are watched from here on. */
	follow: (thread: string) => void;
	/** Tells the user about something that happens off the command path. */
	warn: (message: string) => void;
	/** The session's cwd: what `sessionManager.getCwd()` of every ref answers. */
	cwd: () => string;
	/** The session's entries: which messages of cloud agents it received already. */
	entries: () => readonly unknown[];
	/** A turn's relay to its sender failed: the turn is delivered some other way. */
	relayFailed: (detail: ThreadDetail, turn: ThreadTurn, reason: string) => void;
	/** The host's registry; omp's global one by default. */
	registry?: () => AgentRegistryLike | undefined;
	/** The artifacts directory; a fresh temporary one by default, removed by {@link CloudAgents.dispose}. */
	dir?: string;
	/** Fetch a thread's conversation when it becomes known with finished turns (default true). */
	hydrate?: boolean;
	now?: () => number;
}

/** The turn's result as `<id>.json` and the job's structured data hold it. */
export interface TurnPayload {
	thread: string;
	name: string;
	turn: number;
	state: ThreadTurn["state"];
	title: string;
	reply: string;
	error: string;
	result: ThreadResult | null;
	metrics: ThreadMetrics | null;
	diffstat: { filesChanged: number; insertions: number; deletions: number } | null;
	branch: string;
	model: string;
}

/** The structured result of a finished turn; `replyMax` cuts the reply for the copies that are persisted in a session. */
export function turnPayload(detail: ThreadDetail, turn: ThreadTurn, replyMax = Number.POSITIVE_INFINITY): TurnPayload {
	return {
		thread: detail.id,
		name: detail.name,
		turn: turn.id,
		state: turn.state,
		title: turn.title,
		reply: turn.reply.length > replyMax ? `${turn.reply.slice(0, replyMax)}…` : turn.reply,
		error: turn.error,
		result: detail.result,
		metrics: detail.metrics,
		diffstat: detail.result ? { filesChanged: detail.result.filesChanged, insertions: detail.result.insertions, deletions: detail.result.deletions } : turn.filesChanged + turn.insertions + turn.deletions > 0 ? { filesChanged: turn.filesChanged, insertions: turn.insertions, deletions: turn.deletions } : null,
		branch: threadBranch(detail.id),
		model: detail.model,
	};
}

/** Ids of the cloud agents' messages the session's `irc:incoming` entries record. */
export function ircIdsFromEntries(entries: readonly unknown[]): Set<string> {
	const out = new Set<string>();
	for (const e of entries) {
		if (!isRecord(e) || e.type !== "custom_message" || e.customType !== "irc:incoming" || !isRecord(e.details)) continue;
		if (typeof e.details.id === "string") out.add(e.details.id);
	}
	return out;
}

/** Whether the session's last `mode_change` entry put it in plan mode (omp's interactive mode records `plan`, `plan_paused` and `none`). */
export function planModeFromEntries(entries: readonly unknown[]): boolean {
	const last = entries.findLast(e => isRecord(e) && e.type === "mode_change");
	return isRecord(last) && last.mode === "plan";
}

const isFinished = (t: ThreadTurn): boolean => t.state === "done" || t.state === "failed" || t.state === "cancelled";
const isLive = (t: ThreadTurn): boolean => t.state === "queued" || t.state === "running";

/** `from` as the service accepts a sender. */
function sender(from: string): string {
	const clean = from.replace(SENDER_RE, "_").slice(0, 64);
	return clean === "" ? MAIN_AGENT_ID : clean;
}

/** The IRC message a finished turn's reply becomes: a `<task-result>`, as a woken subagent's reply reaches its parent. */
function relayBody(id: string, detail: ThreadDetail, turn: ThreadTurn): string {
	return taskResultText({
		id,
		status: turn.state === "done" ? "completed" : turn.state === "failed" ? "failed" : "cancelled",
		duration: spanBetween(turn.startedAt, turn.completedAt),
		reply: turn.reply,
		error: turn.state === "done" ? "" : turn.error,
		thread: detail.id,
		turn: turn.id,
		result: detail.result,
		pr: detail.pr?.url ?? "",
	});
}

/**
 * The members of an agent's session that omp's paths read of a ref, with the code that reads them. The shim answers every one; the smoke test calls each.
 * A ref of `kind: "sub"` with a `session` object is what `agent://`, `history://`, `proc://`, `wait`, omp's IRC bus, job control (`abort`, `dispose`) and the agent hub read.
 */
export interface ShimMember {
	/** Dotted path on the session. */
	path: string;
	/** `get`: a property; `call`: a function called with `args()`. */
	kind: "get" | "call";
	consumer: string;
	args?: () => unknown[];
}

/** The message the smoke test delivers. */
const PROBE: IrcMessage = { id: "probe", from: "Main", to: "Probe", body: "ping", ts: 0 };

export const SHIM_MEMBERS: readonly ShimMember[] = [
	{ path: "isStreaming", kind: "get", consumer: "registry/agent-registry.ts isRunning, markResultAccepted; tools/wait.ts pendingReplies; async/job-control.ts" },
	{ path: "runStartedAt", kind: "get", consumer: "tools/wait.ts pendingReplies" },
	{ path: "subscribe", kind: "call", consumer: "tools/wait.ts reply wait; modes/controllers/session-focus-controller.ts", args: () => [() => {}] },
	{ path: "subscribeRunState", kind: "call", consumer: "registry/agent-registry.ts syncSessionStatus", args: () => [() => {}] },
	{ path: "deliverIrcMessage", kind: "call", consumer: "irc/bus.ts #deliver", args: () => [PROBE] },
	{ path: "waitForIrcReplies", kind: "call", consumer: "tools/wait.ts reply wait" },
	{ path: "drainPendingIrcInboxMessages", kind: "call", consumer: "irc/messaging.ts drainPendingInbox", args: () => ["Main", { limit: 1 }] },
	{ path: "emitIrcRelayObservation", kind: "call", consumer: "irc/bus.ts #relayToMainUi; task/workpool.ts", args: () => [{}] },
	{ path: "messages", kind: "get", consumer: "internal-urls/agent-protocol.ts #resolveProgress; internal-urls/history-protocol.ts resolve" },
	{ path: "abort", kind: "call", consumer: "async/job-control.ts cancelAgentRegistration; collab/host.ts; modes/rpc/rpc-mode.ts", args: () => [{ reason: "probe" }] },
	{ path: "dispose", kind: "call", consumer: "async/job-control.ts; registry/agent-lifecycle.ts release, park" },
	{ path: "sessionManager.getArtifactsDir", kind: "call", consumer: "internal-urls/registry-helpers.ts artifactsDirsFromRegistry" },
	{ path: "sessionManager.getCwd", kind: "call", consumer: "internal-urls/forge-diff.ts; internal-urls/issue-pr-protocol.ts; internal-urls/memory-protocol.ts" },
	{ path: "sessionManager.getSessionId", kind: "call", consumer: "internal-urls/memory-protocol.ts" },
	{ path: "sessionManager.getSessionFile", kind: "call", consumer: "modes/** session pickers" },
	{ path: "sessionManager.getEntries", kind: "call", consumer: "modes/** transcript readers" },
	{ path: "sessionManager.getUsageStatistics", kind: "call", consumer: "registry/agent-lifecycle.ts park; pi-tui agent-hub-projection.ts" },
	{ path: "sessionFile", kind: "get", consumer: "internal-urls/memory-protocol.ts; agent-session.ts captureLiveDumpState" },
	{ path: "agent.state.messages", kind: "get", consumer: "pi-tui agent-hub-projection.ts; session-focus-controller.ts" },
	{ path: "agent.state.isStreaming", kind: "get", consumer: "session-focus-controller.ts" },
	{ path: "agent.state.streamMessage", kind: "get", consumer: "session-focus-controller.ts; agent-session.ts captureLiveDumpState" },
	{ path: "getSessionStats", kind: "call", consumer: "pi-tui agent-hub-projection.ts" },
	{ path: "thinkingLevel", kind: "get", consumer: "pi-tui agent-hub-renderer.ts" },
	{ path: "servingModel", kind: "get", consumer: "pi-tui agent-hub-renderer.ts" },
	{ path: "model", kind: "get", consumer: "pi-tui agent-hub-renderer.ts; agent-hub-projection.ts" },
	{ path: "baseSystemPrompt", kind: "get", consumer: "task/executor.ts recordIrcRender" },
	{ path: "getWorkPoolYieldItems", kind: "call", consumer: "task/executor.ts" },
	{ path: "setWorkPoolYieldItems", kind: "call", consumer: "task/workpool.ts cleanup", args: () => [[]] },
	{ path: "getHindsightSessionState", kind: "call", consumer: "internal-urls/memory-protocol.ts" },
	{ path: "settleInFlightMessagePersistence", kind: "call", consumer: "modes/controllers/session-focus-controller.ts" },
	{ path: "activeToolExecutionUpdates", kind: "call", consumer: "modes/controllers/session-focus-controller.ts" },
	{ path: "prompt", kind: "call", consumer: "pi-tui agent-transcript-viewer.ts (hub chat)", args: () => ["ping", { streamingBehavior: "steer" }] },
	{ path: "steer", kind: "call", consumer: "vibe/runtime.ts; modes/rpc/rpc-mode.ts", args: () => ["ping"] },
];

/** What the shim needs of the agents that own it. */
interface SessionHost {
	thread: string;
	id: string;
	deliver(msg: IrcMessage): Promise<IrcReceiptKind>;
	/** Throws when the plan-mode rules refuse a message to this agent. */
	checkIrc(): void;
	stop(): Promise<void>;
	messages(): unknown[];
	detail(): ThreadDetail;
	dir(): string;
	cwd(): string;
}

type SessionListener = (event: { type: string; [key: string]: unknown }) => void;

/**
 * The session object of a cloud agent's registry ref: omp reads it as an `AgentSession`, so it answers every member omp's
 * paths read of one ({@link SHIM_MEMBERS}) and none throws. Run state is the thread's: running while a turn is queued or running.
 */
export class CloudSession {
	readonly #host: SessionHost;
	readonly #now: () => number;
	readonly #listeners = new Set<SessionListener>();
	readonly #runStateListeners = new Set<(status: "running" | "idle") => void>();
	/** Deliveries in flight (a relay to a sender): `waitForIrcReplies` waits for them. */
	readonly #pending = new Set<Promise<unknown>>();
	#streaming = false;
	#startedAt: number | undefined;

	constructor(host: SessionHost, now: () => number) {
		this.#host = host;
		this.#now = now;
	}

	get isStreaming(): boolean {
		return this.#streaming;
	}

	get runStartedAt(): number | undefined {
		return this.#startedAt;
	}

	/** The thread has a turn queued or running (or one a message just queued). Emits `agent_start` and `agent_end`; `agent_end` comes after the deliveries {@link track} holds are made. */
	setActive(active: boolean): void {
		if (active === this.#streaming) return;
		this.#streaming = active;
		if (active) this.#startedAt = this.#now();
		for (const listener of [...this.#runStateListeners]) this.#safely(() => listener(active ? "running" : "idle"));
		this.#emit({ type: active ? "agent_start" : "agent_end", ...(active ? {} : { messages: [] }) });
	}

	/** A delivery made for the run that is ending: `waitForIrcReplies` resolves once it settled. */
	track(delivery: Promise<unknown>): void {
		this.#pending.add(delivery);
		void delivery.finally(() => this.#pending.delete(delivery)).catch(() => {});
	}

	subscribe(listener: SessionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	subscribeRunState(listener: (status: "running" | "idle") => void): () => void {
		this.#runStateListeners.add(listener);
		return () => this.#runStateListeners.delete(listener);
	}

	/** omp's IRC delivery: the message goes to the service; the receipt is the service's (`injected` into the running turn, `woken`, `revived`). A failure throws, which the bus turns into a `failed` receipt. */
	async deliverIrcMessage(msg: IrcMessage): Promise<IrcReceiptKind> {
		this.#host.checkIrc();
		return this.#host.deliver(msg);
	}

	async waitForIrcReplies(): Promise<void> {
		while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
	}

	/** Only a session's own inbox has messages to drain; a cloud agent's mail is in the cloud. */
	drainPendingIrcInboxMessages(_agentId: string, _opts?: { from?: string; limit?: number }): IrcMessage[] {
		return [];
	}

	emitIrcRelayObservation(_record: unknown): void {}

	/** The conversation: what the last exported turn left, or the thread's turns and, while one runs, its events. */
	get messages(): unknown[] {
		return this.#host.messages();
	}

	/** A user's kill, the hub's stop: stops the cloud turn (and cancels the queued ones) like a native agent's abort. */
	async abort(_opts?: { reason?: string }): Promise<void> {
		await this.#host.stop();
	}

	/** omp lets the session go (a kill, a release): nothing local is held but listeners; the thread keeps living in the cloud. */
	async dispose(_opts?: unknown): Promise<void> {
		this.#listeners.clear();
		this.#runStateListeners.clear();
	}

	readonly sessionManager = {
		getArtifactsDir: (): string => this.#host.dir(),
		getCwd: (): string => this.#host.cwd(),
		getSessionId: (): string => this.#host.thread,
		getSessionFile: (): undefined => undefined,
		getEntries: (): unknown[] => [],
		getUsageStatistics: (): { cost: number; subagentCost: number } => ({ cost: this.#host.detail().metrics?.usage.cost ?? 0, subagentCost: 0 }),
	};

	readonly agent = {
		state: {
			get messages(): unknown[] {
				return [];
			},
			isStreaming: false,
			streamMessage: undefined,
		},
	};

	get sessionFile(): undefined {
		return undefined;
	}

	/** The Agent Hub's row metrics. */
	getSessionStats(): { tokens: { input: number; output: number; cacheWrite: number }; assistantMessages: number; toolCalls: number; cost: number; contextUsage: { tokens: number; contextWindow: number } | null } {
		const m = this.#host.detail().metrics;
		return {
			tokens: { input: m?.usage.inputTokens ?? 0, output: m?.usage.outputTokens ?? 0, cacheWrite: m?.usage.cacheWriteTokens ?? 0 },
			assistantMessages: m?.requests ?? 0,
			toolCalls: m?.tools ?? 0,
			cost: m?.usage.cost ?? 0,
			contextUsage: m?.context ? { tokens: m.context.tokens, contextWindow: m.context.window } : null,
		};
	}

	get thinkingLevel(): string | undefined {
		const level = this.#host.detail().thinking;
		return level === "" ? undefined : level;
	}

	get servingModel(): undefined {
		return undefined;
	}

	get model(): { id: string; provider: string; contextWindow: number } | undefined {
		const d = this.#host.detail();
		if (d.model === "") return undefined;
		const [provider = "", ...rest] = d.model.split("/");
		return { id: rest.length > 0 ? rest.join("/") : provider, provider: rest.length > 0 ? provider : "", contextWindow: d.metrics?.context?.window ?? 0 };
	}

	get baseSystemPrompt(): undefined {
		return undefined;
	}

	getWorkPoolYieldItems(): unknown[] {
		return [];
	}

	async setWorkPoolYieldItems(_items: unknown[]): Promise<void> {}

	getHindsightSessionState(): undefined {
		return undefined;
	}

	async settleInFlightMessagePersistence(): Promise<void> {}

	activeToolExecutionUpdates(): Iterable<unknown> {
		return [];
	}

	/** The hub's chat box: a message typed to the agent is a message to the cloud agent. */
	async prompt(text: string, _opts?: unknown): Promise<void> {
		await this.#host.deliver({ id: `hub-${this.#now()}`, from: MAIN_AGENT_ID, to: this.#host.id, body: text, ts: this.#now() });
	}

	async steer(text: string, _images?: unknown, _opts?: unknown): Promise<void> {
		await this.prompt(text);
	}

	#emit(event: { type: string; [key: string]: unknown }): void {
		for (const listener of [...this.#listeners]) this.#safely(() => listener(event));
	}

	/** A listener's failure never reaches the thread's own bookkeeping. */
	#safely(call: () => void): void {
		try {
			call();
		} catch {
			// a subscriber of omp's: its error is its own
		}
	}
}

/** One followed thread. */
interface Agent {
	thread: string;
	id: string;
	shim: CloudSession;
	detail: ThreadDetail;
	/** Turn ids whose end was handled (published, relayed). */
	ended: Set<number>;
	/** The key of the turn result last written to the artifacts directory. */
	published: string;
	/** Turns whose reply is on its way to the sender: their card is not posted. */
	relaying: Set<number>;
	/** A turn a message queued that the thread's detail does not show yet, and until when it counts. */
	awaiting: { turn: number | undefined; until: number } | undefined;
	/** The running turn's events as text lines, by turn. */
	log: Map<number, string[]>;
	/** The sender of each message delivered to the agent, by message id (the service stores the sender as it accepts it). */
	senders: Map<string, string>;
	/** Messages delivered to the agent that no turn answers: a relay or a broadcast is never relayed back. */
	noRelay: Set<string>;
	parentId: string;
	/** The conversation of the last exported turn, with the number of finished turns it covers. */
	loaded: { messages: unknown[]; finished: number } | undefined;
	hydrating: boolean;
}

/** The registry refs, artifacts and message routes of the cloud threads a session follows. One instance per plugin. */
export class CloudAgents {
	readonly #opts: CloudAgentsOptions;
	readonly #now: () => number;
	readonly #agents = new Map<string, Agent>();
	/** Message ids of cloud agents already handed to omp: replays of the event log never repeat one. */
	readonly #seen = new Set<string>();
	#seenSynced = false;
	#dir: string | undefined;
	#unregisterDir: (() => void) | undefined;
	#warnedWrite = false;

	constructor(opts: CloudAgentsOptions) {
		this.#opts = opts;
		this.#now = opts.now ?? Date.now;
		this.#dir = opts.dir;
	}

	#registry(): AgentRegistryLike | undefined {
		return this.#opts.registry ? this.#opts.registry() : AgentRegistry.global();
	}

	/** The id of the agent `thread` is, when it is followed. */
	agentId(thread: string): string | undefined {
		return this.#agents.get(thread)?.id;
	}

	/** Whether omp's agent registry holds an agent with this id: the ids of a cloud agent's own children never take one. */
	holdsId(id: string): boolean {
		return this.#registry()?.get(id) !== undefined;
	}

	/** The directory `<id>.md`, `<id>.json` and `<id>.jsonl` are written to; created and registered with omp on first use (`agent://<id>` and `history://<id>` also read a directory registered with `registerArtifactsDir`). */
	dir(): string {
		if (this.#dir === undefined) this.#dir = mkdtempSync(join(tmpdir(), "omp-cloud-agents-"));
		else mkdirSync(this.#dir, { recursive: true });
		if (this.#unregisterDir === undefined) {
			const register: unknown = Reflect.get(registryHelpers, "registerArtifactsDir");
			this.#unregisterDir = typeof register === "function" ? (register as (dir: string) => () => void)(this.#dir) : () => {};
		}
		return this.#dir;
	}

	/** The thread, as the service shows it now: its ref is registered (and kept while it is idle), a turn that ended since the last call is published and relayed, and the agent's run state follows the thread's. */
	observe(detail: ThreadDetail): void {
		let a = this.#agents.get(detail.id);
		const first = a === undefined;
		a ??= this.#create(detail);
		a.detail = detail;
		this.#ensureRef(a);
		for (const turn of detail.turns) {
			if (!isFinished(turn) || a.ended.has(turn.id)) continue;
			a.ended.add(turn.id);
			// What was finished before the thread was first seen was delivered to someone else already.
			if (!first) this.#finished(a, detail, turn);
		}
		this.#publish(a, detail);
		const live = detail.turns.some(isLive);
		const now = this.#now();
		if (a.awaiting) {
			const queued = a.awaiting.turn === undefined ? undefined : detail.turns.find(t => t.id === a.awaiting?.turn);
			if (live || (queued && isFinished(queued)) || now > a.awaiting.until) a.awaiting = undefined;
		}
		const running = live || a.awaiting !== undefined;
		a.shim.setActive(running);
		const registry = this.#registry();
		registry?.setStatus(a.id, running ? "running" : "idle");
		if (live && detail.activity) registry?.setActivity?.(a.id, detail.activity.text);
		const finished = detail.turns.filter(isFinished).length;
		if (first && finished > 0) void this.#hydrate(a);
	}

	/** One event of the thread's stream: a message the cloud agent sent out goes to its local recipient; the events of a running turn feed `history://`. */
	event(detail: ThreadDetail, e: ThreadEvent): void {
		const a = this.#agents.get(detail.id);
		if (!a) return;
		if (e.kind === IRC_OUT_KIND) {
			this.#inbound(a, e);
			return;
		}
		if (e.turn === null || (e.kind !== "assistant" && e.kind !== "tool" && e.kind !== "tool_error")) return;
		const lines = a.log.get(e.turn) ?? [];
		lines.push(e.kind === "assistant" ? e.text : e.kind === "tool" ? `» ${e.text}` : `! ${e.text}`);
		if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
		a.log.set(e.turn, lines);
	}

	/** Whether the turn's reply is on its way to the agent that woke the thread: nothing else delivers it. */
	relayed(thread: string, turn: number): boolean {
		return this.#agents.get(thread)?.relaying.has(turn) === true;
	}

	/** Whether the main agent's session is in a transition (`/clear`, a new session, a fork, a switch, a branch): omp cancels its jobs itself then, under the same abort reason as a user's cancel, and the session reports it as `isSessionTransitioning`. False when the session has no such getter. */
	ownerTransitioning(): boolean {
		const session: unknown = this.#registry()?.get(MAIN_AGENT_ID)?.session;
		return isRecord(session) && session.isSessionTransitioning === true;
	}

	/** Whether the main agent's session is in plan mode, as its own state says; undefined when the session has no such state (an older omp). */
	ownerPlanning(): boolean | undefined {
		const session: unknown = this.#registry()?.get(MAIN_AGENT_ID)?.session;
		if (!isRecord(session) || typeof session.getPlanModeState !== "function") return undefined;
		const state: unknown = session.getPlanModeState();
		return isRecord(state) && state.enabled === true;
	}

	/** Whether the session is in plan mode: omp's own state, else the last `mode_change` entry of the session. */
	planning(): boolean {
		return this.ownerPlanning() ?? planModeFromEntries(this.#opts.entries());
	}

	/** Plan mode: a message could wake an agent that is not read-only, and its next turn pushes; only read-only agents take messages. */
	#checkIrc(a: Agent): void {
		if (!a.detail.readOnly && this.planning()) throw new Error(`plan mode: ${a.id} is not read-only, so a message could make it change and push work; message it after the plan is approved`);
	}

	/** The `cloud` tool's `send`: the message the way `write agent://<id>` delivers it (omp's IRC, from the main agent). Throws what the bus would report as a failure. */
	async send(thread: string, text: string, from: string = MAIN_AGENT_ID): Promise<{ receipt: IrcReceiptKind; turn: number | null }> {
		const a = this.#agents.get(thread);
		if (!a) throw new Error(`${thread} is not a cloud agent of this session`);
		this.#ensureRef(a);
		const r = await this.#post(a, { id: randomUUID().replaceAll("-", ""), from, to: a.id, body: text, ts: this.#now() });
		return { receipt: r.receipt, turn: r.turn?.id ?? null };
	}

	/**
	 * The `cloud` tool's `read`: `agent://<id>` as omp's own handler resolves it, with the finished turn it names. Undefined when
	 * the thread has no finished turn, is no agent, or omp has no router for the plugin to ask: the caller then reads the turn from the service.
	 */
	async read(thread: string): Promise<{ id: string; text: string; turn: number } | undefined> {
		const a = this.#agents.get(thread);
		const turn = a ? [...a.detail.turns].reverse().find(isFinished) : undefined;
		const Router: unknown = Reflect.get(internalRouter, "InternalUrlRouter");
		const instance: unknown = typeof Router === "function" ? Reflect.get(Router, "instance") : undefined;
		if (!a || !turn || typeof instance !== "function") return undefined;
		const router: unknown = instance.call(Router);
		if (!isRecord(router) || typeof router.resolve !== "function") return undefined;
		const resource: unknown = await (router.resolve as (url: string) => Promise<unknown>).call(router, `agent://${a.id}`);
		return isRecord(resource) && typeof resource.content === "string" ? { id: a.id, text: resource.content, turn: turn.id } : undefined;
	}

	/** The service no longer has the thread, or the session no longer follows it: its ref and files go. */
	release(thread: string): void {
		const a = this.#agents.get(thread);
		if (!a) return;
		this.#agents.delete(thread);
		AGENT_IDS.set(thread, undefined);
		this.#registry()?.unregister(a.id, a.shim);
		a.shim.setActive(false);
		void a.shim.dispose();
		if (this.#dir !== undefined) for (const ext of ["md", "json", "jsonl"]) rmSync(join(this.#dir, `${a.id}.${ext}`), { force: true });
	}

	/** Keeps the refs of `keep` and releases the others: the session now follows only those. */
	retainOnly(keep: ReadonlySet<string>): void {
		for (const thread of [...this.#agents.keys()]) if (!keep.has(thread)) this.release(thread);
	}

	/** The conversation of the thread as `omp session pack` exported it: `history://<id>` reads it from now on. */
	async ingest(thread: string, archive: string): Promise<void> {
		const a = this.#agents.get(thread);
		if (!a) return;
		const text = await readArchiveJournal(archive);
		const file = join(this.dir(), `${a.id}.jsonl`);
		writeFileSync(`${file}.tmp`, text);
		renameSync(`${file}.tmp`, file);
		const load: unknown = Reflect.get(sessionLoader, "loadSessionMessagesReadOnly");
		if (typeof load !== "function") return;
		const messages: unknown = await (load as (file: string) => Promise<unknown>)(file);
		if (Array.isArray(messages)) a.loaded = { messages, finished: a.detail.turns.filter(isFinished).length };
	}

	/** The session ends: refs, files and the registered directory go. */
	dispose(): void {
		for (const thread of [...this.#agents.keys()]) this.release(thread);
		this.#unregisterDir?.();
		this.#unregisterDir = undefined;
		if (this.#dir !== undefined && this.#opts.dir === undefined) rmSync(this.#dir, { recursive: true, force: true });
		this.#dir = this.#opts.dir;
	}

	#create(detail: ThreadDetail): Agent {
		const id = this.#claim(detail);
		const a: Agent = {
			thread: detail.id,
			id,
			shim: undefined as unknown as CloudSession,
			detail,
			ended: new Set(),
			published: "",
			relaying: new Set(),
			awaiting: undefined,
			log: new Map(),
			senders: new Map(),
			noRelay: new Set(),
			parentId: MAIN_AGENT_ID,
			loaded: undefined,
			hydrating: false,
		};
		a.shim = new CloudSession(
			{
				thread: detail.id,
				get id() {
					return a.id;
				},
				deliver: msg => this.#deliver(a, msg),
				checkIrc: () => this.#checkIrc(a),
				stop: () => this.#stop(a),
				messages: () => this.#messages(a),
				detail: () => a.detail,
				dir: () => this.dir(),
				cwd: this.#opts.cwd,
			},
			this.#now,
		);
		this.#agents.set(detail.id, a);
		return a;
	}

	/** `cloudJobId` of the thread, or `-2`, `-3`… when a ref or another thread holds it. */
	#claim(detail: ThreadDetail): string {
		const base = cloudJobId(detail);
		const registry = this.#registry();
		const mine = (id: string): boolean => [...this.#agents.values()].some(a => a.id === id && a.thread !== detail.id);
		let id = base;
		for (let n = 2; mine(id) || registry?.get(id) !== undefined; n++) id = `${base}-${n}`;
		return id;
	}

	/** The ref exists and is this agent's: it is registered again when omp dropped it (a kill), under a new id when another agent took the id. */
	#ensureRef(a: Agent): void {
		const registry = this.#registry();
		const ref = registry?.get(a.id);
		if (registry && ref?.session !== a.shim) {
			if (ref) a.id = this.#claim(a.detail);
			registry.register({ id: a.id, displayName: a.id, kind: "sub", parentId: a.parentId, session: a.shim, sessionFile: null, status: a.shim.isStreaming ? "running" : "idle" });
		}
		// Cards name the thread by the agent id the registry shows (a `-2` suffix included).
		AGENT_IDS.set(a.thread, a.id);
	}

	/** omp's IRC to the cloud agent: the service's IRC endpoint, or the thread's message queue on a service without it. */
	async #deliver(a: Agent, msg: IrcMessage): Promise<IrcReceiptKind> {
		return (await this.#post(a, msg)).receipt;
	}

	async #post(a: Agent, msg: IrcMessage): Promise<{ receipt: IrcReceiptKind; turn: ThreadTurn | null }> {
		let receipt: IrcReceiptKind;
		let queued: ThreadTurn | null;
		try {
			const client = await this.#opts.client();
			let irc = true;
			try {
				await client.requireCapability(IRC_CAPABILITY);
			} catch (e) {
				if (!(e instanceof CloudError) || e.code !== "version_skew") throw e;
				irc = false;
			}
			if (irc) {
				const r = await client.irc(a.thread, { from: sender(msg.from), body: msg.body, id: msg.id, ...(msg.replyTo === undefined ? {} : { replyTo: msg.replyTo }) });
				receipt = r.receipt;
				queued = r.turn;
			} else {
				const r = await client.sendMessage(a.thread, msg.body);
				receipt = a.detail.archivedAt !== null && a.detail.phase === "idle" ? "revived" : a.shim.isStreaming ? "injected" : "woken";
				queued = r.turn;
			}
		} catch (e) {
			throw this.#failure(a, e);
		}
		a.senders.set(msg.id, msg.from);
		if (msg.wakeRelay === true || msg.broadcast === true) a.noRelay.add(msg.id);
		// The agent that wrote last is the one the cloud agent's messages go to when it addresses none.
		const ref = this.#registry()?.get(a.id);
		const sentBy = this.#registry()?.get(msg.from);
		if (ref && sentBy && msg.from !== a.id) {
			a.parentId = msg.from;
			ref.parentId = msg.from;
		}
		if (receipt !== "injected") {
			a.awaiting = { turn: queued?.id, until: this.#now() + AWAIT_MS };
			a.shim.setActive(true);
			this.#registry()?.setStatus(a.id, "running");
		}
		this.#opts.follow(a.thread);
		return { receipt, turn: queued };
	}

	/** What the bus reports for a message that did not arrive; a thread the service lost is forgotten, and a message the client's repeated attempts (same id) could not confirm says it may have been delivered. */
	#failure(a: Agent, e: unknown): Error {
		if (!(e instanceof CloudError)) return e instanceof Error ? e : new Error(String(e));
		if (e.code === "not_found") this.release(a.thread);
		const unsure = e.outcomeKnown ? "" : " The message may have been delivered: the cloud gave no answer after repeated attempts with the same message id.";
		return new Error(`${cloudErrorText(e)}${unsure}`);
	}

	async #stop(a: Agent): Promise<void> {
		try {
			await (await this.#opts.client()).stop(a.thread);
		} catch (e) {
			throw e instanceof CloudError ? new Error(`cannot stop ${a.id}: ${cloudErrorText(e)}`) : e;
		}
	}

	/** A turn ended: an `irc` turn's reply goes back to the agent that sent the message. */
	#finished(a: Agent, detail: ThreadDetail, turn: ThreadTurn): void {
		a.log.delete(turn.id);
		if (turn.origin !== "irc" || turn.ircFrom === "" || a.noRelay.has(turn.ircId)) return;
		const to = a.senders.get(turn.ircId) ?? turn.ircFrom;
		const target = this.#registry()?.get(to);
		const session: unknown = target?.session;
		if (!target || to === a.id || !isRecord(session) || typeof session.deliverIrcMessage !== "function") return;
		a.relaying.add(turn.id);
		const deliver = session.deliverIrcMessage as (msg: IrcMessage) => Promise<unknown>;
		const at = this.#now();
		const relay = (async () => {
			try {
				await deliver.call(session, { id: `${a.id}-${turn.id}-${at}`, from: a.id, to, body: relayBody(a.id, detail, turn), ts: at, ...(turn.ircId === "" ? {} : { replyTo: turn.ircId }), wakeRelay: true });
			} catch (e) {
				a.relaying.delete(turn.id);
				this.#opts.relayFailed(detail, turn, e instanceof Error ? e.message : String(e));
			}
		})();
		a.shim.track(relay);
	}

	/** A message the cloud agent sent out reaches its recipient's session once, as omp's own incoming message. */
	#inbound(a: Agent, e: ThreadEvent): void {
		const payload = parseIrcPayload(e.text);
		if (!payload) return;
		if (!this.#seenSynced) {
			for (const id of ircIdsFromEntries(this.#opts.entries())) this.#seen.add(id);
			this.#seenSynced = true;
		}
		if (this.#seen.has(payload.id)) return;
		const registry = this.#registry();
		const addressed = registry?.get(payload.to);
		const to = addressed && payload.to !== a.id && addressed.session ? payload.to : a.parentId;
		const session: unknown = registry?.get(to)?.session;
		if (!isRecord(session) || typeof session.deliverIrcMessage !== "function") {
			this.#opts.warn(`☁ ${a.id} wrote to ${to}, which is not running here: "${clip(payload.body, 80)}"`);
			return;
		}
		this.#seen.add(payload.id);
		if (this.#seen.size > SEEN_MAX) this.#seen.delete(this.#seen.values().next().value ?? "");
		const at = Date.parse(payload.at);
		const deliver = session.deliverIrcMessage as (msg: IrcMessage) => Promise<unknown>;
		void deliver
			.call(session, { id: payload.id, from: a.id, to, body: payload.body.replaceAll(IRC_CUT_PLACEHOLDER, `history://${a.id}`), ts: Number.isFinite(at) ? at : this.#now(), ...(payload.replyTo === "" ? {} : { replyTo: payload.replyTo }) })
			.catch((error: unknown) => {
				this.#seen.delete(payload.id);
				this.#opts.warn(`☁ ${a.id}'s message to ${to} was not delivered: ${error instanceof Error ? error.message : String(error)}`);
			});
	}

	/** `<id>.md` and `<id>.json` of the newest finished turn; the same turn's files are written once. */
	#publish(a: Agent, detail: ThreadDetail): void {
		const turn = [...detail.turns].reverse().find(isFinished);
		if (!turn) return;
		const key = `${turn.id}:${turn.state}:${turn.completedAt}:${turn.reply.length}:${turn.error.length}:${detail.result?.updatedAt ?? ""}:${detail.metrics?.requests ?? 0}`;
		if (a.published === key) return;
		try {
			const dir = this.dir();
			const text = turn.state === "done" ? (turn.reply === "" ? "(the turn ended with no reply)" : turn.reply) : `Turn ${turn.id} ${turn.state}: ${turn.error || turn.reply || "no details"}`;
			for (const [ext, content] of [
				["md", text],
				["json", JSON.stringify(turnPayload(detail, turn), null, 2)],
			] as const) {
				const file = join(dir, `${a.id}.${ext}`);
				writeFileSync(`${file}.tmp`, content);
				renameSync(`${file}.tmp`, file);
			}
			a.published = key;
		} catch (e) {
			if (this.#warnedWrite) return;
			this.#warnedWrite = true;
			this.#opts.warn(`☁ cannot write ${a.id}'s result for agent://${a.id}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** The conversation of a thread that finished turns before this session knew it. */
	async #hydrate(a: Agent): Promise<void> {
		if (this.#opts.hydrate === false || a.hydrating || a.loaded) return;
		a.hydrating = true;
		const tmp = mkdtempSync(join(tmpdir(), "omp-cloud-conversation-"));
		try {
			const archive = join(tmp, "conversation.tar");
			await (await this.#opts.client()).downloadConversation(a.thread, archive);
			await this.ingest(a.thread, archive);
		} catch {
			// No conversation yet, or no contact: history:// shows the turns the service reported.
		} finally {
			a.hydrating = false;
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	/** The agent's conversation: the exported one when it covers the finished turns, else the turns and the running turn's events. */
	#messages(a: Agent): unknown[] {
		const turns = a.detail.turns.filter(t => t.state !== "queued");
		const finished = turns.filter(isFinished).length;
		const base = a.loaded && a.loaded.finished >= finished ? a.loaded.messages : undefined;
		if (base && !turns.some(t => t.state === "running")) return base;
		const out: unknown[] = base ? [...base] : [];
		for (const turn of turns) {
			if (base && isFinished(turn)) continue;
			const at = Date.parse(turn.startedAt || turn.queuedAt) || 0;
			out.push({ role: "user", content: turn.origin === "irc" ? `[irc from ${turn.ircFrom}] ${turn.text}` : turn.text, timestamp: at });
			const text = turn.state === "running" ? (a.log.get(turn.id) ?? []).join("\n") : turn.state === "done" ? turn.reply : turn.error || turn.reply;
			if (text.trim() === "") continue;
			out.push({
				role: "assistant",
				content: [{ type: "text", text }],
				api: "omp-cloud",
				provider: "omp-cloud",
				model: a.detail.model,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: turn.state === "failed" ? "error" : "stop",
				timestamp: Date.parse(turn.completedAt) || at,
			});
		}
		return out;
	}
}
