import { describe, expect, test } from "bun:test";
import { chooseNetPool, DEFAULT_NET_POOL, isNetPool, poolOfUnit } from "./netpool";

const DEFAULT_ROUTES = ["default via 192.168.1.1 dev eth0 proto dhcp metric 100", "192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.20", "10.254.254.1 dev ompsvc0 scope link"].join("\n");

describe("chooseNetPool", () => {
	test("is 172.20.0.0/16 when no route overlaps it", () => {
		expect(chooseNetPool(DEFAULT_ROUTES)).toBe(DEFAULT_NET_POOL);
		expect(chooseNetPool("")).toBe(DEFAULT_NET_POOL);
	});

	test("falls back to the first free of 172.29, 172.30 and 172.31 when a route overlaps", () => {
		const nested = `default via 172.20.0.1 dev eth0\n172.20.0.0/30 dev eth0 proto kernel scope link src 172.20.0.2`;
		expect(chooseNetPool(nested)).toBe("172.29.0.0/16");
		expect(chooseNetPool(`${nested}\n172.29.5.0/24 dev tap1`)).toBe("172.30.0.0/16");
		expect(chooseNetPool(`${nested}\n172.29.0.0/16 dev a\n172.30.1.1 dev b`)).toBe("172.31.0.0/16");
	});

	test("a wider route that contains the pool overlaps too, and so does a host route inside it", () => {
		expect(chooseNetPool("172.20.0.0/15 dev eth0")).toBe("172.29.0.0/16");
		expect(chooseNetPool("172.16.0.0/12 dev eth0")).toBeNull();
		expect(chooseNetPool("172.20.7.9 dev tap0 scope link")).toBe("172.29.0.0/16");
	});

	test("the default route and a VPN's split default are not conflicts", () => {
		expect(chooseNetPool("default dev wg0\n0.0.0.0/1 dev wg0\n128.0.0.0/1 dev wg0")).toBe(DEFAULT_NET_POOL);
	});

	test("route types before the prefix are skipped, IPv6 lines ignored", () => {
		expect(chooseNetPool("unreachable 172.20.0.0/16\nfe80::/64 dev eth0")).toBe("172.29.0.0/16");
		expect(chooseNetPool("blackhole 172.29.1.0/24\nlocal 172.20.1.1 dev lo")).toBe("172.30.0.0/16");
	});

	test("is null when every candidate overlaps", () => {
		expect(chooseNetPool("172.20.0.0/16 dev a\n172.29.0.0/16 dev b\n172.30.0.0/16 dev c\n172.31.0.0/16 dev d")).toBeNull();
	});
});

describe("isNetPool", () => {
	test("takes an IPv4 prefix with room for /30 leases", () => {
		expect(isNetPool("172.29.0.0/16")).toBe(true);
		expect(isNetPool("172.29.0.0/30")).toBe(false);
		expect(isNetPool("172.29.0.0")).toBe(false);
		expect(isNetPool("999.1.1.1/16")).toBe(false);
	});
});

describe("poolOfUnit", () => {
	test("reads --net-pool from a unit file", () => {
		expect(poolOfUnit("ExecStart=/opt/vmon/vmon serve --net-pool 172.30.0.0/16\nKillMode=process")).toBe("172.30.0.0/16");
	});

	test("a vmon start line without the flag runs the default pool", () => {
		expect(poolOfUnit("ExecStart=/opt/vmon/vmon serve --role node,driver")).toBe(DEFAULT_NET_POOL);
	});

	test("is null for text that does not start vmon, or a malformed pool", () => {
		expect(poolOfUnit("")).toBeNull();
		expect(poolOfUnit("ExecStart=/bin/true")).toBeNull();
		expect(poolOfUnit("ExecStart=/opt/vmon/vmon serve --net-pool nonsense")).toBeNull();
	});
});
