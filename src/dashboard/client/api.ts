/**
 * The dashboard's API client: same-origin `/api/v1/...` calls with the session cookie, the custom header on
 * mutations, and the wire shapes the views read.
 *
 * The thread, question and turn shapes mirror `src/server/views.ts`. They are not imported from there because that
 * module reaches for `Buffer`, which the client's DOM-only tsconfig does not have; `store/types.ts` is pure.
 */
import type { Paths, QuestionOption, Repo, ThreadPhase, TurnState, Usage } from "../../store/types";

export type { Paths, QuestionOption, Repo, ThreadPhase, TurnState, Usage };

export interface QuestionView {
	id: number;
	ask: number;
	key: string;
	text: string;
	header: string;
	options: QuestionOption[];
	multi: boolean;
	recommended: number | null;
	askedAt: string;
	selected: string[];
	answer: string;
	answeredBy: string;
	answeredAt: string | null;
	expired: boolean;
}

export interface PendingQuestionView {
	turn: number;
	id: number;
	ask: number;
	text: string;
	header: string;
	options: QuestionOption[];
	multi: boolean;
	recommended: number | null;
	askedAt: string;
	remaining: number;
}

/** The context a turn ended with, or the thread's latest: `window` 0 means the model's window is unknown. */
export interface ContextView {
	tokens: number;
	window: number;
}

export interface ThreadContextView extends ContextView {
	at: string;
}

/** One finished turn on the per-turn charts. */
export interface TurnMetricView {
	n: number;
	cost: number;
	contextTokens: number | null;
}

export interface ThreadMetricsView {
	usage: Usage;
	requests: number;
	tools: number;
	workMs: number;
	context: ThreadContextView | null;
	/** The last 12 finished turns, oldest first. */
	turns: TurnMetricView[];
}

/** The running turn's latest tool or assistant event. */
export interface ThreadActivityView {
	kind: "tool" | "assistant";
	text: string;
	at: string;
}

export interface TurnView {
	id: number;
	state: TurnState;
	text: string;
	by: string;
	queuedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	reply: string;
	title: string;
	error: string;
	usage: Usage | null;
	head: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	pushed: boolean;
	pushError: string;
	pushRef: string;
	questions: QuestionView[];
	requests: number;
	tools: number;
	context: ContextView | null;
}

export interface LatestView {
	id: number;
	state: TurnState;
	title: string;
	reply: string;
	error: string;
	completedAt: string | null;
}

export interface ResultView {
	branch: string;
	head: string;
	base: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	pushed: boolean;
	pushError: string;
	pushRef: string;
	updatedAt: string;
}

export interface ThreadSummaryView {
	id: string;
	/** A short human label; `""` when the thread has none, and then `title` stands in. */
	name: string;
	title: string;
	owner: string;
	phase: ThreadPhase;
	error: string;
	turns: number;
	queued: number;
	model: string;
	thinking: string;
	ompVersion: string;
	/** The repository the thread works on, as `thread.repo` stores it; `remoteURL` may be `""`. */
	repo: Pick<Repo, "name" | "remoteURL" | "baseRef" | "localBranch">;
	/** The client's repository root as the client wrote it; may be `""`. */
	workspace: string;
	latest: LatestView | null;
	question: PendingQuestionView | null;
	result: ResultView | null;
	/** The pull request the service opened for the thread's branch; null until one exists. */
	pr: { number: number; url: string } | null;
	createdAt: string;
	lastActivityAt: string;
	/** When the archive sweep released the thread's VM; null when it has one or never did. */
	archivedAt: string | null;
	metrics: ThreadMetricsView;
	activity: ThreadActivityView | null;
}

export interface ThreadDetailView extends Omit<ThreadSummaryView, "turns" | "repo" | "workspace"> {
	turns: TurnView[];
	repo: Repo;
	paths: Paths;
	configOverlays: string[];
	vm: { sandboxId: string; state: "running" | "paused"; pid: number | null } | null;
}

/** One event of a thread's stream, and of the global stream. */
export interface ThreadEvent {
	seq: number;
	at: string;
	kind: string;
	turn: number | null;
	text: string;
}

/** A thread's event on the global stream. */
export interface GlobalEvent extends ThreadEvent {
	thread: string;
}

/** A thread deleted, on the global stream. */
export interface GlobalDeletion {
	thread: string;
	deleted: true;
}

export interface Whoami {
	user: string;
	modelPatterns: string[];
}

export interface UsageReport {
	since: string;
	total: Usage;
	threads: { thread: string; name: string; title: string; cost: number; turns: number }[];
	days: { day: string; cost: number }[];
}

export interface VmMetrics {
	at: string;
	cpuUsedPct: number;
	memUsed: number;
	memTotal: number;
	diskUsed: number;
	diskTotal: number;
}

