/** GitHub for the cloud: the App that pushes and opens pull requests, the key that signs commits, and the settings that steer both. */
import { useEffect, useRef, useState } from "react";
import {
	ApiError,
	createSigningKey,
	deleteSigningKey,
	disconnectGithub,
	type GithubApp,
	type GithubStatus,
	getGithub,
	getSettings,
	getSigning,
	githubManifest,
	putSettings,
	type Setting,
	type SigningStatus,
} from "../api";
import { clearGithubReturnError, githubReturned, readGithubReturnError } from "../app/github-return";
import type { PageProps } from "../app/page";
import { messageOf, useQuery } from "../app/query";
import { dateTime, safeHref } from "../format";
import { Badge, Card, ErrorState, KeyValues, Modal, PageHeader, QueryView, Segmented, TableSkeleton } from "../kit/ui";
import "./access.css";

const OWNER_ONLY = "Connect GitHub from the dashboard on the service host.";
const NEW_SIGNING_KEY_URL = "https://github.com/settings/ssh/new";
const ORG_NAME = /^[A-Za-z0-9-]{1,39}$/;

/** An error as one readable line; a 403 means a paired device's session reached an owner-only route. */
function describe(error: unknown): string {
	if (error instanceof ApiError && error.status === 403) return OWNER_ONLY;
	return messageOf(error);
}

/** Awaits `call`; a failure rethrows as an `Error` whose message is `describe`'s, so `ErrorState` shows it as is. */
async function readable<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (error) {
		throw new Error(describe(error), { cause: error });
	}
}

/** A link that opens GitHub in a new tab; text only when the URL is not http(s). */
function ExternalLink({ url, children }: { url: string; children: string }) {
	const href = safeHref(url);
	if (href === null) return <span>{children}</span>;
	return (
		<a href={href} target="_blank" rel="noreferrer noopener">
			{children}
		</a>
	);
}

/** An enum setting as a segmented control that saves on click. */
function SettingChoice({ setting, label, onApplied }: { setting: Setting; label: string; onApplied: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function choose(value: string): Promise<void> {
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
		<div className="access-stack">
			<span className="cell-primary">
				<span className="access-title-mono">{setting.key}</span> · {label}
			</span>
			<div>
				<Segmented
					options={setting.choices.map(choice => ({ value: choice, label: choice }))}
					value={String(setting.value)}
					onChange={choice => {
						if (!busy) void choose(choice);
					}}
					aria-label={setting.key}
				/>
			</div>
			<p className="access-fine" style={{ margin: 0 }}>
				{setting.doc}
			</p>
			{error !== null && <ErrorState error={error} />}
		</div>
	);
}

/** The Connect button: asks the service for the manifest, then posts it to GitHub from a hidden form. */
function ConnectForm() {
	const [org, setOrg] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [post, setPost] = useState<{ postUrl: string; manifest: string } | null>(null);
	const form = useRef<HTMLFormElement>(null);

	useEffect(() => {
		if (post !== null) form.current?.submit();
	}, [post]);

	async function connect(): Promise<void> {
		const name = org.trim();
		if (name !== "" && !ORG_NAME.test(name)) {
			setError("An organization name has letters, digits and hyphens only (at most 39).");
			return;
		}
		setBusy(true);
		try {
			const manifest = await githubManifest(name === "" ? { origin: window.location.origin } : { origin: window.location.origin, org: name });
			if (new URL(manifest.postUrl).origin !== "https://github.com") throw new Error(`the service answered a form address outside github.com: ${manifest.postUrl}`);
			setError(null);
			setPost(manifest);
		} catch (failure) {
			setError(describe(failure));
			setBusy(false);
		}
	}

	return (
		<div className="access-stack">
			<p className="access-fine" style={{ margin: 0 }}>
				Creates a private GitHub App named omp-cloud-… under your account (or an organization) with write access to contents and pull requests. GitHub asks you to confirm, then
				returns here.
			</p>
			<div className="access-fields">
				<input
					className="input"
					type="text"
					placeholder="organization (optional)"
					autoComplete="off"
					value={org}
					onChange={event => setOrg(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && !busy) void connect();
					}}
					aria-label="Organization"
				/>
				<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void connect()}>
					Connect GitHub
				</button>
			</div>
			{error !== null && <ErrorState error={error} />}
			{post !== null && (
				<form ref={form} method="post" action={post.postUrl} hidden>
					<input type="hidden" name="manifest" value={post.manifest} />
				</form>
			)}
		</div>
	);
}

