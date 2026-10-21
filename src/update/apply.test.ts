import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApplyDeps, applyStaged } from "./apply";
import { AppLayout, ensureLayout, installBinary, installedVersions, linkedVersion, swapLink } from "./layout";
import type { ReleaseManifest } from "./manifest";
import { StateStore } from "./state";
import { OMP_UNITS } from "./omp-units";
import { Units } from "./system";
import { fakeVmon, type FakeVmon, lines, makeManifest, recordingRunner } from "./test-support";

let dir: string;
let layout: AppLayout;
let state: StateStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-apply-"));
	layout = new AppLayout(join(dir, "app"));
	state = new StateStore(layout.stateFile, layout.lockFile, { sleep: async () => undefined });
	await ensureLayout(layout);
	for (const version of ["0.4.0", "0.5.0", "0.5.1"]) await installBinary(layout, version, (path) => Bun.write(path, `#!/bin/sh\necho ${version}\n`).then(() => undefined));
	await swapLink(layout, "0.5.0");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

interface Run {
	deps: ApplyDeps;
	calls: ReturnType<typeof recordingRunner>["calls"];
	events: string[];
	vmon: FakeVmon;
	/** The version the service reports on /health, per restart count. */
	health: { versions: string[]; answers: number; status: number };
	steps: string[];
	/** The environments `recreateService` was called with. */
	recreated: Record<string, string>[];
	clock: { now: number };
}

interface Options {
	manifest?: ReleaseManifest;
	vmon?: Parameters<typeof fakeVmon>[0];
	schema?: number;
	ompHost?: string;
	/** ompVersion each omp unit runs. */
	units?: { broker?: string | null; gateway?: string | null };
	failCommand?: (line: string) => string | undefined;
	failBackup?: boolean;
	/** `update.ompUnits`: default the broker and gateway. */
	ompUnits?: string[];
	failRestore?: boolean;
	/** The service unit's `Environment` as systemd reports it. */
	unitEnvironment?: string;
	/** A crashed new binary unloaded the transient service unit once it was restarted. */
	unitGoneAfterSwap?: boolean;
	/** false: the applier has no way to recreate the unit. */
	recreate?: boolean;
	/** What /health answers once the service restarted: given the number of service restarts so far. */
	healthy?: (restarts: number, link: string) => string | null;
	/** The `plugin` step: absent leaves it out. */
	plugin?: (binary: string) => Promise<unknown>;
}

