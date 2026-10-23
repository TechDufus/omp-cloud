import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config";
import { VMON_PIN } from "../vmon/pin";
import { defaultServiceConfig } from "./config";
import { parseSetupArgs, runSetup, type SetupArgs, setupMain } from "./index";
import { packagesFor } from "./packages";
import { NODE_ENV_FILE, type SystemReport } from "./system";
import { ADMIN_TOKEN, rootReport, rig, type RigOptions, type TestRig, TEST_USER } from "./test-support";

let dir: string;
beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-cloud-setup-")));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function args(...flags: string[]): SetupArgs {
	const parsed = parseSetupArgs(flags);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.args;
}

async function run(options: RigOptions = {}, ...flags: string[]): Promise<{ rig: TestRig; code: number }> {
	const testRig = await rig(dir, options);
	return { rig: testRig, code: await runSetup(args(...flags), testRig.ctx) };
}

async function text(path: string): Promise<string> {
	return readFile(path, "utf8");
}

async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

function sudoCalls(testRig: TestRig): string[][] {
	return testRig.host.calls.filter((call) => call.argv[0] === "sudo" && call.argv.includes("system")).map((call) => call.argv);
}

describe("parseSetupArgs", () => {
	test("reads every flag", () => {
		expect(parseSetupArgs(["--yes", "--no-login", "--no-plugin", "--no-linger", "--no-wait", "--team", "acme", "--max-sandboxes", "12", "--migrate-team", "--checkout", "--json"])).toEqual({
			ok: true,
			args: { yes: true, noLogin: true, noPlugin: true, noLinger: true, noWait: true, team: "acme", maxSandboxes: 12, migrateTeam: true, noCluster: false, checkout: true, json: true },
		});
	});

	test.each([
		[["--bogus"], "unknown argument"],
		[["--team"], "--team needs a slug"],
		[["--team", "Bad Slug"], "--team needs a slug"],
		[["--team", "system"], "--team needs a slug"],
		[["--max-sandboxes", "0"], "--max-sandboxes"],
		[["--max-sandboxes", "1001"], "--max-sandboxes"],
		[["--max-sandboxes", "many"], "--max-sandboxes"],
	])("usage error for %p", (argv, message) => {
		const parsed = parseSetupArgs(argv);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain(message);
	});
});

describe("setupMain --help", () => {
	test.each(["--help", "-h"])("%s prints the usage to stdout and exits 0", async (flag) => {
		const written: string[] = [];
		const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		try {
			expect(await setupMain([flag])).toBe(0);
		} finally {
			spy.mockRestore();
		}
		expect(written.join("")).toStartWith("usage: omp-cloud setup ");
	});
});

describe("refusals", () => {
	test("as root: nothing runs", async () => {
		const { rig: testRig, code } = await run({ uid: 0 }, "--yes");
		expect(code).toBe(1);
		expect(testRig.err.join("")).toContain("run omp-cloud setup as your user; it asks for sudo once");
		expect(testRig.host.calls).toEqual([]);
	});

	test("under bun without --checkout", async () => {
		const { rig: testRig, code } = await run({ compiled: false }, "--yes");
		expect(code).toBe(1);
		expect(testRig.err.join("")).toContain("run omp-cloud setup from a release binary, or mise run infra:up in a checkout");
		expect(testRig.host.calls).toEqual([]);
	});

	test("without a terminal and without --yes it will not guess", async () => {
		const { rig: testRig, code } = await run({ stdinIsTty: false });
		expect(code).toBe(2);
		expect(sudoCalls(testRig)).toEqual([]);
		expect(testRig.out.join("")).toContain("omp-cloud setup");
	});

	test("declining the plan changes nothing", async () => {
		const { rig: testRig, code } = await run({ answer: false });
		expect(code).toBe(1);
		expect(testRig.asked).toEqual(["Continue? [Y/n]"]);
		expect(sudoCalls(testRig)).toEqual([]);
		expect(await Bun.file(join(dir, ".config", "omp-cloud", "service.json")).exists()).toBe(false);
	});

	test("sudo that needs a password and no terminal stops before anything changes, with the exact command", async () => {
		const { rig: testRig, code } = await run({ stdinIsTty: false, host: { sudoCached: false } }, "--yes", "--team", "acme");
		expect(code).toBe(1);
		const err = testRig.err.join("");
		expect(err).toContain("sudo");
		expect(err).toContain(`sudo -- ${testRig.ctx.self.argv[0]} setup system --user ${TEST_USER} --team acme`);
		expect(sudoCalls(testRig)).toEqual([]);
		expect(await Bun.file(join(dir, ".config", "omp-cloud")).exists()).toBe(false);
	});
});

