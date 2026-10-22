import { canonicalAddress, cidrsContain, parseCidr } from "../pairing/cidr";

/** Address ranges an MCP server may not sit in: this host (a VM that reached it could call the service's own listeners) and link-local (cloud metadata). LAN ranges stay allowed, for the owner's homelab servers. */
const REFUSED_RANGES = ["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "::/128", "::1/128", "fe80::/10"].flatMap(range => {
	const cidr = parseCidr(range);
	return cidr === null ? [] : [cidr];
});

/** The host of a URL without the brackets of an IPv6 literal, lower-cased. */
function bareHost(hostname: string): string {
	return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname).toLowerCase();
}

/** Whether `address` (an IP literal) is loopback, unspecified, link-local, or one of `own` (the service's own addresses). */
export function isRefusedUpstream(address: string, own: readonly string[] = []): boolean {
	const host = bareHost(address);
	return cidrsContain(REFUSED_RANGES, host) || own.some(entry => canonicalAddress(bareHost(entry)) === canonicalAddress(host));
}

/** Whether an MCP server URL's `hostname` is a name or address that points at the service host (`localhost`, a loopback or link-local address, one of `own`). Names other than `localhost` are judged when the proxy resolves them. */
export function isRefusedHost(hostname: string, own: readonly string[] = []): boolean {
	const host = bareHost(hostname);
	return host === "localhost" || host.endsWith(".localhost") || isRefusedUpstream(host, own);
}
