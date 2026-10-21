/**
 * The one lock of the runs that share the gateway clients file and the local vmon: `scenario`, `plugin:scenario`,
 * `update:scenario`, `install:scenario` and `parity:capture`. A pid file in the shared omp-cloud state directory; a run takes it
 * for its whole life and refuses to start while another run holds it. A file whose pid is dead is stale and taken over. The lock
 * is released when the process exits and on SIGINT and SIGTERM.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const RUN_LOCK_FILE = join(homedir(), ".local", "share", "omp-cloud", "scenario.lock");

interface Holder {
	pid: number;
	name: string;
	since: string;
}

/** Whether a process with this pid exists (a process of another user counts as alive). */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function readHolder(file: string): Holder | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const pid = Reflect.get(parsed, "pid");
		const name = Reflect.get(parsed, "name");
		const since = Reflect.get(parsed, "since");
		return typeof pid === "number" && typeof name === "string" && typeof since === "string" ? { pid, name, since } : null;
	} catch {
		return null;
	}
}

/**
 * Takes the lock for the running process as `name` (`plugin:scenario`, `parity:capture`…). Throws an Error naming the holder
 * when another live process has it. Call once, at the start of a run.
 */
export function acquireRunLock(name: string, file: string = RUN_LOCK_FILE): void {
	mkdirSync(dirname(file), { recursive: true });
	const mine: Holder = { pid: process.pid, name, since: new Date().toISOString() };
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			// `wx`: the file is created only when it does not exist, so two runs starting together cannot both win.
			const fd = openSync(file, "wx", 0o600);
			try {
				writeFileSync(fd, JSON.stringify(mine));
			} finally {
				closeSync(fd);
			}
			release(file, mine.pid);
			return;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		const holder = readHolder(file);
		if (holder !== null && holder.pid !== process.pid && alive(holder.pid)) {
			throw new Error(
				`${basename(file)}: ${holder.name} (pid ${holder.pid}, since ${holder.since}) is running: it owns the gateway clients file and the local vmon, so ${name} does not start. Wait for it, or stop it.`,
			);
		}
		// A dead holder, an unreadable file or our own pid left by an earlier run of this process: stale. Remove it and try again.
		try {
			unlinkSync(file);
		} catch {
			// Another run removed it first.
		}
	}
	throw new Error(`${file}: could not take the lock`);
}

/** Removes the lock file at exit and on SIGINT and SIGTERM, but only while it is still this process's. */
function release(file: string, pid: number): void {
	const drop = (): void => {
		if (readHolder(file)?.pid !== pid) return;
		try {
			unlinkSync(file);
		} catch {
			// Already gone.
		}
	};
	process.on("exit", drop);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			drop();
			process.exit(signal === "SIGINT" ? 130 : 143);
		});
	}
}

/** {@link acquireRunLock} for a script's top level: a refusal is printed and ends the process with status 2. */
export function takeRunLockOrExit(name: string): void {
	try {
		acquireRunLock(name);
	} catch (error) {
		console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
}
