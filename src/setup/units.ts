/**
 * The systemd user units of a persistent install, rendered in TypeScript (the release binary carries no template files):
 * the omp auth broker and gateway, the service itself, and the daily backup with its timer. `installUserUnits` verifies
 * them with `systemd-analyze`, writes the ones that changed, and enables them; every command goes through the
 * `CommandRunner` seam.
 */
import { chmod, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppLayout } from "../update/layout";
import { type CommandResult, type CommandRunner, Units } from "../update/system";
import { SERVICE_IP, type SetupPaths } from "./config";
import type { StepResult } from "./steps";

export const USER_SERVICES = ["omp-auth-broker", "omp-auth-gateway", "omp-cloud"] as const;

const BACKUP_SERVICE = "omp-cloud-backup.service";
const BACKUP_TIMER = "omp-cloud-backup.timer";

/** The three services, the backup oneshot and its timer. */
export const USER_UNIT_FILES: readonly string[] = [...USER_SERVICES.map((name) => `${name}.service`), BACKUP_SERVICE, BACKUP_TIMER];

/** Units that stay enabled and active (the oneshot backup runs from its timer). */
const LONG_RUNNING_UNITS: readonly string[] = [...USER_SERVICES.map((name) => `${name}.service`), BACKUP_TIMER];

/** The drop-in `omp-cloud install` writes onto a persistent unit to start the managed binary; setup's own unit file already starts it, so setup removes the drop-in. */
const DROP_IN_DIR = "omp-cloud.service.d";
const DROP_IN_FILE = "managed.conf";

/** managed: `<app>/bin/omp-cloud` runs the service; checkout: `bun run` in the repository. */
export type UnitMode = { kind: "managed" } | { kind: "checkout"; repoRoot: string; bunBin: string };

export interface UnitInput {
	paths: SetupPaths;
	mode: UnitMode;
	/** The omp that runs the broker and the gateway. */
	ompBin: string;
}

/** A value that a unit file cannot carry unquoted (or that is empty): thrown by `renderUnits`, named after the field. */
export class UnitValueError extends Error {}

const SAFE_VALUE = /^[A-Za-z0-9_./:%+=,-]+$/;

/** `value` for a unit file: limited to characters that need no quoting, `%` doubled for systemd's specifiers. */
function unitValue(field: string, value: string): string {
	if (value === "") throw new UnitValueError(`${field} is empty`);
	if (!SAFE_VALUE.test(value)) throw new UnitValueError(`${field} contains characters a unit file cannot carry without quoting: ${value}`);
	return value.replaceAll("%", "%%");
}

/** The one fixed PATH every unit runs with, never the caller's: a mise shim on an interactive PATH once hung the service's `gh auth token`. */
export function unitSearchPath(ompBin: string, mode: UnitMode): string {
	const fixed = [dirname(ompBin), "/usr/local/bin", "/usr/bin", "/bin"];
	return (mode.kind === "checkout" ? [dirname(mode.bunBin), ...fixed] : fixed).join(":");
}

