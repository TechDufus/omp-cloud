import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asCard, cardContent, cardPlain, loadTui, type CardDetails } from "../src/cards";
import { run } from "../src/exec";
import { cloudJobId } from "../src/cloud-job";
import { originsFromEntries } from "../src/deliver";
import { git } from "../src/snapshot";
import { describeResult } from "../src/tool-view";
import { runTool, type ToolParams } from "../src/tool";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AnswerBody, HandoffRequest, ThreadDetail, ThreadResult, ThreadSummary } from "../src/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { Env } from "../src/config";
import { Cloud } from "../src/verbs";
import { detail, event, metrics, pending, question, summary, turn, whoami } from "./builders";
import { cloudEnv, fakeHost, fakePi, fakeSettings, until, type FakeHost, type FakePi } from "./fakes";
import { cleanup, commitFile, configureRepo, isolateOmp, remoteFixture, tmp, type Fixture } from "./helpers";

afterEach(cleanup);

const ID = "k3x9fa2m7q1z";
const SHORT = "2m7q1z";
const OTHER = "k3x9fbq8w4e5";
/** How the tests' thread reads in text: its title (it has no name) and its id. */
const TAG = `Add Greet · ${ID}`;

/** The body of an IRC message the plugin posts. */
interface IrcBody {
	id: string;
	from: string;
	body: string;
}

interface Req {
	method: string;
	path: string;
	json?: unknown;
	key?: string | null;
	parts?: Record<string, Blob | string>;
}

const noIrc = (_body: IrcBody): Response => Response.json({ error: "no irc in this test" }, { status: 500 });

const state = {
	reqs: [] as Req[],
	who: whoami(),
	listed: [] as ThreadSummary[],
	detail: detail(),
	bundle: undefined as string | undefined,
	stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
	created: summary(),
	irc: noIrc,
};

function reset(): void {
	state.reqs = [];
	state.who = whoami({
		user: "dev",
		modelPatterns: ["anthropic/*", "openai-codex/*"],
		defaultModel: "anthropic/claude-sonnet-5-5",
		vms: { running: 1, paused: 2 },
		threads: { starting: 0, working: 1, waiting: 1, idle: 3, failed: 0 },
		capabilities: ["threads.paging", "threads.meta", "threads.idempotency", "threads.scratch", "threads.subagent"],
	});
	state.listed = [summary({ id: ID, title: "Add Greet", phase: "waiting", question: pending({ turn: 1, id: 2, text: "Which database?" }) })];
	state.detail = detail({ id: ID, title: "Add Greet", phase: "idle", turns: [turn(1)] });
	state.bundle = undefined;
	state.created = summary({ id: ID, title: "Add Greet", phase: "starting", turns: 0, warnings: ["model x is not available; using y"] });
	state.irc = noIrc;
}

