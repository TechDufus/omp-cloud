import type { GitService } from "../git";
import { InspectError, type Inspection } from "../git/inspect";
import type { Store } from "../store";
import type { Thread } from "../store/types";
import { ApiError } from "./errors";
import type { InspectGate } from "./inspect-gate";
import { intParam } from "./query";

/** At most this many entries of a tree listing. */
export const MAX_TREE_ENTRIES = 5000;
const MAX_DIFF_BYTES = 1024 ** 2;
const DEFAULT_DIFF_BYTES = 65_536;
const MAX_CONTEXT = 20;
const DEFAULT_CONTEXT = 3;
const MAX_FILE_BYTES = 1024 ** 2;
const DEFAULT_FILE_BYTES = 65_536;
/** The longest repository-relative path a request may name. */
const MAX_PATH_BYTES = 4096;

export type InspectRoute = "diff" | "tree" | "files";

/** What the three routes need from the service. */
export interface InspectDeps {
	store: Store;
	git: Pick<GitService, "inspect">;
	/** Admits a few inspections at a time; the rest wait. */
	gate: InspectGate;
	/** The request's: a client that goes away leaves the gate's queue. */
	signal: AbortSignal;
}

/** A `0`/`1` (or `false`/`true`) query flag, false when absent. Throws 400 naming the parameter. */
function flagParam(url: URL, name: string): boolean {
	const raw = url.searchParams.get(name);
	if (raw === null || raw === "0" || raw === "false") return false;
	if (raw === "1" || raw === "true") return true;
	throw new ApiError(400, `${name} must be 1 or 0`);
}

/**
 * A repository-relative path as the routes accept it: `""` for the root, else segments joined by `/` (one trailing `/`
 * is dropped). Throws 400 for an absolute path, an empty, `.` or `..` segment, a segment `.git` (any case), a control
 * character or a path over 4096 bytes.
 */
export function repoPath(raw: string, name: string): string {
	if (raw.startsWith("/")) throw new ApiError(400, `${name} must be relative to the repository root`);
	const path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
	if (path === "") return "";
	if (Buffer.byteLength(path) > MAX_PATH_BYTES) throw new ApiError(400, `${name} is longer than ${MAX_PATH_BYTES} bytes`);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
	if (/[\u0000-\u001f\u007f]/.test(path)) throw new ApiError(400, `${name} must not contain control characters`);
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") throw new ApiError(400, `${name} must not contain empty, "." or ".." segments`);
		if (segment.toLowerCase() === ".git") throw new ApiError(400, `${name} must not go through .git`);
	}
	return path;
}

/** The commits a diff compares: the handoff commit or the head of the previous turn that recorded one, then the head of `turn` (the newest recorded head without it). */
function diffRange(store: Store, thread: Thread, turn: number | null): { base: string; head: string } {
	const recorded = store.turns(thread.id).filter((t) => t.head !== "");
	if (turn === null) {
		const newest = recorded.at(-1);
		if (newest === undefined) throw new ApiError(404, "no result yet");
		return { base: thread.repo.handoffCommit, head: newest.head };
	}
	const found = store.turns(thread.id).find((t) => t.id === turn);
	if (found === undefined) throw new ApiError(404, `no turn ${turn}`);
	if (found.head === "") throw new ApiError(404, `turn ${turn} recorded no head`);
	const previous = recorded.filter((t) => t.id < turn).at(-1);
	return { base: previous?.head ?? thread.repo.handoffCommit, head: found.head };
}

/** `bytes` without a trailing, incomplete UTF-8 sequence (a cut in the middle of a character). */
function wholeCharacters(bytes: Buffer): Buffer {
	for (let back = 1; back <= 4 && back <= bytes.length; back++) {
		const byte = bytes[bytes.length - back] ?? 0;
		if ((byte & 0xc0) === 0x80) continue;
		const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return length > back ? bytes.subarray(0, bytes.length - back) : bytes;
	}
	return bytes;
}

/** Runs `read` over the thread's inspection repository; a thread whose base cannot be found answers 404. */
async function inspecting<T>(deps: InspectDeps, thread: Thread, read: (inspection: Inspection) => Promise<T>): Promise<T> {
	const { store, git, gate, signal } = deps;
	const [result, source] = await Promise.all([
		store.blob(thread.id, "result.bundle"),
		thread.repo.baseCommit === "" ? store.blob(thread.id, "source.bundle") : Promise.resolve(null),
	]);
	try {
		return await gate.run(signal, () =>
			git.inspect(
				{
					threadId: thread.id,
					remoteURL: thread.repo.remoteURL,
					baseCommit: thread.repo.baseCommit,
					sourceBundle: source === null ? null : store.blobPath(thread.id, "source.bundle"),
					resultBundle: result === null ? null : store.blobPath(thread.id, "result.bundle"),
					resultBranch: `omp-cloud/${thread.id}`,
				},
				read,
			),
		);
	} catch (error) {
		if (error instanceof InspectError && error.code === "base") throw new ApiError(404, error.message);
		throw error;
	}
}

