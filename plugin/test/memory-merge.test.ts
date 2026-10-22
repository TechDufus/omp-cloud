import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import type { CloudClient } from "../src/api";
import { CloudError } from "../src/errors";
import { run } from "../src/exec";
import { checkMemoryMembers, mergeCloudMemory, mergeWorkingMemory } from "../src/memory-merge";
import { projectBankName, type MemorySettings } from "../src/mnemopi";
import type { Whoami } from "../src/types";
import { whoami } from "./builders";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

const SINCE = "2026-10-20T12:00:00.000Z";
const BEFORE = "2026-10-19 08:00:00";
const AFTER = "2026-10-21 08:00:00";

interface Row {
	content: string;
	/** `created_at` as sqlite writes it; the store's own default (now) when omitted. */
	at?: string;
}

/** A mnemopi database made by pi-mnemopi's own store, so its schema and FTS triggers are the real ones. */
async function makeDb(file: string, rows: Row[]): Promise<string[]> {
	await mkdir(join(file, ".."), { recursive: true });
	const store = new Mnemopi({ dbPath: file, noEmbeddings: true, proactiveLinking: false });
	const ids = rows.map(r => store.remember(r.content));
	store.close();
	const db = new Database(file);
	for (const [i, r] of rows.entries()) if (r.at) db.run("UPDATE working_memory SET created_at = ? WHERE id = ?", [r.at, ids[i] as string]);
	db.close();
	return ids;
}

function contents(file: string): string[] {
	const db = new Database(file, { readonly: true });
	try {
		return db
			.query<{ content: string }, []>("SELECT content FROM working_memory ORDER BY content")
			.all()
			.map(r => r.content);
	} finally {
		db.close();
	}
}

function found(file: string, term: string): string[] {
	const db = new Database(file, { readonly: true });
	try {
		return db
			.query<{ content: string }, [string]>("SELECT content FROM fts_working WHERE fts_working MATCH ?")
			.all(term)
			.map(r => r.content);
	} finally {
		db.close();
	}
}

