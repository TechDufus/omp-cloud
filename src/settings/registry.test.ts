import { describe, expect, test } from "bun:test";
import { branchNameProblem, isSettingKey, modelAllowed, REGISTRY, SETTING_DEFS, SettingError } from "./registry";

describe("registry", () => {
	test("keys match their entries and no key is a path prefix of another", () => {
		for (const [key, def] of Object.entries(REGISTRY)) expect(def.key).toBe(key);
		for (const a of SETTING_DEFS) {
			for (const b of SETTING_DEFS) {
				if (a !== b) expect(b.key.startsWith(`${a.key}.`)).toBe(false);
			}
		}
	});

	test("every default passes its own validator, and enum choices are declared", () => {
		for (const def of SETTING_DEFS) expect(def.parse(def.default)).toEqual(def.default);
		expect(REGISTRY["git.push"].choices).toEqual(["never", "ask", "auto"]);
	});

	test("isSettingKey knows registered keys only, not prototype names", () => {
		expect(isSettingKey("git.push")).toBe(true);
		expect(isSettingKey("git")).toBe(false);
		expect(isSettingKey("toString")).toBe(false);
	});
});

describe("git.push", () => {
	const parse = (raw: unknown) => REGISTRY["git.push"].parse(raw);

	test("takes never, ask and auto", () => {
		expect(parse("never")).toBe("never");
		expect(parse("ask")).toBe("ask");
		expect(parse("auto")).toBe("auto");
	});

	test("refuses anything else with a message naming the key", () => {
		for (const raw of ["sometimes", "", "Ask", 1, null, true, ["ask"]]) {
			expect(() => parse(raw)).toThrow(SettingError);
			expect(() => parse(raw)).toThrow("git.push must be one of never, ask, auto");
		}
	});
});

describe("git.branch", () => {
	const parse = (raw: unknown) => REGISTRY["git.branch"].parse(raw);

	test("takes templates with {thread} that name a valid branch", () => {
		for (const template of ["omp-cloud/{thread}", "{thread}", "bots/{thread}-work", "a/b/{thread}", "x-{thread}/{thread}"]) {
			expect(parse(template)).toBe(template);
		}
	});

	test("requires {thread}", () => {
		expect(() => parse("omp-cloud/fixed")).toThrow("git.branch must contain {thread}");
	});

	test("refuses any other placeholder or stray brace", () => {
		for (const template of ["a/{thread}/{id}", "{thread}}", "{{thread}", "a{b}/{thread}", "{thread}{"]) {
			expect(() => parse(template)).toThrow("git.branch may only use the {thread} placeholder");
		}
	});

	test("refuses a template that cannot substitute to a valid branch name", () => {
		for (const template of [
			"a b/{thread}",
			"a..b/{thread}",
			"/{thread}",
			"{thread}/",
			"a//{thread}",
			"{thread}.lock",
			".hidden/{thread}",
			"a/.{thread}",
			"-{thread}",
			"a/{thread}.",
			"a~/{thread}",
			"a:/{thread}",
		]) {
			expect(() => parse(template)).toThrow(SettingError);
			expect(() => parse(template)).toThrow("git.branch");
		}
	});

	test("refuses a non-string", () => {
		expect(() => parse(5)).toThrow("git.branch must be a string");
		expect(() => parse(null)).toThrow("git.branch must be a string");
	});
});

describe("branchNameProblem", () => {
	test("accepts names git check-ref-format --branch accepts", () => {
		for (const name of ["main", "feature/x", "omp-cloud/aaaaaaaaaaaa", "a.b", "a_b-c", "release/1.2", "ünï"]) {
			expect(branchNameProblem(name)).toBeNull();
		}
	});

	test("refuses the names it refuses", () => {
		for (const name of [
			"",
			"@",
			"HEAD",
			"-x",
			"a b",
			"a\tb",
			"a\u007fb",
			"a~1",
			"a^",
			"a:b",
			"a?b",
			"a*b",
			"a[b",
			"a\\b",
			"a..b",
			"a@{b",
			"/a",
			"a/",
			"a//b",
			"a.",
			"x.lock",
			"a.lock/b",
			".a",
			"a/.b",
		]) {
			expect(branchNameProblem(name)).not.toBeNull();
		}
	});
});

