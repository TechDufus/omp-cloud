import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudClient, type ClientTuning } from "../src/api";
import { CloudError } from "../src/errors";
import type { HandoffRequest } from "../src/types";
import { detail, summary, turn, whoami } from "./builders";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

interface Seen {
	method: string;
	path: string;
	search: string;
	auth: string | null;
	contentType: string | null;
	body: string;
}

let server: Bun.Server<undefined>;
let seen: Seen[] = [];
/** The reply of the current test; every request is recorded first. */
let reply: (req: Request, url: URL) => Response | Promise<Response> = () => Response.json({ error: "not found" }, { status: 404 });
/** Multipart parts of the last `POST /api/v1/threads`, in arrival order. */
let parts: [string, File | string][] = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const isForm = (req.headers.get("content-type") ?? "").startsWith("multipart/form-data");
			const entry: Seen = {
				method: req.method,
				path: url.pathname,
				search: url.search,
				auth: req.headers.get("authorization"),
				contentType: req.headers.get("content-type"),
				body: "",
			};
			seen.push(entry);
			if (isForm) {
				const fd = await req.formData();
				parts = [...fd.entries()];
			} else {
				entry.body = await req.text();
			}
			return reply(req, url);
		},
	});
});

afterAll(() => server.stop(true));

beforeEach(() => {
	seen = [];
	parts = [];
	reply = () => Response.json({ error: "not found" }, { status: 404 });
});

const FAST: ClientTuning = { backoffMs: [1, 1, 1], random: () => 0.5 };
const client = (token = "tok") => new CloudClient(`http://127.0.0.1:${server.port}`, token, undefined, FAST);

/** The CloudError a call failed with. */
async function failed(call: Promise<unknown>): Promise<CloudError> {
	const err = await call.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(err instanceof CloudError)) throw new Error(`expected a CloudError, got ${String(err)}`);
	return err;
}

const last = (): Seen => {
	const s = seen.at(-1);
	if (!s) throw new Error("the server saw no request");
	return s;
};

describe("auth and errors", () => {
	test("every request carries the bearer token", async () => {
		reply = () => Response.json(whoami());
		await client("secret-token").whoami();
		expect(last().auth).toBe("Bearer secret-token");
		expect(last().path).toBe("/api/v1/whoami");
	});

	test("a 401 is an unauthorized CloudError carrying the service's message and a hint", async () => {
		reply = req =>
			req.headers.get("authorization") === "Bearer good"
				? Response.json(whoami())
				: Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="omp-cloud"' } });
		expect((await client("good").whoami()).user).toBe("owner");
		const err = await failed(client("bad").whoami());
		expect(err).toMatchObject({ code: "unauthorized", status: 401, message: "unauthorized", retriable: false });
		expect(err.hint).toContain("/cloud connect");
	});

	test("the {error} body of a failure becomes the message", async () => {
		reply = () => Response.json({ error: "thread has failed; start a new one" }, { status: 409 });
		const err = await failed(client().sendMessage("k3x9fa2m7q1z", "hi"));
		expect(err).toMatchObject({ code: "conflict", status: 409, message: "thread has failed; start a new one", retriable: false });
	});

	test("an error without a usable JSON body keeps the status line (a 502 is unavailable and is retried)", async () => {
		reply = () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
		const err = await failed(client().listThreads());
		expect(err).toMatchObject({ code: "unavailable", status: 502, message: "502 Bad Gateway", retriable: true });
		expect(seen).toHaveLength(4);
	});

	test("an unreachable service is an unreachable CloudError naming it, without runtime boilerplate", async () => {
		const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
		const url = `http://127.0.0.1:${dead.port}`;
		await dead.stop(true);
		const err = await failed(new CloudClient(url, "tok", undefined, FAST).whoami());
		expect(err).toMatchObject({ code: "unreachable", retriable: true, outcomeKnown: true });
		expect(err.message).toBe(`cannot reach ${url}: connection refused`);
	});

	test("trailing slashes of the base URL do not double up", async () => {
		reply = () => Response.json(whoami());
		await new CloudClient(`http://127.0.0.1:${server.port}///`, "tok").whoami();
		expect(last().path).toBe("/api/v1/whoami");
	});
});

