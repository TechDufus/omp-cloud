import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLayout, linkedVersion } from "../update/layout";
import type { CommandResult } from "../update/system";
import { recordingRunner } from "../update/test-support";
import { setupPaths, type SetupPaths } from "./config";
import { installCheckoutWrapper, installManagedBinary, removeAppDir, removeBinaryLink } from "./managed";

let dir: string;
let paths: SetupPaths;
let binary: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-cloud-setup-managed-")));
	paths = setupPaths({ HOME: dir, OMP_CLOUD_APP_DIR: join(dir, "app") }, "tester");
	binary = join(dir, "downloaded", "omp-cloud");
	await mkdir(join(dir, "downloaded"));
	await writeFile(binary, "#!/bin/sh\necho 'omp-cloud 0.5.1 (test)'\n");
	await chmod(binary, 0o755);
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function versionRunner(printed = "omp-cloud 0.5.1 (test)\n") {
	return recordingRunner((argv): Partial<CommandResult> | undefined => (argv[1] === "version" ? { stdout: printed } : undefined));
}

describe("installManagedBinary", () => {
	test("installs before service.json exists: copy, bin link, marker, state and the shell link", async () => {
		const { run, calls } = versionRunner();
		const result = await installManagedBinary(paths, binary, run);

		const layout = new AppLayout(paths.appDir);
		expect(result.version).toBe("0.5.1");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]).toMatchObject({ id: "managed.binary", status: "changed" });
		expect(result.steps[0]?.detail).toContain("0.5.1");
		expect(result.steps[0]?.detail).toContain(paths.appDir);
		await expect(lstat(paths.serviceJson)).rejects.toThrow();
		expect((await stat(layout.versionBinary("0.5.1"))).mode & 0o777).toBe(0o755);
		expect(JSON.parse(await readFile(layout.managerFile, "utf8"))).toEqual({ manager: "omp-cloud", name: "omp-cloud" });
		expect(await linkedVersion(layout)).toBe("0.5.1");
		expect(JSON.parse(await readFile(layout.stateFile, "utf8"))).toMatchObject({ installed: "0.5.1" });
		expect(await readlink(join(paths.binDir, "omp-cloud"))).toBe(layout.binLink);
		expect(calls.map((call) => call.argv)).toEqual([[binary, "version"]]);
	});

	test("a rerun changes nothing", async () => {
		await installManagedBinary(paths, binary, versionRunner().run);
		const again = await installManagedBinary(paths, binary, versionRunner().run);
		expect(again.steps[0]).toMatchObject({ id: "managed.binary", status: "ok" });
		expect(again.version).toBe("0.5.1");
	});

	test("running it from the installed copy changes nothing either", async () => {
		await installManagedBinary(paths, binary, versionRunner().run);
		const installed = new AppLayout(paths.appDir).versionBinary("0.5.1");
		const again = await installManagedBinary(paths, installed, versionRunner().run);
		expect(again.steps[0]?.status).toBe("ok");
	});

	test("a binary that does not print omp-cloud <version> is a failed step with the release fix, and nothing is installed", async () => {
		const result = await installManagedBinary(paths, binary, versionRunner("bun 1.4.3\n").run);
		expect(result.version).toBe("");
		expect(result.steps[0]).toMatchObject({ id: "managed.binary", status: "failed", fix: "run omp-cloud setup from a release binary" });
		await expect(lstat(paths.appDir)).rejects.toThrow();
		await expect(lstat(join(paths.binDir, "omp-cloud"))).rejects.toThrow();
	});

	test("a binary that cannot be started is the same failed step", async () => {
		const result = await installManagedBinary(paths, binary, async () => {
			throw new Error("spawn ENOEXEC");
		});
		expect(result.steps[0]).toMatchObject({ status: "failed", fix: "run omp-cloud setup from a release binary" });
		expect(result.steps[0]?.detail).toContain("ENOEXEC");
	});
});

