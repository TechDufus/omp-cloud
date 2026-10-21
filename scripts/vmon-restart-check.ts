/**
 * Checks that a vmon restart (what the vmon update does to the shared vmon: `systemctl restart vmon`) does not kill a turn
 * that is running in a VM. NOT part of any gate and NOT to be run without the owner's say-so: it restarts the real `vmon`
 * unit, which every sandbox on this host depends on, for about a minute.
 *
 *   OMP_CLOUD_ALLOW_VMON_RESTART=1 bun run scripts/vmon-restart-check.ts
 *
 * It starts its own throwaway omp-cloud service (a temp data directory, the fake provider, a free port; the live service is
 * never touched), creates one thread, queues a turn that sleeps in the VM for a minute, restarts vmon while that turn runs,
 * waits for vmon to be healthy again and requires the turn to finish `done`. It reports whether the VM survived (the same
 * sandbox, the turn ran on) or was restored (a `vm` event says the VM was lost, and the turn was requeued), and either is a pass:
 * what must not happen is a failed turn or a stuck thread. Everything it created is deleted at the end. It needs the same
 * prerequisites as `mise run scenario` (vmon, the gateway at 10.254.254.1:4000, the broker, the omp-agent template) and `sudo`.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClients } from "../src/gateway/clients";
import { isRecord } from "../src/guards";
import { installedVmonVersion } from "../src/vmon/pin";
import { type FakeProvider, modelsYaml, startFakeProvider } from "../test/fake-provider";

const REPO_ROOT = join(import.meta.dir, "..");
const VMON_URL = "http://127.0.0.1:3000";
const VMON_KEY_FILE = join(homedir(), ".config", "omp-cloud", "vmon.key");
const PROVIDER_HOST = "10.254.254.1";
const GATEWAY_URL = `http://${PROVIDER_HOST}:4000`;
const CLIENTS_FILE = join(homedir(), ".local", "share", "omp-cloud", "auth-home", "clients.json");
const BROKER_URL = "http://127.0.0.1:8765";
const BROKER_TOKEN_FILE = join(homedir(), ".local", "share", "omp-cloud", "auth-home", ".omp", "auth-broker.token");
const TURN = "BASH: sleep 60; echo survived > vmon-restart.txt";

if (process.env.OMP_CLOUD_ALLOW_VMON_RESTART !== "1") {
	console.error("This restarts the real vmon unit. Run it only with the owner's approval: OMP_CLOUD_ALLOW_VMON_RESTART=1 bun run scripts/vmon-restart-check.ts");
	process.exit(2);
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
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
	return stdout;
}

async function freePort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = server.port ?? 0;
	await server.stop(true);
	return port;
}

async function vmonHealthy(): Promise<boolean> {
	try {
		return (await fetch(`${VMON_URL}/health`, { signal: AbortSignal.timeout(3000) })).status === 204;
	} catch {
		return false;
	}
}

const token = randomBytes(24).toString("hex");
const authHeaders = { authorization: `Bearer ${token}` };
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
	return fetch(`${origin}/api/v1${path}`, {
		method,
		headers: body === undefined ? authHeaders : { ...authHeaders, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function detail(id: string): Promise<Json> {
	const res = await api("GET", `/threads/${id}`);
	if (res.status !== 200) throw new Error(`GET /threads/${id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
	return obj(await res.json(), "thread");
}

/** Polls the thread until `check` holds; a failed thread stops the wait at once. */
async function waitFor(what: string, timeoutMs: number, id: string, check: (thread: Json) => boolean): Promise<Json> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const thread = await detail(id);
		if (check(thread)) return thread;
		if (thread.phase === "failed") throw new Error(`the thread failed while waiting for ${what}: ${JSON.stringify(thread.error)}`);
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}; the thread is ${JSON.stringify(thread.phase)}`);
		await Bun.sleep(500);
	}
}

const turnOf = (thread: Json, id: number): Json => {
	const turns = Array.isArray(thread.turns) ? thread.turns : [];
	return obj(turns.find(t => isRecord(t) && t.id === id), `turn ${id}`);
};

/** The texts of the thread's `vm` events, read from the start of its event stream for a few seconds. */
async function vmEventTexts(id: string): Promise<string[]> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 2000);
	const texts: string[] = [];
	let buffer = "";
	try {
		const res = await fetch(`${origin}/api/v1/threads/${id}/events?after=0`, { headers: authHeaders, signal: abort.signal });
		if (res.status !== 200 || res.body === null) return texts;
		const decoder = new TextDecoder();
		for await (const chunk of res.body) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
				const data = buffer.slice(0, end).split("\n").find(line => line.startsWith("data: "));
				buffer = buffer.slice(end + 2);
				if (data === undefined) continue;
				const event: unknown = JSON.parse(data.slice("data: ".length));
				if (isRecord(event) && event.kind === "vm") texts.push(text(event.text));
			}
		}
	} catch (error) {
		if (!abort.signal.aborted) throw error;
	} finally {
		clearTimeout(timer);
	}
	return texts;
}

const clients = new GatewayClients({ file: CLIENTS_FILE, url: GATEWAY_URL });
const clientsBefore = await clients.names();
const dir = await mkdtemp(join(tmpdir(), "omp-cloud-vmon-restart-"));
let provider: FakeProvider | null = null;
let service: Bun.Subprocess | null = null;
let threadId: string | null = null;
let failure: unknown = null;

try {
	if (!(await vmonHealthy())) throw new Error(`vmon does not answer ${VMON_URL}/health: nothing to restart`);
	console.log(`vmon ${(await installedVmonVersion()) ?? "(unknown version)"} is healthy; this is the restart check`);

	const repo = join(dir, "repo");
	await Bun.$`git init -q -b main ${repo}`.quiet();
	await writeFile(join(repo, "README.md"), "# vmon restart check\n");
	await git(repo, "add", "-A");
	await git(repo, "-c", "user.name=Check", "-c", "user.email=check@example.com", "commit", "-q", "-m", "initial");
	const handoff = (await git(repo, "rev-parse", "HEAD")).trim();
	await git(repo, "update-ref", "refs/omp-cloud/handoff", handoff);
	const bundle = join(dir, "source.bundle");
	await git(repo, "bundle", "create", bundle, "refs/omp-cloud/handoff");

	provider = startFakeProvider({ hostname: PROVIDER_HOST, port: 0 });
	const providers = obj(obj(Bun.YAML.parse(modelsYaml(`http://${PROVIDER_HOST}:${provider.port}`)), "fake models.yml").providers, "providers");
	const config = {
		listen: `127.0.0.1:${port}`,
		apiTokenSha256: createHash("sha256").update(token).digest("hex"),
		dataDir: join(dir, "data"),
		vmon: { url: VMON_URL, keyFile: VMON_KEY_FILE, template: "omp-agent" },
		gateway: { url: GATEWAY_URL, clientsFile: CLIENTS_FILE },
		broker: { url: BROKER_URL, tokenFile: BROKER_TOKEN_FILE },
		models: { default: "fake/fake-model", direct: { fake: providers.fake } },
		runner: { idleTimeoutSeconds: 600, turnTimeoutSeconds: 600, questionTimeoutSeconds: 120 },
	};
	const configFile = join(dir, "config.json");
	await writeFile(configFile, JSON.stringify(config, null, 2));
	const log = join(dir, "service.log");
	service = Bun.spawn(["bun", "run", "src/main.ts", "--config", configFile], { cwd: REPO_ROOT, stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(log) });
	for (const deadline = Date.now() + 60_000; ; await Bun.sleep(200)) {
		if (service.exitCode !== null) throw new Error(`the test service exited with code ${service.exitCode}: see ${log}`);
		const up = await fetch(`${origin}/api/v1/whoami`, { headers: authHeaders }).then(
			res => res.status === 200,
			() => false,
		);
		if (up) break;
		if (Date.now() >= deadline) throw new Error("the test service did not answer /whoami within 60 s");
	}

	const form = new FormData();
	form.append(
		"request",
		JSON.stringify({
			prompt: "hello",
			model: "",
			repo: { name: "vmon-restart-check", baseRef: "", baseCommit: "", handoffCommit: handoff, localBranch: "main" },
			paths: { home: "", workspace: "" },
			author: { name: "Check", email: "check@example.com" },
		}),
	);
	form.append("source", Bun.file(bundle), "source.bundle");
	const created = await fetch(`${origin}/api/v1/threads`, { method: "POST", headers: authHeaders, body: form });
	if (created.status !== 201) throw new Error(`create: expected 201, got ${created.status} ${(await created.text()).slice(0, 300)}`);
	const id = text(obj(await created.json(), "create").id);
	threadId = id;
	await waitFor("the first turn", 240_000, id, t => t.phase === "idle" && isRecord(t.latest) && Number(t.latest.id) >= 1);
	const before = obj((await detail(id)).vm, "vm");
	const sandbox = text(before.sandboxId);
	console.log(`thread ${id} runs in sandbox ${sandbox}`);

	const sent = await api("POST", `/threads/${id}/messages`, { text: TURN });
	if (sent.status !== 201) throw new Error(`send: expected 201, got ${sent.status}`);
	const turn = Number(obj(obj(await sent.json(), "message").turn, "turn").id);
	await waitFor(`turn ${turn} to run`, 120_000, id, t => turnOf(t, turn).state === "running");
	await Bun.sleep(5000);

	console.log("restarting vmon (sudo systemctl restart vmon) while the turn runs");
	const restarted = Date.now();
	const restart = Bun.spawn(["sudo", "systemctl", "restart", "vmon"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	if ((await restart.exited) !== 0) throw new Error("`sudo systemctl restart vmon` failed");
	for (const deadline = Date.now() + 120_000; !(await vmonHealthy()); await Bun.sleep(1000)) {
		if (Date.now() >= deadline) throw new Error("vmon was not healthy again 120 s after the restart");
	}
	console.log(`vmon is healthy again after ${((Date.now() - restarted) / 1000).toFixed(1)} s`);

	const done = await waitFor(`turn ${turn} to end`, 420_000, id, t => ["done", "failed"].includes(text(turnOf(t, turn).state)) && t.phase === "idle");
	const outcome = turnOf(done, turn);
	if (outcome.state !== "done") throw new Error(`the turn ended ${JSON.stringify(outcome.state)}: ${JSON.stringify(outcome.error)}`);
	const after = obj((await detail(id)).vm, "vm");
	const lost = (await vmEventTexts(id)).some(line => line.includes("the VM was lost"));
	console.log(
		lost
			? `PASS  the turn finished after the VM was lost and restored (sandbox ${sandbox} -> ${text(after.sandboxId)})`
			: `PASS  the turn finished in the same sandbox ${text(after.sandboxId)} through the vmon restart`,
	);
} catch (error) {
	failure = error;
	console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
	if (threadId !== null) {
		await api("DELETE", `/threads/${threadId}`).catch(() => undefined);
		await Bun.sleep(5000);
	}
	service?.kill("SIGTERM");
	await service?.exited.catch(() => undefined);
	await provider?.stop().catch(() => undefined);
	for (const name of await clients.names().catch(() => [] as string[])) {
		const mine = (threadId !== null && name.endsWith(`-${threadId}`)) || (name.endsWith("-service") && !clientsBefore.includes(name));
		if (mine) await clients.revoke(name).catch(() => undefined);
	}
	await rm(dir, { recursive: true, force: true });
}
process.exit(failure === null ? 0 : 1);
