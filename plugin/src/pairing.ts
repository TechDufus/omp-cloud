/**
 * Device pairing, the parts that are pure: reading a pairing code (`ompc1:<offer>:<secret>:<fingerprint>@<addr>[,<addr>…]`),
 * certificate fingerprints, device names, and the rule about which addresses a code may point at. No I/O.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { UserError } from "./types";

/** A pairing code starts with this; a code in a launch or follow-up message is a mistake, never a task. */
export const CODE_MARKER = "ompc1:";

/** One `host:port` a code lists. `text` is the address as written (IPv6 in brackets) and is what a connection file stores. */
export interface ServerAddress {
	host: string;
	port: number;
	text: string;
}

/** A parsed pairing code. `fingerprint` is always the display form, `SHA256:` + standard base64 without padding. */
export interface PairingCode {
	offer: string;
	secret: string;
	fingerprint: string;
	addresses: ServerAddress[];
}

const MAX_CODE_LENGTH = 1024;
const MAX_ADDRESSES = 8;
const ID_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** 32 bytes in base64url (`-_`) or standard base64 (`+/`), unpadded. */
const FINGERPRINT_PART = /^[A-Za-z0-9_+/-]{43}$/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const DEVICE_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

export const NOT_A_CODE =
	"☁ that is not a pairing code (expected ompc1:<offer>:<secret>:<fingerprint>@<host:port>); run /cloud pair on the server machine for a fresh one";

/** `SHA256:` + standard base64 without padding of the SHA-256 of a certificate's DER, like `ssh-keygen -l`. */
export function fingerprintOf(der: Uint8Array): string {
	return `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/, "")}`;
}

/** A fingerprint in either encoding (with or without the `SHA256:` prefix) as base64url without padding. */
function normalizeFingerprint(fp: string): string {
	return fp.replace(/^SHA256:/, "").replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
}

/** Whether two fingerprints name the same certificate, whichever encoding each is in; constant time. */
export function fingerprintsMatch(a: string, b: string): boolean {
	const x = Buffer.from(normalizeFingerprint(a));
	const y = Buffer.from(normalizeFingerprint(b));
	return x.length === y.length && timingSafeEqual(x, y);
}

/** Refuses text that holds a pairing code: a code is a credential for one pairing and has no business in a task or a message. */
export function refusePairingCode(...texts: (string | undefined)[]): void {
	if (texts.some(t => t?.toLowerCase().includes(CODE_MARKER))) throw new UserError("that looks like a pairing code; use /cloud connect");
}

/** Whether `name` (trimmed) is a device name the service accepts: 1–64 letters, digits, spaces, `.`, `_` or `-`. */
export function isDeviceName(name: string): boolean {
	return DEVICE_NAME.test(name.trim());
}

/** A device name made of `host`: characters the service refuses become `-`; `omp-device` when nothing is left. */
export function defaultDeviceName(host: string): string {
	const cleaned = host.trim().replace(/[^\p{L}\p{N} ._-]/gu, "-").slice(0, 64).trim();
	return cleaned === "" ? "omp-device" : cleaned;
}

/**
 * Whether `host` is made only of inet_aton-style parts: 1 to 4 dot-separated numbers, each decimal, `0x` hex or
 * leading-0 octal. A resolver reads such a host as an IPv4 address (`0x5db8d822`, `1572395042`), so it is never a
 * name; only the canonical dotted quad is accepted as an address.
 */
function isNumericForm(host: string): boolean {
	const parts = host.split(".");
	return parts.length <= 4 && parts.every(p => /^(0[xX][0-9a-fA-F]*|\d+)$/.test(p));
}

/** `host:port` or `[ipv6]:port`; undefined when it is neither. */
export function parseServerAddress(text: string): ServerAddress | undefined {
	const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(text);
	const plain = bracketed ? null : /^([^:[\]]+):(\d{1,5})$/.exec(text);
	const host = bracketed?.[1] ?? plain?.[1];
	const port = Number(bracketed?.[2] ?? plain?.[2]);
	if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	if (bracketed) {
		if (isIP(host.replace(/%[\w.-]+$/, "")) !== 6) return undefined;
	} else if (isNumericForm(host) ? isIP(host) !== 4 : isIP(host) !== 4 && (!HOSTNAME.test(host) || host.length > 253)) {
		return undefined;
	}
	return { host, port, text };
}

