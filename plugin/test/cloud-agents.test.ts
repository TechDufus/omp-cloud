import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { AGENT_IDS } from "../src/cards";
import { CloudAgents, CloudSession, IRC_CAPABILITY, SHIM_MEMBERS, turnPayload, type AgentsClient } from "../src/cloud-agents";
import { CloudError } from "../src/errors";
import type { IrcReceipt, IrcReceiptKind, ThreadDetail, ThreadTurn } from "../src/types";
import { detail, event, metrics, turn } from "./builders";
import { until } from "./fakes";

const ID = "aaaaaak3x9fa";
const JOB = "FixGreetingBug";
const NAME = "Fix greeting bug";
const AT = "2026-01-01T00:00:00Z";

/** The thread between turns, and while a turn is queued or running. */
const idle = (turns: ThreadTurn[], over: Partial<ThreadDetail> = {}): ThreadDetail => detail({ id: ID, name: NAME, phase: "idle", turns, ...over });
const working = (turns: ThreadTurn[], over: Partial<ThreadDetail> = {}): ThreadDetail => detail({ id: ID, name: NAME, phase: "working", turns, ...over });
const archived = (turns: ThreadTurn[]): ThreadDetail => idle(turns, { archivedAt: "2026-01-02T00:00:00Z" });

/** A turn a message from `Main` queued (or ended, with `over`). */
const ircTurn = (id: number, ircId: string, over: Partial<ThreadTurn> = {}): ThreadTurn =>
	turn(id, { origin: "irc", ircFrom: "Main", ircId, text: "hello", reply: "The fix is in", title: "Greeting fixed", ...over });
const queued = (id: number, ircId: string): ThreadTurn => ircTurn(id, ircId, { state: "queued", startedAt: "", completedAt: "", reply: "", title: "" });

const message = (id: string, over: Partial<IrcMessage> = {}): IrcMessage => ({ id, from: "Main", to: JOB, body: "hello", ts: 1, ...over });

/** Lets every promise that can already resolve run its continuations. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A local agent's session: records what omp's IRC delivers to it. */
class Inbox {
	readonly messages: IrcMessage[] = [];
	attempts = 0;
	fail: Error | undefined;
	gate: Promise<void> | undefined;

	async deliverIrcMessage(msg: IrcMessage): Promise<IrcReceiptKind> {
		this.attempts++;
		if (this.fail) throw this.fail;
		this.messages.push(msg);
		await this.gate;
		return "injected";
	}
}

const asSession = (inbox: Inbox): AgentSession => inbox as unknown as AgentSession;

interface ClientScript {
	/** The service lacks `threads.irc`. */
	skew: boolean;
	answer: IrcReceipt;
	ircError: Error | undefined;
	stopError: Error | undefined;
	/** The turn the queue fallback's `sendMessage` returns. */
	sent: ThreadTurn;
}

interface Rig {
	registry: AgentRegistry;
	agents: CloudAgents;
	main: Inbox;
	script: ClientScript;
	calls: { irc: { thread: string; body: Parameters<AgentsClient["irc"]>[1] }[]; send: { thread: string; text: string }[]; stop: string[]; caps: string[] };
	warnings: string[];
	follows: string[];
	relayFailures: { turn: number; reason: string }[];
	entries: unknown[];
	clock: { t: number };
	dir: string;
}

interface RigOptions {
	/** `Main` is registered without a session (parked). */
	parkedMain?: boolean;
	/** No `dir` option: the agents make a temporary one. */
	ownDir?: boolean;
	hydrate?: boolean;
	download?: (thread: string, dest: string) => Promise<void>;
}

const rigs: Rig[] = [];
const dirs: string[] = [];

function rig(options: RigOptions = {}): Rig {
	const dir = mkdtempSync(join(tmpdir(), "omp-cloud-agents-test-"));
	dirs.push(dir);
	const registry = new AgentRegistry();
	const main = new Inbox();
	registry.register({ id: "Main", displayName: "Main", kind: "main", session: options.parkedMain ? null : asSession(main), status: "idle" });
	const script: ClientScript = { skew: false, answer: { receipt: "injected", id: "x", turn: null }, ircError: undefined, stopError: undefined, sent: queued(2, "") };
	const calls: Rig["calls"] = { irc: [], send: [], stop: [], caps: [] };
	const client: AgentsClient = {
		async requireCapability(capability) {
			calls.caps.push(capability);
			if (script.skew) throw new CloudError({ code: "version_skew", message: "the service is too old", retriable: false, outcomeKnown: true });
		},
		async irc(thread, body) {
			calls.irc.push({ thread, body });
			if (script.ircError) throw script.ircError;
			return script.answer;
		},
		async sendMessage(thread, text) {
			calls.send.push({ thread, text });
			return { turn: script.sent, interrupted: false, cancelled: [] };
		},
		async stop(thread) {
			calls.stop.push(thread);
			if (script.stopError) throw script.stopError;
			return { stoppedRunning: true, cancelled: 0 };
		},
		async downloadConversation(thread, dest) {
			await (options.download ?? (async () => {}))(thread, dest);
		},
	};
	const r: Rig = { registry, main, script, calls, warnings: [], follows: [], relayFailures: [], entries: [], clock: { t: 5000 }, dir, agents: undefined as unknown as CloudAgents };
	r.agents = new CloudAgents({
		client: async () => client,
		follow: thread => r.follows.push(thread),
		warn: message => r.warnings.push(message),
		cwd: () => "/work",
		entries: () => r.entries,
		relayFailed: (_detail, t, reason) => r.relayFailures.push({ turn: t.id, reason }),
		registry: () => registry,
		...(options.ownDir ? {} : { dir }),
		hydrate: options.hydrate ?? false,
		now: () => r.clock.t,
	});
	rigs.push(r);
	return r;
}

