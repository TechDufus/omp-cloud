import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, ExecError, localExec, shellQuote } from "./exec";
import { applyResultBundle, finalizeTurn, restoreRepo } from "./git";

const BRANCH = "omp-cloud/aaaaaaaaaaaa";
const NO_HOOKS_IDENTITY = "-c user.name=owner -c user.email=owner@example.com -c commit.gpgsign=false";

let dir: string;
let exec: Exec;
/** The "owner's machine": a repo with two commits and a bundle of the second as `refs/omp-cloud/handoff`. */
let source: string;
let handoff: string;
let first: string;
let bundle: string;
let workspace: string;

const q = shellQuote;

async function git(repo: string, args: string): Promise<string> {
	return (await exec(`git -C ${q(repo)} ${args}`)).trim();
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	exec = localExec();
	source = join(dir, "source");
	workspace = join(dir, "work");
	bundle = join(dir, "source.bundle");
	await exec(`git init -q -b main ${q(source)}`);
	await writeFile(join(source, "a.txt"), "one\n");
	await git(source, `add -A`);
	await git(source, `${NO_HOOKS_IDENTITY} commit -q -m first`);
	first = await git(source, "rev-parse HEAD");
	await writeFile(join(source, "a.txt"), "one\ntwo\n");
	await writeFile(join(source, "b.txt"), "b\n");
	await git(source, `add -A`);
	await git(source, `${NO_HOOKS_IDENTITY} commit -q -m second`);
	handoff = await git(source, "rev-parse HEAD");
	await git(source, `update-ref refs/omp-cloud/handoff ${handoff}`);
	await git(source, `bundle create ${q(bundle)} refs/omp-cloud/handoff`);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function restore(overrides: Partial<Parameters<typeof restoreRepo>[1]> = {}): Promise<void> {
	return restoreRepo(exec, {
		workspace,
		bundlePath: bundle,
		branch: BRANCH,
		handoffCommit: handoff,
		author: { name: "", email: "" },
		remoteURL: "",
		...overrides,
	});
}

describe("restoreRepo", () => {
	test("checks the thread branch out at the handoff commit with default identity and signing off", async () => {
		await restore();
		expect(await git(workspace, "rev-parse HEAD")).toBe(handoff);
		expect(await git(workspace, "symbolic-ref --short HEAD")).toBe(BRANCH);
		expect(await git(workspace, "config user.name")).toBe("omp-cloud");
		expect(await git(workspace, "config user.email")).toBe("omp-cloud@localhost");
		expect(await git(workspace, "config commit.gpgsign")).toBe("false");
		expect(await git(workspace, "config tag.gpgsign")).toBe("false");
		expect(await exec(`git -C ${q(workspace)} config remote.origin.url || true`)).toBe("");
		expect(await Bun.file(join(workspace, "b.txt")).text()).toBe("b\n");
	});

	test("uses the author and remote it is given", async () => {
		await restore({ author: { name: "Ada", email: "ada@example.com" }, remoteURL: "https://example.com/r.git" });
		expect(await git(workspace, "config user.name")).toBe("Ada");
		expect(await git(workspace, "config user.email")).toBe("ada@example.com");
		expect(await git(workspace, "config remote.origin.url")).toBe("https://example.com/r.git");
	});

	test("rejects a bundle whose handoff ref is not the recorded handoff commit", async () => {
		await expect(restore({ handoffCommit: first })).rejects.toThrow(/handoff commit/);
	});

	test("fails when the bundle is not a bundle", async () => {
		await writeFile(bundle, "not a bundle");
		await expect(restore()).rejects.toBeInstanceOf(ExecError);
	});
});

describe("finalizeTurn", () => {
	let bundlePath: string;

	beforeEach(async () => {
		await restore();
		bundlePath = join(dir, "result.bundle");
	});

	function finalize(overrides: Partial<Parameters<typeof finalizeTurn>[1]> = {}) {
		return finalizeTurn(exec, {
			workspace,
			branch: BRANCH,
			baseCommit: "",
			message: "turn one",
			uploadedHead: handoff,
			bundlePath,
			...overrides,
		});
	}

	test("commits the changes with the message, moves the branch and bundles the full history", async () => {
		await writeFile(join(workspace, "a.txt"), "one\ntwo\nthree\n");
		await writeFile(join(workspace, "c.txt"), "c\n");

		const result = await finalize();

		expect(result.head).not.toBe(handoff);
		expect(await git(workspace, `rev-parse refs/heads/${BRANCH}`)).toBe(result.head);
		expect(await git(workspace, "log -1 --format=%s")).toBe("turn one");
		expect(await git(workspace, "log -1 --format=%an")).toBe("omp-cloud");
		// From the handoff commit: a.txt gained a line and c.txt is new; b.txt and a.txt's first lines were handed off.
		expect(result).toMatchObject({ filesChanged: 2, insertions: 2, deletions: 0, bundlePath });
		const heads = await git(source, `bundle list-heads ${q(bundlePath)}`);
		expect(heads).toBe(`${result.head} refs/heads/${BRANCH}`);
		await git(source, `bundle verify ${q(bundlePath)}`);
	});

	test("measures from the handoff even when the base is older, and leaves the base's history out of the bundle", async () => {
		await writeFile(join(workspace, "a.txt"), "one\n");
		await writeFile(join(workspace, "c.txt"), "c\n");

		const result = await finalize({ baseCommit: first });

		// Measured from the base it would be b.txt and c.txt added; from the handoff it is a.txt's line gone and c.txt.
		expect(result).toMatchObject({ filesChanged: 2, insertions: 1, deletions: 1, bundlePath });
		// The source repo holds the base, so the bundle's prerequisite is satisfied there.
		await git(source, `bundle verify ${q(bundlePath)}`);
		expect(await git(source, `bundle list-heads ${q(bundlePath)}`)).toBe(`${result.head} refs/heads/${BRANCH}`);
	});

	test("does not commit when nothing changed", async () => {
		const result = await finalize();

		expect(result.head).toBe(handoff);
		expect(await git(workspace, "rev-list --count HEAD")).toBe("2");
		expect(result).toMatchObject({ filesChanged: 0, insertions: 0, deletions: 0 });
	});

	test("creates no bundle when the head is the one already uploaded", async () => {
		const result = await finalize({ uploadedHead: handoff });
		expect(result.head).toBe(handoff);
		expect(result.bundlePath).toBeNull();
		expect(await Bun.file(bundlePath).exists()).toBe(false);
	});

	test("creates no bundle when the head is the base", async () => {
		const result = await finalize({ baseCommit: handoff, uploadedHead: "" });
		expect(result).toMatchObject({ head: handoff, filesChanged: 0, insertions: 0, deletions: 0, bundlePath: null });
		expect(await Bun.file(bundlePath).exists()).toBe(false);
	});

	test("moves the branch to commits the agent made on a detached HEAD", async () => {
		await git(workspace, "checkout -q --detach");
		await writeFile(join(workspace, "d.txt"), "d\n");
		await git(workspace, "add -A");
		await git(workspace, "commit -q -m detached");
		const detached = await git(workspace, "rev-parse HEAD");

		const result = await finalize();

		expect(result.head).toBe(detached);
		expect(await git(workspace, `rev-parse refs/heads/${BRANCH}`)).toBe(detached);
	});

	test("leaves the branch alone when HEAD is not a descendant of it", async () => {
		await git(workspace, "checkout -q --orphan elsewhere");
		await writeFile(join(workspace, "e.txt"), "e\n");
		await git(workspace, "add -A");

		const result = await finalize();

		expect(result.head).toBe(handoff);
		expect(await git(workspace, `rev-parse refs/heads/${BRANCH}`)).toBe(handoff);
		expect(await git(workspace, "log -1 --format=%s elsewhere")).toBe("turn one");
	});

	test("keeps a file listed in .git/info/exclude out of the commit", async () => {
		await writeFile(join(workspace, ".git", "info", "exclude"), "/secret.env\n");
		await writeFile(join(workspace, "secret.env"), "TOKEN=1\n");
		await writeFile(join(workspace, "c.txt"), "c\n");

		const result = await finalize();

		expect(await git(workspace, `ls-tree -r --name-only ${result.head}`)).not.toContain("secret.env");
	});
});

describe("applyResultBundle", () => {
	let bundlePath: string;
	let head: string;
	let fresh: string;

	/** A turn in `workspace` that adds c.txt; its result bundle is left in `bundlePath`. */
	async function runTurn(baseCommit: string): Promise<void> {
		await restore();
		await writeFile(join(workspace, "c.txt"), "c\n");
		head = (await finalizeTurn(exec, { workspace, branch: BRANCH, baseCommit, message: "turn one", uploadedHead: handoff, bundlePath })).head;
	}

	function apply(overrides: Partial<Parameters<typeof applyResultBundle>[1]> = {}): Promise<void> {
		return applyResultBundle(exec, { workspace: fresh, bundlePath, branch: BRANCH, head, ...overrides });
	}

	beforeEach(() => {
		bundlePath = join(dir, "result.bundle");
		fresh = join(dir, "fresh");
	});

	test("puts the branch on the result's head and keeps the handoff ref", async () => {
		await runTurn("");
		await restore({ workspace: fresh });

		await apply();

		expect(await git(fresh, "rev-parse HEAD")).toBe(head);
		expect(await git(fresh, "symbolic-ref --short HEAD")).toBe(BRANCH);
		expect(await git(fresh, `rev-parse refs/heads/${BRANCH}`)).toBe(head);
		expect(await git(fresh, "rev-parse refs/omp-cloud/handoff")).toBe(handoff);
		expect(await Bun.file(join(fresh, "c.txt")).text()).toBe("c\n");
		expect(await git(fresh, "status --porcelain")).toBe("");
	});

	test("applies a thin result bundle of a delta thread on the full-history source", async () => {
		await runTurn(first);
		await restore({ workspace: fresh });

		await apply();

		expect(await git(fresh, "rev-parse HEAD")).toBe(head);
		expect(await git(fresh, `rev-list --count ${first}..HEAD`)).toBe("2");
	});

	test("goes to the recorded head when the bundle is newer, and leaves the later commits out", async () => {
		await runTurn("");
		const newer = join(dir, "newer.bundle");
		await writeFile(join(workspace, "d.txt"), "d\n");
		const second = await finalizeTurn(exec, { workspace, branch: BRANCH, baseCommit: "", message: "turn two", uploadedHead: head, bundlePath: newer });
		expect(second.head).not.toBe(head);
		await restore({ workspace: fresh });

		await apply({ bundlePath: newer });

		expect(await git(fresh, "rev-parse HEAD")).toBe(head);
		expect(await git(fresh, `rev-parse refs/heads/${BRANCH}`)).toBe(head);
		expect(await git(fresh, "symbolic-ref --short HEAD")).toBe(BRANCH);
		expect(await Bun.file(join(fresh, "d.txt")).exists()).toBe(false);
		expect(await git(fresh, "status --porcelain")).toBe("");
	});

	test("throws when the recorded head is not in the bundle, leaving the checkout at the handoff", async () => {
		await runTurn("");
		await restore({ workspace: fresh });

		await expect(apply({ head: "d".repeat(40) })).rejects.toThrow(/does not contain the head/);

		expect(await git(fresh, "rev-parse HEAD")).toBe(handoff);
	});

	test("throws when the recorded head exists in the repository but is not in the bundle's history", async () => {
		await runTurn("");
		await restore({ workspace: fresh });
		await git(fresh, "checkout -q --detach");
		await writeFile(join(fresh, "side.txt"), "side\n");
		await git(fresh, "add -A");
		await git(fresh, "commit -q -m side");
		const side = await git(fresh, "rev-parse HEAD");
		await git(fresh, `checkout -q ${BRANCH}`);

		await expect(apply({ head: side })).rejects.toThrow(/does not contain the head/);
	});

	test("fails when the bundle has no such branch", async () => {
		await runTurn("");
		await restore({ workspace: fresh });

		await expect(apply({ branch: "omp-cloud/missing" })).rejects.toBeInstanceOf(ExecError);
	});
});
