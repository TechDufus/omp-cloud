/** Fakes the runner's tests share: a service environment over a temp data dir, seeded threads, a scripted sandbox and a fake vmon. */
import { CommandExitError, type Sandbox } from "e2b";
import { join } from "node:path";
import type { Config } from "../config";
import { GatewayClients } from "../gateway/clients";
import { GitService } from "../git";
import { SigningKey } from "../git/signing-key";
import { GitHubApi } from "../github/api";
import { GitHubApp } from "../github/app";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import type { NewThread } from "../store/types";
import type { SandboxSummary, Vmon } from "../vmon";
import { messageText } from "./progress";
import { DROP_STALE_SOCKETS } from "./stale-sockets";
import { clientName, type ThreadEnv } from "./thread";

/** The head every seeded thread's first turn ended at. */
export const HEAD = "a".repeat(40);
export const SESSION_FILE = "/home/user/.omp/agent/sessions/s.jsonl";
const OLD_SESSION = "0198a1c0-0000-7000-8000-000000000001";

export function testConfig(dataDir: string): Config {
	return {
		listen: { hostname: "127.0.0.1", port: 0 },
		apiTokenSha256: "0".repeat(64),
		dataDir,
		vmon: { url: "http://vmon", keyFile: "/key", template: "omp" },
		gateway: { url: "http://gateway", clientsFile: join(dataDir, "clients.json") },
		broker: { url: "http://broker", tokenFile: "/token" },
		models: { default: "fake/fake-model", direct: {} },
		runner: {
			enabled: true,
			idleTimeoutSeconds: 600,
			turnTimeoutSeconds: 1800,
			questionTimeoutSeconds: 1800,
			sandboxTimeoutSeconds: 3600,
			lifecycleSweepSeconds: 3600,
		},
		git: { hosts: {}, fetchTimeoutSeconds: 120, pushTimeoutSeconds: 120 },
	};
}

/** A store, its settings, the gateway clients file and a thread environment over `dir` (a vmon that has nothing). */
export async function openEnv(dir: string): Promise<{ store: Store; settings: Settings; gateway: GatewayClients; env: ThreadEnv }> {
	const store = Store.open({ dataDir: dir });
	const settings = Settings.load(store);
	const gateway = new GatewayClients({ file: join(dir, "clients.json"), url: "http://gateway" });
	const githubApi = new GitHubApi();
	const env: ThreadEnv = {
		store,
		vmon: fakeVmon(null).vmon,
		gateway,
		models: { providers: () => [] },
		config: testConfig(dir),
		serviceId: store.serviceId(),
		settings,
		git: await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 1, pushTimeoutSeconds: 1 }),
		signingKey: SigningKey.open(dir),
		github: await GitHubApp.open(dir, githubApi),
		githubApi,
		ompVersion: "18.12.3",
	};
	return { store, settings, gateway, env };
}

