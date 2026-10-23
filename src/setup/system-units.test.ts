import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clusterListenOfUnit,
	installNodeUnits,
	installSystemUnits,
	NET_UNIT,
	NODE_NET_UNIT,
	removeSystemUnits,
	renderNetUnit,
	renderNodeNetUnit,
	renderNodeVmonUnit,
	renderSyncTimer,
	renderSyncUnit,
	renderVmonUnit,
	SYNC_TIMER,
	SYNC_UNIT,
	SYSTEM_UNIT_DIR,
	VMON_UNIT,
	writeIfChanged,
} from "./system-units";
import { fakeRunner, putFile } from "./system-fakes";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-cloud-units-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const DEFAULT_ROUTES = "default via 192.168.1.1 dev eth0\n192.168.1.0/24 dev eth0 scope link\n";
const unitFile = (name: string) => join(root, SYSTEM_UNIT_DIR, name);
/** Only the commands that change something. */
const changes = (lines: string[]) => lines.filter((line) => !/ (is-enabled|is-active) /.test(line) && !line.startsWith("ip -4 route"));

/** A host with no units: nothing enabled, nothing active. */
const freshHost = (routes = DEFAULT_ROUTES) =>
	fakeRunner((argv) => {
		if (argv[0] === "ip") return { stdout: routes };
		if (argv[1] === "is-enabled") return { code: 1, stdout: "disabled\n" };
		if (argv[1] === "is-active") return { code: 3, stdout: "inactive\n" };
		return undefined;
	});

describe("rendered units", () => {
	test("omp-cloud-net creates ompsvc0 idempotently, stays after exit, is removed on stop and runs before vmon", () => {
		const unit = renderNetUnit();
		expect(unit).toContain("Type=oneshot");
		expect(unit).toContain("RemainAfterExit=yes");
		expect(unit).toContain("Before=vmon.service");
		expect(unit).toContain("WantedBy=multi-user.target");
		expect(unit).toContain("ip link show ompsvc0");
		expect(unit).toContain("ip link add ompsvc0 type dummy");
		expect(unit).toContain("ip addr replace 10.254.254.1/32 dev ompsvc0");
		expect(unit).toContain("ip link set ompsvc0 up");
		expect(unit).toMatch(/^ExecStop=-.*ip link del ompsvc0/m);
	});

	test("vmon.service runs vmon serve with host-default capacity and the pool, and keeps sandboxes over a restart", () => {
		const unit = renderVmonUnit("172.29.0.0/16");
		expect(unit).toContain("ExecStart=/opt/vmon/vmon serve --role node,driver --data-dir /var/lib/vmon --listen 127.0.0.1:3000 --public-url http://127.0.0.1:3000 --domain localhost --cluster-listen 127.0.0.1:7947 --gossip-listen 127.0.0.1:7946 --egress-internal-allow 10.254.254.1/32 --registry-mirror https://mirror.gcr.io --net-pool 172.29.0.0/16");
		expect(unit).not.toContain("--max-vcpus");
		expect(unit).not.toContain("--max-memory-mb");
		expect(unit).not.toContain("--vmm-user");
		for (const line of ["EnvironmentFile=/etc/vmon/env", "KillMode=process", "TimeoutStopSec=60", "Restart=on-failure", "Requires=omp-cloud-net.service", "After=omp-cloud-net.service network-online.target", "Wants=network-online.target", "WantedBy=multi-user.target"]) {
			expect(unit).toContain(line);
		}
	});

	test("systemd-analyze verify accepts both units", async () => {
		if (Bun.which("systemd-analyze") === null) return;
		// A root with the files the units point at; `--root` keeps the check away from the real system.
		await putFile(root, "/opt/vmon/vmon", "#!/bin/sh\n", 0o755);
		await putFile(root, "/etc/vmon/env", "A=b\n", 0o600);
		await putFile(root, "/bin/sh", "#!/bin/sh\n", 0o755);
		await putFile(root, `${SYSTEM_UNIT_DIR}/${NET_UNIT}`, renderNetUnit());
		await putFile(root, `${SYSTEM_UNIT_DIR}/${VMON_UNIT}`, renderVmonUnit("172.20.0.0/16"));
		const probe = Bun.spawnSync(["systemd-analyze", `--root=${root}`, "verify", `${SYSTEM_UNIT_DIR}/${NET_UNIT}`, `${SYSTEM_UNIT_DIR}/${VMON_UNIT}`], { stdout: "pipe", stderr: "pipe" });
		const output = `${probe.stdout.toString()}${probe.stderr.toString()}`;
		// Hosts differ in what `verify` can do in a chroot-like root (no dbus, missing targets): what must never appear is a complaint about the unit syntax.
		expect(output).not.toMatch(/Unknown (key|section)|Invalid argument|Failed to parse|Missing '='|Unbalanced quote|not a valid/i);
	});
});

