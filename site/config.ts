// Shared by the build (Bun) and the client bundle (browser): no imports.

export const SITE_URL = "https://omp-cloud.techdufus.com";
export const REPO_URL = "https://github.com/TechDufus/omp-cloud";
export const BLOB_URL = REPO_URL + "/blob/main/";
export const TREE_URL = REPO_URL + "/tree/main/";
export const EDIT_URL = REPO_URL + "/edit/main/";
export const REPO_API_URL = "https://api.github.com/repos/TechDufus/omp-cloud";
/** The dashboard's key (src/dashboard/client/app/theme.ts), so a preference carries over on the same origin. */
export const STORAGE_THEME = "omp-cloud-theme";
export const STORAGE_STARS = "omp-cloud-site-stars";
export const DOCS_INDEX_URL = "docs/";

/** The page-relative URL of a page source: "" for the landing page, else a directory ending in "/". */
export function pageUrl(source: string): string {
  if (source === "README.md") return "";
  if (source === "CHANGELOG.md") return "changelog/";
  const doc = /^docs\/([^/]+)\.md$/.exec(source);
  if (doc) return `docs/${doc[1]}/`;
  throw new Error(`site: no URL for ${source}`);
}

export function depth(url: string): number {
  return url.split("/").length - 1;
}

/** The relative path from the page at `url` back to the site root. */
export function rootPrefix(url: string): string {
  const d = depth(url);
  return d === 0 ? "./" : "../".repeat(d);
}
