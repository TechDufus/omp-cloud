/** The settings store: one editor per key, the audit trail, and YAML export and import. */
import { useState } from "react";
import { type AuditEntry, type AuditPage, getAudit, getSettings, importSettings, putSettings, SETTINGS_EXPORT_PATH, type Setting } from "../api";
import type { PageProps } from "../app/page";
import { messageOf, useQuery } from "../app/query";
import { dateTime } from "../format";
import { Badge, Card, type Column, ErrorState, Modal, PageHeader, QueryView, Segmented, Table, TableSkeleton } from "../kit/ui";
import { describe, readable } from "./access-errors";
import "./access.css";
import { UpdateCard } from "./UpdateCard";

type ImportMode = "replace" | "merge";

const IMPORT_MODES = [
	{ value: "replace", label: "Replace all", title: "Replace all stored settings; keys missing from the YAML go back to their defaults" },
	{ value: "merge", label: "Merge", title: "Merge into the stored settings" },
] as const;

const AUDIT_TONE: Record<AuditEntry["action"], "accent" | "warn" | "neutral"> = { set: "accent", reset: "warn", import: "neutral" };

/** Enums with at most this many choices render as a segmented control, longer ones as a select. */
const SEGMENTED_MAX = 4;

/** The update card above the list owns this setting's editor. */
const UPDATE_MODE_KEY = "update.mode";

/** A value as shown in text: lists comma-separated, strings bare, the rest as JSON. */
function display(value: unknown): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return "(empty)";
		return value.every(item => typeof item === "string") ? value.join(", ") : JSON.stringify(value);
	}
	if (typeof value === "string") return value === "" ? "(empty)" : value;
	return JSON.stringify(value) ?? "";
}

/** The editor's starting text for a setting; booleans keep their state apart in a checkbox. */
function initialText(setting: Setting): string {
	const { value } = setting;
	switch (setting.type) {
		case "enum":
			return String(value);
		case "string[]":
			return Array.isArray(value) ? value.join("\n") : "";
		case "number":
			return typeof value === "number" ? String(value) : "";
		case "json":
			return JSON.stringify(value, null, 2);
		default:
			return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	}
}

/** The value an editor holds, parsed by the setting's registry type. Throws an `Error` for an unparsable entry. */
function readValue(setting: Setting, text: string, checked: boolean): unknown {
	switch (setting.type) {
		case "bool":
			return checked;
		case "string[]":
			return text
				.split("\n")
				.map(line => line.trim())
				.filter(line => line !== "");
		case "number":
			if (text.trim() === "" || Number.isNaN(Number(text))) throw new Error(`${setting.key} needs a number`);
			return Number(text);
		case "json":
			try {
				return JSON.parse(text);
			} catch (failure) {
				throw new Error(`${setting.key} is not valid JSON: ${messageOf(failure)}`);
			}
		default:
			return text;
	}
}

interface EditorProps {
	setting: Setting;
	text: string;
	checked: boolean;
	onText: (text: string) => void;
	onChecked: (checked: boolean) => void;
}

/** The control for a setting, chosen by its registry type: enum, one entry per line (string[]), checkbox (bool), number, JSON textarea (json) or text. */
function Editor({ setting, text, checked, onText, onChecked }: EditorProps) {
	switch (setting.type) {
		case "enum":
			if (setting.choices.length <= SEGMENTED_MAX) {
				return (
					<Segmented
						options={setting.choices.map(choice => ({ value: choice, label: choice }))}
						value={text}
						onChange={onText}
						aria-label={setting.key}
					/>
				);
			}
			return (
				<select className="input" value={text} onChange={event => onText(event.target.value)} aria-label={setting.key}>
					{setting.choices.map(choice => (
						<option key={choice} value={choice}>
							{choice}
						</option>
					))}
				</select>
			);
		case "string[]":
			return (
				<textarea
					className="input"
					rows={4}
					placeholder="One per line"
					value={text}
					onChange={event => onText(event.target.value)}
					aria-label={setting.key}
				/>
			);
		case "bool":
			return (
				<label className="check">
					<input type="checkbox" checked={checked} onChange={event => onChecked(event.target.checked)} />
					enabled
				</label>
			);
		case "number":
			return (
				<input
					className="input"
					type="number"
					step="any"
					min={0}
					value={text}
					onChange={event => onText(event.target.value)}
					aria-label={setting.key}
				/>
			);
		case "json":
			return (
				<textarea
					className="input"
					rows={8}
					spellCheck={false}
					placeholder="JSON"
					value={text}
					onChange={event => onText(event.target.value)}
					aria-label={setting.key}
				/>
			);
		default:
			return <input className="input mono" type="text" value={text} onChange={event => onText(event.target.value)} aria-label={setting.key} />;
	}
}

