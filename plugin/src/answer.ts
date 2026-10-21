/** Answering the questions a cloud agent asks: finding the pending ones, parsing typed answers, prompting. */

import type { ExtensionAskDialogResultItem } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import type { CloudClient } from "./api";
import { clip } from "./format";
import { CloudError } from "./errors";
import { UserError, type AnswerBody, type Host, type HostUi, type Question, type QuestionOption, type ThreadDetail } from "./types";

/** The choice that lets the user type a free-text answer. */
export const OTHER = "Other (type your own)";
const DONE = "Done";

export interface Pending {
	turn: number;
	/** Unanswered questions of the oldest pending ask, in order. */
	questions: Question[];
}

function options(q: Pick<Question, "options">): QuestionOption[] {
	return q.options ?? [];
}

/**
 * The questions the thread is waiting on: the unanswered ones of the oldest pending ask of
 * the turn that asked first.
 */
export function pendingQuestions(detail: Pick<ThreadDetail, "turns">): Pending | undefined {
	for (const turn of detail.turns) {
		const open = turn.questions.filter(q => !q.answeredAt && !q.expired);
		if (open.length === 0) continue;
		const oldest = Math.min(...open.map(q => q.ask));
		return { turn: turn.id, questions: open.filter(q => q.ask === oldest).sort((a, b) => a.id - b.id) };
	}
	return undefined;
}

/**
 * A typed answer: text equal to an option label (ignoring case) selects it; for a multi-select
 * question a comma-separated list of labels selects them all; anything else is free text.
 */
export function parseAnswerText(q: Pick<Question, "options" | "multi">, text: string): AnswerBody {
	const t = text.trim();
	const labels = options(q).map(o => o.label);
	const find = (s: string): string | undefined => labels.find(l => l.toLowerCase() === s.trim().toLowerCase());
	const whole = find(t);
	if (whole) return { selected: [whole] };
	if (q.multi) {
		const parts = t.split(",").map(p => p.trim()).filter(p => p !== "");
		const picked = parts.map(find);
		if (parts.length > 1 && picked.every((p): p is string => p !== undefined)) return { selected: [...new Set(picked)] };
	}
	return { answer: t };
}

function optionLabel(o: QuestionOption, i: number, recommended: number | null | undefined): string {
	return `${o.label}${recommended === i ? " (recommended)" : ""}${o.description ? ` — ${clip(o.description, 100)}` : ""}`;
}

/** True for the questions only the user decides: a tool approval (`approval:*`) and the push (`omp-cloud:push`). */
export function isPermission(q: Pick<Question, "kind" | "key">): boolean {
	return q.kind === "approval" || q.kind === "push" || q.key.startsWith("approval:") || q.key === "omp-cloud:push";
}

const APPROVE_LABELS = ["Approve", "Push"];
const DENY_LABELS = ["Deny", "Do not push"];

/** The labels that approve and deny a permission question: the service's own (`Approve`/`Deny`, `Push`/`Do not push`), else its first and second option. */
function permissionLabels(q: Pick<Question, "options">): { approve: QuestionOption; deny: string } | undefined {
	const opts = options(q);
	const approve = opts.find(o => APPROVE_LABELS.includes(o.label)) ?? opts[0];
	const deny = opts.find(o => DENY_LABELS.includes(o.label)) ?? opts[1];
	return approve && deny && approve.label !== deny.label ? { approve, deny: deny.label } : undefined;
}

/** True when omp's own approval prompt answers `q`: the host has `approve` and `q` is a permission question with an approve and a deny choice. */
export function usesApprove(ui: Pick<HostUi, "approve">, q: Pick<Question, "kind" | "key" | "options">): boolean {
	return ui.approve !== undefined && isPermission(q) && permissionLabels(q) !== undefined;
}

/** True when answering `q` goes through omp's own dialogs (the ask dialog or the approval prompt) instead of select/input. */
export function usesNativeDialog(ui: Pick<HostUi, "askDialog" | "approve">, q: Pick<Question, "kind" | "key" | "options">): boolean {
	return ui.askDialog !== undefined || usesApprove(ui, q);
}

/** How a prompt behaves beyond the host's choice of dialog. */
export interface AskOptions {
	/** Closes the prompt unanswered (the host resolves it undefined, and a queued one is never shown). */
	signal?: AbortSignal;
	/** Never fall back to select and input: an unanswered native prompt stays unanswered. */
	nativeOnly?: boolean;
}

