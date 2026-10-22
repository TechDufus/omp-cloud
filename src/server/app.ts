import type { LoginManager } from "../auth/login";
import type { GitService } from "../git";
import type { SigningKey } from "../git/signing-key";
import type { GitHubApi } from "../github/api";
import type { GitHubApp } from "../github/app";
import { canonicalAddress } from "../pairing/cidr";
import { SourceLimiter } from "../pairing/limiter";
import type { RemoteSettings } from "../pairing/remote";
import { utcDay } from "../runner/spend";
import { VM_WORKSPACE } from "../runner/vm-layout";
import { ServiceSecrets } from "../secrets/store";
import type { Settings } from "../settings";
import type { Store } from "../store";
import {
	MAX_OPTION_LABEL_BYTES,
	MAX_OPTIONS,
	MAX_QUESTION_TEXT_BYTES,
	MAX_TEXT_BYTES,
	MAX_TURNS,
	RESULT_BRANCH_PREFIX,
	StoreError,
	THREAD_ID_PATTERN,
	type Thread,
} from "../store/types";
import { API_VERSION, SERVICE_VERSION } from "../version";
import type { ApiServer } from "./api-server";
import { actorOf, authenticate, type Caller } from "./auth";
import { readJsonObject } from "./body";
import { createThreadIdempotent, type ModelOptions, modelPatterns } from "./create";
import { DashboardRoutes, type DashboardRoutesOptions, type VmInspector } from "./dashboard-routes";
import { abortableStream, DeviceAborts, requireActive, unauthorized } from "./devices";
import { deviceDownload } from "./download";
import { ApiError } from "./errors";
import { eventsPage, eventStream } from "./events";
import { inspectResponse } from "./inspect";
import { INSPECTION_GATE, type InspectGate } from "./inspect-gate";
import { MAX_SOURCE_BYTES } from "./limits";
import { MAX_LIST_LIMIT, threadListBody } from "./list";
import { handleGithub } from "./github-routes";
import { handleLogins } from "./logins";
import { GITHUB_PATH, LOGINS_PATH, SECRETS_PATH, SETTINGS_PATH, SIGNING_PATH } from "./paths";
import { PairingRoutes } from "./pairing-routes";
import { requireScope } from "./scopes";
import { handleSecrets } from "./secrets-routes";
import { handleSettings } from "./settings-routes";
import { handleSigning } from "./signing-routes";
import { turnTextPage } from "./turn-text";
import { handleUpdate, HEALTH_PATH, healthBody, type UpdateApi, updateSummary } from "./update-routes";
import { detailView, questionView, summaryView, turnView } from "./views";

/** What `createApp` needs. */
export interface AppOptions {
	store: Store;
	/** Config.apiTokenSha256 */
	apiTokenSha256: string;
	/** The data directory: uploads check its volume's free space. */
	dataDir: string;
	/** The models the service routes: `whoami` reports its default and the providers the cloud can run right now. */
	models: ModelOptions;
	/** The service host's omp version: what a thread that names none runs. */
	ompVersion: string;
	/** Runs `/cloud login <provider>` flows for the cloud broker. */
	logins: LoginManager;
	/** The run-time settings the `/api/v1/settings` routes read and change. */
	settings: Settings;
	/** The service's git: `whoami` lists its hosts, and create fetches the base of delta handoffs through it. */
	git: GitService;
	/** Set when the config has a `dashboard` section: `POST /api/v1/dashboard/links` mints sign-in links for it. */
	dashboard?: DashboardRoutesOptions["dashboard"];
	/** The vmon client behind `GET /api/v1/vms`; absent when the service opened none (runner off and no dashboard, or vmon failed to open). */
	vmon?: VmInspector;
	/** The address of vmon's own dashboard, which `GET /api/v1/vms` links to. */
	vmonDashboard?: string;
	/** Set when the config has a `remote` section: the TLS listener's sources, fingerprint and advertised addresses. */
	remote?: RemoteSettings;
	/** The question timeout (`runner.questionTimeoutSeconds`): gives each unanswered question its `expiresAt`. Absent: no question has one. */
	questionTimeoutSeconds?: number;
	/** The `provider/id` of every model the cloud can run right now (the gateway's and the direct providers'), for `whoami`. Absent: whoami lists none. */
	modelIds?: () => string[];
	/** Limits concurrent diff/tree/files inspections. Absent: the service-wide gate (2 at a time); tests pass their own. */
	inspectGate?: InspectGate;
	/** The updater behind `GET /api/v1/update` and `whoami.update`; absent in a service without one (every test app): the update routes do not exist and whoami says `unsupported`. */
	update?: UpdateApi;
	/** The GitHub App, its REST client and the SSH signing key behind `/api/v1/github`, `/api/v1/signing` and `whoami.github`; absent in a service without them (most test apps): those routes do not exist. */
	github?: GithubWiring;
	/** The service's secret store behind `/api/v1/secrets`. Absent: a store of its own over `store` (the runner's one is shared, so its resolved `!command` values are cached once). */
	secrets?: ServiceSecrets;
	/** The MCP proxy: whether it is listening (`whoami.mcpProxy`), and the service's own addresses an http MCP server may not point at. Absent: no proxy. */
	mcp?: { proxy: boolean; selfHosts: readonly string[] };
}

