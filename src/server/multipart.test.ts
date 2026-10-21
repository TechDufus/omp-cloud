import { describe, expect, test } from "bun:test";
import { MultipartError, MultipartReader, multipartBoundary } from "./multipart";

const BOUNDARY = "----omp-cloud-test-boundary";
const encoder = new TextEncoder();

interface PartSpec {
	headers: string[];
	body: Uint8Array | string;
}

interface Collected {
	name: string;
	filename: string | null;
	contentType: string | null;
	body: Uint8Array;
}

function bytes(value: Uint8Array | string): Uint8Array {
	return typeof value === "string" ? encoder.encode(value) : value;
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

function field(name: string, body: Uint8Array | string, extra: string[] = []): PartSpec {
	return { headers: [`Content-Disposition: form-data; name="${name}"`, ...extra], body };
}

/** A well-formed body: optional preamble, parts, closing delimiter, optional epilogue. */
function build(parts: PartSpec[], options: { preamble?: string; epilogue?: string; boundary?: string } = {}): Uint8Array {
	const boundary = options.boundary ?? BOUNDARY;
	const pieces: Uint8Array[] = [];
	if (options.preamble !== undefined) pieces.push(bytes(`${options.preamble}\r\n`));
	for (const part of parts) {
		pieces.push(bytes(`--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`), bytes(part.body), bytes("\r\n"));
	}
	pieces.push(bytes(`--${boundary}--`));
	if (options.epilogue !== undefined) pieces.push(bytes(`\r\n${options.epilogue}`));
	return concat(pieces);
}

function streamOf(chunks: Iterable<Uint8Array>): ReadableStream<Uint8Array> {
	const iterator = chunks[Symbol.iterator]();
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const next = iterator.next();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
	});
}

function splitEvery(data: Uint8Array, size: number): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < data.length; at += size) chunks.push(data.slice(at, at + size));
	return chunks;
}

/** mulberry32: deterministic pseudo-random numbers in [0, 1). */
function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function splitRandom(data: Uint8Array, seed: number, maxSize: number): Uint8Array[] {
	const random = seeded(seed);
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < data.length; ) {
		const size = 1 + Math.floor(random() * maxSize);
		chunks.push(data.slice(at, at + size));
		at += size;
	}
	return chunks;
}

async function collect(chunks: Iterable<Uint8Array>, boundary = BOUNDARY): Promise<Collected[]> {
	const reader = new MultipartReader(streamOf(chunks), boundary);
	const parts: Collected[] = [];
	for (let part = await reader.next(); part !== null; part = await reader.next()) {
		const pieces: Uint8Array[] = [];
		for await (const chunk of part.body) pieces.push(chunk);
		parts.push({ name: part.name, filename: part.filename, contentType: part.contentType, body: concat(pieces) });
	}
	return parts;
}

function text(part: Collected | undefined): string {
	return new TextDecoder().decode(part?.body);
}

/** A binary body that is hostile to a delimiter scanner. */
function trickyBody(): Uint8Array {
	const delimiter = `\r\n--${BOUNDARY}`;
	return concat([
		new Uint8Array([0, 1, 2, 0xff, 0xfe, 13, 10, 13, 13, 10, 10]),
		bytes("--"),
		bytes("\r\n--"),
		bytes("\r\n--x"),
		bytes(delimiter.slice(0, -1)),
		bytes(delimiter.slice(0, 7)),
		bytes(`${delimiter.slice(0, -3)}-`),
		bytes("\r\n"),
		bytes("\r\n\r\n"),
		new Uint8Array([13]),
	]);
}

