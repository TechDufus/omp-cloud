import { describe, expect, test } from "bun:test";
import {
	completions,
	parseCommand,
	resolveThread,
	shortName,
	USAGE_LAUNCH,
	USAGE_LOGIN,
	USAGE_SEND,
	USAGE_USE,
	type Command,
	type ThreadRef,
} from "../src/commands";
import type { CloudClient } from "../src/api";
import { cloudErrorFromStatus } from "../src/errors";
import { resolveParsed } from "../src/resolve";
import { detail, summary } from "./builders";

const IDS = ["aaaaaak3x9fa", "aaaaaaab12cd", "aaaaaak3zzzz", "bbbbbbq9w8e7"];
const THREADS: ThreadRef[] = IDS.map(id => ({ id, name: "" }));

/** Parses `args` and resolves its thread reference the way `/cloud` does: through the service, here one that holds `threads`. */
async function run(args: string, threads: ThreadRef[] = THREADS): Promise<Command> {
	const client: Pick<CloudClient, "thread" | "listThreadsPage"> = {
		async thread(id) {
			if (!threads.some(t => t.id === id)) throw cloudErrorFromStatus(404, "no such thread");
			return detail({ id });
		},
		async listThreadsPage() {
			return { threads: threads.map(t => summary({ id: t.id, name: t.name, title: t.title ?? "" })), next: null, total: threads.length };
		},
	};
	return resolveParsed(parseCommand(args), client, { jobOf: id => threads.find(t => t.id === id)?.job });
}

describe("command parsing", () => {
	const cases: [string, Command][] = [
		["fix the bug", { kind: "launch", task: "fix the bug" }],
		["  fix the bug  ", { kind: "launch", task: "fix the bug" }],
		["new stop the flake", { kind: "launch", task: "stop the flake" }],
		["NEW   Stop   the flake", { kind: "launch", task: "Stop   the flake" }],
		["new", { kind: "error", message: USAGE_LAUNCH }],
		["stop k3x9fa", { kind: "stop", thread: "aaaaaak3x9fa" }],
		["STOP k3x9fa", { kind: "stop", thread: "aaaaaak3x9fa" }],
		["", { kind: "hub" }],
		["   ", { kind: "hub" }],
		["answer k3x9fa", { kind: "answer", thread: "aaaaaak3x9fa", text: "" }],
		["answer k3x9fa  use the second one", { kind: "answer", thread: "aaaaaak3x9fa", text: "use the second one" }],
		["answer", { kind: "error", message: "☁ usage: /cloud answer <id>" }],
		["LIST", { kind: "list" }],
		["list everything please", { kind: "list" }],
		["send k3x9fa hi there", { kind: "send", thread: "aaaaaak3x9fa", text: "hi there" }],
		["send k3x9fa", { kind: "error", message: USAGE_SEND }],
		["send", { kind: "error", message: USAGE_SEND }],
		["pull aaaaaaab12cd", { kind: "pull", thread: "aaaaaaab12cd", into: undefined }],
		["pull ab12cd --into ../out", { kind: "pull", thread: "aaaaaaab12cd", into: "../out" }],
		['pull ab12cd --into "my dir/x"', { kind: "pull", thread: "aaaaaaab12cd", into: "my dir/x" }],
		["pull ab12cd --into", { kind: "error", message: "☁ usage: /cloud pull <id> [--into <dir>]" }],
		["pull ab12cd --into --force", { kind: "error", message: "☁ usage: /cloud pull <id> [--into <dir>]" }],
		["pull ab12cd extra", { kind: "error", message: "☁ usage: /cloud pull <id> [--into <dir>]" }],
		["watch ab12cd", { kind: "watch", thread: "aaaaaaab12cd" }],
		["show bbb", { kind: "show", thread: "bbbbbbq9w8e7" }],
		["resume q9w8e7", { kind: "resume", thread: "bbbbbbq9w8e7" }],
		["delete k3x9fa", { kind: "delete", thread: "aaaaaak3x9fa" }],
		["unwatch", { kind: "unwatch" }],
		["status", { kind: "status" }],
		["dashboard", { kind: "dashboard" }],
		["help", { kind: "help" }],
		["pull", { kind: "error", message: "☁ usage: /cloud pull <id>" }],
	];
	for (const [args, want] of cases) {
		test(JSON.stringify(args), async () => expect(await run(args)).toEqual(want));
	}

	test("an id verb with no matching thread explains how to launch a task that starts with the verb", async () => {
		expect(await run("stop the flaky test")).toEqual({
			kind: "error",
			message: '☁ no thread matches "the"; to start a cloud task beginning with "stop", use /cloud new <task>',
		});
	});

	test("an ambiguous prefix lists the candidates", async () => {
		expect(await run("pull aaaaaa")).toEqual({
			kind: "error",
			message: '☁ "aaaaaa" matches 3 threads: aaaaaak3x9fa, aaaaaaab12cd, aaaaaak3zzzz — use the full 12-character thread id',
		});
	});

	test("parsing alone does not need any threads", () => {
		expect(parseCommand("stop k3x9fa")).toEqual({ kind: "stop", token: "k3x9fa", text: "" });
		expect(parseCommand("send k3x9fa hi there")).toEqual({ kind: "send", token: "k3x9fa", text: "hi there" });
	});
});

