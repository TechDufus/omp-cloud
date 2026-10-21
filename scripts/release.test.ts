import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS } from "../src/store/schema";
import { parseManifest } from "../src/update/manifest";
import { BUILD, DEV_BUILD, parseBuild, SERVICE_VERSION } from "../src/version";
import {
	bumpVersions,
	buildManifest,
	checkVersion,
	extractChangelogSection,
	parseReleaseArgs,
	promoteUnreleased,
	release,
	repositoryFacts,
	setVersionField,
	sidecar,
	TARGETS,
	unreleasedSection,
	VERSION_FILES,
	embedPluginPlugin,
	pluginBundleFiles,
	pluginBundleSource,
} from "./release";
import { isRecord } from "../src/guards";
import { ensurePlugin } from "../src/setup/plugin";
import { bundledPlugin } from "../src/setup/plugin-bundle";
import type { CommandResult, CommandRunner } from "../src/update/system";
import { bundledPackageDirs, collectNotices, licenseCounts, packageOf, readEntry, renderNotices } from "./notices";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-cloud-release-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

async function bunOutput(args: string[]): Promise<string> {
	const proc = Bun.spawn([process.execPath, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`bun ${args.join(" ")} failed: ${stderr}`);
	return stdout;
}

describe("version and build identity", () => {
	test("without release defines a checkout reports package.json's version and the dev build", () => {
		const pkg = readJson(join(REPO_ROOT, "package.json"));
		expect(pkg).toMatchObject({ version: SERVICE_VERSION });
		expect(BUILD).toEqual({ id: "dev", commit: "", createdAt: "" });
		expect(parseBuild(undefined)).toEqual(DEV_BUILD);
	});

	test("the injected build is JSON text with a non-empty id and string commit and createdAt; anything else is refused", () => {
		const build = { id: "20261021120000-abcdef1", commit: "abcdef1".padEnd(40, "0"), createdAt: "2026-10-21T12:00:00.000Z" };
		expect(parseBuild(JSON.stringify(build))).toEqual(build);
		for (const bad of ["null", '"dev"', "{}", '{"id":"","commit":"","createdAt":""}', '{"id":"x","commit":1,"createdAt":""}', "{not json"]) {
			expect(() => parseBuild(bad)).toThrow();
		}
	});

	test("bun build --define of the two identifiers reaches src/version.ts as release.ts passes them", async () => {
		const build = { id: "20261021120000-abcdef1", commit: "c".repeat(40), createdAt: "2026-10-21T12:00:00.000Z" };
		const entry = join(dir, "entry.ts");
		writeFileSync(entry, `import { BUILD, SERVICE_VERSION } from ${JSON.stringify(join(REPO_ROOT, "src", "version.ts"))};\nconsole.log(JSON.stringify({ SERVICE_VERSION, BUILD }));\n`);
		const bundle = join(dir, "entry.js");
		await bunOutput([
			"build",
			entry,
			"--target=bun",
			"--define",
			`__OMP_CLOUD_VERSION__=${JSON.stringify("9.8.7-test")}`,
			"--define",
			`__OMP_CLOUD_BUILD__=${JSON.stringify(JSON.stringify(build))}`,
			`--outfile=${bundle}`,
		]);
		expect(JSON.parse(await bunOutput([bundle]))).toEqual({ SERVICE_VERSION: "9.8.7-test", BUILD: build });
		// The same entry bundled without defines falls back like a checkout.
		const plain = join(dir, "plain.js");
		await bunOutput(["build", entry, "--target=bun", `--outfile=${plain}`]);
		expect(JSON.parse(await bunOutput([plain]))).toEqual({ SERVICE_VERSION, BUILD: DEV_BUILD });
	});
});

describe("release arguments", () => {
	test("build takes an optional version and out directory; release takes exactly one version", () => {
		expect(parseReleaseArgs(["build"])).toEqual({ command: "build", version: undefined, out: undefined });
		expect(parseReleaseArgs(["build", "--version", "0.5.0-test", "--out", "/tmp/x"])).toEqual({ command: "build", version: "0.5.0-test", out: "/tmp/x" });
		expect(parseReleaseArgs(["release", "0.5.0"])).toEqual({ command: "release", version: "0.5.0" });
		for (const bad of [[], ["frob"], ["release"], ["release", "0.5.0", "x"], ["release", "v0.5.0"], ["build", "--version"], ["build", "--version", "1.2"], ["build", "--bogus", "1"]]) {
			expect(() => parseReleaseArgs(bad)).toThrow();
		}
		expect(checkVersion("10.20.30")).toBe("10.20.30");
	});
});

describe("manifest", () => {
	const input = {
		version: "0.5.0",
		build: { id: "20261021120000-abcdef1", commit: "c".repeat(40), createdAt: "2026-10-21T12:00:00.000Z" },
		notes: "- a change",
		files: [
			{ name: "omp-cloud-linux-x86_64", arch: "x86_64" as const, size: 111, sha256: SHA_A },
			{ name: "omp-cloud-linux-arm64", arch: "arm64" as const, size: 222, sha256: SHA_B },
		],
		pluginVersion: "0.5.0",
		vmonVersion: "v0.4.0",
		ompMin: "18.12.3",
		schema: 10,
	};

	test("lists each file with its size and sha256, the plugin version and what the release requires", () => {
		const manifest = buildManifest(input);
		expect(manifest).toEqual({
			product: "omp-cloud",
			version: "0.5.0",
			build: input.build,
			notes: "- a change",
			files: [
				{ name: "omp-cloud-linux-x86_64", platform: "linux", arch: "x86_64", size: 111, sha256: SHA_A },
				{ name: "omp-cloud-linux-arm64", platform: "linux", arch: "arm64", size: 222, sha256: SHA_B },
			],
			plugin: { version: "0.5.0" },
			requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 10 },
		});
		// What the updater reads back is exactly what the release writes.
		expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
	});

	test("asset names are the ones the updater downloads by", () => {
		expect(TARGETS.map((target) => [target.name, target.arch])).toEqual([
			["omp-cloud-linux-x86_64", "x86_64"],
			["omp-cloud-linux-arm64", "arm64"],
		]);
		expect(sidecar(SHA_A, "omp-cloud-linux-x86_64")).toBe(`${SHA_A}  omp-cloud-linux-x86_64\n`);
	});

	test("a vibemon pin that is not a v<x.y.z> tag and a malformed version are refused", () => {
		expect(() => buildManifest({ ...input, vmonVersion: "0.4.0" })).toThrow("vmon.json");
		expect(() => buildManifest({ ...input, version: "v0.5.0" })).toThrow();
	});

	test("this repository's facts: the plugin's version, the vibemon pin in infra/vmon.json, the pinned omp, the newest schema", () => {
		const facts = repositoryFacts(REPO_ROOT);
		expect(readJson(join(REPO_ROOT, "plugin", "package.json"))).toMatchObject({ version: facts.pluginVersion });
		expect(readJson(join(REPO_ROOT, "infra", "vmon.json"))).toMatchObject({ version: facts.vmonVersion });
		expect(facts.vmonVersion).toMatch(/^v\d+\.\d+\.\d+$/);
		expect(facts.ompMin).toMatch(/^\d+\.\d+\.\d+$/);
		expect(facts.schema).toBe(MIGRATIONS.length);
		const manifest = buildManifest({ ...input, ...facts });
		expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
	});
});

