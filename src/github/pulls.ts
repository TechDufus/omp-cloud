import { isRecord } from "../guards";
import { type GitHubApi, GitHubError } from "./api";

export const SECTION_BEGIN = "<!-- omp-cloud:begin -->";
export const SECTION_END = "<!-- omp-cloud:end -->";
/** The latest reply in the section is cut to this many characters. */
const MAX_REPLY_CHARS = 6000;

export type PullRequestAction = "opened" | "updated" | "unchanged" | "closed";

/** The omp-cloud section of a pull request's body: who made the change and its latest reply. */
export function pullRequestSection(input: { threadId: string; name: string; model: string; reply: string }): string {
	const reply = input.reply.length > MAX_REPLY_CHARS ? `${input.reply.slice(0, MAX_REPLY_CHARS)}…` : input.reply;
	return [
		SECTION_BEGIN,
		`**omp-cloud** thread \`${input.threadId}\` · ${input.name} · model \`${input.model}\``,
		"",
		reply,
		"",
		`Check it out locally: \`/cloud pull ${input.threadId}\``,
		SECTION_END,
	].join("\n");
}

/**
 * `body` with the text from the begin marker through the end marker replaced by `section`; with no markers, `section`
 * is appended after a blank line. Whatever the owner wrote outside the markers stays.
 */
export function replaceSection(body: string, section: string): string {
	const begin = body.indexOf(SECTION_BEGIN);
	const end = begin === -1 ? -1 : body.indexOf(SECTION_END, begin + SECTION_BEGIN.length);
	if (begin !== -1 && end !== -1) return body.slice(0, begin) + section + body.slice(end + SECTION_END.length);
	const text = body.trimEnd();
	return text === "" ? section : `${text}\n\n${section}`;
}

interface PullSummary {
	number: number;
	url: string;
	state: string;
	merged: boolean;
	body: string;
}

function parsePull(value: unknown): PullSummary | null {
	if (!isRecord(value) || typeof value.number !== "number" || typeof value.html_url !== "string") return null;
	return {
		number: value.number,
		url: value.html_url,
		state: typeof value.state === "string" ? value.state : "",
		merged: typeof value.merged_at === "string",
		body: typeof value.body === "string" ? value.body : "",
	};
}

/**
 * Opens the pull request of `head` into `base`, or brings the omp-cloud section of the branch's newest pull request up
 * to date. An open one is patched only when its body changes; a merged one (or none) gets a new pull request; one
 * closed without merging was rejected by the owner, so nothing is opened (`closed`).
 */
export async function upsertPullRequest(
	api: GitHubApi,
	token: string,
	input: { owner: string; repo: string; head: string; base: string; title: string; section: string; draft: boolean },
): Promise<{ number: number; url: string; action: PullRequestAction; draft: boolean }> {
	const auth = { kind: "bearer", value: token } as const;
	const pulls = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`;
	const listed = await api.request<unknown>("GET", `${pulls}?head=${encodeURIComponent(`${input.owner}:${input.head}`)}&state=all&per_page=1`, auth);
	const newest = Array.isArray(listed.json) ? parsePull(listed.json[0]) : null;
	if (newest !== null && newest.state === "open") {
		const body = replaceSection(newest.body, input.section);
		if (body === newest.body) return { number: newest.number, url: newest.url, action: "unchanged", draft: false };
		await api.request("PATCH", `${pulls}/${newest.number}`, auth, { body });
		return { number: newest.number, url: newest.url, action: "updated", draft: false };
	}
	if (newest !== null && !newest.merged) return { number: newest.number, url: newest.url, action: "closed", draft: false };
	const create = (draft: boolean) => api.request<unknown>("POST", pulls, auth, { title: input.title, head: input.head, base: input.base, body: input.section, draft });
	let created: unknown;
	let draft = input.draft;
	try {
		created = (await create(draft)).json;
	} catch (error) {
		if (!draft || !(error instanceof GitHubError) || error.status !== 422 || !/draft/i.test(error.message)) throw error;
		draft = false;
		created = (await create(false)).json;
	}
	const pull = parsePull(created);
	if (pull === null) throw new GitHubError(502, `POST ${pulls}: the answer is not a pull request`);
	return { number: pull.number, url: pull.url, action: "opened", draft };
}
