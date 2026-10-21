import { describe, expect, test } from "bun:test";
import { normalizeRemote, remoteHostOf } from "./remote";

const HOSTS = ["github.com", "git.example.test:8443"];

describe("remoteHostOf", () => {
	test.each([
		["https://github.com/acme/app.git", "github.com"],
		["https://GitHub.com/acme/app.git", "github.com"],
		["https://git.example.test:8443/a.git", "git.example.test:8443"],
		["https://github.com:443/a.git", "github.com"],
		["http://127.0.0.1:8080/a.git", "127.0.0.1:8080"],
		["ssh://git@github.com/acme/app.git", "github.com"],
		["ssh://git@github.com:2222/acme/app.git", "github.com"],
		["git@github.com:acme/app.git", "github.com"],
		["github.com:acme/app.git", "github.com"],
		["GitHub.com:acme/app.git", "github.com"],
		["/srv/git/app.git", ""],
		["../app.git", ""],
		["", ""],
		["git://github.com/a.git", ""],
		["file:///srv/git/a.git", ""],
	])("%p is host %p", (remote, host) => {
		expect(remoteHostOf(remote)).toBe(host);
	});
});

describe("normalizeRemote", () => {
	test.each([
		["git@github.com:acme/app.git", "https://github.com/acme/app.git"],
		["github.com:acme/app.git", "https://github.com/acme/app.git"],
		["github.com:/acme/app.git", "https://github.com/acme/app.git"],
		["ssh://git@github.com/acme/app.git", "https://github.com/acme/app.git"],
		["ssh://git@github.com:2222/acme/app.git", "https://github.com/acme/app.git"],
		["git+ssh://git@github.com/acme/app.git", "https://github.com/acme/app.git"],
	])("the ssh form %p of a configured host is %p", (remote, want) => {
		expect(normalizeRemote(remote, HOSTS)).toBe(want);
	});

	test("an ssh remote of an unconfigured host keeps its form, without userinfo", () => {
		expect(normalizeRemote("git@gitlab.example:acme/app.git", HOSTS)).toBe("gitlab.example:acme/app.git");
		expect(normalizeRemote("ssh://git@gitlab.example/acme/app.git", HOSTS)).toBe("ssh://gitlab.example/acme/app.git");
	});

	test("an ssh remote needs the bare host: a configured host:port is an https port", () => {
		expect(normalizeRemote("ssh://git@git.example.test:8443/a.git", HOSTS)).toBe("ssh://git.example.test:8443/a.git");
	});

	test("http(s) remotes lose their userinfo and keep their host", () => {
		expect(normalizeRemote("https://user:s3cret@github.com/acme/app.git", HOSTS)).toBe("https://github.com/acme/app.git");
		expect(normalizeRemote("https://token@git.example.test:8443/a.git", HOSTS)).toBe("https://git.example.test:8443/a.git");
		expect(normalizeRemote("http://127.0.0.1:8080/a.git", HOSTS)).toBe("http://127.0.0.1:8080/a.git");
	});

	test("local paths and unknown schemes pass through", () => {
		expect(normalizeRemote("/srv/git/app.git", HOSTS)).toBe("/srv/git/app.git");
		expect(normalizeRemote("../app.git", HOSTS)).toBe("../app.git");
		expect(normalizeRemote("", HOSTS)).toBe("");
		expect(normalizeRemote("file:///srv/git/a.git", HOSTS)).toBe("file:///srv/git/a.git");
	});

	test("it is idempotent", () => {
		for (const remote of ["git@github.com:acme/app.git", "https://user:pw@github.com/a.git", "ssh://git@x.example/a.git"]) {
			const once = normalizeRemote(remote, HOSTS);
			expect(normalizeRemote(once, HOSTS)).toBe(once);
		}
	});
});
