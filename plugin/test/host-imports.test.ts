/**
 * Every module of omp the plugin imports at runtime must be one a compiled omp serves to extensions.
 *
 * A compiled omp has no `node_modules` for an extension to resolve from: it answers an extension's `@oh-my-pi/*` imports from
 * a registry built into the binary by `scripts/legacy-pi-virtual-module.ts` (omp's `packages/coding-agent`). The registry is
 * the exports of seven packages, with different rules for the catch-all `./*` export of each (coding-agent, agent, ai, natives
 * and utils: named exports only; catalog: top-level files; tui: nested). An import outside it works from a checkout, where
 * the specifier resolves to this repository's `node_modules`, and fails in a compiled omp with `Cannot find package`.
 * That is how `job-widgets/text-tap` and `job-widgets/types` shipped: they are in coding-agent's `./*` export and not in
 * its bundled list; `main` and `irc/*` (so `irc/bus`) are not served either, while `async/job-manager`, `registry/*`,
 * `internal-urls/*`, `session/*`, pi-tui's `tools/job-widget` and `@oh-my-pi/pi-utils` are. The rule is about what is served,
 * not how it is imported: a literal dynamic `import()` of a served module gets the same instance as a static import.
 *
 * Two checks. The first derives the served set from the pinned packages' `package.json` exports with omp's own rules and is
 * deterministic. The second, when Tern's compiled omp binaries are on this machine, looks for each import's key (quoted) in
 * every binary from the plugin's minimum omp up, so a module an older release did not bundle is caught too.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import ts from "typescript";
import { isRecord } from "../src/guards";
import { MIN_OMP_VERSION } from "../src/index";

const SRC = resolve(import.meta.dir, "../src");
/** Read as data: `plugin/` never imports `src/`. */
const VM_EXTENSION = resolve(import.meta.dir, "../../src/runner/vm-extension");
const MODULES = resolve(import.meta.dir, "../../node_modules/@oh-my-pi");

/** How much of a package's root `./*` export enters the registry (omp's `RootWildcard`). */
type RootWildcard = "flat" | "nested" | null;

interface BundledPackage {
	/** The package's directory under `node_modules/@oh-my-pi`. */
	readonly dir: string;
	readonly rootWildcard: RootWildcard;
}

/** omp's `BUNDLED_PACKAGES`. The root of ai, coding-agent and tui is a shim there; its key is still the package name. */
const BUNDLED: readonly BundledPackage[] = [
	{ dir: "pi-agent-core", rootWildcard: null },
	{ dir: "pi-ai", rootWildcard: null },
	{ dir: "pi-catalog", rootWildcard: "flat" },
	{ dir: "pi-coding-agent", rootWildcard: null },
	{ dir: "pi-natives", rootWildcard: null },
	{ dir: "pi-tui", rootWildcard: "nested" },
	{ dir: "pi-utils", rootWildcard: null },
];

const UNSAFE_BASENAMES = new Set(["worker-entry"]);
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

function importTarget(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	return isRecord(value) && typeof value.import === "string" ? value.import : undefined;
}

function safeBasename(basename: string): boolean {
	if (!basename || basename.startsWith(".") || basename.startsWith("_") || UNSAFE_BASENAMES.has(basename)) return false;
	return !/\.(test|spec|d|d\.json|generated|bench)$/.test(basename);
}

