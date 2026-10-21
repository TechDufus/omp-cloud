import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import type { Store } from "../store";
import type { Turn } from "../store/types";
import { ircInCommand, ircPlainText } from "./irc";
import {
	assistantEnd,
	type Frame,
	type FakeOmp,
	type FakeOmpOptions,
	fakeVm,
	fakeVmon,
	openEnv,
	promptResult,
	response,
	sandboxWithOmp,
	type Script,
	seedThread,
	settle,
	until,
} from "./test-support";
import { type ThreadEnv, ThreadRunner } from "./thread";

let dir: string;
let store: Store;
let gateway: GatewayClients;
let env: ThreadEnv;
const runners: ThreadRunner[] = [];
const unsubscribes: (() => void)[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	({ store, gateway, env } = await openEnv(dir));
});

afterEach(async () => {
	for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
	await Promise.all(runners.splice(0).map(runner => runner.detach()));
	store.close();
	await rm(dir, { recursive: true, force: true });
});

const PEER = "Peer";

/** omp acknowledges every prompt and never settles: a turn stays running until a test ends it. */
const held: Script = id => [response(id, "prompt"), assistantEnd("working on it")];

/** The prompt of a turn that runs to its end at once: the model answers `reply`. */
function answering(reply: string): Script {
	return id => [response(id, "prompt"), assistantEnd(reply), promptResult(id, true)];
}

interface Setup {
	id: string;
	runner: ThreadRunner;
	omp: FakeOmp;
}

/** A seeded thread whose VM holds the fake omp, with a runner wired like `Runner` wires its threads (a queued turn wakes it, an `irc_in` event hands the messages to omp). */
async function start(script: Script, options: FakeOmpOptions = {}): Promise<Setup> {
	const id = await seedThread(store, gateway, 1);
	const omp = sandboxWithOmp(fakeVm({ dirty: false, head: "a".repeat(40) }), script, options);
	const runner = attach(id, omp);
	return { id, runner, omp };
}

/** A runner of thread `id` over `omp`, wired like `Runner` wires its threads. */
function attach(id: string, omp: FakeOmp): ThreadRunner {
	const runner = new ThreadRunner({ ...env, vmon: fakeVmon(omp.sandbox).vmon }, id);
	runners.push(runner);
	unsubscribes.push(
		store.subscribeAll({
			event: (threadId, event) => {
				if (threadId !== id) return;
				if (event.kind === "turn_queued") queueMicrotask(() => runner.wake());
				if (event.kind === "irc_in") queueMicrotask(() => runner.onIrcQueued());
			},
			deleted: () => {},
		}),
	);
	return runner;
}

/** Queues a plain message and waits until omp holds its prompt and the runner took its acknowledgement (`acknowledged` false: until it holds the prompt only). */
async function startTurn(setup: Setup, text = "work", acknowledged = true): Promise<Turn> {
	const turn = store.enqueueTurn(setup.id, text, "owner");
	setup.runner.wake();
	await until(() => setup.omp.prompts.length === 1, "the first prompt");
	if (!acknowledged) return turn;
	// The assistant text follows the acknowledgement on omp's stdout: once it is an event, the runner has taken the acknowledgement.
	await until(() => eventsOf(setup.id, "assistant").some(event => event.turn === turn.id), "omp's acknowledgement");
	await settle();
	return turn;
}

function promptFrames(omp: FakeOmp): Frame[] {
	return omp.frames.filter(frame => frame.type === "prompt");
}

/** The message of prompt `n` (0-based) as the `/irc-in` command carried it. */
function irc(omp: FakeOmp, n: number): unknown {
	const prompt = omp.prompts[n] ?? "";
	expect(prompt.startsWith("/irc-in ")).toBe(true);
	return JSON.parse(prompt.slice("/irc-in ".length));
}

/** Ends the running turn the way omp does: the answer, then the prompt's result. */
function finish(omp: FakeOmp, text = "finished"): void {
	const promptId = promptFrames(omp)[0]?.id;
	if (typeof promptId !== "string") throw new Error("omp was not prompted");
	omp.emit([assistantEnd(text), promptResult(promptId, true)]);
}

async function turnEnded(id: string, turnId: number): Promise<Turn> {
	await until(() => ["done", "failed"].includes(store.turns(id).find(t => t.id === turnId)?.state ?? ""), `turn ${turnId} to end`);
	const turn = store.turns(id).find(t => t.id === turnId);
	if (turn === undefined) throw new Error("the turn vanished");
	return turn;
}

function eventsOf(id: string, kind: string) {
	return store.events(id, 0, 1000).filter(event => event.kind === kind);
}

