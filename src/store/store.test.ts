import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, titleFromReply, type ThreadListener } from "./index";
import { MIGRATIONS } from "./schema";
import {
	type IrcPayload,
	MAX_ERROR_CHARS,
	MAX_EVENT_TEXT_CHARS,
	MAX_IRC_EVENT_CHARS,
	MAX_QUESTION_TEXT_BYTES,
	MAX_QUESTIONS_PER_TURN,
	MAX_TEXT_BYTES,
	MAX_TURNS,
	type NewThread,
	type QuestionInput,
	type SettingChange,
	StoreError,
	type StoreErrorCode,
	THREAD_ID_PATTERN,
	type ThreadCursor,
	type ThreadEvent,
	type TurnResult,
	type VmRecord,
} from "./types";

const ID = "aaaaaaaaaaaa";
const T0 = Date.UTC(2026, 0, 1);

let dir: string;
let store: Store;
let clock: number;

function open(): Store {
	return Store.open({ dataDir: dir, now: () => new Date(clock) });
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	clock = T0;
	store = open();
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function newThread(overrides: Partial<NewThread> = {}): NewThread {
	return {
		owner: "owner",
		title: "fix the bug",
		prompt: "please fix the bug",
		model: "",
		thinking: "",
		repo: { name: "repo", remoteURL: "https://example.com/r.git", baseRef: "main", baseCommit: "abc", handoffCommit: "def", localBranch: "feat" },
		paths: { home: "/home/me", workspace: "/home/me/repo" },
		author: { name: "Me", email: "me@example.com" },
		secretFiles: [".env"],
		secretEnv: ["TOKEN"],
		configOverlays: ["overlays/claude.yml"],
		ompVersion: "18.12.3",
		policy: {},
		...overrides,
	};
}

function result(overrides: Partial<TurnResult> = {}): TurnResult {
	return {
		outcome: "completed",
		error: "",
		reply: "# All done\nbody",
		usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 0.5 },
		head: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		pushed: false,
		pushError: "",
		pushRef: "",
		...overrides,
	};
}

function question(overrides: Partial<QuestionInput> = {}): QuestionInput {
	const options = overrides.options ?? [
		{ label: "a", description: "" },
		{ label: "b", description: "" },
	];
	return {
		key: "k",
		text: "Which one?",
		header: "",
		options,
		multi: false,
		recommended: null,
		ompKey: overrides.key ?? "k",
		ompLabels: options.map((o) => o.label),
		...overrides,
	};
}

/** A thread whose first turn is running. */
function running(id = ID): void {
	store.createThread(id, newThread());
	store.startNextTurn(id);
}

function tick(ms = 1000): void {
	clock += ms;
}

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function codeOf(fn: () => unknown): StoreErrorCode | "other" {
	try {
		fn();
	} catch (err) {
		return err instanceof StoreError ? err.code : "other";
	}
	throw new Error("expected a StoreError, nothing thrown");
}

function kinds(id = ID): string[] {
	return store.events(id, 0, 1000).map((e) => e.kind);
}

function bytes(n: number): Uint8Array {
	return new Uint8Array(n).fill(7);
}

interface Recorder {
	seen: ThreadEvent[];
	deleted: number;
	listener: ThreadListener;
}

/** A listener that remembers what it heard. */
function record(): Recorder {
	const recorder: Recorder = {
		seen: [],
		deleted: 0,
		listener: {
			event: (event) => {
				recorder.seen.push(event);
			},
			deleted: () => {
				recorder.deleted++;
			},
		},
	};
	return recorder;
}

