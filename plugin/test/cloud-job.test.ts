import { describe, expect, test } from "bun:test";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { cloudJobId, cloudJobLiveWidget, cloudJobStage, cloudJobTile, cloudJobWidget, toolCall, toolLabel } from "../src/cloud-job";
import { metrics, pending, summary, turn } from "./builders";

const NOW = Date.parse("2026-10-19T10:00:00Z");

const used = metrics({
	usage: { inputTokens: 12_000, outputTokens: 3_000, cacheReadTokens: 120_000, cacheWriteTokens: 4_000, cost: 0.42 },
	requests: 7,
	tools: 19,
	workMs: 252_000,
	context: { tokens: 20_000, window: 200_000, at: "2026-10-19T09:50:00Z" },
	turns: [
		{ n: 1, cost: 0.1, contextTokens: 8_000 },
		{ n: 2, cost: 0.12, contextTokens: 15_000 },
		{ n: 3, cost: 0.2, contextTokens: 20_000 },
	],
});

const thread = (over: Parameters<typeof summary>[0] = {}) =>
	summary({ id: "aaaaaak3x9fa", name: "Fix login redirect", title: "Fix the login redirect loop", turns: 3, lastActivityAt: "2026-10-19T09:00:00Z", metrics: used, ...over });

describe("cloudJobId", () => {
	test("the name's words in CamelCase, letters and digits only", () => {
		expect(cloudJobId({ id: "aaaaaak3x9fa", name: "Pane zoom shortcut" })).toBe("PaneZoomShortcut");
		expect(cloudJobId({ id: "x", name: "fix: the login-redirect (v2)!" })).toBe("FixTheLoginRedirectV2");
		// Words keep their inner capitals.
		expect(cloudJobId({ id: "x", name: "PluginNaming slice" })).toBe("PluginNamingSlice");
		expect(cloudJobId({ id: "x", name: "über cool" })).toBe("ÜberCool");
	});

	test("at most 32 characters, cut at a word", () => {
		const id = cloudJobId({ id: "x", name: "refactor the authentication middleware for every service" });
		expect(id).toBe("RefactorTheAuthentication");
		expect(id.length).toBeLessThanOrEqual(32);
		// A first word longer than the limit is cut inside it.
		expect(cloudJobId({ id: "x", name: "a".repeat(50) })).toBe(`A${"a".repeat(31)}`);
		expect(cloudJobId({ id: "x", name: `${"a".repeat(31)} b` })).toHaveLength(32);
	});

	test("trailing stop words are dropped after the cut, never the whole id", () => {
		expect(cloudJobId({ id: "x", name: "Rebuild the dashboard client on the vendored omp-stats kit" })).toBe("RebuildTheDashboardClient");
		// Without a cut too, and several in a row; a stop word inside stays.
		expect(cloudJobId({ id: "x", name: "Add support for the" })).toBe("AddSupport");
		expect(cloudJobId({ id: "x", name: "Fix the login" })).toBe("FixTheLogin");
		// A name of stop words alone keeps its first word.
		expect(cloudJobId({ id: "x", name: "of the" })).toBe("Of");
	});

	test("a thread without a name takes its title's words under the same rules", () => {
		expect(cloudJobId({ id: "aaaaaak3x9fa", name: "", title: "Add Greet" })).toBe("AddGreet");
		expect(cloudJobId({ id: "aaaaaak3x9fa", name: "  -- !! ", title: "fix the login redirect loop on the router and more" })).toBe("FixTheLoginRedirectLoop");
		// A name wins over the title.
		expect(cloudJobId({ id: "x", name: "Pane zoom", title: "Something else" })).toBe("PaneZoom");
	});

	test("Cloud and the short id only when neither the name nor the title has a letter or digit", () => {
		expect(cloudJobId({ id: "aaaaaak3x9fa", name: "" })).toBe("Cloudk3x9fa");
		expect(cloudJobId({ id: "aaaaaak3x9fa", name: "  -- !! ", title: "…" })).toBe("Cloudk3x9fa");
	});
});

