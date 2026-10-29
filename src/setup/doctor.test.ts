import { describe, expect, test } from "bun:test";
import { type Config, parseConfig } from "../config";
import { collectDoctor, collectNodeDoctor, type DoctorDeps, formatDoctor, type NodeDoctorDeps } from "./doctor";
import type { HealthDeps, TemplateProbe } from "./health";
import type { PreflightResult } from "./preflight";
import type { StepResult } from "./steps";
import { renderNodeVmonUnit } from "./system-units";
import { VmonAdminRefused, VmonAdminUnavailable } from "../vmon/admin";
import type { ClusterNode } from "../vmon/admin";
import type { CommandResult } from "../update/system";

const VERSION = "0.5.0";

function testConfig(): Config {
	return parseConfig({
		listen: "127.0.0.1:8080",
		apiTokenSha256: "0".repeat(64),
		dataDir: "/data/omp-cloud",
		vmon: { url: "http://127.0.0.1:3000", keyFile: "/config/vmon.key", template: "omp-agent", team: "omp-cloud" },
		gateway: { url: "http://10.254.254.1:4000", clientsFile: "/data/clients.json" },
		broker: { url: "http://127.0.0.1:8765", tokenFile: "/data/broker.token" },
		models: { default: "anthropic/claude-sonnet-4-6" },
	});
}

const ok = (id: string): StepResult => ({ id, status: "ok", detail: `${id} fine` });

/** Answers per URL; an Error is a network failure, a missing URL is refused. */
function fakeHealth(routes: Record<string, Response | Error>): { health: HealthDeps; urls: string[] } {
	const urls: string[] = [];
	const health: HealthDeps = {
		fetch: async (url) => {
			urls.push(url);
			const answer = routes[url] ?? new Error("connect ECONNREFUSED");
			if (answer instanceof Error) throw answer;
			// A fresh Bun Response each time (`clone()` is typed as undici's Response, which the health seam does not accept).
			const copy = answer.clone();
			return new Response(await copy.text(), { status: copy.status });
		},
		sleep: async () => {},
		now: () => 0,
	};
	return { health, urls };
}

const GOOD_ROUTES = {
	"http://127.0.0.1:8080/api/v1/health": Response.json({ status: "ok", version: VERSION }),
	"http://127.0.0.1:8765/v1/healthz": new Response("ok"),
	"http://10.254.254.1:4000/healthz": new Response("ok"),
};

function probe(exists: boolean | Error): TemplateProbe {
	return {
		name: async () => "omp-agent:18.12.3-abc123def456",
		exists: async () => {
			if (exists instanceof Error) throw exists;
			return exists;
		},
	};
}

function fakeDeps(overrides: Partial<DoctorDeps> = {}, calls: string[] = []): DoctorDeps {
	const preflightResult: PreflightResult = { steps: [ok("preflight.kvm"), ok("preflight.sudo")], blocked: false, missingTools: [], packageManager: "apt", omp: null };
	return {
		preflight: async () => {
			calls.push("preflight");
			return preflightResult;
		},
		systemChecks: async () => {
			calls.push("system");
			return [ok("system.check.vmon")];
		},
		userUnitChecks: async () => {
			calls.push("units");
			return [ok("units.omp-cloud")];
		},
		pluginChecks: async () => {
			calls.push("plugin");
			return [ok("plugin.installed")];
		},
		health: fakeHealth(GOOD_ROUTES).health,
		config: testConfig(),
		readKey: async () => "key-1",
		ompVersion: async () => "18.12.3",
		templateProbe: async () => probe(true),
		clusterProbe: async () => ({ localId: "server", history: [], nodes: [{ id: "server", hostname: "omp-server", addrs: [], alive: true, status: "ready", version: "0.4.0", server: true, cpus: 8, vcpusUsed: 0, memoryMB: 8192, memoryUsedMB: 0, diskFreeMB: 1, sandboxes: 0 }] }),
		version: VERSION,
		...overrides,
	};
}

const ids = (steps: readonly StepResult[]) => steps.map((step) => step.id);
const byId = (steps: readonly StepResult[], id: string): StepResult => {
	const found = steps.find((step) => step.id === id);
	if (found === undefined) throw new Error(`no step ${id} in ${ids(steps).join(", ")}`);
	return found;
};

