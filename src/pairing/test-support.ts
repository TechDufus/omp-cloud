import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "../store";
import { newDeviceToken, randomBase64Url, sha256Hex } from "./secrets";

/** What `pairDevice` takes; everything has a default. */
export interface PairDeviceOptions {
	owner?: string;
	name?: string;
	platform?: string;
	address?: string;
	/** The device token; a fresh one by default. */
	token?: string;
}

/** A device paired through the store's own offer, redeem, approve and claim steps. */
export interface PairedDevice {
	id: string;
	name: string;
	token: string;
}

/** Pairs a device in `store` and returns it with its token. */
export function pairDevice(store: Store, options: PairDeviceOptions = {}): PairedDevice {
	const owner = options.owner ?? "owner";
	const token = options.token ?? newDeviceToken();
	const offerId = randomBase64Url(9);
	const secret = randomBase64Url(16);
	const requestId = randomBase64Url(9);
	const requestSecret = randomBase64Url(16);
	store.createOffer({ id: offerId, owner, secretSha256: sha256Hex(secret), ttlMs: 300_000, maxOpen: 3 });
	const redeemed = store.redeemOffer({
		offerId,
		secretSha256: sha256Hex(secret),
		requestId,
		requestSecretSha256: sha256Hex(requestSecret),
		name: options.name ?? "test device",
		platform: options.platform ?? "linux",
		address: options.address ?? "10.0.0.9",
	});
	if (redeemed.kind !== "ok") throw new Error("pairDevice: redeem failed");
	if (store.decideOffer(offerId, "approve") !== "done") throw new Error("pairDevice: approve failed");
	const claimed = store.claimOffer(requestId, sha256Hex(requestSecret), { id: randomBase64Url(9), tokenSha256: sha256Hex(token) });
	if (claimed.kind !== "created") throw new Error("pairDevice: claim failed");
	return { id: claimed.device.id, name: claimed.device.name, token };
}

/** The files `generateIdentity` wrote. */
export interface GeneratedIdentity {
	/** The 0700 directory holding both files. */
	dir: string;
	certFile: string;
	keyFile: string;
}

/** A self-signed EC P-256 certificate and key written by `openssl` into a new 0700 directory `<dir>/tls`, the key 0600. */
export async function generateIdentity(dir: string): Promise<GeneratedIdentity> {
	const tlsDir = join(dir, "tls");
	await mkdir(tlsDir, { recursive: true, mode: 0o700 });
	await chmod(tlsDir, 0o700);
	const certFile = join(tlsDir, "cert.pem");
	const keyFile = join(tlsDir, "key.pem");
	const proc = Bun.spawn(
		[
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-nodes",
			"-keyout",
			keyFile,
			"-out",
			certFile,
			"-days",
			"3650",
			"-subj",
			"/CN=omp-cloud-test",
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	if ((await proc.exited) !== 0) throw new Error(`openssl failed: ${await new Response(proc.stderr).text()}`);
	await chmod(keyFile, 0o600);
	return { dir: tlsDir, certFile, keyFile };
}
