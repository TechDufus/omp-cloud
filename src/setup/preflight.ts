/** `omp-cloud setup` step 1 and the doctor's first block: what the machine must have before anything changes. Read-only; every probe is injected. */
import { access, statfs } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { hostOmp } from "../omp-version";
import { compareVersions } from "../update/manifest";
import { type CommandResult, type CommandRunner, runCommand } from "../update/system";
import { isPrivateLan } from "./ipv4";
import { detectPackageManager, installCommand, type PackageManager, PREFLIGHT_TOOLS, packagesFor } from "./packages";
import type { StepResult } from "./steps";

/** The omp the service host needs: the SDK version this release is built against (the plugin needs it too). */
export const MIN_OMP_VERSION: string = pkg.dependencies["@oh-my-pi/pi-coding-agent"];

export interface PreflightDeps {
	run: CommandRunner;
	env: Record<string, string | undefined>;
	platform: string;
	arch: string;
	uid: number;
	which(name: string): string | null;
	exists(path: string): Promise<boolean>;
	/** `/proc/1/comm`, `/proc/meminfo`. */
	readText(path: string): Promise<string>;
	/** Free space of the filesystem that holds `path`. */
	freeBytes(path: string): Promise<number>;
	/** Something listens on `port`, on any local address (loopback, 0.0.0.0, or one interface such as the service IP). */
	portInUse(port: number): Promise<boolean>;
	/** The HTTP status of `GET url` over HTTPS within a few seconds; null when the host cannot be reached. */
	httpsStatus(url: string): Promise<number | null>;
	/** Throws when there is no omp. */
	hostOmp(): Promise<{ path: string; version: string }>;
}

export interface PreflightResult {
	steps: StepResult[];
	/** True when setup cannot go on: an unsupported platform, a failed required check. */
	blocked: boolean;
	/** Tool names from PREFLIGHT_TOOLS that are not installed (setup passes their packages to the root part). */
	missingTools: string[];
	packageManager: PackageManager | null;
	/** Null when omp is missing (setup installs it). */
	omp: { path: string; version: string } | null;
}

export type PreflightMode = "setup" | "doctor" | "node";

/** The ports a node checks: vibemon's cluster listeners; every other port of the server stack is the server's. */
const NODE_PORTS: readonly number[] = [7946, 7947];

const GIB = 1024 ** 3;
const MIN_DISK_BYTES = 30 * GIB;
const MIN_RAM_BYTES = 8 * GIB;
const SERVICE_IP = "10.254.254.1";
const SERVICE_DEVICE = "ompsvc0";
const OMP_INSTALL = "curl -fsSL https://omp.sh/install | sh";
const PROBE_TIMEOUT_MS = 10_000;
/** The directories that hold ip, iptables and mkfs.ext4 on a distribution whose user PATH has no sbin. */
const SBIN_DIRS = "/usr/local/sbin:/usr/sbin:/sbin";

type PortUnit = { unit: string; scope: "system" | "user" };
/** What each port belongs to when omp-cloud's own stack holds it. */
const VMON_UNIT: PortUnit = { unit: "vmon", scope: "system" };
const PORTS: readonly { port: number; owner: PortUnit }[] = [
	{ port: 3000, owner: VMON_UNIT },
	{ port: 7946, owner: VMON_UNIT },
	{ port: 7947, owner: VMON_UNIT },
	{ port: 4000, owner: { unit: "omp-auth-gateway", scope: "user" } },
	{ port: 8765, owner: { unit: "omp-auth-broker", scope: "user" } },
	{ port: 8080, owner: { unit: "omp-cloud", scope: "user" } },
	{ port: 8081, owner: { unit: "omp-cloud", scope: "user" } },
	{ port: 8443, owner: { unit: "omp-cloud", scope: "user" } },
];

const NETWORK_TIMEOUT_MS = 5000;

