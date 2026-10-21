/**
 * Read-only views of a thread's repository for `GET /threads/{id}/diff|tree|files`: a scratch bare repository that
 * holds the thread's base objects and its stored result bundle (built by `GitService.inspect`), read with git under
 * a deadline. Everything here is bounded: a diff is cut at the caller's byte limit, a listing at its entry limit and a
 * file page at its limit, and git is stopped as soon as it has produced enough.
 */

/** Every git command of an inspection gets this long. */
const COMMAND_TIMEOUT_MS = 60_000;
/** The most stdout a command whose whole output is needed (`ok`) may produce. */
const MAX_COLLECTED_BYTES = 32 * 1024 ** 2;
/** git treats a file as binary when a NUL is among its first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;
/** The most files `stat` lists; the totals still count every file. */
export const MAX_STAT_FILES = 5000;
/** A full 40 (SHA-1) or 64 (SHA-256) digit object name: the only revision an inspection accepts. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Why an inspection could not start: `base` the thread's base commit is not available (the git cache lost it, or the
 * source bundle is gone), `result` the stored result bundle cannot be read.
 */
export class InspectError extends Error {
	constructor(
		readonly code: "base" | "result",
		message: string,
	) {
		super(message);
		this.name = "InspectError";
	}
}

export interface DiffFile {
	path: string;
	status: "A" | "M" | "D" | "R";
	insertions: number;
	deletions: number;
}

/** The files between two commits; `truncated` when more than MAX_STAT_FILES changed (the totals count all of them). */
export interface DiffStat {
	files: DiffFile[];
	insertions: number;
	deletions: number;
	truncated: boolean;
}

/** A diff cut at `maxBytes`; `length` is the full size in bytes. */
export interface DiffText {
	bytes: Buffer;
	length: number;
}

export interface TreeEntry {
	path: string;
	type: "file" | "dir";
	size: number;
}

export interface TreeListing {
	entries: TreeEntry[];
	truncated: boolean;
}

/** One page of a file: `offset` and `next` are byte offsets; `text` is whole UTF-8 characters. */
export interface FileSlice {
	size: number;
	binary: boolean;
	offset: number;
	text: string;
	next: number | null;
}

interface TreeRecord {
	mode: string;
	type: string;
	oid: string;
	size: number;
	path: string;
}

interface Outcome {
	code: number;
	stderr: string;
	/** The consumer stopped reading and git was killed. */
	stopped: boolean;
}

const TREE_RECORD = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+) +(-|\d+)\t([\s\S]*)$/;
const NUMSTAT_RECORD = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

function treeRecord(text: string): TreeRecord {
	const match = TREE_RECORD.exec(text);
	if (match === null) throw new Error(`unexpected git ls-tree output: ${JSON.stringify(text.slice(0, 80))}`);
	return { mode: match[1] ?? "", type: match[2] ?? "", oid: match[3] ?? "", size: match[4] === "-" ? 0 : Number(match[4]), path: match[5] ?? "" };
}

/** A UTF-8 continuation byte (10xxxxxx): it belongs to a character that started earlier. */
function continuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** Reads one inspection repository. Build it through `GitService.inspect`. */
export class Inspection {
	readonly #git: string;
	readonly #repo: string;
	readonly #env: Record<string, string>;

