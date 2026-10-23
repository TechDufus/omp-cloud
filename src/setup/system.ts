/**
 * `omp-cloud setup system`: the root part of `omp-cloud setup`, run by setup through one `sudo`. It installs the missing
 * packages, the root helper and its sudoers rule, vibemon at the pin, the vmon secrets, the two system units, the vmon team
 * and linger; or, with `--uninstall`, removes what setup put there. It takes only validated flags, never a path to a user's
 * file. Human lines go to stderr; the last stdout line is the JSON {@link SystemReport}.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../guards";
import type { CommandResult, CommandRunner } from "../update/system";
import { lastLine, runCommand } from "../update/system";
import { helperVerdict, VMON_BINARY, VMON_HELPER_PATH, VMON_HELPER_SCRIPT, VMON_PIN, VMON_SYNC_PATH, VMON_SYNC_SCRIPT } from "../vmon/pin";
import { isPrivateLan, isUnicastHost } from "./ipv4";
import { detectPackageManager, installPackages, PACKAGE_NAMES, packageSet } from "./packages";
import type { StepResult } from "./steps";
import { Reporter } from "./steps";
import { installNodeUnits, installSystemUnits, NET_UNIT, readText, removeSystemUnits, SERVICE_IP, SERVICE_LINK, SYSTEM_UNIT_DIR, VMON_UNIT, writeIfChanged } from "./system-units";
import { DEFAULT_MAX_SANDBOXES, DEFAULT_TEAM, ensureTeam, envValueOf, RESERVED_TEAM, TEAM_PATTERN } from "./vmon-team";

export const SUDOERS_FILE = "/etc/sudoers.d/omp-cloud";
export const SETUP_RECORD = "/etc/omp-cloud/setup.json";
/** Where a vibemon node records the server it follows (`SERVER_URL`, `SERVER_PIN`; no secret): its presence is what makes this machine a node. */
export const NODE_ENV_FILE = "/etc/omp-cloud/node.env";
const VMON_ENV_FILE = "/etc/vmon/env";
const LINGER_DIR = "/var/lib/systemd/linger";
const VMON_HEALTH_URL = "http://127.0.0.1:3000/health";
const HEALTH_WAIT_SECONDS = 60;
const HELPER_TIMEOUT_MS = 5 * 60_000;
/** What `--uninstall --purge` removes besides the units, the helper and the rule. */
const PURGE_PATHS = ["/opt/vmon", "/opt/vmon.prev", "/etc/vmon", "/var/lib/vmon"];
/** The sync script's memory of a vibemon tag it failed to install (`<tag> <epoch>`); `vmon-sync.sh` writes it. */
const VMON_SYNC_STATE = "/var/lib/omp-cloud/vmon-sync.failed";
const USER_PATTERN = /^[a-z_][a-z0-9_-]*$/;
/** What a secret in the report may look like: non-empty, at most 256 characters, no whitespace. */
const SECRET_PATTERN = /^\S{1,256}$/;
/**
 * What a cluster secret of a node may look like. It goes unquoted into `/etc/vmon/env`, an `EnvironmentFile` that systemd
 * parses (quotes, backslashes and `$` mean something there), so only characters it carries byte for byte are accepted.
 */
export const NODE_SECRET_PATTERN = /^[A-Za-z0-9._~+/=:-]{1,256}$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
/** The certificate pin of the server (`spkiPin`): `sha256//` and the base64 of a SHA-256. */
const PIN_PATTERN = /^sha256\/\/[A-Za-z0-9+/]{43}=$/;
/** A node's vmon must stay active this long before the node counts as up. */
const NODE_ACTIVE_SECONDS = 10;

/** What a node is asked to set up (`--node` and its flags). */
export interface NodeArgs {
	/** The vibemon tag to install: the server's. */
	vmon: string;
	/** The server's LAN address. */
	server: string;
	remotePort: number;
	/** The server certificate's pin, for the sync script. */
	pin: string;
	/** Absolute path of the file holding the cluster secret, written by the user part with mode 0600. */
	secretFile: string;
	/** The node reaches the server directly: route the service address through it. */
	route: boolean;
}

export interface SystemArgs {
	/** The user the sudoers rule and linger are for. Required to set up; an uninstall may take it from the setup record. */
	user?: string;
	team: string;
	maxSandboxes: number;
	packages: string[];
	mintKey: boolean;
	noLinger: boolean;
	migrateTeam: boolean;
	uninstall: boolean;
	purge: boolean;
	/** The LAN address vmon listens on for other vibemon machines; null: this server is alone. */
	clusterAddress: string | null;
	/** Set up this machine as a vibemon node of another server's cluster; null on a server. */
	node: NodeArgs | null;
}

export type ParsedSystemArgs = { ok: true; args: SystemArgs } | { ok: false; error: string };

