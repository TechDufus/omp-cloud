/**
 * `mise run install:scenario`: the one-command install, proven from scratch. A release is built from this tree and served,
 * with `install.sh`, over HTTP on `10.254.254.1` (the one host address a vmon VM can reach); a clean Debian 13 VM in the
 * vmon team `omp-cloud-test` (`scripts/cleanhost.ts`; nested KVM) runs `curl | sh`; the nested vmon, units, service and a
 * real turn against the fake model are checked; setup is rerun, persistence is checked, and `uninstall --purge` removes it.
 * Nothing touches the live team, the live units, the gateway clients file or the broker vault: the fake provider runs inside
 * the VM and the release goes to a temp directory.
 *
 *  1  release: `scripts/release.ts build --version 0.0.0-install.1` into a temp directory
 *  2  server: that directory (as `/latest/download/`) and `install.sh` over HTTP on 10.254.254.1
 *  3  nested KVM: a throwaway clean VM boots a guest of its own with vmon's VMM and survives (`mise run cleanhost -- nested`);
 *     where it does not, everything below needs `-- --no-nested` (see below)
 *  4  clean VM: a fresh Debian 13 sandbox with a user session; no omp, no vmon, no omp-cloud
 *  5  install: `curl -fsSL <host>/install.sh | OMP_CLOUD_DOWNLOAD_URL=<host> sh -s -- --yes --no-login` exits 0
 *  6  checks: `omp-cloud doctor` passes, system and user units enabled and active, linger, vmon answers 204, the VM template is ready
 *  7  real turn: the fake provider (compiled here, pushed in, bound to the VM's own 10.254.254.1) serves a scratch thread
 *     in a nested VM through the inner service until its turn is `done`
 *  8  a second `omp-cloud setup --yes --no-login` changes nothing
 *  9  reboot persistence: a probe VM finds out whether a vmon guest survives `reboot`; if it does the install VM is
 *     rebooted and must come back whole, if not every unit is checked as enabled and wanted by multi-user.target (a real reboot is not run)
 * 10  `omp-cloud uninstall --purge --yes` leaves no units, /opt/vmon, /etc/vmon, config or data, and keeps the backups
 *
 * `-- --no-nested` is for a host whose nested KVM kills the clean VM at the first guest (step 3 fails without it). The
 * runner is switched off in a seeded service.json (the service would build the template at start and
 * take the VM down), setup runs with `--no-wait`, and the template check and step 7 are skipped. The run ends with a
 * PARTIAL RUN line: it proves everything but the nested pieces, not the install.
 *
 * The cleanup destroys every VM it created and stops the server, even on failure. Slow: the nested template build alone is
 * minutes (the contract allows setup 15).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "e2b";
import { isRecord } from "../src/guards";
import { expectContains, expectEqual, Report, StepFailed } from "./report";
import { connectClean, createClean, DEFAULT_LIFETIME_MS, destroyClean, ensureCleanTemplate, exec, execLong, listClean, probeNestedKvm, shellQuote } from "./cleanhost/vmon";
import { MODEL, modelsYaml } from "./fake-provider";
import { takeRunLockOrExit } from "./run-lock";

const REPO_ROOT = join(import.meta.dir, "..");
/** The only host address a VM reaches; inside the VM it is the VM's own once setup creates `ompsvc0`. */
const HOST_IP = "10.254.254.1";
const VERSION = "0.0.0-install.1";
const ASSET = "omp-cloud-linux-x86_64";
const PROVIDER_PORT = 4010;
const SETUP_TIMEOUT_MS = 40 * 60_000;
/** `-- --no-nested`: for a host whose nested KVM kills the clean VM (`mise run cleanhost -- nested` says so); everything that needs a guest inside the clean VM is skipped, loudly. */
const NO_NESTED = process.argv.slice(2).includes("--no-nested");
const UNKNOWN_ARG = process.argv.slice(2).find(arg => arg !== "--no-nested");
if (UNKNOWN_ARG !== undefined) {
	console.error(`install-scenario: unknown argument ${JSON.stringify(UNKNOWN_ARG)}; the only option is --no-nested`);
	process.exit(2);
}
const SYSTEM_UNITS = ["vmon", "omp-cloud-net"];
const USER_UNITS = ["omp-auth-broker", "omp-auth-gateway", "omp-cloud", "omp-cloud-backup.timer"];

