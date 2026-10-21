import { describe, expect, test } from "bun:test";
import { CloudError, cloudErrorFromStatus } from "../src/errors";
import type { ThreadDetail } from "../src/types";
import { verdict, WAIT_POLL_MS, Waits, type WaitOptions, type WaitSource } from "../src/wait";
import { detail, pending, turn } from "./builders";
import { ManualClock } from "./clock";

const A = "aaaaaak3x9fa";
const B = "bbbbbbq9w8e7";
const C = "cccccch2d4f6";

const running = (id: string): ThreadDetail => detail({ id, phase: "working", turns: [turn(1, { state: "running" })] });
const done = (id: string): ThreadDetail => detail({ id, phase: "idle", turns: [turn(1), turn(2, { state: "done" })] });
const failed = (id: string): ThreadDetail => detail({ id, phase: "idle", turns: [turn(1, { state: "failed", error: "boom" })] });
const asking = (id: string): ThreadDetail => detail({ id, phase: "waiting", question: pending({ turn: 3 }), turns: [turn(3, { state: "running" })] });

const ALL: WaitOptions["on"] = ["done", "failed", "question"];

interface Rig {
	waits: Waits;
	clock: ManualClock;
	/** What the watcher follows: id to what it last saw. */
	followed: Map<string, { detail: ThreadDetail; stale: boolean }>;
	/** What the service answers for threads that are not followed; a missing id is a 404, an Error is a failed request. */
	service: Map<string, ThreadDetail | Error>;
	fetched: string[];
}

