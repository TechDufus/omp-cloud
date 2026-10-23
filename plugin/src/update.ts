/**
 * Updates of the cloud service as the session sees them: what `whoami` says of them (every caller sees it), the
 * footer's `update ready` for a connection with full access, one card per ready version, and one notice per session when this plugin is older
 * than the service it talks to. Applying an update needs full access and lives in `Cloud` (confirm, then the route).
 */

import { fullAccess } from "./access";
import { asCard, CARD_TYPE } from "./cards";
import { isRecord } from "./guards";
import type { UpdateStatus, Whoami, WhoamiUpdate } from "./types";

/** How often the session asks the service again, so `update ready` appears without a command. */
export const UPDATE_PROBE_MS = 15 * 60_000;

/** `[major, minor, patch, prerelease]` of `1.2.3` or `v1.2.3-rc.1`; undefined for anything else. */
function parseVersion(v: string): [number, number, number, string] | undefined {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : undefined;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal; undefined when either is not a version. A release outranks its own prereleases. */
export function compareVersions(a: string, b: string): number | undefined {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return undefined;
	const major = x[0] - y[0];
	if (major !== 0) return major;
	const minor = x[1] - y[1];
	if (minor !== 0) return minor;
	const patch = x[2] - y[2];
	if (patch !== 0) return patch;
	if (x[3] === y[3]) return 0;
	if (x[3] === "") return 1;
	if (y[3] === "") return -1;
	return x[3] < y[3] ? -1 : 1;
}

/** What the plugin tells the user when it is older than the service. */
export function pluginOlderText(plugin: string, service: string): string {
	return `☁ the omp-cloud plugin ${plugin} is older than the service ${service}: update it (omp plugin upgrade omp-cloud, or git pull in a linked checkout) and restart omp`;
}

/** Whether this release moves vibemon: it is installed and the release needs another tag. */
export function vmonMoves({ installed, required }: UpdateStatus["vmon"]): boolean {
	return installed !== null && required !== null && installed !== required;
}

/**
 * What an update confirmation adds when the release moves vibemon: the restart it causes and, with other machines in the
 * cluster, that they follow by themselves. Empty when vibemon stays as it is (or is not installed, which the update does
 * not restart). `machines` is the capacity's machine count, undefined when the service did not report it.
 */
export function vmonMoveText(vmon: UpdateStatus["vmon"], machines: number | undefined): string {
	if (!vmonMoves(vmon)) return "";
	const moves = `This release moves vibemon from ${vmon.installed} to ${vmon.required}: vmon restarts, so a turn running now is re-run.`;
	if (machines === undefined || machines <= 1) return moves;
	const others = machines - 1;
	return `${moves} ${others === 1 ? "The other vibemon machine follows by itself" : `The other ${others} vibemon machines follow by themselves`} within a few minutes.`;
}

/** The update state as one line for the user and the model; undefined when the service reports none. `full` is whether this caller has full access, which installs updates. */
export function updateLine(u: WhoamiUpdate | null, full: boolean): string | undefined {
	if (!u) return undefined;
	const version = u.available ?? "a newer version";
	switch (u.state) {
		case "ready":
			return full ? `${version} is downloaded and ready: /cloud update (or the card's Restart to update button) restarts the service to install it` : `${version} is downloaded and ready: a connection with full access installs it (/cloud update there)`;
		case "downloading":
			return `downloading ${version}`;
		case "checking":
			return "checking for a newer version";
		case "applying":
			return `installing ${u.available ?? "an update"}: the service restarts`;
		case "failed":
			return full ? "the last update failed: /cloud update shows why and checks again" : "the last update failed: a connection with full access sees why in /cloud update";
		case "unsupported":
			return "not managed: this service runs from a git checkout; update it with git pull and restart it";
		case "idle":
			return "up to date";
	}
}

/** Versions whose update card the session's entries already hold, so a resumed session does not show the same card again. */
export function updateVersionsFromEntries(entries: readonly unknown[]): Set<string> {
	const out = new Set<string>();
	for (const e of entries) {
		if (!isRecord(e) || e.type !== "custom_message" || e.customType !== CARD_TYPE) continue;
		const card = asCard(e.details);
		if (card?.kind === "update") out.add(card.version);
	}
	return out;
}

/** Runs `run` every `ms` until the returned function is called. */
export type Schedule = (run: () => void, ms: number) => () => void;

const intervalSchedule: Schedule = (run, ms) => {
	const timer = setInterval(run, ms);
	timer.unref();
	return () => clearInterval(timer);
};

export interface UpdatesOptions {
	/** This plugin's version. */
	pluginVersion: string;
	/** The notice that the plugin is older than the service. */
	notify(message: string): void;
	/** A version is ready for the owner and its card was not shown yet. */
	card(version: string): void;
	/** Versions whose card the session already holds. */
	shown(): ReadonlySet<string>;
	/** What the footer shows changed (an update became ready for a connection with full access, or stopped being; the cloud's name changed). */
	changed(): void;
	/** Test seam for the periodic probe. */
	schedule?: Schedule;
}

/** What the session knows of the service's update: fed by every `whoami` it sees. */
export class Updates {
	readonly #o: UpdatesOptions;
	#update: WhoamiUpdate | null = null;
	#full = false;
	#cloud = "";
	#olderNoticed = false;
	/** Versions whose card was posted by this instance (the session's entries lag a posted card). */
	readonly #carded = new Set<string>();
	#stop: (() => void) | undefined;

	constructor(options: UpdatesOptions) {
		this.#o = options;
	}

	/** The update a `whoami` carries; null when the service reports none. */
	get update(): WhoamiUpdate | null {
		return this.#update;
	}

	/** Whether the caller of the last `whoami` has full access (a threads-only device cannot install). */
	get full(): boolean {
		return this.#full;
	}

	/** What the cloud calls itself, as the last `whoami` said; `""` before one, and for a service that predates names. */
	get cloud(): string {
		return this.#cloud;
	}

	/** The version waiting for a connection with full access to install it: set only for one, and only while it is `ready`. */
	get ready(): string | undefined {
		const u = this.#update;
		return this.#full && u?.state === "ready" && u.available !== null ? u.available : undefined;
	}

	/** Takes in a `whoami`: the plugin notice (once per session), the footer, and the card (once per version, full access only). */
	observe(who: Whoami): void {
		const before = this.ready;
		const cloud = this.#cloud;
		this.#full = fullAccess(who);
		this.#cloud = who.service.name;
		this.#update = who.update;
		if (!this.#olderNoticed && who.service.version !== "" && (compareVersions(this.#o.pluginVersion, who.service.version) ?? 0) < 0) {
			this.#olderNoticed = true;
			this.#o.notify(pluginOlderText(this.#o.pluginVersion, who.service.version));
		}
		const ready = this.ready;
		if (ready !== before || this.#cloud !== cloud) this.#o.changed();
		if (ready !== undefined && !this.#carded.has(ready) && !this.#o.shown().has(ready)) {
			this.#carded.add(ready);
			this.#o.card(ready);
		}
	}

	/** A connection with full access asked the service to install: it is no longer waiting for a click. */
	applying(version: string): void {
		const before = this.ready;
		this.#update = { state: "applying", available: version, mode: this.#update?.mode ?? "notify" };
		if (before !== undefined) this.#o.changed();
	}

	/** Calls `probe` now and every {@link UPDATE_PROBE_MS}; a second call changes nothing. */
	start(probe: () => Promise<void>): void {
		if (this.#stop) return;
		void probe();
		this.#stop = (this.#o.schedule ?? intervalSchedule)(() => void probe(), UPDATE_PROBE_MS);
	}

	stop(): void {
		this.#stop?.();
		this.#stop = undefined;
	}
}
