import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DashboardForwarder, type ForwarderOptions, IDLE_STOP_MS, SESSION_IDLE_MS } from "../src/forwarder";
import { until } from "./fakes";

const TOKEN = "ompd_forwarder_test_token";

/** One request the fake service received. */
interface Seen {
	method: string;
	/** Path and query as sent. */
	target: string;
	headers: Headers;
	body: string;
}

let service: Bun.Server<undefined>;
let base = "";
let seen: Seen[] = [];
/** Set once the fake service notices the relayed event stream going away. */
let streamEnded = false;

const encoder = new TextEncoder();

beforeAll(() => {
	service = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async req => {
			const url = new URL(req.url);
			const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
			seen.push({ method: req.method, target: url.pathname + url.search, headers: req.headers, body });
			if (url.pathname === "/api/v1/threads") {
				return Response.json([{ id: "t1" }], {
					headers: { etag: '"v1"', "x-secret": "1", "set-cookie": "upstream=1; Path=/", "content-disposition": "inline" },
				});
			}
			if (url.pathname === "/api/v1/threads/x/answer") return new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "text/plain" } });
			if (url.pathname === "/api/v1/threads/x/events") {
				req.signal.addEventListener("abort", () => {
					streamEnded = true;
				});
				const stream = new ReadableStream<Uint8Array>({
					start: controller => controller.enqueue(encoder.encode("data: 1\n\n")),
					cancel: () => {
						streamEnded = true;
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
			}
			if (url.pathname.startsWith("/api/v1/dashboard/static/")) {
				return new Response("<html>dashboard</html>", {
					headers: { "content-type": "text/html", "cache-control": "max-age=60", etag: '"page"', "last-modified": "Tue, 20 Oct 2026 00:00:00 GMT", "x-secret": "1", "set-cookie": "upstream=1" },
				});
			}
			if (url.pathname === "/api/v1/redirect") return new Response(null, { status: 302, headers: { location: "/api/v1/threads" } });
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	base = `http://127.0.0.1:${service.port}`;
});

afterAll(() => service.stop(true));

const started: DashboardForwarder[] = [];

beforeEach(() => {
	seen = [];
	streamEnded = false;
});

afterEach(() => {
	for (const f of started.splice(0)) f.stop();
});

function start(options: Partial<ForwarderOptions> = {}): DashboardForwarder {
	const f = DashboardForwarder.start({ upstream: (url, init) => fetch(url, init), base, token: TOKEN, ...options });
	started.push(f);
	return f;
}

const MUTATE = { "X-Omp-Dashboard": "1", "Content-Type": "application/json" };

function signInRequest(f: DashboardForwarder, body: string, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${f.origin}/session`, { method: "POST", headers: { ...MUTATE, ...headers }, body });
}

/** Mints a code, trades it for a session and returns the `Cookie` header value that carries it. */
async function signIn(f: DashboardForwarder, previous?: string): Promise<string> {
	const res = await signInRequest(f, JSON.stringify({ code: f.mintCode().code }), previous === undefined ? {} : { Cookie: previous });
	expect(res.status).toBe(204);
	const cookie = res.headers.get("set-cookie")?.split(";")[0];
	if (cookie === undefined) throw new Error("no session cookie");
	return cookie;
}

/** Sends `request-line` and headers verbatim, so a path the URL parser would normalize reaches the listener as written. */
async function raw(port: number, target: string, extra = ""): Promise<string> {
	let received = "";
	const closed = Promise.withResolvers<void>();
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			data: (_socket, data) => {
				received += data.toString("utf8");
			},
			close: () => closed.resolve(),
			error: () => closed.resolve(),
		},
	});
	socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${extra}\r\n`);
	await closed.promise;
	return received;
}

function statusOf(response: string): number {
	return Number(response.split(" ")[1]);
}