function noticesOf(id: string): string[] {
	return eventsOf(id, "notice").map(event => event.text);
}

/** The state of an inbox row; the store only serves the pending ones. */
function inboxState(messageId: string): string | null {
	const db = new Database(join(dir, "omp-cloud.db"), { readonly: true });
	try {
		return db.query<{ state: string }, [string]>("SELECT state FROM irc_inbox WHERE id = ?").get(messageId)?.state ?? null;
	} finally {
		db.close();
	}
}

/** The `extension_ui_request` the VM extension writes for a message of the agent. */
function ircFrame(message: { id: string; from?: string; to?: string; body?: string; replyTo?: string }, overrides: Frame = {}): Frame {
	const payload = { kind: "omp-cloud.irc", from: "Cloud", to: "Parent", body: "hello", replyTo: "", ...message };
	return {
		type: "extension_ui_request",
		id: `ui-${message.id}`,
		method: "setStatus",
		statusKey: "omp-cloud.irc",
		statusText: JSON.stringify(payload),
		...overrides,
	};
}

describe("the agent's messages", () => {
	test("a frame of the extension during a turn becomes an irc event of that turn, whose text is the message as JSON", async () => {
		const setup = await start(held);
		const turn = await startTurn(setup);

		setup.omp.emit([ircFrame({ id: "a1", body: "found it", replyTo: "q7" })]);
		await until(() => eventsOf(setup.id, "irc").length === 1, "the irc event");

		const [event] = eventsOf(setup.id, "irc");
		expect(event?.turn).toBe(turn.id);
		const payload: unknown = JSON.parse(event?.text ?? "");
		expect(payload).toEqual({ id: "a1", from: "Cloud", to: "Parent", body: "found it", replyTo: "q7", at: event?.at });
	});

	test("the same frame twice is stored once, and the next message keeps its place", async () => {
		const setup = await start(held);
		await startTurn(setup);

		setup.omp.emit([ircFrame({ id: "a1" }), ircFrame({ id: "a1" }), ircFrame({ id: "a2", body: "second" })]);
		await until(() => eventsOf(setup.id, "irc").length === 2, "both messages");

		expect(eventsOf(setup.id, "irc").map(event => JSON.parse(event.text).id)).toEqual(["a1", "a2"]);
	});

	test("a frame omp writes again after the service re-attached is stored once", async () => {
		const setup = await start(held);
		const turn = await startTurn(setup);
		setup.omp.emit([ircFrame({ id: "a1" })]);
		await until(() => eventsOf(setup.id, "irc").length === 1, "the first message");

		// A service restart: the turn stays running, a new runner adopts omp, which is still busy with it.
		await setup.runner.detach();
		setup.omp.state.isSettled = false;
		setup.omp.state.isStreaming = true;
		const frames = setup.omp.frames;
		const probes = () => frames.filter(frame => frame.type === "get_available_commands").length;
		const before = probes();
		attach(setup.id, setup.omp).wake();
		await until(() => probes() > before, "the second attach to be configured");
		// The runner reads omp's state once it has taken the turn up again; the frames below then land on that turn.
		await until(() => frames.slice(frames.findLastIndex(frame => frame.type === "get_available_commands") + 1).some(frame => frame.type === "get_state"), "the turn to be taken up");

		// omp's output of the lost stream is replayed, then something new follows.
		setup.omp.emit([ircFrame({ id: "a1" }), ircFrame({ id: "a2", body: "after the restart" })]);
		await until(() => eventsOf(setup.id, "irc").length === 2, "the message after the restart");

		const events = eventsOf(setup.id, "irc");
		expect(events.map(event => JSON.parse(event.text).id)).toEqual(["a1", "a2"]);
		expect(events.map(event => event.turn)).toEqual([turn.id, turn.id]);

		setup.omp.state.isSettled = true;
		setup.omp.state.isStreaming = false;
		setup.omp.emit([{ type: "session_settled" }]);
		expect((await turnEnded(setup.id, turn.id)).state).toBe("done");
	});

	test("two different messages keep their order, and the log stays gapless", async () => {
		const setup = await start(held);
		await startTurn(setup);

		setup.omp.emit([ircFrame({ id: "a1", body: "one" }), ircFrame({ id: "a2", body: "two" })]);
		await until(() => eventsOf(setup.id, "irc").length === 2, "both messages");

		const bodies = eventsOf(setup.id, "irc").map(event => JSON.parse(event.text).body);
		expect(bodies).toEqual(["one", "two"]);
		const seqs = store.events(setup.id, 0, 1000).map(event => event.seq);
		expect(seqs).toEqual(seqs.map((_, i) => i + 1));
	});

	test("another status key, a payload that is no message and a malformed one store nothing", async () => {
		const setup = await start(held);
		await startTurn(setup);
		const frames = [
			ircFrame({ id: "k1" }, { statusKey: "something.else" }),
			ircFrame({ id: "k2" }, { statusText: "not json" }),
			ircFrame({ id: "k3" }, { statusText: JSON.stringify({ kind: "other", id: "k3", from: "Cloud", to: "Parent", body: "hi" }) }),
			ircFrame({ id: "k4", body: "  " }),
			ircFrame({ id: "k5", to: "" }),
			ircFrame({ id: "" }),
			ircFrame({ id: "k6" }, { method: "setWidget" }),
			ircFrame({ id: "k7" }, { statusText: undefined }),
			// the one that counts: the frames before it are processed first
			ircFrame({ id: "ok" }),
		];
		setup.omp.emit(frames);
		await until(() => eventsOf(setup.id, "irc").length >= 1, "the valid message");

		expect(eventsOf(setup.id, "irc").map(event => JSON.parse(event.text).id)).toEqual(["ok"]);
	});

	test("a frame between turns becomes an event without a turn", async () => {
		const setup = await start(answering("done quickly"));
		const turn = store.enqueueTurn(setup.id, "quick", "owner");
		setup.runner.wake();
		await turnEnded(setup.id, turn.id);

		setup.omp.emit([ircFrame({ id: "late", body: "one more thing" })]);
		await until(() => eventsOf(setup.id, "irc").length === 1, "the irc event");

		expect(eventsOf(setup.id, "irc")[0]?.turn).toBeNull();
		expect(JSON.parse(eventsOf(setup.id, "irc")[0]?.text ?? "").body).toBe("one more thing");
	});
});

