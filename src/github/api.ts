import { isRecord } from "../guards";
import type { FetchLike } from "../update/feed";
import { SERVICE_VERSION } from "../version";

const API_URL = "https://api.github.com";
const TIMEOUT_MS = 30_000;
/** GitHub's answers (installation listings, tokens, pull requests) are small. */
const MAX_BODY_BYTES = 2 * 1024 ** 2;

/**
 * A GitHub request that failed: `status` is the HTTP status, or 0 when GitHub did not answer (network failure,
 * timeout, an answer longer than the cap).
 */
export class GitHubError extends Error {
	override name = "GitHubError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export type GitHubAuth = { kind: "none" } | { kind: "bearer"; value: string };

/** The body of `response` as text, at most `max` bytes; null when it is longer. */
async function boundedText(response: Response, max: number): Promise<string | null> {
	const reader = response.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The JSON a text holds, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** A minimal client of the GitHub REST API: JSON in, JSON out, one error type. */
export class GitHubApi {
	readonly #fetch: FetchLike;

	/** The parameter is not named `fetch`: that would hit the temporal dead zone of its own default. */
	constructor(fetcher: FetchLike = fetch) {
		this.#fetch = fetcher;
	}

	/**
	 * Calls `<method> <path>` (a path starting with `/`). A 2xx answer returns its parsed JSON (null for an empty
	 * body); any other throws `GitHubError(status, "<METHOD> <path>: <message>")`.
	 */
	async request<T>(method: string, path: string, auth: GitHubAuth, body?: unknown): Promise<{ status: number; json: T }> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": `omp-cloud/${SERVICE_VERSION}`,
		};
		if (auth.kind === "bearer") headers.Authorization = `Bearer ${auth.value}`;
		const init: RequestInit = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		const label = `${method} ${path}`;
		let response: Response;
		let text: string | null;
		try {
			response = await this.#fetch(`${API_URL}${path}`, init);
			text = await boundedText(response, MAX_BODY_BYTES);
		} catch (error) {
			throw new GitHubError(0, `${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (text === null) throw new GitHubError(0, `${label}: the answer is longer than ${MAX_BODY_BYTES} bytes`);
		const json = text === "" ? null : parseJson(text);
		if (response.status < 200 || response.status >= 300) {
			const message = isRecord(json) && typeof json.message === "string" ? json.message : text.slice(0, 200) || response.statusText || "no message";
			throw new GitHubError(response.status, `${label}: ${message}`);
		}
		return { status: response.status, json: (json === undefined ? null : json) as T };
	}
}
