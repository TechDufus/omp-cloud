import { describe, expect, test } from "bun:test";
import { cloudErrorFromStatus } from "../src/errors";
import type { FollowOptions } from "../src/events";
import type { ThreadDetail } from "../src/types";
import { resultLine, Watcher, type WatchApi } from "../src/watch";
import { detail, event, turn } from "./builders";
import { Feed } from "./feed";
import { fakeHost, lastLines, until, type FakeHost } from "./fakes";

const ID = "aaaaaak3x9fa";

const working = (turns = [turn(1, { title: "old" }), turn(2, { state: "running" })]): ThreadDetail => detail({ id: ID, phase: "working", turns });
const finished = (): ThreadDetail =>
	detail({ id: ID, phase: "idle", turns: [turn(1, { title: "old" }), turn(2, { title: "Added Greet", reply: "Done.\nSee tests." })] });

interface Made {
	f: FakeHost;
	feed: Feed;
	w: Watcher;
	fetched: () => number;
	set(d: ThreadDetail): void;
}

function make(initial: ThreadDetail, followOptions: FollowOptions = { backoffMs: () => 1 }, api: Partial<WatchApi> = {}): Made {
	const f = fakeHost();
	const feed = new Feed();
	let current = initial;
	let n = 0;
	const w = new Watcher(
		f.host,
		{
			thread: async () => {
				n++;
				return current;
			},
			events: feed.source,
			...api,
		},
		undefined,
		followOptions,
	);
	return { f, feed, w, fetched: () => n, set: d => void (current = d) };
}

