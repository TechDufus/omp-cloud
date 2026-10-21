import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The argv prefix that re-enters the omp hosting this plugin, the way omp's own `resolveCliEntryCmd` does: a compiled
 * omp (its `Bun.main` lives in Bun's virtual filesystem) is its own executable, without the Windows extended-length
 * prefix (`\\?\`) that omp also strips before spawning it; anywhere else (`bun test`, a source checkout) the `omp` on
 * PATH. A bare `omp` can be another, older install than the one hosting the plugin, hence the preference; omp's own
 * `resolveCliEntryCmd` is not importable from an extension, so this repeats its rule. `main` is `Bun.main`; a
 * parameter only so tests can supply a compiled omp's.
 */
export function ompCommand(main: string = Bun.main): string[] {
	const compiled = /\$bunfs|~BUN|%7EBUN/.test(main);
	const self = process.execPath.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
	return compiled && existsSync(self) ? [self] : ["omp"];
}

/** `p` as omp's `normalizePathForComparison` would compare it: case-insensitive on Windows, exact elsewhere. */
export function comparablePath(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

export interface RunOptions {
	cwd?: string;
	/** Merged over process.env; an undefined value removes the variable. */
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	input?: string | Uint8Array;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Runs a child process and collects its output. Never rejects: a spawn failure
 * is code 127 and a timeout is code 124, both with the reason in stderr.
 * Used instead of `pi.exec`, which cannot set the child's environment.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
	for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
	const child = spawn(cmd, args, {
		cwd: opts.cwd,
		env: env as NodeJS.ProcessEnv,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	let settled = false;
	let timedOut = false;
	const timer = opts.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, opts.timeoutMs)
		: undefined;
	const finish = (code: number, extra = ""): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve({
			code,
			stdout: Buffer.concat(out).toString("utf8"),
			stderr: Buffer.concat(err).toString("utf8") + extra,
		});
	};
	child.stdout.on("data", (d: Buffer) => out.push(d));
	child.stderr.on("data", (d: Buffer) => err.push(d));
	child.on("error", e => finish(127, `${cmd}: ${e.message}`));
	child.on("close", code => {
		if (timedOut) finish(124, `${cmd}: timed out after ${opts.timeoutMs}ms`);
		else finish(code ?? 1);
	});
	child.stdin.on("error", () => {});
	child.stdin.end(opts.input);
	return promise;
}
