/**
 * `mise run parity:capture`: how close omp-cloud's surfaces are to omp's own, measured in one scripted session on a real omp.
 *
 * The session (fake model, isolated agent dir, the plugin linked from the repository, a throwaway omp-cloud service on the
 * local vmon): a native background bash job and a native `task` subagent start, a cloud task is handed off, `/jobs` opens,
 * omp's `wait` blocks on all three, the cloud agent asks a question (question card), finishes turns (turn cards), and the
 * `/cloud` hub opens. It runs twice, once per renderer, because omp draws one or the other:
 *
 *  native  a pty that speaks the terminal half of the Tern Surface Protocol (tmux swallows APC, so tmux cannot): omp records
 *          every message (`PI_TUI_TSP_RECORD`) and counts fallbacks (`PI_TUI_NATIVE_STATS=1`, read back from omp's log). The
 *          record is replayed through omp's own reference applier (`TspDocument`): (a) every `rows` node with the component
 *          it came from (the goal is zero from omp-cloud); (b) the job tiles and `/jobs` widgets of the cloud job against the
 *          native bash job's and subagent's, per surface (the wait card, the jobs pill's hovercard, the `/jobs` sheet, the
 *          cloud hub), by `omp.job.*` role and node kind. The native bash job carries a widget spec the fake model writes
 *          for omp's job-widget author (headline, step dots, meter, stat line, stage), so native tiles are fully drawn.
 *  ansi    tmux with `PI_TUI_NATIVE=0`: omp's classic renderer; (c) `tmux capture-pane -e` of the launch card, `/jobs` (each
 *          job), the wait view, the turn, question and answered cards and the hub, for side-by-side review.
 *
 * The service runs from a snapshot of the committed tree (`git archive HEAD`), so another slice's half-edited `src/` cannot
 * stop it; the plugin under test is always the working tree's.
 *
 * Files land in `/tmp/parity/`: `native/record.jsonl` (the TSP record), `native/<step>.json` (surface documents at each
 * step), `ansi/<step>.ansi` (with colour) and `.txt`, `model-requests.log`, `summary.json`. Stdout ends with the summary
 * table. Exit code 0 when the run completes (baseline numbers); `--assert` makes rows from omp-cloud, or a required surface
 * where the cloud job's view lacks a role (see `REQUIRED_CLOUD_ROLES` in tsp.ts), a failure.
 *
 * Flags: `--only native|ansi`, `--no-cloud` (native jobs only: no service, no VM), `--assert`, `--plugin head` (the committed
 * plugin: the baseline before any slice), `--live-service` (the service from the working tree), `--out <dir>`.
 * Fake model only; no subscription is used. It writes the shared gateway clients file like `test/scenario.ts`; every such run
 * (`scenario`, `plugin:scenario`, `update:scenario`, `install:scenario` and this) takes the one lock `test/run-lock.ts` and refuses while another holds it.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "e2b";
import { cloudJobId } from "../../plugin/src/cloud-job";
import { GatewayClients } from "../../src/gateway/clients";
import { isRecord } from "../../src/guards";
import { hostOmp, pathWithoutNodeBin } from "../../src/omp-version";
import { CONFIG_YAML, MODEL, modelsYaml } from "../../test/fake-provider";
import { type GitHttpServer, serveGitHttp } from "../../test/git-http";
import { Report, StepFailed } from "../../test/report";
import { acquireRunLock } from "../../test/run-lock";
import { CLOUD_AGENT_ID, CLOUD_BG_LABEL, type ParityProvider, startParityProvider, WAITED_DONE, JOBS_DONE } from "./provider";
import { FakeTern, type KeyName, TmuxTerminal, type Terminal } from "./terminal";
import { checkJobsChildren } from "./children";
import { analyze, checkJobsTail, checkSubagentStrip, printSummary, parseStats, type Summary } from "./summary";
import { isCloudText, parseRecord, replay, stripAnsi } from "./tsp";

const REPO_ROOT = join(import.meta.dir, "..", "..");
/** The plugin omp loads: the working tree's, unless `--plugin head`. */
let pluginEntry = join(REPO_ROOT, "plugin", "src", "index.ts");
const VMON_URL = "http://127.0.0.1:3000";
const VMON_KEY_FILE = join(homedir(), ".config", "omp-cloud", "vmon.key");
const PROVIDER_HOST = "10.254.254.1";
const GATEWAY_URL = `http://${PROVIDER_HOST}:4000`;
const CLIENTS_FILE = join(homedir(), ".local", "share", "omp-cloud", "auth-home", "clients.json");
const BROKER_URL = "http://127.0.0.1:8765";
const BROKER_TOKEN_FILE = join(homedir(), ".local", "share", "omp-cloud", "auth-home", ".omp", "auth-broker.token");
const COLS = 140;
const ROWS = 50;
/** The cloud agent's first task: the scripted `TAIL:` turn (provider.ts), about two minutes of bash calls and assistant lines, long enough to span the `/jobs` sheets and the wait view. */
const CLOUD_TASK = "TAIL: three steps, an assistant line before each";
/** The cloud agent's second message: it asks, the harness answers through the API. */
const CLOUD_ASK = "ASK: pick a color";

