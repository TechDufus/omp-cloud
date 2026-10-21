import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import type { NewThread, TurnResult } from "../store/types";
import { type App, createApp } from "./app";
import { OWNER, tokenSha256 } from "./auth";
import { InspectGate } from "./inspect-gate";

const TOKEN = "inspect-token";
const ORIGIN = "http://omp.test";
const ID = "aaaaaaaaaaaa";
const REMOTE = "https://example.test/r.git";
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
const GATEWAY = { providers: (): string[] => [], refresh: async (): Promise<void> => undefined };

let root: string;
let dir: string;
let settings: Settings;
let store: Store;
let git: GitService;
let app: App;

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...IDENTITY, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
	return out.trim();
}

/** What the fixture's owner machine and VM produced. */
interface Repos {
	c1: string;
	c2: string;
	h1: string;
	h2: string;
	/** Full-history bundle of c2 as `refs/omp-cloud/handoff`. */
	sourceBundle: string;
	/** The branch of turn 2 in full (every commit back to the root). */
	fullResult: string;
	/** The same without c1's history: what a delta thread stores. */
	thinResult: string;
	/** The owner's repository: `c1` is what its remote has. */
	source: string;
}

const UTF = "é".repeat(50);
const WIDE = ["é1", "é2", "é3"].join("\n");

/**
 * Two commits on the owner's side (c1 = the remote's, c2 = the handoff), then two VM turns: turn 1 modifies a file, adds
 * one, deletes one, renames one and changes a binary file; turn 2 adds a file and appends to a.txt.
 */
async function buildRepos(dir: string): Promise<Repos> {
	const source = join(dir, "source");
	const work = join(dir, "work");
	await mkdir(source);
	await run(source, "init", "-q", "-b", "main");
	await writeFile(join(source, "a.txt"), "one\n");
	await writeFile(join(source, "b.txt"), "b\n");
	await writeFile(join(source, "n.txt"), "name\nline2\nline3\nline4\nline5\n");
	await run(source, "add", "-A");
	await run(source, "commit", "-q", "-m", "c1");
	const c1 = await run(source, "rev-parse", "HEAD");
	await mkdir(join(source, "src", "deep"), { recursive: true });
	await writeFile(join(source, "src", "deep", "inner.txt"), "inner\n");
	await writeFile(join(source, "bin.dat"), Buffer.from([0, 1, 2, 255, 0]));
	await writeFile(join(source, "utf.txt"), `${UTF}\n`);
	await run(source, "add", "-A");
	await run(source, "commit", "-q", "-m", "c2");
	const c2 = await run(source, "rev-parse", "HEAD");
	await run(source, "update-ref", "refs/omp-cloud/handoff", c2);
	const sourceBundle = join(dir, "source.bundle");
	await run(source, "bundle", "create", "--quiet", sourceBundle, "refs/omp-cloud/handoff");

	await run(dir, "clone", "-q", source, work);
	const branch = `omp-cloud/${ID}`;
	await run(work, "checkout", "-q", "-b", branch, c2);
	await writeFile(join(work, "a.txt"), "one\nTURN1\n");
	await writeFile(join(work, "c.txt"), "c\n");
	await writeFile(join(work, "bin.dat"), Buffer.from([0, 9, 9, 0]));
	await run(work, "rm", "-q", "b.txt");
	await run(work, "mv", "n.txt", "renamed.txt");
	await run(work, "add", "-A");
	await run(work, "commit", "-q", "-m", "turn 1");
	const h1 = await run(work, "rev-parse", "HEAD");
	await writeFile(join(work, "a.txt"), "one\nTURN1\nTURN2\n");
	await writeFile(join(work, "wide.txt"), `${WIDE}\n`);
	await run(work, "add", "-A");
	await run(work, "commit", "-q", "-m", "turn 2");
	const h2 = await run(work, "rev-parse", "HEAD");
	const fullResult = join(dir, "result-full.bundle");
	const thinResult = join(dir, "result-thin.bundle");
	await run(work, "bundle", "create", "--quiet", fullResult, `refs/heads/${branch}`);
	await run(work, "bundle", "create", "--quiet", thinResult, `refs/heads/${branch}`, `^${c1}`);
	return { c1, c2, h1, h2, sourceBundle, fullResult, thinResult, source };
}

