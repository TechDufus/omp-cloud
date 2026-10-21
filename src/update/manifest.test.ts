import { describe, expect, test } from "bun:test";
import { DEFAULT_FEED, parseFeedSpec } from "./feed-spec";
import { compareVersions, hostArch, isVersion, parseManifest, releaseAssetName } from "./manifest";
import { makeManifest } from "./test-support";

const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(makeManifest("0.5.0")));

function refused(change: (raw: Record<string, unknown>) => void): string {
	const raw = valid();
	change(raw);
	try {
		parseManifest(raw);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("the manifest was accepted");
}

describe("parseManifest", () => {
	test("takes what the release pipeline writes and ignores keys it does not know", () => {
		const raw = { ...valid(), futureField: { x: 1 } };
		expect(parseManifest(raw)).toEqual(makeManifest("0.5.0"));
	});

	test("refuses a wrong product, a version with a v, a bad digest, a size that is not a count", () => {
		expect(refused((raw) => (raw.product = "tern"))).toBe('release.json: product must be "omp-cloud"');
		expect(refused((raw) => (raw.version = "v0.5.0"))).toContain("is not X.Y.Z (no leading v)");
		expect(refused((raw) => (raw.version = "0.5"))).toContain("is not X.Y.Z");
		const file = (raw: Record<string, unknown>, change: (entry: Record<string, unknown>) => void) => {
			const files = raw.files;
			if (!Array.isArray(files)) throw new Error("no files");
			change(files[0]);
		};
		expect(refused((raw) => file(raw, (entry) => (entry.sha256 = "ABC")))).toBe("release.json: files[0].sha256 must be 64 lowercase hex digits");
		expect(refused((raw) => file(raw, (entry) => (entry.size = 0)))).toBe("release.json: files[0].size must be a positive integer");
		expect(refused((raw) => file(raw, (entry) => (entry.size = 1.5)))).toBe("release.json: files[0].size must be a positive integer");
		expect(refused((raw) => file(raw, (entry) => (entry.arch = "riscv")))).toBe('release.json: files[0].arch must be "x86_64" or "arm64"');
		expect(refused((raw) => file(raw, (entry) => (entry.platform = "macos")))).toBe('release.json: files[0].platform must be "linux"');
		expect(refused((raw) => file(raw, (entry) => (entry.name = "../evil")))).toContain("is not a plain file name");
	});

	test("refuses missing sections and malformed requirements, naming the path", () => {
		expect(refused((raw) => delete raw.requires)).toBe("release.json: requires must be an object");
		expect(refused((raw) => delete raw.build)).toBe("release.json: build must be an object");
		expect(refused((raw) => (raw.files = []))).toBe("release.json: files must be a non-empty list");
		expect(refused((raw) => (raw.notes = 5))).toBe("release.json: notes must be a string");
		expect(refused((raw) => (raw.plugin = { version: "x" }))).toBe("release.json: plugin.version is not X.Y.Z");
		expect(refused((raw) => (raw.requires = { vmon: { version: "0.4.0" }, omp: { min: "18.12.3" }, schema: 10 }))).toBe(
			"release.json: requires.vmon.version must look like v0.4.0",
		);
		expect(refused((raw) => (raw.requires = { vmon: { version: "v0.4.0" }, omp: { min: "18.12.3" }, schema: 0 }))).toBe(
			"release.json: requires.schema must be a positive integer",
		);
	});

	test("refuses two files for one architecture, and anything that is not an object", () => {
		expect(
			refused((raw) => {
				const files = raw.files;
				if (Array.isArray(files)) files.push({ ...files[0], name: "other" });
			}),
		).toBe("release.json: two files for linux/x86_64");
		expect(() => parseManifest("nope")).toThrow("release.json: the document must be an object");
		expect(() => parseManifest(null)).toThrow("must be an object");
	});
});

describe("versions", () => {
	test("compare numerically, a prerelease before its release", () => {
		expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("0.5.0", "0.5.1")).toBeLessThan(0);
		expect(compareVersions("0.5.0-rc.1", "0.5.0")).toBeLessThan(0);
		expect(compareVersions("0.5.0", "0.5.0-rc.1")).toBeGreaterThan(0);
		expect(compareVersions("0.5.0-rc.2", "0.5.0-rc.1")).toBeGreaterThan(0);
		expect(() => compareVersions("x", "0.5.0")).toThrow("not a version");
	});

	test("isVersion, the asset name and the architecture", () => {
		expect([isVersion("0.5.0"), isVersion("v0.5.0"), isVersion("0.5.0-rc.1"), isVersion("0.5")]).toEqual([true, false, true, false]);
		expect(releaseAssetName("x86_64")).toBe("omp-cloud-linux-x86_64");
		expect(releaseAssetName("arm64")).toBe("omp-cloud-linux-arm64");
		expect([hostArch("x64"), hostArch("arm64")]).toEqual(["x86_64", "arm64"]);
		expect(() => hostArch("ia32")).toThrow("no omp-cloud release is built for ia32");
	});
});

describe("update.feed values", () => {
	test("github:<owner>/<repo> and http(s) base URLs", () => {
		expect(parseFeedSpec(DEFAULT_FEED)).toEqual({ kind: "github", owner: "TechDufus", repo: "omp-cloud" });
		expect(parseFeedSpec("http://127.0.0.1:9000/feed")).toEqual({ kind: "static", base: "http://127.0.0.1:9000/feed/" });
		expect(parseFeedSpec("https://example.test/omp/")).toEqual({ kind: "static", base: "https://example.test/omp/" });
	});

	test("refuses anything else, credentials in a URL and queries", () => {
		for (const bad of ["", "github:owner", "github:/repo", "github:a/b/c", "ftp://x/", "https://u:p@example.test/", "https://example.test/?a=1", "TechDufus/omp-cloud"]) {
			expect(() => parseFeedSpec(bad)).toThrow();
		}
		expect(() => parseFeedSpec("https://u:p@example.test/")).toThrow("must not carry credentials");
	});
});
