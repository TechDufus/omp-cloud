/**
 * The model login of `omp-cloud setup` and `omp-cloud login [<provider>]`: it drives the service's own flow
 * (`POST /api/v1/logins`, `POST …/input`, `GET …`, `DELETE …`) with `service.token`, so the OAuth flow runs on the
 * service host against the cloud broker and the user never needs `HOME=… omp auth-broker login`. The URL is printed
 * first and in full; a device-code provider shows its code; any other provider ends on a page that may not load (the
 * browser can be on another machine), so the person may paste that page's URL or the code it shows. The paste is read
 * while the login is polled, because a browser on the service host completes it by itself.
 */
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import type { LoginView } from "../auth/login";
import { loadConfig, resolveConfigPath } from "../config";
import { isRecord } from "../guards";
import { Reporter, type StepResult } from "./steps";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Where the service is and the token that opens its API. */
export interface ServiceAccess {
	/** `http://127.0.0.1:8080`, without a trailing slash. */
	serviceUrl: string;
	/** `service.token`: read on every call, never printed. */
	tokenFile: string;
	fetch?: Fetch;
}

/** The person at the terminal. */
export interface LoginIo {
	/** One line for the person. */
	print(line: string): void;
	/** Whether someone can answer: stdin is a terminal. */
	interactive: boolean;
	/** One line typed; null at the end of input or when `signal` aborts. */
	ask(question: string, signal: AbortSignal): Promise<string | null>;
}

/** A provider the service can log in to. */
export interface ProviderChoice {
	id: string;
	name: string;
}

export interface LoginStepOptions extends ServiceAccess {
	io: LoginIo;
	/** The provider to log in to. Absent: nothing to do when the cloud already runs a provider, else the picker. */
	provider?: string;
	/** What the service can log in to; default is omp's own list. */
	providers?: () => Promise<ProviderChoice[]>;
	/** Milliseconds between two polls of a waiting login. Default 2000. */
	pollMs?: number;
	/** Gives up waiting after this long; the service fails a login after 5 minutes by itself. Default 6 minutes. */
	maxMs?: number;
	sleep?: (ms: number) => Promise<void>;
	/** Cancels the login (Ctrl+C). */
	signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_MAX_MS = 6 * 60_000;
const SERVICE_FIX = "systemctl --user status omp-cloud";
const PASTE_QUESTION = "paste the redirect URL or code (Enter waits for the browser): ";

/** A failed call to the service: its HTTP status (0 when it could not be reached) and the message it gave. */
class ServiceError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ServiceError";
		this.status = status;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The service's API as the login needs it. */
class ServiceClient {
	readonly #access: ServiceAccess;

	constructor(access: ServiceAccess) {
		this.#access = access;
	}

	async #call(method: string, path: string, body?: unknown): Promise<unknown> {
		let token: string;
		try {
			token = (await Bun.file(this.#access.tokenFile).text()).trim();
		} catch {
			throw new ServiceError(0, `cannot read the service token at ${this.#access.tokenFile}`);
		}
		const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) };
		if (body !== undefined) init.body = JSON.stringify(body);
		let response: Response;
		try {
			response = await (this.#access.fetch ?? fetch)(`${this.#access.serviceUrl}${path}`, init);
		} catch (error) {
			throw new ServiceError(0, `the service at ${this.#access.serviceUrl} is not reachable (${describe(error)})`);
		}
		let json: unknown = null;
		try {
			json = await response.json();
		} catch {
			// An empty or non-JSON body: the status says enough.
		}
		if (!response.ok) {
			const message = isRecord(json) && typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
			throw new ServiceError(response.status, response.status === 401 ? "the service rejected service.token" : message);
		}
		return json;
	}