function outcome(head: string): TurnResult {
	return {
		outcome: "completed",
		error: "",
		reply: "done",
		usage: null,
		head,
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		pushed: false,
		pushError: "",
		pushRef: "",
	};
}

function newThread(repo: Partial<NewThread["repo"]>): NewThread {
	return {
		owner: OWNER,
		title: "t",
		prompt: "go",
		model: "",
		thinking: "",
		repo: { name: "repo", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "c".repeat(40), localBranch: "main", ...repo },
		paths: { home: "/home/me", workspace: "/home/me/repo" },
		author: { name: "Me", email: "me@example.com" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
	};
}

interface ThreadSetup {
	id?: string;
	/** Heads of turn 1 and turn 2 (turn 2 is omitted when absent). */
	heads: (string | null)[];
	/** `delta`: the base is `c1` in the remote's cache and the result bundle is thin. */
	delta?: boolean;
	source?: boolean;
	result?: "full" | "thin" | "garbage" | null;
}

let repos: Repos;

/** A thread whose turns recorded `setup.heads` (null: the turn ended without a head), with the stored blobs it asks for. */
async function seedThread(setup: ThreadSetup): Promise<string> {
	const id = setup.id ?? ID;
	const delta = setup.delta === true;
	store.createThread(
		id,
		newThread({ handoffCommit: repos.c2, ...(delta ? { remoteURL: REMOTE, baseRef: "main", baseCommit: repos.c1 } : {}) }),
	);
	const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(await Bun.file(path).arrayBuffer());
	if (setup.source !== false && !delta) await store.putBlob(id, "source.bundle", await bytes(repos.sourceBundle), 1 << 26);
	if (delta) {
		const cache = join(dir, "git", "cache", `${new Bun.CryptoHasher("sha256").update(git.normalize(REMOTE)).digest("hex")}.git`);
		await run(dir, "init", "-q", "--bare", cache);
		await run(cache, "fetch", "-q", "--no-tags", repos.sourceBundle, `+refs/omp-cloud/handoff:refs/omp-cloud/threads/${id}/handoff`);
	}
	const result = setup.result === undefined ? (delta ? "thin" : "full") : setup.result;
	if (result === "garbage") await store.putBlob(id, "result.bundle", new TextEncoder().encode("not a bundle"), 1 << 20);
	else if (result !== null) await store.putBlob(id, "result.bundle", await bytes(result === "thin" ? repos.thinResult : repos.fullResult), 1 << 26);
	for (const [index, head] of setup.heads.entries()) {
		if (index > 0) store.enqueueTurn(id, `turn ${index + 1}`, OWNER);
		store.startNextTurn(id);
		store.completeTurn(id, index + 1, outcome(head ?? ""));
	}
	return id;
}

function appWith(inspectGate?: InspectGate): App {
	return createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: { default: "fake/fake-model", direct: ["fake"], gateway: GATEWAY },
		ompVersion: "18.12.3",
		logins: new LoginManager({
			brokerUrl: "http://127.0.0.1:1",
			brokerTokenFile: "/nonexistent/auth-broker.token",
			flow: { has: () => false, run: () => Promise.reject(new Error("no provider")) },
		}),
		settings,
		git,
		inspectGate,
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-inspect-"));
	store = Store.open({ dataDir: dir });
	git = await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 30, pushTimeoutSeconds: 30 });
	settings = Settings.load(store);
	app = appWith();
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-cloud-inspect-repos-"));
	repos = await buildRepos(root);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

