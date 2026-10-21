/** Error text for the owner-only pages (settings, logins, devices): a 403 gets an explanation, the rest keep the service's message. */
import { ApiError } from "../api";
import { messageOf } from "../app/query";

const OWNER_ONLY = "Only the owner can do this. Open the dashboard on the server machine, where the owner token works.";

/** An error as one readable line; a 403 means a paired device's session reached an owner-only route. */
export function describe(error: unknown): string {
	if (error instanceof ApiError && error.status === 403) return OWNER_ONLY;
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
