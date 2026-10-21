import { stat } from "node:fs/promises";
import { type AppLayout, linkedVersion, prune, swapLink } from "./layout";
import { compareVersions, type ReleaseManifest } from "./manifest";
import type { ApplyStep, StateStore } from "./state";
import { type Units, type VmonTools } from "./system";

export const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 1000;

export interface ApplyDeps {
	layout: AppLayout;
	state: StateStore;
	units: Units;
	vmon: VmonTools;
	/** The service's user unit (`update.unit`). */
	serviceUnit: string;
	/** The units the `omp` step checks and restarts (`update.ompUnits`); empty skips the step's work. */
	ompUnits: readonly string[];
	/** `GET /api/v1/health` of the service, without a trailing slash: `http://127.0.0.1:8080`. */
	healthBase: string;
	/** The omp the service host runs (`hostOmp()`). */
	ompHost: string;
	/** The database's schema version, read from the file. */
	schema: () => number;
	/** Takes the step-1 backup; resolves with the archive's path. */
	backup: () => Promise<string>;
	/** Puts the backup's database back; the service is stopped. */
	restore: (archive: string) => Promise<void>;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	healthTimeoutMs?: number;
	log?: (message: string) => void;
	/** Starts the service unit again when it is gone (a transient unit that ended is unloaded), with the `Environment` it had before the swap: absent means a rollback only restarts. */
	recreateService?: (env: Record<string, string>) => Promise<void>;
	/**
	 * Puts the new version's plugin in omp: runs the new binary (`<app>/versions/<v>/omp-cloud`, which carries the
	 * bundle) through `refreshPluginFrom`. A rejection never fails the update; it is noted in the outcome. Absent: no step.
	 */
	plugin?: (binary: string) => Promise<unknown>;
}

export interface ApplyOutcome {
	ok: boolean;
	/** What happened, in a sentence: `updated to 0.5.1` or the reason it failed (`…; rolled back to 0.5.0`). */
	message: string;
}

/** A failure that happened after the service was pointed at the new version: undone by rollback. */
class AfterSwap extends Error {}

/** A failure before the swap: nothing of the install was touched, so there is nothing to undo. */
class BeforeSwap extends Error {}

/**
 * Installs the staged `version` and records every step in `state.json` (`applying.step`):
 * `backup` (when the release needs a newer database schema), `vmon` (when it needs another vibemon: the root helper),
 * `omp` (restart the broker and gateway units that run another omp than the host's), `swap` (point `bin/omp-cloud` at the
 * new version, restart the service unit) and `health` (the new version must answer `/api/v1/health` within 60 s). A
 * failure after the swap points back, restores the backup if one was taken, restarts and fails with
 * `…; rolled back to <old>`. Before anything changes it refuses what cannot work: a vibemon that is needed but cannot
 * be installed, an omp older than the release's minimum. On success it prunes old versions, runs the `plugin` step (the
 * new binary puts its plugin in omp; a failure is only noted in the message, never fails or rolls back the update) and
 * records `installed`/`previous`/`last`.
 */