describe("/cloud login", () => {
	test("takes exactly one provider", () => {
		expect(parseCommand("login openai-codex")).toEqual({ kind: "login", provider: "openai-codex" });
		expect(parseCommand("LOGIN   anthropic  ")).toEqual({ kind: "login", provider: "anthropic" });
	});

	test("a missing or extra argument is the usage error", () => {
		const usage = { kind: "error" as const, message: USAGE_LOGIN };
		expect(USAGE_LOGIN).toBe("☁ usage: /cloud login <provider>");
		expect(parseCommand("login")).toEqual(usage);
		expect(parseCommand("login   ")).toEqual(usage);
		expect(parseCommand("login openai-codex now")).toEqual(usage);
	});

	test("resolution passes login through without consulting thread ids", async () => {
		expect(await run("login openai-codex", [])).toEqual({ kind: "login", provider: "openai-codex" });
		// a provider that is also a thread id prefix is still a provider
		expect(await run("login aaaaaa")).toEqual({ kind: "login", provider: "aaaaaa" });
		expect(await run("login")).toEqual({ kind: "error", message: USAGE_LOGIN });
	});

	test("is completed as a verb but takes no thread id", () => {
		expect(completions("log", THREADS)?.map(c => c.value)).toEqual(["login"]);
		expect(completions("login ", THREADS)).toBeNull();
	});
});

describe("/cloud dashboard", () => {
	test("takes no argument and needs no threads", async () => {
		expect(parseCommand("dashboard")).toEqual({ kind: "dashboard" });
		expect(parseCommand("DASHBOARD now")).toEqual({ kind: "dashboard" });
		expect(await run("dashboard", [])).toEqual({ kind: "dashboard" });
	});

	test("is completed as a verb but takes no thread id", () => {
		expect(completions("da", THREADS)?.map(c => c.value)).toEqual(["dashboard"]);
		expect(completions("dashboard ", THREADS)).toBeNull();
	});
});

describe("/cloud use", () => {
	test("without a word lists the clouds; with env, personal or paired (any case) picks one", async () => {
		expect(await run("use", [])).toEqual({ kind: "use", cloud: undefined });
		expect(await run("use paired", [])).toEqual({ kind: "use", cloud: "paired" });
		expect(await run("USE Personal", [])).toEqual({ kind: "use", cloud: "personal" });
		expect(await run("use env", [])).toEqual({ kind: "use", cloud: "env" });
	});

	test("any other word is the usage error, so a task that begins with use needs /cloud new", async () => {
		const usage = { kind: "error" as const, message: USAGE_USE };
		expect(await run("use foo", [])).toEqual(usage);
		expect(await run("use paired now", [])).toEqual(usage);
		expect(await run("new use the new API", [])).toEqual({ kind: "launch", task: "use the new API" });
	});

	test("is completed as a verb and completes the three clouds, never a thread id", () => {
		expect(completions("us", THREADS)?.map(c => c.value)).toEqual(["use"]);
		expect(completions("use ", THREADS)?.map(c => c.value)).toEqual(["use env", "use personal", "use paired"]);
		expect(completions("use pa", THREADS)?.map(c => c.value)).toEqual(["use paired"]);
		expect(completions("use paired ", THREADS)).toBeNull();
	});
});

