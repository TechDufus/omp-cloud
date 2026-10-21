interface SearchEntry {
  p: string;
  h: string;
  u: string;
  x: string;
}

const MAX_RESULTS = 12;
const SNIPPET_CHARS = 140;

function isEntry(value: unknown): value is SearchEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "p" in value &&
    "h" in value &&
    "u" in value &&
    "x" in value &&
    typeof value.p === "string" &&
    typeof value.h === "string" &&
    typeof value.u === "string" &&
    typeof value.x === "string"
  );
}

async function loadEntries(root: string): Promise<SearchEntry[]> {
  const response = await fetch(new URL(root + "search.json", document.baseURI));
  if (!response.ok) throw new Error(`search.json: ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("search.json: not an array");
  return body.filter(isEntry);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function score(entry: SearchEntry, terms: string[]): number {
  const h = entry.h.toLowerCase();
  const p = entry.p.toLowerCase();
  const x = entry.x.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (h.includes(term)) total += 8;
    if (p.includes(term)) total += 4;
    if (x.includes(term)) total += 1;
  }
  const first = terms[0];
  if (first !== undefined && h.startsWith(first)) total += 2;
  return total;
}

/** Match every term somewhere in the entry; rank by where they match; ties keep index order. */
function search(entries: SearchEntry[], terms: string[]): SearchEntry[] {
  const ranked: { entry: SearchEntry; score: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const haystack = `${entry.h} ${entry.p} ${entry.x}`.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return;
    ranked.push({ entry, score: score(entry, terms), index });
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, MAX_RESULTS).map((item) => item.entry);
}

/** About 140 characters of `text` around the first term, with every term wrapped in <mark>. Escaping happens per fragment, after matching, so entities are never split. */
function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const start = at === -1 ? 0 : Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  const slice = text.slice(start, end);
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const html = slice
    .split(pattern)
    .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join("");
  return (start > 0 ? "…" : "") + html + (end < text.length ? "…" : "");
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches("input, textarea, select") || target.isContentEditable;
}

export function initSearch(): void {
  const overlay = document.querySelector<HTMLElement>("[data-search]");
  const input = overlay?.querySelector<HTMLInputElement>("input");
  const list = document.getElementById("search-results");
  if (!overlay || !input || !list) return;

  const root = document.documentElement.dataset.root ?? "./";
  let entries: Promise<SearchEntry[]> | undefined;
  let selected = -1;
  let generation = 0;

  function options(): HTMLElement[] {
    return Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
  }

  function select(index: number): void {
    const items = options();
    if (items.length === 0) return;
    selected = (index + items.length) % items.length;
    items.forEach((item, i) => item.setAttribute("aria-selected", String(i === selected)));
    items[selected]?.scrollIntoView({ block: "nearest" });
  }

  function message(text: string): void {
    selected = -1;
    const item = document.createElement("li");
    item.className = "search-empty muted";
    item.textContent = text;
    list?.replaceChildren(item);
  }

  function render(found: SearchEntry[], terms: string[]): void {
    const items = found.map((entry) => {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      const link = document.createElement("a");
      link.href = root + entry.u;
      const title = document.createElement("span");
      title.className = "search-title";
      title.textContent = entry.h ? `${entry.p} › ${entry.h}` : entry.p;
      const text = document.createElement("span");
      text.className = "search-snippet";
      text.innerHTML = snippet(entry.x, terms);
      link.append(title, text);
      item.append(link);
      return item;
    });
    list?.replaceChildren(...items);
    select(0);
  }

  async function update(): Promise<void> {
    const query = input?.value.trim() ?? "";
    const mine = ++generation;
    if (query === "") {
      message("Type to search the docs");
      return;
    }
    entries ??= loadEntries(root);
    let loaded: SearchEntry[];
    try {
      loaded = await entries;
    } catch {
      entries = undefined;
      if (mine === generation) message("Search is unavailable");
      return;
    }
    if (mine !== generation) return;
    const terms = query.toLowerCase().split(/\s+/);
    const found = search(loaded, terms);
    if (found.length === 0) message(`No results for "${query}"`);
    else render(found, terms);
  }

  function open(): void {
    if (!overlay) return;
    overlay.hidden = false;
    input?.focus();
    input?.select();
    void update();
  }

  function close(): void {
    if (overlay) overlay.hidden = true;
  }

  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-search-open]")) open();
  });

  document.addEventListener("keydown", (event) => {
    const isOpen = !overlay.hidden;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (isOpen) close();
      else open();
      return;
    }
    if (!isOpen) {
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditable(event.target)) {
        event.preventDefault();
        open();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      select(selected + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      select(selected - 1);
    } else if (event.key === "Enter") {
      const link = options()[selected]?.querySelector("a");
      if (link) {
        event.preventDefault();
        link.click();
      }
    }
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
    // A result on the current page only changes the hash, so the dialog has to close itself.
    else if (event.target instanceof Element && event.target.closest("#search-results a")) close();
  });
  input.addEventListener("input", () => void update());
}
