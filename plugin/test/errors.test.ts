import { describe, expect, test } from "bun:test";
import { CloudClient, type FetchFn } from "../src/api";
import { CloudError, cloudErrorFromStatus, cloudErrorText, toCloudError, type CloudErrorCode } from "../src/errors";
import type { ScratchHandoffRequest } from "../src/types";

/** What a runtime or a person must never read in an error message. */
const BOILERPLATE = ["TypeError", "CloudError", "ApiError", "ECONN", "ENOTFOUND", "EPROTO", "verbose", "☁", "Is the computer able"];

function expectPlain(message: string): void {
	for (const word of BOILERPLATE) expect(message).not.toContain(word);
}

async function failed(call: Promise<unknown>): Promise<CloudError> {
	const err = await call.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(err instanceof CloudError)) throw new Error(`expected a CloudError, got ${String(err)}`);
	return err;
}

/** A client whose transport throws `failure` on every request. */
function throwing(failure: unknown, requests: { count: number } = { count: 0 }): CloudClient {
	const fetchFn: FetchFn = async () => {
		requests.count++;
		throw failure;
	};
	return new CloudClient("http://cloud.test", "tok", fetchFn, { backoffMs: [1, 1, 1], random: () => 0.5 });
}

function networkError(code: string, message: string): Error {
	return Object.assign(new TypeError(message), { code });
}

describe("status codes", () => {
	const table: [number, string, CloudErrorCode, boolean][] = [
		[400, "name must be 1-64 characters", "invalid", false],
		[401, "unauthorized", "unauthorized", false],
		[403, "owner only", "forbidden", false],
		[404, "no such thread", "not_found", false],
		[408, "request timeout", "timeout", true],
		[409, "thread has failed; start a new one", "conflict", false],
		[409, "a request with this Idempotency-Key is still in progress", "conflict", true],
		[413, "request body is too large", "too_large", false],
		[429, "too many attempts; try again later", "rate_limited", true],
		[500, "internal error", "unavailable", true],
		[502, "502 Bad Gateway", "unavailable", true],
		[503, "503 Service Unavailable", "unavailable", true],
		[507, "insufficient storage on the service data volume", "capacity", false],
		[409, "Idempotency-Key fix.1 was used for a different request (thread k3x9fa2m7q1z)", "conflict", false],
		[418, "teapot", "invalid", false],
	];

	test.each(table)("%d %s is %s (retriable: %p), with the service's own message", (status, message, code, retriable) => {
		const error = cloudErrorFromStatus(status, message);
		expect(error).toMatchObject({ code, status, message, retriable, outcomeKnown: true });
		expect(error).toBeInstanceOf(Error);
	});

	test("a 401 tells a revoked device to connect again and the owner to check the token", () => {
		const error = cloudErrorFromStatus(401, "unauthorized");
		expect(error.hint).toContain("/cloud connect");
		expect(error.hint).toContain("token");
		expect(cloudErrorText(error)).toBe(`unauthorized — ${error.hint}`);
	});

	test("a 429 carries the seconds the service asked to wait", () => {
		expect(cloudErrorFromStatus(429, "slow down", 12).retryAfterSec).toBe(12);
		expect(cloudErrorFromStatus(429, "slow down").retryAfterSec).toBeUndefined();
	});

	test("an error without a hint is its message alone", () => {
		expect(cloudErrorText(cloudErrorFromStatus(404, "no such thread"))).toBe("no such thread");
	});
});

