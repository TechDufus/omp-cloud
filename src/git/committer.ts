import type { GitHubApp } from "../github/app";

/** A commit's committer identity. */
export interface Committer {
	name: string;
	email: string;
}

/**
 * The committer of signed commits: `configured` (the `git.committer` setting, `Name <email>`) when set, else the GitHub
 * App owner's noreply identity, else null, which keeps each commit's own committer.
 */
export function effectiveCommitter(configured: string, github: Pick<GitHubApp, "committer">): Committer | null {
	const match = /^([^<>\n]+) <([^<>\s]+@[^<>\s]+)>$/.exec(configured);
	if (match?.[1] !== undefined && match[2] !== undefined) return { name: match[1], email: match[2] };
	return github.committer();
}
