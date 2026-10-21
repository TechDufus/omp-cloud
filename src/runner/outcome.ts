/** How a prompt ended, as the thread's turn reports it. */
import type { AssistantEnd } from "./progress";

/** The part of omp's `prompt_result` frame that decides the outcome. */
export interface PromptResult {
	status: string;
	error?: { message?: string; httpStatus?: number };
}

export interface TurnOutcome {
	outcome: "completed" | "failed";
	error: string;
}

/** omp reports an HTTP status for direct provider calls; a model behind the gateway only leaves it as the `auth-gateway <status>` message prefix. */
const GATEWAY_STATUS = /^auth-gateway (\d{3})\b/;

/** The HTTP status of a failed prompt; 0 when unknown. */
export function errorStatus(error: { message?: string; httpStatus?: number }): number {
	if (error.httpStatus !== undefined) return error.httpStatus;
	const match = GATEWAY_STATUS.exec(error.message ?? "");
	return match?.[1] === undefined ? 0 : Number(match[1]);
}

function failed(message: string, status: number): TurnOutcome {
	const refused = status === 401 || status === 403;
	return { outcome: "failed", error: refused ? `the gateway refused the request (${status}): ${message}` : message };
}

/**
 * The outcome of a prompt: its `prompt_result` when omp sent one, else how the last assistant message ended (a lost
 * frame, a local-only prompt, or a turn read back from the session after a service restart).
 */
export function classifyPrompt(result: PromptResult | undefined, last: AssistantEnd | null): TurnOutcome {
	if (result !== undefined) {
		if (result.status === "aborted") return failed("prompt aborted", 0);
		if (result.status === "error") {
			const error = result.error;
			if (error === undefined) return failed("prompt failed", 0);
			return failed(error.message ?? "prompt failed", errorStatus(error));
		}
		return { outcome: "completed", error: "" };
	}
	if (last?.stopReason === "error") {
		const message = last.errorMessage === "" ? "prompt failed" : last.errorMessage;
		return failed(message, errorStatus({ message }));
	}
	if (last?.stopReason === "aborted") return failed("prompt aborted", 0);
	return { outcome: "completed", error: "" };
}
