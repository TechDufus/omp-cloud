import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginManager } from "../auth/login";
import { DashboardSessions } from "../dashboard/session";
import { GitService } from "../git";
import { isRecord } from "../guards";
import { Settings } from "../settings";
import { Store } from "../store";
import type { NewThread, TurnResult } from "../store/types";
import type { SandboxMetricsSample, SandboxSummary } from "../vmon";
import { type App, createApp } from "./app";
import { OWNER, tokenSha256 } from "./auth";
import type { VmInspector } from "./dashboard-routes";

const TOKEN = "s3cret-token";
const ORIGIN = "http://127.0.0.1:8081";
const VMON_DASHBOARD = "http://127.0.0.1:3000/dashboard/";
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";

function newThread(owner = OWNER): NewThread {
	return {
		owner,
		title: "fix the bug",
		prompt: "please fix the bug",
		model: "",
		thinking: "",
		repo: { name: "repo", remoteURL: "", baseRef: "", baseCommit: "", handoffCommit: "a".repeat(40), localBranch: "" },
		paths: { home: "", workspace: "" },
		author: { name: "", email: "" },
		secretFiles: [],
		secretEnv: [],
		configOverlays: [],
		ompVersion: "18.12.3",
		policy: {},
	};
}

function result(cost: number): TurnResult {
	return {
		outcome: "completed",
		error: "",
		reply: "done",
		usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, cost },
		head: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		pushed: false,
		pushError: "",
		pushRef: "",
	};
}

/** A vmon with a canned list and canned samples; records what it was asked. */
class FakeVmon implements VmInspector {
	listed: SandboxSummary[] = [];
	listFails = false;
	/** A sample, null for none, or an Error to throw. */
	samples = new Map<string, SandboxMetricsSample | null | Error>();
	queries: Record<string, string>[] = [];
	sampled: string[] = [];

	async list(metadata: Record<string, string>): Promise<SandboxSummary[]> {
		this.queries.push(metadata);
		if (this.listFails) throw new Error("vmon is down");
		return this.listed;
	}

	async metrics(sandboxId: string): Promise<SandboxMetricsSample | null> {
		this.sampled.push(sandboxId);
		const sample = this.samples.get(sandboxId) ?? null;
		if (sample instanceof Error) throw sample;
		return sample;
	}
}

const SAMPLE: SandboxMetricsSample = { at: "2026-10-20T00:00:00.000Z", cpuUsedPct: 12.5, memUsed: 100, memTotal: 1000, diskUsed: 5, diskTotal: 50 };

let dir: string;
let store: Store;
let vmon: FakeVmon;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
	store = Store.open({ dataDir: dir });
	vmon = new FakeVmon();
});

afterEach(async () => {
	store.close();
	await rm(dir, { recursive: true, force: true });
});

async function appWith(extra: { dashboard?: boolean; vmon?: boolean } = {}): Promise<App> {
	const gateway = { served: ["anthropic"], providers: () => ["anthropic"], refresh: async (): Promise<void> => undefined };
	return createApp({
		store,
		apiTokenSha256: tokenSha256(TOKEN),
		dataDir: dir,
		models: { default: "fake/fake-model", direct: ["fake"], gateway },
		ompVersion: "18.12.3",
		logins: new LoginManager({ brokerUrl: "http://127.0.0.1:1", brokerTokenFile: "/nonexistent/auth-broker.token" }),
		settings: Settings.load(store),
		git: await GitService.open({ dataDir: dir, hosts: {}, fetchTimeoutSeconds: 10, pushTimeoutSeconds: 10 }),
		dashboard: extra.dashboard === false ? undefined : { origin: ORIGIN, upstream: ORIGIN, sessions: new DashboardSessions() },
		vmon: extra.vmon === true ? vmon : undefined,
		vmonDashboard: VMON_DASHBOARD,
	});
}

function call(app: App, method: string, path: string, token: string | null = TOKEN): Promise<Response> {
	const headers = new Headers();
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	return app.fetch(new Request(`http://omp.test${path}`, { method, headers }));
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
	const body: unknown = await res.json();
	if (!isRecord(body)) throw new Error("expected a JSON object");
	return body;
}

/** A thread with a running first turn, completed with `cost` when given. */
function thread(id: string, owner = OWNER, cost?: number): void {
	store.createThread(id, newThread(owner));
	store.startNextTurn(id);
	if (cost !== undefined) store.completeTurn(id, 1, result(cost));
}

