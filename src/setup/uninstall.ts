/**
 * `omp-cloud uninstall [--purge] [--yes] [--checkout]`: stops and removes the user units, the plugin and the `~/.local/bin`
 * link, then runs the root part with `--uninstall` (vmon's and the network's system units, the helper and its sudoers rule,
 * linger when setup enabled it). `--purge` also removes vibemon's files and every omp-cloud directory of this user; backups
 * are always kept. On a vibemon node (`/etc/omp-cloud/node.env` exists) there are no user units, plugin, sandboxes of the
 * team or service data: it removes the link and runs the root part, and `--purge` also removes the app directory.
 */
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord } from "../guards";
import { findOmp, realContext, type SetupContext } from "./context";
import { readVmonKey } from "./config";
import { removeAppDir, removeBinaryLink } from "./managed";
import { personalConfigPath } from "./plugin";
import { runRootPart, sudoCommand, sudoReady } from "./root";
import { Reporter, type StepResult } from "./steps";
import { NODE_ENV_FILE } from "./system";
import { removeUserUnits } from "./units";

const USAGE = "usage: omp-cloud uninstall [--purge] [--yes] [--checkout]";
const VMON_BASE = "http://127.0.0.1:3000";
/** vmon lists at most this many sandboxes per call (the team runs a few). */
const SANDBOX_PAGE = 100;

export interface UninstallArgs {
	purge: boolean;
	yes: boolean;
	checkout: boolean;
}

export type ParsedUninstallArgs = { ok: true; args: UninstallArgs } | { ok: false; error: string };

export function parseUninstallArgs(argv: readonly string[]): ParsedUninstallArgs {
	const args: UninstallArgs = { purge: false, yes: false, checkout: false };
	for (const flag of argv) {
		if (flag === "--purge") args.purge = true;
		else if (flag === "--yes" || flag === "-y") args.yes = true;
		else if (flag === "--checkout") args.checkout = true;
		else return { ok: false, error: `unknown argument ${JSON.stringify(flag)}` };
	}
	return { ok: true, args };
}

