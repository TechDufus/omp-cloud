import type { Sandbox } from "e2b";

/** The longest the cleanup may take in the guest. */
const TIMEOUT_MS = 20_000;

/**
 * Prints and destroys every established IPv4 TCP socket whose local address is no longer on an interface of the guest.
 *
 * vmon does not keep a paused sandbox's tap lease: another sandbox may take its /30, so the resume hands the guest a new
 * address. A connection the guest opened under the old one (the idle keep-alive connection omp holds to its model) is
 * dead for good: nothing answers it, and a request written to it hangs until TCP gives up, many minutes later. Destroying
 * it (`ss -K`, root) makes the next request open a new connection. Loopback and sockets on a current address are left
 * alone, so a request that is in flight on a valid connection is never cut.
 */
export const DROP_STALE_SOCKETS = [
	"have=$(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1)",
	"for a in $(ss -tnH | awk '{print $4}' | sed -n 's/^\\([0-9][0-9.]*\\):[0-9]*$/\\1/p' | sort -u); do",
	'\tcase " $(echo $have) " in',
	"\t\t*\" $a \"*) ;;",
	'\t\t*) ss -K -tn src "$a" >/dev/null 2>&1 && echo "$a" ;;',
	"\tesac",
	"done",
].join("\n");

/**
 * Drops the guest's connections that belong to an address it no longer has (see {@link DROP_STALE_SOCKETS}). Returns the
 * addresses whose sockets were destroyed, `[]` when nothing was stale. Best effort: a sandbox that cannot run it (no root,
 * no `ss`) is left as it is and the result is `[]`.
 */
export async function dropStaleSockets(sandbox: Sandbox): Promise<string[]> {
	try {
		const result = await sandbox.commands.run(DROP_STALE_SOCKETS, { user: "root", timeoutMs: TIMEOUT_MS });
		return result.stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
	} catch {
		return [];
	}
}
