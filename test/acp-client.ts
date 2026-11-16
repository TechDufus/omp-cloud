/** An ACP host for the acceptance scenarios: it spawns `omp-cloud acp` and talks to it over stdio, as an editor does. */

import { join } from "node:path";
import { ClientSideConnection, ndJsonStream, type SessionNotification } from "@oh-my-pi/pi-utils/acp";

const REPO_ROOT = join(import.meta.dir, "..");

export interface AcpAgentProcess {
	connection: ClientSideConnection;
	/** Every `session/update` the agent sent, in order. */
	updates: SessionNotification[];
	/** Closes the agent's stdin, which ends it; its exit code. */
	close(): Promise<number>;
}

/**
 * Starts the agent with exactly `env` plus `PATH`: nothing of the caller's omp or omp-cloud configuration reaches it.
 * `command` is `bun src/bin.ts acp` of this checkout unless given (a release binary and `acp`). Permission requests are
 * answered as cancelled.
 */
export function startAcpAgent(env: Record<string, string>, command: readonly string[] = [process.execPath, join(REPO_ROOT, "src", "bin.ts"), "acp"]): AcpAgentProcess {
	const proc = Bun.spawn([...command], { cwd: REPO_ROOT, env: { ...env, PATH: process.env.PATH ?? "" }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	const toAgent = new WritableStream<Uint8Array>({
		write(chunk) {
			proc.stdin.write(chunk);
			proc.stdin.flush();
		},
	});
	const updates: SessionNotification[] = [];
	const connection = new ClientSideConnection(
		() => ({
			sessionUpdate: notification => void updates.push(notification),
			requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
		}),
		ndJsonStream(toAgent, proc.stdout),
	);
	return {
		connection,
		updates,
		close: async () => {
			await proc.stdin.end();
			return proc.exited;
		},
	};
}
