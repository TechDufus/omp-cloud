import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CONVERSATION_BYTES, packConversation, rewriteConversation, uuidv7 } from "../src/conversation";
import { cleanup, ompHome, syncInto, tmp } from "./helpers";

afterEach(cleanup);

const OLD_ID = "0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const TS = "2026-10-18T22-11-00-000Z";

/** omp's fixed-width (256 bytes with its newline) title slot line, without the newline. */
function titleSlot(): string {
	const mk = (pad: string) => JSON.stringify({ type: "title", v: 1, title: "My task", updatedAt: "2026-10-18T22:11:00.000Z", pad });
	return mk(" ".repeat(255 - mk("").length));
}

const headerOf = (cwd: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "session", version: 3, id: OLD_ID, timestamp: "2026-10-18T22:11:00.000Z", cwd, title: "t", ...extra });

const msg = (id: string, parentId: string | null, role: string, content: unknown = "x") =>
	JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-18T22:11:01.000Z", message: { role, content } });
const card = (id: string, parentId: string | null, customType = "omp-cloud") =>
	JSON.stringify({ type: "custom_message", id, parentId, customType, content: "[cloud] x", display: true, details: { kind: "turn" } });

interface Entry {
	id?: string;
	parentId?: string | null;
	type: string;
	customType?: string;
	parentSession?: string;
}
const parse = (text: string): Entry[] =>
	text
		.trimEnd()
		.split("\n")
		.map(l => JSON.parse(l) as Entry);

