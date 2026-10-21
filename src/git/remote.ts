/** Remote URL forms the service understands: how a configured git host is recognized and how its remote becomes an https URL. */

const SSH_SCHEMES: readonly string[] = ["ssh:", "git+ssh:", "ssh+git:"];
/** `[user@]host:path`, git's scp-like syntax (groups: the `user@`, the host, the path); a `host:` followed by `//` is a URL instead. */
const SCP_FORM = /^((?:[^@/:\s]+@)?)([^@/:\s]+):(?!\/\/)(.*)$/;

function parseUrl(raw: string): URL | null {
	if (!raw.includes("://")) return null;
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

/**
 * The host a remote names, lower-case: an http(s) URL's `host` (with `:port` when it is not the scheme's default),
 * the bare host of an ssh URL or of scp syntax (their port is not the https port); `""` for anything else.
 */
export function remoteHostOf(raw: string): string {
	const url = parseUrl(raw);
	if (url !== null) {
		if (url.protocol === "http:" || url.protocol === "https:") return url.host;
		return SSH_SCHEMES.includes(url.protocol) ? url.hostname : "";
	}
	return SCP_FORM.exec(raw)?.[2]?.toLowerCase() ?? "";
}

/**
 * The remote without credentials. An ssh URL or scp-like remote whose host is in `hosts` becomes
 * `https://<host>/<path>`, so the service can fetch what the owner pushes over ssh; every other remote is only stripped
 * of its userinfo.
 */
export function normalizeRemote(raw: string, hosts: readonly string[]): string {
	const url = parseUrl(raw);
	if (url !== null) {
		if (SSH_SCHEMES.includes(url.protocol) && hosts.includes(url.hostname)) return `https://${url.hostname}${url.pathname}${url.search}`;
		url.username = "";
		url.password = "";
		return url.href;
	}
	const scp = SCP_FORM.exec(raw);
	if (scp === null) return raw;
	const host = (scp[2] ?? "").toLowerCase();
	const path = scp[3] ?? "";
	return hosts.includes(host) ? `https://${host}/${path.replace(/^\/+/, "")}` : `${scp[2]}:${path}`;
}