const VALUE_FLAGS = ["--user", "--team", "--max-sandboxes", "--packages", "--cluster-address", "--vmon", "--server", "--remote-port", "--pin", "--secret-file"];
const SWITCH_FLAGS = ["--mint-key", "--no-linger", "--migrate-team", "--uninstall", "--purge", "--node", "--route"];
/** Flags that only make sense when setting up. */
const SETUP_ONLY = ["--team", "--max-sandboxes", "--packages", "--mint-key", "--no-linger", "--migrate-team", "--cluster-address", "--node", "--vmon", "--server", "--remote-port", "--pin", "--secret-file", "--route"];
/** Flags that only make sense with `--node`. */
const NODE_ONLY = ["--vmon", "--server", "--remote-port", "--pin", "--secret-file", "--route"];
/** Flags of a server's setup that a node has no use for. */
const SERVER_ONLY = ["--team", "--max-sandboxes", "--mint-key", "--no-linger", "--migrate-team", "--cluster-address"];

/** Validates the root part's flags. Nothing is read from the environment or the file system. */
export function parseSystemArgs(argv: readonly string[]): ParsedSystemArgs {
	const values = new Map<string, string>();
	const switches = new Set<string>();
	for (let index = 0; index < argv.length; index++) {
		const word = argv[index] ?? "";
		const equals = word.indexOf("=");
		const flag = equals === -1 ? word : word.slice(0, equals);
		if (SWITCH_FLAGS.includes(flag) && equals === -1) {
			if (switches.has(flag)) return { ok: false, error: `${flag} given twice` };
			switches.add(flag);
		} else if (VALUE_FLAGS.includes(flag)) {
			const value = equals === -1 ? argv[++index] : word.slice(equals + 1);
			if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) return { ok: false, error: `${flag} needs a value` };
			if (values.has(flag)) return { ok: false, error: `${flag} given twice` };
			values.set(flag, value);
		} else {
			return { ok: false, error: `unknown argument ${JSON.stringify(word)}` };
		}
	}
	const given = (flag: string): boolean => values.has(flag) || switches.has(flag);

	const uninstall = switches.has("--uninstall");
	if (switches.has("--purge") && !uninstall) return { ok: false, error: "--purge needs --uninstall" };
	if (uninstall) {
		const stray = SETUP_ONLY.find(given);
		if (stray !== undefined) return { ok: false, error: `${stray} cannot be combined with --uninstall` };
	}
	const node = switches.has("--node");
	if (!node) {
		const stray = NODE_ONLY.find(given);
		if (stray !== undefined) return { ok: false, error: `${stray} needs --node` };
	} else {
		const stray = SERVER_ONLY.find(given);
		if (stray !== undefined) return { ok: false, error: `${stray} cannot be combined with --node` };
	}

	const user = values.get("--user");
	if (user !== undefined && (user.length > 32 || !USER_PATTERN.test(user) || user === "root")) return { ok: false, error: `--user ${JSON.stringify(user)} is not a regular user name (^[a-z_][a-z0-9_-]*$, not root)` };
	if (user === undefined && !uninstall) return { ok: false, error: "--user is required" };

	const team = values.get("--team") ?? DEFAULT_TEAM;
	if (!TEAM_PATTERN.test(team) || team === RESERVED_TEAM) return { ok: false, error: `--team ${JSON.stringify(team)} is not a team slug (^[a-z0-9][a-z0-9-]{0,62}$, not ${RESERVED_TEAM})` };

	const sandboxes = values.get("--max-sandboxes");
	const maxSandboxes = sandboxes === undefined ? DEFAULT_MAX_SANDBOXES : /^\d{1,4}$/.test(sandboxes) ? Number(sandboxes) : 0;
	if (maxSandboxes < 1 || maxSandboxes > 1000) return { ok: false, error: `--max-sandboxes ${JSON.stringify(sandboxes)} is not a number from 1 to 1000` };

	const packages = [...new Set((values.get("--packages") ?? "").split(",").filter((name) => name !== ""))];
	const unknown = packages.find((name) => !PACKAGE_NAMES.has(name));
	if (unknown !== undefined) return { ok: false, error: `--packages names ${JSON.stringify(unknown)}, which is not in the fixed package set` };
	if (values.has("--packages") && packages.length === 0) return { ok: false, error: "--packages needs at least one name" };

	const clusterAddress = values.get("--cluster-address") ?? null;
	if (clusterAddress !== null && !isPrivateLan(clusterAddress)) return { ok: false, error: `--cluster-address ${JSON.stringify(clusterAddress)} is not a private LAN IPv4 address (10.x, 172.16-31.x or 192.168.x, no leading zeros)` };

	let nodeArgs: NodeArgs | null = null;
	if (node) {
		const missing = ["--vmon", "--server", "--remote-port", "--pin", "--secret-file"].find((flag) => !values.has(flag));
		if (missing !== undefined) return { ok: false, error: `${missing} is required with --node` };
		const vmon = values.get("--vmon") ?? "";
		if (vmon.length > 32 || !TAG_PATTERN.test(vmon)) return { ok: false, error: `--vmon ${JSON.stringify(vmon)} is not a vibemon tag like v0.4.0` };
		const server = values.get("--server") ?? "";
		if (!isUnicastHost(server)) return { ok: false, error: `--server ${JSON.stringify(server)} is not the IPv4 address of a machine (no leading zeros; not 0.0.0.0, loopback, multicast or broadcast)` };
		const port = values.get("--remote-port") ?? "";
		const remotePort = /^\d{1,5}$/.test(port) ? Number(port) : 0;
		if (remotePort < 1 || remotePort > 65535) return { ok: false, error: `--remote-port ${JSON.stringify(port)} is not a port from 1 to 65535` };
		const pin = values.get("--pin") ?? "";
		if (!PIN_PATTERN.test(pin)) return { ok: false, error: "--pin is not a certificate pin (sha256// and 44 base64 characters)" };
		const secretFile = values.get("--secret-file") ?? "";
		if (!/^\/\S+$/.test(secretFile) || secretFile.split("/").includes("..")) return { ok: false, error: `--secret-file ${JSON.stringify(secretFile)} is not an absolute path without .. or whitespace` };
		nodeArgs = { vmon, server, remotePort, pin, secretFile, route: switches.has("--route") };
	}

	return {
		ok: true,
		args: {
			...(user === undefined ? {} : { user }),
			team,
			maxSandboxes,
			packages,
			mintKey: switches.has("--mint-key"),
			noLinger: switches.has("--no-linger"),
			migrateTeam: switches.has("--migrate-team"),
			uninstall,
			purge: switches.has("--purge"),
			clusterAddress,
			node: nodeArgs,
		},
	};
}

