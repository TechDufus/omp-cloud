import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../git";
import { SigningKey } from "../git/signing-key";
import { GitHubApi } from "../github/api";
import { GitHubApp } from "../github/app";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { SETTING_DEFS } from "../settings/registry";
import type { ThreadPolicy } from "../settings/policy";
import { Store } from "../store";
import {
	MAX_OPTIONS,
	MAX_QUESTION_TEXT_BYTES,
	MAX_TEXT_BYTES,
	MAX_TURNS,
	type NewThread,
	type QuestionInput,
	type TurnResult,
} from "../store/types";
import { API_VERSION, SERVICE_VERSION } from "../version";
import { LoginManager } from "../auth/login";
import { type App, createApp } from "./app";
import { OWNER, tokenSha256 } from "./auth";
import { MAX_SOURCE_BYTES } from "./limits";

const TOKEN = "s3cret-token";
const ID = "aaaaaaaaaaaa";
const T0 = Date.UTC(2026, 0, 1);
const ORIGIN = "http://omp.test";
const REQUEST_ID = "ui-request-4f9c";
const OMP_VERSION = "18.12.3";
/** The gateway as the app sees it: it serves `served` and a refresh changes nothing. */
const gateway = { served: ["anthropic"], providers: () => gateway.served, refresh: async (): Promise<void> => undefined };
const MODELS = { default: "fake/fake-model", direct: ["fake"], gateway };

/** A login manager that knows no provider: enough to show the login routes are reached, and only after authentication. */
function noLogins(): LoginManager {
	return new LoginManager({
		brokerUrl: "http://127.0.0.1:1",
		brokerTokenFile: "/nonexistent/auth-broker.token",
		flow: { has: () => false, run: () => Promise.reject(new Error("no provider")) },
	});
}

let dir: string;
let store: Store;
let app: App;
let settings: Settings;
let clock: number;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	clock = T0;
	store = Store.open({ dataDir: dir, now: () => new Date(clock) });
	gateway.served = ["anthropic"];
	settings = Settings.load(store);
	const git = await GitService.open({
		dataDir: dir,
		hosts: { "github.com": { credential: "!true", username: "x-access-token" }, "git.example.test:8443": { credential: "!true", username: "ci" } },
		fetchTimeoutSeconds: 30,
		pushTimeoutSeconds: 30,
	});
	const githubApi = new GitHubApi();
	app = createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: MODELS,
		ompVersion: OMP_VERSION,
		logins: noLogins(),
		settings,
		git,
		github: { app: await GitHubApp.open(dir, githubApi), api: githubApi, signingKey: SigningKey.open(dir) },
	});
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

interface CallOptions {
	/** The bearer token; null sends no Authorization header. Defaults to the valid token. */
	token?: string | null;
	/** A string is sent as is, anything else as JSON. */
	body?: unknown;
	headers?: Record<string, string>;
}

function request(method: string, path: string, options: CallOptions = {}): Request {
	const headers = new Headers(options.headers);
	if (options.token !== null) headers.set("Authorization", `Bearer ${options.token ?? TOKEN}`);
	const body = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
	return new Request(ORIGIN + path, { method, headers, body });
}

function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
	return app.fetch(request(method, path, options));
}

/** The value at `keys` (property names and array indexes) below `value`; undefined when the path breaks. */
function at(value: unknown, ...keys: (string | number)[]): unknown {
	let current = value;
	for (const key of keys) {
		if (typeof key === "number") {
			current = Array.isArray(current) ? current[key] : undefined;
		} else {
			current = isRecord(current) ? current[key] : undefined;
		}
	}
	return current;
}

function keysOf(value: unknown): string[] {
	if (!isRecord(value)) throw new Error("expected an object");
	return Object.keys(value).sort();
}

function sorted(...keys: string[]): string[] {
	return keys.sort();
}

async function jsonOf(res: Response): Promise<unknown> {
	return res.json();
}

/** The response is the API's error answer. */
async function expectError(res: Response, status: number, message?: string): Promise<void> {
	expect(res.status).toBe(status);
	expect(res.headers.get("content-type")).toBe("application/json");
	const body = await jsonOf(res);
	expect(keysOf(body)).toEqual(["error"]);
	expect(typeof at(body, "error")).toBe("string");
	if (message !== undefined) expect(at(body, "error")).toBe(message);
}

function id(n: number): string {
	return `t${String(n).padStart(11, "0")}`;
}

function newThread(overrides: Partial<NewThread> = {}): NewThread {
	return {
		owner: OWNER,
		title: "fix the bug",
		prompt: "please fix the bug",
		model: "",
		thinking: "",
		repo: { name: "repo", remoteURL: "https://example.com/r.git", baseRef: "main", baseCommit: "b".repeat(40), handoffCommit: "c".repeat(40), localBranch: "feat" },
		paths: { home: "/home/me", workspace: "/home/me/repo" },
		author: { name: "Me", email: "me@example.com" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: OMP_VERSION,
		policy: {},
		...overrides,
	};
}

function seed(threadId = ID, overrides: Partial<NewThread> = {}): void {
	store.createThread(threadId, newThread(overrides));
}

/** A thread whose first turn is running. */
function seedRunning(threadId = ID, overrides: Partial<NewThread> = {}): void {
	seed(threadId, overrides);
	store.startNextTurn(threadId);
}

function outcome(overrides: Partial<TurnResult> = {}): TurnResult {
	return {
		outcome: "completed",
		error: "",
		reply: "# All done\nbody",
		usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, cost: 0.25 },
		head: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		pushed: false,
		pushError: "",
		pushRef: "",
		...overrides,
	};
}

function ask(overrides: Partial<QuestionInput> = {}): QuestionInput {
	const options = overrides.options ?? [
		{ label: "sqlite", description: "embedded" },
		{ label: "postgres", description: "" },
	];
	return {
		key: "k",
		text: "Which database?",
		header: "DB",
		options,
		multi: false,
		recommended: 1,
		ompKey: `omp-key-${overrides.key ?? "k"}`,
		ompLabels: options.map((o) => `omp-label-${o.label}`),
		...overrides,
	};
}

/** A running turn that asked a single-select question with options and a free-text one, in one ask. */
function seedAsking(): void {
	seedRunning();
	store.askQuestions(ID, 1, [ask(), ask({ key: "why", text: "Why?", header: "", options: [], recommended: null })], REQUEST_ID);
}

const threadPath = (threadId = ID): string => `/api/v1/threads/${threadId}`;
const answerPath = (turn: string | number, question: string | number): string =>
	`${threadPath()}/turns/${turn}/questions/${question}/answer`;

describe("authentication", () => {
	test("a missing or wrong token is 401 with a Bearer challenge, also for unknown routes", async () => {
		seed();
		const cases: [string, CallOptions][] = [
			["/api/v1/whoami", { token: null }],
			["/api/v1/whoami", { token: "wrong" }],
			["/api/v1/nothing-here", { token: null }],
			[threadPath(), { token: null }],
			[`/api/v1/threads/${id(999)}`, { token: "wrong" }],
			["/", { token: null }],
		];
		for (const [path, options] of cases) {
			const res = await call("GET", path, options);
			await expectError(res, 401, "unauthorized");
			expect(res.headers.get("www-authenticate")).toBe('Bearer realm="omp-cloud"');
		}
		const basic = await call("GET", "/api/v1/whoami", { token: null, headers: { Authorization: `Basic ${btoa(`x:${TOKEN}`)}` } });
		expect(basic.status).toBe(401);
		expect((await call("POST", "/api/v1/threads", { token: null, body: "{}" })).status).toBe(401);
		expect((await call("DELETE", threadPath(), { token: null })).status).toBe(401);
		expect(store.getThread(ID)).not.toBeNull();
	});

	test("after authentication an unknown route or method is 404, trailing slashes included", async () => {
		seed();
		const cases: [string, string][] = [
			["GET", "/"],
			["GET", "/api/v1"],
			["GET", "/api/v1/nope"],
			["GET", "/api/v2/whoami"],
			["POST", "/api/v1/whoami"],
			["DELETE", "/api/v1/threads"],
			["PUT", threadPath()],
			["GET", `${threadPath()}/`],
			["GET", "/api/v1/threads/"],
			["GET", "/api/v1/whoami/"],
			["GET", `${threadPath()}/messages`],
			["POST", `${threadPath()}/result`],
			["GET", `${threadPath()}/unknown`],
			["GET", `${threadPath()}/turns`],
			["GET", answerPath(1, 1)],
			["POST", `${answerPath(1, 1)}/`],
			["GET", "/api/v1/threads/AAAAAAAAAAAA"],
			["GET", "/api/v1/threads/short"],
		];
		for (const [method, path] of cases) {
			await expectError(await call(method, path), 404, "not found");
		}
	});
});

describe("common headers", () => {
	test("every kind of response carries no-store and nosniff, and the JSON ones their content type", async () => {
		seed();
		await store.putBlob(ID, "result.bundle", new Uint8Array([1, 2, 3]), 100);
		const json = "application/json";
		const cases: [Response, string][] = [
			[await call("GET", "/api/v1/whoami"), json],
			[await call("GET", "/api/v1/whoami", { token: null }), json],
			[await call("GET", "/api/v1/nope"), json],
			[await call("GET", threadPath(id(1))), json],
			[await call("GET", `${threadPath()}/conversation`), json],
			[await call("POST", `${threadPath()}/messages`, { body: "{nope" }), json],
			[await call("GET", `${threadPath()}/result`), "application/octet-stream"],
			[await call("GET", `${threadPath()}/events`), "text/event-stream"],
			[await call("DELETE", threadPath()), json],
		];
		for (const [res, contentType] of cases) {
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("content-type")).toStartWith(contentType);
		}
		await cases[7]?.[0].body?.cancel();
	});
});

