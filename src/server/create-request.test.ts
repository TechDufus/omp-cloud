import { describe, expect, test } from "bun:test";
import type { ThreadPolicy } from "../settings/policy";
import { MAX_TEXT_BYTES, THINKING_LEVELS } from "../store/types";
import { parseCreateRequest } from "./create-request";
import { ApiError } from "./errors";

const HANDOFF = "a".repeat(40);
const BASE = "b".repeat(40);
const MIB = 1024 * 1024;

type Body = Record<string, unknown>;

/** A valid full-history request with `over` merged on top (top-level keys replace; nested sections merge). */
function request(over: Body = {}): Body {
	const { repo, paths, author, ...rest } = over;
	return {
		prompt: "fix the bug",
		repo: Array.isArray(repo) ? repo : { name: "proj", handoffCommit: HANDOFF, ...(repo as Body | undefined) },
		...(paths === undefined ? {} : { paths }),
		...(author === undefined ? {} : { author }),
		...rest,
	};
}

/** A valid delta request: needs an http(s) remote, a base ref and a base commit. */
function delta(repo: Body = {}): Body {
	return request({
		repo: { remoteURL: "https://git.example.com/a/b.git", baseRef: "main", baseCommit: BASE, ...repo },
	});
}

/** The request is rejected with status 400. */
function rejected(raw: unknown, selfHosts: readonly string[] = []): ApiError {
	try {
		parseCreateRequest(raw, selfHosts);
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
		return error as ApiError;
	}
	throw new Error("expected the request to be rejected");
}

const b64 = (text: string): string => Buffer.from(text).toString("base64");

describe("shape", () => {
	test.each([[null], [[]], ["x"], [5]])("rejects a non-object body %p", raw => {
		rejected(raw);
	});

	test("ignores unknown fields, including the retired conversationFile and agent", () => {
		const parsed = parseCreateRequest(request({ conversationFile: "../x", agent: 7, extra: { a: 1 } }));
		expect(parsed.thread.prompt).toBe("fix the bug");
	});

	test("a null field counts as absent", () => {
		const parsed = parseCreateRequest(request({ model: null, thinking: null, paths: null, secretEnv: null, secretFiles: null }));
		expect(parsed.thread.model).toBe("");
		expect(parsed.secrets).toBeNull();
	});

	test.each<[string, Body, string]>([
		["prompt", { prompt: 5 }, "prompt"],
		["model", { model: 5 }, "model"],
		["thinking", { thinking: 5 }, "thinking"],
		["repo", { repo: [] }, "repo"],
		["repo.name", { repo: { name: 5 } }, "repo.name"],
		["repo.handoffCommit", { repo: { handoffCommit: 5 } }, "repo.handoffCommit"],
		["paths", { paths: "x" }, "paths"],
		["paths.home", { paths: { home: 5 } }, "paths.home"],
		["author", { author: [] }, "author"],
		["author.email", { author: { email: {} } }, "author.email"],
		["secretFiles", { secretFiles: {} }, "secretFiles"],
		["secretFiles entry", { secretFiles: ["a"] }, "secretFiles[0]"],
		["secretFiles path", { secretFiles: [{ path: 5, content: "" }] }, "secretFiles[0].path"],
		["secretFiles content", { secretFiles: [{ path: "a", content: 5 }] }, "secretFiles[0].content"],
		["secretEnv", { secretEnv: [] }, "secretEnv"],
		["secretEnv value", { secretEnv: { TOKEN: 5 } }, "TOKEN"],
	])("a wrong JSON type for %s is a 400 naming the field", (_label, over, named) => {
		expect(rejected(request(over)).message).toContain(named);
	});
});

describe("prompt", () => {
	test("is required", () => {
		rejected(request({ prompt: "" }));
		rejected({ repo: { name: "proj", handoffCommit: HANDOFF } });
	});

	test("is capped in UTF-8 bytes, not characters", () => {
		expect(parseCreateRequest(request({ prompt: "x".repeat(MAX_TEXT_BYTES) })).thread.prompt).toHaveLength(MAX_TEXT_BYTES);
		rejected(request({ prompt: "x".repeat(MAX_TEXT_BYTES + 1) }));
		// 16384 two-byte characters fit exactly; one more does not.
		parseCreateRequest(request({ prompt: "é".repeat(MAX_TEXT_BYTES / 2) }));
		rejected(request({ prompt: "é".repeat(MAX_TEXT_BYTES / 2 + 1) }));
	});

	test("must be well-formed: a lone surrogate is rejected", () => {
		rejected(request({ prompt: "hi \ud800" }));
		parseCreateRequest(request({ prompt: "hi 😀" }));
	});

	test("is stored as sent", () => {
		const prompt = "\n  first line  \nsecond\n";
		expect(parseCreateRequest(request({ prompt })).thread.prompt).toBe(prompt);
	});
});

describe("title", () => {
	test("is the first non-empty trimmed line", () => {
		const parsed = parseCreateRequest(request({ prompt: "\n  \r\n\t  Fix the bug \t\r\nmore text" }));
		expect(parsed.thread.title).toBe("Fix the bug");
	});

	test("a long first line is cut to 80 code points, not code units", () => {
		const title = parseCreateRequest(request({ prompt: "😀".repeat(100) })).thread.title;
		expect(Array.from(title)).toHaveLength(80);
		expect(title).toBe("😀".repeat(80));
		expect(title.isWellFormed()).toBe(true);
	});

	test("an 80 character line is kept whole", () => {
		const line = "y".repeat(80);
		expect(parseCreateRequest(request({ prompt: `${line}\nz` })).thread.title).toBe(line);
	});
});

