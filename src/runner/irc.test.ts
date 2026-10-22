import { describe, expect, test } from "bun:test";
import type { Thread } from "../store/types";
import { MAX_TEXT_BYTES } from "../store/types";
import * as extension from "./vm-extension/irc-peer";
import {
	boundedIrcBody,
	IRC_COMMAND,
	IRC_FRAME_KIND,
	IRC_STATUS_KEY,
	PARENT_AGENT_ID,
	ircConfigJson,
	ircDelivered,
	ircInCommand,
	ircPlainText,
	parentIdentity,
	parseIrcFrame,
	turnMessage,
	type IrcIn,
} from "./irc";

function statusFrame(payload: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "extension_ui_request", method: "setStatus", statusKey: IRC_STATUS_KEY, statusText: JSON.stringify(payload), ...overrides };
}

const VALID = { kind: IRC_FRAME_KIND, id: "m1", from: "Main", to: "Parent", body: "a question", replyTo: "r1" };

describe("parseIrcFrame", () => {
	test("reads a valid frame", () => {
		expect(parseIrcFrame(statusFrame(VALID))).toEqual({ id: "m1", from: "Main", to: "Parent", body: "a question", replyTo: "r1" });
	});

	test("an absent or non-string replyTo is an empty string", () => {
		const { replyTo: _replyTo, ...withoutReply } = VALID;
		expect(parseIrcFrame(statusFrame(withoutReply))?.replyTo).toBe("");
		expect(parseIrcFrame(statusFrame({ ...VALID, replyTo: 7 }))?.replyTo).toBe("");
	});

	test("a frame of another method, key or kind is not a message", () => {
		expect(parseIrcFrame(statusFrame(VALID, { method: "notify" }))).toBeNull();
		expect(parseIrcFrame(statusFrame(VALID, { statusKey: "other" }))).toBeNull();
		expect(parseIrcFrame(statusFrame({ ...VALID, kind: "other" }))).toBeNull();
		expect(parseIrcFrame(statusFrame({ ...VALID, kind: undefined }))).toBeNull();
	});

	test("statusText that is not a string, not JSON or not an object is not a message", () => {
		expect(parseIrcFrame(statusFrame(VALID, { statusText: undefined }))).toBeNull();
		expect(parseIrcFrame(statusFrame(VALID, { statusText: 5 }))).toBeNull();
		expect(parseIrcFrame(statusFrame(VALID, { statusText: "not json" }))).toBeNull();
		expect(parseIrcFrame(statusFrame(VALID, { statusText: "[1]" }))).toBeNull();
		expect(parseIrcFrame(statusFrame(VALID, { statusText: "null" }))).toBeNull();
		expect(parseIrcFrame({})).toBeNull();
	});

	test.each(["id", "from", "to", "body"])("a missing, empty or non-string %s is not a message", field => {
		expect(parseIrcFrame(statusFrame({ ...VALID, [field]: undefined }))).toBeNull();
		expect(parseIrcFrame(statusFrame({ ...VALID, [field]: "" }))).toBeNull();
		expect(parseIrcFrame(statusFrame({ ...VALID, [field]: 3 }))).toBeNull();
	});

	test("a blank body is not a message", () => {
		expect(parseIrcFrame(statusFrame({ ...VALID, body: " \n\t" }))).toBeNull();
	});

	test("ids, senders and recipients longer than 200 characters are not messages", () => {
		for (const field of ["id", "from", "to"]) {
			expect(parseIrcFrame(statusFrame({ ...VALID, [field]: "a".repeat(200) }))).not.toBeNull();
			expect(parseIrcFrame(statusFrame({ ...VALID, [field]: "a".repeat(201) }))).toBeNull();
		}
	});

	test("a body of exactly MAX_TEXT_BYTES bytes arrives whole, with no marker", () => {
		const exact = "x".repeat(MAX_TEXT_BYTES);
		expect(parseIrcFrame(statusFrame({ ...VALID, body: exact }))?.body).toBe(exact);
		const multi = "é".repeat(MAX_TEXT_BYTES / 2);
		expect(parseIrcFrame(statusFrame({ ...VALID, body: multi }))?.body).toBe(multi);
	});

	test("one byte over is cut with a marker that names the size, the limit and where the whole text is", () => {
		const body = parseIrcFrame(statusFrame({ ...VALID, body: "x".repeat(MAX_TEXT_BYTES + 1) }))?.body ?? "";
		expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
		expect(body.startsWith("xxxx")).toBe(true);
		expect(body).toContain(`this message was cut: it is ${MAX_TEXT_BYTES + 1} bytes and the limit is ${MAX_TEXT_BYTES}`);
		expect(body).toContain("history://");
		expect(body.endsWith("]")).toBe(true);
	});

	test("a long body keeps as much as fits next to the marker and is within the limit to the byte", () => {
		const body = boundedIrcBody("x".repeat(MAX_TEXT_BYTES * 3));
		expect(Buffer.byteLength(body)).toBe(MAX_TEXT_BYTES);
		expect(body).toContain(`it is ${MAX_TEXT_BYTES * 3} bytes`);
	});

	test("the limit counts bytes: multi-byte text over it is cut on a character boundary", () => {
		const text = "é".repeat(MAX_TEXT_BYTES / 2 + 1);
		const body = boundedIrcBody(text);
		expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
		const kept = body.slice(0, body.indexOf("\n\n[omp-cloud:"));
		expect(kept).toBe("é".repeat(kept.length));
		expect(body).toContain(`it is ${MAX_TEXT_BYTES + 2} bytes`);
		// four-byte characters (surrogate pairs) are never split either
		const emoji = boundedIrcBody("😀".repeat(MAX_TEXT_BYTES / 4 + 1));
		expect(emoji).not.toContain("\uFFFD");
		expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
	});

	test("an over-long replyTo is cut to 200 characters", () => {
		expect(parseIrcFrame(statusFrame({ ...VALID, replyTo: "r".repeat(500) }))?.replyTo).toBe("r".repeat(200));
	});
});