describe("POST /api/v1/dashboard/links", () => {
	test("mints a one-time link to the dashboard's origin, valid for 60 s", async () => {
		const app = await appWith();
		const before = Date.now();
		const res = await call(app, "POST", "/api/v1/dashboard/links");
		expect(res.status).toBe(201);
		const body = await bodyOf(res);
		expect(Object.keys(body).sort()).toEqual(["expiresAt", "url"]);
		expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:8081\/#[A-Za-z0-9_-]{43}$/);
		const ttl = Date.parse(String(body.expiresAt)) - before;
		expect(ttl).toBeGreaterThan(59_000);
		expect(ttl).toBeLessThanOrEqual(61_000);
		// Every link is new.
		expect((await bodyOf(await call(app, "POST", "/api/v1/dashboard/links"))).url).not.toBe(body.url);
	});

	test("404 the dashboard is not configured without the section", async () => {
		const res = await call(await appWith({ dashboard: false }), "POST", "/api/v1/dashboard/links");
		expect(res.status).toBe(404);
		expect(await bodyOf(res)).toEqual({ error: "the dashboard is not configured" });
	});

	test("needs the bearer token and POST", async () => {
		const app = await appWith();
		expect((await call(app, "POST", "/api/v1/dashboard/links", null)).status).toBe(401);
		expect((await call(app, "POST", "/api/v1/dashboard/links", "wrong")).status).toBe(401);
		expect((await call(app, "GET", "/api/v1/dashboard/links")).status).toBe(404);
	});
});

describe("GET /api/v1/usage", () => {
	test("sums the owner's recorded usage per thread and day, in the documented shape", async () => {
		thread(A, OWNER, 0.5);
		thread(B, OWNER, 0.25);
		thread(C, "bob", 9);
		const res = await call(await appWith(), "GET", "/api/v1/usage");
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		expect(Object.keys(body).sort()).toEqual(["days", "since", "threads", "total"]);
		expect(body.total).toEqual({ inputTokens: 20, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 80, cost: 0.75 });
		expect(body.threads).toEqual([
			{ thread: A, title: "fix the bug", name: "", cost: 0.5, turns: 1 },
			{ thread: B, title: "fix the bug", name: "", cost: 0.25, turns: 1 },
		]);
		const days = body.days;
		expect(Array.isArray(days) && days.length >= 1 && days.length <= 2).toBe(true);
		const dayCosts = Array.isArray(days) ? days.map(d => (isRecord(d) ? Number(d.cost) : Number.NaN)) : [];
		expect(dayCosts.reduce((sum, cost) => sum + cost, 0)).toBe(0.75);
	});

	test("since defaults to 30 days ago and is echoed as an ISO instant", async () => {
		const app = await appWith();
		const defaulted = Date.parse(String((await bodyOf(await call(app, "GET", "/api/v1/usage"))).since));
		expect(Date.now() - defaulted).toBeGreaterThan(30 * 86_400_000 - 5000);
		expect(Date.now() - defaulted).toBeLessThan(30 * 86_400_000 + 5000);
		expect((await bodyOf(await call(app, "GET", "/api/v1/usage?since=2026-01-02"))).since).toBe("2026-01-02T00:00:00.000Z");
		expect((await bodyOf(await call(app, "GET", "/api/v1/usage?since=2026-01-02T03:04:05%2B02:00"))).since).toBe("2026-01-02T01:04:05.000Z");
	});

	test("since bounds what counts", async () => {
		thread(A, OWNER, 0.5);
		const app = await appWith();
		const future = new Date(Date.now() + 86_400_000).toISOString();
		const empty = await bodyOf(await call(app, "GET", `/api/v1/usage?since=${encodeURIComponent(future)}`));
		expect(empty.threads).toEqual([]);
		expect(empty.days).toEqual([]);
		expect(empty.total).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
	});

	test.each(["yesterday", "", "1700000000", "2026-13-45", "2026-02"])("400 for since=%p", async since => {
		const res = await call(await appWith(), "GET", `/api/v1/usage?since=${since}`);
		expect(res.status).toBe(400);
		expect(await bodyOf(res)).toEqual({ error: "since must be an ISO 8601 time" });
	});

	test("needs the bearer token and GET", async () => {
		const app = await appWith();
		expect((await call(app, "GET", "/api/v1/usage", null)).status).toBe(401);
		expect((await call(app, "POST", "/api/v1/usage")).status).toBe(404);
	});
});

