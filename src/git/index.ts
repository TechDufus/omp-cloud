/**
 * The service's own git: a bare cache per remote that holds the base branch the owner's handoffs build on, so a handoff
 * ships only what the remote lacks (a delta bundle) and the service completes it to the full history the VM needs.
 *
 * Every git call runs with a minimal environment (`HOME` is a private temp directory, no system or global config, no
 * prompts) and, for a configured host, with a credential helper that reads the token from a 0600 file in that
 * directory: the token never reaches argv, the environment, logs or a VM. Failures are scrubbed before they leave.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitHostConfig } from "../config";
import { GitHubAppNotInstalled, type GitHubApp } from "../github/app";
import { githubRepoOf } from "../github/repo";
import { shellQuote } from "../runner/exec";
import { scrub, writeCredentialHelper } from "./credential";
import { InspectError, Inspection } from "./inspect";
import { normalizeRemote, remoteHostOf } from "./remote";
import { SecretError, SecretRefs } from "./secret";
import { rewriteSigned, type RawGit } from "./sign";

/** The refs of an inspection repository: the thread's handoff commit and the branch of its stored result bundle. */
const INSPECT_BASE_REF = "refs/omp-cloud/base";
const INSPECT_RESULT_REF = "refs/omp-cloud/result";
const HANDOFF_REF = "refs/omp-cloud/handoff";
/** Local git work (a bundle of a big history) gets this long. */
const LOCAL_TIMEOUT_MS = 10 * 60_000;
/** The longest reason from git that an error carries. */
const MAX_REASON_CHARS = 200;
/** What git says when the remote simply has no such branch: nothing to add to "is not on". */
const REF_NOT_FOUND = /couldn't find remote ref|not our ref|no such ref/i;

/**
 * A handoff the service cannot take. `code` tells the caller what is wrong: `base` the remote does not (or cannot)
 * provide the base commit, `source` the uploaded bundle does not match the request. The message is scrubbed.
 */
export class GitError extends Error {
	override name = "GitError";
	constructor(
		readonly code: "base" | "source",
		message: string,
	) {
		super(message);
	}
}

/** What `inspect` reads: the thread's repository (`baseCommit` `""` for a full-history thread) and its stored bundles. */
export interface InspectSource {
	threadId: string;
	remoteURL: string;
	baseCommit: string;
	/** The path of `source.bundle`; null when the thread has none. Needed by full-history threads. */
	sourceBundle: string | null;
	/** The path of `result.bundle`; null when no turn stored one. */
	resultBundle: string | null;
	/** The branch the result bundle holds under `refs/heads/`. */
	resultBranch: string;
}

/** What `prepare` needs to know of the thread's repository. */
export interface RepoRef {
	remoteURL: string;
	baseRef: string;
	baseCommit: string;
	handoffCommit: string;
}

/** A full-history bundle on disk; `release` deletes it. */
export interface ComposedSource {
	path: string;
	release(): Promise<void>;
}

/** The base of a scratch thread: a full-history bundle of one empty commit, which is the handoff commit. */
export interface ScratchSource extends ComposedSource {
	/** The empty commit; the bundle's `refs/omp-cloud/handoff` is at it. */
	commit: string;
}

export interface GitServiceOptions {
	/** The service's data directory: caches live in `<dataDir>/git/cache`, scratch space in `<dataDir>/git/tmp`. */
	dataDir: string;
	/** `Config.git.hosts` */
	hosts: Record<string, GitHostConfig>;
	/** `Config.git.fetchTimeoutSeconds`: each network git call of `prepare` stops after this long. */
	fetchTimeoutSeconds: number;
	/** `Config.git.pushTimeoutSeconds`: each network git call of `push` stops after this long. */
	pushTimeoutSeconds: number;
	/** Test seam: the git executable (a wrapper that records its arguments and environment); defaults to `git`. */
	gitBinary?: string;
	/** Test seam: resolves the credential references; defaults to a 5 minute in-memory cache. */
	secrets?: SecretRefs;
	/** The GitHub App: github.com remotes it is installed on are fetched and pushed with its 1-hour tokens. */
	github?: Pick<GitHubApp, "connected" | "tokenFor">;
}

