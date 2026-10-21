import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../update/system";
import { Reporter } from "./steps";
import { parseSystemArgs, parseSystemReport, runSystem, SETUP_RECORD, SUDOERS_FILE, systemChecks } from "./system";
import type { SystemDeps, SystemReport } from "./system";
import type { FakeRunner } from "./system-fakes";
import { fakeRunner, putFile } from "./system-fakes";

const HELPER = "/usr/local/libexec/omp-cloud/vmon-install";
const KEY = `e2b_${"ab12".repeat(10)}`;
const OTHER_KEY = `e2b_${"cd34".repeat(10)}`;
const COUNTS = "sandboxes=32 builds=4 vcpus=8 memory_mb=8192 disk_mb=20480 hours=24";
const CREATED = `team    omp-cloud (9f1d)\nslug    omp-cloud\napi key ${KEY}\n`;
const HELPER_OK = 'downloading\n{"ok": true, "version": "v0.4.0"}\n';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-cloud-system-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

interface Host {
	deps: SystemDeps;
	runner: FakeRunner;
	/** The human lines (stderr). */
	human: string[];
	/** What reached stdout. */
	stdout: string[];
	secrets: string[];
	report(): SystemReport;
}

interface HostOptions {
	/** Answers that win over the defaults of a healthy fresh host. */
	respond?: (argv: readonly string[]) => Partial<CommandResult> | undefined;
	euid?: number;
	which?: (name: string) => string | null;
	helperScript?: string;
	teams?: string;
}

/** A fresh host whose every command works: no units, vmon missing (the helper installs it), the team not yet created. */
function host(options: HostOptions = {}): Host {
	const human: string[] = [];
	const stdout: string[] = [];
	const secrets: string[] = [];
	const runner = fakeRunner((argv) => {
		const custom = options.respond?.(argv);
		if (custom !== undefined) return custom;
		const verb = argv[0] === "/opt/vmon/vmon" ? argv[4] : argv[1];
		if (argv[0] === "ip") return { stdout: "default via 192.168.1.1 dev eth0\n192.168.1.0/24 dev eth0 scope link\n" };
		if (argv[0] === HELPER) return { stdout: HELPER_OK };
		if (argv[0] === "/opt/vmon/vmon" && argv[1] === "--version") return { stdout: "vmon 0.4.0\n" };
		if (argv[0] === "/opt/vmon/vmon") {
			if (verb === "list-teams") return { stdout: options.teams ?? "" };
			if (verb === "create-team") return { stdout: CREATED };
			if (verb === "create-api-key") return { stdout: `${OTHER_KEY}\n` };
			return { stdout: "team line\n" };
		}
		if (verb === "is-enabled") return { code: 1 };
		if (verb === "is-active") return { code: 3 };
		return undefined;
	});
	const deps: SystemDeps = {
		root,
		runner: runner.run,
		reporter: new Reporter({ out: (text) => void human.push(text), err: (text) => void human.push(text), color: false }),
		stdout: (text) => void stdout.push(text),
		euid: () => options.euid ?? 0,
		rootUid: process.getuid?.() ?? 0,
		which: options.which ?? ((name) => (name === "apt-get" ? "/usr/bin/apt-get" : null)),
		secret: () => {
			const secret = String(secrets.length + 1).padStart(64, "a");
			secrets.push(secret);
			return secret;
		},
		sleep: async () => {},
		vmonHealth: async () => 204,
		pin: "v0.4.0",
		helperScript: options.helperScript ?? "#!/bin/sh\n# the embedded helper\n",
	};
	return { deps, runner, human, stdout, secrets, report: () => parseSystemReport(stdout.at(-1)?.trim() ?? "") };
}

const ARGS = ["--user", "alice"];
const modeOf = async (path: string) => (await stat(join(root, path))).mode & 0o777;
const exists = async (path: string) => (await stat(join(root, path)).catch(() => null)) !== null;

