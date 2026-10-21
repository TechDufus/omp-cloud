import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager, type AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { JobWidgetRegistry } from "@oh-my-pi/pi-coding-agent/job-widgets/types";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { buildJobTree } from "@oh-my-pi/pi-tui/overlays/job-tree";
import { eventLines } from "../src/event-lines";
import { CloudJobs } from "../src/cloud-jobs";
import type { ThreadDetail, ThreadEvent } from "../src/types";
import { Watcher, type WatchApi, type WatchSink } from "../src/watch";
import { detail, event, turn } from "./builders";
import { Feed } from "./feed";
import { fakeHost, until } from "./fakes";

const ID = "aaaaaak3x9fa";
/** The cloud agent's id: what its job is labelled and registered as, and the `ownerId` of its children. */
const AGENT = "FixGreetingBug";
const VM = { sandboxId: "sb1", state: "running", pid: 7 };

/** Turn 1 running on the thread. */
const running = (over: Partial<ThreadDetail> = {}): ThreadDetail =>
	detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", vm: VM, turns: [turn(1, { state: "running", text: "fix the greeting bug" })], ...over });

/** Turn 1 done and the thread idle: nothing but a child keeps it going. */
const idle = (over: Partial<ThreadDetail> = {}): ThreadDetail =>
	detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "idle", vm: VM, turns: [turn(1, { state: "done", title: "Greeting fixed", reply: "All done." })], ...over });

let seq = 0;
const next = () => ++seq;

/** The service's `child_start`. */
const started = (job: string, over: Record<string, unknown> = {}) =>
	event(next(), { kind: "child_start", turn: 1, text: JSON.stringify({ job, agent: "", kind: "bash", label: "sleep 600", parentCall: "call-1", parent: "", description: "", ...over }) });

/** The service's `child_progress` of a subagent. */
const progressed = (job: string, over: Record<string, unknown> = {}) =>
	event(next(), { kind: "child_progress", turn: 1, text: JSON.stringify({ job, agent: job, tools: 3, requests: 2, tokens: 1500, cost: 0.05, tool: "read", args: "src/a.go", intent: "", stage: "", percent: null, context: { tokens: 20_000, window: 200_000 }, ms: 4000, ...over }) });

/** The service's `child_end`. */
const ended = (job: string, over: Record<string, unknown> = {}) =>
	event(next(), { kind: "child_end", turn: 1, text: JSON.stringify({ job, agent: "", kind: "bash", status: "completed", ms: 4000, error: "", inferred: false, ...over }) });

/** A registry standing for the one omp installs: it knows no job, and records every one it was asked about (a real one would start a model writing a widget). */
interface OmpRegistry extends JobWidgetRegistry {
	asked: string[];
}

function ompRegistry(): OmpRegistry {
	const asked: string[] = [];
	return {
		asked,
		view: job => {
			asked.push(job.id);
			return undefined;
		},
		subscribe: () => () => {},
		forget: () => {},
		dispose: () => {},
	};
}

/** What omp's tiles and panel draw for `job`. */
function viewOf(m: AsyncJobManager, job: AsyncJob | undefined): JobWidgetView | undefined {
	return job ? m.widgets?.view(job) : undefined;
}

interface Rig {
	m: AsyncJobManager;
	jobs: CloudJobs;
	warnings: string[];
	stops: string[];
	/** What omp would deliver to a session: the main agent's and the cloud agent's own sinks. */
	delivered: string[];
	/** Agent ids omp's registry holds. */
	taken: Set<string>;
	lifecycle: { value: boolean };
	/** Feeds an event the way the watcher does: the thread's stream so far, then the event. */
	feed(d: ThreadDetail, e: ThreadEvent): void;
	/** The jobs the manager holds that are owned by `owner`. */
	owned(owner: string): AsyncJob[];
}

let manager: AsyncJobManager | undefined;
afterEach(async () => {
	await manager?.dispose({ timeoutMs: 100 });
	manager = undefined;
});

