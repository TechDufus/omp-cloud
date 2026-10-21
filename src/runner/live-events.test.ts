import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import type { Store } from "../store";
import type { ThreadEvent, Turn } from "../store/types";
import { type Frame, fakeVm, fakeVmon, openEnv, promptResult, response, sandboxWithOmp, type Script, seedThread, until } from "./test-support";
import { type ThreadEnv, ThreadRunner } from "./thread";

let dir: string;
let store: Store;
let gateway: GatewayClients;
let env: ThreadEnv;
const runners: ThreadRunner[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	({ store, gateway, env } = await openEnv(dir));
});

afterEach(async () => {
	await Promise.all(runners.splice(0).map(runner => runner.detach()));
	store.close();
	await rm(dir, { recursive: true, force: true });
});

const STRUCTURED = ["tool_start", "tool_end", "usage"];

function text(content: string): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text: content }] };
}

function start(id: string, toolName: string, args: unknown, intent?: string): Frame {
	return { type: "tool_execution_start", toolCallId: id, toolName, args, ...(intent === undefined ? {} : { intent }) };
}

function end(id: string, toolName: string, result: unknown, isError = false): Frame {
	return { type: "tool_execution_end", toolCallId: id, toolName, result, isError };
}

function message(content: string, usage: Record<string, unknown>, stopReason: string): Frame {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: content }], provider: "prov", model: "mod", usage, stopReason },
	};
}

/** Runs one turn of a fake omp that answers its prompt with `frames`, and returns the turn once it ended with the events it appended. */
async function runTurn(frames: Frame[]): Promise<{ turn: Turn; events: ThreadEvent[] }> {
	const id = await seedThread(store, gateway, 1);
	const script: Script = promptId => [response(promptId, "prompt"), ...frames, promptResult(promptId, true)];
	const omp = sandboxWithOmp(fakeVm({ dirty: false, head: "a".repeat(40) }), script);
	const runner = new ThreadRunner({ ...env, vmon: fakeVmon(omp.sandbox).vmon }, id);
	runners.push(runner);
	const turn = store.enqueueTurn(id, "work", "owner");
	runner.wake();
	await until(() => ["done", "failed"].includes(store.turns(id).find(t => t.id === turn.id)?.state ?? ""), "the turn to end");
	const ended = store.turns(id).find(t => t.id === turn.id);
	if (ended === undefined) throw new Error("the turn vanished");
	return { turn: ended, events: store.events(id, 0, 1000) };
}

function json(event: ThreadEvent): Record<string, unknown> {
	return JSON.parse(event.text) as Record<string, unknown>;
}

