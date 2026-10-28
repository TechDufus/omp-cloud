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
import { renderVmonUnit } from "./system-units";

const HELPER = "/usr/local/libexec/omp-cloud/vmon-install";
const KEY = `e2b_${"ab12".repeat(10)}`;
const OTHER_KEY = `e2b_${"cd34".repeat(10)}`;
const CREATED = `team    omp-cloud (9f1d)\nslug    omp-cloud\napi key ${KEY}\n`;
const EXISTING = "team    omp-cloud (9f1d)\nslug    omp-cloud\n";
const DELETED = "deleted team acme (0b3c)\nkilled sandboxes=1 cancelled builds=0\nremoved templates=2 volumes=0 secrets=0 webhooks=0 api keys=1\n";
const HELPER_OK = 'downloading\n{"ok": true, "version": "v0.4.0"}\n';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-cloud-system-"));
	// The umask masks the mode writeFile gets: /dev/kvm must be read-write for everyone unless a test says otherwise.
	await putFile(root, "/dev/kvm", "", 0o666);
	await chmod(join(root, "/dev/kvm"), 0o666);
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
	/** Slugs of teams that already exist in vmon. */
	teams?: string[];
	/** The system user omp-cloud-vmm exists before the run. */
	vmmUserExists?: boolean;
	/** Its uid as `id -u` prints it. */
	vmmUid?: string;
	/** What `getent group kvm` prints; "" for no such group. */
	kvmGroup?: string;
}