const sseBytes = new TextEncoder();
let server: Bun.Server<undefined>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const r: Req = { method: req.method, path: url.pathname };
			state.reqs.push(r);
			const p = url.pathname;
			const T = `/api/v1/threads/${ID}`;
			if (p === "/api/v1/whoami") return Response.json(state.who);
			if (req.method === "POST" && p === "/api/v1/threads") {
				r.parts = {};
				r.key = req.headers.get("Idempotency-Key");
				for (const [k, v] of (await req.formData()).entries()) r.parts[k] = v;
				return Response.json(state.created, { status: 201 });
			}
			if (req.method === "GET" && p === "/api/v1/threads") return Response.json({ threads: state.listed });
			if (req.method === "GET" && p === T) return Response.json(state.detail);
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
			if (req.method === "POST" && p === `${T}/irc`) {
				r.json = await req.json();
				return state.irc(r.json as IrcBody);
			}
			if (req.method === "POST" && p === `${T}/stop`) return Response.json({ stoppedRunning: true, cancelled: 2 });
			const answer = /^\/api\/v1\/threads\/[^/]+\/turns\/(\d+)\/questions\/(\d+)\/answer$/.exec(p);
			if (req.method === "POST" && answer) {
				r.json = await req.json();
				const body = r.json as AnswerBody;
				return Response.json(
					question({ id: Number(answer[2]), text: "Which database?", selected: body.selected ?? [], answer: body.answer ?? "", answeredAt: "2026-01-01T00:02:00Z" }),
				);
			}
			if (req.method === "GET" && p === `${T}/result`) {
				if (!state.bundle) return Response.json({ error: "no result yet" }, { status: 404 });
				return new Response(await readFile(state.bundle), { headers: { "X-Omp-Branch": `omp-cloud/${ID}`, "X-Omp-Head": "x", "X-Omp-Base": "y" } });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

beforeEach(reset);

/** Everything a test started, so afterEach can stop its watchers and streams. */
const live: { cloud: Cloud; host: FakeHost }[] = [];

afterEach(async () => {
	for (const { cloud, host } of live.splice(0)) {
		await cloud.handle("unwatch", host.host as never);
		// The agents it registered live in omp's process-wide registry: a later test file must not find them taken.
		cloud.shutdown();
	}
});

/** Sends one SSE message of the thread's event stream; waits until the plugin has connected. */
async function push(kind: string, seq: number): Promise<void> {
	await until(() => state.stream !== undefined);
	state.stream?.enqueue(sseBytes.encode(`id: ${seq}\ndata: ${JSON.stringify(event(seq, { kind, turn: 1 }))}\n\n`));
}

/** An omp agent dir of its own (so omp's extension discovery never reads the developer's) and the environment whose omp-cloud file points the plugin at the fake service. */
async function configured(cwd: string | undefined, deliver?: "transcript", entries?: unknown[]): Promise<{ agentDir: string; pi: FakePi; env: Env }> {
	const { agentDir } = await isolateOmp();
	const settings = await fakeSettings({ agentDir, cwd });
	const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\n${deliver ? `deliver: ${deliver}\n` : ""}`, { PI_CODING_AGENT_DIR: agentDir });
	return { agentDir, pi: fakePi({ settings, entries }), env };
}

interface SetupOptions {
	sessionFile?: string;
	mode?: string;
	fixture?: Fixture;
	cwd?: string;
	/** The personal file's `deliver`; the default (the tray) when absent. */
	deliver?: "transcript";
	hostOpts?: Parameters<typeof fakeHost>[0];
	/** The session's entries as a resumed session has them; what the plugin appends joins them, and the host reads them all. */
	entries?: unknown[];
}

async function setup(opts: SetupOptions = {}): Promise<{ f: Fixture | undefined; pi: FakePi; cloud: Cloud; host: FakeHost }> {
	const f = opts.cwd ? undefined : (opts.fixture ?? (await remoteFixture()));
	const { pi, env } = await configured(opts.cwd ?? f?.work, opts.deliver, opts.entries);
	const cloud = new Cloud(pi.pi, "/own", env);
	const host = fakeHost({ cwd: opts.cwd ?? f?.work, sessionFile: opts.sessionFile, mode: opts.mode, entries: pi.entries, ...opts.hostOpts });
	live.push({ cloud, host });
	return { f, pi, cloud, host };
}

const call = (cloud: Cloud, host: FakeHost, p: ToolParams, id = "call_1") => runTool({ cloud, ctx: host.host, toolCallId: id }, p);

const result = (over: Partial<ThreadResult> = {}): ThreadResult => ({
	branch: `omp-cloud/${ID}`,
	head: "0123456789abcdef",
	base: "main",
	filesChanged: 2,
	insertions: 5,
	deletions: 1,
	pushed: false,
	pushError: "denied",
	pushRef: "",
	updatedAt: "2026-01-01T00:03:00Z",
	...over,
});

describe("the cloud tool's pull against the API", () => {
	test("pull fetches the result branch into the local repository and reports it, with the identity of the repository checked", async () => {
		const f = await remoteFixture();
		const other = join(f.root, "other");
		await git(f.root, ["clone", "-q", f.bare, other]);
		await configureRepo(other);
		await git(other, ["checkout", "-q", "-b", `omp-cloud/${ID}`]);
		const head = await commitFile(other, "greet.txt", "hi\n");
		state.bundle = join(f.root, "result.bundle");
		await git(other, ["bundle", "create", state.bundle, `refs/heads/omp-cloud/${ID}`, `^${f.base}`]);
		const repo = { name: "app", remoteURL: "", baseRef: "main", baseCommit: "", handoffCommit: f.base, localBranch: "main" };
		state.detail = detail({ id: ID, repo, result: result({ head, filesChanged: 1, insertions: 1, deletions: 0, pushed: true, pushError: "", pushRef: `omp-cloud/${ID}` }) });

		const { cloud, host } = await setup({ fixture: f });
		const out = await call(cloud, host, { op: "pull", thread: SHORT });
		expect(out.content[0]?.text.split("\n")[0]).toBe(`cloud pull: ok fetched omp-cloud/${ID} @ ${head.slice(0, 8)} (+1 −0, 1 file)`);
		expect(out.content[0]?.text).toContain("working tree: not touched");
		expect(out.details).toMatchObject({ op: "pull", thread: ID, mode: "fetch", branch: `omp-cloud/${ID}`, head });
		expect(await git(f.work, ["rev-parse", `omp-cloud/${ID}`])).toBe(head);
		expect(await git(f.work, ["branch", "--show-current"])).toBe("main");

		state.bundle = undefined;
		const missing = await call(cloud, host, { op: "pull", thread: SHORT });
		expect(missing.content[0]?.text).toStartWith(`cloud pull: error not_found 404: ${ID} has no result yet`);
	});

	test("/cloud pull posts a card that says what came and how to take it, and puts nothing in a toast", async () => {
		const f = await remoteFixture();
		const other = join(f.root, "other");
		await git(f.root, ["clone", "-q", f.bare, other]);
		await configureRepo(other);
		await git(other, ["checkout", "-q", "-b", `omp-cloud/${ID}`]);
		await commitFile(other, "greet.txt", "hi\n", "docs: add greeting");
		const head = await commitFile(other, "bye.txt", "bye\n", "feat: add bye");
		state.bundle = join(f.root, "result.bundle");
		await git(other, ["bundle", "create", state.bundle, `refs/heads/omp-cloud/${ID}`, `^${f.base}`]);
		const repo = { name: "app", remoteURL: "", baseRef: "main", baseCommit: "", handoffCommit: f.base, localBranch: "main" };
		state.detail = detail({ id: ID, repo, result: result({ head, filesChanged: 2, insertions: 2, deletions: 0 }) });

		const { cloud, host, pi } = await setup({ fixture: f });
		await cloud.handle(`pull ${SHORT}`, host.host as never);

		expect(host.notes).toEqual([]);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.options).toEqual({ triggerTurn: false });
		const card = pi.sent[0]?.message.details as CardDetails;
		expect(card.kind).toBe("notice");
		const plain = cardPlain(card);
		expect(plain[0]).toBe(`Pulled omp-cloud/${ID} @ ${head.slice(0, 8)}`);
		expect(plain[1]).toBe("2 commits · +2 −0 · 2 files · working tree untouched");
		expect(plain[2]).toMatch(/^ {2}[0-9a-f]{7,} feat: add bye$/);
		expect(plain[3]).toMatch(/^ {2}[0-9a-f]{7,} docs: add greeting$/);
		expect(plain.at(-1)).toBe(`next: git merge --ff-only omp-cloud/${ID}`);
		// What the model reads is the same facts, with the cloud's commit subjects fenced as the cloud's words.
		expect(pi.sent[0]?.message.content).toStartWith(`[cloud] Pulled omp-cloud/${ID}`);
		expect(pi.sent[0]?.message.content).toContain("<cloud-output");
		expect(pi.sent[0]?.message.content).toContain("feat: add bye");
		expect(await git(f.work, ["branch", "--show-current"])).toBe("main");
	});

	test("the repository identity check is the model's: a thread from another clone is refused for the tool's pull unless forced, but /cloud pull, the hub and the card button take it as the user named it", async () => {
		const f = await remoteFixture();
		const other = join(f.root, "other");
		await git(f.root, ["clone", "-q", f.bare, other]);
		await configureRepo(other);
		await git(other, ["checkout", "-q", "-b", `omp-cloud/${ID}`]);
		const head = await commitFile(other, "greet.txt", "hi\n");
		state.bundle = join(f.root, "result.bundle");
		await git(other, ["bundle", "create", state.bundle, `refs/heads/omp-cloud/${ID}`, `^${f.base}`]);
		// Started in a clone whose WIP handoff commit this repository never had, on a fork's remote.
		const repo = { name: "app", remoteURL: "https://git.example.test/fork/app.git", baseRef: "main", baseCommit: "", handoffCommit: "d".repeat(40), localBranch: "main" };
		state.detail = detail({ id: ID, repo, result: result({ head, filesChanged: 1, insertions: 1, deletions: 0 }) });

		const { cloud, host, pi } = await setup({ fixture: f });
		const refused = await call(cloud, host, { op: "pull", thread: SHORT });
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toStartWith("cloud pull: error conflict: this repository");
		expect(refused.content[0]?.text).toContain("force: true");
		expect(await git(f.work, ["branch", "--list", `omp-cloud/${ID}`])).toBe("");

		await cloud.handle(`pull ${SHORT}`, host.host as never);
		expect(host.notes).toEqual([]);
		expect(pi.sent).toHaveLength(1);
		expect(await git(f.work, ["rev-parse", `omp-cloud/${ID}`])).toBe(head);

		await git(f.work, ["branch", "-D", `omp-cloud/${ID}`]);
		const forced = await call(cloud, host, { op: "pull", thread: SHORT, force: true });
		expect(forced.isError).toBeUndefined();
		expect(await git(f.work, ["rev-parse", `omp-cloud/${ID}`])).toBe(head);
	});

	test("pull outside a git repository is refused before anything is downloaded", async () => {
		const { cloud, host } = await setup({ cwd: await tmp("omp-cloud-nogit-") });
		const out = await call(cloud, host, { op: "pull", thread: SHORT });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toStartWith("cloud pull: error conflict: ");
		expect(out.content[0]?.text).toContain("not a git repository");
		expect(state.reqs.some(r => r.path.endsWith("/result"))).toBe(false);
	});
});

describe("delegation", () => {
	const OLD_ID = "0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

	async function sessionFile(): Promise<string> {
		const file = join(await tmp(), `2026-10-19T10-00-00-000Z_${OLD_ID}.jsonl`);
		const mk = (pad: string) => JSON.stringify({ type: "title", v: 1, title: "t", updatedAt: "2026-10-19T10:00:00.000Z", pad });
		const lines = [
			mk(" ".repeat(255 - mk("").length)),
			JSON.stringify({ type: "session", version: 3, id: OLD_ID, timestamp: "2026-10-19T10:00:00.000Z", cwd: "/work" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-10-19T10:00:01.000Z", message: { role: "user", content: "please delegate" } }),
			JSON.stringify({ type: "custom_message", id: "c1", parentId: "e1", customType: "omp-cloud", content: "[cloud] old", display: true, details: { kind: "turn" } }),
			JSON.stringify({ type: "message", id: "a1", parentId: "c1", timestamp: "2026-10-19T10:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_9", name: "cloud", arguments: { op: "delegate", task: "t" } }] } }),
		];
		await writeFile(file, `${lines.join("\n")}\n`);
		return file;
	}

	test("uploads the repository, the forked conversation without the pending call or cards and the setup, tags the thread as the tool's, and wakes the model with results", async () => {
		const { cloud, host, pi, f } = await setup({ sessionFile: await sessionFile() });
		if (!f) throw new Error("fixture expected");
		await writeFile(join(f.work, "untracked.txt"), "u\n");
		await writeFile(join(f.work, ".env.local"), "TOKEN=1\n");
		host.idle = false; // a tool runs while the agent streams
		state.detail = detail({ id: ID, phase: "working", turns: [turn(1, { state: "running" })] });

		const out = await call(cloud, host, { op: "delegate", task: "port the build to bazel", conversation: "full" }, "call_9");
		const lines = out.content[0]?.text.split("\n") ?? [];
		expect(lines[0]).toBe(`cloud delegate: ok started ${ID}`);
		expect(lines).toContain("workspace: repo by default (this directory is inside a git repository)");
		expect(lines).toContain(`task 1: agent \`${cloudJobId(state.detail)}\` (thread ${ID}) started`);
		expect(lines).toContain(`  branch: omp-cloud/${ID}`);
		expect(lines).toContain("  warnings: model x is not available; using y");
		expect(out.details).toMatchObject({ op: "delegate", defaultWorkspace: "repo", outcomes: [{ ok: true, index: 0, thread: ID, replayed: false, workspace: "repo", warnings: ["model x is not available; using y"] }] });

		const create = state.reqs.filter(r => r.method === "POST" && r.path === "/api/v1/threads");
		expect(create).toHaveLength(1);
		// The model check comes before the upload.
		expect(state.reqs.findIndex(r => r.path === "/api/v1/whoami")).toBeLessThan(state.reqs.indexOf(create[0] as Req));
		const parts = create[0]?.parts ?? {};
		expect(Object.keys(parts).sort()).toEqual(["conversation", "request", "setup", "source"]);
		const request = JSON.parse(await (parts.request as Blob).text()) as HandoffRequest;
		expect(create[0]?.key).toMatch(/^omp-[0-9a-f]{40}$/);
		expect(request).toMatchObject({
			origin: "tool",
			prompt: "port the build to bazel",
			model: "anthropic/claude-sonnet-5-5",
			thinking: "high",
			ompVersion: "18.12.3",
			configOverlays: [],
			repo: { baseCommit: "", localBranch: "main" },
		});

		// conversation: an `omp session pack` archive of the fork
		const archive = join(await tmp(), "conv.tar");
		await Bun.write(archive, parts.conversation as Blob);
		const session = await run("tar", ["-xOf", archive, "session.jsonl"]);
		expect(session.code).toBe(0);
		const entries = session.stdout
			.trimEnd()
			.split("\n")
			.map(l => JSON.parse(l) as { type: string; id?: string; parentSession?: string });
		const ids = entries.filter(e => e.type !== "title").map(e => e.id);
		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(OLD_ID);
		expect(ids[1]).toBe("e1");
		expect(session.stdout).not.toContain("call_9");
		expect(session.stdout).not.toContain("[cloud] old");

		// The delegate result is the record: no launch card is posted, even once the agent is idle again; the session wrote an entry at once, while the agent was busy.
		expect(pi.sent).toHaveLength(0);
		host.idle = true;
		cloud.flushCards(host.host);
		expect(pi.sent).toHaveLength(0);
		expect(pi.entries).toEqual([{ type: "custom", customType: "omp-cloud-thread", data: { thread: ID, origin: "tool" } }]);
		expect(lines).toContain("  left on this machine (credential-named): .env.local");
		expect(lines).toContain("  conversation: forked from this session");

		// The watcher follows the event stream; the finished turn reaches the model as a turn of its own.
		// The follow starts in the background: it has read the working thread and opened the stream before the turn ends.
		await until(() => state.stream !== undefined);
		state.detail = detail({ id: ID, phase: "idle", turns: [turn(1, { title: "Ported", reply: "Ported." })] });
		await push("turn_done", 1);
		await until(() => pi.sent.length === 1);
		expect(pi.sent[0]?.options).toEqual({ triggerTurn: true });
		expect(pi.sent[0]?.message.content).toContain(`[cloud] ${ID} turn 1 done\n`);
		expect(pi.sent.every(s => s.message.attribution === "agent")).toBe(true);
	});

	test("a model whose provider the cloud does not run is refused before anything is uploaded", async () => {
		state.who = { ...state.who, defaultModel: "" };
		const { cloud, host } = await setup({ hostOpts: { model: { provider: "google", id: "gemini-3" } } });
		const out = await call(cloud, host, { op: "delegate", task: "x" });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toStartWith("cloud delegate: error invalid: this cloud does not serve google/gemini-3");
		expect(state.reqs.some(r => r.method === "POST")).toBe(false);
	});

	test("help, list, show and watching an idle thread post cards instead of toasts and never touch the widget", async () => {
		state.detail = detail({ id: ID, title: "Add Greet", phase: "failed", error: "vm lost", turns: [turn(1, { state: "failed", error: "boom" }), turn(2, { reply: "All **done**." })] });
		const { cloud, host, pi } = await setup();
		for (const args of ["help", "list", `show ${SHORT}`]) await cloud.handle(args, host.host as never);
		expect(host.notes).toEqual([]);
		expect(pi.sent.map(s => (s.message.details as CardDetails).kind)).toEqual(["notice", "inventory", "notice"]);
		expect(pi.sent.every(s => s.options?.triggerTurn === false && s.message.attribution === "agent")).toBe(true);

		const help = pi.sent[0]?.message.details as CardDetails;
		expect(cardPlain(help).join("\n")).toContain("stop following threads live");
		expect(pi.sent[0]?.message.content).not.toContain("<cloud-output");

		const show = pi.sent[2]?.message.details as CardDetails;
		const plain = cardPlain(show);
		expect(plain[0]).toContain(ID);
		expect(plain[0]).toContain("failed");
		expect(plain[0]).toContain("Add Greet");
		expect(plain).toContain("error: vm lost");
		expect(plain).toContain("All **done**.");
		expect(cardContent(show)).toContain("<cloud-output");

		await cloud.handle(`watch ${SHORT}`, host.host as never);
		expect(host.notes).toEqual([]);
		expect(host.widgets).toEqual([]);
		const watched = pi.sent[3]?.message.details as CardDetails;
		expect(watched.kind).toBe("notice");
		expect(cardPlain(watched)).toEqual(plain);
	});

	test("with deliver: transcript a thread started with /cloud only displays its cards", async () => {
		const { cloud, host, pi } = await setup({ deliver: "transcript" });
		state.detail = detail({ id: ID, phase: "working", turns: [turn(1, { state: "running" })] });
		await cloud.handle("port the build", host.host as never);
		expect(host.notes).toEqual([["☁ Handing off to the cloud…", "info"]]);
		host.timeouts[0]?.();
		await until(() => host.notes.length >= 3);
		expect(host.notes[1]?.[0]).toBe(`☁ ${TAG} started — /cloud watch ${SHORT}`);
		expect(host.notes[2]?.[0]).toBe("☁ model x is not available; using y");
		await until(() => pi.sent.length === 1);
		expect(pi.sent[0]?.options).toEqual({ triggerTurn: false });
		expect((pi.sent[0]?.message.details as CardDetails).origin).toBe("user");
		// The user's thread is recorded by its card: no `omp-cloud-thread` entry.
		expect(pi.entries).toEqual([]);

		// The follow starts in the background: it has read the working thread and opened the stream before the turn ends.
		await until(() => state.stream !== undefined);
		state.detail = detail({ id: ID, phase: "idle", turns: [turn(1, { title: "Done" })] });
		await push("turn_done", 1);
		await until(() => pi.sent.length === 2);
		expect(pi.sent.map(s => s.options)).toEqual([{ triggerTurn: false }, { triggerTurn: false }]);
	});
});

