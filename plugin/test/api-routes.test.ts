import { describe, expect, test } from "bun:test";
import { CloudClient, type FetchFn } from "../src/api";
import { CloudError } from "../src/errors";
import { parseQuestion, parseThreadSummary } from "../src/wire";
import type { ScratchHandoffRequest } from "../src/types";
import { summary } from "./builders";

interface Seen {
	method: string;
	path: string;
	params: URLSearchParams;
}

/** A client whose transport answers with `answer(path)` and records every request. */
function service(answer: (seen: Seen) => Response): { client: CloudClient; seen: Seen[] } {
	const seen: Seen[] = [];
	const fetchFn: FetchFn = async (url, init) => {
		const parsed = new URL(url);
		const entry: Seen = { method: init?.method ?? "GET", path: parsed.pathname, params: parsed.searchParams };
		seen.push(entry);
		return answer(entry);
	};
	return { client: new CloudClient("http://cloud.test", "tok", fetchFn, { backoffMs: [] }), seen };
}

async function failed(call: Promise<unknown>): Promise<CloudError> {
	const err = await call.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(err instanceof CloudError)) throw new Error(`expected a CloudError, got ${String(err)}`);
	return err;
}

/** A whoami without the version, capability, limit, spend and model fields. */
const OLD_WHOAMI = { user: "owner", maxUploadBytes: 5000, defaultModel: "anthropic/claude-sonnet-4-6", modelPatterns: ["anthropic/*"], ompVersion: "18.12.3", gitHosts: [], vms: { running: 1, paused: 0 }, threads: { starting: 0, working: 1, waiting: 0, idle: 0, failed: 0 } };

describe("whoami: every field, and one without the version fields", () => {
	test("every field is parsed", async () => {
		const { client } = service(() =>
			Response.json({
				...OLD_WHOAMI,
				service: { version: "0.4.0", api: 2, name: "" },
				capabilities: ["threads.paging", "inspect"],
				limits: { maxMessageBytes: 32768, maxAnswerBytes: 4000, maxUploadBytes: 9999, listMax: 200, maxTurns: 200 },
				spend: { todayUSD: 1.25, dayCapUSD: 20 },
				models: [{ id: "anthropic/claude-sonnet-4-6" }, { id: "openai-codex/gpt-5" }],
			}),
		);
		const who = await client.whoami();
		expect(who.service).toEqual({ version: "0.4.0", api: 2, name: "" });
		expect(who.capabilities).toEqual(["threads.paging", "inspect"]);
		expect(who.limits).toEqual({ maxMessageBytes: 32768, maxAnswerBytes: 4000, maxUploadBytes: 9999, listMax: 200, maxTurns: 200 });
		expect(who.spend).toEqual({ todayUSD: 1.25, dayCapUSD: 20 });
		expect(who.models).toEqual([{ id: "anthropic/claude-sonnet-4-6" }, { id: "openai-codex/gpt-5" }]);
	});

	test("a whoami without the version fields is api 1 with no capabilities, the default limits, no spend, no models", async () => {
		const { client } = service(() => Response.json(OLD_WHOAMI));
		const who = await client.whoami();
		expect(who.service).toEqual({ version: "", api: 1, name: "" });
		expect(who.capabilities).toEqual([]);
		expect(who.limits).toEqual({ maxMessageBytes: 32768, maxAnswerBytes: 4000, maxUploadBytes: 5000, listMax: 50, maxTurns: 200 });
		expect(who.spend).toBeNull();
		expect(who.models).toEqual([]);
		expect(who.user).toBe("owner");
	});
});

