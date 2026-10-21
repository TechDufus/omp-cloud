import { createHash } from "node:crypto";
import { isRecord } from "../guards";
import { type Exec, ExecError, shellQuote } from "./exec";

/** The session ids omp writes: UUIDs, but anything this narrow is safe inside a `sed` expression and a shell word. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** How many leading journal lines may precede or hold the header (a `title` slot line can come first; `omp session pack` rejects a journal whose first line is neither a `title` nor a `session` entry). */
const HEADER_SEARCH_LINES = 4;

/**
 * The session id every export of thread `threadId` carries: stable, derived from the thread id, and never the id of the
 * conversation the thread was created with. UUID-shaped: 32 hex digits of a SHA-256 as 8-4-4-4-12, version nibble 8,
 * RFC variant.
 */
export function exportSessionId(threadId: string): string {
	const hex = createHash("sha256").update(`omp-cloud/session/${threadId}`).digest("hex").slice(0, 32);
	const variant = (Number.parseInt(hex[16] ?? "0", 16) & 3) | 8;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant.toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The id of a journal's header line and its 1-based line number among the first lines; null when there is none. */
function findHeader(head: string): { line: number; id: string } | null {
	const lines = head.split("\n");
	for (let i = 0; i < Math.min(lines.length, HEADER_SEARCH_LINES); i++) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(lines[i] ?? "");
		} catch {
			continue;
		}
		if (isRecord(parsed) && parsed.type === "session") {
			return { line: i + 1, id: typeof parsed.id === "string" ? parsed.id : "" };
		}
	}
	return null;
}

/**
 * Packs a copy of the omp session journal `sessionFile` (and its artifacts directory) into the `omp session pack` archive
 * `outPath`, with the header's session id replaced by `exportId`. omp refuses to pack a session another process writes,
 * and the id is what it leases (a plain copy of a live session is refused too), so the copy under another id packs while omp
 * keeps writing the original. omp appends each journal entry synchronously (rewrites too), so a settled turn's entries are
 * already on disk when this copies. Only complete journal lines are copied; every entry keeps its id and timestamp. Runs
 * through `exec` (the sandbox in production).
 * Throws `ExecError` or `Error` (no header, an id that is not a session id, or `sessionFile` already carries `exportId`).
 */
export async function exportSession(exec: Exec, input: { sessionFile: string; exportId: string; outPath: string }): Promise<void> {
	const { sessionFile, exportId, outPath } = input;
	if (!SESSION_ID.test(exportId)) throw new Error(`invalid export session id: ${JSON.stringify(exportId)}`);
	if (!sessionFile.endsWith(".jsonl")) throw new Error(`the session file is not a .jsonl journal: ${sessionFile}`);
	const q = shellQuote;
	const tmp = (await exec("mktemp -d")).trim();
	if (tmp === "") throw new Error("mktemp -d printed no directory");
	try {
		const copy = `${tmp}/session.jsonl`;
		await exec(`head -n "$(wc -l < ${q(sessionFile)})" ${q(sessionFile)} > ${q(copy)}`);
		const artifacts = sessionFile.slice(0, -".jsonl".length);
		await exec(`if [ -d ${q(artifacts)} ]; then cp -a ${q(artifacts)} ${q(`${tmp}/session`)}; fi`);

		const header = findHeader(await exec(`head -n ${HEADER_SEARCH_LINES} ${q(copy)}`));
		if (header === null) throw new Error("the session journal has no header line");
		if (!SESSION_ID.test(header.id)) throw new Error(`the session header carries an unusable id: ${JSON.stringify(header.id)}`);
		if (header.id === exportId) throw new Error("the session already carries the export id, so it is the live session and cannot be packed");
		await exec(`sed -i '${header.line}s/"id":"${header.id}"/"id":"${exportId}"/' ${q(copy)}`);
		const check = findHeader(await exec(`head -n ${HEADER_SEARCH_LINES} ${q(copy)}`));
		if (check === null || check.line !== header.line || check.id !== exportId) {
			throw new Error("the session header could not be rewritten to the export id");
		}

		try {
			await exec(`omp session pack ${q(copy)} ${q(outPath)}`);
		} catch (error) {
			if (!(error instanceof ExecError)) throw error;
			const reason = error.stderr.trim().split("\n").at(-1)?.trim().slice(0, 200) || `exit ${error.exitCode}`;
			throw new Error(`omp session pack failed: ${reason}`);
		}
	} finally {
		await exec(`rm -rf ${q(tmp)}`).catch(() => undefined);
	}
}

/**
 * Rewrites the session id of the `omp session pack` archive `archive` to `sessionId` and packs the result to `outPath`.
 * An export carries the stable export id and `exportSession` refuses a live session that carries it, so the archive of a
 * restored thread is re-identified before `omp session unpack` makes it the live session. Both `manifest.json` and the
 * journal header name the id (omp refuses an archive where they differ). Every journal line, artifact and blob is kept
 * as is; the new archive holds exactly `manifest.json`, `session.jsonl` and the files under `artifacts/` and `blobs/`,
 * never a directory member. Runs through `exec` (the sandbox in production). Throws `ExecError` or `Error` (an id that is
 * not a session id, an archive without manifest or header).
 */
export async function reidentifySession(exec: Exec, input: { archive: string; outPath: string; sessionId: string }): Promise<void> {
	const { archive, outPath, sessionId } = input;
	if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
	const q = shellQuote;
	const tmp = (await exec("mktemp -d")).trim();
	if (tmp === "") throw new Error("mktemp -d printed no directory");
	try {
		await exec(`tar -xf ${q(archive)} -C ${q(tmp)}`);
		const journal = `${tmp}/session.jsonl`;
		const manifestFile = `${tmp}/manifest.json`;

		let manifest: unknown;
		try {
			manifest = JSON.parse(await exec(`cat ${q(manifestFile)}`));
		} catch (error) {
			if (error instanceof ExecError) throw new Error("the archive has no manifest.json");
			throw new Error("the archive's manifest.json is not JSON");
		}
		if (!isRecord(manifest) || typeof manifest.id !== "string") throw new Error("the archive's manifest.json has no id");
		await exec(`printf %s ${q(JSON.stringify({ ...manifest, id: sessionId }, null, 2))} > ${q(manifestFile)}`);

		const header = findHeader(await exec(`head -n ${HEADER_SEARCH_LINES} ${q(journal)}`));
		if (header === null) throw new Error("the session journal has no header line");
		if (!SESSION_ID.test(header.id)) throw new Error(`the session header carries an unusable id: ${JSON.stringify(header.id)}`);
		await exec(`sed -i '${header.line}s/"id":"${header.id}"/"id":"${sessionId}"/' ${q(journal)}`);
		const check = findHeader(await exec(`head -n ${HEADER_SEARCH_LINES} ${q(journal)}`));
		if (check === null || check.line !== header.line || check.id !== sessionId) {
			throw new Error("the session header could not be rewritten to the new id");
		}

		await exec(`{ printf '%s\\n' manifest.json session.jsonl; find artifacts blobs -type f 2>/dev/null; true; } | tar -cf ${q(outPath)} --verbatim-files-from -T -`, { cwd: tmp });
	} finally {
		await exec(`rm -rf ${q(tmp)}`).catch(() => undefined);
	}
}
