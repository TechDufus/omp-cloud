/** What every `omp-cloud setup` step returns, and the reporter that prints them and collects the `--json` report. */

export interface StepResult {
	/** A short stable name: `kvm`, `vmon`, `units.omp-cloud`. */
	id: string;
	/** `ok`: already right, `changed`: done now, `skipped`: not applicable or declined, `failed`: needs the user. */
	status: "ok" | "changed" | "skipped" | "failed";
	detail: string;
	/** A command or action that repairs a failure; present on failures that have one. */
	fix?: string;
}

const MARKS: Record<StepResult["status"], string> = { ok: "·", changed: "✓", skipped: "-", failed: "✗" };
const COLORS: Record<StepResult["status"], string> = { ok: "\x1b[2m", changed: "\x1b[32m", skipped: "\x1b[2m", failed: "\x1b[31m" };
const RESET = "\x1b[0m";

export interface ReporterOptions {
	/** Receives `✓`, `·` and `-` lines and notes (stdout in a plain run, stderr under `--json` or in the root part). */
	out: (text: string) => void;
	/** Receives `✗` lines and their fixes (always stderr). */
	err: (text: string) => void;
	/** Colour the marks; only a TTY gets it. */
	color: boolean;
}

/** One line per step: `✓ id  detail`, a failed step followed by `  fix: …` on the error sink. Keeps every step for the report. */
export class Reporter {
	readonly #options: ReporterOptions;
	readonly steps: StepResult[] = [];

	constructor(options: ReporterOptions) {
		this.#options = options;
	}

	/** Whether marks are coloured (the table of the doctor follows the same rule). */
	get color(): boolean {
		return this.#options.color;
	}

	/** The reporter for a process that prints to its own stdout and stderr (colour when stdout is a TTY), or all to stderr when stdout is reserved for JSON. */
	static forProcess(stdoutIsReport: boolean): Reporter {
		const toStdout = (text: string) => void process.stdout.write(text);
		const toStderr = (text: string) => void process.stderr.write(text);
		const stream = stdoutIsReport ? process.stderr : process.stdout;
		return new Reporter({ out: stdoutIsReport ? toStderr : toStdout, err: toStderr, color: stream.isTTY === true });
	}

	report(step: StepResult): void {
		this.steps.push(step);
		const mark = this.#options.color ? `${COLORS[step.status]}${MARKS[step.status]}${RESET}` : MARKS[step.status];
		const sink = step.status === "failed" ? this.#options.err : this.#options.out;
		sink(`${mark} ${step.id}  ${step.detail}\n`);
		if (step.status === "failed" && step.fix !== undefined) this.#options.err(`    fix: ${step.fix}\n`);
	}

	reportAll(steps: readonly StepResult[]): void {
		for (const step of steps) this.report(step);
	}

	/** Records steps that were already printed by someone else (the root part's own lines) so the report and `failed` include them. */
	collect(steps: readonly StepResult[]): void {
		this.steps.push(...steps);
	}

	/** A plain line that is not a step (the plan, a hint, `log in later: …`). */
	note(text: string): void {
		this.#options.out(`${text}\n`);
	}

	/** A plain line on the error sink. */
	warn(text: string): void {
		this.#options.err(`${text}\n`);
	}

	get failed(): boolean {
		return this.steps.some((step) => step.status === "failed");
	}
}
