import { isRecord } from "../guards";
import type { GatewayClients } from "./clients";

const DEFAULT_REFRESH_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 1000;
/** `start()` waits this long for the gateway to accept the new client (it re-reads its clients file every 10 s). */
const DEFAULT_STARTUP_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5000;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface GatewayModelsOptions {
	clients: GatewayClients;
	url: string;
	/** The gateway client the service reads the model list with. Reconcile must never revoke it. */
	clientName: string;
	/** How often the list is re-read. Default 5 minutes. */
	refreshMs?: number;
	/** Test seams. */
	retryMs?: number;
	startupMs?: number;
}

/** The providers the gateway serves: `GET /v1/models` with the service's own client token, cached and refreshed. */
export class GatewayModels {
	readonly #clients: GatewayClients;
	readonly #url: string;
	readonly #clientName: string;
	readonly #refreshMs: number;
	readonly #retryMs: number;
	readonly #startupMs: number;
	#token: string | null = null;
	/** When `#token` was issued: 401s are expected until the gateway re-reads its clients file. */
	#issuedAt = 0;
	#providers: string[] = [];
	#ids: string[] = [];
	/** True once a read succeeded. */
	#loaded = false;
	/** The last read was answered 401: the gateway is up but has not picked up the client yet. */
	#awaitingAcceptance = false;
	#lastProblem = "";
	#inflight: Promise<void> | null = null;
	#timer: Timer | undefined;
	#stopped = false;

	constructor(options: GatewayModelsOptions) {
		this.#clients = options.clients;
		this.#url = options.url.replace(/\/+$/, "");
		this.#clientName = options.clientName;
		this.#refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
		this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
		this.#startupMs = options.startupMs ?? DEFAULT_STARTUP_MS;
	}

	/**
	 * Issues the service's own gateway client and loads the list. The client is reissued at every start, because only a
	 * token's hash is stored, so the list is ready only after the gateway's next re-read of its clients file (up to 10 s):
	 * a gateway that answers 401 has not read the client yet, so this waits for it; a gateway that does not answer is left
	 * to the background retries. Once running, a 401 that outlasts that wait means something else replaced the client's
	 * entry (another `omp-cloud` process, an edited clients file), so a fresh client is issued and the short retry cadence
	 * runs until the gateway accepts it. Never throws.
	 */
	async start(): Promise<void> {
		const deadline = Date.now() + this.#startupMs;
		while (!this.#stopped) {
			await this.refresh();
			if (this.#loaded || !this.#awaitingAcceptance || Date.now() + this.#retryMs > deadline) break;
			await Bun.sleep(this.#retryMs);
		}
		this.#schedule();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
	}

	/** Providers the gateway served at the last successful read, sorted. */
	providers(): string[] {
		return [...this.#providers];
	}

	/** The `provider/model` ids the gateway served at the last successful read, sorted. */
	modelIds(): string[] {
		return [...this.#ids];
	}

	/** Re-reads the list now; a failure is logged and keeps the last good list. Never throws. */
	refresh(): Promise<void> {
		this.#inflight ??= this.#read().finally(() => {
			this.#inflight = null;
		});
		return this.#inflight;
	}

	#schedule(): void {
		if (this.#stopped) return;
		this.#timer = setTimeout(
			() =>
				void this.refresh().then(() => {
					this.#schedule();
				}),
			this.#loaded && !this.#awaitingAcceptance ? this.#refreshMs : this.#retryMs,
		);
		this.#timer.unref();
	}

	async #read(): Promise<void> {
		this.#awaitingAcceptance = false;
		try {
			if (this.#token === null) {
				this.#token = await this.#clients.issue(this.#clientName);
				this.#issuedAt = Date.now();
			}
			const response = await fetch(`${this.#url}/v1/models`, {
				headers: { Authorization: `Bearer ${this.#token}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			this.#awaitingAcceptance = response.status === 401;
			if (response.status !== 200) {
				await response.body?.cancel();
				// A fresh client is unknown to the gateway until its next clients-file read (every 10 s): within the
				// startup window that 401 is the normal wait. After it the gateway has dropped or replaced the entry, so a
				// new client replaces whatever entry has this name; the window starts over for it.
				if (this.#awaitingAcceptance && Date.now() - this.#issuedAt >= this.#startupMs) {
					this.#token = await this.#clients.issue(this.#clientName);
					this.#issuedAt = Date.now();
					this.#report("the gateway no longer accepts the service's client (status 401); issued a new one");
					return;
				}
				throw new Error(`status ${response.status}`);
			}
			const served = modelListOf(await response.json());
			this.#providers = served.providers;
			this.#ids = served.ids;
			this.#loaded = true;
			this.#lastProblem = "";
		} catch (error) {
			if (this.#awaitingAcceptance && Date.now() - this.#issuedAt < this.#startupMs) return;
			const problem = error instanceof Error ? error.message : String(error);
			this.#report(`reading the gateway's models failed: ${problem}${this.#loaded ? "; keeping the last list" : ""}`, problem);
		}
	}

	/** Logs `message` unless `key` (default the message) is what was logged last; a successful read forgets it. */
	#report(message: string, key = message): void {
		if (key !== this.#lastProblem && !this.#stopped) console.error(`omp-cloud: ${message}`);
		this.#lastProblem = key;
	}
}

/** The distinct ids (`provider/model`, a well-formed provider) and providers of an OpenAI-style model list, both sorted. Throws for any other shape. */
function modelListOf(body: unknown): { ids: string[]; providers: string[] } {
	if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("the model list is not {data: [...]}");
	const ids = new Set<string>();
	const providers = new Set<string>();
	for (const entry of body.data) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const slash = entry.id.indexOf("/");
		const provider = slash < 1 ? "" : entry.id.slice(0, slash);
		if (!PROVIDER_PATTERN.test(provider)) continue;
		providers.add(provider);
		if (slash < entry.id.length - 1) ids.add(entry.id);
	}
	return { ids: [...ids].sort(), providers: [...providers].sort() };
}
