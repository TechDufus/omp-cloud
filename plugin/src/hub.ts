/**
 * The `/cloud` hub: an overlay listing what the cloud can run and the user's threads, with the
 * selected thread's latest reply, pending question and live events. Keys act on the selected
 * thread; the overlay closes with the action and the command runs it, then reopens the hub.
 *
 * The thread list is polled (the API has no list stream); the selected thread's events arrive over
 * its event stream, and its lifecycle events refetch the list and the thread at once.
 */

import type { Component, DescribeContext, KeyId, NativeNode, NativeUiEvent, Theme } from "@oh-my-pi/pi-tui";
import { COUNT_BADGES, hoverRows, inventoryThread, nativeTile, patternProviders, type TuiModule } from "./cards";
import { shortName } from "./commands";
import { eventLines, lineLabel, lineText } from "./event-lines";
import { follow, LIFECYCLE_KINDS, type EventSource, type Follower, type FollowOptions } from "./events";
import { clip, firstLines, formatAge, metricsLine, phaseIcon, plural, threadHeading, threadTag } from "./format";
import type { Inbox } from "./inbox";
import { repoLabel } from "./repo-key";
import type { ThreadDetail, ThreadEvent, ThreadSummary, Whoami } from "./types";

export type HubAction = "send" | "answer" | "open" | "stop" | "pull" | "resume" | "delete" | "update";

export interface HubResult {
	action: HubAction;
	thread: string;
	/** The thread as notifications name it: its name (else title) and its id. */
	label: string;
}

export interface HubApi {
	whoami(): Promise<Whoami>;
	listThreads(): Promise<ThreadSummary[]>;
	thread(id: string): Promise<ThreadDetail>;
	events: EventSource;
}

export interface HubDeps {
	api: HubApi;
	theme: Pick<Theme, "fg" | "bold">;
	tui: Pick<TuiModule, "truncateToWidth" | "matchesKey" | "node" | "text" | "span" | "col" | "row" | "propNode" | "stableKey">;
	requestRender(): void;
	done(result: HubResult | undefined): void;
	now?(): number;
	pollMs?: number;
	followOptions?: FollowOptions;
	/** What the user's own threads reported while they worked elsewhere; opening a thread's detail reads it. */
	inbox: Pick<Inbox, "unread" | "unreadFor" | "read" | "keepOnly">;
}

/** Rows of the thread list shown at once. */
const LIST_ROWS = 10;
const REFRESH_WHOAMI_EVERY = 5;
const KEEP_EVENTS = 12;
/** A thread's stream that stays down this long shows its error in the hub, which keeps retrying. */
const HUB_STALE_MS = 15_000;
const KEY_ACTIONS: [KeyId, HubAction][] = [
	["s", "send"],
	["a", "answer"],
	["x", "stop"],
	["p", "pull"],
	["r", "resume"],
	["d", "delete"],
	["o", "open"],
];

/** The thread actions as buttons, in the order of the key hints. */
const HUB_BUTTONS: { act: HubAction; label: string; key: string; tone?: "accent" | "error" }[] = [
	{ act: "open", label: "Open", key: "o", tone: "accent" },
	{ act: "send", label: "Send", key: "s" },
	{ act: "answer", label: "Answer", key: "a" },
	{ act: "pull", label: "Pull", key: "p" },
	{ act: "resume", label: "Resume", key: "r" },
	{ act: "stop", label: "Stop", key: "x", tone: "error" },
	{ act: "delete", label: "Delete", key: "d", tone: "error" },
];

const HUB_ACTIONS: readonly string[] = [...HUB_BUTTONS.map(b => b.act), "update"];

function isHubAction(act: string): act is HubAction {
	return HUB_ACTIONS.includes(act);
}

