/**
 * `mise run plugin:scenario`: plugin acceptance. A local omp (isolated HOME and agent dir, fake model) loads the plugin the way
 * users get it: the release's bundle file set (`pluginBundleFiles` of `scripts/release.ts`: `.omp-plugin/marketplace.json` and
 * `plugin/`, no `node_modules`) is written to a temp directory, added as a marketplace and installed with `omp plugin install`
 * into each omp's isolated agent dir; nothing links the checkout. It drives a fresh omp-cloud service on local vmon through
 * `/cloud` commands only; this script reads the service's HTTP API, its stored setup archive and vmon (read-only).
 *
 *  0  the plugin as users get it: the bundle is built from the repository's files, added as a marketplace and installed into the
 *     owner omp's isolated agent dir (`omp plugin list` shows the marketplace install, not a link); the real `/cloud` is registered
 *     (its description, its `help` card listing the subcommands) and no load-failure notice or stderr line was emitted
 *
 *  1  handoff: `/cloud <task>` after a local turn creates one thread mirroring the session (model, omp version, overlay), named by omp's title generator (the fake model's deterministic answer, shown by `/cloud list`); the clone's
 *     remote is a git server the service holds a credential for, so the handoff is a delta from the remote's main; the
 *     session's omp-cloud files (`policy` in the personal file and in the work clone's `.omp-cloud.yml`, dotted keys included) reach the thread as one merged policy
 *  2  the shipped setup holds the allowed files and none of the denied ones; the conversation reached the cloud
 *  3  the first turn finishes with a result; the person-started thread reports it to the tray (footer `☁ 1 unread`, no turn card), `/cloud show` posts the card and clears the count; the later steps run with `deliver: transcript`
 *  4  `/cloud send` an ask: the question card lands in the local session, `/cloud answer` answers it, the reply and the turn card arrive
 *  4b the running cloud turn is a task job of the local omp (named after the thread): the fake local model's `wait` blocks on it and returns the turn's result, so the model hears of the turn once; the turn card is the pointer
 *  5  `/cloud pull` creates `omp-cloud/<thread>` with the cloud's file
 *  5b the cloud conversation is one local session: the export's id names exactly one file in the local omp's sessions, holding the replies of turns 1-3; the pull card says it was saved
 *  5c `/cloud resume` continues the cloud conversation: the snapshot is the session, `omp-cloud/<thread>` the branch, and the next local reply sees the whole conversation
 *  5d `omp stats --json` (the same isolated home) counts every request once: the local ones plus the cloud turns' usage, at the fake model's known cost
 *  5e `/cloud dashboard` prints a one-time sign-in link: the code signs in once, a cross-site POST is refused, the cookie reads the API
 *  8a–8h the `cloud` tool, called by the fake model of a second local omp (own repository whose remote the service can read, `CLOUD[tag]: {json}` prompts):
 *     8a `info`; 8b a batch `delegate` of two (one with `ref`, one scratch); 8c a replay with the same `ref`, `list` with `mine`, filters and cursor;
 *     8d `wait` until all, `status` (id, suffix, name, list; a missing thread is an error result), `diff`, `files`; 8e `send`, `read` paging, `events`;
 *     8f `send` with `mode: interrupt` (an agent the model started has no `ask`); 8f2 an adopted person-started thread still asks, answered through `answer`; 8g an approval and a push question refused by `answer` (the owner answers them);
 *     8h `pull` (fetch, worktree, scratch clone, wrong repository refused), `delete` (`confirm`, a user's thread refused), `stop all-mine`
 *  9a–9e orchestration parity (the tool omp's fake model drives omp's own `read`, `write` and `wait`; the cloud agents' model is the fake model in a real VM):
 *     9a a model-started cloud agent is a registered agent: `agent://<id>` and `proc://<job>` resolve while its turn runs; its result arrives as omp's `async-result` (type task, completed, pointing at `agent://<id>`), no `[cloud]` turn card
 *     9b drill-in: `agent://<id>` is the reply, `agent://<id>/result/branch` a field of the structured result, `history://<id>` the transcript
 *     9c local to cloud: `write agent://<id>` answers omp's receipt (woken); the VM agent's model got omp's IRC envelope; the woken turn's reply returns to the sender as an IRC message with `replyTo` = the message id and `wakeRelay`
 *     9d cloud to local: the VM agent's `write agent://Parent` lands as an `irc:incoming` message in the idle local session, wakes its model, and the turn's relay follows
 *     9e omp's native `wait` on a second model-started cloud job returns it as completed when the turn settles; no `[cloud]` card; both agents are deleted
 *  9f children: a background `bash` job the cloud agent starts (fake rule `BGBASH:`) is a child_start event, then a bash job under the cloud agent's row in the tool omp's `/jobs` tree (read from its `command_output` frame); it outlives turn 1 (the thread is idle, no child_end); `/jobs kill <id>` from omp stops nothing (the job still runs here, the VM still runs the command, no child_end); when the VM job ends child_end is `completed` and `/jobs` shows it completed; its result never reaches the local model. A background `task` subagent is not driven: the fake model cannot make a subagent `yield`
 *  7  pairing: a second isolated omp (device B) runs `/cloud connect <code>` over the service's TLS `remote` listener while the owner approves through the API; B's `connection.json` is written 0600
 *  7b B's `/cloud status` names the device and the pinned fingerprint, `/cloud list` works, the owner token on the remote port gets 401, B's token on an owner-only route gets 403
 *  7c B's `/cloud dashboard` forwarder: serves the page, refuses a foreign Host (421) and cross-site requests (403), signs in with its one-time code once, relays the API, never accepts a pasted token
 *  7d a fake TLS server with another certificate at a code's address: a fresh device refuses it, the imposter sees no HTTP request, the real offer stays open and no connection file is written
 *  7e revoking B through the API ends its open event stream, fails its next `/cloud list` with an error and the forwarder's next API call with 401
 *  7f ssh pairing: `OMP_CLOUD_SSH` is a script that runs the remote command locally, so `sh -c` and `omp-cloud ssh-pair` really run against this service's config through a wrapper like the `~/.local/bin/omp-cloud` link `omp-cloud setup` installs; `/cloud connect me@localhost` writes the pinned connection file, lists a device, and its token works
 *  6  delete: no sandbox and no gateway client remain
 *
 * Fake model only; no subscription is used. Both this and `test/scenario.ts` write the shared gateway clients file, so
 * do not run them at the same time.
 */
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { Sandbox } from "e2b";
import { cloudJobId } from "../plugin/src/cloud-job";
import { GatewayClients } from "../src/gateway/clients";
import { isRecord } from "../src/guards";
import { hostOmp, pathWithoutNodeBin } from "../src/omp-version";
import { messageText, userTexts } from "./messages";
import { expectContains, expectEqual, Report, StepFailed } from "./report";
import { cloudCallId, CONFIG_YAML, describeRequest, GENERATED_TITLE, longReply, MODEL, modelsYaml, REQUEST_COST, toolCallId, type FakeProvider, startFakeProvider } from "./fake-provider";
import { type GitHttpServer, serveGitHttp } from "./git-http";
import { takeRunLockOrExit } from "./run-lock";
import { pluginBundleFiles } from "../scripts/release";
import { API_VERSION } from "../src/version";

const REPO_ROOT = join(import.meta.dir, "..");
/** The directory the plugin's marketplace was written to (step 0); every omp of this scenario installs the plugin from it. */
let pluginMarketplace = "";
const VMON_URL = "http://127.0.0.1:3000";
const VMON_KEY_FILE = join(homedir(), ".config", "omp-cloud", "vmon.key");
const PROVIDER_HOST = "10.254.254.1";
const GATEWAY_URL = `http://${PROVIDER_HOST}:4000`;
const CLIENTS_FILE = join(homedir(), ".local", "share", "omp-cloud", "auth-home", "clients.json");
const BROKER_URL = "http://127.0.0.1:8765";
const BROKER_TOKEN_FILE = join(homedir(), ".local", "share", "omp-cloud", "auth-home", ".omp", "auth-broker.token");
const POLL_MS = 500;
const STDERR_TAIL_BYTES = 32 * 1024;
const CARD_TYPE = "omp-cloud";
/** `/cloud <task>`: the fake model runs the bash command and answers `DONE=`. */
const TASK = "BASH: printf 'hi\\n' > hello.txt";
/**
 * The policy the thread must end up with, split over omp-cloud's two files: `spend.turnUSD` in the personal file
 * (`$XDG_CONFIG_HOME/omp-cloud/config.yml`), `fetch` in the work clone's `.omp-cloud.yml`. Dotted keys must arrive as
 * they are; the per-turn cap stays above the fake model's turns (two requests at most, 0.264).
 */
const CLOUD_POLICY = { "spend.turnUSD": 0.5, fetch: false } as const;

type Json = Record<string, unknown>;

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