describe("name", () => {
	const MESSAGE = "name must be one line of at most 60 characters";

	test("absent, null and empty mean no name", () => {
		expect(parseCreateRequest(request()).thread.name).toBe("");
		expect(parseCreateRequest(request({ name: null })).thread.name).toBe("");
		expect(parseCreateRequest(request({ name: "" })).thread.name).toBe("");
		expect(parseCreateRequest(request({ name: " \u00a0 " })).thread.name).toBe("");
	});

	test("is trimmed and its inner whitespace collapsed to single spaces", () => {
		expect(parseCreateRequest(request({ name: "  Fix   the \u00a0 login\u3000bug  " })).thread.name).toBe("Fix the login bug");
	});

	test("is capped at 60 code points, not code units", () => {
		expect(parseCreateRequest(request({ name: "y".repeat(60) })).thread.name).toBe("y".repeat(60));
		expect(parseCreateRequest(request({ name: "😀".repeat(60) })).thread.name).toBe("😀".repeat(60));
		expect(rejected(request({ name: "y".repeat(61) })).message).toBe(MESSAGE);
		expect(rejected(request({ name: "😀".repeat(61) })).message).toBe(MESSAGE);
	});

	test("the cap counts the collapsed text, so surrounding and doubled spaces do not use it up", () => {
		expect(parseCreateRequest(request({ name: ` ${"a".repeat(30)}    ${"b".repeat(29)} ` })).thread.name).toBe(`${"a".repeat(30)} ${"b".repeat(29)}`);
	});

	test.each([["two\nlines"], ["tab\there"], ["cr\rhere"], ["nul\u0000"], ["del\u007f"], ["\nlead"], ["lone \ud800"], [7], [true], [["a"]], [{}]])(
		"%p is rejected",
		name => {
			expect(rejected(request({ name })).message).toBe(MESSAGE);
		},
	);
});

describe("model and thinking", () => {
	test("model is plain text of at most 512 bytes; empty means the default", () => {
		expect(parseCreateRequest(request()).thread.model).toBe("");
		expect(parseCreateRequest(request({ model: "anthropic/claude-sonnet-5" })).thread.model).toBe("anthropic/claude-sonnet-5");
		expect(parseCreateRequest(request({ model: `p/${"m".repeat(510)}` })).thread.model).toHaveLength(512);
		rejected(request({ model: `p/${"m".repeat(511)}` }));
		rejected(request({ model: "a/b\nc" }));
	});

	test.each(["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5:high", "openai-codex/gpt-6:xhigh", "openrouter/anthropic/claude-4", "ollama/qwen:7b", "ollama/qwen:7b:low", "a.b_c-1/x"])(
		"model %p is <provider>/<id> with an optional thinking suffix",
		model => {
			expect(parseCreateRequest(request({ model })).thread.model).toBe(model);
		},
	);

	test.each(["claude", "/claude", "anthropic/", "anthropic/:high", "Anthropic/claude", "anth ropic/claude", "anthropic/clau de", "-a/b", "a!/b"])(
		"model %p is not <provider>/<id>",
		model => {
			expect(rejected(request({ model })).message).toContain("model must be empty or <provider>/<id>");
		},
	);

	test.each([...THINKING_LEVELS, ""])("accepts thinking level %p", level => {
		expect(parseCreateRequest(request({ thinking: level })).thread.thinking).toBe(level);
	});

	test.each(["extreme", "HIGH", " high"])("rejects thinking level %p", level => {
		rejected(request({ thinking: level }));
	});
});

describe("the owner's environment", () => {
	test("configOverlays and ompVersion default to none", () => {
		const parsed = parseCreateRequest(request());
		expect(parsed.thread.configOverlays).toEqual([]);
		expect(parsed.thread.ompVersion).toBe("");
		const nulls = parseCreateRequest(request({ configOverlays: null, ompVersion: null }));
		expect(nulls.thread.configOverlays).toEqual([]);
		expect(nulls.thread.ompVersion).toBe("");
	});

	test("overlays are kept in order, at most 8", () => {
		const overlays = ["overlays/claude.yml", "a.b-c_d/e.yml", "x"];
		expect(parseCreateRequest(request({ configOverlays: overlays })).thread.configOverlays).toEqual(overlays);
		const eight = Array.from({ length: 8 }, (_, i) => `o${i}.yml`);
		expect(parseCreateRequest(request({ configOverlays: eight })).thread.configOverlays).toEqual(eight);
		expect(rejected(request({ configOverlays: [...eight, "o8.yml"] })).message).toContain("at most 8");
	});

	test.each(["", "/abs/x.yml", "../x.yml", "a/../x.yml", "a/./x.yml", "./x.yml", "a//b", "a/", "~/x.yml", "a b.yml", "a\\b", "é.yml", "a\nb", "x".repeat(513)])(
		"overlay %p is not a clean relative path",
		path => {
			expect(rejected(request({ configOverlays: [path] })).message).toContain("configOverlays[0]");
		},
	);

	test.each([[{}], ["a"], [[5]], [[null]], [[["a"]]]])("configOverlays %p has the wrong type", configOverlays => {
		expect(rejected(request({ configOverlays })).message).toContain("configOverlays");
	});

	test.each(["18.12.3", "1.0.0", "0.0.0", "100.200.300"])("ompVersion %p is accepted", ompVersion => {
		expect(parseCreateRequest(request({ ompVersion })).thread.ompVersion).toBe(ompVersion);
	});

	test.each(["v18.12.3", "18.12", "18.12.3.1", "18.12.3-beta", "latest", " 18.12.3", "18.12.x", "1.2.3\n", 5])("ompVersion %p is rejected", ompVersion => {
		expect(rejected(request({ ompVersion })).message).toContain("ompVersion");
	});
});

