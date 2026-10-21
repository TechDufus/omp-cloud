import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { threadBranch } from "./cards";
import { CloudError } from "./errors";
import { normalizeRemote, type NormalizedRemote } from "./repo-key";
import { git, gitRaw, resolveRemote } from "./snapshot";
import { UserError } from "./types";

export interface PullOptions {
	root: string;
	thread: string;
	bundlePath: string;
	/** The thread's base commit, named in the "lacks the base commit" error. */
	baseCommit: string;
	remote: string;
}

export interface PullOutcome {
	branch: string;
	head: string;
	/** Whether the pulled branch was the checked-out one of `root`, so the fast-forward moved its working tree. */
	checkedOutMoved: boolean;
	/** Another worktree of the repository that had the branch checked out and was fast-forwarded. */
	movedIn?: string;
}

/** The worktree of the repository that has `branch` checked out, if any (`git branch -f` refuses to move such a branch). */
async function holdingWorktree(root: string, branch: string): Promise<string | undefined> {
	let path = "";
	for (const line of (await git(root, ["worktree", "list", "--porcelain"])).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line === `branch refs/heads/${branch}`) return path;
	}
	return undefined;
}

/**
 * Fetches the result bundle's branch and points `omp-cloud/<thread>` at it. A worktree that has the branch checked out
 * (this one or another) is fast-forwarded in place; one that cannot be is a `conflict` naming it, since git will not
 * move a checked-out branch any other way.
 */
export async function pullBundle(opts: PullOptions): Promise<PullOutcome> {
	const branch = threadBranch(opts.thread);
	const fetched = await gitRaw(opts.root, ["fetch", "--no-tags", opts.bundlePath, `refs/heads/${branch}`]);
	if (fetched.code !== 0) {
		if (/prerequisite|missing necessary objects|bad object|unable to read tree/i.test(fetched.stderr)) {
			const base = opts.baseCommit ? ` ${opts.baseCommit}` : "";
			throw new UserError(`your repository lacks the thread's base commit${base}; git fetch ${opts.remote || "origin"}, then retry`);
		}
		throw new Error(`git fetch failed: ${fetched.stderr.trim() || `exit ${fetched.code}`}`);
	}
	const head = await git(opts.root, ["rev-parse", "FETCH_HEAD^{commit}"]);
	const holder = await holdingWorktree(opts.root, branch);
	if (holder === undefined) {
		await git(opts.root, ["branch", "-f", branch, head]);
		return { branch, head, checkedOutMoved: false };
	}
	const merged = await gitRaw(holder, ["merge", "--ff-only", head]);
	if (merged.code !== 0) {
		throw conflict(
			`${branch} is checked out in ${holder} and cannot fast-forward to the result: ${merged.stderr.trim().split("\n")[0] || "not a fast-forward"}`,
			`commit or discard what ${holder} has beyond the thread's branch, or check out another branch there, then pull again`,
		);
	}
	const here = await realpath(opts.root);
	return (await realpath(holder)) === here ? { branch, head, checkedOutMoved: true } : { branch, head, checkedOutMoved: false, movedIn: holder };
}

/** Subjects a pull card lists. */
export const PULL_SUBJECTS_MAX = 10;

/** What a pull brought and how to take it. */
export interface PullReport {
	/** Commits the cloud added since the handoff; undefined when the handoff commit is not in this repository. */
	commits: number | undefined;
	/** `%h %s` of the newest of those commits, at most {@link PULL_SUBJECTS_MAX}. */
	subjects: string[];
	/** The next step, by where the local branch stands against the pulled head. */
	next: string;
}

/** Reads the pulled branch against the handoff commit and the current HEAD; call after {@link pullBundle}. */
export async function describePull(root: string, pulled: Pick<PullOutcome, "branch" | "head" | "movedIn">, handoff: string): Promise<PullReport> {
	const { commits, subjects } = await listCommits(root, pulled.head, handoff);
	const known = commits !== undefined;
	const { branch } = pulled;
	let next: string;
	if ((await git(root, ["branch", "--show-current"])) === branch) {
		next = `${branch} is checked out here and was fast-forwarded`;
	} else if (pulled.movedIn !== undefined) {
		next = `${branch} is checked out in ${pulled.movedIn} and was fast-forwarded there`;
	} else if ((await gitRaw(root, ["merge-base", "--is-ancestor", "HEAD", pulled.head])).code === 0) {
		next = `git merge --ff-only ${branch}`;
	} else if (known) {
		next = `the local branch moved since the handoff: git cherry-pick ${handoff.slice(0, 8)}..${branch}`;
	} else {
		next = `the local branch moved since the handoff: git log --oneline HEAD..${branch}`;
	}
	return { commits, subjects, next };
}

