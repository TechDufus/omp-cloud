/** Everything `setup`, `doctor` and `uninstall` touch outside their own code, so tests run them in a temp directory with fake commands. */
import { hostname as osHostname } from "node:os";
import { createInterface } from "node:readline/promises";
import type { HostOmp } from "../omp-version";
import { hostOmp } from "../omp-version";
import { type CommandRunner, runCommand } from "../update/system";
import { SERVICE_VERSION } from "../version";
import { type SetupPaths, setupPaths } from "./config";
import { type HealthDeps, realHealthDeps, realTemplateProbe, type TemplateProbe } from "./health";
import { loginStep, type LoginStepOptions, terminalIo, type LoginIo } from "./login";
import { ensurePlugin, type PluginChecksOptions, type PluginOptions, pluginChecks, type RemoveOptions, removePlugin } from "./plugin";
import { type PreflightDeps, realPreflightDeps } from "./preflight";
import { type SelfCommand, selfCommand } from "./root";
import type { Reporter, StepResult } from "./steps";
import { systemChecks } from "./system";
import type { Config } from "../config";
import { type ClusterView, VmonAdmin, VmonAdminUnavailable } from "../vmon/admin";

/** The functions of the plugin, login and root slices, so a test can answer for them. */
export interface SetupParts {
	ensurePlugin(options: PluginOptions): Promise<StepResult[]>;
	removePlugin(options: RemoveOptions): Promise<StepResult[]>;
	pluginChecks(options: PluginChecksOptions): Promise<StepResult[]>;
	loginStep(options: LoginStepOptions): Promise<StepResult[]>;
	systemChecks(run: CommandRunner): Promise<StepResult[]>;
	templateProbe(config: Config, key: string, ompVersion: string): Promise<TemplateProbe>;
	/** The cluster as vibemon's admin API reports it, read with `vmon.adminTokenFile`; throws `VmonAdminUnavailable` when the service has no token. */
	clusterProbe(config: Config): Promise<ClusterView>;
}

export interface SetupContext {
	run: CommandRunner;
	env: Record<string, string | undefined>;
	paths: SetupPaths;
	self: SelfCommand;
	/** This binary's version. */
	version: string;
	/** `process.getuid()`: setup refuses to run as 0. */
	uid: number;
	stdinIsTty: boolean;
	hostname: string;
	preflight: PreflightDeps;
	health: HealthDeps;
	reporter: Reporter;
	io: LoginIo;
	/** Asks a yes/no question (default yes); false when declined. */
	confirm(question: string): Promise<boolean>;
	hostOmp(env: Record<string, string | undefined>): Promise<HostOmp>;
	/** Where the `--json` report goes (process stdout). */
	stdout(text: string): void;
	parts: SetupParts;
}

async function askYesNo(question: string): Promise<boolean> {
	const lines = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await lines.question(`${question} `)).trim().toLowerCase();
		return answer === "" || answer === "y" || answer === "yes";
	} finally {
		lines.close();
	}
}

async function clusterProbe(config: Config): Promise<ClusterView> {
	const tokenFile = config.vmon.adminTokenFile;
	if (tokenFile === undefined) throw new VmonAdminUnavailable("service.json has no vmon.adminTokenFile");
	return (await VmonAdmin.open({ url: config.vmon.url, tokenFile })).cluster();
}

/** The real context for this process; `reporter` is the caller's (it knows whether stdout is the `--json` report). */
export function realContext(reporter: Reporter): SetupContext {
	return {
		run: runCommand,
		env: process.env,
		paths: setupPaths(),
		self: selfCommand(),
		version: SERVICE_VERSION,
		uid: process.getuid?.() ?? -1,
		stdinIsTty: process.stdin.isTTY === true,
		hostname: osHostname(),
		preflight: realPreflightDeps(),
		health: realHealthDeps,
		reporter,
		io: terminalIo(),
		confirm: askYesNo,
		hostOmp,
		stdout: (text) => void process.stdout.write(text),
		parts: { ensurePlugin, removePlugin, pluginChecks, loginStep, systemChecks, templateProbe: realTemplateProbe, clusterProbe },
	};
}

/** The omp this user has (Tern's, else PATH, plus `~/.local/bin` where omp's installer puts it), or undefined when there is none. A terminal whose `omp` resolves to a stale build older than the plugin's minimum cannot load the plugin, whatever is found here. */
export async function findOmp(ctx: SetupContext): Promise<HostOmp | undefined> {
	const path = `${ctx.env.PATH ?? ""}:${ctx.paths.binDir}`;
	try {
		return await ctx.hostOmp({ ...ctx.env, PATH: path });
	} catch {
		return undefined;
	}
}
