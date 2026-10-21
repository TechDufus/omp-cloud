import { describe, expect, test } from "bun:test";
import type { Component, DescribeContext, NativeNode, TUI, Theme } from "@oh-my-pi/pi-tui";
import { loadTui, type TuiModule } from "../src/cards";
import type { PendingQuestion, ThreadDetail, ThreadEvent, ThreadPhase, ThreadTurn } from "../src/types";
import { rowSegments, Watcher, widgetLines, widgetModel, WIDGET_MAX_ROWS, type WatchApi, type WidgetThread } from "../src/watch";
import { detail as buildDetail, event, pending, turn } from "./builders";
import { Feed } from "./feed";
import { fakeHost, lastLines, until, type FakeHost } from "./fakes";

const ID = "aaaaaak3x9fa";
const NOW = Date.parse("2026-01-01T00:05:00Z");

const running = (id: number, over: Partial<ThreadTurn> = {}): ThreadTurn => turn(id, { state: "running", startedAt: "2026-01-01T00:03:00Z", ...over });
const thread = (phase: ThreadPhase, turns: ThreadTurn[], events: ThreadEvent[] = [], over: Partial<ThreadDetail> = {}): WidgetThread => ({
	id: ID,
	detail: buildDetail({ id: ID, phase, turns, title: "Add Greet", ...over }),
	events,
});
const lines = (...threads: WidgetThread[]): string[] => widgetLines(widgetModel(threads), NOW);
const pq = (over: Partial<PendingQuestion> = {}): PendingQuestion => pending({ id: 1, turn: 1, text: "Which database?", remaining: 1, ...over });

