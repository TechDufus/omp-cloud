import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClients } from "./clients";
import { GatewayModels } from "./models";

const NAME = "omp-cloud-svc-service";

/** A gateway: 401 for the first `rejections` requests, then `status` with `body`. */
class FakeGateway {
	rejections = 0;
	status = 200;
	body: unknown = { object: "list", data: [] };
	requests = 0;
	tokens: string[] = [];
	#waiters: { count: number; resolve: () => void }[] = [];
	readonly server: Bun.Server<undefined>;

	constructor() {
		this.server = Bun.serve({
			port: 0,
			fetch: req => {
				this.requests++;
				this.tokens.push((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
				for (const waiter of this.#waiters.filter(w => w.count <= this.requests)) waiter.resolve();
				this.#waiters = this.#waiters.filter(w => w.count > this.requests);
				if (new URL(req.url).pathname !== "/v1/models") return new Response("not found", { status: 404 });
				if (this.rejections > 0) {
					this.rejections--;
					return new Response("unauthorized", { status: 401 });
				}
				return new Response(JSON.stringify(this.body), { status: this.status });
			},
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	/** Resolves once `requests` reached `count`. */
	until(count: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (this.requests >= count) resolve();
		else this.#waiters.push({ count, resolve });
		return promise;
	}

	models(...ids: string[]): void {
		this.body = { object: "list", data: ids.map(id => ({ id, object: "model" })) };
	}
}

let dir: string;
let gateway: FakeGateway;
let clients: GatewayClients;
let models: GatewayModels | undefined;
let logged: ReturnType<typeof spyOn<typeof console, "error">>;

function make(options: { refreshMs?: number; startupMs?: number; url?: string } = {}): GatewayModels {
	models = new GatewayModels({ clients, url: options.url ?? gateway.url, clientName: NAME, retryMs: 10, startupMs: 2000, ...options });
	return models;
}

beforeEach(async () => {
	logged = spyOn(console, "error").mockImplementation(() => undefined);
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	gateway = new FakeGateway();
	clients = new GatewayClients({ file: join(dir, "clients.json"), url: gateway.url });
});

afterEach(async () => {
	models?.stop();
	models = undefined;
	logged.mockRestore();
	await gateway.server.stop(true);
	await rm(dir, { recursive: true, force: true });
});

describe("GatewayModels", () => {
	test("start issues the service client and waits until the gateway accepts it", async () => {
		gateway.rejections = 3;
		gateway.models("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai-codex/gpt-6", "no-slash", "/x", "Bad Name/y");
		const served = make();
		expect(served.providers()).toEqual([]);
		await served.start();
		expect(served.providers()).toEqual(["anthropic", "openai-codex"]);
		// Ids keep only well-formed providers with a model name, sorted.
		expect(served.modelIds()).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai-codex/gpt-6"]);
		expect(gateway.requests).toBe(4);
		expect(await clients.names()).toEqual([NAME]);
		// Every request carried the one token the client was issued.
		expect(new Set(gateway.tokens).size).toBe(1);
		const digest = new Bun.CryptoHasher("sha256").update(gateway.tokens[0] ?? "").digest("hex");
		expect(JSON.parse(await Bun.file(join(dir, "clients.json")).text())[NAME].tokenSha256).toBe(digest);
		// Waiting for the gateway to re-read its clients file is normal, not a failure.
		expect(logged.mock.calls).toEqual([]);
	});

	test("a 401 that outlasts the startup window is logged", async () => {
		gateway.rejections = Number.MAX_SAFE_INTEGER;
		const firstLog = new Promise<unknown>((resolve) => {
			logged.mockImplementation((message: unknown) => resolve(message));
		});
		const served = make({ startupMs: 50 });
		await served.start();
		expect(String(await firstLog)).toContain("status 401");
		expect(served.providers()).toEqual([]);
	});

	test("refresh re-reads the list, so a provider that logged in later shows up", async () => {
		gateway.models("anthropic/a");
		const served = make();
		await served.start();
		expect(served.providers()).toEqual(["anthropic"]);
		gateway.models("anthropic/a", "openai-codex/b");
		expect(served.providers()).toEqual(["anthropic"]);
		await served.refresh();
		expect(served.providers()).toEqual(["anthropic", "openai-codex"]);
	});

	test("a failed refresh keeps the last good list and logs once per distinct problem", async () => {
		gateway.models("anthropic/a");
		const served = make();
		await served.start();
		gateway.status = 500;
		await served.refresh();
		await served.refresh();
		expect(served.providers()).toEqual(["anthropic"]);
		expect(logged).toHaveBeenCalledTimes(1);
		expect(String(logged.mock.calls[0]?.[0])).toContain("status 500");
		expect(String(logged.mock.calls[0]?.[0])).toContain("keeping the last list");
		gateway.status = 200;
		gateway.body = { not: "a list" };
		await served.refresh();
		expect(served.providers()).toEqual(["anthropic"]);
		gateway.models("openai-codex/b");
		await served.refresh();
		expect(served.providers()).toEqual(["openai-codex"]);
	});

	test("concurrent refreshes share one request", async () => {
		gateway.models("anthropic/a");
		const served = make();
		await served.start();
		const before = gateway.requests;
		await Promise.all([served.refresh(), served.refresh(), served.refresh()]);
		expect(gateway.requests).toBe(before + 1);
	});

	test("the list is re-read every refreshMs", async () => {
		gateway.models("anthropic/a");
		const served = make({ refreshMs: 5 });
		await served.start();
		gateway.models("anthropic/a", "openai-codex/b");
		// The next read is scheduled when a read ends, so the second request after this point proves the first one landed.
		await gateway.until(gateway.requests + 2);
		expect(served.providers()).toEqual(["anthropic", "openai-codex"]);
	});

	test("start never throws when the gateway is unreachable", async () => {
		const down = new FakeGateway();
		const url = down.url;
		await down.server.stop(true);
		const served = make({ url, startupMs: 5000 });
		await served.start();
		expect(served.providers()).toEqual([]);
		expect(logged).toHaveBeenCalled();
	});

	test("start waits only while the gateway answers 401: any other failure is left to the background retries", async () => {
		gateway.status = 500;
		const served = make({ startupMs: 5000, refreshMs: 5 });
		await served.start();
		expect(gateway.requests).toBe(1);
		expect(served.providers()).toEqual([]);
		expect(String(logged.mock.calls[0]?.[0])).toContain("status 500");
		// The background retry finds the gateway healthy again.
		gateway.status = 200;
		gateway.models("anthropic/a");
		await gateway.until(gateway.requests + 2);
		expect(served.providers()).toEqual(["anthropic"]);
	});
});