describe("parseSystemArgs", () => {
	test("takes every documented flag, with defaults for the rest", () => {
		expect(parseSystemArgs(["--user", "alice"])).toEqual({
			ok: true,
			args: { user: "alice", team: "omp-cloud", maxSandboxes: 32, packages: [], mintKey: false, noLinger: false, migrateTeam: false, uninstall: false, purge: false },
		});
		expect(parseSystemArgs(["--user=alice", "--team", "my-team", "--max-sandboxes=1000", "--packages", "curl,git,curl", "--mint-key", "--no-linger", "--migrate-team"])).toEqual({
			ok: true,
			args: { user: "alice", team: "my-team", maxSandboxes: 1000, packages: ["curl", "git"], mintKey: true, noLinger: true, migrateTeam: true, uninstall: false, purge: false },
		});
		expect(parseSystemArgs(["--uninstall", "--purge"])).toMatchObject({ ok: true, args: { uninstall: true, purge: true } });
		expect(parseSystemArgs(["--uninstall", "--user", "alice"])).toMatchObject({ ok: true, args: { user: "alice", uninstall: true } });
	});

	const refused: Array<[string, string[]]> = [
		["a missing user", []],
		["an unknown flag", [...ARGS, "--force"]],
		["a positional word", [...ARGS, "extra"]],
		["a user with a capital", ["--user", "Alice"]],
		["a user with a space", ["--user", "al ice"]],
		["a user that starts with a digit", ["--user", "1alice"]],
		["a user with a shell metacharacter", ["--user", "alice;id"]],
		["root as the user", ["--user", "root"]],
		["a user of 33 characters", ["--user", "a".repeat(33)]],
		["--user without a value", ["--user"]],
		["--user followed by a flag", ["--user", "--mint-key"]],
		["an empty value", ["--user="]],
		["the same flag twice", [...ARGS, "--user", "bob"]],
		["a switch twice", [...ARGS, "--mint-key", "--mint-key"]],
		["a switch with a value", [...ARGS, "--mint-key=1"]],
		["the reserved team system", [...ARGS, "--team", "system"]],
		["a team with a capital", [...ARGS, "--team", "Acme"]],
		["a team that starts with a dash", [...ARGS, "--team=-acme"]],
		["a team with an underscore", [...ARGS, "--team", "a_b"]],
		["a team of 64 characters", [...ARGS, "--team", "a".repeat(64)]],
		["zero sandboxes", [...ARGS, "--max-sandboxes", "0"]],
		["1001 sandboxes", [...ARGS, "--max-sandboxes", "1001"]],
		["a negative sandbox count", [...ARGS, "--max-sandboxes=-1"]],
		["a fractional sandbox count", [...ARGS, "--max-sandboxes", "1.5"]],
		["a non-numeric sandbox count", [...ARGS, "--max-sandboxes", "many"]],
		["a package outside the set", [...ARGS, "--packages", "curl,openssh-server"]],
		["a package list with a shell metacharacter", [...ARGS, "--packages", "curl;reboot"]],
		["a package list of only commas", [...ARGS, "--packages", ","]],
		["--purge without --uninstall", [...ARGS, "--purge"]],
		["--uninstall with --mint-key", ["--uninstall", "--mint-key"]],
		["--uninstall with --team", ["--uninstall", "--team", "x"]],
		["--uninstall with --packages", ["--uninstall", "--packages", "curl"]],
		["--uninstall with --no-linger", ["--uninstall", "--no-linger"]],
	];
	test.each(refused)("refuses %s", (_name, argv) => {
		expect(parseSystemArgs(argv).ok).toBe(false);
	});
});

describe("runSystem: refusals", () => {
	test("a refused flag exits 2, runs nothing and still ends with a JSON line", async () => {
		const h = host();
		expect(await runSystem([...ARGS, "--team", "system"], h.deps)).toBe(2);
		expect(h.runner.calls).toEqual([]);
		expect(h.stdout).toHaveLength(1);
		expect(h.report()).toMatchObject({ ok: false, steps: [{ id: "system.arguments", status: "failed" }] });
		expect(await readdir(root)).toEqual([]);
	});

	test("not root: exit 1, nothing runs, nothing is written", async () => {
		const h = host({ euid: 1000 });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(h.runner.calls).toEqual([]);
		expect(h.report()).toMatchObject({ ok: false, steps: [{ id: "system.root", status: "failed" }] });
		expect(await readdir(root)).toEqual([]);
		const uninstall = host({ euid: 1000 });
		expect(await runSystem(["--uninstall"], uninstall.deps)).toBe(1);
		expect(uninstall.runner.calls).toEqual([]);
	});

	test("a user that does not exist stops before anything is installed", async () => {
		const h = host({ respond: (argv) => (argv[0] === "id" ? { code: 1 } : undefined) });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.user", status: "failed" });
		expect(await exists(HELPER)).toBe(false);
	});
});