const CHANGELOG = `# Changelog

Intro text.

## Unreleased

- new thing
- another thing

## 0.4.0 (2026-10-20)

- four

## 0.3.10

- three ten

## 0.3.1 (2026-01-01)

- three one
`;

describe("CHANGELOG", () => {
	test("a version's section is its body up to the next heading, matched exactly with or without a date", () => {
		expect(extractChangelogSection(CHANGELOG, "0.4.0")).toBe("- four");
		expect(extractChangelogSection(CHANGELOG, "0.3.10")).toBe("- three ten");
		expect(extractChangelogSection(CHANGELOG, "0.3.1")).toBe("- three one");
		expect(extractChangelogSection(CHANGELOG, "0.3")).toBeNull();
		expect(extractChangelogSection(CHANGELOG, "0.5.0")).toBeNull();
		expect(unreleasedSection(CHANGELOG)).toBe("- new thing\n- another thing");
		expect(unreleasedSection("# Changelog\n")).toBeNull();
	});

	test("this repository's CHANGELOG has an Unreleased section and a written section for the current version", () => {
		const text = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
		expect(unreleasedSection(text)).not.toBeNull();
		expect(extractChangelogSection(text, SERVICE_VERSION)).not.toBeNull();
	});

	test("releasing moves Unreleased under the version and date and leaves an empty Unreleased above it", () => {
		const promoted = promoteUnreleased(CHANGELOG, "0.5.0", "2026-10-21");
		expect(unreleasedSection(promoted)).toBe("");
		expect(extractChangelogSection(promoted, "0.5.0")).toBe("- new thing\n- another thing");
		expect(promoted).toContain("## Unreleased\n\n## 0.5.0 (2026-10-21)\n\n- new thing");
		expect(extractChangelogSection(promoted, "0.4.0")).toBe("- four");
		expect(promoted.startsWith("# Changelog\n\nIntro text.\n\n## Unreleased")).toBe(true);
	});

	test("an empty or missing Unreleased and an existing version are refused", () => {
		expect(() => promoteUnreleased(CHANGELOG, "0.4.0", "2026-10-21")).toThrow("already has a section");
		expect(() => promoteUnreleased("# Changelog\n\n## Unreleased\n\n## 0.4.0\n\n- x\n", "0.5.0", "2026-10-21")).toThrow("no entries");
		expect(() => promoteUnreleased("# Changelog\n\n## 0.4.0\n\n- x\n", "0.5.0", "2026-10-21")).toThrow("no `## Unreleased`");
	});
});

