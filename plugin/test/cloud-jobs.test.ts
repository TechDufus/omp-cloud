import { afterEach, describe, expect, test } from "bun:test";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobError, AsyncJobManager, type AsyncJob, type AsyncJobDetails } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { JobWidgetRegistry } from "@oh-my-pi/pi-coding-agent/job-widgets/types";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { CARD_VERSION, type CardDetails } from "../src/cards";
import { cloudErrorFromStatus } from "../src/errors";
import { isRecord } from "../src/guards";
import { turnPayload } from "../src/cloud-agents";
import { CloudJobs, STALE_STAGE, type JobManager, type JobSettled } from "../src/cloud-jobs";
import { Deliverer } from "../src/deliver";
import type { ThreadDetail, ThreadTurn } from "../src/types";
import { Watcher, type WatchApi, type WatchSink } from "../src/watch";
import { detail, event, metrics, pending, turn } from "./builders";
import { Feed } from "./feed";
import { fakeHost, fakePi, lastLines, until, type FakeHost } from "./fakes";

const ID = "aaaaaak3x9fa";
const JOB = "FixGreetingBug";

/** A running turn 1 of a named thread. */
const running = (over: Partial<ThreadDetail> = {}): ThreadDetail =>
	detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", model: "anthropic/claude-sonnet-5-5", turns: [turn(1, { state: "running", text: "fix the greeting bug" })], ...over });

/** The thread once turn 1 ended in `state`. */
const ended = (state: "done" | "failed" | "cancelled", over: Partial<ThreadTurn> = {}): ThreadDetail =>
	detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "idle", turns: [turn(1, { state, title: "Greeting fixed", reply: "All done.", error: "boom", ...over })] });

/** The first progress record of a job's `reportProgress` details: undefined when there is none. */
function progressOf(details: AsyncJobDetails | undefined): Record<string, unknown> | undefined {
	const list = details?.progress;
	const first: unknown = Array.isArray(list) ? list[0] : undefined;
	return isRecord(first) ? first : undefined;
}

interface Registered {
	id: string;
	type: string;
	label: string;
	ownerId: string | undefined;
	agentId: string | undefined;
	/** What the job's run returned or its `AsyncJobError` carried as structured data. */
	structured: unknown;
	status: "running" | "completed" | "failed" | "cancelled";
	result: string | undefined;
	error: string | undefined;
	/** What the job reported through `reportProgress`, oldest first. */
	reports: { text: string; details: AsyncJobDetails | undefined }[];
	abort: AbortController;
	settled: Promise<void>;
}

interface FakeManagerOptions {
	/** The manager reports itself at capacity. */
	full?: boolean;
	/** The manager refuses a registration (it filled since the capacity check). */
	refuse?: boolean;
}

interface FakeManager {
	manager: JobManager;
	jobs: Registered[];
	/** Jobs whose delivery the plugin acknowledged. */
	acknowledged: string[];
	/** Jobs a `wait` is blocked on. */
	watched: Set<string>;
}

/** A job manager that runs the job's body at once, like omp's, and records what the plugin did to it. */
function fakeManager(over: FakeManagerOptions = {}): FakeManager {
	const jobs: Registered[] = [];
	const acknowledged: string[] = [];
	const watched = new Set<string>();
	const manager: JobManager = {
		widgets: undefined,
		getJob: id => jobs.find(j => j.id === id && j.status === "running") as unknown as AsyncJob | undefined,
		get atCapacity() {
			return over.full === true;
		},
		register(type, label, run, options) {
			if (over.refuse) throw new Error("Background job limit reached (15).");
			const abort = new AbortController();
			const job: Registered = { id: options?.id ?? `bg_${jobs.length + 1}`, type, label, ownerId: options?.ownerId, agentId: options?.agentId, status: "running", result: undefined, error: undefined, structured: undefined, reports: [], abort, settled: Promise.resolve() };
			job.settled = run({
				jobId: job.id,
				signal: abort.signal,
				reportProgress: async (text, details) => void job.reports.push({ text, details }),
				markRunning: () => {},
			}).then(
				outcome => {
					if (job.status === "running") job.status = "completed";
					job.result = typeof outcome === "string" ? outcome : outcome.text;
					job.structured = typeof outcome === "string" ? undefined : outcome.structured;
				},
				(e: unknown) => {
					if (job.status === "running") job.status = "failed";
					job.error = e instanceof Error ? e.message : String(e);
					job.structured = e instanceof AsyncJobError ? e.structured : undefined;
				},
			);
			jobs.push(job);
			return job.id;
		},
		cancel(id) {
			const job = jobs.find(j => j.id === id);
			if (!job || job.status !== "running") return false;
			job.status = "cancelled";
			job.abort.abort();
			return true;
		},
		acknowledgeDeliveries(ids) {
			acknowledged.push(...ids);
			return ids.length;
		},
		isDeliverySuppressed: id => watched.has(id) || acknowledged.includes(id),
	};
	return { manager, jobs, acknowledged, watched };
}

interface RigOptions extends FakeManagerOptions {
	/** The agent id of a thread, as `CloudAgents.agentId` answers; without it the plugin names the job itself. */
	agentId?: (thread: string) => string | undefined;
	/** Whether the turn's reply is on its way to the agent that woke the thread, as `CloudAgents.relayed` answers. */
	relayed?: (thread: string, turn: number) => boolean;
}

interface Rig {
	jobs: CloudJobs;
	fake: FakeManager;
	warnings: string[];
	/** The threads whose cloud turn the plugin was asked to stop. */
	stops: string[];
	/** The cancels the model was told about: thread and label. */
	asides: [string, string][];
	/** Holds the manager the plugin sees; undefined is a host without one. */
	present: { manager: JobManager | undefined };
	/** Whether the threads' cards wake the model. */
	wakes: { value: boolean };
	/** The frames the jobs published on omp's session bus: channel and payload. */
	frames: [string, unknown][];
}

function rig(over: RigOptions = {}): Rig {
	const fake = fakeManager(over);
	const warnings: string[] = [];
	const stops: string[] = [];
	const asides: Rig["asides"] = [];
	const present: Rig["present"] = { manager: fake.manager };
	const wakes: Rig["wakes"] = { value: true };
	const frames: Rig["frames"] = [];
	const jobs = new CloudJobs({
		manager: () => present.manager,
		wakes: () => wakes.value,
		...(over.agentId ? { agentId: over.agentId } : {}),
		...(over.relayed ? { relayed: over.relayed } : {}),
		warn: message => void warnings.push(message),
		stop: thread => void stops.push(thread),
		aside: (thread, label) => void asides.push([thread, label]),
		events: () => ({ emit: (channel, data) => void frames.push([channel, data]) }),
	});
	return { jobs, fake, warnings, stops, asides, present, wakes, frames };
}

describe("registering the running turn", () => {
	test("a running turn becomes a task job of the main agent, named and labelled after the thread", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		expect(r.fake.jobs).toHaveLength(1);
		expect(r.fake.jobs[0]).toMatchObject({ id: JOB, type: "task", label: JOB, agentId: JOB, ownerId: "Main", status: "running" });
		expect(r.jobs.jobId(ID)).toBe(JOB);
		expect(r.jobs.has(ID)).toBe(true);
	});

	test("an unnamed thread's job is its title's words, labelled with its title", () => {
		const r = rig();
		r.jobs.sync(running({ name: "" }), []);
		expect(r.fake.jobs[0]).toMatchObject({ id: "AddGreet", label: "AddGreet", agentId: "AddGreet" });
	});

	test("a queued turn registers too, a running one wins over it, and a thread with no active turn registers nothing", () => {
		const queued = rig();
		queued.jobs.sync(detail({ id: ID, name: "Fix greeting bug", phase: "starting", turns: [turn(1, { state: "queued" })] }), []);
		expect(queued.fake.jobs).toHaveLength(1);

		const both = rig();
		both.jobs.sync(detail({ id: ID, name: "Fix greeting bug", turns: [turn(1, { state: "queued", text: "later" }), turn(2, { state: "running", text: "now" })] }), []);
		expect(progressOf(both.fake.jobs[0]?.reports.at(-1)?.details)).toMatchObject({ task: "now" });

		const idle = rig();
		idle.jobs.sync(detail({ id: ID, phase: "idle", turns: [turn(1)] }), []);
		expect(idle.fake.jobs).toHaveLength(0);
		expect(idle.jobs.jobId(ID)).toBeUndefined();
	});

	test("syncing again keeps the one job", () => {
		const r = rig();
		for (let i = 0; i < 3; i++) r.jobs.sync(running(), []);
		expect(r.fake.jobs).toHaveLength(1);
	});

	test("the job reports the turn's task, its stage and what is worth watching in omp's task shape", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		const progress = progressOf(r.fake.jobs[0]?.reports.at(-1)?.details);
		expect(progress).toMatchObject({ task: "fix the greeting bug", stage: "working" });
		expect(String(progress?.watch)).toContain("context");
		expect(String(progress?.watch)).toContain("cost");
	});

	test("with the thread's agent id the job's label and agentId are it, and its own id stays the first free one", async () => {
		const r = rig({ agentId: thread => (thread === ID ? "Scout" : undefined) });
		r.jobs.sync(running(), []);
		expect(r.fake.jobs[0]).toMatchObject({ id: "Scout", label: "Scout", agentId: "Scout", ownerId: "Main" });
		expect(r.jobs.jobId(ID)).toBe("Scout");

		// The manager holds "Scout" still (omp keeps a finished job for a while): the next turn's job is Scout-2, the same agent.
		const held = rig({ agentId: () => "Scout" });
		held.jobs.sync(running(), []);
		held.jobs.sync(running({ id: "bbbbbbq9w8e7" }), []);
		expect(held.fake.jobs.map(j => [j.id, j.label, j.agentId])).toEqual([["Scout", "Scout", "Scout"], ["Scout-2", "Scout", "Scout"]]);
		expect(held.jobs.jobId("bbbbbbq9w8e7")).toBe("Scout-2");
	});

	test("without the option the job's label, agentId and id are all the thread's job name", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		expect(r.fake.jobs[0]).toMatchObject({ id: JOB, label: JOB, agentId: JOB });
	});

	test("a new turn after the old one ended is a new job; an old job whose turn vanished is ended", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.sync(detail({ id: ID, name: "Fix greeting bug", turns: [turn(1), turn(2, { state: "running" })] }), []);
		expect(r.fake.jobs).toHaveLength(2);
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.status).toBe("completed");
		expect(r.fake.acknowledged).toContain(JOB);
	});
});

