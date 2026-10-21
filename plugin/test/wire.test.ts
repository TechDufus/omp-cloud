import { describe, expect, test } from "bun:test";
import { parseIrcPayload, parseIrcReceipt, parseThreadDetail, parseThreadSummary } from "../src/wire";

const result = { branch: "omp-cloud/a", head: "0123456789", base: "main", filesChanged: 1, insertions: 2, deletions: 3, pushed: true, pushError: "", updatedAt: "" };
const turn = { id: 1, state: "done", pushed: true, pushError: "", questions: [] };

describe("pushRef", () => {
	test("the result and the turns carry the branch they were pushed to", () => {
		const detail = parseThreadDetail({ id: "a", result: { ...result, pushRef: "bots/a" }, turns: [{ ...turn, pushRef: "bots/a" }] });
		expect(detail.result?.pushRef).toBe("bots/a");
		expect(detail.turns[0]?.pushRef).toBe("bots/a");
		expect(parseThreadSummary({ id: "a", result: { ...result, pushRef: "x/y" } }).result?.pushRef).toBe("x/y");
	});

	test("a service that does not send it, or sends it mistyped, means no branch", () => {
		const detail = parseThreadDetail({ id: "a", result, turns: [{ ...turn, pushRef: 7 }] });
		expect(detail.result?.pushRef).toBe("");
		expect(detail.turns[0]?.pushRef).toBe("");
	});
});

describe("the repository of a thread summary", () => {
	test("carries the repo and the workspace the service lists", () => {
		const s = parseThreadSummary({
			id: "a",
			repo: { name: "app", remoteURL: "https://github.com/org/app.git", baseRef: "main", localBranch: "feat", baseCommit: "ignored" },
			workspace: "/home/ada/app",
		});
		expect(s.repo).toEqual({ name: "app", remoteURL: "https://github.com/org/app.git", baseRef: "main", localBranch: "feat" });
		expect(s.workspace).toBe("/home/ada/app");
	});

	test("a service that sends neither, or sends them mistyped, means an empty repo and workspace", () => {
		for (const body of [{ id: "a" }, { id: "a", repo: "x", workspace: 3 }]) {
			const s = parseThreadSummary(body);
			expect(s.repo).toEqual({ name: "", remoteURL: "", baseRef: "", localBranch: "" });
			expect(s.workspace).toBe("");
		}
	});

	test("a detail keeps its fuller repo and its paths, and takes no top-level workspace", () => {
		const d = parseThreadDetail({ id: "a", repo: { name: "app", remoteURL: "u", baseRef: "main", baseCommit: "b", handoffCommit: "h", localBranch: "feat" }, paths: { home: "/h", workspace: "/h/app" } });
		expect(d.repo).toEqual({ name: "app", remoteURL: "u", baseRef: "main", baseCommit: "b", handoffCommit: "h", localBranch: "feat" });
		expect(d.paths.workspace).toBe("/h/app");
		expect("workspace" in d).toBe(false);
	});
});

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 30, cost: 0.12 };

describe("the name, archive state, metrics and activity of a thread", () => {
	test("a summary and a detail carry them", () => {
		const body = {
			id: "a",
			name: "Fix login redirect",
			archivedAt: "2026-01-09T00:00:00Z",
			metrics: {
				usage,
				requests: 4,
				tools: 9,
				workMs: 61000,
				context: { tokens: 19000, window: 200000, at: "2026-01-02T00:00:00Z" },
				turns: [
					{ n: 1, cost: 0.05, contextTokens: 8000 },
					{ n: 2, cost: 0.07, contextTokens: null },
				],
			},
			activity: { kind: "tool", text: "bash: bun test", at: "2026-01-02T00:00:01Z" },
		};
		for (const t of [parseThreadSummary(body), parseThreadDetail(body)]) {
			expect(t.name).toBe("Fix login redirect");
			expect(t.archivedAt).toBe("2026-01-09T00:00:00Z");
			expect(t.metrics).toEqual({
				usage,
				requests: 4,
				tools: 9,
				workMs: 61000,
				context: { tokens: 19000, window: 200000, at: "2026-01-02T00:00:00Z" },
				turns: [
					{ n: 1, cost: 0.05, contextTokens: 8000 },
					{ n: 2, cost: 0.07, contextTokens: null },
				],
			});
			expect(t.activity).toEqual({ kind: "tool", text: "bash: bun test", at: "2026-01-02T00:00:01Z" });
		}
	});

	test("a thread that sends none gives an empty name and null for the rest", () => {
		for (const t of [parseThreadSummary({ id: "a" }), parseThreadDetail({ id: "a" })]) {
			expect(t.name).toBe("");
			expect(t.archivedAt).toBeNull();
			expect(t.metrics).toBeNull();
			expect(t.activity).toBeNull();
		}
	});

	test("mistyped values are the absent ones", () => {
		const t = parseThreadSummary({ id: "a", name: 3, archivedAt: 7, metrics: "x", activity: [] });
		expect(t.name).toBe("");
		expect(t.archivedAt).toBeNull();
		expect(t.metrics).toBeNull();
		expect(t.activity).toBeNull();
		const m = parseThreadSummary({ id: "a", metrics: { requests: "many", context: "big", turns: [{ n: 1 }, "x"] } }).metrics;
		expect(m).toEqual({
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
			requests: 0,
			tools: 0,
			workMs: 0,
			context: null,
			turns: [{ n: 1, cost: 0, contextTokens: null }],
		});
	});

	test("a turn carries its requests, tools and context at the end; none sent means 0, 0 and null", () => {
		const d = parseThreadDetail({ id: "a", turns: [{ ...turn, requests: 3, tools: 5, context: { tokens: 12000, window: 200000 } }, turn] });
		expect(d.turns[0]).toMatchObject({ requests: 3, tools: 5, context: { tokens: 12000, window: 200000 } });
		expect(d.turns[1]).toMatchObject({ requests: 0, tools: 0, context: null });
	});
});

