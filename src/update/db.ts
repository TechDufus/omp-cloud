import { Database } from "bun:sqlite";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { REGISTRY } from "../settings/registry";
import { DEFAULT_RECIPE, type Recipe, recipeFrom } from "../vmon/recipe";
import { lastLine, type CommandRunner } from "./system";

const DB_FILE = "omp-cloud.db";
const BUSY_TIMEOUT_MS = 10_000;

/** The `update.*` settings the updater reads. */
export interface UpdateSettings {
	mode: "off" | "notify" | "auto";
	feed: string;
	token: string;
	unit: string;
	/** The units the applier's omp step checks and restarts. */
	ompUnits: string[];
}

/** `PRAGMA user_version` of the service database: its schema version, read without migrating or locking anything. Throws when there is no database. */
export function readSchemaVersion(dataDir: string): number {
	const db = new Database(join(dataDir, DB_FILE), { readonly: true });
	try {
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
	} finally {
		db.close();
	}
}

/**
 * The stored `update.*` settings straight from the database, for the CLI and the applier, which must work while the
 * database is at another schema than the binary (a newer binary runs before the service migrates it). A missing
 * database or a value its validator refuses gives the default.
 */
export function readUpdateSettings(dataDir: string): UpdateSettings {
	const found: UpdateSettings = {
		mode: REGISTRY["update.mode"].default,
		feed: REGISTRY["update.feed"].default,
		token: REGISTRY["update.token"].default,
		unit: REGISTRY["update.unit"].default,
		ompUnits: [...REGISTRY["update.ompUnits"].default],
	};
	let db: Database;
	try {
		db = new Database(join(dataDir, DB_FILE), { readonly: true });
	} catch {
		return found;
	}
	try {
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings WHERE key LIKE 'update.%'").all();
		for (const row of rows) {
			try {
				const raw: unknown = JSON.parse(row.value);
				if (row.key === "update.mode") found.mode = REGISTRY["update.mode"].parse(raw);
				else if (row.key === "update.feed") found.feed = REGISTRY["update.feed"].parse(raw);
				else if (row.key === "update.token") found.token = REGISTRY["update.token"].parse(raw);
				else if (row.key === "update.unit") found.unit = REGISTRY["update.unit"].parse(raw);
				else if (row.key === "update.ompUnits") found.ompUnits = [...REGISTRY["update.ompUnits"].parse(raw)];
			} catch {
				// A stored value the validator refuses keeps its default, as the service's Settings does.
			}
		}
	} catch {
		// A database without the settings table yet (the service never ran) has nothing stored.
	} finally {
		db.close();
	}
	return found;
}

/**
 * The stored `vm.packages` and `vm.setup` straight from the database, read-only, for the setup and doctor checks that
 * name the VM template while the database may be at another schema than the binary (a newer binary runs before the
 * service migrates it). A missing database, a missing settings table or a value the validator refuses gives the default.
 */
export function readStoredRecipe(dataDir: string): Recipe {
	let db: Database;
	try {
		db = new Database(join(dataDir, DB_FILE), { readonly: true });
	} catch {
		return DEFAULT_RECIPE;
	}
	let packages: readonly string[] = REGISTRY["vm.packages"].default;
	let setup: readonly string[] = REGISTRY["vm.setup"].default;
	try {
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings WHERE key IN ('vm.packages', 'vm.setup')").all();
		for (const row of rows) {
			try {
				const raw: unknown = JSON.parse(row.value);
				if (row.key === "vm.packages") packages = REGISTRY["vm.packages"].parse(raw);
				else setup = REGISTRY["vm.setup"].parse(raw);
			} catch {
				// A stored value the validator refuses keeps its default, as the service's Settings does.
			}
		}
	} catch {
		// A database without the settings table yet (the service never ran) has nothing stored.
	} finally {
		db.close();
	}
	return recipeFrom(packages, setup);
}

/**
 * Puts the database of a `omp-cloud backup` archive back: extracts `omp-cloud.db` from `archive` next to the live one
 * and renames it into place, dropping the old write-ahead files. The service must be stopped. Threads created since
 * the backup lose their rows; their blobs are swept as orphans at the next start.
 */
export async function restoreDatabase(run: CommandRunner, archive: string, dataDir: string): Promise<void> {
	const scratch = await mkdtemp(join(dataDir, ".restore-"));
	try {
		const extracted = await run(["tar", "-xzf", archive, "-C", scratch, DB_FILE], { timeoutMs: 10 * 60_000 });
		if (extracted.code !== 0) throw new Error(`tar could not read ${DB_FILE} from ${archive}: ${lastLine(extracted.stderr) || `exit ${extracted.code}`}`);
		await rm(join(dataDir, `${DB_FILE}-wal`), { force: true });
		await rm(join(dataDir, `${DB_FILE}-shm`), { force: true });
		await rename(join(scratch, DB_FILE), join(dataDir, DB_FILE));
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
