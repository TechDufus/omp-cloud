import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { parsePairingCode } from "../pairing/code";
import { loadIdentity } from "../pairing/identity";
import { RemoteAccess, type RemoteSettings } from "../pairing/remote";
import { generateIdentity } from "../pairing/test-support";
import { Settings } from "../settings";
import { Store } from "../store";
import type { NewThread, QuestionInput } from "../store/types";
import type { ApiServer } from "./api-server";
import { type App, createApp } from "./app";
import { tokenSha256 } from "./auth";
import { serveRemote } from "./remote";
import { FULL_ACCESS_MESSAGE } from "./scopes";

const TOKEN = "s3cret-token";
const ORIGIN = "http://omp.test";
const FINGERPRINT_CODE = "A".repeat(43);
const FINGERPRINT = `SHA256:${FINGERPRINT_CODE}`;
const GATEWAY_HOST = "10.9.9.9";
const T0 = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const THREAD = "aaaaaaaaaaaa";
const INVALID_CODE = "invalid or expired pairing code";
const INVALID_REQUEST = "invalid or expired pairing request";

const gateway = { served: ["anthropic"], providers: () => gateway.served, refresh: async (): Promise<void> => undefined };

let dir: string;
let store: Store;
let app: App;
let clock: number;

function remoteSettings(): RemoteSettings {
	return {
		listen: { hostname: "0.0.0.0", port: 8443 },
		advertise: ["10.0.0.42:8443"],
		fingerprint: FINGERPRINT,
		fingerprintCode: FINGERPRINT_CODE,
		access: new RemoteAccess(["10.0.0.0/8", "127.0.0.0/8"], [GATEWAY_HOST]),
	};
}

async function buildApp(remote: RemoteSettings | undefined): Promise<App> {
	return createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: { default: "fake/fake-model", direct: ["fake"], gateway },
		ompVersion: "18.12.3",
		logins: new LoginManager({
			brokerUrl: "http://127.0.0.1:1",
			brokerTokenFile: "/nonexistent/auth-broker.token",
			flow: { has: () => false, run: () => Promise.reject(new Error("no provider")) },
		}),
		settings: Settings.load(store),
		git: await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 10, pushTimeoutSeconds: 10 }),
		remote,
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-pairing-"));
	clock = T0;
	store = Store.open({ dataDir: dir, now: () => new Date(clock) });
	app = await buildApp(remoteSettings());
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

/** A server handle that says the request came from `address`. */
function from(address: string): ApiServer {
	return { requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 40000 }), timeout: () => {} };
}

interface CallOptions {
	token?: string;
	body?: unknown;
	headers?: Record<string, string>;
}

function request(method: string, path: string, options: CallOptions = {}): Request {
	const headers = new Headers(options.headers);
	if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);
	const body = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
	return new Request(ORIGIN + path, { method, headers, body });
}

/** The loopback listener, with the owner token unless `token` says otherwise. */
function loopback(method: string, path: string, options: CallOptions = {}): Promise<Response> {
	return app.fetch(request(method, path, { token: TOKEN, ...options }));
}

/** The remote listener, the request coming from `address`. */
function remote(method: string, path: string, options: CallOptions = {}, address = "10.0.0.5"): Promise<Response> {
	return app.fetchRemote(request(method, path, options), from(address));
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
	const body: unknown = await res.json();
	if (!isRecord(body)) throw new Error("expected an object");
	return body;
}

function str(value: unknown): string {
	if (typeof value !== "string") throw new Error(`expected a string, got ${JSON.stringify(value)}`);
	return value;
}

/** A new offer minted through the API: its id and the secret out of its code. */
async function newOffer(): Promise<{ id: string; secret: string; code: string }> {
	const res = await loopback("POST", "/api/v1/pairing/offers", { body: {} });
	expect(res.status).toBe(201);
	const body = await bodyOf(res);
	const code = parsePairingCode(str(body.code));
	if (code === null) throw new Error("the offer's code does not parse");
	return { id: str(body.id), secret: code.secret, code: str(body.code) };
}

function redeemBody(offer: { id: string; secret: string }, over: Record<string, unknown> = {}): Record<string, unknown> {
	return { offer: offer.id, secret: offer.secret, name: "laptop", platform: "linux", ...over };
}

interface PairedViaApi {
	id: string;
	name: string;
	token: string;
	offerId: string;
}

/** The whole flow through the API: offer, redeem, approve (with `access`, else with no body like an old client), claim. */
async function pair(name = "laptop", address = "10.0.0.5", access?: "full" | "threads"): Promise<PairedViaApi> {
	const offer = await newOffer();
	const redeemed = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name }) }, address);
	expect(redeemed.status).toBe(202);
	const requested = await bodyOf(redeemed);
	expect((await loopback("POST", `/api/v1/pairing/offers/${offer.id}/approve`, access === undefined ? {} : { body: { access } })).status).toBe(204);
	const claimed = await remote("POST", "/api/v1/pairing/claim", { body: { request: requested.request, requestSecret: requested.requestSecret } }, address);
	expect(claimed.status).toBe(201);
	const body = await bodyOf(claimed);
	const device = body.device;
	if (!isRecord(device)) throw new Error("no device");
	return { id: str(device.id), name: str(device.name), token: str(body.token), offerId: offer.id };
}

function newThread(over: Partial<NewThread> = {}): NewThread {
	return {
		owner: "owner",
		title: "fix the bug",
		prompt: "please fix the bug",
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
		...over,
	};
}

function seedRunning(id: string, over: Partial<NewThread> = {}): void {
	store.createThread(id, newThread(over));
	store.startNextTurn(id);
}

function ask(): QuestionInput {
	return {
		key: "db",
		text: "Which database?",
		header: "DB",
		options: [
			{ label: "sqlite", description: "embedded" },
			{ label: "postgres", description: "" },
		],
		multi: false,
		recommended: null,
		ompKey: "omp-key-db",
		ompLabels: ["omp-label-sqlite", "omp-label-postgres"],
	};
}