describe("collectDoctor", () => {
	test("runs the checks in order and concatenates their steps", async () => {
		const calls: string[] = [];
		const steps = await collectDoctor(fakeDeps({}, calls));
		expect(calls).toEqual(["preflight", "system", "units", "plugin"]);
		expect(ids(steps)).toEqual([
			"preflight.kvm",
			"preflight.sudo",
			"system.check.vmon",
			"units.omp-cloud",
			"doctor.service",
			"doctor.broker",
			"doctor.gateway",
			"doctor.template",
			"doctor.vmon-admin",
			"plugin.installed",
		]);
		expect(steps.every((step) => step.status === "ok")).toBe(true);
	});

	test("a blocked preflight still lets the rest run", async () => {
		const failedKvm: StepResult = { id: "preflight.kvm", status: "failed", detail: "/dev/kvm is missing", fix: "enable nested virtualization" };
		const calls: string[] = [];
		const steps = await collectDoctor(
			fakeDeps({ preflight: async () => ({ steps: [failedKvm], blocked: true, missingTools: [], packageManager: "apt", omp: null }) }, calls),
		);
		expect(calls).toEqual(["system", "units", "plugin"]);
		expect(steps[0]).toBe(failedKvm);
		expect(ids(steps)).toContain("doctor.service");
		expect(ids(steps).at(-1)).toBe("plugin.installed");
	});

	test("asks the loopback API, the broker and the gateway", async () => {
		const { health, urls } = fakeHealth(GOOD_ROUTES);
		await collectDoctor(fakeDeps({ health }));
		expect(urls).toEqual(["http://127.0.0.1:8080/api/v1/health", "http://127.0.0.1:8765/v1/healthz", "http://10.254.254.1:4000/healthz"]);
	});

	test("a throwing check becomes one failed step with its message, and the rest still run", async () => {
		const steps = await collectDoctor(
			fakeDeps({
				systemChecks: async () => {
					throw new Error("systemctl exploded");
				},
				pluginChecks: async () => {
					throw new Error("omp not found");
				},
			}),
		);
		expect(byId(steps, "doctor.system")).toEqual({ id: "doctor.system", status: "failed", detail: "systemctl exploded" });
		expect(byId(steps, "doctor.plugin")).toEqual({ id: "doctor.plugin", status: "failed", detail: "omp not found" });
		expect(byId(steps, "units.omp-cloud").status).toBe("ok");
		expect(byId(steps, "doctor.service").status).toBe("ok");
	});

	test("a throwing preflight is one failed step too", async () => {
		const steps = await collectDoctor(
			fakeDeps({
				preflight: async () => {
					throw new Error("statfs failed");
				},
			}),
		);
		expect(steps[0]).toEqual({ id: "doctor.preflight", status: "failed", detail: "statfs failed" });
		expect(steps).toHaveLength(9);
	});
});

describe("the service", () => {
	test("a different version than this binary's is failed, names both, and says restart", async () => {
		const { health } = fakeHealth({ ...GOOD_ROUTES, "http://127.0.0.1:8080/api/v1/health": Response.json({ status: "ok", version: "0.4.0" }) });
		const step = byId(await collectDoctor(fakeDeps({ health })), "doctor.service");
		expect(step.status).toBe("failed");
		expect(step.detail).toContain("0.4.0");
		expect(step.detail).toContain(VERSION);
		expect(step.fix).toBe("systemctl --user restart omp-cloud");
	});

	test("unreachable is failed with the status command; broker and gateway are reported separately", async () => {
		const { health } = fakeHealth({});
		const steps = await collectDoctor(fakeDeps({ health }));
		expect(byId(steps, "doctor.service")).toMatchObject({ status: "failed", fix: "systemctl --user status omp-cloud" });
		expect(byId(steps, "doctor.broker")).toMatchObject({ status: "failed", fix: "systemctl --user status omp-auth-broker" });
		expect(byId(steps, "doctor.gateway")).toMatchObject({ status: "failed", fix: "systemctl --user status omp-auth-gateway" });
	});

	test("one broken piece does not hide the others", async () => {
		const { health } = fakeHealth({ ...GOOD_ROUTES, "http://127.0.0.1:8765/v1/healthz": new Response("down", { status: 503 }) });
		const steps = await collectDoctor(fakeDeps({ health }));
		expect(byId(steps, "doctor.service").status).toBe("ok");
		expect(byId(steps, "doctor.broker").status).toBe("failed");
		expect(byId(steps, "doctor.broker").detail).toContain("HTTP 503");
		expect(byId(steps, "doctor.gateway").status).toBe("ok");
	});

	test("a status that is not ok is failed", async () => {
		const { health } = fakeHealth({ ...GOOD_ROUTES, "http://127.0.0.1:8080/api/v1/health": Response.json({ status: "starting" }) });
		expect(byId(await collectDoctor(fakeDeps({ health })), "doctor.service").status).toBe("failed");
	});

	test("asks the port the config listens on", async () => {
		const config = { ...testConfig(), listen: { hostname: "127.0.0.1", port: 9090 } };
		const { health, urls } = fakeHealth({ ...GOOD_ROUTES, "http://127.0.0.1:9090/api/v1/health": Response.json({ status: "ok", version: VERSION }) });
		await collectDoctor(fakeDeps({ config, health }));
		expect(urls[0]).toBe("http://127.0.0.1:9090/api/v1/health");
	});
});

