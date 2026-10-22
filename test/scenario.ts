/**
 * `mise run scenario`: acceptance of the service's API (the runner, git, session export, archive, policy and the create, inspection and list routes). The service runs as a child process
 * against local vmon and the fake provider; this script drives only its HTTP API, plus read-only checks of vmon
 * (`Sandbox.list`), the gateway clients file and a bare git remote it serves over authenticated smart HTTP (L-O). It
 * kills one sandbox itself (P). Settings change through `PUT /settings` and are reset after the step that sets them.
 *
 *  A  create a thread from a one-commit bundle: first turn replies, omp has a pid in the VM; the conversation is
 *     already the runner's export, under the thread's export session id, holding the reply
 *  B  `ASK:` message: the thread waits with a question (`kind`, `expiresAt` = asked + the timeout, also in the list summary), the question
 *     is answered (its expiry gone), the turn finishes with the answer
 *  C  `BASH:` message: the turn changes a file; the result branch is recorded and served as a bundle; the export
 *     keeps its session id and now holds the `DONE=` reply too
 *  D  the idle VM pauses; the next message resumes the same omp process
 *  E  the service restarts while the VM is paused; the same omp process answers the next message
 *  H  the VM is paused from outside under a running turn: the runner reconnects, resumes it and finishes the turn
 *  F  the event stream carries every progress and lifecycle kind
 *  G  delete: the sandbox and the gateway client are gone
 *  I  a conversation that does not unpack fails its thread, leaving no sandbox and no gateway client
 *  J  whoami lists the model patterns and the omp version; a model the cloud cannot run is refused (409)
 *  K  the owner's overlays reach omp's arguments before the service's own; a missing overlay fails the thread
 *  K2 no memory: a shipped `config.yml` that sets `memory.backend: mnemopi` still leaves the model's requests without the memory device lines (`xd://recall`): the service's overlay wins
 *  L  delta handoff from an authenticated git remote (`git.hosts`): the base history is in the VM, the result bundle is thin
 *  M  `git.push` ask: the result waits for a `Push` answer, then the branch lands on the remote
 *  N  `git.push` auto: no question, the remote branch follows the new head
 *  N2 signed result (`git.sign` ssh, the service's signing key): a turn made unsigned stays as pushed; after `POST /signing/key` only the
 *     new commits carry signatures that `git verify-commit` accepts, the push is a fast-forward of the unsigned head, the VM adopted the
 *     signed tip (the next turn's first parent), and a cold restore after a killed sandbox still descends from it and pushes fast-forward
 *  N3 read-only (`policy.readOnly`): a read-only thread's change is not pushed (no remote branch, a `not pushed` push event) and its VM
 *     gets no MCP server (no `mcp.json`, a `vm` event, the read-only prompt line)
 *  O  push refusals: a protected branch, then a diverged remote branch (never force-pushed)
 *  P  cold restore: the thread's sandbox is killed; the next message restores it on a new VM from the stored bundles and export
 *  P2 archive: with a tiny `lifecycle.archiveAfterDays` the sweep snapshots the idle thread and releases its VM (no sandbox,
 *     no gateway client, `archivedAt` set, a `vm` archived event); the next message restores it on a new VM with its work and
 *     conversation (`archivedAt` null again); the thread's metrics show requests and a context reading
 *  Q  approval relay (`policy.bash.patterns` prompt): Approve runs the command, Deny blocks it; the git guard blocks `git push`
 *  R  spend cap (`policy.spend.turnUSD`): the turn is aborted and fails with `spend cap reached: turn ...`
 *  S  egress (`policy.egress`): a new VM reaches the model but not the internet
 *  T  allowed models (`policy.models.allowed`): a model outside the list is refused (409)
 *  U  thread policy (`policy` of the create request): a thread's deny rule blocks its command and shows in the detail; a
 *     widening `policy.egress` and an unknown key are refused (400)
 *  V  slash commands: `/session info` runs as an omp built-in, never reaching the model: the turn ends in seconds (not at the 30 s
 *     poll) with the command's output as its reply, no model request, no usage, no new commit; `/usage` replies too
 *  W  idempotent create: a malformed `Idempotency-Key` is 400; a duplicate that arrives while the first create is still
 *     uploading is 409; the finished scratch create is 201; the key is bound to the prompt: the same prompt replays (200 `replayed`,
 *     multipart only), a different prompt is 409 `used for a different request` and creates nothing, a non-multipart replay is 400
 *  X  inspection before a result: diff, tree (head) and files are 404 `no result yet`; turn diffs say no head; `tree?ref=base` works
 *  Y  scratch thread end to end: the turn runs, `diff`/`tree`/`files` show what the agent wrote, `result` downloads, `git.push: auto`
 *     still never pushes or asks, a turn's own diff is only its change
 *  Z  turn text paging (`reply`/`error`/`text`, bounds) and events as JSON (paging, `after`, `kind`, `turn`, bounds; SSE unchanged)
 *  AA a thread the model started (origin tool) has no `ask` tool: `ASK:` ends the turn with the tool's error as the answer, no question
 *  AB interrupting send: the running turn is stopped (`stopped by owner`), every queued turn is cancelled and listed in `cancelled`,
 *     the new turn runs next; on an idle thread `interrupted` is false and `cancelled` empty; a bad mode is 400
 *  AC list: meta fields, filters, `total`, paging by cursor, bad parameters, deleted threads never listed, a replayed repo create
 *  AC2 secret env: `PUT /secrets/DEMO_TOKEN` (repos `*`; values are never served, `repos` is required) reaches a new thread's env (`printf %s ${#DEMO_TOKEN}`
 *     is 16, a `secret env:` vm event names it) and omp's masking keeps the value out of every model request after `echo $DEMO_TOKEN`
 *  AC3 MCP proxy: a thread with an http MCP server (a fake upstream on the host's primary non-loopback address, credential in `headers`)
 *     reaches it from the VM only through the service's proxy with the VM's own token; the upstream sees its own credential and never the
 *     VM's; an MCP server at the gateway host is refused (400)
 *  AD whoami fields (service, capabilities, limits, spend, models), then the scratch thread is deleted and its inspections are 404
 *  AF environment: a thread whose request has `setup` prepares the repository environment in a build sandbox (`preparing the repository environment`,
 *     then `environment ready`) and its VM starts from the snapshot, so a file the setup wrote into an ignored directory is there; a second
 *     thread of the same repo uses the cached environment (`using the cached environment`, the same stamp) and, started from the snapshot,
 *     still obeys `policy.egress`; a changed `bun.lock` prepares a new environment (a new stamp). The scenario deletes the snapshots it made
 *  AG preview: `GET /threads/{id}/ports/8000/` relays a web server the agent started in the VM; once the idle VM is paused the same GET resumes
 *     it and answers again; port 49983 is 400 and a websocket upgrade is 501
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "e2b";
import { GatewayClients } from "../src/gateway/clients";
import { isRecord } from "../src/guards";
import { hostOmp } from "../src/omp-version";
import { exportSessionId } from "../src/runner/session-export";
import { API_VERSION } from "../src/version";
import { expectContains, expectEqual, Report, StepFailed } from "./report";
import { describeRequest, type FakeProvider, longReply, modelsYaml, startFakeProvider } from "./fake-provider";
import { type GitHttpServer, serveGitHttp } from "./git-http";
import { takeRunLockOrExit } from "./run-lock";

const REPO_ROOT = join(import.meta.dir, "..");
const VMON_URL = "http://127.0.0.1:3000";
const VMON_KEY_FILE = join(homedir(), ".config", "omp-cloud", "vmon.key");
const PROVIDER_HOST = "10.254.254.1";
const GATEWAY_URL = `http://${PROVIDER_HOST}:4000`;
const CLIENTS_FILE = join(homedir(), ".local", "share", "omp-cloud", "auth-home", "clients.json");
const BROKER_URL = "http://127.0.0.1:8765";
const BROKER_TOKEN_FILE = join(homedir(), ".local", "share", "omp-cloud", "auth-home", ".omp", "auth-broker.token");
const POLL_MS = 500;

type Json = Record<string, unknown>;

interface ServiceEvent {
	seq: number;
	kind: string;
	turn: number | null;
	text: string;
}

function obj(value: unknown, label: string): Json {
	if (!isRecord(value)) throw new Error(`${label}: expected an object, got ${JSON.stringify(value)}`);
	return value;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** A port nothing listens on right now. */
function freePort(hostname: string): number {
	const server = Bun.serve({ hostname, port: 0, fetch: () => new Response("") });
	const port = server.port ?? 0;
	void server.stop(true);
	return port;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
	return stdout;
}

/** Writes `content` to `file` in the repository `repo`, commits it and returns the new commit. */
async function commitFile(repo: string, file: string, content: string, message: string): Promise<string> {
	await writeFile(join(repo, file), content);
	await git(repo, "add", file);
	await git(repo, "-c", "user.name=Scenario", "-c", "user.email=scenario@example.com", "commit", "-q", "-m", message);
	return (await git(repo, "rev-parse", "HEAD")).trim();
}

/** The commit `branch` points to in the bare repository `bare`; `""` when it does not exist. */
async function remoteBranch(bare: string, branch: string): Promise<string> {
	try {
		return (await git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).trim();
	} catch {
		return "";
	}
}

takeRunLockOrExit("scenario");
const report = new Report();
const startedAt = performance.now();

// Everything the finally block cleans up.
let tempDir: string | null = null;
let vmonKey: string | null = null;
let threadId: string | null = null;
let provider: FakeProvider | null = null;
let gitServer: GitHttpServer | null = null;
let service: { proc: Bun.Subprocess; logFile: string } | null = null;
/** Every thread this scenario created, for cleanup. */
const createdThreads: string[] = [];
const logFiles: string[] = [];
/** The gateway clients that existed before the scenario started: the service's own client is revoked at the end unless it is one of them. */
let clientsBefore: string[] = [];
/** The providers the gateway serves (read in the preflight): the model patterns `whoami` must list besides `fake/*`. */
let gatewayProviders: string[] = [];

const token = randomBytes(24).toString("hex");
/** What the git remote's Basic auth accepts; the service reads it through `git.hosts` and a `!printf` credential command. */
const gitPassword = randomBytes(18).toString("hex");
const listenPort = freePort("127.0.0.1");
const origin = `http://127.0.0.1:${listenPort}`;
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

/** The thread's events from the start of the log, read for `durationMs`. */
async function readEvents(durationMs: number): Promise<ServiceEvent[]> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), durationMs);
	const events: ServiceEvent[] = [];
	let buffer = "";
	try {
		const res = await fetch(`${origin}/api/v1/threads/${threadId}/events?after=0`, { headers: authHeaders, signal: abort.signal });
		if (res.status !== 200 || res.body === null) throw new Error(`events: expected 200 with a body, got ${res.status}`);
		const decoder = new TextDecoder();
		for await (const chunk of res.body) {
			buffer += decoder.decode(chunk, { stream: true });
			let end = buffer.indexOf("\n\n");
			while (end >= 0) {
				const message = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				end = buffer.indexOf("\n\n");
				const data = message.split("\n").find(line => line.startsWith("data: "));
				if (data === undefined) continue;
				const event = obj(JSON.parse(data.slice("data: ".length)), "event");
				events.push({
					seq: Number(event.seq),
					kind: text(event.kind),
					turn: typeof event.turn === "number" ? event.turn : null,
					text: text(event.text),
				});
			}
		}
	} catch (error) {
		if (!abort.signal.aborted) throw error;
	} finally {
		clearTimeout(timer);
	}
	return events;
}

async function detail(): Promise<Json> {
	return apiJson("GET", `/threads/${threadId}`, 200);
}

function vmOf(thread: Json): Json | null {
	return isRecord(thread.vm) ? thread.vm : null;
}

function latestOf(thread: Json): Json | null {
	return isRecord(thread.latest) ? thread.latest : null;
}

/** A readable account of where the thread stands, for timeouts. */
async function describe(thread: Json): Promise<string> {
	let events = "";
	try {
		const last = (await readEvents(800)).slice(-8);
		events = last.map(e => `  #${e.seq} ${e.kind}${e.turn === null ? "" : ` (turn ${e.turn})`}: ${e.text.slice(0, 120)}`).join("\n");
	} catch (error) {
		events = `  (events unavailable: ${error instanceof Error ? error.message : String(error)})`;
	}
	return [
		`phase: ${text(thread.phase)}  error: ${JSON.stringify(thread.error)}`,
		`vm: ${JSON.stringify(thread.vm)}`,
		`latest turn: ${JSON.stringify(thread.latest)}`,
		`question: ${JSON.stringify(thread.question)}`,
		`last events:\n${events}`,
	].join("\n");
}