describe("widget rows", () => {
	test("a running turn shows the short id, title, time since it started and the latest activity", () => {
		const events = [
			event(1, { kind: "turn_queued", text: "queued by owner" }),
			event(2, { kind: "turn_started", text: "started" }),
			event(3, { kind: "vm", text: "sandbox sbx-1 created" }),
			event(4, { kind: "vm", text: "omp started (pid 1227)" }),
			event(5, { kind: "tool", text: "read Reading project plan" }),
			event(6, { kind: "tool", text: "read Listing repo root" }),
			event(7, { kind: "tool", text: "read Reading build phases section" }),
		];
		const t = thread("working", [running(1, { startedAt: "2026-01-01T00:04:07Z" })], events, { title: "Summarize the plan" });
		expect(lines(t)).toEqual(["☁ k3x9fa · Summarize the plan · 53s · read: Reading build phases section"]);

		// The reply's first line replaces it; the lifecycle events around it never show.
		const reply = event(8, { kind: "assistant", text: "\nThe build has four phases.\n\n1. Skeleton and store\n2. Runner" });
		expect(lines({ ...t, events: [...events, reply, event(9, { kind: "turn_done", text: "Summarize the plan" })] })).toEqual([
			"☁ k3x9fa · Summarize the plan · 53s · The build has four phases.",
		]);
	});

	test("with no progress yet the activity is `working`; vm events read without the sandbox id or pid, unknown ones as they are", () => {
		expect(lines(thread("working", [running(1)], [event(1, { kind: "turn_started" })]))).toEqual(["☁ k3x9fa · Add Greet · 2m00s · working"]);
		const vm = (text: string): string => lines(thread("working", [running(1)], [event(1, { kind: "vm", text })]))[0] ?? "";
		expect(vm("sandbox io53kkthryryqs4p22k1i created")).toEndWith(" · preparing the VM");
		expect(vm("omp started (pid 1227)")).toEndWith(" · omp started");
		expect(vm("resumed")).toEndWith(" · VM resumed");
		expect(vm("paused")).toEndWith(" · VM paused");
		expect(vm("building the omp 18.12.3 VM template")).toEndWith(" · building the omp 18.12.3 VM template");
		expect(vm("omp restarted")).toEndWith(" · omp restarted");
	});

	test("activity comes from the current turn only; events of no turn count, events of other turns never", () => {
		const events = [
			event(1, { kind: "tool", turn: 1, text: "bash old turn" }),
			event(2, { kind: "notice", turn: null, text: "template ready" }),
			event(3, { kind: "tool", turn: 3, text: "bash a later turn" }),
		];
		const t = thread("working", [turn(1), running(2)], events);
		expect(lines(t)[0]?.endsWith("· template ready")).toBe(true);
		expect(lines({ ...t, events: events.slice(0, 1) })[0]?.endsWith("· working")).toBe(true);
	});

	test("a tool shows `tool: rest`, an assistant its first non-empty line, long text is cut, a tool without arguments is just its name", () => {
		const row = (e: ThreadEvent): string => lines(thread("working", [running(1)], [e]))[0] ?? "";
		expect(row(event(1, { kind: "tool", text: "grep  Searching   for\nusages" }))).toEndWith("· grep: Searching for usages");
		expect(row(event(1, { kind: "assistant", text: "\n  \nFirst line\nsecond" }))).toEndWith("· First line");
		expect(row(event(1, { kind: "tool", text: "ls" }))).toEndWith("· ls");
		const long = row(event(1, { kind: "assistant", text: "word ".repeat(60) }));
		expect(long.length).toBeLessThan("☁ k3x9fa · Add Greet · 2m00s · ".length + 81);
		expect(long.endsWith("…")).toBe(true);
	});

	test("an empty assistant message does not hide the activity before it", () => {
		const events = [event(1, { kind: "tool", text: "read a.go" }), event(2, { kind: "assistant", text: "  \n" })];
		expect(lines(thread("working", [running(1)], events))[0]).toEndWith("· read: a.go");
	});

	test("a tool error is told apart by its colour and keeps its text", () => {
		const toneOf = (e: ThreadEvent): string | undefined => {
			const row = widgetModel([thread("working", [running(1)], [e])]).rows[0];
			return row && rowSegments(row, NOW).find(s => s[1] === e.text)?.[0];
		};
		expect(toneOf(event(1, { kind: "tool_error", text: "read: ENOENT a.go" }))).toBe("error");
		expect(toneOf(event(1, { kind: "notice", text: "template ready" }))).toBe("muted");
	});

	test("elapsed counts from the running turn's start, not its queueing or the thread's creation", () => {
		const t = thread("working", [running(1, { queuedAt: "2026-01-01T00:00:30Z", startedAt: "2026-01-01T00:02:30Z" })]);
		expect(lines(t)[0]).toContain(" · 2m30s · ");
		// A start that cannot be parsed falls back to the queueing, then to the thread's creation.
		expect(lines(thread("working", [running(1, { startedAt: "", queuedAt: "2026-01-01T00:04:00Z" })]))[0]).toContain(" · 1m00s · ");
		expect(lines(thread("working", [running(1, { startedAt: "", queuedAt: "" })], [], { createdAt: "2026-01-01T00:00:00Z" }))[0]).toContain(" · 5m00s · ");
	});

	test("the turn number shows only after the first turn", () => {
		expect(lines(thread("working", [running(1)]))[0]).not.toContain("turn");
		expect(lines(thread("working", [turn(1), running(2)]))[0]).toBe("☁ k3x9fa · Add Greet · 2m00s · turn 2 · working");
	});

	test("a thread whose first turn has not started prepares the VM until a vm event arrives; a queued turn says so", () => {
		const queued = turn(1, { state: "queued", startedAt: "", queuedAt: "2026-01-01T00:04:00Z" });
		expect(lines(thread("starting", [queued]))).toEqual(["☁ k3x9fa · Add Greet · 1m00s · preparing the VM"]);
		const vm = event(1, { kind: "vm", text: "building the omp 18.12.3 VM template" });
		expect(lines(thread("starting", [queued], [vm]))).toEqual(["☁ k3x9fa · Add Greet · 1m00s · building the omp 18.12.3 VM template"]);
		expect(lines(thread("idle", [turn(1), turn(2, { state: "queued", startedAt: "", queuedAt: "2026-01-01T00:04:30Z" })]))).toEqual([
			"☁ k3x9fa · Add Greet · 30s · turn 2 · queued",
		]);
	});

	test("a waiting row shows the first line of the question, how many more wait, and how to answer", () => {
		const t = (q: PendingQuestion) => thread("waiting", [running(1)], [event(1, { kind: "tool", text: "read a.go" })], { question: q });
		expect(lines(t(pq({ text: "\nWhich database?\nsqlite or postgres" })))).toEqual(["☁ k3x9fa · Add Greet · asks: Which database? · /cloud answer k3x9fa"]);
		expect(lines(t(pq({ remaining: 3 })))[0]).toBe("☁ k3x9fa · Add Greet · asks: Which database? (+2 more) · /cloud answer k3x9fa");
		expect(lines(t(pq({ text: "x".repeat(300) })))[0]).toContain(`asks: ${"x".repeat(99)}… · `);
	});

	test("long titles are cut to 40 characters", () => {
		expect(lines(thread("working", [running(1)], [], { title: "t".repeat(100) }))[0]).toContain(` · ${"t".repeat(39)}… · `);
	});

	test("only active threads get a row; past three they fold into one overflow row", () => {
		const active = (n: number): WidgetThread => ({ ...thread("working", [running(1)], [], { title: `job ${n}` }), id: `aaaaaa00000${n}` });
		const idle: WidgetThread = { ...thread("idle", [turn(1)]), id: "aaaaaa000099" };
		const out = lines(active(1), idle, active(2), active(3), active(4), active(5));
		expect(out).toHaveLength(WIDGET_MAX_ROWS + 1);
		expect(out.slice(0, 3).map(l => l.split(" · ")[1])).toEqual(["job 1", "job 2", "job 3"]);
		expect(out[3]).toBe("+2 more · /cloud");
		expect(lines(active(1), active(2), active(3))).toHaveLength(3);
		expect(lines(idle)).toEqual([]);
	});

	test("a thread waiting on the user is never folded into the overflow: waiting rows come first", () => {
		const active = (n: number): WidgetThread => ({ ...thread("working", [running(1)], [], { title: `job ${n}` }), id: `aaaaaa00000${n}` });
		const asking: WidgetThread = { ...thread("waiting", [running(1)], [], { title: "needs you", question: pq() }), id: "aaaaaa000009" };
		const out = lines(active(1), active(2), active(3), asking);
		expect(out[0]).toBe("☁ 000009 · needs you · asks: Which database? · /cloud answer 000009");
		expect(out.at(-1)).toBe("+1 more · /cloud");
	});
});

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

