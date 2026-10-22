/**
 * The secret values the service delivers to a thread's VM and how they are hidden. One rule for both uses: omp's
 * obfuscation list in the VM (`secrets.yml`) and the scrubbing of text the service itself posts elsewhere (a pull request).
 */
import type { ThreadSecrets } from "../store/types";

/** An env value shorter than this is not masked: it would garble ordinary text. */
export const MIN_MASKED_ENV_CHARS = 4;
/** The largest secret file whose content is masked. */
const MAX_MASKED_FILE_BYTES = 65536;

/** One delivered secret value and the label that stands for it in scrubbed text. */
export interface MaskEntry {
	/** `secret NAME` for an env variable, `secret file <path>` for a secret file. */
	label: string;
	value: string;
}

/** The content of a secret file as text to mask: the empty list for content that is empty, over 64 KiB or not valid UTF-8. */
function maskableContent(bytes: Buffer): string[] {
	if (bytes.length === 0 || bytes.length > MAX_MASKED_FILE_BYTES) return [];
	try {
		return [new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
	} catch {
		return [];
	}
}

/** The values to mask of a thread's delivered env (its own over the service's, already merged) and secret files (base64 content). */
export function maskEntries(env: Record<string, string>, files: ThreadSecrets["files"]): MaskEntry[] {
	return [
		...Object.entries(env)
			.filter(([, value]) => value.length >= MIN_MASKED_ENV_CHARS)
			.map(([name, value]) => ({ label: `secret ${name}`, value })),
		...files.flatMap(file =>
			maskableContent(Buffer.from(file.content, "base64")).map(value => ({ label: `secret file ${file.path}`, value })),
		),
	];
}

/** `text` with every entry's value replaced by `[<label>]`, longest values first so a value that contains another is replaced whole. */
export function scrubSecrets(text: string, entries: readonly MaskEntry[]): string {
	let out = text;
	for (const entry of [...entries].sort((a, b) => b.value.length - a.value.length)) {
		out = out.split(entry.value).join(`[${entry.label}]`);
	}
	return out;
}
