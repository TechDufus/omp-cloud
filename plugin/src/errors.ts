/**
 * The one error the cloud client throws. Every field the plugin or the model needs to decide what to do next is on it:
 * whether to retry, whether the request took effect, which threads an ambiguous reference could mean. `message` is plain
 * prose for a person or a model: no class names, no `☁`, no runtime boilerplate.
 */

export type CloudErrorCode =
	| "unreachable"
	| "timeout"
	| "ambiguous_outcome"
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "ambiguous_ref"
	| "conflict"
	| "too_large"
	| "rate_limited"
	| "unavailable"
	| "invalid"
	| "not_configured"
	| "version_skew"
	| "capacity"
	/** The caller's own abort signal fired. */
	| "aborted";

export interface CloudErrorInit {
	code: CloudErrorCode;
	message: string;
	/** The HTTP status of the service's answer, when there was one. */
	status?: number;
	/** Repeating the same request can succeed (the client already did so where it is safe). */
	retriable: boolean;
	/** Seconds the service asked to wait (`Retry-After`). */
	retryAfterSec?: number;
	/** False when the request may have taken effect on the service although no answer arrived. */
	outcomeKnown: boolean;
	/** The threads an ambiguous reference could mean, at most 10. */
	candidates?: { id: string; name: string }[];
	hint?: string;
	/** The thread an error is about when the service names one (a reused Idempotency-Key names the thread that key created). */
	threadId?: string;
}

export class CloudError extends Error {
	override name = "CloudError";
	readonly code: CloudErrorCode;
	readonly status: number | undefined;
	readonly retriable: boolean;
	readonly retryAfterSec: number | undefined;
	readonly outcomeKnown: boolean;
	readonly candidates: { id: string; name: string }[] | undefined;
	readonly hint: string | undefined;
	readonly threadId: string | undefined;

	constructor(init: CloudErrorInit, options?: { cause?: unknown }) {
		super(init.message, options);
		this.code = init.code;
		this.status = init.status;
		this.retriable = init.retriable;
		this.retryAfterSec = init.retryAfterSec;
		this.outcomeKnown = init.outcomeKnown;
		this.candidates = init.candidates;
		this.hint = init.hint;
		this.threadId = init.threadId;
	}
}

/** The error as one line: its message, then its hint after a dash. */
export function cloudErrorText(error: CloudError): string {
	return error.hint === undefined || error.hint === "" ? error.message : `${error.message} — ${error.hint}`;
}

const IN_PROGRESS = /Idempotency-Key is still in progress/i;
/** `Idempotency-Key <key> was used for a different request (thread <id>)`: nothing was created, and the thread is the earlier one. */
const KEY_REUSED = /^Idempotency-Key \S+ was used for a different request \(thread ([A-Za-z0-9]+)\)/;
const UNAUTHORIZED_HINT = "a revoked device must run /cloud connect again; the owner checks the configured token";

/** The error for an HTTP answer that was not a success. `message` is the service's `error` text (or the status line). */
export function cloudErrorFromStatus(status: number, message: string, retryAfterSec?: number): CloudError {
	const base = { status, message, ...(retryAfterSec === undefined ? {} : { retryAfterSec }), outcomeKnown: true };
	switch (status) {
		case 400:
			return new CloudError({ ...base, code: "invalid", retriable: false });
		case 401:
			return new CloudError({ ...base, code: "unauthorized", retriable: false, hint: UNAUTHORIZED_HINT });
		case 403:
			return new CloudError({ ...base, code: "forbidden", retriable: false });
		case 404:
			return new CloudError({ ...base, code: "not_found", retriable: false });
		case 408:
			return new CloudError({ ...base, code: "timeout", retriable: true });
		case 409: {
			const reused = KEY_REUSED.exec(message);
			if (reused) {
				return new CloudError({ ...base, code: "conflict", retriable: false, threadId: reused[1], hint: "that ref or Idempotency-Key already created a different task; use a new one, or read that thread" });
			}
			return new CloudError({ ...base, code: "conflict", retriable: IN_PROGRESS.test(message) });
		}
		case 413:
			return new CloudError({ ...base, code: "too_large", retriable: false });
		case 429:
			return new CloudError({ ...base, code: "rate_limited", retriable: true });
		case 507:
			return new CloudError({ ...base, code: "capacity", retriable: false });
		default:
			return new CloudError({ ...base, code: status >= 500 ? "unavailable" : "invalid", retriable: status >= 500 });
	}
}

/** What the mapper needs to know of the request that failed. */
export interface FailedRequest {
	/** Repeating it is safe (a read, a stop, an answer, a delete, a create with an Idempotency-Key). */
	repeatable: boolean;
	/** The service address, for the message of an unreachable service. */
	target?: string;
}

const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|HOSTNAME_MISMATCH)/;

const REASONS: Record<string, string> = {
	ECONNREFUSED: "connection refused",
	ConnectionRefused: "connection refused",
	ENOTFOUND: "host name not found",
	EAI_AGAIN: "host name lookup failed",
	EHOSTUNREACH: "host unreachable",
	ENETUNREACH: "network unreachable",
	ENETDOWN: "network down",
	EADDRNOTAVAIL: "address not available",
	EPROTO: "TLS handshake failed",
	FailedToOpenSocket: "could not open a connection",
	ConnectionTimeout: "connection timed out",
	ECONNRESET: "connection closed unexpectedly",
	EPIPE: "connection closed unexpectedly",
	ECONNABORTED: "connection closed unexpectedly",
	ConnectionClosed: "connection closed unexpectedly",
	SocketClosed: "connection closed unexpectedly",
};

