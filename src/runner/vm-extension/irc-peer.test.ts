import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import ircPeer, { installIrcPeer, IRC_COMMAND, IRC_FRAME_KIND, IRC_STATUS_KEY, type IrcMessage, type RegistryLike } from "./irc-peer";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

interface UiCalls {
	status: Array<{ key: string; text: string | undefined }>;
	notices: Array<{ message: string; type: string | undefined }>;
}

interface FakeSession {
	delivered: IrcMessage[];
	readonly isStreaming: boolean;
	/** How many times `isStreaming` was read after a wake. */
	readonly wakeReads: number;
	deliverIrcMessage(message: IrcMessage): Promise<string>;
}

interface Setup {
	registry: RegistryLike;
	/** The records `registry.register` was called with, in order. */
	registered: Array<Record<string, unknown>>;
	logs: string[];
	ui: UiCalls;
	session: FakeSession;
	pi: ExtensionAPI;
	handlers: Handler[];
	command: () => { description: string | undefined; handler: CommandHandler };
	ctx: (kind?: string) => { agent: { kind: string; id: string }; ui: { setStatus: (key: string, text: string | undefined) => void; notify: (message: string, type?: string) => void } };
	start: (kind?: string) => void;
	run: (args: string) => Promise<void>;
	/** The shim session registered for `id`. */
	peer: (id: string) => Record<string, unknown>;
}

interface Options {
	config?: unknown;
	readConfig?: () => unknown;
	agentId?: string;
	/** What the root session's `deliverIrcMessage` returns. */
	outcome?: string;
	/** After a `woken` outcome, the read of `isStreaming` that first answers true; undefined = never. */
	streamsAtRead?: number;
	deliver?: (message: IrcMessage) => Promise<string>;
	/** Leave the root session out of the registry. */
	noRoot?: boolean;
	/** The root session without `deliverIrcMessage`. */
	noDeliver?: boolean;
}

const AGENT_ID = "Main";

function setup(options: Options = {}): Setup {
	const agentId = options.agentId ?? AGENT_ID;
	const entries = new Map<string, { session?: unknown }>();
	const registered: Array<Record<string, unknown>> = [];
	const registry: RegistryLike = {
		get: id => entries.get(id),
		register: input => {
			registered.push(input);
			const id = input.id;
			if (typeof id !== "string") throw new Error("register without an id");
			entries.set(id, { session: input.session });
			return undefined;
		},
	};

	let woken = false;
	let wakeReads = 0;
	const session: FakeSession = {
		delivered: [],
		get isStreaming() {
			if (!woken || options.streamsAtRead === undefined) return false;
			wakeReads++;
			return wakeReads >= options.streamsAtRead;
		},
		get wakeReads() {
			return wakeReads;
		},
		async deliverIrcMessage(message) {
			session.delivered.push(message);
			if (options.deliver !== undefined) return options.deliver(message);
			const outcome = options.outcome ?? "injected";
			if (outcome === "woken") woken = true;
			return outcome;
		},
	};
	if (!options.noRoot) entries.set(agentId, { session: options.noDeliver ? {} : session });

	const handlers: Handler[] = [];
	let command: { description: string | undefined; handler: CommandHandler } | undefined;
	const pi = {
		on: (event: string, handler: Handler) => {
			if (event === "session_start") handlers.push(handler);
		},
		registerCommand: (name: string, definition: { description?: string; handler: CommandHandler }) => {
			expect(name).toBe(IRC_COMMAND);
			command = { description: definition.description, handler: definition.handler };
		},
	} as unknown as ExtensionAPI;

	const logs: string[] = [];
	const ui: UiCalls = { status: [], notices: [] };
	installIrcPeer(pi, {
		registry,
		readConfig: options.readConfig ?? (() => options.config),
		log: line => logs.push(line),
	});

	const ctx = (kind = "main") => ({
		agent: { kind, id: agentId },
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				ui.status.push({ key, text });
			},
			notify: (message: string, type?: string) => {
				ui.notices.push({ message, type });
			},
		},
	});
	const commandOf = (): { description: string | undefined; handler: CommandHandler } => {
		if (command === undefined) throw new Error("no command registered");
		return command;
	};
	const shared = ctx();
	return {
		registry,
		registered,
		logs,
		ui,
		session,
		pi,
		handlers,
		command: commandOf,
		ctx,
		start: kind => {
			const context = kind === undefined ? shared : ctx(kind);
			for (const handler of handlers) handler({ type: "session_start" }, context);
		},
		run: args => commandOf().handler(args, shared),
		peer: id => {
			const session = entries.get(id)?.session;
			if (typeof session !== "object" || session === null) throw new Error(`no peer ${id}`);
			return Object.fromEntries(Object.entries(session));
		},
	};
}