afterEach(() => {
	for (const r of rigs.splice(0)) r.agents.dispose();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function shimOf(r: Rig, id = JOB): CloudSession {
	const session = r.registry.get(id)?.session;
	if (!(session instanceof CloudSession)) throw new Error(`${id} has no cloud session`);
	return session;
}

const statusOf = (r: Rig, id = JOB): string | undefined => r.registry.get(id)?.status;

/** The JSON text of an `irc` thread event: a message the cloud agent sent out. */
const ircEvent = (seq: number, over: Record<string, string> = {}) =>
	event(seq, { kind: "irc", turn: 1, text: JSON.stringify({ id: "i1", from: "agent", to: "Main", body: "hi", replyTo: "", at: AT, ...over }) });

describe("registry ref", () => {
	test("one sub-agent ref per thread, parented by Main, running while a turn is live and idle between turns", () => {
		const r = rig();
		r.agents.observe(working([turn(1, { state: "running" })]));
		const ref = r.registry.get(JOB);
		expect(ref).toMatchObject({ id: JOB, displayName: JOB, kind: "sub", parentId: "Main", sessionFile: null, status: "running" });
		expect(ref?.session).toBeInstanceOf(CloudSession);
		expect(r.agents.agentId(ID)).toBe(JOB);
		const session = ref?.session;

		r.agents.observe(working([turn(1, { state: "running", text: "again" })]));
		expect(r.registry.list().filter(x => x.kind === "sub")).toHaveLength(1);
		expect(r.registry.get(JOB)?.session).toBe(session);

		r.agents.observe(idle([turn(1)]));
		expect(statusOf(r)).toBe("idle");
		r.agents.observe(working([turn(1), turn(2, { state: "queued" })]));
		expect(statusOf(r)).toBe("running");
	});

	test("an archived thread is idle", () => {
		const r = rig();
		r.agents.observe(archived([turn(1)]));
		expect(statusOf(r)).toBe("idle");
		expect(shimOf(r).isStreaming).toBe(false);
	});

	test("a second thread with the same name gets a numbered id", () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		r.agents.observe(idle([turn(1)], { id: "bbbbbbk3x9fa" }));
		expect(r.agents.agentId(ID)).toBe(JOB);
		expect(r.agents.agentId("bbbbbbk3x9fa")).toBe(`${JOB}-2`);
		expect(r.registry.get(`${JOB}-2`)?.session).toBeInstanceOf(CloudSession);
	});

	test("cards learn the agent id of a registered thread (a numbered one included), and forget it on release and dispose", () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		r.agents.observe(idle([turn(1)], { id: "bbbbbbk3x9fa" }));
		expect(AGENT_IDS.get(ID)).toBe(JOB);
		expect(AGENT_IDS.get("bbbbbbk3x9fa")).toBe(`${JOB}-2`);

		r.agents.release(ID);
		expect(AGENT_IDS.get(ID)).toBeUndefined();
		expect(AGENT_IDS.get("bbbbbbk3x9fa")).toBe(`${JOB}-2`);

		r.agents.dispose();
		expect(AGENT_IDS.get("bbbbbbk3x9fa")).toBeUndefined();
	});

	test("release unregisters the ref and removes its files; retainOnly keeps the named threads", () => {
		const r = rig();
		r.agents.observe(idle([turn(1, { reply: "done" })]));
		r.agents.observe(idle([turn(1, { reply: "done" })], { id: "bbbbbbk3x9fa", name: "Other task" }));
		expect(existsSync(join(r.dir, `${JOB}.md`))).toBe(true);

		r.agents.retainOnly(new Set(["bbbbbbk3x9fa"]));
		expect(r.registry.get(JOB)).toBeUndefined();
		expect(r.agents.agentId(ID)).toBeUndefined();
		expect(existsSync(join(r.dir, `${JOB}.md`))).toBe(false);
		expect(existsSync(join(r.dir, `${JOB}.json`))).toBe(false);
		expect(r.registry.get("OtherTask")).toBeDefined();

		r.agents.release("bbbbbbk3x9fa");
		expect(r.registry.get("OtherTask")).toBeUndefined();
		r.agents.release("bbbbbbk3x9fa");
	});

	test("a ref omp dropped is registered again by the next observe", () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		expect(r.registry.unregister(JOB)).toBe(true);
		r.agents.observe(idle([turn(1)]));
		expect(r.registry.get(JOB)?.session).toBeInstanceOf(CloudSession);
		expect(r.agents.agentId(ID)).toBe(JOB);
	});

	test("dispose removes every ref and the temporary directory the agents made", () => {
		const r = rig({ ownDir: true });
		r.agents.observe(idle([turn(1, { reply: "done" })]));
		const dir = r.agents.dir();
		expect(dir.startsWith(r.dir)).toBe(false);
		expect(existsSync(join(dir, `${JOB}.md`))).toBe(true);
		r.agents.dispose();
		expect(r.registry.get(JOB)).toBeUndefined();
		expect(existsSync(dir)).toBe(false);
	});

	test("dispose leaves a directory it was given", () => {
		const r = rig();
		r.agents.observe(idle([turn(1, { reply: "done" })]));
		r.agents.dispose();
		expect(existsSync(r.dir)).toBe(true);
		expect(existsSync(join(r.dir, `${JOB}.md`))).toBe(false);
	});
});

