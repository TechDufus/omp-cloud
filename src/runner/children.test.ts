import { describe, expect, test } from "bun:test";
import { isRecord } from "../guards";
import type { ThreadEvent } from "../store/types";
import { type ChildEventKind, ChildTracker } from "./children";

interface Written {
	kind: ChildEventKind;
	body: Record<string, unknown>;
	turn: number | null;
}

function parse(text: string): Record<string, unknown> {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value)) throw new Error("not a JSON object");
	return value;
}

function harness(): { tracker: ChildTracker; out: Written[]; advance: (ms: number) => void } {
	const out: Written[] = [];
	let now = 10_000;
	const tracker = new ChildTracker(
		(kind, text, turn) => out.push({ kind, body: parse(text), turn }),
		() => now,
	);
	return {
		tracker,
		out,
		advance: ms => {
			now += ms;
		},
	};
}

function toolEnd(id: string, tool: string, result: unknown, isError = false): unknown {
	return { type: "tool_execution_end", toolCallId: id, toolName: tool, result, isError };
}

function spawnedText(...pairs: [string, string][]): unknown {
	return { content: [{ type: "text", text: pairs.map(([agent, job]) => `Spawned agent \`${agent}\` (job \`${job}\`).`).join("\n") }] };
}

function bashJob(jobId: string): unknown {
	return { content: [{ type: "text", text: "running in the background" }], details: { async: { state: "running", jobId, type: "bash" } } };
}

function lifecycle(id: string, status: string, extra: Record<string, unknown> = {}): unknown {
	return { id, agent: "task", agentSource: "bundled", status, index: 0, ...extra };
}

function delivery(...jobs: Record<string, unknown>[]): unknown {
	return { type: "message_end", message: { role: "custom", customType: "async-result", content: "done", details: { jobs } } };
}

function progress(id: string, extra: Record<string, unknown> = {}): unknown {
	return { index: 0, agent: "task", agentSource: "bundled", task: "t", progress: { id, status: "running", toolCount: 1, requests: 1, tokens: 10, cost: 0.5, durationMs: 100, ...extra } };
}

describe("child_start", () => {
	test("a task call's spawn feedback starts a task child named by its agent, with the call that started it", () => {
		const { tracker, out } = harness();
		tracker.toolEnded(3, toolEnd("c2", "task", spawnedText(["AuthFix", "AuthFix"], ["Docs", "job_9"])), { tasks: [] });
		expect(out.map(w => w.kind)).toEqual(["child_start", "child_start"]);
		expect(out[0]).toEqual({
			kind: "child_start",
			turn: 3,
			body: { job: "AuthFix", agent: "AuthFix", kind: "task", label: "AuthFix", parentCall: "c2", parent: "", description: "" },
		});
		expect(out[1]?.body).toMatchObject({ job: "Docs", agent: "Docs", kind: "task" });
		expect(tracker.size).toBe(2);
	});

	test("a background bash job is labelled with its command, collapsed and clipped; an eval job with its title or first line", () => {
		const { tracker, out } = harness();
		const command = `sleep 60\n  && ${"x".repeat(400)}`;
		tracker.toolEnded(1, toolEnd("b1", "bash", bashJob("bg_1")), { command });
		tracker.toolEnded(1, toolEnd("e1", "eval", bashJob("bg_2")), { code: "print(1)\nprint(2)" });
		tracker.toolEnded(1, toolEnd("e2", "eval", bashJob("bg_3")), { title: "crunch", code: "x" });
		const [bash, evalFirst, evalTitle] = out.map(w => w.body);
		expect(bash).toMatchObject({ job: "bg_1", agent: "", kind: "bash", parentCall: "b1", parent: "" });
		expect(String(bash?.label).startsWith("sleep 60 && xxx")).toBe(true);
		expect(String(bash?.label).length).toBeLessThanOrEqual(201);
		expect(evalFirst).toMatchObject({ job: "bg_2", kind: "eval", label: "print(1)" });
		expect(evalTitle).toMatchObject({ job: "bg_3", kind: "eval", label: "crunch" });
	});

	test("a failed call, a call that left nothing running and a foreground job start nothing", () => {
		const { tracker, out } = harness();
		tracker.toolEnded(1, toolEnd("a", "task", spawnedText(["A", "A"]), true), {});
		tracker.toolEnded(1, toolEnd("b", "read", { content: [{ type: "text", text: "hello" }] }), {});
		tracker.toolEnded(1, toolEnd("c", "bash", { content: [], details: { async: { state: "completed", jobId: "bg_9", type: "bash" } } }), { command: "ls" });
		tracker.toolEnded(1, { type: "tool_execution_start", toolCallId: "d", toolName: "task" }, {});
		expect(out).toEqual([]);
	});

	test("a detached subagent's started frame starts a task child; one that blocks its parent is not a job", () => {
		const { tracker, out } = harness();
		tracker.lifecycle(2, lifecycle("Sync", "started"));
		tracker.lifecycle(2, lifecycle("Sync", "completed"));
		expect(out).toEqual([]);
		tracker.lifecycle(2, lifecycle("Bg", "started", { detached: true, parentToolCallId: "c7", description: "check the build" }));
		expect(out).toEqual([
			{ kind: "child_start", turn: 2, body: { job: "Bg", agent: "Bg", kind: "task", label: "Bg", parentCall: "c7", parent: "", description: "check the build" } },
		]);
	});

	test("a subagent that a child spawned names that child as its parent", () => {
		const { tracker, out } = harness();
		tracker.lifecycle(1, lifecycle("Outer", "started", { detached: true }));
		tracker.lifecycle(1, lifecycle("Outer.Inner", "started", { detached: true, parentToolCallId: "inner_call" }));
		tracker.lifecycle(1, lifecycle("Other.Inner", "started", { detached: true }));
		expect(out.map(w => w.body.parent)).toEqual(["", "Outer", ""]);
	});
});

