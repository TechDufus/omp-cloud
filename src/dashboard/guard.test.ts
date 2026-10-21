import { describe, expect, test } from "bun:test";
import { isRecord } from "../guards";
import { OWNER_CALLER } from "../server/auth";
import { checkRequest, DASHBOARD_HEADER, guardPolicy, sessionCaller } from "./guard";
import { DashboardSessions, SESSION_COOKIE } from "./session";

const PORT = 8081;
const policy = guardPolicy(PORT);

/** A request to the dashboard listener as its own page would send it; `headers` override or (with `null`) drop. */
function request(method: string, headers: Record<string, string | null> = {}): Request {
	const merged: Record<string, string | null> = { host: `127.0.0.1:${PORT}`, ...headers };
	const init = new Headers();
	for (const [name, value] of Object.entries(merged)) if (value !== null) init.set(name, value);
	return new Request(`http://127.0.0.1:${PORT}/api/v1/threads`, { method, headers: init });
}

async function refusal(req: Request, p = policy): Promise<{ status: number; error: string } | null> {
	const response = checkRequest(req, p);
	if (response === null) return null;
	const body: unknown = await response.json();
	if (!isRecord(body) || typeof body.error !== "string") throw new Error("a refusal is {error}");
	return { status: response.status, error: body.error };
}

describe("checkRequest", () => {
	test("a same-origin GET passes", async () => {
		expect(await refusal(request("GET"))).toBeNull();
		expect(await refusal(request("GET", { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${PORT}` }))).toBeNull();
	});

	test("a typed URL (Sec-Fetch-Site: none) and a client without fetch metadata pass", async () => {
		expect(await refusal(request("GET", { "sec-fetch-site": "none" }))).toBeNull();
		expect(await refusal(request("HEAD"))).toBeNull();
	});

	test.each(["127.0.0.1", "localhost", "[::1]"])("loopback host %s with the listen port is accepted", async host => {
		expect(await refusal(request("GET", { host: `${host}:${PORT}` }))).toBeNull();
		expect(await refusal(request("GET", { host: `${host.toUpperCase()}:${PORT}` }))).toBeNull();
	});

	test.each([null, "evil.example", "evil.example:8081", "127.0.0.1", "127.0.0.1:8080", "localhost.evil.example:8081"])(
		"host %p is refused with 421 (DNS rebinding)",
		async host => {
			expect(await refusal(request("GET", { host }))).toEqual({ status: 421, error: "unexpected host" });
		},
	);

	test.each(["cross-site", "same-site", "bogus"])("Sec-Fetch-Site %s is refused", async site => {
		expect(await refusal(request("GET", { "sec-fetch-site": site }))).toEqual({ status: 403, error: "cross-site request refused" });
	});

	test.each(["http://evil.example", "http://127.0.0.1:8080", "https://127.0.0.1:8081", "null", "not a url"])(
		"foreign Origin %s is refused",
		async origin => {
			expect(await refusal(request("GET", { origin }))).toEqual({ status: 403, error: "cross-site request refused" });
		},
	);

	test("an Origin of another allowed spelling does not match a different Host", async () => {
		const mismatch = request("GET", { host: `localhost:${PORT}`, origin: `http://127.0.0.1:${PORT}` });
		expect(await refusal(mismatch)).toEqual({ status: 403, error: "cross-site request refused" });
		expect(await refusal(request("GET", { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }))).toBeNull();
	});

	test.each(["POST", "PUT", "PATCH", "DELETE"])("%s needs X-Omp-Dashboard: 1", async method => {
		expect(await refusal(request(method))).toEqual({ status: 403, error: `${DASHBOARD_HEADER} header required` });
		expect(await refusal(request(method, { [DASHBOARD_HEADER]: "0" }))).toEqual({ status: 403, error: `${DASHBOARD_HEADER} header required` });
		expect(await refusal(request(method, { [DASHBOARD_HEADER]: "1" }))).toBeNull();
	});

	test("the custom header does not excuse a cross-site request", async () => {
		const req = request("POST", { [DASHBOARD_HEADER]: "1", "sec-fetch-site": "cross-site" });
		expect(await refusal(req)).toEqual({ status: 403, error: "cross-site request refused" });
	});

	test("the host check runs first", async () => {
		const req = request("POST", { host: "evil.example", "sec-fetch-site": "cross-site", origin: "http://evil.example" });
		expect((await refusal(req))?.status).toBe(421);
	});

	test("a configured url adds its host and origin", async () => {
		const withUrl = guardPolicy(PORT, "https://omp.lan");
		expect(await refusal(request("GET", { host: "omp.lan", origin: "https://omp.lan" }), withUrl)).toBeNull();
		expect(await refusal(request("GET", { host: "omp.lan", origin: "http://omp.lan" }), withUrl)).not.toBeNull();
		expect(await refusal(request("GET", { host: "omp.lan" }))).toEqual({ status: 421, error: "unexpected host" });
		expect(await refusal(request("GET"), withUrl)).toBeNull();
	});

	test("no CORS header is ever set on a refusal", () => {
		const response = checkRequest(request("POST", { origin: "http://evil.example" }), policy);
		expect(response).not.toBeNull();
		for (const [name] of response?.headers ?? []) expect(name.toLowerCase()).not.toStartWith("access-control-");
	});
});

describe("sessionCaller", () => {
	test("a live session cookie is the owner's caller; no cookie, an unknown or a closed one is nobody", () => {
		const sessions = new DashboardSessions();
		const id = sessions.openSession();
		const withCookie = (value: string): Request => request("GET", { cookie: `${SESSION_COOKIE}=${value}` });

		expect(sessionCaller(withCookie(id), sessions)).toBe(OWNER_CALLER);
		expect(sessionCaller(request("GET"), sessions)).toBeNull();
		expect(sessionCaller(withCookie("unknown"), sessions)).toBeNull();
		sessions.closeSession(id);
		expect(sessionCaller(withCookie(id), sessions)).toBeNull();
	});

	test("the bearer token is not a credential here", () => {
		const sessions = new DashboardSessions();
		expect(sessionCaller(request("GET", { authorization: "Bearer tok" }), sessions)).toBeNull();
	});
});
