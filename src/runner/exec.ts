import { CommandExitError, type Sandbox } from "e2b";

/** The longest command text an `ExecError` message quotes. */
const MAX_COMMAND_CHARS = 200;
/** Default timeout of a command in a sandbox. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** A shell command that exited non-zero. The message names the command (cut), never its output. */
export class ExecError extends Error {
	readonly exitCode: number;
	readonly stderr: string;

	constructor(command: string, exitCode: number, stderr: string) {
		const shown = command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command;
		super(`command failed (exit ${exitCode}): ${shown}`);
		this.name = "ExecError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

/** A failed command as one line for a notice: the exit code and the last line of its stderr (the command text says nothing about why). */
export function execFailure(error: unknown): string {
	if (!(error instanceof ExecError)) return error instanceof Error ? error.message : String(error);
	const last = error.stderr.split("\n").map(line => line.trim()).filter(line => line !== "").at(-1);
	return last === undefined ? `exit ${error.exitCode}, no error output` : `exit ${error.exitCode}: ${last.slice(0, MAX_COMMAND_CHARS)}`;
}

/** Runs a shell command and returns its stdout; throws `ExecError` on a non-zero exit. */
export type Exec = (command: string, options?: { cwd?: string; timeoutMs?: number }) => Promise<string>;

/** Single-quotes `value` for a POSIX shell. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Runs commands in the sandbox as its default user; `timeoutMs` defaults to 10 minutes. */
export function sandboxExec(sandbox: Sandbox): Exec {
	return async (command, options) => {
		try {
			const result = await sandbox.commands.run(command, {
				cwd: options?.cwd,
				timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			});
			return result.stdout;
		} catch (error) {
			if (error instanceof CommandExitError) throw new ExecError(command, error.exitCode, error.stderr);
			throw error;
		}
	};
}

/** Runs commands on this machine through `bash -c`; for tests. Not a login shell: the host's profile must neither slow nor change them. */
export function localExec(): Exec {
	return async (command, options) => {
		const proc = Bun.spawn(["bash", "-c", command], {
			cwd: options?.cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});
		const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
		if (exitCode !== 0) throw new ExecError(command, exitCode, stderr);
		return stdout;
	};
}