/** Polls the thread detail until `check` holds. A failed thread or a dead service stops the wait at once. */
async function waitFor(what: string, timeoutMs: number, check: (thread: Json) => boolean): Promise<Json> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const thread = await detail();
		if (check(thread)) return thread;
		if (thread.phase === "failed") throw new Error(`waiting for ${what}: the thread failed\n${await describe(thread)}`);
		if (service !== null && service.proc.exitCode !== null) {
			throw new Error(`waiting for ${what}: the service exited with code ${service.proc.exitCode}\n${await describe(thread)}`);
		}
		if (Date.now() >= deadline) {
			throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}\n${await describe(thread)}`);
		}
		await Bun.sleep(POLL_MS);
	}
}

/** The turn `turnId` is done and nothing else is queued or running; returns the thread. */
async function waitTurnIdle(turnId: number, timeoutMs: number): Promise<Json> {
	const thread = await waitFor(`turn ${turnId} to finish`, timeoutMs, t => {
		const latest = latestOf(t);
		return t.phase === "idle" && latest !== null && Number(latest.id) >= turnId;
	});
	const latest = obj(thread.latest, "latest");
	if (latest.state !== "done") throw new Error(`turn ${turnId} ended ${text(latest.state)}: ${text(latest.error)}`);
	return thread;
}

async function sendMessage(message: string): Promise<number> {
	const body = await apiJson("POST", `/threads/${threadId}/messages`, 201, { text: message });
	return Number(obj(body.turn, "turn").id);
}

/** Downloads `/conversation` of thread `id` and returns the archive's session id and its journal text (read with `tar -xOf`). */
async function fetchConversation(dir: string, id: string): Promise<{ sessionId: string; journal: string }> {
	const res = await api("GET", `/threads/${id}/conversation`);
	if (res.status !== 200) throw new Error(`GET /conversation: expected 200, got ${res.status} ${(await res.text()).slice(0, 300)}`);
	const archive = join(dir, "conversation.tar");
	await writeFile(archive, new Uint8Array(await res.arrayBuffer()));
	const member = async (name: string): Promise<string> => {
		const proc = Bun.spawn(["tar", "-xOf", archive, name], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
		if (code !== 0) throw new Error(`tar -xOf ${name} exited ${code}: ${stderr.trim()}`);
		return stdout;
	};
	return { sessionId: text(obj(JSON.parse(await member("manifest.json")), "manifest").id), journal: await member("session.jsonl") };
}

async function startService(configFile: string, logFile: string): Promise<{ proc: Bun.Subprocess; logFile: string }> {
	logFiles.push(logFile);
	const fd = openSync(logFile, "a");
	try {
		const proc = Bun.spawn(["bun", "run", "src/main.ts", "--config", configFile], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: fd,
			stderr: fd,
		});
		const started = { proc, logFile };
		service = started;
		const deadline = Date.now() + 60_000;
		for (;;) {
			if (proc.exitCode !== null) throw new Error(`the service exited with code ${proc.exitCode} while starting`);
			try {
				const res = await fetch(`${origin}/api/v1/whoami`, { headers: authHeaders });
				if (res.status === 200) return started;
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

async function logTail(file: string): Promise<string> {
	try {
		return (await readFile(file, "utf8")).split("\n").slice(-40).join("\n");
	} catch {
		return "(no log)";
	}
}

function vmonOptions(key: string) {
	return { apiKey: key, apiUrl: VMON_URL, sandboxUrl: VMON_URL, domain: new URL(VMON_URL).hostname };
}

/** The scenario thread's sandboxes (running and paused), by metadata; read-only. */
async function sandboxesOf(key: string, id: string): Promise<{ sandboxId: string }[]> {
	const paginator = Sandbox.list({ ...vmonOptions(key), query: { metadata: { thread: id }, state: ["running", "paused"] } });
	const found: { sandboxId: string }[] = [];
	while (paginator.hasNext) found.push(...(await paginator.nextItems()));
	return found;
}

async function clientsOf(id: string): Promise<string[]> {
	const names = await new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL }).names();
	return names.filter(name => name.endsWith(`-${id}`));
}

interface CreateOptions {
	/** A setup tar.gz to ship. */
	setup?: string;
	/** Fields merged over the request part. */
	request?: Json;
	/** Extra request headers (an `Idempotency-Key`). */
	headers?: Record<string, string>;
}

/** Posts a create request (prompt `hello`, full-history `source`, optional `conversation` archive); returns the response as it is. */
function postThread(handoff: string, bundle: string, conversation: string | null, options: CreateOptions = {}): Promise<Response> {
	const request = {
		prompt: "hello",
		model: "",
		repo: { name: "scenario", baseRef: "", baseCommit: "", handoffCommit: handoff, localBranch: "main" },
		paths: { home: "", workspace: "" },
		author: { name: "Scenario", email: "scenario@example.com" },
		...options.request,
	};
	const form = new FormData();
	form.append("request", JSON.stringify(request));
	form.append("source", Bun.file(bundle), "source.bundle");
	if (conversation !== null) form.append("conversation", Bun.file(conversation), "conversation.tar");
	if (options.setup !== undefined) form.append("setup", Bun.file(options.setup), "setup.tar.gz");
	return fetch(`${origin}/api/v1/threads`, { method: "POST", headers: { ...authHeaders, ...options.headers }, body: form });
}

/** Creates a thread and makes it the current one. */
async function createThread(handoff: string, bundle: string, conversation: string | null, options: CreateOptions = {}): Promise<string> {
	const res = await postThread(handoff, bundle, conversation, options);
	const raw = await res.text();
	if (res.status !== 201) throw new Error(`create: expected 201, got ${res.status} ${raw.slice(0, 300)}`);
	const created = text(obj(JSON.parse(raw), "create").id);
	if (created === "") throw new Error(`create: no thread id in ${raw.slice(0, 300)}`);
	threadId = created;
	createdThreads.push(created);
	return created;
}

/** Deletes the thread and waits until its sandbox and gateway client are gone. */
async function waitGone(id: string): Promise<void> {
	expectEqual("DELETE status", (await api("DELETE", `/threads/${id}`)).status, 202);
	const deadline = Date.now() + 30_000;
	for (;;) {
		const sandboxes = await sandboxesOf(vmonKey ?? "", id);
		const clients = await clientsOf(id);
		if (sandboxes.length === 0 && clients.length === 0) return;
		if (Date.now() >= deadline) {
			throw new Error(`after 30 s: ${sandboxes.length} sandbox(es) left, gateway clients left: ${JSON.stringify(clients)}`);
		}
		await Bun.sleep(POLL_MS);
	}
}

/** One `PUT /settings`: the keys it names change, `null` resets a key to its default. */
async function putSettings(settings: Json): Promise<void> {
	await apiJson("PUT", "/settings", 200, { settings });
}

/** The current thread's open question once it waits with one under `header`. */
async function waitQuestion(what: string, timeoutMs: number, header: string): Promise<Json> {
	const thread = await waitFor(what, timeoutMs, t => t.phase === "waiting" && isRecord(t.question) && t.question.header === header);
	return obj(thread.question, "question");
}

/** Answers `question` of the current thread with the option `label`. */
async function answerQuestion(question: Json, label: string): Promise<void> {
	await apiJson("POST", `/threads/${threadId}/turns/${question.turn}/questions/${question.id}/answer`, 200, { selected: [label] });
}

/** The turn `turnId` has ended, done or failed, and nothing else is queued or running; returns the thread without judging the outcome. */
function waitTurnFinished(turnId: number, timeoutMs: number): Promise<Json> {
	return waitFor(`turn ${turnId} to end`, timeoutMs, t => {
		const latest = latestOf(t);
		return t.phase === "idle" && latest !== null && Number(latest.id) >= turnId;
	});
}

/** Turn `id` of a thread detail. */
function turnOf(thread: Json, id: number): Json {
	const turns = Array.isArray(thread.turns) ? thread.turns : [];
	return obj(turns.find(t => isRecord(t) && t.id === id), `turn ${id}`);
}

/** A request body the scenario feeds by hand, to hold a create open in the middle of its upload. */
function slowBody(): { body: ReadableStream<Uint8Array>; push: (chunk: string) => void; end: () => void } {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return { body, push: chunk => controller?.enqueue(encoder.encode(chunk)), end: () => controller?.close() };
}

/** `value` as a list of objects. */
function rows(value: unknown, label: string): Json[] {
	if (!Array.isArray(value)) throw new Error(`${label}: expected an array, got ${JSON.stringify(value)}`);
	return value.map((item, index) => obj(item, `${label}[${index}]`));
}

/** One call of the API that must be refused: `status`, and an `error` message that contains `message`. */
async function expectRefused(method: string, path: string, status: number, message: string, body?: unknown): Promise<void> {
	const res = await api(method, path, body);
	const raw = await res.text();
	expectEqual(`${method} ${path} status`, res.status, status);
	expectContains(`${method} ${path} error`, text(obj(JSON.parse(raw), `${method} ${path}`).error), message);
}

/** `GET /threads` with a query string (without the `?`). */
async function listThreads(query: string): Promise<{ threads: Json[]; next: string | null; total: number }> {
	const body = await apiJson("GET", `/threads${query === "" ? "" : `?${query}`}`, 200);
	return { threads: rows(body.threads, "threads"), next: typeof body.next === "string" ? body.next : null, total: Number(body.total) };
}

/** One page of a thread's events as JSON. */
async function eventsPage(id: string, query: string): Promise<{ events: Json[]; next: number | null }> {
	const body = await apiJson("GET", `/threads/${id}/events?format=json${query === "" ? "" : `&${query}`}`, 200);
	return { events: rows(body.events, "events"), next: typeof body.next === "number" ? body.next : null };
}

/** The thread's metrics show a turn's work: model requests, and the context use omp reported, against a known window. */
function expectMetrics(thread: Json, label: string): void {
	const metrics = obj(thread.metrics, `${label}: metrics`);
	if (!(Number(metrics.requests) > 0)) throw new Error(`${label}: metrics.requests is not above 0: ${JSON.stringify(metrics.requests)}`);
	const context = obj(metrics.context, `${label}: metrics.context`);
	if (!(Number(context.tokens) > 0)) throw new Error(`${label}: metrics.context.tokens is not above 0: ${JSON.stringify(context)}`);
	if (!(Number(context.window) > 0)) throw new Error(`${label}: metrics.context.window is unknown: ${JSON.stringify(context)}`);
}

async function run(): Promise<void> {
	await report.step("preflight: vmon, gateway, key file", async () => {
		const health = await fetch(`${VMON_URL}/health`);
		expectEqual("vmon /health", health.status, 204);
		const gateway = await fetch(`${GATEWAY_URL}/healthz`);
		expectEqual("gateway /healthz", gateway.status, 200);
		expectContains("gateway /healthz body", await gateway.text(), "ok");
		vmonKey = (await readFile(VMON_KEY_FILE, "utf8")).trim();
		const clients = new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL });
		clientsBefore = await clients.names();
		// Which providers does the gateway serve? Ask it with a temporary client (revoked at once; every other entry is kept). The
		// precondition of J is the broker's logins, not a constant: a fresh host has none.
		const probe = "scenario-gateway-probe";
		const probeToken = await clients.issue(probe);
		try {
			await clients.waitAccepted(probeToken, 45_000);
			const res = await fetch(`${GATEWAY_URL}/v1/models`, { headers: { authorization: `Bearer ${probeToken}` }, signal: AbortSignal.timeout(10_000) });
			if (res.status !== 200) throw new Error(`gateway /v1/models: expected 200, got ${res.status}`);
			const listed = obj(await res.json(), "gateway /v1/models").data;
			const providers = new Set<string>();
			for (const entry of Array.isArray(listed) ? listed : []) {
				const id = isRecord(entry) ? text(entry.id) : "";
				const provider = id.slice(0, Math.max(id.indexOf("/"), 0));
				if (/^[a-z0-9][a-z0-9._-]*$/.test(provider)) providers.add(provider);
			}
			gatewayProviders = [...providers].sort();
		} finally {
			await clients.revoke(probe);
		}
		if (vmonKey === "") throw new Error(`${VMON_KEY_FILE} is empty`);
	});

	const dir = await mkdtemp(join(tmpdir(), "omp-cloud-scenario-"));
	tempDir = dir;
	let handoff = "";
	let bundle = "";
	const remotes = join(dir, "remotes");
	const bareRepo = join(remotes, "app.git");
	const deltaRepo = join(dir, "delta-repo");
	let deltaBase = "";
	let remoteUrl = "";
	let remoteHost = "";

	await report.step("fake provider, source bundle and service", async () => {
		provider = startFakeProvider({ hostname: PROVIDER_HOST, port: 0 });
		const providerUrl = `http://${PROVIDER_HOST}:${provider.port}`;

		const repo = join(dir, "repo");
		await Bun.$`git init -q -b main ${repo}`.quiet();
		await writeFile(join(repo, "README.md"), "# scenario\n");
		await git(repo, "add", "-A");
		await git(repo, "-c", "user.name=Scenario", "-c", "user.email=scenario@example.com", "commit", "-q", "-m", "initial");
		handoff = (await git(repo, "rev-parse", "HEAD")).trim();
		await git(repo, "update-ref", "refs/omp-cloud/handoff", handoff);
		bundle = join(dir, "source.bundle");
		await git(repo, "bundle", "create", bundle, "refs/omp-cloud/handoff");

		// The git remote of L: a bare repository behind git smart HTTP with Basic auth, holding two commits.
		await mkdir(remotes, { recursive: true });
		await git(dir, "init", "-q", "--bare", "-b", "main", bareRepo);
		await git(dir, "init", "-q", "-b", "main", deltaRepo);
		await commitFile(deltaRepo, "a.txt", "one\n", "one");
		deltaBase = await commitFile(deltaRepo, "b.txt", "two\n", "two");
		await git(deltaRepo, "push", "-q", bareRepo, "main");
		const server = serveGitHttp({ root: remotes, password: gitPassword });
		gitServer = server;
		remoteUrl = server.url("app");
		remoteHost = server.host;

		const providers = obj(obj(Bun.YAML.parse(modelsYaml(providerUrl)), "fake models.yml").providers, "providers");
		const config = {
			listen: `127.0.0.1:${listenPort}`,
			apiTokenSha256: createHash("sha256").update(token).digest("hex"),
			dataDir: join(dir, "data"),
			vmon: { url: VMON_URL, keyFile: VMON_KEY_FILE, template: "omp-agent" },
			gateway: { url: GATEWAY_URL, clientsFile: CLIENTS_FILE },
			broker: { url: BROKER_URL, tokenFile: BROKER_TOKEN_FILE },
			mcp: { listen: `${PROVIDER_HOST}:4101` },
			models: { default: "fake/fake-model", direct: { fake: providers.fake } },
			runner: { idleTimeoutSeconds: 4, turnTimeoutSeconds: 300, questionTimeoutSeconds: 120, lifecycleSweepSeconds: 5 },
			git: { hosts: { [remoteHost]: { credential: `!printf %s ${gitPassword}` } } },
		};
		await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2));
		await startService(join(dir, "config.json"), join(dir, "service-1.log"));
	});

	let pid = 0;

	await report.step("A create thread: first turn replies, omp has a pid", async () => {
		await createThread(handoff, bundle, null);
		// The first VM may build the template (any recipe change is a new template): that takes minutes.
		const thread = await waitTurnIdle(1, 900_000);
		expectEqual("reply", text(latestOf(thread)?.reply), "TURN count=1 first=hello");
		const vm = vmOf(thread);
		if (typeof vm?.pid !== "number") throw new Error(`detail vm.pid is not a number: ${JSON.stringify(thread.vm)}`);
		pid = vm.pid;
		expectMetrics(thread, "turn 1");
		const exported = await fetchConversation(dir, threadId ?? "");
		expectEqual("export session id", exported.sessionId, exportSessionId(threadId ?? ""));
		expectContains("export journal", exported.journal, "TURN count=1 first=hello");
	}, () => `thread ${threadId}, pid ${pid}`);
	const id = threadId ?? "";

	await report.step("B ask: question, answer, reply", async () => {
		const turn = await sendMessage("ASK: pick a color");
		const waiting = await waitFor("the question", 120_000, t => t.phase === "waiting" && isRecord(t.question));
		const question = obj(waiting.question, "question");
		expectContains("question text", text(question.text), "pick a color");
		expectEqual("question.kind", question.kind, "ask");
		const asked = Date.parse(text(question.askedAt));
		const expires = Date.parse(text(question.expiresAt));
		if (Number.isNaN(asked) || Number.isNaN(expires)) throw new Error(`the question has no askedAt/expiresAt dates: ${JSON.stringify(question)}`);
		// runner.questionTimeoutSeconds is 120 in this scenario.
		expectEqual("expiresAt - askedAt", expires - asked, 120_000);
		const summary = (await listThreads("")).threads.find(t => t.id === id);
		const listed = obj(summary?.question, "the list summary's question");
		expectEqual("list summary question.kind", listed.kind, "ask");
		expectEqual("list summary question.expiresAt", listed.expiresAt, question.expiresAt);
		await apiJson("POST", `/threads/${id}/turns/${question.turn}/questions/${question.id}/answer`, 200, { selected: ["blue"] });
		const thread = await waitTurnIdle(turn, 120_000);
		const answered = rows(turnOf(thread, turn).questions, "turn questions");
		expectEqual("answered questions", answered.length, 1);
		expectEqual("answered question kind", answered[0]?.kind, "ask");
		expectEqual("answered question expiresAt", answered[0]?.expiresAt, null);
		const reply = text(latestOf(thread)?.reply);
		expectContains("reply", reply, "ANSWER=");
		expectContains("reply", reply, "blue");
	});

	await report.step("C bash: result branch and bundle", async () => {
		const turn = await sendMessage("BASH: printf 'hi\\n' > hello.txt");
		const thread = await waitTurnIdle(turn, 120_000);
		const result = obj(thread.result, "result");
		if (text(result.head) === "") throw new Error(`result.head is empty: ${JSON.stringify(result)}`);
		if (!(Number(result.filesChanged) >= 1)) throw new Error(`result.filesChanged < 1: ${JSON.stringify(result)}`);
		const res = await api("GET", `/threads/${id}/result`);
		expectEqual("GET /result status", res.status, 200);
		expectEqual("X-Omp-Branch", res.headers.get("x-omp-branch"), `omp-cloud/${id}`);
		const saved = join(dir, "result.bundle");
		await writeFile(saved, new Uint8Array(await res.arrayBuffer()));
		const heads = await git(dir, "bundle", "list-heads", saved);
		expectContains("bundle heads", heads, `refs/heads/omp-cloud/${id}`);
		const exported = await fetchConversation(dir, id);
		expectEqual("export session id after the bash turn", exported.sessionId, exportSessionId(id));
		expectContains("export journal", exported.journal, "TURN count=1 first=hello");
		expectContains("export journal", exported.journal, "DONE=");
	}, () => "result head recorded, bundle lists the branch, export holds the new reply");

	await report.step("D idle pause, resume the same omp", async () => {
		const paused = await waitFor("the VM to pause", 90_000, t => vmOf(t)?.state === "paused");
		const before = vmOf(paused)?.pid;
		if (typeof before !== "number") throw new Error(`paused VM has no pid: ${JSON.stringify(paused.vm)}`);
		const turn = await sendMessage("again");
		const thread = await waitTurnIdle(turn, 120_000);
		expectEqual("vm.pid", vmOf(thread)?.pid, before);
		expectContains("reply", text(latestOf(thread)?.reply), "TURN count=");
		pid = before;
	});

	await report.step("E service restart while paused", async () => {
		await waitFor("the VM to pause", 90_000, t => vmOf(t)?.state === "paused");
		await stopService();
		await startService(join(dir, "config.json"), join(dir, "service-2.log"));
		const turn = await sendMessage("after restart");
		const thread = await waitTurnIdle(turn, 180_000);
		expectEqual("vm.pid", vmOf(thread)?.pid, pid);
		expectContains("reply", text(latestOf(thread)?.reply), "TURN count=");
	});

	await report.step("H lost stream: the VM is paused under a running turn", async () => {
		const key = vmonKey ?? "";
		const before = await detail();
		const vm = vmOf(before);
		if (typeof vm?.sandboxId !== "string" || typeof vm.pid !== "number") throw new Error(`no VM to pause: ${JSON.stringify(before.vm)}`);
		const filesBefore = Number(obj(before.result, "result").filesChanged);
		const turn = await sendMessage("BASH: sleep 15; echo hi > lost.txt");
		await waitFor(`turn ${turn} to start`, 120_000, t => {
			const turns = Array.isArray(t.turns) ? t.turns : [];
			return t.phase === "working" && turns.some(item => isRecord(item) && item.id === turn && item.state === "running");
		});
		await Bun.sleep(3000);
		const sandbox = await Sandbox.connect(vm.sandboxId, vmonOptions(key));
		if (!(await sandbox.pause())) throw new Error(`vmon did not pause sandbox ${vm.sandboxId}`);
		const thread = await waitTurnIdle(turn, 150_000);
		expectEqual("vm.pid", vmOf(thread)?.pid, vm.pid);
		const filesAfter = Number(obj(thread.result, "result").filesChanged);
		if (!(filesAfter > filesBefore)) throw new Error(`result.filesChanged did not grow: ${filesBefore} -> ${filesAfter}`);
		const notices = (await readEvents(2000)).filter(e => e.kind === "notice" && e.turn === turn);
		if (!notices.some(e => e.text.includes("lost the connection to the VM"))) {
			throw new Error(`no lost-connection notice for turn ${turn}; notices: ${JSON.stringify(notices.map(e => e.text))}`);
		}
	});

	await report.step("F event stream kinds", async () => {
		const events = await readEvents(2000);
		const kinds = new Set(events.map(e => e.kind));
		const missing = ["vm", "assistant", "tool", "turn_done", "question_asked"].filter(kind => !kinds.has(kind));
		if (missing.length > 0) throw new Error(`missing kinds ${missing.join(", ")}; saw ${[...kinds].join(", ")}`);
		return events.length;
	}, count => `${count} events`);

	await report.step("G delete: sandbox and gateway client are gone", async () => {
		const key = vmonKey ?? "";
		const res = await api("DELETE", `/threads/${id}`);
		expectEqual("DELETE status", res.status, 202);
		const deadline = Date.now() + 30_000;
		for (;;) {
			const sandboxes = await sandboxesOf(key, id);
			const clients = await clientsOf(id);
			if (sandboxes.length === 0 && clients.length === 0) break;
			if (Date.now() >= deadline) {
				throw new Error(`after 30 s: ${sandboxes.length} sandbox(es) left, gateway clients left: ${JSON.stringify(clients)}`);
			}
			await Bun.sleep(POLL_MS);
		}
		expectEqual("detail status after delete", (await api("GET", `/threads/${id}`)).status, 404);
	});

	await report.step("I bad conversation: the thread fails and leaves nothing behind", async () => {
		const key = vmonKey ?? "";
		await writeFile(join(dir, "notes.txt"), "not a session\n");
		const archive = join(dir, "conversation.tar");
		const tar = Bun.spawn(["tar", "-cf", archive, "-C", dir, "notes.txt"], { stdout: "pipe", stderr: "pipe" });
		if ((await tar.exited) !== 0) throw new Error(`tar failed: ${await tar.stderr.text()}`);
		const bad = await createThread(handoff, bundle, archive);
		const thread = await waitFor("the thread to fail", 60_000, t => t.phase === "failed");
		expectContains("thread error", text(thread.error), "the conversation did not unpack");
		const deadline = Date.now() + 30_000;
		for (;;) {
			const sandboxes = await sandboxesOf(key, bad);
			const clients = await clientsOf(bad);
			if (sandboxes.length === 0 && clients.length === 0) break;
			if (Date.now() >= deadline) {
				throw new Error(`after 30 s: ${sandboxes.length} sandbox(es) left, gateway clients left: ${JSON.stringify(clients)}`);
			}
			await Bun.sleep(POLL_MS);
		}
	});

	await report.step("J whoami reports the model patterns and omp version; an unrunnable model is refused", async () => {
		const who = await apiJson("GET", "/whoami", 200);
		const patterns = Array.isArray(who.modelPatterns) ? who.modelPatterns : [];
		for (const expected of ["fake/*", ...gatewayProviders.map(provider => `${provider}/*`)]) {
			if (!patterns.includes(expected)) throw new Error(`whoami.modelPatterns lacks ${expected}: ${JSON.stringify(patterns)}`);
		}
		expectEqual("whoami.ompVersion", who.ompVersion, (await hostOmp()).version);
		const refused = await postThread(handoff, bundle, null, { request: { model: "nosuch/model:high" } });
		expectEqual("create status", refused.status, 409);
		expectEqual(
			"create error",
			text(obj(await refused.json(), "refusal").error),
			"the cloud cannot run nosuch models; log the cloud broker in with /cloud login nosuch",
		);
		const malformed = await postThread(handoff, bundle, null, { request: { model: "no-slash" } });
		expectEqual("malformed model status", malformed.status, 400);
		await malformed.body?.cancel();
	});

	await report.step("K overlays: omp loads them before the service's own; a missing one fails the thread", async () => {
		const key = vmonKey ?? "";
		const setupDir = join(dir, "setup-k");
		await mkdir(join(setupDir, "overlays"), { recursive: true });
		await writeFile(join(setupDir, "config.yml"), "retry:\n  enabled: true\n");
		await writeFile(join(setupDir, "overlays", "extra.yml"), "retry:\n  enabled: true\n");
		const setup = join(dir, "setup-k.tar.gz");
		const tar = Bun.spawn(["tar", "-czf", setup, "-C", setupDir, "config.yml", "overlays"], { stdout: "pipe", stderr: "pipe" });
		if ((await tar.exited) !== 0) throw new Error(`tar failed: ${await tar.stderr.text()}`);

		const good = await createThread(handoff, bundle, null, { setup, request: { configOverlays: ["overlays/extra.yml"] } });
		const thread = await waitTurnIdle(1, 240_000);
		expectEqual("configOverlays", JSON.stringify(thread.configOverlays), JSON.stringify(["overlays/extra.yml"]));
		expectEqual("ompVersion", thread.ompVersion, (await hostOmp()).version);
		const vm = vmOf(thread);
		if (typeof vm?.sandboxId !== "string" || typeof vm.pid !== "number") throw new Error(`no VM: ${JSON.stringify(thread.vm)}`);
		const sandbox = await Sandbox.connect(vm.sandboxId, vmonOptions(key));
		const processes = await sandbox.commands.list();
		const omp = processes.find(p => p.pid === vm.pid);
		if (omp === undefined) throw new Error(`omp pid ${vm.pid} is not in the VM's processes: ${JSON.stringify(processes.map(p => [p.pid, p.cmd]))}`);
		// The runner shell-quotes every argument, so the process may list them as one string.
		const commandLine = [omp.cmd, ...omp.args].join(" ");
		const configs = [...commandLine.matchAll(/--config'?\s+'?([^\s']+)'?/g)].map(match => match[1]);
		expectEqual(
			"omp --config args",
			JSON.stringify(configs),
			JSON.stringify(["/home/user/.omp/agent/overlays/extra.yml", "/home/user/.omp-cloud/config.yml"]),
		);
		await waitGone(good);

		const missing = await createThread(handoff, bundle, null, { setup, request: { configOverlays: ["overlays/missing.yml"] } });
		const failed = await waitFor("the thread to fail", 90_000, t => t.phase === "failed");
		expectContains("thread error", text(failed.error), "the overlay overlays/missing.yml is not in the shipped setup");
		await waitGone(missing);
	});

	await report.step("K2 no memory: a config.yml that turns memory on (the plugin never ships one) still gives the model no memory device", async () => {
		// The needle is a device line omp's system prompt lists only with a memory backend on. Control run on omp 18.12.6 with the overlay's
		// `memory.backend: off` line removed: all 3 requests of this step contained it; with the line, none.
		const needle = "xd://recall";
		const setupDir = join(dir, "setup-k2");
		await mkdir(setupDir, { recursive: true });
		await writeFile(join(setupDir, "config.yml"), "memory:\n  backend: mnemopi\nmnemopi:\n  scoping: per-project-tagged\n");
		const setup = join(dir, "setup-k2.tar.gz");
		const tar = Bun.spawn(["tar", "-czf", setup, "-C", setupDir, "config.yml"], { stdout: "pipe", stderr: "pipe" });
		if ((await tar.exited) !== 0) throw new Error(`tar failed: ${await tar.stderr.text()}`);

		provider?.watch(needle);
		const before = provider?.count ?? 0;
		const memoryless = await createThread(handoff, bundle, null, { setup });
		await waitTurnIdle(1, 240_000);
		const turn = await sendMessage("BASH: echo no-memory");
		await waitTurnIdle(turn, 180_000);
		const requests = (provider?.count ?? 0) - before;
		if (requests < 3) throw new Error(`the two turns made ${requests} model request(s); expected the greeting and the bash call with its result`);
		const found = provider?.seen(needle) ?? 0;
		if (found > 0) {
			const last = (provider?.recentTurns ?? []).map(describeRequest).join("\n  --\n");
			throw new Error(`${found} of ${requests} model request(s) listed ${needle}: the VM's omp ran with memory on\nthe fake model's last turn requests (oldest first):\n${last}`);
		}
		await waitGone(memoryless);
	});

	let delta = "";

	await report.step("L delta handoff: the base history is in the VM, the result bundle is thin", async () => {
		const handoffDelta = await commitFile(deltaRepo, "c.txt", "three\n", "three");
		await git(deltaRepo, "update-ref", "refs/omp-cloud/handoff", handoffDelta);
		const deltaBundle = join(dir, "delta.bundle");
		await git(deltaRepo, "bundle", "create", deltaBundle, "refs/omp-cloud/handoff", `^${deltaBase}`);

		const who = await apiJson("GET", "/whoami", 200);
		const hosts = Array.isArray(who.gitHosts) ? who.gitHosts : [];
		if (!hosts.includes(remoteHost)) throw new Error(`whoami.gitHosts lacks ${remoteHost}: ${JSON.stringify(hosts)}`);

		delta = await createThread(handoffDelta, deltaBundle, null, {
			request: {
				repo: { name: "scenario-delta", remoteURL: remoteUrl, baseRef: "main", baseCommit: deltaBase, handoffCommit: handoffDelta, localBranch: "main" },
			},
		});
		const first = await waitTurnIdle(1, 240_000);
		expectEqual("first reply", text(latestOf(first)?.reply), "TURN count=1 first=hello");
		const repo = obj((await detail()).repo, "repo");
		expectEqual("repo.remoteURL", repo.remoteURL, remoteUrl);
		expectEqual("repo.baseCommit", repo.baseCommit, deltaBase);
		expectEqual("repo.handoffCommit", repo.handoffCommit, handoffDelta);

		// The VM restored the whole history (the base from the service's git cache, the extra commit from the upload): three commits.
		const turn = await sendMessage("BASH: n=$(git log --oneline | wc -l); echo $n > count.txt; echo $n");
		const done = await waitTurnIdle(turn, 120_000);
		expectEqual("commits in the VM", text(latestOf(done)?.reply), "DONE=3");

		const res = await api("GET", `/threads/${delta}/result`);
		expectEqual("GET /result status", res.status, 200);
		expectEqual("X-Omp-Base", res.headers.get("x-omp-base"), deltaBase);
		const saved = join(dir, "delta-result.bundle");
		await writeFile(saved, new Uint8Array(await res.arrayBuffer()));
		const empty = join(dir, "empty-repo");
		await git(dir, "init", "-q", empty);
		const verdict = await git(empty, "bundle", "verify", saved).then(
			() => "verified",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		expectContains("bundle verify in an empty repository", verdict, "prerequisite");
		await git(deltaRepo, "bundle", "verify", saved);
	}, () => `thread ${delta}`);

	await report.step("M push ask: a Push question, answer Push, the branch lands on the remote", async () => {
		await putSettings({ "git.push": "ask" });
		const turn = await sendMessage("BASH: printf 'hi\\n' > hello.txt");
		const question = await waitQuestion("the push question", 120_000, "Push");
		expectContains("push question text", text(question.text), `Push omp-cloud/${delta} to `);
		expectEqual("push question kind", question.kind, "push");
		const labels = (Array.isArray(question.options) ? question.options : []).map(option => text(obj(option, "option").label));
		expectEqual("push question options", JSON.stringify(labels), JSON.stringify(["Push", "Do not push"]));
		await answerQuestion(question, "Push");
		const thread = await waitTurnIdle(turn, 120_000);
		const result = obj(thread.result, "result");
		expectEqual("result.pushed", result.pushed, true);
		expectEqual("result.pushRef", result.pushRef, `omp-cloud/${delta}`);
		expectEqual("result.pushError", result.pushError, "");
		expectEqual("remote branch", await remoteBranch(bareRepo, `omp-cloud/${delta}`), text(result.head));
		const pushed = turnOf(thread, turn);
		expectEqual("turn.pushed", pushed.pushed, true);
		expectEqual("turn.pushRef", pushed.pushRef, `omp-cloud/${delta}`);
		const events = (await readEvents(2000)).filter(e => e.kind === "push").map(e => e.text);
		if (!events.some(e => e.startsWith(`pushed omp-cloud/${delta} to `))) throw new Error(`no "pushed omp-cloud/${delta} to ..." push event: ${JSON.stringify(events)}`);
	});

	await report.step("N push auto: no question, the remote branch follows the new head", async () => {
		const branch = `omp-cloud/${delta}`;
		const before = await remoteBranch(bareRepo, branch);
		await putSettings({ "git.push": "auto" });
		const turn = await sendMessage("BASH: printf 'auto\\n' >> hello.txt");
		const thread = await waitTurnIdle(turn, 120_000);
		const asked = turnOf(thread, turn).questions;
		if (Array.isArray(asked) && asked.length > 0) throw new Error(`an auto push asked: ${JSON.stringify(asked)}`);
		const result = obj(thread.result, "result");
		expectEqual("result.pushed", result.pushed, true);
		expectEqual("result.pushRef", result.pushRef, branch);
		if (text(result.head) === before) throw new Error(`the head did not move: ${before}`);
		expectEqual("remote branch", await remoteBranch(bareRepo, branch), text(result.head));
	});

	// Its own thread (the remote branch of `delta` belongs to O's divergence): a delta handoff, the same remote, `git.push` auto.
	await report.step("N2 signed result: the service re-signs each turn's commits, the VM adopts them, pushes and restores fast-forward", async () => {
		const handoffDelta = (await git(deltaRepo, "rev-parse", "refs/omp-cloud/handoff")).trim();
		const signId = await createThread(handoffDelta, join(dir, "delta.bundle"), null, {
			request: {
				repo: { name: "scenario-sign", remoteURL: remoteUrl, baseRef: "main", baseCommit: deltaBase, handoffCommit: handoffDelta, localBranch: "main" },
			},
		});
		try {
			await waitTurnIdle(1, 240_000);
			const bashTurn = async (file: string): Promise<{ head: string; result: Json }> => {
				const turn = await sendMessage(`BASH: printf '${file}\\n' > ${file}.txt`);
				const result = obj((await waitTurnIdle(turn, 180_000)).result, "result");
				const head = text(result.head);
				if (head === "") throw new Error(`turn ${turn} recorded no head: ${JSON.stringify(result)}`);
				return { head, result };
			};
			const hasSignature = async (sha: string): Promise<boolean> => /^gpgsig/m.test((await git(deltaRepo, "cat-file", "commit", sha)).split("\n\n")[0] ?? "");
			const allowed = join(dir, "allowed-signers");
			const verify = (sha: string): Promise<string> =>
				git(deltaRepo, "-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", sha);
			/** Downloads the stored result bundle and fetches the commits into the delta repository (which holds the base). */
			const fetchResult = async (label: string, head: string): Promise<void> => {
				const res = await api("GET", `/threads/${signId}/result`);
				expectEqual(`${label}: GET /result status`, res.status, 200);
				const saved = join(dir, `sign-${label}.bundle`);
				await writeFile(saved, new Uint8Array(await res.arrayBuffer()));
				const heads = (await git(deltaRepo, "bundle", "list-heads", saved)).trim().split("\n");
				const ref = heads.map(line => line.split(" ")).find(([sha]) => sha === head)?.[1];
				if (ref === undefined) throw new Error(`${label}: the result bundle holds no ref at ${head}: ${JSON.stringify(heads)}`);
				await git(deltaRepo, "fetch", "-q", saved, `+${ref}:refs/scn/${label}`);
				expectEqual(`${label}: fetched head`, (await git(deltaRepo, "rev-parse", `refs/scn/${label}`)).trim(), head);
			};

			// Unsigned first: git.sign is off, the head is pushed as the VM made it.
			await putSettings({ "git.push": "auto", "git.sign": "off" });
			const unsigned = await bashTurn("sign-u");
			expectEqual("unsigned: result.pushed", unsigned.result.pushed, true);
			const branch = text(unsigned.result.pushRef);
			expectEqual("unsigned: remote branch", await remoteBranch(bareRepo, branch), unsigned.head);
			await fetchResult("unsigned", unsigned.head);
			if (await hasSignature(unsigned.head)) throw new Error(`the head ${unsigned.head} carries a signature with git.sign off`);

			// A key, git.sign ssh: only this turn's commits are signed, and the push is a fast-forward of the unsigned head.
			const created = await apiJson("POST", "/signing/key", 201);
			const publicKey = text(created.publicKey);
			if (!publicKey.startsWith("ssh-ed25519 ")) throw new Error(`POST /signing/key: unexpected public key ${JSON.stringify(created)}`);
			expectContains("POST /signing/key fingerprint", text(created.fingerprint), "SHA256:");
			await expectRefused("POST", "/signing/key", 409, "a signing key exists");
			const shown = await apiJson("GET", "/signing", 200);
			expectEqual("GET /signing publicKey", shown.publicKey, publicKey);
			await writeFile(allowed, `omp-cloud ${publicKey}\n`);
			await putSettings({ "git.sign": "ssh" });
			const who = obj((await apiJson("GET", "/whoami", 200)).github, "whoami.github");
			expectEqual("whoami.github.signing", who.signing, true);

			const first = await bashTurn("sign-1");
			expectEqual("signed 1: result.pushed", first.result.pushed, true);
			expectEqual("signed 1: result.pushError", first.result.pushError, "");
			await fetchResult("signed1", first.head);
			const ahead = (await git(deltaRepo, "rev-list", first.head, `^${unsigned.head}`)).trim().split("\n").filter(sha => sha !== "");
			if (ahead.length === 0) throw new Error(`the signed head ${first.head} adds no commit over the unsigned ${unsigned.head}`);
			for (const sha of ahead) await verify(sha);
			await git(deltaRepo, "merge-base", "--is-ancestor", unsigned.head, first.head);
			if (!(await hasSignature(first.head))) throw new Error(`the head ${first.head} is not signed`);
			if (await hasSignature(unsigned.head)) throw new Error(`the earlier unsigned commit ${unsigned.head} was rewritten`);
			expectEqual("signed 1: remote branch", await remoteBranch(bareRepo, branch), first.head);
			const signEvents = (await readEvents(2000)).filter(e => e.kind === "sign").map(e => e.text);
			if (!signEvents.some(e => /^signed \d+ commits? with SHA256:/.test(e))) throw new Error(`no "signed <n> commit(s) with SHA256:..." sign event: ${JSON.stringify(signEvents)}`);

			// The VM adopted the signed tip: the next turn's commit sits on it, and is signed too.
			const second = await bashTurn("sign-2");
			expectEqual("signed 2: result.pushed", second.result.pushed, true);
			await fetchResult("signed2", second.head);
			expectEqual("signed 2: first parent", (await git(deltaRepo, "rev-parse", `${second.head}^1`)).trim(), first.head);
			await verify(second.head);
			expectEqual("signed 2: remote branch", await remoteBranch(bareRepo, branch), second.head);

			// Restore: the sandbox is killed, the new VM is rebuilt from the stored (signed) bundle and pushes a fast-forward.
			const lost = text(obj(vmOf(await detail()), "vm").sandboxId);
			if (lost === "") throw new Error("the signing thread has no sandbox to kill");
			await Sandbox.kill(lost, vmonOptions(vmonKey ?? ""));
			const restored = await bashTurn("sign-3");
			expectEqual("restored: result.pushed", restored.result.pushed, true);
			expectEqual("restored: result.pushError", restored.result.pushError, "");
			await fetchResult("restored", restored.head);
			await git(deltaRepo, "merge-base", "--is-ancestor", second.head, restored.head);
			await verify(restored.head);
			expectEqual("restored: remote branch", await remoteBranch(bareRepo, branch), restored.head);
			await git(bareRepo, "merge-base", "--is-ancestor", second.head, restored.head);
			const notices = (await readEvents(2000)).filter(e => e.kind === "notice" && e.text.includes("not signed")).map(e => e.text);
			if (notices.length > 0) throw new Error(`signing failed: ${JSON.stringify(notices)}`);
		} finally {
			// git.push stays `auto`, as N left it (O needs it); the key goes, so a later step cannot sign.
			await putSettings({ "git.sign": null });
			await api("DELETE", "/signing/key");
			threadId = delta;
		}
		// Deleting the thread kills its sandbox, whose address the paused VM of `delta` may hold: O resumes that VM, which must not hang.
		await waitGone(signId);
		const gone = await apiJson("GET", "/signing", 200);
		expectEqual("GET /signing publicKey after DELETE /signing/key", gone.publicKey, null);
	}, () => `thread ${threadId}`);

	// Its own thread, as N2's: the same remote, `git.push` auto (N left it), now read-only and shipping an MCP server.
	await report.step("N3 read-only: a read-only thread's change is not pushed and its VM gets no MCP server", async () => {
		const handoffDelta = (await git(deltaRepo, "rev-parse", "refs/omp-cloud/handoff")).trim();
		const readOnlyId = await createThread(handoffDelta, join(dir, "delta.bundle"), null, {
			request: {
				repo: { name: "scenario-readonly", remoteURL: remoteUrl, baseRef: "main", baseCommit: deltaBase, handoffCommit: handoffDelta, localBranch: "main" },
				policy: { readOnly: true },
				mcp: [{ name: "probe", type: "stdio", command: "true" }],
			},
		});
		try {
			await waitTurnIdle(1, 240_000);
			const turn = await sendMessage("BASH: printf 'ro\\n' > ro.txt && test ! -e ~/.omp/agent/mcp.json && grep -q '^- Read-only:' ~/.omp-cloud/system-prompt.md && echo read-only-ok");
			const done = await waitTurnIdle(turn, 180_000);
			expectEqual("reply", text(latestOf(done)?.reply), "DONE=read-only-ok");
			const result = obj(done.result, "result");
			expectEqual("result.pushed", result.pushed, false);
			expectEqual("result.pushRef", result.pushRef, "");
			expectEqual("remote branch", await remoteBranch(bareRepo, `omp-cloud/${readOnlyId}`), "");
			expectEqual("turn questions", rows(turnOf(done, turn).questions, "turn questions").length, 0);
			const events = await readEvents(2000);
			const pushEvents = events.filter(e => e.kind === "push").map(e => e.text);
			if (!pushEvents.includes("not pushed: the thread is read-only")) throw new Error(`no "not pushed: the thread is read-only" push event: ${JSON.stringify(pushEvents)}`);
			const vmEvents = events.filter(e => e.kind === "vm").map(e => e.text);
			if (!vmEvents.some(e => e.startsWith("MCP servers not delivered: the thread is read-only"))) {
				throw new Error(`no "MCP servers not delivered: the thread is read-only" vm event: ${JSON.stringify(vmEvents)}`);
			}
			expectEqual("detail().policy", JSON.stringify((await detail()).policy), JSON.stringify({ readOnly: true }));
		} finally {
			threadId = delta;
		}
		// Deleting the thread kills its sandbox, whose address the paused VM of `delta` may hold: O resumes that VM, which must not hang.
		await waitGone(readOnlyId);
	}, () => `thread ${threadId}`);

	await report.step("O push refusals: a protected branch, then a diverged remote branch", async () => {
		const branch = `omp-cloud/${delta}`;
		const pushedHead = await remoteBranch(bareRepo, branch);

		await putSettings({ "git.protected": ["omp-cloud/*"] });
		const protectedTurn = await sendMessage("BASH: printf 'o1\\n' > o1.txt");
		const refused = obj((await waitTurnIdle(protectedTurn, 120_000)).result, "result");
		expectEqual("protected: result.pushed", refused.pushed, false);
		expectContains("protected: result.pushError", text(refused.pushError), "refusing to push to protected branch");
		expectEqual("protected: remote branch", await remoteBranch(bareRepo, branch), pushedHead);
		await putSettings({ "git.protected": null });

		// Someone commits to the pushed branch on the remote: the cloud's next head no longer fast-forwards it.
		const scratch = join(dir, "scratch-clone");
		await git(dir, "clone", "-q", bareRepo, scratch);
		await git(scratch, "checkout", "-q", "-b", branch, `origin/${branch}`);
		const diverged = await commitFile(scratch, "diverged.txt", "elsewhere\n", "diverged");
		await git(scratch, "push", "-q", "origin", branch);
		await rm(scratch, { recursive: true, force: true });

		const divergedTurn = await sendMessage("BASH: printf 'o2\\n' > o2.txt");
		const thread = await waitTurnIdle(divergedTurn, 120_000);
		const result = obj(thread.result, "result");
		expectEqual("diverged: result.pushed", result.pushed, false);
		expectContains("diverged: result.pushError", text(result.pushError), "not force-pushing");
		expectEqual("diverged: remote branch", await remoteBranch(bareRepo, branch), diverged);
		const events = (await readEvents(2000)).filter(e => e.kind === "push").map(e => e.text);
		if (!events.some(e => e.startsWith("push failed: "))) throw new Error(`no "push failed: ..." push event: ${JSON.stringify(events)}`);
		await putSettings({ "git.push": null });
	});

	await report.step("P cold restore: a killed sandbox is replaced by a new VM holding the thread's work", async () => {
		const key = vmonKey ?? "";
		const lost = text(obj(vmOf(await detail()), "vm").sandboxId);
		if (lost === "") throw new Error("the thread has no sandbox to kill");
		await Sandbox.kill(lost, vmonOptions(key));

		const turn = await sendMessage("BASH: cat hello.txt");
		const thread = await waitTurnIdle(turn, 300_000);
		expectEqual("reply", text(latestOf(thread)?.reply), "DONE=hi");
		const vm = obj(vmOf(thread), "vm");
		if (text(vm.sandboxId) === "" || vm.sandboxId === lost) throw new Error(`the thread still runs in the lost sandbox ${lost}: ${JSON.stringify(vm)}`);
		const sandboxes = await sandboxesOf(key, delta);
		expectEqual("sandboxes of the thread", JSON.stringify(sandboxes.map(s => s.sandboxId)), JSON.stringify([vm.sandboxId]));
		expectEqual("gateway clients of the thread", (await clientsOf(delta)).length, 1);
		const lostEvents = (await readEvents(2000)).filter(e => e.kind === "vm" && e.text.includes("the VM was lost"));
		if (lostEvents.length === 0) throw new Error("no vm event says the VM was lost");

		// The conversation came along: the model of the new VM sees the first message of the old one, and the export keeps its id.
		const next = await sendMessage("and again");
		const again = await waitTurnIdle(next, 120_000);
		const reply = text(latestOf(again)?.reply);
		if (!/^TURN count=\d+ first=hello$/.test(reply)) throw new Error(`the reply is not "TURN count=<n> first=hello": ${JSON.stringify(reply)}`);
		const exported = await fetchConversation(dir, delta);
		expectEqual("export session id", exported.sessionId, exportSessionId(delta));
	}, () => `thread ${delta}`);

	await report.step("P2 archive: the sweep releases an idle thread's VM; the next message restores it with its work", async () => {
		const key = vmonKey ?? "";
		const before = await detail();
		expectMetrics(before, "before the archive");
		const latest = obj(latestOf(before), "latest");
		const lastTurn = turnOf(before, Number(latest.id));
		if (!(Number(lastTurn.requests) > 0)) throw new Error(`the last turn counted no requests: ${JSON.stringify(lastTurn.requests)}`);
		const turnContext = obj(lastTurn.context, "the last turn's context");
		if (!(Number(turnContext.tokens) > 0)) throw new Error(`the last turn has no context reading: ${JSON.stringify(lastTurn.context)}`);
		const oldSandbox = text(obj(vmOf(before), "vm").sandboxId);
		if (oldSandbox === "") throw new Error("the thread has no sandbox to archive");

		// The sweep runs every 5 s and reads the setting live: a fraction of a second idle is enough.
		await putSettings({ "lifecycle.archiveAfterDays": 0.00001 });
		let archived: Json;
		try {
			archived = await waitFor("the thread to be archived and its VM released", 120_000, t => text(t.archivedAt) !== "" && vmOf(t) === null);
		} finally {
			await putSettings({ "lifecycle.archiveAfterDays": null });
		}
		expectEqual("phase", archived.phase, "idle");
		expectEqual("sandboxes of the archived thread", (await sandboxesOf(key, delta)).length, 0);
		expectEqual("gateway clients of the archived thread", (await clientsOf(delta)).length, 0);
		expectMetrics(archived, "archived");
		const archiveEvents = (await readEvents(2000)).filter(e => e.kind === "vm" && e.text.startsWith("archived after"));
		if (archiveEvents.length === 0) throw new Error("no vm event says the thread was archived");

		// The next message restores the thread on a new VM: the work is there and the conversation goes on.
		const turn = await sendMessage("BASH: cat hello.txt");
		const thread = await waitTurnIdle(turn, 300_000);
		expectEqual("reply", text(latestOf(thread)?.reply), "DONE=hi");
		expectEqual("archivedAt after the restore", thread.archivedAt, null);
		const vm = obj(vmOf(thread), "vm");
		if (text(vm.sandboxId) === "" || vm.sandboxId === oldSandbox) throw new Error(`the thread did not get a new VM: ${JSON.stringify(vm)}`);
		expectEqual("sandboxes of the thread", JSON.stringify((await sandboxesOf(key, delta)).map(s => s.sandboxId)), JSON.stringify([vm.sandboxId]));
		expectEqual("gateway clients of the thread", (await clientsOf(delta)).length, 1);
		const restoreEvents = (await readEvents(2000)).filter(e => e.kind === "vm" && e.text === "restoring from the archive");
		if (restoreEvents.length === 0) throw new Error("no vm event says the thread was restored from the archive");
		expectMetrics(thread, "after the restore");

		const next = await sendMessage("and once more");
		const again = text(latestOf(await waitTurnIdle(next, 120_000))?.reply);
		if (!/^TURN count=\d+ first=hello$/.test(again)) throw new Error(`the reply is not "TURN count=<n> first=hello": ${JSON.stringify(again)}`);
		await waitGone(delta);
	}, () => `thread ${delta}`);

	let policyThread = "";

	await report.step("Q approval relay: Approve runs the command, Deny blocks it; the git guard blocks git push", async () => {
		await putSettings({ "policy.bash.patterns": [{ match: "touch /tmp/approve*", approval: "prompt" }] });
		try {
			policyThread = await createThread(handoff, bundle, null);
			await waitTurnIdle(1, 240_000);

			const approve = await sendMessage("BASH: touch /tmp/approve-yes");
			const asked = await waitQuestion("the approval question", 120_000, "Approval");
			expectContains("approval question text", text(asked.text), "Allow tool: bash");
			expectEqual("approval question kind", asked.kind, "approval");
			const labels = (Array.isArray(asked.options) ? asked.options : []).map(option => text(obj(option, "option").label));
			expectEqual("approval options", JSON.stringify(labels), JSON.stringify(["Approve", "Deny"]));
			await answerQuestion(asked, "Approve");
			const approved = text(latestOf(await waitTurnIdle(approve, 120_000))?.reply);
			if (!approved.startsWith("DONE=") || approved.startsWith("DONE=Tool call denied")) throw new Error(`an approved call was not run: ${JSON.stringify(approved)}`);
			const made = await waitTurnIdle(await sendMessage("BASH: ls /tmp/approve-yes"), 120_000);
			expectEqual("the approved file", text(latestOf(made)?.reply), "DONE=/tmp/approve-yes");

			const deny = await sendMessage("BASH: touch /tmp/approve-no");
			const refused = await waitQuestion("the second approval question", 120_000, "Approval");
			await answerQuestion(refused, "Deny");
			expectEqual("a denied call", text(latestOf(await waitTurnIdle(deny, 120_000))?.reply), "DONE=Tool call denied by user: bash");
			const absent = await waitTurnIdle(await sendMessage("BASH: ls /tmp/approve-no"), 120_000);
			expectContains("the denied file", text(latestOf(absent)?.reply), "No such file");

			const pushed = await waitTurnIdle(await sendMessage("BASH: git push origin main"), 120_000);
			expectEqual("the git guard", text(latestOf(pushed)?.reply), 'DONE=Tool "bash" is blocked by tool policy.');
		} finally {
			await putSettings({ "policy.bash.patterns": null });
		}
	}, () => `thread ${policyThread}`);

	await report.step("R spend cap: the turn is aborted and fails with the cap error", async () => {
		threadId = policyThread;
		await putSettings({ "policy.spend.turnUSD": 0.1 });
		try {
			const startedTurn = Date.now();
			const turn = await sendMessage("BASH: sleep 20");
			const thread = await waitTurnFinished(turn, 120_000);
			const elapsed = Date.now() - startedTurn;
			const latest = obj(thread.latest, "latest");
			expectEqual("turn state", latest.state, "failed");
			if (!text(latest.error).startsWith("spend cap reached: turn")) throw new Error(`the turn error is not a turn spend cap: ${JSON.stringify(latest.error)}`);
			if (elapsed >= 18_000) throw new Error(`the turn ran ${elapsed} ms: the cap did not abort it before sleep 20 ended`);
		} finally {
			await putSettings({ "policy.spend.turnUSD": null });
		}
		// The cap is read live and the abort left omp usable.
		const again = await waitTurnIdle(await sendMessage("again"), 120_000);
		expectContains("reply after the cap", text(latestOf(again)?.reply), "TURN count=");
		await waitGone(policyThread);
	});

	await report.step("S egress: a new VM reaches its model but not the internet", async () => {
		await putSettings({ "policy.egress": ["example.com"] });
		try {
			const egress = await createThread(handoff, bundle, null);
			const first = await waitTurnIdle(1, 240_000);
			expectEqual("first reply", text(latestOf(first)?.reply), "TURN count=1 first=hello");
			const probe = await sendMessage("BASH: if curl -s -m 5 -o /dev/null http://1.1.1.1/ 2>/dev/null; then echo reachable; else echo blocked; fi");
			expectEqual("the internet", text(latestOf(await waitTurnIdle(probe, 120_000))?.reply), "DONE=blocked");
			await waitGone(egress);
		} finally {
			await putSettings({ "policy.egress": null });
		}
	});

	await report.step("T models policy: a model outside policy.models.allowed is refused", async () => {
		await putSettings({ "policy.models.allowed": ["anthropic/*"] });
		try {
			const named = await postThread(handoff, bundle, null, { request: { model: "fake/fake-model" } });
			expectEqual("create status", named.status, 409);
			expectEqual("create error", text(obj(await named.json(), "refusal").error), "the cloud policy does not allow fake/fake-model");
			const defaulted = await postThread(handoff, bundle, null);
			expectEqual("default model status", defaulted.status, 409);
			expectContains("default model error", text(obj(await defaulted.json(), "refusal").error), "does not allow fake/fake-model");
		} finally {
			await putSettings({ "policy.models.allowed": null });
		}
	});

	await report.step("U thread policy: a thread tightens the policy and never loosens it", async () => {
		const policy = { "bash.patterns": [{ match: "touch /tmp/thread-deny*", approval: "deny" }], fetch: false };
		const tightened = await createThread(handoff, bundle, null, { request: { policy } });
		await waitTurnIdle(1, 240_000);
		const blocked = await waitTurnIdle(await sendMessage("BASH: touch /tmp/thread-deny-x"), 120_000);
		expectEqual("the thread's deny rule", text(latestOf(blocked)?.reply), 'DONE=Tool "bash" is blocked by tool policy.');
		expectEqual("the thread's policy", JSON.stringify((await detail()).policy), JSON.stringify(policy));

		await putSettings({ "policy.egress": ["example.com"] });
		try {
			const widened = await postThread(handoff, bundle, null, { request: { policy: { egress: ["example.com", "evil.test"] } } });
			expectEqual("widening egress status", widened.status, 400);
			expectEqual("widening egress error", text(obj(await widened.json(), "refusal").error), "policy.egress of a thread may only narrow the service's list");
		} finally {
			await putSettings({ "policy.egress": null });
		}

		const unknown = await postThread(handoff, bundle, null, { request: { policy: { nope: 1 } } });
		expectEqual("unknown policy key status", unknown.status, 400);
		expectEqual("unknown policy key error", text(obj(await unknown.json(), "refusal").error), "unknown policy key nope");
		await waitGone(tightened);
	});

	await report.step("V slash command: a built-in's output is the reply, the model is never asked", async () => {
		const slash = await createThread(handoff, bundle, null);
		const first = await waitTurnIdle(1, 240_000);
		const headOf = (t: Json): string => (isRecord(t.result) ? text(t.result.head) : "");
		const headBefore = headOf(first);
		const requestsBefore = provider?.count ?? 0;

		const startedAt = Date.now();
		const turn = await sendMessage("/session info");
		const thread = await waitTurnIdle(turn, 25_000);
		const elapsed = Date.now() - startedAt;
		// The runner's lost-frame poll runs every 30 s: a turn that ended earlier ended on omp's answer.
		if (elapsed >= 20_000) throw new Error(`the command turn took ${elapsed} ms: it ended on the poll, not on omp's answer`);
		const reply = text(latestOf(thread)?.reply);
		if (!/^Session: \S+/.test(reply)) throw new Error(`the reply does not name the session: ${JSON.stringify(reply)}`);
		expectContains("session reply", reply, "CWD:");
		expectEqual("model requests during the command", (provider?.count ?? 0) - requestsBefore, 0);
		const latest = obj(latestOf(thread), "latest");
		expectEqual("turn state", latest.state, "done");
		const turnDetail = turnOf(thread, turn);
		expectEqual("requests of the command turn", turnDetail.requests, 0);
		expectEqual("head after the command", headOf(thread), headBefore);

		// Another built-in, and then an ordinary turn: the thread goes on as usual.
		const usage = await waitTurnIdle(await sendMessage("/usage"), 25_000);
		expectEqual("/usage turn state", obj(latestOf(usage), "latest").state, "done");
		if (text(latestOf(usage)?.reply) === "") throw new Error("the /usage reply is empty");
		const after = await waitTurnIdle(await sendMessage("and a question for the model"), 120_000);
		expectContains("model reply after the commands", text(latestOf(after)?.reply), "TURN count=");
		await waitGone(slash);
	});

	// Create, inspection and list. One scratch thread carries W to AB, AC lists it among others and AD ends it.
	const SCRATCH_REF = "scn-scratch";
	const SCRATCH_SESSION = "scn-session-1";
	const scratchKey = `scn-${randomBytes(6).toString("hex")}`;
	const scratchPrompt = "BASH: mkdir -p docs && printf 'hello scratch\\n' > docs/note.txt && printf 'top\\n' > top.txt";
	const scratchRequest = (prompt: string): Json => ({
		prompt,
		model: "",
		repo: { scratch: true },
		paths: { home: "", workspace: "" },
		author: { name: "Scenario", email: "scenario@example.com" },
		origin: "tool",
		ref: SCRATCH_REF,
		session: SCRATCH_SESSION,
	});
	const postJson = (headers: Record<string, string>, body: string): Promise<Response> =>
		fetch(`${origin}/api/v1/threads`, { method: "POST", headers: { ...authHeaders, "content-type": "application/json", ...headers }, body });
	let scratchId = "";

	await report.step("W idempotent create: malformed key 400, duplicate during the upload 409, finished scratch create 201, replays 200", async () => {
		const malformed = await postJson({ "idempotency-key": "bad key!" }, "{}");
		expectEqual("malformed key status", malformed.status, 400);
		expectContains("malformed key error", text(obj(await malformed.json(), "refusal").error), "Idempotency-Key");

		// The first create stays open in the middle of its upload while a duplicate arrives.
		const boundary = "scenario-scratch-boundary";
		const upload = slowBody();
		const request = JSON.stringify(scratchRequest(scratchPrompt));
		const cut = Math.floor(request.length / 2);
		const first = fetch(`${origin}/api/v1/threads`, {
			method: "POST",
			headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": scratchKey },
			body: upload.body,
			duplex: "half",
		});
		upload.push(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n${request.slice(0, cut)}`);
		await Bun.sleep(500);
		// Before the service has claimed the key a duplicate is only a plain create that fails as 400 and frees the key again.
		let inProgress = "";
		for (let attempt = 0; inProgress === ""; attempt++) {
			const duplicate = await postJson({ "idempotency-key": scratchKey }, "{}");
			const raw = await duplicate.text();
			if (duplicate.status === 409) inProgress = text(obj(JSON.parse(raw), "duplicate").error);
			else if (duplicate.status !== 400 || attempt >= 40) throw new Error(`a duplicate during the upload: expected 409, got ${duplicate.status} ${raw.slice(0, 200)}`);
			else await Bun.sleep(250);
		}
		expectEqual("in-progress error", inProgress, "a request with this Idempotency-Key is still in progress");
		upload.push(`${request.slice(cut)}\r\n--${boundary}--\r\n`);
		upload.end();
		const res = await first;
		const raw = await res.text();
		if (res.status !== 201) throw new Error(`the finished create: expected 201, got ${res.status} ${raw.slice(0, 300)}`);
		const created = obj(JSON.parse(raw), "create");
		scratchId = text(created.id);
		if (scratchId === "") throw new Error(`create: no thread id in ${raw.slice(0, 300)}`);
		threadId = scratchId;
		createdThreads.push(scratchId);
		expectEqual("created.scratch", created.scratch, true);
		expectEqual("created.origin", created.origin, "tool");
		expectEqual("created.ref", created.ref, SCRATCH_REF);
		expectEqual("created.session", created.session, SCRATCH_SESSION);
		expectEqual("created.replayed", created.replayed === true, false);

		// The key is bound to the prompt. A replay is multipart (the service reads the `request` part to compare) and reads nothing else.
		const notMultipart = await postJson({ "idempotency-key": scratchKey }, "not even json");
		expectEqual("non-multipart replay status", notMultipart.status, 400);
		expectContains("non-multipart replay error", text(obj(await notMultipart.json(), "refusal").error), "multipart");
		const form = new FormData();
		form.append("request", JSON.stringify(scratchRequest(scratchPrompt)));
		const again = await fetch(`${origin}/api/v1/threads`, { method: "POST", headers: { ...authHeaders, "idempotency-key": scratchKey }, body: form });
		expectEqual("same-prompt replay status", again.status, 200);
		const againBody = obj(await again.json(), "same-prompt replay");
		expectEqual("same-prompt replay id", againBody.id, scratchId);
		expectEqual("same-prompt replay.replayed", againBody.replayed, true);
		const other = new FormData();
		other.append("request", JSON.stringify(scratchRequest("a prompt that never runs")));
		const different = await fetch(`${origin}/api/v1/threads`, { method: "POST", headers: { ...authHeaders, "idempotency-key": scratchKey }, body: other });
		expectEqual("different-prompt status", different.status, 409);
		expectEqual("different-prompt error", text(obj(await different.json(), "refusal").error), `Idempotency-Key ${scratchKey} was used for a different request (thread ${scratchId})`);
		expectEqual("threads with the ref", (await listThreads(`ref=${SCRATCH_REF}`)).total, 1);
		expectEqual("turns after the replays", rows((await detail()).turns, "turns").length, 1);
		return scratchId;
	}, id => `thread ${id}`);

	await report.step("X inspection before a result: head views are 404 `no result yet`, the base is served", async () => {
		const base = `/threads/${scratchId}`;
		for (const path of ["/diff", "/diff?stat=1", "/tree", "/tree?recursive=1", "/files/top.txt"]) {
			await expectRefused("GET", `${base}${path}`, 404, "no result yet");
		}
		await expectRefused("GET", `${base}/diff?turn=1`, 404, "recorded no head");
		await expectRefused("GET", `${base}/diff?turn=9`, 404, "no turn 9");
		await expectRefused("GET", `${base}/files/top.txt?ref=base`, 404, "no such file");
		await expectRefused("GET", `${base}/files/top.txt?ref=nowhere`, 400, "ref");
		await expectRefused("GET", "/threads/nosuchthread/diff", 404, "not found");
		const tree = await apiJson("GET", `${base}/tree?ref=base`, 200);
		expectEqual("base tree ref", tree.ref, "base");
		expectEqual("base tree commit", tree.commit, text(obj((await detail()).repo, "repo").handoffCommit));
		expectEqual("base tree entries", rows(tree.entries, "entries").length, 0);
		expectEqual("base tree truncated", tree.truncated, false);
	});

	await report.step("Y scratch thread end to end: diff, tree and files show the agent's work, result downloads, nothing is pushed", async () => {
		threadId = scratchId;
		const done = await waitTurnIdle(1, 240_000);
		expectContains("turn 1 reply", text(latestOf(done)?.reply), "DONE=");
		expectEqual("scratch", done.scratch, true);
		const repo = obj(done.repo, "repo");
		expectEqual("repo.name", repo.name, "scratch");
		expectEqual("repo.remoteURL", repo.remoteURL, "");
		const baseCommit = text(repo.handoffCommit);
		const result = obj(done.result, "result");
		const head = text(result.head);
		if (head === "" || baseCommit === "") throw new Error(`no head or base commit: ${JSON.stringify({ head, baseCommit })}`);
		expectEqual("result files/insertions/deletions", `${result.filesChanged}/${result.insertions}/${result.deletions}`, "2/2/0");
		expectEqual("result.pushed", result.pushed, false);
		expectEqual("result.pushRef", result.pushRef, "");
		const base = `/threads/${scratchId}`;

		// diff: stat, text, a path, a cut
		const stat = await apiJson("GET", `${base}/diff?stat=1`, 200);
		expectEqual("stat.base", stat.base, baseCommit);
		expectEqual("stat.head", stat.head, head);
		const changed = rows(stat.files, "stat files").map(f => `${f.status} ${f.path} +${f.insertions} -${f.deletions}`).sort();
		expectEqual("stat files", JSON.stringify(changed), JSON.stringify(["A docs/note.txt +1 -0", "A top.txt +1 -0"]));
		expectEqual("stat insertions/deletions", `${stat.insertions}/${stat.deletions}`, "2/0");
		const diff = await api("GET", `${base}/diff`);
		expectEqual("diff status", diff.status, 200);
		expectContains("diff content-type", diff.headers.get("content-type"), "text/plain");
		expectEqual("X-Omp-Base", diff.headers.get("x-omp-base"), baseCommit);
		expectEqual("X-Omp-Head", diff.headers.get("x-omp-head"), head);
		expectEqual("X-Omp-Truncated on a whole diff", diff.headers.get("x-omp-truncated"), null);
		const patch = await diff.text();
		for (const expected of ["docs/note.txt", "top.txt", "+hello scratch"]) expectContains("the diff", patch, expected);
		const narrowed = await (await api("GET", `${base}/diff?path=docs`)).text();
		expectContains("the diff of docs", narrowed, "docs/note.txt");
		expectEqual("the diff of docs holds top.txt", narrowed.includes("top.txt"), false);
		const cutDiff = await api("GET", `${base}/diff?maxBytes=60`);
		expectEqual("cut diff status", cutDiff.status, 200);
		expectEqual("X-Omp-Truncated is the full length", cutDiff.headers.get("x-omp-truncated"), String(Buffer.byteLength(patch)));
		if ((await cutDiff.arrayBuffer()).byteLength > 60) throw new Error("the cut diff is longer than maxBytes");

		// tree: the root, recursive, a directory, refusals
		const listing = async (query: string): Promise<string[]> => {
			const tree = await apiJson("GET", `${base}/tree${query}`, 200);
			expectEqual(`tree${query} truncated`, tree.truncated, false);
			return rows(tree.entries, "entries").map(e => `${e.type} ${e.path} ${e.size}`).sort();
		};
		const root = await apiJson("GET", `${base}/tree`, 200);
		expectEqual("tree ref", root.ref, "head");
		expectEqual("tree commit", root.commit, head);
		expectEqual("root entries", JSON.stringify(await listing("")), JSON.stringify(["dir docs 0", "file top.txt 4"]));
		expectEqual("recursive entries", JSON.stringify(await listing("?recursive=1")), JSON.stringify(["dir docs 0", "file docs/note.txt 14", "file top.txt 4"]));
		expectEqual("docs entries", JSON.stringify(await listing("?path=docs")), JSON.stringify(["file docs/note.txt 14"]));
		await expectRefused("GET", `${base}/tree?path=nothing`, 404, "no such directory");
		await expectRefused("GET", `${base}/tree?path=top.txt`, 404, "no such directory");
		await expectRefused("GET", `${base}/tree?path=.git`, 400, "");
		await expectRefused("GET", `${base}/tree?path=%2Fetc`, 400, "");

		// files: a whole file, pages, the base, refusals
		const note = await apiJson("GET", `${base}/files/docs/note.txt`, 200);
		expectEqual("file", JSON.stringify([note.path, note.ref, note.commit, note.size, note.binary, note.offset, note.text, note.next]), JSON.stringify(["docs/note.txt", "head", head, 14, false, 0, "hello scratch\n", null]));
		const page = await apiJson("GET", `${base}/files/docs/note.txt?limit=5`, 200);
		expectEqual("first file page", JSON.stringify([page.text, page.next]), JSON.stringify(["hello", 5]));
		const rest = await apiJson("GET", `${base}/files/docs/note.txt?offset=5&limit=100`, 200);
		expectEqual("second file page", JSON.stringify([rest.text, rest.offset, rest.next]), JSON.stringify([" scratch\n", 5, null]));
		await expectRefused("GET", `${base}/files/top.txt?ref=base`, 404, "no such file");
		await expectRefused("GET", `${base}/files/docs`, 404, "no such file");
		await expectRefused("GET", `${base}/files/nothing.txt`, 404, "no such file");
		await expectRefused("GET", `${base}/files/.git/config`, 400, "");

		// result: the bundle carries the branch at the head
		const download = await api("GET", `${base}/result`);
		expectEqual("GET /result status", download.status, 200);
		expectEqual("X-Omp-Branch", download.headers.get("x-omp-branch"), `omp-cloud/${scratchId}`);
		const bundle = join(dir, "scratch-result.bundle");
		await writeFile(bundle, new Uint8Array(await download.arrayBuffer()));
		expectContains("bundle heads", await git(dir, "bundle", "list-heads", bundle), `${head} refs/heads/omp-cloud/${scratchId}`);

		// Even `git.push: auto` never pushes a thread without a remote, and asks nothing; a turn's diff is only its own change.
		await putSettings({ "git.push": "auto" });
		try {
			const turn = await sendMessage("BASH: printf 'more\\n' >> top.txt && printf 'a\\000b\\n' > blob.bin");
			const after = await waitTurnIdle(turn, 120_000);
			expectEqual("questions of an auto-push scratch turn", rows(turnOf(after, turn).questions, "questions").length, 0);
			const pushed = obj(after.result, "result");
			expectEqual("result.pushed after a turn with git.push auto", pushed.pushed, false);
			expectEqual("result.pushRef after a turn with git.push auto", pushed.pushRef, "");
			if (text(pushed.head) === head) throw new Error("the second turn recorded no new head");
			expectEqual("push events", (await eventsPage(scratchId, "kind=push")).events.length, 0);

			const own = await apiJson("GET", `${base}/diff?turn=${turn}&stat=1`, 200);
			expectEqual("turn diff base", own.base, head);
			expectEqual("turn diff head", own.head, text(pushed.head));
			expectEqual("turn diff files", JSON.stringify(rows(own.files, "files").map(f => `${f.status} ${f.path}`).sort()), JSON.stringify(["A blob.bin", "M top.txt"]));
			const ownPatch = await (await api("GET", `${base}/diff?turn=${turn}`)).text();
			expectContains("the turn's diff", ownPatch, "+more");
			expectEqual("the turn's diff holds the first turn's file", ownPatch.includes("hello scratch"), false);
			const everything = await (await api("GET", `${base}/diff`)).text();
			expectContains("the whole diff", everything, "+more");
			expectContains("the whole diff", everything, "+hello scratch");
			const first = await apiJson("GET", `${base}/diff?turn=1&stat=1`, 200);
			expectEqual("turn 1 diff files", rows(first.files, "files").length, 2);

			const top = await apiJson("GET", `${base}/files/top.txt`, 200);
			expectEqual("top.txt after turn 2", top.text, "top\nmore\n");
			const blob = await apiJson("GET", `${base}/files/blob.bin`, 200);
			expectEqual("blob.bin", JSON.stringify([blob.binary, blob.text, blob.next]), JSON.stringify([true, "", null]));
		} finally {
			await putSettings({ "git.push": null });
		}
	});

	await report.step("Z turn text paging and events as JSON", async () => {
		threadId = scratchId;
		const longPrompt = "LONG:3000";
		const turn = await sendMessage(longPrompt);
		await waitTurnIdle(turn, 120_000);
		const replyPath = `/threads/${scratchId}/turns/${turn}/reply`;

		const whole = await apiJson("GET", `${replyPath}?limit=32000`, 200);
		const full = text(whole.text);
		if (full !== longReply(3000)) {
			const requests = (provider?.recentTurns ?? []).map(describeRequest).join("\n  --\n");
			throw new Error(`the reply is not DONE= and 3000 characters of counter: ${JSON.stringify(full.slice(0, 40))} (${full.length} characters)\nthe fake model's last turn requests (oldest first):\n${requests}`);
		}
		expectEqual("whole reply", JSON.stringify([whole.turn, whole.part, whole.total, whole.offset, whole.next]), JSON.stringify([turn, "reply", full.length, 0, null]));
		let collected = "";
		let offset = 0;
		let pages = 0;
		for (;;) {
			const page = await apiJson("GET", `${replyPath}?offset=${offset}&limit=1000`, 200);
			expectEqual("page offset", page.offset, offset);
			expectEqual("page total", page.total, full.length);
			const piece = text(page.text);
			collected += piece;
			pages++;
			if (page.next === null) break;
			expectEqual("page next", page.next, offset + piece.length);
			offset = Number(page.next);
			if (pages > 50) throw new Error("the reply paged past 50 pages");
		}
		expectEqual("paged reply", collected, full);
		if (pages < 4) throw new Error(`a ${full.length} character reply came in ${pages} pages of 1000`);
		const past = await apiJson("GET", `${replyPath}?offset=${full.length}`, 200);
		expectEqual("page past the end", JSON.stringify([past.text, past.next]), JSON.stringify(["", null]));
		const prompt = await apiJson("GET", `${replyPath}?part=text`, 200);
		expectEqual("part=text", JSON.stringify([prompt.text, prompt.total, prompt.next]), JSON.stringify([longPrompt, longPrompt.length, null]));
		const noError = await apiJson("GET", `${replyPath}?part=error`, 200);
		expectEqual("part=error of a finished turn", JSON.stringify([noError.text, noError.total, noError.next]), JSON.stringify(["", 0, null]));
		expectContains("turn 1's reply", text((await apiJson("GET", `/threads/${scratchId}/turns/1/reply`, 200)).text), "DONE=");
		await expectRefused("GET", `${replyPath}?part=bogus`, 400, "part");
		await expectRefused("GET", `${replyPath}?limit=0`, 400, "limit");
		await expectRefused("GET", `${replyPath}?limit=32001`, 400, "limit");
		await expectRefused("GET", `${replyPath}?offset=-1`, 400, "offset");
		await expectRefused("GET", `/threads/${scratchId}/turns/99/reply`, 404, "");

		// events as JSON: every field, pages that join up, the filters, the bounds
		const collect = async (query: string, limit: number): Promise<Json[]> => {
			const events: Json[] = [];
			let after = 0;
			for (let requests = 0; requests < 200; requests++) {
				const page = await eventsPage(scratchId, [query, `after=${after}`, `limit=${limit}`].filter(part => part !== "").join("&"));
				if (page.events.length > limit) throw new Error(`a page of ${page.events.length} events for limit ${limit}`);
				events.push(...page.events);
				if (page.next === null) return events;
				const last = Number(page.events.at(-1)?.seq);
				expectEqual("next of a page is its last seq", page.next, last);
				if (!(last > after)) throw new Error(`the page after ${after} ended at ${last}`);
				after = last;
			}
			throw new Error("the events paged past 200 requests");
		};
		const everything = await collect("", 500);
		if (everything.length <= 7) throw new Error(`only ${everything.length} events; the paging below needs more than 7`);
		for (const event of everything) {
			if (typeof event.seq !== "number" || typeof event.kind !== "string" || event.kind === "" || typeof event.text !== "string") throw new Error(`a malformed event: ${JSON.stringify(event)}`);
			if (event.turn !== null && typeof event.turn !== "number") throw new Error(`an event turn is neither a number nor null: ${JSON.stringify(event)}`);
			if (Number.isNaN(Date.parse(text(event.at)))) throw new Error(`an event time is not a date: ${JSON.stringify(event)}`);
		}
		const seqs = everything.map(e => Number(e.seq));
		if (seqs.some((seq, index) => index > 0 && seq <= (seqs[index - 1] ?? 0))) throw new Error(`event seqs are not strictly increasing: ${JSON.stringify(seqs)}`);
		// The idle VM may log a pause while this runs: compare up to the newest event seen above.
		const newest = seqs.at(-1) ?? 0;
		expectEqual("events paged by 7", JSON.stringify((await collect("", 7)).map(e => Number(e.seq)).filter(seq => seq <= newest)), JSON.stringify(seqs));
		const resumed = await eventsPage(scratchId, `after=${seqs[2]}&limit=3`);
		expectEqual("events after seq", JSON.stringify(resumed.events.map(e => Number(e.seq))), JSON.stringify(seqs.slice(3, 6)));
		const doneEvents = await collect("kind=turn_done", 500);
		expectEqual("kind=turn_done events", doneEvents.length, everything.filter(e => e.kind === "turn_done").length);
		if (doneEvents.length < 3) throw new Error(`only ${doneEvents.length} turn_done events for a thread with 3 finished turns`);
		const two = await collect("kind=turn_done,assistant", 500);
		expectEqual("kind=turn_done,assistant events", two.length, everything.filter(e => e.kind === "turn_done" || e.kind === "assistant").length);
		if (two.some(e => e.kind !== "turn_done" && e.kind !== "assistant")) throw new Error("a kind filter let another kind through");
		const ofTurn = await collect("turn=2", 500);
		if (ofTurn.length === 0 || ofTurn.some(e => e.turn !== 2)) throw new Error(`turn=2 returned events of other turns: ${JSON.stringify(ofTurn.map(e => e.turn))}`);
		expectEqual("turn=2 events", ofTurn.length, everything.filter(e => e.turn === 2).length);
		const events = `/threads/${scratchId}/events?format=json`;
		await expectRefused("GET", `${events}&limit=0`, 400, "limit");
		await expectRefused("GET", `${events}&limit=501`, 400, "limit");
		await expectRefused("GET", `${events}&after=-1`, 400, "after");
		await expectRefused("GET", `${events}&after=abc`, 400, "after");
		await expectRefused("GET", `${events}&kind=BAD%20KIND`, 400, "kind");
		// Without format=json the route is still the event stream.
		const abort = new AbortController();
		try {
			const stream = await fetch(`${origin}/api/v1/threads/${scratchId}/events?after=0`, { headers: authHeaders, signal: abort.signal });
			expectEqual("event stream status", stream.status, 200);
			expectContains("event stream content-type", stream.headers.get("content-type"), "text/event-stream");
		} finally {
			abort.abort();
		}
		return `${everything.length} events, reply of ${full.length} characters in ${pages} pages`;
	}, shown => shown);

	await report.step("AA a thread the model started has no ask tool: the question is never asked and the turn ends with the tool's error", async () => {
		threadId = scratchId;
		const turn = await sendMessage("ASK: pick a color");
		// The thread never waits: omp has no `ask` tool, so the fake model's call fails and its text echoes the tool result.
		const done = await waitTurnIdle(turn, 120_000);
		expectEqual("turn state", turnOf(done, turn).state, "done");
		expectEqual("turn questions", rows(turnOf(done, turn).questions, "turn questions").length, 0);
		expectContains("reply", text(latestOf(done)?.reply), "ANSWER=");
	});

	await report.step("AB interrupting send: the running turn is stopped, the queued turn is cancelled, the new turn runs next", async () => {
		threadId = scratchId;
		const slow = await sendMessage("BASH: sleep 90");
		await waitFor(`turn ${slow} to run`, 120_000, t => turnOf(t, slow).state === "running");
		const working = await listThreads(`phase=working&session=${SCRATCH_SESSION}`);
		expectEqual("working threads of the session", JSON.stringify(working.threads.map(t => t.id)), JSON.stringify([scratchId]));
		expectEqual("working total", working.total, 1);
		expectEqual("idle threads of the session while it works", (await listThreads(`phase=idle&session=${SCRATCH_SESSION}`)).total, 0);

		const queued = await sendMessage("BASH: printf 'queued\\n' > queued.txt");
		const sent = await apiJson("POST", `/threads/${scratchId}/messages`, 201, { text: "BASH: printf 'urgent\\n' > urgent.txt", mode: "interrupt" });
		expectEqual("interrupted", sent.interrupted, true);
		expectEqual("cancelled turns", JSON.stringify(sent.cancelled), JSON.stringify([queued]));
		const urgent = Number(obj(sent.turn, "turn").id);
		expectEqual("the urgent turn's id follows the queued turn's", urgent, queued + 1);
		expectEqual("the urgent turn's state", obj(sent.turn, "turn").state, "queued");
		const ended = ["done", "failed", "cancelled"];
		const thread = await waitFor("the three turns to end", 180_000, t => t.phase === "idle" && [slow, queued, urgent].every(id => ended.includes(text(turnOf(t, id).state))));

		const stopped = turnOf(thread, slow);
		expectEqual("the stopped turn's state", stopped.state, "failed");
		expectEqual("the stopped turn's error", stopped.error, "stopped by owner");
		if (Date.parse(text(stopped.completedAt)) - Date.parse(text(stopped.startedAt)) >= 80_000) throw new Error("the interrupted turn ran to the end of its sleep");
		expectEqual("the queued turn's state", turnOf(thread, queued).state, "cancelled");
		expectEqual("the queued turn never started", turnOf(thread, queued).startedAt, null);
		expectEqual("the urgent turn's state after the run", turnOf(thread, urgent).state, "done");
		const stops = (await eventsPage(scratchId, "kind=stop_requested")).events;
		expectEqual("stop_requested events", JSON.stringify(stops.map(e => e.turn)), JSON.stringify([slow]));
		const cancels = (await eventsPage(scratchId, "kind=turn_cancelled")).events;
		expectEqual("turn_cancelled events", JSON.stringify(cancels.map(e => e.turn)), JSON.stringify([queued]));
		// The urgent turn is the newest result: its file is in the head, the cancelled turn's is not.
		expectEqual("urgent.txt", (await apiJson("GET", `/threads/${scratchId}/files/urgent.txt`, 200)).text, "urgent\n");
		await expectRefused("GET", `/threads/${scratchId}/files/queued.txt`, 404, "no such file");

		// Nothing runs now: nothing is interrupted or cancelled, and the message simply runs.
		const idle = await apiJson("POST", `/threads/${scratchId}/messages`, 201, { text: "BASH: printf 'idle\\n' > idle.txt", mode: "interrupt" });
		expectEqual("interrupted on an idle thread", idle.interrupted, false);
		expectEqual("cancelled on an idle thread", JSON.stringify(idle.cancelled), JSON.stringify([]));
		await waitTurnIdle(Number(obj(idle.turn, "turn").id), 120_000);
		expectEqual("stop_requested events after an idle interrupt", (await eventsPage(scratchId, "kind=stop_requested")).events.length, 1);
		expectEqual("turn_cancelled events after an idle interrupt", (await eventsPage(scratchId, "kind=turn_cancelled")).events.length, 1);
		await expectRefused("POST", `/threads/${scratchId}/messages`, 400, "mode", { text: "x", mode: "sideways" });
	});

	let repoThread = "";

	await report.step("AC list: meta fields, filters, total, paging by cursor, bad parameters, deleted threads, a replayed repo create", async () => {
		const repoKey = `scn-${randomBytes(6).toString("hex")}`;
		repoThread = await createThread(handoff, bundle, null, { request: { origin: "user", ref: "scn-repo", session: "scn-session-2" }, headers: { "idempotency-key": repoKey } });
		await waitTurnIdle(1, 240_000);
		// A replay of a repository create (same key, same prompt) reads only its `request` part; a different prompt is refused and creates nothing.
		const replay = await postThread(handoff, bundle, null, { request: { origin: "user", ref: "scn-repo" }, headers: { "idempotency-key": repoKey } });
		expectEqual("repo replay status", replay.status, 200);
		const replayed = obj(await replay.json(), "repo replay");
		expectEqual("repo replay id", replayed.id, repoThread);
		expectEqual("repo replay.replayed", replayed.replayed, true);
		const changed = await postThread(handoff, bundle, null, { request: { prompt: "never runs", origin: "user", ref: "scn-repo" }, headers: { "idempotency-key": repoKey } });
		expectEqual("repo different-prompt status", changed.status, 409);
		expectEqual("repo different-prompt error", text(obj(await changed.json(), "refusal").error), `Idempotency-Key ${repoKey} was used for a different request (thread ${repoThread})`);
		expectEqual("threads with the repo ref", (await listThreads("ref=scn-repo")).total, 1);

		// A pause is logged as activity: let both VMs settle first, so the order below holds from one request to the next.
		for (const id of [repoThread, scratchId]) {
			threadId = id;
			await waitFor(`the VM of ${id} to pause`, 90_000, t => vmOf(t)?.state === "paused");
		}

		const all = await listThreads("limit=200");
		expectEqual("next of a full list", all.next, null);
		expectEqual("total of a full list", all.total, all.threads.length);
		const total = all.total;
		const ids = all.threads.map(t => text(t.id));
		for (const id of [scratchId, repoThread]) if (!ids.includes(id)) throw new Error(`the list lacks ${id}: ${JSON.stringify(ids)}`);
		const summaryOf = (id: string): Json => obj(all.threads.find(t => t.id === id), `summary of ${id}`);
		const scratch = summaryOf(scratchId);
		expectEqual("scratch summary", JSON.stringify([scratch.origin, scratch.ref, scratch.session, scratch.scratch]), JSON.stringify(["tool", SCRATCH_REF, SCRATCH_SESSION, true]));
		const repo = summaryOf(repoThread);
		expectEqual("repo summary", JSON.stringify([repo.origin, repo.ref, repo.session, repo.scratch]), JSON.stringify(["user", "scn-repo", "scn-session-2", false]));
		for (const [index, summary] of all.threads.entries()) {
			const previous = all.threads[index - 1];
			if (previous !== undefined && text(previous.lastActivityAt) < text(summary.lastActivityAt)) throw new Error(`the list is not newest first: ${text(previous.lastActivityAt)} before ${text(summary.lastActivityAt)}`);
		}

		// filters
		const only = async (query: string, expected: string[]): Promise<void> => {
			const found = await listThreads(`${query}&limit=200`);
			expectEqual(`${query}: threads`, JSON.stringify(found.threads.map(t => text(t.id)).sort()), JSON.stringify([...expected].sort()));
			expectEqual(`${query}: total`, found.total, expected.length);
		};
		await only(`session=${SCRATCH_SESSION}`, [scratchId]);
		await only("session=scn-session-2", [repoThread]);
		await only(`ref=${SCRATCH_REF}`, [scratchId]);
		await only("ref=scn-repo", [repoThread]);
		await only("origin=tool", [scratchId]);
		await only("origin=user", [repoThread]);
		await only("repo=scratch", [scratchId]);
		await only("origin=tool&session=scn-session-2", []);
		const named = await listThreads("repo=scenario&limit=200");
		const namedIds = named.threads.map(t => text(t.id));
		if (!namedIds.includes(repoThread) || namedIds.includes(scratchId) || named.total !== named.threads.length) throw new Error(`repo=scenario: ${JSON.stringify(namedIds)} of ${named.total}`);
		const idle = await listThreads("phase=idle&limit=200");
		const failed = await listThreads("phase=failed&limit=200");
		const idleIds = idle.threads.map(t => text(t.id));
		if (!idleIds.includes(scratchId) || !idleIds.includes(repoThread)) throw new Error(`phase=idle lacks a thread: ${JSON.stringify(idleIds)}`);
		if (failed.threads.some(t => t.phase !== "failed" || t.id === scratchId || t.id === repoThread)) throw new Error(`phase=failed: ${JSON.stringify(failed.threads.map(t => [t.id, t.phase]))}`);
		expectEqual("phase=idle,failed total", (await listThreads("phase=idle,failed&limit=200")).total, idle.total + failed.total);
		expectEqual("idle + failed + the rest", idle.total + failed.total, total);
		const since = await listThreads(`since=${encodeURIComponent(text(repo.lastActivityAt))}&limit=200`);
		if (!since.threads.some(t => t.id === repoThread)) throw new Error(`since=<the repo thread's last activity> lacks it: ${JSON.stringify(since.threads.map(t => t.id))}`);
		expectEqual("total of a since filter", since.total, since.threads.length);
		const old = await listThreads(`since=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`);
		expectEqual("threads active in the future", old.total, 0);

		// paging by cursor: one thread per page, the same order as the full list, `total` the same on every page
		const paged: string[] = [];
		let cursor: string | null = null;
		for (let requests = 0; requests <= total + 1; requests++) {
			const page: { threads: Json[]; next: string | null; total: number } = await listThreads(`limit=1${cursor === null ? "" : `&before=${encodeURIComponent(cursor)}`}`);
			expectEqual("total on a page", page.total, total);
			if (page.threads.length > 1) throw new Error(`a page of ${page.threads.length} threads for limit 1`);
			paged.push(...page.threads.map(t => text(t.id)));
			if (page.next === null || page.threads.length === 0) break;
			cursor = page.next;
		}
		expectEqual("threads by cursor", JSON.stringify(paged), JSON.stringify(ids));

		for (const [query, name] of [["limit=0", "limit"], ["limit=201", "limit"], ["limit=abc", "limit"], ["before=not-a-cursor", "before"], ["phase=bogus", "phase"], ["since=yesterday", "since"], ["origin=", "origin"]] as const) {
			await expectRefused("GET", `/threads?${query}`, 400, name);
		}

		// a deleted thread is never listed
		await waitGone(repoThread);
		const after = await listThreads("limit=200");
		expectEqual("total after a delete", after.total, total - 1);
		if (after.threads.some(t => t.id === repoThread)) throw new Error("the deleted thread is still listed");
		await only("ref=scn-repo", []);
		return `${total} threads`;
	}, shown => shown);

	await report.step("AC2 secret env: a service secret reaches the VM's env and never reaches the model", async () => {
		const value = "s3cr3t-value-123";
		await expectRefused("PUT", "/secrets/DEMO_TOKEN", 400, "repos is required", { value });
		const listed = await apiJson("PUT", "/secrets/DEMO_TOKEN", 200, { value, repos: ["*"] });
		if (JSON.stringify(listed).includes(value)) throw new Error(`PUT /secrets answered with the value: ${JSON.stringify(listed)}`);
		const previous = threadId;
		try {
			const shown = await apiJson("GET", "/secrets", 200);
			if (JSON.stringify(shown).includes(value)) throw new Error(`GET /secrets served the value: ${JSON.stringify(shown)}`);
			expectContains("GET /secrets names the secret", JSON.stringify(shown), "DEMO_TOKEN");

			const secretId = await createThread(handoff, bundle, null);
			await waitTurnIdle(1, 240_000);
			const turn = await sendMessage("BASH: printf %s ${#DEMO_TOKEN} > len.txt");
			await waitTurnIdle(turn, 180_000);
			expectEqual("len.txt", (await apiJson("GET", `/threads/${secretId}/files/len.txt`, 200)).text, String(value.length));
			const events = await readEvents(2000);
			if (!events.some(e => e.kind === "vm" && e.text.startsWith("secret env:") && e.text.includes("DEMO_TOKEN"))) {
				throw new Error(`no "secret env: ..." vm event naming DEMO_TOKEN: ${JSON.stringify(events.filter(e => e.kind === "vm").map(e => e.text))}`);
			}
			if (events.some(e => e.text.includes(value))) throw new Error("an event of the thread contains the secret value");

			// The command prints the value; omp's masking (secrets.yml) must replace it before the model sees the tool result.
			provider?.watch(value);
			const before = provider?.count ?? 0;
			const echo = await sendMessage("BASH: echo $DEMO_TOKEN");
			await waitTurnIdle(echo, 180_000);
			const requests = (provider?.count ?? 0) - before;
			if (requests < 2) throw new Error(`the echo turn made ${requests} model request(s); expected the tool call and the one that carries its result`);
			const leaked = provider?.seen(value) ?? 0;
			if (leaked > 0) {
				const last = (provider?.recentTurns ?? []).map(describeRequest).join("\n  --\n");
				throw new Error(`${leaked} model request(s) after the echo contained the secret value\nthe fake model's last turn requests (oldest first):\n${last}`);
			}
			// The reply is not checked: it is the model's `DONE=<tool result>` and omp restores the value in what it shows, so the value is
			// there although the model only ever saw its placeholder.
			await waitGone(secretId);
		} finally {
			await api("DELETE", "/secrets/DEMO_TOKEN");
			threadId = previous;
		}
		await expectRefused("DELETE", "/secrets/DEMO_TOKEN", 404, "no secret DEMO_TOKEN");
	});

	await report.step("AC3 MCP proxy: the VM reaches an http MCP server only through the service, which adds the upstream credential", async () => {
		const who = await apiJson("GET", "/whoami", 200);
		expectEqual("whoami.mcpProxy", who.mcpProxy, true);
		// The proxy refuses loopback upstreams, so the fake one binds the host's primary non-loopback address.
		const route = await Bun.$`ip -4 route get 1.1.1.1`.text();
		const address = /\bsrc (\d+\.\d+\.\d+\.\d+)/.exec(route)?.[1];
		if (address === undefined) throw new Error(`no source address in \`ip -4 route get 1.1.1.1\`: ${route.trim()}`);
		const received: string[] = [];
		const upstream = Bun.serve({
			hostname: address,
			port: 0,
			fetch: req => {
				const auth = req.headers.get("authorization") ?? "";
				received.push(auth);
				return new Response(auth);
			},
		});
		const previous = threadId;
		try {
			const url = `http://${address}:${upstream.port}/mcp`;
			const refused = await postThread(handoff, bundle, null, { request: { mcp: [{ name: "self", type: "http", url: `http://${PROVIDER_HOST}:4000/mcp` }] } });
			expectEqual("an mcp server at the gateway host: status", refused.status, 400);
			expectContains("an mcp server at the gateway host: error", text(obj(await refused.json(), "refusal").error), "may not point at the service host");

			const mcpId = await createThread(handoff, bundle, null, {
				request: { mcp: [{ name: "fake", type: "http", url, headers: { Authorization: "Bearer upstream-secret" } }] },
			});
			await waitTurnIdle(1, 240_000);
			const command = `curl -s -X POST -H "Authorization: $(jq -r .mcpServers.fake.headers.Authorization ~/.omp/agent/mcp.json)" http://${PROVIDER_HOST}:4101/mcp/fake -d '{}' > mcp.txt`;
			const turn = await sendMessage(`BASH: ${command}`);
			await waitTurnIdle(turn, 180_000);
			expectEqual("mcp.txt", (await apiJson("GET", `/threads/${mcpId}/files/mcp.txt`, 200)).text, "Bearer upstream-secret");
			// omp in the VM also talks to the server on its own (through the same proxy): every call the upstream got carries its credential.
			if (received.length === 0 || received.some(auth => auth !== "Bearer upstream-secret")) throw new Error(`the upstream received ${JSON.stringify(received)}; expected only Bearer upstream-secret`);
			await waitGone(mcpId);
		} finally {
			await upstream.stop(true);
			threadId = previous;
		}
	});

	await report.step("AD whoami fields; deleting the scratch thread ends its inspections", async () => {
		const pkg = obj(JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")), "package.json");
		const who = await apiJson("GET", "/whoami", 200);
		const service = obj(who.service, "whoami.service");
		expectEqual("service.version", service.version, pkg.version);
		expectContains("service.version", text(service.version), ".");
		expectEqual("service.api", service.api, API_VERSION);
		const expected = ["threads.paging", "threads.meta", "threads.idempotency", "threads.scratch", "turns.reply", "events.json", "inspect", "messages.interrupt", "questions.meta", "threads.irc", "events.live", "events.children", "github.app", "commits.signed", "threads.pr", "secrets.store", "mcp.proxy", "threads.preview", "threads.setup", "threads.readonly", "threads.subagent"];
		expectEqual("capabilities", JSON.stringify((Array.isArray(who.capabilities) ? who.capabilities.map(text) : []).sort()), JSON.stringify([...expected].sort()));
		const limits = obj(who.limits, "whoami.limits");
		expectEqual("limits", JSON.stringify([limits.maxMessageBytes, limits.maxAnswerBytes, limits.listMax, limits.maxTurns]), JSON.stringify([32768, 4000, 200, 200]));
		if (!(Number(limits.maxUploadBytes) > 0)) throw new Error(`limits.maxUploadBytes is not positive: ${JSON.stringify(limits)}`);
		expectEqual("limits.maxUploadBytes", limits.maxUploadBytes, who.maxUploadBytes);
		const spend = obj(who.spend, "whoami.spend");
		// The scenario's own turns cost money today (UTC); there is no day cap until one is set.
		if (!(Number(spend.todayUSD) > 0)) throw new Error(`spend.todayUSD is not above 0 after the scenario's turns: ${JSON.stringify(spend)}`);
		expectEqual("spend.dayCapUSD", spend.dayCapUSD, 0);
		await putSettings({ "policy.spend.dayUSD": 1234 });
		try {
			expectEqual("spend.dayCapUSD with a cap", obj(obj(await apiJson("GET", "/whoami", 200), "whoami").spend, "spend").dayCapUSD, 1234);
		} finally {
			await putSettings({ "policy.spend.dayUSD": null });
		}
		const models = rows(who.models, "whoami.models").map(m => text(m.id));
		if (!models.includes("fake/fake-model")) throw new Error(`whoami.models lacks fake/fake-model: ${JSON.stringify(models)}`);
		if (models.some(m => !m.includes("/"))) throw new Error(`a model id is not provider/id: ${JSON.stringify(models)}`);
		expectEqual("whoami.defaultModel", who.defaultModel, "fake/fake-model");
		expectEqual("whoami.device", who.device, null);
		expectEqual("whoami.remote", who.remote, null);
		expectEqual("whoami.vmWorkspace", who.vmWorkspace, undefined);
		await expectRefused("GET", `/threads/${scratchId}/memory`, 404, "not found");

		await waitGone(scratchId);
		await expectRefused("GET", `/threads/${scratchId}/diff`, 404, "not found");
		await expectRefused("GET", `/threads/${scratchId}/turns/1/reply`, 404, "not found");
		expectEqual("threads with the scratch ref after the delete", (await listThreads(`ref=${SCRATCH_REF}`)).total, 0);
	});

	await report.step("AF environment: setup runs once per repository state, its snapshot starts the VMs (egress still applies), a changed lockfile prepares again", async () => {
		const repo = join(dir, "repo-af");
		await Bun.$`git init -q -b main ${repo}`.quiet();
		await writeFile(join(repo, ".gitignore"), "deps/\n");
		await writeFile(join(repo, "bun.lock"), "# lock one\n");
		await git(repo, "add", "-A");
		await git(repo, "-c", "user.name=Scenario", "-c", "user.email=scenario@example.com", "commit", "-q", "-m", "initial");
		const bundleOf = async (name: string): Promise<{ handoff: string; bundle: string }> => {
			const head = (await git(repo, "rev-parse", "HEAD")).trim();
			await git(repo, "update-ref", "refs/omp-cloud/handoff", head);
			const file = join(dir, name);
			await git(repo, "bundle", "create", file, "refs/omp-cloud/handoff");
			return { handoff: head, bundle: file };
		};
		const first = await bundleOf("af-1.bundle");
		await commitFile(repo, "bun.lock", "# lock two\n", "change the lockfile");
		const second = await bundleOf("af-2.bundle");
		const setup = { run: "mkdir -p deps && date +%s%N > deps/stamp" };

		const vmTexts = async (id: string): Promise<string[]> => (await eventsPage(id, "kind=vm&limit=500")).events.map(e => text(e.text));
		const indexOfText = (texts: string[], pattern: RegExp): number => texts.findIndex(t => pattern.test(t));
		/** The stamp the setup wrote, read by the agent into a committed file. */
		const stampOf = async (): Promise<string> => {
			const turn = await sendMessage("BASH: cat deps/stamp > stamp.txt");
			await waitTurnIdle(turn, 120_000);
			const stamp = text((await apiJson("GET", `/threads/${threadId}/files/stamp.txt`, 200)).text);
			if (!/^[0-9]{10,}\n$/.test(stamp)) throw new Error(`stamp.txt is not the setup's stamp: ${JSON.stringify(stamp)}`);
			return stamp;
		};
		const previous = threadId;
		try {
			const who = await apiJson("GET", "/whoami", 200);
			if (!(Array.isArray(who.capabilities) && who.capabilities.includes("threads.setup"))) throw new Error("whoami lacks threads.setup");

			// 1. The first thread builds the environment.
			const one = await createThread(first.handoff, first.bundle, null, { request: { setup } });
			await waitTurnIdle(1, 900_000);
			const oneTexts = await vmTexts(one);
			const preparing = indexOfText(oneTexts, /^preparing the repository environment/);
			const ready = indexOfText(oneTexts, /^environment ready \(omp-env-[0-9a-f]{16}\)$/);
			if (preparing < 0 || ready < preparing) throw new Error(`expected "preparing the repository environment" then "environment ready", got ${JSON.stringify(oneTexts)}`);
			const name = /\((omp-env-[0-9a-f]{16})\)/.exec(oneTexts[ready] ?? "")?.[1] ?? "";
			if (indexOfText(oneTexts, /^using the cached environment/) >= 0) throw new Error(`the first thread used a cache: ${JSON.stringify(oneTexts)}`);
			const stampOne = await stampOf();
			await waitGone(one);

			// 2. The second thread of the same repository finds the cache; its VM comes from the snapshot and still obeys the egress policy.
			await putSettings({ "policy.egress": ["example.com"] });
			try {
				const two = await createThread(first.handoff, first.bundle, null, { request: { setup } });
				await waitTurnIdle(1, 240_000);
				const twoTexts = await vmTexts(two);
				if (indexOfText(twoTexts, new RegExp(`^using the cached environment ${name}$`)) < 0) throw new Error(`expected "using the cached environment ${name}", got ${JSON.stringify(twoTexts)}`);
				if (indexOfText(twoTexts, /^preparing the repository environment/) >= 0) throw new Error(`the second thread prepared the environment again: ${JSON.stringify(twoTexts)}`);
				expectEqual("the cached environment's stamp", await stampOf(), stampOne);
				const probe = await sendMessage("BASH: if curl -s -m 5 -o /dev/null http://1.1.1.1/ 2>/dev/null; then echo reachable; else echo blocked; fi");
				expectEqual("the internet from a snapshot VM", text(latestOf(await waitTurnIdle(probe, 120_000))?.reply), "DONE=blocked");
				await waitGone(two);
			} finally {
				await putSettings({ "policy.egress": null });
			}

			// 3. A changed lockfile is another environment.
			const three = await createThread(second.handoff, second.bundle, null, { request: { setup } });
			await waitTurnIdle(1, 900_000);
			const threeTexts = await vmTexts(three);
			const rebuilt = indexOfText(threeTexts, /^environment ready \(omp-env-[0-9a-f]{16}\)$/);
			if (indexOfText(threeTexts, /^preparing the repository environment/) < 0 || rebuilt < 0) throw new Error(`a changed bun.lock did not prepare the environment: ${JSON.stringify(threeTexts)}`);
			if ((threeTexts[rebuilt] ?? "").includes(name)) throw new Error(`the changed bun.lock kept the environment name ${name}`);
			const stampThree = await stampOf();
			if (stampThree === stampOne) throw new Error(`the rebuilt environment kept the old stamp ${stampOne.trim()}`);
			await waitGone(three);
		} finally {
			threadId = previous;
		}
	});

	await report.step("AG preview: a web server in the VM is relayed through the service, also after the VM paused; port 49983 and websocket upgrades are refused", async () => {
		const previous = threadId;
		try {
			const preview = await createThread(handoff, bundle, null);
			await waitTurnIdle(1, 240_000);
			const turn = await sendMessage("BASH: setsid nohup python3 -m http.server 8000 >/dev/null 2>&1 </dev/null & sleep 1");
			await waitTurnIdle(turn, 120_000);

			const listing = async (what: string): Promise<void> => {
				for (let tries = 0; tries < 20; tries++) {
					const res = await api("GET", `/threads/${preview}/ports/8000/`);
					const body = await res.text();
					if (res.status === 200) {
						expectContains(`${what}: the relayed page`, body, "Directory listing");
						return;
					}
					if (tries === 19) throw new Error(`${what}: GET /ports/8000/ answered ${res.status} ${body.slice(0, 200)}`);
					await Bun.sleep(1000);
				}
			};
			await listing("while running");

			// An idle VM pauses; the next request resumes it.
			await waitFor("the VM to pause", 90_000, t => vmOf(t)?.state === "paused");
			const resumedBefore = (await eventsPage(preview, "kind=vm&limit=500")).events.filter(e => text(e.text) === "resumed").length;
			await listing("after the VM paused");
			const resumedAfter = (await eventsPage(preview, "kind=vm&limit=500")).events.filter(e => text(e.text) === "resumed").length;
			expectEqual("resumed events after the relayed request", resumedAfter, resumedBefore + 1);

			await expectRefused("GET", `/threads/${preview}/ports/49983/`, 400, "port must be 1 to 65535 and not 49983");
			const upgrade = await fetch(`${origin}/api/v1/threads/${preview}/ports/8000/ws`, { headers: { ...authHeaders, upgrade: "websocket", connection: "Upgrade" } });
			expectEqual("upgrade status", upgrade.status, 501);
			expectContains("upgrade error", text(obj(await upgrade.json(), "refusal").error), "WebSocket upgrades are not forwarded");
			expectEqual("without a bearer token", (await fetch(`${origin}/api/v1/threads/${preview}/ports/8000/`)).status, 401);
			await waitGone(preview);
		} finally {
			threadId = previous;
		}
	});
}

let failure: unknown = null;
try {
	await run();
} catch (error) {
	if (!(error instanceof StepFailed)) {
		failure = error;
		console.log(`FAIL  scenario: ${error instanceof Error ? error.message : String(error)}`);
	}
	failure ??= error;
}

if (failure !== null) {
	for (const file of logFiles) console.log(`\n--- tail of ${file} ---\n${await logTail(file)}`);
}

/** Stops the service and the provider, kills this scenario's sandboxes, revokes its gateway clients, removes the temp dir. */
async function cleanup(): Promise<void> {
	await stopService().catch(() => undefined);
	await provider?.stop().catch(() => undefined);
	await gitServer?.stop().catch(() => undefined);
	const key = vmonKey;
	if (key !== null) {
		for (const created of createdThreads) {
			try {
				for (const sandbox of await sandboxesOf(key, created)) await Sandbox.kill(sandbox.sandboxId, vmonOptions(key));
			} catch (error) {
				console.log(`cleanup: killing sandboxes of ${created} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				const clients = new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL });
				for (const name of await clientsOf(created)) await clients.revoke(name);
			} catch (error) {
				console.log(`cleanup: revoking gateway clients of ${created} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (key !== null) {
		// The service's own gateway client outlives its temp data directory: revoke the ones this scenario added.
		try {
			const clients = new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL });
			for (const name of await clients.names()) {
				if (name.endsWith("-service") && !clientsBefore.includes(name)) await clients.revoke(name);
			}
		} catch (error) {
			console.log(`cleanup: revoking the service's gateway client failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (tempDir !== null) {
		// The environments the service cached live in vmon as snapshots: delete the ones this scenario's database holds.
		try {
			const db = new Database(join(tempDir, "data", "omp-cloud.db"), { readonly: true });
			try {
				for (const row of db.query<{ snapshot_id: string }, []>("SELECT snapshot_id FROM environments").all()) {
					if (key !== null) await Sandbox.deleteSnapshot(row.snapshot_id, vmonOptions(key));
				}
			} finally {
				db.close();
			}
		} catch (error) {
			console.log(`cleanup: deleting the environment snapshots failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
}
await cleanup();

const ok = report.print();
console.log(`total ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
process.exit(ok && failure === null ? 0 : 1);
