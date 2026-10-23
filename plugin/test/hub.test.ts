import { describe, expect, test } from "bun:test";
import { cloudErrorFromStatus } from "../src/errors";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { loadTui } from "../src/cards";
import type { FollowOptions } from "../src/events";
import { HubComponent, type HubApi, type HubDeps, type HubResult } from "../src/hub";
import { Inbox } from "../src/inbox";
import type { ThreadDetail, ThreadSummary } from "../src/types";
import { detail, event, metrics, pending, summary, turn, whoami } from "./builders";
import { Feed } from "./feed";
import { until } from "./fakes";

const NOW = Date.parse("2026-01-01T00:05:00Z");

const A = "aaaaaak3x9fa";
const B = "bbbbbbab12cd";
const C = "cccccczz99yy";

const theme: HubDeps["theme"] = { fg: (_color, text) => text, bold: text => text };

const result = { branch: "omp-cloud/a", head: "0123456789", base: "main", filesChanged: 3, insertions: 12, deletions: 3, pushed: true, pushError: "", pushRef: "omp-cloud/a", updatedAt: "" };

const threads = [
	summary({
		id: A,
		title: "title of a",
		phase: "waiting",
		turns: 2,
		latest: { id: 2, state: "done", title: "Added Greet", reply: "line one", error: "", completedAt: "" },
		result,
		lastActivityAt: "2026-01-01T00:01:00Z",
		question: pending({ turn: 2, id: 1, text: "Which database?", header: "DB", options: [{ label: "postgres", description: "prod" }, { label: "sqlite", description: "" }], recommended: 0, remaining: 2 }),
	}),
	summary({ id: B, title: "title of b", phase: "working" }),
	summary({ id: C, title: "title of c" }),
];

/** What the API returns for a thread; tests override it per id. */
function detailOf(t: ThreadSummary): ThreadDetail {
	return detail({
		id: t.id,
		phase: t.phase,
		question: t.question,
		title: t.title,
		turns: [turn(1, { reply: "first reply" }), turn(2, { title: "Added Greet", reply: "line one\nline two" })],
	});
}

interface Made {
	hub: HubComponent;
	feed: Feed;
	results: (HubResult | undefined)[];
	calls: string[];
	renders: () => number;
	inbox: Inbox;
}

async function make(list: ThreadSummary[], api: Partial<HubApi> = {}, followOptions: FollowOptions = { backoffMs: () => 1 }, pollMs?: number, inbox: Inbox = new Inbox(), serverHost?: string): Promise<Made> {
	const tui = await loadTui();
	if (!tui) throw new Error("the host pi-tui is required for the hub tests");
	const results: (HubResult | undefined)[] = [];
	const calls: string[] = [];
	const feed = new Feed();
	let renders = 0;
	const full: HubApi = {
		whoami: async () => {
			calls.push("whoami");
			return whoami({ user: "dev", modelPatterns: ["anthropic/*", "openai-codex/*"], defaultModel: "anthropic/claude-sonnet-5-5", vms: { running: 1, paused: 2 }, threads: { starting: 0, working: 1, waiting: 1, idle: 3, failed: 0 } });
		},
		listThreads: async () => {
			calls.push("list");
			return list;
		},
		thread: async id => {
			calls.push(`thread ${id}`);
			const t = list.find(x => x.id === id);
			if (!t) throw cloudErrorFromStatus(404, "no such thread");
			return detailOf(t);
		},
		events: feed.source,
		...api,
	};
	const hub = new HubComponent({ api: full, theme, tui, requestRender: () => void renders++, done: r => void results.push(r), now: () => NOW, pollMs, followOptions, inbox, serverHost });
	await hub.refresh();
	return { hub, feed, results, calls, renders: () => renders, inbox };
}

