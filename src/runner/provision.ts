import { randomBytes } from "node:crypto";
import type { Sandbox } from "e2b";
import type { ModelsConfig } from "../config";
import type { GitService } from "../git";
import { isRecord } from "../guards";
import { parseMcpServers } from "../connectors/mcp-servers";
import { sha256Hex } from "../pairing/secrets";
import type { ServiceSecrets } from "../secrets/store";
import { MAX_SOURCE_BYTES } from "../server/limits";
import type { Store } from "../store";
import { type BlobName, RESULT_BRANCH_PREFIX, type Thread, type ThreadSecrets } from "../store/types";
import { ExecError, sandboxExec, shellQuote } from "./exec";
import { type MaskEntry, maskEntries } from "./mask";
import { applyResultBundle, restoreRepo } from "./git";
import ircPeerSource from "./vm-extension/irc-peer" with { type: "text" };
import { cloudSystemPrompt, modelsYaml, type OverlayPolicy, overlayConfigYaml } from "./omp-config";
import { ircConfigJson, parentIdentity } from "./irc";
import { reidentifySession } from "./session-export";
import { VM_AGENT_DIR, VM_CLOUD_DIR, VM_ENV_FILE, VM_IRC_CONFIG, VM_IRC_EXTENSION, VM_WORKSPACE } from "./vm-layout";

const OVERLAY_FILE = `${VM_CLOUD_DIR}/config.yml`;
const SYSTEM_PROMPT_FILE = `${VM_CLOUD_DIR}/system-prompt.md`;
/** omp's secret obfuscation list, read when the overlay sets `secrets.enabled`. */
const MASK_FILE = `${VM_AGENT_DIR}/secrets.yml`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;


export interface ProvisionInput {
	thread: Thread;
	store: Store;
	/** Composes the full-history bundle of a delta thread. */
	git: Pick<GitService, "composeSource">;
	gatewayUrl: string;
	/** The thread's gateway client token. Reaches the VM only through `files.write`. */
	token: string;
	models: ModelsConfig;
	/** The providers the gateway serves now: `models.yml` lists each. */
	served: string[];
	questionTimeoutSeconds: number;
	/** The thread's effective policy at provision time (the owner's settings tightened by the thread's own): what the overlay enforces inside the VM. */
	policy: OverlayPolicy;
	/** The service's secrets that match the thread's repository (`ServiceSecrets.resolveForThread`); the thread's own `secretEnv` wins over them. */
	serviceEnv: Record<string, string>;
	/** `<ip>:<port>` of the listening MCP proxy the VM's http MCP servers go through; null when there is none. */
	mcpListen: string | null;
}

/** What `provisionVm` leaves for the runner to start omp with: `envNames` are the variables of the env file omp is started under (names only). */
export interface Provisioned {
	extraArgs: string[];
	envNames: string[];
	/** The MCP servers written to the VM's mcp.json, and the http ones left out because the service has no proxy. */
	mcpNames: string[];
	mcpSkipped: string[];
}

/**
 * The omp args of a thread: `--config <overlay>` for each overlay the session shipped, in order, then the
 * service's own `--config <overlay>` (so it wins), `--append-system-prompt <file>`, `-e <the IRC extension>`, `--model`
 * (the thread's, else `models.default`), `--thinking` when the thread sets it and `--resume <resumeFile>` when given.
 */
export function ompLaunchArgs(thread: Thread, models: ModelsConfig, resumeFile: string | null): string[] {
	const args = [
		...thread.configOverlays.flatMap(overlay => ["--config", `${VM_AGENT_DIR}/${overlay}`]),
		"--config",
		OVERLAY_FILE,
		"--append-system-prompt",
		SYSTEM_PROMPT_FILE,
		"-e",
		VM_IRC_EXTENSION,
		"--model",
		thread.model || models.default,
	];
	if (thread.thinking !== "") args.push("--thinking", thread.thinking);
	if (resumeFile !== null) args.push("--resume", resumeFile);
	return args;
}

/** Writes the IRC extension (the file `ompLaunchArgs` names) and the thread's parent identity into the VM. */
export async function shipIrcExtension(sandbox: Sandbox, thread: Thread): Promise<void> {
	// The import is a text module; a bundler that ignored the attribute would hand over the extension's code instead.
	if (typeof ircPeerSource !== "string") throw new Error("the IRC extension was not embedded as text");
	await sandbox.files.write(VM_IRC_EXTENSION, ircPeerSource);
	await sandbox.files.write(VM_IRC_CONFIG, ircConfigJson(thread));
}


