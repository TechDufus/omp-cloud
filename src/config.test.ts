import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig, parseConfig } from "./config";

const HASH = "ab".repeat(32);

const FAKE = { baseUrl: "http://127.0.0.1:1/v1", auth: "none", api: "openai-completions", models: [{ id: "m" }] };

function validRaw(): Record<string, unknown> {
	return {
		listen: "127.0.0.1:8080",
		apiTokenSha256: HASH,
		dataDir: "/srv/omp-cloud/data",
		vmon: { url: "http://127.0.0.1:3000", keyFile: "/etc/omp-cloud/vmon.key", template: "omp-agent" },
		gateway: { url: "http://10.254.254.1:4000", clientsFile: "/srv/omp-cloud/clients.json" },
		broker: { url: "http://127.0.0.1:8765", tokenFile: "/srv/omp-cloud/broker.token" },
		models: { default: "anthropic/claude-sonnet-5", direct: { fake: FAKE } },
	};
}

interface RawConfig {
	[key: string]: unknown;
	vmon: Record<string, unknown>;
	gateway: Record<string, unknown>;
}

/** `validRaw()` with `mutate` applied. */
function rawWith(mutate: (raw: RawConfig) => void): unknown {
	const raw = validRaw() as RawConfig;
	mutate(raw);
	return raw;
}