/**
 * One approval through `ui.approve`: once, session and a grant approve this call (the service has no remembered approvals, so the
 * prompt offers neither), deny denies. Undefined when the host gave no usable answer.
 */
async function askApproval(ui: Pick<HostUi, "approve">, thread: string, q: Question, signal?: AbortSignal): Promise<AnswerBody | undefined> {
	const labels = permissionLabels(q);
	if (!ui.approve || !labels) return undefined;
	const title = `☁ ${thread} · ${q.kind === "push" || q.key === "omp-cloud:push" ? "push" : "tool approval"}`;
	const detail = [q.text, labels.approve.description].filter(s => s !== "").join("\n");
	const first = q.text.split("\n").find(l => l.trim() !== "") ?? "";
	const answer = await ui.approve({ full: `${title}\n${detail}`, compact: `${title} — ${clip(first, 100)}` }, signal ? { signal } : undefined);
	if (answer === "deny") return { selected: [labels.deny] };
	if (answer === "once" || answer === "session" || (typeof answer === "object" && answer !== null && "grant" in answer)) {
		return { selected: [labels.approve.label] };
	}
	return undefined;
}

/** The ask-dialog answer of one question as the service takes it: the options, the typed text and the note (as the free text). Undefined when it holds no answer. */
function dialogBody(item: ExtensionAskDialogResultItem): AnswerBody | undefined {
	const selected = item.selectedOptions ?? [];
	const text = [item.customInput, item.note].map(s => s?.trim() ?? "").filter(s => s !== "").join("\n");
	if (selected.length === 0 && text === "") return undefined;
	return { ...(selected.length > 0 ? { selected: [...selected] } : {}), ...(text !== "" ? { answer: text } : {}) };
}

/**
 * Asks `questions` in one omp ask dialog (a tab each, options with their descriptions, multi-select, the recommended option,
 * Other and notes). The answers by question id; undefined when the user cancels or asks to chat instead. A question the
 * dialog returned nothing for is missing from the map.
 */
async function askDialog(ui: Pick<HostUi, "askDialog">, thread: string, questions: readonly Question[], signal?: AbortSignal): Promise<Map<number, AnswerBody> | undefined> {
	if (!ui.askDialog) return undefined;
	const single = questions.length === 1;
	const result = await ui.askDialog(
		questions.map(q => {
			const header = q.header !== "" ? q.header : single ? thread : undefined;
			const recommended = q.recommended !== null && q.recommended !== undefined && q.recommended >= 0 && q.recommended < options(q).length ? q.recommended : undefined;
			return {
				id: String(q.id),
				question: q.text,
				...(header !== undefined ? { header } : {}),
				options: options(q).map(o => (o.description !== "" ? { label: o.label, description: o.description } : { label: o.label })),
				multi: q.multi,
				...(recommended !== undefined ? { recommended } : {}),
			};
		}),
		signal ? { signal } : undefined,
	);
	if (!result || result.kind !== "submit") return undefined;
	const answers = new Map<number, AnswerBody>();
	for (const item of result.results) {
		const body = dialogBody(item);
		if (body) answers.set(Number(item.id), body);
	}
	return answers;
}

/**
 * Prompts for one question. Undefined when the user cancels. A permission question goes through `ui.approve` and any other
 * through `ui.askDialog` when the host has them; otherwise (or when `approve` gave no answer) through select and input.
 */
export async function askUser(ui: HostUi, thread: string, q: Question, opts: AskOptions = {}): Promise<AnswerBody | undefined> {
	if (usesApprove(ui, q)) {
		const approved = await askApproval(ui, thread, q, opts.signal);
		if (approved || opts.nativeOnly) return approved;
	} else if (ui.askDialog) {
		return (await askDialog(ui, thread, [q], opts.signal))?.get(q.id);
	}
	return opts.nativeOnly ? undefined : await askBySelect(ui, thread, q);
}

/**
 * Prompts for every question of an ask, in order, stopping at the first one left unanswered: the answers by question, the
 * unanswered ones undefined. With `ui.askDialog` all the questions that are not approvals share one dialog.
 */