describe("live progress events", () => {
	test("a turn's tool calls and model requests also append tool_start, tool_end and usage events next to the plain ones", async () => {
		const agents = "Spawned agent `AuthFix` (job `job_7`).";
		const { turn, events } = await runTurn([
			start("c1", "bash", { command: "bun test" }, "run tests"),
			end("c1", "bash", text("all green")),
			start("c2", "task", { tasks: [{ id: "AuthFix" }] }, "fix auth"),
			end("c2", "task", text(agents)),
			start("c3", "bash", { command: "false" }),
			end("c3", "bash", text("exit 2\nmore"), true),
			message("looking", { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, cost: { total: 0.25 } }, "toolUse"),
			message("done", { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }, "stop"),
		]);
		expect(turn.state).toBe("done");
		const own = events.filter(event => event.turn === turn.id);

		// The existing events are unchanged, in order.
		expect(own.filter(event => ["tool", "tool_error", "assistant"].includes(event.kind)).map(event => [event.kind, event.text])).toEqual([
			["tool", "bash run tests"],
			["tool", "task fix auth"],
			["tool", 'bash {"command":"false"}'],
			["tool_error", "bash: exit 2"],
			["assistant", "looking"],
			["assistant", "done"],
		]);

		// The structured events interleave with them in the order omp's frames came.
		const relevant = own.filter(event => ["tool", "tool_error", "assistant", ...STRUCTURED].includes(event.kind));
		expect(relevant.map(event => event.kind)).toEqual([
			"tool",
			"tool_start",
			"tool_end",
			"tool",
			"tool_start",
			"tool_end",
			"tool",
			"tool_start",
			"tool_error",
			"tool_end",
			"assistant",
			"usage",
			"assistant",
			"usage",
		]);

		const starts = own.filter(event => event.kind === "tool_start").map(json);
		expect(starts).toEqual([
			{ id: "c1", tool: "bash", intent: "run tests", args: '{"command":"bun test"}' },
			{ id: "c2", tool: "task", intent: "fix auth", args: '{"tasks":[{"id":"AuthFix"}]}' },
			{ id: "c3", tool: "bash", intent: "", args: '{"command":"false"}' },
		]);

		const ends = own.filter(event => event.kind === "tool_end").map(json);
		expect(ends).toHaveLength(3);
		const [bash, task, failed] = ends;
		expect(bash).toMatchObject({ id: "c1", tool: "bash", ok: true, error: "", async: false, detached: false, spawned: [] });
		expect(Number.isInteger(bash?.ms) && (bash?.ms as number) >= 0).toBe(true);
		expect(task).toMatchObject({ id: "c2", tool: "task", ok: true, error: "", async: true, detached: true, spawned: [{ agent: "AuthFix", job: "job_7" }] });
		expect(Number.isInteger(task?.ms) && (task?.ms as number) >= 0).toBe(true);
		expect(failed).toMatchObject({ id: "c3", tool: "bash", ok: false, error: "exit 2", async: false, detached: false, spawned: [] });
		expect(Number.isInteger(failed?.ms) && (failed?.ms as number) >= 0).toBe(true);

		// One usage event per model request; the harness's get_state reports a 200000 window.
		const usages = own.filter(event => event.kind === "usage").map(json);
		expect(usages).toEqual([
			{ input: 10, output: 5, cacheRead: 100, cacheWrite: 20, cost: 0.25, model: "prov/mod", stopReason: "toolUse", context: { tokens: 135, window: 200_000 } },
			{ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5, model: "prov/mod", stopReason: "stop", context: { tokens: 10, window: 200_000 } },
		]);
		const summed = usages.reduce((sum, usage) => sum + (usage.cost as number), 0);
		expect(turn.usage?.cost).toBeCloseTo(summed, 10);

		const seqs = events.map(event => event.seq);
		expect(seqs).toEqual(seqs.map((_, i) => i + 1));
	});

	test("a tool end whose start was never seen has ms null", async () => {
		const { turn, events } = await runTurn([end("lost", "read", text("contents"))]);
		const ends = events.filter(event => event.turn === turn.id && event.kind === "tool_end").map(json);
		expect(ends).toEqual([{ id: "lost", tool: "read", ok: true, ms: null, error: "", async: false, detached: false, spawned: [] }]);
	});

	test("structured events stay whole JSON: long arguments are clipped and a long spawn list is not cut at 500 characters", async () => {
		const id = (n: number, letter: string): string => `${letter}${n.toString().padStart(2, "0")}${"x".repeat(57)}`;
		const listing = Array.from({ length: 16 }, (_, n) => `- \`${id(n, "a")}\` (job \`${id(n, "j")}\`)`).join("\n");
		const { turn, events } = await runTurn([
			start("c1", "bash", { command: "y".repeat(5000) }),
			start("c2", "task", {}),
			end("c2", "task", text(`Started 16 agents:\n${listing}`)),
		]);
		const own = events.filter(event => event.turn === turn.id);

		const started = own.find(event => event.kind === "tool_start" && json(event).id === "c1");
		expect(started).toBeDefined();
		const args = json(started as ThreadEvent).args as string;
		expect(typeof args).toBe("string");
		expect(args.length).toBeGreaterThan(0);
		expect(args.length).toBeLessThan(230);

		const finished = own.find(event => event.kind === "tool_end" && json(event).id === "c2") as ThreadEvent;
		expect(finished.text.length).toBeGreaterThan(500);
		const spawned = json(finished).spawned as { agent: string; job: string }[];
		expect(spawned).toHaveLength(16);
		expect(spawned[15]).toEqual({ agent: id(15, "a"), job: id(15, "j") });
		expect(json(finished)).toMatchObject({ async: true, detached: true });
	});
});