describe("no job", () => {
	test("no manager: nothing is registered and nothing throws; a manager that appears later gets the job on the next sync", () => {
		const r = rig();
		r.present.manager = undefined;
		r.jobs.sync(running(), []);
		r.jobs.event(running(), [], event(1, { kind: "tool", text: "bash: ls" }));
		expect(r.jobs.jobId(ID)).toBeUndefined();
		expect(r.fake.jobs).toHaveLength(0);
		r.present.manager = r.fake.manager;
		r.jobs.sync(running(), []);
		expect(r.fake.jobs).toHaveLength(1);
	});

	test("a full manager gets no job", () => {
		const r = rig({ full: true });
		r.jobs.sync(running(), []);
		expect(r.fake.jobs).toHaveLength(0);
		expect(r.jobs.has(ID)).toBe(false);
	});

	test("a manager that fills between the check and the registration gets no job and no error", () => {
		const r = rig({ refuse: true });
		r.jobs.sync(running(), []);
		expect(r.fake.jobs).toHaveLength(0);
		expect(r.jobs.has(ID)).toBe(false);
	});

	test("settling, finishing and releasing a thread with no job do nothing", () => {
		const r = rig();
		expect(r.jobs.settle(ended("done"), turn(1))).toBeUndefined();
		r.jobs.finish(ended("done"));
		r.jobs.release(ID);
		expect(r.warnings).toEqual([]);
	});
});

describe("progress", () => {
	test("each event reports the stage in omp's task shape and keeps the newest lines as the job's output", () => {
		const r = rig();
		const events = [event(1, { kind: "tool", turn: 1, text: "bash: bun test" })];
		r.jobs.sync(running(), []);
		r.jobs.event(running(), events, events[0] ?? event(1));
		const last = r.fake.jobs[0]?.reports.at(-1);
		expect(last?.text).toBe("» bash: bun test");
		const progress = progressOf(last?.details);
		expect(progress).toMatchObject({ id: JOB, agent: "cloud", status: "running", stage: "» bash: bun test", toolCount: 0, resolvedModel: "anthropic/claude-sonnet-5-5", task: "fix the greeting bug" });

		const more = [...events, event(2, { kind: "assistant", turn: 1, text: "Looking at greet.go\nsecond line" })];
		r.jobs.event(running(), more, more[1] ?? event(2));
		expect(r.fake.jobs[0]?.reports.at(-1)?.text).toBe("» bash: bun test\nLooking at greet.go");
		expect(r.fake.jobs[0]?.reports.at(-1)?.details?.output).toBe("» bash: bun test\nLooking at greet.go");
	});

	test("a tool error line is marked, an event of another turn is ignored, and the stage keeps the newest activity", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.event(running(), [], event(1, { kind: "tool_error", turn: 1, text: "bash exited 1" }));
		r.jobs.event(running(), [], event(2, { kind: "tool", turn: 7, text: "read other.go" }));
		expect(r.fake.jobs[0]?.reports.at(-1)?.details?.output).toBe("! bash exited 1");
		expect(r.fake.jobs[0]?.reports).toHaveLength(2); // the registration and the tool error
	});

	test("the metrics line joins the output once per change and the counts reach the progress record", () => {
		const r = rig();
		const m = metrics({ usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, cacheWriteTokens: 200, cost: 0.42 }, requests: 7, tools: 12, context: { tokens: 19000, window: 200000, at: "x" } });
		r.jobs.sync(running({ metrics: m }), []);
		r.jobs.sync(running({ metrics: m }), []);
		expect(r.fake.jobs[0]?.reports.at(-1)?.details?.output).toBe("· context 19K / 200K · $0.42 · 7 requests · 12 tool calls");
		const progress = progressOf(r.fake.jobs[0]?.reports.at(-1)?.details);
		expect(progress).toMatchObject({ requests: 7, toolCount: 12, tokens: 1700, contextTokens: 19000, contextWindow: 200000, cost: 0.42 });
	});

	test("a thread waiting for an answer reports its question as the stage", () => {
		const r = rig();
		r.jobs.sync(running({ phase: "waiting", question: pending({ text: "Which database?" }) }), []);
		expect(r.fake.jobs[0]?.reports.at(-1)?.text).toBe("? Which database?");
	});
});

describe("settling", () => {
	test("a done turn of a thread the model started resolves the job with its result and the structured payload, and omp's own delivery is left alone: no card follows", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		const done = ended("done", { filesChanged: 1, insertions: 2, deletions: 0 });
		const finished = turn(1, { state: "done", title: "Greeting fixed", reply: "All done." });
		const settled = r.jobs.settle(done, finished);
		expect(settled).toEqual({ id: JOB, waited: false, native: true });
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.status).toBe("completed");
		const text = r.fake.jobs[0]?.result ?? "";
		expect(text).toStartWith(`<task-result id="${JOB}" agent="cloud" status="completed"`);
		expect(text).toContain("All done.");
		expect(text).toContain("result:");
		expect(r.fake.jobs[0]?.structured).toEqual({ source: "none", mode: "permissive", status: "valid", data: turnPayload(done, finished, 1500) });
		expect(r.fake.acknowledged).toEqual([]);
		expect(r.jobs.has(ID)).toBe(false);
	});

	test("the structured payload names the thread, the turn, the reply and the branch, and cuts a long reply", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.settle(ended("done"), turn(1, { state: "done", title: "Greeting fixed", reply: "x".repeat(2000) }));
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.structured).toMatchObject({ source: "none", mode: "permissive", status: "valid", data: { thread: ID, name: "Fix greeting bug", turn: 1, state: "done", title: "Greeting fixed", error: "" } });
		const data = isRecord(r.fake.jobs[0]?.structured) ? r.fake.jobs[0]?.structured.data : undefined;
		const reply = isRecord(data) ? String(data.reply) : "";
		expect(reply).toBe(`${"x".repeat(1500)}…`);
	});

	test("a failed turn of a thread the model started rejects the job with its error and the structured payload, and omp's delivery is left alone", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		const failed = ended("failed");
		const finished = turn(1, { state: "failed", title: "", error: "vm lost" });
		expect(r.jobs.settle(failed, finished)).toEqual({ id: JOB, waited: false, native: true });
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.status).toBe("failed");
		expect(r.fake.jobs[0]?.error).toStartWith(`<task-result id="${JOB}" agent="cloud" status="failed"`);
		expect(r.fake.jobs[0]?.error).toContain("vm lost");
		expect(r.fake.jobs[0]?.structured).toEqual({ source: "none", mode: "permissive", status: "valid", data: turnPayload(failed, finished, 1500) });
		expect(r.fake.acknowledged).toEqual([]);
	});

	test("a stopped turn says so, is acknowledged (the model stopped it), carries the payload and is not native", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		const stopped = ended("cancelled");
		const finished = turn(1, { state: "cancelled", title: "" });
		expect(r.jobs.settle(stopped, finished)).toEqual({ id: JOB, waited: false, native: false });
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.status).toBe("failed");
		expect(r.fake.jobs[0]?.error).toStartWith(`<task-result id="${JOB}" agent="cloud" status="cancelled"`);
		expect(r.fake.jobs[0]?.structured).toMatchObject({ data: { turn: 1, state: "cancelled" } });
		expect(r.fake.acknowledged).toEqual([JOB]);
	});

	test("a turn of a thread whose cards do not wake the model is acknowledged and not native: the cards and the inbox are its channel", async () => {
		const done = rig();
		done.wakes.value = false;
		done.jobs.sync(running(), []);
		expect(done.jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }))).toEqual({ id: JOB, waited: false, native: false });
		await done.fake.jobs[0]?.settled;
		expect(done.fake.jobs[0]?.result).toContain("All done.");
		expect(done.fake.acknowledged).toContain(JOB);

		const failed = rig();
		failed.wakes.value = false;
		failed.jobs.sync(running(), []);
		expect(failed.jobs.settle(ended("failed"), turn(1, { state: "failed", error: "vm lost" }))).toEqual({ id: JOB, waited: false, native: false });
		await failed.fake.jobs[0]?.settled;
		expect(failed.fake.jobs[0]?.status).toBe("failed");
	});

	test("a thread the user started and the model took over later settles as a pointer to the card, not native, with both channels never telling twice", async () => {
		const done = rig();
		done.wakes.value = false;
		done.jobs.sync(running(), []);
		done.jobs.adopt(ID);
		expect(done.jobs.settle(ended("done"), turn(1, { state: "done", title: "Greeting fixed", reply: "All done." }))).toEqual({ id: JOB, waited: false, native: false });
		await done.fake.jobs[0]?.settled;
		expect(done.fake.jobs[0]?.status).toBe("completed");
		expect(done.fake.jobs[0]?.result).toStartWith("Turn 1 done: Greeting fixed. The full result arrives as a [cloud] message");
		expect(done.fake.jobs[0]?.result).not.toContain("All done.");
		expect(done.fake.jobs[0]?.structured).toBeUndefined();

		const failed = rig();
		failed.wakes.value = false;
		failed.jobs.sync(running(), []);
		failed.jobs.adopt(ID);
		expect(failed.jobs.settle(ended("failed"), turn(1, { state: "failed", error: "vm lost" }))).toEqual({ id: JOB, waited: false, native: false });
		await failed.fake.jobs[0]?.settled;
		expect(failed.fake.jobs[0]?.status).toBe("failed");
		expect(failed.fake.jobs[0]?.error).toContain("arrives as a [cloud] message");
	});

	test("a turn the wake relay delivers settles as a pointer to the relay, done or failed, so a wait on it does not repeat the report; a quiet turn nothing relays keeps its full result", async () => {
		const done = rig({ relayed: (thread, t) => thread === ID && t === 1 });
		done.wakes.value = false;
		done.jobs.sync(running(), []);
		expect(done.jobs.settle(ended("done"), turn(1, { state: "done", title: "Greeting fixed", reply: "All done." }))).toEqual({ id: JOB, waited: false, native: false });
		await done.fake.jobs[0]?.settled;
		expect(done.fake.jobs[0]?.status).toBe("completed");
		expect(done.fake.jobs[0]?.result).toBe(`Turn 1 done: Greeting fixed. Its reply was delivered to you as an incoming message from agent ${JOB}; agent://${JOB} reads it again.`);
		expect(done.fake.jobs[0]?.structured).toBeUndefined();

		const failed = rig({ relayed: () => true });
		failed.wakes.value = false;
		failed.jobs.sync(running(), []);
		failed.jobs.settle(ended("failed"), turn(1, { state: "failed", error: "vm lost" }));
		await failed.fake.jobs[0]?.settled;
		expect(failed.fake.jobs[0]?.status).toBe("failed");
		expect(failed.fake.jobs[0]?.error).toContain("delivered to you as an incoming message");
		expect(failed.fake.jobs[0]?.error).not.toContain("vm lost");

		const unrelayed = rig({ relayed: () => false });
		unrelayed.wakes.value = false;
		unrelayed.jobs.sync(running(), []);
		unrelayed.jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }));
		await unrelayed.fake.jobs[0]?.settled;
		expect(unrelayed.fake.jobs[0]?.result).toContain("All done.");
	});

	test("adopting a job the model's own cards already deliver changes nothing", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.adopt(ID);
		expect(r.jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }))).toEqual({ id: JOB, waited: false, native: true });
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.result).toContain("All done.");
	});

	test("a turn that was not the job's settles nothing", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		expect(r.jobs.settle(ended("done"), turn(2))).toBeUndefined();
		expect(r.fake.jobs[0]?.status).toBe("running");
	});

	test("a thread that ended with no turn to say so fails its job with the thread's error", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.finish(detail({ id: ID, phase: "failed", error: "vm lost", turns: [] }));
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]).toMatchObject({ status: "failed", error: "vm lost" });
		expect(r.fake.acknowledged).toEqual([JOB]);
	});

	test("a model blocked in wait on the job gets the result from wait: omp's own delivery is left to wait, and no card follows", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.fake.watched.add(JOB);
		const settled = r.jobs.settle(ended("done"), turn(1, { state: "done", title: "Greeting fixed", reply: "All done." }));
		expect(settled).toEqual({ id: JOB, waited: true, native: true });
		expect(r.fake.acknowledged).toEqual([]);
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.result).toContain("All done.");
	});
});

