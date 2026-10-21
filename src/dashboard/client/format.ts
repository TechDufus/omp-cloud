/** Display formatting for times, money, sizes and links. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A local date and time, or the input itself when it is not a date; `"—"` for empty. */
export function dateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** "5 min ago" style age of `iso` up to a week; then a short date ("Oct 8", with the year only when it is not `now`'s). */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return "—";
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return iso;
	const age = Math.max(0, now - then);
	if (age < MINUTE) return "just now";
	if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
	if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
	if (age < 7 * DAY) return `${Math.floor(age / DAY)} d ago`;
	const date = new Date(then);
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** USD with four decimals below a dollar (turns cost cents or less), two above. */
export function money(value: number): string {
	return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function count(value: number): string {
	return value.toLocaleString();
}

export function bytes(value: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}
	return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

/** `url` when it is an http(s) URL, else null: server-supplied links never become `javascript:` hrefs. */
export function safeHref(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
	} catch {
		return null;
	}
}

/** The first `n` characters of a commit id. */
export function short(sha: string, n = 8): string {
	return sha.slice(0, n);
}

/** A `provider/id` model without its provider ("claude-sonnet-4-6"); `""` stays `""`. Show the full id as a title. */
export function modelName(model: string): string {
	return model.slice(model.indexOf("/") + 1);
}

/** "3 files, +10 −2" for a diffstat. */
export function diffstat(files: number, insertions: number, deletions: number): string {
	return `${count(files)} ${files === 1 ? "file" : "files"}, +${count(insertions)} −${count(deletions)}`;
}
