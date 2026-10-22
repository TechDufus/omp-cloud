/** Type guard shared by the plugin's boundaries. The plugin is self-contained: it never imports from the service's `src/`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a URL host name (`URL.hostname`) is this machine: `localhost`, `*.localhost`, `127.*`, `[::1]` or `0.0.0.0`. */
export function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "::1" || host === "0.0.0.0";
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