interface Options {
	only: "native" | "ansi" | undefined;
	cloud: boolean;
	assert: boolean;
	/** Run the service from the working tree rather than a snapshot of HEAD. */
	liveService: boolean;
	/** The plugin under test: the working tree's, or the committed one (the baseline before any slice). */
	plugin: "work" | "head";
	/** A quick pass for the registry-ref checks: handoff, `/jobs`, the Agent Hub, the session switches, exit. */
	stopAfterHub: boolean;
	out: string;
}

function parseArgs(argv: string[]): Options {
	const options: Options = { only: undefined, cloud: true, assert: false, liveService: false, stopAfterHub: false, plugin: "work", out: "/tmp/parity" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--no-cloud") options.cloud = false;
		else if (arg === "--assert") options.assert = true;
		else if (arg === "--live-service") options.liveService = true;
		else if (arg === "--stop-after-hub") options.stopAfterHub = true;
		else if (arg === "--plugin") {
			const value = argv[++i];
			if (value !== "work" && value !== "head") throw new Error("--plugin takes work or head");
			options.plugin = value;
		}
		else if (arg === "--only") {
			const value = argv[++i];
			if (value !== "native" && value !== "ansi") throw new Error("--only takes native or ansi");
			options.only = value;
		} else if (arg === "--out") {
			const value = argv[++i];
			if (value === undefined || value === "") throw new Error("--out takes a directory");
			options.out = value;
		} else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
	}
	return options;
}

type Json = Record<string, unknown>;

function obj(value: unknown, label: string): Json {
	if (!isRecord(value)) throw new Error(`${label}: expected an object, got ${JSON.stringify(value)}`);
	return value;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
	return stdout;
}

function freePort(hostname: string): number {
	const server = Bun.serve({ hostname, port: 0, fetch: () => new Response("") });
	const port = server.port ?? 0;
	void server.stop(true);
	return port;
}


// ─── What the run starts, and what the cleanup stops ────────────────────────────────────────────────────────────────

let tempDir: string | null = null;
let vmonKey: string | null = null;
let provider: ParityProvider | null = null;
let gitServer: GitHttpServer | null = null;
let service: { proc: Bun.Subprocess; logFile: string } | null = null;
const terminals: Terminal[] = [];
const createdThreads: string[] = [];
/** What names a cloud job on screen (its job id, its thread's name): what tells its views from a native job's. */
const cloudJobIds: string[] = [];
let serviceLogFile: string | null = null;
/** The fake model's request log (one line per chat request), for a failure report and `model-requests.log`. */
let modelRequests: readonly string[] = [];
let clientsBefore: string[] = [];

const options = parseArgs(process.argv.slice(2));
const report = new Report();
const startedAt = performance.now();
const token = randomBytes(24).toString("hex");
const listenPort = freePort("127.0.0.1");
const origin = `http://127.0.0.1:${listenPort}`;
const gitPassword = randomBytes(18).toString("hex");
const authHeaders = { authorization: `Bearer ${token}` };

