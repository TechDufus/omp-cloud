import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellQuote } from "../runner/exec";

/** What the credential helper of one git call answers. */
export interface HelperInput {
	/** The scheme of the remote (`https`): git asks with `protocol=`. */
	protocol: string;
	/** The remote's `host[:port]`: git asks with `host=`. */
	host: string;
	username: string;
	token: string;
}

/**
 * Writes the token (mode 0600) and the credential helper script (mode 0700) into `dir`, which must be private (0700),
 * and returns the helper's path. The script holds paths and the host, never the token: it answers `get` with the
 * username and the token file's content only when git asks for exactly `protocol` and `host`, so a redirect to another
 * host gets nothing.
 */
export async function writeCredentialHelper(dir: string, input: HelperInput): Promise<string> {
	const tokenFile = join(dir, "token");
	const helper = join(dir, "credential-helper");
	await writeFile(tokenFile, input.token, { mode: 0o600 });
	const script = `#!/bin/sh
[ "$1" = get ] || exit 0
protocol= host=
while IFS='=' read -r key value; do
	case $key in
		protocol) protocol=$value ;;
		host) host=$value ;;
	esac
done
[ "$protocol" = ${shellQuote(input.protocol)} ] && [ "$host" = ${shellQuote(input.host)} ] || exit 0
printf 'username=%s\\n' ${shellQuote(input.username)}
printf 'password=%s\\n' "$(cat ${shellQuote(tokenFile)})"
`;
	await writeFile(helper, script, { mode: 0o700 });
	return helper;
}

/** `text` with every secret and every URL's userinfo removed: what may reach an error, an event or a log. */
export function scrub(text: string, secrets: readonly string[]): string {
	let out = text.replace(/(\/\/)[^/\s@]*@/g, "$1");
	for (const secret of secrets) {
		if (secret !== "") out = out.replaceAll(secret, "***");
	}
	return out;
}
