/**
 * Delivery of cards into the local conversation.
 *
 * - Threads the user started with `/cloud` only display their cards: an idle session shows them
 *   at once without a model turn; a busy one holds them until the agent ends.
 * - Threads the local model started with the `cloud` tool (`origin: "tool"`) wake the model with
 *   their turn and question cards: `triggerTurn` when idle, an aside (next step boundary, no
 *   interruption of the running tool batch) when busy.
 */

import type { TerminalNotification } from "@oh-my-pi/pi-tui";
import { CARD_TYPE, CARD_VERSION, asCard, cardContent, cardEvents, DETAILS_REPLY_MAX, noticeCard, QUESTIONS, questionCard, threadBranch, threadLabel, type CardDetails, type LaunchCard, type NoticeCard, type TurnCard } from "./cards";
import type { DeliverMode } from "./config";
import { clip, controlFree, spanBetween, threadHeading, turnCost } from "./format";
import { isRecord } from "./guards";
import type { JobSettled } from "./cloud-jobs";
import type { Inbox, InboxKind } from "./inbox";
import type { HandoffSummary } from "./launch";
import type { WatchSink } from "./watch";
import type { Host, PendingQuestion, PiHost, ThreadDetail, ThreadEvent, ThreadOrigin, ThreadTurn } from "./types";

interface Message {
	customType: string;
	content: string;
	display: boolean;
	details: CardDetails;
	/** Cards are relayed text, never the user's words: the model must not read them as user input. */
	attribution: "agent";
}

/** Whether a card wakes the model: a tool-started thread's results and questions, and the notices that say it will not get a result. */
function wakesModel(d: CardDetails): boolean {
	return d.origin === "tool" && (d.kind === "turn" || d.kind === "question" || d.kind === "notice");
}

/** A notice for the model about a thread of its own; only this plugin's words, so nothing in it is fenced. */
function modelNotice(title: string, lines: string[]): NoticeCard {
	return { ...noticeCard("", title, lines), origin: "tool" };
}

/** Thread origins recorded in the launch cards of a session's entries. */
export function originsFromEntries(entries: readonly unknown[]): Map<string, ThreadOrigin> {
	const out = new Map<string, ThreadOrigin>();
	for (const e of entries) {
		if (!isRecord(e) || e.type !== "custom_message" || e.customType !== CARD_TYPE) continue;
		const card = asCard(e.details);
		if (card?.kind === "launch") out.set(card.thread, card.origin);
	}
	return out;
}

/** Ids of the threads the session's cards name: the ones it launched, was told about or was asked a question by. */
export function threadsFromEntries(entries: readonly unknown[]): Set<string> {
	const out = new Set<string>();
	for (const e of entries) {
		if (!isRecord(e) || e.type !== "custom_message" || e.customType !== CARD_TYPE) continue;
		const card = asCard(e.details);
		if (card && card.kind !== "inventory" && card.thread !== "") out.add(card.thread);
	}
	return out;
}

export function launchCard(args: { origin: ThreadOrigin; thread: string; name: string; prompt: string; summary: HandoffSummary; warnings: string[] }): LaunchCard {
	const s = args.summary;
	return {
		v: CARD_VERSION,
		kind: "launch",
		origin: args.origin,
		thread: args.thread,
		name: args.name,
		model: s.model,
		thinking: s.thinking,
		ompVersion: s.ompVersion,
		prompt: args.prompt,
		repo: { ...s.repo, branch: threadBranch(args.thread) },
		scratch: s.scratch,
		commits: s.commits,
		base: s.base,
		wip: s.wip,
		untracked: s.untracked,
		untrackedTotal: s.untrackedTotal,
		withheld: s.withheld,
		secrets: s.secrets,
		conversation: s.conversation,
		setupBytes: s.setupBytes,
		overlays: s.overlays,
		mcp: s.mcp,
		...(s.setup !== null ? { environment: s.setup.cacheFiles === undefined ? {} : { cacheFiles: s.setup.cacheFiles } } : {}),
		policy: s.policy,
		warnings: args.warnings,
	};
}

/** What the tray delivery needs: where entries go, which mode is on now, how the terminal is told. */
export interface TrayOptions {
	inbox: Pick<Inbox, "add" | "resolve" | "hasQuestion" | "forget">;
	/** Read on every turn: the setting may change between commands. */
	mode: () => DeliverMode;
	notify: (notification: TerminalNotification) => void;
	/** Whether omp's own setting for this kind of notice (`completion.notify`, `error.notify`, `ask.notify`) is on; absent allows all. */
	allow?: (type: "completion" | "error" | "ask") => boolean;
	now?: () => number;
}

/** The first non-empty line of `text`, control-free, cut for a notification body. */
function firstLine(text: string): string {
	return clip(controlFree(text.split("\n").find(l => controlFree(l) !== "") ?? ""), 200);
}