/** How a thread reads in the list: waiting for the user, failed, working, parked, done. */
function threadTone(t: ThreadSummary): "warning" | "error" | "pending" | "muted" | "success" | "neutral" {
	if (t.question || t.phase === "waiting") return "warning";
	if (t.phase === "failed" || t.latest?.state === "failed") return "error";
	if (t.phase === "starting" || t.phase === "working") return "pending";
	if (t.archivedAt) return "muted";
	return t.latest?.state === "done" ? "success" : "neutral";
}

/** One thread of the list: heading, a facts line, its phase in the tone of its state and how long ago it was active. */
function threadItem(tui: HubDeps["tui"], t: ThreadSummary, unread: number, now: number): NativeNode {
	const tone = threadTone(t);
	const heading = threadHeading(t, 80) || shortName(t.id);
	const phase = t.archivedAt ? "archived" : t.question ? "question" : t.phase;
	const diff = t.result ? `+${t.result.insertions}/−${t.result.deletions}` : "";
	const facts = [shortName(t.id), `t${t.turns}`, t.latest?.state ?? "", diff].filter(f => f !== "").join(" · ");
	return tui.node(
		"item",
		{
			label: [tui.span(heading, "strong"), ...(unread > 0 ? [tui.span(`  ${unread} new`, "accent")] : [])],
			detail: [tui.span(facts, "muted")],
			value: [tui.span(phase, tone === "muted" ? "dim" : tone), tui.span(` · ${formatAge(t.lastActivityAt || t.createdAt, now)}`, "muted")],
			icon: "agent",
			tone,
			title: `${heading}\n${phase} · ${t.id}`,
			aria: `${heading}, ${phase}`,
		},
		undefined,
		t.id,
	);
}

/** The hub overlay. `start` begins polling; `dispose` (called by the host) stops it. */
export class HubComponent implements Component {
	readonly #d: HubDeps;
	#who: Whoami | undefined;
	#threads: ThreadSummary[] = [];
	#sel = 0;
	#detail: ThreadDetail | undefined;
	#events: ThreadEvent[] = [];
	#followed: { id: string; follower: Follower } | undefined;
	#error = "";
	#loaded = false;
	#running: Promise<void> | undefined;
	#again = false;
	#ticks = 0;
	#timer: Timer | undefined;
	#closed = false;
	/** Bumped whenever what the hub draws changes: the native description is rebuilt only then. */
	#version = 0;
	#native: { key: string; node: NativeNode } | undefined;

	constructor(deps: HubDeps) {
		this.#d = deps;
	}

	/** Loads once, then polls every `pollMs` (3 s). */
	start(): void {
		void this.refresh();
		this.#timer = setInterval(() => void this.refresh(), this.#d.pollMs ?? 3000);
	}

	dispose(): void {
		this.#closed = true;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#followed?.follower.stop();
		this.#followed = undefined;
	}

	invalidate(): void {}

	get selected(): ThreadSummary | undefined {
		return this.#threads[this.#sel];
	}