describe("shortName", () => {
	test("is the last 6 characters of the id", () => {
		expect(shortName("aaaaaak3x9fa")).toBe("k3x9fa");
	});
});

describe("resolveThread", () => {
	test("exact id beats prefix; suffix of 4 or more; unique prefix", () => {
		const ids = ["axxxxxxxxxxx", "axxxxxxxxxxxb", "cyyyyyyyyyyy"].map(id => ({ id, name: "" }));
		expect(resolveThread("axxxxxxxxxxx", ids)).toEqual({ id: "axxxxxxxxxxx" });
		expect(resolveThread("AXXXXXXXXXXX", ids)).toEqual({ id: "axxxxxxxxxxx" });
		expect(resolveThread("yyyyyy", ids)).toEqual({ id: "cyyyyyyyyyyy" });
		expect(resolveThread("cy", ids)).toEqual({ id: "cyyyyyyyyyyy" });
		expect(resolveThread("ax", ids)).toEqual({ error: "ambiguous", candidates: [{ id: "axxxxxxxxxxx", name: "" }, { id: "axxxxxxxxxxxb", name: "" }] });
		expect(resolveThread("zzz", ids)).toEqual({ error: "none", candidates: [] });
	});

	test("a suffix shorter than 4 characters is not matched as a suffix", () => {
		expect(resolveThread("e7", THREADS)).toEqual({ error: "none", candidates: [] });
		expect(resolveThread("9w8e7", THREADS)).toEqual({ id: "bbbbbbq9w8e7" });
	});

	test("a word prefix of the name resolves a thread when it is the only one", () => {
		const threads: ThreadRef[] = [
			{ id: "aaaaaak3x9fa", name: "Fix flaky retry test" },
			{ id: "bbbbbbq9w8e7", name: "Add dashboard charts" },
			{ id: "cccccc4m2n5p", name: "" },
		];
		expect(resolveThread("flaky", threads)).toEqual({ id: "aaaaaak3x9fa" });
		expect(resolveThread("DASH", threads)).toEqual({ id: "bbbbbbq9w8e7" });
		expect(resolveThread("retry", threads)).toEqual({ id: "aaaaaak3x9fa" });
		expect(resolveThread("test", threads)).toEqual({ id: "aaaaaak3x9fa" });
		expect(resolveThread("tes", threads)).toEqual({ id: "aaaaaak3x9fa" });
		expect(resolveThread("lak", threads)).toEqual({ error: "none", candidates: [] });
	});

	test("an id match beats a name match", () => {
		const threads: ThreadRef[] = [
			{ id: "aaaaaak3x9fa", name: "Fix k3 dashboard" },
			{ id: "k3rbbbbbbbbb", name: "Other work" },
		];
		expect(resolveThread("k3", threads)).toEqual({ id: "k3rbbbbbbbbb" });
		expect(resolveThread("dash", threads)).toEqual({ id: "aaaaaak3x9fa" });
	});

	test("a job id names a thread: the running job's id as omp lists it, else the bare name-derived id; a suffix alone names nothing", () => {
		const threads: ThreadRef[] = [
			{ id: "aaaaaak3x9fa", name: "Pane zoom shortcut", job: "PaneZoomShortcut-3" },
			{ id: "bbbbbbq9w8e7", name: "", title: "Fix flaky test" },
			{ id: "cccccck1m2n3", name: "" },
		];
		expect(resolveThread("panezoomshortcut-3", threads)).toEqual({ id: "aaaaaak3x9fa" });
		expect(resolveThread("PaneZoomShortcut", threads)).toEqual({ id: "aaaaaak3x9fa" });
		expect(resolveThread("PaneZoomShortcut-4", threads)).toEqual({ error: "none", candidates: [] });
		expect(resolveThread("FixFlakyTest", threads)).toEqual({ id: "bbbbbbq9w8e7" });
		expect(resolveThread("Cloudk1m2n3", threads)).toEqual({ id: "cccccck1m2n3" });
		const twins: ThreadRef[] = [
			{ id: "aaaaaak3x9fa", name: "Pane zoom shortcut" },
			{ id: "dddddd7a8b9c", name: "Pane zoom shortcut", job: "PaneZoomShortcut-2" },
		];
		expect(resolveThread("PaneZoomShortcut-2", twins)).toEqual({ id: "dddddd7a8b9c" });
		expect(resolveThread("PaneZoomShortcut", twins)).toEqual({ error: "ambiguous", candidates: twins });
	});

	test("a word shared by several names is ambiguous and the candidates carry their names", async () => {
		const threads: ThreadRef[] = [
			{ id: "aaaaaak3x9fa", name: "Fix retry queue" },
			{ id: "bbbbbbq9w8e7", name: "Retry flaky upload" },
			{ id: "cccccc4m2n5p", name: "" },
		];
		expect(resolveThread("retry", threads)).toEqual({ error: "ambiguous", candidates: threads.slice(0, 2) });
		expect(await run("pull retry", threads)).toEqual({
			kind: "error",
			message: '☁ "retry" matches 2 threads: aaaaaak3x9fa (Fix retry queue), bbbbbbq9w8e7 (Retry flaky upload) — use the full 12-character thread id',
		});
		expect(await run("show cccccc4m2n5p", threads)).toEqual({ kind: "show", thread: "cccccc4m2n5p" });
	});
});

