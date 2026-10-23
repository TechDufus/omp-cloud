import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { CloudClient } from "../src/api";
import { CARD_TYPE, CARD_VERSION, updateCard, type CardDetails } from "../src/cards";
import { parseUpdateStatus, parseWhoami } from "../src/wire";
import type { UpdateStatus, Whoami } from "../src/types";
import { compareVersions, pluginOlderText, Updates, updateLine, updateVersionsFromEntries, UPDATE_PROBE_MS, type Schedule, type UpdatesOptions } from "../src/update";
import { PLUGIN_VERSION } from "../src/version";
import { Cloud } from "../src/verbs";
import { statusText } from "../src/watch";
import { summary, whoami } from "./builders";
import { cloudEnv, fakeHost, fakePi, until, type FakeHost, type FakePi } from "./fakes";
import { cleanup, FAST_RETRY, tmp } from "./helpers";

afterEach(cleanup);

/** The service as it reports itself in the session tests: as new as this plugin, so no test sees the older-plugin notice unless it asks for it. */
const SERVICE = { version: PLUGIN_VERSION, api: 2, name: "" };

const OLDER_SERVICE = "99.0.0";

describe("versions", () => {
	test("compare by number, not by text; a release outranks its prereleases; anything else is unknown", () => {
		expect(compareVersions("0.4.0", "0.5.0")).toBeLessThan(0);
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
		expect(compareVersions("0.5.0", "v0.5.0")).toBe(0);
		expect(compareVersions("0.5.0-rc.1", "0.5.0")).toBeLessThan(0);
		expect(compareVersions("0.5.0", "0.5.0-rc.1")).toBeGreaterThan(0);
		expect(compareVersions("0.5.0-rc.1", "0.5.0-rc.2")).toBeLessThan(0);
		expect(compareVersions("dev", "0.5.0")).toBeUndefined();
		expect(compareVersions("", "0.5.0")).toBeUndefined();
	});

	test("the plugin's own version is the one in its package.json", () => {
		expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("the older-plugin notice says what to do", () => {
		expect(pluginOlderText("0.4.0", "0.5.0")).toBe("☁ the omp-cloud plugin 0.4.0 is older than the service 0.5.0: update it (omp plugin upgrade omp-cloud, or git pull in a linked checkout) and restart omp");
	});
});

describe("what the service says", () => {
	test("whoami carries the update; a whoami without it carries none", () => {
		const { update: _update, ...old } = whoami();
		expect(parseWhoami({ ...old, update: { state: "ready", available: "0.5.1", mode: "notify" } }).update).toEqual({ state: "ready", available: "0.5.1", mode: "notify" });
		expect(parseWhoami({ ...old, update: { state: "idle", available: null, mode: "notify" } }).update).toEqual({ state: "idle", available: null, mode: "notify" });
		expect(parseWhoami(old).update).toBeNull();
		// A state this plugin does not know reads as idle: nothing is offered.
		expect(parseWhoami({ ...old, update: { state: "rebooting", available: "", mode: "notify" } }).update).toEqual({ state: "idle", available: null, mode: "notify" });
	});

	test("a whoami from before access levels: a device is threads-only, the cloud has no name, the update mode is notify", () => {
		const { device: _device, service: _service, update: _update, ...old } = whoami();
		const before = parseWhoami({ ...old, device: { id: "d1", name: "laptop" }, service: { version: "0.5.0", api: 5 }, update: { state: "idle" } });
		expect(before.device).toEqual({ id: "d1", name: "laptop", access: "threads" });
		expect(before.service).toEqual({ version: "0.5.0", api: 5, name: "" });
		expect(before.update).toEqual({ state: "idle", available: null, mode: "notify" });
		const now = parseWhoami({ ...old, device: { id: "d1", name: "laptop", access: "full" }, service: { version: "0.6.0", api: 6, name: "home" }, update: { state: "idle", mode: "auto" } });
		expect(now.device?.access).toBe("full");
		expect(now.service.name).toBe("home");
		expect(now.update?.mode).toBe("auto");
		// Anything but `full` is the least a device can have.
		expect(parseWhoami({ ...old, device: { id: "d1", name: "laptop", access: "root" } }).device?.access).toBe("threads");
		expect(parseWhoami({ ...old, device: null }).device).toBeNull();
	});

	test("GET /update is read field by field; what the service leaves out is absent", () => {
		const status = parseUpdateStatus({
			mode: "notify",
			managed: true,
			state: "ready",
			current: { version: "0.5.0", build: { id: "b1", commit: "c", createdAt: "t" } },
			latest: { version: "0.5.1", notes: "## 0.5.1", publishedAt: "2026-10-21T00:00:00Z" },
			staged: "0.5.1",
			applying: null,
			error: null,
			message: null,
			checkedAt: "2026-10-21T01:00:00Z",
			components: { vmon: { installed: "v0.4.0", required: "v0.4.0", helper: true } },
			last: null,
		});
		expect(status).toEqual({
			mode: "notify",
			managed: true,
			state: "ready",
			current: { version: "0.5.0" },
			latest: { version: "0.5.1", notes: "## 0.5.1", publishedAt: "2026-10-21T00:00:00Z" },
			staged: "0.5.1",
			applying: null,
			error: null,
			message: null,
			checkedAt: "2026-10-21T01:00:00Z",
		});
		expect(parseUpdateStatus({ state: "applying", applying: { version: "0.5.1", step: "swap", startedAt: "t" } }).applying).toEqual({ version: "0.5.1", step: "swap", startedAt: "t" });
	});

	test("one line says each state, for the owner and for a device", () => {
		expect(updateLine(null, true)).toBeUndefined();
		expect(updateLine({ state: "ready", available: "0.5.1", mode: "notify" }, true)).toContain("/cloud update");
		expect(updateLine({ state: "ready", available: "0.5.1", mode: "notify" }, false)).toContain("a connection with full access installs it");
		expect(updateLine({ state: "downloading", available: "0.5.1", mode: "notify" }, true)).toBe("downloading 0.5.1");
		expect(updateLine({ state: "applying", available: "0.5.1", mode: "notify" }, true)).toBe("installing 0.5.1: the service restarts");
		expect(updateLine({ state: "failed", available: null, mode: "notify" }, false)).toContain("a connection with full access sees why");
		expect(updateLine({ state: "unsupported", available: null, mode: "notify" }, true)).toContain("git checkout");
		expect(updateLine({ state: "idle", available: null, mode: "notify" }, true)).toBe("up to date");
	});

	test("the footer adds `update ready` to what is there, or stands alone", () => {
		expect(statusText(0, 0, 0, true)).toBe("☁ update ready");
		expect(statusText(2, 1, 3, true)).toBe("☁ 2 working · 1 waiting · 3 unread · update ready");
		expect(statusText(0, 0, 0, false)).toBeUndefined();
		expect(statusText(1, 0)).toBe("☁ 1 working");
	});

	test("the cloud's name comes last, and stands alone in an idle footer", () => {
		expect(statusText(0, 0, 0, false, "home")).toBe("☁ home");
		expect(statusText(2, 1, 3, true, "home")).toBe("☁ 2 working · 1 waiting · 3 unread · update ready · home");
		expect(statusText(1, 0, 0, false, "home")).toBe("☁ 1 working · home");
		expect(statusText(0, 0, 0, false, "")).toBeUndefined();
		expect(statusText(0, 0, 0, false, undefined)).toBeUndefined();
	});
});

describe("the update routes", () => {
	test("status, check and apply go to their routes with the bearer token and read the answers", async () => {
		const seen: string[] = [];
		const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
			seen.push(`${init?.method} ${new URL(input).pathname} ${new Headers(init?.headers).get("authorization")}`);
			const p = new URL(input).pathname;
			if (p === "/api/v1/update/apply") return Response.json({ applying: { version: "0.5.1" } }, { status: 202 });
			if (p === "/api/v1/update/check") return Response.json({}, { status: 202 });
			return Response.json({ state: "ready", staged: "0.5.1", current: { version: "0.5.0" } });
		};
		const client = new CloudClient("http://svc", "tok", fetchFn, FAST_RETRY);
		expect((await client.updateStatus()).staged).toBe("0.5.1");
		await client.checkUpdate();
		expect(await client.applyUpdate()).toBe("0.5.1");
		expect(seen).toEqual(["GET /api/v1/update Bearer tok", "POST /api/v1/update/check Bearer tok", "POST /api/v1/update/apply Bearer tok"]);
	});

	test("a refusal to apply keeps the service's words and a code; apply is sent once", async () => {
		let applies = 0;
		const fetchFn = async (): Promise<Response> => {
			applies++;
			return Response.json({ error: "no update is ready" }, { status: 409 });
		};
		const err = await new CloudClient("http://svc", "tok", fetchFn, FAST_RETRY).applyUpdate().catch((e: unknown) => e);
		expect(err).toMatchObject({ code: "conflict", message: "no update is ready" });
		expect(applies).toBe(1);
	});
});

describe("Updates", () => {
	interface Probe {
		updates: Updates;
		notices: string[];
		cards: string[];
		changes: number;
		/** Versions the session's entries already hold. */
		shown: Set<string>;
		schedule: { runs: (() => void)[]; ms: number[]; stopped: number };
	}

	function probe(over: Partial<UpdatesOptions> = {}): Probe {
		const p: Probe = { updates: undefined as unknown as Updates, notices: [], cards: [], changes: 0, shown: new Set(), schedule: { runs: [], ms: [], stopped: 0 } };
		const schedule: Schedule = (run, ms) => {
			p.schedule.runs.push(run);
			p.schedule.ms.push(ms);
			return () => void p.schedule.stopped++;
		};
		p.updates = new Updates({ pluginVersion: "0.5.0", notify: m => void p.notices.push(m), card: v => void p.cards.push(v), shown: () => p.shown, changed: () => void p.changes++, schedule, ...over });
		return p;
	}

	const ready = (version: string, over: Partial<Whoami> = {}): Whoami => whoami({ service: { version: "0.5.0", api: 2, name: "" }, update: { state: "ready", available: version, mode: "notify" }, ...over });

	test("the owner gets the version, a footer change and one card; the same whoami again changes nothing", () => {
		const p = probe();
		p.updates.observe(ready("0.5.1"));
		expect(p.updates.ready).toBe("0.5.1");
		expect(p.updates.full).toBe(true);
		expect(p.changes).toBe(1);
		expect(p.cards).toEqual(["0.5.1"]);
		p.updates.observe(ready("0.5.1"));
		expect(p.changes).toBe(1);
		expect(p.cards).toEqual(["0.5.1"]);
	});

	test("a newer version gets its own card; a version the session already shows gets none", () => {
		const p = probe();
		p.shown.add("0.5.1");
		p.updates.observe(ready("0.5.1"));
		expect(p.cards).toEqual([]);
		// The footer still says so: only the card is once per version.
		expect(p.updates.ready).toBe("0.5.1");
		p.updates.observe(ready("0.5.2"));
		expect(p.cards).toEqual(["0.5.2"]);
		p.updates.observe(whoami({ service: { version: "0.5.0", api: 2, name: "" }, update: { state: "idle", available: null, mode: "notify" } }));
		p.updates.observe(ready("0.5.2"));
		expect(p.cards).toEqual(["0.5.2"]);
	});

	test("a device is told the state but never gets the footer or the card", () => {
		const p = probe();
		p.updates.observe(ready("0.5.1", { device: { id: "d1", name: "laptop", access: "threads" } }));
		expect(p.updates.full).toBe(false);
		expect(p.updates.update).toEqual({ state: "ready", available: "0.5.1", mode: "notify" });
		expect(p.updates.ready).toBeUndefined();
		expect(p.changes).toBe(0);
		expect(p.cards).toEqual([]);
	});

	test("a device with full access installs like the owner: the footer, the card and the version", () => {
		const p = probe();
		p.updates.observe(ready("0.5.1", { device: { id: "d1", name: "laptop", access: "full" } }));
		expect(p.updates.full).toBe(true);
		expect(p.updates.ready).toBe("0.5.1");
		expect(p.cards).toEqual(["0.5.1"]);
	});

	test("the cloud's name is kept, and the footer is refreshed when it changes", () => {
		const p = probe();
		p.updates.observe(whoami({ service: { version: "0.5.0", api: 6, name: "home" } }));
		expect(p.updates.cloud).toBe("home");
		expect(p.changes).toBe(1);
		p.updates.observe(whoami({ service: { version: "0.5.0", api: 6, name: "home" } }));
		expect(p.changes).toBe(1);
		p.updates.observe(whoami({ service: { version: "0.5.0", api: 6, name: "lab" } }));
		expect(p.changes).toBe(2);
		expect(p.updates.cloud).toBe("lab");
	});

	test("only a ready update is waiting for a click: downloading, failed, unsupported and idle are not", () => {
		const p = probe();
		for (const state of ["downloading", "checking", "applying", "failed", "unsupported", "idle"] as const) {
			p.updates.observe(whoami({ update: { state, available: "0.5.1", mode: "notify" } }));
			expect(p.updates.ready).toBeUndefined();
		}
		expect(p.cards).toEqual([]);
		expect(p.changes).toBe(0);
	});

	test("a service that reports no update: nothing ready, nothing said", () => {
		const p = probe();
		p.updates.observe(whoami({ update: null, service: { version: "", api: 1, name: "" } }));
		expect(p.updates.update).toBeNull();
		expect(p.updates.ready).toBeUndefined();
		expect(p.cards).toEqual([]);
		expect(p.notices).toEqual([]);
	});

	test("applying takes the footer away at once", () => {
		const p = probe();
		p.updates.observe(ready("0.5.1"));
		p.updates.applying("0.5.1");
		expect(p.updates.ready).toBeUndefined();
		expect(p.updates.update).toEqual({ state: "applying", available: "0.5.1", mode: "notify" });
		expect(p.changes).toBe(2);
	});

	test("a plugin older than the service says so once; the same, newer or unknown versions say nothing", () => {
		const p = probe();
		p.updates.observe(whoami({ service: { version: "0.6.0", api: 2, name: "" } }));
		p.updates.observe(whoami({ service: { version: "0.7.0", api: 2, name: "" } }));
		expect(p.notices).toEqual([pluginOlderText("0.5.0", "0.6.0")]);

		for (const service of ["0.5.0", "0.4.9", "", "dev"]) {
			const q = probe();
			q.updates.observe(whoami({ service: { version: service, api: 2, name: "" } }));
			expect(q.notices).toEqual([]);
		}
	});

	test("the probe runs at once and every quarter hour; a second start changes nothing; stop ends it", async () => {
		const p = probe();
		let probes = 0;
		const run = async (): Promise<void> => void probes++;
		p.updates.start(run);
		p.updates.start(run);
		expect(probes).toBe(1);
		expect(p.schedule.ms).toEqual([UPDATE_PROBE_MS]);
		expect(UPDATE_PROBE_MS).toBe(15 * 60_000);
		p.schedule.runs[0]?.();
		expect(probes).toBe(2);
		p.updates.stop();
		p.updates.stop();
		expect(p.schedule.stopped).toBe(1);
	});

	test("cards in a session's entries are what `shown` is made of", () => {
		const entry = (details: unknown, type = "custom_message") => ({ type, customType: CARD_TYPE, details });
		const other: CardDetails = { v: CARD_VERSION, kind: "notice", origin: "user", thread: "", title: "t", lines: [], body: "" };
		expect([...updateVersionsFromEntries([entry(updateCard("0.5.1", "")), entry(updateCard("0.5.2", "n")), entry(other), entry(updateCard("0.5.3", ""), "message"), { type: "custom_message", customType: "x", details: updateCard("0.5.4", "") }, "junk"])]).toEqual(["0.5.1", "0.5.2"]);
	});
});

// ---------------------------------------------------------------------------
// The session: a fake service
// ---------------------------------------------------------------------------

interface Req {
	method: string;
	path: string;
}

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
	mode: "notify",
	managed: true,
	state: "idle",
	current: { version: "0.5.0" },
	latest: null,
	staged: null,
	applying: null,
	error: null,
	message: null,
	checkedAt: null,
	...over,
});