describe("cloudJobStage", () => {
	test("waiting says what the agent asks", () => {
		expect(cloudJobStage(thread({ phase: "waiting", question: pending({ text: "Which database?" }) }))).toBe("? Which database?");
		expect(cloudJobStage(thread({ phase: "waiting" }))).toBe("waiting for an answer");
	});

	test("a running turn shows its tool as » text, its assistant text as it is, else its phase", () => {
		const at = "2026-10-19T09:59:00Z";
		expect(cloudJobStage(thread({ phase: "working", activity: { kind: "tool", text: "bash: bun test", at } }))).toBe("» bash: bun test");
		expect(cloudJobStage(thread({ phase: "working", activity: { kind: "assistant", text: "Reading   the\nrouter", at } }))).toBe("Reading the router");
		expect(cloudJobStage(thread({ phase: "working" }))).toBe("working");
		expect(cloudJobStage(thread({ phase: "starting" }))).toBe("starting");
		expect(cloudJobStage(thread({ phase: "starting", activity: { kind: "assistant", text: "", at } }))).toBe("starting");
	});

	test("idle shows the latest turn's title, failed the error", () => {
		const latest = { id: 3, state: "done" as const, title: "Fixed the loop", reply: "", error: "", completedAt: "" };
		expect(cloudJobStage(thread({ phase: "idle", latest }))).toBe("Fixed the loop");
		// Before any turn the task title stands in.
		expect(cloudJobStage(thread({ phase: "idle" }))).toBe("Fix the login redirect loop");
		expect(cloudJobStage(thread({ phase: "failed", error: "vm lost" }))).toBe("vm lost");
		expect(cloudJobStage(thread({ phase: "failed", latest: { ...latest, state: "failed", error: "stopped by owner" } }))).toBe("stopped by owner");
		expect(cloudJobStage(thread({ phase: "failed" }))).toBe("failed");
	});

	test("an archived idle thread says so and how to restore it; one that is restoring reads as running", () => {
		const archivedAt = new Date(2026, 9, 8, 12).toISOString();
		expect(cloudJobStage(thread({ archivedAt }))).toBe("archived Oct 8 · the next message restores it");
		expect(cloudJobStage(thread({ archivedAt, phase: "starting" }))).toBe("starting");
	});

	test("a long stage is cut to one line", () => {
		const stage = cloudJobStage(thread({ phase: "waiting", question: pending({ text: `${"word ".repeat(100)}\nmore` }) }));
		expect(stage).not.toContain("\n");
		expect(stage.length).toBeLessThanOrEqual(202);
	});
});

