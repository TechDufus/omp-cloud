import { isRefusedHost } from "../connectors/refused";
import { isRecord } from "../guards";
import { SettingError } from "../settings/registry";
import type { ThreadPolicy } from "../settings/policy";
import { parseThreadPolicy } from "../settings/tighten";
import { MAX_TEXT_BYTES, THINKING_LEVELS } from "../store/types";
import type { Author, NewThread, Paths, Repo, ThreadMcpServer, ThreadOrigin, ThreadSecrets, ThreadSetup } from "../store/types";
import { ApiError } from "./errors";

/** A validated create request. */
export interface CreateRequest {
	/** Everything Store.createThread needs but the owner; `ompVersion` is `""` when the request names none (`createThreadFromUpload` fills in the host's). */
	thread: Omit<NewThread, "owner">;
	/** Null when the request ships no secret files and no secret variables. */
	secrets: ThreadSecrets | null;
}

const MAX_TITLE_CHARS = 80;
/** A heading this short names a section (`Goal`, `Known cause`) rather than the work, so the line under it joins the title. */
const SHORT_HEADING_WORDS = 3;
const MAX_NAME_CHARS = 60;
const NAME_MESSAGE = `name must be one line of at most ${MAX_NAME_CHARS} characters`;
const MAX_FIELD_BYTES = 512;
const MAX_URL_BYTES = 2048;
const MAX_SECRET_FILES = 32;
const MAX_SECRET_ENV = 64;
/** Decoded file bytes plus variable names and values. */
const MAX_SECRET_BYTES = 1024 * 1024;
/** Quoted values in messages are cut to this many characters. */
const MAX_QUOTED_CHARS = 100;

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = ["HOME", "PATH"];
const RESERVED_ENV_PREFIXES = ["OMP_", "MISE_"];
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const OMP_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_MCP_SERVERS = 32;
const MAX_MCP_HEADERS = 32;
const MAX_MCP_ENV = 64;
const MAX_MCP_ARGS = 256;
/** The JSON of every shipped MCP server together. */
const MAX_MCP_BYTES = 262144;
const MCP_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** An stdio server's env value: a reference (`${NAME}` or `${NAME:-default}`) to the VM's own environment, so no literal secret travels in a request. */
const MCP_ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/;
const MAX_CONFIG_OVERLAYS = 8;
const OVERLAY_SEGMENT = /^[A-Za-z0-9._-]+$/;
const REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SESSION_CHARS = 128;
const MAX_SETUP_RUN_CHARS = 16384;
const MAX_SETUP_CACHE_FILES = 32;
/** The repository files whose contents key a cached environment when a request's `setup` names none: the lockfiles and requirement lists of the common ecosystems. */
export const DEFAULT_SETUP_CACHE_FILES: readonly string[] = [
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"Cargo.lock",
	"go.sum",
	"poetry.lock",
	"uv.lock",
	"requirements.txt",
	"Gemfile.lock",
	"composer.lock",
];
/** The name of a scratch thread's repository when the request gives none. */
const SCRATCH_NAME = "scratch";

function bad(message: string): ApiError {
	return new ApiError(400, message);
}

/** At most `limit` UTF-8 bytes, well-formed, no control characters. */
function plainText(s: string, limit: number): boolean {
	if (!s.isWellFormed() || Buffer.byteLength(s) > limit) return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return false;
	}
	return true;
}

function cut(s: string, chars: number): string {
	const points = Array.from(s);
	return points.length > chars ? points.slice(0, chars).join("") : s;
}

/** The string at `obj[key]`; absent or null is `""`. */
function textField(obj: Record<string, unknown>, key: string, field: string): string {
	const value = obj[key];
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw bad(`${field} must be a string`);
	return value;
}

/** The object at `obj[key]`; absent or null is empty. */
function objectField(obj: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = obj[key];
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw bad(`${key} must be an object`);
	return value;
}

