import { describe, expect, test } from "bun:test";
import type { Thread, ThreadStats, Turn } from "../store/types";
import { cutBytes, detailView, summaryView, turnView } from "./views";

describe("cutBytes", () => {
	test("leaves a text within the limit alone", () => {
		expect(cutBytes("abc", 3)).toBe("abc");
		expect(cutBytes("é€", 5)).toBe("é€");
		expect(cutBytes("", 0)).toBe("");
	});

	test("cuts ASCII at the limit", () => {
		expect(cutBytes("abcdef", 4)).toBe("abcd");
	});

	test("never splits a multi-byte sequence", () => {
		expect(cutBytes("é€", 2)).toBe("é"); // the euro sign would end at byte 5
		expect(cutBytes("é€", 3)).toBe("é");
		expect(cutBytes("é€", 4)).toBe("é");
		expect(cutBytes("a😀b", 4)).toBe("a");
		expect(cutBytes("a😀b", 5)).toBe("a😀");
		expect(cutBytes("€", 2)).toBe("");
		expect(cutBytes("€", 0)).toBe("");
	});

	test("the cut text is at most the limit and a prefix of the original", () => {
		const text = "aé€😀".repeat(100);
		for (let max = 0; max <= 60; max++) {
			const cut = cutBytes(text, max);
			expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(max);
			expect(text.startsWith(cut)).toBe(true);
			expect(cut).not.toContain("\uFFFD");
		}
	});
});

const NO_METRICS: ThreadStats["metrics"] = {
	usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
	requests: 0,
	tools: 0,
	workMs: 0,
	context: null,
	turns: [],
};