/** The files under `cwd` that end in `suffix`; none when the directory is not there (omp skips such an export too). */
async function sourceFiles(cwd: string, suffix: string): Promise<string[]> {
	try {
		return await Array.fromAsync(new Bun.Glob(`**/*${suffix}`).scan({ cwd, onlyFiles: true }));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

/** The import keys a compiled omp serves, derived the way `collectBundledPiEntries` derives them. */
async function servedKeys(): Promise<Set<string>> {
	const keys = new Set<string>(["typebox"]);
	for (const pkg of BUNDLED) {
		const root = join(MODULES, pkg.dir);
		const manifest: unknown = await Bun.file(join(root, "package.json")).json();
		if (!isRecord(manifest) || typeof manifest.name !== "string") throw new Error(`no name in ${root}/package.json`);
		const name = manifest.name;
		const exports = isRecord(manifest.exports) ? manifest.exports : {};
		keys.add(name);
		for (const exportKey of Object.keys(exports)) {
			if (!exportKey.startsWith("./") || exportKey.includes("*")) continue;
			keys.add(`${name}/${exportKey.slice(2)}`);
		}
		for (const [exportKey, value] of Object.entries(exports)) {
			if (!exportKey.startsWith("./") || exportKey.indexOf("*") === -1) continue;
			const source = importTarget(value);
			const exportStar = exportKey.indexOf("*");
			const sourceStar = source?.indexOf("*") ?? -1;
			if (!source || sourceStar === -1 || exportKey.indexOf("*", exportStar + 1) !== -1 || source.indexOf("*", sourceStar + 1) !== -1 || !source.startsWith("./")) continue;
			const exportPrefix = exportKey.slice(2, exportStar);
			const exportSuffix = exportKey.slice(exportStar + 1);
			const sourcePrefix = source.slice(2, sourceStar);
			const sourceSuffix = source.slice(sourceStar + 1);
			if (!SOURCE_FILE.test(sourceSuffix)) continue;
			const rootWildcard = exportPrefix === "" || exportPrefix === "/";
			if (rootWildcard && (exportKey !== "./*" || !pkg.rootWildcard)) continue;
			for (const found of await sourceFiles(join(root, sourcePrefix), sourceSuffix)) {
				const match = found.split(sep).join("/");
				if (!match.endsWith(sourceSuffix)) continue;
				if (rootWildcard && pkg.rootWildcard === "flat" && match.includes("/")) continue;
				const basename = match.slice(0, match.length - sourceSuffix.length);
				const segments = basename.split("/");
				if (segments.some(s => s.startsWith(".") || s.startsWith("_"))) continue;
				if (!safeBasename(segments.at(-1) ?? "")) continue;
				keys.add(`${name}/${exportPrefix}${basename}${exportSuffix}`);
			}
		}
	}
	return keys;
}

/** One runtime import of an omp module: where it is and what it names. */
interface HostImport {
	file: string;
	line: number;
	key: string;
}

const isHost = (specifier: string): boolean => specifier.startsWith("@oh-my-pi/");

/** Whether an import or export clause keeps a value at runtime: a default, a namespace, a named value, or nothing named at all. */
function keepsValue(clause: ts.ImportClause | undefined): boolean {
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name) return true;
	const bindings = clause.namedBindings;
	if (!bindings || ts.isNamespaceImport(bindings)) return true;
	return bindings.elements.length === 0 || bindings.elements.some(e => !e.isTypeOnly);
}

/** The runtime `@oh-my-pi/*` imports of one source file: static imports with a value, `export … from`, and `import("…")`. */
function hostImports(file: string, text: string): HostImport[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const found: HostImport[] = [];
	const add = (node: ts.Node, specifier: string): void => {
		if (isHost(specifier)) found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, key: specifier });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && keepsValue(node.importClause)) add(node, node.moduleSpecifier.text);
		else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
			const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
			if (!named || named.length === 0 || named.some(e => !e.isTypeOnly)) add(node, node.moduleSpecifier.text);
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const [arg] = node.arguments;
			if (arg && ts.isStringLiteralLike(arg)) add(node, arg.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/** The runtime omp imports of the plugin and of the extension the runner loads into the VM's omp (`-e`): both run in a compiled omp. */
async function pluginImports(): Promise<HostImport[]> {
	const all: HostImport[] = [];
	const roots = [
		{ dir: SRC, label: "plugin/src" },
		{ dir: VM_EXTENSION, label: "src/runner/vm-extension" },
	];
	for (const { dir, label } of roots) {
		for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: dir, onlyFiles: true })) {
			if (/\.test\.tsx?$/.test(rel)) continue;
			all.push(...hostImports(`${label}/${rel.split(sep).join("/")}`, await Bun.file(join(dir, rel)).text()));
		}
	}
	return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const where = (imports: readonly HostImport[]): string[] => imports.map(i => `${i.file}:${i.line} imports ${i.key}`);

