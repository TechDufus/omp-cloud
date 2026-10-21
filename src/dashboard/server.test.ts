import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { type App, createApp } from "../server/app";
import { OWNER, OWNER_CALLER, tokenSha256 } from "../server/auth";
import { pairDevice } from "../pairing/test-support";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import type { NewThread } from "../store/types";
import { DASHBOARD_HEADER } from "./guard";
import { createDashboardServer, dashboardOrigin } from "./server";
import { DashboardSessions, SESSION_COOKIE } from "./session";

const TOKEN = "s3cret-token";
const ORIGIN = "http://127.0.0.1:8081";
const JSON_HEADERS = { [DASHBOARD_HEADER]: "1", "Content-Type": "application/json" };

const NEW_THREAD: NewThread = {
	owner: OWNER,
	title: "t",
	prompt: "do it",
	model: "",
	thinking: "",
	repo: { name: "proj", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "a".repeat(40), localBranch: "" },
	paths: { home: "", workspace: "" },
	author: { name: "", email: "" },
	secretFiles: [],
	secretEnv: [],
	configOverlays: [],
	ompVersion: "18.12.3",
	policy: {},
};

let dir: string;
let store: Store;
let sessions: DashboardSessions;
let app: App;
let listener: Bun.Server<undefined>;
let base: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	store = Store.open({ dataDir: dir });
	sessions = new DashboardSessions();
	const gateway = { served: ["anthropic"], providers: () => ["anthropic"], refresh: async (): Promise<void> => undefined };
	app = createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: { default: "fake/fake-model", direct: ["fake"], gateway },
		ompVersion: "18.12.3",
		logins: new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: "/nonexistent/auth-broker.token" }),
		settings: Settings.load(store),
		git: await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 10, pushTimeoutSeconds: 10 }),
		dashboard: { origin: ORIGIN, upstream: ORIGIN, sessions },
	});
	const dashboard = createDashboardServer({ app, apiTokenSha256: tokenSha256(TOKEN), sessions, port: 0 });
	listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: dashboard.fetch, idleTimeout: 0 });
	base = `http://127.0.0.1:${listener.port}`;
});

afterEach(async () => {
	await listener.stop(true);
	store.close();
	await rm(dir, { recursive: true, force: true });
});

/** A request to the dashboard listener. */
function dash(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(base + path, init);
}

/** A request to the service listener's handler with the bearer token. */
function bearer(method: string, path: string): Promise<Response> {
	return app.fetch(new Request(`http://omp.test${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } }));
}

/** Mints a link through the bearer API and returns its code. */
async function mintCode(): Promise<string> {
	const res = await bearer("POST", "/api/v1/dashboard/links");
	expect(res.status).toBe(201);
	const url = (await bodyOf(res)).url;
	if (typeof url !== "string") throw new Error("no url in the link");
	expect(url.startsWith(`${ORIGIN}/#`)).toBe(true);
	return new URL(url).hash.slice(1);
}

/** The `name=value` pair of a response's session cookie, or null. */
function cookieOf(res: Response): string | null {
	const header = res.headers.get("set-cookie");
	return header?.startsWith(`${SESSION_COOKIE}=`) ? (header.split(";")[0] ?? null) : null;
}

/** The response body as a JSON object. */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
	const body: unknown = await res.json();
	if (!isRecord(body)) throw new Error("expected a JSON object");
	return body;
}

/** Signs in with a fresh link; returns the `Cookie` header value. */
async function signIn(): Promise<string> {
	const res = await dash("/session", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ code: await mintCode() }) });
	expect(res.status).toBe(204);
	const cookie = cookieOf(res);
	if (cookie === null) throw new Error("no session cookie");
	return cookie;
}

/** What `readUntil` needs of a stream reader. */
interface StreamReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): Promise<void>;
}

/** Reads an event stream until `done` accepts the text so far; fails the test when the stream ends first. */
async function readUntil(reader: StreamReader, done: (text: string) => boolean): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	while (!done(text)) {
		const chunk = await reader.read();
		if (chunk.done) throw new Error(`the stream ended before the expected data: ${JSON.stringify(text)}`);
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text;
}

