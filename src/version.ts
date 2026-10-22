import pkg from "../package.json" with { type: "json" };

/** Which build this is: set by `scripts/release.ts`, `dev` in a checkout. */
export interface Build {
	/** `<YYYYMMDDHHMMSS>-<short commit>` of a release build, `dev` otherwise. */
	id: string;
	/** The full commit the release was built from; `""` in a checkout. */
	commit: string;
	/** ISO time of the build; `""` in a checkout. */
	createdAt: string;
}

/** What a checkout or a test run reports: no build defines were injected. */
export const DEV_BUILD: Build = { id: "dev", commit: "", createdAt: "" };

/**
 * `bun build --define`d by a release build (`scripts/release.ts`): the version as a string literal and the build as a
 * string literal holding JSON. Undeclared (a checkout, `bun test`), they must only be read through `typeof`.
 */
declare const __OMP_CLOUD_VERSION__: string | undefined;
declare const __OMP_CLOUD_BUILD__: string | undefined;

/** The build described by the JSON text a release build injected; `undefined` (no define) is the dev build, anything malformed throws. */
export function parseBuild(text: string | undefined): Build {
	if (text === undefined) return DEV_BUILD;
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== "object" || raw === null) throw new Error("the injected omp-cloud build is not an object");
	const { id, commit, createdAt } = { id: Reflect.get(raw, "id"), commit: Reflect.get(raw, "commit"), createdAt: Reflect.get(raw, "createdAt") };
	if (typeof id !== "string" || typeof commit !== "string" || typeof createdAt !== "string" || id === "") {
		throw new Error("the injected omp-cloud build needs string id, commit and createdAt");
	}
	return { id, commit, createdAt };
}

/** The service's version: the release build's, else `version` in the root package.json. */
export const SERVICE_VERSION: string = typeof __OMP_CLOUD_VERSION__ === "undefined" ? pkg.version : __OMP_CLOUD_VERSION__;

/** The build this process runs. */
export const BUILD: Build = parseBuild(typeof __OMP_CLOUD_BUILD__ === "undefined" ? undefined : __OMP_CLOUD_BUILD__);

/** The API revision: an integer bumped whenever the contract gains something a client may depend on. `whoami` and `omp-cloud ssh-pair` report it. */
export const API_VERSION = 5;
