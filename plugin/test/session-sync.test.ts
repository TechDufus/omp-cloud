import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { run } from "../src/exec";
import { readArchiveJournal } from "../src/session-sync";
import { isRecord } from "../src/guards";
import { cleanup, ompHome, syncInto, tmp } from "./helpers";

afterEach(cleanup);

const STAMP = "2026-10-18T22-11-00-000Z";

/**
 * A cloud export of `messages` entries as a real `omp session pack` archive. Exports of the same id with
 * more messages are strictly longer: entries e1..eN never change, like the runner's copies of the live journal.
 */
async function exportArchive(id: string, messages: number): Promise<string> {
	const dir = await tmp("omp-cloud-export-");
	const file = join(dir, `${STAMP}_${id}.jsonl`);
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-18T22:11:00.000Z", cwd: "/cloud/work", title: "t" })];
	for (let i = 1; i <= messages; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `e${i}`,
				parentId: i === 1 ? null : `e${i - 1}`,
				timestamp: `2026-10-18T22:11:0${i}.000Z`,
				message: { role: "user", content: [{ type: "text", text: `message ${i}` }] },
			}),
		);
	}
	await writeFile(file, `${lines.join("\n")}\n`);
	await mkdir(join(dir, `${STAMP}_${id}`), { recursive: true });
	await writeFile(join(dir, `${STAMP}_${id}`, "artifact.txt"), "artifact bytes");
	const archive = join(dir, `export-${messages}.tar`);
	const packed = await run("omp", ["session", "pack", file, archive], { env: (await ompHome()).env });
	expect(packed.code).toBe(0);
	return archive;
}

async function entriesOf(file: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for (const line of (await readFile(file, "utf8")).split("\n")) {
		if (line.trim() === "") continue;
		const o: unknown = JSON.parse(line);
		if (isRecord(o)) out.push(o);
	}
	return out;
}

const isArrival = (e: Record<string, unknown>) =>
	e.type === "custom_message" && e.customType === "session-transfer" && isRecord(e.details) && e.details.kind === "arrived";

/** Ids of the message entries, in order. */
const messageIds = async (file: string) => (await entriesOf(file)).filter(e => e.type === "message").map(e => e.id);

/** The session files in the bucket directory of `file`: a fork shows up here under its own id. */
async function bucketSessions(file: string): Promise<string[]> {
	return (await readdir(dirname(file))).filter(n => n.endsWith(".jsonl")).sort();
}

/** The lease seam: records every claim and release. */
function leases() {
	const claimed: [string, string][] = [];
	let released = 0;
	return {
		claimed,
		get released() {
			return released;
		},
		claim: (id: string, file: string) => {
			claimed.push([id, file]);
			return () => void released++;
		},
	};
}