describe("cancelling", () => {
	test("cancelling the job from omp stops the cloud turn once, tells the user and the model, and the turn is not registered again", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		expect(r.fake.manager.cancel(JOB)).toBe(true);
		expect(r.fake.manager.cancel(JOB)).toBe(false);
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.status).toBe("cancelled");
		expect(r.stops).toEqual([ID]);
		expect(r.warnings).toEqual([`☁ Fix greeting bug was cancelled in omp: its cloud turn is being stopped (k3x9fa)`]);
		expect(r.asides).toEqual([[ID, "Fix greeting bug"]]);
		expect(r.jobs.has(ID)).toBe(false);

		// The stream still says turn 1 runs until the service reports the end.
		r.jobs.sync(running(), []);
		r.jobs.event(running(), [], event(1, { kind: "tool", text: "bash: ls" }));
		expect(r.fake.jobs).toHaveLength(1);
		// The turn then ends: nothing to settle, and the next turn is a new job.
		expect(r.jobs.settle(ended("cancelled"), turn(1, { state: "cancelled" }))).toBeUndefined();
		r.jobs.sync(detail({ id: ID, name: "Fix greeting bug", turns: [turn(1, { state: "cancelled" }), turn(2, { state: "running" })] }), []);
		expect(r.fake.jobs).toHaveLength(2);
		expect(r.stops).toHaveLength(1);
		expect(r.warnings).toHaveLength(1);
	});

	test("a session switch or branch cancels the session's jobs without stopping the turn or a notice, and the next event registers the job again", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.beginTransition();
		r.fake.manager.cancel(JOB);
		await r.fake.jobs[0]?.settled;
		expect(r.stops).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.asides).toEqual([]);
		expect(r.jobs.has(ID)).toBe(false);
		r.jobs.event(running(), [], event(1, { kind: "tool", turn: 1, text: "bash: ls" }));
		expect(r.fake.jobs).toHaveLength(2);
		expect(r.jobs.has(ID)).toBe(true);
	});

	test("once the switch is over a cancel is the user's again, even inside the old window", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.beginTransition();
		r.jobs.endTransition();
		r.fake.manager.cancel(JOB);
		await r.fake.jobs[0]?.settled;
		expect(r.stops).toEqual([ID]);
		expect(r.warnings).toHaveLength(1);
		r.jobs.sync(running(), []);
		expect(r.fake.jobs).toHaveLength(1);
	});

	test("a cancel after the switch window has passed on the clock is the user's", async () => {
		let clock = 1_000;
		const fake = fakeManager();
		const stops: string[] = [];
		const jobs = new CloudJobs({ manager: () => fake.manager, wakes: () => true, warn: () => {}, stop: t => void stops.push(t), aside: () => {}, now: () => clock });
		jobs.sync(running(), []);
		jobs.beginTransition();
		clock += 6_000;
		fake.manager.cancel(JOB);
		await fake.jobs[0]?.settled;
		expect(stops).toEqual([ID]);
	});

	test("omp shutting its job manager down stops nothing, says nothing and declines nothing", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.fake.jobs[0]?.abort.abort(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		await r.fake.jobs[0]?.settled;
		expect(r.stops).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.asides).toEqual([]);
	});

	test("a job of a thread whose cards do not wake the model is acknowledged at registration and settles as not waited, even when a wait is blocked on it", async () => {
		const r = rig();
		r.wakes.value = false;
		r.jobs.sync(running(), []);
		expect(r.fake.acknowledged).toEqual([JOB]);
		r.fake.watched.add(JOB);
		expect(r.jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }))).toEqual({ id: JOB, waited: false, native: false });
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.result).toContain("All done.");
	});

	test("whether a message woke the turn is asked of the thread and the turn", () => {
		const asked: [string, number][] = [];
		const fake = fakeManager();
		const jobs = new CloudJobs({ manager: () => fake.manager, wakes: (thread, t) => (asked.push([thread, t.id]), false), warn: () => {}, stop: () => {}, aside: () => {} });
		jobs.sync(running(), []);
		expect(asked).toEqual([[ID, 1]]);
		expect(fake.acknowledged).toEqual([JOB]);
	});

	test("a job of a thread the model started is not acknowledged while it runs", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		expect(r.fake.acknowledged).toEqual([]);
	});

	test("releasing a job leaves the cloud turn running and says nothing and stops nothing; the job reads cancelled", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.release(ID);
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.status).toBe("cancelled");
		expect(r.stops).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.jobs.has(ID)).toBe(false);
	});

	test("releasing a job the manager has lost still ends it", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.present.manager = undefined;
		r.jobs.release(ID);
		expect(r.jobs.has(ID)).toBe(false);
	});
});

interface Followed {
	f: FakeHost;
	feed: Feed;
	w: Watcher;
	r: Rig;
	sink: { turns: { turn: number; job: JobSettled | undefined }[] };
	/** What the service answers next; undefined is a thread that no longer exists. */
	set(d: ThreadDetail | undefined): void;
}

/** A watcher following `initial` with the plugin's jobs in `r`. */
function follow(initial: ThreadDetail, r: Rig = rig()): Followed {
	const f = fakeHost();
	const feed = new Feed();
	let current: ThreadDetail | undefined = initial;
	const sink: Followed["sink"] = { turns: [] };
	const api: WatchApi = {
		thread: async () => {
			if (!current) throw cloudErrorFromStatus(404, "no such thread");
			return current;
		},
		events: feed.source,
	};
	const w = new Watcher(f.host, api, {
		turn: (_host, _thread, t, _events, job) => void sink.turns.push({ turn: t.id, job }),
		question: () => {},
	} satisfies WatchSink, { backoffMs: () => 1 }, { jobs: r.jobs });
	return { f, feed, w, r, sink, set: d => void (current = d) };
}

