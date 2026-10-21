import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostOmp, parseOmpVersion, pathWithoutNodeBin } from "./omp-version";

describe("parseOmpVersion", () => {
	test("reads omp/X.Y.Z, with surrounding whitespace", () => {
		expect(parseOmpVersion("omp/18.12.3\n")).toBe("18.12.3");
		expect(parseOmpVersion("  omp/1.20.300 ")).toBe("1.20.300");
	});

	test.each(["", "18.12.3", "omp/18.12", "omp/18.12.3-beta", "omp 18.12.3", "omp/18.12.3\nextra", "error: nope"])("rejects %p", output => {
		expect(() => parseOmpVersion(output)).toThrow("omp --version");
	});
});

describe("hostOmp", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "omp-version-"));
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	/** An `omp` that prints `omp/<version>`, in `<where>/omp`. */
	async function fakeOmp(where: string, version: string): Promise<string> {
		await mkdir(where, { recursive: true });
		const bin = join(where, "omp");
		await writeFile(bin, `#!/bin/sh\necho omp/${version}\n`);
		await chmod(bin, 0o755);
		return bin;
	}

	/** A Tern root under `<dir>/data` whose `manager.json` is `manifest`; returns the data home. */
	async function ternRoot(manifest: string, version: string): Promise<{ dataHome: string; bin: string }> {
		const dataHome = join(dir, "data");
		const root = join(dataHome, "tern", "omp");
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "manager.json"), manifest);
		return { dataHome, bin: await fakeOmp(join(root, "bin"), version) };
	}

	test("a Tern marker selects its bin/omp over the first omp on PATH", async () => {
		const stale = join(dir, "stale");
		await fakeOmp(stale, "18.12.1");
		const tern = await ternRoot('{"manager":"tern","name":"Tern"}', "18.12.3");
		expect(await hostOmp({ PATH: `${stale}:/usr/bin`, XDG_DATA_HOME: tern.dataHome })).toEqual({ path: tern.bin, version: "18.12.3" });
	});

	test("the Tern root is found under $HOME/.local/share when XDG_DATA_HOME is unset", async () => {
		const home = join(dir, "home");
		const root = join(home, ".local", "share", "tern", "omp");
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "manager.json"), '{"manager":"tern"}');
		const bin = await fakeOmp(join(root, "bin"), "18.12.3");
		expect(await hostOmp({ PATH: "/usr/bin", HOME: home })).toEqual({ path: bin, version: "18.12.3" });
	});

	test.each([
		["no manager.json", undefined],
		["a manager.json naming another manager", '{"manager":"brew"}'],
		["a manager.json that is not JSON", "tern"],
		["a manager.json that is not an object", '"tern"'],
	])("falls back to the first omp on PATH with %s", async (_name, manifest) => {
		const onPath = join(dir, "path");
		const bin = await fakeOmp(onPath, "18.12.1");
		const dataHome = join(dir, "data");
		if (manifest !== undefined) await ternRoot(manifest, "18.12.3");
		expect(await hostOmp({ PATH: onPath, XDG_DATA_HOME: dataHome })).toEqual({ path: bin, version: "18.12.1" });
	});

	test("falls back to PATH when the marker is there but bin/omp is not", async () => {
		const onPath = join(dir, "path");
		const bin = await fakeOmp(onPath, "18.12.1");
		const tern = await ternRoot('{"manager":"tern"}', "18.12.3");
		await rm(tern.bin);
		expect(await hostOmp({ PATH: onPath, XDG_DATA_HOME: tern.dataHome })).toEqual({ path: bin, version: "18.12.1" });
	});

	test("PATH skips node_modules/.bin directories", async () => {
		const sdk = join(dir, "repo", "node_modules", ".bin");
		const real = join(dir, "real");
		await fakeOmp(sdk, "18.12.2");
		const bin = await fakeOmp(real, "18.12.3");
		const env = { PATH: `${sdk}:${real}`, XDG_DATA_HOME: join(dir, "no-data") };
		expect(pathWithoutNodeBin(env)).toBe(real);
		expect(await hostOmp(env)).toEqual({ path: bin, version: "18.12.3" });
	});

	test("throws when there is no omp at all", async () => {
		await expect(hostOmp({ PATH: join(dir, "empty"), XDG_DATA_HOME: join(dir, "no-data") })).rejects.toThrow("omp is not installed");
	});

	test("throws when omp --version fails", async () => {
		const onPath = join(dir, "path");
		await mkdir(onPath, { recursive: true });
		await writeFile(join(onPath, "omp"), "#!/bin/sh\necho boom >&2\nexit 3\n");
		await chmod(join(onPath, "omp"), 0o755);
		await expect(hostOmp({ PATH: onPath, XDG_DATA_HOME: join(dir, "no-data") })).rejects.toThrow("exited 3: boom");
	});
});
