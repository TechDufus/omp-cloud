/**
 * The clean-host VMs of `scripts/cleanhost.ts` and `test/install-scenario.ts`: plain Debian 13 sandboxes in the vmon team
 * `omp-cloud-test` (created once by the owner's approval, its key in `~/.config/omp-cloud/vmon-test.key`). They are
 * where `install.sh` and `omp-cloud setup` run from scratch, with a nested vmon inside. Nothing here touches the live team.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CommandExitError, type ConnectionOpts, Sandbox, SandboxNotFoundError, Template } from "e2b";
import { installedVmonVersion, VMON_BINARY } from "../../src/vmon/pin";

export const VMON_URL = "http://127.0.0.1:3000";
export const TEST_KEY_FILE = join(homedir(), ".config", "omp-cloud", "vmon-test.key");

/** The size of a clean host: the vmon inside needs about 8 GiB, 4 vCPUs and 30 GiB of disk (the disk is the team's `max_disk_mb`). */
export const CLEAN_SIZE = { cpuCount: 4, memoryMB: 12_288 };
/** Marks the sandboxes this tooling creates. */
export const CLEAN_METADATA = { app: "omp-cloud-cleanhost" };
const TEMPLATE_BASE = "omp-cloud-clean";
/** A VM nobody destroyed is killed after this; `create --keep` asks for the team's maximum instead. */
export const DEFAULT_LIFETIME_MS = 3 * 3_600_000;
export const KEEP_LIFETIME_MS = 24 * 3_600_000;

/**
 * Debian 13 with what `curl | sh` needs (`ca-certificates`, `curl`, `sudo`; vmon's own provisioning adds git, iptables, ssh and
 * chrony but no e2fsprogs, so setup's package step has work to do), plus the session stack of any ordinary Debian install:
 * `dbus`, `libpam-systemd` and `dbus-user-session`. The vmon base image has none of them, so no user manager can exist
 * without them and `systemctl --user` (which setup needs) cannot work on it.
 */
export function cleanRecipe() {
	return Template().fromImage("debian:13").aptInstall(["ca-certificates", "curl", "sudo", "dbus", "dbus-user-session", "libpam-systemd"]);
}

/** `omp-cloud-clean:<hash12>`: the hash covers the recipe, the size and the vmon version, so a change builds a new template (as `templateName` in `src/vmon/template.ts`). */
export async function cleanTemplateName(): Promise<string> {
	const recipe = await Template.toJSON(cleanRecipe(), true);
	const hash = new Bun.CryptoHasher("sha256")
		.update(recipe)
		.update(JSON.stringify(CLEAN_SIZE))
		.update(JSON.stringify({ vmon: await installedVmonVersion() }))
		.digest("hex");
	return `${TEMPLATE_BASE}:${hash.slice(0, 12)}`;
}

/** The test team's connection; the key is read from its file and never printed. */
export async function connection(): Promise<ConnectionOpts> {
	let apiKey: string;
	try {
		apiKey = (await Bun.file(TEST_KEY_FILE).text()).trim();
	} catch {
		throw new Error(`cannot read ${TEST_KEY_FILE}: the omp-cloud-test vmon team's key (see scripts/cleanhost.ts)`);
	}
	if (apiKey === "") throw new Error(`${TEST_KEY_FILE} is empty`);
	return { apiKey, apiUrl: VMON_URL, sandboxUrl: VMON_URL, domain: new URL(VMON_URL).hostname };
}

/** Builds the clean template when it is missing; returns its name and the build seconds (0 when it existed). */
export async function ensureCleanTemplate(log: (line: string) => void): Promise<{ name: string; seconds: number }> {
	const conn = await connection();
	const name = await cleanTemplateName();
	if (await Template.exists(name, conn)) return { name, seconds: 0 };
	log(`building the template ${name} (a few minutes the first time)`);
	const started = performance.now();
	await Template.build(cleanRecipe(), name, {
		...conn,
		...CLEAN_SIZE,
		onBuildLogs: entry => log(`  build: ${entry.message.trimEnd()}`),
	});
	return { name, seconds: (performance.now() - started) / 1000 };
}

