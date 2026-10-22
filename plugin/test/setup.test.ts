import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../src/exec";
import { buildSetup, MEMORY_WARNING, sanitizeSettings, type SetupOptions } from "../src/setup";
import { UserError } from "../src/types";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

async function put(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

async function listAll(dir: string, prefix = ""): Promise<string[]> {
	const out: string[] = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...(await listAll(join(dir, e.name), rel)));
		else out.push(rel);
	}
	return out.sort();
}

async function extract(archive: string): Promise<string> {
	const dir = await tmp("omp-cloud-x-");
	const r = await run("tar", ["-xzf", archive, "-C", dir]);
	expect(r.code).toBe(0);
	return dir;
}

interface Layout {
	agentDir: string;
	elsewhere: string;
	opts: SetupOptions;
}

/** Every file an owner's `~/.omp/agent` typically holds, shippable or not. */
async function layout(over: Partial<SetupOptions> = {}): Promise<Layout> {
	const agentDir = await tmp("omp-cloud-agent-");
	const elsewhere = await tmp("omp-cloud-else-");
	// shipped
	await put(join(elsewhere, "AGENTS.md"), "# OMP User Preferences\n");
	await symlink(join(elsewhere, "AGENTS.md"), join(agentDir, "AGENTS.md"));
	await put(join(agentDir, "RULES.md"), "rules\n");
	await put(join(agentDir, "WATCHDOG.md"), "watchdog\n");
	await put(join(agentDir, "config.yml"), "modelRoles:\n  default: a/b\n");
	await put(join(agentDir, "lsp.json"), '{"servers":{}}');
	await put(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
	await put(join(agentDir, "skills", "demo", "refs", "deep", "note.md"), "nested\n");
	await put(join(elsewhere, "linked-skill", "SKILL.md"), "---\nname: linked\n---\n");
	await put(join(elsewhere, "linked-skill", "scripts", "run.sh"), "echo linked\n");
	await symlink(join(elsewhere, "linked-skill"), join(agentDir, "skills", "linked"));
	await put(join(agentDir, "agents", "reviewer.md"), "---\nname: reviewer\n---\n");
	await put(join(agentDir, "agents", "writer.md"), "---\nname: writer\n---\n");
	await put(join(agentDir, "extensions", "keep.ts"), "// keep\n");
	await put(join(agentDir, "extensions", "herd.ts"), "// excluded\n");
	await put(join(elsewhere, "linked-ext.ts"), "// linked file\n");
	await symlink(join(elsewhere, "linked-ext.ts"), join(agentDir, "extensions", "linked-ext.ts"));
	await put(join(elsewhere, "ext-dir", "index.ts"), "// linked dir\n");
	await symlink(join(elsewhere, "ext-dir"), join(agentDir, "extensions", "ext-dir"));
	const shippable = ["keep.ts", "linked-ext.ts", "ext-dir"];
	await put(join(agentDir, "memories", "mnemopi", "notes.txt"), "plain file\n");
	// never shipped
	for (const name of ["agent.db", "agent.db-wal", "agent.db-shm", "history.db", "history.db-wal", "models.db", "models.db-shm", "skill-descriptions.db"]) {
		await put(join(agentDir, name), "never shipped: logins and history");
	}
	await put(join(agentDir, "sessions", "--proj--", "2026-01-01_abc.jsonl"), '{"type":"session"}\n');
	await put(join(agentDir, "cache", "blob"), "cache");
	await put(join(agentDir, ".cache", "x"), "cache");
	await put(join(agentDir, "secret-placeholder.key"), "never shipped");
	await put(join(agentDir, "mcp.json"), '{"mcpServers":{"x":{"env":{"TOKEN":"never shipped"}}}}');
	await put(join(agentDir, "extensions", "unplanned.ts"), "// listed by nobody: stays home\n");
	await put(join(agentDir, "overlays", "claude.yml"), "theme: dark\n");
	await put(join(agentDir, "blobs", "b".repeat(64)), "blob");
	return {
		agentDir,
		elsewhere,
		opts: {
			agentDir,
			extensions: shippable.map(name => ({ source: join(agentDir, "extensions", name), dest: `extensions/${name}` })),
			overlays: [],
			tmpDir: await tmp("omp-cloud-out-"),
			...over,
		},
	};
}

describe("buildSetup", () => {
	test("ships exactly the allowlist and the planned extensions; databases, sessions, caches, keys, mcp.json and unplanned extensions stay home", async () => {
		const l = await layout();
		const r = await buildSetup(l.opts);
		const dir = await extract(r.path);
		expect(await listAll(dir)).toEqual([
			"AGENTS.md",
			"RULES.md",
			"WATCHDOG.md",
			"agents/reviewer.md",
			"agents/writer.md",
			"config.yml",
			"extensions/ext-dir/index.ts",
			"extensions/keep.ts",
			"extensions/linked-ext.ts",
			"lsp.json",
			"memories/mnemopi/notes.txt",
			"skills/demo/SKILL.md",
			"skills/demo/refs/deep/note.md",
			"skills/linked/SKILL.md",
			"skills/linked/scripts/run.sh",
		]);
		expect(r.configOverlays).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.bytes).toBeGreaterThan(0);
	});

	test("symlinks (the file AGENTS.md, a skill dir, extension links) are dereferenced into regular files with the target's content", async () => {
		const l = await layout();
		const dir = await extract((await buildSetup(l.opts)).path);
		for (const rel of ["AGENTS.md", "skills/linked/SKILL.md", "extensions/linked-ext.ts", "extensions/ext-dir/index.ts"]) {
			expect((await lstat(join(dir, rel))).isFile()).toBe(true);
		}
		expect((await lstat(join(dir, "skills", "linked"))).isDirectory()).toBe(true);
		expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("# OMP User Preferences\n");
		expect(await readFile(join(dir, "skills/linked/scripts/run.sh"), "utf8")).toBe("echo linked\n");
		expect(await readFile(join(dir, "extensions/linked-ext.ts"), "utf8")).toBe("// linked file\n");
	});

	test("a symlink inside a shipped tree (a file or a directory, even one pointing back up) ships as its contents, a cycle does not loop", async () => {
		const l = await layout();
		const demo = join(l.agentDir, "skills", "demo");
		await put(join(l.elsewhere, "shared.md"), "shared file\n");
		await symlink(join(l.elsewhere, "shared.md"), join(demo, "shared.md"));
		await symlink(join(l.elsewhere, "linked-skill", "scripts"), join(demo, "tools"));
		await symlink(demo, join(demo, "refs", "again"));
		const dir = await extract((await buildSetup(l.opts)).path);
		expect(await readFile(join(dir, "skills/demo/shared.md"), "utf8")).toBe("shared file\n");
		expect(await readFile(join(dir, "skills/demo/tools/run.sh"), "utf8")).toBe("echo linked\n");
		expect(await readFile(join(dir, "skills/demo/refs/deep/note.md"), "utf8")).toBe("nested\n");
		expect((await listAll(dir)).filter(f => f.startsWith("skills/demo/refs/again/refs"))).toEqual([]);
	});

	test("an executable skill script stays executable in the archive, a plain file does not gain the bit", async () => {
		const l = await layout();
		await put(join(l.agentDir, "skills", "demo", "run.sh"), "#!/bin/sh\necho hi\n");
		await chmod(join(l.agentDir, "skills", "demo", "run.sh"), 0o755);
		await chmod(join(l.agentDir, "skills", "demo", "SKILL.md"), 0o644);
		await put(join(l.elsewhere, "linked-skill", "scripts", "tool.sh"), "#!/bin/sh\n");
		await chmod(join(l.elsewhere, "linked-skill", "scripts", "tool.sh"), 0o755);
		const listing = await run("tar", ["-tvzf", (await buildSetup(l.opts)).path]);
		expect(listing.code).toBe(0);
		const modeOf = (rel: string): string | undefined => listing.stdout.split("\n").find(line => line.endsWith(` ./${rel}`))?.slice(0, 10);
		expect(modeOf("skills/demo/run.sh")).toBe("-rwxr-xr-x");
		expect(modeOf("skills/linked/scripts/tool.sh")).toBe("-rwxr-xr-x");
		expect(modeOf("skills/demo/SKILL.md")).toBe("-rw-r--r--");
	});

	test("a planned extension from outside the agent dir ships at its planned name, a directory with everything in it", async () => {
		const l = await layout();
		await put(join(l.elsewhere, "suite", "index.ts"), "// suite\n");
		await put(join(l.elsewhere, "suite", "lib", "helper.ts"), "// helper\n");
		const extensions = [{ source: join(l.elsewhere, "suite"), dest: "extensions/suite" }];
		const files = await listAll(await extract((await buildSetup({ ...l.opts, extensions })).path));
		expect(files.filter(f => f.startsWith("extensions/"))).toEqual(["extensions/suite/index.ts", "extensions/suite/lib/helper.ts"]);
	});

	test("an agent dir with nothing but a config still packs; absent pieces are simply not shipped", async () => {
		const agentDir = await tmp("omp-cloud-bare-");
		await put(join(agentDir, "config.yml"), "a: 1\n");
		const dir = await extract(
			(await buildSetup({ agentDir, extensions: [], overlays: [], tmpDir: await tmp("omp-cloud-out-") })).path,
		);
		expect(await listAll(dir)).toEqual(["config.yml"]);
	});

	test("the cloud block of config.yml and of an overlay stays home, everything else in them ships; files without it ship as they are", async () => {
		const agentDir = await tmp("omp-cloud-cfg-");
		await put(join(agentDir, "config.yml"), "theme: dark\ncloud:\n  url: http://svc\n  token: super-secret\n  secretEnv: [A]\nretry:\n  enabled: true\n");
		const overlay = join(await tmp("omp-cloud-else-"), "o.yml");
		await put(overlay, "cloud:\n  token: another-secret\nteam: yes\n");
		const plain = join(agentDir, "plain.yml");
		await put(plain, "# a comment that must survive\nteam: no\n");

		const r = await buildSetup({ agentDir, extensions: [], overlays: [overlay, plain], tmpDir: await tmp("omp-cloud-out-") });
		const dir = await extract(r.path);

		const config = await readFile(join(dir, "config.yml"), "utf8");
		expect(config).not.toContain("super-secret");
		expect(config).not.toContain("cloud");
		expect(Bun.YAML.parse(config)).toEqual({ theme: "dark", retry: { enabled: true } });
		const shipped = await readFile(join(dir, r.configOverlays[0] ?? ""), "utf8");
		expect(shipped).not.toContain("another-secret");
		expect(Bun.YAML.parse(shipped)).toEqual({ team: "yes" });
		expect(await readFile(join(dir, r.configOverlays[1] ?? ""), "utf8")).toBe("# a comment that must survive\nteam: no\n");
	});

	test("config.yml and overlays ship without their extensions key (and keep disabledExtensions) while the extension itself ships under extensions/", async () => {
		const agentDir = await tmp("omp-cloud-cfg-");
		const elsewhere = await tmp("omp-cloud-else-");
		const ext = join(elsewhere, "out.ts");
		await put(ext, "// out\n");
		await put(join(agentDir, "config.yml"), `theme: dark\nextensions:\n  - ${ext}\ndisabledExtensions:\n  - extension-module:off\n`);
		const overlay = join(elsewhere, "o.yml");
		await put(overlay, `extensions: [${ext}]\nteam: yes\n`);

		const r = await buildSetup({
			agentDir,
			extensions: [{ source: ext, dest: "extensions/out.ts" }],
			overlays: [overlay],
			tmpDir: await tmp("omp-cloud-out-"),
		});
		const dir = await extract(r.path);

		const config = await readFile(join(dir, "config.yml"), "utf8");
		expect(config).not.toContain(ext);
		expect(Bun.YAML.parse(config)).toEqual({ theme: "dark", disabledExtensions: ["extension-module:off"] });
		const shipped = await readFile(join(dir, r.configOverlays[0] ?? ""), "utf8");
		expect(shipped).not.toContain(ext);
		expect(Bun.YAML.parse(shipped)).toEqual({ team: "yes" });
		expect(await readFile(join(dir, "extensions/out.ts"), "utf8")).toBe("// out\n");
	});

	test("a config.yml keeps credentials, host paths, commands and local endpoints at home, and each is a warning that reaches the caller", async () => {
		const agentDir = await tmp("omp-cloud-cfg-");
		await put(
			join(agentDir, "config.yml"),
			[
				"theme: dark",
				"auth:",
				"  broker:",
				"    url: http://127.0.0.1:4000",
				"    token: broker-secret",
				"hindsight:",
				"  apiUrl: http://localhost:8888",
				"  apiToken: hs-secret",
				"searxng:",
				"  endpoint: https://search.example.test",
				"mnemopi:",
				"  llmApiKey: '!op read op://v/i/key'",
				"  embeddingApiUrl: http://[::1]:11434",
				"  scoping: per-project",
				'"browser.cdpUrl": http://127.0.0.1:9222',
				"modelRoles:",
				"  default: a/b",
				"  smol: '!echo hi'",
				"cloud:",
				"  token: t",
				"",
			].join("\n"),
		);
		const r = await buildSetup({ agentDir, extensions: [], overlays: [], tmpDir: await tmp("omp-cloud-out-") });
		const config = Bun.YAML.parse(await readFile(join(await extract(r.path), "config.yml"), "utf8"));
		expect(config).toEqual({ theme: "dark", searxng: { endpoint: "https://search.example.test" }, mnemopi: { scoping: "per-project" }, modelRoles: { default: "a/b" } });
		expect(r.warnings.sort()).toEqual(
			[
				"config.yml: auth.broker stays on this machine",
				"config.yml: hindsight.apiUrl stays on this machine",
				"config.yml: hindsight.apiToken stays on this machine",
				"config.yml: mnemopi.llmApiKey stays on this machine",
				"config.yml: mnemopi.embeddingApiUrl stays on this machine",
				"config.yml: browser.cdpUrl stays on this machine",
				"config.yml: modelRoles.smol stays on this machine",
			].sort(),
		);
	});

	test("a settings file with nothing to keep home ships byte for byte, with no warning", async () => {
		const agentDir = await tmp("omp-cloud-cfg-");
		const text = "# comment\nhindsight:\n  apiUrl: https://hindsight.example.test\ntheme: dark\n";
		await put(join(agentDir, "config.yml"), text);
		const r = await buildSetup({ agentDir, extensions: [], overlays: [], tmpDir: await tmp("omp-cloud-out-") });
		expect(await readFile(join(await extract(r.path), "config.yml"), "utf8")).toBe(text);
		expect(r.warnings).toEqual([]);
	});

	test("an overlay's warnings name the overlay file, and an overlay that is also config.yml warns once", async () => {
		const agentDir = await tmp("omp-cloud-cfg-");
		await put(join(agentDir, "config.yml"), "shellPath: /bin/zsh\n");
		const overlay = join(await tmp("omp-cloud-else-"), "team.yml");
		await put(overlay, "auth:\n  broker:\n    url: x\n");
		const r = await buildSetup({ agentDir, extensions: [], overlays: [join(agentDir, "config.yml"), overlay], tmpDir: await tmp("omp-cloud-out-") });
		expect(r.warnings).toEqual(["config.yml: shellPath stays on this machine", "team.yml: auth.broker stays on this machine"]);
	});

	test("a config.yml that is not YAML is a UserError naming the file", async () => {
		const agentDir = await tmp("omp-cloud-cfg-");
		await put(join(agentDir, "config.yml"), "a: [unclosed\n");
		const err = await buildSetup({ agentDir, extensions: [], overlays: [], tmpDir: await tmp("omp-cloud-out-") }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UserError);
		expect((err as UserError).message).toContain(`${join(agentDir, "config.yml")} is not valid YAML`);
	});

	test("a Mnemopi SQLite database round-trips through serialize, including uncheckpointed WAL writes; sidecars are skipped", async () => {
		const l = await layout();
		const dbPath = join(l.agentDir, "memories", "mnemopi", "mnemopi.db");
		const bankDb = join(l.agentDir, "memories", "mnemopi", "banks", "global", "bank.db");
		await mkdir(join(bankDb, ".."), { recursive: true });
		const dbs: Database[] = [];
		for (const p of [dbPath, bankDb]) {
			const db = new Database(p);
			db.run("PRAGMA journal_mode=WAL");
			db.run("PRAGMA wal_autocheckpoint=0");
			db.run("CREATE TABLE memories(id INTEGER PRIMARY KEY, text TEXT)");
			db.run("INSERT INTO memories(text) VALUES ('omp-cloud scratch codeword is plover'), ('second')");
			dbs.push(db);
		}
		// The writes live in the -wal files, which are still open.
		expect((await lstat(`${dbPath}-wal`)).size).toBeGreaterThan(0);

		const r = await buildSetup(l.opts);
		for (const db of dbs) db.close();
		expect(r.warnings).toEqual([]);

		const dir = await extract(r.path);
		const files = await listAll(dir);
		expect(files).toContain("memories/mnemopi/mnemopi.db");
		expect(files).toContain("memories/mnemopi/banks/global/bank.db");
		expect(files).toContain("memories/mnemopi/notes.txt");
		expect(files.filter(f => /-(wal|shm)$/.test(f))).toEqual([]);
		for (const rel of ["memories/mnemopi/mnemopi.db", "memories/mnemopi/banks/global/bank.db"]) {
			const copy = new Database(join(dir, rel), { readonly: true });
			expect(copy.query("SELECT text FROM memories ORDER BY id").all()).toEqual([
				{ text: "omp-cloud scratch codeword is plover" },
				{ text: "second" },
			]);
			copy.close();
		}
	});

	test("a memory .db that is not a readable database is copied as it is and warned about", async () => {
		const l = await layout();
		await put(join(l.agentDir, "memories", "mnemopi", "broken.db"), "this is not sqlite, just bytes that are longer than a header");
		const r = await buildSetup(l.opts);
		expect(r.warnings).toEqual([MEMORY_WARNING]);
		const dir = await extract(r.path);
		expect(await readFile(join(dir, "memories/mnemopi/broken.db"), "utf8")).toBe("this is not sqlite, just bytes that are longer than a header");
	});

	describe("the project bank rename", () => {
		const bankDb = async (agentDir: string, bank: string, text: string): Promise<void> => {
			await put(join(agentDir, "memories", "mnemopi", "banks", bank, "mnemopi.db"), text);
		};

		test("the bank of this machine ships under the name the VM looks for, with its content", async () => {
			const l = await layout();
			const db = join(l.agentDir, "memories", "mnemopi", "banks", "app-laptop", "mnemopi.db");
			await mkdir(join(db, ".."), { recursive: true });
			const store = new Database(db);
			store.run("CREATE TABLE memories(id INTEGER PRIMARY KEY, text TEXT)");
			store.run("INSERT INTO memories(text) VALUES ('laptop memory')");
			store.close();
			await bankDb(l.agentDir, "other-bank", "kept as it is");
			const dir = await extract((await buildSetup({ ...l.opts, memoryBank: { from: "app-laptop", to: "work-vm" } })).path);
			const files = await listAll(dir);
			expect(files).toContain("memories/mnemopi/banks/work-vm/mnemopi.db");
			expect(files).toContain("memories/mnemopi/banks/other-bank/mnemopi.db");
			expect(files.filter(f => f.includes("app-laptop"))).toEqual([]);
			const copy = new Database(join(dir, "memories/mnemopi/banks/work-vm/mnemopi.db"), { readonly: true });
			expect(copy.query("SELECT text FROM memories").all()).toEqual([{ text: "laptop memory" }]);
			copy.close();
		});

		test("without a plan nothing is renamed", async () => {
			const l = await layout();
			await bankDb(l.agentDir, "app-laptop", "x");
			expect(await listAll(await extract((await buildSetup(l.opts)).path))).toContain("memories/mnemopi/banks/app-laptop/mnemopi.db");
		});

		test("a bank that is not there is skipped, and a bank already under the new name is not overwritten", async () => {
			const l = await layout();
			await bankDb(l.agentDir, "work-vm", "already named");
			const absent = await extract((await buildSetup({ ...l.opts, memoryBank: { from: "app-laptop", to: "work-vm" } })).path);
			expect(await readFile(join(absent, "memories/mnemopi/banks/work-vm/mnemopi.db"), "utf8")).toBe("already named");
			await bankDb(l.agentDir, "app-laptop", "laptop text");
			const both = await extract((await buildSetup({ ...l.opts, memoryBank: { from: "app-laptop", to: "work-vm" } })).path);
			expect(await readFile(join(both, "memories/mnemopi/banks/work-vm/mnemopi.db"), "utf8")).toBe("already named");
			expect(await readFile(join(both, "memories/mnemopi/banks/app-laptop/mnemopi.db"), "utf8")).toBe("laptop text");
		});
	});

	test("an archive over the cap is an error naming the remedies", async () => {
		const l = await layout();
		// Incompressible content beyond 64 MiB.
		const big = new Uint8Array(65 * 1024 * 1024);
		for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, Math.min(i + 65536, big.length)));
		await Bun.write(join(l.agentDir, "skills", "huge.bin"), big);
		await expect(buildSetup(l.opts)).rejects.toThrow(/omp setup is [\d.]+ MB, over the 64 MB limit.*excludeExtensions of your omp-cloud config/);
	}, 60_000);
});

