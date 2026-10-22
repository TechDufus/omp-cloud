import { isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isRecord } from "./guards";
import { parseCidr } from "./pairing/cidr";
import { hostPort } from "./pairing/remote";

/** The dashboard's own listener: plain HTTP, loopback only. */
export interface DashboardConfig {
	listen: { hostname: string; port: number };
	/** The origin browsers use to reach the listener, without a trailing slash; absent means `http://<listen>`. */
	url?: string;
}

export interface ModelsConfig {
	/** `provider/id` used when a thread names no model. Its provider must be in `direct` or served by the gateway. */
	default: string;
	/** Keyless providers written into every VM's models.yml as given (omp provider objects). */
	direct: Record<string, Record<string, unknown>>;
}

export interface RunnerConfig {
	/** False runs the API without starting VMs: threads stay queued. */
	enabled: boolean;
	/** Pause a VM after this long with nothing queued or running. */
	idleTimeoutSeconds: number;
	/** Abort a turn that runs longer than this, not counting time a question is open. */
	turnTimeoutSeconds: number;
	/** Answer an unanswered question with a note to proceed after this long. */
	questionTimeoutSeconds: number;
	/** The sandbox expiry (vmon pauses it then), refreshed while the VM works. At most 86400. */
	sandboxTimeoutSeconds: number;
	/** How often the archive and orphan sweep runs. */
	lifecycleSweepSeconds: number;
}

/** One git host the service holds a credential for. */
export interface GitHostConfig {
	/** A `!command` secret reference whose output is the token; never the token itself. */
	credential: string;
	/** The Basic-auth user name git sends with the token. */
	username: string;
}

export interface GitConfig {
	/** Keyed by the remote URL's `host`, with `:port` when it names one (`github.com`, `git.example:8443`). */
	hosts: Record<string, GitHostConfig>;
	/** Each network git call of a base fetch stops after this long. */
	fetchTimeoutSeconds: number;
	/** The push of a result stops after this long. */
	pushTimeoutSeconds: number;
}

const GIT_DEFAULT_FETCH_TIMEOUT_SECONDS = 120;
const GIT_DEFAULT_PUSH_TIMEOUT_SECONDS = 120;
const GIT_DEFAULT_USERNAME = "x-access-token";

/** The remote listener: TLS with the service's own certificate, device tokens only. */
export interface RemoteConfig {
	listen: { hostname: string; port: number };
	/** Absolute. One certificate in PEM. */
	certFile: string;
	/** Absolute. Mode 0600 in a 0700 directory, checked at start. */
	keyFile: string;
	/** The `host:port` entries pairing codes list; absent means the host's own addresses. */
	advertise?: string[];
	/** The CIDR ranges sources must be in; replaces the default. */
	allow: string[];
}

/** The MCP proxy listener: the VMs reach it at the gateway address, so it binds an IP literal (never a wildcard). */
export interface McpConfig {
	listen: { hostname: string; port: number };
}

/** The service configuration, validated by `parseConfig`. */
export interface Config {
	listen: { hostname: string; port: number };
	/** Lowercase hex SHA-256 of the API token. */
	apiTokenSha256: string;
	/** Absolute. */
	dataDir: string;
	/** `team` is the vibemon team's slug (setup, doctor and uninstall read it; absent on a host set up before it existed). */
	vmon: { url: string; keyFile: string; template: string; team?: string };
	gateway: { url: string; clientsFile: string };
	/** The omp auth broker that `/cloud login` signs in to. */
	broker: { url: string; tokenFile: string };
	models: ModelsConfig;
	runner: RunnerConfig;
	/** What the service may fetch from git remotes; empty hosts mean it fetches nothing. */
	git: GitConfig;
	/** The dashboard listener; absent means no dashboard. */
	dashboard?: DashboardConfig;
	/** The TLS listener other machines pair with and use; absent means loopback only. */
	remote?: RemoteConfig;
	/** The MCP proxy the VMs reach their http MCP servers through; absent means http MCP servers are not offered. */
	mcp?: McpConfig;
}

const RUNNER_DEFAULTS: RunnerConfig = {
	enabled: true,
	idleTimeoutSeconds: 600,
	turnTimeoutSeconds: 1800,
	questionTimeoutSeconds: 1800,
	sandboxTimeoutSeconds: 3600,
	lifecycleSweepSeconds: 3600,
};
/** setTimeout fires at once past 2^31-1 ms. */
const MAX_TIMER_SECONDS = 2147483;
/** vmon caps one execution at 24 hours. */
const MAX_SANDBOX_TIMEOUT_SECONDS = 86400;
/** What vibemon accepts as a team slug and omp-cloud sets up (`system` is reserved by vibemon). */
export const TEAM_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** Lower-cased keys a `direct` provider may not carry: credentials never go into a VM this way. */
const CREDENTIAL_KEYS = ["apikey", "headers", "authheader"];

