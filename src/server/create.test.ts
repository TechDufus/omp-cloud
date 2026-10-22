import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, type RepoRef, type ScratchSource } from "../git";
import { normalizeRemote, remoteHostOf } from "../git/remote";
import { Settings } from "../settings";
import { Store } from "../store";
import { createThreadFromUpload, createThreadIdempotent, type UploadOptions } from "./create";
import { ApiError } from "./errors";
import { MAX_CREATE_BODY_BYTES } from "./limits";

const OWNER = "owner";
const HANDOFF = "a".repeat(40);
const SCRATCH = "5".repeat(40);
const BASE = "b".repeat(40);
const URL_ = "http://127.0.0.1/api/v1/threads";

let dir: string;
let store: Store;
let settings: Settings;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	gateway.served = ["anthropic"];
	gateway.afterRefresh = ["anthropic"];
	gateway.refreshes = 0;
	git.prepared = [];
	git.forgotten = [];
	git.failure = null;
	git.scratchReleased = 0;
	git.scratchFailure = null;
	store = Store.open({ dataDir: dir });
	settings = Settings.load(store);
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

type Body = Record<string, unknown>;

/** A valid full-history request body. */
function full(over: Body = {}): Body {
	return { prompt: "fix the bug", repo: { name: "proj", handoffCommit: HANDOFF }, ...over };
}

/** A valid delta request body: the handoff equals the base unless `repo` says otherwise. */
function delta(repo: Body = {}, over: Body = {}): Body {
	return full({
		repo: {
			name: "proj",
			remoteURL: "https://git.example.com/a/b.git",
			baseRef: "main",
			baseCommit: BASE,
			handoffCommit: BASE,
			...repo,
		},
		...over,
	});
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A multipart/form-data POST built by FormData; each entry is `[name, content]` in order. */
function upload(entries: [string, string | Uint8Array][], headers: Record<string, string> = {}): Request {
	const form = new FormData();
	for (const [name, content] of entries) {
		if (typeof content === "string") form.append(name, content);
		else form.append(name, new Blob([content]), name);
	}
	return new Request(URL_, { method: "POST", body: form, headers });
}

/** A request part followed by `rest`. */
function withRequest(body: Body, rest: [string, string | Uint8Array][] = [], headers: Record<string, string> = {}): Request {
	return upload([["request", JSON.stringify(body)], ...rest], headers);
}

const BOUNDARY = "test-boundary";

/** A hand-built multipart body; `close: false` leaves out the closing delimiter. */
function rawUpload(parts: { name: string; body: string }[], close = true): Request {
	let text = "";
	for (const part of parts) {
		text += `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.body}\r\n`;
	}
	if (close) text += `--${BOUNDARY}--\r\n`;
	return new Request(URL_, {
		method: "POST",
		body: text,
		headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
	});
}

const HOST_VERSION = "18.12.3";

/** The gateway as the upload sees it: it serves `served`, and a refresh swaps in `afterRefresh`. */
const gateway = {
	served: ["anthropic"],
	afterRefresh: ["anthropic"],
	refreshes: 0,
	providers(): string[] {
		return this.served;
	},
	async refresh(): Promise<void> {
		this.refreshes++;
		this.served = this.afterRefresh;
	},
};

/** The service's git as create sees it: it holds a credential for `git.example.com`, and `failure` makes the next `prepare` throw. */
const git = {
	prepared: [] as { id: string; repo: RepoRef; source: string | null }[],
	forgotten: [] as string[],
	failure: null as Error | null,
	normalize: (url: string): string => normalizeRemote(url, ["git.example.com"]),
	canFetch(url: string): boolean {
		return remoteHostOf(this.normalize(url)) === "git.example.com";
	},
	async prepare(id: string, repo: RepoRef, source: string | null): Promise<void> {
		this.prepared.push({ id, repo, source });
		if (this.failure !== null) throw this.failure;
	},
	async forget(id: string): Promise<void> {
		this.forgotten.push(id);
	},
	scratchReleased: 0,
	scratchFailure: null as Error | null,
	/** The base of a scratch thread: a file holding "scratch bundle", at the commit `SCRATCH`. */
	async scratchSource(): Promise<ScratchSource> {
		if (this.scratchFailure !== null) throw this.scratchFailure;
		const path = join(dir, "scratch-base.bundle");
		await writeFile(path, "scratch bundle");
		return {
			path,
			commit: SCRATCH,
			release: async () => {
				this.scratchReleased++;
				await rm(path, { force: true });
			},
		};
	},
};
const MODELS = { default: "fake/fake-model", direct: ["fake", "exact"], gateway };

/** Test options: a data volume with plenty of room unless `over` says otherwise. */
function options(over: Partial<UploadOptions> = {}): UploadOptions {
	return { dataDir: dir, models: MODELS, ompVersion: HOST_VERSION, git, settings, freeBytes: async () => Number.MAX_SAFE_INTEGER, ...over };
}

async function readBlob(id: string, name: "source.bundle" | "session.tar" | "setup.tar.gz" | "secrets.json"): Promise<string | null> {
	const file = await store.blob(id, name);
	return file === null || !(await file.exists()) ? null : file.text();
}

/** The upload fails with this status, and nothing of it remains: no thread row, no blob directory. */
async function rejected(req: Request, status: number, over: Partial<UploadOptions> = {}): Promise<ApiError> {
	let error: unknown;
	try {
		await createThreadFromUpload(store, req, OWNER, options(over));
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).status).toBe(status);
	await expectNothingLeft();
	return error as ApiError;
}