describe("parseConfig", () => {
	test("a valid config round trips", () => {
		const expected: Config = {
			listen: { hostname: "127.0.0.1", port: 8080 },
			apiTokenSha256: HASH,
			dataDir: "/srv/omp-cloud/data",
			vmon: { url: "http://127.0.0.1:3000", keyFile: "/etc/omp-cloud/vmon.key", template: "omp-agent" },
			gateway: { url: "http://10.254.254.1:4000", clientsFile: "/srv/omp-cloud/clients.json" },
			broker: { url: "http://127.0.0.1:8765", tokenFile: "/srv/omp-cloud/broker.token" },
			models: { default: "anthropic/claude-sonnet-5", direct: { fake: FAKE } },
			runner: {
				enabled: true,
				idleTimeoutSeconds: 600,
				turnTimeoutSeconds: 1800,
				questionTimeoutSeconds: 1800,
				sandboxTimeoutSeconds: 3600,
				lifecycleSweepSeconds: 3600,
			},
			git: { hosts: {}, fetchTimeoutSeconds: 120, pushTimeoutSeconds: 120 },
		};
		expect(parseConfig(validRaw())).toEqual(expected);
	});

	test("IPv6 listen is returned without brackets", () => {
		const config = parseConfig({ ...validRaw(), listen: "[::1]:9090" });
		expect(config.listen).toEqual({ hostname: "::1", port: 9090 });
	});

	test("upper-case hash is normalized to lower case", () => {
		const config = parseConfig({ ...validRaw(), apiTokenSha256: HASH.toUpperCase() });
		expect(config.apiTokenSha256).toBe(HASH);
	});

	test("trailing slashes are cut from URLs, paths are normalized", () => {
		const config = parseConfig(
			rawWith(raw => {
				raw.vmon.url = "https://vmon.example/";
				raw.dataDir = "/srv/omp-cloud/../omp-cloud/data/";
			}),
		);
		expect(config.vmon.url).toBe("https://vmon.example");
		expect(config.dataDir).toBe("/srv/omp-cloud/data");
	});

	test("vmon.team is optional: absent stays absent, a slug is returned", () => {
		expect(parseConfig(validRaw()).vmon).not.toHaveProperty("team");
		const config = parseConfig(
			rawWith(raw => {
				raw.vmon.team = "omp-cloud";
			}),
		);
		expect(config.vmon.team).toBe("omp-cloud");
	});

	test.each(["", "Acme", "-lead", "has space", "a".repeat(64), 5, null])("vmon.team %p is rejected and named", team => {
		expect(() =>
			parseConfig(
				rawWith(raw => {
					raw.vmon.team = team;
				}),
			),
		).toThrow("vmon.team");
	});

	test.each([
		["listen", (raw: Record<string, unknown>) => delete raw.listen],
		["apiTokenSha256", (raw: Record<string, unknown>) => delete raw.apiTokenSha256],
		["dataDir", (raw: Record<string, unknown>) => delete raw.dataDir],
		["vmon", (raw: Record<string, unknown>) => delete raw.vmon],
		["vmon.url", (raw: Record<string, unknown>) => delete (raw.vmon as Record<string, unknown>).url],
		["vmon.keyFile", (raw: Record<string, unknown>) => delete (raw.vmon as Record<string, unknown>).keyFile],
		["vmon.template", (raw: Record<string, unknown>) => delete (raw.vmon as Record<string, unknown>).template],
		["gateway", (raw: Record<string, unknown>) => delete raw.gateway],
		["broker", (raw: Record<string, unknown>) => delete raw.broker],
		["models", (raw: Record<string, unknown>) => delete raw.models],
		["gateway.url", (raw: Record<string, unknown>) => delete (raw.gateway as Record<string, unknown>).url],
		[
			"gateway.clientsFile",
			(raw: Record<string, unknown>) => delete (raw.gateway as Record<string, unknown>).clientsFile,
		],
	])("missing %s is rejected and named", (field, remove) => {
		const raw = validRaw();
		remove(raw);
		expect(() => parseConfig(raw)).toThrow(field);
	});

	test("unknown keys are rejected at every level", () => {
		expect(() => parseConfig({ ...validRaw(), extra: 1 })).toThrow("extra");
		expect(() =>
			parseConfig(
				rawWith(raw => {
					raw.vmon.extra = 1;
				}),
			),
		).toThrow("vmon.extra");
		expect(() =>
			parseConfig(
				rawWith(raw => {
					raw.gateway.extra = 1;
				}),
			),
		).toThrow("gateway.extra");
	});

	test("non-object config and sections are rejected", () => {
		expect(() => parseConfig(null)).toThrow();
		expect(() => parseConfig([])).toThrow();
		expect(() => parseConfig({ ...validRaw(), vmon: "x" })).toThrow("vmon");
	});

	test.each(["127.0.0.1", "localhost:", ":8080", "[::1]", "::1:8080", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:http", "127.0.0.1:80x", "127.0.0.1:-1"])(
		"bad listen %p is rejected",
		listen => {
			expect(() => parseConfig({ ...validRaw(), listen })).toThrow("listen");
		},
	);

	test("port bounds 1 and 65535 are accepted", () => {
		expect(parseConfig({ ...validRaw(), listen: "localhost:1" }).listen).toEqual({ hostname: "localhost", port: 1 });
		expect(parseConfig({ ...validRaw(), listen: "localhost:65535" }).listen.port).toBe(65535);
	});

	test("relative paths are rejected with the field path", () => {
		expect(() => parseConfig({ ...validRaw(), dataDir: "data" })).toThrow("dataDir must be an absolute path");
		expect(() =>
			parseConfig(
				rawWith(raw => {
					raw.vmon.keyFile = "vmon.key";
				}),
			),
		).toThrow("vmon.keyFile must be an absolute path");
		expect(() =>
			parseConfig(
				rawWith(raw => {
					raw.gateway.clientsFile = "./clients.json";
				}),
			),
		).toThrow("gateway.clientsFile must be an absolute path");
	});

	test("non-http URLs are rejected", () => {
		for (const url of ["ftp://host/", "file:///etc/passwd", "not a url", "host:3000"]) {
			expect(() =>
				parseConfig(
					rawWith(raw => {
						raw.vmon.url = url;
					}),
				),
			).toThrow("vmon.url");
			expect(() =>
				parseConfig(
					rawWith(raw => {
						raw.gateway.url = url;
					}),
				),
			).toThrow("gateway.url");
		}
	});

	test.each(["", "ab".repeat(31), "ab".repeat(33), `${"ab".repeat(31)}zz`, 12])("bad hash %p is rejected", hash => {
		expect(() => parseConfig({ ...validRaw(), apiTokenSha256: hash })).toThrow("apiTokenSha256");
	});

	test.each(["", "omp agent", " omp-agent", 7])("bad template %p is rejected", template => {
		expect(() =>
			parseConfig(
				rawWith(raw => {
					raw.vmon.template = template;
				}),
			),
		).toThrow("vmon.template");
	});

	test("models is required, with default", () => {
		const raw = validRaw();
		delete raw.models;
		expect(() => parseConfig(raw)).toThrow("models");
		expect(() => parseConfig({ ...validRaw(), models: {} })).toThrow("models.default is required");
		expect(() => parseConfig({ ...validRaw(), models: { default: "fake/m", extra: 1 } })).toThrow("models.extra");
	});

	test("direct defaults to empty", () => {
		expect(parseConfig({ ...validRaw(), models: { default: "anthropic/x" } }).models).toEqual({ default: "anthropic/x", direct: {} });
		expect(parseConfig(validRaw()).models.direct).toEqual({ fake: FAKE });
	});

	test.each(["apiKey", "headers", "authHeader", "APIKEY", "Headers"])("a credential key %p in a direct provider is rejected", key => {
		const models = { default: "fake/m", direct: { fake: { ...FAKE, [key]: "secret-value" } } };
		const error = (() => {
			try {
				parseConfig({ ...validRaw(), models });
			} catch (e) {
				return e as Error;
			}
			return null;
		})();
		expect(error?.message).toContain("models.direct.fake");
		expect(error?.message).not.toContain("secret-value");
	});

	test("a credential key nested in a direct provider is rejected", () => {
		const models = { default: "fake/m", direct: { fake: { ...FAKE, models: [{ id: "m", headers: { a: "b" } }] } } };
		expect(() => parseConfig({ ...validRaw(), models })).toThrow("headers");
	});

	test("a direct provider needs an http(s) baseUrl", () => {
		for (const baseUrl of [undefined, "ftp://x", "nope", 3]) {
			const models = { default: "fake/m", direct: { fake: { ...FAKE, baseUrl } } };
			expect(() => parseConfig({ ...validRaw(), models })).toThrow("models.direct.fake.baseUrl");
		}
	});

	test("models.gateway is gone: the gateway's own model list says which providers it serves", () => {
		expect(() => parseConfig({ ...validRaw(), models: { default: "anthropic/x", gateway: ["anthropic"] } })).toThrow("models.gateway is not a known key");
	});

	test("provider names of direct must be well formed", () => {
		expect(() => parseConfig({ ...validRaw(), models: { default: "a/b", direct: { "A!": FAKE } } })).toThrow("models.direct");
	});

	test("the broker section is required, with an http(s) url and an absolute token file", () => {
		const config = parseConfig(
			rawWith(raw => {
				raw.broker = { url: "http://127.0.0.1:8765/", tokenFile: "/srv/omp-cloud/../omp-cloud/broker.token" };
			}),
		);
		expect(config.broker).toEqual({ url: "http://127.0.0.1:8765", tokenFile: "/srv/omp-cloud/broker.token" });
		for (const [field, mutate] of [
			["broker", (raw: RawConfig) => delete raw.broker],
			["broker.url", (raw: RawConfig) => delete (raw.broker as Record<string, unknown>).url],
			["broker.tokenFile", (raw: RawConfig) => delete (raw.broker as Record<string, unknown>).tokenFile],
		] as const) {
			expect(() => parseConfig(rawWith(mutate))).toThrow(`${field} is required`);
		}
		for (const url of ["ftp://host/", "not a url", "host:8765", 7]) {
			expect(() => parseConfig(rawWith(raw => void (raw.broker = { url, tokenFile: "/t" })))).toThrow("broker.url");
		}
		expect(() => parseConfig(rawWith(raw => void (raw.broker = { url: "http://b", tokenFile: "t" })))).toThrow(
			"broker.tokenFile must be an absolute path",
		);
		expect(() => parseConfig(rawWith(raw => void (raw.broker = { url: "http://b", tokenFile: "/t", extra: 1 })))).toThrow("broker.extra");
	});

	test.each(["fake", "fake/", "/m", "fake/ m", 3])("default model %p must be provider/id", model => {
		expect(() => parseConfig({ ...validRaw(), models: { default: model, direct: { fake: FAKE } } })).toThrow("models.default");
	});

	test("a default model of a provider that is not direct is accepted: the gateway may serve it", () => {
		expect(parseConfig({ ...validRaw(), models: { default: "other/m", direct: { fake: FAKE } } }).models.default).toBe("other/m");
	});

	test("runner defaults apply when absent or partial", () => {
		const defaults = {
			enabled: true,
			idleTimeoutSeconds: 600,
			turnTimeoutSeconds: 1800,
			questionTimeoutSeconds: 1800,
			sandboxTimeoutSeconds: 3600,
			lifecycleSweepSeconds: 3600,
		};
		expect(parseConfig(validRaw()).runner).toEqual(defaults);
		expect(parseConfig({ ...validRaw(), runner: {} }).runner).toEqual(defaults);
		expect(parseConfig({ ...validRaw(), runner: { enabled: false, idleTimeoutSeconds: 5 } }).runner).toEqual({
			...defaults,
			enabled: false,
			idleTimeoutSeconds: 5,
		});
	});

	test.each(["idleTimeoutSeconds", "turnTimeoutSeconds", "questionTimeoutSeconds", "sandboxTimeoutSeconds", "lifecycleSweepSeconds"])(
		"runner.%s must be a positive integer",
		key => {
			for (const value of [0, -1, 1.5, "60", null]) {
				expect(() => parseConfig({ ...validRaw(), runner: { [key]: value } })).toThrow(`runner.${key}`);
			}
			expect(parseConfig({ ...validRaw(), runner: { [key]: 1 } }).runner[key as "idleTimeoutSeconds"]).toBe(1);
		},
	);

	test("sandboxTimeoutSeconds is at most 86400", () => {
		expect(parseConfig({ ...validRaw(), runner: { sandboxTimeoutSeconds: 86400 } }).runner.sandboxTimeoutSeconds).toBe(86400);
		expect(() => parseConfig({ ...validRaw(), runner: { sandboxTimeoutSeconds: 86401 } })).toThrow("runner.sandboxTimeoutSeconds");
	});

	test("runner.enabled must be a boolean and unknown runner keys are rejected", () => {
		expect(() => parseConfig({ ...validRaw(), runner: { enabled: "no" } })).toThrow("runner.enabled");
		expect(() => parseConfig({ ...validRaw(), runner: { extra: 1 } })).toThrow("runner.extra");
		expect(() => parseConfig({ ...validRaw(), runner: "x" })).toThrow("runner");
	});

	test.each(["idleTimeoutSeconds", "turnTimeoutSeconds", "questionTimeoutSeconds", "lifecycleSweepSeconds"])("runner.%s is at most 2147483 (the setTimeout limit)", key => {
		expect(parseConfig({ ...validRaw(), runner: { [key]: 2147483 } }).runner[key as "idleTimeoutSeconds"]).toBe(2147483);
		expect(() => parseConfig({ ...validRaw(), runner: { [key]: 2147484 } })).toThrow(`runner.${key} must be at most 2147483`);
	});

	test("the dashboard section is optional", () => {
		expect(parseConfig(validRaw()).dashboard).toBeUndefined();
	});

	test("a dashboard listens on loopback, with an optional origin url", () => {
		expect(parseConfig({ ...validRaw(), dashboard: { listen: "127.0.0.1:8081" } }).dashboard).toEqual({
			listen: { hostname: "127.0.0.1", port: 8081 },
		});
		expect(parseConfig({ ...validRaw(), dashboard: { listen: "localhost:8081", url: "http://localhost:8081/" } }).dashboard).toEqual({
			listen: { hostname: "localhost", port: 8081 },
			url: "http://localhost:8081",
		});
		expect(parseConfig({ ...validRaw(), dashboard: { listen: "[::1]:8081" } }).dashboard?.listen).toEqual({ hostname: "::1", port: 8081 });
	});

	test.each(["0.0.0.0:8081", "10.254.254.1:8081", "192.168.1.5:8081", "example.com:8081", "[::]:8081"])(
		"a non-loopback dashboard.listen %p is rejected",
		listen => {
			expect(() => parseConfig({ ...validRaw(), dashboard: { listen } })).toThrow("dashboard.listen must be a loopback address");
		},
	);

	test("dashboard.listen is required and malformed values name the field", () => {
		expect(() => parseConfig({ ...validRaw(), dashboard: {} })).toThrow("dashboard.listen is required");
		expect(() => parseConfig({ ...validRaw(), dashboard: { listen: "127.0.0.1" } })).toThrow("dashboard.listen must be host:port");
		expect(() => parseConfig({ ...validRaw(), dashboard: { listen: "127.0.0.1:0" } })).toThrow("dashboard.listen port");
		expect(() => parseConfig({ ...validRaw(), dashboard: { listen: "127.0.0.1:8081", extra: 1 } })).toThrow("dashboard.extra");
		expect(() => parseConfig({ ...validRaw(), dashboard: "x" })).toThrow("dashboard");
	});

	test.each(["ftp://x/", "not a url", "http://localhost:8081/ui", "http://localhost:8081/?a=1", 7])("a bad dashboard.url %p is rejected", url => {
		expect(() => parseConfig({ ...validRaw(), dashboard: { listen: "127.0.0.1:8081", url } })).toThrow("dashboard.url");
	});

	test("the mcp section is optional and takes an IP address and port", () => {
		expect(parseConfig(validRaw()).mcp).toBeUndefined();
		expect(parseConfig({ ...validRaw(), mcp: { listen: "10.254.254.1:4100" } }).mcp).toEqual({ listen: { hostname: "10.254.254.1", port: 4100 } });
		expect(parseConfig({ ...validRaw(), mcp: { listen: "[fd00::1]:4100" } }).mcp?.listen).toEqual({ hostname: "fd00::1", port: 4100 });
	});

	test.each(["gateway.internal:4100", "localhost:4100", "0.0.0.0:4100", "[::]:4100"])("mcp.listen %p is refused: a host name or a wildcard", listen => {
		expect(() => parseConfig({ ...validRaw(), mcp: { listen } })).toThrow("mcp.listen must be");
	});

	test("mcp.listen is required and malformed values name the field", () => {
		expect(() => parseConfig({ ...validRaw(), mcp: {} })).toThrow("mcp.listen is required");
		expect(() => parseConfig({ ...validRaw(), mcp: { listen: "10.254.254.1" } })).toThrow("mcp.listen must be host:port");
		expect(() => parseConfig({ ...validRaw(), mcp: { listen: "10.254.254.1:4100", extra: 1 } })).toThrow("mcp.extra");
	});
});

describe("git", () => {
	const HOST = { credential: "!gh auth token" };

	test("without the section the service has no hosts and the default timeouts", () => {
		expect(parseConfig(validRaw()).git).toEqual({ hosts: {}, fetchTimeoutSeconds: 120, pushTimeoutSeconds: 120 });
	});

	test("hosts carry a credential reference and a username that defaults to x-access-token", () => {
		const config = parseConfig({
			...validRaw(),
			git: {
				hosts: { "github.com": HOST, "127.0.0.1:8080": { credential: "!op read op://v/i/p", username: "ci" }, "[::1]:9": HOST },
				fetchTimeoutSeconds: 30,
				pushTimeoutSeconds: 45,
			},
		});
		expect(config.git).toEqual({
			hosts: {
				"github.com": { credential: "!gh auth token", username: "x-access-token" },
				"127.0.0.1:8080": { credential: "!op read op://v/i/p", username: "ci" },
				"[::1]:9": { credential: "!gh auth token", username: "x-access-token" },
			},
			fetchTimeoutSeconds: 30,
			pushTimeoutSeconds: 45,
		});
	});

	test.each([
		["a literal token", { hosts: { "github.com": { credential: "ghp_abcdef" } } }, "git.hosts.github.com.credential"],
		["an empty command", { hosts: { "github.com": { credential: "!" } } }, "git.hosts.github.com.credential"],
		["a missing credential", { hosts: { "github.com": {} } }, "git.hosts.github.com.credential is required"],
		["an unknown host key", { hosts: { "github.com": { ...HOST, token: "x" } } }, "git.hosts.github.com.token"],
		["an upper-case host", { hosts: { "GitHub.com": HOST } }, "git.hosts.GitHub.com must be a lower-case host"],
		["a host with a path", { hosts: { "github.com/acme": HOST } }, "git.hosts.github.com/acme must be a lower-case host"],
		["a url as host", { hosts: { "https://github.com": HOST } }, "must be a lower-case host"],
		["a username with a space", { hosts: { "github.com": { ...HOST, username: "a b" } } }, "git.hosts.github.com.username"],
		["a non-string username", { hosts: { "github.com": { ...HOST, username: 7 } } }, "git.hosts.github.com.username"],
		["hosts that is not an object", { hosts: "github.com" }, "git.hosts must be an object"],
		["a zero timeout", { fetchTimeoutSeconds: 0 }, "git.fetchTimeoutSeconds must be a positive integer"],
		["a timeout past the timer limit", { fetchTimeoutSeconds: 2147484 }, "git.fetchTimeoutSeconds must be at most 2147483"],
		["a zero push timeout", { pushTimeoutSeconds: 0 }, "git.pushTimeoutSeconds must be a positive integer"],
		["a push timeout past the timer limit", { pushTimeoutSeconds: 2147484 }, "git.pushTimeoutSeconds must be at most 2147483"],
		["an unknown key", { push: "auto" }, "git.push is not a known key"],
	])("%s is rejected and named", (_label, git, message) => {
		expect(() => parseConfig({ ...validRaw(), git })).toThrow(message);
	});

	test("a section that is not an object is rejected", () => {
		expect(() => parseConfig({ ...validRaw(), git: "x" })).toThrow("git must be an object");
	});
});

describe("loadConfig", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("reads and parses a config file", async () => {
		const path = join(dir, "service.json");
		await Bun.write(path, JSON.stringify({ ...validRaw(), listen: "[::1]:8081" }));
		const config = await loadConfig(path);
		expect(config.listen).toEqual({ hostname: "::1", port: 8081 });
		expect(config.dataDir).toBe("/srv/omp-cloud/data");
	});

	test("invalid JSON is rejected naming the path, not the contents", async () => {
		const path = join(dir, "service.json");
		await Bun.write(path, "{ not-json hunter2");
		const error = await loadConfig(path).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain(path);
		expect(message).not.toContain("hunter2");
	});

	test("an invalid config is rejected naming the path and the field", async () => {
		const path = join(dir, "service.json");
		await Bun.write(path, JSON.stringify({ ...validRaw(), dataDir: "relative" }));
		const error = await loadConfig(path).then(
			() => null,
			(e: unknown) => e,
		);
		expect((error as Error).message).toContain(path);
		expect((error as Error).message).toContain("dataDir");
	});

	test("a missing file is rejected naming the path", async () => {
		const path = join(dir, "absent.json");
		await expect(loadConfig(path)).rejects.toThrow(path);
	});
});