/** ~/.config/omp-cloud/service.json */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "omp-cloud", "service.json");

/** The config path: the `--config` value when given, else `OMP_CLOUD_CONFIG`, else the default. */
export function resolveConfigPath(fromFlag: string | undefined): string {
	const fromEnv = process.env.OMP_CLOUD_CONFIG;
	return fromFlag ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_CONFIG_PATH);
}

/** An object at `path` holding every key of `required` and no key beyond `required` and `optional`: missing and unknown keys throw. */
function section(raw: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	if (!isRecord(raw)) throw new Error(`${path || "config"} must be an object`);
	const prefix = path === "" ? "" : `${path}.`;
	for (const key of Object.keys(raw)) {
		if (!required.includes(key) && !optional.includes(key)) throw new Error(`${prefix}${key} is not a known key`);
	}
	for (const key of required) {
		if (!(key in raw)) throw new Error(`${prefix}${key} is required`);
	}
	return raw;
}

function pathField(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
	return resolve(value);
}

function urlField(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be an http or https URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${label} must be an http or https URL`);
	}
	return value.replace(/\/+$/, "");
}

function parseListen(value: unknown, label = "listen"): Config["listen"] {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const bracketed = /^\[([^\]]+)\]:(.*)$/.exec(value);
	let hostname: string;
	let portText: string;
	if (bracketed) {
		hostname = bracketed[1] ?? "";
		portText = bracketed[2] ?? "";
	} else {
		const colon = value.lastIndexOf(":");
		if (colon < 0) throw new Error(`${label} must be host:port or [ipv6]:port`);
		hostname = value.slice(0, colon);
		portText = value.slice(colon + 1);
		if (hostname.includes(":")) throw new Error(`${label} must be host:port or [ipv6]:port`);
	}
	if (hostname === "" || /\s/.test(hostname)) throw new Error(`${label} must be host:port or [ipv6]:port`);
	if (!/^\d+$/.test(portText)) throw new Error(`${label} port must be an integer from 1 to 65535`);
	const port = Number(portText);
	if (port < 1 || port > 65535) throw new Error(`${label} port must be an integer from 1 to 65535`);
	return { hostname, port };
}

/** Hosts the plain-HTTP listeners may bind: the API's and the dashboard's sessions carry the owner's full power, so they stay on loopback; other machines use `remote`. */
const LOOPBACK_HOST = /^(localhost|::1|127(\.\d{1,3}){3})$/;

/** The sources the remote listener answers unless `remote.allow` says otherwise: private, unique-local, link-local and CGNAT ranges. Loopback is not among them. */
export const DEFAULT_REMOTE_ALLOW: readonly string[] = [
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"100.64.0.0/10",
	"169.254.0.0/16",
	"fc00::/7",
	"fe80::/10",
];

/** A non-empty array of strings, each checked by `item`; its result replaces the entry. */
function stringList(value: unknown, label: string, item: (entry: string) => string): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array of strings`);
	return value.map((entry: unknown, i) => {
		if (typeof entry !== "string") throw new Error(`${label}[${i}] must be a string`);
		return item(entry);
	});
}

function parseRemote(value: unknown): RemoteConfig | undefined {
	if (value === undefined) return undefined;
	const rec = section(value, "remote", ["listen", "certFile", "keyFile"], ["advertise", "allow"]);
	const listen = parseListen(rec.listen, "remote.listen");
	const remote: RemoteConfig = {
		listen,
		certFile: pathField(rec.certFile, "remote.certFile"),
		keyFile: pathField(rec.keyFile, "remote.keyFile"),
		allow: [...DEFAULT_REMOTE_ALLOW],
	};
	if (rec.advertise !== undefined) {
		remote.advertise = stringList(rec.advertise, "remote.advertise", entry => {
			const address = parseListen(entry, "remote.advertise entry");
			return hostPort(address.hostname, address.port);
		});
	}
	if (rec.allow !== undefined) {
		remote.allow = stringList(rec.allow, "remote.allow", entry => {
			if (parseCidr(entry) === null) throw new Error(`remote.allow entry ${JSON.stringify(entry)} is not a CIDR range such as 10.0.0.0/8`);
			return entry;
		});
	}
	return remote;
}

function parseMcp(value: unknown): McpConfig | undefined {
	if (value === undefined) return undefined;
	const rec = section(value, "mcp", ["listen"]);
	const listen = parseListen(rec.listen, "mcp.listen");
	if (isIP(listen.hostname) === 0) throw new Error("mcp.listen must be an IP address, not a host name");
	if (listen.hostname === "0.0.0.0" || listen.hostname === "::") throw new Error("mcp.listen must be a specific address, not a wildcard");
	return { listen };
}

