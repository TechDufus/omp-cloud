/**
 * Release tooling.
 *
 *   bun run scripts/release.ts build [--version X] [--out dir]
 *       `dist/` (or --out): the two executables `omp-cloud-linux-x86_64` and `omp-cloud-linux-arm64` compiled from
 *       src/bin.ts with the version and build id injected, a `<file>.sha256` sidecar for each (`sha256sum -c` format),
 *       `release.json` (the manifest, src/update/manifest.ts) and `notes.md` (the CHANGELOG section of the version).
 *       --version defaults to package.json's; a build of a version that is not in the CHANGELOG uses `## Unreleased`.
 *       Each binary also carries a gzip tar of `plugin/` and `.omp-plugin/marketplace.json` (`src/setup/plugin-bundle.ts`,
 *       replaced for the build the way scripts/embed-natives.ts replaces the addon module), which setup and the updater
 *       extract to `<app>/marketplace/<version>/` for `omp plugin marketplace add`.
 *   bun run scripts/release.ts release <version>
 *       Bumps package.json, plugin/package.json and .omp-plugin/marketplace.json together, moves CHANGELOG's
 *       `## Unreleased` into `## <version> (<date>)`, commits `release: <version>` and tags `v<version>`. It pushes nothing.
 *
 * `mise run release:build` and `mise run release` run these.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { MIGRATIONS } from "../src/store/schema";
import { compressAddons, embeddedAddonSource, embedNativesPlugin, installedNativesVersion, leafAddons, NATIVE_TARGETS, type NativeArch } from "./embed-natives";
import { collectNotices, type NoticeEntry, renderNotices } from "./notices";
import type { ReleaseManifest } from "../src/update/manifest";
import type { Build } from "../src/version";

const REPO_ROOT = resolve(import.meta.dir, "..");
/** `1.2.3` and `1.2.3-rc.1`: what a release version may be, with no leading `v`. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const VMON_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

/** The executables of a release: the asset name and the architecture (`scripts/embed-natives.ts` knows its bun target). */
export const TARGETS: readonly { name: string; arch: NativeArch }[] = [
	{ name: "omp-cloud-linux-x86_64", arch: "x86_64" },
	{ name: "omp-cloud-linux-arm64", arch: "arm64" },
];

/** The third-party notices asset of a release (`scripts/notices.ts`). */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

/** Files vendored in this repository that carry their own license and are bundled into the dashboard client. */
const VENDORED = [{ dir: "src/dashboard/client/kit", name: "omp-stats UI kit (vendored)", source: "@oh-my-pi/omp-stats 18.12.2", license: "MIT" }];

export type ReleaseCommand = { command: "build"; version: string | undefined; out: string | undefined } | { command: "release"; version: string };

/** Throws a readable Error unless `version` is `x.y.z` or `x.y.z-pre`. */
export function checkVersion(version: string): string {
	if (!VERSION_PATTERN.test(version)) throw new Error(`${JSON.stringify(version)} is not a version such as 1.2.3 (no leading v)`);
	return version;
}

const USAGE = "usage: release.ts build [--version <x.y.z>] [--out <dir>]\n       release.ts release <x.y.z>";

export function parseReleaseArgs(argv: readonly string[]): ReleaseCommand {
	const [command, ...rest] = argv;
	if (command === "release") {
		const [version, ...extra] = rest;
		if (version === undefined || extra.length > 0) throw new Error(`release takes exactly one version\n${USAGE}`);
		return { command, version: checkVersion(version) };
	}
	if (command !== "build") throw new Error(USAGE);
	let version: string | undefined;
	let out: string | undefined;
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i];
		const value = rest[i + 1];
		if (value === undefined || value === "") throw new Error(`${flag} needs a value\n${USAGE}`);
		if (flag === "--version") version = checkVersion(value);
		else if (flag === "--out") out = value;
		else throw new Error(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
	}
	return { command, version, out };
}

// ---- CHANGELOG

const SECTION_HEADING = /^## (.+?)\s*$/;

/** The sections of a changelog: each `## <heading>` and the lines up to the next one, in file order. */
function sections(changelog: string): { heading: string; start: number; end: number; lines: string[] }[] {
	const lines = changelog.split("\n");
	const found: { heading: string; start: number; end: number; lines: string[] }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const heading = SECTION_HEADING.exec(lines[i] ?? "")?.[1];
		if (heading === undefined) continue;
		const previous = found.at(-1);
		if (previous !== undefined) previous.end = i;
		found.push({ heading, start: i, end: lines.length, lines: [] });
	}
	for (const section of found) section.lines = lines.slice(section.start + 1, section.end);
	return found;
}

