/**
 * A turn's timeout. It runs while the agent works and stands still while the turn waits for an answer, so that a slow
 * human does not use up the agent's time.
 */
export class TurnClock {
	#remainingMs: number;
	#since = 0;
	#paused = 0;
	#timer: Timer | undefined;
	#fired = false;
	#stopped = false;

	/** Starts running at once; `onFire` is called once after `limitMs` of running time. */
	constructor(
		limitMs: number,
		private readonly onFire: () => void,
	) {
		this.#remainingMs = limitMs;
		this.#arm();
	}

	/** Stops the clock until the matching `resume`; pauses nest. */
	pause(): void {
		this.#paused++;
		if (this.#paused === 1 && !this.#fired && !this.#stopped) {
			clearTimeout(this.#timer);
			this.#remainingMs -= Date.now() - this.#since;
		}
	}

	resume(): void {
		if (this.#paused === 0) return;
		this.#paused--;
		if (this.#paused === 0 && !this.#fired && !this.#stopped) this.#arm();
	}

	/** Ends the clock without firing. */
	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
	}

	/** Epoch milliseconds at which the turn times out if it keeps running from now on; a clock that fired reports the past. */
	deadline(): number {
		const now = Date.now();
		if (this.#fired) return now - 1000;
		if (this.#paused > 0 || this.#stopped) return now + this.#remainingMs;
		return now + this.#remainingMs - (now - this.#since);
	}

	#arm(): void {
		this.#since = Date.now();
		this.#timer = setTimeout(() => this.#fire(), Math.max(this.#remainingMs, 0));
	}

	#fire(): void {
		if (this.#paused > 0 || this.#fired || this.#stopped) return;
		this.#fired = true;
		this.onFire();
	}
}
