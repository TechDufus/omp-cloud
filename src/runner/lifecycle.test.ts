import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import type { Settings } from "../settings";
import type { Store } from "../store";
import type { ThreadEvent } from "../store/types";
import type { SandboxSummary, Vmon } from "../vmon";
import { archiveSweep, ARCHIVE_PER_SWEEP, sweepOrphans } from "./lifecycle";
import { DROP_STALE_SOCKETS } from "./stale-sockets";
import { fakeVm, fakeVmon, HEAD, openEnv, seedThread, threadId } from "./test-support";
import { clientName, serviceClientName, type ArchiveOutcome, ThreadRunner, type ThreadEnv } from "./thread";

const SNAPSHOT_HEAD = "b".repeat(40);
const DAY_MS = 86_400_000;

let dir: string;
let store: Store;
let settings: Settings;
let gateway: GatewayClients;
let env: ThreadEnv;
const runners: ThreadRunner[] = [];

function runnerFor(vmon: Vmon, id: string): ThreadRunner {
	const runner = new ThreadRunner({ ...env, vmon }, id);
	runners.push(runner);
	return runner;
}

function eventsOf(id: string, kind: string): string[] {
	return store
		.events(id, 0, 1000)
		.filter((event: ThreadEvent) => event.kind === kind)
		.map(event => event.text);
}

/** Past every thread's activity, so each idle thread is archivable. */
function later(): string {
	return new Date(Date.now() + DAY_MS).toISOString();
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	({ store, settings, gateway, env } = await openEnv(dir));
});

afterEach(async () => {
	setSystemTime();
	await Promise.all(runners.splice(0).map(runner => runner.detach()));
	store.close();
	await rm(dir, { recursive: true, force: true });
});

