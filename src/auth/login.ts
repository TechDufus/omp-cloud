/**
 * `/cloud login <provider>`: runs omp's own OAuth login for a provider on the service host and stores the finished
 * credential in the cloud broker only, through the broker's `POST /v1/credential`. The broker has no endpoint that runs
 * an OAuth login (omp's own `omp auth-broker login` runs the flow in-process against the broker host's database), so the
 * flow runs here, in this process, and the broker's next snapshot picks the credential up. The refresh token exists in
 * this process between the provider's token exchange and that upload; it is never written to disk, logged or returned.
 * A flow takes the redirect URL or code pasted back by the owner (`onManualCodeInput`), so a service on the broker host
 * can drive a login for an owner on another machine; a device-code provider needs no callback or paste at all.
 */
import { randomBytes } from "node:crypto";
import { type AuthCredential, getOAuthProvider, getOAuthProviders, getProviderDefinition } from "@oh-my-pi/pi-ai";
import { formatLoginIdentity } from "@oh-my-pi/pi-coding-agent/cli/oauth-terminal";

/** A login as the API shows it (`docs/api.md`, Logins). Empty strings stand for "none". */
export interface LoginView {
	id: string;
	provider: string;
	state: "waiting" | "done" | "failed";
	/** Where the owner signs in. */
	url: string;
	/** What to do there, or the question the provider is asking. */
	instructions: string;
	/** The code to enter at `url` (device-code providers). */
	userCode: string;
	/** The signed-in identity once `state` is `done`. */
	account: string;
	/** Why the login failed. */
	error: string;
}

export interface LoginOptions {
	brokerUrl: string;
	/** Absolute path of the broker's bearer token file; read on every login, never logged. */
	brokerTokenFile: string;
	/** A waiting login fails after this long. Default 5 minutes. */
	timeoutMs?: number;
	/** How long a finished login stays readable. Default 10 minutes. */
	retentionMs?: number;
	/** The provider boundary; default is omp's own login flows. */
	flow?: LoginFlow;
}

export type LoginErrorCode = "unknown_provider" | "not_found" | "not_waiting";

export class LoginError extends Error {
	readonly code: LoginErrorCode;

	constructor(code: LoginErrorCode, message: string) {
		super(message);
		this.name = "LoginError";
		this.code = code;
	}
}

/** What a provider flow reports to the manager. */
export interface LoginController {
	/** Aborts when the login is cancelled, times out or finishes. */
	readonly signal: AbortSignal;
	/** The page to sign in at; `instructions` may be empty. */
	auth(url: string, instructions: string): void;
	progress(message: string): void;
	/** Resolves with the next `input`; a non-empty `message` replaces the login's instructions. Rejects when `signal` aborts. */
	prompt(message: string, signal?: AbortSignal): Promise<string>;
}

/** A finished provider flow: the credential to store and who it belongs to. */
export interface LoginResult {
	/** The provider id the credential is stored under (may differ from the login's provider). */
	provider: string;
	credential: AuthCredential;
	account: string;
}

