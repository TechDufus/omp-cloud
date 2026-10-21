import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "../backup";
import { Settings } from "../settings";
import { Store } from "../store";
import { MIGRATIONS } from "../store/schema";
import { readSchemaVersion, readUpdateSettings, restoreDatabase } from "./db";
import { runCommand } from "./system";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-udb-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("the database as the updater reads it", () => {
	test("schema version is the file's user_version; a missing database throws", () => {
		expect(() => readSchemaVersion(dir)).toThrow();
		Store.open({ dataDir: dir }).close();
		expect(readSchemaVersion(dir)).toBe(MIGRATIONS.length);
	});

	test("update.* settings come from the stored values, defaults otherwise, and a missing database gives the defaults", () => {
		expect(readUpdateSettings(join(dir, "nowhere"))).toEqual({ mode: "notify", feed: "github:TechDufus/omp-cloud", token: "", unit: "omp-cloud", ompUnits: ["omp-auth-broker", "omp-auth-gateway"] });
		const store = Store.open({ dataDir: dir });
		expect(readUpdateSettings(dir).mode).toBe("notify");
		const settings = Settings.load(store);
		settings.apply({ "update.mode": "auto", "update.feed": "https://feed.example.test/omp", "update.token": "!/usr/bin/gh auth token", "update.unit": "omp-cloud-dev" }, "owner");
		store.close();
		expect(readUpdateSettings(dir)).toEqual({ mode: "auto", feed: "https://feed.example.test/omp", token: "!/usr/bin/gh auth token", unit: "omp-cloud-dev", ompUnits: ["omp-auth-broker", "omp-auth-gateway"] });
	});

	test("a stored value the validator refuses falls back to the default", () => {
		const store = Store.open({ dataDir: dir });
		store.applySettings([{ key: "update.mode", value: '"sometimes"' }, { key: "update.unit", value: '"bad unit"' }], "owner", "set");
		store.close();
		expect(readUpdateSettings(dir)).toMatchObject({ mode: "notify", unit: "omp-cloud" });
	});

	test("update.ompUnits: the default is the broker and gateway; a stored list, also an empty one, is read; a bad one falls back", () => {
		expect(readUpdateSettings(join(dir, "nowhere")).ompUnits).toEqual(["omp-auth-broker", "omp-auth-gateway"]);
		const store = Store.open({ dataDir: dir });
		Settings.load(store).apply({ "update.ompUnits": [] }, "owner");
		store.close();
		expect(readUpdateSettings(dir).ompUnits).toEqual([]);
		const again = Store.open({ dataDir: dir });
		Settings.load(again).apply({ "update.ompUnits": ["a.service", "b"] }, "owner");
		again.applySettings([{ key: "update.unit", value: '"bad unit"' }], "owner", "set");
		again.close();
		expect(readUpdateSettings(dir).ompUnits).toEqual(["a.service", "b"]);
		const bad = Store.open({ dataDir: dir });
		bad.applySettings([{ key: "update.ompUnits", value: '["bad unit"]' }], "owner", "set");
		bad.close();
		expect(readUpdateSettings(dir).ompUnits).toEqual(["omp-auth-broker", "omp-auth-gateway"]);
	});

	test("restoreDatabase puts a backup's database back: what was written after the backup is gone", async () => {
		const dataDir = join(dir, "data");
		await mkdir(dataDir);
		let store = Store.open({ dataDir });
		Settings.load(store).apply({ "update.mode": "off" }, "owner");
		store.close();
		const archive = (await backup({ dataDir, keep: 3 })).path;
		store = Store.open({ dataDir });
		Settings.load(store).apply({ "update.mode": "auto" }, "owner");
		store.close();
		expect(readUpdateSettings(dataDir).mode).toBe("auto");

		await restoreDatabase(runCommand, archive, dataDir);

		expect(readUpdateSettings(dataDir).mode).toBe("off");
		expect(readSchemaVersion(dataDir)).toBe(MIGRATIONS.length);
		expect((await readdir(dataDir)).filter((name) => name.startsWith(".restore-"))).toEqual([]);
		// The restored database opens as the service would open it.
		Store.open({ dataDir }).close();
	});

	test("restoreDatabase with an archive that has no database fails and leaves the live one alone", async () => {
		const dataDir = join(dir, "data");
		await mkdir(dataDir);
		Store.open({ dataDir }).close();
		await expect(restoreDatabase(runCommand, join(dir, "missing.tar.gz"), dataDir)).rejects.toThrow("tar could not read omp-cloud.db");
		expect(readSchemaVersion(dataDir)).toBe(MIGRATIONS.length);
		expect((await readdir(dataDir)).filter((name) => name.startsWith(".restore-"))).toEqual([]);
	});
});
