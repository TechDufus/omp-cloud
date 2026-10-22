import { statfs } from "node:fs/promises";
import { GitError, type GitService } from "../git";
import { remoteHostOf } from "../git/remote";
import { isRecord } from "../guards";
import type { Settings } from "../settings";
import { modelAllowed } from "../settings/registry";
import { effectivePolicy, egressWidens } from "../settings/tighten";
import type { Store } from "../store";
import { type BlobName, StoreError, type Thread } from "../store/types";
import { modelProvider, parseCreateRequest } from "./create-request";
import { ApiError } from "./errors";
import {
	MAX_CREATE_BODY_BYTES,
	MAX_REQUEST_PART_BYTES,
	MAX_SESSION_BYTES,
	MAX_SETUP_BYTES,
	MAX_SOURCE_BYTES,
} from "./limits";
import { MultipartError, MultipartReader, multipartBoundary } from "./multipart";

/** The `secrets.json` blob: base64 file contents and variables, validated to 1 MiB before encoding. */
const MAX_SECRETS_BLOB_BYTES = 4 * 1024 ** 2;
const REQUEST_PART = "request";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Upload limits in bytes; `UploadOptions.limits` overrides them in tests. */
export interface UploadLimits {
	body: number;
	request: number;
	source: number;
	conversation: number;
	setup: number;
}

/** The models the service routes. */
export interface ModelOptions {
	default: string;
	/** Providers routed directly: `Config.models.direct`. */
	direct: string[];
	/** The providers the gateway serves, which `refresh` re-reads. */
	gateway: { providers(): string[]; refresh(): Promise<void> };
}

export interface UploadOptions {
	/** The data directory: free space is checked on its volume. */
	dataDir: string;
	models: ModelOptions;
	/** The service host's omp version: what a request without `ompVersion` runs. */
	ompVersion: string;
	/** Test seam: replaces the limits of `./limits`. */
	limits?: Partial<UploadLimits>;
	/** Test seam: free bytes available to unprivileged writers on the volume of `dir`; defaults to `statfs`. */
	freeBytes?: (dir: string) => Promise<number>;
	/** The service's git: the base fetch of delta handoffs, and the empty base of scratch threads. */
	git: Pick<GitService, "normalize" | "canFetch" | "prepare" | "forget" | "scratchSource">;
	/** The run-time settings: the policy settings are read at each request. */
	settings: Pick<Settings, "get">;
	/** Who sent the first turn (`owner` or `device:<id>`); absent means `owner`. */
	sentBy?: string;
	/** Runs right before the thread is written; throws to refuse (a revoked device's upload), which removes what was stored. */
	beforeCreate?: () => void;
	/** The create request's `Idempotency-Key`, stored on the thread with the fingerprint of the prompt and `policy.readOnly` (`createThreadIdempotent` sets it). */
	idempotencyKey?: string;
	/** The service's own addresses (the gateway's and the MCP proxy's): an http MCP server may not point at them. */
	mcpSelfHosts?: readonly string[];
}

/** `provider/*` for every provider the cloud can run right now: the gateway's, then the direct ones. */
export function modelPatterns(models: ModelOptions): string[] {
	return [...new Set([...models.gateway.providers(), ...models.direct])].map(provider => `${provider}/*`);
}

/** Throws 409 when `model` is outside any of the non-empty `models.allowed` lists of the effective policy; `model` is the requested one, else the default. */
function requireAllowed(model: string, lists: readonly (readonly string[])[]): void {
	if (!lists.every(allowed => modelAllowed(allowed, model))) throw new ApiError(409, `the cloud policy does not allow ${model}`);
}

/** Throws 409 when `model`'s provider is neither served by the gateway (after one refresh) nor direct; an empty model runs the default. */
async function requireRunnable(model: string, models: ModelOptions): Promise<void> {
	if (model === "") return;
	const provider = modelProvider(model);
	if (models.direct.includes(provider) || models.gateway.providers().includes(provider)) return;
	await models.gateway.refresh();
	if (models.gateway.providers().includes(provider)) return;
	throw new ApiError(409, `the cloud cannot run ${provider} models; log the cloud broker in with /cloud login ${provider}`);
}

async function statfsFreeBytes(dir: string): Promise<number> {
	const stats = await statfs(dir, { bigint: false });
	return stats.bavail * stats.bsize;
}

/** The request's Content-Length, or null when it carries none (or an unparseable one). */
function contentLength(req: Request): number | null {
	const header = req.headers.get("content-length");
	if (header === null || !/^\d+$/.test(header)) return null;
	const length = Number(header);
	return Number.isSafeInteger(length) ? length : null;
}

/** What a failure while reading or storing `part` means to the client; errors it does not know pass through. */
function uploadError(part: string, error: unknown, req: Request): unknown {
	// The client is gone: nobody reads a response, so keep the original error.
	if (error instanceof ApiError || req.signal.aborted) return error;
	if (error instanceof StoreError && error.code === "too_large") {
		return new ApiError(413, `part "${part}" is too large`);
	}
	if (error instanceof MultipartError) return new ApiError(400, "the upload ended early or is malformed");
	return error;
}

