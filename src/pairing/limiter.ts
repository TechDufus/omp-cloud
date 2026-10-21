import { parseIp } from "./cidr";

/** Failures from one source tolerated per window. */
export const MAX_SOURCE_FAILURES = 10;
export const SOURCE_WINDOW_MS = 60_000;
/** Sources tracked at once; the one whose last failure is oldest goes first. */
export const MAX_SOURCE_BUCKETS = 4096;

/** The bucket of an address: IPv4 as is (a mapped IPv6 address too), IPv6 by its /64, anything unparseable by its text. */
export function sourceKey(address: string): string {
	const ip = parseIp(address);
	if (ip === null) return `raw:${address}`;
	return ip.family === 4 ? `v4:${ip.value}` : `v6:${(ip.value >> 64n).toString(16)}`;
}

/**
 * Counts failed pairing attempts per source in a sliding window. A source with `max` failures inside the window is
 * blocked until the oldest ages out; successes never count and nothing blocks everyone. The map stays in order of each
 * bucket's last failure, so the first key is the one to evict.
 */
export class SourceLimiter {
	readonly #buckets = new Map<string, number[]>();

	constructor(
		private readonly max: number = MAX_SOURCE_FAILURES,
		private readonly windowMs: number = SOURCE_WINDOW_MS,
		private readonly maxBuckets: number = MAX_SOURCE_BUCKETS,
		private readonly now: () => number = Date.now,
	) {}

	/** The failures of `key` still inside the window; an emptied bucket is dropped. */
	#live(key: string): number[] {
		const failures = this.#buckets.get(key) ?? [];
		const cutoff = this.now() - this.windowMs;
		while (failures.length > 0 && (failures[0] as number) <= cutoff) failures.shift();
		if (failures.length === 0) this.#buckets.delete(key);
		return failures;
	}

	/** Whether `address` has `max` failures inside the window. */
	blocked(address: string): boolean {
		return this.#live(sourceKey(address)).length >= this.max;
	}

	/** Seconds until `address` may be unblocked, at least 1. */
	retryAfterSeconds(address: string): number {
		const oldest = this.#live(sourceKey(address))[0];
		return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
	}

	/** Records a failed attempt from `address`. */
	fail(address: string): void {
		const key = sourceKey(address);
		const failures = this.#live(key);
		this.#buckets.delete(key);
		if (this.#buckets.size >= this.maxBuckets) {
			for (const other of [...this.#buckets.keys()]) this.#live(other);
			while (this.#buckets.size >= this.maxBuckets) this.#buckets.delete(this.#buckets.keys().next().value as string);
		}
		failures.push(this.now());
		this.#buckets.set(key, failures);
	}

	/** The number of sources tracked. */
	get size(): number {
		return this.#buckets.size;
	}
}
