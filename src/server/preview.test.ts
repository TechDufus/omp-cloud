import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { pairDevice } from "../pairing/test-support";
import { Settings } from "../settings";
import { Store } from "../store";
import type { NewThread } from "../store/types";
import { type App, createApp } from "./app";
import { OWNER, tokenSha256 } from "./auth";
import { ApiError } from "./errors";
import { NO_VM_MESSAGE, type PreviewOptions } from "./preview";

const TOKEN = "s3cret-token";
const ORIGIN = "http://omp.test";
const ID = "aaaaaaaaaaa1";
const SANDBOX = "sbx-preview-1";
const NEW_THREAD: NewThread = {
	owner: OWNER,
	title: "t",
	prompt: "do it",
	model: "",
	thinking: "",
	repo: { name: "repo", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "a".repeat(40), localBranch: "" },
	paths: { home: "", workspace: "" },
	author: { name: "", email: "" },
	secretFiles: [],
	secretEnv: [],
	configOverlays: [],
	ompVersion: "18.12.3",
	policy: {},
};

/** What the fake vmon ingress received. */
interface Seen {
	method: string;
	path: string;
	search: string;
	headers: Headers;
	body: string;
}

let dir: string;
let store: Store;
let vmon: Bun.Server<undefined>;
let seen: Seen[];
let release: PromiseWithResolvers<void>;
let asked: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	store = Store.open({ dataDir: dir });
	store.createThread(ID, NEW_THREAD);
	seen = [];
	asked = [];
	release = Promise.withResolvers<void>();
	vmon = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const hasBody = req.method !== "GET" && req.method !== "HEAD";
			seen.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body: hasBody ? await req.text() : "" });
			if (url.pathname === "/stream") {
				const encoder = new TextEncoder();
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(encoder.encode("one\n"));
							await release.promise;
							controller.enqueue(encoder.encode("two\n"));
							controller.close();
						},
					}),
				);
			}
			if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: "/elsewhere" } });
			if (url.pathname === "/cookies") {
				const headers = new Headers({ "X-App": "yes" });
				headers.append("Set-Cookie", "a=1; Path=/");
				headers.append("Set-Cookie", "b=2; Path=/");
				return new Response("ok", { headers });
			}
			return new Response("Directory listing", { headers: { "X-App": "yes" } });
		},
	});
});

afterEach(async () => {
	await vmon.stop(true);
	store.close();
	await rm(dir, { recursive: true, force: true });
});

async function appWith(preview: PreviewOptions | undefined): Promise<App> {
	return createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: { default: "fake/fake-model", direct: ["fake"], gateway: { providers: () => ["anthropic"], refresh: async (): Promise<void> => undefined } },
		ompVersion: "18.12.3",
		logins: new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: "/nonexistent/auth-broker.token" }),
		settings: Settings.load(store),
		git: await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 10, pushTimeoutSeconds: 10 }),
		preview,
	});
}

function ingress(): PreviewOptions {
	return {
		vmonUrl: `http://127.0.0.1:${vmon.port}`,
		vmFor: async threadId => {
			asked.push(threadId);
			return SANDBOX;
		},
	};
}

function request(path: string, init: RequestInit = {}, token = TOKEN): Request {
	const headers = new Headers(init.headers);
	if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
	return new Request(ORIGIN + path, { ...init, headers });
}

async function errorOf(res: Response): Promise<string> {
	const body: unknown = await res.json();
	return isRecord(body) && typeof body.error === "string" ? body.error : "";
}

