import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { threadBranch } from "../src/cards";
import { applyPull, describePull, isClean, pullBundle, type ApplyInput } from "../src/pull";
import { CloudError } from "../src/errors";
import { git, gitRaw } from "../src/snapshot";
import { cleanup, commitFile, configureRepo, remoteFixture, REMOTE_URL, tmp } from "./helpers";

afterEach(cleanup);

const THREAD = "k3x9fa27bq1m";

/** A second clone of the remote plays the cloud pod: it commits on omp-cloud/<thread> and bundles the result. */
async function cloudResult(remoteBare: string, root: string, files: Record<string, string>, bundleName: string) {
	const pod = join(root, `pod-${bundleName}`);
	await git(root, ["clone", "-q", remoteBare, pod]);
	await git(pod, ["config", "user.name", "Cloud"]);
	await git(pod, ["config", "user.email", "cloud@example.com"]);
	await git(pod, ["config", "commit.gpgsign", "false"]);
	await git(pod, ["checkout", "-q", "-b", threadBranch(THREAD)]);
	for (const [p, c] of Object.entries(files)) await commitFile(pod, p, c);
	const bundle = join(root, `${bundleName}.bundle`);
	const base = await git(pod, ["rev-parse", "origin/main"]);
	await git(pod, ["bundle", "create", bundle, `refs/heads/${threadBranch(THREAD)}`, `^${base}`]);
	return { bundle, head: await git(pod, ["rev-parse", "HEAD"]), base, pod };
}

