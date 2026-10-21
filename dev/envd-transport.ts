/**
 * Runs `omp --mode rpc-ui` as a background envd command inside an e2b/vmon sandbox and exposes it as an omp
 * {@link RpcAgentProcess}, so `new RpcClient({ spawn })` drives it exactly like a local child.
 *
 * Mapping:
 * - `stdout`   a ReadableStream fed by the command's `onStdout` callback (the SDK hands us decoded text; it is
 *              re-encoded as UTF-8 bytes for `RpcClient`). stderr goes to a 32 KiB tail for `peekStderr()`.
 * - `stdin`    `sandbox.commands.sendStdin(pid, data)`, serialized so frames keep their order.
 * - `kill`     SIGTERM through `kill -s`, SIGKILL via `commands.kill` after the grace period.
 * - `exited`   settles only when envd reports the process ended (`CommandExitError` / exit code); a dropped
 *              stream does NOT settle it, because the process may be alive (see below).
 *
 * Pause / resume. A memory pause keeps the guest process but every open envd stream drops. {@link EnvdRpcProcess.adopt}
 * (the dev tool's next invocation after `Sandbox.connect(id)`) `commands.connect(pid)`s to the same pid and feeds a fresh
 * stdout stream, so a new `RpcClient` drives the omp that kept running.
 *
 * LOST OUTPUT: envd has no replay buffer. Anything omp writes while no client is attached is gone. Consequences:
 *  - pause only while omp is idle (after the prompt settled). A frame cut in half by the drop would make
 *    `RpcClient`'s JSONL reader throw and reap the agent, so attaching calls `UiTap.reset()`.
 *  - if a turn WAS in flight, its events are lost; ask `get_state` (isStreaming / isSettled) and `get_messages`
 *    for the authoritative transcript, and re-send any `extension_ui_response` whose request was lost (an
 *    unanswered `ask` is still pending inside omp but its request frame is gone).
 */
import { type CommandHandle, CommandExitError, type Sandbox } from "e2b";
import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { type Chooser, ompArgs, UiTap } from "./rpc-ui";

const STDERR_TAIL_BYTES = 32 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;

interface EnvdSpawnOptions {
	/** Working directory of omp inside the guest. */
	cwd: string;
	/** Answers `ask` dialogs. */
	choose: Chooser;
	envs?: Record<string, string>;
	/** Attach to this already running omp (see {@link EnvdRpcProcess.adopt}) instead of starting a new one. */
	adoptPid?: number;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class EnvdRpcProcess implements RpcAgentProcess {
	readonly stdin = { write: (data: string | Uint8Array): Promise<void> => this.#send(data) };
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	/** Answers `ask` requests found in stdout. */
	readonly ui: UiTap;
	/** Guest pid of omp (`exec` replaces the wrapping bash, so this is omp itself). */
	pid = -1;

	#sandbox: Sandbox;
	#handle?: CommandHandle;
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	#encoder = new TextEncoder();
	#stderr = "";
	#tail: Promise<void> = Promise.resolve();
	#resolveExit!: (code: number) => void;
	#exitCode?: number;

	private constructor(sandbox: Sandbox, choose: Chooser) {
		this.#sandbox = sandbox;
		this.stdout = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
			},
		});
		this.exited = new Promise<number>(resolve => {
			this.#resolveExit = resolve;
		});
		this.ui = new UiTap(frame => this.#send(`${JSON.stringify(frame)}\n`), choose);
	}

	/** Starts `omp <ompArgs(agentArgs)>` in the background with stdin enabled and no command timeout. */
	static async start(sandbox: Sandbox, agentArgs: string[], options: EnvdSpawnOptions): Promise<EnvdRpcProcess> {
		const process = new EnvdRpcProcess(sandbox, options.choose);
		const command = `exec omp ${ompArgs(agentArgs).map(shellQuote).join(" ")}`;
		const handle = await sandbox.commands.run(command, {
			background: true,
			stdin: true,
			// 0 = no limit. A positive value becomes a lifetime SIGKILL (Connect-Timeout-Ms) on vmon.
			timeoutMs: 0,
			cwd: options.cwd,
			envs: options.envs,
			onStdout: data => process.#feed(data),
			onStderr: data => process.#onStderr(data),
		});
		process.pid = handle.pid;
		process.#attach(handle);
		return process;
	}