describe("runSystem: packages", () => {
	test("apt, dnf and pacman each run their command with the requested names", async () => {
		const cases: Array<[string, string[], string[]]> = [
			["apt-get", ["curl", "iproute2"], ["apt-get update", "apt-get install -y curl iproute2"]],
			["dnf", ["curl", "iproute"], ["dnf install -y curl iproute"]],
			["pacman", ["curl", "iproute2"], ["pacman -S --needed --noconfirm curl iproute2"]],
		];
		for (const [manager, names, commands] of cases) {
			const h = host({ which: (name) => (name === manager ? `/usr/bin/${name}` : null) });
			await runSystem([...ARGS, "--packages", names.join(",")], h.deps);
			expect(h.runner.lines().slice(0, commands.length)).toEqual(commands);
			expect(h.report().steps[0]).toMatchObject({ id: "system.packages", status: "changed" });
		}
	});

	test("a name from another manager's set is a failed step, not an install", async () => {
		const h = host();
		expect(await runSystem([...ARGS, "--packages", "iproute"], h.deps)).toBe(1);
		expect(h.report().steps[0]).toMatchObject({ id: "system.packages", status: "failed" });
		expect(h.runner.calls).toEqual([]);
	});

	test("no package manager is a failed step with the names to install", async () => {
		const h = host({ which: () => null });
		expect(await runSystem([...ARGS, "--packages", "curl"], h.deps)).toBe(1);
		expect(h.report().steps[0]).toMatchObject({ status: "failed", fix: "install curl with your package manager" });
	});

	test("a failed install stops the run", async () => {
		const h = host({ respond: (argv) => (argv[0] === "apt-get" && argv[1] === "install" ? { code: 100, stderr: "E: no network" } : undefined) });
		expect(await runSystem([...ARGS, "--packages", "curl"], h.deps)).toBe(1);
		expect(await exists(HELPER)).toBe(false);
	});

	test("without --packages nothing is installed", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(h.runner.lines().some((line) => line.startsWith("apt-get"))).toBe(false);
	});
});

describe("runSystem: helper and sudoers rule", () => {
	test("installs the embedded helper root-owned 0755 and a validated 0440 rule that names only the helper", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(await readFile(join(root, HELPER), "utf8")).toBe("#!/bin/sh\n# the embedded helper\n");
		expect(await modeOf(HELPER)).toBe(0o755);
		expect(await modeOf("/usr/local/libexec/omp-cloud")).toBe(0o755);
		expect(await readFile(join(root, SUDOERS_FILE), "utf8")).toBe(`alice ALL=(root) NOPASSWD: ${HELPER}\n`);
		expect(await modeOf(SUDOERS_FILE)).toBe(0o440);
		expect(h.runner.lines()).toContain(`visudo -cf ${join(root, SUDOERS_FILE)}.tmp`);
		expect(await exists(`${SUDOERS_FILE}.tmp`)).toBe(false);
		const steps = h.report().steps;
		expect(steps.find((step) => step.id === "system.helper")?.status).toBe("changed");
		expect(steps.find((step) => step.id === "system.sudoers")?.status).toBe("changed");
	});

	test("the rule never mentions the omp-cloud binary", async () => {
		const h = host();
		await runSystem(["--user", "bob_2", "--no-linger"], h.deps);
		const rule = await readFile(join(root, SUDOERS_FILE), "utf8");
		expect(rule).toBe(`bob_2 ALL=(root) NOPASSWD: ${HELPER}\n`);
		expect(rule.match(/NOPASSWD/g)).toHaveLength(1);
		expect(rule).not.toContain("omp-cloud ");
	});

	test("a rule that fails visudo is removed, nothing is installed in its place and the run stops", async () => {
		const h = host({ respond: (argv) => (argv[0] === "visudo" ? { code: 1, stderr: "parse error in line 1\n" } : undefined) });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(await exists(SUDOERS_FILE)).toBe(false);
		expect(await exists(`${SUDOERS_FILE}.tmp`)).toBe(false);
		const last = h.report().steps.at(-1);
		expect(last).toMatchObject({ id: "system.sudoers", status: "failed" });
		expect(last?.detail).toContain("parse error");
		expect(h.runner.lines().some((line) => line.startsWith("/opt/vmon") || line.startsWith(HELPER))).toBe(false);
	});

	test("a failing visudo leaves an existing valid rule in place", async () => {
		await putFile(root, SUDOERS_FILE, `bob ALL=(root) NOPASSWD: ${HELPER}\n`, 0o440);
		const h = host({ respond: (argv) => (argv[0] === "visudo" ? { code: 1 } : undefined) });
		await runSystem(ARGS, h.deps);
		expect(await readFile(join(root, SUDOERS_FILE), "utf8")).toBe(`bob ALL=(root) NOPASSWD: ${HELPER}\n`);
	});

	test("a rerun changes neither file nor mode and does not call visudo again", async () => {
		const first = host();
		await runSystem(ARGS, first.deps);
		const again = host();
		await runSystem(ARGS, again.deps);
		expect(again.runner.lines().some((line) => line.startsWith("visudo"))).toBe(false);
		const steps = again.report().steps;
		expect(steps.find((step) => step.id === "system.helper")?.status).toBe("ok");
		expect(steps.find((step) => step.id === "system.sudoers")?.status).toBe("ok");
	});

	test("a changed helper is replaced and a drifted mode repaired; a rule for another user is replaced", async () => {
		await runSystem(ARGS, host().deps);
		await writeFile(join(root, HELPER), "tampered");
		await chmod(join(root, SUDOERS_FILE), 0o640);
		const h = host({ helperScript: "#!/bin/sh\n# v2\n" });
		await runSystem(["--user", "carol"], h.deps);
		expect(await readFile(join(root, HELPER), "utf8")).toBe("#!/bin/sh\n# v2\n");
		expect(await readFile(join(root, SUDOERS_FILE), "utf8")).toBe(`carol ALL=(root) NOPASSWD: ${HELPER}\n`);
		expect(await modeOf(SUDOERS_FILE)).toBe(0o440);
	});

	test("a helper directory that root does not own is a failed step", async () => {
		const h = host();
		h.deps.rootUid = (process.getuid?.() ?? 0) + 1;
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.helper", status: "failed" });
		expect(await exists(SUDOERS_FILE)).toBe(false);
	});
});

