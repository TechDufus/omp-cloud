/**
 * Parsers for the service's JSON: every response is read once here, so the rest of the plugin
 * works with the named types of `types.ts`. A missing or mistyped field takes the API's
 * "absent" value (`""`, `0`, `false`, `[]` or `null`); only a wrong top-level shape throws.
 */

import { isRecord } from "./guards";
import type {
	Claim,
	Capacity,
	DashboardLink,
	Device,
	DeviceAccess,
	DeviceRef,
	LoginEntry,
	LoginList,
	Login,
	LoginState,
	OfferState,
	OfferStatus,
	PairingOffer,
	PendingQuestion,
	Question,
	QuestionOption,
	Redeemed,
	Revoked,
	ThreadActivity,
	ThreadContext,
	ThreadDetail,
	ThreadEvent,
	ThreadLatest,
	ThreadMetrics,
	ThreadPhase,
	ThreadRepoSummary,
	ThreadResult,
	ThreadSummary,
	ThreadTurn,
	TurnMetric,
	TurnState,
	TurnUsage,
	Whoami,
	CreatedThread,
	DiffFile,
	DiffStatResult,
	EventsPage,
	FileResult,
	QuestionKind,
	IrcPayload,
	IrcReceipt,
	IrcReceiptKind,
	SentMessage,
	TurnOrigin,
	ThreadsPage,
	TreeResult,
	TurnPart,
	ThreadOrigin,
	TurnTextPage,
	UpdateState,
	UpdateStatus,
	WhoamiDevice,
	WhoamiUpdate,
} from "./types";

type Obj = Record<string, unknown>;

const PHASES: readonly ThreadPhase[] = ["starting", "working", "waiting", "idle", "failed"];
const TURN_STATES: readonly TurnState[] = ["queued", "running", "done", "failed", "cancelled"];
const LOGIN_STATES: readonly LoginState[] = ["waiting", "done", "failed"];
const QUESTION_KINDS: readonly QuestionKind[] = ["ask", "approval", "push"];
const ORIGINS: readonly (ThreadOrigin | "")[] = ["user", "tool", ""];
const DIFF_STATUSES: readonly DiffFile["status"][] = ["A", "M", "D", "R"];
const REFS: readonly TreeResult["ref"][] = ["head", "base"];
const TURN_PARTS: readonly TurnPart[] = ["reply", "error", "text"];
const UPDATE_STATES: readonly UpdateState[] = ["idle", "checking", "downloading", "ready", "applying", "failed", "unsupported"];
const UPDATE_MODES: readonly UpdateStatus["mode"][] = ["off", "notify", "auto"];

function obj(v: unknown, what: string): Obj {
	if (!isRecord(v)) throw new Error(`${what}: the response is not a JSON object`);
	return v;
}

function str(o: Obj, key: string): string {
	const v = o[key];
	return typeof v === "string" ? v : "";
}

