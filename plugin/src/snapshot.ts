import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, posix } from "node:path";
import { comparablePath, run, type RunResult } from "./exec";
import { UserError } from "./types";

export const MAX_SECRET_FILE_BYTES = 256 * 1024;
const DEFAULT_AUTHOR = { name: "omp-cloud", email: "omp-cloud@localhost" };

export interface SnapshotOptions {
	cwd: string;
	/** An existing scratch directory; the index and the bundle are written here. */
	tmpDir: string;
	/** `whoami.maxUploadBytes`, the service's upload cap; 0 means it states none. */
	maxBytes: number;
	secretFiles: string[];
	secretEnv: string[];
	env: Record<string, string | undefined>;
	home: string;
	/** `whoami.gitHosts`: remotes of these hosts ship as a delta from the upstream branch; any other remote ships whole. */
	gitHosts: readonly string[];
	/** `false` leaves uncommitted work out: the handoff is HEAD itself. Default `true`. */
	wip?: boolean;
	/** How long signing the handoff commit may take before it falls back to an unsigned one. Default 30 s. */
	signTimeoutMs?: number;
}

export interface Snapshot {
	root: string;
	name: string;
	/** Raw configured remote URL (`git config --get remote.<remote>.url`); empty when no remote is resolved. */
	remoteURL: string;
	baseRef: string;
	/** `""`: the bundle holds the whole history. Else the commit of the remote's branch the delta bundle builds on; the service fetches it. */
	baseCommit: string;
	handoffCommit: string;
	localBranch: string;
	/** The bundle to upload; null when the handoff is the base commit itself (nothing to ship). */
	bundlePath: string | null;
	bundleBytes: number;
	secretFiles: { path: string; content: string }[];
	secretEnv: Record<string, string>;
	paths: { home: string; workspace: string };
	author: { name: string; email: string };
	/** Commits of HEAD the handoff ships: since `baseCommit` for a delta, else the whole history. */
	commits: number;
	/** What the work-in-progress commit adds on top of HEAD. */
	wip: { files: number; insertions: number; deletions: number };
	/** The first untracked files that ship (git does not ignore them); `untrackedTotal` counts all of them. */
	untracked: string[];
	untrackedTotal: number;
	/** Credential-named files left out of the snapshot: they stay on this machine. */
	withheld: string[];
	/** Problems the user should know about that did not stop the handoff (the handoff commit could not be signed). */
	warnings: string[];
}

export interface GitOptions {
	env?: Record<string, string | undefined>;
	input?: string | Uint8Array;
	timeoutMs?: number;
}

/** Runs git in `cwd`, returning the exit code and output. */
export function gitRaw(cwd: string, args: string[], opts: GitOptions = {}): Promise<RunResult> {
	return run("git", args, {
		cwd,
		env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...opts.env },
		input: opts.input,
		timeoutMs: opts.timeoutMs,
	});
}

/** Runs git in `cwd`; any non-zero exit throws with git's own message. Returns trimmed stdout. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
	const r = await gitRaw(cwd, args, opts);
	if (r.code !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
	return r.stdout.trim();
}

async function gitOpt(cwd: string, args: string[]): Promise<string | undefined> {
	const r = await gitRaw(cwd, args);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

export function mb(bytes: number): string {
	return String(Number((bytes / (1024 * 1024)).toFixed(1)));
}

interface Upstream {
	remote: string;
	baseRef: string;
}

async function findUpstream(root: string, branch: string): Promise<Upstream | undefined> {
	if (branch) {
		const line = await gitOpt(root, [
			"for-each-ref",
			"--format=%(upstream:remotename)%09%(upstream:remoteref)",
			`refs/heads/${branch}`,
		]);
		const [remote, ref] = (line ?? "").split("\t");
		if (remote && remote !== "." && ref?.startsWith("refs/heads/")) {
			return { remote, baseRef: ref.slice("refs/heads/".length) };
		}
	}
	const sym = await gitOpt(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (sym?.startsWith("origin/")) return { remote: "origin", baseRef: sym.slice("origin/".length) };
	return undefined;
}

/**
 * The host a remote names, lower-case: an http(s) URL's `host` (with `:port` unless it is the default), the bare host of
 * an ssh URL or of scp syntax; `""` for a local path or anything else. The service reads remotes the same way.
 */