describe("session shim", () => {
	const UNDEFINED_WHEN_IDLE = ["runStartedAt", "sessionFile", "servingModel", "baseSystemPrompt", "agent.state.streamMessage"];

	/** `path` of `root`: the object that holds the last member, and the member. */
	function member(root: unknown, path: string): { owner: unknown; value: unknown } {
		let owner: unknown = root;
		let value: unknown = root;
		for (const key of path.split(".")) {
			owner = value;
			value = Reflect.get(Object(owner), key);
		}
		return { owner, value };
	}

	test("answers every member omp's paths read, and none throws", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1, { reply: "done" })], { metrics: metrics({ requests: 2 }) }));
		const session = shimOf(r);
		for (const m of SHIM_MEMBERS) {
			const { owner, value } = member(session, m.path);
			if (m.kind === "get") {
				if (!UNDEFINED_WHEN_IDLE.includes(m.path)) expect(value, m.path).toBeDefined();
				continue;
			}
			expect(typeof value, m.path).toBe("function");
			if (typeof value === "function") await Reflect.apply(value, owner, m.args?.() ?? []);
		}
		expect(r.calls.stop).toEqual([ID]);
		expect(r.calls.irc.length).toBeGreaterThanOrEqual(1);
		expect(session.sessionManager.getArtifactsDir()).toBe(r.dir);
		expect(session.sessionManager.getCwd()).toBe("/work");
		expect(session.sessionManager.getSessionId()).toBe(ID);
	});

	test("run state follows the thread: isStreaming, runStartedAt, subscribe, subscribeRunState", () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		const session = shimOf(r);
		const events: string[] = [];
		const states: string[] = [];
		session.subscribe(() => {
			throw new Error("a broken subscriber");
		});
		const off = session.subscribe(e => events.push(e.type));
		session.subscribeRunState(s => states.push(s));
		expect(session.isStreaming).toBe(false);
		expect(session.runStartedAt).toBeUndefined();

		r.clock.t = 7000;
		r.agents.observe(working([turn(1), turn(2, { state: "running" })]));
		expect(session.isStreaming).toBe(true);
		expect(session.runStartedAt).toBe(7000);
		expect(events).toEqual(["agent_start"]);
		expect(states).toEqual(["running"]);

		r.agents.observe(working([turn(1), turn(2, { state: "running", text: "more" })]));
		expect(events).toEqual(["agent_start"]);

		r.agents.observe(idle([turn(1), turn(2)]));
		expect(session.isStreaming).toBe(false);
		expect(events).toEqual(["agent_start", "agent_end"]);
		expect(states).toEqual(["running", "idle"]);

		off();
		r.agents.observe(working([turn(1), turn(2), turn(3, { state: "running" })]));
		expect(events).toEqual(["agent_start", "agent_end"]);
		expect(states).toEqual(["running", "idle", "running"]);
	});

	test("waitForIrcReplies resolves at once with nothing in flight, and only after a relay settled otherwise", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		const session = shimOf(r);
		await session.waitForIrcReplies();

		r.script.answer = { receipt: "woken", id: "m1", turn: queued(2, "m1") };
		await session.deliverIrcMessage(message("m1"));
		const gate = Promise.withResolvers<void>();
		r.main.gate = gate.promise;
		r.agents.observe(idle([turn(1), ircTurn(2, "m1")]));
		let waited = false;
		const wait = session.waitForIrcReplies().then(() => {
			waited = true;
		});
		await settle();
		expect(r.main.messages).toHaveLength(1);
		expect(waited).toBe(false);
		gate.resolve();
		await wait;
		expect(waited).toBe(true);
	});

	describe("messages", () => {
		test("is an array with no history", () => {
			const r = rig();
			r.agents.observe(idle([]));
			expect(shimOf(r).messages).toEqual([]);
		});

		test("shows a running turn's prompt and the events fed through event()", () => {
			const r = rig();
			const d = working([turn(1, { state: "running", text: "fix the greeting", completedAt: "" })]);
			r.agents.observe(d);
			expect(shimOf(r).messages).toMatchObject([{ role: "user", content: "fix the greeting" }]);

			r.agents.event(d, event(1, { kind: "assistant", turn: 1, text: "looking" }));
			r.agents.event(d, event(2, { kind: "tool", turn: 1, text: "bash: ls" }));
			r.agents.event(d, event(3, { kind: "tool_error", turn: 1, text: "exit 1" }));
			r.agents.event(d, event(4, { kind: "assistant", turn: null, text: "not of a turn" }));
			const messages = shimOf(r).messages;
			expect(messages).toHaveLength(2);
			expect(messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "looking\n» bash: ls\n! exit 1" }] });
		});

		test("shows finished turns: the reply, the error of a failed turn and the sender of an irc turn", () => {
			const r = rig();
			r.agents.observe(idle([turn(1, { text: "first", reply: "one" }), turn(2, { state: "failed", text: "second", error: "boom" }), ircTurn(3, "m1", { text: "third", reply: "" })]));
			const messages = shimOf(r).messages;
			expect(Array.isArray(messages)).toBe(true);
			expect(messages).toMatchObject([
				{ role: "user", content: "first" },
				{ role: "assistant", content: [{ type: "text", text: "one" }], stopReason: "stop" },
				{ role: "user", content: "second" },
				{ role: "assistant", content: [{ type: "text", text: "boom" }], stopReason: "error" },
				{ role: "user", content: "[irc from Main] third" },
			]);
		});

		test("reads the exported conversation after ingest, with a later running turn after it", async () => {
			const r = rig();
			const d = idle([turn(1, { text: "ask", reply: "answer" })]);
			r.agents.observe(d);
			const session = [
				{ type: "session", version: 3, id: "01990000-0000-7000-8000-000000000001", timestamp: "2026-10-18T22:11:00.000Z", cwd: "/cloud/work", title: "t" },
				{ type: "message", id: "e1", parentId: null, timestamp: "2026-10-18T22:11:01.000Z", message: { role: "user", content: [{ type: "text", text: "exported ask" }], timestamp: 1 } },
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: "2026-10-18T22:11:02.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "exported answer" }],
						api: "x",
						provider: "p",
						model: "m",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "stop",
						timestamp: 2,
					},
				},
			];
			const archive = join(r.dir, "conversation.tar");
			writeFileSync(archive, await new Bun.Archive({ "session.jsonl": `${session.map(e => JSON.stringify(e)).join("\n")}\n` }).bytes());
			await r.agents.ingest(ID, archive);

			expect(existsSync(join(r.dir, `${JOB}.jsonl`))).toBe(true);
			expect(shimOf(r).messages).toMatchObject([
				{ role: "user", content: [{ type: "text", text: "exported ask" }] },
				{ role: "assistant", content: [{ type: "text", text: "exported answer" }] },
			]);

			r.agents.observe(working([turn(1), turn(2, { state: "running", text: "next", completedAt: "" })]));
			expect(shimOf(r).messages.map(m => Reflect.get(Object(m), "role"))).toEqual(["user", "assistant", "user"]);

			r.agents.observe(idle([turn(1), turn(2, { text: "next", reply: "later" })]));
			expect(JSON.stringify(shimOf(r).messages)).toContain("later");
		});

		test("hydrates a thread first seen with finished turns from the service's conversation", async () => {
			const entries = [
				{ type: "session", version: 3, id: "01990000-0000-7000-8000-000000000002", timestamp: "2026-10-18T22:11:00.000Z", cwd: "/w" },
				{ type: "message", id: "e1", parentId: null, timestamp: "2026-10-18T22:11:01.000Z", message: { role: "user", content: [{ type: "text", text: "hydrated ask" }], timestamp: 1 } },
			];
			const r = rig({
				hydrate: true,
				download: async (_thread, dest) => {
					writeFileSync(dest, await new Bun.Archive({ "session.jsonl": `${entries.map(e => JSON.stringify(e)).join("\n")}\n` }).bytes());
				},
			});
			r.agents.observe(idle([turn(1, { reply: "answer" })]));
			await until(() => JSON.stringify(shimOf(r).messages).includes("hydrated ask"));
		});
	});

	test("abort stops the cloud turn; a client failure surfaces as an Error; dispose does not stop it", async () => {
		const r = rig();
		r.agents.observe(working([turn(1, { state: "running" })]));
		const session = shimOf(r);
		await session.abort({ reason: "user" });
		expect(r.calls.stop).toEqual([ID]);

		r.script.stopError = new CloudError({ code: "unreachable", message: "cannot reach the service", retriable: true, outcomeKnown: true });
		const failure = await session.abort().catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(Error);
		expect(String(Reflect.get(Object(failure), "message"))).toContain("cannot reach the service");
		expect(String(Reflect.get(Object(failure), "message"))).toContain(JOB);

		const listener: string[] = [];
		session.subscribe(e => listener.push(e.type));
		await session.dispose();
		expect(r.calls.stop).toEqual([ID, ID]);
		r.agents.observe(idle([turn(1)]));
		expect(listener).toEqual([]);
		expect(r.registry.get(JOB)).toBeDefined();
	});
});

