/**
 * The settings store: typed run-time settings over the `settings` table. A key at its registry default
 * has no row, so `source` is `stored` exactly when the value differs from the default. Values are cached and refreshed
 * after every `apply`/`importYaml`; the service is the only writer, in one process, so the cache never goes stale.
 */
import { isRecord } from "../guards";
import type { Store } from "../store";
import type { SettingChange, SettingsAuditAction } from "../store/types";
import {
	isSettingKey,
	REGISTRY,
	SETTING_DEFS,
	type SettingDef,
	SettingError,
	type SettingKey,
	type SettingType,
	type SettingValues,
} from "./registry";

export { SettingError, type SettingKey, type SettingValues } from "./registry";

/** The largest settings file `importYaml` takes. */
export const MAX_IMPORT_BYTES = 64 * 1024;

/** One setting as `GET /api/v1/settings` serves it. */
export interface SettingView {
	key: string;
	type: SettingType;
	value: unknown;
	default: unknown;
	source: "default" | "stored";
	doc: string;
	/** The allowed values of an enum; empty otherwise. */
	choices: string[];
	/** When and by whom the stored value was set; empty at the default. */
	updatedAt: string;
	updatedBy: string;
}

/** One audit row as served: `old` and `new` are JSON values, or null for the default. */
export interface SettingsAuditView {
	seq: number;
	at: string;
	actor: string;
	action: SettingsAuditAction;
	key: string;
	old: unknown;
	new: unknown;
}

/** Called after a commit that changed `changed`, in registry order. */
export type SettingsListener = (changed: readonly SettingKey[]) => void;

interface CachedSetting {
	value: unknown;
	updatedAt: string;
	updatedBy: string;
}

/** The value of `key` as it is shown: a setting that may hold a secret goes through its own `redact`. */
function shown(key: string, value: unknown): unknown {
	if (!isSettingKey(key)) return value;
	const def: SettingDef<unknown> = REGISTRY[key];
	return def.redact === undefined ? value : def.redact(value);
}

/** What the audit log keeps of a stored JSON value of `key`: undefined for a key with nothing to hide. */
function auditMapper(key: SettingKey): SettingChange["audit"] {
	const def: SettingDef<unknown> = REGISTRY[key];
	if (def.redact === undefined) return undefined;
	return (json) => (json === null ? null : JSON.stringify(shown(key, JSON.parse(json))));
}

/**
 * Flattens a nested settings document into `out` by walking until a path is a registry key. A path that neither is a
 * key nor leads to one, or a key given twice (flat and nested), is a {@link SettingError}.
 */
function flatten(node: Record<string, unknown>, prefix: string, out: Record<string, unknown>): void {
	for (const [name, value] of Object.entries(node)) {
		const path = prefix === "" ? name : `${prefix}.${name}`;
		if (isSettingKey(path)) {
			if (Object.hasOwn(out, path)) throw new SettingError(`${path} is set twice`);
			out[path] = value;
		} else if (SETTING_DEFS.some((def) => def.key.startsWith(`${path}.`))) {
			if (!isRecord(value)) throw new SettingError(`${path} must be a mapping of settings`);
			flatten(value, path, out);
		} else {
			throw new SettingError(`unknown setting ${path}`);
		}
	}
}

export class Settings {
	readonly #store: Store;
	readonly #cache = new Map<string, CachedSetting>();
	readonly #listeners = new Set<SettingsListener>();

	private constructor(store: Store) {
		this.#store = store;
		this.#reload();
	}

	/** Reads the stored values. A stored key the registry no longer knows, or whose value its validator now refuses, is ignored with a warning (the default applies) and left in the table. */
	static load(store: Store): Settings {
		return new Settings(store);
	}

	/** The key's current value: the stored one, else the registry default. */
	get<K extends SettingKey>(key: K): SettingValues[K] {
		const cached = this.#cache.get(key);
		// Every cached value came out of the key's own `parse`, so it has the key's type.
		return cached === undefined ? REGISTRY[key].default : (cached.value as SettingValues[K]);
	}

	/** Every registered setting in registry order. */
	list(): SettingView[] {
		return SETTING_DEFS.map((def) => {
			const cached = this.#cache.get(def.key);
			return {
				key: def.key,
				type: def.type,
				value: shown(def.key, cached === undefined ? def.default : cached.value),
				default: shown(def.key, def.default),
				source: cached === undefined ? "default" : "stored",
				doc: def.doc,
				choices: [...(def.choices ?? [])],
				updatedAt: cached?.updatedAt ?? "",
				updatedBy: cached?.updatedBy ?? "",
			};
		});
	}