describe("writeIfChanged", () => {
	test("writes with the mode regardless of the umask, rewrites nothing that is right, repairs a mode", async () => {
		const path = join(root, "dir", "file");
		expect(await writeIfChanged(path, "a\n", 0o440)).toBe(true);
		expect((await stat(path)).mode & 0o777).toBe(0o440);
		expect(await writeIfChanged(path, "a\n", 0o440)).toBe(false);
		await chmod(path, 0o666);
		expect(await writeIfChanged(path, "a\n", 0o440)).toBe(true);
		expect((await stat(path)).mode & 0o777).toBe(0o440);
		expect(await writeIfChanged(path, "b\n", 0o440)).toBe(true);
		expect(await readFile(path, "utf8")).toBe("b\n");
	});
});

describe("installSystemUnits", () => {
	test("a fresh host: writes both units with the first free pool, reloads and enables both with --now", async () => {
		const runner = freshHost();
		const outcome = await installSystemUnits({ root, runner: runner.run });
		expect(outcome.netPool).toBe("172.20.0.0/16");
		expect(outcome.steps.map((step) => [step.id, step.status])).toEqual([["system.unit.omp-cloud-net", "changed"], ["system.unit.vmon", "changed"]]);
		expect(await readFile(unitFile(NET_UNIT), "utf8")).toBe(renderNetUnit());
		expect(await readFile(unitFile(VMON_UNIT), "utf8")).toBe(renderVmonUnit("172.20.0.0/16"));
		expect((await stat(unitFile(VMON_UNIT))).mode & 0o777).toBe(0o644);
		expect(changes(runner.lines())).toEqual(["systemctl daemon-reload", "systemctl enable --now omp-cloud-net.service", "systemctl enable --now vmon.service"]);
	});

	test("a rerun changes nothing and reports ok for both units", async () => {
		await installSystemUnits({ root, runner: freshHost().run });
		const before = await readFile(unitFile(VMON_UNIT), "utf8");
		const again = fakeRunner();
		const outcome = await installSystemUnits({ root, runner: again.run });
		expect(outcome.steps.map((step) => step.status)).toEqual(["ok", "ok"]);
		expect(await readFile(unitFile(VMON_UNIT), "utf8")).toBe(before);
		expect(again.lines().some((line) => line.startsWith("ip "))).toBe(false);
		expect(changes(again.lines()).some((line) => line.includes("stop") || line.includes("restart"))).toBe(false);
	});

	test("the pool is 172.29.0.0/16 when a host route overlaps 172.20.0.0/16 (a nested vmon)", async () => {
		const outcome = await installSystemUnits({ root, runner: freshHost("default via 172.20.0.1 dev eth0\n172.20.0.0/30 dev eth0 scope link\n").run });
		expect(outcome.netPool).toBe("172.29.0.0/16");
		expect(await readFile(unitFile(VMON_UNIT), "utf8")).toContain("--net-pool 172.29.0.0/16");
	});

	test("the installed unit's pool stays even when vmon's own TAP routes now overlap it", async () => {
		await installSystemUnits({ root, runner: freshHost("172.20.0.1 dev eth0\n").run });
		const rerun = fakeRunner((argv) => {
			if (argv[0] === "ip") return { stdout: "172.29.0.0/30 dev tap0 scope link\n172.29.0.4/30 dev tap1 scope link\n" };
			return undefined;
		});
		const outcome = await installSystemUnits({ root, runner: rerun.run });
		expect(outcome.netPool).toBe("172.29.0.0/16");
		expect(rerun.lines().some((line) => line.startsWith("ip "))).toBe(false);
	});

	test("every candidate pool overlapping is a failure that changes nothing", async () => {
		const routes = ["172.20", "172.29", "172.30", "172.31"].map((net) => `${net}.0.0/16 dev x`).join("\n");
		const runner = freshHost(routes);
		const outcome = await installSystemUnits({ root, runner: runner.run });
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]).toMatchObject({ status: "failed" });
		expect(changes(runner.lines())).toEqual([]);
		expect(await stat(unitFile(VMON_UNIT)).catch(() => null)).toBeNull();
	});

	test("an existing ompsvc0 is not touched by setup: the net unit's start is the idempotent one", async () => {
		const runner = freshHost();
		await installSystemUnits({ root, runner: runner.run });
		expect(runner.lines().some((line) => line.includes("ip link"))).toBe(false);
	});

	test("an unchanged vmon unit that is not active is started and reported as changed", async () => {
		await installSystemUnits({ root, runner: freshHost().run });
		const runner = fakeRunner((argv) => {
			if (argv[1] === "is-active" && argv[2] === VMON_UNIT) return { code: 3 };
			return undefined;
		});
		const outcome = await installSystemUnits({ root, runner: runner.run });
		expect(outcome.steps.map((step) => step.status)).toEqual(["ok", "changed"]);
		expect(runner.lines()).toContain("systemctl enable --now vmon.service");
	});

	test("an edited vmon unit file is repaired, and a running vmon is not restarted", async () => {
		await installSystemUnits({ root, runner: freshHost().run });
		await writeFile(unitFile(VMON_UNIT), renderVmonUnit("172.20.0.0/16").replace("KillMode=process", "KillMode=control-group"));
		const runner = fakeRunner();
		const outcome = await installSystemUnits({ root, runner: runner.run });
		expect(await readFile(unitFile(VMON_UNIT), "utf8")).toContain("KillMode=process");
		expect(outcome.steps.at(-1)).toMatchObject({ status: "changed" });
		expect(outcome.steps.at(-1)?.detail).toContain("takes effect at the next restart");
		expect(runner.lines().some((line) => /restart|stop/.test(line))).toBe(false);
	});

	test("a unit that will not start is a failed step with a journal command; the net unit failing stops before vmon", async () => {
		const runner = fakeRunner((argv) => {
			if (argv[1] === "is-enabled") return { code: 1 };
			if (argv[1] === "enable" && argv[3] === NET_UNIT) return { code: 1, stderr: "Job for omp-cloud-net.service failed\n" };
			if (argv[0] === "ip") return { stdout: DEFAULT_ROUTES };
			return undefined;
		});
		const outcome = await installSystemUnits({ root, runner: runner.run });
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]).toMatchObject({ id: "system.unit.omp-cloud-net", status: "failed", fix: "journalctl -u omp-cloud-net -n 50 --no-pager" });
		expect(runner.lines()).not.toContain("systemctl enable --now vmon.service");
	});
});

