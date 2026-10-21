/** Cloud spend from the recorded turn usage: totals, per day, per thread and the token mix. */
import { useMemo, useState } from "react";
import { getUsage, type UsageReport } from "../api";
import type { PageProps } from "../app/page";
import { useQuery } from "../app/query";
import { BarList, Chart, Legend, ShareBar } from "../kit/charts";
import { formatCompact, formatInteger, formatPercent } from "../kit/data/formatters";
import {
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	Segmented,
	Skeleton,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../kit/ui";
import { money } from "../format";
import { threadLabel } from "./thread-metrics";
import { navigate } from "../app/route";

const DAY_MS = 86_400_000;
const TOP_THREADS = 8;

const RANGE_OPTIONS = [
	{ value: "7" as const, label: "7d", title: "Last 7 days" },
	{ value: "30" as const, label: "30d", title: "Last 30 days" },
	{ value: "90" as const, label: "90d", title: "Last 90 days" },
];

type RangeDays = (typeof RANGE_OPTIONS)[number]["value"];

const TOKEN_KINDS = [
	{ key: "input", label: "Input", color: "#5b8cff" },
	{ key: "output", label: "Output", color: "var(--chart-secondary)" },
	{ key: "cacheRead", label: "Cache read", color: "var(--chart-primary)" },
	{ key: "cacheWrite", label: "Cache write", color: "#f5b54a" },
] as const;

/** Spend is bucketed by UTC day on the server. */
const UTC_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const UTC_DAY_LONG = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

type ThreadSpend = UsageReport["threads"][number];

interface SpendView {
	/** UTC midnight of every day from the report's `since` to today. */
	buckets: number[];
	dailyCost: number[];
	activeDays: number;
	turns: number;
	topThread: ThreadSpend | undefined;
	tokens: { key: string; label: string; color: string; value: number }[];
}

export function SpendPage({ active }: PageProps) {
	const [days, setDays] = useState<RangeDays>("30");
	const query = useQuery(["usage", days], () => getUsage(new Date(Date.now() - Number(days) * DAY_MS).toISOString()), {
		enabled: active,
	});
	const view = useMemo(() => (query.data ? buildView(query.data) : undefined), [query.data]);
	const columns = useMemo(() => (query.data ? threadColumns(query.data) : []), [query.data]);
	const isEmpty = (data: UsageReport) => data.days.length === 0 && data.threads.length === 0;
	const empty = <EmptyState title="No turns in this range" hint="Pick a wider range." />;

	return (
		<div className="page">
			<PageHeader
				title="Spend"
				description="Cloud turns recorded by this service. Spend merged with your local usage is `omp stats`."
				actions={
					<Segmented size="sm" options={RANGE_OPTIONS} value={days} onChange={setDays} aria-label="Range" />
				}
			/>

			<QueryView
				query={query}
				skeleton={<Skeleton height={112} style={{ borderRadius: 12 }} />}
				isEmpty={isEmpty}
				empty={empty}
			>
				{data => view && <SpendStats report={data} view={view} />}
			</QueryView>

			<div className="grid grid-main-side">
				<Card index={1} title="Per day" description="Spend per UTC day">
					<QueryView query={query} skeleton={<ChartSkeleton height={260} />} isEmpty={isEmpty} empty={empty}>
						{() =>
							view && (
								<Chart
									slots={view.buckets.length}
									tickLabel={i => UTC_DAY.format(view.buckets[i])}
									tooltipTitle={i => UTC_DAY_LONG.format(view.buckets[i])}
									series={[
										{
											key: "cost",
											label: "Spend",
											color: "var(--chart-secondary)",
											values: view.dailyCost.map(v => v || null),
										},
									]}
									height={260}
									format={axisMoney}
									formatTooltip={money}
									emptyLabel="No spend in this range"
								/>
							)
						}
					</QueryView>
				</Card>

				<Card index={2} title="Top threads" description={`The ${TOP_THREADS} costliest threads in range`}>
					<QueryView query={query} skeleton={<ChartSkeleton height={260} />} isEmpty={isEmpty} empty={empty}>
						{data => (
							<BarList
								items={data.threads.slice(0, TOP_THREADS).map(thread => ({
									key: thread.thread,
									label: <span className="truncate">{threadLabel(thread, thread.thread)}</span>,
									value: thread.cost,
									display: money(thread.cost),
									color: "var(--chart-secondary)",
								}))}
								onSelect={threadId => navigate(`#/threads/${encodeURIComponent(threadId)}`)}
							/>
						)}
					</QueryView>
				</Card>
			</div>

			<Card index={3} title="Token mix" description="Recorded tokens by kind">
				<QueryView query={query} skeleton={<Skeleton height={48} />} isEmpty={isEmpty} empty={empty}>
					{() =>
						view && (
							<div className="stack" style={{ gap: 12 }}>
								<ShareBar
									segments={view.tokens.map(t => ({ key: t.key, label: t.label, value: t.value, color: t.color }))}
									height={10}
								/>
								<Legend
									items={view.tokens.map(t => ({
										key: t.key,
										label: t.label,
										color: t.color,
										value: formatInteger(t.value),
									}))}
								/>
							</div>
						)
					}
				</QueryView>
			</Card>

			<Card index={4} title="Per thread" description="Turns and cost per thread in range" flush>
				<QueryView query={query} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={empty}>
					{data => (
						<Table
							rows={data.threads}
							rowKey={row => row.thread}
							columns={columns}
							initialSort={{ key: "cost", dir: "desc" }}
							limit={20}
							empty={<EmptyState title="No threads in this range" />}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function SpendStats({ report, view }: { report: UsageReport; view: SpendView }) {
	const { total } = report;
	const top = view.topThread;
	const tokenTotal = view.tokens.reduce((sum, token) => sum + token.value, 0);
	return (
		<StatGrid min={180}>
			<Stat
				label="Spend"
				title="Recorded cost of the cloud turns in this range"
				value={money(total.cost)}
				hint={`${formatInteger(view.turns)} turns · ${formatInteger(report.threads.length)} threads`}
				spark={view.dailyCost}
				sparkColor="var(--chart-secondary)"
			/>
			<Stat
				label="Average per day"
				title="Spend ÷ days with any turns"
				value={money(view.activeDays > 0 ? total.cost / view.activeDays : 0)}
				hint={`over ${formatInteger(view.activeDays)} active day${view.activeDays === 1 ? "" : "s"}`}
			/>
			<Stat
				label="Top thread"
				title={top ? `${threadLabel(top, top.thread)} (${top.thread})` : undefined}
				value={top ? money(top.cost) : "–"}
				hint={
					top ? (
						<div className="truncate">
							{threadLabel(top, top.thread)} · {formatPercent(total.cost > 0 ? top.cost / total.cost : 0)}
						</div>
					) : (
						"No threads yet"
					)
				}
			/>
			<Stat
				label="Tokens"
				title="Recorded tokens of all kinds; the token mix below splits them"
				value={formatInteger(tokenTotal)}
				hint={`${formatCompact(total.inputTokens)} in · ${formatCompact(total.outputTokens)} out`}
			/>
		</StatGrid>
	);
}

function buildView(report: UsageReport): SpendView {
	const costByDay = new Map(report.days.map(day => [day.day, day.cost]));
	const last = Math.floor(Date.now() / DAY_MS) * DAY_MS;
	const first = Math.floor(Date.parse(report.since) / DAY_MS) * DAY_MS;
	const buckets: number[] = [];
	for (let t = first; t <= last; t += DAY_MS) buckets.push(t);
	const dailyCost = buckets.map(t => costByDay.get(new Date(t).toISOString().slice(0, 10)) ?? 0);
	const { total } = report;
	const tokenValues = {
		input: total.inputTokens,
		output: total.outputTokens,
		cacheRead: total.cacheReadTokens,
		cacheWrite: total.cacheWriteTokens,
	};
	let topThread: ThreadSpend | undefined;
	for (const thread of report.threads) if (!topThread || thread.cost > topThread.cost) topThread = thread;
	return {
		buckets,
		dailyCost,
		activeDays: report.days.filter(day => day.cost > 0).length,
		turns: report.threads.reduce((sum, thread) => sum + thread.turns, 0),
		topThread,
		tokens: TOKEN_KINDS.map(kind => ({ ...kind, value: tokenValues[kind.key] })),
	};
}

function threadColumns(report: UsageReport): Column<ThreadSpend>[] {
	const maxCost = Math.max(0, ...report.threads.map(thread => thread.cost));
	return [
		{
			key: "thread",
			header: "Thread",
			sort: row => threadLabel(row, row.thread).toLowerCase(),
			render: row => (
				<LabelCell
					primary={<a href={`#/threads/${encodeURIComponent(row.thread)}`}>{threadLabel(row, row.thread)}</a>}
					secondary={<span className="mono">{row.thread}</span>}
				/>
			),
		},
		{
			key: "turns",
			header: "Turns",
			align: "right",
			sort: row => row.turns,
			render: row => <span className="num">{formatInteger(row.turns)}</span>,
		},
		{
			key: "share",
			header: "Share",
			align: "right",
			sort: row => row.cost,
			render: row => (
				<span className="num">{formatPercent(report.total.cost > 0 ? row.cost / report.total.cost : 0)}</span>
			),
		},
		{
			key: "cost",
			header: "Cost",
			align: "right",
			width: 200,
			sort: row => row.cost,
			render: row => (
				<MeterCell value={row.cost} max={maxCost} display={money(row.cost)} color="var(--chart-secondary)" />
			),
		},
	];
}

/** Axis tick: whole dollars bare, cents above a dollar, the table precision below. */
function axisMoney(value: number): string {
	if (value === 0) return "$0";
	if (value >= 1) return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
	return money(value);
}
