import { type ConnectionOpts, defaultBuildLogger, Template } from "e2b";
import type { Recipe } from "./recipe";

/** omp's build service origin, as `omp update` and Tern resolve it: `PI_BUILD_URL`, else this. */
const DEFAULT_BUILD_URL = "https://build.stencil.so";

/** The VM size every template is built with (the sandbox reports it back from the template). Part of the recipe: a different size is a different template. */
export const BUILD_SIZE = { cpuCount: 2, memoryMB: 4096 };

/**
 * The recipe of the template of omp `version`: Debian trixie, the tools the runner needs, the owner's `recipe.packages`,
 * omp, then the owner's `recipe.setup` lines as root. Provider config is not part of it: the runner writes it per
 * sandbox. vmon provisions the image itself by its `/etc/os-release` (init, its guest agent, sshd, sudo, curl, git, jq
 * and the default user `user` with passwordless sudo), so the base image needs nothing but a root filesystem.
 */
export function agentTemplate(version: string, recipe: Recipe) {
	const template = Template()
		.fromImage("debian:trixie-slim")
		.aptInstall(["ca-certificates", "curl", "git", "jq", "procps"]);
	const withPackages = recipe.packages.length === 0 ? template : template.aptInstall(recipe.packages);
	const withOmp = withPackages.runCmd(installOmp(version), { user: "root" });
	return recipe.setup.length === 0 ? withOmp : withOmp.runCmd(["set -eux", ...recipe.setup].join("\n"), { user: "root" });
}

/**
 * The vmon template of an omp version and the recipe that builds it: `omp-agent:18.12.3-<hash12>`, the hash being the
 * first 12 hex characters of the SHA-256 of the serialized recipe (base image, steps, install script), the build size and
 * the vmon version that builds and boots it (`vmonVersion`, null when none is installed). A changed recipe, or a vmon
 * upgrade (whose snapshot format or guest agent may differ), gets a new tag, which `Templates.ensure` builds on first
 * use; the old tag stays for the VMs built from it. Aliases cannot hold dots, tags can (`^[a-z0-9-_.]+$`, an alias is
 * `^[a-z0-9-_]+$`), so the omp version and the recipe hash live in the tag. `Template.toJSON(recipe, true)` serializes
 * the recipe offline and deterministically, base image included.
 */
export async function templateName(base: string, version: string, vmonVersion: string | null, recipe: Recipe): Promise<string> {
	const json = await Template.toJSON(agentTemplate(version, recipe), true);
	const hash = new Bun.CryptoHasher("sha256")
		.update(json)
		.update(JSON.stringify(BUILD_SIZE))
		.update(JSON.stringify({ vmon: vmonVersion }))
		.digest("hex");
	return `${base}:${version}-${hash.slice(0, 12)}`;
}

/**
 * The shell recipe that installs the omp `version` (`<major>.<minor>.<patch>`, checked by the caller) as `bin`: the same
 * build, from the same service, that `omp update` and Tern install. `GET {origin}/api/products/omp/versions/<version>/linux-x86_64`
 * answers the file's exact SHA-256 and a presigned download URL (SDK `src/cli/build-service.ts`, `fetchBuild`); the
 * download is installed only when it hashes to that SHA-256. Debian trixie is glibc, so the target is `linux-x86_64`
 * (an Alpine base would need the musl build, `linux-musl-x86_64`, whose file is `omp-linux-musl-x64`).
 */
export function installOmp(
	version: string,
	origin = (process.env.PI_BUILD_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_BUILD_URL,
	bin = "/usr/local/bin/omp",
): string {
	const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
	return `set -eux
origin=${quoted(origin)}
tmp="$(mktemp -d)"
cd "$tmp"
curl -fsS -H 'Accept: application/json' -o answer.json "$origin/api/products/omp/versions/${version}/linux-x86_64"
jq -e '.build.version == "${version}" and .file.name == "omp-linux-x64"' answer.json
sha256="$(jq -er '.file.sha256 | select(test("^[0-9a-f]{64}$"))' answer.json)"
curl -fsSL -o omp-linux-x64 "$(jq -er .download answer.json)"
echo "$sha256  omp-linux-x64" | sha256sum -c -
install -m 0755 omp-linux-x64 ${quoted(bin)}
cd /
rm -rf "$tmp"
${quoted(bin)} --version`;
}

/** Builds the template `name` (the recipe `agentTemplate(version, recipe)` at `BUILD_SIZE`) and returns the seconds it took. */
export async function buildTemplate(name: string, version: string, recipe: Recipe, connection: ConnectionOpts, log = false): Promise<number> {
	const started = performance.now();
	await Template.build(agentTemplate(version, recipe), name, {
		...connection,
		...BUILD_SIZE,
		...(log ? { onBuildLogs: defaultBuildLogger() } : {}),
	});
	return (performance.now() - started) / 1000;
}

export interface TemplateOps {
	exists(name: string): Promise<boolean>;
	build(name: string, version: string, recipe: Recipe): Promise<void>;
}

/** The templates `<base>:<version>-<recipe hash>` of the omp versions threads ask for, built on first use. */
export class Templates {
	readonly #base: string;
	readonly #ops: TemplateOps;
	readonly #vmonVersion: () => Promise<string | null>;
	/** The build in progress per template name. */
	readonly #builds = new Map<string, Promise<void>>();

	/** `vmonVersion` reads the installed vmon at each use: an upgrade between two threads gets the new vmon's template. */
	constructor(base: string, ops: TemplateOps, vmonVersion: () => Promise<string | null>) {
		this.#base = base;
		this.#ops = ops;
		this.#vmonVersion = vmonVersion;
	}

	/**
	 * The template of `version`, built first when it does not exist. One build per name at a time (vmon cancels a
	 * template's running builds whose tag overlaps a new build of the name): concurrent callers
	 * wait for the same build, and a failed build rejects each of them (the next call tries again). `onBuilding`
	 * runs for every caller that has to wait for a build, before the wait.
	 */
	async ensure(version: string, recipe: Recipe, onBuilding?: () => void): Promise<string> {
		const name = await templateName(this.#base, version, await this.#vmonVersion(), recipe);
		let build = this.#builds.get(name);
		if (build === undefined) {
			if (await this.#ops.exists(name)) return name;
			// Another caller may have started the build while `exists` was answering.
			build = this.#builds.get(name);
			if (build === undefined) {
				build = this.#ops.build(name, version, recipe).finally(() => this.#builds.delete(name));
				this.#builds.set(name, build);
			}
		}
		onBuilding?.();
		await build;
		return name;
	}

	/**
	 * Builds the template of `version` when it is missing, for a service that just started: the first thread of a vmon or
	 * omp upgrade then finds it ready instead of waiting ~80 s. A thread that arrives meanwhile shares the build. Never
	 * throws: a failure is logged and the first thread builds it again (`ensure`).
	 */
	async prebuild(version: string, recipe: Recipe): Promise<void> {
		try {
			const name = await this.ensure(version, recipe, () => console.log(`omp-cloud: building the VM template for omp ${version} in the background`));
			console.log(`omp-cloud: the VM template ${name} is ready`);
		} catch (error) {
			console.error(`omp-cloud: building the VM template for omp ${version} in the background failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
