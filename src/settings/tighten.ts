/**
 * The per-thread policy: a thread may tighten the service's policy, never loosen it, so a client cannot widen what the
 * owner restricted. A create request may carry a
 * policy of its own; {@link tightenPolicy} lays it over the service's policy settings and the result is what the
 * thread's VM, network, spend caps and model check follow. Pure: the settings are read by the caller, at each use, so a
 * later change of the service's policy still applies and a thread can never loosen it.
 */
import { isRecord } from "../guards";
import type { SpendCaps } from "../runner/spend";
import type { Settings } from "./index";
import { type Approval, type BashPattern, REGISTRY, SettingError } from "./registry";
import { POLICY_KEYS, type PolicyKey, type PolicyValues, type ThreadPolicy } from "./policy";

/** The policy a thread runs under: the service's and the thread's, tightened. */
export interface EffectivePolicy {
	bashPatterns: readonly BashPattern[];
	toolApproval: Readonly<Record<string, Approval>>;
	fetch: boolean;
	webSearch: boolean;
	browser: boolean;
	/** Empty leaves the network open. */
	egress: readonly string[];
	/** 0 is no cap. */
	spend: SpendCaps;
	/** The non-empty `models.allowed` lists, the service's first: a model must match every one. */
	modelsAllowed: readonly (readonly string[])[];
}

/** How strict an approval is; the stricter one wins. */
const STRICTNESS: Readonly<Record<Approval, number>> = { allow: 0, prompt: 1, deny: 2 };

function isPolicyKey(name: string): name is PolicyKey {
	return (POLICY_KEYS as readonly string[]).includes(name);
}

/** The most characters of an unknown key quoted in a message. */
const MAX_QUOTED_KEY = 100;

/**
 * The thread policy of a create request's `policy` value (absent or null is none), each value validated and normalized
 * by the registry's validator of `policy.<key>`. Throws {@link SettingError}: unknown key or a value its validator refuses.
 */
export function parseThreadPolicy(raw: unknown): ThreadPolicy {
	if (raw === undefined || raw === null) return {};
	if (!isRecord(raw)) throw new SettingError("policy must be an object");
	const parsed: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!isPolicyKey(name)) throw new SettingError(`unknown policy key ${name.slice(0, MAX_QUOTED_KEY)}`);
		parsed[name] = REGISTRY[`policy.${name}` as const].parse(value);
	}
	// Every key is a policy key and every value came out of its registry validator, which is what ThreadPolicy holds.
	return parsed as ThreadPolicy;
}

/** The service's policy settings as they are now. */
export function globalPolicy(settings: Pick<Settings, "get">): PolicyValues {
	return {
		"bash.patterns": settings.get("policy.bash.patterns"),
		"tools.approval": settings.get("policy.tools.approval"),
		fetch: settings.get("policy.fetch"),
		webSearch: settings.get("policy.webSearch"),
		browser: settings.get("policy.browser"),
		egress: settings.get("policy.egress"),
		"spend.turnUSD": settings.get("policy.spend.turnUSD"),
		"spend.threadUSD": settings.get("policy.spend.threadUSD"),
		"spend.dayUSD": settings.get("policy.spend.dayUSD"),
		"models.allowed": settings.get("policy.models.allowed"),
	};
}

/** Whether a thread's egress list would widen the service's: both are non-empty and the thread names a destination the service does not. */
export function egressWidens(global: readonly string[], thread: readonly string[]): boolean {
	return global.length > 0 && thread.some(entry => !global.includes(entry));
}

/** The smaller non-zero cap; 0 is none. */
function tighterCap(global: number, thread: number | undefined): number {
	if (thread === undefined || thread <= 0) return global;
	return global <= 0 ? thread : Math.min(global, thread);
}

/**
 * The effective policy of `global` tightened by `thread`:
 * - `bash.patterns`: when the thread has a deny or prompt rule, the service's deny and prompt rules (their order), then
 *   the thread's, then the service's allow rules; the thread's allow rules are dropped, they could only loosen. A thread
 *   without such a rule leaves the service's rules as they are.
 * - `tools.approval`: per tool the stricter of the two (`allow` < `prompt` < `deny`); a thread's `allow` for a tool the
 *   service does not name is dropped, it would override what the shipped configuration says.
 * - `fetch`, `webSearch`, `browser`: allowed only when both allow.
 * - `egress`: the service's list is the thread's when it is empty, and the thread's list is the service's when it is empty;
 *   with both non-empty it is the thread's entries the service's list holds ({@link egressWidens} is what create refuses),
 *   or, when the service's list changed since the create and holds none of them, the service's list.
 * - `spend.*`: the smaller non-zero cap.
 * - `models.allowed`: every non-empty list applies.
 */
export function tightenPolicy(global: PolicyValues, thread: ThreadPolicy): EffectivePolicy {
	const threadRules = (thread["bash.patterns"] ?? []).filter(rule => rule.approval !== "allow");
	const globalRules = global["bash.patterns"];
	const bashPatterns =
		threadRules.length === 0
			? globalRules
			: [
					...globalRules.filter(rule => rule.approval !== "allow"),
					...threadRules,
					...globalRules.filter(rule => rule.approval === "allow"),
				];

	const toolApproval: Record<string, Approval> = { ...global["tools.approval"] };
	for (const [tool, approval] of Object.entries(thread["tools.approval"] ?? {})) {
		const current = toolApproval[tool];
		if (current === undefined ? approval !== "allow" : STRICTNESS[approval] > STRICTNESS[current]) toolApproval[tool] = approval;
	}

	const threadEgress = thread.egress ?? [];
	let egress = global.egress;
	if (threadEgress.length > 0) {
		if (egress.length === 0) {
			egress = threadEgress;
		} else {
			const kept = threadEgress.filter(entry => egress.includes(entry));
			if (kept.length > 0) egress = kept;
		}
	}

	return {
		bashPatterns,
		toolApproval,
		fetch: global.fetch && (thread.fetch ?? true),
		webSearch: global.webSearch && (thread.webSearch ?? true),
		browser: global.browser && (thread.browser ?? true),
		egress,
		spend: {
			turn: tighterCap(global["spend.turnUSD"], thread["spend.turnUSD"]),
			thread: tighterCap(global["spend.threadUSD"], thread["spend.threadUSD"]),
			day: tighterCap(global["spend.dayUSD"], thread["spend.dayUSD"]),
		},
		modelsAllowed: [global["models.allowed"], thread["models.allowed"] ?? []].filter(list => list.length > 0),
	};
}

/** The policy of a thread now: the settings as they are, tightened by the thread's own. */
export function effectivePolicy(settings: Pick<Settings, "get">, thread: ThreadPolicy): EffectivePolicy {
	return tightenPolicy(globalPolicy(settings), thread);
}
