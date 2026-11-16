import type { Store } from "../store";
import type { LiveText, ThreadEvent } from "../store/types";
import type { ApiServer } from "./api-server";
import { ApiError } from "./errors";
import { intParam } from "./query";

/** Interval of the `: keepalive` comments. */
const KEEPALIVE_MS = 15_000;
/** Events read per backlog page. */
const PAGE_SIZE = 500;

export interface EventStreamOptions {
	/** Test seam: the keepalive interval in milliseconds. */
	keepaliveMs?: number;
}

/** The resume point: `?after=`, else the `Last-Event-ID` header, else 0. */
function parseAfter(req: Request): number {
	const raw = new URL(req.url).searchParams.get("after") ?? req.headers.get("last-event-id") ?? "0";
	const after = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isSafeInteger(after)) throw new ApiError(400, "after must be a non-negative integer");
	return after;
}

/** `?text=1` asks for the running turn's reply text too; absent is off. Throws ApiError(400) for any other value. */
function parseText(req: Request): boolean {
	const raw = new URL(req.url).searchParams.get("text");
	if (raw === null) return false;
	if (raw !== "1") throw new ApiError(400, "text must be 1");
	return true;
}

/**
 * GET /api/v1/threads/{id}/events for a thread the caller may read: every stored event above `after`, then the live
 * ones, until the thread is deleted or the client goes away. With `?text=1` the reply text of the running turn is sent as
 * `event: text` messages between them: the message being written whole so far after the backlog, then each piece. Throws
 * ApiError(400) for a bad `after` or `text` before streaming.
 */
