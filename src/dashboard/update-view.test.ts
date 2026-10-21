import { describe, expect, test } from "bun:test";
import type { UpdateStatus } from "./client/api";
import { checkedText, isMoving, type PillInput, pendingStillApplies, pillOf, UPDATED_VISIBLE_MS, vmonRow } from "./client/app/update";

const NOW = Date.parse("2026-10-21T12:00:00Z");

/** An up-to-date, managed install; each test changes what it is about. */
function status(change: Partial<UpdateStatus> = {}): UpdateStatus {
	return {
		mode: "notify",
		managed: true,
		state: "idle",
		current: { version: "0.5.0", build: { id: "20261021-100000-abc1234", commit: "abc1234", createdAt: "2026-10-21T10:00:00Z" } },
		latest: { version: "0.5.0", notes: "First release.", publishedAt: "2026-10-21T10:05:00Z" },
		staged: null,
		applying: null,
		error: null,
		message: null,
		checkedAt: "2026-10-21T11:55:00Z",
		last: null,
		components: {
			vmon: { installed: "v0.4.0", required: "v0.4.0", helper: true },
			omp: { host: "18.12.4", broker: "18.12.4", gateway: "18.12.4" },
		},
		...change,
	};
}

function pill(current: UpdateStatus | undefined, change: Partial<PillInput> = {}) {
	return pillOf({ status: current, pending: null, seen: null, unreachable: false, refusal: null, now: NOW, ...change });
}

describe("pillOf", () => {
	test("shows nothing when up to date, checking, unsupported or before the first status", () => {
		expect(pill(undefined)).toBeNull();
		expect(pill(status())).toBeNull();
		expect(pill(status({ state: "checking" }))).toBeNull();
		expect(pill(status({ state: "unsupported", managed: false }))).toBeNull();
	});

	test("downloading names the release being fetched", () => {
		const latest = { version: "0.5.1", notes: "", publishedAt: "2026-10-21T11:00:00Z" };
		expect(pill(status({ state: "downloading", latest }))).toEqual({ kind: "downloading", version: "0.5.1" });
	});

	test("ready prefers the staged version over the latest one", () => {
		const latest = { version: "0.5.2", notes: "", publishedAt: "2026-10-21T11:00:00Z" };
		expect(pill(status({ state: "ready", staged: "0.5.1", latest }))).toEqual({ kind: "ready", version: "0.5.1" });
		expect(pill(status({ state: "ready", staged: null, latest }))).toEqual({ kind: "ready", version: "0.5.2" });
	});

	test("applying reads the step in words and keeps an unknown step as it is", () => {
		const applying = (step: string) => status({ state: "applying", applying: { version: "0.5.1", step, startedAt: "2026-10-21T11:59:00Z" } });
		expect(pill(applying("swap"))).toEqual({ kind: "applying", version: "0.5.1", step: "switching to the new version" });
		expect(pill(applying("rollback"))).toEqual({ kind: "applying", version: "0.5.1", step: "rolling back" });
		expect(pill(applying("future-step"))).toEqual({ kind: "applying", version: "0.5.1", step: "future-step" });
	});

	test("failed carries the error and retries the apply only while a staged release remains", () => {
		expect(pill(status({ state: "failed", error: "health check failed", staged: "0.5.1" }))).toEqual({
			kind: "failed",
			error: "health check failed",
			retry: "apply",
		});
		expect(pill(status({ state: "failed", error: "feed unreachable", staged: null }))).toEqual({
			kind: "failed",
			error: "feed unreachable",
			retry: "check",
		});
		const last = { version: "0.5.1", notes: "", at: "2026-10-21T11:58:00Z", result: "failed" as const, message: "rolled back to 0.5.0" };
		expect(pill(status({ state: "failed", error: null, last }))).toMatchObject({ error: "rolled back to 0.5.0" });
	});

	test("a refused click shows as a failed pill ahead of the status", () => {
		expect(pill(status({ state: "ready", staged: "0.5.1" }), { refusal: "an update is already being applied" })).toEqual({
			kind: "failed",
			error: "an update is already being applied",
			retry: "apply",
		});
	});

	test("an unreachable service is a restart only while this browser waits for one", () => {
		expect(pill(status({ state: "applying" }), { unreachable: true, pending: "0.5.1" })).toEqual({ kind: "restarting", version: "0.5.1" });
		expect(pill(status(), { unreachable: true })).toBeNull();
	});

	describe("updated", () => {
		const last = { version: "0.5.1", notes: "Fixes.", at: "2026-10-21T11:00:00Z", result: "installed" as const, message: "" };
		const installed = status({ current: { ...status().current, version: "0.5.1" }, last });

		test("shows the applied release's notes once the new version runs", () => {
			expect(pill(installed)).toEqual({ kind: "updated", version: "0.5.1", notes: "Fixes." });
		});

		test("is gone once dismissed, when old, or when another version runs", () => {
			expect(pill(installed, { seen: "0.5.1" })).toBeNull();
			expect(pill(installed, { now: Date.parse(last.at) + UPDATED_VISIBLE_MS + 1 })).toBeNull();
			expect(pill(status({ last }))).toBeNull();
		});

		test("does not report a failed apply as an update", () => {
			const failed = { ...last, result: "failed" as const, message: "rolled back" };
			expect(pill(status({ current: installed.current, last: failed }))).toBeNull();
		});
	});
});

describe("pendingStillApplies", () => {
	test("holds through the states of an apply and ends at the new version or a stopped apply", () => {
		expect(pendingStillApplies(status({ state: "ready", staged: "0.5.1" }), "0.5.1")).toBe(true);
		expect(pendingStillApplies(status({ state: "applying" }), "0.5.1")).toBe(true);
		expect(pendingStillApplies(status(), "0.5.1")).toBe(false);
		expect(pendingStillApplies(status({ state: "failed", error: "x" }), "0.5.1")).toBe(false);
		expect(pendingStillApplies(status({ state: "ready" }), "0.5.0")).toBe(false);
	});
});

describe("isMoving", () => {
	test("polls fast while something runs or this browser waits for the swap", () => {
		expect(isMoving(status(), null)).toBe(false);
		expect(isMoving(undefined, null)).toBe(false);
		expect(isMoving(status({ state: "downloading" }), null)).toBe(true);
		expect(isMoving(status({ state: "applying" }), null)).toBe(true);
		expect(isMoving(status({ state: "ready" }), null)).toBe(false);
		expect(isMoving(status({ state: "ready" }), "0.5.1")).toBe(true);
	});
});

describe("checkedText", () => {
	test("says when the feed was last asked", () => {
		expect(checkedText(status(), NOW)).toBe("checked 5 min ago");
		expect(checkedText(status({ checkedAt: null }), NOW)).toBe("Not checked yet");
	});
});

describe("vmonRow", () => {
	test("compares the installed vibemon with the one this release needs", () => {
		expect(vmonRow({ installed: "v0.4.0", required: "v0.4.0", helper: true })).toEqual({ text: "v0.4.0 · matches this release", tone: "ok" });
		expect(vmonRow({ installed: "v0.3.9", required: "v0.4.0", helper: true })).toEqual({ text: "v0.3.9 installed · v0.4.0 required", tone: "warn" });
		expect(vmonRow({ installed: null, required: "v0.4.0", helper: false })).toEqual({
			text: "not installed · v0.4.0 required · root helper missing",
			tone: "warn",
		});
		expect(vmonRow({ installed: "v0.4.0", required: null, helper: false })).toEqual({ text: "v0.4.0", tone: "neutral" });
	});
});