/** Uploads a store blob into the sandbox by streaming. */
export async function uploadBlob(sandbox: Sandbox, file: Bun.BunFile, path: string): Promise<void> {
	await sandbox.files.write(path, file.stream());
}

/** Streams a sandbox file into a store blob; returns its size. Throws `StoreError` "too_large" past `maxBytes`. */
export async function downloadBlob(
	sandbox: Sandbox,
	path: string,
	store: Store,
	threadId: string,
	name: BlobName,
	maxBytes: number,
): Promise<number> {
	const stream = await sandbox.files.read(path, { format: "stream" });
	return store.putBlob(threadId, name, stream, maxBytes);
}

/** Parses the `secrets.json` blob. */
function parseSecrets(text: string): ThreadSecrets {
	const bad = () => new Error("secrets.json is malformed");
	const raw: unknown = JSON.parse(text);
	if (!isRecord(raw) || !Array.isArray(raw.files) || !isRecord(raw.env)) throw bad();
	const files = raw.files.map(entry => {
		if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.content !== "string") throw bad();
		return { path: entry.path, content: entry.content };
	});
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw.env)) {
		if (typeof value !== "string" || !ENV_NAME.test(name)) throw bad();
		env[name] = value;
	}
	return { files, env, mcp: parseMcpServers(raw.mcp) };
}

/** The thread's own secret files, env and MCP servers from its stored `secrets.json`; null when it has none. Throws when the blob is missing or malformed. */
async function readThreadSecrets(store: Store, thread: Thread): Promise<ThreadSecrets | null> {
	if (thread.secretFiles.length === 0 && thread.secretEnv.length === 0 && thread.mcpServers.length === 0) return null;
	const blob = await store.blob(thread.id, "secrets.json");
	if (blob === null) throw new Error("the thread's secrets.json is missing");
	return parseSecrets(await blob.text());
}

/**
 * Every secret value the service delivered to the thread's VM, as `provisionVm` masks them: its own secret env and
 * files plus the service Secrets that match it (the thread's own env wins over the service's). Throws when they cannot be read.
 */
export async function threadMaskEntries(store: Store, service: Pick<ServiceSecrets, "resolveForThread">, thread: Thread): Promise<MaskEntry[]> {
	const own = await readThreadSecrets(store, thread);
	const { env } = await service.resolveForThread(thread);
	return maskEntries({ ...env, ...own?.env }, own?.files ?? []);
}

