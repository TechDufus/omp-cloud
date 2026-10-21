import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handOffSessions, HANDOFF_FILE, HANDOFF_MAX_AGE_MS, importSessionHandoff, writeSessionHandoff } from "./handoff";
import { DashboardSessions, SESSION_IDLE_MS, SESSION_MAX_MS } from "./session";

const T0 = Date.UTC(2026, 9, 21, 12);

let dir: string;
let path: string;
let clock: number;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-handoff-"));
	path = join(dir, HANDOFF_FILE);
	clock = T0;
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function sessions(): DashboardSessions {
	return new DashboardSessions({ now: () => clock });
}

/** A browser signs in: a link is minted and redeemed, a session opens; the cookie value is what the browser holds. */
function signIn(on: DashboardSessions): string {
	expect(on.redeemLink(on.mintLink().code)).toBe(true);
	return on.openSession();
}

describe("the session handoff of an update restart", () => {
	test("round trip: a browser signed in before the update restart still is after it, and the file is gone", async () => {
		const before = sessions();
		const first = signIn(before);
		clock += 5000;
		const second = signIn(before);
		clock += 1000;

		expect(await handOffSessions(path, before, async () => true, () => clock)).toBe(2);
		const after = sessions();
		clock += 20_000;
		expect(await importSessionHandoff(path, after, clock)).toBe(2);

		expect(after.resolveSession(first)).toBe(true);
		expect(after.resolveSession(second)).toBe(true);
		expect(after.resolveSession("never-issued")).toBe(false);
		expect(await readdir(dir)).toEqual([]);
	});

	test("the file is mode 0600, written atomically, and holds hashes and times, never a cookie value", async () => {
		const on = sessions();
		const cookie = signIn(on);
		await writeSessionHandoff(path, on, clock);

		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readdir(dir)).toEqual([HANDOFF_FILE]);
		const text = await readFile(path, "utf8");
		expect(text).not.toContain(cookie);
		const body: unknown = JSON.parse(text);
		expect(body).toMatchObject({ version: 1, writtenAt: clock, sessions: [{ hash: expect.stringMatching(/^[0-9a-f]{64}$/), createdAt: T0, lastSeen: T0 }] });
	});

	test("a handoff 2 minutes old or older is ignored and deleted: everyone signs in again", async () => {
		const before = sessions();
		const cookie = signIn(before);
		await writeSessionHandoff(path, before, clock);

		const after = sessions();
		clock += HANDOFF_MAX_AGE_MS;
		expect(await importSessionHandoff(path, after, clock)).toBe(0);
		expect(after.resolveSession(cookie)).toBe(false);
		expect(await readdir(dir)).toEqual([]);

		clock = T0;
		await writeSessionHandoff(path, before, clock);
		clock += HANDOFF_MAX_AGE_MS - 1;
		expect(await importSessionHandoff(path, sessions(), clock)).toBe(1);
	});

	test("a handoff from the future, a damaged one and one of the wrong shape are ignored and deleted", async () => {
		const on = sessions();
		signIn(on);
		for (const content of [
			JSON.stringify({ version: 1, writtenAt: clock + 60_000, sessions: on.exportSessions() }),
			"{broken",
			JSON.stringify({ version: 2, writtenAt: clock, sessions: [] }),
			JSON.stringify({ version: 1, writtenAt: clock }),
			JSON.stringify([]),
			"x".repeat(70_000),
		]) {
			await writeFile(path, content);
			const target = sessions();
			expect(await importSessionHandoff(path, target, clock)).toBe(0);
			expect(await readdir(dir)).toEqual([]);
		}
	});

	test("entries that are not SHA-256 hashes or numbers are dropped, valid ones kept", async () => {
		const on = sessions();
		const cookie = signIn(on);
		const [good] = on.exportSessions();
		await writeFile(path, JSON.stringify({ version: 1, writtenAt: clock, sessions: [{ hash: "not-a-hash", createdAt: T0, lastSeen: T0 }, { hash: "a".repeat(64), createdAt: "x", lastSeen: T0 }, 7, good] }));
		const target = sessions();
		expect(await importSessionHandoff(path, target, clock)).toBe(1);
		expect(target.resolveSession(cookie)).toBe(true);
	});

	test("the idle and absolute limits still apply to what was handed over", async () => {
		const before = sessions();
		const idle = signIn(before);
		clock += SESSION_IDLE_MS - 10_000;
		const fresh = signIn(before);
		await writeSessionHandoff(path, before, clock);

		clock += 30_000;
		const after = sessions();
		expect(await importSessionHandoff(path, after, clock)).toBe(1);
		expect(after.resolveSession(idle)).toBe(false);
		expect(after.resolveSession(fresh)).toBe(true);

		// A session at its absolute cap is not carried over even when it was just active.
		clock = T0;
		const old = sessions();
		const aged = signIn(old);
		clock = T0 + SESSION_MAX_MS - 1000;
		old.resolveSession(aged);
		await writeSessionHandoff(path, old, clock);
		clock += 5000;
		const target = sessions();
		expect(await importSessionHandoff(path, target, clock)).toBe(0);
		expect(target.resolveSession(aged)).toBe(false);
	});

	test("an ordinary restart writes nothing, so a stale file never appears and everyone signs in again", async () => {
		const on = sessions();
		const cookie = signIn(on);
		expect(await handOffSessions(path, on, async () => false)).toBe(0);
		expect(await readdir(dir)).toEqual([]);
		const after = sessions();
		expect(await importSessionHandoff(path, after, clock)).toBe(0);
		expect(after.resolveSession(cookie)).toBe(false);
	});

	test("a failing marker check or write is logged and writes nothing: the shutdown goes on", async () => {
		const log = spyOn(console, "error").mockImplementation(() => undefined);
		const on = sessions();
		signIn(on);
		expect(
			await handOffSessions(path, on, async () => {
				throw new Error("state unreadable");
			}),
		).toBe(0);
		expect(await handOffSessions(join(dir, "missing", HANDOFF_FILE), on, async () => true)).toBe(0);
		expect(log).toHaveBeenCalledTimes(2);
		log.mockRestore();
		expect(await readdir(dir)).toEqual([]);
	});

	test("the importing process takes at most as many sessions as it can hold, the most recent ones", async () => {
		const many = sessions();
		const cookies: string[] = [];
		for (let i = 0; i < 40; i++) {
			cookies.push(signIn(many));
			clock += 1000;
		}
		const handed = many.exportSessions();
		expect(handed.length).toBe(32);
		await writeSessionHandoff(path, many, clock);
		const after = sessions();
		expect(await importSessionHandoff(path, after, clock)).toBe(32);
		expect(after.resolveSession(cookies[39] ?? "")).toBe(true);
		expect(after.resolveSession(cookies[7] ?? "")).toBe(false);
		expect(after.resolveSession(cookies[8] ?? "")).toBe(true);
	});
});
