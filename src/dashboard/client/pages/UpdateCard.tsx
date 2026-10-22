/** Settings' "Updates" card: where the service's own update stands, its mode, and the components an update touches. */
import { useState } from "react";
import { putSettings, type UpdateMode, type UpdateStatus } from "../api";
import { Markdown } from "../app/Markdown";
import { checkedText, vmonRow } from "../app/update";
import { useUpdate } from "../app/update-context";
import { dateTime } from "../format";
import { Badge, Card, ErrorState, KeyValues, Modal, Segmented, type SegmentedOption } from "../kit/ui";
import { describe } from "./access-errors";
import "./access.css";

const MODES: readonly SegmentedOption<UpdateMode>[] = [
	{ value: "off", label: "Off", title: "Never checks on its own" },
	{ value: "notify", label: "Notify", title: "Checks and downloads in the background; you restart to update" },
	{ value: "auto", label: "Auto", title: "Also installs by itself when that needs no downtime" },
];

/** One sentence per mode; auto's is the caveat. */
const MODE_TEXT: Record<UpdateMode, string> = {
	off: "Nothing is checked until you press Check for updates.",
	notify: "Checks every hour and downloads in the background; you restart to update from the header.",
	auto: "Installs by itself only when no thread is starting, working or waiting and none has been for 10 minutes, and the release needs the same vibemon and database schema; otherwise it waits for your click.",
};

const CHECKOUT = "This omp-cloud runs from a git checkout; update it with git pull and restart it.";

/** The headline of the card: what the service is doing about updates right now. */
function headline(status: UpdateStatus, now: number): string {
	const latest = status.latest?.version ?? "";
	switch (status.state) {
		case "checking":
			return "Checking for updates…";
		case "downloading":
			return `Downloading ${latest}…`;
		case "ready":
			return `${status.staged ?? latest} is ready · Restart to update, in the header`;
		case "applying":
			return `Updating to ${status.applying?.version ?? latest}…`;
		case "failed":
			return `Update failed: ${status.error ?? status.last?.message ?? "unknown error"}`;
		case "unsupported":
			return "Updates are not available here";
		case "idle":
			return `Up to date · ${checkedText(status, now)}`;
	}
}

export function UpdateCard({ onModeChanged }: { onModeChanged: () => void }) {
	const { status, failure, busy, check, refetch } = useUpdate();
	const [modeBusy, setModeBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reading, setReading] = useState(false);

	async function setMode(mode: UpdateMode): Promise<void> {
		setModeBusy(true);
		try {
			await putSettings({ "update.mode": mode });
			setError(null);
			refetch();
			onModeChanged();
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setModeBusy(false);
		}
	}

	if (status === undefined) {
		return (
			<Card title="Updates" description={failure === null ? "Checking where the service stands…" : "The service did not report its update status"}>
				{failure !== null && <ErrorState error={failure} />}
				{error !== null && <ErrorState error={error} />}
			</Card>
		);
	}

	const now = Date.now();
	const vmon = vmonRow(status.components.vmon);
	const omp = status.components.omp;
	const differs = (version: string | null): boolean => version !== null && version !== omp.host;
	const ompItem = (key: string, label: string, version: string | null) => ({
		key,
		label,
		value:
			version === null ? (
				"not running"
			) : (
				<span className="row" style={{ gap: 8 }}>
					<span>{version}</span>
					{differs(version) && <Badge tone="warn">restarts on update</Badge>}
				</span>
			),
	});
	const items = [
		{
			key: "service",
			label: "Service",
			value: (
				<span title={`build ${status.current.build.id}${status.current.build.commit ? ` · ${status.current.build.commit.slice(0, 8)}` : ""}`}>
					{status.current.version} · {status.managed ? "managed install" : "git checkout"}
				</span>
			),
		},
		{
			key: "latest",
			label: "Latest release",
			value: status.latest ? `${status.latest.version} · ${dateTime(status.latest.publishedAt)}` : "none seen yet",
		},
		{
			key: "vmon",
			label: "vibemon",
			value: (
				<span className="row" style={{ gap: 8 }}>
					<span>{vmon.text}</span>
					{vmon.tone === "warn" && <Badge tone="warn">update needed</Badge>}
				</span>
			),
		},
		ompItem("omp-host", "omp (host)", omp.host),
		ompItem("omp-broker", "omp (broker)", omp.broker),
		ompItem("omp-gateway", "omp (gateway)", omp.gateway),
	];
	const notes = status.latest?.notes.trim() ?? "";

	return (
		<Card
			title="Updates"
			description={headline(status, now)}
			actions={
				<span className="row">
					{notes !== "" && (
						<button type="button" className="btn" data-size="sm" onClick={() => setReading(true)}>
							Release notes
						</button>
					)}
					<button
						type="button"
						className="btn"
						data-size="sm"
						disabled={busy || status.state === "checking" || status.state === "applying" || status.state === "unsupported"}
						onClick={() => void check()}
					>
						Check for updates
					</button>
				</span>
			}
		>
			<div className="access-stack">
				{status.state === "unsupported" && <p className="access-fine">{status.message ?? CHECKOUT}</p>}
				{status.state === "failed" && status.last?.result === "failed" && status.last.message !== "" && (
					<p className="access-fine">{status.last.message}</p>
				)}
				<div className="access-stack">
					<span className="cell-primary">Update mode</span>
					<div>
						<Segmented options={MODES} value={status.mode} onChange={mode => void setMode(mode)} size="sm" aria-label="Update mode" />
					</div>
					<p className="access-fine" style={{ margin: 0 }}>
						{MODE_TEXT[status.mode]}
					</p>
					{modeBusy && <span className="access-fine">Saving…</span>}
					{error !== null && <ErrorState error={error} />}
				</div>
				<div className="update-facts">
					<KeyValues items={items} />
				</div>
			</div>
			{status.latest && (
				<Modal open={reading} title={`omp-cloud ${status.latest.version}`} onClose={() => setReading(false)} cancelLabel="Close">
					<Markdown className="update-notes" source={notes} />
				</Modal>
			)}
		</Card>
	);
}