describe("whoami", () => {
	test("counts the owner's threads by phase, leaving other owners out", async () => {
		seed(id(1)); // starting
		seedRunning(id(2)); // working
		seedRunning(id(3));
		store.askQuestions(id(3), 1, [ask()], null); // waiting
		seedRunning(id(4));
		store.completeTurn(id(4), 1, outcome()); // idle
		seed(id(5));
		store.failThread(id(5), "vm lost"); // failed
		seed(id(6), { owner: "someone-else" });
		seed(id(7));
		await store.deleteThread(id(7));

		const res = await call("GET", "/api/v1/whoami");
		expect(res.status).toBe(200);
		expect(await jsonOf(res)).toEqual({
			user: OWNER,
			service: { version: SERVICE_VERSION, api: API_VERSION },
			capabilities: [
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
				"secrets.store",
				"mcp.proxy",
			],
			limits: { maxMessageBytes: MAX_TEXT_BYTES, maxAnswerBytes: MAX_QUESTION_TEXT_BYTES, maxUploadBytes: MAX_SOURCE_BYTES, listMax: 200, maxTurns: MAX_TURNS },
			spend: { todayUSD: 0, dayCapUSD: 0 },
			models: [],
			maxUploadBytes: MAX_SOURCE_BYTES,
			defaultModel: MODELS.default,
			modelPatterns: ["anthropic/*", "fake/*"],
			ompVersion: OMP_VERSION,
			gitHosts: ["git.example.test:8443", "github.com"],
			github: { app: null, signing: false },
			mcpProxy: false,
			mcpLogins: [],
			vms: { running: 0, paused: 0 },
			threads: { starting: 1, working: 1, waiting: 1, idle: 1, failed: 1 },
			device: null,
			remote: null,
			update: { state: "unsupported", available: null },
		});
	});

	test("whoami lists the MCP servers the service holds a login for", async () => {
		store.putMcpCredential("https://b.example.com/mcp", "{}", new Date().toISOString());
		store.putMcpCredential("https://a.example.com/mcp", "{}", new Date().toISOString());
		const body = await jsonOf(await call("GET", "/api/v1/whoami"));
		expect(at(body, "mcpLogins")).toEqual(["https://a.example.com/mcp", "https://b.example.com/mcp"]);
		expect(at(body, "mcpProxy")).toBe(false);
	});

	test("modelPatterns follow the providers the gateway serves now, then the direct ones, each once", async () => {
		gateway.served = ["openai-codex", "fake", "anthropic"];
		expect(at(await jsonOf(await call("GET", "/api/v1/whoami")), "modelPatterns")).toEqual(["openai-codex/*", "fake/*", "anthropic/*"]);
		gateway.served = [];
		expect(at(await jsonOf(await call("GET", "/api/v1/whoami")), "modelPatterns")).toEqual(["fake/*"]);
	});

	test("counts the owner's VMs of live threads by state", async () => {
		seed(id(1));
		seed(id(2));
		seed(id(3));
		seed(id(4), { owner: "someone-else" });
		seed(id(5));
		store.putVm({ threadId: id(1), sandboxId: "s1", state: "running", pid: 1, sessionFile: null });
		store.putVm({ threadId: id(2), sandboxId: "s2", state: "paused", pid: 2, sessionFile: null });
		store.putVm({ threadId: id(3), sandboxId: "s3", state: "paused", pid: 3, sessionFile: null });
		store.putVm({ threadId: id(4), sandboxId: "s4", state: "running", pid: 4, sessionFile: null });
		store.putVm({ threadId: id(5), sandboxId: "s5", state: "running", pid: 5, sessionFile: null });
		await store.deleteThread(id(5));
		expect(at(await jsonOf(await call("GET", "/api/v1/whoami")), "vms")).toEqual({ running: 1, paused: 2 });
	});
});

describe("listing", () => {
	test("lists the newest 50 first, as summaries with every field", async () => {
		for (let i = 1; i <= 52; i++) {
			clock = T0 + i * 1000;
			seed(id(i));
		}
		clock = T0 + 60_000;
		seed(id(100), { owner: "someone-else" });

		const res = await call("GET", "/api/v1/threads");
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(keysOf(body)).toEqual(["next", "threads", "total"]);
		expect(at(body, "total")).toBe(52);
		expect(typeof at(body, "next")).toBe("string");
		const threads = at(body, "threads");
		expect(Array.isArray(threads) && threads.length).toBe(50);
		expect(at(body, "threads", 0, "id")).toBe(id(52));
		expect(at(body, "threads", 49, "id")).toBe(id(3));
		for (let i = 0; i < 50; i++) expect(at(body, "threads", i, "owner")).toBe(OWNER);
		expect(keysOf(at(body, "threads", 0))).toEqual(SUMMARY_KEYS);
		for (let i = 0; i < 50; i++) {
			expect(keysOf(at(body, "threads", i, "repo"))).toEqual(sorted("name", "remoteURL", "baseRef", "localBranch"));
			expect(at(body, "threads", i, "workspace")).toBe("/home/me/repo");
		}
	});

	test("an owner without threads gets an empty list", async () => {
		expect(await jsonOf(await call("GET", "/api/v1/threads"))).toEqual({ threads: [], next: null, total: 0 });
	});
});

const SUMMARY_KEYS = sorted(
	"id", "title", "name", "owner", "phase", "error", "turns", "queued", "model", "thinking", "ompVersion", "latest", "question", "result", "createdAt", "lastActivityAt",
	"repo", "workspace", "archivedAt", "pr", "metrics", "activity", "origin", "ref", "session", "scratch",
);
const TURN_KEYS = sorted(
	"id", "state", "text", "by", "origin", "ircFrom", "ircId", "ircReplyTo", "queuedAt", "startedAt", "completedAt", "reply", "title", "error", "usage", "head", "filesChanged",
	"insertions", "deletions", "pushed", "pushError", "pushRef", "requests", "tools", "context", "questions",
);
const QUESTION_KEYS = sorted(
	"id", "ask", "key", "kind", "text", "header", "options", "multi", "recommended", "askedAt", "selected", "answer", "answeredBy", "answeredAt", "expiresAt", "expired",
);
const PENDING_KEYS = sorted("turn", "id", "ask", "kind", "text", "header", "options", "multi", "recommended", "askedAt", "expiresAt", "remaining");

