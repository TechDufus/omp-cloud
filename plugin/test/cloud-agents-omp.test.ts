/**
 * The cloud agents through omp's own handlers: a real `AgentRegistry` and `IrcBus`, omp's `agent://` and `history://` handlers
 * through its router, `executeSend` (what `write agent://<id>` runs), the real `AsyncJobManager` with its delivery sinks and
 * `buildAsyncResultBatchMessage`, `WaitTool`, `executeCancel` and `cancelAgentRegistration`. Only the cloud client, the
 * recipient sessions of the messages and the model-facing sink are fakes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobError, AsyncJobManager, type AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { cancelAgentRegistration, executeCancel } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { artifactsDirsFromRegistry, resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { executeSend } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildAsyncResultBatchMessage } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { CloudError } from "../src/errors";
import { isRecord } from "../src/guards";
import { CloudAgents, IRC_CAPABILITY, type AgentsClient } from "../src/cloud-agents";
import { CloudJobs } from "../src/cloud-jobs";
import { Deliverer } from "../src/deliver";
import type { IrcMessageBody, IrcReceipt, ThreadDetail, ThreadTurn } from "../src/types";
import { detail, event, turn } from "./builders";
import { fakeHost, fakePi, until } from "./fakes";
import { cleanup, isolateOmp, tmp } from "./helpers";

const ID = "aaaaaak3x9fa";
const AGENT = "FixGreetingBug";
const BRANCH = `omp-cloud/${ID}`;

/** A running turn 1 of a named thread. */
const running = (over: Partial<ThreadDetail> = {}): ThreadDetail =>
	detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", model: "anthropic/claude-sonnet-5-5", turns: [turn(1, { state: "running", text: "fix the greeting bug", completedAt: "" })], ...over });

/** The thread once turn 1 ended in `state`. */
const ended = (state: "done" | "failed" | "cancelled" = "done", over: Partial<ThreadTurn> = {}, thread: Partial<ThreadDetail> = {}): ThreadDetail =>
	detail({
		id: ID,
		name: "Fix greeting bug",
		title: "Add Greet",
		phase: "idle",
		result: { branch: BRANCH, head: "abc1234", base: "def5678", filesChanged: 1, insertions: 3, deletions: 1, pushed: false, pushError: "", pushRef: "", updatedAt: "2026-01-01T00:01:00Z" },
		turns: [turn(1, { state, title: "Greeting fixed", reply: "All done.", error: "boom", ...over })],
		...thread,
	});

/** The thread with turn 1 done and turn 2 an IRC turn in `state`. */
const second = (state: "queued" | "running" | "done", over: Partial<ThreadTurn> = {}, thread: Partial<ThreadDetail> = {}): ThreadDetail =>
	ended("done", {}, {
		phase: state === "done" ? "idle" : "working",
		turns: [turn(1, { reply: "All done.", title: "Greeting fixed" }), turn(2, { state, text: "also the farewell", reply: state === "done" ? "Second reply." : "", title: "Farewell", completedAt: state === "done" ? "2026-01-01T00:02:00Z" : "", ...over })],
		...thread,
	});

const ircEvent = (seq: number, body: Record<string, string>) => event(seq, { kind: "irc", turn: 1, text: JSON.stringify({ id: "m-1", from: "greeter", to: "Main", body: "need the file name", replyTo: "", at: "2026-01-01T00:00:30Z", ...body }) });

/** The session of a local agent that receives messages: every `deliverIrcMessage` call is recorded. */
class FakeSession {
	readonly delivered: IrcMessage[] = [];
	readonly relays: unknown[] = [];
	isStreaming = false;
	runStartedAt: number | undefined = 0;
	/** Set to make the next delivery fail. */
	failWith: Error | undefined;
	#transitions = 0;

	/** omp's `AgentSession.isSessionTransitioning`: true while a session identity or transcript transition is applying. */
	get isSessionTransitioning(): boolean {
		return this.#transitions > 0;
	}

	/** Runs `work` the way omp's `resetSessionContext`, `newSession`, `fork` and `switchSession` run theirs: inside a transition. */
	transition(work: () => void): void {
		this.#transitions++;
		try {
			work();
		} finally {
			this.#transitions--;
		}
	}

	async deliverIrcMessage(msg: IrcMessage): Promise<"injected"> {
		if (this.failWith) throw this.failWith;
		this.delivered.push(msg);
		return "injected";
	}

	emitIrcRelayObservation(record: unknown): void {
		this.relays.push(record);
	}
}

interface FakeClient {
	client: AgentsClient;
	irc: { thread: string; message: IrcMessageBody }[];
	messages: { thread: string; text: string }[];
	stops: string[];
	capabilities: string[];
	/** The service's answer to an IRC message; a woken thread with a queued turn by default. */
	answer: (thread: string, message: IrcMessageBody) => Promise<IrcReceipt>;
	/** Makes `requireCapability` fail. */
	capabilityError: CloudError | undefined;
	stopError: CloudError | undefined;
}

function fakeClient(): FakeClient {
	const f: FakeClient = {
		irc: [],
		messages: [],
		stops: [],
		capabilities: [],
		answer: async (_thread, message) => ({ receipt: "woken", id: message.id ?? "", turn: turn(2, { state: "queued", text: message.body, origin: "irc", ircFrom: message.from, ircId: message.id ?? "", completedAt: "" }) }),
		capabilityError: undefined,
		stopError: undefined,
		client: {
			async irc(thread, message) {
				f.irc.push({ thread, message });
				return f.answer(thread, message);
			},
			async sendMessage(thread, text) {
				f.messages.push({ thread, text });
				return { turn: turn(2, { state: "queued", text, completedAt: "" }), interrupted: false, cancelled: [] };
			},
			async stop(thread) {
				f.stops.push(thread);
				if (f.stopError) throw f.stopError;
				return { stoppedRunning: true, cancelled: 0 };
			},
			async requireCapability(capability) {
				f.capabilities.push(capability);
				if (f.capabilityError) throw f.capabilityError;
			},
			async downloadConversation() {
				throw new Error("no conversation in this test");
			},
		},
	};
	return f;
}

const unavailable = (over: Partial<ConstructorParameters<typeof CloudError>[0]> = {}): CloudError => new CloudError({ code: "unavailable", message: "the cloud is unavailable", retriable: false, outcomeKnown: true, ...over });

interface Delivered {
	jobId: string;
	text: string;
	job: AsyncJob | undefined;
}

