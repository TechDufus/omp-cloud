import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import type { Store } from "../store";
import type { Vmon } from "../vmon";
import { fakeVmon, openEnv, seedThread } from "./test-support";
import { clientName, type ThreadEnv, ThreadRunner } from "./thread";

let dir: string;
let store: Store;
let gateway: GatewayClients;
let env: ThreadEnv;
const runners: ThreadRunner[] = [];
const restores: (() => void)[] = [];

/** The retry backoffs of an unreachable VM (5, 15, 30, 60 and 120 s) shrink to a millisecond; every other timer is untouched. */
function shrinkBackoffs(): void {
	const real = globalThis.setTimeout;
	const backoffs = new Set([5000, 15_000, 30_000, 60_000, 120_000]);
	const spy = spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) =>
		real(handler, ms !== undefined && backoffs.has(ms) ? 1 : ms, ...args)) as unknown as typeof setTimeout);
	restores.push(() => spy.mockRestore());
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	({ store, gateway, env } = await openEnv(dir));
	shrinkBackoffs();
});

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	await Promise.all(runners.splice(0).map(runner => runner.detach()));
	store.close();
	await rm(dir, { recursive: true, force: true });
});

/** A vmon whose `connect` fails like a machine that is asleep (503, never a 404), whose own health is `healthy`, and that cannot build a template. */
function unreachable(healthy: boolean): { vmon: Vmon; connects: string[]; templates: number } {
	const base = fakeVmon(null);
	const state = { connects: base.connects, templates: 0 };
	const vmon = {
		...base.vmon,
		connect: async (id: string) => {
			state.connects.push(id);
			throw new Error("503 Service Unavailable");
		},
		healthy: async () => healthy,
		ensureTemplate: async () => {
			state.templates++;
			throw new Error("no template in this test");
		},
	} as unknown as Vmon;
	return {
		vmon,
		get connects() {
			return state.connects;
		},
		get templates() {
			return state.templates;
		},
	};
}

/** Queues a turn on a thread whose paused VM `sb-1` is unreachable, wakes its runner and waits until the thread failed. */
async function runUntilFailed(vmon: Vmon): Promise<string> {
	const id = await seedThread(store, gateway, 1, "paused");
	const runner = new ThreadRunner({ ...env, vmon }, id);
	runners.push(runner);
	const { promise: ended, resolve } = Promise.withResolvers<void>();
	const unsubscribe = store.subscribeAll({
		event: (threadId, event) => {
			if (threadId !== id || event.kind !== "turn_failed") return;
			unsubscribe();
			resolve();
		},
		deleted: () => {},
	});
	store.enqueueTurn(id, "work", "owner");
	runner.wake();
	await ended;
	return id;
}

const eventsOf = (id: string): string[] => store.events(id, 0, 1000).map(event => event.text);

describe("a VM that never answers", () => {
	test("is replaced by a new VM once the retries are used up and vmon itself is healthy", async () => {
		const fake = unreachable(true);

		const id = await runUntilFailed(fake.vmon);

		// The first attempt and the five retries all reached for sb-1; then the thread went to a new VM (which this test cannot build).
		expect(fake.connects).toEqual(Array(6).fill("sb-1"));
		expect(fake.templates).toBe(1);
		const events = eventsOf(id);
		expect(events).toContain("the VM did not answer for about 4 minutes (503 Service Unavailable); restoring the thread on a new VM");
		expect(events.filter(text => text.startsWith("the VM is not reachable"))).toHaveLength(5);
		expect(events.some(text => text.startsWith("could not prepare the VM"))).toBe(true);
		// The old VM is forgotten, never killed, and its gateway client is revoked so a partitioned copy cannot call a model.
		expect(store.vm(id)).toBeNull();
		expect(await gateway.names()).not.toContain(clientName(store.serviceId(), id));
	});

	test("fails the thread as before when vmon does not answer either", async () => {
		const fake = unreachable(false);

		const id = await runUntilFailed(fake.vmon);

		expect(fake.connects).toEqual(Array(6).fill("sb-1"));
		expect(fake.templates).toBe(0);
		const events = eventsOf(id);
		expect(events.some(text => text.includes("the VM did not answer"))).toBe(false);
		expect(events.some(text => text.includes("the VM stopped responding: 503 Service Unavailable"))).toBe(true);
		expect(store.vm(id)?.sandboxId).toBe("sb-1");
	});
});