const working = (): ThreadDetail => buildDetail({ id: ID, phase: "working", title: "Add Greet", turns: [running(1)] });
const idle = (): ThreadDetail => buildDetail({ id: ID, phase: "idle", title: "Add Greet", turns: [turn(1, { title: "Added", reply: "Done." })] });
const waiting = (q: PendingQuestion): ThreadDetail => buildDetail({ id: ID, phase: "waiting", title: "Add Greet", turns: [running(1)], question: q });

interface Made {
	f: FakeHost;
	feed: Feed;
	w: Watcher;
	fetched: () => number;
	/** The detail the API answers with, per thread. */
	set(d: ThreadDetail): void;
}

function make(initial: ThreadDetail[], opts: { mode?: string; tui?: () => TuiModule | undefined; now?: () => number } = {}): Made {
	const f = fakeHost({ mode: opts.mode });
	const feed = new Feed();
	const details = new Map(initial.map(d => [d.id, d]));
	let n = 0;
	const api: WatchApi = {
		thread: async id => {
			n++;
			const d = details.get(id);
			if (!d) throw new Error(`no thread ${id}`);
			return d;
		},
		events: feed.source,
	};
	const w = new Watcher(f.host, api, undefined, { backoffMs: () => 1 }, { tui: opts.tui, now: opts.now ?? (() => NOW) });
	return { f, feed, w, fetched: () => n, set: d => void details.set(d.id, d) };
}

