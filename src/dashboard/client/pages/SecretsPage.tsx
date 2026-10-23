/** Secrets the service delivers to cloud agents as environment variables: the list, an add/replace form and delete. A value is never shown. */
import { RotateCw } from "lucide-react";
import { useState } from "react";
import { deleteSecret, getSecrets, putSecret, type Secret } from "../api";
import type { PageProps } from "../app/page";
import { useQuery } from "../app/query";
import { useAccess } from "../app/session";
import { ago } from "../format";
import { Badge, Card, type Column, ErrorState, Modal, PageHeader, QueryView, Table, TableSkeleton } from "../kit/ui";
import { describe, readable } from "./access-errors";
import "./access.css";
import { LockedPage } from "./FullAccessNotice";

/** One glob per line; commas also separate, since a pasted list often uses them. */
function parseRepos(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map(line => line.trim())
		.filter(line => line !== "");
}

interface FormProps {
	/** A secret picked for replacement: its name and repositories fill the form; the value is never known here. */
	replacing: Secret | null;
	onSaved: (secret: Secret) => void;
}

/** Add or replace a secret. Saving a name that exists replaces its value and repositories. */
function SecretForm({ replacing, onSaved }: FormProps) {
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [repos, setRepos] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [picked, setPicked] = useState<Secret | null>(null);

	// A new pick of a row to replace loads its name and repositories (adjusted during render, not in an effect).
	if (replacing !== picked) {
		setPicked(replacing);
		if (replacing !== null) {
			setName(replacing.name);
			setRepos(replacing.repos.join("\n"));
			setValue("");
			setError(null);
		}
	}

	async function save(): Promise<void> {
		const secretName = name.trim();
		const globs = parseRepos(repos);
		if (secretName === "") {
			setError("Name the environment variable.");
			return;
		}
		if (value === "") {
			setError("Enter the value, or a !command that prints it.");
			return;
		}
		if (globs.length === 0) {
			setError("List the repositories the secret goes to, one glob per line; * means all.");
			return;
		}
		setBusy(true);
		try {
			const secret = await putSecret(secretName, value, globs);
			setName("");
			setValue("");
			setRepos("");
			setError(null);
			onSaved(secret);
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card
			title={replacing === null ? "Add a secret" : `Replace ${replacing.name}`}
			description="A value starting with ! is a command the service runs when a thread starts; its output is the value. Saving an existing name replaces it."
		>
			<div className="access-stack">
				<div className="access-fields">
					<input
						className="input"
						type="text"
						placeholder="NAME"
						autoComplete="off"
						spellCheck={false}
						value={name}
						onChange={event => setName(event.target.value)}
						aria-label="Environment variable name"
					/>
					<input
						className="input"
						type="password"
						style={{ flex: "1 1 260px" }}
						placeholder="value, or !command"
						autoComplete="new-password"
						spellCheck={false}
						value={value}
						onChange={event => setValue(event.target.value)}
						aria-label="Secret value"
					/>
				</div>
				<div className="access-stack" style={{ gap: 6 }}>
					<textarea
						className="input"
						rows={3}
						placeholder="* or github.com/owner/*"
						autoComplete="off"
						spellCheck={false}
						value={repos}
						onChange={event => setRepos(event.target.value)}
						aria-label="Repositories"
					/>
					<p className="access-fine" style={{ margin: 0 }}>
						Repositories, one glob per line: <span className="mono">github.com/owner/repo</span>, <span className="mono">github.com/owner/*</span>, or{" "}
						<span className="mono">*</span> for every thread. A repository with no match never receives the secret. Threads without a remote match as{" "}
						<span className="mono">local/&lt;name&gt;</span>.
					</p>
				</div>
				<div className="access-actions">
					<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void save()}>
						{busy ? "Saving…" : replacing === null ? "Save secret" : "Replace secret"}
					</button>
				</div>
				{error !== null && <ErrorState error={error} />}
			</div>
		</Card>
	);
}

function SecretsContent({ active }: PageProps) {
	const secrets = useQuery(["secrets"], () => readable(getSecrets()), { enabled: active });
	const [replacing, setReplacing] = useState<Secret | null>(null);
	const [deleting, setDeleting] = useState<Secret | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	async function remove(secret: Secret): Promise<void> {
		setDeleteBusy(true);
		try {
			await deleteSecret(secret.name);
			setNotice(`Deleted ${secret.name}. Running threads keep what they already received.`);
			setDeleting(null);
			setDeleteError(null);
			if (replacing?.name === secret.name) setReplacing(null);
			secrets.refetch();
		} catch (failure) {
			setDeleteError(describe(failure));
		} finally {
			setDeleteBusy(false);
		}
	}

	const columns: readonly Column<Secret>[] = [
		{ key: "name", header: "Name", sort: secret => secret.name, render: secret => <span className="mono">{secret.name}</span> },
		{
			key: "repos",
			header: "Repositories",
			render: secret => (
				<span className="row" style={{ flexWrap: "wrap", gap: 4 }}>
					{secret.repos.map(repo => (
						<Badge key={repo}>{repo}</Badge>
					))}
				</span>
			),
		},
		{
			key: "kind",
			header: "Kind",
			sort: secret => secret.kind,
			render: secret => (secret.kind === "command" ? <Badge tone="accent">command</Badge> : <Badge>value</Badge>),
		},
		{
			key: "updated",
			header: "Updated",
			sort: secret => secret.updatedAt,
			render: secret => (secret.updatedBy === "" ? ago(secret.updatedAt) : `${ago(secret.updatedAt)} by ${secret.updatedBy}`),
		},
		{
			key: "actions",
			header: "",
			align: "right",
			render: secret => (
				<span className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
					<button
						type="button"
						className="btn"
						data-size="sm"
						onClick={() => {
							setNotice(null);
							setReplacing(secret);
						}}
					>
						Replace
					</button>
					<button
						type="button"
						className="btn"
						data-size="sm"
						data-variant="danger"
						onClick={() => {
							setDeleteError(null);
							setDeleting(secret);
						}}
					>
						Delete
					</button>
				</span>
			),
		},
	];

	return (
		<div className="page">
			<PageHeader
				title="Secrets"
				description="Environment variables for cloud agents, set once here. A thread gets only the secrets whose repositories match its own; nothing goes to a thread by default."
				actions={
					<button type="button" className="btn" data-size="sm" data-variant="ghost" onClick={secrets.refetch}>
						<RotateCw size={13} /> Refresh
					</button>
				}
			/>
			<SecretForm
				replacing={replacing}
				onSaved={secret => {
					setNotice(`Saved ${secret.name}. Threads that start from now on receive it.`);
					setReplacing(null);
					secrets.refetch();
				}}
			/>
			<Card title="Stored secrets" flush footer={notice === null ? undefined : <span className="access-ok">{notice}</span>}>
				<QueryView query={secrets} skeleton={<TableSkeleton rows={4} />}>
					{rows => <Table columns={columns} rows={rows} rowKey={secret => secret.name} empty="No secrets yet." />}
				</QueryView>
			</Card>
			<Modal
				open={deleting !== null}
				title="Delete secret"
				onClose={() => setDeleting(null)}
				primaryAction={{
					label: deleteBusy ? "Deleting…" : "Delete",
					onClick: () => {
						if (deleting) void remove(deleting);
					},
					disabled: deleteBusy,
				}}
			>
				<div className="access-stack">
					<p>
						Delete <span className="mono">{deleting?.name}</span>? Threads that start later no longer receive it.
					</p>
					{deleteError !== null && <ErrorState error={deleteError} />}
				</div>
			</Modal>
		</div>
	);
}

export function SecretsPage(props: PageProps) {
	if (useAccess() === "threads") {
		return (
			<LockedPage
				title="Secrets"
				description="Environment variables for cloud agents, set once here. A thread gets only the secrets whose repositories match its own; nothing goes to a thread by default."
			/>
		);
	}
	return <SecretsContent {...props} />;
}
