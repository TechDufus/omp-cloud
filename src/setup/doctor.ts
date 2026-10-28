/** `omp-cloud doctor`: every check of the host and the stack as one table, a fix beside each failure. */
import { type Config, loadConfig } from "../config";
import { adminProblem } from "../vmon/capacity";
import { type ClusterView, VmonAdminUnavailable } from "../vmon/admin";
import { VMON_BINARY } from "../vmon/pin";
import { isRecord } from "../guards";
import { healthBase } from "../update/real";
import type { CommandRunner } from "../update/system";
import { type SetupContext, findOmp, realContext } from "./context";
import { readVmonKey } from "./config";
import type { HealthDeps, TemplateProbe } from "./health";
import { type PreflightResult, preflight } from "./preflight";
import { Reporter, type StepResult } from "./steps";
import { NODE_ENV_FILE, vmmUserCheck } from "./system";
import { SYSTEM_UNIT_DIR, VMON_UNIT } from "./system-units";
import { userUnitChecks } from "./units";

export interface DoctorDeps {
	preflight: () => Promise<PreflightResult>;
	systemChecks: () => Promise<StepResult[]>;
	userUnitChecks: () => Promise<StepResult[]>;
	pluginChecks: () => Promise<StepResult[]>;
	health: HealthDeps;
	/** Null when service.json does not exist or is invalid (a failed `doctor.config` step then names `omp-cloud setup`). */
	config: Config | null;
	readKey: () => Promise<string | null>;
	ompVersion: () => Promise<string | null>;
	templateProbe: (config: Config, key: string, ompVersion: string) => Promise<TemplateProbe>;
	clusterProbe: (config: Config) => Promise<ClusterView>;
	/** This binary's version: the service that answers must be running it. */
	version: string;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The steps `check` returns, or one failed step named `id` when it throws: one broken probe never hides the rest of the table. */
async function guarded(id: string, check: () => Promise<StepResult[]>): Promise<StepResult[]> {
	try {
		return await check();
	} catch (error) {
		return [{ id, status: "failed", detail: messageOf(error) }];
	}
}

/** `GET url` answers 200: a step `id` that is `ok`, or failed with `fix`. `inspect` may refuse the body of a 200. */
async function probeHttp(
	deps: HealthDeps,
	id: string,
	what: string,
	url: string,
	unit: string,
	inspect?: (body: unknown) => StepResult | null,
): Promise<StepResult> {
	let response: Response;
	try {
		response = await deps.fetch(url);
	} catch (error) {
		return { id, status: "failed", detail: `${what} is not reachable at ${url} (${messageOf(error)})`, fix: `systemctl --user status ${unit}` };
	}
	if (response.status !== 200) {
		return { id, status: "failed", detail: `${what} answered HTTP ${response.status} at ${url}`, fix: `systemctl --user status ${unit}` };
	}
	if (inspect !== undefined) {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return { id, status: "failed", detail: `${what} at ${url} did not answer JSON`, fix: `systemctl --user status ${unit}` };
		}
		const verdict = inspect(body);
		if (verdict !== null) return verdict;
	}
	return { id, status: "ok", detail: `${what} is healthy at ${url}` };
}

async function serviceChecks(deps: DoctorDeps, config: Config): Promise<StepResult[]> {
	const base = healthBase(config.listen);
	const service = await probeHttp(deps.health, "doctor.service", "the omp-cloud service", `${base}/api/v1/health`, "omp-cloud", (body) => {
		if (!isRecord(body) || body.status !== "ok") return { id: "doctor.service", status: "failed", detail: "the service answered, but not {status: ok}", fix: "systemctl --user status omp-cloud" };
		if (body.version !== deps.version) {
			return {
				id: "doctor.service",
				status: "failed",
				detail: `the service runs ${typeof body.version === "string" ? body.version : "an unknown version"}, this binary is ${deps.version}`,
				fix: "systemctl --user restart omp-cloud",
			};
		}
		return { id: "doctor.service", status: "ok", detail: `the omp-cloud service ${deps.version} is healthy at ${base}` };
	});
	const broker = await probeHttp(deps.health, "doctor.broker", "the auth broker", `${config.broker.url.replace(/\/+$/, "")}/v1/healthz`, "omp-auth-broker");
	const gateway = await probeHttp(deps.health, "doctor.gateway", "the auth gateway", `${config.gateway.url.replace(/\/+$/, "")}/healthz`, "omp-auth-gateway");
	return [service, broker, gateway];
}

