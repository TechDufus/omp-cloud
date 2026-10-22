import { isRecord } from "../guards";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sha256Hex } from "../pairing/secrets";
import type { Store } from "../store";
import type { ThreadMcpServer } from "../store/types";
import type { McpCredentials } from "./mcp-credentials";
import { parseMcpServers } from "./mcp-servers";
import { isRefusedUpstream } from "./refused";

export interface McpProxyOptions {
	listen: { hostname: string; port: number };
	store: Pick<Store, "threadByMcpToken" | "blob">;
	credentials: Pick<McpCredentials, "access">;
	/** The service's own addresses beside loopback and link-local (the gateway's, the proxy's own); an upstream resolving to one is refused. */
	own?: readonly string[];
	/** Whether an upstream address is refused; the default is `isRefusedUpstream` over `own`. A test seam: a fake upstream sits on loopback. */
	refused?: (address: string) => boolean;
}

const PATH = /^\/mcp\/([A-Za-z0-9_.-]{1,64})$/;
/** Request headers the proxy never forwards: the VM's token and the connection's own framing. `accept-encoding` is dropped so the upstream answers uncompressed. */
const REQUEST_DROPPED = new Set(["authorization", "host", "cookie", "connection", "content-length", "transfer-encoding", "accept-encoding"]);
/** Response headers the proxy never returns: hop-by-hop ones, and the encoding and length of a body Bun's `fetch` already decoded. */
const RESPONSE_DROPPED = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-encoding", "content-length"]);

function jsonError(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}

/** The upstream server of `name` in the thread's `secrets.json`; null when there is none or it is not http. */
async function entryOf(store: McpProxyOptions["store"], threadId: string, name: string): Promise<Extract<ThreadMcpServer, { type: "http" }> | null> {
	const blob = await store.blob(threadId, "secrets.json");
	if (blob === null) return null;
	const raw: unknown = JSON.parse(await blob.text());
	const entry = parseMcpServers(isRecord(raw) ? raw.mcp : undefined).find(server => server.name === name);
	return entry?.type === "http" ? entry : null;
}

/** Whether `hostname` (a URL host) is or resolves to an address `refused` names. A lookup failure is not a refusal: the connect reports it. */
async function resolvesToRefused(hostname: string, refused: (address: string) => boolean): Promise<boolean> {
	const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
	if (isIP(host) !== 0) return refused(host);
	try {
		const addresses = await lookup(host, { all: true });
		return addresses.some(entry => refused(entry.address));
	} catch {
		return false;
	}
}

/**
 * The MCP proxy: VMs call `http://<listen>/mcp/<name>` with their thread's token; the service forwards to the server the
 * thread shipped, adding that server's headers or its stored OAuth token, so no MCP credential enters the VM.
 */
export function serveMcpProxy(options: McpProxyOptions): Bun.Server<undefined> {
	const own = options.own ?? [];
	const refused = options.refused ?? ((address: string) => isRefusedUpstream(address, own));
	return Bun.serve({
		hostname: options.listen.hostname,
		port: options.listen.port,
		idleTimeout: 0,
		async fetch(req) {
			const name = PATH.exec(new URL(req.url).pathname)?.[1];
			if (name === undefined) return jsonError(404, "not found");
			const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
			const thread = bearer === undefined ? null : options.store.threadByMcpToken(sha256Hex(bearer));
			if (thread === null || thread.phase === "failed") return jsonError(401, "unknown token");
			let entry: Extract<ThreadMcpServer, { type: "http" }> | null;
			try {
				entry = await entryOf(options.store, thread.id, name);
			} catch {
				return jsonError(500, "the thread's MCP servers could not be read");
			}
			if (entry === null) return jsonError(404, `no MCP server ${name}`);

			const upstreamUrl = new URL(entry.url);
			if (await resolvesToRefused(upstreamUrl.hostname, refused)) return jsonError(403, "the MCP server resolves to the service host");

			const headers = new Headers();
			for (const [key, value] of req.headers) if (!REQUEST_DROPPED.has(key)) headers.set(key, value);
			for (const [key, value] of Object.entries(entry.headers)) headers.set(key, value);
			if (!headers.has("authorization")) {
				const token = await options.credentials.access(entry.url);
				if (token !== null) headers.set("authorization", `Bearer ${token}`);
			}
			let upstream: Response;
			try {
				upstream = await fetch(entry.url, { method: req.method, headers, body: req.body, duplex: "half", redirect: "manual", signal: req.signal });
			} catch (error) {
				return jsonError(502, `the MCP server did not answer: ${error instanceof Error ? error.message : String(error)}`);
			}
			const responseHeaders = new Headers();
			for (const [key, value] of upstream.headers) if (!RESPONSE_DROPPED.has(key)) responseHeaders.append(key, value);
			return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
		},
	});
}

/** `serveMcpProxy`, except that a failed bind is logged and answers null: the service then runs without a proxy (`whoami.mcpProxy` false) instead of not starting. */
export function tryServeMcpProxy(options: McpProxyOptions): Bun.Server<undefined> | null {
	try {
		return serveMcpProxy(options);
	} catch (error) {
		const { hostname, port } = options.listen;
		console.error(`omp-cloud: the MCP proxy could not listen on ${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}
