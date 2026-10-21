/**
 * Following a thread's event stream: connect, hand each event over once, and reconnect with
 * `Last-Event-ID` when the connection drops or goes quiet, the way an `EventSource` does.
 */

import type { EventStreamOptions } from "./api";
import { CloudError } from "./errors";
import type { ThreadEvent } from "./types";

/** Kinds the service writes in the same transaction as the change they describe; a client refetches the thread on each. */
export const LIFECYCLE_KINDS: ReadonlySet<string> = new Set([
	"turn_queued",
	"turn_started",
	"turn_done",
	"turn_failed",
	"turn_cancelled",
	"turn_requeued",
	"stop_requested",
	"question_asked",
	"question_answered",
	"question_expired",
	"thread_failed",
]);

/** The message the cloud agent sent out (its `text` is the JSON of an `IrcPayload`). Not a lifecycle kind: nothing to refetch, the follower hands it to omp's IRC. */
export const IRC_OUT_KIND = "irc";
/** A message delivered to the cloud agent, which the service echoes into the log; the plugin never acts on it, so a message cannot come back to its sender. */
export const IRC_IN_KIND = "irc_in";

export type EventSource = (id: string, opts: EventStreamOptions) => AsyncIterable<ThreadEvent>;

/** What time the follower and the watcher read and wait on; tests substitute one they advance themselves. */
export interface Clock {
	now(): number;
	/** Resolves after `ms`, or as soon as `signal` aborts. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const wallClock: Clock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise<void>(resolve => {
			if (signal?.aborted) return resolve();
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		}),
};

export interface FollowHandlers {
	/** Each event once, in sequence order. */
	onEvent(event: ThreadEvent): void;
	/** The service no longer has the thread (a refused request that retrying cannot change); the follower has stopped. */
	onGiveUp(error: unknown): void;
	/** No contact with the service for `staleAfterMs`; the follower keeps retrying. Called once per outage. */
	onStale?(error: unknown): void;
	/** Contact is back after `onStale`: a connection opened or an event arrived. */
	onRecover?(): void;
}

export interface FollowOptions {
	/** Start after this sequence number; without it the stream starts at the first event. */
	after?: number;
	/** Delay before reconnect attempt `n` (1-based). Defaults to 1 s doubling up to 15 s. */
	backoffMs?: (attempt: number) => number;
	/** How long contact may be lost before `onStale` is called. Defaults to 10 minutes. */
	staleAfterMs?: number;
	/** A connection that lasted this long counts as healthy: the backoff starts over. */
	healthyMs?: number;
	idleMs?: number;
	clock?: Clock;
}

export interface Follower {
	/** Sequence number of the last event handed over, or the `after` it started from. */
	readonly lastSeq: number;
	stop(): void;
}

const defaultBackoff = (attempt: number): number => Math.min(15_000, 1000 * 2 ** (attempt - 1));

/** A refusal the next attempt cannot change: the service does not know the thread. Everything else (a bad token, a restart, a network failure) is retried: the owner may fix it while the turn keeps running. */
function gone(e: unknown): boolean {
	return e instanceof CloudError && e.code === "not_found";
}

/**
 * Follows `id` until `stop()` or until the service says the thread does not exist. The first connection sends `?after=`
 * (when given); every reconnection sends `Last-Event-ID` with the last sequence number handled, so no event is lost or
 * handled twice. A lost connection is retried with a capped backoff for as long as it takes; after `staleAfterMs` without
 * contact `onStale` is called once, and `onRecover` when contact returns.
 */
export function follow(source: EventSource, id: string, handlers: FollowHandlers, opts: FollowOptions = {}): Follower {
	const ctrl = new AbortController();
	const backoff = opts.backoffMs ?? defaultBackoff;
	const staleAfterMs = opts.staleAfterMs ?? 10 * 60_000;
	const healthyMs = opts.healthyMs ?? 30_000;
	const clock = opts.clock ?? wallClock;
	let last = opts.after ?? 0;
	/** When the current outage began; undefined while there is contact. */
	let outageSince: number | undefined;
	let stale = false;

	/** The service answered: the outage, if any, is over. */
	const contact = (): void => {
		outageSince = undefined;
		if (!stale) return;
		stale = false;
		handlers.onRecover?.();
	};

	void (async () => {
		let failures = 0;
		let reconnecting = false;
		while (!ctrl.signal.aborted) {
			const started = clock.now();
			let error: unknown;
			try {
				const resume = reconnecting ? { lastEventId: last } : opts.after !== undefined ? { after: last } : {};
				for await (const event of source(id, { signal: ctrl.signal, idleMs: opts.idleMs, onOpen: contact, ...resume })) {
					if (event.seq <= last) continue;
					last = event.seq;
					failures = 0;
					contact();
					handlers.onEvent(event);
				}
			} catch (e) {
				error = e;
			}
			if (ctrl.signal.aborted) return;
			if (gone(error)) {
				handlers.onGiveUp(error);
				return;
			}
			const failedAt = clock.now();
			if (failedAt - started >= healthyMs) failures = 0;
			failures++;
			outageSince ??= failedAt;
			if (!stale && failedAt - outageSince >= staleAfterMs) {
				stale = true;
				handlers.onStale?.(error ?? new Error("the event stream keeps closing"));
			}
			reconnecting = true;
			await clock.sleep(backoff(failures), ctrl.signal);
		}
	})();

	return {
		get lastSeq() {
			return last;
		},
		stop: () => ctrl.abort(),
	};
}
