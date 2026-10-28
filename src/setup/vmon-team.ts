/**
 * The vibemon team omp-cloud runs its sandboxes in. The team is ensured by `vmon admin create-team --if-missing`, which is
 * idempotent: it always prints `team    <name> (<id>)` and `slug    <slug>`, and only when it created the team an
 * `api key e2b_…` line; for a slug that exists it exits 0 with nothing more on stdout and leaves the team unchanged. Limits
 * are therefore applied on every run with `set-limits`. The CLI talks to vmon's cluster listener with the cluster secret,
 * which goes into the child's environment and never into argv (the process list is public). Its output is the 0.4.1 text
 * format of `reference/admin.md`; `create-api-key` prints only the key.
 */
import type { CommandResult, CommandRunner } from "../update/system";
import { lastLine } from "../update/system";
import { VMON_BINARY } from "../vmon/pin";
import type { StepResult } from "./steps";

/** The team's slug unless `--team` says otherwise. */
export const DEFAULT_TEAM = "omp-cloud";
/** The cap on running sandboxes unless `--max-sandboxes` says otherwise. */
export const DEFAULT_MAX_SANDBOXES = 32;
/** A team slug (vmon slugifies names to this alphabet, so the name and the slug are the same string). */
export const TEAM_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Reserved by vmon's template tooling. */
export const RESERVED_TEAM = "system";

const DEFAULT_CLUSTER_URL = "http://127.0.0.1:7947";
const ADMIN_TIMEOUT_MS = 60_000;
/** Deleting a team kills its sandboxes and removes its templates, which can take a while. */
const DELETE_TIMEOUT_MS = 5 * 60_000;
/** `create-team --if-missing` is idempotent, so it is retried while `vmon admin` has no driver yet: right after the health check it may still fail for a moment. */
const CREATE_ATTEMPTS = 5;
const CREATE_RETRY_MS = 2_000;
const API_KEY_PATTERN = /^e2b_[A-Za-z0-9]{16,}$/;

/**
 * The slug and the one-time key of `vmon admin create-team --if-missing` (`slug    <slug>` and `api key e2b_…` lines).
 * `key` is null when the team already existed (no `api key` line); the result is null when there is no slug line or the
 * `api key` line does not hold a key.
 */
export function parseCreateTeam(stdout: string): { slug: string; key: string | null } | null {
	let slug: string | undefined;
	let key: string | undefined;
	for (const line of stdout.split("\n")) {
		slug ??= /^slug\s+(\S+)\s*$/.exec(line)?.[1];
		key ??= /^api key\s+(\S+)\s*$/.exec(line)?.[1];
	}
	if (slug === undefined || (key !== undefined && !API_KEY_PATTERN.test(key))) return null;
	return { slug, key: key ?? null };
}

/** The key `vmon admin create-api-key` prints (its only output line); null when that is not a key. */
export function parseApiKey(stdout: string): string | null {
	const key = stdout.trim();
	return API_KEY_PATTERN.test(key) ? key : null;
}

/**
 * The `--max-*` flags every create and every set-limits run carries. `--max-length-hours` caps each execution of a sandbox
 * (vmon's default is 24 as well; the cap restarts on resume), which is why `runner.sandboxTimeoutSeconds` is at most
 * 86400: raise this limit with `vmon admin set-limits`, or pause before the cap.
 */
export function limitArgs(maxSandboxes: number): string[] {
	return [
		"--max-concurrent-sandboxes", String(maxSandboxes),
		"--max-concurrent-builds", "4",
		"--max-vcpus", "8",
		"--max-memory-mb", "8192",
		"--max-disk-mb", "20480",
		"--max-length-hours", "24",
	];
}

