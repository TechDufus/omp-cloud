import { describe, expect, test } from "bun:test";
import { answerSummary, answerThread, AutoAsker, askUser, OTHER, parseAnswerText, pendingQuestions, usesNativeDialog } from "../src/answer";
import type { AnswerBody, HostUi, Question } from "../src/types";
import { detail, question, turn } from "./builders";
import { fakeHost } from "./fakes";

const OPTIONS = [{ label: "postgres", description: "prod" }, { label: "sqlite", description: "" }, { label: "mysql", description: "" }];

const q = (id: number, over: Partial<Question> = {}): Question =>
	question({ id, key: `k${id}`, text: `question ${id}`, options: OPTIONS, recommended: 0, ...over });

describe("pendingQuestions", () => {
	test("is the unanswered questions of the oldest pending ask, in order", () => {
		const p = pendingQuestions({
			turns: [
				turn(1, { questions: [q(1, { answeredAt: "x" })] }),
				turn(2, { questions: [q(3, { ask: 2 }), q(2, { ask: 1 }), q(1, { ask: 1, answeredAt: "x" }), q(4, { ask: 1 })] }),
			],
		});
		expect(p?.turn).toBe(2);
		expect(p?.questions.map(x => x.id)).toEqual([2, 4]);
	});

	test("expired questions are not pending", () => {
		const p = pendingQuestions({ turns: [turn(1, { questions: [q(1, { expired: true }), q(2)] })] });
		expect(p?.questions.map(x => x.id)).toEqual([2]);
		expect(pendingQuestions({ turns: [turn(1, { questions: [q(1, { expired: true })] })] })).toBeUndefined();
	});

	test("nothing pending when every question is answered or a turn has none", () => {
		expect(pendingQuestions({ turns: [turn(1, { questions: [q(1, { answeredAt: "x" })] })] })).toBeUndefined();
		expect(pendingQuestions({ turns: [turn(1, { questions: [] })] })).toBeUndefined();
		expect(pendingQuestions({ turns: [] })).toBeUndefined();
	});
});

describe("parseAnswerText", () => {
	const cases: [string, Partial<Question>, AnswerBody][] = [
		["postgres", {}, { selected: ["postgres"] }],
		["  SQLite ", {}, { selected: ["sqlite"] }],
		["the second one", {}, { answer: "the second one" }],
		["postgres, sqlite", {}, { answer: "postgres, sqlite" }],
		["postgres, sqlite", { multi: true }, { selected: ["postgres", "sqlite"] }],
		["postgres, oracle", { multi: true }, { answer: "postgres, oracle" }],
		["postgres, postgres", { multi: true }, { selected: ["postgres"] }],
		["yes", { options: [] }, { answer: "yes" }],
	];
	for (const [text, over, want] of cases) {
		test(`${JSON.stringify(text)} ${over.multi ? "(multi) " : ""}-> ${JSON.stringify(want)}`, () => expect(parseAnswerText(q(1, over), text)).toEqual(want));
	}
});