describe("the thread policy", () => {
	test("an absent, null or empty policy is none", () => {
		expect(parseCreateRequest(request()).thread.policy).toEqual({});
		expect(parseCreateRequest(request({ policy: null })).thread.policy).toEqual({});
		expect(parseCreateRequest(request({ policy: {} })).thread.policy).toEqual({});
	});

	test("every key takes the value its setting takes, normalized by the registry's validator", () => {
		const policy: ThreadPolicy = {
			"bash.patterns": [{ match: "touch /tmp/x*", approval: "deny" }],
			"tools.approval": { eval: "prompt" },
			fetch: false,
			webSearch: false,
			browser: false,
			egress: ["Example.COM", "10.0.0.0/8"],
			"spend.turnUSD": 0.5,
			"spend.threadUSD": 2,
			"spend.dayUSD": 10,
			"models.allowed": ["anthropic/*"],
		};
		expect(parseCreateRequest(request({ policy })).thread.policy).toEqual({ ...policy, egress: ["example.com", "10.0.0.0/8"] });
	});

	test("an unknown key is rejected naming it", () => {
		expect(rejected(request({ policy: { nope: 1 } })).message).toBe("unknown policy key nope");
		expect(rejected(request({ policy: { "policy.fetch": false } })).message).toBe("unknown policy key policy.fetch");
		expect(rejected(request({ policy: { fetch: false, git: 1 } })).message).toBe("unknown policy key git");
		expect(rejected(request({ policy: { ["x".repeat(300)]: 1 } })).message).toBe(`unknown policy key ${"x".repeat(100)}`);
	});

	test.each([
		["a list", []],
		["a string", "fetch"],
		["a number", 5],
		["true", true],
	])("%s is not a policy object", (_label, policy) => {
		expect(rejected(request({ policy })).message).toBe("policy must be an object");
	});

	test.each([
		["bash.patterns", "ls", "policy.bash.patterns must be a list"],
		["bash.patterns", [{ match: "ls", approval: "ask" }], "policy.bash.patterns[0].approval must be one of allow, deny, prompt"],
		["tools.approval", { Eval: "deny" }, "policy.tools.approval tool names look like"],
		["fetch", "no", "policy.fetch must be true or false"],
		["webSearch", 0, "policy.webSearch must be true or false"],
		["browser", null, "policy.browser must be true or false"],
		["egress", ["https://example.com"], "policy.egress entries are IPv4 addresses, CIDRs or domains"],
		["spend.turnUSD", -1, "policy.spend.turnUSD must be a number from 0 to"],
		["spend.threadUSD", "5", "policy.spend.threadUSD must be a number from 0 to"],
		["spend.dayUSD", 1e7, "policy.spend.dayUSD must be a number from 0 to"],
		["models.allowed", "anthropic/*", "policy.models.allowed must be a list of strings"],
	])("policy.%s with %p is rejected by the setting's validator", (key, value, message) => {
		expect(rejected(request({ policy: { [key]: value } })).message).toContain(message);
	});
});

describe("repo", () => {
	test("handoffCommit is a lowercase 40 or 64 digit hex commit id", () => {
		expect(parseCreateRequest(request({ repo: { handoffCommit: "0".repeat(64) } })).thread.repo.handoffCommit).toBe("0".repeat(64));
		for (const handoffCommit of ["", "HEAD", "A".repeat(40), "a".repeat(39), "a".repeat(41), "a".repeat(63), "g".repeat(40)]) {
			rejected(request({ repo: { handoffCommit } }));
		}
	});

	test("baseCommit is empty or a commit id", () => {
		rejected(request({ repo: { baseCommit: "xyz" } }));
		rejected(delta({ baseCommit: "B".repeat(40) }));
	});

	test("name is required", () => {
		rejected(request({ repo: { name: "" } }));
	});

	test.each<[string, Body]>([
		["repo.name", { repo: { name: "a\nb" } }],
		["repo.baseRef", { repo: { baseRef: "m".repeat(513) } }],
		["repo.localBranch", { repo: { localBranch: "a\u0000b" } }],
		["author.name", { author: { name: "a\nb" } }],
		["author.email", { author: { email: "a\u007f@b" } }],
		["author.email", { author: { email: "\ud800" } }],
	])("plain-text field %s rejects control characters, lone surrogates and over-long values", (_label, over) => {
		rejected(request(over));
	});

	test("the remaining fields are stored as sent", () => {
		const parsed = parseCreateRequest(
			request({
				repo: { baseRef: "main", localBranch: "feat/x" },
				author: { name: "Ada", email: "ada@example.com" },
			}),
		);
		expect(parsed.thread.repo).toEqual({
			name: "proj",
			remoteURL: "",
			baseRef: "main",
			baseCommit: "",
			handoffCommit: HANDOFF,
			localBranch: "feat/x",
		});
		expect(parsed.thread.author).toEqual({ name: "Ada", email: "ada@example.com" });
	});
});

