import { describe, expect, test } from "bun:test";
import { type Approval, type BashPattern, REGISTRY, SettingError, type SettingKey, type SettingValues } from "./registry";
import { POLICY_KEYS, type PolicyValues, type ThreadPolicy } from "./policy";
import { effectivePolicy, egressWidens, globalPolicy, parseThreadPolicy, tightenPolicy } from "./tighten";

/** The service's policy when its operator set nothing: open. */
const OPEN: PolicyValues = {
	"bash.patterns": [],
	"tools.approval": {},
	fetch: true,
	webSearch: true,
	browser: true,
	readOnly: false,
	egress: [],
	"spend.turnUSD": 0,
	"spend.threadUSD": 0,
	"spend.dayUSD": 0,
	"models.allowed": [],
};

const rule = (match: string, approval: Approval): BashPattern => ({ match, approval });

describe("POLICY_KEYS", () => {
	test("are the registry's policy keys without the prefix, in registry order", () => {
		const registered = Object.keys(REGISTRY)
			.filter(key => key.startsWith("policy."))
			.map(key => key.slice("policy.".length));
		expect<string[]>([...POLICY_KEYS]).toEqual(registered);
	});
});

describe("tightenPolicy with no thread policy", () => {
	test("an open service policy stays open", () => {
		expect(tightenPolicy(OPEN, {})).toEqual({
			bashPatterns: [],
			toolApproval: {},
			fetch: true,
			webSearch: true,
			browser: true,
			readOnly: false,
			egress: [],
			spend: { turn: 0, thread: 0, day: 0 },
			modelsAllowed: [],
		});
	});

	test("the service's own policy is the effective one, its rules in their own order", () => {
		const global: PolicyValues = {
			"bash.patterns": [rule("a*", "allow"), rule("b*", "deny"), rule("c*", "prompt")],
			"tools.approval": { eval: "deny", write: "allow" },
			fetch: false,
			webSearch: true,
			browser: false,
			readOnly: false,
			egress: ["example.com"],
			"spend.turnUSD": 1,
			"spend.threadUSD": 2,
			"spend.dayUSD": 3,
			"models.allowed": ["anthropic/*"],
		};
		expect(tightenPolicy(global, {})).toEqual({
			bashPatterns: [rule("a*", "allow"), rule("b*", "deny"), rule("c*", "prompt")],
			toolApproval: { eval: "deny", write: "allow" },
			fetch: false,
			webSearch: true,
			browser: false,
			readOnly: false,
			egress: ["example.com"],
			spend: { turn: 1, thread: 2, day: 3 },
			modelsAllowed: [["anthropic/*"]],
		});
	});

	test("empty lists and absent keys of a thread policy change nothing", () => {
		const global: PolicyValues = { ...OPEN, "bash.patterns": [rule("a*", "allow"), rule("b*", "deny")], egress: ["example.com"], "models.allowed": ["x/*"] };
		const empty = { "bash.patterns": [], "tools.approval": {}, egress: [], "models.allowed": [] };
		expect(tightenPolicy(global, empty)).toEqual(tightenPolicy(global, {}));
	});

	test("does not change its inputs", () => {
		const global: PolicyValues = { ...OPEN, "bash.patterns": [rule("a*", "allow"), rule("b*", "deny")], "tools.approval": { eval: "prompt" }, egress: ["a.com"] };
		const thread = { "bash.patterns": [rule("c*", "prompt")], "tools.approval": { eval: "deny" as const }, egress: ["a.com"] };
		const before = structuredClone([global, thread]);
		tightenPolicy(global, thread);
		expect([global, thread]).toEqual(before);
	});
});

