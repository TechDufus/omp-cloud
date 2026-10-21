/**
 * Waiting for cloud threads: which state of a thread ends a wait, and the waiter that watches several threads at once.
 * The watcher feeds it what its streams show; threads the session does not follow are polled, and so is anything a
 * missed event could have stranded.
 */

import { CloudError } from "./errors";
import type { Clock } from "./events";
import type { ThreadDetail } from "./types";

/** What a thread can be waited on for. */
export type WaitKind = "done" | "failed" | "question";

export type WaitOutcome = WaitKind | "deleted" | "timeout" | "stale";

export interface WaitOptions {
	/** `any` ends the wait at the first thread that settles; `all` when every thread has. */
	until: "any" | "all";
	on: readonly WaitKind[];
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface WaitResult {
	threadId: string;
	outcome: WaitOutcome;
	/** The turn the outcome is about (`done`, `failed`, `question`). */
	turn?: number;
}

/** How often threads that are not followed are fetched. */
export const WAIT_POLL_MS = 10_000;

/** Whether the thread has a turn that has not ended, or is starting one. */
export function isActive(t: Pick<ThreadDetail, "phase" | "turns">): boolean {
	return t.phase === "starting" || t.phase === "working" || t.phase === "waiting" || t.turns.some(x => x.state === "queued" || x.state === "running");
}

/** What one look at a thread showed. */
export type Observation = { id: string; state: "detail"; detail: ThreadDetail } | { id: string; state: "gone" } | { id: string; state: "stale" };

/**
 * What one look at a thread says to a wait for `on`. A thread that is not working has settled whatever `on` says: it is
 * judged by its latest ended turn, so an idle thread answers at once with how its last turn went. A working thread
 * answers only with the question it waits on, and only when `on` asks for questions.
 */
export function verdict(o: Observation, on: readonly WaitKind[]): WaitResult | undefined {
	if (o.state === "gone") return { threadId: o.id, outcome: "deleted" };
	if (o.state === "stale") return { threadId: o.id, outcome: "stale" };
	const d = o.detail;
	if (d.question && on.includes("question")) return { threadId: o.id, outcome: "question", turn: d.question.turn };
	if (isActive(d)) return undefined;
	const last = d.turns.findLast(t => t.state === "done" || t.state === "failed" || t.state === "cancelled");
	const turn = last ? { turn: last.id } : {};
	const outcome = d.phase === "failed" || last?.state === "failed" || last?.state === "cancelled" ? "failed" : "done";
	return { threadId: o.id, outcome, ...turn };
}

/** The wait was cancelled by its caller. */
function abortedError(): CloudError {
	return new CloudError({ code: "aborted", message: "the wait was cancelled", retriable: false, outcomeKnown: true });
}

/** What the waiter reads of the watcher. */
export interface WaitSource {
	clock: Clock;
	/** A thread this session follows, as its watcher last saw it; undefined when it is not followed. */
	followed(id: string): { detail: ThreadDetail; stale: boolean } | undefined;
	/** The thread as the service has it now. */
	fetch(id: string, signal: AbortSignal): Promise<ThreadDetail>;
}

interface Waiter {
	observe(o: Observation): void;
}

export class Waits {
	readonly #source: WaitSource;
	readonly #waiters = new Set<Waiter>();

	constructor(source: WaitSource) {
		this.#source = source;
	}

	/** The watcher saw `o`: every waiter on that thread takes it in. */
	observe(o: Observation): void {
		for (const waiter of [...this.#waiters]) waiter.observe(o);
	}

	/**
	 * Resolves with the outcome of the threads that settled (all of the requested ones, in order, once `until: "all"` is
	 * met or the time is up; a thread still waiting then reads `timeout`). Rejects with an `aborted` CloudError when
	 * `signal` fires.
	 */
	async run(threads: readonly string[], opts: WaitOptions): Promise<WaitResult[]> {
		const ids = [...new Set(threads)];
		if (ids.length === 0) return [];
		const results = new Map<string, WaitResult>();
		const done = Promise.withResolvers<void>();
		const ctrl = new AbortController();
		let timedOut = false;
		const waiter: Waiter = {
			observe: o => {
				if (!ids.includes(o.id) || results.has(o.id)) return;
				const r = verdict(o, opts.on);
				if (!r) return;
				results.set(o.id, r);
				if (opts.until === "any" || results.size === ids.length) done.resolve();
			},
		};
		if (opts.signal?.aborted) throw abortedError();
		const onAbort = (): void => done.reject(abortedError());
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		this.#waiters.add(waiter);
		try {
			for (const id of ids) {
				const known = this.#source.followed(id);
				if (!known) continue;
				waiter.observe(known.stale ? { id, state: "stale" } : { id, state: "detail", detail: known.detail });
			}
			void this.#poll(ids, results, waiter, ctrl.signal);
			void this.#source.clock.sleep(opts.timeoutMs, ctrl.signal).then(() => {
				if (ctrl.signal.aborted) return;
				timedOut = true;
				done.resolve();
			});
			await done.promise;
		} finally {
			ctrl.abort();
			opts.signal?.removeEventListener("abort", onAbort);
			this.#waiters.delete(waiter);
		}
		return ids.flatMap((id): WaitResult[] => {
			const r = results.get(id);
			if (r) return [r];
			return timedOut ? [{ threadId: id, outcome: "timeout" }] : [];
		});
	}

	/** Fetches the threads that have no stream here (all of them at first), until the wait ends. */
	async #poll(ids: readonly string[], results: ReadonlyMap<string, WaitResult>, waiter: Waiter, signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			await Promise.all(
				ids
					.filter(id => !results.has(id) && !this.#source.followed(id))
					.map(async id => {
						try {
							waiter.observe({ id, state: "detail", detail: await this.#source.fetch(id, signal) });
						} catch (e) {
							// A failed fetch is tried again at the next poll; only a thread the service does not know ends the wait.
							if (e instanceof CloudError && e.code === "not_found") waiter.observe({ id, state: "gone" });
						}
					}),
			);
			await this.#source.clock.sleep(WAIT_POLL_MS, signal);
		}
	}
}
