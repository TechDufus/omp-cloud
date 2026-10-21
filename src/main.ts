import { LoginManager } from "./auth/login";
import { type Config, loadConfig, resolveConfigPath } from "./config";
import { GatewayClients } from "./gateway/clients";
import { GatewayModels } from "./gateway/models";
import { GitService } from "./git";
import { credentialExecutable } from "./git/executable";
import { type HostOmp, hostOmp } from "./omp-version";
import { Runner } from "./runner";
import { serviceClientName } from "./runner/thread";
import { createApp } from "./server/app";
import { createDashboardServer, dashboardOrigin, dashboardUpstream } from "./dashboard/server";
import { openRemote } from "./pairing/remote";
import { serveRemote } from "./server/remote";
import { directModelIds } from "./server/model-ids";
import { serveDashboard } from "./dashboard/serve";
import { handOffSessions, HANDOFF_FILE, importSessionHandoff } from "./dashboard/handoff";
import { DashboardSessions } from "./dashboard/session";
import { MAX_CREATE_BODY_BYTES } from "./server/limits";
import { Settings } from "./settings";
import { join } from "node:path";
import { Store } from "./store";
import { Vmon } from "./vmon";
import { MIGRATIONS } from "./store/schema";
import { createUpdateService, openUpdateContext } from "./update/real";
import type { UpdateService } from "./update/service";
import { OWNER } from "./server/auth";

/** The config path: `--config <path>`, else `OMP_CLOUD_CONFIG`, else the default. */
function configPath(args: readonly string[]): string {
	let fromFlag: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--config") throw new Error(`unknown argument ${JSON.stringify(args[i])}`);
		fromFlag = args[++i];
		if (fromFlag === undefined || fromFlag === "") throw new Error("--config needs a path");
	}
	return resolveConfigPath(fromFlag);
}

/** Logs the programs the service will run: the omp, the git, and the first word of each git host's credential command (never the rest of it). */
async function logExecutables(config: Config, omp: HostOmp): Promise<void> {
	console.log(`omp-cloud: omp ${omp.path} (${omp.version})`);
	const git = Bun.which("git");
	if (git === null) console.warn("omp-cloud: warning: git is not on the service PATH");
	else console.log(`omp-cloud: git ${git}`);
	for (const [host, entry] of Object.entries(config.git.hosts)) {
		const found = await credentialExecutable(entry.credential, process.env.PATH);
		if ("path" in found) console.log(`omp-cloud: git host ${host}: credential command runs ${found.path}`);
		else console.warn(`omp-cloud: warning: git host ${host}: ${found.warning}`);
	}
}