describe("version bump", () => {
	function copyVersionFiles(to: string): void {
		for (const file of VERSION_FILES) {
			mkdirSync(join(to, file, ".."), { recursive: true });
			cpSync(join(REPO_ROOT, file), join(to, file));
		}
	}

	test("sets the version of the root package, the plugin package and the marketplace entry together and touches nothing else", () => {
		copyVersionFiles(dir);
		const before = VERSION_FILES.map((file) => readFileSync(join(dir, file), "utf8"));
		const written = bumpVersions(dir, "9.9.9");
		expect(written).toEqual(VERSION_FILES.map((file) => join(dir, file)));

		expect(readJson(join(dir, "package.json"))).toMatchObject({ name: "omp-cloud", version: "9.9.9" });
		expect(readJson(join(dir, "plugin", "package.json"))).toMatchObject({ name: "omp-cloud", version: "9.9.9" });
		expect(readJson(join(dir, ".omp-plugin", "marketplace.json"))).toMatchObject({ plugins: [{ name: "omp-cloud", version: "9.9.9", source: "./plugin" }] });
		VERSION_FILES.forEach((file, i) => {
			const original = before[i] ?? "";
			// Same bytes apart from the version: put the old one back and compare.
			const oldVersion = /"version"\s*:\s*"([^"]*)"/.exec(original)?.[1] ?? "";
			expect(oldVersion).not.toBe("9.9.9");
			expect(setVersionField(readFileSync(join(dir, file), "utf8"), oldVersion)).toBe(original);
		});
	});

	test("a file that cannot take the version stops everything before any file is written", () => {
		copyVersionFiles(dir);
		writeFileSync(join(dir, ".omp-plugin", "marketplace.json"), '{ "plugins": [] }\n');
		const before = readFileSync(join(dir, "package.json"), "utf8");
		expect(() => bumpVersions(dir, "9.9.9")).toThrow('no "version" field');
		expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
		expect(() => bumpVersions(dir, "v9.9.9")).toThrow();
	});
});