function num(o: Obj, key: string): number {
	const v = o[key];
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numOrNull(o: Obj, key: string): number | null {
	const v = o[key];
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(o: Obj, key: string): string | null {
	const v = o[key];
	return typeof v === "string" && v !== "" ? v : null;
}

function bool(o: Obj, key: string): boolean {
	return o[key] === true;
}

function strings(o: Obj, key: string): string[] {
	const v = o[key];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function records(o: Obj, key: string): Obj[] {
	const v = o[key];
	return Array.isArray(v) ? v.filter(isRecord) : [];
}

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
	return allowed.find(a => a === value) ?? fallback;
}

function options(o: Obj): QuestionOption[] {
	return records(o, "options").map(x => ({ label: str(x, "label"), description: str(x, "description") }));
}

/** Null when the service sends no update state. */
function parseWhoamiUpdate(v: unknown): WhoamiUpdate | null {
	if (!isRecord(v)) return null;
	return { state: oneOf(str(v, "state"), UPDATE_STATES, "idle"), available: strOrNull(v, "available"), mode: oneOf(str(v, "mode"), UPDATE_MODES, "notify") };
}

/** `GET /api/v1/update`. Fields the service leaves out take their absent values. */
export function parseUpdateStatus(json: unknown): UpdateStatus {
	const o = obj(json, "update status");
	const current = isRecord(o.current) ? o.current : {};
	const latest = isRecord(o.latest) ? o.latest : undefined;
	const applying = isRecord(o.applying) ? o.applying : undefined;
	const components = isRecord(o.components) ? o.components : {};
	const vmon = isRecord(components.vmon) ? components.vmon : {};
	return {
		mode: oneOf(str(o, "mode"), UPDATE_MODES, "notify"),
		managed: bool(o, "managed"),
		state: oneOf(str(o, "state"), UPDATE_STATES, "idle"),
		current: { version: str(current, "version") },
		latest: latest ? { version: str(latest, "version"), notes: str(latest, "notes"), publishedAt: str(latest, "publishedAt") } : null,
		staged: strOrNull(o, "staged"),
		applying: applying ? { version: str(applying, "version"), step: str(applying, "step"), startedAt: str(applying, "startedAt") } : null,
		error: strOrNull(o, "error"),
		message: strOrNull(o, "message"),
		checkedAt: strOrNull(o, "checkedAt"),
		vmon: { installed: strOrNull(vmon, "installed"), required: strOrNull(vmon, "required") },
	};
}

/** The version `POST /api/v1/update/apply` started installing. */
export function parseApplied(json: unknown): string {
	const o = obj(json, "update apply");
	return isRecord(o.applying) ? str(o.applying, "version") : "";
}

/** Anything but `full` is `threads`: the least a device can have, and what a service without access levels gives. */
function accessOf(v: string): DeviceAccess {
	return v === "full" ? "full" : "threads";
}

function whoamiDevice(v: unknown): WhoamiDevice | null {
	return isRecord(v) ? { id: str(v, "id"), name: str(v, "name"), access: accessOf(str(v, "access")) } : null;
}

/** Fields the service leaves out take their absent values: api 1, no capabilities, the limits the service enforces by default. */
export function parseWhoami(json: unknown): Whoami {
	const o = obj(json, "whoami");
	const vms = isRecord(o.vms) ? o.vms : {};
	const threads = isRecord(o.threads) ? o.threads : {};
	const service = isRecord(o.service) ? o.service : {};
	const limits = isRecord(o.limits) ? o.limits : {};
	const spend = isRecord(o.spend) ? o.spend : undefined;
	const maxUploadBytes = num(o, "maxUploadBytes");
	return {
		user: str(o, "user"),
		maxUploadBytes,
		defaultModel: str(o, "defaultModel"),
		modelPatterns: strings(o, "modelPatterns"),
		ompVersion: str(o, "ompVersion"),
		gitHosts: strings(o, "gitHosts"),
		mcpProxy: bool(o, "mcpProxy"),
		mcpLogins: strings(o, "mcpLogins"),
		vms: { running: num(vms, "running"), paused: num(vms, "paused") },
		threads: {
			starting: num(threads, "starting"),
			working: num(threads, "working"),
			waiting: num(threads, "waiting"),
			idle: num(threads, "idle"),
			failed: num(threads, "failed"),
		},
		device: whoamiDevice(o.device),
		remote: isRecord(o.remote) ? { fingerprint: str(o.remote, "fingerprint") } : null,
		service: { version: str(service, "version"), api: numOrNull(service, "api") ?? 1, name: str(service, "name") },
		capabilities: strings(o, "capabilities"),
		limits: {
			maxMessageBytes: numOrNull(limits, "maxMessageBytes") ?? 32768,
			maxAnswerBytes: numOrNull(limits, "maxAnswerBytes") ?? 4000,
			maxUploadBytes: numOrNull(limits, "maxUploadBytes") ?? maxUploadBytes,
			listMax: numOrNull(limits, "listMax") ?? 50,
			maxTurns: numOrNull(limits, "maxTurns") ?? 200,
		},
		spend: spend ? { todayUSD: num(spend, "todayUSD"), dayCapUSD: num(spend, "dayCapUSD") } : null,
		models: records(o, "models").map(m => ({ id: str(m, "id") })),
		update: parseWhoamiUpdate(o.update),
	};
}

/** `approval:*` keys are the human's approvals, `omp-cloud:push` the push question; anything else the model may answer. */
function questionKindOf(key: string): QuestionKind {
	if (key.startsWith("approval:")) return "approval";
	return key === "omp-cloud:push" ? "push" : "ask";
}

function parsePendingQuestion(v: unknown): PendingQuestion | null {
	if (!isRecord(v)) return null;
	return {
		turn: num(v, "turn"),
		id: num(v, "id"),
		ask: num(v, "ask"),
		text: str(v, "text"),
		header: str(v, "header"),
		options: options(v),
		multi: bool(v, "multi"),
		recommended: numOrNull(v, "recommended"),
		askedAt: str(v, "askedAt"),
		kind: oneOf(str(v, "kind"), QUESTION_KINDS, "ask"),
		expiresAt: strOrNull(v, "expiresAt"),
		remaining: num(v, "remaining"),
	};
}

export function parseQuestion(json: unknown): Question {
	const o = obj(json, "question");
	return {
		id: num(o, "id"),
		ask: num(o, "ask"),
		key: str(o, "key"),
		text: str(o, "text"),
		header: str(o, "header"),
		options: options(o),
		multi: bool(o, "multi"),
		recommended: numOrNull(o, "recommended"),
		askedAt: str(o, "askedAt"),
		kind: oneOf(str(o, "kind"), QUESTION_KINDS, questionKindOf(str(o, "key"))),
		expiresAt: strOrNull(o, "expiresAt"),
		selected: strings(o, "selected"),
		answer: str(o, "answer"),
		answeredBy: str(o, "answeredBy"),
		answeredAt: str(o, "answeredAt"),
		expired: bool(o, "expired"),
	};
}

function parseLatest(v: unknown): ThreadLatest | null {
	if (!isRecord(v)) return null;
	return {
		id: num(v, "id"),
		state: oneOf(str(v, "state"), TURN_STATES, "done"),
		title: str(v, "title"),
		reply: str(v, "reply"),
		error: str(v, "error"),
		completedAt: str(v, "completedAt"),
	};
}

function parseResult(v: unknown): ThreadResult | null {
	if (!isRecord(v)) return null;
	return {
		branch: str(v, "branch"),
		head: str(v, "head"),
		base: str(v, "base"),
		filesChanged: num(v, "filesChanged"),
		insertions: num(v, "insertions"),
		deletions: num(v, "deletions"),
		pushed: bool(v, "pushed"),
		pushError: str(v, "pushError"),
		pushRef: str(v, "pushRef"),
		updatedAt: str(v, "updatedAt"),
	};
}

function parseUsage(v: unknown): TurnUsage | null {
	if (!isRecord(v)) return null;
	return {
		inputTokens: num(v, "inputTokens"),
		outputTokens: num(v, "outputTokens"),
		cacheReadTokens: num(v, "cacheReadTokens"),
		cacheWriteTokens: num(v, "cacheWriteTokens"),
		cost: num(v, "cost"),
	};
}

function parseContext(v: unknown): { tokens: number; window: number } | null {
	if (!isRecord(v)) return null;
	return { tokens: num(v, "tokens"), window: num(v, "window") };
}

function parseThreadContext(v: unknown): ThreadContext | null {
	return isRecord(v) ? { tokens: num(v, "tokens"), window: num(v, "window"), at: str(v, "at") } : null;
}

function parseTurnMetric(o: Obj): TurnMetric {
	return { n: num(o, "n"), cost: num(o, "cost"), contextTokens: numOrNull(o, "contextTokens") };
}

/** Null when the service sent no metrics: the list then shows none. */
function parseMetrics(v: unknown): ThreadMetrics | null {
	if (!isRecord(v)) return null;
	return {
		usage: parseUsage(v.usage) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
		requests: num(v, "requests"),
		tools: num(v, "tools"),
		workMs: num(v, "workMs"),
		context: parseThreadContext(v.context),
		turns: records(v, "turns").map(parseTurnMetric),
	};
}

function parseActivity(v: unknown): ThreadActivity | null {
	if (!isRecord(v)) return null;
	const kind = oneOf(str(v, "kind"), ["tool", "assistant"], "assistant");
	return { kind, text: str(v, "text"), at: str(v, "at") };
}

const TURN_ORIGINS: readonly TurnOrigin[] = ["", "irc"];

export function parseTurn(o: Obj): ThreadTurn {
	return {
		id: num(o, "id"),
		state: oneOf(str(o, "state"), TURN_STATES, "queued"),
		text: str(o, "text"),
		by: str(o, "by"),
		queuedAt: str(o, "queuedAt"),
		startedAt: str(o, "startedAt"),
		completedAt: str(o, "completedAt"),
		reply: str(o, "reply"),
		title: str(o, "title"),
		error: str(o, "error"),
		usage: parseUsage(o.usage),
		head: str(o, "head"),
		filesChanged: num(o, "filesChanged"),
		insertions: num(o, "insertions"),
		deletions: num(o, "deletions"),
		pushed: bool(o, "pushed"),
		pushError: str(o, "pushError"),
		pushRef: str(o, "pushRef"),
		requests: num(o, "requests"),
		tools: num(o, "tools"),
		context: parseContext(o.context),
		origin: oneOf(str(o, "origin"), TURN_ORIGINS, ""),
		ircFrom: str(o, "ircFrom"),
		ircId: str(o, "ircId"),
		ircReplyTo: str(o, "ircReplyTo"),
		questions: records(o, "questions").map(parseQuestion),
	};
}

function parsePullRequest(v: unknown): { number: number; url: string } | null {
	return isRecord(v) && num(v, "number") > 0 ? { number: num(v, "number"), url: str(v, "url") } : null;
}

function parseSummaryFields(o: Obj): Omit<ThreadSummary, "turns" | "warnings" | "repo" | "workspace"> {
	return {
		id: str(o, "id"),
		name: str(o, "name"),
		title: str(o, "title"),
		owner: str(o, "owner"),
		phase: oneOf(str(o, "phase"), PHASES, "idle"),
		error: str(o, "error"),
		queued: num(o, "queued"),
		model: str(o, "model"),
		thinking: str(o, "thinking"),
		ompVersion: str(o, "ompVersion"),
		latest: parseLatest(o.latest),
		question: parsePendingQuestion(o.question),
		result: parseResult(o.result),
		createdAt: str(o, "createdAt"),
		lastActivityAt: str(o, "lastActivityAt"),
		archivedAt: strOrNull(o, "archivedAt"),
		metrics: parseMetrics(o.metrics),
		activity: parseActivity(o.activity),
		origin: oneOf(str(o, "origin"), ORIGINS, ""),
		ref: str(o, "ref"),
		session: str(o, "session"),
		scratch: bool(o, "scratch"),
		pr: parsePullRequest(o.pr),
	};
}

function parseRepoSummary(repo: Obj): ThreadRepoSummary {
	return { name: str(repo, "name"), remoteURL: str(repo, "remoteURL"), baseRef: str(repo, "baseRef"), localBranch: str(repo, "localBranch") };
}

export function parseThreadSummary(json: unknown): ThreadSummary {
	const o = obj(json, "thread");
	const repo = isRecord(o.repo) ? o.repo : {};
	return { ...parseSummaryFields(o), turns: num(o, "turns"), warnings: strings(o, "warnings"), repo: parseRepoSummary(repo), workspace: str(o, "workspace") };
}

export function parseThreadsPage(json: unknown): ThreadsPage {
	const o = obj(json, "thread list");
	const threads = records(o, "threads").map(parseThreadSummary);
	return { threads, next: strOrNull(o, "next"), total: numOrNull(o, "total") ?? threads.length };
}

export function parseThreadDetail(json: unknown): ThreadDetail {
	const o = obj(json, "thread");
	const repo = isRecord(o.repo) ? o.repo : {};
	const paths = isRecord(o.paths) ? o.paths : {};
	const vm = isRecord(o.vm) ? o.vm : undefined;
	return {
		...parseSummaryFields(o),
		repo: {
			...parseRepoSummary(repo),
			baseCommit: str(repo, "baseCommit"),
			handoffCommit: str(repo, "handoffCommit"),
		},
		paths: { home: str(paths, "home"), workspace: str(paths, "workspace") },
		configOverlays: strings(o, "configOverlays"),
		vm: vm ? { sandboxId: str(vm, "sandboxId"), state: str(vm, "state"), pid: numOrNull(vm, "pid") } : null,
		turns: records(o, "turns").map(parseTurn),
		readOnly: isRecord(o.policy) && o.policy.readOnly === true,
	};
}

/** The event of one SSE `data:` payload; undefined for a payload that is not an event. */
export function parseEvent(json: unknown): ThreadEvent | undefined {
	if (!isRecord(json)) return undefined;
	const seq = json.seq;
	if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return undefined;
	return { seq, at: str(json, "at"), kind: str(json, "kind"), turn: numOrNull(json, "turn"), text: str(json, "text") };
}

export function parseLogin(json: unknown): Login {
	const o = obj(json, "login");
	return {
		id: str(o, "id"),
		provider: str(o, "provider"),
		state: oneOf(str(o, "state"), LOGIN_STATES, "waiting"),
		url: str(o, "url"),
		instructions: str(o, "instructions"),
		userCode: str(o, "userCode"),
		account: str(o, "account"),
		error: str(o, "error"),
	};
}

export function parseDashboardLink(json: unknown): DashboardLink {
	const o = obj(json, "dashboard link");
	return { url: str(o, "url"), expiresAt: str(o, "expiresAt") };
}

const OFFER_STATUSES: readonly OfferStatus[] = ["open", "pending", "approved", "paired", "declined", "cancelled", "burned", "expired"];

function deviceRef(v: unknown): DeviceRef | null {
	return isRecord(v) ? { id: str(v, "id"), name: str(v, "name") } : null;
}

export function parsePairingOffer(json: unknown): PairingOffer {
	const o = obj(json, "pairing offer");
	return { id: str(o, "id"), code: str(o, "code"), expiresAt: str(o, "expiresAt"), fingerprint: str(o, "fingerprint"), addresses: strings(o, "addresses") };
}

/** A status the plugin does not know is `expired`: nothing can be done with the offer. */
export function parseOfferState(json: unknown): OfferState {
	const o = obj(json, "pairing offer");
	const req = isRecord(o.request) ? o.request : undefined;
	return {
		id: str(o, "id"),
		status: oneOf(str(o, "status"), OFFER_STATUSES, "expired"),
		expiresAt: str(o, "expiresAt"),
		request: req ? { name: str(req, "name"), platform: str(req, "platform"), address: str(req, "address"), at: str(req, "at") } : null,
		device: deviceRef(o.device),
	};
}

export function parseRedeemed(json: unknown): Redeemed {
	const o = obj(json, "pairing redeem");
	return { request: str(o, "request"), requestSecret: str(o, "requestSecret"), expiresAt: str(o, "expiresAt") };
}

/** The 201 body of a claim: the device and its token. */
export function parseClaimed(json: unknown): Extract<Claim, { status: "paired" }> {
	const o = obj(json, "pairing claim");
	return { status: "paired", device: deviceRef(o.device) ?? { id: "", name: "" }, token: str(o, "token") };
}

/** The service's settings (`GET /settings`), each with its current value; the other fields of an entry (type, doc, source) are not read. */
export function parseSettings(json: unknown): { key: string; value: unknown }[] {
	return records(obj(json, "settings"), "settings").map(s => ({ key: str(s, "key"), value: s.value }));
}

export function parseDevices(json: unknown): Device[] {
	return records(obj(json, "devices"), "devices").map(parseDevice);
}

function parseDevice(d: Obj): Device {
	return {
		id: str(d, "id"),
		name: str(d, "name"),
		platform: str(d, "platform"),
		access: accessOf(str(d, "access")),
		createdAt: str(d, "createdAt"),
		pairedFrom: str(d, "pairedFrom"),
		lastSeenAt: str(d, "lastSeenAt"),
		lastSeenAddress: str(d, "lastSeenAddress"),
		current: bool(d, "current"),
	};
}

/** `PATCH /api/v1/devices/{id}`: `{device}`. */
export function parseDeviceChanged(json: unknown): Device {
	const o = obj(json, "device");
	return parseDevice(isRecord(o.device) ? o.device : {});
}

/** `GET /api/v1/logins`: a login entry the plugin cannot read as an object is skipped. */
export function parseLoginList(json: unknown): LoginList {
	const o = obj(json, "logins");
	const logins: LoginEntry[] = records(o, "logins").map(e => ({
		provider: str(e, "provider"),
		kind: str(e, "kind") === "mcp" ? "mcp" : "provider",
		account: str(e, "account"),
		loggedInAt: str(e, "loggedInAt"),
		renewBy: str(e, "renewBy"),
		disabled: bool(e, "disabled"),
		note: str(e, "note"),
	}));
	return { logins, brokerError: str(o, "brokerError") };
}

/** `GET /api/v1/capacity`; the lists the plugin does not show (`history`, `members`) are not read. */
export function parseCapacity(json: unknown): Capacity {
	const o = obj(json, "capacity");
	const pair = (key: string): { total: number; allocated: number } => {
		const v = isRecord(o[key]) ? o[key] : {};
		return { total: num(v, "total"), allocated: num(v, "allocated") };
	};
	const machines = isRecord(o.machines) ? o.machines : {};
	const vms = isRecord(o.vms) ? o.vms : {};
	const cloud = isRecord(vms.cloud) ? vms.cloud : {};
	const size = isRecord(vms.size) ? vms.size : {};
	const cluster = isRecord(o.cluster) ? o.cluster : {};
	return {
		available: bool(o, "available"),
		problem: str(o, "problem"),
		fix: str(o, "fix"),
		machines: { total: num(machines, "total"), ready: num(machines, "ready") },
		vcpus: pair("vcpus"),
		memoryMB: pair("memoryMB"),
		diskFreeMB: num(o, "diskFreeMB"),
		vms: {
			cluster: num(vms, "cluster"),
			cloud: { running: num(cloud, "running"), paused: num(cloud, "paused"), limit: num(cloud, "limit") },
			size: { vcpus: num(size, "vcpus"), memoryMB: num(size, "memoryMB") },
		},
		cluster: { accepting: bool(cluster, "accepting"), address: str(cluster, "address"), joinCommand: str(cluster, "joinCommand"), versionSkew: bool(cluster, "versionSkew") },
	};
}

export function parseRevoked(json: unknown): Revoked {
	const o = obj(json, "revoked device");
	return { device: deviceRef(o.device) ?? { id: "", name: "" }, runningThreads: strings(o, "runningThreads") };
}

function parseDiffFile(o: Obj): DiffFile {
	return { path: str(o, "path"), status: oneOf(str(o, "status"), DIFF_STATUSES, "M"), insertions: num(o, "insertions"), deletions: num(o, "deletions") };
}

export function parseDiffStat(json: unknown): DiffStatResult {
	const o = obj(json, "diff stat");
	return { stat: { base: str(o, "base"), head: str(o, "head"), files: records(o, "files").map(parseDiffFile), insertions: num(o, "insertions"), deletions: num(o, "deletions") } };
}

export function parseTree(json: unknown): TreeResult {
	const o = obj(json, "tree");
	return {
		ref: oneOf(str(o, "ref"), REFS, "head"),
		commit: str(o, "commit"),
		path: str(o, "path"),
		entries: records(o, "entries").map(e => ({ path: str(e, "path"), type: oneOf(str(e, "type"), ["file", "dir"], "file"), size: num(e, "size") })),
		truncated: bool(o, "truncated"),
	};
}

export function parseFile(json: unknown): FileResult {
	const o = obj(json, "file");
	return {
		path: str(o, "path"),
		ref: oneOf(str(o, "ref"), REFS, "head"),
		commit: str(o, "commit"),
		size: num(o, "size"),
		binary: bool(o, "binary"),
		offset: num(o, "offset"),
		text: str(o, "text"),
		next: numOrNull(o, "next"),
	};
}

export function parseTurnTextPage(json: unknown): TurnTextPage {
	const o = obj(json, "turn text");
	return { turn: num(o, "turn"), part: oneOf(str(o, "part"), TURN_PARTS, "reply"), total: num(o, "total"), offset: num(o, "offset"), text: str(o, "text"), next: numOrNull(o, "next") };
}

export function parseEventsPage(json: unknown): EventsPage {
	const o = obj(json, "events");
	const events: ThreadEvent[] = [];
	for (const e of Array.isArray(o.events) ? o.events : []) {
		const event = parseEvent(e);
		if (event) events.push(event);
	}
	return { events, next: numOrNull(o, "next") };
}

/** The 201 answer of a message: the queued turn, whether a running turn was stopped, and the queued turns cancelled. */
export function parseSentMessage(json: unknown): SentMessage {
	const o = obj(json, "message");
	const cancelled = Array.isArray(o.cancelled) ? o.cancelled.filter((n): n is number => typeof n === "number" && Number.isInteger(n)) : [];
	return { turn: parseTurn(isRecord(o.turn) ? o.turn : {}), interrupted: bool(o, "interrupted"), cancelled };
}

const IRC_RECEIPTS: readonly IrcReceiptKind[] = ["injected", "woken", "revived"];

/** The 201 answer of an IRC message; a receipt this client does not know is an error, never a guess. */
export function parseIrcReceipt(json: unknown): IrcReceipt {
	const o = obj(json, "irc");
	const receipt = IRC_RECEIPTS.find(r => r === o.receipt);
	if (receipt === undefined) throw new Error(`irc: unknown receipt ${JSON.stringify(o.receipt)}`);
	return { receipt, id: str(o, "id"), turn: isRecord(o.turn) ? parseTurn(o.turn) : null };
}

/** The message of an `irc` event's text; undefined when the text is not one (no id, sender or body). */
export function parseIrcPayload(text: string): IrcPayload | undefined {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(json)) return undefined;
	const payload: IrcPayload = { id: str(json, "id"), from: str(json, "from"), to: str(json, "to"), body: str(json, "body"), replyTo: str(json, "replyTo"), at: str(json, "at") };
	return payload.id === "" || payload.from === "" || payload.body === "" ? undefined : payload;
}

/** The answer of a create: a thread summary, plus `replayed: true` for an Idempotency-Key that had created it before. */
export function parseCreatedThread(json: unknown): CreatedThread {
	return { summary: parseThreadSummary(json), replayed: isRecord(json) && json.replayed === true };
}