describe("GET /api/v1/vms", () => {
	function records(): void {
		thread(A);
		thread(B);
		thread(C, "bob");
		store.putVm({ threadId: A, sandboxId: "sbx-a", state: "running", pid: 42, sessionFile: null });
		store.putVm({ threadId: B, sandboxId: "sbx-b", state: "paused", pid: null, sessionFile: null });
		store.putVm({ threadId: C, sandboxId: "sbx-c", state: "running", pid: 7, sessionFile: null });
	}

	test("without a vmon it lists the owner's records with empty live fields", async () => {
		records();
		const res = await call(await appWith(), "GET", "/api/v1/vms");
		expect(res.status).toBe(200);
		expect(await bodyOf(res)).toEqual({
			vmonDashboard: VMON_DASHBOARD,
			vms: [
				{ thread: A, sandboxId: "sbx-a", state: "running", pid: 42, startedAt: "", cpuCount: 0, memoryMB: 0, metrics: null },
				{ thread: B, sandboxId: "sbx-b", state: "paused", pid: null, startedAt: "", cpuCount: 0, memoryMB: 0, metrics: null },
			],
		});
	});

	test("with a vmon it joins the live view and samples only running sandboxes", async () => {
		records();
		vmon.listed = [
			{ sandboxId: "sbx-a", state: "running", metadata: {}, startedAt: "2026-10-20T00:00:00.000Z", cpuCount: 2, memoryMB: 2048 },
			{ sandboxId: "sbx-b", state: "paused", metadata: {}, startedAt: "2026-10-19T00:00:00.000Z", cpuCount: 1, memoryMB: 1024 },
		];
		vmon.samples.set("sbx-a", SAMPLE);
		vmon.samples.set("sbx-b", SAMPLE);
		const body = await bodyOf(await call(await appWith({ vmon: true }), "GET", "/api/v1/vms"));

		expect(vmon.queries).toEqual([{ app: "omp-cloud", service: store.serviceId() }]);
		expect(vmon.sampled).toEqual(["sbx-a"]);
		expect(body.vms).toEqual([
			{ thread: A, sandboxId: "sbx-a", state: "running", pid: 42, startedAt: "2026-10-20T00:00:00.000Z", cpuCount: 2, memoryMB: 2048, metrics: SAMPLE },
			{ thread: B, sandboxId: "sbx-b", state: "paused", pid: null, startedAt: "2026-10-19T00:00:00.000Z", cpuCount: 1, memoryMB: 1024, metrics: null },
		]);
	});

	test("vmon's state wins over the record's", async () => {
		records();
		vmon.listed = [{ sandboxId: "sbx-a", state: "paused", metadata: {}, startedAt: "2026-10-20T00:00:00.000Z", cpuCount: 2, memoryMB: 2048 }];
		const body = await bodyOf(await call(await appWith({ vmon: true }), "GET", "/api/v1/vms"));
		const first = Array.isArray(body.vms) ? body.vms[0] : undefined;
		expect(isRecord(first) ? first.state : undefined).toBe("paused");
		expect(vmon.sampled).toEqual([]);
	});

	test("a failing metrics call gives null for that sandbox only", async () => {
		records();
		store.putVm({ threadId: B, sandboxId: "sbx-b", state: "running", pid: null, sessionFile: null });
		vmon.listed = [
			{ sandboxId: "sbx-a", state: "running", metadata: {}, startedAt: "2026-10-20T00:00:00.000Z", cpuCount: 2, memoryMB: 2048 },
			{ sandboxId: "sbx-b", state: "running", metadata: {}, startedAt: "2026-10-20T00:00:00.000Z", cpuCount: 2, memoryMB: 2048 },
		];
		vmon.samples.set("sbx-a", new Error("no metrics endpoint"));
		vmon.samples.set("sbx-b", SAMPLE);
		const res = await call(await appWith({ vmon: true }), "GET", "/api/v1/vms");
		expect(res.status).toBe(200);
		const vms = (await bodyOf(res)).vms;
		expect(Array.isArray(vms) ? vms.map(v => (isRecord(v) ? v.metrics : "?")) : []).toEqual([null, SAMPLE]);
	});

	test("an unreachable vmon degrades to the records", async () => {
		records();
		vmon.listFails = true;
		const res = await call(await appWith({ vmon: true }), "GET", "/api/v1/vms");
		expect(res.status).toBe(200);
		const vms = (await bodyOf(res)).vms;
		expect(Array.isArray(vms) ? vms.map(v => (isRecord(v) ? [v.sandboxId, v.state, v.startedAt, v.metrics] : "?")) : []).toEqual([
			["sbx-a", "running", "", null],
			["sbx-b", "paused", "", null],
		]);
		expect(vmon.sampled).toEqual([]);
	});

	test("a VM whose thread was deleted is still listed for its owner", async () => {
		records();
		await store.deleteThread(A);
		const vms = (await bodyOf(await call(await appWith(), "GET", "/api/v1/vms"))).vms;
		expect(Array.isArray(vms) ? vms.map(v => (isRecord(v) ? v.thread : "?")) : []).toEqual([A, B]);
	});

	test("needs the bearer token and GET", async () => {
		const app = await appWith();
		expect((await call(app, "GET", "/api/v1/vms", null)).status).toBe(401);
		expect((await call(app, "DELETE", "/api/v1/vms")).status).toBe(404);
	});
});

describe("GET /api/v1/events", () => {
	test("needs the bearer token and streams like the dashboard's", async () => {
		const app = await appWith();
		expect((await call(app, "GET", "/api/v1/events", null)).status).toBe(401);

		const ctrl = new AbortController();
		const res = await app.fetch(new Request("http://omp.test/api/v1/events", { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal }));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("text/event-stream");
		const body = res.body;
		if (body === null) throw new Error("no body");
		const reader = body.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
		ctrl.abort();
		await reader.cancel();
	});
});
