import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultServiceConfig, ensureDirs, writeVmonKey } from "./config";
import { doctorMain } from "./doctor";
import { rig, type TestRig } from "./test-support";

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
