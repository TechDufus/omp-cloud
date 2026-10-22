import { refreshMCPOAuthToken } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { isRecord } from "../guards";
import type { Store } from "../store";

/** What the store keeps per MCP server URL after the service logged in to it: the token and the material to refresh it. */
export interface McpStoredCredential {
	access: string;
	refresh: string;
	/** Epoch ms. */
	expires: number;
	tokenUrl: string;
	clientId?: string;
	clientSecret?: string;
	resource?: string;
	/** The authorization server the grant was minted against (omp filters same-origin resource indicators on refresh with it). */
	authorizationUrl?: string;
}

/** Exchanges a stored credential's refresh token for a new token. */
export type McpRefresher = (credential: McpStoredCredential) => Promise<{ access: string; refresh: string; expires: number }>;

/** A token this close to its expiry is refreshed before use. */
const REFRESH_WINDOW_MS = 5 * 60_000;

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** The stored credential in `json`; null when it is not one. */
function parseCredential(json: string): McpStoredCredential | null {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return null;
	}
	if (!isRecord(raw) || typeof raw.access !== "string" || typeof raw.refresh !== "string" || typeof raw.expires !== "number" || typeof raw.tokenUrl !== "string") return null;
	return {
		access: raw.access,
		refresh: raw.refresh,
		expires: raw.expires,
		tokenUrl: raw.tokenUrl,
		clientId: optionalString(raw, "clientId"),
		clientSecret: optionalString(raw, "clientSecret"),
		resource: optionalString(raw, "resource"),
		authorizationUrl: optionalString(raw, "authorizationUrl"),
	};
}

/** omp's refresh_token grant, with the material the login stored. */
const refreshWithOmp: McpRefresher = credential =>
	refreshMCPOAuthToken(credential.tokenUrl, credential.refresh, credential.clientId, credential.clientSecret, credential.resource, {
		authorizationUrl: credential.authorizationUrl,
	});

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The OAuth tokens the service holds for MCP servers it logged in to, refreshed on use. */
export class McpCredentials {
	readonly #store: Pick<Store, "mcpCredential" | "putMcpCredential">;
	readonly #refresh: McpRefresher;
	readonly #now: () => number;
	/** One refresh at a time per URL. */
	readonly #inflight = new Map<string, Promise<string | null>>();
	/** URLs whose last refresh failed and was logged: logged again only after one succeeds. */
	readonly #failed = new Set<string>();

	constructor(options: { store: Pick<Store, "mcpCredential" | "putMcpCredential">; refresh?: McpRefresher; now?: () => number }) {
		this.#store = options.store;
		this.#refresh = options.refresh ?? refreshWithOmp;
		this.#now = options.now ?? Date.now;
	}

	/** The access token for the MCP server at `url`, refreshed when it expires within 5 minutes; null when there is none or it cannot be refreshed. */
	async access(url: string): Promise<string | null> {
		const json = this.#store.mcpCredential(url);
		const credential = json === null ? null : parseCredential(json);
		if (credential === null) return null;
		if (credential.expires - this.#now() >= REFRESH_WINDOW_MS) return credential.access;
		if (credential.refresh === "") return credential.expires > this.#now() ? credential.access : null;
		const running = this.#inflight.get(url);
		if (running !== undefined) return running;
		const refreshing = this.#refreshStored(url, credential).finally(() => this.#inflight.delete(url));
		this.#inflight.set(url, refreshing);
		return refreshing;
	}

	async #refreshStored(url: string, credential: McpStoredCredential): Promise<string | null> {
		try {
			const refreshed = await this.#refresh(credential);
			const stored: McpStoredCredential = { ...credential, ...refreshed };
			this.#store.putMcpCredential(url, JSON.stringify(stored), new Date(this.#now()).toISOString());
			this.#failed.delete(url);
			return stored.access;
		} catch (error) {
			if (!this.#failed.has(url)) {
				this.#failed.add(url);
				console.error(`omp-cloud: refreshing the MCP login for ${url} failed: ${describe(error)}`);
			}
			return null;
		}
	}
}
