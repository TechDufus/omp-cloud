/** Small pure helpers shared by the cards, the hub, the widgets and the tool. */

import type { ThreadMetrics, ThreadTurn, TurnState } from "./types";

/** Control characters (C0, DEL, C1): a terminal acts on them or discards a report that holds them. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** `s` as one line a terminal can show: every control character a space, whitespace collapsed, trimmed. */
export function controlFree(s: string): string {
	return s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** One line, whitespace collapsed, cut to `n` characters with an ellipsis. */
export function clip(s: string, n: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** At most `n` lines of `text`, trailing whitespace dropped. */
export function firstLines(text: string | undefined, n: number): string[] {
	return (text ?? "").trimEnd().split("\n").slice(0, n);
}

/** `text` cut to `max` characters; a cut is marked and says how much was left out. */
export function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}… [${text.length - max} more characters]`;
}

/** `4m12s`, `38s`, `2h05m`; "" for a missing or negative span. */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** The span between two RFC 3339 timestamps, formatted; "" when either is missing. */
export function spanBetween(from: string | undefined, to: string | undefined): string {
	if (!from || !to) return "";
	return formatDuration(Date.parse(to) - Date.parse(from));
}

/** `3m`, `2h`, `5d` since `at`; "" when unknown. */
export function formatAge(at: string | undefined, now: number): string {
	if (!at) return "";
	const ms = now - Date.parse(at);
	if (!Number.isFinite(ms) || ms < 0) return "";
	const m = Math.floor(ms / 60_000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** A cost string or number as `$0.42`; "" when absent or zero. */
export function formatCost(cost: string | number | undefined): string {
	const n = typeof cost === "string" ? Number(cost) : cost;
	if (n === undefined || !Number.isFinite(n) || n <= 0) return "";
	return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** The icon for a thread phase. */
export function phaseIcon(phase: string): string {
	switch (phase) {
		case "starting":
			return "◌";
		case "working":
			return "●";
		case "waiting":
			return "?";
		case "idle":
			return "○";
		case "failed":
			return "✗";
		default:
			return "·";
	}
}

export function stateIcon(state: TurnState): string {
	switch (state) {
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "running":
			return "●";
		case "queued":
			return "…";
		default:
			return "–";
	}
}

/** `+ins −del · N files`, with the zero case spelled out. */
export function diffstat(t: Pick<ThreadTurn, "filesChanged" | "insertions" | "deletions">): string {
	const files = t.filesChanged ?? 0;
	if (files === 0 && !t.insertions && !t.deletions) return "no changes";
	return `+${t.insertions ?? 0} −${t.deletions ?? 0} · ${files} file${files === 1 ? "" : "s"}`;
}

/** `pushed to <branch>`; plain `pushed` for a result recorded without a branch. */
export function pushedText(t: { pushRef: string }): string {
	return t.pushRef === "" ? "pushed" : `pushed to ${t.pushRef}`;
}

/** The cost of a turn, from its usage block. */
export function turnCost(t: Pick<ThreadTurn, "usage">): string {
	return formatCost(t.usage?.cost);
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** A thread's primary label: its name, else its title; one line, cut to `max` characters. */
export function threadHeading(t: { name: string; title: string }, max = 60): string {
	return clip(t.name || t.title, max);
}

/** `heading · id`: the label users read with the id they type kept visible; the bare id when the thread has neither name nor title. */
export function threadTag(t: { id: string; name: string; title: string }): string {
	const heading = threadHeading(t, 50);
	return heading === "" ? t.id : `${heading} · ${t.id}`;
}

/** `950`, `19K`, `1.2M`: a token count as omp's own cards write it. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(n / 1000)}K`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** One line of what a thread has used: context (`19K / 200K`, or `19K` when the window is unknown), cost, requests, tool calls. `""` without metrics. */
export function metricsLine(m: ThreadMetrics | null): string {
	if (!m) return "";
	const parts: string[] = [];
	if (m.context) parts.push(`context ${formatTokens(m.context.tokens)}${m.context.window > 0 ? ` / ${formatTokens(m.context.window)}` : ""}`);
	const cost = formatCost(m.usage.cost);
	if (cost !== "") parts.push(cost);
	parts.push(plural(m.requests, "request"), plural(m.tools, "tool call"));
	return parts.join(" · ");
}
