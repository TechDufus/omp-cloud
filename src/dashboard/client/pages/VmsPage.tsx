/** The sandboxes behind the threads, with live metrics when vmon reports them. */
import { ExternalLink, RotateCw } from "lucide-react";
import { useMemo } from "react";
import { getCapacity, getVms, type VmEntry, type VmsReport } from "../api";
import type { PageProps } from "../app/page";
import { useQuery } from "../app/query";
import { useSession } from "../app/session";
import { formatInteger, formatPercent } from "../kit/data/formatters";
import {
	Badge,
	Card,
	type Column,
	EmptyState,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	Skeleton,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
	type Tone,
} from "../kit/ui";
import { ago, bytes, safeHref } from "../format";
import { CapacityCard } from "./CapacityCard";

const REFRESH_MS = 10_000;
const MIB = 1024 * 1024;

const STATE_TONE: Record<string, Tone> = { running: "ok", paused: "warn" };

const COLUMNS: Column<VmEntry>[] = [
	{
		key: "thread",
		header: "Thread",
		sort: vm => vm.thread,
		render: vm => (
			<a className="mono" href={`#/threads/${encodeURIComponent(vm.thread)}`}>
				{vm.thread}
			</a>
		),
	},
	{
		key: "state",
		header: "State",
		sort: vm => vm.state,
		render: vm => (vm.state ? <Badge tone={STATE_TONE[vm.state] ?? "neutral"}>{vm.state}</Badge> : "—"),
	},
	{
		key: "sandbox",
		header: "Sandbox",
		sort: vm => vm.sandboxId,
		render: vm => (
			<LabelCell
				primary={<span className="mono">{vm.sandboxId || "—"}</span>}
				secondary={vm.pid === null ? undefined : `pid ${vm.pid}`}
			/>
		),
	},
	{
		key: "started",
		header: "Started",
		sort: vm => vm.startedAt,
		render: vm => ago(vm.startedAt),
	},
	{
		key: "cpu",
		header: "CPU",
		align: "right",
		width: 190,
		sort: vm => vm.metrics?.cpuUsedPct ?? -1,
		render: vm =>
			vm.metrics ? (
				<MeterCell
					value={vm.metrics.cpuUsedPct}
					max={100}
					display={`${vm.metrics.cpuUsedPct.toFixed(0)}% of ${formatInteger(vm.cpuCount)}`}
				/>
			) : (
				<span className="num">{vm.cpuCount > 0 ? `${formatInteger(vm.cpuCount)} vCPU` : "n/a"}</span>
			),
	},
	{
		key: "memory",
		header: "Memory",
		align: "right",
		width: 220,
		sort: vm => (vm.metrics && vm.metrics.memTotal > 0 ? vm.metrics.memUsed / vm.metrics.memTotal : -1),
		render: vm =>
			vm.metrics ? (
				<MeterCell
					value={vm.metrics.memUsed}
					max={vm.metrics.memTotal}
					display={`${bytes(vm.metrics.memUsed)} / ${bytes(vm.metrics.memTotal)}`}
				/>
			) : (
				<span className="num">{vm.memoryMB > 0 ? `${formatInteger(vm.memoryMB)} MiB` : "n/a"}</span>
			),
	},
	{
		key: "disk",
		header: "Disk",
		align: "right",
		width: 220,
		sort: vm => (vm.metrics && vm.metrics.diskTotal > 0 ? vm.metrics.diskUsed / vm.metrics.diskTotal : -1),
		render: vm =>
			vm.metrics ? (
				<MeterCell
					value={vm.metrics.diskUsed}
					max={vm.metrics.diskTotal}
					display={`${bytes(vm.metrics.diskUsed)} / ${bytes(vm.metrics.diskTotal)}`}
				/>
			) : (
				<span className="num">n/a</span>
			),
	},
];

export function VmsPage({ active }: PageProps) {
	const query = useQuery(["vms"], () => getVms(), { enabled: active, refetchMs: REFRESH_MS });
	const capacity = useQuery(["capacity"], () => getCapacity(), { enabled: active, refetchMs: REFRESH_MS });
	const { identity } = useSession();
	const isEmpty = (data: VmsReport) => data.vms.length === 0;
	const empty = <EmptyState title="No VMs" hint="A sandbox appears here once a thread starts one." />;
	const vmonHref = useMemo(() => (query.data ? safeHref(query.data.vmonDashboard) : null), [query.data]);

	return (
		<div className="page">
			<PageHeader
				title="VMs"
				description={`Your cloud's machines as one pool, and the VMs on it. Metrics refresh every ${REFRESH_MS / 1000} s.`}
				actions={
					<>
						{identity.device === null && vmonHref !== null && (
							<a className="btn" data-size="sm" data-variant="ghost" href={vmonHref} target="_blank" rel="noreferrer noopener" title="Terminals, files and logs of the VMs">
								vmon dashboard <ExternalLink size={13} />
							</a>
						)}
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							onClick={() => {
								query.refetch();
								capacity.refetch();
							}}
						>
							<RotateCw size={13} /> Refresh
						</button>
					</>
				}
			/>

			<CapacityCard query={capacity} />

			<QueryView
				query={query}
				skeleton={<Skeleton height={112} style={{ borderRadius: 12 }} />}
				isEmpty={isEmpty}
				empty={empty}
			>
				{data => <VmStats vms={data.vms} />}
			</QueryView>

			<Card index={1} title="Sandboxes" description="One per thread, with live usage while vmon reports it" flush>
				<QueryView query={query} skeleton={<TableSkeleton rows={4} />} isEmpty={isEmpty} empty={empty}>
					{data => (
						<Table
							rows={data.vms}
							rowKey={vm => vm.thread}
							columns={COLUMNS}
							initialSort={{ key: "started", dir: "desc" }}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function VmStats({ vms }: { vms: readonly VmEntry[] }) {
	const running = vms.filter(vm => vm.state === "running").length;
	const paused = vms.filter(vm => vm.state === "paused").length;
	const cpuCount = vms.reduce((sum, vm) => sum + vm.cpuCount, 0);
	const cpuBusy = vms.reduce((sum, vm) => sum + (vm.metrics ? (vm.metrics.cpuUsedPct / 100) * vm.cpuCount : 0), 0);
	const metered = vms.filter(vm => vm.metrics !== null);
	const memUsed = metered.reduce((sum, vm) => sum + (vm.metrics?.memUsed ?? 0), 0);
	const memTotal = vms.reduce((sum, vm) => sum + (vm.metrics ? vm.metrics.memTotal : vm.memoryMB * MIB), 0);
	return (
		<StatGrid min={180}>
			<Stat label="Running" value={formatInteger(running)} hint={`of ${formatInteger(vms.length)} VMs`} />
			<Stat label="Paused" value={formatInteger(paused)} hint={`of ${formatInteger(vms.length)} VMs`} />
			<Stat
				label="CPU"
				title="Allocated vCPUs across all VMs; busy cores come from the live metrics"
				value={`${formatInteger(cpuCount)} vCPU`}
				hint={
					metered.length > 0
						? `${cpuBusy.toFixed(1)} busy (${formatPercent(cpuCount > 0 ? cpuBusy / cpuCount : 0, 0)})`
						: "no live metrics"
				}
			/>
			<Stat
				label="Memory"
				title="Allocated memory across all VMs; used memory comes from the live metrics"
				value={bytes(memTotal)}
				hint={metered.length > 0 ? `${bytes(memUsed)} used` : "no live metrics"}
			/>
		</StatGrid>
	);
}
