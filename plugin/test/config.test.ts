import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudLines, knownClouds, notConfigured, readConfig, resolveConnection, statusLines, tilde, type CloudConfig, type ConfigInput } from "../src/config";
import { writeConnectionFile, type PairedConnection } from "../src/connection";
import { UserError } from "../src/types";
import { cleanup, tmp } from "./helpers";
import { deviceToken, makeCert, PAIRING_DEVICE } from "./tls";

afterEach(async () => {
	delete process.env.CLOUD_TEST_TOKEN;
	await cleanup();
});

interface Layout {
	home: string;
	repo: string;
	/** `<home>/.config/omp-cloud/config.yml`, where the personal file is with nothing in the environment. */
	personal: string;
	/** `<repo>/.omp-cloud.yml`. */
	repoFile: string;
}

/** A home and a repository in temp directories, with the files written that the arguments give. */
async function layout(files: { personal?: string; repo?: string } = {}): Promise<Layout> {
	const home = await tmp("omp-cloud-home-");
	const repo = await tmp("omp-cloud-repo-");
	const personal = join(home, ".config", "omp-cloud", "config.yml");
	const repoFile = join(repo, ".omp-cloud.yml");
	if (files.personal !== undefined) {
		await mkdir(join(home, ".config", "omp-cloud"), { recursive: true });
		await writeFile(personal, files.personal);
	}
	if (files.repo !== undefined) await writeFile(repoFile, files.repo);
	return { home, repo, personal, repoFile };
}

const read = (l: Layout, over: Partial<ConfigInput> = {}): Promise<CloudConfig> =>
	readConfig({ env: {}, home: l.home, repoRoot: l.repo, platform: "linux", ...over });

const failure = async (p: Promise<unknown>): Promise<string> => {
	const err = await p.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(UserError);
	return (err as UserError).message;
};