interface Rig {
	agents: CloudAgents;
	registry: AgentRegistry;
	router: InternalUrlRouter;
	dir: string;
	client: FakeClient;
	main: FakeSession;
	follows: string[];
	warns: string[];
	relayFailures: string[];
	entries: unknown[];
	manager: AsyncJobManager;
	jobs: CloudJobs;
	/** What the manager's delivery sink of "Main" got: omp's own async-result path. */
	delivered: Delivered[];
	stops: string[];
	asides: [string, string][];
	/** The origin the session records for the thread: `tool` threads wake the model. */
	origin: { value: "tool" | "user" };
}

const rigs: Rig[] = [];

interface RigOptions {
	/** The agents' artifacts directory is a fresh temp directory the test owns, not one the agents make. */
	dir?: boolean;
	main?: boolean;
	hydrate?: boolean;
}

async function rig(opts: RigOptions = {}): Promise<Rig> {
	const registry = AgentRegistry.global();
	const dir = await tmp("omp-cloud-agents-");
	const main = new FakeSession();
	if (opts.main !== false) registry.register({ id: "Main", displayName: "Main", kind: "main", session: main as unknown as AgentSession, status: "running" });
	const client = fakeClient();
	const follows: string[] = [];
	const warns: string[] = [];
	const relayFailures: string[] = [];
	const entries: unknown[] = [];
	const agents = new CloudAgents({
		client: async () => client.client,
		follow: thread => void follows.push(thread),
		warn: message => void warns.push(message),
		cwd: () => "/work",
		entries: () => entries,
		relayFailed: (_detail, t, reason) => void relayFailures.push(`${t.id}: ${reason}`),
		registry: () => AgentRegistry.global(),
		...(opts.dir === false ? {} : { dir }),
		hydrate: opts.hydrate ?? false,
	});
	const manager = new AsyncJobManager({ retentionMs: 60_000, consumedResultEvictionMs: 60_000 });
	const delivered: Delivered[] = [];
	manager.registerDeliverySink("Main", (jobId, text, job) => void delivered.push({ jobId, text, job }));
	const stops: string[] = [];
	const asides: [string, string][] = [];
	const origin: Rig["origin"] = { value: "tool" };
	const jobs = new CloudJobs({
		manager: () => manager,
		wakes: (_thread, t) => origin.value === "tool" && t.origin !== "irc",
		agentId: thread => agents.agentId(thread),
		warn: message => void warns.push(message),
		stop: thread => void stops.push(thread),
		transitioning: () => agents.ownerTransitioning(),
		aside: (thread, label) => void asides.push([thread, label]),
	});
	const r: Rig = { agents, registry, router: InternalUrlRouter.instance(), dir, client, main, follows, warns, relayFailures, entries, manager, jobs, delivered, stops, asides, origin };
	rigs.push(r);
	return r;
}

beforeEach(async () => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	await isolateOmp();
});

afterEach(async () => {
	for (const r of rigs.splice(0)) {
		r.agents.dispose();
		await r.manager.dispose({ timeoutMs: 200 });
	}
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	await cleanup();
});

/** The ref's session as the shim, typed for what the tests read of it. */
function shimOf(r: Rig, id = AGENT): AgentSession {
	const session = r.registry.get(id)?.session;
	if (!session) throw new Error(`no session for ${id}`);
	return session;
}

/** `agent://<id>` or `history://<id>` as omp's router resolves it. */
async function read(r: Rig, url: string): Promise<{ content: string; notes: string[]; sourcePath: string | undefined }> {
	const resource = await r.router.resolve(url);
	return { content: resource.content, notes: resource.notes ?? [], sourcePath: resource.sourcePath };
}

/** What `write agent://<to>` does: omp's own `executeSend` from `from`. */
async function write(r: Rig, to: string, message: string, from = "Main") {
	return executeSend({ registry: r.registry, senderId: from }, { to, message });
}

function textOf(result: AgentToolResult<CoordinationDetails>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

/** A tiny `omp session pack` archive: a session journal of one exchange. */
async function archive(dir: string, user: string, assistant: string): Promise<string> {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const lines = [
		{ type: "session", version: 3, id: "conversation-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" },
		{ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: user, timestamp: 1 } },
		{ type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: assistant }], api: "omp-cloud", provider: "omp-cloud", model: "claude", usage, stopReason: "stop", timestamp: 2 } },
	];
	const file = join(dir, "conversation.tar");
	await Bun.write(file, new Bun.Archive({ "session.jsonl": `${lines.map(l => JSON.stringify(l)).join("\n")}\n` }));
	return file;
}

