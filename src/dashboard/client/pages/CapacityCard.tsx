/** The VMs page's first card: the vibemon cluster as one pool, its last hour, its machines and how to add one. */
import { useState } from "react";
import type { Capacity, CapacityMachine } from "../api";
import type { QueryState } from "../app/query";
import { gib } from "../format";
import { Chart } from "../kit/charts";
import { formatInteger } from "../kit/data/formatters";
import { Badge, Card, type Column, EmptyState, MeterCell, QueryView, Skeleton, Stat, StatGrid, Table, type Tone } from "../kit/ui";
import "./capacity.css";

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = { idle: "Copy", copied: "Copied", failed: "Copy failed: select the command" };

const STATUS_TONE: Record<string, Tone> = { ready: "ok", suspect: "warn", dead: "bad", left: "bad" };

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** The machines table, closed by default: one row per vibemon machine, the server first. */
function Machines({ capacity }: { capacity: Capacity }) {
	const serverVersion = capacity.members.find(member => member.server)?.version ?? "";
	const columns: readonly Column<CapacityMachine>[] = [
		{
			key: "hostname",
			header: "Machine",
			sort: member => member.hostname,
			render: member => (
				<span className="row">
					{member.hostname}
					{member.server && <Badge tone="accent">server</Badge>}
				</span>
			),
		},
		{ key: "status", header: "Status", sort: member => member.status, render: member => <Badge tone={STATUS_TONE[member.status] ?? "neutral"}>{member.status}</Badge> },
		{
			key: "version",
			header: "vibemon",
			sort: member => member.version,
			render: member =>
				member.version === "" ? (
					"—"
				) : (
					<span title={member.version === serverVersion ? undefined : `The server runs ${serverVersion}`}>
						<Badge tone={member.version === serverVersion ? "neutral" : "warn"} mono>
							{member.version}
						</Badge>
					</span>
				),
		},
		{
			key: "cpu",
			header: "vCPU",
			align: "right",
			width: 190,
			sort: member => member.vcpusAllocated,
			render: member => <MeterCell value={member.vcpusAllocated} max={member.vcpus} display={`${formatInteger(member.vcpusAllocated)} of ${formatInteger(member.vcpus)}`} />,
		},
		{
			key: "memory",
			header: "Memory",
			align: "right",
			width: 220,
			sort: member => member.memoryAllocatedMB,
			render: member => (
				<MeterCell value={member.memoryAllocatedMB} max={member.memoryMB} display={`${gib(member.memoryAllocatedMB)} of ${gib(member.memoryMB)} GiB`} />
			),
		},
		{ key: "vms", header: "VMs", align: "right", sort: member => member.vms, render: member => formatInteger(member.vms) },
	];
	return (
		<details className="capacity-machines">
			<summary>Machines ({capacity.members.length})</summary>
			<Table columns={columns} rows={capacity.members} rowKey={member => member.hostname} dense />
		</details>
	);
}

/** "Add a machine": the join command to copy when the server takes other machines, else the one setup step that makes it so. */
function AddMachine({ capacity }: { capacity: Capacity }) {
	const [copied, setCopied] = useState<CopyState>("idle");
	const { accepting, joinCommand } = capacity.cluster;

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(joinCommand);
			setCopied("copied");
		} catch {
			setCopied("failed");
		}
		window.setTimeout(() => setCopied("idle"), 2000);
	}

	return (
		<div className="capacity-add">
			<span className="cell-primary">Add a machine</span>
			{accepting ? (
				<div className="capacity-join">
					<code className="capacity-command">{joinCommand}</code>
					<button type="button" className="btn" data-size="sm" onClick={() => void copy()}>
						{COPY_LABEL[copied]}
					</button>
				</div>
			) : (
				<p className="access-fine" style={{ margin: 0 }}>
					Run <code>omp-cloud setup --cluster-address &lt;this server's LAN address&gt;</code> on the server once, then on the new machine run the join command it shows here.
				</p>
			)}
		</div>
	);
}

function CapacityBody({ capacity }: { capacity: Capacity }) {
	const { vcpus, memoryMB, machines, vms, history } = capacity;
	const sparkOf = (pick: (point: Capacity["history"][number]) => number): number[] | undefined => (history.length > 1 ? history.map(pick) : undefined);
	return (
		<div className="capacity-body">
			<StatGrid min={170}>
				<Stat
					label="vCPU"
					title="vCPUs of the VMs running on the cluster's machines, against all their CPUs"
					value={`${formatInteger(vcpus.allocated)} of ${formatInteger(vcpus.total)}`}
					spark={sparkOf(point => point.vcpusAllocated)}
					sparkColor="var(--chart-primary)"
				/>
				<Stat
					label="Memory"
					title="Memory of the VMs running on the cluster's machines, against all of it"
					value={`${gib(memoryMB.allocated)} of ${gib(memoryMB.total)} GiB`}
					spark={sparkOf(point => point.memoryAllocatedMB)}
					sparkColor="var(--chart-secondary)"
				/>
				<Stat label="Disk free" value={`${gib(capacity.diskFreeMB)} GiB`} />
				<Stat
					label="Machines"
					value={`${formatInteger(machines.ready)} of ${formatInteger(machines.total)} ready`}
					hint={capacity.cluster.versionSkew ? "vibemon versions differ" : undefined}
				/>
				<Stat
					label="VMs"
					title="The omp-cloud team's VMs"
					value={`${formatInteger(vms.cloud.running)} running`}
					hint={`${formatInteger(vms.cloud.paused)} paused · limit ${formatInteger(vms.cloud.limit)} · each ${formatInteger(vms.size.vcpus)} vCPU, ${gib(vms.size.memoryMB)} GiB`}
				/>
			</StatGrid>
			{history.length > 1 && (
				<div className="capacity-chart">
					<span className="cell-secondary">vCPU allocated, last hour</span>
					<Chart
						slots={history.length}
						tickLabel={index => TIME_FORMAT.format(new Date(history[index]?.at ?? 0))}
						series={[{ key: "vcpus", label: "vCPU allocated", color: "var(--chart-primary)", values: history.map(point => point.vcpusAllocated) }]}
						kind="area"
						height={170}
						format={formatInteger}
						references={[{ value: vcpus.total, label: `${formatInteger(vcpus.total)} vCPU` }]}
					/>
				</div>
			)}
			<Machines capacity={capacity} />
		</div>
	);
}

export function CapacityCard({ query }: { query: QueryState<Capacity> }) {
	return (
		<Card title="Capacity" description="Every vibemon machine of the cloud as one pool." footer={query.data?.available ? <AddMachine capacity={query.data} /> : undefined}>
			<QueryView query={query} skeleton={<Skeleton height={112} style={{ borderRadius: 12 }} />}>
				{capacity =>
					capacity.available ? <CapacityBody capacity={capacity} /> : <EmptyState title="Capacity unavailable" hint={`${capacity.problem} ${capacity.fix}`} />
				}
			</QueryView>
		</Card>
	);
}