describe("HubComponent", () => {
	test("shows the cloud summary and the threads with icon, id, phase, turns, state, diff, age and title", async () => {
		const { hub } = await make(threads);
		const rows = hub.render(130);
		const text = rows.join("\n");
		expect(text).toContain("☁ omp-cloud · dev");
		expect(text).toContain("runs anthropic, openai-codex · threads run their session's model");
		expect(text).not.toContain("default anthropic");
		expect(text).toContain("VMs 1 running, 2 paused · threads 1 working, 1 waiting, 3 idle, 0 failed");
		expect(text).toContain("Threads (3)");
		expect(rows.find(r => r.includes("k3x9fa"))).toMatch(/▸ \? k3x9fa waiting\s+t2\s+done\s+\+12\/−3\s+4m\s+title of a/);
		expect(rows.find(r => r.includes("ab12cd"))).toMatch(/ {2}● ab12cd working\s+t1\s+-/);
		expect(rows.find(r => r.includes("zz99yy"))).toMatch(/ {2}○ zz99yy idle/);
	});

	test("a cloud that runs no provider says how to add one", async () => {
		const { hub } = await make(threads, { whoami: async () => whoami({ modelPatterns: [] }) });
		expect(hub.render(130).join("\n")).toContain("no providers (/cloud login <provider>)");
	});

	test("on a threads-only device a cloud with no provider points at the server, not at /cloud login; a device with full access names /cloud login", async () => {
		const threadsOnly = whoami({ modelPatterns: [], device: { id: "d1", name: "laptop", access: "threads" } });
		const { hub } = await make(threads, { whoami: async () => threadsOnly }, undefined, undefined, undefined, "10.0.20.24");
		const text = hub.render(300).join("\n");
		expect(text).toContain("no providers (log the server in: run omp-cloud login <provider> on 10.0.20.24");
		expect(text).not.toContain("/cloud login");

		const full = whoami({ modelPatterns: [], device: { id: "d1", name: "laptop", access: "full" } });
		const { hub: owner } = await make(threads, { whoami: async () => full }, undefined, undefined, undefined, "10.0.20.24");
		expect(owner.render(300).join("\n")).toContain("no providers (/cloud login <provider>)");
	});

	describe("an update of the service", () => {
		const ready = (over: Parameters<typeof whoami>[0] = {}) => whoami({ user: "dev", update: { state: "ready", available: "0.5.1", mode: "notify" }, ...over });

		test("the owner sees `update <v> ready (u: restart to update)` in the header and the key in the hints; u closes the hub with the update action", async () => {
			const { hub, results } = await make(threads, { whoami: async () => ready() });
			const rows = hub.render(130);
			expect(rows[0]).toBe("☁ omp-cloud · dev · update 0.5.1 ready (u: restart to update)");
			expect(rows.join("\n")).toContain("d delete · u update · q close");
			hub.handleInput("u");
			expect(results).toEqual([{ action: "update", thread: "", label: "" }]);
		});

		test("u works with no threads at all", async () => {
			const { hub, results } = await make([], { whoami: async () => ready() });
			hub.handleInput("u");
			expect(results).toEqual([{ action: "update", thread: "", label: "" }]);
		});

		test("a device sees nothing and u does nothing: only the owner installs", async () => {
			const { hub, results } = await make(threads, { whoami: async () => ready({ device: { id: "d1", name: "laptop", access: "threads" } }) });
			const text = hub.render(130).join("\n");
			expect(text).not.toContain("update 0.5.1");
			expect(text).not.toContain("u update");
			hub.handleInput("u");
			expect(results).toEqual([]);
		});

		test("a device with full access is the owner here: it sees the update and u installs it", async () => {
			const { hub, results } = await make(threads, { whoami: async () => ready({ device: { id: "d1", name: "laptop", access: "full" } }) });
			expect(hub.render(130)[0]).toBe("☁ omp-cloud · dev · update 0.5.1 ready (u: restart to update)");
			hub.handleInput("u");
			expect(results).toEqual([{ action: "update", thread: "", label: "" }]);
		});

		test("an update that is only downloading, or a service that reports none, shows nothing and u does nothing", async () => {
			for (const update of [{ state: "downloading" as const, available: "0.5.1", mode: "notify" as const }, { state: "idle" as const, available: null, mode: "notify" as const }, null]) {
				const { hub, results } = await make(threads, { whoami: async () => whoami({ user: "dev", update }) });
				expect(hub.render(130)[0]).toBe("☁ omp-cloud · dev");
				hub.handleInput("u");
				expect(results).toEqual([]);
			}
		});
	});

	test("shows the selected thread's pending question with its options and its latest reply", async () => {
		const { hub } = await make(threads);
		const text = hub.render(130).join("\n");
		expect(text).toContain(`${A} · waiting · 2 turns · anthropic/claude-sonnet-5-5 · omp 18.12.3`);
		expect(text).toContain("? DB: Which database? (+1 more)");
		expect(text).toContain("(•) postgres  ← recommended — prod");
		expect(text).toContain("(•) sqlite");
		expect(text).toContain("Latest — turn 2 done: Added Greet");
		expect(text).toContain("  line one");
		expect(text).toContain("  line two");
		expect(text).toContain("s send · a answer · o open · x stop · p pull · r resume · d delete · q close");
	});

	test("a failed thread shows its error", async () => {
		const failed = summary({ id: A, phase: "failed", error: "vm failed to boot" });
		const { hub } = await make([failed], { thread: async () => detail({ id: A, phase: "failed", error: "vm failed to boot", turns: [] }) });
		expect(hub.render(130).join("\n")).toContain("! vm failed to boot");
	});

	test("moving the selection loads the new thread's detail and clamps at both ends", async () => {
		const { hub, calls } = await make(threads);
		hub.handleInput("\x1b[B"); // down
		await hub.refresh();
		expect(hub.selected?.id).toBe(B);
		expect(calls).toContain(`thread ${B}`);
		expect(hub.render(130).join("\n")).toContain(`${B} · working`);
		hub.handleInput("k");
		expect(hub.selected?.id).toBe(A);
		hub.handleInput("k");
		expect(hub.selected?.id).toBe(A);
	});

	test("each action key closes the hub with the action and the selected thread", async () => {
		const keys: [string, HubResult["action"]][] = [
			["s", "send"],
			["a", "answer"],
			["x", "stop"],
			["p", "pull"],
			["r", "resume"],
			["d", "delete"],
			["o", "open"],
		];
		for (const [key, action] of keys) {
			const { hub, results } = await make(threads);
			hub.handleInput("j");
			hub.handleInput(key);
			expect(results).toEqual([{ action, thread: B, label: `title of b · ${B}` }]);
		}
	});

	test("the header counts unread entries and rows carry them; opening a thread's detail marks its entries read", async () => {
		const inbox = new Inbox();
		const at = Date.parse("2026-01-01T00:04:00Z");
		inbox.add({ thread: A, turn: 2, kind: "result", label: "title of a", line: "line one", at });
		inbox.add({ thread: B, turn: 1, kind: "failure", label: "title of b", line: "boom", at });
		inbox.add({ thread: B, turn: 2, kind: "question", label: "title of b", line: "Which?", at });
		// The first thread's detail is on screen from the start: its entry is read at once.
		const { hub } = await make(threads, {}, undefined, undefined, inbox);
		expect(inbox.unreadFor(A)).toBe(0);
		expect(inbox.unread).toBe(2);
		const rows = hub.render(130);
		expect(rows[0]).toBe("☁ omp-cloud · dev · 2 unread");
		expect(rows.find(r => r.includes("ab12cd"))).toContain("[2 new] title of b");
		expect(rows.find(r => r.includes("k3x9fa"))).not.toContain("new]");

		hub.handleInput("j");
		await hub.refresh();
		expect(inbox.unread).toBe(0);
		expect(hub.render(130)[0]).toBe("☁ omp-cloud · dev");
		expect(hub.render(130).join("\n")).not.toContain("new]");
	});

	test("a change to the inbox is heard by its listeners: reading tells the status line", () => {
		const inbox = new Inbox();
		let heard = 0;
		inbox.onChange(() => void heard++);
		inbox.add({ thread: A, turn: 1, kind: "result", label: "x", line: "y", at: 0 });
		inbox.read(A);
		inbox.read(A);
		expect(heard).toBe(2);
	});

	test("entries of a thread the service no longer lists are dropped when the hub loads", async () => {
		const inbox = new Inbox();
		inbox.add({ thread: "gone-thread", turn: 1, kind: "result", label: "x", line: "y", at: 0 });
		inbox.add({ thread: B, turn: 1, kind: "result", label: "x", line: "y", at: 0 });
		await make(threads, {}, undefined, undefined, inbox);
		expect(inbox.entries.map(e => e.thread)).toEqual([B]);
	});

	test("a named thread leads its row and its detail with the name, keeps the title beneath, and the result's label is name and id", async () => {
		const named = [summary({ id: A, name: "Fix greeting bug", title: "title of a", phase: "working" })];
		const { hub, results } = await make(named, { thread: async () => detail({ id: A, name: "Fix greeting bug", title: "title of a", phase: "working", turns: [], metrics: metrics({ requests: 3, tools: 5, context: { tokens: 1500, window: 0, at: "x" } }) }) });
		const rows = hub.render(130);
		expect(rows.find(r => r.includes("k3x9fa"))).toMatch(/k3x9fa working\s+t1\s+-.*Fix greeting bug$/);
		const text = rows.join("\n");
		expect(text).toContain(`Fix greeting bug · ${A} · working`);
		expect(text).toContain("title of a");
		expect(text).toContain("context 1.5K · 3 requests · 5 tool calls");
		hub.handleInput("s");
		expect(results).toEqual([{ action: "send", thread: A, label: `Fix greeting bug · ${A}` }]);
	});

	test("an archived thread reads archived in the list and in its detail", async () => {
		const archived = [summary({ id: A, title: "title of a", phase: "idle", archivedAt: "2026-02-01T00:00:00Z" })];
		const { hub } = await make(archived, { thread: async () => detail({ id: A, title: "title of a", phase: "idle", archivedAt: "2026-02-01T00:00:00Z", turns: [] }) });
		const rows = hub.render(130);
		expect(rows.find(r => r.includes("k3x9fa"))).toMatch(/k3x9fa archived/);
		expect(rows.join("\n")).toContain(`${A} · archived`);
	});

	test("q, escape and ctrl+c close without an action", async () => {
		for (const key of ["q", "\x1b", "\x03"]) {
			const { hub, results } = await make(threads);
			hub.handleInput(key);
			expect(results).toEqual([undefined]);
		}
	});

	test("with no threads the action keys do nothing and the hub says how to start", async () => {
		const { hub, results, feed } = await make([]);
		hub.handleInput("s");
		hub.handleInput("d");
		expect(results).toEqual([]);
		expect(feed.connections).toEqual([]);
		expect(hub.render(100).join("\n")).toContain("no threads — hand off work with /cloud <task>");
	});

	test("an API failure is shown in the hub rather than thrown", async () => {
		const { hub } = await make(threads, {
			listThreads: async () => {
				throw new Error("connection refused");
			},
		});
		expect(hub.render(100).join("\n")).toContain("! connection refused");
	});

	test("every row fits the width, however long the title", async () => {
		const { hub } = await make([summary({ id: A, title: "x".repeat(300) })]);
		const tui = await loadTui();
		for (const w of [40, 80]) {
			for (const row of hub.render(w)) expect(tui?.truncateToWidth(row, w)).toBe(row);
		}
	});
});