	/**
	 * Refreshes the cloud summary (every few polls), the threads and the selected thread's detail.
	 * A call while one is running makes it run once more afterwards, so a selection change is never dropped.
	 */
	refresh(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		this.#running = (async () => {
			do {
				this.#again = false;
				await this.#load();
			} while (this.#again && !this.#closed);
		})().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	/** Follows the selected thread's event stream; the previous thread's stream stops. */
	#followSelected(): void {
		const id = this.selected?.id;
		if (this.#followed?.id === id) return;
		this.#followed?.follower.stop();
		this.#followed = undefined;
		if (!id || this.#closed) return;
		const fail = (e: unknown): void => {
			this.#error = e instanceof Error ? e.message : String(e);
			this.#changed();
		};
		const follower = follow(
			this.#d.api.events,
			id,
			{
				onEvent: e => {
					if (this.selected?.id !== id) return;
					this.#events = [...this.#events, e].slice(-KEEP_EVENTS);
					if (LIFECYCLE_KINDS.has(e.kind)) {
						this.#version++;
						void this.refresh();
					} else this.#changed();
				},
				onGiveUp: fail,
				onStale: fail,
			},
			{ staleAfterMs: HUB_STALE_MS, ...this.#d.followOptions },
		);
		this.#followed = { id, follower };
	}

	async #load(): Promise<void> {
		try {
			const { api } = this.#d;
			if (this.#ticks++ % REFRESH_WHOAMI_EVERY === 0) this.#who = await api.whoami();
			const prev = this.selected?.id;
			this.#threads = await api.listThreads();
			// Threads the service no longer has can never be read: their entries go.
			this.#d.inbox.keepOnly(this.#threads.map(t => t.id));
			const keep = prev ? this.#threads.findIndex(t => t.id === prev) : -1;
			this.#sel = keep >= 0 ? keep : Math.min(this.#sel, Math.max(0, this.#threads.length - 1));
			const t = this.selected;
			if (t) {
				const detail = await api.thread(t.id);
				if (this.selected?.id === t.id) {
					this.#detail = detail;
					// The thread's detail is on screen: what it reported is read.
					this.#d.inbox.read(t.id);
				}
			} else {
				this.#detail = undefined;
				this.#events = [];
			}
			this.#followSelected();
			this.#error = "";
		} catch (e) {
			this.#error = e instanceof Error ? e.message : String(e);
		} finally {
			this.#loaded = true;
			this.#version++;
			if (!this.#closed) this.#d.requestRender();
		}
	}

	handleInput(data: string): void {
		const { matchesKey } = this.#d.tui;
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.#d.done(undefined);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) return this.#move(-1);
		if (matchesKey(data, "down") || matchesKey(data, "j")) return this.#move(1);
		if (matchesKey(data, "u") && this.#updateReady() !== undefined) {
			this.#run("update");
			return;
		}
		const t = this.selected;
		if (t === undefined) return;
		for (const [key, action] of KEY_ACTIONS) {
			if (matchesKey(data, key)) {
				this.#run(action);
				return;
			}
		}
	}

	/** The version waiting for the owner's click, as the last `whoami` says; undefined for a device, a service that reports no update, or nothing ready. */
	#updateReady(): string | undefined {
		const who = this.#who;
		return who && who.device === null && who.update?.state === "ready" && who.update.available !== null ? who.update.available : undefined;
	}

	#move(delta: number): void {
		this.#select(Math.max(0, Math.min(this.#threads.length - 1, this.#sel + delta)));
	}

	/** Selects the thread at `index`: its detail and event stream replace the previous thread's. */
	#select(index: number): void {
		if (index === this.#sel || index < 0 || index >= this.#threads.length) return;
		this.#sel = index;
		this.#detail = undefined;
		this.#events = [];
		this.#followSelected();
		this.#changed();
		void this.refresh();
	}

	/** Closes the hub with the action on the selected thread (`update` needs none); what a key and its button both run. */
	#run(action: HubAction): void {
		if (action === "update") {
			if (this.#updateReady() !== undefined) this.#d.done({ action: "update", thread: "", label: "" });
			return;
		}
		const t = this.selected;
		if (t) this.#d.done({ action, thread: t.id, label: threadTag(t) });
	}

	/** The state a description or a frame draws changed. */
	#changed(): void {
		this.#version++;
		this.#d.requestRender();
	}

