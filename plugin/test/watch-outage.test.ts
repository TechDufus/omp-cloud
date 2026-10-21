import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { CloudJobs, STALE_STAGE } from "../src/cloud-jobs";
import { Deliverer } from "../src/deliver";
import { cloudErrorFromStatus } from "../src/errors";
import { Inbox } from "../src/inbox";
import type { ThreadDetail } from "../src/types";
import { Watcher } from "../src/watch";
import { detail, event, pending, turn } from "./builders";
import { ManualClock } from "./clock";
import { fakeHost, fakePi, type FakeHost, type FakePi } from "./fakes";
import { Feed } from "./feed";
import { Service } from "./service";

const A = "aaaaaak3x9fa";
const B = "bbbbbbq9w8e7";
const C = "cccccch2d4f6";
const NAMES: Record<string, string> = { [A]: "Fix greeting bug", [B]: "Update readme", [C]: "Add tests" };

const working = (id: string): ThreadDetail => detail({ id, name: NAMES[id] ?? "", title: "", phase: "working", turns: [turn(1, { state: "running", text: "do the work" })] });
const finished = (id: string, reply = "All done."): ThreadDetail =>
	detail({ id, name: NAMES[id] ?? "", title: "", phase: "idle", turns: [turn(1, { state: "done", title: "Work finished", reply })] });

interface Rig {
	w: Watcher;
	f: FakeHost;
	pi: FakePi;
	feed: Feed;
	svc: Service;
	clock: ManualClock;
	manager: AsyncJobManager;
	jobs: CloudJobs;
	deliver: Deliverer;
	/** The jobs omp's own delivery sent to the model, by job id. */
	delivered: string[];
}

let manager: AsyncJobManager | undefined;

afterEach(async () => {
	await manager?.dispose({ timeoutMs: 100 });
	manager = undefined;
});

/** A watcher over `threads`, the way the extension builds one: real job manager, a deliverer as the sink, a clock the test moves. */
function rig(origins: Record<string, "tool" | "user">, ...threads: ThreadDetail[]): Rig {
	const f = fakeHost();
	const pi = fakePi();
	const feed = new Feed();
	const svc = new Service(...threads);
	const clock = new ManualClock();
	const m = new AsyncJobManager({ retentionMs: 60_000 });
	manager = m;
	const deliver = new Deliverer(pi.pi);
	const delivered: string[] = [];
	m.registerDeliverySink("Main", id => void delivered.push(id));
	for (const [id, origin] of Object.entries(origins)) deliver.setOrigin(id, origin);
	const jobs = new CloudJobs({ manager: () => m, wakes: id => origins[id] === "tool", warn: () => {}, stop: () => {}, aside: () => {} });
	const w = new Watcher(f.host, { thread: svc.thread, events: feed.source }, deliver, { clock }, { jobs });
	return { w, f, pi, feed, svc, clock, manager: m, jobs, deliver, delivered };
}

/** The ids omp's job manager gives the threads' jobs: the words of their names. */
const JOB_IDS: Record<string, string> = { [A]: "FixGreetingBug", [B]: "UpdateReadme", [C]: "AddTests" };

/** The thread's job as the manager has it, running or settled. */
const jobOf = (r: Rig, id: string) => r.manager.getJob(JOB_IDS[id] ?? "none");