describe("remote credentials", () => {
	test("userinfo is stripped from a URL remote", () => {
		for (const remoteURL of [
			"https://user:s3cret@git.example.com/a/b.git",
			"https://s3cret@git.example.com/a/b.git",
			"ssh://git:s3cret@git.example.com/a/b.git",
		]) {
			const stored = parseCreateRequest(request({ repo: { remoteURL } })).thread.repo.remoteURL;
			expect(stored).not.toContain("s3cret");
			expect(stored).not.toContain("@");
			expect(stored).toContain("git.example.com/a/b.git");
		}
	});

	test("user@ is stripped from an scp-style remote", () => {
		const stored = parseCreateRequest(request({ repo: { remoteURL: "git@github.com:a/b.git" } })).thread.repo.remoteURL;
		expect(stored).toBe("github.com:a/b.git");
	});

	test("a remote without credentials is kept", () => {
		expect(parseCreateRequest(request({ repo: { remoteURL: "github.com:a/b.git" } })).thread.repo.remoteURL).toBe("github.com:a/b.git");
		expect(parseCreateRequest(request({ repo: { remoteURL: "https://git.example.com/a/b.git" } })).thread.repo.remoteURL).toBe(
			"https://git.example.com/a/b.git",
		);
		expect(parseCreateRequest(request({ repo: { remoteURL: "/srv/git/a.git" } })).thread.repo.remoteURL).toBe("/srv/git/a.git");
	});

	test("credentials are not stored in a delta remote either", () => {
		const parsed = parseCreateRequest(delta({ remoteURL: "https://user:s3cret@git.example.com/a/b.git" }));
		expect(parsed.thread.repo.remoteURL).not.toContain("s3cret");
	});

	test.each([["https://%zz"], ["http://"], ["ssh:///x"], ["https://host/a\tb"], [`https://h/${"p".repeat(2048)}`]])(
		"rejects the unusable remote %p",
		remoteURL => {
			rejected(request({ repo: { remoteURL } }));
		},
	);

	test("a file: remote has no host and no credentials, and is stored as given", () => {
		for (const remoteURL of ["file:///srv/app.git", "file:///C:/repos/app.git", "file://fileserver/share/app.git"]) {
			expect(parseCreateRequest(request({ repo: { remoteURL } })).thread.repo.remoteURL).toBe(remoteURL);
		}
		expect(parseCreateRequest(delta({ remoteURL: "file:///srv/app.git" })).thread.repo.remoteURL).toBe("file:///srv/app.git");
	});

	test("a file: remote with userinfo is refused", () => {
		rejected(request({ repo: { remoteURL: "file://ada:s3cret@fileserver/app.git" } }));
	});
});

describe("delta mode", () => {
	test("a delta over an http(s) remote is valid", () => {
		for (const remoteURL of ["https://git.example.com/a/b.git", "http://127.0.0.1:8080/a.git"]) {
			const parsed = parseCreateRequest(delta({ remoteURL }));
			expect(parsed.thread.repo.baseCommit).toBe(BASE);
			expect(parsed.thread.repo.baseRef).toBe("main");
		}
	});

	test("handoffCommit equal to baseCommit is valid input", () => {
		const parsed = parseCreateRequest(delta({ handoffCommit: BASE }));
		expect(parsed.thread.repo.handoffCommit).toBe(BASE);
		expect(parsed.thread.repo.baseCommit).toBe(BASE);
	});

	test("needs a remote", () => {
		rejected(delta({ remoteURL: "" }));
	});

	test("needs a base ref", () => {
		rejected(delta({ baseRef: "" }));
	});

	test.each([
		["scp-style", "github.com:a/b.git", "github.com:a/b.git"],
		["scp-style with a user", "git@github.com:a/b.git", "github.com:a/b.git"],
		["ssh://", "ssh://git@github.com/a/b.git", "ssh://github.com/a/b.git"],
		["a local path", "/srv/git/a.git", "/srv/git/a.git"],
	])("a delta remote that is %s parses (whether the service can fetch it is create's call), without credentials", (_label, remoteURL, stored) => {
		expect(parseCreateRequest(delta({ remoteURL })).thread.repo.remoteURL).toBe(stored);
	});

	test("a full handoff may carry any remote", () => {
		for (const remoteURL of ["git@github.com:a/b.git", "ssh://git@github.com/a/b.git", ""]) {
			parseCreateRequest(request({ repo: { remoteURL, baseRef: "main" } }));
		}
	});
});

describe("secret files", () => {
	const file = (path: string, content = "YQ==") => ({ path, content });

	test("keeps file order and the base64 content as sent", () => {
		const parsed = parseCreateRequest(request({ secretFiles: [file("z.txt", b64("one")), file("a/b.env", b64("two")), file("m", "")] }));
		expect(parsed.secrets).toEqual({
			files: [
				{ path: "z.txt", content: b64("one") },
				{ path: "a/b.env", content: b64("two") },
				{ path: "m", content: "" },
			],
			env: {},
		});
		expect(parsed.thread.secretFiles).toEqual(["z.txt", "a/b.env", "m"]);
	});

	test("accepts 32 files and rejects 33", () => {
		const files = (n: number) => Array.from({ length: n }, (_, i) => file(`f${i}`));
		expect(parseCreateRequest(request({ secretFiles: files(32) })).thread.secretFiles).toHaveLength(32);
		rejected(request({ secretFiles: files(33) }));
	});

	test.each([
		["absolute", "/etc/passwd"],
		["escaping", "../x"],
		["bare parent", ".."],
		["dot", "."],
		["unclean", "a/../b"],
		["dot segment", "./a"],
		["doubled slash", "a//b"],
		["trailing slash", "a/"],
		["inside .git", ".git/config"],
		["the .git directory", ".git"],
		["empty", ""],
		["control character", "a\nb"],
		["a backslash", "a\\b"],
		["a Windows drive path", "C:\\Users\\ada\\.env"],
		["too long", "p".repeat(513)],
	])("rejects a path that is %s", (_label, path) => {
		rejected(request({ secretFiles: [file(path)] }));
	});

	test("accepts a dot-file and a path that merely starts with .git", () => {
		parseCreateRequest(request({ secretFiles: [file(".env"), file(".github/x"), file(".gitignore")] }));
	});

	test("rejects a path listed twice", () => {
		rejected(request({ secretFiles: [file("a"), file("a")] }));
	});

	test.each([["not base64 characters", "***"], ["unpadded", "YQ"], ["a trailing newline", "YQ==\n"], ["misplaced padding", "Y=Q="], ["URL-safe alphabet", "-_-_"]])(
		"rejects content that is %s",
		(_label, content) => {
			rejected(request({ secretFiles: [file("a", content)] }));
		},
	);
});

