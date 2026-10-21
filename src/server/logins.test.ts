import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoginFlow, LoginManager, type LoginView } from "../auth/login";
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
	const response = await handleLogins(request(method, body, raw), segments, logins);
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
		const declared = await handleLogins(new Request("http://service/api/v1/logins", { method: "POST", body: big, headers: { "content-length": String(big.length) } }), [], logins);
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
		);
		expect(streamed.status).toBe(413);
	});

	test("other paths and methods are 404", async () => {
		const logins = manager();
		const view = await started(logins);
		for (const [method, segments] of [
			["GET", []],
			["PUT", []],
			["POST", [view.id]],
			["GET", [view.id, "input"]],
			["POST", [view.id, "other"]],
			["POST", [view.id, "input", "extra"]],
		] as const) {
			expect(await call(logins, method, [...segments], {})).toEqual({ status: 404, body: { error: "not found" } });
		}
	});
});
