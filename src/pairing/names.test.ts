import { describe, expect, test } from "bun:test";
import { MAX_DEVICE_NAME_CHARS, parseDeviceName, parsePlatform, suffixedName } from "./names";
import { DEVICE_TOKEN_PREFIX, hashesEqual, newDeviceToken, randomBase64Url, sha256Hex } from "./secrets";

describe("parseDeviceName", () => {
	test("trims and accepts letters, digits, space, dot, underscore and hyphen of any script", () => {
		expect(parseDeviceName("  work laptop  ")).toBe("work laptop");
		expect(parseDeviceName("a.b_c-d 9")).toBe("a.b_c-d 9");
		expect(parseDeviceName("Ünïcödé 日本語")).toBe("Ünïcödé 日本語");
		expect(parseDeviceName("x".repeat(MAX_DEVICE_NAME_CHARS))).toHaveLength(MAX_DEVICE_NAME_CHARS);
	});

	test("counts characters, not UTF-16 units or bytes", () => {
		expect(parseDeviceName("日".repeat(MAX_DEVICE_NAME_CHARS))).not.toBeNull();
		expect(parseDeviceName("日".repeat(MAX_DEVICE_NAME_CHARS + 1))).toBeNull();
	});

	test.each(["", "   ", "x".repeat(65), "<b>", "a/b", "a\\b", "a\nb", "a\tb", "it's", "emoji 😀", "a:b", "a@b"])("refuses %p", name => {
		expect(parseDeviceName(name)).toBeNull();
	});
});

describe("parsePlatform", () => {
	test("accepts 1 to 32 of [A-Za-z0-9._-]", () => {
		expect(parsePlatform("linux")).toBe("linux");
		expect(parsePlatform("win32-x64.1_a")).toBe("win32-x64.1_a");
		expect(parsePlatform("x".repeat(32))).not.toBeNull();
	});

	test.each(["", "x".repeat(33), "lin ux", "li/nux", "linüx", " linux"])("refuses %p", platform => {
		expect(parsePlatform(platform)).toBeNull();
	});
});

describe("suffixedName", () => {
	test("appends -n and cuts the base to stay within the limit", () => {
		expect(suffixedName("laptop", 2)).toBe("laptop-2");
		const long = suffixedName("n".repeat(64), 12);
		expect([...long]).toHaveLength(64);
		expect(long.endsWith("-12")).toBe(true);
	});
});

describe("secrets", () => {
	test("device tokens are ompd_ and 32 random bytes as base64url, all different", () => {
		const a = newDeviceToken();
		expect(a).toStartWith(DEVICE_TOKEN_PREFIX);
		expect(a).toMatch(/^ompd_[A-Za-z0-9_-]{43}$/);
		expect(newDeviceToken()).not.toBe(a);
	});

	test("random ids have the documented lengths", () => {
		expect(randomBase64Url(9)).toHaveLength(12);
		expect(randomBase64Url(16)).toHaveLength(22);
	});

	test("sha256Hex is lowercase hex of the UTF-8 text", () => {
		expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	test("hashesEqual compares 32-byte digests and refuses anything else", () => {
		const hash = sha256Hex("x");
		expect(hashesEqual(hash, sha256Hex("x"))).toBe(true);
		expect(hashesEqual(hash, sha256Hex("y"))).toBe(false);
		expect(hashesEqual(hash, "")).toBe(false);
		expect(hashesEqual(hash, hash.slice(2))).toBe(false);
		expect(hashesEqual("", "")).toBe(false);
		expect(hashesEqual("zz".repeat(32), "zz".repeat(32))).toBe(false);
	});
});