describe("HubComponent following the selected thread", () => {
	test("follows the selected thread's event stream and shows its live events", async () => {
		const { hub, feed, renders } = await make(threads);
		expect(feed.connections.map(c => c.id)).toEqual([A]);
		expect(feed.connections[0]?.opts.after).toBeUndefined();
		expect(hub.render(130).join("\n")).not.toContain("Live");

		const before = renders();
		feed.push(A, event(1, { kind: "tool", text: "read: a.go" }));
		await until(() => hub.render(130).join("\n").includes("  read: a.go"));
		expect(hub.render(130).join("\n")).toContain("Live");
		expect(renders()).toBeGreaterThan(before);
	});

	test("a plain event only re-renders; a lifecycle event refetches the list and the thread", async () => {
		const { hub, feed, calls } = await make(threads);
		const base = calls.length;
		feed.push(A, event(1, { kind: "assistant", text: "thinking" }));
		await until(() => hub.render(130).join("\n").includes("assistant: thinking"));
		expect(calls.slice(base)).toEqual([]);

		feed.push(A, event(2, { kind: "turn_done", text: "turn 2 done" }));
		await until(() => calls.includes("list") && calls.slice(base).includes(`thread ${A}`));
		expect(calls.slice(base)).toEqual(["list", `thread ${A}`]);
	});

	test("a lifecycle event brings in the thread's new state", async () => {
		let phase: ThreadSummary["phase"] = "working";
		let reply = "";
		const { hub, feed } = await make([summary({ id: A, phase: "working" })], {
			listThreads: async () => [summary({ id: A, phase })],
			thread: async () => detail({ id: A, phase, turns: [turn(1, { state: phase === "working" ? "running" : "done", reply })] }),
		});
		expect(hub.render(130).join("\n")).not.toContain("Latest");
		phase = "idle";
		reply = "all green";
		feed.push(A, event(1, { kind: "turn_done" }));
		await until(() => hub.render(130).join("\n").includes("  all green"));
		expect(hub.render(130).join("\n")).toContain(`${A} · idle`);
	});

	test("moving the selection stops the previous stream and follows the new one", async () => {
		const { hub, feed } = await make(threads);
		const first = feed.open(A);
		feed.push(A, event(1, { kind: "tool", text: "bash: from a" }));
		await until(() => hub.render(130).join("\n").includes("  bash: from a"));

		hub.handleInput("j");
		expect(first?.aborted).toBe(true);
		await hub.refresh();
		expect(feed.of(B)).toHaveLength(1);
		const text = hub.render(130).join("\n");
		expect(text).not.toContain("from a");
		expect(hub.selected?.id).toBe(B);

		feed.push(B, event(1, { kind: "tool", text: "bash: from b" }));
		await until(() => hub.render(130).join("\n").includes("  bash: from b"));
		expect(feed.open(A)).toBeUndefined();
	});

	test("refreshing keeps following the same thread over one connection", async () => {
		const { hub, feed } = await make(threads);
		await hub.refresh();
		await hub.refresh();
		expect(feed.of(A)).toHaveLength(1);
		expect(feed.open(A)).toBeDefined();
	});

	test("a dropped stream resumes with the last seq handled and the live lines stay", async () => {
		const { hub, feed } = await make(threads);
		feed.push(A, event(1, { kind: "tool", text: "bash: one" }), event(2, { kind: "tool", text: "bash: two" }));
		await until(() => hub.render(130).join("\n").includes("  bash: two"));
		feed.fail(A, new Error("reset"));
		await until(() => feed.of(A).length === 2);
		expect(feed.of(A)[1]?.opts.lastEventId).toBe(2);
		expect(feed.of(A)[1]?.opts.after).toBeUndefined();
		// the server replays what the hub already has: it shows once
		feed.push(A, event(2, { kind: "tool", text: "bash: two" }), event(3, { kind: "tool", text: "bash: three" }));
		await until(() => hub.render(130).join("\n").includes("  bash: three"));
		expect(hub.render(130).filter(l => l.includes("  bash: two"))).toHaveLength(1);
	});

	test("a tool call's events and the usage of its request show as one line, not as raw JSON", async () => {
		const { hub, feed } = await make(threads);
		feed.push(
			A,
			event(1, { kind: "tool", text: "bash: bun test" }),
			event(2, { kind: "tool_start", text: JSON.stringify({ id: "c1", tool: "bash", intent: "bun test" }) }),
			event(3, { kind: "usage", text: JSON.stringify({ input: 5 }) }),
			event(4, { kind: "tool_end", text: JSON.stringify({ id: "c1", tool: "bash", ok: true, ms: 1200 }) }),
		);
		await until(() => hub.render(130).join("\n").includes("✓"));
		const live = hub.render(130).filter(l => l.startsWith("  bash: "));
		expect(live).toEqual(["  bash: bun test · ✓ · 1s"]);
		expect(hub.render(130).join("\n")).not.toContain("usage");
	});

	test("a stream the follower gives up on shows its error in the hub", async () => {
		const { hub, feed } = await make(threads);
		feed.fail(A, cloudErrorFromStatus(404, "no such thread"));
		await until(() => hub.render(130).join("\n").includes("! no such thread"));
		expect(feed.of(A)).toHaveLength(1);
	});

	test("dispose stops the stream; refresh after it does nothing", async () => {
		const { hub, feed, calls } = await make(threads);
		const conn = feed.open(A);
		hub.dispose();
		expect(conn?.aborted).toBe(true);
		const n = calls.length;
		await hub.refresh();
		expect(calls).toHaveLength(n);
		expect(feed.of(A)).toHaveLength(1);
	});
});