describe("rewriteConversation", () => {
	const fixtureLines = (): string[] => [
		titleSlot(),
		headerOf("/work/app"),
		JSON.stringify({ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: 'type":"session" in text, é ü 日本' }] } }),
		JSON.stringify({ type: "message", id: "e2", message: { role: "user", content: [{ type: "image", data: "blob:sha256:" + "a".repeat(64) }] } }),
		"",
	];

	test("changes only the session header, which is not on the first line: new id, parentSession set, everything else byte-identical", () => {
		const lines = fixtureLines();
		const origPath = `/home/u/.omp/agent/sessions/--work-app--/${TS}_${OLD_ID}.jsonl`;
		const newId = uuidv7();
		const out = rewriteConversation(Buffer.from(lines.join("\n")), origPath, newId);

		const got = out.data.toString("utf8").split("\n");
		expect(got).toHaveLength(lines.length);
		for (const i of [0, 2, 3, 4]) expect(got[i]).toBe(lines[i] as string);
		const header = JSON.parse(got[1] as string) as Record<string, unknown>;
		expect(header).toEqual({
			type: "session",
			version: 3,
			id: newId,
			timestamp: "2026-10-18T22:11:00.000Z",
			cwd: "/work/app",
			title: "t",
			parentSession: origPath,
		});
		expect(Object.keys(header).slice(0, 6)).toEqual(["type", "version", "id", "timestamp", "cwd", "title"]);
		// The title slot keeps its fixed 256-byte width.
		expect(Buffer.byteLength((got[0] as string) + "\n")).toBe(256);
		expect(out.filename).toBe(`${TS}_${newId}.jsonl`);
		expect(out.filename).toMatch(/^[A-Za-z0-9._-]+\.jsonl$/);
		expect(out.oldId).toBe(OLD_ID);
		expect(out.newId).toBe(newId);
	});

	test("the default new id is a fresh UUIDv7 each time", () => {
		const text = Buffer.from(`${headerOf("/w")}\n`);
		const a = rewriteConversation(text, `/s/${TS}_${OLD_ID}.jsonl`);
		const b = rewriteConversation(text, `/s/${TS}_${OLD_ID}.jsonl`);
		expect(a.newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(a.newId).not.toBe(b.newId);
		expect(a.newId).not.toBe(OLD_ID);
	});

	test("replaces an existing parentSession and tolerates a file without a title slot or trailing newline", () => {
		const header = JSON.stringify({ type: "session", id: OLD_ID, parentSession: "/old/parent.jsonl" });
		const out = rewriteConversation(Buffer.from(`${header}\n{"type":"message"}`), `/s/${TS}_${OLD_ID}.jsonl`, "new-id");
		const [h, rest] = out.data.toString("utf8").split("\n");
		expect(JSON.parse(h as string)).toEqual({ type: "session", id: "new-id", parentSession: `/s/${TS}_${OLD_ID}.jsonl` });
		expect(rest).toBe('{"type":"message"}');
	});

	test("text that mentions the session header is not mistaken for it", () => {
		const chatter = JSON.stringify({ type: "message", id: "e0", message: { role: "user", content: 'a line with "type":"session" inside' } });
		const out = rewriteConversation(Buffer.from([chatter, headerOf("/w")].join("\n")), `/s/${TS}_${OLD_ID}.jsonl`, "nid");
		const [first, second] = out.data.toString("utf8").split("\n");
		expect(first).toBe(chatter);
		expect(JSON.parse(second as string)).toMatchObject({ type: "session", id: "nid" });
	});

	test("filename falls back to appending the id when the original name does not embed the old id", () => {
		const header = JSON.stringify({ type: "session", id: OLD_ID });
		expect(rewriteConversation(Buffer.from(header), "/s/custom.jsonl", "nid").filename).toBe("custom_nid.jsonl");
	});

	test("a file without a session header is an error", () => {
		expect(() => rewriteConversation(Buffer.from('{"type":"message"}\n'), "/s/x.jsonl")).toThrow("no session header");
	});

	describe("cards", () => {
		const header = headerOf("/work/app");
		const build = (...lines: string[]) => Buffer.from(`${[header, ...lines].join("\n")}\n`);

		test("drops cards and re-links their children to the nearest surviving ancestor", () => {
			const keep = msg("e1", null, "user");
			const other = card("k1", "e1", "something-else");
			const out = rewriteConversation(
				build(keep, card("c1", "e1"), card("c2", "c1"), msg("e2", "c2", "assistant"), card("c3", "e2"), msg("e3", "c3", "user"), other),
				`/s/${TS}_${OLD_ID}.jsonl`,
				"nid",
			);
			const entries = parse(out.data.toString("utf8"));
			expect(entries.map(e => e.id)).toEqual(["nid", "e1", "e2", "e3", "k1"]);
			expect(Object.fromEntries(entries.filter(e => e.id !== "nid").map(e => [e.id, e.parentId]))).toEqual({ e1: null, e2: "e1", e3: "e2", k1: "e1" });
			expect(out.droppedCards).toBe(3);
			// Lines that need no change stay byte-identical.
			const lines = out.data.toString("utf8").split("\n");
			expect(lines).toContain(keep);
			expect(lines).toContain(other);
		});

		test("a card at the root leaves its children as roots", () => {
			const out = rewriteConversation(build(card("c1", null), msg("e1", "c1", "user")), "/s/x.jsonl", "nid");
			const entries = parse(out.data.toString("utf8"));
			expect(entries.map(e => e.id)).toEqual(["nid", "e1"]);
			expect(entries[1]?.parentId).toBeNull();
		});

		test("text that merely mentions the card type is not a card", () => {
			const chatter = msg("e1", null, "user", 'a custom_message with customType "omp-cloud"');
			const out = rewriteConversation(build(chatter), "/s/x.jsonl", "nid");
			expect(out.droppedCards).toBe(0);
			expect(out.data.toString("utf8").split("\n")).toContain(chatter);
		});

		test("a conversation without cards is unchanged apart from the header", () => {
			const body = [msg("e1", null, "user"), msg("e2", "e1", "assistant")];
			const out = rewriteConversation(build(...body), "/s/x.jsonl", "nid");
			expect(out.data.toString("utf8").split("\n").slice(1)).toEqual([...body, ""]);
			expect(out.droppedCards).toBe(0);
			expect(out.droppedForToolCall).toBe(0);
		});
	});

	describe("tool-call cut", () => {
		const build = (...lines: string[]) => Buffer.from(`${[headerOf("/work/app"), ...lines].join("\n")}\n`);
		const call = (id: string) =>
			msg("a1", "e1", "assistant", [
				{ type: "text", text: "delegating" },
				{ type: "toolCall", id, name: "cloud", arguments: { op: "delegate" } },
			]);

		test("a delegation cuts the assistant message with the pending tool call and everything after it", () => {
			const earlier = msg("a0", null, "assistant", [{ type: "toolCall", id: "call_0", name: "read", arguments: {} }]);
			const lines = [earlier, msg("e1", "a0", "user"), call("call_42"), msg("r1", "a1", "toolResult"), card("c1", "r1"), msg("e9", "c1", "user")];
			const out = rewriteConversation(build(...lines), "/s/x.jsonl", "nid", { dropFromToolCall: "call_42" });
			expect(parse(out.data.toString("utf8")).map(e => e.id)).toEqual(["nid", "a0", "e1"]);
			expect(out.droppedForToolCall).toBe(4);
		});

		test("the cut ends the file at the last kept line with its newline", () => {
			const keepA = msg("e1", null, "user");
			const out = rewriteConversation(build(keepA, call("call_42")), "/s/x.jsonl", "nid", { dropFromToolCall: "call_42" });
			expect(out.data.toString("utf8").endsWith(`${keepA}\n`)).toBe(true);
			expect(out.data.toString("utf8")).not.toContain("call_42");
		});

		test("the id must name a tool call of an assistant message: user text that repeats it is not cut", () => {
			const mention = msg("e1", null, "user", "call_42 is the id");
			const kept = rewriteConversation(build(mention, msg("e2", "e1", "assistant")), "/s/x.jsonl", "nid", { dropFromToolCall: "call_42" });
			expect(kept.droppedForToolCall).toBe(0);
			expect(parse(kept.data.toString("utf8")).map(e => e.id)).toEqual(["nid", "e1", "e2"]);
		});

		test("an id nothing carries cuts nothing", () => {
			const out = rewriteConversation(build(msg("e1", null, "user")), "/s/x.jsonl", "nid", { dropFromToolCall: "call_missing" });
			expect(out.droppedForToolCall).toBe(0);
			expect(parse(out.data.toString("utf8")).map(e => e.id)).toEqual(["nid", "e1"]);
		});
	});
});

