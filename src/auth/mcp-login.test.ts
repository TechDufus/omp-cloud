import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store";
import { LoginError, type LoginController } from "./login";
import { mcpLoginFlow } from "./mcp-login";

let dir: string;
let store: Store;
let server: Bun.Server<undefined>;
/** Whether the fake MCP server advertises OAuth metadata. */
let advertise: boolean;
let tokenRequests: URLSearchParams[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-mcp-login-"));
	store = Store.open({ dataDir: dir });
	advertise = true;
	tokenRequests = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const origin = `http://127.0.0.1:${server.port}`;
			if (!advertise) return new Response("nope", { status: 404 });
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					code_challenge_methods_supported: ["S256"],
				});
			}
			if (url.pathname === "/register") return Response.json({ client_id: "registered-client" }, { status: 201 });
			if (url.pathname === "/token") {
				tokenRequests.push(new URLSearchParams(await req.text()));
				return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			return new Response("nope", { status: 404 });
		},
	});
});

afterEach(async () => {
	await server.stop(true);
	store.close();
	await rm(dir, { recursive: true, force: true });
});

interface Driven {
	controller: LoginController;
	authUrl: () => string;
}

/** A login controller whose "browser" completes the sign-in: it answers the prompt with the redirect the provider would send. */
function driven(): Driven {
	let authUrl = "";
	const offered = Promise.withResolvers<string>();
	const abort = new AbortController();
	return {
		authUrl: () => authUrl,
		controller: {
			signal: abort.signal,
			auth: url => {
				authUrl = url;
				offered.resolve(url);
			},
			progress: () => undefined,
			prompt: async () => {
				const params = new URL(await offered.promise).searchParams;
				return `${params.get("redirect_uri")}?code=the-code&state=${params.get("state")}`;
			},
		},
	};
}

describe("mcpLoginFlow", () => {
	test("serves only mcp:<https url> providers", () => {
		const flow = mcpLoginFlow(store);
		expect(flow.has("mcp:https://mcp.example.com/mcp")).toBe(true);
		expect(flow.has("mcp:http://mcp.example.com/mcp")).toBe(false);
		expect(flow.has("anthropic")).toBe(false);
		expect(flow.has("mcp:")).toBe(false);
	});

	test("a server that advertises no OAuth endpoints is refused with a message that names it", async () => {
		advertise = false;
		const url = `http://127.0.0.1:${server.port}/mcp`;
		const error = await mcpLoginFlow(store).run(`mcp:${url}`, driven().controller).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LoginError);
		expect((error as LoginError).code).toBe("unknown_provider");
		expect((error as LoginError).message).toBe(`the MCP server ${url} advertises no OAuth endpoints`);
	});

	test("discovers the endpoints, registers a client, signs in, and persists the credential under the server's URL", async () => {
		const url = `http://127.0.0.1:${server.port}/mcp`;
		const { controller, authUrl } = driven();
		const result = await mcpLoginFlow(store).run(`mcp:${url}`, controller);

		const params = new URL(authUrl()).searchParams;
		expect(new URL(authUrl()).pathname).toBe("/authorize");
		expect(params.get("client_id")).toBe("registered-client");
		expect(params.get("code_challenge_method")).toBe("S256");
		expect(tokenRequests).toHaveLength(1);
		expect(tokenRequests[0]?.get("code")).toBe("the-code");
		expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code");

		expect(result.provider).toBe(`mcp:${url}`);
		expect(result.account).toBe(`127.0.0.1:${server.port}`);
		// Nothing is stored until the manager asks: it persists instead of uploading to the broker.
		expect(store.mcpCredentialUrls()).toEqual([]);
		await result.persist?.();
		expect(store.mcpCredentialUrls()).toEqual([url]);
		const stored = JSON.parse(store.mcpCredential(url) ?? "null") as Record<string, unknown>;
		expect(stored).toMatchObject({
			access: "access-1",
			refresh: "refresh-1",
			tokenUrl: `http://127.0.0.1:${server.port}/token`,
			clientId: "registered-client",
		});
		expect(typeof stored.expires).toBe("number");
	});
});
