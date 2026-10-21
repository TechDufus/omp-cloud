// Adapted from omp-stats' useSystemTheme (MIT, Stencil Labs, Inc.; see ../kit/LICENSE): same store, omp-cloud's storage key.
import { useSyncExternalStore } from "react";

export type SystemTheme = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "omp-cloud-theme";
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function readStoredPreference(): ThemePreference {
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function getSystemTheme(): SystemTheme {
	return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

// One store shared by the toggle (writer) and every reader, so an explicit choice and the system default resolve in one place.
let preference: ThemePreference = readStoredPreference();
let resolved: SystemTheme = preference === "system" ? getSystemTheme() : preference;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function applyResolvedTheme(): void {
	resolved = preference === "system" ? getSystemTheme() : preference;
	document.documentElement.dataset.theme = resolved;
	document.documentElement.style.colorScheme = resolved;
}

applyResolvedTheme();
window.matchMedia(DARK_SCHEME_QUERY).addEventListener("change", () => {
	// System changes only matter while following the system.
	if (preference !== "system") return;
	applyResolvedTheme();
	emit();
});

export function setThemePreference(next: ThemePreference): void {
	preference = next;
	localStorage.setItem(STORAGE_KEY, next);
	applyResolvedTheme();
	emit();
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

/** The resolved theme: the system default or the explicit choice. */
export function useSystemTheme(): SystemTheme {
	return useSyncExternalStore(subscribe, () => resolved);
}

/** The theme preference and its setter (the toggle). */
export function useThemePreference(): { preference: ThemePreference; setPreference: (next: ThemePreference) => void } {
	const current = useSyncExternalStore(subscribe, () => preference);
	return { preference: current, setPreference: setThemePreference };
}