describe("the remote entry point", () => {
	test("the owner token is refused there with the ordinary 401", async () => {
		const res = await remote("GET", "/api/v1/whoami", { token: TOKEN });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe('Bearer realm="omp-cloud"');
		expect(await bodyOf(res)).toEqual({ error: "unauthorized" });
	});

	test("a device token works there and whoami names the device and the fingerprint", async () => {
		const device = await pair();
		const res = await remote("GET", "/api/v1/whoami", { token: device.token });
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		expect(body.device).toEqual({ id: device.id, name: "laptop", access: "threads" });
		expect(body.remote).toEqual({ fingerprint: FINGERPRINT });
		expect(body.user).toBe("owner");
	});

	test("no token and an unknown device token are 401", async () => {
		expect((await remote("GET", "/api/v1/whoami")).status).toBe(401);
		expect((await remote("GET", "/api/v1/whoami", { token: "ompd_unknown" })).status).toBe(401);
	});

	test("a source outside allow is 403 before anything is routed, the pairing routes included", async () => {
		const device = await pair();
		for (const address of ["8.8.8.8", "127.0.0.1x", "2001:db8::1", "192.168.0.1"]) {
			const res = await remote("GET", "/api/v1/whoami", { token: device.token }, address);
			expect(res.status).toBe(403);
			expect(await bodyOf(res)).toEqual({ error: "forbidden" });
		}
		const offer = await newOffer();
		const redeem = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }, "8.8.8.8");
		expect(redeem.status).toBe(403);
		expect(store.offer(offer.id)?.status).toBe("open");
		expect((await remote("POST", "/api/v1/nope", {}, "8.8.8.8")).status).toBe(403);
	});

	test("the gateway host is refused even though allow lists its range, mapped spelling included", async () => {
		const device = await pair();
		for (const address of [GATEWAY_HOST, `::ffff:${GATEWAY_HOST}`]) {
			expect((await remote("GET", "/api/v1/whoami", { token: device.token }, address)).status).toBe(403);
		}
		expect((await remote("GET", "/api/v1/whoami", { token: device.token }, "10.9.9.8")).status).toBe(200);
		expect((await remote("GET", "/api/v1/whoami", { token: device.token }, "::ffff:10.0.0.5")).status).toBe(200);
	});

	test("a request whose source cannot be determined is refused", async () => {
		const res = await app.fetchRemote(request("GET", "/api/v1/whoami", { token: "ompd_x" }));
		expect(res.status).toBe(403);
	});

	test("without a remote section the remote entry point refuses everything", async () => {
		app = await buildApp(undefined);
		expect((await remote("GET", "/api/v1/whoami", { token: TOKEN })).status).toBe(403);
	});

	test("the loopback entry point takes the owner token and a device token", async () => {
		const device = await pair();
		expect((await loopback("GET", "/api/v1/whoami")).status).toBe(200);
		const res = await loopback("GET", "/api/v1/whoami", { token: device.token });
		expect(res.status).toBe(200);
		expect((await bodyOf(res)).device).toEqual({ id: device.id, name: "laptop", access: "threads" });
		expect((await bodyOf(await loopback("GET", "/api/v1/whoami"))).device).toBeNull();
	});

	test("every response carries the common headers", async () => {
		const res = await remote("GET", "/api/v1/whoami", {}, "8.8.8.8");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe("offers", () => {
	test("create answers the code, the ttl, the fingerprint and the advertised addresses, once", async () => {
		const res = await loopback("POST", "/api/v1/pairing/offers", { body: {} });
		expect(res.status).toBe(201);
		const body = await bodyOf(res);
		expect(Object.keys(body).sort()).toEqual(["addresses", "code", "expiresAt", "fingerprint", "id"]);
		expect(body.expiresAt).toBe(new Date(T0 + 5 * MINUTE).toISOString());
		expect(body.fingerprint).toBe(FINGERPRINT);
		expect(body.addresses).toEqual(["10.0.0.42:8443"]);
		const code = parsePairingCode(str(body.code));
		expect(code).toMatchObject({ offerId: body.id, fingerprint: FINGERPRINT_CODE, addresses: ["10.0.0.42:8443"] });
		expect(code?.secret).toHaveLength(22);
		expect(String(body.id)).toHaveLength(12);
		const view = JSON.stringify(await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${body.id}`)));
		expect(view).not.toContain(str(code?.secret));
		expect(view).not.toContain("ompc1");
	});

	test("an empty body works too; a body that is not an object does not", async () => {
		expect((await loopback("POST", "/api/v1/pairing/offers")).status).toBe(201);
		expect((await loopback("POST", "/api/v1/pairing/offers", { body: "[]" })).status).toBe(400);
		expect((await loopback("POST", "/api/v1/pairing/offers", { body: "x".repeat(500) })).status).toBe(400);
		expect((await loopback("POST", "/api/v1/pairing/offers", { body: "x".repeat(2000) })).status).toBe(413);
	});

	test("without a remote section there is nothing to offer", async () => {
		app = await buildApp(undefined);
		const res = await loopback("POST", "/api/v1/pairing/offers", { body: {} });
		expect(res.status).toBe(404);
		expect(await bodyOf(res)).toEqual({ error: "remote access is not configured" });
	});

	test("the store keeps only the secret's SHA-256", async () => {
		const offer = await newOffer();
		store.close();
		const raw = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		const row = raw.query<{ secret_sha256: string }, [string]>("SELECT secret_sha256 FROM pairing_offers WHERE id = ?").get(offer.id);
		raw.close();
		expect(row?.secret_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.secret_sha256).not.toContain(offer.secret);
		store = Store.open({ dataDir: dir, now: () => new Date(clock) });
	});

	test("a fourth offer cancels the oldest", async () => {
		const offers = [await newOffer(), await newOffer(), await newOffer()];
		clock += 1000;
		offers.push(await newOffer());
		const statuses: unknown[] = [];
		for (const offer of offers) statuses.push((await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`))).status);
		expect(statuses).toEqual(["cancelled", "open", "open", "open"]);
	});

	test("get shows the request and the device, and expired is computed", async () => {
		const offer = await newOffer();
		let view = await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`));
		expect(view).toEqual({ id: offer.id, status: "open", expiresAt: new Date(T0 + 5 * MINUTE).toISOString(), request: null, device: null });
		clock += 1000;
		await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name: "Ada Mac", platform: "darwin" }) }, "10.0.0.77");
		view = await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`));
		expect(view.status).toBe("pending");
		expect(view.request).toEqual({ name: "Ada Mac", platform: "darwin", address: "10.0.0.77", at: new Date(T0 + 1000).toISOString() });
		clock += 5 * MINUTE;
		expect((await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`))).status).toBe("expired");
	});

	test("approve and decline need a pending offer, 409 otherwise, and approve needs it unexpired", async () => {
		const offer = await newOffer();
		for (const action of ["approve", "decline"]) {
			const res = await loopback("POST", `/api/v1/pairing/offers/${offer.id}/${action}`);
			expect(res.status).toBe(409);
			expect(await bodyOf(res)).toEqual({ error: "this pairing is not waiting for approval" });
		}
		await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) });
		clock += 6 * MINUTE;
		expect((await loopback("POST", `/api/v1/pairing/offers/${offer.id}/approve`)).status).toBe(409);
		expect((await loopback("POST", "/api/v1/pairing/offers/nope/approve")).status).toBe(404);
		expect((await loopback("POST", "/api/v1/pairing/offers/nope/decline")).status).toBe(404);
	});

	test("delete cancels, and again and on a finished offer changes nothing", async () => {
		const offer = await newOffer();
		expect((await loopback("DELETE", `/api/v1/pairing/offers/${offer.id}`)).status).toBe(204);
		expect((await loopback("DELETE", `/api/v1/pairing/offers/${offer.id}`)).status).toBe(204);
		expect((await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`))).status).toBe("cancelled");
		expect((await loopback("DELETE", "/api/v1/pairing/offers/unknown")).status).toBe(404);
		expect((await loopback("GET", "/api/v1/pairing/offers/unknown")).status).toBe(404);
		const device = await pair("done");
		expect((await loopback("DELETE", `/api/v1/pairing/offers/${device.offerId}`)).status).toBe(204);
		expect((await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${device.offerId}`))).status).toBe("paired");
	});

	test("the offer routes need the owner token and answer 404 for other paths and methods", async () => {
		expect((await remote("POST", "/api/v1/pairing/offers", {})).status).toBe(401);
		expect((await loopback("GET", "/api/v1/pairing/offers")).status).toBe(404);
		expect((await loopback("PUT", "/api/v1/pairing/offers/x")).status).toBe(404);
		expect((await loopback("POST", "/api/v1/pairing/offers/x/other")).status).toBe(404);
		expect((await loopback("GET", "/api/v1/pairing/redeem")).status).toBe(404);
		expect((await app.fetch(request("GET", "/api/v1/pairing/redeem"))).status).toBe(401);
	});
});

describe("redeem", () => {
	test("the right secret is 202 with a request id, its secret and the expiry; the offer is pending", async () => {
		const offer = await newOffer();
		const res = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name: "  work laptop  " }) });
		expect(res.status).toBe(202);
		const body = await bodyOf(res);
		expect(Object.keys(body).sort()).toEqual(["expiresAt", "request", "requestSecret"]);
		expect(String(body.request)).toHaveLength(12);
		expect(String(body.requestSecret)).toHaveLength(22);
		expect(body.expiresAt).toBe(new Date(T0 + 5 * MINUTE).toISOString());
		expect((await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`))).request).toMatchObject({ name: "work laptop" });
	});

	test("redeem works on the loopback listener too, with no token", async () => {
		const offer = await newOffer();
		expect((await app.fetch(request("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }))).status).toBe(202);
	});

	test("five wrong secrets burn the offer, and then the right secret gets the same 401", async () => {
		const offer = await newOffer();
		const wrong = redeemBody(offer, { secret: "wrong-secret" });
		let first = "";
		for (let i = 0; i < 5; i++) {
			const res = await remote("POST", "/api/v1/pairing/redeem", { body: wrong }, `10.0.1.${i}`);
			expect(res.status).toBe(401);
			first = first || JSON.stringify(await bodyOf(res));
		}
		expect(first).toBe(JSON.stringify({ error: INVALID_CODE }));
		const right = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }, "10.0.2.1");
		expect(right.status).toBe(401);
		expect(await bodyOf(right)).toEqual({ error: INVALID_CODE });
		expect((await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`))).status).toBe("burned");
	});

	test("four wrong secrets leave the offer open for the right one", async () => {
		const offer = await newOffer();
		for (let i = 0; i < 4; i++) await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { secret: "wrong" }) }, `10.0.1.${i}`);
		expect((await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }, "10.0.2.1")).status).toBe(202);
	});

	test("wrong secrets on an offer that is not open change nothing", async () => {
		const offer = await newOffer();
		await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) });
		for (let i = 0; i < 6; i++) {
			expect((await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { secret: "wrong" }) }, `10.0.1.${i}`)).status).toBe(401);
		}
		expect((await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`))).status).toBe("pending");
	});

	test("an expired offer, an unknown one and a cancelled one are the same 401", async () => {
		const expired = await newOffer();
		clock += 6 * MINUTE;
		const cancelled = await newOffer();
		await loopback("DELETE", `/api/v1/pairing/offers/${cancelled.id}`);
		const bodies: unknown[] = [];
		for (const body of [redeemBody(expired), redeemBody({ id: "unknownoffer", secret: expired.secret }), redeemBody(cancelled)]) {
			const res = await remote("POST", "/api/v1/pairing/redeem", { body }, "10.0.3.1");
			expect(res.status).toBe(401);
			bodies.push(await bodyOf(res));
		}
		expect(bodies).toEqual([{ error: INVALID_CODE }, { error: INVALID_CODE }, { error: INVALID_CODE }]);
	});

	test("two parallel redemptions of one offer have one winner", async () => {
		const offer = await newOffer();
		const results = await Promise.all([
			remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name: "one" }) }, "10.0.4.1"),
			remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name: "two" }) }, "10.0.4.2"),
		]);
		expect(results.map(r => r.status).sort()).toEqual([202, 401]);
	});

	test("ten failures from one source are 429 for it, even with the right secret, while another source still succeeds", async () => {
		const offer = await newOffer();
		for (let i = 0; i < 10; i++) {
			const res = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody({ id: `unknown${i}`, secret: "x" }) }, "10.0.5.1");
			expect(res.status).toBe(401);
		}
		const blocked = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }, "10.0.5.1");
		expect(blocked.status).toBe(429);
		expect(await bodyOf(blocked)).toEqual({ error: "too many attempts; try again later" });
		expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect((await remote("POST", "/api/v1/pairing/claim", { body: { request: "x", requestSecret: "y" } }, "10.0.5.1")).status).toBe(429);
		expect((await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }, "10.0.5.2")).status).toBe(202);
	});

	test("failures of the sources inside one IPv6 /64 add up", async () => {
		app = await buildApp({ ...remoteSettings(), access: new RemoteAccess(["fd00::/8"], []) });
		const offer = await newOffer();
		for (let i = 0; i < 10; i++) await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody({ id: "nope", secret: "x" }) }, `fd00:1:2:3::${i + 1}`);
		expect((await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }, "fd00:1:2:3::ff")).status).toBe(429);
		expect((await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }, "fd00:1:2:4::1")).status).toBe(202);
	});

	test("a malformed request is not a failure and never reaches the limiter", async () => {
		const offer = await newOffer();
		for (let i = 0; i < 15; i++) {
			expect((await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name: "" }) }, "10.0.6.1")).status).toBe(400);
		}
		expect((await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }, "10.0.6.1")).status).toBe(202);
	});

	test("a body over 2 KiB is 413, and with a declared length nothing is read", async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulled++;
					controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
				},
			},
			{ highWaterMark: 0 },
		);
		const declared = new Request(`${ORIGIN}/api/v1/pairing/redeem`, { method: "POST", headers: { "content-length": "5000" }, body: stream, duplex: "half" });
		const res = await app.fetchRemote(declared, from("10.0.7.1"));
		expect(res.status).toBe(413);
		expect(await bodyOf(res)).toEqual({ error: "request body is too large" });
		expect(pulled).toBe(0);
	});

	test("without a declared length at most 2 KiB are read before the 413", async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulled++;
					controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
				},
			},
			{ highWaterMark: 0 },
		);
		const res = await app.fetchRemote(new Request(`${ORIGIN}/api/v1/pairing/redeem`, { method: "POST", body: stream, duplex: "half" }), from("10.0.7.2"));
		expect(res.status).toBe(413);
		expect(pulled).toBeLessThanOrEqual(4);
		const exact = await remote("POST", "/api/v1/pairing/redeem", { body: JSON.stringify({ pad: "x".repeat(2048 - 10) }) }, "10.0.7.3");
		expect(exact.status).toBe(400);
	});

	test("an invalid device name is 400", async () => {
		const offer = await newOffer();
		for (const name of ["", "   ", "x".repeat(65), "<script>", "a/b", "line\nbreak", "tab\there", "emoji 😀"]) {
			const res = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name }) });
			expect(res.status).toBe(400);
			expect(await bodyOf(res)).toEqual({ error: "invalid device name" });
		}
		for (const name of ["x".repeat(64), "Ünïcödé ñame", "a.b_c-d e", "日本語 3"]) {
			const res = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name }) }, "10.0.8.1");
			expect(res.status === 202 || res.status === 401).toBe(true);
			expect(await bodyOf(res)).not.toEqual({ error: "invalid device name" });
		}
	});

	test("malformed JSON, missing or mistyped fields and a bad platform are 400", async () => {
		const offer = await newOffer();
		const cases: unknown[] = [
			"not json",
			"[]",
			{},
			{ ...redeemBody(offer), offer: 7 },
			{ ...redeemBody(offer), secret: undefined },
			{ ...redeemBody(offer), name: null },
			{ ...redeemBody(offer), platform: "x".repeat(33) },
			{ ...redeemBody(offer), platform: "lin ux" },
			{ ...redeemBody(offer), platform: "" },
		];
		for (const body of cases) expect((await remote("POST", "/api/v1/pairing/redeem", { body })).status).toBe(400);
		expect((await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`))).status).toBe("open");
	});
});

describe("claim", () => {
	async function pendingRequest(name = "laptop"): Promise<{ offer: { id: string }; claim: Record<string, unknown> }> {
		const offer = await newOffer();
		const res = await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name }) });
		expect(res.status).toBe(202);
		const body = await bodyOf(res);
		return { offer, claim: { request: body.request, requestSecret: body.requestSecret } };
	}
	const claim = (body: unknown, address = "10.0.5.5"): Promise<Response> => remote("POST", "/api/v1/pairing/claim", { body }, address);

	test("is 202 pending until the owner approves", async () => {
		const { claim: body } = await pendingRequest();
		const res = await claim(body);
		expect(res.status).toBe(202);
		expect(await bodyOf(res)).toEqual({ status: "pending" });
	});

	test("after approval it is 201 once with a device token, and a second claim is 401", async () => {
		const { offer, claim: body } = await pendingRequest();
		await loopback("POST", `/api/v1/pairing/offers/${offer.id}/approve`);
		const res = await claim(body);
		expect(res.status).toBe(201);
		const created = await bodyOf(res);
		expect(Object.keys(created).sort()).toEqual(["device", "token"]);
		expect(str(created.token)).toMatch(/^ompd_[A-Za-z0-9_-]{43}$/);
		expect(created.device).toMatchObject({ name: "laptop" });
		const again = await claim(body);
		expect(again.status).toBe(401);
		expect(await bodyOf(again)).toEqual({ error: INVALID_REQUEST });
		expect(await bodyOf(await loopback("GET", `/api/v1/pairing/offers/${offer.id}`))).toMatchObject({ status: "paired", device: created.device });
		expect((await remote("GET", "/api/v1/whoami", { token: str(created.token) })).status).toBe(200);
	});

	test("no token is stored: the database holds only its SHA-256", async () => {
		const device = await pair("hashed");
		store.close();
		const raw = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		const row = raw.query<{ token_sha256: string }, [string]>("SELECT token_sha256 FROM devices WHERE id = ?").get(device.id);
		raw.close();
		expect(row?.token_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(device.token).toStartWith("ompd_");
		store = Store.open({ dataDir: dir, now: () => new Date(clock) });
	});

	test("a declined request is 403, every time", async () => {
		const { offer, claim: body } = await pendingRequest();
		expect((await loopback("POST", `/api/v1/pairing/offers/${offer.id}/decline`)).status).toBe(204);
		for (let i = 0; i < 2; i++) {
			const res = await claim(body);
			expect(res.status).toBe(403);
			expect(await bodyOf(res)).toEqual({ error: "the owner declined this device" });
		}
	});

	test("a name that is taken gets -2", async () => {
		const first = await pair("laptop");
		const second = await pair("laptop");
		expect([first.name, second.name]).toEqual(["laptop", "laptop-2"]);
	});

	test("an unknown request, a wrong secret, a cancelled and an expired offer are the same 401", async () => {
		const cancelled = await pendingRequest();
		await loopback("POST", `/api/v1/pairing/offers/${cancelled.offer.id}/approve`);
		await loopback("DELETE", `/api/v1/pairing/offers/${cancelled.offer.id}`);
		const expired = await pendingRequest();
		await loopback("POST", `/api/v1/pairing/offers/${expired.offer.id}/approve`);
		const live = await pendingRequest();
		await loopback("POST", `/api/v1/pairing/offers/${live.offer.id}/approve`);
		const cases: unknown[] = [
			{ request: "unknown", requestSecret: "x" },
			{ ...live.claim, requestSecret: "wrong" },
			cancelled.claim,
		];
		for (const body of cases) {
			const res = await claim(body, "10.0.9.1");
			expect(res.status).toBe(401);
			expect(await bodyOf(res)).toEqual({ error: INVALID_REQUEST });
		}
		clock += 6 * MINUTE;
		expect((await claim(expired.claim, "10.0.9.2")).status).toBe(401);
		expect((await claim(live.claim, "10.0.9.2")).status).toBe(401);
	});

	test("ten wrong claims from one source block that source", async () => {
		const { claim: body } = await pendingRequest();
		for (let i = 0; i < 10; i++) expect((await claim({ ...body, requestSecret: `wrong${i}` }, "10.0.9.9")).status).toBe(401);
		expect((await claim(body, "10.0.9.9")).status).toBe(429);
		expect((await claim(body, "10.0.9.8")).status).toBe(202);
	});

	test("the body is capped at 2 KiB and must be two strings", async () => {
		expect((await remote("POST", "/api/v1/pairing/claim", { body: "x".repeat(3000), headers: { "content-length": "3000" } })).status).toBe(413);
		expect((await claim({ request: 7, requestSecret: "x" })).status).toBe(400);
		expect((await claim({})).status).toBe(400);
		expect((await claim("nope")).status).toBe(400);
	});

	test("two parallel claims of an approved request create one device", async () => {
		const { offer, claim: body } = await pendingRequest();
		await loopback("POST", `/api/v1/pairing/offers/${offer.id}/approve`);
		const results = await Promise.all([claim(body, "10.0.9.3"), claim(body, "10.0.9.4")]);
		expect(results.map(r => r.status).sort()).toEqual([201, 401]);
		expect(store.devices("owner")).toHaveLength(1);
	});
});

describe("scopes", () => {
	test("a threads-only device on every route that needs full access is 403 with the contract body, on both entry points", async () => {
		const device = await pair("laptop");
		const other = await pair("other");
		const routes: [string, string][] = [
			["POST", "/api/v1/pairing/offers"],
			["GET", "/api/v1/pairing/offers/abc"],
			["DELETE", "/api/v1/pairing/offers/abc"],
			["POST", "/api/v1/pairing/offers/abc/approve"],
			["POST", "/api/v1/pairing/offers/abc/decline"],
			["DELETE", `/api/v1/devices/${other.id}`],
			["DELETE", "/api/v1/devices/unknown"],
			["PATCH", `/api/v1/devices/${device.id}`],
			["PATCH", `/api/v1/devices/${other.id}`],
			["PUT", "/api/v1/settings"],
			["PUT", "/api/v1/settings/import"],
			["GET", "/api/v1/logins/abc"],
			["POST", "/api/v1/logins/anthropic"],
			["POST", "/api/v1/logins/abc/input"],
			["DELETE", "/api/v1/logins/abc"],
			["POST", "/api/v1/update/check"],
			["POST", "/api/v1/update/apply"],
			["POST", "/api/v1/dashboard/links"],
		];
		for (const [method, path] of routes) {
			for (const res of [await remote(method, path, { token: device.token }), await loopback(method, path, { token: device.token })]) {
				expect([method, path, res.status]).toEqual([method, path, 403]);
				expect(await bodyOf(res)).toEqual({ error: FULL_ACCESS_MESSAGE });
			}
		}
		expect(FULL_ACCESS_MESSAGE).toBe(
			"this device has threads-only access; a connection with full access can change that (Devices in the dashboard, or /cloud devices access <device> full)",
		);
		expect(store.device(other.id)).not.toBeNull();
		expect(store.device(device.id)?.access).toBe("threads");
		expect(store.settingRows()).toEqual([]);
	});

	test("a threads-only device may list the logins, and a full device or the owner is not refused on any of those routes", async () => {
		const threads = await pair("threads");
		expect((await remote("GET", "/api/v1/logins", { token: threads.token })).status).not.toBe(403);
		const full = await pair("full", "10.0.0.6", "full");
		const routes = [
			["POST", "/api/v1/pairing/offers"],
			["GET", "/api/v1/pairing/offers/abc"],
			["PATCH", `/api/v1/devices/${threads.id}`],
			["PUT", "/api/v1/settings"],
			["GET", "/api/v1/logins"],
			["GET", "/api/v1/logins/abc"],
			["POST", "/api/v1/update/check"],
			["POST", "/api/v1/dashboard/links"],
		] as const;
		for (const [method, path] of routes) {
			expect([method, path, (await loopback(method, path)).status === 403]).toEqual([method, path, false]);
			expect([method, path, (await remote(method, path, { token: full.token }, "10.0.0.6")).status === 403]).toEqual([method, path, false]);
		}
	});

	test("a device may read settings, usage and VMs, and work with threads", async () => {
		const device = await pair();
		for (const path of ["/api/v1/settings", "/api/v1/settings/audit", "/api/v1/settings/export", "/api/v1/usage", "/api/v1/vms", "/api/v1/threads", "/api/v1/devices"]) {
			expect([path, (await remote("GET", path, { token: device.token })).status]).toEqual([path, 200]);
		}
	});

	test("a threads-only device lists only itself; the owner and a full device list all, current marking the caller's own", async () => {
		const first = await pair("first");
		clock += 1000;
		const second = await pair("second", "10.0.0.6");
		const asFirst = await bodyOf(await remote("GET", "/api/v1/devices", { token: first.token }));
		expect(asFirst.devices).toEqual([
			{ id: first.id, name: "first", platform: "linux", createdAt: new Date(T0).toISOString(), pairedFrom: "10.0.0.5", lastSeenAt: new Date(T0 + 1000).toISOString(), lastSeenAddress: "10.0.0.5", access: "threads", current: true },
		]);
		const asOwner = await bodyOf(await loopback("GET", "/api/v1/devices"));
		expect(asOwner.devices).toMatchObject([
			{ id: first.id, name: "first", current: false },
			{ id: second.id, name: "second", pairedFrom: "10.0.0.6", lastSeenAt: null, current: false },
		]);
		const asSecond = await bodyOf(await loopback("GET", "/api/v1/devices", { token: second.token }));
		expect(asSecond.devices).toMatchObject([{ id: second.id, current: true }]);
		const full = await pair("full", "10.0.0.7", "full");
		const asFull = await bodyOf(await remote("GET", "/api/v1/devices", { token: full.token }, "10.0.0.7"));
		expect(asFull.devices).toMatchObject([
			{ id: first.id, access: "threads", current: false },
			{ id: second.id, access: "threads", current: false },
			{ id: full.id, access: "full", current: true },
		]);
	});

	test("a device can revoke only itself, while a full device revokes any", async () => {
		const first = await pair("first");
		const second = await pair("second");
		expect((await remote("DELETE", `/api/v1/devices/${second.id}`, { token: first.token })).status).toBe(403);
		expect(store.device(second.id)).not.toBeNull();
		const own = await remote("DELETE", `/api/v1/devices/${first.id}`, { token: first.token });
		expect(own.status).toBe(200);
		expect(await bodyOf(own)).toEqual({ device: { id: first.id, name: "first" }, runningThreads: [] });
		expect((await remote("GET", "/api/v1/whoami", { token: first.token })).status).toBe(401);
		expect((await remote("GET", "/api/v1/whoami", { token: second.token })).status).toBe(200);
		const full = await pair("full", "10.0.0.6", "full");
		expect((await remote("DELETE", `/api/v1/devices/${second.id}`, { token: full.token }, "10.0.0.6")).status).toBe(200);
		expect(store.device(second.id)).toBeNull();
	});

	test("the owner revokes any device; unknown and already revoked ones are 404", async () => {
		const device = await pair();
		expect((await loopback("DELETE", `/api/v1/devices/${device.id}`)).status).toBe(200);
		expect((await loopback("DELETE", `/api/v1/devices/${device.id}`)).status).toBe(404);
		expect((await loopback("DELETE", "/api/v1/devices/unknown")).status).toBe(404);
		expect((await loopback("DELETE", "/api/v1/devices/bad%20id")).status).toBe(404);
		expect((await loopback("GET", "/api/v1/devices/x")).status).toBe(404);
		expect((await loopback("POST", "/api/v1/devices")).status).toBe(404);
	});
});

describe("access levels", () => {
	test("an approval with no body, an empty object or access threads gives a threads-only device; access full gives a full one", async () => {
		expect(store.device((await pair("a")).id)?.access).toBe("threads");
		expect(store.device((await pair("b", "10.0.0.5", "threads")).id)?.access).toBe("threads");
		expect(store.device((await pair("c", "10.0.0.5", "full")).id)?.access).toBe("full");
		const offer = await newOffer();
		const redeemed = await bodyOf(await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer, { name: "empty" }) }));
		expect((await loopback("POST", `/api/v1/pairing/offers/${offer.id}/approve`, { body: {} })).status).toBe(204);
		const claimed = await bodyOf(await remote("POST", "/api/v1/pairing/claim", { body: { request: redeemed.request, requestSecret: redeemed.requestSecret } }));
		expect(store.device(str((claimed.device as Record<string, unknown>).id))?.access).toBe("threads");
	});

	test("an approval with another access value is 400 and leaves the offer waiting", async () => {
		const offer = await newOffer();
		await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) });
		for (const access of ["owner", "", 1, null, "FULL"]) {
			const res = await loopback("POST", `/api/v1/pairing/offers/${offer.id}/approve`, { body: { access } });
			expect([access, res.status]).toEqual([access, 400]);
			expect(await bodyOf(res)).toEqual({ error: "access must be full or threads" });
		}
		expect(store.offer(offer.id)?.status).toBe("pending");
	});

	test("a decline ignores access, and an approval's access is recorded once", async () => {
		const offer = await newOffer();
		const redeemed = await bodyOf(await remote("POST", "/api/v1/pairing/redeem", { body: redeemBody(offer) }));
		expect((await loopback("POST", `/api/v1/pairing/offers/${offer.id}/decline`, { body: { access: "full" } })).status).toBe(204);
		const res = await remote("POST", "/api/v1/pairing/claim", { body: { request: redeemed.request, requestSecret: redeemed.requestSecret } });
		expect(res.status).toBe(403);
	});

	test("PATCH sets a device's access, answers the device and takes effect on the device's next request", async () => {
		const device = await pair("laptop");
		expect((await remote("PUT", "/api/v1/settings", { token: device.token, body: { settings: {} } })).status).toBe(403);
		const res = await loopback("PATCH", `/api/v1/devices/${device.id}`, { body: { access: "full" } });
		expect(res.status).toBe(200);
		expect(await bodyOf(res)).toEqual({
			device: {
				id: device.id,
				name: "laptop",
				platform: "linux",
				createdAt: new Date(T0).toISOString(),
				pairedFrom: "10.0.0.5",
				lastSeenAt: new Date(T0).toISOString(),
				lastSeenAddress: "10.0.0.5",
				access: "full",
				current: false,
			},
		});
		expect((await remote("GET", "/api/v1/whoami", { token: device.token })).status).toBe(200);
		expect((await bodyOf(await remote("GET", "/api/v1/whoami", { token: device.token }))).device).toEqual({ id: device.id, name: "laptop", access: "full" });
		expect((await remote("PUT", "/api/v1/settings", { token: device.token, body: { settings: {} } })).status).not.toBe(403);
		// A full device changes access too, its own included, and the answer marks its own device current.
		const own = await remote("PATCH", `/api/v1/devices/${device.id}`, { token: device.token, body: { access: "threads" } });
		expect(own.status).toBe(200);
		expect((await bodyOf(own)).device).toMatchObject({ access: "threads", current: true });
		expect((await remote("PATCH", `/api/v1/devices/${device.id}`, { token: device.token, body: { access: "full" } })).status).toBe(403);
	});

	test("PATCH needs access to be full or threads (400), a body that is JSON (400) and a known active device (404)", async () => {
		const device = await pair("laptop");
		for (const body of [{}, { access: "owner" }, { access: 1 }, { access: null }, { access: "" }]) {
			const res = await loopback("PATCH", `/api/v1/devices/${device.id}`, { body });
			expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
			expect(await bodyOf(res)).toEqual({ error: "access must be full or threads" });
		}
		expect((await loopback("PATCH", `/api/v1/devices/${device.id}`, { body: "not json" })).status).toBe(400);
		expect((await loopback("PATCH", `/api/v1/devices/${device.id}`)).status).toBe(400);
		expect(store.device(device.id)?.access).toBe("threads");
		expect((await loopback("PATCH", "/api/v1/devices/unknown", { body: { access: "full" } })).status).toBe(404);
		expect((await loopback("PATCH", "/api/v1/devices/bad%20id", { body: { access: "full" } })).status).toBe(404);
		expect((await loopback("DELETE", `/api/v1/devices/${device.id}`)).status).toBe(200);
		const revoked = await loopback("PATCH", `/api/v1/devices/${device.id}`, { body: { access: "full" } });
		expect(revoked.status).toBe(404);
		expect(await bodyOf(revoked)).toEqual({ error: "not found" });
		expect((await loopback("PATCH", "/api/v1/devices")).status).toBe(404);
	});

	test("whoami lists the access in the capabilities, and the API revision is 6", async () => {
		const body = await bodyOf(await loopback("GET", "/api/v1/whoami"));
		expect(body.capabilities).toContain("devices.access");
		expect((body.service as Record<string, unknown>).api).toBe(6);
	});
});

describe("attribution", () => {
	test("a device's messages, stops and answers are recorded as device:<id>, and the owner's as owner", async () => {
		const device = await pair();
		const by = `device:${device.id}`;
		seedRunning(THREAD);
		store.askQuestions(THREAD, 1, [ask()], null);
		const sent = await remote("POST", `/api/v1/threads/${THREAD}/messages`, { token: device.token, body: { text: "and then?" } });
		expect(sent.status).toBe(201);
		expect(((await bodyOf(sent)).turn as Record<string, unknown>).by).toBe(by);
		const answered = await remote("POST", `/api/v1/threads/${THREAD}/turns/1/questions/1/answer`, { token: device.token, body: { selected: ["sqlite"] } });
		expect(answered.status).toBe(200);
		expect((await bodyOf(answered)).answeredBy).toBe(by);
		const stopped = await remote("POST", `/api/v1/threads/${THREAD}/stop`, { token: device.token });
		expect(stopped.status).toBe(200);
		const turns = store.turns(THREAD);
		expect(turns.map(t => t.by)).toEqual(["owner", by]);
		expect(turns[0]).toMatchObject({ stopRequested: true, stoppedBy: by });
		expect(turns[1]).toMatchObject({ state: "cancelled", stoppedBy: by });
		const detail = await bodyOf(await remote("GET", `/api/v1/threads/${THREAD}`, { token: device.token }));
		expect(JSON.stringify(detail)).toContain(`"by":"${by}"`);
		expect(JSON.stringify(detail)).toContain(`"answeredBy":"${by}"`);

		store.createThread("bbbbbbbbbbbb", newThread());
		await loopback("POST", "/api/v1/threads/bbbbbbbbbbbb/messages", { body: { text: "hi" } });
		expect(store.turns("bbbbbbbbbbbb").map(t => t.by)).toEqual(["owner", "owner"]);
		expect(store.threadOwner(THREAD)).toBe("owner");
	});

	test("a device's irc messages are accepted like its other messages; the sender is the body's own `from`", async () => {
		const device = await pair();
		seedRunning(THREAD);
		const injected = await remote("POST", `/api/v1/threads/${THREAD}/irc`, { token: device.token, body: { from: "Peer", body: "ping", id: "msg-1" } });
		expect(injected.status).toBe(201);
		expect(await bodyOf(injected)).toEqual({ receipt: "injected", id: "msg-1", turn: null });
		store.completeTurn(THREAD, 1, { outcome: "completed", error: "", reply: "done", usage: null, head: "", filesChanged: 0, insertions: 0, deletions: 0, pushed: false, pushError: "", pushRef: "" });
		const woken = await bodyOf(await remote("POST", `/api/v1/threads/${THREAD}/irc`, { token: device.token, body: { from: "Peer", body: "pong", id: "msg-2" } }));
		expect(woken.receipt).toBe("woken");
		expect(woken.turn).toMatchObject({ by: "Peer", origin: "irc", ircFrom: "Peer", ircId: "msg-2" });
		expect((await remote("POST", `/api/v1/threads/${THREAD}/irc`, { token: "wrong", body: { from: "Peer", body: "x" } })).status).toBe(401);
	});

	test("a thread created through a device is owned by the owner and its first turn is the device's", async () => {
		const device = await pair();
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, maxRequestBodySize: 64 * 1024 * 1024 });
		try {
			const form = new FormData();
			form.append("request", JSON.stringify({ prompt: "fix the bug", repo: { name: "proj", handoffCommit: "a".repeat(40) } }));
			const source = new Uint8Array(3 * 1024 * 1024).fill(97);
			form.append("source", new Blob([source]), "source");
			const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/threads`, { method: "POST", headers: { Authorization: `Bearer ${device.token}` }, body: form });
			expect(res.status).toBe(201);
			const id = str((await bodyOf(res)).id);
			expect(store.getThread(id)?.owner).toBe("owner");
			expect(store.turns(id)[0]?.by).toBe(`device:${device.id}`);
			const stored = await store.blob(id, "source.bundle");
			expect(stored?.size).toBe(source.byteLength);
		} finally {
			await server.stop(true);
		}
	});
});