describe("createThread and reads", () => {
	test("creates the thread in phase starting with turn 1 queued by the owner", () => {
		const { thread, turn } = store.createThread(ID, newThread({ prompt: "hello" }));
		expect(thread).toMatchObject({ id: ID, owner: "owner", phase: "starting", error: "", createdAt: iso(0), lastActivityAt: iso(0) });
		expect(thread.secretFiles).toEqual([".env"]);
		expect(thread.repo.baseRef).toBe("main");
		expect(turn).toMatchObject({ id: 1, state: "queued", text: "hello", by: "owner", queuedAt: iso(0), startedAt: null, questions: [] });
		expect(store.events(ID, 0, 10)).toEqual([{ seq: 1, at: iso(0), kind: "turn_queued", turn: 1, text: "queued by owner" }]);
		expect(store.getThread(ID)).toEqual(thread);
	});

	test("rejects empty and oversized prompts without leaving a thread behind", () => {
		expect(codeOf(() => store.createThread(ID, newThread({ prompt: "" })))).toBe("invalid_text");
		// The limit counts UTF-8 bytes: 16385 two-byte characters are over it.
		expect(codeOf(() => store.createThread(ID, newThread({ prompt: "é".repeat(MAX_TEXT_BYTES / 2 + 1) })))).toBe("invalid_text");
		expect(store.getThread(ID)).toBeNull();
		store.createThread(ID, newThread({ prompt: "é".repeat(MAX_TEXT_BYTES / 2) }));
		expect(store.getThread(ID)).not.toBeNull();
	});

	test("unknown thread reads", () => {
		expect(store.getThread("bbbbbbbbbbbb")).toBeNull();
		expect(codeOf(() => store.turns("bbbbbbbbbbbb"))).toBe("thread_not_found");
		expect(codeOf(() => store.threadStats("bbbbbbbbbbbb"))).toBe("thread_not_found");
		expect(store.events("bbbbbbbbbbbb", 0, 10)).toEqual([]);
	});

	test("listThreads orders newest first (ties by id descending), filters by owner and applies the limit", () => {
		store.createThread("aaaaaaaaaaa1", newThread());
		store.createThread("aaaaaaaaaaa3", newThread());
		store.createThread("aaaaaaaaaaa2", newThread());
		tick();
		store.createThread("aaaaaaaaaaa0", newThread());
		store.createThread("bbbbbbbbbbbb", newThread({ owner: "other" }));
		expect(store.listThreads("owner", 10).map((t) => t.id)).toEqual(["aaaaaaaaaaa0", "aaaaaaaaaaa3", "aaaaaaaaaaa2", "aaaaaaaaaaa1"]);
		expect(store.listThreads("owner", 2).map((t) => t.id)).toEqual(["aaaaaaaaaaa0", "aaaaaaaaaaa3"]);
		expect(store.listThreads("other", 10).map((t) => t.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(store.listThreads("nobody", 10)).toEqual([]);
	});

	test("a thread keeps its origin, ref, session and scratch flag; unknown metadata reads as empty", () => {
		store.createThread("aaaaaaaaaaa1", newThread({ origin: "tool", ref: "fix-login", session: "01HXSESSION", scratch: true }));
		store.createThread("aaaaaaaaaaa2", newThread());
		expect(store.getThread("aaaaaaaaaaa1")).toMatchObject({ origin: "tool", ref: "fix-login", session: "01HXSESSION", scratch: true });
		expect(store.getThread("aaaaaaaaaaa2")).toMatchObject({ origin: "", ref: "", session: "", scratch: false });
	});

	describe("listThreadsPage", () => {
		const ids = (page: { threads: { id: string }[] }): string[] => page.threads.map((t) => t.id);

		test("pages newest lastActivityAt first with ties by id descending; every page carries the same total", () => {
			store.createThread("aaaaaaaaaaa1", newThread());
			store.createThread("aaaaaaaaaaa2", newThread());
			tick();
			store.createThread("aaaaaaaaaaa3", newThread());
			tick();
			store.createThread("aaaaaaaaaaa4", newThread());
			store.createThread("aaaaaaaaaaa5", newThread());
			const seen: string[] = [];
			let after: ThreadCursor | null = null;
			for (let pages = 0; pages < 3; pages++) {
				const page = store.listThreadsPage("owner", {}, 2, after);
				expect(page.total).toBe(5);
				seen.push(...ids(page));
				if (pages < 2) expect(page.next).not.toBeNull();
				after = page.next;
			}
			expect(after).toBeNull();
			expect(seen).toEqual(["aaaaaaaaaaa5", "aaaaaaaaaaa4", "aaaaaaaaaaa3", "aaaaaaaaaaa2", "aaaaaaaaaaa1"]);
		});

		test("the last page has no next, a full page that ends the list has none either", () => {
			store.createThread("aaaaaaaaaaa1", newThread());
			tick();
			store.createThread("aaaaaaaaaaa2", newThread());
			const page = store.listThreadsPage("owner", {}, 2, null);
			expect(ids(page)).toEqual(["aaaaaaaaaaa2", "aaaaaaaaaaa1"]);
			expect(page.next).toBeNull();
			expect(store.listThreadsPage("owner", {}, 1, null).next).not.toBeNull();
		});

		test("new activity moves a thread to the top, not its creation time", () => {
			store.createThread("aaaaaaaaaaa1", newThread());
			tick();
			store.createThread("aaaaaaaaaaa2", newThread());
			tick();
			store.enqueueTurn("aaaaaaaaaaa1", "again", "owner");
			expect(ids(store.listThreadsPage("owner", {}, 10, null))).toEqual(["aaaaaaaaaaa1", "aaaaaaaaaaa2"]);
		});

		test("a cursor still resumes after the thread it points at was deleted", async () => {
			store.createThread("aaaaaaaaaaa1", newThread());
			tick();
			store.createThread("aaaaaaaaaaa2", newThread());
			tick();
			store.createThread("aaaaaaaaaaa3", newThread());
			const first = store.listThreadsPage("owner", {}, 1, null);
			expect(ids(first)).toEqual(["aaaaaaaaaaa3"]);
			await store.deleteThread("aaaaaaaaaaa3");
			const second = store.listThreadsPage("owner", {}, 5, first.next);
			expect(ids(second)).toEqual(["aaaaaaaaaaa2", "aaaaaaaaaaa1"]);
			expect(second.total).toBe(2);
		});

		test("filters narrow the page and the total together; deleted threads and other owners never count", async () => {
			store.createThread("aaaaaaaaaaa1", newThread({ origin: "tool", ref: "alpha", session: "s1" }));
			tick();
			store.createThread("aaaaaaaaaaa2", newThread({ origin: "user", session: "s1", repo: { ...newThread().repo, name: "other-repo" } }));
			tick();
			store.createThread("aaaaaaaaaaa3", newThread({ origin: "tool", ref: "alpha", session: "s2" }));
			store.startNextTurn("aaaaaaaaaaa3");
			tick();
			store.createThread("aaaaaaaaaaa4", newThread({ origin: "tool", ref: "beta" }));
			store.createThread("aaaaaaaaaaa5", newThread({ owner: "other", origin: "tool", ref: "alpha" }));
			await store.deleteThread("aaaaaaaaaaa4");

			const page = (filter: Parameters<Store["listThreadsPage"]>[1], limit = 10): { ids: string[]; total: number } => {
				const found = store.listThreadsPage("owner", filter, limit, null);
				return { ids: ids(found), total: found.total };
			};
			expect(page({})).toEqual({ ids: ["aaaaaaaaaaa3", "aaaaaaaaaaa2", "aaaaaaaaaaa1"], total: 3 });
			expect(page({ origin: "tool" })).toEqual({ ids: ["aaaaaaaaaaa3", "aaaaaaaaaaa1"], total: 2 });
			expect(page({ ref: "alpha" })).toEqual({ ids: ["aaaaaaaaaaa3", "aaaaaaaaaaa1"], total: 2 });
			expect(page({ session: "s1" })).toEqual({ ids: ["aaaaaaaaaaa2", "aaaaaaaaaaa1"], total: 2 });
			expect(page({ repo: "other-repo" })).toEqual({ ids: ["aaaaaaaaaaa2"], total: 1 });
			expect(page({ phases: ["working", "failed"] })).toEqual({ ids: ["aaaaaaaaaaa3"], total: 1 });
			expect(page({ phases: ["starting"] })).toEqual({ ids: ["aaaaaaaaaaa2", "aaaaaaaaaaa1"], total: 2 });
			expect(page({ since: iso(1000) })).toEqual({ ids: ["aaaaaaaaaaa3", "aaaaaaaaaaa2"], total: 2 });
			expect(page({ origin: "tool", session: "s1" })).toEqual({ ids: ["aaaaaaaaaaa1"], total: 1 });
			// The total counts the whole filtered set while the page is cut.
			expect(page({ origin: "tool" }, 1)).toEqual({ ids: ["aaaaaaaaaaa3"], total: 2 });
			expect(page({ ref: "nothing" })).toEqual({ ids: [], total: 0 });
		});
	});

	describe("idempotency keys", () => {
		test("a key finds its owner's live thread and the fingerprint it was bound to; another owner or an unknown key finds none", () => {
			store.createThread("aaaaaaaaaaa1", newThread({ idempotency: { key: "k1", fingerprint: "f1" } }));
			const found = store.threadByIdempotencyKey("owner", "k1");
			expect(found?.thread.id).toBe("aaaaaaaaaaa1");
			expect(found?.fingerprint).toBe("f1");
			expect(store.threadByIdempotencyKey("other", "k1")).toBeNull();
			expect(store.threadByIdempotencyKey("owner", "k2")).toBeNull();
		});

		test("two owners may use the same key, one owner's second live thread may not", () => {
			store.createThread("aaaaaaaaaaa1", newThread({ idempotency: { key: "k1", fingerprint: "f1" } }));
			store.createThread("bbbbbbbbbbbb", newThread({ owner: "other", idempotency: { key: "k1", fingerprint: "f1" } }));
			expect(() => store.createThread("aaaaaaaaaaa2", newThread({ idempotency: { key: "k1", fingerprint: "f2" } }))).toThrow();
			expect(store.getThread("aaaaaaaaaaa2")).toBeNull();
		});

		test("deleting the thread frees its key and its fingerprint for a new one", async () => {
			store.createThread("aaaaaaaaaaa1", newThread({ idempotency: { key: "k1", fingerprint: "f1" } }));
			await store.deleteThread("aaaaaaaaaaa1");
			expect(store.threadByIdempotencyKey("owner", "k1")).toBeNull();
			store.createThread("aaaaaaaaaaa2", newThread({ idempotency: { key: "k1", fingerprint: "f2" } }));
			expect(store.threadByIdempotencyKey("owner", "k1")).toMatchObject({ thread: { id: "aaaaaaaaaaa2" }, fingerprint: "f2" });
		});

		test("only one create per owner and key is in progress at a time", () => {
			const release = store.beginCreate("owner", "k1");
			expect(release).not.toBeNull();
			expect(store.beginCreate("owner", "k1")).toBeNull();
			expect(store.beginCreate("owner", "k2")).not.toBeNull();
			expect(store.beginCreate("other", "k1")).not.toBeNull();
			release?.();
			expect(store.beginCreate("owner", "k1")).not.toBeNull();
		});
	});

	test("countThreads has every phase and counts the owner's live threads only", async () => {
		expect(store.countThreads("owner")).toEqual({ starting: 0, working: 0, waiting: 0, idle: 0, failed: 0 });
		store.createThread("aaaaaaaaaaa1", newThread());
		store.createThread("aaaaaaaaaaa2", newThread());
		store.startNextTurn("aaaaaaaaaaa2");
		store.createThread("aaaaaaaaaaa3", newThread());
		store.failThread("aaaaaaaaaaa3", "broken");
		store.createThread("aaaaaaaaaaa4", newThread());
		await store.deleteThread("aaaaaaaaaaa4");
		store.createThread("bbbbbbbbbbbb", newThread({ owner: "other" }));
		expect(store.countThreads("owner")).toEqual({ starting: 1, working: 1, waiting: 0, idle: 0, failed: 1 });
	});
});

describe("turn queue", () => {
	test("enqueueTurn gives the next id and enforces text limits", () => {
		store.createThread(ID, newThread());
		const turn = store.enqueueTurn(ID, "again", "alice");
		expect(turn).toMatchObject({ id: 2, state: "queued", text: "again", by: "alice", queuedAt: iso(0) });
		expect(codeOf(() => store.enqueueTurn(ID, "", "alice"))).toBe("invalid_text");
		expect(codeOf(() => store.enqueueTurn(ID, "x".repeat(MAX_TEXT_BYTES + 1), "alice"))).toBe("invalid_text");
		expect(store.enqueueTurn(ID, "x".repeat(MAX_TEXT_BYTES), "alice").id).toBe(3);
		expect(codeOf(() => store.enqueueTurn("bbbbbbbbbbbb", "x", "alice"))).toBe("thread_not_found");
	});

	test("a thread holds at most MAX_TURNS turns in any state", () => {
		store.createThread(ID, newThread());
		store.stopThread(ID, "alice");
		for (let i = 2; i <= MAX_TURNS; i++) expect(store.enqueueTurn(ID, "t", "alice").id).toBe(i);
		expect(codeOf(() => store.enqueueTurn(ID, "t", "alice"))).toBe("thread_full");
		expect(store.turns(ID)).toHaveLength(MAX_TURNS);
	});

	test("startNextTurn starts the oldest queued turn, redelivers the running one, and is null when empty", () => {
		store.createThread(ID, newThread());
		store.enqueueTurn(ID, "second", "alice");
		tick();
		const first = store.startNextTurn(ID);
		expect(first).toMatchObject({ id: 1, state: "running", startedAt: iso(1000) });
		tick();
		const again = store.startNextTurn(ID);
		expect(again).toEqual(first);
		expect(kinds()).toEqual(["turn_queued", "turn_queued", "turn_started"]);
		store.completeTurn(ID, 1, result());
		expect(store.startNextTurn(ID)).toMatchObject({ id: 2, state: "running" });
		store.completeTurn(ID, 2, result());
		expect(store.startNextTurn(ID)).toBeNull();
		expect(codeOf(() => store.startNextTurn("bbbbbbbbbbbb"))).toBe("thread_not_found");
	});

	test("turns lists every turn in id order with its questions in id order", () => {
		running();
		store.enqueueTurn(ID, "next", "alice");
		store.askQuestions(ID, 1, [question({ key: "x" }), question({ key: "y" })], null);
		const turns = store.turns(ID);
		expect(turns.map((t) => t.id)).toEqual([1, 2]);
		expect(turns[0]?.questions.map((q) => q.key)).toEqual(["x", "y"]);
		expect(turns[1]?.questions).toEqual([]);
	});
});

describe("completeTurn", () => {
	test("completed outcome makes the turn done and records the result", () => {
		running();
		tick();
		const turn = store.completeTurn(
			ID,
			1,
			result({ head: "h1", filesChanged: 2, insertions: 3, deletions: 4, pushed: true, pushError: "late", pushRef: "omp-cloud/x" }),
		);
		expect(turn).toMatchObject({
			state: "done",
			error: "",
			title: "All done",
			reply: "# All done\nbody",
			completedAt: iso(1000),
			head: "h1",
			filesChanged: 2,
			insertions: 3,
			deletions: 4,
			pushed: true,
			pushError: "late",
			pushRef: "omp-cloud/x",
			usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 0.5 },
		});
		expect(store.turns(ID)[0]).toEqual(turn);
		expect(store.getThread(ID)?.phase).toBe("idle");
		const last = store.events(ID, 0, 100).at(-1);
		expect(last).toMatchObject({ kind: "turn_done", turn: 1, text: "All done" });
	});

	test("a done turn without a reply has no title and the event says done", () => {
		running();
		const turn = store.completeTurn(ID, 1, result({ reply: "", usage: null }));
		expect(turn).toMatchObject({ title: "", usage: null });
		expect(store.events(ID, 0, 100).at(-1)?.text).toBe("done");
	});

	test("failed outcome records the error, cut to MAX_ERROR_CHARS", () => {
		running();
		const turn = store.completeTurn(ID, 1, result({ outcome: "failed", error: "💥".repeat(MAX_ERROR_CHARS + 5) }));
		expect(turn.state).toBe("failed");
		expect(Array.from(turn.error)).toHaveLength(MAX_ERROR_CHARS);
		expect(store.events(ID, 0, 100).at(-1)).toMatchObject({ kind: "turn_failed", turn: 1 });
	});

	test("a stop-requested turn always ends failed as stopped by whoever stopped it", () => {
		running();
		store.stopThread(ID, "alice");
		store.stopThread(ID, "bob");
		const turn = store.completeTurn(ID, 1, result());
		expect(turn).toMatchObject({ state: "failed", error: "stopped by alice", stopRequested: true, stoppedBy: "alice" });
	});

	test("drops the turn's unanswered questions and keeps answered ones", () => {
		running();
		tick();
		store.askQuestions(ID, 1, [question(), question()], null);
		store.answerQuestion(ID, 1, 1, ["a"], "", "alice");
		tick();
		const turn = store.completeTurn(ID, 1, result());
		expect(turn.questions[0]).toMatchObject({ answeredBy: "alice", expired: false });
		expect(turn.questions[1]).toMatchObject({ answeredBy: "dropped", expired: true, answeredAt: iso(2000) });
		expect(kinds().slice(-2)).toEqual(["question_expired", "turn_done"]);
	});

	test("only a running turn can be completed", () => {
		store.createThread(ID, newThread());
		expect(codeOf(() => store.completeTurn(ID, 1, result()))).toBe("turn_not_running");
		store.startNextTurn(ID);
		expect(codeOf(() => store.completeTurn(ID, 9, result()))).toBe("turn_not_running");
		store.completeTurn(ID, 1, result());
		expect(codeOf(() => store.completeTurn(ID, 1, result()))).toBe("turn_not_running");
		expect(codeOf(() => store.completeTurn("bbbbbbbbbbbb", 1, result()))).toBe("thread_not_found");
	});
});

describe("stopThread", () => {
	test("stops the running turn and cancels the queued ones", () => {
		running();
		store.enqueueTurn(ID, "q1", "alice");
		store.enqueueTurn(ID, "q2", "alice");
		store.askQuestions(ID, 1, [question()], null);
		tick();
		expect(store.stopThread(ID, "bob")).toEqual({ stoppedRunning: true, cancelled: 2 });
		const [t1, t2, t3] = store.turns(ID);
		expect(t1).toMatchObject({ state: "running", stopRequested: true, stoppedBy: "bob" });
		expect(t1?.questions[0]).toMatchObject({ answeredBy: "stop", answer: "", expired: true, answeredAt: iso(1000) });
		for (const t of [t2, t3]) {
			expect(t).toMatchObject({ state: "cancelled", stoppedBy: "bob", error: "cancelled by bob", completedAt: iso(1000) });
		}
		expect(kinds().slice(-4)).toEqual(["stop_requested", "question_expired", "turn_cancelled", "turn_cancelled"]);
		expect(store.getThread(ID)?.phase).toBe("working");
	});

	test("a repeated stop keeps the first stopper and does nothing more", () => {
		running();
		store.stopThread(ID, "bob");
		const before = store.events(ID, 0, 100).length;
		expect(store.stopThread(ID, "carol")).toEqual({ stoppedRunning: true, cancelled: 0 });
		expect(store.turns(ID)[0]?.stoppedBy).toBe("bob");
		expect(store.events(ID, 0, 100)).toHaveLength(before);
	});

	test("stopping a thread with nothing running leaves it idle", () => {
		store.createThread(ID, newThread());
		expect(store.stopThread(ID, "bob")).toEqual({ stoppedRunning: false, cancelled: 1 });
		expect(store.getThread(ID)?.phase).toBe("idle");
		expect(store.stopThread(ID, "bob")).toEqual({ stoppedRunning: false, cancelled: 0 });
		expect(codeOf(() => store.stopThread("bbbbbbbbbbbb", "bob"))).toBe("thread_not_found");
	});
});

describe("requeueRunningTurn", () => {
	test("markPromptSent stamps the running turn without an event, and a requeue clears it", () => {
		running();
		const before = kinds();
		tick();
		store.markPromptSent(ID, 1);
		expect(store.turns(ID)[0]?.promptSentAt).toBe(iso(1000));
		expect(kinds()).toEqual(before);
		expect(store.requeueRunningTurn(ID)).toBe(1);
		expect(store.turns(ID)[0]).toMatchObject({ state: "queued", startedAt: null, promptSentAt: null });
		expect(codeOf(() => store.markPromptSent(ID, 1))).toBe("turn_not_running");
		expect(codeOf(() => store.markPromptSent(ID, 9))).toBe("turn_not_running");
		expect(codeOf(() => store.markPromptSent("bbbbbbbbbbbb", 1))).toBe("thread_not_found");
		store.startNextTurn(ID);
		expect(store.turns(ID)[0]?.promptSentAt).toBeNull();
	});

	test("puts the running turn back in the queue, without startedAt and questions", () => {
		running();
		store.askQuestions(ID, 1, [question()], null);
		expect(store.requeueRunningTurn(ID)).toBe(1);
		expect(store.turns(ID)[0]).toMatchObject({ state: "queued", startedAt: null, questions: [] });
		expect(store.getThread(ID)?.phase).toBe("starting");
		expect(kinds().slice(-1)).toEqual(["turn_requeued"]);
		expect(store.startNextTurn(ID)).toMatchObject({ id: 1, state: "running" });
		// The redo asks from scratch: ids and ask numbers restart.
		expect(store.askQuestions(ID, 1, [question()], null)).toMatchObject({ ask: 1, questions: [{ id: 1 }] });
	});

	test("does nothing when no turn is running", () => {
		store.createThread(ID, newThread());
		expect(store.requeueRunningTurn(ID)).toBe(0);
		expect(store.turns(ID)[0]?.state).toBe("queued");
		expect(codeOf(() => store.requeueRunningTurn("bbbbbbbbbbbb"))).toBe("thread_not_found");
	});

	test("a stop-requested turn ends failed instead and is not counted", () => {
		running();
		tick();
		store.stopThread(ID, "bob");
		tick();
		expect(store.requeueRunningTurn(ID)).toBe(0);
		expect(store.turns(ID)[0]).toMatchObject({ state: "failed", error: "stopped by bob", completedAt: iso(2000) });
		expect(kinds().slice(-1)).toEqual(["turn_failed"]);
		expect(store.getThread(ID)?.phase).toBe("idle");
	});
});

describe("failThread", () => {
	test("fails queued and running turns, drops their questions and makes the thread terminal", () => {
		running();
		store.enqueueTurn(ID, "queued", "alice");
		store.askQuestions(ID, 1, [question()], null);
		tick();
		expect(store.failThread(ID, "vm lost")).toBe(2);
		const thread = store.getThread(ID);
		expect(thread).toMatchObject({ phase: "failed", error: "vm lost" });
		const [t1, t2] = store.turns(ID);
		expect(t1).toMatchObject({ state: "failed", error: "vm lost", completedAt: iso(1000) });
		expect(t1?.questions[0]).toMatchObject({ answeredBy: "dropped", expired: true });
		expect(t2).toMatchObject({ state: "failed", error: "vm lost" });
		expect(store.events(ID, 0, 100).at(-1)).toMatchObject({ kind: "thread_failed", turn: null, text: "vm lost" });
		expect(codeOf(() => store.enqueueTurn(ID, "more", "alice"))).toBe("thread_failed");
		expect(store.startNextTurn(ID)).toBeNull();
	});

	test("keeps finished turns as they were, cuts the error, and fails unknown threads", () => {
		running();
		store.completeTurn(ID, 1, result());
		expect(store.failThread(ID, "x".repeat(MAX_ERROR_CHARS + 10))).toBe(0);
		expect(store.turns(ID)[0]?.state).toBe("done");
		expect(store.getThread(ID)?.error).toHaveLength(MAX_ERROR_CHARS);
		expect(codeOf(() => store.failThread("bbbbbbbbbbbb", "x"))).toBe("thread_not_found");
	});
});

describe("askQuestions", () => {
	test("numbers questions and asks across calls", () => {
		running();
		tick();
		const first = store.askQuestions(ID, 1, [question({ key: "a" }), question({ key: "b", multi: true, recommended: 1, header: "H" })], null);
		expect(first.ask).toBe(1);
		expect(first.questions.map((q) => [q.id, q.ask, q.key])).toEqual([[1, 1, "a"], [2, 1, "b"]]);
		expect(first.questions[1]).toMatchObject({ multi: true, recommended: 1, header: "H", askedAt: iso(1000), answeredAt: null, answeredBy: "", expired: false, selected: [] });
		const second = store.askQuestions(ID, 1, [question({ key: "c" })], null);
		expect(second).toMatchObject({ ask: 2, questions: [{ id: 3, ask: 2 }] });
		expect(store.turns(ID)[0]?.questions.map((q) => q.id)).toEqual([1, 2, 3]);
		expect(kinds().slice(-3)).toEqual(["question_asked", "question_asked", "question_asked"]);
	});

	test("a turn takes at most MAX_QUESTIONS_PER_TURN questions; a refused call records nothing", () => {
		running();
		store.askQuestions(ID, 1, Array.from({ length: MAX_QUESTIONS_PER_TURN - 1 }, () => question()), null);
		expect(codeOf(() => store.askQuestions(ID, 1, [question(), question()], null))).toBe("too_many_questions");
		expect(store.turns(ID)[0]?.questions).toHaveLength(MAX_QUESTIONS_PER_TURN - 1);
		expect(store.askQuestions(ID, 1, [question()], null).questions).toHaveLength(1);
		expect(codeOf(() => store.askQuestions(ID, 1, [question()], null))).toBe("too_many_questions");
	});

	test("needs a running turn that was not asked to stop", () => {
		store.createThread(ID, newThread());
		expect(codeOf(() => store.askQuestions(ID, 1, [question()], null))).toBe("turn_not_running");
		store.startNextTurn(ID);
		expect(codeOf(() => store.askQuestions(ID, 7, [question()], null))).toBe("turn_not_running");
		store.stopThread(ID, "bob");
		expect(codeOf(() => store.askQuestions(ID, 1, [question()], null))).toBe("turn_not_running");
		store.completeTurn(ID, 1, result());
		expect(codeOf(() => store.askQuestions(ID, 1, [question()], null))).toBe("turn_not_running");
		expect(codeOf(() => store.askQuestions("bbbbbbbbbbbb", 1, [question()], null))).toBe("thread_not_found");
	});

	test("stores ompKey and ompLabels, and rejects labels that do not match the options one to one", () => {
		running();
		const asked = store.askQuestions(ID, 1, [question({ ompKey: "x".repeat(300), ompLabels: ["é".repeat(150), "b"] })], null);
		expect(asked.questions[0]).toMatchObject({ ompKey: "x".repeat(300), ompLabels: ["é".repeat(150), "b"] });
		store.close();
		store = open();
		expect(store.turns(ID)[0]?.questions[0]).toMatchObject({ ompKey: "x".repeat(300), ompLabels: ["é".repeat(150), "b"] });
		expect(codeOf(() => store.askQuestions(ID, 1, [question({ ompLabels: ["a"] })], null))).toBe("invalid_question");
		expect(codeOf(() => store.askQuestions(ID, 1, [question({ options: [], ompLabels: ["a"] })], null))).toBe("invalid_question");
		expect(store.turns(ID)[0]?.questions).toHaveLength(1);
	});

	test("stores the requestId on every question of the ask, and null when there is none", () => {
		running();
		const asked = store.askQuestions(ID, 1, [question({ key: "a" }), question({ key: "b" })], "ui-req-1");
		expect(asked.questions.map((q) => q.requestId)).toEqual(["ui-req-1", "ui-req-1"]);
		const later = store.askQuestions(ID, 1, [question({ key: "c" })], null);
		expect(later.questions[0]?.requestId).toBeNull();
		expect(store.turns(ID)[0]?.questions.map((q) => q.requestId)).toEqual(["ui-req-1", "ui-req-1", null]);
		store.close();
		store = open();
		expect(store.turns(ID)[0]?.questions.map((q) => q.requestId)).toEqual(["ui-req-1", "ui-req-1", null]);
	});

	test("rejects questions that break a limit, naming the question", () => {
		running();
		const euro = (n: number): string => "€".repeat(n);
		const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `o${i}`, description: "" }));
		const bad: QuestionInput[] = [
			question({ text: "" }),
			question({ text: "  \n" }),
			// 1334 characters, 4002 bytes
			question({ text: euro(1334) }),
			question({ key: "k".repeat(201) }),
			question({ header: "h".repeat(201) }),
			question({ options: opts(21) }),
			question({ options: [{ label: "", description: "" }] }),
			question({ options: [{ label: "l".repeat(201), description: "" }] }),
			question({ options: [{ label: "a", description: "d".repeat(501) }] }),
			question({ options: [{ label: "a", description: "" }, { label: "a", description: "x" }] }),
			question({ recommended: 2 }),
			question({ recommended: -1 }),
			question({ options: [], recommended: 0 }),
		];
		for (const input of bad) {
			let error: unknown;
			try {
				store.askQuestions(ID, 1, [question(), input], null);
			} catch (err) {
				error = err;
			}
			expect(error).toBeInstanceOf(StoreError);
			expect((error as StoreError).code).toBe("invalid_question");
			expect((error as StoreError).message).toContain("question 2");
		}
		expect(codeOf(() => store.askQuestions(ID, 1, [], null))).toBe("invalid_question");
		expect(store.turns(ID)[0]?.questions).toEqual([]);
	});

	test("accepts questions exactly at the limits", () => {
		running();
		const options = Array.from({ length: 20 }, (_, i) => ({ label: `${i}`.padEnd(200, "l"), description: "d".repeat(500) }));
		const { questions } = store.askQuestions(ID, 1, [
			question({ text: "t".repeat(MAX_QUESTION_TEXT_BYTES), key: "k".repeat(200), header: "h".repeat(200), options, recommended: 19 }),
			question({ options: [], recommended: null }),
		], null);
		expect(questions).toHaveLength(2);
	});
});

