import { describe, expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { recordingRunner } from "../update/test-support";
import { PREFLIGHT_TOOLS } from "./packages";
import { listeningPorts, MIN_OMP_VERSION, type PreflightDeps, type PreflightResult, preflight } from "./preflight";

const GIB = 1024 ** 3;
const MEMINFO = (gib: number) => `MemTotal:       ${gib * 1024 * 1024} kB\nMemFree:        1234 kB\n`;
const IP_LISTING = "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever\n2: eth0    inet 192.168.1.5/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever\n";
const SERVICE_IP_ON_DUMMY = `${IP_LISTING}7: ompsvc0    inet 10.254.254.1/32 scope global ompsvc0\\       valid_lft forever\n`;

interface Host {
	platform?: string;
	arch?: string;
	kvm?: boolean;
	pid1?: string;
	userManager?: boolean;
	missing?: string[];
	omp?: { path: string; version: string } | Error;
	freeGiB?: number;
	ramGiB?: number;
	/** Ports something listens on. */
	listening?: number[];
	/** Systemd units that are active (`vmon` for system, the rest user units). */
	active?: string[];
	ipAddrs?: string;
	/** The HTTP status each HTTPS probe gets, null for an unreachable host. Default: every host answers 200. */
	httpsStatus?: (url: string) => number | null;
}

/** A fake machine: `deps` plus the commands the preflight ran. */
function fakeHost(host: Host = {}): { deps: PreflightDeps; commands: () => string[][] } {
	const missing = new Set(host.missing ?? []);
	const active = new Set(host.active ?? []);
	const listening = new Set(host.listening ?? []);
	const { run, calls } = recordingRunner((argv) => {
		if (argv[1] === "--user" && argv[2] === "show-environment") return host.userManager === false ? { code: 1 } : {};
		if (argv[0] === "systemctl" && argv.includes("is-active")) return active.has(argv.at(-1) ?? "") ? {} : { code: 3 };
		if (argv.slice(1).join(" ") === "-o -4 addr show") return { stdout: host.ipAddrs ?? IP_LISTING };
		return undefined;
	});
	const deps: PreflightDeps = {
		run,
		env: {},
		platform: host.platform ?? "linux",
		arch: host.arch ?? "x64",
		uid: 1000,
		which: (name) => (missing.has(name) ? null : `/usr/bin/${name}`),
		exists: async (path) => (path === "/dev/kvm" ? host.kvm !== false : true),
		readText: async (path) => {
			if (path === "/proc/1/comm") return `${host.pid1 ?? "systemd"}\n`;
			if (path === "/proc/meminfo") return MEMINFO(host.ramGiB ?? 16);
			throw new Error(`unexpected read of ${path}`);
		},
		freeBytes: async () => (host.freeGiB ?? 200) * GIB,
		portInUse: async (port) => listening.has(port),
		httpsStatus: async (url) => (host.httpsStatus === undefined ? 200 : host.httpsStatus(url)),
		hostOmp: async () => {
			const omp = host.omp ?? { path: "/home/u/.local/share/tern/omp/bin/omp", version: MIN_OMP_VERSION };
			if (omp instanceof Error) throw omp;
			return omp;
		},
	};
	return { deps, commands: () => calls.map((call) => call.argv) };
}

function stepOf(result: PreflightResult, name: string) {
	const found = result.steps.find((s) => s.id === `preflight.${name}`);
	if (found === undefined) throw new Error(`no step preflight.${name} in ${result.steps.map((s) => s.id).join(", ")}`);
	return found;
}

const NO_OMP = new Error("omp is not installed on the service host (no Tern install, no omp on PATH)");

describe("MIN_OMP_VERSION", () => {
	test("is the SDK version package.json pins", () => {
		expect(MIN_OMP_VERSION).toBe(pkg.dependencies["@oh-my-pi/pi-coding-agent"]);
		expect(MIN_OMP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("preflight on a good host", () => {
	test("every check passes in both modes, in order, and nothing is blocked", async () => {
		for (const mode of ["setup", "doctor"] as const) {
			const result = await preflight(fakeHost().deps, mode);
			expect(result.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
				"preflight.platform:ok",
				"preflight.kvm:ok",
				"preflight.systemd:ok",
				"preflight.user-manager:ok",
				"preflight.sudo:ok",
				"preflight.omp:ok",
				"preflight.tools:ok",
				"preflight.disk:ok",
				"preflight.ram:ok",
				"preflight.ports:ok",
				"preflight.service-ip:ok",
				"preflight.network:ok",
			]);
			expect(result.blocked).toBe(false);
			expect(result.missingTools).toEqual([]);
			expect(result.packageManager).toBe("apt");
			expect(result.omp?.version).toBe(MIN_OMP_VERSION);
		}
	});

	test("ports free and the service IP absent are reported as such", async () => {
		const result = await preflight(fakeHost().deps, "setup");
		expect(stepOf(result, "ports").detail).toBe("free: 3000 7946 7947 4000 8765 8080 8081 8443");
		expect(stepOf(result, "service-ip").detail).toContain("is free");
	});

	test("changes nothing: the only commands are probes", async () => {
		const { deps, commands } = fakeHost();
		await preflight(deps, "setup");
		expect(commands().map((argv) => argv.join(" "))).toEqual(["systemctl --user show-environment", "/usr/bin/ip -o -4 addr show"]);
	});
});

describe("listeningPorts", () => {
	const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

	test("reads LISTEN sockets bound to any address: all, loopback or one interface (the service IP)", () => {
		const table =
			HEADER +
			"   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1\n" +
			"   1: 01FEFE0A:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1\n" +
			"   2: 0100007F:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1\n" +
			"   3: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4 1\n" +
			"   4: 0100007F:C350 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 5 1\n";
		expect([...listeningPorts(table)].sort((a, b) => a - b)).toEqual([3000, 4000, 8080]);
	});

	test("an IPv6 table works the same, and an empty one holds nothing", () => {
		const table = HEADER + "   0: 00000000000000000000000001000000:1FA1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1\n";
		expect([...listeningPorts(table)]).toEqual([8097]);
		expect(listeningPorts(HEADER).size).toBe(0);
	});
});

describe("network", () => {
	test("all three hosts reachable is a quiet ok; any HTTP status counts", async () => {
		const result = await preflight(fakeHost({ httpsStatus: () => 401 }).deps, "setup");
		expect(stepOf(result, "network")).toMatchObject({ status: "ok", detail: "reachable over HTTPS: github.com, build.stencil.so, registry-1.docker.io" });
	});

	test("an unreachable host is a warning that names it and what to open, and never blocks", async () => {
		const urls: string[] = [];
		const { deps } = fakeHost({
			httpsStatus: (url) => {
				urls.push(url);
				return url.includes("build.stencil.so") ? null : 200;
			},
		});
		for (const mode of ["setup", "doctor"] as const) {
			const result = await preflight(deps, mode);
			const network = stepOf(result, "network");
			expect(network.status).toBe("ok");
			expect(network.detail).toMatch(/^warning: cannot reach build\.stencil\.so \(omp's build service/);
			expect(network.detail).toContain("open outbound HTTPS (port 443) to build.stencil.so");
			expect(network.detail).not.toContain("github.com");
			expect(result.blocked).toBe(false);
		}
		expect(urls.slice(0, 3)).toEqual(["https://github.com/", "https://build.stencil.so/", "https://registry-1.docker.io/v2/"]);
	});
});

describe("platform", () => {
	test("anything but Linux x86_64 is one failed line, returned at once", async () => {
		for (const host of [{ platform: "darwin", arch: "arm64" }, { platform: "linux", arch: "arm64" }, { platform: "win32", arch: "x64" }]) {
			const result = await preflight(fakeHost(host).deps, "setup");
			expect(result.steps).toHaveLength(1);
			expect(result.steps[0]).toMatchObject({ id: "preflight.platform", status: "failed" });
			expect(result.steps[0]?.detail).toContain("the service host needs Linux x86_64 with KVM");
			expect(result.steps[0]?.detail).toContain("another machine only needs the plugin: omp plugin marketplace add TechDufus/omp-cloud");
			expect(result.blocked).toBe(true);
			expect(result.packageManager).toBeNull();
			expect(result.omp).toBeNull();
		}
	});

	test("doctor mode blocks the same way and runs no command", async () => {
		const { deps, commands } = fakeHost({ platform: "darwin" });
		const result = await preflight(deps, "doctor");
		expect(result.blocked).toBe(true);
		expect(commands()).toEqual([]);
	});
});

describe("required checks", () => {
	test("no /dev/kvm", async () => {
		const result = await preflight(fakeHost({ kvm: false }).deps, "setup");
		expect(stepOf(result, "kvm")).toMatchObject({ status: "failed", detail: "/dev/kvm is missing" });
		expect(stepOf(result, "kvm").fix).toContain("nested virtualization in the VM settings");
		expect(result.blocked).toBe(true);
	});

	test("PID 1 is not systemd", async () => {
		const result = await preflight(fakeHost({ pid1: "tini" }).deps, "setup");
		expect(stepOf(result, "systemd")).toMatchObject({ status: "failed" });
		expect(stepOf(result, "systemd").detail).toContain("PID 1 is tini");
		expect(stepOf(result, "systemd").fix).toBeDefined();
		expect(result.blocked).toBe(true);
	});

	test("no reachable user manager names both ways out", async () => {
		const result = await preflight(fakeHost({ userManager: false }).deps, "setup");
		expect(stepOf(result, "user-manager")).toMatchObject({ status: "failed" });
		expect(stepOf(result, "user-manager").fix).toBe("log in through ssh or the console, or run `loginctl enable-linger $USER` and log in again");
		expect(result.blocked).toBe(true);
	});

	test("no sudo", async () => {
		const result = await preflight(fakeHost({ missing: ["sudo"] }).deps, "setup");
		expect(stepOf(result, "sudo")).toMatchObject({ status: "failed", detail: expect.stringContaining("sudo is not installed") });
		expect(stepOf(result, "sudo").fix).toBeDefined();
		expect(result.blocked).toBe(true);
	});

	test("a failure does not stop the later checks", async () => {
		const result = await preflight(fakeHost({ kvm: false, pid1: "init" }).deps, "setup");
		expect(result.steps).toHaveLength(12);
		expect(result.steps.filter((s) => s.status === "failed").map((s) => s.id)).toEqual(["preflight.kvm", "preflight.systemd"]);
	});

	test("doctor mode reports the failure but is not blocked", async () => {
		const result = await preflight(fakeHost({ kvm: false }).deps, "doctor");
		expect(stepOf(result, "kvm").status).toBe("failed");
		expect(result.blocked).toBe(false);
	});
});

describe("omp", () => {
	test("older than the minimum fails with omp update, in both modes", async () => {
		for (const mode of ["setup", "doctor"] as const) {
			const result = await preflight(fakeHost({ omp: { path: "/usr/bin/omp", version: "18.0.0" } }).deps, mode);
			expect(stepOf(result, "omp")).toMatchObject({ status: "failed", fix: "omp update" });
			expect(stepOf(result, "omp").detail).toContain(`18.0.0`);
			expect(stepOf(result, "omp").detail).toContain(MIN_OMP_VERSION);
			expect(result.omp).toEqual({ path: "/usr/bin/omp", version: "18.0.0" });
			expect(result.blocked).toBe(mode === "setup");
		}
	});

	test("a newer omp passes", async () => {
		const result = await preflight(fakeHost({ omp: { path: "/usr/bin/omp", version: "99.0.0" } }).deps, "setup");
		expect(stepOf(result, "omp").status).toBe("ok");
	});

	test("missing: setup installs it (skipped, not blocked)", async () => {
		const result = await preflight(fakeHost({ omp: NO_OMP }).deps, "setup");
		expect(stepOf(result, "omp").status).toBe("skipped");
		expect(stepOf(result, "omp").detail).toContain("curl -fsSL https://omp.sh/install | sh");
		expect(result.omp).toBeNull();
		expect(result.blocked).toBe(false);
	});

	test("missing: doctor fails with the installer as the fix", async () => {
		const result = await preflight(fakeHost({ omp: NO_OMP }).deps, "doctor");
		expect(stepOf(result, "omp")).toMatchObject({ status: "failed", fix: "curl -fsSL https://omp.sh/install | sh" });
		expect(result.omp).toBeNull();
	});

	test("an omp that is there but broken is a failure in both modes, never an install", async () => {
		const result = await preflight(fakeHost({ omp: new Error("/usr/bin/omp --version exited 1: boom") }).deps, "setup");
		expect(stepOf(result, "omp")).toMatchObject({ status: "failed", fix: "omp update" });
		expect(stepOf(result, "omp").detail).toContain("boom");
		expect(result.blocked).toBe(true);
	});
});

describe("tools", () => {
	test("setup mode: missing tools are skipped, listed and mapped to packages", async () => {
		const result = await preflight(fakeHost({ missing: ["mkfs.ext4", "e2fsck", "flock"] }).deps, "setup");
		expect(result.missingTools).toEqual(["mkfs.ext4", "e2fsck", "flock"]);
		expect(stepOf(result, "tools").status).toBe("skipped");
		expect(stepOf(result, "tools").detail).toContain("will be installed: e2fsprogs, util-linux");
		expect(result.blocked).toBe(false);
	});

	test("doctor mode: failed, with the install command as the fix", async () => {
		const result = await preflight(fakeHost({ missing: ["mkfs.ext4", "curl"] }).deps, "doctor");
		expect(result.missingTools).toEqual(["mkfs.ext4", "curl"]);
		expect(stepOf(result, "tools")).toMatchObject({ status: "failed", fix: "sudo apt-get install -y curl e2fsprogs" });
	});

	test("no package manager: failed in both modes, naming the tools", async () => {
		for (const mode of ["setup", "doctor"] as const) {
			const result = await preflight(fakeHost({ missing: ["git", "apt-get", "dnf", "pacman"] }).deps, mode);
			expect(result.packageManager).toBeNull();
			expect(stepOf(result, "tools")).toMatchObject({ status: "failed", fix: "install: git" });
			expect(stepOf(result, "tools").detail).toContain("git");
			expect(result.missingTools).toEqual(["git"]);
			expect(result.blocked).toBe(mode === "setup");
		}
	});

	test("checks every tool of PREFLIGHT_TOOLS", async () => {
		const result = await preflight(fakeHost({ missing: [...PREFLIGHT_TOOLS] }).deps, "doctor");
		expect(result.missingTools).toEqual([...PREFLIGHT_TOOLS]);
	});
});

describe("disk and RAM", () => {
	test("low disk warns without failing", async () => {
		const result = await preflight(fakeHost({ freeGiB: 12 }).deps, "setup");
		expect(stepOf(result, "disk").status).toBe("ok");
		expect(stepOf(result, "disk").detail).toMatch(/^warning: 12\.0 GiB free under \/var\/lib/);
		expect(result.blocked).toBe(false);
	});

	test("enough disk is a plain line", async () => {
		const result = await preflight(fakeHost({ freeGiB: 30 }).deps, "setup");
		expect(stepOf(result, "disk").detail).toBe("30.0 GiB free under /var/lib");
	});

	test("low RAM warns without failing", async () => {
		const result = await preflight(fakeHost({ ramGiB: 4 }).deps, "setup");
		expect(stepOf(result, "ram").status).toBe("ok");
		expect(stepOf(result, "ram").detail).toMatch(/^warning: 4\.0 GiB RAM/);
		expect(result.blocked).toBe(false);
	});

	test("measuring errors are skipped, not fatal", async () => {
		const { deps } = fakeHost();
		deps.freeBytes = async () => {
			throw new Error("ENOENT");
		};
		const result = await preflight(deps, "setup");
		expect(stepOf(result, "disk").status).toBe("skipped");
		expect(result.blocked).toBe(false);
	});
});

describe("ports", () => {
	test("in use by a stranger fails and names the process lookup", async () => {
		const result = await preflight(fakeHost({ listening: [3000, 8080] }).deps, "setup");
		expect(stepOf(result, "ports")).toMatchObject({ status: "failed" });
		expect(stepOf(result, "ports").detail).toContain("3000, 8080");
		expect(stepOf(result, "ports").fix).toBe("ss -ltnp 'sport = :3000'; ss -ltnp 'sport = :8080'");
		expect(result.blocked).toBe(true);
	});

	test("in use by our own active units is fine, each asked at its own unit", async () => {
		const { deps, commands } = fakeHost({ listening: [3000, 7946, 4000, 8765, 8080, 8443], active: ["vmon", "omp-auth-gateway", "omp-auth-broker", "omp-cloud"] });
		const result = await preflight(deps, "setup");
		expect(stepOf(result, "ports")).toMatchObject({ status: "ok", detail: "free: 7947 8081; already ours: 3000 7946 4000 8765 8080 8443" });
		const asked = commands().filter((argv) => argv.includes("is-active")).map((argv) => argv.join(" "));
		expect(asked).toContain("systemctl is-active --quiet vmon");
		expect(asked).toContain("systemctl --user is-active --quiet omp-auth-gateway");
		expect(asked).toContain("systemctl --user is-active --quiet omp-auth-broker");
		expect(asked).toContain("systemctl --user is-active --quiet omp-cloud");
		expect(result.blocked).toBe(false);
	});

	test("a port is a stranger's when its owner unit is not active", async () => {
		const result = await preflight(fakeHost({ listening: [3000, 4000], active: ["omp-auth-gateway"] }).deps, "setup");
		expect(stepOf(result, "ports").status).toBe("failed");
		expect(stepOf(result, "ports").fix).toBe("ss -ltnp 'sport = :3000'");
	});

	test("the user's unit does not vouch for a vmon port", async () => {
		const result = await preflight(fakeHost({ listening: [3000], active: ["omp-cloud"] }).deps, "doctor");
		expect(stepOf(result, "ports").status).toBe("failed");
	});
});

describe("service IP", () => {
	test("already on ompsvc0 is fine", async () => {
		const result = await preflight(fakeHost({ ipAddrs: SERVICE_IP_ON_DUMMY }).deps, "setup");
		expect(stepOf(result, "service-ip")).toMatchObject({ status: "ok", detail: "10.254.254.1 is on ompsvc0" });
	});

	test("on another device fails and names it", async () => {
		const ipAddrs = `${IP_LISTING}9: wg0    inet 10.254.254.1/24 scope global wg0\\       valid_lft forever\n`;
		const result = await preflight(fakeHost({ ipAddrs }).deps, "setup");
		expect(stepOf(result, "service-ip").status).toBe("failed");
		expect(stepOf(result, "service-ip").detail).toContain("wg0");
		expect(stepOf(result, "service-ip").fix).toContain("wg0");
		expect(result.blocked).toBe(true);
	});

	test("a similar address is not the service IP", async () => {
		const ipAddrs = `${IP_LISTING}9: wg0    inet 10.254.254.10/24 scope global wg0\\       valid_lft forever\n`;
		const result = await preflight(fakeHost({ ipAddrs }).deps, "setup");
		expect(stepOf(result, "service-ip").status).toBe("ok");
	});
});

describe("node mode", () => {
	test("runs the node checks in order: no user manager, no omp", async () => {
		const { deps, commands } = fakeHost();
		const result = await preflight(deps, "node");
		expect(result.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
			"preflight.platform:ok",
			"preflight.kvm:ok",
			"preflight.systemd:ok",
			"preflight.sudo:ok",
			"preflight.tools:ok",
			"preflight.disk:ok",
			"preflight.ram:ok",
			"preflight.ports:ok",
			"preflight.service-ip:ok",
			"preflight.network:ok",
		]);
		expect(result.blocked).toBe(false);
		expect(result.omp).toBeNull();
		expect(commands().map((argv) => argv.join(" "))).toEqual(["/usr/bin/ip -o -4 addr show"]);
	});

	test("a machine with no omp and no user manager is fine", async () => {
		const result = await preflight(fakeHost({ omp: NO_OMP, userManager: false }).deps, "node");
		expect(result.blocked).toBe(false);
	});

	test("only ports 7946 and 7947 are looked at", async () => {
		const { deps, commands } = fakeHost({ listening: [3000, 8080, 8443, 4000] });
		const result = await preflight(deps, "node");
		expect(stepOf(result, "ports")).toMatchObject({ status: "ok", detail: "free: 7946 7947" });
		expect(commands().some((argv) => argv.includes("is-active"))).toBe(false);
	});

	test("a stranger on 7946 blocks, an active vmon there is ours", async () => {
		const stranger = await preflight(fakeHost({ listening: [7946] }).deps, "node");
		expect(stepOf(stranger, "ports")).toMatchObject({ status: "failed", fix: "ss -ltnp 'sport = :7946'" });
		expect(stranger.blocked).toBe(true);
		const ours = await preflight(fakeHost({ listening: [7946, 7947], active: ["vmon"] }).deps, "node");
		expect(stepOf(ours, "ports")).toMatchObject({ status: "ok", detail: "already ours: 7946 7947" });
		expect(ours.blocked).toBe(false);
	});

	test("only github.com has to be reachable", async () => {
		const asked: string[] = [];
		const host = fakeHost({
			httpsStatus: (url) => {
				asked.push(url);
				return url.includes("github.com") ? 200 : null;
			},
		});
		const result = await preflight(host.deps, "node");
		expect(asked).toEqual(["https://github.com/"]);
		expect(stepOf(result, "network")).toMatchObject({ status: "ok", detail: "reachable over HTTPS: github.com" });
	});

	test("a missing tool is skipped with its packages, like setup, and a failed check blocks", async () => {
		const result = await preflight(fakeHost({ missing: ["curl"] }).deps, "node");
		expect(stepOf(result, "tools").status).toBe("skipped");
		expect(result.missingTools).toEqual(["curl"]);
		expect(result.blocked).toBe(false);
		const noKvm = await preflight(fakeHost({ kvm: false }).deps, "node");
		expect(noKvm.blocked).toBe(true);
	});

	test("an unsupported platform blocks", async () => {
		const result = await preflight(fakeHost({ platform: "darwin" }).deps, "node");
		expect(result.blocked).toBe(true);
	});
});

describe("cluster address", () => {
	const PUBLIC_LISTING = `${IP_LISTING}3: eth1    inet 203.0.113.7/24 scope global eth1\\       valid_lft forever\n`;

	test("is not checked without an address", async () => {
		const result = await preflight(fakeHost().deps, "setup");
		expect(result.steps.some((s) => s.id === "preflight.cluster-address")).toBe(false);
	});

	test("a LAN address of this machine passes, and the step sits between service-ip and network", async () => {
		const result = await preflight(fakeHost().deps, "setup", { clusterAddress: "192.168.1.5" });
		expect(stepOf(result, "cluster-address")).toMatchObject({ status: "ok" });
		const ids = result.steps.map((s) => s.id);
		expect(ids.slice(-3)).toEqual(["preflight.service-ip", "preflight.cluster-address", "preflight.network"]);
		expect(result.blocked).toBe(false);
	});

	test("an address that is not on this machine fails", async () => {
		const result = await preflight(fakeHost().deps, "setup", { clusterAddress: "192.168.1.99" });
		expect(stepOf(result, "cluster-address")).toMatchObject({ status: "failed", detail: "192.168.1.99 is not an address of this machine" });
		expect(stepOf(result, "cluster-address").fix).toContain("--cluster-address");
		expect(result.blocked).toBe(true);
	});

	test("the service IP on ompsvc0 does not count as an address of this machine", async () => {
		const result = await preflight(fakeHost({ ipAddrs: SERVICE_IP_ON_DUMMY }).deps, "setup", { clusterAddress: "10.254.254.1" });
		expect(stepOf(result, "cluster-address").detail).toBe("10.254.254.1 is not an address of this machine");
	});

	test("a public address of this machine fails as not private", async () => {
		const result = await preflight(fakeHost({ ipAddrs: PUBLIC_LISTING }).deps, "setup", { clusterAddress: "203.0.113.7" });
		expect(stepOf(result, "cluster-address")).toMatchObject({
			status: "failed",
			detail:
				"203.0.113.7 is not a private LAN address: vibemon's cluster ports must not face the internet, and VMs on other machines reach the server's 10.254.254.1 only over a LAN",
		});
		expect(stepOf(result, "cluster-address").fix).toContain("--cluster-address");
		expect(result.blocked).toBe(true);
	});

	test("the private ranges are 10/8, 172.16/12 and 192.168/16", async () => {
		const addresses = ["10.1.2.3", "172.16.0.9", "172.31.255.1", "172.15.0.1", "172.32.0.1", "192.168.0.2", "192.169.0.2", "100.64.0.5"];
		const listing = addresses.map((address, index) => `${index + 10}: net${index}    inet ${address}/24 scope global net${index}\\       valid_lft forever\n`).join("");
		const result: Record<string, string> = {};
		for (const address of addresses) {
			result[address] = stepOf(await preflight(fakeHost({ ipAddrs: listing }).deps, "doctor", { clusterAddress: address }), "cluster-address").status;
		}
		expect(result).toEqual({
			"10.1.2.3": "ok",
			"172.16.0.9": "ok",
			"172.31.255.1": "ok",
			"172.15.0.1": "failed",
			"172.32.0.1": "failed",
			"192.168.0.2": "ok",
			"192.169.0.2": "failed",
			"100.64.0.5": "failed",
		});
	});

	test("an address that is neither this machine's nor private reports 'not an address of this machine' first", async () => {
		const result = await preflight(fakeHost().deps, "setup", { clusterAddress: "8.8.8.8" });
		expect(stepOf(result, "cluster-address").detail).toBe("8.8.8.8 is not an address of this machine");
	});
});