/** What the root part prints as its last stdout line. */
export interface SystemReport {
	ok: boolean;
	steps: StepResult[];
	/** The vibemon team; null on a node, which has none. */
	team: { slug: string; created: boolean } | null;
	/** Present only when a key was minted now (the team was created, or `--mint-key`). */
	key?: string;
	/** The vibemon admin token of `/etc/vmon/env`, for the user part to write as a 0600 file; absent when the file holds none. Never in a step's text. */
	adminToken?: string;
	/** The vibemon cluster secret, only in cluster mode, for the same reason. */
	clusterSecret?: string;
	netPool: string;
	/** Whether linger is on for the user after this run. */
	linger: boolean;
}

function isStepResult(value: unknown): value is StepResult {
	if (!isRecord(value)) return false;
	const statuses = ["ok", "changed", "skipped", "failed"];
	return typeof value.id === "string" && typeof value.status === "string" && statuses.includes(value.status) && typeof value.detail === "string" && (value.fix === undefined || typeof value.fix === "string");
}

/** Parses the last stdout line of `omp-cloud setup system`. Throws an `Error` naming the problem when it is not a {@link SystemReport}. */
export function parseSystemReport(lastStdoutLine: string): SystemReport {
	let value: unknown;
	try {
		value = JSON.parse(lastStdoutLine);
	} catch {
		throw new Error(`the root part's last output line is not JSON: ${lastStdoutLine.slice(0, 200)}`);
	}
	if (!isRecord(value)) throw new Error("the root part's report is not an object");
	const { ok, steps, team, key, adminToken, clusterSecret, netPool, linger } = value;
	if (typeof ok !== "boolean") throw new Error("the root part's report has no boolean ok");
	if (!Array.isArray(steps) || !steps.every(isStepResult)) throw new Error("the root part's report has malformed steps");
	const parsedTeam = team === null ? null : isRecord(team) && typeof team.slug === "string" && typeof team.created === "boolean" ? { slug: team.slug, created: team.created } : undefined;
	if (parsedTeam === undefined) throw new Error("the root part's report has a malformed team");
	if (key !== undefined && typeof key !== "string") throw new Error("the root part's report has a malformed key");
	for (const [name, secret] of [["adminToken", adminToken], ["clusterSecret", clusterSecret]] as const) {
		if (secret !== undefined && (typeof secret !== "string" || !SECRET_PATTERN.test(secret))) throw new Error(`the root part's report has a malformed ${name}`);
	}
	if (typeof netPool !== "string") throw new Error("the root part's report has no netPool");
	if (typeof linger !== "boolean") throw new Error("the root part's report has no boolean linger");
	return { ok, steps, team: parsedTeam, ...(key === undefined ? {} : { key }), ...(typeof adminToken === "string" ? { adminToken } : {}), ...(typeof clusterSecret === "string" ? { clusterSecret } : {}), netPool, linger };
}

/** Everything the root part touches outside its own code, so tests can run it on a temp directory with fake commands. */
export interface SystemDeps {
	/** `/` in production; every file path is joined onto it. */
	root: string;
	runner: CommandRunner;
	/** Receives the human lines (stderr in production). */
	reporter: Reporter;
	/** Receives the JSON report line (stdout in production). */
	stdout: (text: string) => void;
	euid: () => number;
	/** The uid that must own what is installed as root's (0; tests run unprivileged and say their own). */
	rootUid: number;
	which: (name: string) => string | null;
	/** A fresh random secret, 64 hex characters. */
	secret: () => string;
	sleep: (ms: number) => Promise<void>;
	/** The status of vmon's health route; 0 when it did not answer. */
	vmonHealth: () => Promise<number>;
	/** The vibemon tag to install and the helper and sync scripts to put in place. */
	pin: string;
	helperScript: string;
	syncScript: string;
}

