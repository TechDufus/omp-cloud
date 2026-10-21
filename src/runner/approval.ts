/**
 * Tool approvals as questions. With `--no-ui` gone, omp asks over the protocol (`extension_ui_request`, method
 * `select`, title `Allow tool: <tool>` and the options `Approve` and `Deny`) before it runs a tool call the policy
 * marks `prompt` (a `bash.patterns` rule or `tools.approval.<tool>: prompt`, both also under `approvalMode: yolo`). The
 * title has a `Reason:` line for a pattern rule only. The runner shows that as a question to a person and replies
 * `Approve` or `Deny`; a cancelled reply is a denial too. The turn waits inside the tool call and omp has no approval
 * timeout, and its `abort` blocks until every open approval is answered, so the runner times approvals out itself and
 * answers them all before it ever aborts.
 */
import {
	MAX_QUESTION_KEY_BYTES,
	MAX_QUESTION_TEXT_BYTES,
	type QuestionInput,
} from "../store/types";
import { APPROVAL_OMP_KEY, cutBytes } from "./ask";
import { formatDuration } from "./omp-config";

/** The header of an approval question. */
export const APPROVAL_HEADER = "Approval";

/** What the store records as the answer of an approval that was denied because its turn ended first. */
export const APPROVAL_ABORTED = "Denied: the turn ended before the approval was answered.";

const TITLE_PREFIX = "Allow tool: ";

/** One approval request of omp: the frame id, the tool and the whole title (tool, reason, command). */
export interface ApprovalRequest {
	id: string;
	tool: string;
	title: string;
}

/** The approval request of an `extension_ui_request` frame; null for every other frame, including any other `select`. */
export function parseApprovalRequest(frame: Record<string, unknown>): ApprovalRequest | null {
	if (frame.method !== "select" || typeof frame.id !== "string" || typeof frame.title !== "string") return null;
	if (!frame.title.startsWith(TITLE_PREFIX)) return null;
	const { options } = frame;
	if (!Array.isArray(options) || options.length !== 2 || options[0] !== "Approve" || options[1] !== "Deny") return null;
	const tool = (frame.title.slice(TITLE_PREFIX.length).split("\n", 1)[0] ?? "").trim();
	return tool === "" ? null : { id: frame.id, tool, title: frame.title };
}

/** The store's question for an approval. Deny is the recommended answer, and `ompKey` marks it as an approval for the reply encoder. */
export function approvalInput(request: ApprovalRequest): QuestionInput {
	return {
		key: cutBytes(`approval:${request.tool}`, MAX_QUESTION_KEY_BYTES),
		text: cutBytes(request.title, MAX_QUESTION_TEXT_BYTES),
		header: APPROVAL_HEADER,
		options: [
			{ label: "Approve", description: "run this tool call" },
			{ label: "Deny", description: "block it" },
		],
		multi: false,
		recommended: 1,
		ompKey: APPROVAL_OMP_KEY,
		ompLabels: ["Approve", "Deny"],
	};
}

/** The stored answer of an approval nobody answered within `timeoutSeconds`: omp has no timeout, so the runner denies. */
export function approvalTimeoutAnswer(timeoutSeconds: number): string {
	return `Denied: no answer within ${formatDuration(timeoutSeconds)}.`;
}

/**
 * Aborts the turn without hanging omp: `denyApprovals` answers every open approval first, then `abort` is sent. omp's
 * `abort` does not return, and holds back every other command, until its open approvals are answered, so the abort
 * is never awaited before the approvals are.
 */
export async function abortAfterDenying(denyApprovals: () => void, abort: () => Promise<void>): Promise<void> {
	denyApprovals();
	await abort();
}

/**
 * The request ids of the approvals omp asked and nobody has answered: omp waits on every one, and its `abort` blocks until
 * they are all answered. The set belongs to one omp process, so it outlives a turn that is requeued and is cleared when a
 * new process starts.
 */
export class PendingApprovals {
	readonly #ids = new Set<string>();

	add(id: string): void {
		this.#ids.add(id);
	}

	/** `id` was answered. */
	settle(id: string): void {
		this.#ids.delete(id);
	}

	/** Every id still open, in the order they arrived; the set is empty afterwards. */
	drain(): string[] {
		const ids = [...this.#ids];
		this.#ids.clear();
		return ids;
	}

	clear(): void {
		this.#ids.clear();
	}

	get size(): number {
		return this.#ids.size;
	}
}
