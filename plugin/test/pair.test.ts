import { afterEach, describe, expect, test } from "bun:test";
import { loadTui } from "../src/cards";
import { PairComponent, type PairApi, type PairOutcome } from "../src/pair";
import type { OfferState, OfferStatus, PairingOffer } from "../src/types";
import { until } from "./fakes";

const CODE = "ompc1:AbCdEfGhIjKl:s3cr3tS3cr3tS3cr3tS3cr3t:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ@10.0.0.42:8443,workstation.local:8443";
const OFFER: PairingOffer = { id: "AbCdEfGhIjKl", code: CODE, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), fingerprint: "SHA256:x", addresses: ["10.0.0.42:8443"] };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const tui = await loadTui();
if (!tui) throw new Error("the host pi-tui is required for the pairing overlay tests");

interface Rig {
	pair: PairComponent;
	calls: string[];
	outcomes: PairOutcome[];
	renders: () => number;
	/** What the overlay put on the clipboard, in order. */
	copies: string[];
	/** The status the fake service reports; change it to move the pairing along. */
	set(status: OfferStatus, over?: Partial<OfferState>): void;
	fail(message: string | undefined): void;
}

const made: PairComponent[] = [];
afterEach(() => {
	for (const p of made.splice(0)) p.dispose();
});

function rig(opts: { copyFails?: boolean; pollMs?: number; lingerMs?: number; now?: () => number; offer?: PairingOffer } = {}): Rig {
	if (!tui) throw new Error("unreachable");
	let state: OfferState = { id: OFFER.id, status: "open", expiresAt: OFFER.expiresAt, request: null, device: null };
	let failure: string | undefined;
	const calls: string[] = [];
	const outcomes: PairOutcome[] = [];
	let renders = 0;
	const copies: string[] = [];
	const api: PairApi = {
		pairingOffer: async () => {
			if (failure) throw new Error(failure);
			return state;
		},
		approvePairing: async id => void calls.push(`approve ${id}`),
		declinePairing: async id => void calls.push(`decline ${id}`),
		cancelPairing: async id => void calls.push(`cancel ${id}`),
	};
	const pair = new PairComponent({
		api,
		offer: opts.offer ?? OFFER,
		theme,
		tui,
		copy: async text => {
			copies.push(text);
			if (opts.copyFails) throw new Error("no clipboard");
		},
		requestRender: () => void renders++,
		done: o => void outcomes.push(o),
		pollMs: opts.pollMs ?? 5,
		lingerMs: opts.lingerMs ?? 10,
		now: opts.now,
	});
	made.push(pair);
	pair.start();
	return {
		pair,
		calls,
		outcomes,
		renders: () => renders,
		copies,
		set: (status, over = {}) => void (state = { ...state, status, ...over }),
		fail: m => void (failure = m),
	};
}

const text = (r: Rig, width = 120): string => r.pair.render(width).join("\n");
const REQUEST = { name: "laptop", platform: "linux", address: "10.0.0.7", at: "2026-10-20T00:00:00.000Z" };