describe("deliverIrcMessage", () => {
	test("injected into a running thread: the service's receipt, the sanitized sender, one follow", async () => {
		const r = rig();
		r.agents.observe(working([turn(1, { state: "running" })]));
		r.script.answer = { receipt: "injected", id: "m1", turn: null };
		const receipt = await shimOf(r).deliverIrcMessage(message("m1", { from: "Fix Agent/ü 1", replyTo: "r1" }));
		expect(receipt).toBe("injected");
		expect(r.calls.caps).toEqual([IRC_CAPABILITY]);
		expect(r.calls.irc).toEqual([{ thread: ID, body: { from: "Fix_Agent___1", body: "hello", id: "m1", replyTo: "r1" } }]);
		expect(r.follows).toEqual([ID]);
		expect(shimOf(r).isStreaming).toBe(true);
	});

	test("the sender is cut to 64 characters, and an empty one is Main", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		await shimOf(r).deliverIrcMessage(message("m1", { from: "é".repeat(100) }));
		await shimOf(r).deliverIrcMessage(message("m2", { from: "" }));
		const [long, empty] = r.calls.irc.map(c => c.body.from);
		expect(long).toMatch(/^[A-Za-z0-9._-]{64}$/);
		expect(empty).toBe("Main");
		expect("replyTo" in (r.calls.irc[0]?.body ?? {})).toBe(false);
	});

	for (const [receipt, thread] of [
		["woken", idle([turn(1)])],
		["revived", archived([turn(1)])],
	] as const) {
		test(`${receipt}: the agent counts as running at once, until the queued turn ends`, async () => {
			const r = rig();
			const old = thread;
			r.agents.observe(old);
			r.script.answer = { receipt, id: "m1", turn: queued(2, "m1") };
			expect(await shimOf(r).deliverIrcMessage(message("m1"))).toBe(receipt);
			expect(shimOf(r).isStreaming).toBe(true);
			expect(statusOf(r)).toBe("running");
			expect(r.follows).toEqual([ID]);

			r.agents.observe(old);
			expect(shimOf(r).isStreaming).toBe(true);
			expect(statusOf(r)).toBe("running");

			r.agents.observe(working([turn(1), queued(2, "m1")]));
			expect(statusOf(r)).toBe("running");
			r.agents.observe(working([turn(1), ircTurn(2, "m1", { state: "running" })]));
			expect(statusOf(r)).toBe("running");
			r.agents.observe(idle([turn(1), ircTurn(2, "m1")]));
			expect(shimOf(r).isStreaming).toBe(false);
			expect(statusOf(r)).toBe("idle");
		});
	}

	test("a message whose turn never shows counts the agent as running only for a while", async () => {
		const r = rig();
		const old = idle([turn(1)]);
		r.agents.observe(old);
		r.script.answer = { receipt: "woken", id: "m1", turn: queued(2, "m1") };
		await shimOf(r).deliverIrcMessage(message("m1"));
		r.clock.t += 29_000;
		r.agents.observe(old);
		expect(shimOf(r).isStreaming).toBe(true);
		r.clock.t += 2_000;
		r.agents.observe(old);
		expect(shimOf(r).isStreaming).toBe(false);
		expect(statusOf(r)).toBe("idle");
	});

	test("a service error is thrown as an Error with the service's text, and the message is sent once", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		r.script.ircError = new CloudError({ code: "unavailable", message: "the service is busy", retriable: true, outcomeKnown: true });
		const error = await shimOf(r).deliverIrcMessage(message("m1")).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(String(Reflect.get(Object(error), "message"))).toBe("the service is busy");
		expect(r.calls.irc).toHaveLength(1);
		expect(r.follows).toEqual([]);
		expect(shimOf(r).isStreaming).toBe(false);
	});

	test("an unknown outcome says the message may have been delivered after repeated attempts", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		r.script.ircError = new CloudError({ code: "ambiguous_outcome", message: "lost the connection", retriable: false, outcomeKnown: false });
		await expect(shimOf(r).deliverIrcMessage(message("m1"))).rejects.toThrow(/lost the connection.*may have been delivered/);
		expect(r.calls.irc).toHaveLength(1);
	});

	test("a thread the service no longer has is released", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		const session = shimOf(r);
		r.script.ircError = new CloudError({ code: "not_found", message: "no such thread", retriable: false, outcomeKnown: true });
		await expect(session.deliverIrcMessage(message("m1"))).rejects.toThrow("no such thread");
		expect(r.registry.get(JOB)).toBeUndefined();
		expect(r.agents.agentId(ID)).toBeUndefined();
		expect(r.calls.irc).toHaveLength(1);
	});

	test("another error of the capability check is thrown, not answered by the queue", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		const client = r.calls;
		r.script.skew = false;
		r.script.ircError = new CloudError({ code: "unreachable", message: "cannot reach the service", retriable: true, outcomeKnown: true });
		await expect(shimOf(r).deliverIrcMessage(message("m1"))).rejects.toThrow("cannot reach the service");
		expect(client.send).toEqual([]);
	});

	describe("on a service without threads.irc", () => {
		test("the message is a queued turn, and the receipt follows the thread's state", async () => {
			const r = rig();
			r.script.skew = true;
			r.agents.observe(idle([turn(1)]));
			expect(await shimOf(r).deliverIrcMessage(message("m1", { body: "go on" }))).toBe("woken");
			expect(r.calls.send).toEqual([{ thread: ID, text: "go on" }]);
			expect(r.calls.irc).toEqual([]);
			expect(r.calls.caps).toEqual([IRC_CAPABILITY]);
			expect(statusOf(r)).toBe("running");
			expect(r.follows).toEqual([ID]);

			// The thread now shows the turn running: a second message is injected into it.
			r.agents.observe(working([turn(1), turn(2, { state: "running" })]));
			expect(await shimOf(r).deliverIrcMessage(message("m2"))).toBe("injected");

			const a = rig();
			a.script.skew = true;
			a.agents.observe(archived([turn(1)]));
			expect(await shimOf(a).deliverIrcMessage(message("m3"))).toBe("revived");
		});
	});

	test("CloudAgents.send posts as Main and answers the receipt and the queued turn", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		r.script.answer = { receipt: "woken", id: "x", turn: queued(2, "x") };
		expect(await r.agents.send(ID, "do more")).toEqual({ receipt: "woken", turn: 2 });
		expect(r.calls.irc[0]?.thread).toBe(ID);
		expect(r.calls.irc[0]?.body).toMatchObject({ from: "Main", body: "do more" });
		expect(r.calls.irc[0]?.body.id).toMatch(/^[0-9a-f]{32}$/);
		expect(statusOf(r)).toBe("running");

		r.script.answer = { receipt: "injected", id: "y", turn: null };
		expect(await r.agents.send(ID, "also")).toEqual({ receipt: "injected", turn: null });
		await expect(r.agents.send("zzzzzzzzzzzz", "x")).rejects.toThrow("not a cloud agent");
	});

	test("a registered sender becomes the agent's parent", async () => {
		const r = rig();
		r.agents.observe(idle([turn(1)]));
		r.registry.register({ id: "Planner", displayName: "Planner", kind: "sub", parentId: "Main", session: asSession(new Inbox()), status: "idle" });
		await shimOf(r).deliverIrcMessage(message("m1", { from: "Planner" }));
		expect(r.registry.get(JOB)?.parentId).toBe("Planner");
	});
});

