import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { CloudClient, type CreateOptions, type HandoffParts } from "../src/api";
import { readConfig, type CloudConfig, type Env } from "../src/config";
import { run } from "../src/exec";
import { isRecord } from "../src/guards";
import { CloudError } from "../src/errors";
import { launchBatch, type LaunchBatchInput, type LaunchedThread, type LaunchOutcome } from "../src/launch";
import type { TitleGenerator } from "../src/naming";
import { git } from "../src/snapshot";
import type { HandoffRequest, Whoami } from "../src/types";
import { projectBankName } from "../src/mnemopi";
import { summary, whoami } from "./builders";
import { fakeHost, fakePi, fakeSettings, type FakeHost, type FakePiOptions } from "./fakes";
import { cleanup, commitFile, configureRepo, isolateOmp, ompHome, syncInto, tmp } from "./helpers";

const OLD_ID = "0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const TS = "2026-10-18T22-11-00-000Z";
const CALL_ID = "call_cloud";

const realTmpDir = process.env.TMPDIR;
/** Everything the handoff creates goes under here (`os.tmpdir()` follows `TMPDIR`), so leftovers are visible. */
let scratch = "";

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "omp-cloud-launch-"));
	process.env.TMPDIR = scratch;
});

afterEach(async () => {
	restoreTmpDir();
	await cleanup();
	await rm(scratch, { recursive: true, force: true });
});

afterAll(restoreTmpDir);

function restoreTmpDir(): void {
	if (realTmpDir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = realTmpDir;
}

// ---------------------------------------------------------------------------
// A fake cloud API: whoami plus the handoff upload
// ---------------------------------------------------------------------------

interface Upload {
	keys: string[];
	request: HandoffRequest;
	files: Record<string, File>;
}

let uploads: Upload[] = [];
let whoamiHits = 0;
let patterns: string[] = ["anthropic/*"];

const api = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/api/v1/whoami") {
			whoamiHits++;
			return Response.json(whoami({ modelPatterns: patterns }));
		}
		if (req.method === "POST" && url.pathname === "/api/v1/threads") {
			const form = await req.formData();
			const files: Record<string, File> = {};
			const keys: string[] = [];
			for (const [k, v] of form.entries()) {
				keys.push(k);
				if (typeof v !== "string") files[k] = v;
			}
			const request: HandoffRequest = JSON.parse(await (files.request as File).text());
			uploads.push({ keys, request, files });
			return Response.json(summary({ id: "newthread123", warnings: [] }), { status: 201 });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	},
});

afterAll(() => api.stop(true));

beforeEach(() => {
	uploads = [];
	whoamiHits = 0;
	patterns = ["anthropic/*"];
});

// ---------------------------------------------------------------------------
// Fixtures: a git repo, an agent dir with overlays, a session with an artifacts directory
// ---------------------------------------------------------------------------

/** omp's fixed-width title slot line; it precedes the `session` header line. */
function titleSlot(): string {
	const mk = (pad: string) => JSON.stringify({ type: "title", v: 1, title: "My task", updatedAt: "2026-10-18T22:11:00.000Z", pad });
	return mk(" ".repeat(255 - mk("").length));
}

const msg = (id: string, parentId: string | null, role: string, content: unknown) =>
	JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-18T22:11:01.000Z", message: { role, content } });

interface Session {
	file: string;
	original: string;
}

async function makeSession(cwd: string, agentDir: string): Promise<Session> {
	const dir = join(agentDir, "sessions", "--work--");
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${TS}_${OLD_ID}.jsonl`);
	const lines = [
		titleSlot(),
		JSON.stringify({ type: "session", version: 3, id: OLD_ID, timestamp: "2026-10-18T22:11:00.000Z", cwd, title: "t" }),
		msg("e1", null, "user", [{ type: "text", text: "hello" }]),
		JSON.stringify({ type: "custom_message", id: "c1", parentId: "e1", customType: "omp-cloud", content: "[cloud] x", display: true, details: {} }),
		msg("e2", "c1", "assistant", [{ type: "text", text: "done" }]),
		msg("a9", "e2", "assistant", [{ type: "toolCall", id: CALL_ID, name: "cloud", arguments: { op: "delegate" } }]),
		"",
	];
	await writeFile(file, lines.join("\n"));
	await mkdir(join(dir, `${TS}_${OLD_ID}`), { recursive: true });
	await writeFile(join(dir, `${TS}_${OLD_ID}`, "artifact.txt"), "artifact bytes");
	return { file, original: await readFile(file, "utf8") };
}

async function makeRepo(): Promise<string> {
	const dir = await tmp("omp-cloud-repo-");
	await git(dir, ["init", "-q", "-b", "main"]);
	await configureRepo(dir);
	await commitFile(dir, "a.txt", "one\n");
	await commitFile(dir, "b.txt", "two\n");
	await writeFile(join(dir, "a.txt"), "one\nDIRTY\n");
	return dir;
}

interface Setup {
	repo: string;
	agentDir: string;
	home: string;
	/** An overlay inside the agent dir, and one outside it. */
	inside: string;
	outside: string;
	session: Session;
	/** The session's settings: `--config` overlays are `outside` then `inside`. */
	settings: Settings;
	/** omp-cloud's configuration with no file and nothing in the environment. */
	cfg: CloudConfig;
}

/** omp-cloud's configuration for a setup's home and repository, from the files given: `<home>/.config/omp-cloud/config.yml` and `<repo>/.omp-cloud.yml`. */
async function cloudConfig(where: { home: string; repo: string }, files: { personal?: string; repo?: string } = {}): Promise<CloudConfig> {
	if (files.personal !== undefined) {
		await mkdir(join(where.home, ".config", "omp-cloud"), { recursive: true });
		await writeFile(join(where.home, ".config", "omp-cloud", "config.yml"), files.personal);
	}
	if (files.repo !== undefined) await writeFile(join(where.repo, ".omp-cloud.yml"), files.repo);
	return readConfig({ env: {}, home: where.home, repoRoot: where.repo, platform: "linux" });
}

async function setup(): Promise<Setup> {
	const repo = await makeRepo();
	// omp discovers extensions from its own agent dir: a temp one keeps the developer's out of the handoff.
	const { agentDir } = await isolateOmp();
	const home = await tmp("omp-cloud-home-");
	const elsewhere = await tmp("omp-cloud-else-");
	await writeFile(join(agentDir, "config.yml"), "theme: dark\n");
	await writeFile(join(agentDir, "AGENTS.md"), "# prefs\n");
	const inside = join(agentDir, "team.yml");
	await writeFile(inside, "team: yes\n");
	const outside = join(elsewhere, "outside.yml");
	await writeFile(outside, "outside: yes\n");
	const settings = await fakeSettings({ agentDir, cwd: repo, configFiles: [outside, inside] });
	return { repo, agentDir, home, inside, outside, session: await makeSession(repo, agentDir), settings, cfg: await cloudConfig({ home, repo }) };
}

interface Launched {
	s: Setup;
	result: LaunchedThread;
	host: FakeHost;
	env: Env;
}

interface LaunchOptions extends FakePiOptions {
	model?: { provider: string; id: string } | null;
	/** Without a session file there is no conversation to pack. */
	withSession?: boolean;
	toolCallId?: string;
	task?: string;
	/** omp-cloud's configuration; none by default (see {@link cloudConfig}). */
	cfg?: CloudConfig;
	/** Replaces omp's title generator; the host then has a model registry to ask it with. */
	generateTitle?: TitleGenerator;
}

function input(s: Setup, o: LaunchOptions, client: LaunchClient): { input: LaunchInput; host: FakeHost; env: Env } {
	const host = fakeHost({ cwd: s.repo, sessionFile: o.withSession === false ? undefined : s.session.file, model: o.model, modelRegistry: o.generateTitle ? ({ find: () => undefined } as never) : undefined });
	const env: Env = { PI_CODING_AGENT_DIR: s.agentDir };
	const settings = o.settings ?? s.settings;
	const { pi } = fakePi({ ...o, settings });
	return {
		host,
		env,
		input: {
			host: host.host,
			pi,
			cfg: o.cfg ?? s.cfg,
			client,
			task: o.task ?? "add tests",
			env,
			home: s.home,
			agentDir: s.agentDir,
			// This extension's own directory: somewhere that holds nothing of the agent dir.
			ownRoot: join(s.home, "own-extension"),
			toolCallId: o.toolCallId,
			generateTitle: o.generateTitle,
		},
	};
}

const realClient = (): CloudClient => new CloudClient(`http://127.0.0.1:${api.port}`, "tok");

type LaunchClient = Pick<CloudClient, "createThread" | "whoami">;

/** One user-origin task of the repository, the shape a `/cloud <task>` launch has. */
interface LaunchInput extends Omit<LaunchBatchInput, "tasks" | "origin" | "sessionId" | "client"> {
	client: LaunchClient;
	task: string;
}

/** Launches the one task and returns its thread; a failed task throws its error. */
async function launchHandoff(input: LaunchInput): Promise<LaunchedThread> {
	const { task, client, ...rest } = input;
	const batch = await launchBatch({
		...rest,
		client: { whoami: o => client.whoami(o), createThread: (p, o) => client.createThread(p, o), requireCapability: async () => {} },
		tasks: [{ task, workspace: "repo" }],
		origin: "user",
		sessionId: "sess-1",
	});
	const outcome = batch.outcomes[0];
	if (!outcome) throw new Error("no outcome");
	if (!outcome.ok) throw outcome.error;
	return outcome;
}

/** The repository of a handoff that ships one: a scratch request has none. */
function repoOf(parts: HandoffParts): HandoffRequest["repo"] {
	const { repo } = parts.request;
	if ("scratch" in repo) throw new Error("a scratch request has no repository");
	return repo;
}

const refused = (status: number, message: string): CloudError => new CloudError({ code: status === 409 ? "conflict" : status === 413 ? "too_large" : status === 400 ? "invalid" : "unavailable", status, message, retriable: false, outcomeKnown: true });

async function launch(o: LaunchOptions = {}): Promise<Launched> {
	const s = await setup();
	const built = input(s, o, realClient());
	const result = await launchHandoff(built.input);
	return { s, result, host: built.host, env: built.env };
}

const only = (): Upload => {
	expect(uploads).toHaveLength(1);
	return uploads[0] as Upload;
};

const parseEntries = (text: string): Record<string, unknown>[] =>
	text
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as unknown)
		.filter(isRecord);