function rig(opts: { maxRunningJobs?: number } = {}): Rig {
	seq = 0;
	const m = new AsyncJobManager({ retentionMs: 60_000, ...(opts.maxRunningJobs === undefined ? {} : { maxRunningJobs: opts.maxRunningJobs }) });
	manager = m;
	m.widgets = ompRegistry();
	const delivered: string[] = [];
	m.registerDeliverySink("Main", id => void delivered.push(id));
	m.registerDeliverySink(AGENT, id => void delivered.push(id));
	const warnings: string[] = [];
	const stops: string[] = [];
	const taken = new Set<string>();
	const lifecycle = { value: false };
	const stream: ThreadEvent[] = [];
	const jobs = new CloudJobs({
		manager: () => m,
		wakes: () => true,
		taken: id => taken.has(id),
		transitioning: () => lifecycle.value,
		warn: message => void warnings.push(message),
		stop: thread => void stops.push(thread),
		aside: () => {},
	});
	return {
		m,
		jobs,
		warnings,
		stops,
		delivered,
		taken,
		lifecycle,
		feed: (d, e) => {
			stream.push(e);
			jobs.event(d, stream, e);
		},
		owned: owner => m.getAllJobs({ ownerId: owner }),
	};
}

describe("registering a cloud agent's own jobs and subagents", () => {
	test("a background command is a bash job owned by the cloud agent, labelled by its command, like a native subagent's", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1", { label: "sleep 600" }));
		const [child] = r.owned(AGENT);
		expect(child).toMatchObject({ type: "bash", label: "sleep 600", ownerId: AGENT, status: "running" });
		// omp's native bash job has no `agentId`: only a task job runs an agent.
		expect(child?.agentId).toBeUndefined();
		// The parent is still the cloud turn, owned by the main agent.
		expect(r.m.getJob(AGENT)).toMatchObject({ type: "task", ownerId: "Main", agentId: AGENT });
	});

	test("a subagent is a task job whose id, label and agentId are its agent id, as omp registers one", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("Explorer", { kind: "task", agent: "Explorer", label: "Explorer", description: "map the repo" }));
		expect(r.owned(AGENT)).toHaveLength(1);
		expect(r.m.getJob("Explorer")).toMatchObject({ type: "task", label: "Explorer", agentId: "Explorer", ownerId: AGENT, status: "running" });
	});

	test("a command's label is cut to 120 characters as omp cuts it", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1", { label: "x".repeat(200) }));
		const label = r.owned(AGENT)[0]?.label ?? "";
		expect(label).toBe(`${"x".repeat(117)}...`);
	});

	test("omp's job tree draws the child under the cloud agent's job, and a subagent's child under that subagent", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("Explorer", { kind: "task", agent: "Explorer", label: "Explorer" }));
		r.feed(running(), started("bg_9", { label: "make watch", parent: "Explorer" }));
		r.feed(running(), started("bg_2", { label: "tail -f log" }));
		// What `AgentSession.getAsyncJobTree` hands the sheet: every running job of the tree, and the agents that own them with their lineage.
		const rows = buildJobTree(
			r.m.getRunningJobs(),
			[{ id: AGENT, parentId: "Main" }, { id: "Explorer", parentId: AGENT }],
			"Main",
		);
		expect(rows.map(row => [row.kind === "job" ? row.job.label : row.agent.id, row.depth])).toEqual([
			[AGENT, 0],
			["Explorer", 1],
			["make watch", 2],
			["tail -f log", 1],
		]);
		expect(r.owned("Explorer")).toHaveLength(1);
		expect(r.owned("Explorer")[0]).toMatchObject({ type: "bash", label: "make watch" });
	});

	test("a child's id never takes the id of an agent omp already has, nor a job it already holds", () => {
		const r = rig();
		r.taken.add("Explorer");
		r.jobs.sync(running(), []);
		r.feed(running(), started("Explorer", { kind: "task", agent: "Explorer", label: "Explorer" }));
		expect(r.m.getJob("Explorer")).toBeUndefined();
		expect(r.m.getJob("Explorer-2")).toMatchObject({ type: "task", label: "Explorer", agentId: "Explorer-2", ownerId: AGENT });
	});

	test("a child's result is the cloud agent's, not a local session's: omp delivers nothing of it", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1"));
		r.feed(running(), ended("bg_1"));
		await r.owned(AGENT)[0]?.promise;
		await r.m.drainDeliveries({ timeoutMs: 300 });
		expect(r.delivered).toEqual([]);
	});

	test("a child's view is its label, and for a subagent what the VM's omp reported of it; omp's own registry is never asked to author one", () => {
		const r = rig();
		const omp = ompRegistry();
		r.m.widgets = omp;
		r.jobs.sync(running(), []);
		r.feed(running(), started("Explorer", { kind: "task", agent: "Explorer", label: "Explorer", description: "map the repo" }));
		r.feed(running(), progressed("Explorer"));
		const view = viewOf(r.m, r.m.getJob("Explorer"));
		expect(view).toMatchObject({ title: "Explorer", stage: "read: src/a.go", state: "live" });
		expect(view?.blocks.map(b => b.kind)).toEqual(["meter", "stat", "text"]);
		const stat = view?.blocks.find(b => b.kind === "stat");
		expect(stat?.kind === "stat" && stat.items.map(i => `${i.label} ${i.text}`)).toEqual(["tools 3", "requests 2", "tokens 1.5K", "cost $0.05"]);
		// A command has nothing but running or ended.
		r.feed(running(), started("bg_1", { label: "sleep 600" }));
		expect(viewOf(r.m, r.owned(AGENT).find(j => j.type === "bash"))).toMatchObject({ title: "sleep 600", stage: "running in the cloud", blocks: [] });
		expect(omp.asked).toEqual([]);
		// The job's output, which the panel shows, is the call in flight.
		expect(r.m.getJob("Explorer")?.progressText).toBe("» read: src/a.go");
	});
});