describe("missing config", () => {
	test("one failed doctor.config step that names omp-cloud setup, and no service or template probing", async () => {
		const { health, urls } = fakeHealth(GOOD_ROUTES);
		const steps = await collectDoctor(fakeDeps({ config: null, health }));
		expect(byId(steps, "doctor.config")).toMatchObject({ status: "failed", fix: "omp-cloud setup" });
		expect(ids(steps).filter((id) => id.startsWith("doctor."))).toEqual(["doctor.config"]);
		expect(urls).toEqual([]);
		expect(ids(steps).at(-1)).toBe("plugin.installed");
	});
});

describe("the template", () => {
	test("ready is ok, with its name", async () => {
		const step = byId(await collectDoctor(fakeDeps({ templateProbe: async () => probe(true) })), "doctor.template");
		expect(step).toEqual({ id: "doctor.template", status: "ok", detail: "the VM template omp-agent:18.12.3-abc123def456 is ready" });
	});

	test("not built yet is skipped and points at the build log", async () => {
		const step = byId(await collectDoctor(fakeDeps({ templateProbe: async () => probe(false) })), "doctor.template");
		expect(step.status).toBe("skipped");
		expect(step.detail).toContain("not built yet");
		expect(step.detail).toContain("journalctl --user -u omp-cloud -f");
	});

	test("no key file is skipped, and the probe is never built", async () => {
		let built = false;
		const steps = await collectDoctor(
			fakeDeps({
				readKey: async () => null,
				templateProbe: async () => {
					built = true;
					return probe(true);
				},
			}),
		);
		expect(byId(steps, "doctor.template").status).toBe("skipped");
		expect(built).toBe(false);
	});

	test("no omp is skipped", async () => {
		const step = byId(await collectDoctor(fakeDeps({ ompVersion: async () => null })), "doctor.template");
		expect(step.status).toBe("skipped");
	});

	test("hands the probe the config, the key and the omp version", async () => {
		const seen: unknown[] = [];
		await collectDoctor(
			fakeDeps({
				templateProbe: async (config, key, ompVersion) => {
					seen.push(config.vmon.template, key, ompVersion);
					return probe(true);
				},
			}),
		);
		expect(seen).toEqual(["omp-agent", "key-1", "18.12.3"]);
	});

	test("vmon refusing the question is failed with setup as the fix", async () => {
		const step = byId(await collectDoctor(fakeDeps({ templateProbe: async () => probe(new Error("401 Unauthorized")) })), "doctor.template");
		expect(step).toMatchObject({ status: "failed", fix: "omp-cloud setup" });
		expect(step.detail).toContain("401 Unauthorized");
	});

	test("a probe that cannot even be made is a failed doctor.template step", async () => {
		const steps = await collectDoctor(
			fakeDeps({
				templateProbe: async () => {
					throw new Error("e2b missing");
				},
			}),
		);
		expect(byId(steps, "doctor.template")).toEqual({ id: "doctor.template", status: "failed", detail: "e2b missing" });
	});
});