describe("installCheckoutWrapper", () => {
	const input = { bunBin: "/opt/bun/bin/bun", repoRoot: "/home/me/dev/omp-cloud", unitPath: "/opt/bun/bin:/opt/omp/bin:/usr/local/bin:/usr/bin:/bin" };

	test("writes the shell-quoted wrapper, 0755, then leaves it alone", async () => {
		const target = join(paths.binDir, "omp-cloud");
		const first = await installCheckoutWrapper(paths, input);
		expect(first).toMatchObject({ id: "managed.wrapper", status: "changed" });
		expect(await readFile(target, "utf8")).toBe(`#!/bin/sh\nPATH='${input.unitPath}'\nexport PATH\nexec '/opt/bun/bin/bun' '/home/me/dev/omp-cloud/src/cli.ts' "$@"\n`);
		expect((await stat(target)).mode & 0o777).toBe(0o755);

		const inode = (await stat(target)).ino;
		const second = await installCheckoutWrapper(paths, input);
		expect(second.status).toBe("ok");
		expect((await stat(target)).ino).toBe(inode);
	});

	test("quotes a path with a single quote", async () => {
		await installCheckoutWrapper(paths, { ...input, repoRoot: "/home/o'brien/repo" });
		expect(await readFile(join(paths.binDir, "omp-cloud"), "utf8")).toContain(`'/home/o'\\''brien/repo/src/cli.ts'`);
	});

	test("rewrites a different script, and the file mode when it drifted", async () => {
		const target = join(paths.binDir, "omp-cloud");
		await mkdir(paths.binDir, { recursive: true });
		await writeFile(target, "#!/bin/sh\nexec old\n");
		expect((await installCheckoutWrapper(paths, input)).status).toBe("changed");
		await chmod(target, 0o644);
		expect((await installCheckoutWrapper(paths, input)).status).toBe("changed");
		expect((await stat(target)).mode & 0o777).toBe(0o755);
	});

	test("replaces a managed install's symlink with the script and leaves no temp file", async () => {
		await installManagedBinary(paths, binary, versionRunner().run);
		const target = join(paths.binDir, "omp-cloud");
		expect((await lstat(target)).isSymbolicLink()).toBe(true);
		const step = await installCheckoutWrapper(paths, input);
		expect(step.status).toBe("changed");
		expect((await lstat(target)).isFile()).toBe(true);
		expect(await Array.fromAsync(new Bun.Glob(".omp-cloud.*").scan({ cwd: paths.binDir, dot: true }))).toEqual([]);
	});
});

describe("removeBinaryLink", () => {
	test("removes our link into the app directory", async () => {
		await installManagedBinary(paths, binary, versionRunner().run);
		const step = await removeBinaryLink(paths);
		expect(step.status).toBe("changed");
		await expect(lstat(join(paths.binDir, "omp-cloud"))).rejects.toThrow();
	});

	test("removes our checkout wrapper", async () => {
		await installCheckoutWrapper(paths, { bunBin: "/opt/bun/bin/bun", repoRoot: "/repo", unitPath: "/usr/bin" });
		expect((await removeBinaryLink(paths)).status).toBe("changed");
		await expect(lstat(join(paths.binDir, "omp-cloud"))).rejects.toThrow();
	});

	test("keeps a foreign file and says so", async () => {
		const target = join(paths.binDir, "omp-cloud");
		await mkdir(paths.binDir, { recursive: true });
		await writeFile(target, "#!/bin/sh\necho mine\n");
		const step = await removeBinaryLink(paths);
		expect(step).toMatchObject({ id: "managed.link", status: "skipped" });
		expect(step.detail).toContain("not omp-cloud's");
		expect(await readFile(target, "utf8")).toBe("#!/bin/sh\necho mine\n");
	});

	test("keeps a symlink that points elsewhere", async () => {
		const target = join(paths.binDir, "omp-cloud");
		await mkdir(paths.binDir, { recursive: true });
		await symlink("/usr/bin/true", target);
		expect((await removeBinaryLink(paths)).status).toBe("skipped");
		expect(await readlink(target)).toBe("/usr/bin/true");
	});

	test("a name that does not exist is already right", async () => {
		expect((await removeBinaryLink(paths)).status).toBe("ok");
	});
});

describe("removeAppDir", () => {
	test("removes the app directory", async () => {
		await installManagedBinary(paths, binary, versionRunner().run);
		expect((await removeAppDir(paths)).status).toBe("changed");
		await expect(lstat(paths.appDir)).rejects.toThrow();
		expect((await removeAppDir(paths)).status).toBe("ok");
	});

	test("refuses a directory that is or holds the home directory", async () => {
		const home = await removeAppDir({ ...paths, appDir: paths.home });
		expect(home).toMatchObject({ id: "managed.app", status: "failed" });
		expect((await removeAppDir({ ...paths, appDir: "/" })).status).toBe("failed");
		expect((await removeAppDir({ ...paths, appDir: join(paths.home, "..") })).status).toBe("failed");
		expect((await lstat(paths.home)).isDirectory()).toBe(true);
	});
});