/** The ports in LISTEN state in a /proc/net/tcp or tcp6 table, whatever address they are bound to. */
export function listeningPorts(procNetTcp: string): Set<number> {
	const ports = new Set<number>();
	for (const line of procNetTcp.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		const local = fields[1];
		if (fields[3] !== "0A" || local === undefined) continue;
		const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
		if (Number.isInteger(port)) ports.add(port);
	}
	return ports;
}

/** The fallback when /proc/net/tcp cannot be read: a connection to loopback. */
function connectsOnLoopback(port: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.setTimeout(2000);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

export function realPreflightDeps(): PreflightDeps {
	const searchPath = `${process.env.PATH ?? ""}:${SBIN_DIRS}`;
	return {
		run: runCommand,
		env: process.env,
		platform: process.platform,
		arch: process.arch,
		uid: process.getuid?.() ?? -1,
		which: (name) => Bun.which(name, { PATH: searchPath }),
		exists: (path) => access(path).then(() => true, () => false),
		readText: (path) => Bun.file(path).text(),
		freeBytes: async (path) => {
			// The directory may not exist yet (`/var/lib` always does; a custom path might not): measure its nearest parent.
			let dir = path;
			for (;;) {
				try {
					const stats = await statfs(dir);
					return stats.bavail * stats.bsize;
				} catch (error) {
					const parent = dirname(dir);
					if (parent === dir) throw error;
					dir = parent;
				}
			}
		},
		portInUse: async (port) => {
			try {
				for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
					if (listeningPorts(await Bun.file(table).text()).has(port)) return true;
				}
				return false;
			} catch {
				return connectsOnLoopback(port);
			}
		},
		httpsStatus: async (url) => {
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS), redirect: "manual" });
				await response.body?.cancel();
				return response.status;
			} catch {
				return null;
			}
		},
		hostOmp: () => hostOmp(process.env),
	};
}

/** The command's result, or null when it cannot even start (the program is not installed). */
async function attempt(run: CommandRunner, argv: readonly string[]): Promise<CommandResult | null> {
	try {
		return await run(argv, { timeoutMs: PROBE_TIMEOUT_MS });
	} catch {
		return null;
	}
}

function step(id: string, status: StepResult["status"], detail: string, fix?: string): StepResult {
	const result: StepResult = { id: `preflight.${id}`, status, detail };
	if (fix !== undefined) result.fix = fix;
	return result;
}

async function checkSystemd(deps: PreflightDeps): Promise<StepResult> {
	let comm: string;
	try {
		comm = (await deps.readText("/proc/1/comm")).trim();
	} catch {
		return step("systemd", "failed", "cannot tell what PID 1 is (/proc/1/comm is unreadable)", "run omp-cloud on a distribution that uses systemd (Debian, Ubuntu, Fedora, Arch)");
	}
	if (comm === "systemd") return step("systemd", "ok", "PID 1 is systemd");
	return step("systemd", "failed", `PID 1 is ${comm}, not systemd (omp-cloud's units need systemd)`, "run omp-cloud on a distribution that uses systemd (Debian, Ubuntu, Fedora, Arch); a container usually does not");
}

async function checkUserManager(deps: PreflightDeps): Promise<StepResult> {
	const result = await attempt(deps.run, ["systemctl", "--user", "show-environment"]);
	if (result?.code === 0) return step("user-manager", "ok", "the systemd user manager is reachable");
	return step(
		"user-manager",
		"failed",
		"no systemd user manager is reachable (systemctl --user fails)",
		"log in through ssh or the console, or run `loginctl enable-linger $USER` and log in again",
	);
}