describe("MultipartReader", () => {
	test("reads several parts with names, filenames and content types", async () => {
		const binary = new Uint8Array([1, 2, 3, 0, 255]);
		const body = build([
			field("request", '{"a":1}', ["Content-Type: application/json"]),
			{
				headers: [`Content-Disposition: form-data; name="repo"; filename="repo.bundle"`, "Content-Type: application/octet-stream"],
				body: binary,
			},
			field("note", "hello"),
		]);
		const parts = await collect([body]);
		expect(parts.map((part) => [part.name, part.filename, part.contentType])).toEqual([
			["request", null, "application/json"],
			["repo", "repo.bundle", "application/octet-stream"],
			["note", null, null],
		]);
		expect(text(parts[0])).toBe('{"a":1}');
		expect(parts[1]?.body).toEqual(binary);
		expect(text(parts[2])).toBe("hello");
	});

	test("yields identical parts for one chunk, 1-byte chunks and seeded random chunk sizes", async () => {
		const body = build(
			[
				field("a", trickyBody(), ["Content-Type: application/octet-stream"]),
				field("empty", ""),
				{ headers: [`Content-Disposition: form-data; name="b"; filename="b.bin"`], body: concat([trickyBody(), trickyBody()]) },
			],
			{ preamble: "ignore me", epilogue: "trailing\r\n--junk" },
		);
		const whole = await collect([body]);
		expect(whole[0]?.body).toEqual(trickyBody());
		expect(whole[1]?.body.length).toBe(0);
		expect(whole[2]?.body).toEqual(concat([trickyBody(), trickyBody()]));
		expect(await collect(splitEvery(body, 1))).toEqual(whole);
		for (let seed = 1; seed <= 40; seed++) {
			expect(await collect(splitRandom(body, seed, 1 + (seed % 9) * 7))).toEqual(whole);
		}
	});

	test("keeps CR, LF and delimiter look-alikes in a body", async () => {
		const parts = await collect(splitEvery(build([field("x", trickyBody())]), 5));
		expect(parts).toHaveLength(1);
		expect(parts[0]?.body).toEqual(trickyBody());
	});

	test("an empty part body is a part with no bytes", async () => {
		const parts = await collect([build([field("empty", ""), field("after", "x")])]);
		expect(parts.map((part) => part.name)).toEqual(["empty", "after"]);
		expect(parts[0]?.body.length).toBe(0);
	});

	test("ignores preamble and epilogue and allows padding after delimiters", async () => {
		const raw =
			`preamble line\r\n--other\r\n` +
			`--${BOUNDARY} \t \r\nContent-Disposition: form-data; name="a"\r\n\r\none\r\n` +
			`--${BOUNDARY}\t\r\nContent-Disposition: form-data; name="b"\r\n\r\ntwo\r\n` +
			`--${BOUNDARY}-- \r\nepilogue\r\n--${BOUNDARY}\r\nnot a part`;
		for (const chunks of [[encoder.encode(raw)], splitEvery(encoder.encode(raw), 1)]) {
			const parts = await collect(chunks);
			expect(parts.map((part) => [part.name, text(part)])).toEqual([
				["a", "one"],
				["b", "two"],
			]);
		}
	});

	test("the first delimiter may start the body", async () => {
		const parts = await collect([build([field("a", "1")])]);
		expect(parts.map((part) => part.name)).toEqual(["a"]);
	});

	test("a body with only the closing delimiter has no parts", async () => {
		const reader = new MultipartReader(streamOf([encoder.encode(`--${BOUNDARY}--\r\n`)]), BOUNDARY);
		expect(await reader.next()).toBeNull();
		expect(await reader.next()).toBeNull();
	});

	test("matches header names case-insensitively and decodes quoted-string escapes", async () => {
		const raw = `--b\r\nCONTENT-disposition: Form-Data; NAME=plain; FileName="we\\"ird \\\\ name.txt"\r\ncontent-TYPE: text/plain\r\n\r\nhi\r\n--b--`;
		const parts = await collect([encoder.encode(raw)], "b");
		expect(parts).toHaveLength(1);
		expect(parts[0]?.name).toBe("plain");
		expect(parts[0]?.filename).toBe('we"ird \\ name.txt');
		expect(parts[0]?.contentType).toBe("text/plain");
	});

	test("a part with an empty header block has no name and is rejected", async () => {
		const raw = `--b\r\n\r\ndata\r\n--b--`;
		await expect(collect([encoder.encode(raw)], "b")).rejects.toBeInstanceOf(MultipartError);
	});

	test("rejects a part without a name, without form-data disposition or without Content-Disposition", async () => {
		for (const header of [
			`Content-Disposition: form-data; filename="f"`,
			`Content-Disposition: attachment; name="a"`,
			`Content-Type: text/plain`,
			`Content-Disposition: form-data; name="unterminated`,
		]) {
			const raw = `--b\r\n${header}\r\n\r\ndata\r\n--b--`;
			await expect(collect([encoder.encode(raw)], "b")).rejects.toBeInstanceOf(MultipartError);
		}
	});

	test("rejects an oversized header block however it is chunked", async () => {
		const padding = `X-Padding: ${"a".repeat(20 * 1024)}`;
		const raw = encoder.encode(`--b\r\nContent-Disposition: form-data; name="a"\r\n${padding}\r\n\r\ndata\r\n--b--`);
		await expect(collect([raw], "b")).rejects.toBeInstanceOf(MultipartError);
		await expect(collect(splitEvery(raw, 1000), "b")).rejects.toBeInstanceOf(MultipartError);
		const endless = encoder.encode(`--b\r\nContent-Disposition: form-data; name="a"\r\nX: ${"a".repeat(64 * 1024)}`);
		await expect(collect(splitEvery(endless, 1000), "b")).rejects.toBeInstanceOf(MultipartError);
	});

	test("accepts a header block just under the cap", async () => {
		const padding = `X-Padding: ${"a".repeat(15 * 1024)}`;
		const raw = encoder.encode(`--b\r\nContent-Disposition: form-data; name="a"\r\n${padding}\r\n\r\ndata\r\n--b--`);
		const parts = await collect(splitEvery(raw, 1000), "b");
		expect(parts.map((part) => text(part))).toEqual(["data"]);
	});

	test("a body cut inside a part throws MultipartError from the body iterator", async () => {
		const full = build([field("a", "x".repeat(100))]);
		const reader = new MultipartReader(streamOf([full.slice(0, 120)]), BOUNDARY);
		const part = await reader.next();
		expect(part).not.toBeNull();
		const drain = async () => {
			for await (const _chunk of part?.body ?? []);
		};
		await expect(drain()).rejects.toBeInstanceOf(MultipartError);
		await expect(reader.next()).rejects.toBeInstanceOf(MultipartError);
	});

	test("a body without its closing delimiter throws MultipartError", async () => {
		const full = build([field("a", "payload"), field("b", "more")]);
		const withoutClose = full.slice(0, full.length - `--${BOUNDARY}--`.length);
		await expect(collect([withoutClose])).rejects.toBeInstanceOf(MultipartError);
		const midClose = full.slice(0, full.length - 3);
		await expect(collect(splitEvery(midClose, 4))).rejects.toBeInstanceOf(MultipartError);
	});

	test("a body cut anywhere before the closing delimiter completes throws MultipartError", async () => {
		const full = build([field("a", "payload", ["Content-Type: text/plain"]), field("b", "more")], { preamble: "pre" });
		const closeAt = full.length - `--${BOUNDARY}--`.length;
		for (let cut = 0; cut < closeAt + `--${BOUNDARY}-`.length; cut++) {
			await expect(collect([full.slice(0, cut)])).rejects.toBeInstanceOf(MultipartError);
		}
	});

	test("an empty or delimiter-free body throws MultipartError", async () => {
		await expect(collect([])).rejects.toBeInstanceOf(MultipartError);
		await expect(collect([encoder.encode("just some text")])).rejects.toBeInstanceOf(MultipartError);
	});

	test("rejects garbage after a delimiter", async () => {
		const raw = `--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nx\r\n--bXYZ\r\n`;
		await expect(collect([encoder.encode(raw)], "b")).rejects.toBeInstanceOf(MultipartError);
	});

	test("next() skips the unread rest of a part, even when it was read in part", async () => {
		const big = new Uint8Array(100_000).map((_, i) => i % 251);
		const body = build([field("first", big), field("second", "kept"), field("third", trickyBody())]);
		const reader = new MultipartReader(streamOf(splitEvery(body, 777)), BOUNDARY);

		const first = await reader.next();
		expect(first?.name).toBe("first");
		const iterator = first?.body[Symbol.asyncIterator]();
		const chunk = await iterator?.next();
		expect(chunk?.done).toBe(false);
		await iterator?.return?.();

		const second = await reader.next();
		expect(second?.name).toBe("second");
		const third = await reader.next();
		expect(third?.name).toBe("third");
		expect(await reader.next()).toBeNull();
		expect(second).not.toBeNull();
	});

	test("next() skips a part whose body was never touched", async () => {
		const reader = new MultipartReader(streamOf(splitEvery(build([field("a", "x".repeat(5000)), field("b", "y")]), 100)), BOUNDARY);
		expect((await reader.next())?.name).toBe("a");
		const b = await reader.next();
		expect(b?.name).toBe("b");
		const pieces: Uint8Array[] = [];
		for await (const chunk of b?.body ?? []) pieces.push(chunk);
		expect(new TextDecoder().decode(concat(pieces))).toBe("y");
		expect(await reader.next()).toBeNull();
	});

	test("a chunk stays valid after the consumer pulls the next one", async () => {
		const data = new Uint8Array(50_000).map((_, i) => (i * 7) % 256);
		const reader = new MultipartReader(streamOf(splitEvery(build([field("a", data)]), 1000)), BOUNDARY);
		const part = await reader.next();
		const chunks: Uint8Array[] = [];
		const snapshots: Uint8Array[] = [];
		for await (const chunk of part?.body ?? []) {
			chunks.push(chunk);
			snapshots.push(chunk.slice());
		}
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks).toEqual(snapshots);
		expect(concat(chunks)).toEqual(data);
	});

	test("a body of a part that next() moved past is not readable", async () => {
		const reader = new MultipartReader(streamOf([build([field("a", "1"), field("b", "2")])]), BOUNDARY);
		const first = await reader.next();
		await reader.next();
		const read = async () => {
			for await (const _chunk of first?.body ?? []);
		};
		await expect(read()).rejects.toBeInstanceOf(MultipartError);
	});

	test("streams an 8 MiB part without buffering it whole", async () => {
		const total = 8 * 1024 * 1024;
		const piece = 64 * 1024;
		const pattern = (offset: number, length: number) => new Uint8Array(length).map((_, i) => (offset + i) % 253);
		const head = bytes(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="repo"; filename="big.bin"\r\n\r\n`);
		const tail = bytes(`\r\n--${BOUNDARY}--\r\n`);
		let produced = 0;
		let offset = 0;
		let stage: "head" | "body" | "tail" | "done" = "head";
		const source = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (stage === "head") {
						controller.enqueue(head);
						stage = "body";
					} else if (stage === "body") {
						const length = Math.min(piece, total - offset);
						controller.enqueue(pattern(offset, length));
						offset += length;
						if (offset === total) stage = "tail";
					} else if (stage === "tail") {
						controller.enqueue(tail);
						stage = "done";
					} else {
						controller.close();
						return;
					}
					produced++;
				},
			},
			{ highWaterMark: 0 },
		);
		const reader = new MultipartReader(source, BOUNDARY);
		const part = await reader.next();
		expect(part?.filename).toBe("big.bin");
		let chunks = 0;
		let size = 0;
		let largest = 0;
		let producedAtFirstChunk = -1;
		let mismatch = false;
		for await (const chunk of part?.body ?? []) {
			if (chunks === 0) producedAtFirstChunk = produced;
			chunks++;
			largest = Math.max(largest, chunk.length);
			for (let i = 0; i < chunk.length; i += 4099) {
				if (chunk[i] !== (size + i) % 253) mismatch = true;
			}
			size += chunk.length;
		}
		expect(mismatch).toBe(false);
		expect(size).toBe(total);
		expect(chunks).toBeGreaterThan(1);
		expect(largest).toBeLessThan(total / 4);
		expect(producedAtFirstChunk).toBeLessThan(5);
		expect(await reader.next()).toBeNull();
	});
});

describe("multipartBoundary", () => {
	test("extracts quoted and unquoted boundaries", () => {
		expect(multipartBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
		expect(multipartBoundary('multipart/form-data; boundary="abc 123"')).toBe("abc 123");
		expect(multipartBoundary("multipart/form-data;boundary=----WebKitFormBoundaryX")).toBe("----WebKitFormBoundaryX");
	});

	test("matches the media type and parameter name case-insensitively", () => {
		expect(multipartBoundary("Multipart/Form-Data; Boundary=AbC")).toBe("AbC");
		expect(multipartBoundary("  MULTIPART/FORM-DATA ;  BOUNDARY=x ")).toBe("x");
	});

	test("finds the boundary among other parameters", () => {
		expect(multipartBoundary('multipart/form-data; charset=utf-8; boundary="q;r"; foo=bar')).toBe("q;r");
		expect(multipartBoundary("multipart/form-data; boundary=a; boundary=b")).toBe("a");
	});

	test("accepts 70 characters and rejects 0 or 71", () => {
		expect(multipartBoundary(`multipart/form-data; boundary=${"a".repeat(70)}`)).toBe("a".repeat(70));
		expect(multipartBoundary(`multipart/form-data; boundary=${"a".repeat(71)}`)).toBeNull();
		expect(multipartBoundary("multipart/form-data; boundary=")).toBeNull();
		expect(multipartBoundary('multipart/form-data; boundary=""')).toBeNull();
	});

	test("returns null for other types, a missing boundary or malformed values", () => {
		expect(multipartBoundary(null)).toBeNull();
		expect(multipartBoundary("")).toBeNull();
		expect(multipartBoundary("application/json; boundary=abc")).toBeNull();
		expect(multipartBoundary("multipart/mixed; boundary=abc")).toBeNull();
		expect(multipartBoundary("multipart/form-data")).toBeNull();
		expect(multipartBoundary("multipart/form-data; charset=utf-8")).toBeNull();
		expect(multipartBoundary('multipart/form-data; boundary="abc')).toBeNull();
	});
});
