import {
	MAX_OPTION_DESCRIPTION_BYTES,
	MAX_OPTION_LABEL_BYTES,
	MAX_OPTIONS,
	MAX_QUESTION_HEADER_BYTES,
	MAX_QUESTION_KEY_BYTES,
	MAX_QUESTION_TEXT_BYTES,
	MAX_TEXT_BYTES,
	type Question,
	type QuestionInput,
	StoreError,
	type ThreadPhase,
} from "./types";

/** The longest title `titleFromReply` returns, in characters (code points). */
export const MAX_TITLE_CHARS = 80;

/** `text` cut to at most `max` characters (code points). */
export function cutChars(text: string, max: number): string {
	// A code point takes one or two UTF-16 units, so a string of at most `max` units cannot be longer in code points.
	if (text.length <= max) return text;
	const points = Array.from(text);
	return points.length <= max ? text : points.slice(0, max).join("");
}

/**
 * The first non-empty line of a reply with leading markdown markers (`#`, `*`, `-`, `>`) and blanks stripped, cut to 80
 * characters; a line of only markers is skipped.
 */
export function titleFromReply(reply: string): string {
	for (const raw of reply.split("\n")) {
		const line = raw.replace(/^[#*\->\s]+/, "").trim();
		if (line !== "") return cutChars(line, MAX_TITLE_CHARS).trim();
	}
	return "";
}

/** Throws "invalid_text" unless a message is 1 to MAX_TEXT_BYTES bytes. */
export function validateText(text: string): void {
	if (text === "" || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
		throw new StoreError("invalid_text", `text must be 1 to ${MAX_TEXT_BYTES} bytes`);
	}
}

/** Throws "invalid_question" naming question `index` (0-based) and the rule it breaks. */
export function validateQuestion(index: number, input: QuestionInput): void {
	const bad = (rule: string): StoreError => new StoreError("invalid_question", `question ${index + 1}: ${rule}`);
	if (input.text.trim() === "" || Buffer.byteLength(input.text) > MAX_QUESTION_TEXT_BYTES) {
		throw bad(`text must be 1 to ${MAX_QUESTION_TEXT_BYTES} bytes`);
	}
	if (Buffer.byteLength(input.key) > MAX_QUESTION_KEY_BYTES) throw bad(`key is longer than ${MAX_QUESTION_KEY_BYTES} bytes`);
	if (Buffer.byteLength(input.header) > MAX_QUESTION_HEADER_BYTES) {
		throw bad(`header is longer than ${MAX_QUESTION_HEADER_BYTES} bytes`);
	}
	if (input.options.length > MAX_OPTIONS) throw bad(`at most ${MAX_OPTIONS} options`);
	if (input.ompLabels.length !== input.options.length) throw bad("ompLabels must have one entry per option");
	const labels = new Set<string>();
	input.options.forEach((option, j) => {
		if (option.label === "" || Buffer.byteLength(option.label) > MAX_OPTION_LABEL_BYTES) {
			throw bad(`option ${j + 1}: label must be 1 to ${MAX_OPTION_LABEL_BYTES} bytes`);
		}
		if (Buffer.byteLength(option.description) > MAX_OPTION_DESCRIPTION_BYTES) {
			throw bad(`option ${j + 1}: description is longer than ${MAX_OPTION_DESCRIPTION_BYTES} bytes`);
		}
		if (labels.has(option.label)) throw bad(`option label ${JSON.stringify(option.label)} is not unique`);
		labels.add(option.label);
	});
	const recommended = input.recommended;
	if (recommended !== null && (!Number.isInteger(recommended) || recommended < 0 || recommended >= input.options.length)) {
		throw bad(`recommended ${recommended} is not an option index`);
	}
}

/** Throws "invalid_answer" unless `selected` and the (already trimmed) `answer` are a valid answer to `question`. */
export function validateAnswer(question: Question, selected: string[], answer: string): void {
	const bad = (rule: string): StoreError => new StoreError("invalid_answer", rule);
	if (selected.length === 0 && answer === "") throw bad("select an option or give an answer");
	if (Buffer.byteLength(answer) > MAX_QUESTION_TEXT_BYTES) throw bad(`answer is longer than ${MAX_QUESTION_TEXT_BYTES} bytes`);
	if (!question.multi && selected.length > 1) throw bad("the question takes one option");
	const seen = new Set<string>();
	for (const label of selected) {
		if (!question.options.some((option) => option.label === label)) {
			throw bad(`${JSON.stringify(label)} is not an option`);
		}
		if (seen.has(label)) throw bad(`option ${JSON.stringify(label)} is selected twice`);
		seen.add(label);
	}
}

/** What the phase of a thread derives from; counts are over the thread's turns. */
export interface PhaseInputs {
	deleted: boolean;
	failed: boolean;
	running: number;
	queued: number;
	/** Turns with a startedAt. */
	started: number;
	/** Unanswered questions of running turns. */
	unanswered: number;
}

/** The one derivation of a thread's phase: deleted > failed > waiting > working > starting > idle. */
export function derivePhase(inputs: PhaseInputs): ThreadPhase {
	if (inputs.deleted) return "deleted";
	if (inputs.failed) return "failed";
	if (inputs.running > 0 && inputs.unanswered > 0) return "waiting";
	if (inputs.running > 0 || (inputs.queued > 0 && inputs.started > 0)) return "working";
	if (inputs.queued > 0) return "starting";
	return "idle";
}
