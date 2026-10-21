import { MIGRATIONS } from "../store/schema";
import { BUILD, SERVICE_VERSION } from "../version";
import type { UpdateState } from "../update/policy";
import { UpdateConflict, type UpdateStatus } from "../update/service";
import type { Caller } from "./auth";
import { ApiError } from "./errors";
import { OWNER_ONLY_MESSAGE } from "./scopes";

/** Public, no authentication: what the updater's health check (and any monitor) polls. */
export const HEALTH_PATH = "/api/v1/health";
export const UPDATE_PATH = "/api/v1/update";

/** What the routes need of the updater (`UpdateService`). */
export interface UpdateApi {
	status(): Promise<UpdateStatus>;
	summary(): Promise<{ state: UpdateState; available: string | null }>;
	/** Runs a check now; resolves when it is over and never rejects (a failure is the status's `error`). */
	check(): Promise<void>;
	/** Starts the apply of the staged release. Throws UpdateConflict. */
	apply(): Promise<{ version: string }>;
}

/** The answer of `GET /api/v1/health`: this process's version, build and the schema its database runs at. */
export function healthBody(): { status: "ok"; version: string; build: typeof BUILD; schema: number } {
	return { status: "ok", version: SERVICE_VERSION, build: BUILD, schema: MIGRATIONS.length };
}

/** `whoami.update` for a service that has an updater, else a checkout-like `unsupported`. */
export async function updateSummary(update: UpdateApi | undefined): Promise<{ state: UpdateState; available: string | null }> {
	return update === undefined ? { state: "unsupported", available: null } : update.summary();
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * `GET /api/v1/update`, `POST /api/v1/update/check` and `POST /api/v1/update/apply`, owner token only (a device gets
 * 403: it sees the state in `whoami`). Null when `pathname`/`method` is not one of them. Without an updater the routes
 * do not exist (404).
 */
export async function handleUpdate(update: UpdateApi | undefined, caller: Caller, req: Request, pathname: string): Promise<Response | null> {
	const get = req.method === "GET" && pathname === UPDATE_PATH;
	const check = req.method === "POST" && pathname === `${UPDATE_PATH}/check`;
	const apply = req.method === "POST" && pathname === `${UPDATE_PATH}/apply`;
	if (!get && !check && !apply) return null;
	if (update === undefined) return null;
	if (caller.device !== null) throw new ApiError(403, OWNER_ONLY_MESSAGE);
	if (get) return json(200, await update.status());
	if (check) {
		void update.check();
		return json(202, {});
	}
	try {
		return json(202, { applying: await update.apply() });
	} catch (error) {
		if (error instanceof UpdateConflict) return json(409, { error: error.message });
		throw error;
	}
}
