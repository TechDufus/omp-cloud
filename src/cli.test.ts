import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "./auth/login";
import { type NodeJoinOptions, type NodeJoinOutput, nodeJoinInfo, type PairOutput, sshPair } from "./cli";
import { GitService } from "./git";
import { loadIdentity, spkiPin } from "./pairing/identity";
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
import { type ClusterNode, type ClusterView, VmonAdminRefused } from "./vmon/admin";

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

/** The pin as `openssl` computes it, the way the plan's curl check does. */
async function opensslPin(certFile: string): Promise<string> {
	const script = `openssl x509 -in '${certFile}' -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64 -w0`;
	const proc = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) throw new Error("openssl could not compute the pin");
	return `sha256//${out.trim()}`;
}

describe("spkiPin", () => {
	test("is sha256// and the base64 SHA-256 of the certificate's SPKI DER, as openssl computes it", async () => {
		const pin = spkiPin(await Bun.file(identity.certFile).text());
		expect(pin).toMatch(/^sha256\/\/[A-Za-z0-9+/]{43}=$/);
		expect(pin).toBe(await opensslPin(identity.certFile));
	});
});

describe("omp-cloud node-join-info", () => {
	const SECRET = "cluster-secret-0123456789abcdef";
	let secretFile: string;
	let tokenFile: string;

	function node(extra: Partial<ClusterNode>): ClusterNode {
		return { id: "n1", hostname: "box", addrs: ["192.168.1.20"], alive: true, status: "ready", version: "0.4.0", server: false, cpus: 4, vcpusUsed: 0, memoryMB: 8192, memoryUsedMB: 0, diskFreeMB: 10000, sandboxes: 0, ...extra };
	}

	/** A service.json that takes machines; `vmon` keys and `remote` can be changed or dropped (`null`). */
	async function nodeConfig(options: { vmon?: Record<string, unknown>; remote?: Record<string, unknown> | null } = {}): Promise<string> {
		const path = join(dir, "node-service.json");
		const config = {
			listen: "127.0.0.1:18080",
			apiTokenSha256: sha256Hex("owner-token"),
			dataDir: join(dir, "no-database-here"),
			vmon: { url: "http://127.0.0.1:1", keyFile: join(dir, "vmon.key"), template: "omp-agent", clusterAddress: "192.168.1.10", clusterSecretFile: secretFile, adminTokenFile: tokenFile, ...options.vmon },
			gateway: { url: "http://127.0.0.2:2", clientsFile: join(dir, "clients.json") },
			broker: { url: "http://127.0.0.1:3", tokenFile: join(dir, "broker.token") },
			models: { default: "fake/fake-model" },
			...(options.remote === null ? {} : { remote: options.remote ?? remoteConfig({ listen: "0.0.0.0:8444" }) }),
		};
		await Bun.write(path, JSON.stringify(config));
		return path;
	}

	/** The seams, with a clock that only the fake sleep moves; `views` is what vibemon answers per look (the last repeats). */
	function seams(views: (ClusterView | Error)[], installed: string | null = "v0.4.0") {
		const state = { now: 0, looks: 0, sleeps: [] as number[], opened: [] as { url: string; tokenFile: string }[] };
		const options: NodeJoinOptions = {
			installedVmon: async () => installed,
			openAdmin: async (open) => {
				state.opened.push(open);
				return {
					cluster: async () => {
						const view = views[Math.min(state.looks++, views.length - 1)];
						if (view === undefined || view instanceof Error) throw view ?? new Error("no view");
						return view;
					},
				};
			},
			now: () => state.now,
			sleep: async (ms) => {
				state.sleeps.push(ms);
				state.now += ms;
			},
		};
		return { state, options };
	}

	function view(...nodes: ClusterNode[]): ClusterView {
		return { localId: "server", nodes, history: [] };
	}

	function nodeFailed(output: NodeJoinOutput): string {
		if (!("error" in output)) throw new Error(`node-join-info succeeded: ${JSON.stringify(output)}`);
		return output.error;
	}

	beforeEach(async () => {
		secretFile = join(dir, "vmon-cluster.secret");
		tokenFile = join(dir, "vmon-admin.token");
		await Bun.write(secretFile, `  ${SECRET}\n`);
		await Bun.write(tokenFile, "admin-token\n");
	});

	test("reports the server's address, remote port, certificate pin and versions, and vibemon's join address, version and cluster secret", async () => {
		const path = await nodeConfig();
		const out = await nodeJoinInfo(["--config", path], {}, seams([], "v0.4.0").options);
		expect(out).toEqual({
			ompCloudNode: 1,
			server: { address: "192.168.1.10", remotePort: 8444, pin: await opensslPin(identity.certFile), version: SERVICE_VERSION },
			vmon: { version: "v0.4.0", join: "192.168.1.10:7946", clusterSecret: SECRET },
		});
	});

	test("reads the config from OMP_CLOUD_CONFIG, opens no store and contacts nothing", async () => {
		const path = await nodeConfig();
		const { state, options } = seams([]);
		const out = await nodeJoinInfo([], { OMP_CLOUD_CONFIG: path }, options);
		expect("server" in out).toBe(true);
		expect(state.opened).toEqual([]);
		await expect(stat(join(dir, "no-database-here"))).rejects.toThrow();
	});

	describe("refusals", () => {
		test("a server without cluster keys does not take machines", async () => {
			const path = await writeConfig(remoteConfig());
			expect(nodeFailed(await nodeJoinInfo(["--config", path], {}, seams([]).options))).toBe(
				"this server does not take vibemon machines: run omp-cloud setup --cluster-address <its LAN address> on it first",
			);
		});

		test("a server without a remote listener cannot be pinned", async () => {
			const path = await nodeConfig({ remote: null });
			expect(nodeFailed(await nodeJoinInfo(["--config", path], {}, seams([]).options))).toBe("the server has no remote listener: run omp-cloud setup on it");
		});

		test("vibemon that is not installed is refused", async () => {
			const path = await nodeConfig();
			expect(nodeFailed(await nodeJoinInfo(["--config", path], {}, seams([], null).options))).toBe("vibemon is not installed on the server");
		});

		test("--member without an admin token file is refused, before vibemon is asked", async () => {
			const path = await nodeConfig({ vmon: { adminTokenFile: undefined } });
			const { state, options } = seams([view(node({}))]);
			expect(nodeFailed(await nodeJoinInfo(["--config", path, "--member", "192.168.1.20"], {}, options))).toBe(
				"this server has no vibemon admin token yet: run omp-cloud setup on it",
			);
			expect(state.opened).toEqual([]);
			// Without --member the token is not needed.
			expect("server" in (await nodeJoinInfo(["--config", path], {}, seams([]).options))).toBe(true);
		});

		test("the checks run in order: cluster keys, remote, vibemon, admin token", async () => {
			const noKeys = await writeConfig(null);
			expect(nodeFailed(await nodeJoinInfo(["--config", noKeys, "--member", "192.168.1.20"], {}, seams([], null).options))).toContain("does not take vibemon machines");
			const noRemote = await nodeConfig({ remote: null, vmon: { adminTokenFile: undefined } });
			expect(nodeFailed(await nodeJoinInfo(["--config", noRemote, "--member", "192.168.1.20"], {}, seams([], null).options))).toContain("no remote listener");
			const noVmon = await nodeConfig({ vmon: { adminTokenFile: undefined } });
			expect(nodeFailed(await nodeJoinInfo(["--config", noVmon, "--member", "192.168.1.20"], {}, seams([], null).options))).toBe("vibemon is not installed on the server");
		});

		test("an unreadable cluster secret file or certificate is an error naming the file, never a secret", async () => {
			const gone = await nodeConfig({ vmon: { clusterSecretFile: join(dir, "absent.secret") } });
			expect(nodeFailed(await nodeJoinInfo(["--config", gone], {}, seams([]).options))).toBe(`cannot read vmon.clusterSecretFile ${join(dir, "absent.secret")}: ENOENT`);
			const noCert = await nodeConfig({ remote: remoteConfig({ listen: "0.0.0.0:8444", certFile: join(dir, "absent.pem") }) });
			expect(nodeFailed(await nodeJoinInfo(["--config", noCert], {}, seams([]).options))).toBe(`cannot read remote.certFile ${join(dir, "absent.pem")}: ENOENT`);
		});

		test("a missing config is an error line, not a throw", async () => {
			expect(nodeFailed(await nodeJoinInfo(["--config", join(dir, "nope.json")], {}, seams([]).options))).not.toBe("");
		});

		test("bad flags are error lines with the usage", async () => {
			const path = await nodeConfig();
			const options = seams([]).options;
			expect(nodeFailed(await nodeJoinInfo(["--frobnicate"], {}, options))).toContain('unknown argument "--frobnicate"; usage: omp-cloud node-join-info');
			expect(nodeFailed(await nodeJoinInfo(["--config"], {}, options))).toContain("--config needs a value");
			expect(nodeFailed(await nodeJoinInfo(["--config", path, "--config", path], {}, options))).toContain("--config given twice");
			expect(nodeFailed(await nodeJoinInfo(["--config", path, "--member", "box.lan"], {}, options))).toContain("--member must be an IPv4 address");
			expect(nodeFailed(await nodeJoinInfo(["--config", path, "--member", "fe80::1"], {}, options))).toContain("--member must be an IPv4 address");
		});
	});

	describe("--member", () => {
		const IP = "192.168.1.20";

		test("a machine the server's vibemon already sees is reported at once, from the admin API at the configured url and token file", async () => {
			const path = await nodeConfig();
			const { state, options } = seams([view(node({ id: "server", hostname: "srv", addrs: ["192.168.1.10"], server: true }), node({ hostname: "laptop-2", version: "0.4.1", status: "ready" }))]);
			const out = await nodeJoinInfo(["--config", path, "--member", IP], {}, options);
			expect(out).toEqual({ ompCloudNode: 1, member: { hostname: "laptop-2", status: "ready", version: "0.4.1" } });
			expect(state.opened).toEqual([{ url: "http://127.0.0.1:1", tokenFile }]);
			expect(state.sleeps).toEqual([]);
		});

		test("a machine that appears after a few looks is found; the poll is every 2 s", async () => {
			const path = await nodeConfig();
			const { state, options } = seams([view(), view(), view(node({ id: "other", addrs: ["192.168.1.99"] })), view(node({ hostname: "late" }))]);
			const out = await nodeJoinInfo(["--config", path, "--member", IP], {}, options);
			expect(out).toEqual({ ompCloudNode: 1, member: { hostname: "late", status: "ready", version: "0.4.0" } });
			expect(state.looks).toBe(4);
			expect(state.sleeps).toEqual([2000, 2000, 2000]);
		});

		test("a machine never seen is an error after 60 s, looked for every 2 s", async () => {
			const path = await nodeConfig();
			const { state, options } = seams([view(node({ addrs: ["192.168.1.99"] }))]);
			expect(nodeFailed(await nodeJoinInfo(["--config", path, "--member", IP], {}, options))).toBe(`the server's vibemon has not seen a machine at ${IP} within 60 s`);
			expect(state.now).toBe(60_000);
			expect(state.looks).toBe(31);
			expect(new Set(state.sleeps)).toEqual(new Set([2000]));
		});

		test("vibemon's gossip addresses carry a port, a mask or brackets: the host part is what matches, and only whole hosts", async () => {
			const path = await nodeConfig();
			for (const addr of [`${IP}:7946`, `${IP}/24`, `[${IP}]:7946`]) {
				const { options } = seams([view(node({ hostname: "ported", addrs: ["192.168.1.200:7946", addr] }))]);
				expect(await nodeJoinInfo(["--config", path, "--member", IP], {}, options)).toEqual({ ompCloudNode: 1, member: { hostname: "ported", status: "ready", version: "0.4.0" } });
			}
			const { options } = seams([view(node({ addrs: ["192.168.1.200:7946", "192.168.1.2:7946", "x192.168.1.20:7946"] }))]);
			expect(nodeFailed(await nodeJoinInfo(["--config", path, "--member", IP], {}, options))).toContain("has not seen a machine at");
		});

		test("a dead, suspect or left machine at that address is not accepted", async () => {
			const path = await nodeConfig();
			for (const status of ["dead", "suspect", "left"]) {
				const { options } = seams([view(node({ alive: false, status }))]);
				expect(nodeFailed(await nodeJoinInfo(["--config", path, "--member", IP], {}, options))).toContain("has not seen a machine at");
			}
		});

		test("a machine that was dead and comes alive is found", async () => {
			const path = await nodeConfig();
			const { options } = seams([view(node({ alive: false, status: "suspect" })), view(node({ hostname: "back" }))]);
			expect(await nodeJoinInfo(["--config", path, "--member", IP], {}, options)).toMatchObject({ member: { hostname: "back" } });
		});

		test("vibemon that does not answer for a moment is waited for; one that never answers is named in the error", async () => {
			const path = await nodeConfig();
			const flaky = seams([new Error("connection refused"), view(node({ hostname: "up" }))]);
			expect(await nodeJoinInfo(["--config", path, "--member", IP], {}, flaky.options)).toMatchObject({ member: { hostname: "up" } });
			const down = seams([new Error("connection refused")]);
			expect(nodeFailed(await nodeJoinInfo(["--config", path, "--member", IP], {}, down.options))).toBe("the server's vibemon did not answer: connection refused");
		});

		test("a refused admin token stops the wait at once", async () => {
			const path = await nodeConfig();
			const { state, options } = seams([new VmonAdminRefused(tokenFile)]);
			expect(nodeFailed(await nodeJoinInfo(["--config", path, "--member", IP], {}, options))).toContain(tokenFile);
			expect(state.looks).toBe(1);
		});

		test("an admin token file that is missing is an error naming the file, not the token", async () => {
			const path = await nodeConfig({ vmon: { adminTokenFile: join(dir, "absent.token") } });
			const out = await nodeJoinInfo(["--config", path, "--member", IP, "--member", IP], {}, seams([]).options);
			expect(nodeFailed(out)).toContain("--member given twice");
			const real = await nodeJoinInfo(["--config", path, "--member", IP], {}, { installedVmon: async () => "v0.4.0" });
			expect(nodeFailed(real)).toBe(`cannot read the vibemon admin token file ${join(dir, "absent.token")}`);
		});

		test("the cluster secret is not read for --member", async () => {
			const path = await nodeConfig({ vmon: { clusterSecretFile: join(dir, "absent.secret") } });
			const { options } = seams([view(node({}))]);
			expect(await nodeJoinInfo(["--config", path, "--member", IP], {}, options)).toMatchObject({ member: { hostname: "box" } });
		});
	});

	describe("(process)", () => {
		async function run(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
			const proc = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, OMP_CLOUD_CONFIG: configPath, ...env }, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			return { stdout, stderr, code };
		}

		test("an error is one {ompCloudNode: 1, error} line on stdout and exit 1", async () => {
			const out = await run(["node-join-info"]);
			expect(out.code).toBe(1);
			expect(out.stdout.trimEnd().split("\n")).toHaveLength(1);
			expect(JSON.parse(out.stdout.trimEnd())).toEqual({ ompCloudNode: 1, error: expect.stringContaining("does not take vibemon machines") });
		});

		test("the secret is on the last stdout line only, when vibemon is installed", async () => {
			const out = await run(["node-join-info", "--config", await nodeConfig()]);
			const parsed: unknown = JSON.parse(out.stdout.trimEnd().split("\n").at(-1) ?? "");
			if (isRecord(parsed) && "error" in parsed) {
				// No vibemon installed on this machine: the only acceptable failure, and it carries no secret.
				expect(parsed.error).toBe("vibemon is not installed on the server");
				expect(out.code).toBe(1);
			} else {
				expect(out.code).toBe(0);
				expect(parsed).toMatchObject({ ompCloudNode: 1, vmon: { clusterSecret: SECRET } });
			}
			expect(out.stdout.trimEnd().split("\n")).toHaveLength(1);
			expect(out.stderr).not.toContain(SECRET);
		});
	});
});