function frame(id: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ id, from: "alice", body: "hello", ...extra });
}

function deliverer(shim: Record<string, unknown>): (message: IrcMessage) => Promise<unknown> {
	const deliver = shim.deliverIrcMessage;
	if (typeof deliver !== "function") throw new Error("no deliverIrcMessage");
	return async message => Reflect.apply(deliver, shim, [message]);
}

const MESSAGE: IrcMessage = { id: "m1", from: "Main", to: "Parent", body: "a question", replyTo: "r9", ts: 1 };

describe("registration", () => {
	test("session_start of the main agent registers the parent as an idle peer from the config", () => {
		const s = setup({ config: { thread: "t", parent: { id: "Boss", displayName: "The boss", description: "who started this" } } });
		s.start();
		expect(s.registered).toHaveLength(1);
		const record = s.registered[0];
		expect(record?.id).toBe("Boss");
		expect(record?.displayName).toBe("The boss");
		expect(record?.activity).toBe("who started this");
		expect(record?.kind).toBe("sub");
		expect(record?.status).toBe("idle");
		expect(typeof record?.session).toBe("object");
	});

	test("a sub agent's session_start registers nothing", () => {
		const s = setup({ config: { parent: { id: "Boss" } } });
		s.start("sub");
		expect(s.registered).toEqual([]);
		expect(s.logs).toEqual([]);
	});

	test("the command is registered with a description even before any session starts", () => {
		const s = setup();
		expect(s.command().description).toBeTruthy();
	});

	test.each([
		["no config", undefined],
		["a config that is not an object", "junk"],
		["a config without a parent", { thread: "t" }],
		["a parent that is not an object", { parent: 5 }],
		["a parent id that is not an id", { parent: { id: "1 bad id" } }],
		["parent fields of the wrong type", { parent: { id: 7, displayName: 8, description: 9 } }],
	])("defaults for %s", (_name, config) => {
		const s = setup({ config });
		s.start();
		expect(s.registered).toHaveLength(1);
		const record = s.registered[0];
		expect(record?.id).toBe("Parent");
		expect(record?.displayName).toBe("Parent");
		expect(typeof record?.activity).toBe("string");
		expect(String(record?.activity).length).toBeGreaterThan(0);
	});

	test("a parent id equal to the VM agent's own id becomes Parent", () => {
		const s = setup({ config: { parent: { id: "Main", displayName: "Me" } } });
		s.start();
		expect(s.registered.map(r => r.id)).toEqual(["Parent"]);
		expect(s.registered[0]?.displayName).toBe("Me");
	});

	test("running session_start twice registers the parent once", () => {
		const s = setup({ config: { parent: { id: "Boss" } } });
		s.start();
		s.start();
		expect(s.registered).toHaveLength(1);
	});

	test("a config reader that throws logs once and registers nothing", () => {
		const s = setup({
			readConfig: () => {
				throw new Error("disk gone");
			},
		});
		s.start();
		s.start();
		expect(s.registered).toEqual([]);
		expect(s.logs).toHaveLength(1);
		expect(s.logs[0]).toContain("disk gone");
	});
});

describe("the parent's session shim", () => {
	test("deliverIrcMessage emits a setStatus frame with the exact fields and answers injected", async () => {
		const s = setup();
		s.start();
		const result = await deliverer(s.peer("Parent"))(MESSAGE);
		expect(result).toBe("injected");
		expect(s.ui.status).toHaveLength(1);
		expect(s.ui.status[0]?.key).toBe(IRC_STATUS_KEY);
		const text = s.ui.status[0]?.text;
		expect(typeof text).toBe("string");
		expect(JSON.parse(text ?? "")).toEqual({ kind: IRC_FRAME_KIND, id: "m1", from: "Main", to: "Parent", body: "a question", replyTo: "r9" });
	});

	test("an absent replyTo travels as an empty string", async () => {
		const s = setup();
		s.start();
		const { replyTo: _replyTo, ...withoutReply } = MESSAGE;
		await deliverer(s.peer("Parent"))(withoutReply);
		expect(JSON.parse(s.ui.status[0]?.text ?? "").replyTo).toBe("");
	});

	test("deliverIrcMessage throws when no ui is known", async () => {
		const s = setup();
		const bare = { agent: { kind: "main", id: AGENT_ID } };
		for (const handler of s.handlers) handler({ type: "session_start" }, bare);
		await expect(deliverer(s.peer("Parent"))(MESSAGE)).rejects.toThrow();
		expect(s.ui.status).toEqual([]);
	});

	test("the other members of the shim never throw", async () => {
		const s = setup();
		s.start();
		const shim = s.peer("Parent");
		const call = (name: string, ...args: unknown[]): unknown => {
			const member = shim[name];
			if (typeof member !== "function") throw new Error(`${name} is not a function`);
			return Reflect.apply(member, shim, args);
		};
		expect(call("drainPendingIrcInboxMessages")).toEqual([]);
		await call("waitForIrcReplies", ["x"], 100);
		const unsubscribe = call("subscribe", () => {});
		expect(typeof unsubscribe).toBe("function");
		if (typeof unsubscribe === "function") expect(() => unsubscribe()).not.toThrow();
		await call("abort");
		await call("dispose");
		expect(shim.isStreaming).toBe(false);
		expect(shim.runStartedAt).toBe(0);
		expect(shim.messages).toEqual([]);
	});
});

