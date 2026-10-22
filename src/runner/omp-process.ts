/**
 * Runs `omp --mode rpc-ui` as a background envd command inside a vmon sandbox and exposes it as an omp
 * {@link RpcAgentProcess}, so `new RpcClient({ spawn })` drives it like a local child.
 *
 * - `stdout`  a ReadableStream fed by the command's `onStdout` callback (decoded text, re-encoded as UTF-8).
 *             Every complete `extension_ui_request`, `command_output` and `prompt` response frame also goes to the frame tap;
 *             `RpcClient` has no hook for the first two and drops the data of the third. stderr goes to a 32 KiB tail for `peekStderr()`.
 * - `stdin`   `sandbox.commands.sendStdin(pid, data)`, serialized with {@link OmpProcess.sendFrame}.
 * - `kill`    the SDK's stop hook only marks the process detached; `terminate()` is the real SIGTERM, then SIGKILL after the grace period.
 * - `exited`  settles only when envd reports the process ended; a dropped stream does NOT settle it, because
 *             the process may be alive.
 *
 * Pause / resume. A memory pause keeps the guest process but every open envd stream drops. After
 * `Sandbox.connect(id)` (a NEW `Sandbox` with fresh envd endpoints) call {@link OmpProcess.reattach}: it
 * `commands.connect(pid)`s and keeps feeding the SAME stdout stream, so the existing `RpcClient` keeps working.
 *
 * Lost output: envd has no replay buffer, so output produced while nobody is attached is gone. Pause only while
 * omp is idle. A half-received line is dropped on reattach, otherwise it would corrupt the next frame.
 */
import { CommandExitError, type CommandHandle, type Sandbox } from "e2b";
import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isRecord } from "../guards";
import { shellQuote } from "./exec";
import { VM_ENV_FILE } from "./vm-layout";

/**
 * Called for every complete stdout line that is a frame `RpcClient` has no hook for (parsed): an `extension_ui_request`, a
 * `command_output` (what a slash command printed) or the `response` to a `prompt` (whose `data.agentInvoked` the client drops).
 */
export type FrameTap = (frame: Record<string, unknown>) => void;

/** `cwd` and `extraArgs`; secret env must never go through `commands.run` envs, which `commands.list` shows, so omp sources {@link VM_ENV_FILE} when it exists. */
export interface OmpStart {
	cwd: string;
	extraArgs: string[];
}

const STDERR_TAIL_BYTES = 32 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;
/** A line containing none of these is never parsed for the tap. */
const TAP_MARKERS = ['"extension_ui_request"', '"command_output"', '"command":"prompt"'] as const;
const TAPPED_TYPES: readonly string[] = ["extension_ui_request", "command_output", "response"];

/**
 * Flags added after the ones `RpcClient` passes. No --no-skills/--no-rules/--no-lsp: threads use the repo's. No --no-ui:
 * it would make omp fail every tool call that needs approval; without it omp asks over the protocol and the runner relays
 * the approval to a person as a question.
 */
const OMP_FLAGS = ["--no-title", "--no-pty", "--approval-mode", "yolo"] as const;

/** `--mode rpc` becomes `rpc-ui` (the mode that routes the `ask` tool over the protocol); then the fixed flags, then extraArgs. */
export function ompArgs(agentArgs: readonly string[], extraArgs: readonly string[]): string[] {
	const args = [...agentArgs];
	const mode = args.indexOf("--mode");
	if (mode >= 0 && args[mode + 1] === "rpc") args[mode + 1] = "rpc-ui";
	return [...args, ...OMP_FLAGS, ...extraArgs];
}

/** Whether `pid` is a running omp rpc-ui process in the sandbox (`commands.list()`). */
export async function ompAlive(sandbox: Sandbox, pid: number): Promise<boolean> {
	const running = await sandbox.commands.list();
	return running.some(p => p.pid === pid && p.args.some(arg => arg.includes("rpc-ui")));
}

/**
 * The stdout stream `RpcClient` reads. Its JSONL reader throws on a cut line and reaps omp, so only COMPLETE
 * lines (each with its newline) are enqueued; a complete line that is a tapped frame (see {@link FrameTap}) also goes to `tap`, parsed.
 */
