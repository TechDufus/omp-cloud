/**
 * `/cloud login mcp:<https url>`: the service logs in to an MCP server's OAuth itself, with omp's own discovery and flow
 * (dynamic client registration included), and keeps the tokens in its store (`mcp_credentials`). The VMs never see them:
 * the MCP proxy adds the token to the requests it forwards.
 */
import { discoverOAuthEndpoints } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { MCPOAuthFlow } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { McpStoredCredential } from "../connectors/mcp-credentials";
import type { Store } from "../store";
import { LoginError, type LoginFlow } from "./login";

const PREFIX = "mcp:";

/** The MCP login of `provider` (`mcp:<https url>`), and a flow that runs it. */
export function mcpLoginFlow(store: Pick<Store, "putMcpCredential">): LoginFlow {
	return {
		has: provider => provider.startsWith(`${PREFIX}https://`),
		async run(provider, controller) {
			const url = provider.slice(PREFIX.length);
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new LoginError("unknown_provider", `${JSON.stringify(provider.slice(0, 64))} is not mcp:<https url>`);
			}
			const endpoints = await discoverOAuthEndpoints(url, undefined, undefined, { signal: controller.signal });
			if (endpoints === null) throw new LoginError("unknown_provider", `the MCP server ${url} advertises no OAuth endpoints`);
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: endpoints.authorizationUrl,
					tokenUrl: endpoints.tokenUrl,
					issuerUrl: endpoints.issuerUrl,
					registrationUrl: endpoints.registrationUrl,
					clientId: endpoints.clientId,
					scopes: endpoints.scopes,
					resource: endpoints.resource ?? url,
					stripSameOriginResource: endpoints.resource === undefined,
				},
				{
					onAuth: ({ url: authUrl, instructions }) => controller.auth(authUrl, instructions ?? ""),
					onProgress: message => controller.progress(message),
					onManualCodeInput: signal => controller.prompt("", signal),
					signal: controller.signal,
				},
			);
			const tokens = await flow.login();
			// What omp stores after its own MCP login (`mcp-command-controller.ts`), so refresh needs nothing else.
			const stored: McpStoredCredential = {
				access: tokens.access,
				refresh: tokens.refresh,
				expires: tokens.expires,
				tokenUrl: endpoints.tokenUrl,
				clientId: flow.resolvedClientId?.trim() || endpoints.clientId,
				clientSecret: flow.registeredClientSecret,
				resource: flow.resource,
				authorizationUrl: flow.authorizationUrl,
			};
			return {
				provider,
				credential: { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, authorizedAt: Date.now() },
				account: parsed.host,
				persist: async () => store.putMcpCredential(url, JSON.stringify(stored), new Date().toISOString()),
			};
		},
	};
}
