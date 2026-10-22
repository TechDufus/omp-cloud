import type { Database as BunDatabase } from "bun:sqlite";
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { run } from "./exec";
import type { ShippedExtension } from "./extensions";
import { isLocalHost, isRecord } from "./guards";
import type { MemoryBankPlan } from "./mnemopi";
import { mb } from "./snapshot";
import { UserError } from "./types";

export const MAX_SETUP_BYTES = 64 * 1024 * 1024;
export const MEMORY_WARNING = "memory copied without a snapshot; it may miss the last few writes";
/** The service accepts at most this many `configOverlays`. */
export const MAX_OVERLAYS = 8;

/**
 * Everything the cloud receives of `~/.omp/agent`, as an allowlist: instructions and rules, skills
 * and subagents, the settings file (without its `cloud` block, which earlier versions kept the service token in), LSP
 * configuration, extensions and Mnemopi memory. Anything else (`agent.db*` logins, sessions,
 * history/model/skill-description databases, caches, `secret-placeholder.key`, `mcp.json`) never ships.
 */
export const SETUP_FILES = ["AGENTS.md", "RULES.md", "WATCHDOG.md", "config.yml", "lsp.json"] as const;
export const SETUP_DIRS = ["skills", "agents"] as const;

export interface SetupOptions {
	agentDir: string;
	/** The extensions to ship, from {@link planExtensions}. */
	extensions: readonly ShippedExtension[];
	/** The session's `--config` overlays (absolute paths, in load order). */
	overlays: readonly string[];
	/** Scratch directory for staging and the archive. */
	tmpDir: string;
	/** Renames the project bank of the shipped memory, so the cloud agent (which works in another directory) finds it: `from` is this machine's bank, `to` the VM's. */
	memoryBank?: MemoryBankPlan;
}

export interface SetupResult {
	path: string;
	bytes: number;
	warnings: string[];
	/** The overlays' paths inside the archive, relative to the agent dir, in load order. */
	configOverlays: string[];
}

export type DatabaseCtor = new (path: string, options?: { readonly?: boolean }) => BunDatabase;

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Copies `src` to `dest`, resolving symlinks: a symlinked file or directory ships as its contents. File modes
 * survive, so an executable skill script stays executable. A directory already being copied
 * further up (a symlink cycle) and anything that is neither a regular file nor a directory are left out. Returns
 * whether `src` was staged.
 */
async function stageTree(src: string, dest: string, ancestors: readonly string[] = []): Promise<boolean> {
	const st = await stat(src).catch(() => undefined);
	if (st?.isFile()) {
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(src, dest);
		return true;
	}
	if (!st?.isDirectory()) return false;
	const real = await realpath(src);
	if (ancestors.includes(real)) return false;
	await mkdir(dest, { recursive: true });
	for (const name of await readdir(src)) await stageTree(join(src, name), join(dest, name), [...ancestors, real]);
	return true;
}

/** Top-level keys that stay home without a word: `cloud` held the service token in earlier versions, `extensions` lists paths on this machine (every shipped extension already sits in the setup's `extensions/` directory). */
const SILENT_KEYS = new Set(["cloud", "extensions"]);
/** Subtrees that stay home: the broker login. */
const HOME_SUBTREES = ["auth.broker"];
/** Credentials, host paths and settings of this machine. */
const HOME_KEYS = new Set([
	"images.urls.credentials",
	"hindsight.apiToken",
	"mnemopi.embeddingApiKey",
	"mnemopi.llmApiKey",
	"dev.autoqaPush.token",
	"searxng.token",
	"searxng.basicPassword",
	"mnemopi.dbPath",
	"shellPath",
	"shellMinimizer.settingsPath",
	"plan.autosaveDir",
	"browser.screenshotDir",
	"browser.cdpUrl",
	"browser.relayUrl",
	"skills.customDirectories",
	"workspace.additionalDirectories",
	"ida.installDir",
	"images.urls.command",
	"images.urls.sshTarget",
	"images.urls.bindHost",
	"images.urls.publicBaseUrl",
]);
/** Endpoints that stay home when they point at this machine. */
const LOCAL_URL_KEYS = new Set(["hindsight.apiUrl", "searxng.endpoint", "mnemopi.embeddingApiUrl", "mnemopi.llmBaseUrl", "compaction.remoteEndpoint"]);

function pointsAtThisMachine(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		return isLocalHost(new URL(value).hostname);
	} catch {
		return false;
	}
}

/** Whether `value`, set at the dotted `path`, stays on this machine (a `!command` anywhere, a credential, a host path, a local endpoint). */
function staysHome(path: string, value: unknown): boolean {
	if (typeof value === "string" && value.startsWith("!")) return true;
	if (HOME_KEYS.has(path) || HOME_SUBTREES.some(s => path === s || path.startsWith(`${s}.`))) return true;
	return LOCAL_URL_KEYS.has(path) && pointsAtThisMachine(value);
}

