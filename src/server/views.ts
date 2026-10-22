import { PUSH_QUESTION_KEY } from "../runner/push";
import { cutChars } from "../store/rules";
import {
	type PendingQuestion,
	type Question,
	type QuestionOption,
	RESULT_BRANCH_PREFIX,
	type Thread,
	type ThreadActivity,
	type ThreadMetrics,
	type ThreadStats,
	type Turn,
	type TurnOrigin,
	type TurnState,
	type Usage,
	type VmRecord,
} from "../store/types";

/** A turn's message is cut to this many bytes in thread views; the store keeps the full text. */
export const MAX_TURN_TEXT_BYTES = 2000;
/** `latest.reply` is cut to this many characters (code points). */
export const MAX_LATEST_REPLY_CHARS = 3000;
/** `latest.error` is cut to this many characters (code points). */
export const MAX_LATEST_ERROR_CHARS = 1000;
/** `result.pushError` is cut to this many characters (code points). */
export const MAX_PUSH_ERROR_CHARS = 300;

/** What a question is for: `approval` a tool approval (`approval:<tool>`), `push` the service's push question, `ask` the agent's own `ask`. */
export type QuestionKind = "ask" | "approval" | "push";

/** A question as the API shows it, in a turn's `questions` and as the answer response. */
export interface QuestionView {
	id: number;
	ask: number;
	key: string;
	kind: QuestionKind;
	text: string;
	header: string;
	options: QuestionOption[];
	multi: boolean;
	recommended: number | null;
	askedAt: string;
	selected: string[];
	answer: string;
	answeredBy: string;
	answeredAt: string | null;
	/** When the question times out (`askedAt` plus `runner.questionTimeoutSeconds`); null once answered or when no timeout applies. */
	expiresAt: string | null;
	expired: boolean;
}

/** The oldest unanswered question of the running turn, in summaries. */
export interface PendingQuestionView {
	turn: number;
	id: number;
	ask: number;
	kind: QuestionKind;
	text: string;
	header: string;
	options: QuestionOption[];
	multi: boolean;
	recommended: number | null;
	askedAt: string;
	/** When the question times out; null when no timeout applies. */
	expiresAt: string | null;
	remaining: number;
}

export interface TurnView {
	id: number;
	state: TurnState;
	text: string;
	by: string;
	/** `irc` for a turn a peer's IRC message started (its `by` is the sender), else `""`. */
	origin: TurnOrigin;
	/** The sender of an `irc` turn; `""` otherwise. */
	ircFrom: string;
	/** The id of an `irc` turn's message: the `replyTo` of the wake relay. `""` otherwise. */
	ircId: string;
	/** The `replyTo` the message carried; `""` for none. */
	ircReplyTo: string;
	queuedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	reply: string;
	title: string;
	error: string;
	usage: Usage | null;
	head: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	pushed: boolean;
	pushError: string;
	/** The remote branch the turn's result was pushed to; `""` when it was not. */
	pushRef: string;
	/** Model requests (assistant messages) of the turn. */
	requests: number;
	/** Tool calls of the turn. */
	tools: number;
	/** Context use at the turn's end; null when omp reported none. */
	context: { tokens: number; window: number } | null;
	questions: QuestionView[];
}

/** The done or failed turn with the highest id. */
export interface LatestView {
	id: number;
	state: TurnState;
	title: string;
	reply: string;
	error: string;
	completedAt: string | null;
}

/** The state of the result branch, from the newest turn that recorded a head. */
export interface ResultView {
	branch: string;
	head: string;
	base: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	pushed: boolean;
	pushError: string;
	/** The remote branch the result was pushed to; `""` when it was not. */
	pushRef: string;
	updatedAt: string;
}

