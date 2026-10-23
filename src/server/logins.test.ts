import type { Server } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoginFlow, LoginManager, type LoginView } from "../auth/login";
import { type Caller, OWNER, OWNER_CALLER } from "./auth";
import { handleLogins } from "./logins";

const AUTH_URL = "https://auth.example.com/authorize?state=s";
const dir = mkdtempSync(join(tmpdir(), "omp-cloud-logins-"));
const tokenFile = join(dir, "token");
writeFileSync(tokenFile, "handler-test-token\n");
const managers: LoginManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.stop();
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** A flow that waits for the pasted code "good" and fails on anything else. */
const flow: LoginFlow = {
	has: provider => provider === "anthropic",
	async run(_provider, controller) {
		controller.auth(AUTH_URL, "");
		const code = await controller.prompt("", controller.signal);
		if (code !== "good") throw new Error("the code was refused");
		return { provider: "anthropic", credential: { type: "api_key", key: "k" }, account: "owner@example.com" };
	},
};

function manager(): LoginManager {
	const created = new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: tokenFile, flow });
	managers.push(created);
	return created;
}

function request(method: string, body?: unknown, raw?: string): Request {
	const init: RequestInit = { method };
	if (raw !== undefined) init.body = raw;
	else if (body !== undefined) init.body = JSON.stringify(body);
	return new Request("http://service/api/v1/logins", init);
}

