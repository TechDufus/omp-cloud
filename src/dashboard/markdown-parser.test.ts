import { describe, expect, test } from "bun:test";
import { type Block, type Inline, type ListItem, parseInline, parseMarkdown } from "./client/app/markdown-parser";

const text = (value: string): Inline => ({ kind: "text", text: value });
const para = (...children: Inline[]): Block => ({ kind: "paragraph", children });
const item = (...children: Block[]): ListItem => ({ checked: null, children });
const bullets = (...items: ListItem[]): Block => ({ kind: "list", ordered: false, start: 1, items });
const ordered = (start: number, ...items: ListItem[]): Block => ({ kind: "list", ordered: true, start, items });

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

	test("bold may hold code, and a closing marker inside code does not close it", () => {
		expect(parseInline("**the `x` op**")).toEqual([{ kind: "strong", children: [text("the "), { kind: "code", text: "x" }, text(" op")] }]);
		expect(parseInline("**a `**` b**")).toEqual([{ kind: "strong", children: [text("a "), { kind: "code", text: "**" }, text(" b")] }]);
	});

	test("a code span matches a backtick run of the same length and strips one padding space", () => {
		expect(parseInline("`` a`b `` and ` x `")).toEqual([{ kind: "code", text: "a`b" }, text(" and "), { kind: "code", text: "x" }]);
		expect(parseInline("a `` b")).toEqual([text("a `` b")]);
	});

	test("a javascript: link is text, never an anchor", () => {
		const nodes = parseInline("[click](javascript:alert(1)) and [x](javascript:void)");
		expect(JSON.stringify(nodes)).not.toContain("link");
		expect(nodes).toEqual([text("click and x")]);
		expect(parseInline("[x](javascript:alert(1))")).toEqual([text("x")]);
	});

	test("relative, data: and other schemes are text too", () => {
		for (const url of ["docs/configuration.md#docker", "data:text/html,hi", "ftp://example.com/x", "//evil.example/x", "HTTP:foo"]) {
			expect(parseInline(`[label](${url})`).some(node => node.kind === "link")).toBe(false);
		}
	});

	test("a link keeps balanced parentheses in its URL and ignores a title", () => {
		expect(parseInline('[w](https://en.wikipedia.org/wiki/Foo_(bar) "T") [v](https://a.example/b \'t\')')).toEqual([
			{ kind: "link", href: "https://en.wikipedia.org/wiki/Foo_(bar)", children: [text("w")] },
			text(" "),
			{ kind: "link", href: "https://a.example/b", children: [text("v")] },
		]);
	});

	test("a cut-off link and an unclosed bold stay text", () => {
		expect(parseInline("see [a](https://exa")).toEqual([text("see [a](https://exa")]);
		expect(parseInline("see [a](https://example.com")).toEqual([text("see [a](https://example.com")]);
		expect(parseInline("**bold but cut")).toEqual([text("**bold but cut")]);
		expect(parseInline("~~gone")).toEqual([text("~~gone")]);
	});

	test("a lone or spaced asterisk is plain text", () => {
		expect(parseInline("globs like acme/* and repo/* here")).toEqual([text("globs like acme/* and repo/* here")]);
		expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
	});

	test("an unclosed marker is plain text; escapes drop the backslash", () => {
		expect(parseInline("**open `tick [x](")).toEqual([text("**open `tick [x](")]);
		expect(parseInline("\\*not em\\*")).toEqual([text("*not em*")]);
		expect(parseInline("a\\\\b \\q")).toEqual([text("a\\b \\q")]);
	});

	test("HTML stays text", () => {
		expect(parseInline("<script>alert(1)</script>")).toEqual([text("<script>alert(1)</script>")]);
		expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([text("<img src=x onerror=alert(1)>")]);
	});

	test("<br> in any case and spelling is a break; nothing else is HTML", () => {
		expect(parseInline("a<br>b<BR/>c<br />d")).toEqual([text("a"), { kind: "break" }, text("b"), { kind: "break" }, text("c"), { kind: "break" }, text("d")]);
	});

	test("an image with an http(s) URL is an image node", () => {
		expect(parseInline("![x](https://evil.example/p.png)")).toEqual([{ kind: "image", href: "https://evil.example/p.png", alt: "x" }]);
		expect(parseInline("![a \\] b](http://a.example/p.png)")).toEqual([{ kind: "image", href: "http://a.example/p.png", alt: "a ] b" }]);
	});

	test("an image with any other URL is only its alt text, nothing when the alt is empty", () => {
		expect(parseInline("![x](javascript:alert(1))")).toEqual([text("x")]);
		expect(parseInline("![x](data:image/png;base64,AAAA)")).toEqual([text("x")]);
		expect(parseInline("![x](pics/a.png) and ![](javascript:1)")).toEqual([text("x and ")]);
	});

	test("a linked image is a link holding an image", () => {
		expect(parseInline("[![alt](https://a.example/i.png)](https://b.example/)")).toEqual([
			{ kind: "link", href: "https://b.example/", children: [{ kind: "image", href: "https://a.example/i.png", alt: "alt" }] },
		]);
	});

	test("an angle autolink needs an http(s) URL; bare URLs are text", () => {
		expect(parseInline("<https://example.com/a>")).toEqual([{ kind: "link", href: "https://example.com/a", children: [text("https://example.com/a")] }]);
		expect(parseInline("<javascript:alert(1)> <mailto:a@b.c> https://example.com/x")).toEqual([
			text("<javascript:alert(1)> <mailto:a@b.c> https://example.com/x"),
		]);
	});

	test("a link never nests inside a link", () => {
		expect(parseInline("[a [b](https://in.example/) c](https://out.example/)")).toEqual([
			{ kind: "link", href: "https://out.example/", children: [text("a b c")] },
		]);
	});

	test("_em_ and __strong__ need word boundaries; snake_case stays text", () => {
		expect(parseInline("_em_ and __strong__ here")).toEqual([
			{ kind: "em", children: [text("em")] },
			text(" and "),
			{ kind: "strong", children: [text("strong")] },
			text(" here"),
		]);
		expect(parseInline("snake_case_name and my__dunder__x")).toEqual([text("snake_case_name and my__dunder__x")]);
	});

	test("~~strike~~ needs non-blank edges", () => {
		expect(parseInline("a ~~gone~~ b")).toEqual([text("a "), { kind: "strike", children: [text("gone")] }, text(" b")]);
		expect(parseInline("~~ not ~~")).toEqual([text("~~ not ~~")]);
	});

	test("emphasis nests: em inside strong, strong inside em, and ***both***", () => {
		expect(parseInline("**a *b* c**")).toEqual([{ kind: "strong", children: [text("a "), { kind: "em", children: [text("b")] }, text(" c")] }]);
		expect(parseInline("*a **b** c*")).toEqual([{ kind: "em", children: [text("a "), { kind: "strong", children: [text("b")] }, text(" c")] }]);
		expect(parseInline("***x***")).toEqual([{ kind: "strong", children: [{ kind: "em", children: [text("x")] }] }]);
		expect(parseInline("**bold *em***")).toEqual([{ kind: "strong", children: [text("bold "), { kind: "em", children: [text("em")] }] }]);
	});
});

