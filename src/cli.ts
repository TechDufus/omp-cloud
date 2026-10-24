/**
 * `omp-cloud`: the service host's command line. Two subcommands run here (over ssh):
 *
 *   omp-cloud ssh-pair --name <name> --platform <platform> [--config <path>]
 *   omp-cloud node-join-info [--member <ipv4>] [--config <path>]
 *
 * `ssh-pair` pairs a device without the offer/approve dance: whoever can run this has a login on the service's account,
 * which is the proof of ownership (the client reaches it over SSH, `/cloud connect user@host`). It needs only `dataDir`
 * and `remote` from service.json (the file is parsed as the service parses it; nothing it names is contacted), so it
 * works while vmon and the gateway are down, and opens the store directly: SQLite's WAL and busy timeout make that safe
 * next to the running service, which looks a token up in the database on every request.
 *
 * `node-join-info` tells `omp-cloud setup node --join` what a vibemon machine needs to join this server's cluster (the
 * server's address and certificate pin, vibemon's version, the cluster secret), or with `--member <ip>` whether the
 * server's vibemon sees that machine yet. It reads service.json and the files it names, never the store; the cluster
 * secret is in the record by design: the record travels over the ssh session the owner authenticated.
 *
 * The last line of stdout is one JSON object (`{"ompCloudPair": 1, ...}` or `{"ompCloudNode": 1, ...}`: the result or an
 * `error`), exit status 1 on failure. Nothing else goes to stdout; the token and the secret appear nowhere else.
 */
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { loadConfig, resolveConfigPath } from "./config";
import { loadIdentity, spkiPin } from "./pairing/identity";
import { parseDeviceName, parsePlatform } from "./pairing/names";
import { advertiseAddresses } from "./pairing/remote";
import { newDeviceToken, randomBase64Url, sha256Hex } from "./pairing/secrets";
import { OWNER } from "./server/auth";
import { SchemaVersionError, Store } from "./store";
import { API_VERSION, SERVICE_VERSION } from "./version";
import { VmonAdmin, VmonAdminRefused } from "./vmon/admin";
import { installedVmonVersion } from "./vmon/pin";

const USAGE = "usage: omp-cloud ssh-pair --name <name> --platform <platform> [--config <path>]";

/** What `ssh-pair` prints: the paired device and what the client needs to reach the service, or the reason it failed. */
export type PairOutput =
	| {
			ompCloudPair: 1;
			device: { id: string; name: string };
			token: string;
			server: { fingerprint: string; certificate: string; port: number; addresses: string[] };
			service: { version: string; api: number };
	  }
	| { ompCloudPair: 1; error: string };

interface PairArgs {
	name: string;
	platform: string;
	configPath: string;
}

/** The flags of `ssh-pair`, each exactly once with a value; the name and platform are validated like a pairing request's. */
function parsePairArgs(args: readonly string[], env: Record<string, string | undefined>): PairArgs {
	const flags = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag !== "--name" && flag !== "--platform" && flag !== "--config") throw new Error(`unknown argument ${JSON.stringify(flag)}; ${USAGE}`);
		const value = args[++i];
		if (value === undefined) throw new Error(`${flag} needs a value; ${USAGE}`);
		if (flags.has(flag)) throw new Error(`${flag} given twice; ${USAGE}`);
		flags.set(flag, value);
	}
	const rawName = flags.get("--name");
	const rawPlatform = flags.get("--platform");
	if (rawName === undefined || rawPlatform === undefined) throw new Error(`--name and --platform are required; ${USAGE}`);
	const name = parseDeviceName(rawName);
	if (name === null) throw new Error("invalid name: 1 to 64 characters of letters, digits, spaces, '.', '_' and '-'");
	const platform = parsePlatform(rawPlatform);
	if (platform === null) throw new Error("invalid platform: 1 to 32 characters of letters, digits, '.', '_' and '-'");
	const fromEnv = env.OMP_CLOUD_CONFIG;
	const configPath = flags.get("--config") ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
	return { name, platform, configPath: resolveConfigPath(configPath) };
}

/** The client address sshd reports (`SSH_CONNECTION`, else `SSH_CLIENT`: its first word), else `ssh`. A value that is not an IP literal is not trusted. */
function pairedFrom(env: Record<string, string | undefined>): string {
	const address = (env.SSH_CONNECTION ?? env.SSH_CLIENT ?? "").split(" ")[0] ?? "";
	return /^[0-9a-fA-F:.]{2,45}$/.test(address) ? address : "ssh";
}

/**
 * Pairs a device named `--name` on `--platform` and returns what `ssh-pair` prints. Every failure is an `error` result:
 * no `remote` section, an unreadable or world-readable key, a bad name or platform, a missing database, a database whose
 * schema version is not this code's (the CLI never migrates a database the running service owns).
 */
