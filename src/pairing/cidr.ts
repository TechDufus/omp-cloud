/** An IP address as a number: IPv4 in 32 bits, IPv6 in 128. */
export interface ParsedIp {
	family: 4 | 6;
	value: bigint;
}

/** One CIDR range: `network` is the address with its host bits cleared and `mask` has the `prefix` leading bits set. */
export interface Cidr {
	family: 4 | 6;
	network: bigint;
	mask: bigint;
}

const MAPPED_PREFIX = 0xffffn;

function parseIpv4(text: string): bigint | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	let value = 0n;
	for (const part of parts) {
		if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return null;
		value = (value << 8n) | BigInt(part);
	}
	return value;
}

function groupsOf(part: string): number[] | null {
	if (part === "") return [];
	const groups: number[] = [];
	for (const group of part.split(":")) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
		groups.push(Number.parseInt(group, 16));
	}
	return groups;
}

function parseIpv6(text: string): bigint | null {
	let source = text;
	if (source.includes(".")) {
		const colon = source.lastIndexOf(":");
		const tail = parseIpv4(source.slice(colon + 1));
		if (tail === null) return null;
		source = `${source.slice(0, colon + 1)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
	}
	const halves = source.split("::");
	if (halves.length > 2) return null;
	const head = groupsOf(halves[0] ?? "");
	if (head === null) return null;
	let groups: number[];
	if (halves.length === 1) {
		groups = head;
	} else {
		const tail = groupsOf(halves[1] ?? "");
		if (tail === null) return null;
		const missing = 8 - head.length - tail.length;
		if (missing < 1) return null;
		groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
	}
	if (groups.length !== 8) return null;
	return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

/** `text` as an address without unmapping `::ffff:a.b.c.d`; a zone id (`%eth0`) is dropped. Null when it is not an IP literal. */
function parseRaw(text: string): ParsedIp | null {
	if (text.includes(":")) {
		const zone = text.indexOf("%");
		const value = parseIpv6(zone < 0 ? text : text.slice(0, zone));
		return value === null ? null : { family: 6, value };
	}
	const value = parseIpv4(text);
	return value === null ? null : { family: 4, value };
}

/** `text` as an address, an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) becoming the IPv4 address; null when it is not an IP literal. */
export function parseIp(text: string): ParsedIp | null {
	const raw = parseRaw(text);
	if (raw !== null && raw.family === 6 && raw.value >> 32n === MAPPED_PREFIX) return { family: 4, value: raw.value & 0xffff_ffffn };
	return raw;
}

function dotted(value: bigint): string {
	return [24n, 16n, 8n, 0n].map(shift => String((value >> shift) & 0xffn)).join(".");
}

/** The address as the service records it: IPv4-mapped IPv6 as plain IPv4, an IPv6 address lower-cased without its zone id, anything else as given. */
export function canonicalAddress(text: string): string {
	const ip = parseIp(text);
	if (ip === null) return text;
	if (ip.family === 4) return dotted(ip.value);
	const zone = text.indexOf("%");
	return (zone < 0 ? text : text.slice(0, zone)).toLowerCase();
}

/** A CIDR range (`10.0.0.0/8`, `fc00::/7`), or null when `text` is not one. The prefix is required; an IPv4-mapped IPv6 range is refused (write it as IPv4). */
export function parseCidr(text: string): Cidr | null {
	const slash = text.indexOf("/");
	if (slash < 0 || text.includes("%")) return null;
	const ip = parseRaw(text.slice(0, slash));
	const prefixText = text.slice(slash + 1);
	if (ip === null || !/^[0-9]{1,3}$/.test(prefixText)) return null;
	const bits = ip.family === 4 ? 32 : 128;
	const prefix = Number(prefixText);
	if (prefix > bits) return null;
	if (ip.family === 6 && ip.value >> 32n === MAPPED_PREFIX) return null;
	const all = (1n << BigInt(bits)) - 1n;
	const mask = all ^ ((1n << BigInt(bits - prefix)) - 1n);
	return { family: ip.family, network: ip.value & mask, mask };
}

/** Whether `text` is an IP literal inside any of `cidrs`; anything else is not. */
export function cidrsContain(cidrs: readonly Cidr[], text: string): boolean {
	const ip = parseIp(text);
	if (ip === null) return false;
	return cidrs.some(cidr => cidr.family === ip.family && (ip.value & cidr.mask) === cidr.network);
}
