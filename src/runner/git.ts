import { type Exec, ExecError, shellQuote } from "./exec";

const HANDOFF_REF = "refs/omp-cloud/handoff";
const RESULT_REF = "refs/omp-cloud/result";
const DEFAULT_AUTHOR_NAME = "omp-cloud";
const DEFAULT_AUTHOR_EMAIL = "omp-cloud@localhost";

/**
 * Rebuilds the owner's repository in `workspace` from the uploaded bundle: the bundle's `refs/omp-cloud/handoff` must
 * be `handoffCommit`, and `branch` is checked out there. Sets the commit identity (defaults for an empty author) and
 * `remote.origin.url` when `remoteURL` is set. Throws `ExecError` when git fails, `Error` on a handoff mismatch.
 */
export async function restoreRepo(
	exec: Exec,
	input: {
		workspace: string;
		bundlePath: string;
		branch: string;
		handoffCommit: string;
		author: { name: string; email: string };
		remoteURL: string;
	},
): Promise<void> {
	const ws = shellQuote(input.workspace);
	await exec(`git init -q ${ws}`);
	await exec(`git -C ${ws} fetch -q ${shellQuote(input.bundlePath)} +${HANDOFF_REF}:${HANDOFF_REF}`);
	const got = (await exec(`git -C ${ws} rev-parse --verify ${HANDOFF_REF}^{commit}`)).trim();
	if (got !== input.handoffCommit) {
		throw new Error(`the uploaded source is at ${got}, not the handoff commit ${input.handoffCommit}`);
	}
	await exec(`git -C ${ws} checkout -q -f -B ${shellQuote(input.branch)} ${HANDOFF_REF}`);
	const settings: [string, string][] = [
		["user.name", input.author.name || DEFAULT_AUTHOR_NAME],
		["user.email", input.author.email || DEFAULT_AUTHOR_EMAIL],
		["commit.gpgsign", "false"],
		["tag.gpgsign", "false"],
	];
	if (input.remoteURL !== "") settings.push(["remote.origin.url", input.remoteURL]);
	for (const [key, value] of settings) await exec(`git -C ${ws} config ${key} ${shellQuote(value)}`);
}

/**
 * Brings the checked-out `branch` to `head`, the tip of the last completed turn: `bundlePath` is the newest `result.bundle`
 * (the branch under `refs/heads/<branch>`, without the base history of a delta thread, which the restored repository
 * already holds). The bundle may be newer than `head` (a VM lost after a turn's bundle was stored and before the turn
 * completed): the branch then goes to `head`, which the bundle's history must contain. `refs/omp-cloud/handoff` stays,
 * the turn's diffstat measures from it. Throws `ExecError` when git fails, `Error` when `head` is not in the bundle.
 */
export async function applyResultBundle(
	exec: Exec,
	input: { workspace: string; bundlePath: string; branch: string; head: string },
): Promise<void> {
	const ws = shellQuote(input.workspace);
	const branch = shellQuote(input.branch);
	await exec(`git -C ${ws} fetch -q ${shellQuote(input.bundlePath)} ${shellQuote(`+refs/heads/${input.branch}:${RESULT_REF}`)}`);
	const tip = (await exec(`git -C ${ws} rev-parse --verify ${RESULT_REF}^{commit}`)).trim();
	if (tip !== input.head) {
		const head = shellQuote(input.head);
		const known = !(await exitsOne(exec, `git -C ${ws} rev-parse --verify --quiet ${head}^{commit}`));
		if (!known || (await exitsOne(exec, `git -C ${ws} merge-base --is-ancestor ${head} ${RESULT_REF}`))) {
			throw new Error(`the stored result does not contain the head ${input.head} of the last turn`);
		}
	}
	await exec(`git -C ${ws} checkout -q -f -B ${branch} ${shellQuote(input.head)}`);
}

/** The branch after a turn; the counts measure it from the handoff commit: everything the cloud changed. */
export interface TurnGit {
	/** The branch tip. */
	head: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	/** Path of a new result bundle, or null when head did not change since `uploadedHead` or equals the base. */
	bundlePath: string | null;
}

const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/** Reads files changed, insertions and deletions from `git diff --shortstat`; zeros for empty output. */
function parseShortstat(text: string): { files: number; insertions: number; deletions: number } {
	const m = SHORTSTAT.exec(text);
	if (m === null) return { files: 0, insertions: 0, deletions: 0 };
	return { files: Number(m[1]), insertions: Number(m[2] ?? 0), deletions: Number(m[3] ?? 0) };
}

/** The exit code of a command that may legitimately exit 1; other failures throw. */
async function exitsOne(exec: Exec, command: string): Promise<boolean> {
	try {
		await exec(command);
		return false;
	} catch (error) {
		if (error instanceof ExecError && error.exitCode === 1) return true;
		throw error;
	}
}

/**
 * Commits whatever the turn left in the workspace (with `message`), keeps `branch` on the newest commit, measures it
 * from the handoff commit and bundles it to `bundlePath` (without `baseCommit`'s history when set) unless head is the
 * already uploaded one or the base. Throws `ExecError` when git fails.
 */
export async function finalizeTurn(
	exec: Exec,
	input: { workspace: string; branch: string; baseCommit: string; message: string; uploadedHead: string; bundlePath: string },
): Promise<TurnGit> {
	const ws = shellQuote(input.workspace);
	const branchRef = shellQuote(`refs/heads/${input.branch}`);

	await exec(`git -C ${ws} add -A`);
	if (await exitsOne(exec, `git -C ${ws} diff --cached --quiet`)) {
		await exec(`git -C ${ws} -c core.hooksPath=/dev/null commit -q --no-verify -m ${shellQuote(input.message)}`);
	}
	if (!(await exitsOne(exec, `git -C ${ws} merge-base --is-ancestor ${branchRef} HEAD`))) {
		await exec(`git -C ${ws} update-ref ${branchRef} HEAD`);
	}

	const head = (await exec(`git -C ${ws} rev-parse --verify ${branchRef}`)).trim();
	const stat = parseShortstat(await exec(`git -C ${ws} diff --shortstat ${HANDOFF_REF}..${branchRef}`));

	let bundlePath: string | null = null;
	if (head !== input.uploadedHead && head !== input.baseCommit) {
		const exclude = input.baseCommit === "" ? "" : ` ^${shellQuote(input.baseCommit)}`;
		await exec(`git -C ${ws} bundle create ${shellQuote(input.bundlePath)} ${branchRef}${exclude}`);
		bundlePath = input.bundlePath;
	}
	return { head, filesChanged: stat.files, insertions: stat.insertions, deletions: stat.deletions, bundlePath };
}
