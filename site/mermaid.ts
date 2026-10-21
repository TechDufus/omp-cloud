import { renderMermaidSVG } from "beautiful-mermaid";

const GOOGLE_FONTS_IMPORT = /@import url\('https:\/\/fonts\.googleapis\.com\/[^']*'\);\s*/g;

/**
 * A diagram as an inline SVG coloured by the kit's tokens, so it follows the theme.
 * `accent` is `--accent-b`, not `--accent`: the library sets its own `--accent` on the <svg>, so `var(--accent)` would reference itself.
 */
export function renderDiagram(source: string, from: string): string {
  try {
    return renderMermaidSVG(source, {
      bg: "var(--panel)",
      fg: "var(--ink-1)",
      line: "var(--ink-3)",
      accent: "var(--accent-b)",
      muted: "var(--ink-2)",
      surface: "var(--card)",
      border: "var(--line-3)",
      font: "Inter Variable",
      transparent: true,
    }).replace(GOOGLE_FONTS_IMPORT, "");
  } catch (error) {
    throw new Error(`site: ${from}: mermaid diagram failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
