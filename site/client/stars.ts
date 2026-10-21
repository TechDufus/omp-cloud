import { REPO_API_URL, STORAGE_STARS } from "../config";

const FRESH_MS = 3_600_000;

interface StarCache {
  n: number;
  t: number;
}

function isStarCache(value: unknown): value is StarCache {
  return (
    typeof value === "object" &&
    value !== null &&
    "n" in value &&
    "t" in value &&
    typeof value.n === "number" &&
    typeof value.t === "number"
  );
}

function readCache(): StarCache | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_STARS);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isStarCache(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(n: number): void {
  try {
    localStorage.setItem(STORAGE_STARS, JSON.stringify({ n, t: Date.now() } satisfies StarCache));
  } catch {
    // Storage can be unavailable; the next page load fetches again.
  }
}

function formatStars(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "") + "k";
}

async function fetchStars(): Promise<number | undefined> {
  const response = await fetch(REPO_API_URL, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) return undefined;
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("stargazers_count" in body)) return undefined;
  const count = body.stargazers_count;
  return typeof count === "number" ? count : undefined;
}

export function initStars(): void {
  const targets = document.querySelectorAll<HTMLElement>("[data-stars]");
  if (targets.length === 0) return;

  function show(n: number): void {
    const text = formatStars(n);
    for (const target of targets) {
      target.textContent = text;
      target.hidden = false;
    }
  }

  const cached = readCache();
  if (cached && Date.now() - cached.t < FRESH_MS) {
    show(cached.n);
    return;
  }

  // A private repository (404), a rate limit (403) or a network failure leaves the markup as rendered.
  fetchStars().then(
    (n) => {
      if (n === undefined) return;
      writeCache(n);
      show(n);
    },
    () => undefined,
  );
}
