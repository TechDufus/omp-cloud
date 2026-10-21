/** A stand-in for the cloud service's thread endpoint, for watcher tests that move a clock. */

import { cloudErrorFromStatus } from "../src/errors";
import type { ThreadDetail } from "../src/types";

/** What the service answers: a thread's detail, a 404 for a thread it does not have, or a failure for every request while `down`. */
export class Service {
	readonly details = new Map<string, ThreadDetail>();
	/** Thread fetches made, per thread. */
	readonly fetched: string[] = [];
	down: Error | undefined;

	constructor(...threads: ThreadDetail[]) {
		for (const t of threads) this.details.set(t.id, t);
	}

	thread = async (id: string): Promise<ThreadDetail> => {
		this.fetched.push(id);
		if (this.down) throw this.down;
		const d = this.details.get(id);
		if (!d) throw cloudErrorFromStatus(404, "no such thread");
		return d;
	};
}
