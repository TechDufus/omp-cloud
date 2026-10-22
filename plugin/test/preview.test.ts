import { afterEach, describe, expect, test } from "bun:test";
import { completions, parseCommand, USAGE_PREVIEW, type Command } from "../src/commands";
import type { FetchFn } from "../src/api";
import { SESSION_COOKIE } from "../src/forwarder";
import { PreviewForwarder } from "../src/preview";
import { resolveParsed } from "../src/resolve";
import { helpLines } from "../src/watch";

const THREAD = "k3x9fa2m7q1z";
const BASE = "https://10.0.0.42:8443/";

interface Seen {
	url: string;
	method: string;
	headers: Headers;
	redirect: RequestInit["redirect"];
	body: string;
}

const started: PreviewForwarder[] = [];

function start(upstream: FetchFn, port = 8000): PreviewForwarder {
	const forwarder = PreviewForwarder.start({ upstream, base: BASE, token: "ompd_secret", thread: THREAD, port });
	started.push(forwarder);
	return forwarder;
}

/** An upstream that records the request it got and answers with `answer`. */
function recording(answer: (seen: Seen) => Response | Promise<Response>): { fetch: FetchFn; seen: Seen[] } {
	const seen: Seen[] = [];
	return {
		seen,
		fetch: async (input, init) => {
			const entry: Seen = {
				url: input,
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				redirect: init?.redirect,
				body: init?.body ? await new Response(init.body as ReadableStream | string).text() : "",
			};
			seen.push(entry);
			return answer(entry);
		},
	};
}

afterEach(() => {
	for (const f of started.splice(0)) f.stop();
});

describe("parseCommand: preview", () => {
	test("takes a thread and a port, or stop", () => {
		expect(parseCommand("preview abc123 8000")).toEqual({ kind: "preview", token: "abc123", port: 8000 });
		expect(parseCommand("preview stop")).toEqual({ kind: "previewStop" });
		expect(parseCommand("PREVIEW Stop")).toEqual({ kind: "previewStop" });
	});

	test("anything else is the usage, and a port the service refuses is refused here", () => {
		for (const bad of ["preview", "preview abc123", "preview abc123 http", "preview abc123 80x", "preview abc123 8000 extra", "preview stop now", "preview 'abc 8000"]) {
			expect(parseCommand(bad)).toEqual({ kind: "error", message: USAGE_PREVIEW });
		}
		for (const port of ["0", "65536", "49983"]) expect(parseCommand(`preview abc123 ${port}`)).toEqual({ kind: "error", message: "☁ port must be 1 to 65535 and not 49983" });
	});

	test("the thread is resolved and the port kept; stop needs no thread", async () => {
		const client = {
			thread: async (id: string) => ({ id }) as never,
			listThreadsPage: async () => ({ threads: [], total: 0 }) as never,
		};
		const resolved: Command = await resolveParsed({ kind: "preview", token: THREAD, port: 3000 }, client);
		expect(resolved).toEqual({ kind: "preview", thread: THREAD, port: 3000 });
		expect(await resolveParsed({ kind: "previewStop" }, client)).toEqual({ kind: "previewStop" });
	});

	test("completes the verb and, after it, thread ids; help lists it", () => {
		expect(completions("prev", [])?.map(c => c.value)).toEqual(["preview"]);
		expect(completions("preview k3", [{ id: THREAD, name: "dev server", title: "", phase: "idle" } as never])?.map(c => c.value)).toEqual([`preview ${THREAD}`]);
		expect(completions(`preview ${THREAD} `, [])).toBeNull();
		expect(helpLines().some(l => l.startsWith("/cloud preview <id> <port>"))).toBe(true);
	});
});

