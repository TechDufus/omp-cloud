import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	addonsIn,
	compressAddons,
	embeddedAddonSource,
	embedNativesPlugin,
	installedNativesVersion,
	integrityOf,
	leafAddons,
	NATIVE_TARGETS,
} from "./embed-natives";

const REPO_ROOT = resolve(import.meta.dir, "..");
const VERSION = "18.12.3";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-cloud-natives-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A directory of fake addons: each file's bytes are its own name repeated, so frames and sizes differ. */
function fakeAddons(where: string, filenames: string[]): void {
	mkdirSync(where, { recursive: true });
	for (const filename of filenames) writeFileSync(join(where, filename), filename.repeat(500));
	writeFileSync(join(where, "package.json"), JSON.stringify({ version: VERSION }));
	writeFileSync(join(where, "README.md"), "not an addon");
}

describe("addonsIn", () => {
	test("x64 needs the modern and the baseline addon, the other architecture one default; other files are ignored", () => {
		fakeAddons(join(dir, "x64"), ["pi_natives.linux-x64-modern.node", "pi_natives.linux-x64-baseline.node"]);
		expect(addonsIn(join(dir, "x64"), "x86_64").map((addon) => [addon.variant, addon.filename])).toEqual([
			["baseline", "pi_natives.linux-x64-baseline.node"],
			["modern", "pi_natives.linux-x64-modern.node"],
		]);
		fakeAddons(join(dir, "arm64"), ["pi_natives.linux-arm64.node"]);
		expect(addonsIn(join(dir, "arm64"), "arm64").map((addon) => [addon.variant, addon.filename])).toEqual([["default", "pi_natives.linux-arm64.node"]]);
	});

	test("a missing or foreign addon is refused, naming what was found", () => {
		fakeAddons(join(dir, "half"), ["pi_natives.linux-x64-modern.node"]);
		expect(() => addonsIn(join(dir, "half"), "x86_64")).toThrow("[modern], expected [baseline, modern]");
		fakeAddons(join(dir, "wrong"), ["pi_natives.linux-arm64.node"]);
		expect(() => addonsIn(join(dir, "wrong"), "x86_64")).toThrow("expected [baseline, modern]");
		expect(() => addonsIn(join(dir, "wrong"), "arm64")).not.toThrow();
	});
});

describe("this repository's x64 natives", () => {
	test("the installed SDK addons are what the manifest would list, at the version the loader compares against", () => {
		const version = installedNativesVersion(REPO_ROOT);
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		const leaf = join(REPO_ROOT, "node_modules", "@oh-my-pi", "pi-natives-linux-x64");
		expect(JSON.parse(readFileSync(join(leaf, "package.json"), "utf8"))).toMatchObject({ version });
		expect(addonsIn(leaf, "x86_64").map((addon) => addon.filename)).toEqual(["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"]);
	});
});

