import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity } from "./identity";
import { type GeneratedIdentity, generateIdentity } from "./test-support";

let dir: string;
let files: GeneratedIdentity;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-identity-"));
	files = await generateIdentity(dir);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("loadIdentity", () => {
	test("loads the certificate and key and fingerprints the DER the way ssh-keygen does", async () => {
		const identity = await loadIdentity(files);
		const der = new X509Certificate(identity.cert).raw;
		const digest = createHash("sha256").update(der).digest();
		expect(identity.fingerprint).toBe(`SHA256:${digest.toString("base64").replace(/=+$/, "")}`);
		expect(identity.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
		expect(identity.fingerprintCode).toBe(digest.toString("base64url"));
		expect(identity.key).toContain("PRIVATE KEY");
	});

	test.skipIf(process.platform === "win32")("refuses a key file that group or other can read", async () => {
		await chmod(files.keyFile, 0o644);
		await expect(loadIdentity(files)).rejects.toThrow(
			`remote.keyFile ${files.keyFile} must be readable only by its owner (chmod 600, its directory chmod 700)`,
		);
		await chmod(files.keyFile, 0o640);
		await expect(loadIdentity(files)).rejects.toThrow("must be readable only by its owner");
		await chmod(files.keyFile, 0o604);
		await expect(loadIdentity(files)).rejects.toThrow("must be readable only by its owner");
	});

	test.skipIf(process.platform === "win32")("refuses a key whose directory group or other can enter", async () => {
		await chmod(files.dir, 0o755);
		await expect(loadIdentity(files)).rejects.toThrow("must be readable only by its owner (chmod 600, its directory chmod 700)");
		await chmod(files.dir, 0o710);
		await expect(loadIdentity(files)).rejects.toThrow("must be readable only by its owner");
	});

	test("accepts 0400 for the key", async () => {
		await chmod(files.keyFile, 0o400);
		await expect(loadIdentity(files)).resolves.toBeDefined();
	});

	test("refuses a certificate file with two certificates", async () => {
		const pem = await Bun.file(files.certFile).text();
		await writeFile(files.certFile, pem + pem);
		await expect(loadIdentity(files)).rejects.toThrow("must hold exactly one CERTIFICATE block (found 2)");
	});

	test("refuses a certificate file with none", async () => {
		await writeFile(files.certFile, "not a certificate\n");
		await expect(loadIdentity(files)).rejects.toThrow("must hold exactly one CERTIFICATE block (found 0)");
	});

	test("refuses a block that is not a certificate", async () => {
		await writeFile(files.certFile, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
		await expect(loadIdentity(files)).rejects.toThrow("does not hold a valid certificate");
	});

	test("refuses a key that belongs to another certificate, without printing either", async () => {
		const other = await generateIdentity(join(dir, "other"));
		const error = await loadIdentity({ certFile: files.certFile, keyFile: other.keyFile }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("is not the private key of");
		expect(message).not.toContain("PRIVATE KEY");
		expect(message).not.toContain("BEGIN");
	});

	test("a missing file names the file and the error code only", async () => {
		await expect(loadIdentity({ certFile: join(dir, "nope.pem"), keyFile: files.keyFile })).rejects.toThrow(`cannot read remote.certFile ${join(dir, "nope.pem")}: ENOENT`);
		await expect(loadIdentity({ certFile: files.certFile, keyFile: join(files.dir, "nope.pem") })).rejects.toThrow("cannot read remote.keyFile");
	});
});
