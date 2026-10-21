import { describe, expect, test } from "bun:test";
import type { CloudClient, ThreadsQuery } from "../src/api";
import { CloudError, cloudErrorFromStatus } from "../src/errors";
import { MAX_CANDIDATES, resolveRef, SCAN_LIMIT } from "../src/resolve";
import type { ThreadSummary } from "../src/types";
import { detail, summary } from "./builders";

/** Thread `i` (0 = newest) has the 12-character id `base36(i)` left-padded with zeros. */
const idOf = (i: number): string => i.toString(36).padStart(12, "0");

interface Fake {
	client: Pick<CloudClient, "thread" | "listThreadsPage">;
	gets: string[];
	pages: (string | undefined)[];
}

/**
 * A service holding `threads` (newest first). `paging: false` is a service without `threads.paging`: its list is its newest 50, with no cursor
 * and an ignored `limit`. `down` makes `thread()` fail with a 503.
 */
function fake(threads: Partial<ThreadSummary>[], opts: { paging?: boolean; down?: boolean } = {}): Fake {
	const all = threads.map((t, i) => summary({ id: idOf(i), ...t }));
	const gets: string[] = [];
	const pages: (string | undefined)[] = [];
	const client: Fake["client"] = {
		async thread(id) {
			gets.push(id);
			if (opts.down) throw cloudErrorFromStatus(503, "try later");
			const found = all.find(t => t.id === id);
			if (!found) throw cloudErrorFromStatus(404, "no such thread");
			return detail({ id: found.id, name: found.name });
		},
		async listThreadsPage(q: ThreadsQuery = {}) {
			pages.push(q.before);
			if (opts.paging === false) return { threads: all.slice(0, 50), next: null, total: Math.min(50, all.length) };
			const offset = q.before === undefined ? 0 : Number(q.before);
			const limit = q.limit ?? 50;
			const end = offset + limit;
			return { threads: all.slice(offset, end), next: end < all.length ? String(end) : null, total: all.length };
		},
	};
	return { client, gets, pages };
}

async function failed(call: Promise<unknown>): Promise<CloudError> {
	const err = await call.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(err instanceof CloudError)) throw new Error(`expected a CloudError, got ${String(err)}`);
	return err;
}

const many = (n: number, over: (i: number) => Partial<ThreadSummary> = () => ({})): Partial<ThreadSummary>[] => Array.from({ length: n }, (_, i) => over(i));

describe("a full 12-character id", () => {
	test("resolves through GET, for a thread far older than the newest 50, without scanning the list", async () => {
		const f = fake(many(500));
		expect(await resolveRef(f.client, idOf(430))).toBe(idOf(430));
		expect(f.gets).toEqual([idOf(430)]);
		expect(f.pages).toEqual([]);
	});

	test("is matched case-insensitively and trimmed", async () => {
		const f = fake(many(3));
		expect(await resolveRef(f.client, `  ${idOf(2).toUpperCase()}\n`)).toBe(idOf(2));
	});

	test("an id the service does not know falls back to searching the list, then is not found", async () => {
		const f = fake(many(3));
		const err = await failed(resolveRef(f.client, "zzzzzzzzzzzz"));
		expect(err).toMatchObject({ code: "not_found", message: 'no thread matches "zzzzzzzzzzzz"', retriable: false });
		expect(f.gets).toEqual(["zzzzzzzzzzzz"]);
		expect(f.pages).toHaveLength(1);
	});

	test("a failure other than not_found is the caller's to see, not a search", async () => {
		const f = fake(many(3), { down: true });
		expect(await failed(resolveRef(f.client, idOf(1)))).toMatchObject({ code: "unavailable", status: 503 });
		expect(f.pages).toEqual([]);
	});

	test("an old service that lists only its newest 50 still resolves an old thread by exact id", async () => {
		const f = fake(many(300), { paging: false });
		expect(await resolveRef(f.client, idOf(250))).toBe(idOf(250));
	});
});