async function setup(options: Options = {}): Promise<Run> {
	const manifest = options.manifest ?? makeManifest("0.5.1");
	await state.update((file) => {
		file.latest = { manifest, publishedAt: "p" };
		file.staged = manifest.version;
		file.applying = { version: manifest.version, step: "starting", startedAt: new Date(0).toISOString(), from: "0.5.0", backup: "" };
	});
	const events: string[] = [];
	let restarts = 0;
	const { run, calls } = recordingRunner((argv) => {
		const line = argv.join(" ");
		const failure = options.failCommand?.(line);
		if (failure !== undefined) return { code: 1, stderr: failure };
		if (argv[0] === "systemctl" && argv[4] === "Environment") return { stdout: `${options.unitEnvironment ?? ""}\n` };
		if (argv[0] === "systemctl" && argv[2] === "show" && argv[4] === "MainPID") return { stdout: argv[argv.length - 1] === OMP_UNITS[0] ? "4242\n" : "4343\n" };
		if (argv[0] === "/proc/4242/exe") return options.units?.broker === null ? { code: 1 } : { stdout: `omp/${options.units?.broker ?? "18.12.3"}\n` };
		if (argv[0] === "/proc/4343/exe") return options.units?.gateway === null ? { code: 1 } : { stdout: `omp/${options.units?.gateway ?? "18.12.3"}\n` };
		// A crashed new binary unloaded the transient unit: nothing can be stopped, started or restarted by name.
		const gone = options.unitGoneAfterSwap === true && restarts >= 1 && argv[argv.length - 1] === "omp-cloud";
		if (gone && argv[0] === "systemctl" && argv[2] === "is-active") return { code: 3 };
		if (gone && argv[0] === "systemctl" && ["restart", "start", "stop"].includes(argv[2] ?? "")) return { code: 5, stderr: "Unit omp-cloud.service not loaded.\n" };
		if (argv[0] === "systemctl" && (argv[2] === "restart" || argv[2] === "start") && argv[3] === "omp-cloud") {
			restarts++;
			events.push(`${argv[2]} service`);
		}
		if (argv[0] === "systemctl" && argv[2] === "stop" && argv[3] === "omp-cloud") events.push("stop service");
		return undefined;
	});
	const vmon = fakeVmon(options.vmon ?? {});
	const clock = { now: Date.parse("2026-10-21T12:00:00Z") };
	const health = { versions: [] as string[], answers: 0, status: 200 };
	const steps: string[] = [];
	const recreated: Record<string, string>[] = [];
	const deps: ApplyDeps = {
		layout,
		state,
		units: new Units(run),
		vmon,
		serviceUnit: "omp-cloud",
		ompUnits: options.ompUnits ?? [...OMP_UNITS],
		healthBase: "http://127.0.0.1:8080",
		ompHost: options.ompHost ?? "18.12.3",
		schema: () => options.schema ?? 10,
		backup: async () => {
			events.push("backup");
			if (options.failBackup === true) throw new Error("disk full");
			return join(dir, "backups", "omp-cloud-20261021T120000Z.tar.gz");
		},
		restore: async (archive) => {
			events.push(`restore ${archive}`);
			if (options.failRestore === true) throw new Error("tar failed");
		},
		fetch: async (url) => {
			health.answers++;
			expect(url).toBe("http://127.0.0.1:8080/api/v1/health");
			const link = (await linkedVersion(layout)) ?? "";
			const reported = options.healthy === undefined ? link : options.healthy(restarts, link);
			if (reported === null) throw new Error("connect ECONNREFUSED");
			if (health.status !== 200) return new Response("x", { status: health.status });
			return Response.json({ status: "ok", version: reported });
		},
		sleep: async (ms) => {
			clock.now += ms;
		},
		now: () => clock.now,
		healthTimeoutMs: 5000,
		log: (message) => steps.push(message),
		recreateService:
			options.recreate === false
				? undefined
				: async (env) => {
						recreated.push(env);
						events.push("recreate service");
						restarts++;
					},
		plugin: options.plugin,
	};
	return { deps, calls, events, vmon, health, steps, clock, recreated };
}

async function stepsRecorded(deps: ApplyDeps, until: () => Promise<unknown>): Promise<string[]> {
	const seen: string[] = [];
	const original = state.update.bind(state);
	state.update = async (change) => {
		const next = await original(change);
		const step = next.applying?.step;
		if (step !== undefined && seen.at(-1) !== step) seen.push(step);
		return next;
	};
	await until();
	state.update = original;
	return seen;
}

describe("applyStaged: the happy path", () => {
	test("swap, restart the service, wait for health, then installed/previous/last; steps are recorded in order", async () => {
		const run = await setup();
		let outcome = { ok: false, message: "" };
		const steps = await stepsRecorded(run.deps, async () => {
			outcome = await applyStaged("0.5.1", run.deps);
		});

		expect(outcome).toEqual({ ok: true, message: "updated to 0.5.1" });
		expect(steps).toEqual(["starting", "omp", "swap", "health"]);
		expect(await linkedVersion(layout)).toBe("0.5.1");
		expect(run.events).toEqual(["restart service"]);
		expect(run.vmon.installs).toEqual([]);
		const file = await state.read();
		expect(file).toMatchObject({ applying: null, staged: null, error: null, installed: "0.5.1", previous: "0.5.0" });
		expect(file.last).toMatchObject({ version: "0.5.1", notes: "notes of 0.5.1", result: "installed", message: "updated to 0.5.1" });
	});

	test("old versions are pruned: the new one, the two before it and nothing older", async () => {
		await installBinary(layout, "0.3.0", async (path) => void (await Bun.write(path, "x")));
		await installBinary(layout, "0.2.0", async (path) => void (await Bun.write(path, "x")));
		const run = await setup();
		await applyStaged("0.5.1", run.deps);
		expect(await installedVersions(layout)).toEqual(["0.5.1", "0.5.0", "0.4.0"]);
	});
});

