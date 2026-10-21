import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "./auth/login";
import { type PairOutput, sshPair } from "./cli";
import { GitService } from "./git";
import { loadIdentity } from "./pairing/identity";
import { RemoteAccess } from "./pairing/remote";
import { sha256Hex } from "./pairing/secrets";
import { MIGRATIONS } from "./store/schema";
import { generateIdentity, type GeneratedIdentity, pairDevice } from "./pairing/test-support";
import { createApp } from "./server/app";
import { tokenSha256 } from "./server/auth";
import { isRecord } from "./guards";
import { Settings } from "./settings";
import { Store } from "./store";
import { API_VERSION, SERVICE_VERSION } from "./version";

const CLI = join(import.meta.dir, "cli.ts");
const SSH = { SSH_CONNECTION: "10.0.0.7 51234 10.0.0.2 22" };
const TOKEN_FORMAT = /^ompd_[A-Za-z0-9_-]{43}$/;

let dir: string;
let identity: GeneratedIdentity;
let store: Store;
let configPath: string;

/** What `ssh-pair` printed for a success; fails the test when it printed an error. */
function paired(output: PairOutput): Extract<PairOutput, { token: string }> {
	if ("error" in output) throw new Error(`ssh-pair failed: ${output.error}`);
	return output;
}

function failed(output: PairOutput): string {
	if (!("error" in output)) throw new Error("ssh-pair succeeded");
	return output.error;
}

async function writeConfig(remote: Record<string, unknown> | null, path = join(dir, "service.json"), dataDir = join(dir, "data")): Promise<string> {
	const config = {
		listen: "127.0.0.1:18080",
		apiTokenSha256: sha256Hex("owner-token"),
		dataDir,
		// Nothing here is contacted: the CLI must work while vmon, the gateway and the broker are down.
		vmon: { url: "http://127.0.0.1:1", keyFile: join(dir, "vmon.key"), template: "omp-agent" },
		gateway: { url: "http://127.0.0.2:2", clientsFile: join(dir, "clients.json") },
		broker: { url: "http://127.0.0.1:3", tokenFile: join(dir, "broker.token") },
		models: { default: "fake/fake-model" },
		...(remote === null ? {} : { remote }),
	};
	await Bun.write(path, JSON.stringify(config));
	return path;
}

function remoteConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		listen: "0.0.0.0:8443",
		certFile: identity.certFile,
		keyFile: identity.keyFile,
		advertise: ["10.0.0.42:8443", "workstation.local:8443"],
		allow: ["10.0.0.0/8"],
		...extra,
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-cli-"));
	identity = await generateIdentity(dir);
	// Open, like the running service, while the CLI adds devices next to it.
	store = Store.open({ dataDir: join(dir, "data") });
	configPath = await writeConfig(remoteConfig());
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

