import { describe, expect, test } from "bun:test";
import { GitHubApi } from "./api";
import { pullRequestSection, replaceSection, SECTION_BEGIN, SECTION_END, upsertPullRequest } from "./pulls";

interface Call {
	method: string;
	path: string;
	authorization: string | null;
	body: Record<string, unknown> | undefined;
}

/** A fake GitHub whose answers come from `handler`; every request is recorded. */
function fake(handler: (call: Call) => { status: number; json: unknown }): { api: GitHubApi; calls: Call[] } {
	const calls: Call[] = [];
	const api = new GitHubApi(async (url, init) => {
		const call: Call = {
			method: init.method ?? "GET",
			path: url.replace("https://api.github.com", ""),
			authorization: new Headers(init.headers).get("authorization"),
			body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
		};
		calls.push(call);
		const { status, json } = handler(call);
		return new Response(JSON.stringify(json), { status });
	});
	return { api, calls };
}

const SECTION = pullRequestSection({ threadId: "abc123", name: "Fix the thing", model: "anthropic/claude", reply: "Done.\n\nChanged two files." });
const INPUT = { owner: "acme", repo: "widgets", head: "omp-cloud/abc123", base: "main", title: "Fix the thing", section: SECTION, draft: true };

describe("pullRequestSection", () => {
	test("is the verbatim section", () => {
		expect(SECTION).toBe(
			[
				"<!-- omp-cloud:begin -->",
				"**omp-cloud** thread `abc123` · Fix the thing · model `anthropic/claude`",
				"",
				"Done.\n\nChanged two files.",
				"",
				"Check it out locally: `/cloud pull abc123`",
				"<!-- omp-cloud:end -->",
			].join("\n"),
		);
	});

	test("cuts a long reply to 6000 characters and marks the cut", () => {
		const section = pullRequestSection({ threadId: "t", name: "n", model: "m", reply: "x".repeat(6001) });
		expect(section).toContain(`${"x".repeat(6000)}…\n`);
		expect(section).not.toContain("x".repeat(6001));
		expect(pullRequestSection({ threadId: "t", name: "n", model: "m", reply: "x".repeat(6000) })).not.toContain("…");
	});
});

describe("replaceSection", () => {
	test("appends after a blank line when there are no markers, and is the section alone for an empty body", () => {
		expect(replaceSection("Owner text.\n", SECTION)).toBe(`Owner text.\n\n${SECTION}`);
		expect(replaceSection("", SECTION)).toBe(SECTION);
	});

	test("replaces only the text between the markers, keeping what the owner wrote around it", () => {
		const next = pullRequestSection({ threadId: "abc123", name: "Fix the thing", model: "m", reply: "Second reply with $& and $1" });
		const body = `Intro by the owner.\n\n${SECTION}\n\nFooter by the owner.`;
		expect(replaceSection(body, next)).toBe(`Intro by the owner.\n\n${next}\n\nFooter by the owner.`);
		expect(replaceSection(replaceSection(body, next), next)).toBe(replaceSection(body, next));
	});

	test("an end marker before the begin marker counts as no section", () => {
		const body = `${SECTION_END}\n${SECTION_BEGIN}`;
		expect(replaceSection(body, SECTION)).toBe(`${body}\n\n${SECTION}`);
	});
});

