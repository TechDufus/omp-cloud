/**
 * The policy keys a thread may tighten and their value types. Types only, plus the key list: `store/types.ts` imports
 * from here, and the dashboard client compiles `store/types.ts`, so nothing here may reach the service's runtime modules.
 */
import type { SettingValues } from "./registry";

/** The policy settings a thread may tighten: the registry's `policy.<key>` keys without the prefix. */
export const POLICY_KEYS = [
	"bash.patterns",
	"tools.approval",
	"fetch",
	"webSearch",
	"browser",
	"egress",
	"spend.turnUSD",
	"spend.threadUSD",
	"spend.dayUSD",
	"models.allowed",
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];

/** The typed value of every policy key, as the service's settings hold them. */
export type PolicyValues = { [K in PolicyKey]: SettingValues[`policy.${K}`] };

/** What a create request asked for: any of the keys, each a value of its setting's type. Absent keys ask for nothing. */
export type ThreadPolicy = Partial<PolicyValues>;
