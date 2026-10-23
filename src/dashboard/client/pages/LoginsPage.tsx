/** Provider logins for the cloud broker: start, open the sign-in page, paste a redirect or code, follow the state. */
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, cancelLogin, getLogin, getLogins, getWhoami, inputLogin, type Login, type LoginEntry, type LoginList, startLogin } from "../api";
import type { PageProps } from "../app/page";
import { type QueryState, useQuery } from "../app/query";
import { useAccess } from "../app/session";
import { dateTime, safeHref } from "../format";
import { Badge, Card, type Column, EmptyState, ErrorState, LabelCell, PageHeader, QueryView, Table, TableSkeleton, type Tone } from "../kit/ui";
import { describe } from "./access-errors";
import "./access.css";
import { FullAccessNotice } from "./FullAccessNotice";
import { renewTone } from "./logins-view";

const POLL_MS = 2000;

const STATE_TONE: Record<Login["state"], Tone> = { waiting: "warn", done: "ok", failed: "bad" };

/** One polled login; `login` is null when the service forgot it (finished logins stay readable for ten minutes). */
interface LoginPoll {
	id: string;
	login: Login | null;
}

async function pollLogin(id: string): Promise<LoginPoll> {
	try {
		return { id, login: await getLogin(id) };
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return { id, login: null };
		throw error;
	}
}

/** `logins` with every poll applied: changed ones replaced, forgotten ones dropped. The same array when nothing changed. */
function applyPolls(logins: Login[], polls: LoginPoll[]): Login[] {
	let changed = false;
	const next: Login[] = [];
	for (const login of logins) {
		const poll = polls.find(candidate => candidate.id === login.id);
		if (!poll) {
			next.push(login);
		} else if (poll.login === null) {
			changed = true;
		} else if (JSON.stringify(poll.login) !== JSON.stringify(login)) {
			changed = true;
			next.push(poll.login);
		} else {
			next.push(login);
		}
	}
	return changed ? next : logins;
}

interface LoginCardProps {
	login: Login;
	onUpdate: (login: Login) => void;
	onDismiss: () => void;
	onCancelled: () => void;
}

function LoginCard({ login, onUpdate, onDismiss, onCancelled }: LoginCardProps) {
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const href = safeHref(login.url);
	const waiting = login.state === "waiting";

	async function send(): Promise<void> {
		const text = input.trim();
		if (text === "") {
			setError("Paste the redirect URL or the code first.");
			return;
		}
		setBusy(true);
		try {
			onUpdate(await inputLogin(login.id, text));
			setInput("");
			setError(null);
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setBusy(false);
		}
	}

	async function cancel(): Promise<void> {
		try {
			await cancelLogin(login.id);
			onCancelled();
		} catch (failure) {
			setError(describe(failure));
		}
	}

	return (
		<Card
			title={<span className="access-title-mono">{login.provider}</span>}
			actions={<Badge tone={STATE_TONE[login.state]}>{login.state}</Badge>}
		>
			<div className="access-stack">
				{href && (
					<p>
						<a href={href} target="_blank" rel="noreferrer noopener">
							Open the sign-in page
						</a>
					</p>
				)}
				{login.instructions && <p className="muted">{login.instructions}</p>}
				{login.userCode && (
					<div className="stack">
						<span className="dim">Code to enter</span>
						<div className="access-code">{login.userCode}</div>
					</div>
				)}
				{waiting && !login.userCode && (
					<div className="access-fields">
						<input
							className="input"
							type="text"
							placeholder="Paste the redirect URL or the code"
							autoComplete="off"
							value={input}
							onChange={event => setInput(event.target.value)}
							onKeyDown={event => {
								if (event.key === "Enter" && !busy) void send();
							}}
						/>
						<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void send()}>
							Send
						</button>
					</div>
				)}
				{login.account && <p>Signed in as {login.account}</p>}
				{login.error && <ErrorState error={login.error} />}
				<div className="access-actions">
					{waiting ? (
						<button type="button" className="btn" onClick={() => void cancel()}>
							Cancel
						</button>
					) : (
						<button type="button" className="btn" data-variant="ghost" onClick={onDismiss}>
							Dismiss
						</button>
					)}
				</div>
				{error !== null && <ErrorState error={error} />}
			</div>
		</Card>
	);
}

const LIST_REFRESH_MS = 60_000;

/** The "Renew by" cell: a plain date, amber inside a week of it, red once past; blank for providers whose logins do not expire on a known date. */
function RenewBy({ renewBy, now }: { renewBy: string; now: number }) {
	const tone = renewTone(renewBy, now);
	if (tone === null) return <span className="muted">—</span>;
	return <Badge tone={tone}>{tone === "bad" ? `overdue · ${dateTime(renewBy)}` : dateTime(renewBy)}</Badge>;
}

interface LoggedInProps {
	query: QueryState<LoginList>;
	/** Whether this connection has full access: accounts show, and each row can log in again. */
	full: boolean;
	starting: string | null;
	onAgain: (provider: string) => void;
}

