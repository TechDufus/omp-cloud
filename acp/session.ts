/**
 * One ACP session: a cloud thread seen from an editor. The first prompt creates the thread, every later one is a message
 * or the answer to the cloud agent's question, and a prompt ends when the turn it started does. Nothing follows the
 * thread between prompts.
 */

import {
	RequestError,
	type AgentSideConnection,
	type ContentBlock,
	type PromptResponse,
	type SessionConfigOption,
	type SessionUpdate,
	type StopReason,
	type Usage,
} from "@oh-my-pi/pi-utils/acp";
import { CloudError, cloudErrorText } from "../plugin/src/errors";
import { follow } from "../plugin/src/events";
import type { LaunchedThread } from "../plugin/src/launch";
import { threadBranch } from "../plugin/src/pull";
import type { LiveText, PendingQuestion, ThreadDetail, ThreadEvent, ThreadSummary, ThreadTurn } from "../plugin/src/types";
import type { AcpEnvironment, CloudConnection } from "./environment";
import { answerBody, command, configOptions, handoffLines, promptText, questionText, toolEnd, toolStart, usageUpdate } from "./render";

/** Events of the service's own progress, shown as thoughts. */
const THOUGHT_KINDS: ReadonlySet<string> = new Set(["vm", "notice", "push", "pr", "sign"]);

export interface SessionInit {
	id: string;
	cwd: string;
	connection: Pick<AgentSideConnection, "sessionUpdate" | "requestPermission">;
	env: AcpEnvironment;
	cloud: CloudConnection;
	/** The cloud's default model, named by the options. */
	defaultModel: string;
	/** What the cloud can run, as `provider/id`: the choices before the thread exists. */
	models: readonly string[];
	/** MCP servers the editor passed; none of them ship. */
	mcpServers: number;
	/** The thread of a loaded session. */
	thread?: string;
}

/** The follow a prompt waits on: it ends once, with a stop reason or an error, and nothing is handled after that. */
interface Following {
	target: number;
	settled: boolean;
	finish(reason: StopReason, usage?: Usage): void;
	fail(error: unknown): void;
}

function usageOf(turn: ThreadTurn | undefined): Usage | undefined {
	const usage = turn?.usage;
	if (usage === null || usage === undefined) return undefined;
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cachedReadTokens: usage.cacheReadTokens,
		cachedWriteTokens: usage.cacheWriteTokens,
		totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
	};
}

export class AcpSession {
	readonly id: string;
	readonly cwd: string;
	readonly #connection: SessionInit["connection"];
	readonly #env: AcpEnvironment;
	readonly #cloud: CloudConnection;
	readonly #defaultModel: string;
	readonly #models: readonly string[];
	readonly #mcpServers: number;

	#thread: string | undefined;
	#model = "";
	#thinking = "";
	#busy = false;
	#cancelRequested = false;
	#disposed = false;
	/** The handoff of the first prompt while it runs. */
	#launch: AbortController | undefined;
	/** An earlier first prompt failed: the service may hold its thread all the same. */
	#launchFailed = false;
	/** Turns this session's prompts made: the editor has their text already. */
	readonly #sent = new Set<number>();
	/** The prompt text of the thread's turns, by turn id, for the turns somebody else sent. */
	readonly #turnTexts = new Map<number, string>();
	/** Approval and push questions already put to the editor, as `<turn>-<id>`. */
	readonly #asked = new Set<string>();
	/** The `ask` question the next prompt answers. */
	#question: PendingQuestion | null = null;
	#lastSeq = 0;
	#following: Following | undefined;
	/** Events and text pieces are handled one after another, in arrival order. */
	#chain: Promise<void> = Promise.resolve();
	#commands: Timer | undefined;

	// What of the running turn's reply the editor has. Reset at every `turn_started`.
	/** The assistant message whose text streams, and how much of it was shown. */
	#live: { turn: number; message: number; have: number } | null = null;
	/** A stored assistant message not shown yet: the final one is replaced by the turn's whole reply. */
	#held: string | null = null;
	/** The text of the last assistant message shown. */
	#last = "";
	/** The last update sent was reply text. */
	#textTail = false;

	constructor(init: SessionInit) {
		this.id = init.id;
		this.cwd = init.cwd;
		this.#connection = init.connection;
		this.#env = init.env;
		this.#cloud = init.cloud;
		this.#defaultModel = init.defaultModel;
		this.#models = init.models;
		this.#mcpServers = init.mcpServers;
		this.#thread = init.thread;
	}

