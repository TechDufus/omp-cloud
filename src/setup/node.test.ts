import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult } from "../update/system";
import { buildNodePlan, nodeMain, parseJoinTarget, parseNodeArgs, quoteArg, readJoinInfo, readRoute, remoteCommand, runNode, sshArgv } from "./node";
import { packagesFor } from "./packages";
import type { SystemReport } from "./system";
import { rig, type RigOptions, TEST_USER, type TestRig } from "./test-support";

const PIN = `sha256//${"A".repeat(43)}=`;
const SECRET = "cluster-secret-0123456789abcdef";
const SERVER = "192.168.1.20";
const NODE = "192.168.1.50";
const ARGS = { join: "user@server", yes: true, json: false };
const GATEWAY = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", "http://10.254.254.1:4000/healthz"];

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ompCloudNode: 1,
		server: { address: SERVER, remotePort: 8443, pin: PIN, version: "0.7.0" },
		vmon: { version: "v0.4.0", join: `${SERVER}:7946`, clusterSecret: SECRET },
		...over,
	};
}

const BANNER = "Welcome to server\n";
const JOINED = { stdout: `${BANNER}${JSON.stringify(record())}\n` };
const MEMBER = { stdout: `${JSON.stringify({ ompCloudNode: 1, member: { hostname: "node-1", status: "ready", version: "0.4.0" } })}\n` };
const SAME_LAN = { stdout: `${SERVER} dev eth0 src ${NODE} uid 1000\n    cache\n` };
const NODE_REPORT: SystemReport = { ok: true, steps: [{ id: "system.node.conf", status: "changed", detail: "wrote /etc/omp-cloud/node.env" }], team: null, netPool: "172.20.0.0/16", linger: false };

/** What the fake host answers to ssh, `ip route get`, the gateway curl, and what the root part saw. */
interface Script {
	join: Partial<CommandResult>;
	member: Partial<CommandResult>;
	route: Partial<CommandResult>;
	gateway: Partial<CommandResult>;
	/** The sudo call, with the secret file as it was at that moment. */
	root: { argv: string[]; secretFile: string; mode: number; content: string }[];
}

function script(over: Partial<Script> = {}): Script {
	return { join: JOINED, member: MEMBER, route: SAME_LAN, gateway: { stdout: "200" }, root: [], ...over };
}

function respond(answers: Script): (argv: readonly string[]) => Partial<CommandResult> | undefined {
	return (argv) => {
		if (argv.includes("BatchMode=yes")) return argv.at(-1)?.includes("'--member'") ? answers.member : answers.join;
		if (argv[1] === "route" && argv[2] === "get") return answers.route;
		if (argv[0] === "curl") return answers.gateway;
		if (argv[0] === "sudo" && argv.includes("setup") && argv.includes("system")) {
			const secretFile = argv[argv.indexOf("--secret-file") + 1] ?? "";
			const present = existsSync(secretFile);
			answers.root.push({ argv: [...argv], secretFile, mode: present ? statSync(secretFile).mode & 0o777 : -1, content: present ? readFileSync(secretFile, "utf8") : "" });
		}
		return undefined;
	};
}

let dir = "";
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "setup-node-test-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function node(answers: Script = script(), options: RigOptions = {}): Promise<TestRig> {
	const host = { root: [NODE_REPORT], ...options.host, respond: respond(answers) };
	return rig(dir, { ...options, host });
}

const sshCalls = (r: TestRig) => r.host.calls.filter((call) => call.argv.includes("BatchMode=yes"));
const rootCalls = (r: TestRig) => r.host.calls.filter((call) => call.argv[0] === "sudo" && call.argv.includes("system"));
const step = (r: TestRig, id: string) => r.ctx.reporter.steps.find((s) => s.id === id);

function expectNoSecret(r: TestRig): void {
	const seen = [...r.out, ...r.err, ...r.stdout, JSON.stringify(r.ctx.reporter.steps), ...r.host.lines(), JSON.stringify(r.host.calls.map((call) => call.options))];
	for (const text of seen) expect(text).not.toContain(SECRET);
}

