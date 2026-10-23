/**
 * `/cloud pair`: a transient overlay on the server machine that shows a pairing code, copies it to the clipboard, waits
 * for a device to redeem it and asks the owner to approve that device. The code lives only in this overlay (and the
 * clipboard): it is never put in a card, a notification or anything the model sees. Esc closes the overlay and cancels
 * the offer unless it paired.
 */

import type { Component, NativeNode, Theme } from "@oh-my-pi/pi-tui";
import type { TuiModule } from "./cards";
import { countdown } from "./connect";
import { clip } from "./format";
import type { DeviceAccess, OfferState, OfferStatus, PairingOffer } from "./types";

export interface PairApi {
	pairingOffer(id: string): Promise<OfferState>;
	approvePairing(id: string, access: DeviceAccess): Promise<void>;
	declinePairing(id: string): Promise<void>;
	cancelPairing(id: string): Promise<void>;
}

/** How the overlay ended: with a device paired, or closed in `status`. */
export type PairOutcome = { kind: "paired"; name: string } | { kind: "closed"; status: OfferStatus };

export interface PairDeps {
	api: PairApi;
	offer: PairingOffer;
	theme: Pick<Theme, "fg" | "bold">;
	tui: Pick<TuiModule, "truncateToWidth" | "matchesKey" | "col" | "text" | "span">;
	/** Puts text on the clipboard, best effort: omp's `copyToClipboard` (OSC 52, then a native copy) gives no failure signal, so a resolved call does not mean the text arrived. Called once. */
	copy(text: string): Promise<void>;
	requestRender(): void;
	done(result: PairOutcome): void;
	now?(): number;
	/** Milliseconds between polls of the offer; 1000 by default. */
	pollMs?: number;
	/** Milliseconds the overlay stays after the device paired; 1500 by default. */
	lingerMs?: number;
}

const TERMINAL: readonly OfferStatus[] = ["paired", "declined", "cancelled", "burned", "expired"];

const COPY_TEXT = "code sent to your clipboard; if pasting fails, copy the code above";

const NEXT_TEXT = "on the other machine: /cloud connect, then paste it";

const STATUS_TEXT: Partial<Record<OfferStatus, string>> = {
	open: "waiting for a device",
	approved: "approved: waiting for the device to collect its token…",
	declined: "declined; nothing was paired",
	cancelled: "cancelled",
	burned: "burned: too many wrong attempts on this code",
	expired: "expired",
};

/** The pairing overlay. `start` begins polling; `dispose` (called by the host) stops it and cancels an offer that did not pair. */
export class PairComponent implements Component {
	readonly #d: PairDeps;
	#offer: OfferState;
	#error = "";
	#busy = false;
	#finished = false;
	#timer: Timer | undefined;
	#closeTimer: Timer | undefined;
	#polling = false;
	#node: { key: string; node: NativeNode } | undefined;

	constructor(deps: PairDeps) {
		this.#d = deps;
		this.#offer = { id: deps.offer.id, status: "open", expiresAt: deps.offer.expiresAt, request: null, device: null };
	}

	get status(): OfferStatus {
		return this.#offer.status;
	}

	start(): void {
		void this.#poll();
		this.#timer = setInterval(() => void this.#poll(), this.#d.pollMs ?? 1000);
		// Best effort, once: the host's copy has no failure signal, so the overlay only claims an attempt.
		void this.#d.copy(this.#d.offer.code).catch(() => {});
	}

