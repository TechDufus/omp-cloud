import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store";
import { MAX_IMPORT_BYTES, SettingError, Settings, type SettingKey } from "./index";

const T0 = Date.UTC(2026, 0, 1);

let dir: string;
let store: Store;
let settings: Settings;
let clock: number;

function iso(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

function open(): Store {
	return Store.open({ dataDir: dir, now: () => new Date(clock) });
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-settings-"));
	clock = T0;
	store = open();
	settings = Settings.load(store);
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

describe("update.token is a secret when it is a literal", () => {
	const LITERAL = "ghp_Abc123SECRETliteral";
	const viewOf = () => settings.list().find((v) => v.key === "update.token");
	const rows = () => store.settingsAudit(0, 20).filter((e) => e.key === "update.token");

	test("a literal reads back as (set) in the list, and the service still gets the value", () => {
		settings.apply({ "update.token": LITERAL }, "owner");
		expect(viewOf()).toMatchObject({ value: "(set)", default: "", source: "stored" });
		expect(JSON.stringify(settings.list())).not.toContain("SECRETliteral");
		expect(settings.get("update.token")).toBe(LITERAL);
	});

	test("a !command and an environment variable name are shown as they are; so is empty", () => {
		for (const reference of ["!/usr/bin/gh auth token", "GH_TOKEN", "_X1"]) {
			settings.apply({ "update.token": reference }, "owner");
			expect(viewOf()?.value).toBe(reference);
		}
		settings.apply({ "update.token": null }, "owner");
		expect(viewOf()).toMatchObject({ value: "", source: "default" });
	});

	test("the audit never stores the literal, neither the new nor the old value, and serves it redacted", () => {
		settings.apply({ "update.token": LITERAL }, "alice");
		settings.apply({ "update.token": "ghp_AnotherSECRETvalue" }, "alice");
		settings.apply({ "update.token": "!/usr/bin/gh auth token" }, "alice");
		settings.apply({ "update.token": null }, "alice");

		expect(rows().map((e) => [e.action, e.oldValue, e.newValue])).toEqual([
			["reset", '"!/usr/bin/gh auth token"', null],
			["set", '"(set)"', '"!/usr/bin/gh auth token"'],
			["set", '"(set)"', '"(set)"'],
			["set", null, '"(set)"'],
		]);
		const dump = JSON.stringify(store.settingsAudit(0, 20)) + JSON.stringify(settings.audit({ before: 0, limit: 20 }));
		expect(dump).not.toContain("SECRET");
		expect(settings.audit({ before: 0, limit: 1 }).entries[0]).toMatchObject({ key: "update.token", old: "!/usr/bin/gh auth token", new: null });
	});

	test("an audit row written before redaction existed is served redacted too", () => {
		store.applySettings([{ key: "update.token", value: JSON.stringify(LITERAL) }], "old", "set");
		expect(store.settingsAudit(0, 5)[0]?.newValue).toBe(JSON.stringify(LITERAL));
		const entry = settings.audit({ before: 0, limit: 5 }).entries[0];
		expect(entry).toMatchObject({ key: "update.token", new: "(set)" });
	});

	test("an export omits a literal (it would import back as the redacted text) and keeps a reference; an import audits no literal", () => {
		settings.apply({ "update.token": LITERAL, "update.mode": "auto" }, "owner");
		expect(settings.exportYaml()).not.toContain("ghp_");
		expect(settings.exportYaml()).toContain("mode: auto");
		settings.apply({ "update.token": "!gh auth token" }, "owner");
		expect(settings.exportYaml()).toContain("!gh auth token");
		settings.importYaml(`update:\n  token: ${LITERAL}\n`, "owner", "merge");
		expect(JSON.stringify(store.settingsAudit(0, 20))).not.toContain("SECRETliteral");
	});
});

/** The thrown value of `fn`, or undefined. */
function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("get and list", () => {
	test("a fresh store answers with the registry defaults", () => {
		expect(settings.get("git.push")).toBe("never");
		expect(settings.get("git.branch")).toBe("omp-cloud/{thread}");
		expect(settings.get("git.protected")).toEqual(["main", "master", "develop", "release/*"]);
	});

	test("list has every key in registry order with every field", () => {
		const views = settings.list();
		expect(views.slice(0, 3).map((v) => v.key)).toEqual(["git.push", "git.branch", "git.protected"]);
		expect(views.slice(3).map((v) => [v.key, v.type])).toEqual([
			["git.sign", "enum"],
			["git.committer", "string"],
			["git.pr", "enum"],
			["policy.bash.patterns", "json"],
			["policy.tools.approval", "json"],
			["policy.fetch", "bool"],
			["policy.webSearch", "bool"],
			["policy.browser", "bool"],
			["policy.readOnly", "bool"],
			["policy.egress", "string[]"],
			["policy.spend.turnUSD", "number"],
			["policy.spend.threadUSD", "number"],
			["policy.spend.dayUSD", "number"],
			["policy.models.allowed", "string[]"],
			["vm.packages", "string[]"],
			["vm.setup", "string[]"],
			["lifecycle.archiveAfterDays", "number"],
			["update.mode", "enum"],
			["update.feed", "string"],
			["update.token", "string"],
			["update.unit", "string"],
			["update.ompUnits", "string[]"],
		]);
		expect(views[0]).toEqual({
			key: "git.push",
			type: "enum",
			value: "never",
			default: "never",
			source: "default",
			doc: expect.any(String),
			choices: ["never", "ask", "auto"],
			updatedAt: "",
			updatedBy: "",
		});
		expect(views[1]).toMatchObject({ type: "string", choices: [], source: "default" });
		expect(views[2]).toMatchObject({ type: "string[]", choices: [], source: "default" });
	});

	test("a stored value shows its source, who set it and when", () => {
		clock += 5000;
		settings.apply({ "git.push": "ask" }, "alice");
		expect(settings.get("git.push")).toBe("ask");
		expect(settings.list()[0]).toMatchObject({ value: "ask", default: "never", source: "stored", updatedAt: iso(5000), updatedBy: "alice" });
	});

	test("stored values survive a restart", () => {
		settings.apply({ "git.push": "auto", "git.protected": ["trunk"] }, "alice");
		store.close();
		store = open();
		settings = Settings.load(store);
		expect(settings.get("git.push")).toBe("auto");
		expect(settings.get("git.protected")).toEqual(["trunk"]);
	});

	test("load ignores a stored key the registry lacks and a value its validator refuses, with a warning", () => {
		store.applySettings(
			[
				{ key: "git.push", value: '"sometimes"' },
				{ key: "gone.key", value: "1" },
				{ key: "git.branch", value: '"x/{thread}"' },
			],
			"old",
			"set",
		);
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			settings = Settings.load(store);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
				expect.stringContaining("git.push"),
				expect.stringContaining("gone.key"),
			]);
		} finally {
			warn.mockRestore();
		}
		expect(settings.get("git.push")).toBe("never");
		expect(settings.get("git.branch")).toBe("x/{thread}");
		expect(settings.list()[0]).toMatchObject({ source: "default" });
	});
});