/** The commits `handoff..head` adds: the count (undefined when `handoff` is not in the repository) and the newest subjects. */
async function listCommits(root: string, head: string, handoff: string): Promise<{ commits: number | undefined; subjects: string[] }> {
	const known = handoff !== "" && (await gitRaw(root, ["cat-file", "-e", `${handoff}^{commit}`])).code === 0;
	if (!known) return { commits: undefined, subjects: [] };
	const range = `${handoff}..${head}`;
	const commits = Number(await git(root, ["rev-list", "--count", range]));
	const subjects = commits > 0 ? (await git(root, ["log", `--max-count=${PULL_SUBJECTS_MAX}`, "--format=%h %s", range])).split("\n") : [];
	return { commits, subjects };
}

/** Whether the working tree has no changes; `untracked: false` ignores files git does not track. */
export async function isClean(root: string, opts: { untracked?: boolean } = {}): Promise<boolean> {
	const args = ["status", "--porcelain", ...(opts.untracked === false ? ["--untracked-files=no"] : [])];
	return (await git(root, args)) === "";
}

// ---------------------------------------------------------------------------
// The `cloud` tool's pull: identity check, apply modes, scratch clone
// ---------------------------------------------------------------------------

export type PullApply = "fetch" | "merge" | "worktree";

/** What identifies the repository a thread was started in. */
export interface RepoIdentity {
	handoffCommit: string;
	baseCommit: string;
	/** Credential-free remote URL the service stored; `""` when the handoff had none. */
	remoteURL: string;
}

export interface ApplyInput {
	/** The repository the pull lands in (the cwd's); undefined outside a git repository. */
	root: string | undefined;
	/** The directory the model works in; relative `into` paths resolve against it. */
	cwd: string;
	thread: string;
	scratch: boolean;
	bundlePath: string;
	identity: RepoIdentity;
	apply: PullApply;
	into: string | undefined;
	force: boolean;
}

export interface Applied extends PullReport {
	branch: string;
	head: string;
	/** `clone` for a scratch thread. */
	mode: PullApply | "clone";
	/** The directory that now holds the result: the repository, the new worktree or the clone. */
	path: string;
	/** Whether the branch checked out in `path`'s working tree moved. */
	checkedOutMoved: boolean;
	/** Another worktree of the repository that had the branch checked out and was fast-forwarded. */
	movedIn?: string;
}

/** `host/path` of a normalized remote, lower case: GitHub and most hosts ignore the case of a repository path. */
function remoteName(r: NormalizedRemote): string {
	return `${r.host}/${r.path}`.toLowerCase();
}

function conflict(message: string, hint?: string): CloudError {
	return new CloudError({ code: "conflict", message, retriable: false, outcomeKnown: true, hint });
}

/** The refusal of a pull from a directory that is not in a repository (scratch threads aside). */
export function notInRepository(): CloudError {
	return conflict("not a git repository");
}

async function hasCommit(root: string, commit: string): Promise<boolean> {
	return commit !== "" && (await gitRaw(root, ["cat-file", "-e", `${commit}^{commit}`])).code === 0;
}

/**
 * Refuses when `root` is not the repository the thread was started in: it lacks the handoff commit (and the base
 * commit), or its upstream remote is not the thread's. Nothing is fetched into a repository that fails it.
 */
export async function assertSameRepository(root: string, id: RepoIdentity): Promise<void> {
	const known = (await hasCommit(root, id.handoffCommit)) || (await hasCommit(root, id.baseCommit));
	if (!known) {
		throw conflict(
			`this repository (${root}) does not contain the thread's handoff commit ${id.handoffCommit.slice(0, 8)}: it is not the repository the thread was started in`,
			"run pull from that repository, or pass force: true to fetch the result into this one anyway",
		);
	}
	const here = normalizeRemote((await resolveRemote(root)).remoteURL);
	const there = normalizeRemote(id.remoteURL);
	if (here && there && remoteName(here) !== remoteName(there)) {
		throw conflict(
			`this repository's remote (${remoteName(here)}) is not the thread's (${remoteName(there)})`,
			"run pull from the repository the thread was started in, or pass force: true",
		);
	}
}

/** `<repo>-<short id>` beside the repository: where `worktree` puts the checkout by default. */
export function defaultWorktree(root: string, thread: string): string {
	return join(dirname(root), `${basename(root)}-${thread.slice(-6)}`);
}

