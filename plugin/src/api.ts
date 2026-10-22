import { randomUUID } from "node:crypto";
import { CloudError, cloudAborted, cloudErrorFromStatus, mayHaveReached, toCloudError, withOutcomeUnknown } from "./errors";
import { isRecord } from "./guards";
import type {
	AnswerBody,
	Claim,
	CreatedThread,
	DashboardLink,
	Device,
	DiffStatResult,
	DiffTextResult,
	EventsPage,
	FileResult,
	HandoffRequest,
	Login,
	OfferState,
	PairingOffer,
	Question,
	Redeemed,
	ResultHeaders,
	Revoked,
	ScratchHandoffRequest,
	IrcMessageBody,
	IrcReceipt,
	SentMessage,
	ThreadDetail,
	ThreadEvent,
	ThreadOrigin,
	ThreadPhase,
	ThreadSummary,
	ThreadsPage,
	TreeResult,
	TurnPart,
	TurnTextPage,
	UpdateStatus,
	Whoami,
} from "./types";
import { refusePairingCode } from "./pairing";
import {
	parseApplied,
	parseClaimed,
	parseCreatedThread,
	parseDashboardLink,
	parseDevices,
	parseDiffStat,
	parseEvent,
	parseEventsPage,
	parseFile,
	parseLogin,
	parseOfferState,
	parsePairingOffer,
	parseQuestion,
	parseRedeemed,
	parseRevoked,
	parseIrcReceipt,
	parseSentMessage,
	parseThreadDetail,
	parseThreadsPage,
	parseTree,
	parseTurnTextPage,
	parseUpdateStatus,
	parseWhoami,
} from "./wire";