describe("bash.patterns", () => {
	test("the service's deny and prompt rules (in order), then the thread's, then the service's allow rules", () => {
		const global: PolicyValues = {
			...OPEN,
			"bash.patterns": [rule("g-allow-1", "allow"), rule("g-deny", "deny"), rule("g-allow-2", "allow"), rule("g-prompt", "prompt")],
		};
		const thread = { "bash.patterns": [rule("t-prompt", "prompt"), rule("t-deny", "deny")] };
		expect(tightenPolicy(global, thread).bashPatterns).toEqual([
			rule("g-deny", "deny"),
			rule("g-prompt", "prompt"),
			rule("t-prompt", "prompt"),
			rule("t-deny", "deny"),
			rule("g-allow-1", "allow"),
			rule("g-allow-2", "allow"),
		]);
	});

	test("the thread's allow rules are dropped, they could only loosen", () => {
		const global: PolicyValues = { ...OPEN, "bash.patterns": [rule("g-deny", "deny")] };
		const thread = { "bash.patterns": [rule("rm *", "allow"), rule("t-deny", "deny"), rule("g-deny-too", "allow")] };
		expect(tightenPolicy(global, thread).bashPatterns).toEqual([rule("g-deny", "deny"), rule("t-deny", "deny")]);
	});

	test("a thread with only allow rules leaves the service's rules exactly as they are", () => {
		const global: PolicyValues = { ...OPEN, "bash.patterns": [rule("a*", "allow"), rule("b*", "deny")] };
		expect(tightenPolicy(global, { "bash.patterns": [rule("c*", "allow")] }).bashPatterns).toEqual([rule("a*", "allow"), rule("b*", "deny")]);
	});

	test("a thread's rules against an empty service list are the thread's deny and prompt rules", () => {
		const thread = { "bash.patterns": [rule("a*", "deny"), rule("b*", "allow"), rule("c*", "prompt")] };
		expect(tightenPolicy(OPEN, thread).bashPatterns).toEqual([rule("a*", "deny"), rule("c*", "prompt")]);
	});

	test("a thread rule that matches what a service allow rule matches is judged first", () => {
		const global: PolicyValues = { ...OPEN, "bash.patterns": [rule("npm *", "allow")] };
		expect(tightenPolicy(global, { "bash.patterns": [rule("npm publish*", "deny")] }).bashPatterns[0]).toEqual(rule("npm publish*", "deny"));
	});
});

describe("tools.approval", () => {
	const APPROVALS_IN_ORDER: Approval[] = ["allow", "prompt", "deny"];

	test("per tool the stricter of the service's and the thread's (allow < prompt < deny), for all nine pairs", () => {
		for (const [g, globalApproval] of APPROVALS_IN_ORDER.entries()) {
			for (const [t, threadApproval] of APPROVALS_IN_ORDER.entries()) {
				const effective = tightenPolicy({ ...OPEN, "tools.approval": { eval: globalApproval } }, { "tools.approval": { eval: threadApproval } });
				expect(effective.toolApproval).toEqual({ eval: APPROVALS_IN_ORDER[Math.max(g, t)] as Approval });
			}
		}
	});

	test("tools only one side names keep that side's approval", () => {
		const effective = tightenPolicy({ ...OPEN, "tools.approval": { eval: "deny", write: "prompt" } }, { "tools.approval": { browser_tool: "prompt", edit: "deny" } });
		expect(effective.toolApproval).toEqual({ eval: "deny", write: "prompt", browser_tool: "prompt", edit: "deny" });
	});

	test("a thread's allow for a tool the service does not name is dropped: it would override what the shipped configuration says", () => {
		expect(tightenPolicy(OPEN, { "tools.approval": { eval: "allow", write: "deny" } }).toolApproval).toEqual({ write: "deny" });
	});

	test("a service allow stays when the thread allows too", () => {
		expect(tightenPolicy({ ...OPEN, "tools.approval": { eval: "allow" } }, { "tools.approval": { eval: "allow" } }).toolApproval).toEqual({ eval: "allow" });
	});
});