describe("the widget in a host without a TUI", () => {
	test("watching shows a row; progress updates it without a refetch; identical lines are not set twice", async () => {
		const { f, feed, w, fetched } = make([working()]);
		await w.watch(ID);
		expect(f.widgets).toEqual([["☁ k3x9fa · Add Greet · 2m00s · working"]]);

		feed.push(ID, event(1, { kind: "tool", text: "read Reading project plan" }));
		await until(() => f.widgets.length === 2);
		expect(lastLines(f)).toEqual(["☁ k3x9fa · Add Greet · 2m00s · read: Reading project plan"]);
		expect(fetched()).toBe(1);

		// Same text again, a kind the row ignores, and a turn that is not the current one: no widget call. The marker proves they were all processed.
		feed.push(ID, event(2, { kind: "tool", text: "read Reading project plan" }), event(3, { kind: "usage", text: "x" }), event(4, { kind: "tool", turn: 7, text: "bash other" }));
		feed.push(ID, event(5, { kind: "tool", text: "bash marker" }));
		await until(() => lastLines(f)?.[0]?.endsWith("· bash: marker") === true);
		expect(f.widgets).toHaveLength(3);
	});

	test("the widget goes the moment the last active thread finishes, and no timer is scheduled", async () => {
		const { f, feed, w, set } = make([working()]);
		await w.watch(ID);
		feed.push(ID, event(1, { kind: "tool", text: "read a.go" }));
		await until(() => f.widgets.length === 2);

		set(idle());
		feed.push(ID, event(2, { kind: "turn_done", text: "Added" }));
		await until(() => f.widgets.length === 3);
		expect(f.widgets.at(-1)).toBeUndefined();
		expect(f.timeouts).toEqual([]);
		// The reply is not in the widget at any point.
		expect(JSON.stringify(f.widgets)).not.toContain("Done.");
		expect(f.widgets).toHaveLength(3);
	});

	test("a waiting thread shows the question row, and the row is a working one again once answered", async () => {
		const { f, feed, w, set } = make([waiting(pq({ remaining: 2 }))]);
		await w.watch(ID);
		expect(lastLines(f)).toEqual(["☁ k3x9fa · Add Greet · asks: Which database? (+1 more) · /cloud answer k3x9fa"]);

		set(working());
		feed.push(ID, event(1, { kind: "question_answered" }));
		await until(() => lastLines(f)?.[0]?.endsWith("· working") === true);
	});

	test("one row per active thread; a finished one drops out and the widget stays for the rest", async () => {
		const other = (n: number): ThreadDetail => buildDetail({ id: `bbbbbb00000${n}`, phase: "working", title: `job ${n}`, turns: [running(1)] });
		const { f, feed, w, set } = make([working(), other(1), other(2), other(3)]);
		for (const id of [ID, "bbbbbb000001", "bbbbbb000002", "bbbbbb000003"]) await w.watch(id);
		expect(lastLines(f)).toHaveLength(WIDGET_MAX_ROWS + 1);
		expect(lastLines(f)?.at(-1)).toBe("+1 more · /cloud");

		set(buildDetail({ id: ID, phase: "idle", turns: [turn(1, { title: "x", reply: "y" })] }));
		feed.push(ID, event(1, { kind: "turn_done" }));
		await until(() => lastLines(f)?.length === 3);
		expect(lastLines(f)?.map(l => l.split(" · ")[1])).toEqual(["job 1", "job 2", "job 3"]);
		expect(w.watching).toEqual(["bbbbbb000001", "bbbbbb000002", "bbbbbb000003"]);
	});

	test("watching a thread that is not active leaves the widget alone and hands the thread back", async () => {
		const { f, w } = make([idle()]);
		expect((await w.watch(ID))?.id).toBe(ID);
		expect(f.widgets).toEqual([]);
		expect(f.notes).toEqual([]);
	});

	test("a session switch moves the widget to the new UI", async () => {
		const { f, w } = make([working()]);
		await w.watch(ID);
		const next = fakeHost();
		w.rebind(next.host);
		expect(lastLines(next)).toEqual(["☁ k3x9fa · Add Greet · 2m00s · working"]);
		// The same UI again is not set a second time.
		w.rebind(next.host);
		expect(next.widgets).toHaveLength(1);
		expect(f.widgets).toHaveLength(1);
	});

	test("a TUI host whose pi-tui could not be imported gets plain lines", async () => {
		const { f, w } = make([working()], { mode: "tui", tui: () => undefined });
		await w.watch(ID);
		expect(lastLines(f)).toEqual(["☁ k3x9fa · Add Greet · 2m00s · working"]);
	});
});

// ---------------------------------------------------------------------------
// The TUI widget
// ---------------------------------------------------------------------------

/** Colours show as tags, so a test can see what was styled. */
const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => t } as unknown as Theme;
const stripTags = (s: string): string => s.replace(/<\/?\w+>/g, "");

interface TuiRig extends Made {
	tui: TuiModule;
	/** `setWidget` calls with a component factory. */
	mounts: () => number;
	renders: () => number;
	/** What omp holds for the widget key: the component its factory built, until it is replaced or cleared. */
	mounted: () => (Component & { dispose?(): void }) | undefined;
	/** The rows as drawn: styled text, one per loader or text child. */
	drawn: () => string[];
	loaders: () => InstanceType<TuiModule["Loader"]>[];
}

