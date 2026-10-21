/**
 * The VM half of omp-cloud's IRC bridge: an omp extension the runner uploads into every VM and starts omp with (`-e`).
 * It makes the thread's parent (the local omp that started or delegated to it) an agent of the VM's own omp, so the cloud
 * agent talks to it with omp's ordinary `write agent://<id>` and receives its messages as omp's ordinary incoming IRC.
 *
 * - `session_start` (the VM's top-level session only) registers the parent as an idle agent of omp's registry. Its id and
 *   description come from `~/.omp-cloud/irc.json`, which the runner writes per thread. Its session is a small shim whose
 *   `deliverIrcMessage` is what omp's `IrcBus` calls for a message to the parent: it emits an `extension_ui_request` frame
 *   (`setStatus`, key `omp-cloud.irc`, the message as JSON) that the runner reads off omp's stdout.
 * - `/irc-in <json>` is how the runner delivers a message to the cloud agent: `{id, from, body, replyTo?, wakeRelay?}`. It goes
 *   to the top-level session's own `deliverIrcMessage`, which is what `IrcBus` calls too, so omp builds its usual `<irc>`
 *   envelope, queues the message at the next step boundary of a running turn (never aborting it) and wakes an idle agent.
 *   The bus itself is not imported: a compiled omp serves an extension only the host subpaths its package exports name
 *   (`registry/*` is one, `irc/bus` is not).
 *
 * Every host member is feature-detected. A registry that is not where this extension expects it, a failed registration or a
 * failed delivery is logged once on stderr and the extension degrades (the cloud agent has no parent peer, `/irc-in` is not
 * offered or answers an error); nothing here throws into omp.
 *
 * The file is uploaded on its own: it imports nothing from this repository.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as registryModule from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

/** The `setStatus` key and the `kind` of the JSON an outgoing message travels in. The runner's `irc.ts` holds the same two. */
export const IRC_STATUS_KEY = "omp-cloud.irc";
export const IRC_FRAME_KIND = "omp-cloud.irc";
/** The slash command that delivers an incoming message (`/irc-in <json>`). */
export const IRC_COMMAND = "irc-in";

const DEFAULT_PARENT_ID = "Parent";
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
/** How many message ids `/irc-in` remembers, to drop a delivery the runner repeats. */
const SEEN_LIMIT = 512;
/** After a wake, how long `/irc-in` waits for omp to start the turn: the runner reads "settled" off omp, which must not say so before the wake begins. */
const WAKE_WAIT_MS = 2000;

/** An IRC message as omp's bus hands it to a session. */
export interface IrcMessage {
	id: string;
	from: string;
	to: string;
	body: string;
	replyTo?: string;
	ts: number;
	broadcast?: boolean;
	wakeRelay?: boolean;
}

/** The slice of omp's `AgentRegistry` this extension uses. */
export interface RegistryLike {
	get(id: string): { session?: unknown } | undefined;
	register(input: Record<string, unknown>): unknown;
}

/** What `installIrcPeer` needs from outside, so a test can stand in for omp. */
export interface IrcPeerHost {
	/** omp's registry, or undefined when the host does not look as this extension expects. */
	registry: RegistryLike | undefined;
	/** The runner's per-thread configuration (`~/.omp-cloud/irc.json`) parsed, or undefined when it is missing. */
	readConfig(): unknown;
	log(line: string): void;
}

interface ParentIdentity {
	id: string;
	displayName: string;
	description: string;
}

