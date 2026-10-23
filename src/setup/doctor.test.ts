import { describe, expect, test } from "bun:test";
import { type Config, parseConfig } from "../config";
import { collectDoctor, type DoctorDeps, formatDoctor } from "./doctor";
import type { HealthDeps, TemplateProbe } from "./health";
import type { PreflightResult } from "./preflight";
import type { StepResult } from "./steps";
import { VmonAdminRefused, VmonAdminUnavailable } from "../vmon/admin";

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
