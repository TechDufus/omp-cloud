import { Sandbox, SandboxNotFoundError, type SandboxNetworkOpts, Template } from "e2b";
import { installedVmonVersion } from "./pin";
import { buildTemplate, Templates } from "./template";

export interface SandboxSummary {
	sandboxId: string;
	state: "running" | "paused";
	metadata: Record<string, string>;
	/** ISO 8601. */
	startedAt: string;
	cpuCount: number;
	memoryMB: number;
}

/** The newest resource sample of a running sandbox; memory and disk in bytes. */
export interface SandboxMetricsSample {
	/** ISO 8601. */
	at: string;
	cpuUsedPct: number;
	memUsed: number;
	memTotal: number;
	diskUsed: number;
	diskTotal: number;
}

/** How far back `metrics` looks for a sample: vmon records one about every 5 s (one or two right after boot), so a running sandbox always has one in this window. */
const METRICS_WINDOW_MS = 5 * 60_000;
/** A metrics request that takes longer is abandoned: the dashboard shows the VM without a sample. */
const METRICS_TIMEOUT_MS = 5000;

/**
 * The sandbox network of the egress policy: undefined when `egress` is empty (the network stays open), else everything
 * denied except the gateway's host and `egress` (IPv4 addresses, CIDRs, domains; an allowed entry beats the deny, and a
 * domain is resolved for the sandbox). `allowInternetAccess: false` alone would cut the gateway off too, so it is not
 * used. vmon enforces the network from create time only, and it survives a pause and resume on one node.
 */
export function egressNetwork(gatewayUrl: string, egress: readonly string[]): SandboxNetworkOpts | undefined {
	if (egress.length === 0) return undefined;
	return { denyOut: ["0.0.0.0/0"], allowOut: [...new Set([new URL(gatewayUrl).hostname, ...egress])] };
}

interface Connection {
	apiKey: string;
	apiUrl: string;
	sandboxUrl: string;
	domain: string;
}

/**
 * The local vmon (e2b-compatible API) as this service uses it. One URL serves the API and envd (`apiUrl` and `sandboxUrl`
 * are both passed explicitly): vmon routes envd calls by the `E2b-Sandbox-Id` header.
 */
export class Vmon {
	private constructor(
		private readonly connection: Connection,
		private readonly templates: Templates,
	) {}

	/** Reads and trims the key file (error naming the path, never the key, when missing or empty). `template` is the template base name: `<template>:<omp version>-<recipe hash>` is what threads run. */
	static async open(config: { url: string; keyFile: string; template: string }): Promise<Vmon> {
		let apiKey: string;
		try {
			apiKey = (await Bun.file(config.keyFile).text()).trim();
		} catch (error) {
			throw new Error(`cannot read the vmon key file ${config.keyFile}`, { cause: error });
		}
		if (!apiKey) throw new Error(`the vmon key file ${config.keyFile} is empty`);
		const connection = { apiKey, apiUrl: config.url, sandboxUrl: config.url, domain: new URL(config.url).hostname };
		const templates = new Templates(
			config.template,
			{
				exists: name => Template.exists(name, connection),
				build: async (name, version) => {
					const seconds = await buildTemplate(name, version, connection);
					console.log(`omp-cloud: built the template ${name} in ${seconds.toFixed(1)} s`);
				},
			},
			() => installedVmonVersion(),
		);
		return new Vmon(connection, templates);
	}

	/** The template name of an omp version, built first when it does not exist; see `Templates.ensure`. */
	ensureTemplate(version: string, onBuilding?: () => void): Promise<string> {
		return this.templates.ensure(version, onBuilding);
	}

	/** Builds the template of omp `version` for the installed vmon in the background when it is missing; never throws. */
	prebuildTemplate(version: string): Promise<void> {
		return this.templates.prebuild(version);
	}

	/**
	 * From the template `template` (see `ensureTemplate`); vmon pauses it at expiry instead of killing it. `network`
	 * (see {@link egressNetwork}) and `metadata` are fixed for the sandbox's life.
	 */
	create(template: string, metadata: Record<string, string>, timeoutMs: number, network?: SandboxNetworkOpts): Promise<Sandbox> {
		return Sandbox.create(template, {
			...this.connection,
			metadata,
			timeoutMs,
			lifecycle: { onTimeout: "pause" },
			...(network === undefined ? {} : { network }),
		});
	}

	/** Resumes a paused sandbox or extends a running one; null when vmon no longer has it. */
	async connect(sandboxId: string, timeoutMs: number): Promise<Sandbox | null> {
		try {
			return await Sandbox.connect(sandboxId, { ...this.connection, timeoutMs });
		} catch (error) {
			if (error instanceof SandboxNotFoundError) return null;
			throw error;
		}
	}

	/** Running and paused sandboxes whose metadata contains every given pair (the filter is an exact match on each value); all pages. */
	async list(metadata: Record<string, string>): Promise<SandboxSummary[]> {
		const paginator = Sandbox.list({ ...this.connection, query: { metadata, state: ["running", "paused"] } });
		const found: SandboxSummary[] = [];
		while (paginator.hasNext) {
			for (const info of await paginator.nextItems()) {
				found.push({
					sandboxId: info.sandboxId,
					state: info.state,
					metadata: info.metadata,
					startedAt: info.startedAt.toISOString(),
					cpuCount: info.cpuCount,
					memoryMB: info.memoryMB,
				});
			}
		}
		return found;
	}

	/** The newest sample of the last few minutes, or null when vmon has none (a paused sandbox, or no metrics endpoint). Throws when the request fails. */
	async metrics(sandboxId: string): Promise<SandboxMetricsSample | null> {
		const samples = await Sandbox.getMetrics(sandboxId, {
			...this.connection,
			start: new Date(Date.now() - METRICS_WINDOW_MS),
			requestTimeoutMs: METRICS_TIMEOUT_MS,
		});
		let newest: (typeof samples)[number] | undefined;
		for (const sample of samples) {
			if (newest === undefined || sample.timestamp > newest.timestamp) newest = sample;
		}
		if (newest === undefined) return null;
		return {
			at: newest.timestamp.toISOString(),
			cpuUsedPct: newest.cpuUsedPct,
			memUsed: newest.memUsed,
			memTotal: newest.memTotal,
			diskUsed: newest.diskUsed,
			diskTotal: newest.diskTotal,
		};
	}

	/** False when it was already gone. */
	kill(sandboxId: string): Promise<boolean> {
		return Sandbox.kill(sandboxId, this.connection);
	}
}
