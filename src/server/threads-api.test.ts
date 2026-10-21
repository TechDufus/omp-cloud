import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import type { NewThread } from "../store/types";
import { type App, createApp } from "./app";
import { OWNER, tokenSha256 } from "./auth";

const TOKEN = "s3cret-token";
const ORIGIN = "http://omp.test";
const T0 = Date.UTC(2026, 0, 1);
const HANDOFF = "a".repeat(40);
const gateway = { providers: () => ["anthropic"], refresh: async (): Promise<void> => undefined };
const MODELS = { default: "fake/fake-model", direct: ["fake"], gateway };

let dir: string;
let store: Store;
let app: App;
let clock: number;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	clock = T0;
	store = Store.open({ dataDir: dir, now: () => new Date(clock) });
	const git = await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 30, pushTimeoutSeconds: 30 });
	const logins = new LoginManager({
		brokerUrl: "http://127.0.0.1:1",
		brokerTokenFile: "/nonexistent/auth-broker.token",
		flow: { has: () => false, run: () => Promise.reject(new Error("no provider")) },
	});
	app = createApp({ store, apiTokenSha256: tokenSha256(TOKEN), dataDir: dir, models: MODELS, ompVersion: "18.12.3", logins, settings: Settings.load(store), git });
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function at(value: unknown, ...keys: (string | number)[]): unknown {
	let current = value;
	for (const key of keys) {
		if (typeof key === "number") current = Array.isArray(current) ? current[key] : undefined;
		else current = isRecord(current) ? current[key] : undefined;
	}
	return current;
}

async function get(path: string): Promise<Response> {
	return app.fetch(new Request(ORIGIN + path, { headers: { Authorization: `Bearer ${TOKEN}` } }));
}