export interface VmEntry {
	thread: string;
	sandboxId: string;
	state: string;
	pid: number | null;
	startedAt: string;
	cpuCount: number;
	memoryMB: number;
	metrics: VmMetrics | null;
}

export interface VmsReport {
	vmonDashboard: string;
	vms: VmEntry[];
}

export type UpdateMode = "off" | "notify" | "auto";

export type UpdateState = "idle" | "checking" | "downloading" | "ready" | "applying" | "failed" | "unsupported";

/** `GET /api/v1/update`: where the service's own update stands, the installed components and the last apply's outcome. */
export interface UpdateStatus {
	mode: UpdateMode;
	/** Whether this process runs from the managed install (`versions/<v>/omp-cloud`), not a checkout. */
	managed: boolean;
	state: UpdateState;
	current: { version: string; build: { id: string; commit: string; createdAt: string } };
	/** The newest release seen; it stays set when it equals `current`. */
	latest: { version: string; notes: string; publishedAt: string } | null;
	/** The version downloaded and verified, ready to apply; kept after a failed apply that can be retried. */
	staged: string | null;
	/** `step` is `starting`, `backup`, `vmon`, `omp`, `swap`, `health` or `rollback`. */
	applying: { version: string; step: string; startedAt: string } | null;
	error: string | null;
	message: string | null;
	checkedAt: string | null;
	/** The previous apply, kept until the next one starts. */
	last: { version: string; notes: string; at: string; result: "installed" | "failed"; message: string } | null;
	components: {
		vmon: { installed: string | null; required: string | null; helper: boolean };
		omp: { host: string; broker: string | null; gateway: string | null };
	};
}

export interface Setting {
	key: string;
	type: string;
	value: unknown;
	default: unknown;
	source: "default" | "stored";
	doc: string;
	choices: string[];
	updatedAt: string;
	updatedBy: string;
}

export interface AuditEntry {
	seq: number;
	at: string;
	actor: string;
	action: "set" | "reset" | "import";
	key: string;
	old: unknown;
	new: unknown;
}

export interface AuditPage {
	entries: AuditEntry[];
	next: number;
}

export interface Login {
	id: string;
	provider: string;
	state: "waiting" | "done" | "failed";
	url: string;
	instructions: string;
	userCode: string;
	account: string;
	error: string;
}

/** A paired device, as `GET /api/v1/devices` lists it. */
export interface Device {
	id: string;
	name: string;
	platform: string;
	createdAt: string;
	pairedFrom: string;
	lastSeenAt: string | null;
	lastSeenAddress: string | null;
	/** True for the device whose token made the call; never true on the server machine's own dashboard. */
	current: boolean;
}

export type OfferStatus = "open" | "pending" | "approved" | "paired" | "declined" | "cancelled" | "burned" | "expired";

/** A new pairing offer: `code` is shown once, here only. */
export interface OfferCreated {
	id: string;
	code: string;
	expiresAt: string;
	fingerprint: string;
	addresses: string[];
}

/** An offer's progress; `request` is the device asking to pair once the status is `pending`. */
export interface OfferState {
	id: string;
	status: OfferStatus;
	expiresAt: string;
	request: { name: string; platform: string; address: string; at: string } | null;
	device: { id: string; name: string } | null;
}

/** A failed call: the HTTP status and the service's `{error}` message. */
export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

export const GLOBAL_EVENTS_PATH = "/api/v1/events";
export const SETTINGS_EXPORT_PATH = "/api/v1/settings/export";

export function threadEventsPath(id: string, after: number): string {
	return `/api/v1/threads/${encodeURIComponent(id)}/events?after=${after}`;
}

export function threadDownloadPath(id: string, what: "result" | "conversation"): string {
	return `/api/v1/threads/${encodeURIComponent(id)}/${what}`;
}

let unauthorizedListener: (() => void) | null = null;

/** `listener` runs when an API call comes back 401: the session ended, so the sign-in view takes over. */
export function onUnauthorized(listener: () => void): void {
	unauthorizedListener = listener;
}

interface Init {
	json?: unknown;
	text?: string;
	/** A 401 from this call is an answer, not a lost session (the sign-in calls). */
	anonymous?: boolean;
}

async function send(method: string, path: string, init: Init = {}): Promise<Response> {
	const headers: Record<string, string> = {};
	if (method !== "GET") headers["X-Omp-Dashboard"] = "1";
	let body: string | undefined;
	if (init.json !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(init.json);
	} else if (init.text !== undefined) {
		headers["Content-Type"] = "application/yaml";
		body = init.text;
	}
	const response = await fetch(path, { method, headers, body, credentials: "same-origin", cache: "no-store" });
	if (response.ok) return response;
	if (response.status === 401 && init.anonymous !== true) unauthorizedListener?.();
	throw new ApiError(response.status, await errorMessage(response));
}

