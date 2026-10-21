import { describe, expect, test } from "bun:test";
import { applyRunning, AUTO_QUIET_MS, autoDecision, type AutoInput, APPLY_STALE_MS, CHECKOUT_MESSAGE, deriveState, readyRelease } from "./policy";
import { emptyState, type UpdateStateFile } from "./state";
import { makeManifest } from "./test-support";

const SAFE: AutoInput = {
	ready: true,
	busyThreads: 0,
	quietMs: AUTO_QUIET_MS,
	vmonInstalled: "v0.4.0",
	manifest: makeManifest("0.5.1"),
	schema: 10,
};

describe("autoDecision", () => {
	test("installs only when ready, nothing is busy for 10 minutes, vibemon and the schema are unchanged", () => {
		expect(autoDecision(SAFE)).toEqual({ apply: true, reason: "no thread is busy, vibemon and the schema are unchanged" });
	});

	const table: [string, Partial<AutoInput>, string][] = [
		["nothing staged", { ready: false }, "nothing is ready"],
		["one thread busy", { busyThreads: 1 }, "1 thread is starting, working or waiting"],
		["three threads busy", { busyThreads: 3 }, "3 threads are starting, working or waiting"],
		["quiet for 9m59s", { quietMs: AUTO_QUIET_MS - 1 }, "a thread was busy less than 10 minutes ago"],
		["a different vibemon is installed", { vmonInstalled: "v0.3.9" }, "the release needs vibemon v0.4.0, v0.3.9 is installed"],
		["vibemon unreadable", { vmonInstalled: null }, "the release needs vibemon v0.4.0, none is installed"],
		["a newer schema", { manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 11 } }) }, "the release needs database schema 11, the database is at 10"],
		["a release needing another vibemon", { manifest: makeManifest("0.5.1", undefined, { requires: { vmon: { version: "v0.5.0" }, omp: { min: "18.12.3" }, schema: 10 } }) }, "the release needs vibemon v0.5.0, v0.4.0 is installed"],
	];
	for (const [name, change, reason] of table) {
		test(`stays ready for a click: ${name}`, () => {
			expect(autoDecision({ ...SAFE, ...change })).toEqual({ apply: false, reason });
		});
	}
});

function file(change: (state: UpdateStateFile) => void): UpdateStateFile {
	const state = emptyState();
	change(state);
	return state;
}

const NOW = Date.parse("2026-10-21T12:00:00Z");

describe("deriveState", () => {
	const manifest = makeManifest("0.5.1");
	const staged = (state: UpdateStateFile): void => {
		state.latest = { manifest, publishedAt: "p" };
		state.staged = "0.5.1";
	};
	const derive = (state: UpdateStateFile, over: { managed?: boolean; phase?: "checking" | "downloading" | null } = {}) =>
		deriveState({ managed: over.managed ?? true, file: state, currentVersion: "0.5.0", phase: over.phase ?? null, nowMs: NOW });

	test("a checkout is unsupported whatever else the file says", () => {
		expect(derive(file(staged), { managed: false })).toBe("unsupported");
		expect(CHECKOUT_MESSAGE).toBe("this omp-cloud runs from a git checkout; update it with git pull and restart it");
	});

	test("idle, ready, failed, and what this process is doing", () => {
		expect(derive(emptyState())).toBe("idle");
		expect(derive(file(staged))).toBe("ready");
		expect(derive(file((state) => (state.error = "boom")))).toBe("failed");
		expect(derive(file((state) => { staged(state); state.error = "rolled back"; }))).toBe("failed");
		expect(derive(emptyState(), { phase: "checking" })).toBe("checking");
		expect(derive(emptyState(), { phase: "downloading" })).toBe("downloading");
	});

	test("a staged release that is not newer than the running one is not ready", () => {
		expect(derive(file((state) => { staged(state); state.staged = "0.5.1"; }))).toBe("ready");
		expect(deriveState({ managed: true, file: file(staged), currentVersion: "0.5.1", phase: null, nowMs: NOW })).toBe("idle");
		expect(readyRelease(file(staged), "0.6.0")).toBeNull();
		expect(readyRelease(file((state) => { staged(state); state.staged = "0.5.2"; }), "0.5.0")).toBeNull();
	});

	test("an apply in progress shows applying, until its record is older than 15 minutes", () => {
		const applying = (ago: number) =>
			file((state) => {
				staged(state);
				state.applying = { version: "0.5.1", step: "vmon", startedAt: new Date(NOW - ago).toISOString(), from: "0.5.0", backup: "" };
			});
		expect(derive(applying(60_000), { phase: "checking" })).toBe("applying");
		expect(applyRunning(applying(APPLY_STALE_MS - 1), NOW)).toBe(true);
		expect(applyRunning(applying(APPLY_STALE_MS), NOW)).toBe(false);
		expect(applyRunning(emptyState(), NOW)).toBe(false);
		expect(derive(applying(APPLY_STALE_MS + 1))).toBe("ready");
	});
});