/** What uninstall will do and keep, printed before anything is removed. `node`: this machine is a vibemon node, which has none of the server's user units, plugin or data. */
export function buildUninstallPlan(args: UninstallArgs, ctx: SetupContext, node: boolean): string[] {
	const { paths } = ctx;
	if (node) {
		const lines = [
			"omp-cloud uninstall will:",
			"  - remove the ~/.local/bin/omp-cloud link",
			"  - as root (asks for sudo once): stop and remove the system units vmon, omp-cloud-node-net and omp-cloud-vmon-sync (with its timer), the vibemon install and sync helpers and the sudoers rule, and /etc/omp-cloud/node.env",
			"  - VMs running on this machine are lost; the server restores their threads on its other machines",
		];
		if (args.purge) {
			lines.push("  - --purge: also delete vibemon (/opt/vmon, /var/lib/vmon with every VM and template, /etc/vmon), /etc/omp-cloud and the system user omp-cloud-vmm", `  - --purge: also delete ${paths.appDir}`);
		}
		lines.push(`kept: ${args.purge ? paths.configDir : `${paths.appDir} and vibemon's data`}`);
		return lines;
	}
	const lines = [
		"omp-cloud uninstall will:",
		"  - stop and remove the user units omp-auth-broker, omp-auth-gateway, omp-cloud and omp-cloud-backup (with its timer)",
		`  - ${args.purge ? "kill" : "pause"} the sandboxes of the omp-cloud team`,
		"  - remove the omp plugin",
		"  - remove the ~/.local/bin/omp-cloud link",
		"  - as root (asks for sudo once): stop and remove the system units omp-cloud-net and vmon, the vibemon install helper and its sudoers rule, and linger when setup enabled it",
	];
	if (args.purge) {
		lines.push(
			"  - --purge: also delete vibemon (/opt/vmon, /var/lib/vmon with every VM and template, /etc/vmon), /etc/omp-cloud and the system user omp-cloud-vmm",
			`  - --purge: also delete ${paths.configDir} (service config, API token, team key, the TLS identity: paired devices must pair again)`,
			`  - --purge: also delete ${paths.authHome} (the model broker's vault: every model login is lost)`,
			`  - --purge: also delete ${paths.dataDir} (threads and their data) and ${paths.appDir}`,
		);
	}
	lines.push(`kept: backups in ${join(dirname(paths.dataDir), "backups")}${args.purge ? "" : `, ${paths.configDir}, ${paths.authHome}, ${paths.dataDir}, ${paths.appDir} and vibemon's data`}`);
	return lines;
}

/** The team's sandboxes: `pause` the running ones, or on a purge `kill` the running and paused ones. Never throws. */
async function retireSandboxes(ctx: SetupContext, purge: boolean): Promise<StepResult> {
	const id = "uninstall.sandboxes";
	const key = await readVmonKey(ctx.paths);
	if (key === null) return { id, status: "skipped", detail: "no team key, so there are no sandboxes to ask vmon about" };
	const headers = { "X-API-Key": key };
	try {
		const health = await ctx.health.fetch(`${VMON_BASE}/health`);
		if (health.status !== 204) return { id, status: "skipped", detail: "vmon is not running, so it holds no running sandboxes" };
		const state = purge ? "running,paused" : "running";
		const list = await ctx.health.fetch(`${VMON_BASE}/v2/sandboxes?state=${state}&limit=${SANDBOX_PAGE}`, { headers });
		if (list.status !== 200) return { id, status: "skipped", detail: `vmon answered HTTP ${list.status} to the sandbox list (the key may be stale); nothing was ${purge ? "killed" : "paused"}` };
		const body: unknown = await list.json();
		const ids = Array.isArray(body) ? body.flatMap((item: unknown) => (isRecord(item) && typeof item.sandboxID === "string" ? [item.sandboxID] : [])) : [];
		let done = 0;
		for (const sandbox of ids) {
			const response = purge
				? await ctx.health.fetch(`${VMON_BASE}/sandboxes/${encodeURIComponent(sandbox)}`, { method: "DELETE", headers })
				: await ctx.health.fetch(`${VMON_BASE}/sandboxes/${encodeURIComponent(sandbox)}/pause`, { method: "POST", headers });
			if (response.status < 300) done++;
		}
		return { id, status: ids.length === 0 ? "ok" : "changed", detail: `${done} of ${ids.length} sandboxes ${purge ? "killed" : "paused"}` };
	} catch (error) {
		return { id, status: "skipped", detail: `could not reach vmon: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function removeDir(id: string, path: string): Promise<StepResult> {
	await rm(path, { recursive: true, force: true });
	return { id, status: "changed", detail: `removed ${path}` };
}

/** Runs uninstall. Returns the exit code: 0 ok, 1 failed, 2 usage. */
export async function runUninstall(args: UninstallArgs, ctx: SetupContext): Promise<number> {
	const { reporter, paths } = ctx;
	const finish = (): number => (reporter.failed ? 1 : 0);
	if (ctx.uid === 0) {
		reporter.report({ id: "uninstall.user", status: "failed", detail: "run omp-cloud uninstall as your user; it asks for sudo once" });
		return finish();
	}
	if (!ctx.self.compiled && !args.checkout) {
		reporter.report({ id: "uninstall.binary", status: "failed", detail: "run omp-cloud uninstall from the installed binary, or pass --checkout in a checkout" });
		return finish();
	}
	const node = await ctx.preflight.exists(NODE_ENV_FILE);
	reporter.note(buildUninstallPlan(args, ctx, node).join("\n"));
	if (!args.yes) {
		if (!ctx.stdinIsTty) {
			process.stderr.write("omp-cloud: no terminal to ask on; run omp-cloud uninstall in a terminal, or pass --yes\n");
			return 2;
		}
		if (!(await ctx.confirm("Continue? [y/N]"))) {
			reporter.warn("nothing was removed");
			return 1;
		}
	}
	const rootArguments = ["--uninstall", "--user", paths.user, ...(args.purge ? ["--purge"] : [])];
	if (!(await sudoReady(ctx.run)) && !ctx.stdinIsTty) {
		reporter.report({
			id: "sudo",
			status: "failed",
			detail: "uninstall needs sudo once and cannot ask for a password without a terminal; nothing was removed",
			fix: `run omp-cloud uninstall in a terminal, or run the root part there: ${sudoCommand(ctx.self, rootArguments).join(" ")}`,
		});
		return finish();
	}

	if (node) {
		reporter.report(await removeBinaryLink(paths));
	} else {
		// The service first: its runner reconnects to a VM that pauses under it.
		reporter.reportAll(await removeUserUnits(paths, ctx.run));
		reporter.report(await retireSandboxes(ctx, args.purge));
		const omp = await findOmp(ctx);
		reporter.reportAll(await ctx.parts.removePlugin({ run: ctx.run, omp, mode: args.checkout ? "checkout" : "managed", appDir: paths.appDir }));
		reporter.report(await removeBinaryLink(paths));
	}

	const root = await runRootPart(ctx.run, ctx.self, rootArguments);
	if (root.ok) {
		reporter.collect(root.report.steps);
	} else if (root.report !== null) {
		reporter.collect(root.report.steps);
		if (!root.report.steps.some((step) => step.status === "failed")) reporter.reportAll(root.steps);
	} else {
		reporter.reportAll(root.steps);
	}
	if (reporter.failed) return finish();

	if (node) {
		if (args.purge) reporter.report(await removeAppDir(paths));
		reporter.note(`kept: ${args.purge ? paths.configDir : `${paths.appDir} and vibemon's data (omp-cloud uninstall --purge removes them)`}`);
		return finish();
	}
	if (args.purge) {
		reporter.report(await removeDir("uninstall.config", paths.configDir));
		const personal = personalConfigPath(ctx.env, paths.home);
		if (!personal.startsWith(`${paths.configDir}/`)) await rm(personal, { force: true });
		reporter.report(await removeDir("uninstall.auth-home", paths.authHome));
		reporter.report(await removeDir("uninstall.data", paths.dataDir));
		reporter.report(await removeAppDir(paths));
	}
	const backups = join(dirname(paths.dataDir), "backups");
	const kept = await readdir(backups).then((names) => names.length, () => 0);
	reporter.note(`kept: backups in ${backups}${kept > 0 ? ` (${kept} files)` : ""}${args.purge ? "" : `; ${paths.configDir}, ${paths.authHome}, ${paths.dataDir} and ${paths.appDir} (omp-cloud uninstall --purge removes them)`}`);
	return finish();
}

/** `omp-cloud uninstall …`; `argv` follows the word `uninstall`. */
export async function uninstallMain(argv: readonly string[], context?: SetupContext): Promise<number> {
	const parsed = parseUninstallArgs(argv);
	if (!parsed.ok) {
		process.stderr.write(`omp-cloud: ${parsed.error}\n${USAGE}\n`);
		return 2;
	}
	return runUninstall(parsed.args, context ?? realContext(Reporter.forProcess(false)));
}
