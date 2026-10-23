/** `omp-cloud doctor`: every check of the host and the stack as one table, a fix beside each failure. */
import { type Config, loadConfig } from "../config";
import { adminProblem } from "../vmon/capacity";
import { type ClusterView, VmonAdminUnavailable } from "../vmon/admin";
import { isRecord } from "../guards";
import { healthBase } from "../update/real";
import { type SetupContext, findOmp, realContext } from "./context";
import { readVmonKey } from "./config";
import type { HealthDeps, TemplateProbe } from "./health";
import { type PreflightResult, preflight } from "./preflight";
import { Reporter, type StepResult } from "./steps";
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
	}
	steps.push(...(await guarded("doctor.plugin", deps.pluginChecks)));
	return steps;
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
	const steps = await collectDoctor(await doctorDeps(ctx));
	ctx.reporter.note(formatDoctor(steps, ctx.reporter.color).trimEnd());
	const ok = !steps.some((step) => step.status === "failed");
	if (json) ctx.stdout(`${JSON.stringify({ ok, steps })}\n`);
	return ok ? 0 : 1;
}