describe("askUser", () => {
	test("single choice: a labelled option, the recommendation marked, 'Other' types free text", async () => {
		const seen: string[][] = [];
		const h = fakeHost({
			select: async (_t, items) => {
				seen.push(items);
				return items[1];
			},
		});
		expect(await askUser(h.host.ui, "t", q(1))).toEqual({ selected: ["sqlite"] });
		expect(seen[0]).toEqual(["postgres (recommended) — prod", "sqlite", "mysql", OTHER]);

		const other = fakeHost({ select: async (_t, items) => items.at(-1), input: async () => " my own " });
		expect(await askUser(other.host.ui, "t", q(1))).toEqual({ answer: "my own" });
	});

	test("the prompt title names the thread, the header and the question", async () => {
		const titles: string[] = [];
		const h = fakeHost({
			select: async (title, items) => {
				titles.push(title);
				return items[0];
			},
		});
		await askUser(h.host.ui, "k3x9fa", q(1, { header: "Database" }));
		expect(titles).toEqual(["k3x9fa · Database: question 1"]);
	});

	test("cancelling at any step answers nothing", async () => {
		const h = fakeHost({ select: async () => undefined, input: async () => undefined });
		expect(await askUser(h.host.ui, "t", q(1))).toBeUndefined();
		const typed = fakeHost({ select: async () => OTHER, input: async () => "   " });
		expect(await askUser(typed.host.ui, "t", q(1))).toBeUndefined();
	});

	test("without options the user types the answer", async () => {
		const h = fakeHost({ select: async () => undefined, input: async () => "use utf-8" });
		expect(await askUser(h.host.ui, "t", q(1, { options: [] }))).toEqual({ answer: "use utf-8" });
	});

	test("multi select repeats until Done; chosen options leave the list", async () => {
		const picks = ["postgres (recommended) — prod", "mysql", "Done (2 selected)"];
		const lists: string[][] = [];
		const h = fakeHost({
			select: async (_t, items) => {
				lists.push(items);
				const want = picks.shift();
				return items.find(i => i === want);
			},
		});
		expect(await askUser(h.host.ui, "t", q(1, { multi: true }))).toEqual({ selected: ["postgres", "mysql"] });
		expect(lists[0]).toEqual(["postgres (recommended) — prod", "sqlite", "mysql", OTHER]);
		expect(lists[1]).toEqual(["sqlite", "mysql", "Done (1 selected)", OTHER]);
		expect(lists[2]).toEqual(["sqlite", "Done (2 selected)", OTHER]);
	});

	test("multi select: Other after choices keeps both the selection and the typed text", async () => {
		const picks = ["mysql", OTHER];
		const h = fakeHost({
			select: async (_t, items) => {
				const want = picks.shift();
				return items.find(i => i === want);
			},
			input: async () => "and a custom one",
		});
		expect(await askUser(h.host.ui, "t", q(1, { multi: true }))).toEqual({ selected: ["mysql"], answer: "and a custom one" });
	});

	test("a host that cannot prompt says how to answer instead", async () => {
		const h = fakeHost();
		await expect(askUser(h.host.ui, "t", q(1))).rejects.toThrow("/cloud answer <id> <text>");
		await expect(askUser(h.host.ui, "t", q(1, { options: [] }))).rejects.toThrow("/cloud answer <id> <text>");
	});
});

describe("answerThread", () => {
	const ID = "aaaaaak3x9fa";

	function client(questions: Question[]) {
		const posted: { thread: string; turn: number; id: number; body: AnswerBody }[] = [];
		const fetched: string[] = [];
		return {
			posted,
			fetched,
			thread: async (id: string) => {
				fetched.push(id);
				return detail({ id, turns: [turn(5, { questions })] });
			},
			answer: async (thread: string, turnId: number, id: number, body: AnswerBody) => {
				posted.push({ thread, turn: turnId, id, body });
				return q(id, { selected: body.selected ?? [], answer: body.answer ?? "", answeredAt: "now" });
			},
		};
	}

	test("with text it answers the first pending question only", async () => {
		const c = client([q(1), q(2)]);
		const out = await answerThread(c, ID, fakeHost().host.ui, "postgres");
		expect(c.fetched).toEqual([ID]);
		expect(c.posted).toEqual([{ thread: ID, turn: 5, id: 1, body: { selected: ["postgres"] } }]);
		expect(out.left).toBe(1);
		expect(out.answered.map(a => a.id)).toEqual([1]);
	});

	test("without text it prompts for every question of the ask in order and stops at a cancel", async () => {
		const c = client([q(1), q(2), q(3)]);
		const answers = ["postgres", "sqlite", undefined];
		const h = fakeHost({
			select: async (_t, items) => {
				const a = answers.shift();
				return a === undefined ? undefined : items.find(i => i.startsWith(a));
			},
		});
		const out = await answerThread(c, ID, h.host.ui);
		expect(c.posted.map(p => [p.id, p.body])).toEqual([
			[1, { selected: ["postgres"] }],
			[2, { selected: ["sqlite"] }],
		]);
		expect(out.left).toBe(1);
		expect(out.answered).toHaveLength(2);
	});

	test("blank text falls back to prompting", async () => {
		const c = client([q(1)]);
		const h = fakeHost({ select: async (_t, items) => items[2] });
		const out = await answerThread(c, ID, h.host.ui, "   ");
		expect(c.posted).toEqual([{ thread: ID, turn: 5, id: 1, body: { selected: ["mysql"] } }]);
		expect(out.left).toBe(0);
	});

	test("a thread with nothing pending is a clear error and posts nothing", async () => {
		const c = client([q(1, { answeredAt: "x" })]);
		await expect(answerThread(c, ID, fakeHost().host.ui, "hi")).rejects.toThrow(`☁ ${ID} has no question waiting`);
		expect(c.posted).toEqual([]);
	});
});

