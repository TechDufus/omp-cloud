/**
 * Pairing over ssh: the one place that runs `ssh`. `/cloud connect <target>` asks the server's own `omp-cloud
 * ssh-pair` (reached through ssh, whose host key and login are the proof of ownership) for a device, and gets its
 * token, certificate and addresses back as one JSON line. This module builds the command line (every remote argument
 * quoted), runs it, reads the record and turns failures into hints. It never prints the token: the record is parsed
 * and handed on, and no message here quotes stdout.
 */

import { X509Certificate } from "node:crypto";
import { clip } from "./format";
import { isRecord } from "./guards";
import { fingerprintOf, fingerprintsMatch, parseServerAddress, type ServerAddress, type SshTarget } from "./pairing";
import { UserError, type DeviceRef } from "./types";

/** What an ssh run left behind. `exitCode` is null when the process was killed. */
export interface SshOutput {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Runs `argv` (executable first) with stdin ignored. The real one is {@link spawnSsh}; tests give a fake. */
export type SshRunner = (argv: readonly string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<SshOutput>;

/** The overall limit of the pairing call: it spans the connection, the login and the server's database write. */
export const PAIR_TIMEOUT_MS = 60_000;
/** `ssh -G` prints the effective settings (the host name included) without connecting, so it only reads configuration and needs far less. */
const CONFIG_TIMEOUT_MS = 10_000;
/** The last bytes of each stream kept: a banner comes first, the record is the last line. */
const MAX_OUTPUT = 1 << 20;
/** How long the streams get to end after the process has: a ProxyCommand child may hold them open. */
const DRAIN_GRACE_MS = 2000;
const TOKEN_TEXT = /ompd_[A-Za-z0-9_-]+/g;
const TOKEN_SHAPE = /^ompd_[A-Za-z0-9_-]{43}$/;
const MAX_ADDRESSES = 8;

/** The ssh program: `OMP_CLOUD_SSH` (a file name, no arguments) or `ssh`. */
export function sshExecutable(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const named = env.OMP_CLOUD_SSH?.trim();
	return named ? named : "ssh";
}

/** `arg` as one word of a POSIX shell, and of fish: single-quoted, each `'` written `'\''`. */
export function quoteArg(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * What the remote login shell is asked to run, whatever its syntax: `sh -c` with a fixed script that execs
 * `omp-cloud` from PATH, else `$HOME/.local/bin/omp-cloud` (where `omp-cloud setup` installs it), given `args`. Every word
 * is single-quoted; the script holds no single quote and its `$HOME` and `$@` are for the inner `sh`.
 */
export function remoteCommand(args: readonly string[]): string {
	const script = 'if command -v omp-cloud >/dev/null 2>&1; then exec omp-cloud "$@"; fi; exec "$HOME/.local/bin/omp-cloud" "$@"';
	return ["sh", "-c", script, "sh", ...args].map(quoteArg).join(" ");
}

function portArgs(target: SshTarget): string[] {
	return target.port === undefined ? [] : ["-p", String(target.port)];
}

/** The ssh command line of the pairing call. `-T` and `BatchMode=yes` keep ssh from ever prompting (a password, a tty); `ConnectTimeout=10` bounds the connection. */
export function pairArgv(executable: string, target: SshTarget, name: string, platform: string): string[] {
	return [
		executable,
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=10",
		...portArgs(target),
		"--",
		target.destination,
		remoteCommand(["ssh-pair", "--name", name, "--platform", platform]),
	];
}

/** One line of text with every control and format character (escape sequences, bidi overrides) removed, short, and no token. */
export function excerpt(text: string, max = 200): string {
	const plain = text
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(TOKEN_TEXT, "ompd_…");
	return clip(plain, max);
}

function describe(target: SshTarget): string {
	return target.port === undefined ? target.destination : `${target.destination} (port ${target.port})`;
}

/** `ssh [-p N] <destination>`: what the user runs by hand. */
function manualCommand(target: SshTarget): string {
	return ["ssh", ...portArgs(target), target.destination].join(" ");
}

/** Reads `stream` into `into.text`, keeping the last {@link MAX_OUTPUT} characters. */
async function collect(stream: ReadableStream<Uint8Array>, into: { text: string }): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		into.text += decoder.decode(chunk, { stream: true });
		if (into.text.length > MAX_OUTPUT) into.text = into.text.slice(-MAX_OUTPUT);
	}
}

/** The real {@link SshRunner}: kills the process on timeout or abort; an abort by the caller throws. */
export const spawnSsh: SshRunner = async (argv, { timeoutMs, signal }) => {
	const timeout = AbortSignal.timeout(timeoutMs);
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		throw new UserError(`☁ cannot run ${argv[0] ?? "ssh"} (${excerpt(why)}); install an ssh client, or set OMP_CLOUD_SSH to its path`);
	}
	const out = { text: "" };
	const err = { text: "" };
	const streams = Promise.all([collect(proc.stdout, out), collect(proc.stderr, err)]);
	const exited = await proc.exited;
	await Promise.race([streams, Bun.sleep(DRAIN_GRACE_MS)]);
	if (signal?.aborted) throw new UserError("☁ connect cancelled");
	return { exitCode: timeout.aborted ? null : exited, stdout: out.text, stderr: err.text, timedOut: timeout.aborted };
};

