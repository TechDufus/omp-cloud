/**
 * The vibemon admin API (`/admin/*`, header `X-Admin-Token`): the cluster's members and their load, and a team's running VMs.
 * Only the fields omp-cloud shows are read, each guarded: a field vibemon drops or renames in a later release becomes a
 * default here, never a thrown error.
 */
import { isRecord } from "../guards";

const ADMIN_TIMEOUT_MS = 5000;

/** The admin token file is missing, empty or unreadable. The message names the file, never the token. */
export class VmonAdminUnavailable extends Error {}

/** vibemon answered 401: the token in the file is not (or no longer) its admin token. */
export class VmonAdminRefused extends Error {
	constructor(readonly tokenFile: string) {
		super(`vibemon refused the admin token in ${tokenFile}`);
	}
}

/** One 5 s sample of the cluster, `ts` in milliseconds since the epoch. */
export interface FleetSample {
	ts: number;
	nodes: number;
	sandboxes: number;
	builds: number;
	vcpus: number;
	vcpusUsed: number;
	memoryMB: number;
	memoryUsedMB: number;
	starts: number;
}

/** A cluster member that runs VMs (`roles.node`). */
export interface ClusterNode {
	id: string;
	hostname: string;
	addrs: string[];
	/** The member's gossip state is `alive`. */
	alive: boolean;
	/** `node.status` of an alive member ("ready", …); the gossip state ("suspect", "dead", "left") of any other. */
	status: string;
	version: string;
	/** This is the member that answered: the omp-cloud server's own vibemon. */
	server: boolean;
	cpus: number;
	vcpusUsed: number;
	memoryMB: number;
	memoryUsedMB: number;
	diskFreeMB: number;
	sandboxes: number;
}

export interface ClusterView {
	localId: string;
	nodes: ClusterNode[];
	history: FleetSample[];
}

export interface TeamView {
	slug: string;
	running: number;
	paused: number;
	maxConcurrentSandboxes: number;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sample(value: unknown): FleetSample | null {
	if (!isRecord(value) || typeof value.ts !== "number" || Number.isNaN(new Date(value.ts).getTime())) return null;
	return {
		ts: value.ts,
		nodes: count(value.nodes),
		sandboxes: count(value.sandboxes),
		builds: count(value.builds),
		vcpus: count(value.vcpus),
		vcpusUsed: count(value.vcpusUsed),
		memoryMB: count(value.memoryMB),
		memoryUsedMB: count(value.memoryUsedMB),
		starts: count(value.starts),
	};
}

function member(value: unknown, localId: string): ClusterNode | null {
	if (!isRecord(value) || !isRecord(value.roles) || value.roles.node !== true) return null;
	const id = text(value.id);
	const state = text(value.state);
	const alive = state === "alive";
	const stats = isRecord(value.node) ? value.node : {};
	return {
		id,
		hostname: text(value.hostname),
		addrs: Array.isArray(value.addrs) ? value.addrs.filter((addr): addr is string => typeof addr === "string") : [],
		alive,
		status: alive ? text(stats.status) || "unknown" : state || "unknown",
		version: text(value.version),
		server: id === localId,
		cpus: count(stats.cpus),
		vcpusUsed: count(stats.vcpusUsed),
		memoryMB: count(stats.memoryMB),
		memoryUsedMB: count(stats.memoryUsedMB),
		diskFreeMB: count(stats.diskFreeMB),
		sandboxes: count(stats.sandboxes),
	};
}

/** The answer of `GET /admin/cluster`; a body of another shape is an empty cluster. */
export function parseCluster(raw: unknown): ClusterView {
	if (!isRecord(raw)) return { localId: "", nodes: [], history: [] };
	const localId = text(raw.localID);
	const nodes = (Array.isArray(raw.members) ? raw.members : []).map((entry) => member(entry, localId)).filter((node): node is ClusterNode => node !== null);
	const history = (Array.isArray(raw.history) ? raw.history : []).map(sample).filter((entry): entry is FleetSample => entry !== null);
	return { localId, nodes, history };
}

/** The team `slug` in the answer of `GET /admin/teams`; null when the list has none. */
export function parseTeam(raw: unknown, slug: string): TeamView | null {
	for (const entry of Array.isArray(raw) ? raw : []) {
		if (!isRecord(entry) || entry.slug !== slug) continue;
		const limits = isRecord(entry.limits) ? entry.limits : {};
		const sandboxes = isRecord(entry.sandboxes) ? entry.sandboxes : {};
		return { slug, running: count(sandboxes.running), paused: count(sandboxes.paused), maxConcurrentSandboxes: count(limits.maxConcurrentSandboxes) };
	}
	return null;
}

export class VmonAdmin {
	readonly #url: string;
	readonly #tokenFile: string;
	readonly #token: string;

	private constructor(url: string, tokenFile: string, token: string) {
		this.#url = url.replace(/\/+$/, "");
		this.#tokenFile = tokenFile;
		this.#token = token;
	}

	/** Reads the token file now, so a file that setup wrote later is found without a restart. */
	static async open(options: { url: string; tokenFile: string }): Promise<VmonAdmin> {
		let token: string;
		try {
			token = (await Bun.file(options.tokenFile).text()).trim();
		} catch {
			throw new VmonAdminUnavailable(`cannot read the vibemon admin token file ${options.tokenFile}`);
		}
		if (token === "") throw new VmonAdminUnavailable(`the vibemon admin token file ${options.tokenFile} is empty`);
		return new VmonAdmin(options.url, options.tokenFile, token);
	}

	async cluster(): Promise<ClusterView> {
		return parseCluster(await this.#get("/admin/cluster"));
	}

	/** Team `slug`'s VMs and limit; null when vibemon has no such team. */
	async team(slug: string): Promise<TeamView | null> {
		return parseTeam(await this.#get("/admin/teams"), slug);
	}

	async #get(path: string): Promise<unknown> {
		const response = await fetch(`${this.#url}${path}`, { headers: { "X-Admin-Token": this.#token }, signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS) });
		if (response.status === 401) throw new VmonAdminRefused(this.#tokenFile);
		if (!response.ok) throw new Error(`${path} answered ${response.status}`);
		try {
			return await response.json();
		} catch {
			throw new Error(`${path} answered something that is not JSON`);
		}
	}
}
