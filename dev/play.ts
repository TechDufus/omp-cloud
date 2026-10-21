/**
 * `mise run dev:play -- [--sandbox <id>] [--model <provider/id>] [--kill] [--ls] "<prompt>"`
 *
 * Talks to a real model through omp's auth gateway from a persistent, pausable microVM:
 *  - no --sandbox: create one from the owner's omp template (`mise run template` builds it; metadata app=omp-cloud-play, 1 h timeout, no auto-pause), write a
 *    gateway-only models.yml (provider routed to the gateway with the client token, as metaharness's agent.ts does),
 *    `git init` the work dir and start omp rpc-ui in it.
 *  - --sandbox <id>: `Sandbox.connect(id)` (resumes a paused VM), find the running omp again, adopt it and continue
 *    the SAME conversation. omp is found without any bookkeeping: envd lists background commands with their argv, and
 *    ours is `/bin/bash -l -c "exec omp '--mode' 'rpc-ui' ..."`, so the one whose args mention `rpc-ui` is omp. (It
 *    keeps running when this CLI exits because envd processes outlive their client stream.)
 *  - the turn streams to stdout; `ask` dialogs are answered on this terminal; when the turn settles the VM is paused.
 */
import "./env";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { Sandbox } from "e2b";
import { EnvdRpcProcess, envdSpawner } from "./envd-transport";
import { isRecord } from "../src/guards";
import { hostOmp } from "../src/omp-version";
import { installedVmonVersion } from "../src/vmon/pin";
import { templateName } from "../src/vmon/template";
import type { AskQuestion } from "./rpc-ui";

const TEMPLATE_BASE = "omp-agent";
const APP = "omp-cloud-play";
const SANDBOX_TIMEOUT_MS = 60 * 60_000;
const HOME = "/home/user";
const WORK = `${HOME}/work`;
const AGENT_DIR = `${HOME}/.omp/agent`;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const GATEWAY_URL = process.env.OMP_GATEWAY_URL ?? "http://10.254.254.1:4000";
const TOKEN_PATH = join(homedir(), ".config", "omp-cloud", "gateway-client.token");
const TURN_TIMEOUT_MS = 10 * 60_000;
const USAGE = 'usage: dev/play.ts [--sandbox <id>] [--model <provider/id>] [--kill] [--ls] "<prompt>"';

const { values: flags, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		sandbox: { type: "string" },
		model: { type: "string" },
		kill: { type: "boolean", default: false },
		ls: { type: "boolean", default: false },
	},
});

const started = performance.now();
function phase(message: string): void {
	console.log(`[+${((performance.now() - started) / 1000).toFixed(1)}s] ${message}`);
}

async function listPlaySandboxes(): Promise<void> {
	const paginator = Sandbox.list({ query: { metadata: { app: APP }, state: ["running", "paused"] } });
	let count = 0;
	while (paginator.hasNext) {
		for (const info of await paginator.nextItems()) {
			count++;
			console.log(`${info.sandboxId}  ${info.state}  started ${info.startedAt.toISOString()}  ends ${info.endAt.toISOString()}`);
		}
	}
	if (count === 0) console.log("no play sandboxes");
}

/** Lazily opened readline on the host terminal; answers `ask` dialogs. */
let terminal: Interface | undefined;
async function askOnTerminal(question: AskQuestion): Promise<string> {
	terminal ??= createInterface({ input: process.stdin, output: process.stdout });
	console.log(`\n? ${question.question}${question.multi ? "  (multi-select: only one answer is taken here)" : ""}`);
	question.options.forEach((option, index) => console.log(`  ${index + 1}) ${option}`));
	const answer = (await terminal.question("choice (number, or type your own answer): ")).trim();
	const index = Number(answer);
	return Number.isInteger(index) && index >= 1 && index <= question.options.length
		? (question.options[index - 1] ?? answer)
		: answer;
}

async function writeGuestConfig(sandbox: Sandbox, model: string): Promise<void> {
	const provider = model.split("/")[0];
	if (!provider || !model.includes("/")) throw new Error(`--model must be <provider>/<id>, got ${JSON.stringify(model)}`);
	const token = readFileSync(TOKEN_PATH, "utf8").trim();
	const modelsYaml = `providers:
  ${provider}:
    baseUrl: ${GATEWAY_URL}
    auth: oauth
    transport: pi-native
    apiKey: ${token}
`;
	await sandbox.files.write(`${AGENT_DIR}/models.yml`, modelsYaml);
	await sandbox.files.write(`${AGENT_DIR}/config.yml`, `modelRoles:\n  default: ${model}\n`);
	await sandbox.commands.run(`chmod 600 ${AGENT_DIR}/models.yml && git init -q -b main ${WORK}`, { cwd: HOME });
}