describe("readConfig", () => {
	test("no files and an empty environment: everything is empty, nothing was read", async () => {
		const l = await layout();
		expect(await read(l)).toEqual({
			url: undefined,
			urlFrom: undefined,
			token: undefined,
			personalUrl: undefined,
			personalToken: undefined,
			tokenFrom: undefined,
			ignored: [],
			excludeExtensions: [],
			secretFiles: [],
			secretEnv: [],
			policy: {},
			setup: undefined,
			deliver: "tray",
			deliverFrom: undefined,
			personalFile: l.personal,
			repoFile: undefined,
			warnings: [],
			home: l.home,
			connectionFile: join(l.home, ".config", "omp-cloud", "connection.json"),
		});
	});

	test("the personal file supplies every setting; the url loses trailing slashes", async () => {
		const l = await layout({
			personal: [
				"url: http://u.example///",
				'token: "!printf tok"',
				"excludeExtensions: [herd.ts]",
				"secretFiles: [.env]",
				"secretEnv: [A, B]",
				"policy:",
				"  fetch: false",
				"  spend.turnUSD: 0.5",
			].join("\n"),
		});
		expect(await read(l)).toMatchObject({
			url: "http://u.example",
			urlFrom: "personal",
			token: "!printf tok",
			tokenFrom: "personal",
			ignored: [],
			excludeExtensions: ["herd.ts"],
			secretFiles: [".env"],
			secretEnv: ["A", "B"],
			policy: { fetch: false, "spend.turnUSD": 0.5 },
			repoFile: undefined,
			warnings: [],
		});
	});

	test("an empty file, or one of comments, is an empty configuration", async () => {
		const l = await layout({ personal: "# nothing yet\n", repo: "" });
		expect(await read(l)).toMatchObject({ url: undefined, repoFile: l.repoFile, warnings: [] });
	});

	test("blank urls and tokens are unset", async () => {
		const l = await layout({ personal: 'url: "  "\ntoken: ""\n' });
		expect(await read(l)).toMatchObject({ url: undefined, urlFrom: undefined, token: undefined, tokenFrom: undefined, warnings: [] });
	});

	test("OMP_CLOUD_URL and OMP_CLOUD_TOKEN beat the personal file and are the origin env", async () => {
		const l = await layout({ personal: "url: http://file.example\ntoken: file-token\n" });
		const cfg = await read(l, { env: { OMP_CLOUD_URL: "http://e.example/", OMP_CLOUD_TOKEN: "etok" } });
		expect(cfg).toMatchObject({ url: "http://e.example", urlFrom: "env", token: "etok", tokenFrom: "env" });
	});

	test("each of url and token comes from the environment or the file on its own, and a blank variable is unset", async () => {
		const l = await layout({ personal: "url: http://file.example\ntoken: file-token\n" });
		const cfg = await read(l, { env: { OMP_CLOUD_URL: "http://e.example", OMP_CLOUD_TOKEN: "  " } });
		expect(cfg).toMatchObject({ url: "http://e.example", urlFrom: "env", token: "file-token", tokenFrom: "personal" });
	});

	test("the repository file's url and token are ignored and reported, never their values", async () => {
		const l = await layout({
			personal: "url: http://personal.example\ntoken: personal-token\n",
			repo: "url: http://evil.example\ntoken: evil-token\nsecretEnv: [X]\n",
		});
		const cfg = await read(l);
		expect(cfg).toMatchObject({ url: "http://personal.example", token: "personal-token", ignored: ["url", "token"], repoFile: l.repoFile, secretEnv: ["X"], warnings: [] });
		expect(JSON.stringify(cfg)).not.toContain("evil");
	});

	test("a repository url with no personal one leaves the cloud unconfigured, and the message names both files without the value", async () => {
		const l = await layout({ personal: "token: t\n", repo: "url: http://evil.example\n" });
		const cfg = await read(l);
		expect(cfg).toMatchObject({ url: undefined, urlFrom: undefined, ignored: ["url"] });
		const message = notConfigured(cfg);
		expect(message).toContain("set url and token in ~/.config/omp-cloud/config.yml (");
		expect(message).toContain(`url in ${l.repoFile} is ignored`);
		expect(message).not.toContain("evil.example");
	});

	test("an ignored repository key keeps its position whatever the order in the file, and counts whatever its type", async () => {
		const l = await layout({ repo: "token: [1]\nurl: 3\n" });
		const cfg = await read(l);
		expect(cfg).toMatchObject({ ignored: ["url", "token"], warnings: [] });
	});

	test("the lists of the personal and repository files are concatenated without duplicates", async () => {
		const l = await layout({
			personal: "excludeExtensions: [a.ts, b.ts]\nsecretFiles: [.env, .env.local]\nsecretEnv: [A, B]\n",
			repo: "excludeExtensions: [b.ts, c.ts]\nsecretFiles: [.env.local, .env.test]\nsecretEnv: [B, C, C]\n",
		});
		expect(await read(l)).toMatchObject({
			excludeExtensions: ["a.ts", "b.ts", "c.ts"],
			secretFiles: [".env", ".env.local", ".env.test"],
			secretEnv: ["A", "B", "C"],
		});
	});

	test("the repository's policy keys lie over the personal record key by key", async () => {
		const l = await layout({
			personal: "policy:\n  fetch: true\n  browser: false\n  egress: [a.example]\n",
			repo: [
				"policy:",
				"  fetch: false",
				"  spend.turnUSD: 0.5",
				"  bash.patterns:",
				"    - { match: 'touch /tmp/x*', approval: deny }",
			].join("\n"),
		});
		expect((await read(l)).policy).toEqual({
			fetch: false,
			browser: false,
			egress: ["a.example"],
			"spend.turnUSD": 0.5,
			"bash.patterns": [{ match: "touch /tmp/x*", approval: "deny" }],
		});
	});

	test("without a repository root there is no repository file, even when one sits in the working directory", async () => {
		const l = await layout({ repo: "secretEnv: [X]\n" });
		const cfg = await read(l, { repoRoot: undefined });
		expect(cfg).toMatchObject({ secretEnv: [], repoFile: undefined });
	});

	test("unknown keys and values of the wrong type are ignored and reported as warnings naming the file and the key", async () => {
		const l = await layout({
			personal: ["url: 3", "token: [secret-marker]", "colour: secret-marker", "secretFiles: secret-marker", "policy: [secret-marker]"].join("\n"),
			repo: ["excludeExtensions: [ok.ts, 3, '']", "secretEnv: {A: secret-marker}", "other: 1"].join("\n"),
		});
		const cfg = await read(l);
		expect(cfg).toMatchObject({ url: undefined, token: undefined, secretFiles: [], policy: {}, excludeExtensions: ["ok.ts"], secretEnv: [] });
		expect(cfg.warnings).toEqual([
			`${l.personal}: url is not a string, ignored`,
			`${l.personal}: token is not a string, ignored`,
			`${l.personal}: colour is not a known key, ignored`,
			`${l.personal}: secretFiles is not a list, ignored`,
			`${l.personal}: policy is not a mapping, ignored`,
			`${l.repoFile}: excludeExtensions has entries that are not non-empty strings, those entries are ignored`,
			`${l.repoFile}: secretEnv is not a list, ignored`,
			`${l.repoFile}: other is not a known key, ignored`,
		]);
		expect(cfg.warnings.join("\n")).not.toContain("secret-marker");
	});

	test("the old cloud: block of omp's config.yml is not read", async () => {
		const l = await layout();
		await mkdir(join(l.home, ".omp", "agent"), { recursive: true });
		await writeFile(join(l.home, ".omp", "agent", "config.yml"), "cloud:\n  url: http://old.example\n  token: old\n");
		expect(await read(l)).toMatchObject({ url: undefined, token: undefined });
	});

	test("setup is read from the repository file with its cacheFiles, or without them", async () => {
		const withFiles = await layout({ repo: "setup:\n  run: |\n    bun install\n    bun run build\n  cacheFiles: [bun.lock, package.json, bun.lock]\n" });
		expect(await read(withFiles)).toMatchObject({ setup: { run: "bun install\nbun run build\n", cacheFiles: ["bun.lock", "package.json"] }, warnings: [] });
		const plain = await layout({ repo: "setup:\n  run: make deps\n" });
		expect(await read(plain)).toMatchObject({ setup: { run: "make deps", cacheFiles: undefined }, warnings: [] });
		expect((await read(await layout({ repo: "setup:\n  run: x\n  cacheFiles: []\n" }))).setup).toEqual({ run: "x", cacheFiles: [] });
	});

	test("setup in the personal file warns and is not used", async () => {
		const l = await layout({ personal: "setup:\n  run: make deps\n" });
		const cfg = await read(l);
		expect(cfg.setup).toBeUndefined();
		expect(cfg.warnings).toEqual([`${l.personal}: setup belongs in a repository's .omp-cloud.yml, ignored`]);
	});

	test("a setup that does not fit is ignored with a warning that never quotes the script", async () => {
		const cases: [string, string][] = [
			["setup: make", "is not a mapping with run and cacheFiles, ignored"],
			["setup:\n  cacheFiles: [a]\n", "needs run: a non-empty script, ignored"],
			["setup:\n  run: '  '\n", "needs run: a non-empty script, ignored"],
			[`setup:\n  run: ${"x".repeat(16385)}\n`, "run is longer than 16384 characters, ignored"],
			["setup:\n  run: x\n  extra: 1\n", "has an unknown key extra, ignored"],
			["setup:\n  run: x\n  cacheFiles: lock\n", "cacheFiles must be a list of at most 32 paths, ignored"],
			[`setup:\n  run: x\n  cacheFiles: [${Array.from({ length: 33 }, (_, i) => `f${i}`).join(", ")}]\n`, "cacheFiles must be a list of at most 32 paths, ignored"],
			["setup:\n  run: x\n  cacheFiles: [/etc/passwd]\n", "cacheFiles must hold relative repository paths, ignored"],
			["setup:\n  run: x\n  cacheFiles: ['../x']\n", "cacheFiles must hold relative repository paths, ignored"],
		];
		for (const [file, why] of cases) {
			const l = await layout({ repo: file });
			const cfg = await read(l);
			expect(cfg.setup).toBeUndefined();
			expect(cfg.warnings).toEqual([`${l.repoFile}: setup ${why}`]);
		}
	});
});