describe("blocks", () => {
	test("bullets, with continuation lines, a heading and a paragraph", () => {
		const blocks = parseMarkdown(
			["## 0.5.1", "", "Intro line", "second line.", "", "- **One.** first", "  continued here", "- Two", "lazy continuation", "* Three", "", "Done."].join("\n"),
		);
		expect(blocks).toEqual([
			{ kind: "heading", level: 2, children: [text("0.5.1")] },
			para(text("Intro line second line.")),
			bullets(
				item(para({ kind: "strong", children: [text("One.")] }, text(" first continued here"))),
				item(para(text("Two lazy continuation"))),
				item(para(text("Three"))),
			),
			para(text("Done.")),
		]);
	});

	test("a blank line then an indented line stays in the item as a second paragraph; an unindented one ends the list", () => {
		expect(parseMarkdown("- a\n\n  more\n- b\n\nafter")).toEqual([
			bullets(item(para(text("a")), para(text("more"))), item(para(text("b")))),
			para(text("after")),
		]);
	});

	test("### headings and a bold line that starts with an asterisk", () => {
		expect(parseMarkdown("### Fixed\n**Bold** start")).toEqual([
			{ kind: "heading", level: 3, children: [text("Fixed")] },
			para({ kind: "strong", children: [text("Bold")] }, text(" start")),
		]);
	});

	test("a fenced block keeps its lines verbatim", () => {
		expect(parseMarkdown("before\n```sh\n- not a bullet\n\n**raw**\n```\nafter")).toEqual([
			para(text("before")),
			{ kind: "code", text: "- not a bullet\n\n**raw**" },
			para(text("after")),
		]);
	});

	test("a trailing backslash (a hard break) joins the next line with a space; an escaped one stays", () => {
		expect(parseMarkdown("x\\\ny")).toEqual([para(text("x y"))]);
		expect(parseMarkdown("x\\\\\ny")).toEqual([para(text("x\\ y"))]);
		expect(parseMarkdown("last\\")).toEqual([para(text("last\\"))]);
	});

	test("empty and CRLF input", () => {
		expect(parseMarkdown("")).toEqual([]);
		expect(parseMarkdown("\n\n")).toEqual([]);
		expect(parseMarkdown("- a\r\n- b\r\n")).toEqual([bullets(item(para(text("a"))), item(para(text("b"))))]);
		expect(parseMarkdown("a\rb")).toEqual([para(text("a b"))]);
	});

	test("fences: tildes, a longer fence holds a shorter one, the opening indent is removed, an unclosed fence runs to the end", () => {
		expect(parseMarkdown("~~~\n```\nx\n```\n~~~")).toEqual([{ kind: "code", text: "```\nx\n```" }]);
		expect(parseMarkdown("````\n```\n````\nafter")).toEqual([{ kind: "code", text: "```" }, para(text("after"))]);
		expect(parseMarkdown("  ```\n  a\n    b\n c\n  ```")).toEqual([{ kind: "code", text: "a\n  b\nc" }]);
		expect(parseMarkdown("intro\n```ts\nconst a = 1;\n\n- not a list")).toEqual([para(text("intro")), { kind: "code", text: "const a = 1;\n\n- not a list" }]);
		expect(parseMarkdown("```")).toEqual([{ kind: "code", text: "" }]);
	});

	test("a backtick fence's info string may not hold a backtick", () => {
		expect(parseMarkdown("```a`b```")).toEqual([para({ kind: "code", text: "a`b" })]);
	});

	test("an unclosed fence inside a list item ends with the item", () => {
		expect(parseMarkdown("- run:\n  ```sh\n  make\n  all\n\nafter")).toEqual([
			bullets(item(para(text("run:")), { kind: "code", text: "make\nall" })),
			para(text("after")),
		]);
	});

	test("a rule is a rule, and wins over a bullet; under a paragraph `---` is a setext h2 and `===` an h1", () => {
		expect(parseMarkdown("a\n\n---\n\n* * *\n\n- - -\n\n___")).toEqual([para(text("a")), { kind: "rule" }, { kind: "rule" }, { kind: "rule" }, { kind: "rule" }]);
		expect(parseMarkdown("Title\n---\n\nBig\nline two\n===")).toEqual([
			{ kind: "heading", level: 2, children: [text("Title")] },
			{ kind: "heading", level: 1, children: [text("Big line two")] },
		]);
		expect(parseMarkdown("- a\n---\nb")).toEqual([bullets(item(para(text("a")))), { kind: "rule" }, para(text("b"))]);
	});

	test("lines indented four or more outside a list are paragraph text, not code", () => {
		expect(parseMarkdown("a\n\n        deep")).toEqual([para(text("a")), para(text("deep"))]);
		expect(parseMarkdown("a\n\n\tdeep")).toEqual([para(text("a")), para(text("deep"))]);
	});
});