/** What {@link sanitizeSettings} took out of a settings document. */
export interface Sanitized {
	doc: Record<string, unknown>;
	/** The dotted keys removed with a warning: they stay on this machine. */
	dropped: string[];
	/** Whether anything was removed, `cloud` and `extensions` included. */
	changed: boolean;
}

/**
 * A settings document (`config.yml` or a `--config` overlay) as the cloud may have it. `cloud` and `extensions` (top level)
 * go silently. Everything else that must stay on this machine goes with its dotted path in `dropped`: the `auth.broker`
 * subtree, credentials, host paths and settings of this machine, any string value that starts with `!` (a command), and
 * the endpoints that point at this machine. Keys match nested (`auth: {broker: …}`) and dotted (`"auth.broker.url"`),
 * at any depth; a mapping the removal empties goes too. The input is not modified.
 */
export function sanitizeSettings(doc: Record<string, unknown>): Sanitized {
	const dropped: string[] = [];
	let removed = 0;

	const walkValue = (value: unknown, path: string[]): { keep: boolean; value: unknown } => {
		const dotted = path.join(".");
		if (staysHome(dotted, value)) {
			dropped.push(dotted);
			removed++;
			return { keep: false, value };
		}
		if (Array.isArray(value)) {
			const kept: unknown[] = [];
			for (const [i, item] of value.entries()) {
				const r = walkValue(item, [...path.slice(0, -1), `${path.at(-1)}[${i}]`]);
				if (r.keep) kept.push(r.value);
			}
			return { keep: true, value: kept.length === value.length ? value : kept };
		}
		if (isRecord(value)) {
			const before = removed;
			const out = walkMapping(value, path);
			// A mapping the removal emptied goes too; one that was empty already stays.
			return { keep: removed === before || Object.keys(out).length > 0, value: out };
		}
		return { keep: true, value };
	};

	const walkMapping = (mapping: Record<string, unknown>, parent: string[]): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(mapping)) {
			const path = [...parent, ...key.split(".")];
			if (parent.length === 0 && SILENT_KEYS.has(path[0] ?? "")) {
				removed++;
				continue;
			}
			const r = walkValue(value, path);
			if (r.keep) out[key] = r.value;
		}
		return out;
	};

	const clean = walkMapping(doc, []);
	return { doc: clean, dropped, changed: removed > 0 };
}

/**
 * Stages a settings file (`config.yml` or a `--config` overlay) like {@link stageTree}, except that what
 * {@link sanitizeSettings} takes out stays home: the file ships as a rewritten copy then, else untouched. Each key that
 * stays home with a reason is a warning.
 */