describe("thread detail", () => {
	test("an idle fresh thread has every field, absent values as null, empty or zero", async () => {
		seed(ID, { model: "anthropic/claude", thinking: "high" });
		const res = await call("GET", threadPath());
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(keysOf(body)).toEqual(sorted(...SUMMARY_KEYS, "paths", "configOverlays", "policy", "vm"));
		expect(at(body, "vm")).toBeNull();
		expect(at(body, "phase")).toBe("starting");
		expect(at(body, "latest")).toBeNull();
		expect(at(body, "question")).toBeNull();
		expect(at(body, "result")).toBeNull();
		expect(at(body, "error")).toBe("");
		expect(at(body, "model")).toBe("anthropic/claude");
		expect(keysOf(at(body, "repo"))).toEqual(sorted("name", "remoteURL", "baseRef", "baseCommit", "handoffCommit", "localBranch"));
		expect(keysOf(at(body, "paths"))).toEqual(["home", "workspace"]);
		expect(at(body, "paths", "workspace")).toBe("/home/me/repo");
		const turn = at(body, "turns", 0);
		expect(at(body, "turns")).toHaveLength(1);
		expect(keysOf(turn)).toEqual(TURN_KEYS);
		expect(turn).toMatchObject({ id: 1, state: "queued", text: "please fix the bug", by: OWNER, startedAt: null, completedAt: null, usage: null, questions: [] });
		// A summary shows the turn count where the detail shows the turns.
		const summary = await jsonOf(await call("GET", "/api/v1/threads"));
		expect(at(summary, "threads", 0, "turns")).toBe(1);
		expect(at(summary, "threads", 0, "queued")).toBe(1);
	});

	test("shows the thread's VM as sandboxId, state and pid, nothing else", async () => {
		seed();
		store.putVm({ threadId: ID, sandboxId: "sbx-1", state: "paused", pid: 4242, sessionFile: "/home/user/.omp/session.jsonl" });
		const vm = at(await jsonOf(await call("GET", threadPath())), "vm");
		expect(vm).toEqual({ sandboxId: "sbx-1", state: "paused", pid: 4242 });
		store.putVm({ threadId: ID, sandboxId: "sbx-1", state: "running", pid: null, sessionFile: null });
		expect(at(await jsonOf(await call("GET", threadPath())), "vm")).toEqual({ sandboxId: "sbx-1", state: "running", pid: null });
	});

	test("serves a thread's name, archive state, metrics and activity, and its turns' requests, tools and context", async () => {
		seed(ID, { name: "Fix login" });
		store.startNextTurn(ID);
		clock += 4000;
		store.setThreadContext(ID, { tokens: 19_000, window: 200_000, at: new Date(clock).toISOString() });
		store.appendEvent(ID, "tool", "read src/a.ts", 1);
		const running = await jsonOf(await call("GET", threadPath()));
		expect(at(running, "name")).toBe("Fix login");
		expect(at(running, "archivedAt")).toBeNull();
		expect(at(running, "activity")).toEqual({ kind: "tool", text: "read src/a.ts", at: new Date(clock).toISOString() });
		expect(at(running, "metrics", "context")).toEqual({ tokens: 19_000, window: 200_000, at: new Date(clock).toISOString() });

		store.completeTurn(ID, 1, {
			outcome: "completed", error: "", reply: "ok", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, cost: 0.5 },
			head: "", filesChanged: 0, insertions: 0, deletions: 0, pushed: false, pushError: "", pushRef: "",
			requests: 3, tools: 7, context: { tokens: 19_000, window: 200_000 },
		});
		store.markArchived(ID, new Date(clock).toISOString(), "");
		const done = await jsonOf(await call("GET", threadPath()));
		expect(at(done, "archivedAt")).toBe(new Date(clock).toISOString());
		expect(at(done, "activity")).toBeNull();
		expect(at(done, "metrics")).toEqual({
			usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, cost: 0.5 },
			requests: 3,
			tools: 7,
			workMs: 4000,
			context: { tokens: 19_000, window: 200_000, at: new Date(clock).toISOString() },
			turns: [{ n: 1, cost: 0.5, contextTokens: 19_000 }],
		});
		expect(at(done, "turns", 0)).toMatchObject({ requests: 3, tools: 7, context: { tokens: 19_000, window: 200_000 } });
		expect(at(await jsonOf(await call("GET", "/api/v1/threads")), "threads", 0, "metrics", "requests")).toBe(3);
	});

	test("a fresh thread has empty metrics and no activity", async () => {
		seed();
		const body = await jsonOf(await call("GET", threadPath()));
		expect(at(body, "metrics")).toEqual({
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
			requests: 0,
			tools: 0,
			workMs: 0,
			context: null,
			turns: [],
		});
		expect(at(body, "activity")).toBeNull();
		expect(at(body, "turns", 0, "context")).toBeNull();
	});

	test("never serves a question's requestId, ompKey or ompLabels, nor a turn's promptSentAt", async () => {
		seedAsking();
		store.markPromptSent(ID, 1);
		const text = JSON.stringify(await jsonOf(await call("GET", threadPath())));
		expect(text).toContain("Which database?");
		expect(text).not.toContain(REQUEST_ID);
		expect(text).not.toContain("requestId");
		expect(text).not.toContain("omp-key-");
		expect(text).not.toContain("omp-label-");
		expect(text).not.toContain("ompKey");
		expect(text).not.toContain("ompLabels");
		expect(text).not.toContain("promptSentAt");
		const summary = JSON.stringify(await jsonOf(await call("GET", "/api/v1/threads")));
		expect(summary).toContain("Which database?");
		expect(summary).not.toContain(REQUEST_ID);
		expect(summary).not.toContain("omp-");
		expect(summary).not.toContain("promptSentAt");
	});

	test("cuts a turn's text to 2000 bytes at a character boundary and leaves the stored text whole", async () => {
		const text = "€".repeat(1000); // 3000 bytes, 3 per character
		seed(ID, { prompt: text });
		const body = await jsonOf(await call("GET", threadPath()));
		const shown = at(body, "turns", 0, "text");
		expect(shown).toBe("€".repeat(666));
		expect(store.turns(ID)[0]?.text).toBe(text);
	});

	test("derives latest, result and the open question from the turns", async () => {
		seed(ID, { prompt: "first" });
		store.startNextTurn(ID);
		clock += 1000;
		store.completeTurn(
			ID,
			1,
			outcome({ reply: `# Title\n${"é".repeat(4000)}`, head: "d".repeat(40), filesChanged: 2, insertions: 3, deletions: 1, pushed: false, pushError: "x".repeat(400) }),
		);
		store.enqueueTurn(ID, "second", OWNER);
		clock += 1000;
		store.startNextTurn(ID);
		store.askQuestions(ID, 2, [ask(), ask({ key: "why", text: "Why?", header: "", options: [], recommended: null })], null);

		const body = await jsonOf(await call("GET", threadPath()));
		expect(at(body, "phase")).toBe("waiting");

		const latest = at(body, "latest");
		expect(keysOf(latest)).toEqual(sorted("id", "state", "title", "reply", "error", "completedAt"));
		expect(latest).toMatchObject({ id: 1, state: "done", title: "Title", error: "" });
		expect(Array.from(String(at(latest, "reply"))).length).toBe(3000);
		expect(at(latest, "completedAt")).toBe(new Date(T0 + 1000).toISOString());

		const result = at(body, "result");
		expect(keysOf(result)).toEqual(sorted("branch", "head", "base", "filesChanged", "insertions", "deletions", "pushed", "pushError", "pushRef", "updatedAt"));
		expect(result).toMatchObject({
			branch: `omp-cloud/${ID}`,
			head: "d".repeat(40),
			base: "b".repeat(40),
			filesChanged: 2,
			insertions: 3,
			deletions: 1,
			pushed: false,
			updatedAt: new Date(T0 + 1000).toISOString(),
		});
		expect(at(result, "pushError")).toBe("x".repeat(300));
		expect(at(result, "pushRef")).toBe("");

		const question = at(body, "question");
		expect(keysOf(question)).toEqual(PENDING_KEYS);
		expect(question).toMatchObject({
			turn: 2,
			id: 1,
			ask: 1,
			text: "Which database?",
			header: "DB",
			multi: false,
			recommended: 1,
			remaining: 2,
			options: [
				{ label: "sqlite", description: "embedded" },
				{ label: "postgres", description: "" },
			],
		});

		const turnQuestions = at(body, "turns", 1, "questions");
		expect(turnQuestions).toHaveLength(2);
		expect(keysOf(at(turnQuestions, 0))).toEqual(QUESTION_KEYS);
		expect(at(turnQuestions, 0)).toMatchObject({ selected: [], answer: "", answeredBy: "", answeredAt: null, expired: false });
		expect(at(body, "turns", 0, "usage")).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, cost: 0.25 });
	});

	test("the open question follows the answers and the summary agrees with the detail", async () => {
		seedAsking();
		const summaryQuestion = async (): Promise<unknown> => at(await jsonOf(await call("GET", "/api/v1/threads")), "threads", 0, "question");
		expect(at(await summaryQuestion(), "remaining")).toBe(2);

		await call("POST", answerPath(1, 1), { body: { selected: ["sqlite"] } });
		let body = await jsonOf(await call("GET", threadPath()));
		expect(at(body, "question")).toMatchObject({ id: 2, remaining: 1, options: [] });
		expect(at(await summaryQuestion(), "id")).toBe(2);
		expect(at(body, "phase")).toBe("waiting");

		await call("POST", answerPath(1, 2), { body: { answer: "because" } });
		body = await jsonOf(await call("GET", threadPath()));
		expect(at(body, "question")).toBeNull();
		expect(at(body, "phase")).toBe("working");
		expect(at(body, "turns", 0, "questions", 1)).toMatchObject({ answer: "because", answeredBy: OWNER, expired: false });
	});
});

describe("threads of another owner", () => {
	test("are hidden: every thread route answers 404 and nothing changes", async () => {
		seedRunning(ID, { owner: "someone-else" });
		store.askQuestions(ID, 1, [ask()], null);
		await store.putBlob(ID, "result.bundle", new Uint8Array([1]), 10);
		await store.putBlob(ID, "session.tar", new Uint8Array([1]), 10);
		const cases: [string, string, unknown?][] = [
			["GET", threadPath()],
			["GET", `${threadPath()}/events`],
			["POST", `${threadPath()}/messages`, { text: "hi" }],
			["POST", `${threadPath()}/irc`, { from: "Peer", body: "hi" }],
			["POST", `${threadPath()}/stop`],
			["POST", answerPath(1, 1), { answer: "x" }],
			["GET", `${threadPath()}/result`],
			["GET", `${threadPath()}/conversation`],
			["DELETE", threadPath()],
		];
		for (const [method, path, body] of cases) {
			await expectError(await call(method, path, { body }), 404, "not found");
		}
		expect(store.getThread(ID)).not.toBeNull();
		const turns = store.turns(ID);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.stopRequested).toBe(false);
		expect(turns[0]?.questions[0]?.answeredAt).toBeNull();
		expect(await store.blob(ID, "result.bundle")).not.toBeNull();
	});

	test("an unknown thread id is 404 too", async () => {
		await expectError(await call("GET", threadPath(id(1))), 404, "not found");
		await expectError(await call("POST", `${threadPath(id(1))}/messages`, { body: { text: "hi" } }), 404, "not found");
	});
});