	/** The providers the cloud can run right now: `modelPatterns` of `whoami`, `provider/*` each. */
	async served(): Promise<string[]> {
		const whoami = await this.#call("GET", "/api/v1/whoami");
		const patterns = isRecord(whoami) && Array.isArray(whoami.modelPatterns) ? whoami.modelPatterns : [];
		return patterns.flatMap((pattern): string[] => (typeof pattern === "string" && pattern.endsWith("/*") ? [pattern.slice(0, -2)] : []));
	}

	async start(provider: string): Promise<LoginView> {
		return parseLogin(await this.#call("POST", "/api/v1/logins", { provider }));
	}

	async get(id: string): Promise<LoginView> {
		return parseLogin(await this.#call("GET", `/api/v1/logins/${encodeURIComponent(id)}`));
	}

	async input(id: string, input: string): Promise<LoginView> {
		return parseLogin(await this.#call("POST", `/api/v1/logins/${encodeURIComponent(id)}/input`, { input }));
	}

	async cancel(id: string): Promise<void> {
		await this.#call("DELETE", `/api/v1/logins/${encodeURIComponent(id)}`);
	}
}

function parseLogin(value: unknown): LoginView {
	if (!isRecord(value)) throw new ServiceError(0, "the service answered something that is not a login");
	const { id, provider, state, url, instructions, userCode, account, error } = value;
	if (
		typeof id !== "string" ||
		typeof provider !== "string" ||
		(state !== "waiting" && state !== "done" && state !== "failed") ||
		typeof url !== "string" ||
		typeof instructions !== "string" ||
		typeof userCode !== "string" ||
		typeof account !== "string" ||
		typeof error !== "string"
	) {
		throw new ServiceError(0, "the service answered something that is not a login");
	}
	return { id, provider, state, url, instructions, userCode, account, error };
}

/** The providers the cloud can run right now (`whoami.modelPatterns`); throws a ServiceError-backed Error with the reason. */
export async function servedProviders(access: ServiceAccess): Promise<string[]> {
	return new ServiceClient(access).served();
}

/**
 * omp's own OAuth providers, the list the service's login flow accepts. Imported when the picker needs it: the SDK
 * installs process-wide signal and exit handlers and loads slowly, which a setup that never asks must not pay for.
 */
async function ompProviders(): Promise<ProviderChoice[]> {
	const { getOAuthProviders } = await import("@oh-my-pi/pi-ai");
	return getOAuthProviders()
		.filter((info) => info.available)
		.map((info) => ({ id: info.id, name: info.name }));
}

function loginFailure(detail: string, fix: string): StepResult {
	return { id: "login", status: "failed", detail, fix };
}

/** Lists the providers, marks the ones the cloud already runs and asks for one by number or id; null when the person gives none. */
export async function chooseProvider(options: Pick<LoginStepOptions, "io" | "providers" | "signal">, served: readonly string[]): Promise<string | null> {
	const { io } = options;
	const choices = await (options.providers ?? ompProviders)();
	if (choices.length === 0) return null;
	io.print("providers the cloud can log in to:");
	choices.forEach((choice, index) => io.print(`  ${index + 1}) ${choice.name} (${choice.id})${served.includes(choice.id) ? "  logged in" : ""}`));
	const signal = options.signal ?? new AbortController().signal;
	for (;;) {
		const answer = (await io.ask("provider (number or id, Enter to skip): ", signal))?.trim();
		if (answer === undefined || answer === "") return null;
		const numbered = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
		const named = choices.find((choice) => choice.id === answer);
		const picked = numbered ?? named;
		if (picked !== undefined) return picked.id;
		io.print(`no provider ${JSON.stringify(answer.slice(0, 64))} in the list`);
	}
}

/** What to show for a login that is waiting. */
function loginLines(login: LoginView): string[] {
	const lines = [`logging the cloud broker in to ${login.provider}`, `  open: ${login.url}`];
	if (login.userCode !== "") lines.push(`  enter the code: ${login.userCode}`);
	if (login.instructions !== "") lines.push(`  ${login.instructions}`);
	if (login.userCode === "") {
		lines.push("  the browser may be on another machine: if the page it ends on does not load, paste that page's URL (or the code it shows) here");
	}
	return lines;
}

/** Reads pasted answers until one is accepted, the input ends or `signal` aborts. */
async function pasteAnswers(client: ServiceClient, io: LoginIo, id: string, signal: AbortSignal): Promise<void> {
	for (;;) {
		const text = (await io.ask(PASTE_QUESTION, signal))?.trim();
		if (text === undefined) return;
		if (text === "") continue;
		try {
			await client.input(id, text);
		} catch (error) {
			// 409: the login finished or failed while the person was typing; the poll reports which.
			if (!(error instanceof ServiceError && error.status === 409)) throw error;
		}
		return;
	}
}

/** Runs one login to its end and reports it as a step. */
async function runLogin(client: ServiceClient, options: LoginStepOptions, provider: string): Promise<StepResult> {
	const { io } = options;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	let login = await client.start(provider);
	if (login.state === "waiting") io.print(loginLines(login).join("\n"));
	if (login.state === "waiting" && login.userCode === "" && !io.interactive) {
		await client.cancel(login.id).catch(() => undefined);
		return loginFailure(`${provider} needs a pasted redirect URL or code, and there is no terminal to read it from`, `omp-cloud login ${provider}`);
	}

	const asking = new AbortController();
	const pasted =
		login.state === "waiting" && login.userCode === "" ? pasteAnswers(client, io, login.id, asking.signal).catch((error: unknown) => io.print(`could not send the answer: ${describe(error)}`)) : Promise.resolve();
	try {
		const deadline = Date.now() + (options.maxMs ?? DEFAULT_MAX_MS);
		while (login.state === "waiting") {
			if (options.signal?.aborted === true) {
				await client.cancel(login.id).catch(() => undefined);
				return loginFailure(`login to ${provider} cancelled`, `omp-cloud login ${provider}`);
			}
			if (Date.now() > deadline) {
				await client.cancel(login.id).catch(() => undefined);
				return loginFailure(`login to ${provider} did not finish in time`, `omp-cloud login ${provider}`);
			}
			await sleep(options.pollMs ?? DEFAULT_POLL_MS);
			login = await client.get(login.id);
		}
	} finally {
		asking.abort();
		await pasted;
	}
	if (login.state === "done") {
		return { id: "login", status: "changed", detail: `logged in to ${provider}${login.account === "" ? "" : ` as ${login.account}`}` };
	}
	return loginFailure(`login to ${provider} failed${login.error === "" ? "" : `: ${login.error}`}`, `omp-cloud login ${provider}`);
}

/**
 * The login step of setup and `omp-cloud login <provider>`. With a `provider` it logs in to it (again too). Without
 * one it reports that the cloud already runs a provider and stops there, else asks which provider (skipped when nobody
 * can answer). Failures name their fix.
 */
export async function loginStep(options: LoginStepOptions): Promise<StepResult[]> {
	const client = new ServiceClient(options);
	try {
		let provider = options.provider;
		if (provider === undefined) {
			const served = await client.served();
			if (served.length > 0) return [{ id: "login", status: "ok", detail: `the cloud can already run ${served.join(", ")}` }];
			if (!options.io.interactive) return [{ id: "login", status: "skipped", detail: "no model provider yet; log in later: omp-cloud login <provider>" }];
			const chosen = await chooseProvider(options, served);
			if (chosen === null) return [{ id: "login", status: "skipped", detail: "no provider chosen; log in later: omp-cloud login <provider>" }];
			provider = chosen;
		}
		return [await runLogin(client, options, provider)];
	} catch (error) {
		return [loginFailure(describe(error), error instanceof ServiceError && error.status === 0 ? SERVICE_FIX : `omp-cloud login ${options.provider ?? "<provider>"}`)];
	}
}

/** stdin and stdout as the person's terminal. */
export function terminalIo(): LoginIo {
	return {
		print: (line) => void process.stdout.write(`${line}\n`),
		interactive: process.stdin.isTTY === true,
		ask: async (question, signal) => {
			const rl = createInterface({ input: process.stdin, output: process.stderr });
			// A terminal in raw mode turns Ctrl+C into this event instead of a signal: pass it on, so the login is cancelled.
			rl.once("SIGINT", () => process.kill(process.pid, "SIGINT"));
			const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
			const answered = new Promise<string | null>((resolve) => rl.question(question, { signal }, resolve));
			signal.addEventListener("abort", () => rl.close(), { once: true });
			try {
				return await Promise.race([answered, closed]);
			} finally {
				rl.close();
			}
		},
	};
}

const LOGIN_USAGE = "usage: omp-cloud login [<provider>]";

/** What `loginMain` takes from its caller; tests pass fakes. */
export interface LoginMainDeps {
	io?: LoginIo;
	/** What the service can log in to; default is omp's own list. */
	providers?: () => Promise<ProviderChoice[]>;
}

/** The providers one per line, `<id>  <name>`, marking the ones the cloud already runs (when the service could say). */
async function printProviders(io: LoginIo, providers: () => Promise<ProviderChoice[]>, served: readonly string[]): Promise<void> {
	for (const choice of await providers()) io.print(`${choice.id}  ${choice.name}${served.includes(choice.id) ? "  (logged in)" : ""}`);
}

/** `omp-cloud login [<provider>]`: returns the exit code (0 done, 1 failed, 2 usage). `--help` lists the providers too. */
export async function loginMain(argv: readonly string[], deps: LoginMainDeps = {}): Promise<number> {
	const [provider, ...rest] = argv;
	const help = provider === "--help" || provider === "-h";
	if (rest.length > 0 || (provider?.startsWith("-") === true && !help)) {
		process.stderr.write(`${LOGIN_USAGE}\n`);
		return 2;
	}
	const io = deps.io ?? terminalIo();
	const providers = deps.providers ?? ompProviders;
	const configPath = resolveConfigPath(undefined);
	let access: ServiceAccess;
	try {
		const config = await loadConfig(configPath);
		const host = config.listen.hostname.includes(":") ? `[${config.listen.hostname}]` : config.listen.hostname;
		access = { serviceUrl: `http://${host}:${config.listen.port}`, tokenFile: join(dirname(configPath), "service.token") };
	} catch (error) {
		if (help) {
			io.print(LOGIN_USAGE);
			return 0;
		}
		process.stderr.write(`omp-cloud login: ${describe(error)}\n`);
		return 1;
	}

	if (help) {
		io.print(LOGIN_USAGE);
		const served = await servedProviders(access).catch(() => undefined);
		// Only when the service answers: the list is what its login flow accepts.
		if (served !== undefined) await printProviders(io, providers, served);
		return 0;
	}

	const abort = new AbortController();
	const onInterrupt = (): void => abort.abort();
	process.once("SIGINT", onInterrupt);
	const reporter = Reporter.forProcess(false);
	try {
		let chosen = provider;
		if (chosen === undefined) {
			if (!io.interactive) {
				io.print(LOGIN_USAGE);
				await printProviders(io, providers, await servedProviders(access).catch(() => []));
				io.print("name one: omp-cloud login <provider>");
				return 2;
			}
			chosen = (await chooseProvider({ io, providers, signal: abort.signal }, await servedProviders(access))) ?? undefined;
			if (chosen === undefined) {
				reporter.note("no provider chosen");
				return 0;
			}
		}
		reporter.reportAll(await loginStep({ ...access, io, provider: chosen, signal: abort.signal }));
	} catch (error) {
		reporter.report(loginFailure(describe(error), SERVICE_FIX));
	} finally {
		process.removeListener("SIGINT", onInterrupt);
	}
	return reporter.failed ? 1 : 0;
}
