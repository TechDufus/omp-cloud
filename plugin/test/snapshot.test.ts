import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitRaw, isCredentialPath, takeSnapshot, type Snapshot, type SnapshotOptions } from "../src/snapshot";
import { cleanup, commitFile, configureRepo, remoteFixture, REMOTE_URL, tmp } from "./helpers";

afterEach(cleanup);

async function opts(cwd: string, over: Partial<SnapshotOptions> = {}): Promise<SnapshotOptions> {
	return {
		cwd,
		tmpDir: await tmp("omp-cloud-snap-"),
		maxBytes: 512 * 1024 * 1024,
		secretFiles: [],
		secretEnv: [],
		env: {},
		home: "/home/test",
		gitHosts: [],
		...over,
	};
}

/** An empty repository to fetch a bundle into; it has none of the source's objects. */
async function emptyRepo(): Promise<string> {
	const dir = await tmp();
	await git(dir, ["init", "-q"]);
	return dir;
}

/** The snapshot's bundle; fails the test when the handoff shipped none. */
function bundleOf(snap: Snapshot): string {
	if (snap.bundlePath === null) throw new Error("the snapshot has no bundle");
	return snap.bundlePath;
}

describe("takeSnapshot", () => {
	test("WIP commit holds edits and untracked files, never ignored ones; the bundle carries the full history", async () => {
		const f = await remoteFixture();
		await commitFile(f.work, "b.txt", "unpushed\n");
		await writeFile(join(f.work, "a.txt"), "one\nDIRTY\n");
		await writeFile(join(f.work, "c.txt"), "untracked\n");
		await writeFile(join(f.work, ".env"), "SECRET=hunter2hunter2\n");
		const head = await git(f.work, ["rev-parse", "HEAD"]);

		const snap = await takeSnapshot(
			await opts(f.work, {
				secretFiles: [".env"],
				secretEnv: ["MY_TOKEN"],
				env: { MY_TOKEN: "tok-123" },
			}),
		);

		expect(snap.remoteURL).toBe(REMOTE_URL);
		expect(snap.baseRef).toBe("main");
		expect(snap.baseCommit).toBe("");
		expect(snap.localBranch).toBe("main");
		expect(snap.root).toBe(f.work);
		expect(snap.name).toBe("work");
		expect(snap.paths).toEqual({ home: "/home/test", workspace: f.work });
		expect(snap.author).toEqual({ name: "Test User", email: "test@example.com" });
		expect(snap.secretEnv).toEqual({ MY_TOKEN: "tok-123" });
		expect(snap.secretFiles).toEqual([{ path: ".env", content: Buffer.from("SECRET=hunter2hunter2\n").toString("base64") }]);
		expect(snap.commits).toBe(3);

		// The user's HEAD, index and ref namespace are untouched.
		expect(await git(f.work, ["rev-parse", "HEAD"])).toBe(head);
		expect((await gitRaw(f.work, ["status", "--porcelain"])).stdout).toBe(" M a.txt\n?? c.txt\n");
		expect((await gitRaw(f.work, ["rev-parse", "--verify", "-q", "refs/omp-cloud/handoff"])).code).not.toBe(0);

		// An empty repository has none of the history; the bundle must be self-contained.
		const fresh = await emptyRepo();
		await git(fresh, ["bundle", "verify", bundleOf(snap)]);
		await git(fresh, ["fetch", "-q", bundleOf(snap), "refs/omp-cloud/handoff"]);
		expect(await git(fresh, ["rev-parse", "FETCH_HEAD"])).toBe(snap.handoffCommit);
		expect(await git(fresh, ["rev-list", "--count", "FETCH_HEAD"])).toBe("4");
		expect(await git(fresh, ["show", "FETCH_HEAD:a.txt"])).toBe("one\nDIRTY");
		expect(await git(fresh, ["show", "FETCH_HEAD:c.txt"])).toBe("untracked");
		expect(await git(fresh, ["show", "FETCH_HEAD:b.txt"])).toBe("unpushed");
		expect(await git(fresh, ["ls-tree", "--name-only", "FETCH_HEAD"])).not.toContain(".env");
		expect(await git(fresh, ["rev-parse", "FETCH_HEAD^"])).toBe(head);
		expect(await git(fresh, ["log", "-1", "--format=%an <%ae> | %s", "FETCH_HEAD"])).toBe(
			"Test User <test@example.com> | omp-cloud: local changes at handoff",
		);
	});

	test("the bundle's only head is refs/omp-cloud/handoff, and it names the handoff commit", async () => {
		const f = await remoteFixture();
		await writeFile(join(f.work, "a.txt"), "changed\n");
		const snap = await takeSnapshot(await opts(f.work));
		const heads = await git(f.work, ["bundle", "list-heads", bundleOf(snap)]);
		expect(heads).toBe(`${snap.handoffCommit} refs/omp-cloud/handoff`);
		await git(f.work, ["bundle", "verify", bundleOf(snap)]);
		expect(snap.bundleBytes).toBe(Bun.file(bundleOf(snap)).size);
	});

	test("a clean, fully pushed tree still ships the whole history with HEAD as the handoff commit", async () => {
		const f = await remoteFixture();
		const snap = await takeSnapshot(await opts(f.work));
		expect(snap.baseCommit).toBe("");
		expect(snap.handoffCommit).toBe(f.base);
		expect(snap.wip).toEqual({ files: 0, insertions: 0, deletions: 0 });
		const fresh = await emptyRepo();
		await git(fresh, ["bundle", "verify", bundleOf(snap)]);
		await git(fresh, ["fetch", "-q", bundleOf(snap), "refs/omp-cloud/handoff"]);
		expect(await git(fresh, ["rev-parse", "FETCH_HEAD"])).toBe(f.base);
		expect(await git(fresh, ["rev-list", "--count", "FETCH_HEAD"])).toBe("2");
	});

	test("wip: false leaves uncommitted and untracked work out: the handoff is HEAD, nothing is listed or withheld, the index is untouched", async () => {
		const f = await remoteFixture();
		await writeFile(join(f.work, "a.txt"), "changed\n");
		await writeFile(join(f.work, "new.txt"), "n\n");
		await writeFile(join(f.work, ".env.local"), "TOKEN=1\n");
		const snap = await takeSnapshot(await opts(f.work, { wip: false }));
		expect(snap.handoffCommit).toBe(f.base);
		expect(snap.wip).toEqual({ files: 0, insertions: 0, deletions: 0 });
		expect(snap.untracked).toEqual([]);
		expect(snap.untrackedTotal).toBe(0);
		expect(snap.withheld).toEqual([]);
		const fresh = await emptyRepo();
		await git(fresh, ["fetch", "-q", bundleOf(snap), "refs/omp-cloud/handoff"]);
		expect(await git(fresh, ["show", "FETCH_HEAD:a.txt"])).toBe("one");
		expect(await gitRaw(fresh, ["cat-file", "-e", "FETCH_HEAD:new.txt"])).toMatchObject({ code: 128 });
		expect(await git(f.work, ["status", "--porcelain"])).toContain("new.txt");
	});

	test("no remote: the whole history is bundled and no remote or base ref is reported", async () => {
		const dir = await tmp();
		await git(dir, ["init", "-q", "-b", "main"]);
		await configureRepo(dir);
		await commitFile(dir, "a.txt", "one\n");
		await commitFile(dir, "b.txt", "two\n");
		const snap = await takeSnapshot(await opts(dir));
		expect(snap.baseCommit).toBe("");
		expect(snap.remoteURL).toBe("");
		expect(snap.baseRef).toBe("");
		const fresh = await emptyRepo();
		await git(fresh, ["bundle", "verify", bundleOf(snap)]);
		await git(fresh, ["fetch", "-q", bundleOf(snap), "refs/omp-cloud/handoff"]);
		expect(await git(fresh, ["rev-list", "--count", "FETCH_HEAD"])).toBe("2");
	});

	test("an ssh remote is reported as configured and the history is still bundled whole", async () => {
		const f = await remoteFixture();
		const url = "git@github.example.test:o/r.git";
		await git(f.work, ["remote", "set-url", "origin", url]);
		const snap = await takeSnapshot(await opts(f.work));
		expect(snap).toMatchObject({ baseCommit: "", remoteURL: url, baseRef: "main" });
		const fresh = await emptyRepo();
		await git(fresh, ["bundle", "verify", bundleOf(snap)]);
	});

	test("falls back to origin/HEAD when the branch has no upstream", async () => {
		const f = await remoteFixture();
		await git(f.work, ["remote", "set-head", "origin", "main"]);
		await git(f.work, ["switch", "-q", "-c", "feature"]);
		await commitFile(f.work, "f.txt", "f\n");
		const snap = await takeSnapshot(await opts(f.work));
		expect(snap.baseRef).toBe("main");
		expect(snap.baseCommit).toBe("");
		expect(snap.localBranch).toBe("feature");
		expect(snap.commits).toBe(3);
		expect(snap.remoteURL).toBe(REMOTE_URL);
	});

	describe("delta handoff", () => {
		const HOSTS = ["git.example.test"];

		test("an upstream on a host the service can fetch ships only what the remote lacks, on top of the merge-base", async () => {
			const f = await remoteFixture();
			await commitFile(f.work, "b.txt", "unpushed\n");
			await writeFile(join(f.work, "a.txt"), "one\nDIRTY\n");
			const snap = await takeSnapshot(await opts(f.work, { gitHosts: HOSTS }));

			expect(snap.baseCommit).toBe(f.base);
			expect(snap.baseRef).toBe("main");
			expect(snap.commits).toBe(1);
			const bundle = bundleOf(snap);
			expect(await git(f.work, ["bundle", "list-heads", bundle])).toBe(`${snap.handoffCommit} refs/omp-cloud/handoff`);

			// The bundle is thin: a repository without the base cannot take it ...
			const fresh = await emptyRepo();
			await expect(git(fresh, ["bundle", "verify", bundle])).rejects.toThrow(/prerequisite/);
			// ... and one that has fetched the remote's main can.
			await git(fresh, ["fetch", "-q", f.bare, "main"]);
			await git(fresh, ["bundle", "verify", bundle]);
			await git(fresh, ["fetch", "-q", bundle, "refs/omp-cloud/handoff"]);
			expect(await git(fresh, ["rev-parse", "FETCH_HEAD"])).toBe(snap.handoffCommit);
			expect(await git(fresh, ["rev-parse", "FETCH_HEAD^^"])).toBe(f.base);
			expect(await git(fresh, ["show", "FETCH_HEAD:a.txt"])).toBe("one\nDIRTY");
			expect(await git(fresh, ["show", "FETCH_HEAD:b.txt"])).toBe("unpushed");
			expect(snap.bundleBytes).toBe(Bun.file(bundle).size);
		});

		test("the base is the merge-base: the commit where HEAD leaves the remote-tracking branch", async () => {
			const f = await remoteFixture();
			const second = await commitFile(f.work, "b.txt", "two\n");
			await git(f.work, ["push", "-q", "origin", "main"]);
			await git(f.work, ["switch", "-q", "-c", "feature"]);
			await git(f.work, ["branch", "-q", "--set-upstream-to=origin/main"]);
			await commitFile(f.work, "c.txt", "three\n");
			const snap = await takeSnapshot(await opts(f.work, { gitHosts: HOSTS }));
			expect(snap.baseCommit).toBe(second);
			expect(snap.commits).toBe(1);
		});

		test("a clean tree whose HEAD is the base ships no bundle at all", async () => {
			const f = await remoteFixture();
			const snap = await takeSnapshot(await opts(f.work, { gitHosts: HOSTS }));
			expect(snap.baseCommit).toBe(f.base);
			expect(snap.handoffCommit).toBe(f.base);
			expect(snap.bundlePath).toBeNull();
			expect(snap.bundleBytes).toBe(0);
			expect(snap.commits).toBe(0);
			expect(snap.wip).toEqual({ files: 0, insertions: 0, deletions: 0 });
		});

		test("an unpushed commit on a clean tree ships HEAD, with the base as prerequisite", async () => {
			const f = await remoteFixture();
			const head = await commitFile(f.work, "b.txt", "unpushed\n");
			const snap = await takeSnapshot(await opts(f.work, { gitHosts: HOSTS }));
			expect(snap.handoffCommit).toBe(head);
			expect(snap.baseCommit).toBe(f.base);
			expect(snap.commits).toBe(1);
			expect(await git(f.work, ["bundle", "list-heads", bundleOf(snap)])).toBe(`${head} refs/omp-cloud/handoff`);
		});

		test("an ssh remote of a host the service can fetch is a delta too", async () => {
			const f = await remoteFixture();
			await git(f.work, ["remote", "set-url", "origin", "git@github.example.test:o/r.git"]);
			await commitFile(f.work, "b.txt", "unpushed\n");
			const snap = await takeSnapshot(await opts(f.work, { gitHosts: ["github.example.test"] }));
			expect(snap).toMatchObject({ baseCommit: f.base, remoteURL: "git@github.example.test:o/r.git", baseRef: "main" });
		});

		test.each([
			["a host the service holds no credential for", ["other.example"]],
			["a service that lists no hosts", []],
		])("%s ships the whole history", async (_label, gitHosts) => {
			const f = await remoteFixture();
			await commitFile(f.work, "b.txt", "unpushed\n");
			const snap = await takeSnapshot(await opts(f.work, { gitHosts }));
			expect(snap.baseCommit).toBe("");
			expect(snap.commits).toBe(3);
			const fresh = await emptyRepo();
			await git(fresh, ["bundle", "verify", bundleOf(snap)]);
		});

		test("without a remote-tracking ref of the upstream the whole history ships", async () => {
			const f = await remoteFixture();
			await git(f.work, ["update-ref", "-d", "refs/remotes/origin/main"]);
			const snap = await takeSnapshot(await opts(f.work, { gitHosts: HOSTS }));
			expect(snap.baseCommit).toBe("");
			expect(snap.bundlePath).not.toBeNull();
		});

		test("a local path remote is never a delta", async () => {
			const f = await remoteFixture();
			await git(f.work, ["remote", "set-url", "origin", f.bare]);
			const snap = await takeSnapshot(await opts(f.work, { gitHosts: HOSTS }));
			expect(snap.baseCommit).toBe("");
		});
	});

	test("a secret file that is not gitignored is refused", async () => {
		const f = await remoteFixture();
		await writeFile(join(f.work, "creds.txt"), "x=1\n");
		await expect(takeSnapshot(await opts(f.work, { secretFiles: ["creds.txt"] }))).rejects.toThrow(
			"creds.txt is not gitignored; refusing to ship it",
		);
	});

	const secretCases: [string, string[], string][] = [
		["missing file", ["nope.env"], "nope.env does not exist"],
		["escaping path", ["../x"], "is not a safe workspace-relative path"],
		["absolute path", ["/etc/passwd"], "is not a safe workspace-relative path"],
		["inside .git", [".git/config"], "is not a safe workspace-relative path"],
		["backslash separator", ["config\\.env"], "secretFiles entry config\\.env contains a backslash; separate path segments with /"],
	];
	for (const [name, files, want] of secretCases) {
		test(`secret file: ${name}`, async () => {
			const f = await remoteFixture();
			await expect(takeSnapshot(await opts(f.work, { secretFiles: files }))).rejects.toThrow(want);
		});
	}

	test("a secret file over 256 KiB is refused", async () => {
		const f = await remoteFixture();
		await writeFile(join(f.work, ".env"), "x".repeat(256 * 1024 + 1));
		await expect(takeSnapshot(await opts(f.work, { secretFiles: [".env"] }))).rejects.toThrow("is over 256 KiB");
	});

	test("a missing secret env var is an error", async () => {
		const f = await remoteFixture();
		await expect(takeSnapshot(await opts(f.work, { secretEnv: ["NOT_SET"] }))).rejects.toThrow(
			"NOT_SET is not set in this omp's environment",
		);
	});

	test("a repository with no commits is refused", async () => {
		const dir = await tmp();
		await git(dir, ["init", "-q", "-b", "main"]);
		await expect(takeSnapshot(await opts(dir))).rejects.toThrow("the repository has no commits");
	});

	test("a directory outside any repository is refused", async () => {
		const dir = await tmp();
		await mkdir(join(dir, "sub"));
		await expect(takeSnapshot(await opts(join(dir, "sub")))).rejects.toThrow("not a git repository");
	});

	test("an oversized bundle reports its size and the limit", async () => {
		const dir = await tmp();
		await git(dir, ["init", "-q", "-b", "main"]);
		await configureRepo(dir);
		await commitFile(dir, "a.txt", "one\n");
		await expect(takeSnapshot(await opts(dir, { maxBytes: 10 }))).rejects.toThrow(
			/^repository bundle is [\d.]+ MB, over the [\d.]+ MB upload limit$/,
		);
	});
});

