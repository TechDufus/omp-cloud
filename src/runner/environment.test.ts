import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CommandExitError, type Sandbox } from "e2b";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store";
import type { EnvironmentRow, NewThread, Thread } from "../store/types";
import { type EnvironmentDeps, environmentKey, environmentName, evictEnvironments, evictionOrder, type PrepareInput, prepareEnvironment } from "./environment";

const HANDOFF = "c".repeat(40);
const BASE = "b".repeat(40);
const TEMPLATE = "omp-agent:18.12.3-aaaaaaaaaaaa";
const REMOTE = "https://github.com/Owner/Repo.git";

describe("environmentKey", () => {
	const input = { template: TEMPLATE, repo: "github.com/owner/repo", run: "bun install", files: { "bun.lock": "a".repeat(64), "package-lock.json": null } };

	test("is a 64-hex SHA-256, the same for the same inputs, whatever the order of the files", () => {
		const key = environmentKey(input);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(environmentKey({ ...input })).toBe(key);
		expect(environmentKey({ ...input, files: { "package-lock.json": null, "bun.lock": "a".repeat(64) } })).toBe(key);
	});

	test("changes with a lockfile's contents, with a lockfile appearing or disappearing, the script, the repository and the template", () => {
		const key = environmentKey(input);
		const changed = [
			{ ...input, files: { ...input.files, "bun.lock": "b".repeat(64) } },
			{ ...input, files: { ...input.files, "package-lock.json": "c".repeat(64) } },
			{ ...input, files: { "bun.lock": "a".repeat(64) } },
			{ ...input, run: "bun install --frozen-lockfile" },
			{ ...input, repo: "github.com/owner/other" },
			{ ...input, template: "omp-agent:18.12.3-bbbbbbbbbbbb" },
		].map(environmentKey);
		expect(new Set([key, ...changed]).size).toBe(changed.length + 1);
	});

	test("the snapshot is named after the first 16 hex characters", () => {
		const key = environmentKey(input);
		expect(environmentName(key)).toBe(`omp-env-${key.slice(0, 16)}`);
	});
});

describe("evictionOrder", () => {
	const row = (key: string, template: string, lastUsedAt: string): EnvironmentRow => ({ key, snapshotId: `snap-${key}`, template, repo: "r", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt });

	test("keeps everything while at most `keep` rows exist", () => {
		expect(evictionOrder([row("a", TEMPLATE, "2026-01-01T00:00:00.000Z")], TEMPLATE, 1)).toEqual([]);
		expect(evictionOrder([], TEMPLATE, 0)).toEqual([]);
	});

	test("takes the rows of another template first, then the least recently used, until `keep` remain", () => {
		const rows = [
			row("new-old", TEMPLATE, "2026-02-01T00:00:00.000Z"),
			row("other-new", "other", "2026-03-01T00:00:00.000Z"),
			row("new-recent", TEMPLATE, "2026-03-01T00:00:00.000Z"),
			row("other-old", "other", "2026-01-01T00:00:00.000Z"),
		];
		expect(evictionOrder(rows, TEMPLATE, 3).map(r => r.key)).toEqual(["other-old"]);
		expect(evictionOrder(rows, TEMPLATE, 2).map(r => r.key)).toEqual(["other-old", "other-new"]);
		expect(evictionOrder(rows, TEMPLATE, 1).map(r => r.key)).toEqual(["other-old", "other-new", "new-old"]);
	});
});

let dir: string;
let store: Store;
let clock: Date;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-env-"));
	clock = new Date("2026-10-22T12:00:00.000Z");
	store = Store.open({ dataDir: dir, now: () => clock });
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

describe("evictEnvironments", () => {
	test("deletes the snapshots and the rows past the limit, and keeps the row of a snapshot vmon could not delete", async () => {
		for (const key of ["a", "b", "c"]) store.putEnvironment({ key, snapshotId: `snap-${key}`, template: TEMPLATE, repo: "r" });
		const deleted: string[] = [];
		const quiet = console.error;
		console.error = () => {};
		try {
			await evictEnvironments(
				store,
				{
					deleteSnapshot: async id => {
						if (id === "snap-a") throw new Error("vmon is busy");
						deleted.push(id);
						return true;
					},
				},
				TEMPLATE,
				1,
			);
		} finally {
			console.error = quiet;
		}
		expect(deleted).toEqual(["snap-b"]);
		expect(store.environments().map(r => r.key)).toEqual(["a", "c"]);
	});
});

interface Fixture {
	deps: EnvironmentDeps;
	input: PrepareInput;
	commands: string[];
	written: Map<string, string>;
	created: { from: string; metadata: Record<string, string> }[];
	killed: string[];
	snapshots: string[];
	events: string[];
	notices: string[];
	hashed: string[][];
}