/** Reads a part whole, at most `limit` bytes, and parses it as JSON. */
async function readJsonPart(body: AsyncIterable<Uint8Array>, limit: number): Promise<unknown> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		size += chunk.byteLength;
		if (size > limit) throw new ApiError(413, "the request part is too large");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		throw new ApiError(400, "the request part is not valid JSON");
	}
}

function uploadLimits(options: UploadOptions): UploadLimits {
	return {
		body: MAX_CREATE_BODY_BYTES,
		request: MAX_REQUEST_PART_BYTES,
		source: MAX_SOURCE_BYTES,
		conversation: MAX_SESSION_BYTES,
		setup: MAX_SETUP_BYTES,
		...options.limits,
	};
}

/** The multipart reader of the upload, advanced past its first part, which must be `request`; and that part's parsed JSON. */
async function readRequestPart(req: Request, limits: UploadLimits): Promise<{ reader: MultipartReader; raw: unknown }> {
	const boundary = multipartBoundary(req.headers.get("content-type"));
	if (req.body === null || boundary === null) throw new ApiError(400, "expected a multipart/form-data body");
	const reader = new MultipartReader(req.body, boundary);
	try {
		const first = await reader.next();
		if (first === null || first.name !== REQUEST_PART) throw new ApiError(400, 'the first part must be "request"');
		return { reader, raw: await readJsonPart(first.body, limits.request) };
	} catch (error) {
		throw uploadError(REQUEST_PART, error, req);
	}
}

/**
 * The SHA-256 (hex) of a request's prompt exactly as the request carried it, with a `\0readOnly` suffix when it asked for
 * `policy.readOnly`: what an `Idempotency-Key` is bound to. A request without `readOnly` hashes the prompt alone, so keys
 * stored before the flag existed still replay.
 */
function requestFingerprint(prompt: string, readOnly: boolean): string {
	return new Bun.CryptoHasher("sha256").update(readOnly ? `${prompt}\0readOnly` : prompt).digest("hex");
}

/**
 * POST /api/v1/threads: reads the multipart upload, stores its parts, creates the thread. Throws ApiError for every
 * non-201 outcome in docs/api.md. A failed upload leaves no blob directory and no thread behind.
 */
export async function createThreadFromUpload(
	store: Store,
	req: Request,
	owner: string,
	options: UploadOptions,
): Promise<Thread> {
	const limits = uploadLimits(options);
	const length = contentLength(req);
	if (length !== null && length > limits.body) throw new ApiError(413, "upload is too large");
	const free = await (options.freeBytes ?? statfsFreeBytes)(options.dataDir);
	if (free < 2 * (length ?? limits.body)) {
		throw new ApiError(507, "insufficient storage on the service data volume");
	}

	const { reader, raw } = await readRequestPart(req, limits);
	let request;
	try {
		request = parseCreateRequest(raw, options.mcpSelfHosts);
	} catch (error) {
		throw uploadError(REQUEST_PART, error, req);
	}
	// Before anything is stored: a policy that widens the service's, a model the effective policy or the cloud itself cannot run fails the request, a model is never swapped for another.
	if (egressWidens(options.settings.get("policy.egress"), request.thread.policy.egress ?? [])) {
		throw new ApiError(400, "policy.egress of a thread may only narrow the service's list");
	}
	requireAllowed(request.thread.model || options.models.default, effectivePolicy(options.settings, request.thread.policy).modelsAllowed);
	await requireRunnable(request.thread.model, options.models);
	const { repo } = request.thread;
	const delta = repo.baseCommit !== "";
	if (delta && !options.git.canFetch(repo.remoteURL)) {
		throw new ApiError(400, `the service has no git credentials for ${remoteHostOf(repo.remoteURL) || repo.remoteURL}; hand off the whole repository instead`);
	}

	const id = store.newThreadId();
	try {
		const seen = await storeParts(store, id, reader, limits, req, request.thread.scratch === true);
		if (repo.baseCommit === "" && request.thread.scratch !== true && !seen.has("source")) {
			throw new ApiError(400, "a full-history handoff needs the source part");
		}
		if (repo.baseCommit !== "" && repo.handoffCommit !== repo.baseCommit && !seen.has("source")) {
			throw new ApiError(400, "the source part is required when the handoff has commits beyond the base");
		}
		if (delta) {
			try {
				await options.git.prepare(id, repo, seen.has("source") ? store.blobPath(id, "source.bundle") : null);
			} catch (error) {
				if (error instanceof GitError) throw new ApiError(error.code === "base" ? 409 : 400, error.message);
				throw error;
			}
		}
		let handoffCommit = repo.handoffCommit;
		if (request.thread.scratch === true) {
			// The base is synthesized here: an empty repository with one empty commit, stored as the full-history source.
			const base = await options.git.scratchSource();
			try {
				await store.putBlob(id, "source.bundle", new Uint8Array(await Bun.file(base.path).arrayBuffer()), limits.source);
			} finally {
				await base.release();
			}
			handoffCommit = base.commit;
		}
		if (request.secrets !== null) {
			const json = new TextEncoder().encode(JSON.stringify(request.secrets));
			await store.putBlob(id, "secrets.json", json, MAX_SECRETS_BLOB_BYTES);
		}
		const ompVersion = request.thread.ompVersion || options.ompVersion;
		// A delta thread keeps the normalized https remote: the one its base was fetched from, and the VM's `origin`.
		const stored = delta ? { ...request.thread, repo: { ...repo, remoteURL: options.git.normalize(repo.remoteURL) } } : { ...request.thread, repo: { ...repo, handoffCommit } };
		options.beforeCreate?.();
		const idempotency =
			options.idempotencyKey === undefined
				? undefined
				: { key: options.idempotencyKey, fingerprint: requestFingerprint(request.thread.prompt, request.thread.policy.readOnly === true) };
		return store.createThread(id, { ...stored, owner, ompVersion, sentBy: options.sentBy, idempotency }).thread;
	} catch (error) {
		await store.removeBlobs(id);
		if (delta) {
			await options.git.forget(id).catch((forgetError: unknown) => {
				console.error(`omp-cloud: dropping the git refs of the refused thread ${id} failed: ${forgetError instanceof Error ? forgetError.message : String(forgetError)}`);
			});
		}
		throw error;
	}
}