/**
 * The text of an ATX Markdown heading (`# Goal`, `## Plan ##`) without its `#` runs; undefined for any other line. Seven
 * `#`, or a `#` with no space after it, is not a heading, and a closing run counts only after a space (`# C#` keeps its
 * `#`). Scanned by hand, not with a regex, so a long line costs linear time.
 */
function headingText(line: string): string | undefined {
	let open = 0;
	while (open < line.length && line[open] === "#") open++;
	if (open === 0 || open > 6 || (open < line.length && !/\s/.test(line.charAt(open)))) return undefined;
	let end = line.length;
	while (end > open && line[end - 1] === "#") end--;
	if (end < line.length && !/\s/.test(line.charAt(end - 1))) end = line.length;
	return line.slice(open, end).trim();
}

/**
 * The first non-empty line of the prompt, trimmed, without the `#` runs of a Markdown heading (an empty heading is
 * skipped). A heading of at most three words is joined with the next non-empty line (`# Goal` then `Fix the bug` gives
 * `Goal: Fix the bug`). Cut to 80 code points.
 */
function titleOf(prompt: string): string {
	const lines = prompt
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "");
	for (const [i, line] of lines.entries()) {
		const text = headingText(line);
		if (text === undefined) return cut(line, MAX_TITLE_CHARS);
		if (text === "") continue;
		const next = lines[i + 1];
		const under = next === undefined ? "" : (headingText(next) ?? next);
		const short = text.split(/\s+/).length <= SHORT_HEADING_WORDS;
		return cut(short && under !== "" ? `${text}: ${under}` : text, MAX_TITLE_CHARS);
	}
	return "";
}

/** Drops the credentials of a git remote before it is stored: the userinfo of a URL, or the `user@` of scp-style syntax. A `file:` URL has none and is kept as given. */
function stripUserinfo(raw: string): string {
	if (raw === "") return "";
	if (raw.includes("://")) {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw bad("repo.remoteURL is not a valid git URL");
		}
		// A `file:` URL has an empty host by design, and the URL parser already refuses userinfo in one.
		if (url.protocol === "file:") return raw;
		if (url.host === "") throw bad("repo.remoteURL is not a valid git URL");
		url.username = "";
		url.password = "";
		return url.href;
	}
	const colon = raw.indexOf(":");
	if (colon >= 0) {
		const host = raw.slice(0, colon);
		const at = host.lastIndexOf("@");
		if (at >= 0) return host.slice(at + 1) + raw.slice(colon);
	}
	return raw;
}

/** An absolute path in the form of any client platform: POSIX (`/x`), Windows drive (`C:\x`, `C:/x`) or UNC (`\\server\share`). */
const CLIENT_ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\])/;

/** A workspace-relative, clean path that is not inside `.git`. The VM is Linux, so a backslash would be a literal file name. */
function validSecretPath(p: string): boolean {
	if (p === "" || p.includes("\\") || !plainText(p, MAX_FIELD_BYTES)) return false;
	const segments = p.split("/");
	return segments.every(segment => segment !== "" && segment !== "." && segment !== "..") && segments[0] !== ".git";
}

/**
 * The provider of a `<provider>/<id>` model, with an optional `:<thinking>` suffix; `""` when the model is not of that
 * form. The provider is lower-case `[a-z0-9._-]` and the id is non-empty text without whitespace (ids may hold `/` and `:`).
 */
export function modelProvider(model: string): string {
	const slash = model.indexOf("/");
	if (slash < 1) return "";
	const provider = model.slice(0, slash);
	let id = model.slice(slash + 1);
	const colon = id.lastIndexOf(":");
	if (colon >= 0 && (THINKING_LEVELS as readonly string[]).includes(id.slice(colon + 1))) id = id.slice(0, colon);
	return PROVIDER_PATTERN.test(provider) && id !== "" && !/\s/.test(id) ? provider : "";
}