async function checkOmp(deps: PreflightDeps, mode: "setup" | "doctor"): Promise<{ step: StepResult; omp: PreflightResult["omp"] }> {
	let found: { path: string; version: string };
	try {
		found = await deps.hostOmp();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.startsWith("omp is not installed")) {
			return { step: step("omp", "failed", `omp does not work: ${message}`, "omp update"), omp: null };
		}
		if (mode === "setup") {
			return { step: step("omp", "skipped", `omp is not installed; setup will install it with omp's installer (${OMP_INSTALL})`), omp: null };
		}
		return { step: step("omp", "failed", "omp is not installed", OMP_INSTALL), omp: null };
	}
	if (compareVersions(found.version, MIN_OMP_VERSION) < 0) {
		return { step: step("omp", "failed", `omp ${found.version} at ${found.path} is older than the ${MIN_OMP_VERSION} omp-cloud needs`, "omp update"), omp: found };
	}
	return { step: step("omp", "ok", `omp ${found.version} at ${found.path}`), omp: found };
}

function checkTools(deps: PreflightDeps, mode: PreflightMode, packageManager: PackageManager | null): { step: StepResult; missing: string[] } {
	const missing = PREFLIGHT_TOOLS.filter((tool) => deps.which(tool) === null);
	if (missing.length === 0) return { step: step("tools", "ok", `all ${PREFLIGHT_TOOLS.length} required tools are installed`), missing: [] };
	if (packageManager === null) {
		return { step: step("tools", "failed", `missing tools: ${missing.join(", ")}; no package manager (apt, dnf or pacman) was found to install them`, `install: ${missing.join(" ")}`), missing };
	}
	const packages = packagesFor(packageManager, missing);
	if (mode !== "doctor") {
		return { step: step("tools", "skipped", `missing: ${missing.join(", ")}; will be installed: ${packages.join(", ")}`), missing };
	}
	return { step: step("tools", "failed", `missing tools: ${missing.join(", ")}`, installCommand(packageManager, packages)), missing };
}

async function checkDisk(deps: PreflightDeps): Promise<StepResult> {
	let free: number;
	try {
		free = await deps.freeBytes("/var/lib");
	} catch (error) {
		return step("disk", "skipped", `could not measure the free space under /var/lib: ${error instanceof Error ? error.message : String(error)}`);
	}
	const gib = (free / GIB).toFixed(1);
	if (free < MIN_DISK_BYTES) return step("disk", "ok", `warning: ${gib} GiB free under /var/lib; VM templates and snapshots want at least ${MIN_DISK_BYTES / GIB} GiB`);
	return step("disk", "ok", `${gib} GiB free under /var/lib`);
}

async function checkRam(deps: PreflightDeps): Promise<StepResult> {
	let text: string;
	try {
		text = await deps.readText("/proc/meminfo");
	} catch (error) {
		return step("ram", "skipped", `could not read /proc/meminfo: ${error instanceof Error ? error.message : String(error)}`);
	}
	const match = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
	if (match?.[1] === undefined) return step("ram", "skipped", "/proc/meminfo has no MemTotal line");
	const total = Number(match[1]) * 1024;
	const gib = (total / GIB).toFixed(1);
	if (total < MIN_RAM_BYTES) return step("ram", "ok", `warning: ${gib} GiB RAM; sandboxes share it, ${MIN_RAM_BYTES / GIB} GiB or more is comfortable`);
	return step("ram", "ok", `${gib} GiB RAM`);
}

async function checkPorts(deps: PreflightDeps, mode: PreflightMode): Promise<StepResult> {
	const free: number[] = [];
	const ours: number[] = [];
	const strangers: number[] = [];
	for (const { port, owner } of mode === "node" ? PORTS.filter((entry) => NODE_PORTS.includes(entry.port)) : PORTS) {
		if (!(await deps.portInUse(port))) {
			free.push(port);
			continue;
		}
		const argv = owner.scope === "system" ? ["systemctl", "is-active", "--quiet", owner.unit] : ["systemctl", "--user", "is-active", "--quiet", owner.unit];
		const active = await attempt(deps.run, argv);
		(active?.code === 0 ? ours : strangers).push(port);
	}
	if (strangers.length > 0) {
		return step(
			"ports",
			"failed",
			`port${strangers.length === 1 ? "" : "s"} ${strangers.join(", ")} already in use by something that is not omp-cloud's stack`,
			strangers.map((port) => `ss -ltnp 'sport = :${port}'`).join("; "),
		);
	}
	const parts: string[] = [];
	if (free.length > 0) parts.push(`free: ${free.join(" ")}`);
	if (ours.length > 0) parts.push(`already ours: ${ours.join(" ")}`);
	return step("ports", "ok", parts.join("; "));
}