describe("cloudJobWidget", () => {
	test("none when the service sent no metrics", () => {
		expect(cloudJobWidget(thread({ metrics: null }), NOW)).toBeUndefined();
	});

	test("with a window: the context percent as the headline with its move, a spark, a meter and the stats", () => {
		const w = cloudJobWidget(thread(), NOW);
		expect(w).toEqual({
			title: "Fix login redirect",
			headline: { text: "10%", label: "context", trend: { text: "▲ 5K", tone: "muted" } },
			stage: "Fix the login redirect loop",
			blocks: [
				{ kind: "spark", label: "context", values: [8_000, 15_000, 20_000], min: 0, max: 200_000, last: "20K", tips: ["turn 1 · 8K", "turn 2 · 15K", "turn 3 · 20K"] },
				{ kind: "meter", label: "context", value: 0.1, text: "20K / 200K" },
				{
					kind: "stat",
					items: [
						{ label: "cost", text: "$0.42" },
						{ label: "tokens", text: "19K" },
						{ label: "requests", text: "7" },
						{ label: "tools", text: "19" },
						{ label: "turns", text: "3" },
						{ label: "id", text: "k3x9fa" },
					],
				},
			],
			state: "live",
			updatedAt: Date.parse("2026-10-19T09:50:00Z"),
		});
	});

	test("tokens count input, output and cache writes, never cache reads", () => {
		const w = cloudJobWidget(thread({ metrics: metrics({ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900_000, cacheWriteTokens: 30, cost: 0 } }) }), NOW);
		const stat = w?.blocks.find(b => b.kind === "stat");
		expect(stat?.kind === "stat" && stat.items.find(i => i.label === "tokens")?.text).toBe("150");
		expect(stat?.kind === "stat" && stat.items.find(i => i.label === "cost")?.text).toBe("$0");
	});

	test("the meter turns warning and error with omp's context thresholds", () => {
		const at = (tokens: number, window: number) => cloudJobWidget(thread({ metrics: { ...used, context: { tokens, window, at: "" } } }), NOW)?.blocks.find(b => b.kind === "meter");
		expect(at(100_000, 200_000)).toMatchObject({ tone: "warning" });
		expect(at(190_000, 200_000)).toMatchObject({ tone: "error" });
		// A large window reaches the token levels first.
		expect(at(160_000, 1_000_000)).toMatchObject({ tone: "warning" });
		expect(at(10_000, 200_000)).not.toHaveProperty("tone");
	});

	test("without a window: tokens as the headline, no meter, the spark spans its own values", () => {
		const w = cloudJobWidget(thread({ metrics: { ...used, context: { tokens: 20_000, window: 0, at: "" } } }), NOW);
		expect(w?.headline).toEqual({ text: "20K", label: "context", trend: { text: "▲ 5K", tone: "muted" } });
		expect(w?.blocks.map(b => b.kind)).toEqual(["spark", "stat"]);
		const spark = w?.blocks[0];
		expect(spark?.kind === "spark" && [spark.min, spark.max]).toEqual([0, 20_000]);
	});

	test("a spark needs two turns; a falling context has a ▼ trend; no change has none", () => {
		const one = cloudJobWidget(thread({ metrics: { ...used, turns: [{ n: 1, cost: 0.1, contextTokens: 8_000 }] } }), NOW);
		expect(one?.blocks.map(b => b.kind)).toEqual(["meter", "stat"]);
		expect(one?.headline?.trend).toBeUndefined();
		const falling = cloudJobWidget(thread({ metrics: { ...used, turns: [{ n: 1, cost: 0, contextTokens: 30_000 }, { n: 2, cost: 0, contextTokens: 12_000 }] } }), NOW);
		expect(falling?.headline?.trend).toEqual({ text: "▼ 18K", tone: "muted" });
		// A turn that reported no context is not a point.
		const gap = cloudJobWidget(thread({ metrics: { ...used, turns: [{ n: 1, cost: 0, contextTokens: 8_000 }, { n: 2, cost: 0, contextTokens: null }] } }), NOW);
		expect(gap?.blocks.map(b => b.kind)).toEqual(["meter", "stat"]);
	});

	test("no context reported yet: no headline and no meter, but the stats stay", () => {
		const w = cloudJobWidget(thread({ metrics: metrics({ requests: 1 }) }), NOW);
		expect(w?.headline).toBeUndefined();
		expect(w?.blocks.map(b => b.kind)).toEqual(["stat"]);
		const stat = w?.blocks[0];
		expect(stat?.kind === "stat" && stat.items.map(i => i.label)).toEqual(["cost", "requests", "id"]);
	});

	test("the title is the name, else the title; an archived thread's stage is the archive note", () => {
		expect(cloudJobWidget(thread({ name: "" }), NOW)?.title).toBe("Fix the login redirect loop");
		expect(cloudJobWidget(thread({ archivedAt: "2026-10-18T10:00:00Z" }), NOW)?.stage).toStartWith("archived ");
	});

	test("updatedAt falls back to the last activity, then to now", () => {
		expect(cloudJobWidget(thread({ metrics: metrics() }), NOW)?.updatedAt).toBe(Date.parse("2026-10-19T09:00:00Z"));
		expect(cloudJobWidget(thread({ metrics: metrics(), lastActivityAt: "" }), NOW)?.updatedAt).toBe(NOW);
	});
});