export function eventStream(
	store: Store,
	threadId: string,
	req: Request,
	server: ApiServer | undefined,
	options: EventStreamOptions = {},
): Response {
	const after = parseAfter(req);
	const wantsText = parseText(req);
	// The stream is silent between events; Bun's idle timeout would cut the connection.
	server?.timeout(req, 0);

	const encoder = new TextEncoder();
	let cleanup: () => void = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let lastSent = after;
			let closed = false;
			let backlogDone = false;
			const queued: (ThreadEvent | LiveText)[] = [];
			let keepalive: NodeJS.Timeout | undefined;
			let unsubscribe: (() => void) | undefined;

			const stop = (): void => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				clearInterval(keepalive);
				req.signal.removeEventListener("abort", end);
			};
			// The server ends the stream (deleted thread, aborted request).
			function end(): void {
				if (closed) return;
				stop();
				controller.close();
			}
			cleanup = stop;

			const send = (event: ThreadEvent): void => {
				if (closed || event.seq <= lastSent) return;
				lastSent = event.seq;
				const data = JSON.stringify({
					seq: event.seq,
					at: event.at,
					kind: event.kind,
					turn: event.turn,
					text: event.text,
				});
				controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${data}\n\n`));
			};

			// Not an event: no `id:` line, so `Last-Event-ID` never names it.
			const sendText = (live: LiveText): void => {
				if (closed) return;
				const data = JSON.stringify({ turn: live.turn, message: live.message, offset: live.offset, text: live.text });
				controller.enqueue(encoder.encode(`event: text\ndata: ${data}\n\n`));
			};

			if (req.signal.aborted) {
				end();
				return;
			}
			req.signal.addEventListener("abort", end, { once: true });
			try {
				// Subscribe before reading so no event falls between the backlog and the live stream.
				unsubscribe = store.subscribe(threadId, {
					event: event => {
						if (backlogDone) send(event);
						else queued.push(event);
					},
					deleted: end,
					...(wantsText
						? {
								text: (live: LiveText) => {
									if (backlogDone) sendText(live);
									else queued.push(live);
								},
							}
						: {}),
				});
				keepalive = setInterval(() => {
					if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
				}, options.keepaliveMs ?? KEEPALIVE_MS);
				for (let page = store.events(threadId, lastSent, PAGE_SIZE); page.length > 0 && !closed; ) {
					for (const event of page) send(event);
					page = store.events(threadId, lastSent, PAGE_SIZE);
				}
				const snapshot = wantsText ? store.liveText(threadId) : null;
				if (snapshot !== null) sendText(snapshot);
				for (const item of queued) {
					if ("seq" in item) send(item);
					else sendText(item);
				}
				queued.length = 0;
				backlogDone = true;
				// Bun sends the response headers with the first chunk; without a backlog the client would wait for a keepalive.
				if (!closed && lastSent === after) controller.enqueue(encoder.encode(": connected\n\n"));
			} catch (error) {
				stop();
				throw error;
			}
		},
		cancel() {
			cleanup();
		},
	});

	return new Response(body, {
		headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" },
	});
}

/**
 * GET /api/v1/events: every live event of every thread `owner` owns, and each of their deletions, until the client goes
 * away. No backlog and no `id:` field: the client reads the lists over the ordinary routes when it connects (the stream
 * announces itself with a comment) and again on every reconnect.
 */
export function globalEventStream(
	store: Store,
	owner: string,
	req: Request,
	server: ApiServer | undefined,
	options: EventStreamOptions = {},
): Response {
	server?.timeout(req, 0);

	const encoder = new TextEncoder();
	let cleanup: () => void = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let keepalive: NodeJS.Timeout | undefined;
			let unsubscribe: (() => void) | undefined;

			const stop = (): void => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				clearInterval(keepalive);
				req.signal.removeEventListener("abort", end);
			};
			function end(): void {
				if (closed) return;
				stop();
				controller.close();
			}
			cleanup = stop;

			const send = (data: unknown): void => {
				if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
			};

			if (req.signal.aborted) {
				end();
				return;
			}
			req.signal.addEventListener("abort", end, { once: true });
			unsubscribe = store.subscribeAll({
				event: (threadId, event) => {
					if (store.threadOwner(threadId) !== owner) return;
					send({ thread: threadId, seq: event.seq, at: event.at, kind: event.kind, turn: event.turn, text: event.text });
				},
				deleted: threadId => {
					if (store.threadOwner(threadId) === owner) send({ thread: threadId, deleted: true });
				},
			});
			keepalive = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
			}, options.keepaliveMs ?? KEEPALIVE_MS);
			// Bun sends the response headers with the first chunk.
			controller.enqueue(encoder.encode(": connected\n\n"));
		},
		cancel() {
			cleanup();
		},
	});

	return new Response(body, {
		headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" },
	});
}

/** The shape of a stored event kind (the store's own rule): a bad `kind` filter is refused up front. */
const EVENT_KIND = /^[a-z][a-z0-9_]{0,31}$/;
/** The most kinds one `kind` filter lists. */
const MAX_KIND_FILTERS = 32;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

/** What `GET /api/v1/threads/{id}/events?format=json` answers: `next` is the `after` of the following page, null at the end. */
export interface EventsPage {
	events: { seq: number; at: string; kind: string; turn: number | null; text: string }[];
	next: number | null;
}

/**
 * GET /api/v1/threads/{id}/events?format=json for a thread the caller may read: the stored events above `after` (default 0)
 * that match `kind` (a comma list) and `turn`, at most `limit` (1 to 500, default 100) in seq order. Throws ApiError(400)
 * naming the bad parameter.
 */
export function eventsPage(store: Store, threadId: string, url: URL): EventsPage {
	const params = url.searchParams;
	const after = intParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
	const limit = intParam(url, "limit", 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT);
	const turn = params.has("turn") ? intParam(url, "turn", 1, Number.MAX_SAFE_INTEGER, 0) : null;
	const kinds = (params.get("kind") ?? "").split(",").filter((kind) => kind !== "");
	if (kinds.length > MAX_KIND_FILTERS || !kinds.every((kind) => EVENT_KIND.test(kind))) {
		throw new ApiError(400, `kind must be a comma list of at most ${MAX_KIND_FILTERS} event kinds`);
	}

	// One more than a page tells whether another page exists.
	const matched: ThreadEvent[] = [];
	for (let cursor = after; matched.length <= limit; ) {
		const batch = store.events(threadId, cursor, PAGE_SIZE);
		for (const event of batch) {
			cursor = event.seq;
			if ((turn === null || event.turn === turn) && (kinds.length === 0 || kinds.includes(event.kind))) matched.push(event);
			if (matched.length > limit) break;
		}
		if (batch.length < PAGE_SIZE) break;
	}
	const page = matched.slice(0, limit).map((event) => ({ seq: event.seq, at: event.at, kind: event.kind, turn: event.turn, text: event.text }));
	return { events: page, next: matched.length > limit ? (page.at(-1)?.seq ?? null) : null };
}
