/**
 * What the cluster of vibemon machines offers and how much of it is taken, as the one `Capacity` the dashboard, `/cloud status`
 * and the `cloud` tool show. vibemon's per-VM ceilings (`max_vcpus` and the like) are not team totals: the totals here are
 * the sums over the alive machines.
 */
import type { Config } from "../config";
import { type ClusterView, type FleetSample, type TeamView, VmonAdmin, VmonAdminRefused, VmonAdminUnavailable } from "./admin";
import { BUILD_SIZE } from "./template";

const MINUTE_MS = 60_000;
const MAX_HISTORY_POINTS = 60;
const JOIN_SCRIPT_URL = "https://omp-cloud.techdufus.com/install.sh";
const NO_TOKEN_PROBLEM = "this server has no vibemon admin token yet";

export interface CapacityHistoryPoint {
	at: string;
	machines: number;
	vcpus: number;
	vcpusAllocated: number;
	memoryMB: number;
	memoryAllocatedMB: number;
	vms: number;
}

export interface CapacityMember {
	hostname: string;
	status: string;
	version: string;
	server: boolean;
	vcpus: number;
	vcpusAllocated: number;
	memoryMB: number;
	memoryAllocatedMB: number;
	vms: number;
}

export interface Capacity {
	available: boolean;
	/** Why it is not available, `""` when it is. */
	problem: string;
	/** What to run about that, `""` when it is available. */
	fix: string;
	/** Node members; `ready` counts the alive ones whose status is `ready`. */
	machines: { total: number; ready: number };
	/** Sums over the alive node members. */
	vcpus: { total: number; allocated: number };
	memoryMB: { total: number; allocated: number };
	diskFreeMB: number;
	vms: {
		cluster: number;
		cloud: { running: number; paused: number; limit: number };
		size: { vcpus: number; memoryMB: number };
	};
	/** The last sample of each minute, oldest first, at most 60. */
	history: CapacityHistoryPoint[];
	/** The server first, then by host name. */
	members: CapacityMember[];
	cluster: { accepting: boolean; address: string; joinCommand: string; versionSkew: boolean };
}

export interface CapacityInput {
	cluster: ClusterView;
	/** The omp-cloud team's VMs; null when the service has no team or vibemon has none by that slug. */
	team: TeamView | null;
	/** `vmon.clusterAddress` of service.json: set when the server takes other vibemon machines. */
	clusterAddress: string | undefined;
	/** The user other machines ssh to for `node --join`. */
	user: string;
}

const VM_SIZE = { vcpus: BUILD_SIZE.cpuCount, memoryMB: BUILD_SIZE.memoryMB };

function unavailable(problem: string, fix: string): Capacity {
	return {
		available: false,
		problem,
		fix,
		machines: { total: 0, ready: 0 },
		vcpus: { total: 0, allocated: 0 },
		memoryMB: { total: 0, allocated: 0 },
		diskFreeMB: 0,
		vms: { cluster: 0, cloud: { running: 0, paused: 0, limit: 0 }, size: VM_SIZE },
		history: [],
		members: [],
		cluster: { accepting: false, address: "", joinCommand: "", versionSkew: false },
	};
}

/** The last sample of each minute, oldest first, at most the last hour. */
function perMinute(samples: readonly FleetSample[]): CapacityHistoryPoint[] {
	const lastOfMinute = new Map<number, FleetSample>();
	for (const entry of [...samples].sort((a, b) => a.ts - b.ts)) lastOfMinute.set(Math.floor(entry.ts / MINUTE_MS), entry);
	return [...lastOfMinute.values()].slice(-MAX_HISTORY_POINTS).map((entry) => ({
		at: new Date(entry.ts).toISOString(),
		machines: entry.nodes,
		vcpus: entry.vcpus,
		vcpusAllocated: entry.vcpusUsed,
		memoryMB: entry.memoryMB,
		memoryAllocatedMB: entry.memoryUsedMB,
		vms: entry.sandboxes,
	}));
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/** The capacity of `input.cluster`: only alive machines add to the totals, every node member is listed. */
export function capacityReport(input: CapacityInput): Capacity {
	const { cluster, team, clusterAddress, user } = input;
	const alive = cluster.nodes.filter((node) => node.alive);
	const serverVersion = cluster.nodes.find((node) => node.server)?.version;
	return {
		available: true,
		problem: "",
		fix: "",
		machines: { total: cluster.nodes.length, ready: alive.filter((node) => node.status === "ready").length },
		vcpus: { total: sum(alive.map((node) => node.cpus)), allocated: sum(alive.map((node) => node.vcpusUsed)) },
		memoryMB: { total: sum(alive.map((node) => node.memoryMB)), allocated: sum(alive.map((node) => node.memoryUsedMB)) },
		diskFreeMB: sum(alive.map((node) => node.diskFreeMB)),
		vms: {
			cluster: sum(alive.map((node) => node.sandboxes)),
			cloud: { running: team?.running ?? 0, paused: team?.paused ?? 0, limit: team?.maxConcurrentSandboxes ?? 0 },
			size: VM_SIZE,
		},
		history: perMinute(cluster.history),
		members: cluster.nodes
			.map((node) => ({
				hostname: node.hostname,
				status: node.status,
				version: node.version,
				server: node.server,
				vcpus: node.cpus,
				vcpusAllocated: node.vcpusUsed,
				memoryMB: node.memoryMB,
				memoryAllocatedMB: node.memoryUsedMB,
				vms: node.sandboxes,
			}))
			.sort((a, b) => Number(b.server) - Number(a.server) || a.hostname.localeCompare(b.hostname)),
		cluster: {
			accepting: clusterAddress !== undefined,
			address: clusterAddress ?? "",
			joinCommand: clusterAddress === undefined ? "" : `curl -fsSL ${JOIN_SCRIPT_URL} | sh -s -- node --join ${user}@${clusterAddress}`,
			versionSkew: serverVersion !== undefined && cluster.nodes.some((node) => node.version !== serverVersion),
		},
	};
}

/** What a failed read of vibemon's admin API means for the owner, and what to run about it. */
export function adminProblem(error: unknown): { problem: string; fix: string } {
	if (error instanceof VmonAdminUnavailable) return { problem: NO_TOKEN_PROBLEM, fix: "omp-cloud setup" };
	if (error instanceof VmonAdminRefused) return { problem: error.message, fix: "omp-cloud setup" };
	return { problem: `vibemon did not answer: ${error instanceof Error ? error.message : String(error)}`, fix: "systemctl status vmon" };
}

/**
 * The capacity as vibemon reports it now. The admin token file is read on every call, so a setup rerun takes effect without
 * a restart. Every failure is an unavailable capacity that says what to run, never a throw.
 */
export async function readCapacity(config: Config, user: string): Promise<Capacity> {
	const { adminTokenFile, url, team, clusterAddress } = config.vmon;
	if (adminTokenFile === undefined) return unavailable(NO_TOKEN_PROBLEM, "omp-cloud setup");
	try {
		const admin = await VmonAdmin.open({ url, tokenFile: adminTokenFile });
		const cluster = await admin.cluster();
		return capacityReport({ cluster, team: team === undefined ? null : await admin.team(team), clusterAddress, user });
	} catch (error) {
		const { problem, fix } = adminProblem(error);
		return unavailable(problem, fix);
	}
}
