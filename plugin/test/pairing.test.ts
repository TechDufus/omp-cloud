import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { defaultDeviceName, fingerprintOf, fingerprintsMatch, isDeviceName, isLocalHost, parseConnectTarget, parsePairingCode, parseServerAddress, refusePairingCode } from "../src/pairing";
import { UserError } from "../src/types";

/** 32 bytes whose standard base64 holds both `+` and `/`, so the two encodings of a fingerprint differ. */
const DER = Buffer.from("a certificate, more or less");
const BYTES = createHash("sha256").update(DER).digest();
const STD = Buffer.alloc(32, 0xfb).toString("base64").replace(/=+$/, "");
const URL_SAFE = STD.replaceAll("+", "-").replaceAll("/", "_");

const code = (fp: string, at = "10.0.0.42:8443") => `ompc1:AbCdEfGhIjKl:s3cr3tS3cr3tS3cr3tS3cr3t:${fp}@${at}`;

describe("parsePairingCode", () => {
	test("reads offer, secret, fingerprint and every address", () => {
		const parsed = parsePairingCode(code(URL_SAFE, "10.0.0.42:8443,workstation.local:8443"));
		expect(parsed.offer).toBe("AbCdEfGhIjKl");
		expect(parsed.secret).toBe("s3cr3tS3cr3tS3cr3tS3cr3t");
		expect(parsed.fingerprint).toBe(`SHA256:${STD}`);
		expect(parsed.addresses.map(a => [a.host, a.port, a.text])).toEqual([
			["10.0.0.42", 8443, "10.0.0.42:8443"],
			["workstation.local", 8443, "workstation.local:8443"],
		]);
	});

	test("an IPv6 address is bracketed and keeps its text", () => {
		const parsed = parsePairingCode(code(URL_SAFE, "[fd00::1]:8443,[fe80::1%eth0]:9"));
		expect(parsed.addresses.map(a => [a.host, a.port, a.text])).toEqual([
			["fd00::1", 8443, "[fd00::1]:8443"],
			["fe80::1%eth0", 9, "[fe80::1%eth0]:9"],
		]);
	});

	test("one pair of surrounding quotes or backticks and surrounding whitespace are removed", () => {
		const plain = code(URL_SAFE);
		for (const wrapped of [`"${plain}"`, `'${plain}'`, `\`${plain}\``, `  ${plain}\n`, ` "${plain}" `]) {
			expect(parsePairingCode(wrapped).offer).toBe("AbCdEfGhIjKl");
		}
		expect(() => parsePairingCode(`""${plain}""`)).toThrow(UserError);
		expect(() => parsePairingCode(`"${plain}'`)).toThrow(UserError);
	});

	test("a code a terminal wrapped across lines still parses", () => {
		const plain = code(URL_SAFE);
		const wrapped = `${plain.slice(0, 30)}\n${plain.slice(30, 61)}\r\n  ${plain.slice(61)}`;
		expect(parsePairingCode(wrapped)).toEqual(parsePairingCode(plain));
	});

	test("the fingerprint is accepted as base64url or as standard base64 and means the same", () => {
		const a = parsePairingCode(code(URL_SAFE));
		const b = parsePairingCode(code(STD));
		expect(STD).not.toBe(URL_SAFE);
		expect(a.fingerprint).toBe(b.fingerprint);
		expect(fingerprintsMatch(a.fingerprint, URL_SAFE)).toBe(true);
		expect(fingerprintsMatch(b.fingerprint, STD)).toBe(true);
	});

	test.each([
		["no @", "ompc1:AbCdEfGhIjKl:s3cr3t:" + URL_SAFE],
		["wrong marker", code(URL_SAFE).replace("ompc1", "ompc2")],
		["too few parts", `ompc1:AbCdEfGhIjKl:${URL_SAFE}@10.0.0.1:1`],
		["too many parts (a SHA256: prefix)", code(`SHA256:${STD}`)],
		["short fingerprint", code(URL_SAFE.slice(0, 42))],
		["fingerprint with padding", code(`${URL_SAFE.slice(0, 42)}=`)],
		["no address", code(URL_SAFE, "")],
		["empty address in a list", code(URL_SAFE, "10.0.0.1:8443,")],
		["port 0", code(URL_SAFE, "10.0.0.1:0")],
		["port too large", code(URL_SAFE, "10.0.0.1:65536")],
		["port not a number", code(URL_SAFE, "10.0.0.1:https")],
		["no port", code(URL_SAFE, "10.0.0.1")],
		["unbracketed IPv6", code(URL_SAFE, "fd00::1:8443")],
		["bracketed non-IPv6", code(URL_SAFE, "[10.0.0.1]:8443")],
		["a path in the host", code(URL_SAFE, "10.0.0.1/x:8443")],
		["a numeric-looking name that is no address", code(URL_SAFE, "10.0.1:8443")],
		["a hex integer host", code(URL_SAFE, "0x5db8d822:8443")],
		["a decimal integer host", code(URL_SAFE, "1572395042:8443")],
		["a dotted hex host", code(URL_SAFE, "0x5d.0xb8.0xd8.0x22:8443")],
		["a dotted octal host", code(URL_SAFE, "0135.0270.0330.042:8443")],
		["a leading-zero dotted quad", code(URL_SAFE, "010.0.0.1:8443")],
		["a mixed-radix host", code(URL_SAFE, "93.0xb8d822:8443")],
		["a second @", code(URL_SAFE, "user@10.0.0.1:8443")],
		["too many addresses", code(URL_SAFE, Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}:1`).join(","))],
		["empty", ""],
		["a space inside a quoted part", `"${code(URL_SAFE)}" x`],
	])("rejects %s", (_name, input) => {
		expect(() => parsePairingCode(input)).toThrow(UserError);
	});

	test("a rejection never quotes the code", () => {
		try {
			parsePairingCode(code(URL_SAFE, "10.0.0.1:0"));
			throw new Error("not rejected");
		} catch (e) {
			expect((e as Error).message).not.toContain("s3cr3t");
			expect((e as Error).message).not.toContain("AbCdEfGhIjKl");
		}
	});
});

describe("fingerprints", () => {
	test("fingerprintOf is SHA256: and the unpadded standard base64 of the DER's SHA-256", () => {
		expect(fingerprintOf(DER)).toBe(`SHA256:${BYTES.toString("base64").replace(/=+$/, "")}`);
		expect(fingerprintOf(DER)).not.toContain("=");
	});

	test("either encoding, with or without the prefix, matches; another certificate does not", () => {
		const fp = fingerprintOf(DER);
		const other = fingerprintOf(Buffer.from("another"));
		const safe = fp.slice(7).replaceAll("+", "-").replaceAll("/", "_");
		expect(fingerprintsMatch(fp, safe)).toBe(true);
		expect(fingerprintsMatch(safe, fp)).toBe(true);
		expect(fingerprintsMatch(fp, fp.slice(7))).toBe(true);
		expect(fingerprintsMatch(fp, other)).toBe(false);
		expect(fingerprintsMatch(fp, fp.slice(0, -1))).toBe(false);
		expect(fingerprintsMatch(fp, "")).toBe(false);
	});
});

describe("addresses", () => {
	test("parseServerAddress", () => {
		expect(parseServerAddress("host.example:8443")).toEqual({ host: "host.example", port: 8443, text: "host.example:8443" });
		expect(parseServerAddress("[::1]:1")?.host).toBe("::1");
		for (const bad of ["", ":8443", "host", "host:", "[::1]", "a b:1", "host:65536", "[host]:1"]) expect(parseServerAddress(bad)).toBeUndefined();
	});

	test.each([
		"127.0.0.1",
		"127.5.5.5",
		"localhost",
		"app.localhost",
		"10.0.0.42",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.20",
		"100.64.0.1",
		"100.127.255.255",
		"169.254.3.4",
		"::1",
		"[::1]",
		"fd00::1",
		"fc00::5",
		"fe80::1",
		"fe80::1%eth0",
		"febf::1",
		"::ffff:10.0.0.1",
		"::ffff:7f00:1",
		"workstation",
		"workstation.local",
		"nas.lan",
		"router.home.arpa",
		"svc.internal",
		"Workstation.LOCAL",
		"workstation.local.",
	])("%s is local", host => {
		expect(isLocalHost(host)).toBe(true);
	});

	test.each([
		"8.8.8.8",
		"172.15.0.1",
		"172.32.0.1",
		"192.169.0.1",
		"100.63.255.255",
		"100.128.0.1",
		"169.253.0.1",
		"203.0.113.7",
		"2001:db8::1",
		"fec0::1",
		"::ffff:8.8.8.8",
		"example.com",
		"a.b.example.org",
		"locally.example",
		"x.localhost.evil.com",
	])("%s needs --allow-public", host => {
		expect(isLocalHost(host)).toBe(false);
	});
});

describe("launch text", () => {
	test("a pairing code anywhere in a text is refused with the contract message, in any case", () => {
		for (const text of [`fix this ${code(URL_SAFE)}`, "OMPC1:x", "see ompc1:abc"]) {
			expect(() => refusePairingCode(text)).toThrow("that looks like a pairing code; use /cloud connect");
		}
		expect(() => refusePairingCode("add pairing support", undefined, "")).not.toThrow();
	});
});

describe("device names", () => {
	test("1–64 letters, digits, spaces, dots, underscores and dashes", () => {
		for (const ok of ["laptop", "My Laptop", "mac-mini_2.local", "Büro-Rechner", "x".repeat(64)]) expect(isDeviceName(ok)).toBe(true);
		for (const bad of ["", "   ", "x".repeat(65), "a/b", "a;b", "a\nb", "<b>"]) expect(isDeviceName(bad)).toBe(false);
	});

	test("the default name is the host name made valid", () => {
		expect(defaultDeviceName("workstation")).toBe("workstation");
		expect(defaultDeviceName("my/host:1")).toBe("my-host-1");
		expect(defaultDeviceName("   ")).toBe("omp-device");
		expect(isDeviceName(defaultDeviceName("x".repeat(100)))).toBe(true);
	});
});

describe("parseConnectTarget", () => {
	test.each([
		["me@nas.local", "me@nas.local", undefined],
		["nas", "nas", undefined],
		["nas.lan", "nas.lan", undefined],
		["my_alias", "my_alias", undefined],
		["10.0.0.5", "10.0.0.5", undefined],
		["root@10.0.0.5", "root@10.0.0.5", undefined],
		["john.doe@nas", "john.doe@nas", undefined],
		["me@fd00::1", "me@fd00::1", undefined],
		["ssh://nas", "nas", undefined],
		["ssh://me@nas.local", "me@nas.local", undefined],
		["ssh://me@nas.local:2222", "me@nas.local", 2222],
		["SSH://nas:22/", "nas", 22],
		["ssh://me@[fd00::1]:2222", "me@fd00::1", 2222],
		["ssh://[fd00::1]", "fd00::1", undefined],
		["me@[fd00::1]", "me@fd00::1", undefined],
		["  'me@nas'  ", "me@nas", undefined],
		['"ssh://nas:2200"', "nas", 2200],
	])("%s is an ssh target for %s, port %p", (input, destination, port) => {
		expect(parseConnectTarget(input)).toEqual({ kind: "ssh", ssh: { destination, port } });
	});

	test("a pairing code is told from a target, quoted or padded, and parsed", () => {
		const text = code(URL_SAFE);
		for (const typed of [text, `'${text}'`, `  ${text}\n`]) {
			const parsed = parseConnectTarget(typed);
			expect(parsed.kind === "code" ? parsed.code.offer : "").toBe("AbCdEfGhIjKl");
		}
		// Marker but not a code: the code's own error, never an ssh attempt at "ompc1:…".
		expect(() => parseConnectTarget("ompc1:broken")).toThrow("not a pairing code");
	});

	test.each(["-oProxyCommand=evil", "-p", "--", "  -x", '"-oProxyCommand=evil"', "ssh://-oProxy@nas", "-me@nas"])("%s is refused: ssh would read it as an option", input => {
		expect(() => parseConnectTarget(input)).toThrow(UserError);
	});

	test("the refusal of a leading '-' says so; it is not the generic message", () => {
		expect(() => parseConnectTarget("-oProxyCommand=evil")).toThrow("cannot start with '-'");
	});

	test.each([
		"",
		"   ",
		"two words",
		"nas:8443",
		"10.0.0.5:8443",
		"@nas",
		"me@",
		"me@@nas",
		"a@b@c",
		"me@na s",
		"me@nas;reboot",
		"me@nas$(id)",
		"me@`id`",
		"nas\nreboot",
		"nas/path",
		"ssh://",
		"ssh://nas/path",
		"ssh://nas:0",
		"ssh://nas:65536",
		"ssh://nas:abc",
		"ssh://me@@nas",
		"ssh://nas?x=1",
		"::1",
		"[::1]",
		"me@fd00:::1",
		"me@-nas",
		"bad user@nas",
		"'me@nas",
	])("%j is neither a code nor a target, and the message names the forms", input => {
		expect(() => parseConnectTarget(input)).toThrow("ssh://[user@]host[:port]");
	});
});