describe("applyStaged: step 1 backup, step 2 vibemon, step 3 omp", () => {
	test("a newer schema is backed up first, and the backup's path is recorded on the applying state", async () => {
		const run = await setup({ manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 11 } }), schema: 10 });
		const steps = await stepsRecorded(run.deps, async () => {
			expect((await applyStaged("0.5.1", run.deps)).ok).toBe(true);
		});
		expect(steps).toEqual(["starting", "backup", "omp", "swap", "health"]);
		expect(run.events).toEqual(["backup", "restart service"]);
	});

	test("no backup when the schema is unchanged", async () => {
		const run = await setup({ schema: 10 });
		await applyStaged("0.5.1", run.deps);
		expect(run.events).not.toContain("backup");
	});

	test("a failed backup stops everything before the swap", async () => {
		const run = await setup({ manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 11 } }), failBackup: true });
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome).toEqual({ ok: false, message: "the backup before the schema change failed: disk full" });
		expect(await linkedVersion(layout)).toBe("0.5.0");
		expect(lines(run.calls).some((line) => line.includes("restart omp-cloud"))).toBe(false);
		expect(await state.read()).toMatchObject({ applying: null, error: outcome.message, staged: "0.5.1", last: { result: "failed" } });
	});

	test("another vibemon runs the root helper before the swap, once, with the tag from the release", async () => {
		const run = await setup({ manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.5.0" }, omp: { min: "18.12.3" }, schema: 10 } }), vmon: { installed: "v0.4.0" } });
		const steps = await stepsRecorded(run.deps, async () => {
			expect((await applyStaged("0.5.1", run.deps)).ok).toBe(true);
		});
		expect(steps).toEqual(["starting", "vmon", "omp", "swap", "health"]);
		expect(run.vmon.installs).toEqual(["v0.5.0"]);
	});

	test("a needed vibemon without the helper stops before anything changed: failed, nothing touched", async () => {
		const run = await setup({
			manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.5.0" }, omp: { min: "18.12.3" }, schema: 11 } }),
			vmon: { installed: "v0.4.0", helper: false },
			ompHost: "18.12.3",
			units: { broker: "18.12.2" },
		});
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome).toEqual({
			ok: false,
			message: "vibemon v0.5.0 is needed (v0.4.0 is installed) and the root helper is not installed: run omp-cloud setup once",
		});
		// No backup, no helper run, no unit restart, no swap.
		expect(run.events).toEqual([]);
		expect(run.vmon.installs).toEqual([]);
		expect(lines(run.calls).filter((line) => line.includes("restart"))).toEqual([]);
		expect(await linkedVersion(layout)).toBe("0.5.0");
		expect(await state.read()).toMatchObject({ applying: null, error: outcome.message, staged: "0.5.1", installed: null });
	});

	test("a failing helper (which rolled vibemon back itself) fails before the swap", async () => {
		const run = await setup({
			manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.5.0" }, omp: { min: "18.12.3" }, schema: 10 } }),
			vmon: { installed: "v0.4.0", failInstall: "health check failed; rolled back to vmon 0.4.0" },
		});
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome).toEqual({ ok: false, message: "installing vibemon v0.5.0 failed: health check failed; rolled back to vmon 0.4.0" });
		expect(await linkedVersion(layout)).toBe("0.5.0");
		expect(run.events).toEqual([]);
	});

	test("an omp older than the release's minimum is refused before anything changes", async () => {
		const run = await setup({ manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.13.0" }, schema: 11 } }), ompHost: "18.12.3" });
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome).toEqual({ ok: false, message: "omp 18.13.0 or newer is needed, this host has 18.12.3" });
		expect(run.events).toEqual([]);
	});

	test("only the broker and gateway units that run another omp than the host's are restarted", async () => {
		const run = await setup({ units: { broker: "18.12.3", gateway: "18.12.2" } });
		await applyStaged("0.5.1", run.deps);
		const restarts = lines(run.calls).filter((line) => line.startsWith("systemctl --user restart"));
		expect(restarts).toEqual(["systemctl --user restart omp-auth-gateway", "systemctl --user restart omp-cloud"]);
	});

	test("update.ompUnits names the units the step checks: only those drifted ones are restarted, the others are not even looked at", async () => {
		const run = await setup({ units: { broker: "18.12.2", gateway: "18.12.2" }, ompUnits: ["omp-auth-broker"] });
		await applyStaged("0.5.1", run.deps);
		expect(lines(run.calls).filter((line) => line.startsWith("systemctl --user restart"))).toEqual([
			"systemctl --user restart omp-auth-broker",
			"systemctl --user restart omp-cloud",
		]);
		expect(lines(run.calls).some((line) => line.includes("omp-auth-gateway"))).toBe(false);
	});

	test("listed units without drift restart nothing", async () => {
		const run = await setup({ units: { broker: "18.12.3", gateway: "18.12.3" }, ompUnits: ["omp-auth-broker", "omp-auth-gateway"] });
		await applyStaged("0.5.1", run.deps);
		expect(lines(run.calls).filter((line) => line.startsWith("systemctl --user restart"))).toEqual(["systemctl --user restart omp-cloud"]);
	});

	test("an empty list skips the step: no unit is queried or restarted, and the step is not recorded", async () => {
		const run = await setup({ units: { broker: "18.12.2", gateway: "18.12.2" }, ompUnits: [] });
		const steps = await stepsRecorded(run.deps, async () => {
			expect((await applyStaged("0.5.1", run.deps)).ok).toBe(true);
		});
		expect(steps).toEqual(["starting", "swap", "health"]);
		expect(lines(run.calls).some((line) => line.includes("omp-auth") || line.includes("/proc/"))).toBe(false);
	});

	test("a unit whose omp cannot be read is left alone; a restart that fails stops before the swap", async () => {
		const quiet = await setup({ units: { broker: null, gateway: null } });
		await applyStaged("0.5.1", quiet.deps);
		expect(lines(quiet.calls).filter((line) => line.includes("restart omp-auth"))).toEqual([]);
	});

	test("a failing unit restart in step 3 is a failure before the swap", async () => {
		const run = await setup({ units: { broker: "18.12.2" }, failCommand: (line) => (line === "systemctl --user restart omp-auth-broker" ? "Job failed\n" : undefined) });
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toBe("restarting omp-auth-broker onto omp 18.12.3 failed: systemctl restart omp-auth-broker failed: Job failed");
		expect(await linkedVersion(layout)).toBe("0.5.0");
	});
});