describe("messages", () => {
	test("queue a turn for the caller", async () => {
		seed();
		const res = await call("POST", `${threadPath()}/messages`, { body: { text: "and then?" } });
		expect(res.status).toBe(201);
		const body = await jsonOf(res);
		expect(keysOf(body)).toEqual(["cancelled", "interrupted", "turn"]);
		expect(at(body, "interrupted")).toBe(false);
		expect(at(body, "cancelled")).toEqual([]);
		expect(keysOf(at(body, "turn"))).toEqual(TURN_KEYS);
		expect(at(body, "turn")).toMatchObject({ id: 2, state: "queued", text: "and then?", by: OWNER });
		expect(store.turns(ID).map((t) => t.text)).toEqual(["please fix the bug", "and then?"]);
	});

	test("an empty, missing or too long text is 400; a body that is not a JSON object or has the wrong type is 400", async () => {
		seed();
		const bodies: unknown[] = [
			{ text: "" },
			{},
			{ text: "x".repeat(MAX_TEXT_BYTES + 1) },
			"{nope",
			"",
			"[]",
			"null",
			'"text"',
			{ text: 5 },
			{ text: null },
		];
		for (const body of bodies) {
			const res = await call("POST", `${threadPath()}/messages`, { body });
			await expectError(res, 400);
		}
		expect(await jsonOf(await call("POST", `${threadPath()}/messages`, { body: "{nope" }))).toEqual({ error: "invalid JSON body" });
		expect(store.turns(ID)).toHaveLength(1);
	});

	test("a text of exactly the limit is accepted", async () => {
		seed();
		const res = await call("POST", `${threadPath()}/messages`, { body: { text: "x".repeat(MAX_TEXT_BYTES) } });
		expect(res.status).toBe(201);
	});

	test("a body over the cap is 413, by Content-Length before reading and by counting while reading", async () => {
		seed();
		const cap = MAX_TEXT_BYTES + 4096;
		const declared = await call("POST", `${threadPath()}/messages`, { body: { text: "hi" }, headers: { "Content-Length": String(cap + 1) } });
		await expectError(declared, 413, "request body is too large");

		const chunk = new TextEncoder().encode(`{"text":"${"x".repeat(cap)}`);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.enqueue(new TextEncoder().encode('"}'));
				controller.close();
			},
		});
		const streamed = await app.fetch(
			new Request(ORIGIN + `${threadPath()}/messages`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
				body: stream,
				duplex: "half",
			}),
		);
		await expectError(streamed, 413, "request body is too large");
		expect(store.turns(ID)).toHaveLength(1);
	});

	test("a thread with 200 turns is 409", async () => {
		seed();
		for (let i = 1; i < MAX_TURNS; i++) store.enqueueTurn(ID, "x", OWNER);
		await expectError(await call("POST", `${threadPath()}/messages`, { body: { text: "one more" } }), 409, "thread has 200 turns; start a new one");
		expect(store.turns(ID)).toHaveLength(MAX_TURNS);
	});

	test("a failed thread is 409", async () => {
		seed();
		store.failThread(ID, "vm lost");
		await expectError(await call("POST", `${threadPath()}/messages`, { body: { text: "hi" } }), 409, "thread has failed; start a new one");
	});
});

describe("irc", () => {
	const ircPath = (threadId = ID): string => `${threadPath(threadId)}/irc`;
	const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

	/** The thread's idle: its turn finished. */
	function seedIdle(): void {
		seedRunning();
		store.completeTurn(ID, 1, outcome());
	}

	test("into a running turn is injected: 201 with no turn, held for the runner, announced by an irc_in event", async () => {
		seedRunning();
		clock = T0 + 5000;
		const res = await call("POST", ircPath(), { body: { from: "Parent", body: "any news?", replyTo: "ask-1", id: "msg-1" } });
		expect(res.status).toBe(201);
		const body = await jsonOf(res);
		expect(keysOf(body)).toEqual(["id", "receipt", "turn"]);
		expect(body).toEqual({ receipt: "injected", id: "msg-1", turn: null });
		expect(store.turns(ID)).toHaveLength(1);
		expect(store.pendingIrc(ID, 1)).toMatchObject([{ id: "msg-1", turn: 1, from: "Parent" }]);
		const event = store.events(ID, 0, 100).find((e) => e.kind === "irc_in");
		expect(event).toMatchObject({ turn: 1 });
		expect(JSON.parse(event?.text ?? "")).toEqual({ id: "msg-1", from: "Parent", to: "", body: "any news?", replyTo: "ask-1", at: new Date(T0 + 5000).toISOString() });
	});

	test("into an idle thread is woken: 201 with the queued irc turn as a turn view", async () => {
		seedIdle();
		const res = await call("POST", ircPath(), { body: { from: "Peer.2", body: "wake up", replyTo: "ask-9", id: "msg-2" } });
		expect(res.status).toBe(201);
		const body = await jsonOf(res);
		expect(keysOf(body)).toEqual(["id", "receipt", "turn"]);
		expect(at(body, "receipt")).toBe("woken");
		expect(at(body, "id")).toBe("msg-2");
		expect(keysOf(at(body, "turn"))).toEqual(TURN_KEYS);
		expect(at(body, "turn")).toMatchObject({
			id: 2,
			state: "queued",
			text: "wake up",
			by: "Peer.2",
			origin: "irc",
			ircFrom: "Peer.2",
			ircId: "msg-2",
			ircReplyTo: "ask-9",
		});
		expect(store.turns(ID).map((t) => [t.state, t.origin])).toEqual([["done", ""], ["queued", "irc"]]);
	});

	test("into an archived thread is revived", async () => {
		seedIdle();
		store.markArchived(ID, new Date(T0).toISOString(), "");
		const res = await call("POST", ircPath(), { body: { from: "Peer", body: "back to work" } });
		expect(res.status).toBe(201);
		const body = await jsonOf(res);
		expect(at(body, "receipt")).toBe("revived");
		expect(at(body, "turn")).toMatchObject({ id: 2, state: "queued", origin: "irc", ircFrom: "Peer" });
	});

	test("a message with no replyTo shows an empty one, and null counts as absent for replyTo and id", async () => {
		seedIdle();
		const plain = await jsonOf(await call("POST", ircPath(), { body: { from: "Peer", body: "one" } }));
		expect(at(plain, "turn")).toMatchObject({ ircReplyTo: "" });
		const nulls = await call("POST", ircPath(), { body: { from: "Peer", body: "two", replyTo: null, id: null } });
		expect(nulls.status).toBe(201);
		const body = await jsonOf(nulls);
		expect(at(body, "turn")).toMatchObject({ ircReplyTo: "" });
		expect(String(at(body, "id"))).toStartWith("irc_");
	});

	test("without an id one is generated (irc_ plus a uuid, a valid name), a different one each time; a supplied id is kept", async () => {
		seedRunning();
		const first = await jsonOf(await call("POST", ircPath(), { body: { from: "Peer", body: "a" } }));
		const second = await jsonOf(await call("POST", ircPath(), { body: { from: "Peer", body: "b" } }));
		const ids = [String(at(first, "id")), String(at(second, "id"))];
		for (const generated of ids) {
			expect(generated).toStartWith("irc_");
			expect(generated).toMatch(NAME_PATTERN);
		}
		expect(ids[0]).not.toBe(ids[1]);
		expect(store.pendingIrc(ID, 1).map((m) => m.id).sort()).toEqual([...ids].sort());

		const supplied = await jsonOf(await call("POST", ircPath(), { body: { from: "Peer", body: "c", id: "My_Id-1.x" } }));
		expect(at(supplied, "id")).toBe("My_Id-1.x");
		const empty = await jsonOf(await call("POST", ircPath(), { body: { from: "Peer", body: "d", id: "" } }));
		expect(String(at(empty, "id"))).toStartWith("irc_");
	});

	test("a repeated id answers as the first time and stores nothing more", async () => {
		seedRunning();
		const send = (): Promise<Response> => call("POST", ircPath(), { body: { from: "Peer", body: "once", id: "dup-1" } });
		const first = await jsonOf(await send());
		const again = await send();
		expect(again.status).toBe(201);
		expect(await jsonOf(again)).toEqual(first);
		expect(store.pendingIrc(ID, 1)).toHaveLength(1);
		expect(store.events(ID, 0, 100).filter((e) => e.kind === "irc_in")).toHaveLength(1);
	});

	test("a repeated id of a message that woke the thread does not queue a second turn", async () => {
		seedIdle();
		const send = (): Promise<Response> => call("POST", ircPath(), { body: { from: "Peer", body: "wake", id: "dup-2" } });
		const first = await jsonOf(await send());
		expect(at(first, "receipt")).toBe("woken");
		const again = await jsonOf(await send());
		expect(at(again, "receipt")).toBe("woken");
		expect(at(again, "id")).toBe("dup-2");
		expect(at(again, "turn", "id")).toBe(at(first, "turn", "id"));
		expect(store.turns(ID).filter((t) => t.origin === "irc")).toHaveLength(1);
		expect(store.events(ID, 0, 100).filter((e) => e.kind === "irc_in")).toHaveLength(1);
	});

	test("a missing, malformed or over long sender, id or replyTo is 400 and nothing is stored", async () => {
		seedRunning();
		const bad: Record<string, unknown>[] = [
			{ body: "hi" },
			{ from: "", body: "hi" },
			{ from: "has space", body: "hi" },
			{ from: "a/b", body: "hi" },
			{ from: "é", body: "hi" },
			{ from: "f".repeat(65), body: "hi" },
			{ from: null, body: "hi" },
			{ from: 5, body: "hi" },
			{ from: "Peer", body: "hi", id: "has space" },
			{ from: "Peer", body: "hi", id: "i".repeat(65) },
			{ from: "Peer", body: "hi", id: 5 },
			{ from: "Peer", body: "hi", replyTo: "has space" },
			{ from: "Peer", body: "hi", replyTo: "r".repeat(65) },
			{ from: "Peer", body: "hi", replyTo: 5 },
			{ from: "Peer", body: "hi", replyTo: ["x"] },
		];
		for (const body of bad) await expectError(await call("POST", ircPath(), { body }), 400);
		expect(store.pendingIrc(ID, 1)).toEqual([]);
		expect(store.events(ID, 0, 100).some((e) => e.kind === "irc_in")).toBe(false);

		for (const accepted of ["f".repeat(64), "Peer.1_x-2"]) {
			expect((await call("POST", ircPath(), { body: { from: accepted, body: "hi" } })).status).toBe(201);
		}
		expect((await call("POST", ircPath(), { body: { from: "Peer", body: "hi", replyTo: "r".repeat(64), id: "i".repeat(64) } })).status).toBe(201);
	});

	test("an empty, blank, missing, non-string or too long body is 400; one of exactly the limit in bytes is accepted", async () => {
		seedRunning();
		const bad: unknown[] = [
			{ from: "Peer", body: "" },
			{ from: "Peer", body: "  \n\t " },
			{ from: "Peer" },
			{ from: "Peer", body: null },
			{ from: "Peer", body: 5 },
			{ from: "Peer", body: "x".repeat(MAX_TEXT_BYTES + 1) },
			// 16385 two-byte characters: within the limit in characters, over it in bytes.
			{ from: "Peer", body: "é".repeat(MAX_TEXT_BYTES / 2 + 1) },
			"{nope",
			"",
			"[]",
			"null",
			'"body"',
		];
		for (const body of bad) await expectError(await call("POST", ircPath(), { body }), 400);
		expect(await jsonOf(await call("POST", ircPath(), { body: "{nope" }))).toEqual({ error: "invalid JSON body" });
		expect(store.pendingIrc(ID, 1)).toEqual([]);

		expect((await call("POST", ircPath(), { body: { from: "Peer", body: "x".repeat(MAX_TEXT_BYTES) } })).status).toBe(201);
		expect((await call("POST", ircPath(), { body: { from: "Peer", body: "é".repeat(MAX_TEXT_BYTES / 2) } })).status).toBe(201);
	});

	test("a body over the cap is 413, by Content-Length before reading and by counting while reading", async () => {
		seedRunning();
		const cap = MAX_TEXT_BYTES + 4096;
		const declared = await call("POST", ircPath(), { body: { from: "Peer", body: "hi" }, headers: { "Content-Length": String(cap + 1) } });
		await expectError(declared, 413, "request body is too large");

		const chunk = new TextEncoder().encode(`{"from":"Peer","body":"${"x".repeat(cap)}`);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.enqueue(new TextEncoder().encode('"}'));
				controller.close();
			},
		});
		const streamed = await app.fetch(
			new Request(ORIGIN + ircPath(), { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: stream, duplex: "half" }),
		);
		await expectError(streamed, 413, "request body is too large");
		expect(store.pendingIrc(ID, 1)).toEqual([]);
	});

	test("needs the token, and is 404 for another owner's thread and an unknown one", async () => {
		seedRunning();
		await expectError(await call("POST", ircPath(), { token: null, body: { from: "Peer", body: "hi" } }), 401, "unauthorized");
		await expectError(await call("POST", ircPath(), { token: "wrong", body: { from: "Peer", body: "hi" } }), 401, "unauthorized");
		expect(store.pendingIrc(ID, 1)).toEqual([]);

		seedRunning(id(1), { owner: "someone-else" });
		await expectError(await call("POST", ircPath(id(1)), { body: { from: "Peer", body: "hi" } }), 404, "not found");
		expect(store.pendingIrc(id(1), 1)).toEqual([]);
		expect(store.events(id(1), 0, 100).some((e) => e.kind === "irc_in")).toBe(false);
		await expectError(await call("POST", ircPath(id(2)), { body: { from: "Peer", body: "hi" } }), 404, "not found");
	});

	test("only POST is routed", async () => {
		seed();
		for (const method of ["GET", "PUT", "DELETE"]) await expectError(await call(method, ircPath()), 404);
	});

	test("a failed thread is 409", async () => {
		seed();
		store.failThread(ID, "vm lost");
		await expectError(await call("POST", ircPath(), { body: { from: "Peer", body: "hi" } }), 409, "thread has failed; start a new one");
	});

	test("a thread with 200 turns is 409 when the message would need a new turn", async () => {
		seed();
		for (let i = 1; i < MAX_TURNS; i++) store.enqueueTurn(ID, "x", OWNER);
		await expectError(await call("POST", ircPath(), { body: { from: "Peer", body: "one more" } }), 409, "thread has 200 turns; start a new one");
		expect(store.turns(ID)).toHaveLength(MAX_TURNS);
	});

	test("the events page carries the irc_in event with the whole message as JSON, not cut", async () => {
		seedRunning();
		const long = "é".repeat(MAX_TEXT_BYTES / 2);
		clock = T0 + 7000;
		await call("POST", ircPath(), { body: { from: "Parent", body: long, replyTo: "ask-3", id: "msg-3" } });
		const res = await call("GET", `${threadPath()}/events?format=json&kind=irc_in`);
		expect(res.status).toBe(200);
		const page = await jsonOf(res);
		const events = at(page, "events");
		expect(events).toHaveLength(1);
		expect(at(events, 0)).toMatchObject({ kind: "irc_in", turn: 1, at: new Date(T0 + 7000).toISOString() });
		const text = String(at(events, 0, "text"));
		expect(text.length).toBeGreaterThan(MAX_TEXT_BYTES / 2);
		expect(JSON.parse(text)).toEqual({ id: "msg-3", from: "Parent", to: "", body: long, replyTo: "ask-3", at: new Date(T0 + 7000).toISOString() });
	});

	test("the event stream carries the irc_in event, in the backlog and live", async () => {
		seedRunning();
		const long = "x".repeat(20_000);
		await call("POST", ircPath(), { body: { from: "Parent", body: long, id: "msg-4" } });
		const res = await call("GET", `${threadPath()}/events`);
		const reader = res.body?.getReader();
		const decoder = new TextDecoder();
		const payloads: { kind: string; turn: number | null; text: string }[] = [];
		let buffered = "";
		const readUntil = async (count: number): Promise<void> => {
			while (payloads.length < count) {
				const chunk = await reader?.read();
				if (chunk === undefined || chunk.done) throw new Error("the stream ended");
				buffered += decoder.decode(chunk.value, { stream: true });
				for (let end = buffered.indexOf("\n\n"); end !== -1; end = buffered.indexOf("\n\n")) {
					const data = buffered.slice(0, end).split("\n").find((line) => line.startsWith("data: "));
					buffered = buffered.slice(end + 2);
					if (data === undefined) continue;
					const parsed: unknown = JSON.parse(data.slice("data: ".length));
					const turn = at(parsed, "turn");
					payloads.push({ kind: String(at(parsed, "kind")), turn: typeof turn === "number" ? turn : null, text: String(at(parsed, "text")) });
				}
			}
		};
		try {
			const known = store.events(ID, 0, 100).length;
			await readUntil(known);
			const backlog = payloads.find((p) => p.kind === "irc_in");
			expect(backlog?.turn).toBe(1);
			expect(JSON.parse(backlog?.text ?? "")).toMatchObject({ id: "msg-4", from: "Parent", body: long });

			await call("POST", ircPath(), { body: { from: "Parent", body: "second", id: "msg-5" } });
			await readUntil(known + 1);
			const live = payloads.at(-1);
			expect(live?.kind).toBe("irc_in");
			expect(JSON.parse(live?.text ?? "")).toMatchObject({ id: "msg-5", body: "second" });
		} finally {
			await reader?.cancel();
		}
	});

	test("an ordinary turn shows no origin and empty irc fields in the detail and the message answer", async () => {
		seed();
		const detail = await jsonOf(await call("GET", threadPath()));
		expect(at(detail, "turns", 0)).toMatchObject({ origin: "", ircFrom: "", ircId: "", ircReplyTo: "" });
		const sent = await jsonOf(await call("POST", `${threadPath()}/messages`, { body: { text: "and then?" } }));
		expect(at(sent, "turn")).toMatchObject({ origin: "", ircFrom: "", ircId: "", ircReplyTo: "" });
	});

	test("an irc turn shows in the thread detail with its sender", async () => {
		seedIdle();
		await call("POST", ircPath(), { body: { from: "Peer", body: "ping", replyTo: "ask-1", id: "msg-6" } });
		const detail = await jsonOf(await call("GET", threadPath()));
		expect(at(detail, "turns", 1)).toMatchObject({ by: "Peer", origin: "irc", ircFrom: "Peer", ircId: "msg-6", ircReplyTo: "ask-1" });
	});
});

