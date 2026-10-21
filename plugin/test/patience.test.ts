import { afterEach, describe, expect, test } from "bun:test";
import { CloudClient, quickTuning, type ClientTuning, type FetchFn } from "../src/api";
import { run } from "../src/exec";
import { Cloud } from "../src/verbs";
import { cloudEnv, fakeHost, fakePi, type FakeHost } from "./fakes";
import { cleanup, FAST_RETRY, tmp } from "./helpers";

afterEach(cleanup);

/** A listener that hangs up on every connection: a service that is dead in a way that is worth retrying. Counts the connections. */
function hangingUp(): { url: string; connections: () => number; stop: () => void } {
	let count = 0;
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				count++;
				socket.terminate();
			},
			data() {},
		},
	});
	return { url: `http://127.0.0.1:${listener.port}`, connections: () => count, stop: () => listener.stop(true) };
}

async function rig(url: string, tuning?: ClientTuning): Promise<{ cloud: Cloud; host: FakeHost }> {
	const env = await cloudEnv(`url: ${url}\ntoken: tok\n`);
	const repo = await tmp("omp-cloud-repo-");
	await run("git", ["init", "-q"], { cwd: repo });
	const host = fakeHost({ cwd: repo });
	return { cloud: new Cloud(fakePi().pi, "/own", env, await tmp("omp-cloud-home-"), undefined, undefined, tuning), host };
}

describe("a dead service is reported at once to a person, and retried fully for the model", () => {
	test("/cloud status with the production schedule says the service is unreachable within 1.5 s, after one retry", async () => {
		const dead = hangingUp();
		try {
			const { cloud, host } = await rig(dead.url);
			const started = Date.now();
			await cloud.handle("status", { ...host.host, switchSession: async () => ({ cancelled: false }) });
			expect(Date.now() - started).toBeLessThan(1500);
			expect(dead.connections()).toBe(2);
			expect(host.notes).toHaveLength(1);
			expect(host.notes[0]?.[1]).toBe("error");
			expect(host.notes[0]?.[0]).toContain("lost the connection to");
		} finally {
			dead.stop();
		}
	});

	test("/cloud list is quick too, while the tool's client keeps all three retries", async () => {
		const dead = hangingUp();
		try {
			const { cloud, host } = await rig(dead.url, FAST_RETRY);
			await cloud.handle("list", { ...host.host, switchSession: async () => ({ cancelled: false }) });
			expect(dead.connections()).toBe(2);
			expect(host.notes.at(-1)?.[1]).toBe("error");

			const { client } = await cloud.toolSession(host.host);
			await expect(client.whoami()).rejects.toMatchObject({ code: "unreachable" });
			expect(dead.connections()).toBe(2 + 4);
		} finally {
			dead.stop();
		}
	});

	test("the model's resolve keeps the full schedule", async () => {
		const dead = hangingUp();
		try {
			const { cloud, host } = await rig(dead.url, FAST_RETRY);
			await expect(cloud.resolve(host.host, "k3x9fa2m7q1z")).rejects.toMatchObject({ code: "unreachable" });
			expect(dead.connections()).toBe(4);
		} finally {
			dead.stop();
		}
	});
});

describe("quickTuning", () => {
	test("is one retry after 250 ms and a Retry-After of at most 1 s, on the production schedule", () => {
		expect(quickTuning()).toEqual({ backoffMs: [250], maxRetryAfterSec: 1 });
	});

	test("never lengthens a schedule that is already shorter, and keeps the base's jitter", () => {
		const random = (): number => 0.5;
		expect(quickTuning({ backoffMs: [1, 1, 1], random })).toEqual({ backoffMs: [1], random, maxRetryAfterSec: 1 });
		expect(quickTuning({ backoffMs: [] })).toEqual({ backoffMs: [], maxRetryAfterSec: 1 });
	});

	test("a Retry-After above 1 s is not waited for by a quick client", async () => {
		let calls = 0;
		const fetchFn: FetchFn = async () => {
			calls++;
			return Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": "2" } });
		};
		const quick = new CloudClient("http://cloud.test", "tok", fetchFn, quickTuning({ backoffMs: [1, 1, 1], random: () => 0.5 }));
		await expect(quick.whoami()).rejects.toMatchObject({ code: "rate_limited", retryAfterSec: 2 });
		expect(calls).toBe(1);
	});
});
