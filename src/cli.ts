/**
 * `omp-cloud`: the service host's command line. One subcommand so far:
 *
 *   omp-cloud ssh-pair --name <name> --platform <platform> [--config <path>]
 *
 * It pairs a device without the offer/approve dance: whoever can run this has a login on the service's account, which
 * is the proof of ownership (the client reaches it over SSH, `/cloud connect user@host`). It needs only `dataDir` and
 * `remote` from service.json (the file is parsed as the service parses it; nothing it names is contacted), so it works
 * while vmon and the gateway are down, and opens the store directly: SQLite's WAL and busy timeout make that safe
 * next to the running service, which looks a token up in the database on every request.
 *
 * The last line of stdout is one JSON object `{"ompCloudPair": 1, ...}` (the device and its token, or an `error`), exit
 * status 1 on failure. Nothing else goes to stdout; the token appears nowhere else.
 */
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveConfigPath } from "./config";
import { loadIdentity } from "./pairing/identity";
import { parseDeviceName, parsePlatform } from "./pairing/names";
import { advertiseAddresses } from "./pairing/remote";
import { newDeviceToken, randomBase64Url, sha256Hex } from "./pairing/secrets";
import { OWNER } from "./server/auth";
import { SchemaVersionError, Store } from "./store";
import { API_VERSION, SERVICE_VERSION } from "./version";

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

/** Runs `omp-cloud <command> …` (`argv` without the program name): prints the one JSON line and sets the exit code. */
export async function cliMain(argv: readonly string[]): Promise<void> {
	const [command, ...rest] = argv;
	const output: PairOutput =
		command === "ssh-pair"
			? await sshPair(rest, process.env)
			: { ompCloudPair: 1, error: `unknown command ${JSON.stringify(command ?? "")}; ${USAGE}` };
	process.stdout.write(`${JSON.stringify(output)}\n`);
	if ("error" in output) {
		console.error(`omp-cloud: ${output.error}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await cliMain(process.argv.slice(2));
