import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runConnect, type ConnectDeps, type ConnectInput } from "../src/connect";
import { readConnectionFile } from "../src/connection";
import { pairArgv, type SshOutput, type SshRunner } from "../src/ssh";
import { UserError } from "../src/types";
import { fakeHost, type FakeHost } from "./fakes";
import { cleanup, tmp } from "./helpers";
import { fakeTls, makeCert, PAIRING_DEVICE as DEVICE, pairedFile, pairingCode, pairingService, sshPairRecord, stopFakeServers, type PairingService, type TestCert } from "./tls";

let cert: TestCert;
let impostorCert: TestCert;

beforeAll(async () => {
	[cert, impostorCert] = await Promise.all([makeCert("service"), makeCert("impostor")]);
});
afterEach(async () => {
	stopFakeServers();
	await cleanup();
});
afterAll(cleanup);

const service = (c: TestCert = cert): PairingService => pairingService(c);

interface Run {
	file: string;
	host: FakeHost;
	input: ConnectInput;
	deps: ConnectDeps;
}

async function setup(target: string, over: Partial<ConnectInput> = {}, deps: Partial<ConnectDeps> = {}): Promise<Run> {
	const dir = await tmp("omp-cloud-conn-");
	const file = join(dir, "omp-cloud", "connection.json");
	const host = fakeHost();
	return { file, host, input: { target, name: undefined, replace: false, allowPublic: false, ...over }, deps: { connectionFile: file, ui: host.host.ui, pollMs: 5, hostName: "laptop", ...deps } };
}

const failure = async (p: Promise<unknown>): Promise<string> => {
	const err = await p.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(UserError);
	return (err as UserError).message;
};