	/**
	 * Sets keys to values, `null` resetting a key to its default. Atomic: an unknown key or a value its validator refuses
	 * throws {@link SettingError} and applies nothing. A value equal to the default is stored as a reset, and a change
	 * that leaves a key as it was writes nothing. Returns the keys that changed.
	 */
	apply(changes: Record<string, unknown>, actor: string): SettingKey[] {
		return this.#commit(changes, actor, "set");
	}

	/** The audit log, newest first: up to `limit` entries with a seq below `before` (0: from the newest). `next` is the `before` of the following page, 0 at the end. */
	audit(options: { before: number; limit: number }): { entries: SettingsAuditView[]; next: number } {
		const rows = this.#store.settingsAudit(options.before, options.limit + 1);
		const page = rows.slice(0, options.limit);
		const entries = page.map((row) => ({
			seq: row.seq,
			at: row.at,
			actor: row.actor,
			action: row.action,
			key: row.key,
			old: row.oldValue === null ? null : shown(row.key, JSON.parse(row.oldValue)),
			new: row.newValue === null ? null : shown(row.key, JSON.parse(row.newValue)),
		}));
		return { entries, next: rows.length > options.limit ? (page[page.length - 1]?.seq ?? 0) : 0 };
	}

	/** The stored values as nested YAML (`git: {push: ask}`); `{}` when everything is at its default. */
	exportYaml(): string {
		const tree: Record<string, unknown> = {};
		for (const def of SETTING_DEFS) {
			const cached = this.#cache.get(def.key);
			if (cached === undefined || shown(def.key, cached.value) !== cached.value) continue;
			const segments = def.key.split(".");
			const leaf = segments.pop() ?? def.key;
			let node = tree;
			for (const segment of segments) {
				const next = node[segment];
				if (isRecord(next)) {
					node = next;
				} else {
					const created: Record<string, unknown> = {};
					node[segment] = created;
					node = created;
				}
			}
			node[leaf] = cached.value;
		}
		return Bun.YAML.stringify(tree, null, 2);
	}

	/**
	 * Applies a YAML settings document, nested or flat or both. `replace` resets every key the document does not name,
	 * `merge` leaves them. Atomic like {@link apply}, audited as `import`; throws {@link SettingError} for a file over
	 * {@link MAX_IMPORT_BYTES}, invalid YAML, an unknown key or an invalid value. Returns the keys that changed.
	 */
	importYaml(text: string, actor: string, mode: "replace" | "merge"): SettingKey[] {
		if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw new SettingError(`the settings file is larger than ${MAX_IMPORT_BYTES} bytes`);
		let document: unknown;
		try {
			document = Bun.YAML.parse(text);
		} catch (error) {
			throw new SettingError(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
		}
		const named: Record<string, unknown> = {};
		if (document !== null && document !== undefined) {
			if (!isRecord(document)) throw new SettingError("the settings file must be a mapping of settings");
			flatten(document, "", named);
		}
		const changes: Record<string, unknown> = mode === "replace" ? Object.fromEntries(SETTING_DEFS.map((def) => [def.key, null])) : {};
		return this.#commit(Object.assign(changes, named), actor, "import");
	}

	/** Calls `listener` after every commit that changed a key. Returns the unsubscribe function. */
	subscribe(listener: SettingsListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#commit(changes: Record<string, unknown>, actor: string, action: "set" | "import"): SettingKey[] {
		const prepared = Object.entries(changes).map(([key, raw]): SettingChange => {
			if (!isSettingKey(key)) throw new SettingError(`unknown setting ${key}`);
			const audit = auditMapper(key);
			if (raw === null) return { key, value: null, audit };
			const def = REGISTRY[key];
			const value = JSON.stringify(def.parse(raw));
			return { key, value: value === JSON.stringify(def.default) ? null : value, audit };
		});
		const changed = this.#store.applySettings(prepared, actor, action).filter(isSettingKey);
		if (changed.length === 0) return changed;
		this.#reload();
		for (const listener of [...this.#listeners]) {
			try {
				listener(changed);
			} catch (error) {
				console.error("settings listener failed:", error);
			}
		}
		return changed;
	}

	#reload(): void {
		this.#cache.clear();
		for (const row of this.#store.settingRows()) {
			try {
				if (!isSettingKey(row.key)) throw new Error("no such setting");
				const value = REGISTRY[row.key].parse(JSON.parse(row.value));
				this.#cache.set(row.key, { value, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
			} catch (error) {
				console.warn(`omp-cloud: ignoring the stored setting ${row.key}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}
