import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../pairing/secrets";
import { Store } from "../store";
import type { NewThread, ThreadMcpServer } from "../store/types";
import { type McpProxyOptions, serveMcpProxy, tryServeMcpProxy } from "./mcp-proxy";
import { isRefusedHost, isRefusedUpstream } from "./refused";

const ID = "aaaaaaaaaaaa";
const VM_TOKEN = "vm-token-never-reaches-the-upstream";
const UPSTREAM_SECRET = "upstream-secret";

interface Seen {
	method: string;
	path: string;
	headers: Headers;
	body: string;
}

let dir: string;
let store: Store;
let upstream: Bun.Server<undefined>;
let seen: Seen[];
let proxies: Bun.Server<undefined>[];
/** Released by the test to let the SSE upstream send its second event and close. */
let sseGate: PromiseWithResolvers<void>;
let oauthToken: string | null;

beforeAll(() => {
	upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			seen.push({ method: req.method, path: url.pathname, headers: req.headers, body: await req.text() });
			if (url.pathname === "/gz") {
				return new Response(Bun.gzipSync("hello from gzip"), { headers: { "Content-Encoding": "gzip", "Content-Type": "text/plain" } });
			}
			if (url.pathname === "/sse") {
				const encoder = new TextEncoder();
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(encoder.encode("event: message\ndata: first\n\n"));
							await sseGate.promise;
							controller.enqueue(encoder.encode("event: message\ndata: second\n\n"));
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json", "Mcp-Session-Id": req.headers.get("mcp-session-id") ?? "session-1" },
			});
		},
	});
});

afterAll(async () => {
	await upstream.stop(true);
});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-mcp-"));
	store = Store.open({ dataDir: dir });
	seen = [];
	proxies = [];
	sseGate = Promise.withResolvers<void>();
	oauthToken = null;
});