type DialogResult = Awaited<ReturnType<NonNullable<HostUi["askDialog"]>>>;
type DialogQuestions = Parameters<NonNullable<HostUi["askDialog"]>>[0];

/** A host whose ask dialog and approval prompt are `askDialog` and `approve`; select and input fail the test when asked. */
function nativeHost(native: Pick<HostUi, "askDialog" | "approve">) {
	const h = fakeHost({
		select: async () => {
			throw new Error("select must not be used");
		},
		input: async () => {
			throw new Error("input must not be used");
		},
	});
	h.host.ui.askDialog = native.askDialog;
	h.host.ui.approve = native.approve;
	return h;
}

const item = (id: number, over: Partial<NonNullable<Extract<DialogResult, { kind: "submit" }>>["results"][number]> = {}) => ({
	id: String(id),
	question: `question ${id}`,
	options: ["postgres", "sqlite", "mysql"],
	multi: false,
	selectedOptions: [] as string[],
	...over,
});

describe("askUser through the ask dialog", () => {
	test("a single question: its text, header, options with descriptions and the recommendation go to the dialog", async () => {
		const seen: DialogQuestions[] = [];
		const h = nativeHost({
			askDialog: async questions => {
				seen.push(questions);
				return { kind: "submit", results: [item(1, { selectedOptions: ["sqlite"] })] };
			},
		});
		expect(await askUser(h.host.ui, "k3x9fa", q(1, { header: "Database" }))).toEqual({ selected: ["sqlite"] });
		expect(seen).toEqual([
			[
				{
					id: "1",
					question: "question 1",
					header: "Database",
					options: [{ label: "postgres", description: "prod" }, { label: "sqlite" }, { label: "mysql" }],
					multi: false,
					recommended: 0,
				},
			],
		]);
	});

	test("a single question without a header is titled with the thread; no recommendation is left out", async () => {
		const seen: DialogQuestions[] = [];
		const h = nativeHost({
			askDialog: async questions => {
				seen.push(questions);
				return { kind: "submit", results: [item(1, { selectedOptions: ["mysql"] })] };
			},
		});
		await askUser(h.host.ui, "k3x9fa", q(1, { recommended: null }));
		expect(seen[0]?.[0]?.header).toBe("k3x9fa");
		expect(seen[0]?.[0]).not.toHaveProperty("recommended");
		await askUser(h.host.ui, "k3x9fa", q(1, { recommended: 7 }));
		expect(seen[1]?.[0]).not.toHaveProperty("recommended");
	});

	test("Other text is the free-text answer; a note rides along as the free text of a selection", async () => {
		const results: DialogResult[] = [
			{ kind: "submit", results: [item(1, { customInput: " my own " })] },
			{ kind: "submit", results: [item(1, { selectedOptions: ["postgres"], note: "but with pgbouncer" })] },
			{ kind: "submit", results: [item(1, { customInput: "mine", note: "because" })] },
		];
		const h = nativeHost({ askDialog: async () => results.shift() });
		expect(await askUser(h.host.ui, "t", q(1))).toEqual({ answer: "my own" });
		expect(await askUser(h.host.ui, "t", q(1))).toEqual({ selected: ["postgres"], answer: "but with pgbouncer" });
		expect(await askUser(h.host.ui, "t", q(1))).toEqual({ answer: "mine\nbecause" });
	});

	test("multi select: the dialog gets multi and the chosen options come back together with the typed text", async () => {
		const seen: DialogQuestions[] = [];
		const h = nativeHost({
			askDialog: async questions => {
				seen.push(questions);
				return { kind: "submit", results: [item(1, { multi: true, selectedOptions: ["postgres", "mysql"], customInput: "and x" })] };
			},
		});
		expect(await askUser(h.host.ui, "t", q(1, { multi: true }))).toEqual({ selected: ["postgres", "mysql"], answer: "and x" });
		expect(seen[0]?.[0]?.multi).toBe(true);
	});

	test("cancel, a chat request and an empty answer are no answer, and select is not asked instead", async () => {
		const results: DialogResult[] = [undefined, { kind: "chat" }, { kind: "submit", results: [item(1)] }, { kind: "submit", results: [] }];
		for (const result of results) {
			const h = nativeHost({ askDialog: async () => result });
			expect(await askUser(h.host.ui, "t", q(1))).toBeUndefined();
		}
	});

	test("a question without options still opens the dialog, for a typed answer", async () => {
		const seen: DialogQuestions[] = [];
		const h = nativeHost({
			askDialog: async questions => {
				seen.push(questions);
				return { kind: "submit", results: [item(1, { options: [], customInput: "use utf-8" })] };
			},
		});
		expect(await askUser(h.host.ui, "t", q(1, { options: [] }))).toEqual({ answer: "use utf-8" });
		expect(seen[0]?.[0]?.options).toEqual([]);
	});
});

