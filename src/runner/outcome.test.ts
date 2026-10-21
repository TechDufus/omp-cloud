import { describe, expect, test } from "bun:test";
import { classifyPrompt, errorStatus } from "./outcome";

const end = (stopReason: string, errorMessage = "") => ({ usage: null, stopReason, errorMessage });

describe("classifyPrompt", () => {
	test("a completed prompt completes", () => {
		expect(classifyPrompt({ status: "completed" }, null)).toEqual({ outcome: "completed", error: "" });
	});

	test("an aborted prompt fails", () => {
		expect(classifyPrompt({ status: "aborted" }, null)).toEqual({ outcome: "failed", error: "prompt aborted" });
	});

	test("an error carries omp's message, prefixed when the gateway refused the request", () => {
		expect(classifyPrompt({ status: "error", error: { message: "overloaded", httpStatus: 529 } }, null).error).toBe("overloaded");
		expect(classifyPrompt({ status: "error", error: { message: "bad key", httpStatus: 401 } }, null).error).toBe(
			"the gateway refused the request (401): bad key",
		);
		expect(classifyPrompt({ status: "error", error: { message: "auth-gateway 403: no access" } }, null).error).toBe(
			"the gateway refused the request (403): auth-gateway 403: no access",
		);
		expect(classifyPrompt({ status: "error" }, null).error).toBe("prompt failed");
	});

	test("without a result the last assistant message decides", () => {
		expect(classifyPrompt(undefined, end("stop"))).toEqual({ outcome: "completed", error: "" });
		expect(classifyPrompt(undefined, null)).toEqual({ outcome: "completed", error: "" });
		expect(classifyPrompt(undefined, end("aborted")).error).toBe("prompt aborted");
		expect(classifyPrompt(undefined, end("error", "auth-gateway 401: nope")).error).toBe(
			"the gateway refused the request (401): auth-gateway 401: nope",
		);
		expect(classifyPrompt(undefined, end("error")).error).toBe("prompt failed");
	});
});

describe("errorStatus", () => {
	test("prefers omp's status, then the gateway prefix, else 0", () => {
		expect(errorStatus({ message: "auth-gateway 500: x", httpStatus: 502 })).toBe(502);
		expect(errorStatus({ message: "auth-gateway 429: slow down" })).toBe(429);
		expect(errorStatus({ message: "the auth-gateway 429 later" })).toBe(0);
		expect(errorStatus({})).toBe(0);
	});
});