async function call(logins: LoginManager, method: string, segments: string[], body?: unknown, raw?: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await handleLogins(request(method, body, raw), segments, logins, OWNER_CALLER, () => []);
	expect(response.headers.get("content-type")).toBe("application/json");
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function started(logins: LoginManager): Promise<LoginView> {
	const created = await call(logins, "POST", [], { provider: "anthropic" });
	expect(created.status).toBe(201);
	return created.body as unknown as LoginView;
}

describe("handleLogins", () => {
	test("POST starts a login and answers 201 with it", async () => {
		const logins = manager();
		const view = await started(logins);
		expect(view).toMatchObject({ provider: "anthropic", state: "waiting", url: AUTH_URL, instructions: "", userCode: "", account: "", error: "" });
		expect(Object.keys(view).sort()).toEqual(["account", "error", "id", "instructions", "provider", "state", "url", "userCode"]);
	});

	test("GET answers the login; an unknown id is 404", async () => {
		const logins = manager();
		const view = await started(logins);
		expect(await call(logins, "GET", [view.id])).toEqual({ status: 200, body: { ...view } });
		expect(await call(logins, "GET", ["missing"])).toEqual({ status: 404, body: { error: "not found" } });
	});

	test("POST .../input finishes a login whose code is accepted", async () => {
		const logins = manager();
		const view = await started(logins);
		const wrong = await call(logins, "POST", [view.id, "input"], { input: "nope" });
		expect(wrong.status).toBe(200);
		expect(wrong.body).toMatchObject({ id: view.id, state: "failed", error: "the code was refused" });
		expect(await call(logins, "POST", [view.id, "input"], { input: "good" })).toEqual({
			status: 409,
			body: { error: "login is not waiting for input" },
		});
	});

	test("input to an unknown login is 404", async () => {
		expect(await call(manager(), "POST", ["missing", "input"], { input: "x" })).toEqual({ status: 404, body: { error: "not found" } });
	});

	test("DELETE cancels a waiting login with 202 and refuses one that ended", async () => {
		const logins = manager();
		const view = await started(logins);
		expect((await call(logins, "DELETE", [view.id])).status).toBe(202);
		expect(logins.get(view.id)).toMatchObject({ state: "failed", error: "cancelled" });
		expect(await call(logins, "DELETE", [view.id])).toEqual({ status: 409, body: { error: "login is not waiting" } });
		expect(await call(logins, "DELETE", ["missing"])).toEqual({ status: 404, body: { error: "not found" } });
	});

	test("an unknown provider is 400", async () => {
		const response = await call(manager(), "POST", [], { provider: "nope" });
		expect(response.status).toBe(400);
		expect(response.body).toEqual({ error: 'unknown provider "nope"' });
	});

	test("a missing or mistyped provider or input is 400", async () => {
		const logins = manager();
		const view = await started(logins);
		for (const body of [{}, { provider: 3 }, { provider: "  " }]) {
			expect((await call(logins, "POST", [], body)).status).toBe(400);
		}
		for (const body of [{}, { input: 3 }, { input: "" }]) {
			expect((await call(logins, "POST", [view.id, "input"], body)).status).toBe(400);
		}
		expect(logins.get(view.id)?.state).toBe("waiting");
	});

	test("a body that is not one JSON object is 400", async () => {
		const logins = manager();
		expect((await call(logins, "POST", [], undefined, "{nope")).status).toBe(400);
		expect((await call(logins, "POST", [], undefined, "[]")).status).toBe(400);
		expect((await call(logins, "POST", [], undefined, "")).status).toBe(400);
	});

	test("a body over 8 KiB is 413, declared or streamed", async () => {
		const logins = manager();
		const big = JSON.stringify({ provider: "anthropic", pad: "x".repeat(8 * 1024) });
		const declared = await handleLogins(new Request("http://service/api/v1/logins", { method: "POST", body: big, headers: { "content-length": String(big.length) } }), [], logins, OWNER_CALLER, () => []);
		expect(declared.status).toBe(413);
		const streamed = await handleLogins(
			new Request("http://service/api/v1/logins", {
				method: "POST",
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(big));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
			[],
			logins,
			OWNER_CALLER,
			() => [],
		);
		expect(streamed.status).toBe(413);
	});

	test("other paths and methods are 404", async () => {
		const logins = manager();
		const view = await started(logins);
		for (const [method, segments] of [
			["PUT", []],
			["POST", [view.id]],
			["GET", [view.id, "input"]],
			["POST", [view.id, "other"]],
			["POST", [view.id, "input", "extra"]],
		] as const) {
			expect(await call(logins, method, [...segments], {})).toEqual({ status: 404, body: { error: "not found" } });
		}
	});

	describe("GET on the collection", () => {
		const THREADS_ONLY: Caller = { kind: "device", principal: OWNER, device: { id: "d1", name: "phone", access: "threads" } };
		let broker: Server<undefined>;
		let listed: LoginManager;

		beforeAll(() => {
			broker = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch(req) {
					const path = new URL(req.url).pathname;
					if (path === "/v1/snapshot") {
						return Response.json({ credentials: [{ id: 1, provider: "anthropic", credential: { type: "oauth", email: "owner@example.com", authorizedAt: Date.parse("2026-10-01T00:00:00Z") } }] });
					}
					return Response.json({ disabled: [] });
				},
			});
			listed = new LoginManager({ brokerUrl: `http://127.0.0.1:${broker.port}`, brokerTokenFile: tokenFile, flow });
		});

		afterAll(() => {
			void broker.stop(true);
		});

		async function list(caller: Caller): Promise<{ status: number; body: unknown }> {
			const response = await handleLogins(request("GET"), [], listed, caller, () => ["https://mcp.example.com/sse"]);
			return { status: response.status, body: await response.json() };
		}

		test("answers {logins, brokerError} with accounts for the owner and a full-access device", async () => {
			const entries = [
				{ provider: "anthropic", kind: "provider", account: "owner@example.com", loggedInAt: "2026-10-01T00:00:00.000Z", renewBy: "2026-10-31T00:00:00.000Z", disabled: false, note: "" },
				{ provider: "mcp:https://mcp.example.com/sse", kind: "mcp", account: "mcp.example.com", loggedInAt: "", renewBy: "", disabled: false, note: "" },
			];
			expect(await list(OWNER_CALLER)).toEqual({ status: 200, body: { logins: entries, brokerError: "" } });
			const full: Caller = { kind: "device", principal: OWNER, device: { id: "d2", name: "laptop", access: "full" } };
			expect(await list(full)).toEqual({ status: 200, body: { logins: entries, brokerError: "" } });
		});

		test("a threads-only device gets the list with every account blank", async () => {
			const answer = await list(THREADS_ONLY);
			expect(answer.status).toBe(200);
			expect(answer.body).toMatchObject({ brokerError: "", logins: [{ provider: "anthropic", account: "", renewBy: "2026-10-31T00:00:00.000Z" }, { provider: "mcp:https://mcp.example.com/sse", account: "" }] });
		});

		test("a down broker is brokerError on a 200, with the MCP rows", async () => {
			const response = await handleLogins(request("GET"), [], manager(), OWNER_CALLER, () => ["https://mcp.example.com/sse"]);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { logins: { provider: string }[]; brokerError: string };
			expect(body.brokerError).toStartWith("the cloud broker did not answer: ");
			expect(body.logins.map((entry) => entry.provider)).toEqual(["mcp:https://mcp.example.com/sse"]);
		});
	});
});
