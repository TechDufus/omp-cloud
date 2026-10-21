import type { Store } from "../store";
import { type Thread, type ThreadCursor, type ThreadListFilter, type ThreadOrigin, type ThreadPhase, THREAD_ID_PATTERN } from "../store/types";
import { ApiError } from "./errors";
import type { ThreadSummaryView } from "./views";

const DEFAULT_LIMIT = 50;
/** The most threads one page lists (`limit` 1 to this). */
export const MAX_LIST_LIMIT = 200;
const LIVE_PHASES: readonly ThreadPhase[] = ["starting", "working", "waiting", "idle", "failed"];
const REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_FIELD_CHARS = 128;
const MAX_REPO_CHARS = 512;
/** A date, or a date and time with a zone: what `new Date` reads the same everywhere. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const STORED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A validated `GET /api/v1/threads` query. */
export interface ListQuery {
	filter: ThreadListFilter;
	limit: number;
	after: ThreadCursor | null;
}

function bad(message: string): ApiError {
	return new ApiError(400, message);
}

function plain(value: string, chars: number): boolean {
	return value.isWellFormed() && Array.from(value).length <= chars && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The opaque `next` / `before` cursor of a position: base64url of the JSON `[lastActivityAt, id]`. */
export function encodeCursor(cursor: ThreadCursor): string {
	return Buffer.from(JSON.stringify([cursor.lastActivityAt, cursor.id])).toString("base64url");
}

function decodeCursor(text: string): ThreadCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
	} catch {
		throw bad("before is not a valid cursor");
	}
	if (Array.isArray(parsed) && parsed.length === 2) {
		const [lastActivityAt, id] = parsed;
		if (typeof lastActivityAt === "string" && STORED_TIME.test(lastActivityAt) && typeof id === "string" && THREAD_ID_PATTERN.test(id)) {
			return { lastActivityAt, id };
		}
	}
	throw bad("before is not a valid cursor");
}

/** The first value of `name`; absent is undefined, an empty value is 400. */
function param(params: URLSearchParams, name: string): string | undefined {
	const value = params.get(name);
	if (value === null) return undefined;
	if (value === "") throw bad(`${name} must not be empty`);
	return value;
}

/**
 * Validates the query of the thread list: `limit` 1-200 (default 50), `before` (a cursor), `phase` (comma list of live
 * phases), `origin`, `ref`, `session`, `repo` and `since` (ISO time). Throws ApiError(400) naming the bad parameter.
 */
export function parseListQuery(params: URLSearchParams): ListQuery {
	const filter: ThreadListFilter = {};
	const limitText = param(params, "limit");
	let limit = DEFAULT_LIMIT;
	if (limitText !== undefined) {
		limit = Number(limitText);
		if (!/^\d+$/.test(limitText) || limit < 1 || limit > MAX_LIST_LIMIT) throw bad(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
	}
	const before = param(params, "before");
	const phase = param(params, "phase");
	if (phase !== undefined) {
		const phases = phase.split(",");
		for (const name of phases) {
			if (!(LIVE_PHASES as readonly string[]).includes(name)) throw bad(`phase must be a comma list of ${LIVE_PHASES.join(", ")}`);
		}
		filter.phases = [...new Set(phases)] as ThreadPhase[];
	}
	const origin = param(params, "origin");
	if (origin !== undefined) {
		if (origin !== "tool" && origin !== "user") throw bad('origin must be "tool" or "user"');
		filter.origin = origin satisfies ThreadOrigin;
	}
	const ref = param(params, "ref");
	if (ref !== undefined) {
		if (!REF_PATTERN.test(ref)) throw bad("ref must be 1 to 64 characters of letters, digits, . _ or -");
		filter.ref = ref;
	}
	const session = param(params, "session");
	if (session !== undefined) {
		if (!plain(session, MAX_FIELD_CHARS)) throw bad(`session must be at most ${MAX_FIELD_CHARS} characters without control characters`);
		filter.session = session;
	}
	const repo = param(params, "repo");
	if (repo !== undefined) {
		if (!plain(repo, MAX_REPO_CHARS)) throw bad(`repo must be at most ${MAX_REPO_CHARS} characters without control characters`);
		filter.repo = repo;
	}
	const since = param(params, "since");
	if (since !== undefined) {
		const at = ISO_TIME.test(since) ? new Date(since) : null;
		if (at === null || Number.isNaN(at.getTime())) throw bad("since must be an ISO 8601 date or date-time with a zone");
		filter.since = at.toISOString();
	}
	return { filter, limit, after: before === undefined ? null : decodeCursor(before) };
}

/** The answer of `GET /api/v1/threads`: `{threads, next, total}`; `summarize` renders one thread. */
export function threadListBody(
	store: Store,
	owner: string,
	params: URLSearchParams,
	summarize: (thread: Thread) => ThreadSummaryView,
): { threads: ThreadSummaryView[]; next: string | null; total: number } {
	const query = parseListQuery(params);
	const page = store.listThreadsPage(owner, query.filter, query.limit, query.after);
	return { threads: page.threads.map(summarize), next: page.next === null ? null : encodeCursor(page.next), total: page.total };
}