describe("syncConversation", () => {
	test("the first sync places the export as a new session and says so", async () => {
		const id = "01990000-0000-7000-8000-000000000001";
		const home = await ompHome();
		const { file, mode } = await syncInto(home, await exportArchive(id, 2), await tmp("omp-cloud-cwd-"));

		expect(mode).toBe("created");
		expect(file.startsWith(`${home.sessionsRoot}/`)).toBe(true);
		expect(basename(file)).toBe(`${STAMP}_${id}.jsonl`);
		const entries = await entriesOf(file);
		expect(entries.find(e => e.type === "session")?.id).toBe(id);
		expect(await messageIds(file)).toEqual(["e1", "e2"]);
		expect(entries.filter(isArrival)).toHaveLength(1);
		expect(await readFile(join(file.replace(/\.jsonl$/, ""), "artifact.txt"), "utf8")).toBe("artifact bytes");
	});

	test("a grown export of the same session leaves one file at the same path, with the new entries and a single arrived marker", async () => {
		const id = "01990000-0000-7000-8000-000000000002";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const first = await syncInto(home, await exportArchive(id, 2), cwd);
		const lease = leases();

		const second = await syncInto(home, await exportArchive(id, 3), cwd, { claim: lease.claim });

		expect(second.mode).toBe("created");
		expect(second.file).toBe(first.file);
		expect(await findSessionFiles(id, home.sessionsRoot)).toEqual([first.file]);
		expect(await messageIds(second.file)).toEqual(["e1", "e2", "e3"]);
		expect((await entriesOf(second.file)).filter(isArrival)).toHaveLength(1);
		expect(await readFile(join(second.file.replace(/\.jsonl$/, ""), "artifact.txt"), "utf8")).toBe("artifact bytes");
		// The stale copy was removed under omp's lease, which was given back.
		expect(lease.claimed).toEqual([[id, first.file]]);
		expect(lease.released).toBe(1);
	});

	test("syncing the same export again changes nothing", async () => {
		const id = "01990000-0000-7000-8000-000000000003";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const archive = await exportArchive(id, 2);
		const first = await syncInto(home, archive, cwd);
		const before = await readFile(first.file);
		const lease = leases();

		const again = await syncInto(home, archive, cwd, { claim: lease.claim });

		expect(again).toEqual({ file: first.file, mode: "unchanged" });
		expect(Buffer.compare(await readFile(first.file), before)).toBe(0);
		expect(lease.claimed).toEqual([]);
		expect(await findSessionFiles(id, home.sessionsRoot)).toEqual([first.file]);
	});

	test("a copy the user continued is kept and the export lands as omp's fork", async () => {
		const id = "01990000-0000-7000-8000-000000000004";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const first = await syncInto(home, await exportArchive(id, 2), cwd);
		await appendFile(
			first.file,
			`${JSON.stringify({ type: "message", id: "local1", parentId: "e2", timestamp: "2026-10-19T08:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "my own turn" }] } })}\n`,
		);
		const continued = await readFile(first.file);
		const lease = leases();

		const second = await syncInto(home, await exportArchive(id, 3), cwd, { claim: lease.claim });

		expect(second.mode).toBe("forked");
		expect(second.file).not.toBe(first.file);
		expect(Buffer.compare(await readFile(first.file), continued)).toBe(0);
		expect(lease.claimed).toEqual([]);
		const fork = await entriesOf(second.file);
		expect(fork.find(e => e.type === "session")?.id).not.toBe(id);
		expect(await messageIds(second.file)).toEqual(["e1", "e2", "e3"]);
	});

	test("a background save beside a copy the user continued skips instead of forking", async () => {
		const id = "01990000-0000-7000-8000-00000000000a";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const first = await syncInto(home, await exportArchive(id, 2), cwd);
		await appendFile(
			first.file,
			`${JSON.stringify({ type: "message", id: "local1", parentId: "e2", timestamp: "2026-10-19T08:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "my own turn" }] } })}\n`,
		);
		const continued = await readFile(first.file);
		const sessions = await bucketSessions(first.file);
		const lease = leases();

		for (let i = 0; i < 2; i++) {
			const second = await syncInto(home, await exportArchive(id, 3), cwd, { fork: false, claim: lease.claim });

			expect(second).toEqual({ file: first.file, mode: "skipped" });
		}

		expect(lease.claimed).toEqual([]);
		expect(Buffer.compare(await readFile(first.file), continued)).toBe(0);
		expect(await findSessionFiles(id, home.sessionsRoot)).toEqual([first.file]);
		expect(await bucketSessions(first.file)).toEqual(sessions);
	});

	test("the session this omp writes is never claimed or modified; the export lands as omp's fork", async () => {
		const id = "01990000-0000-7000-8000-000000000005";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const first = await syncInto(home, await exportArchive(id, 2), cwd);
		const before = await readFile(first.file);
		const lease = leases();

		const second = await syncInto(home, await exportArchive(id, 3), cwd, { current: first.file, claim: lease.claim });

		expect(lease.claimed).toEqual([]);
		expect(Buffer.compare(await readFile(first.file), before)).toBe(0);
		// The kept copy ends with its own arrived marker, so omp places the export under a new id.
		expect(second.mode).toBe("forked");
		expect(second.file).not.toBe(first.file);
		expect(await messageIds(second.file)).toEqual(["e1", "e2", "e3"]);
	});

	test("a background save beside the session this omp writes skips instead of forking", async () => {
		const id = "01990000-0000-7000-8000-00000000000b";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const first = await syncInto(home, await exportArchive(id, 2), cwd);
		const before = await readFile(first.file);
		const sessions = await bucketSessions(first.file);
		const lease = leases();

		for (let i = 0; i < 2; i++) {
			const second = await syncInto(home, await exportArchive(id, 3), cwd, { fork: false, current: first.file, claim: lease.claim });

			expect(second).toEqual({ file: first.file, mode: "skipped" });
		}

		expect(lease.claimed).toEqual([]);
		expect(Buffer.compare(await readFile(first.file), before)).toBe(0);
		expect(await findSessionFiles(id, home.sessionsRoot)).toEqual([first.file]);
		expect(await bucketSessions(first.file)).toEqual(sessions);
	});

	test("a copy whose lease another omp holds is kept; the export lands as omp's fork", async () => {
		const id = "01990000-0000-7000-8000-000000000006";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const first = await syncInto(home, await exportArchive(id, 2), cwd);
		const before = await readFile(first.file);
		const seen: [string, string][] = [];

		const second = await syncInto(home, await exportArchive(id, 3), cwd, {
			claim: (i, f) => {
				seen.push([i, f]);
				return null;
			},
		});

		expect(seen).toEqual([[id, first.file]]);
		expect(Buffer.compare(await readFile(first.file), before)).toBe(0);
		expect(second.mode).toBe("forked");
		expect(second.file).not.toBe(first.file);
		expect(await messageIds(second.file)).toEqual(["e1", "e2", "e3"]);
	});

	test("a background save beside a copy whose lease another omp holds skips instead of forking", async () => {
		const id = "01990000-0000-7000-8000-000000000009";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const first = await syncInto(home, await exportArchive(id, 2), cwd);
		const before = await readFile(first.file);
		const sessions = await bucketSessions(first.file);

		for (let i = 0; i < 2; i++) {
			const second = await syncInto(home, await exportArchive(id, 3), cwd, { fork: false, claim: () => null });

			expect(second).toEqual({ file: first.file, mode: "skipped" });
		}

		expect(Buffer.compare(await readFile(first.file), before)).toBe(0);
		expect(await findSessionFiles(id, home.sessionsRoot)).toEqual([first.file]);
		expect(await bucketSessions(first.file)).toEqual(sessions);
	});

	test("a stale copy in another working directory's bucket is removed with its artifacts", async () => {
		const id = "01990000-0000-7000-8000-000000000007";
		const home = await ompHome();
		const first = await syncInto(home, await exportArchive(id, 2), await tmp("omp-cloud-cwd-a-"));

		const second = await syncInto(home, await exportArchive(id, 3), await tmp("omp-cloud-cwd-b-"));

		expect(second.mode).toBe("created");
		expect(dirname(second.file)).not.toBe(dirname(first.file));
		expect(await findSessionFiles(id, home.sessionsRoot)).toEqual([second.file]);
		await expect(stat(first.file)).rejects.toThrow();
		await expect(stat(first.file.replace(/\.jsonl$/, ""))).rejects.toThrow();
		expect(await messageIds(second.file)).toEqual(["e1", "e2", "e3"]);
	});

	test("unrelated sessions in the same bucket are left alone", async () => {
		const id = "01990000-0000-7000-8000-000000000008";
		const home = await ompHome();
		const cwd = await tmp("omp-cloud-cwd-");
		const first = await syncInto(home, await exportArchive(id, 2), cwd);
		const neighbour = join(dirname(first.file), `${STAMP}_01990000-0000-7000-8000-0000000000ff.jsonl`);
		await writeFile(neighbour, `${JSON.stringify({ type: "session", version: 3, id: "01990000-0000-7000-8000-0000000000ff", timestamp: "2026-10-18T22:11:00.000Z", cwd })}\n`);

		await syncInto(home, await exportArchive(id, 3), cwd);

		expect((await readdir(dirname(first.file))).filter(n => n.endsWith(".jsonl")).sort()).toEqual([basename(first.file), basename(neighbour)].sort());
	});

	test("an archive path that does not exist throws a readable error", async () => {
		const home = await ompHome();
		const missing = join(await tmp("omp-cloud-arc-"), "nope.tar");
		await expect(syncInto(home, missing, await tmp())).rejects.toThrow(/^cannot read the conversation archive: /);
	});

	test("a file that is not an archive throws and leaves no session behind", async () => {
		const home = await ompHome();
		const bogus = join(await tmp("omp-cloud-arc-"), "bogus.tar");
		await writeFile(bogus, "definitely not a tar archive");
		await expect(syncInto(home, bogus, await tmp())).rejects.toThrow(/^cannot read the conversation archive: /);
		await expect(stat(home.sessionsRoot)).rejects.toThrow();
	});

	test("an archive whose journal has no session header throws", async () => {
		const home = await ompHome();
		const dir = await tmp("omp-cloud-arc-");
		await writeFile(join(dir, "session.jsonl"), `${JSON.stringify({ type: "message", id: "e1" })}\n`);
		const archive = join(dir, "headerless.tar");
		expect((await run("tar", ["-cf", archive, "-C", dir, "session.jsonl"])).code).toBe(0);
		await expect(syncInto(home, archive, await tmp())).rejects.toThrow("the conversation archive has no session header");
		await expect(stat(home.sessionsRoot)).rejects.toThrow();
	});
});

