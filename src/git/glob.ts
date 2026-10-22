/** Whether `value` matches `pattern`: `*` is any run of characters, including `/`; the whole value must match. */
export function globMatch(pattern: string, value: string): boolean {
	const parts = pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`^${parts.join(".*")}$`).test(value);
}