describe("runSystem: vibemon", () => {
	test("not installed: the helper runs with the pin as its only argument", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(h.runner.lines()).toContain(`${HELPER} v0.4.0`);
		expect(h.report().steps.find((step) => step.id === "system.vmon")).toMatchObject({ status: "changed", detail: "installed vibemon v0.4.0" });
	});

	test("installed at the pin: skipped, the helper does not run", async () => {
		await putFile(root, "/opt/vmon/vmon", "#!/bin/sh\n", 0o755);
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(h.runner.lines()).toContain("/opt/vmon/vmon --version");
		expect(h.runner.lines()).not.toContain(`${HELPER} v0.4.0`);
		expect(h.report().steps.find((step) => step.id === "system.vmon")).toMatchObject({ status: "ok" });
	});

	test("an older vibemon is upgraded through the helper", async () => {
		await putFile(root, "/opt/vmon/vmon", "#!/bin/sh\n", 0o755);
		const h = host({ respond: (argv) => (argv[1] === "--version" ? { stdout: "vmon 0.3.9\n" } : undefined) });
		await runSystem(ARGS, h.deps);
		expect(h.runner.lines()).toContain(`${HELPER} v0.4.0`);
		expect(h.report().steps.find((step) => step.id === "system.vmon")?.detail).toBe("installed vibemon v0.4.0 (was vmon 0.3.9)");
	});

	test("the helper's own error is the failure, and the run stops there", async () => {
		const h = host({ respond: (argv) => (argv[0] === HELPER ? { code: 1, stdout: '{"ok": false, "error": "refusing to downgrade"}\n' } : undefined) });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		const last = h.report().steps.at(-1);
		expect(last).toMatchObject({ id: "system.vmon", status: "failed" });
		expect(last?.detail).toContain("refusing to downgrade");
		expect(await exists("/etc/vmon/env")).toBe(false);
	});

	test("a helper that exits without a verdict is a failure naming its stderr", async () => {
		const h = host({ respond: (argv) => (argv[0] === HELPER ? { code: 1, stderr: "curl: (6) Could not resolve host\n" } : undefined) });
		await runSystem(ARGS, h.deps);
		expect(h.report().steps.at(-1)?.detail).toContain("Could not resolve host");
	});

	test("an ok verdict with a failing exit status is a failure", async () => {
		const h = host({ respond: (argv) => (argv[0] === HELPER ? { code: 1, stdout: HELPER_OK } : undefined) });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
	});
});