describe("pullBundle", () => {
	test("creates omp-cloud/<thread> from a result bundle without touching the checked-out branch", async () => {
		const f = await remoteFixture();
		const res = await cloudResult(f.bare, f.root, { "hello.txt": "hello\n" }, "r1");
		const before = await git(f.work, ["rev-parse", "HEAD"]);

		const out = await pullBundle({ root: f.work, thread: THREAD, bundlePath: res.bundle, baseCommit: res.base, remote: "origin" });

		expect(out).toEqual({ branch: `omp-cloud/${THREAD}`, head: res.head, checkedOutMoved: false });
		expect(await git(f.work, ["rev-parse", `refs/heads/omp-cloud/${THREAD}`])).toBe(res.head);
		expect(await git(f.work, ["show", `omp-cloud/${THREAD}:hello.txt`])).toBe("hello");
		expect(await git(f.work, ["branch", "--show-current"])).toBe("main");
		expect(await git(f.work, ["rev-parse", "HEAD"])).toBe(before);
	});

	test("fast-forwards the branch when it is checked out, and force-moves it otherwise", async () => {
		const f = await remoteFixture();
		const first = await cloudResult(f.bare, f.root, { "one.txt": "1\n" }, "r1");
		await pullBundle({ root: f.work, thread: THREAD, bundlePath: first.bundle, baseCommit: first.base, remote: "origin" });
		await git(f.work, ["switch", "-q", `omp-cloud/${THREAD}`]);

		// Cloud continues the same branch: a longer result that contains the first.
		await commitFile(first.pod, "two.txt", "2\n");
		const second = join(f.root, "r2.bundle");
		await git(first.pod, ["bundle", "create", second, `refs/heads/omp-cloud/${THREAD}`, `^${first.base}`]);
		const tip = await git(first.pod, ["rev-parse", "HEAD"]);

		await pullBundle({ root: f.work, thread: THREAD, bundlePath: second, baseCommit: first.base, remote: "origin" });
		expect(await git(f.work, ["rev-parse", "HEAD"])).toBe(tip);
		expect(await readFile(join(f.work, "two.txt"), "utf8")).toBe("2\n");

		// From main, the branch is moved with branch -f.
		await git(f.work, ["switch", "-q", "main"]);
		await commitFile(first.pod, "three.txt", "3\n");
		const third = join(f.root, "r3.bundle");
		await git(first.pod, ["bundle", "create", third, `refs/heads/omp-cloud/${THREAD}`, `^${first.base}`]);
		const tip3 = await git(first.pod, ["rev-parse", "HEAD"]);
		await pullBundle({ root: f.work, thread: THREAD, bundlePath: third, baseCommit: first.base, remote: "origin" });
		expect(await git(f.work, ["rev-parse", `refs/heads/omp-cloud/${THREAD}`])).toBe(tip3);
		expect(await git(f.work, ["branch", "--show-current"])).toBe("main");
	});

	test("a branch checked out in another worktree is fast-forwarded there, not moved with branch -f (which git refuses)", async () => {
		const f = await remoteFixture();
		const first = await cloudResult(f.bare, f.root, { "one.txt": "1\n" }, "r1");
		const opts = (bundlePath: string) => ({ root: f.work, thread: THREAD, bundlePath, baseCommit: first.base, remote: "origin" });
		await pullBundle(opts(first.bundle));
		const wt = join(f.root, "wt");
		await git(f.work, ["worktree", "add", wt, `omp-cloud/${THREAD}`]);

		await commitFile(first.pod, "two.txt", "2\n");
		const second = join(f.root, "r2.bundle");
		await git(first.pod, ["bundle", "create", second, `refs/heads/omp-cloud/${THREAD}`, `^${first.base}`]);
		const tip = await git(first.pod, ["rev-parse", "HEAD"]);

		const out = await pullBundle(opts(second));
		expect(out).toEqual({ branch: `omp-cloud/${THREAD}`, head: tip, checkedOutMoved: false, movedIn: wt });
		expect(await git(wt, ["rev-parse", "HEAD"])).toBe(tip);
		expect(await readFile(join(wt, "two.txt"), "utf8")).toBe("2\n");
		expect(await git(f.work, ["branch", "--show-current"])).toBe("main");
		expect((await describePull(f.work, out, f.base)).next).toBe(`omp-cloud/${THREAD} is checked out in ${wt} and was fast-forwarded there`);
	});

	test("a worktree that cannot fast-forward is a conflict naming it, and the branch stays where it was", async () => {
		const f = await remoteFixture();
		const first = await cloudResult(f.bare, f.root, { "one.txt": "1\n" }, "r1");
		const opts = (bundlePath: string) => ({ root: f.work, thread: THREAD, bundlePath, baseCommit: first.base, remote: "origin" });
		await pullBundle(opts(first.bundle));
		const wt = join(f.root, "wt");
		await git(f.work, ["worktree", "add", wt, `omp-cloud/${THREAD}`]);
		await configureRepo(wt);
		const local = await commitFile(wt, "local.txt", "mine\n");

		await commitFile(first.pod, "two.txt", "2\n");
		const second = join(f.root, "r2.bundle");
		await git(first.pod, ["bundle", "create", second, `refs/heads/omp-cloud/${THREAD}`, `^${first.base}`]);
		const err = await pullBundle(opts(second)).then(
			() => undefined,
			(e: unknown) => e,
		);
		if (!(err instanceof CloudError)) throw new Error("expected a CloudError");
		expect(err.code).toBe("conflict");
		expect(err.message).toContain(`omp-cloud/${THREAD} is checked out in ${wt} and cannot fast-forward`);
		expect(await git(f.work, ["rev-parse", `refs/heads/omp-cloud/${THREAD}`])).toBe(local);
	});

	test("a repository that lacks the base commit gets an actionable error", async () => {
		const f = await remoteFixture();
		const res = await cloudResult(f.bare, f.root, { "x.txt": "x\n" }, "r1");
		const other = await tmp();
		await git(other, ["init", "-q", "-b", "main"]);
		await expect(
			pullBundle({ root: other, thread: THREAD, bundlePath: res.bundle, baseCommit: res.base, remote: "origin" }),
		).rejects.toThrow(`your repository lacks the thread's base commit ${res.base}; git fetch origin, then retry`);
	});
});

