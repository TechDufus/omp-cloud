import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushInput as GitPushInput, PushOutcome } from "../git";
import { Settings } from "../settings";
import { Store } from "../store";
import type { NewThread, Question, Thread, Turn, TurnResult } from "../store/types";
import {
	DECLINE_LABEL,
	NOT_PUSHED,
	PUSH_LABEL,
	PUSH_QUESTION_KEY,
	pushAnswer,
	pushEligible,
	pushExpiredAnswer,
	pushQuestion,
	PushStep,
	pushTarget,
	type PushFacts,
	type PushRecord,
} from "./push";

const ID = "aaaaaaaaaaaa";
const REMOTE = "https://git.example.test/acme/app.git";
const HEAD = "1111111111111111111111111111111111111111";
const HANDOFF = "2222222222222222222222222222222222222222";

const facts = (over: Partial<PushFacts> = {}): PushFacts => ({
	mode: "auto",
	outcome: "completed",
	stopped: false,
	head: HEAD,
	handoffCommit: HANDOFF,
	pushedHead: "",
	remoteURL: REMOTE,
	...over,
});

describe("pushEligible", () => {
	test("a finished, unstopped turn with a new head on a thread with a remote, under ask or auto", () => {
		expect(pushEligible(facts())).toBe(true);
		expect(pushEligible(facts({ mode: "ask" }))).toBe(true);
	});

	test.each<[string, Partial<PushFacts>]>([
		["the mode is never", { mode: "never" }],
		["the turn failed", { outcome: "failed" }],
		["the turn was stopped", { stopped: true }],
		["there is no head", { head: "" }],
		["the head is the handoff commit", { head: HANDOFF }],
		["the head is the one already pushed", { pushedHead: HEAD }],
		["the thread has no remote", { remoteURL: "" }],
	])("not when %s", (_label, over) => {
		expect(pushEligible(facts(over))).toBe(false);
	});

	test("an older pushed head does not stop a newer one", () => {
		expect(pushEligible(facts({ pushedHead: "3333333333333333333333333333333333333333" }))).toBe(true);
	});
});

describe("pushTarget", () => {
	test("{thread} becomes the thread id, wherever it stands", () => {
		expect(pushTarget("omp-cloud/{thread}", ID)).toBe(`omp-cloud/${ID}`);
		expect(pushTarget("bots/{thread}-x/{thread}", ID)).toBe(`bots/${ID}-x/${ID}`);
	});
});

describe("pushQuestion", () => {
	test("is the service's Push question with its two options", () => {
		expect(pushQuestion({ target: "omp-cloud/x", remote: REMOTE, head: HEAD })).toEqual({
			key: PUSH_QUESTION_KEY,
			text: `Push omp-cloud/x to ${REMOTE}?`,
			header: "Push",
			options: [
				{ label: "Push", description: `push 11111111 to ${REMOTE} as omp-cloud/x` },
				{ label: "Do not push", description: "keep the result on the service" },
			],
			multi: false,
			recommended: 0,
			ompKey: "omp-cloud:push",
			ompLabels: ["Push", "Do not push"],
		});
	});

	test("a very long remote is cut to the store's limits", () => {
		const question = pushQuestion({ target: "t", remote: `https://x.example/${"a".repeat(5000)}`, head: HEAD });
		expect(Buffer.byteLength(question.text)).toBeLessThanOrEqual(4000);
		expect(Buffer.byteLength(question.options[0]?.description ?? "")).toBeLessThanOrEqual(500);
	});
});

describe("pushAnswer", () => {
	const question = (over: Partial<Question>): Question => ({
		id: 1,
		ask: 1,
		key: PUSH_QUESTION_KEY,
		text: "Push?",
		header: "Push",
		options: [],
		multi: false,
		recommended: 0,
		askedAt: "",
		selected: [],
		answer: "",
		answeredBy: "",
		answeredAt: null,
		expired: false,
		requestId: null,
		ompKey: PUSH_QUESTION_KEY,
		ompLabels: [],
		...over,
	});
	const answered = { answeredAt: "2026-01-01T00:00:00.000Z", answeredBy: "owner" };

	test("is null while nobody answered", () => {
		expect(pushAnswer(question({}))).toBeNull();
	});

	test("exactly [Push] pushes", () => {
		expect(pushAnswer(question({ ...answered, selected: [PUSH_LABEL] }))).toEqual({ kind: "push" });
		expect(pushAnswer(question({ ...answered, selected: [PUSH_LABEL], answer: "yes please" }))).toEqual({ kind: "push" });
	});

	test("anything else is a decline by the answerer", () => {
		expect(pushAnswer(question({ ...answered, selected: [DECLINE_LABEL] }))).toEqual({ kind: "declined", by: "owner" });
		expect(pushAnswer(question({ ...answered, selected: [], answer: "later" }))).toEqual({ kind: "declined", by: "owner" });
		expect(pushAnswer(question({ ...answered, selected: [PUSH_LABEL, DECLINE_LABEL] }))).toEqual({ kind: "declined", by: "owner" });
	});

	test("a timeout is an expiry, a stop is a stop", () => {
		expect(pushAnswer(question({ ...answered, answeredBy: "timeout", expired: true, selected: [] }))).toEqual({ kind: "expired" });
		expect(pushAnswer(question({ ...answered, answeredBy: "stop", expired: true, selected: [] }))).toEqual({ kind: "stopped" });
	});

	test("the expiry note says the result was not pushed", () => {
		expect(pushExpiredAnswer(1800)).toContain("not pushed");
	});
});