describe("what a failed request looks like to the caller", () => {
	test("a refused connection is unreachable and retriable, named plainly", async () => {
		const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
		const url = `http://127.0.0.1:${dead.port}`;
		await dead.stop(true);
		const err = await failed(new CloudClient(url, "tok", undefined, { backoffMs: [] }).whoami());
		expect(err).toMatchObject({ code: "unreachable", retriable: true, outcomeKnown: true, message: `cannot reach ${url}: connection refused` });
		expectPlain(err.message);
	});

	test("an unknown host name is unreachable", async () => {
		const err = await failed(new CloudClient("http://no-such-host.invalid", "tok", undefined, { backoffMs: [] }).whoami());
		expect(err).toMatchObject({ code: "unreachable", retriable: true, outcomeKnown: true });
		expect(err.message).toMatch(/^cannot reach http:\/\/no-such-host\.invalid: host name (not found|lookup failed)$/);
	});

	test("a plain-HTTP port spoken to over TLS is unreachable, not a mystery", async () => {
		const http = Bun.serve({ port: 0, fetch: () => new Response("x") });
		try {
			const err = await failed(new CloudClient(`https://127.0.0.1:${http.port}`, "tok", undefined, { backoffMs: [] }).whoami());
			expect(err.code).toBe("unreachable");
			expectPlain(err.message);
		} finally {
			await http.stop(true);
		}
	});

	test("a pinned-certificate refusal is unreachable and never retried", () => {
		const raw = new Error("ECONNREFUSED: Unable to connect. Is the computer able to access the url? (the server does not present the pinned certificate SHA256:ab; if it was reinstalled, pair again with /cloud connect --replace)");
		const error = toCloudError(raw, { repeatable: true, target: "https://10.0.0.5:8443" });
		expect(error).toMatchObject({ code: "unreachable", retriable: false, outcomeKnown: true });
		expect(error.message).toContain("pinned certificate SHA256:ab");
		expect(error.message.startsWith("cannot reach https://10.0.0.5:8443:")).toBe(true);
		expectPlain(error.message);
	});

	test("a redirect is refused with advice about the configured url", () => {
		const error = toCloudError(networkError("UnexpectedRedirect", 'UnexpectedRedirect fetching "http://x/". For more information, pass `verbose: true`'), { repeatable: true, target: "http://x" });
		expect(error).toMatchObject({ code: "unreachable", retriable: false });
		expectPlain(error.message);
	});

	test("a timeout of a read is retriable and its outcome known", () => {
		const error = toCloudError(new DOMException("The operation timed out.", "TimeoutError"), { repeatable: true, target: "http://cloud.test" });
		expect(error).toMatchObject({ code: "timeout", retriable: true, outcomeKnown: true });
		expectPlain(error.message);
	});

	test("a timeout of a message says it may have been received and is neither retried nor known", () => {
		const error = toCloudError(new DOMException("The operation timed out.", "TimeoutError"), { repeatable: false, target: "http://cloud.test" });
		expect(error).toMatchObject({ code: "timeout", retriable: false, outcomeKnown: false });
		expect(error.message).toContain("may have been received");
	});

	test("the caller's abort is `aborted`, whatever reason it gave", async () => {
		const ctrl = new AbortController();
		const fetchFn: FetchFn = (_url, init) =>
			new Promise((_, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("custom reason")), { once: true });
			});
		const client = new CloudClient("http://cloud.test", "tok", fetchFn, { backoffMs: [1, 1, 1] });
		const pending = failed(client.whoami({ signal: ctrl.signal }));
		ctrl.abort(new Error("custom reason"));
		expect(await pending).toMatchObject({ code: "aborted", retriable: false });
	});

	test("an already aborted signal never reaches the network", async () => {
		const requests = { count: 0 };
		const client = throwing(new Error("must not be called"), requests);
		const err = await failed(client.whoami({ signal: AbortSignal.abort() }));
		expect(err.code).toBe("aborted");
		expect(requests.count).toBeLessThanOrEqual(1);
	});

	test("a CloudError passes through unchanged and a non-Error is wrapped", () => {
		const own = cloudErrorFromStatus(404, "x");
		expect(toCloudError(own)).toBe(own);
		const wrapped = toCloudError("boom");
		expect(wrapped).toBeInstanceOf(CloudError);
		expect(wrapped.message).toContain("boom");
	});

	test("an answer that is not the expected JSON is unavailable, with no class name", async () => {
		const client = new CloudClient("http://cloud.test", "tok", async () => Response.json(["not", "an", "object"]));
		const err = await failed(client.whoami());
		expect(err.code).toBe("unavailable");
		expect(err.message).toContain("not a JSON object");
		expectPlain(err.message);
	});
});

describe("a response lost in flight", () => {
	test("a message whose connection drops is ambiguous_outcome, sent once", async () => {
		const requests = { count: 0 };
		const err = await failed(throwing(networkError("ECONNRESET", "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true`"), requests).sendMessage("k3x9fa2m7q1z", "hi"));
		expect(err).toMatchObject({ code: "ambiguous_outcome", retriable: false, outcomeKnown: false });
		expect(err.hint).toBeDefined();
		expectPlain(err.message);
		expect(requests.count).toBe(1);
	});

	test("the same on a real socket that hangs up after reading the request", async () => {
		const received: Buffer[] = [];
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					received.push(Buffer.from(data));
					socket.terminate();
				},
			},
		});
		try {
			const client = new CloudClient(`http://127.0.0.1:${listener.port}`, "tok", undefined, { backoffMs: [1, 1, 1] });
			const err = await failed(client.sendMessage("k3x9fa2m7q1z", "do not send twice"));
			expect(err).toMatchObject({ code: "ambiguous_outcome", outcomeKnown: false });
			expect(received.length).toBeGreaterThanOrEqual(1);
		} finally {
			listener.stop(true);
		}
	});

	test("a lost read is unreachable and its outcome known: reading twice is harmless", () => {
		const error = toCloudError(networkError("ECONNRESET", "ECONNRESET: closed"), { repeatable: true, target: "http://cloud.test" });
		expect(error).toMatchObject({ code: "unreachable", retriable: true, outcomeKnown: true });
	});

	test("a keyed create whose attempts were all lost says the thread may exist: asking again with the key replays", async () => {
		const requests = { count: 0 };
		const err = await failed(throwing(networkError("ECONNRESET", "ECONNRESET: closed"), requests).createThread({ request: createRequest() }, { idempotencyKey: "k1" }));
		expect(err).toMatchObject({ code: "unreachable", outcomeKnown: false });
		expect(requests.count).toBe(4);
	});

	test("a create without a key that loses its response is ambiguous_outcome and sent once", async () => {
		const requests = { count: 0 };
		const err = await failed(throwing(networkError("ECONNRESET", "ECONNRESET: closed"), requests).createThread({ request: createRequest() }));
		expect(err).toMatchObject({ code: "ambiguous_outcome", outcomeKnown: false });
		expect(requests.count).toBe(1);
	});
});

function createRequest(): ScratchHandoffRequest {
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
