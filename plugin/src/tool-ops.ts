/** The operations of the `cloud` tool. Each takes validated parameters and returns the text lines and the typed details of its result. */

import { answerAsModel, HUMAN_ANSWER_HINT } from "./answer";
import { cloudFence, inventoryThread, threadBranch } from "./cards";
import type { CloudJobThread } from "./cloud-job";
import { CloudError, cloudErrorText } from "./errors";
import { clip, diffstat, formatAge, formatCost, formatTokens, metricsLine, plural, pushedText, threadTag, truncateText } from "./format";
import { asCloudError, MAX_BATCH_TASKS, modelServed, type LaunchFailure, type LaunchProgress, type LaunchTask } from "./launch";
import type { PullApply } from "./pull";
import { repoLabel } from "./repo-key";
import { asEnvelope, type DelegateDetail, type OpDetails, type OpOutput, type ThreadFailure, type ToolCloud, type ToolParams, type ToolSession } from "./tool";
import { updateLine } from "./update";
import type { Host, IrcReceiptKind, ThreadDetail, ThreadPhase, ThreadSummary, ThreadTurn, TurnPart } from "./types";

/** Phases in which a thread has work in progress or waits for an answer. */
const ACTIVE_PHASES: ThreadPhase[] = ["starting", "working", "waiting"];
const LIST_DEFAULT = 20;
const LIST_MAX = 100;
const READ_DEFAULT = 8000;
const READ_MAX = 32000;
const EVENTS_DEFAULT = 40;
const EVENTS_MAX = 200;
const DIFF_DEFAULT = 24000;
const DIFF_MAX = 1048576;
const STATUS_TURNS_DEFAULT = 3;
const STATUS_TURNS_MAX = 20;
const REPLY_CHARS_DEFAULT = 1500;
const REPLY_CHARS_MAX = 8000;
const STATUS_EVENTS = 10;
const EVENT_PAGES_MAX = 4;
const WAIT_DEFAULT_SEC = 600;
const WAIT_MAX_SEC = 1800;
const FILE_DEFAULT = 24000;
const FILE_MAX = 1048576;
const TREE_LISTED = 200;
const MODELS_LISTED = 30;
const EXCERPT_CHARS = 400;

/** What an operation's call needs from the host. */
export interface Env {
	cloud: ToolCloud;
	ctx: Host;
	session: ToolSession;
	params: ToolParams;
	signal: AbortSignal | undefined;
	toolCallId: string;
	/** Progress text for the host to show while the call runs. */
	progress: (text: string) => void;
}

function invalid(message: string, hint?: string): CloudError {
	return new CloudError({ code: "invalid", message, retriable: false, outcomeKnown: true, hint });
}

