/** Wire types of the omp-cloud API (`docs/api.md`) and the host surface the extension needs. */

import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ExtensionUIContext, Settings } from "@oh-my-pi/pi-coding-agent";
import type { Component, Theme, TUI } from "@oh-my-pi/pi-tui";

// ---------------------------------------------------------------------------
// Cloud API responses (every field is always present; absent values are null, "", 0, false or [])
// ---------------------------------------------------------------------------

export type TurnState = "queued" | "running" | "done" | "failed" | "cancelled";
export type ThreadPhase = "starting" | "working" | "waiting" | "idle" | "failed";

/** Who a question is for: the model (`ask`), the human only (`approval`, `push`). */
export type QuestionKind = "ask" | "approval" | "push";

export interface QuestionOption {
	label: string;
	description: string;
}

/** The oldest unanswered question of a thread (`ThreadSummary.question`). */
export interface PendingQuestion {
	turn: number;
	id: number;
	ask: number;
	text: string;
	header: string;
	options: QuestionOption[];
	multi: boolean;
	recommended: number | null;
	askedAt: string;
	kind: QuestionKind;
	/** ISO time the question times out; null when no timeout applies. */
	expiresAt: string | null;
	/** Unanswered questions of that ask, this one included. */
	remaining: number;
}

/** One question of a turn (`ThreadTurn.questions`) with its answer, once given. */
export interface Question {
	id: number;
	ask: number;
	key: string;
	text: string;
	header: string;
	options: QuestionOption[];
	multi: boolean;
	recommended: number | null;
	askedAt: string;
	kind: QuestionKind;
	expiresAt: string | null;
	selected: string[];
	answer: string;
	answeredBy: string;
	/** `""` while the question is unanswered. */
	answeredAt: string;
	expired: boolean;
}

/** Who started a thread: the user with `/cloud`, or the local model through the `cloud` tool. */
export type ThreadOrigin = "user" | "tool";

export interface Whoami {
	user: string;
	maxUploadBytes: number;
	defaultModel: string;
	/** `provider/*` for every provider the cloud can run right now. */
	modelPatterns: string[];
	/** The omp version a thread that names none runs. */
	ompVersion: string;
	/** The git hosts (`host` or `host:port`) the service can fetch a base from: a handoff from one of their remotes ships only what the remote lacks. */
	gitHosts: string[];
	vms: { running: number; paused: number };
	threads: { starting: number; working: number; waiting: number; idle: number; failed: number };
	/** The paired device this request was made with; null for the owner token. */
	device: DeviceRef | null;
	/** The TLS identity of the remote listener when the request arrived over it; null on the loopback listener. */
	remote: { fingerprint: string } | null;
	/** `api` 1 and no capabilities when the service reports no version fields. */
	service: ServiceInfo;
	/** The features this service build serves (`threads.paging`, `inspect`, ...); `[]` when it reports none. */
	capabilities: string[];
	limits: ServiceLimits;
	/** Null when the service reports no spend. */
	spend: Spend | null;
	/** What the cloud can run now. */
	models: { id: string }[];
	/** What the service says of its own update; null when it reports none. */
	update: WhoamiUpdate | null;
}

export type UpdateState = "idle" | "checking" | "downloading" | "ready" | "applying" | "failed" | "unsupported";

/** The update state `whoami` carries for the owner and for devices alike. */
export interface WhoamiUpdate {
	state: UpdateState;
	/** The version that is ready or being fetched; null when none. */
	available: string | null;
}

/** `GET /api/v1/update` (the owner's): what the updater is doing and why. */
export interface UpdateStatus {
	mode: "off" | "notify" | "auto";
	/** The service runs from a managed install; false when from a git checkout (updates are then `unsupported`). */
	managed: boolean;
	state: UpdateState;
	current: { version: string };
	latest: { version: string; notes: string; publishedAt: string } | null;
	/** The version downloaded and verified, ready to install. */
	staged: string | null;
	applying: { version: string; step: string; startedAt: string } | null;
	error: string | null;
	message: string | null;
	checkedAt: string | null;
}