function get(path: string): Promise<Response> {
	return app.fetch(new Request(ORIGIN + path, { headers: { Authorization: `Bearer ${TOKEN}` } }));
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
	const body: unknown = await res.json();
	if (!isRecord(body)) throw new Error("expected an object");
	return body;
}

async function expectError(res: Response, status: number, message: string | RegExp): Promise<void> {
	expect(res.status).toBe(status);
	const body = await jsonOf(res);
	expect(Object.keys(body)).toEqual(["error"]);
	if (typeof message === "string") expect(body.error).toBe(message);
	else expect(String(body.error)).toMatch(message);
}

const base = (id = ID): string => `/api/v1/threads/${id}`;

interface StatFile {
	path: string;
	status: string;
	insertions: number;
	deletions: number;
}

function filesOf(body: Record<string, unknown>): Record<string, StatFile> {
	const files = body.files;
	if (!Array.isArray(files)) throw new Error("no files");
	const byPath: Record<string, StatFile> = {};
	for (const file of files) {
		if (!isRecord(file) || typeof file.path !== "string") throw new Error("bad file entry");
		byPath[file.path] = { path: file.path, status: String(file.status), insertions: Number(file.insertions), deletions: Number(file.deletions) };
	}
	return byPath;
}

describe("GET /threads/{id}/diff", () => {
	test("without turn it is the handoff commit to the newest recorded head: stat and text", async () => {
		await seedThread({ heads: [repos.h1, repos.h2] });

		const stat = await get(`${base()}/diff?stat=1`);
		expect(stat.status).toBe(200);
		const body = await jsonOf(stat);
		expect(body).toMatchObject({ base: repos.c2, head: repos.h2, insertions: 6, deletions: 1, truncated: false });
		expect(filesOf(body)).toEqual({
			"a.txt": { path: "a.txt", status: "M", insertions: 2, deletions: 0 },
			"b.txt": { path: "b.txt", status: "D", insertions: 0, deletions: 1 },
			"c.txt": { path: "c.txt", status: "A", insertions: 1, deletions: 0 },
			"renamed.txt": { path: "renamed.txt", status: "R", insertions: 0, deletions: 0 },
			"bin.dat": { path: "bin.dat", status: "M", insertions: 0, deletions: 0 },
			"wide.txt": { path: "wide.txt", status: "A", insertions: 3, deletions: 0 },
		});

		const text = await get(`${base()}/diff`);
		expect(text.status).toBe(200);
		expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(text.headers.get("x-omp-base")).toBe(repos.c2);
		expect(text.headers.get("x-omp-head")).toBe(repos.h2);
		expect(text.headers.get("x-omp-truncated")).toBeNull();
		const diff = await text.text();
		expect(diff).toContain("+++ b/c.txt");
		expect(diff).toContain("+TURN2");
		expect(diff).toContain("rename from n.txt");
		expect(diff).toContain("Binary files a/bin.dat and b/bin.dat differ");
	});

	test("with turn it is the previous recorded head (or the handoff commit) to that turn's head", async () => {
		await seedThread({ heads: [repos.h1, repos.h2] });

		const first = await get(`${base()}/diff?turn=1&stat=1`);
		const firstBody = await jsonOf(first);
		expect(firstBody).toMatchObject({ base: repos.c2, head: repos.h1 });
		expect(Object.keys(filesOf(firstBody)).sort()).toEqual(["a.txt", "b.txt", "bin.dat", "c.txt", "renamed.txt"]);

		const second = await get(`${base()}/diff?turn=2&stat=1`);
		const secondBody = await jsonOf(second);
		expect(secondBody).toMatchObject({ base: repos.h1, head: repos.h2, insertions: 4, deletions: 0 });
		expect(filesOf(secondBody)).toEqual({
			"a.txt": { path: "a.txt", status: "M", insertions: 1, deletions: 0 },
			"wide.txt": { path: "wide.txt", status: "A", insertions: 3, deletions: 0 },
		});
		const text = await get(`${base()}/diff?turn=2`);
		expect(text.headers.get("x-omp-base")).toBe(repos.h1);
		expect(text.headers.get("x-omp-head")).toBe(repos.h2);
	});

	test("a turn between two recorded heads skips the turns that recorded none", async () => {
		await seedThread({ heads: [repos.h1, null, repos.h2] });

		expect(await jsonOf(await get(`${base()}/diff?turn=3&stat=1`))).toMatchObject({ base: repos.h1, head: repos.h2 });
		await expectError(await get(`${base()}/diff?turn=2`), 404, "turn 2 recorded no head");
		await expectError(await get(`${base()}/diff?turn=9`), 404, "no turn 9");
		// The newest recorded head, not the newest turn, ends the whole-thread range.
		expect(await jsonOf(await get(`${base()}/diff?stat=1`))).toMatchObject({ base: repos.c2, head: repos.h2 });
	});

	test("path limits both the stat and the text to that path, and context sets the lines around a change", async () => {
		await seedThread({ heads: [repos.h2] });

		const one = await jsonOf(await get(`${base()}/diff?stat=1&path=a.txt`));
		expect(Object.keys(filesOf(one))).toEqual(["a.txt"]);
		expect(one).toMatchObject({ insertions: 2, deletions: 0 });
		const narrow = await (await get(`${base()}/diff?path=a.txt&context=0`)).text();
		const wide = await (await get(`${base()}/diff?path=a.txt&context=3`)).text();
		expect(narrow).not.toContain("c.txt");
		expect(narrow).not.toMatch(/^ one$/m);
		expect(wide).toMatch(/^ one$/m);
		// A path that matches nothing is an empty diff, not an error; a glob character is literal.
		expect(await (await get(`${base()}/diff?path=${encodeURIComponent("*.txt")}`)).text()).toBe("");
	});

	test("text is cut at maxBytes on a character boundary, and X-Omp-Truncated gives the full length in bytes", async () => {
		await seedThread({ heads: [repos.h2] });
		const full = new Uint8Array(await (await get(`${base()}/diff?path=wide.txt`)).arrayBuffer());
		// 0xC3 0xA9 is é: the first one starts the first added line.
		const start = full.findIndex((byte, i) => byte === 0xc3 && full[i + 1] === 0xa9);
		expect(start).toBeGreaterThan(40);

		const insideChar = await get(`${base()}/diff?path=wide.txt&maxBytes=${start + 1}`);
		expect(insideChar.headers.get("x-omp-truncated")).toBe(String(full.length));
		const dropped = new Uint8Array(await insideChar.arrayBuffer());
		expect(dropped.length).toBe(start);
		expect(new TextDecoder("utf-8", { fatal: true }).decode(dropped)).toBe(new TextDecoder().decode(full.subarray(0, start)));

		const afterChar = await get(`${base()}/diff?path=wide.txt&maxBytes=${start + 2}`);
		expect(afterChar.headers.get("x-omp-truncated")).toBe(String(full.length));
		expect(new Uint8Array(await afterChar.arrayBuffer()).length).toBe(start + 2);

		const ascii = await get(`${base()}/diff?path=wide.txt&maxBytes=10`);
		expect(await ascii.text()).toBe(new TextDecoder().decode(full.subarray(0, 10)));
		// Exactly the whole diff: not truncated.
		const exact = await get(`${base()}/diff?path=wide.txt&maxBytes=${full.length}`);
		expect(exact.headers.get("x-omp-truncated")).toBeNull();
		expect(new Uint8Array(await exact.arrayBuffer()).length).toBe(full.length);
	});

	test("bad parameters are 400 naming the parameter", async () => {
		await seedThread({ heads: [repos.h1] });
		for (const [query, message] of [
			["turn=0", "turn must be an integer from 1 to 9007199254740991"],
			["turn=x", "turn must be an integer from 1 to 9007199254740991"],
			["context=21", "context must be an integer from 0 to 20"],
			["context=-1", "context must be an integer from 0 to 20"],
			["maxBytes=0", "maxBytes must be an integer from 1 to 1048576"],
			["maxBytes=1048577", "maxBytes must be an integer from 1 to 1048576"],
			["stat=2", "stat must be 1 or 0"],
		] as const) {
			await expectError(await get(`${base()}/diff?${query}`), 400, message);
		}
	});

	test("paths that are absolute, climb out or go through .git are refused", async () => {
		await seedThread({ heads: [repos.h1] });
		for (const path of ["/etc/passwd", "../x", "a/../b", "a//b", ".git/config", "src/.GIT/x", "a/./b", "a\u0000b"]) {
			const res = await get(`${base()}/diff?path=${encodeURIComponent(path)}`);
			expect(res.status).toBe(400);
			expect(String((await jsonOf(res)).error)).toMatch(/^path must/);
		}
	});

	test("a thread with no recorded head is 404 no result yet, whatever the bundle", async () => {
		await seedThread({ heads: [null], result: null });
		await expectError(await get(`${base()}/diff`), 404, "no result yet");
		await expectError(await get(`${base()}/diff?stat=1`), 404, "no result yet");
		await expectError(await get(`${base()}/tree`), 404, "no result yet");
		await expectError(await get(`${base()}/files/a.txt`), 404, "no result yet");
	});

	test("a head the stored bundle does not hold is 404, a source bundle that is gone is 404, a corrupt result bundle is a 500", async () => {
		await seedThread({ heads: ["9".repeat(40)] });
		await expectError(await get(`${base()}/diff`), 404, new RegExp(`does not hold the head ${"9".repeat(40)}`));

		await seedThread({ id: "bbbbbbbbbbbb", heads: [repos.h1], source: false });
		await expectError(await get(`${base("bbbbbbbbbbbb")}/diff`), 404, "the thread's source bundle is not stored");

		await seedThread({ id: "cccccccccccc", heads: [repos.h1], result: "garbage" });
		const log = spyOn(console, "error").mockImplementation(() => {});
		await expectError(await get(`${base("cccccccccccc")}/diff`), 500, "internal error");
		expect(log).toHaveBeenCalled();
		log.mockRestore();
	});

	test("a delta thread reads its base from the git cache and its thin result bundle", async () => {
		await seedThread({ heads: [repos.h1, repos.h2], delta: true });

		const body = await jsonOf(await get(`${base()}/diff?stat=1`));
		expect(body).toMatchObject({ base: repos.c2, head: repos.h2, insertions: 6, deletions: 1 });
		expect(Object.keys(filesOf(body)).sort()).toEqual(["a.txt", "b.txt", "bin.dat", "c.txt", "renamed.txt", "wide.txt"]);
		// Requests on the same cache queue behind each other and all succeed.
		const answers = await Promise.all([get(`${base()}/diff?turn=1`), get(`${base()}/diff?turn=2`), get(`${base()}/tree?ref=base`)]);
		expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
	});

	test("a delta thread whose cache lost the handoff is 404", async () => {
		await seedThread({ heads: [repos.h1], delta: true });
		await rm(join(dir, "git", "cache"), { recursive: true, force: true });
		await expectError(await get(`${base()}/diff`), 404, "the git cache holds no handoff of this thread");
	});
});