describe("the plan", () => {
	test("is printed before anything changes, and names the root and user actions", async () => {
		const { rig: testRig } = await run({ missingTools: ["ip", "git"] }, "--max-sandboxes", "7");
		const out = testRig.out.join("");
		expect(out).toContain("as root (asks for sudo once):");
		expect(out).toContain(`install packages with apt: ${packagesFor("apt", ["ip", "git"]).join(" ")}`);
		expect(out).toContain(`install the vibemon ${VMON_PIN} helper`);
		expect(out).toContain("omp-cloud-net and vmon");
		expect(out).toContain("(7 sandboxes)");
		expect(out).toContain(`enable linger for ${TEST_USER}`);
		expect(out).toContain(`as ${TEST_USER}:`);
		expect(out).toContain("user units omp-auth-broker, omp-auth-gateway, omp-cloud");
		expect(testRig.asked).toEqual(["Continue? [Y/n]"]);
		expect(out.indexOf("as root")).toBeLessThan(out.indexOf("setup system") === -1 ? Number.MAX_SAFE_INTEGER : out.indexOf("setup system"));
	});

	test("--yes does not ask; --no-linger and --no-wait show in it", async () => {
		const { rig: testRig } = await run({}, "--yes", "--no-linger", "--no-wait");
		const out = testRig.out.join("");
		expect(testRig.asked).toEqual([]);
		expect(out).not.toContain("enable linger");
		expect(out).toContain("not wait for the VM template");
	});
});

describe("the root part", () => {
	test("is one sudo with only validated flags and the packages of what is missing", async () => {
		const { rig: testRig } = await run({ missingTools: ["ip", "git"] }, "--yes", "--team", "acme", "--max-sandboxes", "5", "--no-linger");
		const calls = sudoCalls(testRig);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual([
			"sudo",
			"--",
			testRig.ctx.self.argv[0] ?? "",
			"setup",
			"system",
			"--user",
			TEST_USER,
			"--team",
			"acme",
			"--max-sandboxes",
			"5",
			"--packages",
			packagesFor("apt", ["ip", "git"]).join(","),
			"--no-linger",
		]);
		expect(testRig.host.calls.find((call) => call.argv[0] === "sudo" && call.argv.includes("system"))?.options?.inherit).toBe(true);
	});

	test("a plain run asks for nothing but the user", async () => {
		const { rig: testRig } = await run({}, "--yes");
		expect(sudoCalls(testRig)[0]?.slice(2)).toEqual([testRig.ctx.self.argv[0] ?? "", "setup", "system", "--user", TEST_USER]);
	});

	test("a failed root part stops before the user part", async () => {
		const failed = rootReport({ ok: false, steps: [{ id: "system.vmon", status: "failed", detail: "the vibemon helper failed", fix: "see the log" }] });
		const { rig: testRig, code } = await run({ host: { root: [failed] } }, "--yes");
		expect(code).toBe(1);
		expect(testRig.ctx.reporter.steps).toContainEqual(expect.objectContaining({ id: "system.vmon", status: "failed", detail: "the vibemon helper failed" }));
		expect(await Bun.file(join(dir, ".config", "omp-cloud", "service.json")).exists()).toBe(false);
	});

	test("a missing omp is installed with omp's installer, as the user, before the root part", async () => {
		const { rig: testRig, code } = await run({ omp: null }, "--yes");
		expect(code).toBe(0);
		const lines = testRig.host.lines();
		const installer = lines.indexOf("sh -c curl -fsSL https://omp.sh/install | sh");
		expect(installer).toBeGreaterThanOrEqual(0);
		expect(installer).toBeLessThan(lines.findIndex((line) => line.startsWith("sudo -- ")));
		expect(testRig.out.join("")).toContain("install omp with its own installer");
	});
});