describe("artifacts: agent:// and history:// through omp's handlers", () => {
	test("a finished thread's ref exists and agent://<id> reads its reply, with the sidecar fields", async () => {
		const r = await rig();
		r.agents.observe(ended());
		const ref = r.registry.get(AGENT);
		expect(ref?.kind).toBe("sub");
		expect(ref?.parentId).toBe("Main");
		expect(ref?.status).toBe("idle");
		expect(artifactsDirsFromRegistry()).toContain(r.dir);

		const whole = await read(r, `agent://${AGENT}`);
		expect(whole.content).toBe("All done.");
		expect(whole.sourcePath).toBe(join(r.dir, `${AGENT}.md`));
		expect(whole.notes).toEqual([]);
		expect(await r.router.locate(`agent://${AGENT}`)).toBe(join(r.dir, `${AGENT}.md`));

		expect((await read(r, `agent://${AGENT}/result/branch`)).content).toBe(BRANCH);
		expect((await read(r, `agent://${AGENT}/branch`)).content).toBe(BRANCH);
		const reply = await read(r, `agent://${AGENT}/reply`);
		expect(reply.content).toBe("All done.");
		expect(reply.sourcePath).toBe(join(r.dir, `${AGENT}.json`));
		expect(reply.notes).toContain("Source: FixGreetingBug.json");
		expect((await read(r, `agent://${AGENT}/thread`)).content).toBe(ID);
		expect((await read(r, `agent://${AGENT}/diffstat/insertions`)).content).toBe("3");
	});

	test("a failed turn publishes its error as the output, with the state in the sidecar", async () => {
		const r = await rig();
		r.agents.observe(ended("failed"));
		expect((await read(r, `agent://${AGENT}`)).content).toBe("Turn 1 failed: boom");
		expect((await read(r, `agent://${AGENT}/state`)).content).toBe("failed");
		expect((await read(r, `agent://${AGENT}/error`)).content).toBe("boom");
	});

	test("a running turn with nothing published shows the status and the newest assistant text", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.agents.event(d, event(1, { kind: "assistant", text: "Reading the greeting module" }));
		r.agents.event(d, event(2, { kind: "tool", text: "bash: bun test" }));
		expect(r.registry.get(AGENT)?.status).toBe("running");

		const progress = await read(r, `agent://${AGENT}`);
		expect(progress.content).toContain(`# ${AGENT} (running)`);
		expect(progress.content).toContain("No final output yet");
		expect(progress.content).toContain("Reading the greeting module");
		expect(progress.content).toContain("» bash: bun test");
		expect(progress.notes[0]).toContain("progress from live session (running)");
		await expect(read(r, `agent://${AGENT}/reply`)).rejects.toThrow("not published yet");
	});

	test("a running turn after a published one shows omp's superseded banner over the older result, then the new result", async () => {
		const r = await rig();
		r.agents.observe(ended());
		r.agents.observe(second("running"));
		expect(r.registry.isRunning(r.registry.get(AGENT)!)).toBe(true);

		const stale = await read(r, `agent://${AGENT}`);
		expect(stale.content.startsWith(`> \`${AGENT}\` is running a newer turn.`)).toBe(true);
		expect(stale.content.endsWith("All done.")).toBe(true);
		expect(stale.notes).toContain(`Superseded: ${AGENT} is running a newer turn`);
		// omp reads a located file directly, which would skip the banner: a superseded output locates to nothing.
		expect(await r.router.locate(`agent://${AGENT}`)).toBeNull();
		// A JSON-path read is a field of the sidecar, not the output: no banner.
		expect((await read(r, `agent://${AGENT}/result/branch`)).content).toBe(BRANCH);

		r.agents.observe(second("done"));
		const fresh = await read(r, `agent://${AGENT}`);
		expect(fresh.content).toBe("Second reply.");
		expect(fresh.notes).toEqual([]);
		expect(r.registry.get(AGENT)?.status).toBe("idle");
	});

	test("history:// renders the running turn: the user's text and the assistant event lines", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.agents.event(d, event(1, { kind: "assistant", text: "Reading the greeting module" }));
		r.agents.event(d, event(2, { kind: "tool_error", text: "bash: exit 1" }));

		const history = await read(r, `history://${AGENT}`);
		expect(history.notes).toContain("Source: live session");
		expect(history.content).toContain("fix the greeting bug");
		expect(history.content).toContain("Reading the greeting module");
		expect(history.content).toContain("! bash: exit 1");
		expect(history.content).toBe(formatSessionHistoryMarkdown(shimOf(r).messages, { title: `${AGENT} (running)` }));
	});

	test("history:// renders a finished thread's turns, an IRC turn marked with its sender", async () => {
		const r = await rig();
		r.agents.observe(ended("done", { text: "fix the greeting bug" }));
		r.agents.observe(second("done", { origin: "irc", ircFrom: "Planner", ircId: "i-1", text: "also the farewell" }));

		const history = await read(r, `history://${AGENT}`);
		expect(history.content).toContain(`${AGENT} (idle)`);
		expect(history.content).toContain("All done.");
		expect(history.content).toContain("[irc from Planner] also the farewell");
		expect(history.content).toContain("Second reply.");
		expect(history.content).toBe(formatSessionHistoryMarkdown(shimOf(r).messages, { title: `${AGENT} (idle)` }));
	});

	test("history:// renders the exported conversation after ingest, and a turn that runs after it", async () => {
		const r = await rig();
		const d = ended();
		r.agents.observe(d);
		await r.agents.ingest(ID, await archive(await tmp("omp-cloud-arc-"), "Please fix the greeting", "Fixed greet.ts and its test."));
		expect(existsSync(join(r.dir, `${AGENT}.jsonl`))).toBe(true);

		const exported = await read(r, `history://${AGENT}`);
		expect(exported.content).toContain("Please fix the greeting");
		expect(exported.content).toContain("Fixed greet.ts and its test.");
		// The conversation replaces the turns' own summaries.
		expect(exported.content).not.toContain("All done.");
		expect(exported.content).toBe(formatSessionHistoryMarkdown(shimOf(r).messages, { title: `${AGENT} (idle)` }));

		const next = second("running");
		r.agents.observe(next);
		r.agents.event(next, event(9, { kind: "assistant", turn: 2, text: "Starting on the farewell" }));
		const live = await read(r, `history://${AGENT}`);
		expect(live.content).toContain("Fixed greet.ts and its test.");
		expect(live.content).toContain("also the farewell");
		expect(live.content).toContain("Starting on the farewell");
	});

	test("history:// of an unknown agent is omp's Unknown agent error", async () => {
		const r = await rig();
		r.agents.observe(ended());
		await expect(read(r, "history://Nobody")).rejects.toThrow("Unknown agent: Nobody");
	});

	test("releasing a thread unregisters its ref and removes its files; dispose unregisters the directory", async () => {
		const r = await rig();
		r.agents.observe(ended());
		expect(existsSync(join(r.dir, `${AGENT}.md`))).toBe(true);
		r.agents.release(ID);
		expect(r.registry.get(AGENT)).toBeUndefined();
		expect(existsSync(join(r.dir, `${AGENT}.md`))).toBe(false);
		expect(existsSync(join(r.dir, `${AGENT}.json`))).toBe(false);
		await expect(read(r, `agent://${AGENT}`)).rejects.toThrow();

		r.agents.observe(ended());
		expect((await read(r, `agent://${AGENT}`)).content).toBe("All done.");
		expect(artifactsDirsFromRegistry()).toContain(r.dir);
		r.agents.dispose();
		expect(r.registry.get(AGENT)).toBeUndefined();
		expect(artifactsDirsFromRegistry()).not.toContain(r.dir);
		await expect(read(r, `agent://${AGENT}`)).rejects.toThrow();
	});

	test("a directory the agents made is removed by dispose", async () => {
		const r = await rig({ dir: false });
		r.agents.observe(ended());
		const made = r.agents.dir();
		expect(artifactsDirsFromRegistry()).toContain(made);
		expect((await read(r, `agent://${AGENT}`)).content).toBe("All done.");
		r.agents.dispose();
		expect(existsSync(made)).toBe(false);
		expect(artifactsDirsFromRegistry()).not.toContain(made);
	});

	test("a ref omp's kill dropped is registered again by the next observe; an id another agent holds is not taken", async () => {
		const r = await rig();
		r.agents.observe(ended());
		const first = shimOf(r);
		r.registry.unregister(AGENT);
		r.agents.observe(ended());
		expect(shimOf(r)).toBe(first);

		const other = await rig({ main: false });
		other.registry.unregister(AGENT);
		other.registry.register({ id: AGENT, displayName: AGENT, kind: "sub", session: null, status: "idle" });
		const rival = new CloudAgents({ client: async () => other.client.client, follow: () => {}, warn: () => {}, cwd: () => "/", entries: () => [], relayFailed: () => {}, registry: () => AgentRegistry.global(), hydrate: false });
		rival.observe(ended("done", {}, { id: "bbbbbbm1m1m1" }));
		expect(rival.agentId("bbbbbbm1m1m1")).toBe(`${AGENT}-2`);
		rival.dispose();
	});
});

