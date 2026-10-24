import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../pairing/secrets";
import type { Device } from "../store/types";
import { actorOf, authenticate, type AuthOptions, bearerToken, hasFullAccess, OWNER, OWNER_CALLER, tokenSha256 } from "./auth";

const TOKEN = "s3cret-token";
const HASH = tokenSha256(TOKEN);
const DEVICE_TOKEN = "ompd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const DEVICE: Device = {
	id: "dev123456789",
	owner: OWNER,
	name: "laptop",
	platform: "linux",
	createdAt: "2026-01-01T00:00:00.000Z",
	pairedFrom: "10.0.0.5",
	lastSeenAt: null,
	lastSeenAddress: null,
	revokedAt: null,
	access: "threads",
};

/** A store that knows `DEVICE_TOKEN`'s device only; `lookups` records the hashes it was asked for. */
function options(over: Partial<AuthOptions> = {}, lookups: string[] = []): AuthOptions {
	return {
		apiTokenSha256: HASH,
		deviceOnly: false,
		store: {
			deviceByTokenSha256: (hash: string) => {
				lookups.push(hash);
				return hash === sha256Hex(DEVICE_TOKEN) ? DEVICE : null;
			},
		},
		...over,
	};
}

function request(authorization?: string): Request {
	return new Request("http://127.0.0.1/api", authorization === undefined ? {} : { headers: { authorization } });
}

describe("tokenSha256", () => {
	test("is the lowercase hex SHA-256 of the UTF-8 token", () => {
		expect(tokenSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(tokenSha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
});

describe("bearerToken", () => {
	test("is the trimmed token of a Bearer header, the scheme in any case", () => {
		expect(bearerToken(request(`Bearer ${TOKEN}`))).toBe(TOKEN);
		expect(bearerToken(request(`bearer   ${TOKEN}  `))).toBe(TOKEN);
	});

	test("is null without a header, with another scheme or with an empty token", () => {
		expect(bearerToken(request())).toBeNull();
		expect(bearerToken(request(`Basic ${TOKEN}`))).toBeNull();
		expect(bearerToken(request("Bearer"))).toBeNull();
		expect(bearerToken(request("Bearer    "))).toBeNull();
	});
});

describe("authenticate", () => {
	test("the right token is the owner", () => {
		expect(authenticate(request(`Bearer ${TOKEN}`), options())).toBe(OWNER_CALLER);
		expect(OWNER_CALLER).toEqual({ kind: "owner", principal: OWNER, device: null });
	});

	test("the scheme is case-insensitive", () => {
		expect(authenticate(request(`bearer ${TOKEN}`), options())).toBe(OWNER_CALLER);
		expect(authenticate(request(`BEARER ${TOKEN}`), options())).toBe(OWNER_CALLER);
	});

	test("a wrong token is rejected", () => {
		expect(authenticate(request("Bearer nope"), options())).toBeNull();
		expect(authenticate(request(`Bearer ${TOKEN}x`), options())).toBeNull();
	});

	test("a missing header is rejected", () => {
		expect(authenticate(request(), options())).toBeNull();
	});

	test("an empty token is rejected", () => {
		expect(authenticate(request("Bearer "), options())).toBeNull();
		expect(authenticate(request("Bearer"), options())).toBeNull();
		expect(authenticate(request("Bearer    "), options())).toBeNull();
		// Even when the configured hash is the hash of the empty token.
		expect(authenticate(request("Bearer "), options({ apiTokenSha256: tokenSha256("") }))).toBeNull();
	});

	test("another scheme is rejected even with the right token", () => {
		expect(authenticate(request(`Basic ${TOKEN}`), options())).toBeNull();
		expect(authenticate(request(TOKEN), options())).toBeNull();
	});

	test("a malformed expected hash never authenticates", () => {
		expect(authenticate(request(`Bearer ${TOKEN}`), options({ apiTokenSha256: "" }))).toBeNull();
		expect(authenticate(request(`Bearer ${TOKEN}`), options({ apiTokenSha256: HASH.slice(2) }))).toBeNull();
	});

	test("a device token is looked up by its SHA-256 on every request and is a device caller", () => {
		const lookups: string[] = [];
		const caller = authenticate(request(`Bearer ${DEVICE_TOKEN}`), options({}, lookups));
		expect(caller).toEqual({ kind: "device", principal: OWNER, device: { id: DEVICE.id, name: DEVICE.name, access: "threads" } });
		authenticate(request(`Bearer ${DEVICE_TOKEN}`), options({}, lookups));
		expect(lookups).toEqual([sha256Hex(DEVICE_TOKEN), sha256Hex(DEVICE_TOKEN)]);
	});

	test("an unknown or revoked device token is rejected, and never falls back to the owner token check", () => {
		expect(authenticate(request("Bearer ompd_unknown"), options())).toBeNull();
		// Even when the owner token itself starts like a device token, it is looked up as one.
		const odd = "ompd_looks-like-a-device";
		expect(authenticate(request(`Bearer ${odd}`), options({ apiTokenSha256: tokenSha256(odd) }))).toBeNull();
	});

	test("the remote listener knows device tokens only", () => {
		expect(authenticate(request(`Bearer ${TOKEN}`), options({ deviceOnly: true }))).toBeNull();
		expect(authenticate(request(`Bearer ${DEVICE_TOKEN}`), options({ deviceOnly: true }))?.kind).toBe("device");
	});
});

describe("actorOf", () => {
	test("is owner for the owner token and device:<id> for a device", () => {
		expect(actorOf(OWNER_CALLER)).toBe("owner");
		expect(actorOf({ kind: "device", principal: OWNER, device: { id: "abc", name: "n", access: "threads" } })).toBe("device:abc");
	});
});

describe("hasFullAccess", () => {
	test("is true for the owner token and a device with full access, false for a threads-only device", () => {
		expect(hasFullAccess(OWNER_CALLER)).toBe(true);
		expect(hasFullAccess({ kind: "device", principal: OWNER, device: { id: "a", name: "n", access: "full" } })).toBe(true);
		expect(hasFullAccess({ kind: "device", principal: OWNER, device: { id: "a", name: "n", access: "threads" } })).toBe(false);
	});

	test("authenticate carries the device's access into the caller", () => {
		const full = authenticate(request(`Bearer ${DEVICE_TOKEN}`), options({ store: { deviceByTokenSha256: () => ({ ...DEVICE, access: "full" }) } }));
		expect(full?.device?.access).toBe("full");
	});
});
