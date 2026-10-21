import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { readConnectionFile, type PairedConnection } from "./connection";
import { isRecord } from "./guards";
import { UserError } from "./types";

// omp-cloud keeps its configuration out of omp's: two YAML files of its own, read here and nowhere else. omp rewrites its own
// `config.yml` whole whenever a setting changes through it (comments, blank lines and block scalars are lost, a `!command` script
// is reflowed), so nothing a person maintains by hand belongs there.
// The personal file is `<config home>/omp-cloud/config.yml`; the repository file is `<repo root>/.omp-cloud.yml`.

export type Env = Record<string, string | undefined>;

/** Everything {@link readConfig} depends on, passed in so a test never touches the real files. */
export interface ConfigInput {
	env: Env;
	/** The user's home directory. */
	home: string;
	/** The git toplevel of the session's working directory; there is no repository file without one. */
	repoRoot: string | undefined;
	platform: NodeJS.Platform;
}

/** Where `url` and `token` came from: the environment (`OMP_CLOUD_URL`, `OMP_CLOUD_TOKEN`) or the personal file. */
export type Origin = "env" | "personal";

/** The keys of the repository file that never take effect there. */
export type IgnoredKey = "url" | "token";

/** How the user's own threads report finished turns and questions. */
export type DeliverMode = "tray" | "transcript";
/** The cloud settings of a session. */
export interface CloudConfig {
	/** `url` without trailing slashes; undefined when it is unset. */
	url: string | undefined;
	urlFrom: Origin | undefined;
	/** `token` as configured: a literal, an environment variable name or a `!command`. Never shown; {@link resolveConnection} resolves it. */
	token: string | undefined;
	tokenFrom: Origin | undefined;
	/** `url` and `token` as the repository file set them and that therefore lost: a cloned repository must not redirect handoffs or swap the token. */
	ignored: IgnoredKey[];
	/** Extension names (an entry of `<agent dir>/extensions`, or the basename of any other shipped extension) that stay on this machine. */
	excludeExtensions: string[];
	/** Files of the repository (relative paths) whose contents go to the cloud agent. */
	secretFiles: string[];
	/** Names of environment variables whose values go to the cloud agent. */
	secretEnv: string[];
	/** The policy this session asks of the cloud agent: flat keys such as `egress`, `fetch` or `spend.turnUSD`. `{}` asks for none. */
	policy: Record<string, unknown>;
	/** Where a followed thread's finished turns and questions of the user's own threads go: the inbox and a terminal notification (`tray`), or transcript cards (`transcript`). */
	deliver: DeliverMode;
	/** `personal` when the personal file set `deliver`; undefined for the default. */
	deliverFrom: Origin | undefined;
	/** The personal file's path, whether or not it exists. */
	personalFile: string;
	/** The repository file's path when it exists and was read. */
	repoFile: string | undefined;
	/** Unknown keys and values of the wrong type that were ignored; each names the file and the key, never a value. */
	warnings: string[];
	/** The user's home, for showing paths with `~`. */
	home: string;
	/** Where a paired connection lives (`connection.json` beside the personal file), whether or not it exists. */
	connectionFile: string;
}

/** Where a connection comes from: the environment, the personal file, or the pairing of this machine. */
export type ConnectionSource = Origin | "paired";

export interface Connection {
	url: string;
	token: string;
	source: ConnectionSource;
	/** The pinned certificate, addresses and device of a paired connection; undefined for a configured one. */
	paired: PairedConnection | undefined;
	/** For a paired connection: where an ignored `token` was set (`env` or the personal file); undefined when none was. */
	ignoredToken: Origin | undefined;
}

/** The settings one file holds, before the files are layered. */
interface FileSettings {
	url: string | undefined;
	token: string | undefined;
	excludeExtensions: string[];
	secretFiles: string[];
	secretEnv: string[];
	policy: Record<string, unknown>;
	deliver: DeliverMode | undefined;
	/** Which of `url` and `token` the file set, whatever their type. */
	set: IgnoredKey[];
	warnings: string[];
}

const LIST_KEYS = ["excludeExtensions", "secretFiles", "secretEnv"] as const;
const KEYS: readonly string[] = ["url", "token", "policy", "deliver", ...LIST_KEYS];

function text(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** The config directory of this host: `$XDG_CONFIG_HOME`, else `%APPDATA%` on Windows, else `<home>/.config`. */
function configHome({ env, home, platform }: ConfigInput): string {
	if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
	if (platform === "win32") return env.APPDATA || join(home, "AppData", "Roaming");
	return join(home, ".config");
}

/** `path` with the home directory written as `~`. */
export function tilde(path: string, home: string): string {
	return home !== "" && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) ? `~${path.slice(home.length)}` : path;
}

