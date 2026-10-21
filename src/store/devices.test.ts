import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../pairing/secrets";
import { pairDevice } from "../pairing/test-support";
import { Store } from "./index";
import type { ClaimOutcome, NewThread, OfferRedemption } from "./types";

const T0 = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

let dir: string;
let store: Store;
let clock: number;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-devices-"));
	clock = T0;
	store = Store.open({ dataDir: dir, now: () => new Date(clock) });
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

function iso(offsetMs = 0): string {
	return new Date(T0 + offsetMs).toISOString();
}

function newThread(over: Partial<NewThread> = {}): NewThread {
	return {
		owner: "owner",
		title: "t",
		prompt: "do it",
		model: "",
		thinking: "",
		repo: { name: "proj", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "a".repeat(40), localBranch: "" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
		...over,
	};
}

/** An offer with secret `secret` and a request on it, as `redeemOffer` takes it. */
function redemption(offerId: string, secret: string, requestId: string, name = "laptop"): OfferRedemption {
	return {
		offerId,
		secretSha256: sha256Hex(secret),
		requestId,
		requestSecretSha256: sha256Hex(`request-secret-${requestId}`),
		name,
		platform: "linux",
		address: "10.0.0.5",
	};
}

function open(id = "offer-1", secret = "secret-1"): void {
	store.createOffer({ id, owner: "owner", secretSha256: sha256Hex(secret), ttlMs: 5 * MINUTE, maxOpen: 3 });
}

describe("migration 8", () => {
	test("creates the devices and pairing_offers tables and the active-name index", () => {
		store.close();
		const raw = new Database(join(dir, "omp-cloud.db"), { readonly: true });
		const names = raw
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name IN ('devices', 'pairing_offers', 'devices_active_name') ORDER BY name")
			.all()
			.map(row => row.name);
		expect(names).toEqual(["devices", "devices_active_name", "pairing_offers"]);
		expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(8);
		raw.close();
		store = Store.open({ dataDir: dir, now: () => new Date(clock) });
	});
});

describe("createOffer", () => {
	test("records an open offer that expires after its ttl", () => {
		const offer = store.createOffer({ id: "o1", owner: "owner", secretSha256: sha256Hex("s"), ttlMs: 5 * MINUTE, maxOpen: 3 });
		expect(offer).toEqual({ id: "o1", owner: "owner", status: "open", createdAt: iso(), expiresAt: iso(5 * MINUTE), request: null, device: null });
		clock = T0 + 5 * MINUTE;
		expect(store.offer("o1")?.status).toBe("expired");
		expect(store.offer("unknown")).toBeNull();
	});

	test("a fourth live offer cancels the oldest", () => {
		for (const id of ["o1", "o2", "o3"]) {
			open(id);
			clock += 1000;
		}
		open("o4");
		expect(["o1", "o2", "o3", "o4"].map(id => store.offer(id)?.status)).toEqual(["cancelled", "open", "open", "open"]);
	});

	test("an expired offer does not count against the limit", () => {
		open("o1");
		open("o2");
		clock = T0 + 6 * MINUTE;
		open("o3");
		open("o4");
		expect(["o1", "o2", "o3", "o4"].map(id => store.offer(id)?.status)).toEqual(["expired", "expired", "open", "open"]);
	});
});

describe("redeemOffer", () => {
	test("the right secret makes the offer pending and records the request", () => {
		open();
		clock += 1000;
		expect(store.redeemOffer(redemption("offer-1", "secret-1", "r1"))).toEqual({ kind: "ok", expiresAt: iso(5 * MINUTE) });
		expect(store.offer("offer-1")).toMatchObject({
			status: "pending",
			request: { name: "laptop", platform: "linux", address: "10.0.0.5", at: iso(1000) },
		});
	});

	test("two redemptions of one offer have exactly one winner", () => {
		open();
		const results = [store.redeemOffer(redemption("offer-1", "secret-1", "r1")), store.redeemOffer(redemption("offer-1", "secret-1", "r2", "other"))];
		expect(results.map(r => r.kind).sort()).toEqual(["ok", "rejected"]);
		expect(store.offer("offer-1")?.request?.name).toBe("laptop");
	});

	test("the fifth wrong secret burns the offer, and then even the right secret is rejected", () => {
		open();
		for (let i = 0; i < 4; i++) {
			expect(store.redeemOffer(redemption("offer-1", "wrong", `r${i}`)).kind).toBe("rejected");
			expect(store.offer("offer-1")?.status).toBe("open");
		}
		expect(store.redeemOffer(redemption("offer-1", "wrong", "r5")).kind).toBe("rejected");
		expect(store.offer("offer-1")?.status).toBe("burned");
		expect(store.redeemOffer(redemption("offer-1", "secret-1", "r6")).kind).toBe("rejected");
	});

	test("a wrong secret on an offer that is not open changes nothing", () => {
		open();
		store.redeemOffer(redemption("offer-1", "secret-1", "r1"));
		for (let i = 0; i < 8; i++) store.redeemOffer(redemption("offer-1", "wrong", `x${i}`));
		expect(store.offer("offer-1")?.status).toBe("pending");
		expect(store.offer("offer-1")?.request?.name).toBe("laptop");
	});

	test("an expired, unknown or cancelled offer is rejected", () => {
		open();
		open("offer-2", "secret-2");
		store.cancelOffer("offer-2");
		clock += 6 * MINUTE;
		expect(store.redeemOffer(redemption("offer-1", "secret-1", "r1")).kind).toBe("rejected");
		expect(store.redeemOffer(redemption("nope", "secret-1", "r2")).kind).toBe("rejected");
		expect(store.redeemOffer(redemption("offer-2", "secret-2", "r3")).kind).toBe("rejected");
	});
});

describe("claimOffer", () => {
	function pending(id = "offer-1", requestId = "r1", name = "laptop"): void {
		open(id, `secret-${id}`);
		expect(store.redeemOffer(redemption(id, `secret-${id}`, requestId, name)).kind).toBe("ok");
	}
	const claim = (requestId: string, secret = `request-secret-${requestId}`, deviceId = "dev-1", token = "ompd_a"): ClaimOutcome =>
		store.claimOffer(requestId, sha256Hex(secret), { id: deviceId, tokenSha256: sha256Hex(token) });

	test("pending until approved, then one 'created', then rejected", () => {
		pending();
		expect(claim("r1")).toEqual({ kind: "pending" });
		expect(store.decideOffer("offer-1", "approve")).toBe("done");
		expect(claim("r1")).toEqual({ kind: "created", device: { id: "dev-1", name: "laptop" } });
		expect(claim("r1", undefined, "dev-2", "ompd_b")).toEqual({ kind: "rejected" });
		expect(store.offer("offer-1")).toMatchObject({ status: "paired", device: { id: "dev-1", name: "laptop" } });
		expect(store.device("dev-1")).toMatchObject({ name: "laptop", platform: "linux", pairedFrom: "10.0.0.5", lastSeenAt: null });
		expect(store.device("dev-2")).toBeNull();
		expect(store.deviceByTokenSha256(sha256Hex("ompd_a"))?.id).toBe("dev-1");
		expect(store.deviceByTokenSha256(sha256Hex("ompd_b"))).toBeNull();
	});

	test("a wrong request secret or an unknown request is rejected and changes nothing", () => {
		pending();
		store.decideOffer("offer-1", "approve");
		expect(claim("r1", "wrong")).toEqual({ kind: "rejected" });
		expect(claim("nope")).toEqual({ kind: "rejected" });
		expect(store.offer("offer-1")?.status).toBe("approved");
	});

	test("a declined request reports declined", () => {
		pending();
		expect(store.decideOffer("offer-1", "decline")).toBe("done");
		expect(claim("r1")).toEqual({ kind: "declined" });
	});

	test("a cancelled or expired offer is rejected", () => {
		pending();
		store.decideOffer("offer-1", "approve");
		clock += 6 * MINUTE;
		expect(claim("r1")).toEqual({ kind: "rejected" });
		pending("offer-2", "r2");
		store.cancelOffer("offer-2");
		expect(claim("r2")).toEqual({ kind: "rejected" });
	});

	test("a name already taken by an active device gets -2, -3, and a revoked name is free again", () => {
		const first = pairDevice(store, { name: "laptop" });
		const second = pairDevice(store, { name: "laptop" });
		const third = pairDevice(store, { name: "laptop" });
		expect([first.name, second.name, third.name]).toEqual(["laptop", "laptop-2", "laptop-3"]);
		store.revokeDevice(first.id, "owner");
		expect(pairDevice(store, { name: "laptop" }).name).toBe("laptop");
	});

	test("a long name keeps the limit when a suffix is added", () => {
		const name = "n".repeat(64);
		pairDevice(store, { name });
		const second = pairDevice(store, { name });
		expect([...second.name]).toHaveLength(64);
		expect(second.name.endsWith("-2")).toBe(true);
	});

	test("two claims of one approved request create exactly one device", () => {
		pending();
		store.decideOffer("offer-1", "approve");
		const kinds = [claim("r1", undefined, "dev-1", "ompd_a"), claim("r1", undefined, "dev-2", "ompd_b")].map(r => r.kind);
		expect(kinds.sort()).toEqual(["created", "rejected"]);
		expect(store.devices("owner")).toHaveLength(1);
	});
});

describe("decideOffer and cancelOffer", () => {
	test("approve and decline need a pending, unexpired offer", () => {
		open();
		expect(store.decideOffer("offer-1", "approve")).toBe("not_waiting");
		expect(store.decideOffer("nope", "approve")).toBe("not_found");
		store.redeemOffer(redemption("offer-1", "secret-1", "r1"));
		clock += 6 * MINUTE;
		expect(store.decideOffer("offer-1", "approve")).toBe("not_waiting");
	});

	test("cancel is idempotent, leaves finished offers alone and reports unknown ones", () => {
		open();
		expect(store.cancelOffer("offer-1")).toBe(true);
		expect(store.cancelOffer("offer-1")).toBe(true);
		expect(store.offer("offer-1")?.status).toBe("cancelled");
		expect(store.cancelOffer("nope")).toBe(false);
		open("offer-2", "secret-2");
		store.redeemOffer(redemption("offer-2", "secret-2", "r2"));
		store.decideOffer("offer-2", "decline");
		store.cancelOffer("offer-2");
		expect(store.offer("offer-2")?.status).toBe("declined");
	});
});

describe("devices", () => {
	test("lists active devices oldest first, per owner", () => {
		const a = pairDevice(store, { name: "a" });
		clock += 1000;
		const b = pairDevice(store, { name: "b" });
		pairDevice(store, { name: "c", owner: "other" });
		expect(store.devices("owner").map(d => d.id)).toEqual([a.id, b.id]);
		store.revokeDevice(a.id, "owner");
		expect(store.devices("owner").map(d => d.id)).toEqual([b.id]);
		expect(store.deviceByTokenSha256(sha256Hex(a.token))).toBeNull();
		expect(store.device(a.id)).toBeNull();
	});

	test("touchDevice writes at most once per interval and skips revoked devices", () => {
		const device = pairDevice(store);
		store.touchDevice(device.id, "10.0.0.7", MINUTE);
		expect(store.device(device.id)).toMatchObject({ lastSeenAt: iso(), lastSeenAddress: "10.0.0.7" });
		clock += MINUTE - 1;
		store.touchDevice(device.id, "10.0.0.8", MINUTE);
		expect(store.device(device.id)?.lastSeenAddress).toBe("10.0.0.7");
		clock += 1;
		store.touchDevice(device.id, "10.0.0.8", MINUTE);
		expect(store.device(device.id)).toMatchObject({ lastSeenAt: iso(MINUTE), lastSeenAddress: "10.0.0.8" });
		store.revokeDevice(device.id, "owner");
		clock += 10 * MINUTE;
		store.touchDevice(device.id, "10.0.0.9", MINUTE);
		expect(store.device(device.id)).toBeNull();
	});

	test("revoking lists the running threads the device started, and only those", () => {
		const device = pairDevice(store);
		const by = `device:${device.id}`;
		store.createThread("aaaaaaaaaaaa", newThread({ sentBy: by }));
		store.startNextTurn("aaaaaaaaaaaa");
		store.createThread("bbbbbbbbbbbb", newThread({ sentBy: by }));
		store.createThread("cccccccccccc", newThread({ sentBy: by }));
		store.startNextTurn("cccccccccccc");
		store.completeTurn("cccccccccccc", 1, { outcome: "completed", error: "", reply: "ok", usage: null, head: "", filesChanged: 0, insertions: 0, deletions: 0, pushed: false, pushError: "", pushRef: "" });
		store.createThread("dddddddddddd", newThread());
		store.startNextTurn("dddddddddddd");

		const revoked = store.revokeDevice(device.id, "owner");
		expect(revoked?.runningThreads).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(revoked?.device).toMatchObject({ id: device.id, revokedAt: iso() });
		expect(store.revokeDevice(device.id, "owner")).toBeNull();
		expect(store.revokeDevice("nope", "owner")).toBeNull();
	});

	test("an owner cannot revoke another owner's device", () => {
		const device = pairDevice(store, { owner: "other" });
		expect(store.revokeDevice(device.id, "owner")).toBeNull();
		expect(store.device(device.id)).not.toBeNull();
	});

	test("the first turn of a thread is sent by sentBy, else by the owner", () => {
		store.createThread("aaaaaaaaaaaa", newThread({ sentBy: "device:x" }));
		store.createThread("bbbbbbbbbbbb", newThread());
		expect(store.turns("aaaaaaaaaaaa")[0]?.by).toBe("device:x");
		expect(store.turns("bbbbbbbbbbbb")[0]?.by).toBe("owner");
		expect(store.events("aaaaaaaaaaaa", 0, 10)[0]?.text).toBe("queued by device:x");
	});
});