describe("describePull", () => {
	const BRANCH = `omp-cloud/${THREAD}`;
	const pull = (root: string, bundle: string, base: string) => pullBundle({ root, thread: THREAD, bundlePath: bundle, baseCommit: base, remote: "origin" });

	test("local branch untouched since the handoff: counts the cloud's commits, newest first, and says to fast-forward", async () => {
		const f = await remoteFixture();
		const res = await cloudResult(f.bare, f.root, { "one.txt": "1\n", "two.txt": "2\n" }, "r1");
		const report = await describePull(f.work, await pull(f.work, res.bundle, res.base), f.base);
		expect(report.commits).toBe(2);
		expect(report.subjects).toHaveLength(2);
		expect(report.subjects[0]).toMatch(/^[0-9a-f]{7,} add two\.txt$/);
		expect(report.subjects[1]).toMatch(/^[0-9a-f]{7,} add one\.txt$/);
		expect(report.next).toBe(`git merge --ff-only ${BRANCH}`);
	});

	test("the result branch checked out here: says it was fast-forwarded", async () => {
		const f = await remoteFixture();
		const first = await cloudResult(f.bare, f.root, { "one.txt": "1\n" }, "r1");
		await pull(f.work, first.bundle, first.base);
		await git(f.work, ["switch", "-q", BRANCH]);
		await commitFile(first.pod, "two.txt", "2\n");
		const second = join(f.root, "r2.bundle");
		await git(first.pod, ["bundle", "create", second, `refs/heads/${BRANCH}`, `^${first.base}`]);
		const out = await pull(f.work, second, first.base);
		const report = await describePull(f.work, out, f.base);
		expect(report.commits).toBe(2);
		expect(report.next).toBe(`${BRANCH} is checked out here and was fast-forwarded`);
	});

	test("local branch moved since the handoff: names the cherry-pick range from the handoff commit", async () => {
		const f = await remoteFixture();
		const res = await cloudResult(f.bare, f.root, { "one.txt": "1\n" }, "r1");
		await commitFile(f.work, "local.txt", "moved on\n");
		const report = await describePull(f.work, await pull(f.work, res.bundle, res.base), f.base);
		expect(report.commits).toBe(1);
		expect(report.next).toBe(`the local branch moved since the handoff: git cherry-pick ${f.base.slice(0, 8)}..${BRANCH}`);
		// The advice works: the cloud's commit lands on the moved branch.
		await git(f.work, ["cherry-pick", `${f.base.slice(0, 8)}..${BRANCH}`]);
		expect(await readFile(join(f.work, "one.txt"), "utf8")).toBe("1\n");
		expect(await readFile(join(f.work, "local.txt"), "utf8")).toBe("moved on\n");
	});

	test("a handoff commit this repository does not have: no count, no subjects, and the advice does not name it", async () => {
		const f = await remoteFixture();
		const res = await cloudResult(f.bare, f.root, { "one.txt": "1\n" }, "r1");
		await commitFile(f.work, "local.txt", "moved on\n");
		const report = await describePull(f.work, await pull(f.work, res.bundle, res.base), "0123456789abcdef0123456789abcdef01234567");
		expect(report.commits).toBeUndefined();
		expect(report.subjects).toEqual([]);
		expect(report.next).toBe(`the local branch moved since the handoff: git log --oneline HEAD..${BRANCH}`);
		expect((await describePull(f.work, await pull(f.work, res.bundle, res.base), "")).commits).toBeUndefined();
	});

	test("a long result lists the newest 10 subjects but counts every commit; no new commits is a count of 0", async () => {
		const f = await remoteFixture();
		const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, "0")}.txt`, "x\n"]));
		const res = await cloudResult(f.bare, f.root, files, "r1");
		const report = await describePull(f.work, await pull(f.work, res.bundle, res.base), f.base);
		expect(report.commits).toBe(12);
		expect(report.subjects).toHaveLength(10);
		expect(report.subjects[0]).toEndWith("add f11.txt");
		expect((await describePull(f.work, { branch: BRANCH, head: f.base }, f.base)).commits).toBe(0);
	});
});

describe("isClean", () => {
	test("reports uncommitted and untracked changes", async () => {
		const f = await remoteFixture();
		expect(await isClean(f.work)).toBe(true);
		await writeFile(join(f.work, "new.txt"), "x");
		expect(await isClean(f.work)).toBe(false);
	});
});

describe("pullBundle errors", () => {
	test("a bundle that does not hold the thread's branch is a plain git failure, not the base-commit hint", async () => {
		const f = await remoteFixture();
		const res = await cloudResult(f.bare, f.root, { "x.txt": "x\n" }, "r1");
		await expect(
			pullBundle({ root: f.work, thread: "zzzzzzzzzzzz", bundlePath: res.bundle, baseCommit: res.base, remote: "origin" }),
		).rejects.toThrow(/^git fetch failed: /);
	});

	test("the base-commit hint falls back to origin and omits an unknown commit", async () => {
		const f = await remoteFixture();
		const res = await cloudResult(f.bare, f.root, { "x.txt": "x\n" }, "r1");
		const other = await tmp();
		await git(other, ["init", "-q", "-b", "main"]);
		await expect(pullBundle({ root: other, thread: THREAD, bundlePath: res.bundle, baseCommit: "", remote: "" })).rejects.toThrow(
			"your repository lacks the thread's base commit; git fetch origin, then retry",
		);
	});
});

describe("applyPull", () => {
	const BRANCH = threadBranch(THREAD);

	/** A repository thread's pull input: the cloud's result on top of the fixture's base, which is the handoff commit. */
	async function pullInput(over: Partial<ApplyInput> = {}) {
		const f = await remoteFixture();
		const res = await cloudResult(f.bare, f.root, { "one.txt": "1\n", "two.txt": "2\n" }, "r1");
		const input: ApplyInput = {
			root: f.work,
			cwd: f.work,
			thread: THREAD,
			scratch: false,
			bundlePath: res.bundle,
			identity: { handoffCommit: f.base, baseCommit: res.base, remoteURL: REMOTE_URL },
			apply: "fetch",
			into: undefined,
			force: false,
			...over,
		};
		return { f, res, input };
	}

	const refusal = (p: Promise<unknown>): Promise<CloudError> =>
		p.then(
			() => {
				throw new Error("expected a refusal");
			},
			(e: unknown) => {
				if (!(e instanceof CloudError)) throw e;
				return e;
			},
		);

	const hasBranch = async (root: string): Promise<boolean> => (await gitRaw(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`])).code === 0;

	test("fetch points the branch at the result and says the checked-out branch and the working tree did not move", async () => {
		const { f, res, input } = await pullInput();
		const before = await git(f.work, ["rev-parse", "HEAD"]);
		const out = await applyPull(input);
		expect(out).toMatchObject({ mode: "fetch", branch: BRANCH, head: res.head, path: f.work, checkedOutMoved: false, commits: 2 });
		expect(out.subjects).toHaveLength(2);
		expect(await git(f.work, ["rev-parse", BRANCH])).toBe(res.head);
		expect(await git(f.work, ["rev-parse", "HEAD"])).toBe(before);
		expect(out.next).toBe(`git merge --ff-only ${BRANCH}`);
	});

	test("fetch with the thread branch checked out fast-forwards it and says so", async () => {
		const { f, res, input } = await pullInput();
		await applyPull(input);
		await git(f.work, ["switch", "-q", BRANCH]);
		await git(f.work, ["reset", "-q", "--hard", f.base]);
		const out = await applyPull(input);
		expect(out.checkedOutMoved).toBe(true);
		expect(await git(f.work, ["rev-parse", "HEAD"])).toBe(res.head);
	});

	test("merge fast-forwards the current branch; a dirty tracked file refuses it before anything is fetched, an untracked one does not", async () => {
		const { f, res, input } = await pullInput({ apply: "merge" });
		await writeFile(join(f.work, "a.txt"), "dirty\n");
		const dirty = await refusal(applyPull(input));
		expect(dirty).toMatchObject({ code: "conflict" });
		expect(dirty.message).toBe("the working tree has uncommitted changes");
		expect(dirty.hint).toContain('apply: "fetch"');
		expect(await hasBranch(f.work)).toBe(false);

		await git(f.work, ["checkout", "--", "a.txt"]);
		await writeFile(join(f.work, "untracked.txt"), "u\n");
		const out = await applyPull(input);
		expect(out).toMatchObject({ mode: "merge", checkedOutMoved: true, head: res.head });
		expect(await git(f.work, ["rev-parse", "HEAD"])).toBe(res.head);
		expect(await git(f.work, ["branch", "--show-current"])).toBe("main");
	});

	test("merge into a branch that moved on is refused with the way forward, and the thread branch is still fetched; a detached HEAD is refused", async () => {
		const { f, res, input } = await pullInput({ apply: "merge" });
		await commitFile(f.work, "local.txt", "moved on\n");
		const moved = await refusal(applyPull(input));
		expect(moved.code).toBe("conflict");
		expect(moved.message).toContain("main cannot fast-forward");
		expect(moved.hint).toContain(`${BRANCH} was fetched`);
		expect(await git(f.work, ["rev-parse", BRANCH])).toBe(res.head);

		await git(f.work, ["checkout", "-q", "--detach"]);
		const detached = await refusal(applyPull(input));
		expect(detached.message).toContain("HEAD is detached");
	});

	test("worktree checks the branch out beside the repository by default, or where `into` says; an existing directory or a checked-out branch is refused", async () => {
		const { f, res, input } = await pullInput({ apply: "worktree" });
		const out = await applyPull(input);
		const expected = join(dirname(f.work), `work-${THREAD.slice(-6)}`);
		expect(out).toMatchObject({ mode: "worktree", path: expected, checkedOutMoved: false });
		expect(await git(expected, ["rev-parse", "HEAD"])).toBe(res.head);
		expect(await git(f.work, ["branch", "--show-current"])).toBe("main");
		expect(out.next).toBe(`cd ${expected}; ${BRANCH} is checked out there`);

		await writeFile(join(expected, "x"), "x");
		const taken = await refusal(applyPull(input));
		expect(taken.code).toBe("conflict");
		expect(taken.message).toContain("is not an empty directory");

		await git(f.work, ["worktree", "remove", "--force", expected]);
		await git(f.work, ["branch", "-D", BRANCH]);
		const custom = join(f.root, "elsewhere", "wt");
		const placed = await applyPull({ ...input, into: custom });
		expect(placed.path).toBe(custom);
		expect(await readFile(join(custom, "one.txt"), "utf8")).toBe("1\n");

		await git(f.work, ["worktree", "remove", "--force", custom]);
		await git(f.work, ["switch", "-q", BRANCH]);
		const here = await refusal(applyPull(input));
		expect(here.message).toContain(`${BRANCH} is checked out in ${f.work}`);
	});

	test("a repository that does not contain the handoff commit is refused as the wrong repository, and nothing is fetched into it; force fetches anyway", async () => {
		const { res, input } = await pullInput();
		const other = await tmp();
		await git(other, ["init", "-q", "-b", "main"]);
		await git(other, ["config", "user.name", "T"]);
		await git(other, ["config", "user.email", "t@example.com"]);
		await git(other, ["config", "commit.gpgsign", "false"]);
		await commitFile(other, "z.txt", "z\n");
		const wrong = await refusal(applyPull({ ...input, root: other, cwd: other }));
		expect(wrong.code).toBe("conflict");
		expect(wrong.message).toContain(`does not contain the thread's handoff commit ${input.identity.handoffCommit.slice(0, 8)}`);
		expect(wrong.hint).toContain("force: true");
		expect(await hasBranch(other)).toBe(false);

		// With force the identity is not asked; the fetch itself still fails when the objects are missing.
		await expect(applyPull({ ...input, root: other, cwd: other, force: true })).rejects.toThrow("lacks the thread's base commit");
		expect(res.head).toBeDefined();
	});

	test("pulling a thread again after a worktree pull fast-forwards the worktree instead of failing", async () => {
		const { f, res, input } = await pullInput({ apply: "worktree" });
		const first = await applyPull(input);
		await commitFile(res.pod, "three.txt", "3\n");
		const again = join(f.root, "r2.bundle");
		await git(res.pod, ["bundle", "create", again, `refs/heads/${BRANCH}`, `^${res.base}`]);
		const tip = await git(res.pod, ["rev-parse", "HEAD"]);
		const out = await applyPull({ ...input, apply: "fetch", bundlePath: again });
		expect(out).toMatchObject({ mode: "fetch", head: tip, checkedOutMoved: false, movedIn: first.path });
		expect(await readFile(join(first.path, "three.txt"), "utf8")).toBe("3\n");
		// A second worktree of the same branch is refused, naming the first.
		const second = await refusal(applyPull({ ...input, bundlePath: again, into: join(f.root, "second") }));
		expect(second.message).toBe(`${BRANCH} is checked out in ${first.path}`);
	});

	test("the remote is compared as the service names it: ssh with a port and credentials, scp syntax and https are one repository, in any case", async () => {
		const { f, res, input } = await pullInput();
		for (const url of ["ssh://git@git.example.test:2222/App.git", "git@git.example.test:app", "https://user:pw@GIT.example.test/app/"]) {
			await git(f.work, ["remote", "set-url", "origin", url]);
			const out = await applyPull(input);
			expect(out.head).toBe(res.head);
		}
	});

	test("a repository whose remote is not the thread's is refused though it holds the commit; force pulls into it", async () => {
		const { f, res, input } = await pullInput();
		await git(f.work, ["remote", "set-url", "origin", "https://git.example.test/fork/app.git"]);
		const err = await refusal(applyPull(input));
		expect(err.code).toBe("conflict");
		expect(err.message).toBe("this repository's remote (git.example.test/fork/app) is not the thread's (git.example.test/app)");
		expect(await hasBranch(f.work)).toBe(false);
		const forced = await applyPull({ ...input, force: true });
		expect(forced.head).toBe(res.head);
	});

	test("outside a repository, or with `into` on a mode that has no use for it, is a conflict", async () => {
		const { f, input } = await pullInput();
		const none = await refusal(applyPull({ ...input, root: undefined, cwd: f.root }));
		expect(none.message).toBe("not a git repository");
		const into = await refusal(applyPull({ ...input, into: join(f.root, "x") }));
		expect(into.message).toContain("into only applies to");
	});

	describe("scratch", () => {
		/** A scratch thread's result: an empty first commit and the cloud's work on the thread branch, bundled whole. */
		async function scratchResult() {
			const root = await tmp();
			const pod = join(root, "pod");
			await git(root, ["init", "-q", "-b", "main", pod]);
			await git(pod, ["config", "user.name", "Cloud"]);
			await git(pod, ["config", "user.email", "cloud@example.com"]);
			await git(pod, ["config", "commit.gpgsign", "false"]);
			await git(pod, ["commit", "-q", "--allow-empty", "-m", "scratch"]);
			await git(pod, ["checkout", "-q", "-b", BRANCH]);
			await commitFile(pod, "report.md", "# findings\n");
			const bundle = join(root, "result.bundle");
			await git(pod, ["bundle", "create", bundle, `refs/heads/${BRANCH}`]);
			return { root, bundle, head: await git(pod, ["rev-parse", "HEAD"]) };
		}

		const base = (res: { bundle: string }, into: string | undefined, root: string | undefined = undefined): ApplyInput => ({
			root,
			cwd: "/",
			thread: THREAD,
			scratch: true,
			bundlePath: res.bundle,
			identity: { handoffCommit: "", baseCommit: "", remoteURL: "" },
			apply: "fetch",
			into,
			force: false,
		});

		test("is cloned into the new directory with the thread branch checked out", async () => {
			const res = await scratchResult();
			const into = join(res.root, "out");
			const out = await applyPull(base(res, into));
			expect(out).toMatchObject({ mode: "clone", path: into, head: res.head, branch: BRANCH, checkedOutMoved: false, commits: 2 });
			expect(out.subjects[0]).toEndWith("add report.md");
			expect(await readFile(join(into, "report.md"), "utf8")).toBe("# findings\n");
			expect(await git(into, ["branch", "--show-current"])).toBe(BRANCH);
			expect(await isClean(into)).toBe(true);
		});

		test("needs into, and into must be new or empty; an existing empty directory is fine; it is not affected by the cwd's repository or by identity", async () => {
			const res = await scratchResult();
			const missing = await refusal(applyPull(base(res, undefined)));
			expect(missing).toMatchObject({ code: "conflict" });
			expect(missing.hint).toContain("pass into");

			const full = join(res.root, "full");
			await mkdir(full);
			await writeFile(join(full, "f"), "x");
			expect((await refusal(applyPull(base(res, full)))).message).toContain("is not an empty directory");

			const empty = join(res.root, "empty");
			await mkdir(empty);
			const { f } = await pullInput();
			const out = await applyPull({ ...base(res, empty, f.work), cwd: f.work });
			expect(out.path).toBe(empty);
			expect(await hasBranch(f.work)).toBe(false);
		});

		test("a relative into is relative to the model's directory", async () => {
			const res = await scratchResult();
			const out = await applyPull({ ...base(res, "child"), cwd: res.root });
			expect(out.path).toBe(join(res.root, "child"));
		});
	});
});
