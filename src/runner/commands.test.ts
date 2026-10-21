import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import type { Settings } from "../settings";
import type { Store } from "../store";
import type { Turn } from "../store/types";
import {
	assistantEnd,
	fakeVm,
	fakeVmon,
	type FakeVm,
	localAck,
	openEnv,
	promptResult,
	response,
	sandboxWithOmp,
	type Script,
	seedThread,
	type StateScript,
} from "./test-support";
import { type ThreadEnv, ThreadRunner } from "./thread";

let dir: string;
let store: Store;
let gateway: GatewayClients;
let settings: Settings;
let env: ThreadEnv;
const runners: ThreadRunner[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	({ store, settings, gateway, env } = await openEnv(dir));
});

afterEach(async () => {
	await Promise.all(runners.splice(0).map(runner => runner.detach()));
	store.close();
	await rm(dir, { recursive: true, force: true });
});

/** Queues `text` as turn 2 of a seeded thread whose VM holds the fake omp and waits for the turn to end. `remote` gives the thread a git remote and `git.push` auto; `irc` is whether omp lists `/irc-in`. */
async function runTurn(
	script: Script,
	text: string,
	options: { afterPrompt?: StateScript; remote?: boolean; irc?: boolean } = {},
): Promise<{ turn: Turn; ms: number; vm: FakeVm; prompts: string[]; id: string }> {
	const id = await seedThread(store, gateway, 1, "running", options.remote === true ? "https://git.example.com/a/b.git" : "");
	if (options.remote === true) settings.apply({ "git.push": "auto" }, "test");
	const vm = fakeVm({ dirty: false, head: "a".repeat(40) });
	const { sandbox, prompts } = sandboxWithOmp(vm, script, { afterPrompt: options.afterPrompt, irc: options.irc });
	const runner = new ThreadRunner({ ...env, vmon: fakeVmon(sandbox).vmon }, id);
	runners.push(runner);
	const queued = store.enqueueTurn(id, text, "owner");
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

	const started = Date.now();
	runner.wake();
	await ended;
	const turn = store.turns(id).find(t => t.id === queued.id);
	if (turn === undefined) throw new Error("the turn vanished");
	return { turn, ms: Date.now() - started, vm, prompts, id };
}

/** The push events of a thread (`push failed: …`, `pushed …`, a declined or expired question). */
function pushEventsOf(id: string): string[] {
	return store
		.events(id, 0, 1000)
		.filter(event => event.kind === "push")
		.map(event => event.text);
}

describe("a prompt that runs as a command", () => {
	test("a built-in's output is the reply, and the turn ends once omp is quiet, long before the lost-frame poll", async () => {
		const { turn, ms, prompts } = await runTurn(
			id => [
				{ type: "command_output", text: "Session: abc123" },
				{ type: "command_output", text: "Messages: 4" },
				localAck(id),
			],
			"/session info",
		);

		expect(prompts).toEqual(["/session info"]);
		expect(turn.state).toBe("done");
		expect(turn.reply).toBe("Session: abc123\nMessages: 4");
		// The 30 s `get_state` poll is only the lost-frame fallback.
		expect(ms).toBeLessThan(5000);
	});

	test("it records no model usage, commits nothing, bundles nothing and pushes nothing", async () => {
		// The thread has a remote and `git.push` auto: a model turn would be pushed.
		const { turn, vm, id } = await runTurn(ackId => [{ type: "command_output", text: "usage report" }, localAck(ackId)], "/usage", { remote: true });

		expect(turn.usage).toBeNull();
		expect(turn.requests).toBe(0);
		expect(turn.tools).toBe(0);
		expect(turn.pushed).toBe(false);
		expect(pushEventsOf(id)).toEqual([]);
		expect(vm.commands.some(command => command.includes("commit -q"))).toBe(false);
		expect(vm.commands.some(command => command.includes("bundle create"))).toBe(false);
		expect(store.getThread(id)?.phase).toBe("idle");
	});

	test("the context the VM's omp reports still lands on the thread", async () => {
		const { id } = await runTurn(ackId => [{ type: "command_output", text: "x" }, localAck(ackId)], "/todo");

		expect(store.getThread(id)?.context).toMatchObject({ tokens: 1200, window: 200_000 });
	});

	test("a command that prints nothing ends the turn with an empty reply", async () => {
		const { turn } = await runTurn(ackId => [localAck(ackId)], "/fresh");

		expect(turn.state).toBe("done");
		expect(turn.reply).toBe("");
	});

	test("an extension command's notifications are the reply; its prompt_result ends the turn", async () => {
		const { turn, ms } = await runTurn(
			id => [
				{ type: "extension_ui_request", id: "n1", method: "notify", message: "deployed to staging", notifyType: "info" },
				{ type: "extension_ui_request", id: "n2", method: "notify", message: "2 warnings", notifyType: "warning" },
				response(id, "prompt"),
				promptResult(id, false),
			],
			"/deploy staging",
		);

		expect(turn.state).toBe("done");
		expect(turn.reply).toBe("deployed to staging\n2 warnings");
		expect(turn.usage).toBeNull();
		expect(ms).toBeLessThan(5000);
	});

	test("output past the cap is cut", async () => {
		const { turn } = await runTurn(
			id => [{ type: "command_output", text: "x".repeat(150_000) }, { type: "command_output", text: "dropped" }, localAck(id)],
			"/dump",
		);

		expect(turn.reply.length).toBeLessThanOrEqual(100_001);
		expect(turn.reply.endsWith("…")).toBe(true);
		expect(turn.reply).not.toContain("dropped");
	});
});

