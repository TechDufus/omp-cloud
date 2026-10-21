import { compareVersions, type ReleaseManifest } from "./manifest";
import type { UpdateStateFile } from "./state";

/** `auto` installs only after no thread has been starting, working or waiting for this long. */
export const AUTO_QUIET_MS = 10 * 60_000;
/** An `applying` record this old belongs to an applier that is gone. */
export const APPLY_STALE_MS = 15 * 60_000;

export const CHECKOUT_MESSAGE = "this omp-cloud runs from a git checkout; update it with git pull and restart it";

export interface AutoInput {
	/** A release is staged and newer. */
	ready: boolean;
	/** Threads starting, working or waiting right now. */
	busyThreads: number;
	/** How long no thread has been busy, in ms. */
	quietMs: number;
	vmonInstalled: string | null;
	manifest: ReleaseManifest;
	/** The schema version of the database the service runs on. */
	schema: number;
}

/**
 * Whether `auto` installs the staged release by itself. Only when that is safe with no downtime for anyone: nothing is
 * running (and nothing was for 10 minutes), the release runs on the vibemon that is installed (a vibemon upgrade needs
 * root and restarts every VM) and on the database schema as it is (a migration is one-way). Otherwise `reason` says
 * what keeps it waiting for a click.
 */
export function autoDecision(input: AutoInput): { apply: boolean; reason: string } {
	if (!input.ready) return { apply: false, reason: "nothing is ready" };
	if (input.busyThreads > 0) return { apply: false, reason: `${input.busyThreads} thread${input.busyThreads === 1 ? " is" : "s are"} starting, working or waiting` };
	if (input.quietMs < AUTO_QUIET_MS) return { apply: false, reason: "a thread was busy less than 10 minutes ago" };
	if (input.vmonInstalled !== input.manifest.requires.vmon.version) {
		return { apply: false, reason: `the release needs vibemon ${input.manifest.requires.vmon.version}, ${input.vmonInstalled ?? "none"} is installed` };
	}
	if (input.manifest.requires.schema !== input.schema) {
		return { apply: false, reason: `the release needs database schema ${input.manifest.requires.schema}, the database is at ${input.schema}` };
	}
	return { apply: true, reason: "no thread is busy, vibemon and the schema are unchanged" };
}

export type UpdateState = "idle" | "checking" | "downloading" | "ready" | "applying" | "failed" | "unsupported";

export interface DeriveInput {
	managed: boolean;
	file: UpdateStateFile;
	currentVersion: string;
	/** What this process is doing for a check right now. */
	phase: "checking" | "downloading" | null;
	nowMs: number;
}

/** The release that is staged, newer than the running one, and described by the last check; null when none. */
export function readyRelease(file: UpdateStateFile, currentVersion: string): ReleaseManifest | null {
	if (file.staged === null || file.latest === null) return null;
	if (file.latest.manifest.version !== file.staged) return null;
	return compareVersions(file.staged, currentVersion) > 0 ? file.latest.manifest : null;
}

/** Whether the apply recorded in `file` is still believed to run. */
export function applyRunning(file: UpdateStateFile, nowMs: number): boolean {
	if (file.applying === null) return false;
	const started = Date.parse(file.applying.startedAt);
	return Number.isNaN(started) || nowMs - started < APPLY_STALE_MS;
}

/**
 * The state shown to users. Precedence: a checkout cannot update; an apply in progress; what this process is doing now;
 * an error (a failed apply keeps its staged release so Retry can apply it again); a staged newer release; otherwise idle.
 */
export function deriveState(input: DeriveInput): UpdateState {
	if (!input.managed) return "unsupported";
	if (applyRunning(input.file, input.nowMs)) return "applying";
	if (input.phase !== null) return input.phase;
	if (input.file.error !== null) return "failed";
	if (readyRelease(input.file, input.currentVersion) !== null) return "ready";
	return "idle";
}
