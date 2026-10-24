import { type Caller, hasFullAccess } from "./auth";
import { DASHBOARD_LINKS_PATH } from "./dashboard-routes";
import { ApiError } from "./errors";
import { DEVICES_PATH, GITHUB_PATH, LOGINS_PATH, OFFERS_PATH, SECRETS_PATH, SETTINGS_PATH, SIGNING_PATH, UPDATE_PATH } from "./paths";

/** The 403 a device with threads-only access gets on a route that needs full access. */
export const FULL_ACCESS_MESSAGE =
	"this device has threads-only access; a connection with full access can change that (Devices in the dashboard, or /cloud devices access <device> full)";

/** Whether `pathname` is `base` or below it. */
function under(pathname: string, base: string): boolean {
	return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Throws ApiError 403 when `caller` has threads-only access and the request needs full access: every pairing offer route,
 * revoking a device other than itself, changing any device's access, writing or importing settings, every provider login
 * route but the list, every GitHub App and signing key route, every secret route, checking for and applying an update and
 * minting a dashboard link. The owner token and a device with full access pass everything.
 */
export function requireScope(caller: Caller, method: string, pathname: string): void {
	if (hasFullAccess(caller)) return;
	const devicePrefix = `${DEVICES_PATH}/`;
	const needsFullAccess =
		under(pathname, OFFERS_PATH) ||
		(under(pathname, LOGINS_PATH) && !(method === "GET" && pathname === LOGINS_PATH)) ||
		under(pathname, GITHUB_PATH) ||
		under(pathname, SIGNING_PATH) ||
		under(pathname, SECRETS_PATH) ||
		pathname === DASHBOARD_LINKS_PATH ||
		(method === "POST" && under(pathname, UPDATE_PATH)) ||
		(method === "PUT" && under(pathname, SETTINGS_PATH)) ||
		(method === "PATCH" && pathname.startsWith(devicePrefix)) ||
		(method === "DELETE" && pathname.startsWith(devicePrefix) && pathname.slice(devicePrefix.length) !== caller.device?.id);
	if (needsFullAccess) throw new ApiError(403, FULL_ACCESS_MESSAGE);
}
