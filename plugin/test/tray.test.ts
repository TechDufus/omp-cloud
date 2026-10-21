import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { TerminalNotification } from "@oh-my-pi/pi-tui";
import { type CardDetails, loadTui } from "../src/cards";
import { Deliverer } from "../src/deliver";
import { Inbox } from "../src/inbox";
import type { ThreadSummary } from "../src/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Cloud } from "../src/verbs";
import { statusText } from "../src/watch";
import { detail, event, pending, question, summary, turn } from "./builders";
import { cloudEnv, fakeHost, fakePi, until, type FakeHost, type FakePi } from "./fakes";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

const ID = "k3x9fa2m7q1z";
const SHORT = "2m7q1z";
const ENC = new TextEncoder();

const state = {
	listed: [] as ThreadSummary[],
	detail: detail(),
	stream: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
	messages: 0,
	/** The thread was deleted behind the plugin's back. */
	gone: false,
};

const working = () => detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", turns: [turn(1, { state: "running" })] });
const finished = (over: Parameters<typeof turn>[1] = {}) =>
	detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "idle", turns: [turn(1, { title: "Greeting fixed", reply: "All done.\nSee the tests.", ...over })] });

function reset(): void {
	state.listed = [summary({ id: ID, name: "Fix greeting bug", title: "Add Greet" })];
	state.detail = working();
	state.stream = undefined;
	state.messages = 0;
	state.gone = false;
}

