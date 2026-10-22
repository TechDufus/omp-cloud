/**
 * SSH signatures (PROTOCOL.sshsig v1, hash sha512) with an Ed25519 key, made with `node:crypto` alone: setup does not
 * install `ssh-keygen`. Git accepts the armored output as a `gpgsig` commit header when `gpg.format` is `ssh`.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

const KEY_TYPE = "ssh-ed25519";
const MAGIC = Buffer.from("SSHSIG", "latin1");
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
const ARMOR_COLUMNS = 70;

/** SSH wire `string`: a big-endian uint32 length, then the bytes. */
function wireString(data: Uint8Array | string): Buffer {
	const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
}

/** The key blob of an Ed25519 private key: `string("ssh-ed25519") ‖ string(raw public key)`. */
function publicBlob(privatePem: string): Buffer {
	const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: "jwk" });
	if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("the signing key is not an Ed25519 key");
	return Buffer.concat([wireString(KEY_TYPE), wireString(Buffer.from(jwk.x, "base64url"))]);
}

/** A new Ed25519 key as PKCS#8 PEM. */
export function generateSigningKey(): { privatePem: string } {
	const { privateKey } = generateKeyPairSync("ed25519");
	return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** The `ssh-ed25519 <base64> <comment>` line of the key's public half, the form GitHub's Signing Key page takes. */
export function sshPublicKey(privatePem: string, comment = "omp-cloud"): string {
	return `${KEY_TYPE} ${publicBlob(privatePem).toString("base64")} ${comment}`;
}

/** `SHA256:<unpadded base64>` of an `ssh-ed25519 <base64> …` public key's blob, as `ssh-keygen -l` prints it. */
export function sshFingerprint(publicKey: string): string {
	const blob = publicKey.trim().split(/\s+/)[1];
	if (blob === undefined) throw new Error("not an SSH public key");
	return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** The armored SSH signature of `message` under `namespace` (`git` for commits). */
export function sshSign(message: Uint8Array, privatePem: string, namespace = "git"): string {
	const blob = publicBlob(privatePem);
	const digest = createHash("sha512").update(message).digest();
	const signed = Buffer.concat([MAGIC, wireString(namespace), wireString(""), wireString("sha512"), wireString(digest)]);
	const signature = sign(null, signed, createPrivateKey(privatePem));
	const version = Buffer.alloc(4);
	version.writeUInt32BE(1);
	const body = Buffer.concat([
		MAGIC,
		version,
		wireString(blob),
		wireString(namespace),
		wireString(""),
		wireString("sha512"),
		wireString(Buffer.concat([wireString(KEY_TYPE), wireString(signature)])),
	]).toString("base64");
	const lines: string[] = [ARMOR_BEGIN];
	for (let at = 0; at < body.length; at += ARMOR_COLUMNS) lines.push(body.slice(at, at + ARMOR_COLUMNS));
	lines.push(ARMOR_END);
	return lines.join("\n");
}
