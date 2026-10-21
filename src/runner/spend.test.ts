import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../settings";
import { Store } from "../store";
import type { ThreadPolicy } from "../settings/policy";
import type { NewThread, TurnResult } from "../store/types";
import { breachOf, checkSpend, type SpendCaps, spendCapError, utcDay } from "./spend";

const NONE: SpendCaps = { turn: 0, thread: 0, day: 0 };

describe("breachOf", () => {
	test("no cap set is never a breach", () => {
		expect(breachOf(NONE, { turn: 100, thread: 100, day: 100 }, "during")).toBeNull();
		expect(breachOf(NONE, { turn: 100, thread: 100, day: 100 }, "before")).toBeNull();
	});

	test("during a turn a cap is crossed by spending more than it, not by meeting it", () => {
		const caps = { ...NONE, turn: 0.1 };
		expect(breachOf(caps, { turn: 0.1, thread: 0, day: 0 }, "during")).toBeNull();
		expect(breachOf(caps, { turn: 0.132, thread: 0, day: 0 }, "during")).toEqual({ scope: "turn", spent: 0.132, cap: 0.1 });
	});

	test("the thread and day totals count the running turn", () => {
		expect(breachOf({ ...NONE, thread: 1 }, { turn: 0.2, thread: 1.2, day: 0 }, "during")).toEqual({ scope: "thread", spent: 1.2, cap: 1 });
		expect(breachOf({ ...NONE, day: 5 }, { turn: 0.2, thread: 0.2, day: 5.2 }, "during")).toEqual({ scope: "day", spent: 5.2, cap: 5 });
	});

	test("the first crossed cap in the order turn, thread, day is reported", () => {
		const caps = { turn: 1, thread: 1, day: 1 };
		expect(breachOf(caps, { turn: 2, thread: 2, day: 2 }, "during")?.scope).toBe("turn");
		expect(breachOf(caps, { turn: 0.5, thread: 2, day: 2 }, "during")?.scope).toBe("thread");
		expect(breachOf(caps, { turn: 0.5, thread: 0.5, day: 2 }, "during")?.scope).toBe("day");
		expect(breachOf(caps, { turn: 0.5, thread: 0.5, day: 0.5 }, "during")).toBeNull();
	});

	test("before a turn a thread or day already at its cap is a breach, and the turn cap is not judged", () => {
		expect(breachOf({ ...NONE, thread: 1 }, { turn: 0, thread: 1, day: 0 }, "before")).toEqual({ scope: "thread", spent: 1, cap: 1 });
		expect(breachOf({ ...NONE, day: 1 }, { turn: 0, thread: 0, day: 1.5 }, "before")).toEqual({ scope: "day", spent: 1.5, cap: 1 });
		expect(breachOf({ ...NONE, thread: 1 }, { turn: 0, thread: 0.99, day: 0 }, "before")).toBeNull();
		expect(breachOf({ ...NONE, turn: 0.1 }, { turn: 0, thread: 0, day: 0 }, "before")).toBeNull();
	});
});

describe("spendCapError", () => {
	test("names the scope, four decimals of the spend and the cap", () => {
		expect(spendCapError({ scope: "turn", spent: 0.132, cap: 0.1 })).toBe("spend cap reached: turn spend 0.1320 USD is over the 0.1 USD cap");
		expect(spendCapError({ scope: "thread", spent: 12, cap: 10 })).toBe("spend cap reached: thread spend 12.0000 USD is over the 10 USD cap");
		expect(spendCapError({ scope: "day", spent: 3.14159, cap: 3 })).toBe("spend cap reached: day spend 3.1416 USD is over the 3 USD cap");
	});
});

describe("utcDay", () => {
	test("is the instant's UTC day, whatever the local zone", () => {
		expect(utcDay(new Date("2026-10-20T23:59:59.999Z"))).toBe("2026-10-20");
		expect(utcDay(new Date("2026-10-20T00:00:00.000Z"))).toBe("2026-10-20");
		expect(utcDay(new Date("2026-10-20T01:30:00+05:00"))).toBe("2026-10-19");
	});
});

