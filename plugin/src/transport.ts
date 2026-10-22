/**
 * The pinned transport of a paired connection. A paired service is trusted for exactly one certificate, the one stored
 * at pairing: it is the only trust anchor of every request, the host name is not checked (the pin is the identity),
 * and system roots never decide. Requests fail over between the stored addresses on connection errors only.
 *
 * This module holds the one place that reads a certificate without verifying it: {@link readServerCertificate}, which
 * the connect flow uses to learn what a code's address presents before anything is sent to it.
 */

import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { FetchFn } from "./api";
import type { ServerPin } from "./connection";
import type { ServerAddress } from "./pairing";

const READ_TIMEOUT_MS = 5000;

/** The last address of each pin that answered, for the rest of the process: the next request tries it first. */
const lastGood = new Map<string, string>();

/** The PEM of a certificate given as base64 DER. */
export function certificatePem(certificate: string): string {
	return `-----BEGIN CERTIFICATE-----\n${certificate.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END CERTIFICATE-----\n`;
}

/**
 * The leaf certificate (DER) the server at `address` presents. The handshake completes without verifying the
 * chain; nothing is written on the socket, which is destroyed at once. The caller compares the fingerprint
 * with the one in the pairing code before it trusts anything.
 */
export function readServerCertificate(address: ServerAddress, timeoutMs = READ_TIMEOUT_MS): Promise<Buffer> {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	const socket = tlsConnect({
		host: address.host,
		port: address.port,
		servername: isIP(address.host.replace(/%[\w.-]+$/, "")) === 0 ? address.host : undefined,
		rejectUnauthorized: false,
	});
	const settle = (outcome: Buffer | Error): void => {
		clearTimeout(timer);
		socket.destroy();
		if (outcome instanceof Error) reject(outcome);
		else resolve(outcome);
	};
	const timer = setTimeout(() => settle(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
	socket.once("error", settle);
	socket.once("secureConnect", () => {
		const raw = socket.getPeerCertificate(true).raw;
		settle(raw && raw.length > 0 ? raw : new Error("the server presented no certificate"));
	});
	return promise;
}

/** A redirect refused by `redirect: "error"`: the next address would answer the same. */
function isRedirectRefusal(e: unknown): boolean {
	return e instanceof Error && Reflect.get(e, "code") === "UnexpectedRedirect";
}

/** Whether a failed connection looks like a certificate that is not the pinned one. */
function isCertificateFailure(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const code = String(Reflect.get(e, "code") ?? "");
	return /CERT|SELF_SIGNED|ERR_TLS|UNABLE_TO_VERIFY/i.test(code) || /certificate|self.signed/i.test(e.message);
}

function pinKey(pin: ServerPin): string {
	return `${pin.fingerprint} ${pin.addresses.join(",")}`;
}

/** The address of `pin` the next request tries first: the last one that answered in this process, else the first stored. */
export function usedAddress(pin: ServerPin): string {
	return lastGood.get(pinKey(pin)) ?? pin.addresses[0] ?? "";
}

/**
 * A fetch that trusts only `pin`'s certificate: `tls.ca` is that certificate, the host name is not checked,
 * redirects are refused, and the stored addresses are tried in order (the last good one first) when a connection fails.
 * `input` is any URL of the service; its host is replaced by each address in turn.
 */
export function pinnedFetch(pin: ServerPin): FetchFn {
	const ca = certificatePem(pin.certificate);
	const key = pinKey(pin);
	return async (input, init) => {
		const url = new URL(input);
		url.protocol = "https:";
		const first = pin.addresses.indexOf(lastGood.get(key) ?? "");
		const order = first <= 0 ? pin.addresses : [...pin.addresses.slice(first), ...pin.addresses.slice(0, first)];
		let failure: unknown;
		for (const address of order) {
			const target = new URL(url);
			target.host = address;
			try {
				const res = await fetch(target.href, { ...init, tls: { ca, checkServerIdentity: () => undefined }, redirect: "error" });
				lastGood.set(key, address);
				return res;
			} catch (e) {
				if (init?.signal?.aborted || isRedirectRefusal(e)) throw e;
				failure = e;
			}
		}
		if (isCertificateFailure(failure)) {
			const why = failure instanceof Error ? failure.message : String(failure);
			throw new Error(`${why} (the server does not present the pinned certificate ${pin.fingerprint}; if it was reinstalled, pair again with /cloud connect --replace)`);
		}
		throw failure;
	};
}
