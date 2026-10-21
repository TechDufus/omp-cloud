/** The landing page: what the threads are doing, what they cost, and the latest activity. */
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { getUsage, getVms, listThreads, type ThreadPhase, type ThreadSummaryView } from "../api";
import type { PageProps } from "../app/page";
import { useQuery } from "../app/query";
import { navigate } from "../app/route";
import { TimeChart } from "../kit/charts";
import { bucketAxis, rangeMeta, type TimeRange } from "../kit/data/range";
import { densify } from "../kit/data/series";
import { formatCost } from "../kit/data/formatters";
import {
	Badge,
	Card,
	type Column,
	ChartSkeleton,
	EmptyState,
	ErrorState,
	LabelCell,
	PageHeader,
	Segmented,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
	type Tone,
} from "../kit/ui";
import { ago, count, modelName, money } from "../format";
import { threadLabel } from "./thread-metrics";

type SpendRange = Extract<TimeRange, "7d" | "30d" | "90d">;

const SPEND_RANGES: readonly { value: SpendRange; label: string }[] = [
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
	{ value: "90d", label: "90d" },
];

/** The most recently active threads the table lists. */
const LATEST_THREADS = 8;
/** Days the "last 7 days" tile and its sparkline cover, today included. */
const WEEK_DAYS = 7;
const VMS_POLL_MS = 10_000;

const PHASE_TONE: Record<ThreadPhase, Tone> = {
	starting: "neutral",
	working: "accent",
	waiting: "warn",
	idle: "ok",
	failed: "bad",
	deleted: "neutral",
};

const THREAD_COLUMNS: readonly Column<ThreadSummaryView>[] = [
	{
		key: "title",
		header: "Thread",
		sort: row => threadLabel(row, row.id).toLowerCase(),
		render: row => (
			<LabelCell
				primary={<a href={`#/threads/${encodeURIComponent(row.id)}`}>{threadLabel(row, row.id)}</a>}
				secondary={row.name && row.title ? `${row.title} · ${row.id}` : row.id}
			/>
		),
	},
	{ key: "repo", header: "Repository", sort: row => row.repo.name, render: row => row.repo.name || "—" },
	{
		key: "phase",
		header: "Phase",
		sort: row => row.phase,
		render: row => (
			<span className="row" style={{ gap: 6 }}>
				<Badge tone={PHASE_TONE[row.phase]}>{row.phase}</Badge>
				{row.archivedAt !== null && <Badge>archived</Badge>}
			</span>
		),
	},
	{
		key: "model",
		header: "Model",
		sort: row => row.model,
		render: row => (row.model ? <span title={row.model}>{modelName(row.model)}</span> : "—"),
	},
	{
		key: "age",
		header: "Active",
		align: "right",
		sort: row => Date.parse(row.lastActivityAt),
		render: row => ago(row.lastActivityAt),
	},
];