describe("stop", () => {
	test("aborts the running turn, cancels the queued ones and reports both", async () => {
		seedRunning();
		store.enqueueTurn(ID, "two", OWNER);
		store.enqueueTurn(ID, "three", OWNER);
		const res = await call("POST", `${threadPath()}/stop`);
		expect(res.status).toBe(200);
		expect(await jsonOf(res)).toEqual({ stoppedRunning: true, cancelled: 2 });
		const turns = store.turns(ID);
		expect(turns.map((t) => t.state)).toEqual(["running", "cancelled", "cancelled"]);
		expect(turns[0]).toMatchObject({ stopRequested: true, stoppedBy: OWNER });

		const again = await call("POST", `${threadPath()}/stop`);
		expect(again.status).toBe(200);
		expect(await jsonOf(again)).toEqual({ stoppedRunning: true, cancelled: 0 });
	});

	test("an idle thread stops nothing", async () => {
		seedRunning();
		store.completeTurn(ID, 1, outcome());
		expect(await jsonOf(await call("POST", `${threadPath()}/stop`))).toEqual({ stoppedRunning: false, cancelled: 0 });
	});
});

describe("answering a question", () => {
	test("stores the answer for the caller and returns the question", async () => {
		seedAsking();
		const res = await call("POST", answerPath(1, 1), { body: { selected: ["sqlite"], answer: "  fast  " } });
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(keysOf(body)).toEqual(QUESTION_KEYS);
		expect(JSON.stringify(body)).not.toContain(REQUEST_ID);
		expect(JSON.stringify(body)).not.toContain("omp-");
		expect(body).toMatchObject({ id: 1, ask: 1, selected: ["sqlite"], answer: "fast", answeredBy: OWNER, expired: false });
		expect(typeof at(body, "answeredAt")).toBe("string");
		expect(store.turns(ID)[0]?.questions[0]).toMatchObject({ selected: ["sqlite"], answer: "fast", answeredBy: OWNER });
	});

	test("a free-text answer alone is accepted", async () => {
		seedAsking();
		const res = await call("POST", answerPath(1, 2), { body: { answer: "because" } });
		expect(res.status).toBe(200);
		expect(await jsonOf(res)).toMatchObject({ id: 2, selected: [], answer: "because" });
	});

	test("an answer that breaks the rules is 400 and stores nothing", async () => {
		seedAsking();
		const bodies: unknown[] = [
			{},
			{ answer: "   " },
			{ selected: ["mysql"] },
			{ selected: ["sqlite", "postgres"] },
			{ answer: "x".repeat(MAX_QUESTION_TEXT_BYTES + 1) },
		];
		for (const body of bodies) await expectError(await call("POST", answerPath(1, 1), { body }), 400);
		const wrongTypes: unknown[] = ["{nope", "[]", { selected: "sqlite" }, { selected: [1] }, { answer: 5 }, { selected: null }];
		for (const body of wrongTypes) {
			await expectError(await call("POST", answerPath(1, 1), { body }), 400, "invalid JSON body");
		}
		expect(store.turns(ID)[0]?.questions.map((q) => q.answeredAt)).toEqual([null, null]);
	});

	test("an oversized body is 413", async () => {
		seedAsking();
		const cap = MAX_QUESTION_TEXT_BYTES + MAX_OPTIONS * (200 + 16) + 4096;
		await expectError(await call("POST", answerPath(1, 1), { body: { answer: "x".repeat(cap) } }), 413, "request body is too large");
		await expectError(await call("POST", answerPath(1, 1), { body: { answer: "hi" }, headers: { "Content-Length": String(cap + 1) } }), 413);
	});

	test("an unknown turn or question, or ids that are not positive integers, is 404", async () => {
		seedAsking();
		const paths = [
			answerPath(1, 9),
			answerPath(5, 1),
			answerPath("one", "two"),
			answerPath(0, 1),
			answerPath(1, 0),
			answerPath(-1, 1),
			answerPath("1.5", 1),
			answerPath("01", 1),
			answerPath(1, "1e0"),
			answerPath(1, "9007199254740993"),
			answerPath("", 1),
		];
		for (const path of paths) {
			await expectError(await call("POST", path, { body: { answer: "x" } }), 404, "not found");
		}
		expect(store.turns(ID)[0]?.questions.map((q) => q.answeredAt)).toEqual([null, null]);
	});

	test("an answered question, one expired by a stop and one of a finished turn are 409", async () => {
		seedAsking();
		await call("POST", answerPath(1, 1), { body: { answer: "first" } });
		await expectError(await call("POST", answerPath(1, 1), { body: { answer: "again" } }), 409, "question is not waiting for an answer");

		await call("POST", `${threadPath()}/stop`);
		await expectError(await call("POST", answerPath(1, 2), { body: { answer: "late" } }), 409, "question is not waiting for an answer");
		expect(store.turns(ID)[0]?.questions[1]).toMatchObject({ expired: true, answeredBy: "stop" });

		const other = id(2);
		seedRunning(other);
		store.askQuestions(other, 1, [ask()], null);
		store.completeTurn(other, 1, outcome());
		await expectError(await call("POST", `${threadPath(other)}/turns/1/questions/1/answer`, { body: { answer: "x" } }), 409);
	});
});

