/**
 * `/cloud connect`: pairs this machine with a service from a pairing code, or over ssh with the machine the service
 * runs on. Either way the service's certificate fingerprint is known before anything is sent to an address: a code
 * names it, ssh delivers it. Nothing is sent to an address until the certificate it presents has that fingerprint, and
 * every request after that trusts only that certificate.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { CloudClient } from "./api";
import { noticeCard, type NoticeCard } from "./cards";
import { readConnectionFile, writeConnectionFile, type PairedConnection, type ServerPin } from "./connection";
import { CloudError } from "./errors";
import {
	defaultDeviceName,
	fingerprintOf,
	fingerprintsMatch,
	isDeviceName,
	isLocalHost,
	parseConnectTarget,
	type PairingCode,
	type ServerAddress,
	type SshTarget,
} from "./pairing";
import { pairingAddresses, pairOverSsh, spawnSsh, sshHostName, type SshRunner } from "./ssh";
import { pinnedFetch, readServerCertificate } from "./transport";
import { UserError, type Claim, type DeviceRef, type HostUi } from "./types";

export interface ConnectInput {
	/** A pairing code or an ssh target (`user@host`, a host name, `ssh://[user@]host[:port]`) as typed or pasted. */
	target: string;
	name: string | undefined;
	replace: boolean;
	allowPublic: boolean;
}

/** What the tool's `connect` reports: the card's lines plus what the pairing wrote and whether this session switched to it. */
export interface ConnectOutcome {
	lines: string[];
	/** This session uses the new pairing now. */
	using: boolean;
	/** The server's host, as `/cloud status` names it. */
	server: string;
	/** This device's name on the server. */
	device: string;
}

export interface ConnectDeps {
	/** Where `connection.json` lives. */
	connectionFile: string;
	ui: Pick<HostUi, "notify" | "setWidget">;
	/** The certificate (DER) an address presents; the real one reads it without verifying. */
	readCertificate?: (address: ServerAddress) => Promise<Buffer>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Milliseconds between claims; 1500 by default. */
	pollMs?: number;
	/** The machine's name, the default device name. */
	hostName?: string;
	/** Every address a host name resolves to; the real one asks the system resolver. */
	resolve?: (host: string) => Promise<string[]>;
	/** Runs ssh; the real one spawns it. */
	ssh?: SshRunner;
	/** Ends the ssh run. */
	signal?: AbortSignal;
	/** Where `OMP_CLOUD_SSH` is read from; the process environment by default. */
	env?: Readonly<Record<string, string | undefined>>;
}

async function resolveHost(host: string): Promise<string[]> {
	return (await lookup(host, { all: true })).map(r => r.address);
}

const WIDGET_KEY = "omp-cloud-connect";
const DEFAULT_POLL_MS = 1500;
const FALLBACK_WAIT_MS = 5 * 60_000;
/** Consecutive failed claims that end the wait. */
const MAX_CLAIM_FAILURES = 5;
/** The follow-up requests (revoking the old device, the whoami check) are tried once: a slow retry would only delay a notice. */
const SINGLE_ATTEMPT = { backoffMs: [] } as const;

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** `m:ss` for `ms` milliseconds. */
export function countdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** One address of a code as connected to: the text the code gave (what the file stores), what to show, and the vetted IP literal. */
interface Target {
	code: ServerAddress;
	shown: string;
	ip: ServerAddress;
}

/**
 * Resolves each name of `addresses` exactly once and vets what it resolved to. A name that does not resolve is skipped
 * and reported; a name that resolves to an address that is not local (unless `allowPublic`) refuses the whole code.
 * The targets carry IP literals: nothing after this connects by name.
 */
async function resolveTargets(addresses: ServerAddress[], allowPublic: boolean, resolve: (host: string) => Promise<string[]>): Promise<{ targets: Target[]; problems: string[] }> {
	if (!allowPublic) {
		const outside = addresses.find(a => !isLocalHost(a.host));
		if (outside) {
			throw new UserError(`☁ ${outside.text} is not a local address; connecting over the public internet needs --allow-public, and only for a code the server's owner gave you`);
		}
	}
	const targets: Target[] = [];
	const problems: string[] = [];
	for (const a of addresses) {
		if (isIP(a.host.replace(/%[\w.-]+$/, "")) !== 0) {
			targets.push({ code: a, shown: a.text, ip: a });
			continue;
		}
		let resolved: string[];
		try {
			resolved = await resolve(a.host);
		} catch (e) {
			problems.push(`${a.text} cannot be resolved (${errorText(e)}), so it was skipped`);
			continue;
		}
		if (resolved.length === 0) {
			problems.push(`${a.text} resolves to no address, so it was skipped`);
			continue;
		}
		const away = resolved.find(ip => !isLocalHost(ip));
		if (!allowPublic && away !== undefined) {
			throw new UserError(`☁ ${a.text} resolves to ${away}, which is not a local address; connecting over the public internet needs --allow-public, and only for a code the server's owner gave you`);
		}
		for (const ip of resolved) {
			targets.push({ code: a, shown: `${a.text} (${ip})`, ip: { host: ip, port: a.port, text: ip.includes(":") ? `[${ip}]:${a.port}` : `${ip}:${a.port}` } });
		}
	}
	return { targets, problems };
}