describe("parseNodeArgs", () => {
	test("needs --join; takes --yes, -y and --json", () => {
		expect(parseNodeArgs(["--join", "user@server"])).toEqual({ ok: true, args: { join: "user@server", yes: false, json: false } });
		expect(parseNodeArgs(["-y", "--json", "--join", "server"])).toEqual({ ok: true, args: { join: "server", yes: true, json: true } });
		expect(parseNodeArgs([])).toMatchObject({ ok: false, error: expect.stringContaining("--join") });
		expect(parseNodeArgs(["--join"])).toMatchObject({ ok: false, error: expect.stringContaining("--join needs a target") });
		expect(parseNodeArgs(["--join", "a", "--no-such"])).toEqual({ ok: false, error: 'unknown argument "--no-such"' });
	});

	test("nodeMain answers --help with 0 and a usage error with 2, without touching a context", async () => {
		expect(await nodeMain(["--help"])).toBe(0);
		expect(await nodeMain(["--bogus"])).toBe(2);
	});
});

describe("parseJoinTarget", () => {
	test("user@host, host and ssh:// with a port", () => {
		expect(parseJoinTarget("alice@box.lan")).toEqual({ destination: "alice@box.lan", port: undefined });
		expect(parseJoinTarget("box")).toEqual({ destination: "box", port: undefined });
		expect(parseJoinTarget("ssh://alice@box:2222/")).toEqual({ destination: "alice@box", port: 2222 });
		expect(parseJoinTarget("ssh://box")).toEqual({ destination: "box", port: undefined });
	});

	test("refuses an option, an empty host or user, a bad port, an IPv6 literal and any other shape", () => {
		expect(parseJoinTarget("-oProxyCommand=x")).toContain("cannot start with '-'");
		expect(parseJoinTarget("  -x@host")).toContain("cannot start with '-'");
		for (const bad of ["", "user@", "@host", "a b", "user@host name", "ssh://box:0", "ssh://box:99999", "user@[::1]", "::1", "a@b@c", "ssh://", "host;rm", "u$er@host", "-@host"]) {
			expect(typeof parseJoinTarget(bad)).toBe("string");
		}
	});
});

describe("ssh command", () => {
	test("quotes like the plugin's twin", () => {
		expect(quoteArg("it's")).toBe(`'it'\\''s'`);
		expect(remoteCommand(["node-join-info"])).toBe(
			`'sh' '-c' 'if command -v omp-cloud >/dev/null 2>&1; then exec omp-cloud "$@"; fi; exec "$HOME/.local/bin/omp-cloud" "$@"' 'sh' 'node-join-info'`,
		);
	});

	test("the port goes before --", () => {
		expect(sshArgv("ssh", { destination: "u@h", port: 2222 }, ["node-join-info"])).toEqual([
			"ssh",
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			"-p",
			"2222",
			"--",
			"u@h",
			remoteCommand(["node-join-info"]),
		]);
	});
});

describe("readJoinInfo and readRoute", () => {
	test("a good record", () => {
		expect(readJoinInfo(record())).toEqual({ address: SERVER, remotePort: 8443, pin: PIN, serverVersion: "0.7.0", vmonVersion: "v0.4.0", clusterSecret: SECRET });
	});

	test("routes: same LAN, through a router, this machine itself, no source", () => {
		expect(readRoute(`${SERVER} dev eth0 src ${NODE} uid 1000\n`, SERVER)).toEqual({ nodeAddress: NODE, via: null });
		expect(readRoute(`${SERVER} via 10.0.5.1 dev eth0 src 10.0.5.7 uid 1000\n`, SERVER)).toEqual({ nodeAddress: "10.0.5.7", via: "10.0.5.1" });
		expect(readRoute(`local ${SERVER} dev lo src ${SERVER} uid 1000\n`, SERVER)).toContain("a node must be a different machine");
		expect(readRoute("unreachable\n", SERVER)).toContain("names no source address");
	});
});