/** What a login shell would give `user`: its runtime directory (and the user bus in it), which the envd processes do not get. */
const USER_ENV = { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
/** What a login shell's profile adds once `~/.local/bin` exists (where `install.sh`'s binary is linked); the profile is read before it does. */
const USER_PATH = 'export PATH="$HOME/.local/bin:$PATH"; ';

/**
 * What logging in does for `user` and envd does not: start the system bus, logind and `user@1000`, so `systemctl --user`
 * works. Linger stays off: enabling it is setup's job.
 */
export async function startSession(sandbox: Sandbox): Promise<void> {
	const result = await exec(
		sandbox,
		"systemctl start dbus.socket dbus.service systemd-logind.service user@1000.service && for i in $(seq 1 50); do [ -S /run/user/1000/bus ] && exit 0; sleep 0.2; done; echo 'no user bus at /run/user/1000/bus' >&2; exit 1",
		{ root: true, timeoutMs: 60_000 },
	);
	if (result.exitCode !== 0) throw new Error(`starting the user session failed: ${result.stderr.trim()}`);
}

/** A new clean VM with a user session; `bootSeconds` runs from the request to a session that answers `systemctl --user`. */
export async function createClean(lifetimeMs: number, log: (line: string) => void): Promise<{ sandbox: Sandbox; bootSeconds: number }> {
	const conn = await connection();
	const { name } = await ensureCleanTemplate(log);
	const started = performance.now();
	const sandbox = await Sandbox.create(name, { ...conn, metadata: CLEAN_METADATA, timeoutMs: lifetimeMs, lifecycle: { onTimeout: "kill" } });
	try {
		await startSession(sandbox);
	} catch (error) {
		await Sandbox.kill(sandbox.sandboxId, conn).catch(() => false);
		throw error;
	}
	return { sandbox, bootSeconds: (performance.now() - started) / 1000 };
}

/** Attaches to a running clean VM; null when vmon has no such sandbox (or it is not this tooling's). */
export async function connectClean(id: string): Promise<Sandbox | null> {
	try {
		return await Sandbox.connect(id, { ...(await connection()), timeoutMs: DEFAULT_LIFETIME_MS });
	} catch (error) {
		if (error instanceof SandboxNotFoundError) return null;
		throw error;
	}
}

/** False when it was already gone. Only sandboxes of the test team can be named: the key is the team's. */
export async function destroyClean(id: string): Promise<boolean> {
	return Sandbox.kill(id, await connection());
}

export interface CleanVm {
	id: string;
	state: "running" | "paused";
	startedAt: string;
}

/** The test team's sandboxes. */
export async function listClean(): Promise<CleanVm[]> {
	const paginator = Sandbox.list({ ...(await connection()), query: { state: ["running", "paused"] } });
	const found: CleanVm[] = [];
	while (paginator.hasNext) {
		for (const info of await paginator.nextItems()) found.push({ id: info.sandboxId, state: info.state, startedAt: info.startedAt.toISOString() });
	}
	return found;
}

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	root?: boolean;
	/** Environment of the command. */
	envs?: Record<string, string>;
	/** Stream the output as it arrives, to this process's stdout and stderr. */
	stream?: boolean;
	/** `0` for none; default 15 minutes. */
	timeoutMs?: number;
	onStdout?: (data: string) => void;
	onStderr?: (data: string) => void;
}

/** Runs the shell script `script` in the VM (as `user`, or root) to its end; a non-zero exit is a result, not an error. */
export async function exec(sandbox: Sandbox, script: string, options: ExecOptions = {}): Promise<ExecResult> {
	let stdout = "";
	let stderr = "";
	try {
		await sandbox.commands.run(options.root === true ? script : `${USER_PATH}${script}`, {
			user: options.root === true ? "root" : "user",
			envs: options.root === true ? { ...options.envs } : { ...USER_ENV, ...options.envs },
			timeoutMs: options.timeoutMs ?? 15 * 60_000,
			onStdout: data => {
				stdout += data;
				if (options.stream === true) process.stdout.write(data);
				options.onStdout?.(data);
			},
			onStderr: data => {
				stderr += data;
				if (options.stream === true) process.stderr.write(data);
				options.onStderr?.(data);
			},
		});
		return { exitCode: 0, stdout, stderr };
	} catch (error) {
		if (error instanceof CommandExitError) return { exitCode: error.exitCode, stdout, stderr };
		throw error;
	}
}

/** `'…'` for a POSIX shell. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

let longRuns = 0;

/**
 * Runs `script` detached in the VM and follows its log until it exits: a command that runs for many minutes (setup builds a
 * template) must not depend on one envd stream staying open. Output goes to `onOutput` as it arrives; a VM that stops
 * answering for a minute fails the call. `timeoutMs` bounds the whole run (the script is then killed).
 */
