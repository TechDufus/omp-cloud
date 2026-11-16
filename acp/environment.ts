/**
 * What the ACP agent does outside its own code: the cloud connection of a directory, the handoff of a session's first
 * prompt and the pull of a result. Tests replace it; {@link productionEnvironment} is the plugin's code on a host that is
 * not omp.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { CloudClient } from "../plugin/src/api";
import { readConfig, resolveConnection, type CloudConfig } from "../plugin/src/config";
import type { EventSource, FollowOptions } from "../plugin/src/events";
import { launchBatch, type LaunchedThread, type LaunchProgress } from "../plugin/src/launch";
import { serverHostOf } from "../plugin/src/login";
import { applyPull, type Applied } from "../plugin/src/pull";
import { gitRaw } from "../plugin/src/snapshot";
import { pinnedFetch } from "../plugin/src/transport";

/** `events` is the plugin's `EventSource` type (`plugin/src/events.ts`): `CloudClient.events` fits it, and so does a test feed. */
export type AcpClient = Pick<CloudClient, "whoami" | "requireCapability" | "createThread" | "downloadResult" | "thread" | "listThreadsPage" | "eventsPage" | "sendMessage" | "answer" | "stop"> & {
	events: EventSource;
};

export interface CloudConnection {
	client: AcpClient;
	cfg: CloudConfig;
	/** The git toplevel of the session's cwd; undefined outside a repository. */
	root: string | undefined;
	/** The server's host when this machine is a paired device. */
	serverHost: string | undefined;
}

export interface LaunchRequest {
	cwd: string;
	prompt: string;
	/** The ACP session id: the thread's `ref` and the create's idempotency key. */
	ref: string;
	/** `provider/id`, or `""` for the cloud's default. */
	model: string;
	/** A thinking level, or `""`. */
	thinking: string;
	signal: AbortSignal;
	onProgress(progress: LaunchProgress): void;
}

export interface AcpEnvironment {
	/** Throws `UserError` when omp-cloud is not configured. */
	connect(cwd: string): Promise<CloudConnection>;
	/** Creates the thread of a session's first prompt; throws the handoff's `CloudError`. */
	launch(cloud: CloudConnection, request: LaunchRequest): Promise<LaunchedThread>;
	/** Brings the thread's result into the repository of `cwd`. */
	pull(cloud: CloudConnection, input: { cwd: string; thread: string; apply: "fetch" | "merge" }): Promise<Applied>;
	/** Test seam for `follow`. */
	follow?: FollowOptions;
}

async function connect(cwd: string): Promise<CloudConnection> {
	const top = await gitRaw(cwd, ["rev-parse", "--show-toplevel"]);
	const root = top.code === 0 ? top.stdout.trim() : undefined;
	const cfg = await readConfig({ env: process.env, home: homedir(), repoRoot: root, platform: process.platform });
	const conn = await resolveConnection(cfg);
	const client = new CloudClient(conn.url, conn.token, conn.paired ? pinnedFetch(conn.paired.server) : undefined, {}, conn.unauthorizedHint);
	return { client, cfg, root, serverHost: serverHostOf(conn.paired) };
}

/**
 * The plugin's handoff with a host that is not omp: the repository with its uncommitted work, the omp setup of this
 * machine, no conversation and no generated name. The VM runs the service's omp version, and origin `user` keeps the
 * cloud agent's `ask` tool on.
 */
async function launch(cloud: CloudConnection, request: LaunchRequest): Promise<LaunchedThread> {
	const { cwd, model, thinking } = request;
	// Reads config.yml and the project settings without the global singleton or agent.db.
	const settings = await Settings.loadReadOnly({ cwd });
	const agentDir = settings.getAgentDir();
	// The plugin itself is neither shipped nor warned about; without one installed, a path nothing lies under.
	const ownRoot = (await getEnabledPlugins(cwd)).find(plugin => plugin.name === "omp-cloud")?.path ?? join(agentDir, ".omp-cloud-none");
	const batch = await launchBatch({
		host: { cwd, model: undefined, modelRegistry: undefined, sessionManager: { getSessionFile: () => undefined, getSessionDir: () => "" } },
		pi: { getThinkingLevel: () => undefined, pi: { VERSION: "", settings } },
		cfg: cloud.cfg,
		client: cloud.client,
		serverHost: cloud.serverHost,
		tasks: [{ task: request.prompt, ref: request.ref, conversation: "none", ...(model !== "" ? { model } : {}), ...(thinking !== "" ? { thinking } : {}) }],
		origin: "user",
		sessionId: "",
		env: process.env,
		home: homedir(),
		agentDir,
		ownRoot,
		signal: request.signal,
		onProgress: request.onProgress,
	});
	const outcome = batch.outcomes[0];
	if (outcome === undefined) throw new Error("the handoff produced no outcome");
	if (!outcome.ok) throw outcome.error;
	return outcome;
}

async function pull(cloud: CloudConnection, input: { cwd: string; thread: string; apply: "fetch" | "merge" }): Promise<Applied> {
	const { client } = cloud;
	const detail = await client.thread(input.thread);
	const tmp = await mkdtemp(join(tmpdir(), "omp-cloud-pull-"));
	try {
		const bundlePath = join(tmp, "result.bundle");
		const headers = await client.downloadResult(input.thread, bundlePath);
		return await applyPull({
			root: cloud.root,
			cwd: input.cwd,
			thread: input.thread,
			scratch: detail.scratch,
			bundlePath,
			identity: { handoffCommit: detail.repo.handoffCommit, baseCommit: detail.repo.baseCommit || headers.base, remoteURL: detail.repo.remoteURL },
			apply: input.apply,
			into: undefined,
			force: false,
		});
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

export function productionEnvironment(): AcpEnvironment {
	// Launches of one repository run one at a time: their snapshots share `refs/omp-cloud/handoff`.
	const launching = new Map<string, Promise<unknown>>();
	return {
		connect,
		launch(cloud, request) {
			const key = cloud.root ?? request.cwd;
			const start = (): Promise<LaunchedThread> => launch(cloud, request);
			const queued = (launching.get(key) ?? Promise.resolve()).then(start, start);
			launching.set(key, queued);
			const forget = (): void => {
				if (launching.get(key) === queued) launching.delete(key);
			};
			queued.then(forget, forget);
			return queued;
		},
		pull,
	};
}
