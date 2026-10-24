/** IPv4 text checks shared by the root part's argument parser, the unit renderers and the preflight. */

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const PLAIN_IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/** A plain dotted quad: four decimal octets from 0 to 255 without leading zeros (`inet_pton`'s form). */
export function isPlainIpv4(text: string): boolean {
	return PLAIN_IPV4.test(text);
}

/** Throws unless `text` is a plain dotted quad; what ends up in a unit text or a shell command must be this and nothing else. */
export function requirePlainIpv4(text: string, what: string): string {
	if (!isPlainIpv4(text)) throw new Error(`${what} ${JSON.stringify(text)} is not a plain IPv4 address`);
	return text;
}

/** 10/8, 172.16/12 and 192.168/16: the ranges a LAN uses. */
export function isPrivateLan(address: string): boolean {
	if (!isPlainIpv4(address)) return false;
	const [a = 0, b = 0] = address.split(".").map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** An address a machine can be reached at: not 0.x (including 0.0.0.0), loopback, multicast, reserved (including 255.255.255.255). */
export function isUnicastHost(address: string): boolean {
	if (!isPlainIpv4(address)) return false;
	const [a = 0] = address.split(".").map(Number);
	return a !== 0 && a !== 127 && a < 224;
}
