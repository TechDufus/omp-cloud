/** Which executable a git host's credential command starts, resolved the way `sh -c` finds it, for the startup log. */
import { access, constants } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** A word that is plainly a program name or path; anything else (`TOKEN=x cmd`, `$HOME/bin/x`, quotes) may hold a secret and is never reported. */
const PLAIN_WORD = /^[A-Za-z0-9_.+@:/-]+$/;

/** Where the credential command's executable is: its resolved `path`, or why it cannot be (`warning`). */
export type CredentialExecutable = { path: string } | { warning: string };

/**
 * The executable the `!command` credential starts: its first whitespace-separated word, an absolute path as given or a
 * bare name looked up on `searchPath`. Only that word is ever reported, never the rest of the command, which may embed a
 * secret.
 */
export async function credentialExecutable(credential: string, searchPath: string | undefined): Promise<CredentialExecutable> {
	const word = credential.replace(/^!/, "").trim().split(/\s+/, 1)[0] ?? "";
	if (!PLAIN_WORD.test(word) || word.includes("=")) {
		return { warning: "the command does not start with a plain program name, so its executable was not checked" };
	}
	if (isAbsolute(word)) {
		try {
			await access(word, constants.X_OK);
		} catch {
			return { warning: `${word} does not exist or is not executable` };
		}
		return { path: word };
	}
	const path = Bun.which(word, { PATH: searchPath ?? "" });
	return path === null ? { warning: `${word} is not on the service PATH or not executable` } : { path };
}