describe("applyStaged: rollback after the swap", () => {
	test("a failed health check points back, restarts and says rolled back; the release stays staged for Retry", async () => {
		const run = await setup({ healthy: (restarts, link) => (restarts >= 2 ? link : null) });
		const steps = await stepsRecorded(run.deps, async () => {
			const outcome = await applyStaged("0.5.1", run.deps);
			expect(outcome.ok).toBe(false);
			expect(outcome.message).toBe("the service did not report 0.5.1 within 5 s (connect ECONNREFUSED); rolled back to 0.5.0");
		});
		expect(steps).toEqual(["starting", "omp", "swap", "health", "rollback"]);
		expect(await linkedVersion(layout)).toBe("0.5.0");
		expect(run.events).toEqual(["restart service", "restart service"]);
		const file = await state.read();
		expect(file).toMatchObject({ applying: null, staged: "0.5.1", installed: null, error: expect.stringContaining("rolled back to 0.5.0") });
		expect(file.last).toMatchObject({ result: "failed", version: "0.5.1" });
	});

	test("a service that answers with the old version, or an error status, is not healthy", async () => {
		const wrong = await setup({ healthy: () => "0.5.0" });
		const outcome = await applyStaged("0.5.1", wrong.deps);
		expect(outcome.message).toContain("it reports 0.5.0");
		expect(outcome.message).toContain("rolled back to 0.5.0");

		await rm(layout.stateFile);
		await swapLink(layout, "0.5.0");
		const broken = await setup();
		broken.health.status = 503;
		const second = await applyStaged("0.5.1", broken.deps);
		expect(second.message).toContain("it answers 503");
	});

	test("with a backup: the service is stopped, the link points back, the database is restored, then it starts", async () => {
		const run = await setup({
			manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 11 } }),
			healthy: (restarts, link) => (link === "0.5.0" && restarts >= 2 ? "0.5.0" : null),
		});
		const outcome = await applyStaged("0.5.1", run.deps);

		const archive = join(dir, "backups", "omp-cloud-20261021T120000Z.tar.gz");
		expect(outcome.message).toContain("rolled back to 0.5.0");
		expect(run.events).toEqual(["backup", "restart service", "stop service", `restore ${archive}`, "start service"]);
		expect(await linkedVersion(layout)).toBe("0.5.0");
		expect((await state.read()).error).toContain("rolled back to 0.5.0");
	});

	test("without a backup the database is not touched on rollback", async () => {
		const run = await setup({ healthy: (restarts, link) => (restarts >= 2 ? link : null) });
		await applyStaged("0.5.1", run.deps);
		expect(run.events.some((event) => event.startsWith("restore") || event === "stop service")).toBe(false);
	});

	test("a restore that fails still restarts the service on the old version and says so", async () => {
		const run = await setup({
			manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 11 } }),
			failRestore: true,
			healthy: (restarts) => (restarts >= 2 ? "0.5.0" : null),
		});
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.message).toContain("rolled back to 0.5.0, but restoring the database from");
		expect(outcome.message).toContain("tar failed");
		expect(run.events.at(-1)).toBe("start service");
		expect(await linkedVersion(layout)).toBe("0.5.0");
	});

	test("a restart that fails right after the swap is rolled back too", async () => {
		let failed = false;
		const run = await setup({
			failCommand: (line) => {
				if (line === "systemctl --user restart omp-cloud" && !failed) {
					failed = true;
					return "Unit omp-cloud.service not found.\n";
				}
				return undefined;
			},
			healthy: (_restarts, link) => link,
		});
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toBe("switching to 0.5.1 failed: systemctl restart omp-cloud failed: Unit omp-cloud.service not found.; rolled back to 0.5.0");
		expect(await linkedVersion(layout)).toBe("0.5.0");
	});

	test("a transient unit that the crashing new binary unloaded is recreated by the rollback (no backup: instead of restart)", async () => {
		const run = await setup({ unitGoneAfterSwap: true, healthy: (restarts, link) => (restarts >= 2 ? link : null) });
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.message).toBe("the service did not report 0.5.1 within 5 s (connect ECONNREFUSED); rolled back to 0.5.0");
		expect(run.events).toEqual(["restart service", "recreate service"]);
		expect(await linkedVersion(layout)).toBe("0.5.0");
	});

	test("with a backup: the unit is not stopped (it is gone), the database is restored, then the unit is recreated", async () => {
		const run = await setup({
			manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 11 } }),
			unitGoneAfterSwap: true,
			healthy: (restarts, link) => (restarts >= 2 ? link : null),
		});
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.message).toContain("rolled back to 0.5.0");
		expect(run.events).toEqual(["backup", "restart service", `restore ${join(dir, "backups", "omp-cloud-20261021T120000Z.tar.gz")}`, "recreate service"]);
	});

	test("the recreate gets the Environment the unit had before the swap, read while it still existed", async () => {
		const environment = 'HOME=/tmp/h PATH=/opt/bun:/usr/bin OMP_CLOUD_CONFIG=/tmp/h/service.json "EXTRA=two words"';
		const run = await setup({ unitEnvironment: environment, unitGoneAfterSwap: true, healthy: (restarts, link) => (restarts >= 2 ? link : null) });
		await applyStaged("0.5.1", run.deps);
		expect(run.recreated).toEqual([{ HOME: "/tmp/h", PATH: "/opt/bun:/usr/bin", OMP_CLOUD_CONFIG: "/tmp/h/service.json", EXTRA: "two words" }]);
		const lookups = lines(run.calls).filter((line) => line.endsWith("show -p Environment --value omp-cloud"));
		const swapAt = lines(run.calls).findIndex((line) => line === "systemctl --user restart omp-cloud");
		expect(lookups.length).toBe(1);
		expect(lines(run.calls).indexOf(lookups[0] ?? "")).toBeLessThan(swapAt);
	});

	test("without a way to recreate it the rollback says it could not restart", async () => {
		const run = await setup({ unitGoneAfterSwap: true, recreate: false, healthy: () => null });
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.message).toContain("rolling back to 0.5.0 failed: systemctl restart omp-cloud failed: Unit omp-cloud.service not loaded.");
	});

	test("an old version that does not come back up is reported as such", async () => {
		const run = await setup({ healthy: () => null });
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.message).toContain("rolled back to 0.5.0, which did not come up:");
	});
});