describe("last seen", () => {
	test("is recorded with the address, at most once a minute", async () => {
		const device = await pair("laptop", "10.0.0.5");
		expect(store.device(device.id)).toMatchObject({ lastSeenAt: null, lastSeenAddress: null });
		await remote("GET", "/api/v1/whoami", { token: device.token }, "10.0.0.5");
		expect(store.device(device.id)).toMatchObject({ lastSeenAt: new Date(T0).toISOString(), lastSeenAddress: "10.0.0.5" });
		clock += MINUTE - 1;
		await remote("GET", "/api/v1/whoami", { token: device.token }, "10.0.0.6");
		expect(store.device(device.id)).toMatchObject({ lastSeenAt: new Date(T0).toISOString(), lastSeenAddress: "10.0.0.5" });
		clock += 1;
		await remote("GET", "/api/v1/whoami", { token: device.token }, "::ffff:10.0.0.6");
		expect(store.device(device.id)).toMatchObject({ lastSeenAt: new Date(T0 + MINUTE).toISOString(), lastSeenAddress: "10.0.0.6" });
	});
});

/** Reads `reader` until it ends: a stream that never ends fails the test by its timeout. */
async function drain(reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">): Promise<void> {
	for (;;) if ((await reader.read()).done) return;
}

describe("revocation", () => {
	test("the device's next request is 401 on both entry points", async () => {
		const device = await pair();
		expect((await loopback("DELETE", `/api/v1/devices/${device.id}`)).status).toBe(200);
		expect((await remote("GET", "/api/v1/whoami", { token: device.token })).status).toBe(401);
		expect((await loopback("GET", "/api/v1/whoami", { token: device.token })).status).toBe(401);
		expect((await bodyOf(await remote("GET", "/api/v1/whoami", { token: device.token }))).error).toBe("unauthorized");
		expect(store.deviceByTokenSha256(tokenSha256(device.token))).toBeNull();
	});

	test("lists the running threads the device started and ends its open streams promptly", async () => {
		const device = await pair();
		const by = `device:${device.id}`;
		seedRunning(THREAD, { sentBy: by });
		store.createThread("bbbbbbbbbbbb", newThread({ sentBy: by }));
		seedRunning("cccccccccccc");
		store.createThread("dddddddddddd", newThread({ sentBy: by }));
		store.startNextTurn("dddddddddddd");
		store.completeTurn("dddddddddddd", 1, { outcome: "completed", error: "", reply: "ok", usage: null, head: "", filesChanged: 0, insertions: 0, deletions: 0, pushed: false, pushError: "", pushRef: "" });

		const threadStream = await remote("GET", `/api/v1/threads/${THREAD}/events`, { token: device.token });
		const globalStream = await remote("GET", "/api/v1/events", { token: device.token });
		const viaLoopback = await loopback("GET", `/api/v1/threads/${THREAD}/events`, { token: device.token });
		expect([threadStream.status, globalStream.status, viaLoopback.status]).toEqual([200, 200, 200]);
		const readers = [threadStream, globalStream, viaLoopback].map(res => res.body?.getReader());
		for (const reader of readers) expect((await reader?.read())?.done).toBe(false);

		const owner = await loopback("GET", `/api/v1/threads/${THREAD}/events`);
		const ownerReader = owner.body?.getReader();
		await ownerReader?.read();

		const revoked = await loopback("DELETE", `/api/v1/devices/${device.id}`);
		expect(revoked.status).toBe(200);
		expect(await bodyOf(revoked)).toEqual({ device: { id: device.id, name: "laptop" }, runningThreads: [THREAD, "bbbbbbbbbbbb"] });
		for (const reader of readers) {
			if (reader === undefined) throw new Error("no body");
			await drain(reader);
		}
		// The owner's own stream is untouched.
		store.enqueueTurn(THREAD, "still here", "owner");
		expect((await ownerReader?.read())?.done).toBe(false);
		await ownerReader?.cancel();
	});
});