describe("buildNodePlan", () => {
	const input = { version: "0.7.0", user: "tester", appDir: "/app", address: SERVER, vmonVersion: "v0.4.0", packageManager: "apt", packages: ["curl"], route: true };

	test("lists the root work, the network lines and the route only with --route", () => {
		const text = buildNodePlan(input).join("\n");
		expect(text).toContain("install packages with apt: curl");
		expect(text).toContain("install vibemon v0.4.0 and the vibemon helpers");
		expect(text).toContain("run vibemon's VMMs as the system user omp-cloud-vmm (group kvm) under their seccomp and Landlock filters, not as root");
		expect(text).toContain("/etc/vmon/env");
		expect(text).toContain("/etc/omp-cloud/node.env");
		expect(text).toContain(`the system unit vmon (role node, joins ${SERVER}:7946)`);
		expect(text).toContain(`omp-cloud-node-net: VMs here reach only TCP 4000 and 4100 of 10.254.254.1, plus the route 10.254.254.1 via ${SERVER}`);
		expect(text).toContain("omp-cloud-vmon-sync.timer");
		expect(text).toContain("this machine must reach the server's TCP 4000, 4100 and 8443");
		expect(text).toContain("every vibemon machine must reach the others on TCP 7947 and on 7946 over TCP and UDP");
		const routed = buildNodePlan({ ...input, route: false, packages: [] }).join("\n");
		expect(routed).not.toContain("the route 10.254.254.1 via");
		expect(routed).not.toContain("install packages");
	});
});

describe("a node that joins", () => {
	test("asks the server, runs the root part, installs the binary, then checks the member and the gateway", async () => {
		const answers = script();
		const r = await node(answers);
		expect(await runNode(ARGS, r.ctx)).toBe(0);

		const [first, second] = sshCalls(r);
		expect(first?.argv).toEqual(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "user@server", remoteCommand(["node-join-info"])]);
		expect(first?.options?.timeoutMs).toBe(60_000);
		expect(second?.argv).toEqual(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "user@server", remoteCommand(["node-join-info", "--member", NODE])]);
		expect(second?.options?.timeoutMs).toBe(75_000);

		expect(answers.root).toHaveLength(1);
		const seen = answers.root[0];
		expect(seen?.argv).toEqual([
			"sudo",
			"--",
			r.ctx.self.argv[0] ?? "",
			"setup",
			"system",
			"--node",
			"--user",
			TEST_USER,
			"--vmon",
			"v0.4.0",
			"--server",
			SERVER,
			"--remote-port",
			"8443",
			"--pin",
			PIN,
			"--secret-file",
			seen?.secretFile ?? "",
			"--route",
		]);
		expect(seen?.mode).toBe(0o600);
		expect(seen?.content.trim()).toBe(SECRET);
		expect(seen?.secretFile).toMatch(/omp-cloud-node-[^/]+\/secret$/);
		expect(existsSync(dirname(seen?.secretFile ?? ""))).toBe(false);
		expect(rootCalls(r)[0]?.options?.inherit).toBe(true);

		const lines = r.host.lines();
		const rootAt = lines.findIndex((line) => line.startsWith("sudo -- "));
		const installAt = lines.findIndex((line) => line === `${r.ctx.self.argv[0]} version`);
		const memberAt = lines.findIndex((line) => line.includes("'--member'"));
		const gatewayAt = lines.indexOf(GATEWAY.join(" "));
		expect(rootAt).toBeGreaterThan(0);
		expect(installAt).toBeGreaterThan(rootAt);
		expect(memberAt).toBeGreaterThan(installAt);
		expect(gatewayAt).toBeGreaterThan(memberAt);
		expect(existsSync(r.ctx.paths.appDir)).toBe(true);

		const ids = r.ctx.reporter.steps.map((s) => s.id);
		expect(ids.filter((id) => id.startsWith("node."))).toEqual(["node.join-info", "node.route", "node.member", "node.gateway"]);
		expect(ids).toContain("system.node.conf");
		expect(ids).toContain("managed.binary");
		expect(ids).not.toContain("preflight.omp");
		expect(ids).not.toContain("preflight.user-manager");
		expect(step(r, "node.route")).toMatchObject({ status: "ok", detail: `this machine reaches ${SERVER} directly: 10.254.254.1 is routed to it` });
		expect(step(r, "node.member")).toMatchObject({ status: "ok", detail: "the server sees node-1 (vibemon 0.4.0, ready)" });
		expect(step(r, "node.gateway")?.status).toBe("ok");
		expect(r.ctx.reporter.failed).toBe(false);
		expect(r.asked).toEqual([]);
		expectNoSecret(r);
	});

	test("through a router the root part gets no --route, and the route step names the router", async () => {
		const answers = script({ route: { stdout: `${SERVER} via 10.0.5.1 dev eth0 src 10.0.5.7 uid 1000\n` }, member: MEMBER });
		const r = await node(answers);
		expect(await runNode(ARGS, r.ctx)).toBe(0);
		expect(answers.root[0]?.argv).not.toContain("--route");
		expect(step(r, "node.route")?.detail).toBe(
			`this machine reaches ${SERVER} through the router 10.0.5.1: that router must route 10.254.254.1/32 to ${SERVER} (add that static route there; omp-cloud never changes your router)`,
		);
		expect(sshCalls(r)[1]?.argv.at(-1)).toBe(remoteCommand(["node-join-info", "--member", "10.0.5.7"]));
		expect(r.out.join("")).not.toContain("the route 10.254.254.1 via");
		expectNoSecret(r);
	});

	test("passes the packages setup would install, uses OMP_CLOUD_SSH and the target's port", async () => {
		const answers = script();
		const r = await node(answers, { missingTools: ["curl"] });
		const ctx = { ...r.ctx, env: { ...r.ctx.env, OMP_CLOUD_SSH: "/opt/bin/myssh" } };
		expect(await runNode({ ...ARGS, join: "ssh://alice@server:2222" }, ctx)).toBe(0);
		expect(answers.root[0]?.argv.slice(-2)).toEqual(["--packages", packagesFor("apt", ["curl"]).join(",")]);
		expect(sshCalls(r)[0]?.argv).toEqual(["/opt/bin/myssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "2222", "--", "alice@server", remoteCommand(["node-join-info"])]);
	});

	test("--json prints one report line and keeps the plan and steps off stdout", async () => {
		const r = await node();
		expect(await runNode({ ...ARGS, json: true }, r.ctx)).toBe(0);
		expect(r.stdout).toHaveLength(1);
		const report = JSON.parse(r.stdout[0] ?? "") as { ok: boolean; steps: { id: string }[] };
		expect(report.ok).toBe(true);
		expect(report.steps.map((s) => s.id)).toContain("node.gateway");
		expectNoSecret(r);
	});

	test("prints the plan and asks once without --yes", async () => {
		const r = await node();
		expect(await runNode({ ...ARGS, yes: false }, r.ctx)).toBe(0);
		expect(r.asked).toEqual(["Continue? [Y/n]"]);
		expect(r.out.join("")).toContain("this machine must reach the server's TCP 4000, 4100 and 8443");
	});
});