describe("/cloud verbs sharing the tool's thread resolution", () => {
	test("without an overlay-capable UI, /cloud posts an inventory card", async () => {
		for (const mode of ["rpc", undefined]) {
			const { cloud, host, pi } = await setup({ mode });
			await cloud.handle("", host.host as never);
			expect(pi.sent).toHaveLength(1);
			expect((pi.sent[0]?.message.details as CardDetails).kind).toBe("inventory");
			expect(pi.sent[0]?.message.content).toContain("[cloud] runs anthropic, openai-codex models;");
			expect(pi.sent[0]?.message.content).toContain("VMs 1 running, 2 paused;");
			expect(pi.sent[0]?.message.content).toContain(`${SHORT} waiting`);
		}
	});

	test("in a TUI the hub opens as an overlay; its action runs, then the hub reopens until closed", async () => {
		const tui = await loadTui();
		if (!tui) throw new Error("the host pi-tui is required");
		const script = [["s"], ["q"]];
		const opened: unknown[] = [];
		const custom = (async (factory: (...a: unknown[]) => unknown, options: unknown) => {
			opened.push(options);
			const { promise, resolve } = Promise.withResolvers<unknown>();
			const hub = (await factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve)) as {
				refresh(): Promise<void>;
				handleInput(d: string): void;
				dispose(): void;
			};
			await hub.refresh();
			// The first hub asks to send to the selected thread; the reopened one is closed.
			for (const key of script.shift() ?? ["q"]) hub.handleInput(key);
			const result = await promise;
			hub.dispose();
			return result;
		}) as never;
		const { cloud, host, pi } = await setup({
			mode: "tui",
			hostOpts: { custom, input: async () => "ship it", confirm: true },
		});
		cloud.setTui(tui);
		await cloud.handle("", host.host as never);

		expect(opened).toHaveLength(2);
		expect(opened[0]).toMatchObject({ overlay: true });
		const msg = state.reqs.find(r => r.path === `/api/v1/threads/${ID}/messages`);
		expect(msg?.json).toEqual({ text: "ship it" });
		expect(host.notes.map(n => n[0])).toContain(`☁ queued turn 3 on ${TAG}`);
		expect(pi.sent).toHaveLength(0);
	});

	test("a host that never builds the overlay falls back to the inventory card", async () => {
		const tui = await loadTui();
		const { cloud, host, pi } = await setup({ mode: "tui", hostOpts: { custom: (async () => undefined) as never } });
		cloud.setTui(tui);
		await cloud.handle("", host.host as never);
		expect((pi.sent[0]?.message.details as CardDetails).kind).toBe("inventory");
	});

	test("/cloud answer with text selects a matching option, anything else is free text", async () => {
		state.detail = detail({
			id: ID,
			phase: "idle",
			turns: [turn(1, { state: "running", questions: [question({ id: 2, text: "Which database?", options: [{ label: "postgres", description: "" }, { label: "sqlite", description: "" }] })] })],
		});
		const { cloud, host } = await setup();
		await cloud.handle("answer k3x9fa SQLite", host.host as never);
		await cloud.handle("answer k3x9fa the one in staging", host.host as never);
		const answers = state.reqs.filter(r => r.path.endsWith("/answer"));
		expect(answers.map(r => r.path)).toEqual([`/api/v1/threads/${ID}/turns/1/questions/2/answer`, `/api/v1/threads/${ID}/turns/1/questions/2/answer`]);
		expect(answers.map(r => r.json)).toEqual([{ selected: ["sqlite"] }, { answer: "the one in staging" }]);
		expect(host.notes.filter(n => n[0].startsWith("☁ answered"))).toHaveLength(2);
	});

	test("/cloud send, show and completion know the thread's name; an archived thread says it restores first", async () => {
		state.listed = [summary({ id: ID, name: "Fix greeting bug", title: "Add Greet" })];
		state.detail = detail({
			id: ID,
			name: "Fix greeting bug",
			title: "Add Greet",
			phase: "idle",
			archivedAt: "2026-02-01T00:00:00Z",
			turns: [turn(1)],
			metrics: metrics({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.42 }, requests: 7, tools: 12, context: { tokens: 19000, window: 200000, at: "x" } }),
		});
		const { cloud, host, pi } = await setup();

		await cloud.handle("send greeting more work", host.host as never);
		expect(host.notes.map(n => n[0])).toEqual([
			`☁ Fix greeting bug · ${ID} is archived: its VM restores from the archive first (about a minute)`,
			`☁ queued turn 3 on Fix greeting bug · ${ID}`,
		]);
		expect(state.reqs.find(r => r.path === `/api/v1/threads/${ID}/messages`)?.json).toEqual({ text: "more work" });

		await cloud.handle("show greeting", host.host as never);
		const plain = cardPlain(pi.sent[0]?.message.details as CardDetails);
		expect(plain[0]).toBe(`Fix greeting bug · ${ID} · archived · 1 turn · anthropic/claude-sonnet-5-5`);
		expect(plain).toContain("Add Greet");
		expect(plain).toContain("context 19K / 200K · $0.42 · 7 requests · 12 tool calls");

		expect(cloud.complete("show ")).toEqual([{ value: `show ${ID}`, label: ID, description: "Fix greeting bug" }]);
		expect(cloud.complete("send gree")).toEqual([{ value: `send ${ID}`, label: ID, description: "Fix greeting bug" }]);
	});
});

