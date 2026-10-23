import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import { type App, createApp } from "./app";
import { OWNER_CALLER, tokenSha256, type Caller } from "./auth";
import { FULL_ACCESS_MESSAGE } from "./scopes";

const TOKEN = "s3cret-token";
const ORIGIN = "http://omp.test";
const MODELS = { default: "fake/fake-model", direct: ["fake"], gateway: { providers: () => ["anthropic"], refresh: async (): Promise<void> => undefined } };
const DEVICE: Caller = { kind: "device", principal: "owner", device: { id: "dev1", name: "laptop", access: "threads" } };
const REPOS_REQUIRED = "repos is required: list the repositories (globs) the secret goes to, * for all";

let dir: string;
let store: Store;
let app: App;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-secrets-routes-"));
	store = Store.open({ dataDir: dir });
	app = createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: MODELS,
		ompVersion: "18.12.3",
		logins: new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: "/nonexistent/auth-broker.token" }),
		settings: Settings.load(store),
		git: await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 5, pushTimeoutSeconds: 5 }),
	});
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function send(method: string, path: string, body?: unknown, caller: Caller = OWNER_CALLER): Promise<Response> {
	return app.fetchAs(caller, new Request(ORIGIN + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
	const body: unknown = await res.json();
	if (!isRecord(body)) throw new Error("expected an object");
	return body;
}

describe("owner only", () => {
	test.each<[string, string]>([
		["GET", "/api/v1/secrets"],
		["PUT", "/api/v1/secrets/DEMO_TOKEN"],
		["DELETE", "/api/v1/secrets/DEMO_TOKEN"],
	])("a paired device gets 403 on %s %s", async (method, path) => {
		const res = await send(method, path, { value: "v", repos: ["*"] }, DEVICE);
		expect(res.status).toBe(403);
		expect(await bodyOf(res)).toEqual({ error: FULL_ACCESS_MESSAGE });
		expect(store.listSecrets()).toEqual([]);
	});

	test("no token is 401", async () => {
		const res = await app.fetch(new Request(`${ORIGIN}/api/v1/secrets`));
		expect(res.status).toBe(401);
	});
});

describe("PUT and GET", () => {
	test("a stored secret is listed with its repos and kind, and its value is never served", async () => {
		const put = await send("PUT", "/api/v1/secrets/DEMO_TOKEN", { value: "s3cr3t-value-123", repos: ["github.com/acme/*", "local/*"] });
		expect(put.status).toBe(200);
		const written = await bodyOf(put);
		expect(written.secret).toMatchObject({ name: "DEMO_TOKEN", repos: ["github.com/acme/*", "local/*"], kind: "literal", updatedBy: "owner" });
		await send("PUT", "/api/v1/secrets/FROM_CMD", { value: "!op read op://vault/item/field", repos: ["*"] });

		const text = await (await send("GET", "/api/v1/secrets")).text();
		expect(text).not.toContain("s3cr3t-value-123");
		expect(text).not.toContain("op read");
		const body: unknown = JSON.parse(text);
		expect(body).toEqual({
			secrets: [
				{ name: "DEMO_TOKEN", repos: ["github.com/acme/*", "local/*"], kind: "literal", updatedAt: expect.any(String), updatedBy: "owner" },
				{ name: "FROM_CMD", repos: ["*"], kind: "command", updatedAt: expect.any(String), updatedBy: "owner" },
			],
		});
	});

	test("a second PUT replaces the value and the repos", async () => {
		await send("PUT", "/api/v1/secrets/DEMO_TOKEN", { value: "one", repos: ["*"] });
		await send("PUT", "/api/v1/secrets/DEMO_TOKEN", { value: "two", repos: ["github.com/a/b"] });
		expect(store.secretRows()).toEqual([{ name: "DEMO_TOKEN", value: "two", repos: ["github.com/a/b"] }]);
	});

	test("repos is required: missing, null and empty are all the same 400", async () => {
		for (const body of [{ value: "v" }, { value: "v", repos: null }, { value: "v", repos: [] }]) {
			const res = await send("PUT", "/api/v1/secrets/DEMO_TOKEN", body);
			expect(res.status).toBe(400);
			expect(await bodyOf(res)).toEqual({ error: REPOS_REQUIRED });
		}
		expect(store.listSecrets()).toEqual([]);
	});

	test.each<[string, string, unknown, string]>([
		["a reserved name", "HOME", { value: "v", repos: ["*"] }, "secret name HOME is reserved"],
		["an OMP_ name", "OMP_X", { value: "v", repos: ["*"] }, "secret name OMP_X is reserved: names starting with OMP_ are used by the service"],
		["an invalid name", "1BAD", { value: "v", repos: ["*"] }, "secret name 1BAD is not a valid variable name"],
		["a long name", `N${"A".repeat(128)}`, { value: "v", repos: ["*"] }, "secret name is longer than 128 characters"],
		["an empty value", "OK_NAME", { value: "", repos: ["*"] }, "value must be 1 to 65536 characters of text"],
		["a missing value", "OK_NAME", { repos: ["*"] }, "value must be 1 to 65536 characters of text"],
		["a long value", "OK_NAME", { value: "x".repeat(65537), repos: ["*"] }, "value must be 1 to 65536 characters of text"],
		["repos that is not an array", "OK_NAME", { value: "v", repos: "*" }, "repos must be an array of strings"],
		["51 repos", "OK_NAME", { value: "v", repos: Array.from({ length: 51 }, (_, i) => `r${i}`) }, "repos has 51 entries; at most 50"],
		["a glob with whitespace", "OK_NAME", { value: "v", repos: ["a b"] }, "repos[0] must be 1 to 200 characters without whitespace"],
		["a glob of 201 characters", "OK_NAME", { value: "v", repos: ["a".repeat(201)] }, "repos[0] must be 1 to 200 characters without whitespace"],
	])("%s is a 400", async (_label, name, body, message) => {
		const res = await send("PUT", `/api/v1/secrets/${name}`, body);
		expect(res.status).toBe(400);
		expect(await bodyOf(res)).toEqual({ error: message });
		expect(store.listSecrets()).toEqual([]);
	});

	test("a body over 72 KiB is 413", async () => {
		const res = await send("PUT", "/api/v1/secrets/DEMO_TOKEN", { value: "x".repeat(73 * 1024), repos: ["*"] });
		expect(res.status).toBe(413);
	});

	test("a path below a name and other methods are 404", async () => {
		expect((await send("PUT", "/api/v1/secrets/A/b", { value: "v", repos: ["*"] })).status).toBe(404);
		expect((await send("POST", "/api/v1/secrets", {})).status).toBe(404);
		expect((await send("GET", "/api/v1/secrets/DEMO_TOKEN")).status).toBe(404);
	});
});

describe("DELETE", () => {
	test("removes the secret: 202, then 404", async () => {
		await send("PUT", "/api/v1/secrets/DEMO_TOKEN", { value: "v", repos: ["*"] });
		const res = await send("DELETE", "/api/v1/secrets/DEMO_TOKEN");
		expect(res.status).toBe(202);
		expect(store.listSecrets()).toEqual([]);
		const again = await send("DELETE", "/api/v1/secrets/DEMO_TOKEN");
		expect(again.status).toBe(404);
		expect(await bodyOf(again)).toEqual({ error: "no secret DEMO_TOKEN" });
	});
});