/** Why `name` cannot be a secret variable, completing "secretEnv <name> ..."; `""` when it can. */
export function checkEnvName(name: string): string {
	if (!ENV_NAME_PATTERN.test(name)) return "is not a valid variable name";
	if (RESERVED_ENV.includes(name)) return "is reserved";
	const prefix = RESERVED_ENV_PREFIXES.find(p => name.startsWith(p));
	if (prefix !== undefined) return `is reserved: names starting with ${prefix} are used by the service`;
	return "";
}

/** The decoded size of standard padded base64 text, or -1 when it is not valid base64. */
function base64DecodedBytes(content: string): number {
	if (content.length % 4 !== 0 || !BASE64_BODY.test(content)) return -1;
	let padding = 0;
	if (content.endsWith("==")) padding = 2;
	else if (content.endsWith("=")) padding = 1;
	return (content.length / 4) * 3 - padding;
}

/** Validates `secretFiles` and `secretEnv` and returns what ships: the secrets (null when empty) and the lists for the thread. */
function parseSecrets(body: Record<string, unknown>): { secrets: ThreadSecrets | null; files: string[]; envNames: string[] } {
	const rawFiles = body.secretFiles ?? [];
	if (!Array.isArray(rawFiles)) throw bad("secretFiles must be an array");
	const rawEnv = body.secretEnv ?? {};
	if (!isRecord(rawEnv)) throw bad("secretEnv must be an object");
	if (rawFiles.length > MAX_SECRET_FILES) {
		throw bad(`secretFiles has ${rawFiles.length} entries; at most ${MAX_SECRET_FILES}`);
	}
	const names = Object.keys(rawEnv).sort();
	if (names.length > MAX_SECRET_ENV) throw bad(`secretEnv has ${names.length} entries; at most ${MAX_SECRET_ENV}`);

	let total = 0;
	const files: { path: string; content: string }[] = [];
	for (const [i, entry] of rawFiles.entries()) {
		if (!isRecord(entry)) throw bad(`secretFiles[${i}] must be an object`);
		const path = textField(entry, "path", `secretFiles[${i}].path`);
		const content = textField(entry, "content", `secretFiles[${i}].content`);
		if (!validSecretPath(path)) {
			throw bad(`secretFiles[${i}]: path ${JSON.stringify(cut(path, MAX_QUOTED_CHARS))} must be relative, clean and outside .git`);
		}
		if (files.some(f => f.path === path)) throw bad(`secretFiles[${i}]: path ${JSON.stringify(path)} is listed twice`);
		const size = base64DecodedBytes(content);
		if (size < 0) throw bad(`secretFiles[${i}]: content is not base64`);
		files.push({ path, content });
		total += size;
	}
	const env: [string, string][] = [];
	for (const name of names) {
		const reason = checkEnvName(name);
		if (reason !== "") throw bad(`secretEnv ${cut(name, MAX_QUOTED_CHARS)} ${reason}`);
		const value = rawEnv[name];
		if (typeof value !== "string") throw bad(`secretEnv ${name} must be a string`);
		env.push([name, value]);
		total += Buffer.byteLength(name) + Buffer.byteLength(value);
	}
	if (total > MAX_SECRET_BYTES) throw bad(`secretFiles and secretEnv are ${total} bytes; at most ${MAX_SECRET_BYTES}`);

	return {
		secrets: files.length === 0 && env.length === 0 ? null : { files, env: Object.fromEntries(env) },
		files: files.map(f => f.path),
		envNames: names,
	};
}

/** The string at `entry[key]`, or the 400 for a server named `name`. */
function mcpString(entry: Record<string, unknown>, key: string, name: string): string {
	const value = entry[key];
	if (typeof value !== "string") throw bad(`mcp server ${name}: ${key} must be a string`);
	return value;
}

