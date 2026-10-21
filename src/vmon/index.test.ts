import { describe, expect, test } from "bun:test";
import { egressNetwork } from "./index";

describe("egressNetwork", () => {
	test("an empty egress list leaves the network open", () => {
		expect(egressNetwork("http://10.254.254.1:4000", [])).toBeUndefined();
	});

	test("denies everything but the gateway's host and the listed destinations", () => {
		expect(egressNetwork("http://10.254.254.1:4000", ["example.com", "*.github.com", "1.1.1.0/24"])).toEqual({
			denyOut: ["0.0.0.0/0"],
			allowOut: ["10.254.254.1", "example.com", "*.github.com", "1.1.1.0/24"],
		});
	});

	test("the gateway host comes without its port, and a domain gateway works", () => {
		expect(egressNetwork("https://gateway.internal:8443/v1", ["example.com"])?.allowOut).toEqual(["gateway.internal", "example.com"]);
	});

	test("the gateway host is not listed twice", () => {
		expect(egressNetwork("http://10.254.254.1:4000", ["10.254.254.1", "example.com"])?.allowOut).toEqual(["10.254.254.1", "example.com"]);
	});
});
