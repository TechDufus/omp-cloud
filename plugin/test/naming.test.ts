import { describe, expect, test } from "bun:test";
import { cleanName, generateName, NAME_MAX, NAME_TIMEOUT_MS, type NameInput } from "../src/naming";

describe("cleanName", () => {
	test("leaves a plain name alone", () => {
		expect(cleanName("Fix flaky retry test")).toBe("Fix flaky retry test");
	});

	test("strips leading icon, emoji and private-use glyphs", () => {
		expect(cleanName("🔧 Fix flaky retry test")).toBe("Fix flaky retry test");
		expect(cleanName("\u{1F9EA}\uFE0F  Fix flaky retry test")).toBe("Fix flaky retry test");
		expect(cleanName("\uF0AD Fix flaky retry test")).toBe("Fix flaky retry test");
		expect(cleanName("\u{F0000} \u{1F527} Fix flaky retry test")).toBe("Fix flaky retry test");
	});

	test("strips surrounding quotes, backticks and trailing punctuation", () => {
		expect(cleanName('"Fix flaky retry test"')).toBe("Fix flaky retry test");
		expect(cleanName("“Fix flaky retry test.”")).toBe("Fix flaky retry test");
		expect(cleanName("`Fix flaky retry test`")).toBe("Fix flaky retry test");
		expect(cleanName("'Fix flaky retry test':")).toBe("Fix flaky retry test");
	});

	test("keeps digits and inner punctuation", () => {
		expect(cleanName("1.2 Upgrade to v2 (beta)")).toBe("1.2 Upgrade to v2 (beta)");
	});

	test("collapses whitespace and control characters into single spaces", () => {
		expect(cleanName("  Fix \t flaky\n\nretry\u0007test  ")).toBe("Fix flaky retry test");
	});

	test("returns an empty name when nothing is left", () => {
		expect(cleanName("")).toBe("");
		expect(cleanName('  🔧 "" ')).toBe("");
		expect(cleanName("\u{1F527}\u{1F527}")).toBe("");
	});

	test("cuts a long name at a word boundary within the limit", () => {
		const long = "Refactor the retry queue so jobs survive a redis restart without dropping any of them";
		const name = cleanName(long);
		expect([...name].length).toBeLessThanOrEqual(NAME_MAX);
		expect(long.startsWith(name)).toBe(true);
		expect(name).toBe("Refactor the retry queue so jobs survive a redis restart");
	});

	test("keeps a name that is exactly the limit, and one whose limit falls at a space", () => {
		const exact = `${"a".repeat(29)} ${"b".repeat(30)}`;
		expect([...exact]).toHaveLength(NAME_MAX);
		expect(cleanName(exact)).toBe(exact);
		expect(cleanName(`${exact} more`)).toBe(exact);
	});

	test("counts code points, not UTF-16 units, and hard-cuts a single long word", () => {
		const emoji = `${"x".repeat(30)}${"\u{1F600}".repeat(40)}`;
		expect([...cleanName(emoji)]).toHaveLength(NAME_MAX);
		expect([...cleanName("w".repeat(100))]).toHaveLength(NAME_MAX);
	});
});

interface Call {
	task: string;
	registry: unknown;
	settings: unknown;
	sessionId: unknown;
	current: unknown;
	signal: AbortSignal | undefined;
}

const MODEL = { provider: "anthropic", id: "claude-sonnet-5-5" };
const FOUND = { found: true };
const REGISTRY = { find: (provider: string, id: string) => (provider === MODEL.provider && id === MODEL.id ? FOUND : undefined) };
const SETTINGS = { settings: true };

function input(over: Partial<NameInput> = {}): NameInput {
	return { task: "make the retry queue survive redis restarts", registry: REGISTRY as never, settings: SETTINGS as never, model: MODEL, signal: new AbortController().signal, ...over };
}

describe("generateName", () => {
	test("asks omp's title generator with the registry, settings, current model and a signal, and cleans the answer", async () => {
		const calls: Call[] = [];
		const name = await generateName(input(), async (task, registry, settings, sessionId, current, _metadata, _prompt, signal) => {
			calls.push({ task, registry, settings, sessionId, current, signal });
			return '🔧 "Make retry queue survive restarts."';
		});
		expect(name).toBe("Make retry queue survive restarts");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.task).toBe("make the retry queue survive redis restarts");
		expect(calls[0]?.registry).toBe(REGISTRY);
		expect(calls[0]?.settings).toBe(SETTINGS);
		expect(calls[0]?.current).toBe(FOUND);
		expect(calls[0]?.signal?.aborted).toBe(false);
	});

	test("passes no current model when the session has none or the registry does not know it", async () => {
		const seen: unknown[] = [];
		const generate = async (_task: string, _registry: unknown, _settings: unknown, _sessionId?: string, current?: unknown) => {
			seen.push(current);
			return "Some name";
		};
		await generateName(input({ model: undefined }), generate);
		await generateName(input({ model: { provider: "other", id: "m" } }), generate);
		expect(seen).toEqual([undefined, undefined]);
	});

	test("a null answer (a greeting, no title model) is an empty name", async () => {
		expect(await generateName(input(), async () => null)).toBe("");
	});

	test("an answer of nothing but glyphs is an empty name", async () => {
		expect(await generateName(input(), async () => "🔧 ")).toBe("");
	});

	test("a failing generator is an empty name, not an error", async () => {
		expect(await generateName(input(), async () => Promise.reject(new Error("no api key")))).toBe("");
	});

	test("a generator that throws synchronously is an empty name", async () => {
		const generate = () => {
			throw new Error("settings not initialized");
		};
		expect(await generateName(input(), generate)).toBe("");
	});

	test("no registry (a host that cannot resolve models) asks nothing", async () => {
		let called = false;
		const name = await generateName(input({ registry: undefined }), async () => {
			called = true;
			return "Name";
		});
		expect(name).toBe("");
		expect(called).toBe(false);
	});

	test("an already aborted launch asks nothing", async () => {
		const launch = new AbortController();
		launch.abort();
		let called = false;
		const name = await generateName(input({ signal: launch.signal }), async () => {
			called = true;
			return "Name";
		});
		expect(name).toBe("");
		expect(called).toBe(false);
	});

	test("the cap ends a generator that ignores its signal, and aborts the signal it was given", async () => {
		let given: AbortSignal | undefined;
		const started = performance.now();
		const name = await generateName(input({ timeoutMs: 40 }), (_task, _registry, _settings, _sessionId, _current, _metadata, _prompt, signal) => {
			given = signal;
			return new Promise<string | null>(() => {});
		});
		expect(name).toBe("");
		expect(performance.now() - started).toBeLessThan(2000);
		expect(given?.aborted).toBe(true);
	});

	test("aborting the launch ends a pending request at once", async () => {
		const launch = new AbortController();
		const pending = generateName(input({ signal: launch.signal }), () => new Promise<string | null>(() => {}));
		launch.abort();
		expect(await pending).toBe("");
	});

	test("the default cap is 8 seconds", () => {
		expect(NAME_TIMEOUT_MS).toBe(8000);
	});
});
