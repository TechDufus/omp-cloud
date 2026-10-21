/**
 * The thread model the store persists and the API serves: threads, their turns (the messages sent to a thread),
 * the questions a turn asked, and the thread's append-only event log. Timestamps are ISO 8601 UTC strings with
 * millisecond precision (`Date.prototype.toISOString`). Empty optional text is `""`, never `undefined`.
 */
import type { ThreadPolicy } from "../settings/policy";

/**
 * A thread's phase, derived from its turns by the store:
 * `deleted` (tombstone) > `failed` (terminal, `Thread.error` says why) > `waiting` (the running turn has an
 * unanswered question) > `working` (a turn is running, or queued after some turn has started) > `starting`
 * (turns are queued and none has started yet) > `idle` (nothing queued or running).
 */
export const THREAD_PHASES = ["starting", "working", "waiting", "idle", "failed", "deleted"] as const;
export type ThreadPhase = (typeof THREAD_PHASES)[number];

/** A turn moves queued → running → done | failed, or queued → cancelled; a running turn may be requeued. */
export const TURN_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type TurnState = (typeof TURN_STATES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Thread ids: 12 characters of `[a-z0-9]`. They name the blob directory and the branch `omp-cloud/<id>`. */
export const THREAD_ID_PATTERN = /^[a-z0-9]{12}$/;

/** The result branch of thread `<id>` is `RESULT_BRANCH_PREFIX + id`. */
export const RESULT_BRANCH_PREFIX = "omp-cloud/";

/** The principal recorded when the thread model, not a person, answered a question. */
export const ANSWERED_BY_TIMEOUT = "timeout";
export const ANSWERED_BY_DROPPED = "dropped";
export const ANSWERED_BY_STOP = "stop";

/** The `by` that attributes a turn or an answer to a device: `device:<id>`. The owner token is attributed as `owner`. */
export function deviceActor(id: string): string {
	return `device:${id}`;
}

/** Limits of the thread model. Byte limits count UTF-8 bytes. */
export const MAX_TURNS = 200;
export const MAX_TEXT_BYTES = 32 * 1024;
export const MAX_QUESTIONS_PER_TURN = 20;
/** The longest question text and the longest free-text answer. */
export const MAX_QUESTION_TEXT_BYTES = 4000;
export const MAX_OPTIONS = 20;
export const MAX_OPTION_LABEL_BYTES = 200;
export const MAX_OPTION_DESCRIPTION_BYTES = 500;
export const MAX_QUESTION_KEY_BYTES = 200;
export const MAX_QUESTION_HEADER_BYTES = 200;
/** Event text is cut to this many characters (code points). */
export const MAX_EVENT_TEXT_CHARS = 500;
/** `irc` and `irc_in` events carry a whole message as JSON, so their text is cut at this many characters (code points), not at {@link MAX_EVENT_TEXT_CHARS}: the body is at most `MAX_TEXT_BYTES` characters and JSON escaping can multiply each by 6. */
export const MAX_IRC_EVENT_CHARS = MAX_TEXT_BYTES * 8;
/** The progress kinds whose `text` is one JSON object (`usage`, `tool_start`, `tool_end`, `child_start`, `child_progress`, `child_end`; see `runner/progress.ts` and `runner/children.ts`): cut at {@link MAX_STRUCTURED_EVENT_CHARS}, which the runner keeps them under, never at {@link MAX_EVENT_TEXT_CHARS}, which would break the JSON. */
export const STRUCTURED_EVENT_KINDS: readonly string[] = ["usage", "tool_start", "tool_end", "child_start", "child_progress", "child_end"];
export const MAX_STRUCTURED_EVENT_CHARS = 8000;
/** What a sender id and a message id may look like in `POST /api/v1/threads/{id}/irc`. */
export const IRC_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Event kinds of the thread's IRC traffic: `irc` is a message the VM agent wrote to a peer, `irc_in` one a peer sent it. */
export const IRC_OUT_EVENT = "irc";
export const IRC_IN_EVENT = "irc_in";
/** The origin of a turn a peer's IRC message started (`Turn.origin`); an ordinary message's is `""`. */
export type TurnOrigin = "" | "irc";

/** One IRC message as an `irc` or `irc_in` event carries it (the event's `text` is this as JSON). `replyTo` is `""` for none. */
export interface IrcPayload {
	id: string;
	from: string;
	to: string;
	body: string;
	replyTo: string;
	/** ISO 8601 UTC. */
	at: string;
}

/** How `Store.sendIrc` delivered a message: into the running turn, as a new turn, or as a new turn on a thread that was archived. */
export type IrcReceipt = "injected" | "woken" | "revived";

/** A message sent into a running turn that the runner has not (`pending`) or has (`sent`) handed to omp. */
export interface IrcInbound {
	id: string;
	turn: number;
	from: string;
	body: string;
	replyTo: string;
	at: string;
	state: "pending" | "sent";
}
/** `Thread.error` and a failed turn's `error` are cut to this many characters (code points). */
export const MAX_ERROR_CHARS = 1000;

/** Files stored per thread under `<dataDir>/threads/<id>/`. */
export const BLOB_NAMES = [
	"source.bundle",
	"result.bundle",
	"session.tar",
	"session-export.tar",
	"setup.tar.gz",
	"secrets.json",
] as const;
export type BlobName = (typeof BLOB_NAMES)[number];

export interface Repo {
	/** The checkout directory's base name, for display. */
	name: string;
	/** The remote URL with any credentials removed; `""` for a full-history upload without a remote. */
	remoteURL: string;
	/** The remote branch the base commit came from. */
	baseRef: string;
	/** The remote commit the uploaded delta builds on; `""` means the upload holds the full history. */
	baseCommit: string;
	/** The commit holding the owner's state at handoff, uncommitted changes included. */
	handoffCommit: string;
	/** The branch checked out on the owner's machine at handoff. */
	localBranch: string;
}

/** The owner's absolute home and workspace paths, mirrored in the VM; both `""` means the VM defaults. */
export interface Paths {
	home: string;
	workspace: string;
}

/** The git identity the thread's commits are made with. */
export interface Author {
	name: string;
	email: string;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** USD. */
	cost: number;
}

/** What `Store.spend` sums: the owner's turns completed since a point in time. */
export interface Spend {
	/** Sum over every counted turn. */
	total: Usage;
	/** Per thread, the highest cost first; `turns` counts the turns that reported usage. */
	threads: { thread: string; title: string; name: string; cost: number; turns: number }[];
	/** Per UTC day (`YYYY-MM-DD`) of the turn's completion, oldest first. */
	days: { day: string; cost: number }[];
}

export interface QuestionOption {
	/** Unique within the question. */
	label: string;
	description: string;
}

/** A question the agent asked during a turn (omp's `ask` tool), and its answer. */
export interface Question {
	/** 1-based, unique within the turn. */
	id: number;
	/** 1-based number of the `ask` call within the turn; the questions of one call are answered together. */
	ask: number;
	/** omp's question id inside its `ask` call. */
	key: string;
	text: string;
	header: string;
	options: QuestionOption[];
	multi: boolean;
	/** Index into `options`. */
	recommended: number | null;
	askedAt: string;
	/** Chosen option labels. */
	selected: string[];
	/** Free-text answer. */
	answer: string;
	/** The principal that answered, or `timeout` / `dropped` / `stop`; `""` while unanswered. */
	answeredBy: string;
	/** Set once answered or expired. */
	answeredAt: string | null;
	/** True when `timeout`, `dropped` or `stop` answered it, not a person. */
	expired: boolean;
	/** The id of omp's `extension_ui_request` that carried the ask, so the runner can answer it after a restart. Never served. */
	requestId: string | null;
	/** omp's own question id, uncut (`key` is cut to MAX_QUESTION_KEY_BYTES). Never served. */
	ompKey: string;
	/** omp's own option labels, uncut, in `options` order. Never served. */
	ompLabels: string[];
}

/** The sandbox a thread runs in, as the runner records it. Kept until the runner tears the VM down, also after the thread is deleted. */
export interface VmRecord {
	threadId: string;
	sandboxId: string;
	state: "running" | "paused";
	/** omp's pid in the sandbox; null before omp started. */
	pid: number | null;
	/** omp's session file in the sandbox; null until known. */
	sessionFile: string | null;
	updatedAt: string;
}

/** A setting an operator changed, as stored: `value` is JSON. A setting at its default has no record. */
export interface StoredSetting {
	key: string;
	value: string;
	updatedAt: string;
	updatedBy: string;
}

/**
 * One setting to write: `value` is JSON, or null to drop the stored value (back to the default). `audit`, when given,
 * maps a stored JSON value (or null) to what the audit log keeps of it: a secret's literal never reaches the log.
 */
export interface SettingChange {
	key: string;
	value: string | null;
	audit?: (json: string | null) => string | null;
}

/** What changed a setting: `set` and `reset` are one `PUT /settings` key, `import` a key an imported file changed. */
export type SettingsAuditAction = "set" | "reset" | "import";

/** One key's change as the audit log keeps it; `oldValue` and `newValue` are JSON, or null for the default. */
export interface SettingsAuditEntry {
	seq: number;
	at: string;
	actor: string;
	action: SettingsAuditAction;
	key: string;
	oldValue: string | null;
	newValue: string | null;
}

/** One question of an `ask` call, as the runner reports it. */
export interface QuestionInput {
	key: string;
	text: string;
	header: string;
	options: QuestionOption[];
	multi: boolean;
	recommended: number | null;
	/** omp's question id and option labels before they were cut to the store's limits; `ompLabels` follows `options` order. */
	ompKey: string;
	ompLabels: string[];
}

/** The oldest unanswered question of the running turn. */
export interface PendingQuestion {
	/** Id of the running turn that asked. */
	turn: number;
	question: Question;
	/** Unanswered questions of the same ask, this one included. */
	remaining: number;
}

/** One message sent to a thread and what became of it. */
export interface Turn {
	/** 1-based, never reused within the thread. */
	id: number;
	state: TurnState;
	text: string;
	/** The principal that sent the message. */
	by: string;
	queuedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	/** Set by a stop on the running turn; the runner aborts it and it ends as failed `stopped by <stoppedBy>`. */
	stopRequested: boolean;
	stoppedBy: string;
	reply: string;
	/** The origin of a turn: `irc` for one a peer's IRC message started (its `by` is the sender), else `""`. */
	origin: TurnOrigin;
	/** The sender of an `irc` turn; `""` otherwise. */
	ircFrom: string;
	/** The message id of an `irc` turn: the `replyTo` of the wake relay. `""` otherwise. */
	ircId: string;
	/** The `replyTo` the message carried; `""` for none. */
	ircReplyTo: string;
	/** Derived from the reply: its first non-empty line without leading markdown markers, cut to 80 characters. */
	title: string;
	error: string;
	usage: Usage | null;
	/** Tip of the result branch after the turn, with its diffstat against the base. */
	head: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	pushed: boolean;
	pushError: string;
	/** The remote branch the result was pushed to; `""` when it was not. */
	pushRef: string;
	/** When the runner handed the text to omp; null before. Lets a restarted runner tell a sent prompt from an unsent one. Never served. */
	promptSentAt: string | null;
	/** In id order. */
	questions: Question[];
	/** Model requests (assistant messages) of the turn. */
	requests: number;
	/** Tool calls of the turn. */
	tools: number;
	/** Context use at the turn's end; null when omp reported none. */
	context: { tokens: number; window: number } | null;
}

/** How a turn ended, as the runner reports it to `Store.completeTurn`. */
export interface TurnResult {
	/** `completed` makes the turn `done`; `failed` makes it `failed` with `error`. */
	outcome: "completed" | "failed";
	error: string;
	reply: string;
	usage: Usage | null;
	head: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	pushed: boolean;
	pushError: string;
	pushRef: string;
	/** Model requests (assistant messages) of the turn; absent means 0. */
	requests?: number;
	/** Tool calls of the turn; absent means 0. */
	tools?: number;
	/** Context use at the turn's end; absent means null. */
	context?: { tokens: number; window: number } | null;
}

export interface Thread {
	id: string;
	/** The principal that created the thread. Turns, questions and events belong to their thread's owner. */
	owner: string;
	phase: ThreadPhase;
	/** The first non-empty line of the first message, cut to 80 characters. */
	title: string;
	/** `provider/id` for every turn; `""` means the VM's default model. */
	model: string;
	/** One of `THINKING_LEVELS`, or `""` for the default. */
	thinking: string;
	repo: Repo;
	paths: Paths;
	author: Author;
	/** Workspace-relative paths of the shipped secret files; their contents live in the `secrets.json` blob. */
	secretFiles: string[];
	/** Names of the shipped secret variables; their values live in the `secrets.json` blob. */
	secretEnv: string[];
	/** The handing-off session's `--config` overlays: paths inside the shipped setup, relative to `~/.omp/agent`, in load order. */
	configOverlays: string[];
	/** The omp version the thread's VM runs (`<major>.<minor>.<patch>`). */
	ompVersion: string;
	/** What the create request tightened of the service's policy (see `settings/tighten.ts`); `{}` for none. */
	policy: ThreadPolicy;
	/** Why the thread failed; `""` unless `phase` is `failed`. */
	error: string;
	createdAt: string;
	/** The latest of the thread's creation and its turns' queued, started and completed times. */
	lastActivityAt: string;
	/** The short human name; `""` when the thread has none. */
	name: string;
	/** When the archive sweep released the thread's VM; null while it has one. The next message restores the thread. */
	archivedAt: string | null;
	/** The thread branch head the archive snapshot committed past the last turn; `""` for none. Cleared when a turn completes. */
	restoreHead: string;
	/** The latest context use omp reported; null before any. */
	context: ThreadContext | null;
	/** Who started the thread: `tool` (the model, through the cloud tool), `user` (a person) or `""` (unknown). */
	origin: ThreadOrigin | "";
	/** The caller's short label (`[A-Za-z0-9._-]{1,64}`); `""` for none. */
	ref: string;
	/** The omp session id that started the thread; `""` for none. */
	session: string;
	/** A thread without a repository: its base is an empty repository the service synthesized, and it never pushes. */
	scratch: boolean;
}

/** A validated create request: everything `Store.createThread` needs besides the id. */
export interface NewThread {
	owner: string;
	title: string;
	/** The first turn's message. */
	prompt: string;
	model: string;
	thinking: string;
	repo: Repo;
	paths: Paths;
	author: Author;
	secretFiles: string[];
	secretEnv: string[];
	configOverlays: string[];
	/** Resolved at create: the request's version, else the service host's. */
	ompVersion: string;
	policy: ThreadPolicy;
	/** Who sent the first turn: `owner` or `device:<id>`; absent means `owner`. */
	sentBy?: string;
	/** The thread's short human name (2 to 6 words); absent means `""`. */
	name?: string;
	/** `tool`, `user` or `""` (unknown); absent means `""`. */
	origin?: ThreadOrigin | "";
	/** The caller's short label; absent means `""`. */
	ref?: string;
	/** The omp session id that started the thread; absent means `""`. */
	session?: string;
	/** Marks a scratch thread; absent means false. */
	scratch?: boolean;
	/** The create request's `Idempotency-Key` and the SHA-256 (hex) of its prompt; absent means no key. The key is unique per owner among live threads. */
	idempotency?: { key: string; fingerprint: string };
}

export type ThreadOrigin = "tool" | "user";

/** The filters of a paged thread list; an absent filter does not narrow. */
export interface ThreadListFilter {
	/** Live phases to keep. */
	phases?: ThreadPhase[];
	origin?: ThreadOrigin;
	ref?: string;
	session?: string;
	/** The repository name. */
	repo?: string;
	/** Keep threads whose `lastActivityAt` is at or after this ISO time. */
	since?: string;
}

/** Where a paged list resumes: the position of the last thread of the previous page. */
export interface ThreadCursor {
	lastActivityAt: string;
	id: string;
}

/** One page of an owner's threads, newest `lastActivityAt` first (ties: id descending). */
export interface ThreadPage {
	threads: Thread[];
	/** The position to resume after this page; null at the end. */
	next: ThreadCursor | null;
	/** Every thread matching the filters, whatever the page. */
	total: number;
}

/** Contents of the `secrets.json` blob, written at create and read by the runner. */
export interface ThreadSecrets {
	/** In request order; `content` is base64. */
	files: { path: string; content: string }[];
	env: Record<string, string>;
}

/** One entry of a thread's append-only event log. */
export interface ThreadEvent {
	/** 1-based and gapless within the thread. */
	seq: number;
	at: string;
	/** Lifecycle kinds come from the store (see `docs/api.md`); progress kinds come from the runner. */
	kind: string;
	/** The turn the event belongs to, if any. */
	turn: number | null;
	text: string;
}

/** A paired device. A revoked one keeps its row (`revokedAt`) and its token no longer works. */
export interface Device {
	id: string;
	owner: string;
	/** Unique among the owner's active devices. */
	name: string;
	platform: string;
	createdAt: string;
	/** The address the pairing request came from. */
	pairedFrom: string;
	lastSeenAt: string | null;
	lastSeenAddress: string | null;
	revokedAt: string | null;
}

/** The states of a pairing offer; `expired` is never stored: it is a non-terminal offer past its `expiresAt`. */
export const OFFER_STATUSES = ["open", "pending", "approved", "paired", "declined", "cancelled", "burned", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** The device request redeemed against an offer. */
export interface OfferRequest {
	name: string;
	platform: string;
	address: string;
	at: string;
}

/** A pairing offer with its status as of the store's clock. */
export interface PairingOffer {
	id: string;
	owner: string;
	status: OfferStatus;
	createdAt: string;
	expiresAt: string;
	request: OfferRequest | null;
	/** The device the offer paired, once it did. */
	device: { id: string; name: string } | null;
}

/** What `Store.redeemOffer` takes: the offer, the secret's hash and the new request's identity (secret as a hash). */
export interface OfferRedemption {
	offerId: string;
	secretSha256: string;
	requestId: string;
	requestSecretSha256: string;
	name: string;
	platform: string;
	address: string;
}

/** `ok` when the offer was open and the secret right; every other case is one `rejected`, as the API answers them alike. */
export type RedeemOutcome = { kind: "ok"; expiresAt: string } | { kind: "rejected" };

/** A device `Store.claimOffer` may create: the id and token hash the caller minted. */
export interface NewDevice {
	id: string;
	tokenSha256: string;
}

/** A device `Store.addDevice` records: the caller minted the id and the token's hash; `pairedFrom` is where it came from. */
export interface NewDeviceRecord extends NewDevice {
	owner: string;
	name: string;
	platform: string;
	pairedFrom: string;
}

/** `pending` the owner has not decided; `created` the device now exists (with a name unique among active ones); `declined`; `rejected` any other case. */
export type ClaimOutcome =
	| { kind: "pending" }
	| { kind: "created"; device: { id: string; name: string } }
	| { kind: "declined" }
	| { kind: "rejected" };

/** What `Store.revokeDevice` reports: the device and the threads it started that are still running. */
export interface Revocation {
	device: Device;
	runningThreads: string[];
}

/** What thread summaries show besides the thread row, computed in one store call. */
export interface ThreadStats {
	turns: number;
	queued: number;
	/** The done or failed turn with the highest id. */
	latest: Turn | null;
	/** The turn with the highest id that has a non-empty `head`. */
	resultTurn: Turn | null;
	pending: PendingQuestion | null;
	/** Sums, counts and per-turn series over the thread's turns. */
	metrics: ThreadMetrics;
	/** The running turn's latest `tool` or `assistant` event; null when no turn runs or it has shown none. */
	activity: ThreadActivity | null;
}

/** The context use omp last reported for a thread. `window` 0 means omp did not know the model's window. */
export interface ThreadContext {
	tokens: number;
	window: number;
	at: string;
}

/** What a thread's turns add up to. */
export interface ThreadMetrics {
	/** Summed over the thread's turns. */
	usage: Usage;
	/** Model requests (assistant messages), summed over turns. */
	requests: number;
	/** Tool calls, summed over turns. */
	tools: number;
	/** Sum over finished turns of `completedAt - startedAt`, in milliseconds. */
	workMs: number;
	/** The latest context use; null before omp reported any. */
	context: ThreadContext | null;
	/** The last 12 finished (done or failed) turns, oldest first. */
	turns: { n: number; cost: number; contextTokens: number | null }[];
}

/** What a running turn last did. */
export interface ThreadActivity {
	kind: "tool" | "assistant";
	text: string;
	at: string;
}

export type StoreErrorCode =
	/** Unknown or deleted thread. */
	| "thread_not_found"
	/** The thread is in the terminal `failed` phase. */
	| "thread_failed"
	/** The thread already holds `MAX_TURNS` turns. */
	| "thread_full"
	/** A message that is empty or longer than `MAX_TEXT_BYTES`. */
	| "invalid_text"
	/** An IRC sender or message id that does not match `IRC_NAME_PATTERN`. */
	| "invalid_irc"
	/** The turn does not exist, is not running, or (for `askQuestions`) was asked to stop. */
	| "turn_not_running"
	/** A question breaks the limits; the message names which and why. */
	| "invalid_question"
	| "too_many_questions"
	/** Unknown turn, question or ask. */
	| "question_not_found"
	/** The question is answered or expired, or its turn is not running. */
	| "not_waiting"
	/** An answer that breaks the rules; the message says why. */
	| "invalid_answer"
	/** An event kind that does not match `^[a-z][a-z0-9_]{0,31}$`. */
	| "invalid_event"
	/** A blob over its byte limit. */
	| "too_large";

export class StoreError extends Error {
	readonly code: StoreErrorCode;

	constructor(code: StoreErrorCode, message: string) {
		super(message);
		this.name = "StoreError";
		this.code = code;
	}
}