describe("dedupe", () => {
	test("a task seen by its lifecycle frame and by the spawn feedback is one child, in either order", () => {
		const first = harness();
		first.tracker.lifecycle(1, lifecycle("A", "started", { detached: true }));
		first.tracker.toolEnded(1, toolEnd("c", "task", spawnedText(["A", "A"])), {});
		expect(first.out.map(w => w.kind)).toEqual(["child_start"]);

		const second = harness();
		second.tracker.toolEnded(1, toolEnd("c", "task", spawnedText(["B", "B"])), {});
		second.tracker.lifecycle(1, lifecycle("B", "started", { detached: true }));
		second.tracker.lifecycle(1, lifecycle("B", "started", { detached: true }));
		expect(second.out.map(w => w.kind)).toEqual(["child_start"]);
		expect(second.out[0]?.body.parentCall).toBe("c");
	});

	test("omp's own job id of a task, when it differs from the agent's, names the same child and ends it once", () => {
		const { tracker, out } = harness();
		tracker.lifecycle(1, lifecycle("A", "started", { detached: true }));
		tracker.toolEnded(1, toolEnd("c", "task", spawnedText(["A", "A-2"])), {});
		tracker.delivered(1, delivery({ jobId: "A-2", type: "task", status: "completed", agentId: "A", durationMs: 4000 }));
		tracker.delivered(1, delivery({ jobId: "A-2", type: "task", status: "completed", agentId: "A", durationMs: 4000 }));
		expect(out.map(w => w.kind)).toEqual(["child_start", "child_end"]);
		expect(out[1]?.body).toMatchObject({ job: "A", agent: "A", status: "completed", ms: 4000, inferred: false });
	});

	test("the delivery of a task that already ended through its lifecycle frame does not start it again, a job id that ended and starts again does", () => {
		const { tracker, out } = harness();
		tracker.lifecycle(1, lifecycle("A", "started", { detached: true }));
		tracker.lifecycle(1, lifecycle("A", "completed"));
		tracker.delivered(1, delivery({ jobId: "A", type: "task", status: "completed", agentId: "A" }));
		expect(out.map(w => w.kind)).toEqual(["child_start", "child_end"]);
		tracker.lifecycle(1, lifecycle("A", "started", { detached: true }));
		expect(out.map(w => w.kind)).toEqual(["child_start", "child_end", "child_start"]);
		expect(tracker.size).toBe(1);
	});
});

