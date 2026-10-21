import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import type { ClientTuning } from "../src/api";
import type { Env } from "../src/config";
import { syncConversation, type SyncInput, type SyncOutcome } from "../src/session-sync";
import { git } from "../src/snapshot";

/** The clients' retry schedule in tests that build a `Cloud`: the production attempts, a millisecond apart. */
export const FAST_RETRY: ClientTuning = { backoffMs: [1, 1, 1], random: () => 0.5 };

// Isolate every git call from the developer's own configuration.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

const dirs: string[] = [];

export async function tmp(prefix = "omp-cloud-test-"): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

export interface OmpHome {
	agentDir: string;
	/** The sessions root omp's `session unpack` writes into under this home. */
	sessionsRoot: string;
	/** Environment for omp children: a throwaway agent dir and HOME. */
	env: Env;
}

/** A throwaway omp home, so `omp session pack/unpack` never touch the developer's `~/.omp`. */
export async function ompHome(): Promise<OmpHome> {
	const agentDir = await tmp("omp-cloud-agent-");
	const home = await tmp("omp-cloud-home-");
	return {
		agentDir,
		sessionsRoot: join(agentDir, "sessions"),
		env: { PI_CODING_AGENT_DIR: agentDir, HOME: home, PI_CONFIG_DIR: undefined, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined, XDG_CACHE_HOME: undefined },
	};
}

/** `syncConversation` into an isolated omp home; the lease is a no-op unless a test injects its own. */
export function syncInto(home: OmpHome, archive: string, cwd: string, over: Partial<SyncInput> = {}): Promise<SyncOutcome> {
	return syncConversation({ archive, cwd, current: undefined, env: home.env, sessionsRoot: home.sessionsRoot, claim: () => () => {}, fork: true, ...over });
}

const OMP_ENV = ["PI_CONFIG_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "PI_CODING_AGENT_DIR"] as const;
let isolated: { env: (readonly [string, string | undefined])[]; agentDir: string } | undefined;

function restoreEnv(env: readonly (readonly [string, string | undefined])[]): void {
	for (const [key, value] of env) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/**
 * Stands a temp tree in for `~/.omp` until `cleanup`. omp fixes its agent dir, plugins and extension directories
 * when its modules load, so a test that lets omp discover extensions would otherwise read the developer's own: this
 * moves the config root (`PI_CONFIG_DIR`, relative to the home directory), switches off XDG redirection and
 * re-resolves with `setAgentDir`.
 */
export async function isolateOmp(): Promise<{ root: string; configRoot: string; agentDir: string }> {
	isolated ??= { env: OMP_ENV.map(key => [key, process.env[key]] as const), agentDir: getAgentDir() };
	const root = await tmp("omp-cloud-omp-");
	const configRoot = join(root, ".omp");
	const agentDir = join(configRoot, "agent");
	process.env.PI_CONFIG_DIR = relative(homedir(), configRoot);
	for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = join(root, "xdg");
	setAgentDir(agentDir);
	await mkdir(agentDir, { recursive: true });
	return { root, configRoot, agentDir };
}

export async function cleanup(): Promise<void> {
	if (isolated) {
		restoreEnv(isolated.env);
		setAgentDir(isolated.agentDir);
		restoreEnv(isolated.env);
		isolated = undefined;
	}
	await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
}

export async function configureRepo(dir: string): Promise<void> {
	await git(dir, ["config", "user.name", "Test User"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "commit.gpgsign", "false"]);
}

export async function commitFile(dir: string, path: string, content: string, msg = `add ${path}`): Promise<string> {
	await mkdir(join(dir, path, ".."), { recursive: true });
	await writeFile(join(dir, path), content);
	await git(dir, ["add", "--", path]);
	await git(dir, ["commit", "-q", "-m", msg]);
	return git(dir, ["rev-parse", "HEAD"]);
}

export const REMOTE_URL = "http://git.example.test/app.git";

export interface Fixture {
	root: string;
	bare: string;
	work: string;
	/** The commit the remote's main branch points at. */
	base: string;
}

/**
 * A bare "remote" and a clone of it whose origin URL is an http URL (resolved to
 * the bare repo through insteadOf), with `main` pushed and upstream set.
 */
export async function remoteFixture(): Promise<Fixture> {
	const root = await tmp();
	const bare = join(root, "origin.git");
	const work = join(root, "work");
	await git(root, ["init", "-q", "--bare", "-b", "main", bare]);
	await git(root, ["init", "-q", "-b", "main", work]);
	await configureRepo(work);
	await git(work, ["config", `url.${bare}.insteadOf`, REMOTE_URL]);
	await git(work, ["remote", "add", "origin", REMOTE_URL]);
	await commitFile(work, "a.txt", "one\n");
	await commitFile(work, ".gitignore", ".env\n");
	await git(work, ["push", "-q", "-u", "origin", "main"]);
	const base = await git(work, ["rev-parse", "HEAD"]);
	return { root, bare, work, base };
}
