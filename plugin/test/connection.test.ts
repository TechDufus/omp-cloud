import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readConnectionFile, writeConnectionFile, type PairedConnection } from "../src/connection";
import { UserError } from "../src/types";
import { cleanup, tmp } from "./helpers";
import { deviceToken, makeCert, type TestCert } from "./tls";

afterEach(cleanup);

let cert: TestCert;
beforeAll(async () => {
	cert = await makeCert();
});
afterAll(cleanup);

function record(over: Partial<PairedConnection> = {}): PairedConnection {
	return {
		server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses: ["10.0.0.42:8443", "workstation.local:8443"] },
		device: { id: "dev12345abcdef", name: "laptop" },
		token: deviceToken(),
		pairedAt: "2026-10-20T00:00:00.000Z",
		...over,
	};
}

async function target(): Promise<string> {
	return join(await tmp("omp-cloud-conn-"), "omp-cloud", "connection.json");
}

const message = async (p: Promise<unknown>): Promise<string> => {
	const err = await p.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(UserError);
	return (err as UserError).message;
};

describe("writeConnectionFile", () => {
	test("writes the contract's JSON at mode 0600 in a directory made 0700, and reads it back", async () => {
		const file = await target();
		const c = record();
		await writeConnectionFile(file, c);

		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
		const json: unknown = JSON.parse(await readFile(file, "utf8"));
		expect(json).toEqual({
			version: 1,
			server: { fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), addresses: ["10.0.0.42:8443", "workstation.local:8443"] },
			device: { id: "dev12345abcdef", name: "laptop" },
			token: c.token,
			pairedAt: "2026-10-20T00:00:00.000Z",
		});
		expect(await readConnectionFile(file)).toEqual(c);
	});

	test("an existing config directory that is open to others is tightened to 0700", async () => {
		const file = await target();
		await mkdir(dirname(file), { recursive: true, mode: 0o755 });
		await chmod(dirname(file), 0o755);
		expect((await stat(dirname(file))).mode & 0o777).toBe(0o755);
		await writeConnectionFile(file, record());
		expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	test("goes through a temp file: no temp is left, and a replacement is whole", async () => {
		const file = await target();
		await writeConnectionFile(file, record());
		const second = record({ device: { id: "other-id", name: "desktop" } });
		await writeConnectionFile(file, second);
		expect(await readdir(dirname(file))).toEqual(["connection.json"]);
		expect((await readConnectionFile(file))?.device.name).toBe("desktop");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	test("a record that would not read back is refused before anything is written, and the old file stays", async () => {
		const file = await target();
		const good = record();
		await writeConnectionFile(file, good);
		await message(writeConnectionFile(file, record({ token: "not-a-device-token" })));
		expect(await readdir(dirname(file))).toEqual(["connection.json"]);
		expect(await readConnectionFile(file)).toEqual(good);
	});
});

describe("readConnectionFile", () => {
	test("no file is no connection", async () => {
		expect(await readConnectionFile(await target())).toBeUndefined();
	});

	test("a file that is group- or world-readable is refused (POSIX)", async () => {
		const file = await target();
		await writeConnectionFile(file, record());
		await chmod(file, 0o644);
		expect(await message(readConnectionFile(file))).toContain("readable by other users");
		await chmod(file, 0o640);
		expect(await message(readConnectionFile(file))).toContain("readable by other users");
	});

	/** The record as JSON, changed by `mutate`, written 0600. */
	async function broken(mutate: (o: Record<string, unknown>) => void): Promise<string> {
		const file = await target();
		await writeConnectionFile(file, record());
		const o = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		mutate(o);
		await writeFile(file, JSON.stringify(o), { mode: 0o600 });
		return file;
	}

	test.each<[string, (o: Record<string, unknown>) => void]>([
		["version", o => void (o.version = 2)],
		["an unknown key", o => void (o.extra = 1)],
		["a missing server", o => void delete o.server],
		["a token of the wrong shape", o => void (o.token = "ompd_short")],
		["an owner-style token", o => void (o.token = "a".repeat(64))],
		["a missing device id", o => void ((o.device as Record<string, unknown>).id = "")],
		["a bad pairedAt", o => void (o.pairedAt = "yesterday")],
		["a certificate that is not base64", o => void ((o.server as Record<string, unknown>).certificate = "%%%")],
		["a certificate that is not a certificate", o => void ((o.server as Record<string, unknown>).certificate = Buffer.from("hello").toString("base64"))],
		["a fingerprint of another certificate", o => void ((o.server as Record<string, unknown>).fingerprint = `SHA256:${"A".repeat(43)}`)],
		["no addresses", o => void ((o.server as Record<string, unknown>).addresses = [])],
		["an address that is not host:port", o => void ((o.server as Record<string, unknown>).addresses = ["10.0.0.1"])],
		["an unknown server key", o => void ((o.server as Record<string, unknown>).trust = "system")],
	])("fails closed on %s, naming the file and never the token", async (_name, mutate) => {
		const file = await broken(mutate);
		const text = await message(readConnectionFile(file));
		expect(text).toContain(file);
		expect(text).toContain("not a valid connection record");
		expect(text).not.toMatch(/ompd_[A-Za-z0-9_-]{20}/);
	});

	test("something that is not JSON fails closed", async () => {
		const file = await target();
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, "{ nope", { mode: 0o600 });
		expect(await message(readConnectionFile(file))).toContain("not JSON");
	});
});
