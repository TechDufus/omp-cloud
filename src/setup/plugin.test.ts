import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../guards";
import type { HostOmp } from "../omp-version";
import type { LoadVerdict } from "./plugin-probe";
import type { CommandResult, CommandRunner } from "../update/system";
import { ensurePlugin, personalConfigPath, pluginChecks, type PluginOptions, refreshPluginFrom, removePlugin } from "./plugin";

const TOKEN = "svc-token-do-not-print";
const HOST_OMP: HostOmp = { path: "/fake/omp", version: "18.12.3" };

let dir: string;
let tokenFile: string;
let configPath: string;
let fake: FakeOmp;

/** A tar.gz holding what a release carries: `.omp-plugin/marketplace.json` and `plugin/`, at plugin version `version`. */
async function writeBundle(version: string): Promise<{ tar: string }> {
	const files = {
		".omp-plugin/marketplace.json": JSON.stringify({ name: "omp-cloud", plugins: [{ name: "omp-cloud", version, source: "./plugin" }] }),
		"plugin/package.json": JSON.stringify({ name: "omp-cloud", version }),
		"plugin/src/index.ts": `export const version = ${JSON.stringify(version)};\n`,
	};
	const tar = join(dir, `bundle-${version}.tar.gz`);
	await Bun.write(tar, await new Bun.Archive(files, { compress: "gzip" }).bytes());
	return { tar };
}

function catalogVersion(source: string): string {
	const catalog: unknown = JSON.parse(readFileSync(join(source, ".omp-plugin", "marketplace.json"), "utf8"));
	const first: unknown = isRecord(catalog) && Array.isArray(catalog.plugins) ? catalog.plugins[0] : undefined;
	if (!isRecord(first) || typeof first.version !== "string") throw new Error(`no plugin version in the catalog at ${source}`);
	return first.version;
}

/** A valid `service.json` listening on `listen`. */
function serviceJson(listen: string): string {
	return JSON.stringify({
		listen,
		apiTokenSha256: "ab".repeat(32),
		dataDir: join(dir, "data"),
		vmon: { url: "http://127.0.0.1:3000", keyFile: join(dir, "config", "vmon.key"), template: "omp-agent" },
		gateway: { url: "http://10.254.254.1:4000", clientsFile: join(dir, "clients.json") },
		broker: { url: "http://127.0.0.1:8765", tokenFile: join(dir, "broker.token") },
		models: { default: "anthropic/claude-sonnet-5" },
	});
}

/** A stateful stand-in for `omp plugin …`: it reads the real marketplace directory the way omp does, so a wrong `current` link shows. */
class FakeOmp {
	readonly calls: string[] = [];
	marketplaces = new Map<string, string>();
	installed: string | undefined;
	linked: string | undefined;
	/** Argument lines (`marketplace add …`) that fail with this stderr. */
	failing = new Map<string, string>();

	readonly run: CommandRunner = async (argv) => {
		const [program, plugin, ...args] = argv;
		if (program !== HOST_OMP.path || plugin !== "plugin") throw new Error(`unexpected command ${argv.join(" ")}`);
		const line = args.join(" ");
		this.calls.push(line);
		const failure = this.failing.get(line) ?? [...this.failing].find(([prefix]) => line.startsWith(prefix))?.[1];
		if (failure !== undefined) return { code: 1, stdout: "", stderr: `✗ ${failure}\n` };
		return this.answer(args);
	};

