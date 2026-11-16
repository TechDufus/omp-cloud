/** What the ACP agent shows of a cloud thread, as pure functions: prompts in, session updates out. No I/O. */

import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestError, type ContentBlock, type SessionConfigOption, type SessionConfigSelectOption, type SessionUpdate, type ToolKind } from "@oh-my-pi/pi-utils/acp";
import { isRecord } from "../plugin/src/guards";
import { THINKING_LEVELS, type LaunchedThread } from "../plugin/src/launch";
import type { AnswerBody, PendingQuestion, ThreadEvent, ThreadSummary } from "../plugin/src/types";

/** A session id the agent made (`session/new`): `acp-` and 32 hex digits. It is the thread's `ref`. */
export const SESSION_ID = /^acp-[0-9a-f]{32}$/;

/** What a `resource_link` adds to the prompt: a file below `cwd` relative to it, another file absolute, any other URI as written. */
function linkTarget(uri: string, cwd: string): string {
	if (!uri.startsWith("file:")) return uri;
	let path: string;
	try {
		path = fileURLToPath(uri);
	} catch {
		return uri;
	}
	const rel = relative(cwd, path);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
	return rel.split(sep).join("/");
}

/**
 * The text of a prompt for the cloud agent: its text blocks, and each file link as `@<path>`, in order.
 * Throws `invalidParams` for any other block and for a prompt without text.
 */
export function promptText(blocks: readonly ContentBlock[], cwd: string): string {
	let text = "";
	for (const block of blocks) {
		if (block.type === "text") text += block.text;
		else if (block.type === "resource_link") text += `@${linkTarget(block.uri, cwd)}`;
		else throw RequestError.invalidParams(undefined, `omp-cloud takes text and file links; the client sent a ${block.type} block`);
	}
	const trimmed = text.trim();
	if (trimmed === "") throw RequestError.invalidParams(undefined, "the prompt is empty");
	return trimmed;
}

/** The agent's own command a prompt is; undefined for every other text, other slash commands included: those are messages for the cloud agent. */
export function command(text: string): { name: "pull" | "follow"; arg: string } | undefined {
	const match = /^\/(pull|follow)(?:\s+(.*))?$/.exec(text.trim());
	if (match === null) return undefined;
	return { name: match[1] === "pull" ? "pull" : "follow", arg: (match[2] ?? "").trim() };
}

// The tool names of omp's `mapToolKind` (`modes/acp/acp-event-mapper.ts`). That function needs the argument object and
// loads omp's URL router; the service's events carry clipped argument text.
const TOOL_KINDS: Record<string, ToolKind> = {
	read: "read",
	write: "edit",
	edit: "edit",
	delete: "delete",
	move: "move",
	bash: "execute",
	shell: "execute",
	exec: "execute",
	eval: "execute",
	grep: "search",
	glob: "search",
	ast_grep: "search",
	web_search: "fetch",
	todo: "think",
};

/** The ACP category of one of omp's tools, by its name. The name comes off the wire, so an inherited key (`constructor`) is no entry. */
export function toolKind(tool: string): ToolKind {
	return Object.hasOwn(TOOL_KINDS, tool) ? (TOOL_KINDS[tool] ?? "other") : "other";
}