describe("write agent://<id> through omp's executeSend", () => {
	test("a running thread receives the message with the sender, and omp says Delivered", async () => {
		const r = await rig();
		r.agents.observe(running());
		r.client.answer = async (_t, m) => ({ receipt: "injected", id: m.id ?? "", turn: null });

		const result = await write(r, AGENT, "use the existing helper");
		expect(textOf(result)).toBe(`Delivered to ${AGENT}.`);
		expect(result.isError).toBe(false);
		expect(r.client.capabilities).toEqual([IRC_CAPABILITY]);
		expect(r.client.irc).toHaveLength(1);
		const call = r.client.irc[0];
		expect(call?.thread).toBe(ID);
		expect(call?.message.from).toBe("Main");
		expect(call?.message.body).toBe("use the existing helper");
		expect(call?.message.id).toMatch(/\S/);
		expect(call?.message.replyTo).toBeUndefined();
		expect(r.client.messages).toEqual([]);
		// Injected into the running turn: no new turn to follow, the run state is unchanged.
		expect(shimOf(r).isStreaming).toBe(true);
	});

	test("an idle thread is woken: omp says Delivered, the thread is followed and counts as running", async () => {
		const r = await rig();
		r.agents.observe(ended());
		expect(shimOf(r).isStreaming).toBe(false);

		const result = await write(r, AGENT, "also do the farewell");
		expect(textOf(result)).toBe(`Delivered to ${AGENT}.`);
		expect(result.isError).toBe(false);
		expect(r.follows).toEqual([ID]);
		expect(shimOf(r).isStreaming).toBe(true);
		expect(r.registry.get(AGENT)?.status).toBe("running");
		expect(r.registry.isRunning(r.registry.get(AGENT)!)).toBe(true);
	});

	test("an archived thread is revived: omp says Queued ... was parked; revived", async () => {
		const r = await rig();
		r.agents.observe(ended("done", {}, { archivedAt: "2026-01-02T00:00:00Z" }));
		r.client.answer = async (_t, m) => ({ receipt: "revived", id: m.id ?? "", turn: turn(2, { state: "queued", text: m.body, completedAt: "" }) });

		const result = await write(r, AGENT, "pick this back up");
		expect(textOf(result)).toBe(`Queued for ${AGENT} (was parked; revived).`);
		expect(result.isError).toBe(false);
		expect(r.follows).toEqual([ID]);
		expect(shimOf(r).isStreaming).toBe(true);
	});

	test("a service without the IRC endpoint gets the message as a queued turn, with the receipt omp reports from the thread", async () => {
		const r = await rig();
		r.client.capabilityError = unavailable({ code: "version_skew", message: "the service does not support IRC" });
		r.agents.observe(ended());
		expect(textOf(await write(r, AGENT, "one"))).toBe(`Delivered to ${AGENT}.`);
		expect(r.client.irc).toEqual([]);
		expect(r.client.messages).toEqual([{ thread: ID, text: "one" }]);

		const archived = await rig({ main: false });
		archived.registry.register({ id: "Main", displayName: "Main", kind: "main", session: archived.main as unknown as AgentSession, status: "running" });
		archived.client.capabilityError = unavailable({ code: "version_skew", message: "the service does not support IRC" });
		archived.agents.observe(ended("done", {}, { id: "cccccck2k2k2", archivedAt: "2026-01-02T00:00:00Z" }));
		expect(textOf(await executeSend({ registry: archived.registry, senderId: "Main" }, { to: archived.agents.agentId("cccccck2k2k2") ?? "", message: "wake" }))).toContain("was parked; revived");
	});

	test("a failing client is omp's failed receipt with the cloud's own text, and the thread is not followed", async () => {
		const r = await rig();
		r.agents.observe(ended());
		r.client.answer = async () => {
			throw unavailable({ message: "the cloud is unavailable", hint: "try again in a minute" });
		};
		const result = await write(r, AGENT, "hello");
		expect(textOf(result)).toBe(`Failed: ${AGENT} could not receive the message. the cloud is unavailable — try again in a minute`);
		expect(result.isError).toBe(true);
		expect(r.follows).toEqual([]);
		expect(shimOf(r).isStreaming).toBe(false);
		expect(IrcBus.global().sentSince("Main", AGENT, 0)).toBe(false);
		unansweredOf("Main", []);
	});

	test("an answer that was lost says the message may have been delivered, after the client's own repeated attempts", async () => {
		const r = await rig();
		r.agents.observe(ended());
		r.client.answer = async () => {
			throw unavailable({ code: "ambiguous_outcome", message: "the connection dropped", outcomeKnown: false });
		};
		const text = textOf(await write(r, AGENT, "hello"));
		expect(text).toContain(`Failed: ${AGENT} could not receive the message. the connection dropped`);
		expect(text).toContain("The message may have been delivered: the cloud gave no answer after repeated attempts with the same message id.");
		expect(r.client.irc).toHaveLength(1);
	});

	test("a thread the service lost is released, and omp then says the agent is not running", async () => {
		const r = await rig();
		r.agents.observe(ended());
		r.client.answer = async () => {
			throw unavailable({ code: "not_found", message: "no such thread" });
		};
		const result = await write(r, AGENT, "hello");
		expect(textOf(result)).toBe(`Failed: ${AGENT} is not running. no such thread`);
		expect(result.isError).toBe(true);
		expect(r.registry.get(AGENT)).toBeUndefined();
		expect(r.agents.agentId(ID)).toBeUndefined();
	});

	test("an unknown id is omp's Unknown agent failure, and no cloud call is made", async () => {
		const r = await rig();
		r.agents.observe(ended());
		const result = await write(r, "Nobody", "hello");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Failed: Nobody is not running.");
		expect(textOf(result)).toContain('Unknown agent "Nobody"');
		expect(r.client.irc).toEqual([]);
	});

	test("the bus records the send: sentSince, and unansweredSends where omp has it", async () => {
		const r = await rig();
		r.agents.observe(running());
		r.client.answer = async (_t, m) => ({ receipt: "injected", id: m.id ?? "", turn: null });
		const before = Date.now();
		await write(r, AGENT, "hello");
		const bus = IrcBus.global();
		expect(bus.sentSince("Main", AGENT, before)).toBe(true);
		expect(bus.sentSince(AGENT, "Main", 0)).toBe(false);
		unansweredOf("Main", [AGENT]);
	});

	test("a message from another agent goes with that sender and makes it the agent's parent; the main UI is shown the exchange", async () => {
		const r = await rig();
		const planner = new FakeSession();
		r.registry.register({ id: "Planner", displayName: "Planner", kind: "sub", session: planner as unknown as AgentSession, status: "running" });
		r.agents.observe(running());
		r.client.answer = async (_t, m) => ({ receipt: "injected", id: m.id ?? "", turn: null });

		expect(textOf(await write(r, AGENT, "status?", "Planner"))).toBe(`Delivered to ${AGENT}.`);
		expect(r.client.irc[0]?.message.from).toBe("Planner");
		expect(r.registry.get(AGENT)?.parentId).toBe("Planner");
		const card = r.main.relays[0];
		expect(isRecord(card) ? card.customType : undefined).toBe("irc:relay");
		expect(isRecord(card) ? card.content : "").toContain(`\`Planner\` → \`${AGENT}\``);
	});

	test("a broadcast from the main agent reaches every running or idle cloud agent", async () => {
		const r = await rig();
		r.agents.observe(running());
		r.client.answer = async (_t, m) => ({ receipt: "injected", id: m.id ?? "", turn: null });
		const result = await write(r, "all", "stand by");
		expect(textOf(result)).toContain("Broadcast delivered to 1 of 1 peer(s).");
		expect(textOf(result)).toContain(`- ${AGENT}: injected`);
		expect(r.client.irc[0]?.message.body).toBe("stand by");
	});

	test("the cloud tool's send is the same delivery: from Main, through the same receipt", async () => {
		const r = await rig();
		r.agents.observe(ended());
		const sent = await r.agents.send(ID, "do the farewell");
		expect(sent).toEqual({ receipt: "woken", turn: 2 });
		expect(r.client.irc[0]?.message.from).toBe("Main");
		expect(shimOf(r).isStreaming).toBe(true);
		await expect(r.agents.send("unknown-thread", "x")).rejects.toThrow("not a cloud agent");
	});
});

