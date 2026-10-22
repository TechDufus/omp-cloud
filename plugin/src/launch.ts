import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudClient, HandoffParts } from "./api";
import type { CloudConfig, Env } from "./config";
import { MAX_CONVERSATION_BYTES, packConversation, type ConversationResult } from "./conversation";
import { CloudError, toCloudError } from "./errors";
import { planExtensions } from "./extensions";
import { loginHint } from "./login";
import { generateName, type TitleGenerator } from "./naming";
import { sessionOverlays } from "./overlays";
import { refusePairingCode } from "./pairing";
import { type McpPlan, type McpSummary, planMcp } from "./mcp";
import { planMemoryBank, readMemorySettings } from "./mnemopi";
import { buildSetup, type SetupResult } from "./setup";
import { gitRaw, readAuthor, readSecretEnv, type Snapshot, takeSnapshot } from "./snapshot";
import { UserError, type Host, type HandoffRequest, type PiHost, type CreatedThread, type ScratchHandoffRequest, type ThreadOrigin, type ThreadSummary, type Whoami } from "./types";

export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Tasks of one batch. */
export const MAX_BATCH_TASKS = 8;
/** Creates in flight at once. */
export const MAX_CONCURRENT_CREATES = 4;
/** Name of a scratch thread's synthesized repository. */
export const SCRATCH_NAME = "scratch";

const POLICY_KEYS: readonly string[] = ["spend.turnUSD", "spend.threadUSD", "egress", "fetch", "webSearch", "browser"];
const REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/\S+$/;

/** Where a thread works: the cwd's repository (shipped as a bundle) or an empty repository the service makes. */
export type Workspace = "repo" | "scratch";

/** The policy a task may ask for; the service only lets it tighten its own. */
export interface TaskPolicy {
	"spend.turnUSD"?: number;
	"spend.threadUSD"?: number;
	egress?: string[];
	fetch?: boolean;
	webSearch?: boolean;
	browser?: boolean;
}

/** One task of a handoff. */
export interface LaunchTask {
	task: string;
	/** At most 60 characters; omitted, omp's title generator names the thread. */
	name?: string;
	/** The caller's reference, `[A-Za-z0-9._-]{1,64}`; also the idempotency key of the create. */
	ref?: string;
	/** `provider/id`, optionally `:thinking`; omitted, the session's model. */
	model?: string;
	thinking?: string;
	/** Laid over the configuration's policy. The service only lets it tighten. */
	policy?: TaskPolicy;
	/** Omitted: `repo` inside a git repository, else `scratch`. */
	workspace?: Workspace;
	/** `none` ships no conversation. Default `full`. */
	conversation?: "full" | "none";
	/** `false` ships no uncommitted work. Default `true`. */
	wip?: boolean;
}

export interface LaunchProgress {
	/** The task the progress is about; `undefined` for the shared packing. */
	task: number | undefined;
	phase: "packing" | "uploading";
	/** The client's note on a retried upload (the transport cannot report bytes sent). */
	note?: string;
}

/** What a handoff shipped, for the launch card. */
export interface HandoffSummary {
	repo: { name: string; baseRef: string; localBranch: string };
	/** The thread works in an empty repository the service made; nothing of the cwd shipped. */
	scratch: boolean;
	/** The first 8 characters of the commit a delta handoff builds on; `""` when the whole history shipped. */
	base: string;
	commits: number;
	wip: { files: number; insertions: number; deletions: number };
	untracked: string[];
	untrackedTotal: number;
	withheld: string[];
	secrets: { files: number; env: number };
	conversation: "included" | "none" | "too-large";
	setupBytes: number;
	model: string;
	thinking: string;
	ompVersion: string;
	/** The session's `--config` overlays as shipped, relative to the agent dir. */
	overlays: string[];
	/** The MCP servers the handoff shipped and how the cloud agent reaches them. */
	mcp: McpSummary[];
	/** The keys of `policy` the handoff asked for. */
	policy: string[];
}