export interface HandoffParts {
	request: HandoffRequest | ScratchHandoffRequest;
	/** Path of the git bundle. */
	source?: string;
	/** Path of the `omp session pack` archive. */
	conversation?: string;
	/** Path of setup.tar.gz. */
	setup?: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Every client method takes these as its last argument (inside its query or option object where it has one). */
export interface CallOptions {
	signal?: AbortSignal;
}

export interface EventStreamOptions extends CallOptions {
	/** Start after this sequence number (`?after=`). */
	after?: number;
	/** Resume after this sequence number (the `Last-Event-ID` header), as an EventSource does. */
	lastEventId?: number;
	/** The stream is dead when nothing, keepalive comments included, arrives for this long. The service sends one every 15 s. */
	idleMs?: number;
	/** Called once when the response is open, before the first event is read: contact with the service is proven. */
	onOpen?: () => void;
}

/** `GET /threads` filters (`threads.paging`; a service without it ignores them and answers its newest 50). */
export interface ThreadsQuery extends CallOptions {
	/** 1-200, default 50. */
	limit?: number;
	/** The `next` cursor of the previous page. */
	before?: string;
	phase?: ThreadPhase[];
	origin?: ThreadOrigin;
	ref?: string;
	session?: string;
	/** Repository name. */
	repo?: string;
	/** ISO time: threads with `lastActivityAt` at or after it. */
	since?: string;
}

export interface TurnTextQuery extends CallOptions {
	/** Default `reply`. */
	part?: TurnPart;
	/** UTF-16 code units, default 0. */
	offset?: number;
	/** 1-32000, default 8000. */
	limit?: number;
}

export interface EventsQuery extends CallOptions {
	after?: number;
	/** 1-500, default 100. */
	limit?: number;
	kinds?: string[];
	turn?: number;
}

export interface DiffQuery extends CallOptions {
	/** Default: base to the newest head; with a turn, the previous head to that turn's head. */
	turn?: number;
	path?: string;
	/** 0-20, default 3. */
	context?: number;
	/** 1-1048576, default 65536. */
	maxBytes?: number;
}

export interface TreeQuery extends CallOptions {
	/** Default `head`. */
	ref?: "head" | "base";
	/** A directory; default the root. */
	path?: string;
	recursive?: boolean;
}

export interface FileQuery extends CallOptions {
	/** Default `head`. */
	ref?: "head" | "base";
	/** Bytes of the file, default 0. */
	offset?: number;
	/** At most 1048576, default 65536. */
	limit?: number;
}

export interface SendOptions extends CallOptions {
	/** `interrupt` stops the running turn, cancels every queued turn (as `stop` does) and queues the message to run next (`messages.interrupt`); the answer's `cancelled` lists the cancelled turn ids. Default `queue`. */
	mode?: "queue" | "interrupt";
}

export interface CreateOptions extends CallOptions {
	/** `[A-Za-z0-9._:-]{1,128}`: the create is retried safely and a repeat answers with the existing thread (`threads.idempotency`). */
	idempotencyKey?: string;
	/** Told, in a sentence, when an attempt failed and the next one is scheduled. */
	onProgress?: (note: string) => void;
}

/** Test seams: the waits between attempts and their jitter. */
export interface ClientTuning {
	/** The wait before retry 1, 2, 3, ... Default 0.5 s, 1.5 s, 4 s; its length is the number of retries. */
	backoffMs?: readonly number[];
	/** In [0, 1). */
	random?: () => number;
	/** The longest `Retry-After` waited for, in seconds; a longer one ends the call with the error. Default 30. */
	maxRetryAfterSec?: number;
}

/**
 * A budget for commands and UI refreshes that a person waits on: one retry after about 250 ms (the base schedule's first
 * wait when that is shorter) and a `Retry-After` honoured only up to 1 s. The model's tool operations and the following
 * and waiting paths keep the full schedule.
 */
export function quickTuning(base: ClientTuning = {}): ClientTuning {
	const first = (base.backoffMs ?? DEFAULT_BACKOFF_MS)[0];
	return { ...base, backoffMs: first === undefined ? [] : [Math.min(first, QUICK_RETRY_MS)], maxRetryAfterSec: Math.min(base.maxRetryAfterSec ?? MAX_RETRY_AFTER_SEC, QUICK_RETRY_AFTER_SEC) };
}

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const API_TIMEOUT_MS = 30 * 1000;
export const STREAM_IDLE_MS = 45 * 1000;
const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1500, 4000];
const MAX_RETRY_AFTER_SEC = 30;
const QUICK_RETRY_MS = 250;
const QUICK_RETRY_AFTER_SEC = 1;
const UPGRADE_HINT = "update the omp-cloud service (`omp-cloud update` for an installed service; `git pull`, then restart it, for a checkout)";

/**
 * `retry`: repeated on a retriable failure (reads, stop, answer, delete, a create with an Idempotency-Key).
 * `once`: sent once, and a lost answer is `ambiguous_outcome` (a message).
 * `stream`: safe to repeat but not repeated here (the event stream's follower owns its reconnects).
 */
type Mode = "retry" | "once" | "stream";

/** What a failed write's recovery returns when the failure turns out to be success: the value the call would have returned. */
type Settle<T> = (error: CloudError) => Promise<{ value: T } | undefined>;

interface Call extends CallOptions {
	mode?: Mode;
	body?: () => FormData;
	json?: unknown;
	/** `0` for none (the event stream). */
	timeoutMs?: number;
	headers?: Record<string, string>;
	/** A public call: no `Authorization` header. */
	anonymous?: boolean;
	/** Which limit a 413 names. */
	limitOf?: "message" | "answer" | "upload";
	onProgress?: (note: string) => void;
	/** The call is a write (anything but a GET): an attempt that may have reached the service is tracked by `#run`. */
	write?: boolean;
}

