import { SecretRefs } from "../git/secret";
import { ENV_NAME_PATTERN } from "../settings/registry";

/**
 * Resolves `update.token` the way the git hosts' credentials are: `!command` runs the command (its first word is logged,
 * never its output), the name of a set environment variable (upper case, as such names are written) gives that
 * variable's value, anything else is the token itself. Returns undefined for an empty reference. Throws SecretError when
 * a command fails.
 */
export function tokenResolver(
	env: Record<string, string | undefined> = process.env,
	log: (message: string) => void = (message) => console.log(`omp-cloud: ${message}`),
	secrets: SecretRefs = new SecretRefs(),
): (reference: string) => Promise<string | undefined> {
	const announced = new Set<string>();
	return async (reference) => {
		const value = reference.trim();
		if (value === "") return undefined;
		if (value.startsWith("!")) {
			const program = value.slice(1).trim().split(/\s+/)[0] ?? "";
			if (!announced.has(program)) {
				announced.add(program);
				log(`update.token runs ${program}`);
			}
			return secrets.resolve(value, "update.token");
		}
		if (ENV_NAME_PATTERN.test(value)) {
			const fromEnv = env[value];
			if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
		}
		return value;
	};
}