export class OmpStdout {
	readonly stream: ReadableStream<Uint8Array>;
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	#encoder = new TextEncoder();
	#partial = "";
	#verifyFirst = false;
	#closed = false;

	constructor(private readonly tap: FrameTap) {
		this.stream = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
			},
		});
	}

	/** After output may have been lost (a reconnect): drops the pending partial line and the next complete line unless it is JSON, since the new stream may start mid-frame. */
	reset(): void {
		this.#partial = "";
		this.#verifyFirst = true;
	}

	/** Feed decoded stdout text; complete lines are forwarded, a trailing partial line waits for its newline. */
	push(text: string): void {
		this.#partial += text;
		let newline = this.#partial.indexOf("\n");
		while (newline >= 0) {
			const line = this.#partial.slice(0, newline);
			this.#partial = this.#partial.slice(newline + 1);
			this.#line(line);
			newline = this.#partial.indexOf("\n");
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#controller.close();
		} catch {
			// already closed
		}
	}

	#line(line: string): void {
		if (this.#closed) return;
		let frame: unknown;
		let parsed = false;
		const wantsFrame = TAP_MARKERS.some(marker => line.includes(marker));
		if (this.#verifyFirst || wantsFrame) {
			try {
				frame = JSON.parse(line);
				parsed = true;
			} catch {
				// not JSON
			}
		}
		if (this.#verifyFirst) {
			this.#verifyFirst = false;
			if (!parsed) return;
		}
		this.#controller.enqueue(this.#encoder.encode(`${line}\n`));
		if (wantsFrame && isRecord(frame) && TAPPED_TYPES.includes(String(frame.type))) {
			if (frame.type !== "response" || frame.command === "prompt") this.tap(frame);
		}
	}
}

