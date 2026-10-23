import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import { MIGRATIONS } from "../store/schema";
import { UpdateConflict, type UpdateStatus } from "../update/service";
import { BUILD, SERVICE_VERSION } from "../version";
import { type App, createApp } from "./app";
import { tokenSha256 } from "./auth";
import { FULL_ACCESS_MESSAGE } from "./scopes";
import type { UpdateApi } from "./update-routes";

const TOKEN = "owner-token";
const DEVICE_TOKEN = "ompd_device-token-for-the-update-tests-0123456789";
const FULL_DEVICE_TOKEN = "ompd_full-device-token-for-the-update-tests-012345";
const ORIGIN = "http://omp.test";

let dir: string;
let store: Store;
let git: GitService;
let settings: Settings;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-uroutes-"));
	store = Store.open({ dataDir: dir });
	settings = Settings.load(store);
	git = await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 30, pushTimeoutSeconds: 30 });
	store.addDevice({ id: "dev1", owner: "owner", name: "laptop", platform: "linux", tokenSha256: tokenSha256(DEVICE_TOKEN), pairedFrom: "ssh", access: "threads" });
	store.addDevice({ id: "dev2", owner: "owner", name: "desktop", platform: "linux", tokenSha256: tokenSha256(FULL_DEVICE_TOKEN), pairedFrom: "ssh", access: "full" });
});
afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

const STATUS: UpdateStatus = {
	mode: "notify",
	managed: true,
	state: "ready",
	current: { version: "0.5.0", build: { id: "b", commit: "c", createdAt: "t" } },
	latest: { version: "0.5.1", notes: "n", publishedAt: "p" },
	staged: "0.5.1",
	applying: null,
	error: null,
	message: null,
	checkedAt: "x",
	components: { vmon: { installed: "v0.4.0", required: "v0.4.0", helper: true }, omp: { host: "18.12.3", broker: null, gateway: null } },
	last: null,
};

interface Fake extends UpdateApi {
	calls: string[];
	conflict: string | null;
}

function fake(): Fake {
	const api: Fake = {
		calls: [],
		conflict: null,
		status: async () => STATUS,
		summary: async () => ({ state: STATUS.state, available: "0.5.1" }),
		check: async () => {
			api.calls.push("check");
		},
		apply: async () => {
			api.calls.push("apply");
			if (api.conflict !== null) throw new UpdateConflict(api.conflict);
			return { version: "0.5.1" };
		},
	};
	return api;
}

function appWith(update?: UpdateApi): App {
	return createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: { default: "fake/m", direct: ["fake"], gateway: { providers: () => [], refresh: async () => undefined } },
		ompVersion: "18.12.3",
		logins: new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: "/nonexistent", flow: { has: () => false, run: () => Promise.reject(new Error("no")) } }),
		settings,
		git,
		update,
	});
}

function call(app: App, method: string, path: string, token: string | null = TOKEN): Promise<Response> {
	const headers = new Headers();
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	return app.fetch(new Request(ORIGIN + path, { method, headers }));
}

async function body(res: Response): Promise<Record<string, unknown>> {
	const value: unknown = await res.json();
	if (!isRecord(value)) throw new Error("expected an object");
	return value;
}