/** File name -> content of every unit; throws `UnitValueError` naming the field when a value cannot be carried unquoted. */
export function renderUnits(input: UnitInput): Record<string, string> {
	const { paths, mode } = input;
	const authHome = unitValue("authHome", paths.authHome);
	const omp = unitValue("ompBin", input.ompBin);
	const clients = unitValue("clientsFile", paths.clientsFile);
	const brokerToken = unitValue("authHome", join(paths.authHome, ".omp", "auth-broker.token"));

	let workingDirectory: string;
	let extraEnvironment: string[];
	let serveCommand: string;
	let backupCommand: string;
	if (mode.kind === "managed") {
		const appDir = unitValue("appDir", paths.appDir);
		const binary = unitValue("appDir", new AppLayout(paths.appDir).binLink);
		const config = unitValue("serviceJson (configDir)", paths.serviceJson);
		workingDirectory = appDir;
		extraEnvironment = [`Environment="OMP_CLOUD_APP_DIR=${appDir}"`];
		serveCommand = `"${binary}" serve --config ${config}`;
		backupCommand = `"${binary}" backup --config ${config}`;
	} else {
		const repoRoot = unitValue("repoRoot", mode.repoRoot);
		const bun = unitValue("bunBin", mode.bunBin);
		workingDirectory = repoRoot;
		extraEnvironment = [];
		serveCommand = `"${bun}" run src/main.ts`;
		backupCommand = `"${bun}" run scripts/backup.ts`;
	}
	const searchPath = unitValue("unitPath", unitSearchPath(input.ompBin, mode));
	const pathLine = `Environment="PATH=${searchPath}"`;

	const content: Record<string, readonly string[]> = {
		"omp-auth-broker.service": [
			"[Unit]",
			"Description=omp auth broker (omp-cloud)",
			"StartLimitIntervalSec=0",
			"",
			"[Service]",
			`Environment="HOME=${authHome}"`,
			pathLine,
			`ExecStart="${omp}" auth-broker serve --bind=127.0.0.1:8765`,
			"Restart=on-failure",
			"RestartSec=5",
			"",
			"[Install]",
			"WantedBy=default.target",
		],
		"omp-auth-gateway.service": [
			"[Unit]",
			"Description=omp auth gateway (omp-cloud)",
			"Wants=omp-auth-broker.service",
			"After=omp-auth-broker.service",
			"StartLimitIntervalSec=0",
			"",
			"[Service]",
			`Environment="HOME=${authHome}"`,
			pathLine,
			'Environment="OMP_AUTH_BROKER_URL=http://127.0.0.1:8765"',
			`# Binds ${SERVICE_IP}, the dummy link omp-cloud-net.service creates: until it exists the start fails and is retried.`,
			"# The gateway needs the broker's bearer token, which the broker writes a moment after it starts: wait for it for at most 30 s",
			"# (sh builtins and sleep only; `$$` is systemd's escape for `$`), then fail so that Restart= takes over.",
			`ExecStartPre=/bin/sh -c 'n=0; while [ ! -s "$$1" ] && [ $$n -lt 30 ]; do n=$$((n + 1)); sleep 1; done; [ -s "$$1" ] || { echo "the auth broker wrote no token to $$1 within 30 s" >&2; exit 1; }' wait-for-broker-token ${brokerToken}`,
			`ExecStart="${omp}" auth-gateway serve --bind=${SERVICE_IP}:4000 --clients=${clients}`,
			"Restart=on-failure",
			"RestartSec=5",
			"",
			"[Install]",
			"WantedBy=default.target",
		],
		"omp-cloud.service": [
			"[Unit]",
			"Description=omp-cloud service",
			"Wants=omp-auth-broker.service omp-auth-gateway.service",
			"After=omp-auth-broker.service omp-auth-gateway.service",
			"StartLimitIntervalSec=0",
			"",
			"[Service]",
			`WorkingDirectory=${workingDirectory}`,
			pathLine,
			...extraEnvironment,
			`ExecStart=${serveCommand}`,
			"Restart=on-failure",
			"RestartSec=5",
			"",
			"[Install]",
			"WantedBy=default.target",
		],
		[BACKUP_SERVICE]: [
			"[Unit]",
			mode.kind === "managed" ? "Description=omp-cloud backup" : "Description=omp-cloud backup (mise run backup)",
			"",
			"[Service]",
			"Type=oneshot",
			`WorkingDirectory=${workingDirectory}`,
			pathLine,
			...extraEnvironment,
			`ExecStart=${backupCommand}`,
		],
		[BACKUP_TIMER]: ["[Unit]", "Description=Daily omp-cloud backup", "", "[Timer]", "OnCalendar=daily", "Persistent=true", "", "[Install]", "WantedBy=timers.target"],
	};
	return Object.fromEntries(Object.entries(content).map(([file, rows]) => [file, `${rows.join("\n")}\n`]));
}

/** `units.<name>` for a unit file: the `.service` suffix is left off. */
function stepId(file: string): string {
	return `units.${file.replace(/\.service$/, "")}`;
}

