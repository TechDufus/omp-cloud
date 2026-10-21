import { describe, expect, test } from "bun:test";
import { DEFAULT_REMOTE_ALLOW, parseConfig } from "./config";

const HASH = "ab".repeat(32);

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		listen: "127.0.0.1:8080",
		apiTokenSha256: HASH,
		dataDir: "/srv/omp-cloud/data",
		vmon: { url: "http://127.0.0.1:3000", keyFile: "/etc/omp-cloud/vmon.key", template: "omp-agent" },
		gateway: { url: "http://10.254.254.1:4000", clientsFile: "/srv/omp-cloud/clients.json" },
		broker: { url: "http://127.0.0.1:8765", tokenFile: "/srv/omp-cloud/broker.token" },
		models: { default: "anthropic/claude-sonnet-5" },
		...over,
	};
}

const REMOTE = { listen: "0.0.0.0:8443", certFile: "/home/u/.config/omp-cloud/tls/cert.pem", keyFile: "/home/u/.config/omp-cloud/tls/key.pem" };

const LOOPBACK_ONLY = 'listen must be a loopback address; other machines connect through "remote" (the TLS listener)';

describe("listen is loopback only", () => {
	test.each(["127.0.0.1:8080", "127.5.6.7:8080", "localhost:8080", "[::1]:8080"])("%p is accepted", listen => {
		expect(parseConfig(raw({ listen })).listen.port).toBe(8080);
	});

	test.each(["0.0.0.0:8080", "[::]:8080", "10.0.0.42:8080", "192.168.1.5:8080", "example.com:8080", "10.254.254.1:8080"])("%p is refused", listen => {
		expect(() => parseConfig(raw({ listen }))).toThrow(LOOPBACK_ONLY);
	});
});

describe("remote", () => {
	test("is absent by default", () => {
		expect(parseConfig(raw()).remote).toBeUndefined();
	});

	test("takes any listen host and defaults allow, with no advertise", () => {
		const remote = parseConfig(raw({ remote: REMOTE })).remote;
		expect(remote).toEqual({
			listen: { hostname: "0.0.0.0", port: 8443 },
			certFile: REMOTE.certFile,
			keyFile: REMOTE.keyFile,
			allow: [...DEFAULT_REMOTE_ALLOW],
		});
		expect(remote?.advertise).toBeUndefined();
		expect(parseConfig(raw({ remote: { ...REMOTE, listen: "[::]:8443" } })).remote?.listen).toEqual({ hostname: "::", port: 8443 });
		expect(parseConfig(raw({ remote: { ...REMOTE, listen: "10.0.0.42:8443" } })).remote?.listen.hostname).toBe("10.0.0.42");
	});

	test("the default allow list is the private, CGNAT, link-local and unique-local ranges, without loopback", () => {
		expect(DEFAULT_REMOTE_ALLOW).toEqual(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "fc00::/7", "fe80::/10"]);
	});

	test("advertise and allow are kept, advertise normalized and allow replacing the default", () => {
		const remote = parseConfig(raw({ remote: { ...REMOTE, advertise: ["10.0.0.42:8443", "[fd00::1]:8443", "workstation.local:8443"], allow: ["10.0.0.0/8", "127.0.0.0/8"] } })).remote;
		expect(remote?.advertise).toEqual(["10.0.0.42:8443", "[fd00::1]:8443", "workstation.local:8443"]);
		expect(remote?.allow).toEqual(["10.0.0.0/8", "127.0.0.0/8"]);
	});

	test.each([
		[{ certFile: REMOTE.certFile, keyFile: REMOTE.keyFile }, "remote.listen is required"],
		[{ listen: REMOTE.listen, keyFile: REMOTE.keyFile }, "remote.certFile is required"],
		[{ listen: REMOTE.listen, certFile: REMOTE.certFile }, "remote.keyFile is required"],
		[{ ...REMOTE, listen: "8443" }, "remote.listen must be host:port"],
		[{ ...REMOTE, listen: "0.0.0.0:0" }, "remote.listen port"],
		[{ ...REMOTE, certFile: "cert.pem" }, "remote.certFile must be an absolute path"],
		[{ ...REMOTE, keyFile: "key.pem" }, "remote.keyFile must be an absolute path"],
		[{ ...REMOTE, certFile: 7 }, "remote.certFile must be a string"],
		[{ ...REMOTE, extra: 1 }, "remote.extra is not a known key"],
		[{ ...REMOTE, advertise: [] }, "remote.advertise must be a non-empty array"],
		[{ ...REMOTE, advertise: "10.0.0.1:8443" }, "remote.advertise must be a non-empty array"],
		[{ ...REMOTE, advertise: [7] }, "remote.advertise[0] must be a string"],
		[{ ...REMOTE, advertise: ["10.0.0.1"] }, "remote.advertise entry must be host:port"],
		[{ ...REMOTE, allow: [] }, "remote.allow must be a non-empty array"],
		[{ ...REMOTE, allow: ["10.0.0.0"] }, 'remote.allow entry "10.0.0.0" is not a CIDR range'],
		[{ ...REMOTE, allow: ["10.0.0.0/40"] }, "is not a CIDR range"],
		[{ ...REMOTE, allow: ["nope"] }, "is not a CIDR range"],
		["x", "remote must be an object"],
	])("rejects %p", (remote, message) => {
		expect(() => parseConfig(raw({ remote }))).toThrow(message);
	});
});