function newThread(remoteURL: string): NewThread {
	return {
		owner: "owner",
		title: "t",
		prompt: "do it",
		model: "fake/fake-model",
		thinking: "",
		repo: { name: "repo", remoteURL, baseRef: "", baseCommit: "", handoffCommit: "c".repeat(40), localBranch: "main" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
	};
}

export function threadId(n: number): string {
	return n.toString(16).padStart(12, "0");
}

/** A thread that finished its first turn at {@link HEAD} and holds a VM `sb-<n>` with a gateway client; `remoteURL` is the thread's git remote. */
export async function seedThread(
	store: Store,
	gateway: GatewayClients,
	n: number,
	state: "running" | "paused" = "running",
	remoteURL = "",
): Promise<string> {
	const id = threadId(n);
	store.createThread(id, newThread(remoteURL));
	store.startNextTurn(id);
	store.completeTurn(id, 1, {
		outcome: "completed",
		error: "",
		reply: "done",
		usage: null,
		head: HEAD,
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		pushed: false,
		pushError: "",
		pushRef: "",
	});
	store.putVm({ threadId: id, sandboxId: `sb-${n}`, state, pid: 123, sessionFile: SESSION_FILE });
	await gateway.issue(clientName(store.serviceId(), id));
	return id;
}

export function exit(code: number): CommandExitError {
	return new CommandExitError({ exitCode: code, error: "exit", stdout: "", stderr: "" });
}

export interface FakeVm {
	sandbox: Sandbox;
	/** Commands in the order they ran. */
	commands: string[];
	/** The sandbox paths files were written to, in order. */
	uploads: string[];
	paused: () => number;
}

/**
 * A sandbox whose git says the workspace is `dirty` or clean with the branch at `head`; `failBundle` makes `git bundle
 * create` fail; `onCommand` sees every command first; `staleAddresses` are what the stale-socket cleanup reports it dropped.
 * The session journal's header follows the `sed` that rewrites it.
 */
export function fakeVm(options: { dirty: boolean; head: string; failBundle?: boolean; staleAddresses?: string[]; onCommand?: (command: string) => void }): FakeVm {
	const commands: string[] = [];
	let journalId = OLD_SESSION;
	let paused = 0;
	const uploads: string[] = [];
	const sandbox = {
		commands: {
			run: async (command: string) => {
				commands.push(command);
				options.onCommand?.(command);
				if (command === DROP_STALE_SOCKETS) return { stdout: (options.staleAddresses ?? []).map(address => `${address}\n`).join("") };
				if (command.includes("diff --cached --quiet")) {
					if (options.dirty) throw exit(1);
					return { stdout: "" };
				}
				if (command.includes("bundle create") && options.failBundle === true) throw exit(128);
				if (command.includes("rev-parse --verify 'refs/heads/")) return { stdout: `${options.head}\n` };
				if (command.startsWith("mktemp")) return { stdout: "/tmp/transfer\n" };
				if (command.startsWith("head -n 4")) return { stdout: `${JSON.stringify({ type: "session", version: 3, id: journalId })}\n` };
				const sed = /^sed -i '1s\/"id":"[^"]+"\/"id":"([^"]+)"\/'/.exec(command);
				if (sed !== null) journalId = sed[1] ?? journalId;
				return { stdout: "" };
			},
		},
		files: {
			read: async (path: string) => new Blob([`content of ${path}`]).stream(),
			write: async (path: string) => {
				uploads.push(path);
			},
		},
		pause: async () => {
			paused++;
			return true;
		},
	} as unknown as Sandbox;
	return { sandbox, commands, uploads, paused: () => paused };
}

/** A vmon that hands out `sandbox` for every connect and records connects and kills (`onKill` runs first). */
export function fakeVmon(
	sandbox: Sandbox | null,
	sandboxes: SandboxSummary[] = [],
): { vmon: Vmon; connects: string[]; killed: string[]; filters: Record<string, string>[]; onKill: { run: () => Promise<void> | void } } {
	const connects: string[] = [];
	const killed: string[] = [];
	const filters: Record<string, string>[] = [];
	const onKill = { run: (): Promise<void> | void => undefined };
	const vmon = {
		connect: async (id: string) => {
			connects.push(id);
			return sandbox;
		},
		kill: async (id: string) => {
			await onKill.run();
			killed.push(id);
			return true;
		},
		list: async (filter: Record<string, string>) => {
			filters.push(filter);
			return sandboxes;
		},
	} as unknown as Vmon;
	return { vmon, connects, killed, filters, onKill };
}

export type Frame = Record<string, unknown>;

/** What a fake omp answers a `prompt` with: the frames it writes to stdout, in order. */
export type Script = (promptId: string, message: string) => Frame[];

/** What the fake omp reports for the n-th `get_state` after the prompt (1-based), and the frames it writes right after. */
export type StateScript = (n: number) => { patch: Record<string, unknown>; frames: Frame[] };

/** The pid of the fake omp (the one {@link seedThread} records). */
export const OMP_PID = 123;

/** The response frame of `command` to request `id`. */
export function response(id: string, command: string, data?: unknown): Frame {
	return { id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
}

/** The `prompt` response of a built-in command: it ran locally and omp sends no `prompt_result` after it. */
export function localAck(id: string): Frame {
	return response(id, "prompt", { agentInvoked: false });
}

export function promptResult(id: string, agentInvoked: boolean): Frame {
	return { type: "prompt_result", id, agentInvoked, status: "completed", sessionSettled: true };
}

export function assistantEnd(text: string): Frame {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			stopReason: "stop",
		},
	};
}

export interface FakeOmpOptions {
	/** What `get_state` reports once a prompt came in. */
	afterPrompt?: StateScript;
	/** Whether `get_available_commands` lists the IRC extension's `irc-in`. Default true: a VM provisioned by the service has it. */
	irc?: boolean;
	/** omp's conversation (`get_messages`, `get_messages_page`); read at every request, so a test may change it. */
	messages?: unknown[];
}