describe("summaryView", () => {
	const thread: Thread = {
		id: "aaaaaaaaaaaa",
		owner: "owner",
		phase: "idle",
		title: "t",
		model: "",
		thinking: "",
		repo: { name: "r", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "h", localBranch: "" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
		error: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		name: "",
		archivedAt: null,
		restoreHead: "",
		context: null,
		origin: "",
		ref: "",
		session: "",
		scratch: false,
		pr: null,
		mcpServers: [],
		memoryBank: "",
		setup: null,
	};

	function turn(overrides: Partial<Turn>): Turn {
		return {
			id: 1,
			state: "done",
			text: "x",
			by: "owner",
			origin: "",
			ircFrom: "",
			ircId: "",
			ircReplyTo: "",
			queuedAt: "2026-01-01T00:00:00.000Z",
			startedAt: null,
			completedAt: null,
			stopRequested: false,
			stoppedBy: "",
			reply: "",
			title: "",
			error: "",
			usage: null,
			head: "",
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			pushed: false,
			pushError: "",
			pushRef: "",
			promptSentAt: null,
			requests: 0,
			tools: 0,
			context: null,
			questions: [],
			...overrides,
		};
	}

	test("the summary and the detail carry origin, ref, session and scratch", () => {
		const meta = { origin: "tool", ref: "fix-login", session: "01HX", scratch: true } as const;
		const stats: ThreadStats = { turns: 1, queued: 0, latest: null, resultTurn: null, pending: null, metrics: NO_METRICS, activity: null };
		expect(summaryView({ ...thread, ...meta }, stats)).toMatchObject(meta);
		expect(detailView({ ...thread, ...meta }, stats, [], null)).toMatchObject(meta);
		expect(summaryView(thread, stats)).toMatchObject({ origin: "", ref: "", session: "", scratch: false });
	});

	test("the summary and the detail carry the pull request, null before any", () => {
		const stats: ThreadStats = { turns: 1, queued: 0, latest: null, resultTurn: null, pending: null, metrics: NO_METRICS, activity: null };
		const pr = { number: 7, url: "https://github.com/acme/app/pull/7" };
		expect(summaryView(thread, stats).pr).toBeNull();
		expect(summaryView({ ...thread, pr }, stats).pr).toEqual(pr);
		expect(detailView({ ...thread, pr }, stats, [], null).pr).toEqual(pr);
	});

	test("result.updatedAt falls back to the queue time of a turn without completion time", () => {
		const resultTurn = turn({ head: "abc" });
		const stats: ThreadStats = { turns: 1, queued: 0, latest: null, resultTurn, pending: null, metrics: NO_METRICS, activity: null };
		expect(summaryView(thread, stats).result?.updatedAt).toBe(resultTurn.queuedAt);
		const completed = turn({ head: "abc", completedAt: "2026-01-02T00:00:00.000Z" });
		expect(summaryView(thread, { ...stats, resultTurn: completed }).result?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
	});

	test("latest cuts the reply to 3000 and the error to 1000 characters, counting code points", () => {
		const latest = turn({ state: "failed", reply: "😀".repeat(3001), error: "😀".repeat(1001) });
		const view = summaryView(thread, { turns: 1, queued: 0, latest, resultTurn: null, pending: null, metrics: NO_METRICS, activity: null });
		expect(Array.from(view.latest?.reply ?? "")).toHaveLength(3000);
		expect(Array.from(view.latest?.error ?? "")).toHaveLength(1000);
	});

	test("the result and the turn carry the branch they were pushed to, the error cut to 300 characters", () => {
		const pushedTurn = turn({ head: "abc", pushed: true, pushRef: "omp-cloud/aaaaaaaaaaaa", completedAt: "2026-01-02T00:00:00.000Z" });
		const stats: ThreadStats = { turns: 1, queued: 0, latest: null, resultTurn: pushedTurn, pending: null, metrics: NO_METRICS, activity: null };
		expect(summaryView(thread, stats).result).toMatchObject({ pushed: true, pushError: "", pushRef: "omp-cloud/aaaaaaaaaaaa" });
		expect(turnView(pushedTurn)).toMatchObject({ pushed: true, pushRef: "omp-cloud/aaaaaaaaaaaa" });

		const failedTurn = turn({ head: "abc", pushError: "x".repeat(400) });
		const failed = summaryView(thread, { ...stats, resultTurn: failedTurn }).result;
		expect(failed).toMatchObject({ pushed: false, pushRef: "" });
		expect(failed?.pushError).toBe("x".repeat(300));
		expect(turnView(failedTurn).pushError).toBe("x".repeat(400));
	});

	test("the summary carries the name, archive time, metrics and activity; a turn its requests, tools and context", () => {
		const metrics: ThreadStats["metrics"] = {
			usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 0.5 },
			requests: 3,
			tools: 7,
			workMs: 4000,
			context: { tokens: 19_000, window: 200_000, at: "2026-01-01T00:00:05.000Z" },
			turns: [{ n: 1, cost: 0.5, contextTokens: 19_000 }],
		};
		const activity = { kind: "tool" as const, text: "read src/a.ts", at: "2026-01-01T00:00:06.000Z" };
		const view = summaryView(
			{ ...thread, name: "Fix login", archivedAt: "2026-01-09T00:00:00.000Z" },
			{ turns: 1, queued: 0, latest: null, resultTurn: null, pending: null, metrics, activity },
		);
		expect(view).toMatchObject({ name: "Fix login", archivedAt: "2026-01-09T00:00:00.000Z", metrics, activity });
		expect(view.metrics).not.toBe(metrics);
		expect(view.metrics.context).not.toBe(metrics.context);
		expect(turnView(turn({ requests: 3, tools: 7, context: { tokens: 5, window: 10 } }))).toMatchObject({
			requests: 3,
			tools: 7,
			context: { tokens: 5, window: 10 },
		});
		expect(turnView(turn({})).context).toBeNull();
	});

	test("a turn shows where it came from: empty for an ordinary one, the sender and message for an irc one", () => {
		expect(turnView(turn({}))).toMatchObject({ origin: "", ircFrom: "", ircId: "", ircReplyTo: "" });
		const irc = turnView(turn({ by: "Peer.1", origin: "irc", ircFrom: "Peer.1", ircId: "irc_1", ircReplyTo: "ask-2" }));
		expect(irc).toMatchObject({ by: "Peer.1", origin: "irc", ircFrom: "Peer.1", ircId: "irc_1", ircReplyTo: "ask-2" });
	});

	test("a thread without a name, archive or activity shows them empty", () => {
		const view = summaryView(thread, { turns: 1, queued: 0, latest: null, resultTurn: null, pending: null, metrics: NO_METRICS, activity: null });
		expect(view).toMatchObject({ name: "", archivedAt: null, activity: null, metrics: NO_METRICS });
	});
});
