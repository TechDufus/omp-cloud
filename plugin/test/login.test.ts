import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { CloudClient } from "../src/api";
import { CloudError } from "../src/errors";
import { loginListLines, runLogin } from "../src/login";
import { UserError, type Login, type LoginEntry } from "../src/types";
import { login } from "./builders";
import { fakeHost, type FakeHostOptions } from "./fakes";

interface Call {
	method: string;
	path: string;
	body: unknown;
}

/** What the fake broker answers; each reply list is consumed in order and its last entry repeats. */
interface Script {
	start: Login;
	polls: Login[];
	/** The reply to `POST .../input`: a login, or the HTTP status of the failure. */
	input: Login | number;
}

let calls: Call[] = [];
let script: Script;

beforeEach(() => {
	calls = [];
	script = { start: login(), polls: [login()], input: login() };
});

afterEach(() => setSystemTime());

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		const text = await req.text();
		calls.push({ method: req.method, path: url.pathname, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
		if (req.method === "POST" && url.pathname === "/api/v1/logins") return Response.json(script.start, { status: 201 });
		if (req.method === "GET" && url.pathname === "/api/v1/logins/l1") {
			const polled = calls.filter(c => c.method === "GET").length;
			return Response.json(script.polls[Math.min(polled, script.polls.length) - 1]);
		}
		if (req.method === "POST" && url.pathname === "/api/v1/logins/l1/input") {
			return typeof script.input === "number"
				? Response.json({ error: "login is not waiting for input" }, { status: script.input })
				: Response.json(script.input);
		}
		if (req.method === "DELETE" && url.pathname === "/api/v1/logins/l1") return Response.json({}, { status: 202 });
		return Response.json({ error: "not found" }, { status: 404 });
	},
});

afterAll(() => server.stop(true));

const api = () => new CloudClient(`http://127.0.0.1:${server.port}`, "tok");
const noSleep = async (): Promise<void> => {};
const methods = (): string[] => calls.map(c => `${c.method} ${c.path}`);

/** What a presenter was handed: a login per call to `show`. */
function presenter(): { shown: Login[]; show: (l: Login) => void } {
	const shown: Login[] = [];
	return { shown, show: l => void shown.push(l) };
}

interface Prompt {
	title: string;
	placeholder: string | undefined;
}

/** A host whose input box answers with `answers` in turn and records what it was asked. */
function hostAnswering(answers: (string | undefined)[], over: FakeHostOptions = {}) {
	const prompts: Prompt[] = [];
	const f = fakeHost({
		...over,
		input: async (title, placeholder) => {
			prompts.push({ title, placeholder });
			return answers.shift();
		},
	});
	return { ...f, prompts };
}