describe("applyStaged: refusals before the first step", () => {
	test("nothing staged, a version that is not the staged one, an old version, a missing file", async () => {
		const run = await setup();
		expect((await applyStaged("0.5.2", run.deps)).message).toBe("omp-cloud 0.5.2 is not staged; check for updates first");

		await state.update((file) => {
			file.staged = null;
		});
		expect((await applyStaged("0.5.1", run.deps)).message).toBe("omp-cloud 0.5.1 is not staged; check for updates first");

		const older = await setup({ manifest: makeManifest("0.4.0") });
		expect((await applyStaged("0.4.0", older.deps)).message).toBe("omp-cloud 0.4.0 is not newer than 0.5.0");

		const missing = await setup();
		await rm(layout.versionDir("0.5.1"), { recursive: true });
		expect((await applyStaged("0.5.1", missing.deps)).message).toBe("the staged omp-cloud 0.5.1 is missing; check for updates again");
		expect(await linkedVersion(layout)).toBe("0.5.0");
		expect(await readdir(layout.binDir)).toEqual(["omp-cloud"]);
	});

	test("a bin link that is not a managed link refuses, naming it", async () => {
		const run = await setup();
		await rm(layout.binLink);
		await Bun.write(layout.binLink, "x");
		await state.update((file) => {
			file.applying = null;
		});
		expect((await applyStaged("0.5.1", run.deps)).message).toBe("cannot tell which omp-cloud version is installed (bin/omp-cloud is not a managed link)");
	});
});

