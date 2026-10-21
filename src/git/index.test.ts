import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitHttpServer, serveGitHttp } from "../../test/git-http";
import { GitError, GitService, type PushInput } from "./index";

setDefaultTimeout(60_000);

const TOKEN = "tok-SECRET-4f9a1c";
const ID = "aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbbbbbb";

let root: string;
let remotes: string;
let work: string;
let server: GitHttpServer;
let base: string;

/** Runs git in `cwd` with the developer's own configuration out of the way; returns trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: root,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
	return out.trim();
}

async function commit(cwd: string, file: string, content: string): Promise<string> {
	await writeFile(join(cwd, file), content);
	await git(cwd, "add", file);
	await git(cwd, "commit", "-q", "-m", `add ${file}`);
	return git(cwd, "rev-parse", "HEAD");
}

/** A delta bundle of `refs/omp-cloud/handoff` at `tip`, on top of `prerequisite` (none: the whole history). */
async function bundleOf(tip: string, prerequisite: string | null): Promise<string> {
	const path = join(await mkdtemp(join(root, "bundle-")), "source.bundle");
	await git(work, "update-ref", "refs/omp-cloud/handoff", tip);
	await git(work, "bundle", "create", path, "refs/omp-cloud/handoff", ...(prerequisite === null ? [] : [`^${prerequisite}`]));
	return path;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-cloud-git-"));
	remotes = join(root, "remotes");
	work = join(root, "work");
	await mkdir(remotes);
	await git(root, "init", "-q", "--bare", "-b", "main", join(remotes, "app.git"));
	await git(root, "init", "-q", "-b", "main", work);
	await commit(work, "a.txt", "one\n");
	base = await commit(work, "b.txt", "two\n");
	await git(work, "push", "-q", join(remotes, "app.git"), "main");
	server = serveGitHttp({ root: remotes, password: TOKEN });
});

afterAll(async () => {
	await server.stop();
	await rm(root, { recursive: true, force: true });
});

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(root, "data-"));
	server.requests.length = 0;
	await git(work, "reset", "-q", "--hard", base);
});

function open(over: { token?: string; gitBinary?: string; pushTimeoutSeconds?: number; fetchTimeoutSeconds?: number } = {}): Promise<GitService> {
	return GitService.open({
		dataDir,
		hosts: {
			[server.host]: { credential: `!printf %s ${over.token ?? TOKEN}`, username: "x-access-token" },
			"github.com": { credential: "!echo unused", username: "x-access-token" },
		},
		fetchTimeoutSeconds: over.fetchTimeoutSeconds ?? 30,
		pushTimeoutSeconds: over.pushTimeoutSeconds ?? 30,
		gitBinary: over.gitBinary,
	});
}

const repoOf = (handoffCommit: string, baseCommit = base) => ({ remoteURL: server.url("app"), baseRef: "main", baseCommit, handoffCommit });

async function expectGitError(promise: Promise<unknown>, code: "base" | "source"): Promise<GitError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(GitError);
	expect((error as GitError).code).toBe(code);
	return error as GitError;
}