export function remoteHost(url: string): string {
	if (url.includes("://")) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return "";
		}
		if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.host;
		return ["ssh:", "git+ssh:", "ssh+git:"].includes(parsed.protocol) ? parsed.hostname : "";
	}
	return /^(?:[^@/:\s]+@)?([^@/:\s]+):(?!\/\/)/.exec(url)?.[1]?.toLowerCase() ?? "";
}

/**
 * The commit a delta handoff builds on: where `head` leaves the upstream branch as this clone last saw it
 * (`refs/remotes/<remote>/<baseRef>`), when the service can fetch that remote (its host is in `gitHosts`). `""` means
 * the whole history ships.
 */
async function deltaBase(root: string, head: string, upstream: Upstream | undefined, gitHosts: readonly string[], remoteURL: string): Promise<string> {
	if (upstream === undefined || !gitHosts.includes(remoteHost(remoteURL))) return "";
	return (await gitOpt(root, ["merge-base", head, `refs/remotes/${upstream.remote}/${upstream.baseRef}`])) ?? "";
}

async function readSecretFiles(root: string, entries: string[]): Promise<{ path: string; content: string }[]> {
	const out: { path: string; content: string }[] = [];
	for (const entry of entries) {
		const p = process.platform === "win32" ? entry.replaceAll("\\", "/") : entry;
		if (p.includes("\\")) throw new UserError(`☁ secretFiles entry ${entry} contains a backslash; separate path segments with /`);
		const unsafe =
			isAbsolute(p) || posix.normalize(p) !== p || p === ".." || p.startsWith("../") || p === ".git" || p.startsWith(".git/");
		if (unsafe) throw new Error(`${p} is not a safe workspace-relative path`);
		const abs = join(root, p);
		let st: Awaited<ReturnType<typeof stat>>;
		try {
			st = await stat(abs);
		} catch {
			throw new Error(`${p} does not exist`);
		}
		if (!st.isFile()) throw new Error(`${p} is not a regular file`);
		if (st.size > MAX_SECRET_FILE_BYTES) throw new Error(`${p} is over ${MAX_SECRET_FILE_BYTES / 1024} KiB`);
		const ignored = await gitRaw(root, ["check-ignore", "-q", "--", p]);
		if (ignored.code !== 0) throw new Error(`${p} is not gitignored; refusing to ship it`);
		out.push({ path: p, content: (await readFile(abs)).toString("base64") });
	}
	return out;
}

// Basename patterns of files that hold credentials; see `isCredentialPath`.
const CREDENTIAL_GLOBS = [
	/^\.env$/,
	/^\.env\..+$/,
	/\.tfvars$/,
	/\.tfvars\.json$/,
	/\.tfstate$/,
	/\.tfstate\..+$/,
	/\.(pem|key|p12|pfx|jks|keystore)$/,
	/^id_(rsa|dsa|ecdsa|ed25519)$/,
	/^\.(netrc|npmrc|pypirc)$/,
	/^kubeconfig$/,
	/\.kubeconfig$/,
	/^talosconfig$/,
];
const TEMPLATE_SUFFIX = /\.(example|sample|template)$/;
/** How many untracked files a handoff card names. */
export const UNTRACKED_LISTED = 10;

/** Whether a path's basename looks like a credential file (`.env`, `*.pem`, `id_rsa`, `kubeconfig`, ...). */
export function isCredentialPath(path: string): boolean {
	const base = (path.split("/").pop() ?? path).toLowerCase();
	if (/^\.env\./.test(base) && TEMPLATE_SUFFIX.test(base)) return false;
	return CREDENTIAL_GLOBS.some(re => re.test(base));
}

/**
 * Removes credential-named changes from the private index: tracked files keep their HEAD
 * content, untracked ones are dropped. Returns the paths left out, which stay on this machine.
 */