/** What the GitHub and signing routes work with. */
export interface GithubWiring {
	app: GitHubApp;
	api: GitHubApi;
	signingKey: SigningKey;
}

/** A device's `last_seen_at` is written at most this often. */
const LAST_SEEN_INTERVAL_MS = 60_000;

/** The HTTP API as fetch handlers: `Bun.serve({ fetch: app.fetch })` on the loopback listener, `fetchRemote` on the TLS one. */
export interface App {
	/** The loopback listener's entry: authenticates `Authorization: Bearer` (the owner token or a device token), then serves the request. */
	fetch(req: Request, server?: ApiServer): Promise<Response>;
	/** The remote listener's entry: refuses sources outside `remote.allow` (403) and accepts device tokens only. */
	fetchRemote(req: Request, server?: ApiServer): Promise<Response>;
	/** Serves a request whose caller another listener already authenticated. */
	fetchAs(caller: Caller, req: Request, server?: ApiServer): Promise<Response>;
}

/** What this build serves, as `whoami` lists it: a client checks for a feature before it uses it. */
const CAPABILITIES: readonly string[] = [
	"threads.paging",
	"threads.meta",
	"threads.idempotency",
	"threads.scratch",
	"turns.reply",
	"events.json",
	"inspect",
	"messages.interrupt",
	"questions.meta",
	"threads.irc",
	"events.live",
	"events.children",
	"github.app",
	"commits.signed",
	"threads.pr",
	"secrets.store",
	"mcp.proxy",
	"threads.memory",
];

/** A message body: its text plus JSON framing. */
const MAX_MESSAGE_BODY_BYTES = MAX_TEXT_BYTES + 4096;
/** An answer body: its text, every option label and JSON framing. */
const MAX_ANSWER_BODY_BYTES = MAX_QUESTION_TEXT_BYTES + MAX_OPTIONS * (MAX_OPTION_LABEL_BYTES + 16) + 4096;

/** A route under `/api/v1/threads/{id}`; `answer` also carries the turn and question ids. */
type ThreadRoute =
	| { name: "get" | "delete" | "events" | "messages" | "irc" | "stop" | "result" | "conversation" | "memory" | "diff" | "tree"; id: string }
	| { name: "answer"; id: string; turn: number; question: number }
	| { name: "reply"; id: string; turn: number }
	| { name: "files"; id: string; path: string };

type Route = { name: "whoami" | "list" | "create" } | ThreadRoute;

const POSITIVE_INT = /^[1-9][0-9]*$/;

/** A positive decimal safe integer, else null. */
function positiveInt(segment: string): number | null {
	if (!POSITIVE_INT.test(segment)) return null;
	const n = Number(segment);
	return Number.isSafeInteger(n) ? n : null;
}