describe("apply", () => {
	test("sets several keys at once and returns the changed keys", () => {
		expect(settings.apply({ "git.push": "ask", "git.protected": ["a"] }, "alice")).toEqual(["git.push", "git.protected"]);
		expect(settings.get("git.push")).toBe("ask");
		expect(settings.get("git.protected")).toEqual(["a"]);
	});

	test("null resets a key to its default", () => {
		settings.apply({ "git.push": "ask" }, "alice");
		expect(settings.apply({ "git.push": null }, "alice")).toEqual(["git.push"]);
		expect(settings.get("git.push")).toBe("never");
		expect(settings.list()[0]).toMatchObject({ source: "default", updatedAt: "", updatedBy: "" });
	});

	test("a value equal to the default is a reset, so stored always means different", () => {
		settings.apply({ "git.push": "ask" }, "alice");
		expect(settings.apply({ "git.push": "never" }, "bob")).toEqual(["git.push"]);
		expect(settings.list()[0]).toMatchObject({ source: "default" });
		expect(settings.apply({ "git.protected": ["main", "master", "develop", "release/*"] }, "bob")).toEqual([]);
		expect(store.settingRows()).toEqual([]);
		expect(settings.audit({ before: 0, limit: 10 }).entries.map((e) => [e.action, e.key])).toEqual([
			["reset", "git.push"],
			["set", "git.push"],
		]);
	});

	test("a change that leaves everything as it was writes no row, no audit entry and tells no listener", () => {
		settings.apply({ "git.push": "ask" }, "alice");
		const heard: (readonly SettingKey[])[] = [];
		settings.subscribe((changed) => heard.push(changed));
		clock += 1000;
		expect(settings.apply({ "git.push": "ask", "git.branch": null, "git.protected": null }, "bob")).toEqual([]);
		expect(settings.apply({}, "bob")).toEqual([]);
		expect(heard).toEqual([]);
		expect(settings.audit({ before: 0, limit: 10 }).entries).toHaveLength(1);
		expect(settings.list()[0]).toMatchObject({ updatedAt: iso(0), updatedBy: "alice" });
	});

	test("an unknown key throws SettingError and applies nothing", () => {
		const error = thrown(() => settings.apply({ "git.push": "ask", "git.nope": 1 }, "alice"));
		expect(error).toBeInstanceOf(SettingError);
		expect((error as SettingError).message).toBe("unknown setting git.nope");
		expect(settings.get("git.push")).toBe("never");
		expect(settings.audit({ before: 0, limit: 10 }).entries).toEqual([]);
		for (const key of ["git", "toString", ""]) expect(() => settings.apply({ [key]: 1 }, "alice")).toThrow(`unknown setting ${key}`);
	});

	test("an invalid value throws the validator's message and applies nothing, whatever the order", () => {
		for (const changes of [
			{ "git.push": "ask", "git.branch": "no-placeholder" },
			{ "git.branch": "no-placeholder", "git.push": "ask" },
		]) {
			expect(() => settings.apply(changes, "alice")).toThrow("git.branch must contain {thread}");
			expect(settings.get("git.push")).toBe("never");
			expect(store.settingRows()).toEqual([]);
			expect(store.settingsAudit(0, 10)).toEqual([]);
		}
	});

	test("subscribers hear the changed keys after the cache is fresh, until they unsubscribe", () => {
		const seen: { changed: readonly SettingKey[]; push: string }[] = [];
		const unsubscribe = settings.subscribe((changed) => seen.push({ changed, push: settings.get("git.push") }));
		settings.apply({ "git.push": "auto", "git.protected": ["a"] }, "alice");
		expect(seen).toEqual([{ changed: ["git.push", "git.protected"], push: "auto" }]);
		unsubscribe();
		settings.apply({ "git.push": "ask" }, "alice");
		expect(seen).toHaveLength(1);
	});

	test("a throwing subscriber is logged and does not stop the others or the change", () => {
		const log = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			let heard = 0;
			settings.subscribe(() => {
				throw new Error("boom");
			});
			settings.subscribe(() => heard++);
			expect(settings.apply({ "git.push": "ask" }, "alice")).toEqual(["git.push"]);
			expect(heard).toBe(1);
			expect(log).toHaveBeenCalledTimes(1);
			expect(settings.get("git.push")).toBe("ask");
		} finally {
			log.mockRestore();
		}
	});
});