describe("requireCapability", () => {
	test("a served capability passes, and is answered from the last whoami afterwards", async () => {
		const { client, seen } = service(() => Response.json({ ...OLD_WHOAMI, service: { version: "0.4.0", api: 2, name: "" }, capabilities: ["inspect"] }));
		await client.requireCapability("inspect");
		await client.requireCapability("inspect");
		expect(seen).toHaveLength(1);
	});

	test("a missing capability is version_skew naming it, the service version and what to do", async () => {
		const { client } = service(() => Response.json({ ...OLD_WHOAMI, service: { version: "0.4.0", api: 2, name: "" }, capabilities: ["inspect"] }));
		const err = await failed(client.requireCapability("events.json"));
		expect(err).toMatchObject({ code: "version_skew", retriable: false, outcomeKnown: true, hint: "update the omp-cloud service (`omp-cloud update` for an installed service; `git pull`, then restart it, for a checkout)" });
		expect(err.message).toContain("events.json");
		expect(err.message).toContain("0.4.0");
	});

	test("a service that reports no version says so", async () => {
		const { client } = service(() => Response.json(OLD_WHOAMI));
		const err = await failed(client.requireCapability("threads.paging"));
		expect(err.code).toBe("version_skew");
		expect(err.message).toContain("unknown version");
		expect(err.message).toContain("threads.paging");
	});

	test("a service that was updated since the last whoami is asked again before refusing", async () => {
		let capabilities: string[] = [];
		const { client, seen } = service(() => Response.json({ ...OLD_WHOAMI, service: { version: "0.4.0", api: 2, name: "" }, capabilities }));
		await client.whoami();
		capabilities = ["threads.scratch"];
		await client.requireCapability("threads.scratch");
		expect(seen).toHaveLength(2);
	});
});

