import type { DescribeContext, NativeNode, TUI } from "@oh-my-pi/pi-tui";
import type { TuiModule } from "./cards";
import { shortName, VERBS, verbHelp } from "./commands";
import { follow, LIFECYCLE_KINDS, wallClock, type Clock, type EventSource, type Follower, type FollowOptions } from "./events";
import { clip, formatDuration, pushedText, threadHeading, threadTag } from "./format";
import type { CloudAgents } from "./cloud-agents";
import type { CloudJobs, JobSettled } from "./cloud-jobs";
import { CloudError } from "./errors";
import type { Host, PendingQuestion, ThreadDetail, ThreadEvent, ThreadResult, ThreadTurn } from "./types";
import { isActive, Waits } from "./wait";

export const WIDGET_KEY = "omp-cloud";
/** Rows the live widget shows before the rest fold into one `+N more` row. */
export const WIDGET_MAX_ROWS = 3;
/** Events kept per watched thread: the live widget needs the latest one, a turn card up to 20. */
const KEEP_EVENTS = 30;

export function resultLine(r: ThreadResult | null): string {
	if (!r) return "result: none yet";
	const pushed = r.pushed ? pushedText(r) : r.pushError ? `push failed: ${clip(r.pushError, 80)}` : "not pushed";
	return `result: ${r.branch} @ ${r.head.slice(0, 8)} (+${r.insertions} −${r.deletions}, ${r.filesChanged} files, ${pushed})`;
}

export function helpLines(): string[] {
	const usage: Record<string, string> = {
		new: "/cloud [new] <task>",
		list: "/cloud list",
		show: "/cloud show <id>",
		watch: "/cloud watch <id>",
		unwatch: "/cloud unwatch",
		send: "/cloud send <id> <message>",
		answer: "/cloud answer <id> [text]",
		stop: "/cloud stop <id>",
		pull: "/cloud pull <id>",
		preview: "/cloud preview <id> <port>",
		resume: "/cloud resume <id>",
		delete: "/cloud delete <id>",
		login: "/cloud login <provider>",
		status: "/cloud status",
		update: "/cloud update",
		dashboard: "/cloud dashboard",
		connect: "/cloud connect [<code|host>] [--name n]",
		pair: "/cloud pair",
		devices: "/cloud devices [revoke <name>]",
		disconnect: "/cloud disconnect [--force]",
		help: "/cloud help",
	};
	return ["☁ omp-cloud — /cloud with no arguments opens the hub; <id> is a thread's id, its last 6 characters or a word its name starts with", ...VERBS.map(v => `${(usage[v] ?? v).padEnd(28)} ${verbHelp(v)}`)];
}

