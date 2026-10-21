import { formatPairingCode } from "../pairing/code";
import { canonicalAddress } from "../pairing/cidr";
import type { SourceLimiter } from "../pairing/limiter";
import { parseDeviceName, parsePlatform } from "../pairing/names";
import { advertiseAddresses, type RemoteSettings } from "../pairing/remote";
import { newDeviceToken, randomBase64Url, sha256Hex } from "../pairing/secrets";
import type { Store } from "../store";
import type { Device, PairingOffer } from "../store/types";
import type { Caller } from "./auth";
import { readJsonObject } from "./body";
import { type DeviceAborts, requireActive } from "./devices";
import { ApiError } from "./errors";
import { CLAIM_PATH, DEVICES_PATH, OFFERS_PATH, REDEEM_PATH } from "./paths";

/** A public pairing body (`redeem`, `claim`): a few short strings. */
export const MAX_PUBLIC_BODY_BYTES = 2048;
/** The body of an offer request is `{}`. */
const MAX_OFFER_BODY_BYTES = 1024;
/** An offer lives this long. */
const OFFER_TTL_MS = 5 * 60_000;
/** Live offers an owner may have at once: a fourth cancels the oldest. */
const MAX_LIVE_OFFERS = 3;
/** What an id in a path looks like: base64url, as ours are. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const UNKNOWN_SOURCE = "unknown";

export interface PairingRoutesOptions {
	store: Store;
	/** Set when the config has a `remote` section; offers are refused without it. */
	remote?: RemoteSettings;
	limiter: SourceLimiter;
	aborts: DeviceAborts;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A body field that must be a string; ApiError 400 otherwise. */
function stringField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string") throw new ApiError(400, "invalid JSON body");
	return value;
}

/** An offer as `GET /api/v1/pairing/offers/{id}` shows it. */
function offerView(offer: PairingOffer): Record<string, unknown> {
	return { id: offer.id, status: offer.status, expiresAt: offer.expiresAt, request: offer.request, device: offer.device };
}

function deviceView(device: Device, current: boolean): Record<string, unknown> {
	return {
		id: device.id,
		name: device.name,
		platform: device.platform,
		createdAt: device.createdAt,
		pairedFrom: device.pairedFrom,
		lastSeenAt: device.lastSeenAt,
		lastSeenAddress: device.lastSeenAddress,
		current,
	};
}

/**
 * The pairing routes: the two public ones a device calls before it has a token (`handlePublic`, answered
 * before authentication by design), the owner's offer routes and the device routes (`handle`, after authentication and
 * the scope check).
 */
export class PairingRoutes {
	constructor(private readonly options: PairingRoutesOptions) {}

	/** Whether `method` and `pathname` name one of the public routes, which are answered before any authentication. */
	isPublic(method: string, pathname: string): boolean {
		return method === "POST" && (pathname === REDEEM_PATH || pathname === CLAIM_PATH);
	}

	/**
	 * `redeem` or `claim` for a caller at `address`. Every failure to prove the secret is the same 401 per route and counts
	 * against the source; a source with too many recent failures gets 429 before its body is read.
	 */
	async handlePublic(req: Request, pathname: string, address: string | null): Promise<Response> {
		const source = address === null ? UNKNOWN_SOURCE : canonicalAddress(address);
		const { limiter } = this.options;
		if (limiter.blocked(source)) {
			return json(429, { error: "too many attempts; try again later" }, { "Retry-After": String(limiter.retryAfterSeconds(source)) });
		}
		const body = await readJsonObject(req, MAX_PUBLIC_BODY_BYTES);
		if (pathname === REDEEM_PATH) return this.#redeem(body, source);
		return this.#claim(body, source);
	}