describe("the watcher with jobs", () => {
	test("a followed running turn is a job, and the widget does not repeat it as a row", async () => {
		const { f, w, r } = follow(running());
		await w.watch(ID);
		expect(r.jobs.jobId(ID)).toBe(JOB);
		expect(r.fake.jobs).toHaveLength(1);
		expect(lastLines(f)).toBeUndefined();
		expect(f.widgets.every(x => x === undefined)).toBe(true);
		expect(f.status.at(-1)).toBeUndefined();
	});

	test("without a job (no manager) the thread keeps its widget row and the footer count", async () => {
		const r = rig();
		r.present.manager = undefined;
		const { f, w } = follow(running(), r);
		await w.watch(ID);
		expect(r.jobs.jobId(ID)).toBeUndefined();
		expect(lastLines(f)?.[0]).toContain("Fix greeting bug");
		expect(f.status.at(-1)).toBe("☁ 1 working");
	});

	test("a full manager leaves the rows too", async () => {
		const { f, w } = follow(running(), rig({ full: true }));
		await w.watch(ID);
		expect(lastLines(f)?.[0]).toContain("Fix greeting bug");
	});

	test("a thread waiting for an answer is still counted in the footer, though its turn is a job", async () => {
		const { f, w } = follow(running({ phase: "waiting", question: pending({ text: "Which?" }) }));
		await w.watch(ID);
		expect(f.status.at(-1)).toBe("☁ 0 working · 1 waiting");
	});

	test("stream events feed the job; the finished turn settles it before the card is made, and the sink learns the job", async () => {
		const { feed, w, r, sink, set } = follow(running());
		await w.watch(ID);
		feed.push(ID, event(1, { kind: "tool", turn: 1, text: "bash: bun test" }));
		await until(() => r.fake.jobs[0]?.reports.at(-1)?.text === "» bash: bun test");

		set(ended("done"));
		feed.push(ID, event(2, { kind: "turn_done", turn: 1, text: "turn 1 done" }));
		await until(() => sink.turns.length === 1);
		expect(sink.turns[0]).toEqual({ turn: 1, job: { id: JOB, waited: false, native: true } });
		expect(r.fake.jobs[0]?.status).toBe("completed");
		expect(r.jobs.jobId(ID)).toBeUndefined();
	});

	test("a turn the user stops from the cloud side settles the job as stopped and posts no card", async () => {
		const { feed, w, r, sink, set } = follow(running());
		await w.watch(ID);
		set(ended("cancelled"));
		feed.push(ID, event(1, { kind: "turn_cancelled", turn: 1 }));
		await until(() => r.fake.jobs[0]?.status === "failed");
		expect(r.fake.jobs[0]?.error).toStartWith(`<task-result id="${JOB}" agent="cloud" status="cancelled"`);
		expect(sink.turns).toEqual([]);
	});

	test("a thread deleted while followed fails its job with `thread was deleted`, and the sink hears of it", async () => {
		const { feed, w, r, set } = follow(running());
		await w.watch(ID);
		set(undefined);
		feed.push(ID, event(1, { kind: "turn_done", turn: 1 }));
		await until(() => r.fake.jobs[0]?.status === "failed");
		expect(r.fake.jobs[0]?.error).toBe("thread was deleted");
		expect(r.warnings).toEqual([]);
		expect(r.jobs.jobId(ID)).toBeUndefined();
	});

	test("unwatching releases every job without a notice", async () => {
		const { w, r } = follow(running());
		await w.watch(ID);
		w.unwatch();
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.status).toBe("cancelled");
		expect(r.warnings).toEqual([]);
		expect(r.jobs.jobId(ID)).toBeUndefined();
	});

	test("watching again after a session switch re-registers a running turn", async () => {
		const { w, r } = follow(running());
		await w.watch(ID);
		r.jobs.beginTransition();
		r.fake.manager.cancel(JOB);
		await r.fake.jobs[0]?.settled;
		r.jobs.endTransition();
		await w.watch(ID);
		expect(r.fake.jobs).toHaveLength(2);
		expect(r.jobs.jobId(ID)).toBe(JOB);
		expect(r.warnings).toEqual([]);
	});

	test("watching a thread whose turn just ended settles its job and posts the turn's card, instead of leaving the job running", async () => {
		const { w, r, sink, set } = follow(running());
		await w.watch(ID);
		set(ended("done"));
		await w.watch(ID);
		expect(sink.turns).toEqual([{ turn: 1, job: { id: JOB, waited: false, native: true } }]);
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.status).toBe("completed");
		expect(r.jobs.jobId(ID)).toBeUndefined();
	});

	test("a thread that failed with no turn to say so fails its job when it is watched", async () => {
		const { w, r, sink, set } = follow(running());
		await w.watch(ID);
		set(detail({ id: ID, phase: "failed", error: "vm lost", turns: [] }));
		await w.watch(ID);
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]).toMatchObject({ status: "failed", error: "vm lost" });
		expect(sink.turns).toEqual([]);
	});
});

describe("delivery to the model", () => {
	function card(origin: "user" | "tool", idle: boolean, job?: JobSettled, relayed = false, state: "done" | "failed" = "done") {
		const pi = fakePi();
		const host = fakeHost();
		host.idle = idle;
		const d = new Deliverer(pi.pi);
		d.setOrigin(ID, origin);
		d.turn(host.host, ended(state), turn(1, { state, title: "Greeting fixed", reply: "All done.", error: "vm lost", head: "0123456789" }), [], job, relayed);
		return { pi, d, host };
	}

	test("a turn that was not a job reaches the model in full", () => {
		const { pi } = card("tool", true);
		expect(pi.sent[0]?.message.content).toContain("All done.");
		expect(pi.sent[0]?.options).toEqual({ triggerTurn: true });
	});

	test("a done or failed turn whose job delivers it (native) posts no card: omp's async-result and agent://<id> carry it", () => {
		for (const state of ["done", "failed"] as const) {
			const { pi, d } = card("tool", true, { id: JOB, waited: false, native: true }, false, state);
			expect(pi.sent).toEqual([]);
			expect(d.held).toBe(0);
		}
	});

	test("none either when a wait was blocked on the job, or while the model is busy", () => {
		expect(card("tool", true, { id: JOB, waited: true, native: true }).pi.sent).toEqual([]);
		const busy = card("tool", false, { id: JOB, waited: false, native: true });
		expect(busy.pi.sent).toEqual([]);
		expect(busy.d.held).toBe(0);
	});

	test("a turn whose reply went back to the IRC sender (relayed) posts no card, with or without a job", () => {
		expect(card("tool", true, undefined, true).pi.sent).toEqual([]);
		expect(card("user", true, undefined, true).pi.sent).toEqual([]);
		const quiet = card("tool", true, { id: JOB, waited: false, native: false }, true);
		expect(quiet.pi.sent).toEqual([]);
		expect(quiet.d.held).toBe(0);
	});

	test("a quiet job's turn (the job's delivery was acknowledged, not native) is the full card that wakes the model", () => {
		const { pi } = card("tool", true, { id: JOB, waited: false, native: false });
		expect(pi.sent[0]?.message.content).toContain("All done.");
		expect(pi.sent[0]?.options).toEqual({ triggerTurn: true });
		const shown = pi.sent[0]?.message.details as CardDetails;
		expect(shown.kind === "turn" && [shown.v, shown.reply]).toEqual([CARD_VERSION, "All done."]);
	});

	test("while the model is busy a quiet job's card is an aside, not held", () => {
		const { pi, d } = card("tool", false, { id: JOB, waited: false, native: false });
		expect(pi.sent.map(s => s.options)).toEqual([{ deliverAs: "aside" }]);
		expect(d.held).toBe(0);
	});

	test("a job adopted after the user started the thread: its result is a pointer, and the card is the full message", async () => {
		const r = rig();
		r.wakes.value = false;
		r.jobs.sync(running(), []);
		r.jobs.adopt(ID);
		const finished = turn(1, { state: "done", title: "Greeting fixed", reply: "All done.", head: "0123456789" });
		const settled = r.jobs.settle(ended("done"), finished);
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]?.result).toContain("arrives as a [cloud] message");

		const pi = fakePi();
		const host = fakeHost();
		const d = new Deliverer(pi.pi);
		d.setOrigin(ID, "tool");
		d.turn(host.host, ended("done"), finished, [], settled);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.message.content).toContain("All done.");
		expect(pi.sent[0]?.options).toEqual({ triggerTurn: true });
	});

	test("a cancelled turn posts no card whatever its job: the model stopped it and its job was acknowledged", () => {
		const pi = fakePi();
		const host = fakeHost();
		const d = new Deliverer(pi.pi);
		d.setOrigin(ID, "tool");
		d.turn(host.host, ended("cancelled"), turn(1, { state: "cancelled" }), [], { id: JOB, waited: false, native: false });
		d.turn(host.host, ended("cancelled"), turn(1, { state: "cancelled" }), []);
		expect(pi.sent).toEqual([]);
	});

	test("the model is told of a cancelled job as a quiet note with the new wording", () => {
		const pi = fakePi();
		const host = fakeHost();
		const d = new Deliverer(pi.pi);
		d.setOrigin(ID, "tool");
		d.cancelled(host.host, ID, "Fix greeting bug");
		const sent = pi.sent[0];
		expect(sent?.message.content).toContain("its job in omp was cancelled, so its cloud turn is being stopped");
		expect(sent?.message.content).not.toContain("keeps running");
		expect(sent?.message.display).toBe(false);
		expect(sent?.options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
	});
});

