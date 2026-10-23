/**
 * The system units that make the vibemon host survive a reboot. A server has `omp-cloud-net.service` (the dummy link
 * `ompsvc0` that carries 10.254.254.1, the only host address the sandboxes may reach) and `vmon.service`; a node (another
 * machine that joins the server's vibemon cluster, `omp-cloud setup node`) has `omp-cloud-node-net.service` (which limits what
 * its VMs may reach of the server), `vmon.service` in the node role and the timer that keeps its vibemon at the server's
 * version. All are written in `/etc/systemd/system` by the root part of `omp-cloud setup`. `vmon` keeps its name: the root
 * helper and the updater restart it by that name.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandRunner } from "../update/system";
import { lastLine } from "../update/system";
import { VMON_BINARY, VMON_SYNC_PATH } from "../vmon/pin";
import { requirePlainIpv4 } from "./ipv4";
import { chooseNetPool, poolOfUnit } from "./netpool";
import type { StepResult } from "./steps";

export const NET_UNIT = "omp-cloud-net.service";
export const VMON_UNIT = "vmon.service";
export const NODE_NET_UNIT = "omp-cloud-node-net.service";
export const SYNC_UNIT = "omp-cloud-vmon-sync.service";
export const SYNC_TIMER = "omp-cloud-vmon-sync.timer";
export const SYSTEM_UNIT_DIR = "/etc/systemd/system";
export const SERVICE_IP = "10.254.254.1";
export const SERVICE_LINK = "ompsvc0";
/** What a VM on a node may reach of the server: the gateway and the MCP proxy, both on {@link SERVICE_IP}. */
const NODE_VM_PORTS = "4000,4100";
/** Where vmon listens for the other machines of its cluster when it is not alone, and when it is. */
const LOCAL_CLUSTER_HOST = "127.0.0.1";

const START_TIMEOUT_MS = 120_000;
const UNIT_PATH = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** `ompsvc0`: a dummy link with the service address, created idempotently (an existing one from an earlier install is kept), removed on stop. */
export function renderNetUnit(): string {
	return `[Unit]
Description=omp-cloud service network (${SERVICE_LINK}, ${SERVICE_IP})
Before=vmon.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/bin/sh -ec 'ip link show ${SERVICE_LINK} >/dev/null 2>&1 || { modprobe dummy 2>/dev/null || true; ip link add ${SERVICE_LINK} type dummy; }; ip addr replace ${SERVICE_IP}/32 dev ${SERVICE_LINK}; ip link set ${SERVICE_LINK} up'
ExecStop=-/bin/sh -c 'ip link del ${SERVICE_LINK}'

[Install]
WantedBy=multi-user.target
`;
}

/**
 * vmon as the host runs it, with the host's own vCPU and memory defaults and the chosen TAP pool. `--vmm-user` is
 * deliberately absent (in vibemon 0.4.0 it breaks every VM launch). `KillMode=process` and `TimeoutStopSec=60` are what keep sandboxes alive over a restart.
 *
 * vmon denies sandboxes every private address unless the node exempts it, and `--egress-internal-allow` is that
 * exemption: only the service address, which carries the gateway. The exemption covers every port of that address, not
 * just the gateway's, and a sandbox's traffic reaches the host through vmon's egress proxy, so it arrives with the
 * service address itself as its source. Any host listener bound to all addresses is therefore reachable from every VM
 * through that address (the remote listener refuses that source for this reason).
 *
 * The cluster and gossip listeners are the same kind of listener: they bind loopback, or with `clusterAddress` (a server
 * that takes other vibemon machines) that one LAN address and never `0.0.0.0`.
 */