const state = {
	reqs: [] as Req[],
	/** What `GET /whoami` answers; a service that reports no update has no `update` field. */
	who: whoami() as Omit<Whoami, "update"> & Partial<Pick<Whoami, "update">>,
	/** What `GET /update` answers; undefined is a service without the route. */
	status: undefined as UpdateStatus | undefined,
	/** The answer to `POST /update/apply`. */
	apply: undefined as Response | undefined,
};

function reset(): void {
	state.reqs = [];
	state.who = whoami({ user: "dev", service: SERVICE });
	state.status = undefined;
	state.apply = undefined;
}

let server: Bun.Server<undefined>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const p = new URL(req.url).pathname;
			state.reqs.push({ method: req.method, path: p });
			if (p === "/api/v1/whoami") return Response.json(state.who);
			if (p === "/api/v1/threads") return Response.json({ threads: [summary({ id: "k3x9fa2m7q1z" })] });
			if (p === "/api/v1/update" && state.status) return Response.json(state.status);
			if (p === "/api/v1/update/check" && req.method === "POST") return Response.json({}, { status: 202 });
			if (p === "/api/v1/update/apply" && req.method === "POST") return state.apply ?? Response.json({ applying: { version: state.status?.staged ?? "" } }, { status: 202 });
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

beforeEach(reset);

