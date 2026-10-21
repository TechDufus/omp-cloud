import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CloudClient } from "../src/api";
import { CloudError } from "../src/errors";
import { fingerprintOf } from "../src/pairing";
import { certificatePem, pinnedFetch, readServerCertificate } from "../src/transport";
import { cleanup } from "./helpers";
import { fakeTls, makeCert, type FakeTls, type TestCert } from "./tls";

let good: TestCert;
let other: TestCert;
const servers: FakeTls[] = [];

beforeAll(async () => {
	[good, other] = await Promise.all([makeCert("good"), makeCert("other")]);
});
afterEach(() => {
	for (const s of servers.splice(0)) s.server.stop(true);
});
afterAll(cleanup);

const serve = (cert: TestCert, handler: Parameters<typeof fakeTls>[1]): FakeTls => {
	const s = fakeTls(cert, handler);
	servers.push(s);
	return s;
};

const pin = (cert: TestCert, addresses: string[]) => ({ fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses });

/** A port nothing listens on. */
async function deadAddress(): Promise<string> {
	const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = s.port;
	await s.stop(true);
	return `127.0.0.1:${port}`;
}

describe("pinned transport", () => {
	test("talks to the server whose certificate is pinned, with no system roots and no host-name check", async () => {
		const s = serve(good, () => Response.json({ ok: true }));
		// The certificate names localhost and 127.0.0.1; the request goes to a name it does not carry.
		const res = await pinnedFetch(pin(good, [s.address]))("https://some-other-name.invalid/x");
		expect(await res.json()).toEqual({ ok: true });
		expect(s.seen.map(r => r.path)).toEqual(["/x"]);
	});

	test("a different self-signed server is refused and receives no HTTP request", async () => {
		const impostor = serve(other, () => Response.json({ ok: true }));
		const err = await pinnedFetch(pin(good, [impostor.address]))("https://x.invalid/api/v1/whoami", { headers: { Authorization: "Bearer ompd_secret" } }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain(good.fingerprint);
		expect(impostor.seen).toEqual([]);
	});

	test("the client reports a refused certificate as unreachable and never sends the token", async () => {
		const impostor = serve(other, () => Response.json({}));
		const client = new CloudClient(`https://${impostor.address}`, "ompd_secret", pinnedFetch(pin(good, [impostor.address])));
		const err = await client.whoami().catch((e: unknown) => e);
		expect((err as Error).message).toContain(`cannot reach https://${impostor.address}`);
		expect(impostor.seen).toEqual([]);
	});

	test("a redirect is refused and its target is never requested", async () => {
		const target = serve(good, () => Response.json({ reached: true }));
		const redirector = serve(good, () => new Response(null, { status: 302, headers: { Location: `https://${target.address}/stolen` } }));
		const err = await pinnedFetch(pin(good, [redirector.address, target.address]))("https://x.invalid/api/v1/whoami").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(redirector.seen).toHaveLength(1);
		// A redirect is not a connection failure: the next address is not tried either.
		expect(target.seen).toEqual([]);
	});

	test("fails over to the next address when a connection fails, and remembers the one that answered", async () => {
		const live = serve(good, () => Response.json({ ok: true }));
		const fetcher = pinnedFetch(pin(good, [await deadAddress(), live.address]));
		expect((await fetcher("https://x.invalid/a")).status).toBe(200);
		expect((await fetcher("https://x.invalid/b")).status).toBe(200);
		expect(live.seen.map(r => r.path)).toEqual(["/a", "/b"]);
	});

	test("an HTTP status is an answer, not a reason to try another address", async () => {
		const first = serve(good, () => Response.json({ error: "no" }, { status: 500 }));
		const second = serve(good, () => Response.json({ ok: true }));
		const res = await pinnedFetch(pin(good, [first.address, second.address]))("https://x.invalid/a");
		expect(res.status).toBe(500);
		expect(second.seen).toEqual([]);
	});

	test("every address failing is the last connection error", async () => {
		const err = await pinnedFetch(pin(good, [await deadAddress(), await deadAddress()]))("https://x.invalid/a").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
	});

	test("a caller's abort is not retried on another address", async () => {
		const live = serve(good, () => Response.json({ ok: true }));
		const ctrl = new AbortController();
		ctrl.abort();
		const err = await pinnedFetch(pin(good, [live.address]))("https://x.invalid/a", { signal: ctrl.signal }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(live.seen).toEqual([]);
	});

	test("the client carries the device token over the pinned transport and refuses an owner-style redirect", async () => {
		const s = serve(good, () => Response.json({ user: "owner" }));
		const client = new CloudClient(`https://${s.address}`, "ompd_tok", pinnedFetch(pin(good, [s.address])));
		expect((await client.whoami()).user).toBe("owner");
		expect(s.seen[0]?.authorization).toBe("Bearer ompd_tok");
	});
});

describe("every CloudClient request refuses redirects", () => {
	test("a plain http service that redirects is an error and the target sees nothing", async () => {
		const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ reached: true }) });
		const redirector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${target.port}/x` } }) });
		try {
			let reached = 0;
			target.reload({ fetch: () => (reached++, Response.json({})) });
			const err = await new CloudClient(`http://127.0.0.1:${redirector.port}`, "tok", undefined, { backoffMs: [] }).whoami().catch((e: unknown) => e);
			expect(err).toBeInstanceOf(CloudError);
			expect(err).toMatchObject({ code: "unreachable", retriable: false });
			expect(reached).toBe(0);
		} finally {
			await redirector.stop(true);
			await target.stop(true);
		}
	});
});

