import { BookOpen, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { EDIT_URL, REPO_URL, rootPrefix } from "../config";
import type { Heading } from "../markdown";
import { NAV } from "../nav";
import { GitHubMark } from "./icons";

export interface PageInfo {
  /** Repo-relative Markdown source, e.g. "docs/install.md". */
  source: string;
  /** Page URL relative to the site root. */
  url: string;
  title: string;
  description: string;
  /** The NAV group heading. */
  group: string;
}

export interface DocPageProps {
  page: PageInfo & { body: ReactNode; headings: Heading[] };
  pages: ReadonlyMap<string, PageInfo>;
  prev?: PageInfo;
  next?: PageInfo;
  version: string;
}

interface ShellProps {
  url: string;
  /** The source of the active sidebar row; undefined marks the "Overview" row. */
  active: string | undefined;
  pages: ReadonlyMap<string, PageInfo>;
  version: string;
  children: ReactNode;
}

/** The docs chrome: ambient glow, drawer scrim, sidebar and the inset panel. The build supplies the topbar via Document. */
function Shell({ url, active, pages, version, children }: ShellProps) {
  const prefix = rootPrefix(url);
  return (
    <>
      <div className="shell-ambient" />
      <div className="drawer-scrim" hidden role="presentation" />
      <nav className="sidebar" data-open="false" aria-label="Documentation">
        <div className="nav-group">
          <a
            className="nav-row"
            href={`${prefix}docs/`}
            data-active={active === undefined ? "true" : "false"}
            aria-current={active === undefined ? "page" : undefined}
          >
            <BookOpen size={15} />
            <span className="nav-row-label">Overview</span>
          </a>
        </div>
        {NAV.map(group => (
          <div key={group.heading} className="nav-group">
            <div className="nav-heading">{group.heading}</div>
            {group.items.map(item => {
              const info = infoOf(pages, item.source);
              const isActive = item.source === active;
              return (
                <a
                  key={item.source}
                  className="nav-row"
                  href={prefix + info.url}
                  data-active={isActive ? "true" : "false"}
                  aria-current={isActive ? "page" : undefined}
                >
                  <item.icon size={15} />
                  <span className="nav-row-label">{info.title}</span>
                </a>
              );
            })}
          </div>
        ))}
        <div className="sidebar-foot micro">
          <span>v{version} · MIT</span>
          <a href={REPO_URL}>
            <GitHubMark size={12} />
            GitHub
          </a>
        </div>
      </nav>
      <main id="content" className="shell-panel">
        <div className="shell-content">{children}</div>
      </main>
    </>
  );
}

function infoOf(pages: ReadonlyMap<string, PageInfo>, source: string): PageInfo {
  const info = pages.get(source);
  if (!info) throw new Error(`site: no page info for ${source} (listed in site/nav.ts)`);
  return info;
}

export function DocPage({ page, pages, prev, next, version }: DocPageProps) {
  const prefix = rootPrefix(page.url);
  const toc = page.headings.length >= 2;
  return (
    <Shell url={page.url} active={page.source} pages={pages} version={version}>
      <div className="doc" data-toc={toc ? "true" : "false"}>
        <article className="prose">
          <div className="doc-eyebrow micro">{page.group}</div>
          {page.body}
          <footer className="doc-footer">
            {(prev || next) && (
              <nav className="doc-pager" aria-label="Pager">
                {prev && (
                  <a className="card" data-dir="prev" href={prefix + prev.url} rel="prev">
                    <span className="micro">Previous</span>
                    <span className="doc-pager-title">{prev.title}</span>
                  </a>
                )}
                {next && (
                  <a className="card" data-dir="next" href={prefix + next.url} rel="next">
                    <span className="micro">Next</span>
                    <span className="doc-pager-title">{next.title}</span>
                  </a>
                )}
              </nav>
            )}
            <a className="btn" data-variant="ghost" data-size="sm" href={EDIT_URL + page.source}>
              <Pencil size={13} />
              Edit this page on GitHub
            </a>
          </footer>
        </article>
        {toc && (
          <aside className="toc">
            <div className="micro">On this page</div>
            {page.headings.map(heading => (
              <a key={heading.id} className="toc-link" data-level={heading.level} href={`#${heading.id}`}>
                {heading.text}
              </a>
            ))}
          </aside>
        )}
      </div>
    </Shell>
  );
}

/** The page at docs/: one card per page, grouped like the sidebar. */
export function DocsIndex({ pages, version }: { pages: ReadonlyMap<string, PageInfo>; version: string }) {
  return (
    <Shell url="docs/" active={undefined} pages={pages} version={version}>
      <div className="doc" data-toc="false">
        <article className="prose doc-index">
          <h1 className="doc-title">Documentation</h1>
          <p className="page-description">
            Install, use and run omp-cloud. These pages are the Markdown files in the repository's docs/ directory.
          </p>
          {NAV.map(group => (
            <section key={group.heading} className="doc-index-group">
              <div className="section-label">{group.heading}</div>
              <div className="feature-grid">
                {group.items.map(item => {
                  const info = infoOf(pages, item.source);
                  return (
                    <a key={item.source} className="card" href={rootPrefix("docs/") + info.url}>
                      <div className="card-header">
                        <item.icon size={15} />
                        <div className="card-title">{info.title}</div>
                      </div>
                      <div className="card-body muted">{info.description}</div>
                    </a>
                  );
                })}
              </div>
            </section>
          ))}
        </article>
      </div>
    </Shell>
  );
}

/** Served as 404.html from any path: Document's baseHref makes the relative links resolve against the site root. */
export function NotFound() {
  return (
    <>
      <div className="shell-ambient" />
      <main id="content" className="not-found">
        <div className="card">
          <div className="card-body">
            <h1 className="doc-title">Page not found</h1>
            <p className="muted">This page does not exist or has moved.</p>
            <div className="not-found-actions">
              <a className="btn" data-variant="accent" href="./">
                Home
              </a>
              <a className="btn" href="docs/">
                Documentation
              </a>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