describe("ThreadRunner.archive", () => {
	test("snapshots the work and the conversation before it releases the VM", async () => {
		const id = await seedThread(store, gateway, 1);
		const vm = fakeVm({ dirty: true, head: SNAPSHOT_HEAD });
		const { vmon, killed, onKill } = fakeVmon(vm.sandbox);
		// At the kill the archive is recorded, and the VM record and the gateway client are still there.
		const atKill: { archivedAt: string | null; vm: boolean; client: boolean }[] = [];
		onKill.run = async () => {
			atKill.push({
				archivedAt: store.getThread(id)?.archivedAt ?? null,
				vm: store.vm(id) !== null,
				client: (await gateway.names()).includes(clientName(store.serviceId(), id)),
			});
		};

		expect(await runnerFor(vmon, id).archive(later(), 7)).toBe("archived");

		const at = (part: string) => vm.commands.findIndex(command => command.includes(part));
		expect(vm.commands.filter(command => command.includes("commit -q --no-verify -m 'omp-cloud: archive snapshot'"))).toHaveLength(1);
		expect(at("commit -q")).toBeGreaterThanOrEqual(0);
		expect(at("commit -q")).toBeLessThan(at("bundle create"));
		expect(at("bundle create")).toBeLessThan(at("omp session pack"));
		expect(killed).toEqual(["sb-1"]);
		expect(atKill).toHaveLength(1);
		expect(atKill[0]?.archivedAt).not.toBeNull();
		expect(atKill[0]?.vm).toBe(true);
		expect(atKill[0]?.client).toBe(true);

		const thread = store.getThread(id);
		expect(thread?.archivedAt).not.toBeNull();
		expect(thread?.restoreHead).toBe(SNAPSHOT_HEAD);
		expect(await (await store.blob(id, "result.bundle"))?.text()).toContain("omp-cloud-result.bundle");
		expect(await (await store.blob(id, "session-export.tar"))?.text()).toContain("omp-cloud-session-export.tar");
		expect(store.vm(id)).toBeNull();
		expect(await gateway.names()).not.toContain(clientName(store.serviceId(), id));
		expect(eventsOf(id, "vm").at(-1)).toContain("archived after 7 days without activity");
	});

	test("a clean workspace at the stored head commits and bundles nothing, and records no restore head", async () => {
		const id = await seedThread(store, gateway, 1);
		const vm = fakeVm({ dirty: false, head: HEAD });
		const { vmon, killed } = fakeVmon(vm.sandbox);

		expect(await runnerFor(vmon, id).archive(later(), 7)).toBe("archived");

		expect(vm.commands.some(command => command.includes("commit -q"))).toBe(false);
		expect(vm.commands.some(command => command.includes("bundle create"))).toBe(false);
		expect(store.getThread(id)?.restoreHead).toBe("");
		expect(killed).toEqual(["sb-1"]);
	});

	test("eligibility is checked again in the thread's queue", async () => {
		const id = await seedThread(store, gateway, 1);
		const vm = fakeVm({ dirty: false, head: HEAD });
		const { vmon, connects, killed } = fakeVmon(vm.sandbox);

		// The cutoff precedes the thread's activity: it is not idle long enough.
		expect(await runnerFor(vmon, id).archive(new Date(Date.now() - DAY_MS).toISOString(), 7)).toBe("skipped");

		expect(connects).toEqual([]);
		expect(killed).toEqual([]);
		expect(store.getThread(id)?.archivedAt).toBeNull();
		expect(store.vm(id)).not.toBeNull();
	});

	test("a message that arrives during the snapshot keeps the VM", async () => {
		const id = await seedThread(store, gateway, 1);
		const vm = fakeVm({
			dirty: true,
			head: SNAPSHOT_HEAD,
			onCommand: command => {
				if (command.includes("bundle create")) store.enqueueTurn(id, "more", "owner");
			},
		});
		const { vmon, killed } = fakeVmon(vm.sandbox);

		expect(await runnerFor(vmon, id).archive(later(), 7)).toBe("skipped");

		expect(killed).toEqual([]);
		expect(store.getThread(id)?.archivedAt).toBeNull();
		expect(store.vm(id)).not.toBeNull();
		expect(await gateway.names()).toContain(clientName(store.serviceId(), id));
	});

	test("a failed snapshot keeps the VM, says so and backs the thread off for a day", async () => {
		const id = await seedThread(store, gateway, 1);
		const vm = fakeVm({ dirty: true, head: SNAPSHOT_HEAD, failBundle: true });
		const { vmon, connects, killed } = fakeVmon(vm.sandbox);
		const runner = runnerFor(vmon, id);

		expect(await runner.archive(later(), 7)).toBe<ArchiveOutcome>("postponed");

		expect(killed).toEqual([]);
		expect(store.vm(id)).not.toBeNull();
		expect(await gateway.names()).toContain(clientName(store.serviceId(), id));
		expect(store.getThread(id)?.archivedAt).toBeNull();
		expect(eventsOf(id, "notice").at(-1)).toContain("archive postponed:");

		// Within the day the thread is left alone.
		expect(await runner.archive(later(), 7)).toBe("skipped");
		expect(connects).toHaveLength(1);

		// After it the archive is tried again.
		setSystemTime(new Date(Date.now() + DAY_MS + 60_000));
		expect(await runner.archive(new Date(Date.now() + DAY_MS).toISOString(), 7)).toBe("postponed");
		expect(connects).toHaveLength(2);
	});

	test("a paused VM is resumed for the snapshot and paused again when the archive fails", async () => {
		const id = await seedThread(store, gateway, 1, "paused");
		const vm = fakeVm({ dirty: true, head: SNAPSHOT_HEAD, failBundle: true });
		const { vmon, connects, killed } = fakeVmon(vm.sandbox);

		expect(await runnerFor(vmon, id).archive(later(), 7)).toBe("postponed");

		expect(connects).toEqual(["sb-1"]);
		expect(killed).toEqual([]);
		expect(vm.paused()).toBe(1);
		expect(store.vm(id)?.state).toBe("paused");
	});

	test("a resume that gave the VM another address drops the connections of the old one and says so", async () => {
		const id = await seedThread(store, gateway, 1, "paused");
		const vm = fakeVm({ dirty: true, head: SNAPSHOT_HEAD, failBundle: true, staleAddresses: ["172.20.0.138"] });
		const { vmon } = fakeVmon(vm.sandbox);

		await runnerFor(vmon, id).archive(later(), 7);

		// Right after the resume, before any work in the guest.
		expect(vm.commands[0]).toBe(DROP_STALE_SOCKETS);
		expect(eventsOf(id, "vm")).toContain("the sandbox's address changed: dropped its connections from 172.20.0.138");
	});

	test("a resume that kept the address says nothing about connections", async () => {
		const id = await seedThread(store, gateway, 1, "paused");
		const vm = fakeVm({ dirty: true, head: SNAPSHOT_HEAD, failBundle: true });
		const { vmon } = fakeVmon(vm.sandbox);

		await runnerFor(vmon, id).archive(later(), 7);

		expect(vm.commands[0]).toBe(DROP_STALE_SOCKETS);
		expect(eventsOf(id, "vm").some(text => text.includes("address changed"))).toBe(false);
	});

	test("a sandbox vmon no longer has is nothing to archive", async () => {
		const id = await seedThread(store, gateway, 1, "paused");
		const { vmon, killed } = fakeVmon(null);

		expect(await runnerFor(vmon, id).archive(later(), 7)).toBe("skipped");

		expect(killed).toEqual([]);
		expect(store.getThread(id)?.archivedAt).toBeNull();
	});
});

