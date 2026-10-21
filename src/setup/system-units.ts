/**
 * The two system units that make the vibemon host survive a reboot: `omp-cloud-net.service` (the dummy link `ompsvc0` that
 * carries 10.254.254.1, the only host address the sandboxes may reach) and `vmon.service`. Both are written in
 * `/etc/systemd/system` by the root part of `omp-cloud setup`. `vmon` keeps its name: the root helper and the updater restart
 * it by that name.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandRunner } from "../update/system";
import { lastLine } from "../update/system";
import { VMON_BINARY } from "../vmon/pin";
import { chooseNetPool, poolOfUnit } from "./netpool";
import type { StepResult } from "./steps";

export const NET_UNIT = "omp-cloud-net.service";
export const VMON_UNIT = "vmon.service";
export const SYSTEM_UNIT_DIR = "/etc/systemd/system";
export const SERVICE_IP = "10.254.254.1";
export const SERVICE_LINK = "ompsvc0";

const START_TIMEOUT_MS = 120_000;

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
 */
export function renderVmonUnit(pool: string): string {
	const args = [
		"serve", "--role", "node,driver", "--data-dir", "/var/lib/vmon",
		"--listen", "127.0.0.1:3000", "--public-url", "http://127.0.0.1:3000", "--domain", "localhost",
		"--cluster-listen", "127.0.0.1:7947", "--gossip-listen", "127.0.0.1:7946",
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
}

export interface InstallUnitsOutcome {
	steps: StepResult[];
	/** The TAP pool the vmon unit uses; empty when none could be chosen. */
	netPool: string;
}

/**
 * Writes both units and enables both with `--now`. The pool of a unit file that already exists is kept; only a first install
 * chooses one from `ip route`.
 */
export async function installSystemUnits(options: InstallUnitsOptions): Promise<InstallUnitsOutcome> {
	const { root, runner } = options;
	const unitPath = (name: string): string => join(root, SYSTEM_UNIT_DIR, name);
	const fail = (id: string, detail: string, fix: string): InstallUnitsOutcome => ({ steps: [{ id, status: "failed", detail, fix }], netPool: "" });

	let pool = poolOfUnit((await readText(unitPath(VMON_UNIT))) ?? "");
	if (pool === null) {
		const routes = await runner(["ip", "-4", "route", "show"]);
		if (routes.code !== 0) return fail("system.unit.vmon", `ip route failed: ${lastLine(routes.stderr)}`, "install iproute2");
		pool = chooseNetPool(routes.stdout);
		if (pool === null) return fail("system.unit.vmon", "every candidate vmon network pool (172.20, 172.29, 172.30, 172.31 /16) overlaps a route of this host", "free one of those ranges, or remove the overlapping route");
	}

	const before = { net: await unitState(runner, NET_UNIT), vmon: await unitState(runner, VMON_UNIT) };
	const netWritten = await writeIfChanged(unitPath(NET_UNIT), renderNetUnit(), 0o644);
	const vmonWritten = await writeIfChanged(unitPath(VMON_UNIT), renderVmonUnit(pool), 0o644);

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

	const vmonChanged = vmonWritten || !before.vmon.enabled || !before.vmon.active;
	const detail =
		vmonWritten && before.vmon.active
			? `${VMON_UNIT} updated; it takes effect at the next restart of vmon (net pool ${pool})`
			: `${VMON_UNIT} enabled and active (net pool ${pool})`;
	await started(VMON_UNIT, "system.unit.vmon", detail, vmonChanged);
	return { steps, netPool: pool };
}

/** Disables and removes both units, and a `ompsvc0` link that is left over. The vmon files under `/opt` and `/var/lib` are not touched. */
export async function removeSystemUnits(options: InstallUnitsOptions): Promise<StepResult[]> {
	const { root, runner } = options;
	const paths = [VMON_UNIT, NET_UNIT].map((name) => join(root, SYSTEM_UNIT_DIR, name));
	const present = (await Promise.all(paths.map((path) => readText(path)))).some((text) => text !== null);
	const steps: StepResult[] = [];
	if (present) {
		const disabled = await runner(["systemctl", "disable", "--now", VMON_UNIT, NET_UNIT], { timeoutMs: START_TIMEOUT_MS });
		if (disabled.code !== 0) {
			steps.push({ id: "system.uninstall.units", status: "failed", detail: `systemctl disable --now failed: ${lastLine(disabled.stderr)}`, fix: "sudo systemctl disable --now vmon omp-cloud-net" });
			return steps;
		}
	}
	for (const path of paths) await rm(path, { force: true });
	await runner(["systemctl", "daemon-reload"]);
	await runner(["systemctl", "reset-failed", VMON_UNIT, NET_UNIT]);
	if ((await runner(["ip", "link", "show", SERVICE_LINK])).code === 0) await runner(["ip", "link", "del", SERVICE_LINK]);
	steps.push({ id: "system.uninstall.units", status: present ? "changed" : "ok", detail: present ? `removed ${VMON_UNIT} and ${NET_UNIT}` : "no omp-cloud system units to remove" });
	return steps;
}
