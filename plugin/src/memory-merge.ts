import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CloudClient } from "./api";
import { CloudError } from "./errors";
import { run } from "./exec";
import { projectBankName, usesDefaultMnemopi, type MemorySettings } from "./mnemopi";
import { type DatabaseCtor, loadDatabase, tarCommand } from "./setup";

/** The thread the cloud memories belong to. */
export interface MemoryTarget {
	id: string;
	/** The local project bank the handoff renamed (`ThreadSummary.memoryBank`); `""` when it renamed none. */
	bank: string;
	/** The thread's creation time (ISO): memories the VM wrote before it came from this machine. */
	since: string;
}

/** The members of the export: `mnemopi.db` and the banks' `mnemopi.db`, nothing else (the VM's archive is untrusted input). */
const MEMBERS = [/^\.\/?$/, /^\.\/mnemopi\.db$/, /^\.\/banks\/?$/, /^\.\/banks\/[A-Za-z0-9_-]{1,64}\/?$/, /^\.\/banks\/[A-Za-z0-9_-]{1,64}\/mnemopi\.db$/];

/** Throws `unexpected entry <name>` for the first listed member the export may not hold. `listing` is the output of `tar -tf`. */
export function checkMemoryMembers(listing: string): void {
	for (const line of listing.split("\n")) {
		const name = line.replace(/\r$/, "");
		if (name === "") continue;
		if (!MEMBERS.some(pattern => pattern.test(name))) throw new Error(`unexpected entry ${name.length > 80 ? `${name.slice(0, 80)}…` : name}`);
	}
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

interface NameRow {
	name: string;
}

interface CountRow {
	n: number;
}

/** The columns `table` has in both databases (`vm` is the attached snapshot), in the local database's order. */
function sharedColumns(db: InstanceType<DatabaseCtor>, table: string): string[] {
	const local = db.query<NameRow, []>(`PRAGMA main.table_info(${table})`).all();
	const remote = new Set(db.query<NameRow, []>(`PRAGMA vm.table_info(${table})`).all().map(c => c.name));
	return local.map(c => c.name).filter(name => remote.has(name));
}

function hasTable(db: InstanceType<DatabaseCtor>, schema: "main" | "vm", table: string): boolean {
	return db.query(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== null;
}

/** Objects replayed in this order: tables, then what refers to them. */
const OBJECT_ORDER: Record<string, number> = { table: 0, index: 1, view: 2, trigger: 3 };

interface SchemaRow {
	type: string;
	name: string;
	sql: string;
}

/**
 * Creates `file` (which must not exist) with the schema of `reference`, a database of this machine's own mnemopi store, and no
 * rows. The statements run are the reference's own text, never anything from the snapshot: the VM's file is untrusted, so its
 * triggers, views and generated columns must not become part of a database omp opens. A virtual table (the full-text index)
 * creates its shadow tables itself, so those are not replayed.
 */
function createLike(file: string, reference: string, Database: DatabaseCtor): void {
	const source = new Database(reference, { readonly: true });
	let objects: SchemaRow[];
	let version: number;
	try {
		objects = source
			.query<SchemaRow, []>("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
			.all();
		version = source.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
	} finally {
		source.close();
	}
	const virtual = objects.filter(o => o.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql)).map(o => o.name);
	const replay = objects
		.filter(o => o.type in OBJECT_ORDER && !(o.type === "table" && virtual.some(v => o.name.startsWith(`${v}_`))))
		.sort((a, b) => (OBJECT_ORDER[a.type] ?? 0) - (OBJECT_ORDER[b.type] ?? 0));
	const db = new Database(file);
	try {
		db.run("BEGIN");
		for (const o of replay) db.run(o.sql);
		db.run("COMMIT");
		db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
	} finally {
		db.close();
	}
}

/**
 * Inserts the working memories `snapshotDb` (a cloud agent's database) holds and `localDb` lacks: rows created after `since`
 * (ISO time) whose id and content are not in `localDb` yet, with their annotations. The local FTS triggers index the rows, and
 * omp embeds them the next time it opens the store. The snapshot is untrusted: its schema may not run functions
 * (`trusted_schema` off) and only the columns both databases have are copied.
 *
 * A `localDb` that does not exist is never made from the snapshot's file. It is created with the schema of `reference` (a
 * local database of the same store) and merged before it is moved into place. Without a `reference` nothing is merged and
 * `deferred` says why: the rows stay in the export and merge on a later turn, once omp has made a local database.
 * (pi-mnemopi, which would make the database itself, is not a module a compiled omp serves to plugins.)
 */
export function mergeWorkingMemory(localDb: string, snapshotDb: string, since: string, Database: DatabaseCtor, reference?: string): { inserted: number; deferred?: string } {
	if (existsSync(localDb)) return { inserted: mergeInto(localDb, snapshotDb, since, Database) };
	if (reference === undefined || !existsSync(reference)) {
		return { inserted: 0, deferred: `${localDb} does not exist and there is no local mnemopi database to take its schema from; they merge once omp has made one` };
	}
	mkdirSync(dirname(localDb), { recursive: true });
	const partial = `${localDb}.${process.pid}.tmp`;
	rmSync(partial, { force: true });
	try {
		createLike(partial, reference, Database);
		const inserted = mergeInto(partial, snapshotDb, since, Database);
		renameSync(partial, localDb);
		return { inserted };
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	}
}

function mergeInto(localDb: string, snapshotDb: string, since: string, Database: DatabaseCtor): number {
	const db = new Database(localDb);
	try {
		db.run("PRAGMA busy_timeout = 5000");
		db.run("PRAGMA trusted_schema = OFF");
		db.run("ATTACH DATABASE ? AS vm", [snapshotDb]);
		try {
			return mergeAttached(db, since);
		} finally {
			db.run("DETACH DATABASE vm");
		}
	} finally {
		db.close();
	}
}

function mergeAttached(db: InstanceType<DatabaseCtor>, since: string): number {
	const columns = sharedColumns(db, "working_memory");
	if (!columns.includes("id") || !columns.includes("content") || !columns.includes("created_at")) return 0;
	const list = columns.map(quote).join(", ");
	const annotations = hasTable(db, "main", "annotations") && hasTable(db, "vm", "annotations");
	const annotationColumns = annotations ? sharedColumns(db, "annotations").filter(c => c !== "id") : [];
	const copyAnnotations = ["memory_id", "kind", "value"].every(c => annotationColumns.includes(c));
	db.run("BEGIN IMMEDIATE");
	try {
		db.run("CREATE TEMP TABLE merged(id TEXT PRIMARY KEY)");
		// `datetime()` on both sides: sqlite's own `created_at` default and an ISO timestamp compare as text otherwise.
		db.run(
			`INSERT INTO merged SELECT v.id FROM vm.working_memory v
			 WHERE datetime(v.created_at) > datetime(?)
			   AND NOT EXISTS (SELECT 1 FROM main.working_memory m WHERE m.id = v.id OR m.content = v.content)
			   AND NOT EXISTS (SELECT 1 FROM vm.working_memory w WHERE w.content = v.content AND w.rowid < v.rowid)`,
			[since],
		);
		db.run(`INSERT INTO main.working_memory(${list}) SELECT ${list} FROM vm.working_memory WHERE id IN (SELECT id FROM merged)`);
		if (copyAnnotations) {
			const cols = annotationColumns.map(quote).join(", ");
			db.run(`INSERT OR IGNORE INTO main.annotations(${cols}) SELECT ${cols} FROM vm.annotations WHERE memory_id IN (SELECT id FROM merged)`);
		}
		const inserted = db.query<CountRow, []>("SELECT count(*) AS n FROM merged").get()?.n ?? 0;
		db.run("DROP TABLE temp.merged");
		db.run("COMMIT");
		return inserted;
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
}

/** The path of the database member `rel` of an extracted export, undefined when the archive has none; a link in its place is refused. */
function memberDb(root: string, rel: string): string | undefined {
	const file = join(root, rel);
	if (!existsSync(file)) return undefined;
	const info = lstatSync(file);
	if (!info.isFile() || info.nlink !== 1) throw new Error(`unexpected entry ./${rel}`);
	return file;
}

/** A database of this machine's own mnemopi store whose schema a new one can copy: the default database, else any bank's. */
function localReference(store: string): string | undefined {
	const main = join(store, "mnemopi.db");
	if (existsSync(main)) return main;
	try {
		for (const entry of readdirSync(join(store, "banks"), { withFileTypes: true })) {
			const file = join(store, "banks", entry.name, "mnemopi.db");
			if (entry.isDirectory() && existsSync(file)) return file;
		}
	} catch {}
	return undefined;
}

/** What the merge of one export needs. */
export interface MergeInput {
	client: Pick<CloudClient, "whoami" | "downloadMemory">;
	target: MemoryTarget;
	settings: MemorySettings;
	agentDir: string;
	/** `bun:sqlite`'s `Database`; loaded when omitted, and the merge is skipped when it cannot be. */
	Database?: DatabaseCtor;
	signal?: AbortSignal;
	/** Told why a database could not be made yet (no local mnemopi database to take the schema from); the merge is not an error then. */
	onDeferred?: (message: string) => void;
}

/**
 * Downloads the cloud agent's memory of `target` and merges it into this machine's mnemopi store: the snapshot's default
 * database into `<agentDir>/memories/mnemopi/mnemopi.db`, and the VM's project bank into the bank the handoff renamed.
 * Returns the number of working memories inserted; undefined when nothing was to merge (the backend is not the default
 * mnemopi store, the service has no `threads.memory`, or the thread has no memory yet). A rejected archive or a failed merge throws.
 */
export async function mergeCloudMemory(input: MergeInput): Promise<number | undefined> {
	const { client, target, settings, agentDir } = input;
	if (!usesDefaultMnemopi(settings)) return undefined;
	const who = await client.whoami({ signal: input.signal });
	if (!who.capabilities.includes("threads.memory")) return undefined;
	const Database = input.Database ?? (await loadDatabase());
	if (!Database) return undefined;
	const work = await mkdtemp(join(tmpdir(), "omp-cloud-memory-"));
	try {
		const archive = join(work, "memory.tar");
		try {
			await client.downloadMemory(target.id, archive, { signal: input.signal });
		} catch (e) {
			if (e instanceof CloudError && e.status === 404) return undefined;
			throw e;
		}
		const tar = tarCommand();
		const listed = await run(tar, ["-tf", archive]);
		if (listed.code !== 0) throw new Error(`cannot list the memory archive: ${listed.stderr.trim().slice(0, 200) || `tar exit ${listed.code}`}`);
		checkMemoryMembers(listed.stdout);
		const root = join(work, "snapshot");
		await mkdir(root);
		const extracted = await run(tar, ["-xf", archive, "-C", root]);
		if (extracted.code !== 0) throw new Error(`cannot unpack the memory archive: ${extracted.stderr.trim().slice(0, 200) || `tar exit ${extracted.code}`}`);

		const store = join(agentDir, "memories", "mnemopi");
		let inserted = 0;
		const merge = (db: string, snapshot: string): void => {
			const merged = mergeWorkingMemory(db, snapshot, target.since, Database, localReference(store));
			inserted += merged.inserted;
			if (merged.deferred !== undefined) input.onDeferred?.(`the cloud memories of ${target.id} are not merged yet: ${merged.deferred}`);
		};
		const main = memberDb(root, "mnemopi.db");
		if (main) merge(join(store, "mnemopi.db"), main);
		if (target.bank !== "" && who.vmWorkspace !== "") {
			const vmBank = projectBankName(who.vmWorkspace, settings.bank);
			const bank = memberDb(root, `banks/${vmBank}/mnemopi.db`);
			if (bank) merge(join(store, "banks", target.bank, "mnemopi.db"), bank);
		}
		return inserted;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}