describe("completions", () => {
	test("verbs while the first word is typed", () => {
		expect(completions("pu", THREADS)?.map(c => c.value)).toEqual(["pull"]);
		expect(completions("", THREADS)?.map(c => c.value)).toContain("resume");
		expect(completions("zz", THREADS)).toBeNull();
	});

	test("cached thread ids after an id verb; the value carries the verb", () => {
		expect(completions("pull ", THREADS)?.map(c => c.value)).toEqual(IDS.map(n => `pull ${n}`));
		expect(completions("pull aaaaaak3", THREADS)?.map(c => c.label)).toEqual(["aaaaaak3x9fa", "aaaaaak3zzzz"]);
	});

	test("the name is each id's description, and a word of it completes the id", () => {
		const threads: ThreadRef[] = [
			{ id: "aaaaaak3x9fa", name: "Fix flaky retry test" },
			{ id: "bbbbbbq9w8e7", name: "" },
		];
		expect(completions("show ", threads)).toEqual([
			{ value: "show aaaaaak3x9fa", label: "aaaaaak3x9fa", description: "Fix flaky retry test" },
			{ value: "show bbbbbbq9w8e7", label: "bbbbbbq9w8e7" },
		]);
		expect(completions("send ret", threads)).toEqual([{ value: "send aaaaaak3x9fa", label: "aaaaaak3x9fa", description: "Fix flaky retry test" }]);
	});

	test("pull offers --into after its id, once", () => {
		expect(completions("pull aaaaaak3x9fa ", THREADS)).toEqual([{ value: "pull aaaaaak3x9fa --into", label: "--into", description: "directory for a scratch clone or a worktree" }]);
		expect(completions("pull aaaaaak3x9fa --i", THREADS)?.map(c => c.value)).toEqual(["pull aaaaaak3x9fa --into"]);
		expect(completions("pull aaaaaak3x9fa --into ", THREADS)).toBeNull();
	});

	test("nothing is offered after the id or for verbs without one", () => {
		expect(completions("send aaaaaak3x9fa ", THREADS)).toBeNull();
		expect(completions("list ", THREADS)).toBeNull();
		expect(completions("fix the ", THREADS)).toBeNull();
	});
});
