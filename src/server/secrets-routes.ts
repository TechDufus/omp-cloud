import { type ServiceSecrets, SecretInputError } from "../secrets/store";
import { readJsonObject } from "./body";
import { ApiError } from "./errors";

/** A `PUT` body: one value of up to 64 Ki characters (up to 4 bytes each in JSON) and a list of globs. */
const MAX_BODY_BYTES = 72 * 1024;
const NOT_FOUND = "not found";

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * The routes under `/api/v1/secrets`; `segments` is the path after it: the list (never with a value), `PUT /{name}` and
 * `DELETE /{name}`. Answers `404` for any other path or method. Authentication and the owner-only scope are the
 * caller's; `principal` is who the store records.
 */
export async function handleSecrets(req: Request, segments: string[], secrets: ServiceSecrets, principal: string): Promise<Response> {
	const [name, ...rest] = segments;
	if (rest.length > 0) throw new ApiError(404, NOT_FOUND);
	if (name === undefined) {
		if (req.method !== "GET") throw new ApiError(404, NOT_FOUND);
		return json(200, { secrets: secrets.list() });
	}
	if (req.method === "PUT") {
		const body = await readJsonObject(req, MAX_BODY_BYTES);
		try {
			return json(200, { secret: secrets.put(name, { value: body.value, repos: body.repos }, principal) });
		} catch (error) {
			if (error instanceof SecretInputError) throw new ApiError(400, error.message);
			throw error;
		}
	}
	if (req.method === "DELETE") {
		if (!secrets.delete(name)) throw new ApiError(404, `no secret ${name}`);
		return json(202, { status: "deleted" });
	}
	throw new ApiError(404, NOT_FOUND);
}
