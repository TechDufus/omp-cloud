import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CardDetails } from "../src/cards";
import { CloudError } from "../src/errors";
import type { ThreadSummary } from "../src/types";
import { Cloud } from "../src/verbs";
import { detail, event, pending, question, summary, turn } from "./builders";
import { cloudEnv, fakeHost, fakePi, until, type FakeHost, type FakePi } from "./fakes";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

const ID = "k3x9fa2m7q1z";
const OTHER = "p4m8c6w2n5t1";
const ENC = new TextEncoder();

const state = {
	listed: [] as ThreadSummary[],
	detail: detail(),
	stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
	/** The thread was deleted behind the plugin's back. */
	gone: false,
	/** How many times the plugin posted a stop for the thread. */
	stops: 0,
};

const working = () => detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", turns: [turn(1, { state: "running", text: "fix it" })] });
const finished = () => detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "idle", turns: [turn(1, { title: "Greeting fixed", reply: "All done." })] });
const asking = () =>
	detail({
		id: ID,
		name: "Fix greeting bug",
		title: "Add Greet",
		phase: "waiting",
		question: pending({ turn: 1, id: 2, text: "Which database?" }),
		turns: [turn(1, { state: "running", questions: [question({ id: 2, ask: 1, text: "Which database?" })] })],
	});

function reset(): void {
	state.listed = [summary({ id: ID, name: "Fix greeting bug", title: "Add Greet" })];
	state.detail = working();
	state.stream = undefined;
	state.gone = false;
	state.stops = 0;
}