function rig(): Rig {
	const clock = new ManualClock();
	const followed: Rig["followed"] = new Map();
	const service: Rig["service"] = new Map();
	const fetched: string[] = [];
	const source: WaitSource = {
		clock,
		followed: id => followed.get(id),
		fetch: async id => {
			fetched.push(id);
			const answer = service.get(id);
			if (!answer) throw cloudErrorFromStatus(404, "no such thread");
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};
	return { waits: new Waits(source), clock, followed, service, fetched };
}

const opts = (over: Partial<WaitOptions> = {}): WaitOptions => ({ until: "any", on: ALL, timeoutMs: 600_000, ...over });

describe("what ends a wait", () => {
	const seen = (d: ThreadDetail) => ({ id: d.id, state: "detail" as const, detail: d });

	test("a thread that is working has not settled; one that has a question has, whatever else it is doing", () => {
		expect(verdict(seen(running(A)), ALL)).toBeUndefined();
		expect(verdict(seen(asking(A)), ALL)).toEqual({ threadId: A, outcome: "question", turn: 3 });
	});

	test("a finished thread is judged by its latest turn: done, failed (a stopped turn too) or the thread's own failure", () => {
		expect(verdict(seen(done(A)), ALL)).toEqual({ threadId: A, outcome: "done", turn: 2 });
		expect(verdict(seen(failed(A)), ALL)).toEqual({ threadId: A, outcome: "failed", turn: 1 });
		expect(verdict(seen(detail({ id: A, phase: "idle", turns: [turn(1, { state: "cancelled" })] })), ALL)).toEqual({ threadId: A, outcome: "failed", turn: 1 });
		expect(verdict(seen(detail({ id: A, phase: "failed", error: "vm lost", turns: [] })), ALL)).toEqual({ threadId: A, outcome: "failed" });
	});

	test("`on` narrows only what a working thread answers: a question still needs `question`, but a thread that is not working has settled whatever `on` says", () => {
		expect(verdict(seen(asking(A)), ["done", "failed"])).toBeUndefined();
		expect(verdict(seen(running(A)), ["done"])).toBeUndefined();
		expect(verdict(seen(failed(A)), ["done"])).toEqual({ threadId: A, outcome: "failed", turn: 1 });
		expect(verdict(seen(done(A)), ["failed"])).toEqual({ threadId: A, outcome: "done", turn: 2 });
		expect(verdict(seen(done(A)), ["question"])).toEqual({ threadId: A, outcome: "done", turn: 2 });
		expect(verdict(seen(done(A)), ["done"])).toEqual({ threadId: A, outcome: "done", turn: 2 });
	});

	test("a wait for done on a thread that already failed answers at once instead of running to its timeout", async () => {
		const r = rig();
		r.followed.set(A, { detail: failed(A), stale: false });
		expect(await r.waits.run([A], opts({ on: ["done"] }))).toEqual([{ threadId: A, outcome: "failed", turn: 1 }]);
		expect(r.clock.sleeping).toBe(0);
	});

	test("a deleted or stale thread ends the wait whatever `on` says: there is nothing to wait for", () => {
		expect(verdict({ id: A, state: "gone" }, ["done"])).toEqual({ threadId: A, outcome: "deleted" });
		expect(verdict({ id: A, state: "stale" }, ["question"])).toEqual({ threadId: A, outcome: "stale" });
	});
});

describe("waiting for threads", () => {
	test("any: the first thread to settle ends the wait and is the only one reported", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: false });
		r.followed.set(B, { detail: running(B), stale: false });
		const p = r.waits.run([A, B], opts());
		await r.clock.advance(1000);
		r.waits.observe({ id: B, state: "detail", detail: done(B) });
		expect(await p).toEqual([{ threadId: B, outcome: "done", turn: 2 }]);
	});

	test("any: a thread already settled answers at once", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: false });
		r.followed.set(B, { detail: failed(B), stale: false });
		expect(await r.waits.run([A, B], opts())).toEqual([{ threadId: B, outcome: "failed", turn: 1 }]);
		expect(r.clock.sleeping).toBe(0);
	});

	test("all: it waits for every thread and reports them in the order asked", async () => {
		const r = rig();
		for (const id of [A, B, C]) r.followed.set(id, { detail: running(id), stale: false });
		let result: unknown;
		const p = r.waits.run([C, A, B], opts({ until: "all" })).then(v => void (result = v));
		r.waits.observe({ id: A, state: "detail", detail: done(A) });
		r.waits.observe({ id: B, state: "detail", detail: failed(B) });
		await r.clock.advance(1000);
		expect(result).toBeUndefined();
		r.waits.observe({ id: C, state: "detail", detail: asking(C) });
		await p;
		expect(result).toEqual([
			{ threadId: C, outcome: "question", turn: 3 },
			{ threadId: A, outcome: "done", turn: 2 },
			{ threadId: B, outcome: "failed", turn: 1 },
		]);
	});

	test("a question ends the wait while the turn is still running, and a thread that answers it and works on does not end it again", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: false });
		const first = r.waits.run([A], opts());
		r.waits.observe({ id: A, state: "detail", detail: asking(A) });
		expect(await first).toEqual([{ threadId: A, outcome: "question", turn: 3 }]);

		r.followed.set(A, { detail: running(A), stale: false });
		let second: unknown;
		const p = r.waits.run([A], opts()).then(v => void (second = v));
		r.waits.observe({ id: A, state: "detail", detail: running(A) });
		await r.clock.advance(1000);
		expect(second).toBeUndefined();
		r.waits.observe({ id: A, state: "detail", detail: done(A) });
		await p;
		expect(second).toEqual([{ threadId: A, outcome: "done", turn: 2 }]);
	});

	test("timeout: threads that never settled read `timeout`, the ones that did keep their outcome, and the wait ends exactly at the limit", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: false });
		r.followed.set(B, { detail: running(B), stale: false });
		let result: unknown;
		const p = r.waits.run([A, B], opts({ until: "all", timeoutMs: 60_000 })).then(v => void (result = v));
		r.waits.observe({ id: A, state: "detail", detail: done(A) });
		await r.clock.advance(59_999);
		expect(result).toBeUndefined();
		await r.clock.advance(1);
		await p;
		expect(result).toEqual([
			{ threadId: A, outcome: "done", turn: 2 },
			{ threadId: B, outcome: "timeout" },
		]);
		expect(r.clock.sleeping).toBe(0);
	});

	test("abort: the wait rejects with an `aborted` CloudError and leaves nothing sleeping or waiting", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: false });
		const ctrl = new AbortController();
		const p = r.waits.run([A], opts({ signal: ctrl.signal }));
		await r.clock.advance(1000);
		ctrl.abort();
		const error = await p.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CloudError);
		expect((error as CloudError).code).toBe("aborted");
		expect(r.clock.sleeping).toBe(0);
		// Nothing listens any more: a later change is not an error and not a result.
		r.waits.observe({ id: A, state: "detail", detail: done(A) });
	});

	test("abort: a signal that is already aborted rejects without starting anything", async () => {
		const r = rig();
		const error = await r.waits.run([A], opts({ signal: AbortSignal.abort() })).catch((e: unknown) => e);
		expect((error as CloudError).code).toBe("aborted");
		expect(r.fetched).toEqual([]);
		expect(r.clock.sleeping).toBe(0);
	});

	test("a thread the watcher lost contact with is `stale`; the other threads still count", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: true });
		r.followed.set(B, { detail: running(B), stale: false });
		expect(await r.waits.run([A, B], opts())).toEqual([{ threadId: A, outcome: "stale" }]);
		let result: unknown;
		const p = r.waits.run([B], opts()).then(v => void (result = v));
		r.waits.observe({ id: B, state: "stale" });
		await p;
		expect(result).toEqual([{ threadId: B, outcome: "stale" }]);
	});

	test("a thread the watcher found deleted is `deleted`", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: false });
		const p = r.waits.run([A], opts());
		r.waits.observe({ id: A, state: "gone" });
		expect(await p).toEqual([{ threadId: A, outcome: "deleted" }]);
	});

	test("the same thread listed twice is waited on once", async () => {
		const r = rig();
		r.followed.set(A, { detail: done(A), stale: false });
		expect(await r.waits.run([A, A], opts({ until: "all" }))).toEqual([{ threadId: A, outcome: "done", turn: 2 }]);
	});

	test("no threads is an empty answer, not a wait", async () => {
		expect(await rig().waits.run([], opts())).toEqual([]);
	});

	test("observations of other threads, and of threads after their outcome, change nothing", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: false });
		const p = r.waits.run([A], opts());
		r.waits.observe({ id: C, state: "detail", detail: done(C) });
		r.waits.observe({ id: A, state: "detail", detail: failed(A) });
		r.waits.observe({ id: A, state: "detail", detail: done(A) });
		expect(await p).toEqual([{ threadId: A, outcome: "failed", turn: 1 }]);
	});
});