describe("git.protected", () => {
	const parse = (raw: unknown) => REGISTRY["git.protected"].parse(raw);

	test("takes a list of non-empty globs and returns a copy", () => {
		const raw = ["main", "release/*", "*"];
		const parsed = parse(raw);
		expect(parsed).toEqual(raw);
		expect(parsed).not.toBe(raw);
		expect(parse([])).toEqual([]);
	});

	test("refuses a non-list, non-strings, empty or spaced patterns and too many patterns", () => {
		expect(() => parse("main")).toThrow("git.protected must be a list of strings");
		expect(() => parse([1])).toThrow("git.protected must be a list of strings");
		expect(() => parse(null)).toThrow("git.protected must be a list of strings");
		expect(() => parse([""])).toThrow("git.protected patterns must be non-empty without whitespace");
		expect(() => parse(["a b"])).toThrow("git.protected patterns must be non-empty without whitespace");
		expect(() => parse(["a\nb"])).toThrow(SettingError);
		expect(() => parse(Array.from({ length: 101 }, (_, i) => `b${i}`))).toThrow("git.protected holds at most 100 patterns");
	});
});

describe("git.sign, git.committer and git.pr", () => {
	test("git.sign and git.pr take their choices and refuse anything else", () => {
		expect(REGISTRY["git.sign"].parse("ssh")).toBe("ssh");
		expect(REGISTRY["git.sign"].default).toBe("off");
		expect(() => REGISTRY["git.sign"].parse("gpg")).toThrow("git.sign must be one of off, ssh");
		expect(REGISTRY["git.pr"].default).toBe("draft");
		for (const mode of ["off", "draft", "ready"] as const) expect(REGISTRY["git.pr"].parse(mode)).toBe(mode);
		expect(() => REGISTRY["git.pr"].parse("yes")).toThrow("git.pr must be one of off, draft, ready");
	});

	test("git.committer is empty or Name <email>", () => {
		const parse = (raw: unknown) => REGISTRY["git.committer"].parse(raw);
		expect(parse("")).toBe("");
		expect(parse("Ada Lovelace <ada@example.com>")).toBe("Ada Lovelace <ada@example.com>");
		for (const bad of ["ada@example.com", "<ada@example.com>", "Ada <ada>", "Ada <a b@c.d>", "Ada\n <a@b.c>", 5]) {
			expect(() => parse(bad)).toThrow(SettingError);
		}
	});
});

describe("policy.bash.patterns", () => {
	const parse = (raw: unknown) => REGISTRY["policy.bash.patterns"].parse(raw);

	test("takes rules in order and returns copies", () => {
		const raw: { match: string; approval: "allow" | "deny" | "prompt" }[] = [
			{ match: "npm publish*", approval: "prompt" },
			{ match: "rm -rf /*", approval: "deny" },
			{ match: "ls", approval: "allow" },
		];
		const parsed = parse(raw);
		expect(parsed).toEqual(raw);
		expect(parsed[0]).not.toBe(raw[0]);
		expect(parse([])).toEqual([]);
	});

	test("refuses a non-list, a non-record rule, extra properties, a bad match and a bad approval", () => {
		expect(() => parse({})).toThrow("policy.bash.patterns must be a list");
		expect(() => parse(["ls"])).toThrow("policy.bash.patterns[0] must be {match, approval}");
		expect(() => parse([{ match: "ls", approval: "deny", note: "x" }])).toThrow("must be {match, approval}");
		expect(() => parse([{ match: "", approval: "deny" }])).toThrow("policy.bash.patterns[0].match must be 1 to 500 characters");
		expect(() => parse([{ match: "a".repeat(501), approval: "deny" }])).toThrow("1 to 500 characters");
		expect(() => parse([{ match: "a\nb", approval: "deny" }])).toThrow("without control characters");
		expect(() => parse([{ match: 1, approval: "deny" }])).toThrow(SettingError);
		expect(() => parse([{ match: "ls", approval: "ask" }, { match: "ls", approval: "allow" }])).toThrow(
			"policy.bash.patterns[0].approval must be one of allow, deny, prompt",
		);
		expect(parse([{ match: "a".repeat(500), approval: "deny" }])).toHaveLength(1);
	});

	test("takes at most 100 rules", () => {
		const rule = { match: "x", approval: "deny" };
		expect(parse(Array.from({ length: 100 }, () => rule))).toHaveLength(100);
		expect(() => parse(Array.from({ length: 101 }, () => rule))).toThrow("holds at most 100 rules");
	});
});

