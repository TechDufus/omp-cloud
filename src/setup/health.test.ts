import { describe, expect, test } from "bun:test";
import { checkVmonKey, type HealthDeps, type TemplateProbe, waitBroker, waitGateway, waitService, waitTemplate, waitVmon } from "./health";

/** A fake clock that only moves when something sleeps, and a fetch that answers from a script (an Error is a network failure). */
function fakeDeps(answer: (url: string, init: RequestInit | undefined, call: number) => Response | Error): { deps: HealthDeps; urls: string[]; sleeps: number[]; clock: () => number } {
	let time = 1_000_000;
	const urls: string[] = [];
	const sleeps: number[] = [];
	const deps: HealthDeps = {
		fetch: async (url, init) => {
			urls.push(url);
			const result = answer(url, init, urls.length);
			if (result instanceof Error) throw result;
			return result;
		},
		sleep: async (ms) => {
			sleeps.push(ms);
			time += ms;
		},
		now: () => time,
	};
	return { deps, urls, sleeps, clock: () => time };
}

const refused = () => new Error("connect ECONNREFUSED");
const health = (version: string) => Response.json({ status: "ok", version, build: { id: "dev" }, schema: 1 });

describe("waitVmon", () => {
	test("succeeds at once on 204", async () => {
		const { deps, urls, sleeps } = fakeDeps(() => new Response(null, { status: 204 }));
		const step = await waitVmon(deps);
		expect(step).toEqual({ id: "health.vmon", status: "ok", detail: "vmon is healthy" });
		expect(urls).toEqual(["http://127.0.0.1:3000/health"]);
		expect(sleeps).toEqual([]);
	});

	test("retries until it answers, one second apart", async () => {
		const { deps, urls, sleeps } = fakeDeps((_url, _init, call) => (call === 1 ? refused() : call === 2 ? new Response("starting", { status: 503 }) : new Response(null, { status: 204 })));
		const step = await waitVmon(deps);
		expect(step.status).toBe("ok");
		expect(step.detail).toBe("vmon is healthy (after 2 s)");
		expect(urls).toHaveLength(3);
		expect(sleeps).toEqual([1000, 1000]);
	});

	test("a 200 is not the 204 vmon's health route gives", async () => {
		const { deps } = fakeDeps(() => new Response("ok", { status: 200 }));
		const step = await waitVmon(deps, 3000);
		expect(step.status).toBe("failed");
		expect(step.detail).toContain("HTTP 200");
	});

	test("times out on the fake clock with the journal as the fix", async () => {
		const { deps, urls, clock } = fakeDeps(() => refused());
		const start = clock();
		const step = await waitVmon(deps, 5000);
		expect(step).toEqual({ id: "health.vmon", status: "failed", detail: "vmon is not healthy after 5 s (connect ECONNREFUSED)", fix: "journalctl -u vmon -n 50" });
		expect(clock() - start).toBe(5000);
		expect(urls).toHaveLength(6);
	});

	test("the default wait is 60 s", async () => {
		const { deps, clock } = fakeDeps(() => refused());
		const start = clock();
		const step = await waitVmon(deps);
		expect(step.status).toBe("failed");
		expect(clock() - start).toBe(60_000);
	});
});

describe("waitGateway and waitBroker", () => {
	test("the gateway answers 200 on the service IP", async () => {
		const { deps, urls } = fakeDeps(() => new Response("ok"));
		const step = await waitGateway(deps);
		expect(step).toMatchObject({ id: "health.gateway", status: "ok" });
		expect(urls).toEqual(["http://10.254.254.1:4000/healthz"]);
	});

	test("the gateway retries, then times out naming its unit", async () => {
		const retry = fakeDeps((_url, _init, call) => (call < 3 ? refused() : new Response("ok")));
		expect((await waitGateway(retry.deps)).status).toBe("ok");
		const never = fakeDeps(() => refused());
		const step = await waitGateway(never.deps, 2000);
		expect(step).toMatchObject({ id: "health.gateway", status: "failed", fix: "journalctl --user -u omp-auth-gateway -n 50" });
	});

	test("the broker answers 200 on /v1/healthz", async () => {
		const { deps, urls } = fakeDeps(() => new Response("ok"));
		expect(await waitBroker(deps)).toMatchObject({ id: "health.broker", status: "ok" });
		expect(urls).toEqual(["http://127.0.0.1:8765/v1/healthz"]);
	});

	test("the broker times out", async () => {
		const { deps } = fakeDeps(() => new Response("nope", { status: 500 }));
		expect(await waitBroker(deps, 1000)).toMatchObject({ id: "health.broker", status: "failed", fix: "journalctl --user -u omp-auth-broker -n 50" });
	});
});