describe("a message into a running turn", () => {
	test("is handed to omp as one /irc-in prompt, without splitting or aborting the turn", async () => {
		const setup = await start(held);
		const turn = await startTurn(setup);

		const sent = store.sendIrc(setup.id, { id: "m1", from: PEER, body: "how far along?", replyTo: "r1" });
		expect(sent).toMatchObject({ receipt: "injected", id: "m1", turn: null });
		await until(() => setup.omp.prompts.length === 2, "the /irc-in prompt");
		await until(() => inboxState("m1") === "sent", "the inbox row to be sent");

		expect(irc(setup.omp, 1)).toEqual({ id: "m1", from: PEER, body: "how far along?", replyTo: "r1" });
		expect(setup.omp.prompts[1]).toBe(ircInCommand({ id: "m1", from: PEER, body: "how far along?", replyTo: "r1" }));
		// An extension command runs at once, even while omp streams: no streamingBehavior, no steer, no abort.
		for (const frame of promptFrames(setup.omp)) expect("streamingBehavior" in frame).toBe(false);
		expect(setup.omp.frames.some(frame => frame.type === "steer" || frame.type === "abort")).toBe(false);
		expect(store.pendingIrc(setup.id, turn.id)).toEqual([]);

		finish(setup.omp);
		const ended = await turnEnded(setup.id, turn.id);

		expect(ended).toMatchObject({ state: "done", reply: "finished", origin: "" });
		expect(eventsOf(setup.id, "turn_done").filter(event => event.turn === turn.id)).toHaveLength(1);
		// the turn was not split and the delivered message did not come back as a turn of its own
		expect(store.turns(setup.id).map(t => t.id)).toEqual([1, turn.id]);
		expect(setup.omp.prompts).toHaveLength(2);
		expect(inboxState("m1")).toBe("sent");
	});

	test("one that arrives before omp acknowledged the turn's prompt is delivered right after the acknowledgement", async () => {
		// The first prompt is not answered yet; every later one is.
		const setup = await start((id, message) => (message.startsWith("/irc-in") ? [response(id, "prompt")] : []));
		const turn = await startTurn(setup, "work", false);

		store.sendIrc(setup.id, { id: "early", from: PEER, body: "before the ack", replyTo: "" });
		await settle();
		expect(setup.omp.prompts).toHaveLength(1);
		expect(store.pendingIrc(setup.id, turn.id).map(message => message.id)).toEqual(["early"]);

		const promptId = promptFrames(setup.omp)[0]?.id;
		if (typeof promptId !== "string") throw new Error("omp was not prompted");
		setup.omp.emit([response(promptId, "prompt")]);
		await until(() => setup.omp.prompts.length === 2, "the delivery after the acknowledgement");

		// no replyTo: the command leaves the field out
		expect(irc(setup.omp, 1)).toEqual({ id: "early", from: PEER, body: "before the ack" });
		await until(() => inboxState("early") === "sent", "the inbox row to be sent");
		finish(setup.omp);
		expect((await turnEnded(setup.id, turn.id)).state).toBe("done");
	});

	test("two messages are delivered in the order they came", async () => {
		const setup = await start(held);
		const turn = await startTurn(setup);

		store.sendIrc(setup.id, { id: "m1", from: PEER, body: "first", replyTo: "" });
		store.sendIrc(setup.id, { id: "m2", from: "Other", body: "second", replyTo: "m1" });
		await until(() => setup.omp.prompts.length === 3, "both deliveries");

		expect(irc(setup.omp, 1)).toMatchObject({ id: "m1", from: PEER, body: "first" });
		expect(irc(setup.omp, 2)).toMatchObject({ id: "m2", from: "Other", body: "second", replyTo: "m1" });
		await until(() => inboxState("m2") === "sent", "the inbox rows to be sent");
		expect(inboxState("m1")).toBe("sent");

		finish(setup.omp);
		await turnEnded(setup.id, turn.id);
		expect(store.turns(setup.id)).toHaveLength(2);
	});

	test("one that omp could not take stays pending and becomes a turn of its own, which the runner runs", async () => {
		let deliveries = 0;
		const setup = await start((id, message) => {
			if (!message.startsWith("/irc-in")) return held(id, message);
			// the first delivery (into the running turn) fails, the second (the turn it became) works
			if (++deliveries === 1) return [{ id, type: "response", command: "prompt", success: false, error: "boom" }];
			return [response(id, "prompt"), assistantEnd("got your message"), promptResult(id, true)];
		});
		const turn = await startTurn(setup);

		store.sendIrc(setup.id, { id: "m1", from: PEER, body: "please look at this", replyTo: "r1" });
		await until(() => noticesOf(setup.id).some(text => text.includes("could not be delivered")), "the failed delivery's notice");
		expect(store.pendingIrc(setup.id, turn.id)).toHaveLength(1);
		expect(inboxState("m1")).toBe("pending");

		finish(setup.omp);
		await turnEnded(setup.id, turn.id);
		const next = store.turns(setup.id).find(t => t.origin === "irc");
		if (next === undefined) throw new Error("the pending message did not become a turn");
		const ended = await turnEnded(setup.id, next.id);

		expect(ended).toMatchObject({ state: "done", reply: "got your message", by: PEER, text: "please look at this", ircId: "m1", ircFrom: PEER, ircReplyTo: "r1" });
		expect(setup.omp.prompts).toHaveLength(3);
		expect(setup.omp.prompts[2]).toBe(setup.omp.prompts[1]);
	});

	test("onIrcQueued on a runner with no running turn sends nothing", async () => {
		const setup = await start(answering("ok"));
		const idle = setup.runner;
		idle.onIrcQueued();
		await settle();
		expect(setup.omp.frames).toEqual([]);

		const turn = store.enqueueTurn(setup.id, "quick", "owner");
		idle.wake();
		await turnEnded(setup.id, turn.id);
		const frames = setup.omp.frames.length;
		const events = store.events(setup.id, 0, 1000).length;

		idle.onIrcQueued();
		await settle();

		expect(setup.omp.frames).toHaveLength(frames);
		expect(store.events(setup.id, 0, 1000)).toHaveLength(events);
	});
});

