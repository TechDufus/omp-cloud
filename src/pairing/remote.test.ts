import { describe, expect, test } from "bun:test";
import { DEFAULT_REMOTE_ALLOW } from "../config";
import { advertiseAddresses, type HostNetwork, hostAddresses, hostPort, RemoteAccess } from "./remote";

describe("RemoteAccess", () => {
	const access = new RemoteAccess(DEFAULT_REMOTE_ALLOW, ["10.254.254.1"]);

	test("serves sources inside the allow list", () => {
		for (const address of ["10.0.0.42", "192.168.1.9", "100.64.3.3", "fd00::5", "fe80::1%eth0"]) expect(access.permits(address)).toBe(true);
	});

	test("refuses loopback and public sources by default", () => {
		for (const address of ["127.0.0.1", "::1", "8.8.8.8", "2001:db8::1", "not-an-ip", ""]) expect(access.permits(address)).toBe(false);
	});

	test("always refuses the denied addresses, even inside the allow list, in any spelling", () => {
		expect(access.permits("10.254.254.1")).toBe(false);
		expect(access.permits("::ffff:10.254.254.1")).toBe(false);
		expect(access.permits("10.254.254.2")).toBe(true);
		const listed = new RemoteAccess(["10.254.254.1/32", "127.0.0.0/8"], ["10.254.254.1"]);
		expect(listed.permits("10.254.254.1")).toBe(false);
		expect(listed.permits("127.0.0.1")).toBe(true);
	});

	test("treats an IPv4-mapped source as IPv4", () => {
		expect(access.permits("::ffff:10.0.0.7")).toBe(true);
		expect(access.permits("::ffff:127.0.0.1")).toBe(false);
	});

	test("an allow list replaces the default", () => {
		const custom = new RemoteAccess(["203.0.113.0/24"], []);
		expect(custom.permits("203.0.113.9")).toBe(true);
		expect(custom.permits("10.0.0.1")).toBe(false);
	});

	test("a bad allow or denied entry throws", () => {
		expect(() => new RemoteAccess(["10.0.0.0"], [])).toThrow("not a CIDR range");
		expect(() => new RemoteAccess(["10.0.0.0/8"], ["gateway.local"])).toThrow("not an IP address");
	});
});

describe("hostAddresses", () => {
	test("an address literal is itself, an IPv6 one without brackets", async () => {
		expect(await hostAddresses("http://10.254.254.1:4000")).toEqual(["10.254.254.1"]);
		expect(await hostAddresses("http://[fd00::1]:4000/x")).toEqual(["fd00::1"]);
	});

	test("a name resolves to its addresses", async () => {
		const found = await hostAddresses("http://localhost:4000");
		expect(found.length).toBeGreaterThan(0);
		expect(found.some(address => address === "127.0.0.1" || address === "::1")).toBe(true);
	});
});

describe("hostPort", () => {
	test("brackets an IPv6 host", () => {
		expect(hostPort("10.0.0.1", 8443)).toBe("10.0.0.1:8443");
		expect(hostPort("fd00::1", 8443)).toBe("[fd00::1]:8443");
	});
});

describe("advertiseAddresses", () => {
	const network: HostNetwork = {
		hostname: () => "workstation",
		interfaces: () => ({
			lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
			eth0: [
				{ address: "10.0.0.42", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "10.0.0.42/24" },
				{ address: "fd00::42", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "fd00::42/64", scopeid: 0 },
			],
			docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4", mac: "02:42:00:00:00:00", internal: false, cidr: "172.17.0.1/16" }],
			ompsvc0: [{ address: "10.254.254.1", netmask: "255.255.255.255", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "10.254.254.1/32" }],
			vethabc: [{ address: "172.18.0.1", netmask: "255.255.0.0", family: "IPv4", mac: "02:00:00:00:00:00", internal: false, cidr: "172.18.0.1/16" }],
			wlan0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:00:00:00", internal: false, cidr: "192.168.1.20/24" }],
		}),
	};

	test("remote.advertise wins, as given", () => {
		expect(advertiseAddresses({ listen: { hostname: "0.0.0.0", port: 8443 }, advertise: ["a.example:1"] }, network)).toEqual(["a.example:1"]);
	});

	test("a specific listen host is the only address advertised", () => {
		expect(advertiseAddresses({ listen: { hostname: "10.0.0.42", port: 9000 } }, network)).toEqual(["10.0.0.42:9000"]);
		expect(advertiseAddresses({ listen: { hostname: "fd00::42", port: 9000 } }, network)).toEqual(["[fd00::42]:9000"]);
	});

	test("a wildcard listen host advertises the real IPv4 interfaces, then <hostname>.local", () => {
		for (const hostname of ["0.0.0.0", "::"]) {
			expect(advertiseAddresses({ listen: { hostname, port: 8443 } }, network)).toEqual(["10.0.0.42:8443", "192.168.1.20:8443", "workstation.local:8443"]);
		}
	});
});