describe("a fresh install", () => {
	test("writes the service config, token, key, TLS identity and units, with vmon.team and their modes", async () => {
		const { rig: testRig, code } = await run({}, "--yes");
		expect(code).toBe(0);
		const { paths } = testRig.ctx;
		const token = await text(paths.serviceToken);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
		expect(JSON.parse(await text(paths.serviceJson))).toEqual(defaultServiceConfig(paths, digest, "omp-cloud"));
		expect(JSON.parse(await text(paths.serviceJson))).toEqual({
			listen: "127.0.0.1:8080",
			apiTokenSha256: digest,
			dataDir: join(dir, ".local/share/omp-cloud/service"),
			vmon: { url: "http://127.0.0.1:3000", keyFile: join(dir, ".config/omp-cloud/vmon.key"), adminTokenFile: join(dir, ".config/omp-cloud/vmon-admin.token"), template: "omp-agent", team: "omp-cloud" },
			gateway: { url: "http://10.254.254.1:4000", clientsFile: join(dir, ".local/share/omp-cloud/auth-home/clients.json") },
			broker: { url: "http://127.0.0.1:8765", tokenFile: join(dir, ".local/share/omp-cloud/auth-home/.omp/auth-broker.token") },
			dashboard: { listen: "127.0.0.1:8081" },
			remote: { listen: "0.0.0.0:8443", certFile: join(dir, ".config/omp-cloud/tls/cert.pem"), keyFile: join(dir, ".config/omp-cloud/tls/key.pem") },
			mcp: { listen: "10.254.254.1:4100" },
			models: { default: "anthropic/claude-sonnet-4-6" },
		});
		const written: unknown = JSON.parse(await text(paths.serviceJson));
		expect(() => parseConfig(written)).not.toThrow();
		expect(await mode(paths.configDir)).toBe(0o700);
		expect(await mode(paths.authHome)).toBe(0o700);
		expect(await mode(paths.serviceJson)).toBe(0o600);
		expect(await mode(paths.serviceToken)).toBe(0o600);
		expect(await text(paths.vmonKey)).toBe("e2b_freshly_minted_key");
		expect(await mode(paths.vmonKey)).toBe(0o600);
		expect(await text(paths.vmonAdminToken)).toBe(ADMIN_TOKEN);
		expect(await mode(paths.vmonAdminToken)).toBe(0o600);
		expect(testRig.ctx.reporter.steps.find((step) => step.id === "config.admin")).toMatchObject({ status: "changed", detail: `the vibemon admin token is in ${paths.vmonAdminToken}; the service reads the cluster's capacity with it` });
		expect(testRig.out.join("")).not.toContain(ADMIN_TOKEN);
		expect(testRig.err.join("")).not.toContain(ADMIN_TOKEN);
		expect(await mode(paths.tlsDir)).toBe(0o700);
		expect(await mode(join(paths.tlsDir, "key.pem"))).toBe(0o600);
		expect(testRig.out.join("")).not.toContain(token);
		expect(testRig.err.join("")).not.toContain(token);
	});

	test("a root part without the vibemon admin token skips the step and writes no file; a rerun with it changes, then keeps", async () => {
		const bare = await run({ host: { root: [rootReport({ adminToken: undefined })] } }, "--yes");
		expect(bare.code).toBe(0);
		expect(bare.rig.ctx.reporter.steps.find((step) => step.id === "config.admin")).toMatchObject({ status: "skipped", detail: "/etc/vmon/env holds no VMON_ADMIN_TOKEN: capacity stays hidden" });
		expect(await Bun.file(bare.rig.ctx.paths.vmonAdminToken).exists()).toBe(false);
		const again = await rig(dir, { host: { root: [rootReport({ key: undefined, team: { slug: "omp-cloud", created: false } })] } });
		expect(await runSetup(args("--yes"), again.ctx)).toBe(0);
		expect(again.ctx.reporter.steps.find((step) => step.id === "config.admin")).toMatchObject({ status: "changed" });
		const third = await rig(dir, { host: { root: [rootReport({ key: undefined, team: { slug: "omp-cloud", created: false } })] } });
		expect(await runSetup(args("--yes"), third.ctx)).toBe(0);
		expect(third.ctx.reporter.steps.find((step) => step.id === "config.admin")).toMatchObject({ status: "ok" });
		expect(await text(third.ctx.paths.vmonAdminToken)).toBe(ADMIN_TOKEN);
	});

	test("installs itself as the managed binary and runs the units from it", async () => {
		const { rig: testRig } = await run({}, "--yes");
		const { paths } = testRig.ctx;
		expect(await Bun.file(join(paths.appDir, "manager.json")).exists()).toBe(true);
		expect(await Bun.file(join(paths.appDir, "versions", "0.5.1", "omp-cloud")).exists()).toBe(true);
		expect(await readlink(join(paths.binDir, "omp-cloud"))).toBe(join(paths.appDir, "bin", "omp-cloud"));
		const unit = await text(join(paths.unitDir, "omp-cloud.service"));
		expect(unit).toContain(`ExecStart="${paths.appDir}/bin/omp-cloud" serve --config ${paths.serviceJson}`);
		expect(unit).toContain(`OMP_CLOUD_APP_DIR=${paths.appDir}`);
		expect(unit).toContain('Environment="PATH=/opt/omp/bin:/usr/local/bin:/usr/bin:/bin"');
		expect(await Bun.file(join(paths.unitDir, "omp-cloud-backup.timer")).exists()).toBe(true);
		// No dev gateway client outside a checkout, but the clients file the gateway needs exists.
		expect(JSON.parse(await text(paths.clientsFile))).toEqual({});
		expect(await Bun.file(paths.gatewayClientToken).exists()).toBe(false);
	});

	test("hands the plugin the mode, the paths and the omp preflight found", async () => {
		const { rig: testRig } = await run({}, "--yes");
		expect(testRig.pluginCalls).toHaveLength(1);
		expect(testRig.pluginCalls[0]).toMatchObject({ mode: "managed", appDir: testRig.ctx.paths.appDir, configPath: testRig.ctx.paths.serviceJson, tokenFile: testRig.ctx.paths.serviceToken, omp: { path: "/opt/omp/bin/omp" } });
	});

	test("--no-plugin skips it; --yes and --no-login say how to log in later; otherwise the login runs", async () => {
		const noPlugin = await run({}, "--yes", "--no-plugin");
		expect(noPlugin.rig.pluginCalls).toEqual([]);
		expect(noPlugin.rig.out.join("")).toContain("log in later: omp-cloud login <provider>");
		expect(noPlugin.rig.loginCalls).toBe(0);
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		const asked = await run({});
		expect(asked.rig.loginCalls).toBe(1);
		expect(asked.rig.out.join("")).not.toContain("log in later");
	});

	test("waits for the gateway and the service reporting this version, then prints the doctor table last", async () => {
		const { rig: testRig, code } = await run({}, "--yes");
		expect(code).toBe(0);
		expect(testRig.vmon.requests).toContain("GET http://10.254.254.1:4000/healthz");
		expect(testRig.vmon.requests).toContain("GET http://127.0.0.1:8080/api/v1/health");
		const out = testRig.out.join("");
		const table = out.lastIndexOf("0 failed");
		expect(table).toBeGreaterThan(out.lastIndexOf("health.service"));
		expect(out.trimEnd().endsWith("0 failed")).toBe(true);
		// The preflight rows are printed once, at the start; the closing table is the rest.
		const closing = out.slice(out.lastIndexOf("health.service"));
		expect(closing).not.toContain("preflight.");
		expect(closing).toContain("doctor.service");
		expect(out.split("preflight.kvm")).toHaveLength(2);
	});

	test("a service that reports another version is not ready", async () => {
		const testRig = await rig(dir);
		const answer = testRig.vmon.health.fetch;
		testRig.vmon.health.fetch = async (url, init) => (url.endsWith("/api/v1/health") ? Response.json({ status: "ok", version: "0.0.1" }) : answer(url, init));
		const code = await runSetup(args("--yes"), testRig.ctx);
		expect(code).toBe(1);
		expect(testRig.err.join("")).toContain("journalctl --user -u omp-cloud");
	});

	test("--json prints one report on stdout; the human lines stay on the other sinks", async () => {
		const { rig: testRig, code } = await run({}, "--yes", "--json");
		expect(code).toBe(0);
		expect(testRig.stdout).toHaveLength(1);
		const report: unknown = JSON.parse(testRig.stdout[0] ?? "");
		expect(report).toMatchObject({ ok: true, steps: expect.arrayContaining([expect.objectContaining({ id: "system.vmon" }), expect.objectContaining({ id: "config.service", status: "changed" })]) });
		expect(testRig.stdout[0]?.endsWith("\n")).toBe(true);
	});

	test("--json reports a failure with ok: false and exit 1", async () => {
		const failed = rootReport({ ok: false, steps: [{ id: "system.vmon", status: "failed", detail: "no kvm" }] });
		const { rig: testRig, code } = await run({ host: { root: [failed] } }, "--yes", "--json");
		expect(code).toBe(1);
		expect(JSON.parse(testRig.stdout[0] ?? "")).toMatchObject({ ok: false });
	});
});

