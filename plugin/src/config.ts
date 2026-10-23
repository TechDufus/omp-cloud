import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
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
	/** The personal file's own `url` (trailing slashes removed), whether or not `OMP_CLOUD_URL` beat it: `/cloud use personal` reaches it. */
	personalUrl: string | undefined;
	/** The personal file's own `token`, as configured. */
	personalToken: string | undefined;
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
	/** The repository's environment setup from `.omp-cloud.yml`: a script the cloud runs once per environment and caches. Repository file only. */
	setup: SetupConfig | undefined;
	/** `use:` of the personal file: the cloud new sessions take unless `OMP_CLOUD_URL` is set. */
	use: DefaultCloud | undefined;
}

/** The `setup` key of a repository file: `run` is a shell script, `cacheFiles` the repository files whose contents key the cached result. */
export interface SetupConfig {
	run: string;
	/** Undefined asks the service for its default list. */
	cacheFiles: string[] | undefined;
}

const SETUP_RUN_MAX = 16384;
const SETUP_CACHE_FILES_MAX = 32;

/** Where a connection comes from: the environment, the personal file, or the pairing of this machine. */
export type ConnectionSource = Origin | "paired";

/** The clouds `use:` can make the default: `env` is decided by the environment, never by a file. */
export type DefaultCloud = "personal" | "paired";

export interface Connection {
	url: string;
	token: string;
	source: ConnectionSource;
	/** The pinned certificate, addresses and device of a paired connection; undefined for a configured one. */
	paired: PairedConnection | undefined;
	/** For a paired connection: where an ignored `token` was set (`env` or the personal file); undefined when none was. */
	ignoredToken: Origin | undefined;
	/** What a 401 from this connection's service means, for the person who has to fix it. */
	unauthorizedHint: string;
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
	use: DefaultCloud | undefined;
	/** Which of `url` and `token` the file set, whatever their type. */
	set: IgnoredKey[];
	setup: SetupConfig | undefined;
	warnings: string[];
}

const LIST_KEYS = ["excludeExtensions", "secretFiles", "secretEnv"] as const;
const KEYS: readonly string[] = ["url", "token", "use", "policy", "deliver", "setup", ...LIST_KEYS];

const PAIRED_UNAUTHORIZED = "the server refused this device's token: it was revoked, or the server was set up again; /cloud connect --replace pairs this machine again";