describe("uuidv7", () => {
	test("has version 7, the RFC 4122 variant and a millisecond timestamp prefix", () => {
		const now = 1_760_000_000_123;
		const id = uuidv7(now);
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(now);
		expect(uuidv7(now)).not.toBe(id);
	});
});

interface Session {
	agentDir: string;
	cwd: string;
	file: string;
}

/** A session in a throwaway agent dir: title slot, header, a user message, a card, a delegating call, and one artifact. */
async function makeSession(): Promise<Session> {
	const agentDir = await tmp("omp-cloud-agent-");
	const cwd = await tmp("omp-cloud-cwd-");
	const dir = join(agentDir, "sessions", "--work--");
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${TS}_${OLD_ID}.jsonl`);
	const lines = [
		titleSlot(),
		headerOf(cwd),
		msg("e1", null, "user", [{ type: "text", text: "hello é" }]),
		card("c1", "e1"),
		msg("e2", "c1", "assistant", [{ type: "text", text: "done" }]),
		msg("a9", "e2", "assistant", [{ type: "toolCall", id: "call_cloud", name: "cloud", arguments: { op: "delegate" } }]),
		"",
	];
	await writeFile(file, lines.join("\n"));
	await mkdir(join(dir, `${TS}_${OLD_ID}`), { recursive: true });
	await writeFile(join(dir, `${TS}_${OLD_ID}`, "artifact.txt"), "artifact bytes");
	return { agentDir, cwd, file };
}

describe("packConversation", () => {
	test("no session file, or one missing on disk, is no conversation", async () => {
		const tmpDir = await tmp();
		expect(await packConversation({ sessionFile: undefined, tmpDir })).toEqual({ kind: "none" });
		expect(await packConversation({ sessionFile: join(await tmp(), "gone.jsonl"), tmpDir })).toEqual({ kind: "none" });
	});

	test("a session file over the 64 MiB cap is too-large and nothing is written", async () => {
		const file = join(await tmp(), "big.jsonl");
		await Bun.write(file, new Uint8Array(MAX_CONVERSATION_BYTES + 1));
		const tmpDir = await tmp();
		expect(await packConversation({ sessionFile: file, tmpDir })).toEqual({ kind: "too-large", bytes: MAX_CONVERSATION_BYTES + 1 });
		await expect(stat(join(tmpDir, "conversation"))).rejects.toThrow();
	});

	test("a file that is not a session fails with the rewrite error, before omp is run", async () => {
		const file = join(await tmp(), "x.jsonl");
		await writeFile(file, '{"type":"message"}\n');
		const tmpDir = await tmp();
		await expect(packConversation({ sessionFile: file, tmpDir })).rejects.toThrow("no session header");
		await expect(stat(join(tmpDir, "conversation.tar"))).rejects.toThrow();
	});

	test("writes the fork and its artifacts, packs them with `omp session pack`; the archive unpacks to a session with the new id", async () => {
		const s = await makeSession();
		const tmpDir = await tmp("omp-cloud-pack-");
		const r = await packConversation({ sessionFile: s.file, tmpDir, env: { PI_CODING_AGENT_DIR: s.agentDir }, dropFromToolCall: "call_cloud" });
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;

		expect(r.path).toBe(join(tmpDir, "conversation.tar"));
		expect((await stat(r.path)).size).toBe(r.bytes);
		expect(r.oldId).toBe(OLD_ID);
		expect(r.newId).not.toBe(OLD_ID);
		expect(r.filename).toBe(`${TS}_${r.newId}.jsonl`);
		expect(r.droppedCards).toBe(1);
		expect(r.droppedForToolCall).toBe(1);

		// The fork and the copy of the artifacts sit next to each other in the scratch dir.
		const forkPath = join(tmpDir, "conversation", r.filename);
		expect(await readFile(join(forkPath.replace(/\.jsonl$/, ""), "artifact.txt"), "utf8")).toBe("artifact bytes");
		// The owner's own session is untouched.
		expect(await readFile(s.file, "utf8")).toContain("call_cloud");

		const home = await ompHome();
		const { file: unpacked } = await syncInto(home, r.path, await tmp("omp-cloud-cwd-"));
		expect(unpacked.startsWith(home.sessionsRoot + "/")).toBe(true);
		const entries = parse(await readFile(unpacked, "utf8"));
		const header = entries.find(e => e.type === "session");
		expect(header?.id).toBe(r.newId);
		expect(header?.id).not.toBe(OLD_ID);
		expect(header?.parentSession).toBe(s.file);
		// cards are gone, the delegating call is cut, ordinary entries remain
		expect(entries.some(e => e.type === "custom_message" && e.customType === "omp-cloud")).toBe(false);
		expect(entries.map(e => e.id)).toContain("e2");
		expect(entries.map(e => e.id)).not.toContain("a9");
		expect(entries.find(e => e.id === "e2")?.parentId).toBe("e1");
		expect(await readFile(join(unpacked.replace(/\.jsonl$/, ""), "artifact.txt"), "utf8")).toBe("artifact bytes");
	});

	test("a session without an artifacts directory packs as well", async () => {
		const s = await makeSession();
		await Bun.$`rm -rf ${join(s.file.replace(/\.jsonl$/, ""))}`.quiet();
		const tmpDir = await tmp("omp-cloud-pack-");
		const r = await packConversation({ sessionFile: s.file, tmpDir, env: { PI_CODING_AGENT_DIR: s.agentDir } });
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.droppedForToolCall).toBe(0);
		expect((await stat(r.path)).isFile()).toBe(true);
		await expect(stat(join(tmpDir, "conversation", r.filename.replace(/\.jsonl$/, "")))).rejects.toThrow();
	});
});
