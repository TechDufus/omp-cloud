import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { run } from "../src/exec";
import { configFlags, expandTilde, sessionOverlays } from "../src/overlays";
import { buildSetup, MAX_OVERLAYS, type SetupResult } from "../src/setup";
import { UserError } from "../src/types";
import { fakePi, fakeSettings, uninitializedSettings } from "./fakes";
import { cleanup, tmp } from "./helpers";

afterEach(cleanup);

describe("configFlags", () => {
	test("reads `--config x` and `--config=x` in order and ignores everything else", () => {
		expect(configFlags(["omp", "--model", "a/b", "--config", "one.yml", "-p", "--config=two.yml", "--configure", "x", "--config=three.yml"])).toEqual([
			"one.yml",
			"two.yml",
			"three.yml",
		]);
	});

	test("a trailing `--config` without a value yields nothing", () => {
		expect(configFlags(["omp", "--config"])).toEqual([]);
	});

	test("the value after `--config` is consumed, not re-read as a flag", () => {
		expect(configFlags(["--config", "--config=inner.yml"])).toEqual(["--config=inner.yml"]);
	});
});

describe("sessionOverlays", () => {
	const cwd = "/work/project";

	/** Overlay files that exist, named in the order given. */
	async function overlays(...names: string[]): Promise<string[]> {
		const dir = await tmp("omp-cloud-ov-");
		return Promise.all(names.map(n => put(join(dir, n), "x: 1\n")));
	}

	test("the live settings instance is authoritative: PI_CONFIG_FILES and argv are not consulted", async () => {
		const files = await overlays("a.yml", "b.yml");
		const { pi } = fakePi({ settings: await fakeSettings({ configFiles: files }) });
		const got = sessionOverlays(pi, {
			argv: ["omp", "--config", "argv.yml"],
			env: { PI_CONFIG_FILES: "/env/x.yml" },
			cwd,
		});
		expect(got).toEqual(files);
	});

	test("the result is a copy, not the settings' own array", async () => {
		const files = await overlays("a.yml");
		const settings = await fakeSettings({ configFiles: files });
		const got = sessionOverlays(fakePi({ settings }).pi, { argv: [], env: {}, cwd });
		got.push("/mutated.yml");
		expect(settings.getConfigFiles()).toEqual(files);
	});

	test("when the settings proxy throws, PI_CONFIG_FILES comes first (path-delimited), then each --config, resolved against cwd", () => {
		const { pi } = fakePi({ settings: uninitializedSettings() });
		const got = sessionOverlays(pi, {
			argv: ["omp", "--config", "rel/flag.yml", "--config=/abs/flag.yml"],
			env: { PI_CONFIG_FILES: ["env-rel.yml", "/abs/env.yml"].join(delimiter) },
			cwd,
		});
		expect(got).toEqual([
			resolve(cwd, "env-rel.yml"),
			"/abs/env.yml",
			resolve(cwd, "rel/flag.yml"),
			"/abs/flag.yml",
		]);
	});

	test("empty live settings fall back the same way", async () => {
		const { pi } = fakePi({ settings: await fakeSettings() });
		expect(sessionOverlays(pi, { argv: ["omp", "--config=flag.yml"], env: {}, cwd })).toEqual([`${cwd}/flag.yml`]);
	});

	test("`~` and `~/x` expand to the home directory; empty PI_CONFIG_FILES segments are skipped", () => {
		const { pi } = fakePi({ settings: uninitializedSettings() });
		const got = sessionOverlays(pi, {
			argv: ["omp", "--config", "~/cfg/a.yml", "--config=~"],
			env: { PI_CONFIG_FILES: `${delimiter}~/env.yml${delimiter}` },
			cwd,
		});
		expect(got).toEqual([`${homedir()}/env.yml`, `${homedir()}/cfg/a.yml`, homedir()]);
	});

	test("`~\\x` expands like `~/x` (omp accepts both separators)", () => {
		expect(expandTilde("~\\cfg\\a.yml")).toBe(`${homedir()}\\cfg\\a.yml`);
		expect(expandTilde("~other/a.yml")).toBe("~other/a.yml");
	});

	test("no live settings, no env, no flags: no overlays", () => {
		const { pi } = fakePi({ settings: uninitializedSettings() });
		expect(sessionOverlays(pi, { argv: ["omp", "-p", "hi"], env: {}, cwd })).toEqual([]);
	});
});