export async function askAll(ui: HostUi, thread: string, questions: readonly Question[], opts: AskOptions = {}): Promise<(AnswerBody | undefined)[]> {
	const shared = ui.askDialog ? questions.filter(q => !usesApprove(ui, q)) : [];
	let dialog: Map<number, AnswerBody> | undefined;
	let asked = false;
	const out: (AnswerBody | undefined)[] = [];
	for (const q of questions) {
		let body: AnswerBody | undefined;
		if (shared.includes(q)) {
			if (!asked) {
				dialog = await askDialog(ui, thread, shared, opts.signal);
				asked = true;
			}
			body = dialog?.get(q.id);
		} else {
			body = await askUser(ui, thread, q, opts);
		}
		out.push(body);
		if (!body) break;
	}
	while (out.length < questions.length) out.push(undefined);
	return out;
}

/** Prompts for one question with select and input. Undefined when the user cancels. */
async function askBySelect(ui: HostUi, thread: string, q: Question): Promise<AnswerBody | undefined> {
	const title = `${thread}${q.header ? ` · ${q.header}` : ""}: ${clip(q.text, 300)}`;
	const opts = options(q);
	if (opts.length === 0 ? !ui.input : !ui.select) {
		throw new UserError("☁ this host cannot prompt; answer with /cloud answer <id> <text>");
	}
	const typed = async (): Promise<string | undefined> => (await ui.input?.(title, "your answer"))?.trim() || undefined;
	if (opts.length === 0) {
		const t = await typed();
		return t ? { answer: t } : undefined;
	}
	const chosen: string[] = [];
	for (;;) {
		const left = opts.map((o, i) => ({ o, i })).filter(({ o }) => !chosen.includes(o.label));
		const done = `${DONE} (${chosen.length} selected)`;
		const items = [...left.map(({ o, i }) => optionLabel(o, i, q.recommended)), ...(q.multi && chosen.length > 0 ? [done] : []), OTHER];
		const picked = await ui.select?.(q.multi ? `${title} (select several)` : title, items);
		if (picked === undefined) return undefined;
		if (q.multi && picked === done) return { selected: chosen };
		if (picked === OTHER) {
			const t = await typed();
			if (!t) return undefined;
			return chosen.length > 0 ? { selected: chosen, answer: t } : { answer: t };
		}
		const hit = left[items.indexOf(picked)];
		if (!hit) return undefined;
		if (!q.multi) return { selected: [hit.o.label] };
		chosen.push(hit.o.label);
	}
}

export interface AnswerOutcome {
	answered: Question[];
	/** Questions of the ask that still wait (the user cancelled before them). */
	left: number;
	/** The turn and the questions of the ask that was prompted for, answered or not; empty when `text` answered. */
	turn: number;
	asked: Question[];
}

/**
 * Answers the thread's pending question(s). With `text`, answers the first one (a label selects
 * it, anything else is free text); without, prompts for each question of the oldest pending ask
 * in order and stops at the first cancel.
 */
export async function answerThread(
	client: Pick<CloudClient, "thread" | "answer">,
	thread: string,
	ui: HostUi,
	text?: string,
): Promise<AnswerOutcome> {
	const detail = await client.thread(thread);
	const pending = pendingQuestions(detail);
	if (!pending) throw new UserError(`☁ ${thread} has no question waiting`);
	const answered: Question[] = [];
	const [first] = pending.questions;
	const typed = text !== undefined && text.trim() !== "";
	const bodies = typed && first ? [parseAnswerText(first, text)] : await askAll(ui, thread, pending.questions);
	for (const [i, q] of pending.questions.entries()) {
		const body = bodies[i];
		if (!body) break;
		answered.push(await client.answer(thread, pending.turn, q.id, body));
	}
	return { answered, left: pending.questions.length - answered.length, turn: pending.turn, asked: typed ? [] : pending.questions };
}

/** What an {@link AutoAsker} needs from the extension around it. */
export interface AutoAskDeps {
	/** Sends one answer (the cloud client's `answer`, through the host's current connection). */
	answer(host: Host, thread: string, turn: number, id: number, body: AnswerBody): Promise<Question>;
	/** True when the model, not the user, answers the `ask` questions of `thread` (a thread it started); the user's own questions (approvals, the push) open regardless. */
	modelOwns(host: Host, thread: string): boolean;
	/** What an answer did: what was answered and how many questions of the ask still wait (notifications, the inbox, following the thread on). */
	answered(host: Host, thread: string, answered: Question[], left: number): Promise<void>;
	/** A thread as notifications name it: its name (else title) and its id. */
	tag(thread: string): string;
}