/** The mapping a file holds; undefined when the file does not exist. An empty file is an empty mapping. */
async function readMapping(path: string): Promise<Record<string, unknown> | undefined> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (e) {
		const code = e instanceof Error ? Reflect.get(e, "code") : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw new UserError(`☁ ${path} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
	}
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(source);
	} catch (e) {
		throw new UserError(`☁ ${path} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (doc === null || doc === undefined) return {};
	if (!isRecord(doc)) throw new UserError(`☁ ${path} must hold a mapping of settings at the top level`);
	return doc;
}

/**
 * Sorts one file's mapping into settings; what does not fit becomes a warning that names the file and the key. In the
 * repository file `url` and `token` are only noted in `set`: whatever they hold, they never take effect.
 */
function fileSettings(path: string, doc: Record<string, unknown>, repository: boolean): FileSettings {
	const warnings: string[] = [];
	const warn = (key: string, what: string): void => void warnings.push(`${path}: ${key} ${what}`);
	const out: FileSettings = { url: undefined, token: undefined, excludeExtensions: [], secretFiles: [], secretEnv: [], policy: {}, deliver: undefined, set: [], warnings };
	for (const [key, value] of Object.entries(doc)) {
		if (!KEYS.includes(key)) {
			warn(key, "is not a known key, ignored");
		} else if (key === "url" || key === "token") {
			out.set.push(key);
			if (repository) continue;
			if (typeof value === "string") out[key] = text(value);
			else warn(key, "is not a string, ignored");
		} else if (key === "deliver") {
			if (repository) warn(key, "is a personal setting, ignored");
			else if (value === "tray" || value === "transcript") out.deliver = value;
			else warn(key, "is not tray or transcript, ignored");
		} else if (key === "policy") {
			if (isRecord(value)) out.policy = { ...value };
			else warn(key, "is not a mapping, ignored");
		} else if (!Array.isArray(value)) {
			warn(key, "is not a list, ignored");
		} else {
			const names = value.filter((x): x is string => typeof x === "string" && x !== "");
			if (names.length !== value.length) warn(key, "has entries that are not non-empty strings, those entries are ignored");
			out[key as (typeof LIST_KEYS)[number]] = names;
		}
	}
	return out;
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/**
 * Reads the cloud settings. `OMP_CLOUD_URL` and `OMP_CLOUD_TOKEN` beat the personal file. Like omp's auth broker, the
 * cloud never takes its address or token from the repository: `url` and `token` in `.omp-cloud.yml` are ignored and
 * reported. The lists of the two files are concatenated without duplicates.
 *
 * `policy` is the exception: the repository's keys lie over the personal record one by one, because the service lets
 * a thread only tighten its policy, never loosen it.
 *
 * A file that is not YAML or whose top level is not a mapping is a {@link UserError}.
 */
export async function readConfig(input: ConfigInput): Promise<CloudConfig> {
	const personalFile = join(configHome(input), "omp-cloud", "config.yml");
	const connectionFile = join(dirname(personalFile), "connection.json");
	const personalDoc = await readMapping(personalFile);
	const personal = fileSettings(personalFile, personalDoc ?? {}, false);
	const repoPath = input.repoRoot === undefined ? undefined : join(input.repoRoot, ".omp-cloud.yml");
	const repoDoc = repoPath === undefined ? undefined : await readMapping(repoPath);
	const repo = fileSettings(repoPath ?? "", repoDoc ?? {}, true);

	const envUrl = text(input.env.OMP_CLOUD_URL);
	const envToken = text(input.env.OMP_CLOUD_TOKEN);
	const url = envUrl ?? personal.url;
	return {
		url: url?.replace(/\/+$/, ""),
		urlFrom: envUrl !== undefined ? "env" : personal.url !== undefined ? "personal" : undefined,
		token: envToken ?? personal.token,
		tokenFrom: envToken !== undefined ? "env" : personal.token !== undefined ? "personal" : undefined,
		ignored: (["url", "token"] as const).filter(key => repo.set.includes(key)),
		excludeExtensions: union(personal.excludeExtensions, repo.excludeExtensions),
		secretFiles: union(personal.secretFiles, repo.secretFiles),
		secretEnv: union(personal.secretEnv, repo.secretEnv),
		policy: { ...personal.policy, ...repo.policy },
		deliver: personal.deliver ?? "tray",
		deliverFrom: personal.deliver === undefined ? undefined : "personal",
		personalFile,
		repoFile: repoDoc === undefined ? undefined : repoPath,
		warnings: [...personal.warnings, ...repo.warnings],
		home: input.home,
		connectionFile,
	};
}

/** Where a value came from, as the user sees it: `env`, or the personal file with `~` for the home. */
function originLabel(cfg: CloudConfig, from: Origin): string {
	return from === "env" ? "env" : tilde(cfg.personalFile, cfg.home);
}

/**
 * The rows of `/cloud status` that come from the configuration, then the repository file and the warnings. A paired
 * connection shows its source, device, server fingerprint and address and says when a token was ignored; any other shows where `url`
 * and `token` came from. Never the token.
 */
export function statusLines(cfg: CloudConfig, connection?: Connection): string[] {
	const note = " · the repository's value is ignored";
	const row = (key: IgnoredKey, value: string | undefined, from: Origin | undefined, shown: string): string => {
		if (value === undefined || from === undefined) return `  ${key}: not set`;
		return `  ${key}: ${shown} (${originLabel(cfg, from)})${cfg.ignored.includes(key) ? note : ""}`;
	};
	const lines: string[] = [];
	const paired = connection?.paired;
	if (connection && paired) {
		lines.push(
			`  source: paired device (${tilde(cfg.connectionFile, cfg.home)})`,
			`  device: ${paired.device.name} (${paired.device.id.slice(0, 8)})`,
			`  server: ${paired.server.fingerprint} at ${new URL(connection.url).host}`,
		);
		if (connection.ignoredToken !== undefined) {
			const where = connection.ignoredToken === "env" ? "OMP_CLOUD_TOKEN is set" : `token in ${tilde(cfg.personalFile, cfg.home)} is set`;
			lines.push(`  ${where} and ignored: with no url configured this machine uses its paired connection (/cloud disconnect leaves it)`);
		}
	} else {
		lines.push(row("url", cfg.url, cfg.urlFrom, cfg.url ?? ""), row("token", cfg.token, cfg.tokenFrom, "set"));
	}
	lines.push(`  deliver: ${cfg.deliver} (${cfg.deliverFrom === undefined ? "default" : originLabel(cfg, cfg.deliverFrom)})`);
	if (cfg.repoFile !== undefined) lines.push(`  repository file: ${cfg.repoFile}`);
	for (const w of cfg.warnings) lines.push(`  warning: ${w}`);
	return lines;
}

/** What the user sees when the cloud is not configured, with the repository keys that were ignored. */
export function notConfigured(cfg: CloudConfig): string {
	const lines = [
		`☁ omp-cloud is not configured: set url and token in ${tilde(cfg.personalFile, cfg.home)} (for example token: "!cat ~/.config/omp-cloud/service.token"), or OMP_CLOUD_URL and OMP_CLOUD_TOKEN; or pair this machine with /cloud connect <code>`,
	];
	for (const key of cfg.ignored) lines.push(`  ${key} in ${cfg.repoFile} is ignored: a repository never redirects the cloud or supplies its token`);
	return lines.join("\n");
}

/** Whether `url` is a loopback address, the only place plain http may point. */
function isLoopbackUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** `url` as the user configured it, which must be https or loopback http: a bearer token never crosses a network in the clear. */
function checkConfiguredUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new UserError("☁ url is not a valid URL (for example https://cloud.example:8443)");
	}
	if (parsed.protocol === "http:" && !isLoopbackUrl(parsed)) {
		throw new UserError(`☁ url ${url} is plain http to another machine, which would send the token in the clear; use https, or pair this machine with /cloud connect`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new UserError("☁ url must start with https:// (or http:// on this machine)");
}

/**
 * The service address and its credential, from one source, never mixed. `OMP_CLOUD_URL`, else the personal file's `url`,
 * decides: the token is then `OMP_CLOUD_TOKEN`, else the file's `token`, through omp's `resolveConfigValue` (`!command`,
 * environment variable name or literal). With no url at all, the paired connection (`connection.json`) is used whole: its
 * pinned certificate, addresses and device token. A token from the environment or the file is then ignored, and says so.
 * A connection file that does not validate is an error, never a fallback.
 */
export async function resolveConnection(cfg: CloudConfig): Promise<Connection> {
	if (cfg.url === undefined) {
		const paired = await readConnectionFile(cfg.connectionFile);
		const address = paired?.server.addresses[0];
		if (!paired || address === undefined) throw new UserError(notConfigured(cfg));
		return { url: `https://${address}`, token: paired.token, source: "paired", paired, ignoredToken: cfg.tokenFrom };
	}
	if (!cfg.token || cfg.urlFrom === undefined) throw new UserError(notConfigured(cfg));
	checkConfiguredUrl(cfg.url);
	// omp's `resolveConfigValue` runs a `!command` with `/bin/sh -c` (omp's embedded shell on Windows) under a 10 s limit, caches a success for the process and retries a failure after 30 s.
	const token = text(await resolveConfigValue(cfg.token));
	if (!token) {
		const from = cfg.tokenFrom === undefined ? "" : ` (${originLabel(cfg, cfg.tokenFrom)})`;
		throw new UserError(`☁ token${from} resolved to nothing; if it is a !command, run it by hand to see why it prints no token`);
	}
	return { url: cfg.url, token, source: cfg.urlFrom, paired: undefined, ignoredToken: undefined };
}