describe("child_end", () => {
	test("a subagent's end maps completed, failed and aborted, with a duration the runner measured", () => {
		const { tracker, out, advance } = harness();
		for (const id of ["A", "B", "C"]) tracker.lifecycle(1, lifecycle(id, "started", { detached: true }));
		advance(2500);
		tracker.lifecycle(1, lifecycle("A", "completed"));
		tracker.lifecycle(1, lifecycle("B", "failed"));
		tracker.lifecycle(1, lifecycle("C", "aborted"));
		const ends = out.filter(w => w.kind === "child_end").map(w => w.body);
		expect(ends).toEqual([
			{ job: "A", agent: "A", kind: "task", status: "completed", ms: 2500, error: "", inferred: false },
			{ job: "B", agent: "B", kind: "task", status: "failed", ms: 2500, error: "the subagent failed", inferred: false },
			{ job: "C", agent: "C", kind: "task", status: "cancelled", ms: 2500, error: "the subagent was aborted", inferred: false },
		]);
		expect(tracker.size).toBe(0);
	});

	test("the delivery of a background job's result ends it with omp's own status and duration", () => {
		const { tracker, out } = harness();
		tracker.toolEnded(1, toolEnd("b1", "bash", bashJob("bg_1")), { command: "make" });
		tracker.toolEnded(1, toolEnd("b2", "bash", bashJob("bg_2")), { command: "make test" });
		tracker.delivered(1, delivery({ jobId: "bg_1", type: "bash", status: "completed", durationMs: 61_000 }, { jobId: "bg_2", type: "bash", status: "failed", durationMs: 900 }));
		const ends = out.filter(w => w.kind === "child_end").map(w => w.body);
		expect(ends).toEqual([
			{ job: "bg_1", agent: "", kind: "bash", status: "completed", ms: 61_000, error: "", inferred: false },
			{ job: "bg_2", agent: "", kind: "bash", status: "failed", ms: 900, error: "the job failed", inferred: false },
		]);
	});

	test("a delivery of a job the runner never saw start writes its start and its end; other messages and events are no delivery", () => {
		const { tracker, out } = harness();
		tracker.delivered(4, { type: "message_end", message: { role: "assistant", content: "hi" } });
		tracker.delivered(4, { type: "message_start", message: { role: "custom", customType: "async-result", details: { jobs: [{ jobId: "x", type: "bash" }] } } });
		tracker.delivered(4, { type: "message_end", message: { role: "custom", customType: "other", details: { jobs: [{ jobId: "x", type: "bash" }] } } });
		expect(out).toEqual([]);
		tracker.delivered(4, delivery({ jobId: "ev_1", type: "eval", status: "cancelled", label: "crunch", durationMs: 50 }));
		expect(out.map(w => w.kind)).toEqual(["child_start", "child_end"]);
		expect(out[0]).toMatchObject({ turn: 4, body: { job: "ev_1", kind: "eval", label: "crunch" } });
		expect(out[1]?.body).toMatchObject({ status: "cancelled", error: "the job was cancelled", ms: 50 });
	});

	test("omp settled with children open: they ended without a word, which is completed and inferred", () => {
		const { tracker, out, advance } = harness();
		tracker.toolEnded(1, toolEnd("b1", "bash", bashJob("bg_1")), { command: "make" });
		advance(700);
		tracker.settled();
		tracker.settled();
		expect(out.map(w => w.kind)).toEqual(["child_start", "child_end"]);
		expect(out[1]?.body).toEqual({ job: "bg_1", agent: "", kind: "bash", status: "completed", ms: 700, error: "", inferred: true });
	});

	test("cancel ends every open child as cancelled with the reason, on the turn that spawned it", () => {
		const { tracker, out } = harness();
		tracker.toolEnded(1, toolEnd("b1", "bash", bashJob("bg_1")), { command: "make" });
		tracker.lifecycle(2, lifecycle("A", "started", { detached: true }));
		tracker.cancel("the VM was paused");
		const ends = out.filter(w => w.kind === "child_end");
		expect(ends.map(w => [w.turn, w.body.job, w.body.status, w.body.error, w.body.inferred])).toEqual([
			[1, "bg_1", "cancelled", "the VM was paused", true],
			[2, "A", "cancelled", "the VM was paused", true],
		]);
		tracker.cancel("again");
		expect(out.filter(w => w.kind === "child_end")).toHaveLength(2);
	});
});

describe("a child outliving its turn", () => {
	test("its later events carry the turn that spawned it, whatever turn the caller names then", () => {
		const { tracker, out } = harness();
		tracker.toolEnded(5, toolEnd("b1", "bash", bashJob("bg_1")), { command: "make" });
		tracker.lifecycle(5, lifecycle("A", "started", { detached: true }));
		tracker.delivered(9, delivery({ jobId: "bg_1", type: "bash", status: "completed", durationMs: 10 }));
		tracker.lifecycle(9, lifecycle("A", "completed"));
		expect(out.map(w => [w.kind, w.turn])).toEqual([
			["child_start", 5],
			["child_start", 5],
			["child_end", 5],
			["child_end", 5],
		]);
	});
});

