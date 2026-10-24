/** Where `omp-cloud setup` puts things, and (below) the user part's config files. */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parseConfig, TEAM_SLUG } from "../config";
import { GatewayClients } from "../gateway/clients";
import { isRecord } from "../guards";
import { defaultAppDir } from "../update/layout";
import type { StepResult } from "./steps";

/** The only host address the VMs can reach (the dummy link `ompsvc0`): the gateway binds it and `vmon` lets sandboxes reach it. */
export const SERVICE_IP = "10.254.254.1";

/** The vibemon team a new host gets (the root part's default too). */
export const DEFAULT_TEAM = "omp-cloud";

/** Every path the user part reads or writes. */
export interface SetupPaths {
	home: string;
	/** The login name (what the root part writes into the sudoers rule). */
	user: string;
	/** `~/.config/omp-cloud` (0700). */
	configDir: string;
	serviceJson: string;
	serviceToken: string;
	/** The bare vmon team key (0600). */
	vmonKey: string;
	/** The bare vibemon admin token (0600): the service reads the cluster's capacity with it. */
	vmonAdminToken: string;
	/** The bare vibemon cluster secret (0600), only on a server that takes other vibemon machines. */
	vmonClusterSecret: string;
	/** The dev gateway client's token (checkout mode only). */
	gatewayClientToken: string;
	tlsDir: string;
	/** `~/.local/share/omp-cloud/auth-home` (0700): the broker vault and `clients.json`. */
	authHome: string;
	clientsFile: string;
	/** The service's data directory, `~/.local/share/omp-cloud/service`. */
	dataDir: string;
	/** Where the user manager reads unit files: `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. */
	unitDir: string;
	/** `~/.local/bin`, where `omp-cloud` is linked for the shell. */
	binDir: string;
	/** The managed install (`OMP_CLOUD_APP_DIR`, default `~/.local/share/omp-cloud/app`). */
	appDir: string;
}

/** The paths for the current user; `env` and `user` are parameters so a test lives entirely in a temp directory. */
export function setupPaths(env: Record<string, string | undefined> = process.env, user: string = userInfo().username): SetupPaths {
	const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
	const configDir = join(home, ".config", "omp-cloud");
	const authHome = join(home, ".local", "share", "omp-cloud", "auth-home");
	const xdgConfig = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(home, ".config");
	return {
		home,
		user,
		configDir,
		serviceJson: join(configDir, "service.json"),
		serviceToken: join(configDir, "service.token"),
		vmonKey: join(configDir, "vmon.key"),
		vmonAdminToken: join(configDir, "vmon-admin.token"),
		vmonClusterSecret: join(configDir, "vmon-cluster.secret"),
		gatewayClientToken: join(configDir, "gateway-client.token"),
		tlsDir: join(configDir, "tls"),
		authHome,
		clientsFile: join(authHome, "clients.json"),
		dataDir: join(home, ".local", "share", "omp-cloud", "service"),
		unitDir: join(xdgConfig, "systemd", "user"),
		binDir: join(home, ".local", "bin"),
		appDir: defaultAppDir({ ...env, HOME: home }),
	};
}

const BROKER_URL = "http://127.0.0.1:8765";
const DASHBOARD_LISTEN = "127.0.0.1:8081";
const REMOTE_LISTEN = "0.0.0.0:8443";
/** The MCP proxy listens on the gateway's address, the only one the VMs reach. */
const MCP_LISTEN = `${SERVICE_IP}:4100`;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const DEV_CLIENT = "omp-cloud-dev";

/** Writes `text` beside `path` and renames it into place, so a reader never sees half of it; the mode is set before the rename. */
export async function writeFileAtomic(path: string, text: string, mode: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		await writeFile(temp, text, { mode });
		await chmod(temp, mode);
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

async function readIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return null;
		throw error;
	}
}

/** `~/.config/omp-cloud` and the broker's auth home, both 0700 (modes of existing directories are repaired). */
export async function ensureDirs(paths: SetupPaths): Promise<StepResult> {
	const repaired: string[] = [];
	for (const dir of [paths.configDir, paths.authHome]) {
		const before = await stat(dir).then((info) => info.mode & 0o777, () => null);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700);
		if (before !== 0o700) repaired.push(dir);
	}
	return {
		id: "config.dirs",
		status: repaired.length > 0 ? "changed" : "ok",
		detail: repaired.length > 0 ? `${repaired.join(" and ")} created or made private (0700)` : `${paths.configDir} and ${paths.authHome} are private (0700)`,
	};
}

