import { describe, expect, test } from "bun:test";
import { RequestError, type ContentBlock } from "@oh-my-pi/pi-utils/acp";
import { event, pending } from "../plugin/test/builders";
import { answerBody, command, configOptions, handoffLines, promptText, questionText, sessionIdOf, toolEnd, toolKind, toolStart, usageUpdate } from "./render";
import { launched } from "./test-support";

const text = (value: string): ContentBlock => ({ type: "text", text: value });

describe("promptText", () => {
	test("joins text blocks and file links in order: a file below cwd relative to it, another absolute, any other URI as written", () => {
		const blocks: ContentBlock[] = [
			text("  look at "),
			{ type: "resource_link", uri: "file:///work/app/src/a%20b.ts", name: "a b.ts" },
			text(" and "),
			{ type: "resource_link", uri: "file:///etc/hosts", name: "hosts" },
			text(" and "),
			{ type: "resource_link", uri: "https://example.com/x", name: "x" },
			text("\n"),
		];
		expect(promptText(blocks, "/work/app")).toBe("look at @src/a b.ts and @/etc/hosts and @https://example.com/x");
	});

	test("a directory whose name starts like cwd is not inside it", () => {
		expect(promptText([{ type: "resource_link", uri: "file:///work/app2/a.ts", name: "a" }], "/work/app")).toBe("@/work/app2/a.ts");
	});

	test("any other block is refused by its type, and so is a prompt without text", () => {
		const image = (): string => promptText([text("see"), { type: "image", data: "", mimeType: "image/png" }], "/work");
		expect(image).toThrow(RequestError);
		expect(image).toThrow("omp-cloud takes text and file links; the client sent a image block");
		expect(() => promptText([text("  \n ")], "/work")).toThrow("the prompt is empty");
		expect(() => promptText([], "/work")).toThrow("the prompt is empty");
	});
});

describe("command", () => {
	test("only /pull and /follow are the agent's own; everything else is a message", () => {
		expect(command("/pull")).toEqual({ name: "pull", arg: "" });
		expect(command("  /pull  merge ")).toEqual({ name: "pull", arg: "merge" });
		expect(command("/follow")).toEqual({ name: "follow", arg: "" });
		expect(command("/compact")).toBeUndefined();
		expect(command("/pulls")).toBeUndefined();
		expect(command("please /pull")).toBeUndefined();
		expect(command("/pull merge now")).toEqual({ name: "pull", arg: "merge now" });
	});
});

describe("tool events", () => {
	test("toolKind names omp's tools and nothing inherited", () => {
		expect(["read", "write", "edit", "delete", "move", "bash", "eval", "grep", "ast_grep", "web_search", "todo", "task"].map(toolKind)).toEqual([
			"read",
			"edit",
			"edit",
			"delete",
			"move",
			"execute",
			"execute",
			"search",
			"search",
			"fetch",
			"think",
			"other",
		]);
		expect(toolKind("constructor")).toBe("other");
	});

	test("a tool_start is a tool call in progress, titled by its intent, else by the tool and its arguments", () => {
		const start = (fields: Record<string, unknown>) => toolStart(event(7, { kind: "tool_start", text: JSON.stringify(fields) }));
		expect(start({ id: "c1", tool: "bash", intent: "run tests", args: '{"command":"bun test"}' })).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "c1",
			title: "run tests",
			kind: "execute",
			status: "in_progress",
			rawInput: '{"command":"bun test"}',
		});
		expect(start({ id: "", tool: "read", intent: "", args: '{"path":"a"}' })).toMatchObject({ toolCallId: "tool-7", title: 'read {"path":"a"}', kind: "read" });
		expect(start({ id: "c2", tool: "todo", intent: "", args: "" })).toEqual({ sessionUpdate: "tool_call", toolCallId: "c2", title: "todo", kind: "think", status: "in_progress" });
		expect(toolStart(event(7, { kind: "tool_start", text: "bash ls" }))).toBeUndefined();
	});

	test("a tool_end completes or fails its call, with the error as content", () => {
		const end = (fields: Record<string, unknown>) => toolEnd(event(9, { kind: "tool_end", text: JSON.stringify(fields) }));
		expect(end({ id: "c1", ok: true, error: "" })).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
		expect(end({ id: "", ok: false, error: "exit 2" })).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "tool-9",
			status: "failed",
			content: [{ type: "content", content: { type: "text", text: "exit 2" } }],
		});
		expect(toolEnd(event(9, { kind: "tool_end", text: "[1]" }))).toBeUndefined();
	});

	test("a usage event with a known window is a usage update", () => {
		const usage = (context: unknown) => usageUpdate(event(3, { kind: "usage", text: JSON.stringify({ input: 1, context }) }));
		expect(usage({ tokens: 135, window: 200_000 })).toEqual({ sessionUpdate: "usage_update", size: 200_000, used: 135 });
		expect(usage({ tokens: 135, window: 0 })).toBeUndefined();
		expect(usage(undefined)).toBeUndefined();
	});
});