describe("sign-in", () => {
	test("a link code trades for a cookie once, and the cookie opens the API", async () => {
		const code = await mintCode();
		const res = await dash("/session", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ code }) });
		expect(res.status).toBe(204);
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain("Path=/");
		const cookie = cookieOf(res) as string;

		const again = await dash("/session", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ code }) });
		expect(again.status).toBe(401);
		expect(cookieOf(again)).toBeNull();

		const whoami = await dash("/api/v1/whoami", { headers: { cookie } });
		expect(whoami.status).toBe(200);
		expect((await bodyOf(whoami)).user).toBe(OWNER);
		expect((await bodyOf(await dash("/session", { headers: { cookie } }))).user).toBe(OWNER);
	});

	test("the API token signs in too, trimmed", async () => {
		const res = await dash("/session", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token: ` ${TOKEN}\n` }) });
		expect(res.status).toBe(204);
		expect(cookieOf(res)).not.toBeNull();
	});

	test("a device token is not a sign-in credential: only the owner token is", async () => {
		const { token } = pairDevice(store, { name: "laptop", token: "ompd_dashboard-signin-test" });
		const res = await dash("/session", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token }) });
		expect(res.status).toBe(401);
		expect(cookieOf(res)).toBeNull();
	});

	test("a wrong token, an empty body and a body with both are refused", async () => {
		const post = (body: string): Promise<Response> => dash("/session", { method: "POST", headers: JSON_HEADERS, body });
		expect((await post(JSON.stringify({ token: "nope" }))).status).toBe(401);
		expect((await post("{}")).status).toBe(400);
		expect((await post("not json")).status).toBe(400);
		expect((await post(JSON.stringify({ code: "x", token: TOKEN }))).status).toBe(400);
		expect((await post(JSON.stringify({ code: 7 }))).status).toBe(400);
	});

	test("five failed sign-ins lock the endpoint for a while, even for a good credential", async () => {
		const post = (body: unknown): Promise<Response> => dash("/session", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
		for (let i = 0; i < 5; i++) expect((await post({ token: "nope" })).status).toBe(401);
		const blocked = await post({ token: TOKEN });
		expect(blocked.status).toBe(429);
		expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(cookieOf(blocked)).toBeNull();
	});

	test("sign-out ends the session", async () => {
		const cookie = await signIn();
		const out = await dash("/session", { method: "DELETE", headers: { cookie, [DASHBOARD_HEADER]: "1" } });
		expect(out.status).toBe(204);
		expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
		expect((await dash("/api/v1/whoami", { headers: { cookie } })).status).toBe(401);
		expect((await dash("/session", { headers: { cookie } })).status).toBe(401);
	});

	test("signing in again closes the session the old cookie held", async () => {
		const first = await signIn();
		const res = await dash("/session", { method: "POST", headers: { ...JSON_HEADERS, cookie: first }, body: JSON.stringify({ code: await mintCode() }) });
		expect(res.status).toBe(204);
		expect((await dash("/api/v1/whoami", { headers: { cookie: first } })).status).toBe(401);
		expect((await dash("/api/v1/whoami", { headers: { cookie: cookieOf(res) as string } })).status).toBe(200);
	});
});

