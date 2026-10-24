/**
 * `omp-cloud setup`: preflight, the plan, one sudo for the root part, the user part (config, TLS, units), the plugin, the
 * health waits, the model login and the doctor table. Idempotent: a rerun reports what is already right and repairs drift.
 */
import { type Config, loadConfig, TEAM_SLUG } from "../config";
import type { HostOmp } from "../omp-version";
import { healthBase } from "../update/real";
import { Units } from "../update/system";
import { VMON_PIN } from "../vmon/pin";
import { DEFAULT_TEAM, ensureAdminToken, ensureClusterSecret, ensureDirs, ensureGatewayClients, ensureServiceConfig, readVmonKey, recordedClusterAddress, recordedTeam, writeFileAtomic, writeVmonKey } from "./config";
import { findOmp, realContext, type SetupContext } from "./context";
import { collectDoctor, doctorDeps, formatDoctor } from "./doctor";
import { checkVmonKey, waitGateway, waitService, waitTemplate } from "./health";
import { isPlainIpv4 } from "./ipv4";
import { installCheckoutWrapper, installManagedBinary } from "./managed";
import { packagesFor } from "./packages";
import { type PreflightResult, preflight } from "./preflight";
import { type RootRequest, rootArgs, runRootPart, sudoCommand, sudoReady } from "./root";
import { Reporter, type StepResult } from "./steps";
import { NODE_ENV_FILE, type SystemReport } from "./system";
import { ensureTls } from "./tls";
import { installUserUnits, type UnitMode, unitSearchPath } from "./units";

const USAGE = `usage: omp-cloud setup [--yes] [--no-login] [--no-plugin] [--no-linger] [--no-wait] [--team <slug>] [--max-sandboxes <n>] [--migrate-team] [--cluster-address <ip> | --no-cluster] [--checkout] [--json]`;
const OMP_INSTALL = "curl -fsSL https://omp.sh/install | sh";
const OMP_INSTALL_TIMEOUT_MS = 5 * 60_000;
const LOGIN_LATER = "log in later: omp-cloud login <provider>";

export interface SetupArgs {
	yes: boolean;
	noLogin: boolean;
	noPlugin: boolean;
	noLinger: boolean;
	noWait: boolean;
	/** The vibemon team slug for a new host. */
	team?: string;
	maxSandboxes?: number;
	/** The LAN address vmon listens on for other vibemon machines (`--cluster-address`); undefined: what the host already does. */
	clusterAddress?: string;
	/** `--no-cluster`: stop listening for other vibemon machines. */
	noCluster: boolean;
	migrateTeam: boolean;
	checkout: boolean;
	json: boolean;
}

export type ParsedSetupArgs = { ok: true; args: SetupArgs } | { ok: false; error: string };

type SwitchFlag = "yes" | "noLogin" | "noPlugin" | "noLinger" | "noWait" | "migrateTeam" | "checkout" | "json" | "noCluster";

const SWITCHES: Readonly<Record<string, SwitchFlag>> = {
	"--yes": "yes",
	"-y": "yes",
	"--no-login": "noLogin",
	"--no-plugin": "noPlugin",
	"--no-linger": "noLinger",
	"--no-wait": "noWait",
	"--migrate-team": "migrateTeam",
	"--checkout": "checkout",
	"--no-cluster": "noCluster",
	"--json": "json",
};

/** Validates `setup`'s flags; an error is a usage error (exit 2). */
export function parseSetupArgs(argv: readonly string[]): ParsedSetupArgs {
	const args: SetupArgs = { yes: false, noLogin: false, noPlugin: false, noLinger: false, noWait: false, migrateTeam: false, noCluster: false, checkout: false, json: false };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index] ?? "";
		const switchName = SWITCHES[flag];
		if (switchName !== undefined) {
			args[switchName] = true;
			continue;
		}
		if (flag === "--team") {
			const value = argv[++index];
			if (value === undefined || !TEAM_SLUG.test(value) || value === "system") return { ok: false, error: "--team needs a slug: lowercase letters, digits and hyphens, at most 63 characters, not `system`" };
			args.team = value;
			continue;
		}
		if (flag === "--max-sandboxes") {
			const value = argv[++index];
			const count = value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : 0;
			if (count < 1 || count > 1000) return { ok: false, error: "--max-sandboxes needs a whole number from 1 to 1000" };
			args.maxSandboxes = count;
			continue;
		}
		if (flag === "--cluster-address") {
			const value = argv[++index];
			if (value === undefined || !isPlainIpv4(value)) return { ok: false, error: "--cluster-address needs an IPv4 address: this server's LAN address that other vibemon machines reach" };
			args.clusterAddress = value;
			continue;
		}
		return { ok: false, error: `unknown argument ${JSON.stringify(flag)}` };
	}
	if (args.noCluster && args.clusterAddress !== undefined) return { ok: false, error: "--cluster-address and --no-cluster cannot be used together" };
	return { ok: true, args };
}

