/**
 * Host side of omp's `rpc-ui` tool-UI sub-protocol, plus the omp argv shared by the local and VM dev tools.
 *
 * `RpcClient` has no public hook for `extension_ui_request` frames (only `login()` listens to
 * them) and no `set_ask_dialog` method, so a host that wants to answer the `ask` tool has to watch the
 * agent's stdout and write `extension_ui_response` frames to its stdin itself. Both transports here
 * own the process pipes, so they tap the stdout text with {@link UiTap}; `RpcClient` still sees the
 * untouched byte stream.
 */

import { isRecord } from "../src/guards";

/** One question of an `ask` tool call as the host sees it. */
export interface AskQuestion {
	id: string;
	question: string;
	/** Option labels; free text is always possible in addition. */
	options: string[];
	multi: boolean;
}

/**
 * Host policy: the answer to a question. A label from `question.options` selects that option; any other text is
 * sent as free-text `customInput` (the ask dialog always allows it). May resolve later, e.g. after a prompt.
 */
export type Chooser = (question: AskQuestion) => string | Promise<string>;

/** A UI request omp sent and the response the host wrote back (undefined when the request needed none). */
interface UiExchange {
	request: Record<string, unknown>;
	response?: Record<string, unknown>;
}

const SET_ASK_DIALOG_ID = "dev_set_ask_dialog";

function optionLabel(option: unknown): string {
	if (typeof option === "string") return option;
	if (isRecord(option) && typeof option.label === "string") return option.label;
	return String(option);
}

function toQuestion(raw: unknown): AskQuestion {
	const q = isRecord(raw) ? raw : {};
	return {
		id: String(q.id ?? ""),
		question: String(q.question ?? ""),
		options: Array.isArray(q.options) ? q.options.map(optionLabel) : [],
		multi: q.multi === true,
	};
}

/**
 * Watches the agent's stdout for `extension_ui_request` frames and answers them through `send`.
 *
 * - `method: "ask"` (after {@link UiTap.enableAskDialog}): one request carries every question of the tool call;
 *   answered with `{ type: "extension_ui_response", id, answers: [{ id, selectedOptions: [label] }] }`.
 * - `method: "select"` (the fallback omp uses until `set_ask_dialog` is enabled): answered with `{ value }`.
 * - every other dialog method that wants an answer (`confirm`, `input`, `editor`) is cancelled; notifications
 *   and status updates need no response.
 */
export class UiTap {
	/** Every dialog request seen, with the response written back. */
	readonly exchanges: UiExchange[] = [];
	#partial = "";

	constructor(
		private readonly send: (frame: Record<string, unknown>) => unknown,
		private readonly choose: Chooser,
	) {}

	/** Opt in to the single-request `ask` dialog. Resolves once the frame is written (omp applies it in order). */
	async enableAskDialog(): Promise<void> {
		await this.send({ id: SET_ASK_DIALOG_ID, type: "set_ask_dialog", enabled: true });
	}

	/** Drop a half-received line, e.g. after output was lost across a reconnect. */
	reset(): void {
		this.#partial = "";
	}

	/** Feed decoded stdout text; complete lines are inspected. */
	push(text: string): void {
		this.#partial += text;
		let newline = this.#partial.indexOf("\n");
		while (newline >= 0) {
			const line = this.#partial.slice(0, newline);
			this.#partial = this.#partial.slice(newline + 1);
			if (line.includes('"extension_ui_request"')) void this.#handle(line);
			newline = this.#partial.indexOf("\n");
		}
	}

	async #handle(line: string): Promise<void> {
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(frame) || frame.type !== "extension_ui_request" || typeof frame.id !== "string") return;
		const id = frame.id;
		const method = frame.method;
		let response: Record<string, unknown> | undefined;
		if (method === "ask" && Array.isArray(frame.questions)) {
			const answers: Record<string, unknown>[] = [];
			for (const q of frame.questions.map(toQuestion)) {
				const choice = await this.choose(q);
				answers.push(
					q.options.includes(choice)
						? { id: q.id, selectedOptions: [choice] }
						: { id: q.id, selectedOptions: [], customInput: choice },
				);
			}
			response = { type: "extension_ui_response", id, answers };
		} else if (method === "select") {
			const options = Array.isArray(frame.options) ? frame.options.map(optionLabel) : [];
			const value = await this.choose({ id, question: String(frame.title ?? ""), options, multi: false });
			response = { type: "extension_ui_response", id, value };
		} else if (method === "confirm" || method === "input" || method === "editor") {
			response = { type: "extension_ui_response", id, cancelled: true };
		}
		this.exchanges.push({ request: frame, response });
		if (!response) return;
		try {
			await this.send(response);
		} catch (error) {
			console.error(`ui response ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** Picks `label` when a question offers it, else the first option. */
export function prefer(label: string): Chooser {
	return q => (q.options.includes(label) ? label : (q.options[0] ?? label));
}

/**
 * Flags every omp launch of the dev tools adds after the ones `RpcClient` passes (`--mode rpc [--model ...]`). The
 * `--no-skills --no-rules --no-lsp` trio is for deterministic runs only: real agents keep skills, rules and LSP on.
 */
const OMP_EXTRA_FLAGS = [
	"--approval-mode",
	"yolo",
	"--no-ui",
	"--no-skills",
	"--no-rules",
	"--no-title",
	"--no-lsp",
	"--no-pty",
] as const;

/**
 * Final omp argv tail from the args `RpcClient` hands to its launcher: `--mode rpc` becomes `--mode rpc-ui`
 * (the mode that routes the `ask` tool over the protocol) and the yolo/no-discovery flags are appended.
 */
export function ompArgs(agentArgs: readonly string[]): string[] {
	const args = [...agentArgs];
	const mode = args.indexOf("--mode");
	if (mode >= 0 && args[mode + 1] === "rpc") args[mode + 1] = "rpc-ui";
	return [...args, ...OMP_EXTRA_FLAGS];
}
