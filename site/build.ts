import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { createElement, type ReactNode } from "react";
import { createImages } from "./assets";
import { DOCS_INDEX_URL, pageUrl, rootPrefix, SITE_URL } from "./config";
import { checkLinks, createRepoView, type LinkRecord } from "./links";
import { renderDoc, type Heading } from "./markdown";
import { NAV, validateNav } from "./nav";
import { Document, renderPage, Topbar } from "./pages/Document";
import { DocPage, DocsIndex, NotFound, type PageInfo } from "./pages/DocPage";
import { Landing } from "./pages/Landing";
import { type SearchEntry, sectionsOf } from "./search";

export interface BuildOptions {
  /** Repository root. */
  root: string;
  /** Directory the site is written to; it is deleted first. */
  out: string;
  /** Origin (plus any subpath) the site is served from, without a trailing slash. */
  siteUrl: string;
}

const CSS_BANNER =
  "/*! UI kit: @oh-my-pi/omp-stats, MIT License, Copyright (c) 2025-2026 Can Bölük, Copyright (c) 2026 Stencil Labs, Inc. (assets/LICENSE-omp-stats-kit.txt). Fonts: Inter, JetBrains Mono, SIL OFL 1.1 (assets/LICENSE-inter.txt, assets/LICENSE-jetbrains-mono.txt). */\n";

const BUNDLE_NAMING = "assets/[name]-[hash].[ext]";