function AppDetails({ app, status }: { app: GithubApp; status: GithubStatus }) {
	const items = [
		{ key: "app", label: "App", value: <ExternalLink url={app.htmlUrl}>{app.name}</ExternalLink> },
		{ key: "owner", label: "Owner", value: `${app.owner.login} (${app.owner.type})` },
		{ key: "created", label: "Created", value: dateTime(app.createdAt) },
	];
	return (
		<div className="access-stack github-facts">
			<KeyValues items={items} />
			{status.installUrl !== null && (
				<p style={{ margin: 0 }}>
					<ExternalLink url={status.installUrl}>Install on repositories</ExternalLink>
					<span className="access-fine"> · pick the repositories cloud agents may push to; the App reaches nothing else.</span>
				</p>
			)}
			{status.installationsError !== "" && <ErrorState error={`Could not list the installations: ${status.installationsError}`} />}
			{status.installationsError === "" &&
				(status.installations.length === 0 ? (
					<p className="access-fine" style={{ margin: 0 }}>
						Not installed anywhere yet.
					</p>
				) : (
					<div className="access-stack">
						<span className="cell-primary">Installations</span>
						<KeyValues
							items={status.installations.map(installation => ({
								key: String(installation.id),
								label: <ExternalLink url={installation.htmlUrl}>{installation.account}</ExternalLink>,
								value: (
									<span className="row" style={{ gap: 8 }}>
										<span>{installation.accountType}</span>
										<Badge>{installation.selection === "all" ? "all repositories" : "selected repositories"}</Badge>
									</span>
								),
							}))}
						/>
					</div>
				))}
		</div>
	);
}

function AppCard({ status, onChanged }: { status: GithubStatus; onChanged: () => void }) {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const app = status.app;

	async function disconnect(): Promise<void> {
		setBusy(true);
		try {
			await disconnectGithub();
			setError(null);
			onChanged();
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setBusy(false);
			setConfirming(false);
		}
	}

	return (
		<Card
			title="GitHub App"
			description="Cloud agents push and open pull requests as this App, with a one-hour token for the one repository."
			actions={app === null ? <Badge>not connected</Badge> : <Badge tone="ok">connected</Badge>}
			footer={
				app === null ? undefined : (
					<button type="button" className="btn" data-variant="danger" disabled={busy} onClick={() => setConfirming(true)}>
						Disconnect
					</button>
				)
			}
		>
			<div className="access-stack">
				{app === null ? <ConnectForm /> : <AppDetails app={app} status={status} />}
				{error !== null && <ErrorState error={error} />}
			</div>
			<Modal
				open={confirming}
				title="Disconnect GitHub"
				onClose={() => setConfirming(false)}
				primaryAction={{ label: busy ? "Disconnecting…" : "Disconnect", onClick: () => void disconnect(), disabled: busy }}
			>
				<p className="muted">
					The service forgets the App and its private key. Pushes to github.com then need a token in the git.hosts setting. The App itself stays on GitHub until you delete it there.
				</p>
			</Modal>
		</Card>
	);
}

function Registration({ github }: { github: NonNullable<SigningStatus["github"]> }) {
	if (github.registered === true) return <Badge tone="ok">registered for {github.login}</Badge>;
	if (github.registered === false) return <Badge tone="warn">not on {github.login}&apos;s GitHub account yet</Badge>;
	return (
		<span className="row" style={{ gap: 8 }}>
			<Badge>unknown</Badge>
			{github.error !== "" && <span className="access-fine">{github.error}</span>}
		</span>
	);
}