describe("credential-named files", () => {
	const cases: [string, boolean][] = [
		[".env", true],
		[".env.local", true],
		[".env.production", true],
		[".env.example", false],
		[".env.sample", false],
		[".env.template", false],
		["infra/prod.tfvars", true],
		["infra/prod.tfvars.json", true],
		["terraform.tfstate", true],
		["terraform.tfstate.backup", true],
		["certs/server.pem", true],
		["certs/server.key", true],
		["a.p12", true],
		["a.pfx", true],
		["a.jks", true],
		["a.keystore", true],
		["home/.ssh/id_rsa", true],
		["id_dsa", true],
		["id_ecdsa", true],
		["id_ed25519", true],
		["id_ed25519.pub", false],
		[".netrc", true],
		[".npmrc", true],
		[".pypirc", true],
		["kubeconfig", true],
		["clusters/dev.kubeconfig", true],
		["talosconfig", true],
		["environment.ts", false],
		["README.md", false],
		["src/keyboard.ts", false],
	];
	for (const [path, want] of cases) {
		test(`${path} -> ${want ? "withheld" : "shipped"}`, () => expect(isCredentialPath(path)).toBe(want));
	}

	test("untracked ones are skipped, tracked ones keep their HEAD content, the rest ships; all are reported", async () => {
		const f = await remoteFixture();
		await commitFile(f.work, ".npmrc", "registry=https://registry.example.test\n");
		await git(f.work, ["push", "-q", "origin", "main"]);
		const base = await git(f.work, ["rev-parse", "HEAD"]);
		await writeFile(join(f.work, ".npmrc"), "//registry.example.test/:_authToken=npm_secret_value\n");
		await writeFile(join(f.work, ".env.local"), "TOKEN=local-secret\n");
		await mkdir(join(f.work, "certs"), { recursive: true });
		await writeFile(join(f.work, "certs", "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
		await writeFile(join(f.work, ".env.example"), "TOKEN=\n");
		await writeFile(join(f.work, "notes.txt"), "shipped\n");

		const snap = await takeSnapshot(await opts(f.work));
		expect(snap.baseCommit).toBe("");
		expect(await git(f.work, ["rev-parse", `${snap.handoffCommit}^`])).toBe(base);
		expect(snap.withheld).toEqual([".env.local", ".npmrc", "certs/server.pem"]);
		expect(snap.untracked).toEqual([".env.example", "notes.txt"]);
		expect(snap.untrackedTotal).toBe(2);
		expect(snap.wip).toEqual({ files: 2, insertions: 2, deletions: 0 });
		expect(snap.commits).toBe(3);

		const tree = await git(f.work, ["ls-tree", "-r", "--name-only", snap.handoffCommit]);
		expect(tree.split("\n")).toEqual([".env.example", ".gitignore", ".npmrc", "a.txt", "notes.txt"]);
		expect(await git(f.work, ["show", `${snap.handoffCommit}:.npmrc`])).toBe("registry=https://registry.example.test");
		// Nothing was removed from the user's working tree.
		expect((await gitRaw(f.work, ["status", "--porcelain", "--untracked-files=all"])).stdout).toContain("?? .env.local");
	});

	test("a gitignored credential file listed in secretFiles ships as a secret and is not reported as withheld; an unlisted untracked one is", async () => {
		const f = await remoteFixture();
		await writeFile(join(f.work, ".gitignore"), ".env\n.env.local\n");
		await writeFile(join(f.work, ".env.local"), "TOKEN=x\n");
		await writeFile(join(f.work, ".env.production"), "TOKEN=y\n");
		const snap = await takeSnapshot(await opts(f.work, { secretFiles: [".env.local"] }));
		expect(snap.secretFiles.map(s => s.path)).toEqual([".env.local"]);
		expect(snap.withheld).toEqual([".env.production"]);
		expect(await git(f.work, ["ls-tree", "-r", "--name-only", snap.handoffCommit])).not.toContain(".env.");
	});

	test("the untracked listing is capped at 10 names but counts them all", async () => {
		const f = await remoteFixture();
		for (let i = 0; i < 13; i++) await writeFile(join(f.work, `u${String(i).padStart(2, "0")}.txt`), "x\n");
		const snap = await takeSnapshot(await opts(f.work));
		expect(snap.untracked).toHaveLength(10);
		expect(snap.untrackedTotal).toBe(13);
		expect(snap.untracked[0]).toBe("u00.txt");
		expect(snap.wip.files).toBe(13);
	});
});