describe("/cloud connect", () => {
	test("a matching certificate: redeem, wait for approval, write the file, verify with the device token, show a card without secrets", async () => {
		const svc = service();
		const code = pairingCode(cert, [svc.address]);
		const r = await setup(code, { name: "laptop" });
		const card = await runConnect(r.input, r.deps);

		// What was sent: the redeem is public (no token) and carries the name and platform; the claims are public too.
		const redeem = svc.seen.find(s => s.path === "/api/v1/pairing/redeem");
		expect(redeem?.authorization).toBeNull();
		expect(JSON.parse(redeem?.body ?? "{}")).toEqual({ offer: "offer1234567", secret: "secret1234567890123456", name: "laptop", platform: process.platform });
		const claims = svc.seen.filter(s => s.path === "/api/v1/pairing/claim");
		expect(claims).toHaveLength(3);
		expect(claims.every(c => c.authorization === null)).toBe(true);
		expect(JSON.parse(claims[0]?.body ?? "{}")).toEqual({ request: "req123456789", requestSecret: "reqsecret1234567890123" });
		// The pinned whoami carries the device token.
		expect(svc.seen.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/whoami", authorization: `Bearer ${svc.token}` });

		// What was written.
		expect((await stat(r.file)).mode & 0o777).toBe(0o600);
		expect((await stat(dirname(r.file))).mode & 0o777).toBe(0o700);
		expect(await readdir(dirname(r.file))).toEqual(["connection.json"]);
		const saved = await readConnectionFile(r.file);
		expect(saved).toMatchObject({ token: svc.token, device: DEVICE, server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses: [svc.address] } });

		// What was shown.
		expect(card.title).toBe("Connected to omp-cloud");
		expect(card.lines).toEqual([`server ${cert.fingerprint} at ${svc.address}`, "this device: laptop-2 (dev12345)"]);
		const shown = JSON.stringify([card, r.host.notes]);
		for (const secret of [svc.token, "secret1234567890123456", "reqsecret1234567890123", code]) expect(shown).not.toContain(secret);
		const waiting = r.host.widgets.filter((w): w is string[] => Array.isArray(w)).map(w => w.join("\n"));
		expect(waiting[0]).toContain("waiting for approval on the server machine");
		expect(waiting[0]).toMatch(/expires in \d+:\d\d/);
		expect(r.host.widgets.at(-1)).toBeUndefined();
		expect(JSON.stringify(waiting)).not.toContain(svc.token);
	});

	test("the default device name is the machine's, made valid", async () => {
		const svc = service();
		const r = await setup(pairingCode(cert, [svc.address]), {}, { hostName: "my/box" });
		await runConnect(r.input, r.deps);
		expect(JSON.parse(svc.seen[0]?.body ?? "{}").name).toBe("my-box");
	});

	test("an impostor presenting another certificate at the code's address is refused and receives no HTTP request", async () => {
		const impostor = service(impostorCert);
		const r = await setup(pairingCode(cert, [impostor.address]));
		const message = await failure(runConnect(r.input, r.deps));

		expect(message).toContain("different certificate");
		expect(message).toContain("nothing was sent");
		expect(impostor.seen).toEqual([]);
		expect(await readConnectionFile(r.file)).toBeUndefined();
	});

	test("an address that is down is skipped and the next one, which presents the right certificate, is used", async () => {
		const live = service();
		const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const deadAddress = `127.0.0.1:${dead.port}`;
		await dead.stop(true);
		const impostor = service(impostorCert);
		const r = await setup(pairingCode(cert, [deadAddress, impostor.address, live.address]));
		await runConnect(r.input, r.deps);

		expect(impostor.seen).toEqual([]);
		expect(live.seen.length).toBeGreaterThan(0);
		expect((await readConnectionFile(r.file))?.server.addresses).toEqual([live.address]);
	});

	test("with no address answering the error names each", async () => {
		const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const address = `127.0.0.1:${dead.port}`;
		await dead.stop(true);
		const r = await setup(pairingCode(cert, [address]));
		const message = await failure(runConnect(r.input, r.deps));
		expect(message).toContain(address);
		expect(message).toContain("did not answer");
	});

	test("a name that resolves to a public address refuses the code before anything is contacted; --allow-public lets it through", async () => {
		const read: string[] = [];
		const readCertificate: ConnectDeps["readCertificate"] = async a => {
			read.push(a.text);
			throw new Error("unreachable in this test");
		};
		const resolve = async (host: string): Promise<string[]> => (host === "box.lan" ? ["::ffff:8.8.8.8"] : ["10.0.0.5", "93.184.216.34"]);
		for (const host of ["nas.local", "box.lan"]) {
			const r = await setup(pairingCode(cert, ["10.0.0.9:8443", `${host}:8443`]), {}, { readCertificate, resolve });
			const message = await failure(runConnect(r.input, r.deps));
			expect(message).toContain(`${host}:8443`);
			expect(message).toContain("not a local address");
		}
		expect(read).toEqual([]);

		const forced = await setup(pairingCode(cert, ["nas.local:8443"]), { allowPublic: true }, { readCertificate, resolve });
		expect(await failure(runConnect(forced.input, forced.deps))).toContain("did not answer");
		// Resolved once, connected by each IP literal.
		expect(read).toEqual(["10.0.0.5:8443", "93.184.216.34:8443"]);
	});

	test("a name that does not resolve is skipped and reported; the IP address of the same code pairs", async () => {
		const svc = service();
		const port = svc.address.split(":")[1];
		const resolved: string[] = [];
		const resolve = async (host: string): Promise<string[]> => {
			resolved.push(host);
			throw new Error("ENOTFOUND");
		};
		const r = await setup(pairingCode(cert, [`nohost.local:${port}`, svc.address]), {}, { resolve });
		await runConnect(r.input, r.deps);
		expect(resolved).toEqual(["nohost.local"]);
		expect((await readConnectionFile(r.file))?.server.addresses).toEqual([svc.address]);
		expect(svc.seen.length).toBeGreaterThan(0);
	});

	test("every address unresolvable or unanswering is the cannot-pair error listing each problem", async () => {
		const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const address = `127.0.0.1:${dead.port}`;
		await dead.stop(true);
		const resolve = async (host: string): Promise<string[]> => {
			if (host === "empty.local") return [];
			throw new Error("ENOTFOUND");
		};
		const r = await setup(pairingCode(cert, ["nohost.local:8443", "empty.local:8443", address]), {}, { resolve });
		const message = await failure(runConnect(r.input, r.deps));
		expect(message).toContain("cannot pair:");
		expect(message).toContain("nohost.local:8443 cannot be resolved (ENOTFOUND)");
		expect(message).toContain("empty.local:8443 resolves to no address");
		expect(message).toContain(`${address} did not answer`);
	});

	test("a name is resolved once and every connect-phase request goes to the vetted IP, never the public address a later lookup would give", async () => {
		let lookups = 0;
		const resolve = async (): Promise<string[]> => (++lookups === 1 ? ["10.0.0.7"] : ["93.184.216.34"]);
		const read: string[] = [];
		const readCertificate: ConnectDeps["readCertificate"] = async a => {
			read.push(a.text);
			return cert.der;
		};
		const targets: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			targets.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
			if (url.pathname === "/api/v1/pairing/redeem") return Response.json({ request: "req123456789", requestSecret: "reqsecret1234567890123", expiresAt: new Date(Date.now() + 120_000).toISOString() }, { status: 202 });
			if (url.pathname === "/api/v1/pairing/claim") return Response.json({ device: DEVICE, token: "ompd_" + "a".repeat(43) }, { status: 201 });
			return Response.json({ error: "unreachable" }, { status: 503 });
		}) as typeof fetch;
		try {
			const r = await setup(pairingCode(cert, ["workstation.local:8443"]), {}, { resolve, readCertificate });
			await runConnect(r.input, r.deps);
			expect(await readConnectionFile(r.file)).toMatchObject({ server: { addresses: ["workstation.local:8443"] } });
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(lookups).toBe(1);
		expect(read).toEqual(["10.0.0.7:8443"]);
		expect(targets).toEqual(["POST 10.0.0.7:8443/api/v1/pairing/redeem", "POST 10.0.0.7:8443/api/v1/pairing/claim", "GET 10.0.0.7:8443/api/v1/whoami"]);
	});

	test("a public address is refused before anything is contacted, unless --allow-public", async () => {
		let probed = 0;
		const readCertificate: ConnectDeps["readCertificate"] = async () => {
			probed++;
			throw new Error("unreachable in this test");
		};
		for (const address of ["203.0.113.7:8443", "example.com:8443", "[2001:db8::1]:8443"]) {
			const r = await setup(pairingCode(cert, ["10.0.0.5:8443", address]), {}, { readCertificate });
			const message = await failure(runConnect(r.input, r.deps));
			expect(message).toContain(address);
			expect(message).toContain("--allow-public");
		}
		expect(probed).toBe(0);

		const r = await setup(pairingCode(cert, ["203.0.113.7:8443"]), { allowPublic: true }, { readCertificate });
		expect(await failure(runConnect(r.input, r.deps))).toContain("did not answer");
		expect(probed).toBe(1);
	});

	test("an existing connection is refused without --replace, and nothing is contacted", async () => {
		const old = service(impostorCert);
		const { file, connection } = await pairedFile(impostorCert, [old.address]);
		const fresh = service();
		const host = fakeHost();
		const message = await failure(runConnect({ target: pairingCode(cert, [fresh.address]), name: undefined, replace: false, allowPublic: false }, { connectionFile: file, ui: host.host.ui, pollMs: 5 }));

		expect(message).toContain("already connected");
		expect(message).toContain("--replace");
		expect(fresh.seen).toEqual([]);
		expect(old.seen).toEqual([]);
		expect(await readConnectionFile(file)).toEqual(connection);
	});

	test("--replace revokes the old device first, then pairs and replaces the file", async () => {
		const old = service(impostorCert);
		const { file, connection } = await pairedFile(impostorCert, [old.address]);
		const fresh = service();
		const host = fakeHost();
		await runConnect({ target: pairingCode(cert, [fresh.address]), name: "laptop", replace: true, allowPublic: false }, { connectionFile: file, ui: host.host.ui, pollMs: 5 });

		expect(old.seen).toEqual([{ method: "DELETE", path: `/api/v1/devices/${connection.device.id}`, authorization: `Bearer ${connection.token}`, body: "" }]);
		expect(host.notes.map(n => n[0])).toContain("☁ revoked the old device laptop");
		expect((await readConnectionFile(file))?.token).toBe(fresh.token);
	});

	test("--replace still pairs when the old server cannot be reached, and says the old token stays valid", async () => {
		const old = service(impostorCert);
		const { file, connection } = await pairedFile(impostorCert, [old.address]);
		old.server.stop(true);
		const fresh = service();
		const host = fakeHost();
		await runConnect({ target: pairingCode(cert, [fresh.address]), name: "laptop", replace: true, allowPublic: false }, { connectionFile: file, ui: host.host.ui, pollMs: 5 });

		const warning = host.notes.find(n => n[1] === "warning")?.[0] ?? "";
		expect(warning).toContain("could not revoke the old device laptop");
		expect(warning).toContain("stays valid");
		expect(warning).not.toContain(connection.token);
		expect((await readConnectionFile(file))?.token).toBe(fresh.token);
	});

	test("a corrupt existing file blocks a plain connect and is replaced with --replace", async () => {
		const svc = service();
		const r = await setup(pairingCode(cert, [svc.address]));
		await Bun.write(r.file, "{ not json", { createPath: true });
		await chmod(r.file, 0o600);
		expect(await failure(runConnect(r.input, r.deps))).toContain("not a valid connection record");
		expect(svc.seen).toEqual([]);
		await runConnect({ ...r.input, replace: true }, r.deps);
		expect((await readConnectionFile(r.file))?.token).toBe(svc.token);
	});

	test("the owner declining ends the connect without a file", async () => {
		const svc = service();
		svc.claims.splice(0, 3, () => Response.json({ status: "pending" }, { status: 202 }), () => Response.json({ error: "the owner declined this device" }, { status: 403 }));
		const r = await setup(pairingCode(cert, [svc.address]));
		expect(await failure(runConnect(r.input, r.deps))).toContain("declined");
		expect(await readConnectionFile(r.file)).toBeUndefined();
		expect(r.host.widgets.at(-1)).toBeUndefined();
	});

	test("a request that is never approved expires on the clock, not by waiting", async () => {
		const svc = service();
		svc.claims.splice(0, 3, ...Array.from({ length: 50 }, () => () => Response.json({ status: "pending" }, { status: 202 })));
		const start = Date.now();
		const r = await setup(pairingCode(cert, [svc.address]), {}, { now: () => start + (svc.seen.filter(s => s.path === "/api/v1/pairing/claim").length > 2 ? 10 * 60_000 : 0), pollMs: 1 });
		expect(await failure(runConnect(r.input, r.deps))).toContain("expired");
		expect(await readConnectionFile(r.file)).toBeUndefined();
		expect(r.host.widgets.at(-1)).toBeUndefined();
	});

	test("an invalid or used code is the service's refusal, passed on", async () => {
		const svc = service();
		const refusing = fakeTls(cert, () => Response.json({ error: "invalid or expired pairing code" }, { status: 401 }));
		const r = await setup(pairingCode(cert, [refusing.address]));
		const err = await runConnect(r.input, r.deps).catch((e: unknown) => e);
		expect((err as Error).message).toBe("invalid or expired pairing code");
		expect(svc.seen).toEqual([]);
		expect(JSON.parse(await readFile(r.file, "utf8").catch(() => "null"))).toBeNull();
	});

	test("a malformed code or device name is refused before any network", async () => {
		const r = await setup("not a code");
		expect(await failure(runConnect(r.input, r.deps))).toContain("not a pairing code");
		const svc = service();
		const named = await setup(pairingCode(cert, [svc.address]), { name: "bad/name" });
		expect(await failure(runConnect(named.input, named.deps))).toContain("device name");
		expect(svc.seen).toEqual([]);
	});

	test("the code in single quotes pairs, standard-base64 fingerprint included", async () => {
		const svc = service();
		const r = await setup(`'${pairingCode(cert, [svc.address], { encoding: "base64" })}'`);
		await runConnect(r.input, r.deps);
		expect((await readConnectionFile(r.file))?.device).toEqual(DEVICE);
	});
});

