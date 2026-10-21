import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import { isRecord } from "../guards";
import type { Store } from "../store";
import type { ThreadEvent, Turn } from "../store/types";
import { assistantEnd, type Frame, fakeVm, fakeVmon, type FakeOmp, openEnv, promptResult, response, sandboxWithOmp, type Script, seedThread, until } from "./test-support";
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

function body(event: ThreadEvent): Record<string, unknown> {
	const value: unknown = JSON.parse(event.text);
	if (!isRecord(value)) throw new Error("not a JSON object");
	return value;
}

function childEvents(id: string): ThreadEvent[] {
	return store.events(id, 0, 1000).filter(event => event.kind.startsWith("child_"));
}

function toolStart(id: string, tool: string, args: unknown): Frame {
	return { type: "tool_execution_start", toolCallId: id, toolName: tool, args };
}

function toolEnd(id: string, tool: string, result: unknown): Frame {
	return { type: "tool_execution_end", toolCallId: id, toolName: tool, result, isError: false };
}

const BASH_JOB = (jobId: string): unknown => ({ content: [{ type: "text", text: "started" }], details: { async: { state: "running", jobId, type: "bash" } } });

function lifecycle(id: string, status: string, extra: Record<string, unknown> = {}): Frame {
	return { type: "subagent_lifecycle", payload: { id, agent: "task", agentSource: "bundled", status, index: 0, ...extra } };
}

function asyncResult(...jobs: Record<string, unknown>[]): Frame {
	return { type: "message_end", message: { role: "custom", customType: "async-result", content: "done", details: { jobs } } };
}

/** Plays a turn of a fake omp that answers its prompt with `frames` and then settles; returns once the turn ended. */
async function runTurn(frames: Frame[], settleTurn = true): Promise<{ id: string; turn: Turn; omp: FakeOmp; runner: ThreadRunner }> {
	const id = await seedThread(store, gateway, 1);
	const script: Script = promptId => [response(promptId, "prompt"), ...frames, assistantEnd("ok"), ...(settleTurn ? [promptResult(promptId, true)] : [])];
	const omp = sandboxWithOmp(fakeVm({ dirty: false, head: "a".repeat(40) }), script);
	const runner = new ThreadRunner({ ...env, vmon: fakeVmon(omp.sandbox).vmon }, id);
	runners.push(runner);
	const turn = store.enqueueTurn(id, "work", "owner");
	runner.wake();
	await until(() => ["done", "failed"].includes(store.turns(id).find(t => t.id === turn.id)?.state ?? ""), "the turn to end");
	return { id, turn, omp, runner };
}

describe("child events of a running turn", () => {
	test("omp is asked for subagent frames, and a turn's jobs and subagents are written as child_start, child_progress and child_end", async () => {
		const { id, turn, omp } = await runTurn([
			toolStart("c1", "bash", { command: "sleep 60" }),
			toolEnd("c1", "bash", BASH_JOB("bg_1")),
			lifecycle("AuthFix", "started", { detached: true, parentToolCallId: "c2", description: "fix auth" }),
			toolStart("c2", "task", { tasks: [] }),
			toolEnd("c2", "task", { content: [{ type: "text", text: "Spawned agent `AuthFix` (job `AuthFix`)." }] }),
			{ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "t", progress: { id: "AuthFix", status: "running", toolCount: 3, requests: 2, tokens: 1200, cost: 0.01, currentTool: "bash", durationMs: 5000 } } },
			lifecycle("AuthFix", "completed", { detached: true }),
			asyncResult({ jobId: "bg_1", type: "bash", status: "completed", label: "sleep 60", durationMs: 61_000 }),
		]);

		expect(omp.frames.some(frame => frame.type === "set_subagent_subscription" && frame.level === "progress")).toBe(true);

		const events = childEvents(id);
		expect(events.map(event => event.kind)).toEqual(["child_start", "child_start", "child_progress", "child_end", "child_end"]);
		expect(events.every(event => event.turn === turn.id)).toBe(true);
		expect(events.map(body)).toEqual([
			{ job: "bg_1", agent: "", kind: "bash", label: "sleep 60", parentCall: "c1", parent: "", description: "" },
			{ job: "AuthFix", agent: "AuthFix", kind: "task", label: "AuthFix", parentCall: "c2", parent: "", description: "fix auth" },
			{ job: "AuthFix", agent: "AuthFix", tools: 3, requests: 2, tokens: 1200, cost: 0.01, tool: "bash", args: "", intent: "", stage: "", percent: null, context: null, ms: 5000 },
			expect.objectContaining({ job: "AuthFix", kind: "task", status: "completed", error: "", inferred: false }),
			{ job: "bg_1", agent: "", kind: "bash", status: "completed", ms: 61_000, error: "", inferred: false },
		]);
	});

	test("a child that outlives its turn is tracked on: its end lands on the turn that spawned it, with the thread idle", async () => {
		const { id, turn, omp } = await runTurn([toolStart("c1", "bash", { command: "make" }), toolEnd("c1", "bash", BASH_JOB("bg_1")), lifecycle("Bg", "started", { detached: true })]);
		expect(store.turns(id).find(t => t.id === turn.id)?.state).toBe("done");
		expect(childEvents(id).map(event => event.kind)).toEqual(["child_start", "child_start"]);

		omp.emit([lifecycle("Bg", "started", { detached: true }), lifecycle("Bg", "aborted", { detached: true }), asyncResult({ jobId: "bg_1", type: "bash", status: "completed", durationMs: 90 })]);
		await until(() => childEvents(id).length === 4, "the children's ends");

		const ends = childEvents(id).filter(event => event.kind === "child_end");
		expect(ends.map(event => [event.turn, body(event).job, body(event).status, body(event).inferred])).toEqual([
			[turn.id, "Bg", "cancelled", false],
			[turn.id, "bg_1", "completed", false],
		]);
	});

	test("omp reporting itself settled ends a child nobody reported as an inferred completion", async () => {
		const { id, turn, omp } = await runTurn([toolStart("c1", "bash", { command: "make" }), toolEnd("c1", "bash", BASH_JOB("bg_1"))]);
		omp.emit([{ type: "session_settled" }]);
		await until(() => childEvents(id).length === 2, "the inferred end");
		const end = childEvents(id)[1];
		expect(end?.turn).toBe(turn.id);
		expect(end === undefined ? null : body(end)).toMatchObject({ job: "bg_1", status: "completed", inferred: true, error: "" });
	});
});

describe("children and the VM's pause", () => {
	test("a service that restarted with a child open reads it back, and pausing the VM ends it cancelled, on its turn", async () => {
		const { id, turn, omp, runner } = await runTurn([toolStart("c1", "bash", { command: "make" }), toolEnd("c1", "bash", BASH_JOB("bg_1"))]);
		await runner.detach();
		expect(childEvents(id).map(event => event.kind)).toEqual(["child_start"]);

		const restarted = new ThreadRunner({ ...env, config: { ...env.config, runner: { ...env.config.runner, idleTimeoutSeconds: 1 } }, vmon: fakeVmon(omp.sandbox).vmon }, id);
		runners.push(restarted);
		restarted.scheduleIdle();
		await until(() => store.vm(id)?.state === "paused", "the VM to pause", 6000);

		const events = childEvents(id);
		expect(events.map(event => event.kind)).toEqual(["child_start", "child_end"]);
		expect(events[1]?.turn).toBe(turn.id);
		expect(events[1] === undefined ? null : body(events[1])).toMatchObject({ job: "bg_1", kind: "bash", status: "cancelled", error: "the VM was paused", inferred: true });
	});
});
