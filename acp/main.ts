/** `omp-cloud acp`: the ACP agent on stdio. An ACP host (Zed, another editor) spawns it and runs cloud threads through it. */

import { Readable, Writable } from "node:stream";
import { format } from "node:util";
import { AgentSideConnection, ndJsonStream } from "@oh-my-pi/pi-utils/acp";
import { CloudAcpAgent } from "./agent";
import { productionEnvironment } from "./environment";

/**
 * Keeps fd 1 for the protocol: returns the real stdout and points `process.stdout` and `console.log` at stderr, so nothing
 * the imported modules print can land between two frames. omp's ACP mode does the same (`modes/acp/acp-mode.ts`); its
 * helper is not exported.
 */
function isolateProtocolStdout(): NodeJS.WriteStream {
	const protocol = process.stdout;
	const detour = new Writable({
		write(chunk, _encoding, callback) {
			process.stderr.write(chunk, callback);
		},
	});
	Object.defineProperty(process, "stdout", { value: detour, configurable: true, writable: true });
	console.log = (...args: unknown[]): void => {
		process.stderr.write(`${format(...args)}\n`);
	};
	return protocol;
}

/** Serves ACP until the host closes stdin; the exit code. */
export async function acpMain(argv: readonly string[]): Promise<number> {
	if (argv.length > 0) {
		process.stderr.write("usage: omp-cloud acp\n");
		return 2;
	}
	if (process.stdin.isTTY) {
		process.stderr.write("omp-cloud acp: ACP agent speaking JSON-RPC over stdio. An ACP client such as Zed spawns it; it is not an interactive command.\n");
	}
	// As omp's ACP mode wires them: the web streams of the two stdio ends, without a cast.
	const transport = ndJsonStream(Writable.toWeb(isolateProtocolStdout()), Readable.toWeb(process.stdin));
	let agent: CloudAcpAgent | undefined;
	const connection = new AgentSideConnection(peer => {
		agent = new CloudAcpAgent(peer, productionEnvironment());
		return agent;
	}, transport);
	await connection.closed;
	agent?.dispose();
	return 0;
}
