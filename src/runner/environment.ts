/**
 * Per-repository environments: a repository's `setup` script (`.omp-cloud.yml`) runs once in a throwaway VM, and that
 * VM's disk is kept as a vmon snapshot. A thread whose repository, template, script and cache files (lockfiles) hash to
 * the same key starts from the snapshot instead of the template, so its dependencies are already installed.
 */
import type { Sandbox, SandboxNetworkOpts } from "e2b";
import type { GitService } from "../git";
import { repoKeyOf } from "../secrets/store";
import type { Store } from "../store";
import type { EnvironmentRow, Thread, ThreadSetup } from "../store/types";
import type { Vmon } from "../vmon";
import { ExecError, sandboxExec, shellQuote } from "./exec";
import { uploadBlob, uploadComposedSource } from "./provision";
import { VM_WORKSPACE } from "./vm-layout";

/** The `app` metadata of the sandboxes environments are built in: apart from the thread VMs' `omp-cloud`, so the orphan sweep leaves a running build alone. */
export const ENV_APP = "omp-cloud-env";
/** A build sandbox older than this is left over from a service that died mid-build. */
export const ENV_SANDBOX_MAX_AGE_MS = 2 * 3600_000;
/** The most cached environments; the least useful are evicted past it. */
export const MAX_ENVIRONMENTS = 20;
/** How long a setup script may run. */
const SETUP_TIMEOUT_MS = 30 * 60_000;
/** The longest tail of the script's stderr a failure reports. */
const MAX_STDERR_CHARS = 500;

const HANDOFF_REF = "refs/omp-cloud/handoff";
const SETUP_SCRIPT = "/tmp/omp-cloud-setup.sh";
const SETUP_ENV = "/tmp/omp-cloud-setup.env";

/** What the environment of a thread is keyed by. */
export interface EnvironmentKeyInput {
	/** The template the setup runs on. */
	template: string;
	/** `repoKeyOf` of the thread's repository. */
	repo: string;
	/** The setup script. */
	run: string;
	/** The SHA-256 of each cache file at the handoff commit; null for a file the repository lacks. */
	files: Record<string, string | null>;
}