describe("runLogin", () => {
	test("paste path: prompts, posts the trimmed paste as {input}, polls until done, reports the account", async () => {
		script = {
			start: login({ instructions: "Sign in, then paste the address the browser ends on." }),
			input: login(),
			polls: [login(), login({ state: "done", account: "ada@example.com" })],
		};
		const h = hostAnswering(["  http://localhost:1455/auth/callback?code=abc123  "]);
		const sleeps: number[] = [];
		const p = presenter();

		const done = await runLogin(api(), h.host.ui, "openai-codex", p.show, {
			pollMs: 7,
			sleep: async ms => void sleeps.push(ms),
		});

		expect(methods()).toEqual([
			"POST /api/v1/logins",
			"POST /api/v1/logins/l1/input",
			"GET /api/v1/logins/l1",
			"GET /api/v1/logins/l1",
		]);
		expect(calls[0]?.body).toEqual({ provider: "openai-codex" });
		expect(calls[1]?.body).toEqual({ input: "http://localhost:1455/auth/callback?code=abc123" });
		expect(h.prompts).toHaveLength(1);
		expect(h.prompts[0]?.title).toContain("openai-codex");
		expect(sleeps).toEqual([7, 7]);
		expect(done).toMatchObject({ state: "done", account: "ada@example.com" });

		expect(p.shown).toEqual([login({ instructions: "Sign in, then paste the address the browser ends on." })]);
		expect(h.notes).toEqual([["☁ the cloud broker is logged in to openai-codex as ada@example.com", "info"]]);
	});

	test("a login that completes on the pasted input needs no polling", async () => {
		script = { start: login(), input: login({ state: "done", account: "" }), polls: [login()] };
		const h = hostAnswering(["code-1"]);
		const done = await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep });
		expect(methods()).toEqual(["POST /api/v1/logins", "POST /api/v1/logins/l1/input"]);
		expect(done.state).toBe("done");
		expect(h.notes.at(-1)).toEqual(["☁ the cloud broker is logged in to openai-codex", "info"]);
	});

	test("device-code path: no input prompt, shows the url and the code, polls until done", async () => {
		script = {
			start: login({ userCode: "ABCD-1234", url: "https://auth.example/device" }),
			input: 500,
			polls: [login({ userCode: "ABCD-1234" }), login({ userCode: "ABCD-1234" }), login({ state: "done", account: "ada" })],
		};
		const h = fakeHost({
			input: async () => {
				throw new Error("a device-code login must not prompt");
			},
		});
		let slept = 0;
		const p = presenter();

		const done = await runLogin(api(), h.host.ui, "openai-codex", p.show, {
			sleep: async () => {
				slept++;
			},
		});

		expect(methods()).toEqual(["POST /api/v1/logins", "GET /api/v1/logins/l1", "GET /api/v1/logins/l1", "GET /api/v1/logins/l1"]);
		expect(slept).toBe(3);
		expect(done.state).toBe("done");
		expect(p.shown).toEqual([login({ userCode: "ABCD-1234", url: "https://auth.example/device" })]);
		expect(h.notes.at(-1)).toEqual(["☁ the cloud broker is logged in to openai-codex as ada", "info"]);
	});

	test("a failed login is reported at level error with the service's reason", async () => {
		script = { start: login({ userCode: "X" }), input: 500, polls: [login({ state: "failed", error: "access denied" })] };
		const h = fakeHost();
		const done = await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep });
		expect(done).toMatchObject({ state: "failed", error: "access denied" });
		expect(h.notes.at(-1)).toEqual(["☁ login to openai-codex failed: access denied", "error"]);
		expect(h.notes.filter(([, level]) => level === "error")).toHaveLength(1);
	});

	test("a login that fails on the pasted input is reported at level error", async () => {
		script = { start: login(), input: login({ state: "failed", error: "bad code" }), polls: [login()] };
		const h = hostAnswering(["nonsense"]);
		await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep });
		expect(methods()).toEqual(["POST /api/v1/logins", "POST /api/v1/logins/l1/input"]);
		expect(h.notes.at(-1)).toEqual(["☁ login to openai-codex failed: bad code", "error"]);
	});

	test.each([
		["an empty paste", ""],
		["whitespace only", "   "],
		["a dismissed prompt", undefined],
	])("%s cancels the login: DELETE is sent, no input is posted", async (_name, answer) => {
		script = { start: login(), input: login(), polls: [login()] };
		const h = hostAnswering([answer]);
		const result = await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep });
		expect(methods()).toEqual(["POST /api/v1/logins", "DELETE /api/v1/logins/l1"]);
		expect(result.state).toBe("waiting");
		expect(h.notes.at(-1)).toEqual(["☁ login to openai-codex cancelled", "info"]);
	});

	test("a cancel the service cannot deliver still ends the login quietly", async () => {
		script = { start: login({ id: "gone" }), input: login(), polls: [login()] };
		const h = hostAnswering([undefined]);
		await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep });
		expect(methods()).toEqual(["POST /api/v1/logins", "DELETE /api/v1/logins/gone"]);
		expect(h.notes.at(-1)?.[0]).toBe("☁ login to openai-codex cancelled");
	});

	test("409 on input (it finished while the owner typed) falls back to reading the login", async () => {
		script = { start: login(), input: 409, polls: [login({ state: "done", account: "ada" })] };
		const h = hostAnswering(["code-2"]);
		const done = await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep });
		expect(methods()).toEqual(["POST /api/v1/logins", "POST /api/v1/logins/l1/input", "GET /api/v1/logins/l1"]);
		expect(done).toMatchObject({ state: "done", account: "ada" });
		expect(h.notes.at(-1)).toEqual(["☁ the cloud broker is logged in to openai-codex as ada", "info"]);
	});

	test("any other failure of the input call propagates and is not mistaken for a finished login", async () => {
		script = { start: login(), input: 500, polls: [login({ state: "done" })] };
		const h = hostAnswering(["code-3"]);
		const err = await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CloudError);
		expect(err).toMatchObject({ code: "unavailable", status: 500 });
		expect(methods()).toEqual(["POST /api/v1/logins", "POST /api/v1/logins/l1/input"]);
	});

	test("a host without ui.input gets a UserError and the login is cancelled", async () => {
		script = { start: login(), input: login(), polls: [login()] };
		const h = fakeHost();
		expect(h.host.ui.input).toBeUndefined();
		const err = await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UserError);
		expect((err as UserError).message).toBe("☁ this host cannot prompt; log in from a TUI or RPC client that can");
		expect(methods()).toEqual(["POST /api/v1/logins", "DELETE /api/v1/logins/l1"]);
	});

	test("a device-code login needs no input box, so a host without one still logs in", async () => {
		script = { start: login({ userCode: "ZZZZ" }), input: 500, polls: [login({ state: "done", account: "ada" })] };
		const h = fakeHost();
		const done = await runLogin(api(), h.host.ui, "openai-codex", presenter().show, { sleep: noSleep });
		expect(done.state).toBe("done");
		expect(methods()).not.toContain("DELETE /api/v1/logins/l1");
	});

	test("the wait running out is a UserError, after polling", async () => {
		script = { start: login({ userCode: "ABCD" }), input: 500, polls: [login({ userCode: "ABCD" })] };
		const h = fakeHost();
		const err = await runLogin(api(), h.host.ui, "openai-codex", presenter().show, {
			maxMs: 30,
			pollMs: 10,
			sleep: async ms => void setSystemTime(new Date(Date.now() + ms)),
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UserError);
		expect((err as UserError).message).toBe("☁ login to openai-codex did not finish in time");
		expect(calls.filter(c => c.method === "GET").length).toBeGreaterThanOrEqual(1);
		expect(h.notes.some(([m]) => m.includes("logged in"))).toBe(false);
	});

	test("a service error on start propagates before anything is shown", async () => {
		const h = fakeHost();
		const p = presenter();
		const bad = new CloudClient(`http://127.0.0.1:${server.port}/nowhere`, "tok");
		const err = await runLogin(bad, h.host.ui, "openai-codex", p.show, { sleep: noSleep }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CloudError);
		expect(err).toMatchObject({ code: "not_found", status: 404 });
		expect(p.shown).toEqual([]);
		expect(h.notes).toEqual([]);
	});

	test("a login that is already over at start is not shown, only reported", async () => {
		script = { start: login({ state: "failed", error: "provider unknown" }), input: 500, polls: [login()] };
		const h = fakeHost();
		const p = presenter();
		const done = await runLogin(api(), h.host.ui, "nope", p.show, { sleep: noSleep });
		expect(done.state).toBe("failed");
		expect(p.shown).toEqual([]);
		expect(h.notes).toEqual([["☁ login to nope failed: provider unknown", "error"]]);
	});
});

