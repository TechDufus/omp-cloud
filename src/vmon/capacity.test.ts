import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, parseConfig } from "../config";
import { parseCluster, parseTeam, VmonAdmin, VmonAdminRefused, VmonAdminUnavailable } from "./admin";
import { capacityReport, readCapacity } from "./capacity";

const TOKEN = "admin-token-for-tests";
const BASE_TS = Date.UTC(2026, 9, 1, 12, 0, 17);

function member(id: string, hostname: string, state: string, version: string, node: Record<string, unknown> | null, roles = { node: true, driver: false }) {
	return { id, hostname, addrs: [`10.0.0.${id.length}:7946`], state, roles, version, ...(node === null ? {} : { node }) };
}

const CLUSTER = {
	clusterID: "c1",
	localID: "srv",
	members: [
		member("n2", "node-b", "dead", "0.3.2", null),
		member("srv", "omp-server", "alive", "0.4.0", { status: "ready", cpus: 16, vcpusUsed: 6, memoryMB: 65536, memoryUsedMB: 24576, diskFreeMB: 100_000, sandboxes: 3 }, { node: true, driver: true }),
		member("n1", "node-a", "alive", "0.4.0", { status: "ready", cpus: 8, vcpusUsed: 2, memoryMB: 32768, memoryUsedMB: 8192, diskFreeMB: 50_000, sandboxes: 1 }),
		{ id: "x", hostname: "driver-only", addrs: [], state: "alive", roles: { node: false, driver: true }, version: "0.4.0" },
	],
	history: Array.from({ length: 720 }, (_, index) => ({
		ts: BASE_TS + index * 5000,
		nodes: 2,
		sandboxes: index,
		builds: 0,
		vcpus: 24,
		vcpusUsed: index % 24,
		memoryMB: 98304,
		memoryUsedMB: 1024 * (index % 24),
		starts: 0,
	})),
};

const TEAMS = [
	{ teamID: "t0", slug: "system", limits: { maxConcurrentSandboxes: 1 }, sandboxes: { running: 0, paused: 0 } },
	{ teamID: "t1", slug: "omp-cloud", limits: { maxConcurrentSandboxes: 32 }, sandboxes: { running: 4, paused: 2 } },
];