/** The `name: string` pairs of `entry[key]` (absent is empty), at most `limit` of them, each pair checked by `check`. */
function mcpStringMap(entry: Record<string, unknown>, key: string, name: string, limit: number, check: (k: string, v: string) => void): Record<string, string> {
	const value = entry[key] ?? {};
	if (!isRecord(value)) throw bad(`mcp server ${name}: ${key} must be an object`);
	const pairs = Object.entries(value);
	if (pairs.length > limit) throw bad(`mcp server ${name}: ${key} has ${pairs.length} entries; at most ${limit}`);
	const out: Record<string, string> = {};
	for (const [k, v] of pairs) {
		if (typeof v !== "string") throw bad(`mcp server ${name}: ${key} ${cut(k, MAX_QUOTED_CHARS)} must be a string`);
		check(k, v);
		out[k] = v;
	}
	return out;
}

/**
 * Validates `mcp`: at most 32 uniquely named servers. An http server (a public or LAN URL the service proxies; its
 * headers never reach a VM) may not point at the service host. A stdio server runs in the VM and may reference
 * the VM's env only as `${NAME}`.
 */
function parseMcp(body: Record<string, unknown>, selfHosts: readonly string[]): ThreadMcpServer[] {
	const raw = body.mcp ?? [];
	if (!Array.isArray(raw)) throw bad("mcp must be an array");
	if (raw.length > MAX_MCP_SERVERS) throw bad(`mcp has ${raw.length} entries; at most ${MAX_MCP_SERVERS}`);
	const servers: ThreadMcpServer[] = [];
	for (const [i, entry] of raw.entries()) {
		if (!isRecord(entry)) throw bad(`mcp[${i}] must be an object`);
		const name = entry.name;
		if (typeof name !== "string" || !MCP_NAME_PATTERN.test(name)) throw bad(`mcp[${i}].name must be 1 to 64 characters of letters, digits, . _ or -`);
		if (servers.some(server => server.name === name)) throw bad(`mcp server ${name} is listed twice`);
		if (entry.type === "http") {
			const url = mcpString(entry, "url", name);
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw bad(`mcp server ${name}: url is not a URL`);
			}
			if (!plainText(url, MAX_URL_BYTES) || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
				throw bad(`mcp server ${name}: url must be an http or https URL of at most ${MAX_URL_BYTES} bytes`);
			}
			if (isRefusedHost(parsed.hostname, selfHosts)) throw bad(`mcp server ${name} may not point at the service host`);
			const headers = mcpStringMap(entry, "headers", name, MAX_MCP_HEADERS, (key, value) => {
				if (!HEADER_NAME_PATTERN.test(key)) throw bad(`mcp server ${name}: header ${cut(key, MAX_QUOTED_CHARS)} is not a valid header name`);
				if (!plainText(value, 8192)) throw bad(`mcp server ${name}: header ${key} must be at most 8192 bytes without control characters`);
			});
			servers.push({ name, type: "http", url, headers });
		} else if (entry.type === "stdio") {
			const command = mcpString(entry, "command", name);
			if (command === "" || !plainText(command, MAX_FIELD_BYTES)) throw bad(`mcp server ${name}: command must be 1 to ${MAX_FIELD_BYTES} bytes without control characters`);
			const rawArgs = entry.args ?? [];
			if (!Array.isArray(rawArgs)) throw bad(`mcp server ${name}: args must be an array of strings`);
			if (rawArgs.length > MAX_MCP_ARGS) throw bad(`mcp server ${name}: args has ${rawArgs.length} entries; at most ${MAX_MCP_ARGS}`);
			const args = rawArgs.map((arg: unknown) => {
				if (typeof arg !== "string") throw bad(`mcp server ${name}: args must be an array of strings`);
				return arg;
			});
			const env = mcpStringMap(entry, "env", name, MAX_MCP_ENV, (key, value) => {
				if (!ENV_NAME_PATTERN.test(key)) throw bad(`mcp server ${name}: env ${cut(key, MAX_QUOTED_CHARS)} is not a valid variable name`);
				if (!MCP_ENV_REFERENCE.test(value)) throw bad(`mcp server ${name}: env ${key} must be a \${NAME} reference to the cloud's secrets, not a literal value`);
			});
			const cwd = entry.cwd;
			if (cwd !== undefined && (typeof cwd !== "string" || !validSecretPath(cwd))) throw bad(`mcp server ${name}: cwd must be a relative, clean path`);
			servers.push({ name, type: "stdio", command, args, env, ...(cwd === undefined ? {} : { cwd }) });
		} else {
			throw bad(`mcp server ${name}: type must be "http" or "stdio"`);
		}
	}
	const size = Buffer.byteLength(JSON.stringify(servers));
	if (size > MAX_MCP_BYTES) throw bad(`mcp is ${size} bytes; at most ${MAX_MCP_BYTES}`);
	return servers;
}

