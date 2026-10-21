import type { Caller } from "./auth";
import { DASHBOARD_LINKS_PATH } from "./dashboard-routes";
import { ApiError } from "./errors";
import { DEVICES_PATH, LOGINS_PATH, OFFERS_PATH, SETTINGS_PATH } from "./paths";

/** The 403 a device gets on a route only the owner token may use. */
export const OWNER_ONLY_MESSAGE = "only the owner token can do this; it works on the server machine";

/** Whether `pathname` is `base` or below it. */
function under(pathname: string, base: string): boolean {
	return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Throws ApiError 403 when `caller` is a device and the request is one only the owner token may make: every pairing
 * offer route, revoking a device other than itself, writing or importing settings, every provider login route and
 * minting a dashboard link.
 */
export function requireScope(caller: Caller, method: string, pathname: string): void {
	if (caller.device === null) return;
	const devicePrefix = `${DEVICES_PATH}/`;
	const ownerOnly =
		under(pathname, OFFERS_PATH) ||
		under(pathname, LOGINS_PATH) ||
		pathname === DASHBOARD_LINKS_PATH ||
		(method === "PUT" && under(pathname, SETTINGS_PATH)) ||
		(method === "DELETE" && pathname.startsWith(devicePrefix) && pathname.slice(devicePrefix.length) !== caller.device.id);
	if (ownerOnly) throw new ApiError(403, OWNER_ONLY_MESSAGE);
}