describe("settling at the child's end", () => {
	test("completed: the job completes with how long it took, and the row's own view says so", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1", { label: "make build" }));
		const [child] = r.owned(AGENT);
		r.feed(running(), ended("bg_1", { ms: 12_000 }));
		await child?.promise;
		expect(child).toMatchObject({ status: "completed", resultText: "make build completed in 12s" });
		expect(viewOf(r.m, child)).toMatchObject({ title: "make build", stage: "make build completed in 12s", state: "live" });
	});

	test("failed: the job fails with the VM's error", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1"));
		const [child] = r.owned(AGENT);
		r.feed(running(), ended("bg_1", { status: "failed", error: "exit 2" }));
		await child?.promise.catch(() => {});
		expect(child).toMatchObject({ status: "failed", errorText: "exit 2" });
	});

	test("cancelled in the cloud: the job reads cancelled, with the reason, and says and stops nothing", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("Explorer", { kind: "task", agent: "Explorer", label: "Explorer" }));
		const child = r.m.getJob("Explorer");
		r.feed(running(), ended("Explorer", { kind: "task", agent: "Explorer", status: "cancelled", error: "VM paused", inferred: true }));
		await child?.promise.catch(() => {});
		expect(child?.status).toBe("cancelled");
		expect(child?.errorText).toContain("VM paused");
		expect(r.warnings).toEqual([]);
		expect(r.stops).toEqual([]);
		// The parent turn runs on.
		expect(r.m.getJob(AGENT)?.status).toBe("running");
	});

	test("an end of a job that was never started, or already ended, changes nothing", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), ended("ghost"));
		r.feed(running(), started("bg_1"));
		r.feed(running(), ended("bg_1"));
		r.feed(running(), ended("bg_1", { status: "failed", error: "late" }));
		await r.owned(AGENT)[0]?.promise;
		expect(r.owned(AGENT)).toHaveLength(1);
		expect(r.owned(AGENT)[0]?.status).toBe("completed");
	});

	test("a job id that restarts after its end is a new run with its own row; a replayed stream is not handled twice", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		const first = started("Explorer", { kind: "task", agent: "Explorer", label: "Explorer" });
		r.feed(running(), first);
		r.feed(running(), first);
		expect(r.owned(AGENT)).toHaveLength(1);
		r.feed(running(), ended("Explorer", { kind: "task", agent: "Explorer" }));
		await r.m.getJob("Explorer")?.promise;
		// omp's follow-up turn of the same subagent.
		r.feed(running(), started("Explorer", { kind: "task", agent: "Explorer", label: "Explorer" }));
		const rows = r.owned(AGENT);
		expect(rows.map(j => [j.id, j.status])).toEqual([["Explorer", "completed"], ["Explorer-2", "running"]]);
		// The first end replayed does not end the new run.
		r.jobs.event(running(), [], event(2, { kind: "child_end", text: JSON.stringify({ job: "Explorer", status: "completed", ms: 1 }) }));
		expect(r.m.getJob("Explorer-2")?.status).toBe("running");
	});
});

