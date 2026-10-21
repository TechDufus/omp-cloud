/**
 * `mise run update:scenario`: the 0.5 updater against real systemd user units and real compiled release binaries,
 * without touching the live install. Everything lives in a temp directory (the app dir `OMP_CLOUD_APP_DIR`, the config,
 * the data, a static release feed served by this script) and the service runs as a throwaway transient user unit named
 * `omp-cloud-e2e-<random>`. The live `omp-cloud`, `omp-auth-*` and `vmon` units, `~/.local/bin/omp-cloud` and the live app
 * dir are never written; the scenario refuses to start when the apply could reach them (a vibemon that is not the pin) and
 * checks at the end that they did not change. `update.ompUnits` is `[]`, so the applier never restarts the live broker or gateway.
 *
 * Needs a systemd user manager (`systemctl --user`), the pinned vibemon installed (the vmon step is a no-op), `omp` on the
 * host, and the network for `bun build --compile --target=bun-linux-arm64` (the runtime is fetched once). No VM, no model.
 *
 *  1  preflight: a user manager, the pinned vibemon, no apply running
 *  2  release A (`0.5.0-e2e.1`) and B (`0.5.0-e2e.2`) are built with `scripts/release.ts build`; C (`0.5.0-e2e.3`) is B's
 *     build renamed: its `version` answers like a real build and everything but `serve` is the real binary, but `serve`
 *     stays alive without ever listening; its release.json and sidecar still verify
 *  3  A runs as the throwaway unit from a plain path (unmanaged: the updater says so), `update.unit`, `update.feed` and
 *     `update.mode` are stored; `A install --from A` makes it managed: `<app>/bin/omp-cloud` → `versions/A`, the unit runs it,
 *     health reports A, `HOME`-scoped files only
 *  4  check: B is downloaded, verified and staged under `versions/`; the running service is still A
 *  5  apply: the service restarts onto B, health reports B, `last.result: installed`, `bin/omp-cloud` → B, A is kept
 *  6  the feed serves C: check, apply; the health check never sees C, the link goes back to B, the service is healthy on B,
 *     `last.result: failed` with `rolled back to 0.5.0-e2e.2`
 *  7  a checkout run (`bun run src/main.ts` on another config) reports `unsupported` with the contract message and refuses apply
 *  8  the live install is untouched (its unit's process, its `~/.local/bin/omp-cloud`, its app dir)
 *
 * The cleanup stops and resets the throwaway units, the checkout process, the feed and removes the temp dir, even on failure.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../src/guards";
import { hostOmp } from "../src/omp-version";
import { compareVersions, hostArch, parseManifest, releaseAssetName, type ReleaseManifest } from "../src/update/manifest";
import { CHECKOUT_MESSAGE } from "../src/update/policy";
import { installedVmonVersion } from "../src/vmon/pin";
import { expectContains, expectEqual, Report, StepFailed } from "./report";
import { takeRunLockOrExit } from "./run-lock";

const REPO_ROOT = join(import.meta.dir, "..");
const VERSION_A = "0.5.0-e2e.1";
const VERSION_B = "0.5.0-e2e.2";
const VERSION_C = "0.5.0-e2e.3";
/** The applier's own transient unit (`APPLY_UNIT` in `src/update/service.ts`): shared with the live service, so only touched when idle. */
const APPLY_UNIT = "omp-cloud-update";
const POLL_MS = 500;

type Json = Record<string, unknown>;