describe("answerQuestion", () => {
	beforeEach(() => {
		running();
		store.askQuestions(ID, 1, [question(), question({ multi: true })], null);
	});

	test("records the answer, trimming the free text", () => {
		tick();
		const answered = store.answerQuestion(ID, 1, 1, ["a"], "  because  ", "alice");
		expect(answered).toMatchObject({ id: 1, selected: ["a"], answer: "because", answeredBy: "alice", answeredAt: iso(1000), expired: false });
		expect(store.turns(ID)[0]?.questions[0]).toEqual(answered);
		expect(kinds().slice(-1)).toEqual(["question_answered"]);
		// Free text alone is an answer too.
		expect(store.answerQuestion(ID, 1, 2, [], " only text ", "alice")).toMatchObject({ selected: [], answer: "only text" });
	});

	test("a multi question takes several labels, a single one only one", () => {
		expect(codeOf(() => store.answerQuestion(ID, 1, 1, ["a", "b"], "", "alice"))).toBe("invalid_answer");
		expect(store.answerQuestion(ID, 1, 2, ["a", "b"], "", "alice").selected).toEqual(["a", "b"]);
	});

	test("rejects invalid answers and leaves the question open", () => {
		expect(codeOf(() => store.answerQuestion(ID, 1, 1, [], "   ", "alice"))).toBe("invalid_answer");
		expect(codeOf(() => store.answerQuestion(ID, 1, 1, ["nope"], "", "alice"))).toBe("invalid_answer");
		expect(codeOf(() => store.answerQuestion(ID, 1, 2, ["a", "a"], "", "alice"))).toBe("invalid_answer");
		expect(codeOf(() => store.answerQuestion(ID, 1, 1, [" a"], "", "alice"))).toBe("invalid_answer");
		expect(codeOf(() => store.answerQuestion(ID, 1, 1, [], "x".repeat(MAX_QUESTION_TEXT_BYTES + 1), "alice"))).toBe("invalid_answer");
		expect(codeOf(() => store.answerQuestion(ID, 1, 1, [], "€".repeat(1334), "alice"))).toBe("invalid_answer");
		expect(store.turns(ID)[0]?.questions[0]?.answeredAt).toBeNull();
		// The limit applies after trimming.
		const padded = ` ${"x".repeat(MAX_QUESTION_TEXT_BYTES)} `;
		expect(store.answerQuestion(ID, 1, 1, [], padded, "alice").answer).toHaveLength(MAX_QUESTION_TEXT_BYTES);
	});

	test("unknown thread, turn or question", () => {
		expect(codeOf(() => store.answerQuestion("bbbbbbbbbbbb", 1, 1, ["a"], "", "alice"))).toBe("thread_not_found");
		expect(codeOf(() => store.answerQuestion(ID, 9, 1, ["a"], "", "alice"))).toBe("question_not_found");
		expect(codeOf(() => store.answerQuestion(ID, 1, 9, ["a"], "", "alice"))).toBe("question_not_found");
	});

	test("an answered or expired question is not waiting any more", () => {
		store.answerQuestion(ID, 1, 1, ["a"], "", "alice");
		expect(codeOf(() => store.answerQuestion(ID, 1, 1, ["b"], "", "bob"))).toBe("not_waiting");
		store.stopThread(ID, "bob");
		expect(codeOf(() => store.answerQuestion(ID, 1, 2, ["a"], "", "alice"))).toBe("not_waiting");
		// A finished turn has no waiting question either.
		store.completeTurn(ID, 1, result());
		expect(codeOf(() => store.answerQuestion(ID, 1, 1, ["a"], "", "alice"))).toBe("not_waiting");
	});
});

describe("expireAsk", () => {
	test("expires the unanswered questions of one ask and returns the whole ask", () => {
		running();
		store.askQuestions(ID, 1, [question(), question()], null);
		store.askQuestions(ID, 1, [question()], null);
		store.answerQuestion(ID, 1, 1, ["a"], "", "alice");
		tick();
		const qs = store.expireAsk(ID, 1, 1, "no answer", "timeout");
		expect(qs.map((q) => [q.id, q.answeredBy, q.expired])).toEqual([[1, "alice", false], [2, "timeout", true]]);
		expect(qs[1]).toMatchObject({ answer: "no answer", answeredAt: iso(1000) });
		const turn = store.turns(ID)[0];
		expect(turn?.questions[2]?.answeredAt).toBeNull();
		expect(kinds().filter((k) => k === "question_expired")).toHaveLength(1);
		// Repeating changes nothing.
		expect(store.expireAsk(ID, 1, 1, "again", "timeout")).toEqual(qs);
	});

	test("errors", () => {
		running();
		store.askQuestions(ID, 1, [question()], null);
		expect(codeOf(() => store.expireAsk("bbbbbbbbbbbb", 1, 1, "", "timeout"))).toBe("thread_not_found");
		expect(codeOf(() => store.expireAsk(ID, 1, 2, "", "timeout"))).toBe("question_not_found");
		expect(codeOf(() => store.expireAsk(ID, 5, 1, "", "timeout"))).toBe("question_not_found");
		expect(codeOf(() => store.expireAsk(ID, 1, 1, "x".repeat(MAX_QUESTION_TEXT_BYTES + 1), "timeout"))).toBe("invalid_answer");
		expect(store.turns(ID)[0]?.questions[0]?.answeredAt).toBeNull();
	});
});

describe("pending question and threadStats", () => {
	test("the oldest unanswered question, with how many of its ask remain", () => {
		running();
		expect(store.threadStats(ID).pending).toBeNull();
		store.askQuestions(ID, 1, [question({ key: "a" }), question({ key: "b" })], null);
		store.askQuestions(ID, 1, [question({ key: "c" })], null);
		expect(store.threadStats(ID).pending).toMatchObject({ turn: 1, question: { id: 1, key: "a" }, remaining: 2 });
		store.answerQuestion(ID, 1, 1, ["a"], "", "alice");
		expect(store.threadStats(ID).pending).toMatchObject({ question: { id: 2 }, remaining: 1 });
		store.answerQuestion(ID, 1, 2, ["a"], "", "alice");
		expect(store.threadStats(ID).pending).toMatchObject({ question: { id: 3, key: "c" }, remaining: 1 });
		store.answerQuestion(ID, 1, 3, ["a"], "", "alice");
		expect(store.threadStats(ID).pending).toBeNull();
	});

	test("counts turns and queued turns; latest is the highest done or failed turn, resultTurn the highest with a head", () => {
		store.createThread(ID, newThread());
		expect(store.threadStats(ID)).toMatchObject({ turns: 1, queued: 1, latest: null, resultTurn: null, pending: null });
		store.startNextTurn(ID);
		store.completeTurn(ID, 1, result({ head: "h1" }));
		store.enqueueTurn(ID, "two", "alice");
		store.startNextTurn(ID);
		store.completeTurn(ID, 2, result({ head: "" }));
		store.enqueueTurn(ID, "three", "alice");
		store.startNextTurn(ID);
		store.completeTurn(ID, 3, result({ outcome: "failed", error: "boom" }));
		store.enqueueTurn(ID, "four", "alice");
		const stats = store.threadStats(ID);
		expect(stats.turns).toBe(4);
		expect(stats.queued).toBe(1);
		expect(stats.latest?.id).toBe(3);
		expect(stats.resultTurn?.id).toBe(1);
		store.startNextTurn(ID);
		store.completeTurn(ID, 4, result({ head: "h4" }));
		expect(store.threadStats(ID)).toMatchObject({ queued: 0, latest: { id: 4 }, resultTurn: { id: 4, head: "h4" } });
	});
});

describe("phase and lastActivityAt", () => {
	const phase = (): string | undefined => store.getThread(ID)?.phase;

	test("follows the turns through start, ask, answer, completion and a later message", () => {
		store.createThread(ID, newThread());
		expect(phase()).toBe("starting");
		tick();
		store.startNextTurn(ID);
		expect(phase()).toBe("working");
		store.askQuestions(ID, 1, [question(), question()], null);
		expect(phase()).toBe("waiting");
		store.answerQuestion(ID, 1, 1, ["a"], "", "alice");
		expect(phase()).toBe("waiting");
		store.answerQuestion(ID, 1, 2, ["a"], "", "alice");
		expect(phase()).toBe("working");
		tick();
		store.completeTurn(ID, 1, result());
		expect(phase()).toBe("idle");
		// A later message waits in `working`, not `starting`: a turn has started before.
		store.enqueueTurn(ID, "more", "alice");
		expect(phase()).toBe("working");
		store.startNextTurn(ID);
		store.stopThread(ID, "bob");
		expect(phase()).toBe("working");
		store.completeTurn(ID, 2, result());
		expect(phase()).toBe("idle");
	});

	test("an expired question no longer makes the thread wait", () => {
		running();
		store.askQuestions(ID, 1, [question()], null);
		expect(phase()).toBe("waiting");
		store.expireAsk(ID, 1, 1, "", "timeout");
		expect(phase()).toBe("working");
	});

	test("lastActivityAt is the latest queued, started or completed time", () => {
		store.createThread(ID, newThread());
		const last = (): string | undefined => store.getThread(ID)?.lastActivityAt;
		expect(last()).toBe(iso(0));
		tick(1000);
		store.enqueueTurn(ID, "two", "alice");
		expect(last()).toBe(iso(1000));
		tick(1000);
		store.startNextTurn(ID);
		expect(last()).toBe(iso(2000));
		tick(1000);
		store.completeTurn(ID, 1, result());
		expect(last()).toBe(iso(3000));
	});

	test("failed beats every turn-derived phase", () => {
		running();
		store.askQuestions(ID, 1, [question()], null);
		store.failThread(ID, "dead");
		expect(phase()).toBe("failed");
	});
});

describe("events and subscriptions", () => {
	test("seq is per thread, gapless, and events pages by after and limit", () => {
		running();
		store.createThread("bbbbbbbbbbbb", newThread());
		store.appendEvent(ID, "progress", "working", 1);
		store.askQuestions(ID, 1, [question(), question()], null);
		store.stopThread(ID, "bob");
		const all = store.events(ID, 0, 1000);
		expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
		expect(all.length).toBeGreaterThan(6);
		expect(store.events("bbbbbbbbbbbb", 0, 10).map((e) => e.seq)).toEqual([1]);
		expect(store.events(ID, 2, 3).map((e) => e.seq)).toEqual([3, 4, 5]);
		expect(store.events(ID, all.length, 10)).toEqual([]);
		expect(store.events(ID, 0, 0)).toEqual([]);
	});

	test("appendEvent validates the kind, cuts the text by characters and needs a thread", () => {
		store.createThread(ID, newThread());
		for (const kind of ["", "Progress", "1abc", "a-b", "a".repeat(33), "über"]) {
			expect(codeOf(() => store.appendEvent(ID, kind, "x", null))).toBe("invalid_event");
		}
		expect(store.appendEvent(ID, "a".repeat(32), "x", null).kind).toHaveLength(32);
		const event = store.appendEvent(ID, "progress", "😀".repeat(MAX_EVENT_TEXT_CHARS + 50), 1);
		expect(Array.from(event.text)).toHaveLength(MAX_EVENT_TEXT_CHARS);
		expect(event).toMatchObject({ kind: "progress", turn: 1 });
		expect(store.events(ID, event.seq - 1, 1)).toEqual([event]);
		expect(store.appendEvent(ID, "progress", "no turn", null).turn).toBeNull();
		expect(codeOf(() => store.appendEvent("bbbbbbbbbbbb", "progress", "x", null))).toBe("thread_not_found");
	});

	test("appendEvent keeps 4000 characters of a structured kind (usage, tool_start, tool_end, child_start, child_progress, child_end) whole and still cuts any other kind at 500", () => {
		store.createThread(ID, newThread());
		for (const kind of ["usage", "tool_start", "tool_end", "child_start", "child_progress", "child_end"]) {
			expect(store.appendEvent(ID, kind, "x".repeat(4000), 1).text).toHaveLength(4000);
		}
		expect(store.appendEvent(ID, "assistant", "x".repeat(4000), 1).text).toHaveLength(MAX_EVENT_TEXT_CHARS);
		expect(MAX_EVENT_TEXT_CHARS).toBe(500);
	});

	test("childEvents lists the child_start and child_end events of the thread in order and nothing else", () => {
		store.createThread(ID, newThread());
		store.appendEvent(ID, "tool_end", "{}", 1);
		store.appendEvent(ID, "child_start", '{"job":"a"}', 1);
		store.appendEvent(ID, "child_progress", '{"job":"a"}', 1);
		store.appendEvent(ID, "child_end", '{"job":"a"}', 1);
		expect(store.childEvents(ID).map(event => event.kind)).toEqual(["child_start", "child_end"]);
		expect(store.childEvents("nosuchthread")).toEqual([]);
	});

	test("listeners hear each committed event in seq order, only for their thread, until they unsubscribe", () => {
		running();
		store.createThread("bbbbbbbbbbbb", newThread());
		const a = record();
		const unsubscribe = store.subscribe(ID, a.listener);
		store.subscribe("bbbbbbbbbbbb", record().listener);
		store.askQuestions(ID, 1, [question(), question()], null);
		store.appendEvent("bbbbbbbbbbbb", "progress", "other", null);
		expect(a.seen.map((e) => e.kind)).toEqual(["question_asked", "question_asked"]);
		expect(a.seen.map((e) => e.seq)).toEqual([3, 4]);
		expect(a.seen).toEqual(store.events(ID, 2, 10));
		unsubscribe();
		store.appendEvent(ID, "progress", "later", null);
		expect(a.seen).toHaveLength(2);
	});

	test("a throwing listener is logged and does not stop other listeners or the mutation", () => {
		running();
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			const good = record();
			store.subscribe(ID, {
				event: () => {
					throw new Error("listener bug");
				},
				deleted: () => {},
			});
			store.subscribe(ID, good.listener);
			expect(store.appendEvent(ID, "progress", "x", null).kind).toBe("progress");
			expect(good.seen).toHaveLength(1);
			expect(log).toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	test("a transaction that fails after appending events notifies nobody and changes nothing", () => {
		running();
		store.enqueueTurn(ID, "queued", "alice");
		const heard = record();
		store.subscribe(ID, heard.listener);
		const eventsBefore = store.events(ID, 0, 100);
		// A second connection plants a failure that hits after the turn_failed events were appended.
		const other = new Database(join(dir, "omp-cloud.db"));
		other.run("CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.kind = 'thread_failed' BEGIN SELECT RAISE(ABORT, 'boom'); END");
		other.close();
		expect(() => store.failThread(ID, "dead")).toThrow();
		expect(heard.seen).toEqual([]);
		expect(store.events(ID, 0, 100)).toEqual(eventsBefore);
		expect(store.getThread(ID)).toMatchObject({ phase: "working", error: "" });
		expect(store.turns(ID).map((t) => t.state)).toEqual(["running", "queued"]);
	});
});

describe("deleteThread", () => {
	test("leaves a tombstone: the thread, its turns, events and blobs are gone", async () => {
		running();
		store.askQuestions(ID, 1, [question()], null);
		await store.putBlob(ID, "source.bundle", bytes(10), 100);
		const heard = record();
		store.subscribe(ID, heard.listener);
		expect(await store.deleteThread(ID)).toBe(true);
		expect(heard.deleted).toBe(1);
		expect(store.getThread(ID)).toBeNull();
		expect(store.listThreads("owner", 10)).toEqual([]);
		expect(store.countThreads("owner").working).toBe(0);
		expect(store.events(ID, 0, 10)).toEqual([]);
		expect(codeOf(() => store.turns(ID))).toBe("thread_not_found");
		expect(codeOf(() => store.enqueueTurn(ID, "x", "alice"))).toBe("thread_not_found");
		expect(await store.blob(ID, "source.bundle")).toBeNull();
		expect(await store.deleteThread(ID)).toBe(false);
		expect(heard.deleted).toBe(1);
		// The id is not reusable.
		expect(() => store.createThread(ID, newThread())).toThrow();
		// Deleting an unknown thread is false, not an error.
		expect(await store.deleteThread("bbbbbbbbbbbb")).toBe(false);
	});

	test("a deleted thread's tombstone survives a restart as deleted", async () => {
		store.createThread(ID, newThread());
		await store.deleteThread(ID);
		store.close();
		store = open();
		expect(store.getThread(ID)).toBeNull();
		expect(await store.sweepOrphanBlobs()).toBe(0);
	});

	// Root ignores directory permissions, so the removal cannot be made to fail there.
	test.skipIf(process.getuid?.() === 0)("a failed blob removal still ends the thread; the next sweep removes the files", async () => {
		store.createThread(ID, newThread());
		await store.putBlob(ID, "source.bundle", bytes(10), 100);
		const heard = record();
		store.subscribe(ID, heard.listener);
		const logged = spyOn(console, "error").mockImplementation(() => {});
		const threads = join(dir, "threads");
		await chmod(threads, 0o500);
		let logCalls = 0;
		try {
			expect(await store.deleteThread(ID)).toBe(true);
			logCalls = logged.mock.calls.length;
		} finally {
			await chmod(threads, 0o700);
			logged.mockRestore();
		}
		expect(logCalls).toBeGreaterThan(0);
		expect(heard.deleted).toBe(1);
		expect(store.getThread(ID)).toBeNull();
		expect(await readdir(threads)).toEqual([ID]);
		expect(await store.sweepOrphanBlobs()).toBe(1);
		expect(await readdir(threads)).toEqual([]);
	});
});

describe("persistence", () => {
	test("everything survives close and reopen", async () => {
		running();
		store.enqueueTurn(ID, "next", "alice");
		store.askQuestions(ID, 1, [question({ recommended: 1 })], null);
		store.answerQuestion(ID, 1, 1, ["b"], "why", "alice");
		store.appendEvent(ID, "progress", "x", 1);
		const thread = store.getThread(ID);
		const turns = store.turns(ID);
		const events = store.events(ID, 0, 100);
		store.close();
		store = open();
		expect(store.getThread(ID)).toEqual(thread);
		expect(store.turns(ID)).toEqual(turns);
		expect(store.events(ID, 0, 100)).toEqual(events);
		expect(store.appendEvent(ID, "progress", "y", null).seq).toBe(events.length + 1);
		const raw = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		raw.close();
	});
});

describe("migration 2", () => {
	test("a database created by migration 1 keeps its data and gains the runner records", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		raw.run(MIGRATIONS[0] as string);
		raw.run("PRAGMA user_version = 1");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'working', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw.query("INSERT INTO turns (thread_id, id, state, text, sent_by, queued_at, started_at) VALUES (?, 1, 'running', 'hi', 'owner', ?, ?)").run(ID, iso(0), iso(0));
		raw
			.query(
				`INSERT INTO questions (thread_id, turn_id, id, ask, key, text, header, options, multi, recommended, asked_at)
				VALUES (?, 1, 1, 1, 'k', 'Which?', '', '[]', 0, NULL, ?)`,
			)
			.run(ID, iso(0));
		raw.query("INSERT INTO events (thread_id, seq, at, kind, turn_id, text) VALUES (?, 1, ?, 'turn_queued', 1, 'queued by owner')").run(ID, iso(0));
		raw.close();

		store = open();
		expect(store.getThread(ID)).toMatchObject({ id: ID, owner: "owner", title: "old", model: "m" });
		expect(store.turns(ID)[0]).toMatchObject({ id: 1, state: "running", text: "hi" });
		expect(store.turns(ID)[0]?.questions[0]).toMatchObject({ id: 1, text: "Which?", requestId: null });
		expect(store.events(ID, 0, 10).map((e) => e.kind)).toEqual(["turn_queued"]);
		expect(store.vms()).toEqual([]);
		expect(store.serviceId()).toMatch(/^[a-z0-9]{12}$/);
		// The new column and tables work on the migrated data.
		expect(store.askQuestions(ID, 1, [question()], "req-1").questions[0]?.requestId).toBe("req-1");
		expect(store.putVm({ threadId: ID, sandboxId: "sbx", state: "running", pid: null, sessionFile: null }).sandboxId).toBe("sbx");

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		check.close();
		store = open();
	});
});

describe("migration 3", () => {
	test("a version 2 database gains config_overlays and omp_version with their defaults", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		raw.run(MIGRATIONS[0] as string);
		raw.run(MIGRATIONS[1] as string);
		raw.run("PRAGMA user_version = 2");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'working', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.getThread(ID)).toMatchObject({ id: ID, title: "old", configOverlays: [], ompVersion: "" });
		const other = "bbbbbbbbbbbb";
		store.createThread(other, newThread({ configOverlays: ["overlays/a.yml", "b.yml"], ompVersion: "18.12.3" }));
		store.close();
		store = open();
		expect(store.getThread(other)).toMatchObject({ configOverlays: ["overlays/a.yml", "b.yml"], ompVersion: "18.12.3" });

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		check.close();
		store = open();
	});
});

