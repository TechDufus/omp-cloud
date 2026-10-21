import { describe, expect, test } from "bun:test";
import {
	AttemptLimiter,
	DashboardSessions,
	LINK_TTL_MS,
	SESSION_COOKIE,
	SESSION_IDLE_MS,
	SESSION_MAX_MS,
	sessionIdOf,
} from "./session";

/** Sessions on a clock the test moves and a counter standing in for randomness. */
function setup(secure = false): { sessions: DashboardSessions; advance(ms: number): void } {
	let now = Date.UTC(2026, 0, 1);
	let counter = 0;
	const sessions = new DashboardSessions({
		now: () => now,
		randomBytes: size => new Uint8Array(size).fill(++counter),
		secure,
	});
	return { sessions, advance: ms => void (now += ms) };
}

describe("links", () => {
	test("a code is 32 random bytes in base64url and expires 60 s after minting", () => {
		const { sessions } = setup();
		const { code, expiresAt } = sessions.mintLink();
		expect(code).toBe(Buffer.alloc(32, 1).toString("base64url"));
		expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(expiresAt).toBe(new Date(Date.UTC(2026, 0, 1) + LINK_TTL_MS).toISOString());
	});

	test("a code redeems once", () => {
		const { sessions } = setup();
		const { code } = sessions.mintLink();
		expect(sessions.redeemLink(code)).toBe(true);
		expect(sessions.redeemLink(code)).toBe(false);
	});

	test("a code is valid up to its expiry and spent when redeemed too late", () => {
		const { sessions, advance } = setup();
		const early = sessions.mintLink().code;
		advance(LINK_TTL_MS - 1);
		expect(sessions.redeemLink(early)).toBe(true);

		const late = sessions.mintLink().code;
		advance(LINK_TTL_MS);
		expect(sessions.redeemLink(late)).toBe(false);
	});

	test("an unknown or empty code is refused", () => {
		const { sessions } = setup();
		sessions.mintLink();
		expect(sessions.redeemLink("nope")).toBe(false);
		expect(sessions.redeemLink("")).toBe(false);
	});

	test("minting more links than the table holds drops the oldest", () => {
		const { sessions } = setup();
		const first = sessions.mintLink().code;
		const rest = Array.from({ length: 16 }, () => sessions.mintLink().code);
		expect(sessions.redeemLink(first)).toBe(false);
		expect(sessions.redeemLink(rest[0] as string)).toBe(true);
		expect(sessions.redeemLink(rest[15] as string)).toBe(true);
	});
});

describe("sessions", () => {
	test("an opened session resolves; an unknown id and a closed one do not", () => {
		const { sessions } = setup();
		const id = sessions.openSession();
		expect(sessions.resolveSession(id)).toBe(true);
		expect(sessions.resolveSession("other")).toBe(false);
		sessions.closeSession(id);
		expect(sessions.resolveSession(id)).toBe(false);
	});

	test("the idle window slides with every use", () => {
		const { sessions, advance } = setup();
		const id = sessions.openSession();
		for (let i = 0; i < 4; i++) {
			advance(SESSION_IDLE_MS - 1);
			expect(sessions.resolveSession(id)).toBe(true);
		}
		advance(SESSION_IDLE_MS);
		expect(sessions.resolveSession(id)).toBe(false);
		// Once expired it stays gone.
		expect(sessions.resolveSession(id)).toBe(false);
	});

	test("the absolute cap ends a session that is used all the time", () => {
		const { sessions, advance } = setup();
		const id = sessions.openSession();
		const step = SESSION_IDLE_MS / 2;
		let elapsed = 0;
		while (elapsed + step < SESSION_MAX_MS) {
			advance(step);
			elapsed += step;
			expect(sessions.resolveSession(id)).toBe(true);
		}
		advance(SESSION_MAX_MS - elapsed);
		expect(sessions.resolveSession(id)).toBe(false);
	});

	test("opening more sessions than the table holds drops the oldest", () => {
		const { sessions } = setup();
		const first = sessions.openSession();
		const rest = Array.from({ length: 32 }, () => sessions.openSession());
		expect(sessions.resolveSession(first)).toBe(false);
		expect(sessions.resolveSession(rest[31] as string)).toBe(true);
	});
});

describe("cookie", () => {
	test("is HttpOnly, SameSite=Strict, Path=/ and lasts the absolute cap", () => {
		const cookie = setup().sessions.setCookie("abc");
		expect(cookie.split("; ")).toEqual([`${SESSION_COOKIE}=abc`, `Max-Age=${SESSION_MAX_MS / 1000}`, "Path=/", "HttpOnly", "SameSite=Strict"]);
	});

	test("is Secure only when the dashboard is https", () => {
		expect(setup(true).sessions.setCookie("abc")).toEndWith("; Secure");
		expect(setup(true).sessions.clearCookie()).toEndWith("; Secure");
		expect(setup(false).sessions.setCookie("abc")).not.toContain("Secure");
	});

	test("clearing sets an empty value that expires at once", () => {
		expect(setup().sessions.clearCookie()).toBe(`${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`);
	});

	test("the session id is read from the Cookie header among others", () => {
		const read = (cookie: string | null): string | null =>
			sessionIdOf(new Request("http://x/", cookie === null ? {} : { headers: { cookie } }));
		expect(read(`a=1; ${SESSION_COOKIE}=tok; b=2`)).toBe("tok");
		expect(read(`${SESSION_COOKIE}=tok`)).toBe("tok");
		expect(read(`x${SESSION_COOKIE}=tok`)).toBeNull();
		expect(read(`${SESSION_COOKIE}=`)).toBeNull();
		expect(read("a=1")).toBeNull();
		expect(read(null)).toBeNull();
	});
});

describe("AttemptLimiter", () => {
	test("blocks at the limit and clears as failures age out of the window", () => {
		let now = 0;
		const limiter = new AttemptLimiter(3, 60_000, () => now);
		for (let i = 0; i < 2; i++) {
			limiter.fail();
			now += 10_000;
		}
		expect(limiter.blocked()).toBe(false);
		limiter.fail();
		expect(limiter.blocked()).toBe(true);
		// The oldest failure was at 0; it ages out at 60 000.
		expect(limiter.retryAfterSeconds()).toBe(40);
		now = 59_999;
		expect(limiter.blocked()).toBe(true);
		now = 60_000;
		expect(limiter.blocked()).toBe(false);
	});
});
