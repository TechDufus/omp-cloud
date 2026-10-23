import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultServiceConfig, ensureDirs, writeVmonKey } from "./config";
import { doctorMain } from "./doctor";
import { rig, type TestRig } from "./test-support";
import type { CommandResult } from "../update/system";

let dir: string;
beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-cloud-doctor-")));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A host setup finished on: service.json, the team key, healthy everything. */
async function healthyHost(): Promise<TestRig> {
	const testRig = await rig(dir);
	const { paths } = testRig.ctx;
	await ensureDirs(paths);
	await mkdir(paths.tlsDir, { recursive: true });
	await writeFile(paths.serviceJson, JSON.stringify(defaultServiceConfig(paths, "a".repeat(64), "omp-cloud")));
	await writeVmonKey(paths, "e2b_key");
	return testRig;
}

describe("doctorMain", () => {
	test("prints one table and exits 0 when everything is right", async () => {
		const testRig = await healthyHost();
		expect(await doctorMain([], testRig.ctx)).toBe(0);
		const out = testRig.out.join("");
		expect(out).toContain("preflight.kvm");
		expect(out).toContain("system.check.vmon");
		expect(out).toContain("units.omp-cloud");
		expect(out).toContain("doctor.service");
		expect(out).toContain("doctor.template");
		expect(out).toContain("plugin.check");
		expect(out.trimEnd().endsWith("0 failed")).toBe(true);
		expect(testRig.stdout).toEqual([]);
	});

	test("exits 1 and prints the fix beside each failure", async () => {
		const testRig = await healthyHost();
		testRig.ctx.health.fetch = async (url) => (url.endsWith("/api/v1/health") ? Response.json({ status: "ok", version: "0.0.1" }) : new Response("ok", { status: 200 }));
		expect(await doctorMain([], testRig.ctx)).toBe(1);
		const table = testRig.out.join("");
		expect(table).toContain("doctor.service");
		expect(table).toContain("fix: systemctl --user restart omp-cloud");
	});

	test("without service.json it says to run setup", async () => {
		const testRig = await rig(dir);
		expect(await doctorMain([], testRig.ctx)).toBe(1);
		expect(testRig.out.join("")).toContain("fix: omp-cloud setup");
	});

	test("--json puts one report on stdout", async () => {
		const testRig = await healthyHost();
		expect(await doctorMain(["--json"], testRig.ctx)).toBe(0);
		expect(testRig.stdout).toHaveLength(1);
		const report: unknown = JSON.parse(testRig.stdout[0] ?? "");
		expect(report).toMatchObject({ ok: true, steps: expect.arrayContaining([expect.objectContaining({ id: "doctor.service", status: "ok" })]) });
	});

	test("an unknown flag is a usage error", async () => {
		const testRig = await rig(dir);
		expect(await doctorMain(["--bogus"], testRig.ctx)).toBe(2);
	});
});

const NODE_PIN = `sha256//${"A".repeat(43)}=`;

/** What a healthy node answers: ip is `/usr/bin/ip` here, as the fake host's `which` finds it. */
function nodeAnswers(argv: readonly string[]): Partial<CommandResult> | undefined {
	const line = argv.join(" ");
	if (line === "systemctl is-failed omp-cloud-vmon-sync.service") return { code: 1, stdout: "active\n" };
	if (line.endsWith("route get 192.168.1.20")) return { stdout: "192.168.1.20 dev eth0 src 192.168.1.5 uid 1000\n" };
	if (line.endsWith("route get 10.254.254.1")) return { stdout: "10.254.254.1 via 192.168.1.20 dev eth0 src 192.168.1.5\n" };
	if (line.includes("http://10.254.254.1:4000/healthz")) return { stdout: "200" };
	if (line.includes("http://10.254.254.1:8443/")) return { code: 7 };
	if (line.includes("/api/v1/health")) return { stdout: '{"status":"ok","vmon":"v0.4.0"}' };
	if (line === "/opt/vmon/vmon --version") return { stdout: "vmon 0.4.0\n" };
	return undefined;
}

describe("doctorMain on a vibemon node", () => {
	test("runs the node doctor, not the server's, and exits 0 when the node is healthy", async () => {
		const testRig = await rig(dir, { node: true, nodeEnv: `SERVER_URL=https://192.168.1.20:8443\nSERVER_PIN=${NODE_PIN}\n`, host: { respond: nodeAnswers } });
		expect(await doctorMain([], testRig.ctx)).toBe(0);
		const out = testRig.out.join("");
		for (const id of ["preflight.kvm", "doctor.node.config", "doctor.node.vmon", "doctor.node.net", "doctor.node.timer", "doctor.node.sync", "doctor.node.route", "doctor.node.gateway", "doctor.node.restriction", "doctor.node.vmon-version"]) expect(out).toContain(id);
		for (const id of ["doctor.service", "doctor.template", "doctor.config", "doctor.vmon-admin", "doctor.cluster", "units.omp-cloud", "plugin.check", "system.check.vmon"]) expect(out).not.toContain(id);
		expect(out.trimEnd().endsWith("0 failed")).toBe(true);
		// The server's probes are never touched: no service.json, no vmon key, no health fetch.
		expect(testRig.vmon.requests).toEqual([]);
		expect(testRig.host.lines().some((line) => line.includes("--user"))).toBe(false);
	});

	test("prints the fix beside a failure, exits 1, and --json carries the same steps", async () => {
		const testRig = await rig(dir, {
			node: true,
			nodeEnv: `SERVER_URL=https://192.168.1.20:8443\nSERVER_PIN=${NODE_PIN}\n`,
			host: { respond: (argv) => (argv.join(" ") === "/opt/vmon/vmon --version" ? { stdout: "vmon 0.3.9\n" } : nodeAnswers(argv)) },
		});
		expect(await doctorMain(["--json"], testRig.ctx)).toBe(1);
		expect(testRig.out.join("")).toContain("fix: sudo systemctl start omp-cloud-vmon-sync.service; journalctl -u omp-cloud-vmon-sync -n 20");
		const report: unknown = JSON.parse(testRig.stdout[0] ?? "");
		expect(report).toMatchObject({ ok: false, steps: expect.arrayContaining([expect.objectContaining({ id: "doctor.node.vmon-version", status: "failed" })]) });
	});

	test("a machine without node.env still gets the server doctor", async () => {
		const testRig = await rig(dir);
		expect(await doctorMain([], testRig.ctx)).toBe(1);
		expect(testRig.out.join("")).toContain("doctor.config");
		expect(testRig.out.join("")).not.toContain("doctor.node");
	});
});
