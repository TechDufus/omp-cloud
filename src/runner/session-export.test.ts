import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../guards";
import { type Exec, localExec, shellQuote } from "./exec";
import { exportSession, exportSessionId, reidentifySession } from "./session-export";

const q = shellQuote;
const OLD_ID = "0198a1c0-0000-7000-8000-000000000001";
const EXPORT_ID = exportSessionId("aaaaaaaaaaaa");

let dir: string;
let sandbox: string;
let exec: Exec;
let sessionFile: string;

/**
 * An exec whose commands run with a throwaway HOME, omp agent dir and TMPDIR, and without the owner's XDG and
 * `PI_CONFIG_DIR` redirections (`bash -lc` sources the owner's profile): never the owner's omp directories.
 */
function isolated(root: string): Exec {
	const run = localExec();
	return (command, options) =>
		run(
			`unset XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME PI_CONFIG_DIR; export HOME=${q(root)} PI_CODING_AGENT_DIR=${q(`${root}/.omp/agent`)} TMPDIR=${q(`${root}/tmp`)}; ${command}`,
			options,
		);
}

const TITLE = JSON.stringify({ type: "title", v: 1, title: "t", source: "auto", updatedAt: "2026-10-19T10:00:00.000Z", pad: "" });
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-19T10:00:00.000Z", cwd: "/work" });
const message = (id: string, role: string, text: string) =>
	JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-19T10:00:01.000Z", message: { role, content: [{ type: "text", text }], timestamp: 1 } });

const USER_LINE = message("aaaaaaaa", "user", "hello");
const REPLY_LINE = message("bbbbbbbb", "assistant", "hi");

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	sandbox = join(dir, "sandbox");
	await mkdir(join(sandbox, "tmp"), { recursive: true });
	exec = isolated(sandbox);
	sessionFile = join(dir, "live.jsonl");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function member(archive: string, name: string): Promise<string> {
	return exec(`tar -xOf ${q(archive)} ${q(name)}`);
}

describe("exportSessionId", () => {
	test("is a stable version 8 UUID per thread and differs between threads", () => {
		const id = exportSessionId("aaaaaaaaaaaa");
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(exportSessionId("aaaaaaaaaaaa")).toBe(id);
		expect(exportSessionId("bbbbbbbbbbbb")).not.toBe(id);
	});
});

describe("exportSession", () => {
	test("packs a copy under the export id, keeping every other line and the artifacts", async () => {
		const journal = `${[TITLE, header(OLD_ID), USER_LINE, REPLY_LINE].join("\n")}\n`;
		await writeFile(sessionFile, journal);
		await mkdir(join(dir, "live"));
		await writeFile(join(dir, "live", "0.txt"), "artifact body");
		const out = join(dir, "out.tar");

		await exportSession(exec, { sessionFile, exportId: EXPORT_ID, outPath: out });

		expect(JSON.parse(await member(out, "manifest.json")).id).toBe(EXPORT_ID);
		expect(await member(out, "session.jsonl")).toBe(`${[TITLE, header(EXPORT_ID), USER_LINE, REPLY_LINE].join("\n")}\n`);
		expect(await member(out, "artifacts/0.txt")).toBe("artifact body");
		// The live journal is untouched and the temp directory is gone.
		expect(await Bun.file(sessionFile).text()).toBe(journal);
		expect(await readdir(join(sandbox, "tmp"))).toEqual([]);
	});

	test("does not export a line omp is still writing", async () => {
		await writeFile(sessionFile, `${[TITLE, header(OLD_ID), USER_LINE].join("\n")}\n{"type":"message","id":"cccccccc","parentId":"aaa`);
		const out = join(dir, "out.tar");

		await exportSession(exec, { sessionFile, exportId: EXPORT_ID, outPath: out });

		expect(await member(out, "session.jsonl")).toBe(`${[TITLE, header(EXPORT_ID), USER_LINE].join("\n")}\n`);
	});

	test("refuses the live session itself and leaves nothing behind", async () => {
		await writeFile(sessionFile, `${[header(EXPORT_ID), USER_LINE].join("\n")}\n`);
		const out = join(dir, "out.tar");

		await expect(exportSession(exec, { sessionFile, exportId: EXPORT_ID, outPath: out })).rejects.toThrow(/cannot be packed/);
		expect(await Bun.file(out).exists()).toBe(false);
		expect(await readdir(join(sandbox, "tmp"))).toEqual([]);
	});

	test("rejects a journal without a header", async () => {
		await writeFile(sessionFile, `${[TITLE, USER_LINE].join("\n")}\n`);

		await expect(exportSession(exec, { sessionFile, exportId: EXPORT_ID, outPath: join(dir, "out.tar") })).rejects.toThrow(/no header/);
		expect(await readdir(join(sandbox, "tmp"))).toEqual([]);
	});
});