/** The IPv4 addresses of this machine and the device each is on; null when `ip` cannot list them. */
async function localAddresses(deps: PreflightDeps): Promise<{ device: string; address: string }[] | null> {
	const result = await attempt(deps.run, [deps.which("ip") ?? "ip", "-o", "-4", "addr", "show"]);
	if (result === null || result.code !== 0) return null;
	const found: { device: string; address: string }[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = /^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\//.exec(line);
		if (match?.[1] !== undefined && match[2] !== undefined) found.push({ device: match[1].split("@")[0] ?? match[1], address: match[2] });
	}
	return found;
}

async function checkServiceIp(deps: PreflightDeps): Promise<StepResult> {
	const addresses = await localAddresses(deps);
	if (addresses === null) return step("service-ip", "skipped", `could not list the host's addresses to look for ${SERVICE_IP}`);
	const holders = addresses.filter((entry) => entry.address === SERVICE_IP).map((entry) => entry.device);
	const foreign = holders.find((device) => device !== SERVICE_DEVICE);
	if (foreign !== undefined) {
		return step("service-ip", "failed", `${SERVICE_IP} is already on the device ${foreign}; sandboxes reach the host only through it on ${SERVICE_DEVICE}`, `remove ${SERVICE_IP} from ${foreign}: sudo ip addr del ${SERVICE_IP}/32 dev ${foreign}, and find what put it there`);
	}
	if (holders.length > 0) return step("service-ip", "ok", `${SERVICE_IP} is on ${SERVICE_DEVICE}`);
	return step("service-ip", "ok", `${SERVICE_IP} is free (setup creates ${SERVICE_DEVICE})`);
}

/** The address other vibemon machines join on must be this machine's own, on a real device, and a LAN address. */
async function checkClusterAddress(deps: PreflightDeps, address: string): Promise<StepResult> {
	const addresses = await localAddresses(deps);
	if (addresses === null) {
		return step("cluster-address", "failed", `could not list the host's addresses to look for ${address}`, "check that `ip -o -4 addr show` works on this machine");
	}
	if (!addresses.some((entry) => entry.address === address && entry.device !== SERVICE_DEVICE)) {
		return step("cluster-address", "failed", `${address} is not an address of this machine`, "pass this machine's own LAN address: omp-cloud setup --cluster-address <ip>, or --no-cluster to stay single-machine");
	}
	if (!isPrivateLan(address)) {
		return step(
			"cluster-address",
			"failed",
			`${address} is not a private LAN address: vibemon's cluster ports must not face the internet, and VMs on other machines reach the server's ${SERVICE_IP} only over a LAN`,
			"pass a 10.x, 172.16-31.x or 192.168.x address of this machine: omp-cloud setup --cluster-address <ip>, or --no-cluster to stay single-machine",
		);
	}
	return step("cluster-address", "ok", `${address} is a LAN address of this machine`);
}

/** What setup and the VM templates download from; any HTTP answer means the host can reach it. */
const NETWORK_HOSTS: readonly { host: string; url: string; what: string }[] = [
	{ host: "github.com", url: "https://github.com/", what: "omp-cloud and vibemon releases" },
	{ host: "build.stencil.so", url: "https://build.stencil.so/", what: "omp's build service, which VM templates install omp from" },
	{ host: "registry-1.docker.io", url: "https://registry-1.docker.io/v2/", what: "the base image of VM templates; it answers 401 when reachable" },
];
/** A node only downloads omp-cloud and vibemon releases: its VMs' templates are built by the server. */
const NODE_NETWORK_HOSTS = NETWORK_HOSTS.filter((target) => target.host === "github.com");