/** The boundary to the external OAuth providers. */
export interface LoginFlow {
	has(provider: string): boolean;
	/** Drives the provider's login to its end; rejects when `controller.signal` aborts or the provider refuses. */
	run(provider: string, controller: LoginController): Promise<LoginResult>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RETENTION_MS = 10 * 60_000;
/** How long `start` waits for the provider to offer a sign-in. */
const START_WAIT_MS = 30_000;
/** How long `input` waits to see what the input did. */
const INPUT_WAIT_MS = 20_000;
/** How long a replaced login gets to release its callback port (a provider's callback port is fixed: anthropic 54545, openai-codex 1455). */
const REPLACE_WAIT_MS = 2_000;
const UPLOAD_TIMEOUT_MS = 15_000;
const USER_CODE = /Enter code:\s*(\S+)/i;

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** omp's login flows: `AuthStorage.oauth.login` without the storage (the broker is the storage). */
export const ompLoginFlow: LoginFlow = {
	has(provider) {
		return getOAuthProviders().some(info => info.id === provider);
	},
	async run(provider, controller) {
		const definition = getProviderDefinition(provider) ?? getOAuthProvider(provider);
		if (!definition?.login) throw new Error(`${provider} has no OAuth login`);
		const result = await definition.login({
			onAuth: ({ url, instructions }) => controller.auth(url, instructions ?? ""),
			onProgress: message => controller.progress(message),
			onPrompt: prompt => controller.prompt(prompt.placeholder ? `${prompt.message} (${prompt.placeholder})` : prompt.message),
			onManualCodeInput: signal => controller.prompt("", signal),
			signal: controller.signal,
		});
		const storeAs = definition.storeCredentialsAs ?? provider;
		if (typeof result === "string") {
			if (result === "") throw new Error("the login stored nothing");
			return { provider: storeAs, credential: { type: "api_key", key: result, source: "login" }, account: "" };
		}
		const identity = { type: "oauth", email: result.email, accountId: result.accountId, orgId: result.orgId, orgName: result.orgName } as const;
		return {
			provider: storeAs,
			credential: { type: "oauth", ...result, authorizedAt: Date.now() },
			account: formatLoginIdentity(identity) ?? "",
		};
	},
};

interface Waiter {
	resolve(text: string): void;
}

/** One login's mutable state. */
class Entry {
	readonly view: LoginView;
	readonly abort = new AbortController();
	readonly waiters = new Set<Waiter>();
	/** An input that arrived before the flow asked for one. */
	buffered: string | null = null;
	/** The sign-in or question was offered to the owner. */
	offered = false;
	/** The instructions are a progress message, which a later one may replace. */
	progressText = false;
	timer: NodeJS.Timeout | undefined;
	retainTimer: NodeJS.Timeout | undefined;
	settled: Promise<void> = Promise.resolve();
	#listeners: Array<() => void> = [];

	constructor(view: LoginView) {
		this.view = view;
	}

	/** Resolves at the next change of the login or after `ms`. */
	changed(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			resolve();
		}
		this.#listeners.push(done);
		return promise;
	}

	notify(): void {
		const listeners = this.#listeners;
		this.#listeners = [];
		for (const listener of listeners) listener();
	}
}

/** Owns every login: one waiting login per provider, finished ones kept for `get`. */
export class LoginManager {
	readonly #brokerUrl: string;
	readonly #tokenFile: string;
	readonly #timeoutMs: number;
	readonly #retentionMs: number;
	readonly #flow: LoginFlow;
	readonly #logins = new Map<string, Entry>();
	/** The waiting login of each provider. */
	readonly #waiting = new Map<string, Entry>();

	constructor(options: LoginOptions) {
		this.#brokerUrl = options.brokerUrl.replace(/\/+$/, "");
		this.#tokenFile = options.brokerTokenFile;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
		this.#flow = options.flow ?? ompLoginFlow;
	}

