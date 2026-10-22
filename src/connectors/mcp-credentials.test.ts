import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { type McpRefresher, type McpStoredCredential, McpCredentials } from "./mcp-credentials";

const URL_ = "https://mcp.example.com/mcp";
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** The store's two methods over a map. */
function memoryStore(initial: Record<string, McpStoredCredential | string> = {}) {
	const rows = new Map(Object.entries(initial).map(([url, value]) => [url, typeof value === "string" ? value : JSON.stringify(value)]));
	const puts: { url: string; at: string }[] = [];
	return {
		rows,
		puts,
		store: {
			mcpCredential: (url: string) => rows.get(url) ?? null,
			putMcpCredential: (url: string, credential: string, at: string) => {
				rows.set(url, credential);
				puts.push({ url, at });
			},
		},
	};
}

function credential(over: Partial<McpStoredCredential> = {}): McpStoredCredential {
	return { access: "old-access", refresh: "old-refresh", expires: NOW + 60 * MINUTE, tokenUrl: "https://auth.example.com/token", clientId: "client-1", resource: URL_, ...over };
}

let errors: Mock<typeof console.error>;

beforeEach(() => {
	errors = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	errors.mockRestore();
});

describe("McpCredentials.access", () => {
	test("is null for a URL with no credential, or one that is not a credential", async () => {
		const { store } = memoryStore({ "https://other.example.com/mcp": "not json", "https://third.example.com/mcp": "{}" });
		const credentials = new McpCredentials({ store, now: () => NOW });
		expect(await credentials.access(URL_)).toBeNull();
		expect(await credentials.access("https://other.example.com/mcp")).toBeNull();
		expect(await credentials.access("https://third.example.com/mcp")).toBeNull();
	});

	test("returns a token that is good for more than 5 minutes as it is, without refreshing", async () => {
		const { store } = memoryStore({ [URL_]: credential({ expires: NOW + 5 * MINUTE }) });
		let refreshes = 0;
		const refresh: McpRefresher = async () => {
			refreshes++;
			return { access: "x", refresh: "y", expires: 0 };
		};
		expect(await new McpCredentials({ store, refresh, now: () => NOW }).access(URL_)).toBe("old-access");
		expect(refreshes).toBe(0);
	});

	test("refreshes within 5 minutes of expiry with the stored material and persists the result", async () => {
		const { store, rows, puts } = memoryStore({ [URL_]: credential({ expires: NOW + 5 * MINUTE - 1, clientSecret: "shh" }) });
		const seen: McpStoredCredential[] = [];
		const refresh: McpRefresher = async stored => {
			seen.push(stored);
			return { access: "new-access", refresh: "new-refresh", expires: NOW + 3600_000 };
		};
		const credentials = new McpCredentials({ store, refresh, now: () => NOW });
		expect(await credentials.access(URL_)).toBe("new-access");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ refresh: "old-refresh", tokenUrl: "https://auth.example.com/token", clientId: "client-1", clientSecret: "shh", resource: URL_ });
		expect(puts).toEqual([{ url: URL_, at: new Date(NOW).toISOString() }]);
		expect(JSON.parse(rows.get(URL_) ?? "null")).toMatchObject({ access: "new-access", refresh: "new-refresh", expires: NOW + 3600_000, clientId: "client-1", clientSecret: "shh" });
		// The persisted token is now fresh: no second refresh.
		expect(await credentials.access(URL_)).toBe("new-access");
		expect(seen).toHaveLength(1);
	});

	test("an expired token is refreshed too", async () => {
		const { store } = memoryStore({ [URL_]: credential({ expires: NOW - MINUTE }) });
		const credentials = new McpCredentials({ store, refresh: async () => ({ access: "fresh", refresh: "r", expires: NOW + 3600_000 }), now: () => NOW });
		expect(await credentials.access(URL_)).toBe("fresh");
	});

	test("concurrent callers share one refresh per URL", async () => {
		const { store } = memoryStore({ [URL_]: credential({ expires: NOW }) });
		const release = Promise.withResolvers<void>();
		let refreshes = 0;
		const refresh: McpRefresher = async () => {
			refreshes++;
			await release.promise;
			return { access: "shared", refresh: "r", expires: NOW + 3600_000 };
		};
		const credentials = new McpCredentials({ store, refresh, now: () => NOW });
		const calls = [credentials.access(URL_), credentials.access(URL_), credentials.access(URL_)];
		release.resolve();
		expect(await Promise.all(calls)).toEqual(["shared", "shared", "shared"]);
		expect(refreshes).toBe(1);
	});

	test("a failed refresh returns null, keeps the stored credential and is logged once", async () => {
		const { store, rows } = memoryStore({ [URL_]: credential({ expires: NOW }) });
		const before = rows.get(URL_);
		const refresh: McpRefresher = async () => {
			throw new Error("invalid_grant");
		};
		const credentials = new McpCredentials({ store, refresh, now: () => NOW });
		expect(await credentials.access(URL_)).toBeNull();
		expect(await credentials.access(URL_)).toBeNull();
		expect(rows.get(URL_)).toBe(before);
		expect(errors).toHaveBeenCalledTimes(1);
		expect(String(errors.mock.calls[0]?.[0])).toContain("invalid_grant");
	});

	test("without a refresh token the access token is used until it expires", async () => {
		const { store } = memoryStore({ [URL_]: credential({ refresh: "", expires: NOW + MINUTE }) });
		expect(await new McpCredentials({ store, now: () => NOW }).access(URL_)).toBe("old-access");
		const expired = memoryStore({ [URL_]: credential({ refresh: "", expires: NOW - 1 }) });
		expect(await new McpCredentials({ store: expired.store, now: () => NOW }).access(URL_)).toBeNull();
	});
});