describe("whoami", () => {
	test("parses every field", async () => {
		const sent = whoami({
			user: "ada",
			maxUploadBytes: 12345,
			defaultModel: "anthropic/claude-opus-5",
			modelPatterns: ["anthropic/*", "openai-codex/*"],
			ompVersion: "18.12.3",
			gitHosts: ["git.example.test:8443", "github.com"],
			mcpProxy: true,
			mcpLogins: ["https://mcp.example.test/mcp"],
			vms: { running: 2, paused: 1 },
			threads: { starting: 1, working: 2, waiting: 3, idle: 4, failed: 5 },
			service: { version: "0.4.0", api: 2 },
			capabilities: ["threads.paging"],
			spend: { todayUSD: 0.5, dayCapUSD: 10 },
			models: [{ id: "anthropic/claude-opus-5" }],
		});
		reply = () => Response.json(sent);
		expect(await client().whoami()).toEqual(sent);
	});

	test("absent and mistyped fields take the API's absent values", async () => {
		reply = () =>
			Response.json({ user: 7, maxUploadBytes: "big", modelPatterns: ["anthropic/*", 3, null], gitHosts: ["github.com", 3, null], vms: "none", threads: { working: "2", idle: 4 } });
		expect(await client().whoami()).toEqual({
			user: "",
			maxUploadBytes: 0,
			defaultModel: "",
			modelPatterns: ["anthropic/*"],
			ompVersion: "",
			gitHosts: ["github.com"],
			mcpProxy: false,
			mcpLogins: [],
			vms: { running: 0, paused: 0 },
			threads: { starting: 0, working: 0, waiting: 0, idle: 4, failed: 0 },
			device: null,
			remote: null,
			service: { version: "", api: 1 },
			capabilities: [],
			limits: { maxMessageBytes: 32768, maxAnswerBytes: 4000, maxUploadBytes: 0, listMax: 50, maxTurns: 200 },
			spend: null,
			models: [],
			update: null,
		});
	});

	test("a response that is not an object is rejected", async () => {
		reply = () => Response.json([1, 2]);
		await expect(client().whoami()).rejects.toThrow("whoami: the response is not a JSON object");
	});
});