export function OverviewPage({ active }: PageProps) {
	const [range, setRange] = useState<SpendRange>("30d");
	const meta = rangeMeta(range);

	const threads = useQuery(["overview", "threads"], () => listThreads(), { enabled: active, live: true });
	const vms = useQuery(["overview", "vms"], () => getVms(), { enabled: active, refetchMs: VMS_POLL_MS });
	const usage = useQuery(
		["overview", "usage", range],
		() => getUsage(new Date(bucketAxis(range, [])[0] ?? Date.now()).toISOString()),
		{ enabled: active, live: true },
	);

	// Days are UTC midnights, like the service's `usage.days`; recomputed per response so a new day extends the axis.
	const spend = useMemo(() => {
		const days = (usage.data?.days ?? []).map(entry => ({ timestamp: Date.parse(`${entry.day}T00:00:00Z`), cost: entry.cost }));
		const buckets = bucketAxis(range, days.map(entry => entry.timestamp));
		const values = densify(days, buckets, entry => entry.cost);
		const week = values.slice(-WEEK_DAYS);
		return { buckets, values, week, today: values.at(-1) ?? 0, weekTotal: week.reduce((sum, cost) => sum + cost, 0) };
	}, [usage.data, range]);

	const phases = useMemo(() => {
		const tally: Record<ThreadPhase, number> = { starting: 0, working: 0, waiting: 0, idle: 0, failed: 0, deleted: 0 };
		for (const thread of threads.data ?? []) tally[thread.phase] += 1;
		return tally;
	}, [threads.data]);

	const latest = useMemo(
		() => [...(threads.data ?? [])].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)).slice(0, LATEST_THREADS),
		[threads.data],
	);

	const vmCount = (state: string): string =>
		vms.data === undefined ? "—" : count(vms.data.vms.filter(vm => vm.state === state).length);
	const threadCount = (phase: ThreadPhase): string => (threads.data === undefined ? "—" : count(phases[phase]));
	const spendOf = (value: number): string => (usage.data === undefined ? "—" : money(value));

	return (
		<div className="page">
			<PageHeader title="Overview" description="What your cloud agents are doing, and what they cost." />

			{threads.error !== undefined && <ErrorState error={threads.error} onRetry={threads.refetch} />}
			{usage.error !== undefined && <ErrorState error={usage.error} onRetry={usage.refetch} />}
			{vms.error !== undefined && <ErrorState error={vms.error} onRetry={vms.refetch} />}

			<StatGrid min={170}>
				<Stat
					label="Working"
					value={threadCount("working")}
					hint={phases.starting > 0 ? `${count(phases.starting)} starting` : undefined}
				/>
				<Stat label="Waiting for you" value={threadCount("waiting")} title="Threads with a question open" />
				<Stat label="Idle" value={threadCount("idle")} />
				<Stat label="Failed" value={threadCount("failed")} />
			</StatGrid>
			<StatGrid min={190}>
				<Stat label="Spend today" value={spendOf(spend.today)} title="Turns completed since 00:00 UTC" />
				<Stat
					label="Spend, last 7 days"
					value={spendOf(spend.weekTotal)}
					spark={usage.data === undefined ? undefined : spend.week}
					sparkColor="var(--chart-secondary)"
				/>
				<Stat label="VMs running" value={vmCount("running")} />
				<Stat label="VMs paused" value={vmCount("paused")} />
			</StatGrid>

			<Card
				index={1}
				title="Spend per day"
				description={`Per UTC day over ${meta.windowLabel}`}
				actions={<Segmented size="sm" options={SPEND_RANGES} value={range} onChange={setRange} aria-label="Spend range" />}
			>
				{usage.data === undefined && usage.error === undefined ? (
					<ChartSkeleton height={240} />
				) : (
					<TimeChart
						buckets={spend.buckets}
						bucketMs={meta.bucketMs}
						series={[{ key: "cost", label: "Spend", color: "var(--chart-secondary)", values: spend.values }]}
						height={240}
						format={formatCost}
						formatTooltip={money}
						emptyLabel="No spend in this range"
					/>
				)}
			</Card>

			<Card
				index={2}
				title="Latest threads"
				description="Most recent activity first"
				flush
				actions={
					<a className="btn" data-size="sm" data-variant="ghost" href="#/threads">
						All threads <ArrowRight size={13} />
					</a>
				}
			>
				{threads.data === undefined && threads.error === undefined ? (
					<TableSkeleton rows={LATEST_THREADS} />
				) : (
					<Table
						columns={THREAD_COLUMNS}
						rows={latest}
						rowKey={row => row.id}
						onRowClick={row => navigate(`#/threads/${encodeURIComponent(row.id)}`)}
						initialSort={{ key: "age", dir: "desc" }}
						empty={<EmptyState title="No threads yet" hint="Threads you start from omp show up here." />}
					/>
				)}
			</Card>
		</div>
	);
}