async function templateChecks(deps: DoctorDeps, config: Config): Promise<StepResult[]> {
	const id = "doctor.template";
	const key = await deps.readKey();
	if (key === null) return [{ id, status: "skipped", detail: "no vmon key yet, so the VM template cannot be asked about (omp-cloud setup creates it)" }];
	const ompVersion = await deps.ompVersion();
	if (ompVersion === null) return [{ id, status: "skipped", detail: "omp is not installed, so there is no VM template to look for" }];
	const probe = await deps.templateProbe(config, key, ompVersion);
	const name = await probe.name();
	let exists: boolean;
	try {
		exists = await probe.exists(name);
	} catch (error) {
		return [{ id, status: "failed", detail: `could not ask vmon about the VM template ${name}: ${messageOf(error)}`, fix: "omp-cloud setup" }];
	}
	if (exists) return [{ id, status: "ok", detail: `the VM template ${name} is ready` }];
	return [{ id, status: "skipped", detail: `the VM template ${name} is not built yet; the service builds it in the background (nested KVM builds are slow): journalctl --user -u omp-cloud -f` }];
}

/** Whether the service can read vibemon's cluster view: capacity in the dashboard, `/cloud status` and the `cloud` tool needs it. */
async function vmonAdminChecks(deps: DoctorDeps, config: Config): Promise<StepResult[]> {
	const id = "doctor.vmon-admin";
	try {
		const cluster = await deps.clusterProbe(config);
		return [{ id, status: "ok", detail: `the service reads vibemon's cluster view (${cluster.nodes.length} machines)` }];
	} catch (error) {
		const { problem, fix } = adminProblem(error);
		return [{ id, status: error instanceof VmonAdminUnavailable ? "skipped" : "failed", detail: problem, fix }];
	}
}

/** Whether the vibemon machines that joined this server are alive and run the server's vibemon; only a server that takes machines (`vmon.clusterAddress`) has the step. */
async function clusterChecks(deps: DoctorDeps, config: Config): Promise<StepResult[]> {
	const id = "doctor.cluster";
	const address = config.vmon.clusterAddress;
	if (address === undefined) return [];
	let cluster: ClusterView;
	try {
		cluster = await deps.clusterProbe(config);
	} catch (error) {
		const { problem, fix } = adminProblem(error);
		return [{ id, status: error instanceof VmonAdminUnavailable ? "skipped" : "failed", detail: problem, fix }];
	}
	const serverVersion = cluster.nodes.find((node) => node.server)?.version ?? "";
	const problems: string[] = [];
	const offenders: string[] = [];
	let dead = false;
	for (const node of cluster.nodes) {
		if (node.server) continue;
		if (!node.alive) {
			dead = true;
			offenders.push(node.hostname);
			problems.push(`${node.hostname} is not alive (${node.status}); it may be off, or the network blocks the vibemon ports`);
		} else if (serverVersion !== "" && node.version !== serverVersion) {
			offenders.push(node.hostname);
			problems.push(`${node.hostname} runs vibemon ${node.version === "" ? "unknown" : node.version}, the server ${serverVersion}`);
		}
	}
	if (problems.length === 0) return [{ id, status: "ok", detail: `accepting vibemon machines on ${address}; ${cluster.nodes.length} machines` }];
	const sync = `on ${offenders.join(", ")}: ${SYNC_FIX}`;
	return [{ id, status: "failed", detail: problems.join("; "), fix: dead ? `${sync}; a machine that is not alive may be off, or the network blocks TCP 7947 and 7946 (TCP and UDP) between the machines` : sync }];
}

/**
 * Runs the checks in order (preflight, system, user units, the service with its broker and gateway, the VM template,
 * the plugin) and concatenates their steps. A failed preflight does not stop the rest, and a check that throws becomes
 * one failed step with its message.
 */
