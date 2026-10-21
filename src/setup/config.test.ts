import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config";
import { defaultServiceConfig, ensureDirs, ensureGatewayClients, ensureServiceConfig, migrateServiceConfig, readVmonKey, recordedTeam, type SetupPaths, setupPaths, writeVmonKey } from "./config";

let dir: string;
let paths: SetupPaths;
beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-cloud-setup-config-")));
	paths = setupPaths({ HOME: dir }, "tester");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

/** A current service.json without the broker, dashboard and remote sections. */
function withoutSections(): Record<string, unknown> {
	const { broker: _broker, dashboard: _dashboard, remote: _remote, ...rest } = defaultServiceConfig(paths, "a".repeat(64), "omp-cloud");
	return rest;
}

describe("setupPaths", () => {
	test("honours HOME, XDG_CONFIG_HOME (units only) and OMP_CLOUD_APP_DIR", () => {
		const custom = setupPaths({ HOME: "/h", XDG_CONFIG_HOME: "/x", OMP_CLOUD_APP_DIR: "/opt/app" }, "u");
		expect(custom.configDir).toBe("/h/.config/omp-cloud");
		expect(custom.unitDir).toBe("/x/systemd/user");
		expect(custom.appDir).toBe("/opt/app");
		expect(custom.authHome).toBe("/h/.local/share/omp-cloud/auth-home");
		expect(setupPaths({ HOME: "/h" }, "u").appDir).toBe("/h/.local/share/omp-cloud/app");
	});
});

describe("defaultServiceConfig", () => {
	test("is the layout setup writes plus vmon.team, and the service accepts it", () => {
		const config = defaultServiceConfig(paths, "d".repeat(64), "omp-cloud");
		expect(() => parseConfig(config)).not.toThrow();
		expect(parseConfig(config).vmon.team).toBe("omp-cloud");
		expect(Object.keys(config)).toEqual(["listen", "apiTokenSha256", "dataDir", "vmon", "gateway", "broker", "dashboard", "remote", "models"]);
	});
});

describe("migrateServiceConfig", () => {
	test("adds the broker, dashboard and remote sections a document lacks", () => {
		const { config, notes } = migrateServiceConfig(withoutSections(), paths);
		expect(config.broker).toEqual({ url: "http://127.0.0.1:8765", tokenFile: join(paths.authHome, ".omp", "auth-broker.token") });
		expect(config.dashboard).toEqual({ listen: "127.0.0.1:8081" });
		expect(config.remote).toEqual({ listen: "0.0.0.0:8443", certFile: join(paths.tlsDir, "cert.pem"), keyFile: join(paths.tlsDir, "key.pem") });
		expect(notes).toHaveLength(3);
	});

	test("a current document is returned as it is, and the input is not modified", () => {
		const complete = defaultServiceConfig(paths, "d".repeat(64), "omp-cloud");
		const copy = structuredClone(complete);
		expect(migrateServiceConfig(complete, paths)).toEqual({ config: complete, notes: [] });
		expect(complete).toEqual(copy);
	});

	test("existing broker, dashboard and remote sections are never overwritten", () => {
		const custom = { ...withoutSections(), broker: { url: "http://127.0.0.1:1", tokenFile: "/x" }, dashboard: { listen: "127.0.0.1:1" }, remote: { listen: "0.0.0.0:1", certFile: "/c", keyFile: "/k" } };
		const { config } = migrateServiceConfig(custom, paths);
		expect(config.broker).toEqual(custom.broker);
		expect(config.dashboard).toEqual(custom.dashboard);
		expect(config.remote).toEqual(custom.remote);
	});
});

describe("ensureServiceConfig", () => {
	test("a new host gets a token and a config, both 0600, the config holding only the token's digest", async () => {
		await ensureDirs(paths);
		const outcome = await ensureServiceConfig(paths, "omp-cloud");
		expect(outcome.steps.map((step) => `${step.id}:${step.status}`)).toEqual(["config.token:changed", "config.service:changed"]);
		const token = await readFile(paths.serviceToken, "utf8");
		expect(outcome.createdToken).toBe(token);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		const written = await readFile(paths.serviceJson, "utf8");
		expect(written.endsWith("\n")).toBe(true);
		expect(JSON.parse(written).apiTokenSha256).toBe(new Bun.CryptoHasher("sha256").update(token).digest("hex"));
		expect(written).not.toContain(token);
		expect(outcome.steps.map((step) => step.detail).join("\n")).not.toContain(token);
		expect(await mode(paths.serviceJson)).toBe(0o600);
		expect(await mode(paths.serviceToken)).toBe(0o600);
	});

	test("an existing file keeps its token and is rewritten only when something changes", async () => {
		await ensureDirs(paths);
		await ensureServiceConfig(paths, "omp-cloud");
		const before = await readFile(paths.serviceJson, "utf8");
		const again = await ensureServiceConfig(paths, "omp-cloud");
		expect(again.steps.map((step) => step.status)).toEqual(["ok"]);
		expect(again.createdToken).toBeNull();
		expect(await readFile(paths.serviceJson, "utf8")).toBe(before);
	});

	test("a team that differs is rewritten (setup decides which team a host has)", async () => {
		await ensureDirs(paths);
		await ensureServiceConfig(paths, "omp-cloud");
		const outcome = await ensureServiceConfig(paths, "acme");
		expect(outcome.steps[0]?.detail).toContain("vmon.team set to acme");
		expect(await recordedTeam(paths)).toBe("acme");
	});

	test.each([
		["{ nope", "is not valid JSON"],
		["[1]", "is not a JSON object"],
		[JSON.stringify({ listen: "127.0.0.1:1" }), "is invalid"],
	])("a file that cannot be used is reported with a fix and not touched: %s", async (content, problem) => {
		await ensureDirs(paths);
		await writeFile(paths.serviceJson, content);
		const outcome = await ensureServiceConfig(paths, "omp-cloud");
		expect(outcome.steps[0]?.status).toBe("failed");
		expect(outcome.steps[0]?.detail).toContain(problem);
		expect(outcome.steps[0]?.fix).toContain("mv ");
		expect(await readFile(paths.serviceJson, "utf8")).toBe(content);
	});

	test("a team that is not a slug is a programming error", async () => {
		await expect(ensureServiceConfig(paths, "Not A Slug")).rejects.toThrow("not a team slug");
	});
});

