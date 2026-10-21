import type { Database as BunDatabase } from "bun:sqlite";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { run } from "./exec";
import type { ShippedExtension } from "./extensions";
import { isRecord } from "./guards";
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
}

export interface SetupResult {
	path: string;
	bytes: number;
	warnings: string[];
	/** The overlays' paths inside the archive, relative to the agent dir, in load order. */
	configOverlays: string[];
}

type DatabaseCtor = new (path: string, options?: { readonly?: boolean }) => BunDatabase;

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

/**
 * Stages a settings file (`config.yml` or a `--config` overlay) like {@link stageTree}, except for two top-level
 * keys that stay home. `cloud` is dropped though omp-cloud never reads it any more: earlier versions kept the
 * service token there, and the VM has no use for any of it. `extensions` lists
 * paths on this machine; every shipped extension already sits in the setup's `extensions/` directory, which the
 * VM's omp discovers by itself, while a configured path that does not exist there would only fail to load. A file
 * with neither key ships untouched; one with either ships as a rewritten copy.
 */
async function stageSettings(src: string, dest: string): Promise<boolean> {
	if (!(await exists(src))) return false;
	// A tree copy may already have put a (possibly read-only) copy of the file there.
	await rm(dest, { force: true });
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(await readFile(src, "utf8"));
	} catch (e) {
		throw new UserError(`☁ ${src} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!isRecord(doc) || !("cloud" in doc || "extensions" in doc)) return stageTree(src, dest);
	const { cloud: _cloud, extensions: _extensions, ...rest } = doc;
	await mkdir(dirname(dest), { recursive: true });
	await writeFile(dest, Bun.YAML.stringify(rest, null, 2));
	return true;
}

// bun:sqlite exists only under Bun and an extension host may not expose it; a static
// import would fail the whole extension at load time, so load it lazily and fall back.
async function loadDatabase(): Promise<DatabaseCtor | undefined> {
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
async function stageOverlays(agentDir: string, stage: string, overlays: readonly string[]): Promise<string[]> {
	if (overlays.length > MAX_OVERLAYS) {
		throw new UserError(`☁ this session loads ${overlays.length} --config overlays; the cloud takes at most ${MAX_OVERLAYS}`);
	}
	const out: string[] = [];
	for (const [i, overlay] of overlays.entries()) {
		if (!(await exists(overlay))) throw new UserError(`☁ the --config overlay ${overlay} does not exist`);
		const inside = await insideAgentDir(agentDir, overlay);
		if (inside && cleanSegments(inside)) {
			// Even when a shipped tree already copied this file: its `cloud` and `extensions` keys must go.
			await stageSettings(overlay, join(stage, inside));
			out.push(inside);
			continue;
		}
		const name = `overlays/${i + 1}-${basename(overlay).replace(/[^A-Za-z0-9._-]/g, "_")}`;
		await stageSettings(overlay, join(stage, name));
		out.push(name);
	}
	return out;
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
		await (name === "config.yml" ? stageSettings : stageTree)(join(dir, name), join(stage, name));
	}

	for (const ext of opts.extensions) await stageTree(ext.source, join(stage, ext.dest));

	const mem = join(dir, "memories", "mnemopi");
	if (await exists(mem)) await stageMemory(mem, join(stage, "memories", "mnemopi"), await loadDatabase(), warnings);

	const configOverlays = await stageOverlays(dir, stage, opts.overlays);

	// `tar`, not `Bun.Archive`: Bun 1.4.3's writes every member as 0644, so an executable skill script would lose its bit. On Windows the
	// system bsdtar, because a Git or MSYS GNU tar on PATH reads `C:\…` as a remote host.
	const out = join(opts.tmpDir, "setup.tar.gz");
	const tar = process.platform === "win32" ? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
	const r = await run(tar, ["-czf", out, "-C", stage, "."]);
	if (r.code !== 0) throw new Error(`cannot pack the omp setup: ${r.stderr.trim().slice(0, 300) || `tar exit ${r.code}`}`);
	const bytes = (await stat(out)).size;
	if (bytes > MAX_SETUP_BYTES) {
		throw new Error(`omp setup is ${mb(bytes)} MB, over the ${mb(MAX_SETUP_BYTES)} MB limit; list extensions to keep home in excludeExtensions of your omp-cloud config`);
	}
	return { path: out, bytes, warnings, configOverlays };
}