describe("through omp's real job manager", () => {
	let manager: AsyncJobManager | undefined;
	afterEach(async () => {
		await manager?.dispose({ timeoutMs: 100 });
		manager = undefined;
	});

	function real(wakes = true) {
		const delivered: string[] = [];
		const warnings: string[] = [];
		const stops: string[] = [];
		const m = new AsyncJobManager({ retentionMs: 60_000 });
		manager = m;
		m.registerDeliverySink("Main", id => void delivered.push(id));
		const jobs = new CloudJobs({ manager: () => m, wakes: () => wakes, warn: message => void warnings.push(message), stop: thread => void stops.push(thread), aside: () => {} });
		return { m, jobs, delivered, warnings, stops };
	}

	test("the job is listed for the main agent with its id, label, stage and progress record", () => {
		const { m, jobs } = real();
		jobs.sync(running(), [event(1, { kind: "tool", turn: 1, text: "bash: bun test" })]);
		const [job] = m.getRunningJobs({ ownerId: "Main" });
		expect(job).toMatchObject({ id: JOB, type: "task", label: JOB, agentId: JOB, status: "running" });
		expect(job?.progressText).toBe("» bash: bun test");
		expect(job?.latestDetails?.progress).toBeArray();
	});

	test("a done turn of a thread the model started is delivered by omp itself, once, with the structured payload on the job row: no card follows", async () => {
		const { m, jobs, delivered } = real();
		jobs.sync(running(), []);
		const done = ended("done");
		const finished = turn(1, { state: "done", reply: "All done." });
		expect(jobs.settle(done, finished)).toEqual({ id: JOB, waited: false, native: true });
		await m.getJob(JOB)?.promise;
		await m.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual([JOB]);
		expect(m.getJob(JOB)?.resultText).toStartWith(`<task-result id="${JOB}" agent="cloud" status="completed"`);
		expect(m.getJob(JOB)?.structured).toEqual({ source: "none", mode: "permissive", status: "valid", data: turnPayload(done, finished, 1500) });
	});

	test("a failed turn of a thread the model started fails the job with the same structured payload, and omp delivers it once", async () => {
		const { m, jobs, delivered } = real();
		jobs.sync(running(), []);
		const failed = ended("failed");
		const finished = turn(1, { state: "failed", error: "vm lost" });
		expect(jobs.settle(failed, finished)).toEqual({ id: JOB, waited: false, native: true });
		await m.getJob(JOB)?.promise.catch(() => {});
		await m.drainDeliveries({ timeoutMs: 500 });
		expect(m.getJob(JOB)?.status).toBe("failed");
		expect(m.getJob(JOB)?.errorText).toContain("vm lost");
		expect(m.getJob(JOB)?.structured).toEqual({ source: "none", mode: "permissive", status: "valid", data: turnPayload(failed, finished, 1500) });
		expect(delivered).toEqual([JOB]);
	});

	test("a stopped turn is acknowledged: omp delivers nothing of it", async () => {
		const { m, jobs, delivered } = real();
		jobs.sync(running(), []);
		expect(jobs.settle(ended("cancelled"), turn(1, { state: "cancelled" }))).toEqual({ id: JOB, waited: false, native: false });
		await m.getJob(JOB)?.promise.catch(() => {});
		await m.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual([]);
	});

	test("a turn of a thread whose cards do not wake the model is not delivered a second time by omp: the card is its one message", async () => {
		const { m, jobs, delivered } = real(false);
		jobs.sync(running(), []);
		jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }));
		await m.getJob(JOB)?.promise;
		await m.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual([]);
		expect(m.getJob(JOB)?.resultText).toStartWith(`<task-result id="${JOB}" agent="cloud" status="completed"`);
	});

	test("a job registered the plain way would be delivered: the check above does watch for a second delivery", async () => {
		const { m, delivered } = real();
		m.register("task", "plain", async () => "result", { id: "Plain", ownerId: "Main" });
		await m.getJob("Plain")?.promise;
		await m.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["Plain"]);
	});

	test("a wait blocked on the job gets the result from the job row, and omp delivers nothing", async () => {
		const { m, jobs, delivered } = real();
		jobs.sync(running(), []);
		const [blocked] = m.getRunningJobs({ ownerId: "Main" });
		m.watchJobs([JOB]);
		const settled = jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }));
		expect(settled).toEqual({ id: JOB, waited: true, native: true });
		await blocked?.promise;
		expect(m.getJob(JOB)?.resultText).toContain("All done.");
		expect(m.consumeJobResults([JOB])).toBe(1);
		m.unwatchJobs([JOB]);
		await m.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual([]);
	});

	test("a wait that was interrupted leaves the unreported result to omp's own delivery, so the model still gets it once", async () => {
		const { m, jobs, delivered } = real();
		jobs.sync(running(), []);
		m.watchJobs([JOB]);
		jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }));
		await m.getJob(JOB)?.promise;
		m.unwatchJobs([JOB]);
		await m.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual([JOB]);
	});

	test("cancelling through omp stops the cloud turn, tells the user, and the job is not registered again", async () => {
		const { m, jobs, warnings, stops } = real();
		jobs.sync(running(), []);
		expect(m.cancel(JOB, { ownerId: "Main" })).toBe(true);
		await m.getJob(JOB)?.promise;
		expect(m.getJob(JOB)?.status).toBe("cancelled");
		expect(stops).toEqual([ID]);
		expect(warnings).toEqual([`☁ Fix greeting bug was cancelled in omp: its cloud turn is being stopped (k3x9fa)`]);
		jobs.sync(running(), []);
		expect(m.getAllJobs()).toHaveLength(1);
	});

	test("omp's own shutdown of the manager cancels the job without stopping the cloud turn", async () => {
		const { m, jobs, warnings, stops } = real();
		jobs.sync(running(), []);
		const job = m.getJob(JOB);
		await m.dispose({ timeoutMs: 100 });
		await job?.promise;
		expect(stops).toEqual([]);
		expect(warnings).toEqual([]);
	});

	test("a job whose card does not wake the model is acknowledged at once: omp has nothing to deliver, so the local session is not held open, and wait still returns the result", async () => {
		const { m, jobs, delivered } = real(false);
		jobs.sync(running(), []);
		expect(m.isDeliverySuppressed(JOB)).toBe(true);
		expect(m.getDeliveryState({ ownerId: "Main" }).queued).toBe(0);
		const [blocked] = m.getRunningJobs({ ownerId: "Main" });
		m.watchJobs([JOB]);
		expect(jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }))).toEqual({ id: JOB, waited: false, native: false });
		await blocked?.promise;
		expect(m.getJob(JOB)?.resultText).toContain("All done.");
		m.unwatchJobs([JOB]);
		await m.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual([]);
	});

	test("a job whose card wakes the model stays deliverable while it runs", () => {
		const { m, jobs } = real(true);
		jobs.sync(running(), []);
		expect(m.isDeliverySuppressed(JOB)).toBe(false);
	});

	test("a second thread with the same name gets omp's suffixed id, and both are found by the plugin", () => {
		const { m, jobs } = real();
		jobs.sync(running(), []);
		jobs.sync(running({ id: "bbbbbbq9w8e7" }), []);
		expect(m.getRunningJobs({ ownerId: "Main" }).map(j => j.id)).toEqual([JOB, `${JOB}-2`]);
		expect(jobs.jobId("bbbbbbq9w8e7")).toBe(`${JOB}-2`);
		// The suffix is only the job's own id: its label and agentId are the name the thread keeps.
		expect(m.getRunningJobs({ ownerId: "Main" }).map(j => [j.label, j.agentId])).toEqual([[JOB, JOB], [JOB, JOB]]);
	});

	test("with the thread's agent id, a later turn's job is the agent's again: its label and agentId stay, its id takes the next free suffix", async () => {
		const m = new AsyncJobManager({ retentionMs: 60_000 });
		manager = m;
		const jobs = new CloudJobs({ manager: () => m, wakes: () => true, agentId: () => "Scout", warn: () => {}, stop: () => {}, aside: () => {} });
		jobs.sync(running(), []);
		jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }));
		await m.getJob("Scout")?.promise;
		jobs.sync(detail({ id: ID, name: "Fix greeting bug", turns: [turn(1), turn(2, { state: "running" })] }), []);
		expect(m.getAllJobs().map(j => [j.id, j.label, j.agentId])).toEqual([["Scout", "Scout", "Scout"], ["Scout-2", "Scout", "Scout"]]);
		expect(jobs.jobId(ID)).toBe("Scout-2");
	});

	test("the manager's capacity is respected: a full manager gives no job", () => {
		const m = new AsyncJobManager({ maxRunningJobs: 1 });
		manager = m;
		m.register("bash", "other", () => new Promise<string>(() => {}), { id: "Other", ownerId: "Main" });
		const jobs = new CloudJobs({ manager: () => m, wakes: () => true, warn: () => {}, stop: () => {}, aside: () => {} });
		jobs.sync(running(), []);
		expect(jobs.has(ID)).toBe(false);
		expect(m.getRunningJobs().map(j => j.id)).toEqual(["Other"]);
		m.cancelAll();
	});

	test("the real manager's registry is wrapped: the job's own view for the cloud job, omp's for the rest, and the wrapper goes when omp shuts the manager down", async () => {
		const m = new AsyncJobManager({ retentionMs: 60_000 });
		manager = m;
		const omp = ompRegistry();
		m.widgets = omp;
		const jobs = new CloudJobs({ manager: () => m, wakes: () => true, warn: () => {}, stop: () => {}, aside: () => {} });
		jobs.sync(second(), []);
		m.register("bash", "other", () => new Promise<string>(() => {}), { id: "Other", ownerId: "Main" });
		const [cloud] = m.getRunningJobs({ ownerId: "Main" });
		const other = m.getJob("Other");
		expect(cloud && m.widgets?.view(cloud)?.blocks[0]?.kind).toBe("grid");
		expect(other && m.widgets?.view(other)).toBeUndefined();
		expect(omp.asked).toEqual(["Other"]);
		m.cancelAll();
		await m.dispose({ timeoutMs: 100 });
		expect(m.widgets).toBeUndefined();
	});
});