function failure(id: string, error: unknown, fix: string): StepResult {
	return { id, status: "failed", detail: error instanceof Error ? error.message : String(error), fix };
}

/** Writes `content` to `path` (beside it, then renamed, 0644) unless the file already has exactly those bytes. Returns whether it wrote. */
async function writeIfChanged(path: string, content: string): Promise<boolean> {
	const wanted = Buffer.from(content);
	try {
		if (wanted.equals(await readFile(path))) return false;
	} catch {
		// Absent: it gets written.
	}
	const temp = `${path}.tmp-${process.pid}`;
	await writeFile(temp, wanted);
	await chmod(temp, 0o644);
	await rename(temp, path);
	return true;
}

/** Removes `omp-cloud.service.d/managed.conf` and its directory when that leaves it empty. Returns whether the drop-in existed. */
async function removeManagedDropIn(unitDir: string): Promise<boolean> {
	const directory = join(unitDir, DROP_IN_DIR);
	const file = join(directory, DROP_IN_FILE);
	if (!(await Bun.file(file).exists())) return false;
	await rm(file, { force: true });
	try {
		await rmdir(directory);
	} catch {
		// Other drop-ins live there: the directory stays.
	}
	return true;
}

/** `systemd-analyze --user verify` over the rendered files in a temp directory. A host without a user manager cannot verify: that is a skip, not a failure. */
async function verifyUnits(files: Readonly<Record<string, string>>, run: CommandRunner): Promise<StepResult> {
	const directory = await mkdtemp(join(tmpdir(), "omp-cloud-units-"));
	try {
		const paths = Object.keys(files).map((file) => join(directory, file));
		await Promise.all(Object.entries(files).map(([file, content]) => writeFile(join(directory, file), content)));
		let result: CommandResult;
		try {
			result = await run(["systemd-analyze", "--user", "verify", ...paths], { timeoutMs: 30_000 });
			if (result.code !== 0) {
				// The same command on a trivial unit tells a broken unit from a host with no user manager (a container, a CI runner).
				const probe = join(directory, "probe.service");
				await writeFile(probe, "[Service]\nExecStart=/bin/true\n");
				const probed = await run(["systemd-analyze", "--user", "verify", probe], { timeoutMs: 30_000 });
				if (probed.code !== 0) return { id: "units.verify", status: "skipped", detail: "systemd-analyze could not talk to a user manager, so the units were not verified" };
			}
		} catch (error) {
			return { id: "units.verify", status: "skipped", detail: `systemd-analyze could not be started (${error instanceof Error ? error.message : String(error)}), so the units were not verified` };
		}
		if (result.code !== 0) {
			const output = (result.stderr.trim() || result.stdout.trim()).slice(0, 600);
			return { id: "units.verify", status: "failed", detail: `systemd-analyze rejected the units: ${output || `exit ${result.code}`}`, fix: "fix the paths it names (the omp, the app directory), then rerun omp-cloud setup" };
		}
		return { id: "units.verify", status: "ok", detail: `systemd-analyze verified ${paths.length} units` };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/**
 * Installs the user units: verify, write what changed, `daemon-reload`, `try-restart` the changed ones, `enable --now` the
 * services and the timer. Nothing is installed when verify fails.
 */
export async function installUserUnits(input: UnitInput, run: CommandRunner): Promise<StepResult[]> {
	let files: Record<string, string>;
	try {
		files = renderUnits(input);
	} catch (error) {
		if (error instanceof UnitValueError) return [failure("units.render", error, "use directories made of letters, digits and _ . / : + = , - only, then rerun omp-cloud setup")];
		throw error;
	}
	const verify = await verifyUnits(files, run);
	if (verify.status === "failed") return [verify];

	const steps: StepResult[] = [verify];
	const units = new Units(run);
	const written = new Set<string>();
	let dropIn: boolean;
	try {
		await mkdir(input.paths.unitDir, { recursive: true, mode: 0o755 });
		for (const [file, content] of Object.entries(files)) {
			if (await writeIfChanged(join(input.paths.unitDir, file), content)) written.add(file);
		}
		dropIn = await removeManagedDropIn(input.paths.unitDir);
	} catch (error) {
		return [...steps, failure("units.write", error, `make ${input.paths.unitDir} writable, then rerun omp-cloud setup`)];
	}
	if (dropIn) written.add("omp-cloud.service");

	for (const file of USER_UNIT_FILES) {
		const details = [written.has(file) ? `wrote ${join(input.paths.unitDir, file)}` : "up to date"];
		if (file === "omp-cloud.service" && dropIn) details.push(`removed the old ${DROP_IN_DIR}/${DROP_IN_FILE} drop-in`);
		steps.push({ id: stepId(file), status: written.has(file) ? "changed" : "ok", detail: details.join("; ") });
	}

	let alreadyUp = true;
	try {
		for (const file of LONG_RUNNING_UNITS) {
			if (!((await units.isEnabled(file)) && (await units.isActive(file)))) alreadyUp = false;
		}
		await units.daemonReload();
		const restart = [...written].filter((file) => LONG_RUNNING_UNITS.includes(file));
		if (restart.length > 0) await units.tryRestart(...restart);
		await units.enableNow(...LONG_RUNNING_UNITS);
		if (restart.length > 0) alreadyUp = false;
	} catch (error) {
		steps.push(failure("units.enable", error, "systemctl --user status omp-cloud; journalctl --user -u omp-cloud -e"));
		return steps;
	}
	steps.push({
		id: "units.enable",
		status: alreadyUp ? "ok" : "changed",
		detail: `${alreadyUp ? "already enabled and running" : "enabled and started"}: ${LONG_RUNNING_UNITS.join(", ")}`,
	});
	return steps;
}

/** For the doctor: each long-running unit is enabled and active. */
export async function userUnitChecks(run: CommandRunner): Promise<StepResult[]> {
	const units = new Units(run);
	const steps: StepResult[] = [];
	for (const file of LONG_RUNNING_UNITS) {
		const id = stepId(file);
		const fix = `systemctl --user status ${file}; journalctl --user -u ${file} -e`;
		try {
			const enabled = await units.isEnabled(file);
			const active = await units.isActive(file);
			if (enabled && active) steps.push({ id, status: "ok", detail: "enabled, active" });
			else steps.push({ id, status: "failed", detail: `${enabled ? "enabled" : "not enabled"}, ${active ? "active" : "not active"}`, fix });
		} catch (error) {
			steps.push(failure(id, error, fix));
		}
	}
	return steps;
}

/** Uninstall: stops and disables the five units, deletes their files and a leftover managed drop-in, reloads systemd. */
export async function removeUserUnits(paths: SetupPaths, run: CommandRunner): Promise<StepResult[]> {
	const units = new Units(run);
	const steps: StepResult[] = [];
	for (const file of USER_UNIT_FILES) {
		const path = join(paths.unitDir, file);
		const present = await Bun.file(path).exists();
		try {
			if (present) await units.disable(file);
		} catch {
			// Not enabled, or no user manager: the file goes anyway.
		}
		try {
			await units.stop(file);
		} catch {
			// Not loaded.
		}
		try {
			await rm(path, { force: true });
		} catch (error) {
			steps.push(failure(stepId(file), error, `rm ${path}`));
			continue;
		}
		steps.push({ id: stepId(file), status: present ? "changed" : "ok", detail: present ? `stopped, disabled and removed ${path}` : "not installed" });
	}
	try {
		if (await removeManagedDropIn(paths.unitDir)) steps.push({ id: "units.drop-in", status: "changed", detail: `removed ${join(paths.unitDir, DROP_IN_DIR, DROP_IN_FILE)}` });
		await units.daemonReload();
		for (const file of USER_UNIT_FILES) await units.resetFailed(file);
	} catch (error) {
		steps.push(failure("units.reload", error, "systemctl --user daemon-reload"));
	}
	return steps;
}