/** Bun 1.4.3 inlines the fontsource woff2 files into the CSS as data URLs whatever `loader` says. */
const INLINE_FONT = /url\((["']?)data:font\/woff2;base64,([A-Za-z0-9+/=]+)\1\)/g;

const TITLES = {
  landing: "omp-cloud: self-hosted cloud agents for omp",
  docsIndex: "Documentation · omp-cloud",
  changelog: "Changelog · omp-cloud",
  notFound: "Not found · omp-cloud",
};

function writeOut(out: string, path: string, content: string | Uint8Array): void {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function copyOut(from: string, out: string, path: string): void {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(from, file);
}

/** Bundle the client script and the stylesheet into `<out>/assets/`; returns their site-root-relative paths. */
async function bundleAssets(root: string, out: string): Promise<{ css: string; js: string }> {
  const result = await Bun.build({
    entrypoints: [join(root, "site/client/main.ts"), join(root, "site/styles/site.css")],
    target: "browser",
    minify: true,
    naming: { entry: BUNDLE_NAMING, chunk: BUNDLE_NAMING, asset: BUNDLE_NAMING },
    loader: { ".woff2": "file" },
    throw: false,
  });
  if (!result.success) throw new Error(`site: bundling failed: ${result.logs.map(log => log.message).join("\n")}`);

  let css: string | undefined;
  let js: string | undefined;
  for (const output of result.outputs) {
    const path = output.path.replace(/^\.\//, "");
    if (output.loader === "css") {
      css = path;
      const fonts = new Set<string>();
      const text = (await output.text()).replace(INLINE_FONT, (_match, _quote: string, base64: string) => {
        const bytes = Buffer.from(base64, "base64");
        const name = `font-${Bun.hash(bytes).toString(36)}.woff2`;
        if (!fonts.has(name)) {
          fonts.add(name);
          writeOut(out, join(dirname(path), name), bytes);
        }
        return `url(${name})`;
      });
      writeOut(out, path, CSS_BANNER + text);
    } else {
      if (output.kind === "entry-point") js = path;
      writeOut(out, path, new Uint8Array(await output.arrayBuffer()));
    }
  }
  if (css === undefined || js === undefined) throw new Error("site: bundling produced no stylesheet or no script");
  return { css, js };
}

export async function buildSite({ root, out, siteUrl }: BuildOptions): Promise<{ pages: number; images: number; entries: number }> {
  const target = resolve(out);
  const base = resolve(root);
  if (target === base || base.startsWith(target + sep) || target === join(base, "docs") || target === join(base, "site")) {
    throw new Error(`site: refusing to clean ${out}`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const pkg: { version: string; description: string } = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  const readme = readFileSync(join(base, "README.md"), "utf8");
  const docFiles = readdirSync(join(base, "docs"))
    .filter(name => name.endsWith(".md"))
    .sort()
    .map(name => `docs/${name}`);
  validateNav(NAV, docFiles);

  const { css, js } = await bundleAssets(base, target);

  const sources = NAV.flatMap(group => group.items.map(item => item.source));
  const repo = createRepoView(base, sources);
  const images = createImages(base);
  const links: LinkRecord[] = [];
  const ids = new Map<string, ReadonlySet<string>>([["README.md", new Set<string>()]]);
  const entries: SearchEntry[] = [];
  const info = new Map<string, PageInfo>();
  const rendered = new Map<string, { body: ReactNode; headings: Heading[] }>();

  for (const group of NAV) {
    for (const { source } of group.items) {
      const markdown = readFileSync(join(base, source), "utf8");
      const url = pageUrl(source);
      const doc = renderDoc(markdown, { source, url, repo, links, images });
      ids.set(source, doc.ids);
      entries.push(...sectionsOf(doc.title, url, markdown));
      rendered.set(source, { body: doc.body, headings: doc.headings });
      info.set(source, { source, url, title: doc.title, description: doc.description, group: group.heading });
    }
  }

  const documentFor = (url: string, kind: "landing" | "docs", title: string, description: string, children: ReactNode, baseHref?: string): string =>
    renderPage(
      createElement(Document, {
        url,
        title,
        description,
        siteUrl,
        css,
        js,
        baseHref,
        kind,
        topbar: createElement(Topbar, { prefix: rootPrefix(url), kind }),
        children,
      }),
    );

  const files = new Map<string, string>();
  files.set("index.html", documentFor("", "landing", TITLES.landing, pkg.description, createElement(Landing, { readme, version: pkg.version, repo, links, images })));
  files.set("docs/index.html", documentFor(DOCS_INDEX_URL, "docs", TITLES.docsIndex, pkg.description, createElement(DocsIndex, { pages: info, version: pkg.version })));
  sources.forEach((source, i) => {
    const page = info.get(source);
    const content = rendered.get(source);
    if (!page || !content) throw new Error(`site: ${source} was not rendered`);
    const prev = i > 0 ? info.get(sources[i - 1] ?? "") : undefined;
    const next = info.get(sources[i + 1] ?? "");
    const title = source === "CHANGELOG.md" ? TITLES.changelog : `${page.title} · omp-cloud docs`;
    const body = createElement(DocPage, { page: { ...page, ...content }, pages: info, prev, next, version: pkg.version });
    files.set(`${page.url}index.html`, documentFor(page.url, "docs", title, page.description, body));
  });
  files.set("404.html", documentFor("", "landing", TITLES.notFound, pkg.description, createElement(NotFound), `${siteUrl}/`));

  const problems = checkLinks(links, ids);
  if (problems.length > 0) throw new Error(`site: broken links\n  ${problems.join("\n  ")}`);

  for (const [path, html] of files) writeOut(target, path, html);
  writeOut(target, "search.json", JSON.stringify(entries));
  const locations = [`${siteUrl}/`, `${siteUrl}/${DOCS_INDEX_URL}`, ...sources.map(source => `${siteUrl}/${pageUrl(source)}`)];
  writeOut(
    target,
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations.map(loc => `  <url><loc>${loc.replaceAll("&", "&amp;")}</loc></url>`).join("\n")}\n</urlset>\n`,
  );
  writeOut(target, "robots.txt", `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);

  images.copyAll(target);
  const brand = join(base, "docs/assets/brand");
  copyOut(join(brand, "social-preview.png"), target, "og.png");
  copyOut(join(brand, "logo-mark.svg"), target, "favicon.svg");
  copyOut(join(brand, "favicon-32.png"), target, "favicon-32.png");
  copyOut(join(brand, "logo-mark.png"), target, "apple-touch-icon.png");
  copyOut(join(base, "src/dashboard/client/kit/LICENSE"), target, "assets/LICENSE-omp-stats-kit.txt");
  copyOut(join(base, "node_modules/@fontsource-variable/inter/LICENSE"), target, "assets/LICENSE-inter.txt");
  copyOut(join(base, "node_modules/@fontsource-variable/jetbrains-mono/LICENSE"), target, "assets/LICENSE-jetbrains-mono.txt");
  // The installer at the site root, so `curl -fsSL <site>/install.sh | sh` works: the same file as raw.githubusercontent.com serves from main.
  copyOut(join(base, "install.sh"), target, "install.sh");

  return { pages: 2 + sources.length, images: readdirSync(join(target, "assets", "img")).length, entries: entries.length };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: { out: { type: "string" }, "site-url": { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    const root = resolve(import.meta.dir, "..");
    const out = resolve(values.out ?? join(root, "site/dist"));
    const siteUrl = (values["site-url"] ?? SITE_URL).replace(/\/+$/, "");
    const { pages, images, entries } = await buildSite({ root, out, siteUrl });
    console.log(`site: ${pages} pages, ${images} images, ${entries} search entries → ${out}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
