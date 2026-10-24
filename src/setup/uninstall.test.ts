import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseUninstallArgs, runUninstall, type UninstallArgs } from "./uninstall";
import { rootReport, rig, type RigOptions, type TestRig, TEST_USER } from "./test-support";
import { USER_UNIT_FILES } from "./units";

let dir: string;
beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-cloud-uninstall-")));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function args(...flags: string[]): UninstallArgs {
	const parsed = parseUninstallArgs(flags);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.args;
}

/** A host as setup leaves it: units, config, vault, service data, the managed app with its link, and a backup. */
async function installedHost(options: RigOptions = {}): Promise<TestRig> {
	const testRig = await rig(dir, { host: { root: [rootReport({ key: undefined })] }, ...options });
	const { paths } = testRig.ctx;
	await mkdir(paths.unitDir, { recursive: true });
	for (const file of USER_UNIT_FILES) await writeFile(join(paths.unitDir, file), "[Unit]\n");
	await mkdir(join(paths.unitDir, "omp-cloud.service.d"), { recursive: true });
	await writeFile(join(paths.unitDir, "omp-cloud.service.d", "managed.conf"), "[Service]\n");
	await mkdir(join(paths.tlsDir), { recursive: true });
	await writeFile(paths.serviceJson, "{}");
	await writeFile(paths.vmonKey, "e2b_team_key");
	await writeFile(join(paths.tlsDir, "key.pem"), "k");
	await mkdir(join(paths.authHome, ".omp"), { recursive: true });
	await writeFile(join(paths.authHome, ".omp", "auth-broker.token"), "vault");
	await mkdir(paths.dataDir, { recursive: true });
	await writeFile(join(paths.dataDir, "store.db"), "threads");
	await mkdir(join(paths.appDir, "versions", "0.5.1"), { recursive: true });
	await mkdir(join(paths.appDir, "bin"), { recursive: true });
	await writeFile(join(paths.appDir, "manager.json"), '{"manager":"omp-cloud"}');
	await writeFile(join(paths.appDir, "versions", "0.5.1", "omp-cloud"), "#!/bin/sh\n");
	await symlink(join(paths.appDir, "versions", "0.5.1", "omp-cloud"), join(paths.appDir, "bin", "omp-cloud"));
	await mkdir(paths.binDir, { recursive: true });
	await symlink(join(paths.appDir, "bin", "omp-cloud"), join(paths.binDir, "omp-cloud"));
	await mkdir(join(dirname(paths.dataDir), "backups"), { recursive: true });
	await writeFile(join(dirname(paths.dataDir), "backups", "omp-cloud-1.tar.gz"), "backup");
	return testRig;
}

async function exists(path: string): Promise<boolean> {
	return Bun.file(path).exists().then((found) => found || readdir(path).then(() => true, () => false));
}

function sudoLines(testRig: TestRig): string[] {
	return testRig.host.lines().filter((line) => line.startsWith("sudo -- "));
}

describe("parseUninstallArgs", () => {
	test("reads the flags and refuses others", () => {
		expect(parseUninstallArgs(["--purge", "--yes", "--checkout"])).toEqual({ ok: true, args: { purge: true, yes: true, checkout: true } });
		expect(parseUninstallArgs([])).toEqual({ ok: true, args: { purge: false, yes: false, checkout: false } });
		expect(parseUninstallArgs(["--json"]).ok).toBe(false);
	});
});

describe("uninstall without --purge", () => {
	test("removes units, plugin and link, runs the root part with --uninstall, and keeps data, config, vault and backups", async () => {
		const testRig = await installedHost();
		testRig.vmon.sandboxes = [{ sandboxID: "sb-1" }, { sandboxID: "sb-2" }];
		const code = await runUninstall(args("--yes"), testRig.ctx);
		expect(code).toBe(0);
		const { paths } = testRig.ctx;
		for (const file of USER_UNIT_FILES) expect(await exists(join(paths.unitDir, file))).toBe(false);
		expect(await exists(join(paths.unitDir, "omp-cloud.service.d", "managed.conf"))).toBe(false);
		expect(await exists(join(paths.binDir, "omp-cloud"))).toBe(false);
		expect(sudoLines(testRig)).toEqual([`sudo -- ${testRig.ctx.self.argv[0]} setup system --uninstall --user ${TEST_USER}`]);
		expect(testRig.ctx.reporter.steps.map((step) => step.id)).toContain("plugin.remove");
		for (const kept of [paths.configDir, paths.authHome, paths.dataDir, paths.appDir]) expect(await exists(kept)).toBe(true);
		expect(await readFile(paths.vmonKey, "utf8")).toBe("e2b_team_key");
		expect(await readdir(join(dirname(paths.dataDir), "backups"))).toEqual(["omp-cloud-1.tar.gz"]);
		// The sandboxes are paused, not deleted.
		expect(testRig.vmon.requests).toContain("GET http://127.0.0.1:3000/v2/sandboxes?state=running&limit=100");
		expect(testRig.vmon.requests).toContain("POST http://127.0.0.1:3000/sandboxes/sb-1/pause");
		expect(testRig.vmon.requests).toContain("POST http://127.0.0.1:3000/sandboxes/sb-2/pause");
		expect(testRig.vmon.requests.some((request) => request.startsWith("DELETE"))).toBe(false);
		expect(testRig.out.join("")).toContain("kept: backups in");
		// The units stop before the root part, which stops vmon.
		const lines = testRig.host.lines();
		expect(lines.findIndex((line) => line.startsWith("systemctl --user stop omp-cloud"))).toBeLessThan(lines.findIndex((line) => line.startsWith("sudo -- ")));
	});

	test("the plan says what is removed and what stays", async () => {
		const testRig = await installedHost();
		await runUninstall(args("--yes"), testRig.ctx);
		const out = testRig.out.join("");
		expect(out).toContain("omp-cloud uninstall will:");
		expect(out).toContain("pause the sandboxes");
		expect(out).toContain("asks for sudo once");
		expect(out).not.toContain("--purge: also delete");
	});
});