describe("waitService", () => {
	const BASE = "http://127.0.0.1:8080";

	test("ready when status is ok and the version is the installed one", async () => {
		const { deps, urls } = fakeDeps(() => health("0.5.0"));
		const step = await waitService(deps, BASE, "0.5.0");
		expect(step).toMatchObject({ id: "health.service", status: "ok" });
		expect(urls).toEqual(["http://127.0.0.1:8080/api/v1/health"]);
	});

	test("the old process still answering is not ready; the new one is, once it is up", async () => {
		const { deps, urls } = fakeDeps((_url, _init, call) => (call < 3 ? health("0.4.0") : health("0.5.0")));
		const step = await waitService(deps, BASE, "0.5.0");
		expect(step.status).toBe("ok");
		expect(urls).toHaveLength(3);
	});

	test("a version that never changes fails and says which one is running", async () => {
		const { deps } = fakeDeps(() => health("0.4.0"));
		const step = await waitService(deps, BASE, "0.5.0", 3000);
		expect(step.status).toBe("failed");
		expect(step.detail).toContain("still running 0.4.0");
		expect(step.fix).toBe("journalctl --user -u omp-cloud -n 50");
	});

	test("a status that is not ok, or a body that is not JSON, is not ready", async () => {
		const answers = [() => Response.json({ status: "starting", version: "0.5.0" }), () => new Response("<html>", { status: 200 }), () => new Response("gone", { status: 502 })];
		for (const answer of answers) {
			const { deps } = fakeDeps(() => answer());
			expect((await waitService(deps, BASE, "0.5.0", 1000)).status).toBe("failed");
		}
	});

	test("connection refused until it listens (the service starts only once the gateway accepts it)", async () => {
		const { deps } = fakeDeps((_url, _init, call) => (call < 5 ? refused() : health("0.5.0")));
		expect((await waitService(deps, BASE, "0.5.0")).status).toBe("ok");
	});
});

describe("checkVmonKey", () => {
	test("200 is good and the key goes in X-API-Key", async () => {
		const { deps, urls } = fakeDeps((_url, init) => (new Headers(init?.headers).get("X-API-Key") === "k-123" ? Response.json({ sandboxes: [] }) : new Response("no", { status: 401 })));
		expect(await checkVmonKey(deps, "k-123")).toBe("good");
		expect(urls).toEqual(["http://127.0.0.1:3000/v2/sandboxes?limit=1"]);
	});

	test("401 is stale", async () => {
		const { deps } = fakeDeps(() => new Response("unauthorized", { status: 401 }));
		expect(await checkVmonKey(deps, "old")).toBe("stale");
	});

	test("anything else and a network error are down", async () => {
		expect(await checkVmonKey(fakeDeps(() => new Response("boom", { status: 500 })).deps, "k")).toBe("down");
		expect(await checkVmonKey(fakeDeps(() => new Response("gone", { status: 404 })).deps, "k")).toBe("down");
		expect(await checkVmonKey(fakeDeps(() => refused()).deps, "k")).toBe("down");
	});

	test("takes another vmon URL, trailing slash or not", async () => {
		const { deps, urls } = fakeDeps(() => new Response("{}"));
		await checkVmonKey(deps, "k", "http://127.0.0.1:3100/");
		expect(urls).toEqual(["http://127.0.0.1:3100/v2/sandboxes?limit=1"]);
	});
});