export function renderVmonUnit(pool: string, clusterAddress: string | null = null): string {
	const host = clusterAddress === null ? LOCAL_CLUSTER_HOST : requirePlainIpv4(clusterAddress, "the cluster address");
	const args = [
		"serve", "--role", "node,driver", "--data-dir", "/var/lib/vmon",
		"--listen", "127.0.0.1:3000", "--public-url", "http://127.0.0.1:3000", "--domain", "localhost",
		"--cluster-listen", `${host}:7947`, "--gossip-listen", `${host}:7946`,
		"--egress-internal-allow", `${SERVICE_IP}/32`, "--registry-mirror", "https://mirror.gcr.io",
		"--net-pool", pool,
	];
	return `[Unit]
Description=vmon (omp-cloud)
Requires=${NET_UNIT}
After=${NET_UNIT} network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/vmon/env
ExecStart=${VMON_BINARY} ${args.join(" ")}
KillMode=process
TimeoutStopSec=60
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/** The host a vmon unit text listens on for its cluster (`--cluster-listen <host>:<port>`); null when the text has no such flag. */
export function clusterListenOfUnit(unitText: string): string | null {
	const match = /--cluster-listen[=\s]\s*([^\s:]+):\d+/.exec(unitText);
	return match?.[1] ?? null;
}

/**
 * vmon on a node: the node role only (no listener of its own: it joins the server's gossip at `server`:7946), the cluster
 * and gossip listeners on every address because the other machines must reach them, and the same exemption for the
 * service address as on the server. The environment file holds only the cluster secret. vmon `Requires=` the node network
 * unit (not `Wants=`, which would start vmon even when the unit failed): without the unit's rules the node's VMs reach
 * every all-address listener of the server, so vmon stops when that unit fails or stops.
 */
export function renderNodeVmonUnit(pool: string, server: string): string {
	const args = [
		"serve", "--role", "node", "--data-dir", "/var/lib/vmon", "--join", `${server}:7946`,
		"--egress-internal-allow", `${SERVICE_IP}/32`, "--registry-mirror", "https://mirror.gcr.io",
		"--net-pool", pool,
	];
	requirePlainIpv4(server, "the server address");
	return `[Unit]
Description=vmon (omp-cloud node)
Requires=${NODE_NET_UNIT}
After=network-online.target ${NODE_NET_UNIT}
Wants=network-online.target

[Service]
EnvironmentFile=/etc/vmon/env
ExecStart=${VMON_BINARY} ${args.join(" ")}
KillMode=process
TimeoutStopSec=60
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/**
 * What the VMs of a node may reach of the server. A VM's traffic to 10.254.254.1 is dialed by its machine's host, so on the
 * server it arrives from the node's LAN address, which the remote listener and every other all-address listener would
 * accept. This unit, before vmon, rejects everything the node's host sends or forwards to that address except TCP
 * {@link NODE_VM_PORTS} (the gateway and the MCP proxy). `route` is the server's LAN address when the node reaches it
 * directly: it then gets the host route to the service address through it (behind a router the owner adds that route there).
 * `$$` is systemd's way to write a `$` that the inner shell expands.
 */
export function renderNodeNetUnit(route: string | null): string {
	if (route !== null) requirePlainIpv4(route, "the server address");
	const rules = [`-d ${SERVICE_IP}/32 -p tcp -m multiport ! --dports ${NODE_VM_PORTS} -j REJECT`, `-d ${SERVICE_IP}/32 ! -p tcp -j REJECT`];
	const add = rules.map((rule) => `iptables -w -C $$chain ${rule} 2>/dev/null || iptables -w -I $$chain 1 ${rule}`).join("; ");
	const del = rules.map((rule) => `iptables -w -D $$chain ${rule} 2>/dev/null || true`).join("; ");
	const start = `${route === null ? "" : `ip route replace ${SERVICE_IP}/32 via ${route}; `}for chain in OUTPUT FORWARD; do ${add}; done`;
	const stop = `for chain in OUTPUT FORWARD; do ${del}; done${route === null ? "" : `; ip route del ${SERVICE_IP}/32 2>/dev/null || true`}`;
	return `[Unit]
Description=omp-cloud node network (VMs here reach only TCP ${NODE_VM_PORTS.replace(",", " and ")} of ${SERVICE_IP})
Before=${VMON_UNIT}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=${UNIT_PATH}
ExecStart=/bin/sh -ec '${start}'
ExecStop=-/bin/sh -c '${stop}'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/** The oneshot the node's timer runs: `vmon-sync` moves this machine's vibemon to the server's version. */
export function renderSyncUnit(): string {
	return `[Unit]
Description=omp-cloud: follow the server's vibemon version
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${VMON_SYNC_PATH}
`;
}

export function renderSyncTimer(): string {
	return `[Unit]
Description=omp-cloud: check the server's vibemon version every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
`;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** The text of `path`; null when it does not exist. */
export async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

/**
 * Writes `content` to `path` with `mode` (the umask does not apply) through a temp file and a rename, only when the file
 * differs or has another mode. True when it wrote or repaired something.
 */
export async function writeIfChanged(path: string, content: string, mode: number): Promise<boolean> {
	const current = await readText(path);
	if (current === content) {
		if (((await stat(path)).mode & 0o777) === mode) return false;
		await chmod(path, mode);
		return true;
	}
	await mkdir(dirname(path), { recursive: true });
	const staging = `${path}.tmp`;
	await writeFile(staging, content, { mode });
	await chmod(staging, mode);
	await rename(staging, path);
	return true;
}

async function unitState(runner: CommandRunner, unit: string): Promise<{ enabled: boolean; active: boolean }> {
	const [enabled, active] = await Promise.all([runner(["systemctl", "is-enabled", unit]), runner(["systemctl", "is-active", unit])]);
	return { enabled: enabled.code === 0, active: active.code === 0 };
}

export interface InstallUnitsOptions {
	/** `/` in production; a temp directory in tests. */
	root: string;
	runner: CommandRunner;
	/** The LAN address vmon listens on for other vibemon machines; null: loopback only (the default). */
	clusterAddress?: string | null;
}

export interface InstallUnitsOutcome {
	steps: StepResult[];
	/** The TAP pool the vmon unit uses; empty when none could be chosen. */
	netPool: string;
}

/**
 * Writes both units and enables both with `--now`. The pool of a unit file that already exists is kept; only a first install
 * chooses one from `ip route`. A running vmon whose unit used to listen for its cluster on another address than the one
 * wanted now (a server that starts or stops taking other machines) is restarted: the listeners are bound at start.
 */
export async function installSystemUnits(options: InstallUnitsOptions): Promise<InstallUnitsOutcome> {
	const { root, runner } = options;
	const clusterAddress = options.clusterAddress ?? null;
	const unitPath = (name: string): string => join(root, SYSTEM_UNIT_DIR, name);
	const fail = (id: string, detail: string, fix: string): InstallUnitsOutcome => ({ steps: [{ id, status: "failed", detail, fix }], netPool: "" });

	const oldVmon = await readText(unitPath(VMON_UNIT));
	let pool = poolOfUnit(oldVmon ?? "");
	if (pool === null) {
		const routes = await runner(["ip", "-4", "route", "show"]);
		if (routes.code !== 0) return fail("system.unit.vmon", `ip route failed: ${lastLine(routes.stderr)}`, "install iproute2");
		pool = chooseNetPool(routes.stdout);
		if (pool === null) return fail("system.unit.vmon", "every candidate vmon network pool (172.20, 172.29, 172.30, 172.31 /16) overlaps a route of this host", "free one of those ranges, or remove the overlapping route");
	}

	const before = { net: await unitState(runner, NET_UNIT), vmon: await unitState(runner, VMON_UNIT) };
	const netWritten = await writeIfChanged(unitPath(NET_UNIT), renderNetUnit(), 0o644);
	const vmonWritten = await writeIfChanged(unitPath(VMON_UNIT), renderVmonUnit(pool, clusterAddress), 0o644);

	const reloaded = await runner(["systemctl", "daemon-reload"]);
	if (reloaded.code !== 0) return { ...fail("system.unit.vmon", `systemctl daemon-reload failed: ${lastLine(reloaded.stderr)}`, "sudo systemctl daemon-reload"), netPool: pool };

	const steps: StepResult[] = [];
	const started = async (unit: string, id: string, detail: string, changed: boolean): Promise<boolean> => {
		const enabled = await runner(["systemctl", "enable", "--now", unit], { timeoutMs: START_TIMEOUT_MS });
		if (enabled.code !== 0) {
			steps.push({ id, status: "failed", detail: `${unit} did not start: ${lastLine(enabled.stderr)}`, fix: `journalctl -u ${unit.replace(/\.service$/, "")} -n 50 --no-pager` });
			return false;
		}
		steps.push({ id, status: changed ? "changed" : "ok", detail });
		return true;
	};
	const netChanged = netWritten || !before.net.enabled || !before.net.active;
	const netOk = await started(NET_UNIT, "system.unit.omp-cloud-net", `${NET_UNIT} enabled and active (${SERVICE_LINK}, ${SERVICE_IP})`, netChanged);
	if (!netOk) return { steps, netPool: pool };

	const rebound = before.vmon.active && oldVmon !== null && (clusterListenOfUnit(oldVmon) ?? LOCAL_CLUSTER_HOST) !== (clusterAddress ?? LOCAL_CLUSTER_HOST);
	if (rebound) {
		const restarted = await runner(["systemctl", "restart", VMON_UNIT], { timeoutMs: START_TIMEOUT_MS });
		if (restarted.code !== 0) {
			steps.push({ id: "system.unit.vmon", status: "failed", detail: `${VMON_UNIT} did not restart: ${lastLine(restarted.stderr)}`, fix: "journalctl -u vmon -n 50 --no-pager" });
			return { steps, netPool: pool };
		}
	}
	const vmonChanged = vmonWritten || !before.vmon.enabled || !before.vmon.active;
	const detail = rebound
		? clusterAddress === null
			? `${VMON_UNIT} restarted to listen on ${LOCAL_CLUSTER_HOST} only`
			: `${VMON_UNIT} restarted to listen for other vibemon machines on ${clusterAddress}`
		: vmonWritten && before.vmon.active
			? `${VMON_UNIT} updated; it takes effect at the next restart of vmon (net pool ${pool})`
			: `${VMON_UNIT} enabled and active (net pool ${pool})`;
	await started(VMON_UNIT, "system.unit.vmon", detail, vmonChanged);
	return { steps, netPool: pool };
}

export interface InstallNodeUnitsOptions extends InstallUnitsOptions {
	/** The server's LAN address: vmon joins its gossip there. */
	server: string;
	/** The node reaches `server` directly: route the service address through it. */
	route: boolean;
}

/**
 * The units of a node: `omp-cloud-node-net`, `vmon` (role node, joining `server`:7946) and the sync timer with its oneshot.
 * The pool of a unit file that already exists is kept; a vmon that was running when its unit text changed is restarted
 * (a node has no VMs that must survive: the server restores their threads elsewhere).
 */
export async function installNodeUnits(options: InstallNodeUnitsOptions): Promise<InstallUnitsOutcome> {
	const { root, runner, server } = options;
	const unitPath = (name: string): string => join(root, SYSTEM_UNIT_DIR, name);
	const fail = (id: string, detail: string, fix: string): InstallUnitsOutcome => ({ steps: [{ id, status: "failed", detail, fix }], netPool: "" });

	let pool = poolOfUnit((await readText(unitPath(VMON_UNIT))) ?? "");
	if (pool === null) {
		const routes = await runner(["ip", "-4", "route", "show"]);
		if (routes.code !== 0) return fail("system.unit.vmon", `ip route failed: ${lastLine(routes.stderr)}`, "install iproute2");
		pool = chooseNetPool(routes.stdout);
		if (pool === null) return fail("system.unit.vmon", "every candidate vmon network pool (172.20, 172.29, 172.30, 172.31 /16) overlaps a route of this host", "free one of those ranges, or remove the overlapping route");
	}

	const before = {
		net: await unitState(runner, NODE_NET_UNIT),
		vmon: await unitState(runner, VMON_UNIT),
		sync: await unitState(runner, SYNC_TIMER),
	};
	const netWritten = await writeIfChanged(unitPath(NODE_NET_UNIT), renderNodeNetUnit(options.route ? server : null), 0o644);
	const vmonWritten = await writeIfChanged(unitPath(VMON_UNIT), renderNodeVmonUnit(pool, server), 0o644);
	const syncWritten = [await writeIfChanged(unitPath(SYNC_UNIT), renderSyncUnit(), 0o644), await writeIfChanged(unitPath(SYNC_TIMER), renderSyncTimer(), 0o644)].some(Boolean);

	const reloaded = await runner(["systemctl", "daemon-reload"]);
	if (reloaded.code !== 0) return { ...fail("system.unit.vmon", `systemctl daemon-reload failed: ${lastLine(reloaded.stderr)}`, "sudo systemctl daemon-reload"), netPool: pool };

	const steps: StepResult[] = [];
	const started = async (unit: string, id: string, detail: string, changed: boolean): Promise<boolean> => {
		const enabled = await runner(["systemctl", "enable", "--now", unit], { timeoutMs: START_TIMEOUT_MS });
		if (enabled.code !== 0) {
			steps.push({ id, status: "failed", detail: `${unit} did not start: ${lastLine(enabled.stderr)}`, fix: `journalctl -u ${unit.replace(/\.(service|timer)$/, "")} -n 50 --no-pager` });
			return false;
		}
		steps.push({ id, status: changed ? "changed" : "ok", detail });
		return true;
	};
	const via = options.route ? `; the route ${SERVICE_IP} via ${server}` : "";
	const netChanged = netWritten || !before.net.enabled || !before.net.active;
	if (!(await started(NODE_NET_UNIT, "system.unit.omp-cloud-node-net", `${NODE_NET_UNIT} enabled and active (VMs here reach only TCP ${NODE_VM_PORTS.replace(",", " and ")} of ${SERVICE_IP}${via})`, netChanged))) return { steps, netPool: pool };

	if (vmonWritten && before.vmon.active) {
		const restarted = await runner(["systemctl", "restart", VMON_UNIT], { timeoutMs: START_TIMEOUT_MS });
		if (restarted.code !== 0) {
			steps.push({ id: "system.unit.vmon", status: "failed", detail: `${VMON_UNIT} did not restart: ${lastLine(restarted.stderr)}`, fix: "journalctl -u vmon -n 50 --no-pager" });
			return { steps, netPool: pool };
		}
	}
	const vmonChanged = vmonWritten || !before.vmon.enabled || !before.vmon.active;
	const vmonDetail = `${VMON_UNIT} enabled and active as a node joining ${server}:7946 (net pool ${pool})`;
	if (!(await started(VMON_UNIT, "system.unit.vmon", vmonWritten && before.vmon.active ? `${VMON_UNIT} restarted: its unit changed (joins ${server}:7946, net pool ${pool})` : vmonDetail, vmonChanged))) return { steps, netPool: pool };

	const syncChanged = syncWritten || !before.sync.enabled || !before.sync.active;
	await started(SYNC_TIMER, "system.unit.omp-cloud-vmon-sync", `${SYNC_TIMER} enabled and active: this machine follows the server's vibemon version`, syncChanged);
	return { steps, netPool: pool };
}

/**
 * Disables and removes whichever omp-cloud system units exist (the server's `vmon` and `omp-cloud-net`, a node's
 * `omp-cloud-node-net` and sync timer with its service), and a `ompsvc0` link that is left over. The vmon files under `/opt`
 * and `/var/lib` are not touched. The detail names the removed files as `A`, `A and B` or `A, B and C`.
 */
export async function removeSystemUnits(options: InstallUnitsOptions): Promise<StepResult[]> {
	const { root, runner } = options;
	const candidates = [SYNC_TIMER, SYNC_UNIT, VMON_UNIT, NET_UNIT, NODE_NET_UNIT];
	const names: string[] = [];
	for (const name of candidates) if ((await readText(join(root, SYSTEM_UNIT_DIR, name))) !== null) names.push(name);
	const steps: StepResult[] = [];
	if (names.length > 0) {
		const disabled = await runner(["systemctl", "disable", "--now", ...names], { timeoutMs: START_TIMEOUT_MS });
		if (disabled.code !== 0) {
			steps.push({ id: "system.uninstall.units", status: "failed", detail: `systemctl disable --now failed: ${lastLine(disabled.stderr)}`, fix: `sudo systemctl disable --now ${names.map((name) => name.replace(/\.service$/, "")).join(" ")}` });
			return steps;
		}
	}
	for (const name of names) await rm(join(root, SYSTEM_UNIT_DIR, name), { force: true });
	await runner(["systemctl", "daemon-reload"]);
	await runner(["systemctl", "reset-failed", ...(names.length > 0 ? names : [VMON_UNIT, NET_UNIT])]);
	if ((await runner(["ip", "link", "show", SERVICE_LINK])).code === 0) await runner(["ip", "link", "del", SERVICE_LINK]);
	const removed = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
	steps.push({ id: "system.uninstall.units", status: names.length > 0 ? "changed" : "ok", detail: names.length > 0 ? `removed ${removed}` : "no omp-cloud system units to remove" });
	return steps;
}