/** Posts cards to the session and feeds the watcher's turn and question events into them. */
export class Deliverer implements WatchSink {
	readonly #pi: Pick<PiHost, "sendMessage">;
	readonly #tray: TrayOptions | undefined;
	readonly #origins = new Map<string, ThreadOrigin>();
	/** `<thread>:<turn>:<question>` of the questions whose card was posted. */
	readonly #carded = new Set<string>();
	#pending: Message[] = [];

	/** Without `tray` every card goes to the transcript. */
	constructor(pi: Pick<PiHost, "sendMessage">, tray?: TrayOptions) {
		this.#pi = pi;
		this.#tray = tray;
	}

	setOrigin(thread: string, origin: ThreadOrigin): void {
		this.#origins.set(thread, origin);
	}

	/** The origin of a thread: remembered, else recovered from the session's launch cards, else the user. */
	originOf(host: Host, thread: string): ThreadOrigin {
		const known = this.#origins.get(thread);
		if (known) return known;
		const entries = host.sessionManager.getEntries?.() ?? [];
		for (const [id, origin] of originsFromEntries(entries)) this.#origins.set(id, origin);
		return this.#origins.get(thread) ?? "user";
	}

	/** Sends the card; see the module comment for who is woken. `content` replaces the text the model sees, `wakes: false` keeps a card that would wake it from doing so. */
	post(host: Host, d: CardDetails, how: { content?: string; wakes?: boolean } = {}): void {
		const msg: Message = { customType: CARD_TYPE, content: how.content ?? cardContent(d), display: true, details: d, attribution: "agent" };
		const wakes = wakesModel(d) && how.wakes !== false;
		if (host.isIdle()) {
			this.#pi.sendMessage(msg, { triggerTurn: wakes });
		} else if (wakes) {
			this.#pi.sendMessage(msg, { deliverAs: "aside" });
		} else {
			this.#pending.push(msg);
		}
	}

	/** Shows cards held back while the agent was busy; a no-op until it is idle. */
	flush(host: Host): void {
		if (this.#pending.length === 0 || !host.isIdle()) return;
		const held = this.#pending;
		this.#pending = [];
		for (const msg of held) this.#pi.sendMessage(msg, { triggerTurn: false });
	}

	/** Number of cards waiting for the agent to be idle. */
	get held(): number {
		return this.#pending.length;
	}

	/** The finished turn as the card the transcript shows. */
	#turnCard(host: Host, thread: ThreadDetail, turn: ThreadTurn & { state: "done" | "failed" }, events: ThreadEvent[]): TurnCard {
		return {
			v: CARD_VERSION,
			kind: "turn",
			origin: this.originOf(host, thread.id),
			thread: thread.id,
			name: thread.name,
			turn: turn.id,
			state: turn.state,
			title: turn.title,
			duration: spanBetween(turn.startedAt || turn.queuedAt, turn.completedAt),
			model: thread.model,
			cost: turnCost(turn),
			head: turn.head,
			filesChanged: turn.filesChanged,
			insertions: turn.insertions,
			deletions: turn.deletions,
			pushed: turn.pushed,
			pushError: turn.pushError,
			pushRef: turn.pushRef,
			prUrl: thread.pr?.url ?? "",
			branch: threadBranch(thread.id),
			reply: turn.reply.slice(0, DETAILS_REPLY_MAX),
			error: turn.error,
			events: cardEvents(events),
		};
	}

	/**
	 * Whether the thread's finished turns and questions go to the inbox and a terminal notification instead of the transcript:
	 * the user's own threads, unless `deliver: transcript`. A thread the model delegated keeps its cards, which wake the model.
	 */
	tray(host: Host, thread: string): boolean {
		return this.#tray !== undefined && this.#tray.mode() === "tray" && this.originOf(host, thread) === "user";
	}

