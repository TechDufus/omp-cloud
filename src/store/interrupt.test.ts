import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./index";
import { MAX_TEXT_BYTES, MAX_TURNS, type NewThread, type QuestionInput, StoreError, type TurnResult } from "./types";

const ID = "aaaaaaaaaaaa";

let dir: string;
let store: Store;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-interrupt-"));
	store = Store.open({ dataDir: dir });
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function newThread(): NewThread {
	return {
		owner: "owner",
		title: "t",
		prompt: "first",
		model: "",
		thinking: "",
		repo: { name: "repo", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "d".repeat(40), localBranch: "main" },
		paths: { home: "/home/me", workspace: "/home/me/repo" },
		author: { name: "Me", email: "me@example.com" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
	};
}

function done(overrides: Partial<TurnResult> = {}): TurnResult {
	return { outcome: "completed", error: "", reply: "ok", usage: null, head: "", filesChanged: 0, insertions: 0, deletions: 0, pushed: false, pushError: "", pushRef: "", ...overrides };
}

function question(): QuestionInput {
	return { key: "k", text: "Which?", header: "", options: [{ label: "a", description: "" }], multi: false, recommended: null, ompKey: "k", ompLabels: ["a"] };
}

const states = (): string[] => store.turns(ID).map((turn) => `${turn.id}:${turn.state}`);
const kinds = (kind: string) => store.events(ID, 0, 1000).filter((e) => e.kind === kind);

describe("Store.interruptThread", () => {
	test("stops the running turn and cancels the queued ones exactly as stopThread does, then queues the new turn next in id order", () => {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.askQuestions(ID, 1, [question()], "req-1");
		store.enqueueTurn(ID, "second", "owner");
		store.enqueueTurn(ID, "third", "owner");

		const sent = store.interruptThread(ID, "change of plan", "device:d1");

		expect(sent.interrupted).toBe(true);
		expect(sent.cancelled).toEqual([2, 3]);
		expect(sent.turn).toMatchObject({ id: 4, state: "queued", text: "change of plan", by: "device:d1" });
		expect(states()).toEqual(["1:running", "2:cancelled", "3:cancelled", "4:queued"]);
		expect(store.turns(ID)[1]).toMatchObject({ error: "cancelled by device:d1", stoppedBy: "device:d1" });
		expect(store.turns(ID)[0]?.questions[0]).toMatchObject({ expired: true, answeredBy: "stop" });
		expect(kinds("stop_requested")).toEqual([expect.objectContaining({ turn: 1, text: "stop requested by device:d1" })]);
		expect(kinds("turn_cancelled").map((e) => [e.turn, e.text])).toEqual([[2, "cancelled by device:d1"], [3, "cancelled by device:d1"]]);

		expect(store.completeTurn(ID, 1, done())).toMatchObject({ state: "failed", error: "stopped by device:d1" });
		expect(store.startNextTurn(ID)?.id).toBe(4);
	});

	test("with nothing running it cancels the queued turns, queues the new one and interrupted is false", () => {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.completeTurn(ID, 1, done());
		store.enqueueTurn(ID, "second", "owner");

		const sent = store.interruptThread(ID, "go", "owner");

		expect(sent).toMatchObject({ interrupted: false, cancelled: [2], turn: { id: 3, state: "queued" } });
		expect(kinds("stop_requested")).toEqual([]);
		expect(states()).toEqual(["1:done", "2:cancelled", "3:queued"]);
		expect(store.startNextTurn(ID)?.id).toBe(3);
	});

	test("with nothing running and nothing queued it only queues the turn", () => {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.completeTurn(ID, 1, done());

		expect(store.interruptThread(ID, "go", "owner")).toMatchObject({ interrupted: false, cancelled: [], turn: { id: 2 } });
	});

	test("a second interrupt cancels the first one's still queued turn", () => {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.interruptThread(ID, "first", "owner");
		expect(store.interruptThread(ID, "second", "owner")).toMatchObject({ interrupted: true, cancelled: [2], turn: { id: 3 } });
		expect(states()).toEqual(["1:running", "2:cancelled", "3:queued"]);
	});

	test("a refused message changes nothing: the running turn is not stopped and the queued turns stay", () => {
		store.createThread(ID, newThread());
		store.startNextTurn(ID);
		store.enqueueTurn(ID, "second", "owner");

		const refusal = (text: string): StoreError => {
			try {
				store.interruptThread(ID, text, "owner");
			} catch (error) {
				if (error instanceof StoreError) return error;
				throw error;
			}
			throw new Error("expected a refusal");
		};
		expect(refusal("").code).toBe("invalid_text");
		expect(refusal("x".repeat(MAX_TEXT_BYTES + 1)).code).toBe("invalid_text");
		expect(states()).toEqual(["1:running", "2:queued"]);
		expect(kinds("stop_requested")).toEqual([]);
		expect(kinds("turn_cancelled")).toEqual([]);

		for (let n = store.turns(ID).length; n < MAX_TURNS; n++) store.enqueueTurn(ID, `t${n}`, "owner");
		expect(refusal("one too many").code).toBe("thread_full");
		expect(store.turns(ID)[0]?.state).toBe("running");
		expect(store.turns(ID)[1]?.state).toBe("queued");
		expect(kinds("stop_requested")).toEqual([]);
		expect(kinds("turn_cancelled")).toEqual([]);

		store.failThread(ID, "broke");
		expect(refusal("after failure").code).toBe("thread_failed");
	});
});