describe("GET /threads/{id}/tree", () => {
	test("lists the head one level at a time, directories as dir with size 0", async () => {
		await seedThread({ heads: [repos.h2] });

		const res = await get(`${base()}/tree`);
		expect(res.status).toBe(200);
		const body = await jsonOf(res);
		expect(body).toMatchObject({ ref: "head", commit: repos.h2, path: "", truncated: false });
		expect(body.entries).toEqual([
			{ path: "a.txt", type: "file", size: 16 },
			{ path: "bin.dat", type: "file", size: 4 },
			{ path: "c.txt", type: "file", size: 2 },
			{ path: "renamed.txt", type: "file", size: 29 },
			{ path: "src", type: "dir", size: 0 },
			{ path: "utf.txt", type: "file", size: 101 },
			{ path: "wide.txt", type: "file", size: 12 },
		]);
	});

	test("path and recursive pick a directory and its whole subtree, repository-relative", async () => {
		await seedThread({ heads: [repos.h2] });

		const sub = await jsonOf(await get(`${base()}/tree?path=src`));
		expect(sub).toMatchObject({ path: "src", entries: [{ path: "src/deep", type: "dir", size: 0 }] });
		const all = await jsonOf(await get(`${base()}/tree?path=src/&recursive=1`));
		expect(all.entries).toEqual([
			{ path: "src/deep", type: "dir", size: 0 },
			{ path: "src/deep/inner.txt", type: "file", size: 6 },
		]);
		const everything = await jsonOf(await get(`${base()}/tree?recursive=1`));
		expect(Array.isArray(everything.entries) ? everything.entries.length : 0).toBe(9);
	});

	test("ref=base is the handoff commit, also before any turn recorded a head", async () => {
		await seedThread({ heads: [null], result: null });

		const body = await jsonOf(await get(`${base()}/tree?ref=base`));
		expect(body).toMatchObject({ ref: "base", commit: repos.c2 });
		const paths = (Array.isArray(body.entries) ? body.entries : []).map((e: unknown) => (isRecord(e) ? e.path : ""));
		expect(paths).toContain("b.txt");
		expect(paths).not.toContain("c.txt");
	});

	test("a file, a missing directory and bad parameters are refused", async () => {
		await seedThread({ heads: [repos.h2] });
		await expectError(await get(`${base()}/tree?path=a.txt`), 404, "no such directory");
		await expectError(await get(`${base()}/tree?path=nope`), 404, "no such directory");
		await expectError(await get(`${base()}/tree?ref=main`), 400, "ref must be head or base");
		await expectError(await get(`${base()}/tree?recursive=yes`), 400, "recursive must be 1 or 0");
		await expectError(await get(`${base()}/tree?path=${encodeURIComponent("../x")}`), 400, 'path must not contain empty, "." or ".." segments');
		await expectError(await get(`${base()}/tree?path=${encodeURIComponent(".git")}`), 400, "path must not go through .git");
		await expectError(await get(`${base()}/tree?path=${encodeURIComponent("/src")}`), 400, "path must be relative to the repository root");
	});

	test("a listing is cut at 5000 entries and says so", async () => {
		const wide = join(dir, "wide");
		await mkdir(wide);
		await run(wide, "init", "-q", "-b", "main");
		await mkdir(join(wide, "d"));
		await Promise.all(Array.from({ length: 5002 }, (_, i) => writeFile(join(wide, "d", `f${String(i).padStart(5, "0")}`), "x")));
		await run(wide, "add", "-A");
		await run(wide, "commit", "-q", "-m", "many");
		const head = await run(wide, "rev-parse", "HEAD");
		await run(wide, "update-ref", "refs/omp-cloud/handoff", head);
		const bundle = join(dir, "wide.bundle");
		await run(wide, "bundle", "create", "--quiet", bundle, "refs/omp-cloud/handoff");
		store.createThread(ID, newThread({ handoffCommit: head }));
		await store.putBlob(ID, "source.bundle", new Uint8Array(await Bun.file(bundle).arrayBuffer()), 1 << 26);

		const body = await jsonOf(await get(`${base()}/tree?ref=base&path=d`));
		expect(body.truncated).toBe(true);
		expect(Array.isArray(body.entries) ? body.entries.length : 0).toBe(5000);
		const recursive = await jsonOf(await get(`${base()}/tree?ref=base&recursive=1`));
		expect(recursive.truncated).toBe(true);
		expect(Array.isArray(recursive.entries) ? recursive.entries.length : 0).toBe(5000);
	});
});

