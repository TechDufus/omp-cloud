/**
 * Deterministic OpenAI chat-completions stand-in for omp-cloud's scenarios and `dev:local`.
 *
 * - latest user message contains `BGBASH: <command>` (first line after the marker): stream a call of omp's `bash` tool with
 *   `command` and `async: true` (a background job the call returns from at once); with a tool result: reply
 *   `DONE=<first line of the result>`. It comes before `BASH:`, which the marker contains.
 * - latest user message is `TOOL[<tag>]: <name> <json>` (first line only) and no tool result follows it: stream a call of omp's tool
 *   `<name>` with the JSON object as its arguments and the call id {@link toolCallId}(tag): the local model of a scenario drives omp's
 *   own `read`, `write` and `wait` this way; with a tool result: reply `TOOL-DONE <tag>`; JSON that is no object: `TOOL-BAD-JSON <tag>`.
 * - latest user message contains `WRITEPARENT: <text>` (first line after the marker; an incoming IRC message appends omp's reply
 *   instructions below it): stream a call of `write` to `agent://Parent` with `<text>`; with a tool result: reply
 *   `DONE=<first line of the result>`. It is how a cloud agent in a VM writes to its parent.
 * - latest user message is `CLOUD[<tag>]: <json>` and no tool result follows it: stream a call of the `cloud` tool (the
 *   omp-cloud plugin's) with the JSON object as its arguments and the call id `call_cloud_<tag>`, so a scenario finds its
 *   result by tag; with a tool result: reply `CLOUD-DONE <tag>`; JSON that is no object: reply `CLOUD-BAD-JSON <tag>`.
 *   This rule comes first, so the task text of a delegation (`BASH:`, `ASK:`) does not steer the local model.
 * - latest user message contains `WAIT:` and no tool result follows it: stream a call of omp's `wait` tool (no arguments,
 *   it blocks on the background jobs the session started); with a tool result: reply `WAITED=<the result text, one line>`.
 * - the request is omp's title generator (its system prompt opens "You name coding-agent sessions"): reply
 *   `<title>Print greeting to hello file</title>` ({@link GENERATED_TITLE}), whatever the user message says.
 * - latest user message contains `LONG:<n>` (n up to 100000): reply {@link longReply}(n), no tool call: a long reply for paging tests
 *   (a bash tool result is shortened by omp before the model sees it, so `BASH:` cannot make one). It never repeats itself: omp's
 *   loop guard interrupts a reply of identical characters.
 * - latest user message contains `ASK:` and no tool result follows it: stream a call of omp's `ask` tool
 *   (one question, options `red` / `blue`).
 * - latest user message contains `ASK:` and a tool result follows: reply `ANSWER=<tool result text>`.
 * - latest user message contains `BASH:` and no tool result follows it: stream a call of omp's `bash` tool
 *   with `command` = the rest of the line after `BASH:` (one line: an incoming IRC message appends omp's reply instructions below).
 * - latest user message contains `BASH:` and a tool result follows: reply `DONE=<first line of the result text>`.
 * - anything else: reply `TURN count=<user messages in the request> first=<first user message>`, which shows
 *   that the whole conversation reached the model.
 * - `GET /requests`: `{ count, last }` (request count and the last request body) for debugging.
 *
 * Run standalone: `HOST=127.0.0.1 PORT=4010 bun run test/fake-provider.ts`.
 */
import { isRecord } from "../src/guards";

export const PROVIDER_ID = "fake";
export const MODEL_ID = "fake-model";
/** The `provider/id` form omp's `--model` and `modelRoles` take. */
export const MODEL = `${PROVIDER_ID}/${MODEL_ID}`;

/** The arguments of the `ask` call the fake model makes. Valid for omp 18.12.2's ask schema. */
export const ASK_ARGUMENTS = {
	questions: [
		{
			id: "color",
			question: "pick a color",
			options: [{ label: "red" }, { label: "blue" }],
		},
	],
};

/** Tokens every fake response reports: `usage.prompt_tokens` and `usage.completion_tokens`, streamed or not. */
const PROMPT_TOKENS = 120;
const COMPLETION_TOKENS = 12;
/** `fake-model`'s input and output price in USD per million tokens; cache reads and writes are free. */
const RATE_PER_MILLION = 1000;
/** What omp records as `usage.cost` for every request to the fake model: (120 + 12) tokens at 1000 USD per million. */
export const REQUEST_COST = ((PROMPT_TOKENS + COMPLETION_TOKENS) * RATE_PER_MILLION) / 1_000_000;