describe("approvals through approve", () => {
	const approval = (over: Partial<Question> = {}): Question =>
		q(1, {
			kind: "approval",
			key: "approval:bash",
			header: "Approval",
			text: "Allow tool: bash\nrm -rf build",
			options: [{ label: "Approve", description: "run this tool call" }, { label: "Deny", description: "block it" }],
			recommended: 1,
			...over,
		});
	const push = (): Question =>
		q(2, {
			kind: "push",
			key: "omp-cloud:push",
			header: "Push",
			text: "Push omp-cloud/x to origin?",
			options: [{ label: "Push", description: "push 1111 to origin" }, { label: "Do not push", description: "keep the result on the service" }],
			recommended: 0,
		});

	const answers: [string, Awaited<ReturnType<NonNullable<HostUi["approve"]>>>, AnswerBody][] = [
		["once", "once", { selected: ["Approve"] }],
		["session", "session", { selected: ["Approve"] }],
		["a grant", { grant: "folder", always: false }, { selected: ["Approve"] }],
		["deny", "deny", { selected: ["Deny"] }],
	];
	for (const [name, given, want] of answers) {
		test(`${name} answers ${JSON.stringify(want)}`, async () => {
			const h = nativeHost({ approve: async () => given });
			expect(await askUser(h.host.ui, "k3x9fa", approval())).toEqual(want);
		});
	}

	test("the push question maps to its own labels", async () => {
		const h = nativeHost({ approve: async () => "once" });
		expect(await askUser(h.host.ui, "t", push())).toEqual({ selected: ["Push"] });
		const denied = nativeHost({ approve: async () => "deny" });
		expect(await askUser(denied.host.ui, "t", push())).toEqual({ selected: ["Do not push"] });
	});

	test("the prompt names the thread and carries the whole question, in one line when compact", async () => {
		const seen: Parameters<NonNullable<HostUi["approve"]>>[0][] = [];
		const h = nativeHost({
			approve: async prompt => {
				seen.push(prompt);
				return "deny";
			},
		});
		await askUser(h.host.ui, "k3x9fa", approval());
		await askUser(h.host.ui, "k3x9fa", push());
		expect(seen[0]).toEqual({ full: "☁ k3x9fa · tool approval\nAllow tool: bash\nrm -rf build\nrun this tool call", compact: "☁ k3x9fa · tool approval — Allow tool: bash" });
		expect(seen[1]?.full).toBe("☁ k3x9fa · push\nPush omp-cloud/x to origin?\npush 1111 to origin");
		expect(seen[1]?.compact).not.toContain("\n");
	});

	test("the service's key marks an approval that carries no kind", async () => {
		const h = nativeHost({ approve: async () => "once" });
		const old = approval({ kind: undefined as unknown as Question["kind"] });
		expect(await askUser(h.host.ui, "t", old)).toEqual({ selected: ["Approve"] });
	});

	test("an approval goes to the ask dialog when the host has no approve, with the recommendation on Deny", async () => {
		const seen: DialogQuestions[] = [];
		const h = nativeHost({
			askDialog: async questions => {
				seen.push(questions);
				return { kind: "submit", results: [item(1, { options: ["Approve", "Deny"], selectedOptions: ["Deny"] })] };
			},
		});
		expect(await askUser(h.host.ui, "t", approval())).toEqual({ selected: ["Deny"] });
		expect(seen[0]?.[0]?.recommended).toBe(1);
	});

	test("an ask question never goes through approve", async () => {
		let approved = 0;
		const h = nativeHost({
			approve: async () => {
				approved++;
				return "once";
			},
			askDialog: async () => ({ kind: "submit", results: [item(1, { selectedOptions: ["sqlite"] })] }),
		});
		expect(await askUser(h.host.ui, "t", q(1))).toEqual({ selected: ["sqlite"] });
		expect(approved).toBe(0);
	});

	test("an approve that gives no answer falls back to select", async () => {
		const h = fakeHost({ select: async (_t, items) => items.find(i => i.startsWith("Deny")) });
		h.host.ui.approve = (async () => undefined) as unknown as NonNullable<HostUi["approve"]>;
		expect(await askUser(h.host.ui, "t", approval())).toEqual({ selected: ["Deny"] });
	});

	test("options that are not an approve and a deny leave the question to select", async () => {
		const h = fakeHost({ select: async (_t, items) => items[0] });
		h.host.ui.approve = async () => {
			throw new Error("approve must not be used");
		};
		expect(await askUser(h.host.ui, "t", approval({ options: [{ label: "Only", description: "" }] }))).toEqual({ selected: ["Only"] });
	});
});

