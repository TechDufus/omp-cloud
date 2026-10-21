/** A malformed or truncated multipart body. */
export class MultipartError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MultipartError";
	}
}

/** Largest accepted part header block (everything before the blank line), in bytes. */
const MAX_HEADER_BYTES = 16 * 1024;
/** Longest accepted run of transport padding after a delimiter. */
const MAX_PADDING_BYTES = 1024;
const MAX_BOUNDARY_CHARS = 70;

const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const DASH = 0x2d;

const CRLF = new Uint8Array([CR, LF]);
const HEADER_END = Buffer.from("\r\n\r\n");
const EMPTY = new Uint8Array(0);
const utf8 = new TextDecoder();

/** Index of `pattern` in `buf` at or after `from`, or -1. */
function find(buf: Uint8Array, pattern: Buffer, from = 0): number {
	return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).indexOf(pattern, from);
}

/** Length of the longest suffix of `buf` that is a proper prefix of `pattern`. */
function partialSuffix(buf: Uint8Array, pattern: Buffer): number {
	for (let k = Math.min(pattern.length - 1, buf.length); k > 0; k--) {
		if (buf[buf.length - k] !== pattern[0]) continue;
		let match = true;
		for (let i = 1; i < k; i++) {
			if (buf[buf.length - k + i] !== pattern[i]) {
				match = false;
				break;
			}
		}
		if (match) return k;
	}
	return 0;
}

/**
 * Parses `; name=value` parameters (value a token or a quoted string with `\"` / `\\` escapes). Names are lower-cased,
 * the first occurrence of a name wins. Null when malformed.
 */
function parseParams(input: string): Map<string, string> | null {
	const params = new Map<string, string>();
	let i = 0;
	while (i < input.length) {
		while (i < input.length && (input[i] === " " || input[i] === "\t" || input[i] === ";")) i++;
		if (i >= input.length) break;
		const eq = input.indexOf("=", i);
		if (eq < 0) return null;
		const name = input.slice(i, eq).trim().toLowerCase();
		if (name === "" || name.includes(";")) return null;
		i = eq + 1;
		while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
		let value = "";
		if (input[i] === '"') {
			i++;
			let closed = false;
			while (i < input.length) {
				const c = input[i];
				if (c === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
					value += input[i + 1];
					i += 2;
				} else if (c === '"') {
					closed = true;
					i++;
					break;
				} else {
					value += c;
					i++;
				}
			}
			if (!closed) return null;
			while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
			if (i < input.length && input[i] !== ";") return null;
		} else {
			const end = input.indexOf(";", i);
			const stop = end < 0 ? input.length : end;
			value = input.slice(i, stop).trim();
			i = stop;
		}
		if (!params.has(name)) params.set(name, value);
	}
	return params;
}

/** Splits `type; params` into the lower-cased trimmed type and the raw parameter text. */
function splitMediaType(value: string): { type: string; params: string } {
	const semi = value.indexOf(";");
	if (semi < 0) return { type: value.trim().toLowerCase(), params: "" };
	return { type: value.slice(0, semi).trim().toLowerCase(), params: value.slice(semi + 1) };
}

/** The boundary of a `multipart/form-data` Content-Type (type case-insensitive, boundary quoted or not), else null. */
export function multipartBoundary(contentType: string | null): string | null {
	if (contentType === null) return null;
	const { type, params } = splitMediaType(contentType);
	if (type !== "multipart/form-data") return null;
	const boundary = parseParams(params)?.get("boundary");
	if (boundary === undefined || boundary.length < 1 || boundary.length > MAX_BOUNDARY_CHARS) return null;
	return boundary;
}

/** One `multipart/form-data` part. */
export interface Part {
	/** Content-Disposition `name`. */
	name: string;
	filename: string | null;
	contentType: string | null;
	/** The part's bytes as they arrive. `next()` skips whatever the consumer did not read. */
	body: AsyncIterable<Uint8Array>;
}

type State = "preamble" | "delimiter" | "body" | "closed";