function realDeps(): SystemDeps {
	return {
		root: "/",
		runner: runCommand,
		reporter: Reporter.forProcess(true),
		stdout: (text) => void process.stdout.write(text),
		euid: () => process.geteuid?.() ?? -1,
		rootUid: 0,
		which: (name) => Bun.which(name),
		secret: () => randomBytes(32).toString("hex"),
		sleep: (ms) => Bun.sleep(ms),
		vmonHealth: async () => {
			try {
				return (await fetch(VMON_HEALTH_URL, { signal: AbortSignal.timeout(3000) })).status;
			} catch {
				return 0;
			}
		},
		pin: VMON_PIN,
		helperScript: VMON_HELPER_SCRIPT,
		syncScript: VMON_SYNC_SCRIPT,
	};
}

interface RunState {
	team: { slug: string; created: boolean } | null;
	key?: string;
	adminToken?: string;
	clusterSecret?: string;
	netPool: string;
	linger: boolean;
}

function emit(deps: SystemDeps, state: RunState): void {
	const report: SystemReport = {
		ok: !deps.reporter.failed,
		steps: deps.reporter.steps,
		team: state.team,
		...(state.key === undefined ? {} : { key: state.key }),
		...(state.adminToken === undefined ? {} : { adminToken: state.adminToken }),
		...(state.clusterSecret === undefined ? {} : { clusterSecret: state.clusterSecret }),
		netPool: state.netPool,
		linger: state.linger,
	};
	deps.stdout(`${JSON.stringify(report)}\n`);
}

/** The root part as the `omp-cloud setup system` command: real file system, real commands. Exit status 0 ok, 1 failed, 2 for bad flags. */
export async function systemMain(argv: readonly string[]): Promise<number> {
	return runSystem(argv, realDeps());
}

/** {@link systemMain} over `deps`. */
export async function runSystem(argv: readonly string[], deps: SystemDeps): Promise<number> {
	const parsed = parseSystemArgs(argv);
	const state: RunState = { team: { slug: DEFAULT_TEAM, created: false }, netPool: "", linger: false };
	if (!parsed.ok) {
		deps.reporter.report({ id: "system.arguments", status: "failed", detail: parsed.error, fix: "omp-cloud setup runs this itself; run omp-cloud setup" });
		emit(deps, state);
		return 2;
	}
	const { args } = parsed;
	state.team = args.node === null ? { slug: args.team, created: false } : null;
	if (deps.euid() !== 0) {
		deps.reporter.report({ id: "system.root", status: "failed", detail: "the root part must run as root", fix: "run omp-cloud setup as your user; it asks for sudo once" });
		emit(deps, state);
		return 1;
	}
	if (args.uninstall) await uninstall(args, deps, state);
	else if (args.node !== null) await setUpNode(args, args.node, deps, state);
	else await setUp(args, deps, state);
	emit(deps, state);
	return deps.reporter.failed ? 1 : 0;
}

/** Runs `step`s in order and stops at the first that fails; true when all passed. */
async function inOrder(deps: SystemDeps, steps: ReadonlyArray<() => Promise<StepResult | StepResult[]>>): Promise<boolean> {
	for (const step of steps) {
		const results = [await step()].flat();
		deps.reporter.reportAll(results);
		if (results.some((result) => result.status === "failed")) return false;
	}
	return true;
}

async function setUp(args: SystemArgs, deps: SystemDeps, state: RunState): Promise<void> {
	const user = args.user ?? "";
	await inOrder(deps, [
		() => packagesStep(args, deps),
		() => userStep(user, deps),
		() => helperStep(deps),
		() => sudoersStep(user, deps),
		() => vmonStep(deps, deps.pin),
		() => envStep(deps),
		async () => {
			const units = await installSystemUnits({ root: deps.root, runner: deps.runner, clusterAddress: args.clusterAddress });
			state.netPool = units.netPool;
			return units.steps;
		},
		() => healthStep(deps),
		async () => {
			const envText = await readText(join(deps.root, VMON_ENV_FILE));
			const secret = envText === null ? null : envValueOf(envText, "VMON_CLUSTER_SECRET");
			if (secret === null) return { id: "system.team", status: "failed", detail: `${VMON_ENV_FILE} holds no VMON_CLUSTER_SECRET`, fix: `sudo rm ${VMON_ENV_FILE} only on a host with no vmon data, else restore the file` } satisfies StepResult;
			const adminToken = envValueOf(envText ?? "", "VMON_ADMIN_TOKEN");
			if (adminToken !== null && SECRET_PATTERN.test(adminToken)) state.adminToken = adminToken;
			if (args.clusterAddress !== null && SECRET_PATTERN.test(secret)) state.clusterSecret = secret;
			const clusterUrl = `http://${args.clusterAddress ?? "127.0.0.1"}:7947`;
			const outcome = await ensureTeam({ runner: deps.runner, secret, slug: args.team, maxSandboxes: args.maxSandboxes, mintKey: args.mintKey || args.migrateTeam, sleep: deps.sleep, clusterUrl });
			state.team = outcome.team;
			if (outcome.key !== undefined) state.key = outcome.key;
			return outcome.steps;
		},
		async () => {
			const linger = await lingerStep(user, args.noLinger, deps);
			state.linger = linger.on;
			return linger.step;
		},
	]);
}