async function errorMessage(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
	} catch {
		// Not JSON: fall through to the status line.
	}
	return `${response.status} ${response.statusText}`.trim();
}

async function call<T>(method: string, path: string, init?: Init): Promise<T> {
	const response = await send(method, path, init);
	return (await response.json()) as T;
}

// Session

/** The signed-in user, or null without a valid session. */
export async function getSession(): Promise<{ user: string } | null> {
	try {
		return await call<{ user: string }>("GET", "/session", { anonymous: true });
	} catch (error) {
		if (error instanceof ApiError && error.status === 401) return null;
		throw error;
	}
}

/** Signs in with a one-time link code or the API token. Throws `ApiError` (401 wrong, 429 too many attempts). */
export async function signIn(credential: { code: string } | { token: string }): Promise<void> {
	await send("POST", "/session", { json: credential, anonymous: true });
}

export async function signOut(): Promise<void> {
	await send("DELETE", "/session", { anonymous: true });
}

// Threads

export async function getWhoami(): Promise<Whoami> {
	return call<Whoami>("GET", "/api/v1/whoami");
}

export async function listThreads(): Promise<ThreadSummaryView[]> {
	return (await call<{ threads: ThreadSummaryView[] }>("GET", "/api/v1/threads")).threads;
}

export async function getThread(id: string): Promise<ThreadDetailView> {
	return call<ThreadDetailView>("GET", `/api/v1/threads/${encodeURIComponent(id)}`);
}

export async function sendMessage(id: string, text: string): Promise<void> {
	await send("POST", `/api/v1/threads/${encodeURIComponent(id)}/messages`, { json: { text } });
}

export async function stopThread(id: string): Promise<{ stoppedRunning: boolean; cancelled: number }> {
	return call("POST", `/api/v1/threads/${encodeURIComponent(id)}/stop`);
}

export async function deleteThread(id: string): Promise<void> {
	await send("DELETE", `/api/v1/threads/${encodeURIComponent(id)}`);
}

export async function answerQuestion(
	id: string,
	turn: number,
	question: number,
	answer: { selected: string[]; answer: string },
): Promise<void> {
	await send("POST", `/api/v1/threads/${encodeURIComponent(id)}/turns/${turn}/questions/${question}/answer`, { json: answer });
}

// Spend and VMs

export async function getUsage(since: string): Promise<UsageReport> {
	return call<UsageReport>("GET", `/api/v1/usage?since=${encodeURIComponent(since)}`);
}

export async function getVms(): Promise<VmsReport> {
	return call<VmsReport>("GET", "/api/v1/vms");
}

// Updates

export async function getUpdate(): Promise<UpdateStatus> {
	return call<UpdateStatus>("GET", "/api/v1/update");
}

/** Starts a check of the release feed (202); the result shows in `getUpdate`. */
export async function checkUpdate(): Promise<void> {
	await send("POST", "/api/v1/update/check");
}

/** Applies the staged release (202). A 409 says why nothing can apply: nothing ready, one already running, or an unmanaged install. */
export async function applyUpdate(): Promise<{ applying: { version: string } }> {
	return call("POST", "/api/v1/update/apply");
}

// Settings

export async function getSettings(): Promise<Setting[]> {
	return (await call<{ settings: Setting[] }>("GET", "/api/v1/settings")).settings;
}

/** Sets keys to values; `null` resets a key to its default. Nothing applies when any change is invalid (400). */
export async function putSettings(changes: Record<string, unknown>): Promise<Setting[]> {
	return (await call<{ settings: Setting[] }>("PUT", "/api/v1/settings", { json: { settings: changes } })).settings;
}

export async function getAudit(before: number | null): Promise<AuditPage> {
	const query = before === null ? "" : `?before=${before}`;
	return call<AuditPage>("GET", `/api/v1/settings/audit${query}`);
}

export async function importSettings(yaml: string, mode: "replace" | "merge"): Promise<Setting[]> {
	return (await call<{ settings: Setting[] }>("PUT", `/api/v1/settings/import?mode=${mode}`, { text: yaml })).settings;
}

// Provider logins

export async function startLogin(provider: string): Promise<Login> {
	return call<Login>("POST", "/api/v1/logins", { json: { provider } });
}

export async function getLogin(id: string): Promise<Login> {
	return call<Login>("GET", `/api/v1/logins/${encodeURIComponent(id)}`);
}

export async function inputLogin(id: string, input: string): Promise<Login> {
	return call<Login>("POST", `/api/v1/logins/${encodeURIComponent(id)}/input`, { json: { input } });
}