describe("a rerun", () => {
	test("changes no file and reports nothing as changed", async () => {
		const first = await run({}, "--yes");
		expect(first.code).toBe(0);
		const { paths } = first.rig.ctx;
		const before = new Map<string, string>();
		for (const file of [paths.serviceJson, paths.serviceToken, paths.vmonKey, join(paths.tlsDir, "key.pem"), join(paths.tlsDir, "cert.pem"), join(paths.unitDir, "omp-cloud.service"), join(paths.unitDir, "omp-cloud-backup.timer"), paths.clientsFile]) {
			before.set(file, await text(file));
		}
		const again = await rig(dir, { host: { root: [rootReport({ key: undefined, team: { slug: "omp-cloud", created: false } })] } });
		expect(await runSetup(args("--yes"), again.ctx)).toBe(0);
		for (const [file, content] of before) expect(await text(file)).toBe(content);
		const changed = again.ctx.reporter.steps.filter((step) => step.status === "changed" && !step.id.startsWith("plugin."));
		expect(changed).toEqual([]);
		// The key was checked, not minted again.
		expect(sudoCalls(again)).toHaveLength(1);
		expect(again.vmon.requests.some((request) => request.includes("/v2/sandboxes?limit=1"))).toBe(true);
	});
});

describe("the team key", () => {
	async function existingHost(extra: { team?: string; key?: string } = {}): Promise<void> {
		const first = await rig(dir);
		const { paths } = first.ctx;
		await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
		await runSetup(args("--yes"), first.ctx);
		await writeFile(paths.vmonKey, extra.key ?? "e2b_old_key", { mode: 0o600 });
		if (extra.team !== undefined) {
			const config: Record<string, unknown> = JSON.parse(await text(paths.serviceJson));
			await writeFile(paths.serviceJson, JSON.stringify({ ...config, vmon: { ...(config.vmon as object), team: extra.team } }));
		}
	}

	test("a stale key is replaced: the root part runs again with --mint-key and the new key is written", async () => {
		await existingHost();
		const again = await rig(dir, {
			host: { root: [rootReport({ key: undefined, team: { slug: "omp-cloud", created: false } }), rootReport({ key: "e2b_second_key", team: { slug: "omp-cloud", created: false } })] },
		});
		again.vmon.keyStatus = 401;
		expect(await runSetup(args("--yes"), again.ctx)).toBe(0);
		const calls = sudoCalls(again);
		expect(calls).toHaveLength(2);
		expect(calls[0]).not.toContain("--mint-key");
		expect(calls[1]).toContain("--mint-key");
		expect(calls[1]).toContain("--team");
		expect(await text(again.ctx.paths.vmonKey)).toBe("e2b_second_key");
		expect(await mode(again.ctx.paths.vmonKey)).toBe(0o600);
	});

	test("vmon not answering the key check is a failure with its fix, not a new key", async () => {
		await existingHost();
		const again = await rig(dir, { host: { root: [rootReport({ key: undefined, team: { slug: "omp-cloud", created: false } })] } });
		again.vmon.keyStatus = 503;
		expect(await runSetup(args("--yes"), again.ctx)).toBe(1);
		expect(again.err.join("")).toContain("journalctl -u vmon");
		expect(sudoCalls(again)).toHaveLength(1);
		expect(await text(again.ctx.paths.vmonKey)).toBe("e2b_old_key");
	});

	test("a team the root part just created writes its key even over an old one", async () => {
		await existingHost();
		const again = await rig(dir, { host: { root: [rootReport({ key: "e2b_recreated", team: { slug: "omp-cloud", created: true } })] } });
		expect(await runSetup(args("--yes"), again.ctx)).toBe(0);
		expect(await text(again.ctx.paths.vmonKey)).toBe("e2b_recreated");
		expect(sudoCalls(again)).toHaveLength(1);
	});

	test("--migrate-team switches: the service stops first, the old key is kept as vmon.key.acme and paused threads are mentioned", async () => {
		await existingHost({ team: "acme", key: "e2b_acme_key" });
		const testRig = await rig(dir, { host: { root: [rootReport({ key: "e2b_new_team_key", team: { slug: "omp-cloud", created: true } })] } });
		expect(await runSetup(args("--yes", "--migrate-team"), testRig.ctx)).toBe(0);
		const lines = testRig.host.lines();
		const stop = lines.indexOf("systemctl --user stop omp-cloud");
		const root = lines.findIndex((line) => line.startsWith("sudo -- "));
		expect(stop).toBeGreaterThanOrEqual(0);
		expect(stop).toBeLessThan(root);
		expect(lines[root]).toContain("--team omp-cloud --migrate-team");
		expect(await text(testRig.ctx.paths.vmonKey)).toBe("e2b_new_team_key");
		expect(await text(`${testRig.ctx.paths.vmonKey}.acme`)).toBe("e2b_acme_key");
		expect(await mode(`${testRig.ctx.paths.vmonKey}.acme`)).toBe(0o600);
		expect(JSON.parse(await text(testRig.ctx.paths.serviceJson)).vmon.team).toBe("omp-cloud");
		const out = testRig.out.join("");
		expect(out).toContain("switch the team from acme to omp-cloud");
		expect(out).toContain("cold restores");
	});

	test("--migrate-team --team <slug> migrates to that slug, and a second run of it is a plain run", async () => {
		await existingHost({ team: "acme", key: "e2b_acme_key" });
		const testRig = await rig(dir, { host: { root: [rootReport({ key: "e2b_beta", team: { slug: "beta", created: true } })] } });
		expect(await runSetup(args("--yes", "--migrate-team", "--team", "beta"), testRig.ctx)).toBe(0);
		expect(JSON.parse(await text(testRig.ctx.paths.serviceJson)).vmon.team).toBe("beta");
		const again = await rig(dir, { host: { root: [rootReport({ key: undefined, team: { slug: "beta", created: false } })] } });
		expect(await runSetup(args("--yes", "--migrate-team", "--team", "beta"), again.ctx)).toBe(0);
		expect(sudoCalls(again)).toHaveLength(1);
		expect(sudoCalls(again)[0]).not.toContain("--migrate-team");
		expect(await text(`${again.ctx.paths.vmonKey}.acme`)).toBe("e2b_acme_key");
	});

	test("--team that disagrees with the host's team is a usage error pointing at --migrate-team", async () => {
		await existingHost({ team: "acme" });
		const testRig = await rig(dir);
		expect(await runSetup(args("--yes", "--team", "beta"), testRig.ctx)).toBe(2);
		expect(sudoCalls(testRig)).toEqual([]);
	});
});