/** What the cloud is logged in to now: one row per credential in its broker and per MCP server. */
function LoggedInCard({ query, full, starting, onAgain }: LoggedInProps) {
	const now = Date.now();
	const columns: Column<LoginEntry>[] = [
		{ key: "provider", header: "Provider", sort: entry => entry.provider, render: entry => <span className="mono">{entry.provider}</span> },
		{
			key: "account",
			header: "Account",
			sort: entry => entry.account,
			render: entry =>
				entry.kind === "mcp" ? (
					<LabelCell primary={entry.account === "" ? "—" : entry.account} secondary="MCP server" />
				) : entry.account === "" ? (
					<span className="muted">—</span>
				) : (
					entry.account
				),
		},
		{ key: "loggedIn", header: "Logged in", sort: entry => entry.loggedInAt, render: entry => dateTime(entry.loggedInAt) },
		{ key: "renewBy", header: "Renew by", sort: entry => entry.renewBy, render: entry => <RenewBy renewBy={entry.renewBy} now={now} /> },
		{
			key: "status",
			header: "Status",
			sort: entry => Number(entry.disabled),
			render: entry =>
				entry.disabled ? (
					<span title={entry.note === "" ? undefined : entry.note}>
						<Badge tone="bad">disabled</Badge>
					</span>
				) : (
					<Badge tone="ok">active</Badge>
				),
		},
	];
	if (full) {
		columns.push({
			key: "again",
			header: "",
			align: "right",
			render: entry => (
				<button type="button" className="btn" data-size="sm" disabled={starting !== null} onClick={() => onAgain(entry.provider)}>
					{starting === entry.provider ? "Starting…" : "Log in again"}
				</button>
			),
		});
	}
	return (
		<Card
			title="Logged in"
			description="What the cloud can use now: the cloud broker's provider logins, and the MCP servers it is signed in to."
			flush
			footer={
				query.data !== undefined && query.data.brokerError !== "" ? (
					<span className="access-warn" role="alert">
						<TriangleAlert size={13} /> {query.data.brokerError}
					</span>
				) : undefined
			}
		>
			<QueryView query={query} skeleton={<TableSkeleton rows={3} />}>
				{data => <Table columns={columns} rows={data.logins} rowKey={entry => `${entry.provider}:${entry.account}:${entry.disabled}`} empty="No logins yet." />}
			</QueryView>
		</Card>
	);
}

export function LoginsPage({ active }: PageProps) {
	const full = useAccess() === "full";
	/** The logins started in this tab, newest first. */
	const [logins, setLogins] = useState<Login[]>([]);
	const [provider, setProvider] = useState("");
	const [startError, setStartError] = useState<string | null>(null);
	/** The provider whose flow is being started: from the box (`""`) or a row's "Log in again". */
	const [starting, setStarting] = useState<string | null>(null);

	const list = useQuery(["logins-list"], () => getLogins(), { enabled: active, refetchMs: LIST_REFRESH_MS });

	// Providers the cloud already runs make good suggestions; an unknown id is refused by the service.
	const whoami = useQuery(["whoami"], () => getWhoami(), { enabled: active && full });

	const waitingIds = logins.filter(login => login.state === "waiting").map(login => login.id);
	const polled = useQuery(["logins", ...waitingIds], () => Promise.all(waitingIds.map(pollLogin)), {
		enabled: active && waitingIds.length > 0,
		refetchMs: POLL_MS,
	});
	const polls = polled.data;
	useEffect(() => {
		if (polls) setLogins(current => applyPolls(current, polls));
	}, [polls]);

	// A login that finished in this tab changes what the list shows.
	const doneCount = logins.filter(login => login.state === "done").length;
	const refetchList = list.refetch;
	useEffect(() => {
		if (doneCount > 0) refetchList();
	}, [doneCount, refetchList]);

	function remember(login: Login): void {
		setLogins(current => (current.some(known => known.id === login.id) ? current.map(known => (known.id === login.id ? login : known)) : [login, ...current]));
	}

	async function start(id: string, from: string): Promise<void> {
		if (id === "") {
			setStartError("Enter a provider id.");
			return;
		}
		setStarting(from);
		try {
			remember(await startLogin(id));
			setStartError(null);
		} catch (failure) {
			setStartError(describe(failure));
		} finally {
			setStarting(null);
		}
	}

	return (
		<div className="page">
			<PageHeader
				title="Provider logins"
				description="Give the cloud broker its own login to a provider. The refresh token is created on the service host and never leaves it."
			/>
			<LoggedInCard query={list} full={full} starting={starting} onAgain={id => void start(id, id)} />
			{full ? (
				<Card title="Start a login">
					<div className="access-stack">
						<div className="access-fields">
							<input
								className="input"
								type="text"
								list="login-providers"
								placeholder="provider id, for example openai-codex"
								autoComplete="off"
								value={provider}
								onChange={event => setProvider(event.target.value)}
								onKeyDown={event => {
									if (event.key === "Enter" && starting === null) void start(provider.trim(), "");
								}}
							/>
							<datalist id="login-providers">
								{(whoami.data?.modelPatterns ?? []).map(pattern => (
									<option key={pattern} value={pattern.replace(/\/\*$/, "")} />
								))}
							</datalist>
							<button type="button" className="btn" data-variant="primary" disabled={starting !== null} onClick={() => void start(provider.trim(), "")}>
								Start login
							</button>
						</div>
						{startError !== null && <ErrorState error={startError} />}
					</div>
				</Card>
			) : (
				<FullAccessNotice />
			)}
			{polled.error !== undefined && polled.error !== null && <ErrorState error={describe(polled.error)} />}
			{logins.length === 0 ? (
				full && (
					<Card flush>
						<EmptyState title="No logins started in this session." />
					</Card>
				)
			) : (
				<div className="grid grid-2">
					{logins.map(login => (
						<LoginCard
							key={login.id}
							login={login}
							onUpdate={remember}
							onDismiss={() => setLogins(current => current.filter(known => known.id !== login.id))}
							onCancelled={polled.refetch}
						/>
					))}
				</div>
			)}
		</div>
	);
}