type Json = Record<string, unknown>;

function obj(value: unknown, label: string): Json {
	if (!isRecord(value)) throw new Error(`${label} is not an object: ${JSON.stringify(value)?.slice(0, 200)}`);
	return value;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

takeRunLockOrExit("install:scenario");
const report = new Report();
const startedAt = performance.now();
const notes: string[] = [];

// Everything the cleanup undoes.
let tempDir: string | null = null;
let server: Bun.Server<undefined> | null = null;
const vmIds: string[] = [];
let vm: Sandbox | null = null;

/** Prints a command's output as it arrives, indented, so a long step shows life. */
function echo(chunk: string): void {
	process.stdout.write(chunk.replace(/\r/g, "").replace(/^(?=.)/gm, "      | "));
}

async function run(argv: string[], options: { cwd?: string; timeoutMs: number }): Promise<{ code: number; output: string }> {
	const proc = Bun.spawn(argv, { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(options.timeoutMs) });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, output: `${stdout}${stderr}` };
}

/** The VM, or a thrown error when step 3 has not made it yet. */
function host(): Sandbox {
	if (vm === null) throw new Error("no clean VM yet");
	return vm;
}

/** Runs a short script in the VM and returns its output; a non-zero exit throws with the output. */
async function sh(script: string, options: { root?: boolean; envs?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
	const result = await exec(host(), script, options);
	if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${script.split("\n")[0]?.slice(0, 120)}\n${`${result.stdout}${result.stderr}`.trim().slice(-1500)}`);
	return result.stdout;
}

/**
 * `--no-nested` only: the service.json (and its token) a first setup would write, with the runner off. The service starts a
 * VM template build the moment it runs, and where nested KVM is broken that kills the clean VM, so it must not run one.
 * Setup keeps an existing service.json (and adds `vmon.team`), so the rest of the install is the real one.
 */
async function seedRunnerOff(): Promise<void> {
	const token = randomBytes(32).toString("hex");
	const config = "/home/user/.config/omp-cloud";
	const auth = "/home/user/.local/share/omp-cloud/auth-home";
	const document = {
		listen: "127.0.0.1:8080",
		apiTokenSha256: createHash("sha256").update(token).digest("hex"),
		dataDir: "/home/user/.local/share/omp-cloud/service",
		vmon: { url: "http://127.0.0.1:3000", keyFile: `${config}/vmon.key`, template: "omp-agent" },
		gateway: { url: `http://${HOST_IP}:4000`, clientsFile: `${auth}/clients.json` },
		broker: { url: "http://127.0.0.1:8765", tokenFile: `${auth}/.omp/auth-broker.token` },
		dashboard: { listen: "127.0.0.1:8081" },
		remote: { listen: "0.0.0.0:8443", certFile: `${config}/tls/cert.pem`, keyFile: `${config}/tls/key.pem` },
		models: { default: "anthropic/claude-sonnet-4-6" },
		runner: { enabled: false },
	};
	await sh(`mkdir -p -m 700 ${config}`);
	await host().files.write(`${config}/service.json`, JSON.stringify(document, null, 2));
	await host().files.write(`${config}/service.token`, token);
	await sh(`chmod 600 ${config}/service.json ${config}/service.token`);
}

async function waitUntil<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
		await Bun.sleep(2000);
	}
}

/** The release files by URL name; nothing else is ever served. */
function serveRelease(dir: string, names: readonly string[], served: string[]): Bun.Server<undefined> {
	const files = new Set(names);
	return Bun.serve({
		hostname: HOST_IP,
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			served.push(path);
			if (path === "/install.sh") return new Response(Bun.file(join(REPO_ROOT, "install.sh")));
			const match = /^\/(?:latest\/download|download\/v[0-9A-Za-z.+-]+)\/([^/]+)$/.exec(path);
			const name = match?.[1];
			if (name !== undefined && files.has(name)) return new Response(Bun.file(join(dir, name)));
			return new Response("not found\n", { status: 404 });
		},
	});
}