describe("what `proc://<job>` shows of a running cloud job", () => {
	let manager: AsyncJobManager | undefined;
	afterEach(async () => {
		await manager?.dispose({ timeoutMs: 100 });
		manager = undefined;
	});

	function real(): { m: AsyncJobManager; jobs: CloudJobs } {
		const m = new AsyncJobManager({ retentionMs: 60_000 });
		manager = m;
		return { m, jobs: new CloudJobs({ manager: () => m, wakes: () => true, warn: () => {}, stop: () => {}, aside: () => {} }) };
	}

	test("the recent lines are the job's `output` detail, which omp's proc:// handler prints under the job's header", () => {
		const { m, jobs } = real();
		const events = [event(1, { kind: "tool", turn: 1, text: "bash: bun test" }), event(2, { kind: "assistant", turn: 1, text: "Looking at greet.go\nsecond line" })];
		jobs.sync(running(), []);
		for (const e of events) jobs.event(running(), events, e);
		expect(m.getJob(JOB)?.latestDetails?.output).toBe("» bash: bun test\nLooking at greet.go");
	});

	test("the metrics line is among them, so context and cost can be read there", () => {
		const { m, jobs } = real();
		const mt = metrics({ usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, cacheWriteTokens: 200, cost: 0.42 }, requests: 7, tools: 12, context: { tokens: 19000, window: 200000, at: "x" } });
		jobs.sync(running({ metrics: mt }), []);
		expect(m.getJob(JOB)?.latestDetails?.output).toBe("· context 19K / 200K · $0.42 · 7 requests · 12 tool calls");
	});

	test("only the newest 40 lines are kept", () => {
		const { m, jobs } = real();
		jobs.sync(running(), []);
		for (let n = 1; n <= 60; n++) jobs.event(running(), [], event(n, { kind: "tool", turn: 1, text: `read file${n}.go` }));
		const lines = String(m.getJob(JOB)?.latestDetails?.output).split("\n");
		expect(lines).toHaveLength(40);
		expect(lines[0]).toBe("» read: file21.go");
		expect(lines.at(-1)).toBe("» read: file60.go");
	});

	test("a job with nothing yet has an empty output, not a missing one", () => {
		const { m, jobs } = real();
		jobs.sync(running(), []);
		expect(m.getJob(JOB)?.latestDetails?.output).toBe("");
	});

	test("the settled turn's result is the job's text, which proc:// and the async-result carry", async () => {
		const { m, jobs } = real();
		jobs.sync(running(), []);
		jobs.settle(ended("done"), turn(1, { state: "done", title: "Greeting fixed", reply: "All done." }));
		await m.getJob(JOB)?.promise;
		expect(m.getJob(JOB)?.resultText).toStartWith(`<task-result id="${JOB}" agent="cloud" status="completed"`);
	});
});

describe("telling the model its job was cancelled", () => {
	test("a cancel from omp tells the model which thread's turn is being stopped, and the user too, and stops the cloud turn", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.fake.manager.cancel(JOB);
		await r.fake.jobs[0]?.settled;
		expect(r.asides).toEqual([[ID, "Fix greeting bug"]]);
		expect(r.stops).toEqual([ID]);
		expect(r.warnings).toEqual([`☁ Fix greeting bug was cancelled in omp: its cloud turn is being stopped (k3x9fa)`]);
	});

	test("it is said and stopped once: the declined turn is not registered, so it cannot be cancelled again", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.fake.manager.cancel(JOB);
		await r.fake.jobs[0]?.settled;
		r.jobs.sync(running(), []);
		expect(r.fake.jobs).toHaveLength(1);
		expect(r.asides).toHaveLength(1);
		expect(r.stops).toHaveLength(1);
	});

	test("omp's own cleanup on a session switch or a branch says nothing", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.beginTransition();
		r.fake.manager.cancel(JOB);
		await r.fake.jobs[0]?.settled;
		expect(r.asides).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	test("omp shutting its manager down says nothing", async () => {
		const m = new AsyncJobManager({ retentionMs: 60_000 });
		const asides: string[] = [];
		const jobs = new CloudJobs({ manager: () => m, wakes: () => true, warn: () => {}, stop: () => {}, aside: thread => void asides.push(thread) });
		jobs.sync(running(), []);
		const job = m.getJob(JOB);
		await m.dispose({ timeoutMs: 100 });
		await job?.promise;
		expect(asides).toEqual([]);
	});

	test("the plugin releasing a job (the thread is no longer followed) says nothing", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.release(ID);
		await r.fake.jobs[0]?.settled;
		expect(r.asides).toEqual([]);
	});

	test("a turn that ends normally says nothing", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.settle(ended("done"), turn(1, { state: "done", reply: "All done." }));
		expect(r.asides).toEqual([]);
	});
});

describe("a thread the session lost contact with", () => {
	test("its job's stage says so until contact returns, then reports the agent's activity again", () => {
		const r = rig();
		const events = [event(1, { kind: "tool", turn: 1, text: "bash: bun test" })];
		r.jobs.sync(running(), events);
		r.jobs.markStale(running(), events, true);
		expect(r.fake.jobs[0]?.reports.at(-1)?.text).toBe(`» bash: bun test\n${STALE_STAGE}`);
		expect(STALE_STAGE).toBe("lost contact with the cloud; retrying");
		expect(progressOf(r.fake.jobs[0]?.reports.at(-1)?.details)).toMatchObject({ stage: STALE_STAGE });
		// A refresh of the thread while contact is lost keeps the stage.
		r.jobs.sync(running(), events);
		expect(r.fake.jobs[0]?.reports.at(-1)?.text).toBe(`» bash: bun test\n${STALE_STAGE}`);
		r.jobs.markStale(running(), events, false);
		expect(r.fake.jobs[0]?.reports.at(-1)?.text).toBe("» bash: bun test");
		expect(r.fake.jobs[0]?.status).toBe("running");
	});

	test("a thread without a job has nothing to mark", () => {
		const r = rig();
		r.jobs.markStale(running(), [], true);
		expect(r.fake.jobs).toEqual([]);
	});

	test("a thread deleted from the service fails its job with the reason; a model blocked in wait is the one who got it", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.fake.watched.add(JOB);
		expect(r.jobs.fail(ID, "thread was deleted")).toEqual({ id: JOB, waited: true, native: false });
		await r.fake.jobs[0]?.settled;
		expect(r.fake.jobs[0]).toMatchObject({ status: "failed", error: "thread was deleted" });
		expect(r.fake.acknowledged).toEqual([]);
		expect(r.jobs.has(ID)).toBe(false);
	});

	test("when nobody waited on the job its own delivery is acknowledged: the card is the one message", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		expect(r.jobs.fail(ID, "thread was deleted")).toEqual({ id: JOB, waited: false, native: false });
		expect(r.fake.acknowledged).toEqual([JOB]);
	});

	test("failing a thread that has no job is nothing", () => {
		expect(rig().jobs.fail(ID, "thread was deleted")).toBeUndefined();
	});
});

/** What the dock pill, the `wait` card and `/jobs` call: omp's registry, asked for a job by its id. */
const asJob = (id: string): AsyncJob => ({ id }) as unknown as AsyncJob;

/** A registry standing for the one omp installs: it knows no job, and records every one it was asked about. */
interface OmpRegistry extends JobWidgetRegistry {
	asked: string[];
}

function ompRegistry(): OmpRegistry {
	const asked: string[] = [];
	return {
		asked,
		view: j => {
			asked.push(j.id);
			return undefined;
		},
		subscribe: () => () => {},
		forget: () => {},
		dispose: () => {},
	};
}

const at = (hhmmss: string) => `2026-10-19T${hhmmss}Z`;
/** The clock of the jobs in the view tests: two minutes into turn 2. */
const CLOCK = Date.parse(at("10:00:00"));

/** Turn 1 done and turn 2 running on the thread, with context use. */
const second = (over: Partial<ThreadDetail> = {}): ThreadDetail =>
	running({
		metrics: metrics({ usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.42 }, requests: 7, tools: 12, context: { tokens: 19_000, window: 200_000, at: at("09:59:00") }, turns: [{ n: 1, cost: 0.2, contextTokens: 9_000 }] }),
		turns: [turn(1, { state: "done", startedAt: at("09:50:00"), completedAt: at("09:51:12") }), turn(2, { state: "running", startedAt: at("09:58:00"), completedAt: "", text: "now the tests" })],
		...over,
	});

