/** The longest device name, in characters (code points). */
export const MAX_DEVICE_NAME_CHARS = 64;
const MAX_PLATFORM_CHARS = 32;

const DEVICE_NAME = /^[\p{L}\p{N} ._-]+$/u;
const PLATFORM = /^[A-Za-z0-9._-]+$/;

/** The trimmed name when it is 1 to 64 characters of letters, digits, spaces, `.`, `_` and `-`; else null. */
export function parseDeviceName(raw: string): string | null {
	const name = raw.trim();
	const length = [...name].length;
	return length >= 1 && length <= MAX_DEVICE_NAME_CHARS && DEVICE_NAME.test(name) ? name : null;
}

/** `platform` when it is 1 to 32 characters of `[A-Za-z0-9._-]`; else null. */
export function parsePlatform(raw: string): string | null {
	return raw.length >= 1 && raw.length <= MAX_PLATFORM_CHARS && PLATFORM.test(raw) ? raw : null;
}

/** `base-<n>`, with `base` cut so that the result stays within the name limit. */
export function suffixedName(base: string, n: number): string {
	const suffix = `-${n}`;
	return [...base].slice(0, MAX_DEVICE_NAME_CHARS - suffix.length).join("") + suffix;
}
