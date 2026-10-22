import { sshSign } from "./sshsig";

/** Runs git with `args` in `opts.cwd`, `opts.input` on stdin, and returns stdout; throws when git exits non-zero. */
export type RawGit = (args: string[], opts: { cwd: string; input?: Uint8Array }) => Promise<Uint8Array>;

/** A commit header: its first line and the continuation lines (each starts with a space) that follow. */
interface HeaderEntry {
	key: string;
	lines: string[];
}

const SIGNATURE_HEADERS: readonly string[] = ["gpgsig", "gpgsig-sha256"];

/** Splits a commit's header text (latin1, so bytes survive a round trip) into entries. */
function headerEntries(text: string): HeaderEntry[] {
	const entries: HeaderEntry[] = [];
	for (const line of text.split("\n")) {
		const last = entries.at(-1);
		if (line.startsWith(" ") && last !== undefined) {
			last.lines.push(line);
			continue;
		}
		const space = line.indexOf(" ");
		entries.push({ key: space === -1 ? line : line.slice(0, space), lines: [line] });
	}
	return entries;
}

/** `line` (a `committer` header) with its name and email replaced and the `<epoch> <tz>` kept. */
function withCommitter(line: string, committer: { name: string; email: string }): string {
	const tail = line.slice(line.lastIndexOf(">") + 1);
	return `committer ${Buffer.from(`${committer.name} <${committer.email}>`, "utf8").toString("latin1")}${tail}`;
}

/**
 * Re-signs the commits `head` has over `base` with an SSH signature, oldest first, so a commit whose parents were
 * rewritten gets the new parent ids. Tree, author, author date and message stay byte for byte; a commit that already has
 * a signature and whose parents did not change is kept as it is. `committer`, when set, replaces the committer's name
 * and email (not its date). Ed25519 signs deterministically, so a retry gives the same ids. Returns the rewritten head
 * and how many commits were rewritten.
 */
export async function rewriteSigned(
	git: RawGit,
	input: { repo: string; base: string; head: string; privatePem: string; committer: { name: string; email: string } | null },
): Promise<{ head: string; rewritten: number }> {
	const cwd = input.repo;
	const text = async (args: string[]): Promise<string> => Buffer.from(await git(args, { cwd })).toString("utf8").trim();
	const signatureHeader = (await text(["rev-parse", "--show-object-format"])) === "sha256" ? "gpgsig-sha256" : "gpgsig";
	const head = await text(["rev-parse", "--verify", `${input.head}^{commit}`]);
	const listing = await text(["rev-list", "--reverse", "--topo-order", head, ...(input.base === "" ? [] : [`^${input.base}`])]);
	const rewrites = new Map<string, string>();
	let rewritten = 0;
	for (const sha of listing === "" ? [] : listing.split("\n")) {
		const raw = Buffer.from(await git(["cat-file", "commit", sha], { cwd }));
		const split = raw.indexOf("\n\n");
		const headers = raw.subarray(0, split === -1 ? raw.length : split).toString("latin1");
		const message = split === -1 ? Buffer.alloc(0) : raw.subarray(split + 2);
		const entries = headerEntries(headers);
		let parentsChanged = false;
		for (const entry of entries) {
			if (entry.key !== "parent") continue;
			const parent = (entry.lines[0] ?? "").slice("parent ".length);
			const mapped = rewrites.get(parent);
			if (mapped !== undefined && mapped !== parent) {
				entry.lines = [`parent ${mapped}`];
				parentsChanged = true;
			}
		}
		const signed = entries.some((entry) => SIGNATURE_HEADERS.includes(entry.key));
		if (signed && !parentsChanged) {
			rewrites.set(sha, sha);
			continue;
		}
		const kept: string[] = [];
		for (const entry of entries) {
			if (SIGNATURE_HEADERS.includes(entry.key)) continue;
			if (entry.key === "committer" && input.committer !== null) kept.push(withCommitter(entry.lines[0] ?? "", input.committer));
			else kept.push(...entry.lines);
		}
		const payload = Buffer.concat([Buffer.from(kept.join("\n"), "latin1"), Buffer.from("\n\n"), message]);
		const armored = sshSign(payload, input.privatePem).split("\n");
		const signature = [`${signatureHeader} ${armored[0]}`, ...armored.slice(1).map((line) => ` ${line}`)];
		const object = Buffer.concat([Buffer.from(`${kept.join("\n")}\n${signature.join("\n")}\n\n`, "latin1"), message]);
		const written = await git(["hash-object", "-t", "commit", "-w", "--stdin"], { cwd, input: object });
		rewrites.set(sha, Buffer.from(written).toString("utf8").trim());
		rewritten++;
	}
	return { head: rewrites.get(head) ?? head, rewritten };
}
