import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentSideConnection,
	ClientSideConnection,
	type AnyMessage,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionNotification,
	type SessionUpdate,
} from "@oh-my-pi/pi-utils/acp";
import { readConfig } from "../plugin/src/config";
import type { EventSource } from "../plugin/src/events";
import type { Applied } from "../plugin/src/pull";
import type { AnswerBody, LiveText, PendingQuestion, ThreadDetail, ThreadEvent, ThreadSummary, ThreadTurn } from "../plugin/src/types";
import { parseLiveText } from "../plugin/src/wire";
import { detail, event, pending, question, summary, turn, whoami } from "../plugin/test/builders";
import { until } from "../plugin/test/fakes";
import { Feed, type FeedConnection } from "../plugin/test/feed";
import { CloudAcpAgent } from "./agent";
import type { AcpClient, AcpEnvironment, LaunchRequest } from "./environment";
import { launched } from "./test-support";

const THREAD = "k3x9fa2m7q1z";
const CWD = "/work/app";
const CAPABILITIES = ["threads.meta", "threads.idempotency", "threads.paging", "events.live", "events.json", "events.text"];
/** The kind of a feed item that carries a piece of live text (its `text` is the piece as JSON). */
const LIVE_TEXT = "live_text";
type ChunkKind = "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";

/** A cloud with one thread, driven by the test: it pushes the thread's events and says what the thread looks like. */
class Cloud {
	readonly feed = new Feed();
	who = whoami({ capabilities: CAPABILITIES, defaultModel: "anthropic/claude-sonnet-5-5", models: [{ id: "anthropic/claude-sonnet-5-5" }, { id: "openai/gpt-6" }] });
	/** What `GET /threads/{id}` answers. */
	detail: ThreadDetail = detail({ id: THREAD, turns: [turn(1, { state: "running", text: "hello" })] });
	/** What `GET /threads` lists. */
	threads: ThreadSummary[] = [];
	/** The stored event log, for `session/load`. */
	stored: ThreadEvent[] = [];
	readonly launches: LaunchRequest[] = [];
	readonly pulls: { cwd: string; thread: string; apply: string }[] = [];
	readonly messages: string[] = [];
	readonly answers: { turn: number; id: number; body: AnswerBody }[] = [];
	readonly stops: string[] = [];

	readonly client: AcpClient = {
		whoami: async () => this.who,
		requireCapability: async capability => {
			if (!this.who.capabilities.includes(capability)) throw new Error(`the cloud does not support ${capability}`);
		},
		createThread: async () => {
			throw new Error("the fake environment creates threads itself");
		},
		downloadResult: async () => ({ branch: "", head: "", base: "" }),
		thread: async () => this.detail,
		listThreadsPage: async query => {
			const threads = this.threads.filter(thread => query?.ref === undefined || thread.ref === query.ref);
			return { threads, next: null, total: threads.length };
		},
		eventsPage: async (_id, query) => ({ events: this.stored.filter(stored => stored.seq > (query?.after ?? 0)), next: null }),
		sendMessage: async (_id, text) => {
			this.messages.push(text);
			const queued = turn(this.detail.turns.length + 1, { state: "queued", text });
			this.detail = { ...this.detail, turns: [...this.detail.turns, queued] };
			return { turn: queued, interrupted: false, cancelled: [] };
		},
		answer: async (_id, turnId, id, body) => {
			this.answers.push({ turn: turnId, id, body });
			this.detail = { ...this.detail, question: null };
			return question({ id });
		},
		stop: async id => {
			this.stops.push(id);
			return { stoppedRunning: true, cancelled: 0 };
		},
		events: (id, opts) => this.#stream(id, opts),
	};

	/**
	 * The feed's stream with live text in its place among the events: a `live_text` item goes to `onText` instead of being
	 * yielded, the way `CloudClient.events` calls `onText` from inside its stream.
	 */
	async *#stream(...[id, opts]: Parameters<EventSource>): AsyncGenerator<ThreadEvent> {
		for await (const item of this.feed.source(id, opts)) {
			if (item.kind !== LIVE_TEXT) {
				yield item;
				continue;
			}
			const live = parseLiveText(JSON.parse(item.text));
			if (live !== undefined) opts.onText?.(live);
		}
	}

	/** The thread as it is once turn `id` is over. */
	finish(id: number, over: Partial<ThreadTurn>): void {
		this.detail = { ...this.detail, turns: this.detail.turns.map(candidate => (candidate.id === id ? { ...candidate, state: "done", ...over } : candidate)) };
	}

	ask(over: Partial<PendingQuestion>): void {
		this.detail = { ...this.detail, question: pending(over) };
	}
}

