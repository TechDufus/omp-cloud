/** Test fixtures for the paired transport: self-signed certificates from openssl, fake TLS services, and a paired connection on disk. */

import { randomBytes, X509Certificate } from "node:crypto";
import { join } from "node:path";
import { writeConnectionFile, type PairedConnection } from "../src/connection";
import { run } from "../src/exec";
import { fingerprintOf } from "../src/pairing";
import { whoami } from "./builders";
import { tmp } from "./helpers";

export interface TestCert {
	cert: string;
	key: string;
	/** The certificate's DER. */
	der: Buffer;
	/** `SHA256:…` */
	fingerprint: string;
}

/** A self-signed P-256 certificate for 127.0.0.1 and localhost, made by openssl in a temp directory. */
export async function makeCert(cn = "omp-cloud-test"): Promise<TestCert> {
	const dir = await tmp("omp-cloud-tls-");
	const keyFile = join(dir, "key.pem");
	const certFile = join(dir, "cert.pem");
	const r = await run("openssl", [
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-keyout",
		keyFile,
		"-out",
		certFile,
		"-days",
		"2",
		"-subj",
		`/CN=${cn}`,
		"-addext",
		"subjectAltName=IP:127.0.0.1,DNS:localhost",
	]);
	if (r.code !== 0) throw new Error(`openssl failed: ${r.stderr}`);
	const cert = await Bun.file(certFile).text();
	const der = new X509Certificate(cert).raw;
	return { cert, key: await Bun.file(keyFile).text(), der, fingerprint: fingerprintOf(der) };
}

export interface SeenRequest {
	method: string;
	path: string;
	authorization: string | null;
	body: string;
}

export interface FakeTls {
	server: Bun.Server<undefined>;
	/** `127.0.0.1:<port>` */
	address: string;
	/** Every request the service received, in order. */
	seen: SeenRequest[];
}

/** A TLS service presenting `cert`; `handler` answers and every request is recorded first. */
export function fakeTls(cert: TestCert, handler: (req: Request, url: URL, seen: SeenRequest[]) => Response | Promise<Response>): FakeTls {
	const seen: SeenRequest[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		tls: { cert: cert.cert, key: cert.key },
		fetch: async req => {
			const url = new URL(req.url);
			seen.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body: await req.clone().text() });
			return handler(req, url, seen);
		},
	});
	const fake = { server, address: `127.0.0.1:${server.port}`, seen };
	running.push(fake);
	return fake;
}

/** Every fake service still running; `stopFakeServers` ends them. */
const running: FakeTls[] = [];

export function stopFakeServers(): void {
	for (const s of running.splice(0)) s.server.stop(true);
}

/** The device a {@link pairingService} pairs. */
export const PAIRING_DEVICE = { id: "dev12345abcdef", name: "laptop-2" };

export interface PairingService extends FakeTls {
	/** The device token it mints and accepts. */
	token: string;
	/** The next claims' answers, in order; the default is pending twice, then approved. */
	claims: (() => Response)[];
	/** The access level its whoami reports for the device; `full` by default. */
	access: "full" | "threads";
}

/** A fake omp-cloud remote listener: redeem, claim (scripted), whoami for its token, and device revocation. */
export function pairingService(cert: TestCert): PairingService {
	const token = deviceToken();
	const claims: (() => Response)[] = [
		() => Response.json({ status: "pending" }, { status: 202 }),
		() => Response.json({ status: "pending" }, { status: 202 }),
		() => Response.json({ device: PAIRING_DEVICE, token }, { status: 201 }),
	];
	const fake = fakeTls(cert, (req, url) => {
		if (req.method === "POST" && url.pathname === "/api/v1/pairing/redeem") {
			return Response.json({ request: "req123456789", requestSecret: "reqsecret1234567890123", expiresAt: new Date(Date.now() + 120_000).toISOString() }, { status: 202 });
		}
		if (req.method === "POST" && url.pathname === "/api/v1/pairing/claim") return (claims.shift() ?? (() => Response.json({ error: "gone" }, { status: 401 })))();
		if (url.pathname === "/api/v1/whoami") {
			if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
			return Response.json(whoami({ device: { ...PAIRING_DEVICE, access: service.access }, remote: { fingerprint: cert.fingerprint } }));
		}
		if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/devices/")) return Response.json({ device: { id: url.pathname.split("/").pop(), name: "old" }, runningThreads: [] });
		return Response.json({ error: "not found" }, { status: 404 });
	});
	const service: PairingService = Object.assign(fake, { token, claims, access: "full" as const });
	return service;
}

/** A fresh device token: `ompd_` and 43 base64url characters. */
export function deviceToken(): string {
	return `ompd_${randomBytes(32).toString("base64url")}`;
}

/** A pairing code for `cert` at `addresses`. `encoding` is how the fingerprint is written in it. */
export function pairingCode(cert: TestCert, addresses: string[], opts: { offer?: string; secret?: string; encoding?: "base64url" | "base64" } = {}): string {
	const b64 = cert.fingerprint.slice("SHA256:".length);
	const fp = opts.encoding === "base64" ? b64 : b64.replaceAll("+", "-").replaceAll("/", "_");
	return `ompc1:${opts.offer ?? "offer1234567"}:${opts.secret ?? "secret1234567890123456"}:${fp}@${addresses.join(",")}`;
}

/** Writes a paired connection for `cert` at `addresses` into a fresh config directory; returns its path and the record. */
export async function pairedFile(cert: TestCert, addresses: string[], over: Partial<PairedConnection> = {}): Promise<{ file: string; connection: PairedConnection }> {
	const dir = await tmp("omp-cloud-conn-");
	const file = join(dir, "omp-cloud", "connection.json");
	const connection: PairedConnection = {
		server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses },
		device: { id: "dev12345abcdef", name: "laptop" },
		token: deviceToken(),
		pairedAt: "2026-10-20T00:00:00.000Z",
		...over,
	};
	await writeConnectionFile(file, connection);
	return { file, connection };
}

/** What `omp-cloud ssh-pair` prints on success for a service presenting `cert` at `address` (`host:port`), as one JSON object. */
export function sshPairRecord(cert: TestCert, address: string, token: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ompCloudPair: 1,
		device: PAIRING_DEVICE,
		token,
		server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), port: Number(address.split(":").at(-1)), addresses: [address] },
		service: { version: "0.4.0", api: 2 },
		...over,
	};
}
