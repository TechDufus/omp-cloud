import { describe, expect, test } from "bun:test";
import { SourceLimiter, sourceKey } from "./limiter";

describe("sourceKey", () => {
	test("IPv4 and its mapped form share a bucket", () => {
		expect(sourceKey("10.0.0.5")).toBe(sourceKey("::ffff:10.0.0.5"));
		expect(sourceKey("10.0.0.5")).not.toBe(sourceKey("10.0.0.6"));
	});

	test("IPv6 sources are bucketed by /64", () => {
		expect(sourceKey("fd00:1:2:3::1")).toBe(sourceKey("fd00:1:2:3:ffff:ffff:ffff:ffff"));
		expect(sourceKey("fd00:1:2:3::1")).not.toBe(sourceKey("fd00:1:2:4::1"));
	});

	test("a text that is no address has its own bucket", () => {
		expect(sourceKey("unknown")).toBe("raw:unknown");
	});
});

describe("SourceLimiter", () => {
	function limiter(now: () => number, max = 10, buckets = 4096): SourceLimiter {
		return new SourceLimiter(max, 60_000, buckets, now);
	}

	test("blocks a source at ten failures in a minute and nobody else", () => {
		let t = 1_000_000;
		const l = limiter(() => t);
		for (let i = 0; i < 9; i++) l.fail("10.0.0.5");
		expect(l.blocked("10.0.0.5")).toBe(false);
		l.fail("10.0.0.5");
		expect(l.blocked("10.0.0.5")).toBe(true);
		expect(l.blocked("10.0.0.6")).toBe(false);
		expect(l.retryAfterSeconds("10.0.0.5")).toBe(60);
		t += 30_000;
		expect(l.retryAfterSeconds("10.0.0.5")).toBe(30);
		t += 30_001;
		expect(l.blocked("10.0.0.5")).toBe(false);
		expect(l.size).toBe(0);
	});

	test("failures age out one by one", () => {
		let t = 0;
		const l = limiter(() => t, 3);
		l.fail("10.0.0.5");
		t += 40_000;
		l.fail("10.0.0.5");
		l.fail("10.0.0.5");
		expect(l.blocked("10.0.0.5")).toBe(true);
		t += 20_001;
		expect(l.blocked("10.0.0.5")).toBe(false);
	});

	test("IPv6 sources of one /64 share the budget", () => {
		const l = limiter(() => 5, 2);
		l.fail("fd00:1:2:3::1");
		l.fail("fd00:1:2:3::2");
		expect(l.blocked("fd00:1:2:3::99")).toBe(true);
		expect(l.blocked("fd00:1:2:4::1")).toBe(false);
	});

	test("tracks at most 4096 sources and drops the one whose last failure is oldest", () => {
		let t = 0;
		const l = limiter(() => t, 1, 3);
		for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
			l.fail(ip);
			t += 1;
		}
		l.fail("10.0.0.1");
		t += 1;
		expect(l.size).toBe(3);
		l.fail("10.0.0.4");
		expect(l.size).toBe(3);
		expect(l.blocked("10.0.0.2")).toBe(false);
		expect(l.blocked("10.0.0.1")).toBe(true);
		expect(l.blocked("10.0.0.3")).toBe(true);
		expect(l.blocked("10.0.0.4")).toBe(true);
	});

	test("the default tracks 4096 sources", () => {
		const l = new SourceLimiter();
		for (let i = 0; i < 5000; i++) l.fail(`10.${(i >> 8) & 255}.${i & 255}.1`);
		expect(l.size).toBe(4096);
	});
});