export interface ThreadSummaryView {
	id: string;
	title: string;
	owner: string;
	phase: Thread["phase"];
	error: string;
	turns: number;
	queued: number;
	model: string;
	thinking: string;
	ompVersion: string;
	latest: LatestView | null;
	question: PendingQuestionView | null;
	result: ResultView | null;
	createdAt: string;
	/** Where the thread's code came from: the repository's display name, credential-free remote (`""` when none), base branch and the owner's branch at handoff. */
	repo: Pick<Thread["repo"], "name" | "remoteURL" | "baseRef" | "localBranch">;
	/** The client's repository root as it wrote it (`paths.workspace`); `""` when it sent none. */
	workspace: string;
	lastActivityAt: string;
	/** The thread's short human name; `""` when it has none (clients then show `title`). */
	name: string;
	/** Who started the thread: `tool`, `user` or `""` when unknown. */
	origin: Thread["origin"];
	/** The caller's short label; `""` for none. */
	ref: string;
	/** The omp session id that started the thread; `""` for none. */
	session: string;
	/** True for a thread without a repository (an empty base the service synthesized; it never pushes). */
	scratch: boolean;
	/** When the archive sweep released the thread's VM; null while it has one. The next message restores the thread. */
	archivedAt: string | null;
	/** The pull request the thread's pushes opened; null before any. */
	pr: { number: number; url: string } | null;
	/** The memory bank the thread's laptop used for the project, which the cloud memories merge back into; `""` for none. */
	memoryBank: string;
	/** What the thread's turns add up to. `context.window` 0 means the window is unknown. */
	metrics: ThreadMetrics;
	/** The running turn's latest tool call or assistant message; null when no turn runs. */
	activity: ThreadActivity | null;
}

export interface ThreadDetailView extends Omit<ThreadSummaryView, "turns"> {
	turns: TurnView[];
	repo: Thread["repo"];
	paths: Thread["paths"];
	/** The `--config` overlays the session shipped, as sent. */
	configOverlays: string[];
	/** What the thread tightened of the service's policy, as sent and normalized; `{}` for none. */
	policy: Thread["policy"];
	/** The repository setup the thread's environment is built with (`run` script, `cacheFiles` that key the cache); null for none. */
	setup: { run: string; cacheFiles: string[] } | null;
	/** The sandbox the thread runs in; null before one exists. */
	vm: { sandboxId: string; state: VmRecord["state"]; pid: number | null } | null;
}

/** `text` cut to at most `max` bytes of UTF-8 without splitting a sequence. */
export function cutBytes(text: string, max: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= max) return text;
	let end = max;
	// A continuation byte (10xxxxxx) belongs to a sequence that started earlier: drop that whole sequence.
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return bytes.toString("utf8", 0, end);
}

function optionView(option: QuestionOption): QuestionOption {
	return { label: option.label, description: option.description };
}

/** The kind of the question stored under `key`. */
function questionKind(key: string): QuestionKind {
	if (key.startsWith("approval:")) return "approval";
	return key === PUSH_QUESTION_KEY ? "push" : "ask";
}

/** `askedAt` plus the timeout as an ISO time; null for no timeout (0) or an unreadable `askedAt`. */
function expiryOf(askedAt: string, questionTimeoutSeconds: number): string | null {
	const asked = Date.parse(askedAt);
	if (questionTimeoutSeconds <= 0 || Number.isNaN(asked)) return null;
	return new Date(asked + questionTimeoutSeconds * 1000).toISOString();
}

/** One question with every field present. `questionTimeoutSeconds` (0: none) gives an unanswered question its `expiresAt`. */
export function questionView(q: Question, questionTimeoutSeconds = 0): QuestionView {
	return {
		id: q.id,
		ask: q.ask,
		key: q.key,
		kind: questionKind(q.key),
		text: q.text,
		header: q.header,
		options: q.options.map(optionView),
		multi: q.multi,
		recommended: q.recommended,
		askedAt: q.askedAt,
		selected: [...q.selected],
		answer: q.answer,
		answeredBy: q.answeredBy,
		answeredAt: q.answeredAt,
		expiresAt: q.answeredAt === null ? expiryOf(q.askedAt, questionTimeoutSeconds) : null,
		expired: q.expired,
	};
}

function pendingQuestionView(p: PendingQuestion, questionTimeoutSeconds: number): PendingQuestionView {
	const q = p.question;
	return {
		turn: p.turn,
		id: q.id,
		ask: q.ask,
		kind: questionKind(q.key),
		text: q.text,
		header: q.header,
		options: q.options.map(optionView),
		multi: q.multi,
		recommended: q.recommended,
		askedAt: q.askedAt,
		expiresAt: expiryOf(q.askedAt, questionTimeoutSeconds),
		remaining: p.remaining,
	};
}