function retryAfterSec(headers: Headers): number | undefined {
	const value = headers.get("Retry-After")?.trim();
	if (!value) return undefined;
	if (/^\d+$/.test(value)) return Number(value);
	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function formatBytes(n: number): string {
	return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MiB` : `${n} bytes`;
}

/** `path` with each segment percent-encoded: a repository path in a URL. */
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function query(params: Record<string, string | number | boolean | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
	const text = search.toString();
	return text === "" ? "" : `?${text}`;
}

export class CloudClient {
	readonly #base: string;
	readonly #token: string;
	readonly #fetch: FetchFn;
	readonly #backoffMs: readonly number[];
	readonly #random: () => number;
	readonly #maxRetryAfterSec: number;
	/** The newest `whoami`: the limits for a 413 message, and the capabilities `requireCapability` checks. */
	#whoami: Whoami | undefined;

	constructor(url: string, token: string, fetchFn: FetchFn = (i, init) => fetch(i, init), tuning: ClientTuning = {}) {
		this.#base = url.replace(/\/+$/, "");
		this.#token = token;
		this.#fetch = fetchFn;
		this.#backoffMs = tuning.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.#random = tuning.random ?? Math.random;
		this.#maxRetryAfterSec = tuning.maxRetryAfterSec ?? MAX_RETRY_AFTER_SEC;
	}

	/** One attempt: the response, or a CloudError. */
	async #exchange(method: string, path: string, call: Call): Promise<Response> {
		const headers: Record<string, string> = { ...(call.anonymous ? {} : { Authorization: `Bearer ${this.#token}` }), ...call.headers };
		let body: FormData | string | undefined = call.body?.();
		if (call.json !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(call.json);
		}
		const signals: AbortSignal[] = [];
		if (call.timeoutMs !== 0) signals.push(AbortSignal.timeout(call.timeoutMs ?? API_TIMEOUT_MS));
		if (call.signal) signals.push(call.signal);
		const res = await this.#fetch(this.#base + path, { method, headers, body, redirect: "error", signal: signals.length > 0 ? AbortSignal.any(signals) : undefined });
		if (res.ok) return res;
		let message = `${res.status} ${res.statusText}`.trim();
		try {
			const j: unknown = await res.json();
			if (isRecord(j) && typeof j.error === "string" && j.error) message = j.error;
		} catch {
			// non-JSON error body: keep the status line
		}
		const error = cloudErrorFromStatus(res.status, message, retryAfterSec(res.headers));
		if (res.status === 413 && call.limitOf !== undefined) {
			const limits = this.#whoami?.limits;
			const bytes = call.limitOf === "message" ? (limits?.maxMessageBytes ?? 32768) : call.limitOf === "answer" ? (limits?.maxAnswerBytes ?? 4000) : limits?.maxUploadBytes;
			if (bytes) throw new CloudError({ code: error.code, message: `${message} (the limit is ${formatBytes(bytes)})`, status: 413, retriable: false, outcomeKnown: true });
		}
		throw error;
	}

	/** Waits `ms`, ending early with an `aborted` error when the caller cancels. */
	#sleep(ms: number, signal: AbortSignal | undefined, mode: Mode): Promise<void> {
		const failed = { repeatable: mode !== "once" };
		if (signal?.aborted) return Promise.reject(cloudAborted(failed));
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(cloudAborted(failed));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		return promise;
	}

	/**
	 * Runs `attempt`; on a retriable failure of a `retry` call waits (backoff with jitter, `Retry-After` up to 30 s, never
	 * past the caller's abort) and tries again. A write whose earlier attempt may have reached the service reports its final
	 * failure with `outcomeKnown: false`, unless `settle` recognises that the earlier attempt worked.
	 */
	async #run<T>(call: Call, attempt: () => Promise<T>, settle?: Settle<T>): Promise<T> {
		const mode = call.mode ?? "retry";
		const failed = { repeatable: mode !== "once", target: this.#base };
		/** An earlier attempt of a write may have taken effect. */
		let delivered = false;
		const finish = async (error: CloudError): Promise<T> => {
			if (delivered && settle) {
				const settled = await settle(error).catch(() => undefined);
				if (settled) return settled.value;
			}
			throw delivered ? withOutcomeUnknown(error) : error;
		};
		for (let n = 0; ; n++) {
			try {
				return await attempt();
			} catch (e) {
				if (call.write && mayHaveReached(e)) delivered = true;
				if (call.signal?.aborted) return finish(cloudAborted(failed));
				const error = toCloudError(e, failed);
				const delay = this.#backoffMs[n];
				if (mode !== "retry" || !error.retriable || delay === undefined) return finish(error);
				if (error.retryAfterSec !== undefined && error.retryAfterSec > this.#maxRetryAfterSec) return finish(error);
				const wait = Math.max(delay * (0.75 + 0.5 * this.#random()), (error.retryAfterSec ?? 0) * 1000);
				call.onProgress?.(`${error.message}; retrying in ${Math.round(wait / 100) / 10}s (attempt ${n + 2} of ${this.#backoffMs.length + 1})`);
				try {
					await this.#sleep(wait, call.signal, mode);
				} catch (aborted) {
					return finish(toCloudError(aborted, failed));
				}
			}
		}
	}

	/** A request whose answer is parsed. Parsing is part of the attempt: an answer that does not parse is an `unavailable` error. */
	#call<T>(method: string, path: string, parse: (json: unknown) => T, call: Call = {}): Promise<T> {
		return this.#run({ mode: method === "GET" || method === "DELETE" ? "retry" : "once", write: method !== "GET", ...call }, async () => parse(await (await this.#exchange(method, path, call)).json()));
	}

	/** A request whose answer is not read. `settle` may turn a final failure into success (see {@link Settle}). */
	#send(method: string, path: string, call: Call = {}, settle?: Settle<void>): Promise<void> {
		return this.#run(
			{ mode: method === "GET" || method === "DELETE" ? "retry" : "once", write: method !== "GET", ...call },
			async () => {
				const res = await this.#exchange(method, path, call);
				await res.body?.cancel();
			},
			settle,
		);
	}

	async whoami(opts: CallOptions = {}): Promise<Whoami> {
		const who = await this.#call("GET", "/api/v1/whoami", parseWhoami, opts);
		this.#whoami = who;
		return who;
	}

	/** `GET /update`: the owner's view of the updater (a device is refused with `forbidden`; a service without updates answers `not_found`). */
	async updateStatus(opts: CallOptions = {}): Promise<UpdateStatus> {
		return this.#call("GET", "/api/v1/update", parseUpdateStatus, opts);
	}

	/** `POST /update/check`: asks the service to look for a newer release now. Owner only. */
	async checkUpdate(opts: CallOptions = {}): Promise<void> {
		await this.#send("POST", "/api/v1/update/check", { signal: opts.signal, mode: "retry" });
	}

	/** `POST /update/apply`: installs the staged release and restarts the service; the version being installed. Owner only; `conflict` when nothing is ready or an apply runs. Never retried: a lost answer is `ambiguous_outcome`. */
	async applyUpdate(opts: CallOptions = {}): Promise<string> {
		return this.#call("POST", "/api/v1/update/apply", parseApplied, { signal: opts.signal });
	}

	/**
	 * Throws `version_skew` when the service does not serve `capability` (see `Whoami.capabilities`). Answered from the
	 * last `whoami`; a service that lacked it is asked once more, since it may have been updated since.
	 */
	async requireCapability(capability: string, opts: CallOptions = {}): Promise<void> {
		const cached = this.#whoami;
		const who = cached ?? (await this.whoami(opts));
		if (who.capabilities.includes(capability)) return;
		const fresh = cached === undefined ? who : await this.whoami(opts);
		if (fresh.capabilities.includes(capability)) return;
		const service = fresh.service.version === "" ? `a service of unknown version (api ${fresh.service.api})` : `service ${fresh.service.version} (api ${fresh.service.api})`;
		throw new CloudError({ code: "version_skew", message: `the cloud is ${service} and does not support ${capability}`, retriable: false, outcomeKnown: true, hint: UPGRADE_HINT });
	}

	/** The newest threads, one page of the service's default size. */
	async listThreads(opts: CallOptions = {}): Promise<ThreadSummary[]> {
		return (await this.listThreadsPage(opts)).threads;
	}

	async listThreadsPage(q: ThreadsQuery = {}): Promise<ThreadsPage> {
		const search = query({ limit: q.limit, before: q.before, phase: q.phase?.join(","), origin: q.origin, ref: q.ref, session: q.session, repo: q.repo, since: q.since });
		return this.#call("GET", `/api/v1/threads${search}`, parseThreadsPage, q);
	}

	async thread(id: string, opts: CallOptions = {}): Promise<ThreadDetail> {
		return this.#call("GET", `/api/v1/threads/${encodeURIComponent(id)}`, parseThreadDetail, opts);
	}

	/** One page of a turn's full text (`turns.reply`). */
	async turnText(id: string, turn: number, q: TurnTextQuery = {}): Promise<TurnTextPage> {
		const search = query({ part: q.part, offset: q.offset, limit: q.limit });
		return this.#call("GET", `/api/v1/threads/${encodeURIComponent(id)}/turns/${turn}/reply${search}`, parseTurnTextPage, q);
	}

	/** One page of the event log as JSON (`events.json`). */
	async eventsPage(id: string, q: EventsQuery = {}): Promise<EventsPage> {
		const search = query({ format: "json", after: q.after, limit: q.limit, kind: q.kinds?.join(","), turn: q.turn });
		return this.#call("GET", `/api/v1/threads/${encodeURIComponent(id)}/events${search}`, parseEventsPage, q);
	}

	/** The result's change against its base (`inspect`): per-file counts with `stat: true`, else the unified diff. */
	diff(id: string, q: DiffQuery & { stat: true }): Promise<DiffStatResult>;
	diff(id: string, q?: DiffQuery & { stat?: false }): Promise<DiffTextResult>;
	async diff(id: string, q: DiffQuery & { stat?: boolean } = {}): Promise<DiffStatResult | DiffTextResult> {
		const search = query({ turn: q.turn, path: q.path, stat: q.stat ? 1 : undefined, context: q.context, maxBytes: q.maxBytes });
		const path = `/api/v1/threads/${encodeURIComponent(id)}/diff${search}`;
		if (q.stat) return this.#call("GET", path, parseDiffStat, q);
		return this.#run({ ...q, mode: "retry" }, async () => {
			const res = await this.#exchange("GET", path, q);
			const cut = res.headers.get("X-Omp-Truncated");
			const length = cut === null ? Number.NaN : Number(cut);
			return { text: await res.text(), truncated: Number.isFinite(length) ? length : null, base: res.headers.get("X-Omp-Base") ?? "", head: res.headers.get("X-Omp-Head") ?? "" };
		});
	}

	async tree(id: string, q: TreeQuery = {}): Promise<TreeResult> {
		const search = query({ ref: q.ref, path: q.path, recursive: q.recursive ? 1 : undefined });
		return this.#call("GET", `/api/v1/threads/${encodeURIComponent(id)}/tree${search}`, parseTree, q);
	}

	/** One page of a repository file at the thread's head or base. */
	async file(id: string, path: string, q: FileQuery = {}): Promise<FileResult> {
		const search = query({ ref: q.ref, offset: q.offset, limit: q.limit });
		return this.#call("GET", `/api/v1/threads/${encodeURIComponent(id)}/files/${encodePath(path)}${search}`, parseFile, q);
	}

	/**
	 * One connection to the thread's event stream: yields each event as it arrives and returns when
	 * the server closes the stream. Throws a CloudError when the connection fails or goes quiet.
	 */
	async *events(id: string, opts: EventStreamOptions = {}): AsyncGenerator<ThreadEvent> {
		const ctrl = new AbortController();
		const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;
		const headers: Record<string, string> = { Accept: "text/event-stream" };
		if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = String(opts.lastEventId);
		const search = opts.after !== undefined ? `?after=${opts.after}` : "";
		const call: Call = { mode: "stream", headers, signal, timeoutMs: 0 };
		const res = await this.#run(call, () => this.#exchange("GET", `/api/v1/threads/${encodeURIComponent(id)}/events${search}`, call));
		const failed = { repeatable: true, target: this.#base };
		try {
			if (!res.body) throw new CloudError({ code: "unavailable", message: "the event stream is empty", retriable: true, outcomeKnown: true });
			opts.onOpen?.();
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
			let buffer = "";
			/** A trailing `\r` waits for the next chunk: it may be half of a `\r\n`. */
			let heldCR = "";
			for (;;) {
				let timer: Timer | undefined;
				const quiet = new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(new CloudError({ code: "timeout", message: `event stream went quiet for ${Math.round(idleMs / 1000)}s`, retriable: true, outcomeKnown: true }));
						ctrl.abort();
					}, idleMs);
				});
				try {
					const chunk = await Promise.race([reader.read(), quiet]);
					if (chunk.done) return;
					const text = heldCR + decoder.decode(chunk.value, { stream: true });
					heldCR = text.endsWith("\r") ? "\r" : "";
					buffer += text.slice(0, text.length - heldCR.length).replace(/\r\n?/g, "\n");
				} finally {
					clearTimeout(timer);
				}
				for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
					const event = parseSseMessage(buffer.slice(0, end));
					buffer = buffer.slice(end + 2);
					if (event) yield event;
				}
			}
		} catch (e) {
			throw opts.signal?.aborted ? cloudAborted(failed) : toCloudError(e, failed);
		} finally {
			ctrl.abort();
		}
	}

	/** Queues a message for the thread (or, with `mode: "interrupt"`, stops the thread and queues it as the only turn). Never retried: a lost answer is `ambiguous_outcome`. */
	async sendMessage(id: string, text: string, opts: SendOptions = {}): Promise<SentMessage> {
		refusePairingCode(text);
		const json = opts.mode === undefined ? { text } : { text, mode: opts.mode };
		return this.#call("POST", `/api/v1/threads/${encodeURIComponent(id)}/messages`, parseSentMessage, { signal: opts.signal, json, limitOf: "message" });
	}

	/**
	 * Delivers an agent's message to the thread (omp's IRC): injected into the running turn, or woken as a new turn of origin
	 * `irc`, or revived from the archive. The service stores the message under `id`, so an attempt whose answer was lost is
	 * repeated with the same id (on the client's retry schedule for safe requests) and answered as the first one was; after the
	 * last attempt the error says the outcome is unknown. A 4xx is final. The id is made here when the caller gave none.
	 */
	async irc(id: string, message: IrcMessageBody, opts: CallOptions = {}): Promise<IrcReceipt> {
		refusePairingCode(message.body);
		const json = { from: message.from, body: message.body, id: message.id ?? randomUUID().replaceAll("-", ""), ...(message.replyTo === undefined || message.replyTo === "" ? {} : { replyTo: message.replyTo }) };
		return this.#call("POST", `/api/v1/threads/${encodeURIComponent(id)}/irc`, parseIrcReceipt, { signal: opts.signal, json, limitOf: "message", mode: "retry" });
	}

	async stop(id: string, opts: CallOptions = {}): Promise<{ stoppedRunning: boolean; cancelled: number }> {
		return this.#call(
			"POST",
			`/api/v1/threads/${encodeURIComponent(id)}/stop`,
			r => ({
				stoppedRunning: isRecord(r) && r.stoppedRunning === true,
				cancelled: isRecord(r) && typeof r.cancelled === "number" ? r.cancelled : 0,
			}),
			{ signal: opts.signal, mode: "retry" },
		);
	}

	/**
	 * Answers one question of a turn; `selected` holds option labels, `answer` free text. When an earlier attempt's response
	 * was lost and the retry is told the question is no longer waiting, the question is read back: if it holds this answer,
	 * the first attempt worked and that question is returned.
	 */
	async answer(id: string, turn: number, question: number, body: AnswerBody, opts: CallOptions = {}): Promise<Question> {
		refusePairingCode(body.answer, ...(body.selected ?? []));
		const path = `/api/v1/threads/${encodeURIComponent(id)}/turns/${turn}/questions/${question}/answer`;
		return this.#run(
			{ signal: opts.signal, mode: "retry", write: true },
			async () => parseQuestion(await (await this.#exchange("POST", path, { signal: opts.signal, json: body, limitOf: "answer" })).json()),
			async error => {
				if (error.status !== 409 || !/not waiting for an answer/i.test(error.message)) return undefined;
				const held = (await this.thread(id, opts)).turns.find(t => t.id === turn)?.questions.find(q => q.id === question);
				if (!held || held.answeredAt === "") return undefined;
				const same = (body.answer === undefined || held.answer === body.answer) && (body.selected === undefined || (held.selected.length === body.selected.length && body.selected.every(s => held.selected.includes(s))));
				return same ? { value: held } : undefined;
			},
		);
	}

	/** Deletes a thread. A retry that finds it gone after an earlier attempt's response was lost has succeeded. */
	async deleteThread(id: string, opts: CallOptions = {}): Promise<void> {
		await this.#send("DELETE", `/api/v1/threads/${encodeURIComponent(id)}`, opts, async error => (error.status === 404 ? { value: undefined } : undefined));
	}

	/**
	 * Multipart handoff. Part order is `request`, `source`, `conversation`, `setup`. With an `idempotencyKey` the create
	 * is retried on a retriable failure and a repeat answers `replayed: true`; without one it is sent once.
	 */
	async createThread(parts: HandoffParts, opts: CreateOptions = {}): Promise<CreatedThread> {
		refusePairingCode(parts.request.prompt);
		const body = (): FormData => {
			const form = new FormData();
			form.append("request", new Blob([JSON.stringify(parts.request)], { type: "application/json" }), "request.json");
			if (parts.source) form.append("source", Bun.file(parts.source), "source.bundle");
			if (parts.conversation) form.append("conversation", Bun.file(parts.conversation, { type: "application/x-tar" }), "conversation.tar");
			if (parts.setup) form.append("setup", Bun.file(parts.setup), "setup.tar.gz");
			return form;
		};
		const keyed = opts.idempotencyKey !== undefined;
		return this.#call("POST", "/api/v1/threads", parseCreatedThread, {
			signal: opts.signal,
			body,
			timeoutMs: UPLOAD_TIMEOUT_MS,
			mode: keyed ? "retry" : "once",
			headers: opts.idempotencyKey === undefined ? undefined : { "Idempotency-Key": opts.idempotencyKey },
			limitOf: "upload",
			onProgress: opts.onProgress,
		});
	}

	async #download(path: string, dest: string, opts: CallOptions): Promise<Headers> {
		const call: Call = { ...opts, timeoutMs: UPLOAD_TIMEOUT_MS };
		return this.#run(call, async () => {
			const res = await this.#exchange("GET", path, call);
			if (!res.body) throw new CloudError({ code: "unavailable", message: "the response has no body", retriable: false, outcomeKnown: true });
			await Bun.write(dest, res);
			return res.headers;
		});
	}

	/** Streams the result bundle to `dest`; a `not_found` CloudError (404) when there is no result yet. */
	async downloadResult(id: string, dest: string, opts: CallOptions = {}): Promise<ResultHeaders> {
		const h = await this.#download(`/api/v1/threads/${encodeURIComponent(id)}/result`, dest, opts);
		return { branch: h.get("X-Omp-Branch") ?? "", head: h.get("X-Omp-Head") ?? "", base: h.get("X-Omp-Base") ?? "" };
	}

	/** Streams the conversation (an `omp session pack` archive) to `dest`; a `not_found` CloudError (404) when there is none yet. */
	async downloadConversation(id: string, dest: string, opts: CallOptions = {}): Promise<void> {
		await this.#download(`/api/v1/threads/${encodeURIComponent(id)}/conversation`, dest, opts);
	}

	async startLogin(provider: string, opts: CallOptions = {}): Promise<Login> {
		return this.#call("POST", "/api/v1/logins", parseLogin, { ...opts, json: { provider } });
	}

	async login(id: string, opts: CallOptions = {}): Promise<Login> {
		return this.#call("GET", `/api/v1/logins/${encodeURIComponent(id)}`, parseLogin, opts);
	}

	/** Finishes a login whose provider redirects the browser to localhost: the redirect URL or the code. */
	async loginInput(id: string, input: string, opts: CallOptions = {}): Promise<Login> {
		return this.#call("POST", `/api/v1/logins/${encodeURIComponent(id)}/input`, parseLogin, { ...opts, json: { input } });
	}

	async cancelLogin(id: string, opts: CallOptions = {}): Promise<void> {
		await this.#send("DELETE", `/api/v1/logins/${encodeURIComponent(id)}`, opts);
	}

	/** Mints a one-time sign-in link; a `not_found` CloudError (404) when the service has no dashboard. */
	async createDashboardLink(opts: CallOptions = {}): Promise<DashboardLink> {
		return this.#call("POST", "/api/v1/dashboard/links", parseDashboardLink, opts);
	}

	/** Owner only: opens a pairing offer. The code it carries exists nowhere else; show it on the overlay and nowhere that persists. */
	async createPairingOffer(opts: CallOptions = {}): Promise<PairingOffer> {
		return this.#call("POST", "/api/v1/pairing/offers", parsePairingOffer, { ...opts, json: {} });
	}

	async pairingOffer(id: string, opts: CallOptions = {}): Promise<OfferState> {
		return this.#call("GET", `/api/v1/pairing/offers/${encodeURIComponent(id)}`, parseOfferState, opts);
	}

	/** Approves the device that redeemed the offer; a `conflict` CloudError (409) when nothing waits for approval. */
	async approvePairing(id: string, opts: CallOptions = {}): Promise<void> {
		await this.#send("POST", `/api/v1/pairing/offers/${encodeURIComponent(id)}/approve`, opts);
	}

	async declinePairing(id: string, opts: CallOptions = {}): Promise<void> {
		await this.#send("POST", `/api/v1/pairing/offers/${encodeURIComponent(id)}/decline`, opts);
	}

	/** Cancels an offer unless it is finished; idempotent. */
	async cancelPairing(id: string, opts: CallOptions = {}): Promise<void> {
		await this.#send("DELETE", `/api/v1/pairing/offers/${encodeURIComponent(id)}`, opts);
	}

	async devices(opts: CallOptions = {}): Promise<Device[]> {
		return this.#call("GET", "/api/v1/devices", parseDevices, opts);
	}

	/** Revokes a device (the owner any, a device only itself); its token stops working and its open streams end. */
	async revokeDevice(id: string, opts: CallOptions = {}): Promise<Revoked> {
		return this.#call("DELETE", `/api/v1/devices/${encodeURIComponent(id)}`, parseRevoked, opts);
	}

	/** Public call: redeems an offer's code for a request to wait on. No token is sent. */
	async redeemPairing(body: { offer: string; secret: string; name: string; platform: string }, opts: CallOptions = {}): Promise<Redeemed> {
		return this.#call("POST", "/api/v1/pairing/redeem", parseRedeemed, { ...opts, json: body, anonymous: true });
	}

	/** Public call: asks whether the owner decided. `paired` comes exactly once and carries the device token. */
	async claimPairing(body: { request: string; requestSecret: string }, opts: CallOptions = {}): Promise<Claim> {
		try {
			return await this.#run({ ...opts, mode: "once" }, async () => {
				const res = await this.#exchange("POST", "/api/v1/pairing/claim", { ...opts, json: body, anonymous: true });
				return res.status === 201 ? parseClaimed(await res.json()) : { status: "pending" as const };
			});
		} catch (e) {
			if (e instanceof CloudError && e.status === 403) return { status: "declined" };
			throw e;
		}
	}
}

/** The event of one SSE message (`id:` and `data:` lines, `:` comments), or undefined when it carries none. */
export function parseSseMessage(block: string): ThreadEvent | undefined {
	const data: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	}
	if (data.length === 0) return undefined;
	try {
		return parseEvent(JSON.parse(data.join("\n")));
	} catch {
		return undefined;
	}
}