describe("native views against the API", () => {
	const FINAL = { isPartial: false } as const;

	function nodes(view: NativeToolView | undefined): NativeNode[] {
		const out: NativeNode[] = [];
		const visit = (n: NativeNode): void => {
			out.push(n);
			for (const c of n.c ?? []) if ("k" in c) visit(c);
		};
		for (const c of view?.body ?? []) if ("k" in c) visit(c);
		return out;
	}

	test("status and list of a thread are omp job tiles, never rows, drawn from what the service sent", async () => {
		state.detail = detail({
			id: ID,
			title: "Add Greet",
			phase: "working",
			turns: [turn(1, { state: "running" })],
			activity: { kind: "tool", text: "bash: bun test", at: "2026-01-01T00:01:00Z" },
			metrics: metrics({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.42 }, requests: 7, tools: 12, context: { tokens: 19000, window: 200000, at: "x" } }),
		});
		state.listed = [summary({ id: ID, title: "Add Greet", phase: "working" })];
		const { cloud, host } = await setup();

		const status = describeResult(await call(cloud, host, { op: "status", thread: ID }), FINAL);
		expect(status?.head).toEqual([{ t: "waiting on 1 job", s: "toolTitle strong" }]);
		expect(status?.tone).toBe("info");
		const roles = nodes(status).flatMap(n => (typeof n.p?.role === "string" ? [n.p.role] : []));
		expect(roles).toEqual(expect.arrayContaining(["omp.job.tiles", "omp.job.tile"]));
		expect(nodes(status).filter(n => n.k === "rows")).toEqual([]);
		expect(JSON.stringify(status?.body)).toContain("bash: bun test");

		const listed = describeResult(await call(cloud, host, { op: "list" }), FINAL);
		expect(nodes(listed).filter(n => n.k === "rows")).toEqual([]);
		expect(nodes(listed).some(n => n.p?.role === "omp.job.tile")).toBe(true);
	});
});