export interface LaunchBatchInput {
	host: Pick<Host, "cwd" | "model" | "modelRegistry" | "sessionManager">;
	pi: Pick<PiHost, "getThinkingLevel" | "pi">;
	cfg: CloudConfig;
	client: Pick<CloudClient, "createThread" | "whoami" | "requireCapability">;
	tasks: LaunchTask[];
	/** The host of the server when this machine is a paired device (it cannot log the server in); undefined on the owner token. */
	serverHost?: string;
	/** Prepended to every task's prompt. */
	context?: string;
	origin: ThreadOrigin;
	/** The omp session id, sent as the thread's `session`. */
	sessionId: string;
	env: Env;
	home: string;
	agentDir: string;
	/** This extension's own directory; excluded from the shipped setup. */
	ownRoot: string;
	/** Set when the local model delegated through the `cloud` tool: its pending call is cut from the uploaded conversation, and idempotency keys derive from it. */
	toolCallId?: string;
	signal?: AbortSignal;
	onProgress?: (progress: LaunchProgress) => void;
	/** A test seam: omp's title generator by default. */
	generateTitle?: TitleGenerator;
}

/** A thread a handoff created, or found again by its idempotency key. */
export interface LaunchedThread {
	ok: true;
	index: number;
	response: ThreadSummary;
	/** The idempotency key had created this thread before: nothing was created or uploaded. */
	replayed: boolean;
	workspace: Workspace;
	/** The idempotency key the create carried. */
	key: string;
	/** Local warnings (conversation too large, memory copied without a snapshot) and the service's. */
	warnings: string[];
	summary: HandoffSummary;
}

export interface LaunchFailure {
	ok: false;
	index: number;
	workspace: Workspace;
	error: CloudError;
	/** The idempotency key the failed create carried: repeating the delegation with it as `ref` replays a thread the first attempt may have made. Undefined for a task that never reached the service, or on a service without idempotency. */
	key?: string;
}

export type LaunchOutcome = LaunchedThread | LaunchFailure;

export interface LaunchBatch {
	/** Where tasks without a `workspace` went, and why. */
	defaultWorkspace: Workspace;
	outcomes: LaunchOutcome[];
}

/** `X.Y.Z` of an omp version such as `18.12.3` or `18.12.3-dev.4`; `""` when there is none, so the service uses its own. */
export function ompReleaseVersion(version: string): string {
	return /^\d+\.\d+\.\d+/.exec(version.trim())?.[0] ?? "";
}

/** Whether a `provider/*` (or exact `provider/id`) pattern admits `model`. */
export function modelServed(patterns: readonly string[], model: string): boolean {
	return patterns.some(p => p === "*" || p === model || (p.endsWith("/*") && model.startsWith(p.slice(0, -1))));
}

/** Stops a handoff whose model the cloud cannot run, before anything is packed or uploaded. */
export function assertModelServed(who: Pick<Whoami, "modelPatterns">, model: string, serverHost?: string): void {
	if (model === "" || modelServed(who.modelPatterns, model)) return;
	const provider = model.split("/")[0] ?? model;
	throw new UserError(`☁ the cloud cannot run ${provider} models yet: ${loginHint(provider, serverHost)}`);
}

function invalid(message: string, hint?: string): CloudError {
	return new CloudError({ code: "invalid", message, retriable: false, outcomeKnown: true, hint });
}

/** Any failure as a {@link CloudError}: plugin validation (`UserError`) is `invalid` (`not_configured` when no connection is set up), without the `☁` marker. */
export function asCloudError(error: unknown): CloudError {
	if (!(error instanceof UserError)) return toCloudError(error);
	const message = error.message.replace(/^☁\s*/, "");
	if (!message.startsWith("omp-cloud is not configured")) return invalid(message);
	return new CloudError({ code: "not_configured", message, retriable: false, outcomeKnown: true });
}

/** The idempotency key of task `index`: the caller's `ref`, else derived from the session and the tool call, else random. */
export function idempotencyKey(task: LaunchTask, sessionId: string, toolCallId: string | undefined, index: number): string {
	if (task.ref !== undefined) return task.ref;
	if (toolCallId === undefined) return `omp-${randomUUID()}`;
	return `omp-${createHash("sha256").update(`${sessionId}\0${toolCallId}\0${index}`).digest("hex").slice(0, 40)}`;
}

