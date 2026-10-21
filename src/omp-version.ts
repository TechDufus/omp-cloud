import { join } from "node:path";
import { isRecord } from "./guards";

const VERSION_OUTPUT = /^omp\/(\d+\.\d+\.\d+)$/;

/** `X.Y.Z` from the output of `omp --version` (`omp/X.Y.Z`); throws when it is anything else. */
export function parseOmpVersion(output: string): string {
	const match = VERSION_OUTPUT.exec(output.trim());
	if (match?.[1] === undefined) throw new Error(`omp --version printed ${JSON.stringify(output.trim().slice(0, 100))}, not omp/<major>.<minor>.<patch>`);
	return match[1];
}

/**
 * `PATH` without the `node_modules/.bin` directories. `bun run` puts the repository's first, where the pinned SDK
 * package installs its own `omp`: that is a library, not the owner's CLI.
 */
export function pathWithoutNodeBin(env: NodeJS.ProcessEnv = process.env): string {
	return (env.PATH ?? "")
		.split(":")
		.filter(dir => !dir.endsWith("/node_modules/.bin"))
		.join(":");
}

export interface HostOmp {
	/** The executable to spawn. */
	path: string;
	/** `X.Y.Z` from `<path> --version`. */
	version: string;
}

/**
 * The owner's omp, found the way `omp update` recognises a managed install: a Tern root at
 * `${XDG_DATA_HOME:-$HOME/.local/share}/tern/omp` (Tern installs and updates omp there: `manager.json`, `versions/<v>`,
 * `bin/omp`) whose `manager.json` says `{"manager": "tern"}` (the marker `omp update` defers to) supplies its
 * `bin/omp`. Stale copies elsewhere on PATH do not matter, and must not: several omp installs coexist, and a service
 * started from a login shell once reported an old version because an old binary earlier on PATH shadowed the managed one.
 * Without a Tern root, the first `omp` on PATH, skipping `node_modules/.bin`. The version is whatever that binary prints
 * for `--version`.
 */
export async function hostOmp(env: NodeJS.ProcessEnv = process.env): Promise<HostOmp> {
	const path = (await ternOmp(env)) ?? Bun.which("omp", { PATH: pathWithoutNodeBin(env) });
	if (path === null) throw new Error("omp is not installed on the service host (no Tern install, no omp on PATH)");
	const proc = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`${path} --version exited ${exitCode}: ${stderr.trim().slice(0, 200)}`);
	return { path, version: parseOmpVersion(stdout) };
}

/** `bin/omp` of the Tern-managed omp root, or `undefined` when the root, its marker or its binary is missing. */
async function ternOmp(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const dataHome = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, ".local", "share") : undefined);
	if (dataHome === undefined) return undefined;
	const root = join(dataHome, "tern", "omp");
	let manifest: unknown;
	try {
		manifest = await Bun.file(join(root, "manager.json")).json();
	} catch {
		return undefined;
	}
	if (!isRecord(manifest) || manifest.manager !== "tern") return undefined;
	const bin = join(root, "bin", "omp");
	return (await Bun.file(bin).exists()) ? bin : undefined;
}