describe("the runtime omp imports of the plugin", () => {
	test("the scanner keeps value imports and drops type-only ones", () => {
		const text = [
			'import type { A } from "@oh-my-pi/pi-tui/a";',
			'import { type B } from "@oh-my-pi/pi-tui/b";',
			'import { type C, d } from "@oh-my-pi/pi-tui/c";',
			'import E from "@oh-my-pi/pi-tui/e";',
			'import * as F from "@oh-my-pi/pi-tui/f";',
			'import type * as G from "@oh-my-pi/pi-tui/g";',
			'import "@oh-my-pi/pi-tui/h";',
			'export { i } from "@oh-my-pi/pi-tui/i";',
			'export type { J } from "@oh-my-pi/pi-tui/j";',
			'export * from "@oh-my-pi/pi-tui/k";',
			'import { l } from "./local";',
			'import { m } from "node:path";',
			'const n = await import("@oh-my-pi/pi-tui");',
			'type O = typeof import("@oh-my-pi/pi-tui/o");',
		].join("\n");
		expect(hostImports("x.ts", text).map(i => i.key)).toEqual(["@oh-my-pi/pi-tui/c", "@oh-my-pi/pi-tui/e", "@oh-my-pi/pi-tui/f", "@oh-my-pi/pi-tui/h", "@oh-my-pi/pi-tui/i", "@oh-my-pi/pi-tui/k", "@oh-my-pi/pi-tui"]);
	});

	test("the served set follows omp's rules", async () => {
		const served = await servedKeys();
		// Roots, named exports, and the wildcard exports that omp expands.
		for (const key of ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-tui", "@oh-my-pi/pi-tui/tools/job-widget", "@oh-my-pi/pi-coding-agent/async/job-manager", "@oh-my-pi/pi-utils"]) {
			expect(served.has(key)).toBe(true);
		}
		// coding-agent's root `./*` is not in the registry.
		expect(served.has("@oh-my-pi/pi-coding-agent/job-widgets/text-tap")).toBe(false);
		expect(served.has("@oh-my-pi/pi-coding-agent/main")).toBe(false);
	});

	test("every one is a module a compiled omp serves", async () => {
		const [served, imports] = await Promise.all([servedKeys(), pluginImports()]);
		expect(imports.length).toBeGreaterThan(0);
		expect(where(imports.filter(i => !served.has(i.key)))).toEqual([]);
	});

	test("every one is in each compiled omp binary on this machine, from the plugin's minimum omp up", async () => {
		const dir = join(homedir(), ".local/share/tern/omp/versions");
		const versions = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, onlyFiles: true })).catch(() => []);
		const min = MIN_OMP_VERSION.split(".").map(Number);
		const newEnough = (version: string): boolean => {
			const parts = version.split(".").map(Number);
			if (parts.length !== 3 || parts.some(Number.isNaN)) return false;
			for (let i = 0; i < 3; i++) if (parts[i] !== min[i]) return (parts[i] ?? 0) > (min[i] ?? 0);
			return true;
		};
		const binaries = versions.filter(newEnough).sort();
		if (binaries.length === 0) return;
		const keys = [...new Set((await pluginImports()).map(i => i.key))].sort();
		const missing: string[] = [];
		for (const version of binaries) {
			const bytes = Buffer.from(await Bun.file(join(dir, version)).arrayBuffer());
			for (const key of keys) {
				// A key a binary bundles is a quoted string in its registry.
				if (bytes.indexOf(`"${key}"`) === -1) missing.push(`omp ${version} does not bundle ${key}`);
			}
		}
		expect(missing).toEqual([]);
	}, 180_000);
});