describe("answerThread through the native dialogs", () => {
	const ID = "aaaaaak3x9fa";

	function client(questions: Question[]) {
		const posted: { id: number; body: AnswerBody }[] = [];
		return {
			posted,
			thread: async (id: string) => detail({ id, turns: [turn(5, { questions })] }),
			answer: async (_thread: string, _turn: number, id: number, body: AnswerBody) => {
				posted.push({ id, body });
				return q(id, { selected: body.selected ?? [], answer: body.answer ?? "", answeredAt: "now" });
			},
		};
	}

	test("all the questions of the ask share one dialog, one tab each, and each answer is sent", async () => {
		const c = client([q(1, { header: "Database" }), q(2, { header: "Cache", multi: true, recommended: null }), q(3)]);
		const seen: DialogQuestions[] = [];
		const h = nativeHost({
			askDialog: async questions => {
				seen.push(questions);
				return {
					kind: "submit",
					results: [
						item(1, { selectedOptions: ["sqlite"] }),
						item(2, { multi: true, selectedOptions: ["postgres", "mysql"] }),
						item(3, { customInput: "none of them", note: "ask me later" }),
					],
				};
			},
		});
		const out = await answerThread(c, ID, h.host.ui);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.map(x => [x.id, x.header, x.multi])).toEqual([["1", "Database", false], ["2", "Cache", true], ["3", undefined, false]]);
		expect(c.posted).toEqual([
			{ id: 1, body: { selected: ["sqlite"] } },
			{ id: 2, body: { selected: ["postgres", "mysql"] } },
			{ id: 3, body: { answer: "none of them\nask me later" } },
		]);
		expect(out.left).toBe(0);
		expect(out.answered.map(a => a.id)).toEqual([1, 2, 3]);
	});

	test("a cancelled dialog answers nothing", async () => {
		const c = client([q(1), q(2)]);
		const h = nativeHost({ askDialog: async () => undefined });
		const out = await answerThread(c, ID, h.host.ui);
		expect(c.posted).toEqual([]);
		expect(out).toMatchObject({ answered: [], left: 2, turn: 5 });
		expect(out.asked.map(a => a.id)).toEqual([1, 2]);
	});

	test("answers are sent up to the first question the dialog left empty", async () => {
		const c = client([q(1), q(2), q(3)]);
		const h = nativeHost({
			askDialog: async () => ({ kind: "submit", results: [item(1, { selectedOptions: ["mysql"] }), item(2), item(3, { selectedOptions: ["sqlite"] })] }),
		});
		const out = await answerThread(c, ID, h.host.ui);
		expect(c.posted.map(p => p.id)).toEqual([1]);
		expect(out.left).toBe(2);
	});

	test("an approval of the thread is answered through approve, not the dialog", async () => {
		const c = client([
			q(1, { kind: "approval", key: "approval:bash", options: [{ label: "Approve", description: "" }, { label: "Deny", description: "" }], recommended: 1 }),
		]);
		const h = nativeHost({
			approve: async () => "once",
			askDialog: async () => {
				throw new Error("the dialog must not be used");
			},
		});
		const out = await answerThread(c, ID, h.host.ui);
		expect(c.posted).toEqual([{ id: 1, body: { selected: ["Approve"] } }]);
		expect(out.left).toBe(0);
	});

	test("typed text still answers the first question without opening anything", async () => {
		const c = client([q(1), q(2)]);
		const h = nativeHost({
			askDialog: async () => {
				throw new Error("the dialog must not be used");
			},
		});
		await answerThread(c, ID, h.host.ui, "sqlite");
		expect(c.posted).toEqual([{ id: 1, body: { selected: ["sqlite"] } }]);
	});

	test("without askDialog and approve the select and input flow is unchanged, and usesNativeDialog is false", async () => {
		const c = client([q(1), q(2, { options: [] })]);
		const h = fakeHost({ select: async (_t, items) => items[1], input: async () => "typed" });
		expect(usesNativeDialog(h.host.ui, q(1))).toBe(false);
		const out = await answerThread(c, ID, h.host.ui);
		expect(c.posted).toEqual([
			{ id: 1, body: { selected: ["sqlite"] } },
			{ id: 2, body: { answer: "typed" } },
		]);
		expect(out.left).toBe(0);
	});

	test("usesNativeDialog: the ask dialog covers every question, approve only the permission ones", () => {
		const perm = q(1, { kind: "approval", key: "approval:bash", options: [{ label: "Approve", description: "" }, { label: "Deny", description: "" }] });
		const approveOnly = nativeHost({ approve: async () => "once" });
		expect(usesNativeDialog(approveOnly.host.ui, perm)).toBe(true);
		expect(usesNativeDialog(approveOnly.host.ui, q(1))).toBe(false);
		const dialogOnly = nativeHost({ askDialog: async () => undefined });
		expect(usesNativeDialog(dialogOnly.host.ui, q(1))).toBe(true);
	});
});