async function api(method: string, path: string, body?: unknown): Promise<Response> {
	return fetch(`${origin}/api/v1${path}`, {
		method,
		headers: body === undefined ? authHeaders : { ...authHeaders, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function apiJson(method: string, path: string, expected: number, body?: unknown): Promise<Json> {
	const res = await api(method, path, body);
	const raw = await res.text();
	if (res.status !== expected) throw new Error(`${method} ${path}: expected ${expected}, got ${res.status} ${raw.slice(0, 300)}`);
	return obj(JSON.parse(raw), `${method} ${path}`);
}

async function waitUntil<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>, describe: () => string = () => ""): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (service !== null && service.proc.exitCode !== null) throw new Error(`waiting for ${what}: the service exited with code ${service.proc.exitCode}`);
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}\n${describe()}`);
		await Bun.sleep(500);
	}
}

/**
 * The service's source: the committed tree (`git archive HEAD` with this checkout's node_modules), so another slice's half-edited
 * `src/` cannot stop the service this harness measures the plugin against. `--live-service` runs the working tree instead.
 */
async function snapshotTree(dir: string): Promise<string> {
	const target = join(dir, "service-src");
	await mkdir(target, { recursive: true });
	const archive = Bun.spawn(["git", "archive", "HEAD"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	const extract = Bun.spawn(["tar", "-x", "-C", target], { stdin: archive.stdout, stdout: "pipe", stderr: "pipe" });
	const [archiveErr, extractErr, archiveCode, extractCode] = await Promise.all([archive.stderr.text(), extract.stderr.text(), archive.exited, extract.exited]);
	if (archiveCode !== 0 || extractCode !== 0) throw new Error(`snapshotting HEAD for the service failed: ${archiveErr.trim()} ${extractErr.trim()}`);
	await symlink(join(REPO_ROOT, "node_modules"), join(target, "node_modules"));
	return target;
}

async function startService(configFile: string, logFile: string, cwd: string): Promise<void> {
	const fd = openSync(logFile, "a");
	try {
		const proc = Bun.spawn(["bun", "run", "src/main.ts", "--config", configFile], { cwd, stdin: "ignore", stdout: fd, stderr: fd });
		service = { proc, logFile };
		serviceLogFile = logFile;
		const deadline = Date.now() + 60_000;
		for (;;) {
			if (proc.exitCode !== null) throw new Error(`the service exited with code ${proc.exitCode} while starting`);
			try {
				if ((await fetch(`${origin}/api/v1/whoami`, { headers: authHeaders })).status === 200) return;
			} catch {
				// Not listening yet.
			}
			if (Date.now() >= deadline) throw new Error("the service did not answer /whoami within 60 s");
			await Bun.sleep(200);
		}
	} finally {
		closeSync(fd);
	}
}

async function stopService(): Promise<void> {
	const current = service;
	if (current === null) return;
	service = null;
	if (current.proc.exitCode !== null) return;
	current.proc.kill("SIGTERM");
	const exited = await Promise.race([current.proc.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
	if (!exited) {
		current.proc.kill("SIGKILL");
		await current.proc.exited;
	}
}

function vmonOptions(key: string) {
	return { apiKey: key, apiUrl: VMON_URL, sandboxUrl: VMON_URL, domain: new URL(VMON_URL).hostname };
}

async function sandboxesOf(key: string, id: string): Promise<{ sandboxId: string }[]> {
	const paginator = Sandbox.list({ ...vmonOptions(key), query: { metadata: { thread: id }, state: ["running", "paused"] } });
	const found: { sandboxId: string }[] = [];
	while (paginator.hasNext) found.push(...(await paginator.nextItems()));
	return found;
}

async function clientsOf(id: string): Promise<string[]> {
	return (await new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL }).names()).filter(name => name.endsWith(`-${id}`));
}

async function logTail(file: string): Promise<string> {
	try {
		return (await readFile(file, "utf8")).split("\n").slice(-40).join("\n");
	} catch {
		return "(no log)";
	}
}

// ─── One pass ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
	/** `native` or `ansi`: the pass's folder under the output directory. */
	pass: "native" | "ansi";
	dir: string;
	work: string;
	omp: string;
	env: Record<string, string>;
	out: string;
}

/** The pass's isolated omp: own HOME, agent dir (fake model default) and omp-cloud personal file. */
async function prepare(pass: Rig["pass"], root: string, work: string, host: { path: string; version: string }, out: string, providerUrl: string): Promise<Rig> {
	const dir = join(root, pass);
	const home = join(dir, "home");
	const agentDir = join(home, ".omp", "agent");
	const xdgConfig = join(dir, "xdg-config");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(xdgConfig, "omp-cloud"), { recursive: true });
	await writeFile(join(agentDir, "models.yml"), modelsYaml(providerUrl));
	// No first-run setup wizard and no "what's new" screen: omp reads both from the agent directory.
	await writeFile(join(agentDir, "config.yml"), `${CONFIG_YAML}setupVersion: 2\n`);
	await writeFile(join(agentDir, "last-changelog-version"), host.version);
	// The scripted cloud turn makes a dozen requests with its children (0.132 USD each): a cap above the plugin scenario's 0.5.
	await writeFile(join(xdgConfig, "omp-cloud", "config.yml"), `url: ${JSON.stringify(origin)}\ntoken: ${JSON.stringify(token)}\ndeliver: transcript\npolicy:\n  spend.turnUSD: 5\n`, { mode: 0o600 });
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && !["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "OMP_CLOUD_URL", "OMP_CLOUD_TOKEN", "TMUX", "TMUX_PANE", "TERM_PROGRAM", "WAYLAND_DISPLAY", "DISPLAY"].includes(name)) env[name] = value;
	}
	Object.assign(env, {
		PATH: pathWithoutNodeBin(),
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_DATA_HOME: join(dir, "xdg-data"),
		XDG_STATE_HOME: join(dir, "xdg-state"),
		XDG_CACHE_HOME: join(dir, "xdg-cache"),
	});
	return { pass, dir, work, omp: host.path, env, out: join(out, pass) };
}

const stderrFile = (rig: Rig): string => join(rig.dir, "omp-stderr.log");

function ompArgv(rig: Rig): string[] {
	// `--no-extensions` skips discovered and installed extensions but still loads `-e <path>`, so the plugin runs from the checkout without being installed (its OMP_CLOUD_URL and OMP_CLOUD_TOKEN override every config layer).
	// omp's stderr goes to a file (not the pty), so an uncaught error is told apart from the screen.
	return ["sh", "-c", 'exec "$@" 2>>"$0"', stderrFile(rig), rig.omp, "--no-extensions", "-e", pluginEntry, "--model", MODEL, "--approval-mode", "yolo", "--no-title", "--no-lsp", "--no-pty"];
}

async function launch(rig: Rig): Promise<Terminal> {
	const launchOptions = { argv: ompArgv(rig), cwd: rig.work, env: rig.env, cols: COLS, rows: ROWS };
	const terminal = rig.pass === "native" ? new FakeTern(launchOptions, join(rig.out, "record.jsonl")) : await TmuxTerminal.launch(launchOptions, `parity-${process.pid}`);
	terminals.push(terminal);
	return terminal;
}

/** What a throwing member or a failed prompt build looks like on screen or on stderr. */
const FAULT = /\b(TypeError|ReferenceError|RangeError|SyntaxError|is not a function|is not iterable|Cannot read propert\w*|undefined is not|Uncaught|Unhandled|Maximum call stack)\b|(?:^|\s)Error: /;

/** The screen's fault lines, to tell what a step added. */
function faultLines(screen: string): string[] {
	return stripAnsi(screen)
		.split(/\n| {3,}/)
		.filter(line => FAULT.test(line))
		.map(line => line.trim());
}

/** Safety findings of the run: what fails `--assert`, and what is only worth knowing. */
const safetyProblems: string[] = [];
const safetyNotes: string[] = [];

/** Fails when omp died or the screen shows a fault it did not show before; `mark` is the faults already on screen. */
async function guard(rig: Rig, term: Terminal, what: string, mark: string[]): Promise<void> {
	if (!(await term.alive())) {
		safetyProblems.push(`${rig.pass}: omp is no longer running after ${what}`);
		throw new Error(`omp died during ${what}`);
	}
	for (const line of faultLines(await term.text())) {
		if (!mark.includes(line) && !safetyProblems.some(p => p.includes(line))) safetyProblems.push(`${rig.pass}: after ${what} the screen shows: ${line.slice(0, 200)}`);
	}
}

/** How often the cloud agent's names are on screen: the hub or a list adds them. */
async function registered(term: Terminal): Promise<number> {
	const screen = stripAnsi(await term.text());
	return cloudJobIds.filter(name => name !== "").reduce((sum, name) => sum + screen.split(name).length - 1, 0);
}

/** The slash command a person types: Enter picks the autocompleted command, Enter again runs it when the first only completed it. */
async function slash(term: Terminal, command: string): Promise<void> {
	await term.type(command);
	await Bun.sleep(700);
	await term.key("enter");
	await Bun.sleep(900);
}

async function waitText(term: Terminal, what: string, timeoutMs: number, pattern: RegExp): Promise<string> {
	let last = "";
	return waitUntil(
		what,
		timeoutMs,
		async () => {
			last = await term.text();
			return pattern.test(last) ? last : undefined;
		},
		() => `the screen:\n${stripAnsi(last).split("\n").slice(-30).join("\n")}`,
	);
}

async function press(term: Terminal, ...keys: KeyName[]): Promise<void> {
	for (const key of keys) await term.key(key);
}

/** Captures a step's screen into the pass folder; native: the surface documents, ANSI: the pane in colour and as text. */
async function shoot(rig: Rig, term: Terminal, name: string): Promise<void> {
	if (term.kind === "ansi") {
		await term.capture(join(rig.out, `${name}.ansi`));
		await writeFile(join(rig.out, `${name}.txt`), stripAnsi(await term.text()));
	} else await term.capture(join(rig.out, `${name}.json`));
}

interface Thread {
	id: string;
	phase: string;
}

async function threads(): Promise<Thread[]> {
	const list = obj(await apiJson("GET", "/threads", 200), "threads").threads;
	return Array.isArray(list) ? list.map(item => ({ id: text(obj(item, "thread").id), phase: text(obj(item, "thread").phase) })) : [];
}

async function detail(id: string): Promise<Json> {
	return apiJson("GET", `/threads/${id}`, 200);
}

/** The first open question of the thread: its turn and id. */
function openQuestion(thread: Json): { turn: number; id: number; options: string[] } | undefined {
	const turns = Array.isArray(thread.turns) ? thread.turns : [];
	for (const turn of turns) {
		const t = obj(turn, "turn");
		const questions = Array.isArray(t.questions) ? t.questions : [];
		for (const question of questions) {
			const q = obj(question, "question");
			if (text(q.answeredAt) === "" && typeof q.id === "number" && typeof t.id === "number") {
				const options = Array.isArray(q.options) ? q.options.map(o => text(isRecord(o) ? o.label : o)) : [];
				return { turn: t.id, id: q.id, options };
			}
		}
	}
	return undefined;
}

async function runPass(rig: Rig, report: Report): Promise<void> {
	await mkdir(rig.out, { recursive: true });
	const label = (step: string): string => `${rig.pass}: ${step}`;
	const term = await launch(rig);
	let thread = "";
	let jobsStartedAt = Date.now();

	await report.step(label("omp starts and answers a local turn"), async () => {
		await waitText(term, "omp's prompt", 60_000, /fake-model|Ask anything|>/i);
		await Bun.sleep(1500);
		await term.type("hello");
		await press(term, "enter");
		await waitText(term, "the local reply", 60_000, /TURN count=1/);
	});

	await report.step(label("a native bash job and a native subagent start"), async () => {
		await term.type("PARITY[jobs]");
		await press(term, "enter");
		await waitText(term, "the jobs-started reply", 90_000, new RegExp(JOBS_DONE));
		jobsStartedAt = Date.now();
	});

	if (options.cloud) {
		await report.step(label("handoff: the cloud task starts running"), async () => {
			const before = (await threads()).map(t => t.id);
			await slash(term, `/cloud ${CLOUD_TASK}`);
			const created = await waitUntil("the thread to appear", 120_000, async () => (await threads()).find(t => !before.includes(t.id)));
			thread = created.id;
			createdThreads.push(thread);
			const named = await detail(thread);
			// A cloud job's tile is titled by its job id, its widget by the thread's name.
			cloudJobIds.push(cloudJobId({ id: thread, name: text(named.name) }), text(named.name));
			await waitUntil("the cloud turn to run", 240_000, async () => {
				const d = await detail(thread);
				return text(d.phase) === "working" || text(d.phase) === "waiting" ? d : undefined;
			});
			// The plugin's watcher registers the running turn as a job of the local omp a moment later.
			await Bun.sleep(5000);
			await shoot(rig, term, "01-launch-card");
		});
	}

	await report.step(label("/jobs lists the running jobs"), async () => {
		// omp's job-widget author reads a job's output after it is 15 s old.
		await Bun.sleep(Math.max(0, 24_000 - (Date.now() - jobsStartedAt)));
		await slash(term, "/jobs");
		await waitText(term, "the jobs sheet", 30_000, /Background jobs|running/i);
		await Bun.sleep(1500);
		// The sheet shows one job's detail (its widget over its output) at a time: step through every running job.
		const running = options.cloud ? 3 : 2;
		await shoot(rig, term, "02-jobs-1");
		for (let job = 2; job <= running; job++) {
			await press(term, "down");
			await Bun.sleep(1500);
			await shoot(rig, term, `02-jobs-${job}`);
		}
		await press(term, "escape");
		await Bun.sleep(500);
	});

	if (options.cloud) {
		await report.step(label("Agent Hub (Alt+A): every entry, the cloud agent's detail"), async () => {
			const mark = faultLines(await term.text());
			const before = await registered(term);
			const hubOpen = async (): Promise<boolean> => /Agent Hub|Filter agents/.test(stripAnsi(await term.text()));
			// Alt+A, as the Subagents strip advertises; `/hub` is the same overlay when the key does not reach omp.
			await press(term, "alt-a");
			await Bun.sleep(2500);
			if (!(await hubOpen())) {
				await slash(term, "/hub");
				await Bun.sleep(2500);
				safetyNotes.push(`${rig.pass}: Alt+A did not open the Agent Hub through this terminal; /hub did`);
			}
			await shoot(rig, term, "09-hub-0");
			await guard(rig, term, "opening the Agent Hub", mark);
			if (!(await hubOpen())) safetyProblems.push(`${rig.pass}: the Agent Hub did not open`);
			const after = await registered(term);
			// The classic hub is fullscreen (the transcript's own mentions are hidden); the native one adds the roster to the document.
			if (term.kind === "ansi" ? after === 0 : after <= before) safetyProblems.push(`${rig.pass}: the Agent Hub does not list the cloud agent (its names on screen: ${before} before, ${after} with the hub open)`);
			// The roster's entries in turn (a native subagent and the cloud agent): select, open the chat view (reads the ref's session), step out.
			for (let entry = 0; entry < 2; entry++) {
				if (entry > 0) {
					await press(term, "down");
					await Bun.sleep(1200);
				}
				await shoot(rig, term, `09-hub-${entry + 1}`);
				await guard(rig, term, `selecting hub entry ${entry + 1}`, mark);
				await press(term, "enter");
				await Bun.sleep(2500);
				await shoot(rig, term, `09-hub-detail-${entry + 1}`);
				await guard(rig, term, `opening hub entry ${entry + 1}`, mark);
				await press(term, "escape");
				await Bun.sleep(1200);
				await guard(rig, term, `closing hub entry ${entry + 1}`, mark);
			}
			// Out of the hub (and any chat view still open).
			for (let i = 0; i < 4 && (await hubOpen()); i++) {
				await press(term, "escape");
				await Bun.sleep(1000);
			}
			if (await hubOpen()) safetyProblems.push(`${rig.pass}: the Agent Hub did not close on Escape`);
			await guard(rig, term, "closing the hub", mark);
		});
		if (options.stopAfterHub) {
			await sessionStep();
			await exitStep();
			return;
		}
	}

	if (options.cloud) {
		await report.step(label("/jobs again, midway through the cloud turn: the output tail"), async () => {
			// The scripted cloud turn (provider.ts `TAIL:`) starts a background bash job and a background subagent, then says a line and runs a
			// 35 s bash three times: wait for the third line, with the children running and two of the three bash calls ended.
			const lastEvents = async (): Promise<string> => {
				const events = obj(await apiJson("GET", `/threads/${thread}/events?format=json&limit=500`, 200), "events").events;
				const list = Array.isArray(events) ? events.map(e => (isRecord(e) ? e : {})) : [];
				return `${list.slice(-14).map(e => `  #${text(e.seq)} ${text(e.kind)}: ${text(e.text).slice(0, 140)}`).join("\n")}\nmodel requests (last 12):\n${modelRequests.slice(-12).map(r => `  ${r}`).join("\n")}`;
			};
			let latest = "";
			await waitUntil(
				"the cloud turn's third assistant line",
				240_000,
				async () => {
					const events = obj(await apiJson("GET", `/threads/${thread}/events?format=json&limit=500`, 200), "events").events;
					const list = Array.isArray(events) ? events.map(e => (isRecord(e) ? e : {})) : [];
					latest = await lastEvents();
					return list.some(e => e.kind === "assistant" && text(e.text).includes("Tail step three")) ? true : undefined;
				},
				() => `the thread's last events:\n${latest}`,
			);
			await Bun.sleep(4000);
			await slash(term, "/jobs");
			await waitText(term, "the jobs sheet", 30_000, /Background jobs|running/i);
			// The sheet shows one job's detail at a time; the cloud job's children and the native subagent's child are rows of their own: step through every row.
			const shown = await term.text();
			const counts = [...shown.matchAll(/Running:\s*(\d+)|(\d+) running/g)].map(m => Number(m[1] ?? m[2]));
			const rows = Math.min(12, Math.max(4, ...counts));
			await Bun.sleep(1500);
			await shoot(rig, term, "02b-jobs-tail-1");
			for (let row = 2; row <= rows; row++) {
				await press(term, "down");
				await Bun.sleep(1500);
				await shoot(rig, term, `02b-jobs-tail-${row}`);
			}
			await press(term, "escape");
			await Bun.sleep(500);
		});
	}

	await report.step(label("wait blocks on every job"), async () => {
		await term.type("PARITY[wait]");
		await press(term, "enter");
		await Bun.sleep(12_000);
		await shoot(rig, term, "03-wait-view");
		await waitText(term, "the wait to end", 480_000, new RegExp(WAITED_DONE));
		await Bun.sleep(1500);
		await shoot(rig, term, "04-after-wait");
	});

	if (options.cloud) {
		await report.step(label("the finished turn's card"), async () => {
			await waitUntil("turn 1 to finish", 240_000, async () => {
				const d = await detail(thread);
				return text(d.phase) === "idle" ? d : undefined;
			});
			await Bun.sleep(3000);
			await shoot(rig, term, "05-turn-card");
		});

		await report.step(label("a cloud question: card and dialog"), async () => {
			await slash(term, `/cloud send ${thread} ${CLOUD_ASK}`);
			const question = await waitUntil("the cloud question", 240_000, async () => openQuestion(await detail(thread)));
			await Bun.sleep(3000);
			await shoot(rig, term, "06-question");
			// A person-started thread's question opens omp's own ask dialog by itself; if it did not, `/cloud answer` (the card's Respond) opens it.
			if (!/╭─ Ask|Submit/.test(await term.text())) {
				await slash(term, `/cloud answer ${thread}`);
				await Bun.sleep(2500);
			}
			await shoot(rig, term, "06b-ask-dialog");
			await press(term, "escape");
			await Bun.sleep(800);
			// Answered through the API (the dialog, when it is still there, closes on its own).
			const body = question.options.includes("blue") ? { selected: ["blue"] } : { answer: "blue" };
			await apiJson("POST", `/threads/${thread}/turns/${question.turn}/questions/${question.id}/answer`, 200, body);
			await waitUntil("turn 2 to finish", 240_000, async () => {
				const d = await detail(thread);
				return text(d.phase) === "idle" && openQuestion(d) === undefined ? d : undefined;
			});
			await Bun.sleep(3000);
			if (/Skip|Submit/.test(await term.text())) {
				await press(term, "escape");
				await Bun.sleep(800);
			}
			await shoot(rig, term, "07-turn-card-answered");
		});

		await report.step(label("the /cloud hub"), async () => {
			await slash(term, "/cloud");
			await Bun.sleep(2500);
			await shoot(rig, term, "08-hub");
			await press(term, "escape");
			await Bun.sleep(500);
		});
	}

	await sessionStep();
	await exitStep();

	/** The Agent Hub and the session switches read the cloud agent's registry ref (`ref.session.*`): a member the shim lacks would throw here. */
	async function sessionStep(): Promise<void> {
		await report.step(label("a model turn, /new and /resume with the cloud agent registered"), async () => {
			const mark = faultLines(await term.text());
			const countsIn = (screen: string): number[] => [...screen.matchAll(/count=(\d+) first=hello/g)].map(m => Number(m[1]));
			const seen = Math.max(0, ...countsIn(await term.text()));
			const mentionsBefore = options.cloud ? await registered(term) : 0;
			await slash(term, "/new");
			await Bun.sleep(3000);
			await shoot(rig, term, "10-new");
			await guard(rig, term, "/new", mark);
			await slash(term, "/resume");
			await Bun.sleep(2500);
			await shoot(rig, term, "10b-resume-list");
			await guard(rig, term, "/resume list", mark);
			// The list's first entry is the session the run started in (a session with no messages is not listed).
			await press(term, "enter");
			await Bun.sleep(3500);
			await shoot(rig, term, "10c-resumed");
			await guard(rig, term, "/resume", mark);
			await term.type("safety ping");
			await press(term, "enter");
			// The fake model answers `TURN count=<user messages> first=<the first one>`: more than before, and the first still "hello", means the original session was restored.
			await waitUntil(
				"the model's answer in the resumed session (the IRC peers prompt is built for it)",
				90_000,
				async () => (Math.max(0, ...countsIn(await term.text())) > seen ? true : undefined),
				() => "the screen shows no `TURN count=<more than before> first=hello`: the resume did not restore the session, or the turn failed",
			);
			await Bun.sleep(1500);
			await shoot(rig, term, "10d-model-turn");
			await guard(rig, term, "the model turn", mark);
			if (options.cloud) safetyNotes.push(`${rig.pass}: cloud agent mentions on screen before /new ${mentionsBefore}, after the model turn ${await registered(term)}`);
		});
	}

	async function exitStep(): Promise<void> {
		await report.step(label("omp exits"), async () => {
			await term.type("/exit");
			await press(term, "enter");
			await Bun.sleep(1500);
			await term.stop();
			// omp's stderr, kept apart from the pty: any uncaught error is a failure, anything else a note.
			let stderr = "";
			try {
				stderr = await readFile(stderrFile(rig), "utf8");
			} catch {
				// nothing written
			}
			const faults = stderr.split("\n").filter(line => FAULT.test(line));
			for (const line of faults.slice(0, 5)) safetyProblems.push(`${rig.pass}: omp's stderr: ${line.trim().slice(0, 200)}`);
			if (stderr.trim() !== "" && faults.length === 0) safetyNotes.push(`${rig.pass}: omp's stderr held ${stderr.trim().split("\n").length} line(s), none an error: ${stderr.trim().split("\n")[0]?.slice(0, 120)}`);
		});
	}
}

