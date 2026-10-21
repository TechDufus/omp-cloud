import { isRecord } from "../guards";

export type ReleaseArch = "x86_64" | "arm64";

/** `release.json`: what a release is, its files and what it needs of the rest of the stack. */
export interface ReleaseManifest {
	product: "omp-cloud";
	/** semver, no leading v */
	version: string;
	build: { id: string; commit: string; createdAt: string };
	/** markdown, may be "" */
	notes: string;
	files: { name: string; platform: "linux"; arch: ReleaseArch; size: number; sha256: string }[];
	plugin: { version: string };
	requires: { vmon: { version: string }; omp: { min: string }; schema: number };
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;
const VMON_TAG = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** An asset name: one path segment of plain characters. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_NOTES_CHARS = 200_000;

/** True when `value` is `X.Y.Z` or `X.Y.Z-pre`, without a leading v. */
export function isVersion(value: string): boolean {
	return VERSION.test(value);
}

/** The most-significant-first numbers of a version, and its prerelease part. Throws for anything else. */
function versionParts(version: string): { numbers: [number, number, number]; pre: string } {
	const match = VERSION.exec(version);
	if (match === null) throw new Error(`not a version: ${JSON.stringify(version.slice(0, 50))}`);
	return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" };
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer; a prerelease is older than its release. */
export function compareVersions(a: string, b: string): number {
	const left = versionParts(a);
	const right = versionParts(b);
	for (let i = 0; i < 3; i++) {
		const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
		if (diff !== 0) return diff;
	}
	if (left.pre === right.pre) return 0;
	if (left.pre === "") return 1;
	if (right.pre === "") return -1;
	return left.pre < right.pre ? -1 : 1;
}

/** The asset of this machine's executable. */
export function releaseAssetName(arch: ReleaseArch): string {
	return `omp-cloud-linux-${arch}`;
}

/** This machine's architecture as releases name it; throws on one no release is built for. */
export function hostArch(arch: string = process.arch): ReleaseArch {
	if (arch === "x64") return "x86_64";
	if (arch === "arm64") return "arm64";
	throw new Error(`no omp-cloud release is built for ${arch}`);
}

function text(value: unknown, path: string, max = 200): string {
	if (typeof value !== "string") throw new Error(`release.json: ${path} must be a string`);
	if (value.length > max) throw new Error(`release.json: ${path} is longer than ${max} characters`);
	return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`release.json: ${path} must be an object`);
	return value;
}

/**
 * Parses and checks `release.json`. Missing fields and wrong types throw an Error that names the path; keys it does not
 * know are ignored, so a newer release can add fields.
 */
export function parseManifest(raw: unknown): ReleaseManifest {
	const root = object(raw, "the document");
	if (root.product !== "omp-cloud") throw new Error('release.json: product must be "omp-cloud"');
	const version = text(root.version, "version", 64);
	if (!VERSION.test(version)) throw new Error(`release.json: version ${JSON.stringify(version.slice(0, 50))} is not X.Y.Z (no leading v)`);

	const build = object(root.build, "build");
	const notes = text(root.notes, "notes", MAX_NOTES_CHARS);

	if (!Array.isArray(root.files) || root.files.length === 0) throw new Error("release.json: files must be a non-empty list");
	const files = root.files.map((entry: unknown, index): ReleaseManifest["files"][number] => {
		const at = `files[${index}]`;
		const file = object(entry, at);
		const name = text(file.name, `${at}.name`, 128);
		if (!ASSET_NAME.test(name)) throw new Error(`release.json: ${at}.name ${JSON.stringify(name.slice(0, 50))} is not a plain file name`);
		if (file.platform !== "linux") throw new Error(`release.json: ${at}.platform must be "linux"`);
		if (file.arch !== "x86_64" && file.arch !== "arm64") throw new Error(`release.json: ${at}.arch must be "x86_64" or "arm64"`);
		const size = file.size;
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) throw new Error(`release.json: ${at}.size must be a positive integer`);
		const sha256 = text(file.sha256, `${at}.sha256`, 64);
		if (!SHA256.test(sha256)) throw new Error(`release.json: ${at}.sha256 must be 64 lowercase hex digits`);
		return { name, platform: "linux", arch: file.arch, size, sha256 };
	});
	const seen = new Set<string>();
	for (const file of files) {
		const key = `${file.platform}/${file.arch}`;
		if (seen.has(key)) throw new Error(`release.json: two files for ${key}`);
		seen.add(key);
	}

	const plugin = object(root.plugin, "plugin");
	const pluginVersion = text(plugin.version, "plugin.version", 64);
	if (!VERSION.test(pluginVersion)) throw new Error("release.json: plugin.version is not X.Y.Z");

	const requires = object(root.requires, "requires");
	const vmon = object(requires.vmon, "requires.vmon");
	const vmonVersion = text(vmon.version, "requires.vmon.version", 32);
	if (!VMON_TAG.test(vmonVersion)) throw new Error("release.json: requires.vmon.version must look like v0.4.0");
	const omp = object(requires.omp, "requires.omp");
	const ompMin = text(omp.min, "requires.omp.min", 64);
	if (!VERSION.test(ompMin)) throw new Error("release.json: requires.omp.min is not X.Y.Z");
	const schema = requires.schema;
	if (typeof schema !== "number" || !Number.isSafeInteger(schema) || schema < 1) throw new Error("release.json: requires.schema must be a positive integer");

	return {
		product: "omp-cloud",
		version,
		build: { id: text(build.id, "build.id", 100), commit: text(build.commit, "build.commit", 100), createdAt: text(build.createdAt, "build.createdAt", 100) },
		notes,
		files,
		plugin: { version: pluginVersion },
		requires: { vmon: { version: vmonVersion }, omp: { min: ompMin }, schema },
	};
}
