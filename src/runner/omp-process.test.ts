import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Sandbox } from "e2b";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompArgs, OmpProcess, OmpStdout } from "./omp-process";
import { VM_ENV_FILE } from "./vm-layout";

function open(): { out: OmpStdout; requests: Record<string, unknown>[]; read: () => Promise<string> } {
	const requests: Record<string, unknown>[] = [];
	const out = new OmpStdout(frame => requests.push(frame));
	const reader = out.stream.getReader();
	const decoder = new TextDecoder();
	// Closes the stream, then returns everything the stream carried.
	const read = async (): Promise<string> => {
		out.close();
		let text = "";
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value);
		return text;
	};
	return { out, requests, read };
}

const ask = { type: "extension_ui_request", id: "r1", method: "ask", questions: [{ id: "q", question: "color?" }] };
const askLine = `${JSON.stringify(ask)}\n`;

test("a frame split across chunks reaches stdout once, whole, and the UI handler once, parsed", async () => {
	const { out, requests, read } = open();
	for (let at = 0; at < askLine.length; at += 7) out.push(askLine.slice(at, at + 7));
	expect(await read()).toBe(askLine);
	expect(requests).toEqual([ask]);
});

test("several lines per chunk keep their order; only extension_ui_request frames reach the handler", async () => {
	const { out, requests, read } = open();
	const other = `${JSON.stringify({ type: "response", id: "1", note: "mentions extension_ui_request in text" })}\n`;
	const second = `${JSON.stringify({ ...ask, id: "r2" })}\n`;
	out.push(`${other}${askLine}${second}{"type":"event"}`);
	expect(await read()).toBe(`${other}${askLine}${second}`);
	expect(requests.map(frame => frame.id)).toEqual(["r1", "r2"]);
});

test("command_output frames and the response to a prompt reach the tap; other responses do not", async () => {
	const { out, requests, read } = open();
	const output = { type: "command_output", text: "Session: abc" };
	const ack = { id: "req_3", type: "response", command: "prompt", success: true, data: { agentInvoked: false } };
	const other = { id: "req_4", type: "response", command: "get_state", success: true, data: { note: "command_output" } };
	const lines = [output, ack, other].map(frame => `${JSON.stringify(frame)}\n`).join("");
	out.push(lines);
	expect(await read()).toBe(lines);
	expect(requests).toEqual([output, ack]);
});

test("a partial line before reset never reaches stdout", async () => {
	const { out, requests, read } = open();
	out.push('{"type":"event","a":1}\n{"type":"ev');
	out.reset();
	out.push(`{"type":"event","b":2}\n`);
	expect(await read()).toBe('{"type":"event","a":1}\n{"type":"event","b":2}\n');
	expect(requests).toEqual([]);
});

test("after reset a non-JSON first line is dropped and a JSON first line is kept", async () => {
	const dropped = open();
	dropped.out.reset();
	dropped.out.push(`tail of a cut frame"}\n${askLine}{"type":"event"}\n`);
	expect(await dropped.read()).toBe(`${askLine}{"type":"event"}\n`);
	expect(dropped.requests).toEqual([ask]);

	const kept = open();
	kept.out.reset();
	kept.out.push(`{"type":"event"}\nnot json\n`);
	expect(await kept.read()).toBe(`{"type":"event"}\nnot json\n`);
});

test("lines after close are ignored", async () => {
	const { out, requests, read } = open();
	expect(await read()).toBe("");
	out.push(askLine);
	expect(requests).toEqual([]);
});

test("ompArgs switches rpc to rpc-ui and appends the fixed flags before the extra args", () => {
	expect(ompArgs(["--mode", "rpc", "--model", "fake/m"], ["--resume", "/s.jsonl"])).toEqual([
		"--mode",
		"rpc-ui",
		"--model",
		"fake/m",
		"--no-title",
		"--no-pty",
		"--approval-mode",
		"yolo",
		"--resume",
		"/s.jsonl",
	]);
});

test("ompArgs never passes --no-ui: omp must ask for approvals over the protocol", () => {
	expect(ompArgs(["--mode", "rpc"], [])).not.toContain("--no-ui");
});

test("an approval select frame reaches the UI handler like an ask", async () => {
	const { out, requests, read } = open();
	const approval = {
		type: "extension_ui_request",
		id: "15ad39c0780a899f",
		method: "select",
		title: "Allow tool: bash\nReason: Prompt required by bash pattern: touch /tmp/x*\nCommand: touch /tmp/x",
		options: ["Approve", "Deny"],
	};
	const line = `${JSON.stringify(approval)}\n`;
	out.push(line);
	expect(requests).toEqual([approval]);
	expect(await read()).toBe(line);
});

describe("OmpProcess.start", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "omp-cloud-"));
		const bin = join(dir, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "omp"), '#!/bin/sh\nprintf "[%s]" "$DEMO_SECRET"\n', { mode: 0o755 });
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	/** The shell command `start` runs in the VM, with the VM's env file moved to `envFile`, run against a fake `omp` that prints $DEMO_SECRET. */
	async function started(envFile: string): Promise<string> {
		let command = "";
		const sandbox = {
			commands: {
				run: async (text: string) => {
					command = text;
					return { pid: 7, wait: () => new Promise(() => {}), disconnect: async () => {} };
				},
			},
		} as unknown as Sandbox;
		await OmpProcess.start(sandbox, ["--mode", "rpc"], { cwd: dir, extraArgs: [] }, () => {});
		const proc = Bun.spawn(["bash", "-c", command.replaceAll(VM_ENV_FILE, envFile)], {
			env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
			stdout: "pipe",
		});
		return await new Response(proc.stdout).text();
	}

	test("omp is started under the env file when it exists, so its variables reach omp", async () => {
		const envFile = join(dir, "env");
		await writeFile(envFile, "DEMO_SECRET='it'\\''s here'\n");
		expect(await started(envFile)).toBe("[it's here]");
	});

	test("a VM without an env file starts omp all the same", async () => {
		expect(await started(join(dir, "no-such-env"))).toBe("[]");
	});
});