describe("GET /api/v1/health", () => {
	test("is public: no token, a wrong token, a device token and the owner all get the same answer", async () => {
		const app = appWith(fake());
		for (const token of [null, "wrong", DEVICE_TOKEN, TOKEN]) {
			const res = await call(app, "GET", "/api/v1/health", token);
			expect(res.status).toBe(200);
			expect(await body(res)).toEqual({ status: "ok", version: SERVICE_VERSION, build: BUILD, schema: MIGRATIONS.length });
		}
		// Only GET is a route; without a token a POST is refused as any unknown route is.
		expect((await call(app, "POST", "/api/v1/health", null)).status).toBe(401);
	});

	test("exists without an updater too, and carries the common headers", async () => {
		const res = await call(appWith(), "GET", "/api/v1/health", null);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe("the update routes' auth", () => {
	test("without a token they are 401; a threads-only device may read the status but not check or apply; the owner and a full device are served", async () => {
		const update = fake();
		const app = appWith(update);
		for (const [method, path] of [
			["GET", "/api/v1/update"],
			["POST", "/api/v1/update/check"],
			["POST", "/api/v1/update/apply"],
		] as const) {
			expect((await call(app, method, path, null)).status).toBe(401);
			expect((await call(app, method, path, "wrong")).status).toBe(401);
			const device = await call(app, method, path, DEVICE_TOKEN);
			if (method === "GET") {
				expect([method, path, device.status]).toEqual([method, path, 200]);
				continue;
			}
			expect([method, path, device.status]).toEqual([method, path, 403]);
			expect(await body(device)).toEqual({ error: FULL_ACCESS_MESSAGE });
		}
		expect(update.calls).toEqual([]);
		expect((await call(app, "GET", "/api/v1/update")).status).toBe(200);
		expect((await call(app, "POST", "/api/v1/update/check", FULL_DEVICE_TOKEN)).status).toBe(202);
		expect((await call(app, "POST", "/api/v1/update/apply", FULL_DEVICE_TOKEN)).status).toBe(202);
	});

	test("without an updater the routes do not exist", async () => {
		const app = appWith();
		for (const [method, path] of [
			["GET", "/api/v1/update"],
			["POST", "/api/v1/update/check"],
			["POST", "/api/v1/update/apply"],
		] as const) {
			expect((await call(app, method, path)).status).toBe(404);
		}
	});

	test("other methods and paths are not routes", async () => {
		const app = appWith(fake());
		for (const [method, path] of [
			["POST", "/api/v1/update"],
			["GET", "/api/v1/update/check"],
			["PUT", "/api/v1/update/apply"],
			["GET", "/api/v1/update/apply"],
			["DELETE", "/api/v1/update"],
			["POST", "/api/v1/update/other"],
		] as const) {
			expect([method, path, (await call(app, method, path)).status]).toEqual([method, path, 404]);
		}
	});
});

describe("the update routes' answers", () => {
	test("GET shows the status exactly as the service built it", async () => {
		const res = await call(appWith(fake()), "GET", "/api/v1/update");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(STATUS);
	});

	test("POST check is 202 {} and starts a check without waiting for it", async () => {
		const update = fake();
		let release: () => void = () => undefined;
		update.check = () => {
			update.calls.push("check");
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		};
		const res = await call(appWith(update), "POST", "/api/v1/update/check");
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({});
		expect(update.calls).toEqual(["check"]);
		release();
	});

	test("POST apply is 202 with the version; a refusal is 409 with its message", async () => {
		const update = fake();
		const app = appWith(update);
		const started = await call(app, "POST", "/api/v1/update/apply");
		expect(started.status).toBe(202);
		expect(await started.json()).toEqual({ applying: { version: "0.5.1" } });

		update.conflict = "no update is ready";
		const refused = await call(app, "POST", "/api/v1/update/apply");
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "no update is ready" });
	});

	test("an unexpected failure is the generic 500, not the error's text", async () => {
		const update = fake();
		update.apply = async () => {
			throw new Error("secret detail");
		};
		const log = spyOn(console, "error").mockImplementation(() => undefined);
		const res = await call(appWith(update), "POST", "/api/v1/update/apply");
		log.mockRestore();
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "internal error" });
	});
});

describe("whoami.update", () => {
	test("owner and device callers both see {state, available}; a service without an updater says unsupported", async () => {
		const app = appWith(fake());
		for (const token of [TOKEN, DEVICE_TOKEN]) {
			const res = await call(app, "GET", "/api/v1/whoami", token);
			expect((await body(res)).update).toEqual({ state: "ready", available: "0.5.1" });
		}
		expect((await body(await call(appWith(), "GET", "/api/v1/whoami"))).update).toEqual({ state: "unsupported", available: null });
	});
});

describe("update.token over the settings API", () => {
	test("a literal is shown as (set) by GET, PUT, the audit and the export; a !command is shown", async () => {
		const app = appWith();
		const put = (value: string) =>
			app.fetch(new Request(`${ORIGIN}/api/v1/settings`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ settings: { "update.token": value } }) }));
		const tokenOf = async (res: Response) => {
			const list = (await body(res)).settings;
			return Array.isArray(list) ? list.find((entry) => isRecord(entry) && entry.key === "update.token") : undefined;
		};
		const written = await put("ghp_LiteralSECRET99");
		expect(await tokenOf(written)).toMatchObject({ value: "(set)", source: "stored" });
		const everything = [
			await (await call(app, "GET", "/api/v1/settings")).text(),
			await (await call(app, "GET", "/api/v1/settings/audit")).text(),
			await (await call(app, "GET", "/api/v1/settings/export")).text(),
		].join("\n");
		expect(everything).not.toContain("LiteralSECRET");
		expect(settings.get("update.token")).toBe("ghp_LiteralSECRET99");

		expect(await tokenOf(await put("!/usr/bin/gh auth token"))).toMatchObject({ value: "!/usr/bin/gh auth token" });
	});
});
