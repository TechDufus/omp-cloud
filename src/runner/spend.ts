/**
 * Spend caps: `policy.spend.turnUSD`, `policy.spend.threadUSD` and `policy.spend.dayUSD` (0 is no cap), read from the
 * settings at each check and tightened by the thread's own policy. A turn that goes over one is aborted and fails; a turn that would start with its thread or day
 * already at the cap fails without prompting omp. The cost is what omp reports per assistant message, so a cap bites at
 * the first message that crosses it, after that message's money is spent.
 */
import type { Settings } from "../settings";
import { effectivePolicy } from "../settings/tighten";
import type { Store } from "../store";
import type { Thread } from "../store/types";

export type SpendScope = "turn" | "thread" | "day";

/** The caps in USD; 0 turns a cap off. */
export interface SpendCaps {
	turn: number;
	thread: number;
	day: number;
}

/** What each scope has spent in USD, the running turn included. */
export type SpendTotals = Record<SpendScope, number>;

/** A cap that was crossed: its scope, what the scope spent and the cap. */
export interface SpendBreach {
	scope: SpendScope;
	spent: number;
	cap: number;
}

/** `during` a turn a cap is crossed by spending more than it; `before` a turn it is met by already having spent it (the turn's own cap cannot be, it has spent nothing). */
export type SpendPhase = "before" | "during";

/** The first cap, in the order turn, thread, day, that `totals` cross in `phase`; null when none is. */
export function breachOf(caps: SpendCaps, totals: SpendTotals, phase: SpendPhase): SpendBreach | null {
	for (const scope of ["turn", "thread", "day"] as const) {
		const cap = caps[scope];
		if (cap <= 0 || (phase === "before" && scope === "turn")) continue;
		const spent = totals[scope];
		if (phase === "before" ? spent >= cap : spent > cap) return { scope, spent, cap };
	}
	return null;
}

/** The error of a turn the cap ended: `spend cap reached: turn spend 0.1320 USD is over the 0.1 USD cap`. */
export function spendCapError(breach: SpendBreach): string {
	return `spend cap reached: ${breach.scope} spend ${breach.spent.toFixed(4)} USD is over the ${breach.cap} USD cap`;
}

/** The UTC day of `now` as `YYYY-MM-DD`: the day `Store.daySpend` totals. */
export function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Whether `thread` is over a cap, with `turnCost` the cost of its running turn so far (0 before the turn starts). The caps
 * are the settings' tightened by the thread's policy. The thread's total is its completed turns' cost plus the turn's, the
 * day's is the owner's spend on the UTC day (kept when threads are deleted) plus the turn's. The store is read only for a
 * cap that is set; with no cap set nothing is read.
 */
export function checkSpend(
	env: { store: Pick<Store, "getThread" | "spend" | "daySpend">; settings: Pick<Settings, "get"> },
	thread: Pick<Thread, "id" | "policy">,
	turnCost: number,
	phase: SpendPhase,
	now: Date = new Date(),
): SpendBreach | null {
	const caps = effectivePolicy(env.settings, thread.policy).spend;
	if (caps.turn <= 0 && caps.thread <= 0 && caps.day <= 0) return null;
	const totals: SpendTotals = { turn: turnCost, thread: turnCost, day: turnCost };
	if (caps.thread > 0 || caps.day > 0) {
		const owner = env.store.getThread(thread.id)?.owner;
		if (owner === undefined) return null;
		if (caps.thread > 0) totals.thread += env.store.spend(owner, "").threads.find(row => row.thread === thread.id)?.cost ?? 0;
		if (caps.day > 0) totals.day += env.store.daySpend(owner, utcDay(now));
	}
	return breachOf(caps, totals, phase);
}
