/**
 * The ask bridge's pure half: omp's `ask` tool request becomes the store's questions, and the stored answers become
 * omp's `extension_ui_response`.
 */
import { isRecord } from "../guards";
import {
	ANSWERED_BY_STOP,
	MAX_OPTION_DESCRIPTION_BYTES,
	MAX_OPTION_LABEL_BYTES,
	MAX_OPTIONS,
	MAX_QUESTION_HEADER_BYTES,
	MAX_QUESTION_KEY_BYTES,
	MAX_QUESTION_TEXT_BYTES,
	type Question,
	type QuestionInput,
} from "../store/types";
import { formatDuration } from "./omp-config";

/** The answer of a question that was still open when its turn ended. */
export const ASK_DROPPED = "The question was dropped because the turn ended before it was answered.";

/** One question of omp's `ask` request. */
export interface OmpQuestion {
	id: string;
	question: string;
	header: string;
	options: { label: string; description: string }[];
	multi: boolean;
	/** Index into `options` as omp sent them. */
	recommended: number | null;
}

/** The `ask` request frame of omp: the request id and its questions. */
export interface AskRequest {
	id: string;
	questions: OmpQuestion[];
}

/** `text` cut to at most `max` bytes without splitting a character. */
export function cutBytes(text: string, max: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= max) return text;
	let end = max;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** What an ask that nobody answered within `timeoutSeconds` tells the agent: an answer text, never a cancellation. */
export function expiredAnswer(timeoutSeconds: number): string {
	return `No answer within ${formatDuration(timeoutSeconds)}. Continue with your best judgment, say in your reply what you assumed, and ask again at the end of your turn if it still matters.`;
}

function parseQuestion(raw: unknown): OmpQuestion {
	const q = isRecord(raw) ? raw : {};
	const options = Array.isArray(q.options) ? q.options : [];
	return {
		id: typeof q.id === "string" ? q.id : "",
		question: typeof q.question === "string" ? q.question : "",
		header: typeof q.header === "string" ? q.header : "",
		options: options.map(option => {
			if (typeof option === "string") return { label: option, description: "" };
			const o = isRecord(option) ? option : {};
			return {
				label: typeof o.label === "string" ? o.label : "",
				description: typeof o.description === "string" ? o.description : "",
			};
		}),
		multi: q.multi === true,
		recommended: typeof q.recommended === "number" && Number.isInteger(q.recommended) ? q.recommended : null,
	};
}

/** The request of an `extension_ui_request` frame with `method: "ask"`; null when it is not one. */
export function parseAskRequest(frame: Record<string, unknown>): AskRequest | null {
	if (frame.method !== "ask" || typeof frame.id !== "string" || !Array.isArray(frame.questions)) return null;
	return { id: frame.id, questions: frame.questions.map(parseQuestion) };
}

/**
 * The store's questions for omp's, cut to the store's limits: a key to 200 bytes, a text to 4000, a header to 200;
 * empty and duplicate option labels are skipped, at most 20 options are kept, a label is cut to 200 bytes and a
 * description to 500; `recommended` counts only the kept options. `ompKey` and `ompLabels` keep omp's uncut id and
 * labels (in the order of the kept options), which the answer must name.
 */
export function toQuestionInputs(questions: readonly OmpQuestion[]): QuestionInput[] {
	return questions.map(q => {
		const options: QuestionInput["options"] = [];
		const ompLabels: string[] = [];
		const seen = new Set<string>();
		let recommended: number | null = null;
		for (const [i, option] of q.options.entries()) {
			if (options.length === MAX_OPTIONS) break;
			const label = cutBytes(option.label, MAX_OPTION_LABEL_BYTES);
			if (label === "" || seen.has(label)) continue;
			seen.add(label);
			if (q.recommended === i) recommended = options.length;
			options.push({ label, description: cutBytes(option.description, MAX_OPTION_DESCRIPTION_BYTES) });
			ompLabels.push(option.label);
		}
		return {
			key: cutBytes(q.id, MAX_QUESTION_KEY_BYTES),
			text: cutBytes(q.question, MAX_QUESTION_TEXT_BYTES),
			header: cutBytes(q.header, MAX_QUESTION_HEADER_BYTES),
			options,
			multi: q.multi,
			recommended,
			ompKey: q.id,
			ompLabels,
		};
	});
}

/** The `ompKey` of an approval question (omp's tool approval `select`, relayed as a question). The model picks `ask` ids and never sends a NUL, so it cannot be one. */
export const APPROVAL_OMP_KEY = "\u0000approval";

/** True when the stored questions are one approval of a tool call: it needs `Approve` or `Deny` back, never answers. */
export function isApproval(questions: readonly Question[]): boolean {
	return questions.length === 1 && questions[0]?.ompKey === APPROVAL_OMP_KEY;
}

/** omp's reply to an approval `select`: `Approve` or `Deny`. */
export function approvalReply(requestId: string, approved: boolean): Record<string, unknown> {
	return { type: "extension_ui_response", id: requestId, value: approved ? "Approve" : "Deny" };
}

/** The reply for a stored approval: `Approve` only for the option `Approve` chosen on its own and not expired; everything else (Deny, free text, a timeout, a dropped or stopped question) is `Deny`. */
export function approvalResponse(requestId: string, question: Question): Record<string, unknown> {
	const chosen = question.selected.map(label => {
		const index = question.options.findIndex(option => option.label === label);
		return question.ompLabels[index] ?? label;
	});
	return approvalReply(requestId, !question.expired && chosen.length === 1 && chosen[0] === "Approve");
}

/** True when the store closed every question because the turn was stopped: omp is being aborted and nobody is left to answer. */
export function stoppedByUser(questions: readonly Question[]): boolean {
	return questions.length > 0 && questions.every(q => q.answeredBy === ANSWERED_BY_STOP);
}

/**
 * The `extension_ui_response` for ask `requestId`: one answer per stored question of the ask, in order, naming omp's
 * id and the labels omp offered (`ompLabels`, found by the stored label's option index). A single-choice question
 * with free text or several labels becomes one `customInput` (`"label, label: text"`) because omp refuses a
 * single-choice answer that carries more than one value; an expired question's text is its `customInput`. An approval
 * ({@link isApproval}) is answered with {@link approvalResponse} instead.
 */
export function answersResponse(requestId: string, stored: readonly Question[]): Record<string, unknown> {
	const [first] = stored;
	if (first !== undefined && isApproval(stored)) return approvalResponse(requestId, first);
	const answers = stored.map(question => {
		const answer: { id: string; selectedOptions: string[]; customInput?: string } = { id: question.ompKey, selectedOptions: [] };
		let chosen = question.selected.map(label => {
			const index = question.options.findIndex(option => option.label === label);
			return question.ompLabels[index] ?? label;
		});
		let custom = question.answer;
		if (!question.multi && chosen.length > 0 && (custom !== "" || chosen.length > 1)) {
			custom = chosen.join(", ") + (custom === "" ? "" : `: ${custom}`);
			chosen = [];
		}
		answer.selectedOptions = chosen;
		if (custom !== "") answer.customInput = custom;
		return answer;
	});
	return { type: "extension_ui_response", id: requestId, answers };
}