interface Harness {
	cloud: Cloud;
	client: ClientSideConnection;
	updates: SessionUpdate[];
	permissions: RequestPermissionRequest[];
	/** What the editor answers a permission request with. */
	permit: (request: RequestPermissionRequest) => RequestPermissionResponse;
	/** Starts a session and its first prompt, and waits for the follow of the thread's first turn. */
	start(text?: string): Promise<{ sessionId: string; answer: Promise<unknown> }>;
	/** The open event stream of the thread, once the agent follows it. */
	stream(): Promise<FeedConnection>;
	/** Sends events down the thread's event stream once the agent follows it; the agent handles them in this order. */
	push(...events: ThreadEvent[]): Promise<void>;
	/** A piece of live text, in its place among the pushed events. */
	text(live: LiveText): Promise<void>;
	/** The reply text the editor got, joined as an editor joins chunks. */
	reply(): string;
	/** The text of each chunk of `kind`, in order. */
	texts(kind: ChunkKind): string[];
	of<K extends Exclude<SessionUpdate["sessionUpdate"], ChunkKind>>(kind: K): Extract<SessionUpdate, { sessionUpdate: K }>[];
}

const agents: CloudAcpAgent[] = [];

afterEach(() => {
	for (const agent of agents.splice(0)) agent.dispose();
});

async function harness(): Promise<Harness> {
	const cloud = new Cloud();
	const cfg = await readConfig({ env: {}, home: join(tmpdir(), "omp-cloud-acp-no-home"), repoRoot: undefined, platform: "linux" });
	const env: AcpEnvironment = {
		connect: async cwd => ({ client: cloud.client, cfg, root: cwd, serverHost: undefined }),
		launch: async (_cloud, request) => {
			cloud.launches.push(request);
			const response = summary({ id: THREAD, ref: request.ref, workspace: request.cwd });
			cloud.threads = [response];
			return launched({ model: request.model, thinking: request.thinking }, [], response);
		},
		pull: async (_cloud, input) => {
			cloud.pulls.push(input);
			const applied: Applied = { branch: `omp-cloud/${input.thread}`, head: "1234567890abcdef", mode: input.apply, path: input.cwd, checkedOutMoved: false, commits: 2, subjects: [], next: `git merge --ff-only omp-cloud/${input.thread}` };
			return applied;
		},
		follow: { backoffMs: () => 1 },
	};

	// Two in-memory pipes of JSON-RPC messages stand in for stdio.
	const toAgent = new TransformStream<AnyMessage, AnyMessage>();
	const toClient = new TransformStream<AnyMessage, AnyMessage>();
	new AgentSideConnection(
		peer => {
			const agent = new CloudAcpAgent(peer, env);
			agents.push(agent);
			return agent;
		},
		{ writable: toClient.writable, readable: toAgent.readable },
	);
	const updates: SessionUpdate[] = [];
	const permissions: RequestPermissionRequest[] = [];
	const h: Harness = {
		cloud,
		updates,
		permissions,
		permit: () => ({ outcome: { outcome: "cancelled" } }),
		client: new ClientSideConnection(
			() => ({
				sessionUpdate: (notification: SessionNotification) => void updates.push(notification.update),
				requestPermission: request => {
					permissions.push(request);
					return h.permit(request);
				},
			}),
			{ writable: toAgent.writable, readable: toClient.readable },
		),
		start: async (text = "hello") => {
			const { sessionId } = await h.client.newSession({ cwd: CWD, mcpServers: [] });
			// A rejection is the test's to read, not an unhandled one.
			const answer = h.client.prompt({ sessionId, prompt: [{ type: "text", text }] }).catch((error: unknown) => error);
			await h.stream();
			return { sessionId, answer };
		},
		stream: async () => {
			await until(() => cloud.feed.open(THREAD) !== undefined);
			const open = cloud.feed.open(THREAD);
			if (open === undefined) throw new Error("no open event stream");
			return open;
		},
		push: async (...events) => {
			await h.stream();
			cloud.feed.push(THREAD, ...events);
		},
		text: live => h.push(event(0, { kind: LIVE_TEXT, text: JSON.stringify(live) })),
		reply: () => h.texts("agent_message_chunk").join(""),
		texts: kind =>
			updates.flatMap(update =>
				(update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "user_message_chunk") &&
				update.sessionUpdate === kind &&
				update.content.type === "text"
					? [update.content.text]
					: [],
			),
		of: kind => updates.filter((update): update is Extract<SessionUpdate, { sessionUpdate: typeof kind }> => update.sessionUpdate === kind),
	};
	return h;
}