/** Network errors by what they say about the request: nothing reached the service, or the connection went away after it may have carried the request. */
const DELIVERY: Record<string, "not_sent" | "lost"> = {
	ECONNREFUSED: "not_sent",
	ENOTFOUND: "not_sent",
	EAI_AGAIN: "not_sent",
	EHOSTUNREACH: "not_sent",
	ENETUNREACH: "not_sent",
	ENETDOWN: "not_sent",
	EADDRNOTAVAIL: "not_sent",
	EPROTO: "not_sent",
	ConnectionRefused: "not_sent",
	FailedToOpenSocket: "not_sent",
	ConnectionTimeout: "not_sent",
	ECONNRESET: "lost",
	EPIPE: "lost",
	ECONNABORTED: "lost",
	ConnectionClosed: "lost",
	SocketClosed: "lost",
};

function codeOf(error: Error): string {
	return "code" in error && typeof error.code === "string" ? error.code : "";
}

/** A runtime's error text without its error code prefix and its advice to the developer. */
function plainReason(message: string): string {
	return message
		.replace(/^[A-Z][A-Za-z_]*:\s+(?=[A-Z])/, "")
		.replace(/\s*For more information, pass `verbose: true` in the second argument to fetch\(\)\.?/g, "")
		.replace(/\s*Is the computer able to access the url\?/g, "")
		.replace(/Unable to connect\.?/, "connection failed")
		.trim();
}

function describeFailure(error: Error, code: string): string {
	return REASONS[code] ?? (plainReason(error.message) || "request failed");
}

/**
 * Whether a failed attempt may have reached the service and taken effect: a connection that went away or timed out after
 * the request was sent, a 5xx or 408 answer, or the "still in progress" 409 of an Idempotency-Key (the first request exists).
 */
export function mayHaveReached(error: unknown): boolean {
	if (error instanceof CloudError) return error.status !== undefined && (error.status >= 500 || error.status === 408 || (error.status === 409 && error.retriable));
	if (!(error instanceof Error)) return false;
	return error.name === "TimeoutError" || DELIVERY[codeOf(error)] === "lost";
}

/** `error` with `outcomeKnown: false`: an earlier attempt may have taken effect although this one failed. */
export function withOutcomeUnknown(error: CloudError): CloudError {
	if (!error.outcomeKnown) return error;
	return new CloudError(
		{
			code: error.code,
			message: error.message,
			retriable: error.retriable,
			outcomeKnown: false,
			...(error.status === undefined ? {} : { status: error.status }),
			...(error.retryAfterSec === undefined ? {} : { retryAfterSec: error.retryAfterSec }),
			...(error.candidates === undefined ? {} : { candidates: error.candidates }),
			...(error.hint === undefined ? {} : { hint: error.hint }),
			...(error.threadId === undefined ? {} : { threadId: error.threadId }),
		},
		{ cause: error },
	);
}

/** The error of a request its caller cancelled. */
export function cloudAborted(request: FailedRequest): CloudError {
	return new CloudError({ code: "aborted", message: "the request was cancelled", retriable: false, outcomeKnown: request.repeatable });
}

/**
 * Any failure of a request as a {@link CloudError}: a CloudError passes through; a timeout, an abort, a refused, lost or
 * untrusted connection and everything else the runtime throws are mapped to the codes of the contract.
 */
export function toCloudError(error: unknown, request: FailedRequest = { repeatable: true }): CloudError {
	if (error instanceof CloudError) return error;
	const target = request.target ?? "the cloud service";
	const cause = { cause: error };
	if (!(error instanceof Error)) {
		return new CloudError({ code: "unavailable", message: `unexpected failure talking to ${target}: ${String(error)}`, retriable: false, outcomeKnown: request.repeatable }, cause);
	}
	if (error.name === "TimeoutError") {
		return new CloudError(
			{
				code: "timeout",
				message: request.repeatable ? `${target} did not answer in time` : `${target} did not answer in time; the request may have been received`,
				retriable: request.repeatable,
				outcomeKnown: request.repeatable,
			},
			cause,
		);
	}
	if (error.name === "AbortError") {
		return new CloudError({ code: "aborted", message: "the request was cancelled", retriable: false, outcomeKnown: request.repeatable }, cause);
	}
	const code = codeOf(error);
	const delivery = DELIVERY[code];
	if (delivery === "not_sent" || TLS_CODE.test(code)) {
		return new CloudError({ code: "unreachable", message: `cannot reach ${target}: ${describeFailure(error, code)}`, retriable: true, outcomeKnown: true }, cause);
	}
	if (delivery === "lost") {
		if (request.repeatable) {
			return new CloudError({ code: "unreachable", message: `lost the connection to ${target}: ${describeFailure(error, code)}`, retriable: true, outcomeKnown: true }, cause);
		}
		return new CloudError(
			{
				code: "ambiguous_outcome",
				message: `lost the connection to ${target} before its answer arrived; the request may have been received`,
				retriable: false,
				outcomeKnown: false,
				hint: "check the thread's state before sending it again",
			},
			cause,
		);
	}
	if (code === "UnexpectedRedirect") {
		return new CloudError({ code: "unreachable", message: `${target} answered with a redirect; check the configured url`, retriable: false, outcomeKnown: true }, cause);
	}
	if (/pinned certificate/.test(error.message)) {
		return new CloudError({ code: "unreachable", message: `cannot reach ${target}: ${plainReason(error.message)}`, retriable: false, outcomeKnown: true }, cause);
	}
	return new CloudError({ code: "unavailable", message: plainReason(error.message) || "request failed", retriable: false, outcomeKnown: request.repeatable }, cause);
}
