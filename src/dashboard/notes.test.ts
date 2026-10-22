import { describe, expect, test } from "bun:test";
import { type Inline, parseInline, parseMarkdown } from "./client/app/notes";

const text = (value: string): Inline => ({ kind: "text", text: value });

describe("inline", () => {
	test("bold, code, em and links", () => {
		expect(parseInline("**Title.** use `x --y` or *this* [docs](https://example.com/a?b=1#c)")).toEqual([
			{ kind: "strong", children: [text("Title.")] },
			text(" use "),
			{ kind: "code", text: "x --y" },
			text(" or "),
			{ kind: "em", children: [text("this")] },
			text(" "),
			{ kind: "link", href: "https://example.com/a?b=1#c", children: [text("docs")] },
		]);
	});

	test("code is literal: markers inside it stay", () => {
		expect(parseInline("`**not bold** [a](b)`")).toEqual([{ kind: "code", text: "**not bold** [a](b)" }]);
	});

	test("bold may hold code", () => {
		expect(parseInline("**the `x` op**")).toEqual([{ kind: "strong", children: [text("the "), { kind: "code", text: "x" }, text(" op")] }]);
	});

	test("a javascript: link is text, never an anchor", () => {
		const nodes = parseInline("[click](javascript:alert(1)) and [x](javascript:void)");
		expect(JSON.stringify(nodes)).not.toContain("link");
		expect(nodes.every(node => node.kind === "text")).toBe(true);
		expect(nodes.map(node => (node.kind === "text" ? node.text : "")).join("")).toContain("click");
	});

	test("relative, data: and other schemes are text too", () => {
		for (const url of ["docs/configuration.md#docker", "data:text/html,hi", "ftp://example.com/x", "//evil.example/x", "HTTP:foo"]) {
			expect(parseInline(`[label](${url})`).some(node => node.kind === "link")).toBe(false);
		}
	});

	test("a lone or spaced asterisk is plain text", () => {
		expect(parseInline("globs like acme/* and repo/* here")).toEqual([text("globs like acme/* and repo/* here")]);
		expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
	});

	test("an unclosed marker is plain text; escapes drop the backslash", () => {
		expect(parseInline("**open `tick [x](")).toEqual([text("**open `tick [x](")]);
		expect(parseInline("\\*not em\\*")).toEqual([text("*not em*")]);
	});

	test("HTML stays text", () => {
		expect(parseInline("<script>alert(1)</script>")).toEqual([text("<script>alert(1)</script>")]);
	});
});

describe("blocks", () => {
	test("bullets, with continuation lines, a heading and a paragraph", () => {
		const blocks = parseMarkdown(
			["## 0.5.1", "", "Intro line", "second line.", "", "- **One.** first", "  continued here", "- Two", "lazy continuation", "* Three", "", "Done."].join("\n"),
		);
		expect(blocks).toEqual([
			{ kind: "heading", level: 2, children: [text("0.5.1")] },
			{ kind: "paragraph", children: [text("Intro line second line.")] },
			{
				kind: "list",
				items: [
					[{ kind: "strong", children: [text("One.")] }, text(" first continued here")],
					[text("Two lazy continuation")],
					[text("Three")],
				],
			},
			{ kind: "paragraph", children: [text("Done.")] },
		]);
	});

	test("a blank line then an indented line stays in the item; an unindented one ends the list", () => {
		expect(parseMarkdown("- a\n\n  more\n- b\n\nafter")).toEqual([
			{ kind: "list", items: [[text("a more")], [text("b")]] },
			{ kind: "paragraph", children: [text("after")] },
		]);
	});

	test("### headings and a bold line that starts with an asterisk", () => {
		expect(parseMarkdown("### Fixed\n**Bold** start")).toEqual([
			{ kind: "heading", level: 3, children: [text("Fixed")] },
			{ kind: "paragraph", children: [{ kind: "strong", children: [text("Bold")] }, text(" start")] },
		]);
	});

	test("a fenced block keeps its lines verbatim", () => {
		expect(parseMarkdown("before\n```sh\n- not a bullet\n\n**raw**\n```\nafter")).toEqual([
			{ kind: "paragraph", children: [text("before")] },
			{ kind: "code", text: "- not a bullet\n\n**raw**" },
			{ kind: "paragraph", children: [text("after")] },
		]);
	});

	test("empty and CRLF input", () => {
		expect(parseMarkdown("")).toEqual([]);
		expect(parseMarkdown("\n\n")).toEqual([]);
		expect(parseMarkdown("- a\r\n- b\r\n")).toEqual([{ kind: "list", items: [[text("a")], [text("b")]] }]);
	});
});
