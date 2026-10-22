import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RawGit, rewriteSigned } from "./sign";
import { generateSigningKey, sshPublicKey } from "./sshsig";

const hasSshKeygen = Bun.which("ssh-keygen") !== null;
const { privatePem } = generateSigningKey();

let root: string;
let repo: string;
let allowedSigners: string;
let env: Record<string, string>;

const git: RawGit = async (args, opts) => {
	const child = Bun.spawn(["git", ...args], { cwd: opts.cwd, env, stdin: opts.input ?? "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
	return stdout;
};

async function out(...args: string[]): Promise<string> {
	return Buffer.from(await git(args, { cwd: repo })).toString("utf8").trim();
}

let tick = 0;
/** Commits `file` with `message` on the current branch, with fixed, increasing dates and the given committer. */
async function commit(file: string, message: string, who = "Alice Author <alice@example.com>"): Promise<string> {
	await writeFile(join(repo, file), `${file}\n`);
	await out("add", file);
	const [name, mail] = who.split(" <");
	tick += 60;
	const date = `${1_700_000_000 + tick} +0200`;
	const commitEnv = { GIT_AUTHOR_NAME: "Alice Author", GIT_AUTHOR_EMAIL: "alice@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: name ?? "", GIT_COMMITTER_EMAIL: (mail ?? "").replace(">", ""), GIT_COMMITTER_DATE: date };
	const child = Bun.spawn(["git", "commit", "-q", "-m", message], { cwd: repo, env: { ...env, ...commitEnv }, stdout: "pipe", stderr: "pipe" });
	if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
	return out("rev-parse", "HEAD");
}

async function verify(sha: string): Promise<{ code: number; stderr: string }> {
	const child = Bun.spawn(["git", "-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowedSigners}`, "verify-commit", sha], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(child.stderr).text();
	return { code: await child.exited, stderr };
}

/** Everything of a commit but its parents, committer and signature. */
async function content(sha: string): Promise<string> {
	return out("show", "-s", "--format=%T%n%an%n%ae%n%ad%n%B", "--date=raw", sha);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "sign-"));
	repo = join(root, "repo");
	env = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	allowedSigners = join(root, "allowed_signers");
	await writeFile(allowedSigners, `* ${sshPublicKey(privatePem, "")}\n`);
	await git(["init", "-q", "-b", "main", repo], { cwd: root });
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("rewriteSigned", () => {
	test("signs each commit of the range, keeps tree, author, dates and message, and the base is untouched", async () => {
		const base = await commit("base.txt", "base");
		const one = await commit("one.txt", "first change\n\nwith a body, and a non-ASCII word: café", "Bob Builder <bob@example.com>");
		const two = await commit("two.txt", "second change");
		const result = await rewriteSigned(git, { repo, base, head: two, privatePem, committer: null });
		expect(result.rewritten).toBe(2);
		expect(result.head).not.toBe(two);
		const parent = await out("rev-parse", `${result.head}^`);
		expect(await out("rev-parse", `${parent}^`)).toBe(base);
		expect(await content(result.head)).toBe(await content(two));
		expect(await content(parent)).toBe(await content(one));
		expect(await out("show", "-s", "--format=%cn <%ce> %cd", "--date=raw", parent)).toBe(await out("show", "-s", "--format=%cn <%ce> %cd", "--date=raw", one));
		expect(await out("cat-file", "commit", result.head)).toContain("\ngpgsig -----BEGIN SSH SIGNATURE-----\n");
		if (hasSshKeygen) {
			expect(await verify(result.head)).toEqual({ code: 0, stderr: expect.stringContaining("Good") });
			expect((await verify(parent)).code).toBe(0);
			expect((await verify(two)).code).not.toBe(0);
		}
	});

	test("a second run over the same commits gives the same ids", async () => {
		const base = await out("rev-parse", "HEAD~2");
		const head = await out("rev-parse", "HEAD");
		const first = await rewriteSigned(git, { repo, base, head, privatePem, committer: null });
		const second = await rewriteSigned(git, { repo, base, head, privatePem, committer: null });
		expect(second).toEqual(first);
	});

	test("a signed commit whose parents did not change keeps its id; only the commits above it are rewritten", async () => {
		const base = await out("rev-parse", "HEAD~2");
		const signedOne = await rewriteSigned(git, { repo, base, head: await out("rev-parse", "HEAD~1"), privatePem, committer: null });
		await out("checkout", "-q", "--detach", signedOne.head);
		const next = await commit("three.txt", "third change");
		const again = await rewriteSigned(git, { repo, base, head: next, privatePem, committer: null });
		expect(again.rewritten).toBe(1);
		expect(await out("rev-parse", `${again.head}^`)).toBe(signedOne.head);
		const alreadySigned = await rewriteSigned(git, { repo, base, head: again.head, privatePem, committer: null });
		expect(alreadySigned).toEqual({ head: again.head, rewritten: 0 });
		await out("checkout", "-q", "main");
	});

	test("the committer override changes only the committer's name and email, not its date", async () => {
		const base = await out("rev-parse", "HEAD~2");
		const head = await out("rev-parse", "HEAD");
		const result = await rewriteSigned(git, { repo, base, head, privatePem, committer: { name: "Zoë Owner", email: "1+zoe@users.noreply.github.com" } });
		expect(await out("show", "-s", "--format=%cn|%ce|%cd", "--date=raw", result.head)).toBe(`Zoë Owner|1+zoe@users.noreply.github.com|${await out("show", "-s", "--format=%cd", "--date=raw", head)}`);
		expect(await content(result.head)).toBe(await content(head));
		if (hasSshKeygen) expect((await verify(result.head)).code).toBe(0);
	});

	test("a merge commit gets its rewritten parents", async () => {
		const base = await out("rev-parse", "HEAD");
		await out("checkout", "-q", "-b", "side");
		const side = await commit("side.txt", "side change");
		await out("checkout", "-q", "main");
		const mainTip = await commit("main-only.txt", "main change");
		const mergeEnv = { ...env, GIT_AUTHOR_NAME: "Alice Author", GIT_AUTHOR_EMAIL: "alice@example.com", GIT_COMMITTER_NAME: "Alice Author", GIT_COMMITTER_EMAIL: "alice@example.com" };
		const merge = Bun.spawn(["git", "merge", "-q", "--no-ff", "-m", "merge side", "side"], { cwd: repo, env: mergeEnv, stdout: "pipe", stderr: "pipe" });
		expect(await merge.exited).toBe(0);
		const head = await out("rev-parse", "HEAD");
		const result = await rewriteSigned(git, { repo, base, head, privatePem, committer: null });
		expect(result.rewritten).toBe(3);
		const parents = (await out("rev-list", "--parents", "-n", "1", result.head)).split(" ").slice(1);
		expect(parents).toHaveLength(2);
		expect(parents).not.toContain(mainTip);
		expect(parents).not.toContain(side);
		if (hasSshKeygen) for (const sha of [result.head, ...parents]) expect((await verify(sha)).code).toBe(0);
	});

	test("an empty range rewrites nothing", async () => {
		const head = await out("rev-parse", "HEAD");
		expect(await rewriteSigned(git, { repo, base: head, head, privatePem, committer: null })).toEqual({ head, rewritten: 0 });
	});

	test("a failing git surfaces its error", async () => {
		await expect(rewriteSigned(git, { repo, base: "0".repeat(40), head: "HEAD", privatePem, committer: null })).rejects.toThrow("git rev-list");
	});
});