describe("cloudJobTile", () => {
	test("a running thread is a live running task with a clock from its last activity", () => {
		const tile = cloudJobTile(thread({ phase: "working", lastActivityAt: "2026-10-19T09:58:00Z", activity: { kind: "tool", text: "bash: ls", at: "" } }), NOW);
		expect(tile).toMatchObject({ id: "FixLoginRedirect", type: "task", status: "running", live: true, label: "Fix login redirect", durationMs: 120_000, stage: "» bash: ls" });
		expect(tile.widget?.stage).toBe("» bash: ls");
		for (const phase of ["starting", "waiting"] as const) expect(cloudJobTile(thread({ phase }), NOW)).toMatchObject({ status: "running", live: true });
	});

	test("an idle thread is completed and frozen at the time it worked; a failed one failed", () => {
		expect(cloudJobTile(thread(), NOW)).toMatchObject({ status: "completed", live: false, durationMs: 252_000 });
		expect(cloudJobTile(thread({ phase: "failed", error: "boom" }), NOW)).toMatchObject({ status: "failed", live: false, stage: "boom", durationMs: 252_000 });
	});

	test("an archived thread is completed and its stage reads archived", () => {
		const tile = cloudJobTile(thread({ archivedAt: "2026-10-18T10:00:00Z" }), NOW);
		expect(tile.status).toBe("completed");
		expect(tile.stage).toStartWith("archived ");
	});

	test("an idle thread whose latest turn failed is a failed tile with the error as its stage; a cancelled one is cancelled", () => {
		const latest = { id: 3, state: "failed" as const, title: "", reply: "", error: "spend cap reached", completedAt: "" };
		expect(cloudJobStage(thread({ phase: "idle", latest }))).toBe("spend cap reached");
		expect(cloudJobTile(thread({ phase: "idle", latest }), NOW)).toMatchObject({ status: "failed", live: false, stage: "spend cap reached", durationMs: 252_000 });
		// Without the turn's own error the thread's stands in, then a bare word.
		expect(cloudJobStage(thread({ phase: "idle", error: "vm lost", latest: { ...latest, error: "" } }))).toBe("vm lost");
		expect(cloudJobStage(thread({ phase: "idle", latest: { ...latest, error: "" } }))).toBe("failed");
		const cancelled = cloudJobTile(thread({ phase: "idle", latest: { ...latest, state: "cancelled", error: "" } }), NOW);
		expect(cancelled).toMatchObject({ status: "cancelled", stage: "cancelled" });
		// A done latest turn is a completed tile; a failed one that is archived keeps the archive note as its stage.
		expect(cloudJobTile(thread({ phase: "idle", latest: { ...latest, state: "done", error: "" } }), NOW).status).toBe("completed");
		const parked = cloudJobTile(thread({ phase: "idle", latest, archivedAt: "2026-10-18T10:00:00Z" }), NOW);
		expect(parked.status).toBe("failed");
		expect(parked.stage).toStartWith("archived ");
	});

	test("without a name the id comes from the title and the label is the title; without metrics there is no widget or clock", () => {
		const tile = cloudJobTile(thread({ name: "", metrics: null }), NOW);
		expect(tile).toMatchObject({ id: "FixTheLoginRedirectLoop", label: "Fix the login redirect loop", stage: "Fix the login redirect loop" });
		expect(tile.widget).toBeUndefined();
		expect(tile.durationMs).toBeUndefined();
	});
});