describe("secret env", () => {
	test("lists sorted names and keeps the values", () => {
		const parsed = parseCreateRequest(request({ secretEnv: { ZED: "z", API_KEY: "k", _x1: "" } }));
		expect(parsed.thread.secretEnv).toEqual(["API_KEY", "ZED", "_x1"]);
		expect(parsed.secrets).toEqual({ files: [], env: { API_KEY: "k", ZED: "z", _x1: "" } });
	});

	test("accepts 64 variables and rejects 65", () => {
		const env = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`V${i}`, "v"]));
		expect(parseCreateRequest(request({ secretEnv: env(64) })).thread.secretEnv).toHaveLength(64);
		rejected(request({ secretEnv: env(65) }));
	});

	test.each(["1BAD", "A-B", "A B", "", "A=B", "ÄB"])("rejects the invalid name %p", name => {
		rejected(request({ secretEnv: { [name]: "v" } }));
	});

	test.each(["HOME", "PATH", "OMP_X", "OMP_", "MISE_DATA_DIR"])("rejects the reserved name %s", name => {
		rejected(request({ secretEnv: { [name]: "v" } }));
	});

	test("KUBECONFIG and look-alikes of reserved names are allowed", () => {
		const names = ["KUBECONFIG", "HOMEDIR", "MY_PATH", "OMP", "MISE", "XOMP_A"];
		const parsed = parseCreateRequest(request({ secretEnv: Object.fromEntries(names.map(n => [n, "v"])) }));
		expect(parsed.thread.secretEnv).toEqual([...names].sort());
	});

	test("a __proto__ variable is data, not a prototype", () => {
		const raw: unknown = JSON.parse(`{"prompt":"p","repo":{"name":"r","handoffCommit":"${HANDOFF}"},"secretEnv":{"__proto__":"v"}}`);
		const parsed = parseCreateRequest(raw);
		expect(Object.keys(parsed.secrets?.env ?? {})).toEqual(["__proto__"]);
	});
});

describe("secret byte total", () => {
	test("decoded file bytes, names and values count; exactly 1 MiB passes", () => {
		// A 3-byte tail: the 1-byte name and the 2-byte value of the variable.
		const content = Buffer.alloc(MIB - 3).toString("base64");
		parseCreateRequest(request({ secretFiles: [{ path: "big", content }], secretEnv: { A: "vv" } }));
		rejected(request({ secretFiles: [{ path: "big", content }], secretEnv: { A: "vvv" } }));
	});

	test("variable names count toward the total", () => {
		parseCreateRequest(request({ secretEnv: { A: "v".repeat(MIB - 1) } }));
		rejected(request({ secretEnv: { A: "v".repeat(MIB) } }));
	});

	test("values count in UTF-8 bytes", () => {
		parseCreateRequest(request({ secretEnv: { A: `${"é".repeat(MIB / 2 - 1)}v` } }));
		rejected(request({ secretEnv: { A: "é".repeat(MIB / 2) } }));
	});

	test("one file over 1 MiB is rejected", () => {
		rejected(request({ secretFiles: [{ path: "big", content: Buffer.alloc(MIB + 1).toString("base64") }] }));
	});
});

describe("secrets output", () => {
	test("is null when nothing is shipped", () => {
		for (const over of [{}, { secretFiles: [], secretEnv: {} }]) {
			const parsed = parseCreateRequest(request(over));
			expect(parsed.secrets).toBeNull();
			expect(parsed.thread.secretFiles).toEqual([]);
			expect(parsed.thread.secretEnv).toEqual([]);
		}
	});

	test("an empty file is still shipped", () => {
		const parsed = parseCreateRequest(request({ secretFiles: [{ path: "empty", content: "" }] }));
		expect(parsed.secrets).toEqual({ files: [{ path: "empty", content: "" }], env: {} });
	});
});

describe("paths", () => {
	const withPaths = (home: string, workspace: string) => parseCreateRequest(request({ paths: { home, workspace } }));

	test("absolute paths are kept as given, whatever they look like", () => {
		expect(withPaths("/home/ada", "/home/ada/dev/proj").thread.paths).toEqual({ home: "/home/ada", workspace: "/home/ada/dev/proj" });
		expect(withPaths("/", "/usr/proj/").thread.paths).toEqual({ home: "/", workspace: "/usr/proj/" });
		expect(withPaths("/home/a da", "/home/a da/../x").thread.paths).toEqual({ home: "/home/a da", workspace: "/home/a da/../x" });
		expect(withPaths("/home/ada", "/home/ada").thread.paths).toEqual({ home: "/home/ada", workspace: "/home/ada" });
	});

	test("Windows drive and UNC paths are accepted and kept as given", () => {
		expect(withPaths("C:\\Users\\ada", "C:\\Users\\ada\\src\\app").thread.paths).toEqual({ home: "C:\\Users\\ada", workspace: "C:\\Users\\ada\\src\\app" });
		expect(withPaths("c:/Users/ada", "D:/dev/app").thread.paths).toEqual({ home: "c:/Users/ada", workspace: "D:/dev/app" });
		expect(withPaths("\\\\fileserver\\home\\ada", "\\\\wsl.localhost\\Ubuntu\\home\\ada\\app").thread.paths).toEqual({
			home: "\\\\fileserver\\home\\ada",
			workspace: "\\\\wsl.localhost\\Ubuntu\\home\\ada\\app",
		});
	});

	test("absent or empty paths stay empty, and either one may be empty", () => {
		expect(parseCreateRequest(request()).thread.paths).toEqual({ home: "", workspace: "" });
		expect(withPaths("/home/ada", "").thread.paths).toEqual({ home: "/home/ada", workspace: "" });
		expect(withPaths("", "/home/ada/proj").thread.paths).toEqual({ home: "", workspace: "/home/ada/proj" });
	});

	test.each<[string, string, string, string]>([
		["a relative home", "home/ada", "/home/ada/proj", "paths.home"],
		["a relative workspace", "/home/ada", "./proj", "paths.workspace"],
		["a backslash-relative workspace", "/home/ada", "src\\app", "paths.workspace"],
		["a drive-relative home", "C:Users\\ada", "/home/ada/proj", "paths.home"],
		["a bare drive home", "C:", "/home/ada/proj", "paths.home"],
		["a lone backslash workspace", "/home/ada", "\\app", "paths.workspace"],
		["a UNC path without a server", "\\\\", "/home/ada/proj", "paths.home"],
		["control characters", "/home/a\nda", "/home/ada/proj", "paths.home"],
		["control characters in a Windows path", "C:\\Users\\a\tda", "/home/ada/proj", "paths.home"],
		["too long", "/home/ada", `/${"p".repeat(512)}`, "paths.workspace"],
	])("%s is rejected naming the field", (_label, home, workspace, field) => {
		expect(rejected(request({ paths: { home, workspace } })).message).toContain(field);
	});
});