	/**
	 * Attach to an omp that an earlier host process started (e.g. the previous CLI invocation) and keep it driveable
	 * by a fresh `RpcClient`. `RpcClient.start()` waits for the `ready` frame omp wrote long ago and nobody
	 * buffered, so a synthetic one is queued first; `negotiate_protocol` is idempotent in omp, so the client's
	 * handshake is accepted by the already negotiated process.
	 */
	static async adopt(sandbox: Sandbox, pid: number, choose: Chooser): Promise<EnvdRpcProcess> {
		const process = new EnvdRpcProcess(sandbox, choose);
		process.pid = pid;
		const ready = { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1024 * 1024 };
		process.#controller.enqueue(process.#encoder.encode(`${JSON.stringify(ready)}\n`));
		await process.#reattach(sandbox);
		return process;
	}

	/** Reconnects to the same pid on `sandbox`. Output produced while detached is lost (see the file comment). Throws if the process is gone. */
	async #reattach(sandbox: Sandbox): Promise<void> {
		const previous = this.#handle;
		this.#handle = undefined;
		await previous?.disconnect().catch(() => {});
		this.#sandbox = sandbox;
		this.ui.reset();
		const handle = await sandbox.commands.connect(this.pid, {
			timeoutMs: 0,
			onStdout: data => this.#feed(data),
			onStderr: data => this.#onStderr(data),
		});
		this.#attach(handle);
	}

	/** Stop receiving output without touching the omp process (it keeps running in the guest). */
	async detach(): Promise<void> {
		const handle = this.#handle;
		this.#handle = undefined;
		await handle?.disconnect().catch(() => {});
	}

	peekStderr(): string {
		return this.#stderr;
	}

	/**
	 * SIGTERM, then SIGKILL if omp is still alive after `graceMs`. `RpcClient` calls this as `kill(undefined, grace)`;
	 * the first parameter mirrors `ptree.ChildProcess.kill(reason?: Exception)` and is ignored.
	 */
	kill(_reason?: unknown, graceMs: number = DEFAULT_KILL_GRACE_MS): void {
		if (this.#exitCode !== undefined) return;
		const sandbox = this.#sandbox;
		void sandbox.commands.run(`kill -s TERM ${this.pid}`).catch(() => {});
		setTimeout(() => {
			if (this.#exitCode === undefined) void sandbox.commands.kill(this.pid).catch(() => {});
		}, graceMs).unref();
	}

	#attach(handle: CommandHandle): void {
		this.#handle = handle;
		handle.wait().then(
			result => this.#exit(result.exitCode),
			error => {
				// Any other failure is a dropped stream: the process may still run, so `exited` stays pending.
				if (error instanceof CommandExitError) this.#exit(error.exitCode);
			},
		);
	}

	#exit(code: number): void {
		if (this.#exitCode !== undefined) return;
		this.#exitCode = code;
		this.#resolveExit(code);
		try {
			this.#controller.close();
		} catch {
			// already closed
		}
	}

	#feed(data: string): void {
		this.ui.push(data);
		if (this.#exitCode === undefined) this.#controller.enqueue(this.#encoder.encode(data));
	}

	#onStderr(data: string): void {
		this.#stderr = (this.#stderr + data).slice(-STDERR_TAIL_BYTES);
	}

	/** Sequential stdin: each write waits for the previous one; a failure rejects only its own write. */
	#send(data: string | Uint8Array): Promise<void> {
		const write = this.#tail.then(() => this.#sandbox.commands.sendStdin(this.pid, data));
		this.#tail = write.catch(() => {});
		return write;
	}
}

/** `RpcClientOptions.spawn` for one sandbox; `current()` is the process the client is talking to. */
export function envdSpawner(sandbox: Sandbox, options: EnvdSpawnOptions) {
	let current: EnvdRpcProcess | undefined;
	return {
		spawn: async (agentArgs: string[]): Promise<EnvdRpcProcess> => {
			current =
				options.adoptPid === undefined
					? await EnvdRpcProcess.start(sandbox, agentArgs, options)
					: await EnvdRpcProcess.adopt(sandbox, options.adoptPid, options.choose);
			return current;
		},
		current: (): EnvdRpcProcess => {
			if (!current) throw new Error("omp has not been spawned yet");
			return current;
		},
	};
}