describe("doctor.vmon-admin", () => {
	test("an answering cluster view is ok, with the machine count", async () => {
		const step = byId(await collectDoctor(fakeDeps()), "doctor.vmon-admin");
		expect(step).toEqual({ id: "doctor.vmon-admin", status: "ok", detail: "the service reads vibemon's cluster view (1 machines)" });
	});

	test("no admin token is skipped, with setup as the fix", async () => {
		const step = byId(
			await collectDoctor(
				fakeDeps({
					clusterProbe: async () => {
						throw new VmonAdminUnavailable("cannot read the vibemon admin token file /config/vmon-admin.token");
					},
				}),
			),
			"doctor.vmon-admin",
		);
		expect(step).toEqual({ id: "doctor.vmon-admin", status: "skipped", detail: "this server has no vibemon admin token yet", fix: "omp-cloud setup" });
	});

	test("a refused token is failed and names the file", async () => {
		const step = byId(
			await collectDoctor(
				fakeDeps({
					clusterProbe: async () => {
						throw new VmonAdminRefused("/config/vmon-admin.token");
					},
				}),
			),
			"doctor.vmon-admin",
		);
		expect(step).toEqual({ id: "doctor.vmon-admin", status: "failed", detail: "vibemon refused the admin token in /config/vmon-admin.token", fix: "omp-cloud setup" });
	});

	test("any other error is failed with the vmon unit's status as the fix", async () => {
		const step = byId(
			await collectDoctor(
				fakeDeps({
					clusterProbe: async () => {
						throw new Error("connect ECONNREFUSED");
					},
				}),
			),
			"doctor.vmon-admin",
		);
		expect(step).toEqual({ id: "doctor.vmon-admin", status: "failed", detail: "vibemon did not answer: connect ECONNREFUSED", fix: "systemctl status vmon" });
	});
});

function clusterConfig(): Config {
	return parseConfig({
		listen: "127.0.0.1:8080",
		apiTokenSha256: "0".repeat(64),
		dataDir: "/data/omp-cloud",
		vmon: { url: "http://127.0.0.1:3000", keyFile: "/config/vmon.key", template: "omp-agent", team: "omp-cloud", clusterAddress: "192.168.1.20", clusterSecretFile: "/config/vmon-cluster.secret" },
		gateway: { url: "http://10.254.254.1:4000", clientsFile: "/data/clients.json" },
		broker: { url: "http://127.0.0.1:8765", tokenFile: "/data/broker.token" },
		models: { default: "anthropic/claude-sonnet-4-6" },
	});
}

function member(hostname: string, over: Partial<ClusterNode> = {}): ClusterNode {
	return { id: hostname, hostname, addrs: [], alive: true, status: "ready", version: "0.4.0", server: false, cpus: 8, vcpusUsed: 0, memoryMB: 8192, memoryUsedMB: 0, diskFreeMB: 1, sandboxes: 0, ...over };
}

const SERVER_MEMBER = member("omp-server", { server: true });

function clusterDeps(nodes: ClusterNode[] | Error, config: Config = clusterConfig()): DoctorDeps {
	return fakeDeps({
		config,
		clusterProbe: async () => {
			if (nodes instanceof Error) throw nodes;
			return { localId: "omp-server", history: [], nodes };
		},
	});
}

describe("doctor.cluster", () => {
	test("is not run on a server that takes no machines", async () => {
		expect(ids(await collectDoctor(fakeDeps()))).not.toContain("doctor.cluster");
	});

	test("machines that are alive on the server's vibemon are ok, counted with the server", async () => {
		const step = byId(await collectDoctor(clusterDeps([SERVER_MEMBER, member("node-a"), member("node-b")])), "doctor.cluster");
		expect(step).toEqual({ id: "doctor.cluster", status: "ok", detail: "accepting vibemon machines on 192.168.1.20; 3 machines" });
	});

	test("a machine that is not alive fails, naming it and the ports a network may block", async () => {
		const step = byId(await collectDoctor(clusterDeps([SERVER_MEMBER, member("node-a", { alive: false, status: "dead" })])), "doctor.cluster");
		expect(step.status).toBe("failed");
		expect(step.detail).toContain("node-a is not alive (dead)");
		expect(step.fix).toBe("on node-a: sudo systemctl start omp-cloud-vmon-sync.service; journalctl -u omp-cloud-vmon-sync -n 20; a machine that is not alive may be off, or the network blocks TCP 7947 and 7946 (TCP and UDP) between the machines");
	});

	test("every machine on another vibemon version is listed in one step; the server's own version is the reference", async () => {
		const step = byId(
			await collectDoctor(clusterDeps([SERVER_MEMBER, member("node-a", { version: "0.3.9" }), member("node-ok"), member("node-b", { version: "0.5.0" })])),
			"doctor.cluster",
		);
		expect(step).toEqual({
			id: "doctor.cluster",
			status: "failed",
			detail: "node-a runs vibemon 0.3.9, the server 0.4.0; node-b runs vibemon 0.5.0, the server 0.4.0",
			fix: "on node-a, node-b: sudo systemctl start omp-cloud-vmon-sync.service; journalctl -u omp-cloud-vmon-sync -n 20",
		});
	});

	test("a dead machine's version is not compared", async () => {
		const step = byId(await collectDoctor(clusterDeps([SERVER_MEMBER, member("node-a", { alive: false, status: "suspect", version: "0.1.0" })])), "doctor.cluster");
		expect(step.detail).not.toContain("runs vibemon");
	});

	test("a probe that cannot read the cluster reuses the admin texts", async () => {
		const unavailable = byId(await collectDoctor(clusterDeps(new VmonAdminUnavailable("no file"))), "doctor.cluster");
		expect(unavailable).toEqual({ id: "doctor.cluster", status: "skipped", detail: "this server has no vibemon admin token yet", fix: "omp-cloud setup" });
		const down = byId(await collectDoctor(clusterDeps(new Error("connect ECONNREFUSED"))), "doctor.cluster");
		expect(down).toEqual({ id: "doctor.cluster", status: "failed", detail: "vibemon did not answer: connect ECONNREFUSED", fix: "systemctl status vmon" });
	});
});

