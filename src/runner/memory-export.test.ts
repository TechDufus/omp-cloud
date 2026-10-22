import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClients } from "../gateway/clients";
import type { Store } from "../store";
import type { Turn } from "../store/types";
import { type Exec, ExecError, execFailure, localExec } from "./exec";
import { exportMemory, memoryExportScript, VM_MEMORY_DIR } from "./memory-export";
import { exit, fakeVm, fakeVmon, type FakeVm, HEAD, openEnv, promptResult, response, sandboxWithOmp, seedThread } from "./test-support";
import { type ThreadEnv, ThreadRunner } from "./thread";

const HAS_SQLITE3 = Bun.which("sqlite3") !== null;

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-memory-export-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function writeMemoryDb(path: string, contents: string[]): void {
	const db = new Database(path, { create: true });
	db.run("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
	for (const [i, content] of contents.entries()) db.query("INSERT INTO working_memory (id, content) VALUES (?, ?)").run(`m${i}`, content);
	db.close();
}

function memoryRows(path: string): string[] {
	const db = new Database(path, { readonly: true });
	try {
		return db.query<{ content: string }, []>("SELECT content FROM working_memory").all().map(row => row.content);
	} finally {
		db.close();
	}
}

async function tarMembers(tar: string): Promise<string[]> {
	const proc = Bun.spawn(["tar", "-tf", tar], { stdout: "pipe" });
	const names = (await new Response(proc.stdout).text()).split("\n").filter(name => name !== "");
	await proc.exited;
	return names.sort();
}

/** `localExec` with a PATH that holds no `sqlite3` (and nothing else the script needs after its guard). */
function withoutSqlite3(): Exec {
	const exec = localExec();
	return (command, options) => exec(`PATH=/nonexistent; ${command}`, options);
}

describe("memoryExportScript", () => {
	test("a VM without a memory directory, or without sqlite3, exports nothing", async () => {
		const tarPath = join(dir, "out.tar");
		expect(await exportMemory(localExec(), { src: join(dir, "none"), work: join(dir, "work"), tarPath })).toBe(false);

		await mkdir(join(dir, "mem"));
		expect(await exportMemory(withoutSqlite3(), { src: join(dir, "mem"), work: join(dir, "work"), tarPath })).toBe(false);
		expect(await Bun.file(tarPath).exists()).toBe(false);
		expect(await Bun.file(join(dir, "work")).exists()).toBe(false);
	});

	test("the script exits 3 without a memory directory and 4 without sqlite3", async () => {
		const script = (src: string) => memoryExportScript(src, join(dir, "work"), join(dir, "out.tar"));
		const missing = await localExec()(script(join(dir, "none"))).catch((error: unknown) => error);
		if (!(missing instanceof ExecError)) throw new Error("the script did not fail");
		expect(missing.exitCode).toBe(3);
		await mkdir(join(dir, "mem"));
		const noSqlite = await withoutSqlite3()(script(join(dir, "mem"))).catch((error: unknown) => error);
		if (!(noSqlite instanceof ExecError)) throw new Error("the script did not fail");
		expect(noSqlite.exitCode).toBe(4);
	});

	test.skipIf(!HAS_SQLITE3)("snapshots the default store and every bank that has a database, skipping directories without one", async () => {
		const src = join(dir, "mem");
		await mkdir(join(src, "banks", "proj-abc"), { recursive: true });
		await mkdir(join(src, "banks", "empty"), { recursive: true });
		writeMemoryDb(join(src, "mnemopi.db"), ["global fact"]);
		writeMemoryDb(join(src, "banks", "proj-abc", "mnemopi.db"), ["project fact"]);
		const tarPath = join(dir, "out.tar");

		expect(await exportMemory(localExec(), { src, work: join(dir, "work"), tarPath })).toBe(true);

		expect(await tarMembers(tarPath)).toEqual(["./", "./banks/", "./banks/proj-abc/", "./banks/proj-abc/mnemopi.db", "./mnemopi.db"]);
		expect(await Bun.file(join(dir, "work")).exists()).toBe(false);
		const out = join(dir, "extracted");
		await mkdir(out);
		await Bun.spawn(["tar", "-xf", tarPath, "-C", out]).exited;
		expect(memoryRows(join(out, "mnemopi.db"))).toEqual(["global fact"]);
		expect(memoryRows(join(out, "banks", "proj-abc", "mnemopi.db"))).toEqual(["project fact"]);
	});

	test.skipIf(!HAS_SQLITE3)("a bank-only memory directory exports without a default store", async () => {
		const src = join(dir, "mem");
		await mkdir(join(src, "banks", "b1"), { recursive: true });
		writeMemoryDb(join(src, "banks", "b1", "mnemopi.db"), ["only"]);
		const tarPath = join(dir, "out.tar");
		expect(await exportMemory(localExec(), { src, work: join(dir, "work"), tarPath })).toBe(true);
		expect(await tarMembers(tarPath)).toEqual(["./", "./banks/", "./banks/b1/", "./banks/b1/mnemopi.db"]);
	});

	test.skipIf(!HAS_SQLITE3)("a database sqlite3 cannot read is an error, not a skip", async () => {
		const src = join(dir, "mem");
		await mkdir(src, { recursive: true });
		await writeFile(join(src, "mnemopi.db"), "this is not a database, just text that is long enough to be read as a header");
		const failure = await exportMemory(localExec(), { src, work: join(dir, "work"), tarPath: join(dir, "out.tar") }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ExecError);
	});

	// The sandbox's exec shell is `bash -l -c`; the VM image's ~/.bash_logout ends in `[ -x /usr/bin/clear_console ] && ...`, which fails
	// under an inherited `set -e` on its bash 5.2. This host's bash 5.3 spares that exact form, so the logout here fails plainly.
	test("a login shell whose logout fails still reports the script's own exit codes", async () => {
		const home = join(dir, "home");
		await mkdir(home);
		await writeFile(join(home, ".bash_logout"), "false\n");
		const login: Exec = async command => {
			const proc = Bun.spawn(["bash", "-l", "-c", command], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
			if (code !== 0) throw new ExecError(command, code, stderr);
			return stdout;
		};
		// The failure being guarded against: under `set -e` that logout turns `exit 3` into 1.
		const plain = await login("set -e\n[ -d /nonexistent ] || exit 3").catch((error: unknown) => error);
		if (!(plain instanceof ExecError)) throw new Error("the plain script did not fail");
		expect(plain.exitCode).toBe(1);

		expect(await exportMemory(login, { src: join(dir, "none"), work: join(dir, "work"), tarPath: join(dir, "out.tar") })).toBe(false);
		await mkdir(join(dir, "mem"));
		expect(await exportMemory((command, options) => login(`PATH=/nonexistent; ${command}`, options), { src: join(dir, "mem"), work: join(dir, "work"), tarPath: join(dir, "out.tar") })).toBe(false);
		if (HAS_SQLITE3) {
			writeMemoryDb(join(dir, "mem", "mnemopi.db"), ["through a login shell"]);
			expect(await exportMemory(login, { src: join(dir, "mem"), work: join(dir, "work"), tarPath: join(dir, "out.tar") })).toBe(true);
		}
	});

	test.skipIf(!HAS_SQLITE3)("a real failure names sqlite3's last stderr line", async () => {
		const src = join(dir, "mem");
		await mkdir(src, { recursive: true });
		await writeFile(join(src, "mnemopi.db"), "this is not a database, just text that is long enough to be read as a header");
		const failure = await exportMemory(localExec(), { src, work: join(dir, "work"), tarPath: join(dir, "out.tar") }).catch((error: unknown) => error);
		expect(execFailure(failure)).toMatch(/^exit 1: .*(not a database|file is not a database)/i);
		expect(execFailure(new ExecError("true", 2, "\n"))).toBe("exit 2, no error output");
		expect(execFailure(new Error("boom"))).toBe("boom");
	});

	test("the VM's default directory is omp's mnemopi store under the agent dir", () => {
		expect(VM_MEMORY_DIR).toBe("/home/user/.omp/agent/memories/mnemopi");
	});
});

describe("the turn's memory export", () => {
	let store: Store;
	let gateway: GatewayClients;
	let env: ThreadEnv;
	const runners: ThreadRunner[] = [];

	beforeEach(async () => {
		({ store, gateway, env } = await openEnv(dir));
	});

	afterEach(async () => {
		await Promise.all(runners.splice(0).map(runner => runner.detach()));
		store.close();
	});

	async function runTurn(vm: FakeVm): Promise<{ turn: Turn; id: string }> {
		const id = await seedThread(store, gateway, 1);
		const omp = sandboxWithOmp(vm, promptId => [response(promptId, "prompt"), promptResult(promptId, true)]);
		const runner = new ThreadRunner({ ...env, vmon: fakeVmon(omp.sandbox).vmon }, id);
		runners.push(runner);
		const queued = store.enqueueTurn(id, "work", "owner");
		const { promise: ended, resolve } = Promise.withResolvers<void>();
		const unsubscribe = store.subscribeAll({
			event: (threadId, event) => {
				if (threadId !== id || event.turn !== queued.id || (event.kind !== "turn_done" && event.kind !== "turn_failed")) return;
				unsubscribe();
				resolve();
			},
			deleted: () => {},
		});
		runner.wake();
		await ended;
		const turn = store.turns(id).find(t => t.id === queued.id);
		if (turn === undefined) throw new Error("the turn vanished");
		return { turn, id };
	}

	const noticesOf = (id: string): string[] =>
		store
			.events(id, 0, 1000)
			.filter(event => event.kind === "notice")
			.map(event => event.text);

	test("after the turn the VM's memory tar is downloaded into memory.tar and removed from the VM", async () => {
		const vm = fakeVm({ dirty: false, head: HEAD });
		const { turn, id } = await runTurn(vm);

		expect(turn.state).toBe("done");
		expect(await (await store.blob(id, "memory.tar"))?.text()).toBe("content of /tmp/omp-cloud-memory.tar");
		const script = vm.commands.findIndex(command => command.includes("VACUUM INTO"));
		const conversation = vm.commands.findIndex(command => command.includes("omp-cloud-session-export.tar"));
		expect(script).toBeGreaterThan(-1);
		expect(script).toBeGreaterThan(conversation);
		expect(vm.commands).toContain("rm -f '/tmp/omp-cloud-memory.tar'");
		expect(noticesOf(id)).toEqual([]);
	});

	test.each([3, 4])("exit %i (no memory, or no sqlite3 in the VM) stores nothing and says nothing", async code => {
		const vm = fakeVm({
			dirty: false,
			head: HEAD,
			onCommand: command => {
				if (command.includes("VACUUM INTO")) throw exit(code);
			},
		});
		const { turn, id } = await runTurn(vm);

		expect(turn.state).toBe("done");
		expect(await store.blob(id, "memory.tar")).toBeNull();
		expect(noticesOf(id)).toEqual([]);
	});

	test("any other failure is a notice and the turn still completes", async () => {
		const vm = fakeVm({
			dirty: false,
			head: HEAD,
			onCommand: command => {
				if (command.includes("VACUUM INTO")) throw exit(1);
			},
		});
		const { turn, id } = await runTurn(vm);

		expect(turn.state).toBe("done");
		expect(await store.blob(id, "memory.tar")).toBeNull();
		expect(noticesOf(id).filter(text => text.startsWith("the memory could not be saved: "))).toHaveLength(1);
	});
});
