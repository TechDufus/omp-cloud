import { afterEach, describe, expect, jest, test } from "bun:test";
import { ApiError } from "./errors";
import { INSPECTION_WAIT_MS, InspectGate, MAX_RUNNING_INSPECTIONS } from "./inspect-gate";

/** A unit of work that records when it starts and ends, and finishes when `release` is called. */
function task(log: string[], name: string): { run: () => Promise<string>; release: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return {
		run: async () => {
			log.push(`start ${name}`);
			await promise;
			log.push(`end ${name}`);
			return name;
		},
		release: resolve,
	};
}

const never = new AbortController().signal;

/** Lets every promise continuation that is already runnable run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

afterEach(() => {
	jest.useRealTimers();
});

describe("InspectGate", () => {
	test("the service gate admits 2 at a time and waits 30 s", async () => {
		expect([MAX_RUNNING_INSPECTIONS, INSPECTION_WAIT_MS]).toEqual([2, 30_000]);
		const gate = new InspectGate();
		const log: string[] = [];
		const tasks = ["a", "b", "c"].map((name) => task(log, name));
		const runs = tasks.map((t) => gate.run(never, t.run));
		await settle();
		expect(log).toEqual(["start a", "start b"]);
		for (const t of tasks) t.release();
		await Promise.all(runs);
		expect(log).toContain("start c");
	});

	test("never more than the limit run at once, and waiters start in arrival order as places free up", async () => {
		const gate = new InspectGate(2, 5000);
		const log: string[] = [];
		const tasks = ["1", "2", "3", "4", "5"].map((name) => task(log, name));
		const runs = tasks.map((t) => gate.run(never, t.run));
		await settle();
		expect(log).toEqual(["start 1", "start 2"]);

		tasks[1]?.release();
		await settle();
		expect(log).toEqual(["start 1", "start 2", "end 2", "start 3"]);
		tasks[0]?.release();
		await settle();
		expect(log.slice(4)).toEqual(["end 1", "start 4"]);
		tasks[2]?.release();
		await settle();
		expect(log.slice(6)).toEqual(["end 3", "start 5"]);
		tasks[3]?.release();
		tasks[4]?.release();
		expect(await Promise.all(runs)).toEqual(["1", "2", "3", "4", "5"]);
		// Every place came back: a new run starts at once.
		const again = task(log, "6");
		const run = gate.run(never, again.run);
		await settle();
		expect(log.at(-1)).toBe("start 6");
		again.release();
		await run;
	});

	test("a waiter that gets no place within the wait is a 503 with Retry-After 5, and the queue behind it still works", async () => {
		jest.useFakeTimers();
		const gate = new InspectGate(1, 40);
		const log: string[] = [];
		const holder = task(log, "holder");
		const held = gate.run(never, holder.run);
		await settle();

		const late = rejection(gate.run(never, task(log, "late").run));
		// A request that arrives later has its own 40 ms.
		jest.advanceTimersByTime(30);
		const later = task(log, "later");
		const laterRun = gate.run(never, later.run);
		jest.advanceTimersByTime(10);
		const error = await late;
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 503, message: "inspection busy; retry shortly", headers: { "Retry-After": "5" } });
		expect(log).toEqual(["start holder"]);

		holder.release();
		await held;
		await settle();
		expect(log).toEqual(["start holder", "end holder", "start later"]);
		later.release();
		await laterRun;
	});

	test("a client that disconnects while waiting leaves the queue: its work never runs and the place goes to the next waiter", async () => {
		const gate = new InspectGate(1, 5000);
		const log: string[] = [];
		const holder = task(log, "holder");
		const held = gate.run(never, holder.run);
		await settle();

		const gone = new AbortController();
		const goneRun = gate.run(gone.signal, task(log, "gone").run);
		const next = task(log, "next");
		const nextRun = gate.run(never, next.run);
		await settle();

		gone.abort();
		expect(await rejection(goneRun)).toMatchObject({ status: 499 });
		holder.release();
		await held;
		await settle();
		expect(log).toEqual(["start holder", "end holder", "start next"]);
		next.release();
		await nextRun;
	});

	test("a signal that is already aborted never runs, and a failing run frees its place", async () => {
		const gate = new InspectGate(1, 5000);
		const log: string[] = [];
		expect(await rejection(gate.run(AbortSignal.abort(), task(log, "x").run))).toMatchObject({ status: 499 });
		expect(log).toEqual([]);

		expect(await rejection(gate.run(never, () => Promise.reject(new Error("boom"))))).toMatchObject({ message: "boom" });
		const after = task(log, "after");
		const run = gate.run(never, after.run);
		await settle();
		expect(log).toEqual(["start after"]);
		after.release();
		await run;
	});
});