describe("a file that cannot be used is a UserError naming it", () => {
	test("the personal file is not valid YAML", async () => {
		const l = await layout({ personal: "url: [unclosed\n" });
		expect(await failure(read(l))).toContain(`${l.personal} is not valid YAML`);
	});

	test("the repository file is not valid YAML", async () => {
		const l = await layout({ personal: "url: http://u.example\n", repo: "secretEnv: [unclosed\n" });
		expect(await failure(read(l))).toContain(`${l.repoFile} is not valid YAML`);
	});

	test("the top level is a list or a scalar, not a mapping", async () => {
		for (const personal of ["- url\n- token\n", "just text\n"]) {
			const l = await layout({ personal });
			expect(await failure(read(l))).toContain(`${l.personal} must hold a mapping of settings at the top level`);
		}
		const l = await layout({ repo: "[a, b]\n" });
		expect(await failure(read(l))).toContain(`${l.repoFile} must hold a mapping of settings at the top level`);
	});

	test("a path that is a directory cannot be read", async () => {
		const l = await layout();
		await mkdir(l.personal, { recursive: true });
		expect(await failure(read(l))).toContain(`${l.personal} cannot be read`);
	});
});

describe("where the personal file is", () => {
	test("<home>/.config/omp-cloud/config.yml without XDG_CONFIG_HOME", async () => {
		const l = await layout();
		expect((await read(l)).personalFile).toBe(join(l.home, ".config", "omp-cloud", "config.yml"));
	});

	test("$XDG_CONFIG_HOME/omp-cloud/config.yml when it is set, and it is the file that is read", async () => {
		const l = await layout({ personal: "url: http://home.example\n" });
		const xdg = await tmp("omp-cloud-xdg-");
		await mkdir(join(xdg, "omp-cloud"));
		await writeFile(join(xdg, "omp-cloud", "config.yml"), "url: http://xdg.example\n");
		const cfg = await read(l, { env: { XDG_CONFIG_HOME: xdg } });
		expect(cfg).toMatchObject({ personalFile: join(xdg, "omp-cloud", "config.yml"), url: "http://xdg.example" });
	});

	test("an empty XDG_CONFIG_HOME is not set", async () => {
		const l = await layout();
		expect((await read(l, { env: { XDG_CONFIG_HOME: "" } })).personalFile).toBe(l.personal);
	});

	test("%APPDATA%\\omp-cloud\\config.yml on Windows, <home>/AppData/Roaming without it, XDG_CONFIG_HOME first", async () => {
		const l = await layout();
		const appdata = await tmp("omp-cloud-appdata-");
		await mkdir(join(appdata, "omp-cloud"));
		await writeFile(join(appdata, "omp-cloud", "config.yml"), "url: http://appdata.example\n");
		const onWindows = await read(l, { platform: "win32", env: { APPDATA: appdata } });
		expect(onWindows).toMatchObject({ personalFile: join(appdata, "omp-cloud", "config.yml"), url: "http://appdata.example" });
		expect((await read(l, { platform: "win32" })).personalFile).toBe(join(l.home, "AppData", "Roaming", "omp-cloud", "config.yml"));
		expect((await read(l, { platform: "win32", env: { APPDATA: appdata, XDG_CONFIG_HOME: "/xdg" } })).personalFile).toBe(join("/xdg", "omp-cloud", "config.yml"));
		expect((await read(l, { platform: "linux", env: { APPDATA: appdata } })).personalFile).toBe(l.personal);
	});
});

