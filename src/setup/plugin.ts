/**
 * The omp plugin and its configuration, for `omp-cloud setup`, `uninstall`, `doctor` and the updater.
 *
 * Managed install: the binary carries the plugin (`plugin-bundle.ts`); it is extracted to `<app>/marketplace/<version>/`,
 * `<app>/marketplace/current` points at it, and omp gets it as a marketplace of its own (`omp plugin marketplace add
 * <app>/marketplace/current`, then `update` on later runs; `omp plugin install` the first time, `upgrade` after). Checkout
 * mode links `<repo>/plugin` instead. A plugin the user linked is left alone. Every omp call goes through the
 * `CommandRunner`, so tests run against fake commands.
 */
import { lstat, mkdir, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, resolveConfigPath } from "../config";
import { isRecord } from "../guards";
import { type HostOmp, hostOmp } from "../omp-version";
import { AppLayout, defaultAppDir, managedVersion } from "../update/layout";
import { compareVersions } from "../update/manifest";
import { type CommandRunner, lastLine, runCommand } from "../update/system";
import { type Fetch, servedProviders } from "./login";
import { type BundledPlugin, bundledPlugin } from "./plugin-bundle";
import { type LoadVerdict, probeOmp } from "./plugin-probe";
import { Reporter, type StepResult } from "./steps";

/** The marketplace, the plugin's package name and its id inside the marketplace: all three are `omp-cloud`. */
const MARKETPLACE = "omp-cloud";
const PLUGIN_NAME = "omp-cloud";
const PLUGIN_ID = "omp-cloud@omp-cloud";
const OMP_INSTALL = "curl -fsSL https://omp.sh/install | sh";
const RESTART_HINT = "restart running omp sessions (/restart) to load it";
/** A marketplace add or an upgrade may clone or copy; the runner's 60 s default is too short for a slow disk. */
const OMP_TIMEOUT_MS = 120_000;

type Env = Record<string, string | undefined>;

export interface PluginOptions {
	run: CommandRunner;
	/** The omp preflight found (`hostOmp()`); undefined when omp is not installed: the omp steps are skipped. */
	omp: HostOmp | undefined;
	/** `managed`: the plugin comes from the binary's bundle; `checkout`: `<repoRoot>/plugin` is linked. */
	mode: "managed" | "checkout";
	/** `<app>`: the bundle is extracted under `<app>/marketplace/`. */
	appDir: string;
	/** The omp-cloud version of the running binary: the bundle's directory name. */
	version: string;
	/** Checkout mode: the repository whose `plugin/` is linked. */
	repoRoot?: string;
	/** `service.json`: its `listen` is the `url` of `config.yml`. */
	configPath: string;
	/** `service.token`: `config.yml` reads the token from it with `!cat`. */
	tokenFile: string;
	/** `XDG_CONFIG_HOME` and `HOME` come from here. Default the process environment. */
	env?: Env;
	home?: string;
	/** The bundle to extract; default is the one this binary carries, `null` is none. */
	bundle?: BundledPlugin | null;
}

/** What `removePlugin` needs: the omp, the mode and where the bundle lives. */
export type RemoveOptions = Pick<PluginOptions, "run" | "omp" | "mode" | "appDir">;