export async function collectDoctor(deps: DoctorDeps): Promise<StepResult[]> {
	const steps: StepResult[] = [];
	steps.push(...(await guarded("doctor.preflight", async () => (await deps.preflight()).steps)));
	steps.push(...(await guarded("doctor.system", deps.systemChecks)));
	steps.push(...(await guarded("doctor.units", deps.userUnitChecks)));
	const { config } = deps;
	if (config === null) {
		steps.push({ id: "doctor.config", status: "failed", detail: "service.json is missing or invalid, so the service, the template and the broker cannot be checked", fix: "omp-cloud setup" });
	} else {
		steps.push(...(await guarded("doctor.service", () => serviceChecks(deps, config))));
		steps.push(...(await guarded("doctor.template", () => templateChecks(deps, config))));
		steps.push(...(await guarded("doctor.vmon-admin", () => vmonAdminChecks(deps, config))));
		steps.push(...(await guarded("doctor.cluster", () => clusterChecks(deps, config))));
	}
	steps.push(...(await guarded("doctor.plugin", deps.pluginChecks)));
	return steps;
}

const SERVICE_IP = "10.254.254.1";
const GATEWAY_URL = `http://${SERVICE_IP}:4000/healthz`;
/** A port of the service IP that VMs on a node must not reach: the server's remote listener. */
const RESTRICTED_URL = `http://${SERVICE_IP}:8443/`;
const SYNC_FIX = "sudo systemctl start omp-cloud-vmon-sync.service; journalctl -u omp-cloud-vmon-sync -n 20";
const JOIN_AGAIN = "omp-cloud uninstall --purge, then omp-cloud setup node --join <user@server>";
/** The units of a node, with the id each one's step has. */
const NODE_UNITS: readonly { id: string; unit: string }[] = [
	{ id: "doctor.node.vmon", unit: "vmon" },
	{ id: "doctor.node.net", unit: "omp-cloud-node-net" },
	{ id: "doctor.node.timer", unit: "omp-cloud-vmon-sync.timer" },
];

/** What the node doctor needs from the machine: a vibemon node has no service.json, no user units and no plugin to check. */
export interface NodeDoctorDeps {
	preflight: () => Promise<PreflightResult>;
	run: CommandRunner;
	/** `ip`: the user PATH of some distributions has no sbin. */
	ip: string;
	/** The text of `/etc/omp-cloud/node.env`; throws when it cannot be read. */
	readNodeEnv: () => Promise<string>;
	/** The text of the vmon unit; null when there is none. */
	readVmonUnit: () => Promise<string | null>;
}

interface NodeServer {
	url: string;
	address: string;
	pin: string;
}

/** How this machine reaches the server: on its own LAN, through a router, or not at all. */
type ServerRoute = { kind: "direct"; src: string } | { kind: "routed"; gateway: string; src: string } | { kind: "none"; detail: string };

/** The server `node.env` names, or what is wrong with the file. The pin is read the way the sync script reads it: line by line, never sourced. */
function parseNodeEnv(text: string): NodeServer | string {
	const values = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
		if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
	}
	const url = values.get("SERVER_URL") ?? "";
	const address = /^https:\/\/([0-9.]+):[0-9]+$/.exec(url)?.[1];
	if (address === undefined) return `SERVER_URL in ${NODE_ENV_FILE} is missing or is not https://<server address>:<port>`;
	const pin = values.get("SERVER_PIN") ?? "";
	if (!/^sha256\/\/[A-Za-z0-9+/]{43}=$/.test(pin)) return `SERVER_PIN in ${NODE_ENV_FILE} is missing or is not a sha256// certificate pin`;
	return { url, address, pin };
}

async function serverRoute(deps: NodeDoctorDeps, address: string): Promise<ServerRoute> {
	const result = await deps.run([deps.ip, "route", "get", address]);
	if (result.code !== 0) return { kind: "none", detail: result.stderr.trim() || `ip route get exited ${result.code}` };
	const src = /\bsrc (\S+)/.exec(result.stdout)?.[1] ?? "";
	const gateway = /\bvia (\S+)/.exec(result.stdout)?.[1];
	return gateway === undefined ? { kind: "direct", src } : { kind: "routed", gateway, src };
}