describe("removeSystemUnits", () => {
	test("disables both units, deletes the files, reloads and removes a leftover link", async () => {
		await installSystemUnits({ root, runner: freshHost().run });
		const runner = fakeRunner();
		const steps = await removeSystemUnits({ root, runner: runner.run });
		expect(steps).toEqual([{ id: "system.uninstall.units", status: "changed", detail: "removed vmon.service and omp-cloud-net.service" }]);
		expect(runner.lines()).toEqual([
			"systemctl disable --now vmon.service omp-cloud-net.service",
			"systemctl daemon-reload",
			"systemctl reset-failed vmon.service omp-cloud-net.service",
			"ip link show ompsvc0",
			"ip link del ompsvc0",
		]);
		expect(await stat(unitFile(VMON_UNIT)).catch(() => null)).toBeNull();
		expect(await stat(unitFile(NET_UNIT)).catch(() => null)).toBeNull();
	});

	test("a host without units has nothing to remove: no systemctl stop or disable", async () => {
		await mkdir(join(root, SYSTEM_UNIT_DIR), { recursive: true });
		const runner = fakeRunner((argv) => (argv[2] === "ompsvc0" ? { code: 1 } : undefined));
		expect((await removeSystemUnits({ root, runner: runner.run }))[0]).toMatchObject({ status: "ok" });
		expect(runner.lines().some((line) => /systemctl (stop|disable)/.test(line))).toBe(false);
	});

	test("a unit that will not disable fails and leaves the files", async () => {
		await installSystemUnits({ root, runner: freshHost().run });
		const runner = fakeRunner((argv) => (argv[1] === "disable" ? { code: 1, stderr: "boom\n" } : undefined));
		const steps = await removeSystemUnits({ root, runner: runner.run });
		expect(steps[0]).toMatchObject({ status: "failed" });
		expect(await stat(unitFile(VMON_UNIT))).toBeTruthy();
	});
});