export interface PluginChecksOptions {
	run: CommandRunner;
	omp: HostOmp | undefined;
	env?: Env;
	home?: string;
	/** The service and its token, to list the providers the cloud runs. Absent: that check is skipped. */
	serviceUrl?: string;
	tokenFile?: string;
	fetch?: Fetch;
	/** Asks the host omp whether it loads the plugin (`plugin-probe.ts`); tests pass a fake. Default starts `omp --mode rpc --no-session`. */
	probe?: (ompPath: string) => Promise<LoadVerdict>;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `omp-cloud`'s own config file for this user, where the plugin reads it: `$XDG_CONFIG_HOME/omp-cloud/config.yml`, else `~/.config/omp-cloud/config.yml`. */
export function personalConfigPath(env: Env, home: string): string {
	const configHome = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(home, ".config");
	return join(configHome, "omp-cloud", "config.yml");
}

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");

/** What `omp plugin list --json` says about this plugin. */
interface PluginState {
	/** Linked (an npm-style plugin of this name): the directory it points at. */
	linked: string | undefined;
	/** Installed from a marketplace: its version. */
	installed: string | undefined;
}

function parsePluginList(stdout: string): PluginState {
	let doc: unknown;
	try {
		doc = JSON.parse(stdout);
	} catch {
		throw new Error("omp plugin list --json printed something that is not JSON");
	}
	if (!isRecord(doc)) throw new Error("omp plugin list --json printed something that is not an object");
	let linked: string | undefined;
	for (const entry of Array.isArray(doc.npm) ? doc.npm : []) {
		if (isRecord(entry) && entry.name === PLUGIN_NAME) linked = typeof entry.path === "string" ? entry.path : "";
	}
	let installed: string | undefined;
	for (const entry of Array.isArray(doc.marketplace) ? doc.marketplace : []) {
		if (!isRecord(entry) || entry.id !== PLUGIN_ID) continue;
		const first = Array.isArray(entry.entries) ? entry.entries[0] : undefined;
		installed = isRecord(first) && typeof first.version === "string" ? first.version : "unknown";
	}
	return { linked, installed };
}

/** The marketplaces in `omp plugin marketplace list`: `  <name>  <source>` lines under a heading. */
function parseMarketplaces(stdout: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const line of stdout.replace(ANSI, "").split("\n")) {
		const match = /^ {2}(\S+)\s+(.+?)\s*$/.exec(line);
		if (match?.[1] !== undefined && match[2] !== undefined) found.set(match[1], match[2]);
	}
	return found;
}

/** `omp plugin …` over the runner; a failure carries omp's own last line. */
class OmpPlugin {
	readonly #run: CommandRunner;
	readonly #path: string;

	constructor(run: CommandRunner, omp: HostOmp) {
		this.#run = run;
		this.#path = omp.path;
	}

	/** stdout of `omp plugin <args>`; throws when it exits non-zero. */
	async run(args: readonly string[]): Promise<string> {
		const result = await this.#run([this.#path, "plugin", ...args], { timeoutMs: OMP_TIMEOUT_MS });
		if (result.code !== 0) {
			const reason = lastLine(result.stderr.replace(ANSI, "")) || lastLine(result.stdout.replace(ANSI, "")) || `exit ${result.code}`;
			throw new Error(`omp plugin ${args.join(" ")} failed: ${reason}`);
		}
		return result.stdout;
	}

	async state(): Promise<PluginState> {
		return parsePluginList(await this.run(["list", "--json"]));
	}