export interface ServiceInfo {
	/** `""` when the service reports no version. */
	version: string;
	api: number;
}

export interface ServiceLimits {
	maxMessageBytes: number;
	maxAnswerBytes: number;
	maxUploadBytes: number;
	listMax: number;
	maxTurns: number;
}

/** The caller's owner's spend for the current UTC day. */
export interface Spend {
	todayUSD: number;
	/** 0 = no cap. */
	dayCapUSD: number;
}

/** A paired device as the service names it. */
export interface DeviceRef {
	id: string;
	name: string;
}

export interface ThreadLatest {
	id: number;
	state: TurnState;
	title: string;
	reply: string;
	error: string;
	completedAt: string;
}

export interface ThreadResult {
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

/** The repository a thread works on, as the summary lists it. */
export interface ThreadRepoSummary {
	name: string;
	/** Credential-free as the service stores it; "" when the handoff had no remote. */
	remoteURL: string;
	baseRef: string;
	localBranch: string;
}

/** Latest context use the thread's omp reported; `window` 0 = unknown. */
export interface ThreadContext {
	tokens: number;
	window: number;
	at: string;
}

/** One finished turn of {@link ThreadMetrics.turns}, for the list's small charts. */
export interface TurnMetric {
	n: number;
	/** USD. */
	cost: number;
	contextTokens: number | null;
}

/** What a thread has used so far, summed over its turns. */
export interface ThreadMetrics {
	usage: TurnUsage;
	/** Model requests (assistant messages). */
	requests: number;
	tools: number;
	/** Sum over finished turns of their run time, in ms. */
	workMs: number;
	context: ThreadContext | null;
	/** The last finished turns, oldest first. */
	turns: TurnMetric[];
}

/** The running turn's latest tool or assistant event. */
export interface ThreadActivity {
	kind: "tool" | "assistant";
	text: string;
	at: string;
}

export interface ThreadSummary {
	id: string;
	/** The short human name; "" when the thread has none (the title stands in). */
	name: string;
	title: string;
	owner: string;
	phase: ThreadPhase;
	error: string;
	turns: number;
	queued: number;
	model: string;
	thinking: string;
	ompVersion: string;
	latest: ThreadLatest | null;
	question: PendingQuestion | null;
	result: ThreadResult | null;
	createdAt: string;
	lastActivityAt: string;
	/** When the archive sweep released the thread's VM; null when it has one. */
	archivedAt: string | null;
	/** Null when the service sent no metrics. */
	metrics: ThreadMetrics | null;
	/** Null when no turn runs, or when the service sent no activity. */
	activity: ThreadActivity | null;
	/** Only the creation response carries warnings. */
	warnings: string[];
	repo: ThreadRepoSummary;
	/** The client's repository root as the client wrote it; "" when unknown. */
	workspace: string;
	/** Who started the thread; `""` when unknown (an older thread or service). */
	origin: ThreadOrigin | "";
	/** The caller's reference (`[A-Za-z0-9._-]{1,64}`), `""` when none. */
	ref: string;
	/** The omp session that started the thread, `""` when unknown. */
	session: string;
	/** The thread works in a synthesized empty repository, not a client repository. */
	scratch: boolean;
}

export interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** USD. */
	cost: number;
}

/** `""` for a message of a person or of the `cloud` tool; `"irc"` for an agent's message (`POST /threads/{id}/irc`). */
export type TurnOrigin = "" | "irc";

export interface ThreadTurn {
	id: number;
	state: TurnState;
	text: string;
	by: string;
	queuedAt: string;
	startedAt: string;
	completedAt: string;
	reply: string;
	title: string;
	error: string;
	usage: TurnUsage | null;
	head: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	pushed: boolean;
	pushError: string;
	/** The remote branch the turn's result was pushed to; `""` when it was not. */
	pushRef: string;
	requests: number;
	tools: number;
	/** Context use at the turn's end; null when not reported. */
	context: { tokens: number; window: number } | null;
	/** Who the turn came from: `""` for a message of a person or of the `cloud` tool, `"irc"` for an agent's (omp's IRC). */
	origin: TurnOrigin;
	/** The sending agent of an `irc` turn; `""` otherwise. */
	ircFrom: string;
	/** The message id of an `irc` turn: the `replyTo` of the answer relayed to the sender; `""` otherwise. */
	ircId: string;
	/** The message id the `irc` turn answers; `""` when it answers none. */
	ircReplyTo: string;
	questions: Question[];
}

