import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../guards";
import { isVersion, parseManifest, type ReleaseManifest } from "./manifest";

/** The steps of an apply, in order; `starting` before the first, `rollback` after a failure past `swap`. */
export const APPLY_STEPS = ["starting", "backup", "vmon", "omp", "swap", "health", "rollback"] as const;
export type ApplyStep = (typeof APPLY_STEPS)[number];

export interface Applying {
	version: string;
	step: ApplyStep;
	startedAt: string;
	/** The version being replaced: where a rollback points. */
	from: string;
	/** The archive of the step-1 backup, `""` before it or when none was taken. */
	backup: string;
}

/** What the last apply came to; kept until the next one starts. */
export interface LastApply {
	version: string;
	notes: string;
	at: string;
	result: "installed" | "failed";
	message: string;
}

/** `<app>/state.json`: shared by the service, the applier and the CLI, always written under the lock. */
export interface UpdateStateFile {
	version: 1;
	/** When the feed was last read (ISO), or null. */
	checked: string | null;
	/** The newest release the feed offered at that check. */
	latest: { manifest: ReleaseManifest; publishedAt: string } | null;
	/** The version downloaded, verified and staged under `versions/`, or null. */
	staged: string | null;
	applying: Applying | null;
	/** Why the last check, download or apply failed; null when it did not. */
	error: string | null;
	/** The version the last apply installed, and the one it replaced. */
	installed: string | null;
	previous: string | null;
	last: LastApply | null;
}

export function emptyState(): UpdateStateFile {
	return { version: 1, checked: null, latest: null, staged: null, applying: null, error: null, installed: null, previous: null, last: null };
}

function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** A state read from disk; whatever is missing or malformed falls back to its empty value, so a damaged file never blocks an update. */
export function parseState(raw: unknown): UpdateStateFile {
	const state = emptyState();
	if (!isRecord(raw)) return state;
	state.checked = text(raw.checked);
	if (isRecord(raw.latest)) {
		try {
			const publishedAt = text(raw.latest.publishedAt);
			if (publishedAt !== null) state.latest = { manifest: parseManifest(raw.latest.manifest), publishedAt };
		} catch {
			state.latest = null;
		}
	}
	const staged = text(raw.staged);
	state.staged = staged !== null && isVersion(staged) ? staged : null;
	if (isRecord(raw.applying)) {
		const { version, step, startedAt, from, backup } = raw.applying;
		const known = APPLY_STEPS.find((candidate) => candidate === step);
		if (typeof version === "string" && isVersion(version) && known !== undefined && typeof startedAt === "string" && typeof from === "string" && typeof backup === "string") {
			state.applying = { version, step: known, startedAt, from, backup };
		}
	}
	state.error = text(raw.error);
	state.installed = text(raw.installed);
	state.previous = text(raw.previous);
	if (isRecord(raw.last)) {
		const { version, notes, at, result, message } = raw.last;
		if (typeof version === "string" && typeof notes === "string" && typeof at === "string" && (result === "installed" || result === "failed") && typeof message === "string") {
			state.last = { version, notes, at, result, message };
		}
	}
	return state;
}

export interface StateStoreOptions {
	/** Test seam: whether a process exists. */
	alive?: (pid: number) => boolean;
	/** Test seam: sleeps between attempts at a held lock. */
	sleep?: (ms: number) => Promise<void>;
	/** A lock this old is dead whatever its pid says (a pid can be reused). */
	staleMs?: number;
	/** The longest to wait for a held lock. */
	waitMs?: number;
}

const POLL_MS = 25;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WAIT_MS = 15_000;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/** `state.json` behind a lock file: reads are lock-free (the file is replaced atomically), updates are serialised across processes. */
export class StateStore {
	readonly #file: string;
	readonly #lock: string;
	readonly #alive: (pid: number) => boolean;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #staleMs: number;
	readonly #waitMs: number;

	constructor(file: string, lock: string, options: StateStoreOptions = {}) {
		this.#file = file;
		this.#lock = lock;
		this.#alive = options.alive ?? processAlive;
		this.#sleep = options.sleep ?? Bun.sleep;
		this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS;
		this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
	}

	/** The current state; the empty one when the file is missing or unreadable. */
	async read(): Promise<UpdateStateFile> {
		try {
			return parseState(JSON.parse(await readFile(this.#file, "utf8")));
		} catch {
			return emptyState();
		}
	}

	/** Runs `change` on the current state under the lock and writes the result atomically; returns it. */
	async update(change: (state: UpdateStateFile) => void): Promise<UpdateStateFile> {
		await mkdir(dirname(this.#file), { recursive: true });
		const release = await this.#acquire();
		try {
			const state = await this.read();
			change(state);
			const temp = `${this.#file}.tmp-${process.pid}`;
			await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
			await rename(temp, this.#file);
			return state;
		} finally {
			await release();
		}
	}

	async #acquire(): Promise<() => Promise<void>> {
		const deadline = Date.now() + this.#waitMs;
		for (;;) {
			try {
				const handle = await open(this.#lock, "wx", 0o644);
				await handle.writeFile(String(process.pid));
				await handle.close();
				return () => rm(this.#lock, { force: true });
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
			if (await this.#breakIfDead()) continue;
			if (Date.now() >= deadline) throw new Error(`the update state is locked by another process (${this.#lock})`);
			await this.#sleep(POLL_MS);
		}
	}

	/** Removes the lock when its owner is gone or it is stale; true when it did. */
	async #breakIfDead(): Promise<boolean> {
		try {
			const [owner, info] = await Promise.all([readFile(this.#lock, "utf8"), stat(this.#lock)]);
			const pid = Number(owner.trim());
			// A lock whose pid is not written yet (the file is created, then filled) is its owner starting, not a dead one.
			const unwritten = owner.trim() === "" && Date.now() - info.mtimeMs < 5000;
			const dead = !unwritten && (!Number.isInteger(pid) || pid < 1 || !this.#alive(pid));
			if (dead || Date.now() - info.mtimeMs > this.#staleMs) {
				await rm(this.#lock, { force: true });
				return true;
			}
		} catch {
			// The lock was released between the attempt and the look: try again.
			return true;
		}
		return false;
	}
}