/** One turn with its message cut to MAX_TURN_TEXT_BYTES and its questions (`questionTimeoutSeconds` as in {@link questionView}). */
export function turnView(t: Turn, questionTimeoutSeconds = 0): TurnView {
	return {
		id: t.id,
		state: t.state,
		text: cutBytes(t.text, MAX_TURN_TEXT_BYTES),
		by: t.by,
		origin: t.origin,
		ircFrom: t.ircFrom,
		ircId: t.ircId,
		ircReplyTo: t.ircReplyTo,
		queuedAt: t.queuedAt,
		startedAt: t.startedAt,
		completedAt: t.completedAt,
		reply: t.reply,
		title: t.title,
		error: t.error,
		usage: t.usage === null ? null : { ...t.usage },
		head: t.head,
		filesChanged: t.filesChanged,
		insertions: t.insertions,
		deletions: t.deletions,
		pushed: t.pushed,
		pushError: t.pushError,
		pushRef: t.pushRef,
		requests: t.requests,
		tools: t.tools,
		context: t.context === null ? null : { ...t.context },
		questions: t.questions.map((q) => questionView(q, questionTimeoutSeconds)),
	};
}

function latestView(t: Turn): LatestView {
	return {
		id: t.id,
		state: t.state,
		title: t.title,
		reply: cutChars(t.reply, MAX_LATEST_REPLY_CHARS),
		error: cutChars(t.error, MAX_LATEST_ERROR_CHARS),
		completedAt: t.completedAt,
	};
}

function resultView(thread: Thread, t: Turn): ResultView {
	return {
		branch: RESULT_BRANCH_PREFIX + thread.id,
		head: t.head,
		base: thread.repo.baseCommit,
		filesChanged: t.filesChanged,
		insertions: t.insertions,
		deletions: t.deletions,
		pushed: t.pushed,
		pushError: cutChars(t.pushError, MAX_PUSH_ERROR_CHARS),
		pushRef: t.pushRef,
		updatedAt: t.completedAt ?? t.queuedAt,
	};
}

function metricsView(m: ThreadMetrics): ThreadMetrics {
	return {
		usage: { ...m.usage },
		requests: m.requests,
		tools: m.tools,
		workMs: m.workMs,
		context: m.context === null ? null : { ...m.context },
		turns: m.turns.map((turn) => ({ ...turn })),
	};
}

/** A thread as listed and as returned by the create request (`questionTimeoutSeconds` as in {@link questionView}). */
export function summaryView(thread: Thread, stats: ThreadStats, questionTimeoutSeconds = 0): ThreadSummaryView {
	return {
		id: thread.id,
		title: thread.title,
		name: thread.name,
		origin: thread.origin,
		ref: thread.ref,
		session: thread.session,
		scratch: thread.scratch,
		owner: thread.owner,
		phase: thread.phase,
		error: thread.error,
		turns: stats.turns,
		queued: stats.queued,
		model: thread.model,
		thinking: thread.thinking,
		ompVersion: thread.ompVersion,
		latest: stats.latest === null ? null : latestView(stats.latest),
		question: stats.pending === null ? null : pendingQuestionView(stats.pending, questionTimeoutSeconds),
		result: stats.resultTurn === null ? null : resultView(thread, stats.resultTurn),
		createdAt: thread.createdAt,
		repo: {
			name: thread.repo.name,
			remoteURL: thread.repo.remoteURL,
			baseRef: thread.repo.baseRef,
			localBranch: thread.repo.localBranch,
		},
		workspace: thread.paths.workspace,
		lastActivityAt: thread.lastActivityAt,
		archivedAt: thread.archivedAt,
		pr: thread.pr === null ? null : { ...thread.pr },
		memoryBank: thread.memoryBank,
		metrics: metricsView(stats.metrics),
		activity: stats.activity === null ? null : { ...stats.activity },
	};
}

/** The summary's fields with `turns` the turn objects, plus `repo`, `paths` and the thread's VM. `turns` are all of the thread's turns. */
export function detailView(thread: Thread, stats: ThreadStats, turns: Turn[], vm: VmRecord | null, questionTimeoutSeconds = 0): ThreadDetailView {
	return {
		...summaryView(thread, stats, questionTimeoutSeconds),
		turns: turns.map((turn) => turnView(turn, questionTimeoutSeconds)),
		repo: { ...thread.repo },
		paths: { ...thread.paths },
		configOverlays: [...thread.configOverlays],
		policy: structuredClone(thread.policy),
		setup: thread.setup === null ? null : { run: thread.setup.run, cacheFiles: [...thread.setup.cacheFiles] },
		vm: vm === null ? null : { sandboxId: vm.sandboxId, state: vm.state, pid: vm.pid },
	};
}