const live: Cloud[] = [];

afterEach(() => {
	for (const cloud of live.splice(0)) cloud.shutdown();
});

interface Rig {
	cloud: Cloud;
	host: FakeHost;
	pi: FakePi;
	/** The confirms the user was asked: title and message. */
	asked: [string, string][];
	/** What the user answers to a confirm. */
	answer: { yes: boolean };
}

async function setup(): Promise<Rig> {
	const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\n`);
	const host = fakeHost({ cwd: await tmp("omp-cloud-cwd-") });
	const asked: Rig["asked"] = [];
	const answer = { yes: true };
	host.host.ui.confirm = async (title, message) => {
		asked.push([title, message]);
		return answer.yes;
	};
	const pi = fakePi();
	const cloud = new Cloud(pi.pi, "/own", env, await tmp("omp-cloud-home-"), () => {}, { notify: () => {}, write: () => {} }, FAST_RETRY);
	live.push(cloud);
	cloud.rebind(host.host);
	return { cloud, host, pi, asked, answer };
}

const notes = (r: Rig): string[] => r.host.notes.map(n => n[0]);
const posts = (): string[] => state.reqs.filter(q => q.method === "POST").map(q => q.path);
const cards = (r: Rig) => r.pi.sent.map(s => s.message.details as CardDetails).filter(d => d.kind === "update");
const READY = { state: "ready" as const, available: "0.5.1", mode: "notify" as const };

describe("the footer and the card", () => {
	test("the owner of a service with an update ready: `update ready` in the footer and one card, with the release notes, that does not wake the model", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		state.status = status({ state: "ready", staged: "0.5.1", latest: { version: "0.5.1", notes: "## 0.5.1\n- Tern-style updates", publishedAt: "" } });
		const r = await setup();
		r.cloud.probeUpdates(r.host.host);
		await until(() => cards(r).length === 1);
		expect(r.host.status.at(-1)).toBe("☁ update ready");
		const [card] = cards(r);
		expect(card).toMatchObject({ kind: "update", version: "0.5.1", notes: "## 0.5.1\n- Tern-style updates", origin: "user", thread: "" });
		const sent = r.pi.sent.find(s => (s.message.details as CardDetails).kind === "update");
		expect(sent?.options).toEqual({ triggerTurn: false });
		expect(sent?.message.content).toContain("omp-cloud 0.5.1 is ready");
		expect(notes(r)).toEqual([]);
	});

	test("once per version: every other surface that sees the same whoami adds no card; a newer version adds one", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		state.status = status({ state: "ready", staged: "0.5.1" });
		const r = await setup();
		r.cloud.probeUpdates(r.host.host);
		await until(() => cards(r).length === 1);
		await r.cloud.handle("list", r.host.host as never);
		await r.cloud.handle("list", r.host.host as never);
		expect(cards(r)).toHaveLength(1);

		state.who = whoami({ user: "dev", service: SERVICE, update: { state: "ready", available: "0.5.2", mode: "notify" } });
		await r.cloud.handle("list", r.host.host as never);
		await until(() => cards(r).length === 2);
		expect(cards(r).map(c => (c.kind === "update" ? c.version : ""))).toEqual(["0.5.1", "0.5.2"]);
	});

	test("a session that already holds the version's card (resumed) shows none again, and still has the footer", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		state.status = status({ state: "ready", staged: "0.5.1" });
		const env = await cloudEnv(`url: http://127.0.0.1:${server.port}\ntoken: tok\n`);
		const host = fakeHost({ cwd: await tmp("omp-cloud-cwd-"), entries: [{ type: "custom_message", customType: CARD_TYPE, details: updateCard("0.5.1", "") }] });
		const pi = fakePi();
		const cloud = new Cloud(pi.pi, "/own", env, await tmp("omp-cloud-home-"), () => {}, { notify: () => {}, write: () => {} }, FAST_RETRY);
		live.push(cloud);
		cloud.probeUpdates(host.host);
		await until(() => host.status.at(-1) === "☁ update ready");
		expect(pi.sent).toEqual([]);
	});

	test("a device never gets the footer or the card, and nothing is asked of the owner's route", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, device: { id: "d1", name: "laptop", access: "threads" }, update: READY });
		state.status = status({ state: "ready", staged: "0.5.1" });
		const r = await setup();
		r.cloud.probeUpdates(r.host.host);
		await until(() => state.reqs.some(q => q.path === "/api/v1/whoami"));
		await r.cloud.handle("list", r.host.host as never);
		expect(r.host.status.at(-1)).toBeUndefined();
		expect(cards(r)).toEqual([]);
		expect(state.reqs.map(q => q.path)).not.toContain("/api/v1/update");
	});

	test("the footer clears when the update is no longer ready", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		const r = await setup();
		r.cloud.probeUpdates(r.host.host);
		await until(() => r.host.status.at(-1) === "☁ update ready");
		state.who = whoami({ user: "dev", service: { version: "0.5.1", api: 2, name: "" }, update: { state: "idle", available: null, mode: "notify" } });
		await r.cloud.handle("list", r.host.host as never);
		expect(r.host.status.at(-1)).toBeUndefined();
	});

	test("a service that reports no update (none in whoami) is silent: no footer, no notice, no card, no request to the owner's route", async () => {
		const { update: _update, ...old } = whoami({ user: "dev", service: { version: "", api: 1, name: "" } });
		const r = await setup();
		state.who = old;
		r.cloud.probeUpdates(r.host.host);
		await until(() => state.reqs.some(q => q.path === "/api/v1/whoami"));
		await r.cloud.handle("list", r.host.host as never);
		expect(r.host.status.at(-1)).toBeUndefined();
		expect(r.host.notes).toEqual([]);
		expect(r.pi.sent.filter(s => (s.message.details as CardDetails).kind === "update")).toEqual([]);
		expect(state.reqs.map(q => q.path)).not.toContain("/api/v1/update");
	});
});

