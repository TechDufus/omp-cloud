import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "e2b";
import { DROP_ALL_SOCKETS, DROP_STALE_SOCKETS, dropStaleSockets } from "./stale-sockets";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-stale-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * Runs the cleanup script with a fake `ip` (the guest's addresses) and a fake `ss` (its sockets, `ss -K` recorded in
 * `destroyed`), in the shape the real tools print them.
 */
async function runScript(input: { addresses: string[]; sockets: string[][] }, script: string = DROP_STALE_SOCKETS): Promise<{ dropped: string[]; destroyed: string[] }> {
	const bin = join(dir, "bin");
	await Bun.$`mkdir -p ${bin}`.quiet();
	await writeFile(
		join(bin, "ip"),
		`#!/bin/sh\n${input.addresses.map(address => `echo '1: if inet ${address}/30 scope global'`).join("\n")}\n`,
	);
	const rows = input.sockets.map(([state, local, peer]) => `${state} 0 0 ${local} ${peer}`).join("\n");
	await writeFile(
		join(bin, "ss"),
		`#!/bin/sh\ncase "$*" in\n*-K*) echo "$*" >> ${join(dir, "destroyed")}; exit 0 ;;\nesac\ncat <<'EOF'\n${rows}\nEOF\n`,
	);
	await chmod(join(bin, "ip"), 0o755);
	await chmod(join(bin, "ss"), 0o755);
	const proc = Bun.spawn(["sh", "-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
	const [stdout, , code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	expect(code).toBe(0);
	const destroyed = await readFile(join(dir, "destroyed"), "utf8").catch(() => "");
	return { dropped: stdout.split("\n").filter(line => line !== ""), destroyed: destroyed.split("\n").filter(line => line !== "") };
}

describe("the cleanup script", () => {
	test("destroys the sockets of an address the guest no longer has and no others", async () => {
		const { dropped, destroyed } = await runScript({
			addresses: ["127.0.0.1", "172.20.0.126"],
			sockets: [
				["ESTAB", "172.20.0.138:45734", "10.254.254.1:32909"],
				["ESTAB", "172.20.0.138:45800", "10.254.254.1:32909"],
				["ESTAB", "172.20.0.126:50000", "10.254.254.1:32909"],
				["ESTAB", "127.0.0.1:47604", "127.0.0.1:49983"],
				["ESTAB", "[::1]:47604", "[::1]:49983"],
			],
		});

		expect(dropped).toEqual(["172.20.0.138"]);
		// One `ss -K` per stale address, not per socket, and none for a current or loopback one.
		expect(destroyed).toEqual(["-K -tn src 172.20.0.138"]);
	});

	test("leaves every socket alone when the guest still has all its addresses", async () => {
		const { dropped, destroyed } = await runScript({
			addresses: ["127.0.0.1", "172.20.0.126"],
			sockets: [
				["ESTAB", "172.20.0.126:45734", "10.254.254.1:32909"],
				["ESTAB", "127.0.0.1:47604", "127.0.0.1:49983"],
			],
		});

		expect(dropped).toEqual([]);
		expect(destroyed).toEqual([]);
	});

	test("does nothing without sockets", async () => {
		expect(await runScript({ addresses: ["127.0.0.1"], sockets: [] })).toEqual({ dropped: [], destroyed: [] });
	});
});

describe("the drop-everything script", () => {
	test("destroys the sockets of every non-loopback address, also one the guest still has", async () => {
		const { dropped, destroyed } = await runScript(
			{
				addresses: ["127.0.0.1", "172.20.0.126"],
				sockets: [
					["ESTAB", "172.20.0.126:45734", "10.254.254.1:32909"],
					["ESTAB", "172.20.0.126:45800", "10.254.254.1:4000"],
					["ESTAB", "127.0.0.1:47604", "127.0.0.1:49983"],
					["ESTAB", "[::1]:47604", "[::1]:49983"],
				],
			},
			DROP_ALL_SOCKETS,
		);

		expect(dropped).toEqual(["172.20.0.126"]);
		expect(destroyed).toEqual(["-K -tn src 172.20.0.126"]);
	});
});

describe("dropStaleSockets", () => {
	function sandboxRunning(run: (command: string, options: { user?: string; timeoutMs?: number }) => Promise<{ stdout: string }>): Sandbox {
		return { commands: { run } } as unknown as Sandbox;
	}

	test("runs the script as root and returns the addresses it dropped", async () => {
		const seen: { command: string; user?: string }[] = [];
		const sandbox = sandboxRunning(async (command, options) => {
			seen.push({ command, user: options.user });
			return { stdout: "172.20.0.138\n172.20.0.142\n" };
		});

		expect(await dropStaleSockets(sandbox)).toEqual(["172.20.0.138", "172.20.0.142"]);
		expect(seen).toEqual([{ command: DROP_STALE_SOCKETS, user: "root" }]);
	});

	test("a sandbox that cannot run it is left as it is", async () => {
		const sandbox = sandboxRunning(async () => {
			throw new Error("no root");
		});

		expect(await dropStaleSockets(sandbox)).toEqual([]);
	});

	test("all = true runs the drop-everything script", async () => {
		const seen: string[] = [];
		const sandbox = sandboxRunning(async command => {
			seen.push(command);
			return { stdout: "172.20.0.126\n" };
		});

		expect(await dropStaleSockets(sandbox, true)).toEqual(["172.20.0.126"]);
		expect(seen).toEqual([DROP_ALL_SOCKETS]);
	});
});
