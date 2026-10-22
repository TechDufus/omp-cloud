import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import type { GitService, SignedResult, SignInput } from "../git";
import type { Settings } from "../settings";
import type { Store } from "../store";
import type { Turn } from "../store/types";
import { exit, fakeVm, fakeVmon, type FakeVm, HEAD, openEnv, promptResult, response, sandboxWithOmp, seedThread } from "./test-support";
import { type ThreadEnv, ThreadRunner } from "./thread";

const UNSIGNED = "b".repeat(40);
const SIGNED = "d".repeat(40);

let dir: string;
let store: Store;
let gateway: GatewayClients;
let settings: Settings;
let env: ThreadEnv;
const runners: ThreadRunner[] = [];

/** What the stubbed `GitService.signResult` was asked, and how it answers. */
let signCalls: SignInput[];
let disposed: number;
let signOutcome: "signed" | "nothing" | Error;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-signing-"));
	({ store, settings, gateway, env } = await openEnv(dir));
	signCalls = [];
	disposed = 0;
	signOutcome = "signed";
	const signResult = async (_threadId: string, input: SignInput): Promise<SignedResult | null> => {
		signCalls.push(input);
		if (signOutcome instanceof Error) throw signOutcome;
		if (signOutcome === "nothing") return null;
		const bundlePath = join(dir, "signed.bundle");
		await writeFile(bundlePath, "SIGNED-BUNDLE");
		return {
			bundlePath,
			head: SIGNED,
			rewritten: 2,
			dispose: async () => {
				disposed++;
			},
		};
	};
	// Only `signResult` is reached: the thread has no remote and `git.push` is never.
	env = { ...env, git: { signResult } as unknown as GitService };
});

afterEach(async () => {
	await Promise.all(runners.splice(0).map(runner => runner.detach()));
	store.close();
	await rm(dir, { recursive: true, force: true });
});

/** A turn of a seeded thread whose VM made a commit (its branch is at {@link UNSIGNED}, past the {@link HEAD} an earlier turn exposed). */
async function runTurn(vm: FakeVm): Promise<{ turn: Turn; id: string }> {
	const id = await seedThread(store, gateway, 1);
	const omp = sandboxWithOmp(vm, promptId => [response(promptId, "prompt"), promptResult(promptId, true)]);
	const runner = new ThreadRunner({ ...env, vmon: fakeVmon(omp.sandbox).vmon }, id);
	runners.push(runner);
	const queued = store.enqueueTurn(id, "work", "owner");
	const ended = new Promise<void>(resolve => {
		const unsubscribe = store.subscribeAll({
			event: (threadId, event) => {
				if (threadId !== id || event.turn !== queued.id || (event.kind !== "turn_done" && event.kind !== "turn_failed")) return;
				unsubscribe();
				resolve();
			},
			deleted: () => {},
		});
	});
	runner.wake();
	await ended;
	const turn = store.turns(id).find(t => t.id === queued.id);
	if (turn === undefined) throw new Error("the turn vanished");
	return { turn, id };
}

const eventsOf = (id: string, kind: string): string[] =>
	store
		.events(id, 0, 1000)
		.filter(event => event.kind === kind)
		.map(event => event.text);

const storedBundle = async (id: string): Promise<string> => (await store.blob(id, "result.bundle"))?.text() ?? "";