describe("the vmon unit with a cluster address", () => {
	test("binds the cluster and gossip listeners to that address only", () => {
		const unit = renderVmonUnit("172.20.0.0/16", "192.168.1.20");
		expect(unit).toContain("--cluster-listen 192.168.1.20:7947 --gossip-listen 192.168.1.20:7946");
		expect(unit).not.toContain("0.0.0.0");
		expect(unit).toContain("--listen 127.0.0.1:3000");
		expect(renderVmonUnit("172.20.0.0/16")).toBe(renderVmonUnit("172.20.0.0/16", null));
		expect(renderVmonUnit("172.20.0.0/16")).toContain("--cluster-listen 127.0.0.1:7947 --gossip-listen 127.0.0.1:7946");
	});

	test("clusterListenOfUnit reads the host, and nothing from a text without the flag", () => {
		expect(clusterListenOfUnit(renderVmonUnit("172.20.0.0/16", "10.0.0.5"))).toBe("10.0.0.5");
		expect(clusterListenOfUnit(renderVmonUnit("172.20.0.0/16"))).toBe("127.0.0.1");
		expect(clusterListenOfUnit("ExecStart=/opt/vmon/vmon serve --net-pool 172.20.0.0/16")).toBeNull();
	});

	test("a rerun with the same address never restarts vmon, a change of address does, once", async () => {
		const running = fakeRunner((argv) => (argv[1] === "is-active" || argv[1] === "is-enabled" ? { code: 0 } : argv[0] === "ip" ? { stdout: DEFAULT_ROUTES } : undefined));
		await installSystemUnits({ root, runner: freshHost().run, clusterAddress: "10.0.0.5" });
		const same = await installSystemUnits({ root, runner: running.run, clusterAddress: "10.0.0.5" });
		expect(same.steps.map((step) => step.status)).toEqual(["ok", "ok"]);
		expect(running.lines().some((line) => line.includes("restart"))).toBe(false);
		const moved = fakeRunner((argv) => (argv[1] === "is-active" || argv[1] === "is-enabled" ? { code: 0 } : undefined));
		const outcome = await installSystemUnits({ root, runner: moved.run, clusterAddress: "10.0.0.6" });
		expect(moved.lines().filter((line) => line.includes("restart"))).toEqual(["systemctl restart vmon.service"]);
		expect(outcome.steps.at(-1)?.detail).toBe("vmon.service restarted to listen for other vibemon machines on 10.0.0.6");
	});
});