/** The value of variable `name` in the text of `/etc/vmon/env`; null when it has none. */
export function envValueOf(envFile: string, name: string): string | null {
	const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`);
	for (const line of envFile.split("\n")) {
		const match = pattern.exec(line);
		const value = match?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
		if (value !== undefined && value !== "") return value;
	}
	return null;
}

export interface EnsureTeamOptions {
	runner: CommandRunner;
	/** The cluster secret from `/etc/vmon/env`. */
	secret: string;
	slug: string;
	maxSandboxes: number;
	/** Mint a key even when the team exists (`--mint-key`, `--migrate-team`). */
	mintKey: boolean;
	sleep: (ms: number) => Promise<void>;
	/** vmon's cluster listener: loopback unless the server takes other vibemon machines, when vmon listens on its LAN address instead. */
	clusterUrl?: string;
}

export interface TeamOutcome {
	steps: StepResult[];
	team: { slug: string; created: boolean };
	/** Present only when a key was minted now: the team was created, or a key was asked for. Not in any step's text. */
	key?: string;
}

function failure(id: string, what: string, result: CommandResult, fix: string): StepResult {
	const reason = lastLine(result.stderr) || `exit ${result.code}`;
	return { id, status: "failed", detail: `${what}: ${reason}`, fix };
}

/** Runs `vmon admin <args>` as root against vmon's cluster listener. The secret goes into the child's environment only. */
function vmonAdmin(options: { runner: CommandRunner; secret: string; clusterUrl?: string }, args: readonly string[], timeoutMs = ADMIN_TIMEOUT_MS): Promise<CommandResult> {
	return options.runner([VMON_BINARY, "admin", "--cluster-url", options.clusterUrl ?? DEFAULT_CLUSTER_URL, ...args], { env: { VMON_CLUSTER_SECRET: options.secret }, timeoutMs });
}

/**
 * Makes sure team `slug` exists in vmon with the standard limits, as root. A key that was minted is returned even when a
 * later step fails: it exists in vmon and nobody else has it.
 */
export async function ensureTeam(options: EnsureTeamOptions): Promise<TeamOutcome> {
	const { slug, maxSandboxes } = options;
	const admin = (args: readonly string[]): Promise<CommandResult> => vmonAdmin(options, args);
	const steps: StepResult[] = [];
	const outcome: TeamOutcome = { steps, team: { slug, created: false } };
	const logs = "journalctl -u vmon -n 50 --no-pager";

	let created = await admin(["create-team", slug, "--if-missing", ...limitArgs(maxSandboxes)]);
	for (let attempt = 1; created.code !== 0 && attempt < CREATE_ATTEMPTS; attempt++) {
		await options.sleep(CREATE_RETRY_MS);
		created = await admin(["create-team", slug, "--if-missing", ...limitArgs(maxSandboxes)]);
	}
	if (created.code !== 0) {
		steps.push(failure("system.team", `vmon admin create-team ${slug} failed`, created, logs));
		return outcome;
	}

	const parsed = parseCreateTeam(created.stdout);
	if (/^api key\s/m.test(created.stdout)) outcome.team.created = true;
	if (parsed === null) {
		steps.push({ id: "system.team", status: "failed", detail: `vmon answered create-team ${slug} without a slug and a usable api key line`, fix: "omp-cloud setup" });
		return outcome;
	}
	if (parsed.slug !== slug) {
		steps.push({ id: "system.team", status: "failed", detail: `vmon named the new team ${parsed.slug}, not ${slug}`, fix: "check vmon admin list-teams for a team with a similar name" });
		return outcome;
	}
	if (parsed.key !== null) {
		outcome.team.created = true;
		outcome.key = parsed.key;
		steps.push({ id: "system.team", status: "changed", detail: `created vmon team ${slug}` });
	} else {
		steps.push({ id: "system.team", status: "ok", detail: `vmon team ${slug} exists` });
		if (options.mintKey) {
			const minted = await admin(["create-api-key", slug]);
			const key = minted.code === 0 ? parseApiKey(minted.stdout) : null;
			if (key === null) {
				steps.push(failure("system.team.key", `vmon admin create-api-key ${slug} failed`, minted, logs));
				return outcome;
			}
			outcome.key = key;
		}
	}
	if (outcome.key !== undefined) steps.push({ id: "system.team.key", status: "changed", detail: outcome.team.created ? `the API key of the new team ${slug} is ready` : `minted an API key for team ${slug}` });

	const limits = await admin(["set-limits", slug, ...limitArgs(maxSandboxes)]);
	if (limits.code !== 0) {
		steps.push(failure("system.team.limits", `vmon admin set-limits ${slug} failed`, limits, logs));
		return outcome;
	}
	steps.push({ id: "system.team.limits", status: "ok", detail: `limits of ${slug}: ${maxSandboxes} running sandboxes, 4 builds at once, and per VM at most 8 vCPUs, 8192 MiB of memory and 20480 MiB of disk; 24 h per run` });
	return outcome;
}

/**
 * Deletes the team `slug` the host is leaving (`--migrate-team`). With `--force` vmon kills the team's sandboxes, cancels its
 * builds and removes its templates (environment snapshots included), volumes, secrets, webhooks and keys. It never fails the
 * setup: the switch to the new team must complete, and running the command again finishes a delete that stopped part-way.
 */
export async function deleteTeam(options: { runner: CommandRunner; secret: string; slug: string; clusterUrl?: string }): Promise<StepResult> {
	const { slug } = options;
	const id = "system.team.old";
	const result = await vmonAdmin(options, ["delete-team", slug, "--force"], DELETE_TIMEOUT_MS);
	if (result.code === 0) {
		const counts = result.stdout.split("\n").slice(1, 3).map((line) => line.trim()).filter((line) => line !== "");
		return { id, status: "changed", detail: `deleted the old vmon team ${slug} (${counts.join("; ")})` };
	}
	const reason = lastLine(result.stderr) || `exit ${result.code}`;
	if (reason.includes(`team ${slug} not found`)) return { id, status: "ok", detail: `the old vmon team ${slug} is already gone` };
	const clusterUrl = options.clusterUrl ?? DEFAULT_CLUSTER_URL;
	return {
		id,
		status: "skipped",
		detail: `kept the old vmon team ${slug}: vmon admin delete-team failed: ${reason}`,
		fix: `sudo sh -c 'set -a; . /etc/vmon/env; exec ${VMON_BINARY} admin --cluster-url ${clusterUrl} delete-team ${slug} --force'`,
	};
}
