import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialExecutable } from "./executable";

async function withBin<T>(run: (dir: string, exe: string, plain: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "omp-cloud-exe-"));
	try {
		const exe = join(dir, "get-token");
		const plain = join(dir, "not-exec");
		await writeFile(exe, "#!/bin/sh\necho tok\n");
		await chmod(exe, 0o755);
		await writeFile(plain, "data");
		await chmod(plain, 0o644);
		return await run(dir, exe, plain);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("credentialExecutable", () => {
	test("an absolute word is reported as given, whatever follows it", async () => {
		await withBin(async (_dir, exe) => {
			expect(await credentialExecutable(`!${exe} --host github.com`, "")).toEqual({ path: exe });
			expect(await credentialExecutable(`!  ${exe}`, "")).toEqual({ path: exe });
		});
	});

	test("a bare word is resolved on the search path", async () => {
		await withBin(async (dir, exe) => {
			expect(await credentialExecutable("!get-token arg", `/nonexistent:${dir}`)).toEqual({ path: exe });
		});
	});

	test("a bare word that is not on the path, or not executable there, is a warning naming only the word", async () => {
		await withBin(async dir => {
			for (const command of ["!no-such-tool --token hunter2", "!not-exec hunter2"]) {
				const found = await credentialExecutable(command, dir);
				expect(found).toHaveProperty("warning");
				expect(JSON.stringify(found)).not.toContain("hunter2");
			}
			expect(await credentialExecutable("!no-such-tool", dir)).toEqual({ warning: "no-such-tool is not on the service PATH or not executable" });
		});
	});

	test("an absolute word that is missing or not executable is a warning", async () => {
		await withBin(async (dir, _exe, plain) => {
			expect(await credentialExecutable(`!${plain} x`, "")).toEqual({ warning: `${plain} does not exist or is not executable` });
			expect(await credentialExecutable(`!${join(dir, "gone")}`, "")).toEqual({ warning: `${join(dir, "gone")} does not exist or is not executable` });
		});
	});

	test("a command that starts with an assignment or shell syntax is never echoed", async () => {
		for (const command of ["!TOKEN=s3cret get-token", "!$HOME/bin/get-token s3cret", "!'/opt/my tool' s3cret", "!"]) {
			const found = await credentialExecutable(command, "/usr/bin:/bin");
			expect(found).toHaveProperty("warning");
			expect(JSON.stringify(found)).not.toContain("s3cret");
		}
	});
});