async function tuiRig(initial: ThreadDetail[], now?: () => number): Promise<TuiRig> {
	const tui = await loadTui();
	if (!tui) throw new Error("the host pi-tui is required for the widget tests");
	const made = make(initial, { mode: "tui", tui: () => tui, now });
	let renders = 0;
	let mounts = 0;
	let mounted: (Component & { dispose?(): void }) | undefined;
	const ui = { requestRender: () => void renders++, requestComponentRender: () => {}, synchronizedOutput: false, lastFrameCostMs: 0 } as unknown as TUI;
	// What omp does: dispose the widget a key held before setting or clearing it.
	made.f.host.ui.setWidget = (_key, content) => {
		made.f.widgets.push(content);
		mounted?.dispose?.();
		mounted = undefined;
		if (typeof content === "function") {
			mounted = content(ui, theme);
			mounts++;
		}
	};
	return {
		...made,
		tui,
		mounts: () => mounts,
		renders: () => renders,
		mounted: () => mounted,
		drawn: () =>
			(mounted?.render(200) ?? [])
				.map(l => l.trim())
				.filter(l => l !== ""),
		loaders: () => (mounted as InstanceType<TuiModule["Container"]> | undefined)?.children.filter(c => c instanceof tui.Loader) ?? [],
	};
}

// ---------------------------------------------------------------------------
// The TUI widget on a native (Tern) surface: one `agent` node per row
// ---------------------------------------------------------------------------

const cx = { cols: 100, supports: () => true } as unknown as DescribeContext;
function describeOf(c: { describe?(cx: DescribeContext): NativeNode | null } | undefined): NativeNode {
	const described = c?.describe?.(cx);
	if (!described) throw new Error("the component describes nothing");
	return described;
}
interface AgentView {
	k: string;
	key: string;
	p: Record<string, unknown>;
	c: { k: string; p: { spans?: { t: string; s?: string }[] } }[];
}
/** The node's JSON shape for assertions: `NativeNode` is a union too wide to read props from. */
const agentOf = (n: NativeNode): AgentView => n as unknown as AgentView;
const childTexts = (n: NativeNode): string[] => agentOf(n).c.map(c => (c.p.spans ?? []).map(s => s.t).join(""));

