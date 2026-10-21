import { describe, expect, test } from "bun:test";
import type { Question } from "../store/types";
import {
	answersResponse,
	APPROVAL_OMP_KEY,
	approvalReply,
	cutBytes,
	expiredAnswer,
	isApproval,
	type OmpQuestion,
	parseAskRequest,
	stoppedByUser,
	toQuestionInputs,
} from "./ask";

function ompQuestion(overrides: Partial<OmpQuestion> & { id: string }): OmpQuestion {
	return { question: "?", header: "", options: [], multi: false, recommended: null, ...overrides };
}

function stored(overrides: Partial<Question>): Question {
	return {
		id: 1,
		ask: 1,
		key: "k",
		text: "?",
		header: "",
		options: [],
		multi: false,
		recommended: null,
		askedAt: "2026-01-01T00:00:00.000Z",
		selected: [],
		answer: "",
		answeredBy: "",
		answeredAt: null,
		expired: false,
		requestId: null,
		ompKey: "k",
		ompLabels: [],
		...overrides,
	};
}

describe("parseAskRequest", () => {
	test("reads questions with object or string options and optional fields", () => {
		const request = parseAskRequest({
			type: "extension_ui_request",
			id: "ui1",
			method: "ask",
			questions: [
				{ id: "a", question: "Pick", header: "H", options: [{ label: "x", description: "d" }, "y"], multi: true, recommended: 1 },
				{ id: "b", question: "Free" },
			],
		});
		expect(request).toEqual({
			id: "ui1",
			questions: [
				{
					id: "a",
					question: "Pick",
					header: "H",
					options: [
						{ label: "x", description: "d" },
						{ label: "y", description: "" },
					],
					multi: true,
					recommended: 1,
				},
				{ id: "b", question: "Free", header: "", options: [], multi: false, recommended: null },
			],
		});
	});

	test("is null for other methods and malformed frames", () => {
		expect(parseAskRequest({ id: "u", method: "select", questions: [] })).toBeNull();
		expect(parseAskRequest({ method: "ask", questions: [] })).toBeNull();
		expect(parseAskRequest({ id: "u", method: "ask" })).toBeNull();
	});
});

describe("toQuestionInputs", () => {
	test("cuts to the store's limits, skips duplicate and empty labels, caps the options and re-indexes the recommendation", () => {
		const long = "é".repeat(3000);
		const options = [{ label: "use é", description: "" }, { label: "use é", description: "" }, { label: "", description: "" }, { label: "plain", description: "" }];
		for (let i = 0; i < 25; i++) options.push({ label: `extra ${i}`, description: "" });
		const [q] = toQuestionInputs([
			ompQuestion({ id: "q".repeat(300), question: `token? ${long}`, header: "h".repeat(300), options, recommended: 3 }),
		]);
		expect(Buffer.byteLength(q?.key ?? "")).toBeLessThanOrEqual(200);
		expect(Buffer.byteLength(q?.text ?? "")).toBeLessThanOrEqual(4000);
		expect(q?.text.startsWith("token? é")).toBe(true);
		expect(Buffer.byteLength(q?.header ?? "")).toBeLessThanOrEqual(200);
		expect(q?.options).toHaveLength(20);
		expect(q?.options.slice(0, 2).map(o => o.label)).toEqual(["use é", "plain"]);
		// omp's recommended option is its fourth, the second one kept
		expect(q?.recommended).toBe(1);
		expect(q?.ompLabels).toHaveLength(20);
		expect(q?.ompLabels.slice(0, 2)).toEqual(["use é", "plain"]);
	});

	test("keeps omp's uncut id and labels next to the cut ones", () => {
		const [q] = toQuestionInputs([
			ompQuestion({ id: "k".repeat(300), options: [{ label: "é".repeat(150), description: "d".repeat(900) }] }),
		]);
		const option = q?.options[0];
		expect(Buffer.byteLength(option?.label ?? "")).toBeLessThanOrEqual(200);
		expect(Buffer.byteLength(option?.description ?? "")).toBe(500);
		expect(q?.ompLabels).toEqual(["é".repeat(150)]);
		expect(q?.ompKey).toBe("k".repeat(300));
		expect(Buffer.byteLength(q?.key ?? "")).toBe(200);
	});

	test("drops the recommendation when its option was not kept, and ompLabels follow the kept options", () => {
		const [q] = toQuestionInputs([
			ompQuestion({ id: "q", options: [{ label: "", description: "" }, { label: "a", description: "" }], recommended: 0 }),
		]);
		expect(q?.recommended).toBeNull();
		expect(q?.ompLabels).toEqual(["a"]);
	});
});