	get started(): boolean {
		return this.#thread !== undefined;
	}

	/** The model and thinking options; they are fixed once the thread exists. */
	options(): SessionConfigOption[] {
		return configOptions({ models: this.#models, defaultModel: this.#defaultModel, model: this.#model, thinking: this.#thinking, fixed: this.started });
	}

	/** Chooses the model or the thinking level of a session without a thread. */
	configure(configId: string, value: string | boolean): void {
		if (this.started) throw RequestError.invalidParams(undefined, "the cloud agent's model and thinking level are fixed once it has started");
		const option = this.options().find(candidate => candidate.id === configId);
		if (option === undefined || option.type !== "select") throw RequestError.invalidParams(undefined, `unknown option ${JSON.stringify(configId)}: the session has model and thinking`);
		if (typeof value !== "string" || !option.options.some(choice => choice.value === value)) {
			throw RequestError.invalidParams(undefined, `${JSON.stringify(value)} is not a value of ${configId}`);
		}
		if (configId === "model") this.#model = value;
		else this.#thinking = value;
	}

	/** Tells the editor the agent's own commands, once its answer to `session/new` or `session/load` is out. */
	announceCommands(): void {
		this.#commands = setTimeout(() => {
			this.#send({
				sessionUpdate: "available_commands_update",
				availableCommands: [
					{ name: "pull", description: "Fetch the cloud agent's result branch into this repository; /pull merge also fast-forwards the current branch", input: { hint: "merge" } },
					{ name: "follow", description: "Show the turn the cloud agent is running now" },
				],
			});
		}, 0);
	}

	/**
	 * Shows a thread's stored history (`session/load`): every turn's prompt, the tool calls and each reply. Intermediate
	 * assistant messages are as the event log holds them; every finished turn's reply is whole. A turn still running is shown
	 * up to its last stored event.
	 */
	async replay(detail: ThreadDetail): Promise<void> {
		const thread = this.#requireThread();
		this.#model = detail.model;
		this.#thinking = detail.thinking;
		this.#rememberTurns(detail);
		for (let after = 0; ; ) {
			const page = await this.#cloud.client.eventsPage(thread, { after, limit: 500 });
			for (const event of page.events) await this.#onEvent(event, detail);
			if (page.next === null) break;
			after = page.next;
		}
		this.#flushHeld();
		if (detail.question?.kind === "ask") this.#ask(detail.question);
	}

	async prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse> {
		if (this.#busy) throw RequestError.sessionBusy("a prompt is already running in this session", { reason: "session_busy" });
		this.#busy = true;
		try {
			const text = promptText(blocks, this.cwd);
			this.#cancelRequested = false;
			this.#textTail = false;
			const own = command(text);
			if (own !== undefined) return await this.#command(own.name, own.arg);
			const { client } = this.#cloud;
			if (this.#thread === undefined && this.#launchFailed) {
				const found = (await client.listThreadsPage({ ref: this.id, limit: 1 })).threads[0];
				if (found !== undefined) this.#adopt(found, found.model, found.thinking);
			}
			if (this.#thread === undefined) return await this.#start(text);
			const thread = this.#thread;
			const question = this.#question;
			if (question !== null) {
				try {
					await client.answer(thread, question.turn, question.id, answerBody(question, text));
					this.#question = null;
					return await this.#followTurn(question.turn);
				} catch (error) {
					// The question is no longer open (answered elsewhere, or timed out): the text is a message.
					if (!(error instanceof CloudError) || error.status !== 409) throw error;
					this.#question = null;
				}
			}
			const sent = await client.sendMessage(thread, text);
			this.#sent.add(sent.turn.id);
			return await this.#followTurn(sent.turn.id);
		} finally {
			this.#busy = false;
		}
	}

	async cancel(): Promise<void> {
		this.#cancelRequested = true;
		this.#launch?.abort();
		if (this.#thread === undefined) return;
		try {
			await this.#cloud.client.stop(this.#thread);
		} catch {
			// The stop did not reach the service: the prompt ends here, the turn runs on.
			this.#following?.finish("cancelled");
		}
	}

	/** Ends whatever the session waits on. The thread itself is untouched. */
	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#commands);
		this.#launch?.abort();
		this.#following?.finish("cancelled");
	}

	// ---- prompts

	/** The first prompt: hands the workspace off and follows the thread's first turn. */
	async #start(text: string): Promise<PromptResponse> {
		const abort = new AbortController();
		this.#launch = abort;
		let outcome: LaunchedThread;
		try {
			outcome = await this.#env.launch(this.#cloud, {
				cwd: this.cwd,
				prompt: text,
				ref: this.id,
				model: this.#model,
				thinking: this.#thinking,
				signal: abort.signal,
				onProgress: progress => {
					if (progress.phase === "packing") this.#thought("packing the repository and the omp setup");
					else this.#thought(progress.note !== undefined && progress.note !== "" ? `uploading: ${progress.note}` : "uploading");
				},
			});
		} catch (error) {
			this.#launchFailed = true;
			if (abort.signal.aborted) return { stopReason: "cancelled" };
			throw error;
		} finally {
			this.#launch = undefined;
		}
		const { response } = outcome;
		const first = response.latest?.id ?? 1;
		this.#sent.add(first);
		this.#send({
			sessionUpdate: "tool_call",
			toolCallId: "handoff",
			title: `omp-cloud thread ${response.id} started`,
			kind: "other",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: handoffLines(outcome, this.#mcpServers).join("\n") } }],
		});
		this.#adopt(response, outcome.summary.model, outcome.summary.thinking);
		// The cancel arrived while the create was on its way: the thread exists, so its turn is stopped.
		if (this.#cancelRequested || this.#disposed) await this.#cloud.client.stop(response.id).catch(() => {});
		return this.#followTurn(first);
	}

	/** The session's thread from now on: its model and thinking level are what the thread runs. */
	#adopt(thread: Pick<ThreadSummary, "id" | "name" | "title">, model: string, thinking: string): void {
		this.#thread = thread.id;
		this.#model = model;
		this.#thinking = thinking;
		this.#send({ sessionUpdate: "config_option_update", configOptions: this.options() });
		this.#send({ sessionUpdate: "session_info_update", title: thread.name || thread.title });
	}

	async #command(name: "pull" | "follow", arg: string): Promise<PromptResponse> {
		const thread = this.#thread;
		if (thread === undefined) {
			this.#emitText("This session has no cloud thread yet: send a prompt to start one.");
			return { stopReason: "end_turn" };
		}
		if (name === "follow") {
			// The newest turn that runs or waits to.
			const turn = (await this.#cloud.client.thread(thread)).turns.findLast(candidate => candidate.state === "running" || candidate.state === "queued");
			if (turn !== undefined) return this.#followTurn(turn.id);
			this.#emitText("No turn is running.");
			return { stopReason: "end_turn" };
		}
		if (arg !== "" && arg !== "merge") {
			this.#emitText("usage: /pull [merge]");
			return { stopReason: "end_turn" };
		}
		try {
			const applied = await this.#env.pull(this.#cloud, { cwd: this.cwd, thread, apply: arg === "merge" ? "merge" : "fetch" });
			const commits = applied.commits !== undefined ? `, ${applied.commits} commits` : "";
			this.#emitText(`${applied.branch} is at ${applied.head.slice(0, 8)}${commits}: ${applied.next}`);
		} catch (error) {
			if (!(error instanceof CloudError)) throw error;
			this.#emitText(cloudErrorText(error));
		}
		return { stopReason: "end_turn" };
	}

	// ---- following a turn

	/** Follows the thread until turn `target` ends, or an `ask` question hands the conversation back to the user. */
	async #followTurn(target: number): Promise<PromptResponse> {
		const thread = this.#requireThread();
		if (await this.#pendingQuestion()) return { stopReason: "end_turn" };
		const done = Promise.withResolvers<PromptResponse>();
		const following: Following = {
			target,
			settled: false,
			finish: (reason, usage) => {
				following.settled = true;
				done.resolve({ stopReason: reason, ...(usage !== undefined ? { usage } : {}) });
			},
			fail: error => {
				following.settled = true;
				done.reject(error);
			},
		};
		this.#following = following;
		if (this.#disposed) following.finish("cancelled");
		const follower = follow(
			(id, options) => this.#cloud.client.events(id, { ...options, onText: live => this.#enqueue(following, () => this.#onText(live)) }),
			thread,
			{ onEvent: event => this.#enqueue(following, () => this.#onEvent(event)), onGiveUp: () => following.fail(RequestError.resourceNotFound(this.id)) },
			{ after: this.#lastSeq, ...this.#env.follow },
		);
		try {
			return await done.promise;
		} finally {
			follower.stop();
			await this.#chain;
			this.#following = undefined;
		}
	}

	/** Runs `work` after everything queued before it; once the follow has ended nothing more runs, so the next follow starts at the first event this one did not handle. */
	#enqueue(following: Following, work: () => void | Promise<void>): void {
		this.#chain = this.#chain.then(async () => {
			if (following.settled) return;
			try {
				await work();
			} catch (error) {
				following.fail(error);
			}
		});
	}

	/** Reply text as omp writes it (rule R1): only what the editor does not have yet. */
	#onText(live: LiveText): void {
		this.#flushHeld();
		let shown = this.#live;
		if (shown === null || shown.turn !== live.turn || shown.message !== live.message) {
			shown = { turn: live.turn, message: live.message, have: 0 };
			this.#live = shown;
			this.#last = "";
		}
		const piece = live.text.slice(Math.max(0, shown.have - live.offset));
		if (piece !== "") {
			this.#emitText(piece, shown.have > 0);
			this.#last += piece;
		}
		shown.have = Math.max(shown.have, live.offset + live.text.length);
	}

	/**
	 * One event of the thread's log as session updates. `history` is the thread when a load replays the log: then nothing is
	 * live, a question is not put to anybody and no turn is the one a prompt waits on.
	 */
	async #onEvent(event: ThreadEvent, history?: ThreadDetail): Promise<void> {
		this.#lastSeq = event.seq;
		const following = history === undefined ? this.#following : undefined;
		const target = following !== undefined && event.turn === following.target;
		switch (event.kind) {
			case "turn_started": {
				this.#flushHeld();
				this.#live = null;
				this.#last = "";
				if (event.turn === null || this.#sent.has(event.turn)) return;
				const text = await this.#turnText(event.turn);
				if (text !== "") this.#send({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
				return;
			}
			case "assistant": {
				// Rule R2: a message that streamed is shown already; a stored one waits, in case it is the turn's reply.
				const streamed = this.#live !== null && this.#live.turn === event.turn && this.#live.have > 0;
				this.#live = null;
				if (streamed) return;
				this.#flushHeld();
				this.#held = event.text;
				return;
			}
			case "tool_start":
				this.#flushHeld();
				this.#sendMaybe(toolStart(event));
				return;
			// `tool_end` and `usage` also arrive between a turn's last message and its end: they leave a held message alone.
			case "tool_end":
				this.#sendMaybe(toolEnd(event));
				return;
			case "usage":
				this.#sendMaybe(usageUpdate(event));
				return;
			// A replayed question is history: whatever answered it is in the log too.
			case "question_asked":
				if (history === undefined && (await this.#pendingQuestion())) following?.finish("end_turn");
				return;
			case "turn_done": {
				const detail = history ?? (await this.#cloud.client.thread(this.#requireThread()));
				const turn = detail.turns.find(candidate => candidate.id === event.turn);
				this.#showReply(turn?.reply ?? "");
				if (turn !== undefined && turn.filesChanged > 0) this.#showResult(detail, turn);
				this.#send({ sessionUpdate: "session_info_update", title: detail.name || detail.title, updatedAt: detail.lastActivityAt });
				if (target) following?.finish("end_turn", usageOf(turn));
				return;
			}
			case "turn_failed":
				this.#flushHeld();
				if (!target) this.#thought(`turn ${event.turn ?? "?"} failed: ${event.text}`);
				else if (this.#cancelRequested) following?.finish("cancelled");
				else following?.fail(RequestError.internalError(undefined, event.text));
				return;
			case "turn_cancelled":
				this.#flushHeld();
				if (target) following?.finish("cancelled");
				return;
			case "thread_failed":
				this.#flushHeld();
				following?.fail(RequestError.internalError(undefined, event.text));
				return;
			default:
				if (THOUGHT_KINDS.has(event.kind)) this.#thought(event.text);
		}
	}

	/** Rule R5: a finished turn's reply is always shown whole, once. */
	#showReply(reply: string): void {
		if (this.#held !== null) {
			const text = reply || this.#held;
			this.#held = null;
			this.#last = text;
			this.#emitText(text);
		} else if (reply !== "" && this.#last.trim() !== reply) {
			this.#last = reply;
			this.#emitText(reply);
		}
	}

	/** What a turn changed and how the editor's repository gets it. */
	#showResult(detail: ThreadDetail, turn: ThreadTurn): void {
		const branch = detail.result?.branch || threadBranch(detail.id);
		const lines = [
			detail.scratch
				? `scratch workspace: /cloud pull ${detail.id} --into <dir> in omp clones it`
				: `/pull fetches ${branch} into this repository; /pull merge also fast-forwards the current branch.`,
		];
		if (turn.pushRef !== "") lines.push(`pushed to ${turn.pushRef}`);
		if (detail.pr !== null) lines.push(`pull request: ${detail.pr.url}`);
		this.#send({
			sessionUpdate: "tool_call",
			toolCallId: `result-${turn.id}`,
			title: `${branch}: ${turn.filesChanged} files changed, +${turn.insertions} -${turn.deletions}`,
			kind: "other",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: lines.join("\n") } }],
		});
	}

	// ---- questions

	/**
	 * Deals with the thread's open questions. An approval or a push question goes to the editor's permission dialog, each
	 * once. True for an `ask` question: it is shown, and the user's next prompt answers it.
	 */
	async #pendingQuestion(): Promise<boolean> {
		const thread = this.#requireThread();
		for (;;) {
			const question = (await this.#cloud.client.thread(thread)).question;
			if (question === null) return false;
			if (question.kind === "ask") {
				this.#flushHeld();
				this.#ask(question);
				return true;
			}
			const key = `${question.turn}-${question.id}`;
			if (this.#asked.has(key)) return false;
			this.#asked.add(key);
			// The push question comes after the turn's last message, which stays held for the whole reply; an approval comes
			// after the message that asked for the tool call.
			if (question.kind === "approval") this.#flushHeld();
			await this.#approve(thread, question);
		}
	}

	#ask(question: PendingQuestion): void {
		this.#emitText(questionText(question));
		this.#question = question;
	}

	async #approve(thread: string, question: PendingQuestion): Promise<void> {
		const toolCallId = `question-${question.turn}-${question.id}`;
		this.#send({ sessionUpdate: "tool_call", toolCallId, title: question.text, kind: "other", status: "pending" });
		const { outcome } = await this.#connection.requestPermission({
			sessionId: this.id,
			toolCall: { toolCallId, title: question.text },
			options: question.options.map(option => ({ optionId: option.label, name: option.label, kind: option.label === "Approve" || option.label === "Push" ? "allow_once" : "reject_once" })),
		});
		if (outcome.outcome !== "selected") {
			// The editor cancels its dialog with the prompt; the stop that came with it expires the question.
			this.#send({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
			return;
		}
		try {
			await this.#cloud.client.answer(thread, question.turn, question.id, { selected: [outcome.optionId] });
		} catch (error) {
			if (!(error instanceof CloudError) || error.status !== 409) throw error;
		}
		this.#send({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
	}

	// ---- updates

	#requireThread(): string {
		if (this.#thread === undefined) throw RequestError.internalError(undefined, "the session has no cloud thread");
		return this.#thread;
	}

	#rememberTurns(detail: ThreadDetail): void {
		for (const turn of detail.turns) this.#turnTexts.set(turn.id, turn.text);
	}

	/** The prompt of a turn somebody else sent; the thread is read when the turn is not known yet. */
	async #turnText(turn: number): Promise<string> {
		if (!this.#turnTexts.has(turn)) this.#rememberTurns(await this.#cloud.client.thread(this.#requireThread()));
		return this.#turnTexts.get(turn) ?? "";
	}

	/** The SDK writes frames in call order; an update that cannot be written is lost with its connection. */
	#send(update: SessionUpdate): void {
		this.#textTail = false;
		void this.#connection.sessionUpdate({ sessionId: this.id, update }).catch(() => {});
	}

	#sendMaybe(update: SessionUpdate | undefined): void {
		if (update !== undefined) this.#send(update);
	}

	#thought(line: string): void {
		this.#send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `${line}\n` } });
	}

	/** Reply text. A message that starts right after another one's text is set apart from it, since an editor joins chunks. */
	#emitText(text: string, continues = false): void {
		const lead = !continues && this.#textTail ? "\n\n" : "";
		this.#send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${lead}${text}` } });
		this.#textTail = true;
	}

	/** Rule R4: shows the stored message that waited. */
	#flushHeld(): void {
		if (this.#held === null) return;
		const text = this.#held;
		this.#held = null;
		this.#last = text;
		this.#emitText(text);
	}
}