function parseDashboard(value: unknown): DashboardConfig | undefined {
	if (value === undefined) return undefined;
	const rec = section(value, "dashboard", ["listen"], ["url"]);
	const listen = parseListen(rec.listen, "dashboard.listen");
	if (!LOOPBACK_HOST.test(listen.hostname)) throw new Error("dashboard.listen must be a loopback address");
	if (rec.url === undefined) return { listen };
	const url = urlField(rec.url, "dashboard.url");
	if (new URL(url).pathname !== "/" || url.includes("?") || url.includes("#")) throw new Error("dashboard.url must be an origin without a path");
	return { listen, url };
}

/** The first path of a credential key (`apiKey`, `headers`, `authHeader`, any case) anywhere under `value`, or null. */
function credentialKeyPath(value: unknown, path: string): string | null {
	if (Array.isArray(value)) {
		for (const [i, item] of value.entries()) {
			const found = credentialKeyPath(item, `${path}[${i}]`);
			if (found !== null) return found;
		}
	} else if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			if (CREDENTIAL_KEYS.includes(key.toLowerCase())) return `${path}.${key}`;
			const found = credentialKeyPath(item, `${path}.${key}`);
			if (found !== null) return found;
		}
	}
	return null;
}

function parseModels(value: unknown): ModelsConfig {
	const rec = section(value, "models", ["default"], ["direct"]);

	const direct: Record<string, Record<string, unknown>> = {};
	if (rec.direct !== undefined) {
		if (!isRecord(rec.direct)) throw new Error("models.direct must be an object");
		for (const [provider, config] of Object.entries(rec.direct)) {
			const label = `models.direct.${provider}`;
			if (!PROVIDER_PATTERN.test(provider)) throw new Error(`${label}: provider names must match ${PROVIDER_PATTERN.source}`);
			if (!isRecord(config)) throw new Error(`${label} must be an object`);
			const credential = credentialKeyPath(config, label);
			if (credential !== null) throw new Error(`${credential} is not allowed: direct providers must not carry credentials`);
			urlField(config.baseUrl, `${label}.baseUrl`);
			direct[provider] = config;
		}
	}

	const model = rec.default;
	if (typeof model !== "string") throw new Error("models.default must be a string");
	const slash = model.indexOf("/");
	if (slash < 1 || slash === model.length - 1 || /\s/.test(model)) throw new Error("models.default must be provider/id");
	return { default: model, direct };
}

