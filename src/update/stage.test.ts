import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLayout } from "./layout";
import { releaseBytes, fakeRelease, makeManifest, recordingRunner, sha256Of } from "./test-support";
import { isStaged, parseSidecar, printsVersion, sha256File, stageRelease } from "./stage";
import { runCommand } from "./system";

let dir: string;
let layout: AppLayout;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-stage-"));
	layout = new AppLayout(join(dir, "app"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const VERSION = "0.5.1";

async function leftovers(): Promise<string[]> {
	try {
		return await readdir(layout.versionDir(VERSION));
	} catch {
		return [];
	}
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("staging succeeded");
}

describe("stageRelease", () => {
	test("downloads, verifies size, sha256 and the sidecar, runs `version`, then lands 0755 at versions/<v>/omp-cloud", async () => {
		const bytes = releaseBytes(VERSION);
		const manifest = makeManifest(VERSION, bytes);
		const sidecars = { "omp-cloud-linux-x86_64.sha256": `${sha256Of(bytes)}  omp-cloud-linux-x86_64\n` };
		const { run, calls } = recordingRunner(() => ({ stdout: `omp-cloud ${VERSION} (20261021-abc)\n` }));

		const path = await stageRelease(layout, fakeRelease(manifest, { bytes, sidecars }), "x86_64", run);

		expect(path).toBe(layout.versionBinary(VERSION));
		expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
		expect((await stat(path)).mode & 0o777).toBe(0o755);
		// The check ran on the downloaded file, before it was moved into place.
		expect(calls.length).toBe(1);
		expect(calls[0]?.argv[1]).toBe("version");
		expect(calls[0]?.argv[0]).not.toBe(path);
		expect(await leftovers()).toEqual(["omp-cloud"]);
		expect(await isStaged(layout, manifest, "x86_64")).toBe(true);
	});

	test("a download of another size is refused and nothing is left behind", async () => {
		const bytes = releaseBytes(VERSION);
		const short = bytes.slice(0, bytes.length - 3);
		const message = await refusal(stageRelease(layout, fakeRelease(makeManifest(VERSION, bytes), { bytes: short }), "x86_64", recordingRunner().run));
		expect(message).toBe(`the download is ${short.length} bytes, the release says ${bytes.length}`);
		expect(await leftovers()).toEqual([]);
	});

	test("the right size with other bytes fails the sha256", async () => {
		const bytes = releaseBytes(VERSION);
		const tampered = releaseBytes(VERSION, `omp-cloud ${VERSION} (evil)`.padEnd(`omp-cloud ${VERSION} (test)`.length, " ").slice(0, `omp-cloud ${VERSION} (test)`.length));
		expect(tampered.length).toBe(bytes.length);
		const { run, calls } = recordingRunner();
		const message = await refusal(stageRelease(layout, fakeRelease(makeManifest(VERSION, bytes), { bytes: tampered }), "x86_64", run));
		expect(message).toBe("the download does not match the SHA-256 in release.json");
		expect(calls).toEqual([]);
		expect(await leftovers()).toEqual([]);
	});

	test("a sidecar that names another digest is refused; a sidecar the feed lacks is not an error", async () => {
		const bytes = releaseBytes(VERSION);
		const manifest = makeManifest(VERSION, bytes);
		const wrong = { "omp-cloud-linux-x86_64.sha256": `${"0".repeat(64)}  omp-cloud-linux-x86_64\n` };
		expect(await refusal(stageRelease(layout, fakeRelease(manifest, { bytes, sidecars: wrong }), "x86_64", recordingRunner().run))).toBe(
			"the download does not match its omp-cloud-linux-x86_64.sha256",
		);
		expect(await leftovers()).toEqual([]);

		const withoutSidecar = fakeRelease(manifest, { bytes });
		const announced = { ...withoutSidecar, has: () => true };
		await stageRelease(layout, announced, "x86_64", recordingRunner(() => ({ stdout: `omp-cloud ${VERSION}\n` })).run);
		expect(await leftovers()).toEqual(["omp-cloud"]);
	});

	test("a sidecar without a digest is a failure", async () => {
		const bytes = releaseBytes(VERSION);
		const message = await refusal(
			stageRelease(layout, fakeRelease(makeManifest(VERSION, bytes), { bytes, sidecars: { "omp-cloud-linux-x86_64.sha256": "garbage" } }), "x86_64", recordingRunner().run),
		);
		expect(message).toBe("the .sha256 sidecar holds no SHA-256");
		expect(await leftovers()).toEqual([]);
	});

	test("a binary whose `version` says something else, or fails, is refused and not staged", async () => {
		const bytes = releaseBytes(VERSION);
		const manifest = makeManifest(VERSION, bytes);
		expect(await refusal(stageRelease(layout, fakeRelease(manifest, { bytes }), "x86_64", recordingRunner(() => ({ stdout: "omp-cloud 0.5.0 (old)\n" })).run))).toBe(
			`the downloaded omp-cloud says "omp-cloud 0.5.0 (old)", not "omp-cloud ${VERSION}"`,
		);
		expect(await refusal(stageRelease(layout, fakeRelease(manifest, { bytes }), "x86_64", recordingRunner(() => ({ code: 126 })).run))).toContain("does not run");
		expect(await leftovers()).toEqual([]);
		expect(await isStaged(layout, manifest, "x86_64")).toBe(false);
	});

	test("runs the real downloaded file: a script that prints omp-cloud <v> is accepted, one that prints another version is not", async () => {
		const manifest = makeManifest(VERSION);
		await stageRelease(layout, fakeRelease(manifest), "x86_64", runCommand);
		expect((await runCommand([layout.versionBinary(VERSION), "version"])).stdout).toBe(`omp-cloud ${VERSION} (test)\n`);

		const liar = releaseBytes(VERSION, "omp-cloud 9.9.9 (test)");
		const other = new AppLayout(join(dir, "other"));
		expect(await refusal(stageRelease(other, fakeRelease(makeManifest(VERSION, liar), { bytes: liar }), "x86_64", runCommand))).toContain('not "omp-cloud 0.5.1"');
	});

	test("a release without a file for the architecture is refused before any download", async () => {
		const manifest = makeManifest(VERSION);
		const downloads = { count: 0 };
		const noArm = { ...manifest, files: manifest.files.filter((file) => file.arch === "x86_64") };
		expect(await refusal(stageRelease(layout, fakeRelease(noArm, { downloads }), "arm64", recordingRunner().run))).toBe(`release ${VERSION} has no omp-cloud-linux-arm64`);
		expect(downloads.count).toBe(0);
	});
});

describe("isStaged", () => {
	test("is true only for a file with the manifest's size and digest", async () => {
		const manifest = makeManifest(VERSION);
		expect(await isStaged(layout, manifest, "x86_64")).toBe(false);
		await stageRelease(layout, fakeRelease(manifest), "x86_64", recordingRunner(() => ({ stdout: `omp-cloud ${VERSION}\n` })).run);
		expect(await isStaged(layout, manifest, "x86_64")).toBe(true);
		await chmod(layout.versionBinary(VERSION), 0o700);
		await Bun.write(layout.versionBinary(VERSION), releaseBytes(VERSION, "omp-cloud 0.5.1 (tampered)"));
		expect(await isStaged(layout, manifest, "x86_64")).toBe(false);
	});
});

describe("helpers", () => {
	test("parseSidecar, printsVersion and sha256File", async () => {
		expect(parseSidecar(`${"A".repeat(64)}  file\n`)).toBe("a".repeat(64));
		expect(parseSidecar("b".repeat(64))).toBe("b".repeat(64));
		expect(() => parseSidecar("")).toThrow("holds no SHA-256");
		expect([printsVersion("omp-cloud 0.5.1\n", "0.5.1"), printsVersion("omp-cloud 0.5.1 (id)\n", "0.5.1"), printsVersion("omp-cloud 0.5.10\n", "0.5.1")]).toEqual([true, true, false]);
		const file = join(dir, "f");
		await Bun.write(file, "abc");
		expect(await sha256File(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});
