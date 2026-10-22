import { describe, expect, test } from "bun:test";
import { GitHubApi, GitHubError } from "./api";

describe("GitHubApi.request", () => {
	test("sends the GitHub headers, the bearer token and the JSON body", async () => {
		let seen: { url: string; init: RequestInit } | null = null;
		const api = new GitHubApi(async (url, init) => {
			seen = { url, init };
			return new Response(JSON.stringify({ ok: true }), { status: 201 });
		});
		const result = await api.request<{ ok: boolean }>("POST", "/repos/o/r/pulls", { kind: "bearer", value: "tok" }, { title: "t" });
		expect(result).toEqual({ status: 201, json: { ok: true } });
		const sent = seen as unknown as { url: string; init: RequestInit };
		expect(sent.url).toBe("https://api.github.com/repos/o/r/pulls");
		expect(sent.init.method).toBe("POST");
		expect(sent.init.body).toBe('{"title":"t"}');
		const headers = new Headers(sent.init.headers);
		expect(headers.get("accept")).toBe("application/vnd.github+json");
		expect(headers.get("x-github-api-version")).toBe("2022-11-28");
		expect(headers.get("user-agent")).toStartWith("omp-cloud/");
		expect(headers.get("authorization")).toBe("Bearer tok");
	});

	test("no auth sends no Authorization header; an empty body is null", async () => {
		let headers: Headers | null = null;
		const api = new GitHubApi(async (_url, init) => {
			headers = new Headers(init.headers);
			return new Response(null, { status: 204 });
		});
		expect(await api.request("DELETE", "/x", { kind: "none" })).toEqual({ status: 204, json: null });
		expect((headers as unknown as Headers).has("authorization")).toBe(false);
	});

	test("a non-2xx answer throws GitHubError with the status and GitHub's message", async () => {
		const api = new GitHubApi(async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
		const error = await api.request("GET", "/app", { kind: "none" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitHubError);
		expect(error).toMatchObject({ status: 401, message: "GET /app: Bad credentials" });
	});

	test("an error without a JSON message falls back to the text", async () => {
		const api = new GitHubApi(async () => new Response("<html>gateway</html>", { status: 502 }));
		expect(await api.request("GET", "/x", { kind: "none" }).catch((e: unknown) => e)).toMatchObject({ status: 502, message: "GET /x: <html>gateway</html>" });
	});

	test("a network failure is GitHubError status 0", async () => {
		const api = new GitHubApi(async () => {
			throw new Error("connect ECONNREFUSED");
		});
		expect(await api.request("GET", "/x", { kind: "none" }).catch((e: unknown) => e)).toMatchObject({ status: 0, message: "GET /x: connect ECONNREFUSED" });
	});

	test("an answer longer than 2 MiB is refused", async () => {
		const api = new GitHubApi(async () => new Response("x".repeat(2 * 1024 ** 2 + 1), { status: 200 }));
		expect(await api.request("GET", "/x", { kind: "none" }).catch((e: unknown) => e)).toMatchObject({ status: 0, message: expect.stringContaining("longer than") });
	});
});
