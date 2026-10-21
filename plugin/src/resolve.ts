/**
 * Thread references (`Ref`): what a person or the model types for a thread. A 12-character id always resolves through
 * `GET /threads/{id}` (any thread, any age); anything else (a job id, an id suffix of 4 or more characters, an id or name
 * prefix) is searched in the pages of the thread list, newest first, up to {@link SCAN_LIMIT} threads.
 */

import type { CloudClient } from "./api";
import { candidateList, hintForUnmatched, resolveThread, type Command, type Parsed, type ThreadRef } from "./commands";
import { CloudError, cloudErrorText } from "./errors";

export const SCAN_LIMIT = 1000;
const PAGE_SIZE = 200;
/** An ambiguous reference names at most this many candidates. */
export const MAX_CANDIDATES = 10;
const FULL_ID = /^[a-z0-9]{12}$/;

export interface ResolveOptions {
	/** The id of the host job `thread`'s running turn is in this session, so a job id names the thread it runs. */
	jobOf?: (thread: string) => string | undefined;
	signal?: AbortSignal;
}

function ambiguous(token: string, hits: readonly ThreadRef[]): CloudError {
	const shown = hits.slice(0, MAX_CANDIDATES);
	const more = hits.length - shown.length;
	return new CloudError({
		code: "ambiguous_ref",
		message: `"${token}" matches ${hits.length} threads: ${candidateList(shown)}${more > 0 ? ` and ${more} more` : ""}`,
		retriable: false,
		outcomeKnown: true,
		candidates: shown.map(h => ({ id: h.id, name: h.name })),
		hint: "use the full 12-character thread id",
	});
}

/** The full id of the thread `token` names. Throws `not_found` or `ambiguous_ref` (with its candidates). */
export async function resolveRef(client: Pick<CloudClient, "thread" | "listThreadsPage">, token: string, opts: ResolveOptions = {}): Promise<string> {
	const wanted = token.trim();
	if (wanted === "") throw new CloudError({ code: "invalid", message: "no thread was named", retriable: false, outcomeKnown: true });
	const lower = wanted.toLowerCase();
	if (FULL_ID.test(lower)) {
		try {
			return (await client.thread(lower, { signal: opts.signal })).id;
		} catch (e) {
			if (!(e instanceof CloudError) || e.code !== "not_found") throw e;
			// Not an id after all (a 12-letter name or job id): search the list below.
		}
	}
	const refs: ThreadRef[] = [];
	let cursor: string | undefined;
	let total = 0;
	while (refs.length < SCAN_LIMIT) {
		const page = await client.listThreadsPage({ limit: PAGE_SIZE, before: cursor, signal: opts.signal });
		total = page.total;
		for (const t of page.threads) refs.push({ id: t.id, name: t.name, title: t.title, job: opts.jobOf?.(t.id) });
		if (page.next === null || page.threads.length === 0) break;
		cursor = page.next;
	}
	const match = resolveThread(lower, refs);
	if (!("error" in match)) return match.id;
	if (match.error === "ambiguous") throw ambiguous(wanted, match.candidates);
	const cut = total > refs.length;
	throw new CloudError({
		code: "not_found",
		message: cut ? `no thread matches "${wanted}" among the newest ${refs.length} of ${total} threads` : `no thread matches "${wanted}"`,
		retriable: false,
		outcomeKnown: true,
		...(cut ? { hint: "an older thread needs its full 12-character id" } : {}),
	});
}

/**
 * A parsed command with its thread token resolved. A reference that names no thread, or several, becomes an `error`
 * command that says so; any other failure (the service down, a bad token) is thrown.
 */
export async function resolveParsed(parsed: Parsed, client: Pick<CloudClient, "thread" | "listThreadsPage">, opts: ResolveOptions = {}): Promise<Command> {
	if (parsed.kind === "launch" || parsed.kind === "error" || parsed.kind === "login" || parsed.kind === "connect" || parsed.kind === "devices" || parsed.kind === "disconnect") return parsed;
	if (!("token" in parsed)) return { kind: parsed.kind };
	let thread: string;
	try {
		thread = await resolveRef(client, parsed.token, opts);
	} catch (e) {
		if (!(e instanceof CloudError)) throw e;
		if (e.code === "not_found") return { kind: "error", message: hintForUnmatched(parsed.token, parsed.kind) };
		if (e.code === "ambiguous_ref") return { kind: "error", message: `☁ ${cloudErrorText(e)}` };
		throw e;
	}
	if (parsed.kind === "send" || parsed.kind === "answer") return { kind: parsed.kind, thread, text: parsed.text };
	if (parsed.kind === "pull") return { kind: "pull", thread, into: parsed.into };
	return { kind: parsed.kind, thread };
}
