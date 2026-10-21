/** The one global event stream (`/api/v1/events`) every view shares: browsers cap connections per origin. */
import { GLOBAL_EVENTS_PATH, type GlobalDeletion, type GlobalEvent, getSession } from "./api";

/** Event kinds that change a thread's phase, turns or questions: the thread views refetch on these. */
export const LIFECYCLE_KINDS: Readonly<Record<string, true>> = {
	turn_queued: true,
	turn_started: true,
	turn_done: true,
	turn_failed: true,
	turn_cancelled: true,
	turn_requeued: true,
	stop_requested: true,
	question_asked: true,
	question_answered: true,
	question_expired: true,
	thread_failed: true,
};

const RECONNECT_MS = 3000;

export interface Live {
	/** Runs `listener` for every thread event and deletion; returns the unsubscribe function. */
	subscribe(listener: (event: GlobalEvent | GlobalDeletion) => void): () => void;
	/** Runs `listener` when the stream reconnects after a loss: events in between are gone, so refetch. */
	onReconnect(listener: () => void): () => void;
	/** Whether the stream is open right now. */
	connected(): boolean;
	/** Runs `listener` whenever the stream opens or drops; returns the unsubscribe function. */
	onConnection(listener: () => void): () => void;
	close(): void;
}

/** Opens the stream. `signedOut` runs when the stream dies because the session ended. */
export function startLive(signedOut: () => void): Live {
	const listeners = new Set<(event: GlobalEvent | GlobalDeletion) => void>();
	const reconnects = new Set<() => void>();
	const connections = new Set<() => void>();
	let isConnected = false;
	const setConnected = (next: boolean): void => {
		if (isConnected === next) return;
		isConnected = next;
		for (const listener of connections) listener();
	};
	let source: EventSource | null = null;
	let timer: number | undefined;
	let lost = false;
	let closed = false;

	const open = (): void => {
		const current = new EventSource(GLOBAL_EVENTS_PATH);
		source = current;
		current.onopen = () => {
			setConnected(true);
			if (!lost) return;
			lost = false;
			for (const listener of reconnects) listener();
		};
		current.onmessage = message => {
			const event = JSON.parse(message.data) as GlobalEvent | GlobalDeletion;
			for (const listener of listeners) listener(event);
		};
		current.onerror = () => {
			lost = true;
			setConnected(false);
			// CONNECTING: the browser retries by itself. CLOSED: it gave up, which a 401 or a restart causes.
			if (current.readyState !== EventSource.CLOSED || closed) return;
			current.close();
			timer = window.setTimeout(() => {
				void getSession().then(
					session => {
						if (closed) return;
						if (session === null) signedOut();
						else open();
					},
					() => {
						if (!closed) open();
					},
				);
			}, RECONNECT_MS);
		};
	};
	open();

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onReconnect(listener) {
			reconnects.add(listener);
			return () => reconnects.delete(listener);
		},
		connected() {
			return isConnected;
		},
		onConnection(listener) {
			connections.add(listener);
			return () => connections.delete(listener);
		},
		close() {
			closed = true;
			window.clearTimeout(timer);
			source?.close();
		},
	};
}