describe("policy.tools.approval", () => {
	const parse = (raw: unknown) => REGISTRY["policy.tools.approval"].parse(raw);

	test("takes a record of tool name to approval", () => {
		expect(parse({ eval: "deny", write: "prompt", web_search: "allow" })).toEqual({ eval: "deny", write: "prompt", web_search: "allow" });
		expect(parse({})).toEqual({});
	});

	test("refuses a non-record, a bad tool name, a bad approval and too many tools", () => {
		expect(() => parse([])).toThrow("policy.tools.approval must be a mapping");
		expect(() => parse("deny")).toThrow(SettingError);
		for (const name of ["Eval", "1eval", "a-b", "", "a".repeat(65)]) {
			expect(() => parse({ [name]: "deny" })).toThrow("policy.tools.approval tool names look like");
		}
		expect(() => parse({ eval: "ask" })).toThrow("policy.tools.approval.eval must be one of allow, deny, prompt");
		expect(parse({ [`a${"b".repeat(63)}`]: "deny" })).toBeTruthy();
		const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`t${i}`, "deny"]));
		expect(() => parse(many)).toThrow("holds at most 100 tools");
	});
});

describe("policy booleans", () => {
	test("fetch, webSearch and browser take true and false only, and default to true", () => {
		for (const key of ["policy.fetch", "policy.webSearch", "policy.browser"] as const) {
			expect(REGISTRY[key].default).toBe(true);
			expect(REGISTRY[key].type).toBe("bool");
			expect(REGISTRY[key].parse(false)).toBe(false);
			expect(() => REGISTRY[key].parse("false")).toThrow(`${key} must be true or false`);
			expect(() => REGISTRY[key].parse(0)).toThrow(SettingError);
			expect(() => REGISTRY[key].parse(null)).toThrow(SettingError);
		}
	});
});

describe("policy.egress", () => {
	const parse = (raw: unknown) => REGISTRY["policy.egress"].parse(raw);

	test("takes IPv4 addresses, CIDRs and domains with an optional *. prefix, lowercased", () => {
		expect(parse(["1.1.1.1", "10.0.0.0/8", "0.0.0.0/0", "example.com", "*.Example.COM", "api-2.example.co.uk", "localhost"])).toEqual([
			"1.1.1.1",
			"10.0.0.0/8",
			"0.0.0.0/0",
			"example.com",
			"*.example.com",
			"api-2.example.co.uk",
			"localhost",
		]);
		expect(parse([])).toEqual([]);
	});

	test("refuses malformed addresses, bad domains, a non-list and more than 100 entries", () => {
		for (const bad of ["300.1.1.1", "1.1.1", "1.1.1.1/33", "1.2.3.4.5", "999.999.999.999", "", "*", "*.", "a..b", "-a.com", "a-.com", "exa mple.com", "https://example.com", "example.com/path", "*.*.com", "a".repeat(64) + ".com", "1.1.1.1:80"]) {
			expect(() => parse([bad])).toThrow("policy.egress entries are IPv4 addresses, CIDRs or domains");
		}
		expect(() => parse("example.com")).toThrow("policy.egress must be a list of strings");
		expect(() => parse([1])).toThrow("policy.egress must be a list of strings");
		expect(() => parse(Array.from({ length: 101 }, () => "example.com"))).toThrow("holds at most 100 entries");
	});
});

