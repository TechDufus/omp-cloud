/**
 * vmon's TAP pool (`--net-pool`): sandboxes lease /30 networks from it, so it must not overlap a route the host already
 * has. A vmon inside a vmon sandbox sits in the outer pool's range (172.20.0.0/16), which is why the first pool is not
 * always usable.
 */

export const DEFAULT_NET_POOL = "172.20.0.0/16";
/** The pools in the order setup tries them. */
export const NET_POOL_CANDIDATES: readonly string[] = [DEFAULT_NET_POOL, "172.29.0.0/16", "172.30.0.0/16", "172.31.0.0/16"];

interface Prefix {
	/** First address of the network as an unsigned 32-bit integer. */
	first: number;
	/** Last address. */
	last: number;
}

/** `a.b.c.d` as an unsigned integer; null when it is not an IPv4 address. */
function parseAddress(text: string): number | null {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (match === null) return null;
	const octets = match.slice(1).map(Number);
	if (octets.some((octet) => octet > 255)) return null;
	return octets.reduce((value, octet) => value * 256 + octet, 0);
}

/** `a.b.c.d/n` or a bare address (a host route) as a range; null for anything else (`default`, IPv6). */
function parsePrefix(text: string): Prefix | null {
	const [address, length, ...rest] = text.split("/");
	if (address === undefined || rest.length > 0) return null;
	const base = parseAddress(address);
	if (base === null) return null;
	const bits = length === undefined ? 32 : /^\d{1,2}$/.test(length) ? Number(length) : -1;
	if (bits < 0 || bits > 32) return null;
	const size = 2 ** (32 - bits);
	const first = Math.floor(base / size) * size;
	return { first, last: first + size - 1 };
}

/** What `ip route` prints before the prefix of a route that is not a plain one. */
const ROUTE_TYPES = new Set(["unicast", "local", "broadcast", "multicast", "throw", "unreachable", "prohibit", "blackhole", "nat", "anycast"]);

/** The prefixes of `ip route` output: the first word of each line (after a route type), skipping `default`. */
function routePrefixes(ipRoute: string): Prefix[] {
	const prefixes: Prefix[] = [];
	for (const line of ipRoute.split("\n")) {
		const words = line.trim().split(/\s+/);
		const destination = words.find((word) => !ROUTE_TYPES.has(word));
		if (destination === undefined) continue;
		const prefix = parsePrefix(destination);
		if (prefix !== null) prefixes.push(prefix);
	}
	return prefixes;
}

/**
 * The first candidate pool that no route of `ipRoute` (the output of `ip -4 route show`) overlaps; null when every one does.
 * A route wider than a /8 (the default route, or the 0.0.0.0/1 + 128.0.0.0/1 pair a VPN installs instead) says nothing
 * about a private pool and is not a conflict.
 */
export function chooseNetPool(ipRoute: string): string | null {
	const routes = routePrefixes(ipRoute).filter((route) => route.last - route.first + 1 <= 2 ** 24);
	for (const candidate of NET_POOL_CANDIDATES) {
		const pool = parsePrefix(candidate);
		if (pool === null) continue;
		if (!routes.some((route) => route.first <= pool.last && pool.first <= route.last)) return candidate;
	}
	return null;
}

/** Whether `pool` is `a.b.c.d/n` with a length that leaves room for /30 leases. */
export function isNetPool(pool: string): boolean {
	const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(pool);
	return match !== null && parsePrefix(pool) !== null && Number(match[2]) <= 28;
}

/**
 * The pool a vmon unit file already runs with: its `--net-pool` value, or vmon's default when the text starts vmon
 * without the flag. null when the text is not a vmon start line at all. A pool that is in use stays: vmon's own TAP
 * routes lie inside it, so choosing again from `ip route` would flee its own pool.
 */
export function poolOfUnit(unitText: string): string | null {
	const flagged = /--net-pool[=\s]\s*(\S+)/.exec(unitText);
	if (flagged?.[1] !== undefined) {
		const pool = flagged[1].replace(/[;"']+$/, "");
		return isNetPool(pool) ? pool : null;
	}
	return /\bvmon\b.*\bserve\b/.test(unitText) ? DEFAULT_NET_POOL : null;
}
