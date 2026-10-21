import { ApiError } from "./errors";

/** The decimal integer query parameter `name` within `min..max`, or `fallback` when absent. Throws 400 naming the parameter. */
export function intParam(url: URL, name: string, min: number, max: number, fallback: number): number {
	const raw = url.searchParams.get(name);
	if (raw === null) return fallback;
	const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, `${name} must be an integer from ${min} to ${max}`);
	return value;
}