describe("result and conversation", () => {
	test("are 404 until stored, then served with their headers and exact bytes", async () => {
		seed();
		await expectError(await call("GET", `${threadPath()}/result`), 404, "no result yet");
		await expectError(await call("GET", `${threadPath()}/conversation`), 404, "no conversation yet");

		const bundle = new Uint8Array([0, 1, 2, 255, 254, 13, 10, 13, 10]);
		const tar = new TextEncoder().encode("TAR-BYTES");
		await store.putBlob(ID, "result.bundle", bundle, 1000);
		await store.putBlob(ID, "session.tar", tar, 1000);

		const result = await call("GET", `${threadPath()}/result`);
		expect(result.status).toBe(200);
		expect(result.headers.get("content-type")).toBe("application/octet-stream");
		expect(result.headers.get("accept-ranges")).toBe("bytes");
		expect(result.headers.get("x-omp-branch")).toBe(`omp-cloud/${ID}`);
		expect(result.headers.get("x-omp-base")).toBe("b".repeat(40));
		expect(result.headers.has("x-omp-head")).toBe(false);
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(bundle);

		const conversation = await call("GET", `${threadPath()}/conversation`);
		expect(conversation.status).toBe(200);
		expect(conversation.headers.get("content-type")).toBe("application/x-tar");
		expect(conversation.headers.get("accept-ranges")).toBe("bytes");
		expect(conversation.headers.has("x-omp-branch")).toBe(false);
		expect(await conversation.text()).toBe("TAR-BYTES");
	});

	test("the conversation is the runner's export when there is one, else the upload", async () => {
		seed();
		await store.putBlob(ID, "session-export.tar", new TextEncoder().encode("EXPORT-BYTES"), 1000);
		const exportOnly = await call("GET", `${threadPath()}/conversation`);
		expect(exportOnly.status).toBe(200);
		expect(await exportOnly.text()).toBe("EXPORT-BYTES");

		await store.putBlob(ID, "session.tar", new TextEncoder().encode("TAR-BYTES"), 1000);
		const both = await call("GET", `${threadPath()}/conversation`);
		expect(both.headers.get("content-type")).toBe("application/x-tar");
		expect(await both.text()).toBe("EXPORT-BYTES");

		await rm(store.blobPath(ID, "session-export.tar"));
		expect(await (await call("GET", `${threadPath()}/conversation`)).text()).toBe("TAR-BYTES");
	});

	test("X-Omp-Head names the newest recorded head; X-Omp-Base is empty for a full-history thread", async () => {
		seedRunning(ID, { repo: { ...newThread().repo, baseCommit: "", remoteURL: "" } });
		store.completeTurn(ID, 1, outcome({ head: "e".repeat(40) }));
		await store.putBlob(ID, "result.bundle", new Uint8Array([1]), 10);
		const res = await call("GET", `${threadPath()}/result`);
		expect(res.headers.get("x-omp-head")).toBe("e".repeat(40));
		expect(res.headers.has("x-omp-base")).toBe(true);
		expect(res.headers.get("x-omp-base")).toBe("");
	});

	test("answer a single Range with 206 and an unsatisfiable one with 416 through a real server", async () => {
		seed();
		await store.putBlob(ID, "result.bundle", new TextEncoder().encode("BUNDLE-BYTES"), 100);
		await store.putBlob(ID, "session.tar", new TextEncoder().encode("TAR-BYTES"), 100);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
		try {
			const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
				fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } });

			const partial = await get(`${threadPath()}/result`, { Range: "bytes=0-5" });
			expect(partial.status).toBe(206);
			expect(partial.headers.get("content-range")).toBe("bytes 0-5/12");
			expect(partial.headers.get("x-omp-branch")).toBe(`omp-cloud/${ID}`);
			expect(partial.headers.get("cache-control")).toBe("no-store");
			expect(await partial.text()).toBe("BUNDLE");

			const tail = await get(`${threadPath()}/conversation`, { Range: "bytes=4-" });
			expect(tail.status).toBe(206);
			expect(await tail.text()).toBe("BYTES");

			const beyond = await get(`${threadPath()}/result`, { Range: "bytes=100-" });
			expect(beyond.status).toBe(416);
			expect(beyond.headers.get("content-range")).toBe("bytes */12");
			await beyond.arrayBuffer();

			const whole = await get(`${threadPath()}/result`);
			expect(whole.status).toBe(200);
			expect(whole.headers.get("accept-ranges")).toBe("bytes");
			expect(await whole.text()).toBe("BUNDLE-BYTES");
		} finally {
			await server.stop(true);
		}
	});
});

describe("delete", () => {
	test("is 202, removes the thread and its files, and every route is 404 afterwards", async () => {
		seed();
		await store.putBlob(ID, "result.bundle", new Uint8Array([1]), 10);
		await store.putBlob(ID, "session.tar", new Uint8Array([1]), 10);
		expect(existsSync(join(dir, "threads", ID))).toBe(true);

		const res = await call("DELETE", threadPath());
		expect(res.status).toBe(202);
		expect(await jsonOf(res)).toEqual({ status: "deleting" });
		expect(existsSync(join(dir, "threads", ID))).toBe(false);

		for (const [method, path] of [
			["GET", threadPath()],
			["GET", `${threadPath()}/events`],
			["GET", `${threadPath()}/result`],
			["GET", `${threadPath()}/conversation`],
			["POST", `${threadPath()}/stop`],
			["DELETE", threadPath()],
		] as const) {
			await expectError(await call(method, path), 404, "not found");
		}
		expect(await jsonOf(await call("GET", "/api/v1/threads"))).toEqual({ threads: [], next: null, total: 0 });
	});
});

