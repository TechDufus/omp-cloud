/**
 * `THIRD-PARTY-NOTICES.txt` of a release: the copyright and license text of every package that ends up in the compiled
 * binary, which MIT, ISC, BSD and Apache-2.0 require to travel with every copy.
 *
 * The set is read from the build itself. `Bun.build({metafile: true})` reports, per output (the executable's main bundle
 * and the dashboard client's chunk that the service embeds), each input file and `bytesInOutput`; a package is bundled
 * when at least one of its files contributes bytes. Packages that the bundler read but dropped entirely (tree-shaken to
 * nothing) get no entry. Two things are not JavaScript inputs and are added by name: the native addon's package, whose
 * `.node` files `scripts/embed-natives.ts` embeds as zstd frames (its `THIRD-PARTY-NOTICES.txt` carries the licenses of the
 * Rust crates linked into the addon), and the directories of files vendored in this repository that carry their own LICENSE.
 *
 * A bundled package without a license text is an error that names it: compliant notices cannot be produced without one.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The part of `Bun.build`'s metafile this reads: `outputs[file].inputs[file].bytesInOutput`. */
export interface BuildMetafile {
	outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
}

/** One package (or vendored directory) in the notices. */
export interface NoticeEntry {
	name: string;
	version: string;
	/** The SPDX expression its package.json declares, `UNKNOWN` when it declares none. */
	license: string;
	/** Directory the texts were read from, relative to the repository root. */
	dir: string;
	/** Each license file: its name and text. */
	licenses: { file: string; text: string }[];
	/** Each NOTICE or third-party-notices file: its name and text. */
	notices: { file: string; text: string }[];
	/** True when the package ships no license file and the text comes from this repository (`NoticeExtras.suppliedDir`). */
	supplied: boolean;
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicen[cs]e)(?:[-_.].*)?$/i;
const NOTICE_FILE = /^(notice|third[-_]party[-_]notices?)(?:[-_.].*)?$/i;

/** `{name, dir}` of the package a file under a `node_modules` directory belongs to, or null for any other path. The innermost `node_modules` wins, so nested copies resolve to their own directory. */
export function packageOf(file: string): { name: string; dir: string } | null {
	const marker = "node_modules/";
	const at = file.lastIndexOf(marker);
	if (at < 0) return null;
	const start = at + marker.length;
	const parts = file.slice(start).split("/");
	const scoped = parts[0]?.startsWith("@") === true;
	const name = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
	if (name === undefined || name === "" || name.endsWith("/undefined")) return null;
	return { name, dir: file.slice(0, start + name.length) };
}

/** The package directories that contribute bytes to any output of the build, sorted, each once. */
export function bundledPackageDirs(metafile: BuildMetafile): string[] {
	const dirs = new Set<string>();
	for (const output of Object.values(metafile.outputs)) {
		for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
			if (bytesInOutput <= 0) continue;
			const found = packageOf(input);
			if (found !== null) dirs.add(found.dir);
		}
	}
	return [...dirs].sort();
}

/** The SPDX expression of a package.json `license` (or the legacy `licenses`) field. */
function declaredLicense(manifest: unknown): string {
	if (typeof manifest !== "object" || manifest === null) return "UNKNOWN";
	const license: unknown = Reflect.get(manifest, "license");
	if (typeof license === "string" && license !== "") return license;
	if (typeof license === "object" && license !== null && typeof Reflect.get(license, "type") === "string") return String(Reflect.get(license, "type"));
	const legacy: unknown = Reflect.get(manifest, "licenses");
	if (Array.isArray(legacy)) {
		const types = legacy.map((item: unknown) => (typeof item === "object" && item !== null ? Reflect.get(item, "type") : undefined)).filter((type): type is string => typeof type === "string");
		if (types.length > 0) return `(${types.join(" OR ")})`;
	}
	return "UNKNOWN";
}

function readTexts(dir: string, pattern: RegExp): { file: string; text: string }[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && pattern.test(entry.name))
		.map((entry) => ({ file: entry.name, text: readFileSync(join(dir, entry.name), "utf8").replace(/\r\n/g, "\n").trim() }))
		.filter((item) => item.text !== "")
		.sort((a, b) => a.file.localeCompare(b.file));
}

/** What a vendored directory, which has no package.json, is listed as, and where texts this repository supplies live. */
export interface ReadOptions {
	name?: string;
	version?: string;
	license?: string;
	suppliedDir?: string;
}

/** Reads the entry of the package directory `dir` (absolute) of repository `root`. */
export function readEntry(root: string, dir: string, options: ReadOptions = {}): NoticeEntry {
	const manifestPath = join(dir, "package.json");
	const manifest: unknown = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
	const field = (key: string): string | undefined => {
		const value: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, key) : undefined;
		return typeof value === "string" && value !== "" ? value : undefined;
	};
	const name = field("name") ?? options.name;
	if (name === undefined) throw new Error(`${relative(root, dir)} has no package.json name`);
	const version = field("version") ?? options.version ?? "unknown";
	const declared = declaredLicense(manifest);
	const entry: NoticeEntry = {
		name,
		version,
		license: declared === "UNKNOWN" ? (options.license ?? declared) : declared,
		dir: relative(root, dir).split(sep).join("/"),
		licenses: readTexts(dir, LICENSE_FILE),
		notices: readTexts(dir, NOTICE_FILE),
		supplied: false,
	};
	const supplied = options.suppliedDir === undefined ? null : join(options.suppliedDir, `${name}@${version}`);
	if (entry.licenses.length === 0 && supplied !== null && existsSync(supplied)) {
		entry.licenses = readTexts(supplied, LICENSE_FILE);
		entry.supplied = true;
	}
	return entry;
}

