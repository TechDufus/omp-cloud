import { createHash } from "node:crypto";
import type { FetchFn } from "./api";
import { isRecord } from "./guards";

/** The cookie the forwarder sets. The cookie jar ignores ports, so the name is the service dashboard's own. */
export const SESSION_COOKIE = "omp_cloud_session";
/** A sign-in code is valid this long, once. */
export const CODE_TTL_MS = 60_000;
/** A session ends after this long without a request... */
export const SESSION_IDLE_MS = 12 * 3_600_000;
/** ...and at the latest this long after it began, however busy. */
export const SESSION_MAX_MS = 7 * 24 * 3_600_000;
/** The forwarder stops after this long without a request. */
export const IDLE_STOP_MS = 24 * 3_600_000;
/** Unredeemed codes and open sessions kept; the oldest go first. */
const MAX_CODES = 16;
const MAX_SESSIONS = 32;
/** Failed sign-ins tolerated per window before the forwarder answers 429. */
const MAX_FAILED_SIGN_INS = 5;
const SIGN_IN_WINDOW_MS = 60_000;
const MAX_SIGN_IN_BODY_BYTES = 4096;
const SECRET_BYTES = 32;
const DASHBOARD_HEADER = "x-omp-dashboard";
const API_PREFIX = "/api/v1/";
const LINKS_PATH = "/api/v1/dashboard/links";
const STATIC_PREFIX = "/api/v1/dashboard/static";

/** What the browser may send on to the service, and what may come back, for `/api/v1/*`... */
const API_REQUEST_HEADERS = ["accept", "content-type", "last-event-id"];
const API_RESPONSE_HEADERS = ["content-type", "cache-control", "content-disposition", "etag"];
/** ...and for the dashboard page and its assets. */
const STATIC_REQUEST_HEADERS = ["accept", "if-none-match", "if-modified-since"];
const STATIC_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"];

export interface ForwarderOptions {
	/** Sends one request to the service (pinned TLS, already carries `redirect: "error"`; still pass it). */
	upstream: FetchFn;
	/** The service origin the relay prefixes, e.g. `https://10.0.0.42:8443`. */
	base: string;
	/** The device token (`ompd_…`); sent only as `Authorization: Bearer` upstream. */
	token: string;
	now?: () => number;
	/** Stop after this long without a request; defaults to `IDLE_STOP_MS`. */
	idleStopMs?: number;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function secret(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString("base64url");
}

/** Drops the oldest entry (Maps iterate in insertion order). */
function evictOldest(map: Map<string, unknown>): void {
	for (const key of map.keys()) {
		map.delete(key);
		return;
	}
}

/** The session cookie's value in a `Cookie` header, or null. */
function sessionIdOf(headers: Headers): string | null {
	const header = headers.get("cookie");
	if (header === null) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq >= 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
			const value = part.slice(eq + 1).trim();
			return value === "" ? null : value;
		}
	}
	return null;
}

interface SessionRecord {
	createdAt: number;
	lastSeen: number;
}

/** The forwarder's one-time codes and sessions, in memory. Both are 32 random bytes kept only as their SHA-256. */
class Sessions {
	readonly #now: () => number;
	/** SHA-256 of a code to its expiry. */
	readonly #codes = new Map<string, number>();
	/** SHA-256 of a session id to its record. */
	readonly #sessions = new Map<string, SessionRecord>();

	constructor(now: () => number) {
		this.#now = now;
	}