describe("/irc-in", () => {
	test("a valid message reaches the root session's deliverIrcMessage as an IrcMessage", async () => {
		const s = setup();
		s.start();
		const before = Date.now();
		await s.run(frame("m1", { replyTo: "r1" }));
		expect(s.ui.notices).toEqual([]);
		expect(s.session.delivered).toHaveLength(1);
		const message = s.session.delivered[0];
		expect(message).toMatchObject({ id: "m1", from: "alice", to: AGENT_ID, body: "hello", replyTo: "r1" });
		expect(typeof message?.ts).toBe("number");
		expect(message?.ts).toBeGreaterThanOrEqual(before);
		expect(message?.ts).toBeLessThanOrEqual(Date.now());
		expect(message && "wakeRelay" in message).toBe(false);
	});

	test("replyTo is passed only when given and wakeRelay only when true", async () => {
		const s = setup();
		s.start();
		await s.run(frame("plain", { replyTo: "", wakeRelay: false }));
		await s.run(frame("relay", { wakeRelay: true }));
		await s.run(frame("stringy", { wakeRelay: "true" }));
		const [plain, relay, stringy] = s.session.delivered;
		expect(plain && "replyTo" in plain).toBe(false);
		expect(plain && "wakeRelay" in plain).toBe(false);
		expect(relay?.wakeRelay).toBe(true);
		expect(stringy && "wakeRelay" in stringy).toBe(false);
	});

	test("a body is delivered unchanged", async () => {
		const s = setup();
		s.start();
		const body = "  two\nlines with \"quotes\" and ünïcode ";
		await s.run(JSON.stringify({ id: "m1", from: "alice", body }));
		expect(s.session.delivered[0]?.body).toBe(body);
	});

	test("a sender named like the VM agent arrives as the parent", async () => {
		const s = setup({ config: { parent: { id: "Boss" } } });
		s.start();
		await s.run(frame("m1", { from: AGENT_ID }));
		expect(s.session.delivered[0]?.from).toBe("Boss");
		expect(s.registered.map(r => r.id)).toEqual(["Boss"]);
	});

	test("the default parent id stands in for a sender named like the VM agent", async () => {
		const s = setup();
		s.start();
		await s.run(frame("m1", { from: AGENT_ID }));
		expect(s.session.delivered[0]?.from).toBe("Parent");
	});

	test("an unknown sender is registered once as an idle peer", async () => {
		const s = setup();
		s.start();
		await s.run(frame("m1", { from: "alice" }));
		await s.run(frame("m2", { from: "alice" }));
		const alice = s.registered.filter(r => r.id === "alice");
		expect(alice).toHaveLength(1);
		expect(alice[0]).toMatchObject({ id: "alice", kind: "sub", status: "idle" });
		expect(typeof alice[0]?.session).toBe("object");
		expect(s.session.delivered.map(m => m.id)).toEqual(["m1", "m2"]);
	});

	test("a sender that is already registered is not registered again", async () => {
		const s = setup();
		s.start();
		expect(s.registered).toHaveLength(1);
		await s.run(frame("m1", { from: "Parent" }));
		expect(s.registered).toHaveLength(1);
		expect(s.session.delivered[0]?.from).toBe("Parent");
	});

	test("a repeated id is delivered once", async () => {
		const s = setup();
		s.start();
		await s.run(frame("m1"));
		await s.run(frame("m1", { body: "again" }));
		await s.run(frame("m2"));
		expect(s.session.delivered.map(m => m.id)).toEqual(["m1", "m2"]);
		expect(s.ui.notices).toEqual([]);
	});

	test.each([
		["not JSON", "not json"],
		["empty", ""],
		["a JSON array", "[1]"],
		["no id", JSON.stringify({ from: "a", body: "b" })],
		["an empty id", JSON.stringify({ id: "", from: "a", body: "b" })],
		["no from", JSON.stringify({ id: "m", body: "b" })],
		["no body", JSON.stringify({ id: "m", from: "a" })],
		["a blank body", JSON.stringify({ id: "m", from: "a", body: "  \n" })],
		["a numeric id", JSON.stringify({ id: 4, from: "a", body: "b" })],
	])("%s notifies an error and delivers nothing", async (_name, args) => {
		const s = setup();
		s.start();
		await s.run(args);
		expect(s.session.delivered).toEqual([]);
		expect(s.ui.notices).toHaveLength(1);
		expect(s.ui.notices[0]?.type).toBe("error");
		expect(s.registered).toHaveLength(1);
	});

	test("a failed parse does not poison the id: a corrected message is delivered", async () => {
		const s = setup();
		s.start();
		await s.run(JSON.stringify({ id: "m1", from: "a" }));
		await s.run(frame("m1"));
		expect(s.session.delivered.map(m => m.id)).toEqual(["m1"]);
	});

	test("no live session for the agent notifies an error and logs once", async () => {
		const s = setup({ noRoot: true });
		s.start();
		await s.run(frame("m1"));
		await s.run(frame("m2"));
		expect(s.ui.notices.map(n => n.type)).toEqual(["error", "error"]);
		expect(s.logs).toHaveLength(1);
		expect(s.session.delivered).toEqual([]);
	});

	test("a session without deliverIrcMessage notifies an error and logs once", async () => {
		const s = setup({ noDeliver: true });
		s.start();
		await s.run(frame("m1"));
		expect(s.ui.notices).toHaveLength(1);
		expect(s.ui.notices[0]?.type).toBe("error");
		expect(s.logs).toHaveLength(1);
		expect(s.session.delivered).toEqual([]);
	});

	test("a throwing deliverIrcMessage notifies each time and logs once", async () => {
		const s = setup({
			deliver: async () => {
				throw new Error("bus down");
			},
		});
		s.start();
		await s.run(frame("m1"));
		await s.run(frame("m2"));
		expect(s.session.delivered).toHaveLength(2);
		expect(s.ui.notices).toHaveLength(2);
		for (const notice of s.ui.notices) {
			expect(notice.type).toBe("error");
			expect(notice.message).toContain("bus down");
		}
		expect(s.logs).toHaveLength(1);
		expect(s.logs[0]).toContain("bus down");
	});

	test("a message whose delivery failed may be delivered again", async () => {
		let attempt = 0;
		const s = setup({
			deliver: async () => {
				attempt++;
				if (attempt === 1) throw new Error("first fails");
				return "injected";
			},
		});
		s.start();
		await s.run(frame("m1"));
		await s.run(frame("m1"));
		expect(s.session.delivered).toHaveLength(2);
		expect(s.ui.notices).toHaveLength(1);
	});

	test("a woken outcome waits until the session streams", async () => {
		const s = setup({ outcome: "woken", streamsAtRead: 4 });
		s.start();
		await s.run(frame("m1"));
		// The command polled the session until it answered true, then stopped.
		expect(s.session.wakeReads).toBe(4);
		expect(s.ui.notices).toEqual([]);
	});

	test("a woken outcome with a session already streaming returns at once", async () => {
		const s = setup({ outcome: "woken", streamsAtRead: 1 });
		s.start();
		await s.run(frame("m1"));
		expect(s.session.wakeReads).toBe(1);
	});

	test("an injected outcome does not look at the session's streaming state", async () => {
		const s = setup({ outcome: "injected", streamsAtRead: 1 });
		s.start();
		await s.run(frame("m1"));
		expect(s.session.wakeReads).toBe(0);
	});

	test("the command's ui is what the parent shim emits through", async () => {
		const s = setup();
		const bare = { agent: { kind: "main", id: AGENT_ID } };
		for (const handler of s.handlers) handler({ type: "session_start" }, bare);
		await s.run(frame("m1"));
		await deliverer(s.peer("Parent"))(MESSAGE);
		expect(s.ui.status).toHaveLength(1);
	});
});

describe("without a registry", () => {
	test("installIrcPeer logs once and registers neither a handler nor the command", () => {
		const handlers: string[] = [];
		const commands: string[] = [];
		const pi = {
			on: (event: string) => handlers.push(event),
			registerCommand: (name: string) => commands.push(name),
		} as unknown as ExtensionAPI;
		const logs: string[] = [];
		installIrcPeer(pi, { registry: undefined, readConfig: () => undefined, log: line => logs.push(line) });
		expect(logs).toHaveLength(1);
		expect(handlers).toEqual([]);
		expect(commands).toEqual([]);
	});
});

describe("the default export", () => {
	test("does not throw on a fake pi", () => {
		const pi = { on: () => {}, registerCommand: () => {} } as unknown as ExtensionAPI;
		expect(() => ircPeer(pi)).not.toThrow();
	});
});
