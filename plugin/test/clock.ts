/** A clock the test moves itself: nothing sleeps for real, and a sleep ends exactly when time has been advanced past it. */

import type { Clock } from "../src/events";

interface Timer {
	at: number;
	resolve: () => void;
}

/** Lets everything that is ready to run, promise chains and stream reads included, run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

export class ManualClock implements Clock {
	#now: number;
	#timers: Timer[] = [];
	/** The length of every sleep asked for, in order. */
	readonly slept: number[] = [];

	constructor(start = 1_000_000) {
		this.#now = start;
	}

	now(): number {
		return this.#now;
	}

	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		this.slept.push(ms);
		return new Promise<void>(resolve => {
			if (signal?.aborted) return resolve();
			const timer: Timer = { at: this.#now + ms, resolve };
			this.#timers.push(timer);
			signal?.addEventListener(
				"abort",
				() => {
					this.#timers = this.#timers.filter(t => t !== timer);
					resolve();
				},
				{ once: true },
			);
		});
	}

	/** Sleeps that have not ended. */
	get sleeping(): number {
		return this.#timers.length;
	}

	/** Moves time forward by `ms`: each sleep that falls due ends in order, and what it wakes runs before the next one does. */
	async advance(ms: number): Promise<void> {
		const target = this.#now + ms;
		await settle();
		for (;;) {
			const due = this.#timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.#timers = this.#timers.filter(t => t !== due);
			this.#now = Math.max(this.#now, due.at);
			due.resolve();
			await settle();
		}
		this.#now = target;
		await settle();
	}
}
