import { lookup } from "node:dns/promises";
import { hostname as osHostname, type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import type { RemoteConfig } from "../config";
import { type Cidr, cidrsContain, type ParsedIp, parseCidr, parseIp } from "./cidr";
import { type Identity, loadIdentity } from "./identity";

/** Interfaces whose addresses a device cannot reach the host by: loopback, containers, VMs and tunnels. */
const VIRTUAL_INTERFACE = /^(lo|docker|br-|veth|vmon|virbr|ompsvc|cni|flannel|kube|tap|tun)/;

/** The wildcard hosts of a listener: bound to every address, so no one of them is advertised. */
const WILDCARD_HOSTS: readonly string[] = ["0.0.0.0", "::", "[::]"];

/** The remote listener as the API serves it: what offers and `whoami` report, and who may connect. */
export interface RemoteSettings {
	listen: { hostname: string; port: number };
	/** `host:port` entries of `remote.advertise`; absent means the host's own addresses. */
	advertise?: string[];
	/** `SHA256:…`, as shown to people. */
	fingerprint: string;
	/** The same digest as base64url: what a code carries. */
	fingerprintCode: string;
	/** Which sources the TLS listener answers. */
	access: RemoteAccess;
}

/** Who may reach the remote listener: sources inside `allow`, and never the `denied` addresses. */
export class RemoteAccess {
	readonly #allow: Cidr[];
	readonly #denied: ParsedIp[];

	/** Throws when an `allow` entry is not a CIDR range or a `denied` entry is not an IP address. */
	constructor(allow: readonly string[], denied: readonly string[]) {
		this.#allow = allow.map(entry => {
			const cidr = parseCidr(entry);
			if (cidr === null) throw new Error(`${entry} is not a CIDR range`);
			return cidr;
		});
		this.#denied = denied.map(entry => {
			const ip = parseIp(entry);
			if (ip === null) throw new Error(`${entry} is not an IP address`);
			return ip;
		});
	}

	/** Whether a connection from `address` may be served: inside `allow` and not denied. IPv4-mapped IPv6 counts as IPv4. */
	permits(address: string): boolean {
		const ip = parseIp(address);
		if (ip === null || this.#denied.some(denied => denied.family === ip.family && denied.value === ip.value)) return false;
		return cidrsContain(this.#allow, address);
	}
}

/** The addresses of the host named by `url`: the literal itself, or every address its name resolves to. Throws when a name does not resolve. */
export async function hostAddresses(url: string): Promise<string[]> {
	const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
	if (parseIp(host) !== null) return [host];
	const found = await lookup(host, { all: true });
	return found.map(entry => entry.address);
}

/** What `openRemote` returns: the identity to serve TLS with and the settings the API runs the remote listener by. */
export interface OpenedRemote {
	identity: Identity;
	settings: RemoteSettings;
}

/**
 * Loads the TLS identity (refusing a key others can read, or a bad certificate) and builds the remote listener's
 * settings. The gateway host's addresses are always refused, because VMs reach them: vmon exempts that address from the
 * sandbox egress deny on every port and its proxy dials from the host, so a VM's connection to any listener bound to all
 * addresses arrives with the gateway address as its source. `gatewayUrl` names that host.
 */
export async function openRemote(remote: RemoteConfig, gatewayUrl: string): Promise<OpenedRemote> {
	const identity = await loadIdentity(remote);
	const denied = await hostAddresses(gatewayUrl);
	return {
		identity,
		settings: {
			listen: remote.listen,
			advertise: remote.advertise,
			fingerprint: identity.fingerprint,
			fingerprintCode: identity.fingerprintCode,
			access: new RemoteAccess(remote.allow, denied),
		},
	};
}

/** `host:port`, an IPv6 host in brackets. */
export function hostPort(hostname: string, port: number): string {
	return `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

/** The interfaces `advertiseAddresses` reads; a test seam. */
export interface HostNetwork {
	interfaces(): Record<string, NetworkInterfaceInfo[] | undefined>;
	hostname(): string;
}

const HOST_NETWORK: HostNetwork = { interfaces: networkInterfaces, hostname: osHostname };

/**
 * The addresses a pairing code lists: `remote.advertise` when set; else the one specific host `remote.listen` binds;
 * else the host's non-internal IPv4 addresses (virtual interfaces left out) and `<hostname>.local`, each with the port.
 */
export function advertiseAddresses(
	remote: Pick<RemoteSettings, "listen" | "advertise">,
	network: HostNetwork = HOST_NETWORK,
): string[] {
	if (remote.advertise !== undefined) return [...remote.advertise];
	const { hostname, port } = remote.listen;
	if (!WILDCARD_HOSTS.includes(hostname)) return [hostPort(hostname, port)];
	const addresses: string[] = [];
	for (const [name, entries] of Object.entries(network.interfaces())) {
		if (VIRTUAL_INTERFACE.test(name)) continue;
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) addresses.push(hostPort(entry.address, port));
		}
	}
	addresses.push(hostPort(`${network.hostname()}.local`, port));
	return addresses;
}
