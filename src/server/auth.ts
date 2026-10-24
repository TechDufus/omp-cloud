import { createHash, timingSafeEqual } from "node:crypto";
import { DEVICE_TOKEN_PREFIX, sha256Hex } from "../pairing/secrets";
import type { Store } from "../store";
import { type DeviceAccess, deviceActor } from "../store/types";

/** The principal of the one API token (v1 has one user, the owner). */
export const OWNER = "owner";

/** Who is calling: the owner's token, or a paired device that acts for the owner. `principal` owns threads either way. */
export type Caller =
	| { kind: "owner"; principal: "owner"; device: null }
	| { kind: "device"; principal: "owner"; device: { id: string; name: string; access: DeviceAccess } };

/** The owner token's caller: also what a dashboard session is. */
export const OWNER_CALLER: Caller = { kind: "owner", principal: OWNER, device: null };

/** Whether `caller` may do everything the owner token can: the owner token itself, or a device with full access. */
export function hasFullAccess(caller: Caller): boolean {
	return caller.device === null || caller.device.access === "full";
}

/** What a turn, a stop or an answer records of the caller: `owner`, or `device:<id>`. */
export function actorOf(caller: Caller): string {
	return caller.device === null ? caller.principal : deviceActor(caller.device.id);
}

/** Lowercase hex SHA-256 of a token: the form the config stores. */
export function tokenSha256(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Whether the SHA-256 of `token` equals `expectedSha256`, compared in constant time over the 32-byte digests. */
export function tokenMatches(token: string, expectedSha256: string): boolean {
	const expected = Buffer.from(expectedSha256, "hex");
	const actual = createHash("sha256").update(token, "utf8").digest();
	if (expected.length !== actual.length) return false;
	return timingSafeEqual(actual, expected);
}

/** The token of `Authorization: Bearer <token>` (scheme case-insensitive), or null when there is none. */
export function bearerToken(req: Request): string | null {
	const header = req.headers.get("authorization");
	if (header === null) return null;
	const match = /^(\S+)[ \t]+(.*)$/s.exec(header.trim());
	if (!match || match[1]?.toLowerCase() !== "bearer") return null;
	const token = (match[2] ?? "").trim();
	return token === "" ? null : token;
}

/** What `authenticate` consults. */
export interface AuthOptions {
	/** Config.apiTokenSha256 */
	apiTokenSha256: string;
	store: Pick<Store, "deviceByTokenSha256">;
	/** True on the remote listener: only device tokens count there, the owner token is as good as unknown. */
	deviceOnly: boolean;
}

/**
 * The caller of a request, or null. A device token (`ompd_…`) is looked up in the store on every request, so a revoked or
 * unknown one never passes; any other bearer token must be the owner token, which the remote listener does not accept.
 */
export function authenticate(req: Request, options: AuthOptions): Caller | null {
	const token = bearerToken(req);
	if (token === null) return null;
	if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
		const device = options.store.deviceByTokenSha256(sha256Hex(token));
		return device === null
			? null
			: { kind: "device", principal: OWNER, device: { id: device.id, name: device.name, access: device.access } };
	}
	if (options.deviceOnly) return null;
	return tokenMatches(token, options.apiTokenSha256) ? OWNER_CALLER : null;
}
