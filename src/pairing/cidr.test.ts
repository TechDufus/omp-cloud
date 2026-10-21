import { describe, expect, test } from "bun:test";
import { DEFAULT_REMOTE_ALLOW } from "../config";
import { canonicalAddress, type Cidr, cidrsContain, parseCidr, parseIp } from "./cidr";

function cidrs(...texts: string[]): Cidr[] {
	return texts.map(text => {
		const cidr = parseCidr(text);
		if (cidr === null) throw new Error(`bad cidr ${text}`);
		return cidr;
	});
}

describe("parseIp", () => {
	test("reads IPv4 and IPv6 literals", () => {
		expect(parseIp("10.0.0.1")).toEqual({ family: 4, value: 0x0a000001n });
		expect(parseIp("::1")).toEqual({ family: 6, value: 1n });
		expect(parseIp("fd00::1")?.family).toBe(6);
		expect(parseIp("2001:db8:0:0:0:0:0:1")).toEqual(parseIp("2001:db8::1"));
		expect(parseIp("fe80::1%eth0")).toEqual(parseIp("fe80::1"));
	});

	test("unmaps IPv4-mapped IPv6 addresses in both spellings", () => {
		expect(parseIp("::ffff:10.1.2.3")).toEqual(parseIp("10.1.2.3"));
		expect(parseIp("::ffff:0a01:0203")).toEqual(parseIp("10.1.2.3"));
	});

	test.each(["", "10.0.0", "10.0.0.256", "10.0.0.01", "a.b.c.d", "1:2:3", "::1::2", "12345::", "10.0.0.1/8", "localhost", "::g"])(
		"refuses %p",
		text => {
			expect(parseIp(text)).toBeNull();
		},
	);
});

describe("canonicalAddress", () => {
	test("is plain IPv4 for a mapped address, lower-case IPv6 without zone, else the text as given", () => {
		expect(canonicalAddress("::ffff:10.0.0.5")).toBe("10.0.0.5");
		expect(canonicalAddress("FD00::A%eth0")).toBe("fd00::a");
		expect(canonicalAddress("192.168.1.1")).toBe("192.168.1.1");
		expect(canonicalAddress("unknown")).toBe("unknown");
	});
});

describe("parseCidr and cidrsContain", () => {
	test("matches inside a range and not outside it", () => {
		const list = cidrs("10.0.0.0/8", "172.16.0.0/12", "fc00::/7");
		expect(cidrsContain(list, "10.255.255.255")).toBe(true);
		expect(cidrsContain(list, "172.31.0.1")).toBe(true);
		expect(cidrsContain(list, "172.32.0.1")).toBe(false);
		expect(cidrsContain(list, "11.0.0.1")).toBe(false);
		expect(cidrsContain(list, "fd12:3456::1")).toBe(true);
		expect(cidrsContain(list, "fe80::1")).toBe(false);
	});

	test("an IPv4-mapped source is matched as IPv4", () => {
		expect(cidrsContain(cidrs("10.0.0.0/8"), "::ffff:10.0.0.9")).toBe(true);
		expect(cidrsContain(cidrs("10.0.0.0/8"), "::ffff:11.0.0.9")).toBe(false);
	});

	test("a family never matches the other, and a non-address matches nothing", () => {
		expect(cidrsContain(cidrs("::/0"), "10.0.0.1")).toBe(false);
		expect(cidrsContain(cidrs("0.0.0.0/0"), "fd00::1")).toBe(false);
		expect(cidrsContain(cidrs("0.0.0.0/0"), "not-an-ip")).toBe(false);
	});

	test("host bits in the range are cleared, /32 is one host and /0 everything", () => {
		expect(cidrsContain(cidrs("10.1.2.3/8"), "10.200.0.1")).toBe(true);
		expect(cidrsContain(cidrs("10.1.2.3/32"), "10.1.2.3")).toBe(true);
		expect(cidrsContain(cidrs("10.1.2.3/32"), "10.1.2.4")).toBe(false);
		expect(cidrsContain(cidrs("0.0.0.0/0"), "8.8.8.8")).toBe(true);
	});

	test.each(["10.0.0.0", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/", "::/129", "nope/8", "10.0.0.0/8/8", "::ffff:10.0.0.0/104", "fe80::/10%eth0"])(
		"refuses %p",
		text => {
			expect(parseCidr(text)).toBeNull();
		},
	);

	test("the default allow list holds the private, CGNAT, link-local and unique-local ranges and not loopback or public ones", () => {
		const list = cidrs(...DEFAULT_REMOTE_ALLOW);
		for (const ok of ["10.0.0.42", "172.20.1.1", "192.168.50.2", "100.100.1.1", "169.254.3.3", "fd00::1", "fe80::abcd"]) {
			expect(cidrsContain(list, ok)).toBe(true);
		}
		for (const refused of ["127.0.0.1", "::1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1"]) {
			expect(cidrsContain(list, refused)).toBe(false);
		}
	});
});
