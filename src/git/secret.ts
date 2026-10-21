/** Secret references: a `!command` whose output is the secret, resolved in memory only. */

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** A secret that could not be resolved. The message names the label and the cause, never the command's output. */
export class SecretError extends Error {
	override name = "SecretError";
}

interface Entry {
	value: Promise<string>;
	expiresAt: number;
}

export interface SecretRefsOptions {
	/** How long a resolved secret is reused. */
	ttlMs?: number;
	/** The longest a command may run. */
	timeoutMs?: number;
	/** Test seam: the clock. */
	now?: () => number;
}

/**
 * Resolves `!<command>` references with `/bin/sh -c` in its own process group, like omp does for its own settings. On a
 * timeout the whole group is killed, so a command's children do not outlive it. The trimmed stdout is the secret; it
 * must be one line of printable text. Results are kept in memory for the TTL and never logged; a failed resolution is
 * not cached, and its error never carries the command's stdout or stderr.
 */
export class SecretRefs {
	readonly #ttlMs: number;
	readonly #timeoutMs: number;
	readonly #now: () => number;
	readonly #cache = new Map<string, Entry>();

	constructor(options: SecretRefsOptions = {}) {
		this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#now = options.now ?? Date.now;
	}

	/** The secret `ref` (`!command`) stands for; `label` names it in errors. Throws `SecretError`. */
	resolve(ref: string, label: string): Promise<string> {
		const hit = this.#cache.get(ref);
		if (hit !== undefined && hit.expiresAt > this.#now()) return hit.value;
		if (!ref.startsWith("!") || ref.length < 2) {
			return Promise.reject(new SecretError(`the credential of ${label} is not a "!command" secret reference`));
		}
		const value = this.#run(ref.slice(1), label);
		const entry: Entry = { value, expiresAt: this.#now() + this.#ttlMs };
		this.#cache.set(ref, entry);
		value.catch(() => {
			if (this.#cache.get(ref) === entry) this.#cache.delete(ref);
		});
		return value;
	}

	async #run(command: string, label: string): Promise<string> {
		const proc = Bun.spawn(["/bin/sh", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				try {
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					proc.kill("SIGKILL");
				}
				reject(new SecretError(`the credential command of ${label} timed out after ${this.#timeoutMs / 1000} s`));
			}, this.#timeoutMs);
		});
		try {
			const [stdout, code] = await Promise.race([Promise.all([proc.stdout.text(), proc.exited]), timeout]);
			if (code !== 0) throw new SecretError(`the credential command of ${label} failed (exit ${code})`);
			const secret = stdout.trim();
			if (secret === "") throw new SecretError(`the credential command of ${label} printed nothing`);
			if (!/^[\x20-\x7e]+$/.test(secret)) {
				throw new SecretError(`the credential command of ${label} must print one line of printable text`);
			}
			return secret;
		} finally {
			clearTimeout(timer);
		}
	}
}
