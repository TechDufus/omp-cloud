/** What the Logins page's Logged in table decides from a login's dates: pure, so it is tested without a browser. */

/** Inside this long before `renewBy` the badge turns to a warning. */
const RENEW_WARN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The tone of a "Renew by" badge: `bad` once `renewBy` is past, `warn` inside a week of it, else `neutral`. `null` when the
 * login has no known date (every provider but Anthropic) or the date does not parse.
 */
export function renewTone(renewBy: string, now: number): "bad" | "warn" | "neutral" | null {
	const left = new Date(renewBy).getTime() - now;
	if (renewBy === "" || Number.isNaN(left)) return null;
	if (left < 0) return "bad";
	return left < RENEW_WARN_MS ? "warn" : "neutral";
}
