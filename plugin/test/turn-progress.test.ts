import { describe, expect, test } from "bun:test";
import { TurnProgress } from "../src/turn-progress";
import { event, metrics } from "./builders";

const T0 = Date.parse("2026-10-19T10:00:00Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

const start = (seq: number, s: number, o: { id?: string; tool?: string; intent?: string; args?: string } = {}) =>
	event(seq, { kind: "tool_start", turn: 1, at: at(s), text: JSON.stringify({ id: o.id ?? `c${seq}`, tool: o.tool ?? "bash", intent: o.intent ?? "", args: o.args ?? "" }) });
const end = (seq: number, s: number, o: { id?: string; tool?: string; ok?: boolean } = {}) =>
	event(seq, { kind: "tool_end", turn: 1, at: at(s), text: JSON.stringify({ id: o.id ?? `c${seq - 1}`, tool: o.tool ?? "bash", ok: o.ok ?? true, ms: 1000, error: "", async: false, detached: false, spawned: [] }) });
const usage = (seq: number, s: number, o: { cost?: number; input?: number; output?: number; context?: { tokens: number; window: number } } = {}) =>
	event(seq, { kind: "usage", turn: 1, at: at(s), text: JSON.stringify({ input: o.input ?? 100, output: o.output ?? 20, cacheRead: 900, cacheWrite: 30, cost: o.cost ?? 0.01, model: "anthropic/claude-sonnet-5-5", stopReason: "toolUse", context: o.context ?? { tokens: 1050, window: 200_000 } }) });

describe("structured events (tool_start, tool_end, usage)", () => {
	test("a call in flight is the current tool with its argument preview; its end moves it to the recent calls", () => {
		const p = new TurnProgress(() => T0 + 90_000);
		p.note(start(1, 0, { args: '{"command":"for i in 1 2 3; do sleep 1; done"}' }));
		expect(p.calls()).toMatchObject({ currentTool: "bash", currentToolArgs: "for i in 1 2 3; do sleep 1; done", currentToolArgsKey: "command", currentToolStartMs: T0, recentTools: [] });
		expect(p.tools).toBe(1);
		p.note(end(2, 3));
		const done = p.calls();
		expect(done.currentTool).toBeUndefined();
		expect(done.recentTools).toEqual([{ tool: "bash", args: "for i in 1 2 3; do sleep 1; done", argsKey: "command", isError: false, endMs: T0 + 3000 }]);
	});

	test("an intent is kept as the call's intent and as the last one; a failed call is marked", () => {
		const p = new TurnProgress();
		p.note(start(1, 0, { tool: "read", intent: "reading the router", args: '{"path":"src/router.go"}' }));
		expect(p.calls()).toMatchObject({ currentTool: "read", currentToolIntent: "reading the router", currentToolArgs: "src/router.go", lastIntent: "reading the router" });
		p.note(end(2, 1, { id: "c1", tool: "read", ok: false }));
		expect(p.calls().recentTools[0]).toMatchObject({ tool: "read", intent: "reading the router", isError: true });
	});

	test("overlapping calls: the oldest still running is current, and only the newest five are recent", () => {
		const p = new TurnProgress();
		p.note(start(1, 0, { id: "a", tool: "task" }));
		p.note(start(2, 1, { id: "b", tool: "read" }));
		expect(p.calls().currentTool).toBe("task");
		p.note(end(3, 2, { id: "a", tool: "task" }));
		expect(p.calls().currentTool).toBe("read");
		for (let n = 0; n < 8; n++) {
			p.note(start(10 + n * 2, 3 + n, { id: `x${n}`, tool: `t${n}` }));
			p.note(end(11 + n * 2, 3 + n, { id: `x${n}`, tool: `t${n}` }));
		}
		const recent = p.calls().recentTools;
		expect(recent).toHaveLength(5);
		expect(recent[0]?.tool).toBe("t7");
	});

	test("an end whose start was missed (a reconnect) is a recent call without arguments", () => {
		const p = new TurnProgress();
		p.note(end(1, 2, { id: "lost", tool: "grep" }));
		expect(p.calls().recentTools).toEqual([{ tool: "grep", args: "", isError: false, endMs: T0 + 2000 }]);
	});

	test("the plain tool line of a call whose structured start follows is not counted twice", () => {
		const p = new TurnProgress();
		p.note(event(1, { kind: "tool", turn: 1, at: at(0), text: 'bash {"command":"ls"}' }));
		p.note(start(2, 0, { args: '{"command":"ls"}' }));
		p.note(end(3, 1, { id: "c2" }));
		p.note(event(4, { kind: "tool", turn: 1, at: at(2), text: 'read {"path":"a"}' }));
		p.note(start(5, 2, { tool: "read", args: '{"path":"a"}' }));
		expect(p.tools).toBe(2);
		expect(p.calls().currentTool).toBe("read");
		expect(p.calls().recentTools).toHaveLength(1);
	});

	test("usage events add up: requests, tokens without cache reads, cost, and the latest context against the window", () => {
		const p = new TurnProgress();
		p.note(usage(1, 0, { cost: 0.02, context: { tokens: 1050, window: 200_000 } }));
		p.note(usage(2, 5, { cost: 0.03, context: { tokens: 2100, window: 0 } }));
		const m = p.metrics(metrics({ usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 40, cost: 0.1 }, requests: 3, tools: 5, workMs: 9000, context: { tokens: 800, window: 200_000, at: "x" } }));
		expect(m).toMatchObject({
			usage: { inputTokens: 1200, outputTokens: 240, cacheReadTokens: 6800, cacheWriteTokens: 100 },
			requests: 5,
			tools: 5,
			workMs: 9000,
			// A request that does not know the window keeps the one that did.
			context: { tokens: 2100, window: 200_000, at: at(5) },
		});
		expect(m?.usage.cost).toBeCloseTo(0.15, 10);
	});
});

describe("the plain lines beside the structured events", () => {
	test("plain tool and tool_error lines change nothing: the structured events are the calls", () => {
		const p = new TurnProgress();
		p.note(event(1, { kind: "tool", turn: 1, at: at(0), text: 'bash {"command":"bun test"}' }));
		p.note(event(2, { kind: "tool_error", turn: 1, at: at(1), text: "bash: exit 2" }));
		expect(p.tools).toBe(0);
		expect(p.calls()).toEqual({ recentTools: [] });
		expect(p.metrics(null)).toBeNull();
	});

	test("other kinds change nothing, and a turn that did nothing leaves the thread's metrics as they are", () => {
		const p = new TurnProgress();
		p.note(event(1, { kind: "assistant", turn: 1, text: "thinking" }));
		p.note(event(2, { kind: "vm", turn: null, text: "vm started" }));
		const base = metrics({ requests: 2 });
		expect(p.metrics(base)).toBe(base);
		expect(p.metrics(null)).toBeNull();
		expect(p.calls()).toEqual({ recentTools: [] });
	});
});

describe("malformed structured events", () => {
	test("text that is not an object, or names no tool, is ignored", () => {
		const p = new TurnProgress();
		p.note(event(1, { kind: "tool_start", turn: 1, text: "not json" }));
		p.note(event(2, { kind: "tool_start", turn: 1, text: '{"id":"x"}' }));
		p.note(event(3, { kind: "tool_end", turn: 1, text: "[]" }));
		p.note(event(4, { kind: "usage", turn: 1, text: "nope" }));
		expect(p.tools).toBe(0);
		expect(p.calls()).toEqual({ recentTools: [] });
		expect(p.metrics(null)).toBeNull();
	});
});