export async function execLong(
	sandbox: Sandbox,
	script: string,
	options: { root?: boolean; timeoutMs: number; onOutput: (text: string) => void },
): Promise<ExecResult> {
	const base = `/tmp/cleanhost-long-${++longRuns}-${Date.now()}`;
	const user = options.root === true ? "root" : "user";
	await sandbox.files.write(`${base}.sh`, options.root === true ? script : `${USER_PATH}${script}`, { user });
	const started = await exec(
		sandbox,
		`setsid nohup sh -c 'sh ${base}.sh > ${base}.log 2>&1 < /dev/null; echo $? > ${base}.code' > /dev/null 2>&1 < /dev/null &`,
		{ root: options.root },
	);
	if (started.exitCode !== 0) throw new Error(`could not start the command: ${started.stderr.trim()}`);
	const deadline = Date.now() + options.timeoutMs;
	let offset = 0;
	let output = "";
	let silentSince: number | null = null;
	for (;;) {
		let chunk: { text: string; size: number; code: string } | null = null;
		try {
			const read = await exec(
				sandbox,
				`code=$(cat ${base}.code 2>/dev/null); n=$(wc -c < ${base}.log); echo "$n"; echo "$code"; head -c "$n" ${base}.log | tail -c +${offset + 1}`,
				{ root: options.root, timeoutMs: 30_000 },
			);
			if (read.exitCode === 0) {
				const [size = "0", code = "", ...rest] = read.stdout.split("\n");
				chunk = { size: Number(size), code: code.trim(), text: rest.join("\n") };
			}
		} catch {
			chunk = null;
		}
		if (chunk === null) {
			silentSince ??= Date.now();
			if (Date.now() - silentSince > 60_000) throw new Error("the VM stopped answering while the command ran");
		} else {
			silentSince = null;
			if (chunk.text !== "") {
				output += chunk.text;
				options.onOutput(chunk.text);
			}
			offset = chunk.size;
			if (chunk.code !== "") return { exitCode: Number(chunk.code), stdout: output, stderr: "" };
		}
		if (Date.now() >= deadline) {
			await exec(sandbox, `pkill -f ${base}.sh`, { root: true }).catch(() => undefined);
			throw new Error(`the command did not finish within ${Math.round(options.timeoutMs / 1000)} s; output so far:\n${output.slice(-1500)}`);
		}
		await Bun.sleep(3000);
	}
}

/** Where the installed vmon keeps the guest kernel its VMM boots (the file the nested probe pushes into the VM). */
const VMON_KERNEL = join(dirname(VMON_BINARY), "vmon-kernel-x86_64");

/**
 * Whether a clean VM can run a guest of its own: on a throwaway clean VM, vmon's own VMM (`vmon vmm`, the pinned release
 * installed on this host, which is what setup installs inside) boots the vmon guest kernel for a few seconds. On a host
 * whose nested KVM is broken the first nested VMRUN shuts the clean VM down, which is how this reports it.
 */
export async function probeNestedKvm(): Promise<{ works: boolean; detail: string }> {
	const { sandbox } = await createClean(30 * 60_000, () => undefined);
	try {
		for (const [local, remote] of [[VMON_BINARY, "/home/user/vmon"], [VMON_KERNEL, "/home/user/vmon-kernel"]] as const) {
			await sandbox.files.write(remote, Bun.file(local).stream(), { requestTimeoutMs: 120_000 });
		}
		await exec(sandbox, "chmod 755 /home/user/vmon");
		let result: ExecResult;
		try {
			result = await exec(sandbox, "timeout 15 /home/user/vmon vmm --no-sandbox --kernel /home/user/vmon-kernel --mem 256 --cpus 1 2>&1 | tail -c 600; exit ${PIPESTATUS[0]}", { root: true, timeoutMs: 60_000 });
		} catch (error) {
			return {
				works: false,
				detail: `the clean VM died when a guest of its own started (vmon logs the VMM exit as reason="shutdown": a triple fault at the first nested VMRUN): ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
			};
		}
		// `timeout` ends a guest that is still running with 124: the guest booted and the clean VM survived.
		if (result.exitCode === 124) return { works: true, detail: "a nested guest ran for 15 s and the clean VM survived" };
		return { works: false, detail: `the nested guest exited ${result.exitCode} without the clean VM dying: ${result.stdout.trim().slice(-400)}` };
	} finally {
		await Sandbox.kill(sandbox.sandboxId, await connection()).catch(() => false);
	}
}
