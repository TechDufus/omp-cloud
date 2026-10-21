import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity } from "../pairing/identity";
import { ensureTls, generateIdentity } from "./tls";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-tls-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("generateIdentity", () => {
	test("makes a P-256 certificate for CN=omp-cloud <hostname>, valid for 100 years", async () => {
		const now = new Date("2026-10-21T00:00:00Z");
		const { certPem, keyPem } = await generateIdentity("build-host", now);
		const cert = new X509Certificate(certPem);
		expect(cert.subject).toBe("CN=omp-cloud build-host");
		expect(cert.publicKey.asymmetricKeyType).toBe("ec");
		expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
		expect(new Date(cert.validFrom).getUTCFullYear()).toBe(2026);
		expect(new Date(cert.validTo).getUTCFullYear()).toBe(2126);
		expect(cert.verify(cert.publicKey)).toBe(true);
		expect(keyPem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
	});
});

describe("ensureTls", () => {
	test("generates a pair the service's own identity check accepts, with the right modes", async () => {
		const tls = join(dir, "tls");
		const step = await ensureTls(tls, "build-host");
		expect(step.status).toBe("changed");
		expect(step.detail).toMatch(/SHA256:/);
		expect((await stat(tls)).mode & 0o777).toBe(0o700);
		expect((await stat(join(tls, "key.pem"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(tls, "cert.pem"))).mode & 0o777).toBe(0o644);
		const identity = await loadIdentity({ certFile: join(tls, "cert.pem"), keyFile: join(tls, "key.pem") });
		expect(step.detail).toContain(identity.fingerprint);
	});

	test("never regenerates: a second run keeps both files byte for byte and repairs modes", async () => {
		const tls = join(dir, "tls");
		await ensureTls(tls, "build-host");
		const before = [await readFile(join(tls, "key.pem"), "utf8"), await readFile(join(tls, "cert.pem"), "utf8")];
		await Bun.$`chmod 644 ${join(tls, "key.pem")}`;
		const step = await ensureTls(tls, "another-name");
		expect(step.status).toBe("ok");
		expect([await readFile(join(tls, "key.pem"), "utf8"), await readFile(join(tls, "cert.pem"), "utf8")]).toEqual(before);
		expect((await stat(join(tls, "key.pem"))).mode & 0o777).toBe(0o600);
	});

	test("only one of the two files is refused and nothing is written", async () => {
		const tls = join(dir, "tls");
		await Bun.write(join(tls, "cert.pem"), "x");
		const step = await ensureTls(tls, "build-host");
		expect(step.status).toBe("failed");
		expect(step.detail).toContain("only one of key.pem and cert.pem");
		expect(step.fix).toContain("pair");
		expect(await Bun.file(join(tls, "key.pem")).exists()).toBe(false);
	});

	test("a pair that does not match is reported, not replaced", async () => {
		const tls = join(dir, "tls");
		await ensureTls(tls, "build-host");
		await writeFile(join(tls, "key.pem"), (await generateIdentity("other")).keyPem, { mode: 0o600 });
		const step = await ensureTls(tls, "build-host");
		expect(step.status).toBe("failed");
		expect(step.detail).toContain("is not the private key");
	});
});