describe("service.json that cannot be used", () => {
	test("an invalid file is reported and left alone", async () => {
		const testRig = await rig(dir);
		await mkdir(testRig.ctx.paths.configDir, { recursive: true, mode: 0o700 });
		await writeFile(testRig.ctx.paths.serviceJson, "{ not json");
		expect(await runSetup(args("--yes"), testRig.ctx)).toBe(1);
		expect(await text(testRig.ctx.paths.serviceJson)).toBe("{ not json");
		expect(testRig.err.join("")).toContain("is not valid JSON");
	});
});

describe("checkout mode", () => {
	test("runs the units from the repository with bun, writes the wrapper and the dev gateway client, and links the plugin", async () => {
		const testRig = await rig(dir, { compiled: false });
		const code = await runSetup(args("--yes", "--checkout"), testRig.ctx);
		expect(code).toBe(0);
		const { paths } = testRig.ctx;
		const unit = await text(join(paths.unitDir, "omp-cloud.service"));
		expect(unit).toContain(`WorkingDirectory=${testRig.ctx.self.repoRoot}`);
		expect(unit).toContain(`ExecStart="${join(dir, "bin", "bun")}" run src/main.ts`);
		expect(unit).toContain(`Environment="PATH=${join(dir, "bin")}:/opt/omp/bin:/usr/local/bin:/usr/bin:/bin"`);
		expect(await Bun.file(join(paths.appDir, "manager.json")).exists()).toBe(false);
		const wrapper = join(paths.binDir, "omp-cloud");
		expect((await lstat(wrapper)).isSymbolicLink()).toBe(false);
		expect(await text(wrapper)).toContain("src/cli.ts");
		expect(await mode(wrapper)).toBe(0o755);
		expect(Object.keys(JSON.parse(await text(paths.clientsFile)))).toEqual(["omp-cloud-dev"]);
		expect(await mode(paths.gatewayClientToken)).toBe(0o600);
		expect(testRig.pluginCalls[0]).toMatchObject({ mode: "checkout", repoRoot: testRig.ctx.self.repoRoot });
		// The sudo line runs bun on the checkout's entry.
		expect(sudoCalls(testRig)[0]?.slice(0, 4)).toEqual(["sudo", "--", join(dir, "bin", "bun"), join(dir, "repo", "src", "bin.ts")]);
	});

	test("the dev client keeps its token on a rerun, and a client the service added stays", async () => {
		const first = await rig(dir, { compiled: false });
		const { paths } = first.ctx;
		await mkdir(join(paths.authHome), { recursive: true, mode: 0o700 });
		await writeFile(paths.clientsFile, JSON.stringify({ "thread-1": { tokenSha256: "c".repeat(64) } }), { mode: 0o600 });
		expect(await runSetup(args("--yes", "--checkout"), first.ctx)).toBe(0);
		expect(Object.keys(JSON.parse(await text(paths.clientsFile))).sort()).toEqual(["omp-cloud-dev", "thread-1"]);
		const token = await text(paths.gatewayClientToken);
		const again = await rig(dir, { compiled: false, host: { root: [rootReport({ key: undefined, team: { slug: "omp-cloud", created: false } })] } });
		expect(await runSetup(args("--yes", "--checkout"), again.ctx)).toBe(0);
		expect(await text(paths.gatewayClientToken)).toBe(token);
	});

	test("--checkout with a release binary is a usage error", async () => {
		const testRig = await rig(dir);
		expect(await runSetup(args("--yes", "--checkout"), testRig.ctx)).toBe(2);
		expect(testRig.host.calls).toEqual([]);
	});
});