describe("applyStaged: the plugin step", () => {
	test("after the health check the new binary refreshes the plugin; the update succeeds with its plain message", async () => {
		const refreshed: { binary: string; linked: string | null }[] = [];
		const run = await setup({
			plugin: async (binary) => {
				refreshed.push({ binary, linked: await linkedVersion(layout) });
			},
		});
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome).toEqual({ ok: true, message: "updated to 0.5.1" });
		expect(refreshed).toEqual([{ binary: layout.versionBinary("0.5.1"), linked: "0.5.1" }]);
		expect(run.steps).toContain("step plugin");
		expect(run.steps.indexOf("step plugin")).toBeGreaterThan(run.steps.indexOf("step health"));
		expect(await state.read()).toMatchObject({ applying: null, installed: "0.5.1", previous: "0.5.0" });
	});

	test("a failing refresh never fails the update: it stays installed, nothing rolls back, the message says what to run", async () => {
		const run = await setup({
			plugin: async () => {
				throw new Error("✗ plugin.marketplace  omp plugin marketplace update omp-cloud failed: no network");
			},
		});
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.ok).toBe(true);
		expect(outcome.message).toBe("updated to 0.5.1 (the omp plugin was not refreshed: ✗ plugin.marketplace  omp plugin marketplace update omp-cloud failed: no network; run omp-cloud setup to retry)");
		expect(await linkedVersion(layout)).toBe("0.5.1");
		expect(run.events).toEqual(["restart service"]);
		const file = await state.read();
		expect(file).toMatchObject({ applying: null, error: null, installed: "0.5.1" });
		expect(file.last).toMatchObject({ result: "installed" });
	});

	test("an update that fails and rolls back never touches the plugin", async () => {
		let calls = 0;
		const run = await setup({
			healthy: (restarts, link) => (link === "0.5.1" && restarts === 1 ? null : link),
			plugin: async () => {
				calls++;
			},
		});
		const outcome = await applyStaged("0.5.1", run.deps);
		expect(outcome.ok).toBe(false);
		expect(calls).toBe(0);
	});

	test("without a plugin dependency there is no step", async () => {
		const run = await setup();
		await applyStaged("0.5.1", run.deps);
		expect(run.steps).not.toContain("step plugin");
	});
});
