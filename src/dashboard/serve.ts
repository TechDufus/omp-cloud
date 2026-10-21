import page from "./client/index.html";
import type { DashboardServer } from "./server";

/** The dashboard's requests are small: a message, an answer, a settings document. */
const MAX_BODY_BYTES = 1024 ** 2;

/**
 * Starts the dashboard listener: the bundled page at `/`, everything else (`/session`, `/api/*`) through `dashboard`.
 * The only module that imports the client's HTML; tests build `createDashboardServer` and never load this file.
 */
export function serveDashboard(listen: { hostname: string; port: number }, dashboard: DashboardServer): Bun.Server<undefined> {
	return Bun.serve({
		hostname: listen.hostname,
		port: listen.port,
		routes: { "/": page },
		fetch: dashboard.fetch,
		// Production bundling: cached, minified, and no source in error pages.
		development: false,
		maxRequestBodySize: MAX_BODY_BYTES,
		idleTimeout: 120,
	});
}