describe("cloudJobLiveWidget", () => {
	const at = (hhmmss: string) => `2026-10-19T${hhmmss}Z`;
	const turns = [
		turn(1, { state: "done", startedAt: at("09:50:00"), completedAt: at("09:51:12") }),
		turn(2, { state: "failed", startedAt: at("09:52:00"), completedAt: at("09:52:30") }),
		turn(3, { state: "running", startedAt: at("09:58:00"), completedAt: "" }),
		turn(4, { state: "queued", startedAt: "", completedAt: "" }),
	];
	const live = (over: Parameters<typeof thread>[0] = {}, list = turns) => ({ ...thread({ phase: "working", ...over }), turns: list });
	const kinds = (w: JobWidgetView) => w.blocks.map(b => b.kind);

	test("a running turn: the turns as dots first, their durations, the context meter and spark, the stats, the headline and the stage", () => {
		const w = cloudJobLiveWidget(live({ activity: { kind: "tool", text: "bash: bun test", at: "" } }), NOW);
		expect(kinds(w)).toEqual(["grid", "bars", "meter", "spark", "stat"]);
		expect(w.blocks[0]).toEqual({
			kind: "grid",
			label: "turns",
			items: [
				{ label: "1", text: "turn 1 done · 1m12s", tone: "success" },
				{ label: "2", text: "turn 2 failed · 30s", tone: "error" },
				{ label: "3", text: "turn 3 running · 2m00s", tone: "pending" },
				{ label: "4", text: "turn 4 queued", tone: "muted" },
			],
		});
		// The running turn is charted up to now; the queued one has no time yet; a failed one is red.
		expect(w.blocks[1]).toEqual({
			kind: "bars",
			label: "turn time",
			items: [
				{ label: "turn 1", value: 72_000, text: "1m12s" },
				{ label: "turn 2", value: 30_000, text: "30s", tone: "error" },
				{ label: "turn 3", value: 120_000, text: "2m00s" },
			],
			max: 120_000,
		});
		expect(w.blocks[2]).toMatchObject({ kind: "meter", label: "context", value: 0.1, text: "20K / 200K" });
		expect(w.blocks[4]).toMatchObject({ kind: "stat" });
		expect(w).toMatchObject({ title: "Fix login redirect", stage: "» bash: bun test", state: "live", updatedAt: NOW, headline: { text: "10%", label: "context" } });
	});

	test("the meter takes omp's warning and error tones", () => {
		const meter = (tokens: number) => cloudJobLiveWidget(live({ metrics: { ...used, context: { tokens, window: 200_000, at: "" } } }), NOW).blocks.find(b => b.kind === "meter");
		expect(meter(100_000)).toMatchObject({ tone: "warning" });
		expect(meter(190_000)).toMatchObject({ tone: "error" });
		expect(meter(20_000)).not.toHaveProperty("tone");
	});

	test("a thread waiting for an answer has the question as its stage", () => {
		const w = cloudJobLiveWidget(live({ phase: "waiting", question: pending({ text: "Which database?" }) }), NOW);
		expect(w.stage).toBe("? Which database?");
		expect(w.blocks[0]).toMatchObject({ kind: "grid" });
	});

	test("a done turn: every dot green, the stage the caller gives", () => {
		const done = [turn(1, { state: "done", startedAt: at("09:50:00"), completedAt: at("09:51:00") }), turn(2, { state: "done", startedAt: at("09:55:00"), completedAt: at("09:56:00") })];
		const w = cloudJobLiveWidget(live({ phase: "idle" }, done), NOW, "Greeting fixed");
		expect(w.stage).toBe("Greeting fixed");
		const grid = w.blocks[0];
		expect(grid?.kind === "grid" && grid.items.map(i => i.tone)).toEqual(["success", "success"]);
		const bars = w.blocks[1];
		expect(bars?.kind === "bars" && bars.items.map(i => i.tone)).toEqual([undefined, undefined]);
	});

	test("a failed or stopped turn: a red or amber dot and bar, the error as the stage", () => {
		const ended = [turn(1, { state: "done", startedAt: at("09:50:00"), completedAt: at("09:51:00") }), turn(2, { state: "cancelled", startedAt: at("09:55:00"), completedAt: at("09:55:10") }), turn(3, { state: "failed", startedAt: at("09:56:00"), completedAt: at("09:57:00") })];
		const w = cloudJobLiveWidget(live({ phase: "idle" }, ended), NOW, "spend cap reached");
		expect(w.stage).toBe("spend cap reached");
		const grid = w.blocks[0];
		expect(grid?.kind === "grid" && grid.items.map(i => i.tone)).toEqual(["success", "warning", "error"]);
		const bars = w.blocks[1];
		expect(bars?.kind === "bars" && bars.items.map(i => i.tone)).toEqual([undefined, "warning", "error"]);
	});

	test("without metrics: the dots and durations, no headline, meter or stats", () => {
		const w = cloudJobLiveWidget(live({ metrics: null }), NOW);
		expect(kinds(w)).toEqual(["grid", "bars"]);
		expect(w.headline).toBeUndefined();
		expect(w.state).toBe("live");
		expect(w.title).toBe("Fix login redirect");
	});

	test("only the newest turns are drawn", () => {
		const many = Array.from({ length: 30 }, (_, i) => turn(i + 1, { startedAt: at("09:00:00"), completedAt: at("09:00:10") }));
		const w = cloudJobLiveWidget(live({}, many), NOW);
		const grid = w.blocks[0];
		const bars = w.blocks[1];
		expect(grid?.kind === "grid" && [grid.items.length, grid.items[0]?.label, grid.items.at(-1)?.label]).toEqual([24, "7", "30"]);
		expect(bars?.kind === "bars" && [bars.items.length, bars.items[0]?.label]).toEqual([12, "turn 19"]);
	});

	test("a turn whose times are unreadable has a dot and no bar", () => {
		const w = cloudJobLiveWidget(live({}, [turn(1, { startedAt: "soon", completedAt: "" , state: "done" })]), NOW);
		expect(kinds(w)).toEqual(["grid", "meter", "spark", "stat"]);
	});
});