/** A delta thread of `REMOTE` with a setup, over a fake vmon and a sandbox whose setup command `fails` with stderr `failure`. */
function fixture(options: { failure?: string; hashes?: Record<string, string | null>; id?: string } = {}): Fixture {
	const id = options.id ?? "aaaaaaaaaaaa";
	const newThread: NewThread = {
		owner: "owner",
		title: "t",
		prompt: "go",
		model: "fake/fake-model",
		thinking: "",
		repo: { name: "repo", remoteURL: REMOTE, baseRef: "main", baseCommit: BASE, handoffCommit: HANDOFF, localBranch: "main" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
		setup: { run: "mkdir -p deps && date > deps/stamp", cacheFiles: ["bun.lock", "go.sum"] },
	};
	const thread: Thread = store.createThread(id, newThread).thread;
	const commands: string[] = [];
	const written = new Map<string, string>();
	const created: Fixture["created"] = [];
	const killed: string[] = [];
	const snapshots: string[] = [];
	const hashed: string[][] = [];
	const sandbox = {
		sandboxId: "env-sandbox",
		commands: {
			run: async (command: string) => {
				commands.push(command);
				if (command.startsWith("mktemp")) return { stdout: "/tmp/transfer\n" };
				if (command.startsWith("bash -c") && options.failure !== undefined) {
					throw new CommandExitError({ exitCode: 3, error: "exit", stdout: "", stderr: `noise\n${options.failure}\n` });
				}
				return { stdout: "" };
			},
		},
		files: {
			write: async (path: string, data: unknown) => {
				written.set(path, typeof data === "string" ? data : "<stream>");
			},
		},
	} as unknown as Sandbox;
	const bundle = join(dir, "composed.bundle");
	const deps: EnvironmentDeps = {
		store,
		vmon: {
			create: async (from, metadata) => {
				created.push({ from, metadata });
				return sandbox;
			},
			kill: async id => {
				killed.push(id);
				return true;
			},
			snapshot: async (_sandbox, name) => {
				snapshots.push(name);
				return `snapshot-${snapshots.length}`;
			},
			deleteSnapshot: async () => true,
		},
		git: {
			composeSource: async () => ({ path: bundle, release: async () => undefined }),
			fileHashes: async input => {
				hashed.push([...input.paths]);
				return options.hashes ?? { "bun.lock": "d".repeat(64), "go.sum": null };
			},
		},
		serviceId: store.serviceId(),
		sandboxTimeoutMs: 3600_000,
	};
	const events: string[] = [];
	const notices: string[] = [];
	const input: PrepareInput = {
		thread,
		setup: newThread.setup ?? { run: "", cacheFiles: [] },
		template: TEMPLATE,
		network: undefined,
		secrets: { NPM_TOKEN: "it's-secret" },
		mayBuild: true,
		emit: text => events.push(text),
		warn: text => notices.push(text),
	};
	return { deps, input, commands, written, created, killed, snapshots, events, notices, hashed };
}

describe("prepareEnvironment", () => {
	beforeEach(async () => {
		await writeFile(join(dir, "composed.bundle"), "bundle");
	});

	test("builds the environment for the first VM: the repository checked out in a throwaway sandbox, the script run, the disk snapshotted, the sandbox killed", async () => {
		const f = fixture();

		const prepared = await prepareEnvironment(f.deps, f.input);

		expect(prepared).not.toBeNull();
		expect(prepared?.snapshotId).toBe("snapshot-1");
		expect(prepared?.name).toMatch(/^omp-env-[0-9a-f]{16}$/);
		expect(f.hashed).toEqual([["bun.lock", "go.sum"]]);
		expect(f.created).toEqual([{ from: TEMPLATE, metadata: { app: "omp-cloud-env", service: store.serviceId(), key: prepared?.key ?? "" } }]);
		// The repository first, then the script, then the snapshot; the sandbox is gone either way.
		const at = (part: string) => f.commands.findIndex(command => command.includes(part));
		expect(at("git init -q '/home/user/work'")).toBeGreaterThanOrEqual(0);
		expect(at("checkout -q -f --detach refs/omp-cloud/handoff")).toBeGreaterThan(at("fetch -q"));
		expect(at("exec bash ")).toBeGreaterThan(at("checkout -q -f --detach"));
		expect(f.commands.at(-1)).toBe("rm -f '/tmp/omp-cloud-setup.env' '/tmp/omp-cloud-setup.sh'");
		expect(f.written.get("/tmp/omp-cloud-setup.sh")).toBe("set -e\nmkdir -p deps && date > deps/stamp\n");
		expect(f.written.get("/tmp/omp-cloud-setup.env")).toBe("NPM_TOKEN='it'\\''s-secret'\n");
		expect(f.snapshots).toEqual([prepared?.name ?? ""]);
		expect(f.killed).toEqual(["env-sandbox"]);
		expect(f.events).toEqual(["preparing the repository environment (setup in .omp-cloud.yml)", `environment ready (${prepared?.name})`]);
		expect(f.notices).toEqual([]);
		// The row is stored under the key, and the sandbox was never recorded as a VM.
		expect(store.environment(prepared?.key ?? "")).toMatchObject({ snapshotId: "snapshot-1", template: TEMPLATE, repo: "github.com/owner/repo" });
		expect(store.vm(f.input.thread.id)).toBeNull();
	});

	test("the second thread of the repository finds the cached environment: no sandbox, no build, the row is touched", async () => {
		const first = fixture();
		const built = await prepareEnvironment(first.deps, first.input);
		expect(store.environment(built?.key ?? "")?.lastUsedAt).toBe("2026-10-22T12:00:00.000Z");
		clock = new Date("2026-10-22T13:00:00.000Z");

		const second = fixture({ id: "bbbbbbbbbbbb" });
		const found = await prepareEnvironment(second.deps, second.input);

		expect(found).toEqual(built);
		expect(second.created).toEqual([]);
		expect(second.events).toEqual([`using the cached environment ${built?.name}`]);
		expect(store.environment(built?.key ?? "")?.lastUsedAt).toBe("2026-10-22T13:00:00.000Z");
		expect(store.environment(built?.key ?? "")?.createdAt).toBe("2026-10-22T12:00:00.000Z");
	});

	test("a changed lockfile prepares the environment again, next to the old one", async () => {
		const first = fixture();
		const built = await prepareEnvironment(first.deps, first.input);

		const second = fixture({ id: "bbbbbbbbbbbb", hashes: { "bun.lock": "e".repeat(64), "go.sum": null } });
		const rebuilt = await prepareEnvironment(second.deps, second.input);

		expect(rebuilt?.key).not.toBe(built?.key);
		expect(second.events[0]).toBe("preparing the repository environment (setup in .omp-cloud.yml)");
		expect(store.environments()).toHaveLength(2);
	});

	test("a restore (no build allowed) without a cached environment starts from the template", async () => {
		const f = fixture();

		expect(await prepareEnvironment(f.deps, { ...f.input, mayBuild: false })).toBeNull();

		expect(f.created).toEqual([]);
		expect(f.events).toEqual([]);
		expect(f.notices).toEqual([]);
	});

	test("a failing script is a vm event with its exit code and the end of stderr, no row, and the sandbox is killed", async () => {
		const f = fixture({ failure: "E: package not found" });

		expect(await prepareEnvironment(f.deps, f.input)).toBeNull();

		expect(f.events.at(-1)).toBe("environment setup failed: exit 3: noise\nE: package not found");
		expect(f.notices).toEqual([]);
		expect(f.snapshots).toEqual([]);
		expect(f.killed).toEqual(["env-sandbox"]);
		expect(store.environments()).toEqual([]);
		// The environment file is removed even when the script failed.
		expect(f.commands.at(-1)).toContain("rm -f '/tmp/omp-cloud-setup.env'");
	});

	test("only the last 500 characters of stderr are reported", async () => {
		const f = fixture({ failure: `${"x".repeat(800)}END` });

		await prepareEnvironment(f.deps, f.input);

		const message = f.events.at(-1) ?? "";
		expect(message.startsWith("environment setup failed: exit 3: ")).toBe(true);
		expect(message.length).toBe("environment setup failed: exit 3: ".length + 500);
		expect(message.endsWith("xxxEND")).toBe(true);
	});

	test("an unreadable repository (the git cache lost the base) is a notice, not a throw", async () => {
		const f = fixture();
		f.deps.git.fileHashes = async () => {
			throw new Error("the git cache holds no handoff of this thread");
		};

		expect(await prepareEnvironment(f.deps, f.input)).toBeNull();

		expect(f.notices).toEqual(["the repository environment is not available: the git cache holds no handoff of this thread"]);
		expect(f.created).toEqual([]);
	});

	test("threads that start together share one build", async () => {
		const first = fixture();
		const second = fixture({ id: "bbbbbbbbbbbb" });
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		const slow = first.deps.vmon.create;
		first.deps.vmon.create = async (...args) => {
			entered.resolve();
			await gate.promise;
			return slow(...args);
		};
		second.input.emit = text => {
			second.events.push(text);
			if (text.startsWith("waiting")) waiting.resolve();
		};

		const a = prepareEnvironment(first.deps, first.input);
		await entered.promise;
		const b = prepareEnvironment(second.deps, second.input);
		await waiting.promise;
		gate.resolve();
		const [builtA, builtB] = await Promise.all([a, b]);

		expect(builtA).not.toBeNull();
		expect(builtB).toEqual(builtA);
		expect(first.snapshots).toHaveLength(1);
		expect(second.created).toEqual([]);
		expect(second.events).toEqual(["waiting for the repository environment another thread is preparing"]);
		expect(store.environments()).toHaveLength(1);
	});

	test("the least recently used environments are evicted past 20", async () => {
		for (let n = 0; n < 20; n++) store.putEnvironment({ key: `old-${n}`, snapshotId: `old-snap-${n}`, template: TEMPLATE, repo: "r" });
		clock = new Date("2026-10-23T12:00:00.000Z");
		const f = fixture();
		const deleted: string[] = [];
		f.deps.vmon.deleteSnapshot = async id => {
			deleted.push(id);
			return true;
		};

		await prepareEnvironment(f.deps, f.input);

		expect(store.environments()).toHaveLength(20);
		expect(deleted).toEqual(["old-snap-0"]);
	});
});