async function findOmpPid(sandbox: Sandbox): Promise<number> {
	const processes = await sandbox.commands.list();
	const omp = processes.find(p => p.args.some(arg => arg.includes("rpc-ui")));
	if (!omp) {
		throw new Error(`no omp rpc-ui process in ${sandbox.sandboxId} (running: ${JSON.stringify(processes.map(p => p.args))})`);
	}
	return omp.pid;
}

function shorten(value: unknown, max = 100): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function play(prompt: string): Promise<number> {
	const model = flags.model ?? DEFAULT_MODEL;
	const resuming = flags.sandbox !== undefined;
	let sandbox: Sandbox;
	let created = false;
	if (flags.sandbox) {
		sandbox = await Sandbox.connect(flags.sandbox, { timeoutMs: SANDBOX_TIMEOUT_MS });
		phase(`connected to ${sandbox.sandboxId} (resumed if it was paused)`);
	} else {
		const template = await templateName(TEMPLATE_BASE, (await hostOmp()).version, await installedVmonVersion());
		sandbox = await Sandbox.create(template, {
			metadata: { app: APP },
			timeoutMs: SANDBOX_TIMEOUT_MS,
			lifecycle: { onTimeout: "kill", autoResume: false },
		});
		created = true;
		phase(`created sandbox ${sandbox.sandboxId}`);
	}

	let omp: EnvdRpcProcess | undefined;
	let exitCode = 0;
	try {
		if (created) await writeGuestConfig(sandbox, model);
		const spawner = envdSpawner(sandbox, {
			cwd: WORK,
			choose: askOnTerminal,
			adoptPid: resuming ? await findOmpPid(sandbox) : undefined,
		});
		const client = new RpcClient({ model, spawn: spawner.spawn });
		await client.start();
		omp = spawner.current();
		await omp.ui.enableAskDialog();
		await client.setAutoRetry(false); // provider/gateway errors must surface now, not after retry backoff
		phase(`${resuming ? "adopted" : "started"} omp pid ${omp.pid}`);

		if (resuming && flags.model) {
			const [provider = "", ...id] = flags.model.split("/");
			await client.setModel(provider, id.join("/"));
		}
		const state = await client.getState();
		if (!state.isSettled) {
			phase("a turn is still running in omp; waiting for it to settle");
			await client.waitForSettled(TURN_TIMEOUT_MS);
		}
		const before = (await client.getMessages()).length;
		phase(`session ${state.sessionId}, ${before} messages, model ${state.model?.provider}/${state.model?.id}`);

		let failure: string | undefined;
		client.onEvent(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			} else if (event.type === "tool_execution_start") {
				const args: unknown = event.args;
				console.log(`\n[tool] ${event.toolName} ${shorten(args)}`);
			} else if (event.type === "tool_execution_end" && event.isError) {
				console.log(`[tool error] ${event.toolName}`);
			} else if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
				const { stopReason, errorMessage } = event.message;
				if (stopReason === "error" || stopReason === "aborted") {
					failure = `stopReason=${String(stopReason)}: ${typeof errorMessage === "string" ? errorMessage : "(no error message)"}`;
				}
			}
		});

		phase(`prompt: ${shorten(prompt, 80)}`);
		try {
			await client.promptAndWait(prompt, undefined, TURN_TIMEOUT_MS);
		} catch (error) {
			failure ??= error instanceof Error ? error.message : String(error);
		}
		await client.waitForSettled(30_000).catch(() => {});
		const after = (await client.getMessages()).length;
		console.log("");
		if (failure) {
			console.log(`ERROR from the model/gateway: ${failure}`);
			exitCode = 1;
		}
		phase(`turn settled; session now has ${after} messages (was ${before})`);
	} catch (error) {
		console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
		exitCode = 1;
		if (created && !omp) {
			await sandbox.kill().catch(() => {});
			phase(`killed ${sandbox.sandboxId} (omp never started)`);
			return exitCode;
		}
	}

	terminal?.close();
	await omp?.detach();
	await sandbox.pause();
	phase(`paused ${sandbox.sandboxId}`);
	console.log(`paused ${sandbox.sandboxId}; continue: mise run dev:play -- --sandbox ${sandbox.sandboxId} "..."`);
	return exitCode;
}

if (flags.ls) {
	await listPlaySandboxes();
} else if (flags.kill) {
	if (!flags.sandbox) throw new Error(`--kill needs --sandbox <id>\n${USAGE}`);
	console.log(`killed ${flags.sandbox}: ${await Sandbox.kill(flags.sandbox)}`);
} else {
	const prompt = positionals.join(" ").trim();
	if (!prompt) throw new Error(USAGE);
	process.exit(await play(prompt));
}