const SYSTEMCTL_USER = "systemctl --user";

/** `systemctl is-enabled` and `is-active` of each unit; returns the lines that are not as wanted. */
async function unitProblems(system: readonly string[], user: readonly string[]): Promise<string[]> {
	const problems: string[] = [];
	const check = async (scope: string, root: boolean, unit: string): Promise<void> => {
		const enabled = (await exec(host(), `${scope} is-enabled ${unit}`, { root })).stdout.trim();
		const active = (await exec(host(), `${scope} is-active ${unit}`, { root })).stdout.trim();
		if (enabled !== "enabled") problems.push(`${unit}: ${enabled || "not enabled"}`);
		if (active !== "active") problems.push(`${unit}: ${active || "not active"}`);
	};
	for (const unit of system) await check("systemctl", true, unit);
	for (const unit of user) await check(SYSTEMCTL_USER, false, unit);
	return problems;
}

async function lingers(): Promise<string> {
	return (await sh("loginctl show-user user -p Linger --value", { root: true })).trim();
}

async function vmonStatus(): Promise<string> {
	return (await sh("curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3000/health || true")).trim();
}

/** The service's base URL and bearer token, read inside the VM (the token never leaves it except in `api` calls). */
async function innerService(): Promise<{ base: string; token: string }> {
	const config = obj(JSON.parse(await sh("cat ~/.config/omp-cloud/service.json")), "service.json");
	const listen = text(config.listen);
	if (listen === "") throw new Error("service.json has no listen");
	const token = (await sh("cat ~/.config/omp-cloud/service.token")).trim();
	if (token === "") throw new Error("service.token is empty");
	return { base: `http://${listen}`, token };
}

/** One call of the inner API, made from inside the VM with curl; returns the status and the parsed body. */
async function api(method: string, path: string, extra: string[] = []): Promise<{ status: number; body: Json }> {
	const { base, token } = await innerService();
	const out = await sh(`curl -s -X ${method} -H "Authorization: Bearer $OMP_CLOUD_TOKEN" ${extra.join(" ")} -w '\\n%{http_code}' ${shellQuote(`${base}/api/v1${path}`)}`, {
		envs: { OMP_CLOUD_TOKEN: token },
	});
	const cut = out.lastIndexOf("\n");
	const raw = out.slice(0, cut);
	return { status: Number(out.slice(cut + 1)), body: raw.trim() === "" ? {} : obj(JSON.parse(raw), `${method} ${path}`) };
}

/** The steps (`id`, `status`) of a `setup --json` report. */
function reportSteps(stdout: string): { id: string; status: string; detail: string }[] {
	const start = stdout.indexOf("{");
	if (start < 0) throw new Error(`setup --json printed no JSON on stdout: ${stdout.slice(0, 300)}`);
	const body = obj(JSON.parse(stdout.slice(start)), "the setup report");
	if (!Array.isArray(body.steps)) throw new Error(`the setup report has no steps: ${Object.keys(body).join(", ")}`);
	return body.steps.map(step => {
		const entry = obj(step, "a step");
		return { id: text(entry.id), status: text(entry.status), detail: text(entry.detail) };
	});
}

/** What the VM's own services logged, for a failure report. */
async function vmLogs(): Promise<string> {
	if (vm === null) return "(no VM)";
	const parts = await Promise.all([
		exec(vm, "journalctl -u vmon -u omp-cloud-net --no-pager -n 60 2>&1", { root: true, timeoutMs: 30_000 }),
		exec(vm, "journalctl --user -u omp-cloud -u omp-auth-gateway -u omp-auth-broker --no-pager -n 80 2>&1", { timeoutMs: 30_000 }),
	]).catch(() => null);
	if (parts === null) return "(the VM does not answer)";
	return `--- vmon, omp-cloud-net ---\n${parts[0].stdout}\n--- user units ---\n${parts[1].stdout}`;
}