/** The node's root part: packages, the user, the helper scripts, vibemon at the server's version, the cluster secret, the server record, the units and a wait until vmon stays up. No team, no sudoers rule, no linger. */
async function setUpNode(args: SystemArgs, node: NodeArgs, deps: SystemDeps, state: RunState): Promise<void> {
	await inOrder(deps, [
		() => packagesStep(args, deps),
		() => userStep(args.user ?? "", deps),
		() => nodeGuardStep(deps),
		() => helperStep(deps),
		() => vmonStep(deps, node.vmon),
		() => nodeEnvStep(node, deps),
		() => nodeConfStep(node, deps),
		async () => {
			const units = await installNodeUnits({ root: deps.root, runner: deps.runner, server: node.server, route: node.route });
			state.netPool = units.netPool;
			return units.steps;
		},
		() => nodeHealthStep(deps),
	]);
}

/** A machine that runs a vibemon server (`--role node,driver`) is not made a node: its vmon would be replaced and its VMs lost. */
async function nodeGuardStep(deps: SystemDeps): Promise<StepResult> {
	const unit = await readText(join(deps.root, SYSTEM_UNIT_DIR, VMON_UNIT));
	if (unit !== null && unit.includes("--role node,driver")) {
		return { id: "system.node.guard", status: "failed", detail: "this machine runs a vibemon server (vmon --role node,driver): a machine is either a server or a node", fix: "omp-cloud uninstall --purge, then omp-cloud setup node --join <user@server>" };
	}
	return { id: "system.node.guard", status: "ok", detail: "this machine runs no vibemon server" };
}

async function packagesStep(args: SystemArgs, deps: SystemDeps): Promise<StepResult> {
	if (args.packages.length === 0) return { id: "system.packages", status: "skipped", detail: "no packages requested" };
	const manager = detectPackageManager(deps.which);
	if (manager === null) return { id: "system.packages", status: "failed", detail: "no supported package manager (apt-get, dnf, pacman) found", fix: `install ${args.packages.join(", ")} with your package manager` };
	const allowed = packageSet(manager);
	const refused = args.packages.find((name) => !allowed.has(name));
	if (refused !== undefined) return { id: "system.packages", status: "failed", detail: `${refused} is not in the fixed package set of ${manager}`, fix: "omp-cloud setup passes the right names itself; run omp-cloud setup" };
	return installPackages(deps.runner, manager, args.packages);
}

async function userStep(user: string, deps: SystemDeps): Promise<StepResult> {
	const found = await deps.runner(["id", "-u", user]);
	if (found.code === 0) return { id: "system.user", status: "ok", detail: `user ${user} exists` };
	return { id: "system.user", status: "failed", detail: `the user ${user} does not exist`, fix: "run omp-cloud setup as the user that will run the service" };
}

/** The root-owned helper scripts (vmon-install and vmon-sync), and the check that nothing a user could write to sits on the way to them. */
async function helperStep(deps: SystemDeps): Promise<StepResult> {
	const dir = join(deps.root, dirname(VMON_HELPER_PATH));
	await mkdir(dir, { recursive: true });
	await chmod(dir, 0o755);
	const scripts = [
		{ path: VMON_HELPER_PATH, text: deps.helperScript },
		{ path: VMON_SYNC_PATH, text: deps.syncScript },
	];
	const written: string[] = [];
	for (const { path, text } of scripts) if (await writeIfChanged(join(deps.root, path), text, 0o755)) written.push(path);
	for (const [path, shown] of [[dir, dirname(VMON_HELPER_PATH)], ...scripts.map(({ path }) => [join(deps.root, path), path] as const)] as const) {
		const info = await lstat(path);
		const isFile = path !== dir;
		if ((isFile && !info.isFile()) || info.uid !== deps.rootUid || (info.mode & 0o022) !== 0) {
			return { id: "system.helper", status: "failed", detail: `${shown} is not a root-owned ${isFile ? "file" : "directory"} that only root can write`, fix: `sudo chown -R root:root ${dirname(VMON_HELPER_PATH)} && sudo chmod -R go-w ${dirname(VMON_HELPER_PATH)}` };
		}
	}
	const names = scripts.map(({ path }) => path).join(" and ");
	return { id: "system.helper", status: written.length > 0 ? "changed" : "ok", detail: written.length > 0 ? `${written.join(" and ")} installed` : `${names} are in place` };
}

/** The one rule: this user may run the root helper, and nothing else, without a password. Validated with `visudo -cf` before it replaces the old one. */
async function sudoersStep(user: string, deps: SystemDeps): Promise<StepResult> {
	const rule = `${user} ALL=(root) NOPASSWD: ${VMON_HELPER_PATH}\n`;
	const path = join(deps.root, SUDOERS_FILE);
	const current = await readText(path);
	if (current === rule) {
		const repaired = ((await stat(path)).mode & 0o777) !== 0o440;
		if (repaired) await chmod(path, 0o440);
		return { id: "system.sudoers", status: repaired ? "changed" : "ok", detail: `${SUDOERS_FILE} lets ${user} run the vibemon helper` };
	}
	// sudoers ignores a file name with a dot, so the staging name is inert until the rename.
	const staging = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(staging, rule, { mode: 0o440 });
	await chmod(staging, 0o440);
	const checked = await deps.runner(["visudo", "-cf", staging]);
	if (checked.code !== 0) {
		await rm(staging, { force: true });
		const reason = lastLine(checked.stderr) || lastLine(checked.stdout);
		return { id: "system.sudoers", status: "failed", detail: `the sudoers rule for ${VMON_HELPER_PATH} did not validate, nothing was installed${reason === "" ? "" : `: ${reason}`}`, fix: "install sudo (it brings visudo) and run omp-cloud setup again" };
	}
	await rename(staging, path);
	return { id: "system.sudoers", status: "changed", detail: `${SUDOERS_FILE} lets ${user} run the vibemon helper` };
}