describe("checkSpend", () => {
	let dir: string;
	let store: Store;
	let settings: Settings;
	const NOW = new Date("2026-10-20T12:00:00.000Z");

	const thread = (id: string, owner = "owner"): NewThread => ({
		owner,
		title: id,
		prompt: "go",
		model: "",
		thinking: "",
		repo: { name: "p", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "a".repeat(40), localBranch: "" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		configOverlays: [],
		ompVersion: "",
		policy: {},
		secretFiles: [],
		secretEnv: [],
	});

	const result = (cost: number): TurnResult => ({
		outcome: "completed",
		error: "",
		reply: "ok",
		usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost },
		head: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		pushed: false,
		pushError: "",
		pushRef: "",
	});

	let clock = NOW;

	/** Completes the first turn of a new thread at `at` with `cost`. */
	function spent(id: string, cost: number, at: Date, owner = "owner"): void {
		clock = at;
		store.createThread(id, thread(id, owner));
		store.startNextTurn(id);
		store.completeTurn(id, 1, result(cost));
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "omp-cloud-spend-"));
		clock = NOW;
		store = Store.open({ dataDir: dir, now: () => clock });
		settings = Settings.load(store);
	});

	afterEach(async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
	});

	/** The thread checkSpend judges: its id and the policy it tightened. */
	const ref = (id: string, policy: ThreadPolicy = {}) => ({ id, policy });

	const guarded = {
		getThread: () => {
			throw new Error("store read");
		},
		spend: () => {
			throw new Error("store read");
		},
		daySpend: () => {
			throw new Error("store read");
		},
	};

	test("reads nothing from the store while no cap is set", () => {
		expect(checkSpend({ store: guarded, settings }, ref("aaaaaaaaaaaa"), 50, "during", NOW)).toBeNull();
	});

	test("the turn cap needs no store: it judges the running turn's cost", () => {
		settings.apply({ "policy.spend.turnUSD": 0.1 }, "owner");
		expect(checkSpend({ store: guarded, settings }, ref("aaaaaaaaaaaa"), 0.09, "during", NOW)).toBeNull();
		expect(checkSpend({ store: guarded, settings }, ref("aaaaaaaaaaaa"), 0.132, "during", NOW)).toEqual({ scope: "turn", spent: 0.132, cap: 0.1 });
	});

	test("the thread cap adds the thread's completed turns to the running turn", () => {
		spent("aaaaaaaaaaaa", 0.5, NOW);
		spent("bbbbbbbbbbbb", 9, NOW);
		settings.apply({ "policy.spend.threadUSD": 1 }, "owner");
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0.25, "during", NOW)).toBeNull();
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0.75, "during", NOW)).toEqual({ scope: "thread", spent: 1.25, cap: 1 });
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0, "before", NOW)).toBeNull();
		expect(checkSpend({ store, settings }, ref("bbbbbbbbbbbb"), 0, "before", NOW)).toEqual({ scope: "thread", spent: 9, cap: 1 });
	});

	test("the day cap adds the owner's spend since 00:00 UTC, across threads and not another owner's", () => {
		spent("aaaaaaaaaaaa", 0.5, NOW);
		spent("bbbbbbbbbbbb", 0.25, new Date("2026-10-20T00:00:01.000Z"));
		spent("cccccccccccc", 50, new Date("2026-10-19T23:59:59.000Z"));
		spent("dddddddddddd", 50, NOW, "bob");
		settings.apply({ "policy.spend.dayUSD": 1 }, "owner");
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0.25, "during", NOW)).toBeNull();
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0.5, "during", NOW)).toEqual({ scope: "day", spent: 1.25, cap: 1 });
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0, "before", NOW)).toBeNull();
		settings.apply({ "policy.spend.dayUSD": 0.75 }, "owner");
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0, "before", NOW)).toEqual({ scope: "day", spent: 0.75, cap: 0.75 });
	});

	test("the day cap still trips after the spending thread was deleted", async () => {
		spent("aaaaaaaaaaaa", 0.9, NOW);
		spent("bbbbbbbbbbbb", 0, NOW);
		settings.apply({ "policy.spend.dayUSD": 1 }, "owner");
		expect(checkSpend({ store, settings }, ref("bbbbbbbbbbbb"), 0, "before", NOW)).toBeNull();
		await store.deleteThread("aaaaaaaaaaaa");
		expect(store.spend("owner", "").total.cost).toBe(0);
		const over = checkSpend({ store, settings }, ref("bbbbbbbbbbbb"), 0.2, "during", NOW);
		expect(over?.scope).toBe("day");
		expect(over?.spent).toBeCloseTo(1.1, 9);
		expect(checkSpend({ store, settings }, ref("bbbbbbbbbbbb"), 0.05, "during", NOW)).toBeNull();
	});

	test("a thread the store no longer has is not capped", () => {
		settings.apply({ "policy.spend.threadUSD": 1, "policy.spend.dayUSD": 1 }, "owner");
		expect(checkSpend({ store, settings }, ref("zzzzzzzzzzzz"), 5, "during", NOW)).toBeNull();
	});

	test("caps are read live", () => {
		spent("aaaaaaaaaaaa", 2, NOW);
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0, "before", NOW)).toBeNull();
		settings.apply({ "policy.spend.threadUSD": 1 }, "owner");
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0, "before", NOW)).not.toBeNull();
		settings.apply({ "policy.spend.threadUSD": null }, "owner");
		expect(checkSpend({ store, settings }, ref("aaaaaaaaaaaa"), 0, "before", NOW)).toBeNull();
	});

	test("a thread's own caps apply where the service has none, and the smaller non-zero cap applies where it has both", () => {
		const own = ref("aaaaaaaaaaaa", { "spend.turnUSD": 0.1 });
		expect(checkSpend({ store: guarded, settings }, own, 0.09, "during", NOW)).toBeNull();
		expect(checkSpend({ store: guarded, settings }, own, 0.132, "during", NOW)).toEqual({ scope: "turn", spent: 0.132, cap: 0.1 });
		settings.apply({ "policy.spend.turnUSD": 0.05 }, "owner");
		expect(checkSpend({ store: guarded, settings }, own, 0.07, "during", NOW)).toEqual({ scope: "turn", spent: 0.07, cap: 0.05 });
		settings.apply({ "policy.spend.turnUSD": 1 }, "owner");
		expect(checkSpend({ store: guarded, settings }, own, 0.132, "during", NOW)).toEqual({ scope: "turn", spent: 0.132, cap: 0.1 });
	});

	test("a thread's spend cap reads the store like the service's own", () => {
		spent("aaaaaaaaaaaa", 0.5, NOW);
		spent("bbbbbbbbbbbb", 0.5, NOW);
		const own = ref("aaaaaaaaaaaa", { "spend.threadUSD": 0.5, "spend.dayUSD": 0.9 });
		expect(checkSpend({ store, settings }, own, 0, "before", NOW)).toEqual({ scope: "thread", spent: 0.5, cap: 0.5 });
		expect(checkSpend({ store, settings }, ref("bbbbbbbbbbbb", { "spend.dayUSD": 0.9 }), 0, "before", NOW)).toEqual({ scope: "day", spent: 1, cap: 0.9 });
		expect(checkSpend({ store, settings }, ref("bbbbbbbbbbbb"), 0, "before", NOW)).toBeNull();
	});
});