async function put(path: string, content: string): Promise<string> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
	return path;
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

interface Packed {
	result: SetupResult;
	dir: string;
}

async function pack(agentDir: string, overlays: readonly string[]): Promise<Packed> {
	const result = await buildSetup({
		agentDir,
		extensions: [],
		overlays,
		tmpDir: await tmp("omp-cloud-out-"),
	});
	const dir = await tmp("omp-cloud-x-");
	const r = await run("tar", ["-xzf", result.path, "-C", dir]);
	expect(r.code).toBe(0);
	return { result, dir };
}

async function newAgentDir(): Promise<string> {
	const agentDir = await tmp("omp-cloud-agent-");
	await put(join(agentDir, "config.yml"), "modelRoles:\n  default: a/b\n");
	return agentDir;
}

describe("buildSetup overlays", () => {
	test("an overlay inside the agent dir ships at its relative path with identical content", async () => {
		const agentDir = await newAgentDir();
		const overlay = await put(join(agentDir, "overlays", "claude.yml"), "theme: dark\nunicode: ☁\n");
		const { result, dir } = await pack(agentDir, [overlay]);
		expect(result.configOverlays).toEqual(["overlays/claude.yml"]);
		expect(await readFile(join(dir, "overlays", "claude.yml"), "utf8")).toBe("theme: dark\nunicode: ☁\n");
		expect(await listAll(dir)).toEqual(["config.yml", "overlays/claude.yml"]);
	});

	test("an overlay outside the agent dir ships as overlays/<n>-<basename>, n counting from 1 in load order", async () => {
		const agentDir = await newAgentDir();
		const elsewhere = await tmp("omp-cloud-else-");
		const overlay = await put(join(elsewhere, "team.yml"), "a: 1\n");
		const { result, dir } = await pack(agentDir, [overlay]);
		expect(result.configOverlays).toEqual(["overlays/1-team.yml"]);
		expect(await readFile(join(dir, "overlays", "1-team.yml"), "utf8")).toBe("a: 1\n");
		expect((await lstat(join(dir, "overlays", "1-team.yml"))).isFile()).toBe(true);
	});

	test("configOverlays lists inside and outside overlays in load order; same-basename outside overlays do not collide", async () => {
		const agentDir = await newAgentDir();
		const first = await tmp("omp-cloud-else-");
		const second = await tmp("omp-cloud-else-");
		const outA = await put(join(first, "base.yml"), "from: first\n");
		const inside = await put(join(agentDir, "overlays", "claude.yml"), "from: inside\n");
		const outB = await put(join(second, "base.yml"), "from: second\n");
		const { result, dir } = await pack(agentDir, [outA, inside, outB]);
		expect(result.configOverlays).toEqual(["overlays/1-base.yml", "overlays/claude.yml", "overlays/3-base.yml"]);
		expect(await readFile(join(dir, "overlays/1-base.yml"), "utf8")).toBe("from: first\n");
		expect(await readFile(join(dir, "overlays/claude.yml"), "utf8")).toBe("from: inside\n");
		expect(await readFile(join(dir, "overlays/3-base.yml"), "utf8")).toBe("from: second\n");
		expect(await listAll(dir)).toEqual(["config.yml", "overlays/1-base.yml", "overlays/3-base.yml", "overlays/claude.yml"]);
	});

	test("an overlay that is already part of the shipped setup (config.yml, a skills file) is listed at its own path and not duplicated", async () => {
		const agentDir = await newAgentDir();
		const skill = await put(join(agentDir, "skills", "demo", "extra.yml"), "x: 1\n");
		const { result, dir } = await pack(agentDir, [join(agentDir, "config.yml"), skill]);
		expect(result.configOverlays).toEqual(["config.yml", "skills/demo/extra.yml"]);
		expect(await listAll(dir)).toEqual(["config.yml", "skills/demo/extra.yml"]);
	});

	test("an overlay inside a shipped tree ships without its cloud and extensions keys, though the tree copy already put the file there", async () => {
		const agentDir = await newAgentDir();
		const overlay = await put(join(agentDir, "skills", "demo", "team.yml"), "cloud:\n  token: leaked\nextensions: [/home/me/x.ts]\nteam: yes\n");
		const { result, dir } = await pack(agentDir, [overlay]);
		expect(result.configOverlays).toEqual(["skills/demo/team.yml"]);
		const shipped = await readFile(join(dir, "skills/demo/team.yml"), "utf8");
		expect(shipped).not.toContain("leaked");
		expect(Bun.YAML.parse(shipped)).toEqual({ team: "yes" });
	});

	test("an overlay reached through a symlinked agent dir is still recognised as inside it", async () => {
		const real = await newAgentDir();
		const overlay = await put(join(real, "overlays", "claude.yml"), "k: v\n");
		const holder = await tmp("omp-cloud-link-");
		const link = join(holder, "agent");
		await symlink(real, link);
		const { result } = await pack(link, [overlay]);
		expect(result.configOverlays).toEqual(["overlays/claude.yml"]);
	});

	test("an inside overlay whose path the API would reject (a space) is shipped as overlays/<n>-<sanitized name>", async () => {
		const agentDir = await newAgentDir();
		const overlay = await put(join(agentDir, "my overlays", "dark theme.yml"), "t: dark\n");
		const { result, dir } = await pack(agentDir, [overlay]);
		expect(result.configOverlays).toEqual(["overlays/1-dark_theme.yml"]);
		expect(await readFile(join(dir, "overlays/1-dark_theme.yml"), "utf8")).toBe("t: dark\n");
		expect(await listAll(dir)).toEqual(["config.yml", "overlays/1-dark_theme.yml"]);
	});

	test("an overlay that is a symlink ships its target's content", async () => {
		const agentDir = await newAgentDir();
		const elsewhere = await tmp("omp-cloud-else-");
		const target = await put(join(elsewhere, "real.yml"), "linked: yes\n");
		const holder = await tmp("omp-cloud-else-");
		const link = join(holder, "alias.yml");
		await symlink(target, link);
		const { result, dir } = await pack(agentDir, [link]);
		expect(result.configOverlays).toEqual(["overlays/1-alias.yml"]);
		expect(await readFile(join(dir, "overlays/1-alias.yml"), "utf8")).toBe("linked: yes\n");
	});

	test("a missing overlay is a UserError naming the file", async () => {
		const agentDir = await newAgentDir();
		const missing = join(await tmp("omp-cloud-else-"), "gone.yml");
		const err = await pack(agentDir, [missing]).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UserError);
		expect((err as UserError).message).toBe(`☁ the --config overlay ${missing} does not exist`);
	});

	test(`${MAX_OVERLAYS} overlays ship; one more is a UserError before anything is packed`, async () => {
		const agentDir = await newAgentDir();
		const elsewhere = await tmp("omp-cloud-else-");
		const files: string[] = [];
		for (let i = 0; i <= MAX_OVERLAYS; i++) files.push(await put(join(elsewhere, `o${i}.yml`), `n: ${i}\n`));

		const { result } = await pack(agentDir, files.slice(0, MAX_OVERLAYS));
		expect(result.configOverlays).toEqual(files.slice(0, MAX_OVERLAYS).map((_, i) => `overlays/${i + 1}-o${i}.yml`));

		const tmpDir = await tmp("omp-cloud-out-");
		const err = await buildSetup({ agentDir, extensions: [], overlays: files, tmpDir }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UserError);
		expect((err as UserError).message).toBe(`☁ this session loads ${MAX_OVERLAYS + 1} --config overlays; the cloud takes at most ${MAX_OVERLAYS}`);
		expect(await Bun.file(join(tmpDir, "setup.tar.gz")).exists()).toBe(false);
	});
});