async function assertNewDirectory(path: string): Promise<void> {
	const info = await stat(path).catch(() => undefined);
	if (!info) return;
	if (!info.isDirectory() || (await readdir(path)).length > 0) {
		throw conflict(`${path} exists and is not an empty directory`, "give a path that does not exist yet");
	}
}

/** Clones a scratch thread's result bundle into a new directory, with the thread branch checked out. */
async function cloneScratch(input: ApplyInput, into: string): Promise<Applied> {
	const branch = threadBranch(input.thread);
	await assertNewDirectory(into);
	await mkdir(into, { recursive: true });
	await git(into, ["init", "-q"]);
	const fetched = await gitRaw(into, ["fetch", "--no-tags", input.bundlePath, `refs/heads/${branch}:refs/heads/${branch}`]);
	if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.stderr.trim() || `exit ${fetched.code}`}`);
	await git(into, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
	await git(into, ["reset", "-q", "--hard", "HEAD"]);
	const head = await git(into, ["rev-parse", "HEAD"]);
	const commits = Number(await git(into, ["rev-list", "--count", "HEAD"]));
	const subjects = (await git(into, ["log", `--max-count=${PULL_SUBJECTS_MAX}`, "--format=%h %s", "HEAD"])).split("\n");
	return { branch, head, mode: "clone", path: into, checkedOutMoved: false, commits, subjects, next: `cd ${into}; ${branch} is checked out there` };
}

/**
 * Brings a thread's result into the local repository the way `apply` says: `fetch` points `omp-cloud/<id>` at it, `merge` also
 * fast-forwards the current branch (a clean tree only), `worktree` also checks it out in a new worktree. A scratch thread
 * is cloned into the new directory `into`. Throws `CloudError` `conflict` for every refusal, before the repository changes.
 */
export async function applyPull(input: ApplyInput): Promise<Applied> {
	const into = input.into === undefined ? undefined : resolve(input.cwd, input.into);
	if (input.scratch) {
		if (into === undefined) throw conflict("a scratch thread has no repository to pull into", "pass into: a new directory to clone the result to (/cloud pull <id> --into <dir>)");
		return cloneScratch(input, into);
	}
	const { root } = input;
	if (root === undefined) throw notInRepository();
	if (into !== undefined && input.apply !== "worktree") throw conflict(`into only applies to apply: "worktree" (or a scratch thread)`, `use apply: "worktree", or leave into out`);
	if (!input.force) await assertSameRepository(root, input.identity);
	const branch = threadBranch(input.thread);
	const current = await git(root, ["branch", "--show-current"]);
	if (input.apply === "merge") {
		if (current === "") throw conflict("merge needs a checked-out branch; HEAD is detached", `check out a branch first, or use apply: "fetch"`);
		if (current !== branch && !(await isClean(root, { untracked: false }))) {
			throw conflict("the working tree has uncommitted changes", `commit or stash them, or use apply: "fetch" (leaves the working tree alone)`);
		}
	}
	let worktree: string | undefined;
	if (input.apply === "worktree") {
		worktree = into ?? defaultWorktree(root, input.thread);
		await assertNewDirectory(worktree);
		const held = await holdingWorktree(root, branch);
		if (held !== undefined) throw conflict(`${branch} is checked out in ${held}`, `use apply: "fetch" (it is fast-forwarded there), or check out another branch there first`);
	}
	const pulled = await pullBundle({ root, thread: input.thread, bundlePath: input.bundlePath, baseCommit: input.identity.baseCommit, remote: "origin" });
	const report = await describePull(root, pulled, input.identity.handoffCommit);
	if (input.apply === "merge" && !pulled.checkedOutMoved) {
		const merged = await gitRaw(root, ["merge", "--ff-only", pulled.head]);
		if (merged.code !== 0) {
			throw conflict(
				`${current} cannot fast-forward to ${branch}: it has commits the result lacks (${merged.stderr.trim().split("\n")[0] ?? "not a fast-forward"})`,
				`${branch} was fetched: git merge ${branch} or git cherry-pick ${input.identity.handoffCommit.slice(0, 8)}..${branch} by hand`,
			);
		}
		return { ...report, ...pulled, mode: "merge", path: root, checkedOutMoved: true, next: `${current} fast-forwarded to ${pulled.head.slice(0, 8)}` };
	}
	if (worktree !== undefined) {
		await git(root, ["worktree", "add", worktree, branch]);
		return { ...report, ...pulled, mode: "worktree", path: worktree, next: `cd ${worktree}; ${branch} is checked out there` };
	}
	return { ...report, ...pulled, mode: input.apply, path: root };
}
