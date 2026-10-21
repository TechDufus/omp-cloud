/**
 * Identity of a repository across clients: the same repo reached over https, scp-style ssh,
 * `ssh://` or `git://` is one group. Used to group `/cloud list` by repository.
 */

/** A remote URL reduced to what names the repository: lower-case host and the path without `.git`. */
export interface NormalizedRemote {
	host: string;
	/** `owner/repo` (more segments for nested groups); case kept, no leading or trailing slash. */
	path: string;
}

/** What names a thread's repository: its remote when it has one, else its name, else where it lives. */
export interface RepoRef {
	remoteURL: string;
	name: string;
	workspace: string;
}

const URL_SCHEMES: Record<string, true> = { "http:": true, "https:": true, "ssh:": true, "git:": true, "git+ssh:": true, "ssh+git:": true };
const WEB_SCHEMES: Record<string, true> = { "http:": true, "https:": true };

/**
 * `host` and `path` of a remote; undefined for a local path, `file://` or anything without a host.
 * An ssh or git remote drops its port (it is the transport's, not the repository's); a web remote keeps a non-default one.
 */
export function normalizeRemote(remoteURL: string): NormalizedRemote | undefined {
	const url = remoteURL.trim();
	if (url === "") return undefined;
	let host: string;
	let rawPath: string;
	if (url.includes("://")) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return undefined;
		}
		if (URL_SCHEMES[parsed.protocol] !== true) return undefined;
		host = WEB_SCHEMES[parsed.protocol] === true ? parsed.host : parsed.hostname;
		rawPath = parsed.pathname;
	} else {
		// scp syntax: [user@]host:path. A one-letter "host" is a Windows drive, and a path with a slash before the colon is local.
		const m = /^(?:[^@/:\s]+@)?([^@/:\s]{2,}):(?!\/\/)(.*)$/.exec(url);
		if (!m) return undefined;
		host = m[1] ?? "";
		rawPath = m[2] ?? "";
	}
	const path = rawPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").replace(/\/+$/, "");
	return host === "" || path === "" ? undefined : { host: host.toLowerCase(), path };
}

/** The group key: `host/path` of the remote, else `name:<name>`, else `path:<workspace>`; `unknown` when the thread names nothing. */
export function repoKey(ref: RepoRef): string {
	const remote = normalizeRemote(ref.remoteURL);
	if (remote) return `${remote.host}/${remote.path}`;
	if (ref.name !== "") return `name:${ref.name}`;
	if (ref.workspace !== "") return `path:${ref.workspace}`;
	return "unknown";
}

/** What a group is called: the `owner/repo` path of the remote, else the name, else the last segment of the workspace. */
export function repoLabel(ref: RepoRef): string {
	const remote = normalizeRemote(ref.remoteURL);
	if (remote) return remote.path;
	if (ref.name !== "") return ref.name;
	return ref.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "unknown";
}