describe("refusals before anything is asked", () => {
	async function refused(r: TestRig, args = ARGS): Promise<number> {
		const code = await runNode(args, r.ctx);
		expect(sshCalls(r)).toHaveLength(0);
		expect(rootCalls(r)).toHaveLength(0);
		return code;
	}

	test("as root", async () => {
		const r = await node(script(), { uid: 0 });
		expect(await refused(r)).toBe(1);
		expect(step(r, "node.user")).toMatchObject({ status: "failed", detail: "run omp-cloud setup node as your user; it asks for sudo once" });
	});

	test("from a checkout", async () => {
		const r = await node(script(), { compiled: false });
		expect(await refused(r)).toBe(1);
		expect(step(r, "node.binary")).toMatchObject({ status: "failed", detail: "run the release binary (install.sh) on a node" });
	});

	test("on a machine that runs the server", async () => {
		const r = await node();
		await mkdir(dirname(r.ctx.paths.serviceJson), { recursive: true });
		await writeFile(r.ctx.paths.serviceJson, "{}");
		expect(await refused(r)).toBe(1);
		expect(step(r, "node.server")).toEqual({
			id: "node.server",
			status: "failed",
			detail: "this machine runs an omp-cloud server; a machine is either a server or a node",
			fix: "omp-cloud uninstall --purge, then omp-cloud setup node --join user@server",
		});
	});

	test("when preflight blocks", async () => {
		const r = await node();
		const ctx = { ...r.ctx, preflight: { ...r.ctx.preflight, exists: async (path: string) => path !== "/dev/kvm" } };
		expect(await refused({ ...r, ctx })).toBe(1);
		expect(step(r, "preflight.kvm")?.status).toBe("failed");
	});

	test("bad targets are usage errors that name the reason", async () => {
		for (const [join, why] of [
			["-oProxyCommand=x", "cannot start with '-'"],
			["user@", "not an ssh target"],
			["ssh://box:99999", "not an ssh target"],
			["user@[::1]", "IPv6"],
			["a b", "not an ssh target"],
		] as const) {
			const r = await node();
			expect(await refused(r, { ...ARGS, join })).toBe(2);
			expect(r.err.join("")).toContain(why);
		}
	});
});

