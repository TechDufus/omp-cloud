import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

/** The service's TLS identity: the PEM material `Bun.serve` takes and the two spellings of the certificate's fingerprint. */
export interface Identity {
	/** PEM, one certificate. */
	cert: string;
	/** PEM private key. Never logged. */
	key: string;
	/** `SHA256:` and the standard base64 of SHA-256(certificate DER) without padding, as `ssh-keygen -l` prints it. */
	fingerprint: string;
	/** The same 32 bytes as unpadded base64url: what a pairing code carries. */
	fingerprintCode: string;
}

/** The files an identity is loaded from. */
export interface IdentityFiles {
	certFile: string;
	keyFile: string;
}

/** Fingerprints of SHA-256 digest `digest`, in the display and the code spelling. */
export function fingerprintsOf(digest: Buffer): Pick<Identity, "fingerprint" | "fingerprintCode"> {
	return {
		fingerprint: `SHA256:${digest.toString("base64").replace(/=+$/, "")}`,
		fingerprintCode: digest.toString("base64url"),
	};
}

async function readText(path: string, label: string): Promise<string> {
	try {
		return await Bun.file(path).text();
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
		throw new Error(`cannot read ${label} ${path}: ${code}`);
	}
}

/** POSIX only: mode bits mean nothing on Windows, where this check is skipped. */
async function requirePrivateKey(keyFile: string): Promise<void> {
	if (process.platform === "win32") return;
	const refusal = `remote.keyFile ${keyFile} must be readable only by its owner (chmod 600, its directory chmod 700)`;
	let keyMode: number;
	let directoryMode: number;
	try {
		keyMode = (await stat(keyFile)).mode;
		directoryMode = (await stat(dirname(keyFile))).mode;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
		throw new Error(`cannot read remote.keyFile ${keyFile}: ${code}`);
	}
	if ((keyMode & 0o077) !== 0 || (directoryMode & 0o077) !== 0) throw new Error(refusal);
}

/**
 * Loads and checks the TLS identity: the key file and its directory must not be accessible to group or other (POSIX),
 * the certificate file must hold exactly one `CERTIFICATE` PEM block, and the key must belong to that certificate.
 * Errors name files, never their contents.
 */
export async function loadIdentity(files: IdentityFiles): Promise<Identity> {
	await requirePrivateKey(files.keyFile);
	const cert = await readText(files.certFile, "remote.certFile");
	const key = await readText(files.keyFile, "remote.keyFile");
	const blocks = cert.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
	if (blocks !== 1) throw new Error(`remote.certFile ${files.certFile} must hold exactly one CERTIFICATE block (found ${blocks})`);
	let x509: X509Certificate;
	try {
		x509 = new X509Certificate(cert);
	} catch {
		throw new Error(`remote.certFile ${files.certFile} does not hold a valid certificate`);
	}
	try {
		if (!x509.checkPrivateKey(createPrivateKey(key))) throw new Error("mismatch");
	} catch {
		throw new Error(`remote.keyFile ${files.keyFile} is not the private key of remote.certFile ${files.certFile}`);
	}
	return { cert, key, ...fingerprintsOf(createHash("sha256").update(x509.raw).digest()) };
}