export class OmpProcess implements RpcAgentProcess {
	readonly stdin = { write: (data: string | Uint8Array): Promise<void> => this.#send(data) };
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;

	#pid = -1;
	#sandbox: Sandbox;
	#handle?: CommandHandle;
	#output: OmpStdout;
	#stderr = "";
	#tail: Promise<void> = Promise.resolve();
	#resolveExit!: (code: number) => void;
	#exitCode?: number;
	#bytesSinceAttach = 0;
	#detachedBy?: unknown;
	#killTimer?: Timer;

	private constructor(sandbox: Sandbox, tap: FrameTap) {
		this.#sandbox = sandbox;
		this.#output = new OmpStdout(tap);
		this.stdout = this.#output.stream;
		this.exited = new Promise<number>(resolve => {
			this.#resolveExit = resolve;
		});
	}

	/** Guest pid of omp (`exec` replaces the wrapping bash, so this is omp itself). */
	get pid(): number {
		return this.#pid;
	}

	/** stdout bytes since the last (re)attach: the SDK holds them in memory until the next reattach. */
	get bytesSinceAttach(): number {
		return this.#bytesSinceAttach;
	}

	/** Why the stream dropped while the process may still run; undefined while attached. */
	get detachedBy(): unknown {
		return this.#detachedBy;
	}

	/** `[if [ -f VM_ENV_FILE ]; then set -a; . VM_ENV_FILE; set +a; fi;] exec omp <ompArgs(agentArgs, start.extraArgs)>` in the background, stdin on, timeoutMs 0. */
	static async start(
		sandbox: Sandbox,
		agentArgs: string[],
		start: OmpStart,
		tap: FrameTap,
	): Promise<OmpProcess> {
		const process = new OmpProcess(sandbox, tap);
		const env = shellQuote(VM_ENV_FILE);
		const source = `if [ -f ${env} ]; then set -a; . ${env}; set +a; fi; `;
		const command = `${source}exec omp ${ompArgs(agentArgs, start.extraArgs).map(shellQuote).join(" ")}`;
		const handle = await sandbox.commands.run(command, {
			background: true,
			stdin: true,
			// 0 = no limit. A positive value becomes a lifetime SIGKILL (Connect-Timeout-Ms) on vmon.
			timeoutMs: 0,
			cwd: start.cwd,
			onStdout: data => process.#feed(data),
			onStderr: data => process.#onStderr(data),
		});
		process.#pid = handle.pid;
		process.#attach(handle);
		return process;
	}

	/**
	 * Attach to an omp that an earlier service process started. `RpcClient.start()` waits for the `ready` frame omp
	 * wrote long ago and nobody buffered, so a synthetic one is queued first; `negotiate_protocol` is idempotent in
	 * omp, so the client's handshake is accepted by the already negotiated process.
	 */
	static async adopt(sandbox: Sandbox, pid: number, tap: FrameTap): Promise<OmpProcess> {
		const process = new OmpProcess(sandbox, tap);
		process.#pid = pid;
		const ready = { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1024 * 1024 };
		process.#output.push(`${JSON.stringify(ready)}\n`);
		await process.reattach(sandbox);
		return process;
	}

	/**
	 * Fresh handle on `sandbox` (after pause + `Sandbox.connect`, or to drop the SDK's buffer); the same stdout
	 * stream keeps flowing. Output produced while detached is lost. Throws if the process is gone.
	 */
	async reattach(sandbox: Sandbox): Promise<void> {
		clearTimeout(this.#killTimer);
		const previous = this.#handle;
		this.#handle = undefined;
		await previous?.disconnect().catch(() => {});
		this.#sandbox = sandbox;
		this.#detachedBy = undefined;
		this.#bytesSinceAttach = 0;
		this.#output.reset();
		const handle = await sandbox.commands.connect(this.#pid, {
			timeoutMs: 0,
			onStdout: data => this.#feed(data),
			onStderr: data => this.#onStderr(data),
		});
		this.#attach(handle);
	}

	/** Stop receiving output; omp keeps running. */
	async detach(): Promise<void> {
		// A kill the SDK started when its client broke must not land on an omp the runner is about to re-adopt.
		clearTimeout(this.#killTimer);
		const handle = this.#handle;
		this.#handle = undefined;
		this.#detachedBy = new Error("detached");
		await handle?.disconnect().catch(() => {});
	}

	/** Writes one JSON line to stdin (serialized with every other write). */
	sendFrame(frame: Record<string, unknown>): Promise<void> {
		return this.#send(`${JSON.stringify(frame)}\n`);
	}

	peekStderr(): string {
		return this.#stderr;
	}

	/**
	 * Called by `RpcClient` when it stops, also when a stdin write failed because the sandbox was paused or unreachable:
	 * omp may be perfectly healthy then, and a SIGTERM that vmon delivers after the resume would kill it. The runner owns
	 * omp's lifetime (it re-adopts the process, or kills the sandbox), so this only notes that nobody listens any more.
	 */
	kill(_reason?: unknown, _graceMs?: number): void {
		this.#detachedBy ??= new Error("the client stopped");
	}

	/** SIGTERM, then SIGKILL if omp is still alive after `graceMs`: for an omp the runner itself gives up on. */
	terminate(graceMs: number = DEFAULT_KILL_GRACE_MS): void {
		if (this.#exitCode !== undefined) return;
		const sandbox = this.#sandbox;
		void sandbox.commands.run(`kill -s TERM ${this.#pid}`).catch(() => {});
		clearTimeout(this.#killTimer);
		this.#killTimer = setTimeout(() => {
			if (this.#exitCode === undefined) void sandbox.commands.kill(this.#pid).catch(() => {});
		}, graceMs);
		this.#killTimer.unref();
	}

	#attach(handle: CommandHandle): void {
		this.#handle = handle;
		handle.wait().then(
			result => this.#exit(result.exitCode),
			error => {
				if (error instanceof CommandExitError) this.#exit(error.exitCode);
				else if (this.#handle === handle) this.#detachedBy = error;
			},
		);
	}

	#exit(code: number): void {
		if (this.#exitCode !== undefined) return;
		this.#exitCode = code;
		this.#resolveExit(code);
		this.#output.close();
	}

	#feed(data: string): void {
		this.#bytesSinceAttach += Buffer.byteLength(data);
		this.#output.push(data);
	}

	#onStderr(data: string): void {
		this.#stderr = (this.#stderr + data).slice(-STDERR_TAIL_BYTES);
	}

	/** Sequential stdin: each write waits for the previous one; a failure rejects only its own write. */
	#send(data: string | Uint8Array): Promise<void> {
		const write = this.#tail.then(() => this.#sandbox.commands.sendStdin(this.#pid, data));
		this.#tail = write.catch(() => {});
		return write;
	}
}