async function expectNothingLeft(): Promise<void> {
	expect(store.listThreads(OWNER, 100)).toEqual([]);
	expect(await readdir(join(dir, "threads"))).toEqual([]);
}

describe("success", () => {
	test("a full-history upload stores every part and queues the first turn", async () => {
		const source = new Uint8Array([0, 1, 2, 255, 254, 13, 10, 13, 10]);
		const session = bytes("session");
		const setup = new Uint8Array([31, 139, 8, 0]);
		const req = withRequest(full({ model: "anthropic/claude-sonnet-5", thinking: "high" }), [
			["source", source],
			["conversation", session],
			["setup", setup],
		]);
		const thread = await createThreadFromUpload(store, req, OWNER, options());

		expect(thread.owner).toBe(OWNER);
		expect(thread.phase).toBe("starting");
		expect(thread.model).toBe("anthropic/claude-sonnet-5");
		expect(store.getThread(thread.id)).toEqual(thread);
		const turns = store.turns(thread.id);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ id: 1, state: "queued", text: "fix the bug", by: OWNER });
		expect(new Uint8Array(await (await store.blob(thread.id, "source.bundle"))!.arrayBuffer())).toEqual(source);
		expect(await readBlob(thread.id, "session.tar")).toBe("session");
		expect(new Uint8Array(await (await store.blob(thread.id, "setup.tar.gz"))!.arrayBuffer())).toEqual(setup);
		expect(await readBlob(thread.id, "secrets.json")).toBeNull();
	});

	test("a delta upload at the base commit needs no source", async () => {
		const thread = await createThreadFromUpload(store, withRequest(delta()), OWNER, options());
		expect(thread.phase).toBe("starting");
		expect(thread.repo.baseCommit).toBe(BASE);
		expect(await readBlob(thread.id, "source.bundle")).toBeNull();
	});

	test("a delta upload with commits beyond the base takes its source", async () => {
		const req = withRequest(delta({ handoffCommit: HANDOFF }), [["source", bytes("delta bundle")]]);
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		expect(await readBlob(thread.id, "source.bundle")).toBe("delta bundle");
	});

	test("a delta upload is prepared with its source path, and the thread keeps the normalized https remote", async () => {
		const req = withRequest(delta({ handoffCommit: HANDOFF, remoteURL: "git@git.example.com:a/b.git" }), [["source", bytes("delta bundle")]]);
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		expect(thread.repo.remoteURL).toBe("https://git.example.com/a/b.git");
		expect(git.prepared).toHaveLength(1);
		expect(git.prepared[0]).toMatchObject({
			id: thread.id,
			repo: { remoteURL: "git.example.com:a/b.git", baseRef: "main", baseCommit: BASE, handoffCommit: HANDOFF },
			source: store.blobPath(thread.id, "source.bundle"),
		});
		expect(git.forgotten).toEqual([]);
	});

	test("a delta upload at the base commit is prepared without a source", async () => {
		const thread = await createThreadFromUpload(store, withRequest(delta()), OWNER, options());
		expect(git.prepared.map(p => p.source)).toEqual([null]);
		expect(thread.repo.remoteURL).toBe("https://git.example.com/a/b.git");
	});

	test("a full-history upload never touches the git cache and keeps its remote as sent", async () => {
		const req = withRequest(full({ repo: { name: "proj", handoffCommit: HANDOFF, remoteURL: "git@github.com:a/b.git" } }), [["source", bytes("src")]]);
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		expect(thread.repo.remoteURL).toBe("github.com:a/b.git");
		expect(git.prepared).toEqual([]);
	});

	test("a delta remote of a host the service holds no credential for is 400, before anything is stored", async () => {
		const error = await rejected(withRequest(delta({ remoteURL: "https://gitlab.example/a/b.git" })), 400);
		expect(error.message).toBe("the service has no git credentials for gitlab.example; hand off the whole repository instead");
		expect(git.prepared).toEqual([]);
	});

	test.each([
		["an ssh remote", "git@gitlab.example:a/b.git", "gitlab.example"],
		["a local path", "/srv/git/a.git", "/srv/git/a.git"],
		["a file: URL", "file:///srv/git/a.git", "file:///srv/git/a.git"],
	])("a delta %s the service cannot fetch is 400 naming what it saw", async (_label, remoteURL, named) => {
		const error = await rejected(withRequest(delta({ remoteURL })), 400);
		expect(error.message).toBe(`the service has no git credentials for ${named}; hand off the whole repository instead`);
	});

	test("a base the remote does not have is 409, nothing is stored and the thread's git refs are dropped", async () => {
		git.failure = new GitError("base", `the base commit ${BASE} is not on https://git.example.com/a/b.git`);
		const error = await rejected(withRequest(delta({ handoffCommit: HANDOFF }), [["source", bytes("delta bundle")]]), 409);
		expect(error.message).toBe(`the base commit ${BASE} is not on https://git.example.com/a/b.git`);
		expect(git.forgotten).toEqual([git.prepared[0]?.id ?? "missing"]);
	});

	test("a source bundle that does not match is 400 and nothing is stored", async () => {
		git.failure = new GitError("source", "the handoff commit does not descend from the base commit");
		const error = await rejected(withRequest(delta({ handoffCommit: HANDOFF }), [["source", bytes("delta bundle")]]), 400);
		expect(error.message).toBe("the handoff commit does not descend from the base commit");
		expect(git.forgotten).toHaveLength(1);
	});

	test("a git failure that is not a refusal is not turned into a 4xx", async () => {
		git.failure = new Error("git cache is on fire");
		await expect(createThreadFromUpload(store, withRequest(delta()), OWNER, options())).rejects.toThrow("git cache is on fire");
		await expectNothingLeft();
		expect(git.forgotten).toHaveLength(1);
	});

	test("secrets.json holds the shipped files and variables, only when there are some", async () => {
		const req = withRequest(
			full({ secretFiles: [{ path: ".env", content: Buffer.from("TOKEN=1").toString("base64") }], secretEnv: { API_KEY: "k" } }),
			[["source", bytes("src")]],
		);
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		const secrets: unknown = JSON.parse((await readBlob(thread.id, "secrets.json"))!);
		expect(secrets).toEqual({
			files: [{ path: ".env", content: Buffer.from("TOKEN=1").toString("base64") }],
			env: { API_KEY: "k" },
		});
	});

	test("MCP servers are stored in secrets.json (never served) with their names on the thread; one at the service host refuses the upload", async () => {
		const servers = [
			{ name: "docs", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer upstream" } },
			{ name: "local", type: "stdio", command: "npx", args: [], env: { KEY: "${KEY}" } },
		];
		const thread = await createThreadFromUpload(store, withRequest(full({ mcp: servers }), [["source", bytes("src")]]), OWNER, options());
		expect(thread.mcpServers).toEqual(["docs", "local"]);
		expect(JSON.parse((await readBlob(thread.id, "secrets.json"))!)).toEqual({ files: [], env: {}, mcp: servers });
		expect(JSON.stringify(thread)).not.toContain("Bearer upstream");

		const own = { name: "self", type: "http", url: "http://10.254.254.1:4000/mcp", headers: {} };
		const error = await createThreadFromUpload(store, withRequest(full({ mcp: [own] }), [["source", bytes("src")]]), OWNER, options({ mcpSelfHosts: ["10.254.254.1"] })).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
		expect((error as ApiError).message).toBe("mcp server self may not point at the service host");
	});

	test("the memory bank is stored on the thread, and an invalid one refuses the upload", async () => {
		const thread = await createThreadFromUpload(store, withRequest(full({ memory: { bank: "proj-ab12" } }), [["source", bytes("src")]]), OWNER, options());
		expect(thread.memoryBank).toBe("proj-ab12");
		expect(store.getThread(thread.id)?.memoryBank).toBe("proj-ab12");
		const error = await createThreadFromUpload(store, withRequest(full({ memory: { bank: "../x" } }), [["source", bytes("src")]]), OWNER, options()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
	});

	test("paths are stored as given", async () => {
		const req = withRequest(full({ paths: { home: "/home/ada", workspace: "/usr/src" } }), [["source", bytes("src")]]);
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		expect(thread.paths).toEqual({ home: "/home/ada", workspace: "/usr/src" });
	});

	test("an empty or absent model stays empty: the VM runs the default", async () => {
		for (const over of [{}, { model: "" }]) {
			const thread = await createThreadFromUpload(store, withRequest(full(over), [["source", bytes("src")]]), OWNER, options());
			expect(thread.model).toBe("");
		}
	});

	test("the owner's environment is stored: the overlays in order and the omp version asked for", async () => {
		const req = withRequest(full({ configOverlays: ["overlays/claude.yml", "b.yml"], ompVersion: "18.1.0" }), [["source", bytes("src")]]);
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		expect(thread.configOverlays).toEqual(["overlays/claude.yml", "b.yml"]);
		expect(thread.ompVersion).toBe("18.1.0");
		expect(store.getThread(thread.id)).toMatchObject({ configOverlays: ["overlays/claude.yml", "b.yml"], ompVersion: "18.1.0" });
	});

	test("without overlays and ompVersion the thread runs the host's omp version with no overlays", async () => {
		const thread = await createThreadFromUpload(store, withRequest(full(), [["source", bytes("src")]]), OWNER, options());
		expect(thread.configOverlays).toEqual([]);
		expect(thread.ompVersion).toBe(HOST_VERSION);
	});

	test("the owner passed in owns the thread, whatever the request says", async () => {
		const req = withRequest(full({ owner: "mallory" }), [["source", bytes("src")]]);
		const thread = await createThreadFromUpload(store, req, "ada", options());
		expect(thread.owner).toBe("ada");
		expect(store.listThreads("ada", 10)).toHaveLength(1);
	});

	test("the real data volume has room for a small upload", async () => {
		const req = withRequest(full(), [["source", bytes("src")]], { "content-length": "1024" });
		const thread = await createThreadFromUpload(store, req, OWNER, { dataDir: dir, models: MODELS, ompVersion: HOST_VERSION, git, settings });
		expect(store.getThread(thread.id)).not.toBeNull();
	});
});