describe("a message to an idle thread", () => {
	test("becomes a turn the runner prompts with /irc-in, and ends with the agent's reply", async () => {
		const setup = await start((id, message) => (message.startsWith("/irc-in") ? [response(id, "prompt"), assistantEnd("yes, I am here"), promptResult(id, true)] : [response(id, "prompt")]));

		const sent = store.sendIrc(setup.id, { id: "m1", from: PEER, body: "are you there?", replyTo: "r1" });
		expect(sent.receipt).toBe("woken");
		const turn = sent.turn;
		if (turn === null) throw new Error("no turn");
		const ended = await turnEnded(setup.id, turn.id);

		expect(setup.omp.prompts).toEqual([ircInCommand({ id: "m1", from: PEER, body: "are you there?", replyTo: "r1" })]);
		expect(irc(setup.omp, 0)).toEqual({ id: "m1", from: PEER, body: "are you there?", replyTo: "r1" });
		expect(ended).toMatchObject({ state: "done", reply: "yes, I am here", origin: "irc", text: "are you there?", ircId: "m1", ircFrom: PEER, ircReplyTo: "r1", by: PEER });
		expect(noticesOf(setup.id)).toEqual([]);
	});

	test("a message that replies to nothing carries no replyTo in the command", async () => {
		const setup = await start(answering("ok"));

		const turn = store.sendIrc(setup.id, { id: "m1", from: PEER, body: "hi", replyTo: "" }).turn;
		if (turn === null) throw new Error("no turn");
		await turnEnded(setup.id, turn.id);

		expect(setup.omp.prompts).toEqual([`/irc-in ${JSON.stringify({ id: "m1", from: PEER, body: "hi" })}`]);
	});

	test("a VM without the extension gets the message as plain text, and says so once", async () => {
		const setup = await start(answering("plain reply"), { irc: false });

		const turn = store.sendIrc(setup.id, { id: "m1", from: PEER, body: "are you there?", replyTo: "r1" }).turn;
		if (turn === null) throw new Error("no turn");
		const ended = await turnEnded(setup.id, turn.id);

		const message = { id: "m1", from: PEER, body: "are you there?", replyTo: "r1" };
		expect(setup.omp.prompts).toEqual([ircPlainText(message)]);
		expect(ended).toMatchObject({ state: "done", reply: "plain reply", origin: "irc", text: "are you there?" });
		expect(noticesOf(setup.id).filter(text => text.includes("no IRC extension"))).toHaveLength(1);
	});

	test("a VM without the extension gets a message into a running turn as a steer", async () => {
		const setup = await start(held, { irc: false });
		const turn = await startTurn(setup);

		store.sendIrc(setup.id, { id: "m1", from: PEER, body: "how far along?", replyTo: "r1" });
		await until(() => setup.omp.frames.some(frame => frame.type === "steer"), "the steer");
		await until(() => inboxState("m1") === "sent", "the inbox row to be sent");

		const steers = setup.omp.frames.filter(frame => frame.type === "steer");
		expect(steers).toHaveLength(1);
		expect(steers[0]?.message).toBe(ircPlainText({ id: "m1", from: PEER, body: "how far along?", replyTo: "r1" }));
		expect(setup.omp.prompts).toEqual(["work"]);

		finish(setup.omp);
		expect((await turnEnded(setup.id, turn.id)).state).toBe("done");
		expect(store.turns(setup.id)).toHaveLength(2);
	});
});

