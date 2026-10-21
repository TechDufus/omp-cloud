import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BUILD, SERVICE_VERSION } from "./version";

const BIN = join(import.meta.dir, "bin.ts");

async function bin(...args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", BIN, ...args], { env: { ...process.env, OMP_CLOUD_CONFIG: "" }, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, out, err };
}

describe("omp-cloud entry (src/bin.ts)", () => {
	test("version prints the version and the build id on one line", async () => {
		expect(await bin("version")).toEqual({ code: 0, out: `omp-cloud ${SERVICE_VERSION} (${BUILD.id})\n`, err: "" });
	});

	test("--help lists every command", async () => {
		const { code, out } = await bin("--help");
		expect(code).toBe(0);
		for (const command of ["serve", "setup", "doctor", "login", "uninstall", "ssh-pair", "update", "install", "backup", "version"]) expect(out).toContain(`  ${command}`);
	});

	test("an unknown command exits 2 and names it; nothing is started", async () => {
		const { code, out, err } = await bin("frobnicate");
		expect(code).toBe(2);
		expect(out).toBe("");
		expect(err).toContain('unknown command "frobnicate"');
	});

	test("ssh-pair through the entry keeps its contract: one JSON line on stdout, exit 1 on failure", async () => {
		const { code, out } = await bin("ssh-pair", "--name", "bad/name", "--platform", "linux");
		expect(code).toBe(1);
		expect(out.trimEnd().split("\n")).toHaveLength(1);
		expect(JSON.parse(out)).toMatchObject({ ompCloudPair: 1, error: expect.stringContaining("invalid name") });
	});

	test("serve refuses an unknown argument before anything starts", async () => {
		const { code, err } = await bin("serve", "--bogus");
		expect(code).toBe(1);
		expect(err).toContain('unknown argument "--bogus"');
	});

	test.each([["setup"], ["doctor"], ["uninstall"], ["login"]])("%s rejects an unknown flag with exit 2 and a usage line", async (command) => {
		const { code, out, err } = await bin(command, "--bogus");
		expect(code).toBe(2);
		expect(out).toBe("");
		expect(err).toContain("usage: omp-cloud");
	});

	test("setup under bun without --checkout refuses before touching anything", async () => {
		const { code, err } = await bin("setup", "--yes");
		expect(code).toBe(1);
		expect(err).toContain("run omp-cloud setup from a release binary, or mise run infra:up in a checkout");
	});

	test("the internal setup system refuses to run as a normal user", async () => {
		const { code, out } = await bin("setup", "system", "--user", "nobody");
		expect(code).not.toBe(0);
		expect(out.trimEnd().split("\n").at(-1)).toContain('"ok":false');
	});
});