describe("the widget on a native (Tern) surface", () => {
	test("a working row is an agent node with the thread's name, task, status, model, running tool and clocks", async () => {
		const r = await tuiRig([working()]);
		await r.w.watch(ID);
		try {
			r.feed.push(ID, event(1, { kind: "tool", text: "read Reading project plan", at: "2026-01-01T00:04:30Z" }), event(2, { kind: "tool", text: "bash ls -la", at: "2026-01-01T00:04:40Z" }));
			await until(() => r.loaders().length === 1 && agentOf(describeOf(r.loaders()[0])).p.tool !== null);
			const n = agentOf(describeOf(r.loaders()[0]));
			expect(n.k).toBe("agent");
			expect(n.key).toBe(ID);
			expect(n.p).toMatchObject({ name: "k3x9fa", agent: "cloud", task: "Add Greet", status: "running", model: "anthropic/claude-sonnet-5-5", thinking: "thinkingHigh" });
			expect(n.p.tool).toEqual({ name: "bash", intent: "ls -la", age: 20_000 });
			expect(n.p.stats).toEqual({ tools: 2, age: 120_000 });
			expect(n.p.badges).toBeUndefined();
			// The running tool is the activity: nothing repeats it as a child.
			expect(n.c).toEqual([]);
		} finally {
			r.w.unwatch();
		}
	});

	test("a revisit returns the same node, even as the clock moves; a progress event replaces it", async () => {
		let t = NOW;
		const r = await tuiRig([working()], () => t);
		await r.w.watch(ID);
		try {
			const row = r.loaders()[0];
			const first = describeOf(row);
			expect(describeOf(row)).toBe(first);
			// Time passing alone must not rebuild: Tern counts the ages itself, a new node would restart them.
			t += 30_000;
			expect(describeOf(row)).toBe(first);

			r.feed.push(ID, event(1, { kind: "tool", text: "read Reading project plan", at: "2026-01-01T00:05:20Z" }));
			await until(() => describeOf(row) !== first);
			const next = agentOf(describeOf(row));
			expect(next.p.tool).toEqual({ name: "read", intent: "Reading project plan", age: 10_000 });
			expect(next.p.stats).toEqual({ tools: 1, age: 150_000 });
			expect(r.mounts()).toBe(1);

			// A reply is not a tool: the tool slot empties and the first line shows as the child.
			r.feed.push(ID, event(2, { kind: "assistant", text: "\nThe plan has four phases.\nmore" }));
			await until(() => agentOf(describeOf(row)).p.tool === null);
			expect(childTexts(describeOf(row))).toEqual(["The plan has four phases."]);
			expect(agentOf(describeOf(row)).p.stats).toMatchObject({ tools: 1 });
		} finally {
			r.w.unwatch();
		}
	});

	test("a failing tool is badged; a waiting row has the warning badge and the question as children", async () => {
		const r = await tuiRig([working()]);
		await r.w.watch(ID);
		try {
			r.feed.push(ID, event(1, { kind: "tool_error", text: "read: ENOENT a.go" }));
			await until(() => agentOf(describeOf(r.loaders()[0])).p.badges !== undefined);
			expect(agentOf(describeOf(r.loaders()[0])).p.badges).toEqual([{ text: "tool failed", tone: "error" }]);

			r.set(waiting(pq({ text: "Which database?\nsqlite or postgres", remaining: 2 })));
			r.feed.push(ID, event(2, { kind: "question_asked" }));
			await until(() => r.mounts() === 2);
			const n = describeOf(r.loaders()[0]);
			expect(agentOf(n).p.status).toBe("running");
			expect(agentOf(n).p.tool).toBeNull();
			expect(agentOf(n).p.badges).toEqual([{ text: "waiting for you", tone: "warning" }]);
			expect(childTexts(n)).toEqual(["Which database?\nsqlite or postgres (+1 more)", "/cloud answer k3x9fa"]);
			expect(agentOf(n).c[0]?.p.spans?.[0]?.s).toBe("warning");
		} finally {
			r.w.unwatch();
		}
	});

	test("a thread still starting is pending and shows its vm activity as the child; a queued turn is pending too", async () => {
		const queued = turn(1, { state: "queued", startedAt: "", queuedAt: "2026-01-01T00:04:00Z" });
		const starting = buildDetail({ id: ID, phase: "starting", title: "Add Greet", turns: [queued] });
		const r = await tuiRig([starting]);
		await r.w.watch(ID);
		try {
			const row = r.loaders()[0];
			expect(agentOf(describeOf(row)).p).toMatchObject({ status: "pending", stats: { age: 60_000 } });
			expect(childTexts(describeOf(row))).toEqual(["preparing the VM"]);
			r.feed.push(ID, event(1, { kind: "vm", turn: null, text: "building the omp 18.12.3 VM template" }));
			await until(() => childTexts(describeOf(row))[0] === "building the omp 18.12.3 VM template");
			expect(agentOf(describeOf(row)).p.status).toBe("pending");
		} finally {
			r.w.unwatch();
		}
	});

	test("the overflow row still describes as text", async () => {
		const ids = ["bbbbbb000001", "bbbbbb000002", "bbbbbb000003", ID];
		const r = await tuiRig(ids.map(id => buildDetail({ id, phase: "working", title: id, turns: [running(1)] })));
		for (const id of ids) await r.w.watch(id);
		try {
			const last = (r.mounted() as InstanceType<TuiModule["Container"]>).children.at(-1); // the widget is the Container the factory built
			expect(JSON.stringify(describeOf(last))).toContain("+1 more · /cloud");
		} finally {
			r.w.unwatch();
		}
	});
});