/**
 * A pairing code: trimmed, one pair of surrounding quotes or backticks removed, every whitespace character dropped (a
 * code never contains one, and a terminal wraps a long code across lines), split at the first `@`. Throws
 * {@link UserError} without quoting the input.
 */
export function parsePairingCode(input: string): PairingCode {
	let text = input.trim();
	const quote = text[0];
	if (text.length >= 2 && (quote === '"' || quote === "'" || quote === "`") && text.endsWith(quote)) text = text.slice(1, -1);
	text = text.replace(/\s+/g, "");
	if (text.length > MAX_CODE_LENGTH) throw new UserError(NOT_A_CODE);
	const at = text.indexOf("@");
	if (at < 0) throw new UserError(NOT_A_CODE);
	const parts = text.slice(0, at).split(":");
	const [marker, offer, secret, fp] = parts;
	if (parts.length !== 4 || marker !== CODE_MARKER.slice(0, -1) || offer === undefined || secret === undefined || fp === undefined) throw new UserError(NOT_A_CODE);
	if (!ID_PART.test(offer) || !ID_PART.test(secret) || !FINGERPRINT_PART.test(fp)) throw new UserError(NOT_A_CODE);
	const listed = text.slice(at + 1).split(",");
	if (listed.length > MAX_ADDRESSES) throw new UserError(NOT_A_CODE);
	const addresses = listed.map(parseServerAddress);
	if (addresses.some(a => a === undefined)) throw new UserError(NOT_A_CODE);
	return {
		offer,
		secret,
		fingerprint: `SHA256:${fp.replaceAll("-", "+").replaceAll("_", "/")}`,
		addresses: addresses.filter((a): a is ServerAddress => a !== undefined),
	};
}

/** What `ssh` is asked to connect to: `destination` is `[user@]host` (an IPv6 literal without brackets), `port` only when the target named one. */
export interface SshTarget {
	destination: string;
	port: number | undefined;
}

/** What `/cloud connect` was given: a pairing code, or a machine to pair with over ssh. */
export type ConnectTarget = { kind: "code"; code: PairingCode } | { kind: "ssh"; ssh: SshTarget };

const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** A host name or an ssh_config alias (underscores included, which a DNS name has none of). */
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const SSH_IPV6 = /^[0-9A-Fa-f:.]+(%[\w.-]+)?$/;
const SSH_URI = /^ssh:\/\/(?:([^@/\s]+)@)?(\[[^\]\s]+\]|[^:/\s@[\]]+)(?::(\d{1,5}))?\/?$/i;

export const NOT_A_TARGET =
	"☁ that is not a pairing code or an ssh target (expected ompc1:<offer>:<secret>:<fingerprint>@<host:port>, user@host, a host name, or ssh://[user@]host[:port])";

/** A host name, alias or IP literal ssh accepts after the user; undefined for anything else. IPv6 literals come back without brackets. */
function sshHost(text: string): string | undefined {
	const bare = /^\[(.+)\]$/.exec(text)?.[1] ?? text;
	if (bare.includes(":")) return isIP(bare.replace(/%[\w.-]+$/, "")) === 6 && SSH_IPV6.test(bare) ? bare : undefined;
	return SSH_HOST.test(bare) ? bare : undefined;
}

/**
 * Tells what `/cloud connect` was given: a pairing code (`ompc1:…`, parsed), or an ssh target, `user@host`, a bare
 * host name or `ssh://[user@]host[:port]`. A target that starts with `-` is refused (ssh would read it as an option),
 * and so is anything that is neither. One pair of surrounding quotes or backticks is removed. Throws {@link UserError}
 * without quoting the input.
 */
