/** What a pairing code says: the offer, its one-time secret, the certificate to expect and the addresses to try. */
export interface PairingCode {
	offerId: string;
	secret: string;
	/** As written in the code: unpadded base64url of SHA-256(certificate DER). */
	fingerprint: string;
	/** `host:port`, an IPv6 host in brackets. */
	addresses: string[];
}

const CODE_VERSION = "ompc1";

/** `ompc1:<offerId>:<secret>:<fingerprint>@<address>[,<address>…]`. */
export function formatPairingCode(code: PairingCode): string {
	return `${CODE_VERSION}:${code.offerId}:${code.secret}:${code.fingerprint}@${code.addresses.join(",")}`;
}

/**
 * The code in `text`: trimmed, one pair of surrounding quotes or backticks stripped, split at the first `@`; the left
 * side must be exactly `ompc1`, the offer id, the secret and the fingerprint, the right side one or more addresses.
 * Null for anything else.
 */
export function parsePairingCode(text: string): PairingCode | null {
	let trimmed = text.trim();
	const first = trimmed[0];
	if (trimmed.length >= 2 && (first === '"' || first === "'" || first === "`") && trimmed.endsWith(first)) {
		trimmed = trimmed.slice(1, -1);
	}
	const at = trimmed.indexOf("@");
	if (at < 0) return null;
	const left = trimmed.slice(0, at).split(":");
	if (left.length !== 4 || left[0] !== CODE_VERSION) return null;
	const [, offerId, secret, fingerprint] = left;
	if (!offerId || !secret || !fingerprint) return null;
	const addresses = trimmed.slice(at + 1).split(",");
	if (addresses.some(address => address === "")) return null;
	return { offerId, secret, fingerprint, addresses };
}

/** The 32 digest bytes of a fingerprint in either spelling (`SHA256:<base64>` or bare base64url), or null when it is neither. */
export function fingerprintBytes(text: string): Buffer | null {
	const bare = text.startsWith("SHA256:") ? text.slice("SHA256:".length) : text;
	if (!/^[A-Za-z0-9+/_-]{43}$/.test(bare)) return null;
	const bytes = Buffer.from(bare, "base64url");
	return bytes.length === 32 ? bytes : null;
}
