/**
 * `mise run cleanhost -- <command>`: clean Debian 13 VMs on the local vmon, in the dedicated team `omp-cloud-test`, to try
 * `install.sh` and `omp-cloud setup` from scratch (KVM, systemd, nested vmon inside). Output is plain; the exit code is the
 * command's: `exec` exits with the VM command's own code (255 and a message on stderr when the VM or the call failed).
 *
 *   create [--keep]               a new VM; prints its id (and nothing else) on stdout. It is killed after 3 hours, or 24 with --keep
 *   exec <id> [--root] -- <cmd>   runs <cmd> as `user` (or root), streaming output; one argument is a shell script, several an argv
 *   put <id> <local> <remote>     copies a file in (the remote directory must exist and be writable by `user`)
 *   get <id> <remote> <local>     copies a file out
 *   destroy <id>                  kills the VM
 *   list                          the team's VMs: `<id> <state> <started>`
 *   template                      builds the clean template when it is missing (create does it on first use)
 *   nested                        tries a guest inside a throwaway clean VM; exit 0 when nested KVM works, 1 when it kills the VM
 */
import { chmod, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { connectClean, createClean, DEFAULT_LIFETIME_MS, destroyClean, ensureCleanTemplate, exec, KEEP_LIFETIME_MS, listClean, probeNestedKvm, shellQuote } from "../test/cleanhost/vmon";

const USAGE = `usage: cleanhost.ts create [--keep]
       cleanhost.ts exec <id> [--root] -- <command>...
       cleanhost.ts put <id> <local> <remote>
       cleanhost.ts get <id> <remote> <local>
       cleanhost.ts destroy <id>
       cleanhost.ts list
       cleanhost.ts template
       cleanhost.ts nested`;

const FAILED = 255;

function usage(message: string): never {
	console.error(`cleanhost: ${message}\n${USAGE}`);
	process.exit(2);
}

function log(line: string): void {
	console.error(line);
}

async function vmOf(id: string | undefined) {
	if (id === undefined || id === "") usage("a VM id is needed");
	const sandbox = await connectClean(id);
	if (sandbox === null) {
		console.error(`cleanhost: no VM ${id} in the omp-cloud-test team (cleanhost list shows them)`);
		process.exit(FAILED);
	}
	return sandbox;
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "create") {
		const flags = rest.filter(arg => arg !== "--keep");
		if (flags.length > 0) usage(`unknown argument ${JSON.stringify(flags[0])}`);
		const { sandbox, bootSeconds } = await createClean(rest.includes("--keep") ? KEEP_LIFETIME_MS : DEFAULT_LIFETIME_MS, log);
		log(`booted in ${bootSeconds.toFixed(1)} s`);
		console.log(sandbox.sandboxId);
		return 0;
	}
	if (command === "exec") {
		const split = rest.indexOf("--");
		if (split < 0) usage("exec needs `--` before the command");
		const head = rest.slice(0, split);
		const words = rest.slice(split + 1);
		if (words.length === 0) usage("exec needs a command after `--`");
		const [id, ...flags] = head;
		const unknown = flags.find(flag => flag !== "--root");
		if (unknown !== undefined) usage(`unknown argument ${JSON.stringify(unknown)}`);
		const sandbox = await vmOf(id);
		const script = words.length === 1 ? (words[0] ?? "") : words.map(shellQuote).join(" ");
		const result = await exec(sandbox, script, { root: flags.includes("--root"), stream: true, timeoutMs: 0 });
		return result.exitCode;
	}
	if (command === "put") {
		const [id, local, remote, ...extra] = rest;
		if (local === undefined || remote === undefined || extra.length > 0) usage("put takes <id> <local> <remote>");
		const sandbox = await vmOf(id);
		await sandbox.files.write(remote, Bun.file(local).stream(), { requestTimeoutMs: 600_000 });
		// A file written through the API is not executable: keep the local mode bits for what runs (a compiled binary).
		const mode = (await Bun.file(local).stat()).mode & 0o777;
		const result = await exec(sandbox, `chmod ${mode.toString(8)} ${shellQuote(remote)}`);
		if (result.exitCode !== 0) throw new Error(`chmod ${remote} failed: ${result.stderr.trim()}`);
		log(`${basename(local)} -> ${remote}`);
		return 0;
	}
	if (command === "get") {
		const [id, remote, local, ...extra] = rest;
		if (remote === undefined || local === undefined || extra.length > 0) usage("get takes <id> <remote> <local>");
		const sandbox = await vmOf(id);
		await writeFile(local, await sandbox.files.read(remote, { format: "bytes", requestTimeoutMs: 600_000 }));
		await chmod(local, 0o600);
		log(`${remote} -> ${local}`);
		return 0;
	}
	if (command === "destroy") {
		const [id, ...extra] = rest;
		if (id === undefined || extra.length > 0) usage("destroy takes <id>");
		if (!(await destroyClean(id))) {
			console.error(`cleanhost: no VM ${id} (already gone)`);
			return FAILED;
		}
		log(`destroyed ${id}`);
		return 0;
	}
	if (command === "list") {
		if (rest.length > 0) usage("list takes no arguments");
		for (const vm of await listClean()) console.log(`${vm.id} ${vm.state} ${vm.startedAt}`);
		return 0;
	}
	if (command === "template") {
		if (rest.length > 0) usage("template takes no arguments");
		const { name, seconds } = await ensureCleanTemplate(log);
		console.log(seconds === 0 ? `${name} (already built)` : `${name} (built in ${seconds.toFixed(1)} s)`);
		return 0;
	}
	if (command === "nested") {
		if (rest.length > 0) usage("nested takes no arguments");
		const { works, detail } = await probeNestedKvm();
		console.log(`nested KVM ${works ? "works" : "does NOT work"}: ${detail}`);
		return works ? 0 : 1;
	}
	return usage(command === undefined ? "a command is needed" : `unknown command ${JSON.stringify(command)}`);
}

try {
	process.exit(await main(process.argv.slice(2)));
} catch (error) {
	console.error(`cleanhost: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(FAILED);
}