describe("lists", () => {
	test("bullets nest under an ordered item at two and at three spaces", () => {
		for (const pad of ["  ", "   "]) {
			expect(parseMarkdown(`1. one\n${pad}- a\n${pad}- b\n2. two`)).toEqual([
				ordered(1, item(para(text("one")), bullets(item(para(text("a"))), item(para(text("b"))))), item(para(text("two")))),
			]);
		}
	});

	test("ordered items nest under a bullet, and three levels dedent back to the parent list", () => {
		expect(parseMarkdown("- a\n  1. b\n     - c\n  2. d\n- e")).toEqual([
			bullets(
				item(para(text("a")), ordered(1, item(para(text("b")), bullets(item(para(text("c"))))), item(para(text("d"))))),
				item(para(text("e"))),
			),
		]);
		expect(parseMarkdown("- a\n    - deep")).toEqual([bullets(item(para(text("a")), bullets(item(para(text("deep"))))))]);
	});

	test("a marker indented one space stays a sibling", () => {
		expect(parseMarkdown("- a\n - b\n- c")).toEqual([bullets(item(para(text("a"))), item(para(text("b"))), item(para(text("c"))))]);
		expect(parseMarkdown("1. a\n 2. b")).toEqual([ordered(1, item(para(text("a"))), item(para(text("b"))))]);
	});

	test("an ordered list starts at its first number; a bullet after it is a separate list", () => {
		expect(parseMarkdown("3. x\n4. y\n- z")).toEqual([ordered(3, item(para(text("x"))), item(para(text("y")))), bullets(item(para(text("z"))))]);
		expect(parseMarkdown("1) x\n2) y")).toEqual([ordered(1, item(para(text("x"))), item(para(text("y"))))]);
	});

	test("an ordered line interrupts a paragraph only when it is 1.; a bullet always does", () => {
		expect(parseMarkdown("intro\n2. nope")).toEqual([para(text("intro 2. nope"))]);
		expect(parseMarkdown("intro\n1. yes")).toEqual([para(text("intro")), ordered(1, item(para(text("yes"))))]);
		expect(parseMarkdown("intro\n- yes\n+ too")).toEqual([para(text("intro")), bullets(item(para(text("yes"))), item(para(text("too"))))]);
	});

	test("a lazy line continues the item's paragraph, also in a nested item; a new block ends the list", () => {
		expect(parseMarkdown("- a\n  - b\nlazy")).toEqual([bullets(item(para(text("a")), bullets(item(para(text("b lazy"))))))]);
		expect(parseMarkdown("- a\n# H")).toEqual([bullets(item(para(text("a")))), { kind: "heading", level: 1, children: [text("H")] }]);
		expect(parseMarkdown("- a\n```\ncode\n```")).toEqual([bullets(item(para(text("a")))), { kind: "code", text: "code" }]);
		expect(parseMarkdown("- a\n\nlazy no more")).toEqual([bullets(item(para(text("a")))), para(text("lazy no more"))]);
	});

	test("blank lines between items keep one list", () => {
		expect(parseMarkdown("- a\n\n- b")).toEqual([bullets(item(para(text("a"))), item(para(text("b"))))]);
	});

	test("task items", () => {
		expect(parseMarkdown("- [ ] todo\n- [x] done\n- [X] Done\n- [x]\n- [y] other\n- [x]nope")).toEqual([
			bullets(
				{ checked: false, children: [para(text("todo"))] },
				{ checked: true, children: [para(text("done"))] },
				{ checked: true, children: [para(text("Done"))] },
				{ checked: true, children: [] },
				item(para(text("[y] other"))),
				item(para(text("[x]nope"))),
			),
		]);
	});

	test("an empty item and an item holding a heading and a quote", () => {
		expect(parseMarkdown("-\n- b")).toEqual([bullets(item(), item(para(text("b"))))]);
		expect(parseMarkdown("- # H\n  > q")).toEqual([bullets(item({ kind: "heading", level: 1, children: [text("H")] }, { kind: "quote", children: [para(text("q"))] }))]);
	});
});

