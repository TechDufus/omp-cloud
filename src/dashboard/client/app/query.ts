/** Fetch-on-mount state for the pages: abort on key change, optional polling, optional refetch on live thread events. */
import { useCallback, useEffect, useRef, useState } from "react";
import { LIFECYCLE_KINDS } from "../live";
import { useSession } from "./session";

export interface QueryState<T> {
	data: T | undefined;
	error: unknown;
	loading: boolean;
	refetch: () => void;
}

export interface QueryOptions {
	/** `false`: no fetch (a hidden page). Default `true`. */
	enabled?: boolean;
	/** Poll this often while enabled. */
	refetchMs?: number;
	/** Refetch when the shared event stream reports a thread lifecycle event or reconnects. */
	live?: boolean;
}

/** Bursts of events (a turn finishing emits several) become one refetch. */
const LIVE_DEBOUNCE_MS = 250;

interface Settled<T> {
	key: string;
	data: T | undefined;
	error: unknown;
	loading: boolean;
}

/** `error`'s message, or a fallback for a thrown value that is not an `Error`. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `fetcher` while `enabled` and whenever `key` changes, and returns the latest result. Data from another key is never
 * shown for the current one; data from the same key stays while a refetch runs. Only one fetch per key is in flight: a poll
 * tick, live event or `refetch()` that arrives meanwhile is remembered and runs once the current fetch settles, so a slow
 * request is never abandoned and requests never pile up. Every result that settles for the current key is applied. The
 * fetcher's `signal` is aborted only when the key changes, the query is disabled or the page unmounts; results of an aborted
 * fetch are dropped.
 */
export function useQuery<T>(
	key: readonly unknown[],
	fetcher: (signal: AbortSignal) => Promise<T>,
	options: QueryOptions = {},
): QueryState<T> {
	const { enabled = true, refetchMs, live: refetchOnLive = false } = options;
	const { live } = useSession();
	const keyId = JSON.stringify(key);
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const [result, setResult] = useState<Settled<T>>({ key: keyId, data: undefined, error: undefined, loading: true });
	const requestRef = useRef<(() => void) | null>(null);
	const refetch = useCallback(() => requestRef.current?.(), []);

	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		let inFlight = false;
		let pending = false;
		const settled = (): void => {
			inFlight = false;
			if (!pending || controller.signal.aborted) return;
			pending = false;
			run();
		};
		const run = (): void => {
			inFlight = true;
			setResult(previous => ({
				key: keyId,
				data: previous.key === keyId ? previous.data : undefined,
				error: previous.key === keyId ? previous.error : undefined,
				loading: true,
			}));
			fetcherRef.current(controller.signal).then(
				data => {
					if (!controller.signal.aborted) setResult({ key: keyId, data, error: undefined, loading: false });
					settled();
				},
				(error: unknown) => {
					if (!controller.signal.aborted) {
						setResult(previous => ({ key: keyId, data: previous.key === keyId ? previous.data : undefined, error, loading: false }));
					}
					settled();
				},
			);
		};
		requestRef.current = () => {
			if (inFlight) pending = true;
			else run();
		};
		run();
		return () => {
			controller.abort();
			requestRef.current = null;
		};
	}, [keyId, enabled]);

	useEffect(() => {
		if (!enabled || refetchMs === undefined) return;
		const timer = window.setInterval(refetch, refetchMs);
		return () => window.clearInterval(timer);
	}, [enabled, refetchMs, refetch]);

	useEffect(() => {
		if (!enabled || !refetchOnLive) return;
		let timer: number | undefined;
		const schedule = (): void => {
			window.clearTimeout(timer);
			timer = window.setTimeout(refetch, LIVE_DEBOUNCE_MS);
		};
		const stopEvents = live.subscribe(event => {
			if ("deleted" in event || LIFECYCLE_KINDS[event.kind] === true) schedule();
		});
		const stopReconnects = live.onReconnect(schedule);
		return () => {
			window.clearTimeout(timer);
			stopEvents();
			stopReconnects();
		};
	}, [enabled, refetchOnLive, live, refetch]);

	const current = result.key === keyId;
	return {
		data: current ? result.data : undefined,
		error: current ? result.error : undefined,
		loading: enabled && (!current || result.loading),
		refetch,
	};
}
