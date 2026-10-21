/**
 * The parity harness's model: `test/fake-provider.ts` for every request (the cloud agent's too: it reaches the same server
 * from its VM), except the local session's scripted prompts, which make it start native background work and wait on it:
 *
 * - `PARITY[jobs]`: a background `bash` job (`async: true`), then a `task` subagent whose own prompt is `BASH: ...` (the
 *   fake model runs it), then a closing text.
 * - `PARITY[wait]`: `wait` called once per job (a `wait` returns when ONE job settles), then a closing text.
 * - omp's job-widget author (a forced `respond` call): a spec for the native bash loop, a `skip` for anything else.
 */
import { isRecord } from "../../src/guards";
import { type FakeProvider, startFakeProvider } from "../../test/fake-provider";

/** What a scripted step answers once its calls are done. */
export const JOBS_DONE = "PARITY jobs started";
export const WAITED_DONE = "PARITY waited";

interface ChatMessage {
	role?: string;
	content?: unknown;
}

type Reply = { kind: "text"; text: string } | { kind: "tool"; callId: string; name: string; arguments: Record<string, unknown>; text?: string };

/** A running bash loop: one `<label> step N of M ok` line every few seconds, so a job has output to show. */
export function loopCommand(label: string, steps: number, seconds: number): string {
	return `for i in $(seq 1 ${steps}); do echo "${label} step $i of ${steps} ok"; sleep ${seconds}; done; echo "${label} finished"`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

/** omp prepends `<system-reminder>` blocks to user turns and appends `<system-interrupt>` ones: neither is the user's text. */
function userText(message: ChatMessage | undefined): string {
	return textOf(message?.content)
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/<system-interrupt[\s\S]*?<\/system-interrupt>/g, "")
		.trim();
}

/** The parameter names of the request's tool `name`, or undefined when the request offers no such tool. */
function toolProperties(body: unknown, name: string): string[] | undefined {
	if (!isRecord(body) || !Array.isArray(body.tools)) return undefined;
	for (const tool of body.tools) {
		const fn = isRecord(tool) && isRecord(tool.function) ? tool.function : undefined;
		if (fn?.name !== name) continue;
		const parameters = fn.parameters;
		return isRecord(parameters) && isRecord(parameters.properties) ? Object.keys(parameters.properties) : [];
	}
	return undefined;
}

/** The `task` call: one spawn, or a batch when omp's schema asks for `tasks[]`. */
function taskCall(body: unknown, prompt: string, name = "ParityAgent"): Record<string, unknown> {
	const item = { name, task: prompt, solutionSpace: "one fix: a loop of echo lines, nothing to decide" };
	return (toolProperties(body, "task") ?? []).includes("tasks") ? { context: "A parity harness subagent.", tasks: [item] } : item;
}

/**
 * What a real cheap model writes for lines like `native-bash step 3 of 30 ok`: step dots first (a tile draws its first block),
 * then a meter, a stat line, a headline and a stage; the `/jobs` widget draws every block.
 */
const LOOP_SPEC = {
	title: "parity loop",
	rules: [
		{ from: "*", match: "native-bash step (?P<key>\\d+) of \\d+ (?P<state>ok)", key: "key", text: "state" },
		{ from: "*", match: "native-bash (?P<stage>step (?P<step>\\d+) of (?P<of>\\d+) ok)", text: "stage" },
	],
	blocks: [
		{ kind: "grid", field: "state", label: "steps", tones: { ok: "success" } },
		{ kind: "meter", field: "step", agg: "last", total: { field: "of", agg: "last" }, label: "progress" },
		{
			kind: "stat",
			items: [
				{ label: "step", field: "step", agg: "last" },
				{ label: "lines", field: "step", agg: "count" },
			],
		},
	],
	headline: { field: "step", agg: "last", label: "step" },
	stage: "stage",
};

function widgetAnswer(messages: ChatMessage[], count: number): Reply {
	const sawLoop = messages.some(m => textOf(m.content).includes("native-bash step"));
	const spec = sawLoop ? LOOP_SPEC : { skip: "parity harness: only the native loop has a widget" };
	return { kind: "tool", callId: `call_parity_widget_${count}`, name: "respond", arguments: spec };
}

/**
 * The cloud agent's scripted turn (`TAIL:` prompt): a background `bash` job and a background `task` subagent that outlive the turn's
 * steps (the children `/jobs` nests under the cloud job), then three bash calls, each opened by an assistant line, 35 s apart, then
 * a closing line. A `/jobs` sheet taken midway holds the children's rows and, as the job's output, tool one-liners and assistant lines.
 */
export const TAIL_NOTES = ["Tail step one: starting", "Tail step two: checking", "Tail step three: finishing"] as const;
export const TAIL_DONE = "Tail finished";
/** What names the cloud agent's children on screen: the command of the bash job (a `cloud-bg step N of M ok` loop) and the subagent's id. */
export const CLOUD_BG_LABEL = "cloud-bg";
export const CLOUD_AGENT_ID = "CloudHelper";
/** Both loops run three minutes, longer than the scripted turn, so neither ends (and delivers its result into the turn) before it does. */
const CHILD_STEPS = 45;