describe("blockquotes", () => {
	test("a quote parses its content as blocks: a nested list, nested quotes, code", () => {
		expect(parseMarkdown("> intro\n> - a\n>   - b\n> - c\n>\n> > deep\n>\n> ```\n> x\n> ```")).toEqual([
			{
				kind: "quote",
				children: [
					para(text("intro")),
					bullets(item(para(text("a")), bullets(item(para(text("b"))))), item(para(text("c")))),
					{ kind: "quote", children: [para(text("deep"))] },
					{ kind: "code", text: "x" },
				],
			},
		]);
		expect(parseMarkdown(">> a\n>b")).toEqual([{ kind: "quote", children: [{ kind: "quote", children: [para(text("a b"))] }] }]);
	});

	test("a lazy line continues the quote until a blank line or a new block", () => {
		expect(parseMarkdown("> a\nlazy\n\nafter")).toEqual([{ kind: "quote", children: [para(text("a lazy"))] }, para(text("after"))]);
		expect(parseMarkdown("> a\n# H")).toEqual([{ kind: "quote", children: [para(text("a"))] }, { kind: "heading", level: 1, children: [text("H")] }]);
		expect(parseMarkdown("> a\n- b")).toEqual([{ kind: "quote", children: [para(text("a"))] }, bullets(item(para(text("b"))))]);
	});

	test("a lazy line does not extend a quoted fence", () => {
		expect(parseMarkdown("> ```\n> x\nafter")).toEqual([{ kind: "quote", children: [{ kind: "code", text: "x" }] }, para(text("after"))]);
	});
});