/** Omp-cloud scratch entries of the tmp dir that did not exist in `before`. */
async function leftovers(before: string[]): Promise<string[]> {
	return (await readdir(scratch)).filter(n => n.startsWith("omp-cloud-") && !before.includes(n));
}

async function saved(f: File, name: string): Promise<string> {
	const path = join(await tmp(), name);
	await Bun.write(path, f);
	return path;
}

// ---------------------------------------------------------------------------
// (a) a model the cloud cannot run is refused before anything is packed
// ---------------------------------------------------------------------------

describe("model refusal", () => {
	test("a provider missing from modelPatterns stops the handoff with the exact message, packing and uploading nothing", async () => {
		const s = await setup();
		const built = input(s, { model: { provider: "openai-codex", id: "gpt-5" } }, realClient());
		// If the handoff tried to create its scratch directory, mkdtemp would fail with ENOENT instead.
		process.env.TMPDIR = join(scratch, "does-not-exist");

		const err = await launchHandoff(built.input).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(CloudError);
		expect(err).toMatchObject({ code: "invalid", message: "the cloud cannot run openai-codex models yet: /cloud login openai-codex" });
		expect(whoamiHits).toBe(1);
		expect(uploads).toEqual([]);
	});

	test("on a paired device the refusal sends the owner to the server, with its host and the provider, and never to /cloud login", async () => {
		const s = await setup();
		const built = input(s, { model: { provider: "openai-codex", id: "gpt-5" } }, realClient());

		const err = await launchHandoff({ ...built.input, serverHost: "10.0.20.24" }).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(CloudError);
		expect((err as CloudError).message).toBe(
			"the cloud cannot run openai-codex models yet: log the server in: run omp-cloud login openai-codex on 10.0.20.24 (over ssh: ssh -t <user>@10.0.20.24 '~/.local/bin/omp-cloud login openai-codex')",
		);
		expect((err as CloudError).message).not.toContain("/cloud login");
		expect(uploads).toEqual([]);
	});

	test("createThread is never called for a refused model", async () => {
		const s = await setup();
		const created: HandoffParts[] = [];
		const client: LaunchClient = {
			whoami: async () => whoami({ modelPatterns: ["anthropic/*"] }),
			createThread: async parts => {
				created.push(parts);
				return { summary: summary(), replayed: false };
			},
		};
		const before = await readdir(scratch);
		const built = input(s, { model: { provider: "openai-codex", id: "gpt-5" } }, client);
		await expect(launchHandoff(built.input)).rejects.toThrow("/cloud login openai-codex");
		expect(created).toEqual([]);
		expect(await leftovers(before)).toEqual([]);
	});

	test("an exact provider/id pattern admits just that model", async () => {
		patterns = ["openai-codex/gpt-5"];
		const ok = await launch({ model: { provider: "openai-codex", id: "gpt-5" }, withSession: false });
		expect(ok.result.summary.model).toBe("openai-codex/gpt-5");
		expect(only().request.model).toBe("openai-codex/gpt-5");

		uploads = [];
		const s = await setup();
		const other = input(s, { model: { provider: "openai-codex", id: "gpt-6" }, withSession: false }, realClient());
		await expect(launchHandoff(other.input)).rejects.toThrow("the cloud cannot run openai-codex models yet: /cloud login openai-codex");
		expect(uploads).toEqual([]);
	});

	test("a session without a model is not refused and asks for the service's default", async () => {
		await launch({ model: null, withSession: false });
		expect(only().request.model).toBe("");
	});
});

// ---------------------------------------------------------------------------
// (b) the request mirrors the session
// ---------------------------------------------------------------------------

