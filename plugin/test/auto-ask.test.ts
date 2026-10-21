import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AnswerBody, HostUi } from "../src/types";
import { Cloud } from "../src/verbs";
import { detail, event, pending, question, summary, turn } from "./builders";
import { cloudEnv, fakeHost, fakePi, until, type FakeHost } from "./fakes";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

const ID = "k3x9fa2m7q1z";
const SHORT = "2m7q1z";
const ENC = new TextEncoder();
const OPTIONS = [
	{ label: "postgres", description: "prod" },
	{ label: "sqlite", description: "" },
];

const state = {
	detail: detail(),
	stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
	posted: [] as { path: string; body: AnswerBody }[],
	/** How many times the thread was fetched: a refresh the watcher has made. */
	fetched: 0,
};

const working = () => detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", turns: [turn(1, { state: "running" })] });
const asking = (over: Partial<Parameters<typeof question>[0]> = {}) =>
	detail({
		id: ID,
		name: "Fix greeting bug",
		title: "Add Greet",
		phase: "waiting",
		question: pending({ turn: 1, id: 2, text: "Which database?", options: OPTIONS }),
		turns: [turn(1, { state: "running", questions: [question({ id: 2, ask: 1, key: "db", text: "Which database?", options: OPTIONS, recommended: 0, ...over })] })],
	});

let server: Bun.Server<undefined>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const p = new URL(req.url).pathname;
			const T = `/api/v1/threads/${ID}`;
			if (req.method === "GET" && p === "/api/v1/threads") return Response.json({ threads: [summary({ id: ID, name: "Fix greeting bug", title: "Add Greet" })] });
			if (req.method === "GET" && p === T) {
				state.fetched++;
				return Response.json(state.detail);
			}
			if (req.method === "GET" && p === `${T}/events`) {
				const body = new ReadableStream<Uint8Array>({
					start: c => void (state.stream = c),
					cancel: () => void (state.stream = undefined),
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			}
			if (req.method === "POST" && p === `${T}/messages`) return Response.json({ turn: { id: 2 } }, { status: 201 });
			if (req.method === "POST" && p.startsWith(`${T}/turns/1/questions/`) && p.endsWith("/answer")) {
				const body = (await req.json()) as AnswerBody;
				state.posted.push({ path: p, body });
				return Response.json(question({ id: 2, key: "db", text: "Which database?", options: OPTIONS, selected: body.selected ?? [], answer: body.answer ?? "", answeredAt: "now" }));
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

beforeEach(() => {
	state.detail = working();
	state.stream = undefined;
	state.posted = [];
	state.fetched = 0;
});

const live: { cloud: Cloud; host: FakeHost }[] = [];

afterEach(async () => {
	for (const { cloud, host } of live.splice(0)) {
		await cloud.handle("unwatch", host.host as never);
		cloud.shutdown();
	}
});

type Dialog = NonNullable<HostUi["askDialog"]>;

async function setup(askDialog?: Dialog) {
	const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\ndeliver: transcript\n`);
	const host = fakeHost({ cwd: await tmp("omp-cloud-cwd-") });
	host.host.ui.askDialog = askDialog;
	const cloud = new Cloud(fakePi({ settings: Settings.isolated() }).pi, "/own", env, await tmp("omp-cloud-home-"), () => {}, { notify: () => {}, write: () => {} });
	live.push({ cloud, host });
	// Sending a message makes the session follow the thread.
	await cloud.handle(`send ${SHORT} keep going`, host.host as never);
	await until(() => state.stream !== undefined);
	return { cloud, host };
}

async function push(kind: string, seq: number): Promise<void> {
	await until(() => state.stream !== undefined);
	state.stream?.enqueue(ENC.encode(`id: ${seq}\ndata: ${JSON.stringify(event(seq, { kind, turn: 1 }))}\n\n`));
}

describe("a question of a followed thread", () => {
	test("opens omp's ask dialog by itself, and the answer goes to the service", async () => {
		const dialogs: Parameters<Dialog>[0][] = [];
		const r = await setup(async questions => {
			dialogs.push(questions);
			return { kind: "submit", results: [{ id: "2", question: "Which database?", options: ["postgres", "sqlite"], multi: false, selectedOptions: ["sqlite"] }] };
		});
		state.detail = asking();
		await push("question_asked", 1);
		await until(() => state.posted.length === 1);

		expect(dialogs).toHaveLength(1);
		expect(dialogs[0]).toEqual([
			{ id: "2", question: "Which database?", header: ID, options: [{ label: "postgres", description: "prod" }, { label: "sqlite" }], multi: false, recommended: 0 },
		]);
		expect(state.posted[0]?.path).toBe(`/api/v1/threads/${ID}/turns/1/questions/2/answer`);
		expect(state.posted[0]?.body).toEqual({ selected: ["sqlite"] });
		await until(() => r.host.notes.some(n => n[0].startsWith("☁ answered")));
	});

	test("a dismissed dialog sends nothing and does not come back for the same question", async () => {
		let opened = 0;
		const r = await setup(async () => {
			opened++;
			return undefined;
		});
		state.detail = asking();
		await push("question_asked", 1);
		await until(() => opened === 1);
		// The question stays reachable: the watcher's toast names /cloud answer.
		await until(() => r.host.notes.some(n => n[0].includes("asks: Which database?") && n[0].includes("/cloud answer")));
		const before = state.fetched;
		await push("question_asked", 2);
		await push("turn_started", 3);
		await until(() => state.fetched >= before + 2);
		expect(opened).toBe(1);
		// The dismissal is said once: the quiet notice that names the command, however often the question is announced again.
		const hints = r.host.notes.filter(n => n[0].includes("still waits for an answer"));
		expect(hints).toEqual([[`☁ Fix greeting bug · ${ID} still waits for an answer: /cloud answer ${SHORT} <text> (the card's buttons work too where shown)`, "info"]]);
		expect(state.posted).toEqual([]);
	});

	test("without askDialog the question waits: a toast, no dialog", async () => {
		const r = await setup(undefined);
		state.detail = asking();
		await push("question_asked", 1);
		await until(() => r.host.notes.some(n => n[0].includes("asks: Which database?")));
		// The watcher's toast and its hand-off to the asker are one step: a dialog would have opened by now.
		expect(state.posted).toEqual([]);
	});

	test("answered elsewhere while the dialog is open: the dialog closes and sends nothing", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		await setup((_questions, dialogOptions) => {
			signals.push(dialogOptions?.signal);
			const { promise, resolve } = Promise.withResolvers<undefined>();
			dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined));
			return promise;
		});
		state.detail = asking();
		await push("question_asked", 1);
		await until(() => signals.length === 1);
		state.detail = working();
		await push("question_answered", 2);
		await until(() => signals[0]?.aborted === true);
		expect(state.posted).toEqual([]);
	});
});