describe("the generated manifest module", () => {
	test("lists variant, filename, size and a frame that decompresses to the addon's bytes", () => {
		fakeAddons(join(dir, "src"), ["pi_natives.linux-x64-modern.node", "pi_natives.linux-x64-baseline.node"]);
		const manifest = compressAddons(addonsIn(join(dir, "src"), "x86_64"), "x86_64", VERSION, join(dir, "work"));
		expect(manifest.platformTag).toBe("linux-x64");
		expect(manifest.version).toBe(VERSION);
		expect(manifest.files.map((file) => [file.variant, file.filename, file.size])).toEqual([
			["baseline", "pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-baseline.node".length * 500],
			["modern", "pi_natives.linux-x64-modern.node", "pi_natives.linux-x64-modern.node".length * 500],
		]);
		for (const file of manifest.files) {
			const original = readFileSync(join(dir, "src", file.filename));
			const frame = readFileSync(file.frame);
			expect(frame.length).toBeLessThan(original.length);
			expect(Buffer.from(Bun.zstdDecompressSync(frame)).equals(original)).toBe(true);
		}
		expect(readdirSync(join(dir, "work")).sort()).toEqual(["pi_natives.linux-x64-baseline.node.zst", "pi_natives.linux-x64-modern.node.zst"]);
	});

	test("the module the plugin puts in the SDK's place exports the shape the loader reads, each frame embedded as a file", async () => {
		fakeAddons(join(dir, "src"), ["pi_natives.linux-arm64.node"]);
		const manifest = compressAddons(addonsIn(join(dir, "src"), "arm64"), "arm64", VERSION, join(dir, "work"));

		// A stand-in for node_modules/@oh-my-pi/pi-natives/native/: the null stub the loader imports, and a reader of it.
		const native = join(dir, "node_modules", "@oh-my-pi", "pi-natives", "native");
		mkdirSync(native, { recursive: true });
		writeFileSync(join(native, "embedded-addon.js"), "export const embeddedAddon = null;\n");
		writeFileSync(join(dir, "entry.ts"), `import { embeddedAddon } from "./node_modules/@oh-my-pi/pi-natives/native/embedded-addon.js";\nconsole.log(JSON.stringify(embeddedAddon));\n`);

		const run = async (plugins: Bun.BunPlugin[], outdir: string): Promise<unknown> => {
			const result = await Bun.build({ entrypoints: [join(dir, "entry.ts")], outdir, target: "bun", plugins });
			expect(result.success).toBe(true);
			const proc = Bun.spawn([process.execPath, join(outdir, "entry.js")], { stdout: "pipe", stderr: "pipe" });
			return JSON.parse(await new Response(proc.stdout).text());
		};
		expect(await run([], join(dir, "plain"))).toBeNull();

		const embedded = await run([embedNativesPlugin(embeddedAddonSource(manifest))], join(dir, "embedded"));
		const zstdPath = typeof embedded === "object" && embedded !== null && "files" in embedded && Array.isArray(embedded.files) ? String(embedded.files[0]?.zstdPath) : "";
		// The frame travels with the bundle: the path the loader reads is a file next to it that holds the addon.
		expect(zstdPath).toMatch(/\.zst$/);
		expect(embedded).toEqual({
			platformTag: "linux-arm64",
			version: VERSION,
			files: [{ variant: "default", filename: "pi_natives.linux-arm64.node", size: "pi_natives.linux-arm64.node".length * 500, zstdPath }],
		});
		const frame = readFileSync(join(dir, "embedded", zstdPath));
		expect(Buffer.from(Bun.zstdDecompressSync(frame)).toString()).toBe("pi_natives.linux-arm64.node".repeat(500));
	});
});

