import { isRecord } from "../src/guards";

/** Text of an omp `AgentMessage`: `content` is a string or an array of `{ type: "text", text }` blocks. */
export function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("");
}

/** Texts of the `user` messages of a `get_messages` result, in order. */
export function userTexts(messages: readonly unknown[]): string[] {
	return messages.filter(m => isRecord(m) && m.role === "user").map(messageText);
}