function obj(value: unknown, label: string): Json {
	if (!isRecord(value)) throw new Error(`${label}: expected an object, got ${JSON.stringify(value)}`);
	return value;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** A port nothing listens on right now. */
function freePort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = server.port ?? 0;
	void server.stop(true);
	return port;
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface Ran {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs a program to the end (never a shell). */
async function run(argv: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<Ran> {
	const proc = Bun.spawn(argv, { cwd: options.cwd, env: options.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

async function systemctl(...args: string[]): Promise<Ran> {
	return run(["systemctl", "--user", ...args], { timeoutMs: 60_000 });
}

/** `systemctl --user show -p <name> --value <unit>`, trimmed. */
async function unitProperty(unit: string, name: string): Promise<string> {
	const shown = await systemctl("show", "-p", name, "--value", unit);
	if (shown.code !== 0) throw new Error(`systemctl show ${unit} failed: ${shown.stderr.trim()}`);
	return shown.stdout.trim();
}

/** The pid of the unit's main process, or null. */
async function mainPid(unit: string): Promise<number | null> {
	const pid = Number(await unitProperty(unit, "MainPID"));
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The file the unit's main process runs (`/proc/<pid>/exe`), or null when it has none. */
async function unitExecutable(unit: string): Promise<string | null> {
	const pid = await mainPid(unit);
	if (pid === null) return null;
	try {
		return await readlink(`/proc/${pid}/exe`);
	} catch {
		return null;
	}
}

takeRunLockOrExit("update:scenario");
const report = new Report();
const startedAt = performance.now();

// Everything the cleanup undoes.
let tempDir: string | null = null;
let feedServer: Bun.Server<undefined> | null = null;
let checkoutProc: Bun.Subprocess | null = null;
let applierSeen = false;
const unit = `omp-cloud-e2e-${randomBytes(4).toString("hex")}`;
if (!/^omp-cloud-e2e-[0-9a-f]{8}$/.test(unit)) throw new Error(`refusing the unit name ${unit}`);

const token = randomBytes(24).toString("hex");
const authHeaders = { authorization: `Bearer ${token}` };
const listenPort = freePort();
const origin = `http://127.0.0.1:${listenPort}`;
/** Where the static feed's files come from: switched between B's and C's release directory. */
let feedDir = "";

async function api(method: string, path: string, base: string = origin, body?: unknown): Promise<Response> {
	return fetch(`${base}/api/v1${path}`, {
		method,
		headers: body === undefined ? authHeaders : { ...authHeaders, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
}

/** `GET /api/v1/health`, or null while the service does not answer (it restarts under the update). */
async function health(base: string = origin): Promise<Json | null> {
	try {
		const res = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
		if (res.status !== 200) {
			await res.body?.cancel();
			return null;
		}
		return obj(await res.json(), "health");
	} catch {
		return null;
	}
}

/** `GET /api/v1/update`, or null while the service does not answer. */
async function updateStatus(base: string = origin): Promise<Json | null> {
	try {
		const res = await api("GET", "/update", base);
		if (res.status !== 200) {
			await res.body?.cancel();
			return null;
		}
		return obj(await res.json(), "GET /update");
	} catch {
		return null;
	}
}

async function waitUntil<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
		await Bun.sleep(POLL_MS);
	}
}

/** `PUT /settings`. */
async function putSettings(settings: Json): Promise<void> {
	const res = await api("PUT", "/settings", origin, { settings });
	if (res.status !== 200) throw new Error(`PUT /settings: expected 200, got ${res.status} ${(await res.text()).slice(0, 300)}`);
	await res.body?.cancel();
}

/** The service config: loopback only, the runner off, nothing it names is contacted (as `scripts/smoke.sh`). */
function serviceConfig(dir: string, port: number, dataDir: string): Json {
	return {
		listen: `127.0.0.1:${port}`,
		apiTokenSha256: createHash("sha256").update(token).digest("hex"),
		dataDir,
		vmon: { url: "http://127.0.0.1:1", keyFile: join(dir, "vmon.key"), template: "omp-agent" },
		gateway: { url: "http://127.0.0.2:2", clientsFile: join(dir, "gateway-clients.json") },
		broker: { url: "http://127.0.0.1:3", tokenFile: join(dir, "broker.token") },
		models: { default: "fake/fake-model", direct: { fake: { baseUrl: "http://127.0.0.1:1/v1", auth: "none", api: "openai-completions", models: [{ id: "fake-model" }] } } },
		runner: { enabled: false },
	};
}

/** What the logs of the throwaway units say, for a failure report. */
async function unitLogs(): Promise<string> {
	const out = await run(["journalctl", "--user", "-u", `${unit}.service`, "-u", `${APPLY_UNIT}.service`, "-n", "60", "--no-pager", "-o", "cat"], { timeoutMs: 20_000 }).catch(() => null);
	return out === null ? "(no journal)" : out.stdout.trim() || out.stderr.trim();
}

async function main(): Promise<void> {
	const host = await hostOmp();
	const arch = hostArch();
	const asset = releaseAssetName(arch);
	const live = {
		unit: "omp-cloud",
		wrapper: join(homedir(), ".local", "bin", "omp-cloud"),
		// The live app dir is the default one: this scenario's `OMP_CLOUD_APP_DIR` points elsewhere.
		app: join(homedir(), ".local", "share", "omp-cloud", "app"),
	};
	const liveBefore = {
		pid: await mainPid(live.unit).catch(() => null),
		wrapper: await lstat(live.wrapper).then(info => `${info.mtimeMs}:${info.size}:${info.isSymbolicLink() ? "link" : "file"}`, () => "absent"),
		wrapperTarget: await readlink(live.wrapper).catch(() => ""),
		app: await lstat(live.app).then(info => `${info.mtimeMs}`, () => "absent"),
	};

	await report.step("1 preflight: a user manager, the pinned vibemon, no apply running", async () => {
		const manager = await systemctl("show-environment");
		if (manager.code !== 0) throw new Error(`no systemd user manager: ${manager.stderr.trim()}`);
		const pin = text(obj(JSON.parse(await readFile(join(REPO_ROOT, "infra", "vmon.json"), "utf8")), "infra/vmon.json").version);
		const installed = await installedVmonVersion();
		// The release says `requires.vmon.version` = the pin: anything else makes the apply run the root helper against the live vmon.
		if (installed !== pin) throw new Error(`vibemon ${installed ?? "none"} is installed but the pin is ${pin}: run mise run infra:up first, the updater's vmon step must be a no-op here`);
		// No check of the live broker and gateway: `update.ompUnits` is [] below, so the applier's omp step restarts nothing.
		expectEqual("the apply unit is idle", (await systemctl("is-active", "--quiet", APPLY_UNIT)).code === 0, false);
		expectEqual("the throwaway unit is free", (await systemctl("is-active", "--quiet", unit)).code === 0, false);
		return `vibemon ${installed}, omp ${host.version}, unit ${unit}`;
	}, shown => shown);

	const dir = await mkdtemp(join(tmpdir(), "omp-cloud-update-scenario-"));
	tempDir = dir;
	const releases = join(dir, "releases");
	const app = join(dir, "app");
	const fakeHome = join(dir, "home");
	const config = join(dir, "service.json");
	const dataDir = join(dir, "data");
	const dirOf = (version: string): string => join(releases, version);
	await mkdir(fakeHome, { recursive: true });
	await mkdir(app, { recursive: true });

	await report.step("2 build releases A and B with scripts/release.ts; derive the broken C", async () => {
		const timings: string[] = [];
		for (const version of [VERSION_A, VERSION_B]) {
			const started = performance.now();
			const built = await run([process.execPath, "run", "scripts/release.ts", "build", "--version", version, "--out", dirOf(version)], { cwd: REPO_ROOT, timeoutMs: 600_000 });
			if (built.code !== 0) throw new Error(`release.ts build ${version} exited ${built.code}: ${(built.stderr || built.stdout).trim().slice(-600)}`);
			timings.push(`${version} ${((performance.now() - started) / 1000).toFixed(0)} s`);
			const manifest = parseManifest(JSON.parse(await readFile(join(dirOf(version), "release.json"), "utf8")));
			expectEqual(`${version}: manifest version`, manifest.version, version);
			const entry = manifest.files.find(file => file.name === asset);
			if (entry === undefined) throw new Error(`${version}: release.json lists no ${asset}: ${JSON.stringify(manifest.files.map(file => file.name))}`);
			expectEqual(`${version}: size`, (await stat(join(dirOf(version), asset))).size, entry.size);
			expectEqual(`${version}: sha256`, createHash("sha256").update(await readFile(join(dirOf(version), asset))).digest("hex"), entry.sha256);
			// What the updater needs of this host: the vmon step is a no-op and omp is new enough.
			expectEqual(`${version}: requires.vmon`, manifest.requires.vmon.version, text(obj(JSON.parse(await readFile(join(REPO_ROOT, "infra", "vmon.json"), "utf8")), "vmon.json").version));
			if (compareVersions(host.version, manifest.requires.omp.min) < 0) throw new Error(`${version} needs omp ${manifest.requires.omp.min}, this host has ${host.version}`);
		}

		// C: a third build whose host-arch executable is wrapped by a script. `version` and every command but `serve`
		// run the real build (so `update apply-staged`, which the new binary runs, is the real one); `serve` stays alive
		// and never listens, so the health check can only fail.
		const c = dirOf(VERSION_C);
		await rm(c, { recursive: true, force: true });
		await mkdir(c, { recursive: true });
		const real = join(dir, "c-real", "omp-cloud");
		await mkdir(dirname(real), { recursive: true });
		// The real build must be C's own: `version` is asked of it.
		const started = performance.now();
		const realBuild = join(dir, "c-build");
		const built = await run([process.execPath, "run", "scripts/release.ts", "build", "--version", VERSION_C, "--out", realBuild], { cwd: REPO_ROOT, timeoutMs: 600_000 });
		if (built.code !== 0) throw new Error(`release.ts build ${VERSION_C} exited ${built.code}: ${(built.stderr || built.stdout).trim().slice(-600)}`);
		timings.push(`${VERSION_C} ${((performance.now() - started) / 1000).toFixed(0)} s`);
		await copyFile(join(realBuild, asset), real);
		await chmod(real, 0o755);
		const wrapper = `#!/bin/sh\n# omp-cloud ${VERSION_C} as the e2e scenario's broken release: serve stays alive and never listens.\nif [ "$1" = "serve" ]; then exec sleep 86400; fi\nexec ${quote(real)} "$@"\n`;
		const wrapperPath = join(c, asset);
		await writeFile(wrapperPath, wrapper, { mode: 0o755 });
		await chmod(wrapperPath, 0o755);
		const bytes = await readFile(wrapperPath);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		await writeFile(join(c, `${asset}.sha256`), `${sha256}  ${asset}\n`);
		const realManifest = parseManifest(JSON.parse(await readFile(join(realBuild, "release.json"), "utf8")));
		const manifestC: ReleaseManifest = {
			...realManifest,
			files: realManifest.files.map(file => (file.name === asset ? { ...file, size: bytes.length, sha256 } : file)),
		};
		await writeFile(join(c, "release.json"), `${JSON.stringify(manifestC, null, 2)}\n`);
		await writeFile(join(c, "notes.md"), manifestC.notes === "" ? "" : `${manifestC.notes}\n`);
		parseManifest(JSON.parse(await readFile(join(c, "release.json"), "utf8")));
		const answer = await run([wrapperPath, "version"], { timeoutMs: 30_000 });
		expectEqual("C's version command", answer.code, 0);
		expectContains("C's version output", answer.stdout, `omp-cloud ${VERSION_C}`);
		return timings.join(", ");
	}, shown => shown);

	// The static feed: release.json and the assets of whichever release directory `feedDir` names.
	feedServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || feedDir === "") return new Response("not found", { status: 404 });
			const file = Bun.file(join(feedDir, name));
			return file.size > 0 || name === "notes.md" ? new Response(file) : new Response("not found", { status: 404 });
		},
	});
	const feedUrl = `http://127.0.0.1:${feedServer.port}/`;
	const binA = join(dirOf(VERSION_A), asset);
	const resolvedApp = await realpath(app);
	const versionBinary = (version: string): string => join(resolvedApp, "versions", version, "omp-cloud");
	const linkTarget = (version: string): string => `../versions/${version}/omp-cloud`;
	const unitPath = `${dirname(host.path)}:/usr/local/bin:/usr/bin:/bin`;
	/** The environment of the CLI runs: a throwaway HOME (so `~/.local/bin` and the user unit dir are not the owner's) and the temp app dir. */
	const cliEnv = { ...process.env, HOME: fakeHome, OMP_CLOUD_APP_DIR: app, PATH: unitPath };

	await report.step("3 A runs from a plain path (unmanaged), then `install --from A` makes the unit run <app>/bin/omp-cloud", async () => {
		await writeFile(config, JSON.stringify(serviceConfig(dir, listenPort, dataDir), null, 2));
		const started = await run(
			[
				"systemd-run", "--user", `--unit=${unit}`, "--collect", "--description=omp-cloud update scenario (throwaway)",
				// A clean machine on purpose: HOME is an empty temp dir, so a binary that needs a warm ~/.omp/natives cache fails loudly
				// and nothing lands in the owner's ~/.omp.
				`--setenv=PATH=${unitPath}`, `--setenv=HOME=${fakeHome}`, `--setenv=OMP_CLOUD_APP_DIR=${app}`,
				binA, "serve", "--config", config,
			],
			{ timeoutMs: 60_000 },
		);
		if (started.code !== 0) throw new Error(`systemd-run ${unit} exited ${started.code}: ${started.stderr.trim()}`);
		const first = await waitUntil("the unmanaged A to answer /health", 90_000, async () => (await health()) ?? undefined);
		expectEqual("health.status", first.status, "ok");
		expectEqual("health.version", first.version, VERSION_A);
		const build = obj(first.build, "health.build");
		if (text(build.id) === "" || build.id === "dev") throw new Error(`health.build is not a release build: ${JSON.stringify(build)}`);
		if (!(Number(first.schema) > 0)) throw new Error(`health.schema is not a positive number: ${JSON.stringify(first.schema)}`);

		// Not under <app>/versions yet: the updater says what a checkout says.
		const unmanaged = obj(await updateStatus(), "GET /update");
		expectEqual("managed before install", unmanaged.managed, false);
		expectEqual("state before install", unmanaged.state, "unsupported");
		expectEqual("message before install", unmanaged.message, CHECKOUT_MESSAGE);

		// The updater restarts `update.unit`, which `install` reads from the database: store the throwaway name before it runs.
		// `off`: the scenario checks when it says so (the hourly check would race with it).
		await putSettings({ "update.unit": unit, "update.feed": feedUrl, "update.mode": "off", "update.ompUnits": [] });

		const install = await run([binA, "install", "--from", binA, "--config", config], { env: cliEnv, timeoutMs: 120_000 });
		if (install.code !== 0) throw new Error(`omp-cloud install exited ${install.code}: ${(install.stderr || install.stdout).trim()}`);
		expectContains("install output", install.stdout, `installed ${join(app, "versions", VERSION_A, "omp-cloud")}`);
		expectContains("install output", install.stdout, `restarted the transient unit ${unit}`);

		expectEqual("bin link", await readlink(join(app, "bin", "omp-cloud")), linkTarget(VERSION_A));
		expectEqual("manager.json", JSON.stringify(JSON.parse(await readFile(join(app, "manager.json"), "utf8"))), JSON.stringify({ manager: "omp-cloud", name: "omp-cloud" }));
		expectEqual("the unit's HOME is the throwaway one", (await unitProperty(unit, "Environment")).includes(`HOME=${fakeHome}`), true);
		expectEqual("the shell link of the throwaway HOME", await readlink(join(fakeHome, ".local", "bin", "omp-cloud")), join(resolvedApp, "bin", "omp-cloud"));
		expectEqual("the installed file is A's bytes", createHash("sha256").update(await readFile(versionBinary(VERSION_A))).digest("hex"), createHash("sha256").update(await readFile(binA)).digest("hex"));

		const restarted = await waitUntil("A to answer /health under the managed unit", 90_000, async () => {
			const body = await health();
			const exe = body === null ? null : await unitExecutable(unit);
			return body !== null && exe === versionBinary(VERSION_A) ? body : undefined;
		});
		expectEqual("health.version after install", restarted.version, VERSION_A);
		expectEqual("the unit runs", await unitExecutable(unit), versionBinary(VERSION_A));
		const managed = obj(await updateStatus(), "GET /update");
		expectEqual("managed after install (OMP_CLOUD_APP_DIR must reach the restarted unit)", managed.managed, true);
		expectEqual("state after install", managed.state, "idle");
		expectEqual("current.version", obj(managed.current, "current").version, VERSION_A);
		expectEqual("state.installed", obj(JSON.parse(await readFile(join(app, "state.json"), "utf8")), "state.json").installed, VERSION_A);
		const settings = await api("GET", "/settings");
		expectContains("the stored settings keep the throwaway unit", await settings.text(), unit);
	});

	await report.step("4 check: B is downloaded, verified and staged under versions/; the service still runs A", async () => {
		feedDir = dirOf(VERSION_B);
		// One check, then only reads: every POST starts a new check, and while one runs the state is `checking`, never `ready`.
		const check = await api("POST", "/update/check");
		await check.body?.cancel();
		expectEqual("POST /update/check", check.status, 202);
		const ready = await waitUntil("B to be staged", 120_000, async () => {
			const status = await updateStatus();
			return status !== null && status.state === "ready" && status.staged === VERSION_B ? status : undefined;
		});
		expectEqual("latest.version", obj(ready.latest, "latest").version, VERSION_B);
		expectEqual("current.version", obj(ready.current, "current").version, VERSION_A);
		expectEqual("error", ready.error, null);
		expectEqual("applying", ready.applying, null);
		const staged = versionBinary(VERSION_B);
		const probe = await run([staged, "version"], { timeoutMs: 30_000 });
		expectContains("the staged binary", probe.stdout, `omp-cloud ${VERSION_B}`);
		expectEqual("the staged file's mode", (await stat(staged)).mode & 0o777, 0o755);
		expectEqual("bin link after the download", await readlink(join(app, "bin", "omp-cloud")), linkTarget(VERSION_A));
		expectEqual("health after the download", (await health())?.version, VERSION_A);
		expectEqual("versions", JSON.stringify((await readdir(join(app, "versions"))).sort()), JSON.stringify([VERSION_A, VERSION_B]));
	});

	await report.step("5 apply: the service restarts onto B, `last.result` is installed, bin/omp-cloud → B, A is kept", async () => {
		const res = await api("POST", "/update/apply");
		expectEqual("POST /update/apply", res.status, 202);
		expectEqual("apply body", text(obj(obj(await res.json(), "apply").applying, "applying").version), VERSION_B);
		applierSeen = true;
		await waitUntil("health to report B", 180_000, async () => ((await health())?.version === VERSION_B ? true : undefined));
		const done = await waitUntil("the applier to record the result", 120_000, async () => {
			const status = await updateStatus();
			return status !== null && isRecord(status.last) ? status : undefined;
		});
		const last = obj(done.last, "last");
		expectEqual("last.version", last.version, VERSION_B);
		expectEqual("last.result", last.result, "installed");
		expectContains("last.message", text(last.message), `updated to ${VERSION_B}`);
		expectEqual("current.version", obj(done.current, "current").version, VERSION_B);
		expectEqual("state", done.state, "idle");
		expectEqual("staged", done.staged, null);
		expectEqual("applying", done.applying, null);
		expectEqual("error", done.error, null);
		expectEqual("bin link", await readlink(join(app, "bin", "omp-cloud")), linkTarget(VERSION_B));
		expectEqual("the unit runs", await unitExecutable(unit), versionBinary(VERSION_B));
		expectEqual("versions kept", JSON.stringify((await readdir(join(app, "versions"))).sort()), JSON.stringify([VERSION_A, VERSION_B]));
		const file = obj(JSON.parse(await readFile(join(app, "state.json"), "utf8")), "state.json");
		expectEqual("state.installed", file.installed, VERSION_B);
		expectEqual("state.previous", file.previous, VERSION_A);
		expectEqual("the applier's unit is gone", (await systemctl("is-active", "--quiet", APPLY_UNIT)).code === 0, false);
	});

	await report.step("6 a feed that serves C: apply fails the health check, the link goes back to B, the service is healthy on B", async () => {
		feedDir = dirOf(VERSION_C);
		const check = await api("POST", "/update/check");
		await check.body?.cancel();
		expectEqual("POST /update/check", check.status, 202);
		await waitUntil("C to be staged", 120_000, async () => {
			const status = await updateStatus();
			return status !== null && status.state === "ready" && status.staged === VERSION_C ? status : undefined;
		});
		expectEqual("the staged C binary prints its version", (await run([versionBinary(VERSION_C), "version"], { timeoutMs: 30_000 })).stdout.includes(`omp-cloud ${VERSION_C}`), true);

		const res = await api("POST", "/update/apply");
		expectEqual("POST /update/apply", res.status, 202);
		await res.body?.cancel();
		// C's `serve` never listens: the health check (60 s) is the only thing that can end this, and it must never see C.
		const seen = new Set<string>();
		const done = await waitUntil("the applier to record the failure", 240_000, async () => {
			const body = await health();
			if (body !== null) seen.add(text(body.version));
			const status = await updateStatus();
			return status !== null && isRecord(status.last) && status.last.version === VERSION_C ? status : undefined;
		});
		if (seen.has(VERSION_C)) throw new Error(`health reported ${VERSION_C}, which never listens`);
		const last = obj(done.last, "last");
		expectEqual("last.result", last.result, "failed");
		expectContains("last.message", text(last.message), `rolled back to ${VERSION_B}`);
		expectEqual("state after the failure", done.state, "failed");
		expectContains("error", text(done.error), `rolled back to ${VERSION_B}`);
		expectEqual("applying", done.applying, null);
		expectEqual("current.version", obj(done.current, "current").version, VERSION_B);
		expectEqual("bin link", await readlink(join(app, "bin", "omp-cloud")), linkTarget(VERSION_B));
		const healthy = await waitUntil("B to be healthy again", 90_000, async () => ((await health())?.version === VERSION_B ? true : undefined));
		expectEqual("healthy on B", healthy, true);
		expectEqual("the unit runs", await unitExecutable(unit), versionBinary(VERSION_B));
		const file = obj(JSON.parse(await readFile(join(app, "state.json"), "utf8")), "state.json");
		expectEqual("state.installed after the rollback", file.installed, VERSION_B);
		expectEqual("the applier's unit is gone", (await systemctl("is-active", "--quiet", APPLY_UNIT)).code === 0, false);
		return `health saw ${[...seen].join(", ") || "nothing"}`;
	}, shown => shown);

	await report.step("7 a checkout run (bun run src/main.ts) is unsupported with the contract message and refuses apply", async () => {
		const port = freePort();
		const checkoutConfig = join(dir, "checkout.json");
		await writeFile(checkoutConfig, JSON.stringify(serviceConfig(dir, port, join(dir, "data-checkout")), null, 2));
		const logFile = join(dir, "checkout.log");
		const logFd = openSync(logFile, "a");
		let proc: Bun.Subprocess;
		try {
			proc = Bun.spawn([process.execPath, "run", "src/main.ts", "--config", checkoutConfig], {
				cwd: REPO_ROOT,
				// The same app dir: a managed layout beside it does not make a checkout managed.
				env: { ...process.env, OMP_CLOUD_APP_DIR: app, PATH: unitPath },
				stdin: "ignore",
				stdout: logFd,
				stderr: logFd,
			});
		} finally {
			closeSync(logFd);
		}
		checkoutProc = proc;
		const base = `http://127.0.0.1:${port}`;
		await waitUntil("the checkout run to answer /health", 90_000, async () => {
			if (proc.exitCode !== null) throw new Error(`the checkout run exited with ${proc.exitCode}: ${(await readFile(logFile, "utf8")).slice(-600)}`);
			return (await health(base)) === null ? undefined : true;
		});
		const body = obj(await health(base), "health");
		if (body.build !== undefined) expectEqual("a checkout's build id", obj(body.build, "build").id, "dev");
		const status = obj(await updateStatus(base), "GET /update");
		expectEqual("managed", status.managed, false);
		expectEqual("state", status.state, "unsupported");
		expectEqual("message", status.message, CHECKOUT_MESSAGE);
		// `staged` is not checked: the checkout reads the same state.json as the managed service (it is the app dir's).
		const check = await api("POST", "/update/check", base);
		expectEqual("POST /update/check", check.status, 202);
		await check.body?.cancel();
		const apply = await api("POST", "/update/apply", base);
		expectEqual("POST /update/apply status", apply.status, 409);
		expectEqual("POST /update/apply error", text(obj(await apply.json(), "apply").error), CHECKOUT_MESSAGE);
		await Bun.sleep(1000);
		expectEqual("state after a check", obj(await updateStatus(base), "GET /update").state, "unsupported");
		// The throwaway service is untouched by it.
		expectEqual("the throwaway service", (await health())?.version, VERSION_B);
	});

	await report.step("8 the live install is untouched: its unit's process, ~/.local/bin/omp-cloud and its app dir", async () => {
		expectEqual("the live unit's main pid", await mainPid(live.unit).catch(() => null), liveBefore.pid);
		expectEqual(
			"~/.local/bin/omp-cloud",
			await lstat(live.wrapper).then(info => `${info.mtimeMs}:${info.size}:${info.isSymbolicLink() ? "link" : "file"}`, () => "absent"),
			liveBefore.wrapper,
		);
		expectEqual("~/.local/bin/omp-cloud's target", await readlink(live.wrapper).catch(() => ""), liveBefore.wrapperTarget);
		expectEqual("the live app dir", await lstat(live.app).then(info => `${info.mtimeMs}`, () => "absent"), liveBefore.app);
	});
}

let failure: unknown = null;
try {
	await main();
} catch (error) {
	failure = error;
	if (!(error instanceof StepFailed)) console.log(`FAIL  scenario: ${error instanceof Error ? error.message : String(error)}`);
}

if (failure !== null) console.log(`\n--- journal of ${unit} and ${APPLY_UNIT} ---\n${await unitLogs()}`);

/** Stops the throwaway units, the checkout run and the feed, and removes the temp dir. */
async function cleanup(): Promise<void> {
	// The unit may be transient and already gone: a failed stop is not a failure here.
	await systemctl("stop", unit).catch(() => undefined);
	await systemctl("reset-failed", unit).catch(() => undefined);
	if (applierSeen) {
		// Only the applier this scenario started (the live service never ran one: the preflight saw it idle).
		await systemctl("stop", APPLY_UNIT).catch(() => undefined);
		await systemctl("reset-failed", APPLY_UNIT).catch(() => undefined);
	}
	const child = checkoutProc as Bun.Subprocess | null;
	if (child !== null && child.exitCode === null) {
		child.kill("SIGTERM");
		const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
		if (!exited) child.kill("SIGKILL");
	}
	await (feedServer as Bun.Server<undefined> | null)?.stop(true);
	if (tempDir !== null) await rm(tempDir, { recursive: true, force: true });
}
await cleanup().catch((error: unknown) => console.log(`cleanup: ${error instanceof Error ? error.message : String(error)}`));

const ok = report.print();
console.log(`total ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
process.exit(ok && failure === null ? 0 : 1);