// ─── The numbers: ./summary.ts ──────────────────────────────────────────────────────────────────────────────────────

// ─── Run ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function run(): Promise<Summary | undefined> {
	await report.step("preflight", async () => {
		if (options.cloud) {
			// One lock for every run that owns the gateway clients file and the local vmon (test/run-lock.ts); it throws naming the holder.
			acquireRunLock("parity:capture");
			const health = await fetch(`${VMON_URL}/health`);
			if (health.status !== 204) throw new Error(`vmon /health answered ${health.status}`);
			const gateway = await fetch(`${GATEWAY_URL}/healthz`);
			if (gateway.status !== 200) throw new Error(`gateway /healthz answered ${gateway.status}`);
			vmonKey = (await readFile(VMON_KEY_FILE, "utf8")).trim();
			if (vmonKey === "") throw new Error(`${VMON_KEY_FILE} is empty`);
			clientsBefore = await new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL }).names();
		}
	});

	const dir = await mkdtemp(join(tmpdir(), "omp-cloud-parity-"));
	tempDir = dir;
	const work = join(dir, "work");
	let providerUrl = "";
	const host = await hostOmp();

	await report.step("fake model, service, temp repository", async () => {
		const p = startParityProvider({ hostname: PROVIDER_HOST, waitCalls: options.cloud ? 3 : 2 });
		provider = p;
		providerUrl = p.url;
		modelRequests = p.requests;
		// The committed tree: the service's source (its own half-edited `src/` must not stop it), and the plugin's under `--plugin head`.
		const snapshot = options.liveService && options.plugin === "work" ? REPO_ROOT : await snapshotTree(dir);
		if (options.plugin === "head") pluginEntry = join(snapshot, "plugin", "src", "index.ts");
		await mkdir(work, { recursive: true });
		await git(dir, "init", "-q", "-b", "main", work);
		await writeFile(join(work, "README.md"), "# parity\n");
		await git(work, "add", "-A");
		await git(work, "-c", "user.name=Parity", "-c", "user.email=parity@example.com", "commit", "-q", "-m", "initial");
		if (!options.cloud) return;
		// The clone's upstream is a served bare repository the service holds a credential for: the handoff is a delta from its main.
		const remotes = join(dir, "remotes");
		const bareRepo = join(remotes, "app.git");
		await mkdir(remotes, { recursive: true });
		await git(dir, "init", "-q", "--bare", "-b", "main", bareRepo);
		const server = serveGitHttp({ root: remotes, password: gitPassword });
		gitServer = server;
		await git(work, "remote", "add", "origin", bareRepo);
		await git(work, "push", "-q", "-u", "origin", "main");
		await git(work, "remote", "set-url", "origin", server.url("app"));
		const models = obj(Bun.YAML.parse(modelsYaml(p.url)), "fake models.yml");
		const config = {
			listen: `127.0.0.1:${listenPort}`,
			apiTokenSha256: createHash("sha256").update(token).digest("hex"),
			dataDir: join(dir, "data"),
			vmon: { url: VMON_URL, keyFile: VMON_KEY_FILE, template: "omp-agent" },
			gateway: { url: GATEWAY_URL, clientsFile: CLIENTS_FILE },
			broker: { url: BROKER_URL, tokenFile: BROKER_TOKEN_FILE },
			models: { default: MODEL, direct: { fake: obj(models.providers, "providers").fake } },
			runner: { idleTimeoutSeconds: 4, turnTimeoutSeconds: 300, questionTimeoutSeconds: 120 },
			git: { hosts: { [server.host]: { credential: `!printf %s ${gitPassword}` } } },
		};
		await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2));
		await startService(join(dir, "config.json"), join(dir, "service.log"), options.liveService ? REPO_ROOT : snapshot);
	});

	await rm(options.out, { recursive: true, force: true });
	let nativeRecord: string | undefined;
	for (const pass of ["native", "ansi"] as const) {
		if (options.only !== undefined && options.only !== pass) continue;
		const rig = await prepare(pass, dir, work, host, options.out, providerUrl);
		await mkdir(rig.out, { recursive: true });
		await runPass(rig, report);
		if (pass === "native") nativeRecord = join(rig.out, "record.jsonl");
		await tearDownThreads();
	}
	await writeFile(join(options.out, "model-requests.log"), `${modelRequests.join("\n")}\n`);

	if (nativeRecord === undefined) return undefined;
	const home = join(dir, "native", "home");
	return report.step(
		"native: replay the TSP record",
		async () => {
			const records = parseRecord(await readFile(nativeRecord, "utf8"));
			if (records.length === 0) throw new Error("PI_TUI_TSP_RECORD stayed empty: omp never drew natively");
			const isCloud = (identity: string): boolean => isCloudText(identity) || cloudJobIds.some(id => id !== "" && identity.includes(id));
			const summary = analyze(replay(records, { isCloud }), parseStats(await ompLogs(home)));
			if (options.cloud) {
				if (options.only !== "native") summary.strip = await checkSubagentStrip(options.out, cloudJobIds);
				summary.tail = await checkJobsTail(options.out, cloudJobIds);
				summary.children = await checkJobsChildren(options.out, cloudJobIds, { bash: CLOUD_BG_LABEL, task: CLOUD_AGENT_ID }, { native: true, ansi: options.only !== "native" });
			}
			await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 1));
			return summary;
		},
		summary => `${summary.frames} frames, ${summary.rows.total} rows (${summary.rows.cloud} from omp-cloud)`,
	);
}

