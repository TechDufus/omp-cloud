import { describe, expect, test } from "bun:test";
import { githubRepoOf } from "./repo";

describe("githubRepoOf", () => {
	test("parses a normalized github.com URL, with or without .git", () => {
		expect(githubRepoOf("https://github.com/TechDufus/omp-cloud")).toEqual({ owner: "TechDufus", repo: "omp-cloud" });
		expect(githubRepoOf("https://github.com/TechDufus/omp-cloud.git")).toEqual({ owner: "TechDufus", repo: "omp-cloud" });
		expect(githubRepoOf("https://github.com/o/a.b_c-d")).toEqual({ owner: "o", repo: "a.b_c-d" });
	});

	test.each([
		"https://gitlab.com/o/r",
		"https://github.com.evil.test/o/r",
		"http://github.com/o/r",
		"git@github.com:o/r.git",
		"ssh://git@github.com/o/r",
		"https://user:pw@github.com/o/r",
		"https://github.com:8443/o/r",
		"https://github.com/o",
		"https://github.com/o/r/tree/main",
		"https://github.com/o/r?x=1",
		"https://github.com/o/r#frag",
		"https://github.com/o/..",
		"https://github.com/-bad/r",
		"https://github.com//r",
		"not a url",
		"",
	])("refuses %p", (url) => {
		expect(githubRepoOf(url)).toBeNull();
	});
});