describe("GET /threads/{id}/files/<path>", () => {
	test("pages a text file by byte offset and limit", async () => {
		await seedThread({ heads: [repos.h2] });

		const whole = await jsonOf(await get(`${base()}/files/a.txt`));
		expect(whole).toEqual({ path: "a.txt", ref: "head", commit: repos.h2, size: 16, binary: false, offset: 0, text: "one\nTURN1\nTURN2\n", next: null });

		const first = await jsonOf(await get(`${base()}/files/a.txt?limit=5`));
		expect(first).toMatchObject({ offset: 0, text: "one\nT", next: 5, size: 16 });
		let text = "";
		let offset: number | null = 0;
		let pages = 0;
		while (offset !== null) {
			const page = await jsonOf(await get(`${base()}/files/a.txt?limit=7&offset=${offset}`));
			text += String(page.text);
			offset = typeof page.next === "number" ? page.next : null;
			pages++;
		}
		expect(text).toBe("one\nTURN1\nTURN2\n");
		expect(pages).toBe(3);
		expect(await jsonOf(await get(`${base()}/files/a.txt?offset=16`))).toMatchObject({ text: "", next: null });
		expect(await jsonOf(await get(`${base()}/files/a.txt?offset=500`))).toMatchObject({ text: "", next: null, size: 16 });
	});

	test("a page never splits a UTF-8 character: it ends before it, and an offset inside one starts after it", async () => {
		await seedThread({ heads: [repos.h2] });

		let text = "";
		let offset: number | null = 0;
		while (offset !== null) {
			const page = await jsonOf(await get(`${base()}/files/utf.txt?limit=3&offset=${offset}`));
			expect(String(page.text)).not.toContain("\ufffd");
			text += String(page.text);
			offset = typeof page.next === "number" ? page.next : null;
		}
		expect(text).toBe(`${UTF}\n`);
		// Bytes 0-1 are the first é; offset 1 is inside it.
		expect(await jsonOf(await get(`${base()}/files/utf.txt?limit=4&offset=1`))).toMatchObject({ offset: 2, text: "éé", next: 6 });
		// A limit smaller than one character still makes progress.
		expect(await jsonOf(await get(`${base()}/files/utf.txt?limit=1`))).toMatchObject({ offset: 0, text: "é", next: 2 });
	});

	test("a binary file is binary true with no text and no next", async () => {
		await seedThread({ heads: [repos.h2] });
		expect(await jsonOf(await get(`${base()}/files/bin.dat`))).toEqual({
			path: "bin.dat",
			ref: "head",
			commit: repos.h2,
			size: 4,
			binary: true,
			offset: 0,
			text: "",
			next: null,
		});
		expect(await jsonOf(await get(`${base()}/files/bin.dat?ref=base`))).toMatchObject({ size: 5, binary: true, text: "" });
	});

	test("ref=base reads the handoff commit; nested paths work; a deleted file only exists at base", async () => {
		await seedThread({ heads: [repos.h2] });

		expect(await jsonOf(await get(`${base()}/files/src/deep/inner.txt`))).toMatchObject({ path: "src/deep/inner.txt", text: "inner\n" });
		expect(await jsonOf(await get(`${base()}/files/b.txt?ref=base`))).toMatchObject({ ref: "base", commit: repos.c2, text: "b\n" });
		await expectError(await get(`${base()}/files/b.txt`), 404, "no such file");
		await expectError(await get(`${base()}/files/nope.txt`), 404, "no such file");
		await expectError(await get(`${base()}/files/src`), 404, "no such file");
	});

	test("paths that climb out (also encoded), go through .git or are empty are 400; bad paging is 400", async () => {
		await seedThread({ heads: [repos.h2] });
		for (const path of ["..%2Fa.txt", "src%2F..%2Fa.txt", "%2e%2e%2Fx", ".git/config", "src/.git/x", "%2Fetc%2Fpasswd", "a%00b"]) {
			const res = await get(`${base()}/files/${path}`);
			expect(res.status).toBe(400);
			expect(String((await jsonOf(res)).error)).toMatch(/^path must/);
		}
		await expectError(await get(`${base()}/files/%E0%A4%A`), 400, "path is not valid percent-encoding");
		await expectError(await get(`${base()}/files`), 400, "path is required");
		await expectError(await get(`${base()}/files/a.txt?limit=0`), 400, "limit must be an integer from 1 to 1048576");
		await expectError(await get(`${base()}/files/a.txt?limit=1048577`), 400, "limit must be an integer from 1 to 1048576");
		await expectError(await get(`${base()}/files/a.txt?offset=-1`), 400, "offset must be an integer from 0 to 9007199254740991");
		await expectError(await get(`${base()}/files/a.txt?ref=x`), 400, "ref must be head or base");
	});

	test("another thread's id and an unknown one are 404, and a non-GET method is not a route", async () => {
		await seedThread({ heads: [repos.h2] });
		await expectError(await get(`${base("zzzzzzzzzzzz")}/diff`), 404, "not found");
		const post = await app.fetch(new Request(`${ORIGIN}${base()}/files/a.txt`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }));
		await expectError(post, 404, "not found");
	});
});