/** The notes of `version`: the trimmed body of its `## <version> (<date>)` section, or null when there is none. */
export function extractChangelogSection(changelog: string, version: string): string | null {
	const section = sections(changelog).find((candidate) => candidate.heading === version || candidate.heading.startsWith(`${version} (`));
	return section === undefined ? null : section.lines.join("\n").trim();
}

/** The body of `## Unreleased`, or null. */
export function unreleasedSection(changelog: string): string | null {
	const section = sections(changelog).find((candidate) => candidate.heading === "Unreleased");
	return section === undefined ? null : section.lines.join("\n").trim();
}

/** The changelog with `## Unreleased`'s entries under a new `## <version> (<date>)` and an empty `## Unreleased` above it. */
export function promoteUnreleased(changelog: string, version: string, date: string): string {
	if (extractChangelogSection(changelog, version) !== null) throw new Error(`CHANGELOG.md already has a section for ${version}`);
	const unreleased = sections(changelog).find((candidate) => candidate.heading === "Unreleased");
	if (unreleased === undefined) throw new Error("CHANGELOG.md has no `## Unreleased` section");
	if (unreleased.lines.join("\n").trim() === "") throw new Error("CHANGELOG.md `## Unreleased` has no entries to release");
	const lines = changelog.split("\n");
	lines[unreleased.start] = `## Unreleased\n\n## ${version} (${date})`;
	return lines.join("\n");
}

// ---- version bump

/** The three files that carry the release version, relative to the repository root. */
export const VERSION_FILES: readonly string[] = ["package.json", "plugin/package.json", ".omp-plugin/marketplace.json"];

const VERSION_FIELD = /("version"\s*:\s*")[^"]*(")/;

/** `text` with the first `"version"` field set to `version`; the rest of the file is untouched. */
export function setVersionField(text: string, version: string): string {
	if (!VERSION_FIELD.test(text)) throw new Error('no "version" field to set');
	return text.replace(VERSION_FIELD, `$1${version}$2`);
}

/** Sets the version in `VERSION_FILES` under `root`; returns the paths written. Every file is checked before any is written. */
export function bumpVersions(root: string, version: string): string[] {
	checkVersion(version);
	const updated = VERSION_FILES.map((file) => {
		const path = join(root, file);
		const next = setVersionField(readFileSync(path, "utf8"), version);
		JSON.parse(next);
		return { path, next };
	});
	for (const { path, next } of updated) writeFileSync(path, next);
	return updated.map(({ path }) => path);
}

// ---- manifest

/** What `buildManifest` reads from the repository, so a test can feed it. */
export interface ManifestInput {
	version: string;
	build: Build;
	notes: string;
	/** The built files, in `TARGETS` order. */
	files: { name: string; arch: "x86_64" | "arm64"; size: number; sha256: string }[];
	pluginVersion: string;
	/** `infra/vmon.json`'s `version`: `v<x.y.z>`. */
	vmonVersion: string;
	/** The omp the plugin and the VMs need at least. */
	ompMin: string;
	/** The newest schema migration the service knows. */
	schema: number;
}

export function buildManifest(input: ManifestInput): ReleaseManifest {
	checkVersion(input.version);
	if (!VMON_TAG_PATTERN.test(input.vmonVersion)) throw new Error(`infra/vmon.json version ${JSON.stringify(input.vmonVersion)} is not a tag such as v0.4.0`);
	return {
		product: "omp-cloud",
		version: input.version,
		build: input.build,
		notes: input.notes,
		files: input.files.map((file) => ({ name: file.name, platform: "linux", arch: file.arch, size: file.size, sha256: file.sha256 })),
		plugin: { version: input.pluginVersion },
		requires: { vmon: { version: input.vmonVersion }, omp: { min: input.ompMin }, schema: input.schema },
	};
}

/** `sha256sum` format: `<hex>  <name>`. */
export function sidecar(sha256: string, name: string): string {
	return `${sha256}  ${name}\n`;
}

function readJsonField(path: string, field: string): string {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	const value = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, field) : undefined;
	if (typeof value !== "string" || value === "") throw new Error(`${path} has no string "${field}"`);
	return value;
}

/** The omp release the plugin needs at least: the SDK version this repository pins. */
function pinnedOmp(root: string): string {
	const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const dependencies = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "dependencies") : undefined;
	const pin = typeof dependencies === "object" && dependencies !== null ? Reflect.get(dependencies, "@oh-my-pi/pi-coding-agent") : undefined;
	if (typeof pin !== "string" || !/^\d+\.\d+\.\d+$/.test(pin)) throw new Error("package.json does not pin @oh-my-pi/pi-coding-agent to an exact version");
	return pin;
}

