import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/guards";
import {
	excerpt,
	pairArgv,
	pairingAddresses,
	pairOverSsh,
	PAIR_TIMEOUT_MS,
	quoteArg,
	remoteCommand,
	spawnSsh,
	sshExecutable,
	sshHostName,
	type SshOutput,
	type SshPairInput,
	type SshRunner,
} from "../src/ssh";
import { UserError } from "../src/types";
import { cleanup, tmp } from "./helpers";
import { deviceToken, makeCert, sshPairRecord, type TestCert } from "./tls";

let cert: TestCert;
beforeAll(async () => {
	cert = await makeCert("service");
});
afterEach(cleanup);
afterAll(cleanup);

const ok = (stdout: string, over: Partial<SshOutput> = {}): SshOutput => ({ exitCode: 0, stdout, stderr: "", timedOut: false, ...over });
const target = { destination: "me@nas.local", port: undefined };
const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

/** A runner that answers every call with `out` and records the calls. */
function runner(out: SshOutput | (() => SshOutput)): { run: SshRunner; calls: { argv: readonly string[]; timeoutMs: number; signal: AbortSignal | undefined }[] } {
	const calls: { argv: readonly string[]; timeoutMs: number; signal: AbortSignal | undefined }[] = [];
	const run: SshRunner = async (argv, opts) => {
		calls.push({ argv, timeoutMs: opts.timeoutMs, signal: opts.signal });
		return typeof out === "function" ? out() : out;
	};
	return { run, calls };
}

const input = (run: SshRunner, over: Partial<SshPairInput> = {}): SshPairInput => ({ target, name: "laptop", platform: "linux", run, env: {}, ...over });

async function failure(p: Promise<unknown>): Promise<string> {
	const err = await p.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(UserError);
	return err instanceof Error ? err.message : "";
}

/** Runs `command` the way an ssh login shell does for a POSIX shell: `sh -c <command>`. */
async function login(command: string, env: Record<string, string>, cwd?: string): Promise<{ args: string[]; code: number }> {
	const proc = Bun.spawn(["sh", "-c", command], { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { args: out.split("\0").slice(0, -1), code };
}

describe("quoteArg and remoteCommand", () => {
	const NASTY = ["My Laptop", "it's", 'say "hi"', "$(touch PWNED)", "`touch PWNED`", "; touch PWNED", "a\nb", "*", "~", "\\", "-n", "", "'", "''", "a'b'c'"];

	test("every awkward argument arrives at omp-cloud as exactly one argument, and nothing in it runs", async () => {
		const dir = await tmp("omp-cloud-ssh-");
		const bin = join(dir, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "omp-cloud"), "#!/bin/sh\nprintf '%s\\0' \"$@\"\n");
		await chmod(join(bin, "omp-cloud"), 0o755);
		for (const name of NASTY) {
			const { args, code } = await login(remoteCommand(["ssh-pair", "--name", name, "--platform", "linux"]), { PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, "nohome") }, dir);
			expect(code).toBe(0);
			expect(args).toEqual(["ssh-pair", "--name", name, "--platform", "linux"]);
		}
		expect(await stat(join(dir, "PWNED")).catch(() => undefined)).toBeUndefined();
	});

	test("quoteArg alone round-trips through sh", async () => {
		for (const arg of NASTY) {
			const proc = Bun.spawn(["sh", "-c", `printf '%s' ${quoteArg(arg)}`], { stdout: "pipe" });
			expect(await new Response(proc.stdout).text()).toBe(arg);
		}
		expect(quoteArg("it's")).toBe(`'it'\\''s'`);
	});

	test("omp-cloud is taken from PATH first, then from $HOME/.local/bin, and a missing one exits 127", async () => {
		const dir = await tmp("omp-cloud-ssh-");
		const onPath = join(dir, "bin");
		const home = join(dir, "home");
		await mkdir(onPath);
		await mkdir(join(home, ".local", "bin"), { recursive: true });
		const script = (who: string) => `#!/bin/sh\nprintf '%s\\0' ${who}\n`;
		await writeFile(join(home, ".local", "bin", "omp-cloud"), script("home"));
		await chmod(join(home, ".local", "bin", "omp-cloud"), 0o755);
		const command = remoteCommand(["ssh-pair"]);

		expect((await login(command, { PATH: "/usr/bin:/bin", HOME: home })).args).toEqual(["home"]);
		await writeFile(join(onPath, "omp-cloud"), script("path"));
		await chmod(join(onPath, "omp-cloud"), 0o755);
		expect((await login(command, { PATH: `${onPath}:/usr/bin:/bin`, HOME: home })).args).toEqual(["path"]);
		expect((await login(command, { PATH: "/usr/bin:/bin", HOME: join(dir, "empty") })).code).toBe(127);
	});

	test("the remote command is one single-quoted word list, with no unquoted metacharacter for the login shell to read", () => {
		const command = remoteCommand(["ssh-pair", "--name", "it's $(id)", "--platform", "linux"]);
		expect(command.startsWith("'sh' '-c' '")).toBe(true);
		// Outside single quotes (the `'\''` of an embedded quote taken out first) there is only whitespace.
		const outside = command.replaceAll("'\\''", "").replace(/'[^']*'/g, "");
		expect(outside.trim()).toBe("");
		expect(command).toContain(`'it'\\''s $(id)'`);
	});
});

