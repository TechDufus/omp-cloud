import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import { MAX_TEXT_BYTES, type NewThread, type QuestionInput, type TurnResult } from "../store/types";
import { type App, createApp } from "./app";
import { OWNER, tokenSha256 } from "./auth";
import { MAX_SOURCE_BYTES } from "./limits";

const TOKEN = "v2-token";
const ORIGIN = "http://omp.test";
const ID = "aaaaaaaaaaaa";
const T0 = Date.UTC(2026, 0, 1);
const QUESTION_TIMEOUT = 1800;

let dir: string;
let store: Store;
let settings: Settings;
let clock: number;
let app: App;

function build(extra: { modelIds?: () => string[]; questionTimeoutSeconds?: number }): App {
	return createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: { default: "fake/fake-model", direct: ["fake"], gateway: { providers: () => ["anthropic"], refresh: async () => undefined } },
		ompVersion: "18.12.3",
		logins: new LoginManager({
			brokerUrl: "http://127.0.0.1:1",
			brokerTokenFile: "/nonexistent/auth-broker.token",
			flow: { has: () => false, run: () => Promise.reject(new Error("no provider")) },
		}),
		settings,
		git: gitService,
		...extra,
	});
}

let gitService: GitService;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-v2-"));
	clock = T0;
	store = Store.open({ dataDir: dir, now: () => new Date(clock) });
	settings = Settings.load(store);
	gitService = await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 30, pushTimeoutSeconds: 30 });
	app = build({ questionTimeoutSeconds: QUESTION_TIMEOUT, modelIds: () => ["anthropic/claude-a", "fake/fake-model"] });
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Request {
	return new Request(ORIGIN + path, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}` },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});
}

const get = (path: string): Promise<Response> => app.fetch(request("GET", path));
const post = (path: string, body: unknown): Promise<Response> => app.fetch(request("POST", path, body));

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
	const body: unknown = await res.json();
	if (!isRecord(body)) throw new Error("expected an object");
	return body;
}

async function expectError(res: Response, status: number, message: string): Promise<void> {
	expect(res.status).toBe(status);
	expect(await jsonOf(res)).toEqual({ error: message });
}

function newThread(prompt = "first"): NewThread {
	return {
		owner: OWNER,
		title: "t",
		prompt,
		model: "",
		thinking: "",
		repo: { name: "repo", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "d".repeat(40), localBranch: "main" },
		paths: { home: "/home/me", workspace: "/home/me/repo" },
		author: { name: "Me", email: "me@example.com" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
	};
}

function outcome(overrides: Partial<TurnResult> = {}): TurnResult {
	return { outcome: "completed", error: "", reply: "ok", usage: null, head: "", filesChanged: 0, insertions: 0, deletions: 0, pushed: false, pushError: "", pushRef: "", ...overrides };
}

function ask(key: string): QuestionInput {
	return { key, text: `question ${key}`, header: "", options: [{ label: "yes", description: "" }, { label: "no", description: "" }], multi: false, recommended: null, ompKey: key, ompLabels: ["yes", "no"] };
}

const path = (suffix = ""): string => `/api/v1/threads/${ID}${suffix}`;

function listOf(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error("expected a list");
	return value.map((item) => {
		if (!isRecord(item)) throw new Error("expected a list of objects");
		return item;
	});
}

describe("whoami (1.1)", () => {
	test("reports the service version and api, what this build serves, the limits it enforces, spend and models", async () => {
		const pkg: unknown = await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json();
		const res = await get("/api/v1/whoami");
		expect(res.status).toBe(200);
		const body = await jsonOf(res);

		expect(body.service).toEqual({ version: isRecord(pkg) ? pkg.version : null, api: 4 });
		expect(body.capabilities).toEqual([
			"threads.paging",
			"threads.meta",
			"threads.idempotency",
			"threads.scratch",
			"turns.reply",
			"events.json",
			"inspect",
			"messages.interrupt",
			"questions.meta",
			"threads.irc",
			"events.live",
			"events.children",
			"github.app",
			"commits.signed",
			"threads.pr",
		]);
		expect(body.limits).toEqual({ maxMessageBytes: 32768, maxAnswerBytes: 4000, maxUploadBytes: MAX_SOURCE_BYTES, listMax: 200, maxTurns: 200 });
		expect(body.models).toEqual([{ id: "anthropic/claude-a" }, { id: "fake/fake-model" }]);
		// What it said before stays.
		expect(body).toMatchObject({ user: OWNER, maxUploadBytes: MAX_SOURCE_BYTES, defaultModel: "fake/fake-model", modelPatterns: ["anthropic/*", "fake/*"], ompVersion: "18.12.3" });
		expect(body.limits).toMatchObject({ maxMessageBytes: MAX_TEXT_BYTES });
	});

	test("spend is the owner's cost of today in UTC against the day cap, 0 for none", async () => {
		clock = Date.now();
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.completeTurn(
			ID,
			1,
			outcome({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.75 } }),
		);
		expect((await jsonOf(await get("/api/v1/whoami"))).spend).toEqual({ todayUSD: 0.75, dayCapUSD: 0 });

		settings.apply({ "policy.spend.dayUSD": 5 }, "owner");
		expect((await jsonOf(await get("/api/v1/whoami"))).spend).toEqual({ todayUSD: 0.75, dayCapUSD: 5 });
		// Yesterday's cost is not today's.
		clock = Date.now() - 36 * 3600_000;
		store.enqueueTurn(ID, "again", OWNER);
		store.startNextTurn(ID);
		store.completeTurn(ID, 2, outcome({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 9 } }));
		expect((await jsonOf(await get("/api/v1/whoami"))).spend).toEqual({ todayUSD: 0.75, dayCapUSD: 5 });
	});

	test("an app without a model list shows none", async () => {
		app = build({});
		expect((await jsonOf(await get("/api/v1/whoami"))).models).toEqual([]);
	});
});

describe("question kind and expiresAt (1.8)", () => {
	test("every question carries kind from its key and the time its timeout runs out", async () => {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.askQuestions(ID, 1, [ask("db"), ask("approval:bash"), ask("omp-cloud:push")], "req-1");
		const expires = new Date(T0 + QUESTION_TIMEOUT * 1000).toISOString();

		const detail = await jsonOf(await get(path()));
		const questions = listOf(listOf(detail.turns)[0]?.questions);
		expect(questions.map((q) => [q.key, q.kind, q.expiresAt])).toEqual([
			["db", "ask", expires],
			["approval:bash", "approval", expires],
			["omp-cloud:push", "push", expires],
		]);
		// The oldest pending question of the summary and the list carries them too.
		expect(detail.question).toMatchObject({ id: 1, kind: "ask", expiresAt: expires });
		const listed = listOf((await jsonOf(await get("/api/v1/threads"))).threads);
		expect(listed[0]?.question).toMatchObject({ kind: "ask", expiresAt: expires });
	});

	test("an answered question has no expiry, and a service without a question timeout shows none", async () => {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.askQuestions(ID, 1, [ask("db"), ask("approval:bash")], "req-1");

		const answered = await post(path("/turns/1/questions/1/answer"), { selected: ["yes"] });
		expect(await jsonOf(answered)).toMatchObject({ id: 1, key: "db", kind: "ask", expiresAt: null, answeredBy: OWNER });
		const detail = await jsonOf(await get(path()));
		expect(detail.question).toMatchObject({ id: 2, kind: "approval" });

		app = build({});
		const bare = await jsonOf(await get(path()));
		expect(bare.question).toMatchObject({ id: 2, kind: "approval", expiresAt: null });
		const turn = listOf(bare.turns)[0];
		expect(listOf(turn?.questions).map((q) => q.expiresAt)).toEqual([null, null]);
	});
});

describe("GET /threads/{id}/turns/{turn}/reply (1.5)", () => {
	const REPLY = `${"a".repeat(9) + "😀"}`.repeat(1000);

	function seedReply(reply = REPLY, error = ""): void {
		store.createThread(ID, newThread("p".repeat(5000)));
		store.startNextTurn(ID);
		store.completeTurn(ID, 1, outcome({ reply, outcome: error === "" ? "completed" : "failed", error }));
	}

	test("pages the full reply by UTF-16 code unit: total, offset, next, and the default limit of 8000", async () => {
		seedReply();
		const first = await jsonOf(await get(path("/turns/1/reply")));
		expect(first).toMatchObject({ turn: 1, part: "reply", total: REPLY.length, offset: 0, next: 8000 });
		expect(String(first.text)).toBe(REPLY.slice(0, 8000));

		let text = "";
		let offset: number | null = 0;
		while (offset !== null) {
			const page = await jsonOf(await get(path(`/turns/1/reply?part=reply&limit=1234&offset=${offset}`)));
			expect(page.offset).toBe(offset);
			text += String(page.text);
			offset = typeof page.next === "number" ? page.next : null;
		}
		expect(text).toBe(REPLY);
	});

	test("a page never splits a surrogate pair, whatever the limit or offset", async () => {
		seedReply("x😀y😀z");
		// 😀 is two code units at 1-2 and 4-5.
		expect(await jsonOf(await get(path("/turns/1/reply?limit=2")))).toMatchObject({ offset: 0, text: "x", next: 1 });
		expect(await jsonOf(await get(path("/turns/1/reply?limit=1&offset=1")))).toMatchObject({ offset: 1, text: "😀", next: 3 });
		expect(await jsonOf(await get(path("/turns/1/reply?limit=3&offset=2")))).toMatchObject({ offset: 3, text: "y😀", next: 6 });
		expect(await jsonOf(await get(path("/turns/1/reply?offset=6")))).toMatchObject({ text: "z", next: null, total: 7 });
		for (let limit = 1; limit <= 7; limit++) {
			let text = "";
			let offset: number | null = 0;
			while (offset !== null) {
				const page = await jsonOf(await get(path(`/turns/1/reply?limit=${limit}&offset=${offset}`)));
				expect(String(page.text).isWellFormed()).toBe(true);
				text += String(page.text);
				offset = typeof page.next === "number" ? page.next : null;
			}
			expect(text).toBe("x😀y😀z");
		}
	});

	test("part=text is the whole prompt (not the 2000 bytes of the view) and part=error the failure", async () => {
		seedReply("done", "it broke");
		const prompt = await jsonOf(await get(path("/turns/1/reply?part=text&limit=32000")));
		expect(prompt).toMatchObject({ part: "text", total: 5000, next: null });
		expect(String(prompt.text)).toBe("p".repeat(5000));
		expect(await jsonOf(await get(path("/turns/1/reply?part=error")))).toMatchObject({ part: "error", text: "it broke", total: 8, next: null });
		expect(await jsonOf(await get(path("/turns/1/reply?part=reply")))).toMatchObject({ text: "done" });
	});

	test("an offset past the end is an empty last page", async () => {
		seedReply("short");
		expect(await jsonOf(await get(path("/turns/1/reply?offset=5")))).toEqual({ turn: 1, part: "reply", total: 5, offset: 5, text: "", next: null });
		expect(await jsonOf(await get(path("/turns/1/reply?offset=999")))).toMatchObject({ text: "", next: null });
	});

	test("an unknown turn is 404, bad parameters are 400, a turn id that is not a number is not a route", async () => {
		seedReply("short");
		await expectError(await get(path("/turns/2/reply")), 404, "no turn 2");
		await expectError(await get(path("/turns/1/reply?part=prompt")), 400, "part must be one of reply, error, text");
		await expectError(await get(path("/turns/1/reply?limit=0")), 400, "limit must be an integer from 1 to 32000");
		await expectError(await get(path("/turns/1/reply?limit=32001")), 400, "limit must be an integer from 1 to 32000");
		await expectError(await get(path("/turns/1/reply?offset=-1")), 400, "offset must be an integer from 0 to 9007199254740991");
		await expectError(await get(path("/turns/x/reply")), 404, "not found");
		await expectError(await get(path("/turns/0/reply")), 404, "not found");
		await expectError(await get("/api/v1/threads/zzzzzzzzzzzz/turns/1/reply"), 404, "not found");
	});
});

describe("GET /threads/{id}/events?format=json (1.6)", () => {
	function seedEvents(): void {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		for (const [kind, turn] of [["tool", 1], ["assistant", 1], ["tool", 1], ["tool", 2], ["note", null], ["tool", 2]] as const) {
			clock += 1000;
			store.appendEvent(ID, kind, `${kind} text`, turn);
		}
	}

	test("lists events as seq, at, kind, turn and text, with next null at the end", async () => {
		seedEvents();
		const res = await get(path("/events?format=json"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = await jsonOf(res);
		const all = store.events(ID, 0, 100);
		expect(body.events).toEqual(all.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, turn: e.turn, text: e.text })));
		expect(body.next).toBeNull();
		expect(listOf(body.events).length).toBeGreaterThanOrEqual(8);
	});

	test("after and limit page through, next being the after of the following page and null on the last", async () => {
		seedEvents();
		const total = store.events(ID, 0, 100).length;
		const seen: number[] = [];
		let after = 0;
		let pages = 0;
		for (;;) {
			const body = await jsonOf(await get(path(`/events?format=json&limit=3&after=${after}`)));
			const events = listOf(body.events);
			seen.push(...events.map((e) => Number(e.seq)));
			pages++;
			if (body.next === null) break;
			expect(body.next).toBe(Number(events.at(-1)?.seq));
			after = Number(body.next);
		}
		expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
		expect(pages).toBe(Math.ceil(total / 3));
		// A page that holds exactly the rest has no next.
		expect((await jsonOf(await get(path(`/events?format=json&after=${total - 3}&limit=3`)))).next).toBeNull();
	});

	test("kind and turn filter, and a filtered page keeps looking past events that do not match", async () => {
		seedEvents();
		const tools = await jsonOf(await get(path("/events?format=json&kind=tool")));
		expect(listOf(tools.events).map((e) => [e.kind, e.turn])).toEqual([["tool", 1], ["tool", 1], ["tool", 2], ["tool", 2]]);
		const second = await jsonOf(await get(path("/events?format=json&kind=tool&turn=2")));
		expect(listOf(second.events).map((e) => e.turn)).toEqual([2, 2]);
		const mixed = await jsonOf(await get(path("/events?format=json&kind=note,assistant")));
		expect(listOf(mixed.events).map((e) => e.kind)).toEqual(["assistant", "note"]);

		const paged = await jsonOf(await get(path("/events?format=json&kind=tool&limit=2")));
		expect(listOf(paged.events).length).toBe(2);
		const rest = await jsonOf(await get(path(`/events?format=json&kind=tool&limit=2&after=${paged.next}`)));
		expect(listOf(rest.events).map((e) => e.turn)).toEqual([2, 2]);
		expect(rest.next).toBeNull();
	});

	test("bad parameters are 400 naming the parameter", async () => {
		seedEvents();
		await expectError(await get(path("/events?format=json&limit=0")), 400, "limit must be an integer from 1 to 500");
		await expectError(await get(path("/events?format=json&limit=501")), 400, "limit must be an integer from 1 to 500");
		await expectError(await get(path("/events?format=json&after=x")), 400, "after must be an integer from 0 to 9007199254740991");
		await expectError(await get(path("/events?format=json&turn=0")), 400, "turn must be an integer from 1 to 9007199254740991");
		await expectError(await get(path("/events?format=json&kind=Tool!")), 400, "kind must be a comma list of at most 32 event kinds");
	});

	test("without format=json the route is still the event stream", async () => {
		seedEvents();
		const controller = new AbortController();
		const res = await app.fetch(request("GET", path("/events"), undefined, controller.signal));
		expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		const reader = res.body?.getReader();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toContain("data: ");
		controller.abort();
		await reader?.cancel().catch(() => undefined);
	});
});

describe("POST /threads/{id}/messages with mode (1.9)", () => {
	function seedBusy(): void {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.askQuestions(ID, 1, [ask("db")], "req-1");
		store.enqueueTurn(ID, "second", OWNER);
		store.enqueueTurn(ID, "third", OWNER);
	}

	test("a plain message queues and says it interrupted nothing", async () => {
		seedBusy();
		for (const body of [{ text: "plain" }, { text: "explicit", mode: "queue" }]) {
			const res = await post(path("/messages"), body);
			expect(res.status).toBe(201);
			const answer = await jsonOf(res);
			expect(answer).toMatchObject({ interrupted: false, cancelled: [] });
			expect(answer.turn).toMatchObject({ state: "queued", text: body.text });
		}
		expect(store.turns(ID).map((t) => t.state)).toEqual(["running", "queued", "queued", "queued", "queued"]);
		expect(store.events(ID, 0, 100).some((e) => e.kind === "stop_requested")).toBe(false);
	});

	test("interrupt stops the running turn and cancels the queued ones as a stop does, then the new turn runs next in id order", async () => {
		seedBusy();
		const res = await post(path("/messages"), { text: "change of plan", mode: "interrupt" });
		expect(res.status).toBe(201);
		const answer = await jsonOf(res);
		expect(answer.interrupted).toBe(true);
		expect(answer.cancelled).toEqual([2, 3]);
		expect(answer.turn).toMatchObject({ id: 4, state: "queued", text: "change of plan", by: OWNER });
		expect(store.turns(ID).map((t) => t.state)).toEqual(["running", "cancelled", "cancelled", "queued"]);
		expect(store.turns(ID)[1]).toMatchObject({ error: `cancelled by ${OWNER}` });
		expect(store.events(ID, 0, 100).filter((e) => e.kind === "stop_requested").map((e) => [e.turn, e.text])).toEqual([[1, `stop requested by ${OWNER}`]]);
		expect(store.events(ID, 0, 100).filter((e) => e.kind === "turn_cancelled").map((e) => e.turn)).toEqual([2, 3]);
		expect(store.turns(ID)[0]?.questions[0]).toMatchObject({ expired: true, answeredBy: "stop" });

		expect(store.completeTurn(ID, 1, outcome())).toMatchObject({ state: "failed", error: `stopped by ${OWNER}` });
		expect(store.startNextTurn(ID)?.id).toBe(4);
	});

	test("interrupt with nothing running cancels the queued turns, queues the message and says it interrupted nothing", async () => {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.completeTurn(ID, 1, outcome());
		store.enqueueTurn(ID, "queued", OWNER);
		const answer = await jsonOf(await post(path("/messages"), { text: "go", mode: "interrupt" }));
		expect(answer).toMatchObject({ interrupted: false, cancelled: [2], turn: { id: 3, state: "queued" } });
		expect(store.turns(ID).map((t) => t.state)).toEqual(["done", "cancelled", "queued"]);
		expect(store.events(ID, 0, 100).some((e) => e.kind === "stop_requested")).toBe(false);
	});

	test("a refused interrupt leaves the running turn alone; a bad mode is 400", async () => {
		seedBusy();
		await expectError(await post(path("/messages"), { text: "", mode: "interrupt" }), 400, "text must be 1 to 32768 bytes");
		const tooLong = await post(path("/messages"), { text: "x".repeat(MAX_TEXT_BYTES + 1), mode: "interrupt" });
		expect(tooLong.status).toBe(400);
		await expectError(await post(path("/messages"), { text: "go", mode: "now" }), 400, "mode must be queue or interrupt");
		await expectError(await post(path("/messages"), { text: "go", mode: 1 }), 400, "invalid JSON body");
		expect(store.turns(ID).map((t) => t.state)).toEqual(["running", "queued", "queued"]);
		expect(store.events(ID, 0, 100).some((e) => e.kind === "stop_requested" || e.kind === "turn_cancelled")).toBe(false);

		store.failThread(ID, "broke");
		await expectError(await post(path("/messages"), { text: "go", mode: "interrupt" }), 409, "thread has failed; start a new one");
	});
});