describe("upsertPullRequest", () => {
	test("opens a draft pull request when the branch has none", async () => {
		const { api, calls } = fake((call) =>
			call.method === "GET" ? { status: 200, json: [] } : { status: 201, json: { number: 7, html_url: "https://github.com/acme/widgets/pull/7" } },
		);
		expect(await upsertPullRequest(api, "ghs_tok", INPUT)).toEqual({ number: 7, url: "https://github.com/acme/widgets/pull/7", action: "opened", draft: true });
		expect(calls[0]).toMatchObject({ method: "GET", path: "/repos/acme/widgets/pulls?head=acme%3Aomp-cloud%2Fabc123&state=all&per_page=1", authorization: "Bearer ghs_tok" });
		expect(calls[1]).toMatchObject({ method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "Fix the thing", head: "omp-cloud/abc123", base: "main", body: SECTION, draft: true } });
	});

	test("draft follows the input", async () => {
		const { api, calls } = fake((call) => (call.method === "GET" ? { status: 200, json: [] } : { status: 201, json: { number: 8, html_url: "u" } }));
		const result = await upsertPullRequest(api, "t", { ...INPUT, draft: false });
		expect(result).toMatchObject({ action: "opened", draft: false });
		expect(calls[1]?.body?.draft).toBe(false);
	});

	test("a 422 about drafts is retried once without the draft flag", async () => {
		const { api, calls } = fake((call) => {
			if (call.method === "GET") return { status: 200, json: [] };
			return call.body?.draft === true
				? { status: 422, json: { message: "Draft pull requests are not supported in this repository." } }
				: { status: 201, json: { number: 9, html_url: "https://github.com/acme/widgets/pull/9" } };
		});
		expect(await upsertPullRequest(api, "t", INPUT)).toEqual({ number: 9, url: "https://github.com/acme/widgets/pull/9", action: "opened", draft: false });
		expect(calls.filter((c) => c.method === "POST").map((c) => c.body?.draft)).toEqual([true, false]);
	});

	test("any other 422 is an error", async () => {
		const { api, calls } = fake((call) => (call.method === "GET" ? { status: 200, json: [] } : { status: 422, json: { message: "Validation Failed" } }));
		await expect(upsertPullRequest(api, "t", INPUT)).rejects.toThrow("POST /repos/acme/widgets/pulls: Validation Failed");
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
	});

	test("updates the omp-cloud section of an open pull request and keeps the owner's text", async () => {
		const owner = "My own description.\n\n";
		const stale = pullRequestSection({ threadId: "abc123", name: "Fix the thing", model: "m", reply: "old" });
		const { api, calls } = fake((call) =>
			call.method === "GET"
				? { status: 200, json: [{ number: 3, html_url: "https://github.com/acme/widgets/pull/3", state: "open", merged_at: null, body: `${owner}${stale}\n\nMore owner text.` }] }
				: { status: 200, json: {} },
		);
		expect(await upsertPullRequest(api, "t", INPUT)).toMatchObject({ number: 3, url: "https://github.com/acme/widgets/pull/3", action: "updated" });
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ method: "PATCH", path: "/repos/acme/widgets/pulls/3", body: { body: `${owner}${SECTION}\n\nMore owner text.` } });
	});

	test("an open pull request whose body is current gets no PATCH", async () => {
		const { api, calls } = fake(() => ({ status: 200, json: [{ number: 3, html_url: "u3", state: "open", merged_at: null, body: `Mine.\n\n${SECTION}` }] }));
		expect(await upsertPullRequest(api, "t", INPUT)).toMatchObject({ number: 3, url: "u3", action: "unchanged" });
		expect(calls).toHaveLength(1);
	});

	test("an open pull request with no body gets the section", async () => {
		const { api, calls } = fake((call) => (call.method === "GET" ? { status: 200, json: [{ number: 4, html_url: "u4", state: "open", merged_at: null, body: null }] } : { status: 200, json: {} }));
		expect(await upsertPullRequest(api, "t", INPUT)).toMatchObject({ number: 4, action: "updated" });
		expect(calls[1]?.body).toEqual({ body: SECTION });
	});

	test("a merged pull request gets a new one for the new commits", async () => {
		const { api, calls } = fake((call) =>
			call.method === "GET"
				? { status: 200, json: [{ number: 5, html_url: "u5", state: "closed", merged_at: "2026-10-20T10:00:00Z", body: SECTION }] }
				: { status: 201, json: { number: 6, html_url: "u6" } },
		);
		expect(await upsertPullRequest(api, "t", INPUT)).toMatchObject({ number: 6, url: "u6", action: "opened" });
		expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
	});

	test("a pull request closed without merging is the owner's rejection: nothing is opened", async () => {
		const { api, calls } = fake(() => ({ status: 200, json: [{ number: 5, html_url: "u5", state: "closed", merged_at: null, body: SECTION }] }));
		expect(await upsertPullRequest(api, "t", INPUT)).toMatchObject({ number: 5, url: "u5", action: "closed" });
		expect(calls).toHaveLength(1);
	});
});