describe("audit", () => {
	test("entries are newest first with old and new as JSON values, null for the default", () => {
		settings.apply({ "git.push": "ask" }, "alice");
		clock += 1000;
		settings.apply({ "git.push": "auto", "git.protected": ["x"] }, "bob");
		clock += 1000;
		settings.apply({ "git.push": null }, "carol");
		const { entries, next } = settings.audit({ before: 0, limit: 50 });
		expect(next).toBe(0);
		expect(entries).toEqual([
			{ seq: 4, at: iso(2000), actor: "carol", action: "reset", key: "git.push", old: "auto", new: null },
			{ seq: 3, at: iso(1000), actor: "bob", action: "set", key: "git.protected", old: null, new: ["x"] },
			{ seq: 2, at: iso(1000), actor: "bob", action: "set", key: "git.push", old: "ask", new: "auto" },
			{ seq: 1, at: iso(0), actor: "alice", action: "set", key: "git.push", old: null, new: "ask" },
		]);
	});

	test("pages by before, next being the seq to pass and 0 at the end", () => {
		for (const mode of ["ask", "auto", "ask", "auto", "ask"] as const) settings.apply({ "git.push": mode }, "alice");
		const first = settings.audit({ before: 0, limit: 2 });
		expect(first.entries.map((e) => e.seq)).toEqual([5, 4]);
		expect(first.next).toBe(4);
		const second = settings.audit({ before: first.next, limit: 2 });
		expect(second.entries.map((e) => e.seq)).toEqual([3, 2]);
		expect(second.next).toBe(2);
		const last = settings.audit({ before: second.next, limit: 2 });
		expect(last.entries.map((e) => e.seq)).toEqual([1]);
		expect(last.next).toBe(0);
		expect(settings.audit({ before: 0, limit: 5 }).next).toBe(0);
	});
});

