/** The default of `update.feed`: the GitHub Releases of the omp-cloud repository. */
export const DEFAULT_FEED = "github:TechDufus/omp-cloud";

/** Where releases come from: a GitHub repository's latest release, or a static base URL that serves `release.json` and the assets. */
export type FeedSpec = { kind: "github"; owner: string; repo: string } | { kind: "static"; base: string };

const GITHUB_SPEC = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/**
 * Parses an `update.feed` value: `github:<owner>/<repo>`, or an `http(s)://…` base URL (a trailing `/` is added when
 * missing; no credentials, query or fragment). Throws an Error naming what is wrong.
 */
export function parseFeedSpec(value: string): FeedSpec {
	const github = GITHUB_SPEC.exec(value);
	if (github?.[1] !== undefined && github[2] !== undefined) return { kind: "github", owner: github[1], repo: github[2] };
	if (value.startsWith("http://") || value.startsWith("https://")) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error(`update.feed is not a valid URL: ${JSON.stringify(value.slice(0, 100))}`);
		}
		if (url.username !== "" || url.password !== "") throw new Error("update.feed must not carry credentials; put them in update.token");
		if (url.search !== "" || url.hash !== "") throw new Error("update.feed must not have a query or fragment");
		return { kind: "static", base: url.pathname.endsWith("/") ? url.toString() : `${url.toString()}/` };
	}
	throw new Error(`update.feed must be github:<owner>/<repo> or an http(s) base URL: ${JSON.stringify(value.slice(0, 100))}`);
}