describe("fetch, webSearch and browser", () => {
	for (const key of ["fetch", "webSearch", "browser"] as const) {
		test(`${key} is allowed only when the service and the thread both allow it`, () => {
			for (const g of [true, false]) {
				for (const t of [true, false, undefined]) {
					// A computed key widens the literal's type; the key is one of the three booleans.
					const global = { ...OPEN, [key]: g } as PolicyValues;
					const thread = (t === undefined ? {} : { [key]: t }) as ThreadPolicy;
					expect(tightenPolicy(global, thread)[key]).toBe(g && (t ?? true));
				}
			}
		});
	}

	test("each switch is independent", () => {
		const effective = tightenPolicy({ ...OPEN, webSearch: false }, { fetch: false });
		expect([effective.fetch, effective.webSearch, effective.browser]).toEqual([false, false, true]);
	});
});

describe("readOnly", () => {
	test("is on when the service or the thread turns it on, and a thread's false never clears the service's true", () => {
		expect(tightenPolicy(OPEN, {}).readOnly).toBe(false);
		expect(tightenPolicy(OPEN, { readOnly: false }).readOnly).toBe(false);
		expect(tightenPolicy(OPEN, { readOnly: true }).readOnly).toBe(true);
		expect(tightenPolicy({ ...OPEN, readOnly: true }, {}).readOnly).toBe(true);
		expect(tightenPolicy({ ...OPEN, readOnly: true }, { readOnly: false }).readOnly).toBe(true);
	});
});

describe("egress", () => {
	test("an empty service list takes the thread's list", () => {
		expect(tightenPolicy(OPEN, { egress: ["a.com", "*.b.com"] }).egress).toEqual(["a.com", "*.b.com"]);
	});

	test("an empty thread list leaves the service's list", () => {
		expect(tightenPolicy({ ...OPEN, egress: ["a.com"] }, { egress: [] }).egress).toEqual(["a.com"]);
		expect(tightenPolicy({ ...OPEN, egress: ["a.com"] }, {}).egress).toEqual(["a.com"]);
	});

	test("two non-empty lists: the effective list is the thread's, every entry of which the service's list holds", () => {
		expect(tightenPolicy({ ...OPEN, egress: ["a.com", "b.com", "*.c.com"] }, { egress: ["b.com", "a.com"] }).egress).toEqual(["b.com", "a.com"]);
		expect(tightenPolicy({ ...OPEN, egress: ["a.com"] }, { egress: ["a.com"] }).egress).toEqual(["a.com"]);
	});

	test("a service list that changed after the create never lets the thread widen it", () => {
		expect(tightenPolicy({ ...OPEN, egress: ["a.com", "c.com"] }, { egress: ["a.com", "b.com"] }).egress).toEqual(["a.com"]);
		expect(tightenPolicy({ ...OPEN, egress: ["c.com"] }, { egress: ["a.com", "b.com"] }).egress).toEqual(["c.com"]);
	});

	test("egressWidens: only two non-empty lists, the thread naming a destination the service does not", () => {
		expect(egressWidens([], ["a.com"])).toBe(false);
		expect(egressWidens(["a.com"], [])).toBe(false);
		expect(egressWidens([], [])).toBe(false);
		expect(egressWidens(["a.com", "b.com"], ["b.com"])).toBe(false);
		expect(egressWidens(["a.com", "b.com"], ["b.com", "a.com"])).toBe(false);
		expect(egressWidens(["a.com"], ["a.com", "b.com"])).toBe(true);
		expect(egressWidens(["a.com"], ["b.com"])).toBe(true);
		expect(egressWidens(["*.a.com"], ["x.a.com"])).toBe(true);
	});
});

describe("spend caps", () => {
	test("the smaller non-zero cap applies, 0 being none", () => {
		const cases: [number, number | undefined, number][] = [
			[0, undefined, 0],
			[0, 0, 0],
			[0, 5, 5],
			[5, undefined, 5],
			[5, 0, 5],
			[5, 3, 3],
			[3, 5, 3],
			[3, 3, 3],
		];
		for (const [global, thread, expected] of cases) {
			const effective = tightenPolicy(
				{ ...OPEN, "spend.turnUSD": global, "spend.threadUSD": global, "spend.dayUSD": global },
				thread === undefined ? {} : { "spend.turnUSD": thread, "spend.threadUSD": thread, "spend.dayUSD": thread },
			);
			expect(effective.spend).toEqual({ turn: expected, thread: expected, day: expected });
		}
	});

	test("each scope is tightened on its own", () => {
		const effective = tightenPolicy(
			{ ...OPEN, "spend.turnUSD": 1, "spend.threadUSD": 0, "spend.dayUSD": 10 },
			{ "spend.turnUSD": 2, "spend.threadUSD": 4, "spend.dayUSD": 5 },
		);
		expect(effective.spend).toEqual({ turn: 1, thread: 4, day: 5 });
	});
});

