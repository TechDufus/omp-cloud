import { ApiError } from "./errors";

/** What a preview needs from the service: the vmon address, and the runner's lookup of a thread's sandbox. */
export interface PreviewOptions {
	/** The vmon address: its ingress serves a sandbox's ports by the `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers. */
	vmonUrl: string;
	/** The sandbox of the thread, resumed when paused, with its idle pause postponed; ApiError 409 when the thread has no VM. */
	vmFor(threadId: string): Promise<string>;
}

/** The 409 of a thread that has no VM to preview. */
export const NO_VM_MESSAGE = "the thread has no VM; send it a message first";

/** envd's own port in every sandbox: never forwarded. */
const ENVD_PORT = 49983;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;
/** `/api/v1/threads/{id}/ports…`: the routes that relay a VM's web server. */
const PREVIEW_PATH = /^\/api\/v1\/threads\/[^/]+\/ports(?:\/|$)/;

/** Request headers never forwarded to the VM's server: the caller's credentials, the hop's own framing and everything vmon routes by. `cookie` passes: it carries the previewed app's own cookies, and the route takes bearer callers only. */
const REQUEST_DROPPED = new Set(["authorization", "host", "connection", "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "accept-encoding", "x-api-key"]);
/** Response headers never returned: hop-by-hop ones. */
const RESPONSE_DROPPED = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Whether `pathname` is a preview route. The dashboard listener answers 404 for these: a page the VM serves must never run on the dashboard's origin, which carries the owner's session cookie. */
export function isPreviewPath(pathname: string): boolean {
	return PREVIEW_PATH.test(pathname);
}

/** The port of a `ports/{port}` segment; ApiError 400 unless it is 1 to 65535 and not envd's. */
export function previewPort(segment: string): number {
	const port = PORT_PATTERN.test(segment) ? Number(segment) : 0;
	if (port < 1 || port > 65535 || port === ENVD_PORT) throw new ApiError(400, `port must be 1 to 65535 and not ${ENVD_PORT}`);
	return port;
}

/** Refuses a WebSocket upgrade (501): the relay streams plain HTTP only. */
export function requireNoUpgrade(req: Request): void {
	if (req.headers.get("upgrade")?.toLowerCase().includes("websocket") === true) throw new ApiError(501, "WebSocket upgrades are not forwarded");
}

/** What `proxyPreview` relays. */
export interface PreviewRequest {
	/** The vmon address: its ingress serves a sandbox's ports by the `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers. */
	vmonUrl: string;
	sandboxId: string;
	port: number;
	/** The path inside the VM's server, starting with `/`, as the caller sent it (still percent-encoded). */
	path: string;
	req: Request;
}

/** Relays `req` to the web server on `port` of the sandbox through vmon's ingress and streams the answer back; 502 when vmon does not answer. */
export async function proxyPreview(input: PreviewRequest): Promise<Response> {
	const { req } = input;
	const headers = new Headers();
	for (const [name, value] of req.headers) {
		const lower = name.toLowerCase();
		if (REQUEST_DROPPED.has(lower) || lower.startsWith("x-omp-") || lower.startsWith("e2b-")) continue;
		headers.append(name, value);
	}
	headers.set("E2b-Sandbox-Id", input.sandboxId);
	headers.set("E2b-Sandbox-Port", String(input.port));
	const hasBody = req.body !== null && req.method !== "GET" && req.method !== "HEAD";
	// String concatenation, never URL resolution: a path of `//host/x` must stay a path on vmon.
	const target = `${input.vmonUrl.replace(/\/+$/, "")}${input.path}${new URL(req.url).search}`;
	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method: req.method,
			headers,
			...(hasBody ? { body: req.body, duplex: "half" } : {}),
			redirect: "manual",
			signal: req.signal,
		} as RequestInit);
	} catch (error) {
		throw new ApiError(502, `vmon did not answer: ${error instanceof Error ? error.message : String(error)}`);
	}
	const out = new Headers(upstream.headers);
	for (const name of RESPONSE_DROPPED) out.delete(name);
	// Bun's `fetch` has decoded a compressed body: its encoding and length no longer describe it.
	if (out.has("content-encoding")) {
		out.delete("content-encoding");
		out.delete("content-length");
	}
	return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