describe("GET /api/v1/threads/{id}/ports/{port}", () => {
	test("reaches the vmon ingress with both routing headers, the path, the query and the caller's other headers", async () => {
		const app = await appWith(ingress());
		const res = await app.fetch(
			request(`/api/v1/threads/${ID}/ports/8000/assets/app.js?v=2&x=a%20b`, {
				headers: { Cookie: "a=b", "X-Custom": "1", "X-Omp-Client": "plugin", "E2b-Sandbox-Id": "someone-else", "E2b-Sandbox-Port": "22", "X-Api-Key": "k" },
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Directory listing");
		expect(res.headers.get("x-app")).toBe("yes");
		expect(asked).toEqual([ID]);
		expect(seen).toHaveLength(1);
		const [call] = seen;
		expect(call?.method).toBe("GET");
		expect(call?.path).toBe("/assets/app.js");
		expect(call?.search).toBe("?v=2&x=a%20b");
		expect(call?.headers.get("e2b-sandbox-id")).toBe(SANDBOX);
		expect(call?.headers.get("e2b-sandbox-port")).toBe("8000");
		expect(call?.headers.get("authorization")).toBeNull();
		expect(call?.headers.get("x-omp-client")).toBeNull();
		expect(call?.headers.get("x-api-key")).toBeNull();
		expect(call?.headers.get("cookie")).toBe("a=b");
		expect(call?.headers.get("x-custom")).toBe("1");
	});

	test("the root, with and without the trailing slash, is `/`", async () => {
		const app = await appWith(ingress());
		await app.fetch(request(`/api/v1/threads/${ID}/ports/8000`));
		await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/`));
		expect(seen.map(call => call.path)).toEqual(["/", "/"]);
	});

	test("a path that starts with a second slash stays a path on vmon, never another host", async () => {
		const app = await appWith(ingress());
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000//evil.example/x`));
		expect(res.status).toBe(200);
		// Bun's server collapses a leading `//` of the target it sends, but the request still reached vmon, not a host named `evil.example`.
		expect(seen.map(call => call.path)).toEqual(["/evil.example/x"]);
	});

	test("any method and its streamed body are relayed", async () => {
		const app = await appWith(ingress());
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/3000/api/items`, { method: "POST", body: "payload", headers: { "Content-Type": "text/plain" } }));
		expect(res.status).toBe(200);
		expect(seen[0]).toMatchObject({ method: "POST", path: "/api/items", body: "payload" });
		expect(seen[0]?.headers.get("e2b-sandbox-port")).toBe("3000");
		expect(seen[0]?.headers.get("content-type")).toContain("text/plain");
	});

	test("streams the answer: the first chunk arrives before the server closes", async () => {
		const app = await appWith(ingress());
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/stream`));
		const reader = res.body?.getReader();
		if (reader === undefined) throw new Error("no body");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("one\n");
		release.resolve();
		let rest = "";
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
		expect(rest).toBe("two\n");
	});

	test("a redirect is passed on, not followed, and every Set-Cookie survives", async () => {
		const app = await appWith(ingress());
		const redirect = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/redirect`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("location")).toBe("/elsewhere");
		const cookies = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/cookies`));
		expect(cookies.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
	});

	test("a device token may preview too", async () => {
		const app = await appWith(ingress());
		const device = pairDevice(store);
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/`, {}, device.token));
		expect(res.status).toBe(200);
		expect(seen).toHaveLength(1);
	});

	test("a request without a token is 401 and reaches nothing", async () => {
		const app = await appWith(ingress());
		const res = await app.fetch(new Request(`${ORIGIN}/api/v1/threads/${ID}/ports/8000/`));
		expect(res.status).toBe(401);
		expect(seen).toEqual([]);
		expect(asked).toEqual([]);
	});

	test.each(["49983", "0", "65536", "99999", "abc", "08000", "-1"])("port %s is 400", async port => {
		const app = await appWith(ingress());
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/${port}/`));
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("port must be 1 to 65535 and not 49983");
		expect(seen).toEqual([]);
		expect(asked).toEqual([]);
	});

	test("a WebSocket upgrade is 501 before the VM is looked up", async () => {
		const app = await appWith(ingress());
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/ws`, { headers: { Upgrade: "websocket", Connection: "Upgrade" } }));
		expect(res.status).toBe(501);
		expect(await errorOf(res)).toBe("WebSocket upgrades are not forwarded");
		expect(asked).toEqual([]);
		expect(seen).toEqual([]);
	});

	test("a thread without a VM is 409 and nothing is relayed", async () => {
		const app = await appWith({
			vmonUrl: `http://127.0.0.1:${vmon.port}`,
			vmFor: async () => {
				throw new ApiError(409, NO_VM_MESSAGE);
			},
		});
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/`));
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe(NO_VM_MESSAGE);
		expect(seen).toEqual([]);
	});

	test("a service without a runner answers 409 too", async () => {
		const app = await appWith(undefined);
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/`));
		expect(res.status).toBe(409);
	});

	test("an unknown thread is 404", async () => {
		const app = await appWith(ingress());
		const res = await app.fetch(request("/api/v1/threads/bbbbbbbbbbb2/ports/8000/"));
		expect(res.status).toBe(404);
		expect(asked).toEqual([]);
	});

	test("a vmon that does not answer is 502", async () => {
		const app = await appWith({ vmonUrl: "http://127.0.0.1:1", vmFor: async () => SANDBOX });
		const res = await app.fetch(request(`/api/v1/threads/${ID}/ports/8000/`));
		expect(res.status).toBe(502);
		expect(await errorOf(res)).toContain("vmon did not answer");
	});

	test("whoami lists the capability", async () => {
		const app = await appWith(ingress());
		const res = await app.fetch(request("/api/v1/whoami"));
		const body: unknown = await res.json();
		expect(isRecord(body) && Array.isArray(body.capabilities) && body.capabilities.includes("threads.preview")).toBe(true);
	});
});
