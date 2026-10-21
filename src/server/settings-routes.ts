import { isRecord } from "../guards";
import { MAX_IMPORT_BYTES, SettingError, type Settings } from "../settings";
import { ApiError } from "./errors";

/** A `PUT /settings` body: a few keys and their values. */
const MAX_SETTINGS_BODY_BYTES = 64 * 1024;
const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 200;

const NOT_FOUND = "not found";

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The body as UTF-8 text of at most `maxBytes` bytes. Throws ApiError 413 / 400. */
async function readText(req: Request, maxBytes: number): Promise<string> {
	const tooLarge = (): ApiError => new ApiError(413, "request body is too large");
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) throw tooLarge();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (req.body !== null) {
		for await (const chunk of req.body) {
			size += chunk.byteLength;
			if (size > maxBytes) throw tooLarge();
			chunks.push(chunk);
		}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} catch {
		throw new ApiError(400, "the body is not valid UTF-8");
	}
}

/** The integer in `value` between `min` and `max`, `fallback` when absent; ApiError 400 naming `name` otherwise. */
function intParam(value: string | null, name: string, min: number, max: number, fallback: number): number {
	if (value === null) return fallback;
	const parsed = /^[0-9]{1,15}$/.test(value) ? Number(value) : Number.NaN;
	if (!(parsed >= min && parsed <= max)) throw new ApiError(400, `${name} must be an integer from ${min} to ${max}`);
	return parsed;
}

/**
 * The routes under `/api/v1/settings`; `segments` is the path after it. Answers `404` for any other path or method;
 * a {@link SettingError} is a `400`. Authentication is the caller's; `principal` is who the audit log names.
 */
export async function handleSettings(req: Request, segments: string[], settings: Settings, principal: string): Promise<Response> {
	const [action, ...rest] = segments;
	if (rest.length > 0) throw new ApiError(404, NOT_FOUND);
	const url = new URL(req.url);
	try {
		if (action === undefined) {
			if (req.method === "GET") return json(200, { settings: settings.list() });
			if (req.method !== "PUT") throw new ApiError(404, NOT_FOUND);
			const text = await readText(req, MAX_SETTINGS_BODY_BYTES);
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				throw new ApiError(400, "invalid JSON body");
			}
			if (!isRecord(body) || !isRecord(body.settings)) throw new ApiError(400, "invalid JSON body: expected {\"settings\": {…}}");
			settings.apply(body.settings, principal);
			return json(200, { settings: settings.list() });
		}
		if (req.method === "GET" && action === "audit") {
			const before = intParam(url.searchParams.get("before"), "before", 0, Number.MAX_SAFE_INTEGER, 0);
			const limit = intParam(url.searchParams.get("limit"), "limit", 1, MAX_AUDIT_LIMIT, DEFAULT_AUDIT_LIMIT);
			return json(200, settings.audit({ before, limit }));
		}
		if (req.method === "GET" && action === "export") {
			return new Response(settings.exportYaml(), { headers: { "Content-Type": "application/yaml" } });
		}
		if (req.method === "PUT" && action === "import") {
			const mode = url.searchParams.get("mode") ?? "replace";
			if (mode !== "replace" && mode !== "merge") throw new ApiError(400, "mode must be replace or merge");
			settings.importYaml(await readText(req, MAX_IMPORT_BYTES), principal, mode);
			return json(200, { settings: settings.list() });
		}
		throw new ApiError(404, NOT_FOUND);
	} catch (error) {
		if (error instanceof SettingError) return json(400, { error: error.message });
		throw error;
	}
}
