/**
 * The `cloud` tool as native (TSP) views: `describeCall` while the call runs, `describeResult` once it has a result.
 * A `wait` or `status` result is omp's own `wait` card (its head, its tone, a frame of job tiles from
 * `describeJobTiles`), a `list` is the list card's tiles, and every other op a head over a `kv` or `md` body. Everything
 * is drawn from the result's typed `details` and its text; the text the model sees is untouched.
 */

import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui";
import * as kit from "@oh-my-pi/pi-tui/native/describe";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import type { TspSpan } from "@oh-my-pi/pi-tui/native/node";
import { describeJobTiles, type JobTile } from "@oh-my-pi/pi-tui/tools/job-widget";
import { errorText, errorView, toolHead } from "@oh-my-pi/pi-tui/tools/native-view";
import type { NativeToolView, RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";
import { nativeAsk, nativeTile } from "./cards";
import { cloudJobTile, type CloudJobThread } from "./cloud-job";
import { isRecord } from "./guards";
import { clip, formatCost, plural } from "./format";
import type { OpDetails, ThreadFailure, ToolDetails } from "./tool";
import type { StatusDetail, WaitDetail } from "./tool-ops";

/** Tiles a native wait card shows before it counts the rest (omp's own limit). */
const TILES_SHOWN = 9;

/** The part of the host's result a view reads. */
export interface ViewResult {
	content: { type: string; text?: string }[];
	details?: unknown;
	isError?: boolean;
}

/** The text blocks of a result, joined. */
function textOf(result: ViewResult): string {
	return result.content.flatMap(b => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
}

/** What follows `ok` on the first line of a result's text (`2 of 3 settled (until any)`); "" for none. */
function summaryOf(text: string): string {
	return /^cloud \S+: ok ?(.*)$/.exec(text.split("\n", 1)[0] ?? "")?.[1] ?? "";
}

/** The text the first line leaves. */
function restOf(text: string): string {
	return text.split("\n").slice(1).join("\n").trim();
}

/** The body of the `cloud-output` fence of a result, else the lines after the first. */
function fencedText(text: string): string {
	const lines = text.split("\n");
	const open = lines.findIndex(l => l.startsWith("<cloud-output"));
	const close = lines.lastIndexOf("</cloud-output>");
	return open >= 0 && close > open ? lines.slice(open + 1, close).join("\n") : lines.slice(1).join("\n");
}

function note(message: string, token = "muted"): NativeNode {
	return kit.text([kit.span(plainText(message), token)], { wrap: "word" });
}

function failureNodes(failures: readonly ThreadFailure[]): NativeNode[] {
	return failures.map(f => errorText(`${f.thread}: ${f.error.code}: ${f.error.message}`));
}

function head(op: string, ...details: readonly (string | undefined)[]): TspSpan[] {
	return toolHead(`Cloud ${op}`, ...details);
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** The call as it runs: the op, what it targets and what it says. */
export function describeCall(args: unknown, options: Pick<RenderResultOptions, "isPartial">): NativeToolView | undefined {
	// Once the call has its final result the result view replaces this one (the host merges both, and this head would win).
	if (!options.isPartial) return undefined;
	if (!isRecord(args) || typeof args.op !== "string") return { head: toolHead("Cloud") };
	const p: Record<string, unknown> = args;
	const tasks = Array.isArray(p.tasks) ? p.tasks : [];
	const refs = typeof p.thread === "string" ? clip(p.thread, 80) : Array.isArray(p.thread) ? clip(p.thread.filter((x): x is string => typeof x === "string").join(", "), 80) : "";
	const op = args.op;
	switch (op) {
		case "delegate": {
			const prompts = tasks.length > 0 ? tasks.flatMap(t => (isRecord(t) && typeof t.task === "string" ? [t.task] : [])) : typeof p.task === "string" ? [p.task] : [];
			return { head: head("delegate", prompts.length > 0 ? plural(prompts.length, "task") : undefined), body: prompts.map(t => note(clip(t, 200))) };
		}
		case "send":
		case "answer": {
			const message = typeof p.text === "string" ? p.text : typeof p.answer === "string" ? p.answer : "";
			return { head: head(op, refs), body: message === "" ? [] : [note(clip(message, 300))] };
		}
		default:
			return { head: head(op, refs === "" ? undefined : refs) };
	}
}

// ---------------------------------------------------------------------------
// Job tiles: wait, status
// ---------------------------------------------------------------------------

/** A thread as a frozen tile: the result is history, so its clocks stand where the call left them. */
function frozenTile(view: CloudJobThread, at: number): JobTile {
	return { ...cloudJobTile(view, at), live: false };
}

const ORDER: Record<JobTile["status"], number> = { running: 0, failed: 1, cancelled: 2, completed: 3 };

/**
 * omp's wait card: `waiting on N of M jobs` (`M jobs settled` once none runs) with the done, failed and cancelled counts,
 * then one frame of tiles, the rest counted. `extra` goes under the tiles; a thread the call could not show is a failure.
 */
function jobsView(op: string, tiles: readonly JobTile[], failures: readonly ThreadFailure[], extra: readonly NativeNode[], text: string): NativeToolView {
	if (tiles.length === 0 && failures.length === 0) {
		return { head: toolHead(`Cloud ${op}`), tone: "warning", body: [kit.text([kit.span(plainText(restOf(text) || summaryOf(text) || "No threads to show"), "dim")])] };
	}
	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const tile of tiles) counts[tile.status]++;
	const noun = tiles.length === 1 ? "job" : "jobs";
	const title =
		tiles.length === 0
			? `${plural(failures.length, "thread")} could not be read`
			: counts.running > 0
				? counts.running === tiles.length
					? `waiting on ${tiles.length} ${noun}`
					: `waiting on ${counts.running} of ${tiles.length} ${noun}`
				: `${tiles.length} ${noun} settled`;
	const spans: TspSpan[] = [kit.span(title, "toolTitle strong")];
	if (counts.completed > 0) spans.push(kit.span(` ${counts.completed} done`, "success"));
	if (counts.failed > 0) spans.push(kit.span(` ${counts.failed} failed`, "error"));
	if (counts.cancelled > 0) spans.push(kit.span(` ${counts.cancelled} cancelled`, "warning"));
	const sorted = [...tiles].sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.durationMs ?? 0) - (a.durationMs ?? 0));
	const body: NativeNode[] = [];
	if (sorted.length > 0) body.push(kit.keyed(describeJobTiles(sorted.slice(0, TILES_SHOWN)), "tiles"));
	if (sorted.length > TILES_SHOWN) {
		const rest = sorted.length - TILES_SHOWN;
		body.push(kit.text([kit.span(`+${rest} more ${rest === 1 ? "thread" : "threads"} · /cloud`, "dim")], { role: "omp.wait.more" }));
	}
	body.push(...extra, ...failureNodes(failures));
	return {
		head: spans,
		tone: counts.failed > 0 || failures.length > 0 ? "warning" : counts.running > 0 ? "info" : "success",
		// The tiles are what the view shows: clamping the body by lines would cut them.
		preview: "children",
		body,
	};
}

