// MIT License. Copyright (c) 2025-2026 Can Bölük, 2026 Stencil Labs, Inc. Vendored from @oh-my-pi/omp-stats; see kit/LICENSE.

/**
 * Every number on the dashboard uses one fixed locale. Labels, percents
 * (`toFixed`), durations and dates are English, so following the browser
 * locale mixed conventions (e.g. `1,4 Mr` beside `97.0%` on a tr-TR browser).
 */
const NUMBER_LOCALE = "en-US";

export function formatInteger(value: number): string {
	return value.toLocaleString(NUMBER_LOCALE);
}

export function formatCompact(value: number): string {
	return value.toLocaleString(NUMBER_LOCALE, { notation: "compact" });
}

export function formatCost(value: number, digits?: number): string {
	if (value === 0) return "$0";
	const fractionDigits = digits !== undefined ? digits : value > 0 && value < 0.01 ? 4 : 2;
	return `$${value.toLocaleString(NUMBER_LOCALE, {
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
	})}`;
}

export function formatPercent(value: number, digits = 1): string {
	return `${(value * 100).toFixed(digits)}%`;
}

export function formatDurationMs(value: number | null, digits?: number): string {
	if (value === null) return "-";
	const sec = value / 1000;
	const d = digits !== undefined ? digits : sec < 1 ? 2 : 1;
	return `${sec.toFixed(d)}s`;
}

/** Wall-clock length: seconds below a minute, then `17m 41s` / `2h 05m`. */
export function formatElapsed(ms: number): string {
	if (ms < 60_000) return formatDurationMs(ms);
	const totalMin = Math.floor(ms / 60_000);
	if (totalMin < 60) return `${totalMin}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
	return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, "0")}m`;
}

export function formatBytes(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
	return `${value} B`;
}