describe("archiveSweep", () => {
	/** Runners that record what they were asked and answer from `outcomes` (then "archived"). */
	function recording(outcomes: ArchiveOutcome[] = []): { runnerOf: (id: string) => Pick<ThreadRunner, "archive">; asked: { id: string; days: number }[] } {
		const asked: { id: string; days: number }[] = [];
		return {
			asked,
			runnerOf: id => ({
				archive: async (_cutoff, days) => {
					asked.push({ id, days });
					return outcomes[asked.length - 1] ?? "archived";
				},
			}),
		};
	}

	/** An instant `days` days after every seeded thread's activity. */
	const after = (days: number): number => Date.now() + days * DAY_MS;

	test("takes at most five threads per sweep", async () => {
		for (let n = 1; n <= 8; n++) await seedThread(store, gateway, n);
		const { runnerOf, asked } = recording();

		await archiveSweep(env, runnerOf, after(8), () => false);

		expect(asked).toHaveLength(ARCHIVE_PER_SWEEP);
		expect(asked.every(call => call.days === 7)).toBe(true);
	});

	test("threads that turn out ineligible or backed off do not use up the five", async () => {
		for (let n = 1; n <= 8; n++) await seedThread(store, gateway, n);
		const { runnerOf, asked } = recording(["skipped", "skipped", "skipped"]);

		await archiveSweep(env, runnerOf, after(8), () => false);

		expect(asked).toHaveLength(3 + ARCHIVE_PER_SWEEP);
	});

	test("only threads idle for longer than the setting are offered", async () => {
		await seedThread(store, gateway, 1);
		const { runnerOf, asked } = recording();

		await archiveSweep(env, runnerOf, after(6), () => false);
		expect(asked).toEqual([]);

		await archiveSweep(env, runnerOf, after(8), () => false);
		expect(asked.map(call => call.id)).toEqual([threadId(1)]);
	});

	test("the setting is read at every sweep, and 0 never archives", async () => {
		await seedThread(store, gateway, 1);
		const { runnerOf, asked } = recording();

		settings.apply({ "lifecycle.archiveAfterDays": 0 }, "test");
		await archiveSweep(env, runnerOf, after(400), () => false);
		expect(asked).toEqual([]);

		settings.apply({ "lifecycle.archiveAfterDays": 0.5 }, "test");
		await archiveSweep(env, runnerOf, after(1), () => false);
		expect(asked).toEqual([{ id: threadId(1), days: 0.5 }]);
	});

	test("stops when the runner stops", async () => {
		for (let n = 1; n <= 3; n++) await seedThread(store, gateway, n);
		const { runnerOf, asked } = recording();
		let cancelled = false;
		const stopping: typeof runnerOf = id => {
			const inner = runnerOf(id);
			return {
				archive: async (cutoff, days) => {
					const outcome = await inner.archive(cutoff, days);
					cancelled = true;
					return outcome;
				},
			};
		};

		await archiveSweep(env, stopping, after(8), () => cancelled);

		expect(asked).toHaveLength(1);
	});
});