describe("runSystem: /etc/vmon/env", () => {
	test("is written once with two random secrets, 0600 in a 0700 directory", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		const text = await readFile(join(root, "/etc/vmon/env"), "utf8");
		expect(text).toBe(`VMON_CLUSTER_SECRET=${h.secrets[0]}\nVMON_ADMIN_TOKEN=${h.secrets[1]}\n`);
		expect(h.secrets).toHaveLength(2);
		expect(h.secrets[0]).not.toBe(h.secrets[1]);
		expect(await modeOf("/etc/vmon/env")).toBe(0o600);
		expect(await modeOf("/etc/vmon")).toBe(0o700);
	});

	test("is never rewritten: a rerun draws no new secret and keeps the file byte for byte", async () => {
		await runSystem(ARGS, host().deps);
		const before = await readFile(join(root, "/etc/vmon/env"), "utf8");
		const again = host();
		await runSystem(ARGS, again.deps);
		expect(again.secrets).toEqual([]);
		expect(await readFile(join(root, "/etc/vmon/env"), "utf8")).toBe(before);
		expect(again.report().steps.find((step) => step.id === "system.env")?.status).toBe("ok");
	});

	test("an existing file with its own content is kept, and its mode is repaired", async () => {
		await putFile(root, "/etc/vmon/env", "VMON_CLUSTER_SECRET=mine\nVMON_ADMIN_TOKEN=mine2\n", 0o644);
		const h = host({ teams: "" });
		await runSystem(ARGS, h.deps);
		expect(await readFile(join(root, "/etc/vmon/env"), "utf8")).toBe("VMON_CLUSTER_SECRET=mine\nVMON_ADMIN_TOKEN=mine2\n");
		expect(await modeOf("/etc/vmon/env")).toBe(0o600);
		expect(h.runner.calls.find((call) => call.argv[1] === "admin")?.options.env).toEqual({ VMON_CLUSTER_SECRET: "mine" });
	});

	test("an empty file is filled", async () => {
		await putFile(root, "/etc/vmon/env", "", 0o600);
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(h.secrets).toHaveLength(2);
	});

	test("a file without the cluster secret fails the team step instead of being overwritten", async () => {
		await putFile(root, "/etc/vmon/env", "VMON_ADMIN_TOKEN=x\n", 0o600);
		const h = host();
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.team", status: "failed" });
		expect(await readFile(join(root, "/etc/vmon/env"), "utf8")).toBe("VMON_ADMIN_TOKEN=x\n");
	});
});

describe("runSystem: units, health and the team", () => {
	test("installs both units in /etc/systemd/system and reports the net pool", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(await exists("/etc/systemd/system/omp-cloud-net.service")).toBe(true);
		expect(await readFile(join(root, "/etc/systemd/system/vmon.service"), "utf8")).toContain("--net-pool 172.20.0.0/16");
		expect(h.report().netPool).toBe("172.20.0.0/16");
		expect(h.runner.lines()).toContain("systemctl enable --now vmon.service");
	});

	test("the net pool falls back when 172.20.0.0/16 overlaps a host route", async () => {
		const h = host({ respond: (argv) => (argv[0] === "ip" ? { stdout: "172.20.0.0/24 dev eth0 scope link\n" } : undefined) });
		await runSystem(ARGS, h.deps);
		expect(h.report().netPool).toBe("172.29.0.0/16");
	});

	test("the order: packages, helper, vmon, env, units, health, team, linger", async () => {
		const h = host();
		await runSystem([...ARGS, "--packages", "curl"], h.deps);
		const ids = h.report().steps.map((step) => step.id);
		const order = ["system.packages", "system.user", "system.helper", "system.sudoers", "system.vmon", "system.env", "system.unit.omp-cloud-net", "system.unit.vmon", "system.health", "system.team", "system.team.key", "system.team.limits", "system.linger"];
		expect(ids).toEqual(order);
	});

	test("an unhealthy vmon fails after 60 s of waiting and the team step never runs", async () => {
		let sleptMs = 0;
		const h = host();
		h.deps.vmonHealth = async () => 503;
		h.deps.sleep = async (ms) => void (sleptMs += ms);
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(sleptMs).toBe(60_000);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.health", status: "failed", fix: "journalctl -u vmon -n 50 --no-pager" });
		expect(h.runner.calls.some((call) => call.argv[1] === "admin")).toBe(false);
	});

	test("vmon that turns healthy after a while is accepted", async () => {
		const h = host();
		let polls = 0;
		h.deps.vmonHealth = async () => (++polls < 5 ? 0 : 204);
		expect(await runSystem(ARGS, h.deps)).toBe(0);
		expect(polls).toBe(5);
		expect(h.report().steps.find((step) => step.id === "system.health")).toMatchObject({ status: "changed", detail: expect.stringContaining("after 4 s") });
	});

	test("a missing team is created with the default limits, its key reported once and the team marked created", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		const report = h.report();
		expect(report.team).toEqual({ slug: "omp-cloud", created: true });
		expect(report.key).toBe(KEY);
		const create = h.runner.lines().find((line) => line.includes(" create-team "));
		expect(create).toContain("create-team omp-cloud --max-concurrent-sandboxes 32 --max-concurrent-builds 4 --max-vcpus 8 --max-memory-mb 8192 --max-disk-mb 20480 --max-length-hours 24");
		expect(h.human.join("")).not.toContain(KEY);
		expect(JSON.stringify(report.steps)).not.toContain("e2b_");
	});

	test("an existing team is not duplicated, gets no key and has its limits re-applied", async () => {
		const h = host({ teams: `9f1d\tomp-cloud\tomp-cloud\t${COUNTS}\n` });
		await runSystem([...ARGS, "--max-sandboxes", "5"], h.deps);
		const report = h.report();
		expect(report.team).toEqual({ slug: "omp-cloud", created: false });
		expect(report).not.toHaveProperty("key");
		expect(h.runner.lines().some((line) => line.includes(" create-team "))).toBe(false);
		expect(h.runner.lines().find((line) => line.includes(" set-limits "))).toContain("set-limits omp-cloud --max-concurrent-sandboxes 5");
	});

	test("--mint-key mints a key for the existing team", async () => {
		const h = host({ teams: `9f1d\tomp-cloud\tomp-cloud\t${COUNTS}\n` });
		await runSystem([...ARGS, "--mint-key"], h.deps);
		expect(h.report().key).toBe(OTHER_KEY);
		expect(h.report().team.created).toBe(false);
	});

	test("--migrate-team creates the standard team (or mints for it) and reports a key", async () => {
		const created = host({ teams: `0b3c\tacme\tacme\t${COUNTS}\n` });
		await runSystem([...ARGS, "--migrate-team", "--team", "omp-cloud"], created.deps);
		expect(created.report()).toMatchObject({ team: { slug: "omp-cloud", created: true }, key: KEY });
		const existing = host({ teams: `9f1d\tomp-cloud\tomp-cloud\t${COUNTS}\n` });
		await runSystem([...ARGS, "--migrate-team"], existing.deps);
		expect(existing.report()).toMatchObject({ team: { slug: "omp-cloud", created: false }, key: OTHER_KEY });
	});

	test("--team picks another slug", async () => {
		const h = host();
		await runSystem([...ARGS, "--team", "homelab"], h.deps);
		expect(h.report().team).toEqual({ slug: "homelab", created: true });
		expect(h.runner.lines().some((line) => line.includes("create-team homelab"))).toBe(true);
	});

	test("the cluster secret reaches vmon admin only through the environment", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		const admin = h.runner.calls.filter((call) => call.argv[1] === "admin");
		expect(admin.length).toBeGreaterThan(0);
		for (const call of admin) {
			expect(call.options.env).toEqual({ VMON_CLUSTER_SECRET: h.secrets[0] ?? "" });
			expect(call.argv.join(" ")).not.toContain(h.secrets[0] ?? "x");
		}
	});

	test("a team failure still reports the key that was minted", async () => {
		const h = host({ respond: (argv) => (argv[4] === "set-limits" ? { code: 1, stderr: "vmon: error: bad" } : undefined) });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(h.report()).toMatchObject({ ok: false, key: KEY });
	});
});

