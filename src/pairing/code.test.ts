import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fingerprintBytes, formatPairingCode, parsePairingCode } from "./code";
import { fingerprintsOf } from "./identity";

const FP = "x".repeat(43);
const CODE = { offerId: "abcDEF123_-9", secret: "s".repeat(22), fingerprint: FP, addresses: ["10.0.0.42:8443", "[fd00::1]:8443", "host.local:8443"] };

describe("pairing code", () => {
	test("formats as ompc1:<offer>:<secret>:<fingerprint>@<addresses>", () => {
		expect(formatPairingCode(CODE)).toBe(`ompc1:${CODE.offerId}:${CODE.secret}:${FP}@10.0.0.42:8443,[fd00::1]:8443,host.local:8443`);
	});

	test("parses what it formats, IPv6 addresses included", () => {
		expect(parsePairingCode(formatPairingCode(CODE))).toEqual(CODE);
	});

	test("trims and strips one pair of surrounding quotes or backticks", () => {
		const code = formatPairingCode(CODE);
		for (const wrapped of [`  ${code}\n`, `"${code}"`, `'${code}'`, `\`${code}\``, ` "${code}" `]) {
			expect(parsePairingCode(wrapped)).toEqual(CODE);
		}
		expect(parsePairingCode(`""${code}""`)).toBeNull();
	});

	test.each([
		"",
		"ompc1",
		`ompc2:a:b:${FP}@h:1`,
		`ompc1:a:b@h:1`,
		`ompc1:a:b:c:d@h:1`,
		`ompc1::b:${FP}@h:1`,
		`ompc1:a:b:${FP}`,
		`ompc1:a:b:${FP}@`,
		`ompc1:a:b:${FP}@h:1,,g:2`,
	])("refuses %p", text => {
		expect(parsePairingCode(text)).toBeNull();
	});

	test("splits at the first @", () => {
		expect(parsePairingCode(`ompc1:a:b:${FP}@h:1@x`)?.addresses).toEqual(["h:1@x"]);
	});
});

describe("fingerprints", () => {
	const digest = createHash("sha256").update("certificate der").digest();
	const { fingerprint, fingerprintCode } = fingerprintsOf(digest);

	test("the display form is SHA256: and unpadded standard base64, the code form unpadded base64url", () => {
		expect(fingerprint).toBe(`SHA256:${digest.toString("base64").replace(/=+$/, "")}`);
		expect(fingerprint).not.toContain("=");
		expect(fingerprintCode).toBe(digest.toString("base64url"));
		expect(fingerprintCode).toHaveLength(43);
	});

	test("either spelling gives the same 32 bytes", () => {
		expect(fingerprintBytes(fingerprint)).toEqual(digest);
		expect(fingerprintBytes(fingerprintCode)).toEqual(digest);
	});

	test("anything else is not a fingerprint", () => {
		expect(fingerprintBytes("")).toBeNull();
		expect(fingerprintBytes("SHA256:short")).toBeNull();
		expect(fingerprintBytes(`${fingerprintCode}=`)).toBeNull();
		expect(fingerprintBytes(`MD5:${fingerprintCode}`)).toBeNull();
	});
});