	mintCode(): { code: string; expiresAt: string } {
		const now = this.#now();
		for (const [hash, expiry] of this.#codes) if (expiry <= now) this.#codes.delete(hash);
		while (this.#codes.size >= MAX_CODES) evictOldest(this.#codes);
		const code = secret();
		const expiry = now + CODE_TTL_MS;
		this.#codes.set(sha256Hex(code), expiry);
		return { code, expiresAt: new Date(expiry).toISOString() };
	}

	/** True once per valid, unexpired code; the code is spent whenever it is presented. */
	redeem(code: string): boolean {
		const hash = sha256Hex(code);
		const expiry = this.#codes.get(hash);
		this.#codes.delete(hash);
		return expiry !== undefined && expiry > this.#now();
	}

	open(): string {
		const now = this.#now();
		for (const [hash, record] of this.#sessions) if (!this.#alive(record, now)) this.#sessions.delete(hash);
		while (this.#sessions.size >= MAX_SESSIONS) evictOldest(this.#sessions);
		const id = secret();
		this.#sessions.set(sha256Hex(id), { createdAt: now, lastSeen: now });
		return id;
	}

	#alive(record: SessionRecord, now: number): boolean {
		return now - record.lastSeen < SESSION_IDLE_MS && now - record.createdAt < SESSION_MAX_MS;
	}

	/** Whether `id` is a live session; a live one is extended (sliding idle window, absolute cap). */
	resolve(id: string): boolean {
		const hash = sha256Hex(id);
		const record = this.#sessions.get(hash);
		if (record === undefined) return false;
		const now = this.#now();
		if (!this.#alive(record, now)) {
			this.#sessions.delete(hash);
			return false;
		}
		record.lastSeen = now;
		return true;
	}

	close(id: string): void {
		this.#sessions.delete(sha256Hex(id));
	}
}

/** Counts failed sign-ins in a sliding window; once `max` failures are inside it, `blocked` holds until the oldest ages out. */
class AttemptLimiter {
	readonly #failures: number[] = [];

	constructor(
		private readonly max: number,
		private readonly windowMs: number,
		private readonly now: () => number,
	) {}

	#prune(): void {
		const cutoff = this.now() - this.windowMs;
		while (this.#failures.length > 0 && (this.#failures[0] as number) <= cutoff) this.#failures.shift();
	}

	blocked(): boolean {
		this.#prune();
		return this.#failures.length >= this.max;
	}

	/** Seconds until `blocked` may clear, at least 1. */
	retryAfterSeconds(): number {
		this.#prune();
		const oldest = this.#failures[0];
		return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
	}

	fail(): void {
		this.#prune();
		this.#failures.push(this.now());
	}
}

/** Every answer of the forwarder carries `nosniff` and, unless it relays a cache policy, `no-store`. */
const ANSWER_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function failure(status: number, message: string, headers: Record<string, string> = {}): Response {
	return Response.json({ error: message }, { status, headers: { ...ANSWER_HEADERS, ...headers } });
}

/**
 * Whether a path could climb out of, or be reinterpreted by, the prefix the relay puts in front of it. Bun resolves dot
 * segments and backslashes in the request target before the handler sees it, so what is left to refuse is `..` in any
 * other form, encoded separators and empty segments; the path that is checked is the path that is routed and relayed.
 */
function badPath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.includes("..") || lower.includes("%2e") || lower.includes("%2f") || lower.includes("%5c") || lower.includes("\\") || lower.includes("//");
}

/** The sign-in code of `req`, `"token"` for a pasted token (never honored), or null when the body is anything else. */
async function readCredential(req: Request): Promise<{ code: string } | "token" | null> {
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > MAX_SIGN_IN_BODY_BYTES) return null;
	if (req.body === null) return null;
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_SIGN_IN_BODY_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
	if (!isRecord(body) || Object.keys(body).length !== 1) return null;
	if (typeof body.code === "string" && body.code !== "") return { code: body.code };
	if (typeof body.token === "string" && body.token.trim() !== "") return "token";
	return null;
}

/**
 * A loopback listener that gives a browser the service's dashboard without handing it the device token. It mirrors the
 * dashboard listener's guard and `/session` contract (sign-in takes only a local one-time code), and relays `/api/v1/*`
 * and the page's static files to the service with the device token. One per omp process; it stops after a day of silence.
 */
export class DashboardForwarder {
	/** Starts the listener on a free loopback port. */
	static start(options: ForwarderOptions): DashboardForwarder {
		return new DashboardForwarder(options);
	}

	readonly port: number;
	/** `http://127.0.0.1:<port>`. */
	readonly origin: string;
	readonly #upstream: FetchFn;
	readonly #base: string;
	readonly #authorization: string;
	readonly #idleStopMs: number;
	readonly #sessions: Sessions;
	readonly #limiter: AttemptLimiter;
	readonly #hosts: ReadonlySet<string>;
	readonly #origins: ReadonlySet<string>;
	readonly #server: Bun.Server<undefined>;
	readonly #onExit = (): void => this.stop();
	#idleTimer: NodeJS.Timeout | undefined;
	#stopped = false;