describe("threads", () => {
	test("listThreads parses the summaries; an unknown phase falls back to idle", async () => {
		reply = () =>
			Response.json({
				threads: [
					summary({ id: "aaaaaaaaaaaa", phase: "working", turns: 3, queued: 1 }),
					{ ...summary({ id: "bbbbbbbbbbbb" }), phase: "exploding", latest: { id: 2, state: "failed", title: "t", reply: "r", error: "e", completedAt: "z" } },
					"not a thread",
				],
			});
		const list = await client().listThreads();
		expect(last().path).toBe("/api/v1/threads");
		expect(list.map(t => [t.id, t.phase])).toEqual([
			["aaaaaaaaaaaa", "working"],
			["bbbbbbbbbbbb", "idle"],
		]);
		expect(list[0]).toMatchObject({ turns: 3, queued: 1, owner: "owner", model: "anthropic/claude-sonnet-5-5", thinking: "high", ompVersion: "18.12.3" });
		expect(list[1]?.latest).toEqual({ id: 2, state: "failed", title: "t", reply: "r", error: "e", completedAt: "z" });
		expect(list[0]?.latest).toBeNull();
	});

	test("a list without a threads array is empty", async () => {
		reply = () => Response.json({});
		expect(await client().listThreads()).toEqual([]);
	});

	test("thread() fetches the detail: repo, paths, overlays, turns with questions and usage", async () => {
		const d = detail({
			id: "k3x9fa2m7q1z",
			phase: "waiting",
			configOverlays: ["extra.yml", "overlays/0-x.yml"],
			vm: { sandboxId: "sb1", state: "running", pid: 42 },
			repo: { name: "app", remoteURL: "https://x/app.git", baseRef: "main", baseCommit: "", handoffCommit: "abc", localBranch: "feat" },
			turns: [
				turn(1, {
					reply: "done",
					usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 0.5 },
					questions: [
						{
							id: 7,
							ask: 1,
							key: "q",
							text: "Which?",
							header: "H",
							options: [{ label: "a", description: "A" }],
							multi: true,
							recommended: 0,
							askedAt: "t0",
							kind: "ask",
							expiresAt: null,
							selected: ["a"],
							answer: "free",
							answeredBy: "ada",
							answeredAt: "t1",
							expired: false,
						},
					],
				}),
				turn(2, { state: "running", usage: null }),
			],
		});
		reply = () => Response.json(d);
		const got = await client().thread("k3x9fa2m7q1z");
		expect(last().path).toBe("/api/v1/threads/k3x9fa2m7q1z");
		expect(got).toEqual(d);
	});

	test("thread detail with missing sections takes absent values", async () => {
		reply = () => Response.json({ id: "k3x9fa2m7q1z", turns: [{ id: 1, state: "bogus" }], vm: null, repo: 5 });
		const got = await client().thread("k3x9fa2m7q1z");
		expect(got.repo.name).toBe("");
		expect(got.paths).toEqual({ home: "", workspace: "" });
		expect(got.configOverlays).toEqual([]);
		expect(got.vm).toBeNull();
		expect(got.latest).toBeNull();
		expect(got.turns).toHaveLength(1);
		expect(got.turns[0]).toMatchObject({ id: 1, state: "queued", usage: null, questions: [], reply: "" });
	});

	test("an unknown thread is a not_found error, asked once", async () => {
		const err = await failed(client().thread("nope"));
		expect(err).toMatchObject({ code: "not_found", status: 404, message: "not found", retriable: false });
		expect(seen).toHaveLength(1);
	});

	test("deleteThread sends DELETE and accepts 202", async () => {
		reply = () => Response.json({ status: "deleting" }, { status: 202 });
		await client().deleteThread("k3x9fa2m7q1z");
		expect(last()).toMatchObject({ method: "DELETE", path: "/api/v1/threads/k3x9fa2m7q1z" });
	});
});