describe("the model", () => {
	test.each(["anthropic/claude-sonnet-5", "anthropic/claude-opus-5-5:high", "fake/fake-model", "fake/a/b", "exact/only:xhigh"])(
		"%p is kept when its provider is served or direct",
		async model => {
			const thread = await createThreadFromUpload(store, withRequest(full({ model }), [["source", bytes("src")]]), OWNER, options());
			expect(thread.model).toBe(model);
			expect(gateway.refreshes).toBe(0);
		},
	);

	test.each(["openai-codex/gpt-6", "openai-codex/gpt-6:low", "nope/m"])(
		"%p is refused with 409 and the login hint, after one refresh, when its provider is neither served nor direct",
		async model => {
			const error = await rejected(withRequest(full({ model }), [["source", bytes("src")]]), 409);
			const provider = model.slice(0, model.indexOf("/"));
			expect(error.message).toBe(`the cloud cannot run ${provider} models; log the cloud broker in with /cloud login ${provider}`);
			expect(gateway.refreshes).toBe(1);
		},
	);

	test("a provider that logged in since the last read is served after the refresh on a miss", async () => {
		gateway.afterRefresh = ["anthropic", "openai-codex"];
		const req = withRequest(full({ model: "openai-codex/gpt-6" }), [["source", bytes("src")]]);
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		expect(thread.model).toBe("openai-codex/gpt-6");
		expect(gateway.refreshes).toBe(1);
	});

	test.each(["noslash", "/id", "provider/", "UPPER/m", "a b/m", "fake/a b", "fake/:high", "bad!/m"])("%p is 400, not 409", async model => {
		await rejected(withRequest(full({ model }), [["source", bytes("src")]]), 400);
		expect(gateway.refreshes).toBe(0);
	});

	describe("the cloud policy", () => {
		test("an empty list allows every model", async () => {
			expect(settings.get("policy.models.allowed")).toEqual([]);
			const thread = await createThreadFromUpload(store, withRequest(full({ model: "fake/fake-model" }), [["source", bytes("src")]]), OWNER, options());
			expect(thread.model).toBe("fake/fake-model");
		});

		test("a model outside policy.models.allowed is 409 and stores nothing", async () => {
			settings.apply({ "policy.models.allowed": ["anthropic/*"] }, OWNER);
			const error = await rejected(withRequest(full({ model: "fake/fake-model" }), [["source", bytes("src")]]), 409);
			expect(error.message).toBe("the cloud policy does not allow fake/fake-model");
		});

		test("an empty model is judged as the default model", async () => {
			settings.apply({ "policy.models.allowed": ["anthropic/*"] }, OWNER);
			const error = await rejected(withRequest(full(), [["source", bytes("src")]]), 409);
			expect(error.message).toBe("the cloud policy does not allow fake/fake-model");
			settings.apply({ "policy.models.allowed": ["fake/fake-model"] }, OWNER);
			const thread = await createThreadFromUpload(store, withRequest(full(), [["source", bytes("src")]]), OWNER, options());
			expect(thread.model).toBe("");
		});

		test("provider/* and provider/id patterns allow their models, with or without a thinking suffix", async () => {
			settings.apply({ "policy.models.allowed": ["anthropic/*", "fake/fake-model"] }, OWNER);
			// Refused first: `rejected` also checks that no thread exists yet.
			await rejected(withRequest(full({ model: "exact/only:xhigh" }), [["source", bytes("src")]]), 409);
			for (const model of ["anthropic/claude-opus-5-5:high", "fake/fake-model", "fake/fake-model:low"]) {
				const thread = await createThreadFromUpload(store, withRequest(full({ model }), [["source", bytes("src")]]), OWNER, options());
				expect(thread.model).toBe(model);
			}
		});

		test("the policy is judged before the cloud can run the provider: no gateway refresh", async () => {
			settings.apply({ "policy.models.allowed": ["anthropic/*"] }, OWNER);
			await rejected(withRequest(full({ model: "nope/m" }), [["source", bytes("src")]]), 409);
			expect(gateway.refreshes).toBe(0);
		});

		test("a reset policy allows every model again", async () => {
			settings.apply({ "policy.models.allowed": ["anthropic/*"] }, OWNER);
			settings.apply({ "policy.models.allowed": null }, OWNER);
			const thread = await createThreadFromUpload(store, withRequest(full({ model: "fake/fake-model" }), [["source", bytes("src")]]), OWNER, options());
			expect(thread.model).toBe("fake/fake-model");
		});
	});

	describe("a thread's own policy", () => {
		test("the thread policy is stored on the thread", async () => {
			const req = withRequest(full({ policy: { fetch: false, egress: ["Example.com"] } }), [["source", bytes("src")]]);
			const thread = await createThreadFromUpload(store, req, OWNER, options());
			expect(thread.policy).toEqual({ fetch: false, egress: ["example.com"] });
			expect(store.getThread(thread.id)?.policy).toEqual({ fetch: false, egress: ["example.com"] });
		});

		test("a thread's models.allowed narrows an empty service list", async () => {
			const policy = { "models.allowed": ["anthropic/*"] };
			expect((await rejected(withRequest(full({ model: "fake/fake-model", policy }), [["source", bytes("src")]]), 409)).message).toBe(
				"the cloud policy does not allow fake/fake-model",
			);
			const thread = await createThreadFromUpload(store, withRequest(full({ model: "anthropic/claude-opus-5-5", policy }), [["source", bytes("src")]]), OWNER, options());
			expect(thread.model).toBe("anthropic/claude-opus-5-5");
		});

		test("a model must match the service's list and the thread's", async () => {
			settings.apply({ "policy.models.allowed": ["anthropic/*", "fake/*"] }, OWNER);
			const policy = { "models.allowed": ["fake/*"] };
			await rejected(withRequest(full({ model: "anthropic/claude-opus-5-5", policy }), [["source", bytes("src")]]), 409);
			await rejected(withRequest(full({ model: "other/m", policy: { "models.allowed": ["other/*"] } }), [["source", bytes("src")]]), 409);
			const thread = await createThreadFromUpload(store, withRequest(full({ model: "fake/fake-model", policy }), [["source", bytes("src")]]), OWNER, options());
			expect(thread.model).toBe("fake/fake-model");
		});

		test("an empty model is judged as the default model against the thread's list too", async () => {
			await rejected(withRequest(full({ policy: { "models.allowed": ["anthropic/*"] } }), [["source", bytes("src")]]), 409);
			const thread = await createThreadFromUpload(store, withRequest(full({ policy: { "models.allowed": ["fake/*"] } }), [["source", bytes("src")]]), OWNER, options());
			expect(thread.model).toBe("");
		});

		test("a thread egress list that widens a non-empty service list is 400", async () => {
			settings.apply({ "policy.egress": ["example.com", "*.github.com"] }, OWNER);
			for (const widening of [["evil.test"], ["example.com", "evil.test"], ["api.github.com"]]) {
				const error = await rejected(withRequest(full({ policy: { egress: widening } }), [["source", bytes("src")]]), 400);
				expect(error.message).toBe("policy.egress of a thread may only narrow the service's list");
			}
		});

		test("a thread egress list is any list under an empty service list, and a narrowing one under a non-empty one", async () => {
			const created = (egress: string[]) => createThreadFromUpload(store, withRequest(full({ policy: { egress } }), [["source", bytes("src")]]), OWNER, options());
			expect((await created(["evil.test"])).policy).toEqual({ egress: ["evil.test"] });
			settings.apply({ "policy.egress": ["example.com", "*.github.com"] }, OWNER);
			expect((await created(["*.github.com"])).policy).toEqual({ egress: ["*.github.com"] });
			expect((await created(["example.com", "*.github.com"])).policy).toEqual({ egress: ["example.com", "*.github.com"] });
			expect((await created([])).policy).toEqual({ egress: [] });
		});

		test("an invalid or unknown policy is 400 and stores nothing", async () => {
			expect((await rejected(withRequest(full({ policy: { nope: true } }), [["source", bytes("src")]]), 400)).message).toBe("unknown policy key nope");
			expect((await rejected(withRequest(full({ policy: { "spend.dayUSD": -1 } }), [["source", bytes("src")]]), 400)).message).toContain("policy.spend.dayUSD");
			expect(store.listThreads(OWNER, 100)).toEqual([]);
		});
	});
});