/**
 * Reads the certificate of every target (by IP) and keeps those that present `fingerprint`, which `source` says where
 * it came from ("the code names", "ssh delivered"). `pin.addresses` are the address texts that did (what the file
 * stores); `ips` the vetted literals to connect to meanwhile.
 */
async function verifyAddresses(
	targets: Target[],
	fingerprint: string,
	read: (a: ServerAddress) => Promise<Buffer>,
	source: string,
): Promise<{ pin: { pin: ServerPin; ips: string[] } | undefined; problems: string[] }> {
	const outcomes = await Promise.allSettled(targets.map(t => read(t.ip)));
	const problems: string[] = [];
	let der: Buffer | undefined;
	const verified: string[] = [];
	const ips: string[] = [];
	for (const [i, outcome] of outcomes.entries()) {
		const t = targets[i];
		if (!t) continue;
		if (outcome.status === "rejected") {
			problems.push(`${t.shown} did not answer (${errorText(outcome.reason)})`);
		} else if (fingerprintsMatch(fingerprintOf(outcome.value), fingerprint)) {
			der ??= outcome.value;
			if (!verified.includes(t.code.text)) verified.push(t.code.text);
			ips.push(t.ip.text);
		} else {
			problems.push(`${t.shown} presents a different certificate than ${source}, so nothing was sent to it`);
		}
	}
	if (der === undefined) return { pin: undefined, problems };
	return { pin: { pin: { fingerprint: fingerprintOf(der), certificate: der.toString("base64"), addresses: verified }, ips }, problems };
}

/** The old device of a `--replace`, revoked best effort; the user is told either way. */
async function revokeOld(old: PairedConnection, ui: Pick<HostUi, "notify">): Promise<void> {
	try {
		await new CloudClient(`https://${old.server.addresses[0] ?? ""}`, old.token, pinnedFetch(old.server), SINGLE_ATTEMPT).revokeDevice(old.device.id);
		ui.notify(`☁ revoked the old device ${old.device.name}`, "info");
	} catch (e) {
		ui.notify(`☁ could not revoke the old device ${old.device.name} (${errorText(e)}); its token stays valid until it is revoked from the server machine`, "warning");
	}
}

/** What a pairing flow hands to the common end: the device, its token, and the server as verified. */
interface Paired {
	device: DeviceRef;
	token: string;
	pin: ServerPin;
	/** `pin` with the vetted IP literals as addresses: what every request connects to until the file is written. */
	wire: ServerPin;
	firstIp: string;
}

/** What both flows share. */
interface Session {
	input: ConnectInput;
	deps: ConnectDeps;
	name: string;
	existing: PairedConnection | undefined;
	now: () => number;
}

/** What a flow knows about the server it is about to trust: the fingerprint and where it came from, problems found so far, and text for a refusal's end. */
interface Expected {
	fingerprint: string;
	/** For "presents a different certificate than …". */
	source: string;
	notes: string[];
	after: string;
}

/**
 * Vets `addresses`, reads each one's certificate and keeps those that present the expected fingerprint: nothing is
 * sent to an address before that. Then revokes the device of a `--replace`. `expected.after` is appended to whatever
 * refuses.
 */
async function verifyServer(addresses: ServerAddress[], s: Session, expected: Expected): Promise<Pick<Paired, "pin" | "wire" | "firstIp">> {
	const { fingerprint, source, notes, after } = expected;
	let verified: { pin: ServerPin; ips: string[] };
	try {
		const { targets, problems: unresolved } = await resolveTargets(addresses, s.input.allowPublic, s.deps.resolve ?? resolveHost);
		const { pin, problems } = await verifyAddresses(targets, fingerprint, s.deps.readCertificate ?? readServerCertificate, source);
		if (pin === undefined) throw new UserError(`☁ cannot pair: ${[...notes, ...unresolved, ...problems].join("; ")}`);
		verified = pin;
	} catch (e) {
		throw e instanceof UserError && after !== "" ? new UserError(`${e.message}${after}`) : e;
	}
	if (s.existing) await revokeOld(s.existing, s.deps.ui);
	// Everything until the file is written connects to the vetted IP literals, never to a name again.
	return { pin: verified.pin, wire: { ...verified.pin, addresses: verified.ips }, firstIp: verified.ips[0] ?? "" };
}