describe("listThreadsPage", () => {
	test("sends every filter and parses the page", async () => {
		const { client, seen } = service(() => Response.json({ threads: [summary({ id: "aaaaaaaaaaaa" })], next: "cursor-2", total: 73 }));
		const page = await client.listThreadsPage({ limit: 20, before: "cursor-1", phase: ["working", "waiting"], origin: "tool", ref: "fix.1", session: "sess-1", repo: "app", since: "2026-01-01T00:00:00Z" });
		expect(seen[0]?.path).toBe("/api/v1/threads");
		expect(Object.fromEntries(seen[0]?.params ?? [])).toEqual({ limit: "20", before: "cursor-1", phase: "working,waiting", origin: "tool", ref: "fix.1", session: "sess-1", repo: "app", since: "2026-01-01T00:00:00Z" });
		expect(page.threads.map(t => t.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(page.next).toBe("cursor-2");
		expect(page.total).toBe(73);
	});

	test("no filter sends no query string", async () => {
		const { client, seen } = service(() => Response.json({ threads: [], next: null, total: 0 }));
		await client.listThreadsPage();
		expect([...(seen[0]?.params ?? [])]).toEqual([]);
	});

	test("a list without a cursor: the page is everything it sent", async () => {
		const { client } = service(() => Response.json({ threads: [summary({ id: "aaaaaaaaaaaa" }), summary({ id: "bbbbbbbbbbbb" })] }));
		const page = await client.listThreadsPage({ limit: 200 });
		expect(page).toMatchObject({ next: null, total: 2 });
		expect(page.threads[0]).toMatchObject({ origin: "", ref: "", session: "", scratch: false });
	});

	test("thread metadata is parsed; an unknown origin is unknown", () => {
		expect(parseThreadSummary({ ...summary(), origin: "tool", ref: "r1", session: "s1", scratch: true })).toMatchObject({ origin: "tool", ref: "r1", session: "s1", scratch: true });
		expect(parseThreadSummary({ ...summary(), origin: "robot" }).origin).toBe("");
	});

	test("a pull request is parsed; a thread without one, or with number 0, has none", () => {
		expect(parseThreadSummary({ ...summary(), pr: { number: 7, url: "https://github.com/o/r/pull/7" } }).pr).toEqual({ number: 7, url: "https://github.com/o/r/pull/7" });
		expect(parseThreadSummary(summary()).pr).toBeNull();
		expect(parseThreadSummary({ ...summary(), pr: null }).pr).toBeNull();
		expect(parseThreadSummary({ ...summary(), pr: { number: 0, url: "" } }).pr).toBeNull();
	});

	test("listThreads is the newest page's threads", async () => {
		const { client } = service(() => Response.json({ threads: [summary({ id: "aaaaaaaaaaaa" })], next: "c", total: 9 }));
		expect((await client.listThreads()).map(t => t.id)).toEqual(["aaaaaaaaaaaa"]);
	});
});

describe("question metadata", () => {
	test("kind and expiry come as the service sends them", () => {
		expect(parseQuestion({ id: 1, key: "approval:bash", kind: "approval", expiresAt: "2026-01-01T00:10:00Z" })).toMatchObject({ kind: "approval", expiresAt: "2026-01-01T00:10:00Z" });
	});

	test("a question without a kind gets it from its key, and no expiry", () => {
		expect(parseQuestion({ id: 1, key: "approval:edit" })).toMatchObject({ kind: "approval", expiresAt: null });
		expect(parseQuestion({ id: 1, key: "omp-cloud:push" }).kind).toBe("push");
		expect(parseQuestion({ id: 1, key: "q1" }).kind).toBe("ask");
		expect(parseQuestion({ id: 1, key: "q1", kind: "bogus" }).kind).toBe("ask");
	});

	test("a pending question on a thread summary carries them", () => {
		const parsed = parseThreadSummary({ ...summary(), question: { turn: 1, id: 2, ask: 1, text: "ok?", kind: "push", expiresAt: "2026-01-01T00:10:00Z" } });
		expect(parsed.question).toMatchObject({ kind: "push", expiresAt: "2026-01-01T00:10:00Z" });
		expect(parseThreadSummary({ ...summary(), question: { turn: 1, id: 2, ask: 1, text: "ok?" } }).question).toMatchObject({ kind: "ask", expiresAt: null });
	});
});

describe("full replies and events", () => {
	test("turnText asks for a part and window and parses the page", async () => {
		const { client, seen } = service(() => Response.json({ turn: 3, part: "error", total: 20000, offset: 8000, text: "abc", next: 16000 }));
		const page = await client.turnText("k3x9fa2m7q1z", 3, { part: "error", offset: 8000, limit: 8000 });
		expect(seen[0]?.path).toBe("/api/v1/threads/k3x9fa2m7q1z/turns/3/reply");
		expect(Object.fromEntries(seen[0]?.params ?? [])).toEqual({ part: "error", offset: "8000", limit: "8000" });
		expect(page).toEqual({ turn: 3, part: "error", total: 20000, offset: 8000, text: "abc", next: 16000 });
	});

	test("the last page has no next", async () => {
		const { client } = service(() => Response.json({ turn: 1, part: "reply", total: 3, offset: 0, text: "abc", next: null }));
		expect((await client.turnText("k3x9fa2m7q1z", 1)).next).toBeNull();
	});

	test("eventsPage asks for JSON with kinds, turn and cursor; events that are not events are dropped", async () => {
		const { client, seen } = service(() =>
			Response.json({ events: [{ seq: 5, at: "t", kind: "assistant", turn: 2, text: "hi" }, { kind: "x" }, "nope"], next: 5 }),
		);
		const page = await client.eventsPage("k3x9fa2m7q1z", { after: 4, limit: 50, kinds: ["assistant", "tool"], turn: 2 });
		expect(seen[0]?.path).toBe("/api/v1/threads/k3x9fa2m7q1z/events");
		expect(Object.fromEntries(seen[0]?.params ?? [])).toEqual({ format: "json", after: "4", limit: "50", kind: "assistant,tool", turn: "2" });
		expect(page.events).toEqual([{ seq: 5, at: "t", kind: "assistant", turn: 2, text: "hi" }]);
		expect(page.next).toBe(5);
	});

	test("the stream reports contact through onOpen before its first event", async () => {
		const order: string[] = [];
		const { client } = service(() => new Response('data: {"seq":1,"at":"t","kind":"assistant","turn":1,"text":"hi"}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
		for await (const event of client.events("k3x9fa2m7q1z", { onOpen: () => order.push("open") })) order.push(`event ${event.seq}`);
		expect(order).toEqual(["open", "event 1"]);
	});
});

describe("inspecting a result", () => {
	test("diff with stat parses the per-file counts", async () => {
		const { client, seen } = service(() =>
			Response.json({ base: "b1", head: "h1", files: [{ path: "a.ts", status: "M", insertions: 3, deletions: 1 }, { path: "b.ts", status: "A", insertions: 10, deletions: 0 }], insertions: 13, deletions: 1 }),
		);
		const result = await client.diff("k3x9fa2m7q1z", { stat: true, turn: 2, path: "a.ts", context: 5 });
		expect(seen[0]?.path).toBe("/api/v1/threads/k3x9fa2m7q1z/diff");
		expect(Object.fromEntries(seen[0]?.params ?? [])).toEqual({ turn: "2", path: "a.ts", stat: "1", context: "5" });
		expect(result.stat.files.map(f => [f.path, f.status])).toEqual([
			["a.ts", "M"],
			["b.ts", "A"],
		]);
		expect(result.stat).toMatchObject({ base: "b1", head: "h1", insertions: 13, deletions: 1 });
	});

	test("a cut diff reports its full length and the commits it compares", async () => {
		const { client, seen } = service(() => new Response("diff --git a/a b/a\n", { headers: { "X-Omp-Truncated": "70000", "X-Omp-Base": "b1", "X-Omp-Head": "h1" } }));
		const result = await client.diff("k3x9fa2m7q1z", { maxBytes: 1000 });
		expect(seen[0]?.params.get("maxBytes")).toBe("1000");
		expect(seen[0]?.params.has("stat")).toBe(false);
		expect(result).toEqual({ text: "diff --git a/a b/a\n", truncated: 70000, base: "b1", head: "h1" });
	});

	test("a whole diff is not truncated", async () => {
		const { client } = service(() => new Response("x", { headers: { "X-Omp-Base": "b1", "X-Omp-Head": "h1" } }));
		expect((await client.diff("k3x9fa2m7q1z")).truncated).toBeNull();
	});

	test("no result yet is not_found", async () => {
		const { client } = service(() => Response.json({ error: "no result yet" }, { status: 404 }));
		expect(await failed(client.diff("k3x9fa2m7q1z"))).toMatchObject({ code: "not_found", message: "no result yet" });
	});

	test("tree parses entries and the truncation flag", async () => {
		const { client, seen } = service(() => Response.json({ ref: "base", commit: "c1", path: "src", entries: [{ path: "src/a.ts", type: "file", size: 12 }, { path: "src/lib", type: "dir", size: 0 }], truncated: true }));
		const tree = await client.tree("k3x9fa2m7q1z", { ref: "base", path: "src", recursive: true });
		expect(Object.fromEntries(seen[0]?.params ?? [])).toEqual({ ref: "base", path: "src", recursive: "1" });
		expect(tree).toEqual({ ref: "base", commit: "c1", path: "src", entries: [{ path: "src/a.ts", type: "file", size: 12 }, { path: "src/lib", type: "dir", size: 0 }], truncated: true });
	});

	test("file encodes each path segment, keeps the slashes, and parses a page", async () => {
		const { client, seen } = service(() => Response.json({ path: "src/a b/é#.ts", ref: "head", commit: "c1", size: 99, binary: false, offset: 10, text: "hello", next: 15 }));
		const file = await client.file("k3x9fa2m7q1z", "src/a b/é#.ts", { offset: 10, limit: 5 });
		expect(seen[0]?.path).toBe("/api/v1/threads/k3x9fa2m7q1z/files/src/a%20b/%C3%A9%23.ts");
		expect(Object.fromEntries(seen[0]?.params ?? [])).toEqual({ offset: "10", limit: "5" });
		expect(file).toEqual({ path: "src/a b/é#.ts", ref: "head", commit: "c1", size: 99, binary: false, offset: 10, text: "hello", next: 15 });
	});

	test("a binary file has no text", async () => {
		const { client } = service(() => Response.json({ path: "x.png", ref: "head", commit: "c", size: 4, binary: true, offset: 0, text: "", next: null }));
		expect(await client.file("k3x9fa2m7q1z", "x.png")).toMatchObject({ binary: true, text: "", next: null });
	});
});

describe("a 413 names the limit", () => {
	test("a message over the limit says how long a message may be", async () => {
		const { client } = service(() => Response.json({ error: "request body is too large" }, { status: 413 }));
		const err = await failed(client.sendMessage("k3x9fa2m7q1z", "x"));
		expect(err).toMatchObject({ code: "too_large", status: 413 });
		expect(err.message).toBe("request body is too large (the limit is 32768 bytes)");
	});

	test("so does an IRC message over the limit", async () => {
		const { client } = service(() => Response.json({ error: "request body is too large" }, { status: 413 }));
		const err = await failed(client.irc("k3x9fa2m7q1z", { from: "Main", body: "x" }));
		expect(err).toMatchObject({ code: "too_large", status: 413 });
		expect(err.message).toBe("request body is too large (the limit is 32768 bytes)");
	});

	test("an upload says the service's upload limit once whoami has been read", async () => {
		const { client } = service(req => (req.path.endsWith("/whoami") ? Response.json({ ...OLD_WHOAMI, maxUploadBytes: 5 * 1024 * 1024 }) : Response.json({ error: "upload is too large" }, { status: 413 })));
		await client.whoami();
		const err = await failed(client.createThread({ request: scratchRequest() }));
		expect(err.message).toBe("upload is too large (the limit is 5 MiB)");
	});
});

function scratchRequest(): ScratchHandoffRequest {
	return {
		prompt: "do it",
		model: "",
		thinking: "",
		repo: { scratch: true },
		paths: { home: "/h", workspace: "/h/w" },
		author: { name: "Ada", email: "ada@example.com" },
		secretFiles: [],
		secretEnv: {},
		configOverlays: [],
		ompVersion: "",
	};
}

describe("device access", () => {
	/** A service with `capabilities` that records every request with its body. */
	function accessService(capabilities: string[]) {
		const sent: { method: string; path: string; body: string }[] = [];
		const fetchFn: FetchFn = async (url, init) => {
			const path = new URL(url).pathname;
			sent.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? init.body : "" });
			if (path === "/api/v1/whoami") return Response.json({ ...OLD_WHOAMI, capabilities });
			if (init?.method === "PATCH") return Response.json({ device: { id: "d1", name: "laptop", platform: "linux", access: "full", current: false } });
			return new Response(null, { status: 204 });
		};
		return { client: new CloudClient("http://cloud.test", "tok", fetchFn, { backoffMs: [] }), sent };
	}

	test("an approval names the access when the service has devices.access, and sends no body when it has not", async () => {
		const withAccess = accessService(["devices.access"]);
		await withAccess.client.approvePairing("offer1", "threads");
		expect(withAccess.sent.at(-1)).toEqual({ method: "POST", path: "/api/v1/pairing/offers/offer1/approve", body: JSON.stringify({ access: "threads" }) });

		const old = accessService([]);
		await old.client.approvePairing("offer1", "full");
		expect(old.sent.at(-1)).toEqual({ method: "POST", path: "/api/v1/pairing/offers/offer1/approve", body: "" });
	});

	test("setDeviceAccess patches the device and reads it back; a service without devices.access is version_skew and gets no PATCH", async () => {
		const withAccess = accessService(["devices.access"]);
		const changed = await withAccess.client.setDeviceAccess("d1", "full");
		expect(changed).toMatchObject({ id: "d1", name: "laptop", access: "full" });
		expect(withAccess.sent.at(-1)).toEqual({ method: "PATCH", path: "/api/v1/devices/d1", body: JSON.stringify({ access: "full" }) });

		const old = accessService([]);
		const err = await failed(old.client.setDeviceAccess("d1", "full"));
		expect(err).toMatchObject({ code: "version_skew", message: "this omp-cloud service has no device access levels; update it" });
		expect(old.sent.map(s => s.method)).toEqual(["GET"]);
	});

	test("a device listed without access is threads-only", async () => {
		const { client } = service(() => Response.json({ devices: [{ id: "d1", name: "laptop" }, { id: "d2", name: "phone", access: "full" }] }));
		expect((await client.devices()).map(d => d.access)).toEqual(["threads", "full"]);
	});
});