describe("toolLabel and toolCall: a tool event as omp's own lines name the call", () => {
	test("the arguments' preview, picked as omp's task progress picks it", () => {
		expect(toolLabel('bash {"command":"for i in 1 2 3; do echo $i; done"}')).toBe("bash: for i in 1 2 3; do echo $i; done");
		expect(toolLabel('read {"path":"src/a.ts","offset":1}')).toBe("read: src/a.ts");
		expect(toolLabel('grep {"pattern":"TODO","path":"src"}')).toBe("grep: src");
		expect(toolLabel('web_search {"query":"bun test timeout"}')).toBe("web_search: bun test timeout");
		expect(toolCall('bash {"command":"ls"}')).toEqual({ tool: "bash", args: "ls", argsKey: "command" });
	});

	test("an edit names its files", () => {
		expect(toolLabel('edit {"path":"a.ts","edits":[{"path":"b.ts","op":"x"},{"path":"a.ts"}]}')).toBe("edit: a.ts, b.ts");
	});

	test("an intent stands as it is, and a call with neither is the bare tool", () => {
		expect(toolLabel("bash run the tests")).toBe("bash: run the tests");
		expect(toolCall("bash run the tests")).toEqual({ tool: "bash", intent: "run the tests" });
		expect(toolLabel("todo")).toBe("todo");
		expect(toolLabel('todo {"ops":[{"op":"add"}]}')).toBe("todo");
		// Text that already reads `tool: detail` is not doubled.
		expect(toolLabel("bash: bun test")).toBe("bash: bun test");
	});

	test("arguments cut at 200 characters still give their string, and an escape inside it is read", () => {
		expect(toolLabel('bash {"command":"echo \\"hi\\"; sleep 1; echo some more and more and more…')).toBe('bash: echo "hi"; sleep 1; echo some more and more and more…');
		expect(toolLabel('write {"content":"cut here')).toBe("write");
	});

	test("the stage of a running thread never shows raw argument JSON", () => {
		const at = "2026-10-19T09:59:00Z";
		expect(cloudJobStage(thread({ phase: "working", activity: { kind: "tool", text: 'bash {"command":"bun test"}', at } }))).toBe("» bash: bun test");
	});

	test("the live widget takes the title the caller gives, so a tile and its panel call the job one name", () => {
		const w = cloudJobLiveWidget({ ...thread({ phase: "working" }), turns: [] }, NOW, undefined, "FixLoginRedirect");
		expect(w.title).toBe("FixLoginRedirect");
	});
});
