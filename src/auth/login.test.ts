import type { Server } from "bun";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_OAUTH_GRANT_TTL_MS } from "@oh-my-pi/pi-ai/oauth/anthropic";
import { LoginError, type LoginController, type LoginFlow, LoginManager, type LoginResult, type LoginView, ompLoginFlow } from "./login";

const TOKEN = "broker-token-s3cret-do-not-leak";
const REFRESH = "refresh-s3cret-do-not-leak";
const AUTH_URL = "https://auth.example.com/oauth/authorize?state=abc";

interface Upload {
	authorization: string | null;
	body: unknown;
}

let dir: string;
let tokenFile: string;
let broker: ReturnType<typeof Bun.serve>;
let uploads: Upload[];
let brokerStatus = 200;
const managers: LoginManager[] = [];

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-cloud-login-"));
	tokenFile = join(dir, "auth-broker.token");
	broker = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			uploads.push({ authorization: req.headers.get("authorization"), body: await req.json() });
			return Response.json({ entries: [] }, { status: brokerStatus });
		},
	});
});

afterAll(() => {
	void broker.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	uploads = [];
	brokerStatus = 200;
	writeFileSync(tokenFile, `${TOKEN}\n`);
});

afterEach(() => {
	for (const manager of managers.splice(0)) manager.stop();
});

const KNOWN = ["anthropic", "openai-codex"];

/** A flow that runs `script` for the known providers. */
function scripted(script: (controller: LoginController, provider: string) => Promise<LoginResult>): LoginFlow {
	return { has: provider => KNOWN.includes(provider), run: (provider, controller) => script(controller, provider) };
}

function result(provider = "anthropic", account = "owner@example.com"): LoginResult {
	return { provider, credential: { type: "oauth", access: "access-token", refresh: REFRESH, expires: 1 }, account };
}

