/**
 * What the caller of a `whoami` may do. The owner token and a paired device with `full` access are the same person with
 * the same rights; a device with `threads` access can use its own threads and read the rest. Every check of "may this
 * connection change the cloud" goes through {@link fullAccess}, never through the connection type.
 */

import type { Whoami } from "./types";

/** Whether the caller may do anything the owner token can: the owner token itself, or a device with full access. */
export function fullAccess(who: Pick<Whoami, "device">): boolean {
	return who.device === null || who.device.access === "full";
}

/** Who the caller is, as one sentence for `/cloud status` and the tool's `info`. */
export function youLine(who: Pick<Whoami, "device">): string {
	const { device } = who;
	if (device === null) return "the owner, with the server's owner token (full access)";
	if (device.access === "full") return `the owner, on device ${device.name} (full access)`;
	return `device ${device.name}, threads only (a connection with full access runs /cloud devices access ${device.name} full)`;
}