/** With omp 18.12.5's `unansweredSends`: the agents `from` messaged that have not answered. Older omp has none, and nothing is asserted. */
function unansweredOf(from: string, expected: string[]): void {
	const bus = IrcBus.global();
	const call: unknown = Reflect.get(bus, "unansweredSends");
	if (typeof call !== "function") return;
	const sends: unknown = call.call(bus, from, 0);
	expect(Array.isArray(sends) ? sends.map(s => (isRecord(s) ? s.to : undefined)) : sends).toEqual(expected);
}

describe("inbound IRC: a message the cloud agent sends reaches its recipient's session once", () => {
	test("one delivery, from the agent id, again after the events are replayed", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.agents.event(d, ircEvent(5, {}));
		await until(() => r.main.delivered.length === 1);
		const [msg] = r.main.delivered;
		expect(msg).toMatchObject({ id: "m-1", from: AGENT, to: "Main", body: "need the file name", ts: Date.parse("2026-01-01T00:00:30Z") });
		expect(msg?.replyTo).toBeUndefined();

		// The watcher replays the stream after a reconnect: the message is not drawn twice.
		r.agents.event(d, ircEvent(5, {}));
		r.agents.event(running(), ircEvent(5, {}));
		// The fake session records a delivery as it is made: a repeat would already be in the list.
		expect(r.main.delivered).toHaveLength(1);
		expect(r.warns).toEqual([]);
	});

	test("a replay in a new session is dropped by the irc:incoming entries the session recorded", async () => {
		const r = await rig();
		r.entries.push({ type: "custom_message", customType: "irc:incoming", details: { id: "m-1", from: AGENT } });
		const d = running();
		r.agents.observe(d);
		r.agents.event(d, ircEvent(5, {}));
		r.agents.event(d, ircEvent(6, { id: "m-2", body: "second question", replyTo: "q-9" }));
		await until(() => r.main.delivered.length === 1);
		expect(r.main.delivered[0]).toMatchObject({ id: "m-2", from: AGENT, replyTo: "q-9" });
		// The fake session records a delivery as it is made: the replayed message was not handed over again.
		expect(r.main.delivered).toHaveLength(1);
	});

	test("an addressed local agent gets it; an unknown address falls back to the parent", async () => {
		const r = await rig();
		const reviewer = new FakeSession();
		r.registry.register({ id: "Reviewer", displayName: "Reviewer", kind: "sub", session: reviewer as unknown as AgentSession, status: "running" });
		const d = running();
		r.agents.observe(d);
		r.agents.event(d, ircEvent(5, { id: "m-3", to: "Reviewer" }));
		r.agents.event(d, ircEvent(6, { id: "m-4", to: "vm-agent-elsewhere" }));
		await until(() => reviewer.delivered.length === 1 && r.main.delivered.length === 1);
		expect(reviewer.delivered[0]).toMatchObject({ id: "m-3", from: AGENT, to: "Reviewer" });
		expect(r.main.delivered[0]).toMatchObject({ id: "m-4", from: AGENT, to: "Main" });
	});

	test("a recipient that cannot take it is warned about, and a failed delivery is retried by the next replay", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.main.failWith = new Error("recipient is shutting down");
		r.agents.event(d, ircEvent(5, {}));
		await until(() => r.warns.length === 1);
		expect(r.warns[0]).toContain(`${AGENT}'s message to Main was not delivered: recipient is shutting down`);
		r.main.failWith = undefined;
		r.agents.event(d, ircEvent(5, {}));
		await until(() => r.main.delivered.length === 1);
		expect(r.main.delivered[0]?.id).toBe("m-1");

		// Main is gone: nobody here to take it.
		r.registry.unregister("Main");
		r.agents.event(d, ircEvent(7, { id: "m-7" }));
		expect(r.warns.at(-1)).toContain(`${AGENT} wrote to Main, which is not running here`);
	});

	test("the reply of a turn a message woke goes back to the sender once, as omp's wake relay, and no other path delivers it", async () => {
		const r = await rig();
		r.agents.observe(ended());
		await write(r, AGENT, "also do the farewell");
		const msgId = r.client.irc[0]?.message.id ?? "";
		expect(msgId).not.toBe("");

		r.agents.observe(second("running", { origin: "irc", ircFrom: "Main", ircId: msgId }));
		expect(r.agents.relayed(ID, 2)).toBe(false);
		r.agents.observe(second("done", { origin: "irc", ircFrom: "Main", ircId: msgId }));
		expect(r.agents.relayed(ID, 2)).toBe(true);
		await shimOf(r).waitForIrcReplies();

		expect(r.main.delivered).toHaveLength(1);
		const relay = r.main.delivered[0];
		expect(relay).toMatchObject({ from: AGENT, to: "Main", replyTo: msgId, wakeRelay: true });
		expect(relay?.body).toContain("Turn 2 done: Farewell");
		expect(relay?.body).toContain("Second reply.");
		expect(relay?.body).toContain(`Full result: agent://${AGENT}`);
		// A later observe of the same state relays nothing again.
		r.agents.observe(second("done", { origin: "irc", ircFrom: "Main", ircId: msgId }));
		await shimOf(r).waitForIrcReplies();
		expect(r.main.delivered).toHaveLength(1);
		expect((await read(r, `agent://${AGENT}`)).content).toBe("Second reply.");
	});

	test("a relay the recipient refuses is reported, and the turn is not counted as relayed", async () => {
		const r = await rig();
		r.agents.observe(ended());
		await write(r, AGENT, "also do the farewell");
		const msgId = r.client.irc[0]?.message.id ?? "";
		r.main.failWith = new Error("main is shutting down");
		r.agents.observe(second("running", { origin: "irc", ircFrom: "Main", ircId: msgId }));
		r.agents.observe(second("done", { origin: "irc", ircFrom: "Main", ircId: msgId }));
		await shimOf(r).waitForIrcReplies();
		expect(r.relayFailures).toEqual(["2: main is shutting down"]);
		expect(r.agents.relayed(ID, 2)).toBe(false);
	});
});