describe("preflight and the template wait", () => {
	test("a failed preflight stops before the plan, the prompt and sudo", async () => {
		const testRig = await rig(dir);
		testRig.ctx.preflight.exists = async (path) => path !== "/dev/kvm" && path !== NODE_ENV_FILE;
		expect(await runSetup(args("--yes"), testRig.ctx)).toBe(1);
		expect(testRig.err.join("")).toContain("preflight.kvm");
		expect(testRig.out.join("")).not.toContain("will:");
		expect(sudoCalls(testRig)).toEqual([]);
		expect(await Bun.file(join(dir, ".config", "omp-cloud")).exists()).toBe(false);
	});

	test("--no-wait leaves the template building and still succeeds", async () => {
		const testRig = await rig(dir);
		testRig.ctx.parts.templateProbe = async () => ({ name: async () => "omp-agent:18.12.3-abc", exists: async () => false });
		expect(await runSetup(args("--yes", "--no-wait"), testRig.ctx)).toBe(0);
		expect(testRig.ctx.reporter.steps.find((step) => step.id === "health.template")).toMatchObject({ status: "skipped" });
		expect(testRig.out.join("")).toContain("building in the background");
	});

	test("the wait prints a progress line while the template builds, then reports it ready", async () => {
		const testRig = await rig(dir);
		let polls = 0;
		testRig.ctx.parts.templateProbe = async () => ({ name: async () => "omp-agent:18.12.3-abc", exists: async () => ++polls > 8 });
		expect(await runSetup(args("--yes"), testRig.ctx)).toBe(0);
		expect(testRig.out.join("")).toContain("building the VM template omp-agent:18.12.3-abc");
		expect(testRig.ctx.reporter.steps.find((step) => step.id === "health.template")).toMatchObject({ status: "changed" });
	});
});