/** vibemon at `tag` (the pin on a server, the server's version on a node), through the helper (download, checksum, swap, rollback). */
async function vmonStep(deps: SystemDeps, tag: string): Promise<StepResult> {
	const wanted = `vmon ${tag.slice(1)}`;
	let installed: string | null = null;
	if ((await stat(join(deps.root, VMON_BINARY)).catch(() => null)) !== null) {
		const reported = await deps.runner([VMON_BINARY, "--version"]);
		installed = reported.code === 0 ? reported.stdout.trim() : null;
	}
	if (installed === wanted) return { id: "system.vmon", status: "ok", detail: `vibemon ${tag} is installed` };
	const ran: CommandResult = await deps.runner([VMON_HELPER_PATH, tag], { timeoutMs: HELPER_TIMEOUT_MS });
	const verdict = helperVerdict(ran.stdout);
	if (verdict?.ok === true && ran.code === 0) return { id: "system.vmon", status: "changed", detail: `installed vibemon ${tag}${installed === null ? "" : ` (was ${installed})`}` };
	const reason = verdict?.ok === false ? verdict.error : lastLine(ran.stderr) || `the helper exited ${ran.code} without a verdict`;
	return { id: "system.vmon", status: "failed", detail: `vibemon ${tag} could not be installed: ${reason}`, fix: "check the network (github.com/stencil-hq/vibemon releases) and run omp-cloud setup again" };
}

/** `/etc/vmon/env` with the cluster secret and the admin token, created once. Changing the cluster secret invalidates every sandbox, so an existing file is never rewritten. */
async function envStep(deps: SystemDeps): Promise<StepResult> {
	const file = join(deps.root, VMON_ENV_FILE);
	await mkdir(dirname(file), { recursive: true });
	await chmod(dirname(file), 0o700);
	const current = await readText(file);
	if (current !== null && current.trim() !== "") {
		if (((await stat(file)).mode & 0o777) !== 0o600) await chmod(file, 0o600);
		return { id: "system.env", status: "ok", detail: `${VMON_ENV_FILE} exists (kept)` };
	}
	await writeIfChanged(file, `VMON_CLUSTER_SECRET=${deps.secret()}\nVMON_ADMIN_TOKEN=${deps.secret()}\n`, 0o600);
	return { id: "system.env", status: "changed", detail: `wrote ${VMON_ENV_FILE} with new secrets` };
}

/**
 * A node's `/etc/vmon/env`: the server's cluster secret only (the node has no admin API of its own), read from the file the
 * user part wrote. A file that already holds that secret is kept; another cluster's secret is never overwritten, because
 * changing it would cut the node's VMs off.
 */
async function nodeEnvStep(node: NodeArgs, deps: SystemDeps): Promise<StepResult> {
	const info = await lstat(node.secretFile).catch(() => null);
	if (info === null || !info.isFile()) return { id: "system.env", status: "failed", detail: "the cluster secret file is missing or is not a regular file", fix: "omp-cloud setup node --join <user@server> writes it itself; run it again" };
	const secret = ((await readText(node.secretFile)) ?? "").trim();
	if (!NODE_SECRET_PATTERN.test(secret)) return { id: "system.env", status: "failed", detail: "the cluster secret file does not hold a secret (1 to 256 letters, digits or . _ ~ + / = : -)", fix: "run omp-cloud setup node --join <user@server> again" };
	const file = join(deps.root, VMON_ENV_FILE);
	await mkdir(dirname(file), { recursive: true });
	await chmod(dirname(file), 0o700);
	const current = await readText(file);
	if (current !== null && current.trim() !== "") {
		if (envValueOf(current, "VMON_CLUSTER_SECRET") !== secret) return { id: "system.env", status: "failed", detail: `${VMON_ENV_FILE} holds another cluster's secret`, fix: "omp-cloud uninstall --purge first" };
		if (((await stat(file)).mode & 0o777) !== 0o600) await chmod(file, 0o600);
		return { id: "system.env", status: "ok", detail: `${VMON_ENV_FILE} holds the server's cluster secret (kept)` };
	}
	await writeIfChanged(file, `VMON_CLUSTER_SECRET=${secret}\n`, 0o600);
	return { id: "system.env", status: "changed", detail: `wrote ${VMON_ENV_FILE} with the server's cluster secret` };
}

/** `/etc/omp-cloud/node.env`: the server's address and certificate pin (no secret), which the sync script and the doctor read. */
async function nodeConfStep(node: NodeArgs, deps: SystemDeps): Promise<StepResult> {
	const file = join(deps.root, NODE_ENV_FILE);
	await mkdir(dirname(file), { recursive: true });
	await chmod(dirname(file), 0o755);
	const changed = await writeIfChanged(file, `SERVER_URL=https://${node.server}:${node.remotePort}\nSERVER_PIN=${node.pin}\n`, 0o644);
	return { id: "system.node.conf", status: changed ? "changed" : "ok", detail: `${NODE_ENV_FILE} names the server ${node.server}:${node.remotePort}` };
}

