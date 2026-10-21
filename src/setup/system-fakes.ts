/** Fakes shared by the tests of the root part: a recording command runner and a temp root. Nothing here is used outside tests. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandOptions, CommandResult, CommandRunner } from "../update/system";

export interface Call {
	argv: string[];
	options: CommandOptions;
}

export interface FakeRunner {
	run: CommandRunner;
	calls: Call[];
	/** The recorded command lines, joined. */
	lines(): string[];
}

/** A runner that records every call and answers through `respond` (undefined: exit 0, no output). */
export function fakeRunner(respond: (argv: readonly string[], options: CommandOptions) => Partial<CommandResult> | undefined = () => undefined): FakeRunner {
	const calls: Call[] = [];
	const run: CommandRunner = async (argv, options = {}) => {
		calls.push({ argv: [...argv], options });
		return { code: 0, stdout: "", stderr: "", ...respond(argv, options) };
	};
	return { run, calls, lines: () => calls.map((call) => call.argv.join(" ")) };
}

/** Writes `text` at `path` under `root`, creating the directories. */
export async function putFile(root: string, path: string, text: string, mode = 0o644): Promise<void> {
	const full = join(root, path);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, text, { mode });
}