describe("capacityReport", () => {
	const report = capacityReport({ cluster: parseCluster(CLUSTER), team: parseTeam(TEAMS, "omp-cloud"), clusterAddress: "192.168.1.20", user: "owner" });

	test("only alive node members count toward the totals; dead and non-node members do not", () => {
		expect(report.available).toBe(true);
		expect(report.problem).toBe("");
		expect(report.vcpus).toEqual({ total: 24, allocated: 8 });
		expect(report.memoryMB).toEqual({ total: 98304, allocated: 32768 });
		expect(report.diskFreeMB).toBe(150_000);
		expect(report.vms.cluster).toBe(4);
	});

	test("machines count every node member, and ready only the alive ones that report ready", () => {
		expect(report.machines).toEqual({ total: 3, ready: 2 });
	});

	test("the team's VMs and limit, and the VM size", () => {
		expect(report.vms.cloud).toEqual({ running: 4, paused: 2, limit: 32 });
		expect(report.vms.size).toEqual({ vcpus: 2, memoryMB: 4096 });
	});

	test("members list the server first, then by host name, dead ones included", () => {
		expect(report.members.map((entry) => [entry.hostname, entry.status, entry.server])).toEqual([
			["omp-server", "ready", true],
			["node-a", "ready", false],
			["node-b", "dead", false],
		]);
		expect(report.members[0]).toMatchObject({ vcpus: 16, vcpusAllocated: 6, memoryMB: 65536, memoryAllocatedMB: 24576, vms: 3, version: "0.4.0" });
	});

	test("a member on another vibemon version is a version skew", () => {
		expect(report.cluster.versionSkew).toBe(true);
		const aligned = parseCluster({ ...CLUSTER, members: CLUSTER.members.map((entry) => ({ ...entry, version: "0.4.0" })) });
		expect(capacityReport({ cluster: aligned, team: null, clusterAddress: undefined, user: "owner" }).cluster.versionSkew).toBe(false);
	});

	test("720 five-second samples become at most 60 points, the last sample of each minute, oldest first", () => {
		expect(report.history.length).toBeLessThanOrEqual(60);
		expect(report.history.length).toBe(60);
		const times = report.history.map((point) => Date.parse(point.at));
		expect(times).toEqual([...times].sort((a, b) => a - b));
		const last = report.history.at(-1);
		expect(last).toEqual({ at: new Date(BASE_TS + 719 * 5000).toISOString(), machines: 2, vcpus: 24, vcpusAllocated: 719 % 24, memoryMB: 98304, memoryAllocatedMB: 1024 * (719 % 24), vms: 719 });
		// Every point is the last sample of its minute: the next sample is in a later minute (or there is none).
		for (const point of report.history.slice(0, -1)) {
			const at = Date.parse(point.at);
			expect(Math.floor((at + 5000) / 60_000)).toBeGreaterThan(Math.floor(at / 60_000));
		}
	});

	test("the join command names the user and the cluster address; without an address nothing is accepted", () => {
		expect(report.cluster).toEqual({
			accepting: true,
			address: "192.168.1.20",
			joinCommand: "curl -fsSL https://omp-cloud.techdufus.com/install.sh | sh -s -- node --join owner@192.168.1.20",
			versionSkew: true,
		});
		const closed = capacityReport({ cluster: parseCluster(CLUSTER), team: null, clusterAddress: undefined, user: "owner" });
		expect(closed.cluster).toMatchObject({ accepting: false, address: "", joinCommand: "" });
		expect(closed.vms.cloud).toEqual({ running: 0, paused: 0, limit: 0 });
	});

	test("shapes vibemon changed become defaults, never errors", () => {
		expect(parseCluster("nonsense")).toEqual({ localId: "", nodes: [], history: [] });
		const odd = parseCluster({ localID: "a", members: [{ id: "a", roles: { node: true }, state: "alive", node: { cpus: "many" } }, 7], history: [{ ts: "soon" }] });
		expect(odd.nodes).toHaveLength(1);
		expect(odd.nodes[0]).toMatchObject({ cpus: 0, status: "unknown", hostname: "", server: true });
		expect(odd.history).toEqual([]);
		expect(parseTeam({ not: "a list" }, "omp-cloud")).toBeNull();
	});
});