describe("messages the cloud agent sends", () => {
	const delivered = (r: Rig): IrcMessage[] => r.main.messages;

	function observed(options: RigOptions = {}): { r: Rig; d: ThreadDetail } {
		const r = rig(options);
		const d = working([turn(1, { state: "running" })]);
		r.agents.observe(d);
		return { r, d };
	}

	test("reach the addressed local agent once, as omp's own incoming message", () => {
		const { r, d } = observed();
		r.agents.event(d, ircEvent(5, { replyTo: "r9" }));
		expect(delivered(r)).toEqual([{ id: "i1", from: JOB, to: "Main", body: "hi", replyTo: "r9", ts: Date.parse(AT) }]);

		r.agents.event(d, ircEvent(6, { id: "i2" }));
		const second = delivered(r)[1];
		expect(second).toEqual({ id: "i2", from: JOB, to: "Main", body: "hi", ts: Date.parse(AT) });
		expect("replyTo" in (second ?? {})).toBe(false);
	});

	test("go to the registered `to`, else to the agent's parent", () => {
		const { r, d } = observed();
		const planner = new Inbox();
		r.registry.register({ id: "Planner", displayName: "Planner", kind: "sub", parentId: "Main", session: asSession(planner), status: "idle" });
		r.agents.event(d, ircEvent(1, { id: "a", to: "Planner" }));
		r.agents.event(d, ircEvent(2, { id: "b", to: "Ghost" }));
		r.agents.event(d, ircEvent(3, { id: "c", to: JOB }));
		expect(planner.messages.map(m => [m.id, m.to])).toEqual([["a", "Planner"]]);
		expect(delivered(r).map(m => [m.id, m.to])).toEqual([
			["b", "Main"],
			["c", "Main"],
		]);
	});

	test("a replay of the event, or of the message id in another event, delivers nothing more", () => {
		const { r, d } = observed();
		r.agents.event(d, ircEvent(5));
		r.agents.event(d, ircEvent(5));
		r.agents.event(d, ircEvent(9));
		expect(delivered(r)).toHaveLength(1);
		expect(r.warnings).toEqual([]);
	});

	test("an id the session recorded as an irc:incoming entry is skipped", () => {
		const { r, d } = observed();
		r.entries.push({ type: "custom_message", customType: "irc:incoming", details: { id: "i1" } }, { type: "message", id: "e1" });
		r.agents.event(d, ircEvent(5));
		expect(delivered(r)).toEqual([]);
		r.agents.event(d, ircEvent(6, { id: "i2" }));
		expect(delivered(r).map(m => m.id)).toEqual(["i2"]);
	});

	test("a recipient without a session is warned about, and the message is delivered on a replay once it runs", () => {
		const { r, d } = observed({ parkedMain: true });
		r.agents.event(d, ircEvent(5));
		expect(delivered(r)).toEqual([]);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain(JOB);
		expect(r.warnings[0]).toContain("Main");
		expect(r.warnings[0]).toContain("hi");

		expect(r.registry.attachSession("Main", asSession(r.main))).toBe(true);
		r.agents.event(d, ircEvent(5));
		expect(delivered(r).map(m => m.id)).toEqual(["i1"]);
		expect(r.warnings).toHaveLength(1);
	});

	test("a delivery that rejects is warned about and tried again on a replay", async () => {
		const { r, d } = observed();
		r.main.fail = new Error("inbox closed");
		r.agents.event(d, ircEvent(5));
		await settle();
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("inbox closed");
		expect(delivered(r)).toEqual([]);

		r.main.fail = undefined;
		r.agents.event(d, ircEvent(5));
		expect(r.main.attempts).toBe(2);
		expect(delivered(r).map(m => m.id)).toEqual(["i1"]);
	});

	test("an irc_in event, malformed text and an event of an unknown thread are ignored", () => {
		const { r, d } = observed();
		r.agents.event(d, { ...ircEvent(1), kind: "irc_in" });
		r.agents.event(d, event(2, { kind: "irc", text: "not json" }));
		r.agents.event(d, event(3, { kind: "irc", text: JSON.stringify({ id: "", from: "agent", body: "hi" }) }));
		r.agents.event(d, event(4, { kind: "irc", text: JSON.stringify({ id: "z", from: "agent", body: "" }) }));
		r.agents.event({ ...d, id: "zzzzzzzzzzzz" }, ircEvent(5));
		expect(delivered(r)).toEqual([]);
		expect(r.warnings).toEqual([]);
	});
});

