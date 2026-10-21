/**
 * `omp-cloud backup [--keep N] [--config path]` (`mise run backup` runs the same code from a checkout): one consistent archive of the service's state while it runs.
 *
 * `<backupDir>/omp-cloud-<UTC timestamp>.tar.gz` holds `omp-cloud.db` (a `VACUUM INTO` copy: a consistent snapshot of
 * the live WAL database), `threads/` (the blobs, `secrets.json` included) and `git/cache/` (not `git/tmp/`).
 * `backupDir` is `<dataDir>/../backups` (0700), archives are 0600, the newest `--keep` (default 7) stay.
 *
 * Restore is manual: stop the omp-cloud unit, move the data directory aside, `mkdir` it (0700) and
 * `tar -xzf <archive> -C <dataDir>`, start the unit.
 */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, resolveConfigPath } from "./config";

const DEFAULT_KEEP = 7;
const BUSY_TIMEOUT_MS = 30_000;
/** What `backup` writes and retention may delete: nothing else in `backupDir` is touched. */
const ARCHIVE_PATTERN = /^omp-cloud-\d{8}T\d{6}Z\.tar\.gz$/;
/** The scratch directory (`mkdtemp`) and the unfinished archive of a run; a finished run removes or renames both. */
const STAGING_PATTERN = /^\.staging-/;
const PARTIAL_PATTERN = /^\.omp-cloud-\d{8}T\d{6}Z\.tar\.gz\.partial$/;
/** No backup runs this long. */
const STALE_MS = 6 * 60 * 60 * 1000;

export interface BackupOptions {
	/** The service's data directory (`Config.dataDir`). */
	dataDir: string;
	/** Default `<dataDir>/../backups`. */
	backupDir?: string;
	/** Archives to keep, the newest first; at least 1. */
	keep: number;
	/** Clock for the archive name; defaults to `() => new Date()`. */
	now?: () => Date;
}

export interface BackupResult {
	path: string;
	bytes: number;
	/** Older archives retention deleted. */
	removed: string[];
}

export async function backup(options: BackupOptions): Promise<BackupResult> {
	if (!Number.isInteger(options.keep) || options.keep < 1) throw new Error("keep must be an integer of at least 1");
	const dataDir = resolve(options.dataDir);
	const dbPath = join(dataDir, "omp-cloud.db");
	if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
	const backupDir = resolve(options.backupDir ?? join(dataDir, "..", "backups"));
	mkdirSync(backupDir, { recursive: true, mode: 0o700 });
	chmodSync(backupDir, 0o700);

	// Leftovers of a run that was interrupted (killed, out of disk): only what this script creates, by its own patterns,
	// and only once STALE_MS old; a younger one belongs to a run in flight (the timer and a manual run may overlap).
	for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
		if (!((entry.isDirectory() && STAGING_PATTERN.test(entry.name)) || (entry.isFile() && PARTIAL_PATTERN.test(entry.name)))) continue;
		const path = join(backupDir, entry.name);
		if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
	}

	// `20261020T041500Z`
	const archiveName = `omp-cloud-${(options.now ?? (() => new Date()))().toISOString().replace(/[-:]|\.\d+/g, "")}.tar.gz`;
	const archive = join(backupDir, archiveName);
	if (existsSync(archive)) throw new Error(`${archive} exists already`);
	const partial = join(backupDir, `.${archiveName}.partial`);
	const staging = mkdtempSync(join(backupDir, ".staging-"));
	try {
		// A read-only connection still reads through the WAL the service writes; VACUUM INTO writes a fresh file.
		const copy = join(staging, "omp-cloud.db");
		const db = new Database(dbPath, { readonly: true });
		try {
			db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			db.run("VACUUM INTO ?", [copy]);
		} finally {
			db.close();
		}
		chmodSync(copy, 0o600);

		closeSync(openSync(partial, "wx", 0o600));
		const members = ["threads", join("git", "cache")].filter((member) => existsSync(join(dataDir, member)));
		const tar = Bun.spawn(["tar", "-czf", partial, "-C", staging, "omp-cloud.db", "-C", dataDir, ...members], { stdout: "ignore", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(tar.stderr).text(), tar.exited]);
		// tar's 1 means a file changed or vanished while it was read (a blob rewritten by the running service); 2 is fatal.
		if (code !== 0 && code !== 1) throw new Error(`tar failed (${code}): ${stderr.trim()}`);
		if (code === 1) console.warn(`warning: ${stderr.trim()}`);
		chmodSync(partial, 0o600);
		renameSync(partial, archive);
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}

	const removed = readdirSync(backupDir)
		.filter((name) => ARCHIVE_PATTERN.test(name))
		.sort()
		.reverse()
		.slice(options.keep);
	for (const name of removed) unlinkSync(join(backupDir, name));
	return { path: archive, bytes: statSync(archive).size, removed: removed.map((name) => join(backupDir, name)) };
}

function parseArgs(args: readonly string[]): { keep: number; config: string | undefined } {
	let keep = DEFAULT_KEEP;
	let config: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const value = args[i + 1];
		if (args[i] === "--keep") {
			if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error("--keep needs a positive integer");
			keep = Number(value);
		} else if (args[i] === "--config") {
			if (value === undefined || value === "") throw new Error("--config needs a path");
			config = value;
		} else {
			throw new Error(`unknown argument ${JSON.stringify(args[i])}`);
		}
		i++;
	}
	return { keep, config };
}

/** Runs `omp-cloud backup`; `args` are the arguments after the command. Prints the archive and what retention removed; the exit code is returned. */
export async function backupMain(args: readonly string[]): Promise<number> {
	try {
		const { keep, config } = parseArgs(args);
		const { dataDir } = await loadConfig(resolveConfigPath(config));
		const result = await backup({ dataDir, keep });
		console.log(`${result.path} (${result.bytes} bytes)`);
		for (const path of result.removed) console.log(`removed ${path}`);
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