describe("loginListLines", () => {
	const entry = (over: Partial<LoginEntry>): LoginEntry => ({ provider: "anthropic", kind: "provider", account: "", loggedInAt: "", renewBy: "", disabled: false, note: "", ...over });
	const FOOTER = "  /cloud login <provider> logs the cloud in (again)";

	test("each login is one line with the parts it has, dates as YYYY-MM-DD", () => {
		const lines = loginListLines({
			brokerError: "",
			logins: [
				entry({ account: "me@example.com", loggedInAt: "2026-10-01T08:30:00.000Z", renewBy: "2026-11-01T00:00:00.000Z" }),
				entry({ provider: "openai-codex", loggedInAt: "2026-10-02T00:00:00.000Z" }),
				entry({ provider: "google", account: "g@example.com" }),
				entry({ provider: "mcp:https://mcp.example/x", kind: "mcp", loggedInAt: "2026-10-03T00:00:00.000Z", renewBy: "2026-10-30T00:00:00.000Z" }),
			],
		});
		expect(lines).toEqual([
			"☁ the cloud is logged in to:",
			"  anthropic · me@example.com · logged in 2026-10-01 · renew by 2026-11-01",
			"  openai-codex · logged in 2026-10-02",
			"  google · g@example.com",
			"  mcp:https://mcp.example/x · logged in 2026-10-03 · renew by 2026-10-30",
			FOOTER,
		]);
	});

	test("a disabled login says why", () => {
		expect(loginListLines({ brokerError: "", logins: [entry({ provider: "google", disabled: true, note: "refresh token revoked" })] })).toEqual([
			"☁ the cloud is logged in to:",
			"  google · disabled: refresh token revoked",
			FOOTER,
		]);
	});

	test("nothing yet, and a broker error line", () => {
		expect(loginListLines({ brokerError: "", logins: [] })).toEqual(["☁ the cloud is logged in to:", "  nothing yet", FOOTER]);
		expect(loginListLines({ brokerError: "broker unreachable", logins: [] })).toEqual(["☁ the cloud is logged in to:", "  nothing yet", "  ! broker unreachable", FOOTER]);
	});
});