export function parseConnectTarget(input: string): ConnectTarget {
	let text = input.trim();
	const quote = text[0];
	if (text.length >= 2 && (quote === '"' || quote === "'" || quote === "`") && text.endsWith(quote)) text = text.slice(1, -1).trim();
	if (text.startsWith("-")) throw new UserError("☁ an ssh target cannot start with '-' (ssh would read it as an option)");
	if (text.toLowerCase().startsWith(CODE_MARKER)) return { kind: "code", code: parsePairingCode(text) };

	const uri = SSH_URI.exec(text);
	if (uri) {
		const [, user, hostText, portText] = uri;
		const host = sshHost(hostText ?? "");
		const port = portText === undefined ? undefined : Number(portText);
		if (host === undefined || (user !== undefined && !SSH_USER.test(user)) || (port !== undefined && (port < 1 || port > 65535))) throw new UserError(NOT_A_TARGET);
		return { kind: "ssh", ssh: { destination: user === undefined ? host : `${user}@${host}`, port } };
	}
	const at = text.lastIndexOf("@");
	const user = at < 0 ? undefined : text.slice(0, at);
	const host = sshHost(at < 0 ? text : text.slice(at + 1));
	if (host === undefined || (user !== undefined && !SSH_USER.test(user)) || (host.includes(":") && user === undefined)) throw new UserError(NOT_A_TARGET);
	return { kind: "ssh", ssh: { destination: user === undefined ? host : `${user}@${host}`, port: undefined } };
}

/** The 16 bytes of an IPv6 address (zone dropped, a trailing IPv4 part expanded); undefined when `host` is not one. */
function ipv6Bytes(host: string): number[] | undefined {
	const bare = host.replace(/%[\w.-]+$/, "");
	if (isIP(bare) !== 6) return undefined;
	let tail: number[] = [];
	let head = bare;
	const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
	if (dotted?.[1] !== undefined) {
		const v4 = dotted[1].split(".").map(Number);
		tail = [(((v4[0] ?? 0) << 8) | (v4[1] ?? 0)) >>> 0, (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)) >>> 0];
		head = bare.slice(0, -dotted[1].length);
		if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
	}
	const [left = "", right, extra] = head.split("::");
	if (extra !== undefined) return undefined;
	const groups = (s: string): number[] => (s === "" ? [] : s.split(":").map(g => Number.parseInt(g, 16)));
	const before = groups(left);
	const after = right === undefined ? [] : groups(right);
	const words = right === undefined ? [...before, ...tail] : [...before, ...new Array<number>(8 - before.length - after.length - tail.length).fill(0), ...after, ...tail];
	if (words.length !== 8 || words.some(w => !Number.isInteger(w) || w < 0 || w > 0xffff)) return undefined;
	return words.flatMap(w => [w >> 8, w & 0xff]);
}

function isLocalIPv4([a = 0, b = 0]: readonly number[]): boolean {
	return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/**
 * Whether `host` is loopback, private (10/8, 172.16/12, 192.168/16, 100.64/10), link-local, an IPv6 ULA or link-local
 * address, a single-label name, `localhost`, or a name ending `.local`, `.lan`, `.home.arpa` or `.internal`.
 * Anything else is public: `/cloud connect` refuses it without `--allow-public` (an ssh pairing judges a name by the
 * addresses it resolves to instead). An IPv4-mapped IPv6 address counts as its IPv4 address.
 */
export function isLocalHost(host: string): boolean {
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (isIP(bare) === 4) return isLocalIPv4(bare.split(".").map(Number));
	const v6 = ipv6Bytes(bare);
	if (v6) {
		if (v6.slice(0, 15).every(x => x === 0) && v6[15] === 1) return true;
		if (v6.slice(0, 10).every(x => x === 0) && v6[10] === 0xff && v6[11] === 0xff) return isLocalIPv4(v6.slice(12));
		const [b0 = 0, b1 = 0] = v6;
		return (b0 & 0xfe) === 0xfc || (b0 === 0xfe && (b1 & 0xc0) === 0x80);
	}
	const name = bare.toLowerCase().replace(/\.$/, "");
	if (name === "localhost" || name.endsWith(".localhost") || !name.includes(".")) return true;
	return [".local", ".lan", ".home.arpa", ".internal"].some(suffix => name.endsWith(suffix));
}
