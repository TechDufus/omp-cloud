/**
 * Markdown from the feed (release notes) and from threads (prompts and replies) as React elements: no HTML is ever injected,
 * raw HTML in the source is shown as text, and an image never loads: it renders as a link to its URL. See `markdown-parser.ts` for the subset.
 */
import { type ReactNode, useMemo } from "react";
import { type Block, type Inline, type ListItem, parseMarkdown } from "./markdown-parser";

/** `inLink` flattens links and images inside a link to their text: anchors never nest. */
function inline(nodes: readonly Inline[], inLink = false): ReactNode[] {
	return nodes.map((node, index) => {
		switch (node.kind) {
			case "text":
				return node.text;
			case "code":
				return <code key={index}>{node.text}</code>;
			case "strong":
				return <strong key={index}>{inline(node.children, inLink)}</strong>;
			case "em":
				return <em key={index}>{inline(node.children, inLink)}</em>;
			case "strike":
				return <del key={index}>{inline(node.children, inLink)}</del>;
			case "break":
				return <br key={index} />;
			case "link":
				if (inLink) return inline(node.children, true);
				return (
					<a key={index} href={node.href} target="_blank" rel="noreferrer">
						{inline(node.children, true)}
					</a>
				);
			case "image": {
				const label = node.alt === "" ? node.href : node.alt;
				if (inLink) return label;
				return (
					<a key={index} className="md-image" href={node.href} target="_blank" rel="noreferrer" title={node.href}>
						{label}
					</a>
				);
			}
		}
	});
}

function listItem(item: ListItem, index: number): ReactNode {
	const [first, ...rest] = item.children;
	const lead = first?.kind === "paragraph" ? first : null;
	return (
		<li key={index} className={item.checked === null ? undefined : "md-task"}>
			{item.checked !== null && <input type="checkbox" checked={item.checked} disabled readOnly />}
			{lead && inline(lead.children)}
			{blocks(lead ? rest : item.children)}
		</li>
	);
}

function blocks(nodes: readonly Block[]): ReactNode[] {
	return nodes.map((block, index) => {
		switch (block.kind) {
			case "heading":
				return (
					<h4 key={index} className="md-heading" data-level={block.level}>
						{inline(block.children)}
					</h4>
				);
			case "paragraph":
				return <p key={index}>{inline(block.children)}</p>;
			case "list": {
				const items = block.items.map(listItem);
				if (!block.ordered) return <ul key={index}>{items}</ul>;
				return (
					<ol key={index} start={block.start === 1 ? undefined : block.start}>
						{items}
					</ol>
				);
			}
			case "code":
				return (
					<pre key={index} className="code-block">
						<code>{block.text}</code>
					</pre>
				);
			case "quote":
				return <blockquote key={index}>{blocks(block.children)}</blockquote>;
			case "rule":
				return <hr key={index} />;
			case "table":
				return (
					<div key={index} className="md-table">
						<table>
							<thead>
								<tr>
									{block.head.map((cell, at) => (
										<th key={at} data-align={block.align[at] ?? undefined}>
											{inline(cell)}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{block.rows.map((row, rowAt) => (
									<tr key={rowAt}>
										{row.map((cell, at) => (
											<td key={at} data-align={block.align[at] ?? undefined}>
												{inline(cell)}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				);
		}
	});
}

export function Markdown({ source, className }: { source: string; className?: string }) {
	const parsed = useMemo(() => parseMarkdown(source), [source]);
	return <div className={className ? `md ${className}` : "md"}>{blocks(parsed)}</div>;
}