	private answer(args: readonly string[]): CommandResult {
		const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
		const refuse = (message: string): CommandResult => ({ code: 1, stdout: "", stderr: `${message}\n` });
		const [verb, ...rest] = args;
		if (verb === "list") {
			const npm = this.linked === undefined ? [] : [{ name: "omp-cloud", version: "0.4.0", path: this.linked, manifest: {}, enabledFeatures: null, enabled: true }];
			const marketplace =
				this.installed === undefined ? [] : [{ id: "omp-cloud@omp-cloud", scope: "user", entries: [{ scope: "user", installPath: "/cache", version: this.installed, installedAt: "", lastUpdated: "" }] }];
			return ok(JSON.stringify({ npm, marketplace }, null, 2));
		}
		if (verb === "link") {
			this.linked = rest[0];
			return ok(`✔ Linked omp-cloud from ${rest[0]}\n`);
		}
		if (verb === "install" || verb === "upgrade") {
			const source = this.marketplaces.get("omp-cloud");
			if (source === undefined) return refuse("Marketplace not found");
			if (verb === "install" && this.installed !== undefined) return refuse("Plugin is already installed");
			if (verb === "upgrade" && this.installed === undefined) return refuse("Plugin is not installed");
			this.installed = catalogVersion(source);
			return ok(`✔ ${verb} ${this.installed}\n`);
		}
		if (verb === "uninstall") {
			if (rest[0] === "omp-cloud@omp-cloud") this.installed = undefined;
			else this.linked = undefined;
			return ok("✔ Uninstalled\n");
		}
		if (verb === "marketplace") {
			const [action, arg] = rest;
			if (action === "list") {
				if (this.marketplaces.size === 0) return ok("No marketplaces configured\n\nAdd one with: omp plugin marketplace add <source>\n");
				return ok(`Configured Marketplaces:\n\n${[...this.marketplaces].map(([name, source]) => `  ${name}  ${source}`).join("\n")}\n`);
			}
			if (action === "add" && arg !== undefined) {
				if (!existsSync(join(arg, ".omp-plugin", "marketplace.json"))) return refuse("✗ Failed to add marketplace: no catalog");
				this.marketplaces.set("omp-cloud", arg);
				return ok(`✔ Added marketplace: ${arg}\n`);
			}
			if (action === "update") return this.marketplaces.has(arg ?? "") ? ok("✔ Updated marketplace\n") : refuse("no such marketplace");
			if (action === "remove") {
				this.marketplaces.delete(arg ?? "");
				return ok("✔ Removed marketplace\n");
			}
		}
		return refuse(`unknown ${args.join(" ")}`);
	}
}

function options(extra: Partial<PluginOptions> = {}): PluginOptions {
	return {
		run: fake.run,
		omp: HOST_OMP,
		mode: "managed",
		appDir: join(dir, "app"),
		version: "0.5.1",
		configPath,
		tokenFile,
		env: {},
		home: join(dir, "home"),
		...extra,
	};
}