describe("omp-cloud ssh-pair", () => {
	test("pairs a device and reports the token and what the client needs to reach and pin the service", async () => {
		const out = paired(await sshPair(["--name", "work laptop", "--platform", "linux", "--config", configPath], SSH));
		expect(out.ompCloudPair).toBe(1);
		expect(out.token).toMatch(TOKEN_FORMAT);
		expect(out.device.name).toBe("work laptop");
		expect(out.service).toEqual({ version: SERVICE_VERSION, api: API_VERSION });
		expect(out.service.version).toMatch(/^\d+\.\d+\.\d+$/);

		const served = await loadIdentity(identity);
		expect(out.server.fingerprint).toBe(served.fingerprint);
		const der = Buffer.from(out.server.certificate, "base64");
		expect(der.equals(new X509Certificate(served.cert).raw)).toBe(true);
		expect(`SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/, "")}`).toBe(out.server.fingerprint);
		expect(out.server.port).toBe(8443);
		expect(out.server.addresses).toEqual(["10.0.0.42:8443", "workstation.local:8443"]);

		expect(store.device(out.device.id)).toMatchObject({ name: "work laptop", platform: "linux", owner: "owner", pairedFrom: "10.0.0.7", revokedAt: null });
		expect(store.deviceByTokenSha256(sha256Hex(out.token))?.id).toBe(out.device.id);
	});

	test("without advertise it lists the one host the listener binds, with its own port", async () => {
		const path = await writeConfig(remoteConfig({ listen: "10.1.2.3:9443", advertise: undefined }));
		const out = paired(await sshPair(["--name", "a", "--platform", "linux", "--config", path], {}));
		expect(out.server.port).toBe(9443);
		expect(out.server.addresses).toEqual(["10.1.2.3:9443"]);
	});

	test("paired_from is the client address sshd reports, SSH_CLIENT as a fallback, else `ssh`; garbage is not trusted", async () => {
		const args = ["--platform", "linux", "--config", configPath];
		const first = paired(await sshPair(["--name", "one", ...args], { SSH_CLIENT: "192.168.1.9 5555 22" }));
		const second = paired(await sshPair(["--name", "two", ...args], {}));
		const third = paired(await sshPair(["--name", "three", ...args], { SSH_CONNECTION: "<script>alert(1)</script> 1 2 3" }));
		expect([first, second, third].map(out => store.device(out.device.id)?.pairedFrom)).toEqual(["192.168.1.9", "ssh", "ssh"]);
	});

	test("the name is made unique among active devices like a pairing claim's, in both directions", async () => {
		const args = ["--platform", "linux", "--config", configPath];
		const first = paired(await sshPair(["--name", "laptop", ...args], SSH));
		const second = paired(await sshPair(["--name", "laptop", ...args], SSH));
		const claimed = pairDevice(store, { name: "laptop" });
		const third = paired(await sshPair(["--name", "laptop", ...args], SSH));
		expect([first.device.name, second.device.name, claimed.name, third.device.name]).toEqual(["laptop", "laptop-2", "laptop-3", "laptop-4"]);
		const longName = "n".repeat(64);
		paired(await sshPair(["--name", longName, ...args], SSH));
		expect([...paired(await sshPair(["--name", longName, ...args], SSH)).device.name]).toHaveLength(64);

		// A revoked device frees its name.
		store.revokeDevice(first.device.id, "owner");
		expect(paired(await sshPair(["--name", "laptop", ...args], SSH)).device.name).toBe("laptop");
	});

	test("the minted token authenticates against an App over the same store, as a device, and revoking it ends that", async () => {
		const out = paired(await sshPair(["--name", "phone", "--platform", "android", "--config", configPath], SSH));
		const app = createApp({
			store,
			apiTokenSha256: tokenSha256("owner-token"),
			dataDir: join(dir, "data"),
			models: { default: "fake/fake-model", direct: ["fake"], gateway: { providers: () => [], refresh: () => Promise.resolve() } },
			ompVersion: "18.12.3",
			logins: new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: join(dir, "broker.token") }),
			settings: Settings.load(store),
			git: await GitService.open({ dataDir: join(dir, "data"), hosts: {}, fetchTimeoutSeconds: 10, pushTimeoutSeconds: 10 }),
			remote: {
				listen: { hostname: "0.0.0.0", port: 8443 },
				fingerprint: out.server.fingerprint,
				fingerprintCode: Buffer.from(out.server.fingerprint.slice("SHA256:".length), "base64").toString("base64url"),
				access: new RemoteAccess(["10.0.0.0/8"], []),
			},
		});
		const whoami = (token: string): Promise<Response> =>
			app.fetchRemote(new Request("http://omp.test/api/v1/whoami", { headers: { Authorization: `Bearer ${token}` } }), {
				requestIP: () => ({ address: "10.0.0.7", family: "IPv4", port: 40000 }),
				timeout: () => {},
			});
		const res = await whoami(out.token);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ device: { id: out.device.id, name: "phone" } });
		expect((await whoami(`${out.token}x`)).status).toBe(401);
		store.revokeDevice(out.device.id, "owner");
		expect((await whoami(out.token)).status).toBe(401);
	});

	test("the database keeps only the token's SHA-256", async () => {
		const out = paired(await sshPair(["--name", "a", "--platform", "linux", "--config", configPath], SSH));
		for (const file of ["omp-cloud.db", "omp-cloud.db-wal"]) {
			const bytes = Buffer.from(await Bun.file(join(dir, "data", file)).arrayBuffer());
			expect(bytes.includes(out.token)).toBe(false);
			expect(bytes.includes(out.token.slice("ompd_".length))).toBe(false);
		}
		expect(store.device(out.device.id)).not.toBeNull();
	});
});

