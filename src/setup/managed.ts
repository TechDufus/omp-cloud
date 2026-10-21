/** The managed binary and the `~/.local/bin/omp-cloud` name, for `omp-cloud setup` and `uninstall`. */
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { AppLayout, linkedVersion } from "../update/layout";
import { installManagedFiles, ProbeError } from "../update/install";
import type { CommandRunner } from "../update/system";
import type { SetupPaths } from "./config";
import type { StepResult } from "./steps";

/** Copies the running (or given) release binary into `<app>` and links it, before `service.json` exists. `version` is "" when it failed. */
export async function installManagedBinary(paths: SetupPaths, from: string, run: CommandRunner): Promise<{ steps: StepResult[]; version: string }> {
	const layout = new AppLayout(paths.appDir);
	try {
		const changes = await installManagedFiles({ from, layout, binDir: paths.binDir }, run);
		const version = (await linkedVersion(layout)) ?? "";
		const detail = changes.length > 0 ? `installed omp-cloud ${version} in ${paths.appDir}` : `omp-cloud ${version} is installed in ${paths.appDir}`;
		return { steps: [{ id: "managed.binary", status: changes.length > 0 ? "changed" : "ok", detail }], version };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const fix = error instanceof ProbeError ? "run omp-cloud setup from a release binary" : `make ${paths.appDir} and ${paths.binDir} writable, then rerun omp-cloud setup`;
		return { steps: [{ id: "managed.binary", status: "failed", detail, fix }], version: "" };
	}
}

/** `value` in single quotes for a POSIX shell. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The checkout's `~/.local/bin/omp-cloud`: a script that runs `src/cli.ts` with the units' PATH and the absolute bun and repository. */
function wrapperScript(input: { bunBin: string; repoRoot: string; unitPath: string }): string {
	return `#!/bin/sh\nPATH=${shellQuote(input.unitPath)}\nexport PATH\nexec ${shellQuote(input.bunBin)} ${shellQuote(join(input.repoRoot, "src", "cli.ts"))} "$@"\n`;
}

/**
 * Writes the checkout wrapper atomically (a connect in flight never sees half a script), 0755, only when it differs.
 * An existing symlink (a managed install's link) is replaced.
 */
export async function installCheckoutWrapper(paths: SetupPaths, input: { bunBin: string; repoRoot: string; unitPath: string }): Promise<StepResult> {
	const target = join(paths.binDir, "omp-cloud");
	const wanted = wrapperScript(input);
	try {
		const current = await lstat(target).catch(() => null);
		if (current !== null && current.isFile() && (current.mode & 0o777) === 0o755 && (await readFile(target, "utf8")) === wanted) {
			return { id: "managed.wrapper", status: "ok", detail: `${target} runs ${join(input.repoRoot, "src", "cli.ts")}` };
		}
		await mkdir(paths.binDir, { recursive: true, mode: 0o755 });
		const temp = join(paths.binDir, `.omp-cloud.wrapper-${process.pid}`);
		await writeFile(temp, wanted);
		await chmod(temp, 0o755);
		await rename(temp, target);
		return { id: "managed.wrapper", status: "changed", detail: `wrote ${target}, which runs ${join(input.repoRoot, "src", "cli.ts")}` };
	} catch (error) {
		return { id: "managed.wrapper", status: "failed", detail: error instanceof Error ? error.message : String(error), fix: `make ${paths.binDir} writable, then rerun omp-cloud setup --checkout` };
	}
}

/** Our wrapper script, whatever bun, PATH and repository it names. */
const WRAPPER_SHAPE = /^#!\/bin\/sh\nPATH='[^\n]*'\nexport PATH\nexec '[^\n]*' '[^\n]*\/src\/cli\.ts' "\$@"\n$/;

/** Uninstall: removes `~/.local/bin/omp-cloud` when it is our link into the app directory or our wrapper; any other file stays. */
export async function removeBinaryLink(paths: SetupPaths): Promise<StepResult> {
	const target = join(paths.binDir, "omp-cloud");
	const stat = await lstat(target).catch(() => null);
	if (stat === null) return { id: "managed.link", status: "ok", detail: `${target} does not exist` };
	let ours = false;
	let kind = "file";
	if (stat.isSymbolicLink()) {
		kind = "link";
		const destination = resolve(dirname(target), await readlink(target));
		ours = destination.startsWith(`${resolve(paths.appDir)}${sep}`);
	} else if (stat.isFile()) {
		ours = WRAPPER_SHAPE.test(await readFile(target, "utf8"));
	}
	if (!ours) return { id: "managed.link", status: "skipped", detail: `left ${target}: that ${kind} is not omp-cloud's` };
	await rm(target);
	return { id: "managed.link", status: "changed", detail: `removed ${target}` };
}

/** Uninstall --purge: removes the managed install. Refuses a directory that is, or holds, the home directory. */
export async function removeAppDir(paths: SetupPaths): Promise<StepResult> {
	const appDir = resolve(paths.appDir);
	const home = resolve(paths.home);
	if (appDir === sep || appDir === home || home.startsWith(`${appDir}${sep}`)) {
		return { id: "managed.app", status: "failed", detail: `refusing to remove ${appDir}: it is or contains the home directory`, fix: `unset OMP_CLOUD_APP_DIR or point it at a directory only omp-cloud uses, then rerun omp-cloud uninstall --purge` };
	}
	if ((await lstat(appDir).catch(() => null)) === null) return { id: "managed.app", status: "ok", detail: `${appDir} does not exist` };
	try {
		await rm(appDir, { recursive: true, force: true });
	} catch (error) {
		return { id: "managed.app", status: "failed", detail: error instanceof Error ? error.message : String(error), fix: `rm -rf ${appDir}` };
	}
	return { id: "managed.app", status: "changed", detail: `removed ${appDir}` };
}
