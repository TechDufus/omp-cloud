import { parseOmpVersion } from "../omp-version";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandOptions {
	/** The command is killed after this long (reported as exit 124). Default 60 s. */
	timeoutMs?: number;
	/** Variables added over the caller's environment for this child (secrets go here, never in argv). */
	env?: Readonly<Record<string, string>>;
	/** The child shares this process's stdin and stderr (a sudo password prompt, live progress); its stderr then comes back as "". */
	inherit?: boolean;
}

/** Runs a program with arguments (never a shell). Resolves with its exit code; rejects only when it cannot be started. Tests pass fakes: nothing in `update` touches systemd any other way. */
export type CommandRunner = (argv: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

/** The real runner: `Bun.spawn` with the caller's environment, stdin closed. */
export const runCommand: CommandRunner = async (argv, options = {}) => {
	const [program, ...args] = argv;
	if (program === undefined) throw new Error("no command to run");
	const env = options.env === undefined ? process.env : { ...process.env, ...options.env };
	const proc =
		options.inherit === true
			? Bun.spawn([program, ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit", env })
			: Bun.spawn([program, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const [stdout, stderr, exited] = await Promise.all([
			proc.stdout.text(),
			typeof proc.stderr === "object" ? proc.stderr.text() : "",
			proc.exited,
		]);
		return { code: timedOut ? 124 : exited, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
};

/** The last non-empty line of `text`, cut: a reason fit for an error message. */
export function lastLine(text: string): string {
	const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	return (lines.at(-1) ?? "").slice(0, 200);
}

/** vibemon as the updater sees it (`src/vmon/pin.ts` in production, a fake in tests). */
export interface VmonTools {
	/** The vibemon tag this build pins (`VMON_PIN`). */
	pin: string;
	/** The installed vibemon (`v0.4.0`), or null when it cannot be read. */
	installed(): Promise<string | null>;
	/** Whether the root helper and the sudo rule that allows it are in place. */
	helper(): Promise<{ available: boolean }>;
	/** Runs the root helper for `tag`; throws with its message on any failure (the helper rolls back itself). */
	install(tag: string): Promise<void>;
}

const UNIT_NAME = /^[A-Za-z0-9:_.@-]{1,100}$/;

/**
 * The variables in the value of `systemctl show -p Environment`: space-separated `NAME=value` words, a word with a
 * space or quote in it wrapped in double quotes with backslash escapes. Words that are not `NAME=value` are skipped.
 */
export function parseSystemdEnvironment(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	let word = "";
	let inWord = false;
	let quoted = false;
	const flush = (): void => {
		const at = word.indexOf("=");
		if (inWord && at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, at))) out[word.slice(0, at)] = word.slice(at + 1);
		word = "";
		inWord = false;
	};
	for (let i = 0; i < text.length; i++) {
		const char = text[i] ?? "";
		if (quoted) {
			if (char === "\\" && i + 1 < text.length) word += text[++i] ?? "";
			else if (char === '"') quoted = false;
			else word += char;
		} else if (char === '"') {
			quoted = true;
			inWord = true;
		} else if (/\s/.test(char)) {
			flush();
		} else {
			word += char;
			inWord = true;
		}
	}
	flush();
	return out;
}

/** How `Units.runTransient` starts a unit. */
export interface TransientOptions {
	collect?: boolean;
	properties?: readonly string[];
	env?: Readonly<Record<string, string>>;
}

/** `systemctl --user` and `systemd-run --user` over a CommandRunner. */
export class Units {
	readonly #run: CommandRunner;

	constructor(run: CommandRunner) {
		this.#run = run;
	}

	static checkName(unit: string): string {
		if (!UNIT_NAME.test(unit)) throw new Error(`not a unit name: ${JSON.stringify(unit.slice(0, 50))}`);
		return unit;
	}

	async #systemctl(args: readonly string[]): Promise<CommandResult> {
		return this.#run(["systemctl", "--user", ...args]);
	}

	/** Throws with systemctl's reason when the command fails. */
	async #must(args: readonly string[]): Promise<string> {
		const result = await this.#systemctl(args);
		if (result.code !== 0) throw new Error(`systemctl ${args[0]} ${args[1] ?? ""} failed: ${lastLine(result.stderr) || `exit ${result.code}`}`);
		return result.stdout;
	}

	async restart(unit: string): Promise<void> {
		await this.#must(["restart", Units.checkName(unit)]);
	}

	async stop(unit: string): Promise<void> {
		await this.#must(["stop", Units.checkName(unit)]);
	}

	async start(unit: string): Promise<void> {
		await this.#must(["start", Units.checkName(unit)]);
	}

	async daemonReload(): Promise<void> {
		await this.#must(["daemon-reload"]);
	}

	/** `try-restart`: restarts the units that run and starts nothing. */
	async tryRestart(...units: readonly string[]): Promise<void> {
		await this.#must(["try-restart", ...units.map(Units.checkName)]);
	}

	/** `enable --now`: links the units into their targets and starts them. */
	async enableNow(...units: readonly string[]): Promise<void> {
		await this.#must(["enable", "--now", ...units.map(Units.checkName)]);
	}

	/** `disable --now`: stops the unit and removes its links. Throws when the unit does not exist. */
	async disable(unit: string): Promise<void> {
		await this.#must(["disable", "--now", Units.checkName(unit)]);
	}

	/** Clears a unit's `failed` state; never throws (a unit that is not failed or not loaded answers with an error too). */
	async resetFailed(unit: string): Promise<void> {
		await this.#systemctl(["reset-failed", Units.checkName(unit)]);
	}

	async isEnabled(unit: string): Promise<boolean> {
		return (await this.#systemctl(["is-enabled", "--quiet", Units.checkName(unit)])).code === 0;
	}

	async isActive(unit: string): Promise<boolean> {
		return (await this.#systemctl(["is-active", "--quiet", Units.checkName(unit)])).code === 0;
	}

	/** One property of a unit (`systemctl show -p <name> --value`), trimmed; "" when unset. */
	async property(unit: string, name: string): Promise<string> {
		return (await this.#must(["show", "-p", name, "--value", Units.checkName(unit)])).trim();
	}

	/**
	 * The unit's whole `Environment` as systemd reports it; empty when the unit is not loaded or sets none. A caller that
	 * starts the unit again passes all of it on, so a recreated unit keeps its `HOME` and `OMP_CLOUD_APP_DIR`.
	 */
	async environment(unit: string): Promise<Record<string, string>> {
		try {
			return parseSystemdEnvironment(await this.property(unit, "Environment"));
		} catch {
			return {};
		}
	}

	/** The pid of the unit's main process, or null when it has none. */
	async mainPid(unit: string): Promise<number | null> {
		const pid = Number(await this.property(unit, "MainPID"));
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	}

	/** The omp the unit's main process runs: its image's own `--version` (right even after the file on disk was replaced), or null when unknown. */
	async ompVersion(unit: string): Promise<string | null> {
		try {
			const pid = await this.mainPid(unit);
			if (pid === null) return null;
			const result = await this.#run([`/proc/${pid}/exe`, "--version"], { timeoutMs: 15_000 });
			return result.code === 0 ? parseOmpVersion(result.stdout) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Runs `argv` as the transient user unit `unit` (`systemd-run --user --unit=<unit>`), which outlives the caller.
	 * `collect` (default true) unloads the unit when it ends, a failed one included; a long-running service passes false
	 * so that a crash leaves it `failed` and restartable. A transient unit that has ended is unloaded, so `systemctl
	 * restart` of it fails and a caller that must bring it back runs it again through here. `env` is set for the process
	 * (`--setenv`), `properties` are unit properties. Throws with systemd's reason, e.g. when a unit of that name still exists.
	 */
	async runTransient(unit: string, argv: readonly string[], options: TransientOptions = {}): Promise<void> {
		Units.checkName(unit);
		await this.#systemctl(["reset-failed", unit]);
		const flags = [
			...(options.collect === false ? [] : ["--collect"]),
			...(options.properties ?? []).flatMap((property) => ["--property", property]),
			...Object.entries(options.env ?? {}).map(([name, value]) => `--setenv=${name}=${value}`),
		];
		const result = await this.#run(["systemd-run", "--user", `--unit=${unit}`, ...flags, ...argv]);
		if (result.code !== 0) throw new Error(`systemd-run ${unit} failed: ${lastLine(result.stderr) || `exit ${result.code}`}`);
	}
}