	/** Adds an entry to the inbox and tells the terminal (its notification center, or the desktop's) unless omp's own setting for that kind of notice is off. */
	#intoInbox(tray: TrayOptions, thread: ThreadDetail, turn: number, kind: InboxKind, text: string, notice: { title: string; id: string; type: "completion" | "error" | "ask" }, extra: { permission?: boolean; questionId?: number } = {}): void {
		// The cloud wrote these: a control character in them would reach the terminal through the notification.
		const label = controlFree(threadHeading(thread, 40));
		const line = firstLine(text);
		tray.inbox.add({ thread: thread.id, turn, kind, label, line, at: tray.now?.() ?? Date.now(), ...(extra.permission ? { permission: true } : {}), ...(extra.questionId === undefined ? {} : { questionId: extra.questionId }) });
		if (tray.allow?.(notice.type) === false) return;
		tray.notify({ title: `☁ ${label} · ${notice.title}`, body: line, id: notice.id, type: notice.type, actions: "focus", urgency: "normal" });
	}

	/**
	 * `job` is the host job the turn was, when it was one: a model-started thread's job delivers the result itself (`job.native`: omp's
	 * `async-result` with the structured payload, or `wait`'s return), and a turn an IRC message woke has its reply relayed to the
	 * sender (`relayed`): in both the card would tell the model a second time, so none is posted.
	 */
	turn(host: Host, thread: ThreadDetail, turn: ThreadTurn, events: ThreadEvent[], job?: JobSettled, relayed = false): void {
		if (turn.state !== "done" && turn.state !== "failed") return;
		if (job?.native === true || relayed) return;
		if (this.#tray && this.tray(host, thread.id)) {
			const failed = turn.state === "failed";
			const text = failed ? turn.error : turn.reply;
			this.#intoInbox(this.#tray, thread, turn.id, failed ? "failure" : "result", text || turn.title || turn.state, {
				title: `turn ${turn.id} ${turn.state}`,
				id: `omp-cloud-${thread.id}-${turn.id}`,
				type: failed ? "error" : "completion",
			});
			return;
		}
		this.post(host, this.#turnCard(host, thread, { ...turn, state: turn.state }, events));
	}

	/** The hub's `o`: the turn's card in the transcript on demand, with its buttons; it never wakes the model. */
	open(host: Host, thread: ThreadDetail, turn: ThreadTurn): void {
		if (turn.state !== "done" && turn.state !== "failed") return;
		this.post(host, this.#turnCard(host, thread, { ...turn, state: turn.state }, []), { wakes: false });
	}

	/** Settles the question cards of `thread` from what its turns say about their questions. */
	refreshed(thread: ThreadDetail): void {
		QUESTIONS.settle(thread.id, thread.turns);
	}

	question(host: Host, thread: ThreadDetail, q: PendingQuestion): void {
		if (this.#tray && this.tray(host, thread.id)) {
			// The same open question is announced again when the thread is watched again: once is enough.
			if (this.#tray.inbox.hasQuestion(thread.id, q.turn, q.id)) return;
			const key = thread.turns.find(t => t.id === q.turn)?.questions.find(x => x.id === q.id)?.key ?? "";
			const permission = key.startsWith("approval:") || key === "omp-cloud:push";
			this.#intoInbox(this.#tray, thread, q.turn, "question", q.text, { title: "asks", id: `omp-cloud-${thread.id}-${q.turn}q${q.id}`, type: "ask" }, { permission, questionId: q.id });
			return;
		}
		// Watching a thread again announces its open question again: the model must not be woken twice for one question.
		const key = `${thread.id}:${q.turn}:${q.id}`;
		if (this.#carded.has(key)) return;
		this.#carded.add(key);
		this.post(host, questionCard(this.originOf(host, thread.id), thread.id, thread.name, q));
	}

	/** The session lost contact with a thread the model started: it is told, since a result may now never arrive. A thread of the user's has only the watcher's toast. */
	lost(host: Host, thread: ThreadDetail): void {
		if (this.originOf(host, thread.id) !== "tool") return;
		const label = threadLabel({ name: thread.name, thread: thread.id });
		this.post(host, modelNotice(`${label}: lost contact with the cloud; use cloud status ${thread.id}`, ["The thread may still be running. This session keeps retrying and reports a finished turn if contact returns."]));
	}

	/** The service no longer has the thread: what the inbox held of it is moot. A thread the model started wakes it: its turn will never finish. `job` is the host job that stood for it; a model blocked in `wait` on it already has the failure. */
	gone(host: Host, thread: ThreadDetail, job?: JobSettled): void {
		this.#tray?.inbox.forget(thread.id);
		if (this.originOf(host, thread.id) !== "tool") return;
		const label = threadLabel({ name: thread.name, thread: thread.id });
		this.post(host, modelNotice(`${label}: thread was deleted`, ["The cloud no longer has this thread, so its turn will not finish and nothing can be read or pulled from it."]), { wakes: job?.waited !== true });
	}

	/** The model's job for a cloud turn was cancelled in omp, so its cloud turn is being stopped: told without a wake-up, since nothing it waits for has happened. `label` is the thread's name or title. */
	cancelled(host: Host, thread: string, label: string): void {
		if (this.originOf(host, thread) !== "tool") return;
		const card = modelNotice(`${threadLabel({ name: label, thread })}: its job in omp was cancelled, so its cloud turn is being stopped`, [`Nothing more arrives from this turn; cloud status ${thread} shows where the thread is, and a new message to it starts another turn.`]);
		const msg: Message = { customType: CARD_TYPE, content: cardContent(card), display: false, details: card, attribution: "agent" };
		// Idle: kept for the model's next turn without starting one. Busy: at the next step boundary of the turn that is running anyway.
		this.#pi.sendMessage(msg, host.isIdle() ? { triggerTurn: false, deliverAs: "nextTurn" } : { deliverAs: "aside" });
	}

	/** The thread has no open question: the entries of the ones it asked are settled. */
	answered(thread: string): void {
		this.#tray?.inbox.resolve(thread, "question");
	}
}
