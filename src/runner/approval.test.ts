import { describe, expect, test } from "bun:test";
import { MAX_QUESTION_KEY_BYTES, MAX_QUESTION_TEXT_BYTES } from "../store/types";
import { APPROVAL_OMP_KEY } from "./ask";
import { abortAfterDenying, approvalInput, approvalTimeoutAnswer, parseApprovalRequest, PendingApprovals } from "./approval";

/** The frame omp 18.12.3 sent for a bash `prompt` rule, as observed. */
const FRAME = {
	type: "extension_ui_request",
	id: "15ad39c0780a899f",
	method: "select",
	title: "Allow tool: bash\nReason: Prompt required by bash pattern: touch /tmp/x*\nCommand: touch /tmp/xprobe-approve",
	options: ["Approve", "Deny"],
};

describe("parseApprovalRequest", () => {
	test("reads the observed approval frame", () => {
		expect(parseApprovalRequest(FRAME)).toEqual({ id: "15ad39c0780a899f", tool: "bash", title: FRAME.title });
	});

	test("a user-policy prompt has no Reason line", () => {
		const frame = { ...FRAME, title: "Allow tool: bash\nCommand: echo hi" };
		expect(parseApprovalRequest(frame)?.tool).toBe("bash");
	});

	test("a title with the tool alone is an approval", () => {
		expect(parseApprovalRequest({ ...FRAME, title: "Allow tool: write" })?.tool).toBe("write");
	});

	test("any other select is not an approval", () => {
		expect(parseApprovalRequest({ ...FRAME, title: "Pick a color" })).toBeNull();
		expect(parseApprovalRequest({ ...FRAME, title: "allow tool: bash" })).toBeNull();
		expect(parseApprovalRequest({ ...FRAME, title: "Allow tool: " })).toBeNull();
		expect(parseApprovalRequest({ ...FRAME, title: "Allow tool: \nCommand: x" })).toBeNull();
		expect(parseApprovalRequest({ ...FRAME, title: undefined })).toBeNull();
	});

	test("the options must be exactly Approve and Deny, in that order", () => {
		for (const options of [["Approve"], ["Deny", "Approve"], ["Approve", "Deny", "Approve bash for this session"], ["approve", "deny"], "Approve", undefined, []]) {
			expect(parseApprovalRequest({ ...FRAME, options })).toBeNull();
		}
	});

	test("only select frames with a string id count", () => {
		for (const method of ["confirm", "input", "editor", "ask", "notify", undefined]) {
			expect(parseApprovalRequest({ ...FRAME, method })).toBeNull();
		}
		expect(parseApprovalRequest({ ...FRAME, id: 7 })).toBeNull();
		expect(parseApprovalRequest({ ...FRAME, id: undefined })).toBeNull();
	});
});

describe("approvalInput", () => {
	const request = { id: "f1", tool: "bash", title: FRAME.title };

	test("is the question the owner sees: Deny recommended, tagged as an approval", () => {
		expect(approvalInput(request)).toEqual({
			key: "approval:bash",
			text: FRAME.title,
			header: "Approval",
			options: [
				{ label: "Approve", description: "run this tool call" },
				{ label: "Deny", description: "block it" },
			],
			multi: false,
			recommended: 1,
			ompKey: APPROVAL_OMP_KEY,
			ompLabels: ["Approve", "Deny"],
		});
	});

	test("cuts a long title to the store's text limit and a long tool name to its key limit, on character boundaries", () => {
		const title = `Allow tool: bash\nCommand: ${"é".repeat(5000)}`;
		const input = approvalInput({ id: "f1", tool: "t".repeat(300), title });
		expect(Buffer.byteLength(input.text)).toBeLessThanOrEqual(MAX_QUESTION_TEXT_BYTES);
		expect(input.text.startsWith("Allow tool: bash\nCommand: é")).toBe(true);
		expect(input.text).not.toContain("\ufffd");
		expect(Buffer.byteLength(input.key)).toBeLessThanOrEqual(MAX_QUESTION_KEY_BYTES);
		expect(input.key.startsWith("approval:ttt")).toBe(true);
	});
});

describe("approvalTimeoutAnswer", () => {
	test.each([
		[1800, "Denied: no answer within 30m."],
		[5400, "Denied: no answer within 1h30m."],
		[45, "Denied: no answer within 45s."],
	])("%p seconds", (seconds, text) => {
		expect(approvalTimeoutAnswer(seconds)).toBe(text);
	});
});

describe("abortAfterDenying", () => {
	test("answers the approvals before the abort is sent", async () => {
		const calls: string[] = [];
		await abortAfterDenying(
			() => void calls.push("deny"),
			async () => void calls.push("abort"),
		);
		expect(calls).toEqual(["deny", "abort"]);
	});

	test("never waits for the abort before the approvals are answered: the deny has run when the abort starts", async () => {
		let denied = false;
		let deniedWhenAborted: boolean | undefined;
		let release: () => void = () => {};
		const aborting = abortAfterDenying(
			() => {
				denied = true;
			},
			() =>
				new Promise<void>(resolve => {
					deniedWhenAborted = denied;
					release = resolve;
				}),
		);
		// The abort is pending (omp's real one hangs until approvals are answered), yet the deny already ran.
		expect(deniedWhenAborted).toBe(true);
		release();
		await aborting;
	});

	test("a failing abort still happens after the deny, and its error reaches the caller", async () => {
		const calls: string[] = [];
		const result = abortAfterDenying(
			() => void calls.push("deny"),
			async () => {
				calls.push("abort");
				throw new Error("omp is gone");
			},
		);
		await expect(result).rejects.toThrow("omp is gone");
		expect(calls).toEqual(["deny", "abort"]);
	});
});

describe("PendingApprovals", () => {
	test("drain returns every unanswered id in arrival order and empties the set", () => {
		const pending = new PendingApprovals();
		pending.add("a");
		pending.add("b");
		pending.add("c");
		pending.settle("b");
		expect(pending.size).toBe(2);
		expect(pending.drain()).toEqual(["a", "c"]);
		expect(pending.size).toBe(0);
		expect(pending.drain()).toEqual([]);
	});

	test("an id added twice is one, and settling an unknown id does nothing", () => {
		const pending = new PendingApprovals();
		pending.add("a");
		pending.add("a");
		pending.settle("zzz");
		expect(pending.drain()).toEqual(["a"]);
	});

	test("clear forgets everything: a new omp process knows none of them", () => {
		const pending = new PendingApprovals();
		pending.add("a");
		pending.clear();
		expect(pending.drain()).toEqual([]);
	});

	test("ids survive across a requeue: nothing but settle, drain and clear removes them", () => {
		const pending = new PendingApprovals();
		pending.add("a");
		// A requeue forgets the turn's questions and asks; the tracker is not told.
		expect(pending.size).toBe(1);
		const denied: string[] = [];
		for (const id of pending.drain()) denied.push(id);
		expect(denied).toEqual(["a"]);
	});
});