/**
 * Validates `setup`: absent or null is none, else `{run, cacheFiles?}` with a script of 1 to 16384 characters and at
 * most 32 clean relative repository paths whose contents key the cached environment (`DEFAULT_SETUP_CACHE_FILES` when
 * omitted).
 */
function parseSetup(body: Record<string, unknown>): ThreadSetup | null {
	const raw = body.setup;
	if (raw === undefined || raw === null) return null;
	if (!isRecord(raw)) throw bad("setup must be an object");
	const run = raw.run;
	if (typeof run !== "string" || run.trim() === "" || run.length > MAX_SETUP_RUN_CHARS || !run.isWellFormed() || run.includes("\0")) {
		throw bad(`setup.run must be a script of 1 to ${MAX_SETUP_RUN_CHARS} characters`);
	}
	const files = raw.cacheFiles;
	if (files === undefined || files === null) return { run, cacheFiles: [...DEFAULT_SETUP_CACHE_FILES] };
	if (!Array.isArray(files)) throw bad("setup.cacheFiles must be an array");
	if (files.length > MAX_SETUP_CACHE_FILES) throw bad(`setup.cacheFiles has ${files.length} entries; at most ${MAX_SETUP_CACHE_FILES}`);
	const cacheFiles = files.map((file, i) => {
		if (typeof file !== "string") throw bad(`setup.cacheFiles[${i}] must be a string`);
		if (!validSecretPath(file)) throw bad(`setup.cacheFiles[${i}]: ${JSON.stringify(cut(file, MAX_QUOTED_CHARS))} must be a clean relative path outside .git`);
		return file;
	});
	return { run, cacheFiles };
}

/** Validates `configOverlays`: at most 8 clean relative paths of safe segments, in load order. */
function parseConfigOverlays(body: Record<string, unknown>): string[] {
	const raw = body.configOverlays ?? [];
	if (!Array.isArray(raw)) throw bad("configOverlays must be an array");
	if (raw.length > MAX_CONFIG_OVERLAYS) throw bad(`configOverlays has ${raw.length} entries; at most ${MAX_CONFIG_OVERLAYS}`);
	return raw.map((path, i) => {
		if (typeof path !== "string") throw bad(`configOverlays[${i}] must be a string`);
		const segments = path.split("/");
		if (path.length > MAX_FIELD_BYTES || !segments.every(segment => OVERLAY_SEGMENT.test(segment) && segment !== "." && segment !== "..")) {
			throw bad(`configOverlays[${i}]: ${JSON.stringify(cut(path, MAX_QUOTED_CHARS))} must be a clean relative path of [A-Za-z0-9._-] segments`);
		}
		return path;
	});
}

/** Validates `policy`: an object of the policy keys a thread may tighten, each checked by the registry's validator of `policy.<key>`; absent or null is none. */
function parsePolicy(body: Record<string, unknown>): ThreadPolicy {
	try {
		return parseThreadPolicy(body.policy);
	} catch (error) {
		if (error instanceof SettingError) throw bad(error.message);
		throw error;
	}
}