async function main(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "omp-cloud-install-scenario-"));
	tempDir = dir;
	const releaseDir = join(dir, "release");
	await mkdir(releaseDir, { recursive: true });
	const served: string[] = [];
	let origin = "";

	await report.step("1 release: scripts/release.ts build", async () => {
		const started = performance.now();
		const built = await run([process.execPath, "run", "scripts/release.ts", "build", "--version", VERSION, "--out", releaseDir], { cwd: REPO_ROOT, timeoutMs: 20 * 60_000 });
		if (built.code !== 0) throw new Error(`release.ts build exited ${built.code}:\n${built.output.trim().slice(-1500)}`);
		const names = await readdir(releaseDir);
		for (const wanted of [ASSET, `${ASSET}.sha256`]) if (!names.includes(wanted)) throw new Error(`the build left no ${wanted}: ${names.join(", ")}`);
		const size = (await stat(join(releaseDir, ASSET))).size;
		return `${ASSET} ${(size / 1e6).toFixed(0)} MB in ${((performance.now() - started) / 1000).toFixed(0)} s`;
	}, shown => shown);

	await report.step(`2 server: install.sh and the release on ${HOST_IP}`, async () => {
		server = serveRelease(releaseDir, await readdir(releaseDir), served);
		origin = `http://${HOST_IP}:${server.port}`;
		const probe = await fetch(`${origin}/install.sh`);
		expectEqual("install.sh status", probe.status, 200);
		expectContains("install.sh", await probe.text(), "OMP_CLOUD_DOWNLOAD_URL");
		const sidecar = await fetch(`${origin}/latest/download/${ASSET}.sha256`);
		expectEqual("sidecar status", sidecar.status, 200);
		expectEqual("a name outside the release", (await fetch(`${origin}/latest/download/..%2Fetc%2Fpasswd`)).status, 404);
		return origin;
	}, shown => shown);

	await report.step("3 nested KVM: a clean VM can run a guest of its own", async () => {
		const { works, detail } = await probeNestedKvm();
		if (works) return detail;
		if (NO_NESTED) {
			notes.push(`nested KVM does not work on this host (${detail.slice(0, 200)}); --no-nested: the template, the real turn and everything inside nested guests are NOT exercised`);
			return `does not work; continuing with --no-nested`;
		}
		throw new Error(`${detail}\nEverything after this needs a nested guest (setup's service builds the VM template at start and the clean VM dies with it). Run \`mise run install:scenario -- --no-nested\` to prove the rest of the install without them.`);
	}, shown => shown);

	await report.step("4 clean VM: fresh Debian 13 with a user session, nothing installed", async () => {
		const template = await ensureCleanTemplate(line => console.log(`      ${line}`));
		const created = await createClean(DEFAULT_LIFETIME_MS, line => console.log(`      ${line}`));
		vm = created.sandbox;
		vmIds.push(vm.sandboxId);
		const facts = (await sh("uname -r; nproc; free -m | awk 'NR==2{print $2}'; id -un; . /etc/os-release; echo $PRETTY_NAME")).trim().split("\n");
		for (const absent of ["omp", "omp-cloud", "vmon", "bun"]) {
			const found = (await exec(host(), `command -v ${absent}`)).exitCode === 0;
			if (found) throw new Error(`${absent} is already installed in the clean VM`);
		}
		for (const path of ["/opt/vmon", "/etc/vmon", "~/.config/omp-cloud", "~/.local/share/omp-cloud"]) {
			if ((await exec(host(), `test -e ${path}`)).exitCode === 0) throw new Error(`${path} exists in the clean VM`);
		}
		expectEqual("user manager", (await sh(`${SYSTEMCTL_USER} is-system-running`)).trim(), "running");
		expectEqual("linger before setup", await lingers(), "no");
		return `${vm.sandboxId}, kernel ${facts[0]}, ${facts[1]} vCPU, ${facts[2]} MiB, ${facts.at(-1)}; boot ${created.bootSeconds.toFixed(1)} s, template ${template.seconds === 0 ? "already built" : `built in ${template.seconds.toFixed(0)} s`}`;
	}, shown => shown);

	await report.step("5 install: curl | sh with --yes --no-login exits 0", async () => {
		const started = performance.now();
		if (NO_NESTED) await seedRunnerOff();
		const script = `curl -fsSL ${origin}/install.sh | OMP_CLOUD_DOWNLOAD_URL=${origin} sh -s -- --yes --no-login${NO_NESTED ? " --no-wait" : ""}`;
		const result = await execLong(host(), script, { timeoutMs: SETUP_TIMEOUT_MS, onOutput: echo });
		if (result.exitCode !== 0) throw new Error(`install exited ${result.exitCode}; the end of its output:\n${result.stdout.trim().slice(-1500)}`);
		for (const path of [`/latest/download/${ASSET}.sha256`, `/latest/download/${ASSET}`]) {
			if (!served.includes(path)) throw new Error(`install.sh never fetched ${path}; it fetched ${served.join(", ")}`);
		}
		return `${((performance.now() - started) / 1000).toFixed(0)} s`;
	}, shown => shown);

	await report.step("6 checks: doctor, units, linger, vmon 204, the VM template", async () => {
		const doctor = await exec(host(), "omp-cloud doctor", { timeoutMs: 120_000 });
		if (doctor.exitCode !== 0) throw new Error(`omp-cloud doctor exited ${doctor.exitCode}:\n${doctor.stdout}${doctor.stderr}`);
		echo(doctor.stdout);
		const problems = await unitProblems(SYSTEM_UNITS, USER_UNITS);
		if (problems.length > 0) throw new Error(`units: ${problems.join("; ")}`);
		expectEqual("linger", await lingers(), "yes");
		expectEqual("vmon /health", await vmonStatus(), "204");
		const ip = await sh("ip -4 -o addr show dev ompsvc0");
		expectContains("ompsvc0", ip, `${HOST_IP}/32`);
		if (!NO_NESTED) {
			const templates = await sh(`curl -s --max-time 20 -H "X-API-Key: $(cat ~/.config/omp-cloud/vmon.key)" http://127.0.0.1:3000/templates`);
			expectContains("the inner vmon's templates", templates, "omp-agent:");
		}
		const version = await sh("omp-cloud version");
		return `${version.trim()}; ${[...SYSTEM_UNITS, ...USER_UNITS].length} units active`;
	}, shown => shown);

	let threadId = "";
	await report.step(NO_NESTED ? "7 real turn: SKIPPED (--no-nested)" : "7 real turn: a scratch thread runs in a nested VM against the fake model", async () => {
		if (NO_NESTED) return "NOT RUN: it needs a nested guest";
		const binary = join(dir, "fake-provider");
		const compiled = await run([process.execPath, "build", "--compile", "--outfile", binary, "test/fake-provider.ts"], { cwd: REPO_ROOT, timeoutMs: 5 * 60_000 });
		if (compiled.code !== 0) throw new Error(`bun build --compile exited ${compiled.code}: ${compiled.output.trim().slice(-800)}`);
		await host().files.write("/home/user/fake-provider", Bun.file(binary).stream(), { requestTimeoutMs: 600_000 });
		await sh("chmod 755 /home/user/fake-provider");
		await sh(`systemd-run --user --quiet --unit=cleanhost-fake-provider --setenv=HOST=${HOST_IP} --setenv=PORT=${PROVIDER_PORT} /home/user/fake-provider`);
		const answer = await waitUntil("the fake provider on the VM's own address", 30_000, async () => {
			const code = (await sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://${HOST_IP}:${PROVIDER_PORT}/v1/models || true`)).trim();
			return code === "000" ? undefined : code;
		});

		// Register it as a direct model of the inner service; the rest of service.json stays as setup wrote it.
		const config = obj(JSON.parse(await sh("cat ~/.config/omp-cloud/service.json")), "service.json");
		const providers = obj(obj(Bun.YAML.parse(modelsYaml(`http://${HOST_IP}:${PROVIDER_PORT}`)), "fake models.yml").providers, "providers");
		const models = isRecord(config.models) ? config.models : {};
		const runner = isRecord(config.runner) ? config.runner : {};
		const edited = { ...config, models: { ...models, default: MODEL, direct: { fake: providers.fake } }, runner: { ...runner, turnTimeoutSeconds: 900 } };
		await host().files.write("/tmp/service.json.new", JSON.stringify(edited, null, 2));
		await sh("cat /tmp/service.json.new > ~/.config/omp-cloud/service.json && rm -f /tmp/service.json.new");
		await sh(`${SYSTEMCTL_USER} restart omp-cloud`);
		await waitUntil("the inner service's health", 120_000, async () => {
			try {
				const health = await api("GET", "/health");
				return health.status === 200 ? health : undefined;
			} catch {
				return undefined;
			}
		});

		const request = { prompt: "BASH: printf 'hello from the clean host\\n' > hello.txt", model: "", repo: { scratch: true }, paths: { home: "", workspace: "" }, author: { name: "Install scenario", email: "scenario@example.com" }, origin: "tool", ref: "install-scenario", session: "install-scenario-1" };
		await host().files.write("/tmp/request.json", JSON.stringify(request));
		const created = await api("POST", "/threads", ["-F", `'request=</tmp/request.json'`, "-H", `'Idempotency-Key: ${randomBytes(6).toString("hex")}'`]);
		if (created.status !== 201) throw new Error(`creating the thread: ${created.status} ${JSON.stringify(created.body).slice(0, 400)}`);
		threadId = text(created.body.id);
		if (threadId === "") throw new Error(`no thread id in ${JSON.stringify(created.body).slice(0, 300)}`);

		const started = performance.now();
		const finished = await waitUntil(`the turn of thread ${threadId}`, 15 * 60_000, async () => {
			const detail = await api("GET", `/threads/${threadId}`);
			if (detail.status !== 200) throw new Error(`GET thread: ${detail.status}`);
			if (detail.body.phase === "failed") throw new Error(`the thread failed: ${JSON.stringify(detail.body).slice(0, 800)}\n${await vmLogs()}`);
			const latest = isRecord(detail.body.latest) ? detail.body.latest : null;
			if (detail.body.phase === "idle" && latest !== null && Number(latest.id) >= 1) return latest;
			return undefined;
		});
		if (finished.state !== "done") throw new Error(`turn 1 ended ${text(finished.state)}: ${text(finished.error)}`);
		expectContains("the turn's reply", text(finished.reply), "DONE=");
		return `fake provider answered ${answer}; thread ${threadId} turn 1 done in ${((performance.now() - started) / 1000).toFixed(0)} s`;
	}, shown => shown);

	await report.step("8 a second setup changes nothing", async () => {
		const second = await exec(host(), `omp-cloud setup --yes --no-login --json${NO_NESTED ? " --no-wait" : ""}`, { timeoutMs: 15 * 60_000 });
		if (second.exitCode !== 0) throw new Error(`the second setup exited ${second.exitCode}:\n${second.stderr}${second.stdout.slice(0, 400)}`);
		const steps = reportSteps(second.stdout);
		const unchanged = steps.filter(step => step.status !== "ok" && step.status !== "skipped");
		if (unchanged.length > 0) throw new Error(`steps that were not ok: ${unchanged.map(step => `${step.id} ${step.status} (${step.detail})`).join("; ")}\n${second.stderr}`);
		const skipped = steps.filter(step => step.status === "skipped");
		if (skipped.length > 0) notes.push(`second setup skipped: ${skipped.map(step => step.id).join(", ")}`);
		return `${steps.length} steps ok${skipped.length > 0 ? `, ${skipped.length} skipped (${skipped.map(step => step.id).join(", ")})` : ""}`;
	}, shown => shown);

	await report.step("9 reboot persistence", async () => {
		const survives = await guestSurvivesReboot();
		if (survives) return await rebootInstallVm();
		const wanted = await sh("ls /etc/systemd/system/multi-user.target.wants/", { root: true });
		for (const unit of SYSTEM_UNITS) expectContains("multi-user.target.wants", wanted, `${unit}.service`);
		for (const unit of SYSTEM_UNITS) expectContains(`${unit}.service`, await sh(`cat /etc/systemd/system/${unit}.service`, { root: true }), "WantedBy=multi-user.target");
		const problems = await unitProblems(SYSTEM_UNITS, USER_UNITS);
		if (problems.length > 0) throw new Error(`units: ${problems.join("; ")}`);
		expectEqual("linger", await lingers(), "yes");
		const dropped = await sh("ls ~/.config/systemd/user/*.wants/ 2>&1");
		for (const unit of USER_UNITS) expectContains("user unit wants", dropped, unit);
		expectContains("the user units start without a login", await sh("cat ~/.config/systemd/user/omp-cloud.service"), "WantedBy=default.target");
		const message = "a vmon guest does not survive `reboot`, so a real reboot was NOT run; enabled units, linger and multi-user.target wants were checked instead";
		notes.push(message);
		return message;
	}, shown => shown);

	await report.step("10 uninstall --purge --yes leaves nothing but the backups", async () => {
		const backup = await exec(host(), "omp-cloud backup", { timeoutMs: 120_000 });
		if (backup.exitCode !== 0) throw new Error(`omp-cloud backup exited ${backup.exitCode}: ${backup.stderr}${backup.stdout}`);
		const archives = (await sh("ls ~/.local/share/omp-cloud/backups")).trim().split("\n").filter(name => name !== "");
		if (archives.length === 0) throw new Error("omp-cloud backup wrote no archive");
		const result = await execLong(host(), "omp-cloud uninstall --purge --yes", { timeoutMs: 10 * 60_000, onOutput: echo });
		if (result.exitCode !== 0) throw new Error(`uninstall exited ${result.exitCode}:\n${result.stdout.trim().slice(-1500)}`);

		const units = (await sh("systemctl list-unit-files --no-legend 'omp-*' 'vmon*' 2>&1 | grep -v 'No unit files' || true", { root: true })).trim();
		expectEqual("system unit files left", units, "");
		// The user manager itself stops with the last linger (no session is left), so the files are what can be checked.
		const userUnits = (await sh("ls -d ~/.config/systemd/user/omp-* ~/.config/systemd/user/*.wants/omp-* 2>/dev/null || true")).trim();
		expectEqual("user unit files left", userUnits, "");
		const left = (await sh("ls -d /opt/vmon /opt/vmon.prev /etc/vmon /etc/omp-cloud /var/lib/vmon ~/.config/omp-cloud ~/.local/bin/omp-cloud /etc/sudoers.d/omp-cloud /usr/local/libexec/omp-cloud ~/.local/share/omp-cloud/app ~/.local/share/omp-cloud/service ~/.local/share/omp-cloud/auth-home 2>/dev/null || true")).trim();
		expectEqual("paths left", left, "");
		expectEqual("ompsvc0 gone", (await exec(host(), "ip link show ompsvc0")).exitCode === 0, false);
		expectEqual("linger after uninstall", await lingers(), "no");
		const kept = (await sh("find ~/.local/share/omp-cloud -mindepth 1 | sort")).trim().split("\n");
		const unexpected = kept.filter(path => !path.includes("/.local/share/omp-cloud/backups"));
		if (unexpected.length > 0) throw new Error(`uninstall --purge left data besides the backups: ${unexpected.join(", ")}`);
		const afterwards = (await sh("ls ~/.local/share/omp-cloud/backups")).trim().split("\n");
		expectEqual("backups kept", JSON.stringify(afterwards), JSON.stringify(archives));
		return `backups kept: ${afterwards.join(", ")}`;
	}, shown => shown);
}

