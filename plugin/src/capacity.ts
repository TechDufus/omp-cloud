/**
 * The cloud's capacity as the session shows it (`/cloud status`, the tool's `info`, the update confirmation): the vibemon
 * cluster as one pool, which `GET /capacity` reports for every caller.
 */

import type { CloudClient } from "./api";
import { plural } from "./format";
import type { Capacity, Whoami } from "./types";

/** `98304` MB as `96`, `1536` as `1.5`: GiB with at most one decimal. */
function gib(mb: number): string {
	return String(Math.round((mb / 1024) * 10) / 10);
}

/** `<n> vCPU (<n> allocated) · <n> GiB (<n> allocated) · <n> machines · <n> of <limit> VMs running`, or why it is unavailable. */
export function capacityLine(c: Capacity): string {
	if (!c.available) return `unavailable (${c.problem === "" ? "the service did not say why" : c.problem})`;
	const vms = c.vms.cloud.limit > 0 ? `${c.vms.cloud.running} of ${c.vms.cloud.limit} VMs running` : `${c.vms.cloud.running} VMs running`;
	const parts = [
		`${c.vcpus.total} vCPU (${c.vcpus.allocated} allocated)`,
		`${gib(c.memoryMB.total)} GiB (${gib(c.memoryMB.allocated)} allocated)`,
		plural(c.machines.total, "machine"),
		vms,
	];
	if (c.cluster.versionSkew) parts.push("vibemon versions differ");
	return parts.join(" · ");
}

/** The capacity when the service serves it and answers; undefined otherwise (an older service, a failed call): callers leave the line out. */
export async function readCapacity(client: Pick<CloudClient, "capacity">, who: Pick<Whoami, "capabilities">, signal?: AbortSignal): Promise<Capacity | undefined> {
	if (!who.capabilities.includes("capacity")) return undefined;
	try {
		return await client.capacity({ signal });
	} catch {
		return undefined;
	}
}
