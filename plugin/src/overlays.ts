import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import type { PiHost } from "./types";

export function expandTilde(file: string): string {
	if (file === "~") return homedir();
	return file.startsWith("~/") || file.startsWith("~\\") ? `${homedir()}${file.slice(1)}` : file;
}

/** The `--config <file>` and `--config=<file>` values of an omp command line. */
export function configFlags(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--config") {
			const next = argv[i + 1];
			if (next !== undefined) out.push(next);
			i++;
		} else if (arg.startsWith("--config=")) {
			out.push(arg.slice("--config=".length));
		}
	}
	return out;
}

export interface OverlaySources {
	argv?: readonly string[];
	env?: Record<string, string | undefined>;
	cwd?: string;
}

/**
 * The session's active `--config` overlays, absolute and in load order. The live settings
 * instance (`pi.pi.settings.getConfigFiles()`) is authoritative; when it is not reachable (omp's
 * settings proxy throws until initialized) or reports none, the overlays are read the way omp reads
 * them: `PI_CONFIG_FILES` first, then each `--config` of the command line.
 */
export function sessionOverlays(pi: Pick<PiHost, "pi">, src: OverlaySources = {}): string[] {
	try {
		const live = pi.pi.settings.getConfigFiles();
		if (live.length > 0) return [...live];
	} catch {
		// not reachable: fall back to the command line
	}
	const env = src.env ?? process.env;
	const cwd = src.cwd ?? process.cwd();
	const fromEnv = (env.PI_CONFIG_FILES ?? "").split(delimiter).filter(f => f !== "");
	return [...fromEnv, ...configFlags(src.argv ?? process.argv)].map(f => resolve(cwd, expandTilde(f)));
}