describe("the plugin older than the service", () => {
	test("says so once per session, whichever surface sees it first, with the contract's text", async () => {
		state.who = whoami({ user: "dev", service: { version: OLDER_SERVICE, api: 2, name: "" } });
		const r = await setup();
		r.cloud.probeUpdates(r.host.host);
		await until(() => notes(r).length === 1);
		expect(notes(r)[0]).toBe(pluginOlderText(PLUGIN_VERSION, OLDER_SERVICE));
		expect(r.host.notes[0]?.[1]).toBe("warning");
		await r.cloud.handle("list", r.host.host as never);
		await r.cloud.handle("status", r.host.host as never);
		await r.cloud.handle("update", r.host.host as never);
		expect(notes(r).filter(n => n.includes("is older than the service"))).toHaveLength(1);
	});

	test("a plugin that is as new as the service says nothing", async () => {
		state.who = whoami({ user: "dev", service: { version: PLUGIN_VERSION, api: 2, name: "" } });
		const r = await setup();
		r.cloud.probeUpdates(r.host.host);
		await until(() => state.reqs.some(q => q.path === "/api/v1/whoami"));
		await r.cloud.handle("list", r.host.host as never);
		expect(notes(r).filter(n => n.includes("older"))).toEqual([]);
	});
});

describe("/cloud update", () => {
	test("ready: the owner is asked, with the version and the working threads; yes asks the service to install and clears the footer", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY, threads: { starting: 0, working: 2, waiting: 0, idle: 0, failed: 0 } });
		state.status = status({ state: "ready", staged: "0.5.1", latest: { version: "0.5.1", notes: "", publishedAt: "" } });
		const r = await setup();
		await r.cloud.handle("update", r.host.host as never);
		expect(r.asked).toEqual([["Update omp-cloud", "Install omp-cloud 0.5.1 and restart the cloud service? It is unreachable for a moment while it restarts. 2 threads are working right now."]]);
		expect(posts()).toEqual(["/api/v1/update/apply"]);
		expect(notes(r)).toContain("☁ installing omp-cloud 0.5.1: the service restarts in a moment");
		expect(r.host.status.at(-1)).toBeUndefined();
	});

	test("declining sends nothing", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		state.status = status({ state: "ready", staged: "0.5.1" });
		const r = await setup();
		r.answer.yes = false;
		await r.cloud.handle("update", r.host.host as never);
		expect(r.asked).toHaveLength(1);
		expect(posts()).toEqual([]);
		expect(notes(r)).toEqual([]);
	});

	test("the service's refusal (nothing ready any more) is shown in its own words", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		state.status = status({ state: "ready", staged: "0.5.1" });
		state.apply = Response.json({ error: "an update is already being applied" }, { status: 409 });
		const r = await setup();
		await r.cloud.handle("update", r.host.host as never);
		expect(r.host.notes.at(-1)).toEqual(["☁ an update is already being applied", "error"]);
	});

	test("idle: a check is started and the owner is told how to read the result; nothing is asked", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: { state: "idle", available: null, mode: "notify" } });
		state.status = status({ state: "idle", checkedAt: "2026-10-21T01:00:00Z" });
		const r = await setup();
		await r.cloud.handle("update", r.host.host as never);
		expect(posts()).toEqual(["/api/v1/update/check"]);
		expect(r.asked).toEqual([]);
		expect(notes(r)).toEqual([`☁ omp-cloud ${PLUGIN_VERSION} is up to date (checked 2026-10-21T01:00:00Z); checking again now: /cloud update shows what it finds`]);
	});

	test.each([
		["downloading", { state: "downloading" as const, latest: { version: "0.5.1", notes: "", publishedAt: "" } }, [], `☁ omp-cloud ${PLUGIN_VERSION}: downloading 0.5.1; the footer says "update ready" when it can be installed`],
		["checking", { state: "checking" as const }, [], `☁ omp-cloud ${PLUGIN_VERSION}: checking for a newer version; /cloud update shows what it finds`],
		["applying", { state: "applying" as const, applying: { version: "0.5.1", step: "swap", startedAt: "" } }, [], `☁ omp-cloud ${PLUGIN_VERSION} is installing 0.5.1 (swap): the service restarts`],
		["failed", { state: "failed" as const, error: "vibemon v0.5.0 is needed" }, ["/api/v1/update/check"], `☁ omp-cloud ${PLUGIN_VERSION}: the last update failed: vibemon v0.5.0 is needed; checking again`],
		["unsupported", { state: "unsupported" as const, message: "this omp-cloud runs from a git checkout; update it with git pull and restart it" }, [], "☁ this omp-cloud runs from a git checkout; update it with git pull and restart it"],
	])("%s: says so", async (_name, over, expectedPosts, line) => {
		state.who = whoami({ user: "dev", service: SERVICE, update: { state: over.state, available: null, mode: "notify" } });
		state.status = status(over);
		const r = await setup();
		await r.cloud.handle("update", r.host.host as never);
		expect(notes(r)).toEqual([line]);
		expect(posts()).toEqual(expectedPosts);
		expect(r.asked).toEqual([]);
	});

	test("a device is told the state and the owner's route is never asked", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, device: { id: "d1", name: "laptop", access: "threads" }, update: READY });
		const r = await setup();
		await r.cloud.handle("update", r.host.host as never);
		expect(notes(r)).toEqual([`☁ omp-cloud ${PLUGIN_VERSION}: 0.5.1 is downloaded and ready: a connection with full access installs it (/cloud update there)`]);
		expect(state.reqs.map(q => q.path)).not.toContain("/api/v1/update");
		expect(r.asked).toEqual([]);
	});

	test("a service that does not support updates, whether whoami lacks the field or the route is missing, is told so", async () => {
		const r = await setup();
		await r.cloud.handle("update", r.host.host as never);
		expect(notes(r)).toEqual(["☁ this omp-cloud service does not support updates: update it by hand"]);

		reset();
		state.who = whoami({ user: "dev", service: SERVICE, update: { state: "idle", available: null, mode: "notify" } });
		const again = await setup();
		await again.cloud.handle("update", again.host.host as never);
		expect(notes(again)).toEqual(["☁ this omp-cloud service does not support updates: update it by hand"]);
	});

	test("it is a verb: listed in help and completed", async () => {
		const r = await setup();
		expect(r.cloud.complete("upd")?.map(c => c.value)).toEqual(["update"]);
	});
});