export async function applyStaged(version: string, deps: ApplyDeps): Promise<ApplyOutcome> {
	const { layout, state, units } = deps;
	const log = deps.log ?? ((message) => console.log(`omp-cloud update: ${message}`));
	const now = deps.now ?? Date.now;
	const file = await state.read();
	const manifest = file.latest?.manifest;
	const old = (await linkedVersion(layout)) ?? file.applying?.from ?? null;

	const finish = async (ok: boolean, message: string, manifestForNotes: ReleaseManifest | undefined): Promise<ApplyOutcome> => {
		await state.update((next) => {
			next.applying = null;
			next.error = ok ? null : message;
			next.last = { version, notes: manifestForNotes?.notes ?? "", at: new Date(now()).toISOString(), result: ok ? "installed" : "failed", message };
			if (ok) {
				next.staged = null;
				next.installed = version;
				next.previous = old;
			}
		});
		log(message);
		return { ok, message };
	};

	if (manifest === undefined || manifest.version !== version || file.staged !== version) {
		return finish(false, `omp-cloud ${version} is not staged; check for updates first`, manifest);
	}
	if (old === null) return finish(false, "cannot tell which omp-cloud version is installed (bin/omp-cloud is not a managed link)", manifest);
	if (compareVersions(version, old) <= 0) return finish(false, `omp-cloud ${version} is not newer than ${old}`, manifest);
	try {
		await stat(layout.versionBinary(version));
	} catch {
		return finish(false, `the staged omp-cloud ${version} is missing; check for updates again`, manifest);
	}

	const step = async (name: ApplyStep, extra?: { backup: string }): Promise<void> => {
		await state.update((next) => {
			const startedAt = next.applying?.startedAt ?? new Date(now()).toISOString();
			next.applying = { version, step: name, startedAt, from: old, backup: extra?.backup ?? next.applying?.backup ?? "" };
		});
		log(extra === undefined ? `step ${name}` : `step ${name}: saved ${extra.backup}`);
	};
	await step("starting");

	const required = manifest.requires.vmon.version;
	// Before anything restarts: a unit that a crash unloads can no longer be asked for its environment.
	const serviceEnv = await units.environment(deps.serviceUnit);
	let backupPath = "";
	let swapped = false;
	try {
		// Refusals first, while nothing has changed.
		const installedVmon = await deps.vmon.installed();
		const needVmon = installedVmon !== required;
		if (needVmon && !(await deps.vmon.helper()).available) {
			throw new BeforeSwap(`vibemon ${required} is needed (${installedVmon ?? "none"} is installed) and the root helper is not installed: run omp-cloud setup once`);
		}
		if (compareVersions(deps.ompHost, manifest.requires.omp.min) < 0) {
			throw new BeforeSwap(`omp ${manifest.requires.omp.min} or newer is needed, this host has ${deps.ompHost}`);
		}

		if (manifest.requires.schema > deps.schema()) {
			await step("backup");
			try {
				backupPath = await deps.backup();
			} catch (error) {
				throw new BeforeSwap(`the backup before the schema change failed: ${errorText(error)}`);
			}
			await step("backup", { backup: backupPath });
		}

		if (needVmon) {
			await step("vmon");
			try {
				await deps.vmon.install(required);
			} catch (error) {
				throw new BeforeSwap(`installing vibemon ${required} failed: ${errorText(error)}`);
			}
		}

		// The broker and the gateway keep running the omp they started with after the host's omp moves on, and setup restarts a
		// persistent unit only when its rendered file changes: this step restarts the ones whose process runs another omp.
		// An empty `update.ompUnits` skips the step: it is not even recorded.
		if (deps.ompUnits.length > 0) await step("omp");
		for (const unit of deps.ompUnits) {
			const running = await units.ompVersion(unit);
			if (running === null || running === deps.ompHost) continue;
			try {
				await units.restart(unit);
			} catch (error) {
				throw new BeforeSwap(`restarting ${unit} onto omp ${deps.ompHost} failed: ${errorText(error)}`);
			}
		}

		await step("swap");
		swapped = true;
		try {
			await swapLink(layout, version);
			await units.restart(deps.serviceUnit);
		} catch (error) {
			throw new AfterSwap(`switching to ${version} failed: ${errorText(error)}`);
		}

		await step("health");
		const reason = await waitForHealth(version, deps);
		if (reason !== null) throw new AfterSwap(reason);
	} catch (error) {
		const reason = errorText(error);
		if (!swapped || error instanceof BeforeSwap) return finish(false, reason, manifest);
		await step("rollback").catch(() => undefined);
		const outcome = await rollBack(old, backupPath, deps, serviceEnv);
		return finish(false, `${reason}; ${outcome}`, manifest);
	}

	let note = `updated to ${version}`;
	try {
		await prune(layout, version);
	} catch (error) {
		note = `${note} (pruning old versions failed: ${errorText(error)})`;
	}
	if (deps.plugin !== undefined) {
		log("step plugin");
		try {
			await deps.plugin(layout.versionBinary(version));
		} catch (error) {
			note = `${note} (the omp plugin was not refreshed: ${errorText(error)}; run omp-cloud setup to retry)`;
		}
	}
	return finish(true, note, manifest);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Polls the service's health until it reports `version`; null when it did, else the reason. */
async function waitForHealth(version: string, deps: ApplyDeps): Promise<string | null> {
	const fetcher = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? Bun.sleep;
	const now = deps.now ?? Date.now;
	const deadline = now() + (deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
	let last = "no answer";
	for (;;) {
		try {
			const response = await fetcher(`${deps.healthBase}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
			if (response.ok) {
				const body: unknown = await response.json();
				const seen = typeof body === "object" && body !== null && "version" in body ? body.version : undefined;
				if (seen === version) return null;
				last = `it reports ${typeof seen === "string" ? seen : "no version"}`;
			} else {
				await response.body?.cancel();
				last = `it answers ${response.status}`;
			}
		} catch (error) {
			last = errorText(error);
		}
		if (now() >= deadline) return `the service did not report ${version} within ${(deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS) / 1000} s (${last})`;
		await sleep(HEALTH_POLL_MS);
	}
}

/** Starts or restarts the service unit; a transient unit that is gone (a crash of the new binary unloaded it) is recreated when the deps know how. */
async function bringUp(deps: ApplyDeps, how: "restart" | "start", env: Record<string, string>): Promise<void> {
	const { units, serviceUnit } = deps;
	try {
		await (how === "restart" ? units.restart(serviceUnit) : units.start(serviceUnit));
	} catch (error) {
		const recreate = deps.recreateService;
		const gone = recreate !== undefined && !(await units.isActive(serviceUnit)) && (await units.property(serviceUnit, "FragmentPath").catch(() => "x")) === "";
		if (recreate === undefined || !gone) throw error;
		await recreate(env);
	}
}

/** Points back at `old`, restores the backup when there is one (the service stopped meanwhile) and restarts. Returns what came of it. */
async function rollBack(old: string, backup: string, deps: ApplyDeps, env: Record<string, string>): Promise<string> {
	const { layout, units, serviceUnit } = deps;
	try {
		if (backup !== "") {
			// A unit that already ended has nothing to stop.
			await units.stop(serviceUnit).catch(async (error: unknown) => {
				if (await units.isActive(serviceUnit)) throw error;
			});
			await swapLink(layout, old);
			try {
				await deps.restore(backup);
			} catch (error) {
				await bringUp(deps, "start", env).catch(() => undefined);
				return `rolled back to ${old}, but restoring the database from ${backup} failed: ${errorText(error)}`;
			}
			await bringUp(deps, "start", env);
		} else {
			await swapLink(layout, old);
			await bringUp(deps, "restart", env);
		}
	} catch (error) {
		return `rolling back to ${old} failed: ${errorText(error)}`;
	}
	const reason = await waitForHealth(old, deps);
	return reason === null ? `rolled back to ${old}` : `rolled back to ${old}, which did not come up: ${reason}`;
}