const NODE_PIN = `sha256//${"A".repeat(43)}=`;
const NODE_ENV = `SERVER_URL=https://192.168.1.20:8443\nSERVER_PIN=${NODE_PIN}\n`;
const HEALTH_LINE = `curl -q -sk --proto =https --pinnedpubkey ${NODE_PIN} --max-filesize 65536 --max-time 10 https://192.168.1.20:8443/api/v1/health`;
const GATEWAY_LINE = "curl -s -o /dev/null -w %{http_code} --max-time 5 http://10.254.254.1:4000/healthz";
const RESTRICTION_LINE = "curl -s -m 3 -o /dev/null http://10.254.254.1:8443/";
const ON_LINK = "192.168.1.20 dev eth0 src 192.168.1.5 uid 1000\n";
const ROUTED_SERVICE_IP = "10.254.254.1 via 192.168.1.20 dev eth0 src 192.168.1.5 uid 1000\n";

const NODE_UNIT = renderNodeVmonUnit("172.20.0.0/16", "192.168.1.10", { uid: 961, gid: 990 });

/** A healthy node, with `answers` (a command line to its result, or a failure to start) laid over the answers of a machine that is right. `unit` is the text of its vmon unit; null: no unit file. */
function nodeDeps(answers: Record<string, Partial<CommandResult> | Error> = {}, env: string | Error = NODE_ENV, unit: string | null = NODE_UNIT): { deps: NodeDoctorDeps; lines: string[] } {
	const healthy: Record<string, Partial<CommandResult>> = {
		"systemctl is-failed omp-cloud-vmon-sync.service": { code: 1, stdout: "active\n" },
		"ip route get 192.168.1.20": { stdout: ON_LINK },
		"ip route get 10.254.254.1": { stdout: ROUTED_SERVICE_IP },
		[GATEWAY_LINE]: { stdout: "200" },
		[RESTRICTION_LINE]: { code: 7 },
		[HEALTH_LINE]: { stdout: '{"status":"ok","vmon":"v0.4.0"}' },
		"/opt/vmon/vmon --version": { stdout: "vmon 0.4.0\n" },
	};
	const lines: string[] = [];
	const deps: NodeDoctorDeps = {
		preflight: async () => ({ steps: [ok("preflight.kvm")], blocked: false, missingTools: [], packageManager: "apt", omp: null }),
		run: async (argv) => {
			const line = argv.join(" ");
			lines.push(line);
			const answer = answers[line];
			if (answer instanceof Error) throw answer;
			const result: CommandResult = { code: 0, stdout: /^systemctl is-(enabled|active) /.test(line) ? "ok\n" : "", stderr: "" };
			return { ...result, ...(healthy[line] ?? {}), ...answer };
		},
		ip: "ip",
		readNodeEnv: async () => {
			if (env instanceof Error) throw env;
			return env;
		},
		readVmonUnit: async () => unit,
	};
	return { deps, lines };
}