/** In the detail view `turns` is the turn list; the summary's count is its length. */
export interface ThreadDetail extends Omit<ThreadSummary, "turns" | "warnings" | "repo" | "workspace"> {
	repo: ThreadRepoSummary & {
		baseCommit: string;
		handoffCommit: string;
	};
	paths: { home: string; workspace: string };
	configOverlays: string[];
	vm: { sandboxId: string; state: string; pid: number | null } | null;
	turns: ThreadTurn[];
}

/** One entry of a thread's append-only event log. */
export interface ThreadEvent {
	/** 1-based and gapless within the thread. */
	seq: number;
	at: string;
	kind: string;
	turn: number | null;
	text: string;
}

/** One page of `GET /threads`: newest first. `next` is the opaque cursor for the following page, null at the end. */
export interface ThreadsPage {
	threads: ThreadSummary[];
	next: string | null;
	/** Every thread matching the filters (the page's own count from a service without paging). */
	total: number;
}

/** The answer to a create: `replayed` when the Idempotency-Key had already created the thread. */
export interface CreatedThread {
	summary: ThreadSummary;
	replayed: boolean;
}

/** The answer to a message: the queued turn, whether it stopped a running one, and the queued turns an interrupt cancelled (`[]` in queue mode or when the service lists none). */
export interface SentMessage {
	turn: ThreadTurn;
	interrupted: boolean;
	/** Ids of the queued turns an interrupting send cancelled. */
	cancelled: number[];
}

/** A message for a cloud agent (`POST /threads/{id}/irc`): `from` is the sending agent's id (letters, digits, `.`, `_`, `-`, at most 64), `id` the message id the service stores it under and a retry of the same call is recognised by. */
export interface IrcMessageBody {
	from: string;
	body: string;
	replyTo?: string;
	id?: string;
}

/** What the service did with an IRC message: `injected` into the running turn, `woken` (a new turn on an idle thread), `revived` (the thread was archived). */
export type IrcReceiptKind = "injected" | "woken" | "revived";

/** The answer to an IRC message: the receipt, the message id the service stored it under, and the turn it queued (null when it was injected). */
export interface IrcReceipt {
	receipt: IrcReceiptKind;
	id: string;
	turn: ThreadTurn | null;
}

/** The JSON of an `irc` event's text: a message the cloud agent sent out (`to` is the id it addressed in the VM). */
export interface IrcPayload {
	id: string;
	from: string;
	to: string;
	body: string;
	/** `""` when the message answers none. */
	replyTo: string;
	at: string;
}

export type TurnPart = "reply" | "error" | "text";

/** One page of a turn's full text. Offsets and `total` count UTF-16 code units. */
export interface TurnTextPage {
	turn: number;
	part: TurnPart;
	total: number;
	offset: number;
	text: string;
	/** The next offset, null at the end. */
	next: number | null;
}

/** One page of the event log as JSON; `next` is the `after` of the following page, null at the end. */
export interface EventsPage {
	events: ThreadEvent[];
	next: number | null;
}

export interface DiffFile {
	path: string;
	status: "A" | "M" | "D" | "R";
	insertions: number;
	deletions: number;
}

export interface DiffStat {
	base: string;
	head: string;
	files: DiffFile[];
	insertions: number;
	deletions: number;
}

/** `diff` with `stat: true`. */
export interface DiffStatResult {
	stat: DiffStat;
}

