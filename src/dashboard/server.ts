import type { Server } from "bun";
import type { DashboardConfig } from "../config";
import { isRecord } from "../guards";
import type { App } from "../server/app";
import { tokenMatches } from "../server/auth";
import { DASHBOARD_LINKS_PATH } from "../server/dashboard-routes";
import { checkRequest, type GuardPolicy, guardPolicy, sessionCaller } from "./guard";
import { AttemptLimiter, type DashboardSessions, sessionIdOf } from "./session";

/** A sign-in body: one short JSON object. */
const MAX_SIGN_IN_BODY_BYTES = 4096;
/** Failed sign-ins tolerated per window before the listener answers 429. */
const MAX_FAILED_SIGN_INS = 5;
const SIGN_IN_WINDOW_MS = 60_000;

export interface DashboardServerOptions {
	/** The API the `/api/*` routes call with the owner's caller; a session is always the owner's. */
	app: Pick<App, "fetchAs">;
	/** Config.apiTokenSha256: what a pasted token must hash to. */
	apiTokenSha256: string;
	sessions: DashboardSessions;
	/** The configured listen port; a running server's own port wins (a test binds port 0). */
	port: number;
	/** Config.dashboard.url, when set. */
	url?: string;
	/** Clock for the sign-in rate limit; defaults to `Date.now`. */
	now?: () => number;
}

/** The dashboard listener's request handler: `Bun.serve({ fetch: dashboard.fetch })`. The HTML page is served by `serve.ts`. */
export interface DashboardServer {
	fetch(req: Request, server?: Server<undefined>): Promise<Response>;
}

/** The listener's fixed origin, `http://<listen host>:<port>` (an IPv6 host in brackets): what the API's static relay fetches the page from, whatever `url` says. */
export function dashboardUpstream(dashboard: DashboardConfig): string {
	const { hostname, port } = dashboard.listen;
	return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

/** What links point at and the page's own address: the configured `url`, else `http://<listen>` (an IPv6 host in brackets). */
export function dashboardOrigin(dashboard: DashboardConfig): string {
	return dashboard.url ?? dashboardUpstream(dashboard);
}

function failure(status: number, message: string, headers: Record<string, string> = {}): Response {
	return Response.json({ error: message }, { status, headers });
}

/** The sign-in credential of `req`: a `code` or a `token`, exactly one non-empty string. Null when the body is anything else. */
async function readCredential(req: Request): Promise<{ code: string } | { token: string } | null> {
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > MAX_SIGN_IN_BODY_BYTES) return null;
	let body: unknown;
	try {
		body = JSON.parse(await req.text());
	} catch {
		return null;
	}
	if (!isRecord(body) || Object.keys(body).length !== 1) return null;
	if (typeof body.code === "string" && body.code !== "") return { code: body.code };
	if (typeof body.token === "string" && body.token.trim() !== "") return { token: body.token.trim() };
	return null;
}

/**
 * The listener that carries the dashboard's session cookie. `POST /session` trades a one-time link code (or the API
 * token) for the cookie; `/api/*` runs the guard, resolves the cookie to the owner and calls `app.fetchAs`. Nothing
 * here sets a CORS header, and the bearer listener never sees a cookie.
 */
export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
	const { app, apiTokenSha256, sessions } = options;
	const limiter = new AttemptLimiter(MAX_FAILED_SIGN_INS, SIGN_IN_WINDOW_MS, options.now);
	let policy: { port: number; value: GuardPolicy } | undefined;

	async function signIn(req: Request): Promise<Response> {
		if (limiter.blocked()) return failure(429, "too many failed sign-ins", { "Retry-After": String(limiter.retryAfterSeconds()) });
		const credential = await readCredential(req);
		if (credential === null) return failure(400, "send {code} or {token}");
		const ok = "code" in credential ? sessions.redeemLink(credential.code) : tokenMatches(credential.token, apiTokenSha256);
		if (!ok) {
			limiter.fail();
			return failure(401, "invalid or expired sign-in");
		}
		const previous = sessionIdOf(req);
		if (previous !== null) sessions.closeSession(previous);
		return new Response(null, { status: 204, headers: { "Set-Cookie": sessions.setCookie(sessions.openSession()) } });
	}

	function session(req: Request): Response {
		switch (req.method) {
			case "GET": {
				const caller = sessionCaller(req, sessions);
				return caller === null ? failure(401, "unauthorized") : Response.json({ user: caller.principal });
			}
			case "DELETE": {
				const id = sessionIdOf(req);
				if (id !== null) sessions.closeSession(id);
				return new Response(null, { status: 204, headers: { "Set-Cookie": sessions.clearCookie() } });
			}
			default:
				return failure(404, "not found");
		}
	}

	async function handle(req: Request, server: Server<undefined> | undefined): Promise<Response> {
		const port = server?.port ?? options.port;
		if (policy?.port !== port) policy = { port, value: guardPolicy(port, options.url) };
		const pathname = new URL(req.url).pathname;
		const isSession = pathname === "/session";
		if (!isSession && !pathname.startsWith("/api/")) return failure(404, "not found");
		const refusal = checkRequest(req, policy.value);
		if (refusal !== null) return refusal;
		if (isSession) return req.method === "POST" ? signIn(req) : session(req);
		// Links are minted only through the bearer listener.
		if (pathname === DASHBOARD_LINKS_PATH) return failure(404, "not found");
		const caller = sessionCaller(req, sessions);
		if (caller === null) return failure(401, "unauthorized");
		return app.fetchAs(caller, req, server);
	}

	return {
		async fetch(req, server) {
			const response = await handle(req, server);
			response.headers.set("Cache-Control", "no-store");
			response.headers.set("X-Content-Type-Options", "nosniff");
			return response;
		},
	};
}