describe("HubComponent polling the list", () => {
	test("start() polls every pollMs until dispose", async () => {
		let lists = 0;
		const { hub } = await make(threads, { listThreads: async () => (lists++, threads) }, { backoffMs: () => 1 }, 10);
		const loaded = lists;
		hub.start();
		await until(() => lists >= loaded + 3);
		hub.dispose();
		const stopped = lists;
		await hub.refresh();
		expect(lists).toBe(stopped);
	});

	test("the cloud summary is refetched every fifth refresh, the list every time", async () => {
		const { hub, calls } = await make(threads);
		for (let n = 0; n < 5; n++) await hub.refresh();
		expect(calls.filter(c => c === "whoami")).toHaveLength(2);
		expect(calls.filter(c => c === "list")).toHaveLength(6);
	});

	test("a deleted selected thread moves the selection and the stream to the next one", async () => {
		let list = threads;
		const { hub, feed } = await make(threads, { listThreads: async () => list });
		const first = feed.open(A);
		list = threads.filter(t => t.id !== A);
		await hub.refresh();
		expect(first?.aborted).toBe(true);
		expect(hub.selected?.id).toBe(B);
		expect(feed.of(B)).toHaveLength(1);
	});
});

const cx: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => false };

/** Every node of a description, the root first. */
function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [];
	const visit = (n: NativeNode): void => {
		out.push(n);
		for (const c of n.c ?? []) if ("k" in c) visit(c);
	};
	visit(root);
	return out;
}

