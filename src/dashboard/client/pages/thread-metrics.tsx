/** How a thread is labelled, and its context and metrics: shared by the list, the detail and the other pages that name threads. */
import type { ContextView, ThreadContextView, ThreadDetailView } from "../api";
import { count, dateTime, ago, money } from "../format";
import { Chart } from "../kit/charts";
import { formatCompact, formatCost, formatElapsed } from "../kit/data/formatters";
import { Card, EmptyState, KeyValues } from "../kit/ui";

/** The context share above which the meter turns amber, then red. */
const CONTEXT_WARN = 0.7;
const CONTEXT_BAD = 0.9;

/** The primary label of a thread everywhere: its name, else its title, else `fallback`. */
export function threadLabel(thread: { name: string; title: string }, fallback: string): string {
	return thread.name || thread.title || fallback;
}

/** The share of the window the context fills, or null when the window is unknown. */
function contextShare(context: ContextView): number | null {
	return context.window > 0 ? context.tokens / context.window : null;
}

/** "19K / 200K", or "19K" when the window is unknown. */
export function contextLabel(context: ContextView): string {
	return context.window > 0 ? `${formatCompact(context.tokens)} / ${formatCompact(context.window)}` : formatCompact(context.tokens);
}

function contextTitle(context: ContextView): string {
	return context.window > 0
		? `${count(context.tokens)} of ${count(context.window)} tokens`
		: `${count(context.tokens)} tokens; the model's context window is unknown`;
}

function contextColor(share: number): string {
	if (share >= CONTEXT_BAD) return "var(--bad)";
	if (share >= CONTEXT_WARN) return "var(--warn)";
	return "var(--chart-primary)";
}

/** The list's compact context cell: a small bar with the percent; the exact tokens are in its title. */
export function ContextCell({ context }: { context: ThreadContextView | null }) {
	if (!context) return <span className="muted">—</span>;
	const share = contextShare(context);
	if (share === null) {
		return (
			<span className="num muted" title={contextTitle(context)}>
				{formatCompact(context.tokens)}
			</span>
		);
	}
	return (
		<div className="meter-cell" title={contextTitle(context)}>
			<span className="num">{Math.round(share * 100)}%</span>
			<div className="meter">
				<div className="meter-fill" style={{ width: `${Math.min(100, share * 100)}%`, background: contextColor(share) }} />
			</div>
		</div>
	);
}

function ContextMeter({ context }: { context: ThreadContextView | null }) {
	if (!context) return <p className="micro">No context use reported yet.</p>;
	const share = contextShare(context);
	return (
		<div className="threads-context" title={contextTitle(context)}>
			<div className="threads-context-head">
				<span className="cell-primary">Context</span>
				<span className="num">
					{contextLabel(context)}
					{share !== null && ` · ${Math.round(share * 100)}%`}
				</span>
			</div>
			{share !== null && (
				<div className="meter threads-context-meter">
					<div className="meter-fill" style={{ width: `${Math.min(100, share * 100)}%`, background: contextColor(share) }} />
				</div>
			)}
			<span className="micro" title={dateTime(context.at)}>
				{share === null ? "The model's context window is unknown · " : ""}reported {ago(context.at)}
			</span>
		</div>
	);
}

/** A thread's context meter, totals and the per-turn context and cost charts. */
export function MetricsCard({ thread }: { thread: ThreadDetailView }) {
	const { metrics } = thread;
	const { usage, turns, context } = metrics;
	const tokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
	const contextWindow = context !== null ? context.window : 0;
	const peak = Math.max(0, ...turns.map(turn => turn.contextTokens ?? 0));
	const totals = [
		{
			key: "tokens",
			label: "Tokens",
			value: (
				<span title={`${count(usage.inputTokens)} in · ${count(usage.outputTokens)} out · ${count(usage.cacheWriteTokens)} cache write; ${count(usage.cacheReadTokens)} cache read not counted`}>
					{formatCompact(tokens)}
				</span>
			),
		},
		{ key: "cost", label: "Cost", value: money(usage.cost) },
		{ key: "requests", label: "Requests", value: count(metrics.requests) },
		{ key: "tools", label: "Tool calls", value: count(metrics.tools) },
		{ key: "work", label: "Work time", value: formatElapsed(metrics.workMs) },
	];
	return (
		<Card title="Metrics" description={turns.length > 0 ? `Per-turn charts cover the last ${turns.length} finished ${turns.length === 1 ? "turn" : "turns"}` : "Totals over the thread's turns"}>
			<div className="stack threads-metrics">
				<ContextMeter context={context} />
				<KeyValues items={totals} />
				{turns.length === 0 ? (
					<EmptyState title="No finished turns yet" hint="The charts fill in as turns complete." />
				) : (
					<div className="grid grid-2">
						<div className="threads-chart">
							<div className="threads-label">Context per turn</div>
							<Chart
								slots={turns.length}
								tickLabel={i => `#${turns[i]?.n}`}
								tooltipTitle={i => `Turn ${turns[i]?.n}`}
								kind="area"
								stacked={false}
								series={[
									{
										key: "context",
										label: "Context",
										color: "var(--chart-primary)",
										values: turns.map(turn => turn.contextTokens),
									},
								]}
								height={150}
								yMax={contextWindow > 0 ? Math.max(contextWindow, peak) : undefined}
								format={formatCompact}
								formatTooltip={count}
								emptyLabel="No context reported"
							/>
						</div>
						<div className="threads-chart">
							<div className="threads-label">Cost per turn</div>
							<Chart
								slots={turns.length}
								tickLabel={i => `#${turns[i]?.n}`}
								tooltipTitle={i => `Turn ${turns[i]?.n}`}
								series={[
									{
										key: "cost",
										label: "Cost",
										color: "var(--chart-secondary)",
										values: turns.map(turn => turn.cost || null),
									},
								]}
								height={150}
								format={formatCost}
								formatTooltip={money}
								emptyLabel="No cost recorded"
							/>
						</div>
					</div>
				)}
			</div>
		</Card>
	);
}
