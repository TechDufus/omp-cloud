import { createHash } from "node:crypto";

/** The dashboard's session cookie. The cookie jar ignores ports, so the name is distinct from anything else on loopback. */
export const SESSION_COOKIE = "omp_cloud_session";
/** A sign-in link is valid this long, once. */
export const LINK_TTL_MS = 60_000;
/** A session ends after this long without a request... */
export const SESSION_IDLE_MS = 12 * 3_600_000;
/** ...and at the latest this long after it began, however busy. */
export const SESSION_MAX_MS = 7 * 24 * 3_600_000;
/** Unredeemed links and open sessions kept; the oldest go first. */
const MAX_LINKS = 16;
const MAX_SESSIONS = 32;
const SECRET_BYTES = 32;

export interface DashboardSessionsOptions {
	/** Clock in epoch milliseconds; defaults to `Date.now`. */
	now?: () => number;
	/** Random source; defaults to `crypto.getRandomValues`. */
	randomBytes?: (size: number) => Uint8Array;
	/** Mark the cookie `Secure`: set when the dashboard is served over https. */
	secure?: boolean;
}

interface SessionRecord {
	createdAt: number;
	lastSeen: number;
}

/** A session as it crosses an update restart: the SHA-256 of its id and its times. */
export interface HandedSession {
	hash: string;
	createdAt: number;
	lastSeen: number;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The dashboard's one-time sign-in links and its sessions, in memory: a restart signs every browser out. Links and
 * session ids are 32 random bytes, kept only as their SHA-256, so what is held cannot be replayed.
 */
export class DashboardSessions {
	readonly #now: () => number;
	readonly #randomBytes: (size: number) => Uint8Array;
	readonly #secure: boolean;
	/** SHA-256 of a link code to its expiry. */
	readonly #links = new Map<string, number>();
	/** SHA-256 of a session id to its record. */
	readonly #sessions = new Map<string, SessionRecord>();

	constructor(options: DashboardSessionsOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#randomBytes = options.randomBytes ?? (size => crypto.getRandomValues(new Uint8Array(size)));
		this.#secure = options.secure ?? false;
	}

	#secret(): string {
		return Buffer.from(this.#randomBytes(SECRET_BYTES)).toString("base64url");
	}

	/** A fresh link code, valid for `LINK_TTL_MS` and one `redeemLink`. */
	mintLink(): { code: string; expiresAt: string } {
		const now = this.#now();
		for (const [hash, expiry] of this.#links) if (expiry <= now) this.#links.delete(hash);
		while (this.#links.size >= MAX_LINKS) this.#links.delete(this.#links.keys().next().value as string);
		const code = this.#secret();
		const expiry = now + LINK_TTL_MS;
		this.#links.set(sha256Hex(code), expiry);
		return { code, expiresAt: new Date(expiry).toISOString() };
	}

	/** True once per valid, unexpired code; the code is spent either way. */
	redeemLink(code: string): boolean {
		const hash = sha256Hex(code);
		const expiry = this.#links.get(hash);
		this.#links.delete(hash);
		return expiry !== undefined && expiry > this.#now();
	}

	/** Opens a session; the returned id is the cookie value. */
	openSession(): string {
		const now = this.#now();
		for (const [hash, record] of this.#sessions) if (!this.#alive(record, now)) this.#sessions.delete(hash);
		while (this.#sessions.size >= MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value as string);
		const id = this.#secret();
		this.#sessions.set(sha256Hex(id), { createdAt: now, lastSeen: now });
		return id;
	}

	#alive(record: SessionRecord, now: number): boolean {
		return now - record.lastSeen < SESSION_IDLE_MS && now - record.createdAt < SESSION_MAX_MS;
	}

	/** Whether `id` is a live session; a live one is extended (sliding idle window, absolute cap). */
	resolveSession(id: string): boolean {
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

	closeSession(id: string): void {
		this.#sessions.delete(sha256Hex(id));
	}

	/** The live sessions as `{hash, createdAt, lastSeen}`: only SHA-256s, never a cookie value. For the handoff to the next process of an update restart. */
	exportSessions(): HandedSession[] {
		const now = this.#now();
		return [...this.#sessions].filter(([, record]) => this.#alive(record, now)).map(([hash, record]) => ({ hash, createdAt: record.createdAt, lastSeen: record.lastSeen }));
	}

	/** Takes over sessions another process exported: the ones still alive (the idle and absolute limits apply as if they had never been away), newest kept when more than the cap. Returns how many. */
	importSessions(sessions: readonly HandedSession[]): number {
		const now = this.#now();
		const live = sessions.filter((session) => this.#alive(session, now) && session.createdAt <= now && session.lastSeen <= now);
		let taken = 0;
		for (const session of live.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_SESSIONS).reverse()) {
			while (this.#sessions.size >= MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value as string);
			this.#sessions.set(session.hash, { createdAt: session.createdAt, lastSeen: session.lastSeen });
			taken++;
		}
		return taken;
	}

	/** The `Set-Cookie` value that stores session `id`. The browser keeps it for the absolute cap; the server enforces the idle window. */
	setCookie(id: string): string {
		return `${SESSION_COOKIE}=${id}; Max-Age=${SESSION_MAX_MS / 1000}; Path=/; HttpOnly; SameSite=Strict${this.#secure ? "; Secure" : ""}`;
	}

	/** The `Set-Cookie` value that removes the cookie. */
	clearCookie(): string {
		return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${this.#secure ? "; Secure" : ""}`;
	}
}

/** The session cookie's value in the request's `Cookie` header, or null. */
export function sessionIdOf(req: Request): string | null {
	const header = req.headers.get("cookie");
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

/** Counts failed sign-ins in a sliding window; once `max` failures are inside it, `blocked` holds until the oldest ages out. */
export class AttemptLimiter {
	readonly #failures: number[] = [];

	constructor(
		private readonly max: number,
		private readonly windowMs: number,
		private readonly now: () => number = Date.now,
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
