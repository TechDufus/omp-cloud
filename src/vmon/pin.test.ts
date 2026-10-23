import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperVerdict, installedVmonVersion, VMON_HELPER_PATH, VMON_HELPER_SCRIPT, VMON_PIN, VMON_SYNC_PATH, VMON_SYNC_SCRIPT, vmonHelper, runVmonHelper } from "./pin";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-pin-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function script(name: string, body: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
	return path;
}

describe("VMON_PIN", () => {
	test("is the tag in infra/vmon.json", async () => {
		const file: unknown = await Bun.file(join(import.meta.dir, "..", "..", "infra", "vmon.json")).json();
		expect(file).toEqual({ version: VMON_PIN });
		expect(VMON_PIN).toMatch(/^v\d+\.\d+\.\d+$/);
	});
});

describe("VMON_HELPER_SCRIPT", () => {
	test("is infra/vmon-install.sh byte for byte, carried by the binary", async () => {
		const file = await Bun.file(join(import.meta.dir, "..", "..", "infra", "vmon-install.sh")).text();
		expect(VMON_HELPER_SCRIPT).toBe(file);
		expect(VMON_HELPER_SCRIPT.startsWith("#!/usr/bin/env bash\n")).toBe(true);
		expect(VMON_HELPER_PATH).toBe("/usr/local/libexec/omp-cloud/vmon-install");
	});
});

describe("VMON_SYNC_SCRIPT", () => {
	test("is infra/vmon-sync.sh byte for byte, carried by the binary", async () => {
		const file = await Bun.file(join(import.meta.dir, "..", "..", "infra", "vmon-sync.sh")).text();
		expect(VMON_SYNC_SCRIPT).toBe(file);
		expect(VMON_SYNC_SCRIPT.startsWith("#!/usr/bin/env bash\n")).toBe(true);
		expect(VMON_SYNC_PATH).toBe("/usr/local/libexec/omp-cloud/vmon-sync");
	});
});

describe("helperVerdict", () => {
	test("reads the last stdout line", () => {
		expect(helperVerdict('progress\n{"ok": true, "version": "v0.4.0"}\n')).toEqual({ ok: true });
		expect(helperVerdict('{"ok": false, "error": "no"}')).toEqual({ ok: false, error: "no" });
		expect(helperVerdict('{"ok": false}')).toEqual({ ok: false, error: "the helper failed without a reason" });
		expect(helperVerdict("")).toBeNull();
		expect(helperVerdict("done")).toBeNull();
		expect(helperVerdict('{"fine": 1}')).toBeNull();
	});
});

describe("installedVmonVersion", () => {
	test("turns `vmon 0.4.0` into the tag v0.4.0", async () => {
		expect(await installedVmonVersion(await script("vmon", 'echo "vmon 0.4.0"'))).toBe("v0.4.0");
	});

	test("is null for a missing binary, a failing one and one that does not say its version", async () => {
		expect(await installedVmonVersion(join(dir, "absent"))).toBeNull();
		expect(await installedVmonVersion(await script("fails", "exit 3"))).toBeNull();
		expect(await installedVmonVersion(await script("odd", 'echo "something 0.4.0"'))).toBeNull();
		expect(await installedVmonVersion(await script("garbled", 'echo "vmon latest"'))).toBeNull();
	});
});

describe("vmonHelper", () => {
	test("is unavailable when the helper file does not exist", async () => {
		expect(await vmonHelper(join(dir, "vmon-install"))).toEqual({ available: false });
	});
});

describe("runVmonHelper", () => {
	test("resolves when the helper's last line says ok and passes the tag as its only argument", async () => {
		const argsFile = join(dir, "args");
		const helper = await script("helper", `echo "$@" > ${argsFile}\necho progress\necho '{"ok": true, "version": "v0.4.1"}'`);
		await runVmonHelper("v0.4.1", [helper]);
		expect((await Bun.file(argsFile).text()).trim()).toBe("v0.4.1");
	});

	test("throws the helper's own error text, a rollback included", async () => {
		const helper = await script("helper", `echo '{"ok": false, "error": "vmon v0.4.1 did not answer; rolled back to vmon 0.4.0"}'\nexit 1`);
		await expect(runVmonHelper("v0.4.1", [helper])).rejects.toThrow("rolled back to vmon 0.4.0");
	});

	test("an ok verdict with a failing exit status is a failure", async () => {
		const helper = await script("helper", `echo '{"ok": true, "version": "v0.4.1"}'\nexit 1`);
		await expect(runVmonHelper("v0.4.1", [helper])).rejects.toThrow("exited 1");
	});

	test("an exit without a verdict names the last line of stderr", async () => {
		const helper = await script("helper", 'echo "sudo: a password is required" >&2\nexit 1');
		await expect(runVmonHelper("v0.4.1", [helper])).rejects.toThrow("a password is required");
	});

	test("a tag that is not v<x>.<y>.<z> is refused before anything runs", async () => {
		const ran = join(dir, "ran");
		const helper = await script("helper", `touch ${ran}`);
		for (const tag of ["0.4.1", "v0.4", "v0.4.1; reboot", ""]) await expect(runVmonHelper(tag, [helper])).rejects.toThrow("not a vmon tag");
		expect(await Bun.file(ran).exists()).toBe(false);
	});

	test("a helper that cannot start is an error, not a hang", async () => {
		await expect(runVmonHelper("v0.4.1", [join(dir, "missing")])).rejects.toThrow("could not run");
	});
});