describe("reading a certificate", () => {
	test("returns the leaf DER the server presents, verified or not, and sends nothing", async () => {
		const s = serve(other, () => Response.json({}));
		const der = await readServerCertificate({ host: "127.0.0.1", port: s.server.port ?? 0, text: s.address });
		expect(fingerprintOf(der)).toBe(other.fingerprint);
		expect(s.seen).toEqual([]);
	});

	test("an address nobody answers on is an error", async () => {
		const dead = (await deadAddress()).split(":");
		await expect(readServerCertificate({ host: "127.0.0.1", port: Number(dead[1]), text: dead.join(":") })).rejects.toBeInstanceOf(Error);
	});

	test("a server that accepts the connection and says nothing times out", async () => {
		const silent = await Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
		try {
			await expect(readServerCertificate({ host: "127.0.0.1", port: silent.port, text: `127.0.0.1:${silent.port}` }, 150)).rejects.toThrow("no answer");
		} finally {
			silent.stop(true);
		}
	});

	test("certificatePem wraps the DER as a PEM block", () => {
		const pem = certificatePem(good.der.toString("base64"));
		expect(pem.startsWith("-----BEGIN CERTIFICATE-----\n")).toBe(true);
		expect(pem.trimEnd().endsWith("-----END CERTIFICATE-----")).toBe(true);
		expect(Math.max(...pem.split("\n").map(l => l.length))).toBeLessThanOrEqual(64);
	});
});

describe("the one place that does not verify a certificate", () => {
	test("`rejectUnauthorized` appears in plugin/src/transport.ts and in no other source file, and only as `false` once", async () => {
		const src = join(import.meta.dir, "..", "src");
		const hits: string[] = [];
		for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: src })) {
			const text = await Bun.file(join(src, path)).text();
			if (text.includes("rejectUnauthorized")) hits.push(path);
		}
		expect(hits).toEqual(["transport.ts"]);
		const transport = await Bun.file(join(src, "transport.ts")).text();
		expect(transport.match(/rejectUnauthorized/g)).toHaveLength(1);
		expect(transport).toContain("rejectUnauthorized: false");
	});

	test("no source file sets a global TLS opt-out either", async () => {
		const src = join(import.meta.dir, "..", "src");
		for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: src })) {
			const text = await Bun.file(join(src, path)).text();
			expect(text, path).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
		}
	});
});
