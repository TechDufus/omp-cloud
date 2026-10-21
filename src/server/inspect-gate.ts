import { ApiError } from "./errors";

/** How many inspections (each builds a scratch repository and fetches the result bundle) may run at once, process-wide. */
export const MAX_RUNNING_INSPECTIONS = 2;
/** How long a request waits for a place before it is told to retry. */
export const INSPECTION_WAIT_MS = 30_000;
/** What a busy answer tells the client to wait, in seconds. */
const RETRY_AFTER_SECONDS = 5;

interface Waiter {
	/** Hands the freed place to this waiter. */
	grant(): void;
}

/**
 * Admits at most `limit` runs at a time and queues the rest in arrival order. A waiter gives up when its signal aborts
 * (the client went away) or after `waitMs`, which answers 503 with `Retry-After`.
 */
export class InspectGate {
	readonly #limit: number;
	readonly #waitMs: number;
	#running = 0;
	readonly #waiters: Waiter[] = [];

	constructor(limit: number = MAX_RUNNING_INSPECTIONS, waitMs: number = INSPECTION_WAIT_MS) {
		this.#limit = limit;
		this.#waitMs = waitMs;
	}

	/** How many requests wait for a place. */
	get waiting(): number {
		return this.#waiters.length;
	}

	/** Runs `work` once a place is free. Throws ApiError(503) when none frees up in time and ApiError(499) when `signal` aborts first (nobody reads that answer). */
	async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
		await this.#admit(signal);
		try {
			return await work();
		} finally {
			// A freed place goes straight to the longest waiter; the running count stays.
			const next = this.#waiters.shift();
			if (next === undefined) this.#running--;
			else next.grant();
		}
	}

	#admit(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(new ApiError(499, "the request was closed"));
		if (this.#running < this.#limit && this.#waiters.length === 0) {
			this.#running++;
			return Promise.resolve();
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const leave = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			const at = this.#waiters.indexOf(waiter);
			if (at >= 0) this.#waiters.splice(at, 1);
		};
		const waiter: Waiter = {
			grant: () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
		};
		const onAbort = (): void => {
			leave();
			reject(new ApiError(499, "the request was closed"));
		};
		const timer = setTimeout(() => {
			leave();
			reject(new ApiError(503, "inspection busy; retry shortly", { "Retry-After": String(RETRY_AFTER_SECONDS) }));
		}, this.#waitMs);
		signal.addEventListener("abort", onAbort, { once: true });
		this.#waiters.push(waiter);
		return promise;
	}
}

/** The one gate of the service process. */
export const INSPECTION_GATE = new InspectGate();
