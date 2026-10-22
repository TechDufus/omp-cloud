import type { ThreadPolicy } from "../settings/policy";
import type {
	Device,
	IrcInbound,
	OfferStatus,
	PairingOffer,
	Question,
	QuestionOption,
	Thread,
	ThreadContext,
	ThreadEvent,
	ThreadPhase,
	Turn,
	TurnState,
	SettingsAuditEntry,
	StoredSetting,
	Usage,
	VmRecord,
} from "./types";

/**
 * SQLite rows as `bun:sqlite` returns them. The rows come from our own schema (see `schema.ts`), so the converters
 * below are the one place that asserts their types and turns them into domain objects.
 */
export interface ThreadRow {
	id: string;
	owner: string;
	phase: string;
	title: string;
	model: string;
	thinking: string;
	repo_name: string;
	repo_remote_url: string;
	repo_base_ref: string;
	repo_base_commit: string;
	repo_handoff_commit: string;
	repo_local_branch: string;
	home: string;
	workspace: string;
	author_name: string;
	author_email: string;
	secret_files: string;
	secret_env: string;
	config_overlays: string;
	policy: string;
	omp_version: string;
	error: string | null;
	created_at: string;
	last_activity_at: string;
	deleted_at: string | null;
	name: string;
	archived_at: string | null;
	restore_head: string;
	context_tokens: number | null;
	context_window: number | null;
	context_at: string | null;
	origin: string;
	ref: string;
	session: string;
	scratch: number;
	idempotency_key: string | null;
	idempotency_fingerprint: string;
	pr_number: number;
	pr_url: string;
	mcp_names: string;
}

export interface TurnRow {
	thread_id: string;
	id: number;
	state: string;
	text: string;
	sent_by: string;
	queued_at: string;
	started_at: string | null;
	completed_at: string | null;
	stop_requested: number;
	stopped_by: string;
	reply: string;
	title: string;
	error: string;
	usage: string | null;
	head: string;
	files_changed: number;
	insertions: number;
	deletions: number;
	pushed: number;
	push_error: string;
	push_ref: string;
	prompt_sent_at: string | null;
	requests: number;
	tools: number;
	context_tokens: number | null;
	context_window: number | null;
	origin: string;
	irc_from: string;
	irc_id: string;
	irc_reply_to: string;
}

export interface IrcInboxRow {
	thread_id: string;
	id: string;
	turn_id: number;
	sender: string;
	body: string;
	reply_to: string;
	state: string;
	at: string;
}

export interface QuestionRow {
	thread_id: string;
	turn_id: number;
	id: number;
	ask: number;
	key: string;
	text: string;
	header: string;
	options: string;
	multi: number;
	recommended: number | null;
	asked_at: string;
	selected: string;
	answer: string;
	answered_by: string;
	answered_at: string | null;
	expired: number;
	request_id: string | null;
	omp_key: string;
	omp_labels: string;
}

export interface EventRow {
	thread_id: string;
	seq: number;
	at: string;
	kind: string;
	turn_id: number | null;
	text: string;
}

/** The context use a thread row holds; null before omp reported any. */
export function threadContextFromRow(row: ThreadRow): ThreadContext | null {
	if (row.context_tokens === null || row.context_at === null) return null;
	return { tokens: row.context_tokens, window: row.context_window ?? 0, at: row.context_at };
}

/** A thread row as the domain `Thread`. */
export function threadFromRow(row: ThreadRow): Thread {
	return {
		id: row.id,
		owner: row.owner,
		phase: row.phase as ThreadPhase,
		title: row.title,
		model: row.model,
		thinking: row.thinking,
		repo: {
			name: row.repo_name,
			remoteURL: row.repo_remote_url,
			baseRef: row.repo_base_ref,
			baseCommit: row.repo_base_commit,
			handoffCommit: row.repo_handoff_commit,
			localBranch: row.repo_local_branch,
		},
		paths: { home: row.home, workspace: row.workspace },
		author: { name: row.author_name, email: row.author_email },
		secretFiles: JSON.parse(row.secret_files) as string[],
		secretEnv: JSON.parse(row.secret_env) as string[],
		configOverlays: JSON.parse(row.config_overlays) as string[],
		policy: JSON.parse(row.policy) as ThreadPolicy,
		ompVersion: row.omp_version,
		error: row.error ?? "",
		createdAt: row.created_at,
		lastActivityAt: row.last_activity_at,
		name: row.name,
		archivedAt: row.archived_at,
		restoreHead: row.restore_head,
		context: threadContextFromRow(row),
		origin: row.origin === "tool" || row.origin === "user" ? row.origin : "",
		ref: row.ref,
		session: row.session,
		scratch: row.scratch === 1,
		pr: row.pr_number === 0 ? null : { number: row.pr_number, url: row.pr_url },
		mcpServers: JSON.parse(row.mcp_names) as string[],
	};
}

/** A question row as the domain `Question`. */
export function questionFromRow(row: QuestionRow): Question {
	return {
		id: row.id,
		ask: row.ask,
		key: row.key,
		text: row.text,
		header: row.header,
		options: JSON.parse(row.options) as QuestionOption[],
		multi: row.multi !== 0,
		recommended: row.recommended,
		askedAt: row.asked_at,
		selected: JSON.parse(row.selected) as string[],
		answer: row.answer,
		answeredBy: row.answered_by,
		answeredAt: row.answered_at,
		expired: row.expired !== 0,
		requestId: row.request_id,
		ompKey: row.omp_key,
		ompLabels: JSON.parse(row.omp_labels) as string[],
	};
}