describe("the hub as native nodes in a TUI", () => {
	test("its description lists the threads, and a button of it closes it with the action the key would", async () => {
		const tui = await loadTui();
		if (!tui) throw new Error("the host pi-tui is required");
		let described: NativeNode | undefined;
		const custom = (async (factory: (...a: unknown[]) => unknown) => {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			const hub = (await factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve)) as {
				refresh(): Promise<void>;
				describe(cx: DescribeContext): NativeNode;
				handleNativeEvent(e: NativeUiEvent): void;
				dispose(): void;
			};
			await hub.refresh();
			described = hub.describe({ cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => false });
			hub.handleNativeEvent({ type: "action", key: "actions/close", act: "close", mods: [] });
			const result = await promise;
			hub.dispose();
			return result;
		}) as never;
		const { cloud, host } = await setup({ mode: "tui", hostOpts: { custom } });
		cloud.setTui(tui);
		await cloud.handle("", host.host as never);
		expect(described?.p?.role).toBe("omp.cloud.hub");
		expect(JSON.stringify(described)).toContain(ID);
	});
});

describe("choosing a cloud through the tool", () => {
	const TARGET_ENTRY = "omp-cloud-target";
	const text = (out: Awaited<ReturnType<typeof call>>): string => out.content[0]?.text ?? "";

	/** The cloud the personal file names: it answers whoami and nothing else. */
	let personal: Bun.Server<undefined>;
	beforeAll(() => {
		personal = Bun.serve({ port: 0, fetch: req => (new URL(req.url).pathname === "/api/v1/whoami" ? Response.json(whoami({ user: "other" })) : Response.json({ error: "not found" }, { status: 404 })) });
	});
	afterAll(() => personal.stop(true));

	/** The environment names the fake service (`OMP_CLOUD_URL`); the personal file names `personal`. Both known, the environment the default. */
	async function twoClouds(hostOpts: Parameters<typeof fakeHost>[0] = {}): Promise<{ cloud: Cloud; host: FakeHost; pi: FakePi; file: string }> {
		const f = await remoteFixture();
		const { agentDir } = await isolateOmp();
		const settings = await fakeSettings({ agentDir, cwd: f.work });
		const env = await cloudEnv(`url: http://127.0.0.1:${personal.port}\ntoken: other\n`, { PI_CODING_AGENT_DIR: agentDir, OMP_CLOUD_URL: `http://127.0.0.1:${server.port}`, OMP_CLOUD_TOKEN: "tok" });
		const pi = fakePi({ settings });
		const cloud = new Cloud(pi.pi, "/own", env);
		const host = fakeHost({ cwd: f.work, entries: pi.entries, ...hostOpts });
		live.push({ cloud, host });
		return { cloud, host, pi, file: join(env.XDG_CONFIG_HOME ?? "", "omp-cloud", "connection.json") };
	}

	test("info lists both clouds, the environment's the default; use refuses once the session has a thread, and picks the other before that, recording the choice in the session", async () => {
		const { cloud, host, pi } = await twoClouds();
		const info = text(await call(cloud, host, { op: "info" }));
		expect(info).toContain(`cloud: env · http://127.0.0.1:${server.port} · the default (OMP_CLOUD_URL is set)`);
		expect(info).toContain(`other clouds: personal http://127.0.0.1:${personal.port} (url in `);

		const started = await call(cloud, host, { op: "delegate", task: "x", workspace: "scratch" });
		expect(started.isError).toBeUndefined();
		const refused = await call(cloud, host, { op: "use", cloud: "personal" });
		expect(refused.isError).toBe(true);
		expect(text(refused)).toStartWith("cloud use: error conflict: this session already works with 1 cloud thread (");
		expect(pi.entries).toEqual([{ type: "custom", customType: "omp-cloud-thread", data: { thread: ID, origin: "tool" } }]);

		// A session that has started nothing may pick the other cloud; the pick is the session's own.
		const fresh = await twoClouds();
		const picked = await call(fresh.cloud, fresh.host, { op: "use", cloud: "personal" });
		expect(text(picked).split("\n")[0]).toBe("cloud use: ok personal");
		expect(fresh.pi.entries).toEqual([{ type: "custom", customType: TARGET_ENTRY, data: { cloud: "personal" } }]);
		expect(picked.details).toMatchObject({ op: "use", cloud: "personal", url: `http://127.0.0.1:${personal.port}` });
		// It is in use now: info reaches the personal cloud, and says the session chose it.
		const after = await call(fresh.cloud, fresh.host, { op: "info" });
		expect(after.isError).toBeUndefined();
		expect(text(after)).toContain(`cloud: personal · http://127.0.0.1:${personal.port} · this session's choice`);
		expect(text(after)).toContain("you: the owner, with the server's owner token (full access)");
	});

	test("the choice follows the session: a later omp session of this one reads it back from its entries", async () => {
		const first = await twoClouds();
		await call(first.cloud, first.host, { op: "use", cloud: "personal" });
		const resumed = await twoClouds({ entries: first.pi.entries });
		const info = await call(resumed.cloud, resumed.host, { op: "info" });
		expect(text(info)).toContain(`cloud: personal · http://127.0.0.1:${personal.port} · this session's choice`);
	});

	test("use of a cloud this machine lacks is invalid and changes nothing", async () => {
		const { cloud, host, pi } = await twoClouds();
		const out = await call(cloud, host, { op: "use", cloud: "paired" });
		expect(out.isError).toBe(true);
		expect(text(out)).toStartWith("cloud use: error invalid: no usable paired cloud on this machine");
		expect(pi.entries).toEqual([]);
	});

	test("connect asks the user in a dialog; a refusal is forbidden and writes no pairing", async () => {
		const { cloud, host, file } = await twoClouds({ confirm: false });
		const out = await call(cloud, host, { op: "connect", target: "dev@omp.example" });
		expect(out.isError).toBe(true);
		expect(text(out)).toStartWith("cloud connect: error forbidden");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	test("with nothing configured info is not_configured, says so, and names connect as the way forward", async () => {
		const { agentDir } = await isolateOmp();
		const env = await cloudEnv(undefined, { PI_CODING_AGENT_DIR: agentDir });
		const pi = fakePi({ settings: await fakeSettings({ agentDir, cwd: undefined }) });
		const cloud = new Cloud(pi.pi, "/own", env);
		const host = fakeHost({ cwd: "/x" });
		live.push({ cloud, host });
		const out = await call(cloud, host, { op: "info" });
		expect(out.isError).toBe(true);
		expect(text(out)).toStartWith("cloud info: error not_configured");
		expect(text(out)).toContain("cloud connect {target} pairs it");
		expect(text(out)).toContain("cloud: none configured on this machine");
	});
});

describe("how a model's agent reaches it: one delivery for each turn", () => {
	/** The main agent's session as the IRC relay sees it: every message delivered to it is recorded. */
	class FakeMain {
		readonly delivered: IrcMessage[] = [];

		async deliverIrcMessage(msg: IrcMessage): Promise<"injected"> {
			this.delivered.push(msg);
			return "injected";
		}
	}

	let main: FakeMain;
	let manager: AsyncJobManager;
	/** What omp's own result delivery handed the model: the text of each job that finished. */
	let results: string[];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		main = new FakeMain();
		AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: main as unknown as AgentSession, status: "running" });
		manager = new AsyncJobManager({ retentionMs: 60_000, consumedResultEvictionMs: 60_000 });
		results = [];
		manager.registerDeliverySink("Main", (_id, text) => void results.push(text));
		AsyncJobManager.setInstance(manager);
		state.who = { ...state.who, capabilities: [...state.who.capabilities, "threads.irc"] };
	});

	afterEach(async () => {
		AsyncJobManager.resetForTests();
		await manager.dispose({ timeoutMs: 200 });
		AgentRegistry.global().unregister("Main");
	});

	/** One lifecycle event of turn `turnId` on the thread's event stream. */
	async function pushTurn(kind: string, seq: number, turnId: number): Promise<void> {
		await until(() => state.stream !== undefined);
		state.stream?.enqueue(sseBytes.encode(`id: ${seq}\ndata: ${JSON.stringify(event(seq, { kind, turn: turnId }))}\n\n`));
	}

	const cardsOf = (pi: FakePi, kind: string, turnId: number) => pi.sent.map(s => asCard(s.message.details)).filter(c => c?.kind === kind && "turn" in c && c.turn === turnId);

	test("a model's delegation posts no launch card, and the session writes an entry that names the thread at once", async () => {
		state.detail = detail({ id: ID, phase: "working", turns: [turn(1, { state: "running", completedAt: "" })] });
		const { cloud, host, pi } = await setup({ cwd: await tmp("omp-cloud-wd-") });
		host.idle = false;
		const started = await call(cloud, host, { op: "delegate", task: "fix it", workspace: "scratch" });
		expect(started.isError).toBeUndefined();
		host.idle = true;
		cloud.flushCards(host.host);

		expect(pi.sent).toEqual([]);
		expect(pi.entries).toEqual([{ type: "custom", customType: "omp-cloud-thread", data: { thread: ID, origin: "tool" } }]);
		expect(originsFromEntries(pi.entries).get(ID)).toBe("tool");
		// A delegation this session repeats (the service answers the same thread) records it once.
		await call(cloud, host, { op: "delegate", task: "fix it", workspace: "scratch" });
		expect(pi.entries).toHaveLength(1);
	});

	test("a session resumed with only the entry follows the thread as the model's", async () => {
		state.listed = [summary({ id: ID, phase: "working" })];
		state.detail = detail({ id: ID, phase: "working", turns: [turn(1, { state: "running", completedAt: "" })] });
		const { cloud, host } = await setup({ cwd: await tmp("omp-cloud-wd-"), entries: [{ type: "custom", customType: "omp-cloud-thread", data: { thread: ID, origin: "tool" } }] });
		await cloud.followSession(host.host);
		expect(cloud.followState(ID)).toMatchObject({ followed: true, origin: "tool" });
	});

	test("a turn an IRC message woke reaches the model once: the wake relay, and no turn card", async () => {
		state.detail = detail({ id: ID, phase: "working", turns: [turn(1, { state: "running", completedAt: "" })] });
		const { cloud, host, pi } = await setup({ cwd: await tmp("omp-cloud-wd-") });
		expect((await call(cloud, host, { op: "delegate", task: "fix it", workspace: "scratch" })).isError).toBeUndefined();

		// The first turn ends; the thread is idle and the watcher lets it go.
		await until(() => state.stream !== undefined);
		const first = turn(1, { reply: "First." });
		state.detail = detail({ id: ID, phase: "idle", turns: [first] });
		await pushTurn("turn_done", 1, 1);
		await until(() => !cloud.followState(ID).followed);

		// The model wakes it with a message; the service queues the turn the message started.
		let ircId = "";
		state.irc = body => {
			ircId = body.id;
			const woken = { text: body.body, origin: "irc" as const, ircFrom: body.from, ircId: body.id };
			state.detail = detail({ id: ID, phase: "working", turns: [first, turn(2, { ...woken, state: "running", completedAt: "" })] });
			return Response.json({ receipt: "woken", id: body.id, turn: turn(2, { ...woken, state: "queued", completedAt: "" }) }, { status: 201 });
		};
		const sent = await call(cloud, host, { op: "send", thread: ID, text: "also the farewell" });
		expect(sent.isError).toBeUndefined();
		expect(sent.content[0]?.text).toContain("woken");

		await until(() => cloud.jobOf(ID) !== undefined);
		const wokenJob = cloud.jobOf(ID) ?? "";
		state.detail = detail({ id: ID, phase: "idle", turns: [first, turn(2, { text: "also the farewell", reply: "Second.", origin: "irc", ircFrom: "Main", ircId })] });
		await pushTurn("turn_done", 2, 2);
		await until(() => main.delivered.length === 1);
		await until(() => !cloud.followState(ID).followed);
		await manager.drainDeliveries({ timeoutMs: 500 });

		// The report of the woken turn is the wake relay, once: no turn card, nothing from omp's own result delivery, and a wait on its job gets a pointer.
		expect(main.delivered[0]).toMatchObject({ to: "Main", replyTo: ircId, wakeRelay: true });
		expect(main.delivered[0]?.body).toContain("Second.");
		expect(cardsOf(pi, "turn", 2)).toEqual([]);
		expect(results).toHaveLength(1);
		const woken = manager.getJob(wokenJob);
		expect(woken?.resultText).toContain("Its reply was delivered to you as an incoming message");
		expect(woken?.resultText).not.toContain("Second.");
		// The first turn, which no message woke, keeps its one delivery: omp's own result, with no card.
		expect(results[0]).toContain("First.");
		expect(cardsOf(pi, "turn", 1)).toEqual([]);
	});
});