function seed(id: string, overrides: Partial<NewThread> = {}): void {
	store.createThread(id, {
		owner: OWNER,
		title: "t",
		prompt: "do it",
		model: "",
		thinking: "",
		repo: { name: "repo", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: HANDOFF, localBranch: "" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
		...overrides,
	});
}

describe("GET /api/v1/threads", () => {
	test("pages through every thread with the cursor of `next`; every page says the same total", async () => {
		for (let i = 1; i <= 5; i++) {
			clock = T0 + i * 1000;
			seed(`aaaaaaaaaaa${i}`);
		}
		const seen: string[] = [];
		let path = "/api/v1/threads?limit=2";
		for (let pages = 0; pages < 3; pages++) {
			const body: unknown = await (await get(path)).json();
			expect(at(body, "total")).toBe(5);
			for (const thread of at(body, "threads") as unknown[]) seen.push(String(at(thread, "id")));
			const next = at(body, "next");
			if (pages < 2) path = `/api/v1/threads?limit=2&before=${encodeURIComponent(String(next))}`;
			else expect(next).toBeNull();
		}
		expect(seen).toEqual(["aaaaaaaaaaa5", "aaaaaaaaaaa4", "aaaaaaaaaaa3", "aaaaaaaaaaa2", "aaaaaaaaaaa1"]);
	});

	test("filters by phase, origin, ref, session, repo and since, and the total follows the filter", async () => {
		clock = T0 + 1000;
		seed("aaaaaaaaaaa1", { origin: "tool", ref: "alpha", session: "s1" });
		clock = T0 + 2000;
		seed("aaaaaaaaaaa2", { origin: "user", session: "s1", repo: { name: "other", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: HANDOFF, localBranch: "" } });
		clock = T0 + 3000;
		seed("aaaaaaaaaaa3", { origin: "tool", ref: "beta", session: "s2" });
		store.startNextTurn("aaaaaaaaaaa3");

		const idsOf = async (query: string): Promise<{ ids: string[]; total: unknown }> => {
			const body: unknown = await (await get(`/api/v1/threads?${query}`)).json();
			return { ids: (at(body, "threads") as unknown[]).map(t => String(at(t, "id"))), total: at(body, "total") };
		};
		expect(await idsOf("origin=tool")).toEqual({ ids: ["aaaaaaaaaaa3", "aaaaaaaaaaa1"], total: 2 });
		expect(await idsOf("ref=alpha")).toEqual({ ids: ["aaaaaaaaaaa1"], total: 1 });
		expect(await idsOf("session=s1")).toEqual({ ids: ["aaaaaaaaaaa2", "aaaaaaaaaaa1"], total: 2 });
		expect(await idsOf("repo=other")).toEqual({ ids: ["aaaaaaaaaaa2"], total: 1 });
		expect(await idsOf("phase=working,failed")).toEqual({ ids: ["aaaaaaaaaaa3"], total: 1 });
		expect(await idsOf(`since=${new Date(T0 + 2000).toISOString()}`)).toEqual({ ids: ["aaaaaaaaaaa3", "aaaaaaaaaaa2"], total: 2 });
		expect(await idsOf("origin=tool&limit=1")).toEqual({ ids: ["aaaaaaaaaaa3"], total: 2 });
	});

	test.each([
		["limit=0", "limit"],
		["limit=201", "limit"],
		["limit=ten", "limit"],
		["limit=", "limit"],
		["before=not-a-cursor", "before"],
		["phase=bogus", "phase"],
		["phase=working,deleted", "phase"],
		["origin=robot", "origin"],
		["ref=bad%20ref", "ref"],
		["session=a%0Ab", "session"],
		["repo=", "repo"],
		["since=yesterday", "since"],
		["since=2026-13-45", "since"],
	])("%s is 400 and names %s", async (query, name) => {
		const res = await get(`/api/v1/threads?${query}`);
		expect(res.status).toBe(400);
		expect(String(at(await res.json(), "error"))).toContain(name);
	});
});

describe("POST /api/v1/threads", () => {
	function upload(request: unknown, source: string | null = "SOURCE", headers: Record<string, string> = {}): Request {
		const form = new FormData();
		form.append("request", JSON.stringify(request));
		if (source !== null) form.append("source", new Blob([source]), "source");
		return new Request(`${ORIGIN}/api/v1/threads`, { method: "POST", body: form, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } });
	}
	const minimal = { prompt: "fix the bug", repo: { name: "proj", handoffCommit: HANDOFF } };
	const threadsOnDisk = async (): Promise<string[]> => readdir(join(dir, "threads"));

	describe("metadata", () => {
		test("origin, ref and session are stored and shown in the summary and the detail", async () => {
			const res = await app.fetch(upload({ ...minimal, origin: "tool", ref: "fix-login.1", session: "01HX-session id" }));
			expect(res.status).toBe(201);
			const body: unknown = await res.json();
			expect(body).toMatchObject({ origin: "tool", ref: "fix-login.1", session: "01HX-session id", scratch: false });
			const detail: unknown = await (await get(`/api/v1/threads/${String(at(body, "id"))}`)).json();
			expect(detail).toMatchObject({ origin: "tool", ref: "fix-login.1", session: "01HX-session id", scratch: false });
		});

		test("a request without them shows empty strings", async () => {
			const body: unknown = await (await app.fetch(upload(minimal))).json();
			expect(body).toMatchObject({ origin: "", ref: "", session: "", scratch: false });
		});

		test.each([
			["origin", { origin: "robot" }],
			["origin", { origin: 5 }],
			["ref", { ref: "has space" }],
			["ref", { ref: "a/b" }],
			["ref", { ref: "r".repeat(65) }],
			["session", { session: "s".repeat(129) }],
			["session", { session: "a\nb" }],
			["session", { session: 7 }],
		])("an invalid %s is 400 naming it and stores nothing", async (field, extra) => {
			const res = await app.fetch(upload({ ...minimal, ...extra }));
			expect(res.status).toBe(400);
			expect(String(at(await res.json(), "error"))).toContain(field);
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(0);
			expect(await threadsOnDisk()).toEqual([]);
		});

		test("the ref and session limits are inclusive", async () => {
			const res = await app.fetch(upload({ ...minimal, ref: "r".repeat(64), session: "s".repeat(128) }));
			expect(res.status).toBe(201);
		});
	});

	describe("Idempotency-Key", () => {
		const key = { "Idempotency-Key": "delegate:s1:0" };

		test("the first request creates (201), a repeat of the same prompt answers 200 with the same thread and replayed: true, and creates nothing", async () => {
			const first = await app.fetch(upload(minimal, "SOURCE", key));
			expect(first.status).toBe(201);
			const created: unknown = await first.json();
			// Only the prompt is compared: a retry re-snapshots, so its repository and parts may differ.
			const second = await app.fetch(upload({ prompt: minimal.prompt, repo: { name: "other", handoffCommit: "b".repeat(40) } }, null, key));
			expect(second.status).toBe(200);
			const replay: unknown = await second.json();
			expect(replay).toMatchObject({ id: at(created, "id"), title: "fix the bug", replayed: true });
			expect(at(created, "replayed")).toBeUndefined();
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(1);
			expect(await threadsOnDisk()).toEqual([String(at(created, "id"))]);
		});

		test("a repeat reads only the request part: it answers before the large parts of the upload arrive", async () => {
			await app.fetch(upload(minimal, "SOURCE", key));
			const boundary = "never-ends";
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n${JSON.stringify(minimal)}\r\n`));
					controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\nPART-ONE`));
				},
			});
			const res = await app.fetch(
				new Request(`${ORIGIN}/api/v1/threads`, {
					method: "POST",
					body,
					headers: { Authorization: `Bearer ${TOKEN}`, "content-type": `multipart/form-data; boundary=${boundary}`, ...key },
					duplex: "half",
				} as RequestInit),
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ replayed: true });
		});

		test("the same key with a different prompt is 409 naming the key and the thread, and creates nothing", async () => {
			const created: unknown = await (await app.fetch(upload(minimal, "SOURCE", key))).json();
			const res = await app.fetch(upload({ ...minimal, prompt: "a different task" }, "SOURCE", key));
			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({ error: `Idempotency-Key delegate:s1:0 was used for a different request (thread ${String(at(created, "id"))})` });
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(1);
			expect(await threadsOnDisk()).toEqual([String(at(created, "id"))]);
			// The original request still replays.
			expect((await app.fetch(upload(minimal, null, key))).status).toBe(200);
		});

		test("a request without the header is never a replay", async () => {
			await app.fetch(upload(minimal));
			const second = await app.fetch(upload(minimal));
			expect(second.status).toBe(201);
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(2);
		});

		test("a different key creates another thread", async () => {
			await app.fetch(upload(minimal, "SOURCE", key));
			const other = await app.fetch(upload(minimal, "SOURCE", { "Idempotency-Key": "delegate:s1:1" }));
			expect(other.status).toBe(201);
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(2);
		});

		test("once the thread is deleted the key creates a new thread, whatever the prompt", async () => {
			const created: unknown = await (await app.fetch(upload(minimal, "SOURCE", key))).json();
			await store.deleteThread(String(at(created, "id")));
			const again = await app.fetch(upload({ ...minimal, prompt: "a different task" }, "SOURCE", key));
			expect(again.status).toBe(201);
			expect(at(await again.json(), "id")).not.toBe(at(created, "id"));
		});

		test("a create that failed leaves its key free", async () => {
			const bad = await app.fetch(upload({ ...minimal, prompt: "" }, "SOURCE", key));
			expect(bad.status).toBe(400);
			const good = await app.fetch(upload(minimal, "SOURCE", key));
			expect(good.status).toBe(201);
		});

		test.each([["bad key!"], ["k".repeat(129)], [""], ["a/b"]])("the malformed key %p is 400 and nothing is created", async badKey => {
			const res = await app.fetch(upload(minimal, "SOURCE", { "Idempotency-Key": badKey }));
			expect(res.status).toBe(400);
			expect(String(at(await res.json(), "error"))).toContain("Idempotency-Key");
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(0);
		});

		test("a duplicate that arrives while the first is still uploading is 409 and retriable once the first is done", async () => {
			const boundary = "slow-boundary";
			const encoder = new TextEncoder();
			let push: (text: string) => void = () => undefined;
			let finish: () => void = () => undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					push = text => controller.enqueue(encoder.encode(text));
					finish = () => controller.close();
				},
			});
			const slow = app.fetch(
				new Request(`${ORIGIN}/api/v1/threads`, {
					method: "POST",
					body,
					headers: { Authorization: `Bearer ${TOKEN}`, "content-type": `multipart/form-data; boundary=${boundary}`, ...key },
					duplex: "half",
				} as RequestInit),
			);
			push(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n${JSON.stringify(minimal)}\r\n`);
			push(`--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\nPART-ONE`);
			// The first request holds the key once the service started creating it; yield to the event loop until it does.
			for (let spins = 0; ; spins++) {
				const release = store.beginCreate(OWNER, "delegate:s1:0");
				if (release === null) break;
				release();
				if (spins === 1000) throw new Error("the first create never started");
				await new Promise<void>(resolve => setImmediate(resolve));
			}

			const duplicate = await app.fetch(upload(minimal, "SOURCE", key));
			expect(duplicate.status).toBe(409);
			expect(await duplicate.json()).toEqual({ error: "a request with this Idempotency-Key is still in progress" });

			push(`\r\n--${boundary}--\r\n`);
			finish();
			const first = await slow;
			expect(first.status).toBe(201);
			const retry = await app.fetch(upload(minimal, "SOURCE", key));
			expect(retry.status).toBe(200);
			expect(at(await retry.json(), "id")).toBe(at(await first.json(), "id"));
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(1);
		});
	});

	describe("scratch threads", () => {
		const scratch = { prompt: "write a plan", repo: { scratch: true } };

		/** Runs git in `cwd`; returns trimmed stdout. */
		function git(cwd: string, ...args: string[]): string {
			const run = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
			if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
			return run.stdout.toString().trim();
		}

		test("is created without a source: a full-history thread named scratch whose base is one empty commit", async () => {
			const res = await app.fetch(upload(scratch, null));
			expect(res.status).toBe(201);
			const body: unknown = await res.json();
			const id = String(at(body, "id"));
			expect(body).toMatchObject({ scratch: true, repo: { name: "scratch", remoteURL: "", baseRef: "", localBranch: "" } });

			const stored = store.getThread(id);
			expect(stored?.scratch).toBe(true);
			expect(stored?.repo.baseCommit).toBe("");
			expect(stored?.repo.remoteURL).toBe("");
			const handoff = stored?.repo.handoffCommit ?? "";
			expect(handoff).toMatch(/^[0-9a-f]{40}$/);

			// The stored source bundle is what the VM restores from: refs/omp-cloud/handoff is that one empty commit.
			const bundle = store.blobPath(id, "source.bundle");
			const work = await mkdtemp(join(tmpdir(), "omp-cloud-scratch-"));
			try {
				git(work, "init", "-q");
				git(work, "bundle", "verify", bundle);
				git(work, "fetch", "-q", bundle, "+refs/omp-cloud/handoff:refs/omp-cloud/handoff");
				expect(git(work, "rev-parse", "refs/omp-cloud/handoff")).toBe(handoff);
				expect(git(work, "rev-list", "--count", "refs/omp-cloud/handoff")).toBe("1");
				expect(git(work, "ls-tree", "-r", "refs/omp-cloud/handoff")).toBe("");
			} finally {
				await rm(work, { recursive: true, force: true });
			}
		});

		test("takes the name from repo.name, and the metadata like any thread", async () => {
			const res = await app.fetch(upload({ ...scratch, repo: { scratch: true, name: "notes" }, origin: "tool", ref: "plan" }, null));
			expect(await res.json()).toMatchObject({ scratch: true, repo: { name: "notes" }, origin: "tool", ref: "plan" });
		});

		test("is idempotent like any create", async () => {
			const headers = { "Idempotency-Key": "scratch-1" };
			const first: unknown = await (await app.fetch(upload(scratch, null, headers))).json();
			const second = await app.fetch(upload(scratch, null, headers));
			expect(second.status).toBe(200);
			expect(at(await second.json(), "id")).toBe(at(first, "id"));
		});

		test("a source part is refused and nothing is stored", async () => {
			const res = await app.fetch(upload(scratch, "SOURCE"));
			expect(res.status).toBe(400);
			expect(String(at(await res.json(), "error"))).toContain("source");
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(0);
			expect(await threadsOnDisk()).toEqual([]);
		});

		test.each([
			["remoteURL", { remoteURL: "https://example.com/r.git" }],
			["baseRef", { baseRef: "main" }],
			["baseCommit", { baseCommit: "b".repeat(40) }],
			["handoffCommit", { handoffCommit: HANDOFF }],
		])("repo.%s is refused: a scratch repo has no remote or history of its own", async (_field, extra) => {
			const res = await app.fetch(upload({ ...scratch, repo: { scratch: true, ...extra } }, null));
			expect(res.status).toBe(400);
			expect(store.listThreadsPage(OWNER, {}, 10, null).total).toBe(0);
		});

		test("repo.scratch must be a boolean", async () => {
			const res = await app.fetch(upload({ ...scratch, repo: { scratch: "yes" } }, null));
			expect(res.status).toBe(400);
			expect(String(at(await res.json(), "error"))).toContain("repo.scratch");
		});

		test("a non-scratch request still needs its handoff commit and its source", async () => {
			expect((await app.fetch(upload({ prompt: "x", repo: { name: "proj" } }))).status).toBe(400);
			expect((await app.fetch(upload(minimal, null))).status).toBe(400);
		});
	});
});