/** Waits for `condition`, yielding to the event loop (the request is on its way through real file reads). */
async function waitUntil(condition: () => boolean): Promise<void> {
	while (!condition()) await Bun.sleep(0);
}

describe("the limit on concurrent inspections", () => {
	/** Occupies the gate's only place until the returned function is called. */
	function occupy(gate: InspectGate): () => void {
		const { promise, resolve } = Promise.withResolvers<void>();
		void gate.run(new AbortController().signal, () => promise);
		return resolve;
	}

	test("a request that finds no place within the wait is 503 with Retry-After 5, and works once a place is free", async () => {
		await seedThread({ heads: [repos.h1] });
		const gate = new InspectGate(1, 1);
		app = appWith(gate);
		const free = occupy(gate);

		for (const suffix of ["/diff", "/tree", "/files/a.txt"]) {
			const busy = await get(`${base()}${suffix}`);
			expect(busy.status).toBe(503);
			expect(busy.headers.get("retry-after")).toBe("5");
			expect(await jsonOf(busy)).toEqual({ error: "inspection busy; retry shortly" });
		}
		// A request that fails validation or finds no result never needs a place.
		await expectError(await get(`${base()}/diff?turn=0`), 400, "turn must be an integer from 1 to 9007199254740991");
		await expectError(await get(`${base()}/diff?turn=7`), 404, "no turn 7");

		free();
		expect((await get(`${base()}/diff?stat=1`)).status).toBe(200);
	});

	test("requests share the places in arrival order: with 1 place and 2 in line, both are served", async () => {
		await seedThread({ heads: [repos.h1] });
		const gate = new InspectGate(1, 60_000);
		app = appWith(gate);
		const free = occupy(gate);

		const first = get(`${base()}/diff?stat=1`);
		const second = get(`${base()}/tree`);
		await waitUntil(() => gate.waiting === 2);
		free();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		expect(gate.waiting).toBe(0);
	});

	test("a client that disconnects while waiting leaves the queue and holds no place", async () => {
		await seedThread({ heads: [repos.h1] });
		const gate = new InspectGate(1, 60_000);
		app = appWith(gate);
		const free = occupy(gate);

		const gone = new AbortController();
		const abandoned = app.fetch(new Request(`${ORIGIN}${base()}/diff`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: gone.signal }));
		await waitUntil(() => gate.waiting === 1);
		gone.abort();
		await abandoned;
		expect(gate.waiting).toBe(0);

		free();
		expect((await get(`${base()}/diff?stat=1`)).status).toBe(200);
	});
});