describe("showing the configuration", () => {
	test("tilde writes the home as ~ and leaves other paths alone", () => {
		expect(tilde("/home/me/.config/omp-cloud/config.yml", "/home/me")).toBe("~/.config/omp-cloud/config.yml");
		expect(tilde("/home/me", "/home/me")).toBe("~");
		expect(tilde("/home/medium/x", "/home/me")).toBe("/home/medium/x");
		expect(tilde("/srv/x", "/home/me")).toBe("/srv/x");
	});

	test("the status rows name the origins, never the token, then the repository file and the warnings", async () => {
		const l = await layout({
			personal: "url: http://u.example\ntoken: super-secret\nnope: 1\n",
			repo: "url: http://evil.example\n",
		});
		const rows = statusLines(await read(l));
		expect(rows).toEqual([
			"  url: http://u.example (~/.config/omp-cloud/config.yml) · the repository's value is ignored",
			"  token: set (~/.config/omp-cloud/config.yml)",
			"  deliver: tray (default)",
			`  repository file: ${l.repoFile}`,
			`  warning: ${l.personal}: nope is not a known key, ignored`,
		]);
	});

	test("the personal file shows with ~ when it is under the home, and the environment as env", async () => {
		const l = await layout({ personal: "url: http://u.example\ntoken: t\n" });
		const rows = statusLines(await read(l, { env: { OMP_CLOUD_TOKEN: "etok" } }));
		expect(rows[0]).toBe(`  url: http://u.example (${tilde(l.personal, l.home)})`);
		expect(rows[0]).toContain("(~/.config/omp-cloud/config.yml)");
		expect(rows[1]).toBe("  token: set (env)");
	});

	test("unset url and token say so, and deliver reads tray by default", async () => {
		expect(statusLines(await read(await layout()))).toEqual(["  url: not set", "  token: not set", "  deliver: tray (default)"]);
	});

	test("deliver: the personal file sets it; the status row names where; a repository file's value is ignored with a warning", async () => {
		const l = await layout({ personal: "url: http://u.example\ntoken: t\ndeliver: transcript\n", repo: "deliver: transcript\n" });
		const cfg = await read(l);
		expect(cfg).toMatchObject({ deliver: "transcript", deliverFrom: "personal" });
		expect(statusLines(cfg)).toContain("  deliver: transcript (~/.config/omp-cloud/config.yml)");
		expect(cfg.warnings).toEqual([`${l.repoFile}: deliver is a personal setting, ignored`]);

		const repoOnly = await read(await layout({ repo: "deliver: transcript\n" }));
		expect(repoOnly).toMatchObject({ deliver: "tray", deliverFrom: undefined });
	});

	test("deliver: a value that is neither tray nor transcript is ignored and reported", async () => {
		const l = await layout({ personal: "deliver: toast\n" });
		const cfg = await read(l);
		expect(cfg.deliver).toBe("tray");
		expect(cfg.warnings).toEqual([`${l.personal}: deliver is not tray or transcript, ignored`]);
	});

	test("not configured names the personal file's real path, the example and the environment variables", async () => {
		const l = await layout();
		const xdg = await tmp("omp-cloud-xdg-");
		expect(notConfigured(await read(l))).toBe(
			'☁ omp-cloud is not configured: set url and token in ~/.config/omp-cloud/config.yml (for example token: "!cat ~/.config/omp-cloud/service.token"), or OMP_CLOUD_URL and OMP_CLOUD_TOKEN; or pair this machine with /cloud connect <code | user@host>',
		);
		expect(notConfigured(await read(l, { env: { XDG_CONFIG_HOME: xdg } }))).toContain(`set url and token in ${join(xdg, "omp-cloud", "config.yml")} (`);
	});
});

