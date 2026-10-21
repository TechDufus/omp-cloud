import { describe, expect, test } from "bun:test";
import { firstCodeBlock, firstParagraph, leadList, readmeSection } from "./content";
import { type NavGroup, validateNav } from "./nav";

const README = [
  "# omp-cloud",
  "",
  "## What you get",
  "",
  "- **Hand off.** The repo goes to an agent,",
  "  wrapped onto a second line.",
  "- **It asks.** Questions come back.",
  "",
  "## How it works",
  "",
  "```mermaid",
  "graph LR",
  "  - **not an item** x",
  "```",
  "",
  "1. **Run.** The VM runs.",
  "2. **Return.** A branch returns.",
  "",
  "A trailing paragraph.",
  "",
  "## Quickstart",
  "",
  "### In omp",
  "",
  '<p align="center"></p>',
  "",
  "Prose caption here.",
  "",
  "```sh",
  "curl -fsSL https://example.com/install | sh",
  "```",
].join("\n");

describe("readmeSection", () => {
  test("returns only the body of the named section", () => {
    const section = readmeSection(README, "What you get", 2);
    expect(section).toContain("**Hand off.**");
    expect(section).not.toContain("How it works");
  });

  test("a level-2 section includes its level-3 subsections", () => {
    expect(readmeSection(README, "Quickstart", 2)).toContain("### In omp");
  });

  test("stops a level-3 section at the next heading and ignores headings inside fences", () => {
    expect(readmeSection("### A\n\n```sh\n# not a heading\n```\n\n### B\n\nx", "A", 3)).toBe("\n```sh\n# not a heading\n```\n");
  });

  test("throws the exact message for a missing section", () => {
    expect(() => readmeSection(README, "Nope", 2)).toThrow(
      'site: README.md has no "## Nope" section (the landing page reads it)',
    );
  });
});

describe("leadList", () => {
  test("parses bullets, joins wrapped lines and drops the lead's trailing period", () => {
    expect(leadList(readmeSection(README, "What you get", 2), "README.md ## What you get")).toEqual([
      { lead: "Hand off", body: "The repo goes to an agent, wrapped onto a second line." },
      { lead: "It asks", body: "Questions come back." },
    ]);
  });

  test("parses numbered items and skips fenced blocks and trailing paragraphs", () => {
    expect(leadList(readmeSection(README, "How it works", 2), "README.md ## How it works")).toEqual([
      { lead: "Run", body: "The VM runs." },
      { lead: "Return", body: "A branch returns." },
    ]);
  });

  test("throws on an item without a bold lead", () => {
    expect(() => leadList("- **Ok.** fine\n- plain item", "README.md ## X")).toThrow(
      "site: README.md ## X item 2 does not start with **Lead.**",
    );
  });

  test("throws when there are no items", () => {
    expect(() => leadList("just prose", "README.md ## X")).toThrow("site: README.md ## X has no list items");
  });
});

describe("firstParagraph and firstCodeBlock", () => {
  const section = readmeSection(README, "Quickstart", 2);

  test("firstParagraph skips HTML and headings", () => {
    expect(firstParagraph(section, "README.md ## Quickstart")).toBe("Prose caption here.");
  });

  test("firstParagraph throws when there is none", () => {
    expect(() => firstParagraph("# h\n\n- a\n", "README.md ## X")).toThrow("site: README.md ## X has no paragraph");
  });

  test("firstCodeBlock returns the trimmed command", () => {
    expect(firstCodeBlock(section, "sh", "README.md ## Quickstart")).toBe("curl -fsSL https://example.com/install | sh");
  });

  test("firstCodeBlock throws when the language is absent", () => {
    expect(() => firstCodeBlock(section, "json", "README.md ## Quickstart")).toThrow(
      "site: README.md ## Quickstart has no json code block",
    );
  });
});

describe("validateNav", () => {
  const nav: NavGroup[] = [{ heading: "Start", items: [{ source: "docs/install.md", icon: (() => null) as never }] }];

  test("passes when every doc is listed", () => {
    expect(() => validateNav(nav, ["docs/install.md"])).not.toThrow();
  });

  test("reports an unlisted doc with the exact message", () => {
    expect(() => validateNav(nav, ["docs/install.md", "docs/new.md"])).toThrow(
      "site/nav.ts does not list docs/new.md: add it to a group in NAV",
    );
  });

  test("reports unknown sources and duplicates", () => {
    const bad: NavGroup[] = [
      { heading: "A", items: [{ source: "docs/gone.md", icon: nav[0]!.items[0]!.icon }] },
      { heading: "B", items: [{ source: "docs/gone.md", icon: nav[0]!.items[0]!.icon }] },
    ];
    expect(() => validateNav(bad, [])).toThrow(
      "site/nav.ts lists docs/gone.md twice\nsite/nav.ts lists docs/gone.md, which is not a page source (docs/*.md or CHANGELOG.md)",
    );
  });
});