/** What setup will do, printed before anything changes. */
export interface PlanInput {
	args: SetupArgs;
	pre: PreflightResult;
	packages: readonly string[];
	team: string;
	user: string;
	version: string;
	appDir: string;
	configDir: string;
	migrateFrom: string | null;
	/** The LAN address vibemon will listen on for other machines after this run, and what service.json records now; null: none. */
	clusterAddress?: string | null;
	clusterWas?: string | null;
}

export function buildPlan(input: PlanInput): string[] {
	const { args, pre } = input;
	const lines = [`omp-cloud setup ${input.version} will:`, "", "as root (asks for sudo once):"];
	if (input.packages.length > 0 && pre.packageManager !== null) lines.push(`  - install packages with ${pre.packageManager}: ${input.packages.join(" ")}`);
	lines.push(
		`  - install the vibemon ${VMON_PIN} helper and a sudoers rule that lets ${input.user} run only that helper (the updater uses it)`,
		`  - install vibemon ${VMON_PIN} in /opt/vmon`,
		"  - add the service network (ompsvc0, 10.254.254.1) and the system units omp-cloud-net and vmon, which start at boot",
		`  - make sure the vibemon team ${input.team} exists with its limits${args.maxSandboxes === undefined ? "" : ` (${args.maxSandboxes} sandboxes)`}`,
	);
	const cluster = input.clusterAddress ?? null;
	const clusterWas = input.clusterWas ?? null;
	if (cluster !== null && cluster !== clusterWas) {
		lines.push(`  - let other vibemon machines join: vmon listens for them on ${cluster} (ports 7946 and 7947) and restarts, so a turn running now is re-run`);
	} else if (cluster === null && clusterWas !== null) {
		lines.push("  - stop listening for other vibemon machines (vmon restarts; machines that joined lose contact, and threads whose VMs ran there are restored on this server)");
	}
	if (input.migrateFrom !== null) lines.push(`  - switch the team from ${input.migrateFrom} to ${input.team} (paused threads come back as cold restores and the VM template rebuilds)`);
	if (!args.noLinger) lines.push(`  - enable linger for ${input.user} (loginctl enable-linger), so the services start at boot without a login`);
	lines.push("", `as ${input.user}:`);
	if (pre.omp === null) lines.push(`  - install omp with its own installer (${OMP_INSTALL})`);
	lines.push(
		`  - config in ${input.configDir} (service.json, an API token, a TLS identity for paired devices)`,
		args.checkout ? "  - run the service from this checkout (bun)" : `  - install this binary into ${input.appDir} (it updates itself there) and link ~/.local/bin/omp-cloud`,
		"  - user units omp-auth-broker, omp-auth-gateway, omp-cloud and a daily omp-cloud-backup timer",
	);
	if (!args.noPlugin) lines.push("  - install the omp plugin");
	lines.push(args.noWait ? "  - not wait for the VM template (--no-wait); it builds in the background" : "  - wait for the services and the VM template (nested KVM builds can take a while)");
	if (!args.noLogin && !args.yes) lines.push("  - help you log in to a model provider");
	return lines;
}

/** The exit code and, under `--json`, the report. */
function finish(ctx: SetupContext, args: SetupArgs): number {
	const ok = !ctx.reporter.failed;
	if (args.json) ctx.stdout(`${JSON.stringify({ ok, steps: ctx.reporter.steps })}\n`);
	return ok ? 0 : 1;
}

/** The team the root part is asked for, and whether this run switches teams. */
interface TeamPlan {
	/** `--team` for the root part; undefined: its default. */
	requested: string | undefined;
	migrate: boolean;
	/** The slug service.json records; undefined: the root part's report decides. */
	record: string | undefined;
	/** The old slug on a switch. */
	from: string | null;
}