describe("Watcher", () => {
	test("follows the event stream while working, reports the finished turn once, then stops following", async () => {
		const { f, feed, w, set, fetched } = make(working());
		await w.watch(ID);
		expect(f.status.at(-1)).toBe("☁ 1 working");
		expect(w.watching).toEqual([ID]);
		expect(feed.of(ID)).toHaveLength(1);
		expect(feed.of(ID)[0]?.opts.after).toBeUndefined();
		// Turn 1 was already finished when the watch began: not reported.
		expect(f.notes).toEqual([]);
		expect(fetched()).toBe(1);

		// A progress event updates the live row without refetching.
		feed.push(ID, event(1, { kind: "tool", turn: 2, text: "read a.go" }));
		await until(() => lastLines(f)?.[0]?.endsWith("read: a.go") === true);
		expect(fetched()).toBe(1);
		expect(f.notes).toEqual([]);

		set(finished());
		feed.push(ID, event(2, { kind: "turn_done", text: "turn 2 done" }));
		await until(() => f.notes.length === 1);
		expect(f.notes).toEqual([[`☁ do it · ${ID} turn 2 done: Added Greet`, "info"]]);
		// The finished turn leaves nothing in the widget: it is removed at once, with no timer behind it.
		expect(f.widgets.at(-1)).toBeUndefined();
		expect(f.timeouts).toEqual([]);
		expect(f.status.at(-1)).toBeUndefined();
		expect(w.watching).toEqual([]);
		expect(fetched()).toBe(2);
		expect(feed.of(ID)[0]?.aborted).toBe(true);
	});

	test.each(["turn_queued", "turn_started", "turn_done", "turn_failed", "turn_cancelled", "turn_requeued", "stop_requested", "question_asked", "question_answered", "question_expired", "thread_failed"])(
		"a %s event refetches the thread",
		async kind => {
			const { feed, w, fetched } = make(working());
			await w.watch(ID);
			feed.push(ID, event(1, { kind }));
			await until(() => fetched() === 2);
			expect(w.watching).toEqual([ID]);
		},
	);

	test("events of other kinds never refetch", async () => {
		const { f, feed, w, fetched } = make(working());
		await w.watch(ID);
		feed.push(ID, event(1, { kind: "assistant", turn: 2, text: "a" }), event(2, { kind: "tool", turn: 2, text: "b" }), event(3, { kind: "usage", turn: 2, text: "c" }));
		await until(() => lastLines(f)?.[0]?.endsWith("· b") === true);
		expect(fetched()).toBe(1);
	});

	test("a refetch that finds the turn still running reports nothing", async () => {
		const { f, feed, w, fetched } = make(working());
		await w.watch(ID);
		feed.push(ID, event(1, { kind: "turn_started" }));
		await until(() => fetched() === 2);
		await until(() => f.status.length >= 2);
		expect(f.notes).toEqual([]);
		expect(w.watching).toEqual([ID]);
	});

	test("a failed turn is an error notification with its error text", async () => {
		const { f, feed, w, set } = make(working([turn(1, { state: "running" })]));
		await w.watch(ID);
		set(detail({ id: ID, phase: "idle", turns: [turn(1, { state: "failed", error: "stopped by owner" })] }));
		feed.push(ID, event(1, { kind: "turn_failed" }));
		await until(() => f.notes.length === 1);
		expect(f.notes).toEqual([[`☁ do it · ${ID} turn 1 failed: stopped by owner`, "error"]]);
		expect(w.watching).toEqual([]);
	});

	test("a thread that failed outside a turn is reported once with its error", async () => {
		const { f, feed, w, set } = make(working([turn(1, { state: "running" })]));
		await w.watch(ID);
		set(detail({ id: ID, phase: "failed", error: "vm lost", turns: [turn(1, { state: "cancelled" })] }));
		feed.push(ID, event(1, { kind: "thread_failed" }));
		await until(() => f.notes.length === 1);
		expect(f.notes).toEqual([[`☁ do it · ${ID} failed: vm lost`, "error"]]);
		expect(w.watching).toEqual([]);
	});

	test("an idle thread is not followed: it is handed back for the caller to show, and the watcher prints nothing", async () => {
		const idle = detail({ id: ID, phase: "idle", turns: [turn(1, { reply: "all good" })] });
		const { f, feed, w } = make(idle);
		expect(await w.watch(ID)).toEqual(idle);
		expect(feed.connections).toEqual([]);
		expect(w.watching).toEqual([]);
		expect(f.notes).toEqual([]);
		expect(f.widgets).toEqual([]);
	});

	test("a queued turn on an idle-looking thread is still active", async () => {
		const { feed, w } = make(detail({ id: ID, phase: "idle", turns: [turn(1, { state: "queued" })] }));
		await w.watch(ID);
		expect(w.watching).toEqual([ID]);
		expect(feed.of(ID)).toHaveLength(1);
	});

	test("events after the thread finished do not reach the sink or the widget", async () => {
		const { f, feed, w, set } = make(working());
		await w.watch(ID);
		set(finished());
		feed.push(ID, event(1, { kind: "turn_done" }));
		await until(() => f.notes.length === 1);
		const widgets = f.widgets.length;
		expect(feed.open(ID)).toBeUndefined();
		expect(f.widgets).toHaveLength(widgets);
	});

	test("rebinding to the next command's host sends the later notifications there", async () => {
		const { f, feed, w, set } = make(working());
		await w.watch(ID);
		const next = fakeHost();
		w.rebind(next.host);
		set(finished());
		feed.push(ID, event(1, { kind: "turn_done" }));
		await until(() => next.notes.length === 1);
		expect(f.notes).toEqual([]);
		expect(next.notes[0]?.[0]).toContain("turn 2 done");
		expect(feed.of(ID)).toHaveLength(1);
	});

	test("watching the same thread again replaces its stream", async () => {
		const { feed, w } = make(working());
		await w.watch(ID);
		await w.watch(ID);
		expect(feed.of(ID)).toHaveLength(2);
		expect(feed.of(ID)[0]?.aborted).toBe(true);
		expect(feed.open(ID)).toBe(feed.of(ID)[1]);
		expect(w.watching).toEqual([ID]);
	});

	test("unwatch stops the stream and clears the widget and the status", async () => {
		const { f, feed, w } = make(working());
		await w.watch(ID);
		w.unwatch();
		expect(feed.of(ID)[0]?.aborted).toBe(true);
		expect(w.watching).toEqual([]);
		expect(f.widgets.at(-1)).toBeUndefined();
		expect(f.status.at(-1)).toBeUndefined();
	});

	test("a dropped stream is resumed with Last-Event-ID and the watch goes on", async () => {
		const { f, feed, w, set } = make(working());
		await w.watch(ID);
		feed.push(ID, event(1, { kind: "tool", turn: 2, text: "read a.go" }));
		await until(() => lastLines(f)?.[0]?.endsWith("read: a.go") === true);
		feed.fail(ID, new Error("connection reset"));
		await until(() => feed.of(ID).length === 2);
		expect(feed.of(ID)[1]?.opts.lastEventId).toBe(1);
		expect(feed.of(ID)[1]?.opts.after).toBeUndefined();
		expect(f.notes).toEqual([]);

		set(finished());
		feed.push(ID, event(2, { kind: "turn_done" }));
		await until(() => f.notes.length === 1);
		expect(w.watching).toEqual([]);
	});

	test("a refused token is retried like any failure: the watcher stays on the thread and says nothing", async () => {
		const { f, feed, w } = make(working());
		await w.watch(ID);
		feed.fail(ID, cloudErrorFromStatus(401, "bad token"));
		await until(() => feed.of(ID).length === 2);
		expect(f.notes).toEqual([]);
		expect(w.watching).toEqual([ID]);
		expect(w.followed(ID)?.stale).toBe(false);
	});

	test("a thread deleted while watched is reported and dropped", async () => {
		const { f, feed, w } = make(working(), undefined, {
			thread: (() => {
				let first = true;
				return async () => {
					if (first) {
						first = false;
						return working();
					}
					throw cloudErrorFromStatus(404, "no such thread");
				};
			})(),
		});
		await w.watch(ID);
		feed.push(ID, event(1, { kind: "turn_started" }));
		await until(() => f.notes.length === 1);
		expect(f.notes).toEqual([[`☁ do it · ${ID} no longer exists`, "warning"]]);
		expect(w.watching).toEqual([]);
		expect(feed.of(ID)[0]?.aborted).toBe(true);
	});

	test("a failed refetch is transient: the next lifecycle event tries again", async () => {
		let calls = 0;
		let current = working();
		const { f, feed, w } = make(working(), undefined, {
			thread: async () => {
				calls++;
				if (calls === 2) throw new Error("timeout");
				return current;
			},
		});
		await w.watch(ID);
		feed.push(ID, event(1, { kind: "turn_started" }));
		await until(() => calls === 2);
		expect(f.notes).toEqual([]);
		expect(w.watching).toEqual([ID]);

		current = finished();
		feed.push(ID, event(2, { kind: "turn_done" }));
		await until(() => f.notes.length === 1);
		expect(calls).toBe(3);
		expect(w.watching).toEqual([]);
	});

	test("lifecycle events during a refetch cause one more refetch, never overlapping ones", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		let calls = 0;
		let release: (() => void) | undefined;
		const { feed, w } = make(working(), undefined, {
			thread: async () => {
				calls++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				if (calls === 2) await new Promise<void>(resolve => (release = resolve));
				inFlight--;
				return working();
			},
		});
		await w.watch(ID);
		feed.push(ID, event(1, { kind: "turn_started" }));
		await until(() => release !== undefined);
		feed.push(ID, event(2, { kind: "question_asked" }), event(3, { kind: "turn_queued" }));
		await until(() => feed.of(ID)[0]?.queue.length === 0);
		release?.();
		await until(() => calls === 3 && inFlight === 0);
		expect(maxInFlight).toBe(1);
		expect(calls).toBe(3);
	});

	test("the finished turn is reported once however many lifecycle events follow", async () => {
		const { f, feed, w, set } = make(working());
		await w.watch(ID);
		set(finished());
		feed.push(ID, event(1, { kind: "turn_done" }), event(2, { kind: "stop_requested" }));
		await until(() => f.notes.length === 1);
		expect(f.notes).toHaveLength(1);
	});

	test("a named thread leads its notifications and its widget row with the name and keeps the id", async () => {
		const named = (turns = [turn(1, { state: "running" })]) => detail({ id: ID, name: "Fix greeting bug", phase: "working", turns });
		const { f, feed, w, set } = make(named());
		await w.watch(ID);
		expect(lastLines(f)?.[0]).toContain("Fix greeting bug");
		expect(lastLines(f)?.[0]).not.toContain("do it");
		set(detail({ id: ID, name: "Fix greeting bug", phase: "idle", turns: [turn(1, { title: "Done" })] }));
		feed.push(ID, event(1, { kind: "turn_done" }));
		await until(() => f.notes.length === 1);
		expect(f.notes).toEqual([[`☁ Fix greeting bug · ${ID} turn 1 done: Done`, "info"]]);
	});
});

describe("rendering", () => {
	test("result line: pushed, push failed, not pushed", () => {
		const base = { branch: "b", head: "0123456789", base: "main", filesChanged: 1, insertions: 2, deletions: 3, pushed: false, pushError: "", pushRef: "", updatedAt: "" };
		expect(resultLine(null)).toBe("result: none yet");
		expect(resultLine({ ...base, pushed: true })).toBe("result: b @ 01234567 (+2 −3, 1 files, pushed)");
		expect(resultLine({ ...base, pushed: true, pushRef: "bots/b" })).toBe("result: b @ 01234567 (+2 −3, 1 files, pushed to bots/b)");
		expect(resultLine({ ...base, pushError: "denied" })).toBe("result: b @ 01234567 (+2 −3, 1 files, push failed: denied)");
		expect(resultLine(base)).toBe("result: b @ 01234567 (+2 −3, 1 files, not pushed)");
	});
});