	constructor(git: string, repo: string, home: string) {
		this.#git = git;
		this.#repo = repo;
		this.#env = {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: home,
			LC_ALL: "C",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		};
	}

	/** Whether the repository holds the commit `name` (a full object name). */
	async has(name: string): Promise<boolean> {
		if (!OBJECT_NAME.test(name)) return false;
		return (await this.#stream(["cat-file", "-e", `${name}^{commit}`], () => true)).code === 0;
	}

	/** The files and line counts between `from` and `to`, limited to `path` (`""` for all of them). Renames are detected. */
	async stat(from: string, to: string, path: string): Promise<DiffStat> {
		this.#requireCommits(from, to);
		const scope = path === "" ? [] : ["--", path];
		const base = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-z"];
		const statuses = (await this.#ok([...base, "--name-status", from, to, ...scope])).split("\0");
		const counts = (await this.#ok([...base, "--numstat", from, to, ...scope])).split("\0");

		const lines = new Map<string, { insertions: number; deletions: number }>();
		let insertions = 0;
		let deletions = 0;
		for (let i = 0; i < counts.length; ) {
			const match = NUMSTAT_RECORD.exec(counts[i++] ?? "");
			if (match === null) continue;
			let name = match[3] ?? "";
			// A rename carries an empty path here, then the old and the new path as records of their own.
			if (name === "") {
				i++;
				name = counts[i++] ?? "";
			}
			const added = match[1] === "-" ? 0 : Number(match[1]);
			const removed = match[2] === "-" ? 0 : Number(match[2]);
			lines.set(name, { insertions: added, deletions: removed });
			insertions += added;
			deletions += removed;
		}

		const files: DiffFile[] = [];
		let truncated = false;
		for (let i = 0; i < statuses.length; ) {
			const code = statuses[i++] ?? "";
			if (code === "") continue;
			const letter = code[0];
			if (letter === "R" || letter === "C") i++;
			const name = statuses[i++] ?? "";
			if (files.length >= MAX_STAT_FILES) {
				truncated = true;
				continue;
			}
			const status = letter === "A" || letter === "C" ? "A" : letter === "D" ? "D" : letter === "R" ? "R" : "M";
			files.push({ path: name, status, insertions: lines.get(name)?.insertions ?? 0, deletions: lines.get(name)?.deletions ?? 0 });
		}
		return { files, insertions, deletions, truncated };
	}

	/** The unified diff between `from` and `to` for `path` (`""`: everything), the first `maxBytes` bytes of it and its full length. */
	async diff(from: string, to: string, options: { path: string; context: number; maxBytes: number }): Promise<DiffText> {
		this.#requireCommits(from, to);
		const scope = options.path === "" ? [] : ["--", options.path];
		const chunks: Buffer[] = [];
		let kept = 0;
		let length = 0;
		const outcome = await this.#stream(
			["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", `-U${options.context}`, from, to, ...scope],
			(chunk) => {
				length += chunk.length;
				if (kept < options.maxBytes) {
					const piece = Buffer.from(chunk.subarray(0, options.maxBytes - kept));
					chunks.push(piece);
					kept += piece.length;
				}
				return true;
			},
		);
		if (outcome.code !== 0) throw new Error(`git diff failed: ${outcome.stderr.trim().split("\n").at(-1) ?? ""}`);
		return { bytes: Buffer.concat(chunks), length };
	}

	/** The entries under `path` of `commit` (`""` is the root), at most `limit`; null when `path` is not a directory there. */
	async tree(commit: string, path: string, options: { recursive: boolean; limit: number }): Promise<TreeListing | null> {
		this.#requireCommits(commit);
		if (path !== "") {
			const found = await this.#entry(commit, path);
			if (found === null || found.type !== "tree") return null;
		}
		const args = ["ls-tree", "-z", "-l", ...(options.recursive ? ["-r", "-t"] : []), path === "" ? commit : `${commit}:${path}`];
		const entries: TreeEntry[] = [];
		let truncated = false;
		let rest = "";
		const take = (record: string): boolean => {
			if (entries.length >= options.limit) {
				truncated = true;
				return false;
			}
			const parsed = treeRecord(record);
			entries.push({ path: path === "" ? parsed.path : `${path}/${parsed.path}`, type: parsed.type === "blob" ? "file" : "dir", size: parsed.type === "blob" ? parsed.size : 0 });
			return true;
		};
		const decoder = new TextDecoder();
		const outcome = await this.#stream(args, (chunk) => {
			rest += decoder.decode(chunk, { stream: true });
			for (let end = rest.indexOf("\0"); end >= 0; end = rest.indexOf("\0")) {
				const record = rest.slice(0, end);
				rest = rest.slice(end + 1);
				if (!take(record)) return false;
			}
			return true;
		});
		if (!outcome.stopped && outcome.code !== 0) throw new Error(`git ls-tree failed: ${outcome.stderr.trim().split("\n").at(-1) ?? ""}`);
		return { entries, truncated };
	}

	/** A page of the file at `path` in `commit`; null when `path` is not a file there. */
	async file(commit: string, path: string, options: { offset: number; limit: number }): Promise<FileSlice | null> {
		this.#requireCommits(commit);
		const found = await this.#entry(commit, path);
		if (found === null || found.type !== "blob") return null;
		const { size } = found;
		const { offset, limit } = options;
		if (offset >= size) {
			// The page starts at or past the end: nothing to read.
			return { size, binary: false, offset, text: "", next: null };
		}
		// A page may end inside a character: read a few bytes past it and cut at a character boundary.
		const wanted = offset + limit + 3;
		const parts: Buffer[] = [];
		let binary = false;
		let position = 0;
		const outcome = await this.#stream(["cat-file", "blob", found.oid], (chunk) => {
			if (position < BINARY_SNIFF_BYTES && chunk.subarray(0, BINARY_SNIFF_BYTES - position).includes(0)) {
				binary = true;
				return false;
			}
			const from = Math.max(offset - position, 0);
			const to = Math.min(wanted - position, chunk.length);
			if (to > from) parts.push(Buffer.from(chunk.subarray(from, to)));
			position += chunk.length;
			return position < Math.max(wanted, BINARY_SNIFF_BYTES);
		});
		if (!outcome.stopped && outcome.code !== 0) throw new Error(`git cat-file failed: ${outcome.stderr.trim().split("\n").at(-1) ?? ""}`);
		if (binary) return { size, binary: true, offset, text: "", next: null };

		const bytes = Buffer.concat(parts);
		// An offset inside a character starts at the next one.
		let skip = 0;
		if (offset > 0) while (skip < 3 && continuation(bytes[skip])) skip++;
		const available = bytes.length - skip;
		let length = Math.min(limit, available);
		if (length < available) {
			while (length > 0 && continuation(bytes[skip + length])) length--;
			if (length === 0) {
				length = 1;
				while (length < available && continuation(bytes[skip + length])) length++;
			}
		}
		const start = offset + skip;
		return { size, binary: false, offset: start, text: bytes.toString("utf8", skip, skip + length), next: start + length < size ? start + length : null };
	}

	/** The tree entry at `path` of `commit` (type, object and size), or null when there is none. */
	async #entry(commit: string, path: string): Promise<TreeRecord | null> {
		let record: TreeRecord | null = null;
		let rest = "";
		const decoder = new TextDecoder();
		const outcome = await this.#stream(["ls-tree", "-z", "-l", commit, "--", path], (chunk) => {
			rest += decoder.decode(chunk, { stream: true });
			const end = rest.indexOf("\0");
			if (end < 0) return true;
			record = treeRecord(rest.slice(0, end));
			return false;
		});
		if (!outcome.stopped && outcome.code !== 0) throw new Error(`git ls-tree failed: ${outcome.stderr.trim().split("\n").at(-1) ?? ""}`);
		return record;
	}

	#requireCommits(...names: string[]): void {
		for (const name of names) {
			if (!OBJECT_NAME.test(name)) throw new Error(`not an object name: ${JSON.stringify(name.slice(0, 80))}`);
		}
	}

	/** Runs git and returns its whole stdout; a non-zero exit throws. */
	async #ok(args: string[]): Promise<string> {
		const chunks: Buffer[] = [];
		let size = 0;
		const outcome = await this.#stream(args, (chunk) => {
			size += chunk.length;
			if (size > MAX_COLLECTED_BYTES) throw new Error(`git ${args[0]} produced more than ${MAX_COLLECTED_BYTES} bytes`);
			chunks.push(Buffer.from(chunk));
			return true;
		});
		if (outcome.code !== 0) throw new Error(`git ${args[0]} failed: ${outcome.stderr.trim().split("\n").at(-1) ?? ""}`);
		return Buffer.concat(chunks).toString("utf8");
	}

	/**
	 * Runs git with literal pathspecs and feeds stdout to `onChunk` until it returns false (git is then killed and
	 * `stopped` is set). Throws when git outlives COMMAND_TIMEOUT_MS or `onChunk` throws.
	 */
	async #stream(args: string[], onChunk: (chunk: Uint8Array) => boolean): Promise<Outcome> {
		const proc = Bun.spawn([this.#git, "--literal-pathspecs", "-c", "core.quotepath=false", ...args], {
			cwd: this.#repo,
			env: this.#env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(proc.stderr).text();
		stderr.catch(() => undefined);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, COMMAND_TIMEOUT_MS);
		let stopped = false;
		try {
			for await (const chunk of proc.stdout) {
				if (!onChunk(chunk)) {
					stopped = true;
					proc.kill("SIGKILL");
					break;
				}
			}
			const code = await proc.exited;
			if (timedOut) throw new Error(`git ${args[0]} timed out after ${COMMAND_TIMEOUT_MS / 1000} s`);
			return { code: stopped ? 0 : code, stderr: await stderr, stopped };
		} catch (error) {
			proc.kill("SIGKILL");
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}