describe("release", () => {
	const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
	const saved: Record<string, string | undefined> = {};

	async function git(...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], { cwd: dir, env: process.env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
		return stdout.trim();
	}

	beforeEach(async () => {
		for (const [key, value] of Object.entries(env)) {
			saved[key] = process.env[key];
			process.env[key] = value;
		}
		for (const file of VERSION_FILES) {
			mkdirSync(join(dir, file, ".."), { recursive: true });
			cpSync(join(REPO_ROOT, file), join(dir, file));
		}
		writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
		await git("init", "-q", "-b", "main");
		await git("add", "-A");
		await git("commit", "-q", "-m", "start");
	});

	afterEach(() => {
		for (const key of Object.keys(env)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	test("bumps the three files, promotes the changelog, commits `release: <v>` with just those files and tags v<v>; pushes nothing", async () => {
		// 9.9.9, never the repository's own version: the fixture copies the real version files, and a release to the version
		// they already hold would leave them unchanged (as it did on the release commit itself).
		await release(dir, "9.9.9", "2026-10-21");
		expect(await git("log", "-1", "--format=%s")).toBe("release: 9.9.9");
		expect((await git("show", "--name-only", "--format=", "HEAD")).split("\n").sort()).toEqual([".omp-plugin/marketplace.json", "CHANGELOG.md", "package.json", "plugin/package.json"]);
		expect(await git("tag", "--list")).toBe("v9.9.9");
		expect(await git("rev-parse", "v9.9.9^{commit}")).toBe(await git("rev-parse", "HEAD"));
		expect(await git("status", "--porcelain")).toBe("");
		expect(readJson(join(dir, "package.json"))).toMatchObject({ version: "9.9.9" });
		expect(extractChangelogSection(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), "9.9.9")).toBe("- new thing\n- another thing");
		expect(await git("remote")).toBe("");
	});

	test("a dirty tree, an existing tag and an empty Unreleased are refused and leave the repository as it was", async () => {
		const packageBefore = readFileSync(join(dir, "package.json"), "utf8");
		writeFileSync(join(dir, "stray.txt"), "x");
		await expect(release(dir, "0.5.0", "2026-10-21")).rejects.toThrow("not clean");
		rmSync(join(dir, "stray.txt"));

		await git("tag", "-a", "-m", "earlier", "v0.5.0");
		await expect(release(dir, "0.5.0", "2026-10-21")).rejects.toThrow("exists already");
		await git("tag", "-d", "v0.5.0");

		writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## 0.4.0\n\n- x\n");
		await git("commit", "-qam", "empty unreleased");
		await expect(release(dir, "0.5.0", "2026-10-21")).rejects.toThrow("no entries");
		expect(await git("status", "--porcelain")).toBe("");
		expect(await git("log", "-1", "--format=%s")).toBe("empty unreleased");
		expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(packageBefore);
	});
});

describe("third-party notices", () => {
	const MIT = "MIT License\n\nCopyright (c) 2024 Ada Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy";

	/** `node_modules/<name>` under the fixture root with a package.json and the given files. */
	function fixturePackage(name: string, files: Record<string, string>, manifest: Record<string, unknown> = {}): string {
		const pkg = join(dir, "node_modules", ...name.split("/"));
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "1.2.3", license: "MIT", ...manifest }));
		for (const [file, text] of Object.entries(files)) writeFileSync(join(pkg, file), text);
		return pkg;
	}

	/** A metafile with one output whose inputs are the given files, each contributing `bytes`. */
	function metafile(...inputs: [string, number][]): { outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> } {
		return { outputs: { "./app.js": { inputs: Object.fromEntries(inputs.map(([file, bytes]) => [file, { bytesInOutput: bytes }])) } } };
	}

	const extras = { embeddedPackages: [], vendored: [], suppliedDir: "" };

	test("a bundled package with a LICENSE yields an entry carrying its version, SPDX id and copyright line", () => {
		fixturePackage("left-pad", { LICENSE: MIT });
		const [entry, ...rest] = collectNotices(dir, metafile(["node_modules/left-pad/index.js", 40]), extras);
		expect(rest).toEqual([]);
		expect(entry).toMatchObject({ name: "left-pad", version: "1.2.3", license: "MIT", dir: "node_modules/left-pad", supplied: false });
		expect(entry?.licenses).toEqual([{ file: "LICENSE", text: MIT }]);
		const text = renderNotices(entry === undefined ? [] : [entry], { name: "omp-cloud", version: "9.9.9" });
		expect(text).toContain("left-pad 1.2.3\nLicense: MIT");
		expect(text).toContain("Copyright (c) 2024 Ada Example");
	});

	test("a bundled package without license text fails the build and the error names it", () => {
		fixturePackage("fine", { LICENSE: MIT });
		fixturePackage("no-license", { "README.md": "nothing legal here" });
		fixturePackage("@scope/also-none", {}, { license: "Apache-2.0" });
		const meta = metafile(["node_modules/fine/a.js", 1], ["node_modules/no-license/b.js", 1], ["node_modules/@scope/also-none/c.js", 1]);
		expect(() => collectNotices(dir, meta, extras)).toThrow(/@scope\/also-none@1\.2\.3 \(Apache-2\.0, node_modules\/@scope\/also-none\); no-license@1\.2\.3 \(MIT, node_modules\/no-license\)/);
		expect(() => collectNotices(dir, metafile(["node_modules/fine/a.js", 1]), extras)).not.toThrow();
	});

	test("a package that ships no license can be covered by a text this repository supplies for exactly that version", () => {
		fixturePackage("bare", {});
		const supplied = join(dir, "license-texts");
		mkdirSync(join(supplied, "bare@1.2.3"), { recursive: true });
		writeFileSync(join(supplied, "bare@1.2.3", "LICENSE"), MIT);
		const meta = metafile(["node_modules/bare/x.js", 5]);
		const [entry] = collectNotices(dir, meta, { ...extras, suppliedDir: supplied });
		expect(entry).toMatchObject({ name: "bare", supplied: true, licenses: [{ file: "LICENSE", text: MIT }] });
		expect(renderNotices(entry === undefined ? [] : [entry], { name: "omp-cloud", version: "1" })).toContain("ships no license file");
		// A new version of the package is not covered by the old text.
		writeFileSync(join(dir, "node_modules", "bare", "package.json"), JSON.stringify({ name: "bare", version: "2.0.0", license: "MIT" }));
		expect(() => collectNotices(dir, meta, { ...extras, suppliedDir: supplied })).toThrow("bare@2.0.0");
	});

	test("the bundled set is what contributes bytes: dropped packages and the repository's own files are left out, nested copies are their own entry", () => {
		const meta = {
			outputs: {
				"./main.js": { inputs: { "src/main.ts": { bytesInOutput: 9 }, "node_modules/a/x.js": { bytesInOutput: 3 }, "node_modules/dropped/y.js": { bytesInOutput: 0 }, "node_modules/a/node_modules/b/z.js": { bytesInOutput: 2 } } },
				"./client.js": { inputs: { "node_modules/@s/c/w.js": { bytesInOutput: 4 }, "node_modules/a/x.js": { bytesInOutput: 1 } } },
			},
		};
		expect(bundledPackageDirs(meta)).toEqual(["node_modules/@s/c", "node_modules/a", "node_modules/a/node_modules/b"]);
		expect(packageOf("node_modules/@s/c/deep/file.js")).toEqual({ name: "@s/c", dir: "node_modules/@s/c" });
		expect(packageOf("src/main.ts")).toBeNull();
	});

	test("the native addon's package and vendored files are covered, and a text another entry already printed is printed once", () => {
		fixturePackage("@oh-my-pi/pi-natives-linux-x64", { LICENSE: MIT, "THIRD-PARTY-NOTICES.txt": "rust crate notices" });
		fixturePackage("@oh-my-pi/pi-natives", { LICENSE: MIT, "THIRD-PARTY-NOTICES.txt": "rust crate notices" });
		mkdirSync(join(dir, "src", "kit"), { recursive: true });
		writeFileSync(join(dir, "src", "kit", "LICENSE"), "kit license\nCopyright (c) kit authors");
		const entries = collectNotices(dir, metafile(["node_modules/@oh-my-pi/pi-natives/native/index.js", 7], ["src/kit/ui.tsx", 3], ["src/other/page.tsx", 3]), {
			embeddedPackages: ["node_modules/@oh-my-pi/pi-natives-linux-x64"],
			vendored: [
				{ dir: "src/kit", name: "the kit", source: "upstream 1.0", license: "MIT" },
				{ dir: "src/unused", name: "unused vendored", source: "x", license: "MIT" },
			],
			suppliedDir: "",
		});
		expect(entries.map((entry) => entry.name)).toEqual(["@oh-my-pi/pi-natives", "@oh-my-pi/pi-natives-linux-x64", "the kit"]);
		expect(entries.find((entry) => entry.name === "the kit")).toMatchObject({ version: "vendored from upstream 1.0", license: "MIT" });
		const text = renderNotices(entries, { name: "omp-cloud", version: "9.9.9" });
		expect(text.split("rust crate notices").length - 1).toBe(1);
		expect(text.split(MIT).length - 1).toBe(1);
		expect(text).toContain("(identical to the text printed under @oh-my-pi/pi-natives 1.2.3, LICENSE)");
		expect(text).toContain("Copyright (c) kit authors");
	});

	test("license counts group the entries by SPDX expression", () => {
		const entry = (license: string) => readEntry(dir, fixturePackage(`p-${license.replace(/\W/g, "")}-${Math.random().toString(36).slice(2, 6)}`, { LICENSE: "x" }, { license }));
		expect(licenseCounts([entry("MIT"), entry("MIT"), entry("ISC")])).toEqual([["MIT", 2], ["ISC", 1]]);
	});

	test("every package this repository's real build bundles has license text, from the package or from scripts/license-texts", async () => {
		const result = await Bun.build({ entrypoints: [join(REPO_ROOT, "src", "bin.ts")], root: REPO_ROOT, metafile: true, target: "bun", outdir: join(dir, "out") });
		expect(result.success).toBe(true);
		expect(result.metafile).toBeDefined();
		if (result.metafile === undefined) return;
		const entries = collectNotices(REPO_ROOT, result.metafile, { embeddedPackages: ["node_modules/@oh-my-pi/pi-natives-linux-x64"], vendored: [{ dir: "src/dashboard/client/kit", name: "kit", source: "omp-stats", license: "MIT" }], suppliedDir: join(REPO_ROOT, "scripts", "license-texts") });
		expect(entries.length).toBeGreaterThan(15);
		expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(["e2b", "react", "@oh-my-pi/pi-natives-linux-x64"]));
	});
});