async function planTeam(ctx: SetupContext, args: SetupArgs): Promise<TeamPlan | string> {
	const { paths } = ctx;
	const old = await recordedTeam(paths);
	if (args.migrateTeam && old !== null) {
		const target = args.team ?? DEFAULT_TEAM;
		if (target !== old) return { requested: target, migrate: true, record: target, from: old };
		return { requested: old, migrate: false, record: old, from: null };
	}
	if (args.team !== undefined && old !== null && args.team !== old) {
		return `this host's vibemon team is ${old}; --team ${args.team} would need --migrate-team (paused threads come back as cold restores and the VM template rebuilds)`;
	}
	return { requested: old ?? args.team, migrate: false, record: old ?? undefined, from: null };
}

/** Installs omp with its own installer as the user; the omp afterwards, or a failed step. */
async function installOmp(ctx: SetupContext): Promise<HostOmp | undefined> {
	const result = await ctx.run(["sh", "-c", OMP_INSTALL], { timeoutMs: OMP_INSTALL_TIMEOUT_MS, inherit: true });
	const omp = result.code === 0 ? await findOmp(ctx) : undefined;
	if (omp === undefined) {
		ctx.reporter.report({ id: "omp", status: "failed", detail: `omp's installer did not leave a working omp (exit ${result.code})`, fix: OMP_INSTALL });
		return undefined;
	}
	ctx.reporter.report({ id: "omp", status: "changed", detail: `omp ${omp.version} installed at ${omp.path}` });
	return omp;
}

/** `vmon.key` for the team: from the report when one was minted, else the file when vmon still accepts it, else a second root call mints one. */
async function ensureKey(ctx: SetupContext, request: RootRequest, report: SystemReport, plan: TeamPlan, teamSlug: string): Promise<boolean> {
	const { reporter, paths } = ctx;
	let key = report.key;
	if (key === undefined && !plan.migrate) {
		const existing = await readVmonKey(paths);
		const state = existing === null ? "missing" : await checkVmonKey(ctx.health, existing);
		if (state === "good") {
			reporter.report({ id: "config.key", status: "ok", detail: `the team key in ${paths.vmonKey} works` });
			return true;
		}
		if (state === "down") {
			reporter.report({ id: "config.key", status: "failed", detail: "vmon did not answer the key check", fix: "journalctl -u vmon -n 50" });
			return false;
		}
		reporter.note(`${state === "missing" ? "no team key yet" : "the team key in vmon.key is not known to vmon (the team was recreated)"}: minting one`);
	}
	if (key === undefined) {
		const second = await runRootPart(ctx.run, ctx.self, rootArgs({ ...request, team: teamSlug, mintKey: true, migrateTeam: false, packages: [] }));
		if (!second.ok) {
			reportRootFailure(ctx, second);
			return false;
		}
		reporter.collect(second.report.steps);
		key = second.report.key;
	}
	if (key === undefined) {
		reporter.report({ id: "config.key", status: "failed", detail: "the root part minted no team key", fix: `sudo -- ${ctx.self.argv.join(" ")} setup system ${rootArgs({ ...request, team: teamSlug, mintKey: true }).join(" ")}` });
		return false;
	}
	if (plan.migrate && plan.from !== null) {
		const old = await readVmonKey(paths);
		if (old !== null) await writeFileAtomic(`${paths.vmonKey}.${plan.from}`, old, 0o600);
	}
	await writeVmonKey(paths, key);
	reporter.report({ id: "config.key", status: "changed", detail: `the team key was written to ${paths.vmonKey}${plan.migrate && plan.from !== null ? ` (the old one is kept as vmon.key.${plan.from})` : ""}` });
	return true;
}

function reportRootFailure(ctx: SetupContext, outcome: { report: SystemReport | null; steps: StepResult[] }): void {
	if (outcome.report !== null) {
		ctx.reporter.collect(outcome.report.steps);
		if (outcome.report.steps.some((step) => step.status === "failed")) return;
	}
	ctx.reporter.reportAll(outcome.steps);
}

/** The service's `listen` as a base URL, from the config setup just wrote. */
async function readConfig(ctx: SetupContext): Promise<Config | null> {
	try {
		return await loadConfig(ctx.paths.serviceJson);
	} catch (error) {
		ctx.reporter.report({ id: "config.service", status: "failed", detail: error instanceof Error ? error.message : String(error), fix: "fix service.json, or move it aside and run omp-cloud setup again" });
		return null;
	}
}

