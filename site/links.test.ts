import { describe, expect, test } from "bun:test";
import { checkLinks, hrefFor, type LinkRecord, type RepoView, resolveHref } from "./links";

const PAGES = new Set(["docs/install.md", "docs/updating.md", "CHANGELOG.md"]);
const repo: RepoView = {
  isPage: source => PAGES.has(source),
  kind: path => (path === "AGENTS.md" || path === "README.md" ? "file" : path === "src/runner" ? "dir" : undefined),
};
const BLOB = "https://github.com/TechDufus/omp-cloud/blob/main/";

describe("resolveHref + hrefFor", () => {
  test("a page link is relative to the page that holds it", () => {
    const target = resolveHref("docs/install.md", "updating.md#vibemon-is-pinned", repo);
    expect(target).toEqual({ kind: "page", source: "docs/updating.md", anchor: "vibemon-is-pinned" });
    expect(hrefFor("docs/install/", "docs/install.md", target)).toBe("../../docs/updating/#vibemon-is-pinned");
  });

  test("a same-page anchor stays a fragment", () => {
    const target = resolveHref("docs/install.md", "#requirements", repo);
    expect(hrefFor("docs/install/", "docs/install.md", target)).toBe("#requirements");
  });

  test("a repository file becomes a GitHub blob link and a directory a tree link", () => {
    expect(hrefFor("docs/development/", "docs/development.md", resolveHref("docs/development.md", "../AGENTS.md", repo))).toBe(
      `${BLOB}AGENTS.md`,
    );
    expect(hrefFor("docs/development/", "docs/development.md", resolveHref("docs/development.md", "../src/runner", repo))).toBe(
      "https://github.com/TechDufus/omp-cloud/tree/main/src/runner",
    );
  });

  test("README.md is the landing page, or GitHub's README when an anchor is given", () => {
    const home = resolveHref("docs/install.md", "../README.md", repo);
    expect(hrefFor("docs/install/", "docs/install.md", home)).toBe("../../");
    expect(resolveHref("docs/install.md", "../README.md#documentation", repo)).toEqual({
      kind: "url",
      url: `${BLOB}README.md#documentation`,
    });
  });

  test("README links into docs resolve from the landing page", () => {
    expect(hrefFor("", "README.md", resolveHref("README.md", "docs/install.md#x", repo))).toBe("./docs/install/#x");
    expect(resolveHref("README.md", "#quickstart", repo)).toEqual({ kind: "url", url: `${BLOB}README.md#quickstart` });
  });

  test("absolute URLs pass through", () => {
    expect(resolveHref("docs/install.md", "https://example.com/a?b#c", repo)).toEqual({
      kind: "url",
      url: "https://example.com/a?b#c",
    });
    expect(resolveHref("docs/install.md", "mailto:a@b.c", repo).kind).toBe("url");
  });

  test("paths that leave the repository or do not exist are broken", () => {
    expect(resolveHref("docs/install.md", "../../etc/passwd", repo)).toEqual({ kind: "broken", reason: "leaves the repository" });
    expect(resolveHref("docs/install.md", "missing.md", repo)).toEqual({ kind: "broken", reason: "docs/missing.md does not exist" });
    expect(hrefFor("docs/install/", "docs/install.md", { kind: "broken", reason: "x" })).toBe("#");
  });

  test("a leading slash is repository-root relative", () => {
    expect(resolveHref("docs/install.md", "/CHANGELOG.md", repo)).toEqual({ kind: "page", source: "CHANGELOG.md" });
  });
});

describe("checkLinks", () => {
  const ids = new Map([["docs/api.md", new Set(["agent-policy"])]]);
  const record = (href: string, anchor: string): LinkRecord => ({
    from: "docs/api.md",
    href,
    target: { kind: "page", source: "docs/api.md", anchor },
  });

  test("returns nothing when every anchor resolves", () => {
    expect(checkLinks([record("#agent-policy", "agent-policy")], ids)).toEqual([]);
  });

  test("names a missing heading", () => {
    expect(checkLinks([record("#nope", "nope")], ids)).toEqual(["docs/api.md: #nope: no heading #nope in docs/api.md"]);
  });

  test("names a broken target", () => {
    const broken: LinkRecord = { from: "docs/api.md", href: "x.md", target: { kind: "broken", reason: "docs/x.md does not exist" } };
    expect(checkLinks([broken], ids)).toEqual(["docs/api.md: x.md: docs/x.md does not exist"]);
  });
});