describe("a thread the service no longer has", () => {
	test("only that thread is dropped: its job fails, the model that started it is woken, and the others are still followed", async () => {
		const r = rig({ [A]: "tool", [B]: "tool", [C]: "user" }, working(A), working(B), working(C));
		for (const id of [A, B, C]) await r.w.watch(id);
		const jobA = JOB_IDS[A] ?? "";
		r.svc.details.delete(A);
		r.feed.push(A, event(1, { kind: "turn_done", turn: 1 }));
		await r.clock.advance(0);

		expect(r.w.watching).toEqual([B, C]);
		expect(r.f.notes).toEqual([[`☁ Fix greeting bug · ${A} no longer exists`, "warning"]]);
		expect(r.manager.getJob(jobA)).toMatchObject({ status: "failed", errorText: "thread was deleted" });
		expect(r.pi.sent).toHaveLength(1);
		expect(r.pi.sent[0]?.message.content).toBe(`[cloud] Fix greeting bug · ${A}: thread was deleted\nThe cloud no longer has this thread, so its turn will not finish and nothing can be read or pulled from it.`);
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: true });

		// The others keep their streams and their jobs; their results still arrive.
		expect(r.feed.open(B)?.aborted).toBe(false);
		expect(r.feed.open(C)?.aborted).toBe(false);
		expect(jobOf(r, B)?.status).toBe("running");
		expect(jobOf(r, C)?.status).toBe("running");
		r.svc.details.set(B, finished(B));
		r.feed.push(B, event(1, { kind: "turn_done", turn: 1 }));
		await r.clock.advance(0);
		// A model-started thread's result is omp's own delivery (async-result with agent://<id>): no card.
		expect(r.pi.sent).toHaveLength(1);
		await r.manager.drainDeliveries({ timeoutMs: 500 });
		expect(r.delivered).toEqual([JOB_IDS[B] ?? ""]);
		expect(r.w.watching).toEqual([C]);
	});

	test("the stream saying 404 is the same: the thread is dropped on its own, with the same card", async () => {
		const r = rig({ [A]: "tool", [B]: "tool" }, working(A), working(B));
		await r.w.watch(A);
		await r.w.watch(B);
		r.feed.fail(A, cloudErrorFromStatus(404, "no such thread"));
		await r.clock.advance(0);
		expect(r.w.watching).toEqual([B]);
		expect(r.pi.sent.map(s => s.message.content)).toEqual([expect.stringContaining(`${A}: thread was deleted`)]);
		expect(jobOf(r, B)?.status).toBe("running");
	});

	test("a thread of the user's is dropped with a notice for the user and no wake-up", async () => {
		const r = rig({ [C]: "user" }, working(C));
		await r.w.watch(C);
		r.svc.details.delete(C);
		r.feed.push(C, event(1, { kind: "turn_done", turn: 1 }));
		await r.clock.advance(0);
		expect(r.f.notes).toEqual([[`☁ Add tests · ${C} no longer exists`, "warning"]]);
		expect(r.pi.sent).toEqual([]);
	});

	test("what the inbox held of it goes", async () => {
		const f = fakeHost();
		const pi = fakePi();
		const inbox = new Inbox();
		const deliver = new Deliverer(pi.pi, { inbox, mode: () => "tray", notify: () => {} });
		inbox.add({ thread: A, turn: 1, kind: "result", label: "Fix greeting bug", line: "All done.", at: 1 });
		inbox.add({ thread: B, turn: 1, kind: "result", label: "Update readme", line: "Done.", at: 2 });
		deliver.gone(f.host, working(A));
		expect(inbox.entries.map(e => e.thread)).toEqual([B]);
		expect(pi.sent).toEqual([]);
	});

	test("a model blocked in wait on the job already has the failure: the card is there but does not wake it", async () => {
		const r = rig({ [A]: "tool" }, working(A));
		await r.w.watch(A);
		r.manager.watchJobs([r.jobs.jobId(A) ?? ""]);
		r.svc.details.delete(A);
		r.feed.push(A, event(1, { kind: "turn_done", turn: 1 }));
		await r.clock.advance(0);
		expect(r.pi.sent).toHaveLength(1);
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: false });
	});

	test("a thread forgotten on purpose (the model deleted it) is dropped alone and silently: no card, no notice, its job cancelled, a waiter reads `deleted`", async () => {
		const r = rig({ [A]: "tool", [B]: "tool" }, working(A), working(B));
		await r.w.watch(A);
		await r.w.watch(B);
		const waited = r.w.waits.run([A], { until: "any", on: ["done"], timeoutMs: 60_000 });
		r.w.forget(A);
		expect(await waited).toEqual([{ threadId: A, outcome: "deleted" }]);
		await r.clock.advance(0);
		expect(r.w.watching).toEqual([B]);
		expect(r.feed.of(A)[0]?.aborted).toBe(true);
		expect(jobOf(r, A)?.status).toBe("cancelled");
		expect(jobOf(r, B)?.status).toBe("running");
		expect(r.pi.sent).toEqual([]);
		expect(r.f.notes).toEqual([]);
	});
});