/** Throws 404 when the repository does not hold `commit`. */
async function requireCommit(inspection: Inspection, commit: string, what: string): Promise<void> {
	if (!(await inspection.has(commit))) throw new ApiError(404, `the stored result does not hold ${what} ${commit}`);
}

async function diffResponse(deps: InspectDeps, thread: Thread, url: URL): Promise<Response> {
	const turnParam = url.searchParams.get("turn");
	const turn = turnParam === null ? null : intParam(url, "turn", 1, Number.MAX_SAFE_INTEGER, 0);
	const path = repoPath(url.searchParams.get("path") ?? "", "path");
	const stat = flagParam(url, "stat");
	const context = intParam(url, "context", 0, MAX_CONTEXT, DEFAULT_CONTEXT);
	const maxBytes = intParam(url, "maxBytes", 1, MAX_DIFF_BYTES, DEFAULT_DIFF_BYTES);
	const { base, head } = diffRange(deps.store, thread, turn);
	return inspecting(deps, thread, async (inspection) => {
		await requireCommit(inspection, base, "the base");
		await requireCommit(inspection, head, "the head");
		if (stat) {
			const counted = await inspection.stat(base, head, path);
			return Response.json({ base, head, files: counted.files, insertions: counted.insertions, deletions: counted.deletions, truncated: counted.truncated });
		}
		const diff = await inspection.diff(base, head, { path, context, maxBytes });
		const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8", "X-Omp-Base": base, "X-Omp-Head": head };
		const cut = diff.length > diff.bytes.length;
		if (cut) headers["X-Omp-Truncated"] = String(diff.length);
		return new Response(cut ? wholeCharacters(diff.bytes) : diff.bytes, { headers });
	});
}

/** `ref=head|base` as the commit it names. Throws 400 for another value and 404 `no result yet` for `head` without a recorded head. */
function refCommit(store: Store, thread: Thread, url: URL): { ref: "head" | "base"; commit: string } {
	const ref = url.searchParams.get("ref") ?? "head";
	if (ref === "base") return { ref, commit: thread.repo.handoffCommit };
	if (ref !== "head") throw new ApiError(400, "ref must be head or base");
	const head = store.threadStats(thread.id).resultTurn?.head;
	if (head === undefined) throw new ApiError(404, "no result yet");
	return { ref, commit: head };
}

async function treeResponse(deps: InspectDeps, thread: Thread, url: URL): Promise<Response> {
	const path = repoPath(url.searchParams.get("path") ?? "", "path");
	const recursive = flagParam(url, "recursive");
	const { ref, commit } = refCommit(deps.store, thread, url);
	return inspecting(deps, thread, async (inspection) => {
		await requireCommit(inspection, commit, ref);
		const listing = await inspection.tree(commit, path, { recursive, limit: MAX_TREE_ENTRIES });
		if (listing === null) throw new ApiError(404, "no such directory");
		return Response.json({ ref, commit, path, entries: listing.entries, truncated: listing.truncated });
	});
}

async function fileResponse(deps: InspectDeps, thread: Thread, url: URL, rawPath: string): Promise<Response> {
	const path = repoPath(rawPath, "path");
	if (path === "") throw new ApiError(400, "path is required");
	const offset = intParam(url, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
	const limit = intParam(url, "limit", 1, MAX_FILE_BYTES, DEFAULT_FILE_BYTES);
	const { ref, commit } = refCommit(deps.store, thread, url);
	return inspecting(deps, thread, async (inspection) => {
		await requireCommit(inspection, commit, ref);
		const page = await inspection.file(commit, path, { offset, limit });
		if (page === null) throw new ApiError(404, "no such file");
		return Response.json({ path, ref, commit, size: page.size, binary: page.binary, offset: page.offset, text: page.text, next: page.next });
	});
}

/** Serves `GET /threads/{id}/diff`, `/tree` and `/files/<path>` from the thread's stored result bundle and base. `filePath` is the decoded path of a `files` request. */
export function inspectResponse(deps: InspectDeps, thread: Thread, route: InspectRoute, url: URL, filePath: string): Promise<Response> {
	switch (route) {
		case "diff":
			return diffResponse(deps, thread, url);
		case "tree":
			return treeResponse(deps, thread, url);
		case "files":
			return fileResponse(deps, thread, url, filePath);
	}
}

