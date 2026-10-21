/**
 * The vibemon version omp-cloud manages: each omp-cloud release pins the vmon it was tested with (`infra/vmon.json`, bundled
 * into the binary), `omp-cloud setup` and the updater install exactly that, and a thread's VM template is built by the vmon
 * that runs it. Installing needs root, so it goes through the root helper `infra/vmon-install.sh`, which `omp-cloud setup`
 * installs at {@link VMON_HELPER_PATH} with a sudoers rule for the owner.
 */
import { stat } from "node:fs/promises";
import helperScript from "../../infra/vmon-install.sh" with { type: "text" };
import pin from "../../infra/vmon.json" with { type: "json" };
import { isRecord } from "../guards";

/** What the root helper accepts as its one argument. */
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

/** The vmon tag this omp-cloud release was tested with, for example `v0.4.0`. */
export const VMON_PIN: string = pin.version;
if (!TAG_PATTERN.test(VMON_PIN)) throw new Error(`infra/vmon.json holds the version ${JSON.stringify(VMON_PIN)}, which is not a vmon tag like v0.4.0`);

/** Where `omp-cloud setup` installs vmon. */
export const VMON_BINARY = "/opt/vmon/vmon";
/** The root-owned helper that installs a vmon release. */
export const VMON_HELPER_PATH = "/usr/local/libexec/omp-cloud/vmon-install";
/** The text of `infra/vmon-install.sh`, carried by the binary: `omp-cloud setup system` installs it as the root helper at {@link VMON_HELPER_PATH}. */
export const VMON_HELPER_SCRIPT: string = helperScript;

/** The helper takes up to a download of two tarballs, a restart (stop timeout 60 s) and a 60 s health wait, twice when it rolls back. */
const HELPER_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

/** Runs `argv` to its end; `null` when it cannot start, times out or is killed. */
async function run(argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string } | null> {
	try {
		const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return proc.signalCode === null ? { code, stdout, stderr } : null;
	} catch {
		return null;
	}
}

/** The installed vmon as a tag (`v0.4.0`, from `vmon --version`'s `vmon 0.4.0`); null when it is not installed or does not report a version. */
export async function installedVmonVersion(binary: string = VMON_BINARY): Promise<string | null> {
	try {
		await stat(binary);
	} catch {
		return null;
	}
	const result = await run([binary, "--version"], PROBE_TIMEOUT_MS);
	if (result === null || result.code !== 0) return null;
	const match = /^vmon (\d+\.\d+\.\d+)\s*$/.exec(result.stdout.trim());
	return match?.[1] === undefined ? null : `v${match[1]}`;
}

/** Whether the root helper can be used: the file exists and sudo allows this user to run it without a password. */
export async function vmonHelper(helperPath: string = VMON_HELPER_PATH): Promise<{ available: boolean }> {
	try {
		await stat(helperPath);
	} catch {
		return { available: false };
	}
	const result = await run(["sudo", "-n", "-l", helperPath], PROBE_TIMEOUT_MS);
	return { available: result !== null && result.code === 0 };
}

/** The verdict on the last stdout line of the helper (`{"ok": true, …}` or `{"ok": false, "error": …}`); null when that line is not the helper's JSON. */
export function helperVerdict(stdout: string): { ok: true } | { ok: false; error: string } | null {
	const last = stdout.trim().split("\n").at(-1);
	if (last === undefined) return null;
	let value: unknown;
	try {
		value = JSON.parse(last);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	if (value.ok === true) return { ok: true };
	if (value.ok === false) return { ok: false, error: typeof value.error === "string" && value.error !== "" ? value.error : "the helper failed without a reason" };
	return null;
}

/**
 * Installs the vmon release `tag` with the root helper (`sudo -n <helper> <tag>`): download, checksum, swap, restart,
 * health check, rollback. Resolves when the helper reported success; throws an `Error` naming what went wrong otherwise
 * (a rollback included: its message says `rolled back to ...`). Nothing has changed on the machine when it throws before
 * the helper ran. `command` replaces `sudo -n <helper>` (tests).
 */
export async function runVmonHelper(tag: string, command: readonly string[] = ["sudo", "-n", VMON_HELPER_PATH]): Promise<void> {
	if (!TAG_PATTERN.test(tag)) throw new Error(`${JSON.stringify(tag)} is not a vmon tag like v0.4.0`);
	const result = await run([...command, tag], HELPER_TIMEOUT_MS);
	if (result === null) throw new Error(`the vmon install helper could not run or did not finish within ${HELPER_TIMEOUT_MS / 60_000} minutes`);
	const verdict = helperVerdict(result.stdout);
	if (verdict?.ok === true && result.code === 0) return;
	if (verdict?.ok === false) throw new Error(verdict.error);
	const detail = result.stderr.trim().split("\n").at(-1)?.trim().slice(0, 300) ?? "";
	throw new Error(`the vmon install helper exited ${result.code} without a verdict${detail === "" ? "" : `: ${detail}`}`);
}