describe("resolveConnection", () => {
	const connect = async (personal: string, env: ConfigInput["env"] = {}) => resolveConnection(await read(await layout({ personal }), { env }));

	test("a !command token is resolved by omp and its output trimmed", async () => {
		expect(await connect('url: https://u.example\ntoken: "!printf \'tok\\n\'"\n')).toEqual({ url: "https://u.example", token: "tok", source: "personal", paired: undefined, ignoredToken: undefined });
	});

	test("a token that names an environment variable resolves to its value; anything else is a literal", async () => {
		process.env.CLOUD_TEST_TOKEN = "from-env";
		expect((await connect("url: https://u.example\ntoken: CLOUD_TEST_TOKEN\n")).token).toBe("from-env");
		expect((await connect("url: https://u.example\ntoken: literal-token\n")).token).toBe("literal-token");
	});

	test("the environment alone is a whole connection", async () => {
		expect(await connect("", { OMP_CLOUD_URL: "https://e.example/", OMP_CLOUD_TOKEN: "etok" })).toEqual({ url: "https://e.example", token: "etok", source: "env", paired: undefined, ignoredToken: undefined });
	});

	test("a missing url or token is the not-configured error", async () => {
		for (const personal of ["", "url: https://u.example\n", "token: t\n"]) {
			const l = await layout({ personal });
			const cfg = await read(l);
			expect(await failure(resolveConnection(cfg))).toBe(notConfigured(cfg));
		}
	});

	test("with only a repository url the error says it was ignored", async () => {
		const l = await layout({ personal: "token: t\n", repo: "url: http://evil.example\n" });
		const message = await failure(resolveConnection(await read(l)));
		expect(message).toContain(`url in ${l.repoFile} is ignored`);
		expect(message).not.toContain("evil.example");
	});

	test("a token command that prints nothing is reported with its origin and without echoing the command", async () => {
		const l = await layout({ personal: "url: https://u.example\ntoken: \"!printf '' secret-marker\"\n" });
		const message = await failure(resolveConnection(await read(l)));
		expect(message).toContain("token (~/.config/omp-cloud/config.yml) resolved to nothing");
		expect(message).not.toContain("secret-marker");
	});
});