afterEach(async () => {
	for (const proxy of proxies) await proxy.stop(true);
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function newThread(mcpServers: string[]): NewThread {
	return {
		owner: "owner",
		title: "t",
		prompt: "do it",
		model: "",
		thinking: "",
		repo: { name: "repo", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "a".repeat(40), localBranch: "main" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
		mcpServers,
	};
}

function upstreamUrl(path: string): string {
	return `http://127.0.0.1:${upstream.port}${path}`;
}

/** A thread that ships `servers`, holding the proxy token `VM_TOKEN`. */
async function shipThread(servers: ThreadMcpServer[]): Promise<void> {
	store.createThread(ID, newThread(servers.map(server => server.name)));
	await store.putBlob(ID, "secrets.json", new TextEncoder().encode(JSON.stringify({ files: [], env: {}, mcp: servers })), 1024 * 1024);
	store.setMcpToken(ID, sha256Hex(VM_TOKEN));
}

function proxy(over: Partial<McpProxyOptions> = {}): string {
	const server = serveMcpProxy({
		listen: { hostname: "127.0.0.1", port: 0 },
		store,
		credentials: { access: async () => oauthToken },
		// The fake upstream sits on loopback, which the real check refuses.
		refused: () => false,
		...over,
	});
	proxies.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function call(base: string, name: string, init: RequestInit = {}, token: string | null = VM_TOKEN): Promise<Response> {
	const headers = new Headers(init.headers);
	if (token !== null) headers.set("authorization", `Bearer ${token}`);
	return fetch(`${base}/mcp/${name}`, { ...init, headers });
}

const FAKE: ThreadMcpServer = { name: "fake", type: "http", url: "", headers: { Authorization: `Bearer ${UPSTREAM_SECRET}` } };

describe("the MCP proxy", () => {
	test("forwards with the entry's Authorization, never the VM token, and the session id round-trips", async () => {
		await shipThread([{ ...FAKE, url: upstreamUrl("/mcp") }]);
		const base = proxy();

		const first = await call(base, "fake", { method: "POST", body: '{"jsonrpc":"2.0","method":"initialize"}', headers: { "Content-Type": "application/json", Cookie: "a=b" } });
		expect(first.status).toBe(200);
		expect(first.headers.get("mcp-session-id")).toBe("session-1");
		expect(await first.json()).toEqual({ ok: true });

		const second = await call(base, "fake", { method: "POST", body: "{}", headers: { "Mcp-Session-Id": "session-1" } });
		expect(second.headers.get("mcp-session-id")).toBe("session-1");

		expect(seen.map(request => request.method)).toEqual(["POST", "POST"]);
		expect(seen[0]?.body).toBe('{"jsonrpc":"2.0","method":"initialize"}');
		expect(seen[0]?.path).toBe("/mcp");
		expect(seen[1]?.headers.get("mcp-session-id")).toBe("session-1");
		for (const request of seen) {
			expect(request.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_SECRET}`);
			expect(request.headers.get("cookie")).toBeNull();
			expect(JSON.stringify([...request.headers])).not.toContain(VM_TOKEN);
		}
	});

	test("an entry without an Authorization header gets the service's stored OAuth token", async () => {
		await shipThread([{ name: "oauth", type: "http", url: upstreamUrl("/mcp"), headers: {} }]);
		oauthToken = "oauth-access-token";
		const base = proxy();
		await call(base, "oauth", { method: "POST", body: "{}" });
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer oauth-access-token");

		oauthToken = null;
		await call(base, "oauth", { method: "POST", body: "{}" });
		expect(seen[1]?.headers.get("authorization")).toBeNull();
	});

	test("an entry's own headers win over the VM's, and DELETE is forwarded", async () => {
		await shipThread([{ ...FAKE, url: upstreamUrl("/mcp"), headers: { Authorization: `Bearer ${UPSTREAM_SECRET}`, "X-Api-Version": "2" } }]);
		const base = proxy();
		const response = await call(base, "fake", { method: "DELETE", headers: { "X-Api-Version": "1", "Mcp-Session-Id": "session-1" } });
		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("DELETE");
		expect(seen[0]?.headers.get("x-api-version")).toBe("2");
	});

	test("SSE events arrive before the upstream closes", async () => {
		await shipThread([{ ...FAKE, url: upstreamUrl("/sse") }]);
		const base = proxy();
		const response = await call(base, "fake", { method: "GET", headers: { Accept: "text/event-stream" } });
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body?.getReader();
		if (reader === undefined) throw new Error("no body");
		const decoder = new TextDecoder();
		let text = "";
		while (!text.includes("first")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("the stream ended before the first event");
			text += decoder.decode(chunk.value, { stream: true });
		}
		expect(text).toContain("data: first");
		expect(text).not.toContain("second");
		sseGate.resolve();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		expect(text).toContain("data: second");
	});

	test("a gzip upstream reaches the client as a readable body without content-encoding or content-length", async () => {
		await shipThread([{ ...FAKE, url: upstreamUrl("/gz") }]);
		const base = proxy();
		const response = await call(base, "fake", { method: "POST", body: "{}" });
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(await response.text()).toBe("hello from gzip");
		// The VM's own accept-encoding is not forwarded; Bun's fetch negotiates and decodes the upstream's compression itself.
	});

	test("an unknown or missing token is 401, and so is a deleted thread's", async () => {
		await shipThread([{ ...FAKE, url: upstreamUrl("/mcp") }]);
		const base = proxy();
		for (const token of ["not-a-token", null]) {
			const response = await call(base, "fake", { method: "POST", body: "{}" }, token);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unknown token" });
		}
		expect((await call(base, "fake", { method: "POST", body: "{}" })).status).toBe(200);
		await store.deleteThread(ID);
		expect((await call(base, "fake", { method: "POST", body: "{}" })).status).toBe(401);
		expect(seen).toHaveLength(1);
	});

	test("other paths and servers the thread does not ship are 404", async () => {
		await shipThread([{ ...FAKE, url: upstreamUrl("/mcp") }, { name: "local", type: "stdio", command: "x", args: [], env: {} }]);
		const base = proxy();
		expect((await fetch(`${base}/other`, { headers: { authorization: `Bearer ${VM_TOKEN}` } })).status).toBe(404);
		expect((await fetch(`${base}/mcp/fake/extra`, { headers: { authorization: `Bearer ${VM_TOKEN}` } })).status).toBe(404);
		expect((await call(base, "missing", { method: "POST", body: "{}" })).status).toBe(404);
		expect((await call(base, "local", { method: "POST", body: "{}" })).status).toBe(404);
		expect(seen).toHaveLength(0);
	});

	test("a loopback upstream is refused with 403 by the real check, before any connection", async () => {
		await shipThread([{ ...FAKE, url: upstreamUrl("/mcp") }]);
		const base = proxy({ refused: undefined });
		const response = await call(base, "fake", { method: "POST", body: "{}" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "the MCP server resolves to the service host" });
		expect(seen).toHaveLength(0);
	});

	test("an upstream at one of the service's own addresses is refused too", async () => {
		await shipThread([{ ...FAKE, url: "http://10.254.254.1:4000/mcp" }]);
		const base = proxy({ refused: undefined, own: ["10.254.254.1"] });
		expect((await call(base, "fake", { method: "POST", body: "{}" })).status).toBe(403);
	});

	test("an upstream that does not answer is 502", async () => {
		await shipThread([{ ...FAKE, url: "http://127.0.0.1:1/mcp" }]);
		const base = proxy();
		const response = await call(base, "fake", { method: "POST", body: "{}" });
		expect(response.status).toBe(502);
		const body: unknown = await response.json();
		expect(body).toMatchObject({ error: expect.stringContaining("the MCP server did not answer:") });
	});

	test("a taken listen address is logged and leaves the service without a proxy instead of throwing", async () => {
		const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("taken") });
		const logged = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(tryServeMcpProxy({ listen: { hostname: "127.0.0.1", port: taken.port ?? 0 }, store, credentials: { access: async () => null } })).toBeNull();
			expect(String(logged.mock.calls[0]?.[0])).toContain(`omp-cloud: the MCP proxy could not listen on 127.0.0.1:${taken.port}:`);
			const bound = tryServeMcpProxy({ listen: { hostname: "127.0.0.1", port: 0 }, store, credentials: { access: async () => null } });
			expect(bound).not.toBeNull();
			if (bound !== null) proxies.push(bound);
		} finally {
			logged.mockRestore();
			await taken.stop(true);
		}
	});
});

describe("the refused upstream ranges", () => {
	test.each(["127.0.0.1", "127.9.9.9", "::1", "[::1]", "0.0.0.0", "::", "169.254.169.254", "fe80::1", "::ffff:127.0.0.1"])("%s is refused", address => {
		expect(isRefusedUpstream(address)).toBe(true);
	});

	test.each(["10.0.0.5", "192.168.1.20", "172.16.0.1", "8.8.8.8", "fd00::1", "2606:4700::1"])("%s is allowed (a homelab server)", address => {
		expect(isRefusedUpstream(address)).toBe(false);
	});

	test("the service's own addresses are refused as well", () => {
		expect(isRefusedUpstream("10.254.254.1", ["10.254.254.1"])).toBe(true);
		expect(isRefusedUpstream("10.254.254.2", ["10.254.254.1"])).toBe(false);
	});

	test("host names: localhost and its subdomains are refused; other names are judged at resolution", () => {
		expect(isRefusedHost("localhost")).toBe(true);
		expect(isRefusedHost("LOCALHOST")).toBe(true);
		expect(isRefusedHost("api.localhost")).toBe(true);
		expect(isRefusedHost("[::1]")).toBe(true);
		expect(isRefusedHost("mcp.example.com")).toBe(false);
		expect(isRefusedHost("gateway.internal", ["gateway.internal"])).toBe(true);
	});
});
