import { abortableStream } from "./devices";

/** The inclusive byte range a single-range `Range` header selects of a file of `size` bytes. */
export interface ByteRange {
	start: number;
	end: number;
}

/**
 * The range of `header` (`bytes=a-b`, `bytes=a-` or `bytes=-n`, one range) within `size` bytes: `null` for no header or
 * one that is not a single byte range (served whole, as a server may), `"unsatisfiable"` when it selects nothing.
 */
export function byteRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
	const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null || (match[1] === "" && match[2] === "")) return null;
	const first = match[1] ?? "";
	const last = match[2] ?? "";
	if (first === "") {
		const length = Number(last);
		return length === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - length), end: size - 1 };
	}
	const start = Number(first);
	if (start >= size) return "unsatisfiable";
	const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
	return end < start ? null : { start, end };
}

/**
 * The response for `file` to a device: the whole file or the one requested range, streamed through a stream that ends
 * with the unauthorized error when `signal` aborts (the device was revoked), so a download in progress stops. Owners get
 * the plain file response, whose ranges Bun serves itself.
 */
export function deviceDownload(file: Bun.BunFile, req: Request, headers: Record<string, string>, signal: AbortSignal): Response {
	const range = byteRange(req.headers.get("range"), file.size);
	if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${file.size}` } });
	if (range === null) return new Response(abortableStream(file.stream(), signal, "close"), { headers: { ...headers, "Content-Length": String(file.size) } });
	const length = range.end - range.start + 1;
	return new Response(abortableStream(file.slice(range.start, range.end + 1).stream(), signal, "close"), {
		status: 206,
		headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`, "Content-Length": String(length) },
	});
}
