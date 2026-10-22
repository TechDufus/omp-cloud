/**
 * A finished turn of a cloud agent as omp's `<task-result>` (omp's `prompts/tools/task-summary.md`), the shape the model reads
 * a subagent's result in. omp's own `formatTaskResultSummary` reads the AgentRegistry, so this renders the template itself.
 */

import { prLine, formatTokens } from "./format";
import type { ThreadResult } from "./types";
import { resultLine } from "./watch";

/** omp's harness tags (`session/harness-tags.ts`) and this envelope's own tags: `<` becomes `&lt;`, so a reply can neither close the envelope nor forge a notice. */
const RESULT_TAG_START_RE = /<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*|task-result|output|preview|meta|error|abort-reason|cloud-result|cloud-output)(?![\w-]))/gi;

export function escapeResultText(text: string): string {
	return text.replace(RESULT_TAG_START_RE, "&lt;");
}

/** omp's FULL_OUTPUT_THRESHOLD (`task/result-summary.ts:16`): a longer output is previewed, its full text is `agent://<id>`. */
export const FULL_OUTPUT_THRESHOLD = 5000;

/** Where the preview may be cut back to a line end: not before this many characters. */
const PREVIEW_CUT_MIN = FULL_OUTPUT_THRESHOLD / 2;

export interface TaskResultInput {
	/** The agent id: what `agent://<id>` reads. */
	id: string;
	status: "completed" | "failed" | "cancelled";
	/** `4m12s`; empty when unknown. */
	duration: string;
	reply: string;
	/** The turn's error; empty for a completed turn. */
	error: string;
	thread: string;
	turn: number;
	result: ThreadResult | null;
	/** The pull request URL; empty when none. */
	pr: string;
}

export function taskResultText(r: TaskResultInput): string {
	const reply = r.reply.trim();
	const error = r.error.trim();
	const output = reply !== "" ? reply : r.status === "failed" && error !== "" ? error : "(no output)";
	const truncated = output.length > FULL_OUTPUT_THRESHOLD;
	const lines = [`<task-result id="${r.id}" agent="cloud" status="${r.status}" duration="${r.duration === "" ? "unknown" : r.duration}">`];
	if (truncated) lines.push(`<meta lines="${output.split("\n").length}" size="${formatTokens(output.length)}B" />`);
	if (r.status === "cancelled") lines.push(`<abort-reason>${escapeResultText(error === "" ? "stopped" : error)} — the agent is still live with its full context; message it via \`write agent://${r.id}\` to resume instead of redoing the work.</abort-reason>`);
	if (r.status === "failed" && reply !== "" && error !== "") lines.push(`<error>${escapeResultText(error)}</error>`);
	if (truncated) {
		const cut = output.slice(0, FULL_OUTPUT_THRESHOLD);
		const at = cut.lastIndexOf("\n");
		lines.push(`<preview full-output="agent://${r.id}">`, escapeResultText(at >= PREVIEW_CUT_MIN ? cut.slice(0, at) : cut), "</preview>");
	} else {
		lines.push("<output>", escapeResultText(output), "</output>");
	}
	lines.push("<cloud-result>", `thread ${r.thread} · turn ${r.turn}`, escapeResultText(resultLine(r.result)));
	if (r.pr !== "") lines.push(escapeResultText(prLine(r.pr)));
	lines.push("</cloud-result>", "</task-result>");
	return lines.join("\n");
}