function manager(flow: LoginFlow, extra: { timeoutMs?: number; retentionMs?: number; tokenFile?: string } = {}): LoginManager {
	const created = new LoginManager({
		brokerUrl: `http://127.0.0.1:${broker.port}/`,
		brokerTokenFile: extra.tokenFile ?? tokenFile,
		timeoutMs: extra.timeoutMs,
		retentionMs: extra.retentionMs,
		flow,
	});
	managers.push(created);
	return created;
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

function stateOf(login: LoginManager, id: string): string | undefined {
	return login.get(id)?.state;
}

describe("LoginManager", () => {
	test("start offers the sign-in, input finishes it and the credential goes to the broker", async () => {
		let pasted = "";
		const logins = manager(
			scripted(async controller => {
				controller.auth(AUTH_URL, "");
				controller.progress("Waiting for browser authentication...");
				pasted = await controller.prompt("", controller.signal);
				return result();
			}),
		);
		const started = await logins.start("anthropic");
		expect(started).toMatchObject({ provider: "anthropic", state: "waiting", url: AUTH_URL, userCode: "", account: "", error: "" });
		expect(started.instructions).toBe("Waiting for browser authentication...");
		expect(started.id).toMatch(/^[0-9a-f]{16}$/);

		const finished = await logins.input(started.id, "http://localhost:54545/callback?code=c&state=s");
		expect(pasted).toBe("http://localhost:54545/callback?code=c&state=s");
		expect(finished).toMatchObject({ id: started.id, state: "done", account: "owner@example.com", error: "" });
		expect(logins.get(started.id)).toEqual(finished);
		expect(uploads).toEqual([
			{
				authorization: `Bearer ${TOKEN}`,
				body: { provider: "anthropic", credential: { type: "oauth", access: "access-token", refresh: REFRESH, expires: 1 } },
			},
		]);
	});

	test("an MCP login needs no broker token: the flow persists it and nothing is uploaded", async () => {
		rmSync(tokenFile);
		let persisted = 0;
		const flow: LoginFlow = {
			has: provider => provider.startsWith("mcp:"),
			async run(provider, controller) {
				controller.auth(AUTH_URL, "");
				await controller.prompt("", controller.signal);
				return {
					...result(provider, "mcp.example.com"),
					persist: async () => {
						persisted++;
					},
				};
			},
		};
		const logins = manager(flow);
		const started = await logins.start("mcp:https://mcp.example.com/mcp");
		expect(started).toMatchObject({ state: "waiting", url: AUTH_URL });
		const finished = await logins.input(started.id, "http://localhost:3000/callback?code=c&state=s");
		expect(finished).toMatchObject({ state: "done", account: "mcp.example.com", error: "" });
		expect(persisted).toBe(1);
		expect(uploads).toEqual([]);
	});

	test("a failed MCP login reports the flow's own message", async () => {
		rmSync(tokenFile);
		const logins = manager({ has: provider => provider.startsWith("mcp:"), run: async () => Promise.reject(new Error("the MCP server advertises no OAuth endpoints")) });
		const started = await logins.start("mcp:https://mcp.example.com/mcp");
		await until(() => stateOf(logins, started.id) === "failed");
		expect(logins.get(started.id)?.error).toBe("the MCP server advertises no OAuth endpoints");
	});

	test("a provider that is not an MCP login still needs the broker token", async () => {
		rmSync(tokenFile);
		const logins = manager(scripted(async () => result()));
		const started = await logins.start("anthropic");
		expect(started).toMatchObject({ state: "failed", error: "cannot read the broker token file" });
	});

	test("a device-code login shows its code and finishes without input", async () => {
		const release = Promise.withResolvers<void>();
		const logins = manager(
			scripted(async controller => {
				controller.auth("https://auth.example.com/device", "Enter code: ABCD-1234");
				controller.progress("Waiting for browser authorization (code: ABCD-1234)…");
				await release.promise;
				return result("openai-codex", "dev@example.com (Org)");
			}),
		);
		const started = await logins.start("openai-codex");
		expect(started).toMatchObject({ state: "waiting", url: "https://auth.example.com/device", userCode: "ABCD-1234", instructions: "Enter code: ABCD-1234" });
		release.resolve();
		await until(() => stateOf(logins, started.id) === "done");
		expect(logins.get(started.id)).toMatchObject({ account: "dev@example.com (Org)", userCode: "ABCD-1234" });
		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.body).toMatchObject({ provider: "openai-codex" });
	});

	test("a question from the provider is shown as instructions and answered by input", async () => {
		let answer = "";
		const logins = manager(
			scripted(async controller => {
				answer = await controller.prompt("GitHub Enterprise domain (company.ghe.com)");
				controller.auth("https://github.com/login/device", "Enter code: WXYZ");
				await controller.prompt("", controller.signal);
				return result();
			}),
		);
		const started = await logins.start("anthropic");
		expect(started).toMatchObject({ state: "waiting", url: "", instructions: "GitHub Enterprise domain (company.ghe.com)" });
		const next = await logins.input(started.id, "company.ghe.com");
		expect(answer).toBe("company.ghe.com");
		expect(next).toMatchObject({ state: "waiting", url: "https://github.com/login/device", userCode: "WXYZ" });
	});

	test("an input that arrives before the flow asks is kept for it", async () => {
		const gate = Promise.withResolvers<void>();
		let pasted = "";
		const logins = manager(
			scripted(async controller => {
				controller.auth(AUTH_URL, "");
				await gate.promise;
				pasted = await controller.prompt("", controller.signal);
				return result();
			}),
		);
		const started = await logins.start("anthropic");
		const input = logins.input(started.id, "early-code");
		gate.resolve();
		expect((await input).state).toBe("done");
		expect(pasted).toBe("early-code");
	});

	test("an input the flow rejects leaves the login waiting", async () => {
		const seen: string[] = [];
		const logins = manager(
			scripted(async controller => {
				controller.auth(AUTH_URL, "");
				for (;;) {
					const text = await controller.prompt("", controller.signal);
					seen.push(text);
					if (text === "good") return result();
				}
			}),
		);
		const started = await logins.start("anthropic");
		expect((await logins.input(started.id, "bad")).state).toBe("waiting");
		expect((await logins.input(started.id, "good")).state).toBe("done");
		expect(seen).toEqual(["bad", "good"]);
	});

	test("a provider failure fails the login, redacts the broker token and uploads nothing", async () => {
		const logins = manager(
			scripted(async controller => {
				controller.auth(AUTH_URL, "");
				throw new Error(`token exchange failed (sent ${TOKEN})`);
			}),
		);
		const started = await logins.start("anthropic");
		await until(() => stateOf(logins, started.id) === "failed");
		const failed = logins.get(started.id);
		expect(failed?.error).toBe("token exchange failed (sent [redacted])");
		expect(uploads).toEqual([]);
	});

	test("a flow that fails before offering a sign-in returns the failed login", async () => {
		const logins = manager(
			scripted(async () => {
				throw new Error("provider is down");
			}),
		);
		expect(await logins.start("anthropic")).toMatchObject({ state: "failed", error: "provider is down", url: "" });
	});

	test("a broker that refuses the credential fails the login without echoing its answer", async () => {
		brokerStatus = 500;
		const logins = manager(
			scripted(async controller => {
				controller.auth(AUTH_URL, "");
				await controller.prompt("", controller.signal);
				return result();
			}),
		);
		const started = await logins.start("anthropic");
		const view = await logins.input(started.id, "code");
		expect(view).toMatchObject({ state: "failed", error: "the broker refused the credential (HTTP 500)", account: "" });
	});

	test("an unreachable broker fails the login", async () => {
		const logins = new LoginManager({
			brokerUrl: "http://127.0.0.1:1",
			brokerTokenFile: tokenFile,
			flow: scripted(async controller => {
				controller.auth(AUTH_URL, "");
				await controller.prompt("", controller.signal);
				return result();
			}),
		});
		managers.push(logins);
		const started = await logins.start("anthropic");
		const view = await logins.input(started.id, "code");
		expect(view.state).toBe("failed");
		expect(view.error).not.toBe("");
		expect(JSON.stringify(view)).not.toContain(TOKEN);
	});

	test("a login not finished in time fails and its flow is aborted", async () => {
		let signal: AbortSignal | undefined;
		const logins = manager(
			scripted(async controller => {
				signal = controller.signal;
				controller.auth(AUTH_URL, "");
				await controller.prompt("", controller.signal);
				return result();
			}),
			{ timeoutMs: 40 },
		);
		const started = await logins.start("anthropic");
		await until(() => stateOf(logins, started.id) === "failed");
		expect(logins.get(started.id)?.error).toBe("login timed out");
		expect(signal?.aborted).toBe(true);
		expect(uploads).toEqual([]);
		await expect(logins.input(started.id, "late")).rejects.toMatchObject({ code: "not_waiting" });
	});

	test("cancel fails a waiting login once", async () => {
		let signal: AbortSignal | undefined;
		const logins = manager(
			scripted(async controller => {
				signal = controller.signal;
				controller.auth(AUTH_URL, "");
				await controller.prompt("", controller.signal);
				return result();
			}),
		);
		const started = await logins.start("anthropic");
		expect(logins.cancel(started.id)).toBe(true);
		expect(logins.get(started.id)).toMatchObject({ state: "failed", error: "cancelled" });
		expect(signal?.aborted).toBe(true);
		expect(logins.cancel(started.id)).toBe(false);
		expect(logins.cancel("nope")).toBe(false);
		expect(uploads).toEqual([]);
	});

	test("cancel does not touch a finished login", async () => {
		const logins = manager(
			scripted(async controller => {
				controller.auth(AUTH_URL, "");
				await controller.prompt("", controller.signal);
				return result();
			}),
		);
		const started = await logins.start("anthropic");
		await logins.input(started.id, "code");
		expect(logins.cancel(started.id)).toBe(false);
		expect(logins.get(started.id)?.state).toBe("done");
	});

	test("a second start for a provider cancels the first; other providers are unaffected", async () => {
		const signals = new Map<string, AbortSignal[]>();
		const logins = manager(
			scripted(async (controller, provider) => {
				signals.set(provider, [...(signals.get(provider) ?? []), controller.signal]);
				controller.auth(AUTH_URL, "");
				await controller.prompt("", controller.signal);
				return result(provider);
			}),
		);
		const first = await logins.start("anthropic");
		const other = await logins.start("openai-codex");
		const second = await logins.start("anthropic");
		expect(second.id).not.toBe(first.id);
		expect(logins.get(first.id)).toMatchObject({ state: "failed", error: "cancelled by a newer login" });
		expect(signals.get("anthropic")?.map(signal => signal.aborted)).toEqual([true, false]);
		expect(logins.get(second.id)?.state).toBe("waiting");
		expect(logins.get(other.id)?.state).toBe("waiting");
		await expect(logins.input(first.id, "x")).rejects.toMatchObject({ code: "not_waiting" });
		expect((await logins.input(second.id, "code")).state).toBe("done");
		expect(uploads).toHaveLength(1);
	});

	test("input errors: unknown id and a login that is not waiting", async () => {
		const logins = manager(
			scripted(async () => {
				throw new Error("nope");
			}),
		);
		const failed = await logins.start("anthropic");
		const notWaiting = await logins.input(failed.id, "x").catch((error: unknown) => error);
		expect(notWaiting).toBeInstanceOf(LoginError);
		expect(notWaiting).toMatchObject({ code: "not_waiting" });
		await expect(logins.input("missing", "x")).rejects.toMatchObject({ code: "not_found" });
		expect(logins.get("missing")).toBeNull();
	});

	test("an unknown provider is refused before anything starts", async () => {
		let ran = false;
		const logins = manager(
			scripted(async () => {
				ran = true;
				return result();
			}),
		);
		await expect(logins.start("nope")).rejects.toMatchObject({ name: "LoginError", code: "unknown_provider" });
		expect(ran).toBe(false);
	});

	test("a finished login is kept for a while, then forgotten", async () => {
		const logins = manager(
			scripted(async () => {
				throw new Error("failed");
			}),
			{ retentionMs: 40 },
		);
		const failed = await logins.start("anthropic");
		expect(logins.get(failed.id)?.state).toBe("failed");
		await until(() => logins.get(failed.id) === null);
	});

	test("stop cancels waiting logins", async () => {
		let signal: AbortSignal | undefined;
		const logins = manager(
			scripted(async controller => {
				signal = controller.signal;
				controller.auth(AUTH_URL, "");
				await controller.prompt("", controller.signal);
				return result();
			}),
		);
		const started = await logins.start("anthropic");
		logins.stop();
		expect(signal?.aborted).toBe(true);
		expect(logins.get(started.id)).toBeNull();
	});

	test("an unreadable broker token file fails the login before the flow runs", async () => {
		let ran = false;
		const logins = manager(
			scripted(async () => {
				ran = true;
				return result();
			}),
			{ tokenFile: join(dir, "missing.token") },
		);
		const view = await logins.start("anthropic");
		expect(view).toMatchObject({ state: "failed", error: "cannot read the broker token file" });
		expect(ran).toBe(false);
		writeFileSync(join(dir, "empty.token"), "\n");
		const empty = manager(scripted(async () => result()), { tokenFile: join(dir, "empty.token") });
		expect(await empty.start("anthropic")).toMatchObject({ state: "failed", error: "the broker token file is empty" });
	});

	test("the token file is read on every login and its value never appears in a view, error or log", async () => {
		const logged: string[] = [];
		const spies = (["log", "info", "warn", "error", "debug"] as const).map(level =>
			spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))),
		);
		try {
			const views: LoginView[] = [];
			const logins = manager(
				scripted(async controller => {
					controller.auth(AUTH_URL, "");
					const text = await controller.prompt("", controller.signal);
					if (text === "boom") throw new Error(`exchange failed with ${TOKEN}`);
					return result();
				}),
			);
			const first = await logins.start("anthropic");
			views.push(first, await logins.input(first.id, "boom"));
			writeFileSync(tokenFile, "rotated-token\n");
			const second = await logins.start("anthropic");
			views.push(second, await logins.input(second.id, "code"));
			const third = await logins.start("anthropic");
			logins.cancel(third.id);
			const timedOut = await manager(scripted(async () => new Promise<LoginResult>(() => {})), { timeoutMs: 10 }).start("anthropic");
			views.push(third, timedOut);
			for (const id of [first.id, second.id, third.id]) {
				const view = logins.get(id);
				if (view) views.push(view);
			}
			const everything = JSON.stringify(views) + logged.join("\n");
			expect(everything).not.toContain(TOKEN);
			expect(everything).not.toContain("rotated-token");
			expect(everything).not.toContain(REFRESH);
			expect(views.find(view => view.id === first.id && view.state === "failed")?.error).toBe("exchange failed with [redacted]");
			expect(uploads.map(upload => upload.authorization)).toEqual(["Bearer rotated-token"]);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

describe("ompLoginFlow", () => {
	test("knows omp's providers and no others", () => {
		expect(ompLoginFlow.has("anthropic")).toBe(true);
		expect(ompLoginFlow.has("openai-codex")).toBe(true);
		expect(ompLoginFlow.has("not-a-provider")).toBe(false);
	});
});

describe("LoginManager.list", () => {
	const never: LoginFlow = { has: () => false, run: () => Promise.reject(new Error("unused")) };
	let snapshotBody: unknown;
	let disabledStatus: number;
	let disabledBody: unknown;
	let seen: { path: string; authorization: string | null }[];
	let listing: Server<undefined>;
	let listDir: string;
	let listTokenFile: string;

	beforeAll(() => {
		listDir = mkdtempSync(join(tmpdir(), "omp-cloud-login-list-"));
		listTokenFile = join(listDir, "token");
		writeFileSync(listTokenFile, `${TOKEN}\n`);
		listing = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				const path = new URL(req.url).pathname;
				seen.push({ path, authorization: req.headers.get("authorization") });
				if (path === "/v1/snapshot") return Response.json(snapshotBody);
				if (path === "/v1/credentials/disabled") return Response.json(disabledBody, { status: disabledStatus });
				return Response.json({ error: "not found" }, { status: 404 });
			},
		});
	});

	afterAll(() => {
		void listing.stop(true);
		rmSync(listDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		seen = [];
		disabledStatus = 200;
		disabledBody = { generatedAt: 1, disabled: [] };
		snapshotBody = {
			generation: 3,
			credentials: [
				{ id: 2, provider: "openai-codex", identityKey: null, credential: { type: "oauth", access: "a", refresh: "__remote__", expires: 1, email: "z@example.com", authorizedAt: Date.parse("2026-09-01T00:00:00Z") } },
				{ id: 1, provider: "anthropic", identityKey: null, credential: { type: "oauth", access: "a", refresh: "__remote__", expires: 1, email: "owner@example.com", authorizedAt: Date.parse("2026-10-01T00:00:00Z") } },
				{ id: 3, provider: "openrouter", identityKey: null, credential: { type: "api_key", key: "sk-secret" } },
				{ id: 4, provider: "anthropic", identityKey: null, credential: { type: "oauth", access: "a", refresh: "__remote__", expires: 1, orgName: "Acme" } },
			],
		};
	});

	function lister(url = `http://127.0.0.1:${listing.port}`, file = listTokenFile): LoginManager {
		return new LoginManager({ brokerUrl: url, brokerTokenFile: file, flow: never });
	}

	test("lists the broker's credentials by provider then account, Anthropic's with the date to renew by (30 days after the login)", async () => {
		const { logins, brokerError } = await lister().list(true);
		expect(brokerError).toBe("");
		expect(logins).toEqual([
			{ provider: "anthropic", kind: "provider", account: "Acme", loggedInAt: "", renewBy: "", disabled: false, note: "" },
			{ provider: "anthropic", kind: "provider", account: "owner@example.com", loggedInAt: "2026-10-01T00:00:00.000Z", renewBy: "2026-10-31T00:00:00.000Z", disabled: false, note: "" },
			{ provider: "openai-codex", kind: "provider", account: "z@example.com", loggedInAt: "2026-09-01T00:00:00.000Z", renewBy: "", disabled: false, note: "" },
			{ provider: "openrouter", kind: "provider", account: "API key", loggedInAt: "", renewBy: "", disabled: false, note: "" },
		]);
		expect(ANTHROPIC_OAUTH_GRANT_TTL_MS).toBe(30 * 24 * 3600 * 1000);
		expect(seen.map((request) => request.path).sort()).toEqual(["/v1/credentials/disabled", "/v1/snapshot"]);
		expect(seen.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
		expect(JSON.stringify(logins)).not.toContain("sk-secret");
	});

	test("a disabled credential is listed with its cause as the note, and the MCP servers come last", async () => {
		disabledBody = { generatedAt: 1, disabled: [{ id: 9, provider: "anthropic", type: "oauth", email: "gone@example.com", cause: "invalid_grant: Refresh token expired" }] };
		const { logins } = await lister().list(true, ["https://mcp.example.com/sse", "not a url"]);
		expect(logins.map((entry) => [entry.provider, entry.account, entry.disabled])).toEqual([
			["anthropic", "Acme", false],
			["anthropic", "gone@example.com", true],
			["anthropic", "owner@example.com", false],
			["openai-codex", "z@example.com", false],
			["openrouter", "API key", false],
			["mcp:https://mcp.example.com/sse", "mcp.example.com", false],
			["mcp:not a url", "not a url", false],
		]);
		expect(logins.find((entry) => entry.disabled)).toEqual({
			provider: "anthropic",
			kind: "provider",
			account: "gone@example.com",
			loggedInAt: "",
			renewBy: "",
			disabled: true,
			note: "invalid_grant: Refresh token expired",
		});
		expect(logins.filter((entry) => entry.kind === "mcp")).toHaveLength(2);
	});

	test("without full access every account is blank", async () => {
		disabledBody = { generatedAt: 1, disabled: [{ id: 9, provider: "anthropic", type: "oauth", email: "gone@example.com", cause: "x" }] };
		const { logins } = await lister().list(false, ["https://mcp.example.com/sse"]);
		expect(logins).toHaveLength(6);
		expect(logins.every((entry) => entry.account === "")).toBe(true);
		expect(logins.map((entry) => entry.provider)).toContain("mcp:https://mcp.example.com/sse");
	});

	test("a broker without the disabled endpoint (404) is not an error", async () => {
		disabledStatus = 404;
		const { logins, brokerError } = await lister().list(true);
		expect(brokerError).toBe("");
		expect(logins).toHaveLength(4);
	});

	test("a broker that is down gives brokerError and still the MCP rows; the token never appears", async () => {
		const { logins, brokerError } = await lister("http://127.0.0.1:1").list(true, ["https://mcp.example.com/sse"]);
		expect(brokerError).toStartWith("the cloud broker did not answer: ");
		expect(brokerError).not.toContain(TOKEN);
		expect(logins.map((entry) => entry.provider)).toEqual(["mcp:https://mcp.example.com/sse"]);
	});

	test("a broker error status, a missing token file and an empty one are brokerErrors too", async () => {
		disabledStatus = 500;
		expect((await lister().list(true)).brokerError).toBe("the cloud broker did not answer: HTTP 500 from /v1/credentials/disabled");
		const missing = await lister(undefined, join(listDir, "absent")).list(true);
		expect(missing.brokerError).toStartWith("the cloud broker did not answer: ");
		expect(missing.logins).toEqual([]);
		const empty = join(listDir, "empty");
		writeFileSync(empty, "\n");
		expect((await lister(undefined, empty).list(true)).brokerError).toBe("the cloud broker did not answer: the broker token file is empty");
	});

	test("unexpected shapes are skipped, not fatal", async () => {
		snapshotBody = { credentials: [null, "x", { provider: 3, credential: {} }, { provider: "p", credential: "no" }, { provider: "ok", credential: { type: "oauth", authorizedAt: "soon" } }] };
		disabledBody = { disabled: "nope" };
		const { logins, brokerError } = await lister().list(true);
		expect(brokerError).toBe("");
		expect(logins).toEqual([{ provider: "ok", kind: "provider", account: "", loggedInAt: "", renewBy: "", disabled: false, note: "" }]);
	});
});
