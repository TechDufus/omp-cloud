import { BookOpen, Menu, Monitor, Moon, ScrollText, Search, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOCS_INDEX_URL, REPO_URL, rootPrefix, STORAGE_THEME } from "../config";
import { CloudMark, GitHubMark } from "./icons";

/** Applies the saved theme before first paint, so there is no flash. client/theme.ts owns the same storage key and values. */
const PRE_PAINT = `(function(){try{var stored=localStorage.getItem(${JSON.stringify(STORAGE_THEME)});var pref=stored==="light"||stored==="dark"||stored==="system"?stored:"system";var system=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var theme=pref==="system"?system:pref;var root=document.documentElement;root.dataset.theme=theme;root.dataset.themePref=pref;root.style.colorScheme=theme}catch(e){}})();`;

export interface DocumentProps {
  /** The page's URL relative to the site root: "" or a directory ending in "/". */
  url: string;
  title: string;
  description: string;
  siteUrl: string;
  /** Site-root-relative asset paths, e.g. "assets/site-abc.css". */
  css: string;
  js: string;
  /** Only the 404 page sets it: it is served from any path. */
  baseHref?: string;
  kind: "landing" | "docs";
  topbar: ReactNode;
  children: ReactNode;
}

export function Document({
  url,
  title,
  description,
  siteUrl,
  css,
  js,
  baseHref,
  kind,
  topbar,
  children,
}: DocumentProps) {
  const prefix = rootPrefix(url);
  const canonical = `${siteUrl}/${url}`;
  return (
    <html lang="en" data-theme="dark" data-root={prefix}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {baseHref !== undefined && <base href={baseHref} />}
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta name="color-scheme" content="dark light" />
        <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#f2f2f3" media="(prefers-color-scheme: light)" />
        <link rel="canonical" href={canonical} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="omp-cloud" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={`${siteUrl}/og.png`} />
        <meta property="og:image:width" content="1280" />
        <meta property="og:image:height" content="640" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="icon" type="image/svg+xml" href={`${prefix}favicon.svg`} />
        <link rel="icon" type="image/png" sizes="32x32" href={`${prefix}favicon-32.png`} />
        <link rel="apple-touch-icon" href={`${prefix}apple-touch-icon.png`} />
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT }} />
        <link rel="stylesheet" href={prefix + css} />
      </head>
      <body data-kind={kind}>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        {topbar}
        {children}
        <SearchDialog />
        <script type="module" src={prefix + js} />
      </body>
    </html>
  );
}

/** Mirrors the dashboard's Shell topbar; client/topbar.ts, theme.ts, search.ts, stars.ts and sidebar.ts drive it. */
export function Topbar({ prefix, kind }: { prefix: string; kind: "landing" | "docs" }) {
  return (
    <header className="topbar" data-scrolled="false">
      {kind === "docs" && (
        <button
          type="button"
          className="btn topbar-menu"
          data-variant="ghost"
          data-icon="true"
          aria-label="Open navigation"
        >
          <Menu size={16} />
        </button>
      )}
      <a className="topbar-brand" href={prefix}>
        <CloudMark id="topbar" size={22} />
        <span>omp</span>
        <span className="topbar-slash">/</span>
        <span className="topbar-title">cloud</span>
      </a>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        {kind === "landing" && (
          <span className="topbar-hide-narrow topbar-links">
            <a className="btn" data-variant="ghost" data-size="sm" href={prefix + DOCS_INDEX_URL}>
              <BookOpen size={14} />
              Docs
            </a>
            <a className="btn" data-variant="ghost" data-size="sm" href={`${prefix}changelog/`}>
              <ScrollText size={14} />
              Changelog
            </a>
          </span>
        )}
        <button type="button" className="btn" data-size="sm" data-search-open>
          <Search size={14} />
          <span className="topbar-hide-narrow">Search docs</span>
          <span className="kbd">/</span>
        </button>
        <a className="btn" data-size="sm" href={REPO_URL}>
          <GitHubMark size={14} />
          <span className="topbar-hide-narrow">GitHub</span>
          <span data-stars hidden />
        </a>
        <button
          type="button"
          className="btn"
          data-variant="ghost"
          data-icon="true"
          data-theme-toggle
          aria-label="System theme (click to switch)"
          title="System theme (click to switch)"
        >
          <Monitor size={16} className="theme-icon" data-pref="system" />
          <Sun size={16} className="theme-icon" data-pref="light" />
          <Moon size={16} className="theme-icon" data-pref="dark" />
        </button>
      </div>
    </header>
  );
}

/** Rendered hidden on every page; client/search.ts fills the results from search.json. */
export function SearchDialog() {
  return (
    <div className="modal-overlay search-overlay" data-search hidden>
      <div className="modal search-modal" role="dialog" aria-modal="true" aria-label="Search documentation">
        <div className="search">
          <Search size={14} />
          <input
            className="input"
            type="search"
            placeholder="Search the docs"
            autoComplete="off"
            spellCheck={false}
            aria-controls="search-results"
          />
        </div>
        <ul id="search-results" className="search-results" role="listbox" />
        <div className="modal-footer micro">↑↓ move · ↵ open · esc close</div>
      </div>
    </div>
  );
}

export function renderPage(element: ReactNode): string {
  return "<!doctype html>" + renderToStaticMarkup(element);
}