	private constructor(options: ForwarderOptions) {
		const now = options.now ?? Date.now;
		this.#upstream = options.upstream;
		this.#base = options.base.replace(/\/+$/, "");
		this.#authorization = `Bearer ${options.token}`;
		this.#idleStopMs = options.idleStopMs ?? IDLE_STOP_MS;
		this.#sessions = new Sessions(now);
		this.#limiter = new AttemptLimiter(MAX_FAILED_SIGN_INS, SIGN_IN_WINDOW_MS, now);
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			// Event streams idle between events; the forwarder's own idle timer governs.
			idleTimeout: 0,
			development: false,
			fetch: req => this.#handle(req),
			error: () => failure(500, "internal error"),
		});
		this.port = this.#server.port as number;
		this.origin = `http://127.0.0.1:${this.port}`;
		this.#hosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
		this.#origins = new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]);
		process.once("exit", this.#onExit);
		this.#touch();
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	/** A fresh one-time sign-in code, valid 60 s. The code is not part of any URL here. */
	mintCode(): { code: string; expiresAt: string } {
		return this.#sessions.mintCode();
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		clearTimeout(this.#idleTimer);
		process.removeListener("exit", this.#onExit);
		this.#server.stop(true);
	}

	#touch(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => this.stop(), this.#idleStopMs);
		this.#idleTimer.unref();
	}

	/** The refusal for a request that does not look like the page's own, or null to go on; mirrors the service's `checkRequest`. */
	#guard(req: Request): Response | null {
		const host = req.headers.get("host")?.toLowerCase() ?? "";
		if (!this.#hosts.has(host)) return failure(421, "unexpected host");
		const site = req.headers.get("sec-fetch-site");
		if (site !== null && site !== "same-origin" && site !== "none") return failure(403, "cross-site request refused");
		const origin = req.headers.get("origin");
		if (origin !== null) {
			let originHost: string;
			try {
				originHost = new URL(origin).host.toLowerCase();
			} catch {
				return failure(403, "cross-site request refused");
			}
			if (!this.#origins.has(origin.toLowerCase()) || originHost !== host) return failure(403, "cross-site request refused");
		}
		if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get(DASHBOARD_HEADER) !== "1") {
			return failure(403, `${DASHBOARD_HEADER} header required`);
		}
		return null;
	}

	async #handle(req: Request): Promise<Response> {
		this.#touch();
		const refusal = this.#guard(req);
		if (refusal !== null) return refusal;
		const { pathname: path, search } = new URL(req.url);
		if (badPath(path)) return failure(400, "bad path");
		if (path === "/session") return this.#session(req);
		if (path.startsWith(API_PREFIX)) return this.#api(req, path, search);
		if (path.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) return failure(404, "not found");
		return this.#relay(req, `${STATIC_PREFIX}${path}`, "", STATIC_REQUEST_HEADERS, STATIC_RESPONSE_HEADERS);
	}

	#live(req: Request): boolean {
		const id = sessionIdOf(req.headers);
		return id !== null && this.#sessions.resolve(id);
	}

	async #signIn(req: Request): Promise<Response> {
		if (this.#limiter.blocked()) return failure(429, "too many failed sign-ins", { "Retry-After": String(this.#limiter.retryAfterSeconds()) });
		const credential = await readCredential(req);
		if (credential === null) return failure(400, "send {code}");
		// A pasted token is never compared with anything: it only costs an attempt.
		if (credential === "token" || !this.#sessions.redeem(credential.code)) {
			this.#limiter.fail();
			return failure(401, "invalid or expired sign-in");
		}
		const previous = sessionIdOf(req.headers);
		if (previous !== null) this.#sessions.close(previous);
		const cookie = `${SESSION_COOKIE}=${this.#sessions.open()}; Max-Age=${SESSION_MAX_MS / 1000}; Path=/; HttpOnly; SameSite=Strict`;
		return new Response(null, { status: 204, headers: { ...ANSWER_HEADERS, "Set-Cookie": cookie } });
	}

	#session(req: Request): Response | Promise<Response> {
		switch (req.method) {
			case "POST":
				return this.#signIn(req);
			case "GET":
				return this.#live(req) ? Response.json({ user: "owner" }, { headers: ANSWER_HEADERS }) : failure(401, "unauthorized");
			case "DELETE": {
				const id = sessionIdOf(req.headers);
				if (id !== null) this.#sessions.close(id);
				return new Response(null, { status: 204, headers: { ...ANSWER_HEADERS, "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict` } });
			}
			default:
				return failure(404, "not found");
		}
	}

	#api(req: Request, path: string, search: string): Response | Promise<Response> {
		if (!this.#live(req)) return failure(401, "unauthorized");
		// Links are minted over the bearer connection, never through a browser session.
		if (path === LINKS_PATH || path.startsWith(`${LINKS_PATH}/`)) return failure(404, "not found");
		return this.#relay(req, path, search, API_REQUEST_HEADERS, API_RESPONSE_HEADERS);
	}

	/** Sends `req` to the service at `path` with the device token and returns the answer, keeping only the listed headers each way. */
	async #relay(req: Request, path: string, search: string, requestHeaders: readonly string[], responseHeaders: readonly string[]): Promise<Response> {
		const headers = new Headers({ Authorization: this.#authorization });
		for (const name of requestHeaders) {
			const value = req.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
		let upstream: Response;
		try {
			upstream = await this.#upstream(`${this.#base}${path}${search}`, {
				method: req.method,
				headers,
				body: hasBody ? req.body : undefined,
				duplex: "half",
				signal: req.signal,
				redirect: "error",
			});
		} catch {
			return failure(502, "cannot reach the service");
		}
		const out = new Headers({ "X-Content-Type-Options": "nosniff" });
		for (const name of responseHeaders) {
			const value = upstream.headers.get(name);
			if (value !== null) out.set(name, value);
		}
		if (!out.has("cache-control")) out.set("Cache-Control", "no-store");
		return new Response(upstream.body, { status: upstream.status, headers: out });
	}
}
