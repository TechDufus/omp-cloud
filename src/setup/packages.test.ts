import { describe, expect, test } from "bun:test";
import { detectPackageManager, installCommand, installPackages, PACKAGE_NAMES, packagesFor, PREFLIGHT_TOOLS } from "./packages";
import { fakeRunner } from "./system-fakes";

describe("detectPackageManager", () => {
	test("prefers apt-get, then dnf, then pacman, and is null when there is none", () => {
		const has = (...names: string[]) => (name: string) => (names.includes(name) ? `/usr/bin/${name}` : null);
		expect(detectPackageManager(has("apt-get", "dnf"))).toBe("apt");
		expect(detectPackageManager(has("dnf", "pacman"))).toBe("dnf");
		expect(detectPackageManager(has("pacman"))).toBe("pacman");
		expect(detectPackageManager(has())).toBeNull();
	});
});

describe("packagesFor", () => {
	test("maps tools to the packages of the manager, deduplicated and sorted", () => {
		expect(packagesFor("apt", ["ip", "iptables", "iptables-restore", "ip6tables-restore", "mkfs.ext4", "e2fsck", "resize2fs"])).toEqual(["e2fsprogs", "iproute2", "iptables"]);
		expect(packagesFor("dnf", ["ip", "sha256sum", "timeout", "flock"])).toEqual(["coreutils", "iproute", "util-linux"]);
		expect(packagesFor("pacman", ["git", "curl", "tar"])).toEqual(["curl", "git", "tar"]);
	});

	test("udevadm comes from the package that makes /dev/kvm group kvm: udev, systemd-udev, systemd", () => {
		expect(packagesFor("apt", ["udevadm"])).toEqual(["udev"]);
		expect(packagesFor("dnf", ["udevadm"])).toEqual(["systemd-udev"]);
		expect(packagesFor("pacman", ["udevadm"])).toEqual(["systemd"]);
	});

	test("every preflight tool has a package on every manager", () => {
		for (const manager of ["apt", "dnf", "pacman"] as const) expect(packagesFor(manager, PREFLIGHT_TOOLS).every((name) => PACKAGE_NAMES.has(name))).toBe(true);
	});

	test("a name that is not a preflight tool is refused", () => {
		expect(() => packagesFor("apt", ["rm"])).toThrow("not a preflight tool");
	});
});

describe("installCommand", () => {
	test("is the line a user runs for each manager", () => {
		expect(installCommand("apt", ["curl", "git"])).toBe("sudo apt-get install -y curl git");
		expect(installCommand("dnf", ["curl"])).toBe("sudo dnf install -y curl");
		expect(installCommand("pacman", ["curl"])).toBe("sudo pacman -S --needed --noconfirm curl");
	});
});

describe("installPackages", () => {
	test("apt refreshes its lists, then installs non-interactively", async () => {
		const runner = fakeRunner();
		const step = await installPackages(runner.run, "apt", ["curl", "iproute2"]);
		expect(step).toMatchObject({ id: "system.packages", status: "changed" });
		expect(runner.lines()).toEqual(["apt-get update", "apt-get install -y curl iproute2"]);
		expect(runner.calls.every((call) => call.options.env?.DEBIAN_FRONTEND === "noninteractive")).toBe(true);
	});

	test("dnf and pacman run one install each", async () => {
		const dnf = fakeRunner();
		await installPackages(dnf.run, "dnf", ["iproute", "git"]);
		expect(dnf.lines()).toEqual(["dnf install -y iproute git"]);
		const pacman = fakeRunner();
		await installPackages(pacman.run, "pacman", ["iproute2"]);
		expect(pacman.lines()).toEqual(["pacman -S --needed --noconfirm iproute2"]);
	});

	test("a name outside the manager's set is refused before anything runs", async () => {
		const runner = fakeRunner();
		await expect(installPackages(runner.run, "apt", ["curl", "openssh-server"])).rejects.toThrow("fixed package set");
		await expect(installPackages(runner.run, "apt", ["iproute"])).rejects.toThrow("fixed package set");
		await expect(installPackages(runner.run, "dnf", ["iproute2"])).rejects.toThrow("fixed package set");
		expect(runner.calls).toEqual([]);
	});

	test("a failed install is a failed step that names the command to run", async () => {
		const runner = fakeRunner((argv) => (argv[1] === "install" ? { code: 100, stderr: "E: Unable to locate package curl\n" } : undefined));
		const step = await installPackages(runner.run, "apt", ["curl"]);
		expect(step).toMatchObject({ status: "failed", fix: "sudo apt-get install -y curl" });
		expect(step.detail).toContain("Unable to locate package curl");
	});

	test("a failed apt update is not fatal", async () => {
		const runner = fakeRunner((argv) => (argv[1] === "update" ? { code: 100, stderr: "offline" } : undefined));
		expect((await installPackages(runner.run, "apt", ["curl"])).status).toBe("changed");
	});

	test("an empty list is skipped", async () => {
		const runner = fakeRunner();
		expect((await installPackages(runner.run, "apt", [])).status).toBe("skipped");
		expect(runner.calls).toEqual([]);
	});
});