/** Validates `name`: one line, trimmed with inner whitespace collapsed to single spaces, at most 60 code points; absent, null or empty is `""`. */
function parseName(body: Record<string, unknown>): string {
	const value = body.name;
	if (value === undefined || value === null) return "";
	if (typeof value !== "string" || !value.isWellFormed()) throw bad(NAME_MESSAGE);
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) throw bad(NAME_MESSAGE);
	}
	const name = value.trim().replace(/\s+/g, " ");
	if (Array.from(name).length > MAX_NAME_CHARS) throw bad(NAME_MESSAGE);
	return name;
}

/** Validates `origin`: `tool` or `user`; absent, null or empty is `""` (unknown). */
function parseOrigin(body: Record<string, unknown>): ThreadOrigin | "" {
	const value = textField(body, "origin", "origin");
	if (value === "") return "";
	if (value !== "tool" && value !== "user") throw bad('origin must be "tool" or "user"');
	return value;
}

/** Validates `ref`: 1 to 64 characters of `[A-Za-z0-9._-]`; absent, null or empty is `""`. */
function parseRef(body: Record<string, unknown>): string {
	const value = textField(body, "ref", "ref");
	if (value !== "" && !REF_PATTERN.test(value)) throw bad("ref must be 1 to 64 characters of letters, digits, . _ or -");
	return value;
}

/** Validates `session`: at most 128 characters without control characters; absent, null or empty is `""`. */
function parseSession(body: Record<string, unknown>): string {
	const value = textField(body, "session", "session");
	if (!plainText(value, Number.MAX_SAFE_INTEGER) || Array.from(value).length > MAX_SESSION_CHARS) {
		throw bad(`session must be at most ${MAX_SESSION_CHARS} characters without control characters`);
	}
	return value;
}

/** Validates `repo.scratch`: a boolean; absent or null is false. */
function parseScratch(repoBody: Record<string, unknown>): boolean {
	const value = repoBody.scratch;
	if (value === undefined || value === null) return false;
	if (typeof value !== "boolean") throw bad("repo.scratch must be a boolean");
	return value;
}