describe("node units", () => {
	test("vmon runs in the node role, joins the server and keeps the service address exemption", () => {
		const unit = renderNodeVmonUnit("172.29.0.0/16", "192.168.1.20");
		expect(unit).toContain("ExecStart=/opt/vmon/vmon serve --role node --data-dir /var/lib/vmon --join 192.168.1.20:7946 --egress-internal-allow 10.254.254.1/32 --registry-mirror https://mirror.gcr.io --net-pool 172.29.0.0/16");
		expect(unit).not.toContain("--listen");
		expect(unit).not.toContain("--cluster-listen");
		for (const line of ["Requires=omp-cloud-node-net.service", "After=network-online.target omp-cloud-node-net.service", "Wants=network-online.target\n", "EnvironmentFile=/etc/vmon/env", "KillMode=process", "TimeoutStopSec=60", "Restart=on-failure", "RestartSec=5", "WantedBy=multi-user.target"]) {
			expect(unit).toContain(line);
		}
	});

	test("the renderers refuse anything but a plain dotted quad: no leading zeros, no octet above 255, nothing a shell would read", () => {
		for (const address of ["0.0.0.0/0", "192.168.01.20", "192.168.1.256", "1.2.3", "192.168.1.20'; reboot; '", "192.168.1.20 --x", "", "::1"]) {
			expect(() => renderVmonUnit("172.20.0.0/16", address)).toThrow("is not a plain IPv4 address");
			expect(() => renderNodeVmonUnit("172.20.0.0/16", address)).toThrow("is not a plain IPv4 address");
			expect(() => renderNodeNetUnit(address)).toThrow("is not a plain IPv4 address");
		}
	});

	test("the node-net unit limits VMs to TCP 4000 and 4100 of the service address, in both chains, and undoes it on stop", () => {
		const unit = renderNodeNetUnit(null);
		for (const line of ["Type=oneshot", "RemainAfterExit=yes", "Before=vmon.service", "After=network-online.target", "Restart=on-failure", "RestartSec=5", "WantedBy=multi-user.target"]) expect(unit).toContain(line);
		expect(unit).toContain("for chain in OUTPUT FORWARD");
		expect(unit).toContain("iptables -w -I $$chain 1 -d 10.254.254.1/32 -p tcp -m multiport ! --dports 4000,4100 -j REJECT");
		expect(unit).toContain("iptables -w -I $$chain 1 -d 10.254.254.1/32 ! -p tcp -j REJECT");
		expect(unit).not.toContain("-A $$chain");
		expect(unit).toContain("iptables -w -C $$chain -d 10.254.254.1/32 -p tcp -m multiport ! --dports 4000,4100 -j REJECT");
		expect(unit).toMatch(/^ExecStop=-\/bin\/sh -c '.*iptables -w -D \$\$chain -d 10\.254\.254\.1\/32 ! -p tcp -j REJECT/m);
		expect(unit).not.toContain("ip route");
	});

	test("with a route the unit installs and removes the host route to the server", () => {
		const unit = renderNodeNetUnit("192.168.1.20");
		expect(unit).toContain("ExecStart=/bin/sh -ec 'ip route replace 10.254.254.1/32 via 192.168.1.20; for chain");
		expect(unit).toMatch(/^ExecStop=.*; ip route del 10\.254\.254\.1\/32/m);
	});

	test("the sync service runs the root-owned script, and the timer fires 2 min after boot and every minute", () => {
		expect(renderSyncUnit()).toContain("Type=oneshot");
		expect(renderSyncUnit()).toContain("ExecStart=/usr/local/libexec/omp-cloud/vmon-sync");
		const timer = renderSyncTimer();
		for (const line of ["OnBootSec=2min", "OnUnitActiveSec=1min", "WantedBy=timers.target"]) expect(timer).toContain(line);
	});

	test("systemd-analyze verify accepts the node units, Restart=on-failure on the oneshot included", async () => {
		if (Bun.which("systemd-analyze") === null) return;
		await putFile(root, "/opt/vmon/vmon", "#!/bin/sh\n", 0o755);
		await putFile(root, "/etc/vmon/env", "A=b\n", 0o600);
		await putFile(root, "/bin/sh", "#!/bin/sh\n", 0o755);
		await putFile(root, "/usr/local/libexec/omp-cloud/vmon-sync", "#!/bin/sh\n", 0o755);
		const units: Array<[string, string]> = [
			[NODE_NET_UNIT, renderNodeNetUnit("192.168.1.20")],
			[VMON_UNIT, renderNodeVmonUnit("172.20.0.0/16", "192.168.1.20")],
			[SYNC_UNIT, renderSyncUnit()],
			[SYNC_TIMER, renderSyncTimer()],
		];
		for (const [name, text] of units) await putFile(root, `${SYSTEM_UNIT_DIR}/${name}`, text);
		const probe = Bun.spawnSync(["systemd-analyze", `--root=${root}`, "verify", ...units.map(([name]) => `${SYSTEM_UNIT_DIR}/${name}`)], { stdout: "pipe", stderr: "pipe" });
		const output = `${probe.stdout.toString()}${probe.stderr.toString()}`;
		expect(output).not.toMatch(/Unknown (key|section)|Invalid argument|Failed to parse|Missing '='|Unbalanced quote|not a valid|Restart=/i);
	});
});

describe("installNodeUnits", () => {
	const options = { server: "192.168.1.20", route: false };
	const fresh = () =>
		fakeRunner((argv) => {
			if (argv[0] === "ip") return { stdout: DEFAULT_ROUTES };
			if (argv[1] === "is-enabled") return { code: 1 };
			if (argv[1] === "is-active") return { code: 3 };
			return undefined;
		});

	test("a fresh machine: writes the four units with the first free pool, reloads, enables the net unit, vmon and the timer in that order", async () => {
		const runner = fresh();
		const outcome = await installNodeUnits({ root, runner: runner.run, ...options });
		expect(outcome.netPool).toBe("172.20.0.0/16");
		expect(outcome.steps.map((step) => [step.id, step.status])).toEqual([
			["system.unit.omp-cloud-node-net", "changed"],
			["system.unit.vmon", "changed"],
			["system.unit.omp-cloud-vmon-sync", "changed"],
		]);
		expect(changes(runner.lines())).toEqual(["systemctl daemon-reload", `systemctl enable --now ${NODE_NET_UNIT}`, "systemctl enable --now vmon.service", `systemctl enable --now ${SYNC_TIMER}`]);
		expect(await readFile(unitFile(VMON_UNIT), "utf8")).toBe(renderNodeVmonUnit("172.20.0.0/16", "192.168.1.20"));
		expect(await readFile(unitFile(NODE_NET_UNIT), "utf8")).toBe(renderNodeNetUnit(null));
	});

	test("--route puts the route in the net unit", async () => {
		await installNodeUnits({ root, runner: fresh().run, server: "192.168.1.20", route: true });
		expect(await readFile(unitFile(NODE_NET_UNIT), "utf8")).toBe(renderNodeNetUnit("192.168.1.20"));
	});

	test("a rerun changes nothing and restarts nothing; the pool of the existing unit stays", async () => {
		await installNodeUnits({ root, runner: fresh().run, ...options });
		const again = fakeRunner((argv) => (argv[1] === "is-active" || argv[1] === "is-enabled" ? { code: 0 } : undefined));
		const outcome = await installNodeUnits({ root, runner: again.run, ...options });
		expect(outcome.steps.map((step) => step.status)).toEqual(["ok", "ok", "ok"]);
		expect(again.lines().some((line) => line.includes("restart") || line.startsWith("ip "))).toBe(false);
	});

	test("a running vmon whose unit text changed is restarted", async () => {
		await installNodeUnits({ root, runner: fresh().run, ...options });
		const running = fakeRunner((argv) => (argv[1] === "is-active" || argv[1] === "is-enabled" ? { code: 0 } : undefined));
		const outcome = await installNodeUnits({ root, runner: running.run, server: "192.168.1.30", route: false });
		expect(running.lines()).toContain("systemctl restart vmon.service");
		expect(outcome.steps.find((step) => step.id === "system.unit.vmon")).toMatchObject({ status: "changed" });
		expect(await readFile(unitFile(VMON_UNIT), "utf8")).toContain("--join 192.168.1.30:7946");
	});

	test("a unit that will not start is a failed step and stops what follows", async () => {
		const runner = fakeRunner((argv) => {
			if (argv[0] === "ip") return { stdout: DEFAULT_ROUTES };
			if (argv[1] === "enable" && argv[3] === NODE_NET_UNIT) return { code: 1, stderr: "Job failed\n" };
			return argv[1] === "is-enabled" ? { code: 1 } : undefined;
		});
		const outcome = await installNodeUnits({ root, runner: runner.run, ...options });
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]).toMatchObject({ id: "system.unit.omp-cloud-node-net", status: "failed", fix: "journalctl -u omp-cloud-node-net -n 50 --no-pager" });
		expect(runner.lines()).not.toContain("systemctl enable --now vmon.service");
	});
});

describe("removeSystemUnits on a node", () => {
	test("disables the timer, the sync service, vmon and the node-net unit and deletes all four files", async () => {
		await installNodeUnits({ root, runner: freshHost().run, server: "192.168.1.20", route: false });
		const runner = fakeRunner((argv) => (argv[2] === "ompsvc0" ? { code: 1 } : undefined));
		const steps = await removeSystemUnits({ root, runner: runner.run });
		expect(steps).toEqual([{ id: "system.uninstall.units", status: "changed", detail: "removed omp-cloud-vmon-sync.timer, omp-cloud-vmon-sync.service, vmon.service and omp-cloud-node-net.service" }]);
		expect(runner.lines()[0]).toBe("systemctl disable --now omp-cloud-vmon-sync.timer omp-cloud-vmon-sync.service vmon.service omp-cloud-node-net.service");
		for (const name of [VMON_UNIT, NODE_NET_UNIT, SYNC_UNIT, SYNC_TIMER]) expect(await stat(unitFile(name)).catch(() => null)).toBeNull();
		expect(await stat(unitFile(NET_UNIT)).catch(() => null)).toBeNull();
	});
});