/** The JSON object a structured event's text is; undefined for anything else. */
function structured(event: ThreadEvent): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(event.text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function field(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

/** The `tool_call` of a `tool_start` event (`{id, tool, intent, args}`). */
export function toolStart(event: ThreadEvent): SessionUpdate | undefined {
	const start = structured(event);
	if (start === undefined) return undefined;
	const tool = field(start, "tool");
	const args = field(start, "args");
	return {
		sessionUpdate: "tool_call",
		toolCallId: field(start, "id") || `tool-${event.seq}`,
		title: field(start, "intent") || (args !== "" ? `${tool} ${args}` : tool),
		kind: toolKind(tool),
		status: "in_progress",
		...(args !== "" ? { rawInput: args } : {}),
	};
}

/** The `tool_call_update` of a `tool_end` event (`{id, ok, error}`). */
export function toolEnd(event: ThreadEvent): SessionUpdate | undefined {
	const end = structured(event);
	if (end === undefined) return undefined;
	const error = field(end, "error");
	return {
		sessionUpdate: "tool_call_update",
		toolCallId: field(end, "id") || `tool-${event.seq}`,
		status: end.ok === true ? "completed" : "failed",
		...(error !== "" ? { content: [{ type: "content", content: { type: "text", text: error } }] } : {}),
	};
}

/** The `usage_update` of a `usage` event whose context window is known. */
export function usageUpdate(event: ThreadEvent): SessionUpdate | undefined {
	const context = structured(event)?.context;
	if (!isRecord(context) || typeof context.window !== "number" || typeof context.tokens !== "number" || context.window <= 0) return undefined;
	return { sessionUpdate: "usage_update", size: context.window, used: context.tokens };
}

/** An `ask` question as the text the user answers with their next prompt. */
export function questionText(q: PendingQuestion): string {
	const lines = [...(q.header !== "" ? [q.header] : []), q.text, ""];
	q.options.forEach((option, index) => lines.push(`${index + 1}. ${option.label}${option.description !== "" ? ` — ${option.description}` : ""}`));
	lines.push("", q.multi ? "Reply with numbers or labels separated by commas, or your own answer." : "Reply with a number, a label, or your own answer.");
	return lines.join("\n");
}

/** The label of the option `part` names: its number from 1, or its label ignoring case. */
function optionOf(q: Pick<PendingQuestion, "options">, part: string): string | undefined {
	const text = part.trim();
	if (/^\d+$/.test(text)) {
		const picked = q.options[Number(text) - 1];
		if (picked !== undefined) return picked.label;
	}
	return q.options.find(option => option.label.toLowerCase() === text.toLowerCase())?.label;
}

/** The answer a prompt gives to an `ask` question: the options it names, else its text. */
export function answerBody(q: Pick<PendingQuestion, "options" | "multi">, text: string): AnswerBody {
	const parts = q.multi ? text.split(",") : [text];
	const labels = parts.map(part => optionOf(q, part));
	const selected = labels.filter(label => label !== undefined);
	return selected.length === labels.length ? { selected: [...new Set(selected)] } : { answer: text };
}

/** The session id a thread is listed under: its `ref` when a session made it, else its own id. */
export function sessionIdOf(thread: Pick<ThreadSummary, "id" | "ref">): string {
	return SESSION_ID.test(thread.ref) ? thread.ref : thread.id;
}

export interface ConfigInput {
	/** `provider/id` of what the cloud can run. */
	models: readonly string[];
	defaultModel: string;
	/** The chosen model, `""` for the cloud's default. */
	model: string;
	/** The chosen thinking level, `""` for the default. */
	thinking: string;
	/** The thread exists: each option offers only its current value. */
	fixed: boolean;
}

/** The session's two options: the model and the thinking level. */
export function configOptions(input: ConfigInput): SessionConfigOption[] {
	const models: SessionConfigSelectOption[] = input.fixed
		? [{ value: input.model, name: input.model === "" ? "Cloud default" : input.model }]
		: [{ value: "", name: `Cloud default (${input.defaultModel})` }, ...input.models.map(id => ({ value: id, name: id }))];
	const levels: SessionConfigSelectOption[] = input.fixed
		? [{ value: input.thinking, name: input.thinking === "" ? "Default" : input.thinking }]
		: [{ value: "", name: "Default" }, ...THINKING_LEVELS.map(level => ({ value: level, name: level }))];
	return [
		{ id: "model", name: "Model", category: "model", type: "select", currentValue: input.model, options: models },
		{ id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: input.thinking, options: levels },
	];
}

/** What a session's first prompt shipped, one fact per line. */
export function handoffLines(outcome: LaunchedThread, editorMcpServers: number): string[] {
	const { summary } = outcome;
	const branch = summary.repo.localBranch !== "" ? ` (${summary.repo.localBranch})` : "";
	const lines = [
		summary.scratch
			? "workspace: scratch (nothing of this directory shipped)"
			: `repository: ${summary.repo.name}${branch}, ${summary.commits} commits, ${summary.wip.files} changed files, ${summary.untrackedTotal} untracked`,
		`model: ${summary.model || "cloud default"}${summary.thinking !== "" ? `, thinking ${summary.thinking}` : ""}`,
	];
	if (summary.withheld.length > 0) lines.push(`kept here (credential files): ${summary.withheld.join(", ")}`);
	for (const warning of outcome.warnings) lines.push(`warning: ${warning}`);
	if (editorMcpServers > 0) lines.push("warning: MCP servers passed by the editor are not shipped; the cloud agent gets the servers of omp's mcp.json");
	return lines;
}