function waitView(d: Extract<OpDetails, { op: "wait" }>, text: string): NativeToolView {
	const shown = d.outcomes.flatMap(o => (o.view ? [frozenTile(o.view, d.at)] : []));
	const gone = d.outcomes.filter((o: WaitDetail) => o.view === null).map(o => note(`${o.thread}: ${o.outcome === "deleted" ? "deleted, the thread is gone" : o.outcome === "stale" ? "this session lost contact with the cloud" : o.outcome}`, "warning"));
	return jobsView("wait", shown, d.failures, gone, text);
}

/** One status thread's facts under its tile: model, following, job, result. */
function statusNote(t: StatusDetail): NativeNode {
	const parts = [t.id, t.model || "service default model", `following ${t.following}`, ...(t.job ? [`job ${t.job}`] : []), ...(t.result ? [`${t.result.branch}${t.result.pushed ? " pushed" : ""}`] : [])];
	return kit.text([kit.span(parts.join(" · "), "muted")], { wrap: "word", role: "omp.tool.stats" });
}

function statusView(d: Extract<OpDetails, { op: "status" }>, text: string): NativeToolView {
	return jobsView(
		"status",
		d.threads.map(t => frozenTile(t.view, d.at)),
		d.failures,
		d.threads.map(statusNote),
		text,
	);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function listView(d: Extract<OpDetails, { op: "list" }>): NativeToolView {
	const groups = new Map<string, typeof d.threads>();
	for (const t of d.threads) groups.set(t.repo, [...(groups.get(t.repo) ?? []), t]);
	const sections = [...groups].map(([repo, threads]) =>
		kit.node(
			"section",
			{ head: [kit.span(repo, "strong"), kit.span(` · ${plural(threads.length, "thread")}`, "dim")], collapsible: true },
			[kit.row(threads.map(t => nativeTile(kit, t.card, repo, d.at, false)), { role: "omp.job.tiles", gap: "none", wrap: true }), ...threads.filter(t => t.card.question !== "" || t.card.phase === "waiting").map(t => nativeAsk(kit, t.card))],
			kit.stableKey(repo),
		),
	);
	const more = d.next === null ? [] : [kit.text([kit.span(`${d.threads.length} of ${d.total} threads · the next page continues from the cursor`, "dim")], { wrap: "none" })];
	return {
		head: head("list", `${d.threads.length} of ${d.total} threads`),
		tone: "info",
		preview: "children",
		body: d.threads.length === 0 ? [note("no threads")] : [...sections, ...more],
	};
}

// ---------------------------------------------------------------------------
// The rest
// ---------------------------------------------------------------------------

function factsOf(pairs: readonly (readonly [string, string])[]): NativeNode[] {
	const facts = kit.kv(pairs);
	return facts ? [facts] : [];
}

function money(n: number): string {
	return formatCost(n) || "$0";
}

function yesNo(v: boolean): string {
	return v ? "yes" : "no";
}

function infoView(d: Extract<OpDetails, { op: "info" }>): NativeToolView {
	const l = d.limits;
	const spend = d.spend === null ? "not reported" : `${money(d.spend.todayUSD)} today${d.spend.dayCapUSD > 0 ? ` of ${money(d.spend.dayCapUSD)}` : ""}`;
	return {
		head: head("info", `omp-cloud ${d.service.version || "?"}`),
		tone: "info",
		body: factsOf([
			["cloud", d.active === null ? "none usable" : `${d.active} · ${d.clouds.find(c => c.source === d.active)?.url ?? ""}${d.chosen ? " · this session's choice" : ""}${d.clouds.length > 1 ? ` · ${d.clouds.length} known` : ""}`],
			["service", `omp-cloud ${d.service.version || "unknown"} (api ${d.service.api})`],
			["caller", `${d.caller.kind} ${d.caller.name}`],
			["default model", d.defaultModel || "none"],
			["models", d.models.length === 0 ? "none yet" : `${d.models.slice(0, 6).join(", ")}${d.models.length > 6 ? ` and ${d.models.length - 6} more` : ""}`],
			["capabilities", d.capabilities.length === 0 ? "none reported" : d.capabilities.join(", ")],
			["agents may", d.agents === null ? "" : `fetch ${yesNo(d.agents.fetch)} · web search ${yesNo(d.agents.webSearch)} · browser ${yesNo(d.agents.browser)} · egress ${d.agents.egress.length === 0 ? "open" : plural(d.agents.egress.length, "destination")}${d.agents.readOnly ? " · read-only" : ""}`],
			["toolchain", d.agents === null ? "" : d.agents.packages.join(", ")],
			["results", d.agents === null ? "" : [d.agents.push && `git.push ${d.agents.push}`, d.agents.pr && `pull requests ${d.agents.pr}`, d.agents.sign && `signing ${d.agents.sign}`].filter(Boolean).join(" · ")],
			["plan mode", d.planning ? "on: delegations are read-only" : ""],
			["limits", `message ${l.maxMessageBytes} B · answer ${l.maxAnswerBytes} B · list ${l.listMax} · turns per thread ${l.maxTurns}`],
			["spend", spend],
			["VMs", `${d.vms.running} running · ${d.vms.paused} paused`],
			["threads", `${d.threads.starting} starting · ${d.threads.working} working · ${d.threads.waiting} waiting · ${d.threads.idle} idle · ${d.threads.failed} failed`],
		]),
	};
}

function delegateView(d: Extract<OpDetails, { op: "delegate" }>): NativeToolView {
	const failed = d.outcomes.filter(o => !o.ok).length;
	const started = d.outcomes.length - failed;
	const bodies: NativeChild[][] = d.outcomes.map(o =>
		o.ok
			? factsOf([
					["thread", o.thread],
					["name", o.name],
					["model", o.model],
					["branch", o.branch],
					["workspace", o.workspace],
					["ref", o.ref],
					["agent", o.agent ?? o.job ?? ""],
					["read-only", o.readOnly ? "yes" : ""],
					["replayed", o.replayed ? "yes: its idempotency key had created it" : ""],
					["warnings", o.warnings.join("; ")],
				])
			: [errorText(`${o.error.code}: ${o.error.message}`)],
	);
	const body: NativeChild[] =
		d.outcomes.length === 1
			? (bodies[0] ?? [])
			: d.outcomes.map((o, i) => kit.node("section", { head: [kit.span(`Task ${i + 1}`, "strong"), kit.span(o.ok ? " started" : " failed", o.ok ? "success" : "error")] }, bodies[i], `task-${i}`));
	return { head: head("delegate", `${started} started${failed > 0 ? `, ${failed} failed` : ""}`), tone: failed === 0 ? "success" : started === 0 ? "error" : "warning", body };
}

function sendView(d: Extract<OpDetails, { op: "send" }>): NativeToolView {
	return {
		head: head("send", `${d.thread} ${d.turn === null ? (d.receipt ?? "sent") : `turn ${d.turn}`}`),
		tone: "success",
		body: factsOf([
			["thread", d.thread],
			["turn", d.turn === null ? "" : String(d.turn)],
			["delivered", d.receipt ?? ""],
			["mode", d.mode],
			["interrupted", d.interrupted ? "yes" : ""],
			["cancelled", d.cancelled.length > 0 ? d.cancelled.map(t => `turn ${t}`).join(", ") : ""],
			["following", d.following],
			["job", d.job ?? ""],
			["restoring", d.restoring ? "the VM is being restored" : ""],
		]),
	};
}

function answerView(d: Extract<OpDetails, { op: "answer" }>): NativeToolView {
	return {
		head: head("answer", `${d.thread} question ${d.turn}:${d.question}`),
		tone: "success",
		body: factsOf([
			["thread", d.thread],
			["question", `${d.turn}:${d.question} (${d.kind})`],
			["selected", d.selected.join(", ")],
			["answer", clip(d.answer, 300)],
			["still open", d.left.length > 0 ? d.left.map(q => `${q.turn}:${q.id}`).join(", ") : ""],
		]),
	};
}

function stopView(d: Extract<OpDetails, { op: "stop" }>): NativeToolView {
	const items = d.outcomes.map(o => [o.thread, `${o.stoppedRunning ? "stopped the running turn" : "no turn was running"}${o.cancelled > 0 ? ` · cancelled ${plural(o.cancelled, "queued turn")}` : ""}`] as const);
	return { head: head("stop", plural(d.outcomes.length, "thread")), tone: d.failures.length > 0 ? "warning" : "success", body: [...factsOf(items), ...failureNodes(d.failures)] };
}

function pullView(d: Extract<OpDetails, { op: "pull" }>): NativeToolView {
	return {
		head: head("pull", `${d.thread} ${d.mode}`),
		tone: "success",
		body: factsOf([
			["thread", d.thread],
			["mode", d.mode],
			["branch", d.branch],
			["head", d.head.slice(0, 8)],
			["path", d.path],
			["commits", d.commits === null ? "" : String(d.commits)],
			["branch moved", d.checkedOutMoved ? `yes${d.movedIn ? `, in ${d.movedIn}` : ""}` : ""],
			["session", d.session],
		]),
	};
}

function deleteView(d: Extract<OpDetails, { op: "delete" }>): NativeToolView {
	return { head: head("delete", plural(d.deleted.length, "thread")), tone: d.failures.length > 0 ? "warning" : "success", body: [...(d.deleted.length > 0 ? [note(`deleted ${d.deleted.join(", ")}`)] : []), ...failureNodes(d.failures)] };
}

function readView(d: Extract<OpDetails, { op: "read" }>, text: string): NativeToolView {
	const body = fencedText(text);
	return {
		head: head("read", `${d.thread} turn ${d.turn} ${d.part}`, `${d.offset}-${d.end} of ${d.total}`),
		tone: "info",
		body: [kit.md(body), ...(d.next === null ? [] : [note(`the rest continues at offset ${d.next}`)])],
	};
}

function eventsView(d: Extract<OpDetails, { op: "events" }>, text: string): NativeToolView {
	return { head: head("events", d.thread, plural(d.count, "event")), tone: "info", body: d.count === 0 ? [note("no events")] : [kit.code(fencedText(text))] };
}

function diffView(d: Extract<OpDetails, { op: "diff" }>, text: string): NativeToolView {
	const range = `${d.base.slice(0, 8)}..${d.head.slice(0, 8)}`;
	const body = fencedText(text);
	if (d.stat) {
		return { head: head("diff", d.thread, `${plural(d.files ?? 0, "file")} +${d.insertions ?? 0} −${d.deletions ?? 0}`), tone: "info", body: [kit.code(body)] };
	}
	return {
		head: head("diff", d.thread, range),
		tone: "info",
		body: [kit.diff(body), ...(d.truncated === null ? [] : [note(`cut: the diff is ${d.truncated} bytes`, "warning")])],
	};
}

function filesView(d: Extract<OpDetails, { op: "files" }>, text: string): NativeToolView {
	const where = `${d.ref} ${d.commit.slice(0, 8)}`;
	if (d.kind === "tree") return { head: head("files", d.thread, `${d.path === "" ? "/" : d.path} · ${plural(d.entries ?? 0, "entry", "entries")}`), tone: "info", body: [kit.code(fencedText(text))] };
	const binary = text.includes("binary file: its text is not shown");
	return { head: head("files", d.thread, `${d.path} · ${where}`), tone: "info", body: binary ? [note("binary file: its text is not shown")] : [kit.code(fencedText(text), { path: d.path }), ...(d.next === null ? [] : [note(`the rest continues at byte ${d.next}`)])] };
}

/** Any result whose details are absent, old or unknown: its head over its text. */
function textView(op: string, text: string): NativeToolView {
	const rest = restOf(text);
	return { head: head(op, summaryOf(text) || undefined), body: rest === "" ? [] : [kit.md(rest)] };
}

/** The result as a native view; undefined while it is a progress update (the call view stands then). */
export function describeResult(result: ViewResult, options: Pick<RenderResultOptions, "isPartial">): NativeToolView | undefined {
	if (options.isPartial) return undefined;
	const text = textOf(result);
	const d = result.details;
	if (!isRecord(d) || typeof d.op !== "string") return textView("result", text);
	const details = d as unknown as ToolDetails;
	if (result.isError === true || "error" in details) return errorView(`Cloud ${details.op}`, text);
	switch (details.op) {
		case "wait":
			return typeof details.at === "number" && Array.isArray(details.outcomes) ? waitView(details, text) : textView("wait", text);
		case "status":
			return typeof details.at === "number" && details.threads.every(t => isRecord(t.view)) ? statusView(details, text) : textView("status", text);
		case "list":
			return typeof details.at === "number" && details.threads.every(t => isRecord(t.card)) ? listView(details) : textView("list", text);
		case "info":
			return Array.isArray(details.clouds) ? infoView(details) : textView("info", text);
		case "delegate":
			return delegateView(details);
		case "send":
			return sendView(details);
		case "answer":
			return answerView(details);
		case "stop":
			return stopView(details);
		case "pull":
			return pullView(details);
		case "delete":
			return deleteView(details);
		case "read":
			return readView(details, text);
		case "events":
			return eventsView(details, text);
		case "diff":
			return diffView(details, text);
		case "files":
			return filesView(details, text);
		case "use":
		case "connect":
			return textView(details.op, text);
		case "preview":
			return textView("preview", text);
	}
}