describe("the view omp's tiles draw for a running cloud job", () => {
	/** A rig on a fixed clock whose manager has an omp registry, and the registry the surfaces ask. */
	function withWidgets(): { r: Rig; omp: OmpRegistry; view: () => JobWidgetView | undefined } {
		const r = rig();
		const omp = ompRegistry();
		r.fake.manager.widgets = omp;
		r.jobs = new CloudJobs({ manager: () => r.fake.manager, wakes: () => true, warn: () => {}, stop: () => {}, aside: () => {}, now: () => CLOCK });
		return { r, omp, view: () => r.fake.manager.widgets?.view(asJob(JOB)) };
	}

	test("the turns as dots first, then their durations, the context meter and the stats, from the thread's own data", () => {
		const { r, omp, view } = withWidgets();
		r.jobs.sync(second(), []);
		const w = view();
		expect(w?.state).toBe("live");
		expect(w?.blocks.map(b => b.kind)).toEqual(["grid", "bars", "meter", "stat"]);
		const grid = w?.blocks[0];
		expect(grid?.kind === "grid" && grid.items.map(i => [i.label, i.tone])).toEqual([["1", "success"], ["2", "pending"]]);
		expect(w).toMatchObject({ title: JOB, headline: { text: "10%", label: "context" }, stage: "working" });
		// omp's own registry, which would start a cheap model writing a spec, is never asked about it.
		expect(omp.asked).toEqual([]);
	});

	test("each event moves the stage, and every surface that listens repaints", () => {
		const { r, view } = withWidgets();
		const events = [event(1, { kind: "tool", turn: 2, text: "bash: bun test" })];
		r.jobs.sync(second(), []);
		let repaints = 0;
		r.fake.manager.widgets?.subscribe(() => void repaints++);
		r.jobs.event(second(), events, events[0] ?? event(1));
		expect(view()?.stage).toBe("» bash: bun test");
		expect(repaints).toBe(1);
		// An event that changes nothing the view shows repaints nothing.
		r.jobs.event(second(), events, event(2, { kind: "vm", turn: null, text: "vm resumed" }));
		expect(repaints).toBe(1);
	});

	test("a question is the stage and the lost contact is too", () => {
		const { r, view } = withWidgets();
		r.jobs.sync(second({ phase: "waiting", question: pending({ text: "Which database?" }) }), []);
		expect(view()?.stage).toBe("? Which database?");
		r.jobs.markStale(second(), [], true);
		expect(view()?.stage).toBe(STALE_STAGE);
	});

	test("the finished turn keeps its final view: every dot settled, the turn's title as the stage", async () => {
		const { r, view } = withWidgets();
		r.jobs.sync(running(), []);
		r.jobs.settle(ended("done"), turn(1, { state: "done", title: "Greeting fixed", reply: "All done." }));
		await r.fake.jobs[0]?.settled;
		const w = view();
		expect(w?.stage).toBe("Greeting fixed");
		expect(w?.state).toBe("live");
		const grid = w?.blocks[0];
		expect(grid?.kind === "grid" && grid.items.map(i => i.tone)).toEqual(["success"]);
		expect(r.jobs.has(ID)).toBe(false);
	});

	test("a failed turn's final view has the red dot and its error; a stopped one says so", () => {
		const failed = withWidgets();
		failed.r.jobs.sync(running(), []);
		failed.r.jobs.settle(ended("failed"), turn(1, { state: "failed", error: "spend cap reached" }));
		expect(failed.view()?.stage).toBe("spend cap reached");
		const grid = failed.view()?.blocks[0];
		expect(grid?.kind === "grid" && grid.items.map(i => i.tone)).toEqual(["error"]);

		const stopped = withWidgets();
		stopped.r.jobs.sync(running(), []);
		stopped.r.jobs.settle(ended("cancelled"), turn(1, { state: "cancelled" }));
		expect(stopped.view()?.stage).toBe("stopped");
		const stoppedGrid = stopped.view()?.blocks[0];
		expect(stoppedGrid?.kind === "grid" && stoppedGrid.items.map(i => i.tone)).toEqual(["warning"]);
	});

	test("a thread that failed outside a turn or was deleted leaves its last view with the reason", () => {
		const finished = withWidgets();
		finished.r.jobs.sync(second(), []);
		finished.r.jobs.finish(second({ phase: "failed", error: "vm lost" }));
		expect(finished.view()?.stage).toBe("vm lost");
		expect(finished.view()?.blocks.map(b => b.kind)).toEqual(["grid", "bars", "meter", "stat"]);

		const gone = withWidgets();
		gone.r.jobs.sync(second(), []);
		gone.r.jobs.fail(ID, "thread was deleted");
		expect(gone.view()?.stage).toBe("thread was deleted");
	});

	test("omp forgetting the evicted job drops its view", () => {
		const { r, view } = withWidgets();
		r.jobs.sync(second(), []);
		expect(view()).toBeDefined();
		r.fake.manager.widgets?.forget(JOB);
		expect(view()).toBeUndefined();
	});

	test("a registry omp replaces is wrapped too, and a host without one has no view and no failure", () => {
		const { r, view } = withWidgets();
		r.jobs.sync(second(), []);
		const replacement = ompRegistry();
		r.fake.manager.widgets = replacement;
		expect(view()?.title).toBe(JOB);
		expect(replacement.asked).toEqual([]);

		const bare = rig();
		bare.jobs.sync(second(), []);
		expect(bare.fake.manager.widgets).toBeUndefined();
		expect(bare.fake.jobs).toHaveLength(1);
		// The registry arrives later: the next report puts the view in.
		const late = ompRegistry();
		bare.fake.manager.widgets = late;
		const e = event(1, { kind: "tool", turn: 2, text: "read a.go" });
		bare.jobs.event(second(), [e], e);
		expect(bare.fake.manager.widgets?.view(asJob(JOB))?.stage).toBe("» read: a.go");
		expect(late.asked).toEqual([]);
	});
});

describe("the live tail a running job reports for the panel's Output box", () => {
	const tool = (n: number, text = `read file${n}.go`) => event(n, { kind: "tool", turn: 1, text });
	const last = (r: Rig): string | undefined => r.fake.jobs[0]?.reports.at(-1)?.text;

	test("the recent tool calls, the agent's lines and tool errors, each report replacing the last", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		expect(last(r)).toBe("working");
		const events = [tool(1, "bash: bun test"), event(2, { kind: "assistant", turn: 1, text: "Looking at greet.go\nsecond line" }), event(3, { kind: "tool_error", turn: 1, text: "bash: exit 1" })];
		r.jobs.event(running(), events.slice(0, 1), events[0] ?? tool(1));
		expect(last(r)).toBe("» bash: bun test");
		r.jobs.event(running(), events.slice(0, 2), events[1] ?? tool(2));
		expect(last(r)).toBe("» bash: bun test\nLooking at greet.go");
		r.jobs.event(running(), events, events[2] ?? tool(3));
		expect(last(r)).toBe("» bash: bun test\nLooking at greet.go\n! bash: exit 1");
	});

	test("at most 16 lines: the newest", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		for (let n = 1; n <= 40; n++) r.jobs.event(running(), [], tool(n));
		const lines = (last(r) ?? "").split("\n");
		expect(lines).toHaveLength(16);
		expect(lines[0]).toBe("» read: file25.go");
		expect(lines.at(-1)).toBe("» read: file40.go");
	});

	test("the question the agent waits on ends the tail, inside the bound, and goes with the answer", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		for (let n = 1; n <= 20; n++) r.jobs.event(running(), [], tool(n));
		r.jobs.sync(running({ phase: "waiting", question: pending({ text: "Which database?" }) }), []);
		const lines = (last(r) ?? "").split("\n");
		expect(lines).toHaveLength(16);
		expect(lines.at(-1)).toBe("? Which database?");
		expect(lines.at(-2)).toBe("» read: file20.go");
		r.jobs.sync(running(), []);
		expect(last(r)?.split("\n").at(-1)).toBe("» read: file20.go");
	});

	test("the lost-contact note ends it until contact returns", () => {
		const r = rig();
		const events = [tool(1, "bash: bun test")];
		r.jobs.sync(running(), events);
		r.jobs.markStale(running(), events, true);
		expect(last(r)).toBe(`» bash: bun test\n${STALE_STAGE}`);
		r.jobs.markStale(running(), events, false);
		expect(last(r)).toBe("» bash: bun test");
	});

	test("a job registered mid-turn starts with what this turn already did", () => {
		const r = rig();
		const events = [event(1, { kind: "tool", turn: 0, text: "read old.go" }), tool(2, "read a.go"), event(3, { kind: "assistant", turn: 1, text: "hello" }), event(4, { kind: "vm", turn: null, text: "vm started" })];
		r.jobs.sync(running(), events);
		expect(last(r)).toBe("» read: a.go\nhello");
		// `proc://`'s output is the same activity.
		expect(r.fake.jobs[0]?.reports.at(-1)?.details?.output).toBe("» read: a.go\nhello");
	});

	test("the metrics note is not part of the tail, and the stage stands in until there is a line", () => {
		const r = rig();
		r.jobs.sync(running({ metrics: metrics({ requests: 3 }) }), []);
		expect(last(r)).toBe("working");
		expect(r.fake.jobs[0]?.reports.at(-1)?.details?.output).toBe("· 3 requests · 0 tool calls");
	});
});