describe("omp-cloud ssh-pair refusals", () => {
	const ok = ["--name", "laptop", "--platform", "linux"];

	test("a service.json without a remote section is refused and nothing is added", async () => {
		const path = await writeConfig(null, join(dir, "no-remote.json"));
		expect(failed(await sshPair([...ok, "--config", path], SSH))).toContain('no "remote" section');
		expect(store.devices("owner")).toEqual([]);
	});

	test("an invalid name or platform is refused with the reason", async () => {
		for (const name of ["", "   ", "bad/name", "x".repeat(65), "tab\tname"]) {
			expect(failed(await sshPair(["--name", name, "--platform", "linux", "--config", configPath], SSH))).toContain("invalid name");
		}
		for (const platform of ["", "linux x", "a/b", "p".repeat(33)]) {
			expect(failed(await sshPair(["--name", "laptop", "--platform", platform, "--config", configPath], SSH))).toContain("invalid platform");
		}
		expect(store.devices("owner")).toEqual([]);
	});

	test("a key others can read, or none at all, is refused before a token exists", async () => {
		await chmod(identity.keyFile, 0o644);
		expect(failed(await sshPair([...ok, "--config", configPath], SSH))).toContain("must be readable only by its owner");
		await chmod(identity.keyFile, 0o600);
		await rm(identity.keyFile);
		expect(failed(await sshPair([...ok, "--config", configPath], SSH))).toContain("cannot read remote.keyFile");
		expect(store.devices("owner")).toEqual([]);
	});

	test("missing or unknown arguments, and an unreadable config, are errors too", async () => {
		expect(failed(await sshPair(["--name", "x", "--config", configPath], SSH))).toContain("--name and --platform are required");
		expect(failed(await sshPair([...ok, "--bogus", "1"], SSH))).toContain('unknown argument "--bogus"');
		expect(failed(await sshPair([...ok, "--name", "again", "--config", configPath], SSH))).toContain("--name given twice");
		expect(failed(await sshPair(["--platform"], SSH))).toContain("--platform needs a value");
		expect(failed(await sshPair([...ok, "--config", join(dir, "missing.json")], SSH))).toContain("cannot read config");
		expect(store.devices("owner")).toEqual([]);
	});

	test("it never migrates: a database behind or ahead of this code is refused untouched, a matching one is served", async () => {
		const expected = MIGRATIONS.length;
		const pair = (name: string): Promise<PairOutput> => sshPair(["--name", name, "--platform", "linux", "--config", configPath], SSH);
		const raw = new Database(join(dir, "data", "omp-cloud.db"));
		const version = (): number | undefined => raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
		try {
			expect(version()).toBe(expected);
			expect(paired(await pair("laptop")).device.name).toBe("laptop");

			raw.run(`PRAGMA user_version = ${expected - 1}`);
			expect(failed(await pair("behind"))).toBe(
				`the service database is at schema ${expected - 1}, this omp-cloud expects ${expected}: restart the omp-cloud service first`,
			);
			expect(version()).toBe(expected - 1);

			raw.run(`PRAGMA user_version = ${expected + 1}`);
			expect(failed(await pair("ahead"))).toBe(
				`the service database is at schema ${expected + 1}, this omp-cloud expects ${expected}: this omp-cloud checkout is older than the service; update it (git pull) first`,
			);
			expect(version()).toBe(expected + 1);
			expect(store.devices("owner").map(device => device.name)).toEqual(["laptop"]);

			raw.run(`PRAGMA user_version = ${expected}`);
			expect(paired(await pair("again")).device.name).toBe("again");
		} finally {
			raw.close();
		}
	});

	test("a service that never ran leaves no database behind", async () => {
		const path = await writeConfig(remoteConfig(), join(dir, "fresh.json"), join(dir, "never-ran"));
		expect(failed(await sshPair([...ok, "--config", path], SSH))).toContain("no omp-cloud database");
		await expect(stat(join(dir, "never-ran"))).rejects.toThrow();
	});
});

describe("omp-cloud (process)", () => {
	async function run(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
		const proc = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, OMP_CLOUD_CONFIG: configPath, ...env }, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { stdout, stderr, code };
	}

	test("success: exactly one JSON line on stdout, the token nowhere else, exit 0; the config comes from OMP_CLOUD_CONFIG", async () => {
		const { stdout, stderr, code } = await run(["ssh-pair", "--name", "proc", "--platform", "linux"], SSH);
		expect(code).toBe(0);
		expect(stdout.endsWith("\n")).toBe(true);
		const lines = stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		const parsed: unknown = JSON.parse(lines[0] ?? "");
		// The token is read before the matcher call, whose asymmetric matchers rewrite the received object in Bun 1.4.3.
		const token = isRecord(parsed) && typeof parsed.token === "string" ? parsed.token : "";
		expect(token).toMatch(TOKEN_FORMAT);
		expect(parsed).toMatchObject({ ompCloudPair: 1, device: { name: "proc" } });
		expect(stderr).not.toContain("ompd_");
		expect(store.deviceByTokenSha256(sha256Hex(token))?.name).toBe("proc");
	});

	test("failure: one error JSON line on stdout and exit 1; an unknown command too", async () => {
		const bad = await run(["ssh-pair", "--name", "bad/name", "--platform", "linux"]);
		expect(bad.code).toBe(1);
		expect(JSON.parse(bad.stdout.trimEnd())).toEqual({ ompCloudPair: 1, error: expect.stringContaining("invalid name") });
		expect(bad.stdout.trimEnd().split("\n")).toHaveLength(1);
		const unknown = await run(["frobnicate"]);
		expect(unknown.code).toBe(1);
		expect(JSON.parse(unknown.stdout.trimEnd())).toEqual({ ompCloudPair: 1, error: expect.stringContaining('unknown command "frobnicate"') });
		expect(store.devices("owner")).toEqual([]);
	});
});
