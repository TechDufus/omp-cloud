/** A controllable event source for the watcher and hub tests: the test pushes events, ends or fails each connection. */

import type { EventStreamOptions } from "../src/api";
import type { EventSource } from "../src/events";
import type { ThreadEvent } from "../src/types";

type Message = { event: ThreadEvent } | { error: unknown } | { end: true };

export class FeedConnection {
	readonly queue: Message[] = [];
	wake: (() => void) | undefined;
	closed = false;

	constructor(
		readonly id: string,
		readonly opts: EventStreamOptions,
	) {}

	send(message: Message): void {
		this.queue.push(message);
		this.wake?.();
	}

	get aborted(): boolean {
		return this.opts.signal?.aborted === true;
	}
}

export class Feed {
	readonly connections: FeedConnection[] = [];
	/** While set, every new connection fails at once with this error, as when the service cannot be reached. */
	down: Error | undefined;

	readonly source: EventSource = (id, opts) => {
		const conn = new FeedConnection(id, opts);
		this.connections.push(conn);
		if (this.down) conn.send({ error: this.down });
		else opts.onOpen?.();
		return stream(conn);
	};

	/** Connections opened for `id`, oldest first. */
	of(id: string): FeedConnection[] {
		return this.connections.filter(c => c.id === id);
	}

	/** The newest connection for `id` that is still open. */
	open(id: string): FeedConnection | undefined {
		return this.of(id).findLast(c => !c.closed && !c.aborted);
	}

	push(id: string, ...events: ThreadEvent[]): void {
		const conn = this.open(id);
		if (!conn) throw new Error(`no open event stream for ${id}`);
		for (const event of events) conn.send({ event });
	}

	/** The server closes the stream cleanly. */
	end(id: string): void {
		this.open(id)?.send({ end: true });
	}

	/** The connection breaks. */
	fail(id: string, error: unknown): void {
		this.open(id)?.send({ error });
	}
}

async function* stream(conn: FeedConnection): AsyncGenerator<ThreadEvent> {
	const abort = (): void => conn.send({ end: true });
	if (conn.aborted) abort();
	else conn.opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			const message = conn.queue.shift();
			if (!message) {
				await new Promise<void>(resolve => {
					conn.wake = resolve;
				});
				continue;
			}
			if ("event" in message) yield message.event;
			else if ("error" in message) throw message.error;
			else return;
		}
	} finally {
		conn.closed = true;
	}
}