/** Warning level only: a host that cannot be reached is named, but never blocks (a mirror or proxy may be in place). */
async function checkNetwork(deps: PreflightDeps, mode: PreflightMode): Promise<StepResult> {
	const hosts = mode === "node" ? NODE_NETWORK_HOSTS : NETWORK_HOSTS;
	const answers = await Promise.all(hosts.map(async (target) => ({ target, status: await deps.httpsStatus(target.url) })));
	const unreachable = answers.filter((answer) => answer.status === null).map((answer) => answer.target);
	if (unreachable.length === 0) return step("network", "ok", `reachable over HTTPS: ${hosts.map((target) => target.host).join(", ")}`);
	return step(
		"network",
		"ok",
		`warning: cannot reach ${unreachable.map((target) => `${target.host} (${target.what})`).join("; ")}; open outbound HTTPS (port 443) to ${unreachable.map((target) => target.host).join(", ")}, or setup and the first VM template build will fail`,
	);
}

/**
 * Every precondition of the service host, read-only. A failed step names its fix. `setup` mode treats a missing omp and
 * missing tools as work setup does itself (a `skipped` step that says so); `doctor` mode reports them as failures.
 * `node` mode is a machine that only joins a server's vibemon cluster: no omp and no user manager are needed, only
 * ports 7946 and 7947 matter, and only github.com has to be reachable; a missing tool is work the root part does.
 * `blocked` is true for an unsupported platform in any mode and, outside `doctor` mode, for any failed step.
 * `options.clusterAddress` (a server that takes other machines) adds the `cluster-address` check.
 */
export async function preflight(deps: PreflightDeps, mode: PreflightMode, options: { clusterAddress?: string } = {}): Promise<PreflightResult> {
	if (deps.platform !== "linux" || deps.arch !== "x64") {
		return {
			steps: [
				step(
					"platform",
					"failed",
					`this machine is ${deps.platform} ${deps.arch}: the service host needs Linux x86_64 with KVM; another machine only needs the plugin: omp plugin marketplace add TechDufus/omp-cloud`,
				),
			],
			blocked: true,
			missingTools: [],
			packageManager: null,
			omp: null,
		};
	}
	const steps: StepResult[] = [step("platform", "ok", "Linux x86_64")];

	steps.push(
		(await deps.exists("/dev/kvm"))
			? step("kvm", "ok", "/dev/kvm is present")
			: step("kvm", "failed", "/dev/kvm is missing", "enable hardware virtualization in the BIOS, or nested virtualization in the VM settings of this machine"),
	);
	steps.push(await checkSystemd(deps));
	if (mode !== "node") steps.push(await checkUserManager(deps));
	steps.push(
		deps.which("sudo") === null
			? step("sudo", "failed", "sudo is not installed; setup needs it once for the root part", "install sudo with your package manager as root, then run omp-cloud setup again")
			: step("sudo", "ok", "sudo is installed"),
	);

	const ompCheck = mode === "node" ? null : await checkOmp(deps, mode);
	if (ompCheck !== null) steps.push(ompCheck.step);

	const packageManager = detectPackageManager(deps.which);
	const tools = checkTools(deps, mode, packageManager);
	steps.push(tools.step);

	steps.push(await checkDisk(deps));
	steps.push(await checkRam(deps));
	steps.push(await checkPorts(deps, mode));
	steps.push(await checkServiceIp(deps));
	if (options.clusterAddress !== undefined) steps.push(await checkClusterAddress(deps, options.clusterAddress));
	steps.push(await checkNetwork(deps, mode));

	return {
		steps,
		blocked: mode !== "doctor" && steps.some((s) => s.status === "failed"),
		missingTools: tools.missing,
		packageManager,
		omp: ompCheck?.omp ?? null,
	};
}