describe("the wait path: what omp's wait and roster read of the agent", () => {
	test("the roster lists the agent while it runs and while it is idle, never the agent to itself", async () => {
		const r = await rig();
		r.agents.observe(running());
		expect(r.registry.listVisibleTo("Main").map(ref => ref.id)).toEqual([AGENT]);
		expect(r.registry.listVisibleTo(AGENT).map(ref => ref.id)).toEqual(["Main"]);
		r.agents.observe(ended());
		expect(r.registry.get(AGENT)?.status).toBe("idle");
		expect(r.registry.listVisibleTo("Main").map(ref => ref.id)).toEqual([AGENT]);
		r.agents.release(ID);
		expect(r.registry.listVisibleTo("Main")).toEqual([]);
	});

	test("after a write the agent streams; its agent_end follows the end of the turn and waitForIrcReplies has settled", async () => {
		const r = await rig();
		r.agents.observe(ended());
		await write(r, AGENT, "also do the farewell");
		const ref = r.registry.get(AGENT);
		expect(ref?.session?.isStreaming).toBe(true);
		expect(r.registry.isRunning(ref!)).toBe(true);
		expect(typeof ref?.session?.runStartedAt).toBe("number");

		const seen: string[] = [];
		const stop = shimOf(r).subscribe(e => void seen.push(e.type));
		const statuses: string[] = [];
		const stopStatus = shimOf(r).subscribeRunState(s => void statuses.push(s));
		const msgId = r.client.irc[0]?.message.id ?? "";
		r.agents.observe(second("running", { origin: "irc", ircFrom: "Main", ircId: msgId }));
		expect(seen).toEqual([]);
		r.agents.observe(second("done", { origin: "irc", ircFrom: "Main", ircId: msgId }));
		await shimOf(r).waitForIrcReplies();
		expect(seen).toEqual(["agent_end"]);
		expect(statuses).toEqual(["idle"]);
		expect(ref?.session?.isStreaming).toBe(false);
		expect(ref?.status).toBe("idle");
		expect(r.registry.isRunning(ref!)).toBe(false);
		stop();
		stopStatus();
		// The relay was delivered before agent_end: the wait that follows it has the reply in hand.
		expect(r.main.delivered).toHaveLength(1);
	});

	test("agent_start is emitted when a turn starts", async () => {
		const r = await rig();
		r.agents.observe(ended());
		const seen: string[] = [];
		shimOf(r).subscribe(e => void seen.push(e.type));
		r.agents.observe(second("running"));
		expect(seen).toEqual(["agent_start"]);
	});

	test("omp's own WaitTool, blocked on the agent's job, returns when the turn ends with the result and the structured pointer", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		const tool = new WaitTool(session(r));
		const result = tool.execute("t1", {});
		await until(() => r.manager.isDeliverySuppressed(AGENT));

		const done = ended();
		r.agents.observe(done);
		expect(r.jobs.settle(done, done.turns[0] as ThreadTurn)).toEqual({ id: AGENT, waited: true, native: true });
		const out = await result;
		const text = out.content[0]?.type === "text" ? out.content[0].text : "";
		expect(text).toContain(`### ${AGENT} [task] — completed`);
		expect(text).toContain("Turn 1 done: Greeting fixed");
		expect(text).toContain(`Structured output: schema valid; full payload at agent://${AGENT}, fields via agent://${AGENT}/<field>`);
		// The wait returned the result itself: omp does not deliver it a second time.
		await r.manager.drainDeliveries({ timeoutMs: 500 });
		expect(r.delivered).toEqual([]);
	});
});

/** The parts of a `ToolSession` omp's job tools read. */
function session(r: Rig): ToolSession {
	return { settings: Settings.isolated({ "launch.enabled": false }), agentRegistry: r.registry, getAgentId: () => "Main", asyncJobManager: r.manager } as unknown as ToolSession;
}

/** The text of omp's own async-result message for one delivered job. */
function asyncResult(d: Delivered): { text: string; details: unknown } {
	const message = buildAsyncResultBatchMessage([{ jobId: d.jobId, result: d.text, job: d.job, durationMs: undefined, epoch: 0 }]);
	if (!message) throw new Error("no message");
	return { text: typeof message.content === "string" ? message.content : message.content.map(c => (c.type === "text" ? c.text : "")).join(""), details: message.details };
}