/** The last stdout line that is a JSON object with `ompCloudPair: 1`; banners and other output before it are skipped. */
function lastRecord(stdout: string): Record<string, unknown> | undefined {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = (lines[i] ?? "").trim();
		if (!line.startsWith("{")) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRecord(value) && value.ompCloudPair === 1) return value;
	}
	return undefined;
}

/** What the server delivered over ssh. `addresses` are the server's own, as valid `host:port` entries. */
export interface SshPairing {
	device: DeviceRef;
	token: string;
	fingerprint: string;
	/** Base64 DER; it hashes to `fingerprint`. */
	certificate: string;
	port: number;
	addresses: ServerAddress[];
}

/** The pairing in `record`; undefined when it is not one (wrong shapes, a token or certificate that cannot be right). */
function readPairing(record: Record<string, unknown>): SshPairing | undefined {
	const { device, token, server } = record;
	if (!isRecord(device) || typeof device.id !== "string" || typeof device.name !== "string" || device.id === "" || device.name === "") return undefined;
	if (typeof token !== "string" || !TOKEN_SHAPE.test(token) || !isRecord(server)) return undefined;
	const { fingerprint, certificate, port, addresses } = server;
	if (typeof fingerprint !== "string" || typeof certificate !== "string" || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	if (!Array.isArray(addresses)) return undefined;
	let der: Buffer;
	try {
		der = new X509Certificate(Buffer.from(certificate, "base64")).raw;
	} catch {
		return undefined;
	}
	if (!fingerprintsMatch(fingerprintOf(der), fingerprint)) return undefined;
	const listed = addresses.flatMap(a => (typeof a === "string" ? [parseServerAddress(a)] : [])).filter((a): a is ServerAddress => a !== undefined);
	return { device: { id: device.id, name: device.name }, token, fingerprint, certificate, port, addresses: listed };
}

/** The error of an ssh run that did not deliver a pairing: a hint where the failure is a known one. */
function failure(out: SshOutput, target: SshTarget): UserError {
	const where = describe(target);
	const manual = manualCommand(target);
	if (out.timedOut) return new UserError(`☁ ssh to ${where} timed out after ${PAIR_TIMEOUT_MS / 1000} s; check that the host is reachable and runs sshd (${manual} shows what ssh says)`);
	if (out.exitCode === 127) return new UserError(`☁ omp-cloud is not installed on ${where}: install it there and run omp-cloud setup`);
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(out.stderr)) {
		return new UserError(`☁ the host key of ${where} changed since you last connected, so ssh refused it: find out why before you retry, and only then remove the old key with ssh-keygen -R`);
	}
	if (/Host key verification failed/i.test(out.stderr)) {
		return new UserError(`☁ ssh does not know the host key of ${where}: run ${manual} once to accept its host key, then retry`);
	}
	if (/Permission denied \(/i.test(out.stderr)) {
		const copy = ["ssh-copy-id", ...portArgs(target), target.destination].join(" ");
		return new UserError(`☁ ssh to ${where} was refused: set up key-based ssh (${copy}); /cloud connect never asks for a password`);
	}
	const said = excerpt(out.stderr);
	if (out.exitCode !== 0) return new UserError(`☁ ssh to ${where} failed (exit ${out.exitCode ?? "none"})${said === "" ? "" : `: ${said}`}`);
	return new UserError(`☁ ${where} did not answer with a pairing record; does the server's omp-cloud have ssh-pair (run omp-cloud setup on the server)?`);
}

export interface SshPairInput {
	target: SshTarget;
	name: string;
	platform: string;
	run: SshRunner;
	signal?: AbortSignal;
	env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Asks the server behind `target` for a device named `name`. Throws {@link UserError} with the hint for a missing
 * `omp-cloud`, an unknown host key, a refused login, a timeout, a refusal by the server, or output that is no record.
 */
export async function pairOverSsh(input: SshPairInput): Promise<SshPairing> {
	const { target, run, signal } = input;
	const out = await run(pairArgv(sshExecutable(input.env), target, input.name, input.platform), { timeoutMs: PAIR_TIMEOUT_MS, signal });
	const record = lastRecord(out.stdout);
	if (record !== undefined && typeof record.error === "string") throw new UserError(`☁ the server on ${describe(target)} refused: ${excerpt(record.error, 300)}`);
	if (out.exitCode !== 0 || out.timedOut || record === undefined) throw failure(out, target);
	const pairing = readPairing(record);
	if (pairing === undefined) throw new UserError(`☁ ${describe(target)} answered with a pairing record that is not valid; does the server's omp-cloud have ssh-pair (run omp-cloud setup on the server)?`);
	return pairing;
}

/**
 * The host name ssh itself would connect to for `target` (the `hostname` of `ssh -G`, after ssh_config), or what went
 * wrong, in words for the user.
 */
export async function sshHostName(input: SshPairInput): Promise<{ host: string; problem?: undefined } | { host?: undefined; problem: string }> {
	const { target, signal } = input;
	let out: SshOutput;
	try {
		out = await input.run([sshExecutable(input.env), "-G", ...portArgs(target), "--", target.destination], { timeoutMs: CONFIG_TIMEOUT_MS, signal });
	} catch (e) {
		if (signal?.aborted) throw e;
		return { problem: `could not ask ssh for the host name of ${describe(target)} (${excerpt(e instanceof Error ? e.message : String(e))})` };
	}
	const host = /^hostname\s+(\S+)\s*$/im.exec(out.stdout)?.[1];
	if (out.exitCode !== 0 || host === undefined) return { problem: `ssh -G did not give a host name for ${describe(target)}${out.exitCode === 0 ? "" : ` (exit ${out.exitCode ?? "none"})`}` };
	return { host };
}

/** The addresses to try: `host` (as ssh resolves the target) with the port the server reported, then the server's own. */
export function pairingAddresses(host: string | undefined, pairing: Pick<SshPairing, "port" | "addresses">): { addresses: ServerAddress[]; problem?: string } {
	const seen = new Set<string>();
	const addresses: ServerAddress[] = [];
	let problem: string | undefined;
	let first: ServerAddress | undefined;
	if (host !== undefined) {
		first = parseServerAddress(host.includes(":") ? `[${host}]:${pairing.port}` : `${host}:${pairing.port}`);
		if (first === undefined) problem = `ssh names the host ${excerpt(host, 80)}, which is not an address this machine can connect to, so it was skipped`;
	}
	for (const a of first === undefined ? pairing.addresses : [first, ...pairing.addresses]) {
		const key = a.text.toLowerCase();
		if (seen.has(key) || addresses.length >= MAX_ADDRESSES) continue;
		seen.add(key);
		addresses.push(a);
	}
	return { addresses, problem };
}
