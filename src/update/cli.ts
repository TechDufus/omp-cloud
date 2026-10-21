/**
 * `omp-cloud update [--config <path>]`          check the feed, download and verify a newer release, print the state
 * `omp-cloud update apply [--config <path>]`    install the staged release: asks the running service, else applies it here
 * `omp-cloud update apply-staged --version <v> --config <path>`   the applier the service starts (`systemd-run`); runs in the new binary
 *
 * Every function returns the process exit code; `src/bin.ts` exits with it.
 */
import { dirname, join } from "node:path";
import { loadConfig, resolveConfigPath } from "../config";
import { hostOmp } from "../omp-version";
import { BUILD, SERVICE_VERSION } from "../version";
import { applyStaged } from "./apply";
import { readSchemaVersion, readUpdateSettings } from "./db";
import { isVersion } from "./manifest";
import { CHECKOUT_MESSAGE } from "./policy";
import { createUpdateService, healthBase, openUpdateContext, realApplyDeps, type UpdateContext } from "./real";
import type { UpdateService, UpdateStatus } from "./service";

const USAGE = [
	"usage: omp-cloud update [--config <path>]",
	"       omp-cloud update apply [--config <path>]",
	"       omp-cloud update apply-staged --version <version> --config <path>",
].join("\n");

interface UpdateArgs {
	command: "check" | "apply" | "apply-staged";
	configPath: string;
	version: string;
}

function parseArgs(args: readonly string[]): UpdateArgs {
	let command: UpdateArgs["command"] = "check";
	let config: string | undefined;
	let version = "";
	const rest = [...args];
	const first = rest[0];
	if (first === "apply" || first === "apply-staged") {
		command = first;
		rest.shift();
	}
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		const value = rest[i + 1];
		if (flag === "--config" && value !== undefined && value !== "") config = value;
		else if (flag === "--version" && value !== undefined && command === "apply-staged") version = value;
		else throw new Error(`unknown or incomplete argument ${JSON.stringify(flag)}`);
		i++;
	}
	if (command === "apply-staged") {
		if (!isVersion(version)) throw new Error("apply-staged needs --version <X.Y.Z>");
		if (config === undefined) throw new Error("apply-staged needs --config <path>");
	}
	return { command, configPath: resolveConfigPath(config), version };
}

function describe(status: UpdateStatus): string {
	const lines = [`omp-cloud ${status.current.version} (${status.current.build.id})`, `state: ${status.state}`];
	if (status.message !== null) lines.push(status.message);
	if (status.latest !== null) lines.push(`latest: ${status.latest.version} (published ${status.latest.publishedAt})`);
	if (status.staged !== null) lines.push(`staged: ${status.staged}`);
	if (status.applying !== null) lines.push(`applying ${status.applying.version}: step ${status.applying.step}`);
	if (status.error !== null) lines.push(`error: ${status.error}`);
	if (status.checkedAt !== null) lines.push(`checked: ${status.checkedAt}`);
	if (status.last !== null) lines.push(`last: ${status.last.result} ${status.last.version} (${status.last.message})`);
	return lines.join("\n");
}

/** The updater of this process, reading its settings from the database file. */
async function localService(context: UpdateContext): Promise<UpdateService> {
	const { config } = context;
	return createUpdateService({
		context,
		settings: () => readUpdateSettings(config.dataDir),
		busyThreads: () => 0,
		ompVersion: (await hostOmp()).version,
		schema: readSchemaVersion(config.dataDir),
	});
}

/** The owner token the CLI may use against the running service: `OMP_CLOUD_TOKEN`, else `service.token` beside the config. */
async function ownerToken(configPath: string): Promise<string | null> {
	const fromEnv = process.env.OMP_CLOUD_TOKEN;
	if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
	try {
		const text = (await Bun.file(join(dirname(configPath), "service.token")).text()).trim();
		return text === "" ? null : text;
	} catch {
		return null;
	}
}

/** Asks the running service to apply. `started`: it did; `refused`: it answered 409 with `message`; null: it could not be asked (down, no token, not the owner). */
async function askService(context: UpdateContext): Promise<{ kind: "started" } | { kind: "refused"; message: string } | null> {
	const token = await ownerToken(context.configPath);
	if (token === null) return null;
	try {
		const response = await fetch(`${healthBase(context.config.listen)}/api/v1/update/apply`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 202) return { kind: "started" };
		if (response.status === 409) {
			const body: unknown = await response.json().catch(() => null);
			const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "the service refused";
			return { kind: "refused", message };
		}
		return null;
	} catch {
		return null;
	}
}

async function run(parsed: UpdateArgs): Promise<number> {
	const config = await loadConfig(parsed.configPath);
	const context = await openUpdateContext(config, parsed.configPath);

	if (parsed.command === "apply-staged") {
		const outcome = await applyStaged(parsed.version, await realApplyDeps(context));
		if (!outcome.ok) console.error(`omp-cloud: ${outcome.message}`);
		return outcome.ok ? 0 : 1;
	}

	if (!context.managed) {
		console.log(`omp-cloud ${SERVICE_VERSION} (${BUILD.id})\nstate: unsupported\n${CHECKOUT_MESSAGE}`);
		return 1;
	}
	const service = await localService(context);
	let status = await service.status();
	if (parsed.command === "check" || status.state !== "ready") {
		await service.check();
		status = await service.status();
	}
	if (parsed.command === "check") {
		console.log(describe(status));
		return status.state === "failed" ? 1 : 0;
	}

	if (status.state !== "ready" && status.state !== "failed") {
		console.log(`${describe(status)}\nno update is ready`);
		return 1;
	}
	if (status.staged === null) {
		console.log(`${describe(status)}\nno update is staged`);
		return 1;
	}
	const asked = await askService(context);
	if (asked?.kind === "started") {
		console.log(`the service is installing omp-cloud ${status.staged}; run omp-cloud update to follow it`);
		return 0;
	}
	if (asked?.kind === "refused") {
		console.error(`omp-cloud: ${asked.message}`);
		return 1;
	}
	console.log(`the service could not be asked (no owner token or not running): installing omp-cloud ${status.staged} from here`);
	const outcome = await applyStaged(status.staged, await realApplyDeps(context));
	console.log(outcome.message);
	return outcome.ok ? 0 : 1;
}

/** `omp-cloud update …`; `args` follow the word `update`. */
export async function updateMain(args: readonly string[]): Promise<number> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(USAGE);
		return 0;
	}
	let parsed: UpdateArgs;
	try {
		parsed = parseArgs(args);
	} catch (error) {
		console.error(`omp-cloud: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 2;
	}
	try {
		return await run(parsed);
	} catch (error) {
		console.error(`omp-cloud: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

export { installMain } from "./install";