describe("an irc turn found running after a restart", () => {
	const message = { id: "m1", from: PEER, body: "are you there?", replyTo: "r1" };
	const answer = {
		role: "assistant",
		content: [{ type: "text", text: "already answered" }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
		stopReason: "stop",
	};

	/** An irc turn whose prompt the earlier run sent (it is running, with promptSentAt) and a fresh runner over omp holding `messages`. */
	async function restarted(options: FakeOmpOptions): Promise<{ setup: Setup; turn: Turn }> {
		const setup = await start(answering("a second answer"), options);
		const queued = store.sendIrc(setup.id, message).turn;
		if (queued === null) throw new Error("no turn");
		store.startNextTurn(setup.id);
		store.markPromptSent(setup.id, queued.id);
		setup.runner.wake();
		return { setup, turn: queued };
	}

	test("is not prompted again when omp's conversation holds the irc:incoming record", async () => {
		const { setup, turn } = await restarted({
			messages: [
				{ role: "user", content: "earlier" },
				{ role: "custom", customType: "irc:incoming", details: { id: "m1", from: PEER }, content: "..." },
				answer,
			],
		});

		const ended = await turnEnded(setup.id, turn.id);

		expect(setup.omp.prompts).toEqual([]);
		expect(ended).toMatchObject({ state: "done", origin: "irc", reply: "already answered" });
	});

	test("is prompted again when the record of another message is all omp holds", async () => {
		const { setup, turn } = await restarted({
			messages: [{ role: "user", content: "earlier" }, { role: "custom", customType: "irc:incoming", details: { id: "other" } }, answer],
		});

		const ended = await turnEnded(setup.id, turn.id);

		expect(setup.omp.prompts).toEqual([ircInCommand(message)]);
		expect(ended.reply).toBe("a second answer");
	});

	test("on a VM without the extension is not prompted again when the last user message is the plain text", async () => {
		const { setup, turn } = await restarted({
			irc: false,
			messages: [{ role: "user", content: ircPlainText(message) }, answer],
		});

		const ended = await turnEnded(setup.id, turn.id);

		expect(setup.omp.prompts).toEqual([]);
		expect(ended).toMatchObject({ state: "done", reply: "already answered" });
	});
});