function tailTurn(messages: ChatMessage[], body: unknown, lastUser: number, count: number): Reply {
	const results = messages.slice(lastUser + 1).filter(m => m.role === "tool").length;
	const callId = `call_parity_tail_${count}`;
	if (results === 0) return { kind: "tool", callId, name: "bash", arguments: { command: loopCommand(CLOUD_BG_LABEL, CHILD_STEPS, 4), async: true } };
	if (results === 1) return { kind: "tool", callId, name: "task", arguments: taskCall(body, `BASH: ${loopCommand("cloud-agent", CHILD_STEPS, 4)}`, CLOUD_AGENT_ID) };
	const note = TAIL_NOTES[results - 2];
	if (note === undefined) return { kind: "text", text: TAIL_DONE };
	return { kind: "tool", callId, name: "bash", text: note, arguments: { command: `echo tail-${results - 1}; sleep 35` } };
}

function scripted(messages: ChatMessage[], body: unknown, count: number, waitCalls: number): Reply | undefined {
	if (toolProperties(body, "respond") !== undefined) return widgetAnswer(messages, count);
	// A session-title request quotes the first user message; it is no turn of the script.
	if (messages.some(m => (m.role === "system" || m.role === "developer") && textOf(m.content).includes("You name coding-agent sessions"))) return undefined;
	const lastUser = messages.findLastIndex(m => m.role === "user" && userText(m) !== "");
	if (lastUser < 0) return undefined;
	if (/(^|\s)TAIL:/.test(userText(messages[lastUser]))) return tailTurn(messages, body, lastUser, count);
	const step = /PARITY\[(jobs|wait)\]/.exec(userText(messages[lastUser]))?.[1];
	if (step === undefined) return undefined;
	const results = messages.slice(lastUser + 1).filter(m => m.role === "tool").length;
	const callId = `call_parity_${step}_${count}`;
	if (step === "jobs") {
		if (results === 0) return { kind: "tool", callId, name: "bash", arguments: { command: loopCommand("native-bash", 30, 4), async: true } };
		if (results === 1) return { kind: "tool", callId, name: "task", arguments: taskCall(body, `BASH: ${loopCommand("native-agent", 30, 4)}`) };
		return { kind: "text", text: JOBS_DONE };
	}
	if (results < waitCalls) return { kind: "tool", callId, name: "wait", arguments: {} };
	return { kind: "text", text: WAITED_DONE };
}

const USAGE = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };
const COMPLETION = { id: "chatcmpl-parity", created: 1, model: "fake-model" };

function chunk(delta: Record<string, unknown>, finish: string | null): unknown {
	return { ...COMPLETION, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] };
}

function sse(chunks: unknown[]): Response {
	const body = [...chunks.map(c => JSON.stringify(c)), "[DONE]"].map(data => `data: ${data}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function respond(reply: Reply): Response {
	const usage = { ...COMPLETION, object: "chat.completion.chunk", choices: [], usage: USAGE };
	if (reply.kind === "text") return sse([chunk({ role: "assistant", content: reply.text }, null), chunk({}, "stop"), usage]);
	const lead = reply.text === undefined ? {} : { content: reply.text };
	return sse([
		chunk({ role: "assistant", ...lead, tool_calls: [{ index: 0, id: reply.callId, type: "function", function: { name: reply.name, arguments: "" } }] }, null),
		chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.arguments) } }] }, null),
		chunk({}, "tool_calls"),
		usage,
	]);
}

export interface ParityProvider {
	/** Base URL without `/v1`. */
	readonly url: string;
	/** One line per chat request, oldest first: for a failure or a surprise. */
	readonly requests: readonly string[];
	stop(): Promise<void>;
}

export function startParityProvider(options: { hostname: string; waitCalls: number }): ParityProvider {
	const inner: FakeProvider = startFakeProvider({ hostname: "127.0.0.1", port: 0 });
	let count = 0;
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: options.hostname,
		port: 0,
		idleTimeout: 120,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			const raw = req.method === "POST" ? await req.text() : undefined;
			if (raw !== undefined && pathname.endsWith("/chat/completions")) {
				count++;
				let body: unknown;
				try {
					body = JSON.parse(raw);
				} catch {
					body = undefined;
				}
				const messages: ChatMessage[] = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
				const reply = scripted(messages, body, count, options.waitCalls);
				const latest = userText(messages.findLast(m => m.role === "user" && userText(m) !== ""));
				requests.push(`#${count} ${reply === undefined ? "forwarded" : "scripted"} ${messages.length} messages, latest user ${JSON.stringify(latest.slice(0, 100))}`);
				if (reply !== undefined) return respond(reply);
			}
			const forwarded = await fetch(`${inner.url}${pathname}`, { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json" }, body: raw });
			return new Response(forwarded.body, { status: forwarded.status, headers: forwarded.headers });
		},
	});
	return {
		url: `http://${options.hostname}:${server.port}`,
		requests,
		stop: async () => {
			await server.stop(true);
			await inner.stop();
		},
	};
}
