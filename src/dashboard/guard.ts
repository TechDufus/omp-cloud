import { type Caller, OWNER_CALLER } from "../server/auth";
import { type DashboardSessions, sessionIdOf } from "./session";

/** The header every mutating request must carry: a cross-origin page cannot add it without a CORS preflight, which this listener never grants. */
export const DASHBOARD_HEADER = "x-omp-dashboard";

/** The `Host` values and origins the dashboard listener answers to. */
export interface GuardPolicy {
	/** Lowercase `host[:port]` values a request's `Host` header may carry. */
	hosts: ReadonlySet<string>;
	/** Lowercase origins (`scheme://host[:port]`) an `Origin` header may carry. */
	origins: ReadonlySet<string>;
}

/**
 * The policy of a dashboard listening on loopback `port`: every spelling of loopback with that port (a rebound DNS name
 * is not among them) plus the host of the configured `url`, when there is one.
 */
export function guardPolicy(port: number, url?: string): GuardPolicy {
	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
	const origins = new Set([...hosts].map(host => `http://${host}`));
	if (url !== undefined) {
		const parsed = new URL(url);
		hosts.add(parsed.host.toLowerCase());
		origins.add(parsed.origin.toLowerCase());
	}
	return { hosts, origins };
}

function refuse(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}

/**
 * The refusal for a request that does not look like the dashboard's own page talking, or null to go on. In order:
 * the `Host` must be one of ours (DNS rebinding), `Sec-Fetch-Site` must be `same-origin` or `none` (a page on another
 * loopback port is same-site, so SameSite cookies alone do not stop it), a present `Origin` must be ours and match the
 * `Host`, and anything but GET and HEAD needs `X-Omp-Dashboard: 1`.
 */
export function checkRequest(req: Request, policy: GuardPolicy): Response | null {
	const host = req.headers.get("host")?.toLowerCase() ?? "";
	if (!policy.hosts.has(host)) return refuse(421, "unexpected host");
	const site = req.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return refuse(403, "cross-site request refused");
	const origin = req.headers.get("origin");
	if (origin !== null) {
		let originHost: string;
		try {
			originHost = new URL(origin).host.toLowerCase();
		} catch {
			return refuse(403, "cross-site request refused");
		}
		if (!policy.origins.has(origin.toLowerCase()) || originHost !== host) return refuse(403, "cross-site request refused");
	}
	if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get(DASHBOARD_HEADER) !== "1") {
		return refuse(403, `${DASHBOARD_HEADER} header required`);
	}
	return null;
}

/** The owner's caller when the request carries a live session cookie (which extends the session), else null. */
export function sessionCaller(req: Request, sessions: DashboardSessions): Caller | null {
	const id = sessionIdOf(req);
	return id !== null && sessions.resolveSession(id) ? OWNER_CALLER : null;
}