export async function sshPair(args: readonly string[], env: Record<string, string | undefined>): Promise<PairOutput> {
	try {
		const parsed = parsePairArgs(args, env);
		const config = await loadConfig(parsed.configPath);
		if (config.remote === undefined) throw new Error(`${parsed.configPath} has no "remote" section: the service has no listener for other machines`);
		// Before a token exists: a key that cannot be read must not leave a device behind.
		const identity = await loadIdentity(config.remote);
		if (!existsSync(join(config.dataDir, "omp-cloud.db"))) throw new Error(`no omp-cloud database in ${config.dataDir}: has the service run on this account?`);
		const token = newDeviceToken();
		let store: Store;
		try {
			store = Store.open({ dataDir: config.dataDir, migrate: false });
		} catch (error) {
			if (!(error instanceof SchemaVersionError)) throw error;
			const state = `the service database is at schema ${error.found}, this omp-cloud expects ${error.expected}`;
			throw new Error(
				error.found < error.expected
					? `${state}: restart the omp-cloud service first`
					: `${state}: this omp-cloud checkout is older than the service; update it (git pull) first`,
			);
		}
		let device: { id: string; name: string };
		try {
			device = store.addDevice({
				id: randomBase64Url(9),
				owner: OWNER,
				name: parsed.name,
				platform: parsed.platform,
				tokenSha256: sha256Hex(token),
				pairedFrom: pairedFrom(env),
				// Reaching the service's account over ssh is the proof of ownership: the device is the owner, with full access.
				access: "full",
			});
		} finally {
			store.close();
		}
		return {
			ompCloudPair: 1,
			device,
			token,
			server: {
				fingerprint: identity.fingerprint,
				certificate: new X509Certificate(identity.cert).raw.toString("base64"),
				port: config.remote.listen.port,
				addresses: advertiseAddresses(config.remote),
			},
			service: { version: SERVICE_VERSION, api: API_VERSION },
		};
	} catch (error) {
		return { ompCloudPair: 1, error: error instanceof Error ? error.message : String(error) };
	}
}

const NODE_USAGE = "usage: omp-cloud node-join-info [--member <ipv4>] [--config <path>]";

/** What `node-join-info` prints: what a machine needs to join (`server`, `vmon`), or the server's view of one (`member`), or the reason it failed. */
export type NodeJoinOutput =
	| {
			ompCloudNode: 1;
			server: { address: string; remotePort: number; pin: string; version: string };
			vmon: { version: string; join: string; clusterSecret: string };
	  }
	| { ompCloudNode: 1; member: { hostname: string; status: string; version: string } }
	| { ompCloudNode: 1; error: string };

/** The seams of `--member`'s wait and of the checks that read the host; the defaults are the real ones. */
export interface NodeJoinOptions {
	/** The installed vibemon as a tag; null when it is not installed. */
	installedVmon?: () => Promise<string | null>;
	/** Opens the vibemon admin API (`VmonAdmin.open`). */
	openAdmin?: (options: { url: string; tokenFile: string }) => Promise<Pick<VmonAdmin, "cluster">>;
	/** Milliseconds between two looks at the cluster (2000). */
	pollMs?: number;
	/** Milliseconds `--member` waits for the machine in all (60000). */
	waitMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

interface NodeJoinArgs {
	configPath: string;
	member: string | null;
}

/** The flags of `node-join-info`, each at most once with a value; `--member` is an IPv4 address. */
function parseNodeArgs(args: readonly string[], env: Record<string, string | undefined>): NodeJoinArgs {
	const flags = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag !== "--member" && flag !== "--config") throw new Error(`unknown argument ${JSON.stringify(flag)}; ${NODE_USAGE}`);
		const value = args[++i];
		if (value === undefined) throw new Error(`${flag} needs a value; ${NODE_USAGE}`);
		if (flags.has(flag)) throw new Error(`${flag} given twice; ${NODE_USAGE}`);
		flags.set(flag, value);
	}
	const member = flags.get("--member") ?? null;
	if (member !== null && isIP(member) !== 4) throw new Error(`--member must be an IPv4 address; ${NODE_USAGE}`);
	const fromEnv = env.OMP_CLOUD_CONFIG;
	const configPath = flags.get("--config") ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
	return { configPath: resolveConfigPath(configPath), member };
}

/** The text of a file the record is built from; the message names the file, never its content. */
async function readNamed(path: string, label: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
		throw new Error(`cannot read ${label} ${path}: ${code}`);
	}
}