describe("the guard on the listener", () => {
	test("without a cookie the API is 401, with no bearer challenge", async () => {
		const res = await dash("/api/v1/whoami");
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBeNull();
	});

	test("a bearer token is no credential here", async () => {
		expect((await dash("/api/v1/whoami", { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
	});

	test("a cross-site request is refused before authentication, signed in or not", async () => {
		const cookie = await signIn();
		const attempts: Record<string, string>[] = [{ "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "http://evil.example" }];
		for (const headers of attempts) {
			const res = await dash("/api/v1/whoami", { headers: { cookie, ...headers } });
			expect(res.status).toBe(403);
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		}
		const signing = await dash("/session", {
			method: "POST",
			headers: { ...JSON_HEADERS, "Sec-Fetch-Site": "cross-site" },
			body: JSON.stringify({ code: await mintCode() }),
		});
		expect(signing.status).toBe(403);
	});

	test("a same-origin request with fetch metadata passes", async () => {
		const cookie = await signIn();
		const res = await dash("/api/v1/whoami", { headers: { cookie, "Sec-Fetch-Site": "same-origin", Origin: base } });
		expect(res.status).toBe(200);
	});

	test("a mutation without X-Omp-Dashboard is refused, with it goes through", async () => {
		const cookie = await signIn();
		const id = store.newThreadId();
		store.createThread(id, NEW_THREAD);
		const stop = (headers: Record<string, string>): Promise<Response> =>
			dash(`/api/v1/threads/${id}/stop`, { method: "POST", headers: { cookie, ...headers } });
		expect((await stop({})).status).toBe(403);
		expect((await stop({ [DASHBOARD_HEADER]: "1" })).status).toBe(200);
	});

	test("a preflight is not answered with CORS headers", async () => {
		const res = await dash("/api/v1/threads", {
			method: "OPTIONS",
			headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": DASHBOARD_HEADER },
		});
		expect(res.status).toBe(403);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
		expect(res.headers.get("access-control-allow-headers")).toBeNull();
	});

	test("links are minted through the bearer API only", async () => {
		const cookie = await signIn();
		const res = await dash("/api/v1/dashboard/links", { method: "POST", headers: { cookie, [DASHBOARD_HEADER]: "1" } });
		expect(res.status).toBe(404);
	});

	test("anything else is 404, the page itself being the HTML route's", async () => {
		expect((await dash("/")).status).toBe(404);
		expect((await dash("/session/x")).status).toBe(404);
		expect((await dash("/other")).status).toBe(404);
	});

	test("every response is no-store and nosniff", async () => {
		for (const res of [await dash("/api/v1/whoami"), await dash("/nope"), await dash("/session")]) {
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		}
	});
});

describe("the service listener is unchanged", () => {
	test("a session cookie alone is 401 on app.fetch, a bearer token still works", async () => {
		const cookie = await signIn();
		const withCookie = await app.fetch(new Request("http://omp.test/api/v1/whoami", { headers: { cookie } }));
		expect(withCookie.status).toBe(401);
		expect(withCookie.headers.get("www-authenticate")).toBe('Bearer realm="omp-cloud"');
		expect((await bearer("GET", "/api/v1/whoami")).status).toBe(200);
	});

	test("the links route needs the bearer token", async () => {
		const res = await app.fetch(new Request("http://omp.test/api/v1/dashboard/links", { method: "POST" }));
		expect(res.status).toBe(401);
	});

	test("fetchAs serves a caller another listener resolved", async () => {
		const res = await app.fetchAs(OWNER_CALLER, new Request("http://omp.test/api/v1/whoami"));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});
});

describe("the global event stream", () => {
	test("announces itself, then carries the owner's events and deletions and nobody else's", async () => {
		const cookie = await signIn();
		const res = await dash("/api/v1/events", { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("text/event-stream");
		if (res.body === null) throw new Error("no body");
		const reader = res.body.getReader();
		try {
			await readUntil(reader, text => text.includes(": connected\n\n"));

			store.createThread(store.newThreadId(), { ...NEW_THREAD, owner: "bob" });
			const mine = store.newThreadId();
			store.createThread(mine, NEW_THREAD);
			const created = await readUntil(reader, text => text.includes("\n\n") && text.includes("data:"));
			const messages = created.split("\n\n").filter(m => m.startsWith("data: "));
			expect(messages).toHaveLength(1);
			expect(JSON.parse((messages[0] as string).slice(6))).toMatchObject({ thread: mine, seq: 1, kind: "turn_queued" });
			expect(created).not.toContain("id:");

			await store.deleteThread(mine);
			const deleted = await readUntil(reader, text => text.includes("deleted"));
			expect(JSON.parse(deleted.trim().slice(6))).toEqual({ thread: mine, deleted: true });
		} finally {
			await reader.cancel();
		}
	});
});

describe("dashboardOrigin", () => {
	test("is the configured url, else http://<listen> with an IPv6 host bracketed", () => {
		expect(dashboardOrigin({ listen: { hostname: "127.0.0.1", port: 8081 } })).toBe("http://127.0.0.1:8081");
		expect(dashboardOrigin({ listen: { hostname: "::1", port: 8081 } })).toBe("http://[::1]:8081");
		expect(dashboardOrigin({ listen: { hostname: "127.0.0.1", port: 8081 }, url: "https://omp.lan" })).toBe("https://omp.lan");
	});
});