const roles = (root: NativeNode): string[] => nodes(root).flatMap(n => (typeof n.p?.role === "string" ? [n.p.role] : []));

/** The click act of every button in the description. */
const buttons = (root: NativeNode): string[] => nodes(root).flatMap(n => (n.p?.role === "omp.btn" && typeof n.p.actions?.click === "string" ? [n.p.actions.click] : []));

const action = (act: string): NativeUiEvent => ({ type: "action", key: "actions/" + act, act, mods: [] });

describe("HubComponent as native nodes", () => {
	test("describes as a frame of its own with no rows node anywhere", async () => {
		const { hub } = await make(threads);
		const root = hub.describe(cx);
		expect(root.p?.role).toBe("omp.cloud.hub");
		expect(nodes(root).filter(n => n.k === "rows")).toEqual([]);
		expect(hub.nativeOverlay).toMatchObject({ role: "omp.overlay.cloud", head: "☁ omp-cloud" });
	});

	test("the threads are the items of a selectable list, in the tone of their state, with the selected one marked", async () => {
		const { hub } = await make(threads);
		const all = nodes(hub.describe(cx));
		const list = all.find(n => n.k === "list");
		expect(list?.p).toMatchObject({ selected: A, actions: { click: "select", dblclick: "activate" } });
		const items = (list?.c ?? []).filter((c): c is NativeNode => "k" in c);
		expect(items.map(i => i.key)).toEqual([A, B, C]);
		expect(items.map(i => i.p?.tone)).toEqual(["warning", "pending", "neutral"]);
		expect(items.every(i => i.k === "item" && i.p?.icon === "agent")).toBe(true);
		const first = items[0]?.p as { label: { t: string }[]; value: { t: string }[] };
		expect(first.label.map(s => s.t).join("")).toBe("title of a");
		expect(first.value.map(s => s.t).join("")).toContain("question");
	});

	test("the selected thread is drawn as omp's job tile, with its question, options and latest reply", async () => {
		const { hub } = await make(threads);
		const root = hub.describe(cx);
		expect(roles(root)).toEqual(expect.arrayContaining(["omp.job.tiles", "omp.job.tile", "omp.cloud.detail", "omp.cloud.ask", "omp.cloud.latest"]));
		const text = JSON.stringify(root);
		expect(text).toContain("? DB: Which database? (+1 more)");
		expect(text).toContain("(•) postgres");
		expect(text).toContain("line one");
	});

	test("the summary of the cloud heads it: the user, the counts and the facts", async () => {
		const { hub } = await make(threads);
		const text = JSON.stringify(hub.describe(cx));
		expect(text).toContain("anthropic, openai-codex");
		expect(text).toContain("1 running · 2 paused");
		expect(text).toContain("1 working");
		expect(text).toContain("1 waiting");
	});

	test("an error and the unread count show; an unlisted cloud is said, not thrown", async () => {
		const inbox = new Inbox();
		inbox.add({ thread: B, turn: 1, kind: "failure", label: "title of b", line: "boom", at: 0 });
		const { hub } = await make(threads, { listThreads: async () => { throw new Error("connection refused"); } }, undefined, undefined, inbox);
		const text = JSON.stringify(hub.describe(cx));
		expect(text).toContain("! connection refused");
		expect(text).toContain("1 unread");
	});

	test("the buttons are the keys; with no thread only Close remains", async () => {
		const { hub } = await make(threads);
		expect(buttons(hub.describe(cx))).toEqual(["open", "send", "answer", "pull", "resume", "stop", "delete", "close"]);
		const { hub: empty } = await make([]);
		expect(buttons(empty.describe(cx))).toEqual(["close"]);
		expect(JSON.stringify(empty.describe(cx))).toContain("no threads — hand off work with /cloud <task>");
	});

	test("an owner with an update ready gets the Update button and badge; a device does not", async () => {
		const ready = whoami({ user: "dev", update: { state: "ready", available: "0.5.1", mode: "notify" } });
		const { hub } = await make(threads, { whoami: async () => ready });
		expect(buttons(hub.describe(cx))).toContain("update");
		expect(JSON.stringify(hub.describe(cx))).toContain("update 0.5.1 ready");
		const { hub: device } = await make(threads, { whoami: async () => whoami({ user: "dev", update: { state: "ready", available: "0.5.1", mode: "notify" }, device: { id: "d1", name: "laptop", access: "threads" } }) });
		expect(buttons(device.describe(cx))).not.toContain("update");
	});

	test("clicking a thread selects it and loads its detail; a double click opens it", async () => {
		const { hub, results, calls } = await make(threads);
		hub.handleNativeEvent({ type: "select", key: "threads", item: B });
		await hub.refresh();
		expect(hub.selected?.id).toBe(B);
		expect(calls).toContain(`thread ${B}`);
		expect(nodes(hub.describe(cx)).find(n => n.k === "list")?.p).toMatchObject({ selected: B });
		expect(results).toEqual([]);
		hub.handleNativeEvent({ type: "activate", key: "threads", item: C });
		expect(results).toEqual([{ action: "open", thread: C, label: `title of c · ${C}` }]);
	});

	test("an event for a thread the hub does not list is ignored", async () => {
		const { hub, results } = await make(threads);
		hub.handleNativeEvent({ type: "select", key: "threads", item: "nothere" });
		hub.handleNativeEvent({ type: "activate", key: "threads", item: "nothere" });
		expect(hub.selected?.id).toBe(A);
		expect(results).toEqual([]);
	});

	test("each button runs what its key runs, and Close is Esc", async () => {
		for (const act of ["send", "answer", "stop", "pull", "resume", "delete", "open"] as const) {
			const { hub, results } = await make(threads);
			hub.handleInput("j");
			hub.handleNativeEvent(action(act));
			expect(results).toEqual([{ action: act, thread: B, label: `title of b · ${B}` }]);
		}
		const { hub, results } = await make(threads);
		hub.handleNativeEvent(action("close"));
		expect(results).toEqual([undefined]);
	});

	test("Update runs only for an owner with one ready; an unknown act and a button with no thread do nothing", async () => {
		const ready = whoami({ user: "dev", update: { state: "ready", available: "0.5.1", mode: "notify" } });
		const { hub, results } = await make(threads, { whoami: async () => ready });
		hub.handleNativeEvent(action("update"));
		expect(results).toEqual([{ action: "update", thread: "", label: "" }]);
		const { hub: none, results: noneResults } = await make(threads);
		none.handleNativeEvent(action("update"));
		none.handleNativeEvent(action("explode"));
		const { hub: empty, results: emptyResults } = await make([]);
		empty.handleNativeEvent(action("send"));
		expect([noneResults, emptyResults]).toEqual([[], []]);
	});

	test("the description is the same object until something changes, then rebuilt", async () => {
		const { hub, feed } = await make(threads);
		const first = hub.describe(cx);
		expect(hub.describe(cx)).toBe(first);
		expect(hub.describe({ ...cx, dark: false })).not.toBe(first);
		const second = hub.describe(cx);
		feed.push(A, event(1, { kind: "tool", text: "read: a.go" }));
		await until(() => hub.describe(cx) !== second);
		expect(JSON.stringify(hub.describe(cx))).toContain("read: a.go");
		expect(nodes(hub.describe(cx)).filter(n => n.k === "rows")).toEqual([]);
	});
});