describe("runSystem: linger", () => {
	test("is enabled for the user and recorded as enabled by setup", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(h.runner.lines()).toContain("loginctl enable-linger alice");
		expect(JSON.parse(await readFile(join(root, SETUP_RECORD), "utf8"))).toEqual({ linger: { user: "alice", enabledBySetup: true } });
		expect(await modeOf(SETUP_RECORD)).toBe(0o644);
		expect(h.report().linger).toBe(true);
	});

	test("a rerun with linger on does nothing and keeps the record", async () => {
		await runSystem(ARGS, host().deps);
		await putFile(root, "/var/lib/systemd/linger/alice", "");
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(h.runner.lines().some((line) => line.startsWith("loginctl"))).toBe(false);
		expect(JSON.parse(await readFile(join(root, SETUP_RECORD), "utf8")).linger.enabledBySetup).toBe(true);
		expect(h.report()).toMatchObject({ linger: true });
		expect(h.report().steps.find((step) => step.id === "system.linger")?.status).toBe("ok");
	});

	test("linger the user already had is not claimed: no record is written", async () => {
		await putFile(root, "/var/lib/systemd/linger/alice", "");
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(await exists(SETUP_RECORD)).toBe(false);
		expect(h.report().linger).toBe(true);
	});

	test("--no-linger leaves it alone", async () => {
		const h = host();
		await runSystem([...ARGS, "--no-linger"], h.deps);
		expect(h.runner.lines().some((line) => line.startsWith("loginctl"))).toBe(false);
		expect(h.report()).toMatchObject({ linger: false, ok: true });
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.linger", status: "skipped" });
	});

	test("a failing loginctl is a failed step with the command to run", async () => {
		const h = host({ respond: (argv) => (argv[0] === "loginctl" ? { code: 1, stderr: "Access denied" } : undefined) });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(h.report()).toMatchObject({ ok: false, linger: false });
		expect(h.report().steps.at(-1)).toMatchObject({ status: "failed", fix: "sudo loginctl enable-linger alice" });
	});
});