describe("create", () => {
	function upload(request: unknown, source: string | null = "SOURCE", headers: Record<string, string> = {}): Request {
		const form = new FormData();
		form.append("request", JSON.stringify(request));
		if (source !== null) form.append("source", new Blob([source]), "source");
		return new Request(`${ORIGIN}/api/v1/threads`, { method: "POST", body: form, headers });
	}
	const auth = { Authorization: `Bearer ${TOKEN}` };
	const minimal = { prompt: "fix the bug", repo: { name: "proj", handoffCommit: "a".repeat(40) } };

	test("returns 201 with the thread summary and no warnings", async () => {
		const res = await app.fetch(upload(minimal, "SOURCE", auth));
		expect(res.status).toBe(201);
		const body = await jsonOf(res);
		expect(keysOf(body)).toEqual(sorted(...SUMMARY_KEYS, "warnings"));
		expect(body).toMatchObject({ owner: OWNER, phase: "starting", turns: 1, queued: 1, title: "fix the bug", ompVersion: OMP_VERSION, warnings: [] });
		const threadId = String(at(body, "id"));
		expect(store.getThread(threadId)).not.toBeNull();
		expect(await (await store.blob(threadId, "source.bundle"))?.text()).toBe("SOURCE");
		const detail = await jsonOf(await call("GET", threadPath(threadId)));
		expect(at(detail, "turns", 0, "text")).toBe("fix the bug");
		expect(at(detail, "warnings")).toBeUndefined();
	});

	test("keeps paths as given", async () => {
		const res = await app.fetch(upload({ ...minimal, paths: { home: "/home/ada", workspace: "/usr/work" } }, "SOURCE", auth));
		expect(res.status).toBe(201);
		const body = await jsonOf(res);
		expect(store.getThread(String(at(body, "id")))?.paths).toEqual({ home: "/home/ada", workspace: "/usr/work" });
	});

	test("refuses a model whose provider the cloud cannot run, naming the login", async () => {
		const res = await app.fetch(upload({ ...minimal, model: "openai/gpt-5" }, "SOURCE", auth));
		await expectError(res, 409, "the cloud cannot run openai models; log the cloud broker in with /cloud login openai");
		expect(store.listThreads(OWNER, 10)).toEqual([]);
	});

	test("keeps a served or direct model, and an empty one stays empty", async () => {
		const served = await jsonOf(await app.fetch(upload({ ...minimal, model: "anthropic/claude-sonnet-5:high" }, "SOURCE", auth)));
		expect(at(served, "model")).toBe("anthropic/claude-sonnet-5:high");
		const direct = await jsonOf(await app.fetch(upload({ ...minimal, model: "fake/m" }, "SOURCE", auth)));
		expect(at(direct, "model")).toBe("fake/m");
		const empty = await jsonOf(await app.fetch(upload({ ...minimal, model: "" }, "SOURCE", auth)));
		expect(at(empty, "model")).toBe("");
	});

	test("the owner's environment shows in the creation summary and the thread detail", async () => {
		const request = { ...minimal, configOverlays: ["overlays/claude.yml", "b.yml"], ompVersion: "18.1.0" };
		const created = await jsonOf(await app.fetch(upload(request, "SOURCE", auth)));
		expect(at(created, "ompVersion")).toBe("18.1.0");
		expect(at(created, "configOverlays")).toBeUndefined();
		const id = String(at(created, "id"));
		const detail = await jsonOf(await call("GET", threadPath(id)));
		expect(at(detail, "ompVersion")).toBe("18.1.0");
		expect(at(detail, "configOverlays")).toEqual(["overlays/claude.yml", "b.yml"]);
		const listed = await jsonOf(await call("GET", "/api/v1/threads"));
		expect(at(listed, "threads", 0, "ompVersion")).toBe("18.1.0");
		expect(at(listed, "threads", 0, "configOverlays")).toBeUndefined();
	});

	test("invalid overlays and versions are 400", async () => {
		await expectError(await app.fetch(upload({ ...minimal, configOverlays: ["../x"] }, "SOURCE", auth)), 400);
		await expectError(await app.fetch(upload({ ...minimal, ompVersion: "latest" }, "SOURCE", auth)), 400);
		expect(store.listThreads(OWNER, 10)).toEqual([]);
	});

	test("a thread policy is validated, stored normalized and served in the detail only", async () => {
		const policy: ThreadPolicy = { "bash.patterns": [{ match: "touch /tmp/x*", approval: "deny" }], fetch: false, egress: ["Example.COM"], "spend.turnUSD": 0.5 };
		const created = await jsonOf(await app.fetch(upload({ ...minimal, policy }, "SOURCE", auth)));
		expect(at(created, "policy")).toBeUndefined();
		const id = String(at(created, "id"));
		expect(store.getThread(id)?.policy).toEqual({ ...policy, egress: ["example.com"] });
		expect(at(await jsonOf(await call("GET", threadPath(id))), "policy")).toEqual({ ...policy, egress: ["example.com"] });
		const listed = await jsonOf(await call("GET", "/api/v1/threads"));
		expect(at(listed, "threads", 0, "policy")).toBeUndefined();
	});

	test("a thread without a policy serves {}", async () => {
		const created = await jsonOf(await app.fetch(upload(minimal, "SOURCE", auth)));
		expect(at(await jsonOf(await call("GET", threadPath(String(at(created, "id"))))), "policy")).toEqual({});
	});

	test("a name is trimmed, collapsed and served in the creation summary, the list and the detail; none serves an empty name", async () => {
		const created = await jsonOf(await app.fetch(upload({ ...minimal, name: "  Fix   the\u00a0login bug " }, "SOURCE", auth)));
		expect(at(created, "name")).toBe("Fix the login bug");
		const threadId = String(at(created, "id"));
		expect(at(await jsonOf(await call("GET", threadPath(threadId))), "name")).toBe("Fix the login bug");
		expect(at(await jsonOf(await call("GET", "/api/v1/threads")), "threads", 0, "name")).toBe("Fix the login bug");
		const unnamed = await jsonOf(await app.fetch(upload(minimal, "SOURCE", auth)));
		expect(at(unnamed, "name")).toBe("");
	});

	test.each([["two\nlines"], ["x".repeat(61)], [7], [["a"]]])("an invalid name (%p) is 400 and stores nothing", async (name) => {
		await expectError(await app.fetch(upload({ ...minimal, name }, "SOURCE", auth)), 400, "name must be one line of at most 60 characters");
		expect(store.listThreads(OWNER, 10)).toEqual([]);
	});

	test("an unknown or invalid policy key is 400 and stores nothing", async () => {
		await expectError(await app.fetch(upload({ ...minimal, policy: { nope: 1 } }, "SOURCE", auth)), 400, "unknown policy key nope");
		await expectError(await app.fetch(upload({ ...minimal, policy: { fetch: "no" } }, "SOURCE", auth)), 400, "policy.fetch must be true or false");
		await expectError(await app.fetch(upload({ ...minimal, policy: [] }, "SOURCE", auth)), 400, "policy must be an object");
		expect(store.listThreads(OWNER, 10)).toEqual([]);
	});

	test("a thread egress list may only narrow a non-empty service list", async () => {
		settings.apply({ "policy.egress": ["example.com", "*.github.com"] }, OWNER);
		await expectError(
			await app.fetch(upload({ ...minimal, policy: { egress: ["example.com", "evil.test"] } }, "SOURCE", auth)),
			400,
			"policy.egress of a thread may only narrow the service's list",
		);
		expect(store.listThreads(OWNER, 10)).toEqual([]);
		const narrowed = await app.fetch(upload({ ...minimal, policy: { egress: ["example.com"] } }, "SOURCE", auth));
		expect(narrowed.status).toBe(201);
		settings.apply({ "policy.egress": null }, OWNER);
		const widened = await app.fetch(upload({ ...minimal, policy: { egress: ["evil.test"] } }, "SOURCE", auth));
		expect(widened.status).toBe(201);
	});

	test("an unauthenticated upload stores nothing", async () => {
		const res = await app.fetch(upload(minimal));
		await expectError(res, 401, "unauthorized");
		expect(store.listThreads(OWNER, 10)).toEqual([]);
	});

	test("an invalid upload is the create step's status and stores nothing", async () => {
		await expectError(await app.fetch(upload({ ...minimal, prompt: "" }, "SOURCE", auth)), 400);
		await expectError(await call("POST", "/api/v1/threads", { body: minimal }), 400);
		expect(store.listThreads(OWNER, 10)).toEqual([]);
	});
});

