/**
 * Embeds omp's native addon in the compiled `omp-cloud` binary, the way omp's own build does.
 *
 * `@oh-my-pi/pi-natives` (the SDK the service imports) loads a Rust addon at start. In a standalone binary it looks for
 * one it extracts from `native/embedded-addon.js`, a module that is `embeddedAddon = null` on disk and that a binary
 * build replaces with the target's manifest and one zstd frame per addon (omp's `scripts/embed-native.ts`). Without it
 * the binary only starts where an omp has left `~/.omp/natives/<version>/pi_natives.*.node` behind. This module builds
 * that replacement and a `Bun.build` plugin that swaps it in; `scripts/release.ts` runs it for each target.
 *
 * What the loader (`node_modules/@oh-my-pi/pi-natives/native/loader-state.js`) needs of the manifest:
 * `platformTag` (`linux-x64`, `linux-arm64`) and `version` equal to the package's own, and `files` of
 * `{variant, filename, size, zstdPath}` where `size` is the decompressed byte count, `filename` a bare
 * `pi_natives.<tag>[-<variant>].node` and `zstdPath` a readable zstd frame. x64 carries `modern` (AVX2) and `baseline`;
 * the other architectures one `default`. It extracts just the variant the CPU selects into `~/.omp/natives/<version>/`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AddonVariant = "modern" | "baseline" | "default";

/** The release targets' natives: what `bun build --target` and the SDK's platform tag call each architecture. */
export const NATIVE_TARGETS = {
	x86_64: { bunTarget: "bun-linux-x64", platformTag: "linux-x64", leafPackage: "@oh-my-pi/pi-natives-linux-x64" },
	arm64: { bunTarget: "bun-linux-arm64", platformTag: "linux-arm64", leafPackage: "@oh-my-pi/pi-natives-linux-arm64" },
} as const;

export type NativeArch = keyof typeof NATIVE_TARGETS;

/** One addon of a target: the `.node` file on disk and what the manifest calls it. */
export interface AddonSource {
	variant: AddonVariant;
	filename: string;
	path: string;
}

/** One entry of the generated module's `files`. */
export interface EmbeddedFile {
	variant: AddonVariant;
	filename: string;
	size: number;
	/** The zstd frame of the `.node` on disk (the module imports it as an embedded file). */
	frame: string;
}

/** What the generated module exports as `embeddedAddon`, with each `zstdPath` still a file on disk. */
export interface EmbeddedManifest {
	platformTag: string;
	version: string;
	files: EmbeddedFile[];
}

/** `version` of `@oh-my-pi/pi-natives` installed under `root`: the one the loader compares the manifest's against. */
export function installedNativesVersion(root: string): string {
	const parsed: unknown = JSON.parse(readFileSync(join(root, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), "utf8"));
	const version = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "version") : undefined;
	if (typeof version !== "string" || version === "") throw new Error("node_modules/@oh-my-pi/pi-natives has no version: run bun install");
	return version;
}

function variantOf(filename: string, platformTag: string): AddonVariant | null {
	const match = new RegExp(`^pi_natives\\.${platformTag}(?:-(modern|baseline))?\\.node$`).exec(filename);
	if (match === null) return null;
	return match[1] === "modern" || match[1] === "baseline" ? match[1] : "default";
}

/** The addons in directory `dir` for `arch`: x64 needs `modern` and `baseline`, the others a `default`. */
export function addonsIn(dir: string, arch: NativeArch): AddonSource[] {
	const { platformTag } = NATIVE_TARGETS[arch];
	const found: AddonSource[] = [];
	for (const filename of readdirSync(dir).sort()) {
		const variant = variantOf(filename, platformTag);
		if (variant !== null) found.push({ variant, filename, path: join(dir, filename) });
	}
	const have = found.map((addon) => addon.variant).sort();
	const want = arch === "x86_64" ? ["baseline", "modern"] : ["default"];
	if (have.join() !== want.join()) throw new Error(`${dir} holds the ${platformTag} addons [${have.join(", ")}], expected [${want.join(", ")}]`);
	return found;
}