describe("PreviewForwarder", () => {
	test("relays any method and path, with query and body, to the thread's port route with the bearer token", async () => {
		const up = recording(seen => new Response(`got ${seen.method} ${seen.body}`, { status: 201, headers: { "content-type": "text/plain", "x-app": "1" } }));
		const f = start(up.fetch);
		const res = await fetch(`${f.url}api/items?page=2`, { method: "POST", body: "payload", headers: { "content-type": "application/json", authorization: "Bearer browser-token" } });
		expect(res.status).toBe(201);
		expect(res.headers.get("x-app")).toBe("1");
		expect(await res.text()).toBe("got POST payload");
		expect(up.seen).toHaveLength(1);
		const [seen] = up.seen;
		expect(seen?.url).toBe(`https://10.0.0.42:8443/api/v1/threads/${THREAD}/ports/8000/api/items?page=2`);
		expect(seen?.headers.get("authorization")).toBe("Bearer ompd_secret");
		expect(seen?.headers.get("content-type")).toBe("application/json");
		expect(seen?.redirect).toBe("manual");
		expect(f.url).toBe(`http://localhost:${f.port}/`);
	});

	test("streams the response: the first chunk reaches the browser before the upstream finishes", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const encoder = new TextEncoder();
		const up = recording(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(encoder.encode("first;"));
							await gate;
							controller.enqueue(encoder.encode("second"));
							controller.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const f = start(up.fetch);
		const res = await fetch(`${f.url}events`);
		const reader = res.body?.getReader();
		expect(reader).toBeDefined();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toBe("first;");
		release();
		const rest = await reader?.read();
		expect(new TextDecoder().decode(rest?.value)).toBe("second");
		expect((await reader?.read())?.done).toBe(true);
	});

	test("streams the request body upstream", async () => {
		const up = recording(seen => new Response(String(seen.body.length)));
		const f = start(up.fetch);
		const big = "x".repeat(300_000);
		const res = await fetch(`${f.url}upload`, { method: "PUT", body: big });
		expect(await res.text()).toBe("300000");
	});

	test("answers only on localhost:<port>: 127.0.0.1 gets a 400 that names the address, and nothing is relayed", async () => {
		const up = recording(() => new Response("never"));
		const f = start(up.fetch);
		const res = await fetch(`http://127.0.0.1:${f.port}/`);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: `open http://localhost:${f.port}/` });
		const rebound = await fetch(`http://127.0.0.1:${f.port}/`, { headers: { host: "evil.example" } });
		expect(rebound.status).toBe(400);
		expect(up.seen).toEqual([]);
	});

	test("the dashboard's session cookie never goes upstream, and the app's own cookies do", async () => {
		const up = recording(() => new Response("ok"));
		const f = start(up.fetch);
		await fetch(`${f.url}`, { headers: { cookie: `a=1; ${SESSION_COOKIE}=sess; b=2` } });
		await fetch(`${f.url}`, { headers: { cookie: `${SESSION_COOKIE}=sess` } });
		await fetch(`${f.url}`, { headers: { cookie: `x${SESSION_COOKIE}=keep` } });
		expect(up.seen.map(s => s.headers.get("cookie"))).toEqual(["a=1; b=2", null, `x${SESSION_COOKIE}=keep`]);
	});

	test("an upstream Set-Cookie named omp_cloud_session is dropped, the app's own are kept", async () => {
		const headers = new Headers();
		headers.append("set-cookie", `${SESSION_COOKIE}=evil; Path=/`);
		headers.append("set-cookie", "app=1; Path=/; HttpOnly");
		headers.append("set-cookie", "theme=dark");
		const up = recording(() => new Response("ok", { headers }));
		const f = start(up.fetch);
		const res = await fetch(f.url);
		expect(res.headers.getSetCookie()).toEqual(["app=1; Path=/; HttpOnly", "theme=dark"]);
	});

	test("hop-by-hop headers and a decoded body's length and encoding are not relayed", async () => {
		const up = recording(
			() => new Response("body", { headers: { "content-encoding": "gzip", "content-length": "999", "x-keep": "yes", "keep-alive": "timeout=5" } }),
		);
		const f = start(up.fetch);
		const res = await fetch(f.url, { headers: { "accept-encoding": "gzip" } });
		expect(await res.text()).toBe("body");
		expect(res.headers.get("x-keep")).toBe("yes");
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(up.seen[0]?.headers.get("accept-encoding")).toBeNull();
	});

	test("an app's own redirect and error statuses reach the browser unchanged", async () => {
		const up = recording(seen => (seen.url.endsWith("/dir") ? new Response(null, { status: 302, headers: { location: "/dir/" } }) : new Response("nope", { status: 404 })));
		const f = start(up.fetch);
		const redirected = await fetch(`${f.url}dir`, { redirect: "manual" });
		expect(redirected.status).toBe(302);
		expect(redirected.headers.get("location")).toBe("/dir/");
		expect((await fetch(`${f.url}missing`)).status).toBe(404);
	});

	test("a websocket upgrade is 501 and a path that climbs out of the route is 400, neither relayed", async () => {
		const up = recording(() => new Response("never"));
		const f = start(up.fetch);
		const ws = await fetch(f.url, { headers: { connection: "Upgrade", upgrade: "websocket" } });
		expect(ws.status).toBe(501);
		expect(await ws.json()).toEqual({ error: "WebSocket upgrades are not forwarded" });
		// The client's own URL parsing already resolves a bare `%2e%2e` segment, so only what survives it can reach the relay.
		for (const path of ["a%2E%2Eb", "x%5Cy", "a/%2e/b%2e%2e"]) expect((await fetch(`${f.url}${path}`)).status).toBe(400);
		expect(up.seen).toEqual([]);
	});

	test("an unreachable service is a 502 that does not show the token", async () => {
		const f = start(async () => {
			throw new Error("connect ECONNREFUSED ompd_secret");
		});
		const res = await fetch(f.url);
		expect(res.status).toBe(502);
		expect(await res.text()).not.toContain("ompd_secret");
	});

	test("two previews have two ports and stop on their own", async () => {
		const up = recording(() => new Response("ok"));
		const a = start(up.fetch, 8000);
		const b = start(up.fetch, 3000);
		expect(a.port).not.toBe(b.port);
		await fetch(b.url);
		expect(up.seen[0]?.url).toContain("/ports/3000/");
		a.stop();
		expect(a.stopped).toBe(true);
		expect(b.stopped).toBe(false);
		expect((await fetch(b.url)).status).toBe(200);
		await expect(fetch(a.url)).rejects.toThrow();
	});
});
