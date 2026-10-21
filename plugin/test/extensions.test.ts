import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planExtensions, type ExtensionPlan } from "../src/extensions";
import { fakeSettings } from "./fakes";
import { cleanup, isolateOmp } from "./helpers";

afterEach(cleanup);

async function put(path: string, content = "export default function ext(): void {}\n"): Promise<string> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
	return path;
}

interface World {
	root: string;
	/** Stands in for `~/.omp`. */
	configRoot: string;
	agentDir: string;
	/** The repository root, which is also the session's cwd. */
	repo: string;
	/** A directory outside the agent dir and the repository. */
	elsewhere: string;
	/** This extension's own directory. */
	own: string;
}

async function world(): Promise<World> {
	const { root, configRoot, agentDir } = await isolateOmp();
	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });
	const own = join(root, "own");
	await put(join(own, "package.json"), "{}");
	await put(join(own, "src", "index.ts"));
	return { root, configRoot, agentDir, repo, elsewhere: join(root, "elsewhere"), own };
}

async function plan(w: World, over: { global?: string; exclude?: string[]; repoRoot?: string } = {}): Promise<ExtensionPlan> {
	return planExtensions({
		settings: await fakeSettings({ agentDir: w.agentDir, cwd: w.repo, global: over.global }),
		cwd: w.repo,
		agentDir: w.agentDir,
		repoRoot: over.repoRoot ?? w.repo,
		ownRoot: w.own,
		exclude: over.exclude ?? [],
	});
}

const dests = (p: ExtensionPlan): string[] => p.ship.map(s => s.dest).sort();

