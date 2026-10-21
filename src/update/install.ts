/**
 * `omp-cloud install [--from <binary>] [--config <path>]`: turns the current install into a managed one (`<app>/versions/<v>/omp-cloud`,
 * `bin/omp-cloud`, `manager.json`), links `~/.local/bin/omp-cloud` to it and points the service unit at
 * `<app>/bin/omp-cloud serve --config <path>`. Prints what it changed; running it again changes nothing.
 */
import { copyFile, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig, resolveConfigPath } from "../config";
import { readUpdateSettings } from "./db";
import { AppLayout, defaultAppDir, ensureLayout, installBinary, linkedVersion, swapLink } from "./layout";
import { isVersion } from "./manifest";
import { printsVersion, sha256File } from "./stage";
import { StateStore } from "./state";
import { type CommandResult, type CommandRunner, runCommand, Units } from "./system";

export interface InstallInput {
	/** The binary to install: a compiled omp-cloud release. */
	from: string;
	configPath: string;
	/** `update.unit` */
	unit: string;
	layout: AppLayout;
	/** Where `omp-cloud` is linked for the shell (`~/.local/bin`). */
	binDir: string;
	/** Where the user's unit files and drop-ins live (`~/.config/systemd/user`). */
	unitDir: string;
}

/** Whether `target` exists with exactly the bytes of `source`. */
async function sameFile(source: string, target: string): Promise<boolean> {
	try {
		return (await sha256File(source)) === (await sha256File(target));
	} catch {
		return false;
	}
}

