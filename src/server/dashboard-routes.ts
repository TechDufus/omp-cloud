import type { DashboardSessions } from "../dashboard/session";
import type { Store } from "../store";
import type { SandboxMetricsSample, SandboxSummary } from "../vmon";
import type { Capacity } from "../vmon/capacity";
import type { ApiServer } from "./api-server";
import type { Caller } from "./auth";
import { relayDashboardStatic } from "./dashboard-static";
import { ApiError } from "./errors";
import { type EventStreamOptions, globalEventStream } from "./events";
import { DASHBOARD_STATIC_PATH } from "./paths";

/** The route that mints sign-in links: reachable on the API listeners with the owner token only, never through the dashboard listener. */
export const DASHBOARD_LINKS_PATH = "/api/v1/dashboard/links";
const EVENTS_PATH = "/api/v1/events";
const USAGE_PATH = "/api/v1/usage";
const VMS_PATH = "/api/v1/vms";
/** `GET` answers the cluster's capacity; open to every caller. */
export const CAPACITY_PATH = "/api/v1/capacity";

/** The window `GET /api/v1/usage` sums when it gets no `since`. */
const DEFAULT_USAGE_DAYS = 30;
const DAY_MS = 86_400_000;
const ISO_START = /^\d{4}-\d{2}-\d{2}/;

/** What the VM list reads from vmon: `Vmon` satisfies it. */
export interface VmInspector {
	list(metadata: Record<string, string>): Promise<SandboxSummary[]>;
	/** The newest sample, or null when there is none; throws when vmon fails. */
	metrics(sandboxId: string): Promise<SandboxMetricsSample | null>;
}

export interface DashboardRoutesOptions {
	store: Store;
	/**
	 * Set when the config has a `dashboard` section: `origin` is what the sign-in link points at (no trailing slash) and
	 * `upstream` the listener's fixed `http://<host>:<port>` origin, which the static relay fetches from.
	 */
	dashboard?: { origin: string; upstream: string; sessions: DashboardSessions };
	/** Absent when the service opened no vmon client (runner off and no dashboard, or vmon failed to open): the VM list then shows the store's records only. */
	vmon?: VmInspector;
	/** Where vmon's own dashboard lives; `""` when unknown. */
	vmonDashboard?: string;
	/** Reads the cluster's capacity for `GET /api/v1/capacity`. Absent: that route answers 404. */
	capacity?: () => Promise<Capacity>;
	/** Test seam for the stream's keepalive interval. */
	events?: EventStreamOptions;
}

/** One VM of `GET /api/v1/vms`; `""`, `0` and `null` mean vmon told nothing. */
interface VmView {
	thread: string;
	sandboxId: string;
	state: "running" | "paused";
	pid: number | null;
	startedAt: string;
	cpuCount: number;
	memoryMB: number;
	metrics: SandboxMetricsSample | null;
}

/** `since` of the usage route as an ISO instant, defaulting to 30 days ago. Throws ApiError 400. */
function usageSince(req: Request): string {
	const raw = new URL(req.url).searchParams.get("since");
	if (raw === null) return new Date(Date.now() - DEFAULT_USAGE_DAYS * DAY_MS).toISOString();
	const at = ISO_START.test(raw) ? Date.parse(raw) : Number.NaN;
	if (Number.isNaN(at)) throw new ApiError(400, "since must be an ISO 8601 time");
	return new Date(at).toISOString();
}

/** The dashboard's routes under `/api/v1`: the global event stream, spend, VMs and link minting. */
export class DashboardRoutes {
	constructor(private readonly options: DashboardRoutesOptions) {}

	/** The response of `method` + `pathname`, or null when no dashboard route matches (the caller answers 404). Authentication and scopes are the caller's. */
	async handle(caller: Caller, req: Request, pathname: string, server: ApiServer | undefined): Promise<Response | null> {
		const { principal } = caller;
		if (pathname === DASHBOARD_LINKS_PATH) return req.method === "POST" ? this.#link() : null;
		if (pathname === DASHBOARD_STATIC_PATH || pathname.startsWith(`${DASHBOARD_STATIC_PATH}/`)) {
			if (req.method !== "GET" && req.method !== "HEAD") return null;
			const { dashboard } = this.options;
			if (dashboard === undefined) throw new ApiError(404, "the dashboard is not configured");
			return relayDashboardStatic(req, pathname, dashboard.upstream);
		}
		if (req.method !== "GET") return null;
		switch (pathname) {
			case EVENTS_PATH:
				return globalEventStream(this.options.store, principal, req, server, this.options.events);
			case USAGE_PATH: {
				const since = usageSince(req);
				return Response.json({ since, ...this.options.store.spend(principal, since) });
			}
			case VMS_PATH:
				return Response.json(await this.#vms(principal));
			case CAPACITY_PATH: {
				const { capacity } = this.options;
				if (capacity === undefined) throw new ApiError(404, "not found");
				return Response.json(await capacity());
			}
			default:
				return null;
		}
	}

	#link(): Response {
		const { dashboard } = this.options;
		if (dashboard === undefined) throw new ApiError(404, "the dashboard is not configured");
		const { code, expiresAt } = dashboard.sessions.mintLink();
		return Response.json({ url: `${dashboard.origin}/#${code}`, expiresAt }, { status: 201 });
	}

	async #vms(principal: string): Promise<{ vmonDashboard: string; vms: VmView[] }> {
		const { store, vmon, vmonDashboard = "" } = this.options;
		const live = new Map<string, SandboxSummary>();
		if (vmon !== undefined) {
			try {
				for (const sandbox of await vmon.list({ app: "omp-cloud", service: store.serviceId() })) live.set(sandbox.sandboxId, sandbox);
			} catch {
				// vmon is unreachable: the records alone still answer.
			}
		}
		const records = store.vms().filter(record => store.threadOwner(record.threadId) === principal);
		const vms = await Promise.all(
			records.map(async (record): Promise<VmView> => {
				const sandbox = live.get(record.sandboxId);
				let metrics: SandboxMetricsSample | null = null;
				if (vmon !== undefined && sandbox?.state === "running") {
					try {
						metrics = await vmon.metrics(record.sandboxId);
					} catch {
						// An old vmon without a metrics endpoint, or a sandbox that just paused.
					}
				}
				return {
					thread: record.threadId,
					sandboxId: record.sandboxId,
					state: sandbox?.state ?? record.state,
					pid: record.pid,
					startedAt: sandbox?.startedAt ?? "",
					cpuCount: sandbox?.cpuCount ?? 0,
					memoryMB: sandbox?.memoryMB ?? 0,
					metrics,
				};
			}),
		);
		return { vmonDashboard, vms };
	}
}