	dispose(): void {
		clearInterval(this.#timer);
		clearTimeout(this.#closeTimer);
		this.#timer = undefined;
		this.#closeTimer = undefined;
		if (!this.#finished) this.#cancel();
		this.#finished = true;
	}

	invalidate(): void {}

	/** Cancels the offer unless it paired; failures are ignored (the offer expires on its own in minutes). */
	#cancel(): void {
		if (this.#offer.status !== "paired") void this.#d.api.cancelPairing(this.#offer.id).catch(() => {});
	}

	async #poll(): Promise<void> {
		if (this.#polling || this.#finished) return;
		this.#polling = true;
		try {
			const offer = await this.#d.api.pairingOffer(this.#d.offer.id);
			if (this.#finished) return;
			this.#offer = offer;
			this.#error = "";
			if (offer.status === "paired") {
				clearInterval(this.#timer);
				this.#timer = undefined;
				this.#closeTimer ??= setTimeout(() => this.#finish({ kind: "paired", name: offer.device?.name ?? "" }), this.#d.lingerMs ?? 1500);
			} else if (TERMINAL.includes(offer.status)) {
				clearInterval(this.#timer);
				this.#timer = undefined;
			}
		} catch (e) {
			this.#error = e instanceof Error ? e.message : String(e);
		} finally {
			this.#polling = false;
			if (!this.#finished) this.#d.requestRender();
		}
	}

	#finish(outcome: PairOutcome): void {
		if (this.#finished) return;
		clearInterval(this.#timer);
		clearTimeout(this.#closeTimer);
		if (outcome.kind !== "paired") this.#cancel();
		this.#finished = true;
		this.#d.done(outcome);
	}

	/** Approves the device that waits with `full` or `threads` access, or declines it; the poll then shows the result. */
	async #decide(choice: DeviceAccess | "decline"): Promise<void> {
		if (this.#busy || this.#offer.status !== "pending") return;
		this.#busy = true;
		try {
			await (choice === "decline" ? this.#d.api.declinePairing(this.#offer.id) : this.#d.api.approvePairing(this.#offer.id, choice));
			this.#error = "";
		} catch (e) {
			this.#error = e instanceof Error ? e.message : String(e);
		} finally {
			this.#busy = false;
		}
		await this.#poll();
	}

	handleInput(data: string): void {
		const { matchesKey } = this.#d.tui;
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.#finish(this.#offer.status === "paired" ? { kind: "paired", name: this.#offer.device?.name ?? "" } : { kind: "closed", status: this.#offer.status });
		} else if (matchesKey(data, "y")) {
			void this.#decide("full");
		} else if (matchesKey(data, "t")) {
			void this.#decide("threads");
		} else if (matchesKey(data, "n")) {
			void this.#decide("decline");
		}
	}

	/** The status sentence, and the keys that act now. */
	#state(): { status: string; keys: string; tone: "muted" | "warning" | "success" | "error" } {
		const o = this.#offer;
		if (o.status === "pending" && o.request) {
			const r = o.request;
			return {
				status: `${clip(r.name, 64)} · ${clip(r.platform, 32)} · ${clip(r.address, 64)} wants to pair`,
				keys: "y approve with full access · t approve with threads-only access · n decline · esc cancel",
				tone: "warning",
			};
		}
		if (o.status === "paired") return { status: `paired ${clip(o.device?.name ?? "", 64)}`, keys: "esc close", tone: "success" };
		const bad = o.status === "declined" || o.status === "burned" || o.status === "expired" || o.status === "cancelled";
		return { status: STATUS_TEXT[o.status] ?? o.status, keys: TERMINAL.includes(o.status) ? "esc close" : "esc cancel", tone: bad ? "error" : "muted" };
	}

	#remaining(): string {
		const left = Date.parse(this.#offer.expiresAt) - (this.#d.now?.() ?? Date.now());
		return TERMINAL.includes(this.#offer.status) || Number.isNaN(left) ? "" : `expires in ${countdown(left)}`;
	}

	render(width: number): readonly string[] {
		const { theme, tui } = this.#d;
		const w = Math.max(20, width);
		const fit = (s: string): string => tui.truncateToWidth(s, w);
		const st = this.#state();
		const lines = [theme.bold(theme.fg("accent", "☁ pair a device")), theme.fg(st.tone, st.status)];
		if (this.#error) lines.push(theme.fg("error", `! ${clip(this.#error, 200)}`));
		lines.push(theme.fg("dim", [st.keys, this.#remaining()].filter(Boolean).join(" · ")));
		if (!TERMINAL.includes(this.#offer.status)) {
			const code = this.#d.offer.code;
			lines.push("");
			for (let i = 0; i < code.length; i += w - 2) lines.push(`  ${theme.bold(theme.fg("accent", code.slice(i, i + w - 2)))}`);
			lines.push("", theme.fg("muted", COPY_TEXT), theme.fg("muted", NEXT_TEXT));
		}
		return lines.map(fit);
	}

	/** Tern: the same facts as text; the code is one monospace run that wraps by character. */
	describe(): NativeNode {
		const { tui } = this.#d;
		const st = this.#state();
		const done = TERMINAL.includes(this.#offer.status);
		const key = JSON.stringify([st, this.#error, this.#remaining(), done]);
		if (this.#node?.key === key) return this.#node.node;
		const rows = [
			tui.text([tui.span("☁ pair a device", "accent bold")], { wrap: "none" }),
			tui.text([tui.span(st.status, st.tone)], { wrap: "word" }),
			tui.text([tui.span([st.keys, this.#remaining()].filter(Boolean).join(" · "), "dim")], { wrap: "word" }),
		];
		if (this.#error) rows.push(tui.text([tui.span(`! ${clip(this.#error, 200)}`, "error")], { wrap: "word" }));
		if (!done) {
			rows.push(
				tui.text([tui.span(this.#d.offer.code, "accent mono strong")], { wrap: "char" }),
				tui.text([tui.span(COPY_TEXT, "muted")], { wrap: "word" }),
				tui.text([tui.span(NEXT_TEXT, "muted")], { wrap: "word" }),
			);
		}
		const node = tui.col(rows, { role: "omp.cloud.pair" });
		this.#node = { key, node };
		return node;
	}
}