/** A template that exists after `readyAfter` asks (never: Infinity); asking throws on the first `throwing` asks. */
function fakeProbe(readyAfter: number, throwing = 0): TemplateProbe & { asks: number } {
	const probe = {
		asks: 0,
		name: async () => "omp-agent:18.12.3-abc123def456",
		exists: async (name: string) => {
			probe.asks++;
			expect(name).toBe("omp-agent:18.12.3-abc123def456");
			if (probe.asks <= throwing) throw new Error("vmon is busy");
			return probe.asks > readyAfter;
		},
	};
	return probe;
}

describe("waitTemplate", () => {
	test("ready at once is ok and does not wait", async () => {
		const { deps, sleeps } = fakeDeps(() => refused());
		const lines: string[] = [];
		const step = await waitTemplate(deps, fakeProbe(0), { progress: (line) => lines.push(line), noWait: false });
		expect(step).toEqual({ id: "health.template", status: "ok", detail: "the VM template omp-agent:18.12.3-abc123def456 is ready" });
		expect(sleeps).toEqual([]);
		expect(lines).toEqual([]);
	});

	test("--no-wait skips with the doctor hint, ready or not it never sleeps", async () => {
		const { deps, sleeps } = fakeDeps(() => refused());
		const step = await waitTemplate(deps, fakeProbe(Infinity), { progress: () => {}, noWait: true });
		expect(step).toEqual({
			id: "health.template",
			status: "skipped",
			detail: "building in the background (nested KVM builds are slow); omp-cloud doctor shows when it is ready",
		});
		expect(sleeps).toEqual([]);
		expect((await waitTemplate(deps, fakeProbe(0), { progress: () => {}, noWait: true })).status).toBe("ok");
	});

	test("building, then ready: changed, with a progress line about every 15 s", async () => {
		const { deps } = fakeDeps(() => refused());
		const lines: string[] = [];
		// 1 ask up front, ready on the 41st: 40 polls of 5 s = 200 s.
		const step = await waitTemplate(deps, fakeProbe(40), { progress: (line) => lines.push(line), noWait: false });
		expect(step.status).toBe("changed");
		expect(step.detail).toBe("built the VM template omp-agent:18.12.3-abc123def456 in 3m20s");
		expect(lines[0]).toBe("building the VM template omp-agent:18.12.3-abc123def456 (0m0s)");
		expect(lines[1]).toBe("building the VM template omp-agent:18.12.3-abc123def456 (0m15s)");
		expect(lines[2]).toBe("building the VM template omp-agent:18.12.3-abc123def456 (0m30s)");
		expect(lines).toHaveLength(14);
		expect(lines.at(-1)).toBe("building the VM template omp-agent:18.12.3-abc123def456 (3m15s)");
	});

	test("an error from the probe is not ready yet", async () => {
		const { deps } = fakeDeps(() => refused());
		const step = await waitTemplate(deps, fakeProbe(2, 3), { progress: () => {}, noWait: false });
		expect(step.status).toBe("changed");
	});

	test("times out with the journal as the fix, and says it keeps building", async () => {
		const { deps, clock } = fakeDeps(() => refused());
		const lines: string[] = [];
		const start = clock();
		const step = await waitTemplate(deps, fakeProbe(Infinity), { timeoutMs: 60_000, pollMs: 5000, progress: (line) => lines.push(line), noWait: false });
		expect(step).toEqual({
			id: "health.template",
			status: "failed",
			detail: "the VM template omp-agent:18.12.3-abc123def456 is still building after 1m0s; it keeps building in the background",
			fix: "journalctl --user -u omp-cloud -f",
		});
		expect(clock() - start).toBe(60_000);
		expect(lines).toHaveLength(4);
	});

	test("the default wait is 15 minutes", async () => {
		const { deps, clock } = fakeDeps(() => refused());
		const start = clock();
		const step = await waitTemplate(deps, fakeProbe(Infinity), { progress: () => {}, noWait: false });
		expect(step.status).toBe("failed");
		expect(clock() - start).toBe(15 * 60_000);
	});
});
