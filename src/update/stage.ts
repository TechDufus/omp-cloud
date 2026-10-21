import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FeedError, type FeedRelease } from "./feed";
import { type AppLayout, ensureLayout } from "./layout";
import { releaseAssetName, type ReleaseArch, type ReleaseManifest } from "./manifest";
import type { CommandRunner } from "./system";

/** The lowercase hex SHA-256 of a file, read as a stream. */
export async function sha256File(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/** The digest in a `sha256sum`-style sidecar (`<hex>  <name>`, or just the hex). Throws when it holds none. */
export function parseSidecar(content: string): string {
	const first = content.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (!/^[0-9a-f]{64}$/.test(first)) throw new Error("the .sha256 sidecar holds no SHA-256");
	return first;
}

/** What `<binary> version` must print: `omp-cloud <version>`, optionally followed by a space and the build id. */
export function printsVersion(output: string, version: string): boolean {
	const line = output.trim().split("\n")[0] ?? "";
	return line === `omp-cloud ${version}` || line.startsWith(`omp-cloud ${version} `);
}

/** The manifest's file for `arch`. Throws when the release has none. */
export function fileFor(manifest: ReleaseManifest, arch: ReleaseArch): ReleaseManifest["files"][number] {
	const file = manifest.files.find((entry) => entry.arch === arch && entry.name === releaseAssetName(arch));
	if (file === undefined) throw new Error(`release ${manifest.version} has no ${releaseAssetName(arch)}`);
	return file;
}

/** Runs `<binary> version` and requires `omp-cloud <version>`. Throws with what it printed otherwise. */
async function requireVersion(run: CommandRunner, binary: string, version: string): Promise<void> {
	const result = await run([binary, "version"], { timeoutMs: 30_000 });
	if (result.code !== 0) throw new Error(`the downloaded omp-cloud does not run (${binary} version exited ${result.code})`);
	if (!printsVersion(result.stdout, version)) {
		throw new Error(`the downloaded omp-cloud says ${JSON.stringify(result.stdout.trim().slice(0, 80))}, not "omp-cloud ${version}"`);
	}
}

/** Whether `versions/<version>/omp-cloud` is already there with the manifest's size and digest. */
export async function isStaged(layout: AppLayout, manifest: ReleaseManifest, arch: ReleaseArch): Promise<boolean> {
	const file = fileFor(manifest, arch);
	const path = layout.versionBinary(manifest.version);
	try {
		return (await stat(path)).size === file.size && (await sha256File(path)) === file.sha256;
	} catch {
		return false;
	}
}

/**
 * Downloads the release's executable for `arch`, verifies its size and SHA-256 against the manifest (and the
 * `.sha256` sidecar when the release has one), checks that `<file> version` prints `omp-cloud <version>`, and moves it to
 * `versions/<version>/omp-cloud` (0755). Nothing lands there unless every check passed; a failed download leaves no
 * file behind. Returns the staged path. Throws an Error with the reason.
 */
export async function stageRelease(layout: AppLayout, release: FeedRelease, arch: ReleaseArch, run: CommandRunner): Promise<string> {
	const { manifest } = release;
	const file = fileFor(manifest, arch);
	await ensureLayout(layout);
	const directory = layout.versionDir(manifest.version);
	await mkdir(directory, { recursive: true, mode: 0o755 });
	const temp = join(directory, `.omp-cloud.download-${process.pid}`);
	try {
		await release.download(file.name, temp, file.size);
		const size = (await stat(temp)).size;
		if (size !== file.size) throw new Error(`the download is ${size} bytes, the release says ${file.size}`);
		const digest = await sha256File(temp);
		if (digest !== file.sha256) throw new Error("the download does not match the SHA-256 in release.json");
		const sidecar = `${file.name}.sha256`;
		if (release.has(sidecar)) {
			let published: string | null = null;
			try {
				published = parseSidecar(await release.text(sidecar));
			} catch (error) {
				if (!(error instanceof FeedError && error.kind === "none")) throw error;
			}
			if (published !== null && published !== digest) throw new Error(`the download does not match its ${sidecar}`);
		}
		await chmod(temp, 0o755);
		await requireVersion(run, temp, manifest.version);
		await rename(temp, layout.versionBinary(manifest.version));
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return layout.versionBinary(manifest.version);
}