/** What the manifest takes from the repository: the plugin's version, the vibemon pin, the omp pin and the newest schema. */
export function repositoryFacts(root: string): Pick<ManifestInput, "pluginVersion" | "vmonVersion" | "ompMin" | "schema"> {
	return {
		pluginVersion: readJsonField(join(root, "plugin", "package.json"), "version"),
		vmonVersion: readJsonField(join(root, "infra", "vmon.json"), "version"),
		ompMin: pinnedOmp(root),
		schema: MIGRATIONS.length,
	};
}

// ---- plugin bundle

/**
 * The plugin's files as the bundle carries them: `plugin/` (no `node_modules`) and `.omp-plugin/marketplace.json`, keyed
 * by their path in the tar, in sorted order. The tar says `version`, the release's: `plugin/package.json` and the
 * marketplace's plugin entry are stamped here (never in the working tree), so `omp plugin install` puts in the version
 * the service and the binary report, whatever the source tree's files say.
 */
export function pluginBundleFiles(root: string, version: string): Record<string, Uint8Array> {
	checkVersion(version);
	const files: Record<string, Uint8Array> = {};
	const catalog = join(".omp-plugin", "marketplace.json");
	const read = (relativePath: string): Uint8Array => {
		const bytes = readFileSync(join(root, relativePath));
		return relativePath === join("plugin", "package.json") || relativePath === catalog ? new TextEncoder().encode(setVersionField(bytes.toString("utf8"), version)) : bytes;
	};
	const walk = (relativeDir: string): void => {
		for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const relativePath = join(relativeDir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") walk(relativePath);
			} else if (entry.isFile()) {
				files[relativePath] = read(relativePath);
			} else {
				throw new Error(`${relativePath} is not a regular file; the plugin bundle carries files only`);
			}
		}
	};
	walk("plugin");
	files[catalog] = read(catalog);
	return files;
}

/** The module `src/setup/plugin-bundle.ts` becomes in a release build: the tar at `tarPath` is embedded as a file of the binary. */
export function pluginBundleSource(tarPath: string): string {
	return [`import tar from ${JSON.stringify(tarPath)} with { type: "file" };`, "export const bundledPlugin = { tar };", ""].join("\n");
}

/**
 * A `Bun.build` plugin that replaces `src/setup/plugin-bundle.ts` (the stub that says there is no bundle) with `source`,
 * the way `embedNativesPlugin` replaces the SDK's addon module. The file on disk is never touched, so there is nothing
 * to reset after a build, however it ends.
 */
export function embedPluginPlugin(source: string): Bun.BunPlugin {
	return {
		name: "omp-cloud-embed-plugin",
		setup(build) {
			build.onLoad({ filter: /src[\\/]setup[\\/]plugin-bundle\.ts$/ }, () => ({ contents: source, loader: "js" }));
		},
	};
}

// ---- commands

