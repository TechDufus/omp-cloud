/**
 * The TLS identity the remote listener serves and each paired device pins: a self-signed P-256 certificate valid for 100
 * years, generated once in-process (no openssl) and never regenerated, because replacing it unpairs every device.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadIdentity } from "../pairing/identity";
import { writeFileAtomic } from "./config";
import type { StepResult } from "./steps";

const YEARS = 100;
const SIGNING = { name: "ECDSA", hash: "SHA-256" } as const;

/** PEM text of DER `bytes` under `label`, 64 characters per line. */
function pem(label: string, bytes: ArrayBuffer): string {
	const body = Buffer.from(bytes).toString("base64").replace(/(.{64})/g, "$1\n");
	return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}

/** A fresh key and certificate (both PEM) for `CN=omp-cloud <hostname>`. */
export async function generateIdentity(hostname: string, now: Date = new Date()): Promise<{ keyPem: string; certPem: string }> {
	// The polyfill must be evaluated before tsyringe, which @peculiar/x509 builds on, loads. Static imports do not guarantee that
	// order in a `bun build --compile` bundle (the release binary failed on it), so both load here, in order.
	await import("reflect-metadata");
	const x509 = await import("@peculiar/x509");
	const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const notAfter = new Date(now);
	notAfter.setUTCFullYear(notAfter.getUTCFullYear() + YEARS);
	// A positive serial: the top bit of the first byte is cleared.
	const serial = randomBytes(16);
	serial[0] = (serial[0] ?? 0) & 0x7f;
	const certificate = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: serial.toString("hex"),
		name: `CN=omp-cloud ${hostname}`,
		notBefore: now,
		notAfter,
		signingAlgorithm: SIGNING,
		keys,
		extensions: [
			new x509.BasicConstraintsExtension(true, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyCertSign, true),
			await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false),
		],
	});
	return {
		keyPem: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
		certPem: certificate.toString("pem"),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * `<dir>/key.pem` (0600) and `cert.pem` in a 0700 directory. Neither there: generated. Both there: kept, modes
 * repaired. One of the two: refused, since a new pair would unpair every device pinned to the old certificate. Either
 * way the pair must pass the service's own check (`loadIdentity`).
 */
export async function ensureTls(dir: string, hostname: string): Promise<StepResult> {
	const keyFile = join(dir, "key.pem");
	const certFile = join(dir, "cert.pem");
	const [hasKey, hasCert] = await Promise.all([exists(keyFile), exists(certFile)]);
	let generated = false;
	if (hasKey !== hasCert) {
		return {
			id: "tls",
			status: "failed",
			detail: `${dir} holds only one of key.pem and cert.pem`,
			fix: `restore the pair, or remove both (devices pinned to the old certificate must then pair again): rm -f ${keyFile} ${certFile}`,
		};
	}
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	if (!hasKey) {
		const identity = await generateIdentity(hostname);
		await writeFileAtomic(keyFile, identity.keyPem, 0o600);
		await writeFileAtomic(certFile, identity.certPem, 0o644);
		generated = true;
	}
	await chmod(keyFile, 0o600);
	try {
		const identity = await loadIdentity({ certFile, keyFile });
		return { id: "tls", status: generated ? "changed" : "ok", detail: `${generated ? "generated " : ""}${dir} (${identity.fingerprint})` };
	} catch (error) {
		return {
			id: "tls",
			status: "failed",
			detail: error instanceof Error ? error.message : String(error),
			fix: `restore a matching key.pem and cert.pem in ${dir}, or remove both and run omp-cloud setup again (devices must then pair again)`,
		};
	}
}