/** `diff` without `stat`: a unified diff, cut at `maxBytes`. `truncated` is the full length in bytes when it was cut, else null. */
export interface DiffTextResult {
	text: string;
	truncated: number | null;
	base: string;
	head: string;
}

export interface TreeEntry {
	path: string;
	type: "file" | "dir";
	size: number;
}

export interface TreeResult {
	ref: "head" | "base";
	commit: string;
	path: string;
	entries: TreeEntry[];
	/** The listing hit the service's cap (5000 entries). */
	truncated: boolean;
}

/** One page of a file at the thread's head or base. Offsets count bytes of the file. */
export interface FileResult {
	path: string;
	ref: "head" | "base";
	commit: string;
	size: number;
	/** A binary file: `text` is `""`. */
	binary: boolean;
	offset: number;
	text: string;
	/** The next offset, null at the end. */
	next: number | null;
}

export interface ResultHeaders {
	branch: string;
	head: string;
	base: string;
}

/** The answer to one question: option labels, free text, or both. */
export interface AnswerBody {
	selected?: string[];
	answer?: string;
}

export type LoginState = "waiting" | "done" | "failed";

/** A login of the cloud broker to a provider (`/api/v1/logins`). */
export interface Login {
	id: string;
	provider: string;
	state: LoginState;
	url: string;
	instructions: string;
	userCode: string;
	account: string;
	error: string;
}

/** A one-time sign-in link to the dashboard (`POST /api/v1/dashboard/links`). */
export interface DashboardLink {
	/** Carries the code in its fragment: show it, never log it. */
	url: string;
	/** ISO 8601. */
	expiresAt: string;
}

// ---------------------------------------------------------------------------
// Pairing (`/api/v1/pairing/*`, `/api/v1/devices`)
// ---------------------------------------------------------------------------

/** A pairing offer as the owner creates it. `code` is returned only here: show it on the overlay, never anywhere else. */
export interface PairingOffer {
	id: string;
	code: string;
	/** ISO 8601. */
	expiresAt: string;
	/** `SHA256:…` of the service's remote certificate. */
	fingerprint: string;
	addresses: string[];
}

export type OfferStatus = "open" | "pending" | "approved" | "paired" | "declined" | "cancelled" | "burned" | "expired";

/** The device that redeemed an offer and waits for the owner. */
export interface PairingRequest {
	name: string;
	platform: string;
	address: string;
	at: string;
}

/** `GET /api/v1/pairing/offers/{id}`. */
export interface OfferState {
	id: string;
	status: OfferStatus;
	expiresAt: string;
	request: PairingRequest | null;
	device: DeviceRef | null;
}

/** `POST /api/v1/pairing/redeem` (202). */
export interface Redeemed {
	request: string;
	requestSecret: string;
	/** ISO 8601. */
	expiresAt: string;
}

/** `POST /api/v1/pairing/claim`: pending (202), approved (201, once) or declined (403). Anything else is an error. */
export type Claim = { status: "pending" } | { status: "declined" } | { status: "paired"; device: DeviceRef; token: string };

/** One entry of `GET /api/v1/devices`. */
export interface Device {
	id: string;
	name: string;
	platform: string;
	createdAt: string;
	pairedFrom: string;
	lastSeenAt: string;
	lastSeenAddress: string;
	/** True for the device that made the request. */
	current: boolean;
}

/** `DELETE /api/v1/devices/{id}`. */
export interface Revoked {
	device: DeviceRef;
	/** Threads that device started and that still run. */
	runningThreads: string[];
}

// ---------------------------------------------------------------------------
// Handoff request
// ---------------------------------------------------------------------------

