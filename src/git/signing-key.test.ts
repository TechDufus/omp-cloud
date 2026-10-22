import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SigningKey, SigningKeyError } from "./signing-key";
import { sshFingerprint, sshSign } from "./sshsig";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "signing-key-"));
});
afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("SigningKey", () => {
	test("a fresh data directory has no key", () => {
		const key = SigningKey.open(dataDir);
		expect(key.exists()).toBe(false);
		expect(key.privatePem()).toBeNull();
		expect(key.publicKey()).toBeNull();
		expect(key.fingerprint()).toBeNull();
		expect(key.createdAt()).toBeNull();
	});

	test("create writes a 0600 file in a 0700 directory and returns the public half", () => {
		const key = SigningKey.open(dataDir);
		const made = key.create();
		expect(made.publicKey).toMatch(/^ssh-ed25519 \S+ omp-cloud$/);
		expect(made.fingerprint).toBe(sshFingerprint(made.publicKey));
		expect(statSync(join(dataDir, "signing", "ed25519.pem")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dataDir, "signing")).mode & 0o777).toBe(0o700);
		expect(key.publicKey()).toBe(made.publicKey);
		expect(key.fingerprint()).toBe(made.fingerprint);
		expect(Date.parse(key.createdAt() ?? "")).toBeGreaterThan(Date.now() - 60_000);
		expect(sshSign(new Uint8Array([1]), key.privatePem() ?? "")).toContain("BEGIN SSH SIGNATURE");
	});

	test("a second create is refused with kind exists and keeps the key", () => {
		const key = SigningKey.open(dataDir);
		const made = key.create();
		const error = (() => {
			try {
				key.create();
				return null;
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(SigningKeyError);
		expect((error as SigningKeyError).kind).toBe("exists");
		expect(key.publicKey()).toBe(made.publicKey);
	});

	test("a reopened key is the same key, and remove deletes it so create works again", () => {
		const made = SigningKey.open(dataDir).create();
		const reopened = SigningKey.open(dataDir);
		expect(reopened.publicKey()).toBe(made.publicKey);
		reopened.remove();
		expect(reopened.exists()).toBe(false);
		reopened.remove();
		expect(reopened.create().publicKey).not.toBe(made.publicKey);
	});

	test("a key file readable by group or other is refused", () => {
		SigningKey.open(dataDir).create();
		const path = join(dataDir, "signing", "ed25519.pem");
		const pem = readFileSync(path, "utf8");
		chmodSync(path, 0o640);
		expect(() => SigningKey.open(dataDir)).toThrow(`the signing key ${path} must be mode 0600`);
		chmodSync(path, 0o600);
		expect(SigningKey.open(dataDir).privatePem()).toBe(pem);
	});
});
