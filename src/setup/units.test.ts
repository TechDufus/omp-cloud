import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandResult, CommandRunner } from "../update/system";
import { lines, recordingRunner } from "../update/test-support";
import { setupPaths, type SetupPaths } from "./config";
import { installUserUnits, removeUserUnits, renderUnits, USER_SERVICES, USER_UNIT_FILES, unitSearchPath, userUnitChecks, type UnitInput, type UnitMode } from "./units";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CALLER_MARKER = "/home/test/.local/share/mise/shims";
const SERVICE_FILES = USER_UNIT_FILES.filter((file) => file.endsWith(".service"));

/** `systemd-analyze --user verify` needs a user manager to talk to (XDG_RUNTIME_DIR, a user bus): a CI runner or a container has none, and it fails for every file there. */
function userVerifyWorks(): boolean {
	if (Bun.which("systemd-analyze") === null) return false;
	const probe = mkdtempSync(join(tmpdir(), "omp-cloud-units-probe-"));
	try {
		writeFileSync(join(probe, "probe.service"), "[Service]\nExecStart=/bin/true\n");
		const result = Bun.spawnSync(["systemd-analyze", "--user", "verify", join(probe, "probe.service")], { stdout: "pipe", stderr: "pipe" });
		return result.exitCode === 0 && result.stdout.length === 0 && result.stderr.length === 0;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}
const hasSystemd = userVerifyWorks();

let dir: string;
let paths: SetupPaths;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-cloud-setup-units-")));
	paths = setupPaths({ HOME: dir, OMP_CLOUD_APP_DIR: join(dir, "app") }, "tester");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const managed: UnitMode = { kind: "managed" };
const checkout: UnitMode = { kind: "checkout", repoRoot: REPO_ROOT, bunBin: process.execPath };
const modes: [string, UnitMode][] = [
	["managed", managed],
	["checkout", checkout],
];

function input(mode: UnitMode, overrides: Partial<UnitInput> = {}): UnitInput {
	return { paths, mode, ompBin: process.execPath, ...overrides };
}

describe("unitSearchPath", () => {
	test("managed: omp's directory then the system's; checkout: bun's directory first", () => {
		expect(unitSearchPath("/opt/omp/bin/omp", managed)).toBe("/opt/omp/bin:/usr/local/bin:/usr/bin:/bin");
		expect(unitSearchPath("/opt/omp/bin/omp", { kind: "checkout", repoRoot: "/r", bunBin: "/opt/bun/bin/bun" })).toBe("/opt/bun/bin:/opt/omp/bin:/usr/local/bin:/usr/bin:/bin");
	});
});

describe("renderUnits", () => {
	test("USER_SERVICES and USER_UNIT_FILES name the three services, the backup service and its timer", () => {
		expect(USER_SERVICES).toEqual(["omp-auth-broker", "omp-auth-gateway", "omp-cloud"]);
		expect([...USER_UNIT_FILES].sort()).toEqual(["omp-auth-broker.service", "omp-auth-gateway.service", "omp-cloud-backup.service", "omp-cloud-backup.timer", "omp-cloud.service"]);
	});

	for (const [name, mode] of modes) {
		describe(name, () => {
			test("renders every unit with no placeholder left, ending in a newline", () => {
				const files = renderUnits(input(mode));
				expect(Object.keys(files).sort()).toEqual([...USER_UNIT_FILES].sort());
				for (const content of Object.values(files)) {
					expect(content).not.toMatch(/@[A-Z_]+@/);
					expect(content.endsWith("\n")).toBe(true);
					expect(content.endsWith("\n\n")).toBe(false);
				}
			});

			test("the backup service, the timer and the gateway bind line", () => {
				const files = renderUnits(input(mode));
				const backup = files["omp-cloud-backup.service"] ?? "";
				if (mode.kind === "managed") {
					expect(backup).toContain(`ExecStart="${paths.appDir}/bin/omp-cloud" backup --config ${paths.serviceJson}`);
					expect(backup).toContain(`WorkingDirectory=${paths.appDir}`);
					expect(backup).toContain(`Environment="OMP_CLOUD_APP_DIR=${paths.appDir}"`);
				} else {
					expect(backup).toContain(`ExecStart="${process.execPath}" run scripts/backup.ts`);
					expect(backup).toContain(`WorkingDirectory=${REPO_ROOT}`);
					expect(backup).not.toContain("OMP_CLOUD_APP_DIR");
				}
				expect(backup).toContain("Type=oneshot");
				expect(files["omp-cloud-backup.timer"]).toContain("Persistent=true");
				expect(files["omp-auth-gateway.service"]).toContain(`--bind=10.254.254.1:4000 --clients=${paths.clientsFile}`);
				expect(files["omp-auth-gateway.service"]).toContain("omp-cloud-net.service");
				expect(files["omp-auth-gateway.service"]).not.toContain("up.sh");
				for (const unit of ["omp-auth-broker.service", "omp-auth-gateway.service"]) {
					expect(files[unit]).toContain(`Environment="HOME=${paths.authHome}"`);
					expect(files[unit]).toContain(`ExecStart="${process.execPath}" auth-`);
				}
				expect(files["omp-auth-gateway.service"]).toContain('Environment="OMP_AUTH_BROKER_URL=http://127.0.0.1:8765"');
				expect(files["omp-auth-broker.service"]).toContain("--bind=127.0.0.1:8765");
			});

			test("the service unit starts the right command", () => {
				const service = renderUnits(input(mode))["omp-cloud.service"] ?? "";
				if (mode.kind === "managed") {
					expect(service).toContain(`WorkingDirectory=${paths.appDir}`);
					expect(service).toContain(`Environment="OMP_CLOUD_APP_DIR=${paths.appDir}"`);
					expect(service).toContain(`ExecStart="${paths.appDir}/bin/omp-cloud" serve --config ${paths.serviceJson}`);
				} else {
					expect(service).toContain(`WorkingDirectory=${REPO_ROOT}`);
					expect(service).toContain(`ExecStart="${process.execPath}" run src/main.ts`);
				}
				expect(service).toContain("Wants=omp-auth-broker.service omp-auth-gateway.service");
			});

			test("the gateway wants and follows the broker, and waits at most 30 s for its token before starting", () => {
				const gateway = renderUnits(input(mode))["omp-auth-gateway.service"] ?? "";
				expect(gateway).toContain("Wants=omp-auth-broker.service\n");
				expect(gateway).toContain("After=omp-auth-broker.service\n");
				const pre = /^ExecStartPre=\/bin\/sh -c '(.*)' wait-for-broker-token (\S+)$/m.exec(gateway);
				if (pre?.[1] === undefined || pre[2] === undefined) throw new Error(`no ExecStartPre wait in:\n${gateway}`);
				const tokenFile = join(paths.authHome, ".omp", "auth-broker.token");
				expect(pre[2]).toBe(tokenFile);
				expect(pre[1]).toContain("-lt 30");
				expect(gateway.indexOf("ExecStartPre=")).toBeLessThan(gateway.indexOf("ExecStart="));
				// systemd turns `$$` into `$`; what the shell then runs succeeds at once on a token and fails (not hangs) without one.
				const script = pre[1].replaceAll("$$", "$");
				mkdirSync(join(paths.authHome, ".omp"), { recursive: true });
				expect(Bun.spawnSync(["/bin/sh", "-c", script.replace("-lt 30", "-lt 1"), "wait-for-broker-token", tokenFile], { stderr: "pipe" }).exitCode).toBe(1);
				writeFileSync(tokenFile, "token");
				expect(Bun.spawnSync(["/bin/sh", "-c", script, "wait-for-broker-token", tokenFile]).exitCode).toBe(0);
			});

			test("every service unit runs with the fixed PATH and never the caller's", () => {
				const saved = process.env.PATH;
				process.env.PATH = `${CALLER_MARKER}:${saved ?? ""}`;
				try {
					const files = renderUnits(input(mode));
					for (const unit of SERVICE_FILES) {
						expect(files[unit]).toContain(`Environment="PATH=${unitSearchPath(process.execPath, mode)}"`);
						expect(files[unit]).not.toContain(CALLER_MARKER);
					}
				} finally {
					process.env.PATH = saved;
				}
			});

			test.skipIf(!hasSystemd)("systemd-analyze --user verify accepts the rendered units", async () => {
				const binary = `${paths.appDir}/bin/omp-cloud`;
				await mkdir(`${paths.appDir}/bin`, { recursive: true });
				await writeFile(binary, "#!/bin/sh\n");
				await chmod(binary, 0o755);
				const out = join(dir, "verify");
				await mkdir(out);
				const files = renderUnits(input(mode));
				for (const [file, content] of Object.entries(files)) await writeFile(join(out, file), content);
				const verify = Bun.spawn(["systemd-analyze", "--user", "verify", ...USER_UNIT_FILES.map((file) => join(out, file))], { stdout: "pipe", stderr: "pipe" });
				const [stdout, stderr, code] = await Promise.all([new Response(verify.stdout).text(), new Response(verify.stderr).text(), verify.exited]);
				expect(stdout + stderr).toBe("");
				expect(code).toBe(0);
			});
		});
	}

	test("systemd specifiers are escaped: a % in a path is doubled", () => {
		const files = renderUnits(input(managed, { ompBin: "/opt/100%/omp" }));
		expect(files["omp-auth-broker.service"]).toContain('ExecStart="/opt/100%%/omp"');
	});

	test("a value a unit file cannot carry unquoted is refused, and the field is named", () => {
		const spaced = (overrides: Partial<UnitInput>, mode: UnitMode = managed) => () => renderUnits(input(mode, overrides));
		expect(spaced({ ompBin: "/opt/my omp/bin/omp" })).toThrow("ompBin");
		expect(spaced({ paths: { ...paths, appDir: "/srv/my app" } })).toThrow("appDir");
		expect(spaced({ paths: { ...paths, serviceJson: "/srv/my cfg/service.json" } })).toThrow("configDir");
		expect(spaced({ paths: { ...paths, authHome: "/srv/my auth" } })).toThrow("authHome");
		expect(spaced({ paths: { ...paths, clientsFile: "/srv/my clients.json" } })).toThrow("clientsFile");
		expect(spaced({}, { kind: "checkout", repoRoot: "/srv/my repo", bunBin: "/opt/bun" })).toThrow("repoRoot");
		expect(spaced({}, { kind: "checkout", repoRoot: "/srv/repo", bunBin: "/opt/my bun/bun" })).toThrow("bunBin");
		expect(spaced({ ompBin: "" })).toThrow("ompBin");
		expect(spaced({ ompBin: "/opt/x$y/omp" })).toThrow("ompBin");
	});
});

/** A fake systemctl/systemd-analyze: what verify answers, and whether the units are running. */
interface FakeHost {
	verify?: Partial<CommandResult>;
	probe?: Partial<CommandResult>;
	onCall?: (line: string) => void;
	/** The units are not running (is-active exits 3). */
	down?: boolean;
}

function fakeHost(host: FakeHost = {}) {
	return recordingRunner((argv): Partial<CommandResult> | undefined => {
		host.onCall?.(argv.join(" "));
		if (argv[0] === "systemd-analyze") return argv.at(-1)?.endsWith("probe.service") ? host.probe : host.verify;
		if (host.down === true && argv[0] === "systemctl" && argv[2] === "is-active") return { code: 3 };
		return undefined;
	});
}

function indexOfLine(calls: readonly string[], pattern: RegExp): number {
	return calls.findIndex((line) => pattern.test(line));
}

describe("installUserUnits", () => {
	test("a fresh install writes the files, then daemon-reload, try-restart and enable --now, in that order", async () => {
		let atReload: string[] = [];
		const host = fakeHost({
			onCall: (line) => {
				if (line.endsWith("daemon-reload")) atReload = existsSync(paths.unitDir) ? readdirSync(paths.unitDir) : [];
			},
		});
		const steps = await installUserUnits(input(managed), host.run);

		expect(steps.map((step) => `${step.id}:${step.status}`)).toEqual([
			"units.verify:ok",
			"units.omp-auth-broker:changed",
			"units.omp-auth-gateway:changed",
			"units.omp-cloud:changed",
			"units.omp-cloud-backup:changed",
			"units.omp-cloud-backup.timer:changed",
			"units.enable:changed",
		]);
		expect(atReload.sort()).toEqual([...USER_UNIT_FILES].sort());
		const files = renderUnits(input(managed));
		for (const [file, content] of Object.entries(files)) {
			expect(await readFile(join(paths.unitDir, file), "utf8")).toBe(content);
			expect((await stat(join(paths.unitDir, file))).mode & 0o777).toBe(0o644);
		}
		expect((await stat(paths.unitDir)).mode & 0o777).toBe(0o755);
		expect((await readdir(paths.unitDir)).sort()).toEqual([...USER_UNIT_FILES].sort());

		const calls = lines(host.calls);
		expect(calls[0]).toStartWith("systemd-analyze --user verify ");
		const reload = indexOfLine(calls, /daemon-reload$/);
		const restart = indexOfLine(calls, /try-restart/);
		const enable = indexOfLine(calls, /enable --now/);
		expect(reload).toBeGreaterThan(0);
		expect(restart).toBeGreaterThan(reload);
		expect(enable).toBeGreaterThan(restart);
		expect(calls[restart]).toBe("systemctl --user try-restart omp-auth-broker.service omp-auth-gateway.service omp-cloud.service omp-cloud-backup.timer");
		expect(calls[enable]).toBe("systemctl --user enable --now omp-auth-broker.service omp-auth-gateway.service omp-cloud.service omp-cloud-backup.timer");
	});

	test("a rerun with identical files changes nothing: no try-restart, every unit ok", async () => {
		await installUserUnits(input(managed), fakeHost().run);
		const again = fakeHost();
		const steps = await installUserUnits(input(managed), again.run);

		expect(steps.map((step) => step.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
		const calls = lines(again.calls);
		expect(calls.some((line) => line.includes("try-restart"))).toBe(false);
		expect(calls.at(-1)).toStartWith("systemctl --user enable --now");
	});

	test("identical files but units that are not running: enable --now starts them, and the step says it changed something", async () => {
		await installUserUnits(input(managed), fakeHost().run);
		const steps = await installUserUnits(input(managed), fakeHost({ down: true }).run);
		expect(steps.slice(0, -1).map((step) => step.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
		expect(steps.at(-1)).toMatchObject({ id: "units.enable", status: "changed", detail: expect.stringContaining("enabled and started") });
	});

	test("a changed unit gets try-restart and the others do not", async () => {
		await installUserUnits(input(managed), fakeHost().run);
		await writeFile(join(paths.unitDir, "omp-cloud.service"), "[Service]\nExecStart=/bin/false\n");
		const host = fakeHost();
		const steps = await installUserUnits(input(managed), host.run);

		expect(steps.filter((step) => step.status === "changed").map((step) => step.id)).toEqual(["units.omp-cloud", "units.enable"]);
		expect(lines(host.calls).filter((line) => line.includes("try-restart"))).toEqual(["systemctl --user try-restart omp-cloud.service"]);
		const wanted = renderUnits(input(managed))["omp-cloud.service"];
		if (wanted === undefined) throw new Error("omp-cloud.service was not rendered");
		expect(await readFile(join(paths.unitDir, "omp-cloud.service"), "utf8")).toBe(wanted);
	});

	test("a changed backup service is written but not restarted (a oneshot runs from its timer)", async () => {
		await installUserUnits(input(managed), fakeHost().run);
		await writeFile(join(paths.unitDir, "omp-cloud-backup.service"), "old\n");
		const host = fakeHost();
		const steps = await installUserUnits(input(managed), host.run);
		expect(steps.find((step) => step.id === "units.omp-cloud-backup")?.status).toBe("changed");
		expect(lines(host.calls).some((line) => line.includes("try-restart"))).toBe(false);
	});

	test("the managed.conf drop-in of the old install is removed with its directory, and the unit restarts", async () => {
		await installUserUnits(input(managed), fakeHost().run);
		const dropInDir = join(paths.unitDir, "omp-cloud.service.d");
		await mkdir(dropInDir);
		await writeFile(join(dropInDir, "managed.conf"), "[Service]\nExecStart=\n");
		const host = fakeHost();
		const steps = await installUserUnits(input(managed), host.run);

		expect(existsSync(dropInDir)).toBe(false);
		const unit = steps.find((step) => step.id === "units.omp-cloud");
		expect(unit?.status).toBe("changed");
		expect(unit?.detail).toContain("managed.conf");
		expect(lines(host.calls).filter((line) => line.includes("try-restart"))).toEqual(["systemctl --user try-restart omp-cloud.service"]);
	});

	test("another drop-in in that directory stays", async () => {
		const dropInDir = join(paths.unitDir, "omp-cloud.service.d");
		await mkdir(dropInDir, { recursive: true });
		await writeFile(join(dropInDir, "managed.conf"), "x");
		await writeFile(join(dropInDir, "mine.conf"), "y");
		await installUserUnits(input(managed), fakeHost().run);
		expect(await readdir(dropInDir)).toEqual(["mine.conf"]);
	});

	test("a verify that runs and fails installs nothing", async () => {
		const host = fakeHost({ verify: { code: 1, stderr: "omp-cloud.service: Command /nope is not executable: No such file or directory\n" }, probe: { code: 0 } });
		const steps = await installUserUnits(input(managed), host.run);

		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ id: "units.verify", status: "failed" });
		expect(steps[0]?.detail).toContain("not executable");
		expect(steps[0]?.fix).toBeDefined();
		expect(existsSync(paths.unitDir)).toBe(false);
		expect(lines(host.calls).some((line) => line.startsWith("systemctl"))).toBe(false);
	});

	test("without a user manager verify is skipped, said so, and the install goes on", async () => {
		const host = fakeHost({ verify: { code: 1, stderr: "Failed to connect to bus" }, probe: { code: 1, stderr: "Failed to connect to bus" } });
		const steps = await installUserUnits(input(managed), host.run);
		expect(steps[0]).toMatchObject({ id: "units.verify", status: "skipped" });
		expect(steps[0]?.detail).toContain("user manager");
		expect(existsSync(join(paths.unitDir, "omp-cloud.service"))).toBe(true);
	});

	test("a systemd-analyze that cannot be started skips verify and says so", async () => {
		const host = fakeHost();
		const run: CommandRunner = async (argv, options) => {
			if (argv[0] === "systemd-analyze") throw new Error("spawn systemd-analyze ENOENT");
			return host.run(argv, options);
		};
		const steps = await installUserUnits(input(managed), run);
		expect(steps[0]).toMatchObject({ id: "units.verify", status: "skipped" });
		expect(steps[0]?.detail).toContain("could not be started");
		expect(steps.at(-1)).toMatchObject({ id: "units.enable", status: "changed" });
	});

	test("an unsafe path is a failed step that names the field, and nothing runs", async () => {
		const host = fakeHost();
		const steps = await installUserUnits(input(managed, { ompBin: "/opt/my omp/omp" }), host.run);
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ id: "units.render", status: "failed" });
		expect(steps[0]?.detail).toContain("ompBin");
		expect(host.calls).toHaveLength(0);
	});

	test("a failing enable is reported with the status and journal commands", async () => {
		const host = recordingRunner((argv) => (argv[2] === "enable" ? { code: 1, stderr: "Unit omp-cloud.service failed to load\n" } : undefined));
		const steps = await installUserUnits(input(checkout), host.run);
		expect(steps.at(-1)).toMatchObject({ id: "units.enable", status: "failed" });
		expect(steps.at(-1)?.fix).toContain("journalctl --user -u omp-cloud");
		expect(steps.find((step) => step.id === "units.omp-cloud")?.status).toBe("changed");
	});

	test("checkout mode installs the bun run units", async () => {
		await installUserUnits(input(checkout), fakeHost().run);
		expect(await readFile(join(paths.unitDir, "omp-cloud.service"), "utf8")).toContain(`ExecStart="${process.execPath}" run src/main.ts`);
	});
});

describe("userUnitChecks", () => {
	test("one check per long-running unit; a failed one names the status and journal commands", async () => {
		const host = recordingRunner((argv): Partial<CommandResult> | undefined => {
			const unit = argv.at(-1);
			if (argv[2] === "is-enabled") return { code: unit === "omp-auth-broker.service" ? 1 : 0 };
			if (argv[2] === "is-active") return { code: unit === "omp-cloud.service" ? 3 : 0 };
			return undefined;
		});
		const steps = await userUnitChecks(host.run);

		expect(steps.map((step) => `${step.id}:${step.status}`)).toEqual([
			"units.omp-auth-broker:failed",
			"units.omp-auth-gateway:ok",
			"units.omp-cloud:failed",
			"units.omp-cloud-backup.timer:ok",
		]);
		expect(steps[0]?.detail).toBe("not enabled, active");
		expect(steps[2]?.detail).toBe("enabled, not active");
		expect(steps[2]?.fix).toBe("systemctl --user status omp-cloud.service; journalctl --user -u omp-cloud.service -e");
		expect(steps[1]?.fix).toBeUndefined();
	});
});

describe("removeUserUnits", () => {
	test("stops and disables the installed units, deletes the files and the drop-in, reloads and resets", async () => {
		await installUserUnits(input(managed), fakeHost().run);
		const dropInDir = join(paths.unitDir, "omp-cloud.service.d");
		await mkdir(dropInDir);
		await writeFile(join(dropInDir, "managed.conf"), "x");
		await writeFile(join(paths.unitDir, "keep.service"), "unrelated\n");
		const host = fakeHost();
		const steps = await removeUserUnits(paths, host.run);

		expect(await readdir(paths.unitDir)).toEqual(["keep.service"]);
		expect(steps.filter((step) => step.id.startsWith("units.omp")).every((step) => step.status === "changed")).toBe(true);
		expect(steps.some((step) => step.id === "units.drop-in")).toBe(true);
		const calls = lines(host.calls);
		for (const file of USER_UNIT_FILES) {
			expect(calls).toContain(`systemctl --user disable --now ${file}`);
			expect(calls).toContain(`systemctl --user stop ${file}`);
			expect(calls).toContain(`systemctl --user reset-failed ${file}`);
		}
		expect(indexOfLine(calls, /daemon-reload$/)).toBeGreaterThan(calls.indexOf("systemctl --user stop omp-cloud.service"));
		expect(indexOfLine(calls, /reset-failed/)).toBeGreaterThan(indexOfLine(calls, /daemon-reload$/));
	});

	test("units that were never installed are ok, and failing systemctl calls do not stop the removal", async () => {
		const host = recordingRunner(() => ({ code: 5, stderr: "Unit not loaded.\n" }));
		const steps = await removeUserUnits(paths, host.run);
		expect(steps.filter((step) => step.id.startsWith("units.omp")).map((step) => step.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
		expect(steps.at(-1)).toMatchObject({ id: "units.reload", status: "failed" });
	});
});
