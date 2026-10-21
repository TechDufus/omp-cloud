import { createFeed, type Feed, FeedError, type FeedOptions } from "./feed";
import { type FeedSpec, parseFeedSpec } from "./feed-spec";
import type { UpdateSettings } from "./db";
import { type AppLayout, ensureLayout } from "./layout";
import { compareVersions, type ReleaseArch, type ReleaseManifest } from "./manifest";
import { autoDecision, CHECKOUT_MESSAGE, deriveState, applyRunning, readyRelease, type UpdateState } from "./policy";
import { isStaged, stageRelease } from "./stage";
import { emptyState, type StateStore, type UpdateStateFile } from "./state";
import { OMP_UNITS } from "./omp-units";
import { type CommandRunner, type VmonTools, Units } from "./system";

/** The transient unit the applier runs as: one at a time. */
export const APPLY_UNIT = "omp-cloud-update";
/** The first check runs this long after the service starts, then every hour. */
export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 60 * 60_000;
/** The components (vibemon, the omp units) are looked up at most this often. */
const COMPONENTS_TTL_MS = 60_000;

export interface BuildInfo {
	id: string;
	commit: string;
	createdAt: string;
}

/** An apply or check the current state does not allow; the API answers 409 with the message. */
export class UpdateConflict extends Error {
	override name = "UpdateConflict";
}

/** What `GET /api/v1/update` answers. */
export interface UpdateStatus {
	mode: UpdateSettings["mode"];
	managed: boolean;
	state: UpdateState;
	current: { version: string; build: BuildInfo };
	latest: { version: string; notes: string; publishedAt: string } | null;
	staged: string | null;
	applying: { version: string; step: string; startedAt: string } | null;
	error: string | null;
	message: string | null;
	checkedAt: string | null;
	components: {
		vmon: { installed: string | null; required: string | null; helper: boolean };
		omp: { host: string; broker: string | null; gateway: string | null };
	};
	last: { version: string; notes: string; at: string; result: "installed" | "failed"; message: string } | null;
}

export interface UpdateServiceDeps {
	layout: AppLayout;
	/** The process runs from `<app>/versions/`: false in a checkout, where updates are unsupported. */
	managed: boolean;
	current: { version: string; build: BuildInfo };
	state: StateStore;
	settings: () => UpdateSettings;
	/** The credential `update.token` stands for (a `!command`, an env name or a literal); undefined for none. */
	token: (reference: string) => Promise<string | undefined>;
	/** Test seam: the feed of a spec; defaults to `createFeed`. */
	feed?: (spec: FeedSpec, options: FeedOptions) => Feed;
	run: CommandRunner;
	vmon: VmonTools;
	arch: ReleaseArch;
	/** The omp the service itself runs with. */
	ompHost: string;
	/** The database's schema version (what the running service migrated it to). */
	schema: number;
	/** Threads starting, working or waiting now. */
	busyThreads: () => number;
	/** The service.json the applier is started with. */
	configPath: string;
	now?: () => number;
	log?: (message: string) => void;
}

/**
 * The service side of updates: the hourly check (feed, download, verification, staging), the `auto` policy, the state
 * the API shows and the start of an apply, which runs in its own process (`update apply-staged`).
 */
export class UpdateService {
	readonly #deps: UpdateServiceDeps;
	readonly #units: Units;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	#phase: "checking" | "downloading" | null = null;
	#checking: Promise<void> | null = null;
	#timer: ReturnType<typeof setInterval> | undefined;
	#nextCheckAt: number;
	#lastBusyAt: number;
	#components: { at: number; value: UpdateStatus["components"] } | null = null;
	#autoReason = "";

	constructor(deps: UpdateServiceDeps) {
		this.#deps = deps;
		this.#units = new Units(deps.run);
		this.#now = deps.now ?? Date.now;
		this.#log = deps.log ?? ((message) => console.log(`omp-cloud: ${message}`));
		this.#nextCheckAt = this.#now() + FIRST_CHECK_DELAY_MS;
		// Starting counts as busy: nothing is known of the minutes before this process began.
		this.#lastBusyAt = this.#now();
	}

	/** Starts the once-a-minute tick: busy sampling, the hourly check and the `auto` decision. */
	start(): void {
		this.#timer = setInterval(() => void this.tick(), 60_000);
		this.#timer.unref();
	}