describe("uninstall --purge", () => {
	test("also removes vibemon's files (through the root part), the config, the vault, the data and the app, and keeps the backups", async () => {
		const testRig = await installedHost();
		testRig.vmon.sandboxes = [{ sandboxID: "sb-1" }];
		const code = await runUninstall(args("--yes", "--purge"), testRig.ctx);
		expect(code).toBe(0);
		const { paths } = testRig.ctx;
		expect(sudoLines(testRig)).toEqual([`sudo -- ${testRig.ctx.self.argv[0]} setup system --uninstall --user ${TEST_USER} --purge`]);
		for (const gone of [paths.configDir, paths.authHome, paths.dataDir, paths.appDir]) expect(await exists(gone)).toBe(false);
		expect(await readdir(join(dirname(paths.dataDir), "backups"))).toEqual(["omp-cloud-1.tar.gz"]);
		expect(testRig.vmon.requests).toContain("GET http://127.0.0.1:3000/v2/sandboxes?state=running,paused&limit=100");
		expect(testRig.vmon.requests).toContain("DELETE http://127.0.0.1:3000/sandboxes/sb-1");
		const out = testRig.out.join("");
		expect(out).toContain("the model broker's vault: every model login is lost");
		expect(out).toContain("paired devices must pair again");
		expect(out).toContain("kept: backups in");
		expect(out).toContain("(1 files)");
	});

	test("a failed root part removes nothing of the user's data", async () => {
		const failed = rootReport({ ok: false, steps: [{ id: "system.uninstall.vmon", status: "failed", detail: "could not stop vmon" }] });
		const testRig = await installedHost({ host: { root: [failed] } });
		const code = await runUninstall(args("--yes", "--purge"), testRig.ctx);
		expect(code).toBe(1);
		const { paths } = testRig.ctx;
		for (const kept of [paths.configDir, paths.authHome, paths.dataDir, paths.appDir]) expect(await exists(kept)).toBe(true);
	});

	test("a config.yml outside the config directory (XDG_CONFIG_HOME) goes too", async () => {
		const testRig = await installedHost();
		testRig.ctx.env.XDG_CONFIG_HOME = join(dir, "xdg");
		await mkdir(join(dir, "xdg", "omp-cloud"), { recursive: true });
		await writeFile(join(dir, "xdg", "omp-cloud", "config.yml"), "url: x\n");
		expect(await runUninstall(args("--yes", "--purge"), testRig.ctx)).toBe(0);
		expect(await Bun.file(join(dir, "xdg", "omp-cloud", "config.yml")).exists()).toBe(false);
	});
});

describe("sandboxes", () => {
	test("vmon not running or a stale key are skipped with a reason, never a failure", async () => {
		const stale = await installedHost();
		stale.vmon.keyStatus = 401;
		expect(await runUninstall(args("--yes"), stale.ctx)).toBe(0);
		expect(stale.ctx.reporter.steps.find((step) => step.id === "uninstall.sandboxes")?.status).toBe("skipped");
	});
});