describe("sanitizeSettings", () => {
	test("cloud and extensions go silently; the rest of the document is untouched, the input too", () => {
		const input = { theme: "dark", cloud: { token: "t" }, extensions: ["/x.ts"], nested: { keep: 1 } };
		const out = sanitizeSettings(input);
		expect(out).toEqual({ doc: { theme: "dark", nested: { keep: 1 } }, dropped: [], changed: true });
		expect(Object.keys(input)).toEqual(["theme", "cloud", "extensions", "nested"]);
	});

	test("dotted top-level keys match like nested ones", () => {
		const out = sanitizeSettings({ "auth.broker.url": "http://x", "hindsight.apiUrl": "http://127.1.2.3/x", "searxng.endpoint": "http://0.0.0.0:8080", other: 1 });
		expect(out.doc).toEqual({ other: 1 });
		expect(out.dropped).toEqual(["auth.broker.url", "hindsight.apiUrl", "searxng.endpoint"]);
	});

	test("a command is dropped at any depth, in a list too; a mapping the removal empties goes with it", () => {
		const out = sanitizeSettings({ a: { b: { c: "!pass show x" } }, keep: { empty: {} }, list: ["fine", "!cmd", { deep: "!cmd2", ok: 1 }] });
		expect(out.doc).toEqual({ keep: { empty: {} }, list: ["fine", { ok: 1 }] });
		expect(out.dropped).toEqual(["a.b.c", "list[1]", "list[2].deep"]);
	});

	test("endpoints are kept when they are not this machine", () => {
		const doc = { hindsight: { apiUrl: "https://h.example.test" }, compaction: { remoteEndpoint: "http://10.0.0.5:9000" }, mnemopi: { llmBaseUrl: "not a url" } };
		expect(sanitizeSettings(doc)).toEqual({ doc, dropped: [], changed: false });
	});

	test("every listed credential and host path is dropped", () => {
		const keys = ["images.urls.credentials", "dev.autoqaPush.token", "mnemopi.embeddingApiKey", "mnemopi.dbPath", "shellMinimizer.settingsPath", "plan.autosaveDir", "browser.screenshotDir", "browser.relayUrl", "skills.customDirectories", "workspace.additionalDirectories", "ida.installDir", "images.urls.command", "images.urls.sshTarget", "images.urls.bindHost", "images.urls.publicBaseUrl", "searxng.token", "searxng.basicPassword", "compaction.remoteEndpoint"];
		const doc: Record<string, unknown> = {};
		for (const k of keys) doc[k] = k === "compaction.remoteEndpoint" ? "http://localhost:1" : ["x"];
		const out = sanitizeSettings(doc);
		expect(out.doc).toEqual({});
		expect(out.dropped).toEqual(keys);
	});
});