describe("migration 4", () => {
	test("a version 3 database keeps its data and gains the settings tables", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 3)) raw.run(migration);
		raw.run("PRAGMA user_version = 3");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'working', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.getThread(ID)).toMatchObject({ id: ID, title: "old" });
		expect(store.settingRows()).toEqual([]);
		expect(store.settingsAudit(0, 10)).toEqual([]);
		expect(store.applySettings([{ key: "git.push", value: '"ask"' }], "owner", "set")).toEqual(["git.push"]);

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4);
		check.close();
		store = open();
		expect(store.settingRows()).toEqual([{ key: "git.push", value: '"ask"', updatedAt: iso(0), updatedBy: "owner" }]);
	});
});

describe("migration 5", () => {
	test("a version 4 database keeps its turns and gains push_ref, empty for them", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 4)) raw.run(migration);
		raw.run("PRAGMA user_version = 4");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'idle', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw
			.query(
				`INSERT INTO turns (thread_id, id, state, text, sent_by, queued_at, started_at, completed_at, head, pushed, push_error)
				VALUES (?, 1, 'done', 'hi', 'owner', ?, ?, ?, 'abc', 1, '')`,
			)
			.run(ID, iso(0), iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.turns(ID)[0]).toMatchObject({ head: "abc", pushed: true, pushError: "", pushRef: "" });

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(5);
		check.close();
		store = open();
	});
});