describe("uninstall on a vibemon node", () => {
	/** A node as `omp-cloud setup node` leaves it: the managed binary and its link, no key, no service data, no user units. */
	async function nodeHost(options: RigOptions = {}): Promise<TestRig> {
		const testRig = await rig(dir, { host: { root: [rootReport({ team: null, key: undefined })] }, node: true, ...options });
		const { paths } = testRig.ctx;
		await mkdir(join(paths.appDir, "versions", "0.5.1"), { recursive: true });
		await mkdir(join(paths.appDir, "bin"), { recursive: true });
		await writeFile(join(paths.appDir, "manager.json"), '{"manager":"omp-cloud"}');
		await writeFile(join(paths.appDir, "versions", "0.5.1", "omp-cloud"), "#!/bin/sh\n");
		await symlink(join(paths.appDir, "versions", "0.5.1", "omp-cloud"), join(paths.appDir, "bin", "omp-cloud"));
		await mkdir(paths.binDir, { recursive: true });
		await symlink(join(paths.appDir, "bin", "omp-cloud"), join(paths.binDir, "omp-cloud"));
		return testRig;
	}

	test("retires no sandboxes, touches no user unit or plugin, and runs the root part", async () => {
		const testRig = await nodeHost();
		expect(await runUninstall(args("--yes"), testRig.ctx)).toBe(0);
		const { paths } = testRig.ctx;
		expect(sudoLines(testRig)).toEqual([`sudo -- ${testRig.ctx.self.argv[0]} setup system --uninstall --user ${TEST_USER}`]);
		const stepIds = testRig.ctx.reporter.steps.map((step) => step.id);
		expect(stepIds).not.toContain("uninstall.sandboxes");
		expect(stepIds).not.toContain("plugin.remove");
		expect(testRig.vmon.requests).toEqual([]);
		expect(testRig.host.lines().filter((line) => line.startsWith("systemctl --user"))).toEqual([]);
		expect(await exists(join(paths.binDir, "omp-cloud"))).toBe(false);
		expect(await exists(paths.appDir)).toBe(true);
	});

	test("the plan names the node's units and the VMs that are lost, not the team's sandboxes", async () => {
		const testRig = await nodeHost();
		await runUninstall(args("--yes"), testRig.ctx);
		const out = testRig.out.join("");
		expect(out).toContain("VMs running on this machine are lost; the server restores their threads on its other machines");
		expect(out).toContain("the system units vmon, omp-cloud-node-net and omp-cloud-vmon-sync");
		expect(out).toContain("asks for sudo once");
		expect(out).not.toContain("sandboxes of the omp-cloud team");
		expect(out).not.toContain("user units");
		expect(out).not.toContain("omp plugin");
	});

	test("--purge passes it to the root part and removes only the app directory", async () => {
		const testRig = await nodeHost();
		const { paths } = testRig.ctx;
		await mkdir(paths.configDir, { recursive: true });
		await writeFile(join(paths.configDir, "config.yml"), "url: https://elsewhere\n");
		expect(await runUninstall(args("--yes", "--purge"), testRig.ctx)).toBe(0);
		expect(sudoLines(testRig)).toEqual([`sudo -- ${testRig.ctx.self.argv[0]} setup system --uninstall --user ${TEST_USER} --purge`]);
		expect(await exists(paths.appDir)).toBe(false);
		expect(await readFile(join(paths.configDir, "config.yml"), "utf8")).toBe("url: https://elsewhere\n");
		expect(testRig.out.join("")).toContain("--purge: also delete vibemon");
	});

	test("needs no team key, and a failed root part keeps the app directory", async () => {
		const testRig = await nodeHost({ host: { root: [rootReport({ ok: false, team: null, steps: [{ id: "system.uninstall.vmon", status: "failed", detail: "could not stop vmon" }] })] } });
		expect(await Bun.file(testRig.ctx.paths.vmonKey).exists()).toBe(false);
		expect(await runUninstall(args("--yes", "--purge"), testRig.ctx)).toBe(1);
		expect(await exists(testRig.ctx.paths.appDir)).toBe(true);
	});
});

describe("refusals", () => {
	test("as root", async () => {
		const testRig = await installedHost({ uid: 0 });
		expect(await runUninstall(args("--yes"), testRig.ctx)).toBe(1);
		expect(testRig.err.join("")).toContain("run omp-cloud uninstall as your user");
		expect(testRig.host.calls).toEqual([]);
	});

	test("under bun without --checkout", async () => {
		const testRig = await installedHost({ compiled: false });
		expect(await runUninstall(args("--yes"), testRig.ctx)).toBe(1);
		expect(testRig.host.calls).toEqual([]);
	});

	test("without a terminal and without --yes", async () => {
		const testRig = await installedHost({ stdinIsTty: false });
		expect(await runUninstall(args(), testRig.ctx)).toBe(2);
		expect(testRig.host.calls).toEqual([]);
	});

	test("declined: nothing is removed", async () => {
		const testRig = await installedHost({ answer: false });
		expect(await runUninstall(args(), testRig.ctx)).toBe(1);
		expect(testRig.asked).toEqual(["Continue? [y/N]"]);
		expect(await exists(join(testRig.ctx.paths.unitDir, "omp-cloud.service"))).toBe(true);
	});

	test("sudo that needs a password and no terminal stops first and prints the root command", async () => {
		const testRig = await installedHost({ stdinIsTty: false, host: { sudoCached: false } });
		expect(await runUninstall(args("--yes", "--purge"), testRig.ctx)).toBe(1);
		expect(testRig.err.join("")).toContain(`setup system --uninstall --user ${TEST_USER} --purge`);
		expect(await exists(join(testRig.ctx.paths.unitDir, "omp-cloud.service"))).toBe(true);
	});
});