describe("child_progress", () => {
	test("a running child's progress is written with its counters; progress of an unknown or ended child, or an ended status, is not", () => {
		const { tracker, out, advance } = harness();
		tracker.lifecycle(1, lifecycle("A", "started", { detached: true }));
		tracker.progress(progress("Nobody"));
		tracker.progress(
			progress("A", { currentTool: "bash", currentToolArgs: "make", currentToolIntent: "build", stage: "compiling", completionPercent: 41.6, contextTokens: 900, contextWindow: 200_000, requests: 3, toolCount: 4, tokens: 1234 }),
		);
		expect(out.filter(w => w.kind === "child_progress")).toEqual([
			{
				kind: "child_progress",
				turn: 1,
				body: {
					job: "A",
					agent: "A",
					tools: 4,
					requests: 3,
					tokens: 1234,
					cost: 0.5,
					tool: "bash",
					args: "make",
					intent: "build",
					stage: "compiling",
					percent: 42,
					context: { tokens: 900, window: 200_000 },
					ms: 100,
				},
			},
		]);
		advance(5000);
		tracker.progress(progress("A", { status: "completed", toolCount: 9 }));
		expect(out.filter(w => w.kind === "child_progress")).toHaveLength(1);
	});

	test("progress is throttled to one per interval and skipped when nothing it shows changed", () => {
		const { tracker, out, advance } = harness();
		tracker.lifecycle(1, lifecycle("A", "started", { detached: true }));
		const progressEvents = (): number => out.filter(w => w.kind === "child_progress").length;
		tracker.progress(progress("A", { toolCount: 1 }));
		advance(500);
		tracker.progress(progress("A", { toolCount: 2 }));
		expect(progressEvents()).toBe(1);
		advance(2000);
		tracker.progress(progress("A", { toolCount: 2 }));
		expect(progressEvents()).toBe(2);
		advance(3000);
		tracker.progress(progress("A", { toolCount: 2 }));
		expect(progressEvents()).toBe(2);
		tracker.progress(progress("A", { toolCount: 3 }));
		expect(progressEvents()).toBe(3);
	});
});

describe("restore", () => {
	function stored(seq: number, kind: string, body: Record<string, unknown>, turn: number | null, at = "2026-10-21T10:00:00.000Z"): ThreadEvent {
		return { seq, at, kind, turn, text: JSON.stringify(body) };
	}

	test("the children a thread's events left open are open again, with their turn and start, and end like any other", () => {
		const { tracker, out, advance } = harness();
		tracker.restore([
			stored(1, "child_start", { job: "bg_1", agent: "", kind: "bash", label: "make" }, 3, new Date(10_000 - 4000).toISOString()),
			stored(2, "child_start", { job: "A", agent: "A", kind: "task", label: "A" }, 3),
			stored(3, "child_end", { job: "A", status: "completed" }, 3),
			stored(4, "child_start", { job: "A", agent: "A", kind: "task", label: "A" }, 4),
			stored(5, "child_end", { job: "gone", status: "completed" }, 4),
			stored(6, "tool_end", { id: "x" }, 4),
		]);
		expect(tracker.size).toBe(2);
		expect(out).toEqual([]);
		advance(1000);
		tracker.delivered(9, delivery({ jobId: "bg_1", type: "bash", status: "completed" }));
		tracker.cancel("the VM was paused");
		expect(out.map(w => [w.kind, w.turn, w.body.job, w.body.ms])).toEqual([
			["child_end", 3, "bg_1", 5000],
			["child_end", 4, "A", expect.any(Number)],
		]);
	});

	test("an event that is not JSON, or names no job, is skipped", () => {
		const { tracker } = harness();
		tracker.restore([
			{ seq: 1, at: "2026-10-21T10:00:00.000Z", kind: "child_start", turn: 1, text: "not json" },
			stored(2, "child_start", { agent: "A", kind: "task" }, 1),
			stored(3, "child_start", { job: "A", agent: "A", kind: "weird" }, 1),
		]);
		expect(tracker.size).toBe(0);
	});
});
