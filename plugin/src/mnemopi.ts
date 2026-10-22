import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isRecord } from "./guards";
import { sessionOverlays } from "./overlays";
import type { PiHost } from "./types";

/** `omp`'s `sanitizeBankName` (mnemopi/config.ts): runs of characters outside `[A-Za-z0-9_-]` become `-`, edge dashes go, the result is clamped. */
function sanitizeBankName(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized ? limitBankName(sanitized) : undefined;
}

/** `omp`'s `limitBankName`: names over 64 characters keep a prefix and gain a hash. */
function limitBankName(name: string): string {
	if (name.length <= 64) return name;
	const hash = Bun.hash(name).toString(36);
	const prefixLength = Math.max(1, 63 - hash.length);
	const prefix = name.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

/**
 * The per-project mnemopi bank omp derives for a session in `cwd`: a verbatim port of `projectBank` and `projectBankSegment`
 * (omp's mnemopi/config.ts), which an extension cannot import. `configured` is the `mnemopi.bank` setting. The
 * `plugin/test/mnemopi.test.ts` parity test compares it with omp's own `computeMnemopiBankScope`, so an omp upgrade that
 * changes the derivation fails there.
 */
export function projectBankName(cwd: string, configured: string | undefined): string {
	const projectRoot = resolve(cwd || ".");
	const project = sanitizeBankName(basename(projectRoot)) ?? "default";
	const segment = limitBankName(`${project}-${Bun.hash(projectRoot).toString(36)}`);
	const base = sanitizeBankName(configured);
	return limitBankName(base ? `${base}-${segment}` : segment);
}

/** The session's memory settings that decide whether and where cloud memories merge. */
export interface MemorySettings {
	/** `memory.backend`; `off` when unset. */
	backend: string;
	/** `mnemopi.scoping`; `per-project` when unset. */
	scoping: string;
	/** `mnemopi.bank`; undefined when unset. */
	bank: string | undefined;
	/** `mnemopi.dbPath`; undefined when unset or blank. */
	dbPath: string | undefined;
}

/** The value of the dotted setting `key` in one settings layer, written nested (`memory: {backend}`) or as a dotted top-level key. */
function layerValue(layer: Record<string, unknown>, key: string): unknown {
	if (Object.hasOwn(layer, key)) return layer[key];
	let current: unknown = layer;
	for (const segment of key.split(".")) {
		if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
		current = current[segment];
	}
	return current;
}

async function overlayLayer(file: string): Promise<Record<string, unknown>> {
	try {
		const doc: unknown = Bun.YAML.parse(await readFile(file, "utf8"));
		return isRecord(doc) ? doc : {};
	} catch {
		return {};
	}
}

/**
 * Reads the memory settings the way omp layers them: the global layer, the project layer, then each `--config` overlay in
 * order, later layers winning. `Settings` has no generic key getter, so the raw layers are read; an uninitialized settings
 * proxy (it throws) leaves only the overlays that could be found.
 */
export async function readMemorySettings(pi: Pick<PiHost, "pi">, env: Record<string, string | undefined>): Promise<MemorySettings> {
	const layers: Record<string, unknown>[] = [];
	for (const read of [() => pi.pi.settings.getGlobalSettings(), () => pi.pi.settings.getProjectSettings()]) {
		try {
			layers.push(read());
		} catch {
			// settings not initialized: nothing of this layer
		}
	}
	for (const file of sessionOverlays(pi, { env })) layers.push(await overlayLayer(file));
	const pick = (key: string): string | undefined => {
		let found: string | undefined;
		for (const layer of layers) {
			const value = layerValue(layer, key);
			if (typeof value === "string") found = value;
		}
		return found;
	};
	const dbPath = pick("mnemopi.dbPath")?.trim();
	return {
		backend: pick("memory.backend") ?? "off",
		scoping: pick("mnemopi.scoping") ?? "per-project",
		bank: pick("mnemopi.bank"),
		dbPath: dbPath === "" ? undefined : dbPath,
	};
}

/** The cloud merges memories with the local mnemopi store only when it is the default one (a custom `mnemopi.dbPath` keeps the cloud out). */
export function usesDefaultMnemopi(settings: MemorySettings): boolean {
	return settings.backend === "mnemopi" && settings.dbPath === undefined;
}

/** The banks a handoff renames: this machine's project bank and the name omp derives for it in the VM. */
export interface MemoryBankPlan {
	from: string;
	to: string;
}

/**
 * The project bank rename of a handoff: undefined unless the session writes a per-project bank of the default store and the
 * service reported where the VM works (`vmWorkspace`, `""` when it did not).
 */
export function planMemoryBank(settings: MemorySettings, cwd: string, vmWorkspace: string): MemoryBankPlan | undefined {
	if (!usesDefaultMnemopi(settings) || vmWorkspace === "") return undefined;
	if (settings.scoping !== "per-project" && settings.scoping !== "per-project-tagged") return undefined;
	return { from: projectBankName(cwd, settings.bank), to: projectBankName(vmWorkspace, settings.bank) };
}