let server: Bun.Server<undefined>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const p = new URL(req.url).pathname;
			const T = `/api/v1/threads/${ID}`;
			if (req.method === "GET" && p === "/api/v1/threads") return Response.json({ threads: state.listed });
			if (req.method === "GET" && p === T) return state.gone ? Response.json({ error: "no such thread" }, { status: 404 }) : Response.json(state.detail);
			if (req.method === "GET" && p === `${T}/events`) {
				const body = new ReadableStream<Uint8Array>({
					start: c => void (state.stream = c),
					cancel: () => void (state.stream = undefined),
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			}
			if (req.method === "POST" && p === `${T}/stop`) {
				state.stops++;
				return Response.json({ stoppedRunning: true, cancelled: 0 });
			}
			return Response.json({ error: "no such thread" }, { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

beforeEach(reset);

const live: { cloud: Cloud; host: FakeHost }[] = [];
let manager: AsyncJobManager | undefined;

afterEach(async () => {
	for (const { cloud, host } of live.splice(0)) {
		await cloud.handle("unwatch", host.host as never);
		cloud.shutdown();
	}
	AsyncJobManager.setInstance(undefined);
	await manager?.dispose({ timeoutMs: 100 });
	manager = undefined;
});

interface Rig {
	cloud: Cloud;
	host: FakeHost;
	pi: FakePi;
}

/** A Cloud on a fresh session, with omp's real job manager installed as the host's when `jobs`. */
async function setup(jobs = false): Promise<Rig> {
	const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\n`);
	const host = fakeHost({ cwd: await tmp("omp-cloud-cwd-") });
	const pi = fakePi({ settings: Settings.isolated() });
	const cloud = new Cloud(pi.pi, "/own", env, await tmp("omp-cloud-home-"), () => {}, { notify: () => {}, write: () => {} });
	if (jobs) {
		manager = new AsyncJobManager({ retentionMs: 60_000 });
		AsyncJobManager.setInstance(manager);
	}
	live.push({ cloud, host });
	// A command or an event gives the extension its context; `follow` and `waitFor` run in it.
	cloud.rebind(host.host);
	return { cloud, host, pi };
}

async function push(kind: string, seq: number, turnId = 1): Promise<void> {
	await until(() => state.stream !== undefined);
	state.stream?.enqueue(ENC.encode(`id: ${seq}\ndata: ${JSON.stringify(event(seq, { kind, turn: turnId }))}\n\n`));
}

describe("how a thread is followed", () => {
	test("a thread nobody follows says so", async () => {
		const r = await setup();
		expect(r.cloud.followState(ID)).toEqual({ followed: false, origin: "", stale: false });
	});

	test("follow starts at once; the state names the origin and says not stale", async () => {
		const r = await setup();
		r.cloud.follow(ID, { origin: "tool" });
		expect(r.cloud.followState(ID)).toEqual({ followed: true, origin: "tool", stale: false });
		await until(() => state.stream !== undefined);
		expect(r.cloud.followState(ID)).toEqual({ followed: true, origin: "tool", stale: false });
	});

	test("a followed running turn is a host job, and the state says which", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		expect(r.cloud.followState(ID)).toEqual({ followed: true, origin: "tool", jobId: "FixGreetingBug", stale: false });
	});

	test("a thread the user started and the model then adopts keeps being followed, and its finished turn now wakes the model", async () => {
		const r = await setup();
		r.cloud.follow(ID, { origin: "user" });
		await until(() => state.stream !== undefined);
		expect(r.cloud.followState(ID).origin).toBe("user");

		r.cloud.follow(ID, { origin: "tool" });
		expect(r.cloud.followState(ID)).toEqual({ followed: true, origin: "tool", stale: false });
		// One follower: the second call did not open a second stream.
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.pi.sent.length === 1);
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: true });
		expect((r.pi.sent[0]?.message.details as CardDetails).kind).toBe("turn");
		expect(r.cloud.followState(ID).followed).toBe(false);
	});

	test("a later `user` request never downgrades a thread the model follows (an answer or a silent send): its cards still wake the model", async () => {
		const r = await setup();
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => state.stream !== undefined);
		r.cloud.follow(ID, { origin: "user" });
		expect(r.cloud.followState(ID)).toEqual({ followed: true, origin: "tool", stale: false });
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.pi.sent.length === 1);
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: true });
		expect(r.pi.sent[0]?.message.content).toContain("All done.");
	});

	test("a `user` request on a thread nobody follows follows it for the user, and the tool origin of a thread is also kept when it is not followed yet", async () => {
		const r = await setup();
		r.cloud.follow(ID, { origin: "user" });
		expect(r.cloud.followState(ID).origin).toBe("user");
		await until(() => state.stream !== undefined);
		r.cloud.follow(ID, { origin: "tool" });
		r.cloud.follow(ID, { origin: "user" });
		expect(r.cloud.followState(ID).origin).toBe("tool");
	});

	test("adopting a user's thread mid-turn gives the model the result once: the job settles with a pointer, the card carries the result, even with a wait blocked on the job", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "user" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		r.cloud.follow(ID, { origin: "tool" });
		manager?.watchJobs(["FixGreetingBug"]);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.pi.sent.length === 1);
		await manager?.getJob("FixGreetingBug")?.promise;

		// The card wakes the model with the result and is not a pointer to the wait.
		expect(r.pi.sent[0]?.message.content).toContain("All done.");
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: true });
		// What the wait returns holds no second copy of it.
		const result = manager?.getJob("FixGreetingBug")?.resultText ?? "";
		expect(result).toStartWith("Turn 1 done");
		expect(result).toContain("arrives as a [cloud] message");
		expect(result).not.toContain("All done.");
	});

	test("a thread that was the model's from the start settles through its job alone: a wait gets the full result and no card follows", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		r.cloud.follow(ID, { origin: "tool" });
		manager?.watchJobs(["FixGreetingBug"]);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.cloud.followState(ID).followed === false);
		await manager?.getJob("FixGreetingBug")?.promise;
		expect(manager?.getJob("FixGreetingBug")?.resultText).toContain("All done.");
		expect(manager?.getJob("FixGreetingBug")?.structured).toMatchObject({ status: "valid", data: { thread: ID, turn: 1, state: "done", reply: "All done." } });
		expect(r.pi.sent).toEqual([]);
	});

	test("an unwaited model-started turn is delivered by omp's own async-result, not by a card", async () => {
		const r = await setup(true);
		const delivered: string[] = [];
		manager?.registerDeliverySink("Main", id => void delivered.push(id));
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => delivered.length === 1);
		expect(delivered).toEqual(["FixGreetingBug"]);
		expect(r.pi.sent).toEqual([]);
	});

	test("deleting a thread the model follows ends its follower and job without a word", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		r.cloud.forgetThread(ID);
		await manager?.getJob("FixGreetingBug")?.promise.catch(() => {});
		expect(manager?.getJob("FixGreetingBug")?.status).toBe("cancelled");
		expect(r.cloud.followState(ID)).toEqual({ followed: false, origin: "", stale: false });
		// The stream the delete would have ended with a 404 is closed: nothing is posted or notified.
		state.gone = true;
		await until(() => state.stream === undefined);
		expect(r.pi.sent).toEqual([]);
		expect(r.host.notes.filter(n => n[0].includes("no longer exists"))).toEqual([]);
	});

	test("a thread that cannot be followed is reported to the user and is not followed", async () => {
		const r = await setup();
		r.cloud.follow(OTHER, { origin: "tool" });
		await until(() => r.host.notes.length > 0);
		expect(r.host.notes[0]?.[0]).toBe(`☁ cannot follow ${OTHER}: no such thread`);
		expect(r.cloud.followState(OTHER).followed).toBe(false);
	});
});

describe("a thread deleted while followed", () => {
	test("the model that started it is woken with `thread was deleted`; the job fails and is gone", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		state.gone = true;
		await push("turn_done", 1);
		await until(() => r.pi.sent.length === 1);
		expect(r.pi.sent[0]?.message.content).toStartWith(`[cloud] Fix greeting bug · ${ID}: thread was deleted`);
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: true });
		expect(manager?.getJob("FixGreetingBug")).toMatchObject({ status: "failed", errorText: "thread was deleted" });
		expect(r.cloud.followState(ID)).toEqual({ followed: false, origin: "", stale: false });
	});
});

describe("waiting through the session", () => {
	test("a followed thread settles from its stream: no polling is needed and the outcome carries the turn", async () => {
		const r = await setup();
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => state.stream !== undefined);
		const p = r.cloud.waitFor([ID], { until: "any", on: ["done", "failed", "question"], timeoutMs: 60_000 });
		state.detail = finished();
		await push("turn_done", 1);
		expect(await p).toEqual([{ threadId: ID, outcome: "done", turn: 1 }]);
	});

	test("a question ends the wait while the turn runs", async () => {
		const r = await setup();
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => state.stream !== undefined);
		const p = r.cloud.waitFor([ID], { until: "any", on: ["done", "failed", "question"], timeoutMs: 60_000 });
		state.detail = asking();
		await push("question_asked", 1);
		expect(await p).toEqual([{ threadId: ID, outcome: "question", turn: 1 }]);
		expect(r.cloud.followState(ID).followed).toBe(true);
	});

	test("an idle thread nobody follows answers from one fetch", async () => {
		const r = await setup();
		state.detail = finished();
		expect(await r.cloud.waitFor([ID], { until: "all", on: ["done"], timeoutMs: 60_000 })).toEqual([{ threadId: ID, outcome: "done", turn: 1 }]);
	});

	test("the caller's abort ends the wait with an `aborted` CloudError and leaves the thread followed", async () => {
		const r = await setup();
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => state.stream !== undefined);
		const ctrl = new AbortController();
		const p = r.cloud.waitFor([ID], { until: "any", on: ["done"], timeoutMs: 60_000, signal: ctrl.signal });
		ctrl.abort();
		const error = await p.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CloudError);
		expect((error as CloudError).code).toBe("aborted");
		expect(r.cloud.followState(ID).followed).toBe(true);
	});
});

describe("cancelling a cloud job in omp", () => {
	test("stops the cloud turn, and tells the model, without waking it, that its turn is being stopped", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		manager?.cancel("FixGreetingBug", { ownerId: "Main" });
		await until(() => r.pi.sent.length === 1);

		const sent = r.pi.sent[0];
		expect(sent?.message.content).toBe(
			`[cloud] Fix greeting bug · ${ID}: its job in omp was cancelled, so its cloud turn is being stopped\nNothing more arrives from this turn; cloud status ${ID} shows where the thread is, and a new message to it starts another turn.`,
		);
		expect(sent?.message.display).toBe(false);
		// The model is idle: the note waits for its next turn instead of starting one.
		expect(sent?.options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
		expect(r.host.notes.map(n => n[0])).toContain("☁ Fix greeting bug was cancelled in omp: its cloud turn is being stopped (2m7q1z)");
		await until(() => state.stops === 1);
	});

	test("while the model is working it arrives at the next step boundary, as an aside", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		r.host.idle = false;
		manager?.cancel("FixGreetingBug", { ownerId: "Main" });
		await until(() => r.pi.sent.length === 1);
		expect(r.pi.sent[0]?.options).toEqual({ deliverAs: "aside" });
	});

	test("the turn still ends normally: its result card reaches the model, which was told the job was cancelled", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		manager?.cancel("FixGreetingBug", { ownerId: "Main" });
		await until(() => r.pi.sent.length === 1);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.pi.sent.length === 2);
		expect(r.pi.sent[1]?.message.content).toContain("All done.");
		expect(r.pi.sent[1]?.options).toEqual({ triggerTurn: true });
	});

	test("a thread of the user's is not the model's business: the cloud turn is stopped and the user is told, the model is not", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "user" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		manager?.cancel("FixGreetingBug", { ownerId: "Main" });
		await until(() => r.host.notes.some(n => n[0].includes("was cancelled in omp")));
		await until(() => state.stops === 1);
		expect(r.pi.sent).toEqual([]);
	});

	test("omp's cleanup on a session switch tells nobody", async () => {
		const r = await setup(true);
		r.cloud.follow(ID, { origin: "tool" });
		await until(() => r.cloud.followState(ID).jobId !== undefined);
		r.cloud.beforeSwitch();
		manager?.cancel("FixGreetingBug", { ownerId: "Main" });
		await manager?.getJob("FixGreetingBug")?.promise;
		expect(r.pi.sent).toEqual([]);
		expect(r.host.notes.filter(n => n[0].includes("was cancelled in omp"))).toEqual([]);
		expect(state.stops).toBe(0);
	});
});
