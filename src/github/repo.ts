const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The owner and repository a normalized `https://github.com/<owner>/<repo>[.git]` URL names, or null for any other
 * form (another host, a port, credentials, a query, a deeper path, ssh).
 */
export function githubRepoOf(url: string): { owner: string; repo: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" || parsed.host !== "github.com") return null;
	if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
	const parts = parsed.pathname.split("/");
	if (parts.length !== 3 || parts[0] !== "") return null;
	const owner = parts[1] ?? "";
	let repo = parts[2] ?? "";
	if (repo.endsWith(".git")) repo = repo.slice(0, -4);
	if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
	return { owner, repo };
}