/** One setting: its documentation, editor, Save and Reset. Remounted (via `key`) when the stored value changes, so the draft restarts from it. */
function SettingCard({ setting, onApplied }: { setting: Setting; onApplied: () => void }) {
	const [text, setText] = useState(() => initialText(setting));
	const [checked, setChecked] = useState(setting.value === true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const stored = setting.source === "stored";

	async function apply(read: () => unknown): Promise<void> {
		let value: unknown;
		try {
			value = read();
		} catch (failure) {
			setError(messageOf(failure));
			return;
		}
		setBusy(true);
		try {
			await putSettings({ [setting.key]: value });
			setError(null);
			onApplied();
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card
			title={<span className="access-title-mono">{setting.key}</span>}
			description={setting.doc}
			actions={<Badge tone={stored ? "accent" : "neutral"}>{setting.source}</Badge>}
			footer={
				<span className="access-fine">
					Default: {display(setting.default)}
					{stored && setting.updatedAt ? ` · changed by ${setting.updatedBy} on ${dateTime(setting.updatedAt)}` : ""}
				</span>
			}
		>
			<div className="access-stack">
				<div>
					<Editor setting={setting} text={text} checked={checked} onText={setText} onChecked={setChecked} />
				</div>
				<div className="access-actions">
					<button
						type="button"
						className="btn"
						data-variant="primary"
						disabled={busy}
						onClick={() => void apply(() => readValue(setting, text, checked))}
					>
						Save
					</button>
					<button type="button" className="btn" disabled={busy || !stored} onClick={() => void apply(() => null)}>
						Reset to default
					</button>
				</div>
				{error !== null && <ErrorState error={error} />}
			</div>
		</Card>
	);
}

/** Paste or load YAML and import it, merging into or replacing the stored settings. */
function ImportCard({ onImported }: { onImported: () => void }) {
	const [yaml, setYaml] = useState("");
	const [mode, setMode] = useState<ImportMode>("replace");
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);

	async function run(): Promise<void> {
		setConfirming(false);
		setBusy(true);
		try {
			await importSettings(yaml, mode);
			setError(null);
			setYaml("");
			onImported();
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setBusy(false);
		}
	}

	function submit(): void {
		if (yaml.trim() === "") {
			setError("Paste YAML or choose a file.");
			return;
		}
		if (mode === "replace") setConfirming(true);
		else void run();
	}

	async function load(file: File | undefined): Promise<void> {
		if (!file) return;
		try {
			setYaml(await file.text());
			setError(null);
		} catch (failure) {
			setError(messageOf(failure));
		}
	}

	return (
		<Card title="Import YAML" description="Paste YAML or load a file, for example one exported from here.">
			<div className="access-stack">
				<input
					className="access-file"
					type="file"
					accept=".yaml,.yml,text/yaml,text/plain"
					aria-label="YAML file"
					onChange={event => {
						const input = event.currentTarget;
						void load(input.files?.[0]).then(() => {
							input.value = "";
						});
					}}
				/>
				<textarea
					className="input"
					rows={8}
					spellCheck={false}
					placeholder={"git:\n  push: ask\n  protected:\n    - main\n    - release/*"}
					value={yaml}
					onChange={event => setYaml(event.target.value)}
					aria-label="Settings YAML"
				/>
				<div className="access-actions">
					<Segmented options={IMPORT_MODES} value={mode} onChange={setMode} aria-label="Import mode" />
					<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={submit}>
						Import
					</button>
				</div>
				{error !== null && <ErrorState error={error} />}
			</div>
			<Modal
				open={confirming}
				title="Replace all stored settings?"
				onClose={() => setConfirming(false)}
				primaryAction={{ label: "Replace", onClick: () => void run() }}
			>
				<p className="muted">Keys missing from this YAML go back to their defaults. Every change is audited.</p>
			</Modal>
		</Card>
	);
}

const AUDIT_COLUMNS: readonly Column<AuditEntry>[] = [
	{ key: "at", header: "When", render: entry => <time dateTime={entry.at}>{dateTime(entry.at)}</time> },
	{ key: "action", header: "Action", render: entry => <Badge tone={AUDIT_TONE[entry.action]}>{entry.action}</Badge> },
	{ key: "key", header: "Key", render: entry => <span className="mono">{entry.key}</span> },
	{
		key: "change",
		header: "Change",
		wrap: true,
		render: entry => `${entry.old === null ? "default" : display(entry.old)} → ${entry.new === null ? "default" : display(entry.new)}`,
	},
	{ key: "actor", header: "By", render: entry => <span className="muted">{entry.actor}</span> },
];

export function SettingsPage({ active }: PageProps) {
	const [epoch, setEpoch] = useState(0);
	/** Audit pages after the first, appended by "Older changes". */
	const [older, setOlder] = useState<AuditPage | null>(null);
	const [olderBusy, setOlderBusy] = useState(false);
	const [olderError, setOlderError] = useState<string | null>(null);

	const settings = useQuery(["settings"], () => readable(getSettings()), { enabled: active });
	const audit = useQuery(["audit", epoch], () => readable(getAudit(null)), { enabled: active });

	const entries = [...(audit.data?.entries ?? []), ...(older?.entries ?? [])];
	const next = older ? older.next : (audit.data?.next ?? 0);

	/** Reloads the settings and restarts the audit list from the newest change. */
	function applied(): void {
		settings.refetch();
		setOlder(null);
		setEpoch(value => value + 1);
	}

	async function loadOlder(): Promise<void> {
		setOlderBusy(true);
		try {
			const page = await getAudit(next);
			setOlder({ entries: [...(older?.entries ?? []), ...page.entries], next: page.next });
			setOlderError(null);
		} catch (failure) {
			setOlderError(describe(failure));
		} finally {
			setOlderBusy(false);
		}
	}

	return (
		<div className="page">
			<PageHeader
				title="Settings"
				description="Stored values override the defaults for new threads. Every change is audited."
				actions={
					<a className="btn" href={SETTINGS_EXPORT_PATH} download="omp-cloud-settings.yaml">
						Export YAML
					</a>
				}
			/>
			<UpdateCard onModeChanged={applied} />
			<QueryView query={settings} skeleton={<TableSkeleton rows={8} />}>
				{rows => (
					<div className="grid grid-2">
						{rows
							.filter(setting => setting.key !== UPDATE_MODE_KEY)
							.map(setting => (
								<SettingCard key={`${setting.key}:${setting.source}:${setting.updatedAt}`} setting={setting} onApplied={applied} />
							))}
					</div>
				)}
			</QueryView>
			<ImportCard onImported={applied} />
			<Card
				title="Audit"
				flush
				footer={
					next === 0 ? undefined : (
						<button type="button" className="btn" disabled={olderBusy} onClick={() => void loadOlder()}>
							Older changes
						</button>
					)
				}
			>
				{olderError !== null && <ErrorState error={olderError} />}
				<QueryView query={audit} skeleton={<TableSkeleton />}>
					{() => <Table columns={AUDIT_COLUMNS} rows={entries} rowKey={entry => entry.seq} empty="No changes yet." />}
				</QueryView>
			</Card>
		</div>
	);
}