/** The text of the drop-in that makes a persistent unit start the managed binary. */
export function managedDropIn(layout: AppLayout, configPath: string): string {
	return `[Service]\nWorkingDirectory=${layout.dir}\nExecStart=\nExecStart="${layout.binLink}" serve --config ${configPath}\n`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Replaces `path` with a symlink to `target` (a temporary link renamed over it). Returns false when it already pointed there. */
async function relink(path: string, target: string): Promise<boolean> {
	try {
		if ((await readlink(path)) === target) return false;
	} catch {
		// Not a symlink, or absent: it gets replaced.
	}
	await mkdir(dirname(path), { recursive: true });
	const temp = join(dirname(path), `.${basename(path)}.link-${process.pid}`);
	await rm(temp, { force: true });
	await symlink(target, temp);
	await rename(temp, path);
	return true;
}

/** What installing the managed binary needs: no service config, no unit. */
export interface InstallFilesInput {
	/** The binary to install: a compiled omp-cloud release. */
	from: string;
	layout: AppLayout;
	/** Where `omp-cloud` is linked for the shell (`~/.local/bin`). */
	binDir: string;
}

/** The binary to install is not an omp-cloud release (it prints no version, or cannot be started). */
export class ProbeError extends Error {}

/**
 * Installs `input.from` as the managed omp-cloud (`versions/<v>/`, `bin/omp-cloud`, `state.json`, the shell link) and nothing
 * else, so it works before `service.json` exists. Returns what it changed, one line each.
 * Throws a `ProbeError` when the binary does not print `omp-cloud <version>`, another Error when a file operation fails.
 */
export async function installManagedFiles(input: InstallFilesInput, run: CommandRunner): Promise<string[]> {
	const { layout } = input;
	const changes: string[] = [];

	let probe: CommandResult;
	try {
		probe = await run([input.from, "version"], { timeoutMs: 30_000 });
	} catch (error) {
		throw new ProbeError(`${input.from} could not be started for its version command: ${error instanceof Error ? error.message : String(error)}`);
	}
	const version = /^omp-cloud (\S+)/.exec(probe.stdout.trim())?.[1] ?? "";
	if (probe.code !== 0 || !isVersion(version) || !printsVersion(probe.stdout, version)) {
		throw new ProbeError(`${input.from} does not print "omp-cloud <version>" for its version command: install from a release binary (or pass --from <binary>)`);
	}

	const fresh = !(await exists(layout.managerFile));
	await ensureLayout(layout);
	if (fresh) changes.push(`wrote ${layout.managerFile}`);
	const target = layout.versionBinary(version);
	if (resolve(input.from) !== target && !(await sameFile(input.from, target))) {
		await installBinary(layout, version, (temp) => copyFile(input.from, temp));
		changes.push(`installed ${target}`);
	}
	if ((await linkedVersion(layout)) !== version) {
		await swapLink(layout, version);
		changes.push(`pointed ${layout.binLink} at ${version}`);
	}
	await new StateStore(layout.stateFile, layout.lockFile).update((state) => {
		state.installed = version;
	});

	if (await relink(join(input.binDir, "omp-cloud"), layout.binLink)) changes.push(`linked ${join(input.binDir, "omp-cloud")} to ${layout.binLink}`);
	return changes;
}

/**
 * Installs `input.from` as the managed omp-cloud and points the service at it. Returns what it changed, one line each.
 * Throws an Error when the binary does not print `omp-cloud <version>` or a command fails.
 */
export async function installManaged(input: InstallInput, run: CommandRunner): Promise<string[]> {
	const changes = await installManagedFiles(input, run);
	changes.push(...(await pointUnit(input, new Units(run))));
	return changes;
}

/** Points the service unit at the managed binary, restarting it when it runs. */
async function pointUnit(input: InstallInput, units: Units): Promise<string[]> {
	const { layout, unit, configPath } = input;
	let fragment: string;
	try {
		fragment = await units.property(unit, "FragmentPath");
	} catch {
		return [`the unit ${unit} is not loaded: start the service with ${layout.binLink} serve --config ${configPath}`];
	}
	const active = await units.isActive(unit);
	if (fragment === "" && !active) return [`the unit ${unit} is not loaded: start the service with ${layout.binLink} serve --config ${configPath}`];
	// A transient unit has an empty `FragmentPath`, or one under `/transient/`; a persistent unit's fragment is its file.
	if (fragment === "" || fragment.includes("/transient/")) {
		if (!active) return [`the transient unit ${unit} is not running: start the service with ${layout.binLink} serve --config ${configPath}`];
		const environment = await units.environment(unit);
		await units.stop(unit);
		await units.runTransient(unit, [layout.binLink, "serve", "--config", configPath], {
			collect: false,
			properties: ["Description=omp-cloud service"],
			env: { ...environment, OMP_CLOUD_APP_DIR: layout.dir },
		});
		return [`restarted the transient unit ${unit} on ${layout.binLink} serve --config ${configPath}`];
	}
	const dropIn = join(input.unitDir, `${unit}.service.d`, "managed.conf");
	const wanted = managedDropIn(layout, configPath);
	let current = "";
	try {
		current = await readFile(dropIn, "utf8");
	} catch {
		// No drop-in yet.
	}
	if (current === wanted) return [`the unit ${unit} already starts ${layout.binLink}`];
	await mkdir(dirname(dropIn), { recursive: true });
	const temp = `${dropIn}.tmp-${process.pid}`;
	await writeFile(temp, wanted, { mode: 0o644 });
	await rename(temp, dropIn);
	await units.daemonReload();
	const changes = [`wrote ${dropIn} (the unit ${unit} now starts ${layout.binLink})`];
	if (active) {
		await units.restart(unit);
		changes.push(`restarted ${unit}`);
	}
	return changes;
}

interface InstallArgs {
	from: string | null;
	config: string | undefined;
}

function parseArgs(args: readonly string[]): InstallArgs {
	const parsed: InstallArgs = { from: null, config: undefined };
	for (let i = 0; i < args.length; i += 2) {
		const flag = args[i];
		const value = args[i + 1];
		if (value === undefined || value === "") throw new Error(`${flag ?? "an argument"} needs a value`);
		if (flag === "--from") parsed.from = value;
		else if (flag === "--config") parsed.config = value;
		else throw new Error(`unknown argument ${JSON.stringify(flag)}`);
	}
	return parsed;
}

/** `omp-cloud install …`; `args` follow the word `install`. Returns the exit code. */
export async function installMain(args: readonly string[]): Promise<number> {
	try {
		const parsed = parseArgs(args);
		const from = parsed.from ?? process.execPath;
		if (parsed.from === null && /^bun(-|$)/.test(basename(process.execPath))) {
			throw new Error("run omp-cloud install from a release binary, or pass --from <binary>");
		}
		const configPath = resolveConfigPath(parsed.config);
		const config = await loadConfig(configPath);
		const home = process.env.HOME ?? homedir();
		const changes = await installManaged(
			{
				from: resolve(from),
				configPath,
				unit: readUpdateSettings(config.dataDir).unit,
				layout: new AppLayout(defaultAppDir()),
				binDir: join(home, ".local", "bin"),
				unitDir: join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user"),
			},
			runCommand,
		);
		for (const change of changes) console.log(change);
		return 0;
	} catch (error) {
		console.error(`omp-cloud: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