describe("leafAddons", () => {
	const ARM64 = NATIVE_TARGETS.arm64.leafPackage;

	/** A tarball like npm's for the arm64 package, and a fetch that serves the registry's answers for it. */
	async function registry(options: { integrity?: string } = {}): Promise<{ fetchUrl: (url: string) => Promise<Response>; requests: string[]; tarball: Uint8Array }> {
		const pkg = join(dir, "tarball-src", "package");
		fakeAddons(pkg, ["pi_natives.linux-arm64.node"]);
		const tgz = join(dir, "pkg.tgz");
		const tar = Bun.spawnSync(["tar", "-czf", tgz, "-C", join(dir, "tarball-src"), "package"]);
		expect(tar.exitCode).toBe(0);
		const tarball = new Uint8Array(readFileSync(tgz));
		const requests: string[] = [];
		const fetchUrl = async (url: string): Promise<Response> => {
			requests.push(url);
			if (url === `https://registry.npmjs.org/@oh-my-pi%2fpi-natives-linux-arm64/${VERSION}`) {
				return Response.json({ dist: { tarball: "https://registry.test/pkg.tgz", integrity: options.integrity ?? integrityOf(tarball) } });
			}
			if (url === "https://registry.test/pkg.tgz") return new Response(tarball);
			return new Response("not found", { status: 404 });
		};
		return { fetchUrl, requests, tarball };
	}

	test("a package that is not installed is fetched at the SDK's version, checked against the registry's integrity and unpacked", async () => {
		const { fetchUrl, requests } = await registry();
		const addons = await leafAddons(join(dir, "root"), "arm64", VERSION, join(dir, "cache"), fetchUrl);
		expect(addons.map((addon) => [addon.variant, addon.filename])).toEqual([["default", "pi_natives.linux-arm64.node"]]);
		expect(readFileSync(addons[0]?.path ?? "", "utf8")).toBe("pi_natives.linux-arm64.node".repeat(500));
		expect(requests).toEqual([`https://registry.npmjs.org/@oh-my-pi%2fpi-natives-linux-arm64/${VERSION}`, "https://registry.test/pkg.tgz"]);
	});

	test("a second build reuses the cached tarball after checking it again; a tampered cache is downloaded anew", async () => {
		const { fetchUrl, requests } = await registry();
		await leafAddons(join(dir, "root"), "arm64", VERSION, join(dir, "cache"), fetchUrl);
		requests.length = 0;
		await leafAddons(join(dir, "root"), "arm64", VERSION, join(dir, "cache"), fetchUrl);
		expect(requests).toEqual([`https://registry.npmjs.org/@oh-my-pi%2fpi-natives-linux-arm64/${VERSION}`]);

		requests.length = 0;
		writeFileSync(join(dir, "cache", `${ARM64.replace("/", "__")}-${VERSION}`, "package.tgz"), "tampered");
		const addons = await leafAddons(join(dir, "root"), "arm64", VERSION, join(dir, "cache"), fetchUrl);
		expect(requests).toHaveLength(2);
		expect(readFileSync(addons[0]?.path ?? "", "utf8")).toBe("pi_natives.linux-arm64.node".repeat(500));
	});

	test("a download that does not match the registry's integrity is refused and nothing is cached", async () => {
		const { fetchUrl } = await registry({ integrity: `sha512-${Buffer.alloc(64).toString("base64")}` });
		await expect(leafAddons(join(dir, "root"), "arm64", VERSION, join(dir, "cache"), fetchUrl)).rejects.toThrow("does not match the registry's integrity");
		expect(() => readdirSync(join(dir, "cache", `${ARM64.replace("/", "__")}-${VERSION}`))).toThrow();
	});

	test("an unknown version, or an answer without a sha512 integrity, is refused", async () => {
		const notFound = async (): Promise<Response> => new Response("nope", { status: 404 });
		await expect(leafAddons(join(dir, "root"), "arm64", VERSION, join(dir, "cache"), notFound)).rejects.toThrow("answered 404");
		const weak = async (): Promise<Response> => Response.json({ dist: { tarball: "https://registry.test/x.tgz", integrity: "sha1-abc" } });
		await expect(leafAddons(join(dir, "root"), "arm64", VERSION, join(dir, "cache"), weak)).rejects.toThrow("sha512 integrity");
	});

	test("an installed package is used as it is, and one of another version than the SDK's is refused", async () => {
		const leaf = join(dir, "root", "node_modules", "@oh-my-pi", "pi-natives-linux-x64");
		fakeAddons(leaf, ["pi_natives.linux-x64-modern.node", "pi_natives.linux-x64-baseline.node"]);
		const never = async (): Promise<Response> => {
			throw new Error("the registry must not be asked");
		};
		expect(await leafAddons(join(dir, "root"), "x86_64", VERSION, join(dir, "cache"), never)).toHaveLength(2);
		await expect(leafAddons(join(dir, "root"), "x86_64", "18.12.4", join(dir, "cache"), never)).rejects.toThrow("18.12.3 is installed but @oh-my-pi/pi-natives is 18.12.4");
	});
});