describe("a full request", () => {
	test("produces the thread and the secrets", () => {
		const parsed = parseCreateRequest({
			prompt: "\nAdd a retry to the fetcher\n\nIt flakes.",
			model: "anthropic/claude-sonnet-5",
			thinking: "high",
			repo: {
				name: "omp-cloud",
				remoteURL: "https://ada:tok@git.example.com/ada/omp-cloud.git",
				baseRef: "main",
				baseCommit: BASE,
				handoffCommit: HANDOFF,
				localBranch: "retry",
			},
			paths: { home: "/home/ada", workspace: "/home/ada/dev/omp-cloud" },
			author: { name: "Ada", email: "ada@example.com" },
			secretFiles: [
				{ path: ".env", content: b64("A=1\n") },
				{ path: "config/key.pem", content: b64("KEY") },
			],
			secretEnv: { NPM_TOKEN: "t0ken", API_URL: "https://x" },
			conversationFile: "ignored.jsonl",
		});
		expect(parsed).toEqual({
			thread: {
				title: "Add a retry to the fetcher",
				name: "",
				prompt: "\nAdd a retry to the fetcher\n\nIt flakes.",
				model: "anthropic/claude-sonnet-5",
				thinking: "high",
				repo: {
					name: "omp-cloud",
					remoteURL: "https://git.example.com/ada/omp-cloud.git",
					baseRef: "main",
					baseCommit: BASE,
					handoffCommit: HANDOFF,
					localBranch: "retry",
				},
				paths: { home: "/home/ada", workspace: "/home/ada/dev/omp-cloud" },
				author: { name: "Ada", email: "ada@example.com" },
				secretFiles: [".env", "config/key.pem"],
				secretEnv: ["API_URL", "NPM_TOKEN"],
				configOverlays: [],
				mcpServers: [],
				ompVersion: "",
				policy: {},
				origin: "",
				ref: "",
				session: "",
				scratch: false,
			},
			secrets: {
				files: [
					{ path: ".env", content: b64("A=1\n") },
					{ path: "config/key.pem", content: b64("KEY") },
				],
				env: { API_URL: "https://x", NPM_TOKEN: "t0ken" },
			},
		});
	});

	test("the smallest valid request", () => {
		const parsed = parseCreateRequest({ prompt: "x", repo: { name: "r", handoffCommit: HANDOFF } });
		expect(parsed.thread).toEqual({
			title: "x",
			name: "",
			prompt: "x",
			model: "",
			thinking: "",
			repo: { name: "r", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: HANDOFF, localBranch: "" },
			paths: { home: "", workspace: "" },
			author: { name: "", email: "" },
			secretFiles: [],
			secretEnv: [],
			configOverlays: [],
			mcpServers: [],
			ompVersion: "",
			policy: {},
			origin: "",
			ref: "",
			session: "",
			scratch: false,
		});
		expect(parsed.secrets).toBeNull();
	});
});

describe("origin, ref and session", () => {
	test("are kept as sent", () => {
		const parsed = parseCreateRequest(request({ origin: "user", ref: "Fix_login-2.x", session: "0198a1c0-0000-7000-8000-000000000001" }));
		expect(parsed.thread).toMatchObject({ origin: "user", ref: "Fix_login-2.x", session: "0198a1c0-0000-7000-8000-000000000001" });
	});

	test("null and empty count as absent", () => {
		expect(parseCreateRequest(request({ origin: null, ref: null, session: null })).thread).toMatchObject({ origin: "", ref: "", session: "" });
		expect(parseCreateRequest(request({ origin: "", ref: "", session: "" })).thread).toMatchObject({ origin: "", ref: "", session: "" });
	});

	test.each<[string, Body]>([
		["origin", { origin: "robot" }],
		["origin", { origin: "TOOL" }],
		["origin", { origin: 1 }],
		["ref", { ref: "has space" }],
		["ref", { ref: "a/b" }],
		["ref", { ref: "é" }],
		["ref", { ref: "r".repeat(65) }],
		["ref", { ref: 3 }],
		["session", { session: "s".repeat(129) }],
		["session", { session: "a\u0000b" }],
		["session", { session: "a\nb" }],
		["session", { session: "\ud800" }],
		["session", { session: [] }],
	])("an invalid %s is a 400 naming it", (named, over) => {
		expect(rejected(request(over)).message).toContain(named);
	});

	test("the limits are inclusive, a session counts characters not bytes", () => {
		expect(parseCreateRequest(request({ ref: "r".repeat(64) })).thread.ref).toHaveLength(64);
		expect(parseCreateRequest(request({ session: "s".repeat(128) })).thread.session).toHaveLength(128);
		expect(parseCreateRequest(request({ session: "é".repeat(128) })).thread.session).toHaveLength(128);
	});
});