/**
 * A pull-based streaming `multipart/form-data` reader (RFC 7578). It holds at most one stream chunk plus a
 * delimiter-sized tail of the current part body; chunks yielded by a part body are never mutated afterwards. It does not
 * cancel the source stream, even after the closing delimiter: the caller owns it.
 */
export class MultipartReader {
	readonly #reader: { read(): Promise<{ done: true; value?: Uint8Array } | { done: false; value: Uint8Array }> };
	/** `\r\n--boundary`. */
	readonly #delimiter: Buffer;
	/** Unconsumed bytes. Starts with the CRLF the first delimiter lacks, so every delimiter has the same shape. */
	#buf: Uint8Array = CRLF;
	#sourceDone = false;
	#state: State = "preamble";
	#failure: unknown = null;
	/** Identifies the part whose body may be read. */
	#current: object | null = null;

	constructor(body: ReadableStream<Uint8Array>, boundary: string) {
		if (boundary.length < 1 || boundary.length > MAX_BOUNDARY_CHARS) {
			throw new MultipartError(`boundary must be 1-${MAX_BOUNDARY_CHARS} characters`);
		}
		this.#delimiter = Buffer.from(`\r\n--${boundary}`);
		this.#reader = body.getReader();
	}

	/** The next part, or null after the closing delimiter. Throws MultipartError (also from iterating a body) for malformed or truncated input. */
	async next(): Promise<Part | null> {
		if (this.#failure !== null) throw this.#failure;
		try {
			if (this.#state === "body") {
				while ((await this.#pull()) !== null);
			} else if (this.#state === "preamble") {
				await this.#skipPreamble();
			}
			if (this.#state === "closed") return null;
			if (!(await this.#readDelimiterLine())) {
				this.#state = "closed";
				this.#current = null;
				return null;
			}
			const part = await this.#readPart();
			this.#state = "body";
			return part;
		} catch (error) {
			this.#failure = error;
			throw error;
		}
	}

	/** Reads one more chunk from the source into the buffer. False when the source has ended. */
	async #fill(): Promise<boolean> {
		if (this.#sourceDone) return false;
		const result = await this.#reader.read();
		if (result.done) {
			this.#sourceDone = true;
			return false;
		}
		const chunk = result.value;
		if (chunk.length === 0) return true;
		if (this.#buf.length === 0) {
			this.#buf = chunk;
		} else {
			const joined = new Uint8Array(this.#buf.length + chunk.length);
			joined.set(this.#buf);
			joined.set(chunk, this.#buf.length);
			this.#buf = joined;
		}
		return true;
	}

	async #fillOrThrow(): Promise<void> {
		if (!(await this.#fill())) throw new MultipartError("multipart body ended before the closing delimiter");
	}

	/** Discards everything up to and including the first delimiter. */
	async #skipPreamble(): Promise<void> {
		for (;;) {
			const at = find(this.#buf, this.#delimiter);
			if (at >= 0) {
				this.#buf = this.#buf.subarray(at + this.#delimiter.length);
				this.#state = "delimiter";
				return;
			}
			this.#buf = this.#buf.subarray(this.#buf.length - partialSuffix(this.#buf, this.#delimiter));
			await this.#fillOrThrow();
		}
	}

	/** Consumes what follows a delimiter: true for a part's CRLF, false for the closing `--`. */
	async #readDelimiterLine(): Promise<boolean> {
		while (this.#buf.length < 2) await this.#fillOrThrow();
		if (this.#buf[0] === DASH && this.#buf[1] === DASH) {
			this.#buf = EMPTY;
			return false;
		}
		let end = 0;
		for (;;) {
			while (end < this.#buf.length && (this.#buf[end] === SPACE || this.#buf[end] === TAB)) end++;
			if (end + 2 <= this.#buf.length) break;
			if (end > MAX_PADDING_BYTES) throw new MultipartError("too much padding after a delimiter");
			await this.#fillOrThrow();
		}
		if (this.#buf[end] !== CR || this.#buf[end + 1] !== LF) {
			throw new MultipartError("malformed delimiter line");
		}
		this.#buf = this.#buf.subarray(end + 2);
		return true;
	}

	async #readPart(): Promise<Part> {
		const block = await this.#readHeaderBlock();
		const headers = parseHeaders(block);
		const disposition = headers.get("content-disposition");
		if (disposition === undefined) throw new MultipartError("part has no Content-Disposition");
		const { type, params: rawParams } = splitMediaType(disposition);
		if (type !== "form-data") throw new MultipartError("Content-Disposition is not form-data");
		const params = parseParams(rawParams);
		if (params === null) throw new MultipartError("malformed Content-Disposition");
		const name = params.get("name");
		if (name === undefined) throw new MultipartError("Content-Disposition has no name");
		const contentType = headers.get("content-type");
		const token = {};
		this.#current = token;
		return {
			name,
			filename: params.get("filename") ?? null,
			contentType: contentType === undefined || contentType === "" ? null : contentType,
			body: this.#bodyOf(token),
		};
	}

	/** The part header block without its terminating blank line. */
	async #readHeaderBlock(): Promise<string> {
		let from = 0;
		for (;;) {
			if (this.#buf.length >= 2 && this.#buf[0] === CR && this.#buf[1] === LF) {
				this.#buf = this.#buf.subarray(2);
				return "";
			}
			const at = find(this.#buf, HEADER_END, from);
			if (at >= 0) {
				if (at > MAX_HEADER_BYTES) throw new MultipartError("part headers too large");
				const block = utf8.decode(this.#buf.subarray(0, at));
				this.#buf = this.#buf.subarray(at + HEADER_END.length);
				return block;
			}
			if (this.#buf.length > MAX_HEADER_BYTES + HEADER_END.length - 1) {
				throw new MultipartError("part headers too large");
			}
			from = Math.max(0, this.#buf.length - (HEADER_END.length - 1));
			await this.#fillOrThrow();
		}
	}

	#bodyOf(token: object): AsyncIterable<Uint8Array> {
		const owner = this;
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				for (;;) {
					if (owner.#current !== token) throw new MultipartError("part body is no longer readable");
					const chunk = await owner.#pullGuarded();
					if (chunk === null) return;
					yield chunk;
				}
			},
		};
	}

	async #pullGuarded(): Promise<Uint8Array | null> {
		if (this.#failure !== null) throw this.#failure;
		try {
			return await this.#pull();
		} catch (error) {
			this.#failure = error;
			throw error;
		}
	}

	/** The next non-empty piece of the current part body, or null once its closing delimiter was consumed. */
	async #pull(): Promise<Uint8Array | null> {
		for (;;) {
			if (this.#state !== "body") return null;
			const at = find(this.#buf, this.#delimiter);
			if (at >= 0) {
				const chunk = this.#buf.subarray(0, at);
				this.#buf = this.#buf.subarray(at + this.#delimiter.length);
				this.#state = "delimiter";
				if (chunk.length > 0) return chunk;
				return null;
			}
			const emit = this.#buf.length - partialSuffix(this.#buf, this.#delimiter);
			if (emit > 0) {
				const chunk = this.#buf.subarray(0, emit);
				this.#buf = this.#buf.subarray(emit);
				return chunk;
			}
			await this.#fillOrThrow();
		}
	}
}

/** Header names lower-cased; the first occurrence wins; obsolete line folding is joined with a space. */
function parseHeaders(block: string): Map<string, string> {
	const headers = new Map<string, string>();
	if (block === "") return headers;
	const lines: string[] = [];
	for (const line of block.split("\r\n")) {
		if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
			lines[lines.length - 1] += ` ${line.trim()}`;
		} else {
			lines.push(line);
		}
	}
	for (const line of lines) {
		const colon = line.indexOf(":");
		if (colon <= 0) throw new MultipartError("malformed part header");
		const name = line.slice(0, colon).trim().toLowerCase();
		if (name === "") throw new MultipartError("malformed part header");
		if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
	}
	return headers;
}