describe("wake relay", () => {
	/** A thread a message from `from` woke with turn 2 queued. */
	async function woken(over: { from?: string; msg?: Partial<IrcMessage>; r?: Rig } = {}): Promise<Rig> {
		const r = over.r ?? rig();
		r.agents.observe(idle([turn(1)]));
		r.script.answer = { receipt: "woken", id: "m1", turn: queued(2, "m1") };
		await shimOf(r).deliverIrcMessage(message("m1", { ...(over.from === undefined ? {} : { from: over.from }), ...over.msg }));
		return r;
	}

	test("the finished turn's reply goes back to the sender once, fenced, with replyTo and wakeRelay", async () => {
		const r = await woken();
		r.agents.observe(working([turn(1), ircTurn(2, "m1", { state: "running" })]));
		expect(r.main.messages).toEqual([]);

		const done = idle([turn(1), ircTurn(2, "m1")]);
		r.agents.observe(done);
		expect(r.main.messages).toHaveLength(1);
		const relay = r.main.messages[0];
		expect(relay).toMatchObject({ id: `${JOB}-2-5000`, from: JOB, to: "Main", replyTo: "m1", wakeRelay: true });
		expect(relay?.body).toContain("Turn 2 done: Greeting fixed");
		expect(relay?.body).toContain(`<cloud-output thread="${ID}" turn="2">`);
		expect(relay?.body).toContain("The fix is in");
		expect(relay?.body).toContain(`agent://${JOB}`);
		expect(r.agents.relayed(ID, 2)).toBe(true);
		expect(r.agents.relayed(ID, 1)).toBe(false);

		r.agents.observe(done);
		expect(r.main.messages).toHaveLength(1);
		expect(r.relayFailures).toEqual([]);
	});

	test("failed and cancelled turns relay too", async () => {
		const failed = await woken();
		failed.agents.observe(idle([turn(1), ircTurn(2, "m1", { state: "failed", error: "boom", reply: "" })]));
		expect(failed.main.messages[0]?.body).toContain("Turn 2 failed: Greeting fixed");
		expect(failed.main.messages[0]?.body).toContain("boom");

		const cancelled = await woken();
		cancelled.agents.observe(idle([turn(1), ircTurn(2, "m1", { state: "cancelled", reply: "", error: "" })]));
		expect(cancelled.main.messages[0]?.body).toContain("Turn 2 was stopped");
		expect(cancelled.agents.relayed(ID, 2)).toBe(true);
	});

	test("the relay is cut at 8000 characters", async () => {
		const r = await woken();
		r.agents.observe(idle([turn(1), ircTurn(2, "m1", { reply: "x".repeat(9000) })]));
		const body = r.main.messages[0]?.body ?? "";
		expect(body).toContain(`${"x".repeat(8000)}…`);
		expect(body).not.toContain("x".repeat(8001));
	});

	test("a relay or a broadcast is never relayed back", async () => {
		for (const flag of [{ wakeRelay: true }, { broadcast: true }] as const) {
			const r = await woken({ msg: flag });
			r.agents.observe(idle([turn(1), ircTurn(2, "m1")]));
			expect(r.main.messages).toEqual([]);
			expect(r.agents.relayed(ID, 2)).toBe(false);
		}
	});

	test("a turn that is not an irc turn never relays", async () => {
		const r = await woken();
		r.agents.observe(idle([turn(1), turn(2, { reply: "from a person" })]));
		expect(r.main.messages).toEqual([]);
		expect(r.agents.relayed(ID, 2)).toBe(false);
	});

	test("a sender that is not running here is not relayed to", async () => {
		const r = await woken({ from: "Ghost" });
		r.agents.observe(idle([turn(1), ircTurn(2, "m1", { ircFrom: "Ghost" })]));
		expect(r.main.messages).toEqual([]);
		expect(r.agents.relayed(ID, 2)).toBe(false);
		expect(r.relayFailures).toEqual([]);
	});

	test("a sender whose delivery fails is reported, and the turn is not counted as relayed", async () => {
		const r = await woken();
		r.main.fail = new Error("inbox closed");
		r.agents.observe(idle([turn(1), ircTurn(2, "m1")]));
		expect(r.agents.relayed(ID, 2)).toBe(true);
		await shimOf(r).waitForIrcReplies();
		expect(r.relayFailures).toEqual([{ turn: 2, reason: "inbox closed" }]);
		expect(r.agents.relayed(ID, 2)).toBe(false);
	});

	test("a turn that ended before the thread was first seen is never relayed", () => {
		const r = rig();
		r.agents.observe(idle([ircTurn(1, "m0")]));
		expect(r.main.messages).toEqual([]);
		expect(r.agents.relayed(ID, 1)).toBe(false);
		r.agents.observe(idle([ircTurn(1, "m0")]));
		expect(r.main.messages).toEqual([]);
	});

	test("an irc turn the service reports goes to the sender it names when a running agent has that id", () => {
		const r = rig();
		r.agents.observe(working([turn(1, { state: "running" })]));
		r.agents.observe(idle([ircTurn(1, "m7")]));
		expect(r.main.messages).toMatchObject([{ to: "Main", replyTo: "m7", wakeRelay: true }]);
	});
});

