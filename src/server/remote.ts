import type { Identity } from "../pairing/identity";
import type { App } from "./app";
import { MAX_CREATE_BODY_BYTES } from "./limits";

/**
 * Starts the remote TLS listener: the API's remote entry point behind the service's own certificate. Shared by `main`
 * and the tests, so that what they exercise is what runs.
 */
export function serveRemote(
	listen: { hostname: string; port: number },
	identity: Pick<Identity, "cert" | "key">,
	app: Pick<App, "fetchRemote">,
): Bun.Server<undefined> {
	return Bun.serve({
		hostname: listen.hostname,
		port: listen.port,
		tls: { cert: identity.cert, key: identity.key },
		fetch: app.fetchRemote,
		maxRequestBodySize: MAX_CREATE_BODY_BYTES,
		idleTimeout: 120,
	});
}