	/**
	 * Pointer actions, which run what the keys run: a click on a thread selects it, a double click opens it, a button
	 * is its key, and Close is Esc.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select" || event.type === "activate") {
			const index = this.#threads.findIndex(t => t.id === event.item);
			if (index < 0) return;
			this.#select(index);
			if (event.type === "activate") this.#run("open");
			return;
		}
		if (event.type !== "action") return;
		if (event.act === "close") this.#d.done(undefined);
		else if (isHubAction(event.act)) this.#run(event.act);
	}

	/** The hub as native nodes: the cloud's summary, the threads as selectable items, the selected thread's tile and detail, and the actions. */
	describe(cx: DescribeContext): NativeNode {
		const key = `${this.#version}|${cx.dark}|${this.#d.inbox.unread}`;
		if (this.#native?.key === key) return this.#native.node;
		const node = this.#describeHub();
		this.#native = { key, node };
		return node;
	}

	#describeHub(): NativeNode {
		const { tui } = this.#d;
		const now = this.#d.now?.() ?? Date.now();
		const who = this.#who;
		const t = this.selected;
		const unread = this.#d.inbox.unread;
		const update = this.#updateReady();
		const rows: NativeNode[] = [
			tui.row(
				[
					tui.text([tui.span(who ? who.user : "…", "muted")], { wrap: "none" }),
					...(unread > 0 ? [tui.node("badge", { text: `${unread} unread`, tone: "accent" })] : []),
					...(update ? [tui.node("badge", { text: `update ${update} ready`, tone: "warning", title: "Press u to restart the service and install it" })] : []),
					...(who ? COUNT_BADGES.filter(b => who.threads[b.phase] > 0).map(b => tui.node("badge", { text: `${who.threads[b.phase]} ${b.phase}`, tone: b.tone })) : []),
				],
				{ gap: "sm", align: "center", wrap: true, role: "omp.cloud.hub.head" },
			),
		];
		if (who) {
			const providers = patternProviders(who.modelPatterns);
			const facts = [
				{ k: "runs", v: providers.length > 0 ? providers.join(", ") : "no providers · /cloud login <provider>" },
				{ k: "model", v: `threads run their session's model (fallback ${who.defaultModel || "none"})` },
				{ k: "omp", v: who.ompVersion || "?" },
				{ k: "VMs", v: `${who.vms.running} running · ${who.vms.paused} paused` },
			];
			rows.push(tui.node("kv", { items: facts, layout: "inline" }));
		}
		if (this.#error) rows.push(tui.text([tui.span(`! ${clip(this.#error, 200)}`, "error")], { wrap: "word", role: "omp.cloud.error" }));
		if (!this.#loaded) rows.push(tui.text([tui.span("loading…", "muted")], { wrap: "none" }));
		rows.push(
			tui.node(
				"list",
				{ selected: t?.id ?? null, empty: "no threads — hand off work with /cloud <task>", max: { lines: LIST_ROWS }, actions: { click: "select", dblclick: "activate" }, role: "omp.cloud.threads" },
				this.#threads.map(x => threadItem(tui, x, this.#d.inbox.unreadFor(x.id), now)),
				"threads",
			),
		);
		if (t) rows.push(this.#describeDetail(t, now));
		if (this.#events.length > 0) {
			rows.push(
				tui.node(
					"col",
					{ role: "omp.cloud.events", gap: "xs" },
					[
						tui.text([tui.span("Live", "muted")], { wrap: "none" }),
						...eventLines(this.#events)
							.slice(-6)
							.map(e => {
								const label = lineLabel(e);
								const spans = [...(label === undefined ? [] : [tui.span(`${label} `, "dim strong")]), tui.span(clip(e.text, 140), "dim")];
								return tui.node("text", { spans, wrap: "none", truncate: "end" }, undefined, String(e.seq));
							}),
					],
					"events",
				),
			);
		}
		rows.push(this.#describeActions(t !== undefined, update !== undefined));
		return tui.col(rows, { role: "omp.cloud.hub", gap: "md" });
	}

	/** The selected thread as its job tile, its facts, its question, and its latest turn. */
	#describeDetail(t: ThreadSummary, now: number): NativeNode {
		const { tui } = this.#d;
		const card = inventoryThread(t);
		const repo = repoLabel({ remoteURL: t.repo.remoteURL, name: t.repo.name, workspace: t.workspace });
		const parts: NativeNode[] = [tui.row([nativeTile(tui, card, repo, now, true)], { role: "omp.job.tiles", gap: "none", wrap: true }), tui.node("kv", { items: hoverRows(card, repo, now), layout: "grid" })];
		const d = this.#detail?.id === t.id ? this.#detail : undefined;
		if (d) {
			if (d.error) parts.push(tui.text([tui.span(`! ${clip(d.error, 300)}`, "error")], { wrap: "word" }));
			const q = d.question;
			if (q) {
				const head = `? ${q.header ? `${q.header}: ` : ""}${clip(q.text, 400)}${q.remaining > 1 ? ` (+${q.remaining - 1} more)` : ""}`;
				parts.push(
					tui.node(
						"col",
						{ role: "omp.cloud.ask", gap: "xs" },
						[
							tui.text([tui.span(head, "warning")], { wrap: "word" }),
							...q.options.map((o, i) => tui.text([tui.span(`${q.multi ? "[ ]" : "(•)"} ${o.label}`, "strong"), ...(q.recommended === i ? [tui.span("  recommended", "success")] : []), ...(o.description ? [tui.span(` — ${clip(o.description, 100)}`, "muted")] : [])], { wrap: "word" })),
						],
						"question",
					),
				);
			}
			const latest = [...d.turns].reverse().find(x => x.state === "done" || x.state === "failed");
			if (latest) {
				const reply = firstLines(latest.state === "failed" ? latest.error : latest.reply, 6).join("\n");
				parts.push(
					tui.node(
						"col",
						{ role: "omp.cloud.latest", gap: "xs" },
						[tui.text([tui.span(`Latest — turn ${latest.id} ${latest.state}${latest.title ? `: ${latest.title}` : ""}`, "muted")], { wrap: "word" }), ...(reply === "" ? [] : [tui.node("md", { text: reply })])],
						"latest",
					),
				);
			}
		}
		return tui.node("col", { role: "omp.cloud.detail", gap: "sm" }, parts, `detail-${t.id}`);
	}

	/** The keys as buttons; the thread's are left out with no thread, Update only when the owner can install one. */
	#describeActions(thread: boolean, update: boolean): NativeNode {
		const { tui } = this.#d;
		const button = (act: string, label: string, key: string, tone?: "accent" | "error"): NativeNode =>
			tui.node("row", { role: "omp.btn", gap: "xs", align: "center", actions: { click: act }, title: `${label}  ${key}`, ...(tone ? { tone } : {}) }, [tui.text(label, { wrap: "none" }), tui.node("kbd", { keys: [key] })], act);
		const buttons = [
			...(thread ? HUB_BUTTONS.map(b => button(b.act, b.label, b.key, b.tone)) : []),
			...(update ? [button("update", "Update", "u", "accent")] : []),
			tui.node("spacer", { grow: 1 }, undefined, "spacer"),
			button("close", "Close", "escape"),
		];
		return tui.node("row", { role: "omp.actions", gap: "sm", align: "center" }, buttons, "actions");
	}

	/** The overlay's own frame: the host draws `describe()` inside a sheet with this head. */
	readonly nativeOverlay = { role: "omp.overlay.cloud", size: "lg", anchor: "center", head: "☁ omp-cloud" } as const;

	render(width: number): readonly string[] {
		const { theme, tui } = this.#d;
		const now = this.#d.now?.() ?? Date.now();
		const fit = (s: string): string => tui.truncateToWidth(s, Math.max(10, width));
		const lines: string[] = [];
		const rule = theme.fg("borderMuted", "─".repeat(Math.max(10, width)));

		const unreadTotal = this.#d.inbox.unread;
		const update = this.#updateReady();
		lines.push(theme.bold(theme.fg("accent", `☁ omp-cloud${this.#who ? ` · ${this.#who.user}` : ""}${unreadTotal > 0 ? ` · ${unreadTotal} unread` : ""}`)) + (update ? theme.fg("warning", ` · update ${update} ready (u: restart to update)`) : ""));
		if (this.#error) lines.push(theme.fg("error", `! ${clip(this.#error, 200)}`));
		if (!this.#loaded) lines.push(theme.fg("muted", "loading…"));

		const who = this.#who;
		if (who) {
			const providers = patternProviders(who.modelPatterns);
			lines.push(
				`  runs ${providers.length > 0 ? providers.join(", ") : theme.fg("warning", "no providers (/cloud login <provider>)")} · threads run their session's model (fallback ${who.defaultModel || "none"}) · omp ${who.ompVersion || "?"}`,
			);
			const c = who.threads;
			lines.push(theme.fg("muted", `  VMs ${who.vms.running} running, ${who.vms.paused} paused · threads ${c.working} working, ${c.waiting} waiting, ${c.idle} idle, ${c.failed} failed`));
		}

		lines.push(theme.fg("muted", `Threads (${this.#threads.length})`));
		const first = Math.max(0, Math.min(this.#sel - Math.floor(LIST_ROWS / 2), this.#threads.length - LIST_ROWS));
		for (const [i, t] of this.#threads.slice(first, first + LIST_ROWS).entries()) {
			const at = first + i;
			const mark = at === this.#sel ? theme.fg("accent", "▸") : " ";
			const icon = t.question ? theme.fg("warning", "?") : phaseIcon(t.phase);
			const diff = t.result ? `+${t.result.insertions}/−${t.result.deletions}` : "";
			const unread = this.#d.inbox.unreadFor(t.id);
			const row = `${mark} ${icon} ${shortName(t.id)} ${(t.archivedAt ? "archived" : t.phase).padEnd(8)} t${String(t.turns).padEnd(2)} ${(t.latest?.state ?? "-").padEnd(7)} ${diff.padEnd(9)} ${formatAge(t.lastActivityAt || t.createdAt, now).padEnd(4)} ${unread > 0 ? `${theme.fg("accent", `[${unread} new]`)} ` : ""}${threadHeading(t, 80)}`;
			lines.push(at === this.#sel ? theme.bold(row) : row);
		}
		if (this.#threads.length === 0 && this.#loaded) lines.push("  no threads — hand off work with /cloud <task>");

		const d = this.#detail;
		if (d) {
			lines.push(rule);
			lines.push(theme.bold(`${d.name ? `${d.name} · ` : ""}${d.id} · ${d.archivedAt ? "archived" : d.phase} · ${plural(d.turns.length, "turn")} · ${d.model || "fallback model"}${d.ompVersion ? ` · omp ${d.ompVersion}` : ""}`));
			if (d.name) lines.push(theme.fg("muted", clip(d.title, 200)));
			const used = metricsLine(d.metrics);
			if (used !== "") lines.push(theme.fg("muted", used));
			if (d.error) lines.push(theme.fg("error", `! ${clip(d.error, 300)}`));
			const q = d.question;
			if (q) {
				lines.push(theme.fg("warning", `? ${q.header ? `${q.header}: ` : ""}${clip(q.text, 400)}${q.remaining > 1 ? ` (+${q.remaining - 1} more)` : ""}`));
				q.options.forEach((o, i) => {
					lines.push(`   ${q.multi ? "[ ]" : "(•)"} ${o.label}${q.recommended === i ? theme.fg("success", "  ← recommended") : ""}${o.description ? theme.fg("muted", ` — ${clip(o.description, 100)}`) : ""}`);
				});
			}
			const latest = [...d.turns].reverse().find(x => x.state === "done" || x.state === "failed");
			if (latest) {
				lines.push(theme.fg("muted", `Latest — turn ${latest.id} ${latest.state}${latest.title ? `: ${latest.title}` : ""}`));
				for (const l of firstLines(latest.state === "failed" ? latest.error : latest.reply, 6)) lines.push(`  ${l}`);
			}
		}
		if (this.#events.length > 0) {
			lines.push(theme.fg("muted", "Live"));
			for (const e of eventLines(this.#events).slice(-6)) lines.push(theme.fg("dim", `  ${lineText({ kind: e.kind, text: clip(e.text, 140) })}`));
		}
		lines.push(rule);
		lines.push(theme.fg("dim", `↑↓ select · s send · a answer · o open · x stop · p pull · r resume · d delete${update ? " · u update" : ""} · q close`));
		return lines.map(fit);
	}
}
