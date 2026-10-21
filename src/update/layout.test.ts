import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLayout, defaultAppDir, ensureLayout, installBinary, installedVersions, linkedVersion, managedVersion, prune, swapLink } from "./layout";

let dir: string;
let layout: AppLayout;
beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-cloud-layout-")));
	layout = new AppLayout(join(dir, "app"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function version(name: string): Promise<void> {
	await installBinary(layout, name, (path) => writeFile(path, `#!/bin/sh\necho ${name}\n`));
}

describe("the layout", () => {
	test("defaults to ~/.local/share/omp-cloud/app and follows OMP_CLOUD_APP_DIR", () => {
		expect(defaultAppDir({ HOME: "/home/x" })).toBe("/home/x/.local/share/omp-cloud/app");
		expect(defaultAppDir({ HOME: "/home/x", OMP_CLOUD_APP_DIR: "/srv/app" })).toBe("/srv/app");
		expect(defaultAppDir({ HOME: "/home/x", OMP_CLOUD_APP_DIR: "" })).toBe("/home/x/.local/share/omp-cloud/app");
		expect(layout.versionBinary("0.5.1")).toBe(join(dir, "app", "versions", "0.5.1", "omp-cloud"));
		expect(layout.binLink).toBe(join(dir, "app", "bin", "omp-cloud"));
	});

	test("ensureLayout writes the manager marker once; installBinary lands a 0755 file without leftovers", async () => {
		await ensureLayout(layout);
		expect(JSON.parse(await readFile(layout.managerFile, "utf8"))).toEqual({ manager: "omp-cloud", name: "omp-cloud" });
		await writeFile(layout.managerFile, '{"manager":"omp-cloud","name":"custom"}\n');
		await ensureLayout(layout);
		expect(JSON.parse(await readFile(layout.managerFile, "utf8")).name).toBe("custom");

		await version("0.5.0");
		expect((await stat(layout.versionBinary("0.5.0"))).mode & 0o777).toBe(0o755);
		expect(await readdir(layout.versionDir("0.5.0"))).toEqual(["omp-cloud"]);
		await expect(installBinary(layout, "0.5.1", () => Promise.reject(new Error("disk full")))).rejects.toThrow("disk full");
		expect(await readdir(layout.versionDir("0.5.1"))).toEqual([]);
	});
});

describe("the bin link", () => {
	test("swapLink points a relative link at versions/<v>/omp-cloud and replaces it atomically", async () => {
		await ensureLayout(layout);
		await version("0.5.0");
		await version("0.5.1");
		expect(await linkedVersion(layout)).toBeNull();
		await swapLink(layout, "0.5.0");
		expect(await readlink(layout.binLink)).toBe("../versions/0.5.0/omp-cloud");
		expect(await linkedVersion(layout)).toBe("0.5.0");
		await swapLink(layout, "0.5.1");
		expect(await linkedVersion(layout)).toBe("0.5.1");
		expect((await readFile(layout.binLink, "utf8")).trim().endsWith("0.5.1")).toBe(true);
		// No temporary link survives.
		expect(await readdir(layout.binDir)).toEqual(["omp-cloud"]);
	});

	test("linkedVersion is null for a link that is not ours", async () => {
		await ensureLayout(layout);
		await symlink("/usr/bin/true", layout.binLink);
		expect(await linkedVersion(layout)).toBeNull();
	});
});

describe("managedVersion", () => {
	test("is the version when the executable (through a symlink) lives under versions/, else null: a checkout", async () => {
		await ensureLayout(layout);
		await version("0.5.1");
		await swapLink(layout, "0.5.1");
		expect(await managedVersion(layout, layout.versionBinary("0.5.1"))).toBe("0.5.1");
		expect(await managedVersion(layout, layout.binLink)).toBe("0.5.1");
		expect(await managedVersion(layout, process.execPath)).toBeNull();
		expect(await managedVersion(layout, join(dir, "elsewhere"))).toBeNull();
		const outside = join(dir, "outside-bin");
		await mkdir(join(layout.versionsDir, "notaversion"), { recursive: true });
		await writeFile(join(layout.versionsDir, "notaversion", "omp-cloud"), "x");
		expect(await managedVersion(layout, join(layout.versionsDir, "notaversion", "omp-cloud"))).toBeNull();
		await writeFile(outside, "x");
		await symlink(outside, join(layout.versionsDir, "sneaky"));
		expect(await managedVersion(layout, join(layout.versionsDir, "sneaky"))).toBeNull();
	});

	test("an app directory that does not exist is a checkout", async () => {
		expect(await managedVersion(new AppLayout(join(dir, "nope")), process.execPath)).toBeNull();
	});
});

describe("prune", () => {
	test("keeps the current and the two newest older versions, every newer one and the ones named; removes the rest", async () => {
		for (const name of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.10.0"]) await version(name);
		await mkdir(join(layout.versionsDir, "not-a-version"));
		expect(await installedVersions(layout)).toEqual(["0.10.0", "0.6.0", "0.5.0", "0.4.0", "0.3.0", "0.2.0", "0.1.0"]);

		const removed = await prune(layout, "0.5.0", ["0.1.0"]);

		expect(removed.sort()).toEqual(["0.2.0"]);
		expect(await installedVersions(layout)).toEqual(["0.10.0", "0.6.0", "0.5.0", "0.4.0", "0.3.0", "0.1.0"]);
		// A directory that is not a version is never touched.
		expect(await readdir(layout.versionsDir)).toContain("not-a-version");
	});

	test("with only the current version there is nothing to remove", async () => {
		await version("0.5.0");
		expect(await prune(layout, "0.5.0")).toEqual([]);
		expect((await stat(layout.versionBinary("0.5.0"))).isFile()).toBe(true);
	});
});
