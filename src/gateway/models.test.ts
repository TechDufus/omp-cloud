import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../guards";
import { GatewayClients } from "./clients";
import { GatewayModels } from "./models";

const NAME = "omp-cloud-svc-service";

/** A gateway: 401 for the first `rejections` requests, then `status` with `body`. After `watch`, it also answers 401 to any token whose hash its last read of the clients file did not hold. */
class FakeGateway {
	rejections = 0;
	status = 200;
	body: unknown = { object: "list", data: [] };
	requests = 0;
	tokens: string[] = [];
	#waiters: { count: number; resolve: () => void }[] = [];
	#accepted: Set<string> | null = null;
	#watcher: Timer | undefined;
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
				const digest = new Bun.CryptoHasher("sha256").update(this.tokens.at(-1) ?? "").digest("hex");
				if (this.#accepted !== null && !this.#accepted.has(digest)) return new Response("unauthorized", { status: 401 });
				if (this.rejections > 0) {
					this.rejections--;
					return new Response("unauthorized", { status: 401 });
				}
				return new Response(JSON.stringify(this.body), { status: this.status });
			},
		});
	}

	/** Re-reads the clients file every `ms`, as the real gateway does every 10 s, and accepts exactly the tokens it holds. */
	watch(file: string, ms: number): void {
		this.#accepted = new Set();
		const reload = async (): Promise<void> => {
			const text = await Bun.file(file).text().catch(() => "{}");
			const entries: unknown = JSON.parse(text);
			this.#accepted = new Set(isRecord(entries) ? Object.values(entries).flatMap(entry => (isRecord(entry) && typeof entry.tokenSha256 === "string" ? [entry.tokenSha256] : [])) : []);
		};
		this.#watcher = setInterval(() => void reload(), ms);
	}

	close(): Promise<void> {
		clearInterval(this.#watcher);
		return this.server.stop(true);
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

/** The hash the clients file holds for the service's client. */
async function storedDigest(): Promise<string> {
	const entries: unknown = JSON.parse(await Bun.file(join(dir, "clients.json")).text());
	const entry = isRecord(entries) ? entries[NAME] : undefined;
	if (!isRecord(entry) || typeof entry.tokenSha256 !== "string") throw new Error("the clients file has no entry for the service");
	return entry.tokenSha256;
}

/** Polls `check` until it holds; waits for the service's own timers, so it is bounded by a deadline rather than a fixed sleep. */
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("the condition did not hold within 5 s");
		await Bun.sleep(5);
	}
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
	await gateway.close();
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

	test("a client the gateway stops accepting is reissued and the list recovers without a restart", async () => {
		gateway.watch(join(dir, "clients.json"), 5);
		gateway.models("anthropic/a");
		const served = make({ startupMs: 100, refreshMs: 20 });
		await served.start();
		expect(served.providers()).toEqual(["anthropic"]);
		const issued = await storedDigest();
		// Another writer issues the same client name: the gateway's next read of the file no longer holds the service's token.
		await clients.issue(NAME);
		gateway.models("anthropic/a", "openai-codex/b");
		await eventually(() => served.providers().includes("openai-codex"));
		const reissued = await storedDigest();
		expect(reissued).not.toBe(issued);
		expect(reissued).toBe(new Bun.CryptoHasher("sha256").update(gateway.tokens.at(-1) ?? "").digest("hex"));
		expect(await clients.names()).toEqual([NAME]);
		// Said once, and the 401s inside the windows are no failure.
		expect(logged.mock.calls.map(call => String(call[0]))).toEqual(["omp-cloud: the gateway no longer accepts the service's client (status 401); issued a new one"]);
	});

	test("a 401 inside the window after a reissue waits for the gateway instead of reissuing again", async () => {
		gateway.models("anthropic/a");
		const served = make({ startupMs: 300, refreshMs: 20 });
		await served.start();
		const first = await storedDigest();
		gateway.rejections = Number.MAX_SAFE_INTEGER;
		await eventually(async () => (await storedDigest()) !== first);
		const reissued = await storedDigest();
		// The gateway still answers 401 to the new client and the service keeps asking on the short cadence, without replacing it.
		await gateway.until(gateway.requests + 5);
		expect(await storedDigest()).toBe(reissued);
		gateway.rejections = 0;
		gateway.models("anthropic/a", "openai-codex/b");
		await eventually(() => served.providers().includes("openai-codex"));
		expect(logged).toHaveBeenCalledTimes(1);
	});
});