/** `models.yml` registering this server (reachable at `baseUrl`, without `/v1`) as provider `fake`. */
export function modelsYaml(baseUrl: string): string {
	return `providers:
  ${PROVIDER_ID}:
    baseUrl: ${baseUrl}/v1
    auth: none
    api: openai-completions
    models:
      - id: ${MODEL_ID}
        contextWindow: 128000
        maxTokens: 4096
        cost:
          input: ${RATE_PER_MILLION}
          output: ${RATE_PER_MILLION}
          cacheRead: 0
          cacheWrite: 0
`;
}

/** `config.yml` that makes the fake model the default, so omp starts without prompting for a model. */
export const CONFIG_YAML = `modelRoles:\n  default: ${MODEL}\n`;

interface ChatMessage {
	role?: unknown;
	content?: unknown;
}

/** Message text: `content` is a string or an array of `{ type: "text", text }` parts. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
		.join("");
}

type Reply =
	| { kind: "text"; text: string }
	| { kind: "tool"; callId: string; name: string; arguments: Record<string, unknown> };

/**
 * omp prepends `<system-reminder>...</system-reminder>` blocks (date, cwd) to user turns and its loop guard appends
 * `<system-interrupt ...>` messages; neither is the user's text.
 */
function userText(message: ChatMessage | undefined): string {
	return textOf(message?.content)
		.replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/<system-interrupt[^>]*>[\s\S]*?(?:<\/system-interrupt>|$)/g, "")
		.trim();
}

/**
 * What `LONG:<n>` makes the model reply: `DONE=` and exactly `n` characters of `0 1 2 3 … ` (base 36, space separated), so no run
 * repeats. The last character is a digit, not a space: replies are trimmed on the way to the service.
 */
export function longReply(n: number): string {
	let body = "";
	for (let i = 0; body.length < n; i++) body += `${i.toString(36)} `;
	body = body.slice(0, n);
	if (body.endsWith(" ")) body = `${body.slice(0, -1)}z`;
	return `DONE=${body}`;
}

/** The sentence omp's session-title prompt (`title-system.md`) opens with: a request whose system message holds it asks for a title. */
const TITLE_PROMPT_MARKER = "You name coding-agent sessions";

/** `CLOUD[<tag>]: <json>`: a prompt that makes the fake model call the `cloud` tool. */
const CLOUD_PROMPT = /^CLOUD\[([A-Za-z0-9_-]{1,32})\]:\s*([\s\S]+)$/;

/** The id of the tool call a `CLOUD[<tag>]` prompt makes. */
export function cloudCallId(tag: string): string {
	return `call_cloud_${tag}`;
}

/** `TOOL[<tag>]: <name> <json>`: a prompt that makes the fake model call the omp tool `<name>`. */
const TOOL_PROMPT = /^TOOL\[([A-Za-z0-9_-]{1,32})\]:\s*([A-Za-z_][A-Za-z0-9_]*)\s+(\{[\s\S]*\})\s*$/;

/** The id of the tool call a `TOOL[<tag>]` prompt makes. */
export function toolCallId(tag: string): string {
	return `call_tool_${tag}`;
}

/** The recipient of `WRITEPARENT:`: the id the VM's registry gives its parent. */
const PARENT_ID = "Parent";

/** The title the fake model gives every title request (`<title>` markers, as omp's title generator asks). */
export const GENERATED_TITLE = "Print greeting to hello file";

/** Whether the request is omp naming a session or thread rather than a turn: only the title prompt reaches the model as a system or developer message holding the marker. */
function isTitleRequest(messages: ChatMessage[]): boolean {
	return messages.some(m => (m.role === "system" || m.role === "developer") && textOf(m.content).includes(TITLE_PROMPT_MARKER));
}

