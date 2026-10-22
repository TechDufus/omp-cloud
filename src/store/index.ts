import { Database, type SQLQueryBindings } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { blobPath, newThreadId, putBlob, randomId, removeBlobs, sweepDirs } from "./blobs";
import {
	type EventRow,
	type IrcInboxRow,
	ircInboundFromRow,
	eventFromRow,
	type QuestionRow,
	questionFromRow,
	type ThreadRow,
	threadContextFromRow,
	threadFromRow,
	type TurnRow,
	turnFromRow,
	type VmRow,
	vmFromRow,
	type SettingsAuditRow,
	settingsAuditFromRow,
	type StoredSettingRow,
	storedSettingFromRow,
	type DeviceRow,
	deviceFromRow,
	type OfferRow,
	offerFromRow,
	offerIsLive,
} from "./rows";
import { MIGRATIONS } from "./schema";
import { hashesEqual } from "../pairing/secrets";
import { suffixedName } from "../pairing/names";
import { cutChars, derivePhase, titleFromReply, validateAnswer, validateQuestion, validateText } from "./rules";
import {
	ANSWERED_BY_DROPPED,
	ANSWERED_BY_STOP,
	type ClaimOutcome,
	type Device,
	deviceActor,
	IRC_IN_EVENT,
	IRC_NAME_PATTERN,
	IRC_OUT_EVENT,
	type IrcInbound,
	type IrcPayload,
	type IrcReceipt,
	type BlobName,
	MAX_ERROR_CHARS,
	MAX_EVENT_TEXT_CHARS,
	MAX_IRC_EVENT_CHARS,
	MAX_STRUCTURED_EVENT_CHARS,
	MAX_QUESTION_TEXT_BYTES,
	MAX_QUESTIONS_PER_TURN,
	MAX_TURNS,
	type NewDevice,
	type NewDeviceRecord,
	type NewThread,
	type OfferRedemption,
	type PairingOffer,
	type PendingQuestion,
	type Question,
	type QuestionInput,
	type SettingChange,
	type SettingsAuditAction,
	type SettingsAuditEntry,
	type RedeemOutcome,
	type Revocation,
	type Spend,
	StoreError,
	STRUCTURED_EVENT_KINDS,
	type StoredSetting,
	THREAD_ID_PATTERN,
	type Thread,
	type ThreadActivity,
	type ThreadCursor,
	type ThreadListFilter,
	type ThreadPage,
	type ThreadContext,
	type ThreadEvent,
	type ThreadMetrics,
	type ThreadPhase,
	type ThreadStats,
	type Turn,
	type TurnResult,
	type Usage,
	type VmRecord,
} from "./types";

export { titleFromReply } from "./rules";

export interface StoreOptions {
	/** Absolute. Created (with `threads/`) mode 0700 when missing, unless `migrate` is false. */
	dataDir: string;
	/** Clock; defaults to `() => new Date()`. */
	now?: () => Date;
	/**
	 * Default true. False opens an existing database as it is, for a second process next to the running service (the
	 * `omp-cloud` CLI): nothing is created or migrated, and a schema version other than this code's latest is refused
	 * with a `SchemaVersionError`.
	 */
	migrate?: boolean;
}

/** `Store.open({ migrate: false })` found a database whose schema is not the one this code expects. */
export class SchemaVersionError extends Error {
	constructor(
		/** `PRAGMA user_version` of the database. */
		readonly found: number,
		/** The number of migrations this code knows. */
		readonly expected: number,
	) {
		super(`database schema version ${found} does not match the ${expected} this code expects`);
		this.name = "SchemaVersionError";
	}
}

/** Called synchronously after the transaction that appended the event commits, in seq order. */
export interface ThreadListener {
	event(event: ThreadEvent): void;
	/** Once, after the thread was deleted. */
	deleted(): void;
}

const EVENT_KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** A hash no secret has: what an unknown offer's secret is compared against, so that finding no offer costs the same. */
const NO_HASH = "0".repeat(64);
/** The fifth wrong secret burns an offer. */
const MAX_OFFER_FAILURES = 5;
/** An offer row with the name of the device it paired. */
const OFFER_SELECT = "SELECT o.*, d.name AS device_name FROM pairing_offers o LEFT JOIN devices d ON d.id = o.device_id";
const BUSY_TIMEOUT_MS = 5000;

/** Counts of a thread's turns and questions that its phase and last activity derive from. */
interface ThreadStatsRow {
	running: number;
	queued: number;
	started: number;
	unanswered: number;
	latest_queued: string;
	latest_started: string;
	latest_completed: string;
}

/** What one transaction appends: its clock reading and the events it wrote, handed to listeners after the commit. */
class Mutation {
	readonly events: ThreadEvent[] = [];
	private seq: number | null = null;

	constructor(
		private readonly db: Database,
		readonly threadId: string,
		/** The one timestamp of everything this transaction writes. */
		readonly at: string,
	) {}

	/** Appends a lifecycle or progress event with the next seq of the thread; its text is cut to `limit` characters. */
	emit(kind: string, turn: number | null, text: string, limit: number = MAX_EVENT_TEXT_CHARS): ThreadEvent {
		if (this.seq === null) {
			const row = this.db
				.query<{ seq: number }, [string]>("SELECT coalesce(max(seq), 0) AS seq FROM events WHERE thread_id = ?")
				.get(this.threadId);
			this.seq = row?.seq ?? 0;
		}
		this.seq += 1;
		const cut = cutChars(text, limit);
		this.db
			.query("INSERT INTO events (thread_id, seq, at, kind, turn_id, text) VALUES (?, ?, ?, ?, ?, ?)")
			.run(this.threadId, this.seq, this.at, kind, turn, cut);
		const event: ThreadEvent = { seq: this.seq, at: this.at, kind, turn, text: cut };
		this.events.push(event);
		return event;
	}
}

/** Called after the transaction that appended an event, or deleted a thread, commits; events arrive in seq order per thread. Must not write to the store synchronously. */
export interface AllThreadsListener {
	event(threadId: string, event: ThreadEvent): void;
	deleted(threadId: string): void;
}

interface Subscription {
	listener: ThreadListener;
}

/**
 * The thread store: threads, turns, questions and events in SQLite, blobs on disk. It is the system of record and the
 * boundary between the API (which only writes intents) and the runner (which works from the stored state).
 */
export class Store {
	private readonly listeners = new Map<string, Subscription[]>();
	private readonly allListeners = new Set<AllThreadsListener>();
	/** Creates in progress, by owner and `Idempotency-Key`. */
	private readonly creating = new Set<string>();

	private constructor(
		private readonly db: Database,
		private readonly threadsDir: string,
		private readonly now: () => Date,
		private readonly service: string,
	) {}

	/** Opens `<dataDir>/omp-cloud.db` (WAL, foreign keys on, busy timeout), migrating the schema via `PRAGMA user_version` unless `options.migrate` is false. */
	static open(options: StoreOptions): Store {
		const threadsDir = join(options.dataDir, "threads");
		const dbPath = join(options.dataDir, "omp-cloud.db");
		const migrating = options.migrate !== false;
		if (migrating) {
			mkdirSync(threadsDir, { recursive: true, mode: 0o700 });
			// SQLite gives its -wal and -shm files the mode of the database file.
			closeSync(openSync(dbPath, "a", 0o600));
		}
		const db = migrating ? new Database(dbPath) : new Database(dbPath, { readwrite: true });
		try {
			db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			if (migrating) db.run("PRAGMA journal_mode = WAL");
			db.run("PRAGMA foreign_keys = ON");
			if (migrating) migrate(db);
			else {
				const found = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
				if (found !== MIGRATIONS.length) throw new SchemaVersionError(found, MIGRATIONS.length);
			}
		} catch (err) {
			db.close();
			throw err;
		}
		return new Store(db, threadsDir, options.now ?? (() => new Date()), serviceId(db));
	}

	close(): void {
		this.db.close();
	}

	// ---- blobs

	/** A fresh random id matching THREAD_ID_PATTERN whose blob directory it creates exclusively (retries on EEXIST). */
	newThreadId(): string {
		return newThreadId(this.threadsDir);
	}

	/** Absolute path of a blob; throws Error when threadId does not match THREAD_ID_PATTERN. */
	blobPath(threadId: string, name: BlobName): string {
		return blobPath(this.threadsDir, threadId, name);
	}

	/**
	 * Writes a blob atomically: streams into a temp file in the thread directory (created when missing), fsyncs, renames
	 * over `name`. Past `maxBytes` it stops reading, removes the temp file, keeps any previous blob and throws
	 * StoreError "too_large". Returns the byte count.
	 */
	putBlob(threadId: string, name: BlobName, body: Uint8Array | AsyncIterable<Uint8Array>, maxBytes: number): Promise<number> {
		return putBlob(this.threadsDir, threadId, name, body, maxBytes);
	}

	/** The blob, or null when it does not exist. */
	async blob(threadId: string, name: BlobName): Promise<Bun.BunFile | null> {
		const file = Bun.file(this.blobPath(threadId, name));
		return (await file.exists()) ? file : null;
	}

	/** Removes the thread's blob directory; a missing one is fine. */
	removeBlobs(threadId: string): Promise<void> {
		return removeBlobs(this.threadsDir, threadId);
	}