/** Whether a vmon guest comes back from `sudo reboot`, tried on a throwaway VM. */
async function guestSurvivesReboot(): Promise<boolean> {
	const probe = (await createClean(30 * 60_000, () => undefined)).sandbox;
	vmIds.push(probe.sandboxId);
	try {
		const before = (await exec(probe, "cat /proc/sys/kernel/random/boot_id")).stdout.trim();
		await exec(probe, "sudo reboot", { timeoutMs: 20_000 }).catch(() => undefined);
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			await Bun.sleep(5000);
			try {
				const reconnected = await connectClean(probe.sandboxId);
				if (reconnected === null) continue;
				const after = await exec(reconnected, "cat /proc/sys/kernel/random/boot_id", { timeoutMs: 15_000 });
				if (after.exitCode === 0 && after.stdout.trim() !== before) {
					notes.push("a vmon guest survives `sudo reboot` (boot id changed, the guest answered again)");
					return true;
				}
			} catch {
				// not back yet
			}
		}
		notes.push("a vmon guest does not survive `sudo reboot`: it never answered again in 90 s (vmon still lists it as running)");
		return false;
	} finally {
		await destroyClean(probe.sandboxId).catch(() => false);
	}
}

/** Reboots the install VM (only when guests survive it) and checks that everything is back without anyone logging in. */
async function rebootInstallVm(): Promise<string> {
	const before = (await sh("cat /proc/sys/kernel/random/boot_id")).trim();
	await exec(host(), "sudo reboot", { timeoutMs: 20_000 }).catch(() => undefined);
	vm = await waitUntil("the VM to come back", 180_000, async () => {
		try {
			const reconnected = await connectClean(host().sandboxId);
			if (reconnected === null) return undefined;
			const after = await exec(reconnected, "cat /proc/sys/kernel/random/boot_id", { timeoutMs: 15_000 });
			return after.exitCode === 0 && after.stdout.trim() !== before ? reconnected : undefined;
		} catch {
			return undefined;
		}
	});
	await waitUntil("vmon after the reboot", 180_000, async () => ((await vmonStatus()) === "204" ? true : undefined));
	await waitUntil("the user units after the reboot (no login)", 180_000, async () => ((await unitProblems(SYSTEM_UNITS, USER_UNITS)).length === 0 ? true : undefined));
	expectContains("ompsvc0 after the reboot", await sh("ip -4 -o addr show dev ompsvc0"), `${HOST_IP}/32`);
	const health = await waitUntil("the service after the reboot", 180_000, async () => {
		try {
			const result = await api("GET", "/health");
			return result.status === 200 ? result : undefined;
		} catch {
			return undefined;
		}
	});
	const message = "the install VM was rebooted and came back whole: units, ompsvc0, vmon 204 and the service healthy";
	notes.push(message);
	return `${message} (${text(health.body.status) || "healthy"})`;
}

