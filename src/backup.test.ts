import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "./backup";

let root: string;
let dataDir: string;
let live: Database;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-cloud-backup-"));
	dataDir = join(root, "data");
	mkdirSync(join(dataDir, "threads", "t1"), { recursive: true });
	mkdirSync(join(dataDir, "git", "cache", "abc.git"), { recursive: true });
	mkdirSync(join(dataDir, "git", "tmp"), { recursive: true });
	writeFileSync(join(dataDir, "threads", "t1", "secrets.json"), '{"k":"v"}');
	writeFileSync(join(dataDir, "git", "cache", "abc.git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(dataDir, "git", "tmp", "scratch"), "not part of a backup");
	// The service's database: WAL mode, still open, rows that no checkpoint has moved into the main file.
	live = new Database(join(dataDir, "omp-cloud.db"));
	live.run("PRAGMA journal_mode = WAL");
	live.run("PRAGMA wal_autocheckpoint = 0");
	live.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
	live.run("INSERT INTO notes (body) VALUES ('first'), ('second')");
});

afterEach(() => {
	live.close();
	rmSync(root, { recursive: true, force: true });
});

function at(iso: string): () => Date {
	return () => new Date(iso);
}

async function tar(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) throw new Error(`tar ${args.join(" ")} failed`);
	return out;
}

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("backup", () => {
	test("archives a consistent database copy, the blobs and the git cache, not the git scratch space", async () => {
		const result = await backup({ dataDir, keep: 7, now: at("2026-10-20T04:15:00.123Z") });

		expect(result.path).toBe(join(root, "backups", "omp-cloud-20261020T041500Z.tar.gz"));
		expect(result.bytes).toBe(statSync(result.path).size);
		expect(result.removed).toEqual([]);

		const members = (await tar("-tzf", result.path)).split("\n").filter((line) => line !== "");
		expect(members).toContain("omp-cloud.db");
		expect(members).toContain("threads/t1/secrets.json");
		expect(members).toContain("git/cache/abc.git/HEAD");
		expect(members.some((member) => member.startsWith("git/tmp"))).toBe(false);
		expect(members.some((member) => member.endsWith("-wal") || member.endsWith("-shm"))).toBe(false);

		const out = join(root, "restored");
		mkdirSync(out);
		await tar("-xzf", result.path, "-C", out);
		const copy = new Database(join(out, "omp-cloud.db"), { readonly: true });
		try {
			expect(copy.query("SELECT body FROM notes ORDER BY id").all()).toEqual([{ body: "first" }, { body: "second" }]);
		} finally {
			copy.close();
		}
		expect(await Bun.file(join(out, "threads", "t1", "secrets.json")).text()).toBe('{"k":"v"}');
	});

	test("the backup directory is 0700, archives 0600, and nothing but the archive is left behind", async () => {
		const result = await backup({ dataDir, keep: 7, now: at("2026-10-20T04:15:00Z") });
		const dir = join(root, "backups");
		expect(mode(dir)).toBe(0o700);
		expect(mode(result.path)).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["omp-cloud-20261020T041500Z.tar.gz"]);
	});

	test("leftovers older than 6 hours are removed; a fresh one (a run in flight), finished archives and unrelated files stay", async () => {
		const dir = join(root, "backups");
		mkdirSync(join(dir, ".staging-old"), { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, ".staging-old", "omp-cloud.db"), "half a copy");
		writeFileSync(join(dir, ".omp-cloud-20261019T040000Z.tar.gz.partial"), "half an archive");
		const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
		utimesSync(join(dir, ".staging-old"), old, old);
		utimesSync(join(dir, ".omp-cloud-20261019T040000Z.tar.gz.partial"), old, old);
		mkdirSync(join(dir, ".staging-fresh"));
		writeFileSync(join(dir, ".omp-cloud-20261020T040000Z.tar.gz.partial"), "an archive being written");
		writeFileSync(join(dir, "omp-cloud-20261018T040000Z.tar.gz"), "a finished archive");
		writeFileSync(join(dir, "notes.txt"), "mine");
		mkdirSync(join(dir, "staging-not-hidden"));

		await backup({ dataDir, keep: 7, now: at("2026-10-20T04:15:00Z") });

		expect(readdirSync(dir).sort()).toEqual([
			".omp-cloud-20261020T040000Z.tar.gz.partial",
			".staging-fresh",
			"notes.txt",
			"omp-cloud-20261018T040000Z.tar.gz",
			"omp-cloud-20261020T041500Z.tar.gz",
			"staging-not-hidden",
		]);
	});

	test("the live database keeps working and later rows land in the next backup", async () => {
		await backup({ dataDir, keep: 7, now: at("2026-10-20T04:15:00Z") });
		live.run("INSERT INTO notes (body) VALUES ('third')");
		const second = await backup({ dataDir, keep: 7, now: at("2026-10-20T04:15:01Z") });

		const out = join(root, "restored");
		mkdirSync(out);
		await tar("-xzf", second.path, "-C", out);
		const copy = new Database(join(out, "omp-cloud.db"), { readonly: true });
		try {
			expect(copy.query("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 3 });
		} finally {
			copy.close();
		}
	});

	test("retention keeps the newest archives and leaves other files alone", async () => {
		const dir = join(root, "backups");
		mkdirSync(dir, { mode: 0o700 });
		writeFileSync(join(dir, "notes.txt"), "mine");
		const first = await backup({ dataDir, keep: 2, now: at("2026-10-18T04:00:00Z") });
		const second = await backup({ dataDir, keep: 2, now: at("2026-10-19T04:00:00Z") });
		expect([first.removed, second.removed]).toEqual([[], []]);
		const third = await backup({ dataDir, keep: 2, now: at("2026-10-20T04:00:00Z") });

		expect(third.removed).toEqual([first.path]);
		expect(readdirSync(dir).sort()).toEqual(["notes.txt", "omp-cloud-20261019T040000Z.tar.gz", "omp-cloud-20261020T040000Z.tar.gz"]);
	});

	test("a backup directory option is honoured and a missing git cache is fine", async () => {
		rmSync(join(dataDir, "git"), { recursive: true });
		const backupDir = join(root, "elsewhere");
		const result = await backup({ dataDir, backupDir, keep: 1, now: at("2026-10-20T04:15:00Z") });
		expect(result.path.startsWith(backupDir)).toBe(true);
		const members = (await tar("-tzf", result.path)).split("\n");
		expect(members).toContain("omp-cloud.db");
		expect(members.some((member) => member.startsWith("git"))).toBe(false);
	});

	test("a second run in the same second fails and keeps the first archive", async () => {
		const first = await backup({ dataDir, keep: 7, now: at("2026-10-20T04:15:00Z") });
		await expect(backup({ dataDir, keep: 7, now: at("2026-10-20T04:15:00Z") })).rejects.toThrow("exists already");
		expect(existsSync(first.path)).toBe(true);
		expect(readdirSync(join(root, "backups"))).toEqual(["omp-cloud-20261020T041500Z.tar.gz"]);
	});

	test("a data directory without a database and a bad keep are rejected", async () => {
		await expect(backup({ dataDir: join(root, "nowhere"), keep: 7 })).rejects.toThrow("no database");
		expect(existsSync(join(root, "backups"))).toBe(false);
		await expect(backup({ dataDir, keep: 0 })).rejects.toThrow("keep");
	});
});

describe("backup CLI", () => {
	function configFile(): string {
		const path = join(root, "service.json");
		writeFileSync(
			path,
			JSON.stringify({
				listen: "127.0.0.1:8080",
				apiTokenSha256: "ab".repeat(32),
				dataDir,
				vmon: { url: "http://127.0.0.1:3000", keyFile: join(root, "vmon.key"), template: "omp-agent" },
				gateway: { url: "http://10.254.254.1:4000", clientsFile: join(root, "clients.json") },
				broker: { url: "http://127.0.0.1:8765", tokenFile: join(root, "broker.token") },
				models: { default: "anthropic/claude-sonnet-5" },
			}),
		);
		return path;
	}

	/** Runs the checkout's backup task (`scripts/backup.ts`) or the binary's entry (`src/bin.ts backup`). */
	async function run(entry: "task" | "bin", ...args: string[]): Promise<{ code: number; out: string; err: string }> {
		const command =
			entry === "task"
				? ["bun", join(import.meta.dir, "..", "scripts", "backup.ts"), ...args]
				: ["bun", join(import.meta.dir, "bin.ts"), "backup", ...args];
		const proc = Bun.spawn(command, { env: { ...process.env, OMP_CLOUD_CONFIG: "" }, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out, err };
	}

	test.each(["task", "bin"] as const)("%s: --config names the service config; the archive lands in <dataDir>/../backups", async (entry) => {
		const result = await run(entry, "--config", configFile(), "--keep", "3");
		expect(result.err).toBe("");
		expect(result.code).toBe(0);
		const [archive] = readdirSync(join(root, "backups"));
		expect(result.out).toContain(join(root, "backups", archive as string));
		expect(result.out).toContain(" bytes)");
	});

	test.each(["task", "bin"] as const)("%s: bad arguments exit 1 with a message", async (entry) => {
		expect((await run(entry, "--keep", "0")).code).toBe(1);
		expect((await run(entry, "--bogus")).err).toContain("unknown argument");
		expect((await run(entry, "--config", join(root, "missing.json"))).err).toContain("cannot read config");
	});
});