async function run(command: string[], cwd: string): Promise<string> {
	// The live environment, not Bun's startup snapshot: the tests set git's identity and config there.
	const proc = Bun.spawn(command, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}): ${(stderr || stdout).trim()}`);
	return stdout;
}

/** `YYYYMMDDHHMMSS` of a UTC time. */
function compactTime(at: Date): string {
	return at.toISOString().replace(/[-:T]|\.\d+Z$/g, "");
}

export interface BuildOptions {
	root: string;
	out: string;
	version: string;
	now?: () => Date;
}

/** Compiles both executables into `out` (emptied first) with their sidecars, `release.json` and `notes.md`; returns the manifest. */
export async function buildRelease(options: BuildOptions): Promise<ReleaseManifest> {
	// Before the slow compiles: a missing pin or an unparsable file stops the build here.
	const facts = repositoryFacts(options.root);
	const { root, out, version } = options;
	const commit = (await run(["git", "rev-parse", "HEAD"], root)).trim();
	const createdAt = (options.now ?? (() => new Date()))();
	const build: Build = { id: `${compactTime(createdAt)}-${commit.slice(0, 7)}`, commit, createdAt: createdAt.toISOString() };

	const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	let notes = extractChangelogSection(changelog, version);
	if (notes === null) {
		notes = unreleasedSection(changelog) ?? "";
		console.warn(`release: CHANGELOG.md has no section for ${version}; the notes are its Unreleased entries`);
	}

	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const files: ManifestInput["files"] = [];
	const natives = installedNativesVersion(root);
	const notices = new Map<string, NoticeEntry>();
	const work = mkdtempSync(join(tmpdir(), "omp-cloud-release-"));
	try {
		// The plugin rides in the binary too (src/setup/plugin-bundle.ts), for setup and the updater to put in omp.
		const bundlePath = join(work, "plugin-bundle.tar.gz");
		writeFileSync(bundlePath, await new Bun.Archive(pluginBundleFiles(root, version), { compress: "gzip" }).bytes());
		for (const target of TARGETS) {
			const path = join(out, target.name);
			// The SDK's native addon rides in the binary (scripts/embed-natives.ts); without it the binary only starts where an omp left its natives cache.
			const addons = await leafAddons(root, target.arch, natives, join(root, "node_modules", ".cache", "omp-cloud-natives"));
			const embedded = compressAddons(addons, target.arch, natives, join(work, target.arch));
			const result = await Bun.build({
				entrypoints: [join(root, "src", "bin.ts")],
				root,
				metafile: true,
				plugins: [embedNativesPlugin(embeddedAddonSource(embedded)), embedPluginPlugin(pluginBundleSource(bundlePath))],
				// Values are string literals the bundler substitutes for the identifiers src/version.ts reads; the build is JSON inside one.
				define: { __OMP_CLOUD_VERSION__: JSON.stringify(version), __OMP_CLOUD_BUILD__: JSON.stringify(JSON.stringify(build)) },
				compile: {
					target: NATIVE_TARGETS[target.arch].bunTarget,
					outfile: path,
					// A service must not pick up a .env or bunfig.toml that happens to sit in its working directory.
					autoloadDotenv: false,
					autoloadBunfig: false,
				},
			});
			if (!result.success || result.metafile === undefined) throw new Error(`building ${target.name} failed:\n${result.logs.map((log) => log.message).join("\n")}`);
			// What the binary bundles, read from this very build; the native addon's package is embedded by the plugin, not bundled, so it is named.
			for (const entry of collectNotices(root, result.metafile, { embeddedPackages: [relative(root, dirname(addons[0]?.path ?? ""))], vendored: VENDORED, suppliedDir: join(root, "scripts", "license-texts") })) {
				notices.set(`${entry.name}@${entry.version}`, entry);
			}
			const bytes = readFileSync(path);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			writeFileSync(join(out, `${target.name}.sha256`), sidecar(sha256, target.name));
			files.push({ name: target.name, arch: target.arch, size: statSync(path).size, sha256 });
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	const manifest = buildManifest({ version, build, notes, files, ...facts });
	writeFileSync(join(out, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(join(out, "notes.md"), notes === "" ? "" : `${notes}\n`);
	const noticesText = renderNotices([...notices.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)), { name: "omp-cloud", version });
	writeFileSync(join(out, NOTICES_FILE), noticesText);
	writeFileSync(join(out, `${NOTICES_FILE}.sha256`), sidecar(createHash("sha256").update(noticesText).digest("hex"), NOTICES_FILE));
	return manifest;
}

/** Bumps the versions, promotes the changelog, commits `release: <version>` and tags `v<version>`; pushes nothing. */
export async function release(root: string, version: string, today: string): Promise<string[]> {
	const tag = `v${version}`;
	if ((await run(["git", "status", "--porcelain"], root)).trim() !== "") throw new Error("the working tree is not clean: commit or stash first");
	if ((await run(["git", "tag", "--list", tag], root)).trim() !== "") throw new Error(`tag ${tag} exists already`);
	const changelogPath = join(root, "CHANGELOG.md");
	const promoted = promoteUnreleased(readFileSync(changelogPath, "utf8"), version, today);
	const bumped = bumpVersions(root, version);
	writeFileSync(changelogPath, promoted);
	const files = [...VERSION_FILES, "CHANGELOG.md"];
	await run(["git", "add", "--", ...files], root);
	await run(["git", "commit", "-m", `release: ${version}`, "--", ...files], root);
	await run(["git", "tag", "-a", tag, "-m", `omp-cloud ${version}`], root);
	return bumped;
}

async function main(argv: readonly string[]): Promise<void> {
	const parsed = parseReleaseArgs(argv);
	if (parsed.command === "release") {
		await release(REPO_ROOT, parsed.version, new Date().toISOString().slice(0, 10));
		console.log(`released ${parsed.version}: committed "release: ${parsed.version}" and tagged v${parsed.version} locally; nothing was pushed.`);
		console.log(`push it (this starts the release workflow):  git push origin HEAD v${parsed.version}`);
		return;
	}
	const version = parsed.version ?? readJsonField(join(REPO_ROOT, "package.json"), "version");
	const out = resolve(REPO_ROOT, parsed.out ?? "dist");
	const manifest = await buildRelease({ root: REPO_ROOT, out, version });
	console.log(`omp-cloud ${manifest.version} (${manifest.build.id}) -> ${out}`);
	for (const name of readdirSync(out).sort()) {
		console.log(`  ${name} (${statSync(join(out, name)).size} bytes)`);
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