/** A node has no health route: vmon counts as up once its unit has stayed active for 10 s in a row, within 60 s. */
async function nodeHealthStep(deps: SystemDeps): Promise<StepResult> {
	let steady = 0;
	for (let waited = 0; waited <= HEALTH_WAIT_SECONDS; waited++) {
		steady = (await deps.runner(["systemctl", "is-active", "--quiet", VMON_UNIT])).code === 0 ? steady + 1 : 0;
		if (steady >= NODE_ACTIVE_SECONDS) return { id: "system.health", status: "ok", detail: `vmon stayed active for ${NODE_ACTIVE_SECONDS} s` };
		if (waited < HEALTH_WAIT_SECONDS) await deps.sleep(1000);
	}
	return { id: "system.health", status: "failed", detail: `vmon did not stay active for ${NODE_ACTIVE_SECONDS} s within ${HEALTH_WAIT_SECONDS} s`, fix: "journalctl -u vmon -n 50 --no-pager" };
}

/** Waits up to 60 s for vmon to answer 204; a vmon that adopts running sandboxes after a switch takes its time. */
async function healthStep(deps: SystemDeps): Promise<StepResult> {
	for (let waited = 0; waited <= HEALTH_WAIT_SECONDS; waited++) {
		if ((await deps.vmonHealth()) === 204) return { id: "system.health", status: waited === 0 ? "ok" : "changed", detail: waited === 0 ? `vmon answers ${VMON_HEALTH_URL}` : `vmon came up and answers ${VMON_HEALTH_URL} (after ${waited} s)` };
		if (waited < HEALTH_WAIT_SECONDS) await deps.sleep(1000);
	}
	return { id: "system.health", status: "failed", detail: `vmon did not answer ${VMON_HEALTH_URL} with 204 within ${HEALTH_WAIT_SECONDS} s`, fix: "journalctl -u vmon -n 50 --no-pager" };
}

interface SetupRecord {
	linger?: { user: string; enabledBySetup: boolean };
}

/** `/etc/omp-cloud/setup.json`: what setup enabled, so that uninstall undoes only that. */
async function readRecord(root: string): Promise<SetupRecord> {
	const text = await readText(join(root, SETUP_RECORD));
	if (text === null) return {};
	try {
		const value: unknown = JSON.parse(text);
		const linger = isRecord(value) ? value.linger : undefined;
		if (isRecord(linger) && typeof linger.user === "string" && typeof linger.enabledBySetup === "boolean") return { linger: { user: linger.user, enabledBySetup: linger.enabledBySetup } };
	} catch {
		// An unreadable record counts as "setup enabled nothing": uninstall then leaves linger alone.
	}
	return {};
}

async function writeRecord(root: string, record: SetupRecord): Promise<void> {
	await writeIfChanged(join(root, SETUP_RECORD), `${JSON.stringify(record, null, 2)}\n`, 0o644);
	await chmod(dirname(join(root, SETUP_RECORD)), 0o755);
}

async function lingerOn(root: string, user: string): Promise<boolean> {
	return (await stat(join(root, LINGER_DIR, user)).catch(() => null)) !== null;
}

/** `loginctl enable-linger`: without it the user units start at login, not at boot. Recorded, so an uninstall undoes only what setup enabled. */
async function lingerStep(user: string, skip: boolean, deps: SystemDeps): Promise<{ step: StepResult; on: boolean }> {
	if (skip) return { step: { id: "system.linger", status: "skipped", detail: "linger left as it is (--no-linger): the user units start at login, not at boot" }, on: await lingerOn(deps.root, user) };
	if (await lingerOn(deps.root, user)) return { step: { id: "system.linger", status: "ok", detail: `linger is on for ${user}` }, on: true };
	const enabled = await deps.runner(["loginctl", "enable-linger", user]);
	if (enabled.code !== 0) {
		return { step: { id: "system.linger", status: "failed", detail: `loginctl enable-linger ${user} failed: ${lastLine(enabled.stderr)}`, fix: `sudo loginctl enable-linger ${user}` }, on: false };
	}
	await writeRecord(deps.root, { linger: { user, enabledBySetup: true } });
	return { step: { id: "system.linger", status: "changed", detail: `enabled linger for ${user}: the user units start at boot` }, on: true };
}