/** omp's log files under an isolated HOME, as one text. */
async function ompLogs(home: string): Promise<string> {
	const parts: string[] = [];
	for (const dir of [join(home, ".omp", "logs"), join(home, ".omp", "agent", "logs")]) {
		try {
			for (const name of await readdir(dir)) parts.push(await readFile(join(dir, name), "utf8"));
		} catch {
			// no such directory
		}
	}
	return parts.join("\n");
}

/** Deletes the pass's threads, so the next pass starts with none and no sandbox waits for the cleanup. */
async function tearDownThreads(): Promise<void> {
	const key = vmonKey;
	if (key === null || service === null) return;
	for (const id of createdThreads) {
		try {
			await api("DELETE", `/threads/${id}`);
			await waitUntil(`${id}'s sandbox to go`, 60_000, async () => ((await sandboxesOf(key, id)).length === 0 ? true : undefined));
		} catch (error) {
			console.log(`teardown: ${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function cleanup(): Promise<void> {
	for (const terminal of terminals) await terminal.stop().catch(() => undefined);
	await stopService().catch(() => undefined);
	await (provider as ParityProvider | null)?.stop().catch(() => undefined);
	await (gitServer as GitHttpServer | null)?.stop().catch(() => undefined);
	const key = vmonKey;
	if (key !== null) {
		const clients = new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL });
		for (const created of createdThreads) {
			try {
				for (const sandbox of await sandboxesOf(key, created)) await Sandbox.kill(sandbox.sandboxId, vmonOptions(key));
				for (const name of await clientsOf(created)) await clients.revoke(name);
			} catch (error) {
				console.log(`cleanup: ${created}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		try {
			// The service's own gateway client outlives its temp data directory: revoke the one this run added.
			for (const name of await clients.names()) {
				if (name.endsWith("-service") && !clientsBefore.includes(name)) await clients.revoke(name);
			}
		} catch (error) {
			console.log(`cleanup: the service's gateway client: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (tempDir !== null) {
		// omp's daemons and its own exit write into the isolated HOME (n-gram snapshot, logs) a moment after the process is told to stop.
		await Bun.sleep(2500);
		await rm(tempDir, { recursive: true, force: true });
		await Bun.sleep(1500);
		await rm(tempDir, { recursive: true, force: true });
	}
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void cleanup().finally(() => process.exit(130));
	});
}

let summary: Summary | undefined;
let failure: unknown = null;
try {
	summary = await run();
} catch (error) {
	if (!(error instanceof StepFailed)) console.log(`FAIL  parity: ${error instanceof Error ? error.message : String(error)}`);
	failure = error;
}
if (failure !== null) {
	const logFile = serviceLogFile;
	if (logFile !== null) console.log(`\n--- tail of ${logFile} ---\n${await logTail(logFile)}`);
}
await cleanup();

const ok = report.print();
printSummary(summary, options.out);
console.log(`\n(f) the cloud agent's registry ref under omp's own UI (Agent Hub, /new, /resume, a model turn): ${safetyProblems.length === 0 ? "no fault" : "FAULTS"}`);
for (const problem of safetyProblems) console.log(`    FAULT ${problem}`);
for (const note of safetyNotes) console.log(`    note: ${note}`);
console.log(`total ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
let exit = ok && failure === null ? 0 : 1;
if (options.assert) {
	for (const problem of safetyProblems) {
		console.log(`ASSERT FAIL: safety: ${problem}`);
		exit = 1;
	}
}
if (options.assert && summary !== undefined) {
	if (summary.rows.cloud > 0) {
		console.log(`ASSERT FAIL: ${summary.rows.cloud} rows nodes from omp-cloud surfaces`);
		exit = 1;
	}
	for (const problem of summary.children?.problems ?? []) {
		console.log(`ASSERT FAIL: the cloud agent's children do not nest in /jobs like a native subagent's: ${problem}`);
		exit = 1;
	}
	for (const problem of summary.tail?.problems ?? []) {
		console.log(`ASSERT FAIL: the cloud job's /jobs Output is not a tail: ${problem}`);
		exit = 1;
	}
	for (const item of summary.strip ?? []) {
		if (!item.cloudListed) {
			console.log(`ASSERT FAIL: the cloud agent is not in the Subagents strip of ${item.step}`);
			exit = 1;
		}
	}
	if (!summary.views.cloudComplete) {
		for (const surface of summary.views.surfaces.filter(s => s.required)) {
			if (surface.cloud.length === 0) console.log(`ASSERT FAIL: no cloud job view on the ${surface.where}`);
			else if (surface.missingRequired.length > 0) console.log(`ASSERT FAIL: cloud job views on the ${surface.where} lack ${surface.missingRequired.join("; ")}`);
		}
		exit = 1;
	}
}
process.exit(exit);
