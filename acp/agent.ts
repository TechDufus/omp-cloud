/** The ACP agent of `omp-cloud acp`: sessions are cloud threads, and each method is a few calls of the plugin's client. */

import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import {
	PROTOCOL_VERSION,
	RequestError,
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
} from "@oh-my-pi/pi-utils/acp";
import { cloudErrorText } from "../plugin/src/errors";
import { asCloudError } from "../plugin/src/launch";
import type { Whoami } from "../plugin/src/types";
import { SERVICE_VERSION } from "../src/version";
import type { AcpClient, AcpEnvironment, CloudConnection } from "./environment";
import { SESSION_ID, sessionIdOf } from "./render";
import { AcpSession } from "./session";

const AUTH_METHOD = "omp-cloud";
const THREAD_ID = /^[a-z0-9]{12}$/;
/** What the agent cannot work without. `events.text` is not among them: without it a reply arrives message by message. */
const NEEDED: readonly string[] = ["threads.meta", "threads.idempotency", "threads.paging", "events.live", "events.json"];

/** Any failure as the JSON-RPC error the editor shows. */
export function toRequestError(error: unknown): RequestError {
	if (error instanceof RequestError) return error;
	const cloud = asCloudError(error);
	const text = cloudErrorText(cloud);
	switch (cloud.code) {
		case "not_configured":
		case "unauthorized":
			return RequestError.authRequired(undefined, text);
		case "not_found":
			return new RequestError(-32002, text);
		case "invalid":
		case "too_large":
			return RequestError.invalidParams(undefined, text);
		default:
			return RequestError.internalError(undefined, text);
	}
}

/** The thread a session id names: the one a session of this agent made (its `ref`), or a thread id. Throws `resourceNotFound`. */
async function resolveThread(client: AcpClient, sessionId: string): Promise<string> {
	if (SESSION_ID.test(sessionId)) {
		const found = (await client.listThreadsPage({ ref: sessionId, limit: 1 })).threads[0];
		if (found !== undefined) return found.id;
	} else if (THREAD_ID.test(sessionId)) {
		return sessionId;
	}
	throw RequestError.resourceNotFound(sessionId);
}

export class CloudAcpAgent implements Agent {
	readonly #connection: Pick<AgentSideConnection, "sessionUpdate" | "requestPermission">;
	readonly #env: AcpEnvironment;
	readonly #sessions = new Map<string, AcpSession>();

	constructor(connection: Pick<AgentSideConnection, "sessionUpdate" | "requestPermission">, env: AcpEnvironment) {
		this.#connection = connection;
		this.#env = env;
	}

	initialize(): InitializeResponse {
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: "omp-cloud", title: "omp-cloud", version: SERVICE_VERSION },
			authMethods: [
				{
					id: AUTH_METHOD,
					name: "Use this machine's omp-cloud connection",
					description: "The /cloud plugin's connection: /cloud connect in omp pairs this machine, or set OMP_CLOUD_URL and OMP_CLOUD_TOKEN.",
				},
			],
			agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: { list: {}, close: {} } },
		};
	}

	authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		return this.#guarded(async () => {
			if (params.methodId !== AUTH_METHOD) throw RequestError.invalidParams(undefined, `unknown authentication method ${JSON.stringify(params.methodId)}`);
			await (await this.#env.connect(process.cwd())).client.whoami();
			return {};
		});
	}

	newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		return this.#guarded(async () => {
			if (!isAbsolute(params.cwd)) throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
			const { cloud, who } = await this.#connect(params.cwd);
			const session = new AcpSession({
				id: `acp-${randomBytes(16).toString("hex")}`,
				cwd: params.cwd,
				connection: this.#connection,
				env: this.#env,
				cloud,
				defaultModel: who.defaultModel,
				models: who.models.map(model => model.id),
				mcpServers: params.mcpServers.length,
			});
			this.#sessions.set(session.id, session);
			session.announceCommands();
			return { sessionId: session.id, configOptions: session.options() };
		});
	}

	setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		return this.#guarded(async () => {
			const session = this.#session(params.sessionId);
			session.configure(params.configId, params.value);
			return { configOptions: session.options() };
		});
	}

	loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		return this.#guarded(async () => {
			const { cloud, who } = await this.#connect(params.cwd);
			const thread = await resolveThread(cloud.client, params.sessionId);
			const detail = await cloud.client.thread(thread);
			this.#sessions.get(params.sessionId)?.dispose();
			const session = new AcpSession({
				id: params.sessionId,
				cwd: params.cwd,
				connection: this.#connection,
				env: this.#env,
				cloud,
				defaultModel: who.defaultModel,
				models: [],
				mcpServers: params.mcpServers.length,
				thread,
			});
			this.#sessions.set(session.id, session);
			await session.replay(detail);
			session.announceCommands();
			return { configOptions: session.options() };
		});
	}

	listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		return this.#guarded(async () => {
			const cwd = params.cwd ?? undefined;
			const cloud = await this.#env.connect(cwd ?? process.cwd());
			const page = await cloud.client.listThreadsPage({ limit: 50, before: params.cursor ?? undefined });
			const workspace = cloud.root ?? cwd;
			const threads = cwd === undefined ? page.threads : page.threads.filter(thread => thread.workspace === workspace);
			return {
				sessions: threads.map(thread => ({ sessionId: sessionIdOf(thread), cwd: thread.workspace || cwd || "", title: thread.name || thread.title, updatedAt: thread.lastActivityAt })),
				nextCursor: page.next,
			};
		});
	}

	prompt(params: PromptRequest): Promise<PromptResponse> {
		return this.#guarded(() => this.#session(params.sessionId).prompt(params.prompt));
	}

	cancel(params: { sessionId: string }): Promise<void> {
		return this.#guarded(() => this.#session(params.sessionId).cancel());
	}

	closeSession(params: CloseSessionRequest): CloseSessionResponse {
		this.#sessions.get(params.sessionId)?.dispose();
		this.#sessions.delete(params.sessionId);
		return {};
	}

	/** Ends every session's wait; the threads run on. */
	dispose(): void {
		for (const session of this.#sessions.values()) session.dispose();
		this.#sessions.clear();
	}

	async #guarded<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			throw toRequestError(error);
		}
	}

	#session(sessionId: string): AcpSession {
		const session = this.#sessions.get(sessionId);
		if (session === undefined) throw RequestError.resourceNotFound(sessionId);
		return session;
	}

	/** The cloud of `cwd`, once it is known to serve what the agent needs. */
	async #connect(cwd: string): Promise<{ cloud: CloudConnection; who: Whoami }> {
		const cloud = await this.#env.connect(cwd);
		const who = await cloud.client.whoami();
		for (const capability of NEEDED) await cloud.client.requireCapability(capability);
		return { cloud, who };
	}
}