describe("events", () => {
	test("streams the thread's events as text/event-stream", async () => {
		seed();
		const res = await call("GET", `${threadPath()}/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("text/event-stream");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const reader = res.body?.getReader();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toContain("id: 1");
		await reader?.cancel();
	});
});

describe("unexpected failures", () => {
	test("are 500 internal error, logged, and reveal nothing", async () => {
		const failure = new Error("boom: /secret/path");
		spyOn(store, "countThreads").mockImplementation(() => {
			throw failure;
		});
		const log = spyOn(console, "error").mockImplementation(() => {});
		const res = await call("GET", "/api/v1/whoami");
		await expectError(res, 500, "internal error");
		expect(log).toHaveBeenCalledWith(failure);
		expect(res.headers.get("cache-control")).toBe("no-store");
		log.mockRestore();
	});
});

describe("logins", () => {
	test("need the token like every other route", async () => {
		const res = await call("POST", "/api/v1/logins", { token: null, body: { provider: "anthropic" } });
		await expectError(res, 401, "unauthorized");
		expect(res.headers.get("www-authenticate")).toBe('Bearer realm="omp-cloud"');
	});

	test("reach the login handler under the common headers", async () => {
		const unknown = await call("POST", "/api/v1/logins", { body: { provider: "nope" } });
		await expectError(unknown, 400);
		expect(unknown.headers.get("cache-control")).toBe("no-store");
		await expectError(await call("GET", "/api/v1/logins/missing"), 404, "not found");
	});
});

describe("settings", () => {
	const SETTING_FIELDS = sorted("key", "type", "value", "default", "source", "doc", "choices", "updatedAt", "updatedBy");

	/** The `{key: value}` of the push settings (`git.push`, `git.branch`, `git.protected`) of a settings answer. */
	function valuesOf(body: unknown): Record<string, unknown> {
		const list = at(body, "settings");
		if (!Array.isArray(list)) throw new Error("expected a settings list");
		const entries = list.map((entry): [string, unknown] => [String(at(entry, "key")), at(entry, "value")]);
		return Object.fromEntries(entries.filter(([key]) => key === "git.push" || key === "git.branch" || key === "git.protected"));
	}

	test("every route needs the token", async () => {
		const cases: [string, string][] = [
			["GET", "/api/v1/settings"],
			["PUT", "/api/v1/settings"],
			["GET", "/api/v1/settings/audit"],
			["GET", "/api/v1/settings/export"],
			["PUT", "/api/v1/settings/import"],
		];
		for (const [method, path] of cases) {
			const res = await call(method, path, { token: null, body: method === "PUT" ? "{}" : undefined });
			await expectError(res, 401, "unauthorized");
		}
		expect(settings.get("git.push")).toBe("never");
	});

	test("GET lists every setting with every field, defaults first", async () => {
		const res = await call("GET", "/api/v1/settings");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await jsonOf(res);
		expect(keysOf(body)).toEqual(["settings"]);
		const list = at(body, "settings");
		expect(Array.isArray(list) && list.map((entry) => at(entry, "key"))).toEqual(SETTING_DEFS.map((def) => def.key));
		for (const index of [0, 1, 2]) expect(keysOf(at(body, "settings", index))).toEqual(SETTING_FIELDS);
		expect(at(body, "settings", 0)).toEqual({
			key: "git.push",
			type: "enum",
			value: "never",
			default: "never",
			source: "default",
			doc: expect.any(String),
			choices: ["never", "ask", "auto"],
			updatedAt: "",
			updatedBy: "",
		});
		expect(at(body, "settings", 2, "value")).toEqual(["main", "master", "develop", "release/*"]);
	});

	test("PUT sets keys, resets a null one, and answers like GET", async () => {
		clock = T0 + 5000;
		const res = await call("PUT", "/api/v1/settings", { body: { settings: { "git.push": "ask", "git.protected": ["trunk"] } } });
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(valuesOf(body)).toEqual({ "git.push": "ask", "git.branch": "omp-cloud/{thread}", "git.protected": ["trunk"] });
		expect(at(body, "settings", 0)).toMatchObject({
			source: "stored",
			default: "never",
			updatedAt: new Date(T0 + 5000).toISOString(),
			updatedBy: OWNER,
		});
		expect(await jsonOf(await call("GET", "/api/v1/settings"))).toEqual(body);

		const reset = await jsonOf(await call("PUT", "/api/v1/settings", { body: { settings: { "git.protected": null } } }));
		expect(valuesOf(reset)).toEqual({ "git.push": "ask", "git.branch": "omp-cloud/{thread}", "git.protected": ["main", "master", "develop", "release/*"] });
		expect(at(reset, "settings", 2, "source")).toBe("default");
		expect(settings.get("git.push")).toBe("ask");
	});

	test("PUT with an unknown key or an invalid value is 400 and applies nothing", async () => {
		await expectError(await call("PUT", "/api/v1/settings", { body: { settings: { "git.push": "ask", nope: 1 } } }), 400, "unknown setting nope");
		await expectError(
			await call("PUT", "/api/v1/settings", { body: { settings: { "git.push": "ask", "git.branch": "fixed" } } }),
			400,
			"git.branch must contain {thread}",
		);
		await expectError(await call("PUT", "/api/v1/settings", { body: { settings: { "git.push": "yes" } } }), 400, "git.push must be one of never, ask, auto");
		expect(valuesOf(await jsonOf(await call("GET", "/api/v1/settings")))["git.push"]).toBe("never");
		expect(store.settingRows()).toEqual([]);
	});

	test("PUT with a malformed or oversized body is 400 or 413", async () => {
		await expectError(await call("PUT", "/api/v1/settings", { body: "not json" }), 400, "invalid JSON body");
		await expectError(await call("PUT", "/api/v1/settings", { body: [] }), 400);
		await expectError(await call("PUT", "/api/v1/settings", { body: {} }), 400);
		await expectError(await call("PUT", "/api/v1/settings", { body: { settings: "git.push" } }), 400);
		const big = { settings: { "git.protected": ["x".repeat(70 * 1024)] } };
		await expectError(await call("PUT", "/api/v1/settings", { body: big }), 413, "request body is too large");
		expect(store.settingRows()).toEqual([]);
	});

	test("audit lists each change newest first under the caller's name, in pages", async () => {
		for (const mode of ["ask", "auto", "never"]) await call("PUT", "/api/v1/settings", { body: { settings: { "git.push": mode } } });
		const all = await jsonOf(await call("GET", "/api/v1/settings/audit"));
		expect(keysOf(all)).toEqual(["entries", "next"]);
		expect(at(all, "next")).toBe(0);
		expect(at(all, "entries", 0)).toEqual({
			seq: 3,
			at: new Date(T0).toISOString(),
			actor: OWNER,
			action: "reset",
			key: "git.push",
			old: "auto",
			new: null,
		});
		expect(keysOf(at(all, "entries", 1))).toEqual(sorted("seq", "at", "actor", "action", "key", "old", "new"));
		expect(at(all, "entries", 2)).toMatchObject({ seq: 1, action: "set", old: null, new: "ask" });

		const first = await jsonOf(await call("GET", "/api/v1/settings/audit?limit=2"));
		expect((at(first, "entries") as unknown[]).map((entry) => at(entry, "seq"))).toEqual([3, 2]);
		expect(at(first, "next")).toBe(2);
		const second = await jsonOf(await call("GET", `/api/v1/settings/audit?limit=2&before=${String(at(first, "next"))}`));
		expect((at(second, "entries") as unknown[]).map((entry) => at(entry, "seq"))).toEqual([1]);
		expect(at(second, "next")).toBe(0);
	});

	test("audit refuses a bad before or limit", async () => {
		for (const query of ["limit=0", "limit=201", "limit=abc", "limit=1.5", "limit=-1", "before=abc", "before=-1", "before=1e3"]) {
			const res = await call("GET", `/api/v1/settings/audit?${query}`);
			const message = at(await res.json(), "error");
			expect(res.status).toBe(400);
			expect(String(message)).toMatch(/^(before|limit) must be an integer from \d+ to \d+$/);
		}
		expect((await call("GET", "/api/v1/settings/audit?limit=200&before=0")).status).toBe(200);
	});

	test("export is the stored values as nested YAML", async () => {
		const empty = await call("GET", "/api/v1/settings/export");
		expect(empty.status).toBe(200);
		expect(Bun.YAML.parse(await empty.text())).toEqual({});
		await call("PUT", "/api/v1/settings", { body: { settings: { "git.push": "auto", "git.protected": ["trunk"] } } });
		const res = await call("GET", "/api/v1/settings/export");
		expect(res.headers.get("content-type")).toStartWith("application/yaml");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(Bun.YAML.parse(await res.text())).toEqual({ git: { push: "auto", protected: ["trunk"] } });
	});

	test("import replaces by default and merges on request, auditing each change as import", async () => {
		await call("PUT", "/api/v1/settings", { body: { settings: { "git.push": "ask", "git.branch": "bots/{thread}" } } });
		const merged = await call("PUT", "/api/v1/settings/import?mode=merge", { body: "git:\n  protected: [trunk]\n" });
		expect(merged.status).toBe(200);
		expect(valuesOf(await jsonOf(merged))).toEqual({ "git.push": "ask", "git.branch": "bots/{thread}", "git.protected": ["trunk"] });

		const replaced = await call("PUT", "/api/v1/settings/import", { body: "git:\n  push: auto\n" });
		expect(replaced.status).toBe(200);
		expect(valuesOf(await jsonOf(replaced))).toEqual({ "git.push": "auto", "git.branch": "omp-cloud/{thread}", "git.protected": ["main", "master", "develop", "release/*"] });
		expect(at(await jsonOf(await call("GET", "/api/v1/settings/audit?limit=1")), "entries", 0, "action")).toBe("import");

		const exported = await (await call("GET", "/api/v1/settings/export")).text();
		expect(Bun.YAML.parse(exported)).toEqual({ git: { push: "auto" } });
	});

	test("import refuses a bad file, mode or size with a 400 or 413 and applies nothing", async () => {
		await call("PUT", "/api/v1/settings", { body: { settings: { "git.push": "ask" } } });
		await expectError(await call("PUT", "/api/v1/settings/import", { body: "git:\n  nope: 1\n" }), 400, "unknown setting git.nope");
		await expectError(await call("PUT", "/api/v1/settings/import", { body: "git:\n  push: maybe\n" }), 400, "git.push must be one of never, ask, auto");
		await expectError(await call("PUT", "/api/v1/settings/import", { body: "- a\n" }), 400, "the settings file must be a mapping of settings");
		await expectError(await call("PUT", "/api/v1/settings/import?mode=other", { body: "git:\n  push: auto\n" }), 400, "mode must be replace or merge");
		await expectError(await call("PUT", "/api/v1/settings/import", { body: `# ${"x".repeat(70 * 1024)}\n` }), 413, "request body is too large");
		expect(settings.get("git.push")).toBe("ask");
	});

	test("other paths and methods under the prefix are 404", async () => {
		const cases: [string, string][] = [
			["GET", "/api/v1/settings/nope"],
			["POST", "/api/v1/settings"],
			["DELETE", "/api/v1/settings"],
			["POST", "/api/v1/settings/audit"],
			["GET", "/api/v1/settings/import"],
			["PUT", "/api/v1/settings/export"],
			["GET", "/api/v1/settings/audit/extra"],
			["GET", "/api/v1/settings/"],
			["GET", "/api/v1/settingsx"],
		];
		for (const [method, path] of cases) await expectError(await call(method, path), 404, "not found");
	});
});
