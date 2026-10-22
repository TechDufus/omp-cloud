/**
 * The service's secret store: environment values the owner configures once on the service, each scoped to the repositories
 * (globs) whose threads receive it. A thread's VM gets the secrets that match its repository, as env variables of the
 * file omp is started under; nothing else of the store reaches a VM. Values are never served by the API.
 */
import { globMatch } from "../git/glob";
import { remoteKeyOf } from "../git/remote";
import { SecretError, SecretRefs } from "../git/secret";
import { checkEnvName } from "../server/create-request";
import type { Store } from "../store";
import type { SecretSummary, Thread } from "../store/types";

const MAX_NAME_CHARS = 128;
export const MAX_SECRET_VALUE_CHARS = 65536;
const MAX_REPOS = 50;
const MAX_REPO_GLOB_CHARS = 200;

/** A secret the owner submitted that the store refuses; the message says why and is fit for a 400. */
export class SecretInputError extends Error {
	override name = "SecretInputError";
}

/**
 * The key a thread's repository glob is matched against: `<host>/<path>` of its remote URL without `.git`, lower-case
 * (`github.com/techdufus/omp-cloud`), or `local/<repo.name>` when it has no remote.
 */
export function repoKeyOf(repo: Thread["repo"]): string {
	if (repo.remoteURL === "") return `local/${repo.name}`.toLowerCase();
	return remoteKeyOf(repo.remoteURL) ?? repo.remoteURL.toLowerCase();
}

/** The validated list of repository globs, or throws {@link SecretInputError}. */
function parseRepos(raw: unknown): string[] {
	if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
		throw new SecretInputError("repos is required: list the repositories (globs) the secret goes to, * for all");
	}
	if (!Array.isArray(raw)) throw new SecretInputError("repos must be an array of strings");
	if (raw.length > MAX_REPOS) throw new SecretInputError(`repos has ${raw.length} entries; at most ${MAX_REPOS}`);
	const repos: string[] = [];
	for (const [i, glob] of raw.entries()) {
		if (typeof glob !== "string" || glob === "" || glob.length > MAX_REPO_GLOB_CHARS || /\s/.test(glob)) {
			throw new SecretInputError(`repos[${i}] must be 1 to ${MAX_REPO_GLOB_CHARS} characters without whitespace`);
		}
		if (!repos.includes(glob)) repos.push(glob);
	}
	return repos;
}

/** The secrets of the service, over the `secrets` table. */
export class ServiceSecrets {
	readonly #store: Store;
	readonly #refs: SecretRefs;

	constructor(store: Store, refs: SecretRefs = new SecretRefs()) {
		this.#store = store;
		this.#refs = refs;
	}

	/** Every secret without its value, in name order. */
	list(): SecretSummary[] {
		return this.#store.listSecrets();
	}

	/** Validates and stores the secret `name` (inserting or replacing it); `actor` is who the store records. Throws {@link SecretInputError}. */
	put(name: string, input: { value: unknown; repos: unknown }, actor: string): SecretSummary {
		if (name.length > MAX_NAME_CHARS) throw new SecretInputError(`secret name is longer than ${MAX_NAME_CHARS} characters`);
		const reason = checkEnvName(name);
		if (reason !== "") throw new SecretInputError(`secret name ${name} ${reason}`);
		const repos = parseRepos(input.repos);
		const { value } = input;
		if (typeof value !== "string" || value === "" || value.length > MAX_SECRET_VALUE_CHARS || value.includes("\0")) {
			throw new SecretInputError(`value must be 1 to ${MAX_SECRET_VALUE_CHARS} characters of text`);
		}
		if (value === "!") throw new SecretInputError('value "!" is not a command: write "!<command>" or a literal');
		this.#store.putSecret({ name, value, repos }, actor);
		const stored = this.list().find((secret) => secret.name === name);
		if (stored === undefined) throw new Error(`secret ${name} was not stored`);
		return stored;
	}

	/** False when no secret has this name. */
	delete(name: string): boolean {
		return this.#store.deleteSecret(name);
	}

	/**
	 * The secrets whose repository globs match the thread's {@link repoKeyOf}, as env. A `!command` value is resolved
	 * (one service-wide cache); one that fails is left out and reported in `failures` as a notice text, never with the
	 * command's output.
	 */
	async resolveForThread(thread: Thread): Promise<{ env: Record<string, string>; failures: string[] }> {
		const key = repoKeyOf(thread.repo);
		const env: Record<string, string> = {};
		const failures: string[] = [];
		for (const secret of this.#store.secretRows()) {
			if (!secret.repos.some((glob) => globMatch(glob.toLowerCase(), key))) continue;
			if (!secret.value.startsWith("!")) {
				env[secret.name] = secret.value;
				continue;
			}
			try {
				env[secret.name] = await this.#refs.resolve(secret.value, `secret ${secret.name}`);
			} catch (error) {
				if (!(error instanceof SecretError)) throw error;
				failures.push(`secret ${secret.name} was not delivered: ${error.message}`);
			}
		}
		return { env, failures };
	}
}
