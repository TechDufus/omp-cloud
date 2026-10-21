import { LoginError, type LoginManager } from "../auth/login";
import { isRecord } from "../guards";

/** A request body: one short JSON object (a provider id, or a pasted redirect URL or code). */
const MAX_BODY_BYTES = 8 * 1024;

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function failure(status: number, message: string): Response {
	return json(status, { error: message });
}

const NOT_FOUND = "not found";

/** The body as one JSON object, or the failure response. */
async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > MAX_BODY_BYTES) return failure(413, "request body is too large");
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (req.body !== null) {
		for await (const chunk of req.body) {
			size += chunk.byteLength;
			if (size > MAX_BODY_BYTES) return failure(413, "request body is too large");
			chunks.push(chunk);
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		return failure(400, "invalid JSON body");
	}
	return isRecord(parsed) ? parsed : failure(400, "invalid JSON body");
}

/** A non-empty string field of `body`, or the 400 response. */
function requiredString(body: Record<string, unknown>, key: string): string | Response {
	const value = body[key];
	return typeof value === "string" && value.trim() !== "" ? value : failure(400, `${key} is required`);
}

/** Maps a manager failure to its response; anything else is rethrown for the app's 500. */
function loginFailure(error: unknown): Response {
	if (error instanceof LoginError) {
		switch (error.code) {
			case "unknown_provider":
				return failure(400, error.message);
			case "not_found":
				return failure(404, NOT_FOUND);
			case "not_waiting":
				return failure(409, "login is not waiting for input");
		}
	}
	throw error;
}

/**
 * The routes under `/api/v1/logins`; `segments` is the path after it. Answers `404` for any other path or method.
 * Authentication is the caller's.
 */
export async function handleLogins(req: Request, segments: string[], manager: LoginManager): Promise<Response> {
	const [id, action, ...rest] = segments;
	try {
		if (id === undefined) {
			if (req.method !== "POST") return failure(404, NOT_FOUND);
			const body = await readBody(req);
			if (body instanceof Response) return body;
			const provider = requiredString(body, "provider");
			if (provider instanceof Response) return provider;
			return json(201, await manager.start(provider));
		}
		if (action === undefined) {
			if (req.method === "GET") {
				const login = manager.get(id);
				return login === null ? failure(404, NOT_FOUND) : json(200, login);
			}
			if (req.method === "DELETE") {
				if (manager.get(id) === null) return failure(404, NOT_FOUND);
				return manager.cancel(id) ? json(202, { status: "cancelled" }) : failure(409, "login is not waiting");
			}
			return failure(404, NOT_FOUND);
		}
		if (action === "input" && rest.length === 0 && req.method === "POST") {
			const body = await readBody(req);
			if (body instanceof Response) return body;
			const input = requiredString(body, "input");
			if (input instanceof Response) return input;
			return json(200, await manager.input(id, input.trim()));
		}
		return failure(404, NOT_FOUND);
	} catch (error) {
		return loginFailure(error);
	}
}