describe("jobs and structured results with omp's AsyncJobManager", () => {
	test("a running turn is a job owned by Main whose agentId is the registry ref id", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		expect(r.jobs.jobId(ID)).toBe(AGENT);
		const job = r.manager.getJob(AGENT);
		expect(job).toMatchObject({ id: AGENT, type: "task", label: AGENT, status: "running", ownerId: "Main", agentId: AGENT });
		expect(r.agents.agentId(ID)).toBe(AGENT);
		expect(r.manager.isDeliverySuppressed(AGENT)).toBe(false);
	});

	test("a model-started thread: the turn ends, the job completes with the structured payload, omp delivers it, no card is posted", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);

		const done = ended("done", { reply: "All done. The farewell too." });
		const t = done.turns[0] as ThreadTurn;
		// The watcher's order: the agents publish the turn before the job settles.
		r.agents.observe(done);
		const settled = r.jobs.settle(done, t);
		expect(settled).toEqual({ id: AGENT, waited: false, native: true });

		const job = r.manager.getJob(AGENT) as AsyncJob;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(job.structured?.status).toBe("valid");
		expect(job.structured?.data).toEqual(JSON.parse(readFileSync(join(r.dir, `${AGENT}.json`), "utf8")));
		expect(job.structured?.data).toMatchObject({ thread: ID, turn: 1, state: "done", reply: "All done. The farewell too.", branch: BRANCH, title: "Greeting fixed" });

		await until(() => r.delivered.length === 1);
		expect(r.manager.isDeliverySuppressed(AGENT)).toBe(false);
		const delivery = r.delivered[0] as Delivered;
		expect(delivery.job?.structured?.status).toBe("valid");
		const { text, details } = asyncResult(delivery);
		expect(text).toContain(`Background job ${AGENT} has completed.`);
		expect(text).toContain("Turn 1 done: Greeting fixed");
		expect(text).toContain("Structured output: schema valid");
		expect(text).toContain(`full payload at agent://${AGENT}, fields via agent://${AGENT}/<field>[/<index>/…]`);
		expect(details).toMatchObject({ jobs: [{ jobId: AGENT, type: "task", status: "completed", agentId: AGENT, schema: { status: "valid", data: { reply: "All done. The farewell too.", branch: BRANCH, thread: ID } } }] });
		// What the message points at resolves through omp's own handler to the same payload.
		expect((await read(r, `agent://${AGENT}/branch`)).content).toBe(BRANCH);
		expect((await read(r, `agent://${AGENT}/reply`)).content).toBe("All done. The farewell too.");

		const host = fakeHost();
		const pi = fakePi();
		const cards = new Deliverer(pi.pi);
		cards.setOrigin(ID, "tool");
		cards.turn(host.host, done, t, [], settled);
		expect(pi.sent).toEqual([]);
	});

	test("a user thread: its job's delivery is acknowledged (omp delivers nothing) and the card is posted", async () => {
		const r = await rig();
		r.origin.value = "user";
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		expect(r.manager.isDeliverySuppressed(AGENT)).toBe(true);

		const done = ended();
		const t = done.turns[0] as ThreadTurn;
		r.agents.observe(done);
		const settled = r.jobs.settle(done, t);
		expect(settled).toEqual({ id: AGENT, waited: false, native: false });
		await (r.manager.getJob(AGENT) as AsyncJob).promise;
		expect(r.manager.getJob(AGENT)?.structured?.status).toBe("valid");
		await r.manager.drainDeliveries({ timeoutMs: 500 });
		expect(r.delivered).toEqual([]);

		const host = fakeHost();
		const pi = fakePi();
		const cards = new Deliverer(pi.pi);
		cards.setOrigin(ID, "user");
		cards.turn(host.host, done, t, [], settled);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.message.customType).toBe("omp-cloud");
	});

	test("an IRC-woken turn of a model's thread: the wake relay delivers, the job is acknowledged, no card: never both", async () => {
		const r = await rig();
		r.agents.observe(ended());
		await write(r, AGENT, "also do the farewell");
		const msgId = r.client.irc[0]?.message.id ?? "";
		const running2 = second("running", { origin: "irc", ircFrom: "Main", ircId: msgId });
		r.agents.observe(running2);
		r.jobs.sync(running2, []);
		expect(r.manager.isDeliverySuppressed(AGENT)).toBe(true);

		const done = second("done", { origin: "irc", ircFrom: "Main", ircId: msgId });
		const t = done.turns[1] as ThreadTurn;
		r.agents.observe(done);
		const settled = r.jobs.settle(done, t);
		expect(settled).toEqual({ id: AGENT, waited: false, native: false });
		await shimOf(r).waitForIrcReplies();
		await r.manager.drainDeliveries({ timeoutMs: 500 });

		const host = fakeHost();
		const pi = fakePi();
		const cards = new Deliverer(pi.pi);
		cards.setOrigin(ID, "tool");
		cards.turn(host.host, done, t, [], settled, r.agents.relayed(ID, 2));
		expect(r.main.delivered).toHaveLength(1);
		expect(r.main.delivered[0]?.wakeRelay).toBe(true);
		expect(r.delivered).toEqual([]);
		expect(pi.sent).toEqual([]);
	});

	test("an IRC-woken turn whose sender is gone has no relay: the job stays acknowledged and the card is the one delivery", async () => {
		const r = await rig();
		r.agents.observe(ended());
		await write(r, AGENT, "also do the farewell");
		const msgId = r.client.irc[0]?.message.id ?? "";
		const running2 = second("running", { origin: "irc", ircFrom: "Main", ircId: msgId });
		r.agents.observe(running2);
		r.jobs.sync(running2, []);
		r.registry.unregister("Main");

		const done = second("done", { origin: "irc", ircFrom: "Main", ircId: msgId });
		const t = done.turns[1] as ThreadTurn;
		r.agents.observe(done);
		const settled = r.jobs.settle(done, t);
		await shimOf(r).waitForIrcReplies();
		expect(r.agents.relayed(ID, 2)).toBe(false);
		await r.manager.drainDeliveries({ timeoutMs: 500 });
		expect(r.delivered).toEqual([]);

		const host = fakeHost();
		const pi = fakePi();
		const cards = new Deliverer(pi.pi);
		cards.setOrigin(ID, "tool");
		cards.turn(host.host, done, t, [], settled, r.agents.relayed(ID, 2));
		expect(pi.sent).toHaveLength(1);
		expect(r.main.delivered).toEqual([]);
	});

	test("a failed turn rejects with an AsyncJobError whose structured payload omp keeps and delivers", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		const failed = ended("failed", { error: "tests still fail", reply: "" });
		const t = failed.turns[0] as ThreadTurn;
		r.agents.observe(failed);
		expect(r.jobs.settle(failed, t)).toEqual({ id: AGENT, waited: false, native: true });

		const job = r.manager.getJob(AGENT) as AsyncJob;
		await job.promise;
		expect(job.status).toBe("failed");
		expect(job.errorText).toContain("Turn 1 failed: Greeting fixed");
		expect(job.errorText).toContain("Error: tests still fail");
		expect(job.structured).toMatchObject({ status: "valid", data: { state: "failed", error: "tests still fail", thread: ID } });
		expect((await read(r, `agent://${AGENT}`)).content).toBe("Turn 1 failed: tests still fail");

		await until(() => r.delivered.length === 1);
		const { text, details } = asyncResult(r.delivered[0] as Delivered);
		expect(text).toContain("Turn 1 failed: Greeting fixed");
		expect(text).toContain(`full payload at agent://${AGENT}`);
		expect(details).toMatchObject({ jobs: [{ status: "failed", schema: { data: { state: "failed" } } }] });
		expect(new AsyncJobError("x").structured).toBeUndefined();
	});

	test("a stopped turn is acknowledged, as the model stopped it: omp delivers nothing, the card is not the model's", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		const stopped = ended("cancelled", { error: "", reply: "" });
		const t = stopped.turns[0] as ThreadTurn;
		r.agents.observe(stopped);
		expect(r.jobs.settle(stopped, t)).toEqual({ id: AGENT, waited: false, native: false });
		const job = r.manager.getJob(AGENT) as AsyncJob;
		await job.promise;
		expect(job.status).toBe("failed");
		expect(job.structured?.data).toMatchObject({ state: "cancelled" });
		await r.manager.drainDeliveries({ timeoutMs: 500 });
		expect(r.delivered).toEqual([]);
		expect((await read(r, `agent://${AGENT}`)).content).toBe("Turn 1 cancelled: no details");
	});

	test("a second turn's job takes the next free id but keeps the agent id as its agentId", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		const done = ended();
		r.agents.observe(done);
		r.jobs.settle(done, done.turns[0] as ThreadTurn);
		await (r.manager.getJob(AGENT) as AsyncJob).promise;

		const again = second("running");
		r.agents.observe(again);
		r.jobs.sync(again, []);
		expect(r.jobs.jobId(ID)).toBe(`${AGENT}-2`);
		expect(r.manager.getJob(`${AGENT}-2`)).toMatchObject({ agentId: AGENT, ownerId: "Main", status: "running" });
		expect(r.agents.agentId(ID)).toBe(AGENT);
	});
});

