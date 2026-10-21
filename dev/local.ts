/**
 * `mise run dev:local`: omp over RPC (a prompt, the `ask` dialog, continuity, restart + `--resume`) with local omp, an isolated
 * HOME/agent dir and the fake provider on 127.0.0.1. No VM needed.
 *
 * `RpcClient` launches omp through its `spawn` option (it passes `--mode rpc ...`; {@link ompArgs} turns that
 * into `rpc-ui`). A custom launcher is needed instead of `command` because the ask dialog is answered by
 * tapping the child's stdout, which `RpcClient` cannot do for us (see rpc-ui.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { CONFIG_YAML, MODEL, modelsYaml, startFakeProvider } from "../test/fake-provider";
import { userTexts } from "../test/messages";
import { expectContains, expectEqual, Report, StepFailed } from "../test/report";
import { ompArgs, prefer, UiTap } from "./rpc-ui";

const STDERR_TAIL_BYTES = 32 * 1024;

interface LocalOmp extends RpcAgentProcess {
	readonly ui: UiTap;
}

function spawnLocal(args: string[], cwd: string, env: Record<string, string>): LocalOmp {
	const proc = Bun.spawn(["omp", ...ompArgs(args)], {
		cwd,
		env: { ...process.env, ...env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const ui = new UiTap(frame => {
		proc.stdin.write(`${JSON.stringify(frame)}\n`);
		return proc.stdin.flush();
	}, prefer("blue"));
	const decoder = new TextDecoder();
	const stdout = proc.stdout.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				ui.push(decoder.decode(chunk, { stream: true }));
				controller.enqueue(chunk);
			},
		}),
	);
	let stderr = "";
	void (async () => {
		const stderrDecoder = new TextDecoder();
		for await (const chunk of proc.stderr) {
			stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
		}
	})();
	return {
		ui,
		stdin: proc.stdin,
		stdout,
		peekStderr: () => stderr,
		kill: () => proc.kill("SIGTERM"),
		exited: proc.exited,
	};
}

const report = new Report();
const root = mkdtempSync(join(tmpdir(), "omp-cloud-local-"));
const home = join(root, "home");
const agentDir = join(home, ".omp", "agent");
const work = join(root, "work");
const provider = startFakeProvider({ hostname: "127.0.0.1", port: 0 });
const clients: RpcClient[] = [];

/** One omp process driven by a fresh `RpcClient`; `extra` are appended CLI args (e.g. `--resume <file>`). */
async function launch(extra: string[] = []): Promise<{ client: RpcClient; ui: UiTap }> {
	let ui: UiTap | undefined;
	const client = new RpcClient({
		model: MODEL,
		args: extra,
		spawn: args => {
			const omp = spawnLocal(args, work, {
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				XDG_DATA_HOME: join(root, "xdg-data"),
				XDG_STATE_HOME: join(root, "xdg-state"),
				XDG_CACHE_HOME: join(root, "xdg-cache"),
			});
			ui = omp.ui;
			return omp;
		},
	});
	clients.push(client);
	await client.start();
	if (!ui) throw new Error("spawn was not called");
	await ui.enableAskDialog();
	return { client, ui };
}

async function lastText(client: RpcClient): Promise<string> {
	return (await client.getLastAssistantText()) ?? "";
}

try {
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(work, { recursive: true });
	writeFileSync(join(agentDir, "models.yml"), modelsYaml(provider.url));
	writeFileSync(join(agentDir, "config.yml"), CONFIG_YAML);
	const git = Bun.spawnSync(["git", "init", "-q", "-b", "main", work]);
	if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);

	const { client, ui } = await report.step("start omp (rpc-ui)", () => launch());

	await report.step("prompt hello", async () => {
		await client.promptAndWait("hello", undefined, 120_000);
		expectEqual("reply", await lastText(client), "TURN count=1 first=hello");
	});

	await report.step("ask round-trip", async () => {
		await client.promptAndWait("ASK: pick a color", undefined, 120_000);
		const reply = await lastText(client);
		expectContains("reply", reply, "ANSWER=");
		expectContains("reply", reply, "blue");
		const ask = ui.exchanges.filter(x => x.request.method === "ask");
		expectEqual("ask requests", ask.length, 1);
		console.log(`      request:  ${JSON.stringify(ask[0]?.request)}`);
		console.log(`      response: ${JSON.stringify(ask[0]?.response)}`);
	});

	await report.step("rpc continuity (get_messages)", async () => {
		const users = userTexts(await client.getMessages());
		expectEqual("user messages", users.length, 2);
		expectEqual("first user message", users[0], "hello");
		await client.promptAndWait("again", undefined, 120_000);
		expectEqual("reply", await lastText(client), "TURN count=3 first=hello");
	});

	const sessionFile = (await client.getState()).sessionFile;
	if (!sessionFile) throw new Error("get_state returned no sessionFile");

	await report.step("restart + --resume same session", async () => {
		await client.stop();
		const resumed = await launch(["--resume", sessionFile]);
		expectEqual("user messages after resume", userTexts(await resumed.client.getMessages()).length, 3);
		await resumed.client.promptAndWait("after", undefined, 120_000);
		expectEqual("reply", await lastText(resumed.client), "TURN count=4 first=hello");
	});

	console.log(`\nprovider requests: ${provider.count}`);
} catch (error) {
	if (!(error instanceof StepFailed)) {
		console.error(error);
		report.rows.push({ name: "setup", ms: 0, ok: false, detail: String(error) });
	}
	console.log(`provider requests: ${provider.count}`);
	console.log(`last provider request: ${JSON.stringify(provider.last)?.slice(0, 4000)}`);
} finally {
	for (const client of clients) await client.stop().catch(() => {});
	await provider.stop();
	rmSync(root, { recursive: true, force: true });
}
process.exitCode = report.print() ? 0 : 1;