	#redeem(body: Record<string, unknown>, source: string): Response {
		const offerId = stringField(body, "offer");
		const secret = stringField(body, "secret");
		const name = parseDeviceName(stringField(body, "name"));
		if (name === null) throw new ApiError(400, "invalid device name");
		const platform = parsePlatform(stringField(body, "platform"));
		if (platform === null) throw new ApiError(400, "invalid platform");
		const requestId = randomBase64Url(9);
		const requestSecret = randomBase64Url(16);
		const outcome = this.options.store.redeemOffer({
			offerId,
			secretSha256: sha256Hex(secret),
			requestId,
			requestSecretSha256: sha256Hex(requestSecret),
			name,
			platform,
			address: source,
		});
		if (outcome.kind === "rejected") {
			this.options.limiter.fail(source);
			return json(401, { error: "invalid or expired pairing code" });
		}
		return json(202, { request: requestId, requestSecret, expiresAt: outcome.expiresAt });
	}

	#claim(body: Record<string, unknown>, source: string): Response {
		const requestId = stringField(body, "request");
		const requestSecret = stringField(body, "requestSecret");
		// Minted before the store decides, so that the token exists only in this response; the store keeps its hash and uses it just when it creates the device.
		const token = newDeviceToken();
		const outcome = this.options.store.claimOffer(requestId, sha256Hex(requestSecret), {
			id: randomBase64Url(9),
			tokenSha256: sha256Hex(token),
		});
		switch (outcome.kind) {
			case "pending":
				return json(202, { status: "pending" });
			case "created":
				return json(201, { device: outcome.device, token });
			case "declined":
				return json(403, { error: "the owner declined this device" });
			case "rejected":
				this.options.limiter.fail(source);
				return json(401, { error: "invalid or expired pairing request" });
		}
	}

	/** The offer and device routes for an authorized `caller`, or null when `pathname` is none of them. */
	async handle(caller: Caller, req: Request, pathname: string): Promise<Response | null> {
		if (pathname === OFFERS_PATH || pathname.startsWith(`${OFFERS_PATH}/`)) {
			return this.#offers(caller, req, pathname.slice(OFFERS_PATH.length).split("/").slice(1), pathname === OFFERS_PATH);
		}
		if (pathname === DEVICES_PATH) return req.method === "GET" ? this.#listDevices(caller) : null;
		if (pathname.startsWith(`${DEVICES_PATH}/`)) {
			const id = pathname.slice(DEVICES_PATH.length + 1);
			return req.method === "DELETE" && ID_PATTERN.test(id) ? this.#revoke(caller, id, req.signal) : null;
		}
		return null;
	}

	async #offers(caller: Caller, req: Request, segments: string[], collection: boolean): Promise<Response | null> {
		if (collection) return req.method === "POST" ? this.#createOffer(caller, req) : null;
		const [id, action, ...rest] = segments;
		if (id === undefined || !ID_PATTERN.test(id) || rest.length > 0) return null;
		if (action === undefined) {
			if (req.method === "GET") return json(200, offerView(this.#ownedOffer(caller, id)));
			if (req.method !== "DELETE") return null;
			this.#ownedOffer(caller, id);
			this.options.store.cancelOffer(id);
			return new Response(null, { status: 204 });
		}
		if (req.method !== "POST" || (action !== "approve" && action !== "decline")) return null;
		this.#ownedOffer(caller, id);
		const decision = this.options.store.decideOffer(id, action);
		if (decision === "not_found") throw new ApiError(404, "not found");
		if (decision === "not_waiting") throw new ApiError(409, "this pairing is not waiting for approval");
		return new Response(null, { status: 204 });
	}

	/** The offer `id` of `caller`'s owner; ApiError 404 when there is none. */
	#ownedOffer(caller: Caller, id: string): PairingOffer {
		const offer = this.options.store.offer(id);
		if (offer === null || offer.owner !== caller.principal) throw new ApiError(404, "not found");
		return offer;
	}

	async #createOffer(caller: Caller, req: Request): Promise<Response> {
		const { remote, store } = this.options;
		if (remote === undefined) throw new ApiError(404, "remote access is not configured");
		await readJsonObject(req, MAX_OFFER_BODY_BYTES, true);
		const id = randomBase64Url(9);
		const secret = randomBase64Url(16);
		const offer = store.createOffer({
			id,
			owner: caller.principal,
			secretSha256: sha256Hex(secret),
			ttlMs: OFFER_TTL_MS,
			maxOpen: MAX_LIVE_OFFERS,
		});
		const addresses = advertiseAddresses(remote);
		const code = formatPairingCode({ offerId: id, secret, fingerprint: remote.fingerprintCode, addresses });
		return json(201, { id, code, expiresAt: offer.expiresAt, fingerprint: remote.fingerprint, addresses });
	}

	#listDevices(caller: Caller): Response {
		const devices = this.options.store
			.devices(caller.principal)
			.filter(device => caller.device === null || device.id === caller.device.id);
		return json(200, { devices: devices.map(device => deviceView(device, device.id === caller.device?.id)) });
	}

	#revoke(caller: Caller, id: string, signal: AbortSignal): Response {
		requireActive(this.options.store, caller, signal);
		const revoked = this.options.store.revokeDevice(id, caller.principal);
		if (revoked === null) throw new ApiError(404, "not found");
		this.options.aborts.revoke(id);
		return json(200, { device: { id: revoked.device.id, name: revoked.device.name }, runningThreads: revoked.runningThreads });
	}
}