async function tarList(archive: string, flags: string): Promise<string[]> {
	const proc = Bun.spawn(["tar", flags, archive], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`tar ${flags} ${archive} exited ${code}: ${stderr.trim()}`);
	return stdout
		.split("\n")
		.map(line => line.replace(/^\.\//, "").replace(/\/$/, ""))
		.filter(line => line !== "" && line !== ".");
}

/** One member of a tar archive, as text. */
async function tarMember(archive: string, member: string): Promise<string> {
	const proc = Bun.spawn(["tar", "-xOf", archive, member], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`tar -xOf ${archive} ${member} exited ${code}: ${stderr.trim()}`);
	return stdout;
}

/** Every `*_<id>.jsonl` in every session bucket under `root` (omp keeps one directory per working directory). */
async function sessionCopies(root: string, id: string): Promise<string[]> {
	const found: string[] = [];
	for (const bucket of await readdir(root, { withFileTypes: true })) {
		if (!bucket.isDirectory()) continue;
		for (const file of await readdir(join(root, bucket.name))) {
			if (file.endsWith(`_${id}.jsonl`)) found.push(join(root, bucket.name, file));
		}
	}
	return found.sort();
}

/** The text of every assistant message in a session journal; a partly written last line is skipped. */
function assistantTexts(journal: string): string[] {
	const replies: string[] = [];
	for (const line of journal.split("\n")) {
		if (line === "") continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (isRecord(entry) && isRecord(entry.message) && entry.message.role === "assistant") replies.push(messageText(entry.message));
		} catch {
			// not a complete entry
		}
	}
	return replies;
}

takeRunLockOrExit("plugin:scenario");
const report = new Report();
const startedAt = performance.now();

// Everything the finally block cleans up.
let tempDir: string | null = null;
let vmonKey: string | null = null;
let provider: FakeProvider | null = null;
let gitServer: GitHttpServer | null = null;
let service: { proc: Bun.Subprocess; logFile: string } | null = null;
let omp: RpcClient | null = null;
const createdThreads: string[] = [];
const logFiles: string[] = [];
let clientsBefore: string[] = [];
/** What the local omp's extension UI showed (`notify` frames) and wrote to stderr, for failures. */
const notices: string[] = [];
let ompStderr = () => "";
/** Where a local omp's output is collected: its `notify` frames and a reader of its stderr tail. */
interface Capture {
	notices: string[];
	/** The text of each footer status the plugin set (`""` for a cleared one), oldest first. */
	statuses: string[];
	/** The text of each builtin slash command's output, when the omp's owner wants them. */
	commandOutputs?: string[];
	setStderr(read: () => string): void;
}
/** The plugin's footer statuses in the owner's local omp. */
const statuses: string[] = [];
const OWNER_CAPTURE: Capture = {
	notices,
	statuses,
	setStderr: read => {
		ompStderr = read;
	},
};

const token = randomBytes(24).toString("hex");
const listenPort = freePort("127.0.0.1");
/** The dashboard listener's port, never the service's own. */
let dashboardPort = freePort("127.0.0.1");
while (dashboardPort === listenPort) dashboardPort = freePort("127.0.0.1");
/** The service's TLS `remote` listener (device pairing), loopback only in this scenario. */
let remotePort = freePort("127.0.0.1");
while (remotePort === listenPort || remotePort === dashboardPort) remotePort = freePort("127.0.0.1");
/** What the git remote's Basic auth accepts; the service reads it through `git.hosts` and a `!printf` credential command. */
const gitPassword = randomBytes(18).toString("hex");
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

function latestOf(thread: Json): Json | null {
	return isRecord(thread.latest) ? thread.latest : null;
}

function describeLocal(): string {
	return [`local omp notices:\n${notices.slice(-12).map(n => `  ${n}`).join("\n")}`, `local omp stderr:\n${ompStderr().split("\n").slice(-12).join("\n")}`].join("\n");
}

async function waitUntil<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (service !== null && service.proc.exitCode !== null) throw new Error(`waiting for ${what}: the service exited with code ${service.proc.exitCode}\n${describeLocal()}`);
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}\n${describeLocal()}`);
		await Bun.sleep(POLL_MS);
	}
}

async function detail(id: string): Promise<Json> {
	return apiJson("GET", `/threads/${id}`, 200);
}

/** Polls the thread until `check` holds; a failed thread stops the wait at once. */
async function waitThread(id: string, what: string, timeoutMs: number, check: (thread: Json) => boolean): Promise<Json> {
	return waitUntil(what, timeoutMs, async () => {
		const thread = await detail(id);
		if (check(thread)) return thread;
		if (thread.phase === "failed") throw new Error(`waiting for ${what}: the thread failed: ${text(thread.error)}\n${describeLocal()}`);
		return undefined;
	});
}

async function waitTurnIdle(id: string, turnId: number, timeoutMs: number): Promise<Json> {
	const thread = await waitThread(id, `turn ${turnId} to finish`, timeoutMs, t => {
		const latest = latestOf(t);
		return t.phase === "idle" && latest !== null && Number(latest.id) >= turnId;
	});
	const latest = obj(thread.latest, "latest");
	if (latest.state !== "done") throw new Error(`turn ${turnId} ended ${text(latest.state)}: ${text(latest.error)}`);
	return thread;
}

async function startService(configFile: string, logFile: string): Promise<void> {
	logFiles.push(logFile);
	const fd = openSync(logFile, "a");
	try {
		const proc = Bun.spawn(["bun", "run", "src/main.ts", "--config", configFile], { cwd: REPO_ROOT, stdin: "ignore", stdout: fd, stderr: fd });
		service = { proc, logFile };
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

/**
 * The local omp is the owner's installed one, like the service host's (Tern's when it manages one). `bun run` puts
 * the repository's `node_modules/.bin` (the pinned SDK's own `omp`) first on PATH, so that directory is left out of
 * the children's PATH. Resolved from the real environment, before the children get their isolated HOME.
 */
const HOST_OMP = await hostOmp();
const HOST_PATH = pathWithoutNodeBin();

/** The environment of the local omp's processes: the parent's, minus the owner's omp directory overrides and `OMP_CLOUD_*` variables, then `extra` (the isolated HOME and agent dir). */
function isolatedEnv(extra: Record<string, string>): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.PI_CONFIG_DIR;
	delete env.PI_CODING_AGENT_DIR;
	// The plugin reads the service address and token from its files; the owner's variables must not win over them.
	delete env.OMP_CLOUD_URL;
	delete env.OMP_CLOUD_TOKEN;
	return { ...env, PATH: HOST_PATH, ...extra };
}

/** A local omp over a custom spawn: isolated HOME, agent dir and `XDG_CONFIG_HOME` (where omp-cloud's personal file is). */
function spawnLocal(args: string[], cwd: string, env: Record<string, string>, capture: Capture = OWNER_CAPTURE): RpcAgentProcess {
	const proc = Bun.spawn([HOST_OMP.path, ...args, "--approval-mode", "yolo", "--no-title", "--no-lsp", "--no-pty"], {
		cwd,
		env: isolatedEnv(env),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let pending = "";
	const decoder = new TextDecoder();
	const stdout = proc.stdout.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pending += decoder.decode(chunk, { stream: true });
				for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
					const line = pending.slice(0, nl);
					pending = pending.slice(nl + 1);
					if (!line.includes('"notify"') && !line.includes('"setStatus"') && !line.includes('"command_output"')) continue;
					try {
						const frame: unknown = JSON.parse(line);
						if (isRecord(frame) && frame.type === "extension_ui_request" && frame.method === "notify") {
							capture.notices.push(`${text(frame.notifyType) || "info"}: ${text(frame.message)}`);
						} else if (isRecord(frame) && frame.type === "command_output") {
							capture.commandOutputs?.push(text(frame.text));
						} else if (isRecord(frame) && frame.type === "extension_ui_request" && frame.method === "setStatus" && frame.statusKey === "omp-cloud") {
							capture.statuses.push(text(frame.statusText));
						}
					} catch {
						// not a frame
					}
				}
				controller.enqueue(chunk);
			},
		}),
	);
	let stderr = "";
	void (async () => {
		const stderrDecoder = new TextDecoder();
		for await (const chunk of proc.stderr) stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
	})();
	capture.setStderr(() => stderr);
	return { stdin: proc.stdin, stdout, peekStderr: () => stderr, kill: () => proc.kill("SIGTERM"), exited: proc.exited };
}

/** The `details` of the plugin's cards in the local session, oldest first. */
async function cards(client: RpcClient): Promise<Json[]> {
	return (await client.getMessages())
		.filter(m => isRecord(m) && m.customType === CARD_TYPE && isRecord(m.details))
		.map(m => obj(isRecord(m) ? m.details : undefined, "card"));
}

async function waitCard(client: RpcClient, what: string, timeoutMs: number, match: (card: Json) => boolean): Promise<Json> {
	return waitUntil(what, timeoutMs, async () => (await cards(client)).find(match));
}

/** Waits until `/cloud ...` has been handled: the extension command returns once its handler is done. */
async function cloud(client: RpcClient, args: string): Promise<void> {
	await client.prompt(`/cloud ${args}`);
}

/** Waits for a notice this device's omp showed after its first `seen` ones and that satisfies `match`; resolves to its text. */
function waitNotice(device: Device, seen: number, what: string, timeoutMs: number, match: (notice: string) => boolean): Promise<string> {
	return waitUntil(what, timeoutMs, async () => device.notices.slice(seen).find(match));
}

/** The `cloud` tool's answer to one call: its text, its first line, whether it is an error result and its typed `details`. */
interface ToolOutcome {
	text: string;
	first: string;
	isError: boolean;
	details: Json;
}

let toolCalls = 0;

/** Makes the fake model of `client` call the `cloud` tool with `args` (`CLOUD[tag]: {json}`) and waits for the tool's result message. */
async function callCloud(client: RpcClient, args: Json, timeoutMs = 120_000): Promise<ToolOutcome> {
	const tag = `c${++toolCalls}`;
	// `followUp`: a thread's wake-up message may be running the model; the prompt waits for it instead of failing.
	await client.prompt(`CLOUD[${tag}]: ${JSON.stringify(args)}`, undefined, "followUp");
	return toolResult(client, cloudCallId(tag), `cloud ${text(args.op)} (${tag})`, timeoutMs);
}

/** Makes the fake model of `client` call omp's own tool `name` (`read`, `write`, `wait`) with `args` (`TOOL[tag]: name {json}`) and waits for its result. */
async function callTool(client: RpcClient, name: string, args: Json, timeoutMs = 120_000): Promise<ToolOutcome> {
	const tag = `t${++toolCalls}`;
	await client.prompt(`TOOL[${tag}]: ${name} ${JSON.stringify(args)}`, undefined, "followUp");
	return toolResult(client, toolCallId(tag), `${name} ${JSON.stringify(args).slice(0, 80)} (${tag})`, timeoutMs);
}

/** The result message of the tool call `callId` in `client`'s session. */
function toolResult(client: RpcClient, callId: string, label: string, timeoutMs: number): Promise<ToolOutcome> {
	return waitUntil(`the result of ${label}`, timeoutMs, async () => {
		const found = (await client.getMessages()).find(m => isRecord(m) && m.role === "toolResult" && m.toolCallId === callId);
		if (!isRecord(found)) return undefined;
		const body = messageText(found);
		return { text: body, first: body.split("\n", 1)[0] ?? "", isError: found.isError === true, details: isRecord(found.details) ? found.details : {} };
	});
}

/** The custom messages of `customType` (`irc:incoming`, `async-result`) in `client`'s session, oldest first. */
async function customMessages(client: RpcClient, customType: string): Promise<Json[]> {
	return (await client.getMessages()).filter(m => isRecord(m) && m.customType === customType).map(m => obj(m, customType));
}

/** Whether some model request (any omp of this scenario, the VMs included) ended with messages that contain every one of `needles`. */
function sawRequest(...needles: string[]): boolean {
	return (provider?.history ?? []).some(entry => needles.every(needle => entry.includes(needle)));
}

/** Throws unless the tool answered with an error result (or not) whose first line starts with `first`. */
function expectResult(label: string, out: ToolOutcome, first: string, isError = false): void {
	if (out.isError !== isError) throw new Error(`${label}: isError is ${out.isError}, expected ${isError}:\n${out.text.slice(0, 800)}`);
	if (!out.first.startsWith(first)) throw new Error(`${label}: the first line ${JSON.stringify(out.first)} does not start with ${JSON.stringify(first)}\n${out.text.slice(0, 800)}`);
}

/** `value` as a list of objects. */
function rows(value: unknown, label: string): Json[] {
	if (!Array.isArray(value)) throw new Error(`${label}: expected an array, got ${JSON.stringify(value)}`);
	return value.map((item, index) => obj(item, `${label}[${index}]`));
}

/** One page of a thread's events as JSON (`kind` as `kind=a,b`). */
async function eventsPage(id: string, query: string): Promise<{ events: Json[] }> {
	const body = await apiJson("GET", `/threads/${id}/events?format=json&${query}&limit=500`, 200);
	return { events: rows(body.events, "events") };
}

/** Turn `id` of a thread detail, or undefined. */
function turnById(thread: Json, id: number): Json | undefined {
	return rows(thread.turns, "turns").find(t => t.id === id);
}

/**
 * Where a thread that does not finish stands, for a failure report: the turns and the last events through the API, the thread's sandboxes
 * in vmon (state, size) and what runs in them, and the last requests the fake model got. Never prints a key or token.
 */
async function diagnoseThread(id: string): Promise<string> {
	const parts: string[] = [];
	try {
		const d = await detail(id);
		parts.push(`phase ${text(d.phase)} error ${JSON.stringify(d.error)} vm ${JSON.stringify(d.vm)}`);
		for (const t of rows(d.turns, "turns")) parts.push(`  turn ${t.id} ${text(t.state)} started ${text(t.startedAt)} reply ${JSON.stringify(text(t.reply).slice(0, 60))} error ${JSON.stringify(text(t.error).slice(0, 120))}`);
		const events = obj(await apiJson("GET", `/threads/${id}/events?format=json&limit=500`, 200), "events").events;
		for (const e of rows(events, "events").slice(-12)) parts.push(`  event #${e.seq} ${text(e.kind)} t${e.turn}: ${JSON.stringify(text(e.text).slice(0, 160))}`);
	} catch (error) {
		parts.push(`(the thread's own state is unavailable: ${error instanceof Error ? error.message : String(error)})`);
	}
	const key = vmonKey ?? "";
	try {
		for (const found of await sandboxesOf(key, id)) {
			const info = await Sandbox.getInfo(found.sandboxId, vmonOptions(key));
			parts.push(`sandbox ${found.sandboxId}: state ${info.state} cpu ${info.cpuCount} memoryMB ${info.memoryMB} started ${info.startedAt.toISOString()}`);
			if (info.state !== "running") continue;
			const sandbox = await Sandbox.connect(found.sandboxId, vmonOptions(key));
			const probe = `ps -eo pid,stat,etime,args --sort=start_time | grep -v 'ps -eo' | tail -6; echo; ss -tni 2>&1 | head -24; echo; ip -br addr; ip route; ip neigh; echo; curl -s -m 8 -o /dev/null -w 'new connection to the fake model: HTTP %{http_code} in %{time_total}s\\n' http://${PROVIDER_HOST}:${provider?.port ?? 0}/health 2>&1`;
			const ps = await sandbox.commands.run(probe, { timeoutMs: 40_000 }).catch((error: unknown) => ({ stdout: `exec failed: ${error instanceof Error ? error.message : String(error)}`, stderr: "" }));
			parts.push(ps.stdout.split("\n").map(line => `    ${line}`).join("\n"));
		}
	} catch (error) {
		parts.push(`(vmon: ${error instanceof Error ? error.message : String(error)})`);
	}
	for (const argv of [["ss", "-tni", "dport", "=", `:${provider?.port ?? 0}`], ["ss", "-tni", "sport", "=", `:${provider?.port ?? 0}`], ["ip", "-br", "addr"], ["ip", "neigh"]]) {
		const out = await Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }).stdout.text().catch(() => "");
		parts.push(`host ${argv.join(" ")}:\n${out.split("\n").slice(0, 24).map(line => `    ${line}`).join("\n")}`);
	}
	parts.push(`fake model: ${provider?.count ?? "?"} requests; its last turn requests (oldest first):\n${(provider?.recentTurns ?? []).map(describeRequest).join("\n  --\n")}`);
	return parts.join("\n");
}

/** A device's omp: one more isolated local omp with the plugin, and no omp-cloud personal file (it pairs instead). */
interface Device {
	name: string;
	client: RpcClient;
	/** The `notify` frames this omp showed, as `<type>: <message>`. */
	notices: string[];
	/** `<XDG_CONFIG_HOME>/omp-cloud/connection.json`, where `/cloud connect` stores the pairing. */
	connectionFile: string;
	/** The text of each builtin slash command's output (`command_output` frames: `/jobs`), oldest first. */
	commandOutputs: string[];
	stderr: () => string;
}

/** Every device omp started, stopped by the cleanup. */
const devices: Device[] = [];

/** stdout of `omp plugin <args>` in the isolated environment `env`; throws with omp's last lines when it fails. */
async function ompPlugin(env: Record<string, string>, ...args: string[]): Promise<string> {
	const proc = Bun.spawn([HOST_OMP.path, "plugin", ...args], {
		// Not the repository: a project-level plugin directory there must not take part.
		cwd: dirname(pluginMarketplace),
		env: isolatedEnv(env),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal: AbortSignal.timeout(120_000),
	});
	const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`omp plugin ${args.join(" ")} exited ${code}: ${(stderr || stdout).trim().split("\n").slice(-4).join(" | ")}`);
	return stdout;
}

/** Installs the plugin into the isolated omp environment `env` the way `omp-cloud setup` does: marketplace add, then install. */
async function installPlugin(env: Record<string, string>): Promise<void> {
	if (pluginMarketplace === "") throw new Error("the plugin's marketplace has not been built (step 0)");
	await ompPlugin(env, "marketplace", "add", pluginMarketplace);
	await ompPlugin(env, "install", "omp-cloud@omp-cloud");
}

async function startDevice(
	name: string,
	root: string,
	providerUrl: string,
	options: { cwd?: string; extraEnv?: Record<string, string>; cloudConfig?: string } = {},
): Promise<Device> {
	const home = join(root, "home");
	const agentDir = join(home, ".omp", "agent");
	const cwd = options.cwd ?? join(root, "work");
	const xdgConfig = join(root, "xdg-config");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(join(agentDir, "models.yml"), modelsYaml(providerUrl));
	await writeFile(join(agentDir, "config.yml"), CONFIG_YAML);
	// A device pairs instead of reading omp-cloud's personal file; an omp that calls the tool as the owner gets one.
	if (options.cloudConfig !== undefined) {
		await mkdir(join(xdgConfig, "omp-cloud"), { recursive: true });
		await writeFile(join(xdgConfig, "omp-cloud", "config.yml"), options.cloudConfig);
	}
	const env = {
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_DATA_HOME: join(root, "xdg-data"),
		XDG_STATE_HOME: join(root, "xdg-state"),
		XDG_CACHE_HOME: join(root, "xdg-cache"),
		...options.extraEnv,
	};
	await installPlugin(env);
	const notices: string[] = [];
	const commandOutputs: string[] = [];
	let stderr = () => "";
	const client = new RpcClient({
		model: MODEL,
		args: [],
		spawn: args =>
			spawnLocal(args, cwd, env, {
				statuses: [],
				notices,
				commandOutputs,
				setStderr: read => {
					stderr = read;
				},
			}),
	});
	const device: Device = { name, client, notices, commandOutputs, connectionFile: join(xdgConfig, "omp-cloud", "connection.json"), stderr: () => stderr() };
	devices.push(device);
	await client.start();
	return device;
}

/** A self-signed identity like `omp-cloud setup` makes (key 0600 in a 0700 directory); the SAN only serves curl-like clients, omp pins the fingerprint. */
interface Identity {
	certFile: string;
	keyFile: string;
	pem: string;
	/** The certificate's DER, as the plugin stores it. */
	der: Buffer;
	/** `SHA256:` and the unpadded base64 of the DER's SHA-256, the form the service logs and `whoami` shows. */
	fingerprint: string;
}

