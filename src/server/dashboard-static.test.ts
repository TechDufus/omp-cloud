import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { serveDashboard } from "../dashboard/serve";
import { DashboardSessions } from "../dashboard/session";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { RemoteAccess } from "../pairing/remote";
import { pairDevice } from "../pairing/test-support";
import { Settings } from "../settings";
import { Store } from "../store";
import type { ApiServer } from "./api-server";
import { type App, createApp } from "./app";
import { tokenSha256 } from "./auth";
import { staticTarget } from "./dashboard-static";
import { ApiError } from "./errors";

const TOKEN = "s3cret-token";
const PREFIX = "/api/v1/dashboard/static";
const gateway = { served: ["anthropic"], providers: () => ["anthropic"], refresh: async (): Promise<void> => undefined };

/** What the stand-in dashboard saw and what it answers; tests change `answer`. */
interface Upstream {
	server: Bun.Server<undefined>;
	origin: string;
	seen: { method: string; path: string; headers: Headers }[];
	answer: (req: Request) => Response | Promise<Response>;
}

let dir: string;
let store: Store;
let app: App;
let upstream: Upstream;

async function startUpstream(): Promise<Upstream> {
	const state: Upstream = {
		server: Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => handle(req) }),
		origin: "",
		seen: [],
		answer: () => new Response("not found", { status: 404 }),
	};
	function handle(req: Request): Response | Promise<Response> {
		state.seen.push({ method: req.method, path: new URL(req.url).pathname, headers: req.headers });
		return state.answer(req);
	}
	state.origin = `http://127.0.0.1:${state.server.port}`;
	return state;
}

async function buildApp(withDashboard: boolean, upstreamOrigin = upstream.origin): Promise<App> {
	return createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: { default: "fake/fake-model", direct: ["fake"], gateway },
		ompVersion: "18.12.3",
		logins: new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: "/nonexistent/auth-broker.token" }),
		settings: Settings.load(store),
		git: await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 10, pushTimeoutSeconds: 10 }),
		dashboard: withDashboard ? { origin: "http://127.0.0.1:8081", upstream: upstreamOrigin, sessions: new DashboardSessions() } : undefined,
		remote: {
			listen: { hostname: "0.0.0.0", port: 8443 },
			fingerprint: `SHA256:${"A".repeat(43)}`,
			fingerprintCode: "A".repeat(43),
			access: new RemoteAccess(["10.0.0.0/8"], []),
		},
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-static-"));
	store = Store.open({ dataDir: dir });
	upstream = await startUpstream();
	app = await buildApp(true);
});

afterEach(async () => {
	await upstream.server.stop(true);
	store.close();
	await rm(dir, { recursive: true, force: true });
});

const device = (): string => pairDevice(store).token;

function from(address: string): ApiServer {
	return { requestIP: () => ({ address, family: "IPv4", port: 40000 }), timeout: () => {} };
}

/** A relayed request over the remote entry point, as a paired device makes it. */
function relay(path: string, token: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	return app.fetchRemote(new Request(`http://omp.test${PREFIX}${path}`, { ...init, headers }), from("10.0.0.5"));
}

async function errorOf(res: Response): Promise<string> {
	const body: unknown = await res.json();
	if (!isRecord(body) || typeof body.error !== "string") throw new Error("not an error body");
	return body.error;
}

describe("staticTarget", () => {
	const origin = "http://127.0.0.1:8081";

	test("the page is the upstream's root, an asset is its chunk path", () => {
		expect(staticTarget("", origin).href).toBe(`${origin}/`);
		expect(staticTarget("/", origin).href).toBe(`${origin}/`);
		expect(staticTarget("/chunk-wafw10ac.js", origin).href).toBe(`${origin}/chunk-wafw10ac.js`);
		expect(staticTarget("/chunk-jkwb4e04.css", origin).href).toBe(`${origin}/chunk-jkwb4e04.css`);
	});

	test.each([
		"/..",
		"/../x",
		"/chunk-a.js/..",
		"/%2e%2e/x",
		"/%2E/chunk-a.js",
		"/chunk-a%2fb.js",
		"/chunk-a%2Fb.js",
		"/chunk-a%5cb.js",
		"/chunk-a%5Cb.js",
		"\\chunk-a.js",
		"/chunk-a\\b.js",
		"//evil.example/chunk-a.js",
		"/chunk-a.js//",
		"/@evil.example/chunk-a.js",
		"@evil.example",
		"/chunk-a.js#x",
		"/chunk-a.js?x=1",
		"?x",
		"/index.html",
		"/_bun/client/x.js",
		"/chunk-.js",
		"/chunk-A.js",
		"chunk-a.js",
		"/chunk-a.js.map",
		"/api/v1/whoami",
	])("refuses %p", path => {
		expect(() => staticTarget(path, origin)).toThrow(ApiError);
		try {
			staticTarget(path, origin);
		} catch (error) {
			expect(error instanceof ApiError && error.status).toBe(400);
		}
	});
});