describe("collectNodeDoctor", () => {
	test("a healthy node on the server's LAN is all ok, in order, and runs only the probes of the spec", async () => {
		const { deps, lines } = nodeDeps();
		const steps = await collectNodeDoctor(deps);
		expect(steps.map((step) => `${step.status} ${step.id}`)).toEqual([
			"ok preflight.kvm",
			"ok doctor.node.config",
			"ok doctor.node.vmon",
			"ok doctor.node.net",
			"ok doctor.node.timer",
			"ok doctor.node.vmm-user",
			"ok doctor.node.sync",
			"ok doctor.node.route",
			"ok doctor.node.gateway",
			"ok doctor.node.restriction",
			"ok doctor.node.vmon-version",
		]);
		expect(lines).toEqual([
			"systemctl is-enabled vmon",
			"systemctl is-active vmon",
			"systemctl is-enabled omp-cloud-node-net",
			"systemctl is-active omp-cloud-node-net",
			"systemctl is-enabled omp-cloud-vmon-sync.timer",
			"systemctl is-active omp-cloud-vmon-sync.timer",
			"systemctl is-failed omp-cloud-vmon-sync.service",
			"ip route get 192.168.1.20",
			"ip route get 10.254.254.1",
			GATEWAY_LINE,
			RESTRICTION_LINE,
			HEALTH_LINE,
			"/opt/vmon/vmon --version",
		]);
	});

	test("a unit that is not enabled or not running fails with a fix naming it", async () => {
		const { deps } = nodeDeps({ "systemctl is-enabled omp-cloud-node-net": { code: 1, stdout: "disabled\n" }, "systemctl is-active vmon": { code: 3, stdout: "failed\n" } });
		const steps = await collectNodeDoctor(deps);
		expect(byId(steps, "doctor.node.vmon")).toEqual({ id: "doctor.node.vmon", status: "failed", detail: "vmon is not running (failed)", fix: "sudo systemctl enable --now vmon; journalctl -u vmon -n 20" });
		expect(byId(steps, "doctor.node.net")).toMatchObject({ status: "failed", detail: "omp-cloud-node-net is not enabled", fix: "sudo systemctl enable --now omp-cloud-node-net; journalctl -u omp-cloud-node-net -n 20" });
		expect(byId(steps, "doctor.node.timer").status).toBe("ok");
	});

	test("a vmon unit that drops its VMMs to omp-cloud-vmm is ok", async () => {
		const { deps } = nodeDeps();
		expect(byId(await collectNodeDoctor(deps), "doctor.node.vmm-user")).toEqual({
			id: "doctor.node.vmm-user",
			status: "ok",
			detail: "vibemon's VMMs run as omp-cloud-vmm (961:990) under their seccomp and Landlock filters",
		});
	});

	test("a vmon unit without --vmm-user fails with the setup fix, and a node with no unit file has no row", async () => {
		const { deps } = nodeDeps({}, NODE_ENV, NODE_UNIT.replace(" --vmm-user 961:990", ""));
		expect(byId(await collectNodeDoctor(deps), "doctor.node.vmm-user")).toEqual({
			id: "doctor.node.vmm-user",
			status: "failed",
			detail: "vibemon's VMMs run as root without their seccomp and Landlock filters (the vmon unit has no --vmm-user)",
			fix: "omp-cloud setup node --join <user@server>",
		});
		expect(ids(await collectNodeDoctor(nodeDeps({}, NODE_ENV, null).deps))).not.toContain("doctor.node.vmm-user");
	});

	test("a failed sync service names the sync command and the journal", async () => {
		const { deps } = nodeDeps({ "systemctl is-failed omp-cloud-vmon-sync.service": { stdout: "failed\n" } });
		expect(byId(await collectNodeDoctor(deps), "doctor.node.sync")).toMatchObject({
			status: "failed",
			fix: "sudo systemctl start omp-cloud-vmon-sync.service; journalctl -u omp-cloud-vmon-sync -n 20",
		});
	});

	test("on the server's LAN the service IP must be routed to the server", async () => {
		const { deps } = nodeDeps({ "ip route get 10.254.254.1": { stdout: "10.254.254.1 dev eth0 src 192.168.1.5\n" } });
		expect(byId(await collectNodeDoctor(deps), "doctor.node.route")).toEqual({
			id: "doctor.node.route",
			status: "failed",
			detail: "10.254.254.1 is not routed to the server at 192.168.1.20 (10.254.254.1 dev eth0 src 192.168.1.5)",
			fix: "sudo systemctl restart omp-cloud-node-net; journalctl -u omp-cloud-node-net -n 20",
		});
	});

	test("behind a router there is no route step and the gateway fix names the router", async () => {
		const { deps, lines } = nodeDeps({ "ip route get 192.168.1.20": { stdout: "192.168.1.20 via 10.0.0.1 dev eth0 src 10.0.0.5\n" }, [GATEWAY_LINE]: { stdout: "000" } });
		const steps = await collectNodeDoctor(deps);
		expect(ids(steps)).not.toContain("doctor.node.route");
		expect(lines).not.toContain("ip route get 10.254.254.1");
		expect(byId(steps, "doctor.node.gateway")).toMatchObject({
			status: "failed",
			detail: "the server's model gateway did not answer at http://10.254.254.1:4000/healthz (no answer): VMs here cannot call a model",
			fix: "on the router 10.0.0.1, route 10.254.254.1/32 to 192.168.1.20; on the server, allow TCP 4000 and 4100 to 10.254.254.1 from 10.0.0.5",
		});
	});

	test("a gateway answering another status fails; on the LAN the fix is the server's firewall for this machine's address", async () => {
		const { deps } = nodeDeps({ [GATEWAY_LINE]: { stdout: "503" } });
		expect(byId(await collectNodeDoctor(deps), "doctor.node.gateway")).toMatchObject({
			status: "failed",
			detail: expect.stringContaining("(HTTP 503)"),
			fix: "on the server, allow TCP 4000 and 4100 to 10.254.254.1 from 192.168.1.5",
		});
	});

	test("the restriction is probed, not assumed: a curl to 10.254.254.1:8443 that is refused is ok", async () => {
		const { deps, lines } = nodeDeps();
		expect(byId(await collectNodeDoctor(deps), "doctor.node.restriction")).toEqual({
			id: "doctor.node.restriction",
			status: "ok",
			detail: "http://10.254.254.1:8443/ is refused: VMs here reach only TCP 4000 and 4100 of 10.254.254.1",
		});
		expect(lines).toContain(RESTRICTION_LINE);
	});

	test("a restriction that is not in force (the units are active, the rules are gone) fails and says how to restore it", async () => {
		const { deps } = nodeDeps({ [RESTRICTION_LINE]: { code: 0 } });
		expect(byId(await collectNodeDoctor(deps), "doctor.node.restriction")).toEqual({
			id: "doctor.node.restriction",
			status: "failed",
			detail: "this machine reaches 10.254.254.1:8443: the VM traffic restriction is not in force",
			fix: "sudo systemctl restart omp-cloud-node-net vmon",
		});
	});

	test("a server this machine has no route to fails the route step", async () => {
		const { deps } = nodeDeps({ "ip route get 192.168.1.20": { code: 2, stderr: "RTNETLINK answers: Network is unreachable\n" } });
		expect(byId(await collectNodeDoctor(deps), "doctor.node.route")).toMatchObject({ status: "failed", detail: expect.stringContaining("Network is unreachable"), fix: "check this machine's network: ip route get 192.168.1.20" });
	});

	test("the server's vibemon tag must equal the installed one; a mismatch points at the sync", async () => {
		const { deps } = nodeDeps({ "/opt/vmon/vmon --version": { stdout: "vmon 0.3.9\n" } });
		expect(byId(await collectNodeDoctor(deps), "doctor.node.vmon-version")).toEqual({
			id: "doctor.node.vmon-version",
			status: "failed",
			detail: "this machine runs vibemon v0.3.9, the server v0.4.0",
			fix: "sudo systemctl start omp-cloud-vmon-sync.service; journalctl -u omp-cloud-vmon-sync -n 20",
		});
	});

	test("a vibemon that is not installed or reports nothing fails the version step", async () => {
		for (const answer of [new Error("spawn /opt/vmon/vmon ENOENT"), { stdout: "something else\n" }, { code: 1 }]) {
			const { deps } = nodeDeps({ "/opt/vmon/vmon --version": answer });
			expect(byId(await collectNodeDoctor(deps), "doctor.node.vmon-version")).toMatchObject({ status: "failed", detail: expect.stringContaining("is not installed at /opt/vmon/vmon") });
		}
	});

	test("an old server that reports no vibemon tag is skipped, an unreachable one or a pin mismatch is failed", async () => {
		const old = nodeDeps({ [HEALTH_LINE]: { stdout: '{"status":"ok","version":"0.5.0"}' } });
		expect(byId(await collectNodeDoctor(old.deps), "doctor.node.vmon-version").status).toBe("skipped");
		const silent = nodeDeps({ [HEALTH_LINE]: { code: 28 } });
		expect(byId(await collectNodeDoctor(silent.deps), "doctor.node.vmon-version")).toMatchObject({ status: "failed", detail: "the server at https://192.168.1.20:8443 did not answer (curl exit 28)" });
		const pinned = nodeDeps({ [HEALTH_LINE]: { code: 90 } });
		expect(byId(await collectNodeDoctor(pinned.deps), "doctor.node.vmon-version")).toMatchObject({
			status: "failed",
			detail: "the server at https://192.168.1.20:8443 presented a certificate other than the pinned one",
			fix: "omp-cloud uninstall --purge, then omp-cloud setup node --join <user@server>",
		});
	});

	test("a node.env that is invalid is one failed step with the rejoin fix, and the checks that need the server are not run", async () => {
		for (const env of ["SERVER_URL=http://192.168.1.20:8443\nSERVER_PIN=" + NODE_PIN + "\n", "SERVER_URL=https://192.168.1.20:8443\nSERVER_PIN=sha256//short=\n", "", new Error("EACCES")]) {
			const { deps, lines } = nodeDeps({ [GATEWAY_LINE]: { stdout: "000" } }, env);
			const steps = await collectNodeDoctor(deps);
			expect(byId(steps, "doctor.node.config")).toMatchObject({ status: "failed", fix: "omp-cloud uninstall --purge, then omp-cloud setup node --join <user@server>" });
			expect(ids(steps)).not.toContain("doctor.node.route");
			expect(ids(steps)).not.toContain("doctor.node.vmon-version");
			expect(lines.some((line) => line.startsWith("ip route get"))).toBe(false);
			expect(byId(steps, "doctor.node.gateway")).toMatchObject({ fix: "on the server, allow TCP 4000 and 4100 to 10.254.254.1 from this machine" });
		}
	});

	test("a probe that throws is one failed step and the others still run", async () => {
		const { deps } = nodeDeps({ "systemctl is-enabled vmon": new Error("systemctl is not installed") });
		const steps = await collectNodeDoctor(deps);
		expect(byId(steps, "doctor.node.vmon")).toEqual({ id: "doctor.node.vmon", status: "failed", detail: "systemctl is not installed" });
		expect(byId(steps, "doctor.node.vmon-version").status).toBe("ok");
		const broken = await collectNodeDoctor({ ...deps, preflight: async () => Promise.reject(new Error("preflight broke")) });
		expect(byId(broken, "doctor.preflight")).toEqual({ id: "doctor.preflight", status: "failed", detail: "preflight broke" });
	});

	test("it never asks about service.json, the user units or the plugin", async () => {
		const { deps, lines } = nodeDeps();
		await collectNodeDoctor(deps);
		expect(lines.some((line) => line.includes("--user"))).toBe(false);
	});
});