describe("answersResponse", () => {
	test("answers every question in order with omp's ids, folding a single choice with words into one custom answer", () => {
		const response = answersResponse("ui1", [
			stored({ ompKey: "single", options: [{ label: "x", description: "" }], ompLabels: ["x"], selected: ["x"], answer: "with words" }),
			stored({ ompKey: "multi", multi: true, selected: ["p", "q"], answer: "and more", options: [{ label: "p", description: "" }, { label: "q", description: "" }], ompLabels: ["p", "q"] }),
			stored({ ompKey: "unanswered" }),
		]);
		expect(response).toEqual({
			type: "extension_ui_response",
			id: "ui1",
			answers: [
				{ id: "single", selectedOptions: [], customInput: "x: with words" },
				{ id: "multi", selectedOptions: ["p", "q"], customInput: "and more" },
				{ id: "unanswered", selectedOptions: [] },
			],
		});
	});

	test("a single choice alone stays a selected option; several labels on a single question join into one", () => {
		const options = [{ label: "x", description: "" }, { label: "y", description: "" }];
		const response = answersResponse("u", [
			stored({ ompKey: "a", options, ompLabels: ["x", "y"], selected: ["x"] }),
			stored({ ompKey: "b", options, ompLabels: ["x", "y"], selected: ["x", "y"] }),
		]);
		expect(response.answers).toEqual([
			{ id: "a", selectedOptions: ["x"] },
			{ id: "b", selectedOptions: [], customInput: "x, y" },
		]);
	});

	test("an expired question sends its note as the custom answer", () => {
		const note = expiredAnswer(1800);
		const response = answersResponse("u", [stored({ ompKey: "a", answer: note, answeredBy: "timeout", expired: true })]);
		expect(response.answers).toEqual([{ id: "a", selectedOptions: [], customInput: note }]);
	});

	test("a key and a label longer than the store's limits reach omp uncut", () => {
		const [input] = toQuestionInputs([ompQuestion({ id: "k".repeat(300), options: [{ label: "é".repeat(150), description: "" }, { label: "b", description: "" }] })]);
		if (input === undefined) throw new Error("no input");
		const question = stored({ ...input, selected: [input.options[0]?.label ?? ""] });
		const response = answersResponse("u", [question]);
		expect(response.answers).toEqual([{ id: "k".repeat(300), selectedOptions: ["é".repeat(150)] }]);
	});
});

describe("cutBytes", () => {
	test.each([
		["abc", 5, "abc"],
		["abcdef", 3, "abc"],
		["éé", 3, "é"],
		["éé", 4, "éé"],
		["é", 1, ""],
	])("cutBytes(%p, %p) = %p", (text, max, want) => {
		expect(cutBytes(text, max)).toBe(want);
	});
});

describe("expiredAnswer", () => {
	test.each([
		[1800, "No answer within 30m. Continue"],
		[3600, "No answer within 1h. Continue"],
		[5400, "No answer within 1h30m. Continue"],
	])("%p seconds", (seconds, start) => {
		const text = expiredAnswer(seconds);
		expect(text.startsWith(start)).toBe(true);
		expect(text.endsWith("ask again at the end of your turn if it still matters.")).toBe(true);
	});
});

describe("stoppedByUser", () => {
	test("is true only when every question was closed by the stop", () => {
		expect(stoppedByUser([stored({ answeredBy: "stop" }), stored({ answeredBy: "stop" })])).toBe(true);
		expect(stoppedByUser([stored({ answeredBy: "stop" }), stored({ answeredBy: "alice" })])).toBe(false);
		expect(stoppedByUser([])).toBe(false);
	});
});

describe("approvals", () => {
	const options = [{ label: "Approve", description: "run this tool call" }, { label: "Deny", description: "block it" }];
	const approval = (overrides: Partial<Question>): Question =>
		stored({ ompKey: APPROVAL_OMP_KEY, key: "approval:bash", options, ompLabels: ["Approve", "Deny"], requestId: "f1", ...overrides });

	test("the sentinel key can never be a model ask id: it holds a NUL", () => {
		expect(APPROVAL_OMP_KEY).toContain("\u0000");
	});

	test("isApproval is true for exactly one approval question", () => {
		expect(isApproval([approval({})])).toBe(true);
		expect(isApproval([approval({}), approval({})])).toBe(false);
		expect(isApproval([stored({ ompKey: "approval" })])).toBe(false);
		expect(isApproval([])).toBe(false);
	});

	test("Approve chosen on its own approves", () => {
		expect(answersResponse("f1", [approval({ selected: ["Approve"], answeredBy: "alice" })])).toEqual({
			type: "extension_ui_response",
			id: "f1",
			value: "Approve",
		});
	});

	test("Deny, free text, no choice, several choices and an unknown label all deny", () => {
		const denied = (question: Question): unknown => answersResponse("f1", [question]);
		const deny = { type: "extension_ui_response", id: "f1", value: "Deny" };
		expect(denied(approval({ selected: ["Deny"], answeredBy: "alice" }))).toEqual(deny);
		expect(denied(approval({ answer: "go ahead", answeredBy: "alice" }))).toEqual(deny);
		expect(denied(approval({}))).toEqual(deny);
		expect(denied(approval({ selected: ["Approve", "Deny"] }))).toEqual(deny);
		expect(denied(approval({ selected: ["Nope"] }))).toEqual(deny);
	});

	test("an expired, dropped or stopped approval denies even when it holds Approve", () => {
		for (const answeredBy of ["timeout", "dropped", "stop"]) {
			const response = answersResponse("f1", [approval({ selected: ["Approve"], answeredBy, expired: true })]);
			expect(response).toEqual({ type: "extension_ui_response", id: "f1", value: "Deny" });
		}
	});

	test("an approval answer carries no answers array, only the value omp reads", () => {
		expect(Object.keys(answersResponse("f1", [approval({ selected: ["Approve"] })])).sort()).toEqual(["id", "type", "value"]);
	});

	test("a model ask keeps its answers, also when it is the only question", () => {
		const response = answersResponse("u", [stored({ ompKey: "q", options: [{ label: "x", description: "" }], ompLabels: ["x"], selected: ["x"] })]);
		expect(response.answers).toEqual([{ id: "q", selectedOptions: ["x"] }]);
		expect(response).not.toHaveProperty("value");
	});

	test("approvalReply builds both replies", () => {
		expect(approvalReply("a", true)).toEqual({ type: "extension_ui_response", id: "a", value: "Approve" });
		expect(approvalReply("a", false)).toEqual({ type: "extension_ui_response", id: "a", value: "Deny" });
	});
});