describe("sweepOrphans", () => {
	const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

	function sandboxStarted(id: string, ageMinutes: number): SandboxSummary {
		return {
			sandboxId: id,
			state: "running",
			metadata: { app: "omp-cloud", service: store.serviceId() },
			startedAt: new Date(NOW - ageMinutes * 60_000).toISOString(),
			cpuCount: 1,
			memoryMB: 512,
		};
	}

	test("looks at exactly this service's sandboxes", async () => {
		const { vmon, filters } = fakeVmon(null);

		await sweepOrphans({ ...env, vmon }, 3600, NOW);

		expect(filters).toEqual([
			{ app: "omp-cloud", service: store.serviceId() },
			{ app: "omp-cloud-env", service: store.serviceId() },
		]);
	});

	test("kills a sandbox no VM record holds once it is older than twice the sweep interval, never a younger or a held one", async () => {
		await seedThread(store, gateway, 1);
		const sandboxes = [sandboxStarted("sb-1", 600), sandboxStarted("old", 180), sandboxStarted("young", 60)];
		const { vmon, killed } = fakeVmon(null, sandboxes);

		// Hourly sweeps: the grace is two hours.
		await sweepOrphans({ ...env, vmon }, 3600, NOW);

		expect(killed).toEqual(["old"]);
	});

	test("the grace is ten minutes at the least", async () => {
		const sandboxes = [sandboxStarted("eleven", 11), sandboxStarted("nine", 9)];
		const { vmon, killed } = fakeVmon(null, sandboxes);

		await sweepOrphans({ ...env, vmon }, 60, NOW);

		expect(killed).toEqual(["eleven"]);
	});

	test("a sandbox with an unreadable start time is left alone", async () => {
		const { vmon, killed } = fakeVmon(null, [{ ...sandboxStarted("odd", 0), startedAt: "yesterday-ish" }]);

		await sweepOrphans({ ...env, vmon }, 60, NOW);

		expect(killed).toEqual([]);
	});

	test("one sandbox that cannot be killed does not stop the sweep", async () => {
		const { vmon, killed, onKill } = fakeVmon(null, [sandboxStarted("stuck", 300), sandboxStarted("other", 300)]);
		let first = true;
		onKill.run = () => {
			if (!first) return;
			first = false;
			throw new Error("vmon is busy");
		};
		const quiet = console.error;
		console.error = () => {};
		try {
			await sweepOrphans({ ...env, vmon }, 60, NOW);
		} finally {
			console.error = quiet;
		}

		expect(killed).toEqual(["other"]);
	});

	describe("environment build sandboxes", () => {
		function envSandbox(id: string, ageMinutes: number, service = store.serviceId()): SandboxSummary {
			return { ...sandboxStarted(id, ageMinutes), metadata: { app: "omp-cloud-env", service, key: "k" } };
		}

		test("one older than two hours is killed, a running build (younger) is not", async () => {
			const { vmon, killed } = fakeVmon(null, [envSandbox("stale", 121), envSandbox("building", 119), envSandbox("fresh", 1)]);

			await sweepOrphans({ ...env, vmon }, 60, NOW);

			expect(killed).toEqual(["stale"]);
		});

		test("the orphan grace does not apply to a build, and another service's builds are never touched", async () => {
			// Past the orphan grace (10 minutes) yet far from two hours: the orphan pass must not take it.
			const { vmon, killed } = fakeVmon(null, [envSandbox("building", 30), envSandbox("theirs", 600, "another-service")]);

			await sweepOrphans({ ...env, vmon }, 60, NOW);

			expect(killed).toEqual([]);
		});

		test("a sandbox that cannot be killed is logged and the sweep goes on", async () => {
			const { vmon, killed, onKill } = fakeVmon(null, [envSandbox("stuck", 300), envSandbox("other", 300)]);
			let first = true;
			onKill.run = () => {
				if (!first) return;
				first = false;
				throw new Error("vmon is busy");
			};
			const quiet = console.error;
			console.error = () => {};
			try {
				await sweepOrphans({ ...env, vmon }, 60, NOW);
			} finally {
				console.error = quiet;
			}

			expect(killed).toEqual(["other"]);
		});
	});

	test("revokes the gateway clients of threads without a VM record, never a backed one, the service's own or another service's", async () => {
		const service = store.serviceId();
		const backed = await seedThread(store, gateway, 1);
		const unbacked = clientName(service, threadId(2));
		await gateway.issue(unbacked);
		await gateway.issue(serviceClientName(service));
		await gateway.issue("omp-cloud-someone-else-aaaaaaaaaaaa");
		await gateway.issue("unrelated");
		const { vmon } = fakeVmon(null);

		await sweepOrphans({ ...env, vmon }, 3600, NOW);

		expect((await gateway.names()).sort()).toEqual(
			[clientName(service, backed), serviceClientName(service), "omp-cloud-someone-else-aaaaaaaaaaaa", "unrelated"].sort(),
		);
	});
});
