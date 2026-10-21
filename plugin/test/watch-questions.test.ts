import { describe, expect, test } from "bun:test";
import type { PendingQuestion, ThreadDetail, ThreadEvent, ThreadPhase, ThreadTurn } from "../src/types";
import { helpLines, statusText, widgetModel, Watcher, type WatchSink } from "../src/watch";
import { detail as buildDetail, event, pending, turn } from "./builders";
import { Feed } from "./feed";
import { fakeHost, lastLines, until } from "./fakes";

const ID = "aaaaaak3x9fa";

const pq = (id: number, over: Partial<PendingQuestion> = {}): PendingQuestion =>
	pending({ id, text: `question ${id}?`, options: [{ label: "yes", description: "" }, { label: "no", description: "" }], ...over });

const detail = (phase: ThreadPhase, turns: ThreadTurn[], question: PendingQuestion | null = null): ThreadDetail =>
	buildDetail({ id: ID, phase, turns, question });

class Sink implements WatchSink {
	questions: PendingQuestion[] = [];
	turns: { id: number; events: ThreadEvent[] }[] = [];
	flushed = 0;
	turn(_h: unknown, _t: ThreadDetail, t: ThreadTurn, events: ThreadEvent[]): void {
		this.turns.push({ id: t.id, events });
	}
	question(_h: unknown, _t: ThreadDetail, q: PendingQuestion): void {
		this.questions.push(q);
	}
	flush(): void {
		this.flushed++;
	}
}

function make(initial: ThreadDetail) {
	const f = fakeHost();
	const sink = new Sink();
	const feed = new Feed();
	let current = initial;
	let fetched = 0;
	const w = new Watcher(
		f.host,
		{
			thread: async () => {
				fetched++;
				return current;
			},
			events: feed.source,
		},
		sink,
		{ backoffMs: () => 1 },
	);
	return { f, sink, feed, w, set: (d: ThreadDetail) => void (current = d), fetched: () => fetched };
}