	async marketplaces(): Promise<Map<string, string>> {
		return parseMarketplaces(await this.run(["marketplace", "list"]));
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Points the symlink `link` at `target` (relative) atomically; false when it already did. Returns the previous target too. */
async function pointLink(link: string, target: string): Promise<{ changed: boolean; previous: string | undefined }> {
	let previous: string | undefined;
	try {
		previous = await readlink(link);
	} catch {
		// No link yet.
	}
	if (previous === target) return { changed: false, previous };
	const next = `${link}.new`;
	await rm(next, { recursive: true, force: true });
	await symlink(target, next);
	await rename(next, link);
	return { changed: true, previous };
}

/**
 * Extracts the bundle to `<app>/marketplace/<version>/` (beside it and renamed, so a directory that exists is a whole
 * one), points `current` at it and removes older directories but the one `current` pointed at before.
 */
async function ensureBundle(opts: PluginOptions): Promise<StepResult> {
	const bundle = opts.bundle === undefined ? bundledPlugin : opts.bundle;
	const root = join(opts.appDir, "marketplace");
	const dest = join(root, opts.version);
	let extracted = false;
	if (!(await isDirectory(dest))) {
		if (bundle === null) throw new Error("this omp-cloud carries no plugin bundle; run omp-cloud setup from a release binary");
		const partial = `${dest}.partial`;
		await rm(partial, { recursive: true, force: true });
		await mkdir(root, { recursive: true });
		// Bun.Archive reads nothing from a lazy `Bun.file` blob: hand it the bytes.
		await new Bun.Archive(await Bun.file(bundle.tar).bytes()).extract(partial);
		if (!(await Bun.file(join(partial, ".omp-plugin", "marketplace.json")).exists())) throw new Error("the plugin bundle has no .omp-plugin/marketplace.json");
		await rename(partial, dest);
		extracted = true;
	}
	const { changed, previous } = await pointLink(join(root, "current"), opts.version);
	const keep = new Set(["current", opts.version, ...(previous === undefined ? [] : [previous])]);
	for (const entry of await readdir(root)) {
		if (!keep.has(entry)) await rm(join(root, entry), { recursive: true, force: true });
	}
	if (extracted) return { id: "plugin.bundle", status: "changed", detail: `extracted the plugin ${opts.version} to ${dest}` };
	if (changed) return { id: "plugin.bundle", status: "changed", detail: `marketplace/current now points at ${opts.version}` };
	return { id: "plugin.bundle", status: "ok", detail: `the plugin ${opts.version} is extracted at ${dest}` };
}

/** A failed omp step: its message and the command that retries it. */
function failed(id: string, error: unknown, fix: string): StepResult {
	return { id, status: "failed", detail: describe(error), fix };
}

/** The omp part of a managed install: bundle, marketplace, install or upgrade. */
async function ensureManaged(opts: PluginOptions, omp: OmpPlugin, before: PluginState): Promise<StepResult[]> {
	const steps: StepResult[] = [];
	if (before.linked !== undefined) {
		return [{ id: "plugin.install", status: "skipped", detail: `omp-cloud is linked from ${before.linked || "a directory"}; left alone, so omp-cloud updates do not move it` }];
	}
	try {
		steps.push(await ensureBundle(opts));
	} catch (error) {
		return [failed("plugin.bundle", error, "omp-cloud setup")];
	}
	const current = join(opts.appDir, "marketplace", "current");

	try {
		const known = await omp.marketplaces();
		const source = known.get(MARKETPLACE);
		if (source === undefined) {
			await omp.run(["marketplace", "add", current]);
			steps.push({ id: "plugin.marketplace", status: "changed", detail: `added the ${MARKETPLACE} marketplace from ${current}` });
		} else {
			await omp.run(["marketplace", "update", MARKETPLACE]);
			steps.push({ id: "plugin.marketplace", status: "ok", detail: `refreshed the ${MARKETPLACE} marketplace${source === current ? "" : ` (from ${source}, not this binary's bundle)`}` });
		}
	} catch (error) {
		return [...steps, failed("plugin.marketplace", error, `omp plugin marketplace add ${current}`)];
	}

	try {
		const fresh = before.installed === undefined;
		await omp.run(fresh ? ["install", PLUGIN_ID] : ["upgrade", PLUGIN_ID]);
		const after = (await omp.state()).installed ?? "unknown";
		if (fresh) steps.push({ id: "plugin.install", status: "changed", detail: `installed ${PLUGIN_ID} ${after}; ${RESTART_HINT}` });
		else if (after !== before.installed) steps.push({ id: "plugin.install", status: "changed", detail: `upgraded ${PLUGIN_ID} ${before.installed} -> ${after}; ${RESTART_HINT}` });
		else steps.push({ id: "plugin.install", status: "ok", detail: `${PLUGIN_ID} ${after} is up to date` });
	} catch (error) {
		steps.push(failed("plugin.install", error, `omp plugin install ${PLUGIN_ID}`));
	}
	return steps;
}

/** The omp part of a checkout: `<repo>/plugin` linked. */
async function ensureLinked(opts: PluginOptions, omp: OmpPlugin, before: PluginState): Promise<StepResult[]> {
	if (opts.repoRoot === undefined) throw new Error("checkout mode needs repoRoot");
	const plugin = join(opts.repoRoot, "plugin");
	if (before.linked !== undefined) {
		return [{ id: "plugin.link", status: "ok", detail: `omp-cloud is linked${before.linked === plugin ? "" : ` from ${before.linked || "another directory"}`}` }];
	}
	if (before.installed !== undefined) {
		return [{ id: "plugin.link", status: "skipped", detail: `${PLUGIN_ID} is installed from a marketplace; run omp plugin uninstall ${PLUGIN_ID}, then setup again to link this checkout` }];
	}
	try {
		await omp.run(["link", plugin]);
		return [{ id: "plugin.link", status: "changed", detail: `linked ${plugin}; ${RESTART_HINT}` }];
	} catch (error) {
		return [failed("plugin.link", error, `omp plugin link ${plugin}`)];
	}
}

/** Quotes `path` for the shell that runs a `!command` value. */
function shellWord(path: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** `config.yml`, written once: `url` from `service.json`'s `listen`, the token read by `!cat <service.token>`. Never overwritten, never shows the token. */
async function ensureConfigFile(opts: PluginOptions): Promise<StepResult> {
	const file = personalConfigPath(opts.env ?? process.env, opts.home ?? homedir());
	if (await Bun.file(file).exists()) return { id: "plugin.config", status: "ok", detail: `${file} exists; not touched` };
	if (!(await Bun.file(opts.tokenFile).exists())) {
		return { id: "plugin.config", status: "skipped", detail: `no ${opts.tokenFile} to read the token from; put url and token in ${file}, or set OMP_CLOUD_URL and OMP_CLOUD_TOKEN` };
	}
	let url: string;
	try {
		const { listen } = await loadConfig(opts.configPath);
		url = `http://${listen.hostname.includes(":") ? `[${listen.hostname}]` : listen.hostname}:${listen.port}`;
	} catch (error) {
		return failed("plugin.config", error, "omp-cloud setup");
	}
	const text = [
		"# omp-cloud's settings for this machine, read by the omp plugin; written once by omp-cloud setup. It never ships to a VM.",
		`url: ${JSON.stringify(url)}`,
		`token: ${JSON.stringify(`!cat ${shellWord(opts.tokenFile)}`)}`,
		"",
	].join("\n");
	try {
		await mkdir(dirname(file), { recursive: true, mode: 0o700 });
		await writeFile(file, text, { mode: 0o600, flag: "wx" });
	} catch (error) {
		// Another process wrote it first: it stays.
		if (error instanceof Error && Reflect.get(error, "code") === "EEXIST") return { id: "plugin.config", status: "ok", detail: `${file} exists; not touched` };
		return failed("plugin.config", error, `create ${file} with url and token`);
	}
	return { id: "plugin.config", status: "changed", detail: `wrote ${file} (url ${url}; the token is read from ${opts.tokenFile})` };
}

/**
 * Puts the plugin in omp and writes `config.yml` when it is absent. Managed: extract the bundle, add or refresh the
 * marketplace, install or upgrade the plugin. Checkout: link `<repo>/plugin`. A linked plugin is left alone. Without
 * omp the omp steps are skipped (setup's preflight installs it) and the config is still written.
 */
export async function ensurePlugin(opts: PluginOptions): Promise<StepResult[]> {
	let steps: StepResult[];
	if (opts.omp === undefined) {
		steps = [{ id: "plugin.install", status: "skipped", detail: `omp is not installed; install it (${OMP_INSTALL}) and run omp-cloud setup again` }];
	} else {
		const omp = new OmpPlugin(opts.run, opts.omp);
		let before: PluginState;
		try {
			before = await omp.state();
		} catch (error) {
			return [failed("plugin.install", error, "omp plugin doctor --fix")];
		}
		steps = opts.mode === "checkout" ? await ensureLinked(opts, omp, before) : await ensureManaged(opts, omp, before);
	}
	return [...steps, await ensureConfigFile(opts)];
}

/**
 * Takes setup's plugin out of omp for `omp-cloud uninstall`: the marketplace install and the marketplace, when it is
 * ours (a marketplace someone added from elsewhere stays), then the extracted bundle. A linked plugin is unlinked in a
 * checkout and left alone in a managed install. `config.yml` stays.
 */
export async function removePlugin(opts: RemoveOptions): Promise<StepResult[]> {
	const steps: StepResult[] = [];
	const current = join(opts.appDir, "marketplace", "current");
	if (opts.omp === undefined) {
		steps.push({ id: "plugin.uninstall", status: "skipped", detail: "omp is not installed; nothing to remove from it" });
	} else {
		const omp = new OmpPlugin(opts.run, opts.omp);
		try {
			const state = await omp.state();
			if (state.installed !== undefined) {
				await omp.run(["uninstall", PLUGIN_ID]);
				steps.push({ id: "plugin.uninstall", status: "changed", detail: `uninstalled ${PLUGIN_ID}` });
			} else if (state.linked !== undefined && opts.mode === "checkout") {
				await omp.run(["uninstall", PLUGIN_NAME]);
				steps.push({ id: "plugin.uninstall", status: "changed", detail: "unlinked omp-cloud" });
			} else if (state.linked !== undefined) {
				steps.push({ id: "plugin.uninstall", status: "skipped", detail: `omp-cloud is linked from ${state.linked || "a directory"}; left alone` });
			} else {
				steps.push({ id: "plugin.uninstall", status: "ok", detail: `${PLUGIN_ID} is not installed` });
			}
			const source = (await omp.marketplaces()).get(MARKETPLACE);
			if (source === current) {
				await omp.run(["marketplace", "remove", MARKETPLACE]);
				steps.push({ id: "plugin.marketplace", status: "changed", detail: `removed the ${MARKETPLACE} marketplace` });
			} else if (source === undefined) {
				steps.push({ id: "plugin.marketplace", status: "ok", detail: `no ${MARKETPLACE} marketplace` });
			} else {
				steps.push({ id: "plugin.marketplace", status: "skipped", detail: `the ${MARKETPLACE} marketplace comes from ${source}, not from setup; left alone` });
			}
		} catch (error) {
			steps.push(failed("plugin.uninstall", error, `omp plugin uninstall ${PLUGIN_ID}`));
		}
	}
	if (opts.mode === "managed") {
		const root = join(opts.appDir, "marketplace");
		if (await isDirectory(root)) {
			await rm(root, { recursive: true, force: true });
			steps.push({ id: "plugin.bundle", status: "changed", detail: `removed ${root}` });
		}
	}
	return steps;
}

/** The version of a linked plugin, from its `package.json`; "unknown" when it cannot be read. */
async function linkedVersion(dir: string): Promise<string> {
	try {
		const pkg: unknown = await Bun.file(join(dir, "package.json")).json();
		return isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

/** The oldest omp that can load the plugin (`AGENTS.md`: the plugin needs omp 18.12.3 or newer). */
const PLUGIN_MIN_OMP = "18.12.3";

/** `plugin.loads`: the host omp, started in RPC mode, lists the real `/cloud` (`plugin-probe.ts`). */
async function loadStep(omp: HostOmp, version: string, probe: (ompPath: string) => Promise<LoadVerdict>): Promise<StepResult> {
	const verdict = await probe(omp.path);
	if (verdict.state === "loads") return { id: "plugin.loads", status: "ok", detail: `omp loads omp-cloud ${version} (/cloud is registered)` };
	if (verdict.state === "unknown") return { id: "plugin.loads", status: "skipped", detail: `could not check that omp loads the plugin: ${verdict.reason}` };
	return {
		id: "plugin.loads",
		status: "failed",
		detail: `omp does not load omp-cloud ${version}: ${verdict.reason}`,
		fix:
			compareVersions(omp.version, PLUGIN_MIN_OMP) < 0
				? "update omp (omp update), then rerun omp-cloud setup"
				: "update omp-cloud (omp-cloud update), then rerun omp-cloud setup; if it still fails, report this error",
	};
}

/** The doctor's read-only checks: omp and its version, the plugin (version, linked or marketplace) and that omp loads it, `config.yml`, the providers the cloud runs. */
export async function pluginChecks(opts: PluginChecksOptions): Promise<StepResult[]> {
	const steps: StepResult[] = [];
	if (opts.omp === undefined) {
		steps.push({ id: "plugin.omp", status: "failed", detail: "omp is not installed", fix: OMP_INSTALL });
		steps.push({ id: "plugin.loads", status: "skipped", detail: "omp is not installed, so the plugin cannot be checked" });
	} else {
		steps.push({ id: "plugin.omp", status: "ok", detail: `omp ${opts.omp.version} at ${opts.omp.path}` });
		let version: string | undefined;
		try {
			const state = await new OmpPlugin(opts.run, opts.omp).state();
			if (state.linked !== undefined) {
				version = state.linked === "" ? "unknown" : await linkedVersion(state.linked);
				steps.push({ id: "plugin.installed", status: "ok", detail: `omp-cloud is linked from ${state.linked || "a directory"}` });
			} else if (state.installed !== undefined) {
				version = state.installed;
				steps.push({ id: "plugin.installed", status: "ok", detail: `${PLUGIN_ID} ${state.installed} (marketplace)` });
			} else {
				steps.push({ id: "plugin.installed", status: "failed", detail: "the omp-cloud plugin is not installed", fix: "omp-cloud setup" });
			}
		} catch (error) {
			steps.push(failed("plugin.installed", error, "omp plugin doctor --fix"));
		}
		if (version !== undefined) steps.push(await loadStep(opts.omp, version, opts.probe ?? ((ompPath) => probeOmp(ompPath, { env: { ...process.env, ...opts.env } }))));
	}

	const file = personalConfigPath(opts.env ?? process.env, opts.home ?? homedir());
	steps.push(
		(await Bun.file(file).exists())
			? { id: "plugin.config", status: "ok", detail: `${file} is present` }
			: { id: "plugin.config", status: "failed", detail: `${file} is missing`, fix: "omp-cloud setup" },
	);

	if (opts.serviceUrl !== undefined && opts.tokenFile !== undefined) {
		try {
			const served = await servedProviders({ serviceUrl: opts.serviceUrl, tokenFile: opts.tokenFile, fetch: opts.fetch });
			steps.push(
				served.length > 0
					? { id: "plugin.providers", status: "ok", detail: `the cloud can run ${served.join(", ")}` }
					: { id: "plugin.providers", status: "skipped", detail: "no model provider yet; log in: omp-cloud login <provider>" },
			);
		} catch (error) {
			steps.push({ id: "plugin.providers", status: "skipped", detail: `could not ask the service which providers it runs: ${describe(error)}` });
		}
	}
	return steps;
}

/**
 * Runs `<binary> setup plugin`, the new version's own refresh, as the updater does after a successful apply. Resolves
 * with the last line it printed; rejects with the first failed step's line.
 */
export async function refreshPluginFrom(binary: string, run: CommandRunner = runCommand): Promise<string> {
	const result = await run([binary, "setup", "plugin"], { timeoutMs: 180_000 });
	if (result.code !== 0) {
		const failure = result.stderr.split("\n").find((line) => line.startsWith("✗"));
		throw new Error(failure ?? (lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`));
	}
	return lastLine(result.stdout);
}

/**
 * `omp-cloud setup plugin` (internal, no flags): puts this binary's plugin in omp the way setup does, for the updater.
 * Returns the exit code (0 ok, 1 failed, 2 usage).
 */
export async function pluginMain(argv: readonly string[]): Promise<number> {
	if (argv.length > 0) {
		process.stderr.write("usage: omp-cloud setup plugin\n");
		return 2;
	}
	const appDir = defaultAppDir();
	const version = await managedVersion(new AppLayout(appDir), process.execPath);
	if (version === null) {
		process.stderr.write("✗ plugin  omp-cloud setup plugin runs from a managed install (<app>/versions/<version>/)\n");
		return 1;
	}
	let omp: HostOmp | undefined;
	try {
		omp = await hostOmp();
	} catch {
		omp = undefined;
	}
	const configPath = resolveConfigPath(undefined);
	const reporter = Reporter.forProcess(false);
	reporter.reportAll(await ensurePlugin({ run: runCommand, omp, mode: "managed", appDir, version, configPath, tokenFile: join(dirname(configPath), "service.token") }));
	return reporter.failed ? 1 : 0;
}
