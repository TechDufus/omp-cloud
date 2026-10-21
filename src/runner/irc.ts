/**
 * The runner's side of the thread's IRC with its peers (the other half runs in the VM: `vm-extension/irc-peer.ts`).
 *
 * - Out: the VM agent writes `agent://<peer>`; the extension turns the message into an `extension_ui_request` frame
 *   (`setStatus`, key {@link IRC_STATUS_KEY}) that {@link parseIrcFrame} reads off omp's stdout.
 * - In: a peer's message reaches the VM agent as the slash command {@link ircInCommand} (`/irc-in <json>`), which the
 *   extension hands to omp's own IRC delivery; without the extension {@link ircPlainText} stands in.
 */
import type { Thread, Turn } from "../store/types";
import { MAX_TEXT_BYTES } from "../store/types";
import { cutChars } from "../store/rules";
import { cutBytes } from "./ask";
import { isRecord } from "../guards";

/** The `setStatus` key and `kind` of an outgoing message's frame, and the command that delivers an incoming one: `vm-extension/irc-peer.ts` holds the same three. */
export const IRC_STATUS_KEY = "omp-cloud.irc";
export const IRC_FRAME_KIND = "omp-cloud.irc";
export const IRC_COMMAND = "irc-in";

/** The id the thread's parent has in the VM's registry, unless the VM agent is itself called that. */
export const PARENT_AGENT_ID = "Parent";

/** The longest id or sender a frame may carry; longer ones are not messages. */
const MAX_NAME_CHARS = 200;

/** A message the VM agent wrote, as the extension framed it. */
export interface IrcFrame {
	id: string;
	from: string;
	to: string;
	body: string;
	/** `""` for none. */
	replyTo: string;
}

/** A message for the VM agent. */
export interface IrcIn {
	id: string;
	from: string;
	body: string;
	replyTo: string;
}

/**
 * `body` as the thread's IRC allows it: at most `MAX_TEXT_BYTES` bytes of UTF-8 (the endpoint's limit, so a message either
 * way fits the same turn text and event). A longer one keeps its first part and ends with a marker that says it was cut, by
 * how much, and where the whole text is, so the receiver knows to read it; the cut never splits a character, and the part plus the
 * marker stay within the limit. Native omp IRC cuts nothing, so this is the one place a message is shortened.
 */
export function boundedIrcBody(body: string): string {
	const total = Buffer.byteLength(body);
	if (total <= MAX_TEXT_BYTES) return body;
	const marker = `\n\n[omp-cloud: this message was cut: it is ${total} bytes and the limit is ${MAX_TEXT_BYTES}. The whole text is in the sending agent's transcript (its write call): read history://<the sending agent's id>]`;
	return cutBytes(body, MAX_TEXT_BYTES - Buffer.byteLength(marker)) + marker;
}

/** The message of an `extension_ui_request` frame the extension sent; null for any other frame or a malformed message. The body goes through {@link boundedIrcBody}. */
export function parseIrcFrame(frame: Record<string, unknown>): IrcFrame | null {
	if (frame.method !== "setStatus" || frame.statusKey !== IRC_STATUS_KEY || typeof frame.statusText !== "string") return null;
	let payload: unknown;
	try {
		payload = JSON.parse(frame.statusText);
	} catch {
		return null;
	}
	if (!isRecord(payload) || payload.kind !== IRC_FRAME_KIND) return null;
	const { id, from, to, body, replyTo } = payload;
	if (typeof id !== "string" || typeof from !== "string" || typeof to !== "string" || typeof body !== "string") return null;
	if (id === "" || id.length > MAX_NAME_CHARS || from === "" || from.length > MAX_NAME_CHARS || to === "" || to.length > MAX_NAME_CHARS || body.trim() === "") return null;
	return {
		id,
		from,
		to,
		body: boundedIrcBody(body),
		replyTo: typeof replyTo === "string" ? cutChars(replyTo, MAX_NAME_CHARS) : "",
	};
}

/** The prompt that makes the VM extension deliver `message` to the agent as omp's own incoming IRC message. */
export function ircInCommand(message: IrcIn): string {
	return `/${IRC_COMMAND} ${JSON.stringify({ id: message.id, from: message.from, body: message.body, ...(message.replyTo === "" ? {} : { replyTo: message.replyTo }) })}`;
}

/** What the agent is told when the VM has no extension to deliver the message natively: the message as plain prompt text. */
export function ircPlainText(message: IrcIn): string {
	const reply = message.replyTo === "" ? "" : ` (reply to ${message.replyTo})`;
	return `Message from agent ${message.from}${reply}:\n\n${message.body}`;
}

/**
 * Whether omp's conversation already holds the message of an `irc` turn: its `irc:incoming` record (native delivery) or, for
 * the plain-text fallback, a last user message that is exactly the text. `messages` are omp's `get_messages`.
 */
export function ircDelivered(messages: readonly unknown[], message: IrcIn, lastUserText: string): boolean {
	const native = messages.some(
		m => isRecord(m) && m.role === "custom" && m.customType === "irc:incoming" && isRecord(m.details) && m.details.id === message.id,
	);
	return native || lastUserText === ircPlainText(message).trim();
}

/** The message an `irc` turn carries: its text is the body and its `by` the sender. */
export function turnMessage(turn: Pick<Turn, "ircId" | "ircFrom" | "text" | "ircReplyTo">): IrcIn {
	return { id: turn.ircId, from: turn.ircFrom, body: turn.text, replyTo: turn.ircReplyTo };
}

/** The parent of a thread as the VM agent sees it. */
export function parentIdentity(thread: Thread): { id: string; displayName: string; description: string } {
	const ref = thread.ref === "" ? "" : ` (${thread.ref})`;
	const description =
		thread.origin === "tool"
			? `the omp agent that delegated this thread to you${ref}; message it with a question or progress, it can reply later`
			: `the person or omp session that started this thread${ref}; message it with a question or progress, it can reply later`;
	return { id: PARENT_AGENT_ID, displayName: "Parent", description };
}

/** `~/.omp-cloud/irc.json` of a thread: what the VM extension reads to register the parent. */
export function ircConfigJson(thread: Thread): string {
	return `${JSON.stringify({ thread: thread.id, parent: parentIdentity(thread) }, null, 2)}\n`;
}