async function nodeUnitChecks(deps: NodeDoctorDeps, id: string, unit: string): Promise<StepResult[]> {
	const enabled = await deps.run(["systemctl", "is-enabled", unit]);
	const active = await deps.run(["systemctl", "is-active", unit]);
	const problems: string[] = [];
	if (enabled.code !== 0) problems.push("is not enabled");
	if (active.code !== 0) problems.push(`is not running (${active.stdout.trim() || "inactive"})`);
	if (problems.length === 0) return [{ id, status: "ok", detail: `${unit} is enabled and running` }];
	return [{ id, status: "failed", detail: `${unit} ${problems.join(" and ")}`, fix: `sudo systemctl enable --now ${unit}; journalctl -u ${unit} -n 20` }];
}

async function nodeSyncChecks(deps: NodeDoctorDeps): Promise<StepResult[]> {
	const id = "doctor.node.sync";
	const failed = await deps.run(["systemctl", "is-failed", "omp-cloud-vmon-sync.service"]);
	if (failed.stdout.trim() === "failed") return [{ id, status: "failed", detail: "the last vibemon sync failed: this machine could not move vibemon to the server's version", fix: SYNC_FIX }];
	return [{ id, status: "ok", detail: "the last vibemon sync did not fail" }];
}

/** Only a machine on the server's LAN carries a route for the service IP of its own: through a router, the router must have it (the gateway check finds out). */
async function nodeRouteChecks(deps: NodeDoctorDeps, address: string, route: ServerRoute): Promise<StepResult[]> {
	const id = "doctor.node.route";
	if (route.kind === "none") return [{ id, status: "failed", detail: `this machine has no route to the server at ${address} (${route.detail})`, fix: `check this machine's network: ip route get ${address}` }];
	if (route.kind === "routed") return [];
	const result = await deps.run([deps.ip, "route", "get", SERVICE_IP]);
	if (result.code === 0 && result.stdout.includes(` via ${address}`)) return [{ id, status: "ok", detail: `${SERVICE_IP} is routed to the server at ${address}` }];
	const shown = result.stdout.trim().split("\n")[0] ?? "";
	return [
		{
			id,
			status: "failed",
			detail: `${SERVICE_IP} is not routed to the server at ${address}${shown === "" ? "" : ` (${shown})`}`,
			fix: "sudo systemctl restart omp-cloud-node-net; journalctl -u omp-cloud-node-net -n 20",
		},
	];
}

/** The fix of a gateway that does not answer: the server's firewall, and a router that must route the service IP when this machine is not on the server's LAN. */
function gatewayFix(server: NodeServer | null, route: ServerRoute): string {
	const from = route.kind === "none" || route.src === "" ? "this machine" : route.src;
	const allow = `on the server, allow TCP 4000 and 4100 to ${SERVICE_IP} from ${from}`;
	return server !== null && route.kind === "routed" ? `on the router ${route.gateway}, route ${SERVICE_IP}/32 to ${server.address}; ${allow}` : allow;
}

async function nodeGatewayChecks(deps: NodeDoctorDeps, server: NodeServer | null, route: ServerRoute): Promise<StepResult[]> {
	const id = "doctor.node.gateway";
	const result = await deps.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", GATEWAY_URL]);
	const status = result.stdout.trim();
	if (status === "200") return [{ id, status: "ok", detail: `the server's model gateway answers at ${GATEWAY_URL}` }];
	const got = status === "" || status === "000" ? "no answer" : `HTTP ${status}`;
	return [{ id, status: "failed", detail: `the server's model gateway did not answer at ${GATEWAY_URL} (${got}): VMs here cannot call a model`, fix: gatewayFix(server, route) }];
}

/**
 * The units being active proves nothing about the node-net rules (a oneshot stays active after its rules are gone, and a
 * firewall manager may flush or precede them), so the restriction is tried: the server's remote listener answers on 8443 to
 * anything that reaches it, and what the node's host sends to the service IP outside TCP 4000 and 4100 must be rejected, for
 * an unprivileged curl as for a VM's traffic.
 */