describe("a prompt for the model", () => {
	test("is unchanged: the assistant text is the reply, with usage, one request, and the result is finalized", async () => {
		const { turn, vm, id } = await runTurn(
			ackId => [response(ackId, "prompt"), assistantEnd("all done"), promptResult(ackId, true)],
			"fix the bug",
		);

		expect(turn.state).toBe("done");
		expect(turn.reply).toBe("all done");
		expect(turn.usage?.inputTokens).toBe(10);
		expect(turn.requests).toBe(1);
		expect(vm.commands.some(command => command.includes("diff --cached --quiet"))).toBe(true);
		expect(store.getThread(id)?.context).toMatchObject({ tokens: 1200 });
	});

	test("command output and notifications of a turn that invoked the model never replace its reply", async () => {
		const { turn } = await runTurn(
			ackId => [
				{ type: "command_output", text: "noise" },
				{ type: "extension_ui_request", id: "n1", method: "notify", message: "also noise", notifyType: "info" },
				response(ackId, "prompt"),
				assistantEnd("the answer"),
				promptResult(ackId, true),
			],
			"/review the diff",
		);

		expect(turn.reply).toBe("the answer");
	});

	test("an extension command that goes on to ask the model is a model turn: its text is the reply, its usage is kept and its result is pushed", async () => {
		const { turn, id } = await runTurn(
			ackId => [
				{ type: "extension_ui_request", id: "n1", method: "notify", message: "starting", notifyType: "info" },
				response(ackId, "prompt"),
				assistantEnd("review: LGTM"),
				promptResult(ackId, false),
			],
			"/review",
			{ remote: true },
		);

		expect(turn.reply).toBe("review: LGTM");
		expect(turn.requests).toBe(1);
		expect(turn.usage?.inputTokens).toBe(10);
		expect(pushEventsOf(id).length).toBeGreaterThan(0);
	});
});

/** These turns wait out omp's settle polls on purpose (about 4 s); bun's 5 s default leaves a slow CI runner no margin. */
const SETTLE_TEST_TIMEOUT_MS = 15_000;

describe("a command that keeps running after its answer", () => {
	/** `/compact`: it answers `agentInvoked:false` at once and compacts in the background, printing its result when done. */
	const compact: StateScript = n => {
		if (n <= 2) return { patch: { isCompacting: true, isSettled: false }, frames: [] };
		if (n === 3) return { patch: { isCompacting: true, isSettled: false }, frames: [{ type: "command_output", text: "Compaction complete" }] };
		return { patch: {}, frames: [] };
	};

	test("the turn waits for omp to settle and not compact, and the late output is its reply", async () => {
		const { turn, ms } = await runTurn(
			id => [{ type: "command_output", text: "Compacting context..." }, localAck(id)],
			"/compact",
			{ afterPrompt: compact },
		);

		expect(turn.state).toBe("done");
		expect(turn.reply).toBe("Compacting context...\nCompaction complete");
		expect(turn.usage).toBeNull();
		// Three readings while busy, then two quiet ones one poll apart: well under the 30 s poll.
		expect(ms).toBeGreaterThanOrEqual(3000);
		expect(ms).toBeLessThan(10_000);
	}, SETTLE_TEST_TIMEOUT_MS);

	test("a quiet reading that precedes a background task's start does not end the turn", async () => {
		// Idle once (the task has not begun yet), then busy, then idle for good.
		const late: StateScript = n => (n === 2 || n === 3 ? { patch: { isCompacting: true, isSettled: false }, frames: [] } : { patch: {}, frames: [] });
		const { turn } = await runTurn(id => [localAck(id)], "/handoff", { afterPrompt: late });

		expect(turn.state).toBe("done");
		expect(turn.reply).toBe("");
	}, SETTLE_TEST_TIMEOUT_MS);
});