describe("runSystem: uninstall", () => {
	async function installed(): Promise<void> {
		await runSystem(ARGS, host().deps);
		await putFile(root, "/var/lib/systemd/linger/alice", "");
		await putFile(root, "/opt/vmon/vmon", "#!/bin/sh\n", 0o755);
		await putFile(root, "/opt/vmon.prev/vmon", "x");
		await putFile(root, "/opt/.vmon-install.lock", "");
		await putFile(root, "/opt/.vmon-install.AbC123/x", "x");
		await putFile(root, "/opt/other/file", "keep");
		await putFile(root, "/var/lib/vmon/raft/x", "x");
	}

	test("removes the units, the helper and the rule, undoes the linger setup enabled, and keeps vmon and its data", async () => {
		await installed();
		const h = host();
		expect(await runSystem(["--uninstall"], h.deps)).toBe(0);
		expect(h.runner.lines()).toContain("systemctl disable --now vmon.service omp-cloud-net.service");
		expect(h.runner.lines()).toContain("loginctl disable-linger alice");
		for (const path of ["/etc/systemd/system/vmon.service", "/etc/systemd/system/omp-cloud-net.service", SUDOERS_FILE, HELPER]) expect(await exists(path)).toBe(false);
		for (const path of ["/opt/vmon/vmon", "/opt/vmon.prev/vmon", "/etc/vmon/env", "/var/lib/vmon/raft/x", SETUP_RECORD]) expect(await exists(path)).toBe(true);
		expect(JSON.parse(await readFile(join(root, SETUP_RECORD), "utf8"))).toEqual({ linger: { user: "alice", enabledBySetup: false } });
	});

	test("linger the user had before setup is left on", async () => {
		await putFile(root, "/var/lib/systemd/linger/alice", "");
		await runSystem(ARGS, host().deps);
		const h = host();
		await runSystem(["--uninstall", "--user", "alice"], h.deps);
		expect(h.runner.lines().some((line) => line.startsWith("loginctl"))).toBe(false);
		expect(h.report().steps.find((step) => step.id === "system.uninstall.linger")?.status).toBe("skipped");
		expect(h.report().linger).toBe(true);
	});

	test("--purge also removes vmon, its data, the lock and the setup record, and nothing else", async () => {
		await installed();
		const h = host();
		expect(await runSystem(["--uninstall", "--purge"], h.deps)).toBe(0);
		for (const path of ["/opt/vmon", "/opt/vmon.prev", "/etc/vmon", "/var/lib/vmon", "/etc/omp-cloud", "/opt/.vmon-install.lock", "/opt/.vmon-install.AbC123"]) expect(await exists(path)).toBe(false);
		expect(await exists("/opt/other/file")).toBe(true);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.uninstall.purge", status: "changed" });
	});

	test("uninstall of a host that never had setup is a clean no-op", async () => {
		const h = host({ respond: (argv) => (argv[1] === "is-active" ? { code: 3 } : argv[2] === "ompsvc0" ? { code: 1 } : undefined) });
		expect(await runSystem(["--uninstall", "--purge"], h.deps)).toBe(0);
		expect(h.report().ok).toBe(true);
	});

	test("a linger that cannot be undone keeps the record, the vmon files and says so", async () => {
		await installed();
		const h = host({ respond: (argv) => (argv[1] === "disable-linger" ? { code: 1, stderr: "denied" } : undefined) });
		expect(await runSystem(["--uninstall", "--purge"], h.deps)).toBe(1);
		expect(await exists(SETUP_RECORD)).toBe(true);
		expect(await exists("/opt/vmon/vmon")).toBe(true);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.uninstall.purge", status: "skipped" });
	});

	test("a unit that will not disable stops the uninstall before the rule and helper are removed", async () => {
		await installed();
		const h = host({ respond: (argv) => (argv[1] === "disable" ? { code: 1, stderr: "busy" } : undefined) });
		expect(await runSystem(["--uninstall"], h.deps)).toBe(1);
		expect(await exists(SUDOERS_FILE)).toBe(true);
		expect(await exists(HELPER)).toBe(true);
	});
});

