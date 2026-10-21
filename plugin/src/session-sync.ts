import { readFile, realpath, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { Env } from "./config";
import { comparablePath, ompCommand, run } from "./exec";
import { isRecord } from "./guards";

/**
 * `created`: the export landed under its own id; `forked`: omp kept a diverged local copy and placed the export under a new id;
 * `unchanged`: a local copy already holds every entry; `skipped`: a kept copy would have made omp fork and the caller did not allow that.
 */
export type SyncMode = "unchanged" | "created" | "forked" | "skipped";

export interface SyncOutcome {
	/** The local session file holding the export; for `skipped`, the first local copy that was kept. */
	file: string;
	mode: SyncMode;
}

export interface SyncInput {
	/** An `omp session pack` archive of the cloud conversation. */
	archive: string;
	/** Where the session is placed: its session bucket follows this directory. */
	cwd: string;
	/** The session file this omp writes right now; never modified or removed. */
	current: string | undefined;
	env?: Env;
	/** Sessions root searched for older copies; omp's own by default. */
	sessionsRoot?: string;
	/** Takes omp's lease on a session; null while another live omp writes it. omp's own by default. */
	claim?: (id: string, file: string) => (() => void) | null;
	/** Whether omp may place the export as a fork when a local copy of its session id has to be kept; background saves pass false. */
	fork: boolean;
}

interface Entry {
	id: string;
	/** An omp `arrived` marker: omp appends one to every session it unpacks. */
	arrived: boolean;
}

interface Journal {
	id: string | undefined;
	entries: Entry[];
}

function isArrivalMarker(o: Record<string, unknown>): boolean {
	return o.type === "custom_message" && o.customType === "session-transfer" && isRecord(o.details) && o.details.kind === "arrived";
}

/** The session id and the transcript entries (every object with an `id` except the header and `title` slots), in order. Throws on a line that is not JSON. */
function parseJournal(text: string): Journal {
	let id: string | undefined;
	const entries: Entry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const o: unknown = JSON.parse(line);
		if (!isRecord(o)) continue;
		if (o.type === "session") {
			if (id === undefined && typeof o.id === "string") id = o.id;
		} else if (o.type !== "title" && typeof o.id === "string") {
			entries.push({ id: o.id, arrived: isArrivalMarker(o) });
		}
	}
	return { id, entries };
}

/** The entry ids without the `arrived` markers that close the journal. */
function withoutTrailingArrivals(entries: readonly Entry[]): string[] {
	let end = entries.length;
	while (end > 0 && entries[end - 1]?.arrived) end--;
	return entries.slice(0, end).map(e => e.id);
}

async function sameFile(a: string, b: string): Promise<boolean> {
	const real = (p: string) => realpath(p).catch(() => resolve(p));
	return comparablePath(await real(a)) === comparablePath(await real(b));
}

/** The `session.jsonl` of an `omp session pack` archive, read in process: a `tar` on PATH may be GNU tar, which reads `C:\…` as a remote host. */
export async function readArchiveJournal(archive: string): Promise<string> {
	let text: string | undefined;
	try {
		// Bun.Archive does not read a lazy `Bun.file` blob ("Unrecognized archive format"): hand it the bytes.
		text = await (await new Bun.Archive(await Bun.file(archive).bytes()).files("session.jsonl")).get("session.jsonl")?.text();
	} catch (e) {
		throw new Error(`cannot read the conversation archive: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (text === undefined) throw new Error("the conversation archive holds no session.jsonl");
	return text;
}

/** The incoming session's id and entry ids, read from the archive. */
async function readIncoming(archive: string): Promise<{ id: string; ids: string[] }> {
	const text = await readArchiveJournal(archive);
	let journal: Journal;
	try {
		journal = parseJournal(text);
	} catch (e) {
		throw new Error(`the conversation archive holds an unreadable session journal: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (journal.id === undefined) throw new Error("the conversation archive has no session header");
	return { id: journal.id, ids: journal.entries.map(e => e.id) };
}

/**
 * Places the cloud conversation in the local omp sessions with `omp session unpack`, keeping one local
 * session per thread at a stable path. omp's unpack replaces local copies of the same id only when their entries are a
 * prefix of the incoming ones (it skips `departed` markers and nothing else), and lands the export as a fork under a new id
 * otherwise. Every unpacked copy ends with its own `arrived` marker, which is not in the next export, so a second unpack of
 * a grown export would fork; untouched older copies (a strict prefix of the export once trailing markers are dropped) are
 * therefore removed first, and unpack then lands at the same path. A copy the user continued, the session this omp
 * writes, a copy another live omp holds and a copy that cannot be parsed are left alone, and omp would
 * fork the export beside them under a new id. That fork is placed only when `fork` is true; otherwise
 * nothing is unpacked and the outcome is `skipped` with the first kept copy, so repeated background
 * saves cannot pile up forks. `omp stats` counts the cloud turns from these files: its rows are first-write-wins on
 * `(entry_id, timestamp)` across files (copies, forks and a replaced file count once, a deleted file's rows stay) and
 * keep each message's stored cost, so the sync never touches `stats.db` itself.
 */
export async function syncConversation(input: SyncInput): Promise<SyncOutcome> {
	const { archive, cwd, current, env, sessionsRoot, fork } = input;
	const claim = input.claim ?? ((id: string, file: string) => new FileSessionStorage().claimSession(id, file));
	const incoming = await readIncoming(archive);

	let same: string | undefined;
	const kept: string[] = [];
	const copies = (await findSessionFiles(incoming.id, sessionsRoot)).filter(f => basename(f).endsWith(`_${incoming.id}.jsonl`));
	for (const file of copies) {
		let journal: Journal;
		try {
			journal = parseJournal(await readFile(file, "utf8"));
		} catch {
			kept.push(file);
			continue;
		}
		if (journal.id !== incoming.id) continue;
		const core = withoutTrailingArrivals(journal.entries);
		if (core.length > incoming.ids.length || core.some((id, i) => id !== incoming.ids[i])) {
			kept.push(file);
			continue;
		}
		if (core.length === incoming.ids.length) {
			same ??= file;
			continue;
		}
		if (current !== undefined && (await sameFile(file, current))) {
			kept.push(file);
			continue;
		}
		const release = claim(incoming.id, file);
		if (!release) {
			kept.push(file);
			continue;
		}
		try {
			await rm(file, { force: true });
			await rm(file.slice(0, -".jsonl".length), { recursive: true, force: true });
		} finally {
			release();
		}
	}
	if (same !== undefined) return { file: same, mode: "unchanged" };
	if (!fork && kept[0] !== undefined) return { file: kept[0], mode: "skipped" };

	const [omp = "omp", ...prefix] = ompCommand();
	const r = await run(omp, [...prefix, "session", "unpack", archive, "--cwd", cwd], { cwd, env, timeoutMs: 120_000 });
	if (r.code !== 0) throw new Error(`cannot unpack the conversation with omp session unpack: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
	const file = r.stdout.trim().split("\n").at(-1)?.trim();
	if (!file) throw new Error("omp session unpack printed no session file");
	const placed = parseJournal(await readFile(file, "utf8"));
	return { file, mode: placed.id === incoming.id ? "created" : "forked" };
}