	/** Startup cleanup: removes `threads/*` directories of no live (non-deleted) thread, e.g. an upload cut off by a crash. Returns how many. */
	sweepOrphanBlobs(): Promise<number> {
		const live = this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM threads WHERE id = ? AND deleted_at IS NULL");
		return sweepDirs(this.threadsDir, (name) => live.get(name) !== null);
	}

	// ---- threads

	/** One transaction: the thread (phase `starting`), turn 1 (queued, text = prompt, sent by `sentBy`, else the owner) and its `turn_queued` event. Throws "invalid_text". */
	createThread(id: string, input: NewThread): { thread: Thread; turn: Turn } {
		if (!THREAD_ID_PATTERN.test(id)) throw new Error(`invalid thread id: ${JSON.stringify(id)}`);
		validateText(input.prompt);
		this.mutate(
			id,
			(m) => {
				this.db
					.query(
						`INSERT INTO threads (id, owner, phase, title, name, model, thinking, repo_name, repo_remote_url, repo_base_ref,
							repo_base_commit, repo_handoff_commit, repo_local_branch, home, workspace, author_name, author_email,
							secret_files, secret_env, config_overlays, omp_version, policy, created_at, last_activity_at,
							origin, ref, session, scratch, idempotency_key, idempotency_fingerprint)
						VALUES (?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						id,
						input.owner,
						input.title,
						input.name ?? "",
						input.model,
						input.thinking,
						input.repo.name,
						input.repo.remoteURL,
						input.repo.baseRef,
						input.repo.baseCommit,
						input.repo.handoffCommit,
						input.repo.localBranch,
						input.paths.home,
						input.paths.workspace,
						input.author.name,
						input.author.email,
						JSON.stringify(input.secretFiles),
						JSON.stringify(input.secretEnv),
						JSON.stringify(input.configOverlays),
						input.ompVersion,
						JSON.stringify(input.policy),
						m.at,
						m.at,
						input.origin ?? "",
						input.ref ?? "",
						input.session ?? "",
						input.scratch === true ? 1 : 0,
						input.idempotency?.key ?? null,
						input.idempotency?.fingerprint ?? "",
					);
				this.insertTurn(m, 1, input.prompt, input.sentBy ?? input.owner);
			},
			{ create: true },
		);
		return { thread: this.requireThread(id), turn: this.requireTurn(id, 1) };
	}

	/** Null when unknown or deleted. */
	getThread(id: string): Thread | null {
		const row = this.threadRow(id);
		return row === null ? null : threadFromRow(row);
	}

	/** The owner's non-deleted threads, newest createdAt first (ties: id descending), at most `limit`. */
	listThreads(owner: string, limit: number): Thread[] {
		return this.db
			.query<ThreadRow, [string, number]>(
				"SELECT * FROM threads WHERE owner = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?",
			)
			.all(owner, limit)
			.map(threadFromRow);
	}

	/**
	 * One page of the owner's non-deleted threads matching `filter`, newest lastActivityAt first (ties: id descending),
	 * at most `limit`, starting after `after` (the previous page's `next`). `total` counts every match, ignoring `after`.
	 */
	listThreadsPage(owner: string, filter: ThreadListFilter, limit: number, after: ThreadCursor | null): ThreadPage {
		const where = ["owner = ?", "deleted_at IS NULL"];
		const params: SQLQueryBindings[] = [owner];
		if (filter.phases !== undefined) {
			where.push(`phase IN (${filter.phases.map(() => "?").join(", ")})`);
			params.push(...filter.phases);
		}
		for (const [column, value] of [
			["origin", filter.origin],
			["ref", filter.ref],
			["session", filter.session],
			["repo_name", filter.repo],
		] as const) {
			if (value === undefined) continue;
			where.push(`${column} = ?`);
			params.push(value);
		}
		if (filter.since !== undefined) {
			where.push("last_activity_at >= ?");
			params.push(filter.since);
		}
		const matching = where.join(" AND ");
		const total = this.db.query<{ n: number }, SQLQueryBindings[]>(`SELECT count(*) AS n FROM threads WHERE ${matching}`).get(...params)?.n ?? 0;
		const paged = after === null ? matching : `${matching} AND (last_activity_at, id) < (?, ?)`;
		const pageParams = after === null ? params : [...params, after.lastActivityAt, after.id];
		const rows = this.db
			.query<ThreadRow, SQLQueryBindings[]>(`SELECT * FROM threads WHERE ${paged} ORDER BY last_activity_at DESC, id DESC LIMIT ?`)
			.all(...pageParams, limit + 1);
		const threads = rows.slice(0, limit).map(threadFromRow);
		const last = threads.at(-1);
		const next = rows.length > limit && last !== undefined ? { lastActivityAt: last.lastActivityAt, id: last.id } : null;
		return { threads, next, total };
	}

	/** The owner's non-deleted thread created with this `Idempotency-Key` and the fingerprint of its request, or null. */
	threadByIdempotencyKey(owner: string, key: string): { thread: Thread; fingerprint: string } | null {
		const row = this.db
			.query<ThreadRow, [string, string]>("SELECT * FROM threads WHERE owner = ? AND idempotency_key = ? AND deleted_at IS NULL")
			.get(owner, key);
		return row === null ? null : { thread: threadFromRow(row), fingerprint: row.idempotency_fingerprint };
	}

	/**
	 * Marks a create with this key as in progress. Returns the release function, or null when another create of the same
	 * owner and key is still running. Hold it until the thread row exists (or the create failed), then release it.
	 */
	beginCreate(owner: string, key: string): (() => void) | null {
		const claim = JSON.stringify([owner, key]);
		if (this.creating.has(claim)) return null;
		this.creating.add(claim);
		return () => {
			this.creating.delete(claim);
		};
	}

	/** The owner's non-deleted threads per phase; every key present. */
	countThreads(owner: string): Record<Exclude<ThreadPhase, "deleted">, number> {
		const counts = { starting: 0, working: 0, waiting: 0, idle: 0, failed: 0 };
		const rows = this.db
			.query<{ phase: string; n: number }, [string]>(
				"SELECT phase, count(*) AS n FROM threads WHERE owner = ? AND deleted_at IS NULL GROUP BY phase",
			)
			.all(owner);
		for (const row of rows) {
			if (row.phase in counts) counts[row.phase as keyof typeof counts] = row.n;
		}
		return counts;
	}

	/** Throws "thread_not_found". */
	threadStats(threadId: string): ThreadStats {
		const thread = this.liveThreadRow(threadId);
		const counts = this.db
			.query<{ turns: number; queued: number }, [string]>(
				"SELECT count(*) AS turns, coalesce(sum(state = 'queued'), 0) AS queued FROM turns WHERE thread_id = ?",
			)
			.get(threadId);
		const latest = this.db
			.query<TurnRow, [string]>(
				"SELECT * FROM turns WHERE thread_id = ? AND state IN ('done', 'failed') ORDER BY id DESC LIMIT 1",
			)
			.get(threadId);
		const result = this.db
			.query<TurnRow, [string]>("SELECT * FROM turns WHERE thread_id = ? AND head != '' ORDER BY id DESC LIMIT 1")
			.get(threadId);
		return {
			turns: counts?.turns ?? 0,
			queued: counts?.queued ?? 0,
			latest: latest === null ? null : this.turnOf(latest),
			resultTurn: result === null ? null : this.turnOf(result),
			pending: this.pendingQuestion(threadId),
			metrics: this.threadMetrics(thread),
			activity: this.threadActivity(threadId),
		};
	}

	/** Updates the thread's latest context use. No event, `lastActivityAt` does not move; a no-op for an unknown or deleted thread. */
	setThreadContext(threadId: string, context: ThreadContext): void {
		this.db
			.query("UPDATE threads SET context_tokens = ?, context_window = ?, context_at = ? WHERE id = ? AND deleted_at IS NULL")
			.run(context.tokens, context.window, context.at, threadId);
	}

	/** Records the pull request the thread's pushes opened. No event, `lastActivityAt` does not move; a no-op for an unknown or deleted thread. */
	setThreadPullRequest(threadId: string, pr: { number: number; url: string }): void {
		this.db.query("UPDATE threads SET pr_number = ?, pr_url = ? WHERE id = ? AND deleted_at IS NULL").run(pr.number, pr.url, threadId);
	}

	/**
	 * One transaction marks the thread deleted (the row stays as a tombstone with phase `deleted`) and deletes its turns,
	 * questions and events; then it calls `deleted()` on its listeners and removes its blobs. A failed blob removal is
	 * logged, not thrown: the thread is already gone, and `sweepOrphanBlobs` retries at the next start. False when unknown
	 * or already deleted.
	 */
	async deleteThread(threadId: string): Promise<boolean> {
		const at = this.now().toISOString();
		const deleted = this.db
			.transaction(() => {
				const marked = this.db
					.query("UPDATE threads SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
					.run(at, threadId);
				if (marked.changes === 0) return false;
				this.db.query("DELETE FROM questions WHERE thread_id = ?").run(threadId);
				this.db.query("DELETE FROM turns WHERE thread_id = ?").run(threadId);
				this.db.query("DELETE FROM events WHERE thread_id = ?").run(threadId);
				this.db.query("DELETE FROM irc_inbox WHERE thread_id = ?").run(threadId);
				this.db.query("DELETE FROM irc_seen WHERE thread_id = ?").run(threadId);
				this.settle(threadId);
				return true;
			})
			.immediate();
		if (!deleted) return false;
		const subscriptions = this.listeners.get(threadId) ?? [];
		this.listeners.delete(threadId);
		for (const { listener } of subscriptions) {
			try {
				listener.deleted();
			} catch (err) {
				console.error("thread listener failed in deleted():", err);
			}
		}
		for (const listener of [...this.allListeners]) {
			try {
				listener.deleted(threadId);
			} catch (err) {
				console.error("thread listener failed in deleted():", err);
			}
		}
		try {
			await this.removeBlobs(threadId);
		} catch (err) {
			console.error(`removing the files of deleted thread ${threadId} failed; the next start retries:`, err);
		}
		return true;
	}

	/**
	 * Runner side: the thread cannot go on. Sets `error` (cut to MAX_ERROR_CHARS) and phase `failed`; fails its queued and
	 * running turns with that error and drops their unanswered questions. Returns how many turns it failed. Throws "thread_not_found".
	 */
	failThread(threadId: string, error: string): number {
		const message = cutChars(error, MAX_ERROR_CHARS);
		return this.mutate(threadId, (m) => {
			this.db.query("UPDATE threads SET error = ? WHERE id = ?").run(message, threadId);
			const open = this.db
				.query<{ id: number }, [string]>(
					"SELECT id FROM turns WHERE thread_id = ? AND state IN ('queued', 'running') ORDER BY id",
				)
				.all(threadId);
			for (const { id } of open) {
				this.expireOpen(m, id, "", ANSWERED_BY_DROPPED);
				this.db
					.query("UPDATE turns SET state = 'failed', error = ?, completed_at = ? WHERE thread_id = ? AND id = ?")
					.run(message, m.at, threadId, id);
				m.emit("turn_failed", id, message);
			}
			m.emit("thread_failed", null, message);
			return open.length;
		});
	}

	// ---- turns, API side

	/** In id order, each with its questions in id order. Throws "thread_not_found". */
	turns(threadId: string): Turn[] {
		this.liveThreadRow(threadId);
		return this.db
			.query<TurnRow, [string]>("SELECT * FROM turns WHERE thread_id = ? ORDER BY id")
			.all(threadId)
			.map((row) => this.turnOf(row));
	}

	/** Appends a queued turn with the next id. Throws "thread_not_found", "thread_failed", "invalid_text", "thread_full" (MAX_TURNS turns in any state). */
	enqueueTurn(threadId: string, text: string, by: string): Turn {
		const id = this.mutate(threadId, (m) => this.appendTurn(m, text, by));
		return this.requireTurn(threadId, id);
	}

	/**
	 * `stopThread` and `enqueueTurn` in one transaction: the running turn is stopped, every queued turn cancelled, and
	 * `text` queued as the next turn (the one that runs next, in id order). A refused message stops and cancels nothing.
	 * `interrupted`: a turn was running. `cancelled`: the ids of the queued turns cancelled. Throws what `enqueueTurn` throws.
	 */
	interruptThread(threadId: string, text: string, by: string): { turn: Turn; interrupted: boolean; cancelled: number[] } {
		const { id, stopped } = this.mutate(threadId, (m) => {
			const stopped = this.stopOpenTurns(m, by);
			return { id: this.appendTurn(m, text, by), stopped };
		});
		return { turn: this.requireTurn(threadId, id), interrupted: stopped.running, cancelled: stopped.cancelled };
	}

	/**
	 * The running turn gets stopRequested + stoppedBy (only the first stop sets them) and its unanswered questions expire
	 * with answeredBy `stop`; every queued turn becomes cancelled (completedAt now, stoppedBy, error `cancelled by <by>`).
	 * stoppedRunning: a turn is running. cancelled: queued turns cancelled now. Throws "thread_not_found".
	 */
	stopThread(threadId: string, by: string): { stoppedRunning: boolean; cancelled: number } {
		return this.mutate(threadId, (m) => {
			const stopped = this.stopOpenTurns(m, by);
			return { stoppedRunning: stopped.running, cancelled: stopped.cancelled.length };
		});
	}

	/** The stop of `stopThread`, inside the caller's mutation. */
	private stopOpenTurns(m: Mutation, by: string): { running: boolean; cancelled: number[] } {
		const threadId = m.threadId;
		const running = this.db
			.query<{ id: number; stop_requested: number }, [string]>(
				"SELECT id, stop_requested FROM turns WHERE thread_id = ? AND state = 'running' ORDER BY id",
			)
			.all(threadId);
		for (const turn of running) {
			if (turn.stop_requested === 0) {
				this.db
					.query("UPDATE turns SET stop_requested = 1, stopped_by = ? WHERE thread_id = ? AND id = ?")
					.run(by, threadId, turn.id);
				m.emit("stop_requested", turn.id, `stop requested by ${by}`);
				const dropped = this.db.query("DELETE FROM irc_inbox WHERE thread_id = ? AND turn_id = ? AND state = 'pending'").run(threadId, turn.id).changes;
				if (dropped > 0) m.emit("notice", turn.id, `${dropped} IRC ${dropped === 1 ? "message" : "messages"} not delivered: the turn was stopped`);
			}
			this.expireOpen(m, turn.id, "", ANSWERED_BY_STOP);
		}
		const queued = this.db
			.query<{ id: number }, [string]>("SELECT id FROM turns WHERE thread_id = ? AND state = 'queued' ORDER BY id")
			.all(threadId);
		for (const { id } of queued) {
			this.db
				.query(
					"UPDATE turns SET state = 'cancelled', completed_at = ?, stopped_by = ?, error = ? WHERE thread_id = ? AND id = ?",
				)
				.run(m.at, by, cutChars(`cancelled by ${by}`, MAX_ERROR_CHARS), threadId, id);
			m.emit("turn_cancelled", id, `cancelled by ${by}`);
		}
		return { running: running.length > 0, cancelled: queued.map((turn) => turn.id) };
	}

	/**
	 * `answer` is trimmed first. Throws "thread_not_found"; "question_not_found" (unknown turn or question); "not_waiting"
	 * (already answered or expired, or its turn is not running); "invalid_answer" (neither a label nor text; text over
	 * MAX_QUESTION_TEXT_BYTES; more than one label without `multi`; a label that is not an option; a label twice).
	 */
	answerQuestion(threadId: string, turnId: number, questionId: number, selected: string[], answer: string, by: string): Question {
		const text = answer.trim();
		this.mutate(threadId, (m) => {
			const turn = this.turnRow(threadId, turnId);
			const row = this.questionRow(threadId, turnId, questionId);
			if (turn === null || row === null) throw new StoreError("question_not_found", "no such question");
			if (row.answered_at !== null || turn.state !== "running") {
				throw new StoreError("not_waiting", "the question is not waiting for an answer");
			}
			validateAnswer(questionFromRow(row), selected, text);
			this.db
				.query(
					`UPDATE questions SET selected = ?, answer = ?, answered_by = ?, answered_at = ?, expired = 0
					WHERE thread_id = ? AND turn_id = ? AND id = ?`,
				)
				.run(JSON.stringify(selected), text, by, m.at, threadId, turnId, questionId);
			m.emit("question_answered", turnId, `question ${questionId} answered by ${by}`);
		});
		const row = this.questionRow(threadId, turnId, questionId);
		if (row === null) throw new Error("answered question vanished");
		return questionFromRow(row);
	}

	// ---- IRC

	/**
	 * A peer's IRC message to the thread's agent, in one transaction. A turn is running (and not being stopped): the message is
	 * stored `pending` for the runner to hand to omp inside that turn (`injected`, no turn) and an `irc_in` event on that turn
	 * wakes the runner. Otherwise it becomes a queued turn with origin `irc` (`woken`; `revived` when the thread was archived), and
	 * the turn's `by` and `ircFrom` are `from`, its text `body`. A repeated `id` answers as the first time did. Throws
	 * "thread_not_found", "thread_failed", "invalid_irc" (`from`, `id` or `replyTo` breaks `IRC_NAME_PATTERN`), "invalid_text", "thread_full".
	 */
	sendIrc(threadId: string, input: { id: string; from: string; body: string; replyTo: string }): { receipt: IrcReceipt; id: string; turn: Turn | null } {
		for (const [name, value] of [["id", input.id], ["from", input.from]] as const) {
			if (!IRC_NAME_PATTERN.test(value)) throw new StoreError("invalid_irc", `${name} must be 1 to 64 characters of letters, digits, '.', '_' and '-'`);
		}
		if (input.replyTo !== "" && !IRC_NAME_PATTERN.test(input.replyTo)) {
			throw new StoreError("invalid_irc", "replyTo must be 1 to 64 characters of letters, digits, '.', '_' and '-'");
		}
		validateText(input.body);
		const sent = this.mutate(threadId, (m): { receipt: IrcReceipt; turn: number | null } => {
			const thread = this.liveThreadRow(threadId);
			if (this.db.query("SELECT 1 FROM irc_inbox WHERE thread_id = ? AND id = ?").get(threadId, input.id) !== null) return { receipt: "injected", turn: null };
			const earlier = this.db
				.query<{ id: number }, [string, string]>("SELECT id FROM turns WHERE thread_id = ? AND origin = 'irc' AND irc_id = ?")
				.get(threadId, input.id);
			if (earlier !== null) return { receipt: "woken", turn: earlier.id };
			if (thread.error !== null) throw new StoreError("thread_failed", "the thread has failed");
			const payload = JSON.stringify({ id: input.id, from: input.from, to: "", body: input.body, replyTo: input.replyTo, at: m.at } satisfies IrcPayload);
			const running = this.db
				.query<{ id: number }, [string]>("SELECT id FROM turns WHERE thread_id = ? AND state = 'running' AND stop_requested = 0 ORDER BY id LIMIT 1")
				.get(threadId);
			if (running !== null) {
				this.db
					.query("INSERT INTO irc_inbox (thread_id, id, turn_id, sender, body, reply_to, state, at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
					.run(threadId, input.id, running.id, input.from, input.body, input.replyTo, m.at);
				m.emit(IRC_IN_EVENT, running.id, payload, MAX_IRC_EVENT_CHARS);
				return { receipt: "injected", turn: null };
			}
			const turn = this.appendTurn(m, input.body, input.from, { id: input.id, replyTo: input.replyTo });
			m.emit(IRC_IN_EVENT, turn, payload, MAX_IRC_EVENT_CHARS);
			return { receipt: thread.archived_at !== null ? "revived" : "woken", turn };
		});
		return { receipt: sent.receipt, id: input.id, turn: sent.turn === null ? null : this.requireTurn(threadId, sent.turn) };
	}

	/**
	 * Runner side: records a message the VM agent wrote to a peer as an `irc` event on `turn` (null when none runs). The event's
	 * text is the message as JSON (`IrcPayload`, `at` = the event's time), cut only at `MAX_IRC_EVENT_CHARS`. A message
	 * whose `id` was recorded before (a redelivered frame) is not stored again: returns null. Throws "thread_not_found".
	 */
	appendIrcEvent(threadId: string, turn: number | null, message: Omit<IrcPayload, "at">): ThreadEvent | null {
		return this.mutate(threadId, (m) => {
			if (this.db.query("INSERT OR IGNORE INTO irc_seen (thread_id, id) VALUES (?, ?)").run(threadId, message.id).changes === 0) return null;
			const payload: IrcPayload = { ...message, at: m.at };
			return m.emit(IRC_OUT_EVENT, turn, JSON.stringify(payload), MAX_IRC_EVENT_CHARS);
		});
	}

	/** Runner side: the messages sent into running turn `turnId` that omp has not been handed yet, oldest first. Throws "thread_not_found". */
	pendingIrc(threadId: string, turnId: number): IrcInbound[] {
		this.liveThreadRow(threadId);
		return this.db
			.query<IrcInboxRow, [string, number]>("SELECT * FROM irc_inbox WHERE thread_id = ? AND turn_id = ? AND state = 'pending' ORDER BY at, rowid")
			.all(threadId, turnId)
			.map(ircInboundFromRow);
	}

	/** Runner side: records that omp was handed message `id`; no event. A message that is not pending is left as it is. */
	markIrcSent(threadId: string, id: string): void {
		this.db.query("UPDATE irc_inbox SET state = 'sent' WHERE thread_id = ? AND id = ? AND state = 'pending'").run(threadId, id);
	}

	// ---- turns, runner side

	/** The running turn unchanged if there is one (a redelivery), else the oldest queued turn, now running with startedAt. Null when none. Throws "thread_not_found". */
	startNextTurn(threadId: string): Turn | null {
		const id = this.mutate(threadId, (m) => {
			const running = this.db
				.query<{ id: number }, [string]>("SELECT id FROM turns WHERE thread_id = ? AND state = 'running' ORDER BY id LIMIT 1")
				.get(threadId);
			if (running !== null) return running.id;
			const queued = this.db
				.query<{ id: number }, [string]>("SELECT id FROM turns WHERE thread_id = ? AND state = 'queued' ORDER BY id LIMIT 1")
				.get(threadId);
			if (queued === null) return null;
			this.db
				.query("UPDATE turns SET state = 'running', started_at = ? WHERE thread_id = ? AND id = ?")
				.run(m.at, threadId, queued.id);
			m.emit("turn_started", queued.id, "started");
			return queued.id;
		});
		return id === null ? null : this.requireTurn(threadId, id);
	}

	/**
	 * Ends running turn turnId: `done` for outcome `completed`, else `failed` with result.error; a stopRequested turn always
	 * ends `failed` with `stopped by <stoppedBy>`. Records reply, title (from reply), usage, head, diffstat, pushed,
	 * pushError, pushRef, completedAt; drops its unanswered questions; adds a cost over 0 to the owner's spend of the UTC day
	 * (`daySpend`). Throws "thread_not_found", "turn_not_running".
	 */
	completeTurn(threadId: string, turnId: number, result: TurnResult): Turn {
		this.mutate(threadId, (m) => {
			const turn = this.turnRow(threadId, turnId);
			if (turn === null || turn.state !== "running") throw new StoreError("turn_not_running", "the turn is not running");
			let state = result.outcome === "completed" ? "done" : "failed";
			let error = state === "done" ? "" : cutChars(result.error, MAX_ERROR_CHARS);
			if (turn.stop_requested !== 0) {
				state = "failed";
				error = cutChars(`stopped by ${turn.stopped_by}`, MAX_ERROR_CHARS);
			}
			const title = titleFromReply(result.reply);
			this.expireOpen(m, turnId, "", ANSWERED_BY_DROPPED);
			this.db
				.query(
					`UPDATE turns SET state = ?, error = ?, completed_at = ?, reply = ?, title = ?, usage = ?, head = ?,
						files_changed = ?, insertions = ?, deletions = ?, pushed = ?, push_error = ?, push_ref = ?,
						requests = ?, tools = ?, context_tokens = ?, context_window = ?
					WHERE thread_id = ? AND id = ?`,
				)
				.run(
					state,
					error,
					m.at,
					result.reply,
					title,
					result.usage === null ? null : JSON.stringify(result.usage),
					result.head,
					result.filesChanged,
					result.insertions,
					result.deletions,
					result.pushed ? 1 : 0,
					result.pushError,
					result.pushRef,
					result.requests ?? 0,
					result.tools ?? 0,
					result.context?.tokens ?? null,
					result.context?.window ?? null,
					threadId,
					turnId,
				);
			// A newer turn head supersedes the archive snapshot's.
			this.db.query("UPDATE threads SET restore_head = '' WHERE id = ?").run(threadId);
			if (result.usage !== null && result.usage.cost > 0) {
				this.db
					.query(
						`INSERT INTO spend_days (owner, day, cost) VALUES (?, ?, ?)
						ON CONFLICT (owner, day) DO UPDATE SET cost = cost + excluded.cost`,
					)
					.run(this.liveThreadRow(threadId).owner, m.at.slice(0, 10), result.usage.cost);
			}
			if (state === "done") m.emit("turn_done", turnId, title === "" ? "done" : title);
			else m.emit("turn_failed", turnId, error);
			this.spillIrcInbox(m, turnId);
		});
		return this.requireTurn(threadId, turnId);
	}

	/** Records that the runner handed the running turn's text to omp (`promptSentAt` = now); no event. Throws "thread_not_found", "turn_not_running". */
	markPromptSent(threadId: string, turnId: number): void {
		this.mutate(threadId, (m) => {
			const turn = this.turnRow(threadId, turnId);
			if (turn === null || turn.state !== "running") throw new StoreError("turn_not_running", "the turn is not running");
			this.db.query("UPDATE turns SET prompt_sent_at = ? WHERE thread_id = ? AND id = ?").run(m.at, threadId, turnId);
		});
	}

	/** After omp or the VM was lost: the running turn goes back to queued (startedAt and promptSentAt cleared, its questions deleted); a stopRequested one ends `failed` instead. Returns how many it requeued. */
	requeueRunningTurn(threadId: string): number {
		return this.mutate(threadId, (m) => {
			const running = this.db
				.query<{ id: number; stop_requested: number; stopped_by: string }, [string]>(
					"SELECT id, stop_requested, stopped_by FROM turns WHERE thread_id = ? AND state = 'running' ORDER BY id",
				)
				.all(threadId);
			let requeued = 0;
			for (const turn of running) {
				if (turn.stop_requested !== 0) {
					const error = cutChars(`stopped by ${turn.stopped_by}`, MAX_ERROR_CHARS);
					this.db
						.query("UPDATE turns SET state = 'failed', error = ?, completed_at = ? WHERE thread_id = ? AND id = ?")
						.run(error, m.at, threadId, turn.id);
					m.emit("turn_failed", turn.id, error);
					continue;
				}
				this.db.query("DELETE FROM questions WHERE thread_id = ? AND turn_id = ?").run(threadId, turn.id);
				this.db
					.query("UPDATE turns SET state = 'queued', started_at = NULL, prompt_sent_at = NULL WHERE thread_id = ? AND id = ?")
					.run(threadId, turn.id);
				m.emit("turn_requeued", turn.id, "requeued");
				requeued++;
			}
			return requeued;
		});
	}

	/**
	 * Records one `ask` call of running turn turnId with the next question ids and the next ask number; `requestId` (omp's
	 * ui request id) is stored on every question of the ask. Throws
	 * "thread_not_found"; "turn_not_running" (not running, or stopRequested); "invalid_question" (no inputs, or one breaks a
	 * limit — the message names the 1-based question and the rule); "too_many_questions" (over MAX_QUESTIONS_PER_TURN in the turn).
	 */
	askQuestions(
		threadId: string,
		turnId: number,
		inputs: QuestionInput[],
		requestId: string | null,
	): { ask: number; questions: Question[] } {
		const ask = this.mutate(threadId, (m) => {
			if (inputs.length === 0) throw new StoreError("invalid_question", "no questions");
			inputs.forEach((input, i) => validateQuestion(i, input));
			const turn = this.turnRow(threadId, turnId);
			if (turn === null || turn.state !== "running" || turn.stop_requested !== 0) {
				throw new StoreError("turn_not_running", "the turn is not running or was asked to stop");
			}
			const last = this.db
				.query<{ n: number; id: number; ask: number }, [string, number]>(
					"SELECT count(*) AS n, coalesce(max(id), 0) AS id, coalesce(max(ask), 0) AS ask FROM questions WHERE thread_id = ? AND turn_id = ?",
				)
				.get(threadId, turnId);
			if ((last?.n ?? 0) + inputs.length > MAX_QUESTIONS_PER_TURN) {
				throw new StoreError("too_many_questions", `a turn takes at most ${MAX_QUESTIONS_PER_TURN} questions`);
			}
			const askNumber = (last?.ask ?? 0) + 1;
			let id = last?.id ?? 0;
			for (const input of inputs) {
				id++;
				this.db
					.query(
						`INSERT INTO questions (thread_id, turn_id, id, ask, key, text, header, options, multi, recommended, asked_at, request_id, omp_key, omp_labels)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						threadId,
						turnId,
						id,
						askNumber,
						input.key,
						input.text,
						input.header,
						JSON.stringify(input.options),
						input.multi ? 1 : 0,
						input.recommended,
						m.at,
						requestId,
						input.ompKey,
						JSON.stringify(input.ompLabels),
					);
				m.emit("question_asked", turnId, `question ${id}: ${input.text}`);
			}
			return askNumber;
		});
		return { ask, questions: this.askOf(threadId, turnId, ask) };
	}

	/** Expires the unanswered questions of that ask with `answer` on behalf of `by` and returns all of the ask's questions. Throws "thread_not_found", "question_not_found", "invalid_answer" (answer over MAX_QUESTION_TEXT_BYTES). */
	expireAsk(threadId: string, turnId: number, ask: number, answer: string, by: string): Question[] {
		this.mutate(threadId, (m) => {
			if (Buffer.byteLength(answer) > MAX_QUESTION_TEXT_BYTES) {
				throw new StoreError("invalid_answer", `answer is longer than ${MAX_QUESTION_TEXT_BYTES} bytes`);
			}
			if (this.askOf(threadId, turnId, ask).length === 0) throw new StoreError("question_not_found", "no such ask");
			this.expireOpen(m, turnId, answer, by, ask);
		});
		return this.askOf(threadId, turnId, ask);
	}

	// ---- events

	/** A progress event from the runner. kind must match /^[a-z][a-z0-9_]{0,31}$/ ("invalid_event"); text cut to MAX_EVENT_TEXT_CHARS (to MAX_STRUCTURED_EVENT_CHARS for a kind in STRUCTURED_EVENT_KINDS). Throws "thread_not_found". */
	appendEvent(threadId: string, kind: string, text: string, turn: number | null): ThreadEvent {
		return this.mutate(threadId, (m) => {
			if (!EVENT_KIND_PATTERN.test(kind)) throw new StoreError("invalid_event", "invalid event kind");
			return m.emit(kind, turn, text, STRUCTURED_EVENT_KINDS.includes(kind) ? MAX_STRUCTURED_EVENT_CHARS : MAX_EVENT_TEXT_CHARS);
		});
	}

	/** Events with seq > after, ascending, at most limit; [] for an unknown thread. */
	events(threadId: string, after: number, limit: number): ThreadEvent[] {
		return this.db
			.query<EventRow, [string, number, number]>(
				"SELECT * FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?",
			)
			.all(threadId, after, limit)
			.map(eventFromRow);
	}

	/** The `child_start` and `child_end` events of the thread, ascending: what the runner rebuilds the open children of a thread from after a restart of the service. [] for an unknown thread. */
	childEvents(threadId: string): ThreadEvent[] {
		return this.db
			.query<EventRow, [string]>("SELECT * FROM events WHERE thread_id = ? AND kind IN ('child_start', 'child_end') ORDER BY seq")
			.all(threadId)
			.map(eventFromRow);
	}

	/** Returns the unsubscribe function. A throwing listener is logged and affects nothing else. */
	subscribe(threadId: string, listener: ThreadListener): () => void {
		const subscription: Subscription = { listener };
		const subscriptions = this.listeners.get(threadId) ?? [];
		subscriptions.push(subscription);
		this.listeners.set(threadId, subscriptions);
		return () => {
			const current = this.listeners.get(threadId);
			if (current === undefined) return;
			const index = current.indexOf(subscription);
			if (index >= 0) current.splice(index, 1);
			if (current.length === 0) this.listeners.delete(threadId);
		};
	}

	/** Every event of every thread and every deletion, after commit, like `subscribe`. Returns the unsubscribe function. */
	subscribeAll(listener: AllThreadsListener): () => void {
		this.allListeners.add(listener);
		return () => {
			this.allListeners.delete(listener);
		};
	}

	/** What the owner's turns completed on UTC `day` (`YYYY-MM-DD`) cost in USD, deleted threads' included. */
	daySpend(owner: string, day: string): number {
		return this.db.query<{ cost: number }, [string, string]>("SELECT cost FROM spend_days WHERE owner = ? AND day = ?").get(owner, day)?.cost ?? 0;
	}

	/** The owner's recorded usage of turns completed at or after `sinceIso` (an ISO 8601 instant; string order is time order), summed in total, per thread and per UTC day. Turns without usage are not counted. */
	spend(owner: string, sinceIso: string): Spend {
		const threads = this.db
			.query<{ thread: string; title: string; name: string; turns: number; input: number; output: number; cache_read: number; cache_write: number; cost: number }, [string, string]>(
				`SELECT t.thread_id AS thread, th.title AS title, th.name AS name, count(*) AS turns,
					coalesce(sum(json_extract(t.usage, '$.inputTokens')), 0) AS input,
					coalesce(sum(json_extract(t.usage, '$.outputTokens')), 0) AS output,
					coalesce(sum(json_extract(t.usage, '$.cacheReadTokens')), 0) AS cache_read,
					coalesce(sum(json_extract(t.usage, '$.cacheWriteTokens')), 0) AS cache_write,
					coalesce(sum(json_extract(t.usage, '$.cost')), 0) AS cost
				FROM turns t JOIN threads th ON th.id = t.thread_id
				WHERE th.owner = ? AND t.usage IS NOT NULL AND t.completed_at >= ?
				GROUP BY t.thread_id ORDER BY cost DESC, t.thread_id`,
			)
			.all(owner, sinceIso);
		const days = this.db
			.query<{ day: string; cost: number }, [string, string]>(
				`SELECT substr(t.completed_at, 1, 10) AS day, coalesce(sum(json_extract(t.usage, '$.cost')), 0) AS cost
				FROM turns t JOIN threads th ON th.id = t.thread_id
				WHERE th.owner = ? AND t.usage IS NOT NULL AND t.completed_at >= ?
				GROUP BY day ORDER BY day`,
			)
			.all(owner, sinceIso);
		const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
		for (const row of threads) {
			total.inputTokens += row.input;
			total.outputTokens += row.output;
			total.cacheReadTokens += row.cache_read;
			total.cacheWriteTokens += row.cache_write;
			total.cost += row.cost;
		}
		return { total, threads: threads.map(({ thread, title, name, cost, turns }) => ({ thread, title, name, cost, turns })), days };
	}

	// ---- runner records

	/** A random 12-character [a-z0-9] id created on first open and stable for the data directory: names this service's sandboxes and gateway clients. */
	serviceId(): string {
		return this.service;
	}

	/** The thread's VM record, also for a deleted thread. */
	vm(threadId: string): VmRecord | null {
		const row = this.db.query<VmRow, [string]>("SELECT * FROM vms WHERE thread_id = ?").get(threadId);
		return row === null ? null : vmFromRow(row);
	}

	/** Every VM record, deleted threads included. */
	vms(): VmRecord[] {
		return this.db.query<VmRow, []>("SELECT * FROM vms ORDER BY thread_id").all().map(vmFromRow);
	}

	/** Insert or replace; sets updatedAt. A record for a thread that had none clears its `archivedAt` (it has a VM again). Throws Error for an unknown thread id. */
	putVm(record: Omit<VmRecord, "updatedAt">): VmRecord {
		if (this.threadRowAny(record.threadId) === null) throw new Error(`unknown thread ${record.threadId}`);
		this.db.transaction(() => {
			const fresh = this.vm(record.threadId) === null;
			this.db
				.query(
					`INSERT OR REPLACE INTO vms (thread_id, sandbox_id, state, pid, session_file, updated_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(record.threadId, record.sandboxId, record.state, record.pid, record.sessionFile, this.now().toISOString());
			if (fresh) this.db.query("UPDATE threads SET archived_at = NULL WHERE id = ?").run(record.threadId);
		})();
		const stored = this.vm(record.threadId);
		if (stored === null) throw new Error(`vm record of thread ${record.threadId} vanished`);
		return stored;
	}

	removeVm(threadId: string): void {
		this.db.query("DELETE FROM vms WHERE thread_id = ?").run(threadId);
	}

	/**
	 * Ids of the live threads the archive sweep may release at `cutoff` (an ISO 8601 instant): not deleted, not failed, phase
	 * `idle`, not archived, holding a VM record, with `lastActivityAt` before the cutoff; oldest activity first.
	 */
	archiveCandidates(cutoff: string): string[] {
		return this.db
			.query<{ id: string }, [string]>(
				`SELECT t.id FROM threads t
				WHERE t.deleted_at IS NULL AND t.error IS NULL AND t.phase = 'idle' AND t.archived_at IS NULL
				AND t.last_activity_at < ? AND EXISTS (SELECT 1 FROM vms v WHERE v.thread_id = t.id)
				ORDER BY t.last_activity_at, t.id`,
			)
			.all(cutoff)
			.map((row) => row.id);
	}

	/** Records that the runner released the thread's VM: `archivedAt` = `at`, and `restoreHead` when non-empty. No event; `lastActivityAt` does not move. */
	markArchived(threadId: string, at: string, restoreHead: string): void {
		this.db
			.query("UPDATE threads SET archived_at = ?, restore_head = CASE WHEN ? = '' THEN restore_head ELSE ? END WHERE id = ?")
			.run(at, restoreHead, restoreHead, threadId);
	}

	/** VM records of the owner's live threads by state. */
	countVms(owner: string): { running: number; paused: number } {
		const counts = { running: 0, paused: 0 };
		const rows = this.db
			.query<{ state: string; n: number }, [string]>(
				`SELECT v.state AS state, count(*) AS n FROM vms v JOIN threads t ON t.id = v.thread_id
				WHERE t.owner = ? AND t.deleted_at IS NULL GROUP BY v.state`,
			)
			.all(owner);
		for (const row of rows) {
			if (row.state in counts) counts[row.state as keyof typeof counts] = row.n;
		}
		return counts;
	}

	/** Live (not deleted, not failed) threads with a queued or running turn. */
	workThreadIds(): string[] {
		return this.db
			.query<{ id: string }, []>(
				`SELECT id FROM threads t WHERE deleted_at IS NULL AND error IS NULL
				AND EXISTS (SELECT 1 FROM turns WHERE thread_id = t.id AND state IN ('queued', 'running'))
				ORDER BY created_at, id`,
			)
			.all()
			.map((row) => row.id);
	}

	/** The owner of a thread, also when deleted; null when unknown. */
	threadOwner(threadId: string): string | null {
		return this.threadRowAny(threadId)?.owner ?? null;
	}

	// ---- settings

	/** Every stored setting, in key order. */
	settingRows(): StoredSetting[] {
		return this.db.query<StoredSettingRow, []>("SELECT * FROM settings ORDER BY key").all().map(storedSettingFromRow);
	}

	/**
	 * One transaction applies `changes` (a null value drops the stored row) and writes one audit row per key whose stored
	 * value actually changes; a change to the value a key already has writes nothing. `action` `set` audits a dropped row
	 * as `reset`; `import` audits every changed key as `import`. Returns the changed keys in `changes` order.
	 */
	applySettings(changes: readonly SettingChange[], actor: string, action: "set" | "import"): string[] {
		const at = this.now().toISOString();
		return this.db
			.transaction(() => {
				const changed: string[] = [];
				for (const { key, value, audit } of changes) {
					const old = this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
					if (old === value) continue;
					if (value === null) {
						this.db.query("DELETE FROM settings WHERE key = ?").run(key);
					} else {
						this.db
							.query(
								`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
								ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
							)
							.run(key, value, at, actor);
					}
					const audited: SettingsAuditAction = action === "import" ? "import" : value === null ? "reset" : "set";
					this.db
						.query("INSERT INTO settings_audit (at, actor, action, key, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)")
						.run(at, actor, audited, key, audit === undefined ? old : audit(old), audit === undefined ? value : audit(value));
					changed.push(key);
				}
				return changed;
			})
			.immediate();
	}

	/** Up to `limit` audit entries, newest first; `before` > 0 returns only those with a smaller seq. */
	settingsAudit(before: number, limit: number): SettingsAuditEntry[] {
		return this.db
			.query<SettingsAuditRow, [number, number]>(
				"SELECT * FROM settings_audit WHERE (?1 = 0 OR seq < ?1) ORDER BY seq DESC LIMIT ?2",
			)
			.all(before, limit)
			.map(settingsAuditFromRow);
	}

	// ---- devices and pairing offers

	/**
	 * One transaction records an `open` offer for `owner` that lives `ttlMs`; when `maxOpen` live offers (open, pending or
	 * approved, not yet expired) already exist, the oldest are cancelled so that `maxOpen` remain.
	 */
	createOffer(input: { id: string; owner: string; secretSha256: string; ttlMs: number; maxOpen: number }): PairingOffer {
		const created = this.now();
		const at = created.toISOString();
		const expiresAt = new Date(created.getTime() + input.ttlMs).toISOString();
		this.db
			.transaction(() => {
				const live = this.db
					.query<{ id: string }, [string, string]>(
						"SELECT id FROM pairing_offers WHERE owner = ? AND status IN ('open', 'pending', 'approved') AND expires_at > ? ORDER BY created_at, rowid",
					)
					.all(input.owner, at);
				for (const old of live.slice(0, Math.max(0, live.length - input.maxOpen + 1))) {
					this.db.query("UPDATE pairing_offers SET status = 'cancelled' WHERE id = ?").run(old.id);
				}
				this.db
					.query(
						"INSERT INTO pairing_offers (id, owner, secret_sha256, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'open')",
					)
					.run(input.id, input.owner, input.secretSha256, at, expiresAt);
			})
			.immediate();
		const offer = this.offer(input.id);
		if (offer === null) throw new Error(`pairing offer ${input.id} vanished`);
		return offer;
	}

	/** The offer with its status as of now (`expired` for a live offer past its expiry), or null when unknown. */
	offer(id: string): PairingOffer | null {
		const row = this.offerRow(id);
		return row === null ? null : offerFromRow(row, this.now().toISOString());
	}

	/**
	 * One transaction redeems an offer: an `open`, unexpired offer whose secret matches becomes `pending` and records the
	 * request. A wrong secret on an open offer counts as a failure, the fifth burning it; every other case changes nothing.
	 * The secret is compared even for an unknown offer, in constant time.
	 */
	redeemOffer(redemption: OfferRedemption): RedeemOutcome {
		const at = this.now().toISOString();
		return this.db
			.transaction((): RedeemOutcome => {
				const row = this.offerRow(redemption.offerId);
				const matches = hashesEqual(redemption.secretSha256, row?.secret_sha256 ?? NO_HASH);
				if (row === null || row.status !== "open" || row.expires_at <= at) return { kind: "rejected" };
				if (!matches) {
					const failures = row.failures + 1;
					this.db
						.query("UPDATE pairing_offers SET failures = ?, status = ? WHERE id = ?")
						.run(failures, failures >= MAX_OFFER_FAILURES ? "burned" : "open", row.id);
					return { kind: "rejected" };
				}
				this.db
					.query(
						`UPDATE pairing_offers SET status = 'pending', request_id = ?, request_secret_sha256 = ?, request_name = ?,
							request_platform = ?, request_address = ?, requested_at = ? WHERE id = ?`,
					)
					.run(redemption.requestId, redemption.requestSecretSha256, redemption.name, redemption.platform, redemption.address, at, row.id);
				return { kind: "ok", expiresAt: row.expires_at };
			})
			.immediate();
	}

	/**
	 * One transaction answers a device polling its request. With the right request secret: `pending` while the owner has not
	 * decided, `declined` after a decline, and after an approval the one call that creates `device` (named like the request,
	 * with `-2`, `-3`, … until unique among active devices) and marks the offer `paired`. Anything else is `rejected`,
	 * including a second claim, an expired or cancelled offer and a wrong secret.
	 */
	claimOffer(requestId: string, requestSecretSha256: string, device: NewDevice): ClaimOutcome {
		const at = this.now().toISOString();
		return this.db
			.transaction((): ClaimOutcome => {
				const row = this.db.query<OfferRow, [string]>(`${OFFER_SELECT} WHERE o.request_id = ?`).get(requestId);
				const matches = hashesEqual(requestSecretSha256, row?.request_secret_sha256 ?? NO_HASH);
				if (row === null || !matches) return { kind: "rejected" };
				if (row.status === "declined") return { kind: "declined" };
				if (row.expires_at <= at) return { kind: "rejected" };
				if (row.status === "pending") return { kind: "pending" };
				if (row.status !== "approved" || row.request_name === null || row.request_platform === null || row.request_address === null) {
					return { kind: "rejected" };
				}
				const created = this.insertDevice({
					id: device.id,
					owner: row.owner,
					name: row.request_name,
					platform: row.request_platform,
					tokenSha256: device.tokenSha256,
					pairedFrom: row.request_address,
				});
				this.db.query("UPDATE pairing_offers SET status = 'paired', device_id = ? WHERE id = ?").run(device.id, row.id);
				return { kind: "created", device: created };
			})
			.immediate();
	}

	/**
	 * One immediate transaction adds an active device with no offer (the SSH pairing path, where access to the service's
	 * account is the proof of ownership). The name is made unique among the owner's active devices like a claim's: `-2`,
	 * `-3`, … Returns the device id and the name it got.
	 */
	addDevice(input: NewDeviceRecord): { id: string; name: string } {
		return this.db.transaction(() => this.insertDevice(input)).immediate();
	}

	/** The insert `claimOffer` and `addDevice` share; the caller holds the write transaction. */
	private insertDevice(input: NewDeviceRecord): { id: string; name: string } {
		let name = input.name;
		for (let n = 2; this.activeNameTaken(input.owner, name); n++) name = suffixedName(input.name, n);
		this.db
			.query(
				`INSERT INTO devices (id, owner, name, platform, token_sha256, created_at, paired_from)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(input.id, input.owner, name, input.platform, input.tokenSha256, this.now().toISOString(), input.pairedFrom);
		return { id: input.id, name };
	}

	/**
	 * The owner's decision on a `pending`, unexpired offer: `done`, `not_waiting` for any other state, `not_found` for an
	 * unknown offer.
	 */
	decideOffer(id: string, decision: "approve" | "decline"): "done" | "not_waiting" | "not_found" {
		const at = this.now().toISOString();
		return this.db
			.transaction((): "done" | "not_waiting" | "not_found" => {
				const row = this.offerRow(id);
				if (row === null) return "not_found";
				if (row.status !== "pending" || row.expires_at <= at) return "not_waiting";
				this.db.query("UPDATE pairing_offers SET status = ? WHERE id = ?").run(decision === "approve" ? "approved" : "declined", id);
				return "done";
			})
			.immediate();
	}

	/** Cancels an offer that is still open, pending or approved; a finished one stays as it is. False when the offer is unknown. */
	cancelOffer(id: string): boolean {
		return this.db
			.transaction(() => {
				const row = this.offerRow(id);
				if (row === null) return false;
				if (offerIsLive(row.status)) this.db.query("UPDATE pairing_offers SET status = 'cancelled' WHERE id = ?").run(id);
				return true;
			})
			.immediate();
	}

	/** The active device whose token has SHA-256 `tokenSha256`, or null (unknown or revoked). */
	deviceByTokenSha256(tokenSha256: string): Device | null {
		const row = this.db
			.query<DeviceRow, [string]>("SELECT * FROM devices WHERE token_sha256 = ? AND revoked_at IS NULL")
			.get(tokenSha256);
		return row !== null && hashesEqual(row.token_sha256, tokenSha256) ? deviceFromRow(row) : null;
	}

	/** The active device `id`, or null. */
	device(id: string): Device | null {
		const row = this.db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL").get(id);
		return row === null ? null : deviceFromRow(row);
	}

	/** The owner's active devices, oldest first. */
	devices(owner: string): Device[] {
		return this.db
			.query<DeviceRow, [string]>("SELECT * FROM devices WHERE owner = ? AND revoked_at IS NULL ORDER BY created_at, rowid")
			.all(owner)
			.map(deviceFromRow);
	}

	/**
	 * Records that the device was seen at `address` now, unless it was recorded less than `minIntervalMs` ago. A revoked
	 * device is left alone.
	 */
	touchDevice(id: string, address: string | null, minIntervalMs: number): void {
		const now = this.now();
		this.db
			.query(
				`UPDATE devices SET last_seen_at = ?, last_seen_address = ?
				WHERE id = ? AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at <= ?)`,
			)
			.run(now.toISOString(), address, id, new Date(now.getTime() - minIntervalMs).toISOString());
	}

	/**
	 * One transaction revokes the owner's active device `id` and lists its running threads: those whose first turn it sent
	 * and that are still starting, working or waiting. Null when there is no such active device.
	 */
	revokeDevice(id: string, owner: string): Revocation | null {
		const at = this.now().toISOString();
		return this.db
			.transaction((): Revocation | null => {
				const row = this.db
					.query<DeviceRow, [string, string]>("SELECT * FROM devices WHERE id = ? AND owner = ? AND revoked_at IS NULL")
					.get(id, owner);
				if (row === null) return null;
				this.db.query("UPDATE devices SET revoked_at = ? WHERE id = ?").run(at, id);
				const running = this.db
					.query<{ id: string }, [string]>(
						`SELECT t.id FROM threads t JOIN turns u ON u.thread_id = t.id AND u.id = 1
						WHERE u.sent_by = ? AND t.deleted_at IS NULL AND t.phase IN ('starting', 'working', 'waiting')
						ORDER BY t.created_at, t.id`,
					)
					.all(deviceActor(id));
				return { device: deviceFromRow({ ...row, revoked_at: at }), runningThreads: running.map(thread => thread.id) };
			})
			.immediate();
	}

	private offerRow(id: string): OfferRow | null {
		return this.db.query<OfferRow, [string]>(`${OFFER_SELECT} WHERE o.id = ?`).get(id);
	}

	private activeNameTaken(owner: string, name: string): boolean {
		return (
			this.db
				.query<{ one: number }, [string, string]>("SELECT 1 AS one FROM devices WHERE owner = ? AND name = ? AND revoked_at IS NULL")
				.get(owner, name) !== null
		);
	}

	// ---- internals

	/**
	 * Runs `body` in one immediate transaction: it throws "thread_not_found" first unless the thread is being created,
	 * then settles the thread's phase and last activity after the body. Listeners hear the body's events only after the
	 * commit; a throw rolls everything back and notifies nobody.
	 */
	private mutate<T>(threadId: string, body: (m: Mutation) => T, options?: { create: boolean }): T {
		const m = new Mutation(this.db, threadId, this.now().toISOString());
		const result = this.db
			.transaction(() => {
				if (!options?.create) this.liveThreadRow(threadId);
				const value = body(m);
				this.settle(threadId);
				return value;
			})
			.immediate();
		for (const event of m.events) this.notify(threadId, event);
		return result;
	}

	/** Recomputes the stored phase and last activity of a thread from its turns; the only writer of both. */
	private settle(threadId: string): void {
		const thread = this.threadRowAny(threadId);
		if (thread === null) return;
		const stats = this.db
			.query<ThreadStatsRow, [string, string]>(
				`SELECT
					coalesce(sum(state = 'running'), 0) AS running,
					coalesce(sum(state = 'queued'), 0) AS queued,
					coalesce(sum(started_at IS NOT NULL), 0) AS started,
					(SELECT count(*) FROM questions q WHERE q.thread_id = ? AND q.answered_at IS NULL
						AND EXISTS (SELECT 1 FROM turns t WHERE t.thread_id = q.thread_id AND t.id = q.turn_id AND t.state = 'running')) AS unanswered,
					coalesce(max(queued_at), '') AS latest_queued,
					coalesce(max(started_at), '') AS latest_started,
					coalesce(max(completed_at), '') AS latest_completed
				FROM turns WHERE thread_id = ?`,
			)
			.get(threadId, threadId) as ThreadStatsRow;
		const phase = derivePhase({
			deleted: thread.deleted_at !== null,
			failed: thread.error !== null,
			running: stats.running,
			queued: stats.queued,
			started: stats.started,
			unanswered: stats.unanswered,
		});
		// ISO 8601 UTC strings of equal precision order lexicographically.
		const lastActivity = [thread.created_at, stats.latest_queued, stats.latest_started, stats.latest_completed].reduce((a, b) =>
			b > a ? b : a,
		);
		if (phase !== thread.phase || lastActivity !== thread.last_activity_at) {
			this.db.query("UPDATE threads SET phase = ?, last_activity_at = ? WHERE id = ?").run(phase, lastActivity, threadId);
		}
	}

	private notify(threadId: string, event: ThreadEvent): void {
		for (const { listener } of [...(this.listeners.get(threadId) ?? [])]) {
			try {
				listener.event(event);
			} catch (err) {
				console.error("thread listener failed in event():", err);
			}
		}
		for (const listener of [...this.allListeners]) {
			try {
				listener.event(threadId, event);
			} catch (err) {
				console.error("thread listener failed in event():", err);
			}
		}
	}

	/** Validates and inserts a queued turn with the next id (an `irc` turn when `irc` is given). Throws like `enqueueTurn`. */
	private appendTurn(m: Mutation, text: string, by: string, irc?: { id: string; replyTo: string }): number {
		const thread = this.liveThreadRow(m.threadId);
		if (thread.error !== null) throw new StoreError("thread_failed", "the thread has failed");
		validateText(text);
		const counts = this.db
			.query<{ n: number; last: number }, [string]>("SELECT count(*) AS n, coalesce(max(id), 0) AS last FROM turns WHERE thread_id = ?")
			.get(m.threadId);
		if ((counts?.n ?? 0) >= MAX_TURNS) throw new StoreError("thread_full", `the thread holds ${MAX_TURNS} turns`);
		const next = (counts?.last ?? 0) + 1;
		this.insertTurn(m, next, text, by, irc);
		return next;
	}

	private insertTurn(m: Mutation, id: number, text: string, by: string, irc?: { id: string; replyTo: string }): void {
		this.db
			.query(
				`INSERT INTO turns (thread_id, id, state, text, sent_by, queued_at, origin, irc_from, irc_id, irc_reply_to)
				VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(m.threadId, id, text, by, m.at, irc === undefined ? "" : "irc", irc === undefined ? "" : by, irc?.id ?? "", irc?.replyTo ?? "");
		m.emit("turn_queued", id, `queued by ${by}`);
	}

	/**
	 * The messages sent into turn `turnId` that the runner never handed to omp become queued `irc` turns, in the order they
	 * arrived (the turn ended first). Messages the thread has no room for are dropped with a `notice` event. Returns how many
	 * became turns.
	 */
	private spillIrcInbox(m: Mutation, turnId: number): number {
		const rows = this.db
			.query<IrcInboxRow, [string, number]>("SELECT * FROM irc_inbox WHERE thread_id = ? AND turn_id = ? AND state = 'pending' ORDER BY at, rowid")
			.all(m.threadId, turnId);
		let turns = 0;
		for (const row of rows) {
			try {
				this.appendTurn(m, row.body, row.sender, { id: row.id, replyTo: row.reply_to });
				turns++;
			} catch (error) {
				if (!(error instanceof StoreError) || (error.code !== "thread_full" && error.code !== "thread_failed")) throw error;
				m.emit("notice", turnId, `an IRC message from ${row.sender} was dropped: ${error.message}`);
			}
			this.db.query("DELETE FROM irc_inbox WHERE thread_id = ? AND id = ?").run(m.threadId, row.id);
		}
		return turns;
	}

	/** Expires the unanswered questions of a turn (of one ask when given), one `question_expired` event each; returns how many. */
	private expireOpen(m: Mutation, turnId: number, answer: string, by: string, ask?: number): number {
		const params: SQLQueryBindings[] = [m.threadId, turnId];
		if (ask !== undefined) params.push(ask);
		const open = this.db
			.query<{ id: number }, SQLQueryBindings[]>(
				`SELECT id FROM questions WHERE thread_id = ? AND turn_id = ? AND answered_at IS NULL${ask === undefined ? "" : " AND ask = ?"} ORDER BY id`,
			)
			.all(...params);
		for (const { id } of open) {
			this.db
				.query(
					`UPDATE questions SET answer = ?, answered_by = ?, answered_at = ?, expired = 1
					WHERE thread_id = ? AND turn_id = ? AND id = ?`,
				)
				.run(answer, by, m.at, m.threadId, turnId, id);
			m.emit("question_expired", turnId, `question ${id} expired: ${by}`);
		}
		return open.length;
	}

	/** The sums and series a thread summary shows, from aggregate queries over the thread's turns. */
	private threadMetrics(thread: ThreadRow): ThreadMetrics {
		const sums = this.db
			.query<
				{ input: number; output: number; cache_read: number; cache_write: number; cost: number; requests: number; tools: number; work_ms: number },
				[string]
			>(
				`SELECT
					coalesce(sum(json_extract(usage, '$.inputTokens')), 0) AS input,
					coalesce(sum(json_extract(usage, '$.outputTokens')), 0) AS output,
					coalesce(sum(json_extract(usage, '$.cacheReadTokens')), 0) AS cache_read,
					coalesce(sum(json_extract(usage, '$.cacheWriteTokens')), 0) AS cache_write,
					coalesce(sum(json_extract(usage, '$.cost')), 0) AS cost,
					coalesce(sum(requests), 0) AS requests,
					coalesce(sum(tools), 0) AS tools,
					coalesce(sum(CASE WHEN state IN ('done', 'failed') AND started_at IS NOT NULL AND completed_at IS NOT NULL
						THEN round((julianday(completed_at) - julianday(started_at)) * 86400000) END), 0) AS work_ms
				FROM turns WHERE thread_id = ?`,
			)
			.get(thread.id);
		const recent = this.db
			.query<{ id: number; cost: number; context_tokens: number | null }, [string]>(
				`SELECT id, coalesce(json_extract(usage, '$.cost'), 0) AS cost, context_tokens FROM turns
				WHERE thread_id = ? AND state IN ('done', 'failed') ORDER BY id DESC LIMIT 12`,
			)
			.all(thread.id);
		return {
			usage: {
				inputTokens: sums?.input ?? 0,
				outputTokens: sums?.output ?? 0,
				cacheReadTokens: sums?.cache_read ?? 0,
				cacheWriteTokens: sums?.cache_write ?? 0,
				cost: sums?.cost ?? 0,
			},
			requests: sums?.requests ?? 0,
			tools: sums?.tools ?? 0,
			workMs: sums?.work_ms ?? 0,
			context: threadContextFromRow(thread),
			turns: recent.reverse().map((turn) => ({ n: turn.id, cost: turn.cost, contextTokens: turn.context_tokens })),
		};
	}

	/** The running turn's latest `tool` or `assistant` event. */
	private threadActivity(threadId: string): ThreadActivity | null {
		return this.db
			.query<ThreadActivity, [string, string]>(
				`SELECT kind, text, at FROM events
				WHERE thread_id = ? AND kind IN ('tool', 'assistant')
				AND turn_id = (SELECT id FROM turns WHERE thread_id = ? AND state = 'running' ORDER BY id LIMIT 1)
				ORDER BY seq DESC LIMIT 1`,
			)
			.get(threadId, threadId);
	}

	/** The oldest unanswered question of the running turn, with how many of its ask are unanswered. */
	private pendingQuestion(threadId: string): PendingQuestion | null {
		const row = this.db
			.query<QuestionRow, [string]>(
				`SELECT q.* FROM questions q JOIN turns t ON t.thread_id = q.thread_id AND t.id = q.turn_id
				WHERE q.thread_id = ? AND t.state = 'running' AND q.answered_at IS NULL
				ORDER BY q.turn_id, q.id LIMIT 1`,
			)
			.get(threadId);
		if (row === null) return null;
		const remaining = this.db
			.query<{ n: number }, [string, number, number]>(
				"SELECT count(*) AS n FROM questions WHERE thread_id = ? AND turn_id = ? AND ask = ? AND answered_at IS NULL",
			)
			.get(threadId, row.turn_id, row.ask);
		return { turn: row.turn_id, question: questionFromRow(row), remaining: remaining?.n ?? 0 };
	}

	private askOf(threadId: string, turnId: number, ask: number): Question[] {
		return this.db
			.query<QuestionRow, [string, number, number]>(
				"SELECT * FROM questions WHERE thread_id = ? AND turn_id = ? AND ask = ? ORDER BY id",
			)
			.all(threadId, turnId, ask)
			.map(questionFromRow);
	}

	private turnOf(row: TurnRow): Turn {
		const questions = this.db
			.query<QuestionRow, [string, number]>("SELECT * FROM questions WHERE thread_id = ? AND turn_id = ? ORDER BY id")
			.all(row.thread_id, row.id)
			.map(questionFromRow);
		return turnFromRow(row, questions);
	}

	private turnRow(threadId: string, turnId: number): TurnRow | null {
		return this.db.query<TurnRow, [string, number]>("SELECT * FROM turns WHERE thread_id = ? AND id = ?").get(threadId, turnId);
	}

	private questionRow(threadId: string, turnId: number, id: number): QuestionRow | null {
		return this.db
			.query<QuestionRow, [string, number, number]>("SELECT * FROM questions WHERE thread_id = ? AND turn_id = ? AND id = ?")
			.get(threadId, turnId, id);
	}

	private requireTurn(threadId: string, turnId: number): Turn {
		const row = this.turnRow(threadId, turnId);
		if (row === null) throw new Error(`turn ${turnId} of thread ${threadId} vanished`);
		return this.turnOf(row);
	}

	private requireThread(threadId: string): Thread {
		const thread = this.getThread(threadId);
		if (thread === null) throw new Error(`thread ${threadId} vanished`);
		return thread;
	}

	private threadRowAny(id: string): ThreadRow | null {
		return this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(id);
	}

	private threadRow(id: string): ThreadRow | null {
		return this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL").get(id);
	}

	private liveThreadRow(id: string): ThreadRow {
		const row = this.threadRow(id);
		if (row === null) throw new StoreError("thread_not_found", "no such thread");
		return row;
	}
}

/** Runs the migrations the database has not seen yet, each in its own transaction that also advances `user_version`. */
function migrate(db: Database): void {
	const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
	if (current > MIGRATIONS.length) {
		throw new Error(`database schema version ${current} is newer than this service knows (${MIGRATIONS.length})`);
	}
	for (let version = current; version < MIGRATIONS.length; version++) {
		const sql = MIGRATIONS[version];
		if (sql === undefined) throw new Error(`missing migration ${version + 1}`);
		db.transaction(() => {
			db.run(sql);
			db.run(`PRAGMA user_version = ${version + 1}`);
		}).immediate();
	}
}

/** The service id in `meta`, created on first use. */
function serviceId(db: Database): string {
	return db
		.transaction(() => {
			const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'service_id'").get();
			if (row !== null) return row.value;
			const id = randomId();
			db.query("INSERT INTO meta (key, value) VALUES ('service_id', ?)").run(id);
			return id;
		})
		.immediate();
}