describe("the handoff request", () => {
	test("carries model, thinking, a release-only omp version, overlays in load order and a full-history base", async () => {
		const { s, result } = await launch({ thinking: "high", version: "18.12.3-dev.4", task: "add the missing tests" });
		const up = only();
		const r = up.request;

		expect(up.keys).toEqual(["request", "source", "conversation", "setup"]);
		expect(r.prompt).toBe("add the missing tests");
		expect(r.model).toBe("anthropic/claude-sonnet-5-5");
		expect(r.thinking).toBe("high");
		expect(r.ompVersion).toBe("18.12.3");
		// pi.pi.settings.getConfigFiles() order: the outside overlay first, then the one inside the agent dir
		expect(r.configOverlays).toEqual(["overlays/1-outside.yml", "team.yml"]);
		expect(r.repo.baseCommit).toBe("");
		expect(r.repo.name).toBe(s.repo.split("/").at(-1) as string);
		expect(r.repo.localBranch).toBe("main");
		expect(r.paths).toEqual({ home: s.home, workspace: s.repo });
		expect(r.author).toEqual({ name: "Test User", email: "test@example.com" });

		expect(result.response.id).toBe("newthread123");
		expect(result.summary).toMatchObject({
			model: "anthropic/claude-sonnet-5-5",
			thinking: "high",
			ompVersion: "18.12.3",
			overlays: ["overlays/1-outside.yml", "team.yml"],
			conversation: "included",
			commits: 2,
		});
	});

	test("overlays follow the order of getConfigFiles, not their location", async () => {
		const s = await setup();
		const settings = await fakeSettings({ agentDir: s.agentDir, cwd: s.repo, configFiles: [s.inside, s.outside] });
		const built = input(s, { settings, withSession: false }, realClient());
		await launchHandoff(built.input);
		expect(only().request.configOverlays).toEqual(["team.yml", "overlays/2-outside.yml"]);
	});

	describe("mcp", () => {
		const real = realClient();
		const mcpClient = (who: Partial<Whoami>): LaunchClient => ({ createThread: (parts, options) => real.createThread(parts, options), whoami: async () => whoami({ modelPatterns: ["anthropic/*"], ...who }) });

		async function withMcp(): Promise<Setup> {
			const s = await setup();
			const servers = {
				wiki: { type: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer ${WIKI_TOKEN}" } },
				fs: { command: "npx", args: ["-y", "server-fs"], env: { TOKEN: "${FS_TOKEN}" } },
				local: { type: "http", url: "http://127.0.0.1:9/mcp" },
			};
			await writeFile(join(s.agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
			return s;
		}

		test("with mcp.proxy the shippable servers go in the request, the summary names how each is reached, and the rest warn", async () => {
			const s = await withMcp();
			const built = input(s, { withSession: false }, mcpClient({ capabilities: ["mcp.proxy"], mcpProxy: true }));
			built.env.WIKI_TOKEN = "wiki-secret";
			const result = await launchHandoff(built.input);
			expect(only().request.mcp).toEqual([
				{ name: "wiki", type: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer wiki-secret" } },
				{ name: "fs", type: "stdio", command: "npx", args: ["-y", "server-fs"], env: { TOKEN: "${FS_TOKEN}" } },
			]);
			expect(result.summary.mcp).toEqual([
				{ name: "wiki", via: "service" },
				{ name: "fs", via: "vm" },
			]);
			expect(result.warnings).toEqual(["local points at this machine and is not shipped"]);
		});

		test("without mcp.proxy the request has no mcp field and the launch says so", async () => {
			const s = await withMcp();
			const result = await launchHandoff(input(s, { withSession: false }, mcpClient({ capabilities: [] })).input);
			expect(only().request).not.toHaveProperty("mcp");
			expect(result.summary.mcp).toEqual([]);
			expect(result.warnings).toEqual(["the cloud service cannot take MCP servers; none are shipped"]);
		});
	});

	describe("environment setup", () => {
		const real = realClient();
		const setupClient = (capabilities: string[]): LaunchClient => ({ createThread: (parts, options) => real.createThread(parts, options), whoami: async () => whoami({ modelPatterns: ["anthropic/*"], capabilities }) });

		test("the repository's setup ships as request.setup to a service with threads.setup, and the summary names the cache files", async () => {
			const s = await setup();
			const cfg = await cloudConfig(s, { repo: "setup:\n  run: bun install\n  cacheFiles: [bun.lock]\n" });
			const result = await launchHandoff(input(s, { withSession: false, cfg }, setupClient(["threads.setup"])).input);
			expect(only().request.setup).toEqual({ run: "bun install", cacheFiles: ["bun.lock"] });
			expect(result.summary.setup).toEqual({ cacheFiles: ["bun.lock"] });
		});

		test("without cacheFiles the request carries none, so the service's default list applies", async () => {
			const s = await setup();
			const cfg = await cloudConfig(s, { repo: "setup:\n  run: make deps\n" });
			const result = await launchHandoff(input(s, { withSession: false, cfg }, setupClient(["threads.setup"])).input);
			expect(only().request.setup).toEqual({ run: "make deps" });
			expect(result.summary.setup).toEqual({ cacheFiles: undefined });
		});

		test("a service without threads.setup gets no setup field and the launch says why", async () => {
			const s = await setup();
			const cfg = await cloudConfig(s, { repo: "setup:\n  run: make deps\n" });
			const result = await launchHandoff(input(s, { withSession: false, cfg }, setupClient([])).input);
			expect(only().request).not.toHaveProperty("setup");
			expect(result.summary.setup).toBeNull();
			expect(result.warnings).toContain("the cloud service cannot run the setup of .omp-cloud.yml; it is not shipped");
		});

		test("a repository without a setup sends none", async () => {
			const s = await setup();
			const result = await launchHandoff(input(s, { withSession: false }, setupClient(["threads.setup"])).input);
			expect(only().request).not.toHaveProperty("setup");
			expect(result.summary.setup).toBeNull();
		});
	});

	test("secretFiles of the repository's .omp-cloud.yml ship in the request, base64", async () => {
		const s = await setup();
		await writeFile(join(s.repo, ".gitignore"), ".env\n");
		await writeFile(join(s.repo, ".env"), "K=v\n");
		const cfg = await cloudConfig(s, { repo: "secretFiles: [.env]\n" });
		await launchHandoff(input(s, { cfg, withSession: false }, realClient()).input);
		expect(only().request.secretFiles).toEqual([{ path: ".env", content: Buffer.from("K=v\n").toString("base64") }]);
	});

	test("without a policy the request carries no policy and the summary lists no keys", async () => {
		const { result } = await launch({ withSession: false });
		expect(only().request).not.toHaveProperty("policy");
		expect(result.summary.policy).toEqual([]);
	});

	test("the policy of the personal file and the repository file ships as request.policy, key by key, and the summary lists its keys", async () => {
		const s = await setup();
		const cfg = await cloudConfig(s, {
			personal: "policy:\n  fetch: true\n  egress: [example.com]\n",
			repo: "policy:\n  fetch: false\n  spend.turnUSD: 0.5\n  bash.patterns:\n    - { match: 'touch /tmp/x*', approval: deny }\n",
		});
		const result = await launchHandoff(input(s, { cfg, withSession: false }, realClient()).input);
		expect(only().request.policy).toEqual({
			egress: ["example.com"],
			fetch: false,
			"spend.turnUSD": 0.5,
			"bash.patterns": [{ match: "touch /tmp/x*", approval: "deny" }],
		});
		expect(result.summary.policy).toEqual(["fetch", "egress", "spend.turnUSD", "bash.patterns"]);
	});

	test("the service's maxUploadBytes is the only upload cap", async () => {
		const s = await setup();
		const client: LaunchClient = { whoami: async () => whoami({ maxUploadBytes: 10 }), createThread: async () => ({ summary: summary(), replayed: false }) };
		await expect(launchHandoff(input(s, { withSession: false }, client).input)).rejects.toThrow(/^repository bundle is [\d.]+ MB, over the [\d.]+ MB upload limit$/);
	});

	test("the source part is a bundle of the whole history, WIP commit included, that verifies in an empty repository", async () => {
		const { s } = await launch();
		const up = only();
		const bundle = await saved(up.files.source as File, "source.bundle");

		expect(await git(s.repo, ["bundle", "list-heads", bundle])).toBe(`${repoOf(up).handoffCommit} refs/omp-cloud/handoff`);
		const fresh = await tmp();
		await git(fresh, ["init", "-q"]);
		await git(fresh, ["bundle", "verify", bundle]);
		await git(fresh, ["fetch", "-q", bundle, "refs/omp-cloud/handoff"]);
		expect(await git(fresh, ["rev-parse", "FETCH_HEAD"])).toBe(repoOf(up).handoffCommit);
		// a.txt + b.txt + the WIP commit
		expect(await git(fresh, ["rev-list", "--count", "FETCH_HEAD"])).toBe("3");
		expect(await git(fresh, ["show", "FETCH_HEAD:a.txt"])).toBe("one\nDIRTY");
		expect(await git(fresh, ["show", "FETCH_HEAD:b.txt"])).toBe("two");
		// the owner's repository is left as it was
		expect((await run("git", ["status", "--porcelain"], { cwd: s.repo })).stdout).toBe(" M a.txt\n");
		expect((await run("git", ["rev-parse", "--verify", "-q", "refs/omp-cloud/handoff"], { cwd: s.repo })).code).not.toBe(0);
	});

	test("the setup part ships the agent dir allowlist and the overlays at the paths the request names", async () => {
		await launch();
		const up = only();
		const archive = await saved(up.files.setup as File, "setup.tar.gz");
		const listing = await run("tar", ["-tzf", archive]);
		expect(listing.code).toBe(0);
		const names = listing.stdout.split("\n").map(n => n.replace(/^\.\//, ""));
		expect(names).toContain("config.yml");
		expect(names).toContain("AGENTS.md");
		for (const overlay of up.request.configOverlays) expect(names).toContain(overlay);
		expect((await run("tar", ["-xzOf", archive, "./overlays/1-outside.yml"])).stdout).toBe("outside: yes\n");
	});

	test.each([
		["unset", undefined, ""],
		["unknown", "turbo", ""],
		["an empty string", "", ""],
		["off", "off", "off"],
		["xhigh", "xhigh", "xhigh"],
	])("thinking %s is sent as %p", async (_name, level, want) => {
		const { result } = await launch({ thinking: level, withSession: false });
		expect(only().request.thinking).toBe(want);
		expect(result.summary.thinking).toBe(want);
	});

	test.each([
		["18.12.3", "18.12.3"],
		["18.12.3-dev.4", "18.12.3"],
		["v18", ""],
		["", ""],
	])("omp version %p is sent as %p", async (version, want) => {
		await launch({ version, withSession: false });
		expect(only().request.ompVersion).toBe(want);
	});

	test("no session file means no conversation part", async () => {
		const { result } = await launch({ withSession: false });
		expect(only().keys).toEqual(["request", "source", "setup"]);
		expect(result.summary.conversation).toBe("none");
	});
});

describe("the memory bank of a handoff", () => {
	const VM = "/home/user/work";

	/** A setup whose omp uses mnemopi with a project bank for the repository, and a service that reports `who`. */
	async function memoryLaunch(who: Partial<Whoami>): Promise<{ from: string; to: string; names: string[] }> {
		const s = await setup();
		const from = projectBankName(s.repo, undefined);
		await mkdir(join(s.agentDir, "memories", "mnemopi", "banks", from), { recursive: true });
		await writeFile(join(s.agentDir, "memories", "mnemopi", "banks", from, "mnemopi.db"), "bank bytes");
		const settings = await fakeSettings({ agentDir: s.agentDir, cwd: s.repo, configFiles: [s.outside, s.inside], global: "memory:\n  backend: mnemopi\n" });
		const real = realClient();
		const client: LaunchClient = { whoami: async () => whoami({ modelPatterns: patterns, ...who }), createThread: (p, o) => real.createThread(p, o) };
		await launchHandoff(input(s, { settings, withSession: false }, client).input);
		const archive = await saved(only().files.setup as File, "setup.tar.gz");
		const names = (await run("tar", ["-tzf", archive])).stdout.split("\n").map(n => n.replace(/^\.\//, ""));
		return { from, to: projectBankName(VM, undefined), names };
	}

	test("the request names the local bank, and the shipped bank carries the name the VM derives for its workspace", async () => {
		const { from, to, names } = await memoryLaunch({ capabilities: ["threads.memory"], vmWorkspace: VM });
		expect(only().request.memory).toEqual({ bank: from });
		expect(names).toContain(`memories/mnemopi/banks/${to}/mnemopi.db`);
		expect(names.filter(n => n.includes(`banks/${from}`))).toEqual([]);
	});

	test("a service without threads.memory gets no memory field and the bank keeps its name", async () => {
		const { from, names } = await memoryLaunch({ capabilities: [], vmWorkspace: VM });
		expect(only().request.memory).toBeUndefined();
		expect(names).toContain(`memories/mnemopi/banks/${from}/mnemopi.db`);
	});

	test("a service that reports no VM workspace gets no memory field either", async () => {
		const { from, names } = await memoryLaunch({ capabilities: ["threads.memory"], vmWorkspace: "" });
		expect(only().request.memory).toBeUndefined();
		expect(names).toContain(`memories/mnemopi/banks/${from}/mnemopi.db`);
	});

	test("without the mnemopi backend nothing is sent", async () => {
		await launch({ withSession: false });
		expect(only().request.memory).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// the extensions omp loads are the ones that ship
// ---------------------------------------------------------------------------

describe("the shipped extensions", () => {
	async function shippedNames(): Promise<string[]> {
		const archive = await saved(only().files.setup as File, "setup.tar.gz");
		const listing = await run("tar", ["-tzf", archive]);
		return listing.stdout.split("\n").map(n => n.replace(/^\.\//, ""));
	}

	test("the extensions omp discovers ship; excludeExtensions, this extension and the repository's own .omp extensions stay home", async () => {
		const s = await setup();
		const extDir = join(s.agentDir, "extensions");
		await mkdir(extDir, { recursive: true });
		for (const name of ["keep.ts", "herd.ts"]) await writeFile(join(extDir, name), "export default function ext(): void {}\n");
		await mkdir(join(s.repo, ".omp", "extensions"), { recursive: true });
		await writeFile(join(s.repo, ".omp", "extensions", "project.ts"), "export default function ext(): void {}\n");
		const settings = await fakeSettings({ agentDir: s.agentDir, cwd: s.repo, configFiles: [s.outside, s.inside] });
		const cfg = await cloudConfig(s, { personal: "excludeExtensions: [herd.ts]\n" });

		const { warnings } = await launchHandoff(input(s, { settings, cfg, withSession: false }, realClient()).input);

		const names = await shippedNames();
		expect(names).toContain("extensions/keep.ts");
		expect(names).not.toContain("extensions/herd.ts");
		expect(names.filter(n => n.includes("project.ts"))).toEqual([]);
		expect(warnings).toEqual([]);
	});

	test("an enabled plugin is named in the launch warnings and not shipped", async () => {
		const s = await setup();
		const plugins = join(s.agentDir, "..", "plugins");
		await mkdir(join(plugins, "node_modules", "demo-plugin"), { recursive: true });
		await writeFile(join(plugins, "package.json"), JSON.stringify({ dependencies: { "demo-plugin": "1.0.0" } }));
		await writeFile(join(plugins, "node_modules", "demo-plugin", "package.json"), JSON.stringify({ name: "demo-plugin", version: "1.0.0", omp: { extensions: ["./ext.ts"] } }));
		await writeFile(join(plugins, "node_modules", "demo-plugin", "ext.ts"), "export default function ext(): void {}\n");

		const { warnings } = await launchHandoff(input(s, { withSession: false }, realClient()).input);

		expect(warnings).toEqual(["plugin demo-plugin is enabled here but not shipped; the cloud agent runs without it"]);
		expect((await shippedNames()).filter(n => n.includes("demo-plugin") || n.includes("ext.ts"))).toEqual([]);
	});

	test("a handoff commit that could not be signed is named in the launch warnings, and the handoff goes on", async () => {
		const s = await setup();
		const prog = join(await tmp("omp-cloud-gpg-"), "fake-gpg");
		await writeFile(prog, "#!/bin/sh\ncat >/dev/null\nexit 2\n", { mode: 0o755 });
		await git(s.repo, ["config", "commit.gpgsign", "true"]);
		await git(s.repo, ["config", "gpg.program", prog]);
		await writeFile(join(s.repo, "dirty.txt"), "uncommitted\n");

		const { warnings } = await launchHandoff(input(s, { withSession: false }, realClient()).input);

		expect(warnings.filter(w => w.startsWith("the handoff commit is unsigned: "))).toHaveLength(1);
		expect(uploads).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// (c) the conversation is a fork the local omp can unpack
// ---------------------------------------------------------------------------

describe("the uploaded conversation", () => {
	async function unpacked(toolCallId: string | undefined): Promise<{ entries: Record<string, unknown>[]; file: string; s: Setup }> {
		const { s } = await launch({ toolCallId });
		const part = only().files.conversation as File;
		expect(part.type).toBe("application/x-tar");
		const archive = await saved(part, "conversation.tar");
		const home = await ompHome();
		const { file } = await syncInto(home, archive, await tmp("omp-cloud-cwd-"));
		expect(file.startsWith(home.sessionsRoot + "/")).toBe(true);
		return { entries: parseEntries(await readFile(file, "utf8")), file, s };
	}

	test("omp session unpack accepts the archive: new session id, title and artifacts kept, cards and the pending tool call gone", async () => {
		const { entries, file, s } = await unpacked(CALL_ID);

		// the fixture is what the test claims: the session header is not the first line
		expect(s.session.original.split("\n")[0]).toContain('"type":"title"');

		const header = entries.find(e => e.type === "session");
		expect(header?.id).toBeString();
		expect(header?.id).not.toBe(OLD_ID);
		expect(header?.parentSession).toBe(s.session.file);
		expect(entries.find(e => e.type === "title")?.title).toBe("My task");

		expect(entries.some(e => e.type === "custom_message" && e.customType === "omp-cloud")).toBe(false);
		const ids = entries.map(e => e.id);
		expect(ids).toContain("e1");
		expect(ids).toContain("e2");
		expect(ids).not.toContain("a9");
		expect(entries.find(e => e.id === "e2")?.parentId).toBe("e1");

		expect(await readFile(join(file.replace(/\.jsonl$/, ""), "artifact.txt"), "utf8")).toBe("artifact bytes");
	});

	test("without a delegating tool call only the cards are dropped", async () => {
		const { entries } = await unpacked(undefined);
		expect(entries.some(e => e.customType === "omp-cloud")).toBe(false);
		expect(entries.map(e => e.id)).toContain("a9");
	});

	test("the owner's own session file and artifacts are untouched", async () => {
		const { s } = await launch({ toolCallId: CALL_ID });
		expect(await readFile(s.session.file, "utf8")).toBe(s.session.original);
		expect(await readFile(join(s.session.file.replace(/\.jsonl$/, ""), "artifact.txt"), "utf8")).toBe("artifact bytes");
	});
});

// ---------------------------------------------------------------------------
// (e) nothing is left in the temp dir
// ---------------------------------------------------------------------------

describe("temp dir", () => {
	/** A client that records what the handoff staged while the upload was in flight. */
	function spyClient(onUpload: (parts: HandoffParts) => Promise<void>, fail = false): LaunchClient {
		return {
			whoami: async () => whoami(),
			createThread: async parts => {
				await onUpload(parts);
				if (fail) throw new Error("service unavailable");
				return { summary: summary(), replayed: false };
			},
		};
	}

	test("the staged files exist under os.tmpdir() during the upload and are all gone after it", async () => {
		const s = await setup();
		const before = await readdir(scratch);
		let staged: string[] = [];
		const built = input(
			s,
			{},
			spyClient(async parts => {
				staged = [parts.source, parts.conversation, parts.setup].filter((p): p is string => p !== undefined);
				for (const p of staged) expect((await stat(p)).isFile()).toBe(true);
				expect((await leftovers(before)).length).toBe(1);
			}),
		);

		await launchHandoff(built.input);

		expect(staged).toHaveLength(3);
		for (const p of staged) expect(p.startsWith(scratch + "/omp-cloud-")).toBe(true);
		for (const p of staged) await expect(stat(p)).rejects.toThrow();
		expect(await leftovers(before)).toEqual([]);
	});

	test("an upload that fails still cleans up", async () => {
		const s = await setup();
		const before = await readdir(scratch);
		const built = input(s, {}, spyClient(async () => {}, true));
		await expect(launchHandoff(built.input)).rejects.toThrow("service unavailable");
		expect(await leftovers(before)).toEqual([]);
	});

	test("a snapshot that fails (not a git repository) still cleans up", async () => {
		const s = await setup();
		const notRepo = await tmp("omp-cloud-plain-");
		const before = await readdir(scratch);
		const built = input({ ...s, repo: notRepo }, {}, spyClient(async () => {}));
		await expect(launchHandoff(built.input)).rejects.toThrow("not a git repository");
		expect(await leftovers(before)).toEqual([]);
	});

	test("a successful handoff over HTTP leaves nothing behind", async () => {
		const s = await setup();
		const before = await readdir(scratch);
		const built = input(s, {}, realClient());
		await launchHandoff(built.input);
		expect(uploads).toHaveLength(1);
		expect(await leftovers(before)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Delta handoffs: the base fetch lives on the service, so the plugin ships what the remote lacks
// ---------------------------------------------------------------------------

describe("delta handoff", () => {
	const REMOTE = "http://git.example.test/app.git";

	/** The fixture repo with its `main` pushed to a bare "remote" (reached through insteadOf), a local commit on top and the dirty a.txt. */
	async function withRemote(): Promise<{ s: Setup; base: string; head: string }> {
		const s = await setup();
		const bare = join(await tmp("omp-cloud-bare-"), "origin.git");
		await git(s.repo, ["init", "-q", "--bare", "-b", "main", bare]);
		await git(s.repo, ["config", `url.${bare}.insteadOf`, REMOTE]);
		await git(s.repo, ["remote", "add", "origin", REMOTE]);
		await git(s.repo, ["push", "-q", "-u", "origin", "main"]);
		const base = await git(s.repo, ["rev-parse", "HEAD"]);
		const head = await commitFile(s.repo, "c.txt", "three\n");
		return { s, base, head };
	}

	/**
	 * A client whose `createThread` answers from `replies` in turn (an Error rejects) and records every upload. The launch
	 * removes its temp dir once it returns, so each recorded `source` is a copy the test owns.
	 */
	function client(gitHosts: string[], replies: (Error | null)[] = [null]): { client: LaunchClient; created: HandoffParts[] } {
		const created: HandoffParts[] = [];
		return {
			created,
			client: {
				whoami: async () => whoami({ modelPatterns: ["anthropic/*"], gitHosts }),
				createThread: async parts => {
					let source: string | undefined;
					if (parts.source !== undefined) {
						source = join(await tmp("sent-bundle-"), "source.bundle");
						await copyFile(parts.source, source);
					}
					created.push({ ...parts, source });
					const reply = replies[created.length - 1] ?? null;
					if (reply !== null) throw reply;
					return { summary: summary(), replayed: false };
				},
			},
		};
	}

	test("a remote on a host the service can fetch ships a thin bundle on top of the merge-base, and the card says so", async () => {
		const { s, base, head } = await withRemote();
		const c = client(["git.example.test"]);
		const result = await launchHandoff(input(s, {}, c.client).input);

		expect(c.created).toHaveLength(1);
		const sent = c.created[0] as HandoffParts;
		expect(sent.request.repo).toMatchObject({ remoteURL: REMOTE, baseRef: "main", baseCommit: base });
		expect(result.summary).toMatchObject({ base: base.slice(0, 8), commits: 1 });
		// The WIP commit sits on the local head, which sits on the base.
		const fresh = await tmp();
		await git(fresh, ["init", "-q"]);
		await expect(git(fresh, ["bundle", "verify", sent.source as string])).rejects.toThrow(/prerequisite/);
		await git(fresh, ["fetch", "-q", join(s.repo, ".git"), "main"]);
		await git(fresh, ["bundle", "verify", sent.source as string]);
		await git(fresh, ["fetch", "-q", sent.source as string, "refs/omp-cloud/handoff"]);
		expect(await git(fresh, ["rev-parse", "FETCH_HEAD^"])).toBe(head);
	});

	test("a clean handoff at the base sends no source part", async () => {
		const { s, base, head } = await withRemote();
		await git(s.repo, ["reset", "-q", "--hard", base]);
		const c = client(["git.example.test"]);
		await launchHandoff(input(s, {}, c.client).input);
		const sent = c.created[0] as HandoffParts;
		expect(sent.source).toBeUndefined();
		expect(sent.request.repo).toMatchObject({ baseCommit: base, handoffCommit: base });
		expect(head).not.toBe(base);
	});

	test("a host the service holds no credential for ships the whole history", async () => {
		const { s } = await withRemote();
		const c = client(["github.com"]);
		const result = await launchHandoff(input(s, {}, c.client).input);
		expect(repoOf(c.created[0] as HandoffParts).baseCommit).toBe("");
		expect(result.summary).toMatchObject({ base: "", commits: 3 });
	});

	test("a 409 saying the base is not on the remote retries once, as a full-history handoff", async () => {
		const { s, base } = await withRemote();
		const refusal = refused(409, `the base commit ${base} is not on ${REMOTE}`);
		const c = client(["git.example.test"], [refusal, null]);
		const result = await launchHandoff(input(s, {}, c.client).input);

		expect(c.created).toHaveLength(2);
		expect(repoOf(c.created[0] as HandoffParts).baseCommit).toBe(base);
		const retry = c.created[1] as HandoffParts;
		expect(repoOf(retry).baseCommit).toBe("");
		const fresh = await tmp();
		await git(fresh, ["init", "-q"]);
		await git(fresh, ["bundle", "verify", retry.source as string]);
		expect(result.summary).toMatchObject({ base: "", commits: 3 });
	});

	test("the retry sends every other part again and a handoff commit that matches its bundle", async () => {
		const { s, base } = await withRemote();
		const c = client(["git.example.test"], [refused(409, `the base commit ${base} is not on ${REMOTE}`), null]);
		await launchHandoff(input(s, {}, c.client).input);
		const [first, retry] = c.created as [HandoffParts, HandoffParts];
		expect(retry.setup).toBe(first.setup);
		expect(retry.conversation).toBe(first.conversation);
		expect(await git(s.repo, ["bundle", "list-heads", retry.source as string])).toBe(`${repoOf(retry).handoffCommit} refs/omp-cloud/handoff`);
	});

	test.each([
		["another 409", refused(409, "the cloud cannot run openai-codex models; log the cloud broker in with /cloud login openai-codex")],
		["a 400", refused(400, "the source part is required when the handoff has commits beyond the base")],
		["a 500", refused(500, "internal error")],
		["a network failure", new Error("cannot reach http://x: connection refused")],
	])("%s is not retried", async (_label, failure) => {
		const { s } = await withRemote();
		const c = client(["git.example.test"], [failure]);
		await expect(launchHandoff(input(s, {}, c.client).input)).rejects.toThrow(failure.message);
		expect(c.created).toHaveLength(1);
	});

	test("a full-history handoff that is refused is not retried either", async () => {
		const { s, base } = await withRemote();
		const c = client([], [refused(409, `the base commit ${base} is not on ${REMOTE}`)]);
		await expect(launchHandoff(input(s, {}, c.client).input)).rejects.toThrow("is not on");
		expect(c.created).toHaveLength(1);
	});

	test("a failed retry reports its own error and leaves nothing behind", async () => {
		const { s, base } = await withRemote();
		const before = await readdir(scratch);
		const c = client(["git.example.test"], [refused(409, `the base commit ${base} is not on ${REMOTE}`), refused(413, "upload is too large")]);
		await expect(launchHandoff(input(s, {}, c.client).input)).rejects.toThrow("upload is too large");
		expect(await leftovers(before)).toEqual([]);
	});
});

describe("thread name", () => {
	test("the generated name goes into the create request, cleaned, and the generator gets the task and a live signal", async () => {
		const asked: { task: string; signal: AbortSignal | undefined }[] = [];
		await launch({
			task: "make the retry queue survive redis restarts",
			generateTitle: async (task, _registry, _settings, _sessionId, _current, _metadata, _prompt, signal) => {
				asked.push({ task, signal });
				return '🔧 "Make retry queue survive restarts."';
			},
		});
		expect(only().request.name).toBe("Make retry queue survive restarts");
		expect(asked).toHaveLength(1);
		expect(asked[0]?.task).toBe("make the retry queue survive redis restarts");
	});

	test("naming runs while the snapshot is taken, not before or after it", async () => {
		// The generator answers only once the handoff has put something into its scratch directory: a handoff that named first would stall to the cap and send no name.
		await launch({
			generateTitle: async (_task, _registry, _settings, _sessionId, _current, _metadata, _prompt, signal) => {
				while (!signal?.aborted) {
					for (const dir of (await readdir(scratch)).filter(n => n.startsWith("omp-cloud-"))) {
						if ((await readdir(join(scratch, dir))).length > 0) return "Concurrent name";
					}
				}
				return null;
			},
		});
		expect(only().request.name).toBe("Concurrent name");
	});

	test.each([
		["null (a greeting, no title model)", async () => null],
		["a failure", async () => Promise.reject(new Error("no api key"))],
		["only glyphs", async () => "🔧"],
	])("%s sends no name and the handoff still succeeds", async (_label, generateTitle) => {
		const { result } = await launch({ generateTitle });
		expect(result.response.id).toBeDefined();
		expect(only().keys).toContain("request");
		expect(only().request).not.toHaveProperty("name");
	});

	test("a host without a model registry asks for no name", async () => {
		await launch();
		expect(only().request).not.toHaveProperty("name");
	});

	test("the generator's signal is aborted once the handoff ends, whether it succeeded or failed", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const generateTitle: TitleGenerator = async (_task, _registry, _settings, _sessionId, _current, _metadata, _prompt, signal) => {
			signals.push(signal);
			return "A name";
		};
		await launch({ generateTitle });
		expect(signals[0]?.aborted).toBe(true);

		const s = await setup();
		const failing: LaunchClient = {
			whoami: async () => whoami(),
			createThread: async () => {
				throw new Error("service unavailable");
			},
		};
		await expect(launchHandoff(input(s, { generateTitle }, failing).input)).rejects.toThrow("service unavailable");
		expect(signals[1]?.aborted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Batches: one snapshot, one create per task, idempotency, scratch, and per-task outcomes
// ---------------------------------------------------------------------------

describe("launchBatch", () => {
	const CAPS = ["threads.paging", "threads.meta", "threads.idempotency", "threads.scratch", "turns.reply", "events.json", "inspect", "messages.interrupt", "questions.meta"];

	interface Sent {
		parts: HandoffParts;
		options: CreateOptions;
	}

	interface BatchClient {
		client: Pick<CloudClient, "createThread" | "whoami" | "requireCapability">;
		sent: Sent[];
	}

	/** A service that answers every create with a thread of its own; `fail` fails the create of a prompt, `replay` answers one as found by its key, `gate` holds every create. */
	function batchClient(over: { capabilities?: string[]; fail?: Record<string, Error>; replay?: string[]; gate?: (n: number) => Promise<void> } = {}): BatchClient {
		const sent: Sent[] = [];
		const capabilities = over.capabilities ?? CAPS;
		return {
			sent,
			client: {
				whoami: async () => whoami({ modelPatterns: ["anthropic/*"], capabilities }),
				requireCapability: async capability => {
					if (!capabilities.includes(capability)) throw new CloudError({ code: "version_skew", message: `the cloud does not support ${capability}`, retriable: false, outcomeKnown: true, hint: "update the omp-cloud service (`omp-cloud update` for an installed service; `git pull`, then restart it, for a checkout)" });
				},
				createThread: async (parts, options = {}) => {
					sent.push({ parts, options });
					await over.gate?.(sent.length);
					const failure = over.fail?.[parts.request.prompt];
					if (failure) throw failure;
					const id = `thread${String(sent.length).padStart(6, "0")}`;
					return { summary: summary({ id, warnings: [] }), replayed: over.replay?.includes(parts.request.prompt) ?? false };
				},
			},
		};
	}

	interface BatchOptions extends LaunchOptions {
		origin?: "tool" | "user";
		context?: string;
		signal?: AbortSignal;
		onProgress?: LaunchBatchInput["onProgress"];
	}

	async function batch(s: Setup, c: BatchClient, tasks: LaunchBatchInput["tasks"], o: BatchOptions = {}) {
		const { input: built } = input(s, o, { whoami: async () => whoami(), createThread: async () => ({ summary: summary(), replayed: false }) });
		const { task: _task, client: _client, ...rest } = built;
		return launchBatch({ ...rest, client: c.client, tasks, origin: o.origin ?? "tool", sessionId: "sess-1", context: o.context, signal: o.signal, onProgress: o.onProgress });
	}

	/** The create a task made: creates run concurrently, so they are not in task order. */
	const sentFor = (c: BatchClient, prompt: string): Sent => {
		const found = c.sent.find(x => x.parts.request.prompt === prompt);
		if (!found) throw new Error(`no create for ${prompt}`);
		return found;
	};

	const ok = (o: LaunchOutcome | undefined): LaunchedThread => {
		if (!o?.ok) throw new Error(`expected a created thread, got ${o?.error.message}`);
		return o;
	};

	test("one snapshot, one conversation and one setup serve every task; each task still gets its own create", async () => {
		const s = await setup();
		const c = batchClient();
		const done = await batch(s, c, [{ task: "a" }, { task: "b" }, { task: "c" }], { origin: "tool", toolCallId: CALL_ID });
		expect(done.outcomes.map(o => o.ok)).toEqual([true, true, true]);
		expect(c.sent).toHaveLength(3);
		for (const part of ["source", "conversation", "setup"] as const) expect(new Set(c.sent.map(x => x.parts[part])).size).toBe(1);
		expect(c.sent.map(x => x.parts.request.prompt).sort()).toEqual(["a", "b", "c"]);
		expect(done.defaultWorkspace).toBe("repo");
	});

	test("creates run at most four at a time", async () => {
		const s = await setup();
		let inflight = 0;
		let peak = 0;
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const c = batchClient({
			gate: async n => {
				inflight++;
				peak = Math.max(peak, inflight);
				if (n === 4) reached.resolve();
				await release.promise;
				inflight--;
			},
		});
		const run = batch(s, c, Array.from({ length: 8 }, (_, i) => ({ task: `task ${i}` })), { withSession: false });
		await reached.promise;
		release.resolve();
		const done = await run;
		expect(done.outcomes.every(o => o.ok)).toBe(true);
		expect(c.sent).toHaveLength(8);
		expect(peak).toBe(4);
	});

	test("every create carries an idempotency key: the ref when given, else one derived from session, call and index; origin, session and ref are sent as the thread's", async () => {
		const s = await setup();
		const c = batchClient();
		await batch(s, c, [{ task: "a", ref: "bazel-port" }, { task: "b" }, { task: "c" }], { origin: "tool", toolCallId: CALL_ID, withSession: false });
		const keys = ["a", "b", "c"].map(p => sentFor(c, p).options.idempotencyKey);
		expect(keys[0]).toBe("bazel-port");
		expect(keys[1]).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
		expect(new Set(keys).size).toBe(3);
		expect(sentFor(c, "a").parts.request).toMatchObject({ origin: "tool", session: "sess-1", ref: "bazel-port" });
		expect(sentFor(c, "b").parts.request).not.toHaveProperty("ref");

		// The same call, session and index derive the same key: a repeat finds its thread.
		const again = batchClient();
		await batch(await setup(), again, [{ task: "a", ref: "bazel-port" }, { task: "b" }, { task: "c" }], { origin: "tool", toolCallId: CALL_ID, withSession: false });
		expect(["a", "b", "c"].map(p => sentFor(again, p).options.idempotencyKey)).toEqual(keys);
		const other = batchClient();
		await batch(await setup(), other, [{ task: "b" }], { origin: "tool", toolCallId: "call_other", withSession: false });
		expect(other.sent[0]?.options.idempotencyKey).not.toBe(keys[1]);
	});

	test("a service without the capability: the tool's delegation is refused as version_skew before anything is packed; a user's launch simply sends no key and no metadata", async () => {
		const s = await setup();
		const old = batchClient({ capabilities: [] });
		await expect(batch(s, old, [{ task: "a" }], { origin: "tool", withSession: false })).rejects.toMatchObject({ code: "version_skew" });
		expect(old.sent).toEqual([]);

		const user = batchClient({ capabilities: [] });
		const done = await batch(await setup(), user, [{ task: "a" }], { origin: "user", withSession: false });
		expect(ok(done.outcomes[0]).replayed).toBe(false);
		expect(user.sent[0]?.options.idempotencyKey).toBeUndefined();
		expect(user.sent[0]?.parts.request).not.toHaveProperty("origin");
		expect(user.sent[0]?.parts.request).not.toHaveProperty("session");
	});

	test("a create the service answers as replayed is surfaced as such, with the key it matched", async () => {
		const s = await setup();
		const c = batchClient({ replay: ["b"] });
		const done = await batch(s, c, [{ task: "a" }, { task: "b", ref: "known" }], { withSession: false });
		expect(ok(done.outcomes[0]).replayed).toBe(false);
		const replayed = ok(done.outcomes[1]);
		expect(replayed).toMatchObject({ replayed: true, key: "known" });
		expect(replayed.response.id).toBe("thread000002");
	});

	test("one failing task does not undo the others: each has its own outcome, in task order", async () => {
		const s = await setup();
		const down = new CloudError({ code: "unavailable", status: 503, message: "the service is starting", retriable: true, outcomeKnown: true });
		const c = batchClient({ fail: { b: down } });
		const done = await batch(s, c, [{ task: "a" }, { task: "b" }, { task: "c" }], { withSession: false });
		expect(done.outcomes.map(o => o.ok)).toEqual([true, false, true]);
		const failed = done.outcomes[1];
		if (failed?.ok !== false) throw new Error("task 2 should have failed");
		expect(failed.error).toBe(down);
		expect(failed.index).toBe(1);
		// The key the failed create carried: repeating the delegation with it as ref replays what the first attempt may have made.
		expect(failed.key).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
		expect(failed.key).toBe(sentFor(c, "b").options.idempotencyKey);
		expect(ok(done.outcomes[2]).index).toBe(2);
	});

	test("a key the service says made a thread for another request is a conflict in the model's terms: its own ref says to use another, a derived key says an earlier attempt holds it; neither offers a repeat", async () => {
		const s = await setup();
		const reused = (key: string) => new CloudError({ code: "conflict", status: 409, message: `Idempotency-Key ${key} was used for a different request (thread k3x9fa2m7q1z)`, retriable: false, outcomeKnown: true });
		const c = batchClient({ fail: { a: reused("bazel-port"), b: reused("omp-0123") } });
		const done = await batch(s, c, [{ task: "a", ref: "bazel-port" }, { task: "b" }, { task: "c" }], { origin: "tool", toolCallId: CALL_ID, withSession: false });
		const [a, b, other] = done.outcomes;
		if (a?.ok !== false || b?.ok !== false) throw new Error("tasks a and b should have failed");
		expect(a.error).toMatchObject({ code: "conflict", status: 409, retriable: false, outcomeKnown: true, message: 'ref "bazel-port" already names thread k3x9fa2m7q1z, which has a different task; use another ref (or none)' });
		expect(b.error.message).toBe("an earlier attempt of this call already made thread k3x9fa2m7q1z, which holds a different task");
		expect(a.key).toBeUndefined();
		expect(b.key).toBeUndefined();
		expect(other?.ok).toBe(true);
	});

	test("a task that cannot be planned fails alone, before any upload: bad ref, unknown policy key, bad thinking, a model the cloud cannot run, an over-long prompt, a pairing code", async () => {
		const s = await setup();
		const c = batchClient();
		const long = "x".repeat(32769);
		const done = await batch(s, c, [{ task: "fine" }, { task: "a", ref: "no spaces" }, { task: "b", policy: { nope: 1 } as never }, { task: "c", thinking: "wild" }, { task: "d", model: "openai-codex/gpt-5" }, { task: long }, { task: "ompc1:AAAA" }], { withSession: false });
		expect(done.outcomes[0]?.ok).toBe(true);
		const errors = done.outcomes.slice(1).map(o => (o?.ok === false ? o.error : undefined));
		expect(errors.map(e => e?.code)).toEqual(["invalid", "invalid", "invalid", "invalid", "too_large", "invalid"]);
		expect(errors[0]?.message).toContain('ref "no spaces"');
		expect(errors[1]?.message).toContain('policy key "nope"');
		expect(errors[3]?.message).toBe("the cloud cannot run openai-codex models yet: /cloud login openai-codex");
		expect(errors[4]?.message).toContain("limit is 32768");
		expect(c.sent.map(x => x.parts.request.prompt)).toEqual(["fine"]);
		expect(done.outcomes.slice(1).every(o => !o.ok && o.key === undefined)).toBe(true);
	});

	test("outside a git repository the default is scratch: an empty-repository request, no source part, said in the batch; an explicit repo there is refused", async () => {
		const s = await setup();
		const plain = await tmp("omp-cloud-plain-");
		const c = batchClient();
		const done = await batch({ ...s, repo: plain }, c, [{ task: "research" }, { task: "pinned", workspace: "repo" }], { withSession: false });
		expect(done.defaultWorkspace).toBe("scratch");
		const created = ok(done.outcomes[0]);
		expect(created.workspace).toBe("scratch");
		expect(created.summary).toMatchObject({ scratch: true, commits: 0, base: "" });
		const request = c.sent[0]?.parts.request;
		expect(request?.repo).toEqual({ scratch: true, name: "scratch" });
		expect(c.sent[0]?.parts.source).toBeUndefined();
		expect(request?.secretFiles).toEqual([]);
		expect(request?.paths.workspace).toBe(plain);
		const refused = done.outcomes[1];
		if (refused?.ok !== false) throw new Error("repo outside a repository should be refused");
		expect(refused.error.message).toContain("is not a git repository with at least one commit");
		expect(c.sent).toHaveLength(1);
	});

	test("inside a repository a task can still ask for scratch, and nothing of the repository ships for it; a batch can mix both", async () => {
		const s = await setup();
		const c = batchClient();
		const done = await batch(s, c, [{ task: "in repo" }, { task: "elsewhere", workspace: "scratch" }], { withSession: false });
		expect(done.outcomes.map(o => (o.ok ? o.workspace : "error"))).toEqual(["repo", "scratch"]);
		expect(sentFor(c, "in repo").parts.source).toBeDefined();
		expect(sentFor(c, "elsewhere").parts.source).toBeUndefined();
		expect(sentFor(c, "elsewhere").parts.request.repo).toEqual({ scratch: true, name: "scratch" });
	});

	test("conversation: none ships no conversation for that task; wip: false ships HEAD without the uncommitted work, beside a task that ships it", async () => {
		const s = await setup();
		const c = batchClient();
		const done = await batch(s, c, [{ task: "with" }, { task: "without", conversation: "none", wip: false }], {});
		const withAll = sentFor(c, "with");
		const without = sentFor(c, "without");
		expect(withAll?.parts.conversation).toBeDefined();
		expect(without?.parts.conversation).toBeUndefined();
		expect(ok(done.outcomes[1]).summary.conversation).toBe("none");
		const head = await git(s.repo, ["rev-parse", "HEAD"]);
		expect(repoOf(withAll.parts).handoffCommit).not.toBe(head);
		expect(repoOf(without.parts).handoffCommit).toBe(head);
		expect(ok(done.outcomes[1]).summary.wip).toEqual({ files: 0, insertions: 0, deletions: 0 });
		expect(ok(done.outcomes[0]).summary.wip.files).toBe(1);
	});

	test("the shared context is prepended to every task, model and thinking are the task's own or the session's, policy lays over the configuration's", async () => {
		const s = await setup();
		const cfg = await cloudConfig(s, { repo: "policy:\n  fetch: false\n  egress: [example.com]\n" });
		const c = batchClient();
		await batch(s, c, [{ task: "a", model: "anthropic/claude-opus-5:high", policy: { fetch: true, "spend.turnUSD": 2 } }, { task: "b", thinking: "low" }], { context: "House rules.", cfg, withSession: false, thinking: "medium" });
		const a = sentFor(c, "House rules.\n\na").parts.request;
		const b = sentFor(c, "House rules.\n\nb").parts.request;
		expect(a?.prompt).toBe("House rules.\n\na");
		expect(a).toMatchObject({ model: "anthropic/claude-opus-5", thinking: "high", policy: { fetch: true, egress: ["example.com"], "spend.turnUSD": 2 } });
		expect(b).toMatchObject({ model: "anthropic/claude-sonnet-5-5", thinking: "low", policy: { fetch: false, egress: ["example.com"] } });
	});

	test("the abort signal stops a create in flight: that task's outcome is `aborted` and the temp dir is cleaned", async () => {
		const s = await setup();
		const before = await readdir(scratch);
		const ctrl = new AbortController();
		const started = Promise.withResolvers<void>();
		const c = batchClient({
			gate: async () => {
				const cancelled = Promise.withResolvers<void>();
				ctrl.signal.addEventListener("abort", () => cancelled.reject(new CloudError({ code: "aborted", message: "the request was cancelled", retriable: false, outcomeKnown: true })), { once: true });
				started.resolve();
				await cancelled.promise;
			},
		});
		const run = batch(s, c, [{ task: "a" }], { signal: ctrl.signal, withSession: false });
		await started.promise;
		ctrl.abort();
		const done = await run;
		expect(done.outcomes[0]).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(await leftovers(before)).toEqual([]);
		await expect(batch(await setup(), batchClient(), [{ task: "x" }], { signal: ctrl.signal, withSession: false })).rejects.toMatchObject({ name: "AbortError" });
	});

	test("progress says when it packs and which task it uploads, with the client's retry notes", async () => {
		const s = await setup();
		const progress: unknown[] = [];
		const c = batchClient();
		const create = c.client.createThread.bind(c.client);
		c.client.createThread = async (parts, options) => {
			options?.onProgress?.("the service is starting; retrying in 0.5s (attempt 2 of 4)");
			return create(parts, options);
		};
		await batch(s, c, [{ task: "a" }, { task: "b" }], { withSession: false, onProgress: p => void progress.push(p) });
		expect(progress[0]).toEqual({ task: undefined, phase: "packing" });
		expect(progress).toContainEqual({ task: 0, phase: "uploading" });
		expect(progress).toContainEqual({ task: 1, phase: "uploading", note: "the service is starting; retrying in 0.5s (attempt 2 of 4)" });
	});

	test("an empty batch or one over eight tasks is refused outright", async () => {
		const s = await setup();
		await expect(batch(s, batchClient(), [], {})).rejects.toMatchObject({ code: "invalid" });
		await expect(batch(s, batchClient(), Array.from({ length: 9 }, () => ({ task: "x" })), {})).rejects.toMatchObject({ code: "invalid" });
	});
});
