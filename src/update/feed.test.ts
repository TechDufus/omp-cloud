import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeed, type FetchLike, FeedError } from "./feed";
import { parseFeedSpec } from "./feed-spec";
import { makeManifest, releaseBytes } from "./test-support";

interface Seen {
	url: string;
	headers: Record<string, string>;
	redirect: RequestInit["redirect"];
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-feed-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const MANIFEST = makeManifest("0.5.1");
const BYTES = releaseBytes("0.5.1");

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function headersOf(init: RequestInit): Record<string, string> {
	const out: Record<string, string> = {};
	new Headers(init.headers).forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

/** GitHub as far as the feed uses it: the latest release with three assets, and `/releases/assets/<id>` answering a redirect to a storage host. */
function github(options: { tag?: string; manifest?: unknown; releaseStatus?: number; seen: Seen[]; storageBytes?: Uint8Array } = { seen: [] }): FetchLike {
	const storage = options.storageBytes ?? BYTES;
	return async (url, init) => {
		options.seen.push({ url, headers: headersOf(init), redirect: init.redirect });
		if (url === "https://api.github.com/repos/TechDufus/omp-cloud/releases/latest") {
			if (options.releaseStatus !== undefined) return json({ message: "x" }, options.releaseStatus);
			return json({
				tag_name: options.tag ?? "v0.5.1",
				published_at: "2026-10-21T02:00:00Z",
				assets: [
					{ id: 11, name: "release.json" },
					{ id: 12, name: "omp-cloud-linux-x86_64" },
					{ id: 13, name: "omp-cloud-linux-x86_64.sha256" },
				],
			});
		}
		if (url === "https://api.github.com/repos/TechDufus/omp-cloud/releases/assets/11") return json(options.manifest ?? MANIFEST);
		if (url === "https://api.github.com/repos/TechDufus/omp-cloud/releases/assets/12") {
			return new Response(null, { status: 302, headers: { Location: "https://objects.example-storage.test/signed/abc?X-Sig=1" } });
		}
		if (url === "https://api.github.com/repos/TechDufus/omp-cloud/releases/assets/13") return new Response("deadbeef  omp-cloud-linux-x86_64\n");
		if (url === "https://objects.example-storage.test/signed/abc?X-Sig=1") return new Response(storage);
		return new Response("not found", { status: 404 });
	};
}

const spec = parseFeedSpec("github:TechDufus/omp-cloud");

describe("the github feed", () => {
	test("reads the latest release and its release.json; an anonymous feed sends no Authorization", async () => {
		const seen: Seen[] = [];
		const release = await createFeed(spec, { fetch: github({ seen }) }).latest();

		expect(release.manifest).toEqual(MANIFEST);
		expect(release.publishedAt).toBe("2026-10-21T02:00:00Z");
		expect(release.has("omp-cloud-linux-x86_64")).toBe(true);
		expect(release.has("omp-cloud-linux-arm64")).toBe(false);
		expect(seen.map((s) => s.url)).toEqual([
			"https://api.github.com/repos/TechDufus/omp-cloud/releases/latest",
			"https://api.github.com/repos/TechDufus/omp-cloud/releases/assets/11",
		]);
		expect(seen[0]?.headers.accept).toBe("application/vnd.github+json");
		expect(seen[1]?.headers.accept).toBe("application/octet-stream");
		expect(seen.every((s) => s.headers.authorization === undefined)).toBe(true);
		expect(seen.every((s) => s.redirect === "manual")).toBe(true);
		expect(seen.every((s) => /^omp-cloud\//.test(s.headers["user-agent"] ?? ""))).toBe(true);
	});

	test("with a token every request to GitHub carries Authorization: Bearer; the redirect target never sees it", async () => {
		const seen: Seen[] = [];
		const release = await createFeed(spec, { token: "tok-123", fetch: github({ seen }) }).latest();
		const destination = join(dir, "download");
		await release.download("omp-cloud-linux-x86_64", destination, BYTES.length);

		const toGithub = seen.filter((s) => s.url.startsWith("https://api.github.com/"));
		expect(toGithub.length).toBe(3);
		expect(toGithub.every((s) => s.headers.authorization === "Bearer tok-123")).toBe(true);
		const toStorage = seen.filter((s) => s.url.startsWith("https://objects.example-storage.test/"));
		expect(toStorage.length).toBe(1);
		expect(toStorage[0]?.headers.authorization).toBeUndefined();
		expect((await readFile(destination)).equals(Buffer.from(BYTES))).toBe(true);
	});

	test("a download follows the redirect, and a body longer than the declared size is refused and leaves no file", async () => {
		const release = await createFeed(spec, { fetch: github({ seen: [], storageBytes: new Uint8Array(BYTES.length + 50) }) }).latest();
		const destination = join(dir, "long");
		const failure = await release.download("omp-cloud-linux-x86_64", destination, BYTES.length).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(FeedError);
		expect(String((failure as Error).message)).toContain(`longer than the ${BYTES.length} bytes the release declares`);
		expect(await readdir(dir)).toEqual([]);
	});

	test("a sidecar is read as small text; an asset the release lacks is a `none` error", async () => {
		const release = await createFeed(spec, { fetch: github({ seen: [] }) }).latest();
		expect(await release.text("omp-cloud-linux-x86_64.sha256")).toBe("deadbeef  omp-cloud-linux-x86_64\n");
		const missing = await release.text("notes.md").catch((error: unknown) => error);
		expect(missing).toMatchObject({ kind: "none" });
	});

	test("404 without a token says no release is visible (private repository), kind none; with a token it names the token", async () => {
		const anonymous = await createFeed(spec, { fetch: github({ seen: [], releaseStatus: 404 }) }).latest().catch((error: unknown) => error);
		expect(anonymous).toMatchObject({ kind: "none" });
		expect(String((anonymous as Error).message)).toContain("update.token is not set");
		const withToken = await createFeed(spec, { token: "t", fetch: github({ seen: [], releaseStatus: 404 }) }).latest().catch((error: unknown) => error);
		expect(withToken).toMatchObject({ kind: "none" });
		expect(String((withToken as Error).message)).toContain("visible to update.token");
	});

	test("401, 403 and 500 are failures; an unreachable API is a failure naming the origin", async () => {
		for (const status of [401, 403]) {
			const refused = await createFeed(spec, { fetch: github({ seen: [], releaseStatus: status }) }).latest().catch((error: unknown) => error);
			expect(refused).toMatchObject({ kind: "failed" });
			expect(String((refused as Error).message)).toContain("check update.token");
		}
		const broken = await createFeed(spec, { fetch: github({ seen: [], releaseStatus: 500 }) }).latest().catch((error: unknown) => error);
		expect(String((broken as Error).message)).toBe("GitHub answered 500");
		const down = await createFeed(spec, {
			fetch: async () => {
				throw new Error("connect ECONNREFUSED");
			},
		})
			.latest()
			.catch((error: unknown) => error);
		expect(down).toMatchObject({ kind: "failed" });
		expect(String((down as Error).message)).toContain("https://api.github.com");
	});

	test("a tag that disagrees with release.json, or a release.json that is malformed, is refused", async () => {
		const mismatch = await createFeed(spec, { fetch: github({ seen: [], tag: "v0.6.0" }) }).latest().catch((error: unknown) => error);
		expect(String((mismatch as Error).message)).toBe("release tag v0.6.0 does not match the version 0.5.1 in its release.json");
		const malformed = await createFeed(spec, { fetch: github({ seen: [], manifest: { product: "omp-cloud" } }) }).latest().catch((error: unknown) => error);
		expect(malformed).toMatchObject({ kind: "failed" });
		expect(String((malformed as Error).message)).toContain("release v0.5.1: release.json:");
	});
});

describe("a static feed", () => {
	function staticServer(seen: Seen[]): FetchLike {
		return async (url, init) => {
			seen.push({ url, headers: headersOf(init), redirect: init.redirect });
			if (url === "https://feed.example.test/omp/release.json") return json(MANIFEST);
			if (url === "https://feed.example.test/omp/omp-cloud-linux-x86_64") return new Response(BYTES);
			if (url === "https://feed.example.test/omp/omp-cloud-linux-x86_64.sha256") return new Response("x");
			return new Response("no", { status: 404 });
		};
	}

	test("serves <base>release.json and <base><asset>; publishedAt is the build time; no token, no Authorization", async () => {
		const seen: Seen[] = [];
		const release = await createFeed(parseFeedSpec("https://feed.example.test/omp"), { fetch: staticServer(seen) }).latest();
		expect(release.manifest).toEqual(MANIFEST);
		expect(release.publishedAt).toBe(MANIFEST.build.createdAt);
		const destination = join(dir, "bin");
		await release.download("omp-cloud-linux-x86_64", destination, BYTES.length);
		expect((await readFile(destination)).equals(Buffer.from(BYTES))).toBe(true);
		expect(await release.text("omp-cloud-linux-x86_64.sha256")).toBe("x");
		expect(seen.map((s) => s.url)).toEqual([
			"https://feed.example.test/omp/release.json",
			"https://feed.example.test/omp/omp-cloud-linux-x86_64",
			"https://feed.example.test/omp/omp-cloud-linux-x86_64.sha256",
		]);
		expect(seen.every((s) => s.headers.authorization === undefined)).toBe(true);
	});

	test("a configured token is sent to the feed's own origin", async () => {
		const seen: Seen[] = [];
		await createFeed(parseFeedSpec("https://feed.example.test/omp/"), { token: "secret", fetch: staticServer(seen) }).latest();
		expect(seen[0]?.headers.authorization).toBe("Bearer secret");
	});

	test("a missing release.json is `none`; a sidecar the server lacks is `none` too", async () => {
		const empty = await createFeed(parseFeedSpec("https://nothing.example.test/"), { fetch: async () => new Response("no", { status: 404 }) }).latest().catch((error: unknown) => error);
		expect(empty).toMatchObject({ kind: "none" });
		expect(String((empty as Error).message)).toBe("no release.json at https://nothing.example.test/");
		const release = await createFeed(parseFeedSpec("https://feed.example.test/omp/"), { fetch: staticServer([]) }).latest();
		expect(await release.text("omp-cloud-linux-arm64.sha256").catch((error: unknown) => error)).toMatchObject({ kind: "none" });
	});

	test("redirects are followed up to five hops, then refused", async () => {
		let hops = 0;
		const loop: FetchLike = async (url) => {
			hops++;
			return new Response(null, { status: 302, headers: { Location: `${url}x` } });
		};
		const failure = await createFeed(parseFeedSpec("https://feed.example.test/"), { fetch: loop }).latest().catch((error: unknown) => error);
		expect(String((failure as Error).message)).toBe("the feed redirected more than 5 times");
		expect(hops).toBe(6);
	});
});