describe("migration 6", () => {
	test("a version 5 database gets the day totals of its completed turns, per owner and UTC day", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 5)) raw.run(migration);
		raw.run("PRAGMA user_version = 5");
		const thread = raw.query(
			`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
				repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
			VALUES (?, ?, 'idle', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
		);
		thread.run("aaaaaaaaaaaa", "owner", iso(0), iso(0));
		thread.run("bbbbbbbbbbbb", "owner", iso(0), iso(0));
		thread.run("cccccccccccc", "bob", iso(0), iso(0));
		const turn = raw.query(
			`INSERT INTO turns (thread_id, id, state, text, sent_by, queued_at, started_at, completed_at, usage)
			VALUES (?, ?, ?, 'hi', 'owner', ?, ?, ?, ?)`,
		);
		const day = 86_400_000;
		const usage = (cost: number) => JSON.stringify({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost });
		turn.run("aaaaaaaaaaaa", 1, "done", iso(0), iso(0), iso(0), usage(0.5));
		turn.run("aaaaaaaaaaaa", 2, "failed", iso(0), iso(0), iso(1000), usage(0.25));
		turn.run("bbbbbbbbbbbb", 1, "done", iso(0), iso(0), iso(day), usage(1.5));
		turn.run("bbbbbbbbbbbb", 2, "done", iso(0), iso(0), iso(day), null);
		turn.run("bbbbbbbbbbbb", 3, "done", iso(0), iso(0), iso(day), usage(0));
		turn.run("cccccccccccc", 1, "done", iso(0), iso(0), iso(0), usage(9));
		raw.close();

		store = open();
		expect(store.daySpend("owner", "2026-01-01")).toBe(0.75);
		expect(store.daySpend("owner", "2026-01-02")).toBe(1.5);
		expect(store.daySpend("bob", "2026-01-01")).toBe(9);
		expect(store.daySpend("bob", "2026-01-02")).toBe(0);
		await store.deleteThread("aaaaaaaaaaaa");
		expect(store.daySpend("owner", "2026-01-01")).toBe(0.75);

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(6);
		check.close();
		store = open();
	});
});

describe("migration 7", () => {
	test("a version 6 database gains threads.policy, `{}` for the threads that predate it, and a policy round-trips", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 6)) raw.run(migration);
		raw.run("PRAGMA user_version = 6");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'idle', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.getThread(ID)?.policy).toEqual({});
		const other = "bbbbbbbbbbbb";
		const policy = { "bash.patterns": [{ match: "ls*", approval: "deny" as const }], fetch: false, egress: ["example.com"], "spend.turnUSD": 0.5 };
		expect(store.createThread(other, newThread({ policy })).thread.policy).toEqual(policy);
		store.close();
		store = open();
		expect(store.getThread(other)?.policy).toEqual(policy);
		expect(store.getThread(ID)?.policy).toEqual({});

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(7);
		check.close();
		store = open();
	});
});

describe("migration 12", () => {
	test("a version 11 database gains the pull request columns, null for its threads, and a pull request round-trips", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 11)) raw.run(migration);
		raw.run("PRAGMA user_version = 11");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'idle', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.getThread(ID)?.pr).toBeNull();

		const pr = { number: 7, url: "https://github.com/acme/app/pull/7" };
		store.setThreadPullRequest(ID, pr);
		expect(store.getThread(ID)?.pr).toEqual(pr);
		store.setThreadPullRequest(ID, { number: 8, url: "https://github.com/acme/app/pull/8" });
		expect(store.getThread(ID)?.pr).toEqual({ number: 8, url: "https://github.com/acme/app/pull/8" });
		// An unknown thread is a no-op.
		store.setThreadPullRequest("zzzzzzzzzzzz", pr);
		store.close();
		store = open();
		expect(store.getThread(ID)?.pr).toEqual({ number: 8, url: "https://github.com/acme/app/pull/8" });

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(12);
		check.close();
		store = open();
	});
});

describe("migration 13", () => {
	test("a version 12 database gains the secret and MCP tables and the thread columns, empty for its threads", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 12)) raw.run(migration);
		raw.run("PRAGMA user_version = 12");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'idle', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.getThread(ID)?.mcpServers).toEqual([]);
		expect(store.listSecrets()).toEqual([]);
		expect(store.mcpCredentialUrls()).toEqual([]);
		expect(store.threadByMcpToken("")).toBeNull();
		store.close();

		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(13);
		const columns = (table: string): string[] => check.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name);
		expect(columns("secrets")).toEqual(["name", "value", "repos", "updated_at", "updated_by"]);
		expect(columns("mcp_credentials")).toEqual(["url", "credential", "updated_at"]);
		expect(columns("threads")).toEqual(expect.arrayContaining(["mcp_names", "mcp_token_sha256"]));
		expect(check.query<{ name: string }, []>("SELECT name FROM pragma_index_list('threads')").all().map((row) => row.name)).toContain("threads_mcp_token");
		check.close();
		store = open();
	});
});

describe("migration 14", () => {
	test("a version 13 database gains memory_bank, empty for its threads", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 13)) raw.run(migration);
		raw.run("PRAGMA user_version = 13");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'idle', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.getThread(ID)?.memoryBank).toBe("");
		store.close();

		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(14);
		expect(check.query<{ name: string }, []>("SELECT name FROM pragma_table_info('threads')").all().map((row) => row.name)).toContain("memory_bank");
		check.close();
		store = open();
	});

	test("a thread keeps the memory bank it was created with", () => {
		expect(store.createThread(ID, newThread({ memoryBank: "project-abc" })).thread.memoryBank).toBe("project-abc");
		expect(store.createThread("bbbbbbbbbbbb", newThread()).thread.memoryBank).toBe("");
		expect(store.getThread(ID)?.memoryBank).toBe("project-abc");
	});
});

describe("secrets and MCP", () => {
	test("secrets are listed without values, in name order; a put replaces and stamps the clock and actor", () => {
		store.putSecret({ name: "B_TOKEN", value: "!op read x", repos: ["*"] }, "owner");
		store.putSecret({ name: "A_TOKEN", value: "plain", repos: ["github.com/a/*", "local/*"] }, "owner");
		expect(store.listSecrets()).toEqual([
			{ name: "A_TOKEN", repos: ["github.com/a/*", "local/*"], kind: "literal", updatedAt: iso(0), updatedBy: "owner" },
			{ name: "B_TOKEN", repos: ["*"], kind: "command", updatedAt: iso(0), updatedBy: "owner" },
		]);
		tick();
		store.putSecret({ name: "A_TOKEN", value: "changed", repos: ["*"] }, "device:d1");
		expect(store.secretRows()).toEqual([
			{ name: "A_TOKEN", value: "changed", repos: ["*"] },
			{ name: "B_TOKEN", value: "!op read x", repos: ["*"] },
		]);
		expect(store.listSecrets()[0]).toEqual({ name: "A_TOKEN", repos: ["*"], kind: "literal", updatedAt: iso(1000), updatedBy: "device:d1" });
		expect(JSON.stringify(store.listSecrets())).not.toContain("changed");
	});

	test("deleteSecret says whether a secret was there", () => {
		store.putSecret({ name: "A_TOKEN", value: "v", repos: ["*"] }, "owner");
		expect(store.deleteSecret("A_TOKEN")).toBe(true);
		expect(store.deleteSecret("A_TOKEN")).toBe(false);
		expect(store.secretRows()).toEqual([]);
	});

	test("MCP credentials round-trip per URL and replace on a second put", () => {
		expect(store.mcpCredential("https://mcp.example/mcp")).toBeNull();
		store.putMcpCredential("https://mcp.example/mcp", '{"access":"a"}', iso(0));
		store.putMcpCredential("https://a.example/mcp", '{"access":"b"}', iso(0));
		store.putMcpCredential("https://mcp.example/mcp", '{"access":"c"}', iso(1000));
		expect(store.mcpCredential("https://mcp.example/mcp")).toBe('{"access":"c"}');
		expect(store.mcpCredentialUrls()).toEqual(["https://a.example/mcp", "https://mcp.example/mcp"]);
	});

	test("a thread stores its MCP server names, and its token hash finds it until it is deleted", async () => {
		expect(store.createThread(ID, newThread({ mcpServers: ["fake", "docs"] })).thread.mcpServers).toEqual(["fake", "docs"]);
		expect(store.createThread("bbbbbbbbbbbb", newThread()).thread.mcpServers).toEqual([]);
		store.setMcpToken(ID, "a".repeat(64));
		expect(store.threadByMcpToken("a".repeat(64))?.id).toBe(ID);
		expect(store.threadByMcpToken("b".repeat(64))).toBeNull();
		expect(store.threadByMcpToken("")).toBeNull();
		store.setMcpToken(ID, "c".repeat(64));
		expect(store.threadByMcpToken("a".repeat(64))).toBeNull();
		expect(store.threadByMcpToken("c".repeat(64))?.mcpServers).toEqual(["fake", "docs"]);
		// An unknown thread is a no-op.
		store.setMcpToken("zzzzzzzzzzzz", "d".repeat(64));
		await store.deleteThread(ID);
		expect(store.threadByMcpToken("c".repeat(64))).toBeNull();
	});
});

describe("settings", () => {
	const set = (key: string, value: string | null): SettingChange => ({ key, value });

	test("applySettings upserts and deletes rows with one audit row per changed key, stamped with the clock and actor", () => {
		expect(store.applySettings([set("a", '"x"'), set("b", "1")], "alice", "set")).toEqual(["a", "b"]);
		tick();
		expect(store.applySettings([set("a", '"y"'), set("b", null)], "bob", "set")).toEqual(["a", "b"]);
		expect(store.settingRows()).toEqual([{ key: "a", value: '"y"', updatedAt: iso(1000), updatedBy: "bob" }]);
		expect(store.settingsAudit(0, 10).map((e) => [e.seq, e.at, e.actor, e.action, e.key, e.oldValue, e.newValue])).toEqual([
			[4, iso(1000), "bob", "reset", "b", "1", null],
			[3, iso(1000), "bob", "set", "a", '"x"', '"y"'],
			[2, iso(0), "alice", "set", "b", null, "1"],
			[1, iso(0), "alice", "set", "a", null, '"x"'],
		]);
	});

	test("a change to the value a key already has writes nothing, and the action import audits every changed key", () => {
		store.applySettings([set("a", '"x"')], "alice", "set");
		tick();
		expect(store.applySettings([set("a", '"x"'), set("never-set", null)], "bob", "set")).toEqual([]);
		expect(store.settingRows()[0]).toMatchObject({ updatedAt: iso(0), updatedBy: "alice" });
		expect(store.settingsAudit(0, 10)).toHaveLength(1);
		expect(store.applySettings([set("a", null), set("b", "2")], "bob", "import")).toEqual(["a", "b"]);
		expect(store.settingsAudit(0, 2).map((e) => e.action)).toEqual(["import", "import"]);
	});

	test("a batch that throws rolls back every row and audit entry", () => {
		store.applySettings([set("a", '"x"')], "alice", "set");
		expect(() => store.applySettings([set("a", '"y"'), { key: "b", value: undefined as unknown as string }], "bob", "set")).toThrow();
		expect(store.settingRows().map((r) => [r.key, r.value])).toEqual([["a", '"x"']]);
		expect(store.settingsAudit(0, 10)).toHaveLength(1);
	});

	test("settingsAudit pages newest first by seq below before", () => {
		for (const value of ["1", "2", "3", "4", "5"]) store.applySettings([set("a", value)], "alice", "set");
		expect(store.settingsAudit(0, 2).map((e) => e.seq)).toEqual([5, 4]);
		expect(store.settingsAudit(4, 2).map((e) => e.seq)).toEqual([3, 2]);
		expect(store.settingsAudit(2, 10).map((e) => e.seq)).toEqual([1]);
		expect(store.settingsAudit(1, 10)).toEqual([]);
	});

	test("rows and the audit log survive a restart", () => {
		store.applySettings([set("a", '"x"')], "alice", "set");
		store.close();
		store = open();
		expect(store.settingRows().map((r) => r.key)).toEqual(["a"]);
		expect(store.settingsAudit(0, 10)).toHaveLength(1);
	});
});

describe("spend", () => {
	const DAY = 86_400_000;
	const A = "aaaaaaaaaaaa";
	const B = "bbbbbbbbbbbb";
	const C = "cccccccccccc";
	const usage = (cost: number, n = 1) => ({ inputTokens: n, outputTokens: 2 * n, cacheReadTokens: 3 * n, cacheWriteTokens: 4 * n, cost });

	/** Thread A: a turn of 0.5 on day 1 and one of 1.25 on day 2. B: a turn without usage on day 1, one of 0.25 on day 2. C (bob's): 9 on day 1. */
	function seed(): void {
		store.createThread(A, newThread());
		store.startNextTurn(A);
		store.createThread(B, newThread({ title: "other" }));
		store.startNextTurn(B);
		store.createThread(C, newThread({ owner: "bob" }));
		store.startNextTurn(C);
		tick();
		store.completeTurn(A, 1, result({ usage: usage(0.5) }));
		store.completeTurn(B, 1, result({ usage: null }));
		store.completeTurn(C, 1, result({ usage: usage(9) }));
		tick(DAY);
		store.enqueueTurn(A, "again", "owner");
		store.startNextTurn(A);
		store.enqueueTurn(B, "again", "owner");
		store.startNextTurn(B);
		tick();
		store.completeTurn(A, 2, result({ usage: usage(1.25, 10) }));
		store.completeTurn(B, 2, result({ usage: usage(0.25, 100) }));
	}

	test("sums the owner's turns in total, per thread (dearest first) and per UTC day", () => {
		seed();
		expect(store.spend("owner", iso(0))).toEqual({
			total: { inputTokens: 111, outputTokens: 222, cacheReadTokens: 333, cacheWriteTokens: 444, cost: 2 },
			threads: [
				{ thread: A, title: "fix the bug", name: "", cost: 1.75, turns: 2 },
				{ thread: B, title: "other", name: "", cost: 0.25, turns: 1 },
			],
			days: [
				{ day: "2026-01-01", cost: 0.5 },
				{ day: "2026-01-02", cost: 1.5 },
			],
		});
	});

	test("counts only turns completed at or after since", () => {
		seed();
		const spend = store.spend("owner", iso(DAY));
		expect(spend.total.cost).toBe(1.5);
		expect(spend.threads).toEqual([
			{ thread: A, title: "fix the bug", name: "", cost: 1.25, turns: 1 },
			{ thread: B, title: "other", name: "", cost: 0.25, turns: 1 },
		]);
		expect(spend.days).toEqual([{ day: "2026-01-02", cost: 1.5 }]);
	});

	test("another owner's spend, and a window with nothing in it, are zero", () => {
		seed();
		expect(store.spend("bob", iso(0)).total.cost).toBe(9);
		expect(store.spend("nobody", iso(0))).toEqual({ total: usage(0, 0), threads: [], days: [] });
		expect(store.spend("owner", iso(10 * DAY))).toEqual({ total: usage(0, 0), threads: [], days: [] });
	});

	test("a deleted thread's turns no longer count", async () => {
		seed();
		await store.deleteThread(A);
		expect(store.spend("owner", iso(0)).threads.map((t) => t.thread)).toEqual([B]);
	});

	test("daySpend adds each completed turn's cost to the owner's row of its UTC day, nobody else's", () => {
		seed();
		expect(store.daySpend("owner", "2026-01-01")).toBe(0.5);
		expect(store.daySpend("owner", "2026-01-02")).toBe(1.5);
		expect(store.daySpend("bob", "2026-01-01")).toBe(9);
		expect(store.daySpend("bob", "2026-01-02")).toBe(0);
		expect(store.daySpend("nobody", "2026-01-01")).toBe(0);
	});

	test("a turn without cost, or with a cost of 0, adds nothing; a failed turn's cost counts", () => {
		store.createThread(A, newThread());
		store.startNextTurn(A);
		store.completeTurn(A, 1, result({ usage: usage(0) }));
		expect(store.daySpend("owner", "2026-01-01")).toBe(0);
		store.enqueueTurn(A, "again", "owner");
		store.startNextTurn(A);
		store.completeTurn(A, 2, result({ outcome: "failed", error: "boom", usage: usage(0.75) }));
		expect(store.daySpend("owner", "2026-01-01")).toBe(0.75);
	});

	test("deleting a thread keeps the day totals", async () => {
		seed();
		await store.deleteThread(A);
		await store.deleteThread(B);
		expect(store.spend("owner", iso(0)).total.cost).toBe(0);
		expect(store.daySpend("owner", "2026-01-01")).toBe(0.5);
		expect(store.daySpend("owner", "2026-01-02")).toBe(1.5);
	});

	test("the totals survive a restart", () => {
		seed();
		store.close();
		store = open();
		expect(store.daySpend("owner", "2026-01-02")).toBe(1.5);
	});
});

describe("serviceId", () => {
	test("is 12 characters of [a-z0-9], stable across reopen and different per data directory", async () => {
		const id = store.serviceId();
		expect(id).toMatch(/^[a-z0-9]{12}$/);
		expect(store.serviceId()).toBe(id);
		store.close();
		store = open();
		expect(store.serviceId()).toBe(id);

		const other = await mkdtemp(join(tmpdir(), "omp-cloud-"));
		const second = Store.open({ dataDir: other });
		try {
			expect(second.serviceId()).toMatch(/^[a-z0-9]{12}$/);
			expect(second.serviceId()).not.toBe(id);
		} finally {
			second.close();
			await rm(other, { recursive: true, force: true });
		}
	});
});

describe("VM records", () => {
	const vm = (threadId = ID, over: Partial<Omit<VmRecord, "updatedAt" | "threadId">> = {}) => ({
		threadId,
		sandboxId: "sbx-1",
		state: "running" as const,
		pid: 100,
		sessionFile: "/home/user/.omp/s.jsonl",
		...over,
	});

	test("put, read, replace and remove, with updatedAt from the clock", () => {
		store.createThread(ID, newThread());
		expect(store.vm(ID)).toBeNull();
		tick();
		expect(store.putVm(vm())).toEqual({ ...vm(), updatedAt: iso(1000) });
		expect(store.vm(ID)).toEqual({ ...vm(), updatedAt: iso(1000) });
		tick();
		store.putVm(vm(ID, { state: "paused", pid: null, sessionFile: null }));
		expect(store.vm(ID)).toEqual({ threadId: ID, sandboxId: "sbx-1", state: "paused", pid: null, sessionFile: null, updatedAt: iso(2000) });
		expect(store.vms()).toHaveLength(1);
		store.removeVm(ID);
		expect(store.vm(ID)).toBeNull();
		expect(store.vms()).toEqual([]);
		store.removeVm(ID);
	});

	test("putVm throws for an unknown thread and stores nothing", () => {
		expect(() => store.putVm(vm("bbbbbbbbbbbb"))).toThrow("unknown thread");
		expect(store.vms()).toEqual([]);
	});

	test("a record survives deleteThread and a restart until removeVm", async () => {
		store.createThread(ID, newThread());
		store.putVm(vm());
		await store.deleteThread(ID);
		expect(store.vm(ID)).toMatchObject({ sandboxId: "sbx-1", state: "running" });
		expect(store.vms().map((r) => r.threadId)).toEqual([ID]);
		store.close();
		store = open();
		expect(store.vms().map((r) => r.threadId)).toEqual([ID]);
		store.removeVm(ID);
		expect(store.vms()).toEqual([]);
	});

	test("countVms counts the owner's live threads' records by state", async () => {
		const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"];
		const [a, b, c, d, e, f] = ids as [string, string, string, string, string, string];
		for (const id of ids) store.createThread(id, newThread({ owner: id === d ? "bob" : "owner" }));
		store.putVm(vm(a, { state: "running" }));
		store.putVm(vm(b, { state: "paused" }));
		store.putVm(vm(c, { state: "paused" }));
		store.putVm(vm(d, { state: "running" }));
		store.putVm(vm(e, { state: "running" }));
		store.failThread(f, "lost"); // a failed thread is still live
		store.putVm(vm(f, { state: "paused" }));
		await store.deleteThread(e);
		expect(store.countVms("owner")).toEqual({ running: 1, paused: 3 });
		expect(store.countVms("bob")).toEqual({ running: 1, paused: 0 });
		expect(store.countVms("nobody")).toEqual({ running: 0, paused: 0 });
	});
});

describe("names, context and metrics", () => {
	const usage = (cost: number, n = 1) => ({ inputTokens: n, outputTokens: 2 * n, cacheReadTokens: 3 * n, cacheWriteTokens: 4 * n, cost });

	test("createThread stores the name, empty when none is given", () => {
		expect(store.createThread(ID, newThread({ name: "Fix login bug" })).thread.name).toBe("Fix login bug");
		expect(store.createThread("bbbbbbbbbbbb", newThread()).thread.name).toBe("");
		store.close();
		store = open();
		expect(store.getThread(ID)?.name).toBe("Fix login bug");
	});

	test("a new thread has no archive state, restore head or context", () => {
		const { thread, turn } = store.createThread(ID, newThread());
		expect(thread).toMatchObject({ archivedAt: null, restoreHead: "", context: null });
		expect(turn).toMatchObject({ requests: 0, tools: 0, context: null });
	});

	test("completeTurn stores the turn's requests, tools and context; omitted they are 0, 0 and null", () => {
		running();
		tick();
		const done = store.completeTurn(ID, 1, result({ requests: 4, tools: 9, context: { tokens: 19_000, window: 200_000 } }));
		expect(done).toMatchObject({ requests: 4, tools: 9, context: { tokens: 19_000, window: 200_000 } });
		store.enqueueTurn(ID, "two", "alice");
		store.startNextTurn(ID);
		expect(store.completeTurn(ID, 2, result())).toMatchObject({ requests: 0, tools: 0, context: null });
		store.enqueueTurn(ID, "three", "alice");
		store.startNextTurn(ID);
		expect(store.completeTurn(ID, 3, result({ context: { tokens: 5, window: 0 } })).context).toEqual({ tokens: 5, window: 0 });
		store.close();
		store = open();
		expect(store.turns(ID).map((t) => [t.requests, t.tools, t.context])).toEqual([
			[4, 9, { tokens: 19_000, window: 200_000 }],
			[0, 0, null],
			[0, 0, { tokens: 5, window: 0 }],
		]);
	});

	test("setThreadContext records the latest context without an event or a lastActivityAt change", () => {
		running();
		const events = kinds();
		tick();
		store.setThreadContext(ID, { tokens: 1200, window: 200_000, at: iso(1000) });
		expect(store.getThread(ID)?.context).toEqual({ tokens: 1200, window: 200_000, at: iso(1000) });
		tick();
		store.setThreadContext(ID, { tokens: 3400, window: 0, at: iso(2000) });
		expect(store.getThread(ID)?.context).toEqual({ tokens: 3400, window: 0, at: iso(2000) });
		expect(kinds()).toEqual(events);
		expect(store.getThread(ID)?.lastActivityAt).toBe(iso(0));
		expect(store.threadStats(ID).metrics.context).toEqual({ tokens: 3400, window: 0, at: iso(2000) });
	});

	test("setThreadContext does nothing for an unknown or deleted thread", async () => {
		store.setThreadContext("bbbbbbbbbbbb", { tokens: 1, window: 1, at: iso(0) });
		expect(store.getThread("bbbbbbbbbbbb")).toBeNull();
		store.createThread(ID, newThread());
		await store.deleteThread(ID);
		store.setThreadContext(ID, { tokens: 1, window: 1, at: iso(0) });
		expect(store.getThread(ID)).toBeNull();
	});

	test("metrics sum usage, requests, tools and the work time of finished turns", () => {
		store.createThread(ID, newThread());
		expect(store.threadStats(ID).metrics).toEqual({
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
			requests: 0,
			tools: 0,
			workMs: 0,
			context: null,
			turns: [],
		});
		tick();
		store.startNextTurn(ID);
		tick(4000);
		store.completeTurn(ID, 1, result({ usage: usage(0.5), requests: 2, tools: 5, context: { tokens: 10, window: 100 } }));
		store.enqueueTurn(ID, "two", "alice");
		tick();
		store.startNextTurn(ID);
		tick(2500);
		store.completeTurn(ID, 2, result({ outcome: "failed", error: "x", usage: null, requests: 1, tools: 1 }));
		store.enqueueTurn(ID, "three", "alice");
		tick();
		store.startNextTurn(ID);
		tick(60_000);
		const metrics = store.threadStats(ID).metrics;
		expect(metrics.usage).toEqual(usage(0.5));
		expect(metrics.requests).toBe(3);
		expect(metrics.tools).toBe(6);
		// The running third turn is not finished: its time is not counted.
		expect(metrics.workMs).toBe(6500);
		expect(metrics.turns).toEqual([
			{ n: 1, cost: 0.5, contextTokens: 10 },
			{ n: 2, cost: 0, contextTokens: null },
		]);
	});

	test("metrics.turns holds the last 12 finished turns, oldest first", () => {
		running();
		for (let n = 1; n <= 14; n++) {
			if (n > 1) {
				store.enqueueTurn(ID, `turn ${n}`, "alice");
				store.startNextTurn(ID);
			}
			tick();
			store.completeTurn(ID, n, result({ usage: usage(n), context: { tokens: n * 100, window: 1000 } }));
		}
		const turns = store.threadStats(ID).metrics.turns;
		expect(turns).toHaveLength(12);
		expect(turns[0]).toEqual({ n: 3, cost: 3, contextTokens: 300 });
		expect(turns[11]).toEqual({ n: 14, cost: 14, contextTokens: 1400 });
	});

	test("activity is the running turn's latest tool or assistant event, null otherwise", () => {
		running();
		expect(store.threadStats(ID).activity).toBeNull();
		tick();
		store.appendEvent(ID, "tool", "read src/a.ts", 1);
		tick();
		store.appendEvent(ID, "notice", "retry 1/3", 1);
		tick();
		store.appendEvent(ID, "tool_error", "bash: exit 2", 1);
		expect(store.threadStats(ID).activity).toEqual({ kind: "tool", text: "read src/a.ts", at: iso(1000) });
		tick();
		store.appendEvent(ID, "assistant", "Looking at it", 1);
		expect(store.threadStats(ID).activity).toEqual({ kind: "assistant", text: "Looking at it", at: iso(4000) });
		tick();
		store.completeTurn(ID, 1, result());
		expect(store.threadStats(ID).activity).toBeNull();
	});

	test("activity ignores events of earlier turns", () => {
		running();
		store.appendEvent(ID, "tool", "old", 1);
		store.completeTurn(ID, 1, result());
		store.enqueueTurn(ID, "two", "alice");
		store.startNextTurn(ID);
		expect(store.threadStats(ID).activity).toBeNull();
	});

	test("spend rows carry the thread's name", () => {
		store.createThread(ID, newThread({ name: "Fix login" }));
		store.startNextTurn(ID);
		store.completeTurn(ID, 1, result({ usage: usage(1) }));
		expect(store.spend("owner", iso(0)).threads).toEqual([{ thread: ID, title: "fix the bug", name: "Fix login", cost: 1, turns: 1 }]);
	});
});

describe("archive lifecycle", () => {
	const A = "aaaaaaaaaaaa";
	const B = "bbbbbbbbbbbb";
	const vm = (threadId: string) => ({ threadId, sandboxId: `sbx-${threadId}`, state: "running" as const, pid: 1, sessionFile: null });

	/** An idle thread whose last activity is `at` ms after T0 and that holds a VM record. */
	function idle(id: string, at: number): void {
		clock = T0 + at;
		store.createThread(id, newThread());
		store.startNextTurn(id);
		store.completeTurn(id, 1, result());
		store.putVm(vm(id));
	}

	test("an idle thread with a VM and activity before the cutoff is a candidate; the oldest activity comes first", () => {
		idle(A, 2000);
		idle(B, 1000);
		expect(store.archiveCandidates(iso(5000))).toEqual([B, A]);
	});

	test("the cutoff is exclusive: activity at the cutoff or later is not a candidate", () => {
		idle(A, 5000);
		idle(B, 4999);
		expect(store.archiveCandidates(iso(5000))).toEqual([B]);
		expect(store.archiveCandidates(iso(4999))).toEqual([]);
	});

	test("a failed thread is not a candidate", () => {
		idle(A, 0);
		store.failThread(A, "lost");
		expect(store.archiveCandidates(iso(5000))).toEqual([]);
	});

	test("a deleted thread is not a candidate, although its VM record stays", async () => {
		idle(A, 0);
		await store.deleteThread(A);
		expect(store.vm(A)).not.toBeNull();
		expect(store.archiveCandidates(iso(5000))).toEqual([]);
	});

	test("a working, a waiting and a queued thread are not candidates", () => {
		clock = T0;
		store.createThread(A, newThread());
		store.startNextTurn(A);
		store.putVm(vm(A));
		store.createThread(B, newThread());
		store.startNextTurn(B);
		store.askQuestions(B, 1, [question()], null);
		store.putVm(vm(B));
		const queued = "cccccccccccc";
		store.createThread(queued, newThread());
		store.putVm(vm(queued));
		expect(store.getThread(A)?.phase).toBe("working");
		expect(store.getThread(B)?.phase).toBe("waiting");
		expect(store.getThread(queued)?.phase).toBe("starting");
		expect(store.archiveCandidates(iso(5000))).toEqual([]);
	});

	test("a thread without a VM record is not a candidate", () => {
		idle(A, 0);
		store.removeVm(A);
		expect(store.archiveCandidates(iso(5000))).toEqual([]);
	});

	test("an archived thread is not a candidate again", () => {
		idle(A, 0);
		store.markArchived(A, iso(6000), "");
		expect(store.archiveCandidates(iso(5000))).toEqual([]);
	});

	test("a thread with recent activity is not a candidate, and a new message makes it active", () => {
		idle(A, 0);
		expect(store.archiveCandidates(iso(5000))).toEqual([A]);
		clock = T0 + 9000;
		store.enqueueTurn(A, "again", "alice");
		expect(store.archiveCandidates(iso(5000))).toEqual([]);
	});

	test("markArchived sets archivedAt and a non-empty restore head, and keeps lastActivityAt and the event log", () => {
		idle(A, 1000);
		const events = kinds(A);
		clock = T0 + 9000;
		store.markArchived(A, iso(9000), "snap1");
		expect(store.getThread(A)).toMatchObject({ archivedAt: iso(9000), restoreHead: "snap1", lastActivityAt: iso(1000) });
		store.markArchived(A, iso(9500), "");
		expect(store.getThread(A)).toMatchObject({ archivedAt: iso(9500), restoreHead: "snap1" });
		expect(kinds(A)).toEqual(events);
		store.close();
		store = open();
		expect(store.getThread(A)).toMatchObject({ archivedAt: iso(9500), restoreHead: "snap1" });
	});

	test("completeTurn clears the restore head: a newer turn head supersedes the snapshot", () => {
		idle(A, 1000);
		store.markArchived(A, iso(2000), "snap1");
		store.enqueueTurn(A, "again", "alice");
		store.startNextTurn(A);
		expect(store.getThread(A)?.restoreHead).toBe("snap1");
		store.completeTurn(A, 2, result({ head: "h2" }));
		expect(store.getThread(A)?.restoreHead).toBe("");
	});

	test("completeTurn clears the restore head also for a failed turn", () => {
		idle(A, 1000);
		store.markArchived(A, iso(2000), "snap1");
		store.enqueueTurn(A, "again", "alice");
		store.startNextTurn(A);
		store.completeTurn(A, 2, result({ outcome: "failed", error: "x" }));
		expect(store.getThread(A)?.restoreHead).toBe("");
	});

	test("putVm clears archivedAt when it inserts a record for a thread that had none, not when it replaces one", () => {
		idle(A, 1000);
		store.markArchived(A, iso(2000), "snap1");
		store.removeVm(A);
		store.putVm(vm(A));
		expect(store.getThread(A)?.archivedAt).toBeNull();
		// The restore head stays: the restore reads it, and only a completed turn clears it.
		expect(store.getThread(A)?.restoreHead).toBe("snap1");

		store.markArchived(A, iso(3000), "");
		store.putVm({ ...vm(A), state: "paused" });
		expect(store.getThread(A)?.archivedAt).toBe(iso(3000));
	});
});

describe("migration 9", () => {
	test("a version 8 database keeps its threads and turns and gains names, archive state and metrics with their defaults", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 8)) raw.run(migration);
		raw.run("PRAGMA user_version = 8");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'idle', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw
			.query(
				`INSERT INTO turns (thread_id, id, state, text, sent_by, queued_at, started_at, completed_at, head)
				VALUES (?, 1, 'done', 'hi', 'owner', ?, ?, ?, 'abc')`,
			)
			.run(ID, iso(0), iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.getThread(ID)).toMatchObject({ name: "", archivedAt: null, restoreHead: "", context: null });
		expect(store.turns(ID)[0]).toMatchObject({ head: "abc", requests: 0, tools: 0, context: null });
		store.setThreadContext(ID, { tokens: 7, window: 70, at: iso(5) });
		expect(store.threadStats(ID).metrics.context).toEqual({ tokens: 7, window: 70, at: iso(5) });

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(9);
		check.close();
		store = open();
	});
});

describe("migration 11", () => {
	test("a version 10 database keeps its turns, which gain an empty origin, and gets working IRC tables", async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
		await mkdir(join(dir, "threads"), { recursive: true });
		const raw = new Database(join(dir, "omp-cloud.db"));
		for (const migration of MIGRATIONS.slice(0, 10)) raw.run(migration);
		raw.run("PRAGMA user_version = 10");
		raw
			.query(
				`INSERT INTO threads (id, owner, phase, title, model, thinking, repo_name, repo_remote_url, repo_base_ref, repo_base_commit,
					repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email, secret_files, secret_env, created_at, last_activity_at)
				VALUES (?, 'owner', 'idle', 'old', 'm', '', 'repo', '', '', '', 'def', '', '', '', '', '', '[]', '[]', ?, ?)`,
			)
			.run(ID, iso(0), iso(0));
		raw
			.query(
				`INSERT INTO turns (thread_id, id, state, text, sent_by, queued_at, started_at, completed_at, head)
				VALUES (?, 1, 'done', 'hi', 'owner', ?, ?, ?, 'abc')`,
			)
			.run(ID, iso(0), iso(0), iso(0));
		raw.close();

		store = open();
		expect(store.turns(ID)[0]).toMatchObject({ head: "abc", origin: "", ircFrom: "", ircId: "", ircReplyTo: "" });
		expect(store.sendIrc(ID, { id: "m1", from: "alice", body: "hello", replyTo: "" })).toMatchObject({
			receipt: "woken",
			turn: { id: 2, origin: "irc", ircId: "m1" },
		});
		expect(store.appendIrcEvent(ID, null, { id: "o1", from: "agent", to: "alice", body: "hi", replyTo: "" })?.kind).toBe("irc");

		store.close();
		const check = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(11);
		check.close();
		store = open();
	});
});

describe("IRC", () => {
	type IrcInput = Parameters<Store["sendIrc"]>[1];
	const msg = (id: string, over: Partial<IrcInput> = {}): IrcInput => ({ id, from: "alice", body: `body of ${id}`, replyTo: "", ...over });
	const payloadOf = (event: ThreadEvent): IrcPayload => JSON.parse(event.text) as IrcPayload;
	const seqNow = (id = ID): number => store.events(id, 0, 100_000).length;
	const since = (after: number, id = ID): ThreadEvent[] => store.events(id, after, 100_000);
	const kindsOf = (events: ThreadEvent[]): string[] => events.map((e) => e.kind);
	/** The thread with its first turn done. */
	const idle = (): void => {
		running();
		store.completeTurn(ID, 1, result());
	};
	/** Queues turns until the thread holds `total`. */
	const fillTurns = (total: number): void => {
		for (let i = store.turns(ID).length + 1; i <= total; i++) store.enqueueTurn(ID, "t", "alice");
	};
	/** The inbox rows and seen ids as the database holds them, read through a second connection. */
	const tables = (threadId = ID): { inbox: { id: string; turn_id: number; state: string }[]; seen: string[] } => {
		const raw = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		try {
			return {
				inbox: raw.query<{ id: string; turn_id: number; state: string }, [string]>("SELECT id, turn_id, state FROM irc_inbox WHERE thread_id = ? ORDER BY rowid").all(threadId),
				seen: raw.query<{ id: string }, [string]>("SELECT id FROM irc_seen WHERE thread_id = ? ORDER BY id").all(threadId).map((row) => row.id),
			};
		} finally {
			raw.close();
		}
	};

	describe("sendIrc receipts", () => {
		test("a running turn takes the message as pending: injected, no turn, an irc_in event on that turn", () => {
			running();
			tick();
			const heard = record();
			store.subscribe(ID, heard.listener);
			const before = seqNow();
			const sent = store.sendIrc(ID, msg("m1", { replyTo: "r1" }));
			expect(sent).toEqual({ receipt: "injected", id: "m1", turn: null });
			expect(store.turns(ID)).toHaveLength(1);
			expect(store.pendingIrc(ID, 1)).toEqual([{ id: "m1", turn: 1, from: "alice", body: "body of m1", replyTo: "r1", at: iso(1000), state: "pending" }]);
			const events = since(before);
			expect(kindsOf(events)).toEqual(["irc_in"]);
			expect(events[0]).toMatchObject({ turn: 1, at: iso(1000) });
			expect(heard.seen).toEqual(events);
		});

		test("an idle thread wakes with a new queued turn: turn_queued, then irc_in on that turn", () => {
			idle();
			tick(2000);
			const before = seqNow();
			const sent = store.sendIrc(ID, msg("m1", { from: "bob", replyTo: "r1" }));
			expect(sent.receipt).toBe("woken");
			expect(sent.id).toBe("m1");
			expect(sent.turn).toEqual(store.turns(ID)[1] ?? null);
			const events = since(before);
			expect(kindsOf(events)).toEqual(["turn_queued", "irc_in"]);
			expect(events.map((e) => e.turn)).toEqual([2, 2]);
			expect(events[0]?.text).toBe("queued by bob");
			expect(store.pendingIrc(ID, 1)).toEqual([]);
			expect(tables().inbox).toEqual([]);
		});

		test("a thread with only a queued turn wakes too, and the irc turn queues behind it", () => {
			store.createThread(ID, newThread());
			const sent = store.sendIrc(ID, msg("m1"));
			expect(sent.receipt).toBe("woken");
			expect(sent.turn?.id).toBe(2);
			expect(store.turns(ID).map((t) => [t.id, t.state, t.origin])).toEqual([
				[1, "queued", ""],
				[2, "queued", "irc"],
			]);
		});

		test("an archived thread is revived", () => {
			idle();
			store.markArchived(ID, iso(1500), "snap1");
			tick(3000);
			const before = seqNow();
			const sent = store.sendIrc(ID, msg("m1"));
			expect(sent.receipt).toBe("revived");
			expect(sent.turn).toMatchObject({ id: 2, state: "queued", origin: "irc", by: "alice" });
			expect(kindsOf(since(before))).toEqual(["turn_queued", "irc_in"]);
		});

		test("a running turn that is being stopped does not take it: woken as a new turn, nothing pending", () => {
			running();
			store.stopThread(ID, "bob");
			expect(store.turns(ID)[0]?.stopRequested).toBe(true);
			const before = seqNow();
			const sent = store.sendIrc(ID, msg("m1"));
			expect(sent.receipt).toBe("woken");
			expect(sent.turn).toMatchObject({ id: 2, state: "queued", origin: "irc" });
			expect(store.pendingIrc(ID, 1)).toEqual([]);
			expect(tables().inbox).toEqual([]);
			const events = since(before);
			expect(kindsOf(events)).toEqual(["turn_queued", "irc_in"]);
			expect(events[1]?.turn).toBe(2);
		});

		test("a full thread still injects into its running turn", () => {
			running();
			fillTurns(MAX_TURNS);
			expect(store.sendIrc(ID, msg("m1"))).toEqual({ receipt: "injected", id: "m1", turn: null });
			expect(store.turns(ID)).toHaveLength(MAX_TURNS);
		});
	});

	describe("the turn sendIrc creates", () => {
		test("is queued with origin irc, the sender as by and ircFrom, the body as text and the ids", () => {
			idle();
			tick(5000);
			const { turn } = store.sendIrc(ID, msg("m-1.x_y", { from: "Peer.One", body: "hello there", replyTo: "agent-9" }));
			expect(turn).toMatchObject({
				id: 2,
				state: "queued",
				text: "hello there",
				by: "Peer.One",
				origin: "irc",
				ircFrom: "Peer.One",
				ircId: "m-1.x_y",
				ircReplyTo: "agent-9",
				queuedAt: iso(5000),
				startedAt: null,
				stopRequested: false,
			});
			expect(turn).toEqual(store.turns(ID)[1] ?? null);
			// An ordinary turn carries no irc fields.
			expect(store.turns(ID)[0]).toMatchObject({ origin: "", ircFrom: "", ircId: "", ircReplyTo: "" });
			expect(store.enqueueTurn(ID, "plain", "alice")).toMatchObject({ origin: "", ircFrom: "", ircId: "", ircReplyTo: "" });
		});

		test("a missing replyTo is empty, and the irc turn starts and completes like any other", () => {
			idle();
			const { turn } = store.sendIrc(ID, msg("m1"));
			expect(turn?.ircReplyTo).toBe("");
			expect(store.startNextTurn(ID)).toMatchObject({ id: 2, state: "running", origin: "irc", ircFrom: "alice", ircId: "m1" });
			expect(store.completeTurn(ID, 2, result())).toMatchObject({ state: "done", origin: "irc", ircId: "m1" });
		});
	});

	describe("a repeated id", () => {
		test("into a running turn answers injected again without a second row, event or turn", () => {
			running();
			store.sendIrc(ID, msg("m1"));
			const before = seqNow();
			const again = store.sendIrc(ID, msg("m1", { body: "another body", from: "mallory" }));
			expect(again).toEqual({ receipt: "injected", id: "m1", turn: null });
			expect(seqNow()).toBe(before);
			expect(store.turns(ID)).toHaveLength(1);
			expect(store.pendingIrc(ID, 1).map((m) => [m.id, m.from, m.body])).toEqual([["m1", "alice", "body of m1"]]);
			// Still the same once omp was handed the message.
			store.markIrcSent(ID, "m1");
			expect(store.sendIrc(ID, msg("m1"))).toEqual({ receipt: "injected", id: "m1", turn: null });
			expect(seqNow()).toBe(before);
			expect(tables().inbox).toEqual([{ id: "m1", turn_id: 1, state: "sent" }]);
		});

		test("that woke the thread answers woken with the same turn and adds nothing", () => {
			idle();
			const first = store.sendIrc(ID, msg("m1"));
			const before = seqNow();
			const again = store.sendIrc(ID, msg("m1", { body: "another body" }));
			expect(again.receipt).toBe("woken");
			expect(again.turn).toEqual(first.turn);
			expect(again.turn?.text).toBe("body of m1");
			expect(seqNow()).toBe(before);
			expect(store.turns(ID)).toHaveLength(2);
		});

		test("whose message was spilled into a turn answers woken with that turn, not a duplicate", () => {
			running();
			store.sendIrc(ID, msg("m1"));
			store.completeTurn(ID, 1, result());
			expect(store.turns(ID)).toHaveLength(2);
			const before = seqNow();
			const again = store.sendIrc(ID, msg("m1"));
			expect(again).toMatchObject({ receipt: "woken", turn: { id: 2, ircId: "m1" } });
			expect(store.turns(ID)).toHaveLength(2);
			expect(seqNow()).toBe(before);
		});

		test("is per thread: another thread takes the same id", () => {
			running();
			store.createThread("bbbbbbbbbbbb", newThread());
			store.startNextTurn("bbbbbbbbbbbb");
			expect(store.sendIrc(ID, msg("m1")).receipt).toBe("injected");
			expect(store.sendIrc("bbbbbbbbbbbb", msg("m1")).receipt).toBe("injected");
			expect(store.pendingIrc("bbbbbbbbbbbb", 1)).toHaveLength(1);
		});
	});

	describe("validation", () => {
		test("an id, sender or replyTo outside 1 to 64 of [A-Za-z0-9._-] is invalid_irc and stores nothing", () => {
			running();
			const before = store.events(ID, 0, 1000);
			const bad = ["", "a b", "a/b", "über", "x".repeat(65), "ok\n", ":colon"];
			for (const value of bad) {
				expect(codeOf(() => store.sendIrc(ID, msg("m1", { id: value })))).toBe("invalid_irc");
				expect(codeOf(() => store.sendIrc(ID, msg("m1", { from: value })))).toBe("invalid_irc");
				if (value !== "") expect(codeOf(() => store.sendIrc(ID, msg("m1", { replyTo: value })))).toBe("invalid_irc");
			}
			expect(store.events(ID, 0, 1000)).toEqual(before);
			expect(store.turns(ID)).toHaveLength(1);
			expect(tables().inbox).toEqual([]);
		});

		test("the edge values are accepted: 64-character names and an empty replyTo", () => {
			running();
			const name = "A9._-".repeat(12) + "abcd";
			expect(name).toHaveLength(64);
			expect(store.sendIrc(ID, { id: name, from: name, body: "x", replyTo: name }).receipt).toBe("injected");
			expect(store.sendIrc(ID, msg("m2", { replyTo: "" })).receipt).toBe("injected");
		});

		test("an empty body or one over MAX_TEXT_BYTES bytes is invalid_text; exactly MAX_TEXT_BYTES is fine", () => {
			running();
			expect(codeOf(() => store.sendIrc(ID, msg("m1", { body: "" })))).toBe("invalid_text");
			expect(codeOf(() => store.sendIrc(ID, msg("m1", { body: "a".repeat(MAX_TEXT_BYTES + 1) })))).toBe("invalid_text");
			// Characters count by UTF-8 bytes: 16385 two-byte characters are 32770 bytes.
			expect(codeOf(() => store.sendIrc(ID, msg("m1", { body: "é".repeat(MAX_TEXT_BYTES / 2 + 1) })))).toBe("invalid_text");
			expect(tables().inbox).toEqual([]);
			expect(store.sendIrc(ID, msg("m1", { body: "é".repeat(MAX_TEXT_BYTES / 2) })).receipt).toBe("injected");
			expect(store.sendIrc(ID, msg("m2", { body: "a".repeat(MAX_TEXT_BYTES) })).receipt).toBe("injected");
		});

		test("a failed thread is thread_failed", () => {
			running();
			store.failThread(ID, "vm lost");
			const before = seqNow();
			expect(codeOf(() => store.sendIrc(ID, msg("m1")))).toBe("thread_failed");
			expect(seqNow()).toBe(before);
			expect(tables().inbox).toEqual([]);
		});

		test("a thread that holds MAX_TURNS turns and runs none is thread_full, and nothing is written", () => {
			idle();
			fillTurns(MAX_TURNS);
			expect(store.turns(ID)).toHaveLength(MAX_TURNS);
			const before = store.events(ID, 0, 100_000);
			expect(codeOf(() => store.sendIrc(ID, msg("m1")))).toBe("thread_full");
			expect(store.turns(ID)).toHaveLength(MAX_TURNS);
			expect(store.events(ID, 0, 100_000)).toEqual(before);
		});

		test("an unknown or deleted thread is thread_not_found", async () => {
			expect(codeOf(() => store.sendIrc("bbbbbbbbbbbb", msg("m1")))).toBe("thread_not_found");
			store.createThread(ID, newThread());
			await store.deleteThread(ID);
			expect(codeOf(() => store.sendIrc(ID, msg("m1")))).toBe("thread_not_found");
		});
	});

	describe("the irc_in event", () => {
		test("its text is the message as JSON with an empty to and the event time, on the running turn", () => {
			running();
			tick(4000);
			const before = seqNow();
			store.sendIrc(ID, msg("m1", { from: "peer", body: "hi\nthere", replyTo: "r0" }));
			const [event] = since(before);
			expect(event).toMatchObject({ kind: "irc_in", turn: 1, at: iso(4000) });
			expect(payloadOf(event as ThreadEvent)).toEqual({ id: "m1", from: "peer", to: "", body: "hi\nthere", replyTo: "r0", at: iso(4000) });
		});

		test("a woken message's event is on the new turn", () => {
			idle();
			tick();
			const before = seqNow();
			store.sendIrc(ID, msg("m1"));
			const irc = since(before).find((e) => e.kind === "irc_in");
			expect(irc?.turn).toBe(2);
			expect(payloadOf(irc as ThreadEvent)).toMatchObject({ id: "m1", from: "alice", to: "", body: "body of m1", replyTo: "" });
		});

		test("a 32 KiB body is not cut at 500 characters, injected or woken", () => {
			running();
			const body = "a".repeat(MAX_TEXT_BYTES);
			const before = seqNow();
			store.sendIrc(ID, msg("m1", { body }));
			const [injected] = since(before);
			expect(injected?.text.length).toBeGreaterThan(MAX_TEXT_BYTES);
			expect(payloadOf(injected as ThreadEvent).body).toBe(body);
			expect(store.events(ID, (injected as ThreadEvent).seq - 1, 1)[0]).toEqual(injected);

			store.completeTurn(ID, 1, result());
			expect(store.turns(ID)).toHaveLength(2); // m1 spilled into a queued turn, so nothing runs when m2 arrives
			const woken = seqNow();
			store.sendIrc(ID, msg("m2", { body }));
			const irc = since(woken).find((e) => e.kind === "irc_in");
			expect(payloadOf(irc as ThreadEvent).body).toBe(body);
		});

		test("a body that JSON escapes heavily stays valid JSON at the size limit", () => {
			running();
			const body = '"\\\n\u0001\u2028😀'.repeat(Math.floor(MAX_TEXT_BYTES / 11));
			expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
			const before = seqNow();
			store.sendIrc(ID, msg("m1", { body }));
			const [event] = since(before);
			expect(payloadOf(event as ThreadEvent).body).toBe(body);
			const control = "\u0001".repeat(MAX_TEXT_BYTES);
			const next = seqNow();
			store.sendIrc(ID, msg("m2", { body: control }));
			const [second] = since(next);
			expect(second?.text.length).toBeGreaterThan(MAX_TEXT_BYTES * 6);
			expect(payloadOf(second as ThreadEvent).body).toBe(control);
		});
	});

	describe("appendIrcEvent", () => {
		const out = (over: Partial<Omit<IrcPayload, "at">> = {}): Omit<IrcPayload, "at"> => ({ id: "o1", from: "agent", to: "alice", body: "hello peer", replyTo: "m1", ...over });

		test("stores an irc event whose text is the message as JSON with the event time, on the given turn", () => {
			running();
			tick(3000);
			const heard = record();
			store.subscribe(ID, heard.listener);
			const event = store.appendIrcEvent(ID, 1, out());
			expect(event).toMatchObject({ kind: "irc", turn: 1, at: iso(3000) });
			expect(payloadOf(event as ThreadEvent)).toEqual({ id: "o1", from: "agent", to: "alice", body: "hello peer", replyTo: "m1", at: iso(3000) });
			expect(store.events(ID, (event as ThreadEvent).seq - 1, 1)).toEqual([event as ThreadEvent]);
			expect(heard.seen).toEqual([event as ThreadEvent]);
		});

		test("takes a null turn", () => {
			store.createThread(ID, newThread());
			const event = store.appendIrcEvent(ID, null, out());
			expect(event?.turn).toBeNull();
			expect(store.events(ID, (event as ThreadEvent).seq - 1, 1)[0]?.turn).toBeNull();
		});

		test("a repeated id returns null and adds no event, whatever the turn or body; another thread is independent", () => {
			running();
			store.createThread("bbbbbbbbbbbb", newThread());
			expect(store.appendIrcEvent(ID, 1, out())).not.toBeNull();
			const before = seqNow();
			const heard = record();
			store.subscribe(ID, heard.listener);
			expect(store.appendIrcEvent(ID, 1, out())).toBeNull();
			expect(store.appendIrcEvent(ID, null, out({ body: "changed" }))).toBeNull();
			expect(seqNow()).toBe(before);
			expect(heard.seen).toEqual([]);
			expect(tables().seen).toEqual(["o1"]);
			expect(store.appendIrcEvent("bbbbbbbbbbbb", null, out())).not.toBeNull();
			expect(store.appendIrcEvent(ID, 1, out({ id: "o2" }))).not.toBeNull();
		});

		test("an irc event does not clash with a peer's message of the same id", () => {
			running();
			store.sendIrc(ID, msg("same"));
			expect(store.appendIrcEvent(ID, 1, out({ id: "same" }))?.kind).toBe("irc");
		});

		test("seq stays gapless among irc, irc_in and ordinary events, and a dropped duplicate leaves no hole", () => {
			running();
			store.appendEvent(ID, "progress", "working", 1);
			store.appendIrcEvent(ID, 1, out({ id: "o1" }));
			store.sendIrc(ID, msg("m1"));
			store.appendIrcEvent(ID, 1, out({ id: "o1" }));
			store.appendIrcEvent(ID, 1, out({ id: "o2" }));
			store.sendIrc(ID, msg("m1"));
			store.appendEvent(ID, "progress", "more", 1);
			const all = store.events(ID, 0, 1000);
			expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
			expect(kindsOf(all).slice(-5)).toEqual(["progress", "irc", "irc_in", "irc", "progress"]);
		});

		test("a body is not cut at 500 characters, and the text is cut only at MAX_IRC_EVENT_CHARS", () => {
			running();
			const body = "b".repeat(MAX_TEXT_BYTES);
			const event = store.appendIrcEvent(ID, 1, out({ body }));
			expect(payloadOf(event as ThreadEvent).body).toBe(body);
			const huge = store.appendIrcEvent(ID, 1, out({ id: "o2", body: "x".repeat(MAX_IRC_EVENT_CHARS) }));
			expect(Array.from((huge as ThreadEvent).text)).toHaveLength(MAX_IRC_EVENT_CHARS);
			expect(() => JSON.parse((huge as ThreadEvent).text)).toThrow();
		});

		test("a body that needs JSON escaping is valid JSON at the size limit", () => {
			running();
			const body = '"\\\n\t\u0001\u2028😀'.repeat(Math.floor(MAX_TEXT_BYTES / 12));
			expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
			const event = store.appendIrcEvent(ID, 1, out({ body }));
			expect(payloadOf(event as ThreadEvent).body).toBe(body);
			const stored = store.events(ID, (event as ThreadEvent).seq - 1, 1)[0];
			expect(payloadOf(stored as ThreadEvent).body).toBe(body);
		});

		test("an unknown thread is thread_not_found", () => {
			expect(codeOf(() => store.appendIrcEvent(ID, null, out()))).toBe("thread_not_found");
		});
	});

	describe("pendingIrc and markIrcSent", () => {
		test("pendingIrc lists the running turn's unsent messages oldest first, in arrival order within one instant", () => {
			running();
			store.sendIrc(ID, msg("z", { from: "zed" }));
			store.sendIrc(ID, msg("a"));
			tick();
			store.sendIrc(ID, msg("m", { replyTo: "r" }));
			expect(store.pendingIrc(ID, 1).map((m) => [m.id, m.from, m.replyTo, m.at, m.state, m.turn])).toEqual([
				["z", "zed", "", iso(0), "pending", 1],
				["a", "alice", "", iso(0), "pending", 1],
				["m", "alice", "r", iso(1000), "pending", 1],
			]);
			expect(store.pendingIrc(ID, 2)).toEqual([]);
			expect(codeOf(() => store.pendingIrc("bbbbbbbbbbbb", 1))).toBe("thread_not_found");
		});

		test("markIrcSent hides the message from pendingIrc, keeps its row as sent, adds no event and is idempotent", () => {
			running();
			for (const id of ["a", "b", "c"]) store.sendIrc(ID, msg(id));
			const before = seqNow();
			store.markIrcSent(ID, "b");
			store.markIrcSent(ID, "b");
			store.markIrcSent(ID, "unknown");
			expect(store.pendingIrc(ID, 1).map((m) => m.id)).toEqual(["a", "c"]);
			expect(tables().inbox.map((r) => [r.id, r.state])).toEqual([["a", "pending"], ["b", "sent"], ["c", "pending"]]);
			expect(seqNow()).toBe(before);
		});

		test("markIrcSent only touches its own thread", () => {
			running();
			store.createThread("bbbbbbbbbbbb", newThread());
			store.startNextTurn("bbbbbbbbbbbb");
			store.sendIrc(ID, msg("m1"));
			store.sendIrc("bbbbbbbbbbbb", msg("m1"));
			store.markIrcSent(ID, "m1");
			expect(store.pendingIrc(ID, 1)).toEqual([]);
			expect(store.pendingIrc("bbbbbbbbbbbb", 1).map((m) => m.id)).toEqual(["m1"]);
		});

		test("pending and sent messages and seen ids survive close and reopen", () => {
			running();
			store.sendIrc(ID, msg("a"));
			store.sendIrc(ID, msg("b"));
			store.markIrcSent(ID, "b");
			store.appendIrcEvent(ID, 1, { id: "o1", from: "agent", to: "alice", body: "x", replyTo: "" });
			store.close();
			store = open();
			expect(store.pendingIrc(ID, 1).map((m) => m.id)).toEqual(["a"]);
			const before = seqNow();
			expect(store.sendIrc(ID, msg("a")).receipt).toBe("injected");
			expect(store.sendIrc(ID, msg("b")).receipt).toBe("injected");
			expect(store.appendIrcEvent(ID, 1, { id: "o1", from: "agent", to: "alice", body: "x", replyTo: "" })).toBeNull();
			expect(seqNow()).toBe(before);
		});
	});

	describe("completeTurn spilling pending messages", () => {
		test("each pending message becomes an irc turn in arrival order, with turn_queued events after turn_done; sent ones are not spilled", () => {
			running();
			store.sendIrc(ID, msg("z", { from: "zed", replyTo: "rz" }));
			store.sendIrc(ID, msg("a"));
			tick();
			store.sendIrc(ID, msg("s"));
			store.sendIrc(ID, msg("c", { from: "carol", body: "last one" }));
			store.markIrcSent(ID, "s");
			tick();
			const before = seqNow();
			store.completeTurn(ID, 1, result());

			const events = since(before);
			expect(kindsOf(events)).toEqual(["turn_done", "turn_queued", "turn_queued", "turn_queued"]);
			expect(events.map((e) => e.turn)).toEqual([1, 2, 3, 4]);
			expect(events[1]?.text).toBe("queued by zed");
			const turns = store.turns(ID);
			expect(turns.map((t) => [t.id, t.state, t.origin, t.by, t.ircFrom, t.ircId, t.ircReplyTo, t.text])).toEqual([
				[1, "done", "", "owner", "", "", "", "please fix the bug"],
				[2, "queued", "irc", "zed", "zed", "z", "rz", "body of z"],
				[3, "queued", "irc", "alice", "alice", "a", "", "body of a"],
				[4, "queued", "irc", "carol", "carol", "c", "", "last one"],
			]);
			expect(turns[1]?.queuedAt).toBe(iso(2000));
			// The spilled rows are gone, the sent one stays.
			expect(store.pendingIrc(ID, 1)).toEqual([]);
			expect(tables().inbox).toEqual([{ id: "s", turn_id: 1, state: "sent" }]);
			// A retry of a spilled id finds its turn; a retry of the sent one is still injected.
			expect(store.sendIrc(ID, msg("z")).turn?.id).toBe(2);
			expect(store.sendIrc(ID, msg("s")).receipt).toBe("injected");
			expect(store.turns(ID)).toHaveLength(4);
		});

		test("a failed turn spills too, after turn_failed", () => {
			running();
			store.sendIrc(ID, msg("m1"));
			const before = seqNow();
			store.completeTurn(ID, 1, result({ outcome: "failed", error: "boom" }));
			expect(kindsOf(since(before))).toEqual(["turn_failed", "turn_queued"]);
			expect(store.turns(ID)[1]).toMatchObject({ id: 2, state: "queued", origin: "irc", ircId: "m1" });
		});

		test("a turn without pending messages adds nothing beyond turn_done", () => {
			running();
			store.sendIrc(ID, msg("m1"));
			store.markIrcSent(ID, "m1");
			const before = seqNow();
			store.completeTurn(ID, 1, result());
			expect(kindsOf(since(before))).toEqual(["turn_done"]);
			expect(store.turns(ID)).toHaveLength(1);
		});

		test("a message the thread has no room for is dropped with a notice naming the sender; the ones that fit still spill", () => {
			running();
			fillTurns(MAX_TURNS - 1);
			store.sendIrc(ID, msg("a", { from: "alice" }));
			store.sendIrc(ID, msg("b", { from: "bobby" }));
			const before = seqNow();
			store.completeTurn(ID, 1, result());
			const events = since(before);
			expect(kindsOf(events)).toEqual(["turn_done", "turn_queued", "notice"]);
			expect(events[1]).toMatchObject({ turn: MAX_TURNS, text: "queued by alice" });
			expect(events[2]?.turn).toBe(1);
			expect(events[2]?.text).toContain("bobby");
			expect(events[2]?.text).toContain("dropped");
			expect(store.turns(ID)).toHaveLength(MAX_TURNS);
			expect(store.turns(ID)[MAX_TURNS - 1]).toMatchObject({ origin: "irc", ircId: "a" });
			expect(tables().inbox).toEqual([]);
		});

		test("a full thread drops the message with only a notice after turn_done", () => {
			running();
			fillTurns(MAX_TURNS);
			store.sendIrc(ID, msg("a"));
			const before = seqNow();
			store.completeTurn(ID, 1, result());
			const events = since(before);
			expect(kindsOf(events)).toEqual(["turn_done", "notice"]);
			expect(events[1]?.turn).toBe(1);
			expect(store.turns(ID)).toHaveLength(MAX_TURNS);
			expect(store.turns(ID).some((t) => t.origin === "irc")).toBe(false);
			expect(tables().inbox).toEqual([]);
		});
	});

	describe("stopping drops pending messages", () => {
		test("stopThread deletes the running turn's pending rows, emits one notice after stop_requested, and nothing spills later", () => {
			running();
			store.sendIrc(ID, msg("a"));
			store.sendIrc(ID, msg("b"));
			const before = seqNow();
			store.stopThread(ID, "bob");
			const events = since(before);
			expect(kindsOf(events)).toEqual(["stop_requested", "notice"]);
			expect(events[1]).toMatchObject({ turn: 1, text: "2 IRC messages not delivered: the turn was stopped" });
			expect(store.pendingIrc(ID, 1)).toEqual([]);
			expect(tables().inbox).toEqual([]);

			store.stopThread(ID, "bob");
			expect(kindsOf(since(before))).toEqual(["stop_requested", "notice"]);

			const done = seqNow();
			store.completeTurn(ID, 1, result({ outcome: "failed", error: "stopped by bob" }));
			expect(kindsOf(since(done))).toEqual(["turn_failed"]);
			expect(store.turns(ID)).toHaveLength(1);
		});

		test("a single dropped message is named in the singular, and messages already sent are not counted", () => {
			running();
			store.sendIrc(ID, msg("a"));
			store.sendIrc(ID, msg("b"));
			store.markIrcSent(ID, "a");
			const before = seqNow();
			store.stopThread(ID, "bob");
			expect(since(before)[1]).toMatchObject({ kind: "notice", text: "1 IRC message not delivered: the turn was stopped" });
			expect(tables().inbox).toEqual([{ id: "a", turn_id: 1, state: "sent" }]);
		});

		test("a stop with nothing pending emits no notice", () => {
			running();
			const before = seqNow();
			store.stopThread(ID, "bob");
			expect(kindsOf(since(before))).toEqual(["stop_requested"]);
		});

		test("interruptThread drops them too, and only the interrupting message becomes a turn", () => {
			running();
			store.sendIrc(ID, msg("a"));
			const before = seqNow();
			const { turn, interrupted } = store.interruptThread(ID, "change course", "bob");
			expect(interrupted).toBe(true);
			expect(turn).toMatchObject({ id: 2, by: "bob", origin: "" });
			expect(kindsOf(since(before))).toEqual(["stop_requested", "notice", "turn_queued"]);
			expect(since(before)[1]?.text).toBe("1 IRC message not delivered: the turn was stopped");
			expect(store.pendingIrc(ID, 1)).toEqual([]);
			store.completeTurn(ID, 1, result({ outcome: "failed", error: "stopped by bob" }));
			expect(store.turns(ID).map((t) => t.origin)).toEqual(["", ""]);
		});
	});

	describe("requeueRunningTurn", () => {
		test("leaves pending messages pending, and they are still there when the turn runs again and then spill on completion", () => {
			running();
			store.sendIrc(ID, msg("a"));
			store.sendIrc(ID, msg("b"));
			store.markIrcSent(ID, "b");
			expect(store.requeueRunningTurn(ID)).toBe(1);
			expect(store.turns(ID)[0]?.state).toBe("queued");
			expect(store.pendingIrc(ID, 1).map((m) => m.id)).toEqual(["a"]);
			expect(tables().inbox.map((r) => [r.id, r.state])).toEqual([["a", "pending"], ["b", "sent"]]);

			store.startNextTurn(ID);
			expect(store.pendingIrc(ID, 1).map((m) => m.id)).toEqual(["a"]);
			store.completeTurn(ID, 1, result());
			expect(store.turns(ID).map((t) => [t.id, t.origin, t.ircId])).toEqual([
				[1, "", ""],
				[2, "irc", "a"],
			]);
		});
	});

	describe("deleteThread", () => {
		test("clears the inbox and seen tables, and every IRC call then throws thread_not_found", async () => {
			running();
			store.sendIrc(ID, msg("a"));
			store.sendIrc(ID, msg("b"));
			store.markIrcSent(ID, "b");
			store.appendIrcEvent(ID, 1, { id: "o1", from: "agent", to: "alice", body: "x", replyTo: "" });
			expect(tables().inbox).toHaveLength(2);
			expect(tables().seen).toEqual(["o1"]);

			expect(await store.deleteThread(ID)).toBe(true);
			expect(tables()).toEqual({ inbox: [], seen: [] });
			expect(codeOf(() => store.pendingIrc(ID, 1))).toBe("thread_not_found");
			expect(codeOf(() => store.sendIrc(ID, msg("a")))).toBe("thread_not_found");
			expect(codeOf(() => store.appendIrcEvent(ID, null, { id: "o2", from: "agent", to: "alice", body: "x", replyTo: "" }))).toBe("thread_not_found");

			store.close();
			store = open();
			expect(tables()).toEqual({ inbox: [], seen: [] });
		});

		test("leaves another thread's IRC rows alone", async () => {
			running();
			store.createThread("bbbbbbbbbbbb", newThread());
			store.startNextTurn("bbbbbbbbbbbb");
			store.sendIrc("bbbbbbbbbbbb", msg("a"));
			store.appendIrcEvent("bbbbbbbbbbbb", 1, { id: "o1", from: "agent", to: "alice", body: "x", replyTo: "" });
			store.sendIrc(ID, msg("a"));
			await store.deleteThread(ID);
			expect(tables("bbbbbbbbbbbb")).toEqual({ inbox: [{ id: "a", turn_id: 1, state: "pending" }], seen: ["o1"] });
		});
	});
});

describe("workThreadIds and threadOwner", () => {
	test("lists live threads that have a queued or running turn, oldest first", async () => {
		const [queued, runningId, idle, failed, deleted, newer] = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", "eeeeeeeeeeee", "ffffffffffff"] as const;
		store.createThread(queued, newThread());
		tick();
		running(runningId);
		tick();
		running(idle);
		store.completeTurn(idle, 1, result());
		tick();
		store.createThread(failed, newThread());
		store.failThread(failed, "dead");
		tick();
		store.createThread(deleted, newThread());
		await store.deleteThread(deleted);
		tick();
		store.createThread(newer, newThread({ owner: "bob" }));
		expect(store.workThreadIds()).toEqual([queued, runningId, newer]);
		store.enqueueTurn(idle, "again", "alice");
		expect(store.workThreadIds()).toEqual([queued, runningId, idle, newer]);
	});

	test("threadOwner knows deleted threads and returns null for unknown ones", async () => {
		store.createThread(ID, newThread({ owner: "alice" }));
		expect(store.threadOwner(ID)).toBe("alice");
		await store.deleteThread(ID);
		expect(store.threadOwner(ID)).toBe("alice");
		expect(store.threadOwner("bbbbbbbbbbbb")).toBeNull();
	});
});

describe("subscribeAll", () => {
	test("hears every thread's events in commit order and each deletion, until it unsubscribes", async () => {
		const heard: string[] = [];
		const unsubscribe = store.subscribeAll({
			event: (threadId, event) => {
				heard.push(`${threadId}#${event.seq}:${event.kind}`);
			},
			deleted: (threadId) => {
				heard.push(`${threadId} deleted`);
			},
		});
		store.createThread(ID, newThread());
		store.createThread("bbbbbbbbbbbb", newThread());
		store.appendEvent(ID, "progress", "x", null);
		store.appendEvent("bbbbbbbbbbbb", "progress", "y", null);
		await store.deleteThread(ID);
		expect(heard).toEqual([
			`${ID}#1:turn_queued`,
			"bbbbbbbbbbbb#1:turn_queued",
			`${ID}#2:progress`,
			"bbbbbbbbbbbb#2:progress",
			`${ID} deleted`,
		]);
		unsubscribe();
		store.appendEvent("bbbbbbbbbbbb", "progress", "z", null);
		await store.deleteThread("bbbbbbbbbbbb");
		expect(heard).toHaveLength(5);
	});

	test("hears events only after the transaction committed, and a failed one notifies nobody", () => {
		running();
		const heard: ThreadEvent[] = [];
		store.subscribeAll({
			event: (_threadId, event) => {
				heard.push(event);
				// The event is already readable: the transaction has committed.
				expect(store.events(ID, event.seq - 1, 1)).toEqual([event]);
			},
			deleted: () => {},
		});
		store.askQuestions(ID, 1, [question(), question()], null);
		expect(heard.map((e) => e.kind)).toEqual(["question_asked", "question_asked"]);
		expect(codeOf(() => store.askQuestions(ID, 1, [], null))).toBe("invalid_question");
		expect(heard).toHaveLength(2);
	});

	test("a throwing listener is logged and does not stop other listeners", () => {
		running();
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			const heard: ThreadEvent[] = [];
			store.subscribeAll({
				event: () => {
					throw new Error("listener bug");
				},
				deleted: () => {},
			});
			store.subscribeAll({ event: (_threadId, event) => void heard.push(event), deleted: () => {} });
			expect(store.appendEvent(ID, "progress", "x", null).kind).toBe("progress");
			expect(heard).toHaveLength(1);
			expect(log).toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
});