function SigningCard({
	signing,
	app,
	sign,
	onChanged,
}: {
	signing: SigningStatus;
	app: GithubApp | null;
	sign: Setting | undefined;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const hasKey = signing.publicKey !== null;

	async function act(run: () => Promise<unknown>): Promise<void> {
		setBusy(true);
		try {
			await run();
			setError(null);
			onChanged();
		} catch (failure) {
			setError(describe(failure));
		} finally {
			setBusy(false);
			setConfirming(false);
		}
	}

	async function copy(): Promise<void> {
		if (signing.publicKey === null) return;
		try {
			await navigator.clipboard.writeText(signing.publicKey);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch (failure) {
			setError(`Could not copy: ${messageOf(failure)}`);
		}
	}

	let committer: string;
	if (signing.committer !== null) committer = signing.committer;
	else if (app !== null && app.owner.type !== "User") committer = "none: the App belongs to an organization, so set git.committer to an address verified on your GitHub account";
	else committer = "none: each commit keeps its own committer";

	return (
		<Card
			title="Commit signing"
			description="The service re-signs each turn's commits with its own SSH key, so GitHub shows them as Verified."
			actions={hasKey ? <Badge tone="ok">key ready</Badge> : <Badge>no key</Badge>}
		>
			<div className="access-stack github-facts">
				{!hasKey ? (
					<div className="access-actions">
						<button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => void act(() => createSigningKey())}>
							Generate signing key
						</button>
					</div>
				) : (
					<>
						<textarea className="input" rows={3} readOnly spellCheck={false} value={signing.publicKey ?? ""} aria-label="Public key" />
						<div className="access-actions">
							<button type="button" className="btn" onClick={() => void copy()}>
								{copied ? "Copied" : "Copy public key"}
							</button>
							<ExternalLink url={NEW_SIGNING_KEY_URL}>Add it on GitHub</ExternalLink>
							<span className="access-fine">Key type: Signing Key</span>
						</div>
						<KeyValues
							items={[
								{ key: "fingerprint", label: "Fingerprint", value: <span className="mono">{signing.fingerprint}</span> },
								{ key: "created", label: "Created", value: signing.createdAt === null ? "—" : dateTime(signing.createdAt) },
								{
									key: "registered",
									label: "On GitHub",
									value:
										signing.github === null ? (
											<span className="access-fine">checked once a GitHub App is connected</span>
										) : (
											<Registration github={signing.github} />
										),
								},
								{ key: "committer", label: "Committer", value: committer },
							]}
						/>
						<div className="access-actions">
							<button type="button" className="btn" data-variant="danger" disabled={busy} onClick={() => setConfirming(true)}>
								Delete key
							</button>
						</div>
					</>
				)}
				{sign !== undefined && <SettingChoice setting={sign} label="sign each turn's commits" onApplied={onChanged} />}
				{error !== null && <ErrorState error={error} />}
			</div>
			<Modal
				open={confirming}
				title="Delete the signing key"
				onClose={() => setConfirming(false)}
				primaryAction={{ label: busy ? "Deleting…" : "Delete", onClick: () => void act(() => deleteSigningKey()), disabled: busy }}
			>
				<p className="muted">
					New commits stay unsigned until you generate another key and add it on GitHub. Commits already signed keep their signature, and GitHub keeps showing them as Verified while the old key stays on
					your account.
				</p>
			</Modal>
		</Card>
	);
}

function PullRequestsCard({ push, pr, onChanged }: { push: Setting | undefined; pr: Setting | undefined; onChanged: () => void }) {
	return (
		<Card title="Pushes and pull requests" description="What happens to a thread's commits when a turn finishes.">
			<div className="access-stack">
				{push === undefined || pr === undefined ? (
					<p className="access-fine" style={{ margin: 0 }}>
						This service does not offer the git.push and git.pr settings.
					</p>
				) : (
					<>
						<SettingChoice setting={push} label="when to push the thread's branch" onApplied={onChanged} />
						<SettingChoice setting={pr} label="pull request after a push to github.com" onApplied={onChanged} />
					</>
				)}
			</div>
		</Card>
	);
}

export function GitHubPage({ active }: PageProps) {
	const [returnError, setReturnError] = useState<string | null>(null);
	useEffect(() => {
		void githubReturned().then(() => setReturnError(readGithubReturnError()));
	}, []);

	// The fetches wait for a return from GitHub that is still converting the App.
	const github = useQuery(
		["github"],
		async () => {
			await githubReturned();
			return readable(getGithub());
		},
		{ enabled: active },
	);
	const signing = useQuery(
		["signing"],
		async () => {
			await githubReturned();
			return readable(getSigning());
		},
		{ enabled: active },
	);
	const settings = useQuery(["github-settings"], () => readable(getSettings()), { enabled: active });

	const setting = (key: string): Setting | undefined => settings.data?.find(candidate => candidate.key === key);

	function reload(): void {
		github.refetch();
		signing.refetch();
		settings.refetch();
	}

	return (
		<div className="page">
			<PageHeader
				title="GitHub"
				description="Connect GitHub once: cloud agents then push to your private repositories, sign their commits and open pull requests."
			/>
			{returnError !== null && (
				<div className="access-stack">
					<ErrorState error={`GitHub connection failed: ${returnError}`} />
					<div>
						<button
							type="button"
							className="btn"
							onClick={() => {
								clearGithubReturnError();
								setReturnError(null);
							}}
						>
							Dismiss
						</button>
					</div>
				</div>
			)}
			<div className="grid grid-2">
				<QueryView query={github} skeleton={<TableSkeleton rows={4} />}>
					{status => <AppCard status={status} onChanged={reload} />}
				</QueryView>
				<QueryView query={signing} skeleton={<TableSkeleton rows={4} />}>
					{status => <SigningCard signing={status} app={github.data?.app ?? null} sign={setting("git.sign")} onChanged={reload} />}
				</QueryView>
			</div>
			<QueryView query={settings} skeleton={<TableSkeleton rows={3} />}>
				{() => <PullRequestsCard push={setting("git.push")} pr={setting("git.pr")} onChanged={reload} />}
			</QueryView>
		</div>
	);
}