describe("questions", () => {
	const options = [
		{ label: "red", description: "" },
		{ label: "blue", description: "the calm one" },
	];

	test("questionText lists the options by number and says how to answer", () => {
		expect(questionText(pending({ header: "Color", text: "Which one?", options }))).toBe(
			"Color\nWhich one?\n\n1. red\n2. blue — the calm one\n\nReply with a number, a label, or your own answer.",
		);
		expect(questionText(pending({ text: "Which ones?", options, multi: true }))).toBe(
			"Which ones?\n\n1. red\n2. blue — the calm one\n\nReply with numbers or labels separated by commas, or your own answer.",
		);
	});

	test("answerBody selects an option by number or label, else the text is the answer", () => {
		const single = { options, multi: false };
		expect(answerBody(single, "2")).toEqual({ selected: ["blue"] });
		expect(answerBody(single, "BLUE")).toEqual({ selected: ["blue"] });
		expect(answerBody(single, "teal")).toEqual({ answer: "teal" });
		expect(answerBody(single, "3")).toEqual({ answer: "3" });
		// Not a multi question: a comma is part of the answer.
		expect(answerBody(single, "1, blue")).toEqual({ answer: "1, blue" });
	});

	test("a multi answer selects every part when all of them name options, without duplicates", () => {
		const multi = { options, multi: true };
		expect(answerBody(multi, "1, blue")).toEqual({ selected: ["red", "blue"] });
		expect(answerBody(multi, "2, Blue")).toEqual({ selected: ["blue"] });
		expect(answerBody(multi, "1, teal")).toEqual({ answer: "1, teal" });
	});
});

describe("sessions", () => {
	test("a thread is listed under the session id that made it, else under its own id", () => {
		const ref = `acp-${"0af1".repeat(8)}`;
		expect(sessionIdOf({ id: "k3x9fa2m7q1z", ref })).toBe(ref);
		expect(sessionIdOf({ id: "k3x9fa2m7q1z", ref: "" })).toBe("k3x9fa2m7q1z");
		expect(sessionIdOf({ id: "k3x9fa2m7q1z", ref: "my-task" })).toBe("k3x9fa2m7q1z");
	});

	test("configOptions offers the cloud's models and the thinking levels until the thread exists, then only what it runs", () => {
		const open = configOptions({ models: ["a/x", "b/y"], defaultModel: "a/x", model: "", thinking: "", fixed: false });
		expect(open.map(option => [option.id, option.category, option.type, option.currentValue])).toEqual([
			["model", "model", "select", ""],
			["thinking", "thought_level", "select", ""],
		]);
		const values = (index: number): unknown => {
			const option = open[index];
			return option?.type === "select" ? option.options.map(choice => [choice.value, choice.name]) : undefined;
		};
		expect(values(0)).toEqual([
			["", "Cloud default (a/x)"],
			["a/x", "a/x"],
			["b/y", "b/y"],
		]);
		expect(values(1)).toEqual([["", "Default"], ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => [level, level])]);

		expect(configOptions({ models: [], defaultModel: "a/x", model: "b/y", thinking: "", fixed: true })).toEqual([
			{ id: "model", name: "Model", category: "model", type: "select", currentValue: "b/y", options: [{ value: "b/y", name: "b/y" }] },
			{ id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "", options: [{ value: "", name: "Default" }] },
		]);
		expect(configOptions({ models: [], defaultModel: "a/x", model: "", thinking: "high", fixed: true })[0]).toMatchObject({ options: [{ value: "", name: "Cloud default" }] });
	});
});

describe("handoffLines", () => {
	test("says what shipped, the model, and every warning", () => {
		expect(handoffLines(launched({}), 0)).toEqual(["repository: app (feature), 3 commits, 2 changed files, 1 untracked", "model: cloud default"]);
		expect(handoffLines(launched({ scratch: true, model: "a/x", thinking: "high", withheld: [".env", "id_rsa"] }, ["plugin p is enabled here but not shipped"]), 2)).toEqual([
			"workspace: scratch (nothing of this directory shipped)",
			"model: a/x, thinking high",
			"kept here (credential files): .env, id_rsa",
			"warning: plugin p is enabled here but not shipped",
			"warning: MCP servers passed by the editor are not shipped; the cloud agent gets the servers of omp's mcp.json",
		]);
	});
});