describe("blobs", () => {
	async function* chunks(...sizes: number[]): AsyncGenerator<Uint8Array> {
		for (const size of sizes) yield bytes(size);
	}

	test("newThreadId returns unique valid ids and creates their private directories", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const id = store.newThreadId();
			expect(id).toMatch(THREAD_ID_PATTERN);
			ids.add(id);
		}
		expect(ids.size).toBe(100);
		const [id] = ids;
		const info = await stat(join(dir, "threads", id ?? ""));
		expect(info.isDirectory()).toBe(true);
		expect(info.mode & 0o077).toBe(0);
	});

	test("putBlob stores a Uint8Array or a stream and replaces atomically", async () => {
		expect(await store.blob(ID, "session.tar")).toBeNull();
		expect(await store.putBlob(ID, "session.tar", new TextEncoder().encode("one"), 100)).toBe(3);
		expect(await (await store.blob(ID, "session.tar"))?.text()).toBe("one");
		expect(await store.putBlob(ID, "session.tar", chunks(4, 4, 4), 100)).toBe(12);
		expect((await store.blob(ID, "session.tar"))?.size).toBe(12);
		const info = await stat(store.blobPath(ID, "session.tar"));
		expect(info.mode & 0o077).toBe(0);
		expect(await readdir(join(dir, "threads", ID))).toEqual(["session.tar"]);
		const stream = new Response(bytes(5)).body;
		if (stream === null) throw new Error("no stream");
		expect(await store.putBlob(ID, "result.bundle", stream, 100)).toBe(5);
	});

	test("a blob at exactly maxBytes is stored, one byte more is too_large", async () => {
		expect(await store.putBlob(ID, "source.bundle", chunks(5, 5), 10)).toBe(10);
		await expect(store.putBlob(ID, "result.bundle", chunks(5, 6), 10)).rejects.toMatchObject({ code: "too_large" });
		await expect(store.putBlob(ID, "result.bundle", bytes(11), 10)).rejects.toMatchObject({ code: "too_large" });
		expect(await store.blob(ID, "result.bundle")).toBeNull();
	});

	test("too_large stops reading, removes the temp file and keeps the previous blob", async () => {
		await store.putBlob(ID, "source.bundle", new TextEncoder().encode("previous"), 100);
		let pulled = 0;
		let closed = false;
		async function* endless(): AsyncGenerator<Uint8Array> {
			try {
				for (;;) {
					pulled++;
					yield bytes(10);
				}
			} finally {
				closed = true;
			}
		}
		await expect(store.putBlob(ID, "source.bundle", endless(), 25)).rejects.toBeInstanceOf(StoreError);
		expect(pulled).toBe(3);
		expect(closed).toBe(true);
		expect(await (await store.blob(ID, "source.bundle"))?.text()).toBe("previous");
		expect(await readdir(join(dir, "threads", ID))).toEqual(["source.bundle"]);
	});

	test("a failing stream leaves no temp file and keeps the previous blob", async () => {
		await store.putBlob(ID, "source.bundle", new TextEncoder().encode("previous"), 100);
		async function* broken(): AsyncGenerator<Uint8Array> {
			yield bytes(3);
			throw new Error("connection reset");
		}
		await expect(store.putBlob(ID, "source.bundle", broken(), 100)).rejects.toThrow("connection reset");
		expect(await (await store.blob(ID, "source.bundle"))?.text()).toBe("previous");
		expect(await readdir(join(dir, "threads", ID))).toEqual(["source.bundle"]);
	});

	test("thread ids that could escape the data directory are rejected everywhere", async () => {
		for (const id of ["../x", "..", "", "AAAAAAAAAAAA", "aaaaaaaaaaa", "aaaaaaaaaaaaa", "aaaaaaaaaa/a", "aaaaaaaaaa\0a"]) {
			expect(() => store.blobPath(id, "source.bundle")).toThrow();
			await expect(store.putBlob(id, "source.bundle", bytes(1), 10)).rejects.toThrow();
			await expect(store.blob(id, "source.bundle")).rejects.toThrow();
			await expect(store.removeBlobs(id)).rejects.toThrow();
		}
		expect(store.blobPath(ID, "source.bundle")).toBe(join(dir, "threads", ID, "source.bundle"));
	});

	test("removeBlobs removes the directory and tolerates a missing one", async () => {
		await store.putBlob(ID, "source.bundle", bytes(1), 10);
		await store.removeBlobs(ID);
		expect(await store.blob(ID, "source.bundle")).toBeNull();
		await store.removeBlobs(ID);
	});

	test("sweepOrphanBlobs removes the directories of no live thread", async () => {
		store.createThread(ID, newThread());
		await store.putBlob(ID, "source.bundle", bytes(1), 10);
		const orphan = store.newThreadId();
		await store.putBlob("cccccccccccc", "source.bundle", bytes(1), 10);
		store.createThread("dddddddddddd", newThread());
		await store.putBlob("dddddddddddd", "source.bundle", bytes(1), 10);
		await store.deleteThread("dddddddddddd");
		await store.putBlob("dddddddddddd", "secrets.json", bytes(1), 10);
		expect(await store.sweepOrphanBlobs()).toBe(3);
		expect((await readdir(join(dir, "threads"))).sort()).toEqual([ID]);
		expect(await store.blob(ID, "source.bundle")).not.toBeNull();
		expect(orphan).toMatch(THREAD_ID_PATTERN);
		expect(await store.sweepOrphanBlobs()).toBe(0);
	});
});

describe("titleFromReply", () => {
	test("takes the first non-empty line without leading markers, cut to 80 characters", () => {
		expect(titleFromReply("# Heading\nbody")).toBe("Heading");
		expect(titleFromReply("\n  \n> - * plain text \nnext")).toBe("plain text");
		expect(titleFromReply("###\n---\nreal")).toBe("real");
		expect(titleFromReply("")).toBe("");
		expect(titleFromReply("# \n>\n")).toBe("");
		expect(titleFromReply("x".repeat(100))).toBe("x".repeat(80));
		expect(titleFromReply(`${"é".repeat(79)} tail`)).toBe("é".repeat(79));
		expect(Array.from(titleFromReply("😀".repeat(90)))).toHaveLength(80);
		expect(titleFromReply("a\r\nb")).toBe("a");
	});
});