/** A request body the test feeds by hand: pushes after the server cancelled the stream are ignored, as a dying client's would be. */
function slowBody(): { body: ReadableStream<Uint8Array>; push: (text: string) => void; end: () => void } {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		body,
		push: text => {
			try {
				controller?.enqueue(new TextEncoder().encode(text));
			} catch {
				// cancelled by the server
			}
		},
		end: () => {
			try {
				controller?.close();
			} catch {
				// cancelled by the server
			}
		},
	};
}

/** Lets queued I/O and microtasks run, so a handler that is going to start reading its body has. */
function settle(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

async function expectUnauthorized(res: Response): Promise<void> {
	expect(res.status).toBe(401);
	expect(res.headers.get("www-authenticate")).toBe('Bearer realm="omp-cloud"');
	expect(await bodyOf(res)).toEqual({ error: "unauthorized" });
}

describe("requests that are already running when the device is revoked", () => {
	function slowPost(path: string, token: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>): Promise<Response> {
		return app.fetchRemote(
			new Request(ORIGIN + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, ...headers }, body, duplex: "half" }),
			from("10.0.0.5"),
		);
	}

	test("a message whose body finishes after the revocation is 401 and adds no turn", async () => {
		const device = await pair();
		seedRunning(THREAD);
		const slow = slowBody();
		const pending = slowPost(`/api/v1/threads/${THREAD}/messages`, device.token, { "content-type": "application/json" }, slow.body);
		slow.push(" ");
		await settle();
		expect((await loopback("DELETE", `/api/v1/devices/${device.id}`)).status).toBe(200);
		slow.push('{"text":"late"}');
		slow.end();
		await expectUnauthorized(await pending);
		expect(store.turns(THREAD)).toHaveLength(1);
	});

	test("an answer whose body finishes after the revocation is 401 and answers nothing", async () => {
		const device = await pair();
		seedRunning(THREAD);
		store.askQuestions(THREAD, 1, [ask()], null);
		const slow = slowBody();
		const pending = slowPost(`/api/v1/threads/${THREAD}/turns/1/questions/1/answer`, device.token, { "content-type": "application/json" }, slow.body);
		slow.push(" ");
		await settle();
		await loopback("DELETE", `/api/v1/devices/${device.id}`);
		slow.push('{"selected":["sqlite"]}');
		slow.end();
		await expectUnauthorized(await pending);
		expect(store.turns(THREAD)[0]?.questions[0]).toMatchObject({ answeredAt: null, answeredBy: "", selected: [] });
	});

	test("a multipart create that finishes after the revocation is 401 and creates no thread", async () => {
		const device = await pair();
		const boundary = "----revoked-boundary";
		const slow = slowBody();
		const pending = slowPost("/api/v1/threads", device.token, { "content-type": `multipart/form-data; boundary=${boundary}` }, slow.body);
		const request = JSON.stringify({ prompt: "fix it", repo: { name: "proj", handoffCommit: "a".repeat(40) } });
		slow.push(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n${request}\r\n`);
		slow.push(`--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\nPART-ONE`);
		await settle();
		expect((await loopback("DELETE", `/api/v1/devices/${device.id}`)).status).toBe(200);
		slow.push(`PART-TWO\r\n--${boundary}--\r\n`);
		slow.end();
		await expectUnauthorized(await pending);
		expect(store.listThreads("owner", 10)).toEqual([]);
		expect(await readdir(join(dir, "threads"))).toEqual([]);
	});

	test("a stale caller is refused before every write, whatever its signal says", async () => {
		const device = await pair();
		const caller = { kind: "device", principal: "owner", device: { id: device.id, name: device.name, access: "threads" } } as const;
		seedRunning(THREAD);
		store.askQuestions(THREAD, 1, [ask()], null);
		store.revokeDevice(device.id, "owner");
		const send = (method: string, path: string, body?: unknown): Promise<Response> =>
			app.fetchAs(caller, new Request(ORIGIN + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
		await expectUnauthorized(await send("POST", `/api/v1/threads/${THREAD}/messages`, { text: "late" }));
		await expectUnauthorized(await send("POST", `/api/v1/threads/${THREAD}/irc`, { from: "Peer", body: "late" }));
		await expectUnauthorized(await send("POST", `/api/v1/threads/${THREAD}/turns/1/questions/1/answer`, { selected: ["sqlite"] }));
		await expectUnauthorized(await send("POST", `/api/v1/threads/${THREAD}/stop`));
		await expectUnauthorized(await send("DELETE", `/api/v1/threads/${THREAD}`));
		await expectUnauthorized(await send("DELETE", `/api/v1/devices/${device.id}`));
		expect(store.turns(THREAD)).toHaveLength(1);
		expect(store.turns(THREAD)[0]).toMatchObject({ stopRequested: false });
		expect(store.turns(THREAD)[0]?.questions[0]?.answeredAt).toBeNull();
		expect(store.pendingIrc(THREAD, 1)).toEqual([]);
		expect(store.getThread(THREAD)).not.toBeNull();
	});

	test("an upload that already finished is refused by the check in front of the thread write", async () => {
		const device = await pair();
		const caller = { kind: "device", principal: "owner", device: { id: device.id, name: device.name, access: "threads" } } as const;
		store.revokeDevice(device.id, "owner");
		const form = new FormData();
		form.append("request", JSON.stringify({ prompt: "fix it", repo: { name: "proj", handoffCommit: "a".repeat(40) } }));
		form.append("source", new Blob(["SOURCE"]), "source");
		await expectUnauthorized(await app.fetchAs(caller, new Request(`${ORIGIN}/api/v1/threads`, { method: "POST", body: form })));
		expect(store.listThreads("owner", 10)).toEqual([]);
		expect(await readdir(join(dir, "threads"))).toEqual([]);
	});

	test("a download in progress ends after the revocation", async () => {
		const device = await pair();
		seedRunning(THREAD);
		const size = 64 * 1024 ** 2;
		await store.putBlob(THREAD, "result.bundle", new Uint8Array(size), size);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeout: 0 });
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/threads/${THREAD}/result`, { headers: { Authorization: `Bearer ${device.token}` } });
			expect(res.status).toBe(200);
			const reader = res.body?.getReader();
			if (reader === undefined) throw new Error("no body");
			let received = (await reader.read()).value?.byteLength ?? 0;
			expect(received).toBeGreaterThan(0);
			expect((await fetch(`http://127.0.0.1:${server.port}/api/v1/devices/${device.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					received += next.value.byteLength;
				}
			} catch {
				// The connection was cut: the stream ended with an error.
			}
			expect(received).toBeLessThan(size);
		} finally {
			await server.stop(true);
		}
	});

	test("a device gets ranges of a download too, and the owner's downloads are untouched", async () => {
		const device = await pair();
		seedRunning(THREAD);
		await store.putBlob(THREAD, "result.bundle", new TextEncoder().encode("BUNDLE-BYTES"), 100);
		const get = (range?: string): Promise<Response> =>
			remote("GET", `/api/v1/threads/${THREAD}/result`, { token: device.token, headers: range === undefined ? {} : { Range: range } });
		const whole = await get();
		expect(whole.status).toBe(200);
		expect(whole.headers.get("accept-ranges")).toBe("bytes");
		expect(whole.headers.get("x-omp-branch")).toBe(`omp-cloud/${THREAD}`);
		expect(await whole.text()).toBe("BUNDLE-BYTES");
		const partial = await get("bytes=0-5");
		expect(partial.status).toBe(206);
		expect(partial.headers.get("content-range")).toBe("bytes 0-5/12");
		expect(await partial.text()).toBe("BUNDLE");
		const tail = await get("bytes=7-");
		expect(tail.headers.get("content-range")).toBe("bytes 7-11/12");
		expect(await tail.text()).toBe("BYTES");
		const last = await get("bytes=-3");
		expect(await last.text()).toBe("TES");
		const beyond = await get("bytes=100-");
		expect(beyond.status).toBe(416);
		expect(beyond.headers.get("content-range")).toBe("bytes */12");
	});
});

describe("a real TLS listener", () => {
	test("serves the remote entry point over the service's own certificate, pinned", async () => {
		const files = await generateIdentity(dir);
		const identity = await loadIdentity(files);
		const device = await pair("tls device");
		const server = serveRemote({ hostname: "127.0.0.1", port: 0 }, identity, app);
		try {
			const url = `https://127.0.0.1:${server.port}`;
			const pinned = { ca: identity.cert, checkServerIdentity: () => undefined };
			const res = await fetch(`${url}/api/v1/whoami`, { headers: { Authorization: `Bearer ${device.token}` }, tls: pinned, redirect: "error" });
			expect(res.status).toBe(200);
			expect((await bodyOf(res)).device).toEqual({ id: device.id, name: "tls device", access: "threads" });
			expect(store.device(device.id)?.lastSeenAddress).toBe("127.0.0.1");

			const owner = await fetch(`${url}/api/v1/whoami`, { headers: { Authorization: `Bearer ${TOKEN}` }, tls: pinned });
			expect(owner.status).toBe(401);

			await expect(fetch(`${url}/api/v1/whoami`, { headers: { Authorization: `Bearer ${device.token}` } })).rejects.toThrow();
		} finally {
			await server.stop(true);
		}
	});

	test("an address outside allow is refused over TLS before routing", async () => {
		const files = await generateIdentity(dir);
		const identity = await loadIdentity(files);
		app = await buildApp({ ...remoteSettings(), access: new RemoteAccess(["10.0.0.0/8"], []) });
		const server = serveRemote({ hostname: "127.0.0.1", port: 0 }, identity, app);
		try {
			const res = await fetch(`https://127.0.0.1:${server.port}/api/v1/whoami`, { tls: { ca: identity.cert, checkServerIdentity: () => undefined } });
			expect(res.status).toBe(403);
			expect(await bodyOf(res)).toEqual({ error: "forbidden" });
		} finally {
			await server.stop(true);
		}
	});
});