describe("cancel against teardown", () => {
	test("a cancel from omp stops the cloud turn once and tells the model", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		expect(r.manager.cancel(AGENT, { ownerId: "Main" })).toBe(true);
		expect(r.stops).toEqual([ID]);
		expect(r.asides).toEqual([[ID, "Fix greeting bug"]]);
		expect(r.warns.some(w => w.includes("Fix greeting bug was cancelled in omp"))).toBe(true);
		expect(r.manager.getJob(AGENT)?.status).toBe("cancelled");
		// The cancelled turn is declined: the next event does not register it again.
		r.jobs.sync(d, []);
		expect(r.jobs.has(ID)).toBe(false);
		expect(r.manager.getRunningJobs()).toEqual([]);
		expect(r.stops).toEqual([ID]);
	});

	test("omp's executeCancel, the model's cancel of the job, is the same cancel", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		const result = await executeCancel(session(r), r.manager, "Main", [AGENT]);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(`Cancelled background job ${AGENT}.`);
		expect(r.stops).toEqual([ID]);
		expect(r.asides).toHaveLength(1);
	});

	test("a cancel inside a session switch is omp's cleanup: no stop; the next event registers the job again, and a later cancel stops", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		r.jobs.beginTransition();
		expect(r.manager.cancel(AGENT)).toBe(true);
		expect(r.stops).toEqual([]);
		expect(r.asides).toEqual([]);
		expect(r.warns.filter(w => w.includes("cancelled in omp"))).toEqual([]);

		r.jobs.sync(d, []);
		expect(r.jobs.has(ID)).toBe(true);
		const next = r.jobs.jobId(ID) as string;
		expect(next).toBe(`${AGENT}-2`);
		r.jobs.endTransition();
		expect(r.manager.cancel(next)).toBe(true);
		expect(r.stops).toEqual([ID]);
	});

	test("omp's /clear cancels the jobs inside a session transition without any session event: no stop; a /jobs cancel outside one stops", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		// What `AgentSession.resetSessionContext` does: open a transition, cancel the owner's jobs with no reason, close it. No `session_before_switch` fires.
		r.main.transition(() => r.manager.cancelAll({ ownerId: "Main" }));
		expect(r.stops).toEqual([]);
		expect(r.asides).toEqual([]);
		expect(r.warns.filter(w => w.includes("cancelled in omp"))).toEqual([]);
		expect(r.main.isSessionTransitioning).toBe(false);

		// The turn still runs: the next event registers the job again, and a cancel outside a transition is the user's.
		r.jobs.sync(d, []);
		const next = r.jobs.jobId(ID) as string;
		expect(r.manager.cancel(next)).toBe(true);
		expect(r.stops).toEqual([ID]);
		expect(r.asides).toHaveLength(1);
	});

	test("a session without the getter (or no Main) reads as not transitioning: the cancel stops", async () => {
		const r = await rig({ main: false });
		expect(r.agents.ownerTransitioning()).toBe(false);
		r.registry.register({ id: "Main", displayName: "Main", kind: "main", session: {} as unknown as AgentSession, status: "idle" });
		expect(r.agents.ownerTransitioning()).toBe(false);
	});
	test("omp's shutdown reason does not stop the cloud turn, for cancelAll or for dispose", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		r.manager.cancelAll({ ownerId: "Main" }, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		expect(r.stops).toEqual([]);
		expect(r.manager.getJob(AGENT)?.status).toBe("cancelled");

		const other = await rig();
		other.agents.observe(running());
		other.jobs.sync(running(), []);
		expect(other.manager.getRunningJobs()).toHaveLength(1);
		await other.manager.dispose({ timeoutMs: 200 });
		expect(other.stops).toEqual([]);
		expect(other.asides).toEqual([]);
	});

	test("a job the session releases ends without stopping the thread", async () => {
		const r = await rig();
		const d = running();
		r.agents.observe(d);
		r.jobs.sync(d, []);
		r.jobs.release(ID);
		expect(r.manager.getJob(AGENT)?.status).toBe("cancelled");
		expect(r.stops).toEqual([]);
	});

	test("the agent's own abort, what a kill of the agent calls, stops the cloud turn", async () => {
		const r = await rig();
		r.agents.observe(running());
		await shimOf(r).abort({ reason: "user" });
		expect(r.client.stops).toEqual([ID]);

		r.client.stopError = unavailable({ message: "the cloud is unavailable" });
		await expect(shimOf(r).abort({ reason: "user" })).rejects.toThrow(`cannot stop ${AGENT}: the cloud is unavailable`);
	});

	test("omp's cancelAgentRegistration, the kill of an agent without a job: aborts the turn, disposes the session, drops the ref", async () => {
		const r = await rig();
		r.agents.observe(running());
		const outcome = await cancelAgentRegistration(session(r), "Main", AGENT);
		expect(outcome).toMatchObject({ id: AGENT, status: "cancelled" });
		expect(r.client.stops).toEqual([ID]);
		expect(r.registry.get(AGENT)).toBeUndefined();

		// The thread keeps living in the cloud: the next observe registers a fresh ref.
		r.agents.observe(running());
		expect(r.registry.get(AGENT)?.kind).toBe("sub");
	});

	test("a kill of an agent another agent owns is refused by omp", async () => {
		const r = await rig();
		r.agents.observe(running());
		const outcome = await cancelAgentRegistration(session(r), "Planner", AGENT);
		expect(outcome.status).toBe("not_found");
		expect(r.client.stops).toEqual([]);
		expect(r.registry.get(AGENT)).toBeDefined();
	});
});