describe("turn routes", () => {
	test("message posts {text} and returns the new turn's id", async () => {
		reply = () => Response.json({ turn: turn(4, { state: "queued" }), interrupted: false }, { status: 201 });
		const sent = await client().sendMessage("k3x9fa2m7q1z", "now add tests");
		expect(sent.turn.id).toBe(4);
		expect(sent.interrupted).toBe(false);
		expect(last()).toMatchObject({ method: "POST", path: "/api/v1/threads/k3x9fa2m7q1z/messages", contentType: "application/json" });
		expect(JSON.parse(last().body)).toEqual({ text: "now add tests" });
	});

	test("an interrupting send names its mode and reports the stopped turn and the cancelled queue", async () => {
		reply = () => Response.json({ turn: turn(7, { state: "queued" }), interrupted: true, cancelled: [5, 6] }, { status: 201 });
		const sent = await client().sendMessage("k3x9fa2m7q1z", "stop and do this instead", { mode: "interrupt" });
		expect(sent.interrupted).toBe(true);
		expect(sent.cancelled).toEqual([5, 6]);
		expect(JSON.parse(last().body)).toEqual({ text: "stop and do this instead", mode: "interrupt" });
	});

	test("an answer without a cancelled list has none; junk entries are dropped", async () => {
		reply = () => Response.json({ turn: turn(2), interrupted: true }, { status: 201 });
		expect((await client().sendMessage("k3x9fa2m7q1z", "x", { mode: "interrupt" })).cancelled).toEqual([]);
		reply = () => Response.json({ turn: turn(2), interrupted: true, cancelled: [3, "x", 1.5, null, 4] }, { status: 201 });
		expect((await client().sendMessage("k3x9fa2m7q1z", "x", { mode: "interrupt" })).cancelled).toEqual([3, 4]);
	});

	test("a queue send cancels nothing", async () => {
		reply = () => Response.json({ turn: turn(2), interrupted: false, cancelled: [] }, { status: 201 });
		expect((await client().sendMessage("k3x9fa2m7q1z", "x")).cancelled).toEqual([]);
	});

	test("irc posts {from, body, id} to the thread's /irc and returns the receipt, the stored id and the queued turn", async () => {
		reply = () => Response.json({ receipt: "woken", id: "m-1", turn: turn(4, { state: "queued", origin: "irc", ircFrom: "Main", ircId: "m-1" }) }, { status: 201 });
		const sent = await client().irc("k3x9fa2m7q1z", { from: "Main", body: "now add tests" });
		expect(sent.receipt).toBe("woken");
		expect(sent.id).toBe("m-1");
		expect(sent.turn).toMatchObject({ id: 4, origin: "irc", ircFrom: "Main", ircId: "m-1" });
		expect(seen).toHaveLength(1);
		expect(last()).toMatchObject({ method: "POST", path: "/api/v1/threads/k3x9fa2m7q1z/irc", contentType: "application/json" });
		expect(JSON.parse(last().body)).toEqual({ from: "Main", body: "now add tests", id: expect.any(String) });
	});

	test("irc carries replyTo and the message id when given, and leaves an empty replyTo out", async () => {
		reply = () => Response.json({ receipt: "injected", id: "m-2", turn: null }, { status: 201 });
		const sent = await client().irc("k3x9fa2m7q1z", { from: "Main", body: "also the docs", replyTo: "m-0", id: "m-2" });
		expect(sent).toEqual({ receipt: "injected", id: "m-2", turn: null });
		expect(JSON.parse(last().body)).toEqual({ from: "Main", body: "also the docs", replyTo: "m-0", id: "m-2" });

		await client().irc("k3x9fa2m7q1z", { from: "Main", body: "x", replyTo: "" });
		expect(JSON.parse(last().body)).toEqual({ from: "Main", body: "x", id: expect.any(String) });
	});

	test("irc encodes the thread id in the path and takes a revived receipt", async () => {
		reply = () => Response.json({ receipt: "revived", id: "m-3", turn: turn(5, { state: "queued" }) }, { status: 201 });
		expect((await client().irc("a/b c", { from: "Main", body: "x" })).receipt).toBe("revived");
		expect(last().path).toBe("/api/v1/threads/a%2Fb%20c/irc");
	});

	test("irc on a failed thread is a final 409 conflict with the service's words, asked once", async () => {
		reply = () => Response.json({ error: "thread has failed; start a new one" }, { status: 409 });
		const err = await failed(client().irc("k3x9fa2m7q1z", { from: "Main", body: "hi" }));
		expect(err).toMatchObject({ code: "conflict", status: 409, message: "thread has failed; start a new one", retriable: false });
		expect(seen).toHaveLength(1);
	});

	test("irc on an unknown thread is not_found, and an answer with a receipt this client does not know is an error", async () => {
		expect(await failed(client().irc("k3x9fa2m7q1z", { from: "Main", body: "hi" }))).toMatchObject({ code: "not_found", status: 404 });
		reply = () => Response.json({ receipt: "teleported", id: "m", turn: null }, { status: 201 });
		await expect(client().irc("k3x9fa2m7q1z", { from: "Main", body: "hi" })).rejects.toThrow("unknown receipt");
	});

	test("irc refuses a pairing code in the body before any request", async () => {
		const code = `ompc1:AbCdEfGhIjKl:s3cr3tS3cr3tS3cr3tS3cr3t:${"A".repeat(43)}@10.0.0.1:8443`;
		await expect(client().irc("k3x9fa2m7q1z", { from: "Main", body: code })).rejects.toThrow("that looks like a pairing code; use /cloud connect");
		expect(seen).toEqual([]);
	});

	test("a message answer without a turn takes absent values", async () => {
		reply = () => Response.json({}, { status: 201 });
		const sent = await client().sendMessage("k3x9fa2m7q1z", "x");
		expect(sent.turn.id).toBe(0);
		expect(sent.interrupted).toBe(false);
		expect(sent.cancelled).toEqual([]);
	});

	test("stop posts to /stop and returns the counts", async () => {
		reply = () => Response.json({ stoppedRunning: true, cancelled: 2 });
		expect(await client().stop("k3x9fa2m7q1z")).toEqual({ stoppedRunning: true, cancelled: 2 });
		expect(last()).toMatchObject({ method: "POST", path: "/api/v1/threads/k3x9fa2m7q1z/stop" });
		reply = () => Response.json({ stoppedRunning: "yes" });
		expect(await client().stop("k3x9fa2m7q1z")).toEqual({ stoppedRunning: false, cancelled: 0 });
	});

	test("answer posts to the question's route with selected and free text, and parses the answered question", async () => {
		reply = () =>
			Response.json({ id: 9, ask: 2, key: "k", text: "Which?", selected: ["b"], answer: "because", answeredBy: "ada", answeredAt: "t", expired: false });
		const q = await client().answer("k3x9fa2m7q1z", 3, 9, { selected: ["b"], answer: "because" });
		expect(last()).toMatchObject({ method: "POST", path: "/api/v1/threads/k3x9fa2m7q1z/turns/3/questions/9/answer" });
		expect(JSON.parse(last().body)).toEqual({ selected: ["b"], answer: "because" });
		expect(q).toMatchObject({ id: 9, ask: 2, selected: ["b"], answer: "because", answeredBy: "ada", header: "", options: [], recommended: null });
	});

	test("answer sends only what was given", async () => {
		reply = () => Response.json({ id: 1 });
		await client().answer("k3x9fa2m7q1z", 1, 1, { answer: "free text" });
		expect(JSON.parse(last().body)).toEqual({ answer: "free text" });
	});

	test("answering an already answered question surfaces the 409 message", async () => {
		reply = () => Response.json({ error: "question is not waiting for an answer" }, { status: 409 });
		const err = await failed(client().answer("k3x9fa2m7q1z", 1, 1, { answer: "x" }));
		expect(err).toMatchObject({ code: "conflict", status: 409, message: "question is not waiting for an answer", retriable: false });
	});
});