let failure: unknown = null;
try {
	await main();
} catch (error) {
	failure = error;
	if (!(error instanceof StepFailed)) console.log(`FAIL  scenario: ${error instanceof Error ? error.message : String(error)}`);
}

if (failure !== null && vm !== null) console.log(`\n--- the VM's logs ---\n${await vmLogs()}`);

/** Destroys every VM this run created, stops the server and removes the temp directory. */
async function cleanup(): Promise<void> {
	for (const id of vmIds) {
		const gone = await destroyClean(id).catch((error: unknown) => {
			console.log(`cleanup: could not destroy VM ${id}: ${error instanceof Error ? error.message : String(error)}`);
			return true;
		});
		if (gone) console.log(`cleanup: destroyed VM ${id}`);
	}
	const left = (await listClean().catch(() => [])).filter(entry => vmIds.includes(entry.id));
	if (left.length > 0) console.log(`cleanup: STILL LISTED: ${left.map(entry => entry.id).join(", ")}; run mise run cleanhost -- destroy <id>`);
	await (server as Bun.Server<undefined> | null)?.stop(true);
	if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
}
await cleanup().catch((error: unknown) => console.log(`cleanup: ${error instanceof Error ? error.message : String(error)}`));

const ok = report.print();
for (const note of notes) console.log(`note: ${note}`);
if (NO_NESTED) console.log("PARTIAL RUN (--no-nested): the VM template, the real turn and everything that needs a guest inside the clean VM were NOT exercised");
console.log(`total ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
process.exit(ok && failure === null ? 0 : 1);