describe("the card's Restart to update button", () => {
	test("runs the same path: the owner confirms, then the service is asked", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		state.status = status({ state: "ready", staged: "0.5.1" });
		const r = await setup();
		r.cloud.run("", { kind: "update" });
		await until(() => posts().length === 1);
		expect(r.asked).toHaveLength(1);
		expect(posts()).toEqual(["/api/v1/update/apply"]);
		await until(() => notes(r).includes("☁ installing omp-cloud 0.5.1: the service restarts in a moment"));
	});

	test("a failure is a notification, never a throw", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		state.status = status({ state: "ready", staged: "0.5.1" });
		state.apply = Response.json({ error: "nothing is ready" }, { status: 409 });
		const r = await setup();
		r.cloud.run("", { kind: "update" });
		await until(() => notes(r).includes("☁ nothing is ready"));
	});
});

describe("/cloud status", () => {
	test("names the update when the service reports one, and nothing when it reports none", async () => {
		state.who = whoami({ user: "dev", service: SERVICE, update: READY });
		const r = await setup();
		await r.cloud.handle("status", r.host.host as never);
		expect(notes(r).at(-1)).toContain("  updates: notify · 0.5.1 is downloaded and ready");

		reset();
		const old = await setup();
		await old.cloud.handle("status", old.host.host as never);
		expect(notes(old).at(-1)).not.toContain("update:");
	});
});