describe("cluster mode", () => {
	const LAN = "192.168.1.20";
	const SECRET = "cluster-secret-from-the-root-part";
	const lanHost = (argv: readonly string[]) => (argv.includes("addr") ? { stdout: `2: eth0    inet ${LAN}/24 brd 192.168.1.255 scope global eth0\n` } : undefined);
	const cluster = (over: Partial<SystemReport> = {}) => rootReport({ clusterSecret: SECRET, ...over });
	const serviceJson = () => join(dir, ".config", "omp-cloud", "service.json");
	const secretFile = () => join(dir, ".config", "omp-cloud", "vmon-cluster.secret");

	test("--cluster-address and --no-cluster parse, and together are a usage error", () => {
		expect(parseSetupArgs(["--cluster-address", LAN])).toMatchObject({ ok: true, args: { clusterAddress: LAN, noCluster: false } });
		expect(parseSetupArgs(["--no-cluster"])).toMatchObject({ ok: true, args: { noCluster: true } });
		expect(parseSetupArgs(["--cluster-address", LAN, "--no-cluster"])).toEqual({ ok: false, error: "--cluster-address and --no-cluster cannot be used together" });
		expect(parseSetupArgs(["--cluster-address"]).ok).toBe(false);
		expect(parseSetupArgs(["--cluster-address", "lan.example"]).ok).toBe(false);
	});

	test("a machine that is a vibemon node refuses before preflight or sudo", async () => {
		const { rig: testRig, code } = await run({ node: true }, "--yes");
		expect(code).toBe(1);
		expect(testRig.err.join("")).toContain("this machine is a vibemon node; omp-cloud uninstall first");
		expect(testRig.host.calls).toEqual([]);
	});

	test("--cluster-address goes to the root part, shows in the plan, and lands in service.json with the secret in a 0600 file", async () => {
		const { rig: testRig, code } = await run({ host: { respond: lanHost, root: [cluster()] } }, "--yes", "--cluster-address", LAN);
		expect(code).toBe(0);
		expect(sudoCalls(testRig)[0]).toContain("--cluster-address");
		expect(sudoCalls(testRig)[0]?.join(" ")).toContain(`--cluster-address ${LAN}`);
		expect(testRig.out.join("")).toContain(`let other vibemon machines join: vmon listens for them on ${LAN} (ports 7946 and 7947) and restarts, so a turn running now is re-run`);
		const config = parseConfig(JSON.parse(await text(serviceJson())));
		expect(config.vmon.clusterAddress).toBe(LAN);
		expect(config.vmon.clusterSecretFile).toBe(secretFile());
		expect(await text(secretFile())).toBe(SECRET);
		expect(await mode(secretFile())).toBe(0o600);
		expect(testRig.out.join("") + testRig.err.join("") + testRig.stdout.join("")).not.toContain(SECRET);
		expect(JSON.stringify(testRig.ctx.reporter.steps)).not.toContain(SECRET);
	});

	test("a rerun keeps the recorded address without a flag and changes nothing in the plan", async () => {
		await run({ host: { respond: lanHost, root: [cluster()] } }, "--yes", "--cluster-address", LAN);
		const { rig: again, code } = await run({ host: { respond: lanHost, root: [cluster()] } }, "--yes");
		expect(code).toBe(0);
		expect(sudoCalls(again)[0]?.join(" ")).toContain(`--cluster-address ${LAN}`);
		expect(again.out.join("")).not.toContain("let other vibemon machines join");
		expect(await text(secretFile())).toBe(SECRET);
	});

	test("--no-cluster stops it: no flag for the root part, the plan says so, the keys and the secret file go", async () => {
		await run({ host: { respond: lanHost, root: [cluster()] } }, "--yes", "--cluster-address", LAN);
		const { rig: off, code } = await run({ host: { respond: lanHost } }, "--yes", "--no-cluster");
		expect(code).toBe(0);
		expect(sudoCalls(off)[0]).not.toContain("--cluster-address");
		expect(off.out.join("")).toContain("stop listening for other vibemon machines");
		const vmon = JSON.parse(await text(serviceJson())).vmon as Record<string, unknown>;
		expect(vmon).not.toHaveProperty("clusterAddress");
		expect(vmon).not.toHaveProperty("clusterSecretFile");
		expect(await Bun.file(secretFile()).exists()).toBe(false);
	});

	test("an address that is not this machine's fails preflight before the plan", async () => {
		const { rig: testRig, code } = await run({}, "--yes", "--cluster-address", LAN);
		expect(code).toBe(1);
		expect(testRig.err.join("")).toContain(`preflight.cluster-address`);
		expect(sudoCalls(testRig)).toEqual([]);
	});

	test("a root part that reports no cluster secret fails instead of leaving service.json half set", async () => {
		const { rig: testRig, code } = await run({ host: { respond: lanHost } }, "--yes", "--cluster-address", LAN);
		expect(code).toBe(1);
		expect(testRig.err.join("")).toContain("config.cluster");
		expect(await Bun.file(secretFile()).exists()).toBe(false);
	});

	test("the key-minting second call keeps the cluster address", async () => {
		const { rig: testRig } = await run({ host: { respond: lanHost, root: [cluster({ key: undefined })] } }, "--yes", "--cluster-address", LAN);
		const calls = sudoCalls(testRig);
		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls) expect(call.join(" ")).toContain(`--cluster-address ${LAN}`);
	});
});