describe("readArchiveJournal", () => {
	test("reads the session.jsonl of a real `omp session pack` archive: the header and every entry, byte for byte", async () => {
		const id = "01990000-0000-7000-8000-0000000000a1";
		const text = await readArchiveJournal(await exportArchive(id, 3));
		const lines = text.split("\n").filter(l => l !== "");
		expect(lines).toHaveLength(4);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ type: "session", id });
		const entryIds = lines.slice(1).map(l => {
			const entry: unknown = JSON.parse(l);
			return isRecord(entry) ? entry.id : undefined;
		});
		expect(entryIds).toEqual(["e1", "e2", "e3"]);
	});

	test("returns the member's text as it is, wherever the archive was written", async () => {
		const journal = `${JSON.stringify({ type: "session", id: "s1" })}\n${JSON.stringify({ type: "message", id: "e1" })}\n`;
		const archive = join(await tmp("omp-cloud-arc-"), "journal.tar");
		await Bun.write(archive, new Bun.Archive({ "session.jsonl": journal, "artifacts/note.txt": "not the journal" }));
		expect(await readArchiveJournal(archive)).toBe(journal);
	});

	test("an archive without a session.jsonl says so", async () => {
		const archive = join(await tmp("omp-cloud-arc-"), "other.tar");
		await Bun.write(archive, new Bun.Archive({ "notes.txt": "x" }));
		await expect(readArchiveJournal(archive)).rejects.toThrow("the conversation archive holds no session.jsonl");
	});

	test("a path that does not exist, and a file that is not an archive, are `cannot read the conversation archive` with the cause", async () => {
		const dir = await tmp("omp-cloud-arc-");
		await expect(readArchiveJournal(join(dir, "nope.tar"))).rejects.toThrow(/^cannot read the conversation archive: .*(ENOENT|no such file)/);
		const bogus = join(dir, "bogus.tar");
		await writeFile(bogus, "definitely not a tar archive");
		await expect(readArchiveJournal(bogus)).rejects.toThrow(/^cannot read the conversation archive: .*Unrecognized archive format/);
	});
});