async function nodeRestrictionChecks(deps: NodeDoctorDeps): Promise<StepResult[]> {
	const id = "doctor.node.restriction";
	const probe = await deps.run(["curl", "-s", "-m", "3", "-o", "/dev/null", RESTRICTED_URL]);
	if (probe.code !== 0) return [{ id, status: "ok", detail: `${RESTRICTED_URL} is refused: VMs here reach only TCP 4000 and 4100 of ${SERVICE_IP}` }];
	return [{ id, status: "failed", detail: `this machine reaches ${SERVICE_IP}:8443: the VM traffic restriction is not in force`, fix: "sudo systemctl restart omp-cloud-node-net vmon" }];
}

/** The vibemon the server runs (from its health answer, over the pinned certificate) against the one installed here. */
async function nodeVersionChecks(deps: NodeDoctorDeps, server: NodeServer): Promise<StepResult[]> {
	const id = "doctor.node.vmon-version";
	const health = await deps.run(["curl", "-q", "-sk", "--proto", "=https", "--pinnedpubkey", server.pin, "--max-filesize", "65536", "--max-time", "10", `${server.url}/api/v1/health`]);
	if (health.code === 90) return [{ id, status: "failed", detail: `the server at ${server.url} presented a certificate other than the pinned one`, fix: JOIN_AGAIN }];
	if (health.code !== 0) return [{ id, status: "failed", detail: `the server at ${server.url} did not answer (curl exit ${health.code})`, fix: `check that this machine reaches ${server.url}` }];
	let body: unknown;
	try {
		body = JSON.parse(health.stdout);
	} catch {
		body = null;
	}
	const wanted = isRecord(body) && typeof body.vmon === "string" ? body.vmon : null;
	if (wanted === null) return [{ id, status: "skipped", detail: `the server at ${server.url} does not report its vibemon version yet` }];
	let installed: string | null = null;
	try {
		const version = await deps.run([VMON_BINARY, "--version"]);
		const match = /^vmon (\d+\.\d+\.\d+)\s*$/.exec(version.stdout.trim());
		if (version.code === 0 && match?.[1] !== undefined) installed = `v${match[1]}`;
	} catch {
		// A missing binary is the same failure as one that reports no version.
	}
	if (installed === null) return [{ id, status: "failed", detail: `vibemon is not installed at ${VMON_BINARY}, or does not report its version`, fix: SYNC_FIX }];
	if (installed.replace(/^v/, "") !== wanted.replace(/^v/, "")) return [{ id, status: "failed", detail: `this machine runs vibemon ${installed}, the server ${wanted}`, fix: SYNC_FIX }];
	return [{ id, status: "ok", detail: `this machine runs vibemon ${installed}, the server's version` }];
}

/**
 * The checks of a vibemon node (a machine with `/etc/omp-cloud/node.env`): preflight in node mode, its three units, the last
 * sync, the route for the service IP, the server's model gateway and the vibemon version. A check that throws becomes one failed step.
 */
export async function collectNodeDoctor(deps: NodeDoctorDeps): Promise<StepResult[]> {
	const steps: StepResult[] = [];
	steps.push(...(await guarded("doctor.preflight", async () => (await deps.preflight()).steps)));
	let server: NodeServer | null = null;
	try {
		const parsed = parseNodeEnv(await deps.readNodeEnv());
		if (typeof parsed === "string") {
			steps.push({ id: "doctor.node.config", status: "failed", detail: parsed, fix: JOIN_AGAIN });
		} else {
			server = parsed;
			steps.push({ id: "doctor.node.config", status: "ok", detail: `this machine follows the omp-cloud server at ${parsed.url}` });
		}
	} catch (error) {
		steps.push({ id: "doctor.node.config", status: "failed", detail: `${NODE_ENV_FILE} cannot be read (${messageOf(error)})`, fix: JOIN_AGAIN });
	}
	for (const { id, unit } of NODE_UNITS) steps.push(...(await guarded(id, () => nodeUnitChecks(deps, id, unit))));
	steps.push(...(await guarded("doctor.node.vmm-user", async () => vmmUserCheck("doctor.node.vmm-user", await deps.readVmonUnit(), "omp-cloud setup node --join <user@server>"))));
	steps.push(...(await guarded("doctor.node.sync", () => nodeSyncChecks(deps))));
	let route: ServerRoute = { kind: "none", detail: `${NODE_ENV_FILE} names no server` };
	if (server !== null) {
		const { address } = server;
		try {
			route = await serverRoute(deps, address);
		} catch (error) {
			route = { kind: "none", detail: messageOf(error) };
		}
		const found = route;
		steps.push(...(await guarded("doctor.node.route", () => nodeRouteChecks(deps, address, found))));
	}
	steps.push(...(await guarded("doctor.node.gateway", () => nodeGatewayChecks(deps, server, route))));
	steps.push(...(await guarded("doctor.node.restriction", () => nodeRestrictionChecks(deps))));
	const followed = server;
	if (followed !== null) steps.push(...(await guarded("doctor.node.vmon-version", () => nodeVersionChecks(deps, followed))));
	return steps;
}