/** The pairing-code flow: redeem the code, then wait for the owner to approve on the server machine. */
async function pairWithCode(code: PairingCode, s: Session): Promise<Paired> {
	const { ui } = s.deps;
	const sleep = s.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	const server = await verifyServer(code.addresses, s, { fingerprint: code.fingerprint, source: "the code names", notes: [], after: "" });
	const anonymous = new CloudClient(`https://${server.firstIp}`, "", pinnedFetch(server.wire));
	const redeemed = await anonymous.redeemPairing({ offer: code.offer, secret: code.secret, name: s.name, platform: process.platform });
	const expiresAt = Number.isNaN(Date.parse(redeemed.expiresAt)) ? s.now() + FALLBACK_WAIT_MS : Date.parse(redeemed.expiresAt);

	let claimed: Extract<Claim, { status: "paired" }> | undefined;
	try {
		for (let failures = 0; claimed === undefined; ) {
			const left = expiresAt - s.now();
			if (left <= 0) throw new UserError("☁ the pairing request expired before it was approved; run /cloud pair again on the server machine");
			ui.setWidget(WIDGET_KEY, [`☁ waiting for approval on the server machine · expires in ${countdown(left)}`, `  this device: ${s.name} · server ${server.pin.fingerprint}`]);
			let claim: Claim | undefined;
			try {
				claim = await anonymous.claimPairing({ request: redeemed.request, requestSecret: redeemed.requestSecret });
				failures = 0;
			} catch (e) {
				if ((e instanceof CloudError && !e.retriable) || ++failures >= MAX_CLAIM_FAILURES) throw e;
			}
			if (claim?.status === "declined") throw new UserError("☁ the owner declined this device");
			if (claim?.status === "paired") claimed = claim;
			else await sleep(s.deps.pollMs ?? DEFAULT_POLL_MS);
		}
	} finally {
		ui.setWidget(WIDGET_KEY, undefined);
	}
	return { device: claimed.device, token: claimed.token, ...server };
}

/**
 * The ssh flow: the server's own `omp-cloud ssh-pair` mints the device and delivers its token, certificate and
 * addresses through the ssh session, so there is no approval to wait for. Nothing is sent to any address until its
 * certificate matches the fingerprint ssh delivered.
 */
async function pairWithSsh(target: SshTarget, s: Session): Promise<Paired> {
	const ssh = { target, name: s.name, platform: process.platform, run: s.deps.ssh ?? spawnSsh, signal: s.deps.signal, env: s.deps.env };
	const pairing = await pairOverSsh(ssh);
	const unused = `; the device ${pairing.device.name} was created on the server and is not used: /cloud devices revoke ${pairing.device.name} on the server machine removes it`;
	const named = await sshHostName(ssh);
	const { addresses, problem } = pairingAddresses(named.host, pairing);
	const notes = [named.problem, problem].filter((p): p is string => p !== undefined);
	if (addresses.length === 0) throw new UserError(`☁ cannot pair: ${notes.join("; ")}; the server listed no usable address${unused}`);
	const server = await verifyServer(addresses, s, { fingerprint: pairing.fingerprint, source: "the one ssh delivered", notes, after: unused });
	return { device: pairing.device, token: pairing.token, ...server };
}

/**
 * Pairs with the service `input.target` names, a pairing code or an ssh target, and writes the connection file. A code
 * waits for the owner's approval on the server machine, showing a countdown. Returns the card to show: it names the
 * server and this device, never a secret.
 */
export async function runConnect(input: ConnectInput, deps: ConnectDeps): Promise<NoticeCard> {
	const { ui } = deps;
	const now = deps.now ?? Date.now;
	const target = parseConnectTarget(input.target);
	const name = (input.name ?? defaultDeviceName(deps.hostName ?? hostname())).trim();
	if (!isDeviceName(name)) throw new UserError("☁ a device name is 1–64 letters, digits, spaces, '.', '_' or '-'");

	let existing: PairedConnection | undefined;
	try {
		existing = await readConnectionFile(deps.connectionFile);
	} catch (e) {
		if (!input.replace) throw e;
		ui.notify("☁ the existing connection file is not valid and is replaced", "warning");
	}
	if (existing && !input.replace) {
		throw new UserError(
			`☁ this machine is already connected to ${existing.server.fingerprint} as ${existing.device.name}; /cloud connect --replace <code or host> pairs again (and revokes that device), /cloud disconnect forgets it`,
		);
	}

	const session: Session = { input, deps, name, existing, now };
	const paired = target.kind === "code" ? await pairWithCode(target.code, session) : await pairWithSsh(target.ssh, session);

	const { pin, wire, firstIp, device, token } = paired;
	const connection: PairedConnection = { server: pin, device, token, pairedAt: new Date(now()).toISOString() };
	await writeConnectionFile(deps.connectionFile, connection);

	const lines = [`server ${pin.fingerprint} at ${pin.addresses[0] ?? ""}`, `this device: ${device.name} (${device.id.slice(0, 8)})`];
	try {
		const who = await new CloudClient(`https://${firstIp}`, connection.token, pinnedFetch(wire), SINGLE_ATTEMPT).whoami();
		if (who.device?.id !== device.id) lines.push("warning: the service does not name this device in whoami");
	} catch (e) {
		lines.push(`warning: connected, but the first request failed: ${errorText(e)}`);
	}
	return noticeCard("", "Connected to omp-cloud", lines);
}