/** What `push` publishes. */
export interface PushInput {
	/** The thread's remote as stored (`repo.remoteURL`); it is normalized like a base fetch's. */
	remoteURL: string;
	/** The thread's `result.bundle` blob on disk. */
	bundlePath: string;
	/** The branch inside the bundle (`omp-cloud/<id>`). */
	localBranch: string;
	/** The commit the bundle's branch must be at. */
	head: string;
	/** The branch to write on the remote. */
	target: string;
	/** Globs (`*` is any run of characters, the whole name must match) of branches a push never writes to. */
	protectedPatterns: readonly string[];
}

/** What `signResult` re-signs: the thread's base and its stored result bundle. */
export interface SignInput {
	remoteURL: string;
	baseCommit: string;
	handoffCommit: string;
	/** The head of the latest result the service already exposed (stored, pulled or pushed); `""` for none. */
	uploadedHead: string;
	/** The path of `source.bundle`; null when the thread has none. Needed by full-history threads. */
	sourceBundle: string | null;
	/** The path of the result bundle the VM just made. */
	resultBundle: string;
	/** The branch the result bundle holds under `refs/heads/`. */
	branch: string;
	/** The branch's head in the result bundle. */
	head: string;
	privatePem: string;
	committer: { name: string; email: string } | null;
}

/** A result bundle whose new commits the service signed; `dispose` deletes it. */
export interface SignedResult {
	bundlePath: string;
	head: string;
	rewritten: number;
	dispose(): Promise<void>;
}

/** The outcome of a push: `error` says why nothing was pushed (`""` when it was). It never carries a credential. */
export interface PushOutcome {
	pushed: boolean;
	error: string;
	/** The remote's default branch (without `refs/heads/`) when `ls-remote` told; `""` where unknown. */
	defaultBranch: string;
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

interface RunOptions {
	cwd?: string;
	/** A normalized remote: the call goes to the network, with the credential of the remote's host when one is configured. */
	remote?: string;
	timeoutMs: number;
}

/** The last non-empty line of git's stderr, cut: a reason fit for an error message. */
function reasonOf(stderr: string): string {
	const line = stderr
		.split("\n")
		.map(l => l.trim())
		.filter(l => l !== "")
		.at(-1);
	return (line ?? "git failed").slice(0, MAX_REASON_CHARS);
}

/** Whether `name` matches one of the globs (`*` is any run of characters, including `/`; the whole name must match). */
function isProtected(name: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => {
		const parts = pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
		return new RegExp(`^${parts.join(".*")}$`).test(name);
	});
}

/** What a failed `git push` (or the `ls-remote` before it) means for the owner: friendly text for the refusals git reports, else its last line. */
function pushFailure(run: Run, remote: string, target: string, timeoutMs: number): string {
	if (run.code === 124) return `git push timed out after ${timeoutMs / 1000} s`;
	const text = `${run.stderr}\n${run.stdout}`;
	if (/non-fast-forward|fetch first/.test(text)) return `${target} on ${remote} has commits the result lacks; not force-pushing`;
	if (/remote rejected/.test(text)) {
		const lines = run.stderr.split("\n").map(line => line.trim());
		const remoteLine = lines.find(line => /^remote: .*(error|rejected|denied|declined|protected)/i.test(line));
		const rejection = lines.find(line => line.includes("[remote rejected]"));
		const reason = remoteLine?.replace(/^remote: (error: )?/i, "") ?? rejection?.match(/\(([^()]*)\)\s*$/)?.[1] ?? reasonOf(run.stderr);
		return `the remote refused ${target}: ${reason.slice(0, MAX_REASON_CHARS)}`;
	}
	return `git push failed: ${reasonOf(run.stderr)}`;
}

export class GitService {
	readonly #cacheDir: string;
	readonly #tmpDir: string;
	readonly #hosts: Record<string, GitHostConfig>;
	readonly #fetchTimeoutMs: number;
	readonly #pushTimeoutMs: number;
	readonly #git: string;
	readonly #secrets: SecretRefs;
	readonly #github: Pick<GitHubApp, "connected" | "tokenFor"> | undefined;
	readonly #chains = new Map<string, Promise<void>>();