describe("readCapacity against a fake vibemon", () => {
	let dir = "";
	let server: Bun.Server<undefined>;
	let requests: string[] = [];
	let answer = 200;

	function configWith(vmon: Record<string, unknown>): Config {
		return parseConfig({
			listen: "127.0.0.1:8080",
			apiTokenSha256: "0".repeat(64),
			dataDir: join(dir, "data"),
			vmon: { url: `http://127.0.0.1:${server.port}`, keyFile: join(dir, "vmon.key"), template: "omp-agent", team: "omp-cloud", ...vmon },
			gateway: { url: "http://10.254.254.1:4000", clientsFile: join(dir, "clients.json") },
			broker: { url: "http://127.0.0.1:8765", tokenFile: join(dir, "broker.token") },
			models: { default: "anthropic/claude-sonnet-4-6" },
		});
	}

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "omp-cloud-capacity-"));
		await writeFile(join(dir, "vmon-admin.token"), `${TOKEN}\n`, { mode: 0o600 });
		await writeFile(join(dir, "empty.token"), "\n");
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				const { pathname } = new URL(request.url);
				requests.push(`${pathname} ${request.headers.get("x-admin-token") ?? ""}`);
				if (request.headers.get("x-admin-token") !== TOKEN) return new Response("unauthorized", { status: 401 });
				if (answer !== 200) return new Response("busy", { status: answer });
				if (pathname === "/admin/cluster") return Response.json(CLUSTER);
				if (pathname === "/admin/teams") return Response.json(TEAMS);
				return new Response("not found", { status: 404 });
			},
		});
	});

	afterAll(async () => {
		await server.stop(true);
		await rm(dir, { recursive: true, force: true });
	});

	test("reads the cluster and the team with the token from the file", async () => {
		requests = [];
		const capacity = await readCapacity(configWith({ adminTokenFile: join(dir, "vmon-admin.token"), clusterAddress: "192.168.1.20", clusterSecretFile: join(dir, "secret") }), "owner");
		expect(capacity.available).toBe(true);
		expect(capacity.vcpus.total).toBe(24);
		expect(capacity.vms.cloud.limit).toBe(32);
		expect(capacity.cluster.joinCommand).toContain("owner@192.168.1.20");
		expect(requests).toEqual([`/admin/cluster ${TOKEN}`, `/admin/teams ${TOKEN}`]);
	});

	test("a config without an admin token file says setup has not handed it over", async () => {
		const capacity = await readCapacity(configWith({}), "owner");
		expect(capacity).toMatchObject({ available: false, problem: "this server has no vibemon admin token yet", fix: "omp-cloud setup", history: [], members: [] });
		expect(capacity.machines).toEqual({ total: 0, ready: 0 });
	});

	test("a missing or empty token file is the same answer", async () => {
		for (const name of ["absent.token", "empty.token"]) {
			const capacity = await readCapacity(configWith({ adminTokenFile: join(dir, name) }), "owner");
			expect(capacity).toMatchObject({ available: false, problem: "this server has no vibemon admin token yet", fix: "omp-cloud setup" });
		}
	});

	test("a 401 names the file and never the token", async () => {
		await writeFile(join(dir, "wrong.token"), "not-the-token");
		const file = join(dir, "wrong.token");
		const capacity = await readCapacity(configWith({ adminTokenFile: file }), "owner");
		expect(capacity).toMatchObject({ available: false, problem: `vibemon refused the admin token in ${file}`, fix: "omp-cloud setup" });
		expect(JSON.stringify(capacity)).not.toContain("not-the-token");
	});

	test("any other answer is vibemon not answering, with its unit as the fix", async () => {
		answer = 503;
		try {
			const capacity = await readCapacity(configWith({ adminTokenFile: join(dir, "vmon-admin.token") }), "owner");
			expect(capacity).toMatchObject({ available: false, problem: "vibemon did not answer: /admin/cluster answered 503", fix: "systemctl status vmon" });
		} finally {
			answer = 200;
		}
		const down = await readCapacity(configWith({ adminTokenFile: join(dir, "vmon-admin.token"), url: "http://127.0.0.1:1" }), "owner");
		expect(down.available).toBe(false);
		expect(down.problem).toStartWith("vibemon did not answer: ");
		expect(down.fix).toBe("systemctl status vmon");
	});

	test("a team that is not set or that vibemon lacks is zero VMs, not a failure", async () => {
		const noTeam = configWith({ adminTokenFile: join(dir, "vmon-admin.token"), team: undefined });
		expect((await readCapacity(noTeam, "owner")).vms.cloud).toEqual({ running: 0, paused: 0, limit: 0 });
		const other = await readCapacity(configWith({ adminTokenFile: join(dir, "vmon-admin.token"), team: "other" }), "owner");
		expect(other.available).toBe(true);
		expect(other.vms.cloud).toEqual({ running: 0, paused: 0, limit: 0 });
	});

	test("VmonAdmin.open throws the typed errors", async () => {
		await expect(VmonAdmin.open({ url: "http://127.0.0.1:1", tokenFile: join(dir, "absent.token") })).rejects.toBeInstanceOf(VmonAdminUnavailable);
		const refused = await VmonAdmin.open({ url: `http://127.0.0.1:${server.port}`, tokenFile: join(dir, "wrong.token") });
		await expect(refused.cluster()).rejects.toBeInstanceOf(VmonAdminRefused);
	});
});