describe("PushStep", () => {
	let dir: string;
	let store: Store;
	let settings: Settings;
	let thread: Thread;
	let turn: Turn;
	let pushes: GitPushInput[];
	let refusal: string | null;
	let outcome: PushOutcome;
	let events: string[];
	let clockCalls: string[];
	/** Called when the step pauses the clock, i.e. once its question is open. */
	let onPause: () => void = () => {};
	let unsubscribe: () => void;
	let step: PushStep;

	const newThread = (): NewThread => ({
		owner: "owner",
		title: "t",
		prompt: "p",
		model: "",
		thinking: "",
		repo: { name: "app", remoteURL: REMOTE, baseRef: "main", baseCommit: "", handoffCommit: HANDOFF, localBranch: "main" },
		paths: { home: "", workspace: "" },
		author: { name: "Me", email: "me@example.com" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
	});

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "omp-cloud-push-"));
		store = Store.open({ dataDir: dir });
		settings = Settings.load(store);
		store.createThread(ID, newThread());
		await store.putBlob(ID, "result.bundle", new TextEncoder().encode("bundle"), 100);
		const started = store.startNextTurn(ID);
		const found = store.getThread(ID);
		if (started === null || found === null) throw new Error("no thread");
		turn = started;
		thread = found;
		pushes = [];
		refusal = null;
		outcome = { pushed: true, error: "" };
		events = [];
		clockCalls = [];
		step = makeStep(1800);
		// The runner calls `recheck` on every answer and expiry of the thread.
		unsubscribe = store.subscribe(ID, {
			event: e => {
				if (e.kind === "question_answered" || e.kind === "question_expired") step.recheck();
			},
			deleted: () => {},
		});
	});

	afterEach(async () => {
		unsubscribe();
		store.close();
		await rm(dir, { recursive: true, force: true });
	});

	function makeStep(questionTimeoutSeconds: number): PushStep {
		return new PushStep(
			{
				store,
				git: {
					normalize: url => url,
					pushRefusal: () => refusal,
					push: async (_id: string, input: GitPushInput) => {
						pushes.push(input);
						return outcome;
					},
				},
				settings,
				questionTimeoutSeconds,
				clock: {
					pause: () => {
						clockCalls.push("pause");
						onPause();
					},
					resume: () => clockCalls.push("resume"),
				},
				event: text => events.push(text),
			},
			thread,
			turn,
		);
	}

	const run = (over: Partial<{ outcome: "completed" | "failed"; stopped: boolean; head: string }> = {}) =>
		step.run({ outcome: "completed", stopped: false, head: HEAD, ...over });

	/** The service's push question: a model `ask` may reuse the key, but only the service posts one without omp's request id. */
	const pushQuestionOf = (): Question | undefined => store.turns(ID)[0]?.questions.find(q => q.key === PUSH_QUESTION_KEY && q.requestId === null);

	const pushed: PushRecord = { pushed: true, pushError: "", pushRef: `omp-cloud/${ID}` };

	test("never: nothing happens and no event is written", async () => {
		expect(await run()).toEqual(NOT_PUSHED);
		expect(pushes).toEqual([]);
		expect(events).toEqual([]);
	});

	test("a turn that is no longer running (a lost VM requeued it) posts nothing and pushes nothing", async () => {
		settings.apply({ "git.push": "auto" }, "owner");
		store.requeueRunningTurn(ID);
		expect(await run()).toEqual(NOT_PUSHED);
		settings.apply({ "git.push": "ask" }, "owner");
		expect(await run()).toEqual(NOT_PUSHED);
		expect(pushes).toEqual([]);
		expect(events).toEqual([]);
		expect(store.turns(ID)[0]?.questions).toEqual([]);
	});

	test("an ineligible turn under auto is left alone", async () => {
		settings.apply({ "git.push": "auto" }, "owner");
		expect(await run({ outcome: "failed" })).toEqual(NOT_PUSHED);
		expect(await run({ stopped: true })).toEqual(NOT_PUSHED);
		expect(await run({ head: HANDOFF })).toEqual(NOT_PUSHED);
		expect(await run({ head: "" })).toEqual(NOT_PUSHED);
		expect(pushes).toEqual([]);
		expect(events).toEqual([]);
	});

	test("auto pushes at once, to the target built from git.branch, and reports it", async () => {
		settings.apply({ "git.push": "auto", "git.branch": "bots/{thread}", "git.protected": ["main"] }, "owner");
		expect(await run()).toEqual({ pushed: true, pushError: "", pushRef: `bots/${ID}` });
		expect(pushes).toEqual([
			{
				remoteURL: REMOTE,
				bundlePath: store.blobPath(ID, "result.bundle"),
				localBranch: `omp-cloud/${ID}`,
				head: HEAD,
				target: `bots/${ID}`,
				protectedPatterns: ["main"],
			},
		]);
		expect(events).toEqual([`pushed bots/${ID} to ${REMOTE}`]);
		expect(pushQuestionOf()).toBeUndefined();
	});

	test("a push the service refuses is recorded with its reason and never asks", async () => {
		settings.apply({ "git.push": "ask" }, "owner");
		refusal = "the service has no git credentials for git.example.test";
		expect(await run()).toEqual({ pushed: false, pushError: refusal, pushRef: "" });
		expect(events).toEqual([`push failed: ${refusal}`]);
		expect(pushes).toEqual([]);
		expect(pushQuestionOf()).toBeUndefined();
	});

	test("a failed push keeps git's reason and no ref", async () => {
		settings.apply({ "git.push": "auto" }, "owner");
		outcome = { pushed: false, error: `omp-cloud/${ID} on ${REMOTE} has commits the result lacks; not force-pushing` };
		expect(await run()).toEqual({ pushed: false, pushError: outcome.error, pushRef: "" });
		expect(events).toEqual([`push failed: ${outcome.error}`]);
	});

	test("a missing result bundle is an error, not a crash", async () => {
		settings.apply({ "git.push": "auto" }, "owner");
		await store.removeBlobs(ID);
		expect(await run()).toEqual({ pushed: false, pushError: "the result bundle is not stored", pushRef: "" });
		expect(pushes).toEqual([]);
	});

	test("a head that an earlier turn pushed is not pushed again", async () => {
		settings.apply({ "git.push": "auto" }, "owner");
		const done: TurnResult = { outcome: "completed", error: "", reply: "ok", usage: null, head: HEAD, filesChanged: 1, insertions: 1, deletions: 0, pushed: true, pushError: "", pushRef: `omp-cloud/${ID}` };
		store.completeTurn(ID, turn.id, done);
		store.enqueueTurn(ID, "again", "owner");
		const second = store.startNextTurn(ID);
		if (second === null) throw new Error("no second turn");
		turn = second;
		step = makeStep(1800);
		expect(await run()).toEqual(NOT_PUSHED);
		expect(pushes).toEqual([]);
		expect(await run({ head: "4444444444444444444444444444444444444444" })).toMatchObject({ pushed: true });
	});

	describe("ask", () => {
		beforeEach(() => {
			settings.apply({ "git.push": "ask" }, "owner");
		});

		/** Starts the step and returns once its question is open (the clock paused). */
		async function startAsking(): Promise<{ running: Promise<PushRecord | null>; question: Question }> {
			const paused = new Promise<void>(resolve => {
				onPause = resolve;
			});
			const running = run();
			await paused;
			const question = pushQuestionOf();
			if (question === undefined) throw new Error("no push question was posted");
			return { running, question };
		}

		test("posts the service's question on the running turn, pauses the clock, and pushes on Push", async () => {
			const { running, question } = await startAsking();
			expect(question).toMatchObject({
				key: "omp-cloud:push",
				header: "Push",
				text: `Push omp-cloud/${ID} to ${REMOTE}?`,
				multi: false,
				recommended: 0,
				requestId: null,
				ompKey: "omp-cloud:push",
				ompLabels: ["Push", "Do not push"],
				options: [
					{ label: "Push", description: `push 11111111 to ${REMOTE} as omp-cloud/${ID}` },
					{ label: "Do not push", description: "keep the result on the service" },
				],
			});
			expect(store.getThread(ID)?.phase).toBe("waiting");
			expect(clockCalls).toEqual(["pause"]);
			expect(pushes).toEqual([]);

			store.answerQuestion(ID, turn.id, question.id, ["Push"], "", "owner");
			expect(await running).toEqual(pushed);
			expect(clockCalls).toEqual(["pause", "resume"]);
			expect(pushes).toHaveLength(1);
			expect(events).toEqual([`pushed omp-cloud/${ID} to ${REMOTE}`]);
		});

		test("Do not push records nothing but the decliner", async () => {
			const { running, question } = await startAsking();
			store.answerQuestion(ID, turn.id, question.id, ["Do not push"], "", "owner");
			expect(await running).toEqual(NOT_PUSHED);
			expect(pushes).toEqual([]);
			expect(events).toEqual(["push declined by owner"]);
			expect(clockCalls).toEqual(["pause", "resume"]);
		});

		test("free text without the Push label declines", async () => {
			const { running, question } = await startAsking();
			store.answerQuestion(ID, turn.id, question.id, [], "not now", "owner");
			expect(await running).toEqual(NOT_PUSHED);
			expect(events).toEqual(["push declined by owner"]);
		});

		test("an unanswered question expires after the timeout and the result is not pushed", async () => {
			// The step arms its own timeout: a 50 ms real timer is the behaviour under test.
			step = makeStep(0.05);
			expect(await run()).toEqual(NOT_PUSHED);
			expect(pushQuestionOf()).toMatchObject({ answeredBy: "timeout", expired: true });
			expect(events).toEqual(["push question expired"]);
			expect(pushes).toEqual([]);
			expect(clockCalls).toEqual(["pause", "resume"]);
		});

		test("a stop while the question is open ends the wait without a push or an event", async () => {
			const { running } = await startAsking();
			store.stopThread(ID, "owner");
			expect(await running).toEqual(NOT_PUSHED);
			expect(pushQuestionOf()).toMatchObject({ answeredBy: "stop", expired: true });
			expect(pushes).toEqual([]);
			expect(events).toEqual([]);
		});

		test("a stop that landed before the question is posted ends the step too", async () => {
			store.stopThread(ID, "owner");
			expect(await run()).toEqual(NOT_PUSHED);
			expect(pushQuestionOf()).toBeUndefined();
			expect(pushes).toEqual([]);
		});

		test("cancel (the runner goes away) leaves the question open and the turn undecided", async () => {
			const { running } = await startAsking();
			step.cancel();
			expect(await running).toBeNull();
			expect(pushQuestionOf()?.answeredAt).toBeNull();
			expect(clockCalls).toEqual(["pause", "resume"]);
			expect(pushes).toEqual([]);
		});

		test("a redelivered turn reuses the open question instead of asking again", async () => {
			const { running: first, question } = await startAsking();
			step.cancel();
			expect(await first).toBeNull();

			step = makeStep(1800);
			const { running: second } = await startAsking();
			expect(store.turns(ID)[0]?.questions.filter(q => q.key === PUSH_QUESTION_KEY)).toHaveLength(1);
			store.answerQuestion(ID, turn.id, question.id, ["Push"], "", "owner");
			expect(await second).toEqual(pushed);
			expect(store.turns(ID)[0]?.questions.filter(q => q.key === PUSH_QUESTION_KEY)).toHaveLength(1);
		});

		test("a model ask with the push key never stands in for the service's question", async () => {
			// The agent asks with the reserved id (it carries omp's request id) and the owner answers Push.
			store.askQuestions(ID, turn.id, [pushQuestion({ target: "x", remote: REMOTE, head: HEAD })], "req-forged");
			const forged = store.turns(ID)[0]?.questions[0];
			if (forged === undefined) throw new Error("no forged question");
			store.answerQuestion(ID, turn.id, forged.id, ["Push"], "", "owner");

			const { running, question } = await startAsking();
			expect(question.id).not.toBe(forged.id);
			expect(question.requestId).toBeNull();
			expect(pushes).toEqual([]);
			// Answering the forged question again is impossible; answering the real one pushes.
			store.answerQuestion(ID, turn.id, question.id, ["Push"], "", "owner");
			expect(await running).toEqual(pushed);
			expect(pushes).toHaveLength(1);
		});

		test("a declined or expired model ask with the push key does not suppress the real question", async () => {
			store.askQuestions(ID, turn.id, [pushQuestion({ target: "x", remote: REMOTE, head: HEAD })], "req-forged");
			store.expireAsk(ID, turn.id, 1, "gone", "timeout");
			const { running, question } = await startAsking();
			expect(question.requestId).toBeNull();
			store.answerQuestion(ID, turn.id, question.id, ["Push"], "", "owner");
			expect(await running).toEqual(pushed);
		});

		test("a redelivered turn whose question was answered meanwhile acts on that answer without waiting", async () => {
			const { running: first, question } = await startAsking();
			step.cancel();
			expect(await first).toBeNull();
			store.answerQuestion(ID, turn.id, question.id, ["Push"], "", "owner");

			step = makeStep(1800);
			expect(await run()).toEqual(pushed);
			expect(clockCalls).toEqual(["pause", "resume"]);
			expect(pushes).toHaveLength(1);
		});
	});
});
