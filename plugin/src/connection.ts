/**
 * The paired connection: `<config home>/omp-cloud/connection.json` holds the server's pinned certificate, the addresses
 * to reach it and this device's token. It is read strictly and fails closed: a file that does not validate is an error,
 * never a reason to fall back to system roots or to another credential.
 *
 * File modes carry the secrecy on POSIX (file 0600, a directory this module creates 0700). They mean nothing on Windows,
 * where this module sets none and checks none; the file then relies on the user profile's own ACLs.
 */

import { randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord } from "./guards";
import { fingerprintOf, parseServerAddress } from "./pairing";
import { UserError, type DeviceRef } from "./types";

/** What a paired connection pins: the server's certificate (base64 DER), its fingerprint and the addresses to try, in order. */
export interface ServerPin {
	fingerprint: string;
	certificate: string;
	addresses: string[];
}

export interface PairedConnection {
	server: ServerPin;
	device: DeviceRef;
	/** `ompd_…`: the credential of this device. Never shown, never logged. */
	token: string;
	/** ISO 8601. */
	pairedAt: string;
}

const VERSION = 1;
const TOKEN = /^ompd_[A-Za-z0-9_-]{43}$/;
const MAX_ADDRESSES = 8;

function invalid(path: string, why: string): UserError {
	return new UserError(`☁ ${path} is not a valid connection record (${why}); /cloud disconnect --force removes it, /cloud connect pairs again`);
}

/** The keys of `o` that are not in `allowed`. */
function unknownKeys(o: Record<string, unknown>, allowed: readonly string[]): string[] {
	return Object.keys(o).filter(k => !allowed.includes(k));
}

function nonEmpty(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

/** The record `doc` describes, or a {@link UserError} naming `path` and the first thing wrong (never a value). */
function parseRecord(path: string, doc: unknown): PairedConnection {
	if (!isRecord(doc)) throw invalid(path, "not an object");
	if (doc.version !== VERSION) throw invalid(path, "unsupported version");
	if (unknownKeys(doc, ["version", "server", "device", "token", "pairedAt"]).length > 0) throw invalid(path, "unknown key");
	const { server, device } = doc;
	if (!isRecord(server) || unknownKeys(server, ["fingerprint", "certificate", "addresses"]).length > 0) throw invalid(path, "server");
	if (!isRecord(device) || unknownKeys(device, ["id", "name"]).length > 0 || !nonEmpty(device.id) || !nonEmpty(device.name)) throw invalid(path, "device");
	if (typeof doc.token !== "string" || !TOKEN.test(doc.token)) throw invalid(path, "token");
	if (typeof doc.pairedAt !== "string" || Number.isNaN(Date.parse(doc.pairedAt))) throw invalid(path, "pairedAt");
	const { fingerprint, certificate, addresses } = server;
	if (typeof certificate !== "string" || certificate === "" || Buffer.from(certificate, "base64").toString("base64") !== certificate) throw invalid(path, "server.certificate");
	const der = Buffer.from(certificate, "base64");
	try {
		new X509Certificate(der);
	} catch {
		throw invalid(path, "server.certificate is not a certificate");
	}
	if (typeof fingerprint !== "string" || fingerprint !== fingerprintOf(der)) throw invalid(path, "server.fingerprint does not match server.certificate");
	if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > MAX_ADDRESSES) throw invalid(path, "server.addresses");
	const texts = addresses.map(a => (typeof a === "string" ? parseServerAddress(a)?.text : undefined));
	if (texts.some(t => t === undefined)) throw invalid(path, "server.addresses");
	return {
		server: { fingerprint, certificate, addresses: texts.filter((t): t is string => t !== undefined) },
		device: { id: device.id, name: device.name },
		token: doc.token,
		pairedAt: doc.pairedAt,
	};
}

/**
 * The paired connection in `path`; undefined when there is no file. Throws a {@link UserError} when the file cannot be
 * read, is group- or world-accessible (POSIX), is not JSON or does not validate.
 */
export async function readConnectionFile(path: string): Promise<PairedConnection | undefined> {
	let text: string;
	try {
		const handle = await open(path, "r");
		try {
			if (process.platform !== "win32" && ((await handle.stat()).mode & 0o077) !== 0) {
				throw new UserError(`☁ ${path} is readable by other users; chmod 600 it, or /cloud disconnect --force and pair again`);
			}
			text = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch (e) {
		if (e instanceof UserError) throw e;
		const code = e instanceof Error ? Reflect.get(e, "code") : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw new UserError(`☁ ${path} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
	}
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		throw invalid(path, "not JSON");
	}
	return parseRecord(path, doc);
}

/** Writes `connection` to `path` through a temp file opened 0600 in the same directory (made or tightened to 0700), then renames it into place. */
export async function writeConnectionFile(path: string, connection: PairedConnection): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	// `mkdir` leaves a directory that already exists as it was: the one holding the token must not be open to others.
	if (process.platform !== "win32") await chmod(dir, 0o700);
	const temp = join(dir, `.connection.${randomBytes(6).toString("hex")}.tmp`);
	const body = {
		version: VERSION,
		server: { fingerprint: connection.server.fingerprint, certificate: connection.server.certificate, addresses: connection.server.addresses },
		device: { id: connection.device.id, name: connection.device.name },
		token: connection.token,
		pairedAt: connection.pairedAt,
	};
	parseRecord(path, body);
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (e) {
		await rm(temp, { force: true });
		throw e;
	}
}