export async function cancelLogin(id: string): Promise<void> {
	await send("DELETE", `/api/v1/logins/${encodeURIComponent(id)}`);
}

// GitHub App and commit signing

/** The GitHub App the service created through the manifest flow. */
export interface GithubApp {
	id: number;
	slug: string;
	name: string;
	clientId: string;
	htmlUrl: string;
	owner: { login: string; id: number; type: string };
	createdAt: string;
}

export interface GithubInstallation {
	id: number;
	account: string;
	accountType: string;
	selection: "all" | "selected";
	htmlUrl: string;
}

/** `GET /api/v1/github`; `installationsError` is `""` when the installations listed. */
export interface GithubStatus {
	app: GithubApp | null;
	installUrl: string | null;
	installations: GithubInstallation[];
	installationsError: string;
}

/** What the page posts to GitHub to create the App: `manifest` goes in a form field named `manifest`. */
export interface GithubManifest {
	postUrl: string;
	manifest: string;
	state: string;
}

/** `GET /api/v1/signing`; `publicKey` and `fingerprint` are null while there is no key. */
export interface SigningStatus {
	publicKey: string | null;
	fingerprint: string | null;
	createdAt: string | null;
	/** The effective committer of signed commits as `Name <email>`, or null when each commit keeps its own. */
	committer: string | null;
	/** The key's owner on GitHub; `registered` is null when GitHub could not say. */
	github: { login: string; registered: boolean | null; error: string } | null;
}

export async function getGithub(): Promise<GithubStatus> {
	return call<GithubStatus>("GET", "/api/v1/github");
}

export async function githubManifest(request: { origin: string; org?: string }): Promise<GithubManifest> {
	return call<GithubManifest>("POST", "/api/v1/github/manifest", { json: request });
}

/** Finishes the manifest flow with the `code` and `state` GitHub redirected back with. */
export async function githubConvert(code: string, state: string): Promise<GithubApp> {
	return (await call<{ app: GithubApp }>("POST", "/api/v1/github/conversions", { json: { code, state } })).app;
}

export async function disconnectGithub(): Promise<void> {
	await send("DELETE", "/api/v1/github");
}

export async function getSigning(): Promise<SigningStatus> {
	return call<SigningStatus>("GET", "/api/v1/signing");
}

export async function createSigningKey(): Promise<{ publicKey: string; fingerprint: string }> {
	return call("POST", "/api/v1/signing/key");
}

export async function deleteSigningKey(): Promise<void> {
	await send("DELETE", "/api/v1/signing/key");
}

// Secrets

/** A secret as the service lists it: never its value. `kind` is "command" for a `!command` value that the service resolves at delivery. */
export interface Secret {
	name: string;
	repos: string[];
	kind: "command" | "literal";
	updatedAt: string;
	updatedBy: string;
}

export async function getSecrets(): Promise<Secret[]> {
	return (await call<{ secrets: Secret[] }>("GET", "/api/v1/secrets")).secrets;
}

/** Creates or replaces a secret (a literal, or `!command`) delivered to threads whose repository matches one of the `repos` globs. */
export async function putSecret(name: string, value: string, repos: string[]): Promise<Secret> {
	return (await call<{ secret: Secret }>("PUT", `/api/v1/secrets/${encodeURIComponent(name)}`, { json: { value, repos } })).secret;
}

export async function deleteSecret(name: string): Promise<void> {
	await send("DELETE", `/api/v1/secrets/${encodeURIComponent(name)}`);
}

// Devices and pairing

export async function listDevices(): Promise<Device[]> {
	return (await call<{ devices: Device[] }>("GET", "/api/v1/devices")).devices;
}

/** Revokes a device at once; `runningThreads` are the threads it started that are still running. */
export async function revokeDevice(id: string): Promise<{ device: { id: string; name: string }; runningThreads: string[] }> {
	return call("DELETE", `/api/v1/devices/${encodeURIComponent(id)}`);
}

export async function createOffer(): Promise<OfferCreated> {
	return call<OfferCreated>("POST", "/api/v1/pairing/offers", { json: {} });
}

export async function getOffer(id: string): Promise<OfferState> {
	return call<OfferState>("GET", `/api/v1/pairing/offers/${encodeURIComponent(id)}`);
}

export async function approveOffer(id: string): Promise<void> {
	await send("POST", `/api/v1/pairing/offers/${encodeURIComponent(id)}/approve`);
}

export async function declineOffer(id: string): Promise<void> {
	await send("POST", `/api/v1/pairing/offers/${encodeURIComponent(id)}/decline`);
}

export async function cancelOffer(id: string): Promise<void> {
	await send("DELETE", `/api/v1/pairing/offers/${encodeURIComponent(id)}`);
}