describe("questions in the watcher", () => {
	test("a waiting thread announces its question once; later events change nothing; the status counts waiting", async () => {
		const { f, sink, feed, w, set, fetched } = make(detail("waiting", [turn(1, { state: "running" })], pq(1)));
		await w.watch(ID);

		expect(feed.of(ID)).toHaveLength(1);
		expect(sink.questions.map(q => q.id)).toEqual([1]);
		expect(f.notes).toEqual([[`☁ do it · ${ID} asks: question 1? — /cloud answer k3x9fa`, "warning"]]);
		expect(f.status.at(-1)).toBe("☁ 0 working · 1 waiting");
		expect(lastLines(f)).toEqual([`☁ k3x9fa · do it · asks: question 1? · /cloud answer k3x9fa`]);

		// Still waiting on the same question: lifecycle events refetch but announce nothing new.
		feed.push(ID, event(1, { kind: "question_asked" }), event(2, { kind: "turn_started" }));
		await until(() => fetched() === 3);
		await until(() => feed.of(ID)[0]?.queue.length === 0);
		expect(sink.questions).toHaveLength(1);
		expect(f.notes).toHaveLength(1);

		// Answered: the thread works again, nothing is announced, the status drops "waiting".
		set(detail("working", [turn(1, { state: "running" })]));
		feed.push(ID, event(3, { kind: "question_answered" }));
		await until(() => f.status.at(-1) === "☁ 1 working");
		expect(sink.questions).toHaveLength(1);

		// A later question is a new card.
		set(detail("waiting", [turn(1, { state: "running" })], pq(2)));
		feed.push(ID, event(4, { kind: "question_asked" }));
		await until(() => sink.questions.length === 2);
		expect(sink.questions.map(q => q.id)).toEqual([1, 2]);
		expect(f.notes.at(-1)?.[0]).toContain("question 2?");
		expect(f.status.at(-1)).toBe("☁ 0 working · 1 waiting");
	});

	test("a question that arrives on a lifecycle event is announced once, even when the event replays", async () => {
		const { f, sink, feed, w, set } = make(detail("working", [turn(1, { state: "running" })]));
		await w.watch(ID);
		expect(sink.questions).toEqual([]);

		set(detail("waiting", [turn(1, { state: "running" })], pq(1)));
		feed.push(ID, event(1, { kind: "question_asked" }));
		await until(() => sink.questions.length === 1);

		// The connection drops and the server replays the event: no second card.
		feed.fail(ID, new Error("reset"));
		await until(() => feed.of(ID).length === 2);
		feed.push(ID, event(1, { kind: "question_asked" }), event(2, { kind: "assistant", text: "waiting" }));
		await until(() => feed.of(ID)[1]?.queue.length === 0);
		expect(sink.questions.map(q => q.id)).toEqual([1]);
		expect(f.notes.filter(([m]) => m.includes("asks"))).toHaveLength(1);
	});

	test("a question with the same id in another turn is a different question", async () => {
		const { sink, feed, w, set } = make(detail("waiting", [turn(1, { state: "running" })], pq(1, { turn: 1 })));
		await w.watch(ID);
		set(detail("waiting", [turn(1), turn(2, { state: "running" })], pq(1, { turn: 2 })));
		feed.push(ID, event(1, { kind: "question_asked" }));
		await until(() => sink.questions.length === 2);
		expect(sink.questions.map(q => `${q.turn}:${q.id}`)).toEqual(["1:1", "2:1"]);
	});

	test("a finished turn goes to the sink once with the events collected while watching; held cards are flushed after each refetch", async () => {
		const { sink, feed, w, set, f } = make(detail("working", [turn(1, { state: "running" })]));
		await w.watch(ID);
		expect(sink.flushed).toBe(0);

		feed.push(ID, event(1, { kind: "tool", text: "read a.go" }), event(2, { kind: "assistant", text: "done" }));
		await until(() => lastLines(f)?.[0]?.endsWith("done") === true);

		set(detail("idle", [turn(1, { title: "T", reply: "ok" })]));
		feed.push(ID, event(3, { kind: "turn_done", text: "turn 1 done" }));
		await until(() => sink.turns.length === 1);
		expect(sink.turns[0]?.id).toBe(1);
		expect(sink.turns[0]?.events.map(e => e.seq)).toEqual([1, 2, 3]);
		expect(sink.flushed).toBe(1);
		expect(w.watching).toEqual([]);
		expect(feed.of(ID)[0]?.aborted).toBe(true);
	});

	test("the sink gets at most the last 30 events of a turn", async () => {
		const { sink, feed, w, set, f } = make(detail("working", [turn(1, { state: "running" })]));
		await w.watch(ID);
		feed.push(ID, ...Array.from({ length: 40 }, (_, n) => event(n + 1, { kind: "tool", text: `e${n + 1}` })));
		await until(() => lastLines(f)?.[0]?.endsWith("e40") === true);
		set(detail("idle", [turn(1)]));
		feed.push(ID, event(41, { kind: "turn_done" }));
		await until(() => sink.turns.length === 1);
		const seqs = sink.turns[0]?.events.map(e => e.seq) ?? [];
		expect(seqs).toHaveLength(30);
		expect(seqs[0]).toBe(12);
		expect(seqs.at(-1)).toBe(41);
	});

	test("two turns finishing between refetches are both reported", async () => {
		const { sink, feed, w, set } = make(detail("working", [turn(1, { state: "running" })]));
		await w.watch(ID);
		set(detail("idle", [turn(1, { title: "one" }), turn(2, { title: "two" })]));
		feed.push(ID, event(1, { kind: "turn_done" }));
		await until(() => sink.turns.length === 2);
		expect(sink.turns.map(t => t.id)).toEqual([1, 2]);
	});

	test("watching an idle thread whose turns already finished posts no cards", async () => {
		const { f, sink, feed, w } = make(detail("idle", [turn(1, { reply: "old" })]));
		await w.watch(ID);
		expect(sink.turns).toEqual([]);
		expect(sink.questions).toEqual([]);
		expect(feed.connections).toEqual([]);
		expect(f.status.at(-1)).toBeUndefined();
	});

	test("a thread already waiting when the watch starts announces its question and is followed", async () => {
		const { sink, feed, w } = make(detail("waiting", [turn(1, { state: "running" })], pq(3)));
		await w.watch(ID);
		expect(sink.questions.map(q => q.id)).toEqual([3]);
		expect(feed.open(ID)).toBeDefined();
	});
});

describe("status and rendering of waiting threads", () => {
	test("status text", () => {
		expect(statusText(0, 0)).toBeUndefined();
		expect(statusText(2, 0)).toBe("☁ 2 working");
		expect(statusText(2, 1)).toBe("☁ 2 working · 1 waiting");
		expect(statusText(0, 1)).toBe("☁ 0 working · 1 waiting");
	});

	test("a waiting row carries the pending question and its extra count", () => {
		const d = detail("waiting", [turn(1, { state: "running" })], pq(1, { remaining: 3 }));
		expect(widgetModel([{ id: ID, detail: d, events: [] }]).rows[0]).toMatchObject({ kind: "waiting", text: "question 1?", more: 2 });
	});

	test("help names the hub and the answer verb", () => {
		const text = helpLines().join("\n");
		expect(text).toContain("no arguments opens the hub");
		expect(text).toContain("/cloud answer <id> [text]");
	});
});