/** `repo` when `cwd` is inside a git repository that has a commit, else `scratch`. */
export async function defaultWorkspace(cwd: string): Promise<Workspace> {
	const top = await gitRaw(cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return "scratch";
	return (await gitRaw(top.stdout.trim(), ["rev-parse", "--verify", "HEAD^{commit}"])).code === 0 ? "repo" : "scratch";
}

/** `provider/id[:thinking]` split; a suffix that is not a thinking level belongs to the id. */
function splitModel(model: string): { id: string; thinking: string } {
	const colon = model.lastIndexOf(":");
	const suffix = colon > 0 ? model.slice(colon + 1) : "";
	return THINKING_LEVELS.includes(suffix) ? { id: model.slice(0, colon), thinking: suffix } : { id: model, thinking: "" };
}

const KEY_REUSED = /Idempotency-Key \S+ was used for a different request \(thread ([A-Za-z0-9]+)\)/;

/**
 * The service refuses a key that already made a thread for another request. Said in the model's terms: with its own `ref`
 * the fix is another ref; a derived key means an earlier attempt of the same call holds a different task.
 */
function keyReused(error: CloudError, plan: Plan): CloudError {
	const thread = error.status === 409 ? KEY_REUSED.exec(error.message)?.[1] : undefined;
	if (thread === undefined) return error;
	const message =
		plan.task.ref === undefined
			? `an earlier attempt of this call already made thread ${thread}, which holds a different task`
			: `ref "${plan.task.ref}" already names thread ${thread}, which has a different task; use another ref (or none)`;
	return new CloudError({ code: "conflict", status: 409, message, retriable: false, outcomeKnown: true }, { cause: error });
}

interface Plan {
	index: number;
	task: LaunchTask;
	prompt: string;
	workspace: Workspace;
	model: string;
	thinking: string;
	policy: Record<string, unknown>;
	key: string;
}

function planTask(input: LaunchBatchInput, who: Whoami, index: number, fallback: Workspace, sessionModel: string, sessionThinking: string): Plan {
	const task = input.tasks[index];
	if (!task) throw invalid(`task ${index + 1} is missing`);
	const prompt = `${input.context?.trim() ? `${input.context.trim()}\n\n` : ""}${task.task}`;
	if (task.task.trim() === "") throw invalid("a task needs text: write what the cloud agent must do");
	const limit = who.limits.maxMessageBytes;
	const bytes = Buffer.byteLength(prompt);
	if (limit > 0 && bytes > limit) {
		throw new CloudError({ code: "too_large", message: `the prompt is ${bytes} bytes (context included); the limit is ${limit}`, retriable: false, outcomeKnown: true, hint: "shorten the task or the shared context, or split it into several tasks" });
	}
	if (task.ref !== undefined && !REF_PATTERN.test(task.ref)) throw invalid(`ref "${task.ref}" must be 1-64 characters of A-Z a-z 0-9 . _ -`);
	for (const key of Object.keys(task.policy ?? {})) {
		if (!POLICY_KEYS.includes(key)) throw invalid(`policy key "${key}" is not one of ${POLICY_KEYS.join(", ")}`);
	}
	if (task.thinking !== undefined && !THINKING_LEVELS.includes(task.thinking)) throw invalid(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	let model = sessionModel;
	let thinking = task.thinking ?? sessionThinking;
	if (task.model !== undefined && task.model.trim() !== "") {
		const split = splitModel(task.model.trim());
		if (!MODEL_PATTERN.test(split.id)) throw invalid(`model "${task.model}" is not provider/id`, "cloud info lists the models the cloud can run");
		model = split.id;
		thinking = task.thinking ?? split.thinking;
	}
	assertModelServed(who, model, input.serverHost);
	const workspace = task.workspace ?? fallback;
	if (workspace === "repo" && fallback === "scratch") {
		throw invalid(`${input.host.cwd} is not a git repository with at least one commit, which workspace "repo" needs`, `use workspace "scratch" for work that is not tied to a repository`);
	}
	return {
		index,
		task,
		prompt,
		workspace,
		model,
		thinking,
		policy: { ...input.cfg.policy, ...task.policy },
		key: idempotencyKey(task, input.sessionId, input.toolCallId, index),
	};
}

/** Runs `work` for every item with at most `limit` in flight. */
async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let i = next++; i < items.length; i = next++) results[i] = await work(items[i] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** The `provider/id` of the session's model, `""` when it has none: the model `planTask` checks when a task names none. */
export function sessionModelOf(host: Pick<LaunchBatchInput["host"], "model">): string {
	return host.model ? `${host.model.provider}/${host.model.id}` : "";
}

/**
 * Snapshots the repository once (twice at most: with and without uncommitted work), packs the conversation and the omp setup
 * once, and creates one thread per task, at most {@link MAX_CONCURRENT_CREATES} at a time. Every create carries an
 * idempotency key, so a retry (the client's, or the model's with the same `ref`) finds the thread instead of making another. One
 * task failing never undoes the others: each has an outcome. Only a failure before any task could start (the service is
 * unreachable, a capability is missing, the caller aborted while packing) throws. Nothing is left in the temp dir.
 */
export async function launchBatch(input: LaunchBatchInput): Promise<LaunchBatch> {
	const { host, cfg, client, signal } = input;
	if (input.tasks.length < 1 || input.tasks.length > MAX_BATCH_TASKS) throw invalid(`a delegation takes 1 to ${MAX_BATCH_TASKS} tasks, got ${input.tasks.length}`);
	const outcomes: LaunchOutcome[] = new Array(input.tasks.length);
	const fallback = await defaultWorkspace(host.cwd);
	// A pairing code in a prompt is refused before the service is asked anything.
	let open = 0;
	for (let index = 0; index < input.tasks.length; index++) {
		try {
			refusePairingCode(`${input.context ?? ""}\n${input.tasks[index]?.task ?? ""}`);
			open++;
		} catch (e) {
			outcomes[index] = { ok: false, index, workspace: input.tasks[index]?.workspace ?? fallback, error: asCloudError(e) };
		}
	}
	if (open === 0) return { defaultWorkspace: fallback, outcomes };
	const who = await client.whoami();
	if (input.origin === "tool") {
		await client.requireCapability("threads.idempotency");
		await client.requireCapability("threads.meta");
	}
	signal?.throwIfAborted();
	const meta = who.capabilities.includes("threads.meta");
	const idempotent = who.capabilities.includes("threads.idempotency");
	// The project bank the VM will look for: a per-project bank of this machine's default mnemopi store, renamed at handoff
	// (the VM works in another directory, which omp hashes into the bank name).
	const memoryBank = who.capabilities.includes("threads.memory") ? planMemoryBank(await readMemorySettings(input.pi, input.env), host.cwd, who.vmWorkspace) : undefined;
	const sessionModel = sessionModelOf(host);
	const level = input.pi.getThinkingLevel();
	const sessionThinking = level !== undefined && THINKING_LEVELS.includes(level) ? level : "";

	const plans: Plan[] = [];
	for (let index = 0; index < input.tasks.length; index++) {
		if (outcomes[index]) continue;
		try {
			plans.push(planTask(input, who, index, fallback, sessionModel, sessionThinking));
		} catch (e) {
			outcomes[index] = { ok: false, index, workspace: input.tasks[index]?.workspace ?? fallback, error: asCloudError(e) };
		}
	}
	// A service without scratch threads refuses those tasks only.
	if (plans.some(p => p.workspace === "scratch")) {
		try {
			await client.requireCapability("threads.scratch");
		} catch (e) {
			if (!(e instanceof CloudError) || e.code !== "version_skew") throw e;
			for (const p of plans.filter(x => x.workspace === "scratch")) outcomes[p.index] = { ok: false, index: p.index, workspace: "scratch", error: e };
			plans.splice(0, plans.length, ...plans.filter(x => x.workspace !== "scratch"));
		}
	}
	if (plans.length === 0) return { defaultWorkspace: fallback, outcomes };

	const tmp = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	// Stops the naming requests when the batch ends, whichever way.
	const launch = new AbortController();
	try {
		const names = new Map<number, Promise<string>>(
			plans.map(p => [
				p.index,
				p.task.name !== undefined ? Promise.resolve(p.task.name.trim()) : generateName({ task: p.prompt, registry: host.modelRegistry, settings: input.pi.pi.settings, model: host.model, signal: launch.signal }, input.generateTitle),
			]),
		);
		input.onProgress?.({ task: undefined, phase: "packing" });

		// Snapshots go one at a time: they share the repository's `refs/omp-cloud/handoff`.
		const snapshots = new Map<string, Promise<Snapshot>>();
		let queue: Promise<unknown> = Promise.resolve();
		const snapshot = (wip: boolean, full: boolean): Promise<Snapshot> => {
			const key = `${wip ? "wip" : "head"}-${full ? "full" : "delta"}`;
			let snap = snapshots.get(key);
			if (!snap) {
				const take = async (): Promise<Snapshot> => {
					const dir = join(tmp, key);
					await mkdir(dir, { recursive: true });
					return takeSnapshot({ cwd: host.cwd, tmpDir: dir, maxBytes: who.maxUploadBytes, secretFiles: cfg.secretFiles, secretEnv: cfg.secretEnv, env: input.env, home: input.home, gitHosts: full ? [] : who.gitHosts, wip });
				};
				snap = queue.then(take, take);
				queue = snap;
				snapshots.set(key, snap);
			}
			return snap;
		};

		let conversation: Promise<ConversationResult> | undefined;
		const packed = (): Promise<ConversationResult> => {
			conversation ??= packConversation({ sessionFile: host.sessionManager.getSessionFile(), tmpDir: tmp, env: input.env, dropFromToolCall: input.toolCallId });
			return conversation;
		};

		const setups = new Map<string, Promise<SetupResult>>();
		const setupFor = (workspace: Workspace, repoRoot: string): Promise<SetupResult> => {
			const key = `${workspace}:${memoryBank?.from ?? ""}`;
			let made = setups.get(key);
			if (!made) {
				made = (async () => {
					const extensions = await planExtensions({ settings: input.pi.pi.settings, cwd: host.cwd, agentDir: input.agentDir, repoRoot, ownRoot: input.ownRoot, exclude: cfg.excludeExtensions });
					const dir = join(tmp, `setup-${workspace}`);
					await mkdir(dir, { recursive: true });
					const setup = await buildSetup({ agentDir: input.agentDir, extensions: extensions.ship, overlays: sessionOverlays(input.pi, { env: input.env }), tmpDir: dir, memoryBank });
					return { ...setup, warnings: [...extensions.warnings, ...setup.warnings] };
				})();
				setups.set(key, made);
			}
			return made;
		};

		// The same MCP servers go to every task: planned once, and its warnings are every task's.
		let mcpPlan: Promise<McpPlan> | undefined;
		const mcp = (): Promise<McpPlan> => {
			mcpPlan ??= planMcp(input.agentDir, input.env, who);
			return mcpPlan;
		};

		const ompVersion = ompReleaseVersion(input.pi.pi.VERSION);

		const create = async (plan: Plan): Promise<LaunchOutcome> => {
			const { index, task } = plan;
			try {
				signal?.throwIfAborted();
				const conv: ConversationResult = task.conversation === "none" ? { kind: "none" } : await packed();
				const wip = task.wip !== false;
				const local: string[] = [];
				if (conv.kind === "too-large") local.push(`conversation is over ${MAX_CONVERSATION_BYTES / (1024 * 1024)} MiB; the cloud agent starts without it`);
				const name = await names.get(index);
				let snap: Snapshot | undefined = plan.workspace === "repo" ? await snapshot(wip, false) : undefined;
				const made = await setupFor(plan.workspace, snap?.root ?? tmp);
				local.push(...made.warnings);
				const shippedMcp = await mcp();
				local.push(...shippedMcp.warnings);
				if (!snap && cfg.secretFiles.length > 0) local.push("secretFiles are files of a repository: none shipped to a scratch thread");
				const scratchEnv = snap ? {} : readSecretEnv(cfg.secretEnv, input.env);
				const author = snap ? snap.author : await readAuthor(host.cwd);
				const common = {
					prompt: plan.prompt,
					model: plan.model,
					thinking: plan.thinking,
					author,
					configOverlays: made.configOverlays,
					ompVersion,
					...(name ? { name } : {}),
					...(Object.keys(plan.policy).length > 0 ? { policy: plan.policy } : {}),
					...(shippedMcp.servers.length > 0 ? { mcp: shippedMcp.servers } : {}),
					...(memoryBank ? { memory: { bank: memoryBank.from } } : {}),
					...(meta ? { origin: input.origin, ...(input.sessionId !== "" ? { session: input.sessionId } : {}), ...(task.ref !== undefined ? { ref: task.ref } : {}) } : {}),
				};
				const build = (s: Snapshot | undefined): HandoffParts => {
					const conversationPath = conv.kind === "ok" ? conv.path : undefined;
					if (!s) {
						const request: ScratchHandoffRequest = { ...common, repo: { scratch: true, name: SCRATCH_NAME }, paths: { home: input.home, workspace: host.cwd }, secretFiles: [], secretEnv: scratchEnv };
						return { request, conversation: conversationPath, setup: made.path };
					}
					const request: HandoffRequest = {
						...common,
						repo: { name: s.name, remoteURL: s.remoteURL, baseRef: s.baseRef, baseCommit: s.baseCommit, handoffCommit: s.handoffCommit, localBranch: s.localBranch },
						paths: s.paths,
						secretFiles: s.secretFiles,
						secretEnv: s.secretEnv,
					};
					return { request, source: s.bundlePath ?? undefined, conversation: conversationPath, setup: made.path };
				};
				input.onProgress?.({ task: index, phase: "uploading" });
				const options = { idempotencyKey: idempotent ? plan.key : undefined, signal, onProgress: (note: string) => input.onProgress?.({ task: index, phase: "uploading", note }) };
				let sent = build(snap);
				let created: CreatedThread;
				try {
					created = await client.createThread(sent, options);
				} catch (error) {
					// The service's copy of the remote lacks the base (a force-pushed or pruned branch): ship the whole history instead.
					if (!snap || snap.baseCommit === "" || !(error instanceof CloudError) || error.status !== 409 || !error.message.includes("is not on")) throw error;
					snap = await snapshot(wip, true);
					sent = build(snap);
					created = await client.createThread(sent, options);
				}
				const summary: HandoffSummary = {
					repo: snap ? { name: snap.name, baseRef: snap.baseRef, localBranch: snap.localBranch } : { name: SCRATCH_NAME, baseRef: "", localBranch: "" },
					scratch: !snap,
					base: snap?.baseCommit.slice(0, 8) ?? "",
					commits: snap?.commits ?? 0,
					wip: snap?.wip ?? { files: 0, insertions: 0, deletions: 0 },
					untracked: snap?.untracked ?? [],
					untrackedTotal: snap?.untrackedTotal ?? 0,
					withheld: snap?.withheld ?? [],
					secrets: { files: sent.request.secretFiles.length, env: Object.keys(sent.request.secretEnv).length },
					conversation: conv.kind === "ok" ? "included" : conv.kind === "too-large" ? "too-large" : "none",
					setupBytes: made.bytes,
					model: plan.model,
					thinking: plan.thinking,
					ompVersion,
					overlays: made.configOverlays,
					mcp: shippedMcp.summary,
					policy: Object.keys(plan.policy),
				};
				return { ok: true, index, response: created.summary, replayed: created.replayed, workspace: plan.workspace, key: plan.key, warnings: [...local, ...(snap?.warnings ?? []), ...created.summary.warnings], summary };
			} catch (e) {
				const error = keyReused(asCloudError(e), plan);
				return { ok: false, index, workspace: plan.workspace, error, key: idempotent && error.code !== "conflict" ? plan.key : undefined };
			}
		};

		const created = await inPool(plans, MAX_CONCURRENT_CREATES, create);
		for (const outcome of created) outcomes[outcome.index] = outcome;
		return { defaultWorkspace: fallback, outcomes };
	} finally {
		launch.abort();
		await rm(tmp, { recursive: true, force: true });
	}
}