describe("update.*", () => {
	test("mode takes off, notify and auto; notify is the default", () => {
		expect(REGISTRY["update.mode"].default).toBe("notify");
		expect(REGISTRY["update.mode"].choices).toEqual(["off", "notify", "auto"]);
		for (const mode of ["off", "notify", "auto"] as const) expect(REGISTRY["update.mode"].parse(mode)).toBe(mode);
		for (const bad of ["on", "AUTO", "", 1, null]) expect(() => REGISTRY["update.mode"].parse(bad)).toThrow("update.mode must be one of off, notify, auto");
	});

	test("feed takes github:<owner>/<repo> and http(s) base URLs, github:TechDufus/omp-cloud by default", () => {
		expect(REGISTRY["update.feed"].default).toBe("github:TechDufus/omp-cloud");
		for (const good of ["github:TechDufus/omp-cloud", "http://127.0.0.1:9000/feed/", "https://example.test/omp"]) expect(REGISTRY["update.feed"].parse(good)).toBe(good);
		for (const bad of ["TechDufus/omp-cloud", "github:x", "ftp://example.test/", "https://user:pw@example.test/", "https://example.test/?x=1"]) {
			expect(() => REGISTRY["update.feed"].parse(bad)).toThrow(SettingError);
		}
		expect(() => REGISTRY["update.feed"].parse(5)).toThrow("update.feed must be a string");
	});

	test("token is a trimmed one-line string, empty by default", () => {
		expect(REGISTRY["update.token"].default).toBe("");
		expect(REGISTRY["update.token"].parse("  !/usr/bin/gh auth token ")).toBe("!/usr/bin/gh auth token");
		expect(REGISTRY["update.token"].parse("")).toBe("");
		for (const bad of ["a\nb", 5, "x".repeat(501)]) expect(() => REGISTRY["update.token"].parse(bad)).toThrow("update.token must be a string of at most 500 characters");
	});

	test("unit is a systemd unit name, omp-cloud by default", () => {
		expect(REGISTRY["update.unit"].default).toBe("omp-cloud");
		expect(REGISTRY["update.unit"].parse("omp-cloud-dev")).toBe("omp-cloud-dev");
		for (const bad of ["", "has space", "a/b", "x".repeat(101), 3]) expect(() => REGISTRY["update.unit"].parse(bad)).toThrow(SettingError);
	});

	test("ompUnits is a list of unit names: the broker and gateway by default, empty skips the step", () => {
		expect(REGISTRY["update.ompUnits"].default).toEqual(["omp-auth-broker", "omp-auth-gateway"]);
		expect(REGISTRY["update.ompUnits"].parse([])).toEqual([]);
		expect(REGISTRY["update.ompUnits"].parse(["omp-auth-broker.service", "x@y"])).toEqual(["omp-auth-broker.service", "x@y"]);
		for (const bad of [["has space"], ["a/b"], [""], ["x".repeat(101)], [3], "omp-auth-broker", null]) {
			expect(() => REGISTRY["update.ompUnits"].parse(bad)).toThrow(SettingError);
		}
		expect(() => REGISTRY["update.ompUnits"].parse(Array.from({ length: 101 }, () => "u"))).toThrow("holds at most 100 entries");
	});
});

