import { describe, expect, test } from "bun:test";
import { CloudClient, type ClientTuning, type FetchFn } from "../src/api";
import { CloudError } from "../src/errors";
import type { ScratchHandoffRequest } from "../src/types";
import { detail, question, summary, turn, whoami } from "./builders";

type Step = Response | Error;

interface Call {
	method: string;
	url: string;
	headers: Headers;
	form: FormData | undefined;
	body: string | undefined;
}

/** A transport that plays `steps` in order (the last one repeats) and records every request. */
function scripted(steps: Step[], tuning: ClientTuning = { backoffMs: [1, 1, 1], random: () => 0.5 }): { client: CloudClient; calls: Call[] } {
	const calls: Call[] = [];
	const fetchFn: FetchFn = async (url, init) => {
		calls.push({ method: init?.method ?? "GET", url, headers: new Headers(init?.headers), form: init?.body instanceof FormData ? init.body : undefined, body: typeof init?.body === "string" ? init.body : undefined });
		const step = steps[Math.min(calls.length - 1, steps.length - 1)];
		if (step === undefined) throw new Error("no step");
		if (step instanceof Error) throw step;
		return new Response(step.clone().body, step);
	};
	return { client: new CloudClient("http://cloud.test", "tok", fetchFn, tuning), calls };
}

async function failed(call: Promise<unknown>): Promise<CloudError> {
	const err = await call.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(err instanceof CloudError)) throw new Error(`expected a CloudError, got ${String(err)}`);
	return err;
}

const unavailable = (status = 503): Response => Response.json({ error: "try later" }, { status });
const reset = (): Error => Object.assign(new TypeError("ECONNRESET: closed"), { code: "ECONNRESET" });
const refused = (): Error => Object.assign(new TypeError("ECONNREFUSED: Unable to connect."), { code: "ECONNREFUSED" });

function request(): ScratchHandoffRequest {
	return {
		prompt: "do it",
		model: "",
		thinking: "",
		repo: { scratch: true },
		paths: { home: "/home/ada", workspace: "/home/ada/app" },
		author: { name: "Ada", email: "ada@example.com" },
		secretFiles: [],
		secretEnv: {},
		configOverlays: [],
		ompVersion: "",
	};
}

describe("reads are retried on retriable failures", () => {
	test("a 503 then success: the caller never sees the failure", async () => {
		const { client, calls } = scripted([unavailable(), unavailable(502), Response.json(whoami({ user: "ada" }))]);
		expect((await client.whoami()).user).toBe("ada");
		expect(calls).toHaveLength(3);
	});

	test("a connection refused or reset is retried too", async () => {
		const { client, calls } = scripted([refused(), reset(), Response.json({ threads: [], next: null, total: 0 })]);
		expect((await client.listThreadsPage()).threads).toEqual([]);
		expect(calls).toHaveLength(3);
	});

	test("three retries, then the last error: 4 requests in all", async () => {
		const { client, calls } = scripted([unavailable()]);
		const err = await failed(client.thread("k3x9fa2m7q1z"));
		expect(err).toMatchObject({ code: "unavailable", status: 503, retriable: true });
		expect(calls).toHaveLength(4);
	});

	test.each([400, 401, 403, 404, 409, 413])("a %d is final: one request", async status => {
		const { client, calls } = scripted([Response.json({ error: "no" }, { status })]);
		await failed(client.thread("k3x9fa2m7q1z"));
		expect(calls).toHaveLength(1);
	});

	test("a retriable failure followed by a final one stops at the final one", async () => {
		const { client, calls } = scripted([unavailable(), Response.json({ error: "gone" }, { status: 404 })]);
		expect(await failed(client.thread("k3x9fa2m7q1z"))).toMatchObject({ code: "not_found" });
		expect(calls).toHaveLength(2);
	});

	test("downloads are reads: a 503 is retried", async () => {
		const { client, calls } = scripted([unavailable(), new Response("bytes", { headers: { "X-Omp-Head": "abc" } })]);
		const dest = `${process.env.TMPDIR ?? "/tmp"}/omp-cloud-retry-${crypto.randomUUID()}.bundle`;
		try {
			expect((await client.downloadResult("k3x9fa2m7q1z", dest)).head).toBe("abc");
			expect(await Bun.file(dest).text()).toBe("bytes");
			expect(calls).toHaveLength(2);
		} finally {
			await Bun.file(dest).delete().catch(() => {});
		}
	});
});

