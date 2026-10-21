/**
 * A cloud thread as one of omp's own jobs: the id, stage, widget view and tile that omp's job tiles draw
 * (the `wait` card, the dock pill's hover card, `/jobs`). Pure and deterministic over the thread's summary, so
 * the live job of a running turn and the `/cloud list` tile of the same thread read the same.
 */

import { getContextMeterThresholds } from "@oh-my-pi/pi-tui/chrome/context-thresholds";
import type { JobTile, JobWidgetBarsBlock, JobWidgetBlock, JobWidgetGridBlock, JobWidgetHeadline, JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { isRecord } from "./guards";
import { clip, formatCost, formatDuration, formatTokens } from "./format";
import type { PendingQuestion, ThreadActivity, ThreadLatest, ThreadSummary, ThreadTurn, TurnState } from "./types";

type TspTone = JobWidgetGridBlock["items"][number]["tone"];

/**
 * What the job functions read of a thread: a thread summary has all of it, a thread detail too, and so does a list
 * card's thread. The turn count comes from the metrics (finished turns).
 */
export type CloudJobThread = Pick<ThreadSummary, "id" | "name" | "title" | "phase" | "error" | "metrics" | "archivedAt" | "lastActivityAt"> & {
	activity: Pick<ThreadActivity, "kind" | "text"> | null;
	/** The latest turn: a failed or cancelled one leaves the thread idle, and the thread then reads as failed or cancelled. */
	latest: (Pick<ThreadLatest, "title" | "error"> & { state: string }) | null;
	question: Pick<PendingQuestion, "text"> | null;
};

/** Longest job id: omp draws it as the tile's title. */
const JOB_ID_MAX = 32;
/** Longest stage line; a tile cuts it to its own width. */
const STAGE_MAX = 200;
/** Longest widget title. */
const TITLE_MAX = 60;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Oct 8`, in local time. */
export function shortDate(at: string): string {
	const date = new Date(at);
	return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** Words a job id does not end on: cutting at a word can leave one dangling (`RebuildTheDashboardClientOnThe`). */
const STOP_WORDS: readonly string[] = ["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"];

/**
 * The job id omp shows as a task tile's title: the words of the name (the title when the thread has no name, or its
 * name has no letters or digits) in CamelCase, letters and digits only, at most 32 characters cut at a word, without
 * a trailing stop word (`Pane zoom shortcut` is `PaneZoomShortcut`, `Rebuild the dashboard client on the vendored kit`
 * is `RebuildTheDashboardClient`); `Cloud` and the 6-character short id when neither yields a word.
 */
export function cloudJobId(thread: { id: string; name: string; title?: string }): string {
	const words = (text: string): string[] => text.match(/[\p{L}\p{N}]+/gu) ?? [];
	const named = words(thread.name);
	const source = named.length > 0 ? named : words(thread.title ?? "");
	const kept: string[] = [];
	let length = 0;
	for (const word of source) {
		const chars = Array.from(word);
		const camel = `${(chars[0] ?? "").toUpperCase()}${chars.slice(1).join("")}`;
		if (length + chars.length > JOB_ID_MAX) {
			if (kept.length === 0) kept.push(chars.slice(0, JOB_ID_MAX).join("").replace(/^./u, c => c.toUpperCase()));
			break;
		}
		kept.push(camel);
		length += chars.length;
	}
	while (kept.length > 1 && STOP_WORDS.includes((kept.at(-1) ?? "").toLowerCase())) kept.pop();
	return kept.length === 0 ? `Cloud${thread.id.slice(-6)}` : kept.join("");
}

/** The argument names omp's own task progress previews a tool call by, in its order (`extractToolArgsPreview`). */
const ARG_PREVIEW_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"] as const;

/** A tool call of a cloud turn as omp's task progress holds one: the tool, and either the intent the model gave or the arguments' preview. */
export interface ToolCall {
	tool: string;
	/** The model's own intent line for the call. */
	intent?: string;
	/** The call's preview argument, as omp picks it, and the key it came from. */
	args?: string;
	argsKey?: string;
}

/** The value of the preview argument in the call's arguments as the service sends them: JSON, cut at 200 characters (a cut one cannot parse, so its string values are read as far as they go). `tool` is the call's tool: an edit previews its files. */
export function previewArgument(json: string, tool = ""): { value: string; key: string } | undefined {
	if (json === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(json);
		if (isRecord(parsed)) {
			const args = parsed;
			// An edit names its files, as omp's preview of one does (before any other argument).
			const edits = args.edits;
			if ((tool === "edit" || tool === "apply_patch") && Array.isArray(edits)) {
				const paths = new Set<string>(typeof args.path === "string" && args.path !== "" ? [args.path] : []);
				for (const edit of edits) {
					const p = isRecord(edit) ? edit.path : undefined;
					if (typeof p === "string" && p !== "") paths.add(p);
				}
				if (paths.size > 0) return { value: [...paths].join(", "), key: "path" };
			}
			for (const key of ARG_PREVIEW_KEYS) {
				const v = args[key];
				if (typeof v === "string" && v !== "") return { value: v, key };
			}
		}
		return undefined;
	} catch {
		for (const key of ARG_PREVIEW_KEYS) {
			const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
			if (!m?.[1]) continue;
			try {
				return { value: JSON.parse(`"${m[1]}"`) as string, key };
			} catch {
				return { value: m[1].replace(/\\n/g, " ").replace(/\\"/g, '"'), key };
			}
		}
		return undefined;
	}
}

/**
 * A tool event of the thread's log (`<tool> <intent>` or `<tool> <arguments as JSON>`, which is what the runner writes) as the tool and
 * what omp's task progress keeps of a call. Text that already reads `<tool>: <detail>` keeps its detail as the intent.
 */
export function toolCall(text: string): ToolCall {
	const flat = text.trim();
	const space = flat.search(/\s/);
	const head = space < 0 ? flat : flat.slice(0, space);
	const tool = head.endsWith(":") ? head.slice(0, -1) : head;
	const rest = space < 0 ? "" : flat.slice(space + 1).trim();
	if (rest.startsWith("{")) {
		const arg = previewArgument(rest, tool);
		return arg ? { tool, args: arg.value, argsKey: arg.key } : { tool };
	}
	return rest === "" ? { tool } : { tool, intent: rest };
}

/** A tool event as omp's own lines name a call: `bash: for i in …`, `read: src/a.ts`, or the bare tool name. */
export function toolLabel(text: string): string {
	const call = toolCall(text);
	const detail = call.intent ?? call.args ?? "";
	return detail === "" ? call.tool : `${call.tool}: ${detail}`;
}

/**
 * One line of what the agent is doing or did: the question it waits on (`? …`), the tool or text of the running turn
 * (`» bash: bun test`), the latest turn's title, the error of a failed one, or the archive note.
 */
export function cloudJobStage(thread: CloudJobThread): string {
	if (thread.archivedAt !== null && thread.phase === "idle") return `archived ${shortDate(thread.archivedAt)} · the next message restores it`;
	switch (thread.phase) {
		case "waiting":
			return thread.question ? `? ${clip(thread.question.text, STAGE_MAX)}` : "waiting for an answer";
		case "starting":
		case "working": {
			const text = thread.activity ? clip(thread.activity.kind === "tool" ? toolLabel(thread.activity.text) : thread.activity.text, STAGE_MAX) : "";
			if (text === "") return thread.phase;
			return thread.activity?.kind === "tool" ? `» ${text}` : text;
		}
		case "idle":
			if (thread.latest?.state === "failed") return clip(thread.latest.error || thread.error || "failed", STAGE_MAX);
			if (thread.latest?.state === "cancelled") return "cancelled";
			return clip(thread.latest?.title || thread.title, STAGE_MAX);
		case "failed":
			return clip(thread.error || thread.latest?.error || "failed", STAGE_MAX);
	}
}

/** The share of the window in use, 0-100. */
function percent(tokens: number, window: number): number {
	return Math.min(100, Math.round((tokens / window) * 100));
}

/**
 * The thread's widget: its context as the headline (a percent when the window is known, else tokens) with the move
 * since the previous turn, a spark of context per turn (from two turns on), the context meter (with a window), and
 * the stats line (cost, tokens as omp counts them, requests, tools, turns and the short id). Undefined when the
 * service sent no metrics.
 */
export function cloudJobWidget(thread: CloudJobThread, now: number): JobWidgetView | undefined {
	const m = thread.metrics;
	if (!m) return undefined;
	const context = m.context !== null && m.context.tokens > 0 ? m.context : null;
	const known = context !== null && context.window > 0;
	const points = m.turns.flatMap(t => (t.contextTokens === null ? [] : [{ n: t.n, tokens: t.contextTokens }]));
	const last = points.at(-1);
	const previous = points.at(-2);
	const blocks: JobWidgetBlock[] = [];

	if (points.length >= 2 && last) {
		const values = points.map(p => p.tokens);
		blocks.push({
			kind: "spark",
			label: "context",
			values,
			min: 0,
			max: Math.max(1, known ? context.window : 0, ...values),
			last: formatTokens(last.tokens),
			tips: points.map(p => `turn ${p.n} · ${formatTokens(p.tokens)}`),
		});
	}
	if (context !== null && known) {
		const share = context.tokens / context.window;
		const { warn, bad } = getContextMeterThresholds(context.window);
		blocks.push({
			kind: "meter",
			label: "context",
			value: Math.min(1, share),
			text: `${formatTokens(context.tokens)} / ${formatTokens(context.window)}`,
			...(share >= bad ? { tone: "error" as const } : share >= warn ? { tone: "warning" as const } : {}),
		});
	}
	const tokens = m.usage.inputTokens + m.usage.outputTokens + m.usage.cacheWriteTokens;
	const finished = Math.max(m.turns.at(-1)?.n ?? 0, m.turns.length);
	blocks.push({
		kind: "stat",
		items: [
			{ label: "cost", text: formatCost(m.usage.cost) || "$0" },
			...(tokens > 0 ? [{ label: "tokens", text: formatTokens(tokens) }] : []),
			...(m.requests > 0 ? [{ label: "requests", text: String(m.requests) }] : []),
			...(m.tools > 0 ? [{ label: "tools", text: String(m.tools) }] : []),
			...(finished > 0 ? [{ label: "turns", text: String(finished) }] : []),
			{ label: "id", text: thread.id.slice(-6) },
		],
	});

	const delta = last && previous ? last.tokens - previous.tokens : 0;
	const headline: JobWidgetHeadline | undefined =
		context === null
			? undefined
			: {
					text: known ? `${percent(context.tokens, context.window)}%` : formatTokens(context.tokens),
					label: "context",
					...(delta === 0 ? {} : { trend: { text: `${delta > 0 ? "▲" : "▼"} ${formatTokens(Math.abs(delta))}`, tone: "muted" as const } }),
				};
	const reported = Date.parse(context?.at ?? "") || Date.parse(thread.lastActivityAt);
	return {
		title: clip(thread.name || thread.title || thread.id, TITLE_MAX),
		...(headline ? { headline } : {}),
		stage: cloudJobStage(thread),
		blocks,
		state: "live",
		updatedAt: Number.isFinite(reported) ? reported : now,
	};
}

/** What the live widget reads of a turn. */
export type CloudJobTurn = Pick<ThreadTurn, "id" | "state" | "startedAt" | "completedAt">;

/** A thread with its turns: a thread detail has all of it. */
export type CloudJobLiveThread = CloudJobThread & { turns: readonly CloudJobTurn[] };

/** Turn dots a live widget draws (the newest). */
const GRID_TURNS = 24;
/** Turn durations a live widget charts (the newest). */
const BAR_TURNS = 12;

/** The dot of a turn: the step-dots look of omp's own widgets. */
const TURN_TONE: Record<TurnState, TspTone> = { done: "success", failed: "error", running: "pending", queued: "muted", cancelled: "warning" };

/** How long `turn` ran: until it ended, or until `now` while it runs; undefined when it has not started or the times are unreadable. */
function turnDuration(turn: CloudJobTurn, now: number): number | undefined {
	const started = Date.parse(turn.startedAt);
	if (!Number.isFinite(started)) return undefined;
	const ended = turn.completedAt === "" ? (turn.state === "running" ? now : Number.NaN) : Date.parse(turn.completedAt);
	return Number.isFinite(ended) ? Math.max(0, ended - started) : undefined;
}

/**
 * The widget of a cloud job that runs a turn or just ended one, built to read like the widgets of omp's own task jobs:
 * a grid of the thread's turns first (omp's tile draws only a widget's first block, so this is the tile's step dots:
 * one dot per turn, its number as the label, green done, red failed, hollow while it runs or waits in the queue), then
 * the duration of each turn as bars (the panel's step-duration chart), the context meter, the context spark (the pill's
 * mini chart) and the stats line. The headline and the stage are {@link cloudJobWidget}'s; `stage` replaces its stage (a settled
 * job's outcome, a lost connection) and `title` its title (the job's id, so the tile and the panel call it one name). The view is
 * always `live` and stamped with `now`, so omp draws its figures and charts.
 */
export function cloudJobLiveWidget(thread: CloudJobLiveThread, now: number, stage?: string, title?: string): JobWidgetView {
	const base = cloudJobWidget(thread, now);
	const blocksOf = <K extends JobWidgetBlock["kind"]>(kind: K): Extract<JobWidgetBlock, { kind: K }>[] =>
		(base?.blocks ?? []).filter((b): b is Extract<JobWidgetBlock, { kind: K }> => b.kind === kind);

	const turns = thread.turns.slice(-GRID_TURNS);
	const grid: JobWidgetGridBlock = {
		kind: "grid",
		label: "turns",
		items: turns.map(t => {
			const took = formatDuration(turnDuration(t, now));
			return { label: String(t.id), text: `turn ${t.id} ${t.state}${took === "" ? "" : ` · ${took}`}`, tone: TURN_TONE[t.state] };
		}),
	};
	const timed = thread.turns.flatMap(t => {
		const ms = turnDuration(t, now);
		return ms === undefined ? [] : [{ turn: t, ms }];
	}).slice(-BAR_TURNS);
	const bars: JobWidgetBarsBlock = {
		kind: "bars",
		label: "turn time",
		items: timed.map(({ turn, ms }) => ({
			label: `turn ${turn.id}`,
			value: ms,
			text: formatDuration(ms) || "0s",
			...(turn.state === "failed" ? { tone: "error" as const } : turn.state === "cancelled" ? { tone: "warning" as const } : {}),
		})),
		max: Math.max(1, ...timed.map(t => t.ms)),
	};

	const blocks: JobWidgetBlock[] = [
		...(grid.items.length > 0 ? [grid] : []),
		...(bars.items.length > 0 ? [bars] : []),
		...blocksOf("meter"),
		...blocksOf("spark"),
		...blocksOf("stat"),
	];
	return {
		title: title ?? base?.title ?? clip(thread.name || thread.title || thread.id, TITLE_MAX),
		...(base?.headline ? { headline: base.headline } : {}),
		stage: stage ?? base?.stage ?? cloudJobStage(thread),
		blocks,
		state: "live",
		updatedAt: now,
	};
}

/**
 * The thread as a task tile: the job id as its title, running while a turn runs (its clock counts from the last
 * activity), completed with the time it worked once idle (an archived thread reads `archived` in its stage), failed
 * when it failed.
 */
export function cloudJobTile(thread: CloudJobThread, now: number): JobTile {
	const running = thread.phase === "starting" || thread.phase === "working" || thread.phase === "waiting";
	const since = now - Date.parse(thread.lastActivityAt);
	const worked = thread.metrics?.workMs;
	const durationMs = running ? (Number.isFinite(since) ? Math.max(0, since) : undefined) : worked && worked > 0 ? worked : undefined;
	const widget = cloudJobWidget(thread, now);
	return {
		id: cloudJobId(thread),
		type: "task",
		status: running ? "running" : thread.phase === "failed" || thread.latest?.state === "failed" ? "failed" : thread.latest?.state === "cancelled" ? "cancelled" : "completed",
		label: thread.name || thread.title || thread.id,
		live: running,
		stage: cloudJobStage(thread),
		...(durationMs === undefined ? {} : { durationMs }),
		...(widget ? { widget } : {}),
	};
}
