import { isRecord } from "../guards";

/** The `provider/id` of every model the keyless `direct` providers declare (`models: [{id}]` in the omp provider object), sorted. */
export function directModelIds(direct: Record<string, Record<string, unknown>>): string[] {
	const ids = new Set<string>();
	for (const [provider, config] of Object.entries(direct)) {
		const declared = config.models;
		if (!Array.isArray(declared)) continue;
		for (const model of declared) {
			if (isRecord(model) && typeof model.id === "string" && model.id !== "") ids.add(`${provider}/${model.id}`);
		}
	}
	return [...ids].sort();
}