let server: Bun.Server<undefined>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const p = new URL(req.url).pathname;
			const T = `/api/v1/threads/${ID}`;
			if (req.method === "GET" && p === "/api/v1/threads") return Response.json({ threads: state.listed });
			if (req.method === "GET" && p === T) return state.gone ? Response.json({ error: "no such thread" }, { status: 404 }) : Response.json(state.detail);
			if (req.method === "GET" && p === `${T}/events`) {
				const body = new ReadableStream<Uint8Array>({
					start: c => void (state.stream = c),
					cancel: () => void (state.stream = undefined),
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			}
			if (req.method === "DELETE" && p === T) return Response.json({}, { status: 202 });
			if (req.method === "POST" && p === `${T}/messages`) {
				state.messages++;
				return Response.json({ turn: { id: 2 } }, { status: 201 });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

beforeEach(reset);

const live: { cloud: Cloud; host: FakeHost }[] = [];

afterEach(async () => {
	for (const { cloud, host } of live.splice(0)) {
		await cloud.handle("unwatch", host.host as never);
		cloud.shutdown();
	}
});

interface Rig {
	cloud: Cloud;
	host: FakeHost;
	pi: FakePi;
	/** What the terminal was told as a notification, oldest first. */
	terminal: TerminalNotification[];
	/** The OSC 7501 sequences written to the terminal, oldest first. */
	records: string[];
}

async function setup(over: { deliver?: "transcript"; settings?: Record<string, unknown>; hostOpts?: Parameters<typeof fakeHost>[0] } = {}): Promise<Rig> {
	const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\n${over.deliver ? `deliver: ${over.deliver}\n` : ""}`);
	const terminal: TerminalNotification[] = [];
	const records: string[] = [];
	const host = fakeHost({ cwd: await tmp("omp-cloud-cwd-"), ...over.hostOpts });
	const pi = fakePi({ settings: Settings.isolated(over.settings) });
	const cloud = new Cloud(pi.pi, "/own", env, await tmp("omp-cloud-home-"), () => {}, { notify: n => void terminal.push(n), write: s => void records.push(s) });
	live.push({ cloud, host });
	return { cloud, host, pi, terminal, records };
}

/** Sends a message to the thread, which makes the session follow it (the thread then counts as the user's own). */
async function follow(r: Rig): Promise<void> {
	await r.cloud.handle(`send ${SHORT} keep going`, r.host.host as never);
	await until(() => state.stream !== undefined);
}

async function push(kind: string, seq: number): Promise<void> {
	await until(() => state.stream !== undefined);
	state.stream?.enqueue(ENC.encode(`id: ${seq}\ndata: ${JSON.stringify(event(seq, { kind, turn: 1 }))}\n\n`));
}

describe("a finished turn of the user's own thread", () => {
	test("goes to the inbox and the terminal: no card, no toast, the first line of the reply as the body, one unread in the footer", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.terminal.length === 1);

		expect(r.terminal[0]).toEqual({ title: "☁ Fix greeting bug · turn 1 done", body: "All done.", id: `omp-cloud-${ID}-1`, type: "completion", actions: "focus", urgency: "normal" });
		expect(r.pi.sent).toEqual([]);
		expect(r.host.notes.map(n => n[0])).toEqual([`☁ queued turn 2 on Fix greeting bug · ${ID}`]);
		expect(r.host.status.at(-1)).toBe("☁ 1 unread");
	});

	test("a failed turn is an error notification with the first line of the error", async () => {
		const r = await setup({ settings: { "error.notify": "on" } });
		await follow(r);
		state.detail = finished({ state: "failed", error: "vm lost\nsecond line", reply: "" });
		await push("turn_failed", 1);
		await until(() => r.terminal.length === 1);

		expect(r.terminal[0]).toMatchObject({ title: "☁ Fix greeting bug · turn 1 failed", body: "vm lost", type: "error", id: `omp-cloud-${ID}-1` });
		expect(r.pi.sent).toEqual([]);
		expect(r.host.notes.every(n => n[1] !== "error")).toBe(true);
		expect(r.host.status.at(-1)).toBe("☁ 1 unread");
	});

	test("a turn with no reply says its title; one with neither says its state", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished({ reply: "", title: "" });
		await push("turn_done", 1);
		await until(() => r.terminal.length === 1);
		expect(r.terminal[0]?.body).toBe("done");
	});

	test("a question is an ask notification and an unread entry, with the waiting count kept beside it", async () => {
		const r = await setup();
		await follow(r);
		state.detail = detail({
			id: ID,
			name: "Fix greeting bug",
			title: "Add Greet",
			phase: "waiting",
			question: pending({ turn: 1, id: 2, text: "Which database?\nsecond line" }),
			turns: [turn(1, { state: "running", questions: [question({ id: 2, ask: 1, text: "Which database?" })] })],
		});
		await push("question_asked", 1);
		await until(() => r.terminal.length === 1);

		expect(r.terminal[0]).toEqual({ title: "☁ Fix greeting bug · asks", body: "Which database?", id: `omp-cloud-${ID}-1q2`, type: "ask", actions: "focus", urgency: "normal" });
		expect(r.pi.sent).toEqual([]);
		expect(r.host.notes.some(n => n[1] === "warning")).toBe(false);
		await until(() => r.host.status.at(-1) === "☁ 0 working · 1 waiting · 1 unread");
	});

	test("/cloud show reads the thread's entries and clears the footer", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.host.status.at(-1) === "☁ 1 unread");
		await r.cloud.handle(`show ${SHORT}`, r.host.host as never);
		expect(r.host.status.at(-1)).toBeUndefined();
		expect(r.pi.sent).toHaveLength(1);
	});

	test("with deliver: transcript it posts the card and the toast, and tells the terminal nothing", async () => {
		const r = await setup({ deliver: "transcript" });
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.pi.sent.length === 1);
		expect((r.pi.sent[0]?.message.details as CardDetails).kind).toBe("turn");
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: false });
		expect(r.host.notes.map(n => n[0])).toContain(`☁ Fix greeting bug · ${ID} turn 1 done: Greeting fixed`);
		expect(r.terminal).toEqual([]);
		expect(r.host.status.at(-1)).toBeUndefined();
	});
});

const b64 = (text: string): string => Buffer.from(text).toString("base64");
const record = (state: string, text: string, label = "Fix greeting bug"): string => `\x1b]7501;${state}:id=omp-cloud/${ID}:app=omp-cloud:title=${b64(label)}:msg=${b64(text)}\x1b\\`;
const clearOf = (id: string): string => `\x1b]7501;state=clear:id=${id}\x1b\\`;

describe("OSC 7501 records", () => {
	test("a done turn is a done record whose msg names its thread; reading the thread clears it; nothing is sent twice", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.records.length === 1);
		expect(r.records).toEqual([record("state=done", "Fix greeting bug · turn 1 done: All done.")]);

		await r.cloud.handle(`show ${SHORT}`, r.host.host as never);
		expect(r.records).toEqual([record("state=done", "Fix greeting bug · turn 1 done: All done."), clearOf(`omp-cloud/${ID}`)]);
		// Nothing is unread: showing it again writes nothing.
		await r.cloud.handle(`show ${SHORT}`, r.host.host as never);
		expect(r.records).toHaveLength(2);
	});

	test("a failed turn is an error record with the first line of the error", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished({ state: "failed", error: "vm lost\nsecond line", reply: "" });
		await push("turn_failed", 1);
		await until(() => r.records.length === 1);
		expect(r.records[0]).toBe(record("state=error", "Fix greeting bug · turn 1 failed: vm lost"));
	});

	test("a question is a blocked record of kind question, an approval or the push a permission; answering it clears the record", async () => {
		for (const [key, kind] of [
			["", "question"],
			["approval:bash", "permission"],
			["omp-cloud:push", "permission"],
		] as const) {
			reset();
			const r = await setup();
			await follow(r);
			state.detail = detail({
				id: ID,
				name: "Fix greeting bug",
				title: "Add Greet",
				phase: "waiting",
				question: pending({ turn: 1, id: 2, text: "Which database?" }),
				turns: [turn(1, { state: "running", questions: [question({ id: 2, ask: 1, key, text: "Which database?" })] })],
			});
			await push("question_asked", 1);
			await until(() => r.records.length === 1);
			expect(r.records[0]).toBe(record(`state=blocked:kind=${kind}`, "Fix greeting bug asks: Which database?"));

			// The question is answered: the thread's detail has none any more.
			state.detail = working();
			await push("question_answered", 2);
			await until(() => r.records.length === 2);
			expect(r.records[1]).toBe(clearOf(`omp-cloud/${ID}`));
			await r.cloud.handle("unwatch", r.host.host as never);
		}
	});

	test("an open question wins over an unread result; the newest unread result decides otherwise", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.records.length === 1);
		state.detail = detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", turns: [turn(1), turn(2, { state: "running" })] });
		await r.cloud.handle(`send ${SHORT} more`, r.host.host as never);
		state.detail = detail({
			id: ID,
			name: "Fix greeting bug",
			title: "Add Greet",
			phase: "waiting",
			question: pending({ turn: 2, id: 3, text: "Which cache?" }),
			turns: [turn(1), turn(2, { state: "running", questions: [question({ id: 3, ask: 1, text: "Which cache?" })] })],
		});
		await push("question_asked", 3);
		await until(() => r.records.length === 2);
		// The thread had an unread result: the question is a new arrival, so the record is cleared right before it.
		expect(r.records[1]).toBe(`${clearOf(`omp-cloud/${ID}`)}${record("state=blocked:kind=question", "Fix greeting bug asks: Which cache?")}`);
	});

	test("the session ending or switching removes every record, and a switch reports what is still unread again", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.records.length === 1);

		r.cloud.beforeSwitch();
		expect(r.records.at(-1)).toBe(clearOf("omp-cloud"));
		r.cloud.afterSwitch();
		expect(r.records).toHaveLength(3);
		expect(r.records[2]).toBe(record("state=done", "Fix greeting bug · turn 1 done: All done."));

		r.cloud.shutdown();
		expect(r.records.at(-1)).toBe(clearOf("omp-cloud"));
		r.cloud.shutdown();
		expect(r.records).toHaveLength(4);
	});

	test("omp's terminal.programStatus off writes no record", async () => {
		const r = await setup({ settings: { "terminal.programStatus": false } });
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.terminal.length === 1);
		expect(r.records).toEqual([]);
	});

	test("with deliver: transcript no record is written", async () => {
		const r = await setup({ deliver: "transcript" });
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.pi.sent.length === 1);
		expect(r.records).toEqual([]);
	});
});

describe("the desktop notification follows omp's own settings", () => {
	test("completion.notify off keeps the entry and the record but sends no notification for a done turn", async () => {
		const r = await setup({ settings: { "completion.notify": "off" } });
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.records.length === 1);
		expect(r.terminal).toEqual([]);
		expect(r.host.status.at(-1)).toBe("☁ 1 unread");
	});

	test("error.notify (off by default) gates a failed turn, ask.notify a question", async () => {
		const off = await setup();
		await follow(off);
		state.detail = finished({ state: "failed", error: "vm lost", reply: "" });
		await push("turn_failed", 1);
		await until(() => off.records.length === 1);
		expect(off.terminal).toEqual([]);

		reset();
		const on = await setup({ settings: { "error.notify": "on" } });
		await follow(on);
		state.detail = finished({ state: "failed", error: "vm lost", reply: "" });
		await push("turn_failed", 1);
		await until(() => on.terminal.length === 1);
		expect(on.terminal[0]?.type).toBe("error");

		reset();
		const ask = await setup({ settings: { "ask.notify": "off" } });
		await follow(ask);
		state.detail = detail({
			id: ID,
			name: "Fix greeting bug",
			title: "Add Greet",
			phase: "waiting",
			question: pending({ turn: 1, id: 2, text: "Which?" }),
			turns: [turn(1, { state: "running", questions: [question({ id: 2, ask: 1 })] })],
		});
		await push("question_asked", 1);
		await until(() => ask.records.length === 1);
		expect(ask.terminal).toEqual([]);
	});
});

describe("delivery by origin and setting", () => {
	function deliverer(mode: "tray" | "transcript") {
		const inbox = new Inbox();
		const terminal: TerminalNotification[] = [];
		const pi = fakePi();
		const host = fakeHost();
		const d = new Deliverer(pi.pi, { inbox, mode: () => mode, notify: n => void terminal.push(n), now: () => 42 });
		return { inbox, terminal, pi, host, d };
	}

	test("a thread the model delegated keeps its card, which wakes the model, in either setting", () => {
		for (const mode of ["tray", "transcript"] as const) {
			const { inbox, terminal, pi, host, d } = deliverer(mode);
			d.setOrigin(ID, "tool");
			expect(d.tray(host.host, ID)).toBe(false);
			d.turn(host.host, finished(), turn(1, { reply: "All done." }), []);
			d.question(host.host, working(), pending());
			expect(pi.sent.map(s => s.options)).toEqual([{ triggerTurn: true }, { triggerTurn: true }]);
			expect(inbox.entries).toEqual([]);
			expect(terminal).toEqual([]);
		}
	});

	test("the user's own thread goes to the inbox in tray mode and to a card in transcript mode", () => {
		const tray = deliverer("tray");
		tray.d.setOrigin(ID, "user");
		expect(tray.d.tray(tray.host.host, ID)).toBe(true);
		tray.d.turn(tray.host.host, finished(), turn(1, { reply: "All done." }), []);
		expect(tray.pi.sent).toEqual([]);
		expect(tray.inbox.entries).toEqual([{ thread: ID, turn: 1, kind: "result", label: "Fix greeting bug", line: "All done.", at: 42, read: false }]);

		const transcript = deliverer("transcript");
		expect(transcript.d.tray(transcript.host.host, ID)).toBe(false);
		transcript.d.turn(transcript.host.host, finished(), turn(1, { reply: "All done." }), []);
		expect(transcript.pi.sent).toHaveLength(1);
		expect(transcript.inbox.entries).toEqual([]);
	});

	test("without tray options every card goes to the transcript", () => {
		const pi = fakePi();
		const host = fakeHost();
		const d = new Deliverer(pi.pi);
		expect(d.tray(host.host, ID)).toBe(false);
		d.turn(host.host, finished(), turn(1), []);
		expect(pi.sent).toHaveLength(1);
	});

	test("the setting is read on every turn", () => {
		const inbox = new Inbox();
		let mode: "tray" | "transcript" = "tray";
		const pi = fakePi();
		const host = fakeHost();
		const d = new Deliverer(pi.pi, { inbox, mode: () => mode, notify: () => {} });
		d.turn(host.host, finished(), turn(1), []);
		mode = "transcript";
		d.turn(host.host, finished(), turn(2), []);
		expect(inbox.entries).toHaveLength(1);
		expect(pi.sent).toHaveLength(1);
	});

	test("turns that are not finished and the hub's open post nothing into the inbox", () => {
		const { inbox, terminal, pi, host, d } = deliverer("tray");
		d.turn(host.host, working(), turn(1, { state: "running" }), []);
		d.turn(host.host, working(), turn(1, { state: "cancelled" }), []);
		expect(inbox.entries).toEqual([]);
		expect(terminal).toEqual([]);
		d.open(host.host, finished(), turn(1, { reply: "All done." }));
		d.open(host.host, working(), turn(2, { state: "running" }));
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.options).toEqual({ triggerTurn: false });
		expect((pi.sent[0]?.message.details as CardDetails).kind).toBe("turn");
	});

	test("opening a card never wakes the model, even for a thread the model delegated", () => {
		const { pi, host, d } = deliverer("tray");
		d.setOrigin(ID, "tool");
		d.open(host.host, finished(), turn(1, { reply: "All done." }));
		expect(pi.sent.map(s => s.options)).toEqual([{ triggerTurn: false }]);
	});
});

describe("the footer status", () => {
	test("working, waiting and unread, each only when there is something", () => {
		expect(statusText(0, 0)).toBeUndefined();
		expect(statusText(0, 0, 0)).toBeUndefined();
		expect(statusText(2, 0)).toBe("☁ 2 working");
		expect(statusText(2, 1)).toBe("☁ 2 working · 1 waiting");
		expect(statusText(0, 0, 3)).toBe("☁ 3 unread");
		expect(statusText(2, 0, 3)).toBe("☁ 2 working · 3 unread");
		expect(statusText(2, 1, 3)).toBe("☁ 2 working · 1 waiting · 3 unread");
	});
});

describe("the hub's open key", () => {
	test("posts the thread's latest finished turn as a card, marks the thread read and closes the hub", async () => {
		const tui = await loadTui();
		if (!tui) throw new Error("the host pi-tui is required");
		state.detail = finished();
		const opened: unknown[] = [];
		const custom = (async (factory: (...a: unknown[]) => unknown, options: unknown) => {
			opened.push(options);
			const { promise, resolve } = Promise.withResolvers<unknown>();
			const hub = (await factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve)) as {
				refresh(): Promise<void>;
				handleInput(d: string): void;
				dispose(): void;
			};
			await hub.refresh();
			hub.handleInput("o");
			const result = await promise;
			hub.dispose();
			return result;
		}) as never;
		const r = await setup({ hostOpts: { mode: "tui", custom } });
		r.cloud.setTui(tui);
		// An entry from a turn that finished while the user worked elsewhere.
		state.detail = working();
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.host.status.at(-1) === "☁ 1 unread");

		await r.cloud.handle("", r.host.host as never);

		expect(opened).toHaveLength(1);
		expect(r.pi.sent).toHaveLength(1);
		const card = r.pi.sent[0]?.message.details as CardDetails;
		expect(card).toMatchObject({ kind: "turn", thread: ID, turn: 1, state: "done", reply: "All done.\nSee the tests." });
		expect(r.pi.sent[0]?.options).toEqual({ triggerTurn: false });
		expect(r.host.status.at(-1)).toBeUndefined();
	});

	test("a thread with no finished turn says so and posts nothing", async () => {
		const tui = await loadTui();
		if (!tui) throw new Error("the host pi-tui is required");
		const script = ["o", "q"];
		const custom = (async (factory: (...a: unknown[]) => unknown) => {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			const hub = (await factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve)) as {
				refresh(): Promise<void>;
				handleInput(d: string): void;
				dispose(): void;
			};
			await hub.refresh();
			hub.handleInput(script.shift() ?? "q");
			const result = await promise;
			hub.dispose();
			return result;
		}) as never;
		const r = await setup({ hostOpts: { mode: "tui", custom } });
		r.cloud.setTui(tui);
		state.detail = detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "idle", turns: [] });
		await r.cloud.handle("", r.host.host as never);
		expect(r.pi.sent).toEqual([]);
		expect(r.host.notes.map(n => n[0])).toEqual([`☁ Fix greeting bug · ${ID} has no finished turn yet`]);
	});
});

describe("what the cloud writes cannot reach the terminal as control characters", () => {
	test("the notification and the inbox entry hold a thread's name, reply and question as plain lines", () => {
		const inbox = new Inbox();
		const terminal: TerminalNotification[] = [];
		const pi = fakePi();
		const host = fakeHost();
		const d = new Deliverer(pi.pi, { inbox, mode: () => "tray", notify: n => void terminal.push(n) });
		const evil = "ok\u0007\u001b]52;c;Zm9v\u0007\u0085tail";
		const named = detail({ id: ID, name: "x\u001b[31mred\u0007", phase: "idle", turns: [turn(1, { reply: `${evil}\nsecond`, title: "t" })] });
		d.turn(host.host, named, named.turns[0] ?? turn(1), []);
		d.question(host.host, detail({ id: ID, name: "n", question: pending({ turn: 1, id: 2, text: evil }), turns: [turn(1, { questions: [question({ id: 2 })] })] }), pending({ turn: 1, id: 2, text: evil }));

		expect(terminal).toHaveLength(2);
		for (const n of terminal) {
			expect(`${n.title}${n.body}`).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		}
		expect(terminal[0]?.title).toBe("☁ x [31mred · turn 1 done");
		expect(terminal[0]?.body).toBe("ok ]52;c;Zm9v tail");
		for (const e of inbox.entries) expect(`${e.label}${e.line}`).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
	});
});

describe("the inbox of a thread that is gone or announced twice", () => {
	test("deleting a thread forgets its entries and clears its record", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.records.length === 1);
		await r.cloud.handle(`delete ${SHORT}`, r.host.host as never);
		expect(r.records.at(-1)).toBe(clearOf(`omp-cloud/${ID}`));
		expect(r.host.status.at(-1)).toBeUndefined();
	});

	test("a thread the watcher finds gone (404) forgets its entries too", async () => {
		const r = await setup();
		await follow(r);
		state.detail = finished();
		await push("turn_done", 1);
		await until(() => r.records.length === 1);
		state.detail = detail({ id: ID, name: "Fix greeting bug", title: "Add Greet", phase: "working", turns: [turn(1), turn(2, { state: "running" })] });
		await r.cloud.handle(`send ${SHORT} again`, r.host.host as never);
		await until(() => state.stream !== undefined);
		state.gone = true;
		await push("turn_started", 5);
		await until(() => r.records.length === 2);
		expect(r.records[1]).toBe(clearOf(`omp-cloud/${ID}`));
		expect(r.host.status.at(-1)).toBeUndefined();
	});

	test("watching a waiting thread again does not enter its question, or notify, twice", async () => {
		const r = await setup();
		await follow(r);
		state.detail = detail({
			id: ID,
			name: "Fix greeting bug",
			title: "Add Greet",
			phase: "waiting",
			question: pending({ turn: 1, id: 2, text: "Which database?" }),
			turns: [turn(1, { state: "running", questions: [question({ id: 2, ask: 1, text: "Which database?" })] })],
		});
		await push("question_asked", 1);
		await until(() => r.terminal.length === 1);
		await r.cloud.handle(`watch ${SHORT}`, r.host.host as never);
		await r.cloud.handle(`send ${SHORT} hi`, r.host.host as never);
		expect(r.terminal).toHaveLength(1);
		expect(r.records).toHaveLength(1);
		await until(() => r.host.status.at(-1) === "☁ 0 working · 1 waiting · 1 unread");
	});
});