describe("tables", () => {
	test("header, alignment, and body rows", () => {
		expect(parseMarkdown("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | **2** | 3 | 4 |\n5 | 6 | 7 | 8")).toEqual([
			{
				kind: "table",
				align: ["left", "center", "right", null],
				head: [[text("a")], [text("b")], [text("c")], [text("d")]],
				rows: [
					[[text("1")], [{ kind: "strong", children: [text("2")] }], [text("3")], [text("4")]],
					[[text("5")], [text("6")], [text("7")], [text("8")]],
				],
			},
		]);
	});

	test("a short row is padded with empty cells and extra cells are dropped", () => {
		expect(parseMarkdown("a | b | c\n--|--|--\n1 | 2\n1 | 2 | 3 | 4 | 5\n|")).toEqual([
			{
				kind: "table",
				align: [null, null, null],
				head: [[text("a")], [text("b")], [text("c")]],
				rows: [
					[[text("1")], [text("2")], []],
					[[text("1")], [text("2")], [text("3")]],
					[[], [], []],
				],
			},
		]);
	});

	test("an escaped pipe and a pipe in a code span stay in the cell; <br> is a break", () => {
		expect(parseMarkdown("| x | y |\n|---|---|\n| a \\| b | `c|d` |\n| l1<br>l2 | z |")).toEqual([
			{
				kind: "table",
				align: [null, null],
				head: [[text("x")], [text("y")]],
				rows: [
					[[text("a | b")], [{ kind: "code", text: "c|d" }]],
					[[text("l1"), { kind: "break" }, text("l2")], [text("z")]],
				],
			},
		]);
	});

	test("a cut-off table: a header with no delimiter row stays a paragraph", () => {
		expect(parseMarkdown("| a | b |")).toEqual([para(text("| a | b |"))]);
		expect(parseMarkdown("intro\n| a | b |\n|--")).toEqual([para(text("intro | a | b | |--"))]);
		expect(parseMarkdown("| a | b |\n|---|")).toEqual([para(text("| a | b | |---|"))]);
	});

	test("a header and delimiter with half a row", () => {
		expect(parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 |")).toEqual([
			{
				kind: "table",
				align: [null, null],
				head: [[text("a")], [text("b")]],
				rows: [[[text("1")], [text("2")]], [[text("3")], []]],
			},
		]);
		expect(parseMarkdown("| a | b |\n|---|---|")).toEqual([{ kind: "table", align: [null, null], head: [[text("a")], [text("b")]], rows: [] }]);
	});

	test("a table interrupts a paragraph and ends at a blank line or another block", () => {
		expect(parseMarkdown("intro\na | b\n-|-\n1 | 2\n\nafter\n\nx | y\n-|-\n# H")).toEqual([
			para(text("intro")),
			{ kind: "table", align: [null, null], head: [[text("a")], [text("b")]], rows: [[[text("1")], [text("2")]]] },
			para(text("after")),
			{ kind: "table", align: [null, null], head: [[text("x")], [text("y")]], rows: [] },
			{ kind: "heading", level: 1, children: [text("H")] },
		]);
	});

	test("a table inside a list item", () => {
		expect(parseMarkdown("- t\n  a | b\n  -|-\n  1 | 2")).toEqual([
			bullets(item(para(text("t")), { kind: "table", align: [null, null], head: [[text("a")], [text("b")]], rows: [[[text("1")], [text("2")]]] })),
		]);
	});
});