describe("/cloud connect over ssh", () => {
	const ok = (stdout: string, over: Partial<SshOutput> = {}): SshOutput => ({ exitCode: 0, stdout, stderr: "", timedOut: false, ...over });
	const record = (svc: PairingService, over: Record<string, unknown> = {}): string => `Welcome to nas\n${JSON.stringify(sshPairRecord(cert, svc.address, svc.token, over))}\n`;

	/** A fake ssh: `ssh -G` names `host`, every other call answers `pair`. */
	function sshd(pair: SshOutput | (() => SshOutput), host = "127.0.0.1"): { run: SshRunner; pairs: { argv: readonly string[]; signal: AbortSignal | undefined }[]; configs: readonly string[][] } {
		const pairs: { argv: readonly string[]; signal: AbortSignal | undefined }[] = [];
		const configs: string[][] = [];
		const run: SshRunner = async (argv, opts) => {
			if (argv.includes("-G")) {
				configs.push([...argv]);
				return host === "" ? ok("", { exitCode: 255 }) : ok(`user me\nhostname ${host}\nport 22\n`);
			}
			pairs.push({ argv, signal: opts.signal });
			return typeof pair === "function" ? pair() : pair;
		};
		return { run, pairs, configs };
	}

	test("pairs without an approval: no redeem or claim, one whoami with the delivered token, a 0600 file, a card without secrets", async () => {
		const svc = service();
		const ssh = sshd(ok(record(svc)));
		const r = await setup("me@nas.local", { name: "laptop" }, { ssh: ssh.run, env: {} });
		const card = await runConnect(r.input, r.deps);

		expect(ssh.pairs.map(p => p.argv)).toEqual([pairArgv("ssh", { destination: "me@nas.local", port: undefined }, "laptop", process.platform)]);
		expect(svc.seen.map(s => [s.method, s.path, s.authorization])).toEqual([["GET", "/api/v1/whoami", `Bearer ${svc.token}`]]);
		expect(await readConnectionFile(r.file)).toMatchObject({ server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses: [svc.address] }, device: DEVICE, token: svc.token });
		expect(((await stat(r.file)).mode & 0o777).toString(8)).toBe("600");
		expect(JSON.stringify(card)).toContain("Connected to omp-cloud");
		const shown = JSON.stringify([card, r.host.notes, r.host.widgets]);
		expect(shown).not.toContain(svc.token);
		expect(shown).not.toContain("ompd_");
		expect(r.host.widgets.filter(w => Array.isArray(w))).toEqual([]);
	});

	test("the default device name is this machine's, and a port in an ssh:// target goes to both ssh calls", async () => {
		const svc = service();
		const ssh = sshd(ok(record(svc)));
		const r = await setup("ssh://me@nas.local:2222", {}, { ssh: ssh.run, env: {}, hostName: "my laptop" });
		await runConnect(r.input, r.deps);
		expect(ssh.pairs[0]?.argv).toEqual(pairArgv("ssh", { destination: "me@nas.local", port: 2222 }, "my laptop", process.platform));
		expect(ssh.configs[0]).toEqual(["ssh", "-G", "-p", "2222", "--", "me@nas.local"]);
	});

	test("the host name ssh resolves comes first with the reported port, then the server's addresses; the name is resolved once and verified by IP", async () => {
		const svc = service();
		const port = svc.address.split(":")[1];
		const resolved: string[] = [];
		const resolve = async (host: string): Promise<string[]> => {
			resolved.push(host);
			return host === "nas.lan" ? ["127.0.0.1"] : [];
		};
		const ssh = sshd(ok(record(svc)), "nas.lan");
		const r = await setup("nas", {}, { ssh: ssh.run, env: {}, resolve });
		await runConnect(r.input, r.deps);

		expect(resolved).toEqual(["nas.lan"]);
		expect((await readConnectionFile(r.file))?.server.addresses).toEqual([`nas.lan:${port}`, svc.address]);
	});

	test("a failing ssh -G is no reason to fail: the server's own addresses pair, and the problem is named only if nothing verifies", async () => {
		const svc = service();
		const r = await setup("me@nas", {}, { ssh: sshd(ok(record(svc)), "").run, env: {} });
		await runConnect(r.input, r.deps);
		expect((await readConnectionFile(r.file))?.server.addresses).toEqual([svc.address]);

		const dead = await setup("me@nas", {}, { ssh: sshd(ok(`${JSON.stringify(sshPairRecord(cert, "127.0.0.1:1", svc.token))}\n`), "").run, env: {} });
		const message = await failure(runConnect(dead.input, dead.deps));
		expect(message).toContain("ssh -G did not give a host name for me@nas");
		expect(message).toContain("127.0.0.1:1 did not answer");
	});

	test("a service that presents another certificate than ssh delivered is refused and receives no HTTP request; no file; the unused device is named, the token is not", async () => {
		const impostor = service(impostorCert);
		const claimed = service();
		const ssh = sshd(ok(`${JSON.stringify(sshPairRecord(cert, impostor.address, claimed.token))}\n`));
		const r = await setup("me@nas", { name: "laptop" }, { ssh: ssh.run, env: {} });
		const message = await failure(runConnect(r.input, r.deps));

		expect(message).toContain("presents a different certificate than the one ssh delivered");
		expect(message).toContain("nothing was sent");
		expect(message).toContain(`the device ${DEVICE.name} was created on the server and is not used`);
		expect(message).toContain(`/cloud devices revoke ${DEVICE.name}`);
		expect(message).not.toContain(claimed.token);
		expect(impostor.seen).toEqual([]);
		expect(claimed.seen).toEqual([]);
		expect(await readConnectionFile(r.file)).toBeUndefined();
	});

	test("with --replace a refused server does not revoke the old device; a verified one revokes it first and replaces the file", async () => {
		const old = service(impostorCert);
		const { file, connection } = await pairedFile(impostorCert, [old.address]);
		const impostor = service(impostorCert);
		const fresh = service();
		const host = fakeHost();
		const deps = { connectionFile: file, ui: host.host.ui, pollMs: 5, hostName: "laptop", env: {} };

		const refused = sshd(ok(`${JSON.stringify(sshPairRecord(cert, impostor.address, fresh.token))}\n`));
		await failure(runConnect({ target: "me@nas", name: "laptop", replace: true, allowPublic: false }, { ...deps, ssh: refused.run }));
		expect(old.seen).toEqual([]);
		expect(await readConnectionFile(file)).toEqual(connection);

		const accepted = sshd(ok(record(fresh)));
		await runConnect({ target: "me@nas", name: "laptop", replace: true, allowPublic: false }, { ...deps, ssh: accepted.run });
		expect(old.seen).toEqual([{ method: "DELETE", path: `/api/v1/devices/${connection.device.id}`, authorization: `Bearer ${connection.token}`, body: "" }]);
		expect(host.notes.map(n => n[0])).toContain("☁ revoked the old device laptop");
		expect((await readConnectionFile(file))?.token).toBe(fresh.token);
	});

	test("an existing connection needs --replace and ssh is never run", async () => {
		const old = service(impostorCert);
		const { file, connection } = await pairedFile(impostorCert, [old.address]);
		const fresh = service();
		const ssh = sshd(ok(record(fresh)));
		const host = fakeHost();
		const message = await failure(runConnect({ target: "me@nas", name: undefined, replace: false, allowPublic: false }, { connectionFile: file, ui: host.host.ui, ssh: ssh.run, env: {} }));

		expect(message).toContain("already connected");
		expect(message).toContain("--replace");
		expect(ssh.pairs).toEqual([]);
		expect(ssh.configs).toEqual([]);
		expect(await readConnectionFile(file)).toEqual(connection);
	});

	test("a host that is not local is refused without --allow-public before any certificate is read, and the unused device is named", async () => {
		const svc = service();
		const read: string[] = [];
		const readCertificate: ConnectDeps["readCertificate"] = async a => {
			read.push(a.text);
			throw new Error("must not be reached");
		};
		const resolve = async (): Promise<string[]> => ["93.184.216.34"];
		const ssh = sshd(ok(record(svc)), "nas.example.org");
		const r = await setup("me@nas.example.org", {}, { ssh: ssh.run, env: {}, readCertificate, resolve });
		const message = await failure(runConnect(r.input, r.deps));

		expect(message).toContain(`nas.example.org:${svc.address.split(":")[1]} is not a local address`);
		expect(message).toContain("--allow-public");
		expect(message).toContain("was created on the server and is not used");
		expect(read).toEqual([]);
		expect(svc.seen).toEqual([]);
	});

	test("ssh failures end the connect with their hint, before any address is contacted, and leave no file", async () => {
		const svc = service();
		for (const [out, hint] of [
			[ok("", { exitCode: 127, stderr: "sh: omp-cloud: not found" }), "install it there and run omp-cloud setup"],
			[ok("", { exitCode: 255, stderr: "me@nas: Permission denied (publickey)." }), "set up key-based ssh (ssh-copy-id me@nas)"],
			[ok("", { exitCode: 255, stderr: "Host key verification failed." }), "run ssh me@nas once to accept its host key, then retry"],
			[ok("", { exitCode: null, timedOut: true }), "timed out after 60 s"],
			[ok("Last login: never\n"), "did not answer with a pairing record"],
		] as const) {
			const r = await setup("me@nas", {}, { ssh: sshd(out).run, env: {} });
			expect(await failure(runConnect(r.input, r.deps))).toContain(hint);
			expect(await readConnectionFile(r.file)).toBeUndefined();
		}
		expect(svc.seen).toEqual([]);
	});

	test("a bad target or device name is refused before ssh runs", async () => {
		const ssh = sshd(ok(""));
		const dash = await setup("-oProxyCommand=evil", {}, { ssh: ssh.run, env: {} });
		expect(await failure(runConnect(dash.input, dash.deps))).toContain("cannot start with '-'");
		const named = await setup("me@nas", { name: "bad/name" }, { ssh: ssh.run, env: {} });
		expect(await failure(runConnect(named.input, named.deps))).toContain("device name");
		const junk = await setup("10.0.0.5:8443", {}, { ssh: ssh.run, env: {} });
		expect(await failure(runConnect(junk.input, junk.deps))).toContain("ssh://[user@]host[:port]");
		expect(ssh.pairs).toEqual([]);
		expect(ssh.configs).toEqual([]);
	});

	test("the abort signal reaches the ssh run, and a pairing code never runs ssh", async () => {
		const svc = service();
		const abort = new AbortController();
		const ssh = sshd(ok(record(svc)));
		const r = await setup("me@nas", {}, { ssh: ssh.run, env: {}, signal: abort.signal });
		await runConnect(r.input, r.deps);
		expect(ssh.pairs[0]?.signal).toBe(abort.signal);

		const coded = service();
		const never = sshd(ok(""));
		const c = await setup(pairingCode(cert, [coded.address]), {}, { ssh: never.run, env: {} });
		await runConnect(c.input, c.deps);
		expect(never.pairs).toEqual([]);
		expect(never.configs).toEqual([]);
	});
});