describe("the cloud agent in omp's Subagents strip and task progress", () => {
	const LIFECYCLE = "task:subagent:lifecycle";
	const PROGRESS = "task:subagent:progress";
	const t0 = Date.parse("2026-10-19T10:00:00Z");
	const ev = (seq: number, kind: string, o: Record<string, unknown>, s = seq) => event(seq, { kind, turn: 1, at: new Date(t0 + s * 1000).toISOString(), text: JSON.stringify(o) });
	const lifecycle = (r: Rig) => r.frames.filter(([c]) => c === LIFECYCLE).map(([, p]) => p);
	const progress = (r: Rig) => r.frames.filter(([c]) => c === PROGRESS).map(([, p]) => p);
	const lastProgress = (r: Rig): Record<string, unknown> => {
		const p = progress(r).at(-1);
		return isRecord(p) && isRecord(p.progress) ? p.progress : {};
	};

	test("registering announces the agent started, under the id the registry and the job carry, as a detached background agent", () => {
		const r = rig({ agentId: () => "Pinger" });
		r.jobs.sync(running(), []);
		expect(lifecycle(r)).toEqual([{ id: "Pinger", agent: "cloud", agentSource: "user", status: "started", index: 0, description: "fix the greeting bug", detached: true }]);
		expect(r.fake.jobs[0]).toMatchObject({ id: "Pinger", agentId: "Pinger", label: "Pinger" });
	});

	test("each report is a progress frame of the same id in the executor's shape: counts, context, cost, the call in flight", () => {
		const r = rig();
		const events = [
			event(1, { kind: "tool", turn: 1, at: new Date(t0).toISOString(), text: 'bash {"command":"for i in 1 2 3; do echo $i; done"}' }),
			ev(2, "tool_start", { id: "c1", tool: "bash", intent: "", args: '{"command":"for i in 1 2 3; do echo $i; done"}' }),
			ev(3, "usage", { input: 100, output: 20, cacheRead: 900, cacheWrite: 30, cost: 0.13, model: "m", stopReason: "toolUse", context: { tokens: 1050, window: 128_000 } }),
		];
		r.jobs.sync(running(), []);
		for (const e of events) r.jobs.event(running(), events, e);
		const frame = progress(r).at(-1);
		expect(frame).toMatchObject({ index: 0, agent: "cloud", agentSource: "user", task: "fix the greeting bug", detached: true });
		expect(lastProgress(r)).toMatchObject({
			id: JOB,
			agent: "cloud",
			status: "running",
			currentTool: "bash",
			currentToolArgs: "for i in 1 2 3; do echo $i; done",
			currentToolArgsKey: "command",
			toolCount: 1,
			requests: 1,
			tokens: 150,
			contextTokens: 1050,
			contextWindow: 128_000,
			cost: 0.13,
			resolvedModel: "anthropic/claude-sonnet-5-5",
			recentTools: [],
		});
		expect(lastProgress(r).stage).toMatch(/^└ bash: for i in 1 2 3; do echo \$i; done/);
		const detailsProgress = progressOf(r.fake.jobs[0]?.reports.at(-1)?.details);
		expect(detailsProgress).toMatchObject({ id: JOB, currentTool: "bash", toolCount: 1, requests: 1 });
		expect(detailsProgress?.stage).toMatch(/^└ bash: for i in 1 2 3; do echo \$i; done/);
	});

	test("a finished call moves to the recent calls, and the job's stage and Output read `tool: detail`, never raw JSON", () => {
		const r = rig();
		const events = [
			event(1, { kind: "tool", turn: 1, at: new Date(t0).toISOString(), text: 'read {"path":"src/a.go"}' }),
			ev(2, "tool_start", { id: "c1", tool: "read", intent: "", args: '{"path":"src/a.go"}' }),
			ev(3, "tool_end", { id: "c1", tool: "read", ok: true, ms: 40, error: "", async: false, detached: false, spawned: [] }),
		];
		r.jobs.sync(running(), []);
		for (const e of events) r.jobs.event(running(), events, e);
		expect(lastProgress(r)).toMatchObject({ toolCount: 1, recentTools: [{ tool: "read", args: "src/a.go", argsKey: "path", isError: false }] });
		expect(lastProgress(r).currentTool).toBeUndefined();
		expect(r.fake.jobs[0]?.reports.at(-1)?.text).toBe("» read: src/a.go · ✓ · 40ms");
		expect(r.fake.jobs[0]?.reports.at(-1)?.details?.output).toBe("» read: src/a.go · ✓ · 40ms");
	});

	test("a call in flight is marked as omp marks a running tool, in the stage, the Output tail and proc:// output; a finished one is not", () => {
		const clock = { at: t0 + 3000 };
		const fake = fakeManager();
		const jobs = new CloudJobs({ manager: () => fake.manager, wakes: () => true, warn: () => {}, stop: () => {}, aside: () => {}, now: () => clock.at });
		const sleepArgs = '{"command":"sleep 35"}';
		const plain = (seq: number, command: string) => event(seq, { kind: "tool", turn: 1, at: new Date(t0).toISOString(), text: `bash ${JSON.stringify({ command })}` });
		const events = [
			plain(10, "echo one"),
			ev(1, "tool_start", { id: "a", tool: "bash", intent: "", args: '{"command":"echo one"}' }, 0),
			ev(2, "tool_end", { id: "a", tool: "bash", ok: true, ms: 100, error: "", async: false, detached: false, spawned: [] }, 1),
			plain(11, "sleep 35"),
			ev(3, "tool_start", { id: "b", tool: "bash", intent: "", args: sleepArgs }, 2),
		];
		jobs.sync(running(), []);
		const now = () => fake.jobs[0]?.reports.at(-1);
		for (const e of events) jobs.event(running(), events, e);
		// Under five seconds: the hook, no clock yet.
		expect(now()?.text).toBe("» bash: echo one · ✓ · 100ms\n└ bash: sleep 35");
		expect(now()?.details?.output).toBe("» bash: echo one · ✓ · 100ms\n└ bash: sleep 35");
		expect(progressOf(now()?.details)?.stage).toBe("└ bash: sleep 35");
		// Later it shows how long it has run, in warning-worthy seconds as omp does.
		clock.at = t0 + 40_000;
		jobs.event(running(), events, event(4, { kind: "assistant", turn: 1, at: new Date(t0 + 40_000).toISOString(), text: "still going" }));
		expect(now()?.text).toBe("» bash: echo one · ✓ · 100ms\n└ bash: sleep 35 · 38s\nstill going");
		expect(progressOf(now()?.details)?.stage).toBe("└ bash: sleep 35 · 38s");
		// Its end clears the mark.
		const done = ev(5, "tool_end", { id: "b", tool: "bash", ok: true, ms: 35_000, error: "", async: false, detached: false, spawned: [] }, 41);
		jobs.event(running(), [...events, done], done);
		expect(now()?.text).toContain("» bash: sleep 35 · ✓ · 35s");
		expect(now()?.text).not.toContain("└");
		expect(progressOf(now()?.details)?.stage).toBe("» bash: sleep 35");
	});

	test("a service without structured events marks nothing: its plain calls cannot be told from lost ones", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.jobs.event(running(), [], event(1, { kind: "tool", turn: 1, text: "bash sleep 35" }));
		expect(r.fake.jobs[0]?.reports.at(-1)?.text).toBe("» bash: sleep 35");
	});

	test("the running turn's usage reaches the job's widget: the thread's metrics sum finished turns only", () => {
		const w = (() => {
			const r = rig();
			const omp = ompRegistry();
			r.fake.manager.widgets = omp;
			return r;
		})();
		const events = [{ ...ev(1, "usage", { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.42, model: "m", stopReason: "stop", context: { tokens: 64_000, window: 200_000 } }), turn: 2 }];
		w.jobs.sync(second(), []);
		w.jobs.event(second(), events, events[0] ?? event(1));
		const view = w.fake.manager.widgets?.view(asJob(JOB));
		const stat = view?.blocks.find(b => b.kind === "stat");
		expect(stat?.kind === "stat" && stat.items.map(i => `${i.label} ${i.text}`)).toEqual(["cost $0.84", "tokens 3K", "requests 8", "tools 12", "turns 1", `id ${ID.slice(-6)}`]);
		expect(view?.headline).toMatchObject({ text: "32%", label: "context" });
		expect(view?.title).toBe(JOB);
	});

	test("the end of the turn takes the row out of the strip with the turn's outcome, once", () => {
		const done = rig();
		done.jobs.sync(running(), []);
		done.jobs.settle(ended("done"), turn(1, { state: "done" }));
		expect(lifecycle(done).map(p => (isRecord(p) ? p.status : undefined))).toEqual(["started", "completed"]);

		const failed = rig();
		failed.jobs.sync(running(), []);
		failed.jobs.settle(ended("failed"), turn(1, { state: "failed", error: "boom" }));
		expect(lifecycle(failed).map(p => (isRecord(p) ? p.status : undefined))).toEqual(["started", "failed"]);

		const stopped = rig();
		stopped.jobs.sync(running(), []);
		stopped.jobs.settle(ended("cancelled"), turn(1, { state: "cancelled" }));
		expect(lifecycle(stopped).map(p => (isRecord(p) ? p.status : undefined))).toEqual(["started", "aborted"]);

		const gone = rig();
		gone.jobs.sync(running(), []);
		gone.jobs.fail(ID, "thread was deleted");
		expect(lifecycle(gone).map(p => (isRecord(p) ? p.status : undefined))).toEqual(["started", "failed"]);

		const lost = rig();
		lost.jobs.sync(running(), []);
		lost.jobs.finish(running({ phase: "failed", error: "vm lost" }));
		expect(lifecycle(lost).map(p => (isRecord(p) ? p.status : undefined))).toEqual(["started", "failed"]);
	});

	test("a cancel from omp ends the row as aborted, and the next turn's job starts a new row", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.fake.manager.cancel(JOB);
		await r.fake.jobs[0]?.settled;
		expect(lifecycle(r).map(p => (isRecord(p) ? p.status : undefined))).toEqual(["started", "aborted"]);

		const next = rig();
		next.jobs.sync(running(), []);
		next.jobs.sync(detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", turns: [turn(1, { state: "done" }), turn(2, { state: "running", text: "again" })] }), []);
		expect(lifecycle(next).map(p => (isRecord(p) ? p.status : undefined))).toEqual(["started", "completed", "started"]);
	});

	test("a host without the bus, and a bus whose listener throws, cost the job nothing", () => {
		const fake = fakeManager();
		const quiet = new CloudJobs({ manager: () => fake.manager, wakes: () => true, warn: () => {}, stop: () => {}, aside: () => {} });
		quiet.sync(running(), []);
		expect(fake.jobs).toHaveLength(1);

		const throwing = fakeManager();
		const loud = new CloudJobs({
			manager: () => throwing.manager,
			wakes: () => true,
			warn: () => {},
			stop: () => {},
			aside: () => {},
			events: () => ({
				emit: () => {
					throw new Error("listener failed");
				},
			}),
		});
		expect(() => loud.sync(running(), [])).not.toThrow();
		expect(throwing.jobs[0]?.reports.length).toBeGreaterThan(0);
	});
});