describe("ircInCommand", () => {
	test("is the exact /irc-in line with the message as JSON", () => {
		const message: IrcIn = { id: "m1", from: "alice", body: "hi", replyTo: "r1" };
		expect(ircInCommand(message)).toBe('/irc-in {"id":"m1","from":"alice","body":"hi","replyTo":"r1"}');
	});

	test("omits an empty replyTo", () => {
		expect(ircInCommand({ id: "m1", from: "alice", body: "hi", replyTo: "" })).toBe('/irc-in {"id":"m1","from":"alice","body":"hi"}');
	});

	test("round-trips through the JSON after the command", () => {
		const message: IrcIn = { id: "m-2", from: "bob.1", body: 'line one\nline "two" \\ ünï 🙂', replyTo: "r2" };
		const line = ircInCommand(message);
		expect(line.startsWith(`/${IRC_COMMAND} `)).toBe(true);
		expect(JSON.parse(line.slice(`/${IRC_COMMAND} `.length))).toEqual(message);
	});

	test("stays one line however many lines the body has", () => {
		expect(ircInCommand({ id: "m", from: "a", body: "a\nb\r\nc", replyTo: "" })).not.toContain("\n");
	});
});

describe("ircPlainText", () => {
	test("names the sender and carries the body", () => {
		expect(ircPlainText({ id: "m1", from: "alice", body: "hello", replyTo: "" })).toBe("Message from agent alice:\n\nhello");
	});

	test("names the message it replies to", () => {
		expect(ircPlainText({ id: "m1", from: "alice", body: "hello", replyTo: "r1" })).toBe("Message from agent alice (reply to r1):\n\nhello");
	});
});