/** Escapes the characters that are special in a gitignore pattern. */
function escapeIgnore(path: string): string {
	return path.replace(/[\\*?[]/g, match => `\\${match}`);
}

/** Uploads the service's full-history bundle of a delta thread: the cache's base plus the uploaded delta. */
export async function uploadComposedSource(sandbox: Sandbox, input: Pick<ProvisionInput, "thread" | "git">, dest: string): Promise<void> {
	const { thread } = input;
	const composed = await input.git.composeSource(thread.id, thread.repo.remoteURL);
	try {
		const file = Bun.file(composed.path);
		if (file.size > MAX_SOURCE_BYTES) {
			throw new Error(`the full history of ${thread.repo.name} is ${Math.ceil(file.size / 1024 ** 2)} MB, over the ${MAX_SOURCE_BYTES / 1024 ** 2} MB limit`);
		}
		await uploadBlob(sandbox, file, dest);
	} finally {
		await composed.release();
	}
}

/**
 * Everything before omp starts: the setup tarball, `models.yml`, the config overlay and system prompt, the
 * repository, secret files and the env file, and the unpacked conversation. Commands run as the sandbox's default
 * user. Every new VM (a lost one's replacement too) restores the newest state of the thread. The repository: a
 * full-history thread restores from its source bundle, a delta thread (`repo.baseCommit`) from the full-history bundle
 * the service composes, then the stored `result.bundle` is applied up to the archive snapshot's head (`thread.restoreHead`)
 * when the bundle holds it, else up to the last completed turn's head (a bundle of a thread with neither head is ignored). The conversation:
 * the newest `session-export.tar`, re-identified so that the live session does not carry the export id, else the
 * `session.tar` the thread was created with. Throws for a full-history thread without a source bundle, a delta thread
 * the git cache no longer holds, or a result bundle that does not contain the last turn's head; git and tar failures
 * throw `ExecError`; a conversation that does not unpack throws `Error` "the conversation did not unpack: <reason>"; an
 * overlay the shipped setup lacks throws `Error` "the overlay <path> is not in the shipped setup".
 */
export async function provisionVm(sandbox: Sandbox, input: ProvisionInput): Promise<Provisioned> {
	const { thread, store, models } = input;
	const source = thread.repo.baseCommit === "" ? await store.blob(thread.id, "source.bundle") : null;
	if (thread.repo.baseCommit === "" && source === null) throw new Error("the thread has no source bundle");
	const setup = await store.blob(thread.id, "setup.tar.gz");
	const session = await store.blob(thread.id, "session.tar");
	const exported = await store.blob(thread.id, "session-export.tar");
	const resultHead = store.threadStats(thread.id).resultTurn?.head ?? "";
	// An archive snapshot's head, when it is past the last turn's. Without either head the bundle holds nothing the thread restores to.
	const restoreHead = thread.restoreHead;
	// A bundle without a recorded head was stored by a turn that never completed: the thread restores at the handoff commit.
	const result = resultHead === "" && restoreHead === "" ? null : await store.blob(thread.id, "result.bundle");
	const secrets = await readThreadSecrets(store, thread);
	// The thread's own values win over the service's.
	const env = { ...input.serviceEnv, ...secrets?.env };
	const maskSecrets = Object.keys(env).length > 0 || (secrets?.files.length ?? 0) > 0;
	const mcpNames: string[] = [];
	const mcpSkipped: string[] = [];

	const exec = sandboxExec(sandbox);
	const q = shellQuote;
	const branch = `${RESULT_BRANCH_PREFIX}${thread.id}`;
	const model = thread.model || models.default;
	const routable = [...input.served, ...Object.keys(models.direct)];
	let resumeFile: string | null = null;

	await exec(`mkdir -p ${q(VM_AGENT_DIR)} ${q(VM_CLOUD_DIR)}`);
	const transfer = (await exec("mktemp -d")).trim();
	try {
		if (setup !== null) {
			const tgz = `${transfer}/setup.tar.gz`;
			await uploadBlob(sandbox, setup, tgz);
			await exec(`tar -xzf ${q(tgz)} -C ${q(VM_AGENT_DIR)} --no-same-owner && rm -f ${q(tgz)}`);
		}

		for (const overlay of thread.configOverlays) {
			if (!(await sandbox.files.exists(`${VM_AGENT_DIR}/${overlay}`))) throw new Error(`the overlay ${overlay} is not in the shipped setup`);
		}

		// After the setup tarball, so these win over anything it shipped.
		const modelsFile = `${VM_AGENT_DIR}/models.yml`;
		await sandbox.files.write(
			modelsFile,
			modelsYaml({ gatewayUrl: input.gatewayUrl, token: input.token, gateway: input.served, direct: models.direct }),
		);
		await exec(`chmod 600 ${q(modelsFile)}`);
		// The MCP servers the thread ships: http ones through the service's proxy under a per-provisioning token (the upstream headers stay on the service), stdio ones as they are.
		if (thread.mcpServers.length > 0) {
			const servers: Record<string, unknown> = {};
			let mcpToken = "";
			for (const server of secrets?.mcp ?? []) {
				if (server.type === "stdio") {
					servers[server.name] = { command: server.command, args: server.args, env: server.env, ...(server.cwd === undefined ? {} : { cwd: server.cwd }) };
				} else if (input.mcpListen === null) {
					mcpSkipped.push(server.name);
					continue;
				} else {
					mcpToken ||= randomBytes(32).toString("base64url");
					servers[server.name] = { type: "http", url: `http://${input.mcpListen}/mcp/${server.name}`, headers: { Authorization: `Bearer ${mcpToken}` } };
				}
				mcpNames.push(server.name);
			}
			if (mcpToken !== "") store.setMcpToken(thread.id, sha256Hex(mcpToken));
			if (mcpNames.length > 0) {
				const mcpFile = `${VM_AGENT_DIR}/mcp.json`;
				await sandbox.files.write(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2));
				await exec(`chmod 600 ${q(mcpFile)}`);
			}
		}
		await shipIrcExtension(sandbox, thread);

		const configFiles = [`${VM_AGENT_DIR}/config.yml`, ...thread.configOverlays.map(overlay => `${VM_AGENT_DIR}/${overlay}`)];
		const configYamls: (string | null)[] = [];
		for (const file of configFiles) configYamls.push((await sandbox.files.exists(file)) ? await sandbox.files.read(file) : null);
		await sandbox.files.write(
			OVERLAY_FILE,
			overlayConfigYaml({ model, thinking: thread.thinking, configYamls, routable, policy: input.policy, maskSecrets }),
		);
		await sandbox.files.write(
			SYSTEM_PROMPT_FILE,
			cloudSystemPrompt({
				repoName: thread.repo.name,
				branch,
				localBranch: thread.repo.localBranch,
				questionTimeoutSeconds: input.questionTimeoutSeconds,
				secretFiles: thread.secretFiles,
				mcpServers: mcpNames,
				parentId: parentIdentity(thread).id,
			}),
		);

		const bundle = `${transfer}/source.bundle`;
		if (source === null) await uploadComposedSource(sandbox, input, bundle);
		else await uploadBlob(sandbox, source, bundle);
		await restoreRepo(exec, {
			workspace: VM_WORKSPACE,
			bundlePath: bundle,
			branch,
			handoffCommit: thread.repo.handoffCommit,
			author: thread.author,
			remoteURL: thread.repo.remoteURL,
		});
		await exec(`rm -f ${q(bundle)}`);
		if (result !== null) {
			const resultBundle = `${transfer}/result.bundle`;
			await uploadBlob(sandbox, result, resultBundle);
			// The archive snapshot's head when the stored bundle holds it, else the last completed turn's head.
			if (restoreHead !== "") {
				try {
					await applyResultBundle(exec, { workspace: VM_WORKSPACE, bundlePath: resultBundle, branch, head: restoreHead });
				} catch (error) {
					if (error instanceof ExecError) throw error;
					if (resultHead !== "") await applyResultBundle(exec, { workspace: VM_WORKSPACE, bundlePath: resultBundle, branch, head: resultHead });
				}
			} else {
				await applyResultBundle(exec, { workspace: VM_WORKSPACE, bundlePath: resultBundle, branch, head: resultHead });
			}
			await exec(`rm -f ${q(resultBundle)}`);
		}

		if (secrets !== null) {
			const exclude: string[] = [];
			for (const file of secrets.files) {
				const target = `${VM_WORKSPACE}/${file.path}`;
				// The checked-out repository may hold symlinks: the file must land inside the workspace.
				const resolved = (await exec(`realpath -m -- ${q(target)}`)).trim();
				if (!resolved.startsWith(`${VM_WORKSPACE}/`) || resolved.startsWith(`${VM_WORKSPACE}/.git/`)) {
					throw new Error(`secret file ${file.path} resolves outside the workspace`);
				}
				await sandbox.files.write(target, new Blob([Buffer.from(file.content, "base64")]));
				await exec(`chmod 600 ${q(target)}`);
				exclude.push(`/${escapeIgnore(file.path)}`);
			}
			if (exclude.length > 0) {
				const lines = exclude.map(q).join(" ");
				await exec(`mkdir -p .git/info && printf '%s\\n' ${lines} >> .git/info/exclude`, { cwd: VM_WORKSPACE });
			}
		}

		if (Object.keys(env).length > 0) {
			const lines = Object.entries(env).map(([name, value]) => `${name}=${q(value)}\n`);
			await sandbox.files.write(VM_ENV_FILE, lines.join(""));
			await exec(`chmod 600 ${q(VM_ENV_FILE)}`);
		}
		if (maskSecrets) {
			const masks = maskEntries(env, secrets?.files ?? []).map(entry => entry.value);
			await sandbox.files.write(MASK_FILE, Bun.YAML.stringify(masks.map(content => ({ type: "plain", content, mode: "obfuscate" })), null, 2));
			await exec(`chmod 600 ${q(MASK_FILE)}`);
		}

		const conversation = exported ?? session;
		if (conversation !== null) {
			let tar = `${transfer}/session.tar`;
			await uploadBlob(sandbox, conversation, tar);
			if (exported !== null) {
				const restored = `${transfer}/session-restored.tar`;
				await reidentifySession(exec, { archive: tar, outPath: restored, sessionId: crypto.randomUUID() });
				tar = restored;
			}
			let out: string;
			try {
				out = await exec(`omp session unpack ${q(tar)} --cwd ${q(VM_WORKSPACE)}`);
			} catch (error) {
				if (!(error instanceof ExecError)) throw error;
				const reason = error.stderr.trim().split("\n").at(-1)?.trim().slice(0, 200) || `exit ${error.exitCode}`;
				throw new Error(`the conversation did not unpack: ${reason}`);
			}
			const last = out.split("\n").map(line => line.trim()).filter(line => line !== "").at(-1);
			if (last === undefined) throw new Error("the conversation did not unpack: omp session unpack printed no session file");
			resumeFile = last;
		}
	} finally {
		await exec(`rm -rf ${q(transfer)}`).catch(() => undefined);
	}

	return { extraArgs: ompLaunchArgs(thread, models, resumeFile), envNames: Object.keys(env).sort(), mcpNames, mcpSkipped };
}