describe("a child that outlives the cloud turn", () => {
	test("it stays registered under the cloud agent after its turn's job settles, until its own end", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1", { label: "sleep 600" }));
		const done = turn(1, { state: "done", title: "Greeting fixed", reply: "All done." });
		r.jobs.settle(idle(), done);
		await r.m.getJob(AGENT)?.promise;
		expect(r.m.getJob(AGENT)?.status).toBe("completed");
		const [child] = r.owned(AGENT);
		expect(child?.status).toBe("running");
		// The thread's stream stays followed for it, though no turn runs.
		expect(r.jobs.keeps(idle())).toBe(true);
		r.feed(idle(), ended("bg_1", { ms: 70_000 }));
		await child?.promise;
		expect(child?.status).toBe("completed");
		expect(r.jobs.keeps(idle())).toBe(false);
	});

	test("a thread whose VM is gone keeps nothing: finishing it fails the children that never ended", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1"));
		const [child] = r.owned(AGENT);
		expect(r.jobs.keeps(idle({ vm: null }))).toBe(false);
		expect(r.jobs.keeps(idle({ phase: "failed" }))).toBe(false);
		r.jobs.finish(idle({ vm: null, phase: "failed", error: "vm lost" }));
		await child?.promise.catch(() => {});
		expect(child).toMatchObject({ status: "failed", errorText: "vm lost" });
	});

	test("a thread deleted from the service fails its children with the reason", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1"));
		const [child] = r.owned(AGENT);
		r.jobs.fail(ID, "thread was deleted");
		await child?.promise.catch(() => {});
		expect(child).toMatchObject({ status: "failed", errorText: "thread was deleted" });
	});

	test("the watcher keeps following the idle thread for its children, and lets it go at the last child's end", async () => {
		const r = rig();
		const f = fakeHost();
		const feed = new Feed();
		let current: ThreadDetail = running();
		const api: WatchApi = {
			thread: async () => current,
			events: feed.source,
		};
		const w = new Watcher(f.host, api, { turn: () => {}, question: () => {} } satisfies WatchSink, { backoffMs: () => 1 }, { jobs: r.jobs });
		await w.watch(ID);
		feed.push(ID, started("bg_1", { label: "sleep 600" }));
		await until(() => r.owned(AGENT).length === 1);
		// The turn ends while the command runs.
		current = idle();
		feed.push(ID, event(next(), { kind: "turn_done", turn: 1, text: "turn 1 done" }));
		await until(() => r.m.getJob(AGENT)?.status === "completed");
		expect(w.followed(ID)).toBeDefined();
		expect(r.owned(AGENT)[0]?.status).toBe("running");
		// Its end arrives on the same stream, and the watcher then lets the thread go.
		feed.push(ID, ended("bg_1"));
		await until(() => r.owned(AGENT)[0]?.status === "completed");
		await until(() => w.followed(ID) === undefined);
		w.unwatch();
	});
});

describe("a service without events.children", () => {
	test("nothing is registered: a call that spawned an agent (its `tool_end`) is not a child, and no child shows without a `child_start`", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), event(next(), { kind: "tool_start", text: JSON.stringify({ id: "c1", tool: "task", intent: "review", args: "{}" }) }));
		r.feed(running(), event(next(), { kind: "tool_end", text: JSON.stringify({ id: "c1", tool: "task", ok: true, ms: 40, async: true, spawned: [{ agent: "Reviewer", job: "Reviewer" }] }) }));
		r.feed(running(), event(next(), { kind: "assistant", text: "started a reviewer" }));
		expect(r.owned(AGENT)).toEqual([]);
		expect(r.m.getAllJobs().map(j => j.id)).toEqual([AGENT]);
		expect(r.jobs.keeps(idle())).toBe(false);
	});

	test("a child event that is not a JSON object, or names no job, registers nothing", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), event(next(), { kind: "child_start", text: "not json" }));
		r.feed(running(), event(next(), { kind: "child_start", text: JSON.stringify({ kind: "bash", label: "x" }) }));
		expect(r.owned(AGENT)).toEqual([]);
	});

	test("the folded log has no line for a child's events: they are jobs of their own, not JSON in the tail", () => {
		const lines = eventLines([started("bg_1"), progressed("bg_1"), ended("bg_1"), event(next(), { kind: "assistant", text: "hi" })]);
		expect(lines.map(l => l.text)).toEqual(["hi"]);
	});
});

