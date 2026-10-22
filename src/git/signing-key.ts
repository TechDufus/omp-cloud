import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSigningKey, sshFingerprint, sshPublicKey } from "./sshsig";

/** Why a signing-key operation failed; `exists`: `create()` found a key already there. */
export class SigningKeyError extends Error {
	override name = "SigningKeyError";
	constructor(
		readonly kind: "exists" | "mode",
		message: string,
	) {
		super(message);
	}
}

/**
 * The service's SSH signing key: one Ed25519 key in `<dataDir>/signing/ed25519.pem` (directory 0700, file 0600). It
 * signs the commits a thread makes (`git.sign`); the owner registers its public half on GitHub as a Signing Key.
 * Every method is synchronous: the file is one small PEM.
 */
export class SigningKey {
	readonly #dir: string;
	readonly #path: string;

	private constructor(dataDir: string) {
		this.#dir = join(dataDir, "signing");
		this.#path = join(this.#dir, "ed25519.pem");
	}

	/** Throws SigningKeyError(mode) when a key file exists with group or other permission bits. */
	static open(dataDir: string): SigningKey {
		const key = new SigningKey(dataDir);
		if (key.exists()) key.#checkMode();
		return key;
	}

	exists(): boolean {
		return existsSync(this.#path);
	}

	/** Makes the key and returns its public half; throws SigningKeyError(exists) when there is one already. */
	create(): { publicKey: string; fingerprint: string } {
		if (this.exists()) throw new SigningKeyError("exists", "a signing key exists; delete it to replace it");
		mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
		chmodSync(this.#dir, 0o700);
		const { privatePem } = generateSigningKey();
		const temp = `${this.#path}.${process.pid}.tmp`;
		try {
			writeFileSync(temp, privatePem, { mode: 0o600 });
			renameSync(temp, this.#path);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
		const publicKey = sshPublicKey(privatePem);
		return { publicKey, fingerprint: sshFingerprint(publicKey) };
	}

	remove(): void {
		rmSync(this.#path, { force: true });
	}

	/** The private key (PKCS#8 PEM), or null when there is none. */
	privatePem(): string | null {
		if (!this.exists()) return null;
		this.#checkMode();
		return readFileSync(this.#path, "utf8");
	}

	/** The `ssh-ed25519 <base64> omp-cloud` line, or null when there is no key. */
	publicKey(): string | null {
		const pem = this.privatePem();
		return pem === null ? null : sshPublicKey(pem);
	}

	fingerprint(): string | null {
		const publicKey = this.publicKey();
		return publicKey === null ? null : sshFingerprint(publicKey);
	}

	/** When the key was made (the file's mtime, ISO), or null when there is none. */
	createdAt(): string | null {
		return this.exists() ? statSync(this.#path).mtime.toISOString() : null;
	}

	#checkMode(): void {
		if ((statSync(this.#path).mode & 0o077) !== 0) throw new SigningKeyError("mode", `the signing key ${this.#path} must be mode 0600`);
	}
}
