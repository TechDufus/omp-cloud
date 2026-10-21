/** What the header pill and the Settings card show of the service's own update: pure functions of the status the service reports. */
import type { UpdateStatus } from "../api";
import { ago } from "../format";

/** What each `applying.step` is doing, for "Updating to 0.5.1 · switching to the new version". */
const STEP_TEXT: Readonly<Record<string, string>> = {
	starting: "starting",
	backup: "backing up the database",
	vmon: "updating vibemon",
	omp: "restarting omp",
	swap: "switching to the new version",
	health: "checking the new version",
	rollback: "rolling back",
};

/** An applied release's "Updated to" pill stays this long for a browser that has not dismissed it. */
export const UPDATED_VISIBLE_MS = 3 * 24 * 60 * 60 * 1000;

/** States in which the service changes by itself: the client polls fast. */
const MOVING_STATES: readonly UpdateStatus["state"][] = ["checking", "downloading", "applying"];

export type Pill =
	| { kind: "downloading"; version: string }
	| { kind: "ready"; version: string }
	| { kind: "applying"; version: string; step: string }
	/** The service is down for the swap (or the call failed) while an apply is running. */
	| { kind: "restarting"; version: string }
	| { kind: "failed"; error: string; retry: "apply" | "check" }
	| { kind: "updated"; version: string; notes: string };

export interface PillInput {
	/** The latest status, if any call has succeeded. */
	status: UpdateStatus | undefined;
	/** The version this browser asked to apply; `null` when none. */
	pending: string | null;
	/** The release whose "Updated to" pill this browser dismissed. */
	seen: string | null;
	/** Whether the last status call failed (the service is restarting, or unreachable). */
	unreachable: boolean;
	/** Why the last click on apply or check was refused. */
	refusal: string | null;
	now: number;
}

/** The pill to show, or null when the service is up to date and has nothing to say. */
export function pillOf({ status, pending, seen, unreachable, refusal, now }: PillInput): Pill | null {
	if (refusal !== null) return { kind: "failed", error: refusal, retry: status?.staged ? "apply" : "check" };
	if (unreachable && pending !== null) return { kind: "restarting", version: pending };
	if (status === undefined) return null;
	const latest = status.latest?.version ?? "";
	switch (status.state) {
		case "applying":
			return {
				kind: "applying",
				version: status.applying?.version ?? latest,
				step: STEP_TEXT[status.applying?.step ?? ""] ?? status.applying?.step ?? "",
			};
		case "failed":
			return {
				kind: "failed",
				error: status.error ?? status.last?.message ?? status.message ?? "the update failed",
				retry: status.staged !== null ? "apply" : "check",
			};
		case "ready":
			return { kind: "ready", version: status.staged ?? latest };
		case "downloading":
			return { kind: "downloading", version: latest };
		default: {
			const last = status.last;
			if (
				last !== null &&
				last.result === "installed" &&
				last.version === status.current.version &&
				last.version !== seen &&
				now - Date.parse(last.at) < UPDATED_VISIBLE_MS
			) {
				return { kind: "updated", version: last.version, notes: last.notes };
			}
			return null;
		}
	}
}

/** Whether the pending marker still means something: it stays through an apply, then ends once the new version runs or the apply stopped. */
export function pendingStillApplies(status: UpdateStatus, pending: string): boolean {
	if (status.current.version === pending) return false;
	return status.state === "applying" || status.state === "ready" || status.state === "checking" || status.state === "downloading";
}

/** Whether to poll quickly: something moves, or this browser waits for the swap. */
export function isMoving(status: UpdateStatus | undefined, pending: string | null): boolean {
	return pending !== null || (status !== undefined && MOVING_STATES.includes(status.state));
}

/** "Up to date · checked 5 min ago", or "Never checked". */
export function checkedText(status: UpdateStatus, now: number): string {
	if (status.checkedAt === null) return "Not checked yet";
	return `checked ${ago(status.checkedAt, now)}`;
}

/** The vibemon row: installed against required, and whether they agree. */
export function vmonRow(vmon: UpdateStatus["components"]["vmon"]): { text: string; tone: "ok" | "warn" | "neutral" } {
	const installed = vmon.installed ?? "not installed";
	if (vmon.required === null) return { text: installed, tone: "neutral" };
	if (vmon.installed === vmon.required) return { text: `${installed} · matches this release`, tone: "ok" };
	return {
		text: `${installed}${vmon.installed === null ? "" : " installed"} · ${vmon.required} required${vmon.helper ? "" : " · root helper missing"}`,
		tone: "warn",
	};
}