describe("cancelling a child", () => {
	test("omp's own surfaces cannot: the cancel is filtered by the owner, and the child is the cloud agent's, not the main agent's", () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1"));
		const [child] = r.owned(AGENT);
		// `cancelAsyncJob` (the jobs sheet's x, `/jobs kill`) and `proc://<id>/kill` ask the manager as the main agent.
		expect(r.m.cancel(child?.id ?? "", { ownerId: "Main" })).toBe(false);
		expect(child?.status).toBe("running");
		expect(r.stops).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	test("a cancel that gets through is declined: the user is told, the cloud turn is not stopped, and the child, still running, has a row again", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1", { label: "sleep 600" }));
		const [child] = r.owned(AGENT);
		expect(r.m.cancel(child?.id ?? "")).toBe(true);
		await child?.promise.catch(() => {});
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("sleep 600");
		expect(r.warnings[0]).toContain("cannot be cancelled");
		expect(r.stops).toEqual([]);
		// The parent turn is untouched.
		expect(r.m.getJob(AGENT)?.status).toBe("running");
		expect(r.jobs.has(ID)).toBe(true);
		const rows = r.owned(AGENT);
		expect(rows.map(j => j.status)).toEqual(["cancelled", "running"]);
		expect(rows[1]).toMatchObject({ type: "bash", label: "sleep 600", ownerId: AGENT });
		// Its end, when it comes, settles the new row.
		r.feed(running(), ended("bg_1"));
		await rows[1]?.promise;
		expect(rows[1]?.status).toBe("completed");
	});

	test("cancelling the cloud turn's own job stops the turn, and never because of a child", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1"));
		const [child] = r.owned(AGENT);
		r.m.cancel(child?.id ?? "");
		await child?.promise.catch(() => {});
		expect(r.stops).toEqual([]);
		r.m.cancel(AGENT, { ownerId: "Main" });
		await r.m.getJob(AGENT)?.promise.catch(() => {});
		expect(r.stops).toEqual([ID]);
	});

	test("omp's own cleanup (a session transition, shutdown) ends the rows silently, and the next event of the thread registers the running child again", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1", { label: "sleep 600" }));
		const [child] = r.owned(AGENT);
		r.lifecycle.value = true;
		r.m.cancel(child?.id ?? "");
		await child?.promise.catch(() => {});
		expect(r.warnings).toEqual([]);
		expect(r.stops).toEqual([]);
		expect(r.owned(AGENT).map(j => j.status)).toEqual(["cancelled"]);
		r.lifecycle.value = false;
		r.feed(running(), event(next(), { kind: "assistant", text: "still working" }));
		expect(r.owned(AGENT).map(j => j.status)).toEqual(["cancelled", "running"]);
		await r.m.dispose({ timeoutMs: 100 });
		expect(r.warnings).toEqual([]);
		expect(r.stops).toEqual([]);
		expect(r.m.getAllJobs().filter(j => j.status === "running")).toEqual([]);
	});

	test("no longer following the thread ends its children's rows without a notice, and leaves the cloud turn running", async () => {
		const r = rig();
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1"));
		r.feed(running(), started("Explorer", { kind: "task", agent: "Explorer", label: "Explorer" }));
		const children = r.owned(AGENT);
		r.jobs.releaseAll();
		await Promise.all(children.map(c => c.promise.catch(() => {})));
		expect(children.map(c => c.status)).toEqual(["cancelled", "cancelled"]);
		expect(r.warnings).toEqual([]);
		expect(r.stops).toEqual([]);
		expect(r.jobs.keeps(idle())).toBe(false);
	});
});

describe("when the manager is full or absent", () => {
	test("a child waits for room, and the thread's next event registers it; the end of one that never had a row leaves nothing to settle", async () => {
		const r = rig({ maxRunningJobs: 1 });
		r.jobs.sync(running(), []);
		r.feed(running(), started("bg_1", { label: "first" }));
		r.feed(running(), started("bg_2", { label: "second" }));
		expect(r.owned(AGENT)).toEqual([]);
		// Both still run in the VM: the thread stays followed for them.
		expect(r.jobs.keeps(idle())).toBe(true);
		// The cloud turn's job settles and frees the only slot; the next event registers the first child.
		r.jobs.settle(idle(), turn(1, { state: "done", title: "Greeting fixed", reply: "All done." }));
		await r.m.getJob(AGENT)?.promise;
		r.feed(idle(), event(next(), { kind: "assistant", turn: null, text: "still here" }));
		expect(r.owned(AGENT).map(j => [j.label, j.status])).toEqual([["first", "running"]]);
		r.feed(idle(), ended("bg_2"));
		expect(r.owned(AGENT).map(j => j.status)).toEqual(["running"]);
		expect(r.jobs.keeps(idle())).toBe(true);
		r.feed(idle(), ended("bg_1"));
		expect(r.jobs.keeps(idle())).toBe(false);
	});

	test("a host without a manager registers nothing and throws nothing", () => {
		seq = 0;
		const jobs = new CloudJobs({ manager: () => undefined, wakes: () => true, warn: () => {}, stop: () => {}, aside: () => {} });
		jobs.event(running(), [], started("bg_1"));
		jobs.event(running(), [], ended("bg_1"));
		expect(jobs.keeps(idle())).toBe(false);
	});
});