describe("hosts, normalize, canFetch", () => {
	test("hosts are the configured keys, sorted", async () => {
		expect((await open()).hosts()).toEqual([server.host, "github.com"]);
	});

	test("canFetch needs a configured host over http(s), after normalizing ssh forms", async () => {
		const service = await open();
		expect(service.canFetch(server.url("app"))).toBe(true);
		expect(service.canFetch("https://github.com/acme/app.git")).toBe(true);
		expect(service.canFetch("git@github.com:acme/app.git")).toBe(true);
		expect(service.canFetch("ssh://git@github.com/acme/app.git")).toBe(true);
		expect(service.canFetch("git@gitlab.com:acme/app.git")).toBe(false);
		expect(service.canFetch("https://evil.example/app.git")).toBe(false);
		expect(service.canFetch("/srv/git/app.git")).toBe(false);
		expect(service.canFetch("https://constructor/app.git")).toBe(false);
		// A credential never travels over plain http, except to the loopback interface (the test server).
		expect(service.canFetch("http://github.com/acme/app.git")).toBe(false);
	});

	test("a fetch from a server that stalls gives up at the deadline, even when a helper keeps git's pipes open", async () => {
		// The child inherits stderr and outlives the killed git, as git-remote-https does against a stalled server.
		const wrapper = join(root, "git-stalled-fetch.sh");
		await writeFile(wrapper, `#!/bin/sh\ncase " $* " in *" fetch "*) (sleep 8 >&2 &); exec sleep 30;; esac\nexec git "$@"\n`);
		await chmod(wrapper, 0o700);
		const service = await open({ gitBinary: wrapper, fetchTimeoutSeconds: 1 });
		const started = Date.now();
		const error = await expectGitError(service.prepare(ID, repoOf(base), null), "base");
		expect(error.message).toContain("timed out after 1 s");
		// Two fetches (the branch, then the commit), each cut at its 1 s deadline: nowhere near the helper's 8 s.
		expect(Date.now() - started).toBeLessThan(6000);
		expect(await readdir(join(dataDir, "git", "tmp"))).toEqual([]);
	}, 20_000);

	test("normalize turns configured ssh remotes into https and strips userinfo", async () => {
		const service = await open();
		expect(service.normalize("git@github.com:acme/app.git")).toBe("https://github.com/acme/app.git");
		expect(service.normalize("https://user:pw@github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
	});
});

describe("prepare and composeSource over authenticated http", () => {
	test("a delta handoff becomes a full-history bundle of refs/omp-cloud/handoff", async () => {
		const service = await open();
		const c1 = await commit(work, "c.txt", "three\n");
		const source = await bundleOf(c1, base);

		await service.prepare(ID, repoOf(c1), source);
		const composed = await service.composeSource(ID, server.url("app"));
		try {
			expect(await git(work, "bundle", "list-heads", composed.path)).toBe(`${c1} refs/omp-cloud/handoff`);
			const fresh = await mkdtemp(join(root, "fresh-"));
			await git(fresh, "init", "-q");
			await git(fresh, "bundle", "verify", composed.path);
			await git(fresh, "fetch", "-q", composed.path, "refs/omp-cloud/handoff");
			expect(await git(fresh, "rev-parse", "FETCH_HEAD")).toBe(c1);
			expect(await git(fresh, "rev-list", "--count", "FETCH_HEAD")).toBe("3");
			expect(await git(fresh, "show", "FETCH_HEAD:a.txt")).toBe("one");
		} finally {
			await composed.release();
		}
		expect(await Bun.file(composed.path).exists()).toBe(false);
	});

	test("a handoff at the base needs no source", async () => {
		const service = await open();
		await service.prepare(ID, repoOf(base), null);
		const composed = await service.composeSource(ID, server.url("app"));
		try {
			expect(await git(work, "bundle", "list-heads", composed.path)).toBe(`${base} refs/omp-cloud/handoff`);
		} finally {
			await composed.release();
		}
	});

	test("the cache is one bare repository per remote, named by the hash of its URL", async () => {
		const service = await open();
		await service.prepare(ID, repoOf(base), null);
		await service.prepare(OTHER_ID, repoOf(base), null);
		const hash = new Bun.CryptoHasher("sha256").update(server.url("app")).digest("hex");
		expect(await readdir(join(dataDir, "git", "cache"))).toEqual([`${hash}.git`]);
		const refs = await git(join(dataDir, "git", "cache", `${hash}.git`), "for-each-ref", "--format=%(refname)");
		expect(refs.split("\n").sort()).toEqual([
			"refs/omp-cloud/base/main",
			`refs/omp-cloud/threads/${ID}/handoff`,
			`refs/omp-cloud/threads/${OTHER_ID}/handoff`,
		]);
	});

	test("the remote moving on does not matter: the base stays reachable from the branch", async () => {
		const service = await open();
		const c1 = await commit(work, "c.txt", "three\n");
		const source = await bundleOf(c1, base);
		await git(work, "push", "-q", join(remotes, "app.git"), "main");
		await commit(work, "d.txt", "four\n");
		await git(work, "push", "-q", join(remotes, "app.git"), "main");
		try {
			await service.prepare(ID, repoOf(c1), source);
		} finally {
			// Put the shared remote back: other tests build commits that must not exist on it.
			await git(work, "push", "-q", "-f", join(remotes, "app.git"), `${base}:refs/heads/main`);
		}
	});

	test("two threads of one remote prepare at the same time", async () => {
		const service = await open();
		await Promise.all([service.prepare(ID, repoOf(base), null), service.prepare(OTHER_ID, repoOf(base), null)]);
		for (const id of [ID, OTHER_ID]) {
			const composed = await service.composeSource(id, server.url("app"));
			await composed.release();
		}
	});

	test("forget drops the thread's refs and only those", async () => {
		const service = await open();
		await service.prepare(ID, repoOf(base), null);
		await service.prepare(OTHER_ID, repoOf(base), null);
		await service.forget(ID);
		await expect(service.composeSource(ID, server.url("app"))).rejects.toThrow(`holds no handoff of thread ${ID}`);
		const composed = await service.composeSource(OTHER_ID, server.url("app"));
		await composed.release();
		await service.forget("cccccccccccc");
	});

	test("forget works before any cache exists", async () => {
		await (await open()).forget(ID);
	});

	test("the compose scratch space is removed when composing fails", async () => {
		const service = await open();
		await expect(service.composeSource(ID, server.url("app"))).rejects.toThrow();
		expect(await readdir(join(dataDir, "git", "tmp"))).toEqual([]);
	});
});

describe("refusals", () => {
	test("a base commit the remote does not have is a base error naming it and the remote", async () => {
		const service = await open();
		const missing = "1234567890abcdef1234567890abcdef12345678";
		const error = await expectGitError(service.prepare(ID, repoOf(base, missing), null), "base");
		expect(error.message).toStartWith(`the base commit ${missing} is not on ${server.url("app")}`);
	});

	test("an invalid branch name is refused before any network call", async () => {
		const service = await open();
		await expectGitError(service.prepare(ID, { ...repoOf(base), baseRef: "a..b" }, null), "base");
		expect(server.requests).toEqual([]);
	});

	test("wrong credentials are a base error that never shows the token", async () => {
		const service = await open({ token: "wrong-token-xyz" });
		const error = await expectGitError(service.prepare(ID, repoOf(base), null), "base");
		expect(error.message).toContain("is not on");
		expect(error.message).not.toContain("wrong-token-xyz");
		expect(error.message).not.toContain(TOKEN);
	});

	test("a credential command that fails is a base error too, without its output", async () => {
		const service = await GitService.open({
			dataDir,
			hosts: { [server.host]: { credential: "!echo leaked-stdout; exit 2", username: "x-access-token" } },
			fetchTimeoutSeconds: 30,
			pushTimeoutSeconds: 30,
		});
		const error = await expectGitError(service.prepare(ID, repoOf(base), null), "base");
		expect(error.message).toContain("failed (exit 2)");
		expect(error.message).not.toContain("leaked-stdout");
	});

	test("a host without a credential is refused", async () => {
		const service = await open();
		const error = await expectGitError(service.prepare(ID, { ...repoOf(base), remoteURL: "https://evil.example/a.git" }, null), "base");
		expect(error.message).toBe("the service has no git credentials for evil.example");
	});

	test("a handoff beyond the base without a source is a source error", async () => {
		const service = await open();
		const c1 = await commit(work, "c.txt", "three\n");
		await expectGitError(service.prepare(ID, repoOf(c1), null), "source");
	});

	test("a bundle whose prerequisite is not on the remote does not apply", async () => {
		const service = await open();
		await commit(work, "c.txt", "three\n");
		const c1 = await git(work, "rev-parse", "HEAD");
		const c2 = await commit(work, "d.txt", "four\n");
		const source = await bundleOf(c2, c1);
		const error = await expectGitError(service.prepare(ID, repoOf(c2), source), "source");
		expect(error.message).toContain("does not apply on the base commit");
	});

	test("a bundle whose head is not the handoff commit is refused", async () => {
		const service = await open();
		const c1 = await commit(work, "c.txt", "three\n");
		const source = await bundleOf(c1, base);
		const error = await expectGitError(service.prepare(ID, repoOf(base), source), "source");
		expect(error.message).toBe(`the uploaded source is at ${c1}, not the handoff commit ${base}`);
	});

	test("a handoff that does not descend from the base is refused", async () => {
		const service = await open();
		await git(work, "checkout", "-q", "--orphan", "other");
		const root2 = await commit(work, "x.txt", "x\n");
		const source = await bundleOf(root2, null);
		await git(work, "checkout", "-q", "-f", "main");
		const error = await expectGitError(service.prepare(ID, repoOf(root2), source), "source");
		expect(error.message).toBe("the handoff commit does not descend from the base commit");
	});

	test("a file that is not a bundle is a source error", async () => {
		const service = await open();
		const junk = join(await mkdtemp(join(root, "junk-")), "source.bundle");
		await writeFile(junk, "not a bundle");
		await expectGitError(service.prepare(ID, repoOf(base), junk), "source");
	});
});

describe("the token", () => {
	test("reaches git only through the credential helper: never argv or the environment, and no scratch file outlives the call", async () => {
		const log = join(root, "git-calls.log");
		const wrapper = join(root, "git-wrapper.sh");
		await writeFile(wrapper, `#!/bin/sh\n{ printf 'ARGV:'; printf ' %s' "$@"; printf '\\n'; env; } >> '${log}'\nexec git "$@"\n`);
		await chmod(wrapper, 0o700);
		await writeFile(log, "");

		const service = await open({ gitBinary: wrapper });
		const c1 = await commit(work, "c.txt", "three\n");
		await service.prepare(ID, repoOf(c1), await bundleOf(c1, base));
		const composed = await service.composeSource(ID, server.url("app"));
		await composed.release();

		const calls = await readFile(log, "utf8");
		expect(calls).toContain("ARGV: -c credential.helper= -c credential.helper=!");
		expect(calls).toContain("GIT_TERMINAL_PROMPT=0");
		expect(calls).toContain("GIT_ALLOW_PROTOCOL=http:https");
		expect(calls).not.toContain(TOKEN);
		// The server did see the token: git asked the helper once the remote answered 401.
		expect(server.requests.some(r => !r.authorized)).toBe(true);
		expect(server.requests.some(r => r.authorized)).toBe(true);
		expect(await readdir(join(dataDir, "git", "tmp"))).toEqual([]);
	});

	test("the scratch directory is private", async () => {
		await open();
		expect((await stat(join(dataDir, "git", "tmp"))).mode & 0o777).toBe(0o700);
	});

	test("open clears the scratch space a crash left behind", async () => {
		await mkdir(join(dataDir, "git", "tmp", "run-leftover"), { recursive: true });
		await writeFile(join(dataDir, "git", "tmp", "run-leftover", "token"), "stale");
		await open();
		expect(await readdir(join(dataDir, "git", "tmp"))).toEqual([]);
	});
});

describe("push", () => {
	let pushCount = 0;
	let bare: string;
	let name: string;

	/** A fresh served remote with `main` at the base commit, so no test sees another's branches. */
	beforeEach(async () => {
		name = `push${++pushCount}`;
		bare = join(remotes, `${name}.git`);
		await git(root, "init", "-q", "--bare", "-b", "main", bare);
		await git(work, "push", "-q", bare, `${base}:refs/heads/main`);
	});

	const urlOf = () => server.url(name);
	const remoteRef = (ref: string) => git(bare, "rev-parse", "--verify", "--quiet", ref);

	/** A branch of the work repo at a new commit on top of `parent`, and a bundle of it (thin on `prerequisite`, else whole). */
	async function result(branch: string, parent: string, file: string, prerequisite: string | null): Promise<{ head: string; bundlePath: string }> {
		await git(work, "checkout", "-q", "-f", "--detach", parent);
		const head = await commit(work, file, `${file}\n`);
		await git(work, "branch", "-q", "-f", branch, head);
		await git(work, "checkout", "-q", "-f", "main");
		const bundlePath = join(await mkdtemp(join(root, "result-")), "result.bundle");
		await git(work, "bundle", "create", bundlePath, `refs/heads/${branch}`, ...(prerequisite === null ? [] : [`^${prerequisite}`]));
		return { head, bundlePath };
	}

	const inputOf = (r: { head: string; bundlePath: string }, over: Partial<PushInput> = {}): PushInput => ({
		remoteURL: urlOf(),
		bundlePath: r.bundlePath,
		localBranch: `omp-cloud/${ID}`,
		head: r.head,
		target: `omp-cloud/${ID}`,
		protectedPatterns: ["main", "release/*"],
		...over,
	});

	test("pushes the result as a new branch and leaves every other branch alone", async () => {
		const service = await open();
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		expect(await service.push(ID, inputOf(r))).toEqual({ pushed: true, error: "" });
		expect(await remoteRef(`refs/heads/omp-cloud/${ID}`)).toBe(r.head);
		expect(await remoteRef("refs/heads/main")).toBe(base);
		expect(server.requests.some(req => req.authorized)).toBe(true);
	});

	test("a second push of a descendant fast-forwards the same branch", async () => {
		const service = await open();
		const first = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		expect((await service.push(ID, inputOf(first))).pushed).toBe(true);
		const second = await result(`omp-cloud/${ID}`, first.head, "r2.txt", null);
		expect(await service.push(ID, inputOf(second))).toEqual({ pushed: true, error: "" });
		expect(await remoteRef(`refs/heads/omp-cloud/${ID}`)).toBe(second.head);
	});

	test("a result bundle that is thin on the base pushes once prepare cached the base", async () => {
		const service = await open();
		await service.prepare(ID, { remoteURL: urlOf(), baseRef: "main", baseCommit: base, handoffCommit: base }, null);
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", base);
		expect(await service.push(ID, inputOf(r))).toEqual({ pushed: true, error: "" });
		expect(await remoteRef(`refs/heads/omp-cloud/${ID}`)).toBe(r.head);
	});

	test("the target is written as given, with {thread}-style names resolved by the caller", async () => {
		const service = await open();
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		expect((await service.push(ID, inputOf(r, { target: "bots/work-1" }))).pushed).toBe(true);
		expect(await remoteRef("refs/heads/bots/work-1")).toBe(r.head);
	});

	test("a protected branch is refused before any network call", async () => {
		const service = await open();
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		const outcome = await service.push(ID, inputOf(r, { target: "release/1.2" }));
		expect(outcome).toEqual({ pushed: false, error: "refusing to push to protected branch release/1.2" });
		expect(server.requests).toEqual([]);
	});

	test("protected globs match the whole name, * standing for any run of characters", async () => {
		const service = await open();
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		const refused = (target: string, patterns: string[]) =>
			service.push(ID, inputOf(r, { target, protectedPatterns: patterns })).then(o => o.error.startsWith("refusing to push to protected branch"));
		expect(await refused("omp-cloud/a/b", ["omp-*/b"])).toBe(true);
		expect(await refused("omp-cloud/a/b", ["*"])).toBe(true);
		expect(await refused("omp-cloud/a/b", ["a.b"])).toBe(false);
		expect(await refused("xmain", ["main"])).toBe(false);
		expect(await refused("main2", ["main"])).toBe(false);
		expect(await refused("axb", ["a.b"])).toBe(false);
	});

	test("the remote's default branch is refused even when it is not protected", async () => {
		const service = await open();
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		const outcome = await service.push(ID, inputOf(r, { target: "main", protectedPatterns: [] }));
		expect(outcome).toEqual({ pushed: false, error: `refusing to push to main, the default branch of ${urlOf()}` });
		expect(await remoteRef("refs/heads/main")).toBe(base);
	});

	test("a branch that moved on the remote is never overwritten", async () => {
		const service = await open();
		const theirs = await result("theirs", base, "theirs.txt", null);
		await git(work, "push", "-q", bare, `${theirs.head}:refs/heads/omp-cloud/${ID}`);
		const mine = await result(`omp-cloud/${ID}`, base, "mine.txt", null);
		const outcome = await service.push(ID, inputOf(mine));
		expect(outcome).toEqual({ pushed: false, error: `omp-cloud/${ID} on ${urlOf()} has commits the result lacks; not force-pushing` });
		expect(await remoteRef(`refs/heads/omp-cloud/${ID}`)).toBe(theirs.head);
	});

	test("wrong credentials fail the push and never show the token", async () => {
		const service = await open({ token: "wrong-token-xyz" });
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		const outcome = await service.push(ID, inputOf(r));
		expect(outcome.pushed).toBe(false);
		expect(outcome.error).toStartWith("git push failed: ");
		expect(outcome.error).not.toContain("wrong-token-xyz");
		expect(outcome.error).not.toContain(TOKEN);
		expect(await remoteRef(`refs/heads/omp-cloud/${ID}`).catch(() => "")).toBe("");
	});

	test("a credential command that fails stops the push without its output", async () => {
		const service = await GitService.open({
			dataDir,
			hosts: { [server.host]: { credential: "!echo leaked-stdout; exit 2", username: "x-access-token" } },
			fetchTimeoutSeconds: 30,
			pushTimeoutSeconds: 30,
		});
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		const outcome = await service.push(ID, inputOf(r));
		expect(outcome.pushed).toBe(false);
		expect(outcome.error).toContain("failed (exit 2)");
		expect(outcome.error).not.toContain("leaked-stdout");
	});

	test("a host without a credential is refused and the remote is never contacted", async () => {
		const service = await open();
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		const outcome = await service.push(ID, inputOf(r, { remoteURL: "https://evil.example/a.git" }));
		expect(outcome).toEqual({ pushed: false, error: "the service has no git credentials for evil.example" });
		expect(server.requests).toEqual([]);
	});

	test("a bundle at another commit than the head is refused", async () => {
		const service = await open();
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		const outcome = await service.push(ID, inputOf(r, { head: base }));
		expect(outcome).toEqual({ pushed: false, error: `the result bundle is at ${r.head}, not ${base}` });
		expect(await remoteRef(`refs/heads/omp-cloud/${ID}`).catch(() => "")).toBe("");
	});

	test("a file that is not a bundle is unusable", async () => {
		const service = await open();
		const junk = join(await mkdtemp(join(root, "junk-")), "result.bundle");
		await writeFile(junk, "not a bundle");
		const outcome = await service.push(ID, inputOf({ head: base, bundlePath: junk }));
		expect(outcome.pushed).toBe(false);
		expect(outcome.error).toStartWith("the result bundle is unusable: ");
	});

	test("a push that takes longer than git.pushTimeoutSeconds is stopped", async () => {
		const wrapper = join(root, "git-slow-push.sh");
		await writeFile(wrapper, `#!/bin/sh\ncase " $* " in *" push "*) exec sleep 20;; esac\nexec git "$@"\n`);
		await chmod(wrapper, 0o700);
		const service = await open({ gitBinary: wrapper, pushTimeoutSeconds: 3 });
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		expect(await service.push(ID, inputOf(r))).toEqual({ pushed: false, error: "git push timed out after 3 s" });
		expect(await readdir(join(dataDir, "git", "tmp"))).toEqual([]);
	});

	test("the token never reaches argv or the environment of git, and the push is never forced", async () => {
		const log = join(root, "git-push-calls.log");
		const wrapper = join(root, "git-push-wrapper.sh");
		await writeFile(wrapper, `#!/bin/sh\n{ printf 'ARGV:'; printf ' %s' "$@"; printf '\\n'; env; } >> '${log}'\nexec git "$@"\n`);
		await chmod(wrapper, 0o700);
		await writeFile(log, "");
		const service = await open({ gitBinary: wrapper });
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		expect((await service.push(ID, inputOf(r))).pushed).toBe(true);

		const calls = await readFile(log, "utf8");
		expect(calls).not.toContain(TOKEN);
		expect(calls).toContain("GIT_TERMINAL_PROMPT=0");
		const pushLine = calls.split("\n").find(line => line.startsWith("ARGV:") && line.includes(" push "));
		expect(pushLine).toContain(`push --porcelain ${urlOf()} ${r.head}:refs/heads/omp-cloud/${ID}`);
		expect(pushLine).not.toContain("--force");
		expect(pushLine).not.toContain(":+");
		expect(pushLine).not.toContain(" +");
		expect(server.requests.some(req => !req.authorized)).toBe(true);
		expect(await readdir(join(dataDir, "git", "tmp"))).toEqual([]);
	});

	test("pushRefusal says what is refused without touching the remote", async () => {
		const service = await open();
		expect(service.pushRefusal(urlOf(), "bots/x", ["main"])).toBeNull();
		expect(service.pushRefusal(urlOf(), "main", ["main"])).toBe("refusing to push to protected branch main");
		expect(service.pushRefusal("git@gitlab.com:acme/app.git", "bots/x", [])).toBe("the service has no git credentials for gitlab.com");
		expect(service.pushRefusal("/srv/git/app.git", "bots/x", [])).toBe("the service has no git credentials for /srv/git/app.git");
		expect(server.requests).toEqual([]);
	});

	test("forget drops the pushed result ref with the thread", async () => {
		const service = await open();
		const r = await result(`omp-cloud/${ID}`, base, "r1.txt", null);
		await service.push(ID, inputOf(r));
		await service.forget(ID);
		const cache = join(dataDir, "git", "cache");
		const [dirName] = await readdir(cache);
		expect(await git(join(cache, dirName ?? ""), "for-each-ref", `refs/omp-cloud/threads/${ID}/`)).toBe("");
	});
});

describe("scratchSource", () => {
	/** Fetches the bundle into a fresh repository; returns that repository. */
	async function unpack(path: string): Promise<string> {
		const repo = await mkdtemp(join(root, "unpack-"));
		await git(repo, "init", "-q");
		await git(repo, "fetch", "-q", path, "+refs/omp-cloud/handoff:refs/omp-cloud/handoff");
		return repo;
	}

	test("bundles one empty commit as refs/omp-cloud/handoff, with the whole history, and names that commit", async () => {
		const service = await open();
		const source = await service.scratchSource();
		try {
			expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
			const repo = await unpack(source.path);
			expect(await git(repo, "rev-parse", "refs/omp-cloud/handoff")).toBe(source.commit);
			expect(await git(repo, "rev-list", "--count", "refs/omp-cloud/handoff")).toBe("1");
			expect(await git(repo, "ls-tree", "-r", "refs/omp-cloud/handoff")).toBe("");
			expect(await git(repo, "log", "-1", "--format=%an <%ae>", "refs/omp-cloud/handoff")).toBe("omp-cloud <omp-cloud@localhost>");
			// A full-history bundle: it has no prerequisites.
			expect(await git(repo, "bundle", "verify", source.path)).toContain("complete history");
		} finally {
			await source.release();
		}
	});

	test("release deletes the bundle, and no thread's refs or caches are involved", async () => {
		const service = await open();
		const source = await service.scratchSource();
		await source.release();
		expect(await Bun.file(source.path).exists()).toBe(false);
		expect(await readdir(join(dataDir, "git", "cache"))).toEqual([]);
		expect(await readdir(join(dataDir, "git", "tmp"))).toEqual([]);
	});

	test("works offline and without any configured host", async () => {
		const service = await GitService.open({ dataDir, hosts: {}, fetchTimeoutSeconds: 1, pushTimeoutSeconds: 1 });
		const source = await service.scratchSource();
		await source.release();
		expect(server.requests).toEqual([]);
	});
});
