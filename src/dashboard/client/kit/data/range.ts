// MIT License. Copyright (c) 2025-2026 Can Bölük, 2026 Stencil Labs, Inc. Vendored from @oh-my-pi/omp-stats; see kit/LICENSE.
/**
 * Time-range metadata shared by every page: labels, the server's bucket size
 * for the range (mirrors `getTimeRangeConfig` in `aggregator.ts`), tick
 * formatting, and the contiguous bucket axis charts plot against.
 */


export type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface RangeMeta {
	/** Short selector label ("24h"). */
	label: string;
	/** Prose label for subtitles ("the last 24 hours"). */
	windowLabel: string;
	/** Span covered by the range; `null` for all time. */
	spanMs: number | null;
	/** Bucket size of the server's primary time series for this range. */
	bucketMs: number;
}

const RANGE_META: Record<TimeRange, RangeMeta> = {
	"1h": { label: "1h", windowLabel: "the last hour", spanMs: HOUR_MS, bucketMs: 5 * MINUTE_MS },
	"24h": { label: "24h", windowLabel: "the last 24 hours", spanMs: DAY_MS, bucketMs: HOUR_MS },
	"7d": { label: "7d", windowLabel: "the last 7 days", spanMs: 7 * DAY_MS, bucketMs: DAY_MS },
	"30d": { label: "30d", windowLabel: "the last 30 days", spanMs: 30 * DAY_MS, bucketMs: DAY_MS },
	"90d": { label: "90d", windowLabel: "the last 90 days", spanMs: 90 * DAY_MS, bucketMs: DAY_MS },
	all: { label: "All", windowLabel: "all time", spanMs: null, bucketMs: DAY_MS },
};

const MAX_BUCKETS = 1500;

/** Ranges in selector order. */
export const TIME_RANGES: readonly TimeRange[] = ["1h", "24h", "7d", "30d", "90d", "all"];

export function rangeMeta(range: TimeRange): RangeMeta {
	return RANGE_META[range];
}

const HOUR_MINUTE = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const MONTH_DAY_UTC = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** `format(date, "HH:mm")`. */
function clock(timestamp: number): string {
	return HOUR_MINUTE.format(new Date(timestamp));
}

/** `format(date, "MMM d")` in local time, for buckets shorter than a day. */
function monthDay(timestamp: number): string {
	return MONTH_DAY.format(new Date(timestamp));
}

/** Day buckets start at UTC midnight (the service groups by UTC day), so they are labelled in UTC. */
function utcDay(timestamp: number): string {
	return MONTH_DAY_UTC.format(new Date(timestamp));
}

/** Tick/tooltip label for a bucket start, precise enough for the bucket size. */
export function formatBucket(timestamp: number, bucketMs: number): string {
	if (bucketMs < DAY_MS) return bucketMs < HOUR_MS ? clock(timestamp) : `${monthDay(timestamp)} ${clock(timestamp)}`;
	return utcDay(timestamp);
}

/** Compact axis tick for a bucket start. */
export function formatTick(timestamp: number, bucketMs: number): string {
	if (bucketMs < DAY_MS) return clock(timestamp);
	return utcDay(timestamp);
}

/**
 * Contiguous, ascending bucket starts covering `range`, aligned like the
 * server's `(timestamp / bucketMs) * bucketMs`. For all time the axis starts at
 * the earliest data point, so gaps between sessions still render as zeros;
 * it is capped at {@link MAX_BUCKETS} so a stray epoch-zero timestamp cannot
 * explode the axis into decades of empty days.
 */
export function bucketAxis(
	range: TimeRange,
	dataTimestamps: Iterable<number>,
	bucketMs = RANGE_META[range].bucketMs,
	now = Date.now(),
): number[] {
	const last = Math.floor(now / bucketMs) * bucketMs;
	const span = RANGE_META[range].spanMs;
	let first: number;
	if (span !== null) {
		first = Math.floor((now - span) / bucketMs) * bucketMs;
	} else {
		first = last;
		for (const ts of dataTimestamps) if (ts < first) first = ts;
		first = Math.floor(first / bucketMs) * bucketMs;
	}
	first = Math.max(first, last - (MAX_BUCKETS - 1) * bucketMs);
	const buckets: number[] = [];
	for (let t = first; t <= last; t += bucketMs) buckets.push(t);
	return buckets;
}