/** `sha512-<base64>`, the form npm's `dist.integrity` takes. */
export function integrityOf(bytes: Uint8Array): string {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export type Fetch = (url: string) => Promise<Response>;

/**
 * The addons of the leaf package `arch` needs. x64's package is a dependency of the SDK and installed under `root`; any
 * other architecture's is not installed on this host, so its tarball of the same version is fetched from the npm
 * registry, checked against the registry's `dist.integrity` (and refused on a mismatch) and unpacked under `cacheDir`.
 */
export async function leafAddons(root: string, arch: NativeArch, version: string, cacheDir: string, fetchUrl: Fetch = (url) => fetch(url)): Promise<AddonSource[]> {
	const { leafPackage } = NATIVE_TARGETS[arch];
	const installed = join(root, "node_modules", ...leafPackage.split("/"));
	if (existsSync(join(installed, "package.json"))) {
		const parsed: unknown = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
		const installedVersion = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "version") : undefined;
		if (installedVersion !== version) throw new Error(`${leafPackage} ${String(installedVersion)} is installed but @oh-my-pi/pi-natives is ${version}: run bun install`);
		return addonsIn(installed, arch);
	}

	const registry = "https://registry.npmjs.org";
	const metaResponse = await fetchUrl(`${registry}/${leafPackage.replace("/", "%2f")}/${version}`);
	if (!metaResponse.ok) throw new Error(`npm registry: ${leafPackage}@${version} answered ${metaResponse.status}`);
	const meta: unknown = await metaResponse.json();
	const dist = typeof meta === "object" && meta !== null ? Reflect.get(meta, "dist") : undefined;
	const tarball = typeof dist === "object" && dist !== null ? Reflect.get(dist, "tarball") : undefined;
	const integrity = typeof dist === "object" && dist !== null ? Reflect.get(dist, "integrity") : undefined;
	if (typeof tarball !== "string" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
		throw new Error(`npm registry: ${leafPackage}@${version} has no tarball with a sha512 integrity`);
	}

	const dir = join(cacheDir, `${leafPackage.replace("/", "__")}-${version}`);
	const unpacked = join(dir, "package");
	const archive = join(dir, "package.tgz");
	// Every build checks the archive again, so a cache someone edited is never embedded.
	let bytes: Uint8Array | null = existsSync(archive) ? new Uint8Array(readFileSync(archive)) : null;
	if (bytes === null || integrityOf(bytes) !== integrity) {
		const download = await fetchUrl(tarball);
		if (!download.ok) throw new Error(`npm registry: downloading ${tarball} answered ${download.status}`);
		bytes = new Uint8Array(await download.arrayBuffer());
		if (integrityOf(bytes) !== integrity) throw new Error(`${leafPackage}@${version}: the downloaded tarball does not match the registry's integrity ${integrity}`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(archive, bytes);
	}
	rmSync(unpacked, { recursive: true, force: true });
	const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", dir], { stdout: "ignore", stderr: "pipe" });
	if (tar.exitCode !== 0) throw new Error(`tar -xzf ${archive} failed: ${tar.stderr.toString().trim()}`);
	return addonsIn(unpacked, arch);
}

/** Compresses each addon into `<workDir>/<filename>.zst` and returns the manifest (frames are written atomically, so an interrupted build leaves no half frame). */
export function compressAddons(addons: readonly AddonSource[], arch: NativeArch, version: string, workDir: string): EmbeddedManifest {
	mkdirSync(workDir, { recursive: true });
	const files = addons.map((addon): EmbeddedFile => {
		const bytes = readFileSync(addon.path);
		const frame = join(workDir, `${addon.filename}.zst`);
		const partial = `${frame}.partial`;
		writeFileSync(partial, Bun.zstdCompressSync(bytes));
		renameSync(partial, frame);
		return { variant: addon.variant, filename: addon.filename, size: bytes.length, frame };
	});
	return { platformTag: NATIVE_TARGETS[arch].platformTag, version, files };
}

/**
 * The JavaScript the bundler uses in place of `embedded-addon.js`: each frame is imported as an embedded file, so
 * `zstdPath` names it inside the binary.
 */
export function embeddedAddonSource(manifest: EmbeddedManifest): string {
	const imports = manifest.files.map((file, i) => `import frame${i} from ${JSON.stringify(file.frame)} with { type: "file" };`);
	const files = manifest.files.map(
		(file, i) => `\t\t{ variant: ${JSON.stringify(file.variant)}, filename: ${JSON.stringify(file.filename)}, size: ${file.size}, zstdPath: frame${i} },`,
	);
	return [
		...imports,
		"export const embeddedAddon = {",
		`\tplatformTag: ${JSON.stringify(manifest.platformTag)},`,
		`\tversion: ${JSON.stringify(manifest.version)},`,
		"\tfiles: [",
		...files,
		"\t],",
		"};",
		"",
	].join("\n");
}

/** A `Bun.build` plugin that replaces the SDK's null `embedded-addon.js` with `source`. */
export function embedNativesPlugin(source: string): Bun.BunPlugin {
	return {
		name: "omp-cloud-embed-natives",
		setup(build) {
			build.onLoad({ filter: /pi-natives[\\/]native[\\/]embedded-addon\.js$/ }, () => ({ contents: source, loader: "js" }));
		},
	};
}