describe("mergeWorkingMemory", () => {
	async function pair(local: Row[], vm: Row[]): Promise<{ local: string; vm: string; vmIds: string[] }> {
		const dir = await tmp("omp-cloud-merge-");
		await makeDb(join(dir, "local.db"), local);
		const vmIds = await makeDb(join(dir, "vm.db"), vm);
		return { local: join(dir, "local.db"), vm: join(dir, "vm.db"), vmIds };
	}

	test("a new row of the VM is inserted and found by a full-text query", async () => {
		const p = await pair([{ content: "the laptop knows BLUE-HERON", at: BEFORE }], [{ content: "the cloud learned RED-FOX", at: AFTER }]);
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database)).toEqual({ inserted: 1 });
		expect(contents(p.local)).toEqual(["the cloud learned RED-FOX", "the laptop knows BLUE-HERON"]);
		expect(found(p.local, "RED")).toEqual(["the cloud learned RED-FOX"]);
	});

	test("a row with content the local database already has is skipped, whatever its id", async () => {
		const p = await pair([{ content: "same fact", at: BEFORE }], [{ content: "same fact", at: AFTER }, { content: "different fact", at: AFTER }]);
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database)).toEqual({ inserted: 1 });
		expect(contents(p.local)).toEqual(["different fact", "same fact"]);
	});

	test("a row with an id the local database already has is skipped", async () => {
		const p = await pair([], [{ content: "one", at: AFTER }]);
		// The same id, other content: the local row stays.
		const db = new Database(p.local);
		db.run("INSERT INTO working_memory(id, content, created_at) VALUES (?, 'local text', ?)", [p.vmIds[0] as string, AFTER]);
		db.close();
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database)).toEqual({ inserted: 0 });
		expect(contents(p.local)).toEqual(["local text"]);
	});

	test("rows created before `since` came from this machine and are skipped", async () => {
		const p = await pair([], [{ content: "copied at handoff", at: BEFORE }, { content: "learned in the cloud", at: AFTER }]);
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database)).toEqual({ inserted: 1 });
		expect(contents(p.local)).toEqual(["learned in the cloud"]);
	});

	test("two VM rows with the same content arrive once", async () => {
		const p = await pair([], [{ content: "twice", at: AFTER }, { content: "twice", at: AFTER }]);
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database)).toEqual({ inserted: 1 });
		expect(contents(p.local)).toEqual(["twice"]);
	});

	test("a second merge of the same snapshot inserts nothing", async () => {
		const p = await pair([], [{ content: "a", at: AFTER }, { content: "b", at: AFTER }]);
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database).inserted).toBe(2);
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database).inserted).toBe(0);
		expect(contents(p.local)).toEqual(["a", "b"]);
		expect(found(p.local, "a")).toEqual(["a"]);
	});

	test("annotations of the merged rows are copied; those of skipped rows are not", async () => {
		const p = await pair([{ content: "dup", at: BEFORE }], [{ content: "new row", at: AFTER }, { content: "dup", at: AFTER }]);
		const vm = new Database(p.vm);
		vm.run("DELETE FROM annotations");
		const ids = vm.query<{ id: string; content: string }, []>("SELECT id, content FROM working_memory").all();
		for (const row of ids) vm.run("INSERT INTO annotations(memory_id, kind, value, source, confidence) VALUES (?, 'mentions', ?, 'test', 0.9)", [row.id, `about ${row.content}`]);
		vm.close();
		const local = new Database(p.local);
		local.run("DELETE FROM annotations");
		local.close();
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database).inserted).toBe(1);
		const check = new Database(p.local, { readonly: true });
		expect(check.query("SELECT value, source, confidence FROM annotations").all()).toEqual([{ value: "about new row", source: "test", confidence: 0.9 }]);
		check.close();
		expect(mergeWorkingMemory(p.local, p.vm, SINCE, Database).inserted).toBe(0);
	});

	test("a missing local database is created by copying the snapshot into place", async () => {
		const dir = await tmp("omp-cloud-merge-");
		await makeDb(join(dir, "vm.db"), [{ content: "first cloud memory", at: AFTER }]);
		const local = join(dir, "memories", "mnemopi", "banks", "app-1", "mnemopi.db");
		expect(mergeWorkingMemory(local, join(dir, "vm.db"), SINCE, Database)).toEqual({ inserted: 1 });
		expect(contents(local)).toEqual(["first cloud memory"]);
		expect(found(local, "cloud")).toEqual(["first cloud memory"]);
	});

	test("a snapshot with fewer columns merges through the columns both databases have", async () => {
		const dir = await tmp("omp-cloud-merge-");
		await makeDb(join(dir, "local.db"), []);
		const vm = new Database(join(dir, "vm.db"));
		vm.run("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TIMESTAMP, extra TEXT)");
		vm.run("INSERT INTO working_memory VALUES ('x1', 'sparse row', ?, 'not copied')", [AFTER]);
		vm.close();
		expect(mergeWorkingMemory(join(dir, "local.db"), join(dir, "vm.db"), SINCE, Database)).toEqual({ inserted: 1 });
		expect(contents(join(dir, "local.db"))).toEqual(["sparse row"]);
	});

	test("a snapshot without a working_memory table merges nothing", async () => {
		const dir = await tmp("omp-cloud-merge-");
		await makeDb(join(dir, "local.db"), [{ content: "kept", at: BEFORE }]);
		const vm = new Database(join(dir, "vm.db"));
		vm.run("CREATE TABLE other (x TEXT)");
		vm.close();
		expect(mergeWorkingMemory(join(dir, "local.db"), join(dir, "vm.db"), SINCE, Database)).toEqual({ inserted: 0 });
		expect(contents(join(dir, "local.db"))).toEqual(["kept"]);
	});
});