/** The node doctor's dependencies for `ctx`. */
export function nodeDoctorDeps(ctx: SetupContext): NodeDoctorDeps {
	return {
		preflight: () => preflight(ctx.preflight, "node"),
		run: ctx.run,
		ip: ctx.preflight.which("ip") ?? "ip",
		readNodeEnv: () => ctx.preflight.readText(NODE_ENV_FILE),
		readVmonUnit: () => ctx.preflight.readText(`${SYSTEM_UNIT_DIR}/${VMON_UNIT}`).catch(() => null),
	};
}

/** The one table: a line per step (`✓` changed, `·` ok, `-` skipped, `✗` failed; the fix under a failure), then the counts. `color` colours the marks. */
export function formatDoctor(steps: readonly StepResult[], color: boolean): string {
	let table = "";
	const append = (text: string) => {
		table += text;
	};
	const reporter = new Reporter({ out: append, err: append, color });
	const width = Math.max(0, ...steps.map((step) => step.id.length));
	for (const step of steps) reporter.report({ ...step, id: step.id.padEnd(width) });
	const count = (status: StepResult["status"]) => steps.filter((step) => step.status === status).length;
	return `${table}${count("ok")} ok, ${count("changed")} changed, ${count("skipped")} skipped, ${count("failed")} failed\n`;
}

/** The doctor's dependencies for `ctx`: what `omp-cloud doctor` and the end of `setup` check. */
export async function doctorDeps(ctx: SetupContext): Promise<DoctorDeps> {
	const omp = await findOmp(ctx);
	let config: Config | null = null;
	try {
		config = await loadConfig(ctx.paths.serviceJson);
	} catch {
		// A missing or invalid service.json is the doctor's `doctor.config` failure.
	}
	return {
		preflight: () => preflight(ctx.preflight, "doctor"),
		systemChecks: () => ctx.parts.systemChecks(ctx.run),
		userUnitChecks: () => userUnitChecks(ctx.run),
		pluginChecks: () =>
			ctx.parts.pluginChecks({
				run: ctx.run,
				omp,
				env: ctx.env,
				home: ctx.paths.home,
				...(config === null ? {} : { serviceUrl: healthBase(config.listen), tokenFile: ctx.paths.serviceToken }),
			}),
		health: ctx.health,
		config,
		readKey: () => readVmonKey(ctx.paths),
		ompVersion: async () => omp?.version ?? null,
		templateProbe: ctx.parts.templateProbe,
		clusterProbe: ctx.parts.clusterProbe,
		version: ctx.version,
	};
}

/** `omp-cloud doctor [--json]`: the table, exit 1 when anything failed. */
export async function doctorMain(argv: readonly string[], context?: SetupContext): Promise<number> {
	const json = argv.includes("--json");
	if (argv.some((arg) => arg !== "--json")) {
		process.stderr.write("omp-cloud: unknown argument\nusage: omp-cloud doctor [--json]\n");
		return 2;
	}
	const ctx = context ?? realContext(Reporter.forProcess(json));
	const steps = (await ctx.preflight.exists(NODE_ENV_FILE)) ? await collectNodeDoctor(nodeDoctorDeps(ctx)) : await collectDoctor(await doctorDeps(ctx));
	ctx.reporter.note(formatDoctor(steps, ctx.reporter.color).trimEnd());
	const ok = !steps.some((step) => step.status === "failed");
	if (json) ctx.stdout(`${JSON.stringify({ ok, steps })}\n`);
	return ok ? 0 : 1;
}
