import { describe, expect, test } from "bun:test";
import { sectionsOf } from "./search";

describe("sectionsOf", () => {
  test("splits a page into its intro and one entry per section, without the breadcrumb or diagram source", () => {
    const md =
      "# Install\n\n[README](../README.md) · [Documentation index](../README.md#documentation)\n\nIntro text.\n\n## Requirements\n\nNeeds `/dev/kvm`.\n\n```mermaid\ngraph LR; A-->B\n```\n";
    expect(sectionsOf("Install", "docs/install/", md)).toEqual([
      { p: "Install", h: "", u: "docs/install/", x: "Intro text." },
      { p: "Install", h: "Requirements", u: "docs/install/#requirements", x: "Needs /dev/kvm." },
    ]);
  });

  test("folds H4 headings into the section and keeps H3 sections separate", () => {
    const md = "# T\n\n## A\n\nalpha\n\n### B\n\nbeta\n\n#### C\n\ngamma\n";
    expect(sectionsOf("T", "t/", md)).toEqual([
      { p: "T", h: "A", u: "t/#a", x: "alpha" },
      { p: "T", h: "B", u: "t/#b", x: "beta C gamma" },
    ]);
  });
});