const appMarketplace = (...parts: string[]): string => join(dir, "app", "marketplace", ...parts);
const homeConfig = (): string => join(dir, "home", ".config", "omp-cloud", "config.yml");

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-plugin-"));
	fake = new FakeOmp();
	tokenFile = join(dir, "config", "service.token");
	configPath = join(dir, "config", "service.json");
	mkdirSync(join(dir, "config"), { recursive: true });
	writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
	writeFileSync(configPath, serviceJson("127.0.0.1:8080"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const statuses = (steps: readonly { id: string; status: string }[]): string[] => steps.map((step) => `${step.id}:${step.status}`);

describe("ensurePlugin, managed install", () => {
	test("a fresh install extracts the bundle, adds the marketplace from `current`, installs the plugin and writes the config", async () => {
		const steps = await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));

		expect(fake.calls).toEqual([
			"list --json",
			"marketplace list",
			`marketplace add ${appMarketplace("current")}`,
			"install omp-cloud@omp-cloud",
			"list --json",
		]);
		expect(statuses(steps)).toEqual(["plugin.bundle:changed", "plugin.marketplace:changed", "plugin.install:changed", "plugin.config:changed"]);
		expect(steps[2]?.detail).toBe("installed omp-cloud@omp-cloud 0.5.1; restart running omp sessions (/restart) to load it");
		expect(readlinkSync(appMarketplace("current"))).toBe("0.5.1");
		expect(readFileSync(appMarketplace("0.5.1", "plugin", "src", "index.ts"), "utf8")).toBe('export const version = "0.5.1";\n');
		expect(existsSync(appMarketplace("0.5.1", ".omp-plugin", "marketplace.json"))).toBe(true);
		expect(fake.installed).toBe("0.5.1");
	});

	test("a rerun changes nothing: it refreshes the marketplace, upgrades, and every step reports already ok", async () => {
		const bundle = await writeBundle("0.5.1");
		await ensurePlugin(options({ bundle }));
		fake.calls.length = 0;

		const steps = await ensurePlugin(options({ bundle }));
		expect(fake.calls).toEqual(["list --json", "marketplace list", "marketplace update omp-cloud", "upgrade omp-cloud@omp-cloud", "list --json"]);
		expect(statuses(steps)).toEqual(["plugin.bundle:ok", "plugin.marketplace:ok", "plugin.install:ok", "plugin.config:ok"]);
		expect(steps[2]?.detail).toBe("omp-cloud@omp-cloud 0.5.1 is up to date");
	});

	test("a newer binary extracts its bundle beside the old one, moves `current` and upgrades; only one older version is kept", async () => {
		await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		fake.calls.length = 0;

		const steps = await ensurePlugin(options({ version: "0.6.0", bundle: await writeBundle("0.6.0") }));
		expect(statuses(steps)).toEqual(["plugin.bundle:changed", "plugin.marketplace:ok", "plugin.install:changed", "plugin.config:ok"]);
		expect(steps[2]?.detail).toBe("upgraded omp-cloud@omp-cloud 0.5.1 -> 0.6.0; restart running omp sessions (/restart) to load it");
		expect(fake.installed).toBe("0.6.0");
		expect(readlinkSync(appMarketplace("current"))).toBe("0.6.0");
		expect((await readdir(appMarketplace())).sort()).toEqual(["0.5.1", "0.6.0", "current"]);

		await ensurePlugin(options({ version: "0.7.0", bundle: await writeBundle("0.7.0") }));
		expect((await readdir(appMarketplace())).sort()).toEqual(["0.6.0", "0.7.0", "current"]);
	});

	test("a marketplace that came from somewhere else is refreshed, and the step says it is not the binary's bundle", async () => {
		fake.marketplaces.set("omp-cloud", "github:TechDufus/omp-cloud");
		fake.installed = "0.4.0";
		// The catalog the fake reads for that source: a directory, as omp would have cloned.
		const clone = join(dir, "clone");
		mkdirSync(join(clone, ".omp-plugin"), { recursive: true });
		writeFileSync(join(clone, ".omp-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "omp-cloud", version: "0.4.0" }] }));
		fake.marketplaces.set("omp-cloud", clone);

		const steps = await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		expect(fake.calls).toContain("marketplace update omp-cloud");
		expect(fake.calls.some((call) => call.startsWith("marketplace add"))).toBe(false);
		expect(steps.find((step) => step.id === "plugin.marketplace")?.detail).toBe(`refreshed the omp-cloud marketplace (from ${clone}, not this binary's bundle)`);
	});

	test("a plugin the user linked is left alone: no extraction, no marketplace, no install, and it is reported", async () => {
		fake.linked = "/home/ada/src/omp-cloud/plugin";
		const steps = await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		expect(fake.calls).toEqual(["list --json"]);
		expect(existsSync(appMarketplace())).toBe(false);
		expect(steps[0]).toEqual({
			id: "plugin.install",
			status: "skipped",
			detail: "omp-cloud is linked from /home/ada/src/omp-cloud/plugin; left alone, so omp-cloud updates do not move it",
		});
		expect(steps[1]?.id).toBe("plugin.config");
	});

	test("without omp nothing runs and the step says how to install it; the config is still written", async () => {
		const steps = await ensurePlugin(options({ omp: undefined, bundle: await writeBundle("0.5.1") }));
		expect(fake.calls).toEqual([]);
		expect(steps[0]).toMatchObject({ id: "plugin.install", status: "skipped" });
		expect(steps[0]?.detail).toContain("curl -fsSL https://omp.sh/install | sh");
		expect(statuses(steps)).toEqual(["plugin.install:skipped", "plugin.config:changed"]);
		expect(existsSync(homeConfig())).toBe(true);
	});

	test("a failing marketplace add stops before the install and names the command to retry", async () => {
		fake.failing.set("marketplace add", "Failed to add marketplace: boom");
		const steps = await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		expect(statuses(steps)).toEqual(["plugin.bundle:changed", "plugin.marketplace:failed", "plugin.config:changed"]);
		expect(steps[1]?.detail).toBe(`omp plugin marketplace add ${appMarketplace("current")} failed: ✗ Failed to add marketplace: boom`);
		expect(steps[1]?.fix).toBe(`omp plugin marketplace add ${appMarketplace("current")}`);
		expect(fake.calls.some((call) => call.startsWith("install"))).toBe(false);
	});

	test("a failing install is a failed step with its fix", async () => {
		fake.failing.set("install", "Plugin is already installed");
		const steps = await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		expect(steps.find((step) => step.id === "plugin.install")).toMatchObject({ status: "failed", fix: "omp plugin install omp-cloud@omp-cloud" });
	});

	test("a failing `plugin list` is one failed step that points at omp's doctor", async () => {
		fake.failing.set("list --json", "database is locked");
		const steps = await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		expect(steps).toEqual([
			{ id: "plugin.install", status: "failed", detail: "omp plugin list --json failed: ✗ database is locked", fix: "omp plugin doctor --fix" },
		]);
		expect(existsSync(homeConfig())).toBe(false);
	});

	test("a binary without a bundle (a checkout run as managed) fails the bundle step and runs no more omp commands", async () => {
		const steps = await ensurePlugin(options({ bundle: null }));
		expect(steps[0]).toMatchObject({ id: "plugin.bundle", status: "failed", fix: "omp-cloud setup" });
		expect(steps[0]?.detail).toContain("no plugin bundle");
		expect(fake.calls).toEqual(["list --json"]);
	});

	test("a half-extracted directory of an interrupted run is replaced, never taken for the plugin", async () => {
		mkdirSync(appMarketplace("0.5.1.partial", "plugin"), { recursive: true });
		writeFileSync(appMarketplace("0.5.1.partial", "plugin", "stale.ts"), "x");
		await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		expect((await readdir(appMarketplace())).sort()).toEqual(["0.5.1", "current"]);
		expect(existsSync(appMarketplace("0.5.1", "plugin", "stale.ts"))).toBe(false);
	});

	test("a bundle without the marketplace catalog is refused and leaves no version directory", async () => {
		const tar = join(dir, "broken.tar.gz");
		await Bun.write(tar, await new Bun.Archive({ "plugin/package.json": "{}" }, { compress: "gzip" }).bytes());
		const steps = await ensurePlugin(options({ bundle: { tar } }));
		expect(steps[0]).toMatchObject({ id: "plugin.bundle", status: "failed" });
		expect(steps[0]?.detail).toContain(".omp-plugin/marketplace.json");
		expect(existsSync(appMarketplace("0.5.1"))).toBe(false);
	});
});

describe("ensurePlugin, checkout mode", () => {
	const repoRoot = "/home/ada/src/omp-cloud";

	test("links <repo>/plugin when nothing is linked, extracting no bundle", async () => {
		const steps = await ensurePlugin(options({ mode: "checkout", repoRoot, bundle: null }));
		expect(fake.calls).toEqual(["list --json", `link ${repoRoot}/plugin`]);
		expect(statuses(steps)).toEqual(["plugin.link:changed", "plugin.config:changed"]);
		expect(steps[0]?.detail).toBe(`linked ${repoRoot}/plugin; restart running omp sessions (/restart) to load it`);
		expect(existsSync(appMarketplace())).toBe(false);
	});

	test("an existing link is left as it is, and says where it points when that is somewhere else", async () => {
		fake.linked = `${repoRoot}/plugin`;
		expect((await ensurePlugin(options({ mode: "checkout", repoRoot })))[0]).toEqual({ id: "plugin.link", status: "ok", detail: "omp-cloud is linked" });
		fake.linked = "/elsewhere/plugin";
		expect((await ensurePlugin(options({ mode: "checkout", repoRoot })))[0]?.detail).toBe("omp-cloud is linked from /elsewhere/plugin");
		expect(fake.calls.some((call) => call.startsWith("link"))).toBe(false);
	});

	test("a marketplace install is not mixed with a link: the step is skipped and says how to switch", async () => {
		fake.installed = "0.5.0";
		const steps = await ensurePlugin(options({ mode: "checkout", repoRoot }));
		expect(steps[0]).toMatchObject({ id: "plugin.link", status: "skipped" });
		expect(steps[0]?.detail).toContain("omp plugin uninstall omp-cloud@omp-cloud");
		expect(fake.calls).toEqual(["list --json"]);
	});

	test("a failing link is a failed step with its fix", async () => {
		fake.failing.set("link", "not a plugin");
		const steps = await ensurePlugin(options({ mode: "checkout", repoRoot }));
		expect(steps[0]).toMatchObject({ id: "plugin.link", status: "failed", fix: `omp plugin link ${repoRoot}/plugin` });
	});
});

describe("config.yml", () => {
	test("written when absent: the url from service.json, the token read from service.token, mode 0600, and never the token itself", async () => {
		const steps = await ensurePlugin(options({ omp: undefined }));
		const file = homeConfig();
		expect(steps.at(-1)).toEqual({ id: "plugin.config", status: "changed", detail: `wrote ${file} (url http://127.0.0.1:8080; the token is read from ${tokenFile})` });
		const text = readFileSync(file, "utf8");
		expect(text).toContain('url: "http://127.0.0.1:8080"\n');
		expect(text).toContain(`token: "!cat ${tokenFile}"\n`);
		expect(text).not.toContain(TOKEN);
		expect(JSON.stringify(steps)).not.toContain(TOKEN);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(Bun.YAML.parse(text)).toEqual({ url: "http://127.0.0.1:8080", token: `!cat ${tokenFile}` });
	});

	test("present: never overwritten or read, however it looks", async () => {
		mkdirSync(join(dir, "home", ".config", "omp-cloud"), { recursive: true });
		writeFileSync(homeConfig(), "token: '!op read op://vault/omp-cloud/token'\n");
		const steps = await ensurePlugin(options({ omp: undefined }));
		expect(steps.at(-1)).toEqual({ id: "plugin.config", status: "ok", detail: `${homeConfig()} exists; not touched` });
		expect(readFileSync(homeConfig(), "utf8")).toBe("token: '!op read op://vault/omp-cloud/token'\n");
	});

	test("XDG_CONFIG_HOME decides where it goes, as the plugin reads it", async () => {
		const xdg = join(dir, "xdg");
		const steps = await ensurePlugin(options({ omp: undefined, env: { XDG_CONFIG_HOME: xdg } }));
		expect(steps.at(-1)?.status).toBe("changed");
		expect(existsSync(join(xdg, "omp-cloud", "config.yml"))).toBe(true);
		expect(existsSync(homeConfig())).toBe(false);
		expect(personalConfigPath({ XDG_CONFIG_HOME: xdg }, "/home/ada")).toBe(join(xdg, "omp-cloud", "config.yml"));
		expect(personalConfigPath({ XDG_CONFIG_HOME: "" }, "/home/ada")).toBe("/home/ada/.config/omp-cloud/config.yml");
		expect(personalConfigPath({}, "/home/ada")).toBe("/home/ada/.config/omp-cloud/config.yml");
	});

	test("a token path with spaces or quotes is quoted for the shell that runs the !command", async () => {
		const odd = join(dir, "it's here", "service.token");
		mkdirSync(join(dir, "it's here"), { recursive: true });
		writeFileSync(odd, TOKEN);
		await ensurePlugin(options({ omp: undefined, tokenFile: odd }));
		expect(Bun.YAML.parse(readFileSync(homeConfig(), "utf8"))).toEqual({ url: "http://127.0.0.1:8080", token: `!cat '${odd.replaceAll("'", "'\\''")}'` });
	});

	test("an IPv6 loopback listen is bracketed in the url", async () => {
		writeFileSync(configPath, serviceJson("[::1]:9090"));
		await ensurePlugin(options({ omp: undefined }));
		expect(readFileSync(homeConfig(), "utf8")).toContain('url: "http://[::1]:9090"');
	});

	test("without a service.token nothing is written and the step says what to set instead", async () => {
		await rm(tokenFile);
		const steps = await ensurePlugin(options({ omp: undefined }));
		expect(steps.at(-1)).toMatchObject({ id: "plugin.config", status: "skipped" });
		expect(steps.at(-1)?.detail).toContain("OMP_CLOUD_TOKEN");
		expect(existsSync(homeConfig())).toBe(false);
	});

	test("an unreadable service.json is a failed step and writes nothing", async () => {
		writeFileSync(configPath, "{ not json");
		const steps = await ensurePlugin(options({ omp: undefined }));
		expect(steps.at(-1)).toMatchObject({ id: "plugin.config", status: "failed", fix: "omp-cloud setup" });
		expect(existsSync(homeConfig())).toBe(false);
	});
});

describe("removePlugin", () => {
	test("a managed install: uninstall, remove the marketplace, remove the extracted bundle; config.yml stays", async () => {
		await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		fake.calls.length = 0;

		const steps = await removePlugin(options());
		expect(fake.calls).toEqual(["list --json", "uninstall omp-cloud@omp-cloud", "marketplace list", "marketplace remove omp-cloud"]);
		expect(statuses(steps)).toEqual(["plugin.uninstall:changed", "plugin.marketplace:changed", "plugin.bundle:changed"]);
		expect(existsSync(appMarketplace())).toBe(false);
		expect(existsSync(homeConfig())).toBe(true);
		expect(fake.installed).toBeUndefined();
		expect(fake.marketplaces.size).toBe(0);
	});

	test("nothing installed is already ok", async () => {
		const steps = await removePlugin(options());
		expect(statuses(steps)).toEqual(["plugin.uninstall:ok", "plugin.marketplace:ok"]);
	});

	test("a marketplace setup did not add, and a linked plugin in a managed install, stay", async () => {
		fake.marketplaces.set("omp-cloud", "/home/ada/clone");
		fake.linked = "/home/ada/src/omp-cloud/plugin";
		const steps = await removePlugin(options());
		expect(statuses(steps)).toEqual(["plugin.uninstall:skipped", "plugin.marketplace:skipped"]);
		expect(fake.calls.some((call) => call.startsWith("uninstall") || call.startsWith("marketplace remove"))).toBe(false);
	});

	test("a linked plugin in a checkout is unlinked", async () => {
		fake.linked = "/home/ada/src/omp-cloud/plugin";
		const steps = await removePlugin(options({ mode: "checkout" }));
		expect(fake.calls).toContain("uninstall omp-cloud");
		expect(steps[0]).toEqual({ id: "plugin.uninstall", status: "changed", detail: "unlinked omp-cloud" });
		expect(fake.linked).toBeUndefined();
	});

	test("without omp there is nothing to run, and the bundle still goes", async () => {
		await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		fake.calls.length = 0;
		const steps = await removePlugin(options({ omp: undefined }));
		expect(fake.calls).toEqual([]);
		expect(statuses(steps)).toEqual(["plugin.uninstall:skipped", "plugin.bundle:changed"]);
	});

	test("a failing uninstall is a failed step with its fix", async () => {
		fake.installed = "0.5.1";
		fake.failing.set("uninstall", "locked");
		const steps = await removePlugin(options());
		expect(steps[0]).toMatchObject({ id: "plugin.uninstall", status: "failed", fix: "omp plugin uninstall omp-cloud@omp-cloud" });
	});
});

describe("pluginChecks", () => {
	const served = (patterns: string[]) => async (url: string) => {
		expect(url).toBe("http://127.0.0.1:8080/api/v1/whoami");
		return Response.json({ modelPatterns: patterns });
	};

	test("a healthy install reports omp, the marketplace plugin and its version, the config and the providers", async () => {
		await ensurePlugin(options({ bundle: await writeBundle("0.5.1") }));
		const steps = await pluginChecks({
			run: fake.run,
			omp: HOST_OMP,
			env: {},
			home: join(dir, "home"),
			serviceUrl: "http://127.0.0.1:8080",
			tokenFile,
			fetch: served(["anthropic/*", "openai-codex/*"]),
			probe: async () => ({ state: "loads" }),
		});
		expect(steps).toEqual([
			{ id: "plugin.omp", status: "ok", detail: "omp 18.12.3 at /fake/omp" },
			{ id: "plugin.installed", status: "ok", detail: "omp-cloud@omp-cloud 0.5.1 (marketplace)" },
			{ id: "plugin.loads", status: "ok", detail: "omp loads omp-cloud 0.5.1 (/cloud is registered)" },
			{ id: "plugin.config", status: "ok", detail: `${homeConfig()} is present` },
			{ id: "plugin.providers", status: "ok", detail: "the cloud can run anthropic, openai-codex" },
		]);
	});

	test("the call carries the service token as a bearer", async () => {
		let authorization = "";
		await pluginChecks({
			run: fake.run,
			omp: HOST_OMP,
			home: dir,
			env: {},
			serviceUrl: "http://127.0.0.1:8080",
			tokenFile,
			fetch: async (_url, init) => {
				authorization = new Headers(init.headers).get("authorization") ?? "";
				return Response.json({ modelPatterns: [] });
			},
		});
		expect(authorization).toBe(`Bearer ${TOKEN}`);
	});

	test("a linked plugin is reported as linked", async () => {
		fake.linked = "/home/ada/src/omp-cloud/plugin";
		const steps = await pluginChecks({ run: fake.run, omp: HOST_OMP, env: {}, home: dir });
		expect(steps.find((step) => step.id === "plugin.installed")).toEqual({ id: "plugin.installed", status: "ok", detail: "omp-cloud is linked from /home/ada/src/omp-cloud/plugin" });
	});

	test("omp missing, the plugin missing, the config missing and no provider each fail with a fix", async () => {
		const noOmp = await pluginChecks({ run: fake.run, omp: undefined, env: {}, home: dir });
		expect(noOmp[0]).toEqual({ id: "plugin.omp", status: "failed", detail: "omp is not installed", fix: "curl -fsSL https://omp.sh/install | sh" });
		expect(noOmp.find((step) => step.id === "plugin.config")).toMatchObject({ status: "failed", fix: "omp-cloud setup" });
		expect(noOmp.some((step) => step.id === "plugin.installed")).toBe(false);

		const steps = await pluginChecks({ run: fake.run, omp: HOST_OMP, env: {}, home: dir, serviceUrl: "http://127.0.0.1:8080", tokenFile, fetch: served([]) });
		expect(steps.find((step) => step.id === "plugin.installed")).toMatchObject({ status: "failed", fix: "omp-cloud setup" });
		expect(steps.find((step) => step.id === "plugin.providers")).toEqual({ id: "plugin.providers", status: "skipped", detail: "no model provider yet; log in: omp-cloud login <provider>" });
	});

	test("a service that cannot be asked skips the provider check instead of failing the plugin", async () => {
		const steps = await pluginChecks({
			run: fake.run,
			omp: HOST_OMP,
			env: {},
			home: dir,
			serviceUrl: "http://127.0.0.1:8080",
			tokenFile,
			fetch: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		expect(steps.at(-1)).toMatchObject({ id: "plugin.providers", status: "skipped" });
		expect(steps.at(-1)?.detail).toContain("ECONNREFUSED");
	});

	test("it only reads: no install, no link, no write", async () => {
		await pluginChecks({ run: fake.run, omp: HOST_OMP, env: {}, home: join(dir, "home") });
		expect(fake.calls).toEqual(["list --json"]);
		expect(existsSync(homeConfig())).toBe(false);
	});

	describe("plugin.loads", () => {
		const loads = async (verdict: LoadVerdict, ompVersion = HOST_OMP.version) => {
			const asked: string[] = [];
			const steps = await pluginChecks({
				run: fake.run,
				omp: { path: HOST_OMP.path, version: ompVersion },
				env: {},
				home: dir,
				probe: async (ompPath) => {
					asked.push(ompPath);
					return verdict;
				},
			});
			return { step: steps.find((step) => step.id === "plugin.loads"), steps, asked };
		};

		test("an installed plugin that omp loads is ok with its version, and the probe asked the host omp", async () => {
			fake.installed = "0.5.1";
			const { step, asked } = await loads({ state: "loads" });
			expect(step).toEqual({ id: "plugin.loads", status: "ok", detail: "omp loads omp-cloud 0.5.1 (/cloud is registered)" });
			expect(asked).toEqual([HOST_OMP.path]);
		});

		test("a plugin that fails to load on a new enough omp says to update omp-cloud and to report the error, never to update omp", async () => {
			fake.installed = "0.5.1";
			const { step } = await loads({ state: "broken", reason: "Cannot find package '@oh-my-pi/pi-coding-agent'" });
			expect(step).toMatchObject({ id: "plugin.loads", status: "failed" });
			expect(step?.detail).toBe("omp does not load omp-cloud 0.5.1: Cannot find package '@oh-my-pi/pi-coding-agent'");
			expect(step?.fix).toBe("update omp-cloud (omp-cloud update), then rerun omp-cloud setup; if it still fails, report this error");
		});

		test("only an omp older than the plugin's minimum (18.12.3) is told to update omp", async () => {
			fake.installed = "0.5.1";
			const old = await loads({ state: "broken", reason: "no job-widget" }, "18.12.2");
			expect(old.step?.fix).toBe("update omp (omp update), then rerun omp-cloud setup");
			const exact = await loads({ state: "broken", reason: "no job-widget" }, "18.12.3");
			expect(exact.step?.fix).toContain("omp-cloud update");
			const newer = await loads({ state: "broken", reason: "no job-widget" }, "19.0.0");
			expect(newer.step?.fix).toContain("omp-cloud update");
		});

		test("a probe that learned nothing is skipped, never a failure", async () => {
			fake.installed = "0.5.1";
			const { step } = await loads({ state: "unknown", reason: "omp gave no answer within 20 s" });
			expect(step).toEqual({ id: "plugin.loads", status: "skipped", detail: "could not check that omp loads the plugin: omp gave no answer within 20 s" });
		});

		test("a linked plugin is probed and reports the version in its package.json", async () => {
			const linked = join(dir, "linked-plugin");
			mkdirSync(linked, { recursive: true });
			writeFileSync(join(linked, "package.json"), '{ "name": "omp-cloud", "version": "0.6.0-dev" }');
			fake.linked = linked;
			const { step } = await loads({ state: "loads" });
			expect(step?.detail).toBe("omp loads omp-cloud 0.6.0-dev (/cloud is registered)");
		});

		test("no plugin installed means no probe; omp missing is skipped with a note", async () => {
			const none = await loads({ state: "loads" });
			expect(none.step).toBeUndefined();
			expect(none.asked).toEqual([]);
			const missing = await pluginChecks({ run: fake.run, omp: undefined, env: {}, home: dir });
			expect(missing.find((step) => step.id === "plugin.loads")).toEqual({ id: "plugin.loads", status: "skipped", detail: "omp is not installed, so the plugin cannot be checked" });
		});
	});
});

describe("refreshPluginFrom", () => {
	const ran = (result: Partial<CommandResult>): { run: CommandRunner; calls: string[][] } => {
		const calls: string[][] = [];
		return {
			calls,
			run: async (argv) => {
				calls.push([...argv]);
				return { code: 0, stdout: "", stderr: "", ...result };
			},
		};
	};

	test("runs `<binary> setup plugin` and answers with its last line", async () => {
		const fakeRun = ran({ stdout: "✓ plugin.bundle  extracted\n· plugin.config  ok\n" });
		expect(await refreshPluginFrom("/app/versions/0.5.1/omp-cloud", fakeRun.run)).toBe("· plugin.config  ok");
		expect(fakeRun.calls).toEqual([["/app/versions/0.5.1/omp-cloud", "setup", "plugin"]]);
	});

	test("a failure rejects with the first failed step's line, not the hint under it", async () => {
		const fakeRun = ran({ code: 1, stderr: "✗ plugin.marketplace  omp plugin marketplace update omp-cloud failed: no network\n    fix: omp plugin marketplace add /x\n" });
		await expect(refreshPluginFrom("/b", fakeRun.run)).rejects.toThrow("✗ plugin.marketplace  omp plugin marketplace update omp-cloud failed: no network");
	});

	test("a failure without a step line rejects with whatever it printed", async () => {
		await expect(refreshPluginFrom("/b", ran({ code: 124, stderr: "" }).run)).rejects.toThrow("exit 124");
	});
});
