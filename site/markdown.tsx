import { Check, Copy } from "lucide-react";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImageRegistry } from "./assets";
import { rootPrefix } from "./config";
import { hrefFor, type LinkRecord, type RepoView, resolveHref, resolveRepoPath } from "./links";
import { renderDiagram } from "./mermaid";

const BREADCRUMB = "[README](../README.md) · [Documentation index](../README.md#documentation)";

/** Every docs page opens with a breadcrumb back to the README; the site has its own navigation. */
export function stripBreadcrumb(md: string): string {
  const lines = md.split("\n");
  const at = lines.indexOf(BREADCRUMB);
  if (at === -1) return md;
  lines.splice(at, lines[at + 1] === "" ? 2 : 1);
  return lines.join("\n");
}

export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** The first sentence of the first prose block after the H1, as plain text capped at 200 characters. */
export function describe(md: string): string {
  const blocks: string[][] = [[]];
  let fenced = false;
  for (const line of stripBreadcrumb(md).split("\n")) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "") blocks.push([]);
    else blocks[blocks.length - 1]?.push(line);
  }
  const block = blocks.find(lines => lines.length > 0 && !/^(?:#|```|~~~|\||[-*+] |\d+\. |<)/.test(lines[0] ?? ""));
  if (!block) return "";
  const markdown = block.map(line => line.replace(/^>\s?/, "")).join("\n");
  const text = Bun.markdown
    .render(markdown, { paragraph: children => children })
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  if (sentence.length <= 200) return sentence;
  const cut = sentence.slice(0, 200);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1))}…`;
}

export interface Heading {
  level: 2 | 3;
  id: string;
  text: string;
}

export interface RenderContext {
  /** Repo-relative source of the Markdown, e.g. `docs/install.md`. */
  source: string;
  /** Page-relative URL the HTML is served at, e.g. `docs/install/`. */
  url: string;
  repo: RepoView;
  /** Every link rendered is appended here for the build's link check. */
  links: LinkRecord[];
  images: ImageRegistry;
}

export interface RenderedDoc {
  title: string;
  description: string;
  body: ReactNode;
  headings: Heading[];
  ids: Set<string>;
}

interface Collected {
  headings: Heading[];
  ids: Set<string>;
  /** Overrides run when React renders the tree, so records are kept only during renderDoc's own pass, not the page's later one. */
  recording: boolean;
}

function CodeBlock({ language, text }: { language: string | undefined; text: string }) {
  return (
    <div className="code">
      <div className="code-head">
        <span className="code-lang">{language ?? "text"}</span>
        <button type="button" className="btn" data-variant="ghost" data-size="sm" data-copy>
          <Copy className="copy-idle" size={14} aria-hidden="true" />
          <Check className="copy-done" size={14} aria-hidden="true" />
          <span className="copy-label">Copy</span>
        </button>
      </div>
      <pre className="code-block">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function overridesFor(ctx: RenderContext, collected: Collected | undefined): Bun.markdown.ComponentOverrides {
  const record = (level: number, id: string, children: ReactNode) => {
    if (!collected?.recording) return;
    collected.ids.add(id);
    if ((level === 2 || level === 3)) collected.headings.push({ level, id, text: textOf(children) });
  };
  const anchored = (Tag: "h2" | "h3", level: 2 | 3) =>
    function AnchoredHeading({ id = "", children }: { id?: string; children?: ReactNode }) {
      record(level, id, children);
      return (
        <Tag id={id} className="doc-heading">
          {children}
          <a className="heading-anchor" href={`#${id}`} aria-label={`Link to ${textOf(children)}`}>
            #
          </a>
        </Tag>
      );
    };
  const plain = (Tag: "h4" | "h5" | "h6", level: 4 | 5 | 6) =>
    function PlainHeading({ id = "", children }: { id?: string; children?: ReactNode }) {
      record(level, id, children);
      return <Tag id={id}>{children}</Tag>;
    };

  return {
    h1: ({ id = "", children }: { id?: string; children?: ReactNode }) => {
      record(1, id, children);
      return (
        <h1 id={id} className="doc-title">
          {children}
        </h1>
      );
    },
    h2: anchored("h2", 2),
    h3: anchored("h3", 3),
    h4: plain("h4", 4),
    h5: plain("h5", 5),
    h6: plain("h6", 6),
    a: ({ href, children }: { href: string; children?: ReactNode }) => {
      const target = resolveHref(ctx.source, href, ctx.repo);
      if (collected?.recording !== false) ctx.links.push({ from: ctx.source, href, target });
      return <a href={hrefFor(ctx.url, ctx.source, target)}>{children}</a>;
    },
    img: ({ src, alt }: { src: string; alt?: string }) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return <img src={src} alt={alt} loading="lazy" decoding="async" />;
      const resolved = resolveRepoPath(ctx.source, src);
      if ("reason" in resolved) throw new Error(`site: ${ctx.source}: image ${src} ${resolved.reason}`);
      const image = ctx.images.add(resolved.path);
      return (
        <img
          src={rootPrefix(ctx.url) + image.file}
          alt={alt}
          width={image.width}
          height={image.height}
          loading="lazy"
          decoding="async"
        />
      );
    },
    pre: ({ language, children }: { language?: string; children?: ReactNode }) => {
      const text = textOf(children).replace(/\n$/, "");
      if (language === "mermaid") {
        return <figure className="diagram" dangerouslySetInnerHTML={{ __html: renderDiagram(text, ctx.source) }} />;
      }
      return <CodeBlock language={language} text={text} />;
    },
    table: ({ children }: { children?: ReactNode }) => (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    ),
    blockquote: ({ children }: { children?: ReactNode }) => <blockquote className="callout">{children}</blockquote>,
    html: () => {
      throw new Error(`site: ${ctx.source} contains a raw HTML block, which the site does not render`);
    },
  };
}

const PARSER_OPTIONS = { headings: { ids: true }, autolinks: true } as const;

export function renderDoc(markdown: string, ctx: RenderContext): RenderedDoc {
  const md = stripBreadcrumb(markdown);
  const title = /^# (.+)$/m.exec(md)?.[1]?.replace(/`/g, "");
  if (title === undefined) throw new Error(`site: ${ctx.source} has no "# Title" line`);
  const collected: Collected = { headings: [], ids: new Set(), recording: true };
  const body = Bun.markdown.react(md, overridesFor(ctx, collected), PARSER_OPTIONS);
  renderToStaticMarkup(body);
  collected.recording = false;
  return { title, description: describe(markdown), body, headings: collected.headings, ids: collected.ids };
}

/** Markdown from README.md for the landing page: same overrides, no heading collection. */
export function renderFragment(markdown: string, ctx: RenderContext): ReactNode {
  return Bun.markdown.react(markdown, overridesFor(ctx, undefined), PARSER_OPTIONS);
}