/** Throws one Error naming every entry that has no license text. */
export function requireLicenseTexts(entries: readonly NoticeEntry[]): void {
	const missing = entries.filter((entry) => entry.licenses.length === 0).map((entry) => `${entry.name}@${entry.version} (${entry.license}, ${entry.dir})`);
	if (missing.length > 0) {
		throw new Error(`bundled packages without a license file, so no compliant notice can be written: ${missing.join("; ")}`);
	}
}

/** What the notices cover beyond the bundler's JavaScript inputs. */
export interface NoticeExtras {
	/** Package directories (relative to the root) whose files are embedded without passing through the bundler, such as the native addon's leaf packages. */
	embeddedPackages: readonly string[];
	/** Directories vendored in the repository (relative to the root) that carry their own LICENSE, with the name to list them under, used when the bundle contains files from them. */
	vendored: readonly { dir: string; name: string; source: string; license: string }[];
	/**
	 * Directory of license texts this repository supplies for packages that ship none, one `<name>@<version>/` subdirectory
	 * each (the version pins the text: a new version of the package fails the build until someone has checked it again).
	 */
	suppliedDir: string;
}

/**
 * The entries for a build: every bundled package of the metafile, the `extras.embeddedPackages` and each vendored
 * directory the bundle took files from. Sorted by name and version; throws when one lacks a license text.
 */
export function collectNotices(root: string, metafile: BuildMetafile, extras: NoticeExtras): NoticeEntry[] {
	const entries = new Map<string, NoticeEntry>();
	const add = (entry: NoticeEntry): void => {
		entries.set(`${entry.name}@${entry.version}`, entry);
	};
	for (const dir of bundledPackageDirs(metafile)) add(readEntry(root, join(root, dir), { suppliedDir: extras.suppliedDir }));
	for (const dir of extras.embeddedPackages) add(readEntry(root, join(root, dir), { suppliedDir: extras.suppliedDir }));
	const bundled = new Set<string>();
	for (const output of Object.values(metafile.outputs)) {
		for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) if (bytesInOutput > 0) bundled.add(input);
	}
	for (const vendor of extras.vendored) {
		if (![...bundled].some((input) => input.startsWith(`${vendor.dir}/`))) continue;
		add(readEntry(root, join(root, vendor.dir), { name: vendor.name, version: `vendored from ${vendor.source}`, license: vendor.license }));
	}
	const list = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
	requireLicenseTexts(list);
	return list;
}

/** The count of entries per declared SPDX expression, sorted by count then name. */
export function licenseCounts(entries: readonly NoticeEntry[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const RULE = "=".repeat(78);

/**
 * The text of `THIRD-PARTY-NOTICES.txt`. A license or notice text that an earlier entry already printed (same bytes,
 * e.g. the addon's Rust crate notices that two packages carry) is printed once and referred to afterwards.
 */
export function renderNotices(entries: readonly NoticeEntry[], product: { name: string; version: string }): string {
	const out: string[] = [
		`THIRD-PARTY NOTICES for ${product.name} ${product.version}`,
		"",
		`The ${product.name} executable bundles the open-source packages listed below, and the Bun runtime it is compiled with.`,
		"Each package's copyright notice and license text follow its heading, as its license requires.",
		"Bun (https://bun.sh) is MIT-licensed; the licenses of the libraries it links are listed at https://bun.com/docs/project/licensing.",
		"",
		`Packages (${entries.length}):`,
		...entries.map((entry) => `  ${entry.name} ${entry.version}  ${entry.license}`),
		"",
	];
	const printed = new Map<string, string>();
	const texts = (kind: string, items: { file: string; text: string }[], owner: string): void => {
		for (const item of items) {
			const hash = createHash("sha256").update(item.text).digest("hex");
			const earlier = printed.get(hash);
			out.push("", `--- ${kind}: ${item.file}`);
			if (earlier !== undefined) {
				out.push(`(identical to the text printed under ${earlier})`);
				continue;
			}
			printed.set(hash, `${owner}, ${item.file}`);
			out.push("", item.text);
		}
	};
	for (const entry of entries) {
		out.push(RULE, `${entry.name} ${entry.version}`, `License: ${entry.license}`, `Source: ${entry.dir}`);
		if (entry.supplied) out.push("Note: the package ships no license file; the text below is the license of its upstream repository.");
		texts("license", entry.licenses, `${entry.name} ${entry.version}`);
		texts("notice", entry.notices, `${entry.name} ${entry.version}`);
		out.push("");
	}
	return `${out.join("\n")}\n`;
}