async function withholdCredentials(root: string, indexEnv: Record<string, string>, allowed: readonly string[]): Promise<string[]> {
	const allowedPaths = new Set(allowed.map(comparablePath));
	const changed = await git(root, ["diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"], { env: indexEnv });
	const fields = changed.split("\0");
	const restore: string[] = [];
	const drop: string[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const status = fields[i] ?? "";
		const path = fields[i + 1] ?? "";
		if (!isCredentialPath(path) || allowedPaths.has(comparablePath(path))) continue;
		(status.startsWith("A") ? drop : restore).push(path);
	}
	if (restore.length > 0) {
		const entries: string[] = [];
		for (const p of restore) {
			const r = await gitRaw(root, ["ls-tree", "-z", "HEAD", "--", p]);
			const entry = r.stdout.replace(/\0$/, "");
			if (entry) entries.push(entry.replace(/^(\d+) \w+ (\w+)\t/, "$1 $2\t"));
		}
		await git(root, ["update-index", "-z", "--index-info"], {
			env: indexEnv,
			input: `${entries.join("\0")}\0`,
		});
	}
	if (drop.length > 0) {
		await git(root, ["update-index", "--force-remove", "-z", "--stdin"], { env: indexEnv, input: `${drop.join("\0")}\0` });
	}
	return [...restore, ...drop].sort();
}

/** Untracked files git does not ignore, sorted. */
async function listUntracked(root: string): Promise<string[]> {
	const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	return out === "" ? [] : out.split("\0").filter(p => p !== "").sort();
}

/** Files and lines the WIP commit changes relative to HEAD. */
async function wipStat(root: string, indexEnv: Record<string, string>): Promise<{ files: number; insertions: number; deletions: number }> {
	const names = await git(root, ["diff", "--cached", "--name-only", "-z", "HEAD"], { env: indexEnv });
	const short = await git(root, ["diff", "--cached", "--shortstat", "HEAD"], { env: indexEnv });
	return {
		files: names === "" ? 0 : names.split("\0").filter(p => p !== "").length,
		insertions: Number(/(\d+) insertion/.exec(short)?.[1] ?? 0),
		deletions: Number(/(\d+) deletion/.exec(short)?.[1] ?? 0),
	};
}

/** The repository's current branch ("" when detached), its upstream and that upstream remote's raw URL ("" when the handoff would record no remote). */
export async function resolveRemote(root: string): Promise<{ localBranch: string; upstream: Upstream | undefined; remoteURL: string }> {
	const localBranch = (await gitOpt(root, ["branch", "--show-current"])) ?? "";
	const upstream = await findUpstream(root, localBranch);
	const remoteURL = upstream ? ((await gitOpt(root, ["config", "--get", `remote.${upstream.remote}.url`])) ?? "") : "";
	return { localBranch, upstream, remoteURL };
}

/** The values of the named environment variables a handoff ships as secrets; throws when one is not set. */
export function readSecretEnv(names: readonly string[], env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of names) {
		const v = env[name];
		if (v === undefined) throw new Error(`${name} is not set in this omp's environment`);
		out[name] = v;
	}
	return out;
}

/** How long `commit-tree -S` may take: a pinentry or hardware-key prompt must not hang the handoff. */
const SIGN_TIMEOUT_MS = 30_000;

/**
 * The WIP commit of `tree` on HEAD. When the user's git signs commits (`commit.gpgsign`), it is signed too, with a
 * timeout; a failed or timed-out signature falls back to an unsigned commit and a warning.
 */
async function commitHandoff(root: string, tree: string, author: { name: string; email: string }, warnings: string[], signTimeoutMs: number): Promise<string> {
	const env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
	const args = ["commit-tree", tree, "-p", "HEAD", "-m", "omp-cloud: local changes at handoff"];
	if ((await gitOpt(root, ["config", "--type=bool", "--get", "commit.gpgsign"])) === "true") {
		const signed = await gitRaw(root, ["commit-tree", "-S", ...args.slice(1)], { env, timeoutMs: signTimeoutMs });
		const commit = signed.stdout.trim();
		if (signed.code === 0 && commit !== "") return commit;
		const reason = signed.code === 124 ? "signing timed out" : signed.stderr.trim().split("\n")[0] || "signing failed";
		warnings.push(`the handoff commit is unsigned: ${reason}`);
	}
	return git(root, ["-c", "commit.gpgsign=false", ...args], { env });
}