describe("artifacts", () => {
	const read = (r: Rig, ext: "md" | "json"): string => readFileSync(join(r.dir, `${JOB}.${ext}`), "utf8");

	test("<id>.md holds the reply and <id>.json the turn's result, written for a thread first seen finished", () => {
		const r = rig();
		const d = idle([turn(1, { reply: "All done.", title: "Greeting fixed", filesChanged: 2, insertions: 5, deletions: 1 })], { metrics: metrics({ requests: 3 }), model: "anthropic/claude-sonnet-5-5" });
		r.agents.observe(d);
		expect(read(r, "md")).toBe("All done.");
		expect(JSON.parse(read(r, "json"))).toEqual({
			thread: ID,
			name: NAME,
			turn: 1,
			state: "done",
			title: "Greeting fixed",
			reply: "All done.",
			error: "",
			result: null,
			metrics: d.metrics,
			diffstat: { filesChanged: 2, insertions: 5, deletions: 1 },
			branch: `omp-cloud/${ID}`,
			model: "anthropic/claude-sonnet-5-5",
		});
	});

	test("the thread's result gives the diffstat and is in the payload", () => {
		const r = rig();
		const result = { branch: `omp-cloud/${ID}`, head: "abc", base: "def", filesChanged: 4, insertions: 9, deletions: 3, pushed: false, pushError: "", pushRef: "", updatedAt: AT };
		r.agents.observe(idle([turn(1, { reply: "ok" })], { result }));
		expect(JSON.parse(read(r, "json"))).toMatchObject({ result, diffstat: { filesChanged: 4, insertions: 9, deletions: 3 } });
	});

	test("a newer finished turn rewrites both files; the same turn is written once", () => {
		const r = rig();
		r.agents.observe(working([turn(1, { reply: "first" })]));
		expect(read(r, "md")).toBe("first");
		rmSync(join(r.dir, `${JOB}.md`));
		r.agents.observe(working([turn(1, { reply: "first" })]));
		expect(existsSync(join(r.dir, `${JOB}.md`))).toBe(false);

		r.agents.observe(idle([turn(1, { reply: "first" }), turn(2, { reply: "second" })]));
		expect(read(r, "md")).toBe("second");
		expect(JSON.parse(read(r, "json"))).toMatchObject({ turn: 2, reply: "second" });
	});

	test("a failed or empty turn says so in the .md", () => {
		const r = rig();
		r.agents.observe(idle([turn(1, { state: "failed", error: "boom", reply: "" })]));
		expect(read(r, "md")).toBe("Turn 1 failed: boom");
		expect(JSON.parse(read(r, "json"))).toMatchObject({ state: "failed", error: "boom" });

		r.agents.observe(idle([turn(1, { state: "failed", error: "boom", reply: "" }), turn(2, { reply: "" })]));
		expect(read(r, "md")).toBe("(the turn ended with no reply)");

		r.agents.observe(idle([turn(1), turn(2), turn(3, { state: "cancelled", error: "", reply: "" })]));
		expect(read(r, "md")).toBe("Turn 3 cancelled: no details");
	});

	test("turnPayload cuts the reply at replyMax", () => {
		const d = idle([]);
		const t = turn(1, { reply: "abcdefgh" });
		expect(turnPayload(d, t, 5).reply).toBe("abcde…");
		expect(turnPayload(d, t, 8).reply).toBe("abcdefgh");
		expect(turnPayload(d, t).reply).toBe("abcdefgh");
	});
});
