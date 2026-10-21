import { writeFile } from "node:fs/promises";
import { FeedError, type Feed, type FeedRelease } from "./feed";
import type { ReleaseArch, ReleaseManifest } from "./manifest";
import { releaseAssetName } from "./manifest";
import type { CommandResult, CommandRunner, VmonTools } from "./system";

/** The "executable" of a test release: a shell script that prints what `omp-cloud version` prints. */
export function releaseBytes(version: string, printed: string = `omp-cloud ${version} (test)`): Uint8Array {
	return new TextEncoder().encode(`#!/bin/sh\necho '${printed}'\n`);
}

export function sha256Of(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** A manifest of `version` whose files are `bytes` for both architectures. */
export function makeManifest(version: string, bytes: Uint8Array = releaseBytes(version), overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
	const file = (arch: ReleaseArch) => ({ name: releaseAssetName(arch), platform: "linux" as const, arch, size: bytes.length, sha256: sha256Of(bytes) });
	return {
		product: "omp-cloud",
		version,
		build: { id: `20261021000000-abc${version.replaceAll(".", "")}`, commit: "a".repeat(40), createdAt: "2026-10-21T00:00:00Z" },
		notes: `notes of ${version}`,
		files: [file("x86_64"), file("arm64")],
		plugin: { version },
		requires: { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 10 },
		...overrides,
	};
}

export interface FakeReleaseOptions {
	/** The bytes the executable download serves (default: the script of `version`). */
	bytes?: Uint8Array;
	/** The sidecar text per asset name; absent: the release has none. */
	sidecars?: Record<string, string>;
	/** Counts calls to `download`. */
	downloads?: { count: number };
}

/** A release served from memory. `manifest.files` say what is announced; `options.bytes` what is actually downloaded. */
export function fakeRelease(manifest: ReleaseManifest, options: FakeReleaseOptions = {}): FeedRelease {
	const bytes = options.bytes ?? releaseBytes(manifest.version);
	const sidecars = options.sidecars ?? {};
	return {
		manifest,
		publishedAt: "2026-10-21T01:00:00Z",
		has: (asset) => manifest.files.some((file) => file.name === asset) || asset in sidecars,
		text: async (asset) => {
			const text = sidecars[asset];
			if (text === undefined) throw new FeedError("none", `the release has no asset ${asset}`);
			return text;
		},
		download: async (_asset, destination, maxBytes) => {
			if (options.downloads !== undefined) options.downloads.count++;
			if (bytes.length > maxBytes) throw new FeedError("failed", `the download is longer than the ${maxBytes} bytes the release declares`);
			await writeFile(destination, bytes);
		},
	};
}

/** A feed that answers with `release`, or throws what `failure` says. */
export function fakeFeed(answer: { release: FeedRelease } | { failure: Error }): Feed {
	return { latest: async () => ("release" in answer ? answer.release : Promise.reject(answer.failure)) };
}

export interface RecordedCommand {
	argv: string[];
}

/**
 * A CommandRunner that records every call and answers through `respond` (undefined: exit 0, no output). `version`
 * calls of a staged binary are answered by `respond` too; nothing is ever started for real.
 */
export function recordingRunner(respond: (argv: readonly string[]) => Partial<CommandResult> | undefined = () => undefined): { run: CommandRunner; calls: RecordedCommand[] } {
	const calls: RecordedCommand[] = [];
	const run: CommandRunner = async (argv) => {
		calls.push({ argv: [...argv] });
		return { code: 0, stdout: "", stderr: "", ...respond(argv) };
	};
	return { run, calls };
}

/** Joined command lines, for readable assertions. */
export function lines(calls: readonly RecordedCommand[]): string[] {
	return calls.map((call) => call.argv.join(" "));
}

export interface FakeVmon extends VmonTools {
	installs: string[];
}

export function fakeVmon(options: { installed?: string | null; helper?: boolean; pin?: string; failInstall?: string } = {}): FakeVmon {
	const state = { installed: options.installed === undefined ? "v0.4.0" : options.installed };
	const installs: string[] = [];
	return {
		pin: options.pin ?? "v0.4.0",
		installs,
		installed: async () => state.installed,
		helper: async () => ({ available: options.helper ?? true }),
		install: async (tag) => {
			installs.push(tag);
			if (options.failInstall !== undefined) throw new Error(options.failInstall);
			state.installed = tag;
		},
	};
}