describe("request guard", () => {
	test("a foreign Host is refused with 421, even for a signed-in browser", async () => {
		const f = start();
		const cookie = await signIn(f);
		for (const host of ["evil.test", `evil.test:${f.port}`, `127.0.0.1:${f.port + 1}`]) {
			const res = await fetch(`${f.origin}/api/v1/threads`, { headers: { Host: host, Cookie: cookie } });
			expect(res.status).toBe(421);
			expect(await res.json()).toEqual({ error: "unexpected host" });
		}
		expect(seen).toEqual([]);
		// localhost with the right port is ours.
		const res = await fetch(`${f.origin}/session`, { headers: { Host: `LocalHost:${f.port}`, Cookie: cookie } });
		expect(res.status).toBe(200);
	});

	test("Sec-Fetch-Site: only same-origin and none pass", async () => {
		const f = start();
		for (const site of ["cross-site", "same-site"]) {
			const res = await fetch(`${f.origin}/session`, { headers: { "Sec-Fetch-Site": site } });
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "cross-site request refused" });
		}
		for (const site of ["same-origin", "none"]) {
			expect((await fetch(`${f.origin}/session`, { headers: { "Sec-Fetch-Site": site } })).status).toBe(401);
		}
	});

	test("a foreign Origin is refused; the listener's own origin passes", async () => {
		const f = start();
		for (const origin of ["http://evil.test", `http://127.0.0.1:${f.port + 1}`, "null", "not a url"]) {
			const res = await signInRequest(f, JSON.stringify({ code: f.mintCode().code }), { Origin: origin });
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "cross-site request refused" });
		}
		// The Origin must also agree with the Host.
		const mismatch = await fetch(`${f.origin}/session`, { headers: { Host: `localhost:${f.port}`, Origin: `http://127.0.0.1:${f.port}` } });
		expect(mismatch.status).toBe(403);
		expect((await signInRequest(f, JSON.stringify({ code: f.mintCode().code }), { Origin: f.origin })).status).toBe(204);
	});

	test("a mutation needs X-Omp-Dashboard: 1", async () => {
		const f = start();
		const cookie = await signIn(f);
		const signing = await fetch(`${f.origin}/session`, { method: "POST", body: JSON.stringify({ code: f.mintCode().code }) });
		expect(signing.status).toBe(403);
		expect(await signing.json()).toEqual({ error: "x-omp-dashboard header required" });
		const deleting = await fetch(`${f.origin}/api/v1/threads/x`, { method: "DELETE", headers: { Cookie: cookie } });
		expect(deleting.status).toBe(403);
		const wrong = await fetch(`${f.origin}/api/v1/threads/x`, { method: "DELETE", headers: { Cookie: cookie, "X-Omp-Dashboard": "0" } });
		expect(wrong.status).toBe(403);
		expect(seen).toEqual([]);
	});

	test("the guard runs before routing, so it covers static paths and unknown ones", async () => {
		const f = start();
		expect((await fetch(`${f.origin}/`, { headers: { Host: "evil.test" } })).status).toBe(421);
		expect((await fetch(`${f.origin}/nope`, { method: "PUT" })).status).toBe(403);
		expect((await fetch(`${f.origin}/`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
		expect(seen).toEqual([]);
	});
});

describe("/session", () => {
	test("a pasted token is a failure, answers 401 and is never sent anywhere", async () => {
		const f = start();
		const res = await signInRequest(f, JSON.stringify({ token: "ompd_x" }));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "invalid or expired sign-in" });
		expect(res.headers.get("set-cookie")).toBeNull();
		// Not even the forwarder's own device token signs in.
		expect((await signInRequest(f, JSON.stringify({ token: TOKEN }))).status).toBe(401);
		expect(seen).toEqual([]);
	});

	test("anything but exactly one code is a 400", async () => {
		const f = start();
		const code = f.mintCode().code;
		for (const body of ["not json", "[]", "null", "{}", JSON.stringify({ code: "" }), JSON.stringify({ code: 7 }), JSON.stringify({ code, token: "ompd_x" }), JSON.stringify({ code, extra: 1 }), JSON.stringify({ token: 7 }), JSON.stringify({ code: "x".repeat(5000) })]) {
			const res = await signInRequest(f, body);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "send {code}" });
		}
		// None of those spent the code or counted against the limiter.
		expect((await signInRequest(f, JSON.stringify({ code }))).status).toBe(204);
	});

	test("an oversized body is refused on its declared length and on what is read", async () => {
		const f = start();
		const declared = await signInRequest(f, JSON.stringify({ code: "x".repeat(5000) }));
		expect(declared.status).toBe(400);
		// Chunked: no Content-Length to check, so the cap applies to what is read.
		const chunks = new ReadableStream<Uint8Array>({
			pull: controller => {
				controller.enqueue(encoder.encode("x".repeat(3000)));
			},
		});
		const abort = new AbortController();
		const chunked = await fetch(`${f.origin}/session`, { method: "POST", headers: MUTATE, body: chunks, duplex: "half", signal: abort.signal });
		abort.abort();
		expect(chunked.status).toBe(400);
	});

	test("five failures block the sixth attempt with 429, a valid code included", async () => {
		const f = start();
		for (let i = 0; i < 5; i++) expect((await signInRequest(f, JSON.stringify({ code: `wrong-${i}` }))).status).toBe(401);
		const blocked = await signInRequest(f, JSON.stringify({ code: f.mintCode().code }));
		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toEqual({ error: "too many failed sign-ins" });
		expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(blocked.headers.get("set-cookie")).toBeNull();
	});

	test("the failure window slides", async () => {
		let t = 1_000_000;
		const f = start({ now: () => t });
		for (let i = 0; i < 5; i++) expect((await signInRequest(f, JSON.stringify({ token: "ompd_x" }))).status).toBe(401);
		expect((await signInRequest(f, JSON.stringify({ code: "x" }))).status).toBe(429);
		t += 60_001;
		expect((await signInRequest(f, JSON.stringify({ code: f.mintCode().code }))).status).toBe(204);
	});

	test("a valid code opens a session: cookie attributes, GET with and without it, then the code is spent", async () => {
		const f = start();
		const { code, expiresAt } = f.mintCode();
		expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
		const res = await signInRequest(f, JSON.stringify({ code }));
		expect(res.status).toBe(204);
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toMatch(/^omp_cloud_session=[A-Za-z0-9_-]{43}; /);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("Max-Age=604800");
		expect(setCookie).not.toContain("Secure");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");

		const cookie = setCookie.split(";")[0] as string;
		const live = await fetch(`${f.origin}/session`, { headers: { Cookie: cookie } });
		expect(live.status).toBe(200);
		expect(await live.json()).toEqual({ user: "owner" });
		const anonymous = await fetch(`${f.origin}/session`);
		expect(anonymous.status).toBe(401);
		expect(await anonymous.json()).toEqual({ error: "unauthorized" });
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: "omp_cloud_session=forged" } })).status).toBe(401);

		const reused = await signInRequest(f, JSON.stringify({ code }));
		expect(reused.status).toBe(401);
		expect(await reused.json()).toEqual({ error: "invalid or expired sign-in" });
	});

	test("an expired code is refused", async () => {
		let t = 5_000_000;
		const f = start({ now: () => t });
		const { code } = f.mintCode();
		t += 60_000;
		expect((await signInRequest(f, JSON.stringify({ code }))).status).toBe(401);
		const fresh = f.mintCode().code;
		t += 59_999;
		expect((await signInRequest(f, JSON.stringify({ code: fresh }))).status).toBe(204);
	});

	test("a wrong code is spent when presented, never guessable twice", async () => {
		const f = start();
		expect((await signInRequest(f, JSON.stringify({ code: "not-minted" }))).status).toBe(401);
		const { code } = f.mintCode();
		expect((await signInRequest(f, JSON.stringify({ code }))).status).toBe(204);
		expect((await signInRequest(f, JSON.stringify({ code }))).status).toBe(401);
	});

	test("only 16 codes are kept: the oldest is evicted", async () => {
		const f = start();
		const codes = Array.from({ length: 17 }, () => f.mintCode().code);
		expect((await signInRequest(f, JSON.stringify({ code: codes[0] }))).status).toBe(401);
		expect((await signInRequest(f, JSON.stringify({ code: codes[16] }))).status).toBe(204);
	});

	test("only 32 sessions are kept: the oldest is evicted", async () => {
		const f = start();
		const first = await signIn(f);
		for (let i = 0; i < 31; i++) await signIn(f);
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: first } })).status).toBe(200);
		const last = await signIn(f);
		// Opening a 33rd evicts the first.
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: first } })).status).toBe(401);
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: last } })).status).toBe(200);
	});

	test("a session idles out after 12 h unless used, and ends 7 d after it began", async () => {
		let t = 10_000_000;
		const f = start({ now: () => t });
		const cookie = await signIn(f);
		t += SESSION_IDLE_MS - 1;
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: cookie } })).status).toBe(200);
		t += SESSION_IDLE_MS - 1;
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: cookie } })).status).toBe(200);
		t += SESSION_IDLE_MS;
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: cookie } })).status).toBe(401);

		const capped = await signIn(f);
		// Used every 11 h, so the idle window never closes it: only the 7 d cap (168 h) does, between 165 h and 176 h.
		for (let step = 1; step <= 15; step++) {
			t += 11 * 3_600_000;
			expect((await fetch(`${f.origin}/session`, { headers: { Cookie: capped } })).status, `after ${step * 11} h`).toBe(200);
		}
		t += 11 * 3_600_000;
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: capped } })).status).toBe(401);
	});

	test("signing in again closes the previous session", async () => {
		const f = start();
		const first = await signIn(f);
		const second = await signIn(f, first);
		expect(second).not.toBe(first);
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: first } })).status).toBe(401);
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: second } })).status).toBe(200);
	});

	test("DELETE closes the session and clears the cookie; other methods are 404", async () => {
		const f = start();
		const cookie = await signIn(f);
		const out = await fetch(`${f.origin}/session`, { method: "DELETE", headers: { ...MUTATE, Cookie: cookie } });
		expect(out.status).toBe(204);
		expect(out.headers.get("set-cookie")).toMatch(/^omp_cloud_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict/);
		expect((await fetch(`${f.origin}/session`, { headers: { Cookie: cookie } })).status).toBe(401);
		// Without a session it still answers 204.
		expect((await fetch(`${f.origin}/session`, { method: "DELETE", headers: MUTATE })).status).toBe(204);
		const put = await fetch(`${f.origin}/session`, { method: "PUT", headers: MUTATE });
		expect(put.status).toBe(404);
		expect(await put.json()).toEqual({ error: "not found" });
	});
});