interface OpenAsk {
	thread: string;
	turn: number;
	ids: number[];
	abort: AbortController;
}

/**
 * Opens omp's own dialogs by itself when a followed thread asks, as omp does for its own `ask`: at once, even while the agent
 * streams (the host serializes dialogs, queueing a second behind the open one, and guards a half-typed prompt), every pending
 * question of the ask in one ask dialog and approvals in omp's approval prompt. A question is offered once: dismissing the
 * dialog leaves it to the card and `/cloud answer`, and answering it elsewhere, expiring or deleting the thread closes the
 * dialog (a queued one is never shown). A host without `askDialog` is offered nothing, so the card flow is all there is.
 */
export class AutoAsker {
	readonly #deps: AutoAskDeps;
	readonly #offered = new Set<string>();
	readonly #open = new Set<OpenAsk>();
	/** `<thread>:<turn>:<question>` of the questions the how-to-answer notice was shown for. */
	readonly #told = new Set<string>();

	constructor(deps: AutoAskDeps) {
		this.#deps = deps;
	}

	/** Opens the dialogs for `thread`'s pending ask unless they were offered already. Settles when the dialog is answered, dismissed or closed. */
	async open(host: Host, thread: ThreadDetail): Promise<void> {
		const pending = pendingQuestions(thread);
		if (!pending) return;
		const modelOwns = this.#deps.modelOwns(host, thread.id);
		const offer = pending.questions.filter(q => !this.#offered.has(`${thread.id}:${pending.turn}:${q.id}`) && usesNativeDialog(host.ui, q) && (isPermission(q) || !modelOwns));
		if (offer.length === 0) return;
		for (const q of offer) this.#offered.add(`${thread.id}:${pending.turn}:${q.id}`);
		const ask: OpenAsk = { thread: thread.id, turn: pending.turn, ids: offer.map(q => q.id), abort: new AbortController() };
		this.#open.add(ask);
		// The service expires a question itself; the dialog must not answer it with a recommendation first, so it closes at that time.
		const expiry = Math.min(...offer.map(q => (q.expiresAt ? Date.parse(q.expiresAt) : Number.POSITIVE_INFINITY)));
		const timer = Number.isFinite(expiry) ? host.setTimeout(() => ask.abort.abort(), Math.max(0, expiry - Date.now())) : undefined;
		try {
			const bodies = await askAll(host.ui, thread.id, offer, { signal: ask.abort.signal, nativeOnly: true });
			const answered: Question[] = [];
			for (const [i, q] of offer.entries()) {
				const body = bodies[i];
				if (!body || ask.abort.signal.aborted) break;
				answered.push(await this.#deps.answer(host, thread.id, pending.turn, q.id, body));
			}
			if (answered.length > 0) await this.#deps.answered(host, thread.id, answered, pending.questions.length - answered.length);
			else if (!ask.abort.signal.aborted) this.unanswered(host, thread.id, pending.turn, offer);
		} catch (e) {
			host.ui.notify(`☁ could not send the answer: ${e instanceof Error ? e.message : String(e)}`, "error");
		} finally {
			if (timer !== undefined) host.clearTimer(timer);
			this.#open.delete(ask);
		}
	}

	/**
	 * A dialog that returned no answer (dismissed, or a host that cannot draw it and cancels every dialog) leaves its questions
	 * pending with nothing on screen to say so: one quiet notice per question names how to answer. It never reopens a dialog and
	 * never answers. Only questions a native dialog was meant for are named; the select/input flow has its own "cancelled".
	 */
	unanswered(host: Host, thread: string, turn: number, questions: readonly Question[]): void {
		const fresh = questions.filter(q => usesNativeDialog(host.ui, q) && !this.#told.has(`${thread}:${turn}:${q.id}`));
		if (fresh.length === 0) return;
		for (const q of fresh) this.#told.add(`${thread}:${turn}:${q.id}`);
		host.ui.notify(`☁ ${this.#deps.tag(thread)} still waits for an answer: /cloud answer ${thread.slice(-6)} <text> (the card's buttons work too where shown)`, "info");
	}

	/** `thread` as it now is: closes the dialogs of questions that are no longer open (answered elsewhere, expired). */
	settle(thread: ThreadDetail): void {
		const open = new Set(thread.turns.flatMap(t => t.questions.filter(q => !q.answeredAt && !q.expired).map(q => `${t.id}:${q.id}`)));
		for (const ask of this.#open) {
			if (ask.thread === thread.id && !ask.ids.every(id => open.has(`${ask.turn}:${id}`))) ask.abort.abort();
		}
	}

	/** Closes every dialog still open (the thread is gone, or the session ends). Offered questions stay offered. */
	close(thread?: string): void {
		for (const ask of this.#open) {
			if (thread === undefined || ask.thread === thread) ask.abort.abort();
		}
	}
}

/** One line describing an answer, for notifications and tool results. */
export function answerSummary(q: Question): string {
	const parts = [...(q.selected ?? []), ...(q.answer ? [q.answer] : [])];
	return `"${clip(q.text, 60)}" → ${clip(parts.join(", "), 80)}`;
}

/** Where the model is sent when a question is not its to answer. */
export const HUMAN_ANSWER_HINT = "the user answers it: /cloud answer or the card buttons";

/** An unanswered, unexpired question and the turn that asked it. */
export interface OpenQuestion {
	turn: number;
	question: Question;
}

/** Every question the thread waits on, oldest first (by turn, then ask, then id). */
export function openQuestions(detail: Pick<ThreadDetail, "turns">): OpenQuestion[] {
	return detail.turns
		.flatMap(t => t.questions.filter(q => !q.answeredAt && !q.expired).map(question => ({ turn: t.id, question })))
		.sort((a, b) => a.turn - b.turn || a.question.ask - b.question.ask || a.question.id - b.question.id);
}

export interface ModelAnswerInput {
	/** The question to answer; the oldest pending one when absent. */
	question?: { turn: number; id: number };
	selected?: string[];
	answer?: string;
}

export interface ModelAnswer {
	turn: number;
	/** The question as the service recorded the answer. */
	question: Question;
	/** Questions that still wait on the thread. */
	left: OpenQuestion[];
}

function invalid(message: string, hint?: string): CloudError {
	return new CloudError({ code: "invalid", message, retriable: false, outcomeKnown: true, hint });
}

/**
 * Answers one question for the model: `ask` questions only. Approval and push questions are the user's decision and are
 * refused with `forbidden`, whatever the answer says (free text on an approval silently denies it).
 */
export async function answerAsModel(client: Pick<CloudClient, "thread" | "answer">, thread: string, input: ModelAnswerInput): Promise<ModelAnswer> {
	const open = openQuestions(await client.thread(thread));
	const target = input.question
		? open.find(o => o.turn === input.question?.turn && o.question.id === input.question.id)
		: open[0];
	if (!target) {
		const wanted = input.question ? `question ${input.question.turn}:${input.question.id} on ${thread} is not waiting for an answer` : `${thread} has no question waiting`;
		const waiting = open.map(o => `${o.turn}:${o.question.id} (${o.question.kind})`);
		throw new CloudError({
			code: "conflict",
			message: wanted,
			retriable: false,
			outcomeKnown: true,
			hint: waiting.length > 0 ? `waiting: ${waiting.join(", ")}` : "use cloud status to see the thread's state",
		});
	}
	const { turn, question } = target;
	if (question.kind !== "ask") {
		throw new CloudError({
			code: "forbidden",
			message: `question ${turn}:${question.id} on ${thread} is ${question.kind === "push" ? "a push approval" : "a tool approval"} (${clip(question.text, 100)}); only the user decides it`,
			retriable: false,
			outcomeKnown: true,
			hint: HUMAN_ANSWER_HINT,
		});
	}
	const body: AnswerBody = {};
	if (input.selected && input.selected.length > 0) {
		const labels = options(question).map(o => o.label);
		if (labels.length === 0) throw invalid(`question ${turn}:${question.id} offers no options to select; send answer text instead`);
		if (!question.multi && input.selected.length > 1) throw invalid(`question ${turn}:${question.id} takes one option`);
		body.selected = input.selected.map(s => {
			const label = labels.find(l => l.toLowerCase() === s.trim().toLowerCase());
			if (!label) throw invalid(`"${clip(s, 60)}" is not an option of question ${turn}:${question.id}`, `options: ${labels.join(" | ")}`);
			return label;
		});
	}
	if (input.answer !== undefined && input.answer.trim() !== "") body.answer = input.answer.trim();
	if (!body.selected && body.answer === undefined) throw invalid("answer needs selected option labels or an answer text");
	const answered = await client.answer(thread, turn, question.id, body);
	return { turn, question: answered, left: open.filter(o => o !== target) };
}
