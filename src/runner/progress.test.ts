import { describe, expect, test } from "bun:test";
import { MAX_STRUCTURED_EVENT_CHARS } from "../store/types";
import { addUsage, assistantEnd, messageText, progressOf, toolEndEventOf, toolStartEventOf, usageEventOf } from "./progress";

const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({ role: "assistant", content, ...extra });

describe("progressOf", () => {
	test("an assistant message with text is an assistant event", () => {
		expect(progressOf({ type: "message_end", message: assistant([{ type: "text", text: " Done. " }]) })).toEqual({
			kind: "assistant",
			text: "Done.",
		});
		expect(progressOf({ type: "message_end", message: assistant("plain") })).toEqual({ kind: "assistant", text: "plain" });
	});

	test("messages without text and other roles are not shown", () => {
		expect(progressOf({ type: "message_end", message: assistant([{ type: "toolCall", name: "read" }]) })).toBeNull();
		expect(progressOf({ type: "message_end", message: assistant([{ type: "text", text: "  " }]) })).toBeNull();
		expect(progressOf({ type: "message_end", message: { role: "user", content: "hi" } })).toBeNull();
	});

	test("a tool call shows its name and the intent, else compact arguments", () => {
		expect(progressOf({ type: "tool_execution_start", toolName: "bash", intent: "run the tests", args: { command: "bun test" } })).toEqual({
			kind: "tool",
			text: "bash run the tests",
		});
		expect(progressOf({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts", offset: 1 } })).toEqual({
			kind: "tool",
			text: 'read {"path":"src/a.ts","offset":1}',
		});
		expect(progressOf({ type: "tool_execution_start", toolName: "todo", args: {} })).toEqual({ kind: "tool", text: "todo" });
	});

	test("long arguments are cut", () => {
		const event = progressOf({ type: "tool_execution_start", toolName: "write", args: { content: "x".repeat(1000) } });
		expect(event?.kind).toBe("tool");
		expect(event?.text.length).toBeLessThan(230);
		expect(event?.text.endsWith("…")).toBe(true);
	});

	test("only a failed tool call is a tool_error", () => {
		expect(progressOf({ type: "tool_execution_end", toolName: "bash", isError: false, result: {} })).toBeNull();
		expect(progressOf({ type: "tool_execution_end", toolName: "bash", result: {} })).toBeNull();
		expect(
			progressOf({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "\nexit 2\nmore" }] } }),
		).toEqual({ kind: "tool_error", text: "bash: exit 2" });
		expect(progressOf({ type: "tool_execution_end", toolName: "bash", isError: true, result: {} })).toEqual({ kind: "tool_error", text: "bash" });
	});

	test("retries, compaction and omp notices are notices", () => {
		expect(progressOf({ type: "auto_retry_start", attempt: 2, maxAttempts: 4, delayMs: 1000, errorMessage: "overloaded" })).toEqual({
			kind: "notice",
			text: "retry 2/4: overloaded",
		});
		expect(progressOf({ type: "auto_compaction_start", reason: "threshold", action: "context-full" })).toEqual({
			kind: "notice",
			text: "compacting the context (context-full, threshold)",
		});
		expect(progressOf({ type: "notice", level: "warning", message: "disk almost full", source: "persistence" })).toEqual({
			kind: "notice",
			text: "persistence: disk almost full",
		});
		expect(progressOf({ type: "notice", level: "info", message: "hello" })).toEqual({ kind: "notice", text: "hello" });
	});

	test("every other event and non-objects map to nothing", () => {
		expect(progressOf({ type: "agent_end", messages: [] })).toBeNull();
		expect(progressOf({ type: "message_update" })).toBeNull();
		expect(progressOf("text")).toBeNull();
		expect(progressOf(null)).toBeNull();
	});
});

describe("assistantEnd and addUsage", () => {
	test("reads usage and the stop information of an assistant message", () => {
		const end = assistantEnd(
			assistant("x", {
				usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } },
				stopReason: "error",
				errorMessage: "auth-gateway 401: bad token",
			}),
		);
		expect(end).toEqual({
			usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, cost: 0.25 },
			stopReason: "error",
			errorMessage: "auth-gateway 401: bad token",
		});
	});

	test("a message without usage has none, and other roles are not assistant messages", () => {
		expect(assistantEnd(assistant("x"))).toEqual({ usage: null, stopReason: "", errorMessage: "" });
		expect(assistantEnd({ role: "user", content: "x" })).toBeNull();
	});

	test("usage adds up and a missing side is the other", () => {
		const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cost: 0.5 };
		const b = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, cost: 1 };
		expect(addUsage(a, b)).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, cost: 1.5 });
		expect(addUsage(null, b)).toBe(b);
		expect(addUsage(a, null)).toBe(a);
		expect(addUsage(null, null)).toBeNull();
	});
});