/** `setup` as a {@link SetupConfig}, or the reason it does not fit. */
function parseSetup(value: unknown): SetupConfig | string {
	if (!isRecord(value)) return "is not a mapping with run and cacheFiles, ignored";
	for (const key of Object.keys(value)) if (key !== "run" && key !== "cacheFiles") return `has an unknown key ${key}, ignored`;
	const run = value.run;
	if (typeof run !== "string" || run.trim() === "") return "needs run: a non-empty script, ignored";
	if (run.length > SETUP_RUN_MAX) return `run is longer than ${SETUP_RUN_MAX} characters, ignored`;
	const files = value.cacheFiles;
	if (files === undefined) return { run, cacheFiles: undefined };
	if (!Array.isArray(files) || files.length > SETUP_CACHE_FILES_MAX) return `cacheFiles must be a list of at most ${SETUP_CACHE_FILES_MAX} paths, ignored`;
	for (const file of files) {
		if (typeof file !== "string" || file === "" || file.length > 200 || file.startsWith("/") || file.split(/[\\/]/).includes("..")) {
			return "cacheFiles must hold relative repository paths, ignored";
		}
	}
	return { run, cacheFiles: [...new Set(files as string[])] };
}

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
	const out: FileSettings = { url: undefined, token: undefined, excludeExtensions: [], secretFiles: [], secretEnv: [], policy: {}, deliver: undefined, use: undefined, set: [], setup: undefined, warnings };
	for (const [key, value] of Object.entries(doc)) {
		if (!KEYS.includes(key)) {
			warn(key, "is not a known key, ignored");
		} else if (key === "url" || key === "token") {
			out.set.push(key);
			if (repository) continue;
			if (typeof value === "string") out[key] = text(value);
			else warn(key, "is not a string, ignored");
		} else if (key === "use") {
			if (repository) warn(key, "is a personal setting, ignored");
			else if (value === "personal" || value === "paired") out.use = value;
			else warn(key, "is not personal or paired, ignored");
		} else if (key === "deliver") {
			if (repository) warn(key, "is a personal setting, ignored");
			else if (value === "tray" || value === "transcript") out.deliver = value;
			else warn(key, "is not tray or transcript, ignored");
		} else if (key === "setup") {
			if (!repository) {
				warn(key, "belongs in a repository's .omp-cloud.yml, ignored");
			} else {
				const parsed = parseSetup(value);
				if (typeof parsed === "string") warn(key, parsed);
				else out.setup = parsed;
			}
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
		personalUrl: personal.url?.replace(/\/+$/, ""),
		personalToken: personal.token,
		urlFrom: envUrl !== undefined ? "env" : personal.url !== undefined ? "personal" : undefined,
		token: envToken ?? personal.token,
		tokenFrom: envToken !== undefined ? "env" : personal.token !== undefined ? "personal" : undefined,
		ignored: (["url", "token"] as const).filter(key => repo.set.includes(key)),
		excludeExtensions: union(personal.excludeExtensions, repo.excludeExtensions),
		secretFiles: union(personal.secretFiles, repo.secretFiles),
		secretEnv: union(personal.secretEnv, repo.secretEnv),
		policy: { ...personal.policy, ...repo.policy },
		setup: repo.setup,
		use: personal.use,
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
	if (cfg.use !== undefined) lines.push(`  use: ${cfg.use} (${tilde(cfg.personalFile, cfg.home)})`);
	lines.push(`  deliver: ${cfg.deliver} (${cfg.deliverFrom === undefined ? "default" : originLabel(cfg, cfg.deliverFrom)})`);
	if (cfg.repoFile !== undefined) lines.push(`  repository file: ${cfg.repoFile}`);
	for (const w of cfg.warnings) lines.push(`  warning: ${w}`);
	return lines;
}

/** What the user sees when the cloud is not configured, with the repository keys that were ignored. */
export function notConfigured(cfg: CloudConfig): string {
	const lines = [
		`☁ omp-cloud is not configured: set url and token in ${tilde(cfg.personalFile, cfg.home)} (for example token: "!cat ~/.config/omp-cloud/service.token"), or OMP_CLOUD_URL and OMP_CLOUD_TOKEN; or pair this machine with /cloud connect <code | user@host>`,
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

/** The paired connection of `connection.json`, `ignoredToken` being what a token set beside it is called; undefined when there is no file or it names no address. */
async function pairedConnection(cfg: CloudConfig, ignoredToken: Origin | undefined): Promise<Connection | undefined> {
	const paired = await readConnectionFile(cfg.connectionFile);
	const address = paired?.server.addresses[0];
	if (!paired || address === undefined) return undefined;
	return { url: `https://${address}`, token: paired.token, source: "paired", paired, ignoredToken, unauthorizedHint: PAIRED_UNAUTHORIZED };
}

/** A connection from a configured `url` and `token` (through omp's `resolveConfigValue`: `!command`, environment variable name or literal), whose token `tokenFrom` says where it was set. */
async function configuredConnection(cfg: CloudConfig, url: string, token: string, source: Origin, tokenFrom: Origin | undefined): Promise<Connection> {
	checkConfiguredUrl(url);
	// omp's `resolveConfigValue` runs a `!command` with `/bin/sh -c` (omp's embedded shell on Windows) under a 10 s limit, caches a success for the process and retries a failure after 30 s.
	const resolved = text(await resolveConfigValue(token));
	if (!resolved) {
		const from = tokenFrom === undefined ? "" : ` (${originLabel(cfg, tokenFrom)})`;
		throw new UserError(`☁ token${from} resolved to nothing; if it is a !command, run it by hand to see why it prints no token`);
	}
	const unauthorizedHint =
		tokenFrom === "env"
			? "the service refused the token in OMP_CLOUD_TOKEN (this omp's environment): correct it or unset it"
			: `the service refused the token in ${tilde(cfg.personalFile, cfg.home)}: it must be the server's owner token (setup writes token: "!cat ~/.config/omp-cloud/service.token")`;
	return { url, token: resolved, source, paired: undefined, ignoredToken: undefined, unauthorizedHint };
}

/**
 * The service address and its credential, from one source, never mixed. Without `choice`: `OMP_CLOUD_URL`, else the
 * personal file's `url`, decides: the token is then `OMP_CLOUD_TOKEN`, else the file's `token`. With no url at all, the
 * paired connection (`connection.json`) is used whole: its pinned certificate, addresses and device token. A token from
 * the environment or the file is then ignored, and says so. A connection file that does not validate is an error, never a fallback.
 *
 * `choice` is the source a session picked (`/cloud use`): `env` is `OMP_CLOUD_URL` with its token, `personal` the
 * personal file's own `url` and `token`, `paired` the pairing. A source this machine no longer has is an error.
 */
export async function resolveConnection(cfg: CloudConfig, choice?: ConnectionSource): Promise<Connection> {
	const file = tilde(cfg.personalFile, cfg.home);
	const fromUse = choice === undefined && cfg.use !== undefined && cfg.urlFrom !== "env";
	const picked = fromUse ? cfg.use : choice;
	const gone = (source: ConnectionSource): UserError =>
		fromUse
			? new UserError(`☁ use: ${source} in ${file} names a cloud this machine does not have (/cloud connect pairs one; /cloud use <cloud> --default picks another)`)
			: new UserError(`☁ omp-cloud is not configured for this session: it uses ${source}, which this machine no longer has (/cloud use picks another, /cloud connect pairs a server)`);
	if (picked === undefined) {
		if (cfg.url === undefined) {
			const paired = await pairedConnection(cfg, cfg.tokenFrom);
			if (!paired) throw new UserError(notConfigured(cfg));
			return paired;
		}
		if (!cfg.token || cfg.urlFrom === undefined) throw new UserError(notConfigured(cfg));
		return configuredConnection(cfg, cfg.url, cfg.token, cfg.urlFrom, cfg.tokenFrom);
	}
	if (picked === "paired") {
		const paired = await pairedConnection(cfg, cfg.url === undefined ? cfg.tokenFrom : undefined);
		if (!paired) throw gone(picked);
		return paired;
	}
	if (picked === "personal") {
		if (cfg.personalUrl === undefined) throw gone(picked);
		if (!cfg.personalToken) {
			throw new UserError(`☁ url in ${file} has no token: set token there (for example token: "!cat ~/.config/omp-cloud/service.token")`);
		}
		return configuredConnection(cfg, cfg.personalUrl, cfg.personalToken, "personal", "personal");
	}
	if (cfg.urlFrom !== "env" || cfg.url === undefined) throw gone(picked);
	if (!cfg.token) throw new UserError(notConfigured(cfg));
	return configuredConnection(cfg, cfg.url, cfg.token, "env", cfg.tokenFrom);
}

/** One cloud this machine can use: where it is configured (`where` for the user), and its address; `url` is `""` for a pairing that does not validate, which `/cloud use` cannot pick. */
export interface KnownCloud {
	source: ConnectionSource;
	url: string;
	where: string;
}

/** The clouds of this machine and the one a session uses; `lines` is what `/cloud use` and the tool's `info` show. */
export interface CloudsView {
	known: KnownCloud[];
	/** The source the session uses; undefined when the connection does not resolve. */
	active: ConnectionSource | undefined;
	/** The session picked `active` itself (`/cloud use`, `/cloud connect`), rather than taking the default. */
	chosen: boolean;
	lines: string[];
}

/** The clouds this machine knows, in the order `env`, `personal`, `paired`. Never resolves a token. */
export async function knownClouds(cfg: CloudConfig): Promise<KnownCloud[]> {
	const known: KnownCloud[] = [];
	if (cfg.urlFrom === "env" && cfg.url !== undefined) known.push({ source: "env", url: cfg.url, where: "OMP_CLOUD_URL" });
	if (cfg.personalUrl !== undefined) known.push({ source: "personal", url: cfg.personalUrl, where: `url in ${tilde(cfg.personalFile, cfg.home)}` });
	const file = tilde(cfg.connectionFile, cfg.home);
	try {
		const paired = await readConnectionFile(cfg.connectionFile);
		const address = paired?.server.addresses[0];
		if (paired) known.push({ source: "paired", url: address === undefined ? "" : `https://${address}`, where: `paired device ${paired.device.name}, ${file}` });
	} catch (e) {
		known.push({ source: "paired", url: "", where: `${file} does not validate: ${e instanceof Error ? e.message : String(e)}` });
	}
	return known;
}

/** The `cloud:` and `other clouds:` rows: the cloud a session uses, why, and the others it could `/cloud use`. */
export function cloudLines(cfg: CloudConfig, clouds: readonly KnownCloud[], active: ConnectionSource | undefined, chosen: boolean): string[] {
	if (clouds.length === 0) return ["cloud: none configured on this machine"];
	const current = clouds.find(c => c.source === active);
	const why = chosen
		? "this session's choice"
		: active === "env"
			? "the default (OMP_CLOUD_URL is set)"
			: cfg.use !== undefined && active === cfg.use
				? `the default (use: ${cfg.use} in ${tilde(cfg.personalFile, cfg.home)})`
				: active === "personal"
					? `the default (url in ${tilde(cfg.personalFile, cfg.home)})`
					: "the default (the paired server; no url configured)";
	const lines = [active === undefined || !current ? "cloud: none usable yet" : `cloud: ${active} · ${current.url} · ${why}`];
	const others = clouds.filter(c => c.source !== active).map(c => `${c.source}${c.url === "" ? "" : ` ${c.url}`} (${c.where})`);
	if (others.length > 0) lines.push(`other clouds: ${others.join("; ")}`);
	return lines;
}

/**
 * Writes `use: <source>` into the personal file, the cloud new sessions on this machine take. A symlinked file stays a link (its
 * target is rewritten); a top-level `use:` line is replaced or one is appended, every other line untouched; a missing file is
 * created with a header. The write goes through a temp file beside the real file, renamed over it, mode 0600. Never through omp's config writers.
 */
export async function setDefaultCloud(cfg: CloudConfig, source: DefaultCloud): Promise<void> {
	let target = cfg.personalFile;
	let existing: string | undefined;
	try {
		target = await realpath(cfg.personalFile);
		existing = await readFile(target, "utf8");
	} catch (e) {
		if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
	}
	const line = `use: ${source}`;
	let body: string;
	if (existing === undefined) body = `# omp-cloud settings for this machine (see docs/configuration.md)\n${line}\n`;
	else if (/^use:.*$/m.test(existing)) body = existing.replace(/^use:.*$/m, line);
	else body = `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${line}\n`;

	const dir = dirname(target);
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `.config.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(body);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, target);
	} catch (e) {
		await rm(temp, { force: true });
		throw e;
	}
}
