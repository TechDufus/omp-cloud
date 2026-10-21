import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { CloudClient, type EventStreamOptions } from "../src/api";
import { CloudError, cloudErrorFromStatus } from "../src/errors";
import { follow, type EventSource, type Follower, type FollowOptions } from "../src/events";
import type { PendingQuestion, ThreadDetail, ThreadEvent, ThreadTurn } from "../src/types";
import { type WatchSink, Watcher } from "../src/watch";
import { detail, event, turn } from "./builders";
import { ManualClock } from "./clock";
import { fakeHost, until } from "./fakes";
import { Feed } from "./feed";

/** One scripted connection: events to yield, errors to throw, numbers to sleep (ms). It ends after its last item. */
type Item = ThreadEvent | Error | number;

function aborted(signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>(resolve => {
		if (!signal || signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/** An event source that plays `connections` in order; each ends when its items run out, except the last, which stays open until aborted. */
function script(...connections: Item[][]): { source: EventSource; calls: EventStreamOptions[] } {
	const calls: EventStreamOptions[] = [];
	const source: EventSource = (_id, opts) => {
		const index = calls.length;
		const items = connections[index];
		calls.push(opts);
		return (async function* () {
			for (const item of items ?? []) {
				if (typeof item === "number") await Bun.sleep(item);
				else if (item instanceof Error) throw item;
				else yield item;
			}
			if (index >= connections.length - 1) await aborted(opts.signal);
		})();
	};
	return { source, calls };
}

interface Run {
	events: ThreadEvent[];
	giveUps: unknown[];
	stale: unknown[];
	recovered: number[];
	follower: Follower;
}

const live: Follower[] = [];

function run(source: EventSource, opts: FollowOptions = {}): Run {
	const events: ThreadEvent[] = [];
	const giveUps: unknown[] = [];
	const stale: unknown[] = [];
	const recovered: number[] = [];
	const follower = follow(source, "k3x9fa2m7q1z", { onEvent: e => void events.push(e), onGiveUp: e => void giveUps.push(e), onStale: e => void stale.push(e), onRecover: () => void recovered.push(1) }, { backoffMs: () => 1, ...opts });
	live.push(follower);
	return { events, giveUps, stale, recovered, follower };
}

afterEach(() => {
	for (const f of live.splice(0)) f.stop();
});

const seqs = (events: ThreadEvent[]): number[] => events.map(e => e.seq);

describe("follow", () => {
	test("hands each event over once, in order, on one connection", async () => {
		const { source, calls } = script([event(1), event(2), event(3)]);
		const r = run(source);
		await until(() => r.events.length === 3);
		expect(seqs(r.events)).toEqual([1, 2, 3]);
		expect(r.follower.lastSeq).toBe(3);
		expect(calls).toHaveLength(1);
		expect(r.giveUps).toEqual([]);
	});

	test("the first connection carries `after` only when given, and never `lastEventId`", async () => {
		const plain = script([event(1)]);
		run(plain.source);
		await until(() => plain.calls.length === 1);
		expect(plain.calls[0]?.after).toBeUndefined();
		expect(plain.calls[0]?.lastEventId).toBeUndefined();

		const resumed = script([event(11)]);
		const r = run(resumed.source, { after: 10 });
		await until(() => r.events.length === 1);
		expect(resumed.calls[0]?.after).toBe(10);
		expect(resumed.calls[0]?.lastEventId).toBeUndefined();
		expect(r.follower.lastSeq).toBe(11);
	});

	test("lastSeq starts at `after` until an event arrives", () => {
		const { source } = script();
		expect(run(source, { after: 7 }).follower.lastSeq).toBe(7);
		expect(run(source).follower.lastSeq).toBe(0);
	});

	test("a dropped connection reconnects with lastEventId = the last seq handled and no `after`", async () => {
		const { source, calls } = script([event(11), event(12), new Error("connection reset")], [event(13)]);
		const r = run(source, { after: 10 });
		await until(() => r.events.length === 3);
		expect(seqs(r.events)).toEqual([11, 12, 13]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.after).toBe(10);
		expect(calls[1]?.lastEventId).toBe(12);
		expect(calls[1]?.after).toBeUndefined();
	});

	test("a stream the server ends cleanly is resumed the same way", async () => {
		const { source, calls } = script([event(1)], [event(2)]);
		const r = run(source);
		await until(() => r.events.length === 2);
		expect(calls[1]?.lastEventId).toBe(1);
		expect(calls[1]?.after).toBeUndefined();
	});

	test("a drop before any event resumes from 0 without `after`", async () => {
		const { source, calls } = script([new Error("refused")], [event(1)]);
		const r = run(source);
		await until(() => r.events.length === 1);
		expect(calls[1]?.lastEventId).toBe(0);
		expect(calls[1]?.after).toBeUndefined();
	});

	test("every reconnection resumes from the newest seq, however often the stream drops", async () => {
		const { source, calls } = script([event(1), new Error("a")], [event(2), event(3), new Error("b")], [event(4)]);
		const r = run(source);
		await until(() => r.events.length === 4);
		expect(calls.map(c => c.lastEventId)).toEqual([undefined, 1, 3]);
	});

	test("a replay of handled seqs after a reconnect produces no duplicate onEvent calls", async () => {
		const { source } = script([event(1), event(2), new Error("reset")], [event(1), event(2), event(3)]);
		const r = run(source);
		await until(() => r.events.length === 3);
		await Bun.sleep(20);
		expect(seqs(r.events)).toEqual([1, 2, 3]);
	});

	test("an event older than the last handled one inside a connection is skipped", async () => {
		const { source } = script([event(1), event(3), event(2), event(3), event(4)]);
		const r = run(source);
		await until(() => r.events.length === 3);
		expect(seqs(r.events)).toEqual([1, 3, 4]);
	});

	test("a 404 is the service not knowing the thread: onGiveUp once, no retry", async () => {
		const refusal = cloudErrorFromStatus(404, "no such thread");
		const { source, calls } = script([refusal], [event(1)]);
		const r = run(source);
		await until(() => r.giveUps.length === 1);
		await Bun.sleep(30);
		expect(r.giveUps).toEqual([refusal]);
		expect(calls).toHaveLength(1);
		expect(r.events).toEqual([]);
	});

	test.each([400, 401, 403, 500, 503, 429, 408])("a %d is retried: a token can be fixed and a service comes back while the turn runs on", async status => {
		const { source, calls } = script([cloudErrorFromStatus(status, "try later")], [event(1)]);
		const r = run(source);
		await until(() => r.events.length === 1);
		expect(calls).toHaveLength(2);
		expect(r.giveUps).toEqual([]);
	});

	test("a 404 on a reconnect gives up too", async () => {
		const refusal = cloudErrorFromStatus(404, "no such thread");
		const { source, calls } = script([event(1), new Error("reset")], [refusal], [event(2)]);
		const r = run(source);
		await until(() => r.giveUps.length === 1);
		await Bun.sleep(30);
		expect(r.giveUps).toEqual([refusal]);
		expect(calls).toHaveLength(2);
		expect(seqs(r.events)).toEqual([1]);
	});

	test("failures never end the follower: a stream that fails twelve times in a row is followed on once it works", async () => {
		const failing: Item[][] = Array.from({ length: 12 }, () => [new Error("boom")]);
		const { source, calls } = script(...failing, [event(1)]);
		const r = run(source);
		await until(() => r.events.length === 1);
		expect(calls).toHaveLength(13);
		expect(r.giveUps).toEqual([]);
		expect(r.stale).toEqual([]);
	});
});

describe("an outage", () => {
	const ID = "k3x9fa2m7q1z";

	interface Outage extends Run {
		feed: Feed;
		clock: ManualClock;
		/** The service becomes unreachable: the open stream breaks and every attempt after it fails with `error`. */
		cut(error: Error): void;
	}

	/** A follower on the default backoff over a feed and a clock the test moves. */
	function outage(): Outage {
		const feed = new Feed();
		const clock = new ManualClock();
		const events: ThreadEvent[] = [];
		const giveUps: unknown[] = [];
		const stale: unknown[] = [];
		const recovered: number[] = [];
		const follower = follow(feed.source, ID, { onEvent: e => void events.push(e), onGiveUp: e => void giveUps.push(e), onStale: e => void stale.push(e), onRecover: () => void recovered.push(1) }, { clock });
		live.push(follower);
		const cut = (error: Error): void => {
			feed.down = error;
			feed.fail(ID, error);
		};
		return { events, giveUps, stale, recovered, follower, feed, clock, cut };
	}

	test("is retried with a backoff that doubles from 1 s and stops growing at 15 s", async () => {
		const o = outage();
		o.cut(new Error("fetch failed"));
		await o.clock.advance(120_000);
		expect(o.clock.slept.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
	});

	test("a 30 s outage is retried without a word, and the event that happened during it is delivered once", async () => {
		const o = outage();
		await o.clock.advance(1);
		o.feed.push(ID, event(1));
		o.cut(new Error("fetch failed"));
		await o.clock.advance(30_000);
		expect(o.stale).toEqual([]);
		o.feed.down = undefined;
		await o.clock.advance(15_000);
		// The service replays what the follower missed from the Last-Event-ID it sent.
		expect(o.feed.of(ID).at(-1)?.opts.lastEventId).toBe(1);
		o.feed.push(ID, event(1), event(2), event(3));
		await o.clock.advance(1);
		expect(seqs(o.events)).toEqual([1, 2, 3]);
		expect(o.stale).toEqual([]);
		expect(o.recovered).toEqual([]);
		expect(o.giveUps).toEqual([]);
	});

	test("after 10 minutes without contact onStale is called once, with the failure, and retrying goes on", async () => {
		const o = outage();
		const failure = new Error("fetch failed");
		o.cut(failure);
		await o.clock.advance(9 * 60_000);
		expect(o.stale).toEqual([]);
		await o.clock.advance(2 * 60_000);
		expect(o.stale).toEqual([failure]);
		const attempts = o.feed.connections.length;
		await o.clock.advance(5 * 60_000);
		expect(o.stale).toHaveLength(1);
		expect(o.feed.connections.length).toBeGreaterThan(attempts + 15);
		expect(o.giveUps).toEqual([]);
	});

	test("contact returning after onStale calls onRecover once and the stream resumes from the last seq", async () => {
		const o = outage();
		await o.clock.advance(1);
		o.feed.push(ID, event(1), event(2));
		o.cut(new Error("fetch failed"));
		await o.clock.advance(12 * 60_000);
		expect(o.stale).toHaveLength(1);
		o.feed.down = undefined;
		await o.clock.advance(15_000);
		expect(o.recovered).toEqual([1]);
		expect(o.feed.of(ID).at(-1)?.opts.lastEventId).toBe(2);
		o.feed.push(ID, event(3));
		await o.clock.advance(1);
		expect(seqs(o.events)).toEqual([1, 2, 3]);
		expect(o.recovered).toEqual([1]);
	});

	test("a service that answers but keeps dropping the stream is not lost contact", async () => {
		const o = outage();
		await o.clock.advance(1);
		for (let i = 0; i < 40; i++) {
			o.feed.fail(ID, new Error("reset"));
			await o.clock.advance(30_000);
		}
		expect(o.stale).toEqual([]);
		expect(o.feed.connections.length).toBeGreaterThan(30);
	});

	test("a second outage after a recovery is reported again", async () => {
		const o = outage();
		o.cut(new Error("down 1"));
		await o.clock.advance(11 * 60_000);
		o.feed.down = undefined;
		await o.clock.advance(15_000);
		o.cut(new Error("down 2"));
		await o.clock.advance(11 * 60_000);
		expect(o.stale).toHaveLength(2);
		expect(o.recovered).toEqual([1]);
	});

	test("a 404 during an outage ends the follower", async () => {
		const o = outage();
		o.cut(new Error("fetch failed"));
		await o.clock.advance(60_000);
		const refusal = cloudErrorFromStatus(404, "no such thread");
		o.feed.down = refusal;
		await o.clock.advance(15_000);
		expect(o.giveUps).toEqual([refusal]);
		expect(o.stale).toEqual([]);
	});
});

describe("follow: stopping and options", () => {
	test("stop() aborts the open connection and nothing reconnects", async () => {
		const { source, calls } = script([event(1)], []);
		const r = run(source);
		await until(() => r.events.length === 1);
		await until(() => calls.length === 2); // the first stream ended; the second is open
		const signal = calls[1]?.signal;
		expect(signal?.aborted).toBe(false);
		r.follower.stop();
		expect(signal?.aborted).toBe(true);
		await Bun.sleep(30);
		expect(calls).toHaveLength(2);
		expect(r.giveUps).toEqual([]);
	});

	test("stop() during the reconnect delay prevents the next connection", async () => {
		const { source, calls } = script([new Error("reset")], [event(1)]);
		const r = run(source, { backoffMs: () => 200 });
		await until(() => calls.length === 1);
		await Bun.sleep(10);
		r.follower.stop();
		await Bun.sleep(250);
		expect(calls).toHaveLength(1);
		expect(r.events).toEqual([]);
		expect(r.giveUps).toEqual([]);
	});

	test("a failure after stop() is not reported as a give-up", async () => {
		const { source, calls } = script([20, cloudErrorFromStatus(404, "gone")]);
		const r = run(source);
		await until(() => calls.length === 1);
		r.follower.stop();
		await Bun.sleep(50);
		expect(r.giveUps).toEqual([]);
	});

	test("the idle timeout is passed to every connection", async () => {
		const { source, calls } = script([new Error("quiet")], []);
		const r = run(source, { idleMs: 1234 });
		await until(() => calls.length === 2);
		expect(calls.map(c => c.idleMs)).toEqual([1234, 1234]);
		r.follower.stop();
	});
});

class Sink implements WatchSink {
	turns: { id: number; events: number[] }[] = [];
	questions: PendingQuestion[] = [];
	turn(_h: unknown, _t: ThreadDetail, t: ThreadTurn, events: ThreadEvent[]): void {
		this.turns.push({ id: t.id, events: seqs(events) });
	}
	question(_h: unknown, _t: ThreadDetail, q: PendingQuestion): void {
		this.questions.push(q);
	}
}

describe("follow through a Watcher", () => {
	test("a replay after a reconnect neither refetches twice nor posts a second card", async () => {
		const f = fakeHost();
		const sink = new Sink();
		const states = [detail({ phase: "working", turns: [turn(1, { state: "running" })] }), detail({ phase: "idle", turns: [turn(1, { state: "done", title: "T", reply: "ok" })] })];
		let fetched = 0;
		const { source, calls } = script(
			[event(1), event(2), new Error("reset")],
			[event(1), event(2), event(3, { kind: "turn_done" }), event(3, { kind: "turn_done" })],
		);
		const w = new Watcher(
			f.host,
			{
				thread: async () => states[Math.min(fetched++, states.length - 1)] as ThreadDetail,
				events: source,
			},
			sink,
			{ backoffMs: () => 1 },
		);
		await w.watch("k3x9fa2m7q1z");
		await until(() => sink.turns.length === 1);
		await Bun.sleep(30);
		expect(calls[1]?.lastEventId).toBe(2);
		expect(sink.turns).toEqual([{ id: 1, events: [1, 2, 3] }]);
		expect(fetched).toBe(2); // the initial fetch and one refetch for the one turn_done
		expect(f.notes.filter(([m]) => m.includes("turn 1 done"))).toHaveLength(1);
		w.unwatch();
	});
});

describe("the SSE stream over HTTP", () => {
	interface Connection {
		/** Chunks to send; numbers sleep that many ms so each string reaches the client as its own read. */
		steps: (string | number)[];
		/** Stay open and silent once the steps are done. */
		hang?: boolean;
	}

	interface Seen {
		path: string;
		search: string;
		auth: string | null;
		lastEventId: string | null;
		accept: string | null;
	}

	let server: Server<undefined> | undefined;

	afterEach(() => {
		server?.stop(true);
		server = undefined;
	});

	function serve(...connections: Connection[]): { client: CloudClient; seen: Seen[] } {
		const seen: Seen[] = [];
		const enc = new TextEncoder();
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				seen.push({
					path: url.pathname,
					search: url.search,
					auth: req.headers.get("authorization"),
					lastEventId: req.headers.get("last-event-id"),
					accept: req.headers.get("accept"),
				});
				const conn = connections[seen.length - 1] ?? { steps: [], hang: true };
				let i = 0;
				const body = new ReadableStream<Uint8Array>({
					async pull(c) {
						while (i < conn.steps.length) {
							const step = conn.steps[i++];
							if (typeof step === "number") {
								await Bun.sleep(step);
								continue;
							}
							c.enqueue(enc.encode(step));
							return;
						}
						if (conn.hang) await new Promise<void>(() => {});
						c.close();
					},
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		return { client: new CloudClient(`http://127.0.0.1:${server.port}/`, "tok-123"), seen };
	}

	const data = (seq: number, text = `m${seq}`): string => JSON.stringify({ seq, at: "2026-01-01T00:00:00Z", kind: "assistant", turn: 1, text });
	const message = (seq: number, text?: string): string => `id: ${seq}\ndata: ${data(seq, text)}\n\n`;

	async function collect(it: AsyncIterable<ThreadEvent>): Promise<ThreadEvent[]> {
		const out: ThreadEvent[] = [];
		for await (const e of it) out.push(e);
		return out;
	}

	test("parses comments, split chunks and CRLF; sends the bearer token and ?after=", async () => {
		const whole = message(2, "second");
		const cut = whole.indexOf("sec"); // in the middle of the JSON payload
		const { client, seen } = serve({
			steps: [
				": connected\n\n",
				5,
				message(1, "first"),
				5,
				": keepalive\n\n",
				5,
				whole.slice(0, cut),
				5,
				whole.slice(cut),
				5,
				`: keepalive\r\n\r\nid: 3\r\ndata: ${data(3, "crlf")}\r\n\r\n`,
				5,
				// two messages in one chunk, the second one cut inside its terminator
				`${message(4)}id: 5\ndata: ${data(5)}\n`,
				5,
				"\n",
			],
		});
		const events = await collect(client.events("k3x9fa2m7q1z", { after: 0 }));
		expect(events.map(e => [e.seq, e.text])).toEqual([
			[1, "first"],
			[2, "second"],
			[3, "crlf"],
			[4, "m4"],
			[5, "m5"],
		]);
		expect(events[0]).toEqual({ seq: 1, at: "2026-01-01T00:00:00Z", kind: "assistant", turn: 1, text: "first" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.path).toBe("/api/v1/threads/k3x9fa2m7q1z/events");
		expect(seen[0]?.search).toBe("?after=0");
		expect(seen[0]?.auth).toBe("Bearer tok-123");
		expect(seen[0]?.accept).toBe("text/event-stream");
		expect(seen[0]?.lastEventId).toBeNull();
	});

	test("without options the request has neither ?after= nor Last-Event-ID; with lastEventId it sends the header only", async () => {
		const { client, seen } = serve({ steps: [message(1)] }, { steps: [message(8)] });
		await collect(client.events("k3x9fa2m7q1z"));
		await collect(client.events("k3x9fa2m7q1z", { lastEventId: 7 }));
		expect(seen.map(s => [s.search, s.lastEventId])).toEqual([
			["", null],
			["", "7"],
		]);
	});

	test("a message that is not an event is skipped, the stream goes on", async () => {
		const { client } = serve({ steps: ["data: not json\n\n", `data: ${JSON.stringify({ kind: "x" })}\n\n`, "data: [1]\n\n", message(1)] });
		expect((await collect(client.events("k3x9fa2m7q1z"))).map(e => e.seq)).toEqual([1]);
	});

	test("an error status throws a CloudError with the server's message and its code", async () => {
		server = Bun.serve({ port: 0, fetch: () => Response.json({ error: "no such thread" }, { status: 404 }) });
		const client = new CloudClient(`http://127.0.0.1:${server.port}`, "tok-123");
		const err = await collect(client.events("k3x9fa2m7q1z")).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CloudError);
		expect((err as CloudError).code).toBe("not_found");
		expect((err as CloudError).message).toBe("no such thread");
	});

	test("follow reconnects after the server drops the stream: Last-Event-ID, no ?after=, replayed seqs once", async () => {
		const { client, seen } = serve(
			{ steps: [": connected\n\n", 5, message(6), 5, message(7)] }, // then the server closes the stream
			{ steps: [": connected\n\n", 5, message(7), 5, message(8)], hang: true },
		);
		const r = run((id, o) => client.events(id, o), { after: 5 });
		await until(() => r.events.length === 3);
		await Bun.sleep(20);
		expect(seqs(r.events)).toEqual([6, 7, 8]);
		expect(seen).toHaveLength(2);
		expect(seen[0]?.search).toBe("?after=5");
		expect(seen[0]?.lastEventId).toBeNull();
		expect(seen[1]?.search).toBe("");
		expect(seen[1]?.lastEventId).toBe("7");
		expect(seen.every(s => s.auth === "Bearer tok-123")).toBe(true);
		r.follower.stop();
	});

	test("a server that goes silent makes the iterator throw once idleMs has passed", async () => {
		const { client } = serve({ steps: [": connected\n\n", 5, message(1)], hang: true });
		const got: number[] = [];
		const started = Date.now();
		const err = await (async () => {
			try {
				for await (const e of client.events("k3x9fa2m7q1z", { idleMs: 150 })) got.push(e.seq);
			} catch (e) {
				return e;
			}
			return undefined;
		})();
		expect(got).toEqual([1]);
		expect(err).toBeInstanceOf(Error);
		expect(Date.now() - started).toBeGreaterThanOrEqual(140);
	});

	test("keepalive comments reset the idle timer", async () => {
		const { client } = serve({ steps: [": connected\n\n", 60, ": keepalive\n\n", 60, ": keepalive\n\n", 60, message(1)] });
		const events = await collect(client.events("k3x9fa2m7q1z", { idleMs: 100 }));
		expect(events.map(e => e.seq)).toEqual([1]);
	});

	test("follow treats the idle timeout as a dropped connection and resumes", async () => {
		const { client, seen } = serve({ steps: [message(1)], hang: true }, { steps: [message(2)], hang: true });
		const r = run((id, o) => client.events(id, o), { idleMs: 100 });
		await until(() => r.events.length === 2);
		expect(seen[1]?.lastEventId).toBe("1");
		expect(seen[1]?.search).toBe("");
		r.follower.stop();
	});

	test("aborting the signal ends the iteration with the connection closed", async () => {
		const { client } = serve({ steps: [message(1)], hang: true });
		const ctrl = new AbortController();
		const got: number[] = [];
		const err = await (async () => {
			try {
				for await (const e of client.events("k3x9fa2m7q1z", { signal: ctrl.signal })) {
					got.push(e.seq);
					ctrl.abort();
				}
			} catch (e) {
				return e;
			}
			return undefined;
		})();
		expect(got).toEqual([1]);
		expect(err).toBeInstanceOf(Error);
	});
});
