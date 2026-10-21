import { STORAGE_THEME } from "../config";

type ThemePreference = "system" | "light" | "dark";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

// Same cycle and labels as NEXT_PREFERENCE / PREFERENCE_LABEL in the dashboard's Shell.tsx.
const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function initTheme(): void {
  const toggles = document.querySelectorAll<HTMLElement>("[data-theme-toggle]");
  if (toggles.length === 0) return;

  const html = document.documentElement;
  const media = window.matchMedia(DARK_SCHEME_QUERY);
  let preference: ThemePreference = isPreference(html.dataset.themePref) ? html.dataset.themePref : "system";

  function apply(): void {
    const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    html.dataset.theme = resolved;
    html.dataset.themePref = preference;
    html.style.colorScheme = resolved;
    const label = `${PREFERENCE_LABEL[preference]} (click to switch)`;
    for (const toggle of toggles) {
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
    }
  }

  apply();

  for (const toggle of toggles) {
    toggle.addEventListener("click", () => {
      preference = NEXT_PREFERENCE[preference];
      try {
        localStorage.setItem(STORAGE_THEME, preference);
      } catch {
        // Storage can be unavailable (private mode); the choice still applies to this page.
      }
      apply();
    });
  }

  // System changes only matter while following the system.
  media.addEventListener("change", () => {
    if (preference === "system") apply();
  });
}