function decide(messages: ChatMessage[], count: number): Reply {
	if (isTitleRequest(messages)) return { kind: "text", text: `<title>${GENERATED_TITLE}</title>` };
	const users = messages.filter(m => m.role === "user");
	// omp may append user messages that hold only <system-reminder> blocks (empty once stripped): they are not the prompt.
	const lastUser = messages.findLastIndex(m => m.role === "user" && userText(m) !== "");
	const latest = lastUser >= 0 ? userText(messages[lastUser]) : "";
	const cloud = CLOUD_PROMPT.exec(latest);
	if (cloud?.[1] !== undefined && cloud[2] !== undefined) {
		const tag = cloud[1];
		if (messages.slice(lastUser + 1).findLast(m => m.role === "tool")) return { kind: "text", text: `CLOUD-DONE ${tag}` };
		let parsed: unknown;
		try {
			parsed = JSON.parse(cloud[2]);
		} catch {
			parsed = undefined;
		}
		if (!isRecord(parsed)) return { kind: "text", text: `CLOUD-BAD-JSON ${tag}` };
		return { kind: "tool", callId: cloudCallId(tag), name: "cloud", arguments: parsed };
	}
	const tool = TOOL_PROMPT.exec(latest.split("\n", 1)[0] ?? "");
	if (tool?.[1] !== undefined && tool[2] !== undefined && tool[3] !== undefined) {
		const tag = tool[1];
		if (messages.slice(lastUser + 1).findLast(m => m.role === "tool")) return { kind: "text", text: `TOOL-DONE ${tag}` };
		let parsed: unknown;
		try {
			parsed = JSON.parse(tool[3]);
		} catch {
			parsed = undefined;
		}
		if (!isRecord(parsed)) return { kind: "text", text: `TOOL-BAD-JSON ${tag}` };
		return { kind: "tool", callId: toolCallId(tag), name: tool[2], arguments: parsed };
	}
	const parent = latest.indexOf("WRITEPARENT:");
	if (parent >= 0) {
		const last = messages.slice(lastUser + 1).findLast(m => m.role === "tool");
		if (!last) {
			const content = (latest.slice(parent + "WRITEPARENT:".length).trim().split("\n", 1)[0] ?? "").trim();
			return { kind: "tool", callId: `call_fake_${count}`, name: "write", arguments: { path: `agent://${PARENT_ID}`, content } };
		}
		return { kind: "text", text: `DONE=${textOf(last.content).split("\n", 1)[0]}` };
	}
	const long = /LONG:(\d{1,6})/.exec(latest);
	if (long?.[1] !== undefined) return { kind: "text", text: longReply(Math.min(Number(long[1]), 100_000)) };
	if (latest.includes("ASK:")) {
		const last = messages.slice(lastUser + 1).findLast(m => m.role === "tool");
		if (!last) return { kind: "tool", callId: `call_fake_${count}`, name: "ask", arguments: ASK_ARGUMENTS };
		return { kind: "text", text: `ANSWER=${textOf(last.content)}` };
	}
	if (latest.includes("WAIT:")) {
		const last = messages.slice(lastUser + 1).findLast(m => m.role === "tool");
		if (!last) return { kind: "tool", callId: `call_fake_${count}`, name: "wait", arguments: {} };
		return { kind: "text", text: `WAITED=${textOf(last.content).replace(/\s+/g, " ").trim()}` };
	}
	// Deliveries quote cloud text: the local omp's `[cloud] Started cloud thread …: <task>` message quotes the delegated task, and
	// omp's async-result `<system-notice>` for a model-started cloud job quotes the agent's reply (which may quote its own task).
	// A background command meant for the VM must never run here too.
	const quotesCloud = latest.startsWith("[cloud]") || latest.trimStart().startsWith("<system-notice>");
	if (quotesCloud && latest.includes("BGBASH:")) return { kind: "text", text: `TURN count=${users.length} first=${userText(users[0])}` };
	const background = latest.indexOf("BGBASH:");
	if (background >= 0) {
		const last = messages.slice(lastUser + 1).findLast(m => m.role === "tool");
		if (!last) {
			const command = (latest.slice(background + "BGBASH:".length).trim().split("\n", 1)[0] ?? "").trim();
			return { kind: "tool", callId: `call_fake_${count}`, name: "bash", arguments: { command, async: true } };
		}
		return { kind: "text", text: `DONE=${textOf(last.content).split("\n", 1)[0]}` };
	}
	const bash = latest.indexOf("BASH:");
	if (bash >= 0) {
		const last = messages.slice(lastUser + 1).findLast(m => m.role === "tool");
		if (!last) {
			// The first line only: an incoming IRC message (a wake or a steer) appends omp's reply instructions after the sender's text.
			const command = (latest.slice(bash + "BASH:".length).trim().split("\n", 1)[0] ?? "").trim();
			return { kind: "tool", callId: `call_fake_${count}`, name: "bash", arguments: { command } };
		}
		return { kind: "text", text: `DONE=${textOf(last.content).split("\n", 1)[0]}` };
	}
	return { kind: "text", text: `TURN count=${users.length} first=${userText(users[0])}` };
}

const COMPLETION = { id: "chatcmpl-fake", created: 1, model: MODEL_ID };

function sse(chunks: unknown[]): Response {
	const body = `${[...chunks.map(chunk => JSON.stringify(chunk)), "[DONE]"].map(data => `data: ${data}\n\n`).join("")}`;
	return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function chunk(delta: Record<string, unknown>, finish: string | null): unknown {
	return {
		...COMPLETION,
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

const USAGE_CHUNK = {
	...COMPLETION,
	object: "chat.completion.chunk",
	choices: [],
	usage: {
		prompt_tokens: PROMPT_TOKENS,
		completion_tokens: COMPLETION_TOKENS,
		total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
	},
};

function streamReply(reply: Reply): Response {
	if (reply.kind === "text") {
		return sse([
			chunk({ role: "assistant", content: reply.text }, null),
			chunk({}, "stop"),
			USAGE_CHUNK,
		]);
	}
	return sse([
		chunk(
			{
				role: "assistant",
				tool_calls: [{ index: 0, id: reply.callId, type: "function", function: { name: reply.name, arguments: "" } }],
			},
			null,
		),
		chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.arguments) } }] }, null),
		chunk({}, "tool_calls"),
		USAGE_CHUNK,
	]);
}

