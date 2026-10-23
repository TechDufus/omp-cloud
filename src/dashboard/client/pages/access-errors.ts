/** Error text for the pages that need full access (settings writes, logins, github, secrets, devices): a 403 gets an explanation, the rest keep the service's message. */
import { ApiError } from "../api";
import { messageOf } from "../app/query";

const THREADS_ONLY = "This device has threads-only access. A connection with full access can change that on the Devices page.";

/** An error as one readable line; a 403 means this device has threads-only access. */
export function describe(error: unknown): string {
	if (error instanceof ApiError && error.status === 403) return THREADS_ONLY;
	return messageOf(error);
}

/** Awaits `call`; a failure rethrows as an `Error` whose message is `describe`'s, so `ErrorState` shows it as is. */
export async function readable<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (error) {
		throw new Error(describe(error), { cause: error });
	}
}