describe("the pair overlay", () => {
	test("shows the code in full, the countdown and how to cancel while it waits for a device, and no QR", async () => {
		const r = rig();
		await until(() => r.renders() > 0);
		const lines = r.pair.render(100);
		expect(lines[0]).toContain("pair a device");
		expect(text(r, 100)).toContain("waiting for a device");
		expect(text(r, 100)).toMatch(/esc cancel · expires in [45]:\d\d/);
		// The code is wrapped over lines of its own and reads back whole.
		const chunks = lines.filter(l => l.startsWith("  ") && !l.includes("\x1b")).map(l => l.trim());
		expect(chunks.join("")).toBe(CODE);
		// Narrow: the same code wraps over more lines.
		const narrow = r.pair.render(30).filter(l => l.startsWith("  ")).map(l => l.trim());
		expect(narrow.length).toBeGreaterThan(chunks.length);
		expect(narrow.join("")).toBe(CODE);
		// No QR: no inverse-video modules, no block glyphs, no mention of one.
		expect(lines.join("\n")).not.toMatch(/[▀▄█]|\x1b\[47m|QR/);
	});

	test("every row fits the width, narrow or not", async () => {
		const r = rig();
		await until(() => r.renders() > 0);
		for (const w of [20, 30, 60, 90, 140]) {
			for (const row of r.pair.render(w)) expect(tui?.truncateToWidth(row, w)).toBe(row);
		}
	});

	test("the code is copied once, when the overlay opens, and the overlay words it as an attempt", async () => {
		const r = rig();
		await until(() => r.copies.length > 0);
		expect(r.copies).toEqual([CODE]);
		expect(text(r)).toContain("code sent to your clipboard; if pasting fails, copy the code above");
		expect(text(r)).not.toContain("copied to your clipboard");
		expect(text(r)).toContain("on the other machine: /cloud connect, then paste it");
		r.set("pending", { request: REQUEST });
		await until(() => text(r).includes("wants to pair"));
		r.pair.handleInput("y");
		await until(() => r.calls.length > 0);
		expect(r.copies).toEqual([CODE]);
	});

	test("a copy that rejects changes nothing: the code stays on screen to copy by hand", async () => {
		const r = rig({ copyFails: true });
		await until(() => r.copies.length > 0);
		expect(r.copies).toEqual([CODE]);
		expect(r.pair.render(200).join("")).toContain(CODE);
		expect(text(r)).toContain("copy the code above");
	});

	test("a finished offer no longer shows the code or the copy note", async () => {
		const r = rig();
		r.set("expired");
		await until(() => text(r).includes("expired"));
		expect(text(r)).not.toContain("clipboard");
		expect(text(r)).not.toContain("s3cr3t");
	});

	test("a device that redeemed the code is shown with its name, platform and address, and y approves it once", async () => {
		const r = rig();
		r.set("pending", { request: REQUEST });
		await until(() => text(r).includes("laptop · linux · 10.0.0.7 wants to pair"));
		expect(text(r)).toContain("y approve · n decline · esc cancel");

		r.pair.handleInput("y");
		r.pair.handleInput("y");
		await until(() => r.calls.length > 0);
		expect(r.calls).toEqual([`approve ${OFFER.id}`]);
	});

	test("n declines", async () => {
		const r = rig();
		r.set("pending", { request: REQUEST });
		await until(() => text(r).includes("wants to pair"));
		r.pair.handleInput("n");
		await until(() => r.calls.length > 0);
		expect(r.calls).toEqual([`decline ${OFFER.id}`]);
		r.set("declined");
		await until(() => text(r).includes("declined"));
		// A finished offer no longer shows the code.
		expect(text(r)).not.toContain("s3cr3t");
	});

	test("y and n do nothing until a device waits", async () => {
		const r = rig();
		await until(() => r.renders() > 0);
		r.pair.handleInput("y");
		r.pair.handleInput("n");
		const before = r.renders();
		await until(() => r.renders() >= before + 2);
		expect(r.calls).toEqual([]);
	});

	test("once the device paired the overlay says so, closes by itself and does not cancel", async () => {
		const r = rig();
		r.set("paired", { device: { id: "d1", name: "laptop" } });
		await until(() => r.outcomes.length > 0);
		expect(r.outcomes).toEqual([{ kind: "paired", name: "laptop" }]);
		expect(text(r)).toContain("paired laptop");
		r.pair.dispose();
		expect(r.calls).toEqual([]);
	});

	test("Esc and q close the overlay and cancel the offer; ctrl+c too", async () => {
		for (const key of ["\x1b", "q", "\x03"]) {
			const r = rig();
			r.set("pending", { request: REQUEST });
			await until(() => text(r).includes("wants to pair"));
			r.pair.handleInput(key);
			expect(r.outcomes).toEqual([{ kind: "closed", status: "pending" }]);
			expect(r.calls).toEqual([`cancel ${OFFER.id}`]);
			r.pair.dispose();
			expect(r.calls).toEqual([`cancel ${OFFER.id}`]);
		}
	});

	test("closing after pairing is not a cancel", async () => {
		const r = rig({ lingerMs: 10_000 });
		r.set("paired", { device: { id: "d1", name: "laptop" } });
		await until(() => text(r).includes("paired laptop"));
		r.pair.handleInput("q");
		expect(r.outcomes).toEqual([{ kind: "paired", name: "laptop" }]);
		expect(r.calls).toEqual([]);
	});

	test("a host that disposes the overlay without closing it still cancels the offer", async () => {
		const r = rig();
		await until(() => r.renders() > 0);
		r.pair.dispose();
		expect(r.calls).toEqual([`cancel ${OFFER.id}`]);
		r.pair.dispose();
		expect(r.calls).toHaveLength(1);
	});

	test("polling stops once the offer is over, and a failing poll shows the error and keeps trying", async () => {
		const r = rig();
		r.fail("service unreachable");
		await until(() => text(r).includes("! service unreachable"));
		r.fail(undefined);
		r.set("expired");
		await until(() => text(r).includes("expired"));
		expect(text(r)).not.toContain("! service unreachable");
		expect(text(r)).toContain("esc close");
		const before = r.renders();
		// Absence cannot be awaited: several poll intervals (5 ms each) must pass for "no more polling" to mean anything.
		await Bun.sleep(40);
		expect(r.renders()).toBe(before);
	});

	test("the countdown follows the clock", async () => {
		let now = Date.parse(OFFER.expiresAt) - 90_000;
		const r = rig({ now: () => now });
		await until(() => r.renders() > 0);
		expect(text(r)).toContain("expires in 1:30");
		now += 31_000;
		expect(text(r)).toContain("expires in 0:59");
	});

	test("Tern describes the same facts: the code, the status, the copy note and how to continue, with no QR block; the same node while nothing changes", async () => {
		const r = rig();
		await until(() => r.copies.length > 0);
		const node = r.pair.describe();
		const json = JSON.stringify(node);
		expect(json).toContain("omp.cloud.pair");
		expect(json).toContain(CODE);
		expect(json).toContain("waiting for a device");
		expect(json).toContain("code sent to your clipboard; if pasting fails, copy the code above");
		expect(json).toContain("on the other machine: /cloud connect, then paste it");
		expect(json).not.toMatch(/[▀▄█]/);
		expect(json).not.toContain('"code"');
		expect(r.pair.describe()).toBe(node);
	});

	test("the Tern code run wraps by character and is monospace", async () => {
		const r = rig();
		await until(() => r.renders() > 0);
		const json = JSON.stringify(r.pair.describe());
		expect(json).toContain('"wrap":"char"');
		expect(json).toContain("mono");
	});

	test("the Tern code run is followed by the same copy attempt note", async () => {
		const r = rig();
		await until(() => r.renders() > 0);
		expect(JSON.stringify(r.pair.describe())).toContain("if pasting fails, copy the code above");
	});
});
