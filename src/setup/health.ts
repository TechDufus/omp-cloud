/** The waits and probes setup and the doctor run against the stack: vmon, the gateway, the service, the broker, the vmon key and the VM template. Time is injected so tests never sleep. */
import type { Config } from "../config";
import { isRecord } from "../guards";
import type { StepResult } from "./steps";

export interface HealthDeps {
	fetch(url: string, init?: RequestInit): Promise<Response>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

/** One request waits this long before it counts as no answer (a gateway on an address that is not up yet may never reply). */
const REQUEST_TIMEOUT_MS = 5000;
const POLL_MS = 1000;
const DEFAULT_WAIT_MS = 60_000;
const VMON_BASE = "http://127.0.0.1:3000";
const GATEWAY_URL = "http://10.254.254.1:4000/healthz";
const BROKER_URL = "http://127.0.0.1:8765/v1/healthz";

export const realHealthDeps: HealthDeps = {
	fetch: (url, init) => fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init }),
	sleep: (ms) => Bun.sleep(ms),
	now: () => Date.now(),
};

/** Why a probe is not ready (null when it is). */
type Probe = () => Promise<string | null>;

/** What a request to `url` answered, as a reason: `null` when it is `expected`, else `HTTP <status>` or the network error. `inspect` may add a reason from the body of an expected answer. */
async function expectStatus(
	deps: HealthDeps,
	url: string,
	expected: number,
	init?: RequestInit,
	inspect?: (response: Response) => Promise<string | null>,
): Promise<string | null> {
	let response: Response;
	try {
		response = await deps.fetch(url, init);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (response.status !== expected) {
		await discard(response);
		return `HTTP ${response.status}`;
	}
	if (inspect === undefined) {
		await discard(response);
		return null;
	}
	try {
		return await inspect(response);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Frees the connection of an answer whose body nobody reads. */
async function discard(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// the body was already read or released: nothing to free
	}
}

/** Polls `probe` every second until it is ready or `timeoutMs` has passed; the last reason when it never was. */
async function poll(deps: HealthDeps, timeoutMs: number, probe: Probe): Promise<{ ready: true; seconds: number } | { ready: false; reason: string }> {
	const start = deps.now();
	for (;;) {
		const reason = await probe();
		if (reason === null) return { ready: true, seconds: Math.round((deps.now() - start) / 1000) };
		if (deps.now() - start >= timeoutMs) return { ready: false, reason };
		await deps.sleep(POLL_MS);
	}
}

async function waitFor(deps: HealthDeps, id: string, what: string, timeoutMs: number, fix: string, probe: Probe): Promise<StepResult> {
	const outcome = await poll(deps, timeoutMs, probe);
	if (outcome.ready) return { id, status: "ok", detail: outcome.seconds === 0 ? `${what} is healthy` : `${what} is healthy (after ${outcome.seconds} s)` };
	return { id, status: "failed", detail: `${what} is not healthy after ${Math.round(timeoutMs / 1000)} s (${outcome.reason})`, fix };
}

/** vmon's `GET /health` answers 204. */
export function waitVmon(deps: HealthDeps, timeoutMs = DEFAULT_WAIT_MS): Promise<StepResult> {
	return waitFor(deps, "health.vmon", "vmon", timeoutMs, "journalctl -u vmon -n 50", () => expectStatus(deps, `${VMON_BASE}/health`, 204));
}

/** The auth gateway on the service IP answers `GET /healthz` with 200. */
export function waitGateway(deps: HealthDeps, timeoutMs = DEFAULT_WAIT_MS): Promise<StepResult> {
	return waitFor(deps, "health.gateway", "the auth gateway", timeoutMs, "journalctl --user -u omp-auth-gateway -n 50", () => expectStatus(deps, GATEWAY_URL, 200));
}

/** The auth broker answers `GET /v1/healthz` with 200. */
export function waitBroker(deps: HealthDeps, timeoutMs = DEFAULT_WAIT_MS): Promise<StepResult> {
	return waitFor(deps, "health.broker", "the auth broker", timeoutMs, "journalctl --user -u omp-auth-broker -n 50", () => expectStatus(deps, BROKER_URL, 200));
}

/** `GET <base>/api/v1/health` is 200 `{status: "ok", version}` with `version` being the one just installed: while the old process still answers, a different version is not ready. */
export function waitService(deps: HealthDeps, base: string, version: string, timeoutMs = DEFAULT_WAIT_MS): Promise<StepResult> {
	const probe: Probe = () =>
		expectStatus(deps, `${base}/api/v1/health`, 200, undefined, async (response) => {
			const body: unknown = await response.json();
			if (!isRecord(body) || body.status !== "ok") return "the health answer is not {status: ok}";
			if (body.version !== version) return `still running ${typeof body.version === "string" ? body.version : "an unknown version"}`;
			return null;
		});
	return waitFor(deps, "health.service", `the omp-cloud service ${version}`, timeoutMs, "journalctl --user -u omp-cloud -n 50", probe);
}

export type KeyState = "good" | "stale" | "down";

/** The vmon team key: a team route answers 200 for a good key and 401 for one vmon does not know (the team was recreated); anything else, or no answer, is `down`. */
export async function checkVmonKey(deps: HealthDeps, key: string, vmonUrl: string = VMON_BASE): Promise<KeyState> {
	let response: Response;
	try {
		response = await deps.fetch(`${vmonUrl.replace(/\/+$/, "")}/v2/sandboxes?limit=1`, { headers: { "X-API-Key": key } });
	} catch {
		return "down";
	}
	await discard(response);
	if (response.status === 200) return "good";
	if (response.status === 401) return "stale";
	return "down";
}

export interface TemplateProbe {
	name(): Promise<string>;
	exists(name: string): Promise<boolean>;
}

/** The template of this omp on this vmon (`omp-agent:<omp>-<recipe hash>`), asked of vmon through e2b with the team key. e2b loads only when this runs. */
export async function realTemplateProbe(config: Config, key: string, ompVersion: string): Promise<TemplateProbe> {
	const [{ Template }, { templateName }, { installedVmonVersion }] = await Promise.all([import("e2b"), import("../vmon/template"), import("../vmon/pin")]);
	const name = await templateName(config.vmon.template, ompVersion, await installedVmonVersion());
	const connection = { apiKey: key, apiUrl: config.vmon.url, sandboxUrl: config.vmon.url, domain: new URL(config.vmon.url).hostname };
	return {
		name: async () => name,
		exists: (template) => Template.exists(template, connection),
	};
}

export interface WaitTemplateOptions {
	/** Default 15 minutes. */
	timeoutMs?: number;
	/** Default 5 s. */
	pollMs?: number;
	progress: (line: string) => void;
	/** Do not wait: say it builds in the background. */
	noWait: boolean;
}

const TEMPLATE_TIMEOUT_MS = 15 * 60_000;
const TEMPLATE_POLL_MS = 5000;
const PROGRESS_EVERY_MS = 15_000;

function minutesSeconds(ms: number): string {
	const total = Math.floor(ms / 1000);
	return `${Math.floor(total / 60)}m${total % 60}s`;
}

/**
 * The service builds the VM template in the background on its first start (nested KVM builds take minutes). Ready at once
 * is `ok`; `noWait` stops there (`skipped`); otherwise polls, reporting progress every ~15 s, until it exists (`changed`) or
 * the timeout passes (`failed`: the build goes on, only the wait ended).
 */
export async function waitTemplate(deps: HealthDeps, probe: TemplateProbe, options: WaitTemplateOptions): Promise<StepResult> {
	const id = "health.template";
	const name = await probe.name();
	const ready = async (): Promise<boolean> => {
		try {
			return await probe.exists(name);
		} catch {
			// vmon busy with the build or the service not up yet: not ready, ask again.
			return false;
		}
	};
	if (await ready()) return { id, status: "ok", detail: `the VM template ${name} is ready` };
	if (options.noWait) {
		return { id, status: "skipped", detail: "building in the background (nested KVM builds are slow); omp-cloud doctor shows when it is ready" };
	}
	const timeoutMs = options.timeoutMs ?? TEMPLATE_TIMEOUT_MS;
	const pollMs = options.pollMs ?? TEMPLATE_POLL_MS;
	const start = deps.now();
	let nextProgress = start;
	for (;;) {
		const elapsed = deps.now() - start;
		if (elapsed >= timeoutMs) {
			return {
				id,
				status: "failed",
				detail: `the VM template ${name} is still building after ${minutesSeconds(elapsed)}; it keeps building in the background`,
				fix: "journalctl --user -u omp-cloud -f",
			};
		}
		if (deps.now() >= nextProgress) {
			options.progress(`building the VM template ${name} (${minutesSeconds(elapsed)})`);
			nextProgress = deps.now() + PROGRESS_EVERY_MS;
		}
		await deps.sleep(pollMs);
		if (await ready()) return { id, status: "changed", detail: `built the VM template ${name} in ${minutesSeconds(deps.now() - start)}` };
	}
}
