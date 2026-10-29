/**
 * The system packages `omp-cloud setup` may install for the tools vibemon and the root helper shell out to. The set is
 * fixed: the root part takes `--packages` from a user-writable caller (through sudo), so it installs a name only when it is
 * one of these, never anything else a caller names.
 */
import type { CommandRunner } from "../update/system";
import { lastLine } from "../update/system";
import type { StepResult } from "./steps";

export type PackageManager = "apt" | "dnf" | "pacman";

/** The programs the preflight checks (vibemon, its helper and the service need them). */
export const PREFLIGHT_TOOLS = ["ip", "iptables", "iptables-restore", "ip6tables-restore", "mkfs.ext4", "e2fsck", "resize2fs", "curl", "tar", "sha256sum", "flock", "timeout", "git", "udevadm"] as const;
export type PreflightTool = (typeof PREFLIGHT_TOOLS)[number];

/** Which package of each manager provides each tool. */
const PACKAGE_OF: Readonly<Record<PackageManager, Readonly<Record<PreflightTool, string>>>> = {
	apt: {
		ip: "iproute2",
		iptables: "iptables",
		"iptables-restore": "iptables",
		"ip6tables-restore": "iptables",
		"mkfs.ext4": "e2fsprogs",
		e2fsck: "e2fsprogs",
		resize2fs: "e2fsprogs",
		curl: "curl",
		tar: "tar",
		sha256sum: "coreutils",
		flock: "util-linux",
		timeout: "coreutils",
		git: "git",
		udevadm: "udev",
	},
	dnf: {
		ip: "iproute",
		iptables: "iptables",
		"iptables-restore": "iptables",
		"ip6tables-restore": "iptables",
		"mkfs.ext4": "e2fsprogs",
		e2fsck: "e2fsprogs",
		resize2fs: "e2fsprogs",
		curl: "curl",
		tar: "tar",
		sha256sum: "coreutils",
		flock: "util-linux",
		timeout: "coreutils",
		git: "git",
		udevadm: "systemd-udev",
	},
	pacman: {
		ip: "iproute2",
		iptables: "iptables",
		"iptables-restore": "iptables",
		"ip6tables-restore": "iptables",
		"mkfs.ext4": "e2fsprogs",
		e2fsck: "e2fsprogs",
		resize2fs: "e2fsprogs",
		curl: "curl",
		tar: "tar",
		sha256sum: "coreutils",
		flock: "util-linux",
		timeout: "coreutils",
		git: "git",
		udevadm: "systemd",
	},
};

/** The package names `manager` may install. */
export function packageSet(manager: PackageManager): ReadonlySet<string> {
	return new Set(Object.values(PACKAGE_OF[manager]));
}

/** Every name any manager may install: what `--packages` can carry before the manager is known. */
export const PACKAGE_NAMES: ReadonlySet<string> = new Set((Object.keys(PACKAGE_OF) as PackageManager[]).flatMap((manager) => [...packageSet(manager)]));

function isPreflightTool(name: string): name is PreflightTool {
	return (PREFLIGHT_TOOLS as readonly string[]).includes(name);
}

/** The package manager of this machine: the first of apt-get, dnf and pacman that `which` finds. */
export function detectPackageManager(which: (name: string) => string | null): PackageManager | null {
	if (which("apt-get") !== null) return "apt";
	if (which("dnf") !== null) return "dnf";
	if (which("pacman") !== null) return "pacman";
	return null;
}

/** The packages (deduplicated, sorted) that provide `missingTools` on `manager`. Throws for a name that is not a preflight tool. */
export function packagesFor(manager: PackageManager, missingTools: readonly string[]): string[] {
	const names = new Set<string>();
	for (const tool of missingTools) {
		if (!isPreflightTool(tool)) throw new Error(`${JSON.stringify(tool)} is not a preflight tool`);
		names.add(PACKAGE_OF[manager][tool]);
	}
	return [...names].sort();
}

/** The argv of the install, program first. */
function installArgv(manager: PackageManager, packages: readonly string[]): string[] {
	switch (manager) {
		case "apt":
			return ["apt-get", "install", "-y", ...packages];
		case "dnf":
			return ["dnf", "install", "-y", ...packages];
		case "pacman":
			return ["pacman", "-S", "--needed", "--noconfirm", ...packages];
	}
}

/** The command line a user runs to install `packages` (a fix for a doctor line). */
export function installCommand(manager: PackageManager, packages: readonly string[]): string {
	return `sudo ${installArgv(manager, packages).join(" ")}`;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Installs `packages` with `manager`, as root (no sudo here). Every name must be one `manager` provides for a preflight tool;
 * anything else is refused before a command runs. apt refreshes its lists first (a new machine has none) and a failed refresh
 * is not fatal: the install may still work from what is cached.
 */
export async function installPackages(runner: CommandRunner, manager: PackageManager, packages: readonly string[]): Promise<StepResult> {
	const allowed = packageSet(manager);
	const refused = packages.filter((name) => !allowed.has(name));
	if (refused.length > 0) throw new Error(`refusing to install ${refused.map((name) => JSON.stringify(name)).join(", ")}: not in the fixed package set of ${manager}`);
	if (packages.length === 0) return { id: "system.packages", status: "skipped", detail: "no packages requested" };
	const env = { DEBIAN_FRONTEND: "noninteractive" };
	if (manager === "apt") await runner(["apt-get", "update"], { timeoutMs: INSTALL_TIMEOUT_MS, env });
	const result = await runner(installArgv(manager, packages), { timeoutMs: INSTALL_TIMEOUT_MS, env });
	if (result.code === 0) return { id: "system.packages", status: "changed", detail: `installed ${packages.join(", ")} with ${manager}` };
	const reason = lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`;
	return { id: "system.packages", status: "failed", detail: `${manager} could not install ${packages.join(", ")}: ${reason}`, fix: installCommand(manager, packages) };
}