describe("the relay", () => {
	test("serves the page for the empty path and /, to a device and to the owner", async () => {
		upstream.answer = () => new Response("<html>page</html>", { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache", etag: '"abc"' } });
		const token = device();
		for (const path of ["", "/"]) {
			const res = await relay(path, token);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("<html>page</html>");
			expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
			expect(res.headers.get("cache-control")).toBe("no-cache");
			expect(res.headers.get("etag")).toBe('"abc"');
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		}
		const owner = await app.fetch(new Request(`http://omp.test${PREFIX}/`, { headers: { Authorization: `Bearer ${TOKEN}` } }));
		expect(owner.status).toBe(200);
		expect(upstream.seen.map(s => s.path)).toEqual(["/", "/", "/"]);
	});

	test("serves an asset with the upstream's caching headers and passes a conditional request through", async () => {
		upstream.answer = req =>
			req.headers.get("if-none-match") === '"v1"'
				? new Response(null, { status: 304, headers: { etag: '"v1"' } })
				: new Response("console.log(1)", { headers: { "content-type": "text/javascript;charset=utf-8", "cache-control": "public, max-age=31536000, immutable", etag: '"v1"', "last-modified": "Tue, 20 Oct 2026 00:00:00 GMT" } });
		const token = device();
		const first = await relay("/chunk-wafw10ac.js", token);
		expect(first.status).toBe(200);
		expect(await first.text()).toBe("console.log(1)");
		expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(first.headers.get("last-modified")).toBe("Tue, 20 Oct 2026 00:00:00 GMT");
		const again = await relay("/chunk-wafw10ac.js", token, { headers: { "if-none-match": '"v1"' } });
		expect(again.status).toBe(304);
		expect(upstream.seen.at(-1)?.path).toBe("/chunk-wafw10ac.js");
	});

	test("HEAD is served and an unknown upstream path stays the upstream's 404", async () => {
		upstream.answer = req => new Response(req.method === "HEAD" ? null : "x", { headers: { "content-type": "text/css" } });
		const head = await relay("/chunk-abc.css", device(), { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(upstream.seen.at(-1)?.method).toBe("HEAD");
		upstream.answer = () => new Response("gone", { status: 404 });
		expect((await relay("/chunk-zzz.js", device())).status).toBe(404);
	});

	test("refuses the paths staticTarget refuses, as sent over the wire, and never asks the upstream", async () => {
		const token = device();
		// The URL parser itself folds `%2e` segments away, so the dot cases only reach the pure function above.
		for (const path of ["/chunk-a%2fb.js", "/chunk-a%5cb.js", "//chunk-a.js", "/@evil/chunk-a.js", "/other.js", "/chunk-a.js%00"]) {
			const res = await relay(path, token);
			expect([path, res.status]).toEqual([path, 400]);
			expect(await errorOf(res)).toBe("invalid dashboard path");
		}
		expect((await relay("/..%2f..%2fapi", token)).status).toBe(400);
		expect(upstream.seen).toEqual([]);
	});

	test("a path that only starts like the prefix is not the relay", async () => {
		const res = await app.fetch(new Request(`http://omp.test${PREFIX}x/chunk-a.js`, { headers: { Authorization: `Bearer ${TOKEN}` } }));
		expect(res.status).toBe(404);
		expect(await errorOf(res)).toBe("not found");
		expect(upstream.seen).toEqual([]);
	});

	test("only GET and HEAD", async () => {
		const token = device();
		for (const method of ["POST", "PUT", "DELETE"]) expect((await relay("/", token, { method })).status).toBe(404);
		expect(upstream.seen).toEqual([]);
	});

	test("a redirect from the upstream is a 502, never followed", async () => {
		upstream.answer = () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
		const res = await relay("/", device());
		expect(res.status).toBe(502);
		expect(await errorOf(res)).toBe("the dashboard answered with a redirect");
		expect(res.headers.get("location")).toBeNull();
		expect(upstream.seen).toHaveLength(1);
		for (const status of [301, 303, 307, 308]) {
			upstream.answer = () => new Response(null, { status, headers: { location: `${upstream.origin}/x` } });
			expect((await relay("/", device())).status).toBe(502);
		}
	});

	test("cookies and credentials are not forwarded, and Set-Cookie is not returned", async () => {
		upstream.answer = () =>
			new Response("ok", { headers: { "content-type": "text/plain", "set-cookie": "omp_cloud_session=stolen; Path=/", "x-secret": "1", "x-powered-by": "x", "content-length": "2" } });
		const token = device();
		const res = await relay("/", token, {
			headers: {
				cookie: "omp_cloud_session=abc",
				origin: "http://evil.example",
				referer: "http://evil.example/",
				"x-forwarded-for": "6.6.6.6",
				"x-custom": "1",
				accept: "text/html",
				"if-modified-since": "Tue, 20 Oct 2026 00:00:00 GMT",
				"if-none-match": '"e"',
			},
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(res.headers.get("x-secret")).toBeNull();
		expect(res.headers.get("x-powered-by")).toBeNull();
		const seen = upstream.seen[0]?.headers;
		expect(seen?.get("cookie")).toBeNull();
		expect(seen?.get("authorization")).toBeNull();
		expect(seen?.get("origin")).toBeNull();
		expect(seen?.get("referer")).toBeNull();
		expect(seen?.get("x-forwarded-for")).toBeNull();
		expect(seen?.get("x-custom")).toBeNull();
		expect(seen?.get("accept")).toBe("text/html");
		expect(seen?.get("if-modified-since")).toBe("Tue, 20 Oct 2026 00:00:00 GMT");
		expect(seen?.get("if-none-match")).toBe('"e"');
	});

	test("an upstream that is down is a 502", async () => {
		await upstream.server.stop(true);
		const res = await relay("/", device());
		expect(res.status).toBe(502);
		expect(await errorOf(res)).toBe("the dashboard is not reachable");
		upstream = await startUpstream();
	});

	test("without a dashboard section it is 404", async () => {
		app = await buildApp(false);
		const res = await relay("/", device());
		expect(res.status).toBe(404);
		expect(await errorOf(res)).toBe("the dashboard is not configured");
	});

	test("it needs a token", async () => {
		const res = await app.fetchRemote(new Request(`http://omp.test${PREFIX}/`), from("10.0.0.5"));
		expect(res.status).toBe(401);
		expect(upstream.seen).toEqual([]);
	});

	test("revoking the device ends a relay request that is waiting on the upstream", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		upstream.answer = async () => {
			await gate;
			return new Response("late");
		};
		const paired = pairDevice(store);
		const waiting = relay("/", paired.token);
		// A macrotask turn per check: the upstream request needs I/O, which a microtask loop would starve.
		while (upstream.seen.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
		const revoked = await app.fetch(new Request(`http://omp.test/api/v1/devices/${paired.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } }));
		expect(revoked.status).toBe(200);
		const res = await waiting;
		expect(res.status).toBe(401);
		release();
	});
});

describe("the real dashboard page", () => {
	test("its root and its bundled assets are what the relay's allow-list expects", async () => {
		await upstream.server.stop(true);
		const page = serveDashboard({ hostname: "127.0.0.1", port: 0 }, { fetch: async () => new Response("not found", { status: 404 }) });
		try {
			app = await buildApp(true, `http://127.0.0.1:${page.port}`);
			const token = device();
			const root = await relay("/", token);
			expect(root.status).toBe(200);
			expect(root.headers.get("content-type")).toStartWith("text/html");
			const html = await root.text();
			expect(html).toContain('<div id="app">');
			const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(match => match[1] ?? "");
			expect(assets.length).toBeGreaterThanOrEqual(2);
			for (const asset of assets) {
				expect(asset).toMatch(/^\/chunk-[a-z0-9]+\.(?:js|css)$/);
				const res = await relay(asset, token);
				expect(res.status).toBe(200);
				expect(res.headers.get("content-type")).toMatch(/javascript|css/);
				expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
			}
		} finally {
			await page.stop(true);
			upstream = await startUpstream();
		}
	});
});
