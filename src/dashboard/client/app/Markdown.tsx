/** Release notes (and any other Markdown from the feed) as React elements: no HTML is ever injected. See `notes.ts` for the subset. */
import type { ReactNode } from "react";
import { type Inline, parseMarkdown } from "./notes";

function inline(nodes: readonly Inline[]): ReactNode[] {
	return nodes.map((node, index) => {
		switch (node.kind) {
			case "text":
				return node.text;
			case "code":
				return <code key={index}>{node.text}</code>;
			case "strong":
				return <strong key={index}>{inline(node.children)}</strong>;
			case "em":
				return <em key={index}>{inline(node.children)}</em>;
			case "link":
				return (
					<a key={index} href={node.href} target="_blank" rel="noreferrer">
						{inline(node.children)}
					</a>
				);
		}
	});
}

export function Markdown({ source, className }: { source: string; className?: string }) {
	return (
		<div className={className}>
			{parseMarkdown(source).map((block, index) => {
				switch (block.kind) {
					case "heading":
						return (
							<h4 key={index} className="md-heading" data-level={block.level}>
								{inline(block.children)}
							</h4>
						);
					case "paragraph":
						return <p key={index}>{inline(block.children)}</p>;
					case "list":
						return (
							<ul key={index}>
								{block.items.map((item, at) => (
									<li key={at}>{inline(item)}</li>
								))}
							</ul>
						);
					case "code":
						return (
							<pre key={index} className="code-block">
								<code>{block.text}</code>
							</pre>
						);
				}
			})}
		</div>
	);
}