describe("checkMemoryMembers", () => {
	test("accepts the members of an export", () => {
		expect(() => checkMemoryMembers("./\n./mnemopi.db\n./banks/\n./banks/app-1x2y/\n./banks/app-1x2y/mnemopi.db\n")).not.toThrow();
		expect(() => checkMemoryMembers("./\n./banks/\n")).not.toThrow();
		expect(() => checkMemoryMembers("")).not.toThrow();
	});

	test("names the first unexpected entry", () => {
		for (const bad of ["./notes.txt", "../escape", "/etc/passwd", "./banks/../../x", "./banks/a b/mnemopi.db", "./banks/x/mnemopi.db-wal", "./banks/x/sub/mnemopi.db", "./mnemopi.db/", "./banks/x/other.db"]) {
			expect(() => checkMemoryMembers(`./\n./mnemopi.db\n${bad}\n`)).toThrow(`unexpected entry ${bad}`);
		}
		expect(() => checkMemoryMembers(`./banks/${"x".repeat(65)}/\n`)).toThrow("unexpected entry");
	});
});

describe("mergeCloudMemory", () => {
	const VM = "/home/user/work";
	const settings: MemorySettings = { backend: "mnemopi", scoping: "per-project", bank: undefined, dbPath: undefined };
	const vmBank = projectBankName(VM, undefined);

	interface Rig {
		agentDir: string;
		export: string;
		calls: string[];
		client: Pick<CloudClient, "whoami" | "downloadMemory">;
		local: (...rel: string[]) => string;
	}

	/** `build` fills the export's directory; the client serves it as a tar. */
	async function rig(build: (dir: string) => Promise<void>, who: Partial<Whoami> = {}): Promise<Rig> {
		const root = await tmp("omp-cloud-hook-");
		const dir = join(root, "export");
		await mkdir(dir, { recursive: true });
		await build(dir);
		const archive = join(root, "memory.tar");
		expect((await run("tar", ["-cf", archive, "-C", dir, "."])).code).toBe(0);
		const agentDir = join(root, "agent");
		const calls: string[] = [];
		const client: Pick<CloudClient, "whoami" | "downloadMemory"> = {
			async whoami() {
				calls.push("whoami");
				return whoami({ capabilities: ["threads.memory"], vmWorkspace: VM, ...who });
			},
			async downloadMemory(id, dest) {
				calls.push(`download ${id}`);
				await copyFile(archive, dest);
			},
		};
		return { agentDir, export: dir, calls, client, local: (...rel) => join(agentDir, "memories", "mnemopi", ...rel) };
	}

	const target = { id: "k3x9fa2m7q1z", bank: "app-laptop", since: SINCE };

	test("merges the default database, and the VM's project bank into the bank the handoff renamed; other banks are ignored", async () => {
		const r = await rig(async dir => {
			await makeDb(join(dir, "mnemopi.db"), [{ content: "global cloud memory", at: AFTER }]);
			await makeDb(join(dir, "banks", vmBank, "mnemopi.db"), [{ content: "project cloud memory", at: AFTER }]);
			await makeDb(join(dir, "banks", "somebody-else", "mnemopi.db"), [{ content: "foreign bank", at: AFTER }]);
		});
		await makeDb(r.local("mnemopi.db"), [{ content: "global local memory", at: BEFORE }]);
		await makeDb(r.local("banks", "app-laptop", "mnemopi.db"), [{ content: "project local memory", at: BEFORE }]);
		expect(await mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).toBe(2);
		expect(contents(r.local("mnemopi.db"))).toEqual(["global cloud memory", "global local memory"]);
		expect(contents(r.local("banks", "app-laptop", "mnemopi.db"))).toEqual(["project cloud memory", "project local memory"]);
		expect(await Bun.file(r.local("banks", "somebody-else", "mnemopi.db")).exists()).toBe(false);
		expect(r.calls).toEqual(["whoami", "download k3x9fa2m7q1z"]);
		expect(await mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).toBe(0);
	});

	test("a missing local project bank is created from the VM's", async () => {
		const r = await rig(async dir => {
			await makeDb(join(dir, "banks", vmBank, "mnemopi.db"), [{ content: "project cloud memory", at: AFTER }]);
		});
		expect(await mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).toBe(1);
		expect(found(r.local("banks", "app-laptop", "mnemopi.db"), "project")).toEqual(["project cloud memory"]);
	});

	test("without a handoff bank only the default database merges", async () => {
		const r = await rig(async dir => {
			await makeDb(join(dir, "mnemopi.db"), [{ content: "global cloud memory", at: AFTER }]);
			await makeDb(join(dir, "banks", vmBank, "mnemopi.db"), [{ content: "project cloud memory", at: AFTER }]);
		});
		expect(await mergeCloudMemory({ client: r.client, target: { ...target, bank: "" }, settings, agentDir: r.agentDir })).toBe(1);
		expect(await Bun.file(r.local("banks", vmBank, "mnemopi.db")).exists()).toBe(false);
	});

	test("the VM's bank name follows mnemopi.bank", async () => {
		const named = projectBankName(VM, "team");
		const r = await rig(async dir => {
			await makeDb(join(dir, "banks", named, "mnemopi.db"), [{ content: "team memory", at: AFTER }]);
			await makeDb(join(dir, "banks", vmBank, "mnemopi.db"), [{ content: "unnamed memory", at: AFTER }]);
		});
		expect(await mergeCloudMemory({ client: r.client, target, settings: { ...settings, bank: "team" }, agentDir: r.agentDir })).toBe(1);
		expect(contents(r.local("banks", "app-laptop", "mnemopi.db"))).toEqual(["team memory"]);
	});

	test("an archive with an entry outside the export is rejected and nothing merges", async () => {
		const r = await rig(async dir => {
			await makeDb(join(dir, "mnemopi.db"), [{ content: "global cloud memory", at: AFTER }]);
			await writeFile(join(dir, "payload.sh"), "echo no");
		});
		await expect(mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).rejects.toThrow("unexpected entry ./payload.sh");
		expect(await Bun.file(r.local("mnemopi.db")).exists()).toBe(false);
	});

	test("a link in place of a database is rejected", async () => {
		const r = await rig(async dir => {
			const secret = join(dir, "..", "secret.db");
			await makeDb(secret, [{ content: "never merged", at: AFTER }]);
			await symlink(secret, join(dir, "mnemopi.db"));
		});
		await expect(mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).rejects.toThrow("unexpected entry ./mnemopi.db");
		expect(await Bun.file(r.local("mnemopi.db")).exists()).toBe(false);
	});

	test("an archive that is not a tar is rejected", async () => {
		const r = await rig(async () => {});
		r.client.downloadMemory = async (_id, dest) => void (await writeFile(dest, "not a tar"));
		await expect(mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).rejects.toThrow("cannot list the memory archive");
	});

	describe("gating", () => {
		const exported = async (dir: string): Promise<void> => void (await makeDb(join(dir, "mnemopi.db"), [{ content: "cloud memory", at: AFTER }]));

		test("another memory backend or a custom db path downloads nothing", async () => {
			const r = await rig(exported);
			for (const off of [{ ...settings, backend: "off" }, { ...settings, backend: "hindsight" }, { ...settings, dbPath: "/data/m.db" }]) {
				expect(await mergeCloudMemory({ client: r.client, target, settings: off, agentDir: r.agentDir })).toBeUndefined();
			}
			expect(r.calls).toEqual([]);
		});

		test("a service without threads.memory downloads nothing", async () => {
			const r = await rig(exported, { capabilities: ["threads.paging"] });
			expect(await mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).toBeUndefined();
			expect(r.calls).toEqual(["whoami"]);
			expect(await Bun.file(r.local("mnemopi.db")).exists()).toBe(false);
		});

		test("a thread without memory yet (404) merges nothing and is not an error", async () => {
			const r = await rig(exported);
			r.client.downloadMemory = async () => {
				throw new CloudError({ code: "not_found", status: 404, message: "no memory yet", retriable: false, outcomeKnown: true });
			};
			expect(await mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).toBeUndefined();
		});

		test("any other download failure is an error", async () => {
			const r = await rig(exported);
			r.client.downloadMemory = async () => {
				throw new CloudError({ code: "unavailable", status: 503, message: "busy", retriable: true, outcomeKnown: true });
			};
			await expect(mergeCloudMemory({ client: r.client, target, settings, agentDir: r.agentDir })).rejects.toThrow("busy");
		});
	});
});
