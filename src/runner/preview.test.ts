import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Sandbox } from "e2b";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import { ApiError } from "../server/errors";
import { NO_VM_MESSAGE } from "../server/preview";
import type { Store } from "../store";
import type { ThreadEvent } from "../store/types";
import { fakeVm, fakeVmon, openEnv, seedThread, until } from "./test-support";
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
	setSystemTime();
	await Promise.all(runners.splice(0).map(runner => runner.detach()));
	store.close();
	await rm(dir, { recursive: true, force: true });
});

/** A scripted sandbox that counts the timeouts it was given and whether they succeed. */
function sandboxOf(options: { setTimeoutFails?: () => boolean } = {}): { sandbox: Sandbox; timeouts: number[]; paused: () => number } {
	const vm = fakeVm({ dirty: false, head: "a".repeat(40) });
	const timeouts: number[] = [];
	const sandbox = {
		...vm.sandbox,
		setTimeout: async (ms: number) => {
			if (options.setTimeoutFails?.() === true) throw new Error("the sandbox is paused");
			timeouts.push(ms);
		},
	} as unknown as Sandbox;
	return { sandbox, timeouts, paused: vm.paused };
}

function runnerFor(vmon: ThreadEnv["vmon"], id: string, idleSeconds?: number): ThreadRunner {
	const config = idleSeconds === undefined ? env.config : { ...env.config, runner: { ...env.config.runner, idleTimeoutSeconds: idleSeconds } };
	const runner = new ThreadRunner({ ...env, vmon, config }, id);
	runners.push(runner);
	return runner;
}

function vmEvents(id: string): string[] {
	return store
		.events(id, 0, 1000)
		.filter((event: ThreadEvent) => event.kind === "vm")
		.map(event => event.text);
}

describe("ThreadRunner.vmFor", () => {
	test("a thread without a VM record is 409", async () => {
		const id = await seedThread(store, gateway, 1);
		store.removeVm(id);
		const { vmon, connects } = fakeVmon(sandboxOf().sandbox);
		const error = await runnerFor(vmon, id).vmFor().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 409, message: NO_VM_MESSAGE });
		expect(connects).toEqual([]);
	});

	test("a paused VM is resumed and recorded as running", async () => {
		const id = await seedThread(store, gateway, 1, "paused");
		const { vmon, connects } = fakeVmon(sandboxOf().sandbox);

		expect(await runnerFor(vmon, id).vmFor()).toBe("sb-1");

		expect(connects).toEqual(["sb-1"]);
		expect(store.vm(id)?.state).toBe("running");
		expect(vmEvents(id)).toContain("resumed");
	});

	test("a running VM is attached once, then used with no further round trip", async () => {
		const id = await seedThread(store, gateway, 1);
		const { sandbox, timeouts } = sandboxOf();
		const { vmon, connects } = fakeVmon(sandbox);
		const runner = runnerFor(vmon, id);

		expect(await runner.vmFor()).toBe("sb-1");
		expect(await runner.vmFor()).toBe("sb-1");
		expect(await runner.vmFor()).toBe("sb-1");

		expect(connects).toEqual(["sb-1"]);
		expect(timeouts).toEqual([]);
	});

	test("extends the sandbox's timeout at most once a minute, and resumes it when that fails", async () => {
		const id = await seedThread(store, gateway, 1);
		let failing = false;
		const { sandbox, timeouts } = sandboxOf({ setTimeoutFails: () => failing });
		const { vmon, connects } = fakeVmon(sandbox);
		const runner = runnerFor(vmon, id);
		const start = Date.now();
		setSystemTime(start);
		await runner.vmFor();

		setSystemTime(start + 30_000);
		await runner.vmFor();
		expect(timeouts).toEqual([]);

		setSystemTime(start + 61_000);
		await runner.vmFor();
		expect(timeouts).toEqual([env.config.runner.sandboxTimeoutSeconds * 1000]);

		failing = true;
		setSystemTime(start + 130_000);
		expect(await runner.vmFor()).toBe("sb-1");
		expect(connects).toEqual(["sb-1", "sb-1"]);
	});

	test("a VM vmon no longer has is 409 and its record is released", async () => {
		const id = await seedThread(store, gateway, 1, "paused");
		const { vmon } = fakeVmon(null);

		const error = await runnerFor(vmon, id).vmFor().catch((e: unknown) => e);

		expect(error).toMatchObject({ status: 409 });
		expect(store.vm(id)).toBeNull();
	});

	test("an idle VM that is previewed is paused once the previews stop", async () => {
		const id = await seedThread(store, gateway, 1);
		const { sandbox, paused } = sandboxOf();
		const { vmon } = fakeVmon(sandbox);
		const runner = runnerFor(vmon, id, 0.05);

		await runner.vmFor();
		expect(paused()).toBe(0);
		await until(() => store.vm(id)?.state === "paused", "the idle pause");

		expect(paused()).toBe(1);
		expect(vmEvents(id)).toContain("paused");
	});
});
