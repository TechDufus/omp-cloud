import { MIGRATIONS } from "../store/schema";
import { BUILD, SERVICE_VERSION } from "../version";
import type { UpdateState } from "../update/policy";
import { UpdateConflict, type UpdateStatus } from "../update/service";
import { UPDATE_PATH } from "./paths";

/** Public, no authentication: what the updater's health check (and any monitor) polls. */
export const HEALTH_PATH = "/api/v1/health";

/** What the routes need of the updater (`UpdateService`). */
export interface UpdateApi {
	status(): Promise<UpdateStatus>;
	summary(): Promise<{ state: UpdateState; available: string | null }>;
	/** Runs a check now; resolves when it is over and never rejects (a failure is the status's `error`). */
	check(): Promise<void>;
	/** Starts the apply of the staged release. Throws UpdateConflict. */
	apply(): Promise<{ version: string }>;
}

/**
 * The answer of `GET /api/v1/health`: this process's version, build, the schema its database runs at and the vibemon tag
 * installed on the server (`vmon`, null when unknown): the other machines of a cluster follow that tag.
 */
export function healthBody(vmon: string | null): { status: "ok"; version: string; build: typeof BUILD; schema: number; vmon: string | null } {
	return { status: "ok", version: SERVICE_VERSION, build: BUILD, schema: MIGRATIONS.length, vmon };
}

/** `whoami.update` for a service that has an updater, else a checkout-like `unsupported`. */
export async function updateSummary(update: UpdateApi | undefined): Promise<{ state: UpdateState; available: string | null }> {
	return update === undefined ? { state: "unsupported", available: null } : update.summary();
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * `GET /api/v1/update`, `POST /api/v1/update/check` and `POST /api/v1/update/apply`. Null when `pathname`/`method` is
 * none of them. Without an updater the routes do not exist (404). Who may call is `requireScope`'s: the status is open to
 * every caller, `check` and `apply` need full access.
 */
export async function handleUpdate(update: UpdateApi | undefined, req: Request, pathname: string): Promise<Response | null> {
	const get = req.method === "GET" && pathname === UPDATE_PATH;
	const check = req.method === "POST" && pathname === `${UPDATE_PATH}/check`;
	const apply = req.method === "POST" && pathname === `${UPDATE_PATH}/apply`;
	if (!get && !check && !apply) return null;
	if (update === undefined) return null;
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