/** A turn row and its questions (in id order) as the domain `Turn`. */
export function turnFromRow(row: TurnRow, questions: Question[]): Turn {
	return {
		id: row.id,
		state: row.state as TurnState,
		text: row.text,
		by: row.sent_by,
		queuedAt: row.queued_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		stopRequested: row.stop_requested !== 0,
		stoppedBy: row.stopped_by,
		origin: row.origin === "irc" ? "irc" : "",
		ircFrom: row.irc_from,
		ircId: row.irc_id,
		ircReplyTo: row.irc_reply_to,
		reply: row.reply,
		title: row.title,
		error: row.error,
		usage: row.usage === null ? null : (JSON.parse(row.usage) as Usage),
		head: row.head,
		filesChanged: row.files_changed,
		insertions: row.insertions,
		deletions: row.deletions,
		pushed: row.pushed !== 0,
		pushError: row.push_error,
		pushRef: row.push_ref,
		promptSentAt: row.prompt_sent_at,
		requests: row.requests,
		tools: row.tools,
		context: row.context_tokens === null ? null : { tokens: row.context_tokens, window: row.context_window ?? 0 },
		questions,
	};
}

/** An event row as the domain `ThreadEvent`. */
export function eventFromRow(row: EventRow): ThreadEvent {
	return { seq: row.seq, at: row.at, kind: row.kind, turn: row.turn_id, text: row.text };
}

/** An irc_inbox row as the domain `IrcInbound`. */
export function ircInboundFromRow(row: IrcInboxRow): IrcInbound {
	return { id: row.id, turn: row.turn_id, from: row.sender, body: row.body, replyTo: row.reply_to, at: row.at, state: row.state === "sent" ? "sent" : "pending" };
}

export interface VmRow {
	thread_id: string;
	sandbox_id: string;
	state: string;
	pid: number | null;
	session_file: string | null;
	updated_at: string;
}

/** A vms row as the domain `VmRecord`. */
export function vmFromRow(row: VmRow): VmRecord {
	return {
		threadId: row.thread_id,
		sandboxId: row.sandbox_id,
		state: row.state as VmRecord["state"],
		pid: row.pid,
		sessionFile: row.session_file,
		updatedAt: row.updated_at,
	};
}

export interface StoredSettingRow {
	key: string;
	value: string;
	updated_at: string;
	updated_by: string;
}

/** A settings row as the domain `StoredSetting`. */
export function storedSettingFromRow(row: StoredSettingRow): StoredSetting {
	return { key: row.key, value: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

export interface SettingsAuditRow {
	seq: number;
	at: string;
	actor: string;
	action: string;
	key: string;
	old_value: string | null;
	new_value: string | null;
}

/** A settings_audit row as the domain `SettingsAuditEntry`. */
export function settingsAuditFromRow(row: SettingsAuditRow): SettingsAuditEntry {
	return {
		seq: row.seq,
		at: row.at,
		actor: row.actor,
		action: row.action as SettingsAuditEntry["action"],
		key: row.key,
		oldValue: row.old_value,
		newValue: row.new_value,
	};
}

export interface DeviceRow {
	id: string;
	owner: string;
	name: string;
	platform: string;
	token_sha256: string;
	created_at: string;
	paired_from: string;
	last_seen_at: string | null;
	last_seen_address: string | null;
	revoked_at: string | null;
}

/** A devices row as the domain `Device`; the token hash stays in the row. */
export function deviceFromRow(row: DeviceRow): Device {
	return {
		id: row.id,
		owner: row.owner,
		name: row.name,
		platform: row.platform,
		createdAt: row.created_at,
		pairedFrom: row.paired_from,
		lastSeenAt: row.last_seen_at,
		lastSeenAddress: row.last_seen_address,
		revokedAt: row.revoked_at,
	};
}

/** A pairing_offers row, with the name of the device it paired (null before that). */
export interface OfferRow {
	id: string;
	owner: string;
	secret_sha256: string;
	created_at: string;
	expires_at: string;
	status: string;
	failures: number;
	request_id: string | null;
	request_secret_sha256: string | null;
	request_name: string | null;
	request_platform: string | null;
	request_address: string | null;
	requested_at: string | null;
	device_id: string | null;
	device_name: string | null;
}

/** Whether a stored status is still waiting on someone: past its `expires_at` such an offer reads as `expired`. */
export function offerIsLive(status: string): boolean {
	return status === "open" || status === "pending" || status === "approved";
}

/** An offer row as the domain `PairingOffer`; `now` is an ISO time, which turns a live offer past its expiry into `expired`. */
export function offerFromRow(row: OfferRow, now: string): PairingOffer {
	const status = offerIsLive(row.status) && row.expires_at <= now ? "expired" : (row.status as OfferStatus);
	const { request_name: name, request_platform: platform, request_address: address, requested_at: at } = row;
	return {
		id: row.id,
		owner: row.owner,
		status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		request: name !== null && platform !== null && address !== null && at !== null ? { name, platform, address, at } : null,
		device: row.device_id !== null && row.device_name !== null ? { id: row.device_id, name: row.device_name } : null,
	};
}
