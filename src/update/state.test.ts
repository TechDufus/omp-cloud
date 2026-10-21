import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, parseState, StateStore } from "./state";
import { makeManifest } from "./test-support";

let dir: string;
let file: string;
let lock: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-state-"));
	file = join(dir, "state.json");
	lock = join(dir, "state.lock");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const noSleep = async (): Promise<void> => {
	await Promise.resolve();
};

describe("StateStore", () => {
	test("a missing or unreadable file reads as the empty state; an update creates it atomically", async () => {
		const store = new StateStore(file, lock);
		expect(await store.read()).toEqual(emptyState());
		await writeFile(file, "{not json");
		expect(await store.read()).toEqual(emptyState());

		const written = await store.update((state) => {
			state.checked = "2026-10-21T00:00:00.000Z";
			state.staged = "0.5.1";
		});
		expect(written.checked).toBe("2026-10-21T00:00:00.000Z");
		expect(await store.read()).toEqual(written);
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, staged: "0.5.1" });
		// No temporary file and no lock are left.
		expect(await readdir(dir)).toEqual(["state.json"]);
	});

	test("concurrent updates are serialised: none is lost", async () => {
		const store = new StateStore(file, lock);
		const other = new StateStore(file, lock);
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				(i % 2 === 0 ? store : other).update((state) => {
					state.previous = `${state.previous ?? ""}${i.toString(16)}`;
				}),
			),
		);
		const previous = (await store.read()).previous ?? "";
		expect([...previous].sort().join("")).toBe("0123456789ab");
	});

	test("a lock whose owner is gone is broken at once; a live owner's lock is waited for, then refused", async () => {
		await writeFile(lock, "999999");
		const dead = new StateStore(file, lock, { alive: () => false, sleep: noSleep });
		await dead.update((state) => {
			state.error = "x";
		});
		expect((await dead.read()).error).toBe("x");

		await writeFile(lock, String(process.pid));
		const sleeps: number[] = [];
		let ticks = 0;
		const held = new StateStore(file, lock, {
			alive: () => true,
			waitMs: 50,
			sleep: async (ms) => {
				sleeps.push(ms);
				ticks++;
				await Bun.sleep(ms);
			},
		});
		await expect(held.update(() => undefined)).rejects.toThrow(`the update state is locked by another process (${lock})`);
		expect(ticks).toBeGreaterThan(0);
		expect(sleeps.every((ms) => ms === 25)).toBe(true);
	});

	test("an old lock is stale even when its pid answers, and a lock with garbage in it is broken", async () => {
		await writeFile(lock, String(process.pid));
		const old = new Date(Date.now() - 120_000);
		await utimes(lock, old, old);
		const store = new StateStore(file, lock, { alive: () => true, staleMs: 30_000, sleep: noSleep });
		await store.update((state) => {
			state.error = "after stale";
		});
		expect((await store.read()).error).toBe("after stale");

		await writeFile(lock, "not a pid");
		await store.update((state) => {
			state.error = "after garbage";
		});
		expect((await store.read()).error).toBe("after garbage");
	});

	test("a failing change leaves the file as it was and releases the lock", async () => {
		const store = new StateStore(file, lock);
		await store.update((state) => {
			state.staged = "0.5.1";
		});
		await expect(
			store.update((state) => {
				state.staged = "0.5.2";
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect((await store.read()).staged).toBe("0.5.1");
		expect(await readdir(dir)).toEqual(["state.json"]);
	});
});

describe("parseState", () => {
	test("keeps what is valid and drops what is not, so a damaged file never blocks an update", () => {
		const manifest = makeManifest("0.5.1");
		const parsed = parseState({
			version: 1,
			checked: "2026-10-21T00:00:00.000Z",
			latest: { manifest, publishedAt: "2026-10-21T01:00:00Z" },
			staged: "0.5.1",
			applying: { version: "0.5.1", step: "swap", startedAt: "2026-10-21T02:00:00Z", from: "0.5.0", backup: "" },
			error: "boom",
			installed: "0.5.0",
			previous: "0.4.0",
			last: { version: "0.5.0", notes: "n", at: "t", result: "installed", message: "ok" },
		});
		expect(parsed.latest?.manifest).toEqual(manifest);
		expect(parsed.applying).toEqual({ version: "0.5.1", step: "swap", startedAt: "2026-10-21T02:00:00Z", from: "0.5.0", backup: "" });
		expect(parsed.last?.result).toBe("installed");

		const damaged = parseState({
			staged: "v0.5.1",
			latest: { manifest: { product: "nope" }, publishedAt: "x" },
			applying: { version: "0.5.1", step: "teleport", startedAt: "t", from: "0.5.0", backup: "" },
			last: { version: "1", result: "maybe" },
			error: 5,
		});
		expect(damaged).toEqual(emptyState());
		expect(parseState("nope")).toEqual(emptyState());
	});
});