describe("ensureDirs", () => {
	test("creates both 0700 and repairs an existing wider mode", async () => {
		await mkdir(paths.configDir, { recursive: true, mode: 0o755 });
		await chmod(paths.configDir, 0o755);
		await ensureDirs(paths);
		expect(await mode(paths.configDir)).toBe(0o700);
		expect(await mode(paths.authHome)).toBe(0o700);
	});

	test("reports changed when it created or repaired a directory, ok when both were already private", async () => {
		expect((await ensureDirs(paths)).status).toBe("changed");
		expect((await ensureDirs(paths)).status).toBe("ok");
		await chmod(paths.authHome, 0o755);
		expect((await ensureDirs(paths)).status).toBe("changed");
	});
});

describe("the team key files", () => {
	test("writeVmonKey writes the bare key 0600 and readVmonKey trims it", async () => {
		await ensureDirs(paths);
		await writeVmonKey(paths, "e2b_key");
		expect(await readFile(paths.vmonKey, "utf8")).toBe("e2b_key");
		expect(await mode(paths.vmonKey)).toBe(0o600);
		await writeFile(paths.vmonKey, "  e2b_other \n");
		expect(await readVmonKey(paths)).toBe("e2b_other");
		await writeFile(paths.vmonKey, "\n");
		expect(await readVmonKey(paths)).toBeNull();
		await rm(paths.vmonKey);
		expect(await readVmonKey(paths)).toBeNull();
	});
});

describe("ensureGatewayClients", () => {
	test("outside a checkout it creates an empty clients file, once, and no dev client", async () => {
		await ensureDirs(paths);
		const first = await ensureGatewayClients(paths, false);
		expect(first.map((step) => step.status)).toEqual(["changed"]);
		expect(JSON.parse(await readFile(paths.clientsFile, "utf8"))).toEqual({});
		expect((await ensureGatewayClients(paths, false)).map((step) => step.status)).toEqual(["ok"]);
		expect(await Bun.file(paths.gatewayClientToken).exists()).toBe(false);
	});

	test("in a checkout the dev client is issued once; its token file matches its digest", async () => {
		await ensureDirs(paths);
		await ensureGatewayClients(paths, true);
		const token = await readFile(paths.gatewayClientToken, "utf8");
		const clients = JSON.parse(await readFile(paths.clientsFile, "utf8"));
		expect(clients["omp-cloud-dev"].tokenSha256).toBe(new Bun.CryptoHasher("sha256").update(token).digest("hex"));
		expect(await mode(paths.gatewayClientToken)).toBe(0o600);
		const again = await ensureGatewayClients(paths, true);
		expect(again.map((step) => step.status)).toEqual(["ok"]);
		expect(await readFile(paths.gatewayClientToken, "utf8")).toBe(token);
	});

	test("a client the service added is kept", async () => {
		await ensureDirs(paths);
		await writeFile(paths.clientsFile, JSON.stringify({ "thread-9": { tokenSha256: "c".repeat(64) } }), { mode: 0o600 });
		const steps = await ensureGatewayClients(paths, false);
		expect(steps.map((step) => step.status)).toEqual(["ok"]);
		expect(Object.keys(JSON.parse(await readFile(paths.clientsFile, "utf8")))).toEqual(["thread-9"]);
	});

	test("a clients file that is not valid is an error, never overwritten", async () => {
		await ensureDirs(paths);
		await writeFile(paths.clientsFile, "{ broken");
		await expect(ensureGatewayClients(paths, false)).rejects.toThrow("not a valid clients file");
		expect(await readFile(paths.clientsFile, "utf8")).toBe("{ broken");
	});
});
