/** Threads: the list grouped by repository, and the open thread when the route names one. */
import { RotateCw } from "lucide-react";
import { useState } from "react";
import { listThreads, type ThreadSummaryView } from "../api";
import type { PageProps } from "../app/page";
import { messageOf, useQuery } from "../app/query";
import { navigate } from "../app/route";
import { ago, dateTime, diffstat, modelName, money } from "../format";
import {
	Badge,
	Card,
	type Column,
	EmptyState,
	ErrorState,
	LabelCell,
	PageHeader,
	Segmented,
	type SegmentedOption,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../kit/ui";
import { repoKey, repoLabel } from "./repo-key";
import { ContextCell, threadLabel } from "./thread-metrics";
import { PhaseBadge, ThreadDetail, useTicker } from "./ThreadDetail";
import "./threads.css";

type Filter = "all" | "active" | "waiting" | "failed" | "archived";

const FILTERS: readonly SegmentedOption<Filter>[] = [
	{ value: "all", label: "All" },
	{ value: "active", label: "Active", title: "Starting or working" },
	{ value: "waiting", label: "Waiting", title: "Waiting for an answer" },
	{ value: "failed", label: "Failed" },
	{ value: "archived", label: "Archived", title: "VM released after a quiet stretch; the next message restores it" },
];

const FILTER_MATCH: Record<Filter, (thread: ThreadSummaryView) => boolean> = {
	all: () => true,
	active: thread => thread.phase === "starting" || thread.phase === "working",
	waiting: thread => thread.phase === "waiting",
	failed: thread => thread.phase === "failed",
	archived: thread => thread.archivedAt !== null,
};

interface RepoGroup {
	key: string;
	label: string;
	workspace: string;
	threads: ThreadSummaryView[];
	/** Epoch ms of the newest activity in the group. */
	latest: number;
}

function groupByRepo(threads: readonly ThreadSummaryView[]): RepoGroup[] {
	const groups = new Map<string, RepoGroup>();
	for (const thread of threads) {
		const ref = { remoteURL: thread.repo.remoteURL, name: thread.repo.name, workspace: thread.workspace };
		const key = repoKey(ref);
		const activity = Date.parse(thread.lastActivityAt);
		let group = groups.get(key);
		if (!group) {
			group = { key, label: repoLabel(ref), workspace: thread.workspace, threads: [], latest: 0 };
			groups.set(key, group);
		}
		group.threads.push(thread);
		if (activity > group.latest) group.latest = activity;
		if (group.workspace === "") group.workspace = thread.workspace;
	}
	return [...groups.values()].sort((a, b) => b.latest - a.latest);
}

const COLUMNS: readonly Column<ThreadSummaryView>[] = [
	{
		key: "thread",
		header: "Thread",
		sort: thread => threadLabel(thread, "").toLowerCase(),
		render: thread => {
			let secondary = thread.id;
			if (thread.question) secondary = `Asks: ${thread.question.text}`;
			else if (thread.error) secondary = thread.error;
			else if (thread.activity) secondary = `${thread.activity.kind}: ${thread.activity.text}`;
			else if (thread.name && thread.title) secondary = `${thread.title} · ${thread.id}`;
			return <LabelCell primary={threadLabel(thread, "Untitled thread")} secondary={secondary} />;
		},
	},
	{
		key: "phase",
		header: "Phase",
		width: 168,
		sort: thread => thread.phase,
		render: thread => (
			<span className="row" style={{ gap: 6 }}>
				<PhaseBadge phase={thread.phase} />
				{thread.archivedAt !== null && (
					<span title={`VM released ${dateTime(thread.archivedAt)}; the next message restores it`}>
						<Badge>archived</Badge>
					</span>
				)}
			</span>
		),
	},
	{
		key: "model",
		header: "Model",
		width: 150,
		sort: thread => thread.model,
		render: thread => (
			<span className="mono" title={thread.model || undefined}>
				{thread.model ? modelName(thread.model) : "—"}
			</span>
		),
	},
	{
		key: "context",
		header: "Context",
		width: 120,
		align: "right",
		title: "Share of the model's context window the thread's omp last reported",
		sort: thread => {
			const context = thread.metrics.context;
			return context !== null && context.window > 0 ? context.tokens / context.window : -1;
		},
		render: thread => <ContextCell context={thread.metrics.context} />,
	},
	{
		key: "cost",
		header: "Cost",
		width: 90,
		align: "right",
		sort: thread => thread.metrics.usage.cost,
		render: thread => {
			const { usage, requests, tools } = thread.metrics;
			if (usage.cost === 0) return <span className="muted">—</span>;
			return (
				<span className="num" title={`${requests} requests · ${tools} tool calls`}>
					{money(usage.cost)}
				</span>
			);
		},
	},
	{
		key: "turns",
		header: "Turns",
		width: 90,
		align: "right",
		wrap: true,
		sort: thread => thread.turns,
		render: thread => (
			<div className="threads-turns-cell">
				<span className="num">{thread.turns}</span>
				{thread.queued > 0 && <span className="cell-secondary">+{thread.queued} queued</span>}
			</div>
		),
	},
	{
		key: "changes",
		header: "Changes",
		width: 180,
		wrap: true,
		sort: thread => thread.result?.filesChanged ?? -1,
		render: thread => {
			const result = thread.result;
			if (!result) return <span className="muted">—</span>;
			return (
				<div className="threads-changes">
					<span className="cell-primary">{diffstat(result.filesChanged, result.insertions, result.deletions)}</span>
					<span className="cell-secondary">
						{result.branch}
						{result.pushed ? " · pushed" : ""}
					</span>
				</div>
			);
		},
	},
	{
		key: "updated",
		header: "Updated",
		width: 100,
		align: "right",
		sort: thread => thread.lastActivityAt,
		render: thread => (
			<span className="muted" title={dateTime(thread.lastActivityAt)}>
				{ago(thread.lastActivityAt)}
			</span>
		),
	},
];

export function ThreadsPage({ active, threadId }: PageProps & { threadId?: string }) {
	const showingList = threadId === undefined;
	useTicker(active && showingList);
	const threads = useQuery(["threads"], () => listThreads(), { enabled: active && showingList, live: true });
	const [filter, setFilter] = useState<Filter>("all");

	if (threadId !== undefined) return <ThreadDetail key={threadId} id={threadId} active={active} />;

	const all = threads.data;
	const countOf = (match: (thread: ThreadSummaryView) => boolean): number | string => (all ? all.filter(match).length : "—");
	const shown = all ? all.filter(FILTER_MATCH[filter]) : [];
	const groups = groupByRepo(shown);

	let body = (
		<Card flush>
			<TableSkeleton rows={6} />
		</Card>
	);
	if (all) {
		if (all.length === 0) body = <EmptyState title="No threads yet" hint="Hand work off from omp with /cloud." />;
		else if (shown.length === 0) body = <EmptyState title="No threads match this filter" />;
		else {
			body = (
				<>
					{groups.map((group, index) => (
						<Card
							key={group.key}
							index={index}
							className="threads-group"
							title={group.label}
							description={`${group.threads.length} ${group.threads.length === 1 ? "thread" : "threads"}${group.workspace ? ` · ${group.workspace}` : ""}`}
							actions={<GroupBadges threads={group.threads} />}
							flush
						>
							<Table
								columns={COLUMNS}
								rows={group.threads}
								rowKey={thread => thread.id}
								onRowClick={thread => navigate(`#/threads/${encodeURIComponent(thread.id)}`)}
								initialSort={{ key: "updated", dir: "desc" }}
							/>
						</Card>
					))}
				</>
			);
		}
	} else if (threads.error) body = <ErrorState error={messageOf(threads.error)} onRetry={threads.refetch} />;

	return (
		<div className="page">
			<PageHeader
				title="Threads"
				description="Work handed off from omp, grouped by repository."
				actions={
					<>
						<Segmented options={FILTERS} value={filter} onChange={setFilter} size="sm" aria-label="Filter threads" />
						<button type="button" className="btn" data-size="sm" onClick={() => threads.refetch()}>
							<RotateCw size={13} /> Refresh
						</button>
					</>
				}
			/>
			<StatGrid>
				<Stat label="Threads" value={all ? all.length : "—"} hint={all ? `${groupByRepo(all).length} repositories` : undefined} />
				<Stat label="Active" value={countOf(FILTER_MATCH.active)} hint="starting or working" />
				<Stat label="Waiting" value={countOf(FILTER_MATCH.waiting)} hint="need an answer" />
				<Stat label="Idle" value={countOf(thread => thread.phase === "idle" && thread.archivedAt === null)} hint="finished their turns" />
				<Stat label="Archived" value={countOf(FILTER_MATCH.archived)} hint="VM released, restorable" />
				<Stat label="Failed" value={countOf(FILTER_MATCH.failed)} />
			</StatGrid>
			{all && threads.error !== undefined && <ErrorState error={messageOf(threads.error)} onRetry={threads.refetch} />}
			{body}
		</div>
	);
}

/** Per-phase counts of one repository's threads. */
function GroupBadges({ threads }: { threads: readonly ThreadSummaryView[] }) {
	const waiting = threads.filter(thread => thread.phase === "waiting").length;
	const working = threads.filter(thread => thread.phase === "working" || thread.phase === "starting").length;
	const failed = threads.filter(thread => thread.phase === "failed").length;
	const archived = threads.filter(thread => thread.archivedAt !== null).length;
	return (
		<span className="row">
			{working > 0 && <Badge tone="accent">{working} active</Badge>}
			{waiting > 0 && <Badge tone="warn">{waiting} waiting</Badge>}
			{failed > 0 && <Badge tone="bad">{failed} failed</Badge>}
			{archived > 0 && <Badge>{archived} archived</Badge>}
		</span>
	);
}