describe("the report", () => {
	test("is the only stdout line, round-trips through parseSystemReport, and the human lines go elsewhere", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(h.stdout).toHaveLength(1);
		expect(h.stdout[0]?.endsWith("\n")).toBe(true);
		const report = h.report();
		expect(JSON.parse(h.stdout[0] ?? "")).toEqual(report);
		expect(report).toEqual({ ok: true, steps: h.deps.reporter.steps, team: { slug: "omp-cloud", created: true }, key: KEY, netPool: "172.20.0.0/16", linger: true });
		expect(h.human.join("")).toContain("✓ system.vmon");
		expect(h.human.join("")).not.toContain('"ok"');
	});

	test("a rerun on a finished host reports · for everything and no key", async () => {
		await runSystem(ARGS, host().deps);
		await putFile(root, "/var/lib/systemd/linger/alice", "");
		await putFile(root, "/opt/vmon/vmon", "#!/bin/sh\n", 0o755);
		const again = host({
			teams: `9f1d\tomp-cloud\tomp-cloud\t${COUNTS}\n`,
			respond: (argv) => (argv[1] === "is-enabled" || argv[1] === "is-active" ? { code: 0 } : undefined),
		});
		expect(await runSystem(ARGS, again.deps)).toBe(0);
		const report = again.report();
		expect(report.steps.filter((step) => step.status === "changed")).toEqual([]);
		expect(report).not.toHaveProperty("key");
		expect(report.team.created).toBe(false);
	});

	test("parseSystemReport accepts a failure report and rejects anything malformed", () => {
		const good: SystemReport = { ok: false, steps: [{ id: "a", status: "failed", detail: "x", fix: "y" }], team: { slug: "t", created: false }, netPool: "", linger: false };
		expect(parseSystemReport(JSON.stringify(good))).toEqual(good);
		const bad: unknown[] = [
			{ ...good, ok: "yes" },
			{ ...good, steps: [{ id: "a", status: "weird", detail: "x" }] },
			{ ...good, steps: "no" },
			{ ...good, team: { slug: 1, created: true } },
			{ ...good, key: 5 },
			{ ...good, netPool: undefined },
			{ ...good, linger: "on" },
			[],
			null,
		];
		for (const value of bad) expect(() => parseSystemReport(JSON.stringify(value))).toThrow();
		expect(() => parseSystemReport("progress: not json")).toThrow("not JSON");
		expect(() => parseSystemReport("")).toThrow();
	});
});

describe("systemChecks", () => {
	const healthy = (argv: readonly string[]): Partial<CommandResult> | undefined => {
		if (argv[0] === "ip") return { stdout: "7: ompsvc0    inet 10.254.254.1/32 scope global ompsvc0\n" };
		if (argv[0] === "curl") return { stdout: "204" };
		return undefined;
	};

	test("a healthy host is all ok", async () => {
		await putFile(root, "/var/lib/systemd/linger/alice", "");
		const runner = fakeRunner(healthy);
		const steps = await systemChecks(runner.run, { root, user: "alice" });
		expect(steps.map((step) => [step.id, step.status])).toEqual([
			["system.check.omp-cloud-net", "ok"],
			["system.check.vmon", "ok"],
			["system.check.link", "ok"],
			["system.check.health", "ok"],
			["system.check.helper", "ok"],
			["system.check.linger", "ok"],
		]);
		expect(runner.lines()).toContain(`sudo -n -l ${HELPER}`);
	});

	test("every failure has a fix; linger off is skipped, not failed", async () => {
		const runner = fakeRunner((argv) => (argv[0] === "systemctl" ? { code: 3 } : argv[0] === "curl" ? { stdout: "000", code: 7 } : { code: 1 }));
		const steps = await systemChecks(runner.run, { root, user: "alice" });
		expect(steps.filter((step) => step.status === "failed").length).toBe(5);
		expect(steps.filter((step) => step.status === "failed").every((step) => step.fix !== undefined)).toBe(true);
		expect(steps.at(-1)).toMatchObject({ id: "system.check.linger", status: "skipped", fix: "sudo loginctl enable-linger alice" });
		expect(steps[0]?.detail).toBe("omp-cloud-net.service is not enabled and not active");
	});

	test("a command that cannot start is a failed check, not an exception", async () => {
		const runner = fakeRunner();
		const throwing: typeof runner.run = async () => {
			throw new Error("spawn ENOENT");
		};
		const steps = await systemChecks(throwing, { root, user: "alice" });
		expect(steps.some((step) => step.status === "failed")).toBe(true);
	});

	test("it changes nothing: every command is a read", async () => {
		const runner = fakeRunner(healthy);
		await systemChecks(runner.run, { root, user: "alice" });
		for (const line of runner.lines()) expect(line).toMatch(/^(systemctl is-(enabled|active) |ip -o -4 addr show |curl |sudo -n -l )/);
		await mkdir(root, { recursive: true });
	});
});
