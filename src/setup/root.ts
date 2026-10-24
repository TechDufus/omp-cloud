/** The root part of setup: one `sudo -- <self> setup system …` per run (a second only to mint a key), and what its report says. */
import { basename, resolve } from "node:path";
import { type CommandResult, type CommandRunner } from "../update/system";
import type { StepResult } from "./steps";
import { parseSystemReport, type SystemReport } from "./system";

const ROOT_PART_TIMEOUT_MS = 30 * 60_000;

/** How this process starts again: the compiled binary alone, or `bun <repo>/src/bin.ts` in a checkout. */
export interface SelfCommand {
	argv: string[];
	/** True for a release binary; false under bun (a checkout). */
	compiled: boolean;
	/** The repository root, when `compiled` is false. */
	repoRoot: string;
}

/** The command that runs this program, from `process.execPath` (tests pass their own). */
export function selfCommand(execPath: string = process.execPath, repoRoot: string = resolve(import.meta.dir, "..", "..")): SelfCommand {
	const compiled = !/^bun(-|$)/.test(basename(execPath));
	return { argv: compiled ? [execPath] : [execPath, resolve(repoRoot, "src", "bin.ts")], compiled, repoRoot };
}

/** What the root part is asked to do; every field is a validated flag (the root part takes no paths). */
export interface RootRequest {
	user: string;
	team?: string;
	maxSandboxes?: number;
	/** Package names from the fixed set (`packagesFor`); empty: none. */
	packages: readonly string[];
	mintKey?: boolean;
	noLinger?: boolean;
	migrateTeam?: boolean;
	/** The LAN address vmon listens on for other vibemon machines; absent: this server is alone. */
	clusterAddress?: string;
}

/** The arguments after `setup system`. */
export function rootArgs(request: RootRequest): string[] {
	return [
		"--user",
		request.user,
		...(request.team === undefined ? [] : ["--team", request.team]),
		...(request.maxSandboxes === undefined ? [] : ["--max-sandboxes", String(request.maxSandboxes)]),
		...(request.packages.length === 0 ? [] : ["--packages", request.packages.join(",")]),
		...(request.mintKey === true ? ["--mint-key"] : []),
		...(request.noLinger === true ? ["--no-linger"] : []),
		...(request.migrateTeam === true ? ["--migrate-team"] : []),
		...(request.clusterAddress === undefined ? [] : ["--cluster-address", request.clusterAddress]),
	];
}

/** The whole command line setup runs, `sudo -- <self> setup system <args>`. */
export function sudoCommand(self: SelfCommand, args: readonly string[]): string[] {
	return ["sudo", "--", ...self.argv, "setup", "system", ...args];
}

/** Whether sudo would run without asking (a cached credential or a NOPASSWD rule). */
export async function sudoReady(run: CommandRunner): Promise<boolean> {
	try {
		return (await run(["sudo", "-n", "true"])).code === 0;
	} catch {
		return false;
	}
}

export type RootOutcome = { ok: true; report: SystemReport } | { ok: false; steps: StepResult[]; report: SystemReport | null };

/**
 * Runs the root part through sudo, with stdin and stderr shared so a password prompt and the part's own progress lines
 * reach the terminal, and reads its report from the last stdout line. A report that says `ok: false`, an exit code without a
 * report and an unparsable line all come back as `ok: false` with steps that say why.
 */
export async function runRootPart(run: CommandRunner, self: SelfCommand, args: readonly string[]): Promise<RootOutcome> {
	const command = sudoCommand(self, args);
	let result: CommandResult;
	try {
		result = await run(command, { inherit: true, timeoutMs: ROOT_PART_TIMEOUT_MS });
	} catch (error) {
		return { ok: false, report: null, steps: [rootFailure(`sudo could not start: ${error instanceof Error ? error.message : String(error)}`, command)] };
	}
	let report: SystemReport | null = null;
	try {
		report = parseSystemReport(result.stdout.trimEnd().split("\n").at(-1) ?? "");
	} catch {
		// No report: reported below with the exit code.
	}
	if (report !== null && report.ok && result.code === 0) return { ok: true, report };
	if (report !== null) {
		const failed = report.steps.filter((step) => step.status === "failed");
		return { ok: false, report, steps: failed.length > 0 ? failed : [rootFailure(`the root part reported failure (exit ${result.code})`, command)] };
	}
	const why = result.code === 1 ? "sudo was refused or the root part failed before it could report" : `the root part exited ${result.code} without a report`;
	return { ok: false, report: null, steps: [rootFailure(why, command)] };
}

function rootFailure(detail: string, command: readonly string[]): StepResult {
	return { id: "system", status: "failed", detail, fix: `run it yourself to see why: ${command.join(" ")}` };
}
