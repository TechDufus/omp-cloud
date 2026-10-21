import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { isRecord } from "../guards";
import { SERVICE_VERSION } from "../version";
import type { FeedSpec } from "./feed-spec";
import { parseManifest, type ReleaseManifest } from "./manifest";

/** The fetch the feed uses; tests pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The API answers (release metadata, `release.json`, sidecars) are small. */
const MAX_JSON_BYTES = 2 * 1024 ** 2;
const API_TIMEOUT_MS = 30_000;
/** A download may take this long in total. */
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const MAX_REDIRECTS = 5;
const GITHUB_API = "https://api.github.com";

/**
 * Why a feed gave something other than what was asked. `none`: it has nothing to offer (no release published, a private
 * repository without a token, an asset that is not there); `failed`: it could not be read or answered nonsense.
 */
export class FeedError extends Error {
	override name = "FeedError";
	constructor(
		readonly kind: "none" | "failed",
		message: string,
	) {
		super(message);
	}
}

/** The newest release a feed offers: its manifest, when it was published, and its assets. */
export interface FeedRelease {
	manifest: ReleaseManifest;
	publishedAt: string;
	/** Whether the release lists an asset of this name. */
	has(asset: string): boolean;
	/** A small text asset (a `.sha256` sidecar), at most 2 MiB. Throws FeedError (`none` when the asset is not there). */
	text(asset: string): Promise<string>;
	/** Streams the asset to `destination`, failing when it is longer than `maxBytes`. */
	download(asset: string, destination: string, maxBytes: number): Promise<void>;
}

export interface Feed {
	/** The newest release. Throws `FeedError`. */
	latest(): Promise<FeedRelease>;
}

export interface FeedOptions {
	/** The credential to send as `Authorization: Bearer`; absent sends none. */
	token?: string;
	fetch?: FetchLike;
}

/** How to request one asset: the API URL of a GitHub asset, or the URL under a static base. */
interface Asset {
	url: string;
	accept: string;
}

interface Transport {
	text(name: string): Promise<string>;
	download(name: string, destination: string, maxBytes: number): Promise<void>;
}

/**
 * GETs `url`, following redirects by hand: the token goes to the first origin only, never to wherever a redirect points
 * (a release asset redirects to a signed storage URL, which must not see the token). Throws FeedError(failed).
 */