	/** Starts a login and returns it once the provider has offered a sign-in (or it has already ended). */
	async start(provider: string): Promise<LoginView> {
		if (!this.#flow.has(provider)) throw new LoginError("unknown_provider", `unknown provider ${JSON.stringify(provider.slice(0, 64))}`);
		let token = "";
		let tokenError = "";
		try {
			token = (await Bun.file(this.#tokenFile).text()).trim();
			if (token === "") tokenError = "the broker token file is empty";
		} catch {
			tokenError = "cannot read the broker token file";
		}
		const previous = this.#waiting.get(provider);
		if (previous) {
			this.#finish(previous, "failed", "cancelled by a newer login");
			await Promise.race([previous.settled, Bun.sleep(REPLACE_WAIT_MS)]);
		}
		const entry = new Entry({
			id: randomBytes(8).toString("hex"),
			provider,
			state: "waiting",
			url: "",
			instructions: "",
			userCode: "",
			account: "",
			error: "",
		});
		this.#logins.set(entry.view.id, entry);
		if (tokenError !== "") {
			this.#finish(entry, "failed", tokenError);
			return { ...entry.view };
		}
		this.#waiting.set(provider, entry);
		entry.timer = setTimeout(() => this.#finish(entry, "failed", "login timed out"), this.#timeoutMs);
		entry.timer.unref?.();
		entry.settled = this.#run(entry, token);
		const deadline = Date.now() + START_WAIT_MS;
		while (entry.view.state === "waiting" && !entry.offered) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				this.#finish(entry, "failed", "the provider did not offer a sign-in in time");
				break;
			}
			await entry.changed(remaining);
		}
		return { ...entry.view };
	}

	/** Hands the owner's pasted redirect URL, code or answer to the waiting flow. */
	async input(id: string, input: string): Promise<LoginView> {
		const entry = this.#logins.get(id);
		if (!entry) throw new LoginError("not_found", "no such login");
		if (entry.view.state !== "waiting") throw new LoginError("not_waiting", "login is not waiting for input");
		let waiter: Waiter | undefined;
		for (const candidate of entry.waiters) waiter = candidate;
		if (waiter) {
			entry.waiters.delete(waiter);
			waiter.resolve(input);
		} else {
			entry.buffered = input;
		}
		if (!entry.progressText) entry.view.instructions = "";
		entry.progressText = true;
		await entry.changed(INPUT_WAIT_MS);
		return { ...entry.view };
	}

	get(id: string): LoginView | null {
		const entry = this.#logins.get(id);
		return entry ? { ...entry.view } : null;
	}

	/** Fails a waiting login; false when there is none (unknown id or already ended). */
	cancel(id: string): boolean {
		const entry = this.#logins.get(id);
		if (!entry || entry.view.state !== "waiting") return false;
		this.#finish(entry, "failed", "cancelled");
		return true;
	}

	/** Cancels every waiting login and forgets all of them. */
	stop(): void {
		for (const entry of this.#logins.values()) {
			this.#finish(entry, "failed", "the service is stopping");
			clearTimeout(entry.retainTimer);
		}
		this.#logins.clear();
	}

	#controller(entry: Entry): LoginController {
		const view = entry.view;
		const progressText = (text: string): void => {
			view.instructions = text;
			entry.progressText = true;
		};
		return {
			signal: entry.abort.signal,
			auth: (url, instructions) => {
				view.url = url;
				if (instructions !== "") {
					view.instructions = instructions;
					entry.progressText = false;
					const code = USER_CODE.exec(instructions)?.[1];
					if (code !== undefined) view.userCode = code;
				}
				entry.offered = true;
				entry.notify();
			},
			progress: message => {
				if (view.instructions === "" || entry.progressText) progressText(message);
				entry.notify();
			},
			prompt: (message, signal) => {
				if (message !== "") {
					view.instructions = message;
					entry.progressText = false;
				}
				entry.offered = true;
				const buffered = entry.buffered;
				if (buffered !== null) {
					entry.buffered = null;
					return Promise.resolve(buffered);
				}
				const aborted = signal ? AbortSignal.any([entry.abort.signal, signal]) : entry.abort.signal;
				const { promise, resolve, reject } = Promise.withResolvers<string>();
				const waiter: Waiter = {
					resolve: text => {
						aborted.removeEventListener("abort", onAbort);
						resolve(text);
					},
				};
				function onAbort(): void {
					entry.waiters.delete(waiter);
					reject(aborted.reason instanceof Error ? aborted.reason : new Error("login cancelled"));
				}
				if (aborted.aborted) onAbort();
				else {
					aborted.addEventListener("abort", onAbort, { once: true });
					entry.waiters.add(waiter);
				}
				entry.notify();
				return promise;
			},
		};
	}

	async #run(entry: Entry, token: string): Promise<void> {
		try {
			const result = await this.#flow.run(entry.view.provider, this.#controller(entry));
			if (entry.view.state !== "waiting") return;
			const response = await fetch(`${this.#brokerUrl}/v1/credential`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ provider: result.provider, credential: result.credential }),
				signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]),
			});
			await response.body?.cancel();
			if (!response.ok) throw new Error(`the broker refused the credential (HTTP ${response.status})`);
			this.#finish(entry, "done", "", result.account);
		} catch (error) {
			this.#finish(entry, "failed", describe(error).replaceAll(token, "[redacted]"));
		}
	}

	/** Ends a waiting login; a no-op for one that already ended. */
	#finish(entry: Entry, state: "done" | "failed", error: string, account = ""): void {
		const view = entry.view;
		if (view.state !== "waiting") return;
		view.state = state;
		view.error = error;
		view.account = account;
		clearTimeout(entry.timer);
		if (this.#waiting.get(view.provider) === entry) this.#waiting.delete(view.provider);
		entry.waiters.clear();
		entry.buffered = null;
		entry.abort.abort(new Error(error === "" ? "login finished" : error));
		entry.retainTimer = setTimeout(() => this.#logins.delete(view.id), this.#retentionMs);
		entry.retainTimer.unref?.();
		entry.notify();
	}
}