describe("robustness", () => {
	const document = [
		"# Title",
		"",
		"Setext",
		"===",
		"",
		"Intro with **bold**, *em*, _em_, ~~strike~~, `code`, <br>, \\* and [link](https://example.com/a_(b) \"t\") plus ![img](https://e.example/p.png).",
		"A <https://example.com> autolink and [![i](https://a.example/i.png)](https://b.example/).",
		"",
		"1. one",
		"   - nested [ ] x",
		"   - [x] done",
		"2. two",
		"",
		"> quote",
		"> - in quote",
		"lazy",
		"",
		"| a | b |",
		"|:-:|--:|",
		"| `x|y` | 1 \\| 2 |",
		"",
		"---",
		"",
		"~~~sh",
		"echo hi",
		"~~~",
		"",
		"- last",
		"  ```",
		"  code",
	].join("\n");

	test("every prefix of a document using every construct parses without throwing", () => {
		for (let end = 0; end <= document.length; end++) {
			expect(() => parseMarkdown(document.slice(0, end))).not.toThrow();
		}
		expect(parseMarkdown(document).map(block => block.kind)).toEqual(["heading", "heading", "paragraph", "list", "quote", "table", "rule", "code", "list"]);
	});

	test("hostile and degenerate input does not throw", () => {
		const inputs = ["[".repeat(500), "*".repeat(500), "_a ".repeat(400), "`".repeat(301), "> ".repeat(100), "- ".repeat(100), "|".repeat(50), "\\", "![", "[](", "[a](<", "<br", "1.", "-\t-\t-"];
		for (const input of inputs) {
			expect(() => parseMarkdown(input)).not.toThrow();
			expect(() => parseInline(input)).not.toThrow();
		}
	});

	test("a reply that is a wall of unclosed markers parses in linear time", () => {
		const size = 200_000;
		const shapes: Record<string, string> = {
			"unclosed *": "*a ".repeat(size / 3),
			"unclosed **": "**a ".repeat(size / 4),
			"unclosed _": " _a".repeat(size / 3),
			"unclosed ~~": "~~a ".repeat(size / 4),
			"unclosed backticks": "`a ``b ```c ".repeat(size / 12),
			"unclosed [": "[a ".repeat(size / 3),
			"unclosed ![x](": "![x](h ".repeat(size / 6),
			"unclosed [a](": "[a](".repeat(size / 4),
			"unclosed ![a](": "![a](".repeat(size / 5),
			"unclosed [a](#": "[a](#".repeat(size / 5),
			"unclosed *[a](b": "*[a](b".repeat(size / 6),
			"unclosed **[a](": "**[a](".repeat(size / 6),
			"unclosed [a](https://x.example/(": "[a](https://x.example/(".repeat(size / 23),
			"mixed *a **b": "*a **b ".repeat(size / 7),
			"mixed ***": "***a ".repeat(size / 5),
			"spaced heading": `# a${" ".repeat(size)}x`,
			"spaced delimiter row": `a\n-${" ".repeat(size)}x`,
			"spaced delimiter row in an item": `- a\n  -${" ".repeat(size)}x`,
			"heading, item and fence before U+2028": `# ${" ".repeat(size / 3)}\u2028\n- ${" ".repeat(size / 3)}\u2029\n${"`".repeat(size / 3)}\u2028`,
			"lazy lines under alternating nesting": `- a\n${"  - b\nlazy\n".repeat(size / 14)}`,
			"lazy quote": `> a\n${"> - b\nlazy\n".repeat(size / 12)}`,
			"deeply nested quotes": ">".repeat(size),
			"deeply nested items": "1. ".repeat(size / 3),
		};
		// Quadratic or worse behaviour takes tens of seconds at this size; linear takes well under a second.
		for (const [name, source] of Object.entries(shapes)) {
			const start = performance.now();
			parseMarkdown(source);
			expect({ name, fast: performance.now() - start < 3000 }).toEqual({ name, fast: true });
		}
	});

	test("short table rows are padded only up to a document-wide cell allowance", () => {
		const cellsOf = (blocks: Block[]): number =>
			blocks.reduce((sum, block) => (block.kind === "table" ? sum + block.head.length + block.rows.reduce((n, row) => n + row.length, 0) : sum), 0);
		const table = (columns: number, rows: number): string => `${"|a".repeat(columns)}|\n${"|-".repeat(columns)}|\n${"x\n".repeat(rows)}`;
		// One wide table over one-word lines, and many of them: both stay near the allowance instead of columns × rows.
		const one = parseMarkdown(table(1000, 1000));
		const many = parseMarkdown(Array.from({ length: 82 }, () => table(100, 100)).join("\n"));
		expect(cellsOf(one)).toBeLessThan(20_000);
		expect(cellsOf(many)).toBeLessThan(30_000);
		// Once the allowance is spent, a table's full rows still render: only padding is refused.
		const full = parseMarkdown(`${table(1000, 20)}\n| a | b |\n|---|---|\n| 1 | 2 |`);
		expect(full.at(-1)).toEqual({ kind: "table", align: [null, null], head: [[text("a")], [text("b")]], rows: [[[text("1")], [text("2")]]] });
	});
});