describe("messageText", () => {
	test("joins the text blocks and ignores the rest", () => {
		expect(messageText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("ab");
		expect(messageText({ content: 5 })).toBe("");
		expect(messageText(null)).toBe("");
	});
});

describe("usageEventOf", () => {
	const withUsage = { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", content: [], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } } };

	test("one event per assistant message: tokens, cost, model, stop reason and the context it ended with", () => {
		const event = usageEventOf({ type: "message_end", message: withUsage }, 200_000);
		expect(event?.kind).toBe("usage");
		expect(JSON.parse(event?.text ?? "")).toEqual({
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			cost: 0.25,
			model: "anthropic/claude-opus-5-5",
			stopReason: "stop",
			context: { tokens: 18, window: 200_000 },
		});
	});

	test("none for a message without usage, another role, or another event", () => {
		expect(usageEventOf({ type: "message_end", message: { role: "assistant", content: [] } }, 0)).toBeNull();
		expect(usageEventOf({ type: "message_end", message: { role: "user", content: "x", usage: {} } }, 0)).toBeNull();
		expect(usageEventOf({ type: "message_update", message: withUsage }, 0)).toBeNull();
		expect(usageEventOf(null, 0)).toBeNull();
	});

	test("a model with no provider is named as it is, and an unknown window is 0", () => {
		const event = usageEventOf({ type: "message_end", message: { ...withUsage, provider: undefined } }, 0);
		expect(JSON.parse(event?.text ?? "")).toMatchObject({ model: "claude-opus-5-5", context: { window: 0 } });
	});
});

describe("tool_start and tool_end events", () => {
	test("tool_start carries the call id, the tool, the intent and clipped arguments", () => {
		const event = toolStartEventOf({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", intent: "run the tests", args: { command: "x".repeat(1000) } });
		expect(event?.kind).toBe("tool_start");
		const body = JSON.parse(event?.text ?? "");
		expect(body).toMatchObject({ id: "call_1", tool: "bash", intent: "run the tests" });
		expect(body.args.length).toBeLessThan(230);
		expect(body.args.endsWith("…")).toBe(true);
		expect(JSON.parse(toolStartEventOf({ type: "tool_execution_start", toolCallId: "c", toolName: "todo", args: {} })?.text ?? "")).toEqual({ id: "c", tool: "todo", intent: "", args: "" });
		expect(toolStartEventOf({ type: "tool_execution_start", toolCallId: "c" })).toBeNull();
		expect(toolStartEventOf({ type: "tool_execution_end", toolCallId: "c", toolName: "x" })).toBeNull();
	});

	test("tool_end says ok, the duration and nothing spawned for an ordinary call", () => {
		const event = toolEndEventOf({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] } }, 1000, 1250, { path: "a" });
		expect(JSON.parse(event?.text ?? "")).toEqual({ id: "call_1", tool: "read", ok: true, ms: 250, error: "", async: false, detached: false, spawned: [] });
	});

	test("a failed call is not ok and carries the first line of its error; an unseen start has no duration", () => {
		const event = toolEndEventOf(
			{ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "\nexit 2\nmore" }] } },
			null,
			5000,
			undefined,
		);
		expect(JSON.parse(event?.text ?? "")).toMatchObject({ ok: false, ms: null, error: "exit 2", spawned: [] });
	});

	test("a task call that spawned agents lists each agent and job, async and detached", () => {
		const single = toolEndEventOf(
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "task", result: { content: [{ type: "text", text: "Spawned agent `AuthFix` (job `job_7`)." }] } },
			0,
			10,
			{},
		);
		expect(JSON.parse(single?.text ?? "")).toMatchObject({ async: true, detached: true, spawned: [{ agent: "AuthFix", job: "job_7" }] });
		const several = toolEndEventOf(
			{
				type: "tool_execution_end",
				toolCallId: "t2",
				toolName: "task",
				result: { content: [{ type: "text", text: "Spawned 2 background agents using explore.\n- `A` (job `j1`)\n- `B` (job `j2`)\n" }] },
			},
			0,
			10,
			{},
		);
		expect(JSON.parse(several?.text ?? "").spawned).toEqual([{ agent: "A", job: "j1" }, { agent: "B", job: "j2" }]);
	});

	test("a bash call that went to the background names its job; one that finished in the foreground does not", () => {
		const running = toolEndEventOf(
			{ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: { content: [], details: { async: { state: "running", jobId: "bg_1", type: "bash" } } } },
			0,
			1,
			{ async: true },
		);
		expect(JSON.parse(running?.text ?? "")).toMatchObject({ async: true, detached: true, spawned: [{ agent: "", job: "bg_1" }] });
		const done = toolEndEventOf(
			{ type: "tool_execution_end", toolCallId: "b2", toolName: "bash", result: { content: [], details: { async: { state: "completed", jobId: "bg_2", type: "bash" } } } },
			0,
			1,
			{ async: true },
		);
		expect(JSON.parse(done?.text ?? "")).toMatchObject({ async: true, detached: false, spawned: [] });
	});

	test("a failed call spawned nothing, and the largest event stays under the store's limit", () => {
		const failed = toolEndEventOf({ type: "tool_execution_end", toolCallId: "t", toolName: "task", isError: true, result: { content: [{ type: "text", text: "Spawned agent `A` (job `j`)" }] } }, 0, 1, {});
		expect(JSON.parse(failed?.text ?? "").spawned).toEqual([]);
		const lines = Array.from({ length: 40 }, (_, i) => `- \`${i}${"A".repeat(80)}\` (job \`${i}${"j".repeat(80)}\`)`).join("\n");
		const big = toolEndEventOf({ type: "tool_execution_end", toolCallId: "i".repeat(300), toolName: "t".repeat(300), isError: false, result: { content: [{ type: "text", text: lines }] } }, 0, 1, {});
		expect(big?.text.length).toBeLessThan(MAX_STRUCTURED_EVENT_CHARS);
		expect(JSON.parse(big?.text ?? "").spawned).toHaveLength(16);
	});
});