/** Removes what setup installed as root; `purge` also deletes vmon, its data and the setup record. */
async function uninstall(args: SystemArgs, deps: SystemDeps, state: RunState): Promise<void> {
	const record = await readRecord(deps.root);
	const user = args.user ?? record.linger?.user;
	let lingerFailed = false;
	await inOrder(deps, [
		() => removeSystemUnits({ root: deps.root, runner: deps.runner }),
		async () => {
			const files = [SUDOERS_FILE, `${SUDOERS_FILE}.tmp`, VMON_HELPER_PATH, VMON_SYNC_PATH, NODE_ENV_FILE, VMON_SYNC_STATE];
			for (const file of files) await rm(join(deps.root, file), { force: true });
			for (const dir of [dirname(VMON_HELPER_PATH), dirname(VMON_SYNC_STATE)]) await rmdir(join(deps.root, dir)).catch(() => undefined);
			return { id: "system.uninstall.helper", status: "changed", detail: "removed the vibemon helper and its sudoers rule, and on a node the sync script and its server record" } satisfies StepResult;
		},
		async () => {
			const step = await lingerUndoStep(record, user, deps);
			lingerFailed = step.status === "failed";
			return step;
		},
	]);
	if (args.purge && !lingerFailed) {
		const removed = [...PURGE_PATHS, dirname(SETUP_RECORD)];
		for (const path of removed) await rm(join(deps.root, path), { recursive: true, force: true });
		const parent = join(deps.root, "/opt");
		for (const name of await readdir(parent).catch(() => [])) if (name.startsWith(".vmon-install.")) await rm(join(parent, name), { recursive: true, force: true });
		deps.reporter.report({ id: "system.uninstall.purge", status: "changed", detail: `removed ${removed.join(", ")}` });
	} else if (args.purge) {
		deps.reporter.report({ id: "system.uninstall.purge", status: "skipped", detail: `kept ${dirname(SETUP_RECORD)} (the linger record) and the vmon files: linger could not be undone` });
	}
	state.linger = user === undefined ? false : await lingerOn(deps.root, user);
}

/** Undoes linger only when setup enabled it. */
async function lingerUndoStep(record: SetupRecord, user: string | undefined, deps: SystemDeps): Promise<StepResult> {
	if (record.linger?.enabledBySetup !== true || user === undefined) return { id: "system.uninstall.linger", status: "skipped", detail: "linger was not enabled by setup: left as it is" };
	const undone = await deps.runner(["loginctl", "disable-linger", user]);
	if (undone.code !== 0) {
		return { id: "system.uninstall.linger", status: "failed", detail: `loginctl disable-linger ${user} failed: ${lastLine(undone.stderr)}`, fix: `sudo loginctl disable-linger ${user}` };
	}
	await writeRecord(deps.root, { linger: { user, enabledBySetup: false } });
	return { id: "system.uninstall.linger", status: "changed", detail: `disabled linger for ${user}` };
}

export interface SystemChecksOptions {
	/** `/` unless a test says otherwise. */
	root?: string;
	/** The user whose linger is checked; the current user by default. */
	user?: string;
}

/** Read-only checks of the root part for `omp-cloud doctor`; the current user can run them (no sudo prompt: `sudo -n`). */
export async function systemChecks(runner: CommandRunner, options: SystemChecksOptions = {}): Promise<StepResult[]> {
	const root = options.root ?? "/";
	const user = options.user ?? userInfo().username;
	const run = async (argv: readonly string[]): Promise<CommandResult> => {
		try {
			return await runner(argv);
		} catch (error) {
			return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	};
	const fix = "omp-cloud setup";
	const steps: StepResult[] = [];
	for (const unit of [NET_UNIT, VMON_UNIT]) {
		const [enabled, active] = await Promise.all([run(["systemctl", "is-enabled", unit]), run(["systemctl", "is-active", unit])]);
		const name = unit.replace(/\.service$/, "");
		if (enabled.code === 0 && active.code === 0) steps.push({ id: `system.check.${name}`, status: "ok", detail: `${unit} is enabled and active` });
		else {
			const problems = [enabled.code === 0 ? "" : "not enabled", active.code === 0 ? "" : "not active"].filter((problem) => problem !== "");
			steps.push({ id: `system.check.${name}`, status: "failed", detail: `${unit} is ${problems.join(" and ")}`, fix });
		}
	}
	const link = await run(["ip", "-o", "-4", "addr", "show", "dev", SERVICE_LINK]);
	if (link.code === 0 && link.stdout.includes(`${SERVICE_IP}/32`)) steps.push({ id: "system.check.link", status: "ok", detail: `${SERVICE_LINK} carries ${SERVICE_IP}` });
	else steps.push({ id: "system.check.link", status: "failed", detail: `${SERVICE_LINK} does not carry ${SERVICE_IP}`, fix });
	const health = await run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", VMON_HEALTH_URL]);
	if (health.code === 0 && health.stdout.trim() === "204") steps.push({ id: "system.check.health", status: "ok", detail: "vmon is healthy" });
	else steps.push({ id: "system.check.health", status: "failed", detail: "vmon does not answer its health route", fix: "journalctl -u vmon -n 50 --no-pager" });
	const rule = await run(["sudo", "-n", "-l", VMON_HELPER_PATH]);
	if (rule.code === 0) steps.push({ id: "system.check.helper", status: "ok", detail: `sudo lets ${user} run ${VMON_HELPER_PATH} without a password` });
	else steps.push({ id: "system.check.helper", status: "failed", detail: "the vibemon helper cannot be run through sudo -n: updates of vibemon cannot be applied", fix });
	if (await lingerOn(root, user)) steps.push({ id: "system.check.linger", status: "ok", detail: `linger is on for ${user}` });
	else steps.push({ id: "system.check.linger", status: "skipped", detail: `linger is off for ${user}: the user units start at login, not at boot`, fix: `sudo loginctl enable-linger ${user}` });
	return steps;
}