/** A fresh host whose every command works: no units, vmon missing (the helper installs it), the team not yet created. */
function host(options: HostOptions = {}): Host {
	const human: string[] = [];
	const stdout: string[] = [];
	const secrets: string[] = [];
	let vmmUserExists = options.vmmUserExists === true;
	const runner = fakeRunner((argv) => {
		const custom = options.respond?.(argv);
		if (custom !== undefined) return custom;
		if (argv[0] === "getent") return options.kvmGroup === "" ? { code: 2 } : { stdout: options.kvmGroup ?? "kvm:x:990:\n" };
		if (argv[0] === "id" && argv[2] === "omp-cloud-vmm") return vmmUserExists ? { stdout: `${options.vmmUid ?? "961"}\n` } : { code: 1 };
		if (argv[0] === "useradd") {
			vmmUserExists = true;
			return {};
		}
		if (argv[0] === "userdel") {
			vmmUserExists = false;
			return {};
		}
		const verb = argv[0] === "/opt/vmon/vmon" ? argv[4] : argv[1];
		if (argv[0] === "ip") return { stdout: "default via 192.168.1.1 dev eth0\n192.168.1.0/24 dev eth0 scope link\n" };
		if (argv[0] === HELPER) return { stdout: HELPER_OK };
		if (argv[0] === "/opt/vmon/vmon" && argv[1] === "--version") return { stdout: "vmon 0.4.0\n" };
		if (argv[0] === "/opt/vmon/vmon") {
			if (verb === "create-team") {
				const slug = argv[5] ?? "";
				return { stdout: (options.teams ?? []).includes(slug) ? EXISTING : CREATED };
			}
			if (verb === "create-api-key") return { stdout: `${OTHER_KEY}\n` };
			if (verb === "delete-team") return { stdout: DELETED };
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
		syncScript: "#!/bin/sh\n# the embedded sync script\n",
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
			args: { user: "alice", team: "omp-cloud", maxSandboxes: 32, packages: [], mintKey: false, noLinger: false, migrateFrom: null, uninstall: false, purge: false, clusterAddress: null, node: null },
		});
		expect(parseSystemArgs(["--user=alice", "--team", "my-team", "--max-sandboxes=1000", "--packages", "curl,git,curl", "--mint-key", "--no-linger", "--migrate-team", "acme"])).toEqual({
			ok: true,
			args: { user: "alice", team: "my-team", maxSandboxes: 1000, packages: ["curl", "git"], mintKey: true, noLinger: true, migrateFrom: "acme", uninstall: false, purge: false, clusterAddress: null, node: null },
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
		["--migrate-team without a value", [...ARGS, "--migrate-team"]],
		["--migrate-team followed by a flag", [...ARGS, "--migrate-team", "--mint-key"]],
		["--migrate-team of the reserved team system", [...ARGS, "--migrate-team", "system"]],
		["--migrate-team of the --team value", [...ARGS, "--team", "acme", "--migrate-team", "acme"]],
		["--migrate-team of the default team when --team is absent", [...ARGS, "--migrate-team", "omp-cloud"]],
		["--migrate-team with a capital", [...ARGS, "--migrate-team", "Acme"]],
		["--uninstall with --migrate-team", ["--uninstall", "--migrate-team", "acme"]],
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
		expect(await readdir(root)).toEqual(["dev"]);
	});

	test("not root: exit 1, nothing runs, nothing is written", async () => {
		const h = host({ euid: 1000 });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(h.runner.calls).toEqual([]);
		expect(h.report()).toMatchObject({ ok: false, steps: [{ id: "system.root", status: "failed" }] });
		expect(await readdir(root)).toEqual(["dev"]);
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
		const h = host();
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
		const order = ["system.packages", "system.user", "system.helper", "system.sudoers", "system.vmon", "system.env", "system.vmm-user", "system.unit.omp-cloud-net", "system.unit.vmon", "system.health", "system.team", "system.team.key", "system.team.limits", "system.linger"];
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
		expect(create).toContain("create-team omp-cloud --if-missing --max-concurrent-sandboxes 32 --max-concurrent-builds 4 --max-vcpus 8 --max-memory-mb 8192 --max-disk-mb 20480 --max-length-hours 24");
		expect(h.human.join("")).not.toContain(KEY);
		expect(JSON.stringify(report.steps)).not.toContain("e2b_");
	});

	test("an existing team is not recreated, gets no key and has its limits re-applied", async () => {
		const h = host({ teams: ["omp-cloud"] });
		await runSystem([...ARGS, "--max-sandboxes", "5"], h.deps);
		const report = h.report();
		expect(report.team).toEqual({ slug: "omp-cloud", created: false });
		expect(report).not.toHaveProperty("key");
		expect(h.runner.lines().find((line) => line.includes(" create-team "))).toContain("create-team omp-cloud --if-missing --max-concurrent-sandboxes 5");
		expect(h.runner.lines().some((line) => line.includes(" create-api-key "))).toBe(false);
		expect(h.runner.lines().find((line) => line.includes(" set-limits "))).toContain("set-limits omp-cloud --max-concurrent-sandboxes 5");
	});

	test("--mint-key mints a key for the existing team", async () => {
		const h = host({ teams: ["omp-cloud"] });
		await runSystem([...ARGS, "--mint-key"], h.deps);
		expect(h.report().key).toBe(OTHER_KEY);
		expect(h.report().team?.created).toBe(false);
	});

	test("--migrate-team acme creates the new team with a key, then deletes acme before linger", async () => {
		const h = host();
		expect(await runSystem([...ARGS, "--migrate-team", "acme", "--team", "omp-cloud"], h.deps)).toBe(0);
		const report = h.report();
		expect(report).toMatchObject({ ok: true, team: { slug: "omp-cloud", created: true }, key: KEY });
		const verbs = h.runner.calls.filter((call) => call.argv[1] === "admin" || call.argv[0] === "loginctl").map((call) => call.argv.slice(4).join(" ").replace(/ --max-.*$/, "") || call.argv[0]);
		expect(verbs).toEqual(["create-team omp-cloud --if-missing", "set-limits omp-cloud", "delete-team acme --force", "loginctl"]);
		expect(report.steps.find((step) => step.id === "system.team.old")).toMatchObject({ status: "changed", detail: expect.stringContaining("deleted the old vmon team acme") });
		expect(JSON.stringify(report.steps)).not.toContain("e2b_");
	});

	test("--migrate-team mints a key for the target team when it already exists, then deletes the old one", async () => {
		const h = host({ teams: ["omp-cloud"] });
		await runSystem([...ARGS, "--migrate-team", "acme"], h.deps);
		expect(h.report()).toMatchObject({ ok: true, team: { slug: "omp-cloud", created: false }, key: OTHER_KEY });
		expect(h.runner.lines().filter((line) => line.includes(" admin ")).map((line) => line.split(" ")[5])).toEqual(["omp-cloud", "omp-cloud", "omp-cloud", "acme"]);
		expect(h.runner.lines().some((line) => line.includes(" create-api-key omp-cloud"))).toBe(true);
	});

	test("a failing delete-team keeps the old team: skipped with a fix that has no secret, and the report stays ok", async () => {
		const h = host({ respond: (argv) => (argv[4] === "delete-team" ? { code: 1, stderr: "vmon: error: build cancel timed out\n" } : undefined) });
		expect(await runSystem([...ARGS, "--migrate-team", "acme"], h.deps)).toBe(0);
		const report = h.report();
		expect(report.ok).toBe(true);
		const old = report.steps.find((step) => step.id === "system.team.old");
		expect(old).toMatchObject({ status: "skipped", detail: expect.stringContaining("kept the old vmon team acme") });
		expect(old?.fix).toContain("delete-team acme --force");
		expect(`${old?.detail}${old?.fix}`).not.toContain(h.secrets[0] ?? "no secret");
		expect(report.team).toEqual({ slug: "omp-cloud", created: true });
	});

	test("--migrate-team of a team that is already gone is ok", async () => {
		const h = host({ respond: (argv) => (argv[4] === "delete-team" ? { code: 1, stderr: "vmon: error: team acme not found\n" } : undefined) });
		expect(await runSystem([...ARGS, "--migrate-team", "acme"], h.deps)).toBe(0);
		expect(h.report().steps.find((step) => step.id === "system.team.old")).toMatchObject({ status: "ok" });
	});

	test("a failed team step never deletes the old team", async () => {
		const h = host({ respond: (argv) => (argv[4] === "create-team" ? { code: 1, stderr: "vmon: error: boom\n" } : undefined) });
		expect(await runSystem([...ARGS, "--migrate-team", "acme"], h.deps)).toBe(1);
		expect(h.runner.lines().some((line) => line.includes(" delete-team "))).toBe(false);
	});

	test("without --migrate-team nothing is deleted", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(h.runner.lines().some((line) => line.includes(" delete-team "))).toBe(false);
		expect(h.report().steps.some((step) => step.id === "system.team.old")).toBe(false);
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

describe("runSystem: the VMM user", () => {
	const vmonUnit = () => readFile(join(root, "/etc/systemd/system/vmon.service"), "utf8");
	const USERADD = ["useradd", "--system", "--gid", "kvm", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "--comment", "omp-cloud vibemon VMMs", "omp-cloud-vmm"];
	const step = (h: Host) => h.report().steps.find((candidate) => candidate.id === "system.vmm-user");

	test("a fresh host gets the user in the group kvm, and the unit drops the VMMs to its uid and the group's gid", async () => {
		const h = host();
		expect(await runSystem(ARGS, h.deps)).toBe(0);
		expect(h.runner.calls.find((call) => call.argv[0] === "useradd")?.argv).toEqual(USERADD);
		expect(await vmonUnit()).toContain("--net-pool 172.20.0.0/16 --vmm-user 961:990");
		expect(step(h)).toEqual({ id: "system.vmm-user", status: "changed", detail: "created the system user omp-cloud-vmm: vibemon's VMMs run as 961:990 (group kvm)" });
	});

	test("an existing user is kept: no useradd, ok", async () => {
		const h = host({ vmmUserExists: true, vmmUid: "444" });
		expect(await runSystem(ARGS, h.deps)).toBe(0);
		expect(h.runner.lines().some((line) => line.startsWith("useradd"))).toBe(false);
		expect(step(h)).toEqual({ id: "system.vmm-user", status: "ok", detail: "vibemon's VMMs run as omp-cloud-vmm (444:990, group kvm)" });
		expect(await vmonUnit()).toContain("--vmm-user 444:990");
	});

	test("a host without the group kvm fails before any user or unit exists", async () => {
		const h = host({ kvmGroup: "" });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(h.report().steps.at(-1)).toMatchObject({
			id: "system.vmm-user",
			status: "failed",
			detail: "this host has no kvm group, which vibemon's VMMs need to open /dev/kvm without root",
			fix: "give /dev/kvm to the group kvm with read and write for it (the systemd-udev default), then run omp-cloud setup again",
		});
		expect(h.runner.lines().some((line) => line.startsWith("useradd"))).toBe(false);
		expect(await exists("/etc/systemd/system/vmon.service")).toBe(false);
	});

	test("a group entry without a numeric gid is no kvm group", async () => {
		for (const kvmGroup of ["kvm:x::\n", "kvm:x:abc:\n", "kvm:x:0:\n", "\n"]) {
			const h = host({ kvmGroup });
			expect(await runSystem(ARGS, h.deps)).toBe(1);
			expect(step(h)).toMatchObject({ status: "failed", detail: expect.stringContaining("no kvm group") });
		}
	});

	test("a /dev/kvm that the kvm group cannot read and write is a failed step, and setup never changes its mode", async () => {
		for (const mode of [0o600, 0o640, 0o660, 0o644]) {
			await chmod(join(root, "/dev/kvm"), mode);
			// the group of the file is the test user's own group, never gid 990
			const h = host();
			expect(await runSystem(ARGS, h.deps)).toBe(1);
			expect(step(h)).toMatchObject({ status: "failed", detail: expect.stringContaining(`does not let the kvm group read and write it`), fix: "give /dev/kvm to the group kvm with read and write for it (the systemd-udev default), then run omp-cloud setup again" });
			expect(step(h)?.detail).toContain(`mode ${mode.toString(8)}`);
			expect(await modeOf("/dev/kvm")).toBe(mode);
			expect(h.runner.lines().some((line) => line.startsWith("useradd"))).toBe(false);
		}
	});

	test("read-write for the group kvm is enough, whatever the others get", async () => {
		await chmod(join(root, "/dev/kvm"), 0o660);
		const h = host({ kvmGroup: `kvm:x:${process.getgid?.() ?? 0}:\n` });
		expect(await runSystem(ARGS, h.deps)).toBe(0);
		expect(step(h)).toMatchObject({ status: "changed" });
	});

	test("a missing /dev/kvm is a failed step", async () => {
		await rm(join(root, "/dev/kvm"));
		const h = host();
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(step(h)).toMatchObject({ status: "failed", detail: "/dev/kvm is missing" });
	});

	test("a user that cannot be created fails with useradd's last stderr line", async () => {
		const h = host({ respond: (argv) => (argv[0] === "useradd" ? { code: 9, stderr: "useradd: group kvm does not exist\n" } : undefined) });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(step(h)).toMatchObject({ status: "failed", detail: "useradd omp-cloud-vmm failed: useradd: group kvm does not exist" });
		expect(await exists("/etc/systemd/system/vmon.service")).toBe(false);
	});

	test("a user whose uid is 0 is refused: the VMMs must not run as root", async () => {
		const h = host({ vmmUserExists: true, vmmUid: "0" });
		expect(await runSystem(ARGS, h.deps)).toBe(1);
		expect(step(h)).toMatchObject({ status: "failed", detail: "omp-cloud-vmm has uid 0: vibemon's VMMs must not run as root", fix: "sudo userdel omp-cloud-vmm, then omp-cloud setup again" });
		expect(await exists("/etc/systemd/system/vmon.service")).toBe(false);
	});

	test("a running vmon whose unit lacks --vmm-user is restarted, and the step says why", async () => {
		await putFile(root, "/etc/systemd/system/vmon.service", renderVmonUnit("172.20.0.0/16", { uid: 961, gid: 990 }).replace(" --vmm-user 961:990", ""));
		const h = host({ vmmUserExists: true, respond: (argv) => (argv[1] === "is-active" || argv[1] === "is-enabled" ? { code: 0 } : undefined) });
		expect(await runSystem(ARGS, h.deps)).toBe(0);
		expect(h.runner.lines()).toContain("systemctl restart vmon.service");
		expect(h.report().steps.find((candidate) => candidate.id === "system.unit.vmon")?.detail).toContain("so its VMMs run as omp-cloud-vmm (961:990)");
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

	test("--purge removes the system user omp-cloud-vmm with userdel --force; a plain uninstall keeps it", async () => {
		await installed();
		const plain = host({ vmmUserExists: true });
		expect(await runSystem(["--uninstall"], plain.deps)).toBe(0);
		expect(plain.runner.lines().some((line) => line.startsWith("userdel"))).toBe(false);
		expect(plain.report().steps.some((candidate) => candidate.id === "system.uninstall.vmm-user")).toBe(false);

		const purge = host({ vmmUserExists: true });
		expect(await runSystem(["--uninstall", "--purge"], purge.deps)).toBe(0);
		expect(purge.runner.lines()).toContain("userdel --force omp-cloud-vmm");
		expect(purge.report().steps.at(-1)).toEqual({ id: "system.uninstall.vmm-user", status: "changed", detail: "removed the system user omp-cloud-vmm" });
	});

	test("--purge on a host without the user runs no userdel and reports no step for it", async () => {
		await installed();
		const h = host();
		expect(await runSystem(["--uninstall", "--purge"], h.deps)).toBe(0);
		expect(h.runner.lines().some((line) => line.startsWith("userdel"))).toBe(false);
		expect(h.report().steps.some((candidate) => candidate.id === "system.uninstall.vmm-user")).toBe(false);
	});

	test("a userdel that fails is a failed step with the command to run", async () => {
		await installed();
		const h = host({ vmmUserExists: true, respond: (argv) => (argv[0] === "userdel" ? { code: 8, stderr: "userdel: user omp-cloud-vmm is currently used by process 41\n" } : undefined) });
		expect(await runSystem(["--uninstall", "--purge"], h.deps)).toBe(1);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.uninstall.vmm-user", status: "failed", fix: "sudo userdel --force omp-cloud-vmm" });
		expect(h.report().steps.at(-1)?.detail).toContain("currently used by process 41");
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
		expect(report).toEqual({ ok: true, steps: h.deps.reporter.steps, team: { slug: "omp-cloud", created: true }, key: KEY, adminToken: h.secrets[1], netPool: "172.20.0.0/16", linger: true });
		expect(h.human.join("")).toContain("✓ system.vmon");
		expect(h.human.join("")).not.toContain('"ok"');
	});

	test("carries the vibemon admin token of /etc/vmon/env, and no step or human line shows it", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		const token = h.secrets[1] ?? "";
		expect(token).not.toBe("");
		expect(h.report().adminToken).toBe(token);
		expect(h.report()).not.toHaveProperty("clusterSecret");
		expect(JSON.stringify(h.deps.reporter.steps)).not.toContain(token);
		expect(h.human.join("")).not.toContain(token);
		expect(h.runner.calls.map((call) => call.argv.join(" ")).join("\n")).not.toContain(token);
	});

	test("an existing env file's admin token is reported; a file without one reports none", async () => {
		await putFile(root, "/etc/vmon/env", "VMON_CLUSTER_SECRET=mine\nexport VMON_ADMIN_TOKEN='kept-token'\n", 0o600);
		const kept = host();
		await runSystem(ARGS, kept.deps);
		expect(kept.report().adminToken).toBe("kept-token");
		await putFile(root, "/etc/vmon/env", "VMON_CLUSTER_SECRET=mine\n", 0o600);
		const none = host();
		await runSystem(ARGS, none.deps);
		expect(none.report()).not.toHaveProperty("adminToken");
	});

	test("a rerun on a finished host reports · for everything and no key", async () => {
		await runSystem(ARGS, host().deps);
		await putFile(root, "/var/lib/systemd/linger/alice", "");
		await putFile(root, "/opt/vmon/vmon", "#!/bin/sh\n", 0o755);
		const again = host({
			vmmUserExists: true,
			teams: ["omp-cloud"],
			respond: (argv) => (argv[1] === "is-enabled" || argv[1] === "is-active" ? { code: 0 } : undefined),
		});
		expect(await runSystem(ARGS, again.deps)).toBe(0);
		const report = again.report();
		expect(report.steps.filter((step) => step.status === "changed")).toEqual([]);
		expect(report).not.toHaveProperty("key");
		expect(report.team?.created).toBe(false);
	});

	test("parseSystemReport accepts a failure report and rejects anything malformed", () => {
		const good: SystemReport = { ok: false, steps: [{ id: "a", status: "failed", detail: "x", fix: "y" }], team: { slug: "t", created: false }, netPool: "", linger: false };
		const secrets: SystemReport = { ...good, adminToken: "a".repeat(256), clusterSecret: "s3cret" };
		expect(parseSystemReport(JSON.stringify(secrets))).toEqual(secrets);
		expect(parseSystemReport(JSON.stringify({ ...good, team: null }))).toEqual({ ...good, team: null });
		expect(() => parseSystemReport(JSON.stringify({ ...good, team: "t" }))).toThrow("malformed team");
		expect(parseSystemReport(JSON.stringify(good))).toEqual(good);
		const bad: unknown[] = [
			{ ...good, ok: "yes" },
			{ ...good, steps: [{ id: "a", status: "weird", detail: "x" }] },
			{ ...good, steps: "no" },
			{ ...good, team: { slug: 1, created: true } },
			{ ...good, key: 5 },
			{ ...good, netPool: undefined },
			{ ...good, linger: "on" },
			{ ...good, adminToken: "" },
			{ ...good, adminToken: "has space" },
			{ ...good, adminToken: "a".repeat(257) },
			{ ...good, adminToken: 5 },
			{ ...good, clusterSecret: "two\nlines" },
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
		await putFile(root, "/etc/systemd/system/vmon.service", renderVmonUnit("172.20.0.0/16", { uid: 961, gid: 990 }));
		const runner = fakeRunner(healthy);
		const steps = await systemChecks(runner.run, { root, user: "alice" });
		expect(steps.map((step) => [step.id, step.status])).toEqual([
			["system.check.omp-cloud-net", "ok"],
			["system.check.vmon", "ok"],
			["system.check.link", "ok"],
			["system.check.health", "ok"],
			["system.check.vmm-user", "ok"],
			["system.check.helper", "ok"],
			["system.check.linger", "ok"],
		]);
		expect(runner.lines()).toContain(`sudo -n -l ${HELPER}`);
	});

	test("a vmon unit without --vmm-user fails with the setup fix; no unit file means no row", async () => {
		await putFile(root, "/etc/systemd/system/vmon.service", renderVmonUnit("172.20.0.0/16", { uid: 961, gid: 990 }).replace(" --vmm-user 961:990", ""));
		const steps = await systemChecks(fakeRunner(healthy).run, { root, user: "alice" });
		expect(steps.find((candidate) => candidate.id === "system.check.vmm-user")).toEqual({
			id: "system.check.vmm-user",
			status: "failed",
			detail: "vibemon's VMMs run as root without their seccomp and Landlock filters (the vmon unit has no --vmm-user)",
			fix: "omp-cloud setup",
		});
		await rm(join(root, "/etc/systemd/system/vmon.service"));
		expect((await systemChecks(fakeRunner(healthy).run, { root, user: "alice" })).some((candidate) => candidate.id === "system.check.vmm-user")).toBe(false);
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

const LAN = "192.168.1.20";
const PIN = `sha256//${"A".repeat(43)}=`;
const NODE_FLAGS = ["--node", "--user", "alice", "--vmon", "v0.4.0", "--server", LAN, "--remote-port", "8443", "--pin", PIN, "--secret-file", "/tmp/omp-cloud-node-x/secret"];
const without = (argv: string[], flag: string): string[] => {
	const at = argv.indexOf(flag);
	return at === -1 ? argv : argv.filter((_, index) => index !== at && index !== at + (flag === "--node" || flag === "--route" ? 0 : 1));
};
const SECRET = "node-cluster-secret-from-the-server";

describe("parseSystemArgs: cluster address and node flags", () => {
	test("--cluster-address takes an IPv4 address, and only when setting up", () => {
		expect(parseSystemArgs([...ARGS, "--cluster-address", LAN])).toMatchObject({ ok: true, args: { clusterAddress: LAN, node: null } });
		for (const bad of ["192.168.1", "192.168.1.256", "lan.example", "::1", "192.168.1.20/24", "0.0.0.0", "127.0.0.1", "224.0.0.1", "255.255.255.255", "8.8.8.8", "192.169.1.1", "172.32.0.1", "192.168.01.20"]) {
			expect(parseSystemArgs([...ARGS, "--cluster-address", bad])).toEqual({ ok: false, error: `--cluster-address ${JSON.stringify(bad)} is not a private LAN IPv4 address (10.x, 172.16-31.x or 192.168.x, no leading zeros)` });
		}
		for (const good of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20"]) {
			expect(parseSystemArgs([...ARGS, "--cluster-address", good])).toMatchObject({ ok: true, args: { clusterAddress: good } });
		}
		expect(parseSystemArgs(["--uninstall", "--cluster-address", LAN])).toEqual({ ok: false, error: "--cluster-address cannot be combined with --uninstall" });
	});

	test("--node takes its flags and yields the node arguments", () => {
		expect(parseSystemArgs(NODE_FLAGS)).toMatchObject({
			ok: true,
			args: { user: "alice", uninstall: false, clusterAddress: null, node: { vmon: "v0.4.0", server: LAN, remotePort: 8443, pin: PIN, secretFile: "/tmp/omp-cloud-node-x/secret", route: false } },
		});
		expect(parseSystemArgs([...NODE_FLAGS, "--route", "--packages", "curl"])).toMatchObject({ ok: true, args: { packages: ["curl"], node: { route: true } } });
	});

	test.each(["--vmon", "--server", "--remote-port", "--pin", "--secret-file"])("%s without --node is refused as needing --node", (flag) => {
		const value = NODE_FLAGS[NODE_FLAGS.indexOf(flag) + 1] ?? "";
		expect(parseSystemArgs([...ARGS, flag, value])).toEqual({ ok: false, error: `${flag} needs --node` });
	});

	test("--route without --node is refused as needing --node", () => {
		expect(parseSystemArgs([...ARGS, "--route"])).toEqual({ ok: false, error: "--route needs --node" });
	});

	test.each([
		["--team", "x"],
		["--max-sandboxes", "3"],
		["--mint-key"],
		["--no-linger"],
		["--migrate-team", "acme"],
		["--cluster-address", LAN],
	] satisfies string[][])("--node refuses %s", (...extra: string[]) => {
		expect(parseSystemArgs([...NODE_FLAGS, ...extra])).toEqual({ ok: false, error: `${extra[0]} cannot be combined with --node` });
	});

	test.each(["--vmon", "--server", "--remote-port", "--pin", "--secret-file"])("--node without %s is refused", (flag) => {
		expect(parseSystemArgs(without(NODE_FLAGS, flag))).toEqual({ ok: false, error: `${flag} is required with --node` });
	});

	test.each([
		["a vibemon tag without v", ["--vmon", "0.4.0"]],
		["a vibemon tag with a suffix", ["--vmon", "v0.4.0-rc1"]],
		["a server that is a host name", ["--server", "server.lan"]],
		["a server of 0.0.0.0", ["--server", "0.0.0.0"]],
		["a loopback server", ["--server", "127.0.0.1"]],
		["a multicast server", ["--server", "224.0.0.1"]],
		["the broadcast address as the server", ["--server", "255.255.255.255"]],
		["a server with a leading zero", ["--server", "192.168.01.20"]],
		["a port of 0", ["--remote-port", "0"]],
		["a port of 65536", ["--remote-port", "65536"]],
		["a port that is not a number", ["--remote-port", "https"]],
		["a pin without the prefix", ["--pin", "A".repeat(44)]],
		["a pin of the wrong length", ["--pin", `sha256//${"A".repeat(42)}=`]],
		["a relative secret path", ["--secret-file", "secret"]],
		["a secret path with ..", ["--secret-file", "/tmp/../etc/shadow"]],
		["a secret path with a space", ["--secret-file", "/tmp/a b"]],
	])("--node refuses %s", (_name, [flag, value]) => {
		const argv = [...without(NODE_FLAGS, flag ?? ""), flag ?? "", value ?? ""];
		expect(parseSystemArgs(argv).ok).toBe(false);
	});

	test("--node cannot be combined with --uninstall, and neither can any node flag", () => {
		expect(parseSystemArgs(["--uninstall", "--node"])).toEqual({ ok: false, error: "--node cannot be combined with --uninstall" });
		expect(parseSystemArgs(["--uninstall", "--route"])).toEqual({ ok: false, error: "--route cannot be combined with --uninstall" });
	});
});

describe("runSystem: cluster mode", () => {
	const vmonUnit = () => readFile(join(root, "/etc/systemd/system/vmon.service"), "utf8");
	const vmonActive = (argv: readonly string[]) => (argv[1] === "is-active" && argv[2] === "vmon.service" ? { code: 0 } : argv[1] === "is-enabled" ? { code: 0 } : undefined);

	test("a server with a cluster address listens on it, never on 0.0.0.0, and reports the cluster secret and the admin token", async () => {
		const h = host();
		expect(await runSystem([...ARGS, "--cluster-address", LAN], h.deps)).toBe(0);
		const unit = await vmonUnit();
		expect(unit).toContain(`--cluster-listen ${LAN}:7947 --gossip-listen ${LAN}:7946`);
		expect(unit).not.toContain("0.0.0.0");
		const report = h.report();
		expect(report.clusterSecret).toBe(h.secrets[0]);
		expect(report.adminToken).toBe(h.secrets[1]);
		const admin = h.runner.calls.filter((call) => call.argv[1] === "admin");
		expect(admin.length).toBeGreaterThan(0);
		for (const call of admin) expect(call.argv.slice(2, 4)).toEqual(["--cluster-url", `http://${LAN}:7947`]);
	});

	test("neither secret appears in any step, human line or command line", async () => {
		const h = host();
		await runSystem([...ARGS, "--cluster-address", LAN], h.deps);
		const everything = [JSON.stringify(h.deps.reporter.steps), h.human.join(""), ...h.runner.lines()].join("\n");
		for (const secret of h.secrets) expect(everything).not.toContain(secret);
	});

	test("a server without a cluster address listens on loopback only and reports no cluster secret", async () => {
		const h = host();
		await runSystem(ARGS, h.deps);
		expect(await vmonUnit()).toContain("--cluster-listen 127.0.0.1:7947 --gossip-listen 127.0.0.1:7946");
		expect(h.report()).not.toHaveProperty("clusterSecret");
		for (const call of h.runner.calls.filter((call) => call.argv[1] === "admin")) expect(call.argv.slice(2, 4)).toEqual(["--cluster-url", "http://127.0.0.1:7947"]);
	});

	test("vmon restarts only when the address it listens on changes", async () => {
		await runSystem(ARGS, host().deps);

		const toLan = host({ respond: vmonActive });
		await runSystem([...ARGS, "--cluster-address", LAN], toLan.deps);
		expect(toLan.runner.lines()).toContain("systemctl restart vmon.service");
		expect(toLan.report().steps.find((step) => step.id === "system.unit.vmon")).toMatchObject({ status: "changed", detail: `vmon.service restarted to listen for other vibemon machines on ${LAN}` });

		const same = host({ respond: vmonActive });
		await runSystem([...ARGS, "--cluster-address", LAN], same.deps);
		expect(same.runner.lines()).not.toContain("systemctl restart vmon.service");
		expect(same.report().steps.find((step) => step.id === "system.unit.vmon")?.status).toBe("ok");

		const back = host({ respond: vmonActive });
		await runSystem(ARGS, back.deps);
		expect(back.runner.lines()).toContain("systemctl restart vmon.service");
		expect(back.report().steps.find((step) => step.id === "system.unit.vmon")?.detail).toBe("vmon.service restarted to listen on 127.0.0.1 only");
		expect(await vmonUnit()).toContain("--cluster-listen 127.0.0.1:7947");
	});

	test("a vmon that is not running is not restarted when its address changes", async () => {
		await runSystem(ARGS, host().deps);
		const h = host();
		await runSystem([...ARGS, "--cluster-address", LAN], h.deps);
		expect(h.runner.lines().some((line) => line.includes("restart"))).toBe(false);
	});

	test("a vmon that will not restart is a failed unit step and the run stops before the team", async () => {
		await runSystem(ARGS, host().deps);
		const h = host({ respond: (argv) => (argv[1] === "restart" ? { code: 1, stderr: "Job failed" } : vmonActive(argv)) });
		expect(await runSystem([...ARGS, "--cluster-address", LAN], h.deps)).toBe(1);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.unit.vmon", status: "failed" });
	});
});

describe("runSystem: node mode", () => {
	const secretFile = () => join(root, "tmp", "secret");
	const nodeArgs = (...extra: string[]) => [...without(NODE_FLAGS, "--secret-file"), "--secret-file", secretFile(), ...extra];
	const active = (argv: readonly string[]) => (argv[1] === "is-active" ? { code: 0 } : argv[1] === "is-enabled" ? { code: 1 } : undefined);
	const file = (path: string) => readFile(join(root, path), "utf8");

	beforeEach(async () => {
		await putFile(root, "/tmp/secret", `${SECRET}\n`, 0o600);
	});

	test("sets a machine up as a node: the steps in order, no team, no sudoers rule, no linger", async () => {
		const h = host({ respond: active });
		expect(await runSystem(nodeArgs(), h.deps)).toBe(0);
		const report = h.report();
		expect(report.team).toBeNull();
		expect(report).not.toHaveProperty("key");
		expect(report).not.toHaveProperty("adminToken");
		expect(report.steps.map((step) => step.id)).toEqual([
			"system.packages",
			"system.user",
			"system.node.guard",
			"system.helper",
			"system.vmon",
			"system.env",
			"system.node.conf",
			"system.vmm-user",
			"system.unit.omp-cloud-node-net",
			"system.unit.vmon",
			"system.unit.omp-cloud-vmon-sync",
			"system.health",
		]);
		expect(h.runner.lines()).toContain(`${HELPER} v0.4.0`);
		expect(await exists(SUDOERS_FILE)).toBe(false);
		expect(h.runner.lines().some((line) => line.startsWith("loginctl") || line.includes(" admin "))).toBe(false);
	});

	test("writes both scripts, the secret-only env, node.env without a secret, and the node units", async () => {
		const h = host({ respond: active });
		await runSystem(nodeArgs(), h.deps);
		expect(await file(HELPER)).toBe("#!/bin/sh\n# the embedded helper\n");
		expect(await file("/usr/local/libexec/omp-cloud/vmon-sync")).toBe("#!/bin/sh\n# the embedded sync script\n");
		expect(await modeOf("/usr/local/libexec/omp-cloud/vmon-sync")).toBe(0o755);
		expect(await file("/etc/vmon/env")).toBe(`VMON_CLUSTER_SECRET=${SECRET}\n`);
		expect(await modeOf("/etc/vmon/env")).toBe(0o600);
		expect(await file("/etc/omp-cloud/node.env")).toBe(`SERVER_URL=https://${LAN}:8443\nSERVER_PIN=${PIN}\n`);
		expect(await modeOf("/etc/omp-cloud/node.env")).toBe(0o644);
		expect(await file("/etc/omp-cloud/node.env")).not.toContain(SECRET);
		const vmon = await file("/etc/systemd/system/vmon.service");
		expect(vmon).toContain(`ExecStart=/opt/vmon/vmon serve --role node --data-dir /var/lib/vmon --join ${LAN}:7946 --egress-internal-allow 10.254.254.1/32 --registry-mirror https://mirror.gcr.io --net-pool 172.20.0.0/16 --vmm-user 961:990`);
		expect(vmon).not.toContain("--listen");
		for (const unit of ["omp-cloud-node-net.service", "omp-cloud-vmon-sync.service", "omp-cloud-vmon-sync.timer"]) expect(await exists(`/etc/systemd/system/${unit}`)).toBe(true);
		expect(h.runner.lines()).toContain("systemctl enable --now omp-cloud-node-net.service");
		expect(h.runner.lines()).toContain("systemctl enable --now vmon.service");
		expect(h.runner.lines()).toContain("systemctl enable --now omp-cloud-vmon-sync.timer");
	});

	test("the secret appears in no step, human line, report or command line", async () => {
		const h = host({ respond: active });
		await runSystem(nodeArgs(), h.deps);
		const everything = [JSON.stringify(h.deps.reporter.steps), h.human.join(""), h.stdout.join(""), ...h.runner.lines()].join("\n");
		expect(everything).not.toContain(SECRET);
	});

	test("with --route the node-net unit routes the service address through the server, without it no route is touched", async () => {
		await runSystem(nodeArgs("--route"), host({ respond: active }).deps);
		const routed = await file("/etc/systemd/system/omp-cloud-node-net.service");
		expect(routed).toContain(`ip route replace 10.254.254.1/32 via ${LAN};`);
		expect(routed).toContain("ip route del 10.254.254.1/32");
		await rm(join(root, "/etc/systemd/system"), { recursive: true });
		await runSystem(nodeArgs(), host({ respond: active }).deps);
		const plain = await file("/etc/systemd/system/omp-cloud-node-net.service");
		expect(plain).not.toContain("ip route");
	});

	test("an existing env file with the same secret is kept; another cluster's secret is refused and left alone", async () => {
		await putFile(root, "/etc/vmon/env", `VMON_CLUSTER_SECRET=${SECRET}\n`, 0o644);
		const same = host({ respond: active });
		expect(await runSystem(nodeArgs(), same.deps)).toBe(0);
		expect(same.report().steps.find((step) => step.id === "system.env")).toMatchObject({ status: "ok" });
		expect(await modeOf("/etc/vmon/env")).toBe(0o600);

		await putFile(root, "/etc/vmon/env", "VMON_CLUSTER_SECRET=somebody-else\nVMON_ADMIN_TOKEN=x\n", 0o600);
		await rm(join(root, "/etc/omp-cloud/node.env"));
		const other = host({ respond: active });
		expect(await runSystem(nodeArgs(), other.deps)).toBe(1);
		expect(other.report().steps.at(-1)).toMatchObject({ id: "system.env", status: "failed", detail: "/etc/vmon/env holds another cluster's secret", fix: "omp-cloud uninstall --purge first" });
		expect(await file("/etc/vmon/env")).toBe("VMON_CLUSTER_SECRET=somebody-else\nVMON_ADMIN_TOKEN=x\n");
		expect(await exists("/etc/omp-cloud/node.env")).toBe(false);
	});

	test("a missing or empty secret file fails the env step", async () => {
		await rm(secretFile());
		const missing = host({ respond: active });
		expect(await runSystem(nodeArgs(), missing.deps)).toBe(1);
		expect(missing.report().steps.at(-1)).toMatchObject({ id: "system.env", status: "failed" });
		await putFile(root, "/tmp/secret", "  \n", 0o600);
		const empty = host({ respond: active });
		expect(await runSystem(nodeArgs(), empty.deps)).toBe(1);
		expect(empty.report().steps.at(-1)).toMatchObject({ id: "system.env", status: "failed" });
	});

	test("a secret that EnvironmentFile would not carry byte for byte is refused, and /etc/vmon/env is not written", async () => {
		for (const odd of ['abc"def', "abc'def", "abc\\ndef", "abc$HOME", "abc#def", "abc def", "x".repeat(257)]) {
			await putFile(root, "/tmp/secret", odd, 0o600);
			const h = host({ respond: active });
			expect(await runSystem(nodeArgs(), h.deps)).toBe(1);
			expect(h.report().steps.at(-1)).toMatchObject({ id: "system.env", status: "failed" });
			expect(await exists("/etc/vmon/env")).toBe(false);
		}
		await putFile(root, "/tmp/secret", "Ab0._~+/=:-", 0o600);
		expect(await runSystem(nodeArgs(), host({ respond: active }).deps)).toBe(0);
		expect(await file("/etc/vmon/env")).toBe("VMON_CLUSTER_SECRET=Ab0._~+/=:-\n");
	});

	test("a machine that runs a vibemon server is refused before anything is installed", async () => {
		await runSystem(ARGS, host().deps);
		const h = host({ respond: active });
		expect(await runSystem(nodeArgs(), h.deps)).toBe(1);
		expect(h.report().steps.at(-1)).toMatchObject({ id: "system.node.guard", status: "failed", fix: "omp-cloud uninstall --purge, then omp-cloud setup node --join <user@server>" });
		expect(await exists("/etc/omp-cloud/node.env")).toBe(false);
	});

	test("a vmon that never stays active for 10 s fails the health step; one that settles passes", async () => {
		const flapping = host({ respond: (argv) => (argv[1] === "is-active" ? { code: 3 } : argv[1] === "is-enabled" ? { code: 1 } : undefined) });
		expect(await runSystem(nodeArgs(), flapping.deps)).toBe(1);
		expect(flapping.report().steps.at(-1)).toMatchObject({ id: "system.health", status: "failed", detail: "vmon did not stay active for 10 s within 60 s" });

		let polls = 0;
		const settling = host({ respond: (argv) => (argv[1] === "is-active" && argv.includes("--quiet") ? { code: ++polls < 4 ? 3 : 0 } : active(argv)) });
		expect(await runSystem(nodeArgs(), settling.deps)).toBe(0);
		expect(polls).toBe(13);
	});

	test("a rerun changes nothing and restarts nothing", async () => {
		await runSystem(nodeArgs(), host({ respond: active }).deps);
		await putFile(root, "/opt/vmon/vmon", "#!/bin/sh\n", 0o755);
		const again = host({ vmmUserExists: true, respond: (argv) => (argv[1] === "is-active" || argv[1] === "is-enabled" ? { code: 0 } : undefined) });
		expect(await runSystem(nodeArgs(), again.deps)).toBe(0);
		expect(again.report().steps.filter((step) => step.status === "changed")).toEqual([]);
		expect(again.runner.lines().some((line) => line.includes("restart"))).toBe(false);
	});

	test("an uninstall removes the node's units, scripts, server record and sync state", async () => {
		await runSystem(nodeArgs(), host({ respond: active }).deps);
		await putFile(root, "/var/lib/omp-cloud/vmon-sync.failed", "v0.4.1 1700000000\n");
		const h = host();
		expect(await runSystem(["--uninstall"], h.deps)).toBe(0);
		expect(h.runner.lines()).toContain("systemctl disable --now omp-cloud-vmon-sync.timer omp-cloud-vmon-sync.service vmon.service omp-cloud-node-net.service");
		for (const path of ["/etc/systemd/system/vmon.service", "/etc/systemd/system/omp-cloud-node-net.service", "/etc/systemd/system/omp-cloud-vmon-sync.timer", "/etc/systemd/system/omp-cloud-vmon-sync.service", "/usr/local/libexec/omp-cloud/vmon-sync", HELPER, "/etc/omp-cloud/node.env", "/var/lib/omp-cloud/vmon-sync.failed"]) {
			expect(await exists(path)).toBe(false);
		}
		expect(await exists("/etc/vmon/env")).toBe(true);
	});
});