/** Footer status text: `☁ 2 working · 1 waiting · 3 unread · update ready`; each part only when there is something; `☁ 3 unread` when nothing runs. `update` is the owner's: a newer omp-cloud is downloaded and waits for a click. */
export function statusText(working: number, waiting: number, unread = 0, update = false): string | undefined {
	const parts: string[] = [];
	if (working > 0 || waiting > 0) parts.push(`${working} working`);
	if (waiting > 0) parts.push(`${waiting} waiting`);
	if (unread > 0) parts.push(`${unread} unread`);
	if (update) parts.push("update ready");
	return parts.length === 0 ? undefined : `☁ ${parts.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// Live widget rows
// ---------------------------------------------------------------------------

export type RowKind = "working" | "starting" | "queued" | "waiting";
export type Tone = "accent" | "muted" | "warning" | "error";
type Segment = readonly [tone: Tone | undefined, text: string];

/** One active watched thread, as the widget shows it. */
export interface WidgetRow {
	id: string;
	kind: RowKind;
	short: string;
	/** The title cut for one line. */
	title: string;
	/** The full title (the native row's task). */
	task: string;
	/** Epoch ms since which the thread has been in this state; NaN when unknown. */
	since: number;
	/** The active turn's id; shown only above 1. */
	turn: number;
	/** The latest activity of the current turn, or the first line of the pending question. */
	text: string;
	/** The activity is a `tool_error`. */
	error: boolean;
	/** Questions waiting behind the one shown. */
	more: number;
	/** The pending question in full; empty unless waiting. */
	question: string;
	model: string;
	thinking: string;
	/** The latest activity is a tool call: its name and intent, and when it happened (NaN when unknown). */
	tool?: { name: string; intent: string; at: number };
	/** Tool calls of the current turn seen so far. */
	tools: number;
	/** `seq` of the event the activity came from; 0 when there is none. */
	seq: number;
}

export interface WidgetModel {
	rows: WidgetRow[];
	/** Active threads beyond {@link WIDGET_MAX_ROWS}. */
	overflow: number;
}

/** What the widget needs of a watched thread. */
export interface WidgetThread {
	id: string;
	detail: ThreadDetail;
	events: readonly ThreadEvent[];
}

const ACTIVITY_KINDS: ReadonlySet<string> = new Set(["tool", "tool_error", "assistant", "notice", "vm"]);

function splitTool(text: string): { name: string; intent: string } {
	const space = text.indexOf(" ");
	return space > 0 ? { name: text.slice(0, space), intent: text.slice(space + 1) } : { name: text, intent: "" };
}

/**
 * The runner's `vm` texts as a live line says them: the sandbox id and omp's pid matter in a turn card's event
 * list, not while watching. Texts it does not know pass through.
 */
const VM_ACTIVITY: readonly (readonly [RegExp, string])[] = [
	[/^sandbox \S+ created$/, "preparing the VM"],
	[/^omp started \(pid \d+\)$/, "omp started"],
	[/^resumed$/, "VM resumed"],
	[/^paused$/, "VM paused"],
];

function activityText(e: ThreadEvent): string {
	const text = e.text.trim();
	if (e.kind === "assistant") return clip(text.split("\n")[0] ?? "", 80);
	if (e.kind === "tool") {
		const { name, intent } = splitTool(text);
		return clip(intent === "" ? name : `${name}: ${intent}`, 80);
	}
	if (e.kind === "vm") return clip(VM_ACTIVITY.find(([pattern]) => pattern.test(text))?.[1] ?? text, 80);
	return clip(text, 80);
}

/** The newest progress event of `turn` (or of no turn at all) that has something to show. */
function latestActivity(events: readonly ThreadEvent[], turn: number | undefined): { text: string; event: ThreadEvent } | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (!e || !ACTIVITY_KINDS.has(e.kind) || (e.turn !== null && e.turn !== turn)) continue;
		const text = activityText(e);
		if (text !== "") return { text, event: e };
	}
	return undefined;
}

function parseTime(...stamps: (string | undefined)[]): number {
	for (const s of stamps) {
		const ms = s ? Date.parse(s) : Number.NaN;
		if (!Number.isNaN(ms)) return ms;
	}
	return Number.NaN;
}

function widgetRow(t: WidgetThread): WidgetRow {
	const d = t.detail;
	const running = d.turns.find(x => x.state === "running");
	const current = running ?? d.turns.find(x => x.state === "queued");
	const activity = latestActivity(t.events, current?.id);
	const tool = activity?.event.kind === "tool" ? { ...splitTool(activity.event.text.trim()), at: parseTime(activity.event.at) } : undefined;
	const base = {
		id: t.id,
		short: shortName(t.id),
		title: threadHeading(d, 40),
		task: threadHeading(d, 200),
		turn: current?.id ?? 0,
		error: false,
		more: 0,
		question: "",
		model: d.model,
		thinking: d.thinking,
		tool,
		tools: t.events.filter(e => e.kind === "tool" && (e.turn === null || e.turn === current?.id)).length,
		seq: activity?.event.seq ?? 0,
	};
	const since = parseTime(running?.startedAt, current?.queuedAt, d.createdAt);
	if (d.phase === "waiting" && d.question) {
		const first = clip(d.question.text.split("\n").find(l => l.trim() !== "") ?? "", 100);
		return { ...base, kind: "waiting", since, text: first, more: Math.max(0, d.question.remaining - 1), question: d.question.text.trim().slice(0, 500) };
	}
	if (!running && current && d.phase !== "starting") return { ...base, kind: "queued", since, text: "queued" };
	const starting = !running && d.phase === "starting";
	return { ...base, kind: starting ? "starting" : "working", since, text: activity?.text ?? (starting ? "preparing the VM" : "working"), error: activity?.event.kind === "tool_error" };
}

/** One row per active thread, waiting ones first (they need the user), the first {@link WIDGET_MAX_ROWS} of them; the rest count as overflow. */
export function widgetModel(threads: Iterable<WidgetThread>): WidgetModel {
	const rows = [...threads].filter(t => isActive(t.detail)).map(widgetRow);
	rows.sort((a, b) => Number(b.kind === "waiting") - Number(a.kind === "waiting"));
	return { rows: rows.slice(0, WIDGET_MAX_ROWS), overflow: Math.max(0, rows.length - WIDGET_MAX_ROWS) };
}

const SEPARATOR: Segment = ["muted", " · "];

/** The row as styled pieces; the pieces' texts joined are its plain form. */
export function rowSegments(row: WidgetRow, now: number): Segment[] {
	const head: Segment = ["accent", `☁ ${row.short}`];
	const parts: Segment[] =
		row.kind === "waiting"
			? [head, [undefined, row.title], ["warning", `asks: ${row.text}${row.more > 0 ? ` (+${row.more} more)` : ""}`], ["muted", `/cloud answer ${row.short}`]]
			: [
					head,
					[undefined, row.title],
					["muted", formatDuration(now - row.since)],
					["muted", row.turn > 1 ? `turn ${row.turn}` : ""],
					[row.error ? "error" : "muted", row.text],
				];
	const out: Segment[] = [];
	for (const part of parts) {
		if (part[1] === "") continue;
		if (out.length > 0) out.push(SEPARATOR);
		out.push(part);
	}
	return out;
}

export function rowText(row: WidgetRow, now: number): string {
	return rowSegments(row, now)
		.map(s => s[1])
		.join("");
}

/** omp's thinking-level token for the model chip's dot (the one omp's own subagent rows use). */
export function thinkingToken(level: string): string | undefined {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
		case "max":
			return "thinkingXhigh";
		default:
			return undefined;
	}
}

/**
 * The row as a native (TSP) `agent` node, the one omp draws for its own subagents, so a cloud thread
 * looks like one in Tern. The terminal counts `stats.age` and `tool.age` itself from the ages given here.
 */
function nativeRow(tui: TuiModule, row: WidgetRow, now: number): NativeNode {
	const waiting = row.kind === "waiting";
	const children: NativeNode[] = [];
	if (waiting) {
		children.push(
			tui.text([tui.span(`${row.question}${row.more > 0 ? ` (+${row.more} more)` : ""}`, "warning")], { wrap: "word" }),
			tui.text([tui.span(`/cloud answer ${row.short}`, "dim")]),
		);
	} else if (!row.tool && (row.seq > 0 || row.kind !== "working")) {
		children.push(tui.text([tui.span(row.text, "dim")], { wrap: "none" }));
	}
	const badges: { text: string; tone: "warning" | "error" }[] = [];
	if (waiting) badges.push({ text: "waiting for you", tone: "warning" });
	if (row.error) badges.push({ text: "tool failed", tone: "error" });
	return tui.node(
		"agent",
		{
			name: row.short,
			agent: "cloud",
			task: row.task,
			status: row.kind === "working" || waiting ? "running" : "pending",
			model: row.model || undefined,
			thinking: thinkingToken(row.thinking),
			tool: row.tool && !waiting ? { name: row.tool.name, intent: clip(row.tool.intent, 200) || undefined, age: Number.isFinite(row.tool.at) ? Math.max(0, now - row.tool.at) : undefined } : null,
			stats: { tools: row.tools || undefined, age: Number.isFinite(row.since) ? Math.max(0, now - row.since) : undefined },
			badges: badges.length > 0 ? badges : undefined,
		},
		children,
		row.id,
	);
}

export function overflowText(overflow: number): string {
	return `+${overflow} more · /cloud`;
}

/** The widget as plain lines (hosts without a TUI). */
export function widgetLines(model: WidgetModel, now: number): string[] {
	const lines = model.rows.map(r => rowText(r, now));
	if (model.overflow > 0) lines.push(overflowText(model.overflow));
	return lines;
}

/** What a TUI widget is built from: the ordered rows with their spinner or `?` kind, and the overflow count. A change remounts the widget; anything else only repaints it. */
function structureKey(model: WidgetModel): string {
	return `${model.rows.map(r => `${r.id}:${r.kind === "waiting" ? "?" : "spin"}`).join("|")}|+${model.overflow}`;
}

/** Where finished turns and new questions go; the extension posts them as transcript cards or, for a person's own threads, into the inbox. */
export interface WatchSink {
	/** `relayed`: the turn's reply is on its way to the agent that woke the thread, which is its delivery. */
	turn(host: Host, thread: ThreadDetail, turn: ThreadTurn, events: ThreadEvent[], job?: JobSettled, relayed?: boolean): void;
	question(host: Host, thread: ThreadDetail, q: PendingQuestion): void;
	/** Whether finished turns and questions of `thread` go to the inbox: the watcher then raises no toast for them. */
	tray?(host: Host, thread: string): boolean;
	/** The thread has no open question (it was answered, or never asked one). */
	answered?(thread: string): void;
	/** The service no longer has the thread: whatever it reported is moot, and a model that started it must hear that. `job` is the host job that stood for it. */
	gone?(host: Host, thread: ThreadDetail, job?: JobSettled): void;
	/** The session lost contact with the thread and has stopped expecting it back soon; it keeps trying. */
	lost?(host: Host, thread: ThreadDetail): void;
	/** Called after every refresh so held-back cards appear once the local agent is idle. */
	flush?(host: Host): void;
	/** Every refetched thread, before its turns and question are announced. */
	refreshed?(thread: ThreadDetail): void;
}

export interface WatchApi {
	thread(id: string, opts?: { signal?: AbortSignal }): Promise<ThreadDetail>;
	events: EventSource;
}

interface Watched {
	id: string;
	events: ThreadEvent[];
	/** Turn ids whose completion was already reported. */
	reported: Set<number>;
	/** `<turn>:<question id>` of questions already announced. */
	asked: Set<string>;
	detail: ThreadDetail;
	follower?: Follower;
	refreshing: boolean;
	/** A lifecycle event arrived during a refresh: refresh once more. */
	again: boolean;
	closed: boolean;
	/** The session has lost contact with the thread: its job says so, and a waiter reads `stale`. */
	stale: boolean;
}

/**
 * Follows watched threads over their event streams while they are starting, working or waiting,
 * keeps the live `omp-cloud` widget (one row per active thread, gone when none is) and the footer
 * status current, refetches the thread on each lifecycle event, and reports each finished turn
 * and each new question once.
 */
export class Watcher {
	#host: Host;
	readonly #api: WatchApi;
	readonly #sink: WatchSink | undefined;
	readonly #followOptions: FollowOptions;
	readonly #getTui: () => TuiModule | undefined;
	readonly #now: () => number;
	readonly #watched = new Map<string, Watched>();
	readonly #clock: Clock;
	/** Waiting for threads: the watcher tells it what the streams show. */
	readonly waits: Waits;
	#model: WidgetModel = { rows: [], overflow: 0 };
	/** Where a running turn is registered as a job of the host; undefined when the host has no jobs. */
	readonly #jobs: CloudJobs | undefined;
	/** The cloud agents the threads are in omp's registry as: their results are published and relayed as turns end. */
	readonly #agents: CloudAgents | undefined;
	/** The inbox's unread count, shown in the footer status. */
	readonly #unread: (() => number) | undefined;
	/** Whether an update of the service is ready for the owner to install, shown in the footer status. */
	readonly #update: (() => boolean) | undefined;
	/** What the widget slot currently holds: a TUI structure key or the joined lines; undefined when it is empty. */
	#shown: string | undefined;
	/** The TUI the mounted widget was built for. */
	#ui: TUI | undefined;

	constructor(host: Host, api: WatchApi, sink?: WatchSink, followOptions: FollowOptions = {}, opts: { tui?: () => TuiModule | undefined; now?: () => number; jobs?: CloudJobs; agents?: CloudAgents; unread?: () => number; update?: () => boolean } = {}) {
		this.#host = host;
		this.#api = api;
		this.#sink = sink;
		this.#followOptions = followOptions;
		this.#clock = followOptions.clock ?? wallClock;
		this.#getTui = opts.tui ?? (() => undefined);
		this.#now = opts.now ?? (() => this.#clock.now());
		this.#jobs = opts.jobs;
		this.#agents = opts.agents;
		this.#unread = opts.unread;
		this.#update = opts.update;
		this.waits = new Waits({ clock: this.#clock, followed: id => this.followed(id), fetch: (id, signal) => this.#api.thread(id, { signal }) });
	}

	get watching(): string[] {
		return [...this.#watched.keys()];
	}

	/** A thread this session follows: what the watcher last saw of it, and whether contact with it is lost. Undefined when it is not followed. */
	followed(id: string): { detail: ThreadDetail; stale: boolean } | undefined {
		const w = this.#watched.get(id);
		return w ? { detail: w.detail, stale: w.stale } : undefined;
	}

	/** Point the watcher at the host of the next command, or of a new session after `switchSession`. */
	rebind(host: Host): void {
		const moved = host.ui !== this.#host.ui;
		this.#host = host;
		if (!moved) return;
		// The new UI holds none of our widget.
		this.#shown = undefined;
		this.#ui = undefined;
		this.#renderWidget();
	}

	/** Follows `id` while it is active. A thread with nothing to follow is returned for the caller to show (the watcher never prints); null while following. */
	async watch(id: string): Promise<ThreadDetail | null> {
		const detail = await this.#api.thread(id);
		this.#agents?.observe(detail);
		const old = this.#watched.get(id);
		this.#close(old);
		const w: Watched = {
			id,
			events: [],
			reported: new Set(detail.turns.filter(t => t.state !== "queued" && t.state !== "running").map(t => t.id)),
			asked: new Set(),
			detail,
			refreshing: false,
			again: false,
			closed: false,
			stale: false,
		};
		this.#announceQuestion(w, detail);
		this.waits.observe({ id, state: "detail", detail });
		if (!isActive(detail)) {
			// The turn the thread's job stood for may have ended while the follower that would have settled it was being replaced.
			for (const turn of detail.turns) {
				const job = this.#jobs?.settle(detail, turn);
				if (job && (turn.state === "done" || turn.state === "failed")) this.#sink?.turn(this.#host, detail, turn, old?.events ?? [], job, this.#agents?.relayed(id, turn.id));
			}
			this.#jobs?.finish(detail);
			this.#watched.delete(id);
			this.#renderWidget();
			this.refreshStatus();
			return detail;
		}
		this.#watched.set(id, w);
		// The fetch above is contact: a job the old follower marked stale is not any more.
		if (old?.stale) this.#jobs?.markStale(detail, w.events, false);
		this.#jobs?.sync(detail, w.events);
		this.#renderWidget();
		this.refreshStatus();
		w.follower = follow(
			(tid, o) => this.#api.events(tid, o),
			id,
			{
				onEvent: e => this.#onEvent(w, e),
				onGiveUp: () => this.#gone(w),
				onStale: e => this.#lose(w, e),
				onRecover: () => this.#regain(w),
			},
			this.#followOptions,
		);
		return null;
	}

	/** Stops following and clears the widget and the footer status. */
	unwatch(): void {
		this.#jobs?.releaseAll();
		for (const w of this.#watched.values()) this.#close(w);
		this.#watched.clear();
		this.#shown = undefined;
		this.#ui = undefined;
		this.#host.ui.setWidget(WIDGET_KEY, undefined);
		this.refreshStatus();
	}

	/** Stops following one thread that was deleted on purpose: its job is released and nobody is told. Waiters on it read `deleted`. */
	forget(id: string): void {
		const w = this.#watched.get(id);
		this.#jobs?.release(id);
		this.#agents?.release(id);
		if (w) {
			this.#close(w);
			this.#watched.delete(id);
			this.#renderWidget();
			this.refreshStatus();
		}
		this.waits.observe({ id, state: "gone" });
	}

	#close(w: Watched | undefined): void {
		if (!w) return;
		w.closed = true;
		w.follower?.stop();
	}

	/** Brings the widget slot in line with the watched threads: removed when none is active, else rows in the TUI or plain lines. */
	#renderWidget(): void {
		const model = widgetModel([...this.#watched.values()].filter(w => !this.#jobs?.has(w.id)));
		if (model.rows.length === 0) {
			if (this.#shown === undefined) return;
			this.#shown = undefined;
			this.#ui = undefined;
			this.#host.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		this.#model = model;
		const tui = this.#host.mode === "tui" ? this.#getTui() : undefined;
		if (!tui) {
			const lines = widgetLines(model, this.#now());
			const key = lines.join("\n");
			if (key === this.#shown) return;
			this.#shown = key;
			this.#host.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
			return;
		}
		const key = structureKey(model);
		if (key === this.#shown) {
			this.#ui?.requestRender();
			return;
		}
		this.#shown = key;
		this.#host.ui.setWidget(
			WIDGET_KEY,
			(ui, theme) => {
				this.#ui = ui;
				const root = new tui.Container();
				// A Loader opens with a blank line (it spaces omp's own working row); omp already puts a spacer above
				// widgets, so rows here drop it and stack. The subclass also describes itself natively (Tern): the Loader
				// would flatten the message to one muted span, and its clock freezes between events there.
				const now = this.#now;
				const mod: TuiModule = tui;
				class Row extends tui.Loader {
					readonly #current: () => WidgetRow | undefined;
					#node: NativeNode | undefined;
					#key = "";
					constructor(ui: TUI, current: () => WidgetRow | undefined, waiting: boolean) {
						// Reads the live model on every frame, so the elapsed time ticks without a timer of ours.
						const message = (): string => {
							const row = current();
							return row
								? rowSegments(row, now())
										.map(([tone, text]) => (tone ? theme.fg(tone, text) : text))
										.join("")
								: "";
						};
						super(ui, s => theme.fg(waiting ? "warning" : "accent", s), s => s, message, waiting ? ["?"] : undefined);
						this.#current = current;
					}
					override render(width: number): readonly string[] {
						const lines = super.render(width);
						return lines[0] === "" ? lines.slice(1) : lines;
					}
					/** The same node object until the row's content other than its clock changes, so a revisit does not reset the terminal's clock. */
					override describe(cx: DescribeContext): NativeNode {
						const row = this.#current();
						if (!row) return this.#node ?? super.describe(cx);
						const at = now();
						// Everything but the clocks is in the row, so a revisit keeps the node and Tern keeps counting the ages itself.
						const key = JSON.stringify(row);
						if (key !== this.#key || !this.#node) {
							this.#key = key;
							this.#node = nativeRow(mod, row, at);
						}
						return this.#node;
					}
				}
				for (const { id, kind } of this.#model.rows) {
					root.addChild(new Row(ui, () => this.#model.rows.find(r => r.id === id), kind === "waiting"));
				}
				if (this.#model.overflow > 0) root.addChild(new tui.Text(theme.fg("muted", overflowText(this.#model.overflow)), 1, 0));
				return root;
			},
			{ placement: "aboveEditor" },
		);
	}

	/** Recomputes the footer status from the watched threads and the inbox's unread count. */
	refreshStatus(): void {
		const active = [...this.#watched.values()].filter(w => isActive(w.detail));
		const waiting = active.filter(w => w.detail.phase === "waiting").length;
		// A turn that is a job of the host shows in omp's own job surfaces; the footer still says what waits for the user.
		const working = active.filter(w => w.detail.phase !== "waiting" && !this.#jobs?.has(w.id)).length;
		this.#host.ui.setStatus(WIDGET_KEY, statusText(working, waiting, this.#unread?.() ?? 0, this.#update?.() ?? false));
	}

	/** One notification and one question card per question. */
	#announceQuestion(w: Watched, detail: ThreadDetail): void {
		const q = detail.question;
		if (!q) {
			this.#sink?.answered?.(detail.id);
			return;
		}
		const key = `${q.turn}:${q.id}`;
		if (w.asked.has(key)) return;
		w.asked.add(key);
		if (!this.#sink?.tray?.(this.#host, w.id)) this.#host.ui.notify(`☁ ${threadTag(detail)} asks: ${clip(q.text, 160)} — /cloud answer ${shortName(w.id)}`, "warning");
		this.#sink?.question(this.#host, detail, q);
	}

	#onEvent(w: Watched, event: ThreadEvent): void {
		if (w.closed) return;
		w.events = [...w.events, event].slice(-KEEP_EVENTS);
		this.#agents?.event(w.detail, event);
		this.#jobs?.event(w.detail, w.events, event);
		// A child's end after the turn is over is what lets an idle thread, kept followed for its children, be let go.
		if (LIFECYCLE_KINDS.has(event.kind) || (event.kind === "child_end" && !isActive(w.detail))) this.#refresh(w);
		else this.#renderWidget();
	}

	/** Refetches the thread; events arriving meanwhile cause one more refetch, never overlapping ones. */
	#refresh(w: Watched): void {
		if (w.refreshing) {
			w.again = true;
			return;
		}
		w.refreshing = true;
		void (async () => {
			try {
				do {
					w.again = false;
					await this.#apply(w);
				} while (w.again && !w.closed);
			} finally {
				w.refreshing = false;
			}
		})();
	}

	async #apply(w: Watched): Promise<void> {
		let detail: ThreadDetail;
		try {
			detail = await this.#api.thread(w.id);
		} catch (e) {
			if (e instanceof CloudError && e.code === "not_found") this.#gone(w);
			// anything else is transient: the next lifecycle event refetches
			return;
		}
		if (w.closed) return;
		w.detail = detail;
		// Before the turns are settled: their results are published and relayed first, then the job delivers.
		this.#agents?.observe(detail);
		this.#sink?.refreshed?.(detail);
		this.#clearStale(w);
		this.#announceQuestion(w, detail);
		let reportedFailure = false;
		for (const turn of detail.turns) {
			if (turn.state === "cancelled") this.#jobs?.settle(detail, turn);
			if ((turn.state !== "done" && turn.state !== "failed") || w.reported.has(turn.id)) continue;
			w.reported.add(turn.id);
			if (turn.state === "failed") reportedFailure = true;
			const what = turn.state === "failed" ? turn.error : turn.title;
			if (!this.#sink?.tray?.(this.#host, w.id)) this.#host.ui.notify(`☁ ${threadTag(detail)} turn ${turn.id} ${turn.state}${what ? `: ${clip(what, 200)}` : ""}`, turn.state === "failed" ? "error" : "info");
			this.#sink?.turn(this.#host, detail, turn, w.events, this.#jobs?.settle(detail, turn), this.#agents?.relayed(w.id, turn.id));
		}
		if (isActive(detail)) {
			this.#jobs?.sync(detail, w.events);
		} else if (!this.#jobs?.keeps(detail)) {
			// A thread whose children still run in its VM stays followed: their ends arrive on its stream, long after the turn's.
			this.#jobs?.finish(detail);
			this.#close(w);
			this.#watched.delete(w.id);
			if (detail.phase === "failed" && detail.error && !reportedFailure) this.#host.ui.notify(`☁ ${threadTag(detail)} failed: ${clip(detail.error, 200)}`, "error");
		}
		this.#renderWidget();
		this.refreshStatus();
		this.waits.observe({ id: w.id, state: "detail", detail });
		this.#sink?.flush?.(this.#host);
	}

	/** The service no longer has the thread: only this thread stops being followed, its job fails and the sink hears of it. */
	#gone(w: Watched): void {
		if (w.closed) return;
		this.#host.ui.notify(`☁ ${threadTag(w.detail)} no longer exists`, "warning");
		const job = this.#jobs?.fail(w.id, "thread was deleted");
		this.#close(w);
		this.#watched.delete(w.id);
		this.#agents?.release(w.id);
		this.#sink?.gone?.(this.#host, w.detail, job);
		this.waits.observe({ id: w.id, state: "gone" });
		this.#renderWidget();
		this.refreshStatus();
	}

	/** No contact for as long as the follower's patience: the job and the waiters say so, the model of a thread it started is told, and following goes on. */
	#lose(w: Watched, error: unknown): void {
		if (w.closed) return;
		w.stale = true;
		this.#jobs?.markStale(w.detail, w.events, true);
		this.#host.ui.notify(`☁ ${threadTag(w.detail)}: lost contact with the cloud (${clip(error instanceof Error ? error.message : String(error), 120)}); still retrying`, "warning");
		this.#sink?.lost?.(this.#host, w.detail);
		this.waits.observe({ id: w.id, state: "stale" });
		this.#sink?.flush?.(this.#host);
	}

	/** Contact with the thread is back: what happened meanwhile is fetched, so a turn that finished is reported once. */
	#regain(w: Watched): void {
		if (w.closed) return;
		this.#clearStale(w);
		this.#refresh(w);
	}

	#clearStale(w: Watched): void {
		if (!w.stale) return;
		w.stale = false;
		this.#jobs?.markStale(w.detail, w.events, false);
		this.#host.ui.notify(`☁ ${threadTag(w.detail)}: contact with the cloud is back`, "info");
	}
}