describe("pairArgv", () => {
	test("the ssh command line of a sample: batch mode, no tty, `--` before the target, one remote command word", () => {
		const argv = pairArgv("ssh", { destination: "me@nas.local", port: undefined }, "My Laptop", "linux");
		expect(argv.slice(0, 7)).toEqual(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--"]);
		expect(argv[7]).toBe("me@nas.local");
		expect(argv).toHaveLength(9);
		expect(argv[8]).toBe(remoteCommand(["ssh-pair", "--name", "My Laptop", "--platform", "linux"]));
	});

	test("a port goes before the `--`, and the executable is the one given", () => {
		const argv = pairArgv("/opt/ssh", { destination: "nas", port: 2222 }, "box", "darwin");
		expect(argv.slice(0, 9)).toEqual(["/opt/ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "2222", "--"]);
		expect(argv[9]).toBe("nas");
	});

	test("OMP_CLOUD_SSH names the executable; blank or absent is ssh", () => {
		expect(sshExecutable({ OMP_CLOUD_SSH: "/opt/bin/my-ssh" })).toBe("/opt/bin/my-ssh");
		expect(sshExecutable({ OMP_CLOUD_SSH: "  /opt/bin/my-ssh \n" })).toBe("/opt/bin/my-ssh");
		expect(sshExecutable({ OMP_CLOUD_SSH: "" })).toBe("ssh");
		expect(sshExecutable({ OMP_CLOUD_SSH: "   " })).toBe("ssh");
		expect(sshExecutable({})).toBe("ssh");
	});
});

describe("pairOverSsh", () => {
	const token = deviceToken();
	let record: Record<string, unknown>;
	beforeAll(() => {
		record = sshPairRecord(cert, "10.0.0.5:8443", token);
	});

	test("runs the pairing call once with the 60 s limit and the signal, and returns the delivered pairing", async () => {
		const r = runner(ok(line(record)));
		const abort = new AbortController();
		const pairing = await pairOverSsh(input(r.run, { signal: abort.signal, env: { OMP_CLOUD_SSH: "/opt/my-ssh" } }));

		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]?.argv).toEqual(pairArgv("/opt/my-ssh", target, "laptop", "linux"));
		expect(r.calls[0]?.timeoutMs).toBe(60_000);
		expect(PAIR_TIMEOUT_MS).toBe(60_000);
		expect(r.calls[0]?.signal).toBe(abort.signal);
		expect(pairing).toMatchObject({ device: { id: "dev12345abcdef", name: "laptop-2" }, token, fingerprint: cert.fingerprint, certificate: cert.der.toString("base64"), port: 8443 });
		expect(pairing.addresses.map(a => a.text)).toEqual(["10.0.0.5:8443"]);
	});

	test("banner and other lines before the record are skipped; the last record wins; other JSON lines are not records", async () => {
		const older = sshPairRecord(cert, "10.0.0.9:1", deviceToken());
		const stdout = [
			"Welcome to nas (Linux 6.1)",
			"Last login: yesterday",
			JSON.stringify({ ompCloudPair: 2, token: "future" }),
			JSON.stringify(older),
			"{not json",
			JSON.stringify({ unrelated: true }),
			JSON.stringify(record),
			"",
		].join("\r\n");
		const pairing = await pairOverSsh(input(runner(ok(stdout)).run));
		expect(pairing.token).toBe(token);
		expect(pairing.port).toBe(8443);
	});

	test("addresses the server lists that are not host:port are dropped, valid ones kept in order", async () => {
		const odd = sshPairRecord(cert, "10.0.0.5:8443", token, { server: { ...(isRecord(record.server) ? record.server : {}), addresses: ["nas.local:8443", 7, "not an address", "[fd00::1]:8443", "10.0.0.5:99999"] } });
		const pairing = await pairOverSsh(input(runner(ok(line(odd))).run));
		expect(pairing.addresses.map(a => a.text)).toEqual(["nas.local:8443", "[fd00::1]:8443"]);
	});

	test("the server's own refusal is shown, whatever the exit status", async () => {
		for (const exitCode of [1, 0]) {
			const refused = ok(line({ ompCloudPair: 1, error: "this service has no remote listener configured" }), { exitCode });
			const message = await failure(pairOverSsh(input(runner(refused).run)));
			expect(message).toBe("☁ the server on me@nas.local refused: this service has no remote listener configured");
		}
	});

	test("a record with a token is never used when ssh exited non-zero, and the message never holds the token", async () => {
		const out = ok(line(record), { exitCode: 255, stderr: `weird: ${token}` });
		const message = await failure(pairOverSsh(input(runner(out).run)));
		expect(message).toContain("failed (exit 255)");
		expect(message).not.toContain(token);
		expect(message).toContain("ompd_…");
	});

	describe("hints", () => {
		const hint = (out: Partial<SshOutput>, over: Partial<SshPairInput> = {}): Promise<string> => failure(pairOverSsh(input(runner({ exitCode: 255, stdout: "", stderr: "", timedOut: false, ...out }).run, over)));

		test("exit 127: omp-cloud is not installed", async () => {
			expect(await hint({ exitCode: 127, stderr: "zsh:1: command not found: omp-cloud" })).toBe(
				"☁ omp-cloud is not installed on me@nas.local: install it there and run omp-cloud setup",
			);
		});

		test("host key not known: run ssh once, with the port when there is one", async () => {
			const stderr = "No ED25519 host key is known for nas.local and you have requested strict checking.\r\nHost key verification failed.\r\n";
			expect(await hint({ stderr })).toBe("☁ ssh does not know the host key of me@nas.local: run ssh me@nas.local once to accept its host key, then retry");
			expect(await hint({ stderr }, { target: { destination: "me@nas.local", port: 2222 } })).toBe(
				"☁ ssh does not know the host key of me@nas.local (port 2222): run ssh -p 2222 me@nas.local once to accept its host key, then retry",
			);
		});

		test("a changed host key is not an invitation to accept it", async () => {
			const stderr = "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n";
			const message = await hint({ stderr });
			expect(message).toContain("changed");
			expect(message).toContain("find out why");
			expect(message).not.toContain("once to accept");
		});

		test("permission denied: key-based ssh", async () => {
			expect(await hint({ stderr: "me@nas.local: Permission denied (publickey,password).\n" })).toBe(
				"☁ ssh to me@nas.local was refused: set up key-based ssh (ssh-copy-id me@nas.local); /cloud connect never asks for a password",
			);
		});

		test("a permission error from the remote program is not mistaken for a refused login", async () => {
			const message = await hint({ exitCode: 1, stderr: "omp-cloud: Permission denied opening the store" });
			expect(message).not.toContain("key-based");
			expect(message).toContain("failed (exit 1): omp-cloud: Permission denied opening the store");
		});

		test("timeout", async () => {
			expect(await hint({ exitCode: null, timedOut: true })).toBe(
				"☁ ssh to me@nas.local timed out after 60 s; check that the host is reachable and runs sshd (ssh me@nas.local shows what ssh says)",
			);
		});

		test("exit 0 without a record, and a record that cannot be right: malformed", async () => {
			const malformed = "did not answer with a pairing record; does the server's omp-cloud have ssh-pair (run omp-cloud setup on the server)?";
			expect(await hint({ exitCode: 0, stdout: "Welcome\nsomething else\n" })).toBe(`☁ me@nas.local ${malformed}`);
			expect(await hint({ exitCode: 0, stdout: "" })).toBe(`☁ me@nas.local ${malformed}`);

			const bad = "answered with a pairing record that is not valid; does the server's omp-cloud have ssh-pair (run omp-cloud setup on the server)?";
			const server = isRecord(record.server) ? record.server : {};
			const impostor = await makeCert("other");
			for (const broken of [
				{ token: "short" },
				{ token: undefined },
				{ device: { id: "x" } },
				{ device: { id: "", name: "n" } },
				{ server: undefined },
				{ server: { ...server, port: 0 } },
				{ server: { ...server, port: "8443" } },
				{ server: { ...server, addresses: "10.0.0.5:8443" } },
				{ server: { ...server, certificate: "bm90IGEgY2VydA==" } },
				// A certificate that does not hash to the fingerprint: the fingerprint is what verification trusts, so they must agree.
				{ server: { ...server, certificate: impostor.der.toString("base64") } },
				{ server: { ...server, fingerprint: impostor.fingerprint } },
			]) {
				const out = ok(line({ ...record, ...broken }));
				expect(await failure(pairOverSsh(input(runner(out).run)))).toBe(`☁ me@nas.local ${bad}`);
			}
		});

		test("a generic failure shows a short excerpt of stderr", async () => {
			expect(await hint({ stderr: "ssh: connect to host nas.local port 22: Connection refused\n" })).toBe("☁ ssh to me@nas.local failed (exit 255): ssh: connect to host nas.local port 22: Connection refused");
			expect(await hint({ stderr: "" })).toBe("☁ ssh to me@nas.local failed (exit 255)");
		});
	});
});

describe("excerpt", () => {
	test("is one line without control or format characters, short, and without a token", () => {
		const text = `\u001b[31mred\u001b[0m\u0007 bell\r\nsecond\tline \u202Eevil\u200B ${deviceToken()}`;
		const out = excerpt(text);
		expect(out).toBe("red bell second line evil ompd_…");
		expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
		const long = excerpt("x".repeat(5000));
		expect(long).toHaveLength(200);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("host name and addresses", () => {
	test("sshHostName reads the hostname line of ssh -G (after ssh_config), with the port and the executable honoured", async () => {
		const r = runner(ok("user me\nhostname nas.real.lan\nport 22\nidentityfile ~/.ssh/id\n"));
		const named = await sshHostName(input(r.run, { target: { destination: "nas", port: 2200 }, env: { OMP_CLOUD_SSH: "/opt/my-ssh" } }));
		expect(named).toEqual({ host: "nas.real.lan" });
		expect(r.calls[0]?.argv).toEqual(["/opt/my-ssh", "-G", "-p", "2200", "--", "nas"]);
		expect(r.calls[0]?.timeoutMs).toBeLessThan(PAIR_TIMEOUT_MS);
	});

	test("a failed or empty ssh -G is a problem to report, never an error; an abort still propagates", async () => {
		expect((await sshHostName(input(runner(ok("", { exitCode: 255 })).run))).problem).toContain("did not give a host name for me@nas.local (exit 255)");
		expect((await sshHostName(input(runner(ok("user me\n")).run))).problem).toContain("did not give a host name");
		const broken: SshRunner = async () => {
			throw new Error("spawn \u001b[31mexploded");
		};
		expect((await sshHostName(input(broken))).problem).toBe("could not ask ssh for the host name of me@nas.local (spawn exploded)");
		const abort = new AbortController();
		abort.abort();
		const cancelled: SshRunner = async () => {
			throw new UserError("☁ connect cancelled");
		};
		await expect(sshHostName(input(cancelled, { signal: abort.signal }))).rejects.toThrow("cancelled");
	});

	test("the host name comes first with the port the server reported, then the server's addresses, without duplicates", () => {
		const server = [{ host: "10.0.0.5", port: 8443, text: "10.0.0.5:8443" }, { host: "NAS.real.lan", port: 8443, text: "NAS.real.lan:8443" }];
		expect(pairingAddresses("nas.real.lan", { port: 8443, addresses: server })).toEqual({
			addresses: [{ host: "nas.real.lan", port: 8443, text: "nas.real.lan:8443" }, ...server.slice(0, 1)],
			problem: undefined,
		});
		expect(pairingAddresses("fd00::5", { port: 9443, addresses: server }).addresses.map(a => a.text)).toEqual(["[fd00::5]:9443", "10.0.0.5:8443", "NAS.real.lan:8443"]);
		expect(pairingAddresses(undefined, { port: 8443, addresses: server }).addresses).toEqual(server);
	});

	test("a host name ssh gives that is no address is reported and skipped", () => {
		const server = [{ host: "10.0.0.5", port: 8443, text: "10.0.0.5:8443" }];
		const got = pairingAddresses("bad_host!", { port: 8443, addresses: server });
		expect(got.addresses).toEqual(server);
		expect(got.problem).toContain("not an address");
	});
});

describe("spawnSsh", () => {
	const never = new AbortController().signal;

	test("stdin is ignored: a program that reads it sees end of file at once", async () => {
		const out = await spawnSsh(["sh", "-c", "cat; echo eof"], { timeoutMs: 5000, signal: never });
		expect(out).toEqual({ exitCode: 0, stdout: "eof\n", stderr: "", timedOut: false });
	});

	test("stdout, stderr and the exit status come back; a banner before the last line survives", async () => {
		const out = await spawnSsh(["sh", "-c", "echo banner; echo oops >&2; echo '{\"last\":1}'; exit 3"], { timeoutMs: 5000 });
		expect(out).toEqual({ exitCode: 3, stdout: 'banner\n{"last":1}\n', stderr: "oops\n", timedOut: false });
	});

	// A real clock on a real process: the point is that the child is killed at the limit, which a fake timer cannot show.
	test("the timeout kills the process and says so", async () => {
		const started = Date.now();
		const out = await spawnSsh(["sh", "-c", "exec sleep 30"], { timeoutMs: 150 });
		expect(out.timedOut).toBe(true);
		expect(out.exitCode).toBeNull();
		expect(Date.now() - started).toBeLessThan(5000);
	});

	test("an abort kills the process and rejects with a cancellation", async () => {
		const abort = new AbortController();
		// spawnSsh starts the process before its first await, so aborting at once kills a live process.
		const pending = spawnSsh(["sh", "-c", "exec sleep 30"], { timeoutMs: 20_000, signal: abort.signal });
		abort.abort();
		expect(await failure(pending)).toBe("☁ connect cancelled");
	});

	test("a program that does not exist is explained, with OMP_CLOUD_SSH as the way out", async () => {
		const message = await failure(spawnSsh(["/nonexistent/dir/ssh", "-G"], { timeoutMs: 5000 }));
		expect(message).toContain("cannot run /nonexistent/dir/ssh");
		expect(message).toContain("OMP_CLOUD_SSH");
	});

	test("only the last megabyte of a flood is kept, so the record at the end is never lost", async () => {
		const out = await spawnSsh(["sh", "-c", "head -c 3000000 /dev/zero | tr '\\0' x; echo; echo END"], { timeoutMs: 20_000 });
		expect(out.stdout.length).toBeLessThanOrEqual(1 << 20);
		expect(out.stdout.endsWith("\nEND\n")).toBe(true);
	});
});

describe("a fake ssh binary that behaves like ssh", () => {
	/** An `ssh` that logs its argv, answers `-G`, prints a banner and runs the remote command through `sh -c "$*"`, as sshd does. */
	async function fakeSsh(): Promise<{ ssh: string; log: string; argsLog: string }> {
		const dir = await tmp("omp-cloud-fakessh-");
		const bin = join(dir, "bin");
		await mkdir(bin);
		const log = join(dir, "ssh.argv");
		const argsLog = join(dir, "omp-cloud.argv");
		const token = deviceToken();
		await writeFile(join(dir, "record.json"), line(sshPairRecord(cert, "10.0.0.5:8443", token)));
		await writeFile(join(bin, "omp-cloud"), `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsLog}'\ncat '${join(dir, "record.json")}'\n`);
		await chmod(join(bin, "omp-cloud"), 0o755);
		const ssh = join(dir, "fake-ssh");
		await writeFile(
			ssh,
			`#!/bin/sh\nprintf '%s\\0' "$@" > '${log}'\ncase "$1" in -G) echo 'hostname nas.real.lan'; exit 0;; esac\nwhile [ "$1" != "--" ]; do shift; done\nshift; shift\necho 'Welcome banner'\nPATH='${bin}':"$PATH" exec sh -c "$*"\n`,
		);
		await chmod(ssh, 0o755);
		return { ssh, log, argsLog };
	}

	test("through OMP_CLOUD_SSH and a real shell: the name with a space reaches omp-cloud as one argument and the record is read past the banner", async () => {
		const f = await fakeSsh();
		const pairing = await pairOverSsh({ target: { destination: "me@nas.local", port: 2222 }, name: "My Laptop", platform: "linux", run: spawnSsh, env: { OMP_CLOUD_SSH: f.ssh } });

		expect(pairing.port).toBe(8443);
		expect(pairing.device.name).toBe("laptop-2");
		const sshArgv = (await readFile(f.log, "utf8")).split("\0").slice(0, -1);
		expect(sshArgv.slice(0, 9)).toEqual(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "2222", "--", "me@nas.local"]);
		expect((await readFile(f.argsLog, "utf8")).split("\0").slice(0, -1)).toEqual(["ssh-pair", "--name", "My Laptop", "--platform", "linux"]);

		const named = await sshHostName({ target, name: "x", platform: "linux", run: spawnSsh, env: { OMP_CLOUD_SSH: f.ssh } });
		expect(named).toEqual({ host: "nas.real.lan" });
	});
});