/** The commit author of `cwd`'s git configuration, else a placeholder. */
export async function readAuthor(cwd: string): Promise<{ name: string; email: string }> {
	return {
		name: (await gitOpt(cwd, ["config", "user.name"])) || DEFAULT_AUTHOR.name,
		email: (await gitOpt(cwd, ["config", "user.email"])) || DEFAULT_AUTHOR.email,
	};
}

/**
 * Captures the working tree for a handoff: a WIP commit holding every uncommitted change
 * (tracked or not, never ignored files) and a git bundle up to it: the whole history, or, when the upstream's host is
 * in `gitHosts` and its remote-tracking branch is known, only what that branch lacks (the service fetches the rest).
 */
export async function takeSnapshot(opts: SnapshotOptions): Promise<Snapshot> {
	const top = await gitRaw(opts.cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) throw new Error("not a git repository");
	const root = top.stdout.trim();
	const headRes = await gitRaw(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (headRes.code !== 0) throw new Error("the repository has no commits");
	const head = headRes.stdout.trim();

	const { localBranch, upstream, remoteURL } = await resolveRemote(root);

	// Fail on unshippable secrets before spending time on the bundle.
	const secretFiles = await readSecretFiles(root, opts.secretFiles);
	const secretEnv = readSecretEnv(opts.secretEnv, opts.env);

	const baseCommit = await deltaBase(root, head, upstream, opts.gitHosts, remoteURL);
	const commits = Number(await git(root, ["rev-list", "--count", baseCommit === "" ? head : `${baseCommit}..${head}`]));

	const { name, email } = await readAuthor(root);

	// WIP commit via a private index so the user's index is never touched.
	let withheld: string[] = [];
	let untracked: string[] = [];
	let wip = { files: 0, insertions: 0, deletions: 0 };
	const warnings: string[] = [];
	let handoff = head;
	if (opts.wip !== false) {
		const indexEnv = { GIT_INDEX_FILE: join(opts.tmpDir, "index") };
		await git(root, ["read-tree", "HEAD"], { env: indexEnv });
		await git(root, ["add", "-A", "--", "."], { env: indexEnv });
		withheld = await withholdCredentials(root, indexEnv, secretFiles.map(f => f.path));
		untracked = (await listUntracked(root)).filter(p => !withheld.includes(p));
		const tree = await git(root, ["write-tree"], { env: indexEnv });
		wip = await wipStat(root, indexEnv);
		if (tree !== (await git(root, ["rev-parse", "HEAD^{tree}"]))) {
			handoff = await commitHandoff(root, tree, { name, email }, warnings, opts.signTimeoutMs ?? SIGN_TIMEOUT_MS);
		}
	}

	// The handoff is the base itself (git refuses an empty bundle): nothing to upload.
	let bundlePath: string | null = null;
	let bundleBytes = 0;
	if (handoff !== baseCommit) {
		bundlePath = join(opts.tmpDir, "source.bundle");
		await git(root, ["update-ref", "refs/omp-cloud/handoff", handoff]);
		try {
			await git(root, ["bundle", "create", bundlePath, "refs/omp-cloud/handoff", ...(baseCommit === "" ? [] : [`^${baseCommit}`])]);
		} finally {
			await gitRaw(root, ["update-ref", "-d", "refs/omp-cloud/handoff"]);
		}
		bundleBytes = (await stat(bundlePath)).size;
	}
	if (opts.maxBytes > 0 && bundleBytes > opts.maxBytes) {
		throw new Error(`repository bundle is ${mb(bundleBytes)} MB, over the ${mb(opts.maxBytes)} MB upload limit`);
	}

	return {
		root,
		name: basename(root),
		remoteURL,
		baseRef: upstream?.baseRef ?? "",
		baseCommit,
		handoffCommit: handoff,
		localBranch,
		bundlePath,
		bundleBytes,
		secretFiles,
		secretEnv,
		paths: { home: opts.home, workspace: root },
		author: { name, email },
		commits,
		wip,
		untracked: untracked.slice(0, UNTRACKED_LISTED),
		untrackedTotal: untracked.length,
		withheld,
		warnings,
	};
}
