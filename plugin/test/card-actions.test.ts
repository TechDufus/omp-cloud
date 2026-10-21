import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { CardAct } from "../src/cards";
import type { AnswerBody, ThreadDetail, ThreadSummary } from "../src/types";
import { Cloud } from "../src/verbs";
import { detail, pending, question, summary, turn } from "./builders";
import { cloudEnv, fakeHost, fakePi, type FakeHost, type FakePi, until } from "./fakes";
import { cleanup, FAST_RETRY, tmp } from "./helpers";

afterEach(cleanup);

const ID = "k3x9fa2m7q1z";
const SHORT = "2m7q1z";

interface Req {
	method: string;
	path: string;
	json?: unknown;
}

const state = {
	reqs: [] as Req[],
	listed: [] as ThreadSummary[],
	detail: detail(),
	stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
	/** The thread was deleted after it was listed. */
	gone: false,
};

function reset(): void {
	state.reqs = [];
	state.listed = [summary({ id: ID, name: "Fix greeting bug", title: "Add Greet" })];
	state.detail = detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "idle", turns: [turn(1, { reply: "All done." })] });
	state.stream = undefined;
	state.gone = false;
}

let server: Bun.Server<undefined>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const p = url.pathname;
			const r: Req = { method: req.method, path: p };
			state.reqs.push(r);
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
			if (req.method === "POST" && p === `${T}/messages`) {
				r.json = await req.json();
				return Response.json({ turn: { id: 3 } }, { status: 201 });
			}
			if (req.method === "POST" && p === `${T}/stop`) return Response.json({ stoppedRunning: true, cancelled: 2 });
			const answer = /^\/api\/v1\/threads\/[^/]+\/turns\/(\d+)\/questions\/(\d+)\/answer$/.exec(p);
			if (req.method === "POST" && answer) {
				r.json = await req.json();
				const body = r.json as AnswerBody;
				return Response.json(question({ id: Number(answer[2]), text: "Which database?", selected: body.selected ?? [], answer: body.answer ?? "", answeredAt: "2026-01-01T00:02:00Z" }));
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

beforeEach(reset);

const live: { cloud: Cloud; host: FakeHost }[] = [];

afterEach(async () => {
	for (const { cloud, host } of live.splice(0)) {
		await cloud.handle("unwatch", host.host as never);
		// Its agents live in omp's process-wide registry: a later test file must not find their ids taken.
		cloud.shutdown();
	}
});

interface Rig {
	cloud: Cloud;
	host: FakeHost;
	pi: FakePi;
	/** The titles and placeholders of the inputs the user was asked, and what they typed (`undefined` cancels). */
	asked: { title: string; placeholder: string | undefined }[];
	typed: { next: string | undefined };
}

/** A `Cloud` that has seen a context (as it does at `session_start`), over the fake service. */
async function setup(over: { prompts?: boolean } = {}): Promise<Rig> {
	const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\n`);
	const asked: Rig["asked"] = [];
	const typed: Rig["typed"] = { next: "ship it" };
	const host = fakeHost({
		cwd: await tmp("omp-cloud-cwd-"),
		input:
			over.prompts === false
				? undefined
				: async (title, placeholder) => {
						asked.push({ title, placeholder });
						return typed.next;
					},
	});
	const pi = fakePi();
	const cloud = new Cloud(pi.pi, "/own", env, undefined, undefined, undefined, FAST_RETRY);
	live.push({ cloud, host });
	cloud.rebind(host.host);
	return { cloud, host, pi, asked, typed };
}

/** Runs a button and waits until `done` holds: buttons run in the background. */
async function press(r: Rig, act: CardAct, done: () => boolean, thread = ID): Promise<void> {
	r.cloud.run(thread, act);
	await until(done);
}

const notes = (r: Rig): string[] => r.host.notes.map(n => n[0]);
const posts = (): Req[] => state.reqs.filter(q => q.method === "POST");

const asking = (over: Partial<ThreadDetail> = {}): ThreadDetail =>
	detail({
		id: ID,
		name: "Fix greeting bug",
		title: "Add Greet",
		phase: "waiting",
		question: pending({ turn: 1, id: 2, text: "Which database?" }),
		turns: [
			turn(1, {
				state: "running",
				questions: [question({ id: 2, ask: 1, text: "Which database?", options: [{ label: "postgres", description: "" }, { label: "sqlite", description: "" }] })],
			}),
		],
		...over,
	});

describe("Reply", () => {
	test("asks for the message with the thread's name and short id, then sends it as /cloud send does", async () => {
		const r = await setup();
		await press(r, { kind: "reply" }, () => notes(r).length >= 1);
		expect(r.asked).toEqual([{ title: `Reply to Fix greeting bug · ${SHORT}`, placeholder: "message" }]);
		expect(posts().map(q => [q.path, q.json])).toEqual([[`/api/v1/threads/${ID}/messages`, { text: "ship it" }]]);
		expect(notes(r)).toEqual([`☁ queued turn 3 on Fix greeting bug · ${ID}`]);
	});

	test("an archived thread says it restores first, before the queued notice", async () => {
		state.detail = detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "idle", archivedAt: "2026-02-01T00:00:00Z", turns: [turn(1)] });
		const r = await setup();
		await press(r, { kind: "reply" }, () => notes(r).length >= 2);
		expect(notes(r)).toEqual([`☁ Fix greeting bug · ${ID} is archived: its VM restores from the archive first (about a minute)`, `☁ queued turn 3 on Fix greeting bug · ${ID}`]);
	});

	test("a cancelled or empty input sends nothing", async () => {
		const r = await setup();
		r.typed.next = undefined;
		r.cloud.run(ID, { kind: "reply" });
		await until(() => r.asked.length === 1);
		r.typed.next = "   ";
		r.cloud.run(ID, { kind: "reply" });
		await until(() => r.asked.length === 2);
		// A later button's round trips end after both inputs' continuations: nothing was sent by then.
		await press(r, { kind: "stop" }, () => notes(r).length === 1);
		expect(posts().map(q => q.path)).toEqual([`/api/v1/threads/${ID}/stop`]);
	});

	test("a pairing code in the reply is refused like in /cloud send", async () => {
		const r = await setup();
		r.typed.next = `ompc1:AbCdEfGhIjKl:s3cr3t:${"A".repeat(43)}@10.0.0.1:8443`;
		await press(r, { kind: "reply" }, () => notes(r).length === 1);
		expect(notes(r)[0]).toBe("that looks like a pairing code; use /cloud connect");
		expect(posts()).toEqual([]);
	});

	test("a host that cannot prompt says how to send instead", async () => {
		const r = await setup({ prompts: false });
		await press(r, { kind: "reply" }, () => notes(r).length === 1);
		expect(notes(r)[0]).toBe(`☁ this host cannot prompt; use /cloud send ${SHORT} <message>`);
		expect(r.host.notes[0]?.[1]).toBe("error");
	});
});

describe("answers", () => {
	test("an option button answers the question with that option through the answer path", async () => {
		state.detail = asking();
		const r = await setup();
		await press(r, { kind: "answer", question: "1:2", option: 1 }, () => notes(r).some(n => n.startsWith("☁ answered")));
		expect(posts().map(q => [q.path, q.json])).toEqual([[`/api/v1/threads/${ID}/turns/1/questions/2/answer`, { selected: ["sqlite"] }]]);
		expect(notes(r).find(n => n.startsWith("☁ answered"))).toBe('☁ answered "Which database?" → sqlite');
	});

	test("Other asks for text: a label selects it, anything else is free text", async () => {
		state.detail = asking();
		const r = await setup();
		r.typed.next = "the one in staging";
		await press(r, { kind: "answer-other", question: "1:2" }, () => posts().length === 1);
		expect(r.asked[0]?.title).toBe(`Fix greeting bug · ${ID} asks: Which database?`);
		expect(posts()[0]?.json).toEqual({ answer: "the one in staging" });
		r.typed.next = "SQLite";
		await press(r, { kind: "answer-other", question: "1:2" }, () => posts().length === 2);
		expect(posts()[1]?.json).toEqual({ selected: ["sqlite"] });
	});

	test("a cancelled free-text answer says so and answers nothing", async () => {
		state.detail = asking();
		const r = await setup();
		r.typed.next = undefined;
		await press(r, { kind: "answer-other", question: "1:2" }, () => notes(r).length === 1);
		expect(notes(r)).toEqual(["☁ answer cancelled"]);
		expect(posts()).toEqual([]);
	});

	test("an answer that leaves questions of the same ask says so", async () => {
		state.detail = asking({
			turns: [
				turn(1, {
					state: "running",
					questions: [
						question({ id: 2, ask: 1, text: "Which database?", options: [{ label: "postgres", description: "" }] }),
						question({ id: 3, ask: 1, text: "Which cache?" }),
					],
				}),
			],
		});
		const r = await setup();
		await press(r, { kind: "answer", question: "1:2", option: 0 }, () => notes(r).some(n => n.includes("still wait")));
		expect(notes(r).find(n => n.includes("still wait"))).toBe(`☁ 1 question still wait on Fix greeting bug · ${ID}: /cloud answer ${SHORT}`);
	});

	test("a question that is no longer pending is reported closed and nothing is posted", async () => {
		state.detail = detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "idle", turns: [turn(1, { questions: [question({ id: 2, ask: 1, answeredAt: "2026-01-01T00:02:00Z" })] })] });
		const r = await setup();
		await press(r, { kind: "answer", question: "1:2", option: 0 }, () => notes(r).length === 1);
		expect(notes(r)[0]).toBe(`☁ that question on Fix greeting bug · ${ID} is closed already`);
		expect(posts()).toEqual([]);
	});

	test("a question key that names another turn or an option that does not exist is refused", async () => {
		state.detail = asking();
		const r = await setup();
		await press(r, { kind: "answer", question: "7:2", option: 0 }, () => notes(r).length === 1);
		expect(notes(r)[0]).toContain("is closed already");
		await press(r, { kind: "answer", question: "1:2", option: 5 }, () => notes(r).length === 2);
		expect(notes(r)[1]).toContain("has no such option");
		expect(posts()).toEqual([]);
	});

	test("a several-choice question is answered through omp's own prompts", async () => {
		state.detail = asking({
			turns: [
				turn(1, {
					state: "running",
					questions: [question({ id: 2, ask: 1, text: "Which databases?", multi: true, options: [{ label: "postgres", description: "" }, { label: "sqlite", description: "" }] })],
				}),
			],
		});
		const r = await setup();
		const picks = ["postgres", "sqlite", "Done (2 selected)"];
		const withSelect = fakeHost({
			cwd: r.host.host.cwd,
			select: async () => picks.shift(),
			input: async () => undefined,
		});
		r.cloud.rebind(withSelect.host);
		r.cloud.run(ID, { kind: "answer-other", question: "1:2" });
		await until(() => posts().length === 1);
		expect(posts()[0]?.json).toEqual({ selected: ["postgres", "sqlite"] });
	});
});

describe("the other buttons run their verbs", () => {
	test("Show posts the same card /cloud show posts", async () => {
		const r = await setup();
		await press(r, { kind: "show" }, () => r.pi.sent.length === 1);
		const card = r.pi.sent[0]?.message.details as { kind: string; title: string };
		expect(card.kind).toBe("notice");
		expect(card.title).toStartWith(`Fix greeting bug · ${ID}`);
	});

	test("Stop stops the thread and reports it as /cloud stop does", async () => {
		const r = await setup();
		await press(r, { kind: "stop" }, () => notes(r).length === 1);
		expect(posts().map(q => q.path)).toEqual([`/api/v1/threads/${ID}/stop`]);
		expect(notes(r)).toEqual([`☁ stopped Fix greeting bug · ${ID}: running yes, cancelled 2`]);
	});

	test("Pull runs the pull path: outside a git repository it says so, as /cloud pull does", async () => {
		const r = await setup();
		await press(r, { kind: "pull" }, () => notes(r).length === 1);
		expect(notes(r)[0]).toBe("☁ not a git repository");
		expect(r.host.notes[0]?.[1]).toBe("error");
	});

	test("Resume needs a command context; with one it runs the resume path", async () => {
		const r = await setup();
		await press(r, { kind: "resume" }, () => notes(r).length === 1);
		expect(notes(r)[0]).toBe(`☁ resuming switches the session: run /cloud resume ${SHORT}`);

		await r.cloud.handle("unwatch", { ...r.host.host, switchSession: async () => ({ cancelled: false }) });
		await press(r, { kind: "resume" }, () => notes(r).length === 2);
		expect(notes(r)[1]).toBe("☁ not a git repository");
	});
});

describe("failures are notifications, never throws", () => {
	test("a deleted or unknown thread is reported gone", async () => {
		state.listed = [];
		const r = await setup();
		await press(r, { kind: "reply" }, () => notes(r).length === 1);
		expect(notes(r)[0]).toBe(`☁ ${SHORT} no longer exists`);
		expect(r.asked).toEqual([]);
	});

	test("a thread deleted between the list and the action is reported gone", async () => {
		const r = await setup();
		state.gone = true;
		await press(r, { kind: "show" }, () => notes(r).length === 1);
		expect(notes(r)[0]).toBe(`☁ ${SHORT} no longer exists`);
		expect(r.pi.sent).toEqual([]);
	});

	test("an unreachable service is an error notification", async () => {
		const env = await cloudEnv("url: http://127.0.0.1:9\ntoken: tok\n");
		const host = fakeHost({ cwd: await tmp("omp-cloud-cwd-"), input: async () => "x" });
		const cloud = new Cloud(fakePi().pi, "/own", env, undefined, undefined, undefined, FAST_RETRY);
		cloud.rebind(host.host);
		cloud.run(ID, { kind: "stop" });
		await until(() => host.notes.length === 1);
		expect(host.notes[0]?.[1]).toBe("error");
	});

	test("with no context yet a button does nothing and does not throw", async () => {
		const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\n`);
		const cloud = new Cloud(fakePi().pi, "/own", env);
		expect(() => cloud.run(ID, { kind: "stop" })).not.toThrow();
		expect(posts()).toEqual([]);
	});
});