describe("before reading the body", () => {
	test("a Content-Length over the maximum is 413", async () => {
		const req = withRequest(full(), [["source", bytes("src")]], { "content-length": String(MAX_CREATE_BODY_BYTES + 1) });
		expect((await rejected(req, 413)).message).toBe("upload is too large");
	});

	test("a Content-Length at the maximum is accepted", async () => {
		const req = withRequest(full(), [["source", bytes("src")]], { "content-length": String(MAX_CREATE_BODY_BYTES) });
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		expect(store.getThread(thread.id)).not.toBeNull();
	});

	test("free space below twice the Content-Length is 507", async () => {
		const req = withRequest(full(), [["source", bytes("src")]], { "content-length": "100" });
		await rejected(req, 507, { freeBytes: async () => 199 });
	});

	test("free space of exactly twice the Content-Length is enough", async () => {
		const req = withRequest(full(), [["source", bytes("src")]], { "content-length": "100" });
		const thread = await createThreadFromUpload(store, req, OWNER, options({ freeBytes: async () => 200 }));
		expect(store.getThread(thread.id)).not.toBeNull();
	});

	test("without a Content-Length the maximum body counts", async () => {
		const req = withRequest(full(), [["source", bytes("src")]]);
		expect(req.headers.get("content-length")).toBeNull();
		await rejected(req, 507, { limits: { body: 1000 }, freeBytes: async () => 1999 });
	});

	test("the free-space check asks about the data directory", async () => {
		const asked: string[] = [];
		const req = withRequest(full(), [["source", bytes("src")]]);
		await createThreadFromUpload(store, req, OWNER, options({ freeBytes: async d => (asked.push(d), Number.MAX_SAFE_INTEGER) }));
		expect(asked).toEqual([dir]);
	});

	test.each([
		["not multipart", "application/json"],
		["no boundary", "multipart/form-data"],
	])("a body that is %s is 400", async (_label, contentType) => {
		const req = new Request(URL_, { method: "POST", body: "{}", headers: { "content-type": contentType } });
		await rejected(req, 400);
	});

	test("a request without a body is 400", async () => {
		await rejected(new Request(URL_, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` } }), 400);
	});
});

describe("the request part", () => {
	test("an empty multipart body is 400", async () => {
		await rejected(rawUpload([]), 400);
	});

	test("the first part must be named request", async () => {
		await rejected(upload([["source", "x"], ["request", JSON.stringify(full())]]), 400);
	});

	test("a request part over its limit is 413", async () => {
		await rejected(withRequest(full()), 413, { limits: { request: 10 } });
	});

	test("a request part exactly at its limit is read", async () => {
		const text = JSON.stringify(full());
		const req = upload([["request", text], ["source", bytes("src")]]);
		const thread = await createThreadFromUpload(
			store,
			req,
			OWNER,
			options({ limits: { request: Buffer.byteLength(text) } }),
		);
		expect(store.getThread(thread.id)).not.toBeNull();
	});

	test("a request part that is not JSON is 400", async () => {
		await rejected(rawUpload([{ name: "request", body: "{nope" }]), 400);
	});

	test("a request part that is not UTF-8 is 400", async () => {
		await rejected(upload([["request", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])]]), 400);
	});

	test("an invalid create request is rejected with the validator's 400", async () => {
		const error = await rejected(withRequest({ prompt: "", repo: { name: "p", handoffCommit: HANDOFF } }, [["source", bytes("x")]]), 400);
		expect(error.message).toContain("prompt");
	});
});

describe("the other parts", () => {
	test("an unknown part is 400, and the parts stored before it are removed", async () => {
		await rejected(withRequest(full(), [["source", bytes("src")], ["extra", "x"]]), 400);
	});

	test.each(["source", "conversation", "setup"])("a repeated %s part is 400", async name => {
		await rejected(withRequest(full(), [["source", bytes("src")], [name, bytes("a")], [name, bytes("b")]]), 400);
	});

	test("a second request part is a repeat", async () => {
		await rejected(withRequest(full(), [["request", JSON.stringify(full())], ["source", bytes("src")]]), 400);
	});

	test("an empty conversation part is 400", async () => {
		await rejected(withRequest(full(), [["source", bytes("src")], ["conversation", bytes("")]]), 400);
	});

	test.each(["source", "conversation", "setup"] as const)("a %s part over its limit is 413", async name => {
		const rest: [string, Uint8Array][] = name === "source" ? [] : [["source", bytes("src")]];
		rest.push([name, bytes("12345")]);
		await rejected(withRequest(full(), rest), 413, { limits: { [name]: 4 } });
	});

	test("a part exactly at its limit is stored", async () => {
		const thread = await createThreadFromUpload(
			store,
			withRequest(full(), [["source", bytes("1234")]]),
			OWNER,
			options({ limits: { source: 4 } }),
		);
		expect(await readBlob(thread.id, "source.bundle")).toBe("1234");
	});

	test("a body cut off inside a part is 400", async () => {
		await rejected(rawUpload([{ name: "request", body: JSON.stringify(full()) }, { name: "source", body: "abc" }], false), 400);
	});

	test("a body cut off right after the request part is 400", async () => {
		await rejected(rawUpload([{ name: "request", body: JSON.stringify(full()) }], false), 400);
	});

	test("a body cut off inside the request part is 400", async () => {
		const text = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="request"\r\n\r\n{"prompt"`;
		const req = new Request(URL_, {
			method: "POST",
			body: text,
			headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
		});
		await rejected(req, 400);
	});
});

describe("the source requirement", () => {
	test("a full-history handoff without source is 400, though other parts were stored", async () => {
		await rejected(withRequest(full(), [["conversation", bytes("conv")], ["setup", bytes("setup")]]), 400);
	});

	test("a delta handoff beyond the base without source is 400", async () => {
		await rejected(withRequest(delta({ handoffCommit: HANDOFF }), [["setup", bytes("setup")]]), 400);
	});
});

describe("a client that goes away", () => {
	test("the original error is rethrown and nothing is left behind", async () => {
		const abort = new AbortController();
		const encoder = new TextEncoder();
		const head =
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="request"\r\n\r\n${JSON.stringify(full())}\r\n` +
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="source"\r\n\r\npartial bundle`;
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulls++ === 0) {
					controller.enqueue(encoder.encode(head));
					return;
				}
				abort.abort();
				controller.error(new Error("client went away"));
			},
		});
		const req = new Request(URL_, {
			method: "POST",
			body,
			duplex: "half",
			signal: abort.signal,
			headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
		} as RequestInit);

		let error: unknown;
		try {
			await createThreadFromUpload(store, req, OWNER, options());
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ApiError);
		expect((error as Error).message).toBe("client went away");
		await expectNothingLeft();
	});
});