/** The route of `method` and `pathname` (exact; no trailing-slash variants), or null. */
function matchRoute(method: string, pathname: string): Route | null {
	const parts = pathname.split("/");
	if (parts.length < 4 || parts[0] !== "" || parts[1] !== "api" || parts[2] !== "v1") return null;
	const rest = parts.slice(3);
	if (rest[0] === "whoami") return rest.length === 1 && method === "GET" ? { name: "whoami" } : null;
	if (rest[0] !== "threads") return null;
	if (rest.length === 1) {
		if (method === "GET") return { name: "list" };
		return method === "POST" ? { name: "create" } : null;
	}
	const id = rest[1] ?? "";
	if (!THREAD_ID_PATTERN.test(id)) return null;
	if (rest.length === 2) {
		if (method === "GET") return { name: "get", id };
		return method === "DELETE" ? { name: "delete", id } : null;
	}
	if (method === "GET" && rest[2] === "files") {
		// Everything after `files/` is the repository path; an encoded `/` is decoded here and refused with `..` by the path rules.
		try {
			return { name: "files", id, path: decodeURIComponent(rest.slice(3).join("/")) };
		} catch {
			throw new ApiError(400, "path is not valid percent-encoding");
		}
	}
	if (rest.length === 3) {
		const leaf = rest[2];
		if (method === "GET" && (leaf === "events" || leaf === "result" || leaf === "conversation" || leaf === "memory" || leaf === "diff" || leaf === "tree")) {
			return { name: leaf, id };
		}
		if (method === "POST" && (leaf === "messages" || leaf === "stop" || leaf === "irc")) return { name: leaf, id };
		return null;
	}
	if (rest.length === 5 && method === "GET" && rest[2] === "turns" && rest[4] === "reply") {
		const turn = positiveInt(rest[3] ?? "");
		return turn === null ? null : { name: "reply", id, turn };
	}
	if (rest.length === 7 && method === "POST" && rest[2] === "turns" && rest[4] === "questions" && rest[6] === "answer") {
		const turn = positiveInt(rest[3] ?? "");
		const question = positiveInt(rest[5] ?? "");
		return turn === null || question === null ? null : { name: "answer", id, turn, question };
	}
	return null;
}

const COMMON_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function errorResponse(error: unknown): Response {
	if (error instanceof ApiError) {
		const headers = error.status === 401 ? { "WWW-Authenticate": 'Bearer realm="omp-cloud"', ...error.headers } : error.headers;
		return json(error.status, { error: error.message }, headers);
	}
	if (error instanceof StoreError) {
		switch (error.code) {
			case "thread_not_found":
			case "question_not_found":
				return json(404, { error: "not found" });
			case "thread_failed":
				return json(409, { error: "thread has failed; start a new one" });
			case "thread_full":
				return json(409, { error: "thread has 200 turns; start a new one" });
			case "not_waiting":
				return json(409, { error: "question is not waiting for an answer" });
			case "invalid_text":
			case "invalid_irc":
			case "invalid_answer":
				return json(400, { error: error.message });
			default:
				break;
		}
	}
	console.error(error);
	return json(500, { error: "internal error" });
}

function stringField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (value === undefined) return "";
	if (typeof value !== "string") throw new ApiError(400, "invalid JSON body");
	return value;
}

/** A string field that may also be `null` (absent). */
function optionalStringField(body: Record<string, unknown>, key: string): string {
	return body[key] === null ? "" : stringField(body, key);
}

function stringListField(body: Record<string, unknown>, key: string): string[] {
	const value = body[key];
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
		throw new ApiError(400, "invalid JSON body");
	}
	return value;
}