/** A dialog that stays open until its signal aborts, as the host's does, then resolves undefined. */
function closedBy(signal: AbortSignal | undefined): Promise<undefined> {
	const { promise, resolve } = Promise.withResolvers<undefined>();
	signal?.addEventListener("abort", () => resolve(undefined));
	return promise;
}

describe("AutoAsker", () => {
	const ID = "aaaaaak3x9fa";
	const APPROVAL = (id: number, over: Partial<Question> = {}): Question =>
		q(id, { kind: "approval", key: "approval:bash", options: [{ label: "Approve", description: "" }, { label: "Deny", description: "" }], recommended: 1, ...over });

	function rig(over: { modelOwns?: boolean; failAnswer?: boolean } = {}) {
		const posted: { turn: number; id: number; body: AnswerBody }[] = [];
		const reports: { answered: number[]; left: number }[] = [];
		const asker = new AutoAsker({
			answer: async (_host, _thread, turnId, id, body) => {
				if (over.failAnswer) throw new Error("409 conflict");
				posted.push({ turn: turnId, id, body });
				return q(id, { selected: body.selected ?? [], answer: body.answer ?? "", answeredAt: "now" });
			},
			modelOwns: () => over.modelOwns ?? false,
			answered: async (_host, _thread, answered, left) => void reports.push({ answered: answered.map(a => a.id), left }),
			tag: thread => `Fix greeting · ${thread}`,
		});
		return { asker, posted, reports };
	}

	const waiting = (questions: Question[]) => detail({ id: ID, turns: [turn(5, { questions })] });

	test("opens one ask dialog with every pending question of the ask and sends the answers", async () => {
		const { asker, posted, reports } = rig();
		const seen: DialogQuestions[] = [];
		const h = nativeHost({
			askDialog: async questions => {
				seen.push(questions);
				return { kind: "submit", results: [item(1, { selectedOptions: ["sqlite"] }), item(2, { customInput: "mine", note: "why" })] };
			},
		});
		await asker.open(h.host, waiting([q(1), q(2)]));
		expect(seen).toHaveLength(1);
		expect(seen[0]?.map(x => x.id)).toEqual(["1", "2"]);
		expect(posted).toEqual([
			{ turn: 5, id: 1, body: { selected: ["sqlite"] } },
			{ turn: 5, id: 2, body: { answer: "mine\nwhy" } },
		]);
		expect(reports).toEqual([{ answered: [1, 2], left: 0 }]);
	});

	test("each question is offered once: a dismissed dialog is not reopened, an answered or expired question never is", async () => {
		const { asker, posted } = rig();
		let opened = 0;
		const h = nativeHost({
			askDialog: async () => {
				opened++;
				return undefined;
			},
		});
		const thread = waiting([q(1), q(2)]);
		await asker.open(h.host, thread);
		await asker.open(h.host, thread);
		expect(opened).toBe(1);
		expect(posted).toEqual([]);
		await asker.open(h.host, waiting([q(1), q(2, { answeredAt: "x" }), q(3, { expired: true })]));
		expect(opened).toBe(1);
		// A question that arrives later is a new one.
		await asker.open(h.host, waiting([q(1), q(4)]));
		expect(opened).toBe(2);
	});

	test("a host without askDialog is offered nothing, and an ask is left to the card", async () => {
		const { asker, posted } = rig();
		const h = fakeHost({
			select: async () => {
				throw new Error("select must not be used");
			},
		});
		await asker.open(h.host, waiting([q(1)]));
		expect(posted).toEqual([]);
		expect(h.notes).toEqual([]);
	});

	test("an approval goes to approve alone when that is all the host has, and an ask beside it waits for the card", async () => {
		const { asker, posted, reports } = rig();
		const h = nativeHost({ approve: async () => "once" });
		await asker.open(h.host, waiting([APPROVAL(1), q(2)]));
		expect(posted).toEqual([{ turn: 5, id: 1, body: { selected: ["Approve"] } }]);
		expect(reports).toEqual([{ answered: [1], left: 1 }]);
	});

	test("a thread the model started keeps its ask questions for the model, but its approvals are the user's", async () => {
		const { asker, posted } = rig({ modelOwns: true });
		const dialogs: DialogQuestions[] = [];
		const h = nativeHost({
			askDialog: async questions => {
				dialogs.push(questions);
				return undefined;
			},
			approve: async () => "deny",
		});
		await asker.open(h.host, waiting([q(1)]));
		expect(dialogs).toEqual([]);
		await asker.open(h.host, waiting([q(1), APPROVAL(2)]));
		expect(dialogs).toEqual([]);
		expect(posted).toEqual([{ turn: 5, id: 2, body: { selected: ["Deny"] } }]);
	});

	test("answering the question elsewhere closes the open dialog, and nothing is sent", async () => {
		const { asker, posted } = rig();
		const signals: (AbortSignal | undefined)[] = [];
		const h = nativeHost({
			askDialog: (_questions, dialogOptions) => {
				signals.push(dialogOptions?.signal);
				return closedBy(dialogOptions?.signal);
			},
		});
		const done = asker.open(h.host, waiting([q(1), q(2)]));
		expect(signals[0]?.aborted).toBe(false);
		asker.settle(waiting([q(1), q(2)]));
		expect(signals[0]?.aborted).toBe(false);
		asker.settle(waiting([q(1, { answeredAt: "x" }), q(2)]));
		expect(signals[0]?.aborted).toBe(true);
		await done;
		expect(posted).toEqual([]);
	});

	test("the dialog closes when the question's time runs out, without a timeout that would answer it", async () => {
		const { asker } = rig();
		const options: (Parameters<NonNullable<HostUi["askDialog"]>>[1])[] = [];
		const h = nativeHost({
			askDialog: (_questions, dialogOptions) => {
				options.push(dialogOptions);
				return closedBy(dialogOptions?.signal);
			},
		});
		const done = asker.open(h.host, waiting([q(1, { expiresAt: new Date(Date.now() + 60_000).toISOString() })]));
		expect(options[0]).not.toHaveProperty("timeout");
		expect(h.timeouts).toHaveLength(1);
		h.timeouts[0]?.();
		await done;
		expect(options[0]?.signal?.aborted).toBe(true);
	});

	test("close() ends the dialogs of one thread or of all", async () => {
		const { asker } = rig();
		const signals: (AbortSignal | undefined)[] = [];
		const h = nativeHost({
			askDialog: (_questions, dialogOptions) => {
				signals.push(dialogOptions?.signal);
				return closedBy(dialogOptions?.signal);
			},
		});
		const first = asker.open(h.host, waiting([q(1)]));
		const second = asker.open(h.host, detail({ id: "bbbbbbk3x9fb", turns: [turn(2, { questions: [q(1)] })] }));
		asker.close("zzz");
		expect(signals.map(s => s?.aborted)).toEqual([false, false]);
		asker.close(ID);
		expect(signals.map(s => s?.aborted)).toEqual([true, false]);
		asker.close();
		await Promise.all([first, second]);
		expect(signals.map(s => s?.aborted)).toEqual([true, true]);
	});

	test("a failed answer is a notification, not a thrown error", async () => {
		const { asker, reports } = rig({ failAnswer: true });
		const h = nativeHost({ askDialog: async () => ({ kind: "submit", results: [item(1, { selectedOptions: ["sqlite"] })] }) });
		await asker.open(h.host, waiting([q(1)]));
		expect(h.notes).toEqual([["☁ could not send the answer: 409 conflict", "error"]]);
		expect(reports).toEqual([]);
	});

	describe("when the dialog returns no answer", () => {
		const HINT = `☁ Fix greeting · ${ID} still waits for an answer: /cloud answer ${ID.slice(-6)} <text> (the card's buttons work too where shown)`;

		test("one quiet info notice names the command, once per question; nothing is answered or reopened", async () => {
			const { asker, posted } = rig();
			let opened = 0;
			const h = nativeHost({
				askDialog: async () => {
					opened++;
					return undefined;
				},
			});
			await asker.open(h.host, waiting([q(1), q(2)]));
			expect(h.notes).toEqual([[HINT, "info"]]);
			await asker.open(h.host, waiting([q(1), q(2)]));
			expect(opened).toBe(1);
			expect(h.notes).toHaveLength(1);
			expect(posted).toEqual([]);
			// A question that arrives later is a new one.
			await asker.open(h.host, waiting([q(1), q(2), q(3)]));
			expect(h.notes).toEqual([[HINT, "info"], [HINT, "info"]]);
		});

		test("a chat request and an empty submit are no answer either", async () => {
			const results: DialogResult[] = [{ kind: "chat" }, { kind: "submit", results: [item(1)] }];
			for (const result of results) {
				const { asker } = rig();
				const h = nativeHost({ askDialog: async () => result });
				await asker.open(h.host, waiting([q(1)]));
				expect(h.notes).toEqual([[HINT, "info"]]);
			}
		});

		test("an answered dialog and a dialog closed because the question went away say nothing", async () => {
			const { asker } = rig();
			const answered = nativeHost({ askDialog: async () => ({ kind: "submit", results: [item(1, { selectedOptions: ["sqlite"] })] }) });
			await asker.open(answered.host, waiting([q(1)]));
			expect(answered.notes).toEqual([]);

			const closing = nativeHost({ askDialog: (_questions, dialogOptions) => closedBy(dialogOptions?.signal) });
			const done = asker.open(closing.host, waiting([q(2)]));
			asker.settle(waiting([q(2, { answeredAt: "x" })]));
			await done;
			expect(closing.notes).toEqual([]);
		});

		test("unanswered() serves /cloud answer: native hosts only, once per question", () => {
			const { asker } = rig();
			const plain = fakeHost({ select: async () => undefined });
			asker.unanswered(plain.host, ID, 5, [q(1)]);
			expect(plain.notes).toEqual([]);
			const h = nativeHost({ askDialog: async () => undefined });
			asker.unanswered(h.host, ID, 5, [q(1)]);
			asker.unanswered(h.host, ID, 5, [q(1)]);
			expect(h.notes).toEqual([[HINT, "info"]]);
		});
	});
});

describe("answerSummary", () => {
	test("quotes the question and joins the selection and typed text", () => {
		expect(answerSummary(q(1, { selected: ["postgres", "mysql"], answer: "plus x" }))).toBe('"question 1" → postgres, mysql, plus x');
		expect(answerSummary(q(1, { answer: "free" }))).toBe('"question 1" → free');
	});
});