describe("models.allowed", () => {
	test("every non-empty list applies, the service's first", () => {
		expect(tightenPolicy({ ...OPEN, "models.allowed": ["a/*"] }, { "models.allowed": ["a/x"] }).modelsAllowed).toEqual([["a/*"], ["a/x"]]);
	});

	test("an empty list is left out: it allows every model", () => {
		expect(tightenPolicy(OPEN, {}).modelsAllowed).toEqual([]);
		expect(tightenPolicy({ ...OPEN, "models.allowed": ["a/*"] }, { "models.allowed": [] }).modelsAllowed).toEqual([["a/*"]]);
		expect(tightenPolicy(OPEN, { "models.allowed": ["b/*"] }).modelsAllowed).toEqual([["b/*"]]);
	});
});

describe("parseThreadPolicy", () => {
	test("absent and null are no policy; {} is no policy", () => {
		expect(parseThreadPolicy(undefined)).toEqual({});
		expect(parseThreadPolicy(null)).toEqual({});
		expect(parseThreadPolicy({})).toEqual({});
	});

	test("each key is parsed by its registry validator", () => {
		expect(parseThreadPolicy({ egress: ["EXAMPLE.com"], fetch: false, "spend.turnUSD": 0.5 })).toEqual({
			egress: ["example.com"],
			fetch: false,
			"spend.turnUSD": 0.5,
		});
	});

	test("an unknown key, a registry key with its prefix and a non-policy setting are rejected naming the key", () => {
		for (const key of ["nope", "policy.fetch", "git.push", "git.branch", "bash", "__proto__x"]) {
			expect(() => parseThreadPolicy({ [key]: true })).toThrow(`unknown policy key ${key}`);
		}
	});

	test("a value its validator refuses is a SettingError naming the setting", () => {
		expect(() => parseThreadPolicy({ fetch: "no" })).toThrow(SettingError);
		expect(() => parseThreadPolicy({ fetch: "no" })).toThrow("policy.fetch must be true or false");
	});

	test("anything but an object is rejected", () => {
		for (const raw of [[], "x", 1, true]) expect(() => parseThreadPolicy(raw)).toThrow("policy must be an object");
	});
});

describe("effectivePolicy", () => {
	const settingsWith = (stored: Partial<SettingValues>) => ({
		get<K extends SettingKey>(key: K): SettingValues[K] {
			return (stored[key] ?? REGISTRY[key].default) as SettingValues[K];
		},
	});

	test("globalPolicy carries the settings' values, which default to an open policy", () => {
		expect(globalPolicy(settingsWith({}))).toEqual(OPEN);
		expect(globalPolicy(settingsWith({ "policy.fetch": false, "policy.tools.approval": { eval: "deny" }, "policy.spend.dayUSD": 3 }))).toEqual({
			...OPEN,
			fetch: false,
			"tools.approval": { eval: "deny" },
			"spend.dayUSD": 3,
		});
	});

	test("tightens the settings as they are at the call, so a later change of the service's policy applies", () => {
		const stored: Partial<SettingValues> = {};
		const settings = settingsWith(stored);
		const thread = { fetch: false, egress: ["a.com"] };
		expect(effectivePolicy(settings, thread).browser).toBe(true);
		stored["policy.browser"] = false;
		expect(effectivePolicy(settings, thread).browser).toBe(false);
		stored["policy.egress"] = ["b.com"];
		expect(effectivePolicy(settings, thread).egress).toEqual(["b.com"]);
		delete stored["policy.egress"];
		expect(effectivePolicy(settings, thread).egress).toEqual(["a.com"]);
	});
});
