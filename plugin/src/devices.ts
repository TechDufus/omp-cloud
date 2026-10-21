/** `/cloud devices`, `/cloud devices revoke` and `/cloud disconnect`. */

import { rm } from "node:fs/promises";
import { CloudClient, type ClientTuning } from "./api";
import { CloudError } from "./errors";
import { noticeCard, type NoticeCard } from "./cards";
import type { PairedConnection } from "./connection";
import { formatAge, plural } from "./format";
import { pinnedFetch } from "./transport";
import { UserError, type Device, type HostUi } from "./types";

type DevicesApi = Pick<CloudClient, "devices" | "revokeDevice">;

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** The paired devices as a card: one row each, the caller's own marked. */
export function devicesCard(devices: readonly Device[], now: number): NoticeCard {
	const lines = devices.map(d => {
		// formatAge says "now" under a minute and "" for an unreadable time; both read as "just now" here.
		const seenAge = formatAge(d.lastSeenAt, now);
		const pairedAge = formatAge(d.createdAt, now);
		const seen =
			d.lastSeenAt === ""
				? "never seen"
				: `seen ${seenAge === "" || seenAge === "now" ? "just now" : `${seenAge} ago`}${d.lastSeenAddress ? ` from ${d.lastSeenAddress}` : ""}`;
		const paired = pairedAge === "" || pairedAge === "now" ? "paired just now" : `paired ${pairedAge} ago`;
		return `${d.name}${d.current ? " (this device)" : ""} · ${d.platform} · ${d.id.slice(0, 8)} · ${paired} from ${d.pairedFrom} · ${seen}`;
	});
	if (lines.length === 0) lines.push("no devices are paired; /cloud pair on the server machine adds one");
	return noticeCard("", `Paired devices (${devices.length})`, lines);
}

/** The one device `target` names: a name (any case), else a unique id prefix. */
export function resolveDevice(target: string, devices: readonly Device[]): Device {
	const wanted = target.trim();
	const byName = devices.filter(d => d.name.toLowerCase() === wanted.toLowerCase());
	const hits = byName.length > 0 ? byName : devices.filter(d => d.id.startsWith(wanted));
	const [only] = hits;
	if (hits.length === 1 && only) return only;
	if (hits.length > 1) throw new UserError(`☁ "${wanted}" matches several devices: ${hits.map(d => `${d.name} (${d.id.slice(0, 8)})`).join(", ")}`);
	throw new UserError(`☁ no device matches "${wanted}"; /cloud devices lists them`);
}

/** Revokes the device `target` names, after the user confirms, and says which of its threads still run. */
export async function runRevoke(api: DevicesApi, ui: Pick<HostUi, "notify" | "confirm">, target: string): Promise<void> {
	const device = resolveDevice(target, (await api.devices()));
	if (device.current) throw new UserError("☁ that is this machine's own device; /cloud disconnect removes it");
	if (!(await ui.confirm("Revoke device", `Revoke ${device.name}? Its token stops working at once and its open connections end.`))) return;
	const revoked = await api.revokeDevice(device.id);
	const lines = [`☁ revoked ${revoked.device.name || device.name}`];
	if (revoked.runningThreads.length > 0) {
		lines.push(`  ${plural(revoked.runningThreads.length, "thread")} it started still run: ${revoked.runningThreads.join(", ")} (/cloud stop <id> ends one)`);
	}
	ui.notify(lines.join("\n"), "info");
}

export interface DisconnectDeps {
	connectionFile: string;
	paired: PairedConnection;
	ui: Pick<HostUi, "notify" | "confirm">;
	force: boolean;
	/** Stops the dashboard forwarder, whose device token is about to be gone. */
	stopForwarder(): void;
	/** The client's retry schedule; a test seam. */
	tuning?: ClientTuning;
}

/**
 * Revokes this machine's own device, then deletes the connection file and stops the dashboard forwarder. When the
 * service cannot be reached the file stays, unless `force`: then it goes anyway and the token stays valid on the
 * server until the owner revokes the device there. True when the connection was removed, false when the user declined.
 */
export async function runDisconnect(d: DisconnectDeps): Promise<boolean> {
	const { paired, ui } = d;
	if (!(await ui.confirm("Disconnect", `Revoke this device (${paired.device.name}) on the server and forget the connection?`))) return false;
	const client = new CloudClient(`https://${paired.server.addresses[0] ?? ""}`, paired.token, pinnedFetch(paired.server), d.tuning);
	const notes: string[] = [];
	try {
		await client.revokeDevice(paired.device.id);
		notes.push(`revoked ${paired.device.name} on the server`);
	} catch (e) {
		if (e instanceof CloudError && (e.status === 401 || e.status === 404)) {
			notes.push("the server had already revoked this device");
		} else if (!d.force) {
			throw new UserError(
				`☁ could not revoke this device on the server (${errorText(e)}); the connection is kept. /cloud disconnect --force forgets it anyway, and the token then stays valid until the owner revokes ${paired.device.name} on the server machine`,
			);
		} else {
			notes.push(`could not reach the server (${errorText(e)}): the token of ${paired.device.name} stays valid until it is revoked from the server machine`);
		}
	}
	await rm(d.connectionFile, { force: true });
	d.stopForwarder();
	ui.notify(["☁ disconnected", ...notes.map(n => `  ${n}`)].join("\n"), notes.some(n => n.startsWith("could not")) ? "warning" : "info");
	return true;
}