export interface HandoffRequest {
	prompt: string;
	model: string;
	thinking: string;
	repo: {
		name: string;
		remoteURL: string;
		baseRef: string;
		/** `""`: the bundle holds the whole history. Else the commit on the remote the bundle builds on; the service fetches it from the remote. */
		baseCommit: string;
		handoffCommit: string;
		localBranch: string;
	};
	paths: { home: string; workspace: string };
	author: { name: string; email: string };
	secretFiles: { path: string; content: string }[];
	secretEnv: Record<string, string>;
	/** Paths inside the setup archive, relative to `~/.omp/agent`, in load order. */
	configOverlays: string[];
	/** `X.Y.Z`, or `""` for the service's version. */
	ompVersion: string;
	/** The policy the session asks of the cloud agent, as sent; the service validates it and only ever tightens its own policy with it. Absent asks for none. */
	policy?: Record<string, unknown>;
	/** The short human name generated for the task (2-6 words, at most 60 characters). Absent when none could be generated: the service then shows the title. */
	name?: string;
	/** Who started the thread. */
	origin?: ThreadOrigin;
	/** The caller's reference for the thread (`[A-Za-z0-9._-]{1,64}`). */
	ref?: string;
	/** The omp session id (at most 128 characters). */
	session?: string;
}

/** A handoff without a repository: the service synthesizes an empty one (`threads.scratch`); no `source` part. */
export interface ScratchHandoffRequest extends Omit<HandoffRequest, "repo"> {
	repo: { scratch: true; name?: string };
}

// ---------------------------------------------------------------------------
// Host surface (a structural subset of omp's ExtensionContext)
// ---------------------------------------------------------------------------

export type NotifyType = "info" | "warning" | "error";

export interface HostUi {
	notify(message: string, type?: NotifyType): void;
	/** Lines, or a component factory (TUI only; RPC hosts accept lines). */
	setWidget(
		key: string,
		content: string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	setStatus(key: string, text: string | undefined): void;
	confirm(title: string, message: string): Promise<boolean>;
	/** Present in every real host; absent only in test doubles that never prompt. */
	select?(title: string, options: string[]): Promise<string | undefined>;
	input?(title: string, placeholder?: string): Promise<string | undefined>;
	/** Interactive components and overlays; a no-op returning undefined in RPC hosts. */
	custom?: ExtensionUIContext["custom"];
	/** omp's own ask dialog (tabs, options with descriptions, multi, recommended, Other and notes); absent in hosts that cannot show it, and it may resolve undefined (cancelled, or a host without a form). */
	askDialog?: ExtensionUIContext["askDialog"];
	/** omp's tool-approval prompt; absent in hosts without it. Anything but an explicit approval answers `deny`. */
	approve?: ExtensionUIContext["approve"];
}

export interface Host {
	ui: HostUi;
	cwd: string;
	/** `"tui"` is the only mode that can show overlays. */
	mode?: string;
	hasUI?: boolean;
	model: { provider: string; id: string } | undefined;
	/** omp's model registry (`ExtensionContext.modelRegistry`): resolves the model that titles a handoff. Present in every real host; absent only in test doubles. */
	modelRegistry?: ModelRegistry;
	sessionManager: {
		getSessionFile(): string | undefined;
		getSessionDir(): string;
		/** All entries of the session file, for recovering what earlier cards recorded. */
		getEntries?(): readonly unknown[];
		/** The omp session's id. Present in every real host; absent only in test doubles. */
		getSessionId?(): string;
	};
	isIdle(): boolean;
	setTimeout(callback: () => void, ms?: number): Timer;
	clearTimer(timer: Timer): void;
}

export interface CommandHost extends Host {
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
}

export type DeliverAs = "steer" | "followUp" | "nextTurn" | "aside";

export interface PiHost {
	getThinkingLevel(): string | undefined;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown; attribution?: "user" | "agent" },
		options?: { triggerTurn?: boolean; deliverAs?: DeliverAs },
	): void;
	/** omp's own exports (`ExtensionAPI.pi`): its version and the live, layered settings. */
	pi: {
		VERSION: string;
		/** A proxy that throws until omp has initialized its settings. */
		readonly settings: Settings;
	};
	/** omp's session event bus (`ExtensionAPI.events`), where the task tool publishes a native subagent's lifecycle and progress for the Subagents strip. */
	events?: { emit(channel: string, data: unknown): void };
}

/** An error whose message is shown to the user exactly as written. */
export class UserError extends Error {
	override name = "UserError";
}