function jsonReply(reply: Reply): Response {
	const message =
		reply.kind === "text"
			? { role: "assistant", content: reply.text }
			: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: reply.callId,
							type: "function",
							function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
						},
					],
				};
	return Response.json({
		...COMPLETION,
		object: "chat.completion",
		choices: [{ index: 0, message, finish_reason: reply.kind === "text" ? "stop" : "tool_calls" }],
		usage: USAGE_CHUNK.usage,
	});
}

/** The roles and the first 200 characters of each message of a chat-completions request body, one per line, for failure reports. */
export function describeRequest(body: unknown): string {
	if (!isRecord(body) || !Array.isArray(body.messages)) return "(no request)";
	return body.messages
		.map((m: unknown, index) => {
			const message: ChatMessage = isRecord(m) ? m : {};
			const calls = isRecord(m) && Array.isArray(m.tool_calls) ? ` +${m.tool_calls.length} tool call(s)` : "";
			return `  #${index} ${String(message.role)}${calls}: ${JSON.stringify(textOf(message.content).slice(0, 200))}`;
		})
		.join("\n");
}

export interface FakeProvider {
	/** Base URL without `/v1`, e.g. `http://127.0.0.1:4010`. */
	readonly url: string;
	readonly hostname: string;
	readonly port: number;
	/** Number of chat-completions requests received. */
	readonly count: number;
	/** Body of the last chat-completions request. */
	readonly last: unknown;
	/** Bodies of the last 3 requests that were not session-title requests, oldest first. */
	readonly recentTurns: unknown[];
	/** The tail (last 3 messages, 4000 characters each) of the last 500 chat requests that were not title requests, oldest first: what a model saw last. */
	readonly history: string[];
	/** Starts counting the chat requests whose body contains `needle` (from now on); read the count with {@link seen}. */
	watch(needle: string): void;
	/** How many chat requests received since `watch(needle)` contained `needle`; 0 for a needle nobody watches. */
	seen(needle: string): number;
	stop(): Promise<void>;
}

export function startFakeProvider(options: { hostname?: string; port?: number } = {}): FakeProvider {
	const hostname = options.hostname ?? "127.0.0.1";
	let count = 0;
	let last: unknown = null;
	const recentTurns: unknown[] = [];
	const watched = new Map<string, number>();
	const history: string[] = [];
	const server = Bun.serve({
		hostname,
		port: options.port ?? 4010,
		idleTimeout: 120,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			if (req.method === "GET" && pathname === "/requests") return Response.json({ count, last });
			if (req.method === "GET" && pathname === "/health") return new Response("ok");
			if (req.method === "POST" && pathname.endsWith("/chat/completions")) {
				const body: unknown = await req.json();
				count++;
				if (watched.size > 0) {
					const raw = JSON.stringify(body);
					for (const [needle, seen] of watched) if (raw.includes(needle)) watched.set(needle, seen + 1);
				}
				last = body;
				const messages: ChatMessage[] =
					isRecord(body) && Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
				if (!isTitleRequest(messages)) {
					recentTurns.push(body);
					if (recentTurns.length > 3) recentTurns.shift();
				}
				if (!isTitleRequest(messages)) {
					history.push(messages.slice(-3).map(m => `${String(m.role)}: ${textOf(m.content).slice(0, 4000)}`).join("\n---\n"));
					if (history.length > 500) history.shift();
				}
				const reply = decide(messages, count);
				return isRecord(body) && body.stream === false ? jsonReply(reply) : streamReply(reply);
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://${hostname}:${server.port}`,
		hostname,
		port: server.port ?? 0,
		get count() {
			return count;
		},
		get last() {
			return last;
		},
		get recentTurns() {
			return recentTurns;
		},
		get history() {
			return history;
		},
		watch: (needle: string) => void watched.set(needle, 0),
		seen: (needle: string) => watched.get(needle) ?? 0,
		stop: () => server.stop(true),
	};
}

if (import.meta.main) {
	const provider = startFakeProvider({
		hostname: process.env.HOST ?? "127.0.0.1",
		port: Number(process.env.PORT ?? 4010),
	});
	console.log(`fake provider listening on ${provider.url}  (model ${MODEL})`);
	console.log(modelsYaml(provider.url));
}
