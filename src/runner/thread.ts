/**
 * One thread's VM and omp process: creates the sandbox, starts or re-attaches omp, runs the thread's turns one after
 * another, bridges omp's `ask` tool to the store's questions, pauses the VM when idle and tears it down on deletion.
 *
 * Every VM operation of a thread (create, resume, the prompt loop, pause, teardown) runs through one async queue.
 * Stop, answer and abort handling act on the live omp at once, without waiting for the queue.
 */
import { RpcClient, RpcCommandError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcPromptResultFrame, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { Sandbox } from "e2b";
import type { Config } from "../config";
import type { GatewayClients } from "../gateway/clients";
import type { GatewayModels } from "../gateway/models";
import type { GitService, SignedResult } from "../git";
import { effectiveCommitter } from "../git/committer";
import type { SigningKey } from "../git/signing-key";
import type { GitHubApi } from "../github/api";
import type { GitHubApp } from "../github/app";
import { isRecord } from "../guards";
import type { ServiceSecrets } from "../secrets/store";
import type { Settings } from "../settings";
import { effectivePolicy } from "../settings/tighten";
import { MAX_SOURCE_BYTES } from "../server/limits";
import { ApiError } from "../server/errors";
import { NO_VM_MESSAGE } from "../server/preview";
import { titleFromReply, type Store } from "../store";
import {
	ANSWERED_BY_DROPPED,
	ANSWERED_BY_STOP,
	ANSWERED_BY_TIMEOUT,
	type IrcInbound,
	RESULT_BRANCH_PREFIX,
	type Question,
	StoreError,
	type Thread,
	type Turn,
	type Usage,
	type VmRecord,
} from "../store/types";
import { egressNetwork, type Vmon } from "../vmon";
import { recipeOf } from "../vmon/recipe";
import {
	ASK_DROPPED,
	answersResponse,
	approvalReply,
	expiredAnswer,
	isApproval,
	parseAskRequest,
	stoppedByUser,
	toQuestionInputs,
} from "./ask";
import { APPROVAL_ABORTED, abortAfterDenying, approvalInput, approvalTimeoutAnswer, parseApprovalRequest, PendingApprovals } from "./approval";
import { ChildTracker } from "./children";
import { TurnClock } from "./clock";
import { prepareEnvironment } from "./environment";
import { sandboxExec, shellQuote } from "./exec";
import { adoptSigned, finalizeTurn, type TurnGit } from "./git";
import { formatDuration } from "./omp-config";
import { ompAlive, OmpProcess } from "./omp-process";
import { dropStaleSockets } from "./stale-sockets";
import { IRC_COMMAND, ircDelivered, ircInCommand, ircPlainText, parseIrcFrame, turnMessage } from "./irc";
import { classifyPrompt, type TurnOutcome } from "./outcome";
import { addUsage, type AssistantEnd, assistantEnd, messageText, progressOf, toolEndEventOf, toolStartEventOf, usageEventOf } from "./progress";
import { downloadBlob, ompLaunchArgs, provisionVm, shipIrcExtension, threadMaskEntries, uploadBlob } from "./provision";
import { NOT_PUSHED, PushStep, pullRequestsOf, type PushRecord } from "./push";
import { exportSession, exportSessionId } from "./session-export";
import { checkSpend, type SpendBreach, spendCapError } from "./spend";
import { VM_IRC_EXTENSION, VM_WORKSPACE } from "./vm-layout";

/** What a thread runner needs from the service. */
export interface ThreadEnv {
	store: Store;
	vmon: Vmon;
	gateway: GatewayClients;
	/** The providers the gateway serves, which each VM's models.yml lists. */
	models: Pick<GatewayModels, "providers">;
	config: Config;
	/** `store.serviceId()`: names this service's sandboxes and gateway clients. */
	serviceId: string;
	/** The run-time settings, read at use time: the push policy (`git.push`, `git.branch`, `git.protected`) and the policy a thread tightens (`policy.*`). */
	settings: Settings;
	/** Completes the delta handoffs of the threads it runs to full-history bundles. */
	git: GitService;
	/** The service's SSH signing key, which `git.sign` `ssh` re-signs each turn's commits with. */
	signingKey: SigningKey;
	/** The connected GitHub App: its token pushes to github.com and opens pull requests. */
	github: GitHubApp;
	/** The client of GitHub's REST API that pull requests go through. */
	githubApi: GitHubApi;
	/** The service's secret store: the secrets that match a thread's repository go into its VM's env file. */
	secrets: ServiceSecrets;
	/** `<ip>:<port>` of the listening MCP proxy that VMs reach their http MCP servers at; absent when there is none. */
	mcpListen?: string;
	/** The service host's omp version: what a thread stored without one runs. */
	ompVersion: string;
}

/** The gateway client of a thread. */
export function clientName(serviceId: string, threadId: string): string {
	return `omp-cloud-${serviceId}-${threadId}`;
}

/** The gateway client the service reads the model list with. Thread ids are 12 characters, so it never names a thread. */
export function serviceClientName(serviceId: string): string {
	return clientName(serviceId, "service");
}

function isMissingThread(error: unknown): boolean {
	return error instanceof StoreError && error.code === "thread_not_found";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Drops the thread's VM: kills the sandbox (when `kill`), revokes its gateway client and removes the record. A
 * sandbox that could not be killed is left for the next start's reconcile to find.
 */
export async function releaseVm(env: ThreadEnv, threadId: string, kill: boolean): Promise<void> {
	const record = env.store.vm(threadId);
	if (record !== null && kill) {
		try {
			await env.vmon.kill(record.sandboxId);
		} catch (error) {
			console.error(`omp-cloud: killing sandbox ${record.sandboxId} of thread ${threadId} failed: ${describe(error)}`);
		}
	}
	try {
		await env.gateway.revoke(clientName(env.serviceId, threadId));
	} catch (error) {
		console.error(`omp-cloud: revoking the gateway client of thread ${threadId} failed: ${describe(error)}`);
	}
	env.store.removeVm(threadId);
}

/**
 * The sandbox is gone: forget the VM and requeue the running turn (a turn that was asked to stop ends failed). The thread
 * lives on: the next turn restores it on a new VM from its last result and conversation.
 */
export async function loseVm(env: ThreadEnv, threadId: string): Promise<void> {
	await releaseVm(env, threadId, false);
	try {
		env.store.requeueRunningTurn(threadId);
		env.store.appendEvent(threadId, "vm", "the VM was lost; restoring the thread on a new VM", null);
	} catch (error) {
		if (!isMissingThread(error)) throw error;
	}
}

const BUNDLE_PATH = "/tmp/omp-cloud-result.bundle";
const SIGNED_BUNDLE_PATH = "/tmp/omp-cloud-signed.bundle";
const EXPORT_PATH = "/tmp/omp-cloud-session-export.tar";
/** Poll `get_state` this often while a turn runs, in case omp's frames were lost. */
const POLL_MS = 30_000;
/** After a built-in command's answer, check this often whether omp finished what the command left running. */
const LOCAL_POLL_MS = 1000;
/** Check this often whether the stream to omp dropped while a turn runs. */
const WATCH_MS = 5000;
/** `client.start()` (handshake with a new or adopted omp) must finish within this. */
const CLIENT_START_MS = 60_000;
/** Seconds to wait before the n-th retry of preparing an existing VM; one more failure fails the thread. */
const RETRY_DELAYS_S = [5, 15, 30, 60, 120] as const;
/** Consecutive restores of a lost VM (without a completed turn in between) before the thread fails. */
const MAX_RESTORES = 2;
/** The longest wait between idle-pause attempts after failures. */
const MAX_IDLE_DELAY_S = 3600;
/** A preview request extends the sandbox's timeout at most this often. */
const PREVIEW_EXTEND_MS = 60_000;
/**
 * Re-attach to drop the SDK's buffered output once this many bytes arrived since the last attach. The e2b SDK's
 * `CommandHandle` keeps all stdout in memory; `disconnect()` then `commands.connect(pid)` starts a fresh, empty handle.
 * One very long turn still grows without bound, because the reattach waits for omp to settle.
 */
const REATTACH_BYTES = 4 * 1024 * 1024;
const SET_ASK_DIALOG_ID = "omp-cloud-ask-dialog";
const SET_EVENT_FILTER_ID = "omp-cloud-event-filter";
const SET_SUBAGENT_SUBSCRIPTION_ID = "omp-cloud-subagent-subscription";
const DETACH_WAIT_MS = 5000;
/** `get_available_commands` (is `/irc-in` there?) must answer within this. */
const IRC_PROBE_MS = 5000;
/** The commit message of the archive snapshot of a dirty workspace. */
const ARCHIVE_COMMIT_MESSAGE = "omp-cloud: archive snapshot";
/** A thread whose archive failed is not tried again for this long. */
const ARCHIVE_BACKOFF_MS = 24 * 3600 * 1000;
/** The most command output and extension notifications a turn keeps (characters); the rest is dropped. */
const MAX_COMMAND_OUTPUT_CHARS = 100_000;

/** How an archive attempt ended: not eligible or backed off, released, or failed and postponed. */
export type ArchiveOutcome = "skipped" | "archived" | "postponed";

/** The omp process of a thread and what listens to it. */
interface Live {
	proc: OmpProcess;
	client: RpcClient;
	/** envd reported that the process ended. */
	exited: boolean;
	/** The VM's omp has the `/irc-in` command (the IRC extension loaded): messages for the agent are delivered natively. */
	irc: boolean;
	listeners: (() => void)[];
}

/** vmon no longer has the sandbox. `loseVm` already released the VM record and requeued the running turn. */
class VmLostError extends Error {
	constructor() {
		super("the VM was lost");
	}
}

/** An `ask` call of omp waiting for its answers. */
interface OpenAsk {
	requestId: string;
	/** The store's number of the ask within the turn. */
	ask: number;
	/** A tool approval, not a model `ask`: answered `Approve` or `Deny`, and denied by every abort. */
	approval: boolean;
	timer: Timer | undefined;
}

/** Why a turn stopped waiting for omp. */
type TurnEnd =
	| { kind: "result"; result: RpcPromptResultFrame | undefined }
	| { kind: "rejected"; message: string }
	/** Stop was requested before the prompt went out. */
	| { kind: "stopped" }
	| { kind: "exited"; reason: string }
	/** The VM was lost mid-turn: `loseVm` already requeued the turn. */
	| { kind: "lost" }
	/** The runner is shutting down or the thread was deleted. */
	| { kind: "disposed" };

/** The turn being played. */
interface RunningTurn {
	/** The thread as the turn started: its policy never changes. */
	thread: Thread;
	turn: Turn;
	clock: TurnClock;
	usage: Usage | null;
	/** Assistant messages (model requests) and tool calls of the turn, as its events showed them. */
	requests: number;
	tools: number;
	/** The context use omp last reported while the turn ran. */
	context: { tokens: number; window: number } | null;
	/** How the last assistant message ended. */
	last: AssistantEnd | null;
	/** The last non-empty assistant text of this turn: its reply. */
	lastText: string;
	/** Frames of this turn may have been missed (a redelivery, a lost stream): the reply is read back from omp when no text was seen. */
	eventsLost: boolean;
	/** Set once omp acknowledged the prompt. */
	promptId: string | undefined;
	/** The prompt frame is on its way: settle frames count from here. */
	sent: boolean;
	results: RpcPromptResultFrame[];
	/** What slash commands printed (`command_output`) and extensions notified during the turn, in order. */
	commandOutput: string[];
	commandOutputChars: number;
	/** Ids of the `prompt` responses that said `agentInvoked: false`: omp ran the prompt as a built-in command, which sends no `prompt_result` and no settle frame. */
	localAcks: Set<string>;
	/** After a local ack: omp reported itself idle, settled and not compacting twice in a row, so a background command (`/compact`) is over. */
	localQuiet: boolean;
	sawSettled: boolean;
	polledSettled: boolean;
	/** The turn is being aborted (a stop, the clock or a spend cap): a prompt result is enough, without waiting for the settle. */
	aborting: boolean;
	stopRequested: boolean;
	/** A turn found running after a service restart whose prompt is already with omp: wait for the settle instead of prompting. */
	observing: boolean;
	asks: Map<string, OpenAsk>;
	/** Tool calls started and not ended yet, by omp's tool call id: when they started (for `tool_end`'s duration) and their arguments. */
	toolStarts: Map<string, { ms: number; args: unknown }>;
	/** The spend cap the turn went over: the turn is aborted and ends failed with {@link spendCapError}. */
	capHit: SpendBreach | null;
	/** The push step while the turn's result is being pushed (it may wait for the owner's answer). */
	push: PushStep | null;
	finished: boolean;
	finish: (end: TurnEnd) => void;
	ended: Promise<TurnEnd>;
	poll: Timer | undefined;
	watch: Timer | undefined;
}

/** What `#ensureOmp` found: a new process, one adopted from an earlier service run, or the one this runner already drives. */
type Prepared = "fresh" | "adopted" | "existing";

export class ThreadRunner {
	#queue: Promise<unknown> = Promise.resolve();
	#loopQueued = false;
	#disposed = false;
	#sandbox: Sandbox | null = null;
	#live: Live | null = null;
	#running: RunningTurn | null = null;
	#idleTimer: Timer | undefined;
	/** Consecutive turns that ended with omp dying. */
	#deaths = 0;
	/** Consecutive restores of a lost VM: reset when a turn completes. */
	#restores = 0;
	/** Consecutive failures to reach the existing VM. */
	#vmFailures = 0;
	/** Consecutive failed idle pauses: they back the next attempt off. */
	#idleFailures = 0;
	/** A reconnect to the sandbox in progress; concurrent callers share it. */
	#resyncing: Promise<Live> | null = null;
	/** Ends the sleep in progress (a retry backoff), if any. */
	#sleeper: (() => void) | null = null;
	/**
	 * The approvals the current omp process asked and nobody answered yet. omp's `abort` blocks until each is answered, and a
	 * requeue forgets the turn's questions, so this outlives `rt.asks`; a fresh omp process clears it.
	 */
	readonly #pending = new PendingApprovals();
	/** The lost attempt of a requeued turn is being aborted: an approval that arrives meanwhile is denied, never asked. */
	#abortingStale = false;
	/** An archive attempt failed: the thread is not archived again before this time (epoch ms). */
	#archiveRetryAt = 0;
	/** The notice that the VM's omp has no IRC extension was given once. */
	#ircNoticed = false;
	/** Messages for the agent are being handed to omp; one that arrives meanwhile is picked up by the loop in progress. */
	#ircFlushing = false;
	#ircFlushAgain = false;
	/** The context window omp last reported for the thread's model (`0` before it did): what `usage` events carry. */
	#contextWindow = 0;
	/** The background jobs and subagents omp runs for the thread, written as `child_*` events ({@link ChildTracker}). */
	readonly #children: ChildTracker;
	/** The open children were read back from the store (once per runner). */
	#childrenLoaded = false;
	/** The turn that ran last: the one a child that starts while no turn runs belongs to. */
	#lastTurn: number | null = null;
	/** When a preview request last extended the sandbox's timeout (epoch ms): it does so at most once per `PREVIEW_EXTEND_MS`. */
	#previewExtendedAt = 0;

	constructor(
		private readonly env: ThreadEnv,
		readonly id: string,
	) {
		this.#children = new ChildTracker((kind, text, turn) => this.#event(kind, text, turn));
	}

	/** Work may be waiting: runs the loop once the queue is free. Cancels the idle pause. */
	wake(): void {
		if (this.#disposed) return;
		this.#clearIdle();
		if (this.#loopQueued) return;
		this.#loopQueued = true;
		void this.#serial(async () => {
			this.#loopQueued = false;
			try {
				await this.#loop();
			} catch (error) {
				await this.#crash(error);
			}
		}).catch(error => {
			console.error(`omp-cloud: the runner of thread ${this.id} failed: ${describe(error)}`);
		});
	}

	/** The store asked the running turn to stop: abort omp now. */
	onStopRequested(turnId: number): void {
		const rt = this.#running;
		if (rt === null || rt.turn.id !== turnId) return;
		rt.stopRequested = true;
		void this.#abort(rt, ANSWERED_BY_STOP);
	}

	/** An answer or an expiry landed: sends omp the answers of every ask that is complete. */
	recheckAsks(): void {
		const rt = this.#running;
		if (rt === null) return;
		rt.push?.recheck();
		if (rt.asks.size === 0) return;
		const turn = this.#turnNow(rt.turn.id);
		if (turn === null) return;
		for (const open of [...rt.asks.values()]) {
			const questions = turn.questions.filter(q => q.ask === open.ask);
			if (questions.length === 0 || questions.some(q => q.answeredAt === null)) continue;
			this.#closeAsk(rt, open);
			if (stoppedByUser(questions) && !isApproval(questions)) continue;
			if (open.approval) this.#pending.settle(open.requestId);
			this.#send(answersResponse(open.requestId, questions));
		}
	}

	/** An `irc_in` event landed: hands the messages sent into the running turn to omp. */
	onIrcQueued(): void {
		const rt = this.#running;
		if (rt !== null) void this.#flushIrc(rt);
	}

	/** After the loop ends: waits `idleTimeoutSeconds`, then pauses the VM if nothing is queued or running. A paused sandbox does not count against the team's concurrent-sandbox limit, so this is what frees an idle thread's slot. */
	scheduleIdle(): void {
		this.#clearIdle();
		if (this.#disposed) return;
		const record = this.env.store.vm(this.id);
		if (record === null || record.state !== "running") return;
		const base = this.env.config.runner.idleTimeoutSeconds;
		const delaySeconds = Math.min(base * 2 ** Math.min(this.#idleFailures, 8), Math.max(base, MAX_IDLE_DELAY_S));
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			void this.#serial(() => this.#pauseIfIdle()).catch(error => {
				console.error(`omp-cloud: pausing the VM of thread ${this.id} failed: ${describe(error)}`);
			});
		}, delaySeconds * 1000);
	}

	/**
	 * The sandbox a preview request goes to. A running VM is used at once, without waiting for the thread's queue (a turn
	 * holds it for its whole length); a paused one is resumed in the queue. Every call postpones the idle pause, and keeps
	 * vmon's own sandbox timeout from pausing a VM somebody is looking at. ApiError 409 when the thread has no VM.
	 */
	async vmFor(): Promise<string> {
		const { store, config } = this.env;
		const record = store.vm(this.id);
		if (record === null) throw new ApiError(409, NO_VM_MESSAGE);
		const sandbox = this.#sandbox;
		let sandboxId = record.sandboxId;
		let ready = record.state === "running" && sandbox !== null;
		if (sandbox !== null && ready && Date.now() - this.#previewExtendedAt >= PREVIEW_EXTEND_MS) {
			// A failure means vmon paused the sandbox at its timeout: resume it below.
			ready = await sandbox.setTimeout(config.runner.sandboxTimeoutSeconds * 1000).then(
				() => true,
				() => false,
			);
			if (ready) this.#previewExtendedAt = Date.now();
		}
		if (!ready) sandboxId = await this.#serial(() => this.#resumeForPreview());
		if (this.#running === null) this.scheduleIdle();
		return sandboxId;
	}

	async #resumeForPreview(): Promise<string> {
		const record = this.env.store.vm(this.id);
		if (record === null) throw new ApiError(409, NO_VM_MESSAGE);
		try {
			await this.#reconnect(record, null);
		} catch (error) {
			if (error instanceof VmLostError) throw new ApiError(409, "the VM was lost; send the thread a message to restore it");
			throw error;
		}
		this.#previewExtendedAt = Date.now();
		return record.sandboxId;
	}

	/** The thread was deleted: ends running work and timers, kills the sandbox, revokes the client, forgets the VM. */
	async teardown(): Promise<void> {
		this.#dispose();
		await this.#serial(async () => {
			const live = this.#live;
			await releaseVm(this.env, this.id, true);
			this.#sandbox = null;
			this.#live = null;
			if (live !== null) this.#release(live);
			// The sandbox is gone, so the process never reports its exit: do not wait for the client to stop.
			if (live !== null) void live.client.stop().catch(() => {});
			// A result bundle a concurrent finalize wrote after the thread's files were removed must not linger.
			try {
				await this.env.store.removeBlobs(this.id);
			} catch (error) {
				console.error(`omp-cloud: removing the files of thread ${this.id} failed: ${describe(error)}`);
			}
		});
	}

	/**
	 * Releases the VM of an idle thread after a lossless snapshot (the archive sweep, `lifecycle.ts`): eligibility
	 * (`archiveCandidates(cutoff)`) is checked again in the thread's queue, the VM is resumed if paused, uncommitted work
	 * is committed, the result bundle and the conversation are stored, and only then the archive is recorded and the sandbox
	 * killed. A failure keeps the VM (paused again if it was) and leaves the thread alone for a day. `days` is the setting the
	 * event quotes.
	 */
	archive(cutoff: string, days: number): Promise<ArchiveOutcome> {
		return this.#serial(() => this.#archive(cutoff, days));
	}

	/** The service is stopping: ends the loop and detaches from omp, which keeps running with the VM. */
	async detach(): Promise<void> {
		this.#dispose();
		await Promise.race([this.#queue, Bun.sleep(DETACH_WAIT_MS)]);
		const live = this.#live;
		this.#live = null;
		if (live !== null) {
			this.#release(live);
			await live.proc.detach().catch(() => {});
		}
	}

	#serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(work);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#dispose(): void {
		this.#disposed = true;
		this.#clearIdle();
		this.#sleeper?.();
		const rt = this.#running;
		if (rt === null) return;
		rt.push?.cancel();
		for (const open of rt.asks.values()) clearTimeout(open.timer);
		rt.asks.clear();
		rt.clock.stop();
		this.#evaluate(rt);
	}

	#clearIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
	}

	#event(kind: string, text: string, turn: number | null): void {
		try {
			this.env.store.appendEvent(this.id, kind, text, turn);
		} catch (error) {
			if (!isMissingThread(error)) console.error(`omp-cloud: appending an event to thread ${this.id} failed: ${describe(error)}`);
		}
	}

	/** The turn as the store has it; null when the thread is gone. */
	#turnNow(turnId: number): Turn | null {
		try {
			return this.env.store.turns(this.id).find(t => t.id === turnId) ?? null;
		} catch (error) {
			if (isMissingThread(error)) return null;
			throw error;
		}
	}

	/** Writes a frame to omp's stdin; a failure only means omp is gone. */
	#send(frame: Record<string, unknown>): void {
		const live = this.#live;
		if (live === null) return;
		live.proc.sendFrame(frame).catch(() => {
			// The sandbox may have been paused under us: reconnect and write the frame once more.
			if (this.#disposed || live.exited) return;
			this.#resync().then(
				fresh => fresh.proc.sendFrame(frame).catch(() => {}),
				(error: unknown) => {
					// The reconnect failed for good: a turn waiting on omp would never end.
					const rt = this.#running;
					if (rt !== null && (this.#live === null || error instanceof VmLostError)) this.#unreachable(rt, error);
				},
			);
		});
	}

	/** An unexpected error ended the loop: the thread cannot go on. */
	async #crash(error: unknown): Promise<void> {
		if (this.#disposed || isMissingThread(error)) return;
		console.error(`omp-cloud: the runner of thread ${this.id} failed: ${describe(error)}`);
		await this.#fail(`the runner failed: ${describe(error)}`);
	}

	/** Fails the thread and releases its VM, which can never be used again. */
	async #fail(message: string): Promise<void> {
		try {
			this.env.store.failThread(this.id, message);
		} catch (error) {
			if (!isMissingThread(error)) console.error(`omp-cloud: failing thread ${this.id} failed: ${describe(error)}`);
		}
		this.#children.cancel("the thread failed");
		const live = this.#live;
		this.#live = null;
		this.#sandbox = null;
		if (live !== null) {
			this.#release(live);
			await live.proc.detach().catch(() => {});
		}
		await releaseVm(this.env, this.id, true);
	}

	// ---- the work loop

	async #loop(): Promise<void> {
		const { store } = this.env;
		while (!this.#disposed) {
			const thread = store.getThread(this.id);
			if (thread === null || thread.phase === "failed") return;
			const redelivered = store.turns(this.id).some(t => t.state === "running");
			const turn = store.startNextTurn(this.id);
			if (turn === null) {
				this.scheduleIdle();
				return;
			}
			this.#idleFailures = 0;
			if (!(await this.#runTurn(thread, turn, redelivered))) return;
		}
	}

	/** Plays one turn. False when the loop must end (the thread failed, was lost or deleted, or the runner stops). */
	async #runTurn(thread: Thread, turn: Turn, redelivered: boolean): Promise<boolean> {
		const { store, config } = this.env;
		const prepared = await this.#ensureOmp(thread, turn.id);
		if (prepared === "retry") return true;
		const live = this.#live;
		if (prepared === null || live === null) return false;

		const rt = this.#beginTurn(thread, turn);
		const ttlMs = config.runner.sandboxTimeoutSeconds * 1000;
		const refresh = setInterval(
			() => {
				this.#sandbox?.setTimeout(ttlMs).catch(() => {});
			},
			Math.min(600, config.runner.sandboxTimeoutSeconds / 3) * 1000,
		);
		try {
			await this.#sandbox?.setTimeout(ttlMs).catch(() => {});
			rt.poll = setInterval(() => void this.#poll(rt), POLL_MS);
			rt.watch = setInterval(() => void this.#watch(rt), WATCH_MS);
			const end = await this.#drive(rt, redelivered, prepared);
			if (end.kind === "disposed") return false;
			if (end.kind === "exited") return await this.#died(live, end.reason);
			if (end.kind === "lost") return await this.#restored();

			let outcome: TurnOutcome;
			if (rt.capHit !== null && !rt.stopRequested) outcome = { outcome: "failed", error: spendCapError(rt.capHit) };
			else if (end.kind === "stopped" || rt.stopRequested) outcome = { outcome: "failed", error: "stopped" };
			else if (rt.clock.deadline() <= Date.now()) {
				outcome = { outcome: "failed", error: `turn timed out after ${formatDuration(config.runner.turnTimeoutSeconds)}` };
			} else if (end.kind === "rejected") outcome = { outcome: "failed", error: `prompt rejected: ${end.message}` };
			else outcome = classifyPrompt(end.result, rt.last);

			// A built-in or extension command that never reached the model: omp said `agentInvoked: false` (on the prompt response or on its `prompt_result`) and made no request.
			const local =
				end.kind === "result" && rt.requests === 0 && rt.promptId !== undefined && (rt.localAcks.has(rt.promptId) || end.result?.agentInvoked === false);
			let reply = "";
			let git = { head: "", filesChanged: 0, insertions: 0, deletions: 0 };
			if (end.kind !== "stopped" && end.kind !== "rejected") {
				// What omp printed for a command is the reply.
				reply = local && rt.commandOutput.length > 0 ? rt.commandOutput.join("\n").trim() : rt.lastText;
				// The session's last assistant text belongs to an earlier turn when this one never reached the model.
				if (reply === "" && rt.eventsLost && !local) reply = await this.#lastReply();
			}
			if (end.kind === "result") await this.#refreshContext(rt);
			let pushed: PushRecord = NOT_PUSHED;
			if (end.kind !== "stopped") {
				git = await this.#finalizeGit(thread, turn, local ? "" : reply);
				await this.#exportConversation(turn);
				// A command that never reached the model made no result of its own: the next model turn pushes whatever it changed.
				if (!local) {
					const record = await this.#push(rt, thread, turn, outcome, git.head, reply);
					if (record === null) return false;
					pushed = record;
				}
			}
			try {
				store.completeTurn(this.id, turn.id, {
					outcome: outcome.outcome,
					error: outcome.error,
					reply,
					usage: rt.usage,
					requests: rt.requests,
					tools: rt.tools,
					context: rt.context,
					...git,
					...pushed,
				});
				this.#deaths = 0;
				this.#restores = 0;
				this.#vmFailures = 0;
			} catch (error) {
				if (!(error instanceof StoreError) || (error.code !== "thread_not_found" && error.code !== "turn_not_running")) throw error;
			}
			await this.#dropBuffer();
			return true;
		} finally {
			clearInterval(refresh);
			clearInterval(rt.poll);
			clearInterval(rt.watch);
			rt.clock.stop();
			for (const open of rt.asks.values()) clearTimeout(open.timer);
			rt.asks.clear();
			this.#running = null;
		}
	}

	#beginTurn(thread: Thread, turn: Turn): RunningTurn {
		const { runner } = this.env.config;
		let finish: (end: TurnEnd) => void = () => {};
		const ended = new Promise<TurnEnd>(resolve => {
			finish = resolve;
		});
		const rt: RunningTurn = {
			thread,
			turn,
			clock: new TurnClock(runner.turnTimeoutSeconds * 1000, () => {
				rt.aborting = true;
				void this.#abort(rt, ANSWERED_BY_TIMEOUT);
			}),
			usage: null,
			requests: 0,
			tools: 0,
			context: null,
			last: null,
			lastText: "",
			eventsLost: false,
			promptId: undefined,
			sent: false,
			results: [],
			commandOutput: [],
			commandOutputChars: 0,
			localAcks: new Set(),
			localQuiet: false,
			sawSettled: false,
			polledSettled: false,
			aborting: false,
			stopRequested: false,
			observing: false,
			asks: new Map(),
			toolStarts: new Map(),
			capHit: null,
			push: null,
			finished: false,
			finish: end => {
				if (rt.finished) return;
				rt.finished = true;
				finish(end);
			},
			ended,
			poll: undefined,
			watch: undefined,
		};
		this.#running = rt;
		this.#lastTurn = turn.id;
		return rt;
	}

	/** Prompts omp with the turn (or finds out what became of a prompt an earlier service run sent) and waits for it to settle. */
	async #drive(rt: RunningTurn, redelivered: boolean, prepared: Prepared): Promise<TurnEnd> {
		const { store } = this.env;
		const turn = this.#turnNow(rt.turn.id);
		if (turn === null) return { kind: "disposed" };
		try {
			// A turn found running, or any turn on an omp adopted from an earlier run: omp may still be busy with what it was given.
			if (redelivered || prepared === "adopted") {
				if (redelivered) {
					rt.eventsLost = true;
					if (prepared === "fresh") this.#dropStaleAsks(turn);
					else this.#rebuildAsks(rt, turn);
				}
				const state = await this.#rpc(live => live.client.getState());
				if (turn.stopRequested) {
					rt.stopRequested = true;
					await this.#abort(rt, ANSWERED_BY_STOP);
				}
				const settled = state.isSettled && !state.isStreaming;
				if (turn.promptSentAt !== null) {
					if (!settled) {
						rt.observing = true;
						this.#evaluate(rt);
						void this.#flushIrc(rt);
						const end = await rt.ended;
						if (end.kind === "result") rt.last = await this.#lastAssistant();
						return end;
					}
					const messages = await this.#rpc(live => live.client.getMessages());
					const users = messages.filter(m => isRecord(m) && m.role === "user");
					if (this.#promptDelivered(messages, stripReminders(messageText(users.at(-1))), turn)) {
						rt.last = assistantEnd(messages.findLast(m => isRecord(m) && m.role === "assistant"));
						return { kind: "result", result: undefined };
					}
				} else if (!settled) {
					// The prompt was requeued: whatever omp still runs belongs to the lost attempt.
					this.#abortingStale = true;
					try {
						await abortAfterDenying(
							() => this.#denyApprovals(rt, ANSWERED_BY_DROPPED),
							() => this.#rpc(live => live.client.abort()),
						).catch(() => {});
						await this.#waitSettled();
					} finally {
						this.#abortingStale = false;
					}
					if (this.#disposed) return { kind: "disposed" };
				}
			}
			if (turn.stopRequested) return { kind: "stopped" };
			// A thread or day already at its cap: the turn fails at once, omp is never prompted.
			const overCap = checkSpend(this.env, rt.thread, 0, "before");
			if (overCap !== null) {
				rt.capHit = overCap;
				return { kind: "stopped" };
			}
			rt.sent = true;
			try {
				store.markPromptSent(this.id, turn.id);
			} catch (error) {
				if (error instanceof StoreError && (error.code === "thread_not_found" || error.code === "turn_not_running")) {
					return { kind: "disposed" };
				}
				throw error;
			}
			try {
				rt.promptId = await this.#current().client.prompt(this.#promptText(turn));
			} catch (error) {
				if (error instanceof RpcCommandError) return { kind: "rejected", message: error.message };
				return { kind: "exited", reason: describe(error) };
			}
			this.#evaluate(rt);
			void this.#flushIrc(rt);
			// A stop that arrived while the prompt was on its way had nothing to abort yet.
			if (this.#turnNow(rt.turn.id)?.stopRequested === true) {
				rt.stopRequested = true;
				await this.#abort(rt, ANSWERED_BY_STOP);
			}
			return await rt.ended;
		} catch (error) {
			if (this.#disposed) return { kind: "disposed" };
			if (error instanceof VmLostError) return { kind: "lost" };
			return { kind: "exited", reason: describe(error) };
		}
	}

	/** Waits (up to a minute) until omp has nothing running or queued. */
	async #waitSettled(): Promise<void> {
		for (let i = 0; i < 30 && !this.#disposed; i++) {
			const state = await this.#rpc(live => live.client.getState());
			if (state.isSettled && !state.isStreaming) return;
			await this.#sleep(2000);
		}
		if (!this.#disposed) throw new Error("omp did not settle within a minute");
	}

	/** Re-evaluates whether the turn is over; called by every frame that can end it. */
	#evaluate(rt: RunningTurn): void {
		if (rt.finished) return;
		if (this.#disposed) return rt.finish({ kind: "disposed" });
		if (this.#live?.exited === true) return rt.finish({ kind: "exited", reason: "omp exited" });
		if (rt.observing) {
			if (rt.sawSettled || rt.polledSettled) rt.finish({ kind: "result", result: undefined });
			return;
		}
		if (rt.promptId === undefined) return;
		// A built-in command was run: omp answered the prompt with `agentInvoked: false`. It is over once omp is quiet again (`#awaitLocalQuiet`).
		if (rt.localAcks.has(rt.promptId)) {
			if (rt.localQuiet) rt.finish({ kind: "result", result: rt.results.find(r => r.id === rt.promptId) });
			return;
		}
		const result = rt.results.find(r => r.id === rt.promptId);
		if (result !== undefined && (result.sessionSettled || rt.sawSettled || rt.aborting)) {
			return rt.finish({ kind: "result", result });
		}
		if (rt.polledSettled) rt.finish({ kind: "result", result });
	}

	/** A lost-frame fallback: omp says it is settled although no settle frame arrived. */
	async #poll(rt: RunningTurn): Promise<void> {
		if (rt.finished || this.#live === null || this.#live.exited) return;
		try {
			this.#noteState(rt, await this.#rpc(live => live.client.getState()));
		} catch (error) {
			// An omp that died is reported by its exit; one that stays unreachable after a reconnect is as good as dead.
			if (!(error instanceof RpcCommandError) && !this.#disposed) this.#unreachable(rt, error);
		}
		this.#evaluate(rt);
	}

	/**
	 * After a built-in command answered `agentInvoked: false`: it may go on in the background (`/compact`, `/handoff`, a bare
	 * `/rename` run after the answer), and its output still belongs to this turn. Asks omp every `LOCAL_POLL_MS` and ends the turn
	 * once two readings in a row show it settled, idle and not compacting (two, because a background task may start just after the answer).
	 */
	async #awaitLocalQuiet(rt: RunningTurn): Promise<void> {
		let quiet = 0;
		while (!rt.finished && !this.#disposed && this.#live !== null && !this.#live.exited) {
			try {
				const state = await this.#rpc(live => live.client.getState());
				this.#noteContext(rt, state);
				quiet = state.isSettled && !state.isStreaming && !state.isCompacting ? quiet + 1 : 0;
			} catch (error) {
				// An omp that died is reported by its exit; one that stays unreachable after a reconnect is as good as dead.
				if (!(error instanceof RpcCommandError) && !this.#disposed) this.#unreachable(rt, error);
				return;
			}
			if (quiet >= 2) {
				rt.localQuiet = true;
				this.#evaluate(rt);
				return;
			}
			await Bun.sleep(LOCAL_POLL_MS);
		}
	}

	/** Restores a dropped stream (vmon may have paused the VM) without waiting for the next poll. */
	async #watch(rt: RunningTurn): Promise<void> {
		const live = this.#live;
		if (rt.finished || live === null || live.exited || live.proc.detachedBy === undefined || this.#disposed) return;
		try {
			await this.#resync();
			this.#noteState(rt, await this.#rpc(l => l.client.getState()));
		} catch (error) {
			this.#unreachable(rt, error);
		}
		this.#evaluate(rt);
	}

	#noteState(rt: RunningTurn, state: RpcSessionState): void {
		const idle = state.isSettled && !state.isStreaming;
		if (idle) this.#children.settled();
		if (idle && (rt.sent || rt.observing)) rt.polledSettled = true;
		this.#noteContext(rt, state);
	}

	/** Keeps the context use omp reports in `get_state`'s `contextUsage` (tokens and the model's window; read on every poll and at the turn's end): the thread's latest, and the turn's at its end. An absent or unusable reading changes nothing. */
	#noteContext(rt: RunningTurn, state: RpcSessionState): void {
		const usage = state.contextUsage;
		if (usage === undefined || !Number.isFinite(usage.tokens) || usage.tokens < 0) return;
		const window = Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? Math.round(usage.contextWindow) : 0;
		rt.context = { tokens: Math.round(usage.tokens), window };
		if (window > 0) this.#contextWindow = window;
		this.env.store.setThreadContext(this.id, { ...rt.context, at: new Date().toISOString() });
	}

	/** Reads the context use at the end of the turn; omp being unreachable only loses the reading. */
	async #refreshContext(rt: RunningTurn): Promise<void> {
		if (this.#live === null) return;
		try {
			this.#noteContext(rt, await this.#rpc(live => live.client.getState()));
		} catch {
			// the last reading of a poll stands
		}
	}

	/** The VM could not be reached again: lost for good, or end the turn so that it is requeued and recovered. */
	#unreachable(rt: RunningTurn, error: unknown): void {
		if (error instanceof VmLostError) rt.finish({ kind: "lost" });
		else rt.finish({ kind: "exited", reason: `the VM is not reachable: ${describe(error)}` });
	}

	#current(): Live {
		if (this.#live === null) throw new Error("omp is not attached");
		return this.#live;
	}

	/**
	 * Runs an RPC call on the current omp. A transport failure (the stream dropped, a write to a paused sandbox failed,
	 * the call timed out) reconnects to the sandbox, re-attaches and tries once more; an error answer of omp is thrown as is.
	 */
	async #rpc<T>(call: (live: Live) => Promise<T>): Promise<T> {
		const live = this.#current();
		try {
			return await call(live);
		} catch (error) {
			if (error instanceof RpcCommandError || live.exited || this.#disposed) throw error;
			return await call(await this.#resync());
		}
	}

	/** Reconnects to a sandbox the stream to omp was lost on and re-attaches to the same omp. Concurrent callers share one attempt. */
	#resync(): Promise<Live> {
		this.#resyncing ??= this.#doResync().finally(() => {
			this.#resyncing = null;
		});
		return this.#resyncing;
	}

	/**
	 * `vmon.connect` (resumes a sandbox vmon paused), then a new stream and client on the same omp process: a failed write
	 * leaves the old client stopped for good. Output produced while the stream was down is lost (vmon keeps no replay
	 * buffer), which is why the turn is marked `eventsLost` and its reply is read back with `get_messages`: omp's own
	 * session is the transcript of record, never the stream.
	 */
	async #doResync(): Promise<Live> {
		const { store } = this.env;
		const record = store.vm(this.id);
		const old = this.#live;
		const pid = record?.pid ?? old?.proc.pid ?? null;
		if (record === null || pid === null) throw new Error("the VM record is gone");
		// First: a kill the broken client started would otherwise land on the omp we are about to adopt.
		if (old !== null) this.#dropLive(old);
		await this.#reconnect(record, null);
		const sandbox = this.#sandbox;
		if (sandbox === null) throw new Error("the sandbox is gone");
		if (!(await ompAlive(sandbox, pid))) throw new Error("omp is gone");
		const proc = await OmpProcess.adopt(sandbox, pid, frame => this.#onFrame(frame));
		const client = new RpcClient({ spawn: () => proc, args: [] });
		await this.#startClient(client);
		const live = this.#attach(proc, client);
		await this.#configure(live, store.vm(this.id) ?? record);
		const rt = this.#running;
		if (rt !== null) rt.eventsLost = true;
		this.#event("notice", "lost the connection to the VM; reconnected", rt?.turn.id ?? null);
		return live;
	}

	/**
	 * Aborts omp's turn: every open approval is answered `Deny` first (recorded as answered by `by`), because omp's
	 * `abort` blocks its command loop until they are, and only then is the abort sent.
	 */
	async #abort(rt: RunningTurn, by: string): Promise<void> {
		rt.aborting = true;
		try {
			await abortAfterDenying(
				() => this.#denyApprovals(rt, by),
				async () => {
					if (this.#live !== null) await this.#rpc(live => live.client.abort());
				},
			);
		} catch (error) {
			// omp is gone or already idle; when the reconnect failed for good the turn would never end.
			if (this.#live === null || error instanceof VmLostError) this.#unreachable(rt, error);
		}
		this.#evaluate(rt);
	}

	#sleep(ms: number): Promise<void> {
		return new Promise(resolve => {
			const done = (): void => {
				clearTimeout(timer);
				this.#sleeper = null;
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.#sleeper = done;
		});
	}

	async #lastReply(): Promise<string> {
		try {
			return (await this.#rpc(live => live.client.getLastAssistantText())) ?? "";
		} catch {
			return "";
		}
	}

	async #lastAssistant(): Promise<AssistantEnd | null> {
		try {
			return assistantEnd((await this.#rpc(live => live.client.getMessages())).findLast(m => isRecord(m) && m.role === "assistant"));
		} catch {
			return null;
		}
	}

	/** The push step of the turn (`push.ts`); null when the runner went away while it waited for the owner's answer. */
	async #push(rt: RunningTurn, thread: Thread, turn: Turn, outcome: TurnOutcome, head: string, reply: string): Promise<PushRecord | null> {
		const { store, config, github, githubApi } = this.env;
		rt.push = new PushStep(
			{
				store,
				git: this.env.git,
				settings: this.env.settings,
				pulls: github.connected() ? pullRequestsOf(github, githubApi) : null,
				github,
				secrets: target => threadMaskEntries(store, this.env.secrets, target),
				questionTimeoutSeconds: config.runner.questionTimeoutSeconds,
				clock: rt.clock,
				event: (text, kind = "push") => this.#event(kind, text, turn.id),
			},
			thread,
			turn,
		);
		const record = await rt.push.run({ outcome: outcome.outcome, stopped: rt.stopRequested, head, reply });
		rt.push = null;
		return record;
	}

	/** Commits what the turn left in the workspace and stores the result bundle. Failures become a notice, never a failed turn. */
	async #finalizeGit(
		thread: Thread,
		turn: Turn,
		reply: string,
	): Promise<{ head: string; filesChanged: number; insertions: number; deletions: number }> {
		const none = { head: "", filesChanged: 0, insertions: 0, deletions: 0 };
		const sandbox = this.#sandbox;
		if (sandbox === null) return none;
		try {
			const uploadedHead = this.env.store.threadStats(this.id).resultTurn?.head ?? "";
			const git = await this.#saveResult(sandbox, thread, titleFromReply(reply) || `omp-cloud: turn ${turn.id}`, uploadedHead, turn.id);
			return { head: git.head, filesChanged: git.filesChanged, insertions: git.insertions, deletions: git.deletions };
		} catch (error) {
			if (!isMissingThread(error)) this.#event("notice", `the result could not be saved: ${describe(error)}`, turn.id);
			return none;
		}
	}

	/**
	 * Commits the workspace changes (as `message`, only when there are any), moves the thread branch onto them and stores the
	 * result bundle unless the branch is still at `uploadedHead`, the head the stored bundle already holds. With `git.sign`
	 * `ssh` the new commits are then re-signed and the VM adopts them (`#signResult`). Never pushes. Throws when git or the
	 * transfer fails.
	 */
	async #saveResult(sandbox: Sandbox, thread: Thread, message: string, uploadedHead: string, turnId: number | null): Promise<TurnGit> {
		const exec = sandboxExec(sandbox);
		const git = await finalizeTurn(exec, {
			workspace: VM_WORKSPACE,
			branch: RESULT_BRANCH_PREFIX + this.id,
			baseCommit: thread.repo.baseCommit,
			message,
			uploadedHead,
			bundlePath: BUNDLE_PATH,
		});
		if (git.bundlePath === null) return git;
		await downloadBlob(sandbox, git.bundlePath, this.env.store, this.id, "result.bundle", MAX_SOURCE_BYTES);
		await exec(`rm -f ${shellQuote(git.bundlePath)}`).catch(() => undefined);
		return this.#signResult(sandbox, thread, git, uploadedHead, turnId);
	}

	/**
	 * Signs the commits of the turn's stored result bundle when `git.sign` is `ssh`. The service rewrites them, the VM
	 * adopts the signed tip, and only then does the stored `result.bundle` change, so the stored bundle and the recorded head
	 * always agree. Any failure before that leaves the unsigned bundle and head standing, with a notice.
	 */
	async #signResult(sandbox: Sandbox, thread: Thread, git: TurnGit, uploadedHead: string, turnId: number | null): Promise<TurnGit> {
		const { store, settings, signingKey, github } = this.env;
		if (settings.get("git.sign") !== "ssh") return git;
		if (!signingKey.exists()) {
			this.#event("notice", "git.sign is ssh but the service has no signing key: create it on the dashboard's GitHub page", turnId);
			return git;
		}
		const exec = sandboxExec(sandbox);
		const branch = RESULT_BRANCH_PREFIX + this.id;
		let signed: SignedResult | null = null;
		try {
			signed = await this.env.git.signResult(this.id, {
				remoteURL: thread.repo.remoteURL,
				baseCommit: thread.repo.baseCommit,
				handoffCommit: thread.repo.handoffCommit,
				uploadedHead,
				sourceBundle: (await store.blob(this.id, "source.bundle")) === null ? null : store.blobPath(this.id, "source.bundle"),
				resultBundle: store.blobPath(this.id, "result.bundle"),
				branch,
				head: git.head,
				privatePem: signingKey.privatePem() ?? "",
				committer: effectiveCommitter(settings.get("git.committer"), github),
			});
			if (signed === null) return git;
			await uploadBlob(sandbox, Bun.file(signed.bundlePath), SIGNED_BUNDLE_PATH);
			try {
				await adoptSigned(exec, { workspace: VM_WORKSPACE, bundlePath: SIGNED_BUNDLE_PATH, branch, head: signed.head });
			} finally {
				await exec(`rm -f ${shellQuote(SIGNED_BUNDLE_PATH)}`).catch(() => undefined);
			}
			await store.putBlob(this.id, "result.bundle", Bun.file(signed.bundlePath).stream(), MAX_SOURCE_BYTES);
			this.#event("sign", `signed ${signed.rewritten} commit${signed.rewritten === 1 ? "" : "s"} with ${signingKey.fingerprint() ?? "the signing key"}`, turnId);
			return { ...git, head: signed.head };
		} catch (error) {
			if (isMissingThread(error)) throw error;
			this.#event("notice", `the commits were not signed: ${describe(error)}`, turnId);
			return git;
		} finally {
			await signed?.dispose();
		}
	}

	/**
	 * Packs the VM's session (the conversation it continued plus this thread's turns) under the thread's export id and stores
	 * it as `session-export.tar`, replacing the previous export. Failures become a notice, never a failed turn.
	 */
	async #exportConversation(turn: Turn): Promise<void> {
		const sandbox = this.#sandbox;
		if (sandbox === null) return;
		try {
			// omp may persist its session only after the first turn, so ask it before trusting the record.
			const reported = (await this.#rpc(live => live.client.getState())).sessionFile;
			await this.#packConversation(sandbox, reported);
		} catch (error) {
			if (!isMissingThread(error)) this.#event("notice", `the conversation could not be exported: ${describe(error)}`, turn.id);
		}
	}

	/** The export itself: the session file omp `reported`, else the one the VM record holds; nothing to pack for a thread without one. Throws when packing or the transfer fails. */
	async #packConversation(sandbox: Sandbox, reported: string | null | undefined): Promise<void> {
		const { store } = this.env;
		const record = store.vm(this.id);
		const sessionFile = reported ?? record?.sessionFile ?? null;
		if (sessionFile === null) return;
		if (record !== null && record.sessionFile !== sessionFile) store.putVm({ ...record, sessionFile });
		const exec = sandboxExec(sandbox);
		await exportSession(exec, { sessionFile, exportId: exportSessionId(this.id), outPath: EXPORT_PATH });
		await downloadBlob(sandbox, EXPORT_PATH, store, this.id, "session-export.tar", MAX_SOURCE_BYTES);
		await exec(`rm -f ${shellQuote(EXPORT_PATH)}`).catch(() => undefined);
	}

	/** After a turn: re-attach to drop the SDK's buffered output once enough piled up. */
	async #dropBuffer(): Promise<void> {
		const sandbox = this.#sandbox;
		const live = this.#live;
		if (sandbox === null || live === null || live.proc.bytesSinceAttach <= REATTACH_BYTES) return;
		try {
			if ((await live.client.getState()).isSettled) await live.proc.reattach(sandbox);
		} catch (error) {
			console.error(`omp-cloud: re-attaching to omp of thread ${this.id} failed: ${describe(error)}`);
		}
	}

	/** omp died during the turn: requeue it once (the restart resumes the session), then give up. */
	async #died(live: Live, reason: string): Promise<boolean> {
		const stderr = live.proc.peekStderr().trim().slice(-500);
		if (this.#live !== null) this.#dropLive(this.#live);
		this.#children.cancel(`omp exited (${reason})`);
		this.#deaths++;
		if (this.#deaths >= 2) {
			await this.#fail(`omp keeps exiting: ${stderr === "" ? reason : stderr}`);
			return false;
		}
		this.env.store.requeueRunningTurn(this.id);
		this.#event("notice", `omp exited (${reason}); restarting it`, null);
		return true;
	}

	/**
	 * The VM was lost and `loseVm` released it and requeued the turn: the loop restores the thread on a new VM. Fails the
	 * thread after `MAX_RESTORES` in a row. False when the loop must end.
	 */
	async #restored(): Promise<boolean> {
		if (this.#disposed) return false;
		this.#restores++;
		if (this.#restores > MAX_RESTORES) {
			await this.#fail("the VM was lost again and could not be restored");
			return false;
		}
		return true;
	}

	// ---- the VM and omp

	/**
	 * Makes sure the sandbox runs and omp is attached. Null when the thread failed or the runner stops; "retry" when the
	 * turn was requeued and the loop must come back at once (the VM was lost and is restored on a new one) or after a
	 * backoff (an existing VM could not be reached). Only creating and provisioning a VM can fail the thread at once.
	 */
	async #ensureOmp(thread: Thread, turnId: number): Promise<Prepared | "retry" | null> {
		const entry = this.env.store.vm(this.id);
		const existingVm = entry !== null && entry.pid !== null;
		try {
			const prepared = await this.#prepare(thread, turnId);
			if (prepared !== null) this.#vmFailures = 0;
			return prepared;
		} catch (error) {
			if (this.#disposed) return null;
			if (error instanceof VmLostError) return (await this.#restored()) ? "retry" : null;
			if (!existingVm) {
				await this.#fail(`could not prepare the VM: ${describe(error)}`);
				return null;
			}
			return await this.#retryLater(error);
		}
	}

	/** An existing VM does not answer: requeue the turn, say so, wait, and let the loop try again; give up after the last backoff. */
	async #retryLater(error: unknown): Promise<"retry" | null> {
		const message = describe(error);
		this.#vmFailures++;
		const delay = RETRY_DELAYS_S[this.#vmFailures - 1];
		if (delay === undefined) {
			await this.#fail(`the VM stopped responding: ${message}`);
			return null;
		}
		try {
			this.env.store.requeueRunningTurn(this.id);
		} catch (requeueError) {
			if (isMissingThread(requeueError)) return null;
			throw requeueError;
		}
		this.#event("notice", `the VM is not reachable (${message}); retrying in ${delay}s`, null);
		if (this.#live !== null) this.#dropLive(this.#live);
		await this.#sleep(delay * 1000);
		return "retry";
	}

	/**
	 * Brings the thread's omp to a state that can run a turn, from the cheapest recovery that works: the process is alive
	 * (reattach or adopt it); the disk survived but the process did not (a resume that cannot restore memory, for example
	 * on another CPU baseline, boots the root filesystem only: restart omp with `--resume <session file>`); the VM is gone
	 * (`loseVm`, then a new VM restored from the last result bundle and conversation export). vmon loses a running sandbox
	 * with its node (state `orphaned`) and moves paused state between nodes only with an object store.
	 */
	async #prepare(thread: Thread, turnId: number): Promise<Prepared | null> {
		const { store, config } = this.env;
		const ttlMs = config.runner.sandboxTimeoutSeconds * 1000;
		let record = store.vm(this.id);
		this.#loadChildren();
		let resumed = false;
		// A record that never got an omp pid is a creation a crash cut off: start over.
		if (record !== null && record.pid === null) {
			await releaseVm(this.env, this.id, true);
			this.#sandbox = null;
			record = null;
		}
		if (record === null) {
			record = await this.#createVm(thread, turnId);
		} else if (record.state === "paused" || this.#sandbox === null) {
			await this.#reconnect(record, turnId);
			resumed = true;
		} else {
			try {
				await this.#sandbox.setTimeout(ttlMs);
			} catch {
				// `setTimeout` fails (404) on a paused sandbox: it expired and vmon paused it
				await this.#reconnect(record, turnId);
				resumed = true;
			}
		}
		if (this.#disposed) return null;

		const existing = this.#live;
		if (existing !== null && !existing.exited) {
			const alive = await this.#onSandbox(record, turnId, sandbox => ompAlive(sandbox, existing.proc.pid));
			if (alive) {
				if (resumed || existing.proc.detachedBy !== undefined) {
					await this.#onSandbox(record, turnId, sandbox => existing.proc.reattach(sandbox));
				}
				return "existing";
			}
		}
		if (existing !== null) this.#dropLive(existing);
		record = store.vm(this.id) ?? record;
		const pid = record.pid;
		if (pid !== null && (await this.#onSandbox(record, turnId, sandbox => ompAlive(sandbox, pid)))) {
			const proc = await this.#onSandbox(record, turnId, sandbox => OmpProcess.adopt(sandbox, pid, frame => this.#onFrame(frame)));
			const client = new RpcClient({ spawn: () => proc, args: [] });
			await this.#startClient(client);
			await this.#configure(this.#attach(proc, client), record);
			return "adopted";
		}
		await this.#startOmp(thread, record, turnId);
		return "fresh";
	}

	/** Runs `op` on the sandbox; when it fails, reconnects through vmon (a paused or expired sandbox needs it) and tries once more. */
	async #onSandbox<T>(record: VmRecord, turnId: number, op: (sandbox: Sandbox) => Promise<T>): Promise<T> {
		const sandbox = this.#sandbox;
		if (sandbox === null) throw new Error("the sandbox is gone");
		try {
			return await op(sandbox);
		} catch (error) {
			if (this.#disposed) throw error;
			await this.#reconnect(this.env.store.vm(this.id) ?? record, turnId);
			const fresh = this.#sandbox;
			if (fresh === null) throw error;
			return await op(fresh);
		}
	}

	/**
	 * Creates the sandbox from the thread's omp version's template (building it first if needed) or, when the thread's
	 * repository has a `setup`, from its cached environment (built first for the thread's first VM), registers the
	 * gateway client and provisions the VM. Leaves omp to the caller.
	 */
	async #createVm(thread: Thread, turnId: number): Promise<VmRecord> {
		const { store, vmon, gateway, models, config, serviceId } = this.env;
		const version = thread.ompVersion || this.env.ompVersion;
		const template = await vmon.ensureTemplate(version, recipeOf(this.env.settings), () => this.#event("vm", `building the omp ${version} VM template`, turnId));
		const policy = effectivePolicy(this.env.settings, thread.policy);
		const network = egressNetwork(config.gateway.url, policy.egress);
		const metadata = { app: "omp-cloud", service: serviceId, thread: this.id, owner: thread.owner };
		const timeoutMs = config.runner.sandboxTimeoutSeconds * 1000;
		const { env: serviceEnv, failures } = await this.env.secrets.resolveForThread(thread);
		for (const failure of failures) this.#event("notice", failure, turnId);
		const environment =
			thread.setup === null
				? null
				: await prepareEnvironment(
						{ store, vmon, git: this.env.git, serviceId, sandboxTimeoutMs: timeoutMs },
						{
							thread,
							setup: thread.setup,
							template,
							network,
							secrets: serviceEnv,
							mayBuild: thread.archivedAt === null && store.threadStats(thread.id).resultTurn === null,
							emit: text => this.#event("vm", text, turnId),
							warn: text => this.#event("notice", text, turnId),
						},
					);
		let sandbox: Sandbox;
		try {
			sandbox = await vmon.create(environment?.snapshotId ?? template, metadata, timeoutMs, network);
		} catch (error) {
			if (environment === null) throw error;
			// The snapshot is gone from vmon (deleted outside the service, or vmon was reset): forget it and start from the template.
			store.deleteEnvironment(environment.key);
			this.#event("notice", `the cached environment ${environment.name} could not start (${describe(error)}); using the template`, turnId);
			sandbox = await vmon.create(template, metadata, timeoutMs, network);
		}
		this.#sandbox = sandbox;
		const record = store.putVm({ threadId: this.id, sandboxId: sandbox.sandboxId, state: "running", pid: null, sessionFile: null });
		this.#event("vm", `sandbox ${sandbox.sandboxId} created`, turnId);
		if (thread.archivedAt !== null) this.#event("vm", "restoring from the archive", turnId);
		const token = await gateway.issue(clientName(serviceId, this.id));
		const served = models.providers();
		const provisioned = await provisionVm(sandbox, {
			thread,
			store,
			git: this.env.git,
			gatewayUrl: config.gateway.url,
			token,
			models: config.models,
			served,
			questionTimeoutSeconds: config.runner.questionTimeoutSeconds,
			policy,
			serviceEnv,
			mcpListen: this.env.mcpListen ?? null,
		});
		if (provisioned.envNames.length > 0) this.#event("vm", `secret env: ${provisioned.envNames.join(", ")}`, turnId);
		for (const name of provisioned.mcpSkipped) this.#event("notice", `MCP server ${name} was not delivered: the service has no MCP proxy`, turnId);
		if (provisioned.mcpNames.length > 0) this.#event("vm", `MCP servers: ${provisioned.mcpNames.join(", ")}`, turnId);
		if (served.length > 0) await gateway.waitAccepted(token, 30_000);
		// A conversation unpacked into the VM is the session omp resumes, also when omp has to restart before it reports its own.
		const resume = provisioned.extraArgs.indexOf("--resume");
		const sessionFile = resume < 0 ? null : (provisioned.extraArgs[resume + 1] ?? null);
		return sessionFile === null ? record : store.putVm({ ...record, sessionFile });
	}

	/** Resumes a paused sandbox (or extends a running one). Throws `VmLostError` when vmon no longer has it. */
	async #reconnect(record: VmRecord, turnId: number | null): Promise<void> {
		const { store, vmon, config } = this.env;
		const sandbox = await vmon.connect(record.sandboxId, config.runner.sandboxTimeoutSeconds * 1000);
		if (sandbox === null) {
			this.#sandbox = null;
			if (this.#live !== null) this.#dropLive(this.#live);
			this.#children.cancel("the VM was lost");
			await loseVm(this.env, this.id);
			// loseVm requeued the running turn: nothing will report that omp is gone, so end the wait here.
			this.#running?.finish({ kind: "lost" });
			throw new VmLostError();
		}
		this.#sandbox = sandbox;
		if (record.state !== "running") {
			store.putVm({ ...record, state: "running" });
			this.#event("vm", "resumed", turnId);
		}
		// A VM that was paused holds connections nothing can trust any more, also on an unchanged address: its old /30 may have been
		// taken by a sandbox that was killed since, and that sandbox's host-side proxy socket (same 4-tuple: clones pick the same ports)
		// answers them. Drop them all so the next request opens a new one. A running VM only loses the sockets of a changed address.
		const wasPaused = record.state !== "running";
		const dropped = await dropStaleSockets(sandbox, wasPaused);
		if (dropped.length > 0) {
			this.#event("vm", wasPaused ? `dropped the connections the paused VM held from ${dropped.join(", ")}` : `the sandbox's address changed: dropped its connections from ${dropped.join(", ")}`, turnId);
		}
	}

	async #startOmp(thread: Thread, record: VmRecord, turnId: number): Promise<void> {
		const { config } = this.env;
		const sandbox = this.#sandbox;
		if (sandbox === null) throw new Error("the sandbox is gone");
		// A new omp process knows none of the approvals an earlier one was waiting on.
		this.#pending.clear();
		this.#children.cancel("omp was restarted, which ended its jobs");
		// A VM provisioned before the IRC extension existed has no file for `-e` to load.
		if (!(await sandbox.files.exists(VM_IRC_EXTENSION))) await shipIrcExtension(sandbox, thread);
		const extraArgs = ompLaunchArgs(thread, config.models, record.sessionFile);
		const started: { proc?: OmpProcess } = {};
		const client = new RpcClient({
			spawn: async agentArgs => {
				started.proc = await OmpProcess.start(sandbox, agentArgs, { cwd: VM_WORKSPACE, extraArgs }, frame => this.#onFrame(frame));
				return started.proc;
			},
			args: [],
		});
		try {
			await this.#startClient(client);
			if (started.proc === undefined) throw new Error("omp did not start");
		} catch (error) {
			started.proc?.terminate();
			throw error;
		}
		const live = this.#attach(started.proc, client);
		await this.#configure(live, record);
		this.#event("vm", record.pid === null ? `omp started (pid ${live.proc.pid})` : "omp restarted", turnId);
	}

	/** `client.start()` with a limit. A client that does not answer in time is abandoned, never awaited: its reap could hang too. */
	async #startClient(client: RpcClient): Promise<void> {
		let timer: Timer | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("omp did not answer within a minute")), CLIENT_START_MS);
		});
		try {
			await Promise.race([client.start(), timeout]);
		} catch (error) {
			void client.stop().catch(() => {});
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Wires the omp process to this runner. */
	#attach(proc: OmpProcess, client: RpcClient): Live {
		const live: Live = { proc, client, exited: false, irc: false, listeners: [] };
		live.listeners.push(
			client.onSessionEvent(event => this.#onSessionEvent(live, event)),
			client.onPromptResult(frame => {
				const rt = this.#running;
				if (this.#live !== live || rt === null) return;
				rt.results.push(frame);
				this.#evaluate(rt);
			}),
			client.onSessionSettled(() => {
				const rt = this.#running;
				if (this.#live !== live || rt === null || !(rt.sent || rt.observing)) return;
				rt.sawSettled = true;
				this.#evaluate(rt);
			}),
			client.onSessionSettled(() => {
				if (this.#live === live) this.#children.settled();
			}),
			client.onSubagentLifecycle(payload => {
				if (this.#live === live) this.#children.lifecycle(this.#childTurn(), payload);
			}),
			client.onSubagentProgress(payload => {
				if (this.#live === live) this.#children.progress(payload);
			}),
		);
		void proc.exited.then(() => {
			live.exited = true;
			if (this.#live === live && this.#running !== null) this.#evaluate(this.#running);
		});
		this.#live = live;
		return live;
	}

	/**
	 * Opts in to `ask` dialogs (once per omp process; without it omp falls back to plain `select` requests), records the pid and session file
	 * and finds out whether the VM's omp has the IRC extension.
	 */
	async #configure(live: Live, record: VmRecord): Promise<void> {
		await live.proc.sendFrame({ id: SET_ASK_DIALOG_ID, type: "set_ask_dialog", enabled: true });
		// Without `delta`, omp 18.12.2 sends the whole accumulated message twice in every `message_update`, which the SDK buffers until the next reattach.
		await live.proc.sendFrame({ id: SET_EVENT_FILTER_ID, type: "set_event_filter", events: null, messageUpdates: "delta" });
		// omp sends `subagent_lifecycle` and `subagent_progress` frames only once asked; an omp without the command answers with an error nobody reads.
		await live.proc.sendFrame({ id: SET_SUBAGENT_SUBSCRIPTION_ID, type: "set_subagent_subscription", level: "progress" });
		const state = await live.client.getState();
		const attachedWindow = state.contextUsage?.contextWindow;
		if (typeof attachedWindow === "number" && Number.isFinite(attachedWindow) && attachedWindow > 0) this.#contextWindow = Math.round(attachedWindow);
		this.env.store.putVm({
			threadId: this.id,
			sandboxId: record.sandboxId,
			state: "running",
			pid: live.proc.pid,
			sessionFile: state.sessionFile ?? record.sessionFile,
		});
		live.irc = await this.#hasIrcCommand(live);
		if (!live.irc && !this.#ircNoticed) {
			this.#ircNoticed = true;
			this.#event("notice", "the VM's omp has no IRC extension: messages from peers reach the agent as plain text and the agent cannot write to its parent", null);
		}
	}

	/** Whether the VM's omp offers `/irc-in`. An omp that does not answer in time (an old one) has not. */
	async #hasIrcCommand(live: Live): Promise<boolean> {
		let timer: Timer | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("get_available_commands timed out")), IRC_PROBE_MS);
		});
		try {
			const commands = await Promise.race([live.client.getAvailableCommands(), timeout]);
			return commands.some(command => command.name === IRC_COMMAND);
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	#release(live: Live): void {
		for (const unsubscribe of live.listeners) unsubscribe();
		live.listeners = [];
	}

	/** Forgets omp (it died, or its client broke); the process, if it still runs, is adopted again later. */
	#dropLive(live: Live): void {
		this.#release(live);
		if (this.#live === live) this.#live = null;
		void live.proc.detach().catch(() => {});
	}

	/** The turn a child that starts now belongs to: the running one, else the last that ran. */
	#childTurn(): number | null {
		return this.#running?.turn.id ?? this.#lastTurn;
	}

	/** Reads the children an earlier run of the service left open back from the thread's events. */
	#loadChildren(): void {
		if (this.#childrenLoaded) return;
		try {
			this.#children.restore(this.env.store.childEvents(this.id));
			this.#childrenLoaded = true;
		} catch (error) {
			if (!isMissingThread(error)) throw error;
		}
	}

	#onSessionEvent(live: Live, event: unknown): void {
		const rt = this.#running;
		if (this.#live !== live) return;
		this.#children.delivered(this.#childTurn(), event);
		if (rt === null) return;
		const progress = progressOf(event);
		if (progress !== null) this.#event(progress.kind, progress.text, rt.turn.id);
		if (isRecord(event) && event.type === "message_end") {
			const end = assistantEnd(event.message);
			if (end !== null) {
				rt.requests++;
				rt.usage = addUsage(rt.usage, end.usage);
				rt.last = end;
				const text = messageText(event.message).trim();
				if (text !== "") rt.lastText = text;
				// Caps read the settings live; a turn over one is aborted, and `#runTurn` fails it with the cap's text.
				if (rt.capHit === null && !rt.aborting) {
					const breach = checkSpend(this.env, rt.thread, rt.usage?.cost ?? 0, "during");
					if (breach !== null) {
						rt.capHit = breach;
						void this.#abort(rt, ANSWERED_BY_DROPPED);
					}
				}
			}
		}
		if (isRecord(event) && event.type === "tool_execution_start") {
			rt.tools++;
			if (typeof event.toolCallId === "string") rt.toolStarts.set(event.toolCallId, { ms: Date.now(), args: event.args });
		}
		const started = isRecord(event) && typeof event.toolCallId === "string" ? rt.toolStarts.get(event.toolCallId) : undefined;
		const structured = [
			usageEventOf(event, this.#contextWindow),
			toolStartEventOf(event),
			toolEndEventOf(event, started?.ms ?? null, Date.now(), started?.args),
		];
		if (isRecord(event) && event.type === "tool_execution_end" && typeof event.toolCallId === "string") rt.toolStarts.delete(event.toolCallId);
		for (const item of structured) if (item !== null) this.#event(item.kind, item.text, rt.turn.id);
		this.#children.toolEnded(rt.turn.id, event, started?.args);
	}

	// ---- idle pause

	async #pauseIfIdle(): Promise<void> {
		const { store, vmon, config } = this.env;
		if (this.#disposed) return;
		this.#loadChildren();
		let turns: Turn[];
		try {
			turns = store.turns(this.id);
		} catch (error) {
			if (isMissingThread(error)) return;
			throw error;
		}
		if (turns.some(t => t.state === "queued" || t.state === "running")) return;
		const record = store.vm(this.id);
		if (record === null || record.state !== "running") return;

		const live = this.#live;
		if (live !== null && !live.exited) {
			try {
				if (live.proc.detachedBy !== undefined && this.#sandbox !== null) await live.proc.reattach(this.#sandbox);
				if (!(await live.client.getState()).isSettled) {
					this.scheduleIdle();
					return;
				}
				this.#children.settled();
			} catch {
				// omp does not answer: nothing is running, so pausing loses nothing
			}
		}
		const sandbox = this.#sandbox ?? (await vmon.connect(record.sandboxId, config.runner.sandboxTimeoutSeconds * 1000));
		if (sandbox === null) {
			if (live !== null) this.#dropLive(live);
			this.#children.cancel("the VM was lost");
			await loseVm(this.env, this.id);
			return;
		}
		this.#sandbox = sandbox;
		await live?.proc.detach();
		let failure: string | null = null;
		try {
			if (!(await sandbox.pause())) failure = "vmon did not pause the sandbox";
		} catch (error) {
			failure = describe(error);
		}
		if (failure !== null) {
			// The VM keeps running: listen to omp again and try later, less often each time.
			if (live !== null && !live.exited) {
				try {
					await live.proc.reattach(sandbox);
				} catch (error) {
					failure += `; re-attaching to omp failed: ${describe(error)}`;
				}
			}
			this.#idleFailures++;
			this.#event("notice", `pausing the VM failed (${failure}); trying again later`, null);
			this.scheduleIdle();
			return;
		}
		this.#idleFailures = 0;
		store.putVm({ ...record, state: "paused" });
		this.#event("vm", "paused", null);
		this.#children.cancel("the VM was paused");
		this.#sandbox = null;
	}

	// ---- archive

	/** Whether the thread may be archived now: idle with nothing queued, past the cutoff, and not being deleted or stopped. */
	#archivable(cutoff: string): boolean {
		return !this.#disposed && this.#running === null && !this.#loopQueued && this.env.store.archiveCandidates(cutoff).includes(this.id);
	}

	async #archive(cutoff: string, days: number): Promise<ArchiveOutcome> {
		const { store } = this.env;
		if (Date.now() < this.#archiveRetryAt || !this.#archivable(cutoff)) return "skipped";
		const record = store.vm(this.id);
		if (record === null) return "skipped";
		this.#loadChildren();
		const wasPaused = record.state === "paused";
		try {
			try {
				await this.#reconnect(record, null);
			} catch (error) {
				// vmon no longer has the sandbox and `loseVm` released its record: nothing is left to release.
				if (error instanceof VmLostError) return "skipped";
				throw error;
			}
			const sandbox = this.#sandbox;
			const thread = store.getThread(this.id);
			if (thread === null) return "skipped";
			if (sandbox === null) throw new Error("the sandbox is gone");
			const uploadedHead = thread.restoreHead !== "" ? thread.restoreHead : (store.threadStats(this.id).resultTurn?.head ?? "");
			const saved = await this.#saveResult(sandbox, thread, ARCHIVE_COMMIT_MESSAGE, uploadedHead, null);
			await this.#packConversation(sandbox, null);
			// A message that arrived while the snapshot ran keeps the VM; the snapshot only made its bundle newer.
			if (!this.#archivable(cutoff)) {
				await this.#keepVm(wasPaused);
				return "skipped";
			}
			store.markArchived(this.id, new Date().toISOString(), saved.bundlePath === null ? "" : saved.head);
			const live = this.#live;
			this.#clearIdle();
			this.#children.cancel("the VM was released by the archive");
			await releaseVm(this.env, this.id, true);
			this.#sandbox = null;
			this.#live = null;
			if (live !== null) {
				this.#release(live);
				void live.client.stop().catch(() => {});
			}
			this.#idleFailures = 0;
			this.#event(
				"vm",
				`archived after ${days} ${days === 1 ? "day" : "days"} without activity: the VM is released; the conversation and work are kept, and the next message restores them`,
				null,
			);
			return "archived";
		} catch (error) {
			if (isMissingThread(error)) return "skipped";
			this.#archiveRetryAt = Date.now() + ARCHIVE_BACKOFF_MS;
			this.#event("notice", `archive postponed: ${describe(error)}`, null);
			await this.#keepVm(wasPaused).catch((keepError: unknown) => {
				console.error(`omp-cloud: keeping the VM of thread ${this.id} after a failed archive failed: ${describe(keepError)}`);
			});
			return "postponed";
		}
	}

	/** The archive stopped short of releasing the VM: it goes back to how it was, paused, or running with its idle timer. */
	async #keepVm(wasPaused: boolean): Promise<void> {
		if (wasPaused) await this.#pauseIfIdle();
		else this.scheduleIdle();
	}

	// ---- IRC with the thread's peers

	/** What omp is prompted with for `turn`: its text; for a turn a peer's message started, the command that makes omp deliver the message as its own incoming IRC (the message as plain text when the VM has no extension). */
	#promptText(turn: Turn): string {
		if (turn.origin !== "irc") return turn.text;
		return this.#live?.irc === true ? ircInCommand(turnMessage(turn)) : ircPlainText(turnMessage(turn));
	}

	/** Whether omp's conversation already holds what an earlier service run prompted for `turn`; `lastUserText` is its last user message. */
	#promptDelivered(messages: readonly unknown[], lastUserText: string, turn: Turn): boolean {
		return turn.origin === "irc" ? ircDelivered(messages, turnMessage(turn), lastUserText) : lastUserText === turn.text.trim();
	}

	/**
	 * Hands the messages sent into the running turn (`Store.sendIrc` answered `injected`) to omp, oldest first, once omp has the
	 * turn's prompt: each as the command that makes omp deliver it as its own incoming IRC message, which the agent reads at its
	 * next step boundary without its turn being aborted or split. It is an RPC `prompt` with no `streamingBehavior`: omp runs an
	 * extension command at once even while the agent streams, whereas `steer` and `follow_up` reject extension commands, so neither
	 * can carry it (the plain-text fallback is a steer, which queues the same
	 * way). One delivery loop runs at a time; a call while it runs makes it look again. A message that cannot be handed over
	 * stays pending: it is retried by the next call, and a turn that ends first turns it into a turn of its own (`Store.completeTurn`).
	 */
	async #flushIrc(rt: RunningTurn): Promise<void> {
		if (this.#ircFlushing) {
			this.#ircFlushAgain = true;
			return;
		}
		this.#ircFlushing = true;
		try {
			do {
				this.#ircFlushAgain = false;
				if (rt.finished || rt.aborting || this.#disposed || this.#live === null || (rt.promptId === undefined && !rt.observing)) return;
				for (const message of this.#pendingIrc(rt.turn.id)) {
					if (rt.finished || rt.aborting || this.#disposed) return;
					const live = this.#current();
					if (live.irc) await this.#rpc(l => l.client.prompt(ircInCommand(message)));
					else await this.#rpc(l => l.client.steer(ircPlainText(message)));
					this.env.store.markIrcSent(this.id, message.id);
				}
			} while (this.#ircFlushAgain);
		} catch (error) {
			if (!isMissingThread(error)) this.#event("notice", `a message for the agent could not be delivered: ${describe(error)}`, rt.turn.id);
		} finally {
			this.#ircFlushing = false;
		}
	}

	/** The messages waiting for omp in turn `turnId`; none for a thread that is gone. */
	#pendingIrc(turnId: number): IrcInbound[] {
		try {
			return this.env.store.pendingIrc(this.id, turnId);
		} catch (error) {
			if (isMissingThread(error)) return [];
			throw error;
		}
	}

	/** The extension's frame for a message the agent wrote to a peer becomes an `irc` event on the running turn; a frame already stored (omp's output was replayed) is dropped. */
	#onIrcFrame(frame: Record<string, unknown>): void {
		const message = parseIrcFrame(frame);
		if (message === null) return;
		try {
			this.env.store.appendIrcEvent(this.id, this.#running?.turn.id ?? null, message);
		} catch (error) {
			if (!isMissingThread(error)) console.error(`omp-cloud: storing an IRC message of thread ${this.id} failed: ${describe(error)}`);
		}
	}

	// ---- the ask bridge

	/** Every frame the stdout tap forwards: command output and prompt acknowledgements feed the running turn, the rest are UI requests. */
	#onFrame(frame: Record<string, unknown>): void {
		const rt = this.#running;
		switch (frame.type) {
			case "command_output":
				if (rt !== null && typeof frame.text === "string") this.#collectOutput(rt, frame.text);
				break;
			case "response":
				if (rt !== null && typeof frame.id === "string" && isRecord(frame.data) && frame.data.agentInvoked === false) {
					rt.localAcks.add(frame.id);
					void this.#awaitLocalQuiet(rt);
				}
				break;
			default:
				this.#onUi(frame);
				break;
		}
	}

	#collectOutput(rt: RunningTurn, text: string): void {
		const room = MAX_COMMAND_OUTPUT_CHARS - rt.commandOutputChars;
		if (text === "" || room <= 0) return;
		rt.commandOutput.push(text.length > room ? `${text.slice(0, room)}…` : text);
		rt.commandOutputChars += Math.min(text.length, room);
	}

	/** Every UI request of omp. Asks and tool approvals become questions; every other dialog is cancelled, nobody can answer a prompt on omp's stdout. */
	#onUi(frame: Record<string, unknown>): void {
		if (this.#disposed || typeof frame.id !== "string") return;
		switch (frame.method) {
			case "ask":
				this.#onAsk(frame);
				break;
			case "setStatus":
				this.#onIrcFrame(frame);
				break;
			case "notify":
				if (this.#running !== null && typeof frame.message === "string") this.#collectOutput(this.#running, frame.message);
				break;
			case "cancel":
				if (typeof frame.targetId === "string") this.#onCancel(frame.targetId);
				break;
			case "select":
				if (!this.#onApproval(frame)) this.#cancelDialog(frame.id);
				break;
			case "confirm":
			case "input":
			case "editor":
				this.#cancelDialog(frame.id);
				break;
			default:
				// notifications, status lines and widgets (a plain turn emits `setWidget` for omp's built-in autoresearch extension) expect no reply
				break;
		}
	}

	#cancelDialog(requestId: string): void {
		this.#send({ type: "extension_ui_response", id: requestId, cancelled: true });
	}

	/**
	 * A tool approval of omp (`select` titled `Allow tool: …`): it becomes a question for the owner, and is denied at once
	 * when nobody can be asked: no running turn, a turn being aborted, or a question the store refuses. False when `frame` is not an approval.
	 */
	#onApproval(frame: Record<string, unknown>): boolean {
		const request = parseApprovalRequest(frame);
		if (request === null) return false;
		const rt = this.#running;
		this.#pending.add(request.id);
		if (rt === null || rt.aborting || this.#abortingStale) {
			this.#pending.settle(request.id);
			this.#send(approvalReply(request.id, false));
			return true;
		}
		let ask: number;
		try {
			ask = this.env.store.askQuestions(this.id, rt.turn.id, [approvalInput(request)], request.id).ask;
		} catch (error) {
			if (!(error instanceof StoreError)) throw error;
			this.#pending.settle(request.id);
			this.#send(approvalReply(request.id, false));
			this.#event("notice", `approval of ${request.tool} not delivered, denied: ${error.message}`, rt.turn.id);
			return true;
		}
		this.#openAsk(rt, { requestId: request.id, ask, timer: undefined, approval: true }, this.env.config.runner.questionTimeoutSeconds * 1000);
		return true;
	}

	/**
	 * Answers every open approval `Deny`, closes it and expires its question as answered by `by`. omp's `abort` blocks
	 * its command loop until its open approvals are answered, so every abort path runs this first.
	 */
	#denyApprovals(rt: RunningTurn, by: string): void {
		for (const open of [...rt.asks.values()]) {
			if (!open.approval) continue;
			this.#closeAsk(rt, open);
			try {
				this.env.store.expireAsk(this.id, rt.turn.id, open.ask, APPROVAL_ABORTED, by);
			} catch (error) {
				if (!isMissingThread(error)) console.error(`omp-cloud: denying an approval of thread ${this.id} failed: ${describe(error)}`);
			}
		}
		// Also the approvals no question stands for any more (a requeued turn's): omp is still waiting on them.
		for (const id of this.#pending.drain()) this.#send(approvalReply(id, false));
	}

	#onAsk(frame: Record<string, unknown>): void {
		const { store, config } = this.env;
		const request = parseAskRequest(frame);
		if (request === null) return;
		const rt = this.#running;
		if (rt === null) {
			this.#cancelDialog(request.id);
			return;
		}
		let ask: number;
		try {
			ask = store.askQuestions(this.id, rt.turn.id, toQuestionInputs(request.questions), request.id).ask;
		} catch (error) {
			if (!(error instanceof StoreError)) throw error;
			this.#cancelDialog(request.id);
			this.#event("notice", `question not delivered: ${error.message}`, rt.turn.id);
			return;
		}
		this.#openAsk(rt, { requestId: request.id, ask, timer: undefined, approval: false }, config.runner.questionTimeoutSeconds * 1000);
	}

	/** Pauses the turn clock and starts the question timer: when it runs out the open questions expire with the "continue on your own" note, an approval with a denial. */
	#openAsk(rt: RunningTurn, open: OpenAsk, timeoutMs: number): void {
		rt.clock.pause();
		open.timer = setTimeout(() => {
			const seconds = this.env.config.runner.questionTimeoutSeconds;
			try {
				this.env.store.expireAsk(
					this.id,
					rt.turn.id,
					open.ask,
					open.approval ? approvalTimeoutAnswer(seconds) : expiredAnswer(seconds),
					ANSWERED_BY_TIMEOUT,
				);
			} catch (error) {
				if (!isMissingThread(error)) console.error(`omp-cloud: expiring a question of thread ${this.id} failed: ${describe(error)}`);
			}
		}, Math.max(timeoutMs, 0));
		rt.asks.set(open.requestId, open);
	}

	#closeAsk(rt: RunningTurn, open: OpenAsk): void {
		clearTimeout(open.timer);
		if (rt.asks.delete(open.requestId)) rt.clock.resume();
	}

	/** omp withdrew an ask (its tool call ended without an answer): close it for the user too. */
	#onCancel(targetId: string): void {
		const rt = this.#running;
		const open = rt?.asks.get(targetId);
		if (rt === null || open === undefined) return;
		this.#closeAsk(rt, open);
		try {
			this.env.store.expireAsk(this.id, rt.turn.id, open.ask, ASK_DROPPED, ANSWERED_BY_DROPPED);
		} catch (error) {
			if (!isMissingThread(error)) console.error(`omp-cloud: dropping a question of thread ${this.id} failed: ${describe(error)}`);
		}
	}

	/**
	 * After adopting omp from an earlier service run: every ask of the turn that omp may still wait on is rebuilt, grouped by
	 * ask. An answered ask gets its answer now (an approval always does: omp waits for its reply, and a stop reaches omp only
	 * as a Deny); omp ignores a reply to an id it no longer has, so re-sending is safe. An unanswered ask reopens with what is
	 * left of the question timeout, and an unanswered approval is tracked as pending, so an abort denies it.
	 */
	#rebuildAsks(rt: RunningTurn, turn: Turn): void {
		const asks = new Map<number, Question[]>();
		for (const question of turn.questions) {
			if (question.requestId === null) continue;
			const group = asks.get(question.ask);
			if (group === undefined) asks.set(question.ask, [question]);
			else group.push(question);
		}
		for (const [ask, questions] of asks) {
			const requestId = questions[0]?.requestId;
			if (requestId === undefined || requestId === null) continue;
			const approval = isApproval(questions);
			if (questions.every(q => q.answeredAt !== null)) {
				if (approval || !stoppedByUser(questions)) this.#send(answersResponse(requestId, questions));
				continue;
			}
			if (approval) this.#pending.add(requestId);
			const asked = Date.parse(questions[0]?.askedAt ?? "");
			const left = this.env.config.runner.questionTimeoutSeconds * 1000 - (Date.now() - (Number.isNaN(asked) ? Date.now() : asked));
			this.#openAsk(rt, { requestId, ask, timer: undefined, approval }, left);
		}
	}

	/** omp restarted, so the questions an earlier process asked can never be answered: close them. */
	#dropStaleAsks(turn: Turn): void {
		const stale = new Set(turn.questions.filter(q => q.requestId !== null && q.answeredAt === null).map(q => q.ask));
		for (const ask of stale) {
			try {
				this.env.store.expireAsk(this.id, turn.id, ask, ASK_DROPPED, ANSWERED_BY_DROPPED);
			} catch (error) {
				if (!isMissingThread(error)) throw error;
			}
		}
	}
}

/** A user message without the `<system-reminder>` blocks omp adds (date and cwd, prepended to the first user message of a session). */
function stripReminders(text: string): string {
	return text.replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, "").trim();
}