function positiveInt(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function parseRunner(value: unknown): RunnerConfig {
	if (value === undefined) return { ...RUNNER_DEFAULTS };
	const rec = section(value, "runner", [], Object.keys(RUNNER_DEFAULTS));
	const runner = { ...RUNNER_DEFAULTS };
	if (rec.enabled !== undefined) {
		if (typeof rec.enabled !== "boolean") throw new Error("runner.enabled must be a boolean");
		runner.enabled = rec.enabled;
	}
	for (const key of ["idleTimeoutSeconds", "turnTimeoutSeconds", "questionTimeoutSeconds", "sandboxTimeoutSeconds", "lifecycleSweepSeconds"] as const) {
		if (rec[key] === undefined) continue;
		runner[key] = positiveInt(rec[key], `runner.${key}`);
		if (runner[key] > MAX_TIMER_SECONDS) throw new Error(`runner.${key} must be at most ${MAX_TIMER_SECONDS}`);
	}
	if (runner.sandboxTimeoutSeconds > MAX_SANDBOX_TIMEOUT_SECONDS) {
		throw new Error(`runner.sandboxTimeoutSeconds must be at most ${MAX_SANDBOX_TIMEOUT_SECONDS}`);
	}
	return runner;
}

/** What a `git.hosts` entry's key looks like: a lower-case host (or bracketed IPv6 address) with an optional port, as in a URL's `host`. */
const GIT_HOST_KEY = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/;

function parseGit(value: unknown): GitConfig {
	if (value === undefined) {
		return { hosts: {}, fetchTimeoutSeconds: GIT_DEFAULT_FETCH_TIMEOUT_SECONDS, pushTimeoutSeconds: GIT_DEFAULT_PUSH_TIMEOUT_SECONDS };
	}
	const rec = section(value, "git", [], ["hosts", "fetchTimeoutSeconds", "pushTimeoutSeconds"]);
	const hosts: Record<string, GitHostConfig> = {};
	if (rec.hosts !== undefined) {
		if (!isRecord(rec.hosts)) throw new Error("git.hosts must be an object");
		for (const [key, entry] of Object.entries(rec.hosts)) {
			const label = `git.hosts.${key}`;
			if (!GIT_HOST_KEY.test(key)) throw new Error(`${label} must be a lower-case host or host:port`);
			const host = section(entry, label, ["credential"], ["username"]);
			if (typeof host.credential !== "string" || !host.credential.startsWith("!") || host.credential.length < 2) {
				throw new Error(`${label}.credential must be a "!command" secret reference, never the token itself`);
			}
			const username = host.username ?? GIT_DEFAULT_USERNAME;
			if (typeof username !== "string" || !/^[\x21-\x7e]+$/.test(username)) {
				throw new Error(`${label}.username must be a non-empty string of printable characters without spaces`);
			}
			hosts[key] = { credential: host.credential, username };
		}
	}
	let fetchTimeoutSeconds = GIT_DEFAULT_FETCH_TIMEOUT_SECONDS;
	if (rec.fetchTimeoutSeconds !== undefined) {
		fetchTimeoutSeconds = positiveInt(rec.fetchTimeoutSeconds, "git.fetchTimeoutSeconds");
		if (fetchTimeoutSeconds > MAX_TIMER_SECONDS) throw new Error(`git.fetchTimeoutSeconds must be at most ${MAX_TIMER_SECONDS}`);
	}
	let pushTimeoutSeconds = GIT_DEFAULT_PUSH_TIMEOUT_SECONDS;
	if (rec.pushTimeoutSeconds !== undefined) {
		pushTimeoutSeconds = positiveInt(rec.pushTimeoutSeconds, "git.pushTimeoutSeconds");
		if (pushTimeoutSeconds > MAX_TIMER_SECONDS) throw new Error(`git.pushTimeoutSeconds must be at most ${MAX_TIMER_SECONDS}`);
	}
	return { hosts, fetchTimeoutSeconds, pushTimeoutSeconds };
}

/** Validates parsed JSON; throws an Error naming the offending field. */
export function parseConfig(raw: unknown): Config {
	const top = section(raw, "", ["listen", "apiTokenSha256", "dataDir", "vmon", "gateway", "broker", "models"], ["runner", "git", "dashboard", "remote", "mcp"]);
	const listen = parseListen(top.listen);
	if (!LOOPBACK_HOST.test(listen.hostname)) {
		throw new Error('listen must be a loopback address; other machines connect through "remote" (the TLS listener)');
	}

	const hash = top.apiTokenSha256;
	if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) {
		throw new Error("apiTokenSha256 must be 64 hex characters");
	}

	const dataDir = pathField(top.dataDir, "dataDir");

	const vmonRec = section(top.vmon, "vmon", ["url", "keyFile", "template"], ["team"]);
	const template = vmonRec.template;
	if (typeof template !== "string" || template === "" || /\s/.test(template)) {
		throw new Error("vmon.template must be a non-empty string without whitespace");
	}
	const team = vmonRec.team;
	if (team !== undefined && (typeof team !== "string" || !TEAM_SLUG.test(team))) {
		throw new Error("vmon.team must be a team slug: lowercase letters, digits and hyphens, at most 63 characters");
	}
	const vmon = {
		url: urlField(vmonRec.url, "vmon.url"),
		keyFile: pathField(vmonRec.keyFile, "vmon.keyFile"),
		template,
		...(team === undefined ? {} : { team }),
	};

	const gatewayRec = section(top.gateway, "gateway", ["url", "clientsFile"]);
	const gateway = {
		url: urlField(gatewayRec.url, "gateway.url"),
		clientsFile: pathField(gatewayRec.clientsFile, "gateway.clientsFile"),
	};

	const brokerRec = section(top.broker, "broker", ["url", "tokenFile"]);
	const broker = {
		url: urlField(brokerRec.url, "broker.url"),
		tokenFile: pathField(brokerRec.tokenFile, "broker.tokenFile"),
	};

	return {
		listen,
		apiTokenSha256: hash.toLowerCase(),
		dataDir,
		vmon,
		gateway,
		broker,
		models: parseModels(top.models),
		runner: parseRunner(top.runner),
		git: parseGit(top.git),
		dashboard: parseDashboard(top.dashboard),
		remote: parseRemote(top.remote),
		mcp: parseMcp(top.mcp),
	};
}

/** Reads the JSON file at path and parses it. Errors name the path, never the file contents. */
export async function loadConfig(path: string): Promise<Config> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
		throw new Error(`cannot read config ${path}: ${code}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`config ${path} is not valid JSON`);
	}
	try {
		return parseConfig(raw);
	} catch (error) {
		throw new Error(`invalid config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