describe("asking the server over ssh", () => {
	const cases: { name: string; answer: Partial<CommandResult>; detail: string; fix?: string }[] = [
		{ name: "a timeout", answer: { code: 124 }, detail: "ssh to user@server timed out after 60 s", fix: "ssh user@server shows what ssh says" },
		{ name: "a missing omp-cloud", answer: { code: 127 }, detail: "omp-cloud is not installed on user@server", fix: "install it there and run omp-cloud setup" },
		{ name: "a changed host key", answer: { code: 255, stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n" }, detail: "the host key of user@server changed since you last connected, so ssh refused it", fix: "ssh-keygen -R" },
		{ name: "an unknown host key", answer: { code: 255, stderr: "Host key verification failed.\n" }, detail: "ssh does not know the host key of user@server", fix: "run ssh user@server once to accept its host key" },
		{ name: "a refused login", answer: { code: 255, stderr: "user@server: Permission denied (publickey).\n" }, detail: "ssh to user@server was refused", fix: "ssh-copy-id user@server" },
		{ name: "another ssh failure", answer: { code: 255, stderr: "ssh: connect to host server port 22: Connection refused\n" }, detail: "ssh to user@server failed (exit 255): ssh: connect to host server port 22: Connection refused" },
		{ name: "an older server with no record", answer: { code: 1, stdout: `${JSON.stringify({ ompCloudPair: 1, error: "unknown command" })}\n` }, detail: "the server's omp-cloud is older and cannot add machines: update it" },
		{ name: "a server that refuses", answer: { code: 1, stdout: `${JSON.stringify({ ompCloudNode: 1, error: "the server has no remote listener: run omp-cloud setup on it" })}\n` }, detail: "the server on user@server refused: the server has no remote listener: run omp-cloud setup on it" },
	];

	for (const { name, answer, detail, fix } of cases) {
		test(`fails on ${name} and goes no further`, async () => {
			const r = await node(script({ join: answer }));
			expect(await runNode(ARGS, r.ctx)).toBe(1);
			const failed = step(r, "node.join-info");
			expect(failed?.status).toBe("failed");
			expect(failed?.detail).toBe(detail);
			if (fix !== undefined) expect(failed?.fix).toContain(fix);
			expect(r.host.calls.some((call) => call.argv[1] === "route")).toBe(false);
			expect(rootCalls(r)).toHaveLength(0);
		});
	}

	const bad: [string, Record<string, unknown>][] = [
		["server", { server: "x" }],
		["server.address", { server: { address: "not-an-ip", remotePort: 8443, pin: PIN, version: "0.7.0" }, vmon: { version: "v0.4.0", join: "not-an-ip:7946", clusterSecret: SECRET } }],
		["server.address", { server: { address: "999.1.1.1", remotePort: 8443, pin: PIN, version: "0.7.0" }, vmon: { version: "v0.4.0", join: "999.1.1.1:7946", clusterSecret: SECRET } }],
		["server.remotePort", { server: { address: SERVER, remotePort: 0, pin: PIN, version: "0.7.0" } }],
		["server.remotePort", { server: { address: SERVER, remotePort: 70000, pin: PIN, version: "0.7.0" } }],
		["server.remotePort", { server: { address: SERVER, remotePort: "8443", pin: PIN, version: "0.7.0" } }],
		["server.pin", { server: { address: SERVER, remotePort: 8443, pin: "sha256//short", version: "0.7.0" } }],
		["server.version", { server: { address: SERVER, remotePort: 8443, pin: PIN, version: 7 } }],
		["vmon", { vmon: null }],
		["vmon.version", { vmon: { version: "0.4.0", join: `${SERVER}:7946`, clusterSecret: SECRET } }],
		["vmon.join", { vmon: { version: "v0.4.0", join: `${SERVER}:7947`, clusterSecret: SECRET } }],
		["vmon.clusterSecret", { vmon: { version: "v0.4.0", join: `${SERVER}:7946`, clusterSecret: "has a space" } }],
		["vmon.clusterSecret", { vmon: { version: "v0.4.0", join: `${SERVER}:7946`, clusterSecret: "" } }],
		["vmon.clusterSecret", { vmon: { version: "v0.4.0", join: `${SERVER}:7946`, clusterSecret: "x".repeat(257) } }],
		["vmon.clusterSecret", { vmon: { version: "v0.4.0", join: `${SERVER}:7946`, clusterSecret: 'a"b' } }],
		["vmon.clusterSecret", { vmon: { version: "v0.4.0", join: `${SERVER}:7946`, clusterSecret: "a\\nb" } }],
		["vmon.clusterSecret", { vmon: { version: "v0.4.0", join: `${SERVER}:7946`, clusterSecret: "a$b" } }],
		["vmon.clusterSecret", { vmon: { version: "v0.4.0", join: `${SERVER}:7946`, clusterSecret: "a#b" } }],
		["server.address", { server: { address: "0.0.0.0", remotePort: 8443, pin: PIN, version: "0.7.0" }, vmon: { version: "v0.4.0", join: "0.0.0.0:7946", clusterSecret: SECRET } }],
		["server.address", { server: { address: "127.0.0.1", remotePort: 8443, pin: PIN, version: "0.7.0" }, vmon: { version: "v0.4.0", join: "127.0.0.1:7946", clusterSecret: SECRET } }],
	];

	for (const [field, over] of bad) {
		test(`a record with a bad ${field} fails naming the field, with no secret echoed`, async () => {
			const r = await node(script({ join: { stdout: `${JSON.stringify(record(over))}\n` } }));
			expect(await runNode(ARGS, r.ctx)).toBe(1);
			expect(step(r, "node.join-info")?.detail).toContain(`(${field} is wrong)`);
			expect(rootCalls(r)).toHaveLength(0);
			for (const text of [...r.out, ...r.err]) expect(text).not.toContain("has a space");
		});
	}
});

describe("the route", () => {
	test("a failing or unreadable `ip route get` stops before the plan", async () => {
		for (const route of [{ code: 1, stderr: "RTNETLINK answers: Network is unreachable" }, { stdout: "unreachable\n" }, { stdout: `local ${SERVER} dev lo src ${SERVER}\n` }]) {
			const r = await node(script({ route }));
			expect(await runNode(ARGS, r.ctx)).toBe(1);
			expect(step(r, "node.route")?.status).toBe("failed");
			expect(r.asked).toEqual([]);
			expect(rootCalls(r)).toHaveLength(0);
		}
	});
});

describe("confirming and sudo", () => {
	test("no terminal and no --yes asks nothing and changes nothing", async () => {
		const r = await node(script(), { stdinIsTty: false });
		expect(await runNode({ ...ARGS, yes: false }, r.ctx)).toBe(2);
		expect(r.err.join("")).toContain("no terminal to ask on");
		expect(r.asked).toEqual([]);
		expect(rootCalls(r)).toHaveLength(0);
	});

	test("a declined plan changes nothing", async () => {
		const r = await node(script(), { answer: false });
		expect(await runNode({ ...ARGS, yes: false }, r.ctx)).toBe(1);
		expect(r.asked).toEqual(["Continue? [Y/n]"]);
		expect(r.err.join("")).toContain("nothing was changed");
		expect(rootCalls(r)).toHaveLength(0);
	});

	test("sudo that needs a password and no terminal fails before the root part", async () => {
		const r = await node(script(), { stdinIsTty: false, host: { sudoCached: false } });
		expect(await runNode(ARGS, r.ctx)).toBe(1);
		expect(step(r, "node.sudo")?.status).toBe("failed");
		expect(step(r, "node.sudo")?.detail).toContain("nothing was changed");
		expect(rootCalls(r)).toHaveLength(0);
	});
});

describe("when the root part fails", () => {
	test("a report with a failed step is the failure, and the temp directory is gone", async () => {
		const answers = script();
		const failed: SystemReport = { ...NODE_REPORT, ok: false, steps: [{ id: "system.env", status: "failed", detail: "/etc/vmon/env holds another cluster's secret", fix: "omp-cloud uninstall --purge first" }] };
		const r = await node(answers, { host: { root: [failed] } });
		expect(await runNode(ARGS, r.ctx)).toBe(1);
		expect(step(r, "system.env")?.status).toBe("failed");
		expect(r.host.lines().some((line) => line.endsWith("version"))).toBe(false);
		expect(sshCalls(r)).toHaveLength(1);
		expect(existsSync(dirname(answers.root[0]?.secretFile ?? "/"))).toBe(false);
		expectNoSecret(r);
	});

	test("no report: the fix never points at the secret file that no longer exists", async () => {
		const answers = script();
		const r = await node(answers);
		const base = respond(answers);
		const ctx = {
			...r.ctx,
			run: async (argv: readonly string[], options?: Parameters<typeof r.ctx.run>[1]) => {
				if (argv[0] === "sudo" && argv.includes("system")) {
					base(argv);
					return { code: 1, stdout: "", stderr: "" };
				}
				return r.ctx.run(argv, options);
			},
		};
		expect(await runNode(ARGS, ctx)).toBe(1);
		const failed = step(r, "system");
		expect(failed?.status).toBe("failed");
		expect(failed?.fix).toBe("run omp-cloud setup node --join user@server again in a terminal to see why");
		expect(existsSync(dirname(answers.root[0]?.secretFile ?? "/"))).toBe(false);
		expectNoSecret(r);
	});
});

describe("checking from both sides", () => {
	test("a member the server does not see fails with the network fix, and the gateway is still checked", async () => {
		const answers = script({ member: { code: 1, stdout: `${JSON.stringify({ ompCloudNode: 1, error: "the server's vibemon has not seen a machine at 192.168.1.50 within 60 s" })}\n` } });
		const r = await node(answers);
		expect(await runNode(ARGS, r.ctx)).toBe(1);
		expect(step(r, "node.member")).toEqual({
			id: "node.member",
			status: "failed",
			detail: "the server on user@server refused: the server's vibemon has not seen a machine at 192.168.1.50 within 60 s",
			fix: `allow TCP and UDP 7946 and TCP 7947 between this machine and ${SERVER}, both ways`,
		});
		expect(step(r, "node.gateway")?.status).toBe("ok");
		expectNoSecret(r);
	});

	test("a member check that times out says so", async () => {
		const r = await node(script({ member: { code: 124 } }));
		expect(await runNode(ARGS, r.ctx)).toBe(1);
		expect(step(r, "node.member")?.detail).toBe("ssh to user@server timed out after 75 s");
		expect(step(r, "node.member")?.fix).toContain("both ways");
	});

	test("a gateway that does not answer 200 fails; the fix depends on the route", async () => {
		const sameLan = await node(script({ gateway: { code: 7, stdout: "000" } }));
		expect(await runNode(ARGS, sameLan.ctx)).toBe(1);
		expect(sameLan.host.lines()).toContain(GATEWAY.join(" "));
		expect(step(sameLan, "node.gateway")).toMatchObject({
			status: "failed",
			detail: "http://10.254.254.1:4000/healthz did not answer: VMs here cannot call models",
			fix: `on the server, allow TCP 4000 and 4100 to 10.254.254.1 from ${NODE}`,
		});

		const routed = await node(script({ route: { stdout: `${SERVER} via 10.0.5.1 dev eth0 src 10.0.5.7\n` }, gateway: { stdout: "404" } }));
		expect(await runNode(ARGS, routed.ctx)).toBe(1);
		expect(step(routed, "node.gateway")).toMatchObject({
			status: "failed",
			detail: "http://10.254.254.1:4000/healthz answered 404: VMs here cannot call models",
			fix: `on the router 10.0.5.1, route 10.254.254.1/32 to ${SERVER}; on the server, allow TCP 4000 and 4100 to 10.254.254.1 from 10.0.5.7`,
		});
	});

	test("--json reports ok: false with the failing step", async () => {
		const r = await node(script({ gateway: { stdout: "503" } }));
		expect(await runNode({ ...ARGS, json: true }, r.ctx)).toBe(1);
		const report = JSON.parse(r.stdout[0] ?? "") as { ok: boolean; steps: { id: string; status: string }[] };
		expect(report.ok).toBe(false);
		expect(report.steps.find((s) => s.id === "node.gateway")?.status).toBe("failed");
		expectNoSecret(r);
	});
});