	private constructor(options: GitServiceOptions) {
		this.#cacheDir = join(options.dataDir, "git", "cache");
		this.#tmpDir = join(options.dataDir, "git", "tmp");
		this.#hosts = options.hosts;
		this.#fetchTimeoutMs = options.fetchTimeoutSeconds * 1000;
		this.#pushTimeoutMs = options.pushTimeoutSeconds * 1000;
		this.#git = options.gitBinary ?? "git";
		this.#secrets = options.secrets ?? new SecretRefs();
		this.#github = options.github;
	}

	/** Creates the directories and clears the scratch space a crash may have left behind (it can hold token files). */
	static async open(options: GitServiceOptions): Promise<GitService> {
		const service = new GitService(options);
		await rm(service.#tmpDir, { recursive: true, force: true });
		await mkdir(service.#tmpDir, { recursive: true, mode: 0o700 });
		await mkdir(service.#cacheDir, { recursive: true });
		return service;
	}

	/** The configured host keys (`host` or `host:port`), plus `github.com` while a GitHub App is connected; sorted, unique. */
	hosts(): string[] {
		const hosts = new Set(Object.keys(this.#hosts));
		if (this.#github?.connected() === true) hosts.add("github.com");
		return [...hosts].sort();
	}

	/** The remote without credentials; an ssh or scp-like remote of a configured host becomes its https URL. */
	normalize(url: string): string {
		return normalizeRemote(url, this.hosts());
	}

	/**
	 * Whether the service holds a credential for the remote's host and can fetch it: over https, or over plain http only on a
	 * loopback host (a credential over plain http elsewhere would cross the network in clear text).
	 */
	canFetch(url: string): boolean {
		const normalized = this.normalize(url);
		if (!this.hosts().includes(remoteHostOf(normalized))) return false;
		return normalized.startsWith("https://") || (normalized.startsWith("http://") && isLoopbackUrl(normalized));
	}

	/**
	 * Takes in a delta handoff: fetches `baseRef` (then the bare `baseCommit`) into the remote's cache, checks the
	 * source bundle (`sourcePath`, null when the handoff is the base itself) applies on it and holds the thread's
	 * handoff ref `refs/omp-cloud/threads/<id>/handoff`. Throws `GitError` (`base`: the base is not on the remote;
	 * `source`: the bundle is wrong), `Error` for local failures.
	 */
	async prepare(threadId: string, repo: RepoRef, sourcePath: string | null): Promise<void> {
		const url = this.normalize(repo.remoteURL);
		if (!this.canFetch(url)) throw new GitError("base", `the service has no git credentials for ${remoteHostOf(repo.remoteURL) || repo.remoteURL}`);
		const cache = this.#cachePath(url);
		await this.#locked(cache, async () => {
			await this.#ensureCache(cache);
			try {
				await this.#fetchBase(cache, url, repo);
			} catch (error) {
				// A credential that cannot be had means the base cannot be fetched: the handoff may still ship its whole history.
				if (error instanceof SecretError) throw new GitError("base", `the base commit ${repo.baseCommit} is not on ${url} (${error.message})`);
				throw error;
			}
			const handoffRef = threadRef(threadId);
			if (sourcePath === null) {
				if (repo.handoffCommit !== repo.baseCommit) throw new GitError("source", "the source part is required when the handoff has commits beyond the base");
				await this.#ok(["update-ref", handoffRef, repo.baseCommit], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
			} else {
				const bundle = resolve(sourcePath);
				const verified = await this.#run(["bundle", "verify", bundle], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
				if (verified.code !== 0) throw new GitError("source", `the source bundle does not apply on the base commit: ${reasonOf(verified.stderr)}`);
				const fetched = await this.#run(["fetch", "--quiet", "--no-tags", bundle, `+${HANDOFF_REF}:${handoffRef}`], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
				if (fetched.code !== 0) throw new GitError("source", `the source bundle is unusable: ${reasonOf(fetched.stderr)}`);
				const got = (await this.#ok(["rev-parse", "--verify", `${handoffRef}^{commit}`], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS })).trim();
				if (got !== repo.handoffCommit) throw new GitError("source", `the uploaded source is at ${got}, not the handoff commit ${repo.handoffCommit}`);
			}
			const descends = await this.#run(["merge-base", "--is-ancestor", repo.baseCommit, repo.handoffCommit], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
			if (descends.code !== 0) throw new GitError("source", "the handoff commit does not descend from the base commit");
			await this.#run(["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
		});
	}

	/**
	 * A bundle holding the whole history up to the thread's handoff commit as `refs/omp-cloud/handoff`: what the VM
	 * restores its repository from. The caller releases it. Throws `Error` when the cache does not hold the thread.
	 */
	async composeSource(threadId: string, remoteURL: string): Promise<ComposedSource> {
		const cache = this.#cachePath(this.normalize(remoteURL));
		const dir = await mkdtemp(join(this.#tmpDir, "compose-"));
		const path = join(dir, "source.bundle");
		try {
			await this.#locked(cache, async () => {
				const cached = await Bun.file(join(cache, "HEAD")).exists();
				const found = cached ? await this.#run(["rev-parse", "--verify", "--quiet", `${threadRef(threadId)}^{commit}`], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS }) : null;
				if (found === null || found.code !== 0) throw new Error(`the git cache holds no handoff of thread ${threadId}`);
				// A scratch repository that borrows the cache's objects names the commit as the ref the VM fetches.
				const scratch = join(dir, "scratch.git");
				await this.#ok(["init", "--bare", "--quiet", scratch], { timeoutMs: LOCAL_TIMEOUT_MS });
				await writeFile(join(scratch, "objects", "info", "alternates"), `${join(cache, "objects")}\n`);
				await this.#ok(["update-ref", HANDOFF_REF, found.stdout.trim()], { cwd: scratch, timeoutMs: LOCAL_TIMEOUT_MS });
				await this.#ok(["bundle", "create", "--quiet", path, HANDOFF_REF], { cwd: scratch, timeoutMs: LOCAL_TIMEOUT_MS });
			});
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			throw error;
		}
		return { path, release: () => rm(dir, { recursive: true, force: true }) };
	}

	/**
	 * Synthesizes the base of a scratch thread: an empty repository with one empty commit (committed as
	 * `omp-cloud <omp-cloud@localhost>`), bundled as `refs/omp-cloud/handoff`. The caller releases it.
	 */
	async scratchSource(): Promise<ScratchSource> {
		const dir = await mkdtemp(join(this.#tmpDir, "scratch-"));
		const path = join(dir, "source.bundle");
		try {
			const repo = join(dir, "scratch.git");
			await this.#ok(["init", "--bare", "--quiet", repo], { timeoutMs: LOCAL_TIMEOUT_MS });
			const identity = ["-c", "user.name=omp-cloud", "-c", "user.email=omp-cloud@localhost"];
			const tree = (await this.#ok(["mktree"], { cwd: repo, timeoutMs: LOCAL_TIMEOUT_MS })).trim();
			const commit = (await this.#ok([...identity, "commit-tree", tree, "-m", "omp-cloud scratch"], { cwd: repo, timeoutMs: LOCAL_TIMEOUT_MS })).trim();
			await this.#ok(["update-ref", HANDOFF_REF, commit], { cwd: repo, timeoutMs: LOCAL_TIMEOUT_MS });
			await this.#ok(["bundle", "create", "--quiet", path, HANDOFF_REF], { cwd: repo, timeoutMs: LOCAL_TIMEOUT_MS });
			return { path, commit, release: () => rm(dir, { recursive: true, force: true }) };
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			throw error;
		}
	}

	/**
	 * Runs `read` over a scratch repository that holds the thread's base (its handoff commit: from the cache's thread ref
	 * for a delta thread, under the cache's lock, else from `source.bundle`) and, when there is one, its stored result
	 * bundle's branch. Nothing is fetched from a remote and nothing is written to the cache. Throws `InspectError`
	 * (`base`: the base is not available; `result`: the result bundle is unusable), `Error` for local failures.
	 */
	async inspect<T>(source: InspectSource, read: (inspection: Inspection) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(this.#tmpDir, "inspect-"));
		const repo = join(dir, "repo.git");
		const home = join(dir, "home");
		const local = { cwd: repo, timeoutMs: LOCAL_TIMEOUT_MS };
		const inspect = async (): Promise<T> => {
			await this.#ok(["init", "--bare", "--quiet", repo], { timeoutMs: LOCAL_TIMEOUT_MS });
			await mkdir(home);
			await this.#loadBase(source, repo, local);
			if (source.resultBundle !== null) {
				const fetched = await this.#run(["fetch", "--quiet", "--no-tags", resolve(source.resultBundle), `+refs/heads/${source.resultBranch}:${INSPECT_RESULT_REF}`], local);
				if (fetched.code !== 0) throw new InspectError("result", `the stored result bundle is unusable: ${reasonOf(fetched.stderr)}`);
			}
			return read(new Inspection(this.#git, repo, home));
		};
		try {
			return source.baseCommit === "" ? await inspect() : await this.#locked(this.#cachePath(this.normalize(source.remoteURL)), inspect);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	/**
	 * Re-signs the commits the VM made in its latest turn. A scratch repository is built as `inspect` builds one (the
	 * thread's base, then `input.resultBundle`'s branch); only the commits past `input.uploadedHead` (else the handoff
	 * commit) are rewritten, so commits an earlier turn exposed keep their ids. Returns null when nothing was rewritten,
	 * else a bundle of the signed branch (against `input.baseCommit` when there is one) that the caller adopts and stores;
	 * `dispose` deletes it. Throws `Error` when the base or the bundle is unusable.
	 */
	async signResult(threadId: string, input: SignInput): Promise<SignedResult | null> {
		const dir = await mkdtemp(join(this.#tmpDir, "sign-"));
		const repo = join(dir, "repo.git");
		const local = { cwd: repo, timeoutMs: LOCAL_TIMEOUT_MS };
		const raw: RawGit = async (args, opts) => {
			const done = await this.#runRaw(args, { cwd: opts.cwd, input: opts.input, timeoutMs: LOCAL_TIMEOUT_MS });
			if (done.code !== 0) throw new Error(`git ${args[0]} failed: ${reasonOf(done.stderr)}`);
			return done.stdout;
		};
		const sign = async (): Promise<SignedResult | null> => {
			await this.#ok(["init", "--bare", "--quiet", repo], { timeoutMs: LOCAL_TIMEOUT_MS });
			const source: InspectSource = { threadId, remoteURL: input.remoteURL, baseCommit: input.baseCommit, sourceBundle: input.sourceBundle, resultBundle: input.resultBundle, resultBranch: input.branch };
			await this.#loadBase(source, repo, local);
			const ref = `refs/heads/${input.branch}`;
			const fetched = await this.#run(["fetch", "--quiet", "--no-tags", resolve(input.resultBundle), `+${ref}:${ref}`], local);
			if (fetched.code !== 0) throw new Error(`the result bundle is unusable: ${reasonOf(fetched.stderr)}`);
			const signed = await rewriteSigned(raw, {
				repo,
				base: input.uploadedHead || input.handoffCommit,
				head: input.head,
				privatePem: input.privatePem,
				committer: input.committer,
			});
			if (signed.rewritten === 0) return null;
			await this.#ok(["update-ref", ref, signed.head], local);
			const bundlePath = join(dir, "signed.bundle");
			await this.#ok(["bundle", "create", "--quiet", bundlePath, ref, ...(input.baseCommit === "" ? [] : [`^${input.baseCommit}`])], local);
			return { bundlePath, head: signed.head, rewritten: signed.rewritten, dispose: () => rm(dir, { recursive: true, force: true }) };
		};
		try {
			const result = input.baseCommit === "" ? await sign() : await this.#locked(this.#cachePath(this.normalize(input.remoteURL)), sign);
			if (result === null) await rm(dir, { recursive: true, force: true });
			return result;
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			throw error;
		}
	}

	/** Puts the thread's handoff commit into the inspection repository as `refs/omp-cloud/base`. */
	async #loadBase(source: InspectSource, repo: string, local: { cwd: string; timeoutMs: number }): Promise<void> {
		if (source.baseCommit === "") {
			if (source.sourceBundle === null) throw new InspectError("base", "the thread's source bundle is not stored");
			const fetched = await this.#run(["fetch", "--quiet", "--no-tags", resolve(source.sourceBundle), `+${HANDOFF_REF}:${INSPECT_BASE_REF}`], local);
			if (fetched.code !== 0) throw new InspectError("base", `the thread's source bundle is unusable: ${reasonOf(fetched.stderr)}`);
			return;
		}
		const cache = this.#cachePath(this.normalize(source.remoteURL));
		const found = (await Bun.file(join(cache, "HEAD")).exists())
			? await this.#run(["rev-parse", "--verify", "--quiet", `${threadRef(source.threadId)}^{commit}`], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS })
			: null;
		if (found === null || found.code !== 0) throw new InspectError("base", "the git cache holds no handoff of this thread");
		await writeFile(join(repo, "objects", "info", "alternates"), `${join(cache, "objects")}\n`);
		await this.#ok(["update-ref", INSPECT_BASE_REF, found.stdout.trim()], local);
	}

	/** Why `target` may not be pushed to `remoteURL` whatever the remote says (no credential for its host, a protected branch), or null. */
	pushRefusal(remoteURL: string, target: string, protectedPatterns: readonly string[]): string | null {
		if (!this.canFetch(remoteURL)) return `the service has no git credentials for ${remoteHostOf(remoteURL) || remoteURL}`;
		if (isProtected(target, protectedPatterns)) return `refusing to push to protected branch ${target}`;
		return null;
	}

	/**
	 * Publishes a thread's result: `input.head` becomes `input.target` on the remote, never by force. It refuses (no
	 * network write) a host without a credential, a protected branch and the remote's default branch, then loads the
	 * result bundle into the cache, checks it holds `input.head` and pushes. Never throws: whatever stops the push comes
	 * back as `error`, scrubbed of credentials.
	 */
	async push(threadId: string, input: PushInput): Promise<PushOutcome> {
		const refusal = this.pushRefusal(input.remoteURL, input.target, input.protectedPatterns);
		if (refusal !== null) return { pushed: false, error: refusal, defaultBranch: "" };
		const url = this.normalize(input.remoteURL);
		const { target } = input;
		const cache = this.#cachePath(url);
		try {
			return await this.#locked(cache, async (): Promise<PushOutcome> => {
				await this.#ensureCache(cache);
				const local = { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS };
				const remote = { cwd: cache, remote: url, timeoutMs: this.#pushTimeoutMs };
				const valid = await this.#run(["check-ref-format", `refs/heads/${target}`], local);
				if (valid.code !== 0) return { pushed: false, error: `${JSON.stringify(target.slice(0, 100))} is not a branch name`, defaultBranch: "" };
				const head = await this.#run(["ls-remote", "--symref", url, "HEAD"], remote);
				if (head.code !== 0) return { pushed: false, error: pushFailure(head, url, target, this.#pushTimeoutMs), defaultBranch: "" };
				const defaultRef = /^ref: (\S+)\s+HEAD$/m.exec(head.stdout)?.[1];
				const defaultBranch = defaultRef?.startsWith("refs/heads/") === true ? defaultRef.slice("refs/heads/".length) : "";
				if (defaultRef === `refs/heads/${target}`) {
					return { pushed: false, error: `refusing to push to ${target}, the default branch of ${url}`, defaultBranch };
				}
				const resultRef = `refs/omp-cloud/threads/${threadId}/result`;
				const fetched = await this.#run(["fetch", "--quiet", "--no-tags", resolve(input.bundlePath), `+refs/heads/${input.localBranch}:${resultRef}`], local);
				if (fetched.code !== 0) return { pushed: false, error: `the result bundle is unusable: ${reasonOf(fetched.stderr)}`, defaultBranch };
				const got = (await this.#ok(["rev-parse", "--verify", `${resultRef}^{commit}`], local)).trim();
				if (got !== input.head) return { pushed: false, error: `the result bundle is at ${got}, not ${input.head}`, defaultBranch };
				const pushed = await this.#run(["push", "--porcelain", url, `${input.head}:refs/heads/${target}`], remote);
				if (pushed.code !== 0) return { pushed: false, error: pushFailure(pushed, url, target, this.#pushTimeoutMs), defaultBranch };
				return { pushed: true, error: "", defaultBranch };
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { pushed: false, error: `git push failed: ${scrub(reason, []).slice(0, MAX_REASON_CHARS)}`, defaultBranch: "" };
		}
	}

	/** Drops the thread's refs from every cache and lets git collect what only they held. */
	async forget(threadId: string): Promise<void> {
		let names: string[];
		try {
			names = await readdir(this.#cacheDir);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const name of names.filter(n => n.endsWith(".git"))) {
			const cache = join(this.#cacheDir, name);
			await this.#locked(cache, async () => {
				const listed = await this.#ok(["for-each-ref", "--format=%(refname)", `refs/omp-cloud/threads/${threadId}/`], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
				const refs = listed.split("\n").filter(ref => ref !== "");
				for (const ref of refs) await this.#ok(["update-ref", "-d", ref], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
				if (refs.length > 0) await this.#run(["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet", "--prune=now"], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
			});
		}
	}

	/** `<dataDir>/git/cache/<sha256 of the normalized remote>.git` */
	#cachePath(url: string): string {
		return join(this.#cacheDir, `${new Bun.CryptoHasher("sha256").update(url).digest("hex")}.git`);
	}

	async #ensureCache(cache: string): Promise<void> {
		if (await Bun.file(join(cache, "HEAD")).exists()) return;
		await this.#ok(["init", "--bare", "--quiet", cache], { timeoutMs: LOCAL_TIMEOUT_MS });
	}

	/** Runs `fn` after every earlier operation on the same cache finished. */
	async #locked<T>(cache: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.#chains.get(cache) ?? Promise.resolve()).then(fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.#chains.set(cache, tail);
		try {
			return await run;
		} finally {
			if (this.#chains.get(cache) === tail) this.#chains.delete(cache);
		}
	}

	/** Brings `repo.baseCommit` into the cache: its branch first, then the bare commit when the branch no longer has it. */
	async #fetchBase(cache: string, url: string, repo: RepoRef): Promise<void> {
		const branch = `refs/heads/${repo.baseRef}`;
		const valid = await this.#run(["check-ref-format", branch], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS });
		if (valid.code !== 0) throw new GitError("base", `repo.baseRef ${JSON.stringify(repo.baseRef.slice(0, 100))} is not a branch name`);
		const options = { cwd: cache, remote: url, timeoutMs: this.#fetchTimeoutMs };
		const byBranch = await this.#run(["fetch", "--quiet", "--no-tags", url, `+${branch}:refs/omp-cloud/base/${repo.baseRef}`], options);
		let reason = byBranch.code === 0 ? "" : reasonOf(byBranch.stderr);
		const has = async (): Promise<boolean> =>
			(await this.#run(["cat-file", "-e", `${repo.baseCommit}^{commit}`], { cwd: cache, timeoutMs: LOCAL_TIMEOUT_MS })).code === 0;
		if (await has()) return;
		const byCommit = await this.#run(["fetch", "--quiet", "--no-tags", url, repo.baseCommit], options);
		if (byCommit.code !== 0 && reason === "") reason = reasonOf(byCommit.stderr);
		if (await has()) return;
		const why = reason === "" || REF_NOT_FOUND.test(reason) ? "" : ` (${reason})`;
		throw new GitError("base", `the base commit ${repo.baseCommit} is not on ${url}${why}`);
	}

	/** Runs git and returns its stdout; a non-zero exit throws `Error` with git's scrubbed last line. */
	async #ok(args: string[], options: RunOptions): Promise<string> {
		const result = await this.#run(args, options);
		if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${reasonOf(result.stderr)}`);
		return result.stdout;
	}

	/** Runs git for the network and the cache: scrubbed text out, the credential of the remote's host (or the GitHub App) when `options.remote` is set. */
	async #run(args: string[], options: RunOptions): Promise<Run> {
		const home = await mkdtemp(join(this.#tmpDir, "run-"));
		const env = this.#env(home);
		const config: string[] = [];
		const secrets: string[] = [];
		try {
			if (options.remote !== undefined) {
				env.GIT_ALLOW_PROTOCOL = "http:https";
				// A stalled server: the remote helper outlives a killed git, so it must give up on its own.
				env.GIT_HTTP_LOW_SPEED_LIMIT = "1";
				env.GIT_HTTP_LOW_SPEED_TIME = String(Math.max(1, Math.min(60, Math.ceil(options.timeoutMs / 1000))));
				const host = remoteHostOf(options.remote);
				const entry = this.#hosts[host];
				const protocol = new URL(options.remote).protocol.slice(0, -1);
				let credential: { username: string; token: string } | null = null;
				const github = host === "github.com" && this.#github?.connected() === true ? githubRepoOf(options.remote) : null;
				if (github !== null && this.#github !== undefined) {
					try {
						credential = { username: "x-access-token", token: await this.#github.tokenFor(github.owner, github.repo) };
					} catch (error) {
						// Without the App on this repository a configured token for github.com still serves; every other failure stops the call.
						if (!(error instanceof GitHubAppNotInstalled && entry !== undefined)) {
							const reason = error instanceof Error ? error.message : String(error);
							return { code: 128, stdout: "", stderr: `fatal: ${scrub(reason, []).slice(0, MAX_REASON_CHARS)}` };
						}
					}
				}
				if (credential === null && entry !== undefined && (protocol === "https" || isLoopbackUrl(options.remote))) {
					credential = { username: entry.username, token: await this.#secrets.resolve(entry.credential, host) };
				}
				if (credential !== null) {
					secrets.push(credential.token);
					const helper = await writeCredentialHelper(home, { protocol, host, username: credential.username, token: credential.token });
					config.push("-c", "credential.helper=", "-c", `credential.helper=!${shellQuote(helper)}`);
				}
			}
			const done = await this.#spawn(args, env, options, config);
			return { code: done.code, stdout: scrub(new TextDecoder().decode(done.stdout), secrets), stderr: scrub(done.stderr, secrets) };
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	/**
	 * Runs local git with bytes in and out, for the commit rewrite: the fixed environment of `#run`, no credentials,
	 * and stdout is returned as it is (a commit's bytes must not be scrubbed or decoded).
	 */
	async #runRaw(args: string[], options: { cwd: string; input?: Uint8Array; timeoutMs: number }): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
		const home = await mkdtemp(join(this.#tmpDir, "run-"));
		try {
			return await this.#spawn(args, this.#env(home), options);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}

	/** The environment of every git call: a private HOME, no system or global config, no prompts. */
	#env(home: string): Record<string, string> {
		return {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: home,
			LC_ALL: "C",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		};
	}

	/** Spawns git and waits at most `options.timeoutMs`; a call that outlives it is killed and answers exit code 124. */
	async #spawn(
		args: string[],
		env: Record<string, string>,
		options: { cwd?: string; input?: Uint8Array; timeoutMs: number },
		config: string[] = [],
	): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
		const proc = Bun.spawn([this.#git, ...config, ...args], { cwd: options.cwd, env, stdin: options.input ?? "ignore", stdout: "pipe", stderr: "pipe" });
		const output = Promise.all([new Response(proc.stdout).bytes(), proc.stderr.text(), proc.exited]);
		// Read errors after the deadline have nobody to report to.
		output.catch(() => undefined);
		let timer: Timer | undefined;
		// git-remote-https and index-pack inherit the pipes and outlive a killed git: the deadline must not wait for them.
		const deadline = new Promise<null>(resolve => {
			timer = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve(null);
			}, options.timeoutMs);
		});
		try {
			const done = await Promise.race([output, deadline]);
			if (done === null) return { code: 124, stdout: new Uint8Array(), stderr: `git ${args[0]} timed out after ${options.timeoutMs / 1000} s` };
			const [stdout, stderr, code] = done;
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	}
}

/** The cache ref that holds a thread's handoff commit. */
function threadRef(threadId: string): string {
	return `refs/omp-cloud/threads/${threadId}/handoff`;
}

/** Whether the URL's host is the loopback interface, where plain http never crosses a network. */
function isLoopbackUrl(url: string): boolean {
	const host = new URL(url).hostname;
	return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