/** Runs setup. Returns the exit code: 0 ok, 1 failed, 2 usage. */
export async function runSetup(args: SetupArgs, ctx: SetupContext): Promise<number> {
	const { reporter, paths } = ctx;
	if (ctx.uid === 0) {
		reporter.report({ id: "setup.user", status: "failed", detail: "run omp-cloud setup as your user; it asks for sudo once" });
		return finish(ctx, args);
	}
	if (!ctx.self.compiled && !args.checkout) {
		reporter.report({ id: "setup.binary", status: "failed", detail: "run omp-cloud setup from a release binary, or mise run infra:up in a checkout" });
		return finish(ctx, args);
	}
	if (ctx.self.compiled && args.checkout) {
		process.stderr.write("omp-cloud: --checkout is for a checkout (bun run src/bin.ts setup --checkout); a release binary installs itself\n");
		return 2;
	}
	if (await ctx.preflight.exists(NODE_ENV_FILE)) {
		reporter.report({ id: "setup.node", status: "failed", detail: "this machine is a vibemon node; omp-cloud uninstall first", fix: "omp-cloud uninstall" });
		return finish(ctx, args);
	}

	const clusterWas = await recordedClusterAddress(paths);
	const clusterAddress = args.noCluster ? null : (args.clusterAddress ?? clusterWas);
	const pre = await preflight(ctx.preflight, "setup", clusterAddress === null ? {} : { clusterAddress });
	reporter.reportAll(pre.steps);
	if (pre.blocked) return finish(ctx, args);

	const plan = await planTeam(ctx, args);
	if (typeof plan === "string") {
		process.stderr.write(`omp-cloud: ${plan}\n`);
		return 2;
	}
	const packages = pre.packageManager !== null && pre.missingTools.length > 0 ? packagesFor(pre.packageManager, pre.missingTools) : [];
	const request: RootRequest = {
		user: paths.user,
		...(plan.requested === undefined ? {} : { team: plan.requested }),
		...(args.maxSandboxes === undefined ? {} : { maxSandboxes: args.maxSandboxes }),
		packages,
		noLinger: args.noLinger,
		migrateTeam: plan.migrate,
		...(clusterAddress === null ? {} : { clusterAddress }),
	};
	const lines = buildPlan({ args, pre, packages, team: plan.requested ?? DEFAULT_TEAM, user: paths.user, version: ctx.version, appDir: paths.appDir, configDir: paths.configDir, migrateFrom: plan.from, clusterAddress, clusterWas });
	reporter.note(lines.join("\n"));
	if (!args.yes) {
		if (!ctx.stdinIsTty) {
			process.stderr.write("omp-cloud: no terminal to ask on; run omp-cloud setup in a terminal, or pass --yes\n");
			return 2;
		}
		if (!(await ctx.confirm("Continue? [Y/n]"))) {
			reporter.warn("nothing was changed");
			return 1;
		}
	}
	if (!(await sudoReady(ctx.run)) && !ctx.stdinIsTty) {
		reporter.report({
			id: "sudo",
			status: "failed",
			detail: "setup needs sudo once and cannot ask for a password without a terminal; nothing was changed",
			fix: `run omp-cloud setup in a terminal, or run the root part there: ${sudoCommand(ctx.self, rootArgs(request)).join(" ")}`,
		});
		return finish(ctx, args);
	}

	let omp: HostOmp | undefined = pre.omp ?? undefined;
	if (omp === undefined) {
		omp = await installOmp(ctx);
		if (omp === undefined) return finish(ctx, args);
	}

	reporter.report(await ensureDirs(paths));

	if (plan.migrate) {
		try {
			await new Units(ctx.run).stop("omp-cloud");
		} catch {
			// Not loaded or not running: nothing to stop.
		}
	}
	const root = await runRootPart(ctx.run, ctx.self, rootArgs(request));
	if (!root.ok) {
		reportRootFailure(ctx, root);
		return finish(ctx, args);
	}
	reporter.collect(root.report.steps);
	const rootTeam = root.report.team;
	if (rootTeam === null) {
		reporter.report({ id: "system", status: "failed", detail: "the root part reported no vibemon team", fix: "omp-cloud setup" });
		return finish(ctx, args);
	}
	if (!(await ensureKey(ctx, request, root.report, plan, rootTeam.slug))) return finish(ctx, args);
	reporter.report(await ensureAdminToken(paths, root.report.adminToken));
	const clusterSecret = await ensureClusterSecret(paths, clusterAddress, root.report.clusterSecret);
	if (clusterSecret !== null) reporter.report(clusterSecret);
	if (reporter.failed) return finish(ctx, args);
	if (plan.migrate) reporter.note("the team changed: paused threads come back as cold restores and the VM template rebuilds");

	reporter.report(await ensureTls(paths.tlsDir, ctx.hostname));
	const slug = plan.record ?? rootTeam.slug;
	const config = await ensureServiceConfig(paths, slug, clusterAddress);
	reporter.reportAll(config.steps);
	if (reporter.failed) return finish(ctx, args);
	try {
		reporter.reportAll(await ensureGatewayClients(paths, args.checkout));
	} catch (error) {
		reporter.report({
			id: "config.clients",
			status: "failed",
			detail: error instanceof Error ? error.message : String(error),
			fix: `fix ${paths.clientsFile} (it maps each gateway client to its token digest), or move it aside and run omp-cloud setup again`,
		});
		return finish(ctx, args);
	}

	let mode: UnitMode;
	if (args.checkout) {
		mode = { kind: "checkout", repoRoot: ctx.self.repoRoot, bunBin: ctx.self.argv[0] ?? "bun" };
		reporter.report(await installCheckoutWrapper(paths, { bunBin: mode.bunBin, repoRoot: mode.repoRoot, unitPath: unitSearchPath(omp.path, mode) }));
	} else {
		mode = { kind: "managed" };
		const installed = await installManagedBinary(paths, ctx.self.argv[0] ?? "", ctx.run);
		reporter.reportAll(installed.steps);
	}
	if (reporter.failed) return finish(ctx, args);
	reporter.reportAll(await installUserUnits({ paths, mode, ompBin: omp.path }, ctx.run));
	if (reporter.failed) return finish(ctx, args);

	if (args.noPlugin) {
		reporter.report({ id: "plugin", status: "skipped", detail: "--no-plugin: install it later with omp plugin marketplace add TechDufus/omp-cloud" });
	} else {
		reporter.reportAll(
			await ctx.parts.ensurePlugin({
				run: ctx.run,
				omp,
				mode: mode.kind,
				appDir: paths.appDir,
				version: ctx.version,
				...(mode.kind === "checkout" ? { repoRoot: mode.repoRoot } : {}),
				configPath: paths.serviceJson,
				tokenFile: paths.serviceToken,
				env: ctx.env,
				home: paths.home,
			}),
		);
	}

	const loaded = await readConfig(ctx);
	if (loaded === null) return finish(ctx, args);
	reporter.report(await waitGateway(ctx.health));
	reporter.report(await waitService(ctx.health, healthBase(loaded.listen), ctx.version));
	if (reporter.failed) return finish(ctx, args);

	const key = await readVmonKey(paths);
	if (key !== null) {
		const probe = await ctx.parts.templateProbe(loaded, key, omp.version);
		reporter.report(await waitTemplate(ctx.health, probe, { noWait: args.noWait, progress: (line) => reporter.note(line) }));
	}

	if (args.noLogin || args.yes) {
		reporter.note(LOGIN_LATER);
	} else {
		reporter.reportAll(await ctx.parts.loginStep({ serviceUrl: healthBase(loaded.listen), tokenFile: paths.serviceToken, io: ctx.io }));
	}

	// The preflight rows were printed at the start (and setup has since fixed what it could): the closing table is the rest.
	const table = (await collectDoctor(await doctorDeps(ctx))).filter((row) => !row.id.startsWith("preflight."));
	reporter.collect(table);
	reporter.note(formatDoctor(table, reporter.color).trimEnd());
	return finish(ctx, args);
}

/** `omp-cloud setup …`; `argv` follows the word `setup`. */
export async function setupMain(argv: readonly string[], context?: SetupContext): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const parsed = parseSetupArgs(argv);
	if (!parsed.ok) {
		process.stderr.write(`omp-cloud: ${parsed.error}\n${USAGE}\n`);
		return 2;
	}
	return runSetup(parsed.args, context ?? realContext(Reporter.forProcess(parsed.args.json)));
}
