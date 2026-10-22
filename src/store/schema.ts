/**
 * The SQLite schema as an append-only list of migrations. `PRAGMA user_version` holds how many have run, so a later
 * phase adds its change as a new entry at the end and never edits an existing one.
 */
export const MIGRATIONS: readonly string[] = [
	// 1: threads, turns, questions, events.
	`
	CREATE TABLE threads (
		id TEXT PRIMARY KEY,
		owner TEXT NOT NULL,
		phase TEXT NOT NULL,
		title TEXT NOT NULL,
		model TEXT NOT NULL,
		thinking TEXT NOT NULL,
		repo_name TEXT NOT NULL,
		repo_remote_url TEXT NOT NULL,
		repo_base_ref TEXT NOT NULL,
		repo_base_commit TEXT NOT NULL,
		repo_handoff_commit TEXT NOT NULL,
		repo_local_branch TEXT NOT NULL,
		home TEXT NOT NULL,
		workspace TEXT NOT NULL,
		author_name TEXT NOT NULL,
		author_email TEXT NOT NULL,
		secret_files TEXT NOT NULL,
		secret_env TEXT NOT NULL,
		-- NULL until failThread: a NULL error means the thread has not failed.
		error TEXT,
		created_at TEXT NOT NULL,
		last_activity_at TEXT NOT NULL,
		-- Tombstone: the row stays after deleteThread so the id is never reused.
		deleted_at TEXT
	);
	CREATE INDEX threads_by_owner ON threads (owner, created_at DESC, id DESC) WHERE deleted_at IS NULL;

	CREATE TABLE turns (
		thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
		id INTEGER NOT NULL,
		state TEXT NOT NULL,
		text TEXT NOT NULL,
		sent_by TEXT NOT NULL,
		queued_at TEXT NOT NULL,
		started_at TEXT,
		completed_at TEXT,
		stop_requested INTEGER NOT NULL DEFAULT 0,
		stopped_by TEXT NOT NULL DEFAULT '',
		reply TEXT NOT NULL DEFAULT '',
		title TEXT NOT NULL DEFAULT '',
		error TEXT NOT NULL DEFAULT '',
		usage TEXT,
		head TEXT NOT NULL DEFAULT '',
		files_changed INTEGER NOT NULL DEFAULT 0,
		insertions INTEGER NOT NULL DEFAULT 0,
		deletions INTEGER NOT NULL DEFAULT 0,
		pushed INTEGER NOT NULL DEFAULT 0,
		push_error TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (thread_id, id)
	);

	CREATE TABLE questions (
		thread_id TEXT NOT NULL,
		turn_id INTEGER NOT NULL,
		id INTEGER NOT NULL,
		ask INTEGER NOT NULL,
		key TEXT NOT NULL,
		text TEXT NOT NULL,
		header TEXT NOT NULL,
		options TEXT NOT NULL,
		multi INTEGER NOT NULL,
		recommended INTEGER,
		asked_at TEXT NOT NULL,
		selected TEXT NOT NULL DEFAULT '[]',
		answer TEXT NOT NULL DEFAULT '',
		answered_by TEXT NOT NULL DEFAULT '',
		answered_at TEXT,
		expired INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (thread_id, turn_id, id),
		FOREIGN KEY (thread_id, turn_id) REFERENCES turns (thread_id, id) ON DELETE CASCADE
	);

	-- Append-only; seq is per thread, 1-based and gapless.
	CREATE TABLE events (
		thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
		seq INTEGER NOT NULL,
		at TEXT NOT NULL,
		kind TEXT NOT NULL,
		turn_id INTEGER,
		text TEXT NOT NULL,
		PRIMARY KEY (thread_id, seq)
	);
	`,
	// 2: the runner's records. questions.request_id is omp's ui request id of an ask, omp_key and omp_labels its uncut
	// question id and option labels; turns.prompt_sent_at is when the text went to omp; vms outlives a deleted thread
	// until the runner tears the VM down; meta holds the service id.
	`
	ALTER TABLE questions ADD COLUMN request_id TEXT;
	ALTER TABLE questions ADD COLUMN omp_key TEXT NOT NULL DEFAULT '';
	ALTER TABLE questions ADD COLUMN omp_labels TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE turns ADD COLUMN prompt_sent_at TEXT;

	CREATE TABLE vms (
		thread_id TEXT PRIMARY KEY REFERENCES threads (id),
		sandbox_id TEXT NOT NULL,
		state TEXT NOT NULL,
		pid INTEGER,
		session_file TEXT,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	`,
	// 3: the owner's environment. threads.config_overlays is the JSON list of the session's `--config` overlays (paths
	// inside the shipped setup, in load order); threads.omp_version the omp version the VM runs ('' for threads that
	// predate it).
	`
	ALTER TABLE threads ADD COLUMN config_overlays TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE threads ADD COLUMN omp_version TEXT NOT NULL DEFAULT '';
	`,
	// 4: the settings store. settings holds only the values an operator changed (value is JSON; an absent row means the
	// registry default); settings_audit keeps one row per changed key, old_value and new_value being JSON or NULL for
	// the default.
	`
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		updated_by TEXT NOT NULL
	);

	CREATE TABLE settings_audit (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		at TEXT NOT NULL,
		actor TEXT NOT NULL,
		action TEXT NOT NULL,
		key TEXT NOT NULL,
		old_value TEXT,
		new_value TEXT
	);
	`,
	// 5: the branch a turn's result was pushed to (`''` when it was not); pushed/push_error stay as they were.
	`
	ALTER TABLE turns ADD COLUMN push_ref TEXT NOT NULL DEFAULT '';
	`,
	// 6: the owner's spend per UTC day, kept when a thread (and its turns) is deleted so that a spend cap cannot be reset
	// by deleting threads. Backfilled from the turns that recorded a cost.
	`
	CREATE TABLE spend_days (
		owner TEXT NOT NULL,
		day TEXT NOT NULL,
		cost REAL NOT NULL,
		PRIMARY KEY (owner, day)
	);

	INSERT INTO spend_days (owner, day, cost)
	SELECT th.owner, substr(t.completed_at, 1, 10), sum(json_extract(t.usage, '$.cost'))
	FROM turns t JOIN threads th ON th.id = t.thread_id
	WHERE t.usage IS NOT NULL AND t.completed_at IS NOT NULL AND json_extract(t.usage, '$.cost') > 0
	GROUP BY th.owner, substr(t.completed_at, 1, 10);
	`,
	// 7: the policy a create request tightened (JSON of the flat `policy.*` keys without the prefix; `{}` for none).
	`
	ALTER TABLE threads ADD COLUMN policy TEXT NOT NULL DEFAULT '{}';
	`,
	// 8: paired devices and pairing offers. devices holds the SHA-256 of each device token (never the token);
	// a revoked device keeps its row. pairing_offers holds an offer and the one request redeemed against it, each secret as
	// its SHA-256; status is open, pending, approved, paired, declined, cancelled or burned (`expired` is computed).
	`
	CREATE TABLE devices (
		id TEXT PRIMARY KEY,
		owner TEXT NOT NULL,
		name TEXT NOT NULL,
		platform TEXT NOT NULL,
		token_sha256 TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL,
		paired_from TEXT NOT NULL,
		last_seen_at TEXT,
		last_seen_address TEXT,
		revoked_at TEXT
	);
	CREATE UNIQUE INDEX devices_active_name ON devices (owner, name) WHERE revoked_at IS NULL;

	CREATE TABLE pairing_offers (
		id TEXT PRIMARY KEY,
		owner TEXT NOT NULL,
		secret_sha256 TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		status TEXT NOT NULL,
		failures INTEGER NOT NULL DEFAULT 0,
		request_id TEXT UNIQUE,
		request_secret_sha256 TEXT,
		request_name TEXT,
		request_platform TEXT,
		request_address TEXT,
		requested_at TEXT,
		device_id TEXT REFERENCES devices (id)
	);
	`,
	// 9: thread names, the archive lifecycle and list metrics. threads.name is the short human name ('' for none);
	// archived_at is when the archive sweep released the VM (NULL while the thread has one); restore_head is the thread
	// branch head the archive snapshot committed past the last turn ('' for none); context_* is the latest context use
	// omp reported. turns.requests and turns.tools count the turn's model requests and tool calls; turns.context_* is the
	// context use at the turn's end.
	`
	ALTER TABLE threads ADD COLUMN name TEXT NOT NULL DEFAULT '';
	ALTER TABLE threads ADD COLUMN archived_at TEXT;
	ALTER TABLE threads ADD COLUMN restore_head TEXT NOT NULL DEFAULT '';
	ALTER TABLE threads ADD COLUMN context_tokens INTEGER;
	ALTER TABLE threads ADD COLUMN context_window INTEGER;
	ALTER TABLE threads ADD COLUMN context_at TEXT;
	ALTER TABLE turns ADD COLUMN requests INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE turns ADD COLUMN tools INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE turns ADD COLUMN context_tokens INTEGER;
	ALTER TABLE turns ADD COLUMN context_window INTEGER;
	`,
	// 10: thread metadata, scratch threads and idempotent create. origin is `tool` or `user` ('' unknown), ref the caller's
	// short label, session the omp session id that started the thread; scratch marks a thread without a repository;
	// idempotency_key is the create request's `Idempotency-Key` (NULL for none), unique per owner among live threads;
	// idempotency_fingerprint is the SHA-256 (hex) of that request's prompt, what a later request with the key is compared to.
	// threads_by_activity serves the paged list (newest lastActivityAt first).
	`
	ALTER TABLE threads ADD COLUMN origin TEXT NOT NULL DEFAULT '';
	ALTER TABLE threads ADD COLUMN ref TEXT NOT NULL DEFAULT '';
	ALTER TABLE threads ADD COLUMN session TEXT NOT NULL DEFAULT '';
	ALTER TABLE threads ADD COLUMN scratch INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE threads ADD COLUMN idempotency_key TEXT;
	ALTER TABLE threads ADD COLUMN idempotency_fingerprint TEXT NOT NULL DEFAULT '';
	CREATE UNIQUE INDEX threads_idempotency ON threads (owner, idempotency_key) WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;
	CREATE INDEX threads_by_activity ON threads (owner, last_activity_at DESC, id DESC) WHERE deleted_at IS NULL;
	`,
	// 11: IRC between a thread's agent and its peers. turns.origin is `irc` for a turn a peer's message started ('' for an
	// ordinary message), irc_from the sender, irc_id the message id (the wake relay's replyTo) and irc_reply_to the replyTo
	// the message carried. irc_seen holds the ids of the messages the VM agent wrote, so a redelivered frame is stored once.
	// irc_inbox holds the messages sent into a running turn: `pending` until the runner hands them to omp, then `sent`; a
	// pending one whose turn ends first becomes an `irc` turn. Its primary key makes a repeated id idempotent.
	`
	ALTER TABLE turns ADD COLUMN origin TEXT NOT NULL DEFAULT '';
	ALTER TABLE turns ADD COLUMN irc_from TEXT NOT NULL DEFAULT '';
	ALTER TABLE turns ADD COLUMN irc_id TEXT NOT NULL DEFAULT '';
	ALTER TABLE turns ADD COLUMN irc_reply_to TEXT NOT NULL DEFAULT '';
	CREATE TABLE irc_seen (
		thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		PRIMARY KEY (thread_id, id)
	);
	CREATE TABLE irc_inbox (
		thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		turn_id INTEGER NOT NULL,
		sender TEXT NOT NULL,
		body TEXT NOT NULL,
		reply_to TEXT NOT NULL DEFAULT '',
		state TEXT NOT NULL DEFAULT 'pending',
		at TEXT NOT NULL,
		PRIMARY KEY (thread_id, id)
	);
	CREATE INDEX irc_inbox_by_turn ON irc_inbox (thread_id, turn_id, at);
	`,
	// 12: the pull request a thread's pushes opened (`pr_number` 0 means none).
	`
	ALTER TABLE threads ADD COLUMN pr_number INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE threads ADD COLUMN pr_url TEXT NOT NULL DEFAULT '';
	`,
];