/** The `ctx.ui` members used. */
interface UiLike {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The parent as the runner configured it; the defaults when the file is missing or unusable, or names the VM agent itself. */
function parentIdentity(config: unknown, selfId: string): ParentIdentity {
	const raw = isRecord(config) && isRecord(config.parent) ? config.parent : {};
	const id = text(raw.id);
	const valid = ID_PATTERN.test(id) && id !== selfId;
	return {
		id: valid ? id : DEFAULT_PARENT_ID,
		displayName: text(raw.displayName) || "Parent",
		description: text(raw.description) || "the omp that started this thread and is waiting for its result",
	};
}

/** What `/irc-in` was given, or null when it is not `{id, from, body}` of non-empty strings. */
function parseInbound(args: string): { id: string; from: string; body: string; replyTo: string; wakeRelay: boolean } | null {
	let value: unknown;
	try {
		value = JSON.parse(args);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	const id = text(value.id);
	const from = text(value.from);
	const body = text(value.body);
	if (id === "" || from === "" || body.trim() === "") return null;
	return { id, from, body, replyTo: text(value.replyTo), wakeRelay: value.wakeRelay === true };
}

/** Reads `~/.omp-cloud/irc.json`; undefined when missing or not JSON. */
function readConfigFile(): unknown {
	try {
		return JSON.parse(readFileSync(join(homedir(), ".omp-cloud", "irc.json"), "utf8"));
	} catch {
		return undefined;
	}
}

function hasRegistryShape(value: unknown): value is RegistryLike {
	return isRecord(value) && typeof value.get === "function" && typeof value.register === "function";
}

/** The session-shaped object omp's registry, bus and `wait` tool call for a peer: every member they read, none of them throwing. */
function peerSession(deliver: (message: IrcMessage) => void): Record<string, unknown> {
	return {
		isStreaming: false,
		runStartedAt: 0,
		messages: [],
		deliverIrcMessage: async (message: IrcMessage): Promise<"injected"> => {
			deliver(message);
			return "injected";
		},
		drainPendingIrcInboxMessages: () => [],
		waitForIrcReplies: async () => {},
		subscribe: () => () => {},
		abort: async () => {},
		dispose: async () => {},
	};
}

/** Waits until `session` reports it is streaming (the wake it was just given has begun), at most `WAKE_WAIT_MS`. */
async function untilStreaming(session: Record<string, unknown>): Promise<void> {
	const deadline = Date.now() + WAKE_WAIT_MS;
	while (session.isStreaming !== true && Date.now() < deadline) await sleep(10);
}

/** Registers the parent peer and the `/irc-in` command on `pi`. */
export function installIrcPeer(pi: ExtensionAPI, host: IrcPeerHost): void {
	const warned = new Set<string>();
	const warn = (what: string, error?: unknown): void => {
		if (warned.has(what)) return;
		warned.add(what);
		host.log(`omp-cloud irc-peer: ${what}${error === undefined ? "" : `: ${describe(error)}`}`);
	};
	const registry = host.registry;
	if (registry === undefined) {
		warn("omp's agent registry is not where this extension expects it; IRC with the parent is off");
		return;
	}

	let ui: UiLike | undefined;
	let selfId = "Main";
	let parent = parentIdentity(undefined, selfId);
	const seen = new Set<string>();

	/** A peer's `deliverIrcMessage`: the message leaves omp as a UI frame for the runner. */
	const emit = (message: IrcMessage): void => {
		if (ui === undefined) throw new Error("the runner is not attached");
		ui.setStatus(
			IRC_STATUS_KEY,
			JSON.stringify({ kind: IRC_FRAME_KIND, id: message.id, from: message.from, to: message.to, body: message.body, replyTo: message.replyTo ?? "" }),
		);
	};

	const register = (id: string, displayName: string, description: string): void => {
		if (registry.get(id) !== undefined) return;
		registry.register({ id, displayName, kind: "sub", session: peerSession(emit), status: "idle", activity: description });
	};

	pi.on("session_start", (_event, ctx) => {
		const agent: unknown = ctx.agent;
		// The extension is rebound to every subagent the VM agent spawns; only the top-level session has the parent.
		if (!isRecord(agent) || agent.kind !== "main") return;
		ui = ctx.ui;
		selfId = text(agent.id) || selfId;
		try {
			parent = parentIdentity(host.readConfig(), selfId);
			register(parent.id, parent.displayName, parent.description);
		} catch (error) {
			warn("registering the parent failed", error);
		}
	});

	pi.registerCommand(IRC_COMMAND, {
		description: "omp-cloud: deliver an incoming IRC message to this agent (used by the runner)",
		handler: async (args, ctx) => {
			const commandUi = ctx.ui;
			ui = commandUi;
			try {
				const inbound = parseInbound(args);
				if (inbound === null) {
					commandUi.notify(`/${IRC_COMMAND} expects a JSON object with the strings id, from and body`, "error");
					return;
				}
				if (seen.has(inbound.id)) return;
				const agentId = ctx.agent.id || selfId;
				const target = registry.get(agentId)?.session;
				if (!isRecord(target) || typeof target.deliverIrcMessage !== "function") {
					warn("the top-level session has no deliverIrcMessage; incoming IRC is off");
					commandUi.notify(`/${IRC_COMMAND}: this omp cannot deliver IRC messages`, "error");
					return;
				}
				// The local sender may be called like the VM agent itself; the VM knows that sender as its parent.
				const from = inbound.from === agentId ? parent.id : inbound.from;
				register(from, from, "a peer omp agent that wrote to you");
				const message: IrcMessage = {
					id: inbound.id,
					from,
					to: agentId,
					body: inbound.body,
					...(inbound.replyTo === "" ? {} : { replyTo: inbound.replyTo }),
					...(inbound.wakeRelay ? { wakeRelay: true } : {}),
					ts: Date.now(),
				};
				const outcome: unknown = await Reflect.apply(target.deliverIrcMessage, target, [message]);
				seen.add(inbound.id);
				if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value ?? inbound.id);
				if (outcome === "woken") await untilStreaming(target);
			} catch (error) {
				warn("delivering a message failed", error);
				commandUi.notify(`/${IRC_COMMAND} failed: ${describe(error)}`, "error");
			}
		},
	});
}

export default function ircPeer(pi: ExtensionAPI): void {
	const AgentRegistry: unknown = registryModule.AgentRegistry;
	const registry: unknown =
		typeof AgentRegistry === "function" && "global" in AgentRegistry && typeof AgentRegistry.global === "function" ? AgentRegistry.global() : undefined;
	installIrcPeer(pi, {
		registry: hasRegistryShape(registry) ? registry : undefined,
		readConfig: readConfigFile,
		log: line => {
			process.stderr.write(`${line}\n`);
		},
	});
}
