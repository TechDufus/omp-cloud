import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./client/app/Markdown";

function render(source: string): string {
	return renderToStaticMarkup(createElement(Markdown, { source }));
}

describe("Markdown renderer safety", () => {
	test("an image is rendered as a link to its URL and never as an <img>", () => {
		const html = render("![x](https://evil.example/p.png)");
		expect(html).toContain('href="https://evil.example/p.png"');
		expect(html).not.toContain("<img");
	});

	test("raw HTML is shown as escaped text, not as elements", () => {
		const html = render("<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;img");
		expect(html).toContain("&lt;script&gt;");
	});

	test("a javascript: URL never becomes an href, for links and images alike", () => {
		expect(render("[x](javascript:alert(1))")).not.toContain('href="javascript:');
		expect(render("![x](javascript:alert(1))")).not.toContain('href="javascript:');
	});

	test("a task item's checkbox is disabled", () => {
		const html = render("- [x] done\n- [ ] open");
		const boxes = html.match(/<input[^>]*>/g) ?? [];
		expect(boxes).toHaveLength(2);
		for (const box of boxes) expect(box).toContain("disabled");
	});
});