describe("reidentifySession", () => {
	const NEW_ID = "0198a1c0-0000-7000-8000-0000000000ff";

	test("an exported archive unpacks under the new id with every entry and artifact, and can be exported again", async () => {
		await writeFile(sessionFile, `${[TITLE, header(OLD_ID), USER_LINE, REPLY_LINE].join("\n")}\n`);
		await mkdir(join(dir, "live", "sub"), { recursive: true });
		await writeFile(join(dir, "live", "sub", "0.txt"), "artifact body");
		const exported = join(dir, "export.tar");
		const restored = join(dir, "restored.tar");
		await exportSession(exec, { sessionFile, exportId: EXPORT_ID, outPath: exported });

		await reidentifySession(exec, { archive: exported, outPath: restored, sessionId: NEW_ID });

		expect(JSON.parse(await member(restored, "manifest.json")).id).toBe(NEW_ID);
		expect((await member(restored, "session.jsonl")).split("\n")[1]).toBe(header(NEW_ID));
		expect((await exec(`tar -tf ${q(restored)}`)).trim().split("\n")).toEqual(["manifest.json", "session.jsonl", "artifacts/sub/0.txt"]);

		const out = await exec(`omp session unpack ${q(restored)} --cwd ${q(dir)}`);
		const unpacked = out.split("\n").map(line => line.trim()).filter(line => line !== "").at(-1) ?? "";
		expect(unpacked.endsWith(".jsonl")).toBe(true);
		const lines = (await Bun.file(unpacked).text()).split("\n").filter(line => line !== "");
		const unpackedHeader: unknown = JSON.parse(lines.find(line => line.includes('"type":"session"')) ?? "null");
		expect(unpackedHeader).toMatchObject({ type: "session", id: NEW_ID });
		// omp's unpack rewrites the journal (an assistant message gains a zero `usage`), so compare the entries, not the bytes.
		// Ids and timestamps must survive: omp stats deduplicates on them, so a changed one would count a request twice.
		const messages = lines.map((line): unknown => JSON.parse(line)).filter(entry => isRecord(entry) && entry.type === "message");
		expect(messages).toMatchObject([
			{ id: "aaaaaaaa", timestamp: "2026-10-19T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
			{ id: "bbbbbbbb", timestamp: "2026-10-19T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
		]);
		expect(await Bun.file(`${unpacked.slice(0, -".jsonl".length)}/sub/0.txt`).text()).toBe("artifact body");

		const again = join(dir, "again.tar");
		await exportSession(exec, { sessionFile: unpacked, exportId: EXPORT_ID, outPath: again });
		expect(JSON.parse(await member(again, "manifest.json")).id).toBe(EXPORT_ID);
	});

	test("keeps artifacts and blobs, writes no directory members and leaves no temp directory", async () => {
		const src = join(dir, "src");
		await mkdir(join(src, "artifacts", "a"), { recursive: true });
		await mkdir(join(src, "blobs"));
		await writeFile(join(src, "manifest.json"), JSON.stringify({ version: 1, id: OLD_ID, cwd: "/work", omp: "18.12.3" }));
		await writeFile(join(src, "session.jsonl"), `${[header(OLD_ID), USER_LINE].join("\n")}\n`);
		await writeFile(join(src, "artifacts", "a", "b.txt"), "artifact");
		await writeFile(join(src, "blobs", "abc123"), "blob body");
		const archive = join(dir, "in.tar");
		await exec(`tar -cf ${q(archive)} manifest.json session.jsonl artifacts blobs`, { cwd: src });
		const out = join(dir, "out.tar");

		await reidentifySession(exec, { archive, outPath: out, sessionId: NEW_ID });

		expect((await exec(`tar -tf ${q(out)}`)).trim().split("\n")).toEqual(["manifest.json", "session.jsonl", "artifacts/a/b.txt", "blobs/abc123"]);
		expect(JSON.parse(await member(out, "manifest.json"))).toEqual({ version: 1, id: NEW_ID, cwd: "/work", omp: "18.12.3" });
		expect(await member(out, "session.jsonl")).toBe(`${[header(NEW_ID), USER_LINE].join("\n")}\n`);
		expect(await member(out, "artifacts/a/b.txt")).toBe("artifact");
		expect(await member(out, "blobs/abc123")).toBe("blob body");
		expect(await readdir(join(sandbox, "tmp"))).toEqual([]);
	});

	test("an archive without artifacts or blobs holds the manifest and the journal only", async () => {
		await writeFile(sessionFile, `${[header(OLD_ID), USER_LINE].join("\n")}\n`);
		const exported = join(dir, "export.tar");
		const out = join(dir, "out.tar");
		await exportSession(exec, { sessionFile, exportId: EXPORT_ID, outPath: exported });

		await reidentifySession(exec, { archive: exported, outPath: out, sessionId: NEW_ID });

		expect((await exec(`tar -tf ${q(out)}`)).trim().split("\n")).toEqual(["manifest.json", "session.jsonl"]);
	});

	test("rejects an unusable id, an archive without a header or manifest, and leaves nothing behind", async () => {
		await writeFile(sessionFile, `${[header(OLD_ID), USER_LINE].join("\n")}\n`);
		const exported = join(dir, "export.tar");
		await exportSession(exec, { sessionFile, exportId: EXPORT_ID, outPath: exported });
		const out = join(dir, "out.tar");
		await expect(reidentifySession(exec, { archive: exported, outPath: out, sessionId: "bad id'; rm -rf /" })).rejects.toThrow(/invalid session id/);

		const noHeader = join(dir, "no-header");
		await mkdir(noHeader);
		await writeFile(join(noHeader, "manifest.json"), JSON.stringify({ version: 1, id: OLD_ID }));
		await writeFile(join(noHeader, "session.jsonl"), `${USER_LINE}\n`);
		await exec(`tar -cf ${q(join(dir, "no-header.tar"))} manifest.json session.jsonl`, { cwd: noHeader });
		await expect(reidentifySession(exec, { archive: join(dir, "no-header.tar"), outPath: out, sessionId: NEW_ID })).rejects.toThrow(/no header/);

		await exec(`tar -cf ${q(join(dir, "no-manifest.tar"))} session.jsonl`, { cwd: noHeader });
		await expect(reidentifySession(exec, { archive: join(dir, "no-manifest.tar"), outPath: out, sessionId: NEW_ID })).rejects.toThrow(/no manifest/);

		expect(await Bun.file(out).exists()).toBe(false);
		expect(await readdir(join(sandbox, "tmp"))).toEqual([]);
	});
});