describe("the plugin bundle", () => {
	/** Every file under `root`, relative and sorted. */
	function filesUnder(root: string): string[] {
		return [...new Bun.Glob("**/*").scanSync({ cwd: root, dot: true, onlyFiles: true })].sort();
	}

	/** The JSON object in `text`. */
	function readJsonText(text: string): Record<string, unknown> {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) throw new Error("not an object");
		return parsed;
	}

	/** `root` holds exactly the plugin's files and the catalog as the repository has them, but for the version of the two manifests, which is `version`. */
	function expectBundleOf(root: string, version: string): void {
		const source = filesUnder(join(REPO_ROOT, "plugin"));
		expect(filesUnder(root)).toEqual([...source.map((file) => `plugin/${file}`), ".omp-plugin/marketplace.json"].sort());
		for (const file of source) {
			const original = readFileSync(join(REPO_ROOT, "plugin", file));
			const expected = file === "package.json" ? Buffer.from(setVersionField(original.toString("utf8"), version)) : original;
			expect(readFileSync(join(root, "plugin", file))).toEqual(expected);
		}
		const catalog = readFileSync(join(REPO_ROOT, ".omp-plugin", "marketplace.json"), "utf8");
		expect(readFileSync(join(root, ".omp-plugin", "marketplace.json"), "utf8")).toBe(setVersionField(catalog, version));
	}

	test("a checkout's stub reports no bundle", () => {
		expect(bundledPlugin).toBeNull();
	});

	test("it carries every file of plugin/ and the marketplace catalog, and no node_modules", () => {
		const files = pluginBundleFiles(REPO_ROOT, "9.9.9");
		expect(Object.keys(files).sort()).toEqual([...filesUnder(join(REPO_ROOT, "plugin")).map((file) => `plugin/${file}`), ".omp-plugin/marketplace.json"].sort());
		expect(Object.keys(files).some((name) => name.includes("node_modules"))).toBe(false);
		expect(files["plugin/src/index.ts"]).toEqual(readFileSync(join(REPO_ROOT, "plugin", "src", "index.ts")));
	});

	test("node_modules inside plugin/ stays out, and anything that is not a regular file is refused", () => {
		mkdirSync(join(dir, "plugin", "node_modules", "dep"), { recursive: true });
		mkdirSync(join(dir, ".omp-plugin"), { recursive: true });
		writeFileSync(join(dir, "plugin", "package.json"), '{ "version": "0.1.0" }');
		writeFileSync(join(dir, "plugin", "node_modules", "dep", "index.js"), "x");
		writeFileSync(join(dir, ".omp-plugin", "marketplace.json"), '{ "plugins": [{ "version": "0.1.0" }] }');
		expect(Object.keys(pluginBundleFiles(dir, "9.9.9")).sort()).toEqual([".omp-plugin/marketplace.json", "plugin/package.json"]);
		symlinkSync("package.json", join(dir, "plugin", "link.json"));
		expect(() => pluginBundleFiles(dir, "9.9.9")).toThrow("plugin/link.json is not a regular file");
	});

	test("a tar of it extracts to exactly plugin/ and the catalog, byte for byte but for the release's version", async () => {
		const tar = await new Bun.Archive(pluginBundleFiles(REPO_ROOT, "9.9.9"), { compress: "gzip" }).bytes();
		await new Bun.Archive(tar).extract(join(dir, "out"));
		expectBundleOf(join(dir, "out"), "9.9.9");
	});

	test("a build at version X yields a bundle whose two manifests say X, and the working tree is untouched", () => {
		const manifests = [join("plugin", "package.json"), join(".omp-plugin", "marketplace.json")];
		const before = manifests.map((file) => readFileSync(join(REPO_ROOT, file), "utf8"));
		const files = pluginBundleFiles(REPO_ROOT, "0.5.0-rc.1");
		const text = (name: string): string => new TextDecoder().decode(files[name]);
		expect(readJsonText(text("plugin/package.json"))).toMatchObject({ name: "omp-cloud", version: "0.5.0-rc.1" });
		expect(readJsonText(text(".omp-plugin/marketplace.json"))).toMatchObject({ plugins: [{ name: "omp-cloud", version: "0.5.0-rc.1", source: "./plugin" }] });
		expect(manifests.map((file) => readFileSync(join(REPO_ROOT, file), "utf8"))).toEqual(before);
		expect(() => pluginBundleFiles(REPO_ROOT, "v0.5.0")).toThrow();
	});

	test("ensurePlugin on a bundle built at X installs and reports X, whatever the source tree says", async () => {
		const tar = join(dir, "bundle.tar.gz");
		writeFileSync(tar, await new Bun.Archive(pluginBundleFiles(REPO_ROOT, "0.5.0-rc.1"), { compress: "gzip" }).bytes());
		let installed: string | undefined;
		let market: string | undefined;
		const run: CommandRunner = async (argv) => {
			const [, , verb, action, arg] = argv;
			const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
			if (verb === "list") {
				const entries = installed === undefined ? [] : [{ id: "omp-cloud@omp-cloud", entries: [{ version: installed }] }];
				return ok(JSON.stringify({ npm: [], marketplace: entries }));
			}
			if (verb === "marketplace" && action === "list") return ok(market === undefined ? "No marketplaces configured\n" : `Configured Marketplaces:\n\n  omp-cloud  ${market}\n`);
			if (verb === "marketplace" && action === "add") {
				market = arg;
				return ok();
			}
			if (verb === "install" && market !== undefined) {
				installed = String(readJsonText(readFileSync(join(market, "plugin", "package.json"), "utf8")).version);
				return ok();
			}
			return { code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
		};
		const steps = await ensurePlugin({
			run,
			omp: { path: "omp", version: "18.12.3" },
			mode: "managed",
			appDir: join(dir, "app"),
			version: "0.5.0-rc.1",
			configPath: join(dir, "none.json"),
			tokenFile: join(dir, "none.token"),
			env: {},
			home: join(dir, "home"),
			bundle: { tar },
		});
		expect(steps.find((step) => step.id === "plugin.install")?.detail).toContain("omp-cloud@omp-cloud 0.5.0-rc.1;");
		expect(installed).toBe("0.5.0-rc.1");
	});

	test("the replacement module embeds the tar as a file of the binary and keeps the stub's export", () => {
		expect(pluginBundleSource("/tmp/x/plugin-bundle.tar.gz")).toBe('import tar from "/tmp/x/plugin-bundle.tar.gz" with { type: "file" };\nexport const bundledPlugin = { tar };\n');
	});

	test("a compiled binary extracts a bundle identical to plugin/ through ensurePlugin, and the stub on disk is never modified", async () => {
		const stubPath = join(REPO_ROOT, "src", "setup", "plugin-bundle.ts");
		const stubBefore = readFileSync(stubPath, "utf8");
		const tarPath = join(dir, "plugin-bundle.tar.gz");
		writeFileSync(tarPath, await new Bun.Archive(pluginBundleFiles(REPO_ROOT, "9.9.9"), { compress: "gzip" }).bytes());
		// What `omp-cloud setup` runs in the binary: ensurePlugin with the embedded bundle, against an omp that has nothing.
		const entry = join(dir, "entry.ts");
		writeFileSync(
			entry,
			[
				`import { ensurePlugin } from ${JSON.stringify(join(REPO_ROOT, "src", "setup", "plugin.ts"))};`,
				"const [appDir, version, home] = process.argv.slice(2);",
				"const steps = await ensurePlugin({",
				'\trun: async (argv) => ({ code: 0, stdout: argv.includes("--json") ? \'{"npm":[],"marketplace":[]}\' : "No marketplaces configured\\n", stderr: "" }),',
				'\tomp: { path: "/fake/omp", version: "18.12.3" },',
				'\tmode: "managed", appDir, version, home, env: {},',
				'\tconfigPath: "/nonexistent/service.json", tokenFile: "/nonexistent/service.token",',
				"});",
				"console.log(JSON.stringify(steps));",
				"",
			].join("\n"),
		);
		const binary = join(dir, "bundle-check");
		try {
			const result = await Bun.build({
				entrypoints: [entry],
				root: REPO_ROOT,
				plugins: [embedPluginPlugin(pluginBundleSource(tarPath))],
				compile: { outfile: binary, autoloadDotenv: false, autoloadBunfig: false },
			});
			expect(result.success).toBe(true);
		} finally {
			expect(readFileSync(stubPath, "utf8")).toBe(stubBefore);
		}

		const app = join(dir, "app");
		const proc = Bun.spawn([binary, app, "9.9.9", join(dir, "home")], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		const steps: unknown = JSON.parse(stdout);
		expect(steps).toMatchObject([{ id: "plugin.bundle", status: "changed" }, { id: "plugin.marketplace", status: "changed" }, { id: "plugin.install", status: "changed" }, { id: "plugin.config", status: "skipped" }]);

		const extracted = join(app, "marketplace", "9.9.9");
		expectBundleOf(extracted, "9.9.9");
		expect(readlinkSync(join(app, "marketplace", "current"))).toBe("9.9.9");
	}, 180_000);
});
