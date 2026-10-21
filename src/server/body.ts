import { isRecord } from "../guards";
import { ApiError } from "./errors";

/**
 * The request body as one JSON object of at most `maxBytes` bytes. A declared `Content-Length` over the cap is refused
 * before anything is read; without one the stream is read until it passes the cap. Throws ApiError 413 / 400.
 * `allowEmpty` reads a body of no bytes as `{}`.
 */
export async function readJsonObject(req: Request, maxBytes: number, allowEmpty = false): Promise<Record<string, unknown>> {
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
	if (allowEmpty && size === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		throw new ApiError(400, "invalid JSON body");
	}
	if (!isRecord(parsed)) throw new ApiError(400, "invalid JSON body");
	return parsed;
}