describe("repo.scratch", () => {
	const scratch = (repo: Body = {}, over: Body = {}): Body => ({ prompt: "plan it", repo: { scratch: true, ...repo }, ...over });

	test("needs no handoff commit and names the repository scratch", () => {
		const parsed = parseCreateRequest(scratch());
		expect(parsed.thread.scratch).toBe(true);
		expect(parsed.thread.repo).toEqual({ name: "scratch", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "", localBranch: "" });
	});

	test("keeps a given name and local branch", () => {
		const parsed = parseCreateRequest(scratch({ name: "notes", localBranch: "draft" }));
		expect(parsed.thread.repo).toMatchObject({ name: "notes", localBranch: "draft" });
	});

	test("false, null and absent are an ordinary repository", () => {
		for (const flag of [false, null, undefined]) {
			expect(parseCreateRequest(request({ repo: { scratch: flag } })).thread.scratch).toBe(false);
		}
		rejected({ prompt: "x", repo: { scratch: false, name: "proj" } });
	});

	test.each<[string, Body]>([
		["remoteURL", { remoteURL: "https://example.com/r.git" }],
		["baseRef", { baseRef: "main" }],
		["baseCommit", { baseCommit: BASE }],
		["handoffCommit", { handoffCommit: HANDOFF }],
	])("a scratch repo with %s is a 400", (_field, repo) => {
		expect(rejected(scratch(repo)).message).toContain("scratch");
	});

	test.each([["yes"], [1], [[]], [{}]])("a non-boolean %p is a 400 naming repo.scratch", flag => {
		expect(rejected(scratch({ scratch: flag })).message).toContain("repo.scratch");
	});

	test("the other fields are validated as for any request", () => {
		rejected(scratch({}, { prompt: "" }));
		rejected(scratch({ name: "n\nm" }));
		rejected(scratch({}, { model: "no-provider" }));
	});
});