describe("createThread", () => {
	const request = (): HandoffRequest => ({
		prompt: "do it",
		model: "anthropic/claude-sonnet-5-5",
		thinking: "high",
		repo: { name: "app", remoteURL: "", baseRef: "main", baseCommit: "", handoffCommit: "abc", localBranch: "main" },
		paths: { home: "/home/ada", workspace: "/home/ada/app" },
		author: { name: "Ada", email: "ada@example.com" },
		secretFiles: [],
		secretEnv: {},
		configOverlays: ["config.yml", "overlays/0-x.yml"],
		ompVersion: "18.12.3",
	});

	test("parts arrive in the order request, source, conversation, setup with their types and contents", async () => {
		reply = () => Response.json(summary({ id: "newthread123", warnings: ["model x is not available; using y"] }), { status: 201 });
		const dir = await tmp();
		await writeFile(join(dir, "s.bundle"), "SRC");
		await writeFile(join(dir, "c.tar"), "CONV");
		await writeFile(join(dir, "setup.tar.gz"), "SETUP");

		const { summary: created, replayed } = await client().createThread({
			request: request(),
			source: join(dir, "s.bundle"),
			conversation: join(dir, "c.tar"),
			setup: join(dir, "setup.tar.gz"),
		});

		expect(last()).toMatchObject({ method: "POST", path: "/api/v1/threads" });
		expect(replayed).toBe(false);
		expect(created.id).toBe("newthread123");
		expect(created.warnings).toEqual(["model x is not available; using y"]);
		expect(parts.map(([k]) => k)).toEqual(["request", "source", "conversation", "setup"]);
		const byName = Object.fromEntries(parts) as Record<string, File>;
		expect(await byName.source?.text()).toBe("SRC");
		expect(await byName.conversation?.text()).toBe("CONV");
		expect(await byName.setup?.text()).toBe("SETUP");
		expect(byName.conversation?.type).toBe("application/x-tar");
		expect(byName.request?.type.startsWith("application/json")).toBe(true);
	});

	test("the request part carries the handoff JSON: model, thinking, ompVersion, configOverlays", async () => {
		reply = () => Response.json(summary(), { status: 201 });
		await client().createThread({ request: request() });
		const part = parts.find(([k]) => k === "request")?.[1];
		expect(part).toBeInstanceOf(File);
		expect(JSON.parse(await (part as File).text())).toEqual(request());
	});

	test("optional parts are omitted, not sent empty", async () => {
		reply = () => Response.json(summary(), { status: 201 });
		await client().createThread({ request: request() });
		expect(parts.map(([k]) => k)).toEqual(["request"]);
		const dir = await tmp();
		await writeFile(join(dir, "s.bundle"), "SRC");
		await client().createThread({ request: request(), source: join(dir, "s.bundle") });
		expect(parts.map(([k]) => k)).toEqual(["request", "source"]);
	});

	test("a rejected handoff surfaces the service's message", async () => {
		reply = () => Response.json({ error: "model openai-codex/gpt-5 is not served" }, { status: 400 });
		const err = await failed(client().createThread({ request: request() }));
		expect(err).toMatchObject({ code: "invalid", status: 400, message: "model openai-codex/gpt-5 is not served", retriable: false });
	});
});