describe("writes: which ones are retried", () => {
	test("a plain message is never retried, not even after a 503", async () => {
		const { client, calls } = scripted([unavailable()]);
		await failed(client.sendMessage("k3x9fa2m7q1z", "hi"));
		expect(calls).toHaveLength(1);
	});

	test("an IRC message is repeated with the same id after a 5xx, and answered as the first attempt would be", async () => {
		for (const status of [503, 502]) {
			const { client, calls } = scripted([unavailable(status), Response.json({ receipt: "woken", id: "m-1", turn: null }, { status: 201 })]);
			const sent = await client.irc("k3x9fa2m7q1z", { from: "Main", body: "hi", id: "m-1" });
			expect(sent).toEqual({ receipt: "woken", id: "m-1", turn: null });
			expect(calls).toHaveLength(2);
			expect(calls[0]).toMatchObject({ method: "POST", url: "http://cloud.test/api/v1/threads/k3x9fa2m7q1z/irc" });
			expect(calls.map(c => JSON.parse(c.body ?? "{}").id)).toEqual(["m-1", "m-1"]);
		}
	});

	test("a first attempt that times out or loses its answer is repeated with the same id; a message given no id gets one that every attempt shares", async () => {
		const timedOut = scripted([new DOMException("The operation timed out.", "TimeoutError"), Response.json({ receipt: "injected", id: "m-9", turn: null }, { status: 201 })]);
		expect((await timedOut.client.irc("k3x9fa2m7q1z", { from: "Main", body: "hi", id: "m-9" })).receipt).toBe("injected");
		expect(timedOut.calls).toHaveLength(2);

		const lost = scripted([reset(), refused(), Response.json({ receipt: "woken", id: "x", turn: null }, { status: 201 })]);
		await lost.client.irc("k3x9fa2m7q1z", { from: "Main", body: "hi" });
		const ids = lost.calls.map(c => JSON.parse(c.body ?? "{}").id);
		expect(ids).toHaveLength(3);
		expect(ids[0]).toMatch(/^[a-f0-9]{32}$/);
		expect(new Set(ids).size).toBe(1);
	});

	test("an IRC message that keeps failing is tried on the retry schedule, then fails with its outcome unknown", async () => {
		const dead = scripted([unavailable()]);
		expect(await failed(dead.client.irc("k3x9fa2m7q1z", { from: "Main", body: "hi" }))).toMatchObject({ code: "unavailable", status: 503, outcomeKnown: false });
		expect(dead.calls).toHaveLength(4);

		const lost = scripted([reset()]);
		expect(await failed(lost.client.irc("k3x9fa2m7q1z", { from: "Main", body: "hi" }))).toMatchObject({ outcomeKnown: false });
		expect(lost.calls).toHaveLength(4);
	});

	test("an IRC message with an aborted signal reports a cancelled request; a 4xx is final and known", async () => {
		const aborted = scripted([new DOMException("The operation was aborted.", "AbortError")]);
		expect(await failed(aborted.client.irc("k3x9fa2m7q1z", { from: "Main", body: "x" }, { signal: AbortSignal.abort() }))).toMatchObject({ code: "aborted" });

		for (const status of [400, 404, 409, 413]) {
			const final = scripted([Response.json({ error: "no" }, { status }), Response.json({ receipt: "woken", id: "m", turn: null }, { status: 201 })]);
			expect(await failed(final.client.irc("k3x9fa2m7q1z", { from: "Main", body: "x" }))).toMatchObject({ status, outcomeKnown: true });
			expect(final.calls).toHaveLength(1);
		}
	});

	test("stop, answer and delete are retried", async () => {
		const stop = scripted([unavailable(), Response.json({ stoppedRunning: true, cancelled: 0 })]);
		expect((await stop.client.stop("k3x9fa2m7q1z")).stoppedRunning).toBe(true);
		expect(stop.calls).toHaveLength(2);

		const answer = scripted([reset(), Response.json({ id: 1 })]);
		await answer.client.answer("k3x9fa2m7q1z", 1, 1, { answer: "x" });
		expect(answer.calls).toHaveLength(2);

		const del = scripted([unavailable(), Response.json({ status: "deleting" }, { status: 202 })]);
		await del.client.deleteThread("k3x9fa2m7q1z");
		expect(del.calls.map(c => c.method)).toEqual(["DELETE", "DELETE"]);
	});

	test("a pairing approval is a plain POST: not retried", async () => {
		const { client, calls } = scripted([unavailable()]);
		await failed(client.approvePairing("offer1"));
		expect(calls).toHaveLength(1);
	});

	test("a create with an Idempotency-Key is retried, re-sending the whole upload with the same key; the replay is reported", async () => {
		const { client, calls } = scripted([reset(), Response.json({ error: "a request with this Idempotency-Key is still in progress" }, { status: 409 }), Response.json({ ...summary({ id: "newthread123" }), replayed: true }, { status: 200 })]);
		const notes: string[] = [];
		const created = await client.createThread({ request: request() }, { idempotencyKey: "job.42", onProgress: n => notes.push(n) });
		expect(created.replayed).toBe(true);
		expect(created.summary.id).toBe("newthread123");
		expect(calls).toHaveLength(3);
		expect(calls.map(c => c.headers.get("Idempotency-Key"))).toEqual(["job.42", "job.42", "job.42"]);
		for (const c of calls) expect(await (c.form?.get("request") as File).text()).toContain('"prompt":"do it"');
		expect(notes).toHaveLength(2);
		expect(notes[0]).toContain("lost the connection");
		expect(notes[1]).toContain("Idempotency-Key is still in progress");
	});

	test("a create without a key is sent once and sends no Idempotency-Key header", async () => {
		const { client, calls } = scripted([unavailable()]);
		await failed(client.createThread({ request: request() }));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.has("Idempotency-Key")).toBe(false);
	});

	test("a fresh keyed create is 201 and not replayed", async () => {
		const { client } = scripted([Response.json(summary(), { status: 201 })]);
		expect((await client.createThread({ request: request() }, { idempotencyKey: "k" })).replayed).toBe(false);
	});

	test("a keyed create rejected for good (400) is not retried", async () => {
		const { client, calls } = scripted([Response.json({ error: "ref must match [A-Za-z0-9._-]{1,64}" }, { status: 400 })]);
		expect(await failed(client.createThread({ request: request() }, { idempotencyKey: "k" }))).toMatchObject({ code: "invalid" });
		expect(calls).toHaveLength(1);
	});

	test("a key reused for a different request is a final conflict naming the earlier thread: nothing was created, it is not retried", async () => {
		const { client, calls } = scripted([Response.json({ error: "Idempotency-Key fix.1 was used for a different request (thread k3x9fa2m7q1z)" }, { status: 409 })]);
		const err = await failed(client.createThread({ request: request() }, { idempotencyKey: "fix.1" }));
		expect(err).toMatchObject({ code: "conflict", status: 409, retriable: false, outcomeKnown: true, threadId: "k3x9fa2m7q1z" });
		expect(err.hint).toContain("new one");
		expect(calls).toHaveLength(1);
	});

	test("the in-progress 409 is the retriable one and names no thread", async () => {
		const { client, calls } = scripted([Response.json({ error: "a request with this Idempotency-Key is still in progress" }, { status: 409 }), Response.json({ ...summary({ id: "newthread123" }), replayed: true })]);
		const created = await client.createThread({ request: request() }, { idempotencyKey: "fix.1" });
		expect(created.replayed).toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("a keyed create refused after an attempt that may have been delivered says the thread may exist", async () => {
		const { client, calls } = scripted([reset(), refused(), refused(), refused()]);
		const err = await failed(client.createThread({ request: request() }, { idempotencyKey: "k" }));
		expect(err).toMatchObject({ code: "unreachable", outcomeKnown: false });
		expect(calls).toHaveLength(4);
	});

	test("a keyed create that never got past a refused connection knows nothing was created", async () => {
		const { client } = scripted([refused()]);
		expect(await failed(client.createThread({ request: request() }, { idempotencyKey: "k" }))).toMatchObject({ code: "unreachable", outcomeKnown: true });
	});

	test("a keyed create stuck behind its own in-progress 409 says the thread may exist", async () => {
		const { client } = scripted([Response.json({ error: "a request with this Idempotency-Key is still in progress" }, { status: 409 })]);
		expect(await failed(client.createThread({ request: request() }, { idempotencyKey: "k" }))).toMatchObject({ code: "conflict", retriable: true, outcomeKnown: false });
	});

	test("a read that is retried keeps its outcome known: reading twice is harmless", async () => {
		const { client } = scripted([reset(), refused(), refused(), refused()]);
		expect(await failed(client.thread("k3x9fa2m7q1z"))).toMatchObject({ outcomeKnown: true });
	});
});

describe("a retry that finds the first attempt worked", () => {
	const notWaiting = (): Response => Response.json({ error: "question is not waiting for an answer" }, { status: 409 });
	const answered = (answer: string, selected: string[] = []): Response =>
		Response.json(detail({ turns: [turn(3, { questions: [question({ id: 9, answer, selected, answeredAt: "2026-01-01T00:02:00Z", answeredBy: "ada" })] })] }));

	test("a delete retried after a lost response succeeds when the thread is already gone", async () => {
		const { client, calls } = scripted([reset(), Response.json({ error: "no such thread" }, { status: 404 })]);
		await client.deleteThread("k3x9fa2m7q1z");
		expect(calls.map(c => c.method)).toEqual(["DELETE", "DELETE"]);
	});

	test("a delete of a thread that was never there is still not_found", async () => {
		const { client, calls } = scripted([Response.json({ error: "no such thread" }, { status: 404 })]);
		expect(await failed(client.deleteThread("k3x9fa2m7q1z"))).toMatchObject({ code: "not_found" });
		expect(calls).toHaveLength(1);
	});

	test("an answer retried after a lost response succeeds when the question now holds this answer", async () => {
		const { client, calls } = scripted([reset(), notWaiting(), answered("use the second")]);
		const q = await client.answer("k3x9fa2m7q1z", 3, 9, { answer: "use the second" });
		expect(q).toMatchObject({ id: 9, answer: "use the second", answeredBy: "ada" });
		expect(calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"POST /api/v1/threads/k3x9fa2m7q1z/turns/3/questions/9/answer",
			"POST /api/v1/threads/k3x9fa2m7q1z/turns/3/questions/9/answer",
			"GET /api/v1/threads/k3x9fa2m7q1z",
		]);
	});

	test("selected options are compared as a set", async () => {
		const { client } = scripted([reset(), notWaiting(), answered("", ["b", "a"])]);
		expect((await client.answer("k3x9fa2m7q1z", 3, 9, { selected: ["a", "b"] })).selected).toEqual(["b", "a"]);
	});

	test("a question answered with something else stands as the 409", async () => {
		const { client } = scripted([reset(), notWaiting(), answered("someone else's answer")]);
		expect(await failed(client.answer("k3x9fa2m7q1z", 3, 9, { answer: "mine" }))).toMatchObject({ code: "conflict", status: 409, message: "question is not waiting for an answer" });
	});

	test("a 409 with no lost attempt before it is never second-guessed", async () => {
		const { client, calls } = scripted([notWaiting()]);
		expect(await failed(client.answer("k3x9fa2m7q1z", 3, 9, { answer: "x" }))).toMatchObject({ code: "conflict", outcomeKnown: true });
		expect(calls).toHaveLength(1);
	});

	test("when the question cannot be read back the 409 stands", async () => {
		const { client } = scripted([reset(), notWaiting(), Response.json({ error: "gone" }, { status: 404 })]);
		expect(await failed(client.answer("k3x9fa2m7q1z", 3, 9, { answer: "x" }))).toMatchObject({ code: "conflict", status: 409 });
	});
});