describe("the IRC fields of a turn", () => {
	test("a turn an IRC message woke carries its origin, sender, message id and the id it answers", () => {
		const d = parseThreadDetail({ id: "a", turns: [{ ...turn, origin: "irc", ircFrom: "Main", ircId: "m-1", ircReplyTo: "m-0" }] });
		expect(d.turns[0]).toMatchObject({ origin: "irc", ircFrom: "Main", ircId: "m-1", ircReplyTo: "m-0" });
	});

	test("a turn the service did not send them for, or sent mistyped or unknown, is no IRC turn: empty strings", () => {
		for (const t of [turn, { ...turn, origin: "cron", ircFrom: 7, ircId: null, ircReplyTo: {} }, { ...turn, origin: "" }]) {
			const d = parseThreadDetail({ id: "a", turns: [t] });
			expect(d.turns[0]).toMatchObject({ origin: "", ircFrom: "", ircId: "", ircReplyTo: "" });
		}
	});
});

describe("the answer to an IRC message", () => {
	test("each receipt the service knows parses, with the id the message was stored under", () => {
		for (const receipt of ["injected", "woken", "revived"] as const) {
			expect(parseIrcReceipt({ receipt, id: "m-1", turn: null })).toEqual({ receipt, id: "m-1", turn: null });
		}
	});

	test("a woken or revived message carries the turn it queued, parsed as any turn is", () => {
		const woken = parseIrcReceipt({ receipt: "woken", id: "m-2", turn: { ...turn, id: 4, state: "queued", origin: "irc", ircFrom: "Main", ircId: "m-2" } });
		expect(woken.receipt).toBe("woken");
		expect(woken.turn).toMatchObject({ id: 4, state: "queued", origin: "irc", ircFrom: "Main", ircId: "m-2", ircReplyTo: "" });
	});

	test("a turn that is not an object means none, and an absent id is empty", () => {
		expect(parseIrcReceipt({ receipt: "injected", turn: "x" })).toEqual({ receipt: "injected", id: "", turn: null });
	});

	test("a receipt this client does not know is an error naming it, never a guess; so is a missing one or a body that is no object", () => {
		expect(() => parseIrcReceipt({ receipt: "teleported", id: "m", turn: null })).toThrow('irc: unknown receipt "teleported"');
		expect(() => parseIrcReceipt({ id: "m", turn: null })).toThrow("irc: unknown receipt undefined");
		expect(() => parseIrcReceipt({ receipt: 3 })).toThrow("irc: unknown receipt 3");
		expect(() => parseIrcReceipt("woken")).toThrow();
		expect(() => parseIrcReceipt(null)).toThrow();
	});
});

describe("the text of an irc event", () => {
	const payload = { id: "m-1", from: "Scout", to: "Main", body: "found it", replyTo: "m-0", at: "2026-10-21T10:00:00Z" };

	test("a message parses into its id, sender, addressee, body, reply and time", () => {
		expect(parseIrcPayload(JSON.stringify(payload))).toEqual(payload);
	});

	test("an absent reply, addressee or time is empty", () => {
		expect(parseIrcPayload(JSON.stringify({ id: "m-1", from: "Scout", body: "hi" }))).toEqual({ id: "m-1", from: "Scout", to: "", body: "hi", replyTo: "", at: "" });
	});

	test("text that is no message is undefined: not JSON, not an object, or without an id, sender or body", () => {
		expect(parseIrcPayload("not json")).toBeUndefined();
		expect(parseIrcPayload("")).toBeUndefined();
		expect(parseIrcPayload("[1,2]")).toBeUndefined();
		expect(parseIrcPayload("null")).toBeUndefined();
		expect(parseIrcPayload("\"found it\"")).toBeUndefined();
		for (const missing of ["id", "from", "body"] as const) {
			expect(parseIrcPayload(JSON.stringify({ ...payload, [missing]: "" }))).toBeUndefined();
			expect(parseIrcPayload(JSON.stringify({ ...payload, [missing]: 5 }))).toBeUndefined();
		}
	});
});