describe("an Idempotency-Key", () => {
	const KEY = "delegate:s1:0";
	const key = { "idempotency-key": KEY };

	test("is stored on the thread with the fingerprint of its prompt; a repeat of the same prompt answers that thread", async () => {
		const first = await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), OWNER, options());
		expect(first.replayed).toBe(false);
		expect(store.threadByIdempotencyKey(OWNER, KEY)?.thread.id).toBe(first.thread.id);

		// Only the request part is read: the other parts of a retry (a fresh snapshot) may differ or be absent.
		const second = await createThreadIdempotent(store, withRequest(full(), [], key), OWNER, options());
		expect(second).toEqual({ thread: first.thread, replayed: true });
		expect(store.listThreads(OWNER, 10)).toHaveLength(1);
	});

	test("a repeat with a different prompt is 409 naming the key and the thread, and creates nothing", async () => {
		const first = await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), OWNER, options());
		const error = await createThreadIdempotent(store, withRequest(full({ prompt: "fix another bug" }), [["source", bytes("src")]], key), OWNER, options()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(409);
		expect((error as ApiError).message).toBe(`Idempotency-Key ${KEY} was used for a different request (thread ${first.thread.id})`);
		expect(store.listThreads(OWNER, 10)).toHaveLength(1);
		expect(await readdir(join(dir, "threads"))).toEqual([first.thread.id]);
	});

	test("the prompt is compared exactly as received: whitespace and case differ", async () => {
		await createThreadIdempotent(store, withRequest(full({ prompt: "fix the bug" }), [["source", bytes("src")]], key), OWNER, options());
		for (const prompt of ["fix the bug ", "Fix the bug", "fix the bug\n"]) {
			const error = await createThreadIdempotent(store, withRequest(full({ prompt }), [], key), OWNER, options()).catch((caught: unknown) => caught);
			expect((error as ApiError).status).toBe(409);
		}
	});

	test("only the prompt counts: model, repo and parts of a retry may differ", async () => {
		const first = await createThreadIdempotent(store, withRequest(full({ model: "fake/fake-model" }), [["source", bytes("src")]], key), OWNER, options());
		const retry = await createThreadIdempotent(store, withRequest(full({ model: "", repo: { name: "other", handoffCommit: BASE } }), [["source", bytes("newer")]], key), OWNER, options());
		expect(retry).toEqual({ thread: first.thread, replayed: true });
	});

	test("a replay without a usable request part is 400", async () => {
		await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), OWNER, options());
		for (const req of [
			new Request(URL_, { method: "POST", body: "not multipart", headers: key }),
			withRequest({ repo: { name: "p" } }, [], key),
			withRequest({ prompt: 5 }, [], key),
		]) {
			const error = await createThreadIdempotent(store, req, OWNER, options()).catch((caught: unknown) => caught);
			expect((error as ApiError).status).toBe(400);
		}
		expect(store.listThreads(OWNER, 10)).toHaveLength(1);
	});

	test("deleting the thread frees the key for any prompt", async () => {
		const first = await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), OWNER, options());
		await store.deleteThread(first.thread.id);
		const second = await createThreadIdempotent(store, withRequest(full({ prompt: "a different task" }), [["source", bytes("src")]], key), OWNER, options());
		expect(second.replayed).toBe(false);
		expect(second.thread.id).not.toBe(first.thread.id);
		// The key is now bound to the new prompt.
		const mismatch = await createThreadIdempotent(store, withRequest(full(), [], key), OWNER, options()).catch((caught: unknown) => caught);
		expect((mismatch as ApiError).status).toBe(409);
	});

	test("a key is per owner", async () => {
		const mine = await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), OWNER, options());
		const theirs = await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), "ada", options());
		expect(theirs.replayed).toBe(false);
		expect(theirs.thread.id).not.toBe(mine.thread.id);
	});

	test("a create that fails frees the key, and a repeat creates", async () => {
		git.failure = new Error("git cache is on fire");
		await expect(createThreadIdempotent(store, withRequest(delta(), [], key), OWNER, options())).rejects.toThrow("git cache is on fire");
		git.failure = null;
		const retry = await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), OWNER, options());
		expect(retry.replayed).toBe(false);
	});

	test("a repeat while the first is still being created is 409", async () => {
		const release = store.beginCreate(OWNER, KEY);
		expect(release).not.toBeNull();
		const error = await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), OWNER, options()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(409);
		expect((error as ApiError).message).toBe("a request with this Idempotency-Key is still in progress");
		release?.();
		expect((await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], key), OWNER, options())).replayed).toBe(false);
	});

	test.each([["bad key!"], ["k".repeat(129)], [""], ["a b"]])("the malformed key %p is 400 before anything is read", async badKey => {
		const error = await createThreadIdempotent(store, withRequest(full(), [["source", bytes("src")]], { "idempotency-key": badKey }), OWNER, options()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
		await expectNothingLeft();
	});
});