describe("exportYaml and importYaml", () => {
	test("export holds only stored values as nested YAML, and {} when all are default", () => {
		expect(Bun.YAML.parse(settings.exportYaml())).toEqual({});
		settings.apply({ "git.push": "ask", "git.protected": ["trunk", "stable/*"] }, "alice");
		expect(Bun.YAML.parse(settings.exportYaml())).toEqual({ git: { push: "ask", protected: ["trunk", "stable/*"] } });
	});

	test("an export imports into another store and gives the same settings", async () => {
		settings.apply({ "git.push": "auto", "git.branch": "bots/{thread}", "git.protected": ["trunk"] }, "alice");
		const text = settings.exportYaml();
		const otherDir = await mkdtemp(join(tmpdir(), "omp-cloud-settings-"));
		const other = Store.open({ dataDir: otherDir });
		try {
			const copy = Settings.load(other);
			expect(copy.importYaml(text, "bob", "replace")).toEqual(["git.push", "git.branch", "git.protected"]);
			expect(copy.list().map((v) => [v.key, v.value, v.source])).toEqual(settings.list().map((v) => [v.key, v.value, v.source]));
			expect(copy.exportYaml()).toBe(text);
		} finally {
			other.close();
			await rm(otherDir, { recursive: true, force: true });
		}
	});

	test("the policy keys export as nested YAML and import back", async () => {
		settings.apply(
			{
				"policy.bash.patterns": [{ match: "npm publish*", approval: "prompt" }],
				"policy.tools.approval": { eval: "deny" },
				"policy.fetch": false,
				"policy.egress": ["example.com"],
				"policy.spend.turnUSD": 0.5,
				"policy.models.allowed": ["anthropic/*"],
			},
			"alice",
		);
		const text = settings.exportYaml();
		expect(Bun.YAML.parse(text)).toEqual({
			policy: {
				bash: { patterns: [{ match: "npm publish*", approval: "prompt" }] },
				tools: { approval: { eval: "deny" } },
				fetch: false,
				egress: ["example.com"],
				spend: { turnUSD: 0.5 },
				models: { allowed: ["anthropic/*"] },
			},
		});
		const otherDir = await mkdtemp(join(tmpdir(), "omp-cloud-settings-"));
		const other = Store.open({ dataDir: otherDir });
		try {
			const copy = Settings.load(other);
			copy.importYaml(text, "bob", "replace");
			expect(copy.get("policy.bash.patterns")).toEqual([{ match: "npm publish*", approval: "prompt" }]);
			expect(copy.get("policy.tools.approval")).toEqual({ eval: "deny" });
			expect(copy.get("policy.fetch")).toBe(false);
			expect(copy.get("policy.spend.turnUSD")).toBe(0.5);
			expect(copy.exportYaml()).toBe(text);
		} finally {
			other.close();
			await rm(otherDir, { recursive: true, force: true });
		}
	});

	test("replace resets the keys the file does not name, merge keeps them", () => {
		settings.apply({ "git.push": "ask", "git.branch": "bots/{thread}" }, "alice");
		expect(settings.importYaml("git:\n  protected: [trunk]\n", "bob", "merge")).toEqual(["git.protected"]);
		expect(settings.get("git.push")).toBe("ask");
		expect(settings.get("git.branch")).toBe("bots/{thread}");
		expect(settings.get("git.protected")).toEqual(["trunk"]);

		expect(settings.importYaml("git:\n  push: auto\n", "bob", "replace")).toEqual(["git.push", "git.branch", "git.protected"]);
		expect(settings.get("git.push")).toBe("auto");
		expect(settings.get("git.branch")).toBe("omp-cloud/{thread}");
		expect(settings.get("git.protected")).toEqual(["main", "master", "develop", "release/*"]);
	});

	test("an import audits every changed key as import under the importer", () => {
		settings.apply({ "git.push": "ask" }, "alice");
		settings.importYaml("git.push: auto\ngit.branch: b/{thread}\n", "bob", "replace");
		const entries = settings.audit({ before: 0, limit: 10 }).entries.slice(0, 2);
		expect(entries.map((e) => [e.actor, e.action, e.key, e.old, e.new])).toEqual([
			["bob", "import", "git.branch", null, "b/{thread}"],
			["bob", "import", "git.push", "ask", "auto"],
		]);
	});

	test("dotted keys, nested keys and a mix are the same document", () => {
		settings.importYaml("git.push: ask\ngit:\n  branch: b/{thread}\n", "bob", "merge");
		expect(settings.get("git.push")).toBe("ask");
		expect(settings.get("git.branch")).toBe("b/{thread}");
	});

	test("null in the file resets a key under merge too", () => {
		settings.apply({ "git.push": "ask" }, "alice");
		expect(settings.importYaml("git:\n  push: null\n", "bob", "merge")).toEqual(["git.push"]);
		expect(settings.get("git.push")).toBe("never");
	});

	test("an empty document is an empty mapping", () => {
		settings.apply({ "git.push": "ask" }, "alice");
		expect(settings.importYaml("", "bob", "merge")).toEqual([]);
		expect(settings.get("git.push")).toBe("ask");
		expect(settings.importYaml("", "bob", "replace")).toEqual(["git.push"]);
		expect(settings.get("git.push")).toBe("never");
	});

	test("a bad file throws SettingError and applies nothing, even under replace", () => {
		settings.apply({ "git.push": "ask" }, "alice");
		const before = settings.audit({ before: 0, limit: 10 }).entries.length;
		const cases: [string, string][] = [
			["git:\n  nope: 1\n", "unknown setting git.nope"],
			["nope: 1\n", "unknown setting nope"],
			["git:\n  push:\n    deep: 1\n", "git.push"],
			["git: 5\n", "git must be a mapping of settings"],
			["git.push: ask\ngit:\n  push: auto\n", "git.push is set twice"],
			["git:\n  push: sometimes\n", "git.push must be one of never, ask, auto"],
			["git:\n  branch: nope\n  push: auto\n", "git.branch must contain {thread}"],
			["- a\n- b\n", "the settings file must be a mapping of settings"],
			["just text\n", "the settings file must be a mapping of settings"],
			["git: {push: ask\n", "invalid YAML"],
			[`# ${"x".repeat(MAX_IMPORT_BYTES)}\n`, "the settings file is larger than"],
		];
		for (const [text, message] of cases) {
			const error = thrown(() => settings.importYaml(text, "bob", "replace"));
			expect(error).toBeInstanceOf(SettingError);
			expect((error as SettingError).message).toContain(message);
		}
		expect(settings.get("git.push")).toBe("ask");
		expect(settings.audit({ before: 0, limit: 10 }).entries).toHaveLength(before);
	});

	test("a recursive alias is refused instead of walked forever", () => {
		const error = thrown(() => settings.importYaml("git: &g\n  push: ask\n  loop: *g\n", "bob", "replace"));
		expect(error).toBeInstanceOf(SettingError);
		expect(settings.get("git.push")).toBe("never");
	});
});