	stop(): void {
		clearInterval(this.#timer);
	}

	/**
	 * One minute of work: samples whether threads are busy, runs the check when it is due (never when `update.mode` is
	 * off, and never from a checkout), then lets `auto` decide. Never throws.
	 */
	async tick(): Promise<void> {
		try {
			const now = this.#now();
			if (this.#deps.busyThreads() > 0) this.#lastBusyAt = now;
			const { mode } = this.#deps.settings();
			if (mode !== "off" && this.#deps.managed && now >= this.#nextCheckAt) {
				this.#nextCheckAt = now + CHECK_INTERVAL_MS;
				await this.check();
			}
			if (mode === "auto") await this.#maybeAutoApply();
		} catch (error) {
			this.#log(`update tick failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Checks the feed and downloads a newer release; resolves when done. Concurrent calls share one run. Never throws: a failure is the state's `error`. */
	check(): Promise<void> {
		this.#checking ??= this.#runCheck().finally(() => {
			this.#checking = null;
			this.#phase = null;
		});
		return this.#checking;
	}

	/** Why `auto` last did not apply, for the log and tests. */
	get autoReason(): string {
		return this.#autoReason;
	}

	async #runCheck(): Promise<void> {
		const { state, layout, managed } = this.#deps;
		if (!managed) return;
		this.#phase = "checking";
		await this.#settle();
		await state.update((file) => {
			file.error = null;
		});
		try {
			const settings = this.#deps.settings();
			const token = settings.token === "" ? undefined : await this.#deps.token(settings.token);
			const options: FeedOptions = token === undefined ? {} : { token };
			const spec = parseFeedSpec(settings.feed);
			const feed = (this.#deps.feed ?? ((s, o) => createFeed(s, o)))(spec, options);
			const release = await feed.latest();
			const { manifest } = release;
			const current = this.#deps.current.version;
			const newer = compareVersions(manifest.version, current) > 0;
			await state.update((file) => {
				file.checked = new Date(this.#now()).toISOString();
				file.latest = { manifest, publishedAt: release.publishedAt };
				if (!newer || (file.staged !== null && file.staged !== manifest.version)) file.staged = null;
			});
			if (!newer) return;
			if (!(await isStaged(layout, manifest, this.#deps.arch))) {
				this.#phase = "downloading";
				await ensureLayout(layout);
				this.#log(`downloading omp-cloud ${manifest.version}`);
				await stageRelease(layout, release, this.#deps.arch, this.#deps.run);
				this.#log(`omp-cloud ${manifest.version} is staged and verified`);
			}
			await state.update((file) => {
				file.staged = manifest.version;
			});
		} catch (error) {
			const noRelease = error instanceof FeedError && error.kind === "none";
			const message = error instanceof Error ? error.message : String(error);
			await state.update((file) => {
				file.checked = new Date(this.#now()).toISOString();
				// A release that is already staged stays applicable when a later look at the feed fails.
				if (noRelease) file.latest = null;
				else if (file.staged === null || readyRelease(file, this.#deps.current.version) === null) file.error = message;
			});
			if (!noRelease) this.#log(`update check failed: ${message}`);
		}
	}

	/** An `applying` record whose applier is gone (older than 15 minutes) becomes a failure the user can retry. */
	async #settle(): Promise<UpdateStateFile> {
		const file = await this.#deps.state.read();
		if (file.applying === null || applyRunning(file, this.#now())) return file;
		const stuck = file.applying;
		return this.#deps.state.update((next) => {
			if (next.applying?.startedAt !== stuck.startedAt) return;
			next.applying = null;
			next.error = `the update to ${stuck.version} did not finish (its step was ${stuck.step})`;
			next.last = { version: stuck.version, notes: next.latest?.manifest.notes ?? "", at: new Date(this.#now()).toISOString(), result: "failed", message: next.error };
		});
	}

	/** Applies by itself when `update.mode` is auto and the policy says it is safe. */
	async #maybeAutoApply(): Promise<void> {
		const file = await this.#settle();
		const manifest = readyRelease(file, this.#deps.current.version);
		if (manifest === null || file.applying !== null || file.error !== null || !this.#deps.managed) return;
		const now = this.#now();
		const busyThreads = this.#deps.busyThreads();
		const decision = autoDecision({
			ready: true,
			busyThreads,
			quietMs: busyThreads > 0 ? 0 : now - this.#lastBusyAt,
			vmonInstalled: await this.#deps.vmon.installed(),
			manifest,
			schema: this.#deps.schema,
		});
		this.#autoReason = decision.reason;
		if (!decision.apply) return;
		this.#log(`installing omp-cloud ${manifest.version} automatically (${decision.reason})`);
		await this.apply();
	}

	/**
	 * Starts the apply of the staged release in its own process (`systemd-run --user --unit=omp-cloud-update`, the new
	 * binary's `update apply-staged`) and returns the version. Throws `UpdateConflict` when nothing is ready, an apply is
	 * running or the install is unsupported.
	 */
	async apply(): Promise<{ version: string }> {
		const { state, layout } = this.#deps;
		if (!this.#deps.managed) throw new UpdateConflict(CHECKOUT_MESSAGE);
		const file = await this.#settle();
		if (file.applying !== null) throw new UpdateConflict(`omp-cloud ${file.applying.version} is already being installed`);
		if (this.#phase !== null) throw new UpdateConflict("a check is running; try again in a moment");
		const manifest = readyRelease(file, this.#deps.current.version);
		if (manifest === null) throw new UpdateConflict("no update is ready");
		if (!(await isStaged(layout, manifest, this.#deps.arch))) {
			throw new UpdateConflict(`the staged omp-cloud ${manifest.version} is missing or damaged; check for updates again`);
		}
		const startedAt = new Date(this.#now()).toISOString();
		await state.update((next) => {
			next.applying = { version: manifest.version, step: "starting", startedAt, from: this.#deps.current.version, backup: "" };
			next.error = null;
			next.last = null;
		});
		try {
			// The applier is the new binary started by systemd: it must find this service's app directory, not the default one.
			await this.#units.runTransient(
				APPLY_UNIT,
				[layout.versionBinary(manifest.version), "update", "apply-staged", "--version", manifest.version, "--config", this.#deps.configPath],
				{ env: { ...(await this.#units.environment(this.#deps.settings().unit)), OMP_CLOUD_APP_DIR: layout.dir } },
			);
		} catch (error) {
			await state.update((next) => {
				if (next.applying?.startedAt === startedAt) next.applying = null;
			});
			throw new UpdateConflict(`could not start the update: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { version: manifest.version };
	}

	/**
	 * Whether the restart this process is going through belongs to an update: an apply is running and has reached `swap`
	 * (the service is restarted onto the new version) or `rollback` (back onto the old one). The service asks on its way
	 * down, to hand its dashboard sessions to the next process; an ordinary restart finds no apply and says no.
	 */
	async restartingForUpdate(): Promise<boolean> {
		const { applying } = await this.#deps.state.read();
		return applying !== null && (applying.step === "swap" || applying.step === "rollback") && applyRunning({ ...emptyState(), applying }, this.#now());
	}

	/** `{state, available}` for `whoami`: `available` is the newer version a user could install or is being fetched. */
	async summary(): Promise<{ state: UpdateState; available: string | null }> {
		const file = await this.#settle();
		const state = deriveState({ managed: this.#deps.managed, file, currentVersion: this.#deps.current.version, phase: this.#phase, nowMs: this.#now() });
		const newer = file.latest !== null && compareVersions(file.latest.manifest.version, this.#deps.current.version) > 0;
		return { state, available: this.#deps.managed && newer && state !== "idle" ? (file.latest?.manifest.version ?? null) : null };
	}

	async status(): Promise<UpdateStatus> {
		const file = await this.#settle();
		const { current, managed } = this.#deps;
		const state = deriveState({ managed, file, currentVersion: current.version, phase: this.#phase, nowMs: this.#now() });
		const settings = this.#deps.settings();
		return {
			mode: settings.mode,
			managed,
			state,
			current,
			latest: file.latest === null ? null : { version: file.latest.manifest.version, notes: file.latest.manifest.notes, publishedAt: file.latest.publishedAt },
			staged: file.staged,
			applying: file.applying === null ? null : { version: file.applying.version, step: file.applying.step, startedAt: file.applying.startedAt },
			error: managed ? file.error : null,
			message: managed ? null : CHECKOUT_MESSAGE,
			checkedAt: file.checked,
			components: await this.#componentsFor(file.latest?.manifest ?? null),
			last: file.last,
		};
	}

	async #componentsFor(manifest: ReleaseManifest | null): Promise<UpdateStatus["components"]> {
		const now = this.#now();
		if (this.#components !== null && now - this.#components.at < COMPONENTS_TTL_MS) {
			return { ...this.#components.value, vmon: { ...this.#components.value.vmon, required: manifest?.requires.vmon.version ?? this.#deps.vmon.pin } };
		}
		const [installed, helper, broker, gateway] = await Promise.all([
			this.#deps.vmon.installed().catch(() => null),
			this.#deps.vmon.helper().then((found) => found.available, () => false),
			this.#units.ompVersion(OMP_UNITS[0]),
			this.#units.ompVersion(OMP_UNITS[1]),
		]);
		const value: UpdateStatus["components"] = {
			vmon: { installed, required: manifest?.requires.vmon.version ?? this.#deps.vmon.pin, helper },
			omp: { host: this.#deps.ompHost, broker, gateway },
		};
		this.#components = { at: now, value };
		return value;
	}
}