describe("waiting between attempts", () => {
	test("Retry-After is honoured: the next attempt comes no sooner", async () => {
		const { client, calls } = scripted([Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": "1" } }), Response.json(whoami())]);
		const started = Date.now();
		await client.whoami();
		expect(Date.now() - started).toBeGreaterThanOrEqual(950);
		expect(calls).toHaveLength(2);
	});

	test("a Retry-After beyond 30 s is not waited for: the error carries it", async () => {
		const { client, calls } = scripted([Response.json({ error: "too many attempts" }, { status: 429, headers: { "Retry-After": "120" } })]);
		const err = await failed(client.whoami());
		expect(err).toMatchObject({ code: "rate_limited", retryAfterSec: 120, retriable: true });
		expect(calls).toHaveLength(1);
	});

	test("a Retry-After given as an HTTP date is understood", async () => {
		const soon = new Date(Date.now() + 120_000).toUTCString();
		const { client } = scripted([Response.json({ error: "x" }, { status: 503, headers: { "Retry-After": soon } })]);
		expect((await failed(client.whoami())).retryAfterSec).toBeGreaterThan(100);
	});

	test("backoff grows and carries jitter within a quarter of the base", async () => {
		const low = scripted([unavailable()], { backoffMs: [100, 200, 400], random: () => 0 });
		const notes: string[] = [];
		const started = Date.now();
		await failed(low.client.createThread({ request: request() }, { idempotencyKey: "k", onProgress: n => notes.push(n) }));
		const elapsed = Date.now() - started;
		// 0.75 x (100 + 200 + 400) = 525 ms at least; the notes name each wait.
		expect(elapsed).toBeGreaterThanOrEqual(500);
		expect(notes.map(n => /retrying in ([\d.]+)s/.exec(n)?.[1])).toEqual(["0.1", "0.2", "0.3"]);
		expect(notes.map(n => /attempt (\d) of (\d)/.exec(n)?.slice(1).join("/"))).toEqual(["2/4", "3/4", "4/4"]);
	});

	test("the first wait of the default schedule is about half a second", async () => {
		const { client } = scripted([unavailable()], {});
		const ctrl = new AbortController();
		const notes: string[] = [];
		const err = await failed(
			client.createThread(
				{ request: request() },
				{
					idempotencyKey: "k",
					signal: ctrl.signal,
					onProgress: n => {
						notes.push(n);
						ctrl.abort();
					},
				},
			),
		);
		expect(err.code).toBe("aborted");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/retrying in 0\.[3-6]\d?s \(attempt 2 of 4\)/);
	});

	test("an abort during the wait ends the call at once and no further request is made", async () => {
		const { client, calls } = scripted([unavailable()], { backoffMs: [60_000, 60_000, 60_000] });
		const ctrl = new AbortController();
		const { promise: waiting, resolve } = Promise.withResolvers<void>();
		const pending = failed(client.createThread({ request: request() }, { idempotencyKey: "k", signal: ctrl.signal, onProgress: () => resolve() }));
		await waiting;
		ctrl.abort();
		const err = await pending;
		expect(err.code).toBe("aborted");
		expect(calls).toHaveLength(1);
	});

	test("a message sent with an aborted signal reports a cancelled request, outcome unknown", async () => {
		const { client } = scripted([new DOMException("The operation was aborted.", "AbortError")]);
		const err = await failed(client.sendMessage("k3x9fa2m7q1z", "x", { signal: AbortSignal.abort() }));
		expect(err).toMatchObject({ code: "aborted", outcomeKnown: false });
	});
});

test("an interrupting send is never retried either: a 503 is one request, a lost answer is ambiguous", async () => {
	const down = scripted([Response.json({ error: "try later" }, { status: 503 })]);
	await failed(down.client.sendMessage("k3x9fa2m7q1z", "x", { mode: "interrupt" }));
	expect(down.calls).toHaveLength(1);
	const lost = scripted([Object.assign(new TypeError("ECONNRESET: closed"), { code: "ECONNRESET" })]);
	expect(await failed(lost.client.sendMessage("k3x9fa2m7q1z", "x", { mode: "interrupt" }))).toMatchObject({ code: "ambiguous_outcome", outcomeKnown: false });
	expect(lost.calls).toHaveLength(1);
});

test("sendMessage answers 201 with the queued turn", async () => {
	const { client } = scripted([Response.json({ turn: turn(2), interrupted: false }, { status: 201 })]);
	expect((await client.sendMessage("k3x9fa2m7q1z", "x")).turn.id).toBe(2);
});