describe("/api/v1 relay", () => {
	test("relays with the device token and none of the browser's own headers", async () => {
		const f = start();
		const cookie = await signIn(f);
		const res = await fetch(`${f.origin}/api/v1/threads?after=3&limit=2`, {
			headers: {
				Cookie: cookie,
				Authorization: "Bearer browser-supplied",
				Referer: `${f.origin}/`,
				Origin: f.origin,
				Accept: "application/json",
				"Last-Event-ID": "9",
				"X-Omp-Dashboard": "1",
				"X-Other": "nope",
			},
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([{ id: "t1" }]);
		expect(seen).toHaveLength(1);
		const [request] = seen as [Seen];
		expect(request.method).toBe("GET");
		expect(request.target).toBe("/api/v1/threads?after=3&limit=2");
		expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(request.headers.get("accept")).toBe("application/json");
		expect(request.headers.get("last-event-id")).toBe("9");
		for (const name of ["cookie", "origin", "referer", "x-omp-dashboard", "x-other"]) expect(request.headers.get(name)).toBeNull();
		expect(request.headers.get("host")).toBe(new URL(base).host);
	});

	test("without a live session cookie nothing reaches the service", async () => {
		const f = start();
		const none = await fetch(`${f.origin}/api/v1/threads`);
		expect(none.status).toBe(401);
		expect(await none.json()).toEqual({ error: "unauthorized" });
		expect((await fetch(`${f.origin}/api/v1/threads`, { headers: { Cookie: "omp_cloud_session=forged" } })).status).toBe(401);
		expect((await fetch(`${f.origin}/api/v1/threads`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
		const cookie = await signIn(f);
		await fetch(`${f.origin}/session`, { method: "DELETE", headers: { ...MUTATE, Cookie: cookie } });
		expect((await fetch(`${f.origin}/api/v1/threads`, { headers: { Cookie: cookie } })).status).toBe(401);
		expect(seen).toEqual([]);
	});

	test("the response keeps only the allowed headers and is no-store unless the service set a policy", async () => {
		const f = start();
		const cookie = await signIn(f);
		const res = await fetch(`${f.origin}/api/v1/threads`, { headers: { Cookie: cookie } });
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("etag")).toBe('"v1"');
		expect(res.headers.get("content-disposition")).toBe("inline");
		expect(res.headers.get("x-secret")).toBeNull();
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		await res.arrayBuffer();

		const events = await fetch(`${f.origin}/api/v1/threads/x/events`, { headers: { Cookie: cookie } });
		expect(events.headers.get("cache-control")).toBe("no-cache");
		expect(events.headers.get("x-content-type-options")).toBe("nosniff");
		await events.body?.cancel();
	});

	test("a request body streams through with its method and content type", async () => {
		const f = start();
		const cookie = await signIn(f);
		const res = await fetch(`${f.origin}/api/v1/threads/x/answer`, { method: "POST", headers: { ...MUTATE, Cookie: cookie }, body: '{"answer":"yes"}' });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"answer":"yes"}');
		const [request] = seen as [Seen];
		expect(request.method).toBe("POST");
		expect(request.body).toBe('{"answer":"yes"}');
		expect(request.headers.get("content-type")).toBe("application/json");
	});

	test("an event stream streams, and the browser leaving aborts the upstream request", async () => {
		const f = start();
		const cookie = await signIn(f);
		const abort = new AbortController();
		const res = await fetch(`${f.origin}/api/v1/threads/x/events`, { headers: { Cookie: cookie, Accept: "text/event-stream", "Last-Event-ID": "4" }, signal: abort.signal });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("data: 1\n\n");
		expect(streamEnded).toBe(false);
		expect(seen[0]?.headers.get("last-event-id")).toBe("4");
		abort.abort();
		await until(() => streamEnded);
	});

	test("the service's links path is 404 for a signed-in browser", async () => {
		const f = start();
		const cookie = await signIn(f);
		for (const path of ["/api/v1/dashboard/links", "/api/v1/dashboard/links/"]) {
			const res = await fetch(`${f.origin}${path}`, { method: "POST", headers: { ...MUTATE, Cookie: cookie } });
			expect(res.status).toBe(404);
		}
		expect(seen).toEqual([]);
	});

	test("an unknown /api/ path that is not /api/v1/ is 404 without reaching the service", async () => {
		const f = start();
		const cookie = await signIn(f);
		expect((await fetch(`${f.origin}/api/other`, { headers: { Cookie: cookie } })).status).toBe(404);
		expect(seen).toEqual([]);
	});

	test("encoded separators, `..` in any other form and empty segments are refused", async () => {
		const f = start();
		const cookie = await signIn(f);
		const targets = ["/api/v1/a%2fb", "/api/v1/a%2Fb", "/api/v1/a%5cb", "/api/v1/a%5Cb", "/api/v1//x", "/api/v1/a%2eb", "/api/v1/a..b", "/api/v1/..;/x", "/api/v1/%2e%2e%2fb"];
		for (const target of targets) {
			const response = await raw(f.port, target, `Cookie: ${cookie}\r\n`);
			expect(statusOf(response), target).toBe(400);
			expect(response).toContain('{"error":"bad path"}');
		}
		expect(seen).toEqual([]);
	});

	test("dot segments are resolved by the HTTP server before routing, so they cannot climb out of /api/v1/", async () => {
		const f = start();
		const cookie = await signIn(f);
		// Out of /api/v1/ is out of the relay: the routed path is /api/x.
		for (const target of ["/api/v1/../x", "/api/v1/%2e%2e/x", "/api/v1/a/../../x"]) {
			expect(statusOf(await raw(f.port, target, `Cookie: ${cookie}\r\n`)), target).toBe(404);
		}
		expect(seen).toEqual([]);
		// Staying inside it relays the resolved path.
		expect(statusOf(await raw(f.port, "/api/v1/a/../threads", `Cookie: ${cookie}\r\n`))).toBe(200);
		expect(seen.map(s => s.target)).toEqual(["/api/v1/threads"]);
	});

	test("a service that cannot be reached or that redirects is a 502", async () => {
		const dead = start({
			upstream: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		const deadCookie = await signIn(dead);
		const refused = await fetch(`${dead.origin}/api/v1/threads`, { headers: { Cookie: deadCookie } });
		expect(refused.status).toBe(502);
		expect(await refused.json()).toEqual({ error: "cannot reach the service" });

		const f = start({ upstream: (url, init) => fetch(url, init) });
		const cookie = await signIn(f);
		const redirected = await fetch(`${f.origin}/api/v1/redirect`, { headers: { Cookie: cookie }, redirect: "manual" });
		expect(redirected.status).toBe(502);
		expect(redirected.headers.get("location")).toBeNull();
		// The service did get the one request; the redirect was not followed.
		expect(seen.map(s => s.target)).toEqual(["/api/v1/redirect"]);
	});

	test("the upstream is always asked not to follow redirects", async () => {
		const inits: (RequestInit | undefined)[] = [];
		const f = start({
			upstream: async (_url, init) => {
				inits.push(init);
				return new Response("ok");
			},
		});
		const cookie = await signIn(f);
		await fetch(`${f.origin}/api/v1/threads`, { headers: { Cookie: cookie } });
		await fetch(`${f.origin}/`);
		expect(inits.map(init => init?.redirect)).toEqual(["error", "error"]);
	});
});

describe("static relay", () => {
	test("GET / relays to the dashboard's static root with the device token and no session", async () => {
		const f = start();
		const res = await fetch(`${f.origin}/`, {
			headers: { Cookie: "omp_cloud_session=anything", Authorization: "Bearer browser", "If-None-Match": '"old"', "If-Modified-Since": "Mon, 19 Oct 2026 00:00:00 GMT", Accept: "text/html", "X-Other": "nope", Origin: f.origin },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<html>dashboard</html>");
		const [request] = seen as [Seen];
		expect(request.method).toBe("GET");
		expect(request.target).toBe("/api/v1/dashboard/static/");
		expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(request.headers.get("if-none-match")).toBe('"old"');
		expect(request.headers.get("if-modified-since")).toBe("Mon, 19 Oct 2026 00:00:00 GMT");
		expect(request.headers.get("accept")).toBe("text/html");
		for (const name of ["cookie", "origin", "x-other"]) expect(request.headers.get(name)).toBeNull();

		expect(res.headers.get("content-type")).toBe("text/html");
		expect(res.headers.get("cache-control")).toBe("max-age=60");
		expect(res.headers.get("etag")).toBe('"page"');
		expect(res.headers.get("last-modified")).toBe("Tue, 20 Oct 2026 00:00:00 GMT");
		expect(res.headers.get("x-secret")).toBeNull();
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});

	test("an asset path is prefixed and its query dropped; HEAD is relayed as HEAD", async () => {
		const f = start();
		const res = await fetch(`${f.origin}/assets/app.js?v=1&token=secret`);
		expect(res.status).toBe(200);
		await res.arrayBuffer();
		const head = await fetch(`${f.origin}/assets/app.css`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(seen.map(s => `${s.method} ${s.target}`)).toEqual(["GET /api/v1/dashboard/static/assets/app.js", "HEAD /api/v1/dashboard/static/assets/app.css"]);
	});

	test("encoded separators, `..` in any other form and empty segments are refused", async () => {
		const f = start();
		for (const target of ["/a%2fb", "/a%2Fb", "/a%5cb", "/a%5Cb", "//x", "/a%2eb", "/a..b", "/..;/x", "/%2e%2e%2fb", "/a/..%2fb"]) {
			const response = await raw(f.port, target);
			expect(statusOf(response), target).toBe(400);
			expect(response).toContain('{"error":"bad path"}');
		}
		expect(seen).toEqual([]);
	});

	test("dot segments and backslashes are resolved by the HTTP server before routing, so the relayed path is the routed one", async () => {
		const f = start();
		for (const target of ["/../x", "/%2e%2e/x", "/a/../../x", "/a\\..\\x"]) {
			expect(statusOf(await raw(f.port, target)), target).toBe(200);
		}
		expect(seen.map(s => s.target)).toEqual(Array(4).fill("/api/v1/dashboard/static/x"));
	});

	test("other methods on other paths are 404", async () => {
		const f = start();
		const post = await fetch(`${f.origin}/`, { method: "POST", headers: MUTATE, body: "{}" });
		expect(post.status).toBe(404);
		expect(await post.json()).toEqual({ error: "not found" });
		expect((await fetch(`${f.origin}/assets/x.js`, { method: "DELETE", headers: MUTATE })).status).toBe(404);
		expect(seen).toEqual([]);
	});

	test("a service that redirects, or is down, is a 502 for the page too", async () => {
		const down = start({
			upstream: async () => {
				throw new Error("down");
			},
		});
		expect((await fetch(`${down.origin}/`)).status).toBe(502);
		const redirecting = start({ base: `${base}/api/v1/redirect?` });
		expect((await fetch(`${redirecting.origin}/`, { redirect: "manual" })).status).toBe(502);
	});
});

describe("lifetime", () => {
	test("start binds a free loopback port; stop closes it, is idempotent and drops the exit listener", async () => {
		const before = process.listenerCount("exit");
		const f = start();
		expect(f.stopped).toBe(false);
		expect(f.origin).toBe(`http://127.0.0.1:${f.port}`);
		expect(f.port).toBeGreaterThan(0);
		expect(process.listenerCount("exit")).toBe(before + 1);
		expect((await fetch(`${f.origin}/session`)).status).toBe(401);
		f.stop();
		f.stop();
		expect(f.stopped).toBe(true);
		expect(process.listenerCount("exit")).toBe(before);
		await expect(fetch(`${f.origin}/session`)).rejects.toThrow();
	});

	test("two forwarders get distinct ports and sessions do not cross", async () => {
		const a = start();
		const b = start();
		expect(a.port).not.toBe(b.port);
		const cookie = await signIn(a);
		expect((await fetch(`${b.origin}/session`, { headers: { Cookie: cookie } })).status).toBe(401);
		// A code from one is no good at the other.
		expect((await signInRequest(b, JSON.stringify({ code: a.mintCode().code }))).status).toBe(401);
	});

	test("it stops after idleStopMs without a request", async () => {
		expect(IDLE_STOP_MS).toBe(24 * 3_600_000);
		const f = start({ idleStopMs: 30 });
		await until(() => f.stopped);
		await expect(fetch(`${f.origin}/session`)).rejects.toThrow();
	});
});