describe("formatDoctor", () => {
	const STEPS: StepResult[] = [
		{ id: "preflight.kvm", status: "ok", detail: "/dev/kvm is present" },
		{ id: "units.omp-cloud", status: "changed", detail: "restarted" },
		{ id: "doctor.template", status: "skipped", detail: "building" },
		{ id: "doctor.service", status: "failed", detail: "the service runs 0.4.0, this binary is 0.5.0", fix: "systemctl --user restart omp-cloud" },
	];

	test("a line per step with the id padded, the fix under a failure, then the counts", () => {
		expect(formatDoctor(STEPS, false)).toBe(
			[
				"· preflight.kvm    /dev/kvm is present",
				"✓ units.omp-cloud  restarted",
				"- doctor.template  building",
				"✗ doctor.service   the service runs 0.4.0, this binary is 0.5.0",
				"    fix: systemctl --user restart omp-cloud",
				"1 ok, 1 changed, 1 skipped, 1 failed",
				"",
			].join("\n"),
		);
	});

	test("colour only touches the marks", () => {
		const colored = formatDoctor(STEPS, true);
		expect(colored).toContain("\x1b[31m✗\x1b[0m doctor.service");
		expect(colored).toContain("\x1b[32m✓\x1b[0m units.omp-cloud");
		expect(colored.replace(/\x1b\[\d+m/g, "")).toBe(formatDoctor(STEPS, false));
	});

	test("a failed step without a fix prints no fix line, and an empty table is just the counts", () => {
		expect(formatDoctor([{ id: "doctor.system", status: "failed", detail: "boom" }], false)).toBe("✗ doctor.system  boom\n0 ok, 0 changed, 0 skipped, 1 failed\n");
		expect(formatDoctor([], false)).toBe("0 ok, 0 changed, 0 skipped, 0 failed\n");
	});
});
