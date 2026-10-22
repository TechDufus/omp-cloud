import { GitHubError } from "../github/api";
import type { AppInstallation, GitHubApp } from "../github/app";
import { readJsonObject } from "./body";
import { ApiError } from "./errors";

/** A request body: an origin and an organization name, or GitHub's one-time code and the state. */
const MAX_BODY_BYTES = 8 * 1024;
const ORG = /^[A-Za-z0-9-]{1,39}$/;
const NOT_FOUND = "not found";

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A non-empty string field of `body`; ApiError 400 naming it otherwise. */
function requiredString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, `${key} is required`);
	return value;
}

/** The origin an `http:` or `https:` URL names, which must carry no path, query or hash; ApiError 400 otherwise. */
function originOf(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ApiError(400, "origin must be an http or https URL");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
		throw new ApiError(400, "origin must be an http or https URL without a path, query or hash");
	}
	return url.origin;
}

/** GitHub's refusals of the caller's request (400, 409) pass through; any other failure is a 502. */
function githubFailure(error: unknown): never {
	if (error instanceof GitHubError) {
		if (error.status === 400 || error.status === 409) throw new ApiError(error.status, error.message);
		throw new ApiError(502, error.status === 0 ? `GitHub did not answer: ${error.message}` : `GitHub answered ${error.status}: ${error.message}`);
	}
	throw error;
}

/**
 * The routes under `/api/v1/github`; `segments` is the path after it: the connected App and where it is installed, the
 * manifest flow that creates the App, and disconnecting it. Answers `404` for any other path or method. Authentication
 * and the owner-only scope are the caller's.
 */
export async function handleGithub(req: Request, segments: string[], deps: { app: GitHubApp }): Promise<Response> {
	const { app } = deps;
	const [action, ...rest] = segments;
	if (rest.length > 0) throw new ApiError(404, NOT_FOUND);
	if (action === undefined) {
		if (req.method === "GET") {
			let installations: AppInstallation[] = [];
			let installationsError = "";
			if (app.connected()) {
				try {
					installations = await app.installations();
				} catch (error) {
					installationsError = error instanceof Error ? error.message : String(error);
				}
			}
			return json(200, { app: app.info(), installUrl: app.installUrl(), installations, installationsError });
		}
		if (req.method === "DELETE") {
			await app.disconnect();
			return json(202, { status: "disconnected" });
		}
		throw new ApiError(404, NOT_FOUND);
	}
	if (req.method !== "POST") throw new ApiError(404, NOT_FOUND);
	if (action === "manifest") {
		const body = await readJsonObject(req, MAX_BODY_BYTES);
		const origin = originOf(requiredString(body, "origin"));
		const org = body.org === undefined || body.org === null || body.org === "" ? null : body.org;
		if (org !== null && (typeof org !== "string" || !ORG.test(org))) throw new ApiError(400, "org must be a GitHub organization name");
		return json(200, app.manifest({ origin, org }));
	}
	if (action === "conversions") {
		const body = await readJsonObject(req, MAX_BODY_BYTES);
		const code = requiredString(body, "code");
		const state = requiredString(body, "state");
		try {
			return json(200, { app: await app.convert(code, state) });
		} catch (error) {
			return githubFailure(error);
		}
	}
	throw new ApiError(404, NOT_FOUND);
}