describe("a scratch thread", () => {
	const scratch = (over: Body = {}): Body => ({ prompt: "write a plan", repo: { scratch: true }, ...over });

	test("stores the synthesized base as its full-history source and the empty commit as its handoff", async () => {
		const thread = await createThreadFromUpload(store, withRequest(scratch()), OWNER, options());
		expect(thread.scratch).toBe(true);
		expect(thread.repo).toEqual({ name: "scratch", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: SCRATCH, localBranch: "" });
		expect(await readBlob(thread.id, "source.bundle")).toBe("scratch bundle");
		expect(git.prepared).toEqual([]);
		expect(git.scratchReleased).toBe(1);
	});

	test("keeps the metadata and the conversation it ships like any thread", async () => {
		const req = withRequest(scratch({ origin: "tool", ref: "plan", session: "s-1", repo: { scratch: true, name: "notes" } }), [["conversation", bytes("session")]]);
		const thread = await createThreadFromUpload(store, req, OWNER, options());
		expect(thread).toMatchObject({ scratch: true, origin: "tool", ref: "plan", session: "s-1", repo: { name: "notes" } });
		expect(await readBlob(thread.id, "session.tar")).toBe("session");
	});

	test("a source part is refused", async () => {
		const error = await rejected(withRequest(scratch(), [["source", bytes("src")]]), 400);
		expect(error.message).toBe("a scratch thread takes no source part");
	});

	test("a base that cannot be synthesized fails the create and leaves nothing", async () => {
		git.scratchFailure = new Error("git is missing");
		await expect(createThreadFromUpload(store, withRequest(scratch()), OWNER, options())).rejects.toThrow("git is missing");
		await expectNothingLeft();
	});

	test("a refused create still releases the synthesized base", async () => {
		const refuse = (): void => {
			throw new ApiError(401, "unauthorized");
		};
		await expect(createThreadFromUpload(store, withRequest(scratch()), OWNER, options({ beforeCreate: refuse }))).rejects.toThrow("unauthorized");
		expect(git.scratchReleased).toBe(1);
		await expectNothingLeft();
	});
});
