import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