describe("mcp", () => {
	const http = (name: string, url: string, headers: Body = {}): Body => ({ name, type: "http", url, headers });
	const stdio = (name: string, over: Body = {}): Body => ({ name, type: "stdio", command: "npx", args: ["-y", "server"], env: {}, ...over });
	const GATEWAY = "10.254.254.1";

	test("absent, null and empty ship nothing", () => {
		for (const over of [{}, { mcp: null }, { mcp: [] }]) {
			const parsed = parseCreateRequest(request(over));
			expect(parsed.thread.mcpServers).toEqual([]);
			expect(parsed.secrets).toBeNull();
		}
	});

	test("the servers go into the secrets, their names onto the thread, in request order", () => {
		const parsed = parseCreateRequest(
			request({ mcp: [http("docs", "https://mcp.example.com/mcp", { Authorization: "Bearer upstream" }), stdio("local", { env: { TOKEN: "${MCP_TOKEN}", REGION: "${REGION:-eu}" }, cwd: "tools" })] }),
		);
		expect(parsed.thread.mcpServers).toEqual(["docs", "local"]);
		expect(parsed.secrets).toEqual({
			files: [],
			env: {},
			mcp: [
				{ name: "docs", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer upstream" } },
				{ name: "local", type: "stdio", command: "npx", args: ["-y", "server"], env: { TOKEN: "${MCP_TOKEN}", REGION: "${REGION:-eu}" }, cwd: "tools" },
			],
		});
	});

	test("they are added to the secret files and variables the request ships", () => {
		const parsed = parseCreateRequest(request({ secretEnv: { KEY: "v" }, mcp: [http("docs", "https://mcp.example.com/mcp")] }));
		expect(parsed.secrets).toMatchObject({ files: [], env: { KEY: "v" }, mcp: [{ name: "docs" }] });
	});

	test("at most 32 servers", () => {
		const servers = (count: number) => Array.from({ length: count }, (_, i) => http(`s${i}`, "https://mcp.example.com/mcp"));
		expect(parseCreateRequest(request({ mcp: servers(32) })).thread.mcpServers).toHaveLength(32);
		expect(rejected(request({ mcp: servers(33) })).message).toBe("mcp has 33 entries; at most 32");
		expect(rejected(request({ mcp: "x" })).message).toBe("mcp must be an array");
		expect(rejected(request({ mcp: ["x"] })).message).toBe("mcp[0] must be an object");
	});

	test("names are unique and 1 to 64 characters of letters, digits, . _ -", () => {
		expect(parseCreateRequest(request({ mcp: [stdio("A_b-1.x"), stdio("a".repeat(64))] })).thread.mcpServers).toHaveLength(2);
		for (const name of ["", "a".repeat(65), "has space", "slash/x", 7, undefined]) rejected(request({ mcp: [stdio(name as string)] }));
		expect(rejected(request({ mcp: [stdio("dup"), http("dup", "https://mcp.example.com/mcp")] })).message).toBe("mcp server dup is listed twice");
	});

	test("the type must be http or stdio", () => {
		expect(rejected(request({ mcp: [{ name: "x", url: "https://mcp.example.com/mcp" }] })).message).toBe('mcp server x: type must be "http" or "stdio"');
		rejected(request({ mcp: [{ name: "x", type: "sse", url: "https://mcp.example.com/mcp" }] }));
	});

	test("an http server needs an http or https URL and at most 32 string headers", () => {
		parseCreateRequest(request({ mcp: [http("a", "http://192.168.1.20:8080/mcp"), http("b", "https://mcp.example.com/mcp")] }));
		for (const url of ["", "not a url", "ftp://mcp.example.com/mcp", "file:///etc/passwd", "https://mcp.example.com/\u0001"]) rejected(request({ mcp: [http("x", url)] }));
		expect(rejected(request({ mcp: [{ name: "x", type: "http" }] })).message).toBe("mcp server x: url must be a string");
		const headers = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`X-H${i}`, "v"]));
		parseCreateRequest(request({ mcp: [http("x", "https://mcp.example.com/mcp", headers(32))] }));
		expect(rejected(request({ mcp: [http("x", "https://mcp.example.com/mcp", headers(33))] })).message).toBe("mcp server x: headers has 33 entries; at most 32");
		rejected(request({ mcp: [http("x", "https://mcp.example.com/mcp", { "Bad Name": "v" })] }));
		rejected(request({ mcp: [http("x", "https://mcp.example.com/mcp", { "X-Ok": 1 })] }));
		rejected(request({ mcp: [http("x", "https://mcp.example.com/mcp", { "X-Ok": "a\nb" })] }));
	});

	test.each([
		"http://localhost:8080/mcp",
		"http://api.localhost/mcp",
		"http://127.0.0.1/mcp",
		"http://127.9.9.9:1/mcp",
		"http://2130706433/mcp",
		"http://[::1]:8080/mcp",
		"http://[::ffff:127.0.0.1]/mcp",
		"http://169.254.169.254/latest/meta-data",
		"http://[fe80::1]/mcp",
		"http://0.0.0.0:4100/mcp",
		`http://${GATEWAY}:4000/mcp`,
	])("an http server may not point at the service host: %s", url => {
		expect(rejected(request({ mcp: [http("x", url)] }), [GATEWAY]).message).toBe("mcp server x may not point at the service host");
	});

	test("a LAN address is allowed, and the gateway address only matters when the service says so", () => {
		for (const url of ["http://10.0.0.5:8080/mcp", "http://192.168.1.20/mcp", "https://[fd00::1]/mcp"]) parseCreateRequest(request({ mcp: [http("x", url)] }), [GATEWAY]);
		parseCreateRequest(request({ mcp: [http("x", `http://${GATEWAY}:4000/mcp`)] }));
	});

	test("a stdio server needs a command, string args and env values that only reference the VM's env", () => {
		expect(rejected(request({ mcp: [stdio("x", { command: "" })] })).message).toContain("command must be");
		expect(rejected(request({ mcp: [{ name: "x", type: "stdio" }] })).message).toBe("mcp server x: command must be a string");
		expect(rejected(request({ mcp: [stdio("x", { args: "-y" })] })).message).toBe("mcp server x: args must be an array of strings");
		rejected(request({ mcp: [stdio("x", { args: ["-y", 1] })] }));
		expect(parseCreateRequest(request({ mcp: [stdio("x", { args: undefined, env: undefined })] })).secrets?.mcp).toEqual([{ name: "x", type: "stdio", command: "npx", args: [], env: {} }]);
		for (const value of ["literal-secret", "${}", "${1BAD}", "prefix-${TOKEN}", "${TOKEN}-suffix", "$TOKEN", ""]) {
			expect(rejected(request({ mcp: [stdio("x", { env: { TOKEN: value } })] })).message).toBe("mcp server x: env TOKEN must be a ${NAME} reference to the cloud's secrets, not a literal value");
		}
		rejected(request({ mcp: [stdio("x", { env: { "BAD-NAME": "${X}" } })] }));
		rejected(request({ mcp: [stdio("x", { env: { TOKEN: 5 } })] }));
	});

	test("a stdio cwd must be relative and clean", () => {
		for (const cwd of ["/abs", "../up", "a/../../b", 5]) rejected(request({ mcp: [stdio("x", { cwd })] }));
		expect(parseCreateRequest(request({ mcp: [stdio("x", { cwd: "tools/mcp" })] })).secrets?.mcp?.[0]).toMatchObject({ cwd: "tools/mcp" });
	});

	test("the servers are at most 262144 bytes of JSON in all", () => {
		const fits = (headerBytes: number) => request({ mcp: [http("x", "https://mcp.example.com/mcp", { "X-Big": "a".repeat(headerBytes) })] });
		const overhead = Buffer.byteLength(JSON.stringify([{ name: "x", type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Big": "" } }]));
		// A header value is capped at 8192 bytes, so fill the budget with several servers.
		const many = (perServer: number) => request({ mcp: Array.from({ length: 32 }, (_, i) => http(`s${i}`, "https://mcp.example.com/mcp", { "X-Big": "a".repeat(perServer) })) });
		expect(overhead).toBeLessThan(262144);
		parseCreateRequest(fits(8192));
		expect(rejected(request({ mcp: [http("x", "https://mcp.example.com/mcp", { "X-Big": "a".repeat(8193) })] })).message).toContain("at most 8192 bytes");
		parseCreateRequest(many(100));
		const tooBig = rejected(
			request({
				mcp: Array.from({ length: 32 }, (_, i) => http(`s${i}`, "https://mcp.example.com/mcp", Object.fromEntries(Array.from({ length: 32 }, (_, h) => [`X-H${h}`, "a".repeat(300)])))),
			}),
		);
		expect(tooBig.message).toMatch(/^mcp is \d+ bytes; at most 262144$/);
	});
});