/** The host of a gossip address vibemon reports: `10.0.0.5`, `10.0.0.5:7946`, `[fe80::1]:7946` or `10.0.0.5/24` all give their host. */
function hostOfAddr(addr: string): string {
	const withoutMask = addr.split("/")[0] ?? "";
	const bracketed = /^\[([^\]]*)\]/.exec(withoutMask);
	if (bracketed?.[1] !== undefined) return bracketed[1];
	const colons = withoutMask.split(":");
	return colons.length === 2 ? (colons[0] ?? "") : withoutMask;
}

/** Waits for an alive vibemon machine at `address`; the server's vibemon needs a few seconds after a machine starts to see it. */
async function waitForMember(admin: Pick<VmonAdmin, "cluster">, address: string, options: Required<Pick<NodeJoinOptions, "pollMs" | "waitMs" | "now" | "sleep">>): Promise<NodeJoinOutput> {
	const started = options.now();
	let unanswered = "";
	for (;;) {
		try {
			const found = (await admin.cluster()).nodes.find((node) => node.alive && node.addrs.some((addr) => hostOfAddr(addr) === address));
			if (found !== undefined) return { ompCloudNode: 1, member: { hostname: found.hostname, status: found.status, version: found.version } };
			unanswered = "";
		} catch (error) {
			// A refused token does not heal by waiting; vibemon being briefly unreachable (a restart) does.
			if (error instanceof VmonAdminRefused) throw error;
			unanswered = error instanceof Error ? error.message : String(error);
		}
		if (options.now() - started >= options.waitMs) break;
		await options.sleep(options.pollMs);
	}
	if (unanswered !== "") throw new Error(`the server's vibemon did not answer: ${unanswered}`);
	throw new Error(`the server's vibemon has not seen a machine at ${address} within ${Math.round(options.waitMs / 1000)} s`);
}

/**
 * Answers `node-join-info`. Every failure is an `error` result: no cluster keys, no `remote` section, vibemon not
 * installed, `--member` without an admin token file, an unreadable secret or certificate, a bad flag, a machine the
 * server's vibemon does not see in time.
 */
export async function nodeJoinInfo(args: readonly string[], env: Record<string, string | undefined>, options: NodeJoinOptions = {}): Promise<NodeJoinOutput> {
	try {
		const parsed = parseNodeArgs(args, env);
		const config = await loadConfig(parsed.configPath);
		const { clusterAddress, clusterSecretFile, adminTokenFile } = config.vmon;
		if (clusterAddress === undefined || clusterSecretFile === undefined) {
			throw new Error("this server does not take vibemon machines: run omp-cloud setup --cluster-address <its LAN address> on it first");
		}
		if (config.remote === undefined) throw new Error("the server has no remote listener: run omp-cloud setup on it");
		const version = await (options.installedVmon ?? installedVmonVersion)();
		if (version === null) throw new Error("vibemon is not installed on the server");
		if (parsed.member !== null) {
			if (adminTokenFile === undefined) throw new Error("this server has no vibemon admin token yet: run omp-cloud setup on it");
			const admin = await (options.openAdmin ?? VmonAdmin.open)({ url: config.vmon.url, tokenFile: adminTokenFile });
			return await waitForMember(admin, parsed.member, {
				pollMs: options.pollMs ?? 2000,
				waitMs: options.waitMs ?? 60_000,
				now: options.now ?? Date.now,
				sleep: options.sleep ?? Bun.sleep,
			});
		}
		const clusterSecret = (await readNamed(clusterSecretFile, "vmon.clusterSecretFile")).trim();
		const pin = spkiPin(await readNamed(config.remote.certFile, "remote.certFile"));
		return {
			ompCloudNode: 1,
			server: { address: clusterAddress, remotePort: config.remote.listen.port, pin, version: SERVICE_VERSION },
			vmon: { version, join: `${clusterAddress}:7946`, clusterSecret },
		};
	} catch (error) {
		return { ompCloudNode: 1, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Runs `omp-cloud <command> …` (`argv` without the program name): prints the one JSON line and sets the exit code. */
export async function cliMain(argv: readonly string[]): Promise<void> {
	const [command, ...rest] = argv;
	let output: PairOutput | NodeJoinOutput;
	if (command === "ssh-pair") output = await sshPair(rest, process.env);
	else if (command === "node-join-info") output = await nodeJoinInfo(rest, process.env);
	else output = { ompCloudPair: 1, error: `unknown command ${JSON.stringify(command ?? "")}; ${USAGE}` };
	process.stdout.write(`${JSON.stringify(output)}\n`);
	if ("error" in output) {
		console.error(`omp-cloud: ${output.error}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await cliMain(process.argv.slice(2));