/** A valid paired connection written beside the personal file of `l`; its first address is `address`. */
async function pair(l: Layout, address = "10.0.0.5:8443"): Promise<PairedConnection> {
	const cert = await makeCert("server");
	const connection: PairedConnection = {
		server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses: [address] },
		device: PAIRING_DEVICE,
		token: deviceToken(),
		pairedAt: "2026-10-20T00:00:00.000Z",
	};
	await writeConnectionFile(join(l.home, ".config", "omp-cloud", "connection.json"), connection);
	return connection;
}

describe("the clouds of a machine and the session's choice", () => {
	const BOTH = "url: https://personal.example\ntoken: ptok\n";
	const ENV = { OMP_CLOUD_URL: "https://env.example/", OMP_CLOUD_TOKEN: "etok" };

	test("knownClouds lists env, personal and paired in that order, each with where it is configured", async () => {
		const l = await layout({ personal: BOTH });
		const connection = await pair(l);
		const known = await knownClouds(await read(l, { env: ENV }));
		expect(known).toEqual([
			{ source: "env", url: "https://env.example", where: "OMP_CLOUD_URL" },
			{ source: "personal", url: "https://personal.example", where: "url in ~/.config/omp-cloud/config.yml" },
			{ source: "paired", url: "https://10.0.0.5:8443", where: `paired device ${connection.device.name}, ~/.config/omp-cloud/connection.json` },
		]);
	});

	test("a personal url the environment overrides is still a cloud of its own", async () => {
		const l = await layout({ personal: BOTH });
		expect((await knownClouds(await read(l))).map(c => c.source)).toEqual(["personal"]);
		expect((await knownClouds(await read(l, { env: ENV }))).map(c => c.source)).toEqual(["env", "personal"]);
	});

	test("nothing configured lists no cloud", async () => {
		expect(await knownClouds(await read(await layout()))).toEqual([]);
	});

	test("a connection file that does not validate is listed without a url, with the reason", async () => {
		const l = await layout({ personal: BOTH });
		await writeFile(join(l.home, ".config", "omp-cloud", "connection.json"), "{ not json");
		const paired = (await knownClouds(await read(l))).find(c => c.source === "paired");
		expect(paired?.url).toBe("");
		expect(paired?.where).toStartWith("~/.config/omp-cloud/connection.json does not validate: ");
	});

	test("a chosen personal cloud uses the file's own url and token, whatever the environment says", async () => {
		const l = await layout({ personal: BOTH });
		const cfg = await read(l, { env: ENV });
		expect(await resolveConnection(cfg)).toMatchObject({ url: "https://env.example", token: "etok", source: "env" });
		expect(await resolveConnection(cfg, "personal")).toEqual({ url: "https://personal.example", token: "ptok", source: "personal", paired: undefined, ignoredToken: undefined });
		expect(await resolveConnection(cfg, "env")).toMatchObject({ url: "https://env.example", token: "etok", source: "env" });
	});

	test("a chosen personal cloud without a token says where to set one", async () => {
		const l = await layout({ personal: "url: https://personal.example\n" });
		const cfg = await read(l, { env: { OMP_CLOUD_TOKEN: "etok" } });
		expect(await failure(resolveConnection(cfg, "personal"))).toBe(
			'☁ url in ~/.config/omp-cloud/config.yml has no token: set token there (for example token: "!cat ~/.config/omp-cloud/service.token")',
		);
	});

	test("a chosen paired cloud is used whole even when a url is configured, and no ignored token is reported", async () => {
		const l = await layout({ personal: BOTH });
		const connection = await pair(l);
		const conn = await resolveConnection(await read(l), "paired");
		expect(conn).toMatchObject({ url: "https://10.0.0.5:8443", token: connection.token, source: "paired", ignoredToken: undefined });
	});

	test("a chosen source this machine no longer has is an error that names the way out", async () => {
		const l = await layout({ personal: BOTH });
		const cfg = await read(l);
		for (const gone of ["env", "paired"] as const) {
			expect(await failure(resolveConnection(cfg, gone))).toBe(
				`☁ omp-cloud is not configured for this session: it uses ${gone}, which this machine no longer has (/cloud use picks another, /cloud connect pairs a server)`,
			);
		}
		expect(await failure(resolveConnection(await read(await layout()), "personal"))).toContain("it uses personal, which this machine no longer has");
	});

	test("cloudLines: none configured; the default and why; a choice; the other clouds", async () => {
		expect(cloudLines(await read(await layout()), [], undefined, false)).toEqual(["cloud: none configured on this machine"]);

		const l = await layout({ personal: BOTH });
		await pair(l);
		const cfg = await read(l);
		const known = await knownClouds(cfg);
		const others = "other clouds: paired https://10.0.0.5:8443 (paired device laptop-2, ~/.config/omp-cloud/connection.json)";
		expect(cloudLines(cfg, known, "personal", false)).toEqual(["cloud: personal · https://personal.example · the default (url in ~/.config/omp-cloud/config.yml)", others]);
		expect(cloudLines(cfg, known, "personal", true)[0]).toBe("cloud: personal · https://personal.example · this session's choice");

		const envCfg = await read(l, { env: ENV });
		expect(cloudLines(envCfg, await knownClouds(envCfg), "env", false)[0]).toBe("cloud: env · https://env.example · the default (OMP_CLOUD_URL is set)");

		const only = await layout();
		await pair(only);
		const onlyCfg = await read(only);
		expect(cloudLines(onlyCfg, await knownClouds(onlyCfg), "paired", false)).toEqual(["cloud: paired · https://10.0.0.5:8443 · the default (the paired server; no url configured)"]);
	});
});