/** What a request with an `Idempotency-Key` answers while the first one with that key is still being created. */
const IN_PROGRESS = "a request with this Idempotency-Key is still in progress";

/**
 * POST /api/v1/threads: `createThreadFromUpload`, made idempotent by the `Idempotency-Key` header. The first request with
 * a key creates the thread (`replayed` false) and binds the key to the request's prompt and `policy.readOnly`. A later one
 * by the same owner, while that thread is not deleted, answers the existing thread (`replayed` true) when its prompt and
 * `policy.readOnly` are the same, reading only the `request` part of the upload; with another prompt or read-only setting
 * it is 409 and creates nothing. One that arrives while the first is still being created is 409 too; a malformed key is
 * 400. Without the header it is a plain create.
 */
export async function createThreadIdempotent(
	store: Store,
	req: Request,
	owner: string,
	options: UploadOptions,
): Promise<{ thread: Thread; replayed: boolean }> {
	const key = req.headers.get("idempotency-key");
	if (key === null) return { thread: await createThreadFromUpload(store, req, owner, options), replayed: false };
	if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
		throw new ApiError(400, "Idempotency-Key must be 1 to 128 characters of letters, digits, . _ : or -");
	}
	const release = store.beginCreate(owner, key);
	if (release === null) throw new ApiError(409, IN_PROGRESS);
	try {
		const existing = store.threadByIdempotencyKey(owner, key);
		if (existing === null) {
			return { thread: await createThreadFromUpload(store, req, owner, { ...options, idempotencyKey: key }), replayed: false };
		}
		const { raw } = await readRequestPart(req, uploadLimits(options));
		const prompt = isRecord(raw) ? raw.prompt : undefined;
		if (typeof prompt !== "string") throw new ApiError(400, "prompt must be a string");
		if (requestFingerprint(prompt, isRecord(raw) && isRecord(raw.policy) && raw.policy.readOnly === true) !== existing.fingerprint) {
			throw new ApiError(409, `Idempotency-Key ${key} was used for a different request (thread ${existing.thread.id})`);
		}
		return { thread: existing.thread, replayed: true };
	} finally {
		release();
	}
}

/** Streams the parts after `request` into the thread's blobs; returns the names of the parts it stored. */
async function storeParts(
	store: Store,
	id: string,
	reader: MultipartReader,
	limits: UploadLimits,
	req: Request,
	scratch: boolean,
): Promise<Set<string>> {
	const seen = new Set<string>([REQUEST_PART]);
	for (;;) {
		let name = "upload";
		try {
			const part = await reader.next();
			if (part === null) return seen;
			name = part.name;
			if (seen.has(name)) throw new ApiError(400, `part "${name}" is repeated`);
			seen.add(name);
			let blob: BlobName;
			let limit: number;
			switch (name) {
				case "source":
					if (scratch) throw new ApiError(400, "a scratch thread takes no source part");
					[blob, limit] = ["source.bundle", limits.source];
					break;
				case "conversation":
					[blob, limit] = ["session.tar", limits.conversation];
					break;
				case "setup":
					[blob, limit] = ["setup.tar.gz", limits.setup];
					break;
				default:
					throw new ApiError(400, `unknown part "${name}"`);
			}
			const size = await store.putBlob(id, blob, part.body, limit);
			if (name === "conversation" && size === 0) throw new ApiError(400, "the conversation part is empty");
		} catch (error) {
			throw uploadError(name, error, req);
		}
	}
}
