import { backup } from "../backup";
import type { Config } from "../config";
import { hostOmp } from "../omp-version";
import { refreshPluginFrom } from "../setup/plugin";
import { installedVmonVersion, runVmonHelper, VMON_PIN, vmonHelper } from "../vmon/pin";
import { BUILD, SERVICE_VERSION } from "../version";
import type { ApplyDeps } from "./apply";
import { readSchemaVersion, readUpdateSettings, restoreDatabase, type UpdateSettings } from "./db";
import { AppLayout, defaultAppDir, managedVersion } from "./layout";
import { hostArch } from "./manifest";
import { UpdateService } from "./service";
import { StateStore } from "./state";
import { runCommand, Units, type VmonTools } from "./system";
import { tokenResolver } from "./token";

/** vibemon through `src/vmon/pin.ts`. */
export const realVmon: VmonTools = {
	pin: VMON_PIN,
	installed: () => installedVmonVersion(),
	helper: vmonHelper,
	install: runVmonHelper,
};

/** What every updater process needs to know about where it runs. */
export interface UpdateContext {
	config: Config;
	configPath: string;
	layout: AppLayout;
	/** The process runs from `<app>/versions/`. */
	managed: boolean;
	state: StateStore;
}

export async function openUpdateContext(config: Config, configPath: string, env: Record<string, string | undefined> = process.env): Promise<UpdateContext> {
	const layout = new AppLayout(defaultAppDir(env));
	return {
		config,
		configPath,
		layout,
		managed: (await managedVersion(layout, process.execPath)) !== null,
		state: new StateStore(layout.stateFile, layout.lockFile),
	};
}

/** `http://<host>:<port>` of the loopback API; a wildcard bind is reached on 127.0.0.1. */
export function healthBase(listen: Config["listen"]): string {
	const host = listen.hostname === "0.0.0.0" || listen.hostname === "::" || listen.hostname === "" ? "127.0.0.1" : listen.hostname;
	return `http://${host.includes(":") ? `[${host}]` : host}:${listen.port}`;
}

/** The service's updater: the settings come from `settings` (the live ones), threads from `busyThreads`. */
export async function createUpdateService(options: {
	context: UpdateContext;
	settings: () => UpdateSettings;
	busyThreads: () => number;
	ompVersion: string;
	schema: number;
}): Promise<UpdateService> {
	const { context } = options;
	return new UpdateService({
		layout: context.layout,
		managed: context.managed,
		current: { version: SERVICE_VERSION, build: BUILD },
		state: context.state,
		settings: options.settings,
		token: tokenResolver(),
		run: runCommand,
		vmon: realVmon,
		arch: hostArch(),
		ompHost: options.ompVersion,
		schema: options.schema,
		busyThreads: options.busyThreads,
		configPath: context.configPath,
	});
}

/** The applier's dependencies for the service described by `context` (the database is read from the file: it may be at another schema than this binary). */
export async function realApplyDeps(context: UpdateContext): Promise<ApplyDeps> {
	const { config } = context;
	const settings = readUpdateSettings(config.dataDir);
	const units = new Units(runCommand);
	return {
		layout: context.layout,
		state: context.state,
		units,
		vmon: realVmon,
		serviceUnit: settings.unit,
		ompUnits: settings.ompUnits,
		healthBase: healthBase(config.listen),
		ompHost: (await hostOmp()).version,
		schema: () => readSchemaVersion(config.dataDir),
		backup: async () => (await backup({ dataDir: config.dataDir, keep: 7 })).path,
		restore: (archive) => restoreDatabase(runCommand, archive, config.dataDir),
		// A transient service unit that ended is unloaded: start it again as install does, on the managed binary.
		recreateService: (env) =>
			units.runTransient(settings.unit, [context.layout.binLink, "serve", "--config", context.configPath], {
				collect: false,
				properties: ["Description=omp-cloud service"],
				env: { ...env, OMP_CLOUD_APP_DIR: context.layout.dir },
			}),
		plugin: refreshPluginFrom,
	};
}