describe("an outage of the cloud", () => {
	/** The service cannot be reached: the stream cannot connect and the thread cannot be fetched. */
	function cut(r: Rig): void {
		const failure = new Error("fetch failed");
		r.svc.down = failure;
		r.feed.down = failure;
	}

	function restore(r: Rig): void {
		r.svc.down = undefined;
		r.feed.down = undefined;
	}

	test("30 seconds with a turn finishing in the middle: nothing is said, and the finished turn is delivered once, by omp, when contact is back", async () => {
		const r = rig({ [A]: "tool" }, working(A));
		await r.w.watch(A);
		await r.clock.advance(1);
		cut(r);
		r.feed.fail(A, new Error("connection reset"));
		await r.clock.advance(10_000);
		// The turn ends in the cloud while contact is lost.
		r.svc.details.set(A, finished(A));
		await r.clock.advance(20_000);
		expect(r.f.notes).toEqual([]);
		expect(r.pi.sent).toEqual([]);
		expect(r.w.followed(A)?.stale).toBe(false);
		expect(jobOf(r, A)?.status).toBe("running");

		restore(r);
		await r.clock.advance(15_000);
		// The service replays what the follower missed.
		expect(r.feed.of(A).at(-1)?.opts.lastEventId).toBe(0);
		r.feed.push(A, event(1, { kind: "turn_done", turn: 1 }), event(2, { kind: "turn_done", turn: 1 }));
		await r.clock.advance(0);
		await r.manager.drainDeliveries({ timeoutMs: 500 });
		expect(r.pi.sent).toEqual([]);
		expect(r.delivered).toEqual([JOB_IDS[A] ?? ""]);
		expect(jobOf(r, A)?.status).toBe("completed");
		expect(r.w.watching).toEqual([]);
	});

	test("12 minutes: the job says it lost contact, the model that started the thread is woken once, the user is told, and following goes on", async () => {
		const r = rig({ [A]: "tool", [C]: "user" }, working(A), working(C));
		await r.w.watch(A);
		await r.w.watch(C);
		await r.clock.advance(1);
		cut(r);
		r.feed.fail(A, new Error("connection reset"));
		r.feed.fail(C, new Error("connection reset"));
		await r.clock.advance(9 * 60_000);
		expect(r.f.notes).toEqual([]);
		expect(r.pi.sent).toEqual([]);
		await r.clock.advance(3 * 60_000);

		expect(r.w.followed(A)?.stale).toBe(true);
		expect(r.w.followed(C)?.stale).toBe(true);
		expect(jobOf(r, A)?.progressText).toBe(STALE_STAGE);
		expect(jobOf(r, A)?.status).toBe("running");
		expect(r.f.notes.map(n => n[0])).toEqual([`☁ Fix greeting bug · ${A}: lost contact with the cloud (fetch failed); still retrying`, `☁ Add tests · ${C}: lost contact with the cloud (fetch failed); still retrying`]);
		// Only the thread the model started wakes it.
		expect(r.pi.sent).toHaveLength(1);
		expect(r.pi.sent[0]?.message.content).toBe(`[cloud] Fix greeting bug · ${A}: lost contact with the cloud; use cloud status ${A}\nThe thread may still be running. This session keeps retrying and reports a finished turn if contact returns.`);
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: true });
		expect(r.w.watching).toEqual([A, C]);
		const connections = r.feed.connections.length;
		await r.clock.advance(5 * 60_000);
		expect(r.feed.connections.length).toBeGreaterThan(connections + 15);
		expect(r.pi.sent).toHaveLength(1);
		expect(r.f.notes).toHaveLength(2);
	});

	test("contact restored: the stage is the agent's activity again and a turn that finished meanwhile is delivered once", async () => {
		const r = rig({ [A]: "tool", [C]: "user" }, working(A), working(C));
		await r.w.watch(A);
		await r.w.watch(C);
		await r.clock.advance(1);
		r.feed.push(C, event(1, { kind: "tool", turn: 1, text: "bash: bun test" }));
		cut(r);
		r.feed.fail(A, new Error("connection reset"));
		r.feed.fail(C, new Error("connection reset"));
		await r.clock.advance(12 * 60_000);
		expect(jobOf(r, C)?.progressText).toBe(`» bash: bun test\n${STALE_STAGE}`);

		r.svc.details.set(A, finished(A));
		restore(r);
		await r.clock.advance(15_000);

		expect(r.w.followed(C)?.stale).toBe(false);
		expect(jobOf(r, C)?.progressText).toBe("» bash: bun test");
		expect(jobOf(r, C)?.status).toBe("running");
		expect(r.f.notes).toContainEqual([`☁ Add tests · ${C}: contact with the cloud is back`, "info"]);
		// A finished while contact was lost: the stale notice, then its result through omp's delivery, once.
		expect(r.pi.sent).toHaveLength(1);
		expect(r.pi.sent[0]?.message.content).toContain("lost contact with the cloud");
		await r.manager.drainDeliveries({ timeoutMs: 500 });
		expect(r.delivered).toEqual([JOB_IDS[A] ?? ""]);
		expect(jobOf(r, A)?.status).toBe("completed");
		expect(r.w.watching).toEqual([C]);
	});

	test("a stale thread that is deleted meanwhile is dropped when contact is back", async () => {
		const r = rig({ [A]: "tool" }, working(A));
		await r.w.watch(A);
		await r.clock.advance(1);
		cut(r);
		r.feed.fail(A, new Error("connection reset"));
		await r.clock.advance(11 * 60_000);
		r.svc.details.delete(A);
		restore(r);
		await r.clock.advance(15_000);
		expect(r.w.watching).toEqual([]);
		expect(jobOf(r, A)).toMatchObject({ status: "failed", errorText: "thread was deleted" });
		expect(r.pi.sent.map(s => s.message.content.split("\n")[0])).toEqual([expect.stringContaining("lost contact with the cloud"), expect.stringContaining("thread was deleted")]);
	});

	test("a question asked during the outage is announced once when contact is back", async () => {
		const r = rig({ [A]: "tool" }, working(A));
		await r.w.watch(A);
		await r.clock.advance(1);
		cut(r);
		r.feed.fail(A, new Error("connection reset"));
		await r.clock.advance(11 * 60_000);
		r.svc.details.set(A, detail({ id: A, name: NAMES[A] ?? "", title: "", phase: "waiting", question: pending({ text: "Which file?" }), turns: [turn(1, { state: "running" })] }));
		restore(r);
		await r.clock.advance(15_000);
		r.feed.push(A, event(1, { kind: "question_asked", turn: 1 }));
		await r.clock.advance(0);
		const asks = r.pi.sent.filter(s => s.message.content.includes("Which file?"));
		expect(asks).toHaveLength(1);
	});
});
