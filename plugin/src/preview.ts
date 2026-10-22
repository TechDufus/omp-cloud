import type { FetchFn } from "./api";
import { SESSION_COOKIE } from "./forwarder";

/**
 * `/cloud preview <id> <port>`: a loopback listener that relays every request to the service's
 * `/api/v1/threads/<id>/ports/<port>/…` route with the bearer token, so a browser on this machine reaches a dev server
 * running in the thread's VM. The token never reaches the browser.
 *
 * The page is served on `http://localhost:<port>/` and on no other host name. Cookies are scoped by host, not port,
 * and the dashboard forwarder's session cookie lives on `127.0.0.1`: serving the previewed app only on `localhost`
 * keeps its cookies (and its scripts) away from that cookie. The dashboard's own cookie is also filtered both ways.
 */

/** Hop-by-hop request headers, and the ones this relay replaces (`host`, `authorization`) or that must be recomputed (`content-length`, `accept-encoding`, `cookie`). */
const DROPPED_REQUEST_HEADERS = new Set([
	"host",
	"authorization",
	"connection",
	"keep-alive",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"content-length",
	"accept-encoding",
	"cookie",
]);

/** Hop-by-hop response headers, and the two a decoded body invalidates: `fetch` decompresses, so the length and encoding it reported no longer describe the bytes. `set-cookie` is rebuilt. */
const DROPPED_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"content-encoding",
	"content-length",
	"set-cookie",
]);

export interface PreviewOptions {
	/** Sends one request to the service (pinned TLS when paired). */
	upstream: FetchFn;
	/** The service origin, e.g. `https://10.0.0.42:8443`. */
	base: string;
	/** The owner or device token; sent only as `Authorization: Bearer` upstream. */
	token: string;
	/** The thread's full id. */
	thread: string;
	/** The port in the VM. */
	port: number;
}

function failure(status: number, message: string): Response {
	return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/** A path that could climb out of the route prefix the relay puts in front of it (`..`, encoded dots, backslashes plain or encoded). */
function badPath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.includes("..") || lower.includes("%2e") || lower.includes("\\") || lower.includes("%5c");
}

/** `cookie` without any `omp_cloud_session` pair; null when nothing is left. */
function withoutSessionCookie(cookie: string): string | null {
	const kept = cookie.split(";").filter(pair => pair.trim().split("=")[0]?.trim() !== SESSION_COOKIE);
	return kept.length === 0 ? null : kept.join(";").trim();
}

export class PreviewForwarder {
	/** Starts the listener on a free loopback port. */
	static start(options: PreviewOptions): PreviewForwarder {
		return new PreviewForwarder(options);
	}

	readonly port: number;
	readonly thread: string;
	/** The port in the VM. */
	readonly target: number;
	/** `http://localhost:<port>/`, the only address the listener answers on. */
	readonly url: string;
	readonly #upstream: FetchFn;
	readonly #prefix: string;
	readonly #authorization: string;
	readonly #host: string;
	readonly #server: Bun.Server<undefined>;
	#stopped = false;

	private constructor(options: PreviewOptions) {
		this.#upstream = options.upstream;
		this.thread = options.thread;
		this.target = options.port;
		this.#prefix = `${options.base.replace(/\/+$/, "")}/api/v1/threads/${encodeURIComponent(options.thread)}/ports/${options.port}`;
		this.#authorization = `Bearer ${options.token}`;
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			// A dev server streams (event streams, long polls): nothing here ends a quiet connection.
			idleTimeout: 0,
			development: false,
			fetch: req => this.#handle(req),
			error: () => failure(500, "internal error"),
		});
		this.port = this.#server.port as number;
		this.#host = `localhost:${this.port}`;
		this.url = `http://${this.#host}/`;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#server.stop(true);
	}

	async #handle(req: Request): Promise<Response> {
		if ((req.headers.get("host") ?? "").toLowerCase() !== this.#host) return failure(400, `open ${this.url}`);
		if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") return failure(501, "WebSocket upgrades are not forwarded");
		const { pathname, search } = new URL(req.url);
		if (badPath(pathname)) return failure(400, "bad path");

		const headers = new Headers();
		for (const [name, value] of req.headers) if (!DROPPED_REQUEST_HEADERS.has(name)) headers.set(name, value);
		const cookie = req.headers.get("cookie");
		const kept = cookie === null ? null : withoutSessionCookie(cookie);
		if (kept !== null) headers.set("cookie", kept);
		headers.set("authorization", this.#authorization);

		const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
		let upstream: Response;
		try {
			upstream = await this.#upstream(`${this.#prefix}${pathname}${search}`, {
				method: req.method,
				headers,
				body: hasBody ? req.body : undefined,
				duplex: "half",
				signal: req.signal,
				// The app's own redirects go to the browser, which follows them on this host.
				redirect: "manual",
			});
		} catch {
			return failure(502, "cannot reach the service");
		}
		const out = new Headers();
		for (const [name, value] of upstream.headers) if (!DROPPED_RESPONSE_HEADERS.has(name)) out.append(name, value);
		for (const line of upstream.headers.getSetCookie()) if (line.split("=")[0]?.trim() !== SESSION_COOKIE) out.append("set-cookie", line);
		return new Response(upstream.body, { status: upstream.status, headers: out });
	}
}