describe("policy.spend caps", () => {
	for (const key of ["policy.spend.turnUSD", "policy.spend.threadUSD", "policy.spend.dayUSD"] as const) {
		test(`${key} takes finite numbers from 0 to 1e6`, () => {
			expect(REGISTRY[key].default).toBe(0);
			expect(REGISTRY[key].type).toBe("number");
			expect(REGISTRY[key].parse(0)).toBe(0);
			expect(REGISTRY[key].parse(0.25)).toBe(0.25);
			expect(REGISTRY[key].parse(1e6)).toBe(1e6);
			for (const bad of [-0.01, 1e6 + 1, Number.NaN, Number.POSITIVE_INFINITY, "1", null, true]) {
				expect(() => REGISTRY[key].parse(bad)).toThrow(`${key} must be a number from 0 to 1000000`);
			}
		});
	}
});

describe("policy.models.allowed", () => {
	const parse = (raw: unknown) => REGISTRY["policy.models.allowed"].parse(raw);

	test("takes provider/* and provider/id patterns", () => {
		expect(parse(["anthropic/*", "openai/gpt-5", "fake/slow-model:high", "openrouter/anthropic/claude-x"])).toEqual([
			"anthropic/*",
			"openai/gpt-5",
			"fake/slow-model:high",
			"openrouter/anthropic/claude-x",
		]);
		expect(parse([])).toEqual([]);
	});

	test("refuses patterns that are not provider/*, or provider/id", () => {
		for (const bad of ["*", "anthropic", "anthropic/", "/gpt", "*/gpt", "any*/x", "anthropic/claude*", "anthropic/a b", "-x/y"]) {
			expect(() => parse([bad])).toThrow("policy.models.allowed entries are provider/* or provider/id");
		}
		expect(() => parse("anthropic/*")).toThrow("policy.models.allowed must be a list of strings");
		expect(() => parse(Array.from({ length: 101 }, () => "a/b"))).toThrow("holds at most 100 entries");
	});
});

describe("lifecycle.archiveAfterDays", () => {
	const parse = (raw: unknown) => REGISTRY["lifecycle.archiveAfterDays"].parse(raw);

	test("defaults to 7 days", () => {
		expect(REGISTRY["lifecycle.archiveAfterDays"].default).toBe(7);
	});

	test("takes 0 (never) and positive numbers, fractions included", () => {
		expect(parse(0)).toBe(0);
		expect(parse(7)).toBe(7);
		expect(parse(0.5)).toBe(0.5);
	});

	test("rejects negatives, non-finite values and non-numbers", () => {
		for (const bad of [-1, -0.001, Number.NaN, Number.POSITIVE_INFINITY, "7", null, true]) {
			expect(() => parse(bad)).toThrow("lifecycle.archiveAfterDays must be a number of days, 0 or more");
		}
	});
});

describe("modelAllowed", () => {
	test("an empty list allows every model", () => {
		expect(modelAllowed([], "fake/fake-model")).toBe(true);
	});

	test("provider/* allows the provider's models and no other, provider/id exactly one", () => {
		expect(modelAllowed(["anthropic/*"], "anthropic/claude-x")).toBe(true);
		expect(modelAllowed(["anthropic/*"], "anthropic2/claude-x")).toBe(false);
		expect(modelAllowed(["anthropic/*"], "fake/fake-model")).toBe(false);
		expect(modelAllowed(["fake/fake-model"], "fake/fake-model")).toBe(true);
		expect(modelAllowed(["fake/fake-model"], "fake/fake-model-2")).toBe(false);
		expect(modelAllowed(["anthropic/*", "fake/fake-model"], "fake/fake-model")).toBe(true);
	});

	test("a :<thinking> suffix does not make an allowed model another model", () => {
		expect(modelAllowed(["fake/fake-model"], "fake/fake-model:high")).toBe(true);
		expect(modelAllowed(["fake/fake-model:high"], "fake/fake-model:high")).toBe(true);
		expect(modelAllowed(["fake/fake-model:high"], "fake/fake-model")).toBe(false);
		expect(modelAllowed(["fake/fake-model"], "fake/fake-model:custom")).toBe(false);
		expect(modelAllowed(["anthropic/*"], "anthropic/claude-x:xhigh")).toBe(true);
	});
});
