import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type ThreadListener } from "../store";
import type { NewThread, ThreadEvent } from "../store/types";
import { ApiError } from "./errors";
import { eventStream } from "./events";

const OWNER = "owner";

let dir: string;
let store: Store;
let threadId: string;

const NEW_THREAD: NewThread = {
	owner: OWNER,
	title: "t",
	prompt: "do it",
	model: "",
	thinking: "",
	repo: { name: "proj", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "a".repeat(40), localBranch: "" },
	paths: { home: "", workspace: "" },
	author: { name: "", email: "" },
	secretFiles: [],
	secretEnv: [],
	configOverlays: [],
	ompVersion: "18.12.3",
	policy: {},
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	store = Store.open({ dataDir: dir });
	// Creating the thread appends event 1 (turn_queued).
	threadId = store.newThreadId();
	store.createThread(threadId, NEW_THREAD);
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function request(query = "", headers: Record<string, string> = {}, signal?: AbortSignal): Request {
	return new Request(`http://127.0.0.1/api/v1/threads/${threadId}/events${query}`, { headers, signal });
}

/** Appends `count` progress events; returns them. */
function append(count: number, kind = "note"): ThreadEvent[] {
	return Array.from({ length: count }, (_, i) => store.appendEvent(threadId, kind, `text ${i}`, null));
}

/** Reads the stream chunk by chunk and parses its messages. */
class Sse {
	private readonly reader: {
		read(): Promise<{ done: boolean; value?: Uint8Array }>;
		cancel(): Promise<void>;
	};
	private readonly decoder = new TextDecoder();
	private buffer = "";

	constructor(response: Response) {
		const body: ReadableStream<Uint8Array> | null = response.body;
		if (body === null) throw new Error("no body");
		this.reader = body.getReader();
	}

	/** The next message (an event or a comment) as raw text, or null when the stream ended. */
	async message(): Promise<string | null> {
		for (;;) {
			const end = this.buffer.indexOf("\n\n");
			if (end >= 0) {
				const message = this.buffer.slice(0, end);
				this.buffer = this.buffer.slice(end + 2);
				return message;
			}
			const { done, value } = await this.reader.read();
			if (done) return null;
			this.buffer += this.decoder.decode(value, { stream: true });
		}
	}

	/** The next event message, skipping comments. */
	async event(): Promise<{ id: string; data: ThreadEvent } | null> {
		for (;;) {
			const message = await this.message();
			if (message === null) return null;
			if (message.startsWith(":")) continue;
			const [idLine, dataLine, ...extra] = message.split("\n");
			expect(extra).toEqual([]);
			expect(idLine?.startsWith("id: ")).toBe(true);
			expect(dataLine?.startsWith("data: ")).toBe(true);
			return { id: idLine!.slice(4), data: JSON.parse(dataLine!.slice(6)) as ThreadEvent };
		}
	}

	/** The seqs of the next `count` events. */
	async seqs(count: number): Promise<number[]> {
		const seqs: number[] = [];
		for (let i = 0; i < count; i++) {
			const event = await this.event();
			if (event === null) throw new Error("the stream ended early");
			expect(event.id).toBe(String(event.data.seq));
			seqs.push(event.data.seq);
		}
		return seqs;
	}

	cancel(): Promise<void> {
		return this.reader.cancel();
	}
}

/** Counts the listeners a store has handed out and not yet had unsubscribed. */
function tracked(): { store: Store; listeners(): number } {
	let live = 0;
	const proxy = new Proxy(store, {
		get(target, prop) {
			if (prop !== "subscribe") return Reflect.get(target, prop, target) as unknown;
			return (id: string, listener: ThreadListener): (() => void) => {
				const unsubscribe = target.subscribe(id, listener);
				live++;
				let released = false;
				return () => {
					if (!released) live--;
					released = true;
					unsubscribe();
				};
			};
		},
	});
	return { store: proxy, listeners: () => live };
}

function open(query = "", headers: Record<string, string> = {}, keepaliveMs?: number): Sse {
	return new Sse(eventStream(store, threadId, request(query, headers), undefined, { keepaliveMs }));
}

describe("the backlog", () => {
	test("sends every stored event, then stays open", async () => {
		append(2);
		const sse = open();
		expect(await sse.seqs(3)).toEqual([1, 2, 3]);
		append(1);
		expect(await sse.seqs(1)).toEqual([4]);
		await sse.cancel();
	});

	test("a message is id and data only, with the event's fields", async () => {
		const [event] = append(1, "tool_call");
		const sse = open("?after=1");
		const message = await sse.message();
		expect(message).toBe(`id: 2\ndata: ${JSON.stringify({ seq: 2, at: event!.at, kind: "tool_call", turn: null, text: "text 0" })}`);
		await sse.cancel();
	});

	test("the response is an uncached event stream", () => {
		const response = eventStream(store, threadId, request(), undefined);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		void response.body?.cancel();
	});

	test("?after= skips the events up to and including it", async () => {
		append(3);
		const sse = open("?after=2");
		expect(await sse.seqs(2)).toEqual([3, 4]);
		await sse.cancel();
	});

	test("Last-Event-ID resumes the same way", async () => {
		append(3);
		const sse = open("", { "Last-Event-ID": "3" });
		expect(await sse.seqs(1)).toEqual([4]);
		await sse.cancel();
	});

	test("?after= wins over Last-Event-ID", async () => {
		append(3);
		const sse = open("?after=1", { "Last-Event-ID": "3" });
		expect(await sse.seqs(3)).toEqual([2, 3, 4]);
		await sse.cancel();
	});

	test("an after beyond the last event sends nothing until a newer one arrives", async () => {
		const sse = open("?after=5");
		// The backlog holds nothing past the cursor.
		append(5); // seqs 2..6
		expect(await sse.seqs(1)).toEqual([6]);
		await sse.cancel();
	});

	test("a backlog longer than one page arrives complete and in order", async () => {
		append(1200);
		const sse = open();
		const seqs = await sse.seqs(1201);
		expect(seqs).toEqual(Array.from({ length: 1201 }, (_, i) => i + 1));
		await sse.cancel();
	});

	test.each([["abc"], ["-1"], ["1.5"], [""], ["1e3"], [" 2"], ["99999999999999999999"]])("an invalid after %p is 400 before streaming", value => {
		let error: unknown;
		try {
			eventStream(store, threadId, request(`?after=${encodeURIComponent(value)}`), undefined);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
	});

	test("an invalid Last-Event-ID is 400 too", () => {
		expect(() => eventStream(store, threadId, request("", { "Last-Event-ID": "x" }), undefined)).toThrow(ApiError);
	});

	test("a bad after fails even when the header is fine", () => {
		expect(() => eventStream(store, threadId, request("?after=x", { "Last-Event-ID": "1" }), undefined)).toThrow(ApiError);
	});
});

describe("live events", () => {
	test("an event appended after connecting is delivered once", async () => {
		const sse = open();
		expect(await sse.seqs(1)).toEqual([1]);
		append(2);
		expect(await sse.seqs(2)).toEqual([2, 3]);
		append(1);
		expect(await sse.seqs(1)).toEqual([4]);
		await sse.cancel();
	});

	test("lifecycle events from the store arrive too", async () => {
		const sse = open("?after=1");
		store.enqueueTurn(threadId, "again", OWNER);
		const event = await sse.event();
		expect(event?.data).toMatchObject({ seq: 2, kind: "turn_queued", turn: 2, text: `queued by ${OWNER}` });
		await sse.cancel();
	});

	test("events appended while the backlog is read are neither lost, duplicated nor reordered", async () => {
		append(3);
		// A store whose backlog reads append more events mid-read, as another request could between pages.
		let racing = 2;
		const racy = new Proxy(store, {
			get(target, prop) {
				if (prop !== "events") return Reflect.get(target, prop, target) as unknown;
				return (id: string, after: number, limit: number): ThreadEvent[] => {
					const page = target.events(id, after, limit);
					if (racing-- > 0) target.appendEvent(id, "raced", "during backlog", null);
					return page;
				};
			},
		});
		const sse = new Sse(eventStream(racy, threadId, request(), undefined));
		const seqs = await sse.seqs(6);
		expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
		append(1);
		expect(await sse.seqs(1)).toEqual([7]);
		append(1);
		expect(await sse.seqs(1)).toEqual([8]);
		await sse.cancel();
	});

	test("every stream of a thread gets every event", async () => {
		const [a, b] = [open(), open()];
		append(2);
		expect(await a.seqs(3)).toEqual([1, 2, 3]);
		expect(await b.seqs(3)).toEqual([1, 2, 3]);
		await Promise.all([a.cancel(), b.cancel()]);
	});

	test("another thread's events are not sent", async () => {
		const other = store.newThreadId();
		store.createThread(other, NEW_THREAD);
		const sse = open("?after=1");
		store.appendEvent(other, "note", "elsewhere", null);
		store.appendEvent(threadId, "note", "here", null);
		expect((await sse.event())?.data.text).toBe("here");
		await sse.cancel();
	});
});

describe("ending", () => {
	test("the stream ends after the thread is deleted", async () => {
		const sse = open();
		expect(await sse.seqs(1)).toEqual([1]);
		await store.deleteThread(threadId);
		expect(await sse.message()).toBeNull();
	});

	test("a stream that failed to start leaves nothing behind", () => {
		const watched = tracked();
		const broken = new Proxy(watched.store, {
			get(target, prop) {
				if (prop === "events") {
					return (): ThreadEvent[] => {
						throw new Error("disk failure");
					};
				}
				return Reflect.get(target, prop, target) as unknown;
			},
		});
		expect(() => eventStream(broken, threadId, request(), undefined)).toThrow("disk failure");
		expect(watched.listeners()).toBe(0);
	});

	test("cancelling the reader unsubscribes: later events still work and nothing is enqueued", async () => {
		const response = eventStream(store, threadId, request(), undefined);
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();
		// A throwing or enqueueing listener would surface here; the store logs listener errors instead of throwing.
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void errors.push(args);
		try {
			expect(append(1)[0]?.seq).toBe(2);
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
		// The thread still notifies its other listeners.
		const sse = open("?after=2");
		append(1);
		expect(await sse.seqs(1)).toEqual([3]);
		await sse.cancel();
	});

	test("an aborted request ends the stream and releases it", async () => {
		const abort = new AbortController();
		const sse = new Sse(eventStream(store, threadId, request("", {}, abort.signal), undefined));
		expect(await sse.seqs(1)).toEqual([1]);
		abort.abort();
		expect(await sse.message()).toBeNull();
		expect(append(1)[0]?.seq).toBe(2);
	});

	test("an already aborted request streams nothing", async () => {
		const abort = new AbortController();
		abort.abort();
		const sse = new Sse(eventStream(store, threadId, request("", {}, abort.signal), undefined));
		expect(await sse.message()).toBeNull();
	});
});

describe("keepalive", () => {
	test("comments arrive at the injected interval, between events", async () => {
		// A real short interval: the keepalive timer itself is what is under test.
		const sse = open("?after=1", {}, 20);
		expect(await sse.message()).toBe(": connected");
		expect(await sse.message()).toBe(": keepalive");
		expect(await sse.message()).toBe(": keepalive");
		append(1);
		expect((await sse.event())?.data.seq).toBe(2);
		await sse.cancel();
	});

	test.each(["cancel", "abort", "delete"] as const)("nothing is left running after the stream ends by %s", async how => {
		const created = spyOn(globalThis, "setInterval");
		const cleared = spyOn(globalThis, "clearInterval");
		try {
			const watched = tracked();
			const abort = new AbortController();
			const sse = new Sse(eventStream(watched.store, threadId, request("", {}, abort.signal), undefined, { keepaliveMs: 10_000 }));
			expect(await sse.seqs(1)).toEqual([1]);
			expect(watched.listeners()).toBe(1);
			const handle: unknown = created.mock.results[0]?.value;
			expect(handle).toBeDefined();

			if (how === "cancel") await sse.cancel();
			else if (how === "abort") abort.abort();
			else await store.deleteThread(threadId);

			expect(watched.listeners()).toBe(0);
			expect(cleared).toHaveBeenCalledWith(handle);
		} finally {
			created.mockRestore();
			cleared.mockRestore();
		}
	});
});

describe("the server's idle timeout", () => {
	test("is disabled for the request", () => {
		const calls: [Request, number][] = [];
		const req = request();
		const server = { timeout: (r: Request, seconds: number) => void calls.push([r, seconds]) } as unknown as Parameters<typeof eventStream>[3];
		void eventStream(store, threadId, req, server).body?.cancel();
		expect(calls).toEqual([[req, 0]]);
	});
});
