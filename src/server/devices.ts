import type { Store } from "../store";
import type { Caller } from "./auth";
import { ApiError } from "./errors";

/** What a request of a revoked device is answered, and what ends its in-flight bodies: the ordinary unauthorized error. */
export function unauthorized(): ApiError {
	return new ApiError(401, "unauthorized");
}

/**
 * One `AbortController` per device that has a request in flight. Every authenticated request of a device is wrapped with
 * its signal, so revoking the device aborts its in-flight requests and open event streams at once.
 */
export class DeviceAborts {
	readonly #controllers = new Map<string, AbortController>();

	/** The signal that `revoke(deviceId)` aborts. */
	signal(deviceId: string): AbortSignal {
		let controller = this.#controllers.get(deviceId);
		if (controller === undefined) {
			controller = new AbortController();
			this.#controllers.set(deviceId, controller);
		}
		return controller.signal;
	}

	/** Aborts everything running for the device and forgets its controller; the next request of a still-valid device would get a new one. */
	revoke(deviceId: string): void {
		this.#controllers.get(deviceId)?.abort();
		this.#controllers.delete(deviceId);
	}
}

/**
 * The one check in front of every store write a device caller can reach: throws the unauthorized error (writing
 * nothing) when `signal` was aborted or the device is no longer active in the store. The owner token has no device and
 * always passes. The check and the write that follows it are synchronous, so a revocation cannot fall between them.
 */
export function requireActive(store: Pick<Store, "device">, caller: Caller, signal: AbortSignal): void {
	if (caller.device === null) return;
	if (signal.aborted || store.device(caller.device.id) === null) throw unauthorized();
}

/**
 * `source` as a stream that stops as soon as `signal` aborts, cancelling `source` so that nothing more is read from the
 * client or the disk. `onAbort` says how it stops: `error` ends it with the unauthorized error (a request body, whose
 * reader must fail); `close` ends it early (a response body: an error there would only be logged by the server, and the
 * connection is cut either way because the declared length is not met).
 */
export function abortableStream(
	source: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	onAbort: "error" | "close" = "error",
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let aborted = false;
	let stop: () => void = () => {};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			stop = () => {
				aborted = true;
				if (onAbort === "error") controller.error(unauthorized());
				else controller.close();
				reader.cancel().catch(() => {});
			};
			if (signal.aborted) stop();
			else signal.addEventListener("abort", stop, { once: true });
		},
		async pull(controller) {
			const next = await reader.read();
			if (aborted) return;
			if (next.done) {
				signal.removeEventListener("abort", stop);
				controller.close();
			} else {
				controller.enqueue(next.value);
			}
		},
		cancel(reason) {
			signal.removeEventListener("abort", stop);
			return reader.cancel(reason);
		},
	});
}
