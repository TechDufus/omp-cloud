import { statSync } from "node:fs";
import { join, posix } from "node:path";
import { BLOB_URL, pageUrl, rootPrefix, TREE_URL } from "./config";

export type LinkTarget =
  | { kind: "page"; source: string; anchor?: string }
  | { kind: "url"; url: string }
  | { kind: "broken"; reason: string };

export interface LinkRecord {
  /** Repo-relative source of the page that holds the link. */
  from: string;
  /** The href as written in the Markdown. */
  href: string;
  target: LinkTarget;
}

export interface RepoView {
  /** True when `source` (repo-relative) is rendered as a page of the site. */
  isPage(source: string): boolean;
  kind(path: string): "file" | "dir" | undefined;
}

export function createRepoView(root: string, pageSources: readonly string[]): RepoView {
  const pages = new Set(pageSources);
  return {
    isPage: source => pages.has(source),
    kind(path) {
      try {
        const stat = statSync(join(root, path));
        return stat.isDirectory() ? "dir" : "file";
      } catch {
        return undefined;
      }
    },
  };
}

/** Resolve a path in a Markdown link or image to a normalized repo-relative path, or a reason it is outside the repository. */
export function resolveRepoPath(from: string, path: string): { path: string } | { reason: string } {
  const target = path.startsWith("/") ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(posix.dirname(from), path));
  if (target === ".." || target.startsWith("../")) return { reason: "leaves the repository" };
  return { path: target };
}

export function resolveHref(from: string, href: string, repo: RepoView): LinkTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "url", url: href };
  if (href.startsWith("#")) {
    const anchor = href.slice(1);
    return from === "README.md" ? { kind: "url", url: `${BLOB_URL}README.md#${anchor}` } : { kind: "page", source: from, anchor };
  }
  const hash = href.indexOf("#");
  const path = hash === -1 ? href : href.slice(0, hash);
  const anchor = hash === -1 ? undefined : href.slice(hash + 1);
  const resolved = resolveRepoPath(from, path);
  if ("reason" in resolved) return { kind: "broken", reason: resolved.reason };
  const target = resolved.path;
  if (repo.isPage(target)) return anchor ? { kind: "page", source: target, anchor } : { kind: "page", source: target };
  if (target === "README.md") {
    return anchor ? { kind: "url", url: `${BLOB_URL}README.md#${anchor}` } : { kind: "page", source: "README.md" };
  }
  const kind = repo.kind(target);
  if (kind === undefined) return { kind: "broken", reason: `${target} does not exist` };
  return { kind: "url", url: (kind === "dir" ? TREE_URL : BLOB_URL) + target + (anchor ? `#${anchor}` : "") };
}

export function hrefFor(fromUrl: string, fromSource: string, target: LinkTarget): string {
  if (target.kind === "url") return target.url;
  if (target.kind === "broken") return "#";
  if (target.source === fromSource && target.anchor) return `#${target.anchor}`;
  return rootPrefix(fromUrl) + pageUrl(target.source) + (target.anchor ? `#${target.anchor}` : "");
}

/** One line per problem: a broken target, or a page anchor that no heading of that page carries. */
export function checkLinks(records: readonly LinkRecord[], ids: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const problems: string[] = [];
  for (const { from, href, target } of records) {
    if (target.kind === "broken") problems.push(`${from}: ${href}: ${target.reason}`);
    else if (target.kind === "page" && target.anchor && !ids.get(target.source)?.has(target.anchor)) {
      problems.push(`${from}: ${href}: no heading #${target.anchor} in ${target.source}`);
    }
  }
  return problems;
}