/** Builds the API over `options.store`. */
export function createApp(options: AppOptions): App {
	const { store, apiTokenSha256, dataDir, models, ompVersion, logins, settings, git, remote, modelIds, update, github } = options;
	const secrets = options.secrets ?? new ServiceSecrets(store);
	const questionTimeoutSeconds = options.questionTimeoutSeconds ?? 0;
	const inspectGate = options.inspectGate ?? INSPECTION_GATE;
	const dashboardRoutes = new DashboardRoutes({
		store,
		dashboard: options.dashboard,
		vmon: options.vmon,
		vmonDashboard: options.vmonDashboard,
	});
	const aborts = new DeviceAborts();
	const pairing = new PairingRoutes({ store, remote, limiter: new SourceLimiter(), aborts });

	async function download(thread: Thread, route: "result" | "conversation" | "memory", caller: Caller, req: Request): Promise<Response> {
		let file: Bun.BunFile | null;
		if (route === "result") file = await store.blob(thread.id, "result.bundle");
		else if (route === "memory") file = await store.blob(thread.id, "memory.tar");
		else file = (await store.blob(thread.id, "session-export.tar")) ?? (await store.blob(thread.id, "session.tar"));
		if (file === null) throw new ApiError(404, `no ${route} yet`);
		const headers: Record<string, string> = {
			"Content-Type": route === "result" ? "application/octet-stream" : "application/x-tar",
			"Accept-Ranges": "bytes",
		};
		if (route === "result") {
			headers["X-Omp-Branch"] = RESULT_BRANCH_PREFIX + thread.id;
			const resultTurn = store.threadStats(thread.id).resultTurn;
			if (resultTurn !== null) headers["X-Omp-Head"] = resultTurn.head;
			headers["X-Omp-Base"] = thread.repo.baseCommit;
		}
		return caller.device === null ? new Response(file, { headers }) : deviceDownload(file, req, headers, req.signal);
	}

	async function threadRoute(
		route: ThreadRoute,
		thread: Thread,
		caller: Caller,
		req: Request,
		server: ApiServer | undefined,
	): Promise<Response> {
		switch (route.name) {
			case "get":
				return json(
					200,
					detailView(thread, store.threadStats(thread.id), store.turns(thread.id), store.vm(thread.id), questionTimeoutSeconds),
				);
			case "delete":
				requireActive(store, caller, req.signal);
				if (!(await store.deleteThread(thread.id))) throw new ApiError(404, "not found");
				return json(202, { status: "deleting" });
			case "events":
				return new URL(req.url).searchParams.get("format") === "json"
					? json(200, eventsPage(store, thread.id, new URL(req.url)))
					: eventStream(store, thread.id, req, server);
			case "reply": {
				const turn = store.turns(thread.id).find((t) => t.id === route.turn);
				if (turn === undefined) throw new ApiError(404, `no turn ${route.turn}`);
				return json(200, turnTextPage(turn, new URL(req.url)));
			}
			case "diff":
			case "tree":
				return inspectResponse({ store, git, gate: inspectGate, signal: req.signal }, thread, route.name, new URL(req.url), "");
			case "files":
				return inspectResponse({ store, git, gate: inspectGate, signal: req.signal }, thread, "files", new URL(req.url), route.path);
			case "messages": {
				const body = await readJsonObject(req, MAX_MESSAGE_BODY_BYTES);
				const text = stringField(body, "text");
				const mode = stringField(body, "mode") || "queue";
				if (mode !== "queue" && mode !== "interrupt") throw new ApiError(400, "mode must be queue or interrupt");
				requireActive(store, caller, req.signal);
				if (mode === "queue") {
					const turn = turnView(store.enqueueTurn(thread.id, text, actorOf(caller)), questionTimeoutSeconds);
					return json(201, { turn, interrupted: false, cancelled: [] });
				}
				const sent = store.interruptThread(thread.id, text, actorOf(caller));
				return json(201, { turn: turnView(sent.turn, questionTimeoutSeconds), interrupted: sent.interrupted, cancelled: sent.cancelled });
			}
			case "irc": {
				const body = await readJsonObject(req, MAX_MESSAGE_BODY_BYTES);
				const text = stringField(body, "body");
				if (text.trim() === "" || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new ApiError(400, `body must be 1 to ${MAX_TEXT_BYTES} bytes`);
				const from = stringField(body, "from");
				const replyTo = optionalStringField(body, "replyTo");
				const id = optionalStringField(body, "id") || `irc_${crypto.randomUUID()}`;
				requireActive(store, caller, req.signal);
				const sent = store.sendIrc(thread.id, { id, from, body: text, replyTo });
				return json(201, { receipt: sent.receipt, id: sent.id, turn: sent.turn === null ? null : turnView(sent.turn, questionTimeoutSeconds) });
			}
			case "stop":
				requireActive(store, caller, req.signal);
				return json(200, store.stopThread(thread.id, actorOf(caller)));
			case "result":
			case "conversation":
			case "memory":
				return download(thread, route.name, caller, req);
			case "answer": {
				const body = await readJsonObject(req, MAX_ANSWER_BODY_BYTES);
				requireActive(store, caller, req.signal);
				const selected = stringListField(body, "selected");
				const answer = stringField(body, "answer");
				const question = store.answerQuestion(thread.id, route.turn, route.question, selected, answer, actorOf(caller));
				return json(200, questionView(question, questionTimeoutSeconds));
			}
		}
	}

	async function handle(caller: Caller, req: Request, server: ApiServer | undefined): Promise<Response> {
		const { principal } = caller;
		const pathname = new URL(req.url).pathname;
		requireScope(caller, req.method, pathname);
		if (pathname === LOGINS_PATH || pathname.startsWith(`${LOGINS_PATH}/`)) {
			return handleLogins(req, pathname.slice(LOGINS_PATH.length).split("/").slice(1), logins);
		}
		if (pathname === SETTINGS_PATH || pathname.startsWith(`${SETTINGS_PATH}/`)) {
			return handleSettings(req, pathname.slice(SETTINGS_PATH.length).split("/").slice(1), settings, principal);
		}
		if (github !== undefined && (pathname === GITHUB_PATH || pathname.startsWith(`${GITHUB_PATH}/`))) {
			return handleGithub(req, pathname.slice(GITHUB_PATH.length).split("/").slice(1), { app: github.app });
		}
		if (github !== undefined && (pathname === SIGNING_PATH || pathname.startsWith(`${SIGNING_PATH}/`))) {
			return handleSigning(req, pathname.slice(SIGNING_PATH.length).split("/").slice(1), {
				key: github.signingKey,
				app: github.app,
				api: github.api,
				settings,
			});
		}
		if (pathname === SECRETS_PATH || pathname.startsWith(`${SECRETS_PATH}/`)) {
			return handleSecrets(req, pathname.slice(SECRETS_PATH.length).split("/").slice(1), secrets, principal);
		}
		const pairingResponse = await pairing.handle(caller, req, pathname);
		if (pairingResponse !== null) return pairingResponse;
		const dashboardResponse = await dashboardRoutes.handle(caller, req, pathname, server);
		if (dashboardResponse !== null) return dashboardResponse;
		const updateResponse = await handleUpdate(update, caller, req, pathname);
		if (updateResponse !== null) return updateResponse;
		const route = matchRoute(req.method, pathname);
		if (route === null) return json(404, { error: "not found" });
		if ("id" in route) {
			const thread = store.getThread(route.id);
			if (thread === null || thread.owner !== principal) return json(404, { error: "not found" });
			return threadRoute(route, thread, caller, req, server);
		}
		switch (route.name) {
			case "whoami":
				return json(200, {
					user: principal,
					service: { version: SERVICE_VERSION, api: API_VERSION },
					capabilities: CAPABILITIES,
					limits: {
						maxMessageBytes: MAX_TEXT_BYTES,
						maxAnswerBytes: MAX_QUESTION_TEXT_BYTES,
						maxUploadBytes: MAX_SOURCE_BYTES,
						listMax: MAX_LIST_LIMIT,
						maxTurns: MAX_TURNS,
					},
					spend: { todayUSD: store.daySpend(principal, utcDay(new Date())), dayCapUSD: settings.get("policy.spend.dayUSD") },
					models: (modelIds?.() ?? []).map((id) => ({ id })),
					maxUploadBytes: MAX_SOURCE_BYTES,
					defaultModel: models.default,
					modelPatterns: modelPatterns(models),
					ompVersion,
					gitHosts: git.hosts(),
					vmWorkspace: VM_WORKSPACE,
					github: { app: github?.app.info()?.slug ?? null, signing: github !== undefined && github.signingKey.exists() && settings.get("git.sign") === "ssh" },
					mcpProxy: options.mcp?.proxy ?? false,
					mcpLogins: store.mcpCredentialUrls(),
					vms: store.countVms(principal),
					threads: store.countThreads(principal),
					device: caller.device,
					remote: remote === undefined ? null : { fingerprint: remote.fingerprint },
					update: await updateSummary(update),
				});
			case "list":
				return json(
					200,
					threadListBody(store, principal, new URL(req.url).searchParams, (t) => summaryView(t, store.threadStats(t.id), questionTimeoutSeconds)),
				);
			case "create": {
				const { thread, replayed } = await createThreadIdempotent(store, req, principal, {
					dataDir,
					models,
					ompVersion,
					git,
					settings,
					sentBy: actorOf(caller),
					beforeCreate: () => requireActive(store, caller, req.signal),
					mcpSelfHosts: options.mcp?.selfHosts,
				});
				const summary = summaryView(thread, store.threadStats(thread.id), questionTimeoutSeconds);
				return replayed ? json(200, { ...summary, replayed: true }) : json(201, { ...summary, warnings: [] });
			}
		}
	}

	/** Runs `attempt` and turns whatever it throws into the API's error answer; every response gets the common headers. */
	async function respond(attempt: () => Promise<Response>): Promise<Response> {
		let response: Response;
		try {
			response = await attempt();
		} catch (error) {
			response = errorResponse(error);
		}
		for (const [name, value] of Object.entries(COMMON_HEADERS)) {
			// The static relay keeps the dashboard's own Cache-Control.
			if (name !== "Cache-Control" || !response.headers.has(name)) response.headers.set(name, value);
		}
		return response;
	}

	/**
	 * Serves a request of an authenticated caller. A device's request is rebuilt with a signal that its device's revocation
	 * aborts too, and with a body that errors then, so its in-flight request, upload, download and event streams end when
	 * it is revoked; the server handle is bound to the original request, which is the one Bun knows.
	 */
	async function serveCaller(caller: Caller, req: Request, server: ApiServer | undefined): Promise<Response> {
		if (caller.device === null) return handle(caller, req, server);
		const bound: ApiServer = {
			requestIP: () => server?.requestIP(req) ?? null,
			timeout: (_request, seconds) => server?.timeout(req, seconds),
		};
		const revoked = aborts.signal(caller.device.id);
		const signal = AbortSignal.any([req.signal, revoked]);
		// A body is read through a stream that fails the moment the device is revoked: a slow upload cannot outlive it.
		// Only the methods whose handlers read a body get one; the others have nothing to guard.
		const carriesBody = req.body !== null && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH");
		const wrapped =
			req.body !== null && carriesBody
				? new Request(req.url, { method: req.method, headers: req.headers, body: abortableStream(req.body, signal), signal, duplex: "half" })
				: new Request(req, { signal });
		try {
			return await handle(caller, wrapped, bound);
		} catch (error) {
			// Whatever failed after the revocation (a body that ended with an error, a cancelled fetch) is the device's 401.
			throw revoked.aborted ? unauthorized() : error;
		}
	}

	/** One of the two API listeners' entry point: the remote one refuses foreign sources first and knows device tokens only. */
	function enter(req: Request, server: ApiServer | undefined, remoteListener: boolean): Promise<Response> {
		return respond(async () => {
			const address = server?.requestIP(req)?.address ?? null;
			if (remoteListener && (remote === undefined || address === null || !remote.access.permits(address))) {
				return json(403, { error: "forbidden" });
			}
			const pathname = new URL(req.url).pathname;
			if (req.method === "GET" && pathname === HEALTH_PATH) return json(200, healthBody());
			if (pairing.isPublic(req.method, pathname)) return pairing.handlePublic(req, pathname, address);
			const caller = authenticate(req, { apiTokenSha256, store, deviceOnly: remoteListener });
			if (caller === null) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="omp-cloud"' });
			if (caller.device !== null) {
				store.touchDevice(caller.device.id, address === null ? null : canonicalAddress(address), LAST_SEEN_INTERVAL_MS);
			}
			return serveCaller(caller, req, server);
		});
	}

	return {
		fetch: (req, server) => enter(req, server, false),
		fetchRemote: (req, server) => enter(req, server, true),
		fetchAs: (caller, req, server) => respond(() => serveCaller(caller, req, server)),
	};
}