/** `<scheme>://<host>:<port>`, an IPv6 host in brackets. */
function listenUrl(scheme: "http" | "https", hostname: string, port: number | undefined): string {
	return `${scheme}://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

/** Runs the service until a signal stops it; `args` are the command line after the program name (`--config <path>`). */
export async function serve(args: readonly string[]): Promise<void> {
	const config = await loadConfig(configPath(args));
	// Before anything starts: a key others can read, a bad certificate or an unresolvable gateway stops the service here.
	const remote = config.remote === undefined ? undefined : await openRemote(config.remote, config.gateway.url);
	const omp = await hostOmp();
	const ompVersion = omp.version;
	await logExecutables(config, omp);
	const store = Store.open({ dataDir: config.dataDir });
	const settings = Settings.load(store);
	const dashboardUrl = config.dashboard === undefined ? "" : dashboardOrigin(config.dashboard);
	/** Every listener that is up, with the line that says so: stopped together on a failed start and on shutdown. */
	const listeners: { server: Bun.Server<undefined>; log: string }[] = [];
	let runner: Runner | undefined;
	let vmon: Vmon | undefined;
	let update: UpdateService | undefined;
	const gateway = new GatewayClients({ file: config.gateway.clientsFile, url: config.gateway.url });
	const models = new GatewayModels({ clients: gateway, url: config.gateway.url, clientName: serviceClientName(store.serviceId()) });
	const logins = new LoginManager({ brokerUrl: config.broker.url, brokerTokenFile: config.broker.tokenFile });
	const dashboardSessions = new DashboardSessions({ secure: config.dashboard?.url?.startsWith("https:") ?? false });
	const handoffPath = join(config.dataDir, HANDOFF_FILE);
	try {
		const orphans = await store.sweepOrphanBlobs();
		if (orphans > 0) console.log(`omp-cloud: removed ${orphans} orphaned thread director${orphans === 1 ? "y" : "ies"}`);
		const git = await GitService.open({
			dataDir: config.dataDir,
			hosts: config.git.hosts,
			fetchTimeoutSeconds: config.git.fetchTimeoutSeconds,
			pushTimeoutSeconds: config.git.pushTimeoutSeconds,
		});
		store.subscribeAll({
			event: () => {},
			// The thread's refs leave the git cache with it; a failure only leaves garbage for the next collection.
			deleted: threadId => {
				git.forget(threadId).catch((error: unknown) => {
					console.error(`omp-cloud: dropping the git refs of thread ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			},
		});
		await models.start();
		if (config.runner.enabled) {
			vmon = await Vmon.open(config.vmon);
			runner = await Runner.start({ store, vmon, gateway, models, config, settings, git, ompVersion });
		} else if (config.dashboard) {
			// The dashboard's VMs page only reads vmon (the sandbox list and metrics), so it gets a client without the runner.
			try {
				vmon = await Vmon.open(config.vmon);
			} catch (error) {
				console.error(`omp-cloud: the dashboard's VMs page shows stored records only: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const handedOver = await importSessionHandoff(handoffPath, dashboardSessions);
		if (handedOver > 0) console.log(`omp-cloud: ${handedOver} dashboard session${handedOver === 1 ? "" : "s"} carried over the update restart`);
		update = await createUpdateService({
			context: await openUpdateContext(config, configPath(args)),
			settings: () => ({
				mode: settings.get("update.mode"),
				feed: settings.get("update.feed"),
				token: settings.get("update.token"),
				unit: settings.get("update.unit"),
				ompUnits: [...settings.get("update.ompUnits")],
			}),
			busyThreads: () => {
				const threads = store.countThreads(OWNER);
				return threads.starting + threads.working + threads.waiting;
			},
			ompVersion,
			schema: MIGRATIONS.length,
		});
		const app = createApp({
			store,
			apiTokenSha256: config.apiTokenSha256,
			dataDir: config.dataDir,
			models: { default: config.models.default, direct: Object.keys(config.models.direct), gateway: models },
			modelIds: () => [...new Set([...models.modelIds(), ...directModelIds(config.models.direct)])].sort(),
			questionTimeoutSeconds: config.runner.questionTimeoutSeconds,
			ompVersion,
			logins,
			settings,
			git,
			dashboard:
				config.dashboard === undefined
					? undefined
					: { origin: dashboardUrl, upstream: dashboardUpstream(config.dashboard), sessions: dashboardSessions },
			vmon,
			vmonDashboard: `${config.vmon.url}/dashboard/`,
			remote: remote?.settings,
			update,
		});
		// The dashboard binds first: when either port is taken, nothing else is left running.
		if (config.dashboard !== undefined) {
			const dashboard = serveDashboard(
				config.dashboard.listen,
				createDashboardServer({
					app,
					apiTokenSha256: config.apiTokenSha256,
					sessions: dashboardSessions,
					port: config.dashboard.listen.port,
					url: config.dashboard.url,
				}),
			);
			listeners.push({ server: dashboard, log: `omp-cloud dashboard on ${dashboardUrl}` });
		}
		const api = Bun.serve({
			hostname: config.listen.hostname,
			port: config.listen.port,
			fetch: app.fetch,
			maxRequestBodySize: MAX_CREATE_BODY_BYTES,
			idleTimeout: 120,
		});
		listeners.push({ server: api, log: `omp-cloud listening on ${listenUrl("http", config.listen.hostname, api.port)}` });
		if (remote !== undefined) {
			const tls = serveRemote(remote.settings.listen, remote.identity, app);
			listeners.push({
				server: tls,
				log: `omp-cloud remote on ${listenUrl("https", remote.settings.listen.hostname, tls.port)} (${remote.identity.fingerprint})`,
			});
		}
	} catch (error) {
		models.stop();
		logins.stop();
		await runner?.stop();
		for (const listener of listeners) await listener.server.stop(true);
		store.close();
		throw error;
	}

	for (const listener of listeners) console.log(listener.log);
	update?.start();

	let stopping = false;
	const shutdown = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		// An update restart carries the dashboard's sign-ins over (the applier has marked the restart); any other restart does not.
		await handOffSessions(handoffPath, dashboardSessions, async () => (await update?.restartingForUpdate()) === true);
		update?.stop();
		models.stop();
		logins.stop();
		await runner?.stop();
		for (const listener of listeners) await listener.server.stop(true);
		store.close();
		process.exit(0);
	};
	// omp's pi-utils (imported through the SDK) installs its own SIGINT/SIGTERM handlers that run its cleanup and exit 130/143
	// at once, racing this shutdown (which could cut the runner's stop short) and reporting a clean stop as status 143 to
	// systemd. This shutdown ends in process.exit(0), which still runs pi-utils' exit cleanup.
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.removeAllListeners(signal);
		process.on(signal, () => void shutdown());
	}
}

if (import.meta.main) {
	serve(process.argv.slice(2)).catch((error: unknown) => {
		console.error(`omp-cloud: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
