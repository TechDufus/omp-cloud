/** Provider logins for the cloud broker: start, open the sign-in page, paste a redirect or code, follow the state. */
import { useEffect, useState } from "react";
import { ApiError, cancelLogin, getLogin, getWhoami, inputLogin, type Login, startLogin } from "../api";
import type { PageProps } from "../app/page";
import { useQuery } from "../app/query";
import { safeHref } from "../format";
import { Badge, Card, EmptyState, ErrorState, PageHeader, type Tone } from "../kit/ui";
import { describe } from "./access-errors";
import "./access.css";

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

export function LoginsPage({ active }: PageProps) {
	/** The logins started in this tab, newest first. */
	const [logins, setLogins] = useState<Login[]>([]);
	const [provider, setProvider] = useState("");
	const [startError, setStartError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	// Providers the cloud already runs make good suggestions; an unknown id is refused by the service.
	const whoami = useQuery(["whoami"], () => getWhoami(), { enabled: active });

	const waitingIds = logins.filter(login => login.state === "waiting").map(login => login.id);
	const polled = useQuery(["logins", ...waitingIds], () => Promise.all(waitingIds.map(pollLogin)), {
		enabled: active && waitingIds.length > 0,
		refetchMs: POLL_MS,
	});
	const polls = polled.data;
	useEffect(() => {
		if (polls) setLogins(current => applyPolls(current, polls));
	}, [polls]);

	function remember(login: Login): void {
		setLogins(current => (current.some(known => known.id === login.id) ? current.map(known => (known.id === login.id ? login : known)) : [login, ...current]));
	}

	async function start(): Promise<void> {
		const id = provider.trim();
		if (id === "") {
			setStartError("Enter a provider id.");
			return;
		}
		setStarting(true);
		try {
			remember(await startLogin(id));
			setStartError(null);
		} catch (failure) {
			setStartError(describe(failure));
		} finally {
			setStarting(false);
		}
	}

	return (
		<div className="page">
			<PageHeader
				title="Provider logins"
				description="Give the cloud broker its own login to a provider. The refresh token is created on the service host and never leaves it."
			/>
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
								if (event.key === "Enter" && !starting) void start();
							}}
						/>
						<datalist id="login-providers">
							{(whoami.data?.modelPatterns ?? []).map(pattern => (
								<option key={pattern} value={pattern.replace(/\/\*$/, "")} />
							))}
						</datalist>
						<button type="button" className="btn" data-variant="primary" disabled={starting} onClick={() => void start()}>
							Start login
						</button>
					</div>
					{startError !== null && <ErrorState error={startError} />}
				</div>
			</Card>
			{polled.error !== undefined && polled.error !== null && <ErrorState error={describe(polled.error)} />}
			{logins.length === 0 ? (
				<Card flush>
					<EmptyState title="No logins started in this session." />
				</Card>
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
