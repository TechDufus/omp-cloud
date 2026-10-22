import { expect, test } from "bun:test";
import { globMatch } from "./glob";

test("`*` matches any run of characters including `/`; the whole value must match", () => {
	expect(globMatch("*", "github.com/a/b")).toBe(true);
	expect(globMatch("github.com/acme/*", "github.com/acme/app")).toBe(true);
	expect(globMatch("github.com/acme/*", "github.com/acme/group/app")).toBe(true);
	expect(globMatch("github.com/acme/*", "github.com/acmex/app")).toBe(false);
	expect(globMatch("acme", "acme/app")).toBe(false);
	expect(globMatch("release/*", "release/1.2")).toBe(true);
	expect(globMatch("a*c*e", "abcde")).toBe(true);
});

test("everything but `*` is literal", () => {
	expect(globMatch("a.b", "axb")).toBe(false);
	expect(globMatch("a.b", "a.b")).toBe(true);
	expect(globMatch("v1+(x)", "v1+(x)")).toBe(true);
	expect(globMatch("[a]?", "[a]?")).toBe(true);
	expect(globMatch("[a]?", "ax")).toBe(false);
});