async function makeIdentity(directory: string): Promise<Identity> {
	await mkdir(directory, { recursive: true });
	await chmod(directory, 0o700);
	const certFile = join(directory, "cert.pem");
	const keyFile = join(directory, "key.pem");
	const proc = Bun.spawn(
		[
			"openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2",
			"-subj", "/CN=omp-cloud scenario", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stderr, code] = await Promise.all([proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`openssl req exited ${code}: ${stderr.trim()}`);
	await chmod(keyFile, 0o600);
	const pem = await readFile(certFile, "utf8");
	const der = new X509Certificate(pem).raw;
	return { certFile, keyFile, pem, der, fingerprint: `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/, "")}` };
}

/** One raw HTTP/1.1 exchange on loopback, for requests `fetch` will not send (a foreign Host header). Returns the status code. */
function rawStatus(port: number, request: string): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const socket = connect({ host: "127.0.0.1", port }, () => socket.write(request));
	let received = "";
	socket.setEncoding("utf8");
	socket.setTimeout(10_000, () => socket.destroy(new Error("the raw request timed out")));
	socket.on("data", chunk => {
		received += chunk;
	});
	socket.on("error", reject);
	socket.on("close", () => {
		const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
		if (match?.[1] === undefined) reject(new Error(`no HTTP status in ${JSON.stringify(received.slice(0, 80))}`));
		else resolve(Number(match[1]));
	});
	return promise;
}

async function run(): Promise<void> {
	await report.step("preflight: vmon, gateway, key file", async () => {
		expectEqual("vmon /health", (await fetch(`${VMON_URL}/health`)).status, 204);
		const gateway = await fetch(`${GATEWAY_URL}/healthz`);
		expectEqual("gateway /healthz", gateway.status, 200);
		expectContains("gateway /healthz body", await gateway.text(), "ok");
		vmonKey = (await readFile(VMON_KEY_FILE, "utf8")).trim();
		if (vmonKey === "") throw new Error(`${VMON_KEY_FILE} is empty`);
		clientsBefore = await new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL }).names();
	});

	const dir = await mkdtemp(join(tmpdir(), "omp-cloud-plugin-scenario-"));
	tempDir = dir;
	const home = join(dir, "home");
	const agentDir = join(home, ".omp", "agent");
	const work = join(dir, "work");
	const overlay = join(agentDir, "overlays", "demo.yml");
	const xdgConfig = join(dir, "xdg-config");
	/** The local omp's isolated environment; `omp stats` runs in it too, so it never reads the owner's `~/.omp`. */
	const isolated = {
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: xdgConfig,
		XDG_DATA_HOME: join(dir, "xdg-data"),
		XDG_STATE_HOME: join(dir, "xdg-state"),
		XDG_CACHE_HOME: join(dir, "xdg-cache"),
	};
	/** The served URL of the bare remote the work clone tracks. */
	let remoteUrl = "";
	/** The service's TLS identity: what the remote listener serves and every paired device pins. */
	const identity = await makeIdentity(join(dir, "tls"));
	let providerUrl = "";

	/** A request to the service's TLS listener, trusting only its own certificate (omp pins the fingerprint instead of the host name). */
	const remoteFetch = (path: string, headers: Record<string, string>, init: { method?: string; body?: string } = {}): Promise<Response> =>
		fetch(`https://127.0.0.1:${remotePort}/api/v1${path}`, {
			...init,
			headers,
			tls: { ca: identity.pem, checkServerIdentity: () => undefined },
		});

	await report.step("fake provider, service, temp repo and agent dir", async () => {
		provider = startFakeProvider({ hostname: PROVIDER_HOST, port: 0 });
		providerUrl = `http://${PROVIDER_HOST}:${provider.port}`;
		const providers = obj(obj(Bun.YAML.parse(modelsYaml(providerUrl)), "fake models.yml").providers, "providers");
		// A bare repository behind git smart HTTP with Basic auth: the remote of the work clone and a host the service holds a credential for.
		const remotes = join(dir, "remotes");
		const bareRepo = join(remotes, "app.git");
		await mkdir(remotes, { recursive: true });
		await git(dir, "init", "-q", "--bare", "-b", "main", bareRepo);
		const server = serveGitHttp({ root: remotes, password: gitPassword });
		gitServer = server;
		remoteUrl = server.url("app");
		const config = {
			listen: `127.0.0.1:${listenPort}`,
			apiTokenSha256: createHash("sha256").update(token).digest("hex"),
			dataDir: join(dir, "data"),
			vmon: { url: VMON_URL, keyFile: VMON_KEY_FILE, template: "omp-agent" },
			gateway: { url: GATEWAY_URL, clientsFile: CLIENTS_FILE },
			broker: { url: BROKER_URL, tokenFile: BROKER_TOKEN_FILE },
			models: { default: MODEL, direct: { fake: providers.fake } },
			runner: { idleTimeoutSeconds: 4, turnTimeoutSeconds: 300, questionTimeoutSeconds: 120 },
			git: { hosts: { [server.host]: { credential: `!printf %s ${gitPassword}` } } },
			dashboard: { listen: `127.0.0.1:${dashboardPort}` },
			remote: {
				listen: `127.0.0.1:${remotePort}`,
				certFile: identity.certFile,
				keyFile: identity.keyFile,
				advertise: [`127.0.0.1:${remotePort}`],
				allow: ["127.0.0.0/8"],
			},
		};
		await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2));
		await startService(join(dir, "config.json"), join(dir, "service.log"));

		await mkdir(work, { recursive: true });
		await git(dir, "init", "-q", "-b", "main", work);
		await writeFile(join(work, "README.md"), "# plugin scenario\n");
		// The repository's own file, committed with the clone so the working tree stays clean: the other half of the policy.
		await writeFile(join(work, ".omp-cloud.yml"), `policy:\n  fetch: ${CLOUD_POLICY.fetch}\n`);
		await git(work, "add", "-A");
		await git(work, "-c", "user.name=Scenario", "-c", "user.email=scenario@example.com", "commit", "-q", "-m", "initial");
		// The clone's upstream is the served remote, which holds its main: the handoff is a delta from it.
		await git(work, "remote", "add", "origin", bareRepo);
		await git(work, "push", "-q", "-u", "origin", "main");
		await git(work, "remote", "set-url", "origin", remoteUrl);

		for (const sub of ["skills/demo", "agents", "extensions", "overlays", "sessions"]) await mkdir(join(agentDir, sub), { recursive: true });
		await writeFile(join(agentDir, "models.yml"), modelsYaml(providerUrl));
		await writeFile(join(agentDir, "config.yml"), CONFIG_YAML);
		// omp-cloud's own personal file: the service address and token, and the part of the policy that is the owner's.
		await mkdir(join(xdgConfig, "omp-cloud"), { recursive: true });
		await writeFile(
			join(xdgConfig, "omp-cloud", "config.yml"),
			`url: ${JSON.stringify(origin)}\ntoken: ${JSON.stringify(token)}\npolicy:\n  spend.turnUSD: ${CLOUD_POLICY["spend.turnUSD"]}\n`,
		);
		await writeFile(join(agentDir, "AGENTS.md"), "# demo instructions\n");
		await writeFile(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\nDemo.\n");
		await writeFile(join(agentDir, "agents", "demo.md"), "---\nname: demo\ndescription: A demo subagent\n---\nDemo.\n");
		await writeFile(join(agentDir, "extensions", "demo.ts"), "export default function demo(): void {}\n");
		await writeFile(join(agentDir, "mcp.json"), '{"mcpServers":{}}\n');
		await writeFile(join(agentDir, "agent.db"), "not a database; must never ship\n");
		await writeFile(join(agentDir, "sessions", "marker.txt"), "sessions never ship\n");
		await writeFile(overlay, "retry:\n  enabled: true\n");
	});

	await report.step("0 the plugin as users get it: the release's bundle, a marketplace install, the real /cloud registered and no load failure", async () => {
		const version = text(obj(JSON.parse(await readFile(join(REPO_ROOT, "plugin", "package.json"), "utf8")), "plugin/package.json").version);
		const files = pluginBundleFiles(REPO_ROOT, version);
		if (Object.keys(files).some(name => name.includes("node_modules"))) throw new Error("the bundle carries node_modules");
		const marketplace = join(dir, "plugin-marketplace");
		for (const [name, bytes] of Object.entries(files)) {
			await mkdir(dirname(join(marketplace, name)), { recursive: true });
			await writeFile(join(marketplace, name), bytes);
		}
		// Nothing the plugin imports may resolve into the repository's node_modules: no directory above the bundle has one.
		for (let parent = marketplace; ; parent = dirname(parent)) {
			if (await stat(join(parent, "node_modules")).then(() => true, () => false)) throw new Error(`${join(parent, "node_modules")} exists: the plugin could resolve imports through it`);
			if (dirname(parent) === parent) break;
		}
		pluginMarketplace = marketplace;
		await installPlugin(isolated);
		const listed = obj(JSON.parse(await ompPlugin(isolated, "list", "--json")), "omp plugin list --json");
		const fromMarketplace = rows(listed.marketplace, "marketplace installs").map(entry => text(entry.id));
		expectEqual("marketplace installs", JSON.stringify(fromMarketplace), JSON.stringify(["omp-cloud@omp-cloud"]));
		expectEqual("linked plugins", JSON.stringify(Array.isArray(listed.npm) ? listed.npm : []), JSON.stringify([]));

		// Its own omp process (and session): the help card must not land in the conversation step 1 hands off.
		const probeNotices: string[] = [];
		let probeStderr = () => "";
		const probeCwd = join(dir, "probe-cwd");
		await mkdir(probeCwd, { recursive: true });
		const client = new RpcClient({
			model: MODEL,
			args: [],
			spawn: args => spawnLocal(args, probeCwd, isolated, { statuses: [], notices: probeNotices, setStderr: read => { probeStderr = read; } }),
		});
		try {
			await client.start();
			const command = await waitUntil("/cloud to be registered", 30_000, async () => (await client.getAvailableCommands()).find(c => c.name === "cloud"));
			// The load-failure fallback also registers `/cloud`, with another description.
			expectContains("the /cloud description", command.description, "Hand work to a cloud agent");
			await cloud(client, "help");
			const help = await waitCard(client, "the help card", 30_000, c => c.kind === "notice" && text(c.title).startsWith("☁ omp-cloud"));
			const lines = (Array.isArray(help.lines) ? help.lines : []).map(text).join("\n");
			for (const subcommand of ["list", "show", "send", "pull", "login", "status", "dashboard", "connect", "pair", "devices", "disconnect"]) {
				expectContains("the help card", lines, `/cloud ${subcommand}`);
			}
			const failure = /needs omp|cannot load|failed to load|cannot find package|could not resolve/i;
			const failed = probeNotices.filter(notice => failure.test(notice));
			if (failed.length > 0) throw new Error(`the plugin reported a load failure: ${JSON.stringify(failed)}`);
			if (failure.test(probeStderr())) throw new Error(`the local omp's stderr reports a load failure:\n${probeStderr().split("\n").slice(-12).join("\n")}`);
		} finally {
			await client.stop().catch(() => undefined);
		}
		return `${Object.keys(files).length} bundle files, plugin ${version}`;
	}, shown => shown);

	let thread = "";
	let handoffCommit = "";
	/** The cloud conversation's local identity: the export's session id and the file it lands in. */
	let exportId = "";
	let exportFile = "";
	/** The `count` in the cloud's third reply: how many user messages the fake model saw in turn 3. */
	let cloudCount = 0;

	await report.step("1 handoff: /cloud <task> creates one thread mirroring the session; the personal and repository omp-cloud files reach it as one merged policy", async () => {
		omp = new RpcClient({
			model: MODEL,
			args: ["--config", overlay],
			spawn: args => spawnLocal(args, work, isolated),
		});
		await omp.start();
		const client = omp;
		// A local turn first, so the conversation the cloud continues has history.
		await client.promptAndWait("hello", undefined, 120_000);
		expectEqual("local reply", (await client.getLastAssistantText()) ?? "", "TURN count=1 first=hello");
		handoffCommit = (await git(work, "rev-parse", "HEAD")).trim();

		await cloud(client, TASK);
		const created = await waitUntil("the thread to appear", 120_000, async () => {
			const list = obj(await apiJson("GET", "/threads", 200), "threads").threads;
			return Array.isArray(list) && list.length > 0 ? list : undefined;
		});
		expectEqual("threads", created.length, 1);
		thread = text(obj(created[0], "thread").id);
		createdThreads.push(thread);

		const detailed = await detail(thread);
		expectEqual("model", detailed.model, MODEL);
		expectEqual("ompVersion", detailed.ompVersion, HOST_OMP.version);
		expectEqual("configOverlays", JSON.stringify(detailed.configOverlays), JSON.stringify(["overlays/demo.yml"]));
		const repo = obj(detailed.repo, "repo");
		expectEqual("repo.baseCommit", repo.baseCommit, handoffCommit);
		expectEqual("repo.remoteURL", repo.remoteURL, remoteUrl);
		// Both files reached the thread as one policy: the personal file's cap, the repository file's fetch switch; the dotted key arrived as it is.
		expectEqual("policy merged from the personal file (spend.turnUSD) and the repository file (fetch)", JSON.stringify(detailed.policy), JSON.stringify(CLOUD_POLICY));
		const launch = await waitCard(client, "the launch card", 30_000, c => c.kind === "launch");
		expectEqual("launch card thread", launch.thread, thread);
		// The handoff named the thread with omp's own title generator (the fake model answers it deterministically), before the service saw it.
		expectEqual("thread name", detailed.name, GENERATED_TITLE);
		expectEqual("launch card name", launch.name, GENERATED_TITLE);
		await cloud(client, "list");
		const listed = await waitCard(client, "the inventory card", 30_000, c => c.kind === "inventory");
		expectContains("the inventory card shows the thread's name", JSON.stringify(listed.groups), GENERATED_TITLE);
	}, () => `thread ${thread}`);

	await report.step("2 the shipped setup: allowed files in, denied files out; the conversation reached the cloud", async () => {
		const setup = join(dir, "data", "threads", thread, "setup.tar.gz");
		const entries = await tarList(setup, "-tzf");
		const present = (path: string) => entries.some(e => e === path || e.startsWith(`${path}/`));
		for (const path of ["AGENTS.md", "config.yml", "skills/demo/SKILL.md", "agents/demo.md", "extensions/demo.ts", "overlays/demo.yml"]) {
			if (!present(path)) throw new Error(`setup lacks ${path}; it holds ${JSON.stringify(entries)}`);
		}
		for (const path of ["mcp.json", "agent.db", "sessions", "models.yml"]) {
			if (present(path)) throw new Error(`setup must not hold ${path}; it holds ${JSON.stringify(entries)}`);
		}
		const session = join(dir, "data", "threads", thread, "session.tar");
		const inner = await tarList(session, "-tf");
		if (!inner.some(e => e.endsWith(".jsonl"))) throw new Error(`the stored conversation holds no session file: ${JSON.stringify(inner)}`);
		return entries.length;
	}, count => `${count} setup entries`);

	await report.step("3 the first turn finishes with a result; the person-started thread reports it to the tray, not the transcript", async () => {
		const client = omp ?? fail();
		const done = await waitTurnIdle(thread, 1, 300_000);
		const result = obj(done.result, "result");
		if (text(result.head) === "") throw new Error(`result.head is empty: ${JSON.stringify(result)}`);
		// Measured from the handoff: only the cloud's hello.txt, not the README.md the full-history bundle carried.
		expectEqual("result files/insertions/deletions", `${result.filesChanged}/${result.insertions}/${result.deletions}`, "1/1/0");
		expectContains("reply", text(latestOf(done)?.reply), "DONE=");

		// The default delivery is the tray: the footer status says one unread, and no turn card was posted.
		await waitUntil("the footer status to say one unread", 60_000, async () => (statuses.at(-1) === "☁ 1 unread" ? true : undefined));
		expectEqual("turn cards in the transcript", (await cards(client)).filter(c => c.kind === "turn").length, 0);
		// Reading it posts the card and clears the count.
		await cloud(client, `show ${thread}`);
		await waitCard(client, "the show card", 30_000, c => c.kind === "notice" && c.thread === thread);
		await waitUntil("the footer status to clear", 30_000, async () => (statuses.at(-1) === "" ? true : undefined));
		// The steps that follow read their results from transcript cards.
		await writeFile(
			join(xdgConfig, "omp-cloud", "config.yml"),
			`url: ${JSON.stringify(origin)}\ntoken: ${JSON.stringify(token)}\ndeliver: transcript\npolicy:\n  spend.turnUSD: ${CLOUD_POLICY["spend.turnUSD"]}\n`,
		);
	});

	await report.step("4 ask: question card, /cloud answer, reply and turn card", async () => {
		const client = omp ?? fail();
		await cloud(client, `send ${thread} ASK: pick a color`);
		const question = await waitCard(client, "the question card", 180_000, c => c.kind === "question" && c.thread === thread);
		expectContains("question text", text(question.text), "pick a color");
		await cloud(client, `answer ${thread} blue`);
		const done = await waitTurnIdle(thread, 2, 180_000);
		const reply = text(latestOf(done)?.reply);
		expectContains("reply", reply, "ANSWER=");
		expectContains("reply", reply, "blue");
		const turnCard = await waitCard(client, "the second turn card", 60_000, c => c.kind === "turn" && c.turn === 2);
		expectContains("turn card reply", text(turnCard.reply), "blue");
	});

	await report.step("4b the cloud turn is a job of the local omp: wait blocks on it and returns the turn's result; the cloud agent continues the local conversation", async () => {
		const client = omp ?? fail();
		await cloud(client, `send ${thread} what now`);
		// The running turn is a task job of the local omp, named after the thread. The fake local model calls `wait`, which blocks on it
		// (the scenario's omp runs in RPC mode, which has the job manager but no UI to read the dock from, so `wait` is the proof).
		await client.promptAndWait("WAIT: for the cloud agent", undefined, 240_000);
		const waited = (await client.getLastAssistantText()) ?? "";
		// Turns 1 and 2 were jobs of the same thread and omp still retains them, so it suffixes this turn's id (`<id>-3`).
		const jobId = cloudJobId({ id: thread, name: GENERATED_TITLE });
		const named = new RegExp(`### (${jobId}(?:-\\d+)?) \\[task\\] — completed`).exec(waited);
		if (named === null) throw new Error(`the wait result does not name the cloud job ${jobId}: ${JSON.stringify(waited)}`);
		expectContains("the wait result carries the turn's result", waited, "<task-result");
		expectContains("the wait result carries the turn's result", waited, 'status="completed"');
		const done = await waitTurnIdle(thread, 3, 180_000);
		// The fake model reports the first user message of the conversation it was given: the local "hello".
		const reply = text(latestOf(done)?.reply);
		const counted = /^TURN count=(\d+) first=hello$/.exec(reply);
		if (counted === null) throw new Error(`turn 3's reply is not "TURN count=<n> first=hello": ${JSON.stringify(reply)}`);
		cloudCount = Number(counted[1]);
		// The model that waited got the result once: the turn card names the wait instead of repeating the reply.
		const turnCard = await waitCard(client, "the third turn card", 60_000, c => c.kind === "turn" && c.turn === 3);
		expectEqual("turn 3 card state", turnCard.state, "done");
		return named[1] ?? jobId;
	}, id => `job ${id}`);

	await report.step("5 /cloud pull: omp-cloud/<thread> holds the cloud's file", async () => {
		const client = omp ?? fail();
		await cloud(client, `pull ${thread}`);
		const branch = `omp-cloud/${thread}`;
		await waitUntil("the pulled branch", 60_000, async () => ((await git(work, "branch", "--list", branch)).trim() === "" ? undefined : true));
		expectEqual("hello.txt", await git(work, "show", `${branch}:hello.txt`), "hi\n");
		expectEqual("handoff base is an ancestor", (await git(work, "merge-base", "--is-ancestor", handoffCommit, branch).then(() => "yes")), "yes");
		expectEqual("local branch untouched", (await git(work, "branch", "--show-current")).trim(), "main");
		const users = userTexts(await client.getMessages());
		expectEqual("local user messages", users.includes("hello"), true);
		const joined = (await client.getMessages()).map(messageText).join("\n");
		if (joined.includes("TURN count=") === false) throw new Error("the local session lost its own turn");
	});

	await report.step("5b the cloud conversation is one local session", async () => {
		const client = omp ?? fail();
		const res = await api("GET", `/threads/${thread}/conversation`);
		expectEqual("GET /conversation status", res.status, 200);
		const archive = join(dir, "conversation.tar");
		await writeFile(archive, new Uint8Array(await res.arrayBuffer()));
		exportId = text(obj(JSON.parse(await tarMember(archive, "manifest.json")), "manifest.json").id);
		if (exportId === "") throw new Error("the conversation archive's manifest.json has no id");
		const state = await client.getState();
		if (state.sessionFile === undefined) throw new Error("the local omp has no session file");
		if (exportId === state.sessionId) throw new Error(`the cloud conversation carries the local session's id ${exportId}`);
		const sessionsRoot = dirname(dirname(state.sessionFile));

		const pulled = await waitCard(client, "the pull card", 60_000, c => c.kind === "notice" && text(c.title).startsWith(`Pulled omp-cloud/${thread}`));
		const rows = Array.isArray(pulled.lines) ? pulled.lines.map(text) : [];
		if (!rows.some(row => row.startsWith("session saved"))) throw new Error(`the pull card has no "session saved" row: ${JSON.stringify(rows)}`);

		// The watched turns already synced the conversation and the pull synced it again: still one file, with all three replies.
		let seen = "";
		exportFile = await waitUntil(`one local session ${exportId} holding the replies of turns 1-3`, 60_000, async () => {
			const copies = await sessionCopies(sessionsRoot, exportId);
			const [only] = copies;
			if (copies.length !== 1 || only === undefined) {
				seen = `${copies.length} copies: ${JSON.stringify(copies)}`;
				return undefined;
			}
			const replies = assistantTexts(await readFile(only, "utf8"));
			const done = replies.some(r => r.startsWith("DONE="));
			const answered = replies.some(r => r.includes("ANSWER=") && r.includes("blue"));
			const third = replies.includes(`TURN count=${cloudCount} first=hello`);
			if (!(done && answered && third)) {
				seen = `${only}: DONE= ${done}, ANSWER=blue ${answered}, turn 3 reply ${third}; replies ${JSON.stringify(replies)}`;
				return undefined;
			}
			return only;
		}).catch((error: unknown) => {
			throw new Error(`${error instanceof Error ? error.message : String(error)}\nlast seen under ${sessionsRoot}: ${seen}`);
		});
		return basename(exportFile);
	}, file => file);

	await report.step("5c /cloud resume continues the cloud conversation", async () => {
		const client = omp ?? fail();
		await cloud(client, `resume ${thread}`);
		await waitUntil("the resumed session to be the omp session", 60_000, async () => ((await client.getState()).sessionFile === exportFile ? true : undefined));
		expectEqual("branch", (await git(work, "branch", "--show-current")).trim(), `omp-cloud/${thread}`);
		const replies = (await client.getMessages()).filter(m => isRecord(m) && m.role === "assistant").map(messageText);
		if (!replies.some(r => r.startsWith("DONE="))) throw new Error(`the resumed session lacks turn 1's reply: ${JSON.stringify(replies)}`);
		if (!replies.some(r => r.includes("ANSWER=") && r.includes("blue"))) throw new Error(`the resumed session lacks turn 2's reply: ${JSON.stringify(replies)}`);
		if (!replies.includes(`TURN count=${cloudCount} first=hello`)) throw new Error(`the resumed session lacks turn 3's reply: ${JSON.stringify(replies)}`);

		await client.promptAndWait("and now", undefined, 120_000);
		const reply = (await client.getLastAssistantText()) ?? "";
		const counted = /^TURN count=(\d+) first=hello$/.exec(reply);
		if (counted === null) throw new Error(`the local reply is not "TURN count=<n> first=hello": ${JSON.stringify(reply)}`);
		// The local model saw the whole cloud conversation: more user messages than the cloud model saw in turn 3.
		const count = Number(counted[1]);
		if (count <= cloudCount) throw new Error(`the local model saw ${count} user messages; the cloud's turn 3 alone saw ${cloudCount}`);
		return count;
	}, count => `the local model saw ${count} user messages (turn 3 in the cloud: ${cloudCount})`);

	await report.step("5d omp stats --json counts the cloud spend once", async () => {
		const proc = Bun.spawn([HOST_OMP.path, "stats", "--json"], {
			cwd: work,
			env: isolatedEnv(isolated),
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(120_000),
		});
		const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
		if (code !== 0) throw new Error(`omp stats --json exited ${code}: ${stderr.trim() || stdout.trim()}`);
		// `Syncing session files...` and `Synced ...` lines can precede the JSON.
		const start = stdout.search(/^\{/m);
		if (start < 0) throw new Error(`omp stats --json printed no JSON: ${stdout.slice(0, 500)}`);
		const overall = obj(obj(JSON.parse(stdout.slice(start)), "omp stats --json").overall, "stats overall");

		const turns = (await detail(thread)).turns;
		let cloudCost = 0;
		for (const turn of Array.isArray(turns) ? turns : []) {
			const cost = obj(obj(turn, "turn").usage, "turn usage").cost;
			if (typeof cost !== "number" || !Number.isFinite(cost)) throw new Error(`a turn's usage.cost is not a number: ${JSON.stringify(cost)}`);
			cloudCost += cost;
		}
		const cloudRequests = Math.round(cloudCost / REQUEST_COST);
		if (cloudRequests < 1 || Math.abs(cloudCost / REQUEST_COST - cloudRequests) > 1e-9) {
			throw new Error(`the thread's turns cost ${cloudCost}, not a whole number of requests at ${REQUEST_COST}`);
		}
		const localRequests = 4; // the local "hello", the "WAIT:" turn (the wait call and the answer after it) and the resumed "and now"
		const requests = localRequests + cloudRequests;
		const shown = `${requests} requests (${localRequests} local + ${cloudRequests} cloud), ${requests * REQUEST_COST} USD; stats says ${overall.totalRequests} requests, ${overall.totalCost} USD`;
		expectEqual("overall.totalRequests", overall.totalRequests, requests);
		if (typeof overall.totalCost !== "number" || Math.abs(overall.totalCost - requests * REQUEST_COST) > 1e-9) {
			throw new Error(`overall.totalCost is off: ${shown}`);
		}
		return shown;
	}, shown => shown);

	await report.step("5e dashboard: a one-time link signs in once, a cross-site POST is refused", async () => {
		const client = omp ?? fail();
		const seen = notices.length;
		await cloud(client, "dashboard");
		const link = await waitUntil("the dashboard link notice", 30_000, async () => {
			for (const notice of notices.slice(seen)) {
				const match = /dashboard: (http:\/\/127\.0\.0\.1:\d+)\/#(\S+)/.exec(notice);
				if (match?.[1] !== undefined && match[2] !== undefined) return { base: match[1], code: match[2] };
			}
			return undefined;
		});
		expectEqual("dashboard origin", link.base, `http://127.0.0.1:${dashboardPort}`);

		const post = (headers: Record<string, string>, body: unknown): Promise<Response> =>
			fetch(`${link.base}/session`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
		const sameOrigin = { "x-omp-dashboard": "1", origin: link.base, "sec-fetch-site": "same-origin" };

		// The guard answers before the code is looked at, so the refused request leaves the code usable.
		const crossSite = await post({ ...sameOrigin, "sec-fetch-site": "cross-site" }, { code: link.code });
		expectEqual("cross-site sign-in status", crossSite.status, 403);
		await crossSite.body?.cancel();

		const signedIn = await post(sameOrigin, { code: link.code });
		expectEqual("sign-in status", signedIn.status, 204);
		const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		if (!cookie.startsWith("omp_cloud_session=")) throw new Error("the sign-in set no omp_cloud_session cookie");

		const listed = await fetch(`${link.base}/api/v1/threads`, { headers: { cookie } });
		expectEqual("GET /api/v1/threads with the cookie", listed.status, 200);
		const listing = obj(await listed.json(), "dashboard threads").threads;
		const ids = (Array.isArray(listing) ? listing : []).map(t => text(obj(t, "thread").id));
		if (!ids.includes(thread)) throw new Error(`the dashboard's thread list lacks ${thread}: ${JSON.stringify(ids)}`);
		const anonymous = await fetch(`${link.base}/api/v1/threads`);
		expectEqual("GET /api/v1/threads without the cookie", anonymous.status, 401);
		await anonymous.body?.cancel();

		const reused = await post(sameOrigin, { code: link.code });
		expectEqual("reused code status", reused.status, 401);
		await reused.body?.cancel();
	});

	// The cloud tool, called by the fake model of a second local omp that has its own repository (a remote the service can read) and the owner's token.
	const REPO_REF = "scn-tool-repo";
	const toolRoot = join(dir, "tool-omp");
	const toolWork = join(toolRoot, "work");
	let toolOmp: Device | null = null;
	let toolRemote = "";
	let repoThread = "";
	let scratchThread = "";
	let toolSession = "";
	const requireTool = (): RpcClient => (toolOmp ?? fail()).client;
	/** The owner answers a question through the API, as a person on the cards would. */
	const ownerAnswers = async (id: string, label: string): Promise<void> => {
		const question = obj((await detail(id)).question, `the question of ${id}`);
		await apiJson("POST", `/threads/${id}/turns/${question.turn}/questions/${question.id}/answer`, 200, { selected: [label] });
	};

	await report.step("8a tool omp: a second local omp calls the cloud tool through its fake model; info reports the service", async () => {
		if (gitServer === null) throw new Error("the git server is not running");
		const server: GitHttpServer = gitServer;
		const toolBare = join(dir, "remotes", "toolapp.git");
		await git(dir, "init", "-q", "--bare", "-b", "main", toolBare);
		await mkdir(toolWork, { recursive: true });
		await git(dir, "init", "-q", "-b", "main", toolWork);
		await writeFile(join(toolWork, "README.md"), "# tool scenario\n");
		await git(toolWork, "add", "-A");
		await git(toolWork, "-c", "user.name=Scenario", "-c", "user.email=scenario@example.com", "commit", "-q", "-m", "initial");
		await git(toolWork, "remote", "add", "origin", toolBare);
		await git(toolWork, "push", "-q", "-u", "origin", "main");
		toolRemote = server.url("toolapp");
		await git(toolWork, "remote", "set-url", "origin", toolRemote);

		toolOmp = await startDevice("tool", toolRoot, providerUrl, { cwd: toolWork, cloudConfig: `url: ${JSON.stringify(origin)}\ntoken: ${JSON.stringify(token)}\n` });
		// A bash command the cloud agent must ask about (threads started from here on carry the rule): the approval question of 8g.
		await apiJson("PUT", "/settings", 200, { settings: { "policy.bash.patterns": [{ match: "touch /tmp/approve*", approval: "prompt" }] } });

		const version = text(obj(JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")), "package.json").version);
		const info = await callCloud(requireTool(), { op: "info" });
		expectResult("info", info, `cloud info: ok omp-cloud ${version}`);
		for (const expected of [`omp-cloud ${version} (api ${API_VERSION})`, "you: the owner", "capabilities: threads.paging", "threads.irc", "fake/fake-model", "message 32768 bytes", "(served)"]) {
			expectContains("info text", info.text, expected);
		}
		if (info.text.includes("☁")) throw new Error(`the tool text carries a ☁: ${info.text.slice(0, 200)}`);
		const capabilities = Array.isArray(info.details.capabilities) ? info.details.capabilities : [];
		for (const capability of ["threads.idempotency", "threads.scratch", "inspect", "messages.interrupt"]) {
			if (!capabilities.includes(capability)) throw new Error(`info.details.capabilities lacks ${capability}: ${JSON.stringify(capabilities)}`);
		}
		expectEqual("info caller", JSON.stringify(info.details.caller), JSON.stringify({ kind: "owner", name: "owner" }));
		const models = Array.isArray(info.details.models) ? info.details.models : [];
		if (!models.includes("fake/fake-model")) throw new Error(`info.details.models lacks fake/fake-model: ${JSON.stringify(models)}`);
	});

	await report.step("8b delegate: a batch of two (one with a ref in the repository, one scratch) starts two tool-origin threads", async () => {
		const batch = await callCloud(requireTool(), {
			op: "delegate",
			tasks: [
				{ task: "BASH: printf 'from repo\\n' > repo.txt", name: "repo-task", ref: REPO_REF, workspace: "repo", conversation: "full" },
				{ task: "BASH: printf 'from scratch\\n' > scratch.txt", name: "scratch-task", workspace: "scratch", conversation: "none" },
			],
		}, 240_000);
		expectResult("delegate", batch, "cloud delegate: ok 2 of 2 started");
		const outcomes = rows(batch.details.outcomes, "delegate outcomes");
		if (outcomes.length !== 2 || outcomes.some(o => o.ok !== true)) throw new Error(`delegate outcomes: ${JSON.stringify(outcomes)}`);
		const [repoOutcome, scratchOutcome] = outcomes;
		repoThread = text(repoOutcome?.thread);
		scratchThread = text(scratchOutcome?.thread);
		createdThreads.push(repoThread, scratchThread);
		expectEqual("outcome workspaces", JSON.stringify(outcomes.map(o => o.workspace)), JSON.stringify(["repo", "scratch"]));
		expectEqual("outcome replayed", JSON.stringify(outcomes.map(o => o.replayed)), JSON.stringify([false, false]));
		expectEqual("repo outcome ref", repoOutcome?.ref, REPO_REF);
		expectEqual("scratch outcome ref", scratchOutcome?.ref, "");
		expectEqual("repo outcome branch", repoOutcome?.branch, `omp-cloud/${repoThread}`);
		expectContains("delegate text", batch.text, repoThread);
		expectContains("delegate text", batch.text, scratchThread);
		expectContains("delegate text of the conversation=full task", batch.text, "conversation: forked from this session");
		if (batch.text.includes("conversation: not shipped")) throw new Error("the output names a conversation that was not shipped though no line is the rule for none");
		expectContains("delegate text", batch.text, `ref: ${REPO_REF}`);
		if (batch.text.includes("workspace: repo by default") || batch.text.includes("workspace: scratch by default")) throw new Error("the output says a workspace was defaulted though both tasks named one");

		const repo = await detail(repoThread);
		const scratch = await detail(scratchThread);
		toolSession = text(repo.session);
		if (toolSession === "") throw new Error(`the repo thread carries no session: ${JSON.stringify(repo.session)}`);
		expectEqual("repo thread meta", JSON.stringify([repo.origin, repo.ref, repo.scratch, repo.name, obj(repo.repo, "repo").remoteURL]), JSON.stringify(["tool", REPO_REF, false, "repo-task", toolRemote]));
		expectEqual("scratch thread meta", JSON.stringify([scratch.origin, scratch.ref, scratch.scratch, scratch.name, scratch.session]), JSON.stringify(["tool", "", true, "scratch-task", toolSession]));
	}, () => `repo ${repoThread}, scratch ${scratchThread}`);

	await report.step("8c replay and list: the same ref creates nothing; list with mine, filters and a cursor", async () => {
		const tool = requireTool();
		// The same ref with the same task replays; with a different task it is refused (the ref already names a thread with another task).
		const replay = await callCloud(tool, { op: "delegate", task: "BASH: printf 'from repo\\n' > repo.txt", ref: REPO_REF });
		expectResult("replay", replay, `cloud delegate: ok found existing thread ${repoThread}`);
		expectEqual("replayed", JSON.stringify(rows(replay.details.outcomes, "outcomes").map(o => [o.thread, o.replayed])), JSON.stringify([[repoThread, true]]));
		expectContains("replay text", replay.text, "(replayed)");
		expectContains("replay text", replay.text, "workspace: repo by default");
		expectEqual("threads with the ref", Number(obj(await apiJson("GET", `/threads?ref=${REPO_REF}`, 200), "list").total), 1);
		const changed = await callCloud(tool, { op: "delegate", task: "BASH: printf 'never\\n' > never.txt", ref: REPO_REF });
		expectResult("a different task under the same ref", changed, `cloud delegate: error conflict 409: ref "${REPO_REF}" already names thread ${repoThread}, which has a different task`, true);
		const changedOutcome = rows(changed.details.outcomes, "outcomes")[0];
		expectEqual("the refused task's outcome", JSON.stringify([changedOutcome?.ok, obj(changedOutcome?.error, "outcome error").code]), JSON.stringify([false, "conflict"]));
		expectEqual("threads with the ref after the refusal", Number(obj(await apiJson("GET", `/threads?ref=${REPO_REF}`, 200), "list").total), 1);

		const mine = await callCloud(tool, { op: "list", filter: { mine: true } });
		expectResult("list mine", mine, "cloud list: ok 2 of 2 threads");
		const ids = (rows(mine.details.threads, "listed threads")).map(t => text(t.id)).sort();
		expectEqual("mine", JSON.stringify(ids), JSON.stringify([repoThread, scratchThread].sort()));
		expectContains("list row", mine.text, `- ${repoThread} "repo-task"`);
		expectContains("list row", mine.text, "by tool");
		expectContains("list row of the scratch thread", mine.text, "scratch");
		expectContains("end of list", mine.text, "end of list");

		const byRef = await callCloud(tool, { op: "list", filter: { mine: true, ref: REPO_REF } });
		expectResult("list by ref", byRef, "cloud list: ok 1 of 1 threads");
		expectEqual("list by ref rows", JSON.stringify(rows(byRef.details.threads, "threads").map(t => t.id)), JSON.stringify([repoThread]));
		const byOrigin = await callCloud(tool, { op: "list", filter: { origin: "user" }, limit: 100 });
		expectResult("list origin user", byOrigin, "cloud list: ok ");
		const userIds = rows(byOrigin.details.threads, "threads").map(t => text(t.id));
		if (!userIds.includes(thread)) throw new Error(`the user-started thread ${thread} is not among origin=user: ${JSON.stringify(userIds)}`);
		if (userIds.includes(repoThread) || userIds.includes(scratchThread)) throw new Error("origin=user listed a tool-origin thread");

		// The cursor is a point in time (last activity): both threads must stop moving first, or a thread finishing between the two pages
		// moves past the cursor and the second page is empty. A finished turn and the VM's pause are both activity.
		for (const id of [repoThread, scratchThread]) {
			await waitThread(id, `the turn of ${id} to end and its VM to pause`, 120_000, t => t.phase === "idle" && isRecord(t.vm) && t.vm.state === "paused");
		}
		const first = await callCloud(tool, { op: "list", filter: { mine: true }, limit: 1 });
		expectResult("list page 1", first, "cloud list: ok 1 of 2 threads");
		const cursor = first.details.next;
		if (typeof cursor !== "string") throw new Error(`the first page has no next cursor: ${JSON.stringify(first.details)}`);
		expectContains("page 1 next line", first.text, "next: cloud ");
		const second = await callCloud(tool, { op: "list", filter: { mine: true }, limit: 1, cursor });
		expectResult("list page 2", second, "cloud list: ok 1 of 2 threads");
		expectEqual("page 2 next", second.details.next, null);
		const paged = [...rows(first.details.threads, "page 1"), ...rows(second.details.threads, "page 2")].map(t => text(t.id)).sort();
		expectEqual("the two pages", JSON.stringify(paged), JSON.stringify(ids));
		const none = await callCloud(tool, { op: "list", filter: { mine: true, ref: "no-such-ref" } });
		expectResult("list without matches", none, "cloud list: ok 0 of 0 threads");
		const badSince = await callCloud(tool, { op: "list", filter: { since: "yesterday" } });
		expectResult("list with a bad since", badSince, "cloud list: error invalid", true);
	});

	await report.step("8d wait until all, status by id, suffix, name and list, diff and files of the cloud's work", async () => {
		const tool = requireTool();
		const waited = await callCloud(tool, { op: "wait", thread: [repoThread, scratchThread], until: "all", timeoutSec: 300 }, 330_000);
		expectResult("wait", waited, "cloud wait: ok 2 of 2 settled (until all)");
		expectEqual("wait outcomes", JSON.stringify(rows(waited.details.outcomes, "outcomes").map(o => [o.thread, o.outcome]).sort()), JSON.stringify([[repoThread, "done"], [scratchThread, "done"]].sort()));
		expectContains("wait text", waited.text, "done");

		const status = await callCloud(tool, { op: "status", thread: repoThread });
		expectResult("status", status, `cloud status: ok ${repoThread} idle`);
		for (const expected of ["origin: tool (this session)", `ref ${REPO_REF}`, "workspace: repo ", "following: ", `result: omp-cloud/${repoThread} @ `, "next: "]) {
			expectContains("status text", status.text, expected);
		}
		expectEqual("status details", JSON.stringify(rows(status.details.threads, "threads").map(t => [t.id, t.phase, t.origin, t.scratch])), JSON.stringify([[repoThread, "idle", "tool", false]]));
		const bySuffix = await callCloud(tool, { op: "status", thread: repoThread.slice(-6) });
		expectResult("status by id suffix", bySuffix, `cloud status: ok ${repoThread} idle`);
		const byName = await callCloud(tool, { op: "status", thread: "repo-t" });
		expectResult("status by name prefix", byName, `cloud status: ok ${repoThread} idle`);
		const both = await callCloud(tool, { op: "status", thread: [repoThread, scratchThread], include: ["result"], turns: 0 });
		expectResult("status of two", both, "cloud status: ok 2 of 2 threads");
		expectContains("status of the scratch thread", both.text, "workspace: scratch");
		const missing = await callCloud(tool, { op: "status", thread: "zzzzzzzzzzzz" });
		expectResult("status of a missing thread", missing, "cloud status: error not_found", true);
		expectEqual("error envelope", obj(missing.details.error, "details.error").code, "not_found");

		const stat = await callCloud(tool, { op: "diff", thread: repoThread, stat: true });
		expectResult("diff stat", stat, `cloud diff: ok ${repoThread}: 1 file`);
		expectEqual("diff stat details", JSON.stringify([stat.details.files, stat.details.insertions, stat.details.deletions]), JSON.stringify([1, 1, 0]));
		expectContains("diff stat text", stat.text, "repo.txt");
		const patch = await callCloud(tool, { op: "diff", thread: repoThread });
		expectResult("diff", patch, `cloud diff: ok ${repoThread}: diff `);
		expectContains("diff text", patch.text, "+from repo");
		const cut = await callCloud(tool, { op: "diff", thread: repoThread, maxBytes: 20 });
		expectContains("cut diff text", cut.text, "cut: showing 20 of ");
		if (!(Number(cut.details.truncated) > 20)) throw new Error(`diff details.truncated is not the full length: ${JSON.stringify(cut.details)}`);
		const scratchStat = await callCloud(tool, { op: "diff", thread: scratchThread, stat: true });
		expectContains("scratch diff stat", scratchStat.text, "scratch.txt");

		const tree = await callCloud(tool, { op: "files", thread: repoThread });
		expectResult("files", tree, `cloud files: ok ${repoThread}: `);
		expectEqual("files kind", tree.details.kind, "tree");
		expectContains("files text", tree.text, "f repo.txt (10 bytes)");
		expectContains("files text", tree.text, "README.md");
		const file = await callCloud(tool, { op: "files", thread: repoThread, path: "repo.txt" });
		expectResult("file", file, `cloud files: ok ${repoThread}: repo.txt `);
		expectEqual("file details", JSON.stringify([file.details.kind, file.details.size, file.details.next]), JSON.stringify(["file", 10, null]));
		expectContains("file text", file.text, "from repo");
		const onBase = await callCloud(tool, { op: "files", thread: repoThread, path: "repo.txt", ref: "base" });
		expectResult("a file the base lacks", onBase, "cloud files: error not_found", true);
		const badRef = await callCloud(tool, { op: "files", thread: repoThread, path: "repo.txt", ref: "weird" });
		expectResult("files with a bad ref", badRef, "cloud files: error invalid", true);
	});

	await report.step("8e send, read paging and events: a long reply is read in pages, events page by cursor", async () => {
		const tool = requireTool();
		const sent = await callCloud(tool, { op: "send", thread: scratchThread, text: "LONG:3000" });
		expectResult("send", sent, `cloud send: ok ${scratchThread} turn 2`);
		expectEqual("send details", JSON.stringify([sent.details.turn, sent.details.mode, sent.details.interrupted, sent.details.following]), JSON.stringify([2, "queue", false, "wake"]));
		// Queue mode is omp's own IRC now: an idle thread is woken (the receipt), and the message starts turn 2.
		expectEqual("send receipt", sent.details.receipt, "woken");
		expectContains("send text", sent.text, "delivered: woken; turn 2 queued");
		const waited = await callCloud(tool, { op: "wait", thread: scratchThread, timeoutSec: 240 }, 270_000);
		if (!waited.first.startsWith("cloud wait: ok 1 of 1 settled")) throw new Error(`${waited.first}\n${await diagnoseThread(scratchThread)}`);
		expectResult("wait", waited, "cloud wait: ok 1 of 1 settled (until any)");
		expectEqual("wait outcome", JSON.stringify(rows(waited.details.outcomes, "outcomes").map(o => o.outcome)), JSON.stringify(["done"]));

		const page = await callCloud(tool, { op: "read", thread: scratchThread, limit: 1000 });
		if (page.details.total !== longReply(3000).length) {
			const requests = (provider?.recentTurns ?? []).map(describeRequest).join("\n  --\n");
			throw new Error(`turn 2's reply is not DONE= and 3000 characters of counter (total ${JSON.stringify(page.details.total)}):\n${page.text.slice(0, 300)}\nthe fake model's last turn requests (oldest first):\n${requests}`);
		}
		expectResult("read", page, `cloud read: ok ${scratchThread} turn 2 reply, offset 0-1000 of `);
		expectContains("read first line", page.first, "; next offset=1000");
		expectContains("read text", page.text, longReply(3000).slice(0, 100));
		expectContains("read text", page.text, "next: cloud ");
		const total = Number(page.details.total);
		if (total !== longReply(3000).length) throw new Error(`the reply is not DONE= and 3000 characters: total ${total}`);
		expectEqual("read details", JSON.stringify([page.details.turn, page.details.part, page.details.offset, page.details.end, page.details.next]), JSON.stringify([2, "reply", 0, 1000, 1000]));
		const rest = await callCloud(tool, { op: "read", thread: scratchThread, turn: 2, offset: 1000, limit: 32000 });
		expectResult("read rest", rest, `cloud read: ok ${scratchThread} turn 2 reply, offset 1000-${total} of ${total}`);
		expectContains("read rest text", rest.text, "end: all of the text has been shown");
		expectEqual("read rest next", rest.details.next, null);
		const prompt = await callCloud(tool, { op: "read", thread: scratchThread, turn: 2, part: "text" });
		expectContains("the turn's prompt", prompt.text, "LONG:3000");
		const noTurn = await callCloud(tool, { op: "read", thread: scratchThread, turn: 99 });
		expectResult("read of a missing turn", noTurn, "cloud read: error not_found", true);

		const done = await callCloud(tool, { op: "events", thread: scratchThread, kinds: ["turn_done"] });
		expectResult("events", done, `cloud events: ok ${scratchThread}: 2 events after seq 0`);
		expectContains("events text", done.text, "turn_done");
		const one = await callCloud(tool, { op: "events", thread: scratchThread, limit: 1 });
		expectEqual("events limit 1", one.details.count, 1);
		const next = one.details.next;
		if (typeof next !== "number") throw new Error(`the first event page has no next: ${JSON.stringify(one.details)}`);
		expectContains("events next line", one.text, `next: after=${next}`);
		const following = await callCloud(tool, { op: "events", thread: scratchThread, limit: 1, after: next });
		expectEqual("the page after", following.details.after, next);
		const ofTurn = await callCloud(tool, { op: "events", thread: scratchThread, turn: 1, limit: 200 });
		expectEqual("events of turn 1 name another turn", ofTurn.text.includes(" t2 "), false);
	}, () => `scratch ${scratchThread}`);

	await report.step("8f interrupt: the running turn is stopped and the new turn runs first; an agent the model started has no ask", async () => {
		const tool = requireTool();
		const slow = await callCloud(tool, { op: "send", thread: scratchThread, text: "BASH: sleep 90" });
		expectResult("send of the slow turn", slow, `cloud send: ok ${scratchThread} turn 3`);
		await waitThread(scratchThread, "turn 3 to run", 120_000, t => turnById(t, 3)?.state === "running");
		const interrupt = await callCloud(tool, { op: "send", thread: scratchThread, text: "ASK: pick a color", mode: "interrupt" });
		expectResult("interrupting send", interrupt, `cloud send: ok ${scratchThread} turn 4`);
		expectEqual("interrupt details", JSON.stringify([interrupt.details.mode, interrupt.details.interrupted]), JSON.stringify(["interrupt", true]));
		expectContains("interrupt text", interrupt.text, "the running turn was stopped first");

		// The agent the model started has no `ask` tool: the interrupting turn finishes on its own, no question is raised.
		const waited = await callCloud(tool, { op: "wait", thread: scratchThread, on: ["done"], timeoutSec: 240 }, 270_000);
		expectResult("wait for the interrupting turn", waited, "cloud wait: ok 1 of 1 settled");
		expectEqual("wait outcome", JSON.stringify(rows(waited.details.outcomes, "outcomes").map(o => o.outcome)), JSON.stringify(["done"]));
		const thread4 = await waitTurnIdle(scratchThread, 4, 120_000);
		const stopped = turnById(thread4, 3);
		expectEqual("the interrupted turn", JSON.stringify([stopped?.state, stopped?.error]), JSON.stringify(["failed", "stopped by owner"]));
		const asking = turnById(thread4, 4);
		expectEqual("the interrupting turn", asking?.state, "done");
		expectEqual("the interrupting turn's questions", JSON.stringify(asking?.questions ?? []), JSON.stringify([]));
		expectContains("the interrupting turn's reply", text(asking?.reply), "ANSWER=");
	});

	await report.step("8f2 an adopted person-started thread still asks: send adopts it, wait names the question, answer picks an option", async () => {
		const tool = requireTool();
		const n = rows((await detail(thread)).turns, "turns").length + 1;
		const sent = await callCloud(tool, { op: "send", thread, text: "ASK: pick a color", follow: "wake" });
		expectResult("send of the asking turn", sent, `cloud send: ok ${thread} turn ${n}`);
		const waiting = await callCloud(tool, { op: "wait", thread, on: ["question"], timeoutSec: 240 }, 270_000);
		expectResult("wait for the question", waiting, "cloud wait: ok 1 of 1 settled");
		expectEqual("wait outcome", JSON.stringify(rows(waiting.details.outcomes, "outcomes").map(o => o.outcome)), JSON.stringify(["question"]));
		expectContains("wait text", waiting.text, `waiting for an answer (ask, question ${n}:`);
		const status = await callCloud(tool, { op: "status", thread });
		expectResult("status while waiting", status, `cloud status: ok ${thread} waiting`);
		expectContains("status text", status.text, `Question ${n}:`);
		expectContains("status text", status.text, "pick a color");
		expectContains("status text", status.text, "question: ask, expires ");
		expectEqual("status question kind", obj(rows(status.details.threads, "threads")[0]?.question, "question").kind, "ask");

		const answered = await callCloud(tool, { op: "answer", thread, selected: ["blue"] });
		expectResult("answer", answered, `cloud answer: ok question ${n}:`);
		expectContains("answer text", answered.text, "Answered: blue");
		expectEqual("answer details", JSON.stringify([answered.details.kind, answered.details.selected]), JSON.stringify(["ask", ["blue"]]));
		const again = await callCloud(tool, { op: "wait", thread, on: ["done"], timeoutSec: 240 }, 270_000);
		expectEqual("wait after the answer", JSON.stringify(rows(again.details.outcomes, "outcomes").map(o => o.outcome)), JSON.stringify(["done"]));
		expectContains("the asking turn's reply", text(turnById(await detail(thread), n)?.reply), "blue");
	});

	await report.step("8g refusals: answer cannot answer a tool approval or a push approval; the owner does", async () => {
		const tool = requireTool();
		const refusal = "the user answers it";

		const touch = await callCloud(tool, { op: "send", thread: scratchThread, text: "BASH: touch /tmp/approve-x" });
		expectResult("send of the approval turn", touch, `cloud send: ok ${scratchThread} turn 5`);
		const asked = await callCloud(tool, { op: "wait", thread: scratchThread, on: ["question"], timeoutSec: 240 }, 270_000);
		expectContains("wait text", asked.text, "(approval, question 5:");
		expectContains("wait text", asked.text, "tool approval");
		const approval = await callCloud(tool, { op: "answer", thread: scratchThread, selected: ["Approve"] });
		expectResult("answer of an approval", approval, "cloud answer: error forbidden", true);
		expectContains("answer refusal", approval.text, refusal);
		expectEqual("answer error envelope", obj(approval.details.error, "details.error").code, "forbidden");
		const stillAsking = obj((await detail(scratchThread)).question, "the pending question");
		expectEqual("the approval is still pending", stillAsking.kind, "approval");
		await ownerAnswers(scratchThread, "Deny");
		await waitTurnIdle(scratchThread, 5, 120_000);

		await apiJson("PUT", "/settings", 200, { settings: { "git.push": "ask" } });
		try {
			const change = await callCloud(tool, { op: "send", thread: repoThread, text: "BASH: printf 'q\\n' > q.txt" });
			expectResult("send of the push turn", change, `cloud send: ok ${repoThread} turn 2`);
			const waiting = await callCloud(tool, { op: "wait", thread: repoThread, on: ["question"], timeoutSec: 240 }, 270_000);
			expectContains("wait text", waiting.text, "(push, question 2:");
			expectContains("wait text", waiting.text, "push approval");
			const push = await callCloud(tool, { op: "answer", thread: repoThread, selected: ["Push"] });
			expectResult("answer of a push", push, "cloud answer: error forbidden", true);
			expectContains("push refusal", push.text, refusal);
			expectEqual("push error envelope", obj(push.details.error, "details.error").code, "forbidden");
			expectEqual("the push is still pending", obj((await detail(repoThread)).question, "the pending question").kind, "push");
			await ownerAnswers(repoThread, "Do not push");
			const after = await waitTurnIdle(repoThread, 2, 120_000);
			expectEqual("result.pushed", obj(after.result, "result").pushed, false);
			const turn2 = turnById(after, 2);
			const q = await api("GET", `/threads/${repoThread}/files/q.txt`);
			if (q.status !== 200) throw new Error(`the repo thread's turn 2 did not write q.txt (files ${q.status}); turn 2 text ${JSON.stringify(text(turn2?.text).slice(0, 200))} reply ${JSON.stringify(text(turn2?.reply).slice(0, 200))}\n${await diagnoseThread(repoThread)}`);
		} finally {
			await apiJson("PUT", "/settings", 200, { settings: { "git.push": null } });
		}
	});

	await report.step("8h pull (fetch, worktree, scratch clone, wrong repository), delete (confirm, a user's thread refused), stop all-mine", async () => {
		const tool = requireTool();
		const branch = `omp-cloud/${repoThread}`;
		const fetched = await callCloud(tool, { op: "pull", thread: repoThread }, 240_000);
		expectResult("pull", fetched, `cloud pull: ok fetched ${branch} @ `);
		expectContains("pull text", fetched.text, "mode: fetch");
		expectContains("pull text", fetched.text, "working tree: not touched");
		expectEqual("pull details", JSON.stringify([fetched.details.mode, fetched.details.branch, fetched.details.checkedOutMoved]), JSON.stringify(["fetch", branch, false]));
		expectEqual("the fetched file", await git(toolWork, "show", `${branch}:repo.txt`), "from repo\n");
		expectEqual("the fetched second turn", await git(toolWork, "show", `${branch}:q.txt`), "q\n");
		expectEqual("the checked-out branch", (await git(toolWork, "branch", "--show-current")).trim(), "main");

		const worktree = join(toolRoot, "worktree");
		const checkedOut = await callCloud(tool, { op: "pull", thread: repoThread, apply: "worktree", into: worktree }, 240_000);
		expectResult("pull worktree", checkedOut, `cloud pull: ok checked out ${branch} @ `);
		expectEqual("worktree details", JSON.stringify([checkedOut.details.mode, checkedOut.details.path]), JSON.stringify(["worktree", worktree]));
		expectEqual("the worktree's file", await readFile(join(worktree, "repo.txt"), "utf8"), "from repo\n");
		expectContains("git worktree list", await git(toolWork, "worktree", "list"), worktree);

		const clone = join(toolRoot, "scratch-clone");
		const noInto = await callCloud(tool, { op: "pull", thread: scratchThread });
		expectResult("pull of a scratch thread without into", noInto, "cloud pull: error ", true);
		expectContains("scratch pull refusal", noInto.text, "into");
		const cloned = await callCloud(tool, { op: "pull", thread: scratchThread, into: clone }, 240_000);
		expectResult("pull of a scratch thread", cloned, "cloud pull: ok ");
		expectEqual("clone details", JSON.stringify([cloned.details.mode, cloned.details.path]), JSON.stringify(["clone", clone]));
		expectEqual("the cloned file", await readFile(join(clone, "scratch.txt"), "utf8"), "from scratch\n");

		// The owner's own omp sits in another repository: it holds neither the handoff commit nor the remote.
		const wrong = await callCloud(omp ?? fail(), { op: "pull", thread: repoThread });
		expectResult("pull into the wrong repository", wrong, "cloud pull: error conflict", true);
		expectEqual("wrong repository envelope", obj(wrong.details.error, "details.error").code, "conflict");
		expectEqual("branches of the wrong repository", (await git(work, "branch", "--list", branch)).trim(), "");

		// delete: confirm is required; a thread the model did not start in this session needs force
		const unconfirmed = await callCloud(tool, { op: "delete", thread: repoThread });
		expectResult("delete without confirm", unconfirmed, "cloud delete: error invalid", true);
		expectEqual("the thread after an unconfirmed delete", (await api("GET", `/threads/${repoThread}`)).status, 200);
		const users = await callCloud(tool, { op: "delete", thread, confirm: true });
		expectResult("delete of a user's thread", users, "cloud delete: error forbidden", true);
		expectEqual("the user's thread after a refused delete", (await api("GET", `/threads/${thread}`)).status, 200);
		const deleted = await callCloud(tool, { op: "delete", thread: [repoThread, scratchThread], confirm: true }, 240_000);
		expectResult("delete", deleted, "cloud delete: ok 2 of 2 deleted");
		expectEqual("deleted", JSON.stringify(Array.isArray(deleted.details.deleted) ? [...deleted.details.deleted].sort() : null), JSON.stringify([repoThread, scratchThread].sort()));
		const key = vmonKey ?? "";
		await waitUntil("the sandboxes and gateway clients of the tool threads to go", 60_000, async () => {
			for (const id of [repoThread, scratchThread]) if ((await sandboxesOf(key, id)).length > 0 || (await clientsOf(id)).length > 0) return undefined;
			return true;
		});
		for (const id of [repoThread, scratchThread]) expectEqual(`detail of ${id} after the delete`, (await api("GET", `/threads/${id}`)).status, 404);

		const nothing = await callCloud(tool, { op: "stop", thread: "all-mine" });
		expectResult("stop all-mine", nothing, "cloud stop: ok nothing to stop");
		await apiJson("PUT", "/settings", 200, { settings: { "policy.bash.patterns": null } });
	});

	// Orchestration parity: a cloud agent behaves like a native subagent for the local model. The tool omp's fake model drives omp's own
	// `read`, `write` and `wait` (`TOOL[tag]: <name> {json}`); the cloud agent's own model is the fake model in the VM (`LONG:<n>`,
	// `WRITEPARENT: <text>`).
	const ORCH_PROMPT = "LONG:80";
	let orchThread = "";
	/** The cloud agent's id in the tool omp's registry: its job id, `OrchAgent`. */
	let orchAgent = "";
	let orchJob = "";
	/** `[cloud]` turn cards (user messages) of thread `id` in the session of `client`: omp's async-result, an IRC message or a wait result replaces them for a model-started thread. */
	const turnCards = async (client: RpcClient, id: string): Promise<string[]> =>
		(await client.getMessages()).filter(m => isRecord(m) && m.role === "user" && messageText(m).startsWith("[cloud]") && messageText(m).includes(`· ${id} turn `)).map(messageText);

	await report.step("9a a model-started cloud agent is a registered agent: agent:// and proc:// resolve while it runs, its result arrives as omp's async-result and no [cloud] turn card", async () => {
		const client = requireTool();
		const started = await callCloud(client, { op: "delegate", task: ORCH_PROMPT, name: "orch-agent", ref: "scn-orch", workspace: "scratch", conversation: "none" }, 240_000);
		expectResult("delegate", started, "cloud delegate: ok started ");
		const outcome = rows(started.details.outcomes, "delegate outcomes")[0];
		orchThread = text(outcome?.thread);
		createdThreads.push(orchThread);
		orchAgent = cloudJobId({ id: orchThread, name: "orch-agent" });
		orchJob = text(outcome?.job) || orchAgent;

		// While the turn runs (the VM takes seconds to start): agent://<id> answers with the agent's progress and proc://<job> with the job.
		const progress = await waitUntil(`agent://${orchAgent} to resolve`, 60_000, async () => {
			const read = await callTool(client, "read", { path: `agent://${orchAgent}` });
			return read.isError ? undefined : read;
		});
		if (progress.text.trim() === "") throw new Error("agent://<id> read as empty while the turn ran");
		// A running job reads as `<job> [task] — running — <label>` (omp's proc handler); once finished, `<job> [task] — completed — …`. The job registers with the turn: poll.
		const proc = await waitUntil(`proc://${orchJob} to resolve`, 60_000, async () => {
			const read = await callTool(client, "read", { path: `proc://${orchJob}` });
			return !read.isError && read.text.includes(orchJob) ? read : undefined;
		});
		expectContains("proc:// of the cloud job", proc.text, "[task]");

		const delivered = await waitUntil("omp's async-result for the cloud agent", 240_000, async () =>
			(await customMessages(client, "async-result")).find(m => rows(obj(m.details, "async-result details").jobs, "jobs").some(j => j.agentId === orchAgent || j.jobId === orchJob)),
		);
		const job = rows(obj(delivered.details, "async-result details").jobs, "jobs").find(j => j.agentId === orchAgent || j.jobId === orchJob);
		expectEqual("the delivered job's type", job?.type, "task");
		expectEqual("the delivered job's status", job?.status, "completed");
		expectContains("async-result text points at the agent", messageText(delivered), `agent://${orchAgent}`);
		// A card, if the plugin wrongly posted one, lands a moment after the async-result.
		await Bun.sleep(2000);
		expectEqual("[cloud] turn cards of the thread", JSON.stringify(await turnCards(client, orchThread)), JSON.stringify([]));
		return `agent ${orchAgent}, job ${orchJob}`;
	}, shown => shown);

	await report.step("9b drill-in: agent://<id> is the agent's output, agent://<id>/result/branch a field of its structured result, history://<id> its transcript", async () => {
		const client = requireTool();
		const reply = longReply(80);
		// <id>.md and <id>.json are written as the plugin sees the turn end; until then agent://<id> answers with the agent's progress (and a JSON path is an error). Poll.
		const output = await waitUntil(`agent://${orchAgent} to hold the reply`, 60_000, async () => {
			const read = await callTool(client, "read", { path: `agent://${orchAgent}` });
			return !read.isError && read.text.includes(reply) ? read : undefined;
		});
		expectContains("agent://<id>", output.text, reply);
		// `<id>.json` is the structured result: `{thread, turn, state, reply, result: {branch, …}, branch, …}`; a string field reads as prose.
		const branch = await waitUntil(`agent://${orchAgent}/result/branch to resolve`, 60_000, async () => {
			const read = await callTool(client, "read", { path: `agent://${orchAgent}/result/branch` });
			return !read.isError && read.text.includes("omp-cloud/") ? read : undefined;
		});
		expectContains("agent://<id>/result/branch", branch.text, `omp-cloud/${orchThread}`);
		// The transcript is the exported conversation once it was fetched, else the turns and their events: the prompt and the reply are in both. Poll for the former, never read once.
		const history = await waitUntil(`history://${orchAgent} to hold the prompt and the reply`, 60_000, async () => {
			const read = await callTool(client, "read", { path: `history://${orchAgent}` });
			return !read.isError && read.text.includes(ORCH_PROMPT) && read.text.includes(reply) ? read : undefined;
		});
		expectContains("history:// holds the prompt", history.text, ORCH_PROMPT);
		expectContains("history:// holds the reply", history.text, reply);
	});

	await report.step("9c local to cloud: write agent://<id> returns omp's receipt, the VM agent gets omp's IRC envelope, and the woken turn's reply comes back with replyTo", async () => {
		const client = requireTool();
		const written = await callTool(client, "write", { path: `agent://${orchAgent}`, content: "LONG:120" });
		if (written.isError) throw new Error(`write agent://${orchAgent}: ${written.text.slice(0, 400)}`);
		expectContains("the write tool's answer", written.text, `Delivered to ${orchAgent}`);
		// omp's answer text is the same for woken and injected; the receipt itself is in the details when the host passes them on, and turn 2 below proves the wake.
		if (Object.keys(written.details).length > 0) expectContains("the receipt", JSON.stringify(written.details), '"outcome":"woken"');

		const done = await waitThread(orchThread, "turn 2 to finish", 240_000, t => turnById(t, 2)?.state === "done");
		const turn = obj(turnById(done, 2), "turn 2");
		expectEqual("turn 2 origin", turn.origin, "irc");
		expectEqual("turn 2 sender", turn.ircFrom, "Main");
		expectEqual("turn 2 text", turn.text, "LONG:120");
		expectEqual("turn 2 reply", turn.reply, longReply(120));
		const messageId = text(turn.ircId);
		if (messageId === "") throw new Error(`turn 2 has no ircId: ${JSON.stringify(turn)}`);
		// What the VM agent's model was handed: omp's incoming-message envelope (its instructions to reply with `write agent://Parent`), not a bare prompt.
		if (!sawRequest("LONG:120", "agent://Parent")) throw new Error(`no model request carried the message with omp's IRC envelope (agent://Parent):\n${(provider?.history ?? []).slice(-6).join("\n=====\n")}`);

		// The wake relay: the reply goes back to the sender as an IRC message answering the message, wake-relay flagged.
		const relay = await waitUntil("the wake relay of turn 2", 120_000, async () => (await customMessages(client, "irc:incoming")).find(m => obj(m.details, "irc details").replyTo === messageId));
		const details = obj(relay.details, "relay details");
		expectEqual("relay sender", details.from, orchAgent);
		expectEqual("relay wakeRelay", details.wakeRelay, true);
		expectContains("relay text", text(details.message), "<task-result");
		expectContains("relay text", text(details.message), 'status="completed"');
		expectContains("relay text", text(details.message), longReply(120));
		await Bun.sleep(2000);
		expectEqual("[cloud] turn cards of the thread", JSON.stringify(await turnCards(client, orchThread)), JSON.stringify([]));
	});

	await report.step("9d cloud to local: the VM agent's write agent://Parent reaches the local session as native IRC and wakes the idle main agent; the relay follows", async () => {
		const client = requireTool();
		const ping = "ping from the cloud agent";
		const written = await callTool(client, "write", { path: `agent://${orchAgent}`, content: `WRITEPARENT: ${ping}` });
		if (written.isError) throw new Error(`write agent://${orchAgent}: ${written.text.slice(0, 400)}`);

		const incoming = await waitUntil("the cloud agent's message in the local session", 240_000, async () => (await customMessages(client, "irc:incoming")).find(m => obj(m.details, "irc details").message === ping));
		const details = obj(incoming.details, "irc details");
		expectEqual("sender", details.from, orchAgent);
		expectEqual("wakeRelay", details.wakeRelay, undefined);
		expectContains("the envelope", messageText(incoming), ping);
		expectContains("the envelope names the sender", messageText(incoming), orchAgent);

		// The main agent was idle: omp woke it, so its model ran on the message (the fake model answers any prompt it has no rule for with TURN count=…).
		const at = (await client.getMessages()).findIndex(m => isRecord(m) && m.customType === "irc:incoming" && isRecord(m.details) && m.details.message === ping);
		await waitUntil("a model turn after the message (the wake)", 60_000, async () =>
			(await client.getMessages()).slice(at + 1).some(m => isRecord(m) && m.role === "assistant" && messageText(m).startsWith("TURN count=")) ? true : undefined,
		);
		if (!sawRequest(ping, orchAgent)) throw new Error(`no model request carried the cloud agent's message and its sender:\n${(provider?.history ?? []).slice(-6).join("\n=====\n")}`);

		const done = await waitThread(orchThread, "turn 3 to finish", 240_000, t => turnById(t, 3)?.state === "done");
		const turn = obj(turnById(done, 3), "turn 3");
		expectEqual("turn 3 origin", turn.origin, "irc");
		expectContains("turn 3 reply", text(turn.reply), "DONE=");
		const relay = await waitUntil("the wake relay of turn 3", 120_000, async () => (await customMessages(client, "irc:incoming")).find(m => obj(m.details, "irc details").replyTo === text(turn.ircId)));
		expectEqual("relay wakeRelay", obj(relay.details, "relay details").wakeRelay, true);
		expectContains("relay text", text(obj(relay.details, "relay details").message), "<task-result");
		expectContains("relay text", text(obj(relay.details, "relay details").message), 'status="completed"');
		// (the thread goes in 9e)
	});

	await report.step("9e native wait on a model-started cloud job returns when the turn settles, with that job's result and no [cloud] turn card", async () => {
		const client = requireTool();
		const started = await callCloud(client, { op: "delegate", task: "LONG:60", name: "orch-wait", workspace: "scratch", conversation: "none" }, 240_000);
		expectResult("delegate", started, "cloud delegate: ok started ");
		const outcome = rows(started.details.outcomes, "delegate outcomes")[0];
		const waitThreadId = text(outcome?.thread);
		createdThreads.push(waitThreadId);
		const agent = cloudJobId({ id: waitThreadId, name: "orch-wait" });
		const job = text(outcome?.job) || agent;

		// omp's own `wait` with no arguments waits on the session's background jobs. The cloud job registers as the thread's first turn starts; until it does, `wait` has nothing to wait on.
		const marker = new RegExp(`### (${job}(?:-\\d+)?) \\[task\\] — completed`);
		const waited = await waitUntil("omp's wait to return the cloud job", 240_000, async () => {
			const result = await callTool(client, "wait", {}, 270_000);
			return marker.test(result.text) ? result : undefined;
		});
		if (waited.isError) throw new Error(`wait: ${waited.text.slice(0, 400)}`);
		const settled = await detail(waitThreadId);
		expectEqual("the thread's first turn", turnById(settled, 1)?.state, "done");
		await Bun.sleep(2000);
		expectEqual("[cloud] turn cards of the thread", JSON.stringify(await turnCards(client, waitThreadId)), JSON.stringify([]));
		const output = await callTool(client, "read", { path: `agent://${agent}` });
		expectContains("agent://<id> after the wait", output.text, longReply(60));

		// Both cloud agents go: their VMs and gateway clients too.
		const key = vmonKey ?? "";
		for (const id of [orchThread, waitThreadId]) expectEqual(`DELETE ${id}`, (await api("DELETE", `/threads/${id}`)).status, 202);
		await waitUntil("the sandboxes and gateway clients of the orchestration threads to go", 60_000, async () => {
			for (const id of [orchThread, waitThreadId]) if ((await sandboxesOf(key, id)).length > 0 || (await clientsOf(id)).length > 0) return undefined;
			return true;
		});
	});

	await report.step("9f children: a background bash job the cloud agent starts is a child job of the cloud agent in the local omp, outlives the turn, survives a cancel from omp and settles when the VM job ends", async () => {
		const device = toolOmp ?? fail();
		const client = device.client;
		const SLEEP = 45;
		const command = `sleep ${SLEEP}; echo bg-child-done > /tmp/bg-child.done`;
		const started = await callCloud(client, { op: "delegate", task: `BGBASH: ${command}`, name: "orch-child", workspace: "scratch", conversation: "none" }, 240_000);
		expectResult("delegate", started, "cloud delegate: ok started ");
		const childThread = text(rows(started.details.outcomes, "delegate outcomes")[0]?.thread);
		createdThreads.push(childThread);
		const owner = cloudJobId({ id: childThread, name: "orch-child" });
		const childEvents = async (kinds: string): Promise<Json[]> => rows(obj(await apiJson("GET", `/threads/${childThread}/events?format=json&kind=${kinds}&limit=100`, 200), "events").events, "events");
		const eventBody = (event: Json): Json => obj(JSON.parse(text(event.text)), "event text");
		/** `/jobs` of the tool omp: omp's own tree of the session's background jobs, as the model or the user reads it. */
		const jobs = async (): Promise<string> => {
			const before = device.commandOutputs.length;
			await client.prompt("/jobs");
			return waitUntil("the /jobs output", 30_000, async () => device.commandOutputs.slice(before).find(output => output.length > 0));
		};

		// The service saw the child start: a bash child with the command as its label, spawned by turn 1, no agent id.
		const start = await waitUntil("the child_start event", 240_000, async () => (await childEvents("child_start"))[0]);
		const started0 = eventBody(start);
		expectEqual("child kind", started0.kind, "bash");
		expectEqual("child agent", started0.agent, "");
		expectContains("child label", text(started0.label), `sleep ${SLEEP}`);
		expectEqual("child_start turn", start.turn, 1);
		const jobKey = text(started0.job);
		if (jobKey === "") throw new Error(`child_start has no job: ${JSON.stringify(started0)}`);

		// In the local omp: a bash job under the cloud agent's row, with the command as its label.
		const shown = await waitUntil("the child job in /jobs", 60_000, async () => {
			const output = await jobs();
			return output.includes(`sleep ${SLEEP}`) && /bash \(running\)/.test(output) ? output : undefined;
		});
		expectContains("the cloud agent's row in /jobs", shown, owner);
		const localId = /\[([^\]]+)\] bash \(running\)/.exec(shown)?.[1];
		if (localId === undefined) throw new Error(`no running bash job row in /jobs:\n${shown}`);
		// The row is nested under the agent: its line comes after the agent's, not before.
		if (shown.indexOf(owner) > shown.indexOf(`[${localId}]`)) throw new Error(`the child job is not listed under ${owner}:\n${shown}`);

		// It outlives the agent's own reply: the agent said DONE= (a model request after the job started) and the turn is still open on the child, here and in the VM.
		// The service holds a turn until omp is settled, which a running background job prevents; so the child ends first and the turn after it.
		await waitUntil("the agent's reply while its child runs", 120_000, async () => ((await eventsPage(childThread, "kind=assistant")).events.some(e => text(e.text).startsWith("DONE=")) ? true : undefined));
		expectEqual("the thread's phase while its child runs", (await detail(childThread)).phase, "working");
		expectEqual("child_end events while the child runs", (await childEvents("child_end")).length, 0);
		const after = await jobs();
		if (!/bash \(running\)/.test(after)) throw new Error(`the child job is not running in /jobs after the agent replied:\n${after}`);

		// A cancel from omp's own surface stops nothing in the cloud: omp refuses it for a nested job (or the plugin declines it), and the VM keeps running the command.
		const killBefore = device.commandOutputs.length;
		await client.prompt(`/jobs kill ${localId}`);
		await waitUntil("the output of /jobs kill", 30_000, async () => device.commandOutputs.slice(killBefore).find(output => output.length > 0));
		await Bun.sleep(3000);
		const afterKill = await jobs();
		if (!/bash \(running\)/.test(afterKill)) throw new Error(`the child job stopped after /jobs kill:\n${afterKill}`);
		expectEqual("child_end events after /jobs kill", (await childEvents("child_end")).length, 0);
		const key = vmonKey ?? "";
		const [sandbox] = await sandboxesOf(key, childThread);
		if (sandbox === undefined) throw new Error("the cloud agent has no sandbox");
		// omp's shell runs `sleep` in process, so there is no process to look for: the marker file the command writes at its end is the proof, below.
		expectEqual("the thread after /jobs kill: its turn still runs for the child", (await detail(childThread)).phase, "working");

		// When the VM job ends the child settles with its status: child_end completed (not inferred: omp reported it), and the row leaves the running list.
		const end = await waitUntil("the child_end event", 240_000, async () => (await childEvents("child_end"))[0]);
		const ended = eventBody(end);
		expectEqual("child_end job", ended.job, jobKey);
		expectEqual("child_end status", ended.status, "completed");
		expectEqual("child_end turn", end.turn, 1);
		// The command ran to its end in the VM (the cancel from omp did not stop it): it wrote its marker.
		const marker = await (await Sandbox.connect(sandbox.sandboxId, vmonOptions(key))).commands.run("cat /tmp/bg-child.done", { timeoutMs: 30_000 }).catch(() => ({ stdout: "" }));
		expectEqual("the command's marker file in the VM", marker.stdout.trim(), "bg-child-done");
		// omp is not settled while a background job runs (its result is still to be delivered), so the service keeps the turn open until then: the turn ends after its child.
		const finished = await waitThread(childThread, "turn 1 to end after its child", 240_000, t => turnById(t, 1)?.state === "done");
		const turnDone = (await eventsPage(childThread, "kind=turn_done")).events[0];
		if (!(Number(turnDone?.seq) > Number(end.seq))) throw new Error(`turn_done (seq ${turnDone?.seq}) did not come after child_end (seq ${end.seq})`);
		expectEqual("the thread after its turn", finished.phase, "idle");
		const settled = await waitUntil("the child to settle in /jobs", 60_000, async () => {
			const output = await jobs();
			return output.includes(`sleep ${SLEEP}`) && /bash \(completed\)/.test(output) && !/bash \(running\)/.test(output) ? output : undefined;
		});
		expectContains("the settled child's row", settled, owner);
		// The child's result belongs to the cloud agent: omp's async-result deliveries to the local model are for the cloud agent's own job (a task), never for a bash child.
		// (The cloud agent's own delivery may quote the command in its reply, so the jobs are checked, not the text.)
		const delivered = (await customMessages(client, "async-result")).flatMap(m => rows(obj(m.details, "async-result details").jobs, "jobs"));
		const bashDelivered = delivered.filter(job => job.type === "bash");
		if (bashDelivered.length > 0) {
			const message = (await customMessages(client, "async-result")).find(m => JSON.stringify(m.details).includes('"type":"bash"'));
			throw new Error(`a bash child's result was delivered to the local model: ${JSON.stringify(bashDelivered)}\nmessage: ${message === undefined ? "?" : messageText(message).slice(0, 1500)}\n/jobs history:\n${device.commandOutputs.join("\n----\n").slice(-3000)}`);
		}

		expectEqual(`DELETE ${childThread}`, (await api("DELETE", `/threads/${childThread}`)).status, 202);
		await waitUntil("the child thread's sandbox and gateway client to go", 60_000, async () => ((await sandboxesOf(key, childThread)).length > 0 || (await clientsOf(childThread)).length > 0 ? undefined : true));
	});

	const pairedB = await report.step("7 pairing: device B connects over TLS with a code and the owner's approval; its connection file is written 0600", async () => {
		const device = await startDevice("B", join(dir, "device-b"), providerUrl);
		const offer = obj(await apiJson("POST", "/pairing/offers", 201, {}), "offer");
		const offerId = text(offer.id);
		expectEqual("offer fingerprint", offer.fingerprint, identity.fingerprint);
		expectEqual("offer addresses", JSON.stringify(offer.addresses), JSON.stringify([`127.0.0.1:${remotePort}`]));

		// The command blocks until the owner decides: run it, approve through the API once the request shows up.
		let connectDone = false;
		let connectError: unknown;
		const connecting = cloud(device.client, `connect ${text(offer.code)} --name scenario-b`).then(
			() => {
				connectDone = true;
			},
			(error: unknown) => {
				connectDone = true;
				connectError = error ?? new Error("connect failed");
			},
		);
		const request = await waitUntil("B's pairing request to reach the offer", 60_000, async () => {
			const state = await apiJson("GET", `/pairing/offers/${offerId}`, 200);
			return state.status === "pending" ? obj(state.request, "request") : undefined;
		});
		expectEqual("request name", request.name, "scenario-b");
		if (text(request.platform) === "") throw new Error(`the request carries no platform: ${JSON.stringify(request)}`);
		expectEqual("approve status", (await api("POST", `/pairing/offers/${offerId}/approve`)).status, 204);
		// The command may return before its handler has written the file: wait for the file, and stop at once on a failed command.
		await waitUntil("B's connection file", 30_000, async () => {
			if (await Bun.file(device.connectionFile).exists()) return true;
			if (connectDone && connectError !== undefined) throw connectError instanceof Error ? connectError : new Error(String(connectError));
			return undefined;
		});
		await connecting;

		if (process.platform !== "win32") {
			expectEqual("connection.json mode", (await stat(device.connectionFile)).mode & 0o777, 0o600);
			expectEqual("connection directory mode", (await stat(dirname(device.connectionFile))).mode & 0o777, 0o700);
		}
		const connection = obj(JSON.parse(await readFile(device.connectionFile, "utf8")), "connection.json");
		expectEqual("connection.json version", connection.version, 1);
		const server = obj(connection.server, "connection.server");
		expectEqual("pinned fingerprint", server.fingerprint, identity.fingerprint);
		expectEqual("pinned certificate", server.certificate, identity.der.toString("base64"));
		expectEqual("pinned addresses", JSON.stringify(server.addresses), JSON.stringify([`127.0.0.1:${remotePort}`]));
		const paired = obj(connection.device, "connection.device");
		expectEqual("device name", paired.name, "scenario-b");
		const deviceToken = text(connection.token);
		if (!deviceToken.startsWith("ompd_")) throw new Error("connection.json holds no ompd_ device token");

		const after = await apiJson("GET", `/pairing/offers/${offerId}`, 200);
		expectEqual("offer status after connect", after.status, "paired");
		const listed = obj(await apiJson("GET", "/devices", 200), "devices").devices;
		const names = (Array.isArray(listed) ? listed : []).map(d => text(obj(d, "device").name));
		expectEqual("active devices", JSON.stringify(names), JSON.stringify(["scenario-b"]));
		return { device, deviceId: text(paired.id), deviceToken };
	});

	await report.step("7b device B: /cloud status shows the device and fingerprint, /cloud list works, the owner token fails on the remote port, an owner-only route is 403", async () => {
		const { device, deviceId, deviceToken } = pairedB;
		const seen = device.notices.length;
		await cloud(device.client, "status");
		const status = await waitNotice(device, seen, "B's /cloud status notice", 30_000, n => n.includes("☁ omp-cloud"));
		expectContains("/cloud status", status, "scenario-b");
		expectContains("/cloud status", status, identity.fingerprint);

		await cloud(device.client, "list");
		const inventory = await waitCard(device.client, "B's inventory card", 30_000, c => c.kind === "inventory");
		expectContains("B's inventory card", JSON.stringify(inventory.groups), thread);

		const asOwner = await remoteFetch("/whoami", authHeaders);
		expectEqual("owner token on the remote port", asOwner.status, 401);
		await asOwner.body?.cancel();
		const whoami = await remoteFetch("/whoami", { authorization: `Bearer ${deviceToken}` });
		expectEqual("device token whoami on the remote port", whoami.status, 200);
		const who = obj(await whoami.json(), "whoami");
		expectEqual("whoami device", JSON.stringify(who.device), JSON.stringify({ id: deviceId, name: "scenario-b", access: "threads" }));
		expectEqual("whoami remote", JSON.stringify(who.remote), JSON.stringify({ fingerprint: identity.fingerprint }));
		const ownerOnly = await remoteFetch("/pairing/offers", { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, { method: "POST", body: "{}" });
		expectEqual("device token on POST /pairing/offers", ownerOnly.status, 403);
		await ownerOnly.body?.cancel();

		// Nothing B's omp showed or kept may carry the device token.
		const seenByB = JSON.stringify(await device.client.getMessages()) + device.notices.join("\n");
		if (seenByB.includes(deviceToken)) throw new Error("B's transcript or notices contain the device token");
	});

	const forwarder = await report.step("7c device B's dashboard forwarder: serves the page, refuses a foreign Host and cross-site requests, one-time code, relays the API", async () => {
		const { device } = pairedB;
		const seen = device.notices.length;
		await cloud(device.client, "dashboard");
		const link = await waitUntil("B's dashboard link notice", 30_000, async () => {
			for (const notice of device.notices.slice(seen)) {
				const match = /dashboard: (http:\/\/127\.0\.0\.1:(\d+))\/#(\S+)/.exec(notice);
				if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) return { base: match[1], port: Number(match[2]), code: match[3] };
			}
			return undefined;
		});
		if (link.port === dashboardPort || link.port === listenPort) throw new Error("the forwarder must listen on a port of its own");

		const page = await fetch(`${link.base}/`);
		expectEqual("forwarder GET /", page.status, 200);
		expectContains("forwarder GET / content-type", page.headers.get("content-type"), "text/html");
		expectContains("forwarder GET / body", await page.text(), 'id="app"');

		expectEqual("foreign Host", await rawStatus(link.port, "GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"), 421);

		const post = (headers: Record<string, string>, body: unknown): Promise<Response> =>
			fetch(`${link.base}/session`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
		const sameOrigin = { "x-omp-dashboard": "1", origin: link.base, "sec-fetch-site": "same-origin" };

		// The guard answers before the code is looked at, so a refused request leaves the code usable.
		const crossSite = await post({ ...sameOrigin, "sec-fetch-site": "cross-site" }, { code: link.code });
		expectEqual("cross-site sign-in", crossSite.status, 403);
		await crossSite.body?.cancel();
		const crossApi = await fetch(`${link.base}/api/v1/threads`, { headers: { "sec-fetch-site": "cross-site" } });
		expectEqual("cross-site API read", crossApi.status, 403);
		await crossApi.body?.cancel();
		const noHeader = await post({ origin: link.base, "sec-fetch-site": "same-origin" }, { code: link.code });
		expectEqual("sign-in without X-Omp-Dashboard", noHeader.status, 403);
		await noHeader.body?.cancel();

		const signedIn = await post(sameOrigin, { code: link.code });
		expectEqual("forwarder sign-in", signedIn.status, 204);
		const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		if (!cookie.startsWith("omp_cloud_session=")) throw new Error("the forwarder's sign-in set no omp_cloud_session cookie");

		const threads = await fetch(`${link.base}/api/v1/threads`, { headers: { cookie } });
		expectEqual("forwarder GET /api/v1/threads with the cookie", threads.status, 200);
		const listing = obj(await threads.json(), "forwarded threads").threads;
		const ids = (Array.isArray(listing) ? listing : []).map(t => text(obj(t, "thread").id));
		if (!ids.includes(thread)) throw new Error(`the forwarded thread list lacks ${thread}: ${JSON.stringify(ids)}`);
		const anonymous = await fetch(`${link.base}/api/v1/threads`);
		expectEqual("forwarder GET /api/v1/threads without the cookie", anonymous.status, 401);
		await anonymous.body?.cancel();

		const pasted = await post(sameOrigin, { token });
		expectEqual("a pasted token", pasted.status, 401);
		await pasted.body?.cancel();
		const reused = await post(sameOrigin, { code: link.code });
		expectEqual("reused code", reused.status, 401);
		await reused.body?.cancel();
		return { base: link.base, cookie };
	});

	await report.step("7d a fake TLS server at a code's address: a fresh device refuses it, sends it nothing and leaves the offer open", async () => {
		const stranger = await makeIdentity(join(dir, "stranger-tls"));
		// A device that is not paired yet: a paired one would refuse for being connected already.
		const fresh = await startDevice("C", join(dir, "device-c"), providerUrl);
		let requests = 0;
		const imposter = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert: Bun.file(stranger.certFile), key: Bun.file(stranger.keyFile) },
			fetch: () => {
				requests++;
				return new Response("imposter", { status: 500 });
			},
		});
		try {
			const offer = obj(await apiJson("POST", "/pairing/offers", 201, {}), "offer");
			const offerId = text(offer.id);
			const real = text(offer.code);
			const forged = `${real.slice(0, real.indexOf("@"))}@127.0.0.1:${imposter.port}`;
			const seen = fresh.notices.length;
			// The refusal reaches the user as an error notice; a command that throws instead is tolerated.
			await cloud(fresh.client, `connect ${forged} --name scenario-c`).catch(() => undefined);
			await waitNotice(fresh, seen, "C's refusal", 30_000, n => n.startsWith("error: "));
			expectEqual("HTTP requests the imposter saw", requests, 0);
			expectEqual("the real offer after the refused connect", (await apiJson("GET", `/pairing/offers/${offerId}`, 200)).status, "open");
			expectEqual("C's connection file", await Bun.file(fresh.connectionFile).exists(), false);
			expectEqual("cancel the offer", (await api("DELETE", `/pairing/offers/${offerId}`)).status, 204);
		} finally {
			await fresh.client.stop().catch(() => undefined);
			await imposter.stop(true);
		}
	});

	await report.step("7e revoking B ends its event stream; its next /cloud list and the forwarder's next API call fail", async () => {
		const { device, deviceId, deviceToken } = pairedB;
		const stream = await fetch(`${forwarder.base}/api/v1/threads/${thread}/events?after=0`, { headers: { cookie: forwarder.cookie } });
		expectEqual("forwarded event stream status", stream.status, 200);
		const reader = stream.body?.getReader();
		if (reader === undefined) throw new Error("the forwarded event stream has no body");
		const decoder = new TextDecoder();
		let received = "";
		// Any bytes mean the forwarder relays the stream as it comes: the backlog from `after=0`, else `: connected`
		// (the thread stream sends that comment only when it has no backlog to send).
		await waitUntil("the forwarded stream to deliver its first bytes", 30_000, async () => {
			const chunk = await Promise.race([reader.read(), Bun.sleep(30_000).then(() => undefined)]);
			if (chunk === undefined || chunk.done) throw new Error(`the forwarded stream ended before it delivered anything: ${JSON.stringify(received.slice(-200))}`);
			received += decoder.decode(chunk.value, { stream: true });
			return received.length > 0 ? true : undefined;
		});

		const inventories = (await cards(device.client)).filter(c => c.kind === "inventory").length;
		const revoked = obj(await apiJson("DELETE", `/devices/${deviceId}`, 200), "revoke");
		expectEqual("revoked device", JSON.stringify(revoked.device), JSON.stringify({ id: deviceId, name: "scenario-b" }));

		const ended = await Promise.race([
			(async () => {
				for (;;) {
					const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
					if (chunk.done) return true;
				}
			})(),
			Bun.sleep(20_000).then(() => false),
		]);
		if (!ended) throw new Error("B's event stream was still open 20 s after the revoke");

		const seen = device.notices.length;
		// The failure reaches the user as an error notice; a command that throws instead is tolerated.
		await cloud(device.client, "list").catch(() => undefined);
		await waitNotice(device, seen, "B's error after the revoke", 30_000, n => n.startsWith("error: "));
		expectEqual("B's inventory cards after the revoke", (await cards(device.client)).filter(c => c.kind === "inventory").length, inventories);

		const forwarded = await fetch(`${forwarder.base}/api/v1/threads`, { headers: { cookie: forwarder.cookie } });
		expectEqual("forwarder API call after the revoke", forwarded.status, 401);
		await forwarded.body?.cancel();
		const direct = await remoteFetch("/whoami", { authorization: `Bearer ${deviceToken}` });
		expectEqual("device token on the remote port after the revoke", direct.status, 401);
		await direct.body?.cancel();
		const remaining = obj(await apiJson("GET", "/devices", 200), "devices").devices;
		expectEqual("active devices after the revoke", JSON.stringify(remaining), JSON.stringify([]));
	});

	await report.step("7f ssh pairing: /cloud connect me@localhost runs omp-cloud ssh-pair for real; the pinned connection file is written, a device is listed, its token works", async () => {
		// A wrapper like the `~/.local/bin/omp-cloud` link, but on this scenario's config and with the account's real omp-cloud kept out of PATH.
		const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
		const sshHome = join(dir, "ssh-home");
		const wrapper = join(sshHome, ".local", "bin", "omp-cloud");
		await mkdir(dirname(wrapper), { recursive: true });
		await writeFile(
			wrapper,
			`#!/bin/sh\nPATH=${quote(`${dirname(process.execPath)}:/usr/bin:/bin`)}\nexport PATH\nOMP_CLOUD_CONFIG=${quote(join(dir, "config.json"))}\nexport OMP_CLOUD_CONFIG\nexec ${quote(process.execPath)} ${quote(join(REPO_ROOT, "src", "cli.ts"))} "$@"\n`,
			{ mode: 0o755 },
		);
		await chmod(wrapper, 0o755);
		// ssh's stand-in: `-G` answers like `ssh -G`; otherwise it drops ssh's options and the destination and runs the remote command
		// (one argument, for the login shell) here with the wrapper's HOME and a PATH without any other omp-cloud, as sshd would.
		const fakeSsh = join(dir, "fake-ssh", "ssh");
		await mkdir(dirname(fakeSsh), { recursive: true });
		await writeFile(
			fakeSsh,
			[
				"#!/bin/sh",
				'if [ "$1" = "-G" ]; then printf "hostname 127.0.0.1\\nport 22\\n"; exit 0; fi',
				'while [ "$#" -gt 0 ]; do',
				'	case "$1" in',
				"		--) shift; break ;;",
				"		-o|-p) shift 2 ;;",
				"		*) shift ;;",
				"	esac",
				"done",
				"shift",
				`exec env HOME=${quote(sshHome)} PATH=/usr/bin:/bin SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' sh -c "$1"`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		await chmod(fakeSsh, 0o755);

		const device = await startDevice("ssh", join(dir, "device-ssh"), providerUrl, { extraEnv: { OMP_CLOUD_SSH: fakeSsh } });
		await cloud(device.client, "connect me@localhost --name scenario-ssh").catch(() => undefined);
		await waitUntil("the ssh device's connection file", 60_000, async () => {
			if (await Bun.file(device.connectionFile).exists()) return true;
			const failure = device.notices.find(n => n.startsWith("error: "));
			if (failure !== undefined) throw new Error(`connecting over ssh failed: ${failure}`);
			return undefined;
		});

		if (process.platform !== "win32") {
			expectEqual("connection.json mode", (await stat(device.connectionFile)).mode & 0o777, 0o600);
			expectEqual("connection directory mode", (await stat(dirname(device.connectionFile))).mode & 0o777, 0o700);
		}
		const connection = obj(JSON.parse(await readFile(device.connectionFile, "utf8")), "connection.json");
		expectEqual("connection.json version", connection.version, 1);
		const server = obj(connection.server, "connection.server");
		expectEqual("pinned fingerprint", server.fingerprint, identity.fingerprint);
		expectEqual("pinned certificate", server.certificate, identity.der.toString("base64"));
		expectEqual("pinned addresses", JSON.stringify(server.addresses), JSON.stringify([`127.0.0.1:${remotePort}`]));
		const paired = obj(connection.device, "connection.device");
		expectEqual("device name", paired.name, "scenario-ssh");
		const deviceToken = text(connection.token);
		if (!deviceToken.startsWith("ompd_")) throw new Error("connection.json holds no ompd_ device token");

		const listed = rows(obj(await apiJson("GET", "/devices", 200), "devices").devices, "devices");
		expectEqual("active devices", JSON.stringify(listed.map(d => d.name)), JSON.stringify(["scenario-ssh"]));
		expectEqual("the device's id", listed[0]?.id, paired.id);
		expectEqual("paired from (SSH_CONNECTION of the stand-in)", listed[0]?.pairedFrom, "127.0.0.1");
		if (text(listed[0]?.platform) === "") throw new Error(`the device has no platform: ${JSON.stringify(listed[0])}`);

		// The token delivered over ssh is a working device token on the remote port.
		const whoami = await remoteFetch("/whoami", { authorization: `Bearer ${deviceToken}` });
		expectEqual("device token whoami on the remote port", whoami.status, 200);
		const who = obj(await whoami.json(), "whoami");
		expectEqual("whoami device", JSON.stringify(who.device), JSON.stringify({ id: paired.id, name: "scenario-ssh", access: "full" }));
		expectEqual("whoami remote", JSON.stringify(who.remote), JSON.stringify({ fingerprint: identity.fingerprint }));
		const seen = device.notices.length;
		await cloud(device.client, "status");
		const status = await waitNotice(device, seen, "the ssh device's /cloud status notice", 30_000, n => n.includes("☁ omp-cloud"));
		expectContains("/cloud status", status, "scenario-ssh");
		expectContains("/cloud status", status, identity.fingerprint);
		await cloud(device.client, "list");
		await waitCard(device.client, "the ssh device's inventory card", 30_000, c => c.kind === "inventory");

		// Nothing the device's omp showed or kept carries the token.
		const shown = JSON.stringify(await device.client.getMessages()) + device.notices.join("\n");
		if (shown.includes(deviceToken)) throw new Error("the ssh device's transcript or notices contain the device token");
	});

	await report.step("6 delete: no sandbox and no gateway client remain", async () => {
		const key = vmonKey ?? "";
		expectEqual("DELETE status", (await api("DELETE", `/threads/${thread}`)).status, 202);
		await waitUntil("the sandbox and the gateway client to go", 30_000, async () => {
			const sandboxes = await sandboxesOf(key, thread);
			const clients = await clientsOf(thread);
			return sandboxes.length === 0 && clients.length === 0 ? true : undefined;
		});
		expectEqual("detail status after delete", (await api("GET", `/threads/${thread}`)).status, 404);
	});
}

function fail(): never {
	throw new Error("the local omp is not running");
}

let failure: unknown = null;
try {
	await run();
} catch (error) {
	if (!(error instanceof StepFailed)) {
		console.log(`FAIL  scenario: ${error instanceof Error ? error.message : String(error)}`);
	}
	failure = error;
}

if (failure !== null) {
	for (const file of logFiles) console.log(`\n--- tail of ${file} ---\n${await logTail(file)}`);
	if (notices.length > 0) console.log(`\n--- local omp notices ---\n${notices.join("\n")}`);
	for (const device of devices) {
		console.log(`\n--- device ${device.name}: notices ---\n${device.notices.join("\n")}\n--- device ${device.name}: stderr (tail) ---\n${device.stderr().split("\n").slice(-12).join("\n")}`);
	}
}

/** Stops omp, the service and the provider, kills this scenario's sandboxes, revokes its gateway clients, removes the temp dir. */
async function cleanup(): Promise<void> {
	for (const device of devices) await device.client.stop().catch(() => undefined);
	await (omp as RpcClient | null)?.stop().catch(() => undefined);
	await stopService().catch(() => undefined);
	await (provider as FakeProvider | null)?.stop().catch(() => undefined);
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
			// The service's own gateway client outlives its temp data directory: revoke the one this scenario added.
			for (const name of await clients.names()) {
				if (name.endsWith("-service") && !clientsBefore.includes(name)) await clients.revoke(name);
			}
		} catch (error) {
			console.log(`cleanup: the service's gateway client: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
}
await cleanup();

const ok = report.print();
console.log(`total ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
process.exit(ok && failure === null ? 0 : 1);