async function get(fetcher: FetchLike, url: string, headers: Record<string, string>, token: string | undefined, timeoutMs: number): Promise<Response> {
	const first = new URL(url);
	let current = first;
	const signal = AbortSignal.timeout(timeoutMs);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const sent: Record<string, string> = { ...headers, "User-Agent": `omp-cloud/${SERVICE_VERSION}` };
		if (token !== undefined && current.origin === first.origin) sent.Authorization = `Bearer ${token}`;
		let response: Response;
		try {
			response = await fetcher(current.toString(), { method: "GET", headers: sent, redirect: "manual", signal });
		} catch (error) {
			throw new FeedError("failed", `the feed at ${first.origin} cannot be reached: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (location === null) throw new FeedError("failed", `the feed answered ${response.status} without a location`);
			current = new URL(location, current);
			if (current.protocol !== "https:" && current.protocol !== "http:") throw new FeedError("failed", "the feed redirected to a URL that is not http(s)");
			continue;
		}
		return response;
	}
	throw new FeedError("failed", `the feed redirected more than ${MAX_REDIRECTS} times`);
}

/** The body of `response` as text, at most `max` bytes. */
async function boundedText(response: Response, max: number): Promise<string> {
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
			throw new FeedError("failed", `the feed answered more than ${max} bytes where a small document is expected`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Reads `response`'s body into `destination`, at most `maxBytes`; removes the partial file on failure. */
async function saveBody(response: Response, destination: string, maxBytes: number): Promise<void> {
	const reader = response.body?.getReader();
	if (reader === undefined) throw new FeedError("failed", "the feed sent no body");
	const sink = createWriteStream(destination, { mode: 0o755 });
	const failed = new Promise<never>((_, reject) => sink.once("error", reject));
	failed.catch(() => undefined);
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new FeedError("failed", `the download is longer than the ${maxBytes} bytes the release declares`);
			if (!sink.write(value)) await Promise.race([new Promise<void>((resolve) => sink.once("drain", resolve)), failed]);
		}
		await Promise.race([new Promise<void>((resolve) => sink.end(resolve)), failed]);
	} catch (error) {
		sink.destroy();
		await reader.cancel().catch(() => undefined);
		await rm(destination, { force: true });
		throw error instanceof FeedError ? error : new FeedError("failed", `writing the download failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** A transport over the named assets. A 404 for an asset is `none`, any other refusal `failed`. */
function transport(assets: ReadonlyMap<string, Asset>, fetcher: FetchLike, token: string | undefined): Transport {
	const request = async (name: string, timeoutMs: number): Promise<Response> => {
		const asset = assets.get(name);
		if (asset === undefined) throw new FeedError("none", `the release has no asset ${name}`);
		const response = await get(fetcher, asset.url, { Accept: asset.accept }, token, timeoutMs);
		if (!response.ok) {
			await response.body?.cancel();
			throw new FeedError(response.status === 404 ? "none" : "failed", `the feed answered ${response.status} for ${name}`);
		}
		return response;
	};
	return {
		text: async (name) => boundedText(await request(name, API_TIMEOUT_MS), MAX_JSON_BYTES),
		download: async (name, destination, maxBytes) => saveBody(await request(name, DOWNLOAD_TIMEOUT_MS), destination, maxBytes),
	};
}

/** Reads and checks `release.json` through `via`. */
async function readManifest(via: Transport, label: string): Promise<ReleaseManifest> {
	const raw = await via.text("release.json");
	try {
		return parseManifest(JSON.parse(raw));
	} catch (error) {
		throw new FeedError("failed", `${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function feedRelease(manifest: ReleaseManifest, publishedAt: string, assets: ReadonlyMap<string, Asset>, via: Transport): FeedRelease {
	return { manifest, publishedAt, has: (asset) => assets.has(asset), text: via.text, download: via.download };
}

/**
 * The newest release of the repository, through `GET /releases/latest`: GitHub's "latest" skips prereleases and drafts, so a
 * tag with a `-` (released with `--prerelease`) is never offered as an update. Each asset is then fetched by id through
 * `/releases/assets/<id>`, which redirects to a signed storage URL ({@link get} keeps the token off that second origin).
 */
async function githubLatest(spec: Extract<FeedSpec, { kind: "github" }>, options: FeedOptions): Promise<FeedRelease> {
	const fetcher = options.fetch ?? fetch;
	const { owner, repo } = spec;
	const api = `${GITHUB_API}/repos/${owner}/${repo}`;
	const response = await get(
		fetcher,
		`${api}/releases/latest`,
		{ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
		options.token,
		API_TIMEOUT_MS,
	);
	if (response.status === 404) {
		await response.body?.cancel();
		throw new FeedError(
			"none",
			options.token === undefined
				? `no release of ${owner}/${repo} is visible (none is published, or it is a private repository or fork and update.token is not set)`
				: `no release of ${owner}/${repo} is visible to update.token`,
		);
	}
	if (response.status === 401 || response.status === 403) {
		await response.body?.cancel();
		throw new FeedError("failed", `GitHub refused the request (${response.status}): check update.token`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new FeedError("failed", `GitHub answered ${response.status}`);
	}
	let body: unknown;
	try {
		body = JSON.parse(await boundedText(response, MAX_JSON_BYTES));
	} catch (error) {
		if (error instanceof FeedError) throw error;
		throw new FeedError("failed", "GitHub's release answer is not JSON");
	}
	if (!isRecord(body) || typeof body.tag_name !== "string" || !Array.isArray(body.assets)) {
		throw new FeedError("failed", "GitHub's release answer has an unexpected shape");
	}
	const assets = new Map<string, Asset>();
	for (const entry of body.assets) {
		if (isRecord(entry) && typeof entry.name === "string" && typeof entry.id === "number" && Number.isSafeInteger(entry.id)) {
			assets.set(entry.name, { url: `${api}/releases/assets/${entry.id}`, accept: "application/octet-stream" });
		}
	}
	if (!assets.has("release.json")) throw new FeedError("failed", `release ${body.tag_name} has no release.json`);
	const via = transport(assets, fetcher, options.token);
	const manifest = await readManifest(via, `release ${body.tag_name}`);
	if (body.tag_name.replace(/^v/, "") !== manifest.version) {
		throw new FeedError("failed", `release tag ${body.tag_name} does not match the version ${manifest.version} in its release.json`);
	}
	const publishedAt = typeof body.published_at === "string" ? body.published_at : manifest.build.createdAt;
	return feedRelease(manifest, publishedAt, assets, via);
}

async function staticLatest(spec: Extract<FeedSpec, { kind: "static" }>, options: FeedOptions): Promise<FeedRelease> {
	const fetcher = options.fetch ?? fetch;
	const at = (name: string): Asset => ({ url: `${spec.base}${name}`, accept: "*/*" });
	const assets = new Map<string, Asset>([["release.json", at("release.json")]]);
	let manifest: ReleaseManifest;
	try {
		manifest = await readManifest(transport(assets, fetcher, options.token), spec.base);
	} catch (error) {
		if (error instanceof FeedError && error.kind === "none") throw new FeedError("none", `no release.json at ${spec.base}`);
		throw error;
	}
	// A static feed serves every file the manifest lists, with its sidecar, and the notes, by name.
	for (const file of manifest.files) {
		assets.set(file.name, at(file.name));
		assets.set(`${file.name}.sha256`, at(`${file.name}.sha256`));
	}
	assets.set("notes.md", at("notes.md"));
	return feedRelease(manifest, manifest.build.createdAt, assets, transport(assets, fetcher, options.token));
}

/** The feed of `spec`; `options.token` is sent as a Bearer credential to the feed's own origin only. */
export function createFeed(spec: FeedSpec, options: FeedOptions = {}): Feed {
	return { latest: () => (spec.kind === "github" ? githubLatest(spec, options) : staticLatest(spec, options)) };
}
