import { describe, expect, test } from "bun:test";
import { EventLog, eventLines } from "../src/event-lines";
import { event } from "./builders";

let seq = 0;
const next = (kind: string, text: string) => event(++seq, { kind, turn: 1, text });
const json = (o: Record<string, unknown>) => JSON.stringify(o);

const start = (id: string, tool: string, o: { intent?: string; args?: string } = {}) => next("tool_start", json({ id, tool, intent: o.intent ?? "", args: o.args ?? "" }));
const end = (id: string, tool: string, o: { ok?: boolean; ms?: number | null; error?: string; spawned?: { agent: string; job: string }[] } = {}) =>
	next("tool_end", json({ id, tool, ok: o.ok ?? true, ms: o.ms === undefined ? 1200 : o.ms, error: o.error ?? "", async: false, detached: false, spawned: o.spawned ?? [] }));
const usage = () => next("usage", json({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, model: "m", stopReason: "stop", context: { tokens: 2, window: 100 } }));

/** The plain and structured events of one successful call, in the order the runner writes them. */
function call(id: string, tool: string, command: string, o: { ok?: boolean; ms?: number } = {}) {
	const args = json({ command });
	const ok = o.ok ?? true;
	return [next("tool", `${tool} ${args}`), start(id, tool, { args }), ...(ok ? [] : [next("tool_error", `${tool}: exit 1`)]), end(id, tool, { ok, ms: o.ms, error: ok ? "" : "exit 1" })];
}

const texts = (events: ReturnType<typeof next>[]) => eventLines(events).map(l => `${l.kind}: ${l.text}`);

describe("one line per tool call", () => {
	test("a call is its tool and what it ran, with the outcome and duration once it ends; no JSON, no duplicate line", () => {
		expect(texts(call("c1", "bash", "for i in 1 2 3; do echo $i; done"))).toEqual(["tool: bash: for i in 1 2 3; do echo $i; done · ✓ · 1s"]);
	});

	test("a call still running has no outcome yet", () => {
		const args = json({ command: "sleep 30" });
		expect(texts([next("tool", `bash ${args}`), start("c1", "bash", { args })])).toEqual(["tool: └ bash: sleep 30"]);
		// In the log of a finished turn such a call is a lost one, not a running one.
		expect(eventLines([next("tool", `bash ${args}`), start("c1", "bash", { args })], { finished: true }).map(l => l.text)).toEqual(["bash: sleep 30 · no end seen"]);
	});

	test("a failed call shows its error once, in place of the plain error line", () => {
		expect(texts(call("c1", "bash", "false", { ok: false }))).toEqual(["tool: bash: false · ✕ exit 1 · 1s"]);
	});

	test("the model's intent names the call when it gave one; a read names its path", () => {
		const a = [next("tool", "grep scanning for TODOs"), start("a", "grep", { intent: "scanning for TODOs", args: json({ pattern: "TODO" }) }), end("a", "grep", { ms: 40 })];
		const b = [next("tool", "read {}"), start("b", "read", { args: json({ path: "src/a.ts" }) }), end("b", "read", { ms: 2000 })];
		expect(texts([...a, ...b])).toEqual(["tool: grep: scanning for TODOs · ✓ · 40ms", "tool: read: src/a.ts · ✓ · 2s"]);
	});

	test("calls in sequence and overlapping each get their own line, in the order they started", () => {
		const first = [start("a", "task"), start("b", "read", { args: json({ path: "x" }) })];
		expect(texts([...first, end("b", "read", { ms: 5 }), end("a", "task", { ms: 61_000, spawned: [{ agent: "Worker", job: "j1" }] })])).toEqual(["tool: task · ✓ · 1m01s · agent Worker", "tool: read: x · ✓ · 5ms"]);
	});

	test("a tool_end whose start was never seen is a line of its own", () => {
		expect(texts([end("lost", "grep", { ms: null })])).toEqual(["tool: grep · ✓"]);
		expect(texts([next("tool_error", "bash: exit 2"), end("lost", "bash", { ok: false, error: "exit 2", ms: 100 })])).toEqual(["tool: bash · ✕ exit 2 · 100ms"]);
	});

	test("a service without structured events keeps its plain lines, in the same words", () => {
		expect(texts([next("tool", 'bash {"command":"ls"}'), next("tool", "read the config"), next("tool_error", "read: no such file")])).toEqual(["tool: bash: ls", "tool: read: the config", "tool_error: read: no such file"]);
	});
});

describe("the other kinds", () => {
	test("usage has no line, an assistant message is its first line, any other kind its text", () => {
		const events = [next("assistant", "Looking at greet.go\nsecond line"), usage(), next("vm", "vm started"), next("notice", "retry 2/4: overloaded")];
		expect(texts(events)).toEqual(["assistant: Looking at greet.go", "vm: vm started", "notice: retry 2/4: overloaded"]);
	});

	test("an empty assistant message or event leaves no line", () => {
		expect(texts([next("assistant", "  "), next("vm", "")])).toEqual([]);
	});

	test("a line carries the seq of the event it stands at", () => {
		const events = call("c1", "bash", "ls");
		expect(eventLines(events)[0]?.seq).toBe(events[0]?.seq);
	});
});

describe("EventLog", () => {
	test("keeps the newest lines, and an end still finds its call while the call is kept", () => {
		const log = new EventLog(3);
		log.push(start("a", "bash", { intent: "one" }));
		for (let i = 0; i < 2; i++) log.push(next("vm", `note ${i}`));
		log.push(end("a", "bash", { ms: 10 }));
		expect(log.lines.map(l => l.text)).toEqual(["bash: one · ✓ · 10ms", "note 0", "note 1"].slice(0, 3));
		log.push(next("vm", "note 2"));
		expect(log.lines.map(l => l.text)).toEqual(["note 0", "note 1", "note 2"]);
	});
});