describe("searching the list", () => {
	test("a suffix of 4 or more characters finds a thread beyond the first page", async () => {
		const f = fake(many(450));
		const wanted = idOf(333);
		expect(await resolveRef(f.client, wanted.slice(-4))).toBe(wanted);
		expect(f.gets).toEqual([]);
		expect(f.pages).toEqual([undefined, "200", "400"]);
	});

	test("a suffix shorter than 4 characters is not a suffix", async () => {
		const f = fake(many(40));
		expect(await failed(resolveRef(f.client, idOf(30).slice(-3)))).toMatchObject({ code: "not_found" });
	});

	test("a word of the name finds a thread on a later page", async () => {
		const f = fake(many(300, i => (i === 260 ? { name: "Flaky retry test" } : { name: "" })));
		expect(await resolveRef(f.client, "flaky")).toBe(idOf(260));
		expect(await resolveRef(f.client, "RETRY")).toBe(idOf(260));
	});

	test("a job id names the thread whose running job it is, wherever the thread is in the list", async () => {
		const f = fake(many(300));
		const jobOf = (id: string): string | undefined => (id === idOf(280) ? "panezoomshortcut-3" : undefined);
		expect(await resolveRef(f.client, "panezoomshortcut-3", { jobOf })).toBe(idOf(280));
	});

	test("a job id made of a thread's name resolves it too", async () => {
		const f = fake(many(230, i => (i === 220 ? { name: "Pane zoom shortcut" } : {})));
		expect(await resolveRef(f.client, "PaneZoomShortcut")).toBe(idOf(220));
	});

	test("an old service's list is one page and is searched whole", async () => {
		const f = fake(many(30, i => (i === 12 ? { name: "Release notes" } : {})), { paging: false });
		expect(await resolveRef(f.client, "release")).toBe(idOf(12));
		expect(f.pages).toHaveLength(1);
	});

	test("an empty reference is invalid, not a search", async () => {
		const f = fake(many(3));
		expect(await failed(resolveRef(f.client, "   "))).toMatchObject({ code: "invalid" });
		expect(f.pages).toEqual([]);
	});

	test("the scan stops at 1000 threads and says what it could not see", async () => {
		const f = fake(many(1200, i => (i === 1100 ? { name: "Ancient" } : {})));
		expect(f.pages).toEqual([]);
		const err = await failed(resolveRef(f.client, "ancient"));
		expect(f.pages).toHaveLength(SCAN_LIMIT / 200);
		expect(err.code).toBe("not_found");
		expect(err.message).toBe('no thread matches "ancient" among the newest 1000 of 1200 threads');
		expect(err.hint).toContain("full 12-character id");
		// The same thread is reachable by its id.
		expect(await resolveRef(f.client, idOf(1100))).toBe(idOf(1100));
	});
});

describe("ambiguity", () => {
	test("is reported with at most 10 candidates and a count of the rest", async () => {
		const f = fake(many(40, () => ({ name: "Docs sweep" })));
		const err = await failed(resolveRef(f.client, "docs"));
		expect(err.code).toBe("ambiguous_ref");
		expect(err.candidates).toHaveLength(MAX_CANDIDATES);
		expect(err.candidates?.[0]).toEqual({ id: idOf(0), name: "Docs sweep" });
		expect(err.message).toContain('"docs" matches 40 threads');
		expect(err.message.endsWith("and 30 more")).toBe(true);
		expect(err.message.split(", ")).toHaveLength(MAX_CANDIDATES);
		expect(err.retriable).toBe(false);
		expect(err.hint).toContain("12-character");
	});

	test("a few matches are all listed, with no 'more'", async () => {
		const f = fake(many(10, i => (i < 3 ? { name: "Docs sweep" } : { name: "" })));
		const err = await failed(resolveRef(f.client, "docs"));
		expect(err.candidates).toHaveLength(3);
		expect(err.message).not.toContain("more");
	});

	test("a second match on a later page still makes the reference ambiguous", async () => {
		const f = fake(many(300, i => (i === 5 || i === 250 ? { name: "Flaky retry test" } : {})));
		const err = await failed(resolveRef(f.client, "flaky"));
		expect(err.code).toBe("ambiguous_ref");
		expect(err.candidates?.map(c => c.id)).toEqual([idOf(5), idOf(250)]);
	});
});