/** The SHA-256 (hex) of the template, repository, script and cache-file hashes (in path order): the same inputs always give the same key. */
export function environmentKey(input: EnvironmentKeyInput): string {
	const files = Object.entries(input.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return new Bun.CryptoHasher("sha256").update(JSON.stringify({ template: input.template, repo: input.repo, run: input.run, files })).digest("hex");
}

/** The name of the vmon snapshot of an environment: `omp-env-<first 16 hex of the key>`. */
export function environmentName(key: string): string {
	return `omp-env-${key.slice(0, 16)}`;
}

/** The rows to delete so that at most `keep` remain: those of another template first, then the oldest by last use. */
export function evictionOrder(rows: readonly EnvironmentRow[], template: string, keep: number): EnvironmentRow[] {
	const order = [...rows].sort((a, b) => {
		const stale = Number(b.template !== template) - Number(a.template !== template);
		if (stale !== 0) return stale;
		return a.lastUsedAt < b.lastUsedAt ? -1 : a.lastUsedAt > b.lastUsedAt ? 1 : 0;
	});
	return order.slice(0, Math.max(0, rows.length - keep));
}

/** Deletes the evictable environments (see {@link evictionOrder}): their snapshots, then their rows. A failure is logged and leaves the row for the next eviction. */
export async function evictEnvironments(store: Store, vmon: Pick<Vmon, "deleteSnapshot">, template: string, keep = MAX_ENVIRONMENTS): Promise<void> {
	for (const row of evictionOrder(store.environments(), template, keep)) {
		try {
			await vmon.deleteSnapshot(row.snapshotId);
			store.deleteEnvironment(row.key);
		} catch (error) {
			console.error(`omp-cloud: deleting the environment snapshot ${environmentName(row.key)} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** What building and finding environments needs of the service. */
export interface EnvironmentDeps {
	store: Store;
	vmon: Pick<Vmon, "create" | "kill" | "snapshot" | "deleteSnapshot">;
	git: Pick<GitService, "composeSource" | "fileHashes">;
	serviceId: string;
	/** How long a sandbox lives before vmon pauses it: the setup runs inside it. */
	sandboxTimeoutMs: number;
}

/** What `prepareEnvironment` needs besides the service. */
export interface PrepareInput {
	thread: Thread;
	/** The thread's repository setup (`thread.setup`, which is not null). */
	setup: ThreadSetup;
	/** The template the thread's VM would be created from. */
	template: string;
	/** The sandbox network of the thread's egress policy: the build runs under it too. */
	network: SandboxNetworkOpts | undefined;
	/** The service's secrets of the thread's repository: the setup script's environment. */
	secrets: Record<string, string>;
	/** Whether a build may start now: the thread's first VM. A later VM (a restore) only finds a cached environment. */
	mayBuild: boolean;
	/** Reports a `vm` event. */
	emit: (text: string) => void;
	/** Reports a `notice` event. */
	warn: (text: string) => void;
}

/** The snapshot a thread's VM starts from. */
export interface PreparedEnvironment {
	key: string;
	name: string;
	snapshotId: string;
}

/** Environments being built, per store: a thread that finds its key being built waits for it instead of building a second one. */
const building = new WeakMap<Store, Map<string, Promise<string>>>();

/**
 * The cached environment of the thread's setup, built first when there is none and `mayBuild`. Null when there is
 * nothing to start from (no cache and no build, or the build failed: said as a notice, the VM then starts from the
 * template). Never throws for a failed setup or an unreadable cache file; those become notices.
 */
export async function prepareEnvironment(deps: EnvironmentDeps, input: PrepareInput): Promise<PreparedEnvironment | null> {
	const { store } = deps;
	const { thread, setup, template } = input;
	let key: string;
	try {
		const files = await deps.git.fileHashes({
			threadId: thread.id,
			remoteURL: thread.repo.remoteURL,
			baseCommit: thread.repo.baseCommit,
			sourceBundle: (await store.blob(thread.id, "source.bundle")) === null ? null : store.blobPath(thread.id, "source.bundle"),
			commit: thread.repo.handoffCommit,
			paths: setup.cacheFiles,
		});
		key = environmentKey({ template, repo: repoKeyOf(thread.repo), run: setup.run, files });
	} catch (error) {
		input.warn(`the repository environment is not available: ${describe(error)}`);
		return null;
	}
	const name = environmentName(key);
	const cached = store.environment(key);
	if (cached !== null) {
		store.touchEnvironment(key);
		input.emit(`using the cached environment ${name}`);
		return { key, name, snapshotId: cached.snapshotId };
	}
	if (!input.mayBuild) return null;
	let pending = building.get(store)?.get(key);
	if (pending === undefined) {
		pending = buildEnvironment(deps, input, key, name).finally(() => building.get(store)?.delete(key));
		let builds = building.get(store);
		if (builds === undefined) {
			builds = new Map();
			building.set(store, builds);
		}
		builds.set(key, pending);
	} else {
		input.emit("waiting for the repository environment another thread is preparing");
	}
	try {
		return { key, name, snapshotId: await pending };
	} catch (error) {
		input.emit(`environment setup failed: ${describe(error)}`);
		return null;
	}
}

/**
 * Builds the environment `key` and returns its snapshot id: a sandbox of `template` (its `app` is {@link ENV_APP}, never
 * recorded as a VM), the repository's handoff commit checked out in the workspace, the setup script run there as the VM's
 * user with the repository's secrets in its environment, and the disk snapshotted. The sandbox is killed either way.
 * Throws with `exit <code>: <the end of stderr>` when the script fails.
 */
async function buildEnvironment(deps: EnvironmentDeps, input: PrepareInput, key: string, name: string): Promise<string> {
	const { store, vmon } = deps;
	const { thread } = input;
	input.emit("preparing the repository environment (setup in .omp-cloud.yml)");
	const sandbox = await vmon.create(input.template, { app: ENV_APP, service: deps.serviceId, key }, deps.sandboxTimeoutMs + SETUP_TIMEOUT_MS, input.network);
	try {
		await runSetup(deps, sandbox, input);
		const snapshotId = await vmon.snapshot(sandbox, name);
		const previous = store.environment(key);
		store.putEnvironment({ key, snapshotId, template: input.template, repo: repoKeyOf(thread.repo) });
		if (previous !== null && previous.snapshotId !== snapshotId) await vmon.deleteSnapshot(previous.snapshotId).catch(() => undefined);
		input.emit(`environment ready (${name})`);
		await evictEnvironments(store, vmon, input.template);
		return snapshotId;
	} finally {
		try {
			await vmon.kill(sandbox.sandboxId);
		} catch (error) {
			console.error(`omp-cloud: killing the environment sandbox ${sandbox.sandboxId} failed: ${describe(error)}`);
		}
	}
}

/** Puts the repository into `sandbox` and runs the thread's setup script in it. */
async function runSetup(deps: EnvironmentDeps, sandbox: Sandbox, input: PrepareInput): Promise<void> {
	const { thread } = input;
	const exec = sandboxExec(sandbox);
	const q = shellQuote;
	const ws = q(VM_WORKSPACE);
	const transfer = (await exec("mktemp -d")).trim();
	try {
		const bundle = `${transfer}/source.bundle`;
		if (thread.repo.baseCommit === "") {
			const source = await deps.store.blob(thread.id, "source.bundle");
			if (source === null) throw new Error("the thread has no source bundle");
			await uploadBlob(sandbox, source, bundle);
		} else {
			await uploadComposedSource(sandbox, { thread, git: deps.git }, bundle);
		}
		await exec(`git init -q ${ws}`);
		await exec(`git -C ${ws} fetch -q ${q(bundle)} +${HANDOFF_REF}:${HANDOFF_REF}`);
		await exec(`git -C ${ws} checkout -q -f --detach ${HANDOFF_REF}`);
	} finally {
		await exec(`rm -rf ${q(transfer)}`).catch(() => undefined);
	}
	const lines = Object.entries(input.secrets).map(([secret, value]) => `${secret}=${q(value)}\n`);
	await sandbox.files.write(SETUP_ENV, lines.join(""));
	await exec(`chmod 600 ${q(SETUP_ENV)}`);
	await sandbox.files.write(SETUP_SCRIPT, `set -e\n${input.setup.run}\n`);
	const command = `set -a; . ${q(SETUP_ENV)}; set +a; rm -f ${q(SETUP_ENV)}; exec bash ${q(SETUP_SCRIPT)}`;
	try {
		await exec(`bash -c ${q(command)}`, { cwd: VM_WORKSPACE, timeoutMs: SETUP_TIMEOUT_MS });
	} catch (error) {
		if (error instanceof ExecError) throw new Error(`exit ${error.exitCode}: ${error.stderr.trim().slice(-MAX_STDERR_CHARS)}`);
		throw error;
	} finally {
		await exec(`rm -f ${q(SETUP_ENV)} ${q(SETUP_SCRIPT)}`).catch(() => undefined);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