async function stageSettings(src: string, dest: string, warnings: string[]): Promise<boolean> {
	if (!(await exists(src))) return false;
	// A tree copy may already have put a (possibly read-only) copy of the file there.
	await rm(dest, { force: true });
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(await readFile(src, "utf8"));
	} catch (e) {
		throw new UserError(`☁ ${src} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!isRecord(doc)) return stageTree(src, dest);
	const clean = sanitizeSettings(doc);
	if (!clean.changed) return stageTree(src, dest);
	for (const key of clean.dropped) {
		const warning = `${basename(src)}: ${key} stays on this machine`;
		if (!warnings.includes(warning)) warnings.push(warning);
	}
	await mkdir(dirname(dest), { recursive: true });
	await writeFile(dest, Bun.YAML.stringify(clean.doc, null, 2));
	return true;
}

// bun:sqlite exists only under Bun and an extension host may not expose it; a static
// import would fail the whole extension at load time, so load it lazily and fall back.
export async function loadDatabase(): Promise<DatabaseCtor | undefined> {
	try {
		const mod = (await import("bun:sqlite")) as { Database: DatabaseCtor };
		return mod.Database;
	} catch {
		return undefined;
	}
}

const SIDECAR_RE = /\.db-(wal|shm)$|-(wal|shm)$/;

/**
 * Copies a memory tree, writing each SQLite database as a consistent
 * snapshot (`serialize`) and skipping the -wal/-shm sidecars. Without a usable
 * bun:sqlite the database and its sidecars are copied as they are.
 */
async function stageMemory(src: string, dest: string, Database: DatabaseCtor | undefined, warnings: string[]): Promise<void> {
	await mkdir(dest, { recursive: true });
	for (const entry of await readdir(src, { withFileTypes: true })) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(from)).isDirectory());
		if (isDir) {
			await stageMemory(from, to, Database, warnings);
			continue;
		}
		if (entry.name.endsWith(".db")) {
			if (Database) {
				let db: BunDatabase | undefined;
				try {
					db = new Database(from, { readonly: true });
					await writeFile(to, db.serialize());
					continue;
				} catch {
					// fall through to the plain copy
				} finally {
					db?.close();
				}
			}
			if (!warnings.includes(MEMORY_WARNING)) warnings.push(MEMORY_WARNING);
			await copyFile(from, to);
			for (const side of ["-wal", "-shm"]) {
				if (await exists(from + side)) await copyFile(from + side, to + side);
			}
			continue;
		}
		if (SIDECAR_RE.test(entry.name)) {
			// Copied alongside its database only in the fallback above.
			continue;
		}
		await copyFile(from, to);
	}
}

/** What the API accepts of an overlay path: segments of `[A-Za-z0-9._-]`, none of them `.` or `..`. */
function cleanSegments(rel: string): boolean {
	return rel.split("/").every(s => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..");
}

/** `overlay` relative to the agent dir (`/`-separated), or undefined when it lies outside it. */
async function insideAgentDir(agentDir: string, overlay: string): Promise<string | undefined> {
	const candidates: [string, string][] = [[resolve(agentDir), resolve(overlay)]];
	const [realDir, realOverlay] = await Promise.all([realpath(agentDir).catch(() => undefined), realpath(overlay).catch(() => undefined)]);
	if (realDir && realOverlay) candidates.push([realDir, realOverlay]);
	for (const [dir, file] of candidates) {
		const rel = relative(dir, file);
		if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join("/");
	}
	return undefined;
}

/**
 * Stages the session's `--config` overlays and returns their archive paths in load order. An
 * overlay inside the agent dir ships at its relative path; one outside it, or whose path the API
 * would not accept, ships as `overlays/<n>-<basename>`.
 */
async function stageOverlays(agentDir: string, stage: string, overlays: readonly string[], warnings: string[]): Promise<string[]> {
	if (overlays.length > MAX_OVERLAYS) {
		throw new UserError(`☁ this session loads ${overlays.length} --config overlays; the cloud takes at most ${MAX_OVERLAYS}`);
	}
	const out: string[] = [];
	for (const [i, overlay] of overlays.entries()) {
		if (!(await exists(overlay))) throw new UserError(`☁ the --config overlay ${overlay} does not exist`);
		const inside = await insideAgentDir(agentDir, overlay);
		if (inside && cleanSegments(inside)) {
			// Even when a shipped tree already copied this file: its `cloud` and `extensions` keys must go.
			await stageSettings(overlay, join(stage, inside), warnings);
			out.push(inside);
			continue;
		}
		const name = `overlays/${i + 1}-${basename(overlay).replace(/[^A-Za-z0-9._-]/g, "_")}`;
		await stageSettings(overlay, join(stage, name), warnings);
		out.push(name);
	}
	return out;
}

/**
 * Moves the shipped project bank `from` to `to` inside the staged mnemopi tree. A bank directory the VM already has under `to`
 * (the two directories hash alike) is never overwritten, and nothing happens when `from` is not there.
 */
async function renameBank(memory: string, plan: MemoryBankPlan): Promise<void> {
	if (plan.from === plan.to) return;
	const from = join(memory, "banks", plan.from);
	const to = join(memory, "banks", plan.to);
	if (!(await exists(from)) || (await exists(to))) return;
	await rename(from, to);
}

/** The `tar` of this machine: the system bsdtar on Windows, because a Git or MSYS GNU tar on PATH reads `C:\…` as a remote host. */
export function tarCommand(): string {
	return process.platform === "win32" ? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

/**
 * Packs the user's omp setup into `<tmpDir>/setup.tar.gz`: the {@link SETUP_FILES} and
 * {@link SETUP_DIRS} of the agent dir, the planned extensions, Mnemopi memory, and the session's
 * `--config` overlays.
 */
export async function buildSetup(opts: SetupOptions): Promise<SetupResult> {
	const stage = join(opts.tmpDir, "setup-stage");
	await mkdir(stage, { recursive: true });
	const warnings: string[] = [];
	const dir = opts.agentDir;

	for (const name of [...SETUP_FILES, ...SETUP_DIRS]) {
		if (name === "config.yml") await stageSettings(join(dir, name), join(stage, name), warnings);
		else await stageTree(join(dir, name), join(stage, name));
	}

	for (const ext of opts.extensions) await stageTree(ext.source, join(stage, ext.dest));

	const mem = join(dir, "memories", "mnemopi");
	if (await exists(mem)) {
		const staged = join(stage, "memories", "mnemopi");
		await stageMemory(mem, staged, await loadDatabase(), warnings);
		if (opts.memoryBank) await renameBank(staged, opts.memoryBank);
	}

	const configOverlays = await stageOverlays(dir, stage, opts.overlays, warnings);

	// `tar`, not `Bun.Archive`: Bun 1.4.3's writes every member as 0644, so an executable skill script would lose its bit.
	const out = join(opts.tmpDir, "setup.tar.gz");
	const r = await run(tarCommand(), ["-czf", out, "-C", stage, "."]);
	if (r.code !== 0) throw new Error(`cannot pack the omp setup: ${r.stderr.trim().slice(0, 300) || `tar exit ${r.code}`}`);
	const bytes = (await stat(out)).size;
	if (bytes > MAX_SETUP_BYTES) {
		throw new Error(`omp setup is ${mb(bytes)} MB, over the ${mb(MAX_SETUP_BYTES)} MB limit; list extensions to keep home in excludeExtensions of your omp-cloud config`);
	}
	return { path: out, bytes, warnings, configOverlays };
}