/** Validates the parsed JSON of the create request's `request` part. `thread.ompVersion` is `""` when the request names none. Throws ApiError(400, message). */
export function parseCreateRequest(raw: unknown, selfHosts: readonly string[] = []): CreateRequest {
	if (!isRecord(raw)) throw bad("the request must be a JSON object");
	const prompt = textField(raw, "prompt", "prompt");
	const model = textField(raw, "model", "model");
	const thinking = textField(raw, "thinking", "thinking");
	const ompVersion = textField(raw, "ompVersion", "ompVersion");
	const repoBody = objectField(raw, "repo");
	const pathsBody = objectField(raw, "paths");
	const authorBody = objectField(raw, "author");
	const repo: Repo = {
		name: textField(repoBody, "name", "repo.name"),
		remoteURL: textField(repoBody, "remoteURL", "repo.remoteURL"),
		baseRef: textField(repoBody, "baseRef", "repo.baseRef"),
		baseCommit: textField(repoBody, "baseCommit", "repo.baseCommit"),
		handoffCommit: textField(repoBody, "handoffCommit", "repo.handoffCommit"),
		localBranch: textField(repoBody, "localBranch", "repo.localBranch"),
	};
	const paths: Paths = {
		home: textField(pathsBody, "home", "paths.home"),
		workspace: textField(pathsBody, "workspace", "paths.workspace"),
	};
	const author: Author = {
		name: textField(authorBody, "name", "author.name"),
		email: textField(authorBody, "email", "author.email"),
	};

	const promptBytes = Buffer.byteLength(prompt);
	if (promptBytes === 0 || promptBytes > MAX_TEXT_BYTES || !prompt.isWellFormed()) {
		throw bad(`prompt must be 1 to ${MAX_TEXT_BYTES} bytes of UTF-8`);
	}
	if (!plainText(model, MAX_FIELD_BYTES)) {
		throw bad(`model must be at most ${MAX_FIELD_BYTES} bytes without control characters`);
	}
	if (model !== "" && modelProvider(model) === "") throw bad("model must be empty or <provider>/<id>, optionally with a :<thinking> suffix");
	const scratch = parseScratch(repoBody);
	if (scratch) {
		if (repo.remoteURL !== "" || repo.baseRef !== "" || repo.baseCommit !== "" || repo.handoffCommit !== "") {
			throw bad("a scratch repo takes no remoteURL, baseRef, baseCommit or handoffCommit");
		}
		// The service synthesizes the base and fills in the handoff commit (`createThreadFromUpload`).
		if (repo.name === "") repo.name = SCRATCH_NAME;
	} else if (!COMMIT_PATTERN.test(repo.handoffCommit)) {
		throw bad("repo.handoffCommit must be a 40 or 64 character lowercase hex commit id");
	}
	if (repo.baseCommit !== "" && !COMMIT_PATTERN.test(repo.baseCommit)) {
		throw bad("repo.baseCommit must be empty or a 40 or 64 character lowercase hex commit id");
	}
	for (const [field, value] of [
		["repo.name", repo.name],
		["repo.baseRef", repo.baseRef],
		["repo.localBranch", repo.localBranch],
		["author.name", author.name],
		["author.email", author.email],
	] as const) {
		if (!plainText(value, MAX_FIELD_BYTES)) {
			throw bad(`${field} must be at most ${MAX_FIELD_BYTES} bytes without control characters`);
		}
	}
	if (repo.name === "") throw bad("repo.name is required");
	for (const [field, value] of [
		["paths.home", paths.home],
		["paths.workspace", paths.workspace],
	] as const) {
		if (!plainText(value, MAX_FIELD_BYTES) || (value !== "" && !CLIENT_ABSOLUTE_PATH.test(value))) {
			throw bad(
				`${field} must be empty or an absolute POSIX, Windows drive or UNC path of at most ${MAX_FIELD_BYTES} bytes without control characters`,
			);
		}
	}
	// URL parsing silently drops tabs and newlines, so control characters are rejected before it and the result is checked after.
	if (!plainText(repo.remoteURL, MAX_URL_BYTES)) {
		throw bad(`repo.remoteURL must be at most ${MAX_URL_BYTES} bytes without control characters`);
	}
	const remote = stripUserinfo(repo.remoteURL);
	if (!plainText(remote, MAX_URL_BYTES)) {
		throw bad(`repo.remoteURL must be at most ${MAX_URL_BYTES} bytes without control characters`);
	}
	if (repo.baseCommit !== "") {
		if (remote === "") throw bad("a delta handoff (repo.baseCommit) needs repo.remoteURL");
		if (repo.baseRef === "") throw bad("a delta handoff (repo.baseCommit) needs repo.baseRef");
		// Whether the service can fetch that remote depends on its git hosts: `createThreadFromUpload` checks it.
	}
	if (thinking !== "" && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
		throw bad(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	if (ompVersion !== "" && !OMP_VERSION_PATTERN.test(ompVersion)) throw bad("ompVersion must be empty or <major>.<minor>.<patch>");
	const parsedSecrets = parseSecrets(raw);
	const { files, envNames } = parsedSecrets;
	const mcp = parseMcp(raw, selfHosts);
	const secrets: ThreadSecrets | null = mcp.length === 0 ? parsedSecrets.secrets : { ...(parsedSecrets.secrets ?? { files: [], env: {} }), mcp };
	const configOverlays = parseConfigOverlays(raw);
	const policy = parsePolicy(raw);
	const origin = parseOrigin(raw);
	const ref = parseRef(raw);
	const session = parseSession(raw);
	const name = parseName(raw);
	const setup = parseSetup(raw);

	return {
		thread: {
			title: titleOf(prompt),
			name,
			prompt,
			model,
			thinking,
			repo: { ...repo, remoteURL: remote },
			paths,
			author,
			secretFiles: files,
			secretEnv: envNames,
			configOverlays,
			ompVersion,
			policy,
			origin,
			ref,
			session,
			scratch,
			mcpServers: mcp.map(server => server.name),
			setup,
		},
		secrets,
	};
}
