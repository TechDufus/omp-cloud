/**
 * The vibemon team omp-cloud runs its sandboxes in. vmon is the source of truth: a team is looked up by slug in
 * `vmon admin list-teams`, created only when it is missing (`create-team` is not idempotent: a second call makes `<slug>-2`),
 * and its limits are applied on every run. The CLI talks to vmon's cluster listener with the cluster secret, which goes into
 * the child's environment and never into argv (the process list is public). Its output is the 0.4.0 text format of
 * `reference/admin.md`: tab-separated team lines, `create-team` printing `team`, `slug` and `api key` lines, `create-api-key`
 * printing only the key.
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

const CLUSTER_URL = "http://127.0.0.1:7947";
const ADMIN_TIMEOUT_MS = 60_000;
/** `vmon admin` works only once a driver has started: right after the health check it may still fail for a moment. */
const LIST_ATTEMPTS = 5;
const LIST_RETRY_MS = 2_000;
const API_KEY_PATTERN = /^e2b_[A-Za-z0-9]{16,}$/;

export interface TeamLine {
	id: string;
	slug: string;
	name: string;
	system: boolean;
	blocked: boolean;
}

/** The teams of `vmon admin list-teams`: `<id>\t<slug>\t<name>\t<counts>[\tBLOCKED][\tSYSTEM]` per line. Lines that do not have that shape are skipped. */
export function parseListTeams(stdout: string): TeamLine[] {
	const teams: TeamLine[] = [];
	for (const line of stdout.split("\n")) {
		const [id, slug, name, ...flags] = line.replace(/\r$/, "").split("\t");
		if (id === undefined || slug === undefined || name === undefined || id.trim() === "" || slug.trim() === "") continue;
		teams.push({ id: id.trim(), slug: slug.trim(), name: name.trim(), blocked: flags.includes("BLOCKED"), system: flags.includes("SYSTEM") });
	}
	return teams;
}

/** The slug and the one-time key of `vmon admin create-team` (`slug    <slug>` and `api key e2b_…` lines); null when either is missing. */
export function parseCreateTeam(stdout: string): { slug: string; key: string } | null {
	let slug: string | undefined;
	let key: string | undefined;
	for (const line of stdout.split("\n")) {
		slug ??= /^slug\s+(\S+)\s*$/.exec(line)?.[1];
		key ??= /^api key\s+(\S+)\s*$/.exec(line)?.[1];
	}
	if (slug === undefined || key === undefined || !API_KEY_PATTERN.test(key)) return null;
	return { slug, key };
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

/** The value of `VMON_CLUSTER_SECRET` in the text of `/etc/vmon/env`; null when it has none. */
export function clusterSecretOf(envFile: string): string | null {
	for (const line of envFile.split("\n")) {
		const match = /^\s*(?:export\s+)?VMON_CLUSTER_SECRET=(.*)$/.exec(line);
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

/**
 * Makes sure team `slug` exists in vmon with the standard limits, as root. A key that was minted is returned even when a
 * later step fails: it exists in vmon and nobody else has it.
 */
export async function ensureTeam(options: EnsureTeamOptions): Promise<TeamOutcome> {
	const { runner, slug, maxSandboxes } = options;
	const admin = (args: readonly string[]): Promise<CommandResult> =>
		runner([VMON_BINARY, "admin", "--cluster-url", CLUSTER_URL, ...args], { env: { VMON_CLUSTER_SECRET: options.secret }, timeoutMs: ADMIN_TIMEOUT_MS });
	const steps: StepResult[] = [];
	const outcome: TeamOutcome = { steps, team: { slug, created: false } };
	const logs = "journalctl -u vmon -n 50 --no-pager";

	let listed = await admin(["list-teams"]);
	for (let attempt = 1; listed.code !== 0 && attempt < LIST_ATTEMPTS; attempt++) {
		await options.sleep(LIST_RETRY_MS);
		listed = await admin(["list-teams"]);
	}
	if (listed.code !== 0) {
		steps.push(failure("system.team", "vmon admin list-teams failed", listed, logs));
		return outcome;
	}

	const exists = parseListTeams(listed.stdout).some((team) => team.slug === slug);
	if (!exists) {
		const created = await admin(["create-team", slug, ...limitArgs(maxSandboxes)]);
		if (created.code !== 0) {
			steps.push(failure("system.team", `vmon admin create-team ${slug} failed`, created, logs));
			return outcome;
		}
		const parsed = parseCreateTeam(created.stdout);
		outcome.team.created = true;
		if (parsed === null) {
			steps.push({ id: "system.team", status: "failed", detail: `vmon created team ${slug} but printed no api key`, fix: "omp-cloud setup (it mints a key for the team that exists)" });
			return outcome;
		}
		outcome.key = parsed.key;
		if (parsed.slug !== slug) {
			steps.push({ id: "system.team", status: "failed", detail: `vmon named the new team ${parsed.slug}, not ${slug}`, fix: "check vmon admin list-teams for a team with a similar name" });
			return outcome;
		}
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
	if (outcome.key !== undefined) steps.push({ id: "system.team.key", status: "changed", detail: exists ? `minted an API key for team ${slug}` : `the API key of the new team ${slug} is ready` });

	const limits = await admin(["set-limits", slug, ...limitArgs(maxSandboxes)]);
	if (limits.code !== 0) {
		steps.push(failure("system.team.limits", `vmon admin set-limits ${slug} failed`, limits, logs));
		return outcome;
	}
	steps.push({ id: "system.team.limits", status: "ok", detail: `limits of ${slug}: ${maxSandboxes} running sandboxes, 8 vCPUs, 8192 MiB, 20480 MiB disk, 24 h` });
	return outcome;
}
