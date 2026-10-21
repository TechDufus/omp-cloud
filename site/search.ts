import { stripBreadcrumb } from "./markdown";

export interface SearchEntry {
  /** Page title. */
  p: string;
  /** Section heading; empty for a page's intro. */
  h: string;
  /** Page-relative URL, with `#id` for a section. */
  u: string;
  /** Section text, whitespace-collapsed. */
  x: string;
}

const MARK = "\u0001";
const SEP = "\u0002";

/** One entry per page intro and per H2/H3 section; deeper headings fold into the section they sit in. */
export function sectionsOf(title: string, url: string, markdown: string): SearchEntry[] {
  const rendered = Bun.markdown.render(
    stripBreadcrumb(markdown),
    {
      heading: (children, { level, id }) => `${MARK}${level}${SEP}${id ?? ""}${SEP}${children}${MARK}`,
      paragraph: children => `${children}\n`,
      listItem: children => `${children}\n`,
      blockquote: children => `${children}\n`,
      tr: children => `${children}\n`,
      th: children => `${children} `,
      td: children => `${children} `,
      code: (children, meta) => (meta?.language === "mermaid" ? "" : `${children}\n`),
      html: () => "",
    },
    { headings: { ids: true } },
  );
  const entries: SearchEntry[] = [];
  let current: SearchEntry = { p: title, h: "", u: url, x: "" };
  const parts = rendered.split(MARK);
  // Even parts are text, odd parts are heading markers: `level SEP id SEP text`.
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      current.x += part;
      return;
    }
    const [level, id = "", ...text] = part.split(SEP);
    const heading = text.join(SEP);
    if (level === "2" || level === "3") {
      entries.push(current);
      current = { p: title, h: heading, u: `${url}#${id}`, x: "" };
    } else if (level !== "1") {
      current.x += `${heading}\n`;
    }
  });
  entries.push(current);
  const result: SearchEntry[] = [];
  for (const entry of entries) {
    const x = entry.x.replace(/\s+/g, " ").trim();
    if (entry.h !== "" || x !== "") result.push({ ...entry, x });
  }
  return result;
}
