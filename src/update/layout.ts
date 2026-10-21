import { chmod, lstat, mkdir, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { compareVersions, isVersion } from "./manifest";

/** The executable of a version inside its directory, and the link's name. */
const BINARY_NAME = "omp-cloud";
/** The current version and this many older ones stay on disk. */
export const KEEP_PREVIOUS = 2;

/** What `manager.json` says: the marker omp's `omp update` also reads. */
export const MANAGER_MARKER = { manager: "omp-cloud", name: "omp-cloud" } as const;

/** `OMP_CLOUD_APP_DIR`, else `~/.local/share/omp-cloud/app`. */
export function defaultAppDir(env: Record<string, string | undefined> = process.env): string {
	const fromEnv = env.OMP_CLOUD_APP_DIR;
	return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(env.HOME ?? homedir(), ".local", "share", "omp-cloud", "app");
}

/** The paths of a managed install, mirroring Tern's omp manager: `versions/<v>/omp-cloud`, `bin/omp-cloud` (a relative symlink), `manager.json`, `state.json`. */
export class AppLayout {
	readonly dir: string;
	readonly versionsDir: string;
	readonly binDir: string;
	/** The symlink the service unit, `~/.local/bin/omp-cloud` and the shell go through. */
	readonly binLink: string;
	readonly managerFile: string;
	readonly stateFile: string;
	readonly lockFile: string;

	constructor(dir: string) {
		this.dir = dir;
		this.versionsDir = join(dir, "versions");
		this.binDir = join(dir, "bin");
		this.binLink = join(this.binDir, BINARY_NAME);
		this.managerFile = join(dir, "manager.json");
		this.stateFile = join(dir, "state.json");
		this.lockFile = join(dir, "state.lock");
	}

	versionDir(version: string): string {
		return join(this.versionsDir, version);
	}

	/** Where version `version`'s executable lives. */
	versionBinary(version: string): string {
		return join(this.versionDir(version), BINARY_NAME);
	}
}

/**
 * The version whose directory holds `execPath` (symlinks resolved), or null when the process does not run from
 * `<app>/versions/<version>/`: a checkout, where updates are unsupported.
 */
export async function managedVersion(layout: AppLayout, execPath: string): Promise<string | null> {
	let real: string;
	let versions: string;
	try {
		[real, versions] = await Promise.all([realpath(execPath), realpath(layout.versionsDir)]);
	} catch {
		return null;
	}
	const inside = relative(versions, real);
	if (inside === "" || inside.startsWith("..") || inside.startsWith(sep)) return null;
	const version = inside.split(sep)[0] ?? "";
	return isVersion(version) ? version : null;
}

/** The version `bin/omp-cloud` points at, or null when there is no link or it is not ours. */
export async function linkedVersion(layout: AppLayout): Promise<string | null> {
	try {
		const target = await readlink(layout.binLink);
		const version = target.split("/").at(-2) ?? "";
		return target === join("..", "versions", version, BINARY_NAME) && isVersion(version) ? version : null;
	} catch {
		return null;
	}
}

/** Creates the directories and `manager.json` of a managed install; an existing marker is left as it is. */
export async function ensureLayout(layout: AppLayout): Promise<void> {
	await mkdir(layout.versionsDir, { recursive: true, mode: 0o755 });
	await mkdir(layout.binDir, { recursive: true, mode: 0o755 });
	try {
		await lstat(layout.managerFile);
	} catch {
		const temp = `${layout.managerFile}.tmp-${process.pid}`;
		await writeFile(temp, `${JSON.stringify(MANAGER_MARKER)}\n`, { mode: 0o644 });
		await rename(temp, layout.managerFile);
	}
}

/** Points `bin/omp-cloud` at `versions/<version>/omp-cloud` atomically: a temporary link renamed over the old one. */
export async function swapLink(layout: AppLayout, version: string): Promise<void> {
	const temp = join(layout.binDir, `.omp-cloud.link-${process.pid}-${Date.now()}`);
	await symlink(join("..", "versions", version, BINARY_NAME), temp);
	try {
		await rename(temp, layout.binLink);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** Places an executable at `versions/<version>/omp-cloud` (0755) by writing beside it and renaming. */
export async function installBinary(layout: AppLayout, version: string, writeTo: (path: string) => Promise<void>): Promise<string> {
	const directory = layout.versionDir(version);
	await mkdir(directory, { recursive: true, mode: 0o755 });
	const temp = join(directory, `.omp-cloud.part-${process.pid}`);
	try {
		await writeTo(temp);
		await chmod(temp, 0o755);
		await rename(temp, layout.versionBinary(version));
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return layout.versionBinary(version);
}

/** The versions on disk, newest first. */
export async function installedVersions(layout: AppLayout): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(layout.versionsDir);
	} catch {
		return [];
	}
	return names.filter(isVersion).sort((a, b) => compareVersions(b, a));
}

/**
 * Removes old versions: `current`, every newer version (a staged one) and every version in `keep` (the one a process
 * runs) stay, as do the `KEEP_PREVIOUS` newest ones older than `current`. Returns the versions removed.
 */
export async function prune(layout: AppLayout, current: string, keep: readonly string[] = []): Promise<string[]> {
	const all = await installedVersions(layout);
	const older = all.filter((version) => compareVersions(version, current) < 0);
	const retained = new Set<string>([current, ...keep, ...older.slice(0, KEEP_PREVIOUS)]);
	const removed: string[] = [];
	for (const version of all) {
		if (retained.has(version) || compareVersions(version, current) > 0) continue;
		await rm(layout.versionDir(version), { recursive: true, force: true });
		removed.push(version);
	}
	return removed;
}