describe("threads this session does not follow are polled", () => {
	test("each unfollowed thread is fetched at once and then every poll interval, and a followed one never", async () => {
		const r = rig();
		r.followed.set(A, { detail: running(A), stale: false });
		r.service.set(B, running(B));
		r.service.set(C, running(C));
		const p = r.waits.run([A, B, C], opts({ until: "all" }));
		await r.clock.advance(0);
		expect(r.fetched).toEqual([B, C]);
		await r.clock.advance(WAIT_POLL_MS);
		expect(r.fetched).toEqual([B, C, B, C]);
		r.service.set(B, done(B));
		await r.clock.advance(WAIT_POLL_MS);
		// B settled and is not fetched again.
		expect(r.fetched).toEqual([B, C, B, C, B, C]);
		await r.clock.advance(WAIT_POLL_MS);
		expect(r.fetched.slice(6)).toEqual([C]);
		r.waits.observe({ id: A, state: "detail", detail: done(A) });
		r.service.set(C, failed(C));
		await r.clock.advance(WAIT_POLL_MS);
		expect(await p).toEqual([
			{ threadId: A, outcome: "done", turn: 2 },
			{ threadId: B, outcome: "done", turn: 2 },
			{ threadId: C, outcome: "failed", turn: 1 },
		]);
	});

	test("a thread the session starts to follow during the wait is no longer fetched", async () => {
		const r = rig();
		r.service.set(A, running(A));
		const p = r.waits.run([A], opts());
		await r.clock.advance(0);
		expect(r.fetched).toEqual([A]);
		r.followed.set(A, { detail: running(A), stale: false });
		await r.clock.advance(3 * WAIT_POLL_MS);
		expect(r.fetched).toEqual([A]);
		r.waits.observe({ id: A, state: "detail", detail: done(A) });
		expect(await p).toEqual([{ threadId: A, outcome: "done", turn: 2 }]);
	});

	test("a failed request is tried again at the next poll; it does not end the wait", async () => {
		const r = rig();
		r.service.set(A, new Error("fetch failed"));
		let result: unknown;
		const p = r.waits.run([A], opts()).then(v => void (result = v));
		await r.clock.advance(WAIT_POLL_MS);
		expect(result).toBeUndefined();
		r.service.set(A, done(A));
		await r.clock.advance(WAIT_POLL_MS);
		await p;
		expect(result).toEqual([{ threadId: A, outcome: "done", turn: 2 }]);
	});

	test("a thread the service does not know is `deleted`", async () => {
		const r = rig();
		expect(await r.waits.run([A], opts())).toEqual([{ threadId: A, outcome: "deleted" }]);
	});

	test("polling stops when the wait ends: no fetch and no sleep outlives it", async () => {
		const r = rig();
		r.service.set(A, running(A));
		r.service.set(B, running(B));
		const p = r.waits.run([A, B], opts({ timeoutMs: 25_000 }));
		await r.clock.advance(25_000);
		await p;
		const fetched = r.fetched.length;
		await r.clock.advance(5 * WAIT_POLL_MS);
		expect(r.fetched).toHaveLength(fetched);
		expect(r.clock.sleeping).toBe(0);
	});
});