function conflict(message: string, hint?: string): CloudError {
	return new CloudError({ code: "conflict", message, retriable: false, outcomeKnown: true, hint });
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** The thread as the job functions read it, bounded: a result's details are persisted, and its native view draws the tile from them. */
export function jobView(t: Pick<ThreadSummary, "id" | "name" | "title" | "phase" | "error" | "metrics" | "archivedAt" | "lastActivityAt" | "activity" | "latest" | "question">): CloudJobThread {
	return {
		id: t.id,
		name: clip(t.name, 60),
		title: clip(t.title, 200),
		phase: t.phase,
		error: clip(t.error, 200),
		metrics: t.metrics,
		archivedAt: t.archivedAt,
		lastActivityAt: t.lastActivityAt,
		activity: t.activity ? { kind: t.activity.kind, text: clip(t.activity.text, 200) } : null,
		latest: t.latest ? { state: t.latest.state, title: clip(t.latest.title, 200), error: clip(t.latest.error, 200) } : null,
		question: t.question ? { text: clip(t.question.text, 300) } : null,
	};
}

/** The call for the model to make next, as the JSON arguments it would send. */
function callText(args: Record<string, string | number | boolean | undefined>): string {
	const defined = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
	return `cloud ${JSON.stringify(defined)}`;
}

/** The thread references of a call: one, or a list, deduplicated. */
function refsOf(env: Env, op: string): string[] {
	const t = env.params.thread;
	const list = (Array.isArray(t) ? t : t === undefined ? [] : [t]).map(r => r.trim()).filter(r => r !== "");
	if (list.length === 0) throw invalid(`${op} needs a thread: an id, an id suffix of 4 or more characters, a name prefix or a job id`, "cloud list shows them");
	return [...new Set(list)];
}

type Settled<T> = { thread: string; ok: true; value: T } | { thread: string; ok: false; error: CloudError };

/** Runs `work` for each reference, resolving it first; one failing never stops the others. */
async function eachThread<T>(env: Env, refs: string[], work: (id: string) => Promise<T>): Promise<Settled<T>[]> {
	return Promise.all(
		refs.map(async (ref): Promise<Settled<T>> => {
			try {
				const id = await env.cloud.resolve(env.ctx, ref, env.signal);
				return { thread: id, ok: true, value: await work(id) };
			} catch (e) {
				return { thread: ref, ok: false, error: asCloudError(e) };
			}
		}),
	);
}


function failures<T>(results: Settled<T>[]): ThreadFailure[] {
	return results.flatMap(r => (r.ok ? [] : [{ thread: r.thread, error: asEnvelope(r.error) }]));
}

/** One line per failed thread; the single failure of a one-thread call is thrown instead, so its envelope is the result's. */
function failureLines(results: Settled<unknown>[]): string[] {
	return results.flatMap(r => (r.ok ? [] : [`${r.thread}: error ${r.error.code}: ${cloudErrorText(r.error)}`]));
}

function throwWhenAllFailed(results: Settled<unknown>[]): void {
	const first = results[0];
	if (first && !first.ok && results.every(r => !r.ok)) throw first.error;
}

function ago(at: string): string {
	const age = formatAge(at, Date.now());
	return age === "" ? "" : age === "now" ? "just now" : `${age} ago`;
}

function costOf(t: Pick<ThreadSummary, "metrics">): number {
	return t.metrics?.usage.cost ?? 0;
}

/** `$0.04`, or `$0` for a thread that has cost nothing. */
function money(n: number): string {
	return formatCost(n) || "$0";
}

function latestTurnText(t: ThreadSummary): string {
	if (!t.latest) return t.turns > 0 ? `${t.turns} turn${t.turns === 1 ? "" : "s"}` : "no turn";
	return `turn ${t.latest.id} ${t.latest.state}`;
}

function rowText(t: ThreadSummary): string {
	const origin = t.origin === "" ? "origin ?" : `by ${t.origin}`;
	const label = t.name || clip(t.title, 50);
	return `- ${t.id} ${label ? `"${label}" ` : ""}[${t.archivedAt ? "archived" : t.phase || "-"}${t.question ? ", waiting for an answer" : ""}] ${origin}${t.scratch ? " scratch" : ""} · ${ago(t.lastActivityAt)} · ${latestTurnText(t)} · ${money(costOf(t))}`;
}

function followLabel(state: { followed: boolean; origin: string; stale: boolean }): "wake" | "silent" | "stale" | "no" {
	if (!state.followed) return "no";
	if (state.stale) return "stale";
	return state.origin === "tool" ? "wake" : "silent";
}

function followText(label: "wake" | "silent" | "stale" | "no"): string {
	switch (label) {
		case "wake":
			return "wake (its results and questions arrive here as [cloud] messages)";
		case "silent":
			return "silent (its results go to the user's tray, not to you; cloud wait or cloud status shows them)";
		case "stale":
			return "stale (lost contact with the cloud; this session keeps retrying)";
		case "no":
			return "no (this session is not following it; cloud status shows its state)";
	}
}

/** The threads of this session that the model started and that have work or a question: the default targets of `wait` and `stop all-mine`. */
async function activeOwnThreads(env: Env): Promise<ThreadSummary[]> {
	await env.session.client.requireCapability("threads.meta");
	const page = await env.session.client.listThreadsPage({ origin: "tool", ...(env.session.sessionId !== "" ? { session: env.session.sessionId } : {}), phase: ACTIVE_PHASES, limit: 200, signal: env.signal });
	return page.threads;
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

export async function info(env: Env): Promise<OpOutput> {
	const who = await env.session.client.whoami({ signal: env.signal });
	const version = who.service.version === "" ? `unknown (api ${who.service.api})` : `${who.service.version} (api ${who.service.api})`;
	const caller = who.device ? `device ${who.device.name}` : "owner";
	const model = env.ctx.model ? `${env.ctx.model.provider}/${env.ctx.model.id}` : "";
	const ids = who.models.map(m => m.id);
	const shown = ids.slice(0, MODELS_LISTED).join(", ");
	const l = who.limits;
	const spend = who.spend === null ? "not reported by this service" : `${money(who.spend.todayUSD)} today, ${who.spend.dayCapUSD > 0 ? `day cap ${money(who.spend.dayCapUSD)}` : "no day cap"}`;
	// A device cannot log the broker in: its owner does that on the server machine.
	const loginOwner = who.device ? "the owner logs the server in with `omp-cloud login <provider>` on the server machine" : "the owner can run /cloud login <provider>";
	const lines = [
		`service: omp-cloud ${version} · you are ${caller} (${who.user})`,
		`capabilities: ${who.capabilities.length > 0 ? who.capabilities.join(", ") : "none reported"}`,
		`models: ${ids.length > 0 ? `${shown}${ids.length > MODELS_LISTED ? ` and ${ids.length - MODELS_LISTED} more` : ""}` : `none yet (${loginOwner})`}`,
		`default model: ${who.defaultModel || "none"} (used only for a delegation that names no model; a delegation runs this session's model unless model is set)`,
		`this session's model: ${model || "none"}${model !== "" ? (modelServed(who.modelPatterns, model) ? " (the cloud can run it)" : ` (the cloud cannot run it yet: delegate with another model, or ${loginOwner})`) : ""}`,
		`limits: message ${l.maxMessageBytes} bytes · answer ${l.maxAnswerBytes} bytes · upload ${formatTokens(l.maxUploadBytes)}B · list ${l.listMax} · turns per thread ${l.maxTurns}`,
		`spend: ${spend}`,
		`vms: ${who.vms.running} running, ${who.vms.paused} paused`,
		`threads: ${who.threads.starting} starting, ${who.threads.working} working, ${who.threads.waiting} waiting, ${who.threads.idle} idle, ${who.threads.failed} failed`,
	];
	const updating = updateLine(who.update, who.device === null);
	if (updating) lines.push(`update: ${updating}`);
	return {
		summary: `omp-cloud ${who.service.version || "?"}`,
		lines,
		details: {
			op: "info",
			service: who.service,
			caller: who.device ? { kind: "device", name: who.device.name } : { kind: "owner", name: who.user },
			capabilities: who.capabilities,
			models: ids,
			defaultModel: who.defaultModel,
			limits: l,
			spend: who.spend,
			vms: who.vms,
			threads: who.threads,
		},
	};
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function list(env: Env): Promise<OpOutput> {
	const { client, sessionId } = env.session;
	const f = env.params.filter ?? {};
	const limit = clamp(env.params.limit, LIST_DEFAULT, 1, LIST_MAX);
	await client.requireCapability("threads.paging");
	if (f.origin !== undefined || f.mine || f.ref !== undefined) await client.requireCapability("threads.meta");
	if (f.since !== undefined && Number.isNaN(Date.parse(f.since))) throw invalid(`filter.since "${f.since}" is not an ISO time such as 2026-10-20T08:00:00Z`);
	const page = await client.listThreadsPage({
		limit,
		before: env.params.cursor,
		phase: f.phase,
		origin: f.origin,
		ref: f.ref,
		...(f.mine && sessionId !== "" ? { session: sessionId } : {}),
		repo: f.repo,
		since: f.since,
		signal: env.signal,
	});
	const lines = page.threads.length > 0 ? page.threads.map(rowText) : ["- none"];
	lines.push(page.next === null ? "end of list" : `next: ${callText({ op: "list", ...(env.params.filter ? { filter: undefined } : {}), cursor: page.next, limit })} (pass the same filter)`);
	return {
		summary: `${page.threads.length} of ${page.total} threads`,
		lines,
		details: {
			op: "list",
			at: Date.now(),
			total: page.total,
			next: page.next,
			threads: page.threads.map(t => ({ id: t.id, name: t.name, phase: t.phase, origin: t.origin, ref: t.ref, scratch: t.scratch, turns: t.turns, costUSD: costOf(t), lastActivityAt: t.lastActivityAt, waiting: t.question !== null, repo: repoLabel({ remoteURL: t.repo.remoteURL, name: t.repo.name, workspace: t.workspace }), card: inventoryThread(t) })),
		},
	};
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function questionBlock(d: ThreadDetail): string[] {
	const q = d.question;
	if (!q) return [];
	const options = q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${clip(o.description, 120)}` : ""}${q.recommended === i ? " (recommended)" : ""}`);
	return [`Question ${q.turn}:${q.id}${q.header ? ` (${q.header})` : ""}: ${clip(q.text, 600)}`, ...(options.length > 0 ? [`Options${q.multi ? " (several allowed)" : ""}: ${options.join("; ")}; free text is always allowed`] : [])];
}

function nextStep(d: ThreadDetail, follow: "wake" | "silent" | "stale" | "no"): string {
	const q = d.question;
	if (d.phase === "waiting" && q) {
		return q.kind === "ask"
			? `${callText({ op: "answer", thread: d.id })} with selected or answer (question ${q.turn}:${q.id}${q.expiresAt ? `, expires ${q.expiresAt}` : ""}); wait is not useful until it is answered`
			: `the user answers this ${q.kind === "push" ? "push approval" : "tool approval"} (${HUMAN_ANSWER_HINT.replace("the user answers it: ", "")}); tell them, do not wait on it`;
	}
	if (d.phase === "starting" || d.phase === "working") {
		return follow === "wake" ? `${callText({ op: "wait", thread: d.id })} blocks until it settles; its result also arrives as a [cloud] message` : `${callText({ op: "wait", thread: d.id })} blocks until it settles (${follow === "silent" ? "its result goes to the user's tray, not to you" : "this session is not woken for it"})`;
	}
	if (d.phase === "failed") return `${callText({ op: "read", thread: d.id, part: "error" })} for the error; a failed thread takes no more messages, delegate again`;
	const latest = [...d.turns].reverse().find(t => t.state === "done" || t.state === "failed");
	if (!latest) return `${callText({ op: "send", thread: d.id })} queues a turn`;
	return `${callText({ op: "read", thread: d.id, turn: latest.id })} for the full reply; ${callText({ op: "diff", thread: d.id, stat: true })} reviews the change; ${callText({ op: "pull", thread: d.id })} brings it here`;
}

function turnBlock(d: ThreadDetail, t: ThreadTurn, replyChars: number): { body: string[]; read: string | undefined } {
	const body = [`Turn ${t.id} ${t.state}${t.title ? ` — ${clip(t.title, 100)}` : ""}`];
	const part: TurnPart = t.state === "failed" ? "error" : "reply";
	const text = part === "error" ? t.error : t.reply;
	let read: string | undefined;
	if (text) {
		body.push(`${part === "error" ? "Error" : "Reply"}: ${truncateText(text, replyChars)}`);
		if (text.length > replyChars) read = callText({ op: "read", thread: d.id, turn: t.id, part, offset: replyChars });
	}
	return { body, read };
}

async function recentEvents(env: Env, id: string): Promise<string[]> {
	await env.session.client.requireCapability("events.json");
	const tail: string[] = [];
	let after = 0;
	let pages = 0;
	for (;;) {
		const page = await env.session.client.eventsPage(id, { after, limit: 500, signal: env.signal });
		for (const e of page.events) tail.push(eventLine(e));
		tail.splice(0, Math.max(0, tail.length - STATUS_EVENTS));
		pages++;
		if (page.next === null) return tail;
		if (pages >= EVENT_PAGES_MAX) return [`(the log is longer than ${EVENT_PAGES_MAX * 500} events; the newest are not shown: use cloud events after=<seq>)`, ...tail];
		after = page.next;
	}
}

function eventLine(e: { seq: number; turn: number | null; kind: string; text: string }): string {
	return `${e.seq} ${e.turn === null ? "-" : `t${e.turn}`} ${e.kind} ${clip(e.text, 240)}`;
}

export async function status(env: Env): Promise<OpOutput> {
	const refs = refsOf(env, "status");
	const include = env.params.include ?? ["turns", "result", "question"];
	const turns = clamp(env.params.turns, STATUS_TURNS_DEFAULT, 0, STATUS_TURNS_MAX);
	const replyChars = clamp(env.params.replyChars, REPLY_CHARS_DEFAULT, 100, REPLY_CHARS_MAX);
	const results = await eachThread(env, refs, async id => {
		const d = await env.session.client.thread(id, { signal: env.signal });
		return { d, events: include.includes("events") ? await recentEvents(env, id) : [] };
	});
	throwWhenAllFailed(results);
	const lines: string[] = [];
	const details: StatusDetail[] = [];
	for (const r of results) {
		if (!r.ok) continue;
		const { d, events } = r.value;
		const follow = followLabel(env.cloud.followState(d.id));
		const job = env.cloud.followState(d.id).jobId;
		if (lines.length > 0) lines.push("");
		lines.push(`thread: ${threadTag(d)} [${d.archivedAt ? "archived" : d.phase || "-"}]`);
		lines.push(`origin: ${d.origin === "" ? "unknown" : d.origin}${d.session !== "" && d.session === env.session.sessionId ? " (this session)" : d.origin === "tool" ? " (another session)" : ""}${d.ref ? ` · ref ${d.ref}` : ""}`);
		lines.push(`workspace: ${d.scratch ? "scratch (an empty repository the cloud made)" : `repo ${d.repo.name}${d.repo.baseRef ? ` (base ${d.repo.baseRef})` : ""}`}`);
		lines.push(`model: ${d.model || "service default"}${d.thinking ? ` · thinking ${d.thinking}` : ""}`);
		lines.push(`following: ${followText(follow)}${job ? `; job ${job}` : ""}`);
		const used = metricsLine(d.metrics);
		if (used !== "") lines.push(`used: ${used}`);
		if (d.queued > 0) lines.push(`queued: ${plural(d.queued, "turn")}`);
		const body: string[] = [];
		if (d.activity) body.push(`Activity (${d.activity.kind}): ${clip(d.activity.text, 200)}`);
		if (include.includes("question")) body.push(...questionBlock(d));
		const reads: string[] = [];
		if (include.includes("turns")) {
			for (const t of d.turns.slice(-turns)) {
				const block = turnBlock(d, t, replyChars);
				body.push(...block.body);
				if (block.read) reads.push(block.read);
			}
		}
		if (events.length > 0) body.push("Recent events:", ...events);
		lines.push(...cloudFence(d.id, undefined, body));
		for (const read of reads) lines.push(`read: ${read}`);
		const result = d.result;
		if (include.includes("result")) {
			lines.push(result ? `result: ${result.branch} @ ${result.head.slice(0, 8)} (${diffstat(result)}; ${result.pushed ? pushedText(result) : result.pushError ? "push failed" : "not pushed"})` : "result: none yet");
		}
		if (d.pr) lines.push(`pr: ${d.pr.url}`);
		if (d.question) lines.push(`question: ${d.question.kind}${d.question.expiresAt ? `, expires ${d.question.expiresAt}` : ", no timeout"}`);
		lines.push(`next: ${nextStep(d, follow)}`);
		details.push({
			id: d.id,
			name: d.name,
			phase: d.phase,
			origin: d.origin,
			scratch: d.scratch,
			model: d.model,
			following: follow,
			job: job ?? null,
			turns: d.turns.length,
			question: d.question ? { turn: d.question.turn, id: d.question.id, kind: d.question.kind, expiresAt: d.question.expiresAt } : null,
			result: result ? { branch: result.branch, head: result.head, pushed: result.pushed } : null,
			view: jobView(d),
		});
	}
	lines.push(...failureLines(results));
	return { summary: details.length === 1 && details[0] ? `${details[0].id} ${details[0].phase}` : `${details.length} of ${refs.length} threads`, lines, details: { op: "status", at: Date.now(), threads: details, failures: failures(results) } };
}

export interface StatusDetail {
	id: string;
	name: string;
	phase: ThreadPhase;
	origin: string;
	scratch: boolean;
	model: string;
	following: "wake" | "silent" | "stale" | "no";
	job: string | null;
	turns: number;
	question: { turn: number; id: number; kind: string; expiresAt: string | null } | null;
	result: { branch: string; head: string; pushed: boolean } | null;
	/** The thread as its job tile draws it when the status was read. */
	view: CloudJobThread;
}

// ---------------------------------------------------------------------------
// read, events
// ---------------------------------------------------------------------------

export async function read(env: Env): Promise<OpOutput> {
	const [ref] = refsOf(env, "read");
	if (!ref) throw invalid("read needs a thread");
	if (refsOf(env, "read").length > 1) throw invalid("read takes one thread");
	const { client } = env.session;
	const id = await env.cloud.resolve(env.ctx, ref, env.signal);
	// Without a page asked for, the latest result is `agent://<id>`, which omp's own handler serves: the same text `read agent://<id>` shows.
	if (env.params.turn === undefined && env.params.part === undefined && env.params.offset === undefined && env.params.limit === undefined) {
		const native = await env.cloud.readAgent(id).catch(() => undefined);
		if (native) {
			return {
				summary: `${id} agent://${native.id}, ${native.text.length} characters`,
				lines: [`agent://${native.id} (turn ${native.turn}; \`agent://${native.id}/<field>\` reads a field of its result)`, ...cloudFence(id, native.turn, native.text === "" ? ["(empty)"] : [native.text])],
				details: { op: "read", thread: id, turn: native.turn, part: "reply", offset: 0, end: native.text.length, total: native.text.length, next: null },
			};
		}
	}
	await client.requireCapability("turns.reply");
	let turn = env.params.turn;
	let part = env.params.part;
	if (turn === undefined) {
		const d = await client.thread(id, { signal: env.signal });
		const finished = [...d.turns].reverse().find(t => t.state === "done" || t.state === "failed" || t.state === "cancelled");
		if (!finished) throw conflict(`${id} has no finished turn yet`, `${callText({ op: "status", thread: id })} shows where it is`);
		turn = finished.id;
		part ??= finished.state === "failed" || (finished.state === "cancelled" && finished.reply === "") ? "error" : "reply";
	}
	part ??= "reply";
	const limit = clamp(env.params.limit, READ_DEFAULT, 1, READ_MAX);
	const offset = clamp(env.params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
	const page = await client.turnText(id, turn, { part, offset, limit, signal: env.signal });
	const end = page.offset + page.text.length;
	const lines = [`range: ${page.offset}-${end} of ${page.total} characters`];
	lines.push(...cloudFence(id, page.turn, page.text === "" ? ["(empty)"] : [page.text]));
	lines.push(page.next === null ? "end: all of the text has been shown" : `next: ${callText({ op: "read", thread: id, turn: page.turn, part: page.part, offset: page.next, limit })}`);
	return {
		summary: `${id} turn ${page.turn} ${page.part}, offset ${page.offset}-${end} of ${page.total}${page.next === null ? "" : `; next offset=${page.next}`}`,
		lines,
		details: { op: "read", thread: id, turn: page.turn, part: page.part, offset: page.offset, end, total: page.total, next: page.next },
	};
}

export async function events(env: Env): Promise<OpOutput> {
	const refs = refsOf(env, "events");
	if (refs.length > 1 || !refs[0]) throw invalid("events takes one thread");
	await env.session.client.requireCapability("events.json");
	const id = await env.cloud.resolve(env.ctx, refs[0], env.signal);
	const limit = clamp(env.params.limit, EVENTS_DEFAULT, 1, EVENTS_MAX);
	const after = clamp(env.params.after, 0, 0, Number.MAX_SAFE_INTEGER);
	const page = await env.session.client.eventsPage(id, { after, limit, kinds: env.params.kinds, turn: env.params.turn, signal: env.signal });
	const lines = page.events.length > 0 ? cloudFence(id, env.params.turn, ["seq turn kind text", ...page.events.map(eventLine)]) : ["no events"];
	lines.push(page.next === null ? "end: no more events" : `next: after=${page.next} (${callText({ op: "events", thread: id, after: page.next, limit })})`);
	return {
		summary: `${id}: ${plural(page.events.length, "event")} after seq ${after}`,
		lines,
		details: { op: "events", thread: id, after, count: page.events.length, next: page.next },
	};
}

// ---------------------------------------------------------------------------
// diff, files
// ---------------------------------------------------------------------------

export async function diff(env: Env): Promise<OpOutput> {
	const refs = refsOf(env, "diff");
	if (refs.length > 1 || !refs[0]) throw invalid("diff takes one thread");
	const { client } = env.session;
	await client.requireCapability("inspect");
	const id = await env.cloud.resolve(env.ctx, refs[0], env.signal);
	const maxBytes = clamp(env.params.maxBytes, DIFF_DEFAULT, 1, DIFF_MAX);
	const query = { turn: env.params.turn, path: env.params.path, maxBytes, signal: env.signal };
	if (env.params.stat) {
		const { stat } = await client.diff(id, { ...query, stat: true });
		const lines = cloudFence(id, env.params.turn, stat.files.map(f => `${f.status} +${f.insertions} −${f.deletions} ${f.path}`));
		lines.push(`total: ${plural(stat.files.length, "file")} +${stat.insertions} −${stat.deletions}`, `range: ${stat.base.slice(0, 8)}..${stat.head.slice(0, 8)}`);
		return {
			summary: `${id}: ${plural(stat.files.length, "file")} +${stat.insertions} −${stat.deletions}`,
			lines,
			details: { op: "diff", thread: id, stat: true, files: stat.files.length, insertions: stat.insertions, deletions: stat.deletions, base: stat.base, head: stat.head, truncated: null },
		};
	}
	const result = await client.diff(id, query);
	const lines = [`range: ${result.base.slice(0, 8)}..${result.head.slice(0, 8)}`];
	lines.push(...cloudFence(id, env.params.turn, [result.text === "" ? "(no changes)" : result.text]));
	if (result.truncated !== null) {
		lines.push(`cut: showing ${maxBytes} of ${result.truncated} bytes; narrow it with path=<file>, or raise maxBytes (at most ${DIFF_MAX}); stat: true lists the files`);
	}
	return {
		summary: `${id}: diff ${result.base.slice(0, 8)}..${result.head.slice(0, 8)}${result.truncated === null ? "" : ` (cut at ${maxBytes} of ${result.truncated} bytes)`}`,
		lines,
		details: { op: "diff", thread: id, stat: false, files: null, insertions: null, deletions: null, base: result.base, head: result.head, truncated: result.truncated },
	};
}

export async function files(env: Env): Promise<OpOutput> {
	const refs = refsOf(env, "files");
	if (refs.length > 1 || !refs[0]) throw invalid("files takes one thread");
	const { client } = env.session;
	await client.requireCapability("inspect");
	const id = await env.cloud.resolve(env.ctx, refs[0], env.signal);
	const where = env.params.ref === undefined ? undefined : env.params.ref === "head" || env.params.ref === "base" ? env.params.ref : undefined;
	if (env.params.ref !== undefined && where === undefined) throw invalid(`ref must be "head" or "base" for files, got "${env.params.ref}"`);
	const path = (env.params.path ?? "").replace(/^\/+/, "");
	const listing = async (dir: string): Promise<OpOutput> => {
		const tree = await client.tree(id, { ref: where, path: dir, signal: env.signal });
		const entries = tree.entries.slice(0, TREE_LISTED);
		const lines = entries.map(e => (e.type === "dir" ? `d ${e.path}/` : `f ${e.path} (${e.size} bytes)`));
		if (tree.entries.length > entries.length) lines.push(`and ${tree.entries.length - entries.length} more entries; narrow it with path=<directory>`);
		if (tree.truncated) lines.push("the service cut this listing at its limit");
		if (lines.length === 0) lines.push("(empty)");
		return {
			summary: `${id}: ${plural(tree.entries.length, "entry", "entries")} in ${dir === "" ? "the root" : dir} @ ${tree.ref} ${tree.commit.slice(0, 8)}`,
			lines: cloudFence(id, undefined, lines),
			details: { op: "files", thread: id, kind: "tree", path: dir, ref: tree.ref, commit: tree.commit, entries: tree.entries.length, size: null, next: null },
		};
	};
	if (path === "" || path.endsWith("/")) return listing(path.replace(/\/+$/, ""));
	const limit = clamp(env.params.limit, FILE_DEFAULT, 1, FILE_MAX);
	try {
		const file = await client.file(id, path, { ref: where, offset: clamp(env.params.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit, signal: env.signal });
		const end = file.offset + Buffer.byteLength(file.text);
		const lines = [`file: ${file.path} @ ${file.ref} ${file.commit.slice(0, 8)} · ${file.size} bytes`];
		if (file.binary) lines.push("binary file: its text is not shown");
		else {
			lines.push(`range: bytes ${file.offset}-${end} of ${file.size}`, ...cloudFence(id, undefined, [file.text === "" ? "(empty)" : file.text]));
			lines.push(file.next === null ? "end: all of the file has been shown" : `next: ${callText({ op: "files", thread: id, path: file.path, ref: file.ref, offset: file.next, limit })}`);
		}
		return {
			summary: `${id}: ${file.path} ${file.binary ? "binary" : `bytes ${file.offset}-${end} of ${file.size}`}`,
			lines,
			details: { op: "files", thread: id, kind: "file", path: file.path, ref: file.ref, commit: file.commit, entries: null, size: file.size, next: file.next },
		};
	} catch (e) {
		// A directory path: the service has no such file, but it has the tree.
		if (e instanceof CloudError && e.code === "not_found") {
			const tree = await listing(path).catch(() => undefined);
			if (tree && tree.details.op === "files" && tree.details.entries !== 0) return tree;
		}
		throw e;
	}
}

// ---------------------------------------------------------------------------
// send, answer, stop
// ---------------------------------------------------------------------------

export async function send(env: Env): Promise<OpOutput> {
	const refs = refsOf(env, "send");
	if (refs.length > 1 || !refs[0]) throw invalid("send takes one thread");
	const text = env.params.text;
	if (text === undefined || text.trim() === "") throw invalid("send needs text: the message for the cloud agent");
	const mode = env.params.mode ?? "queue";
	const { client } = env.session;
	if (mode === "interrupt") await client.requireCapability("messages.interrupt");
	const id = await env.cloud.resolve(env.ctx, refs[0], env.signal);
	const before = await client.thread(id, { signal: env.signal });
	if (before.phase === "failed") {
		throw conflict(`${id} has failed and takes no more messages`, `${callText({ op: "read", thread: id, part: "error" })} shows why; ${callText({ op: "pull", thread: id })} brings what it committed; delegate again to start over`);
	}
	// Queue mode is omp's own IRC (`write agent://<id>`), receipt and all; interrupt has no native equivalent and stays the service's.
	const sent =
		mode === "interrupt"
			? await client.sendMessage(id, text, { mode, signal: env.signal }).then(s => ({ turn: s.turn.id as number | null, receipt: null as IrcReceiptKind | null, interrupted: s.interrupted, cancelled: s.cancelled }))
			: await env.cloud.sendIrc(before, text).then(s => ({ ...s, interrupted: false, cancelled: [] as number[] }));
	const adopt = (env.params.follow ?? "wake") === "wake";
	env.cloud.follow(id, { origin: adopt ? "tool" : "user" });
	const state = env.cloud.followState(id);
	const follow = followLabel(state);
	const lines = [`thread: ${threadTag(before)}`];
	if (sent.receipt === null) lines.push(`turn: ${sent.turn} queued${sent.interrupted ? "; the running turn was stopped first" : mode === "interrupt" ? " (nothing was running to interrupt)" : ""}`);
	else if (sent.turn === null) lines.push(`delivered: into the running turn at its next step (${sent.receipt})`);
	else lines.push(`delivered: ${sent.receipt}; turn ${sent.turn} queued`);
	if (sent.cancelled.length > 0) lines.push(`cancelled: turns ${sent.cancelled.join(", ")} (queued turns dropped by the interrupt; send them again if still wanted)`);
	lines.push(`following: ${followText(follow)}`);
	if (before.archivedAt) lines.push("restoring: the thread was archived; its VM restores from the archive first (about a minute)");
	if (state.jobId) lines.push(`job: ${state.jobId} (the host's job list shows the running turn)`);
	lines.push(follow === "wake" ? `next: the reply arrives as a [cloud] message; ${callText({ op: "wait", thread: id })} blocks until it does` : `next: ${callText({ op: "wait", thread: id })} blocks until the turn ends; the reply is not delivered to you on its own`);
	return {
		summary: `${id} ${sent.turn === null ? sent.receipt : `turn ${sent.turn}`}`,
		lines,
		details: { op: "send", thread: id, turn: sent.turn, receipt: sent.receipt, mode, interrupted: sent.interrupted, cancelled: sent.cancelled, following: follow, job: state.jobId ?? null, restoring: before.archivedAt !== null },
	};
}

export async function answer(env: Env): Promise<OpOutput> {
	const refs = refsOf(env, "answer");
	if (refs.length > 1 || !refs[0]) throw invalid("answer takes one thread");
	const p = env.params;
	const id = await env.cloud.resolve(env.ctx, refs[0], env.signal);
	const done = await answerAsModel(env.session.client, id, { question: p.question, selected: p.selected, answer: p.answer });
	const q = done.question;
	const origin = (await env.session.client.thread(id, { signal: env.signal }).catch(() => undefined))?.origin;
	env.cloud.follow(id, { origin: origin === "tool" ? "tool" : "user" });
	const given = [...q.selected, ...(q.answer ? [q.answer] : [])].join(", ");
	const lines = [
		`question: ${done.turn}:${q.id} (${q.kind}) on ${id}`,
		...cloudFence(id, done.turn, [`Question: ${clip(q.text, 300)}`, `Answered: ${clip(given, 300)}`]),
		`expires: ${q.expiresAt ?? "no timeout"}`,
	];
	if (done.left.length > 0) lines.push(`still waiting: ${done.left.map(o => `${o.turn}:${o.question.id} (${o.question.kind})`).join(", ")}`);
	lines.push(`next: ${callText({ op: "wait", thread: id })} blocks until the agent continues`);
	return {
		summary: `question ${done.turn}:${q.id} on ${id}`,
		lines,
		details: { op: "answer", thread: id, turn: done.turn, question: q.id, kind: q.kind, expiresAt: q.expiresAt, selected: q.selected, answer: q.answer, left: done.left.map(o => ({ turn: o.turn, id: o.question.id, kind: o.question.kind })) },
	};
}

export async function stop(env: Env): Promise<OpOutput> {
	const t = env.params.thread;
	let refs: string[];
	if (t === "all-mine") {
		refs = (await activeOwnThreads(env)).map(x => x.id);
		if (refs.length === 0) return { summary: "nothing to stop", lines: ["no thread you started in this session is working or waiting"], details: { op: "stop", outcomes: [], failures: [] } };
	} else {
		refs = refsOf(env, "stop");
	}
	const results = await eachThread(env, refs, id => env.session.client.stop(id, { signal: env.signal }));
	throwWhenAllFailed(results);
	const lines = results.flatMap(r => (r.ok ? [`- ${r.thread}: ${r.value.stoppedRunning ? "running turn aborted" : "no running turn"}, ${plural(r.value.cancelled, "queued turn")} cancelled`] : [`- ${r.thread}: error ${r.error.code}: ${cloudErrorText(r.error)}`]));
	const outcomes = results.flatMap(r => (r.ok ? [{ thread: r.thread, stoppedRunning: r.value.stoppedRunning, cancelled: r.value.cancelled }] : []));
	return { summary: `${outcomes.length} of ${refs.length} stopped`, lines, details: { op: "stop", outcomes, failures: failures(results) } };
}

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

export async function wait(env: Env): Promise<OpOutput> {
	const p = env.params;
	let ids: string[];
	let failed: Settled<string>[] = [];
	if (p.thread === undefined) {
		ids = (await activeOwnThreads(env)).map(x => x.id);
		if (ids.length === 0) return { summary: "nothing to wait for", lines: ["no thread you started in this session is working or waiting; pass thread to wait for another"], details: { op: "wait", at: Date.now(), outcomes: [], failures: [] } };
	} else {
		const resolved = await eachThread(env, refsOf(env, "wait"), async id => id);
		throwWhenAllFailed(resolved);
		ids = resolved.flatMap(r => (r.ok ? [r.value] : []));
		failed = resolved.filter(r => !r.ok);
	}
	const on = p.on ?? ["done", "failed", "question"];
	const until = p.until ?? "any";
	const timeoutSec = clamp(p.timeoutSec, WAIT_DEFAULT_SEC, 1, WAIT_MAX_SEC);
	const results = await env.cloud.waitFor(ids, { until, on, timeoutMs: timeoutSec * 1000, signal: env.signal });
	const lines: string[] = [];
	const outcomes: WaitDetail[] = [];
	for (const r of results) {
		const d = ["done", "failed", "question"].includes(r.outcome) ? await env.session.client.thread(r.threadId, { signal: env.signal }).catch(() => undefined) : undefined;
		// A thread still running or out of reach has no `d` (its line names the bare id), yet its tile needs the thread.
		const view = d ?? (r.outcome === "timeout" || r.outcome === "stale" ? await env.session.client.thread(r.threadId, { signal: env.signal }).catch(() => undefined) : undefined);
		const tag = d ? threadTag(d) : r.threadId;
		const turn = r.turn === undefined ? "" : ` (turn ${r.turn})`;
		let next: string;
		let head: string;
		switch (r.outcome) {
			case "done":
				head = `done${turn}${d?.result ? ` · ${diffstat(d.result)} · ${d.result.branch}` : ""}`;
				next = `${callText({ op: "read", thread: r.threadId, ...(r.turn === undefined ? {} : { turn: r.turn }) })}; ${callText({ op: "pull", thread: r.threadId })} brings the change`;
				break;
			case "failed":
				head = `failed${turn}`;
				next = `${callText({ op: "read", thread: r.threadId, ...(r.turn === undefined ? {} : { turn: r.turn }), part: "error" })}`;
				break;
			case "question": {
				const q = d?.question;
				head = `waiting for an answer${q ? ` (${q.kind}, question ${q.turn}:${q.id}${q.expiresAt ? `, expires ${q.expiresAt}` : ""})` : ""}`;
				next = !q || q.kind === "ask" ? `${callText({ op: "answer", thread: r.threadId })} with selected or answer` : `the user answers this ${q.kind === "push" ? "push approval" : "tool approval"}; tell them`;
				break;
			}
			case "deleted":
				head = "deleted: the thread is gone";
				next = "nothing can be read or pulled from it";
				break;
			case "stale":
				head = "stale: this session lost contact with the cloud";
				next = `${callText({ op: "status", thread: r.threadId })} to check again`;
				break;
			case "timeout":
				head = "still running: not settled within the wait";
				next = `${callText({ op: "wait", thread: r.threadId })} again, or ${callText({ op: "status", thread: r.threadId })}`;
				break;
		}
		lines.push(`- ${tag}: ${head}`);
		const reply = d && r.outcome === "done" ? [...d.turns].reverse().find(t => t.id === r.turn)?.reply : undefined;
		if (reply) lines.push(...cloudFence(r.threadId, r.turn, [`Reply: ${truncateText(reply, EXCERPT_CHARS)}`]));
		if (d?.question && r.outcome === "question") lines.push(...cloudFence(r.threadId, d.question.turn, questionBlock(d)));
		lines.push(`  next: ${next}`);
		outcomes.push({ thread: r.threadId, outcome: r.outcome, turn: r.turn ?? null, view: view ? jobView(view) : null });
	}
	lines.push(...failed.flatMap(f => (f.ok ? [] : [`${f.thread}: error ${f.error.code}: ${cloudErrorText(f.error)}`])));
	const settled = outcomes.filter(o => o.outcome !== "timeout").length;
	return { summary: `${settled} of ${outcomes.length} settled (until ${until})`, lines, details: { op: "wait", until, at: Date.now(), outcomes, failures: failures(failed) } };
}

export interface WaitDetail {
	thread: string;
	outcome: string;
	turn: number | null;
	/** The thread as its job tile draws it when the wait ended; null for one that is gone or could not be read. */
	view: CloudJobThread | null;
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export async function remove(env: Env): Promise<OpOutput> {
	const refs = refsOf(env, "delete");
	if (env.params.confirm !== true) throw invalid("delete needs confirm: true", "deleting a thread removes its VM, results and conversation for good; ask the user when they did not ask for it");
	const results = await eachThread(env, refs, async id => {
		const d = await env.session.client.thread(id, { signal: env.signal });
		const mine = d.origin === "tool" && d.session !== "" && d.session === env.session.sessionId;
		if (!mine && env.params.force !== true) {
			throw new CloudError({
				code: "forbidden",
				message: `${threadTag(d)} was not started by you in this session (${d.origin === "" ? "origin unknown" : `started by ${d.origin}`})`,
				retriable: false,
				outcomeKnown: true,
				hint: "pass force: true only when the user asked to delete this thread",
			});
		}
		await env.session.client.deleteThread(id, { signal: env.signal });
		env.cloud.forgetThread(id);
		return threadTag(d);
	});
	throwWhenAllFailed(results);
	const lines = results.flatMap(r => (r.ok ? [`- deleted ${r.value}`] : [`- ${r.thread}: error ${r.error.code}: ${cloudErrorText(r.error)}`]));
	return { summary: `${results.filter(r => r.ok).length} of ${refs.length} deleted`, lines, details: { op: "delete", deleted: results.flatMap(r => (r.ok ? [r.thread] : [])), failures: failures(results) } };
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

export async function pull(env: Env): Promise<OpOutput> {
	const refs = refsOf(env, "pull");
	if (refs.length > 1 || !refs[0]) throw invalid("pull takes one thread");
	const apply: PullApply = env.params.apply ?? "fetch";
	const id = await env.cloud.resolve(env.ctx, refs[0], env.signal);
	const r = await env.cloud.pull(env.ctx, id, { apply, into: env.params.into, force: env.params.force === true }, env.signal);
	const verb = r.mode === "clone" ? "cloned" : r.mode === "merge" ? "merged" : r.mode === "worktree" ? "checked out" : "fetched";
	const lines = [`mode: ${r.mode}${r.mode === "clone" ? " (a scratch thread: a new repository)" : ""}`, `path: ${r.path}`];
	lines.push(
		r.checkedOutMoved
			? `working tree: the checked-out branch moved (${r.branch} is checked out in ${r.path})`
			: r.movedIn !== undefined
				? `working tree: ${r.branch} is checked out in ${r.movedIn} and was fast-forwarded there; ${r.path} is not touched`
				: "working tree: not touched",
	);
	lines.push(`commits: ${r.commits === undefined ? "unknown (the handoff commit is not in this repository)" : r.commits}`);
	// The subjects are the cloud agent's words.
	const more = r.commits !== undefined && r.commits > r.subjects.length ? [`and ${r.commits - r.subjects.length} more`] : [];
	lines.push(...cloudFence(r.thread, undefined, [...r.subjects, ...more]));
	if (r.session.kind === "saved") lines.push(`session: the cloud agent's conversation was saved as a local omp session; /cloud resume ${r.thread.slice(-6)} continues it`);
	else if (r.session.kind === "failed") lines.push(`session: not saved: ${clip(r.session.reason, 200)}`);
	lines.push(`next: ${r.next}`);
	return {
		summary: `${verb} ${r.branch} @ ${r.head.slice(0, 8)} (+${r.insertions} −${r.deletions}, ${plural(r.filesChanged, "file")})`,
		lines,
		details: { op: "pull", thread: r.thread, mode: r.mode, branch: r.branch, head: r.head, path: r.path, commits: r.commits ?? null, checkedOutMoved: r.checkedOutMoved, movedIn: r.movedIn ?? null, session: r.session.kind },
	};
}
// ---------------------------------------------------------------------------
// delegate
// ---------------------------------------------------------------------------

/** `o` without the keys whose value is undefined. */
function defined<T extends object>(o: T): T {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** The tasks a delegate call asks for: one, or a batch whose shared fields are the defaults of each entry. */
function delegateTasks(p: ToolParams): LaunchTask[] {
	const shared = defined({ model: p.model, thinking: p.thinking, policy: p.policy, workspace: p.workspace, conversation: p.conversation, wip: p.wip });
	if (p.tasks === undefined) {
		if (p.task === undefined) throw invalid("delegate needs task (one instruction) or tasks (1 to 8 independent ones)");
		return [defined({ task: p.task, name: p.name, ref: p.ref, ...shared })];
	}
	if (p.task !== undefined) throw invalid("give delegate either task or tasks, not both");
	if (p.name !== undefined || p.ref !== undefined) throw invalid("name and ref belong to each entry of tasks, not beside it");
	if (p.tasks.length < 1 || p.tasks.length > MAX_BATCH_TASKS) throw invalid(`tasks takes 1 to ${MAX_BATCH_TASKS} entries, got ${p.tasks.length}`);
	const tasks: LaunchTask[] = p.tasks.map(t => ({ ...shared, ...defined(t), ...(shared.policy || t.policy ? { policy: { ...shared.policy, ...t.policy } } : {}) }));
	// The same ref is the same idempotency key: the second task would only find the first one's thread.
	const seen = new Map<string, number>();
	for (const [i, t] of tasks.entries()) {
		if (t.ref === undefined) continue;
		const earlier = seen.get(t.ref);
		if (earlier !== undefined) throw invalid(`ref "${t.ref}" is used by tasks ${earlier + 1} and ${i + 1}; the same ref is the same thread, so each task needs its own`);
		seen.set(t.ref, i);
	}
	return tasks;
}

function progressText(p: LaunchProgress): string {
	const of = p.task === undefined ? "all tasks" : `task ${p.task + 1}`;
	return p.phase === "packing" ? `packing the repository, conversation and setup for ${of}` : `uploading ${of}${p.note ? `: ${p.note}` : ""}`;
}

export async function delegate(env: Env): Promise<OpOutput> {
	const tasks = delegateTasks(env.params);
	const result = await env.cloud.delegate(env.ctx, { tasks, context: env.params.context }, { toolCallId: env.toolCallId, signal: env.signal, onProgress: p => env.progress(progressText(p)) });
	const lines: string[] = [];
	const usedDefault = tasks.some(t => t.workspace === undefined);
	if (usedDefault) {
		lines.push(
			result.defaultWorkspace === "repo"
				? "workspace: repo by default (this directory is inside a git repository)"
				: "workspace: scratch by default (this directory is not a git repository with a commit): the cloud agent works in an empty repository and nothing of this machine's files was shipped",
		);
	}
	const details: DelegateDetail[] = [];
	let started = 0;
	for (const o of result.outcomes) {
		const n = o.index + 1;
		if (!o.ok) {
			lines.push(`task ${n}: error ${o.error.code}${o.error.status === undefined ? "" : ` ${o.error.status}`}: ${cloudErrorText(o.error)}`);
			if (!o.error.outcomeKnown) {
				lines.push(
					o.key === undefined
						? "  outcome: unknown; the thread may exist: cloud list shows it before you repeat the call"
						: `  outcome: unknown; the thread may exist; repeat with ref: ${o.key} (the same ref replays the first thread instead of creating another)`,
				);
			}
			details.push({ ok: false, index: o.index, workspace: o.workspace, key: o.key ?? null, error: asEnvelope(o.error) });
			continue;
		}
		started++;
		const r = o.response;
		const task = tasks[o.index];
		lines.push(`task ${n}: thread ${threadTag(r)}${o.replayed ? " (replayed)" : " started"}`);
		if (o.replayed) lines.push(`  replayed: ${o.key} had already created this thread; nothing was created or uploaded`);
		lines.push(`  workspace: ${o.workspace === "scratch" ? "scratch" : `repo ${o.summary.repo.name}${o.summary.base === "" ? " (full history" : ` (changes since ${o.summary.base}`}${o.summary.wip.files > 0 ? `, ${plural(o.summary.wip.files, "uncommitted file")}` : ""})`}`);
		lines.push(`  model: ${o.summary.model || "service default"}${o.summary.thinking ? ` · thinking ${o.summary.thinking}` : ""}`);
		lines.push(`  branch: ${threadBranch(r.id)}`);
		if (task?.ref !== undefined) lines.push(`  ref: ${task.ref}`);
		if (o.job) lines.push(`  job: ${o.job} (the host's job list shows the running turn)`);
		if (o.summary.conversation !== "included") lines.push(`  conversation: ${o.summary.conversation === "too-large" ? "too large, not shipped" : "not shipped"}`);
		if (o.warnings.length > 0) lines.push(`  warnings: ${o.warnings.join("; ")}`);
		details.push({ ok: true, index: o.index, thread: r.id, name: r.name, job: o.job ?? null, model: o.summary.model, branch: threadBranch(r.id), ref: task?.ref ?? "", key: o.key, replayed: o.replayed, workspace: o.workspace, warnings: o.warnings });
	}
	if (started > 0) lines.push("next: results and questions arrive as [cloud] messages; do not poll. cloud wait blocks until they settle; cloud status <thread> shows one");
	const first = result.outcomes.find((o): o is LaunchFailure => !o.ok);
	const outputDetails: OpDetails = { op: "delegate", defaultWorkspace: result.defaultWorkspace, outcomes: details };
	if (started === 0 && first) return { lines, details: outputDetails, error: first.error };
	const only = result.outcomes.length === 1 ? result.outcomes[0] : undefined;
	const summary = only?.ok ? `${only.replayed ? "found existing thread" : "started"} ${only.response.id}` : `${started} of ${result.outcomes.length} started`;
	return { summary, lines, details: outputDetails };
}

/** Runs the call's op. */
export function run(env: Env): Promise<OpOutput> {
	switch (env.params.op) {
		case "delegate":
			return delegate(env);
		case "list":
			return list(env);
		case "status":
			return status(env);
		case "read":
			return read(env);
		case "events":
			return events(env);
		case "diff":
			return diff(env);
		case "files":
			return files(env);
		case "send":
			return send(env);
		case "answer":
			return answer(env);
		case "stop":
			return stop(env);
		case "wait":
			return wait(env);
		case "pull":
			return pull(env);
		case "delete":
			return remove(env);
		case "info":
			return info(env);
	}
}