describe("downloads", () => {
	test("downloadResult streams the bundle to dest and returns the X-Omp headers", async () => {
		reply = () => new Response("bundle-bytes", { headers: { "X-Omp-Branch": "omp-cloud/k3x9fa2m7q1z", "X-Omp-Head": "abc", "X-Omp-Base": "def" } });
		const dest = join(await tmp(), "r.bundle");
		const h = await client().downloadResult("k3x9fa2m7q1z", dest);
		expect(last().path).toBe("/api/v1/threads/k3x9fa2m7q1z/result");
		expect(h).toEqual({ branch: "omp-cloud/k3x9fa2m7q1z", head: "abc", base: "def" });
		expect(await readFile(dest, "utf8")).toBe("bundle-bytes");
	});

	test("missing result headers are empty strings", async () => {
		reply = () => new Response("b");
		const dest = join(await tmp(), "r.bundle");
		expect(await client().downloadResult("k3x9fa2m7q1z", dest)).toEqual({ branch: "", head: "", base: "" });
	});

	test("no result yet is a not_found error and writes nothing", async () => {
		reply = () => Response.json({ error: "no result yet" }, { status: 404 });
		const dest = join(await tmp(), "r.bundle");
		const err = await failed(client().downloadResult("k3x9fa2m7q1z", dest));
		expect(err).toMatchObject({ code: "not_found", status: 404, message: "no result yet" });
		expect(await Bun.file(dest).exists()).toBe(false);
	});

	test("downloadConversation streams the archive byte for byte", async () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255, 10, 13]);
		reply = () => new Response(bytes, { headers: { "Content-Type": "application/x-tar" } });
		const dest = join(await tmp(), "c.tar");
		await client().downloadConversation("k3x9fa2m7q1z", dest);
		expect(last().path).toBe("/api/v1/threads/k3x9fa2m7q1z/conversation");
		expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
	});

	test("no conversation yet is a not_found error", async () => {
		reply = () => Response.json({ error: "no conversation yet" }, { status: 404 });
		const dest = join(await tmp(), "c.tar");
		const err = await failed(client().downloadConversation("k3x9fa2m7q1z", dest));
		expect(err.code).toBe("not_found");
		expect(err.message).toBe("no conversation yet");
	});
});

describe("event stream request", () => {
	test("asks for the SSE stream after a sequence number and resumes with Last-Event-ID", async () => {
		const headers: Headers[] = [];
		reply = req => {
			headers.push(req.headers);
			return new Response(': connected\n\nid: 5\ndata: {"seq":5,"at":"t","kind":"assistant","turn":1,"text":"hi"}\n\n', {
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		const got = [];
		for await (const ev of client().events("k3x9fa2m7q1z", { after: 4, lastEventId: 4 })) got.push(ev);
		expect(got).toEqual([{ seq: 5, at: "t", kind: "assistant", turn: 1, text: "hi" }]);
		expect(last()).toMatchObject({ method: "GET", path: "/api/v1/threads/k3x9fa2m7q1z/events", search: "?after=4" });
		expect(headers[0]?.get("accept")).toBe("text/event-stream");
		expect(headers[0]?.get("last-event-id")).toBe("4");
	});
});