/** A 64-hex token (32 random bytes). */
export function newToken(): string {
	return randomBytes(32).toString("hex");
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The service.json a new install gets: listeners, paths, broker, gateway, models and `vmon.team`. A server that takes
 * other vibemon machines (`clusterAddress`) also gets `vmon.clusterAddress` and `vmon.clusterSecretFile`.
 * `apiTokenSha256` is the digest of the token text in `service.token`.
 */
export function defaultServiceConfig(paths: SetupPaths, apiTokenSha256: string, team: string, clusterAddress: string | null = null): Record<string, unknown> {
	return {
		listen: "127.0.0.1:8080",
		apiTokenSha256,
		dataDir: paths.dataDir,
		vmon: {
			url: "http://127.0.0.1:3000",
			keyFile: paths.vmonKey,
			adminTokenFile: paths.vmonAdminToken,
			template: "omp-agent",
			team,
			...(clusterAddress === null ? {} : { clusterAddress, clusterSecretFile: paths.vmonClusterSecret }),
		},
		gateway: { url: `http://${SERVICE_IP}:4000`, clientsFile: paths.clientsFile },
		broker: { url: BROKER_URL, tokenFile: join(paths.authHome, ".omp", "auth-broker.token") },
		dashboard: { listen: DASHBOARD_LISTEN },
		remote: { listen: REMOTE_LISTEN, certFile: join(paths.tlsDir, "cert.pem"), keyFile: join(paths.tlsDir, "key.pem") },
		mcp: { listen: MCP_LISTEN },
		models: { default: DEFAULT_MODEL },
	};
}

/**
 * The migrations applied to an existing service.json: the `broker`, `dashboard`, `remote` and `mcp` sections and
 * `vmon.adminTokenFile` are added when missing. Returns the new document and what changed (empty: nothing to migrate); the
 * input is not modified.
 */
export function migrateServiceConfig(raw: Record<string, unknown>, paths: SetupPaths): { config: Record<string, unknown>; notes: string[] } {
	const config: Record<string, unknown> = { ...raw };
	const notes: string[] = [];
	if (!("broker" in config)) {
		config.broker = { url: BROKER_URL, tokenFile: join(paths.authHome, ".omp", "auth-broker.token") };
		notes.push("broker section added");
	}
	if (!("dashboard" in config)) {
		config.dashboard = { listen: DASHBOARD_LISTEN };
		notes.push("dashboard section added");
	}
	if (!("remote" in config)) {
		config.remote = { listen: REMOTE_LISTEN, certFile: join(paths.tlsDir, "cert.pem"), keyFile: join(paths.tlsDir, "key.pem") };
		notes.push("remote section added");
	}
	if (!("mcp" in config)) {
		config.mcp = { listen: MCP_LISTEN };
		notes.push("mcp section added");
	}
	if (isRecord(config.vmon) && !("adminTokenFile" in config.vmon)) {
		config.vmon = { ...config.vmon, adminTokenFile: paths.vmonAdminToken };
		notes.push("vmon.adminTokenFile added");
	}
	return { config, notes };
}

export interface ServiceConfigOutcome {
	steps: StepResult[];
	/** The token written now (a new service.json); null when the file already existed. Never put it in a step. */
	createdToken: string | null;
}

/**
 * `service.json` (0600) and `service.token` (0600): written once, with `vmon.team` set to `team` and, for a server that takes
 * other vibemon machines, `vmon.clusterAddress` and `vmon.clusterSecretFile` (removed again when `clusterAddress` is null).
 * An existing file is migrated in place (see `migrateServiceConfig`) and has `vmon.team` set when it differs; a file
 * `parseConfig` refuses is reported and left alone. Rewrites nothing when nothing changes.
 */
export async function ensureServiceConfig(paths: SetupPaths, team: string, clusterAddress: string | null = null): Promise<ServiceConfigOutcome> {
	if (!TEAM_SLUG.test(team)) throw new Error(`not a team slug: ${team}`);
	const text = await readIfExists(paths.serviceJson);
	if (text === null) {
		const token = newToken();
		await writeFileAtomic(paths.serviceToken, token, 0o600);
		await writeFileAtomic(paths.serviceJson, `${JSON.stringify(defaultServiceConfig(paths, sha256Hex(token), team, clusterAddress), null, 2)}\n`, 0o600);
		return {
			steps: [
				{ id: "config.token", status: "changed", detail: `API token written to ${paths.serviceToken}; keep it in a password manager and delete the file if you like (service.json holds only its SHA-256)` },
				{ id: "config.service", status: "changed", detail: `service config written to ${paths.serviceJson} (team ${team})` },
			],
			createdToken: token,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { steps: [invalidConfig(paths, "is not valid JSON")], createdToken: null };
	}
	if (!isRecord(raw)) return { steps: [invalidConfig(paths, "is not a JSON object")], createdToken: null };
	const migrated = migrateServiceConfig(raw, paths);
	const vmon = migrated.config.vmon;
	if (isRecord(vmon) && vmon.team !== team) {
		migrated.config.vmon = { ...vmon, team };
		migrated.notes.push(`vmon.team set to ${team}`);
	}
	if (isRecord(migrated.config.vmon)) {
		const { clusterAddress: oldAddress, clusterSecretFile: oldFile, ...vmonRest } = migrated.config.vmon;
		if (clusterAddress === null && (oldAddress !== undefined || oldFile !== undefined)) {
			migrated.config.vmon = vmonRest;
			migrated.notes.push("vmon.clusterAddress and vmon.clusterSecretFile removed");
		} else if (clusterAddress !== null && (oldAddress !== clusterAddress || oldFile !== paths.vmonClusterSecret)) {
			migrated.config.vmon = { ...vmonRest, clusterAddress, clusterSecretFile: paths.vmonClusterSecret };
			migrated.notes.push(`vmon.clusterAddress set to ${clusterAddress}`);
		}
	}
	try {
		parseConfig(migrated.config);
	} catch (error) {
		return { steps: [invalidConfig(paths, `is invalid: ${error instanceof Error ? error.message : String(error)}`)], createdToken: null };
	}
	if (migrated.notes.length === 0) return { steps: [{ id: "config.service", status: "ok", detail: `${paths.serviceJson} is current (team ${team})` }], createdToken: null };
	await writeFileAtomic(paths.serviceJson, `${JSON.stringify(migrated.config, null, 2)}\n`, 0o600);
	return { steps: [{ id: "config.service", status: "changed", detail: `${paths.serviceJson} migrated: ${migrated.notes.join("; ")}` }], createdToken: null };
}

function invalidConfig(paths: SetupPaths, problem: string): StepResult {
	return {
		id: "config.service",
		status: "failed",
		detail: `${paths.serviceJson} ${problem}`,
		fix: `fix the file, or move it aside (mv ${paths.serviceJson} ${paths.serviceJson}.bak) and run omp-cloud setup again`,
	};
}

/** The team slug recorded in service.json (`vmon.team`); null when the file is absent, unreadable or has none. */
export async function recordedTeam(paths: SetupPaths): Promise<string | null> {
	try {
		const raw: unknown = JSON.parse((await readIfExists(paths.serviceJson)) ?? "null");
		const vmon = isRecord(raw) ? raw.vmon : undefined;
		return isRecord(vmon) && typeof vmon.team === "string" ? vmon.team : null;
	} catch {
		return null;
	}
}

/** The LAN address this server takes other vibemon machines on (`vmon.clusterAddress` of service.json); null when it takes none or the file is absent or unreadable. A rerun of setup keeps this mode. */
export async function recordedClusterAddress(paths: SetupPaths): Promise<string | null> {
	try {
		const raw: unknown = JSON.parse((await readIfExists(paths.serviceJson)) ?? "null");
		const vmon = isRecord(raw) ? raw.vmon : undefined;
		return isRecord(vmon) && typeof vmon.clusterAddress === "string" ? vmon.clusterAddress : null;
	} catch {
		return null;
	}
}

/** The team key in vmon.key (trimmed); null when missing or empty. */
export async function readVmonKey(paths: SetupPaths): Promise<string | null> {
	const key = ((await readIfExists(paths.vmonKey)) ?? "").trim();
	return key === "" ? null : key;
}

/** Writes the bare key atomically, 0600, no newline. */
export async function writeVmonKey(paths: SetupPaths, key: string): Promise<void> {
	await writeFileAtomic(paths.vmonKey, key, 0o600);
}

/**
 * The vibemon admin token as a bare 0600 file the service reads cluster capacity with. Without a token (`/etc/vmon/env` held
 * none) the step is skipped. The token is never in the step's text.
 */
export async function ensureAdminToken(paths: SetupPaths, token: string | undefined): Promise<StepResult> {
	if (token === undefined) return { id: "config.admin", status: "skipped", detail: "/etc/vmon/env holds no VMON_ADMIN_TOKEN: capacity stays hidden" };
	const detail = `the vibemon admin token is in ${paths.vmonAdminToken}; the service reads the cluster's capacity with it`;
	if (((await readIfExists(paths.vmonAdminToken)) ?? "").trim() === token) return { id: "config.admin", status: "ok", detail };
	await writeFileAtomic(paths.vmonAdminToken, token, 0o600);
	return { id: "config.admin", status: "changed", detail };
}

/**
 * The vibemon cluster secret as a bare 0600 file, only on a server that takes other vibemon machines (`node-join-info` hands
 * it to a machine that joins). Out of cluster mode the file is deleted. Null when there is nothing to say: no cluster and no
 * file. The secret is never in the step's text.
 */
export async function ensureClusterSecret(paths: SetupPaths, clusterAddress: string | null, secret: string | undefined): Promise<StepResult | null> {
	if (clusterAddress === null) {
		if ((await readIfExists(paths.vmonClusterSecret)) === null) return null;
		await rm(paths.vmonClusterSecret, { force: true });
		return { id: "config.cluster", status: "changed", detail: `${paths.vmonClusterSecret} removed: this server takes no other vibemon machines` };
	}
	if (secret === undefined) return { id: "config.cluster", status: "failed", detail: "the root part reported no vibemon cluster secret", fix: "omp-cloud setup" };
	const detail = `the vibemon cluster secret is in ${paths.vmonClusterSecret}; machines that join read it through omp-cloud node-join-info`;
	if (((await readIfExists(paths.vmonClusterSecret)) ?? "").trim() === secret) return { id: "config.cluster", status: "ok", detail };
	await writeFileAtomic(paths.vmonClusterSecret, secret, 0o600);
	return { id: "config.cluster", status: "changed", detail };
}

/**
 * The gateway's clients file. The file must exist for the gateway to start, and it is written only through `GatewayClients`
 * (the service adds one entry per thread). `dev` is checkout mode: the dev client `omp-cloud-dev` with its token in
 * `gateway-client.token`, issued once.
 */
export async function ensureGatewayClients(paths: SetupPaths, dev: boolean): Promise<StepResult[]> {
	const clients = new GatewayClients({ file: paths.clientsFile, url: `http://${SERVICE_IP}:4000` });
	const steps: StepResult[] = [];
	if (await readIfExists(paths.clientsFile) === null) {
		await clients.issue("omp-cloud-setup");
		await clients.revoke("omp-cloud-setup");
		steps.push({ id: "config.clients", status: "changed", detail: `${paths.clientsFile} created` });
	}
	// Parsing the file makes one that is not valid fail setup rather than pass as in place: the gateway revokes every client on a bad file.
	const names = await clients.names();
	if (!dev) return steps.length > 0 ? steps : [{ id: "config.clients", status: "ok", detail: `${paths.clientsFile} is in place` }];
	const token = ((await readIfExists(paths.gatewayClientToken)) ?? "").trim();
	if (token !== "" && names.includes(DEV_CLIENT)) {
		steps.push({ id: "config.dev-client", status: "ok", detail: `gateway client ${DEV_CLIENT} exists` });
		return steps;
	}
	await writeFileAtomic(paths.gatewayClientToken, await clients.issue(DEV_CLIENT), 0o600);
	steps.push({ id: "config.dev-client", status: "changed", detail: `gateway client ${DEV_CLIENT} issued (token in ${paths.gatewayClientToken})` });
	return steps;
}
