/** Type guard shared by the plugin's boundaries. The plugin is self-contained: it never imports from the service's `src/`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object a structured event's text holds (`tool_start`, `usage`, `child_start`, ...); undefined when the text is not one. */
export function eventPayload(e: { text: string }): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(e.text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