describe("ircDelivered", () => {
	const message: IrcIn = { id: "m1", from: "alice", body: "hello", replyTo: "" };

	test("a native irc:incoming record with the message's id counts", () => {
		const messages = [
			{ role: "user", content: "x" },
			{ role: "custom", customType: "irc:incoming", details: { id: "m1" } },
		];
		expect(ircDelivered(messages, message, "")).toBe(true);
	});

	test("a record of another id, role or type does not", () => {
		expect(ircDelivered([{ role: "custom", customType: "irc:incoming", details: { id: "m2" } }], message, "")).toBe(false);
		expect(ircDelivered([{ role: "user", customType: "irc:incoming", details: { id: "m1" } }], message, "")).toBe(false);
		expect(ircDelivered([{ role: "custom", customType: "other", details: { id: "m1" } }], message, "")).toBe(false);
		expect(ircDelivered([{ role: "custom", customType: "irc:incoming" }], message, "")).toBe(false);
		expect(ircDelivered([{ role: "custom", customType: "irc:incoming", details: "m1" }], message, "")).toBe(false);
		expect(ircDelivered(["junk", null, 3], message, "")).toBe(false);
	});

	test("the plain text as the last user message counts", () => {
		expect(ircDelivered([], message, ircPlainText(message).trim())).toBe(true);
	});

	test("neither a record nor the plain text does not count", () => {
		expect(ircDelivered([], message, "")).toBe(false);
		expect(ircDelivered([], message, "something else")).toBe(false);
	});
});

describe("turnMessage", () => {
	test("maps an irc turn to its message", () => {
		expect(turnMessage({ ircId: "m1", ircFrom: "alice", text: "hello", ircReplyTo: "r1" })).toEqual({ id: "m1", from: "alice", body: "hello", replyTo: "r1" });
		expect(turnMessage({ ircId: "m2", ircFrom: "bob", text: "x", ircReplyTo: "" }).replyTo).toBe("");
	});
});

function thread(overrides: Partial<Thread>): Thread {
	return {
		id: "aaaaaaaaaaaa",
		owner: "owner",
		phase: "idle",
		title: "t",
		model: "",
		thinking: "",
		repo: { name: "r", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "h", localBranch: "" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
		error: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		name: "",
		archivedAt: null,
		restoreHead: "",
		context: null,
		origin: "",
		ref: "",
		session: "",
		scratch: false,
		pr: null,
		mcpServers: [],
		setup: null,
		...overrides,
	};
}

describe("parentIdentity", () => {
	test("is called Parent", () => {
		const identity = parentIdentity(thread({}));
		expect(identity.id).toBe(PARENT_AGENT_ID);
		expect(identity.displayName).toBe("Parent");
	});

	test("a tool-started thread names the delegating omp agent and its ref", () => {
		const { description } = parentIdentity(thread({ origin: "tool", ref: "plan-7" }));
		expect(description).toContain("omp agent that delegated this thread");
		expect(description).toContain("(plan-7)");
	});

	test("a user-started thread names the person or session and its ref", () => {
		const { description } = parentIdentity(thread({ origin: "user", ref: "my-ref" }));
		expect(description).toContain("person or omp session that started this thread");
		expect(description).toContain("(my-ref)");
		expect(description).not.toContain("delegated");
	});

	test("without a ref no parentheses appear; an unknown origin reads as the user's", () => {
		const tool = parentIdentity(thread({ origin: "tool" })).description;
		expect(tool).not.toContain("(");
		const unknown = parentIdentity(thread({ origin: "" })).description;
		expect(unknown).toContain("person or omp session");
		expect(unknown).not.toContain("(");
	});
});

describe("ircConfigJson", () => {
	test("is JSON of the thread id and the parent, ending in a newline", () => {
		const t = thread({ origin: "tool", ref: "r1" });
		const json = ircConfigJson(t);
		expect(json.endsWith("\n")).toBe(true);
		expect(JSON.parse(json)).toEqual({ thread: t.id, parent: parentIdentity(t) });
	});
});

describe("the VM extension's constants", () => {
	test("are the runner's", () => {
		expect(extension.IRC_STATUS_KEY).toBe(IRC_STATUS_KEY);
		expect(extension.IRC_FRAME_KIND).toBe(IRC_FRAME_KIND);
		expect(extension.IRC_COMMAND).toBe(IRC_COMMAND);
	});
});