describe("planExtensions", () => {
	test("each entry of <agent dir>/extensions ships whole under its name, links included; this extension and excluded names stay home", async () => {
		const w = await world();
		await put(join(w.agentDir, "extensions", "keep.ts"));
		await put(join(w.agentDir, "extensions", "herd.ts"));
		await put(join(w.agentDir, "extensions", "dir", "index.ts"));
		await put(join(w.agentDir, "extensions", "dir", "lib", "helper.ts"));
		await put(join(w.elsewhere, "linked.ts"));
		await symlink(join(w.elsewhere, "linked.ts"), join(w.agentDir, "extensions", "linked.ts"));
		await symlink(w.own, join(w.agentDir, "extensions", "omp-cloud"));
		await symlink(w.own, join(w.agentDir, "extensions", "renamed-copy"));

		const got = await plan(w, { exclude: ["herd.ts"] });

		expect(dests(got)).toEqual(["extensions/dir", "extensions/keep.ts", "extensions/linked.ts"]);
		const extDir = join(w.agentDir, "extensions");
		expect(Object.fromEntries(got.ship.map(s => [s.dest, s.source]))).toEqual({
			"extensions/dir": join(extDir, "dir"),
			"extensions/keep.ts": join(extDir, "keep.ts"),
			"extensions/linked.ts": join(extDir, "linked.ts"),
		});
		expect(got.warnings).toEqual([]);
	});

	test("extensions under the repository's own .omp travel with the bundle and are skipped, so are those of a nested .omp", async () => {
		const w = await world();
		await put(join(w.repo, ".omp", "extensions", "project.ts"));
		await put(join(w.repo, "pkg", ".omp", "extensions", "nested", "index.ts"));
		await put(join(w.agentDir, "extensions", "user.ts"));
		expect(dests(await plan(w))).toEqual(["extensions/user.ts"]);
	});

	test("an agent dir inside the repository's .omp is still shipped", async () => {
		const w = await world();
		await put(join(w.agentDir, "extensions", "user.ts"));
		expect(dests(await plan(w, { repoRoot: w.root }))).toEqual(["extensions/user.ts"]);
	});

	test("settings paths outside the agent dir ship under their basename: a file, a directory with its siblings, a relative path from the cwd", async () => {
		const w = await world();
		await put(join(w.elsewhere, "single.ts"));
		await put(join(w.elsewhere, "suite", "index.ts"));
		await put(join(w.elsewhere, "suite", "lib.ts"));
		await put(join(w.elsewhere, "relative.ts"));
		const got = await plan(w, {
			global: `extensions:\n  - ${join(w.elsewhere, "single.ts")}\n  - ${join(w.elsewhere, "suite")}\n  - ../elsewhere/relative.ts\n`,
		});
		expect(dests(got)).toEqual(["extensions/relative.ts", "extensions/single.ts", "extensions/suite"]);
		expect(got.ship.find(s => s.dest === "extensions/suite")?.source).toBe(join(w.elsewhere, "suite"));
		expect(got.ship.find(s => s.dest === "extensions/relative.ts")?.source).toBe(join(w.elsewhere, "relative.ts"));
	});

	test("a settings path inside the repository's .omp is skipped; one elsewhere in the repository ships", async () => {
		const w = await world();
		await put(join(w.repo, ".omp", "tools", "a.ts"));
		await put(join(w.repo, "tools", "b.ts"));
		const got = await plan(w, { global: `extensions:\n  - ${join(w.repo, ".omp", "tools", "a.ts")}\n  - ${join(w.repo, "tools", "b.ts")}\n` });
		expect(dests(got)).toEqual(["extensions/b.ts"]);
	});

	test("a settings path that is this extension is left out", async () => {
		const w = await world();
		const got = await plan(w, { global: `extensions:\n  - ${w.own}\n  - ${join(w.own, "src", "index.ts")}\n` });
		expect(got.ship).toEqual([]);
	});

	test("disabledExtensions are not shipped, exactly as omp does not load them", async () => {
		const w = await world();
		await put(join(w.agentDir, "extensions", "keep.ts"));
		await put(join(w.agentDir, "extensions", "off.ts"));
		const got = await plan(w, { global: "disabledExtensions:\n  - extension-module:off\n" });
		expect(dests(got)).toEqual(["extensions/keep.ts"]);
	});

	test("two extensions with one basename: the first ships, the second is reported", async () => {
		const w = await world();
		await put(join(w.agentDir, "extensions", "same.ts"));
		await put(join(w.elsewhere, "same.ts"));
		const got = await plan(w, { global: `extensions:\n  - ${join(w.elsewhere, "same.ts")}\n` });
		expect(dests(got)).toEqual(["extensions/same.ts"]);
		expect(got.warnings).toEqual([`extension ${join(w.elsewhere, "same.ts")} is not shipped: same.ts is already taken by ${join(w.agentDir, "extensions", "same.ts")}`]);
	});

	test("an enabled plugin is not shipped and is named in a warning; its extension is not shipped either", async () => {
		const w = await world();
		await put(join(w.agentDir, "extensions", "keep.ts"));
		const pluginsRoot = join(w.configRoot, "plugins");
		await put(join(pluginsRoot, "package.json"), JSON.stringify({ dependencies: { "demo-plugin": "1.0.0" } }));
		await put(join(pluginsRoot, "node_modules", "demo-plugin", "package.json"), JSON.stringify({ name: "demo-plugin", version: "1.0.0", omp: { extensions: ["./ext.ts"] } }));
		await put(join(pluginsRoot, "node_modules", "demo-plugin", "ext.ts"));

		const got = await plan(w);

		expect(dests(got)).toEqual(["extensions/keep.ts"]);
		expect(got.warnings).toEqual(["plugin demo-plugin is enabled here but not shipped; the cloud agent runs without it"]);
	});

	test("this extension installed as a plugin is neither shipped nor warned about", async () => {
		const w = await world();
		const pluginsRoot = join(w.configRoot, "plugins");
		await put(join(pluginsRoot, "package.json"), JSON.stringify({ dependencies: { "omp-cloud": "1.0.0" } }));
		await mkdir(join(pluginsRoot, "node_modules"), { recursive: true });
		await put(join(w.own, "package.json"), JSON.stringify({ name: "omp-cloud", version: "1.0.0", omp: { extensions: ["./src/index.ts"] } }));
		await symlink(w.own, join(pluginsRoot, "node_modules", "omp-cloud"));

		const got = await plan(w);

		expect(got).toEqual({ ship: [], warnings: [] });
	});
});
