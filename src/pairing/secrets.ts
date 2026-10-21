import { createHash, timingSafeEqual } from "node:crypto";

/** What every device token starts with. */
export const DEVICE_TOKEN_PREFIX = "ompd_";

/** `bytes` random bytes as unpadded base64url. */
export function randomBase64Url(bytes: number): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** A fresh device token: `ompd_` and 32 random bytes as base64url. */
export function newDeviceToken(): string {
	return DEVICE_TOKEN_PREFIX + randomBase64Url(32);
}

/** Lowercase hex SHA-256 of `text` as UTF-8: the form the store keeps tokens and secrets in. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Whether two lowercase hex SHA-256 digests are equal, compared in constant time; a value that is not 32 bytes of hex never matches. */
export function hashesEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	if (left.length !== 32 || right.length !== 32) return false;
	return timingSafeEqual(left, right);
}
