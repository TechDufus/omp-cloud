import type { Turn } from "../store/types";
import { ApiError } from "./errors";
import { intParam } from "./query";

export const TURN_TEXT_PARTS = ["reply", "error", "text"] as const;
export type TurnTextPart = (typeof TURN_TEXT_PARTS)[number];

const DEFAULT_LIMIT = 8000;
const MAX_LIMIT = 32_000;

/** The `GET /threads/{id}/turns/{turn}/reply` answer. Offsets count UTF-16 code units, like JavaScript string indices. */
export interface TurnTextPage {
	turn: number;
	part: TurnTextPart;
	total: number;
	offset: number;
	text: string;
	next: number | null;
}

/**
 * One page of a turn's `reply`, `error` or prompt (`text`), by `part`, `offset` and `limit` (1 to 32000 code units,
 * default 8000). A page never splits a surrogate pair: an `offset` inside one starts at the next code unit (the answer's
 * `offset` says where), and a page that would end inside one ends before it (a page of one unit takes the whole pair).
 * Throws 400 for a bad parameter.
 */
export function turnTextPage(turn: Turn, url: URL): TurnTextPage {
	const requested = url.searchParams.get("part") ?? "reply";
	const part = TURN_TEXT_PARTS.find((name) => name === requested);
	if (part === undefined) throw new ApiError(400, `part must be one of ${TURN_TEXT_PARTS.join(", ")}`);
	const offset = intParam(url, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
	const limit = intParam(url, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
	const full = part === "reply" ? turn.reply : part === "error" ? turn.error : turn.text;
	const total = full.length;
	if (offset >= total) return { turn: turn.id, part, total, offset, text: "", next: null };
	const isHigh = (index: number): boolean => full.charCodeAt(index) >= 0xd800 && full.charCodeAt(index) <= 0xdbff;
	const isLow = (index: number): boolean => full.charCodeAt(index) >= 0xdc00 && full.charCodeAt(index) <= 0xdfff;
	let start = offset;
	if (start > 0 && isLow(start) && isHigh(start - 1)) start++;
	let end = Math.min(start + limit, total);
	if (end < total && isHigh(end - 1)) end = end - 1 > start ? end - 1 : end + 1;
	return { turn: turn.id, part, total, offset: start, text: full.slice(start, end), next: end < total ? end : null };
}