describe("the widget in a TUI", () => {
	test("the factory builds one spinner row per thread; a progress event changes the text and repaints without a remount", async () => {
		const r = await tuiRig([working()]);
		await r.w.watch(ID);
		try {
			expect(r.mounts()).toBe(1);
			expect(r.loaders()).toHaveLength(1);
			await until(() => r.drawn().length === 1);
			expect(r.drawn()[0]).toContain("<accent>☁ k3x9fa</accent>");
			expect(stripTags(r.drawn()[0] ?? "")).toEndWith("☁ k3x9fa · Add Greet · 2m00s · working");
			const repaints = r.renders();

			r.feed.push(ID, event(1, { kind: "tool", text: "read Reading project plan" }));
			await until(() => stripTags(r.drawn()[0] ?? "").endsWith("· read: Reading project plan"));
			expect(r.mounts()).toBe(1);
			expect(r.f.widgets).toHaveLength(1);
			expect(r.renders()).toBeGreaterThan(repaints);
			expect(r.fetched()).toBe(1);
			expect(r.drawn()[0]).toContain("<muted>read: Reading project plan</muted>");

			r.feed.push(ID, event(2, { kind: "tool_error", text: "read: ENOENT a.go" }));
			await until(() => (r.drawn()[0] ?? "").includes("<error>read: ENOENT a.go</error>"));
			expect(r.mounts()).toBe(1);
		} finally {
			r.w.unwatch();
		}
	});

	test("a question turns the row into a `?` row with exactly one remount that disposes the old loader", async () => {
		const r = await tuiRig([working()]);
		await r.w.watch(ID);
		try {
			const [first] = r.loaders();
			expect(first?.debugState().running).toBe(true);

			r.set(waiting(pq()));
			r.feed.push(ID, event(1, { kind: "question_asked" }));
			await until(() => r.mounts() === 2);
			await until(() => stripTags(r.drawn()[0] ?? "").includes("asks: Which database?"));
			expect(first?.debugState().running).toBe(false);
			expect(r.drawn()[0]).toContain("<warning>?</warning>");
			expect(r.drawn()[0]).toContain("<warning>asks: Which database?</warning>");
			expect(stripTags(r.drawn()[0] ?? "")).toEndWith("/cloud answer k3x9fa");

			// More progress on the waiting thread repaints; it does not remount.
			r.feed.push(ID, event(2, { kind: "assistant", text: "waiting for you" }), event(3, { kind: "turn_started" }));
			await until(() => r.fetched() >= 3);
			await until(() => r.feed.of(ID)[0]?.queue.length === 0);
			expect(r.mounts()).toBe(2);

			// Answered: the row is a spinner again, one more remount.
			r.set(working());
			r.feed.push(ID, event(4, { kind: "question_answered" }));
			await until(() => r.mounts() === 3);
			expect(r.drawn()[0]).not.toContain("<warning>?</warning>");
		} finally {
			r.w.unwatch();
		}
	});

	test("rows beyond the cap draw as one muted line; the widget is cleared and every loader stopped when the last thread finishes", async () => {
		const ids = ["bbbbbb000001", "bbbbbb000002", "bbbbbb000003", ID];
		const all = ids.map(id => buildDetail({ id, phase: "working", title: `job ${id.slice(-1)}`, turns: [running(1)] }));
		const r = await tuiRig(all);
		for (const id of ids) await r.w.watch(id);
		try {
			// Every watch changes the structure until the cap is reached; the fourth thread only adds the overflow row.
			expect(r.loaders()).toHaveLength(WIDGET_MAX_ROWS);
			await until(() => r.drawn().length === WIDGET_MAX_ROWS + 1);
			expect(r.drawn().at(-1)).toBe("<muted>+1 more · /cloud</muted>");
			// Rows stack: no blank line between them (omp itself puts one spacer above the widget).
			expect(r.mounted()?.render(200).filter(l => l.trim() === "")).toEqual([]);
			const loaders = r.loaders();

			for (const d of all) {
				r.set(buildDetail({ id: d.id, phase: "idle", turns: [turn(1, { title: "x", reply: "y" })] }));
				r.feed.push(d.id, event(1, { kind: "turn_done" }));
			}
			await until(() => r.f.widgets.at(-1) === undefined);
			expect(r.mounted()).toBeUndefined();
			for (const l of loaders) expect(l.debugState().running).toBe(false);
			expect(r.f.timeouts).toEqual([]);
			expect(r.w.watching).toEqual([]);
		} finally {
			r.w.unwatch();
		}
	});

	test("unwatch disposes the loaders", async () => {
		const r = await tuiRig([working()]);
		await r.w.watch(ID);
		const loaders = r.loaders();
		expect(loaders).toHaveLength(1);
		r.w.unwatch();
		expect(r.f.widgets.at(-1)).toBeUndefined();
		expect(loaders[0]?.debugState().running).toBe(false);
	});
});