describe("git.sign ssh", () => {
	test("the service signs the turn's commits, the VM adopts them, and the stored bundle and head are the signed ones", async () => {
		settings.apply({ "git.sign": "ssh" }, "test");
		const made = env.signingKey.create();
		const vm = fakeVm({ dirty: false, head: UNSIGNED });

		const { turn, id } = await runTurn(vm);

		expect(turn.state).toBe("done");
		expect(turn.head).toBe(SIGNED);
		expect(await storedBundle(id)).toBe("SIGNED-BUNDLE");
		expect(signCalls).toHaveLength(1);
		expect(signCalls[0]).toMatchObject({
			uploadedHead: HEAD,
			head: UNSIGNED,
			branch: `omp-cloud/${id}`,
			committer: null,
			resultBundle: store.blobPath(id, "result.bundle"),
		});
		expect(signCalls[0]?.privatePem).toStartWith("-----BEGIN PRIVATE KEY-----");
		expect(vm.uploads).toEqual(["/tmp/omp-cloud-signed.bundle"]);
		const adopt = vm.commands.findIndex(command => command.includes("refs/omp-cloud/signed") && command.includes("fetch -q"));
		const remove = vm.commands.findLastIndex(command => command.includes("rm -f '/tmp/omp-cloud-signed.bundle'"));
		expect(adopt).toBeGreaterThan(-1);
		expect(remove).toBeGreaterThan(adopt);
		expect(vm.commands.some(command => command.includes("reset -q --soft") && command.includes(SIGNED))).toBe(true);
		expect(eventsOf(id, "sign")).toEqual([`signed 2 commits with ${made.fingerprint}`]);
		expect(eventsOf(id, "notice")).toEqual([]);
		expect(disposed).toBe(1);
	});

	test("a VM that cannot adopt the signed tip leaves the unsigned bundle and head, with a notice", async () => {
		settings.apply({ "git.sign": "ssh" }, "test");
		env.signingKey.create();
		const vm = fakeVm({
			dirty: false,
			head: UNSIGNED,
			onCommand: command => {
				if (command.includes("fetch -q") && command.includes("refs/omp-cloud/signed")) throw exit(128);
			},
		});

		const { turn, id } = await runTurn(vm);

		expect(turn.state).toBe("done");
		expect(turn.head).toBe(UNSIGNED);
		expect(await storedBundle(id)).toBe("content of /tmp/omp-cloud-result.bundle");
		expect(eventsOf(id, "sign")).toEqual([]);
		expect(eventsOf(id, "notice")).toEqual([expect.stringContaining("the commits were not signed: command failed (exit 128)")]);
		expect(disposed).toBe(1);
		// Nothing of the signed upload is left in the VM.
		expect(vm.commands.some(command => command.includes("rm -f '/tmp/omp-cloud-signed.bundle'"))).toBe(true);
	});

	test("a signing failure in the service is a notice, not a failed turn", async () => {
		settings.apply({ "git.sign": "ssh" }, "test");
		env.signingKey.create();
		signOutcome = new Error("the base is not available");

		const { turn, id } = await runTurn(fakeVm({ dirty: false, head: UNSIGNED }));

		expect(turn.state).toBe("done");
		expect(turn.head).toBe(UNSIGNED);
		expect(await storedBundle(id)).toBe("content of /tmp/omp-cloud-result.bundle");
		expect(eventsOf(id, "notice")).toEqual(["the commits were not signed: the base is not available"]);
	});

	test("no key: a notice names the dashboard page, and the result stays unsigned", async () => {
		settings.apply({ "git.sign": "ssh" }, "test");

		const { turn, id } = await runTurn(fakeVm({ dirty: false, head: UNSIGNED }));

		expect(turn.head).toBe(UNSIGNED);
		expect(signCalls).toEqual([]);
		expect(eventsOf(id, "notice")).toEqual(["git.sign is ssh but the service has no signing key: create it on the dashboard's GitHub page"]);
	});

	test("nothing to sign (every commit already signed) keeps the head and says nothing", async () => {
		settings.apply({ "git.sign": "ssh" }, "test");
		env.signingKey.create();
		signOutcome = "nothing";

		const vm = fakeVm({ dirty: false, head: UNSIGNED });
		const { turn, id } = await runTurn(vm);

		expect(turn.head).toBe(UNSIGNED);
		expect(vm.uploads).toEqual([]);
		expect(eventsOf(id, "sign")).toEqual([]);
		expect(eventsOf(id, "notice")).toEqual([]);
		expect(disposed).toBe(0);
	});

	test("git.sign off never asks the service to sign", async () => {
		env.signingKey.create();

		const { turn } = await runTurn(fakeVm({ dirty: false, head: UNSIGNED }));

		expect(turn.head).toBe(UNSIGNED);
		expect(signCalls).toEqual([]);
	});

	test("a turn that made no new commit has no bundle to sign", async () => {
		settings.apply({ "git.sign": "ssh" }, "test");
		env.signingKey.create();

		const { turn } = await runTurn(fakeVm({ dirty: false, head: HEAD }));

		expect(turn.head).toBe(HEAD);
		expect(signCalls).toEqual([]);
	});
});