export interface FakeOmp {
	sandbox: Sandbox;
	/** The message of every `prompt` frame, in order. */
	prompts: string[];
	/** Every frame the runner wrote to omp's stdin, parsed, in order (the handshake and the `set_*` frames included). */
	frames: Frame[];
	/** What `get_state` reports; a test may change it. */
	state: { isSettled: boolean; isStreaming: boolean; isCompacting: boolean };
	/** Writes `frames` to omp's stdout, as the process attached last. */
	emit: (frames: Frame[]) => void;
	/** How many times a client attached to the process. */
	attaches: () => number;
}

/**
 * A sandbox holding an omp rpc-ui process (pid {@link OMP_PID}) that speaks the protocol: it answers the handshake,
 * `get_available_commands` (see {@link FakeOmpOptions.irc}), `get_messages`, `steer`, `abort` and `get_state` itself (as
 * `afterPrompt` says once a prompt came in) and plays `script` for every `prompt`. Git and the session export answer like {@link fakeVm}'s.
 */
export function sandboxWithOmp(vm: FakeVm, script: Script, options: FakeOmpOptions = {}): FakeOmp {
	const prompts: string[] = [];
	const frames: Frame[] = [];
	let write: (text: string) => void = () => {};
	let attaches = 0;
	const emit = (out: Frame[]): void => {
		queueMicrotask(() => write(out.map(frame => `${JSON.stringify(frame)}\n`).join("")));
	};
	let statesSincePrompt = -1;
	const state = { isSettled: true, isStreaming: false, isCompacting: false };
	const commands = {
		...vm.sandbox.commands,
		list: async () => [{ pid: OMP_PID, args: ["--mode", "rpc-ui"] }],
		connect: async (_pid: number, connect: { onStdout: (data: string) => void }) => {
			write = connect.onStdout;
			attaches++;
			return { pid: OMP_PID, wait: () => new Promise<never>(() => {}), disconnect: async () => {} };
		},
		sendStdin: async (_pid: number, data: string) => {
			for (const line of data.split("\n")) {
				if (line.trim() === "") continue;
				const frame: unknown = JSON.parse(line);
				if (typeof frame !== "object" || frame === null) continue;
				frames.push({ ...frame });
				if (!("type" in frame) || !("id" in frame) || typeof frame.id !== "string") continue;
				if (frame.type === "negotiate_protocol") emit([response(frame.id, "negotiate_protocol", { protocolVersion: 2 })]);
				else if (frame.type === "get_available_commands") {
					emit([response(frame.id, "get_available_commands", { commands: [{ name: "compact" }, ...(options.irc === false ? [] : [{ name: "irc-in" }])] })]);
				} else if (frame.type === "get_messages_page") {
					const messages = options.messages ?? [];
					emit([response(frame.id, "get_messages_page", { messages, totalMessages: messages.length })]);
				} else if (frame.type === "get_messages") emit([response(frame.id, "get_messages", { messages: options.messages ?? [] })]);
				else if (frame.type === "steer" || frame.type === "abort") emit([response(frame.id, frame.type)]);
				else if (frame.type === "get_last_assistant_text") {
					const last = (options.messages ?? []).findLast(m => isRecord(m) && m.role === "assistant");
					emit([response(frame.id, "get_last_assistant_text", { text: last === undefined ? null : messageText(last) })]);
				} else if (frame.type === "get_state") {
					const scripted = statesSincePrompt < 0 || options.afterPrompt === undefined ? null : options.afterPrompt(++statesSincePrompt);
					emit([
						response(frame.id, "get_state", {
							...state,
							sessionFile: SESSION_FILE,
							contextUsage: { tokens: 1200, contextWindow: 200_000, percent: 0.6 },
							...scripted?.patch,
						}),
						...(scripted?.frames ?? []),
					]);
				} else if (frame.type === "prompt" && "message" in frame && typeof frame.message === "string") {
					statesSincePrompt = 0;
					prompts.push(frame.message);
					emit(script(frame.id, frame.message));
				}
			}
		},
	};
	const sandbox = { ...vm.sandbox, commands, setTimeout: async () => {} } as unknown as Sandbox;
	return { sandbox, prompts, frames, state, emit, attaches: () => attaches };
}

/** Lets everything already queued run: every pending microtask and I/O callback, with no wall-clock wait. */
export function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Yields to the event loop until `condition` holds; throws after `timeoutMs` (a failure message, not a pace). */
export async function until(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await settle();
	}
}
