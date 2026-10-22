/**
 * GitHub's redirects back to the dashboard. Creating the App ends with `/?code=…&state=…` (the manifest flow), installing it
 * ends with `/?github=installed`. Either way the query leaves the address bar at once, and the page that follows is the
 * GitHub page. A failed conversion is parked in `sessionStorage` for that page to show.
 */
import { githubConvert } from "../api";
import { messageOf } from "./query";

const ERROR_KEY = "omp-cloud.github.error";

let started = false;
let finished: Promise<void> = Promise.resolve();

/** Handles the return from GitHub, if `location.search` is one; runs once per page load. */
export function runGithubReturn(): void {
	if (started) return;
	started = true;
	const query = new URLSearchParams(window.location.search);
	const code = query.get("code");
	const state = query.get("state");
	const installed = query.get("github") === "installed";
	if (!installed && (code === null || state === null)) return;

	// The code is single use, but keep it out of history and the address bar before anything else happens.
	window.history.replaceState(null, "", "/#/github");
	window.dispatchEvent(new HashChangeEvent("hashchange"));
	if (code === null || state === null) return;
	finished = githubConvert(code, state).then(
		() => undefined,
		(error: unknown) => {
			window.sessionStorage.setItem(ERROR_KEY, messageOf(error));
		},
	);
}

/** Resolves when the return handling is done; at once when there was none. */
export function githubReturned(): Promise<void> {
	return finished;
}

/** The parked conversion error, if any. */
export function readGithubReturnError(): string | null {
	return window.sessionStorage.getItem(ERROR_KEY);
}

export function clearGithubReturnError(): void {
	window.sessionStorage.removeItem(ERROR_KEY);
}
