import { ApiError } from "./errors";
import { DASHBOARD_STATIC_PATH } from "./paths";

/**
 * The asset paths of the dashboard page. Bun bundles the HTML into `/chunk-<hash>.js` and `/chunk-<hash>.css` (observed
 * serving `src/dashboard/client/index.html` with `development: false`; the page links nothing else).
 */
const ASSET_PATH = /^\/chunk-[a-z0-9]+\.(?:js|css)$/;
/** What may not appear in a relayed path, compared case-insensitively against the path as sent (dot segments, encoded dots, slashes and backslashes, a second slash, userinfo, fragment and query). */
const FORBIDDEN_IN_PATH = ["..", "%2e", "%2f", "%5c", "\\", "//", "@", "#", "?"];
/** The only request headers the relay forwards. */
const FORWARDED_REQUEST_HEADERS = ["accept", "if-none-match", "if-modified-since"];
/** The only response headers the relay returns. */
const RETURNED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"];

/**
 * The URL on `upstream` (the dashboard listener's fixed `http://host:port` origin) that `path` (what follows
 * `DASHBOARD_STATIC_PATH`) names: the page for `""` and `/`, or one asset. Throws ApiError 400 for anything else.
 */
export function staticTarget(path: string, upstream: string): URL {
	const invalid = (): ApiError => new ApiError(400, "invalid dashboard path");
	const lower = path.toLowerCase();
	if (FORBIDDEN_IN_PATH.some(part => lower.includes(part))) throw invalid();
	if (path !== "" && path !== "/" && !ASSET_PATH.test(path)) throw invalid();
	const target = new URL(path === "" ? "/" : path, upstream);
	if (target.origin !== new URL(upstream).origin) throw invalid();
	return target;
}

/**
 * Serves `GET|HEAD` of the dashboard page's files from the dashboard listener, for devices that cannot reach it. Cookies
 * and every header but a few are neither forwarded nor returned, and a redirect is an error, never followed.
 */
export async function relayDashboardStatic(req: Request, pathname: string, upstream: string): Promise<Response> {
	const target = staticTarget(pathname.slice(DASHBOARD_STATIC_PATH.length), upstream);
	const headers = new Headers();
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = req.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	let response: Response;
	try {
		response = await fetch(target, { method: req.method, headers, redirect: "manual", signal: req.signal });
	} catch {
		throw new ApiError(502, "the dashboard is not reachable");
	}
	// 304 Not Modified answers the conditional headers the relay forwards; every other 3xx is a redirect.
	if (response.status >= 300 && response.status < 400 && response.status !== 304) {
		await response.body?.cancel();
		throw new ApiError(502, "the dashboard answered with a redirect");
	}
	const returned = new Headers();
	for (const name of RETURNED_RESPONSE_HEADERS) {
		const value = response.headers.get(name);
		if (value !== null) returned.set(name, value);
	}
	return new Response(response.body, { status: response.status, headers: returned });
}
