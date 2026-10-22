import { isRecord } from "../guards";
import type { ThreadMcpServer } from "../store/types";

/** `name: value` strings of a record; null when `value` is not one. */
function stringRecord(value: unknown): Record<string, string> | null {
	if (!isRecord(value)) return null;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") return null;
		out[key] = entry;
	}
	return out;
}

/** The `mcp` list of a parsed `secrets.json`; absent is empty. Throws `Error("secrets.json is malformed")` for any other shape. */
export function parseMcpServers(value: unknown): ThreadMcpServer[] {
	if (value === undefined) return [];
	const malformed = () => new Error("secrets.json is malformed");
	if (!Array.isArray(value)) throw malformed();
	return value.map((entry: unknown): ThreadMcpServer => {
		if (!isRecord(entry) || typeof entry.name !== "string") throw malformed();
		if (entry.type === "http") {
			const headers = stringRecord(entry.headers);
			if (typeof entry.url !== "string" || headers === null) throw malformed();
			return { name: entry.name, type: "http", url: entry.url, headers };
		}
		if (entry.type === "stdio") {
			const env = stringRecord(entry.env);
			if (typeof entry.command !== "string" || !Array.isArray(entry.args) || !entry.args.every((arg: unknown) => typeof arg === "string") || env === null) throw malformed();
			if (entry.cwd !== undefined && typeof entry.cwd !== "string") throw malformed();
			return { name: entry.name, type: "stdio", command: entry.command, args: entry.args as string[], env, ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }) };
		}
		throw malformed();
	});
}
