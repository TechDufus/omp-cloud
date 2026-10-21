import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { discoverExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getEnabledPlugins, resolvePluginExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { cfgDisabledExtensions, cfgExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { expandTilde } from "./overlays";

export interface ExtensionOptions {
	/** The session's settings: their `extensions` and `disabledExtensions` decide what omp loads. */
	settings: Settings;
	cwd: string;
	agentDir: string;
	/** The repository root; extensions under its `.omp/` travel with the repository bundle. */
	repoRoot: string;
	/** This extension's own directory; never shipped. */
	ownRoot: string;
	/** `excludeExtensions` of the omp-cloud config: names of shipped extensions that stay on this machine. */
	exclude: readonly string[];
}

export interface ShippedExtension {
	/** An absolute file or directory on this machine. */
	source: string;
	/** Where it goes in the setup archive: `extensions/<name>`. */
	dest: string;
}

export interface ExtensionPlan {
	ship: ShippedExtension[];
	warnings: string[];
}

/** Whether `path` is `dir` or lies below it. */
function within(dir: string, path: string): boolean {
	const rel = relative(dir, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The extensions omp loads in this session (its own discovery: `<agent dir>/extensions`, `.omp` and `.pi`
 * extension directories, hook factories, installed plugins, and the `extensions` setting minus
 * `disabledExtensions`), as the setup archive should carry them.
 *
 * - An entry of `<agent dir>/extensions` ships whole under its name.
 * - Anything else ships under `extensions/<basename>`: the configured file or directory that holds it, or
 *   else its directory when it is an `index` file, or else the file.
 * - Skipped: this extension, `excludeExtensions`, anything under a `.omp` directory of the repository
 *   (it travels with the bundle) and plugin-installed extensions, which need a plugin install in the VM.
 *   Each enabled plugin that is not shipped gets a warning.
 */
export async function planExtensions(opts: ExtensionOptions): Promise<ExtensionPlan> {
	const configured = [...cfgExtensions.get(opts.settings)];
	const [discovered, plugins, own] = await Promise.all([
		discoverExtensionPaths(configured, opts.cwd, [...cfgDisabledExtensions.get(opts.settings)]),
		getEnabledPlugins(opts.cwd),
		realpath(opts.ownRoot).catch(() => opts.ownRoot),
	]);
	const pluginPaths = new Set(plugins.flatMap(p => resolvePluginExtensionPaths(p)).map(p => resolve(p)));
	const configuredRoots = configured.map(p => resolve(opts.cwd, expandTilde(p)));
	const extDir = join(opts.agentDir, "extensions");
	const repoRoot = resolve(opts.repoRoot);

	const ship = new Map<string, string>();
	const warnings: string[] = [];
	for (const found of discovered) {
		const path = resolve(found);
		if (pluginPaths.has(path)) continue;
		if (within(own, await realpath(path).catch(() => path))) continue;

		let source: string;
		if (within(extDir, path)) {
			source = join(extDir, relative(extDir, path).split(sep)[0] ?? "");
		} else if (within(repoRoot, path) && !within(opts.agentDir, path) && relative(repoRoot, path).split(sep).includes(".omp")) {
			continue;
		} else {
			source = configuredRoots.find(root => within(root, path)) ?? (/^index\.[cm]?[jt]s$/.test(basename(path)) ? dirname(path) : path);
		}
		const name = basename(source);
		if (opts.exclude.includes(name)) continue;
		const taken = ship.get(name);
		if (taken === undefined) ship.set(name, source);
		else if (taken !== source) warnings.push(`extension ${source} is not shipped: ${name} is already taken by ${taken}`);
	}

	for (const plugin of plugins) {
		if (within(own, await realpath(plugin.path).catch(() => plugin.path))) continue;
		warnings.push(`plugin ${plugin.name} is enabled here but not shipped; the cloud agent runs without it`);
	}
	return { ship: [...ship].map(([name, source]) => ({ source, dest: `extensions/${name}` })), warnings };
}
