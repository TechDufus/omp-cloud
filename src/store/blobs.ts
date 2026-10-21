import { mkdirSync, type Dirent } from "node:fs";
import { mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BLOB_NAMES, type BlobName, StoreError, THREAD_ID_PATTERN } from "./types";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 12;
/** The largest multiple of the alphabet size below 256: bytes from here on are rejected so the modulo has no bias. */
const ID_BYTE_LIMIT = 256 - (256 % ID_ALPHABET.length);

/** `<dataDir>/threads/<id>`; throws Error when `id` does not match THREAD_ID_PATTERN. */
export function threadDir(threadsDir: string, id: string): string {
	if (!THREAD_ID_PATTERN.test(id)) throw new Error(`invalid thread id: ${JSON.stringify(id)}`);
	return join(threadsDir, id);
}

/** Absolute path of a blob; throws Error for an invalid thread id or blob name. */
export function blobPath(threadsDir: string, id: string, name: BlobName): string {
	if (!BLOB_NAMES.includes(name)) throw new Error(`invalid blob name: ${JSON.stringify(name)}`);
	return join(threadDir(threadsDir, id), name);
}

/** A fresh random thread id whose directory this call creates exclusively. */
export function newThreadId(threadsDir: string): string {
	for (;;) {
		const id = randomId();
		try {
			mkdirSync(join(threadsDir, id), { mode: 0o700 });
			return id;
		} catch (err) {
			if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
		}
	}
}

/** A random 12-character `[a-z0-9]` id. */
export function randomId(): string {
	let id = "";
	while (id.length < ID_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2))) {
			if (byte >= ID_BYTE_LIMIT) continue;
			id += ID_ALPHABET.charAt(byte % ID_ALPHABET.length);
			if (id.length === ID_LENGTH) break;
		}
	}
	return id;
}

/**
 * Streams `body` into a temp file beside the blob, fsyncs and renames it over the blob. Past `maxBytes` it stops
 * reading, removes the temp file, keeps any previous blob and throws "too_large". Returns the byte count.
 */
export async function putBlob(
	threadsDir: string,
	id: string,
	name: BlobName,
	body: Uint8Array | AsyncIterable<Uint8Array>,
	maxBytes: number,
): Promise<number> {
	const target = blobPath(threadsDir, id, name);
	const dir = threadDir(threadsDir, id);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
	const file = await open(temp, "wx", 0o600);
	let total = 0;
	try {
		for await (const chunk of body instanceof Uint8Array ? [body] : body) {
			total += chunk.byteLength;
			if (total > maxBytes) throw new StoreError("too_large", `${name} is larger than ${maxBytes} bytes`);
			await file.writeFile(chunk);
		}
		await file.sync();
	} catch (err) {
		await file.close();
		await unlink(temp);
		throw err;
	}
	await file.close();
	try {
		await rename(temp, target);
	} catch (err) {
		await unlink(temp);
		throw err;
	}
	return total;
}

/** Removes a thread's blob directory; a missing one is fine. */
export async function removeBlobs(threadsDir: string, id: string): Promise<void> {
	await rm(threadDir(threadsDir, id), { recursive: true, force: true });
}

/** Removes every directory under `threadsDir` that `isLive` does not accept; returns how many. */
export async function sweepDirs(threadsDir: string, isLive: (name: string) => boolean): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(threadsDir, { withFileTypes: true });
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") return 0;
		throw err;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || isLive(entry.name)) continue;
		await rm(join(threadsDir, entry.name), { recursive: true, force: true });
		removed++;
	}
	return removed;
}
