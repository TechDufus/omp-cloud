/**
 * "Installed" is not "loads": `omp plugin list` says the plugin is installed even when omp cannot import its entry. This
 * starts the host omp in RPC mode (`omp --mode rpc --no-session`, from an empty directory), reads its JSON frames and
 * decides from them whether the plugin's `/cloud` command is the real one. It never sends a command, so there is no
 * prompt and no model call, and the process is killed as soon as the answer is known.
 *
 * What the frames say (`@oh-my-pi/pi-coding-agent` rpc-mode): `available_commands_update` lists every slash command; the
 * real plugin registers `/cloud`. When `plugin/src/index.ts` cannot load `./main` it registers a bare `/cloud` whose
 * description starts with {@link LOAD_FAILED_MARKER}; that decides. The `notify` error frame it also emits is only read
 * for its text. When the extension itself fails to import, omp lists no `/cloud` at all.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../guards";
import { lastLine } from "../update/system";

/**
 * What the description of the `/cloud` that `plugin/src/index.ts` registers when `./main` cannot load starts with, followed
 * by the first line of the error. A literal because `src/` never imports `plugin/`: it is `LOAD_FAILED_MARKER` there.
 */
export const LOAD_FAILED_MARKER = "omp-cloud could not load:";

/** How the probe ended. `unknown`: omp could not be asked (not started, no answer in time); that proves nothing about the plugin. */
export type LoadVerdict = { state: "loads" } | { state: "broken"; reason: string } | { state: "unknown"; reason: string };

export interface ProbeOptions {
	/** The whole probe gives up after this long. Default 20 s. */
	timeoutMs?: number;
	/** How long a missing `/cloud` waits for a later command update before it counts as missing. Default 1.5 s. */
	graceMs?: number;
	/** Environment of the omp process; default is this process's. */
	env?: Record<string, string | undefined>;
}

/** The first line of the error notice about omp-cloud that omp relayed, if any: text for a report, never a reason to decide. */
function relayedError(frames: readonly unknown[]): string | undefined {
	for (const frame of frames) {
		if (!isRecord(frame) || frame.type !== "extension_ui_request" || frame.method !== "notify" || frame.notifyType !== "error") continue;
		const message = typeof frame.message === "string" ? frame.message : "";
		if (/omp-cloud/i.test(message)) return (message.split("\n", 1)[0] ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
	}
	return undefined;
}

/**
 * Decides from the frames read so far, from the command list alone. `undefined` means keep reading; `settled` says no
 * more is coming soon (the grace after the first command list ran out, or the process ended), so what is missing is missing.
 */
export function judgeFrames(frames: readonly unknown[], settled: boolean): LoadVerdict | undefined {
	let commands: readonly unknown[] | undefined;
	for (const frame of frames) {
		if (isRecord(frame) && frame.type === "available_commands_update" && Array.isArray(frame.commands)) commands = frame.commands;
	}
	if (commands === undefined) return settled ? { state: "unknown", reason: "omp printed no command list" } : undefined;
	const cloud = commands.find((command) => isRecord(command) && command.name === "cloud");
	if (!isRecord(cloud)) {
		return settled ? { state: "broken", reason: relayedError(frames) ?? "omp does not list /cloud, so it did not load the plugin" } : undefined;
	}
	const description = typeof cloud.description === "string" ? cloud.description : "";
	if (description.startsWith(LOAD_FAILED_MARKER)) return { state: "broken", reason: description.slice(LOAD_FAILED_MARKER.length).trim() || relayedError(frames) || "the plugin's entry could not load" };
	return { state: "loads" };
}

/** Runs `omp --mode rpc --no-session` until {@link judgeFrames} has an answer, then kills it. */
export async function probeOmp(ompPath: string, options: ProbeOptions = {}): Promise<LoadVerdict> {
	const cwd = await mkdtemp(join(tmpdir(), "omp-cloud-probe-"));
	let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	try {
		try {
			proc = Bun.spawn([ompPath, "--mode", "rpc", "--no-session"], { cwd, env: options.env ?? process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		} catch (error) {
			return { state: "unknown", reason: `could not start ${ompPath}: ${error instanceof Error ? error.message : String(error)}` };
		}
		const started = proc;
		const frames: unknown[] = [];
		let settled = false;
		let ended = false;
		const decided = Promise.withResolvers<LoadVerdict>();
		const check = (): void => {
			const verdict = judgeFrames(frames, settled);
			if (verdict !== undefined) decided.resolve(verdict);
		};
		const timers: Timer[] = [];
		timers.push(
			setTimeout(() => {
				settled = true;
				const verdict = judgeFrames(frames, true);
				decided.resolve(verdict?.state === "unknown" || verdict === undefined ? { state: "unknown", reason: `omp gave no answer within ${(options.timeoutMs ?? 20_000) / 1000} s` } : verdict);
			}, options.timeoutMs ?? 20_000),
		);
		let armed = false;
		const read = async (): Promise<void> => {
			const decoder = new TextDecoder();
			let pending = "";
			for await (const chunk of started.stdout) {
				pending += decoder.decode(chunk, { stream: true });
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					try {
						frames.push(JSON.parse(line));
					} catch {
						// Not a frame (a banner or log line): ignored.
					}
				}
				if (!armed && frames.some((frame) => isRecord(frame) && frame.type === "available_commands_update")) {
					armed = true;
					timers.push(
						setTimeout(() => {
							settled = true;
							check();
						}, options.graceMs ?? 1500),
					);
				}
				check();
			}
			ended = true;
			settled = true;
			const stderr = await new Response(started.stderr).text();
			const verdict = judgeFrames(frames, true);
			decided.resolve(verdict?.state === "unknown" && stderr.trim() !== "" ? { state: "unknown", reason: `omp exited: ${lastLine(stderr)}` } : (verdict ?? { state: "unknown", reason: "omp exited without an answer" }));
		};
		void read().catch((error: unknown) => decided.resolve({ state: "unknown", reason: error instanceof Error ? error.message : String(error) }));
		const verdict = await decided.promise;
		for (const timer of timers) clearTimeout(timer);
		if (!ended) {
			started.kill("SIGKILL");
			// Reaped before the verdict returns, so no zombie outlives the probe; SIGKILL cannot be caught, and the bound only
			// guards against a process stuck in an uninterruptible wait.
			await Promise.race([started.exited, Bun.sleep(2000)]);
		}
		return verdict;
	} finally {
		proc?.kill("SIGKILL");
		await rm(cwd, { recursive: true, force: true });
	}
}
