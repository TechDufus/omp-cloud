import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretError, SecretRefs } from "./secret";

/** Whether a process with this pid exists (an unreaped zombie counts until its parent collects it). */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("SecretRefs.resolve", () => {
	test("the trimmed output of the command is the secret", async () => {
		expect(await new SecretRefs().resolve("!printf '  tok-123\\n'", "github.com")).toBe("tok-123");
	});

	test("the command runs through sh, so pipes and quoting work", async () => {
		expect(await new SecretRefs().resolve("!echo abc | tr a-z A-Z", "github.com")).toBe("ABC");
	});

	test("a plain value is refused: only references resolve", async () => {
		await expect(new SecretRefs().resolve("ghp_literal", "github.com")).rejects.toThrow('not a "!command" secret reference');
		await expect(new SecretRefs().resolve("!", "github.com")).rejects.toThrow('not a "!command" secret reference');
	});

	test("a failing command names the host and its exit code, never its output", async () => {
		const error = await new SecretRefs().resolve("!echo topsecret-in-stdout; echo topsecret-in-stderr >&2; exit 3", "github.com").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SecretError);
		expect(String((error as Error).message)).toBe("the credential command of github.com failed (exit 3)");
	});

	test("empty output and multi-line output are refused without echoing them", async () => {
		await expect(new SecretRefs().resolve("!true", "github.com")).rejects.toThrow("printed nothing");
		const error = await new SecretRefs().resolve("!printf 'line1\\nline2'", "github.com").catch((e: unknown) => e);
		expect(String((error as Error).message)).toBe("the credential command of github.com must print one line of printable text");
		expect(String((error as Error).message)).not.toContain("line1");
	});

	test("a command that outlives the timeout is killed", async () => {
		const refs = new SecretRefs({ timeoutMs: 100 });
		await expect(refs.resolve("!exec sleep 5", "github.com")).rejects.toThrow("timed out after 0.1 s");
	});

	test("a timeout kills the command's children too", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-cloud-secret-"));
		let child = 0;
		try {
			const pidFile = join(dir, "pid");
			const refs = new SecretRefs({ timeoutMs: 500 });
			await expect(refs.resolve(`!sleep 30 & echo $! > ${pidFile}; wait`, "github.com")).rejects.toThrow("timed out");
			child = Number((await readFile(pidFile, "utf8")).trim());
			expect(child).toBeGreaterThan(0);
			// A real wait, no fake clock reaches it: the kernel reaps the SIGKILLed grandchild asynchronously after the timeout.
			const deadline = Date.now() + 2_000;
			while (isAlive(child) && Date.now() < deadline) await Bun.sleep(20);
			expect(isAlive(child)).toBe(false);
		} finally {
			if (child > 0 && isAlive(child)) process.kill(child, "SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a result is reused until its TTL ends, then resolved again", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-cloud-secret-"));
		try {
			const counter = join(dir, "count");
			await writeFile(counter, "");
			let now = 1_000;
			const refs = new SecretRefs({ ttlMs: 60_000, now: () => now });
			const ref = `!echo run >> ${counter}; echo tok`;
			expect(await refs.resolve(ref, "h")).toBe("tok");
			expect(await refs.resolve(ref, "h")).toBe("tok");
			expect((await readFile(counter, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
			now += 60_001;
			expect(await refs.resolve(ref, "h")).toBe("tok");
			expect((await readFile(counter, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a failed resolution is not cached", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-cloud-secret-"));
		try {
			const flag = join(dir, "ok");
			const refs = new SecretRefs();
			const ref = `!test -f ${flag} && echo tok`;
			await expect(refs.resolve(ref, "h")).rejects.toThrow("failed (exit 1)");
			await writeFile(flag, "");
			expect(await refs.resolve(ref, "h")).toBe("tok");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