const prompt = (sessionId: string, text: string) => ({ sessionId, prompt: [{ type: "text" as const, text }] });

/** Each option's values, by option id. */
function choices(options: SessionConfigOption[] | null | undefined): Record<string, string[]> {
	return Object.fromEntries((options ?? []).map(option => [option.id, option.type === "select" ? option.options.map(choice => choice.value) : []]));
}

describe("a session's first prompt", () => {
	test("hands the workspace off under the session's id, shows the reply as it is written and ends with the turn", async () => {
		const h = await harness();
		const { sessionId, answer } = await h.start();
		expect(sessionId).toMatch(/^acp-[0-9a-f]{32}$/);
		expect(h.cloud.launches).toHaveLength(1);
		expect(h.cloud.launches[0]).toMatchObject({ cwd: CWD, prompt: "hello", ref: sessionId, model: "", thinking: "" });

		await h.push(event(1, { kind: "turn_queued", turn: 1 }), event(2, { kind: "turn_started", turn: 1 }));
		await h.text({ turn: 1, message: 1, offset: 0, text: "Hel" });
		await h.text({ turn: 1, message: 1, offset: 3, text: "lo" });
		h.cloud.finish(1, { reply: "Hello", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, cost: 0.25 } });
		await h.push(event(3, { kind: "assistant", turn: 1, text: "Hello" }), event(4, { kind: "usage", turn: 1, text: "{}" }), event(5, { kind: "turn_done", turn: 1 }));

		expect(await answer).toEqual({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, cachedWriteTokens: 20, totalTokens: 135 } });
		expect(h.reply()).toBe("Hello");
		// The session's own prompt is not echoed back to the editor.
		expect(h.texts("user_message_chunk")).toEqual([]);
		expect(h.of("tool_call")[0]).toMatchObject({ toolCallId: "handoff", title: `omp-cloud thread ${THREAD} started`, status: "completed" });
		// Nothing follows the thread between prompts.
		expect(h.cloud.feed.open(THREAD)).toBeUndefined();
	});

	test("a reply that did not stream is shown whole: the stored message is the event log's cut copy", async () => {
		const h = await harness();
		const { answer } = await h.start();
		await h.push(event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "assistant", turn: 1, text: "abc" }));
		h.cloud.finish(1, { reply: "abcdef" });
		await h.push(event(3, { kind: "turn_done", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
		expect(h.reply()).toBe("abcdef");
	});

	test("text the stream sends again from the start of a message is shown once", async () => {
		const h = await harness();
		const { answer } = await h.start();
		await h.push(event(1, { kind: "turn_started", turn: 1 }));
		await h.text({ turn: 1, message: 1, offset: 0, text: "Hel" });
		// A reconnected stream opens with the message so far.
		await h.text({ turn: 1, message: 1, offset: 0, text: "Hello" });
		await h.text({ turn: 1, message: 1, offset: 5, text: " there" });
		h.cloud.finish(1, { reply: "Hello there" });
		await h.push(event(2, { kind: "assistant", turn: 1, text: "Hello there" }), event(3, { kind: "turn_done", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
		expect(h.reply()).toBe("Hello there");
	});

	test("a message before a tool call and the reply after it are two messages, set apart", async () => {
		const h = await harness();
		const { answer } = await h.start();
		await h.push(
			event(1, { kind: "turn_started", turn: 1 }),
			event(2, { kind: "assistant", turn: 1, text: "Looking." }),
			event(3, { kind: "tool_start", turn: 1, text: JSON.stringify({ id: "c1", tool: "bash", intent: "run tests", args: '{"command":"bun test"}' }) }),
			event(4, { kind: "tool_end", turn: 1, text: JSON.stringify({ id: "c1", tool: "bash", ok: true, error: "" }) }),
			event(5, { kind: "assistant", turn: 1, text: "All green." }),
		);
		h.cloud.finish(1, { reply: "All green." });
		await h.push(event(6, { kind: "turn_done", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });

		expect(h.texts("agent_message_chunk")).toEqual(["Looking.", "All green."]);
		expect(h.of("tool_call").find(call => call.toolCallId === "c1")).toMatchObject({ title: "run tests", kind: "execute", status: "in_progress" });
		expect(h.of("tool_call_update")).toEqual([{ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }]);
		// In the order the thread did them.
		const order = h.updates.map(update => update.sessionUpdate).filter(kind => kind === "agent_message_chunk" || kind === "tool_call_update");
		expect(order).toEqual(["agent_message_chunk", "tool_call_update", "agent_message_chunk"]);
	});

	test("a turn that changed files names the result branch and how to get it", async () => {
		const h = await harness();
		const { answer } = await h.start();
		h.cloud.finish(1, { reply: "Done.", filesChanged: 2, insertions: 7, deletions: 1 });
		await h.push(event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "turn_done", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
		const result = h.of("tool_call").find(call => call.toolCallId === "result-1");
		expect(result).toMatchObject({ title: `omp-cloud/${THREAD}: 2 files changed, +7 -1`, status: "completed" });
		expect(JSON.stringify(result?.content)).toContain("/pull fetches");
	});
});

describe("questions", () => {
	const options = [
		{ label: "red", description: "" },
		{ label: "blue", description: "" },
	];

	test("an ask question ends the prompt, and the next prompt answers it and follows the same turn", async () => {
		const h = await harness();
		const { sessionId, answer } = await h.start();
		await h.push(event(1, { kind: "turn_started", turn: 1 }));
		h.cloud.ask({ kind: "ask", turn: 1, id: 2, text: "Which color?", options });
		await h.push(event(2, { kind: "question_asked", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
		expect(h.reply()).toContain("Which color?");
		expect(h.reply()).toContain("2. blue");
		expect(h.permissions).toEqual([]);

		const second = h.client.prompt(prompt(sessionId, "2"));
		await h.stream();
		expect(h.cloud.answers).toEqual([{ turn: 1, id: 2, body: { selected: ["blue"] } }]);
		h.cloud.finish(1, { reply: "blue it is" });
		await h.push(event(3, { kind: "question_answered", turn: 1 }), event(4, { kind: "assistant", turn: 1, text: "blue it is" }), event(5, { kind: "turn_done", turn: 1 }));
		expect(await second).toEqual({ stopReason: "end_turn" });
		expect(h.reply()).toEndWith("blue it is");
		// The answer was no message.
		expect(h.cloud.messages).toEqual([]);
		// The second stream resumed after the question.
		expect(h.cloud.feed.of(THREAD).at(-1)?.opts.after).toBe(2);
	});

	test("an approval goes to the editor's permission dialog, and its choice is the answer", async () => {
		const h = await harness();
		h.permit = () => ({ outcome: { outcome: "selected", optionId: "Approve" } });
		const { sessionId, answer } = await h.start();
		await h.push(event(1, { kind: "turn_started", turn: 1 }));
		h.cloud.ask({ kind: "approval", turn: 1, id: 4, text: "bash: rm -rf build", options: [{ label: "Approve", description: "" }, { label: "Deny", description: "" }] });
		await h.push(event(2, { kind: "question_asked", turn: 1 }));
		await until(() => h.cloud.answers.length === 1);
		expect(h.cloud.answers).toEqual([{ turn: 1, id: 4, body: { selected: ["Approve"] } }]);
		expect(h.permissions).toHaveLength(1);
		expect(h.permissions[0]).toMatchObject({ sessionId, toolCall: { toolCallId: "question-1-4", title: "bash: rm -rf build" } });
		expect(h.permissions[0]?.options).toEqual([
			{ optionId: "Approve", name: "Approve", kind: "allow_once" },
			{ optionId: "Deny", name: "Deny", kind: "reject_once" },
		]);

		h.cloud.finish(1, { reply: "removed" });
		await h.push(event(3, { kind: "turn_done", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
		expect(h.of("tool_call").find(call => call.toolCallId === "question-1-4")).toMatchObject({ status: "pending" });
		expect(h.of("tool_call_update")).toContainEqual({ sessionUpdate: "tool_call_update", toolCallId: "question-1-4", status: "completed" });
	});

	test("a dismissed push dialog answers nothing, is not opened twice, and leaves the reply before it whole", async () => {
		const h = await harness();
		const { answer } = await h.start();
		h.cloud.ask({ kind: "push", turn: 1, id: 9, text: "Push the result?", options: [{ label: "Push", description: "" }, { label: "Do not push", description: "" }] });
		// The push question comes between the turn's last message and its end; the stored message is the log's cut copy.
		await h.push(
			event(1, { kind: "turn_started", turn: 1 }),
			event(2, { kind: "assistant", turn: 1, text: "All do" }),
			event(3, { kind: "question_asked", turn: 1 }),
			event(4, { kind: "question_asked", turn: 1 }),
		);
		h.cloud.finish(1, { reply: "All done." });
		await h.push(event(5, { kind: "turn_done", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
		expect(h.reply()).toBe("All done.");
		expect(h.permissions).toHaveLength(1);
		expect(h.permissions[0]?.options.map(option => option.kind)).toEqual(["allow_once", "reject_once"]);
		expect(h.cloud.answers).toEqual([]);
		expect(h.of("tool_call_update")).toContainEqual({ sessionUpdate: "tool_call_update", toolCallId: "question-1-9", status: "failed" });
	});
});

describe("how a prompt ends", () => {
	test("session/cancel stops the thread, and the failed turn answers cancelled", async () => {
		const h = await harness();
		const { sessionId, answer } = await h.start();
		await h.push(event(1, { kind: "turn_started", turn: 1 }));
		await h.client.cancel({ sessionId });
		await until(() => h.cloud.stops.length === 1);
		expect(h.cloud.stops).toEqual([THREAD]);
		await h.push(event(2, { kind: "turn_failed", turn: 1, text: "stopped" }));
		expect(await answer).toEqual({ stopReason: "cancelled" });
	});

	test("a turn that fails by itself fails the prompt with the turn's error", async () => {
		const h = await harness();
		const { answer } = await h.start();
		await h.push(event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "turn_failed", turn: 1, text: "omp exited: out of memory" }));
		expect(await answer).toMatchObject({ code: -32603, message: "Internal error: omp exited: out of memory" });
		expect(h.cloud.stops).toEqual([]);
	});

	test("a second prompt while one runs is refused as busy, and the first goes on", async () => {
		const h = await harness();
		const { sessionId, answer } = await h.start();
		const second = await h.client.prompt(prompt(sessionId, "and another thing")).catch((error: unknown) => error);
		expect(second).toMatchObject({ code: -32003, data: { reason: "session_busy" } });
		expect(h.cloud.messages).toEqual([]);
		h.cloud.finish(1, { reply: "ok" });
		await h.push(event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "turn_done", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
	});

	test("a later prompt is a message, and a turn somebody else sent is echoed with its text", async () => {
		const h = await harness();
		const { sessionId, answer } = await h.start();
		h.cloud.finish(1, { reply: "one" });
		await h.push(event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "turn_done", turn: 1 }));
		await answer;

		// Another device queued turn 2 before this session's message became turn 3.
		h.cloud.detail = { ...h.cloud.detail, turns: [...h.cloud.detail.turns, turn(2, { state: "queued", text: "from the phone" })] };
		const second = h.client.prompt(prompt(sessionId, "next"));
		await until(() => h.cloud.messages.length === 1);
		expect(h.cloud.messages).toEqual(["next"]);
		h.cloud.finish(2, { reply: "two" });
		h.cloud.finish(3, { reply: "three" });
		await h.push(
			event(3, { kind: "turn_started", turn: 2 }),
			event(4, { kind: "turn_done", turn: 2 }),
			event(5, { kind: "turn_started", turn: 3 }),
			event(6, { kind: "turn_done", turn: 3 }),
		);
		expect(await second).toEqual({ stopReason: "end_turn" });
		expect(h.texts("user_message_chunk")).toEqual(["from the phone"]);
		expect(h.reply()).toBe("onetwothree");
		expect(h.cloud.feed.of(THREAD).at(-1)?.opts.after).toBe(2);
	});
});

describe("the session's options", () => {
	test("the model chosen before the first prompt is the handoff's, and nothing can be chosen after it", async () => {
		const h = await harness();
		const created = await h.client.newSession({ cwd: CWD, mcpServers: [] });
		expect(choices(created.configOptions)).toEqual({
			model: ["", "anthropic/claude-sonnet-5-5", "openai/gpt-6"],
			thinking: ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
		});
		const refused = await h.client.setSessionConfigOption({ sessionId: created.sessionId, configId: "model", value: "openai/nope" }).catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: -32602 });
		const set = await h.client.setSessionConfigOption({ sessionId: created.sessionId, configId: "model", value: "openai/gpt-6" });
		expect(set.configOptions.find(option => option.id === "model")?.currentValue).toBe("openai/gpt-6");
		await h.client.setSessionConfigOption({ sessionId: created.sessionId, configId: "thinking", value: "high" });

		const answer = h.client.prompt(prompt(created.sessionId, "go"));
		await h.stream();
		expect(h.cloud.launches[0]).toMatchObject({ model: "openai/gpt-6", thinking: "high" });
		expect(choices(h.of("config_option_update").at(-1)?.configOptions)).toEqual({ model: ["openai/gpt-6"], thinking: ["high"] });

		const late = await h.client.setSessionConfigOption({ sessionId: created.sessionId, configId: "model", value: "openai/gpt-6" }).catch((error: unknown) => error);
		expect(late).toMatchObject({ code: -32602, message: "Invalid params: the cloud agent's model and thinking level are fixed once it has started" });

		h.cloud.finish(1, { reply: "ok" });
		await h.push(event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "turn_done", turn: 1 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
	});

	test("a cloud that lacks a needed capability is refused when the session is made", async () => {
		const h = await harness();
		h.cloud.who = whoami({ capabilities: ["threads.meta"] });
		const refused = await h.client.newSession({ cwd: CWD, mcpServers: [] }).catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: -32603, message: expect.stringContaining("threads.idempotency") });
		expect(await h.client.newSession({ cwd: "relative/dir", mcpServers: [] }).catch((error: unknown) => error)).toMatchObject({ code: -32602 });
	});
});

describe("loading and listing", () => {
	test("session/load replays a thread: each turn's prompt, its reply whole, and options that are fixed", async () => {
		const h = await harness();
		h.cloud.detail = detail({ id: THREAD, model: "openai/gpt-6", thinking: "low", turns: [turn(1, { text: "do it", reply: "Done, and more than the log holds." })] });
		h.cloud.stored = [
			event(1, { kind: "turn_queued", turn: 1 }),
			event(2, { kind: "turn_started", turn: 1 }),
			event(3, { kind: "assistant", turn: 1, text: "Done, and more" }),
			event(4, { kind: "question_asked", turn: 1 }),
			event(5, { kind: "turn_done", turn: 1 }),
		];
		const loaded = await h.client.loadSession({ sessionId: THREAD, cwd: CWD, mcpServers: [] });
		expect(choices(loaded.configOptions)).toEqual({ model: ["openai/gpt-6"], thinking: ["low"] });
		expect(h.texts("user_message_chunk")).toEqual(["do it"]);
		expect(h.reply()).toBe("Done, and more than the log holds.");
		expect(h.permissions).toEqual([]);

		// The next prompt is a message, followed from the end of what was replayed.
		const answer = h.client.prompt(prompt(THREAD, "again"));
		await h.stream();
		expect(h.cloud.messages).toEqual(["again"]);
		expect(h.cloud.feed.open(THREAD)?.opts.after).toBe(5);
		h.cloud.finish(2, { reply: "ok" });
		await h.push(event(6, { kind: "turn_started", turn: 2 }), event(7, { kind: "turn_done", turn: 2 }));
		expect(await answer).toEqual({ stopReason: "end_turn" });
	});

	test("a session id of this agent loads the thread it made; an id that names nothing is not found", async () => {
		const h = await harness();
		const ref = `acp-${"0af1".repeat(8)}`;
		h.cloud.threads = [summary({ id: THREAD, ref })];
		h.cloud.detail = detail({ id: THREAD, ref, turns: [turn(1, { text: "do it", reply: "Done." })] });
		h.cloud.stored = [event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "turn_done", turn: 1 })];
		await h.client.loadSession({ sessionId: ref, cwd: CWD, mcpServers: [] });
		expect(h.reply()).toBe("Done.");

		const unknown = `acp-${"f".repeat(32)}`;
		expect(await h.client.loadSession({ sessionId: unknown, cwd: CWD, mcpServers: [] }).catch((error: unknown) => error)).toMatchObject({ code: -32002 });
		expect(await h.client.loadSession({ sessionId: "not an id", cwd: CWD, mcpServers: [] }).catch((error: unknown) => error)).toMatchObject({ code: -32002 });
		expect(await h.client.prompt(prompt(unknown, "hi")).catch((error: unknown) => error)).toMatchObject({ code: -32002 });
	});

	test("session/list with a cwd lists that workspace's threads: under the session id that made them, else under the thread id", async () => {
		const h = await harness();
		const ref = `acp-${"0af1".repeat(8)}`;
		h.cloud.threads = [
			summary({ id: "aaaaaaaaaaaa", ref, workspace: CWD, name: "Fix login", lastActivityAt: "2026-02-02T00:00:00Z" }),
			summary({ id: "bbbbbbbbbbbb", workspace: CWD, title: "from omp" }),
			summary({ id: "cccccccccccc", workspace: "/work/other" }),
		];
		const here = await h.client.listSessions({ cwd: CWD });
		expect(here.sessions).toEqual([
			{ sessionId: ref, cwd: CWD, title: "Fix login", updatedAt: "2026-02-02T00:00:00Z" },
			{ sessionId: "bbbbbbbbbbbb", cwd: CWD, title: "from omp", updatedAt: "2026-01-01T00:01:00Z" },
		]);
		expect(here.nextCursor).toBeNull();
		expect((await h.client.listSessions({})).sessions.map(session => session.sessionId)).toEqual([ref, "bbbbbbbbbbbb", "cccccccccccc"]);
	});
});

describe("the agent's commands", () => {
	test("/pull fetches the result and /pull merge fast-forwards; neither is a message", async () => {
		const h = await harness();
		const { sessionId, answer } = await h.start();
		h.cloud.finish(1, { reply: "ok" });
		await h.push(event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "turn_done", turn: 1 }));
		await answer;

		expect(await h.client.prompt(prompt(sessionId, "/pull"))).toEqual({ stopReason: "end_turn" });
		expect(await h.client.prompt(prompt(sessionId, "/pull merge"))).toEqual({ stopReason: "end_turn" });
		expect(await h.client.prompt(prompt(sessionId, "/pull now"))).toEqual({ stopReason: "end_turn" });
		expect(h.cloud.pulls).toEqual([
			{ cwd: CWD, thread: THREAD, apply: "fetch" },
			{ cwd: CWD, thread: THREAD, apply: "merge" },
		]);
		expect(h.cloud.messages).toEqual([]);
		expect(h.reply()).toContain(`omp-cloud/${THREAD} is at 12345678, 2 commits: git merge --ff-only omp-cloud/${THREAD}`);
		expect(h.reply()).toEndWith("usage: /pull [merge]");
	});

	test("without a thread a command says so; /follow shows the running turn, or that there is none", async () => {
		const h = await harness();
		const { sessionId } = await h.client.newSession({ cwd: CWD, mcpServers: [] });
		expect(await h.client.prompt(prompt(sessionId, "/pull"))).toEqual({ stopReason: "end_turn" });
		expect(h.reply()).toBe("This session has no cloud thread yet: send a prompt to start one.");
		expect(h.cloud.launches).toEqual([]);
		await until(() => h.of("available_commands_update").length === 1);
		expect(h.of("available_commands_update")[0]?.availableCommands.map(available => available.name)).toEqual(["pull", "follow"]);

		const first = h.client.prompt(prompt(sessionId, "hello"));
		h.cloud.finish(1, { reply: "ok" });
		await h.push(event(1, { kind: "turn_started", turn: 1 }), event(2, { kind: "turn_done", turn: 1 }));
		await first;
		expect(await h.client.prompt(prompt(sessionId, "/follow"))).toEqual({ stopReason: "end_turn" });
		expect(h.reply()).toEndWith("No turn is running.");

		h.cloud.detail = { ...h.cloud.detail, turns: [...h.cloud.detail.turns, turn(2, { state: "running", text: "from the phone" })] };
		const following = h.client.prompt(prompt(sessionId, "/follow"));
		await h.stream();
		h.cloud.finish(2, { reply: "phone done" });
		await h.push(event(3, { kind: "turn_started", turn: 2 }), event(4, { kind: "turn_done", turn: 2 }));
		expect(await following).toEqual({ stopReason: "end_turn" });
		expect(h.reply()).toEndWith("phone done");
	});
});

describe("initialize", () => {
	test("names the agent and what it can do, without reading any configuration", async () => {
		const h = await harness();
		const hello = await h.client.initialize({ protocolVersion: 1 });
		expect(hello).toMatchObject({
			protocolVersion: 1,
			agentInfo: { name: "omp-cloud" },
			authMethods: [{ id: "omp-cloud" }],
			agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } },
		});
	});
});
