import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeMnemopiBankScope } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { planMemoryBank, projectBankName, readMemorySettings, usesDefaultMnemopi } from "../src/mnemopi";
import { fakePi, fakeSettings, uninitializedSettings } from "./fakes";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

describe("projectBankName", () => {
	const long = `/home/ada/${"x".repeat(70)}`;
	const cases: [string, string, string | undefined][] = [
		["a plain path", "/home/ada/dev/app", undefined],
		["a 70-character basename", long, undefined],
		["a name with spaces and symbols", "/home/ada/My Project (v2)!", undefined],
		["a configured bank", "/home/ada/dev/app", "team"],
		["a configured bank that needs sanitizing", "/home/ada/dev/app", "  Team Bank/1  "],
		["a configured bank that is only symbols", "/home/ada/dev/app", "!!!"],
		["a configured bank of 70 characters", "/home/ada/dev/app", "b".repeat(70)],
		["a path with a trailing slash", "/home/ada/dev/app/", undefined],
		["a relative path", "dev/app", "team"],
		["the VM workspace", "/home/user/work", undefined],
	];
	for (const [name, cwd, configured] of cases) {
		test(`equals omp's own project bank: ${name}`, () => {
			expect(projectBankName(cwd, configured)).toBe(computeMnemopiBankScope(configured, cwd, "per-project").bank);
			expect(projectBankName(cwd, configured).length).toBeLessThanOrEqual(64);
		});
	}

	test("the VM and the laptop get different banks for the same project", () => {
		expect(projectBankName("/home/ada/dev/app", undefined)).not.toBe(projectBankName("/home/user/work", undefined));
	});
});

describe("readMemorySettings", () => {
	async function settings(global: string, ...overlays: string[]) {
		const dir = await tmp("omp-cloud-mem-");
		const files: string[] = [];
		for (const [i, text] of overlays.entries()) {
			const file = join(dir, `overlay-${i}.yml`);
			await writeFile(file, text);
			files.push(file);
		}
		return fakePi({ settings: await fakeSettings({ global, configFiles: files }) });
	}

	test("defaults: memory off, per-project scoping, no bank, no db path", async () => {
		const pi = await settings("");
		expect(await readMemorySettings(pi.pi, {})).toEqual({ backend: "off", scoping: "per-project", bank: undefined, dbPath: undefined });
	});

	test("reads nested keys of the global layer", async () => {
		const pi = await settings("memory:\n  backend: mnemopi\nmnemopi:\n  scoping: per-project-tagged\n  bank: team\n");
		expect(await readMemorySettings(pi.pi, {})).toEqual({ backend: "mnemopi", scoping: "per-project-tagged", bank: "team", dbPath: undefined });
	});

	test("--config overlays win over the global layer, later overlays over earlier ones", async () => {
		const pi = await settings("memory:\n  backend: mnemopi\nmnemopi:\n  bank: global\n", "mnemopi:\n  bank: first\n  scoping: global\n", "mnemopi:\n  bank: second\n");
		expect(await readMemorySettings(pi.pi, {})).toMatchObject({ backend: "mnemopi", scoping: "global", bank: "second" });
	});

	test("a dotted top-level key of an overlay counts, and a blank db path is unset", async () => {
		const pi = await settings("", 'memory.backend: mnemopi\n"mnemopi.dbPath": "  "\n');
		expect(await readMemorySettings(pi.pi, {})).toMatchObject({ backend: "mnemopi", dbPath: undefined });
	});

	test("an uninitialized settings proxy reads as the defaults", async () => {
		const pi = fakePi({ settings: uninitializedSettings() });
		expect(await readMemorySettings(pi.pi, { PI_CONFIG_FILES: "" })).toEqual({ backend: "off", scoping: "per-project", bank: undefined, dbPath: undefined });
	});
});

describe("planMemoryBank", () => {
	const mnemopi = { backend: "mnemopi", scoping: "per-project", bank: undefined, dbPath: undefined };

	test("renames this machine's bank to the VM's", () => {
		expect(planMemoryBank(mnemopi, "/home/ada/dev/app", "/home/user/work")).toEqual({
			from: projectBankName("/home/ada/dev/app", undefined),
			to: projectBankName("/home/user/work", undefined),
		});
		expect(planMemoryBank({ ...mnemopi, scoping: "per-project-tagged", bank: "team" }, "/a/b", "/home/user/work")?.from).toBe(projectBankName("/a/b", "team"));
	});

	test("no rename without mnemopi, with global scoping, a custom db path, or a service that reports no VM workspace", () => {
		expect(planMemoryBank({ ...mnemopi, backend: "off" }, "/a/b", "/home/user/work")).toBeUndefined();
		expect(planMemoryBank({ ...mnemopi, backend: "hindsight" }, "/a/b", "/home/user/work")).toBeUndefined();
		expect(planMemoryBank({ ...mnemopi, scoping: "global" }, "/a/b", "/home/user/work")).toBeUndefined();
		expect(planMemoryBank({ ...mnemopi, dbPath: "/data/m.db" }, "/a/b", "/home/user/work")).toBeUndefined();
		expect(planMemoryBank(mnemopi, "/a/b", "")).toBeUndefined();
	});

	test("usesDefaultMnemopi: mnemopi and no db path", () => {
		expect(usesDefaultMnemopi(mnemopi)).toBe(true);
		expect(usesDefaultMnemopi({ ...mnemopi, dbPath: "/x" })).toBe(false);
		expect(usesDefaultMnemopi({ ...mnemopi, backend: "local" })).toBe(false);
	});
});
