import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * infra/vmon-sync.sh, driven unprivileged in a temp directory with its VMON_SYNC_* overrides: a fake curl answers for the
 * server, a fake helper stands in for vmon-install and a fake vmon reports the installed version. Nothing here touches
 * /opt/vmon, /etc/omp-cloud or the network.
 */
const SCRIPT = join(import.meta.dir, "..", "..", "infra", "vmon-sync.sh");
const TOOLS = ["bash", "sed", "head", "date", "flock"];
const supported = process.platform === "linux" && TOOLS.every(tool => Bun.which(tool) !== null);

const URL = "https://192.0.2.7:8443";
const PIN = `sha256//${"A".repeat(43)}=`;
const NOW = () => Math.floor(Date.now() / 1000);

let dir: string;
const path = (name: string): string => join(dir, name);

async function script(name: string, body: string): Promise<string> {
	const file = path(name);
	await writeFile(file, `#!/bin/sh\n${body}\n`);
	await chmod(file, 0o755);
	return file;
}

interface Setup {
	/** The health body the fake curl prints; `null` makes it fail like an unreachable server. */
	health: string | null;
	/** `vmon --version` of the installed vmon; `null` leaves no binary. */
	installed: string | null;
	/** Exit status of the fake helper. */
	helperExit: number;
	/** Content of the state file before the run. */
	state: string | null;
	/** Content of node.env. */
	conf: string;
	/** The exit status of the fake curl; null: it answers with `health` (or fails like a timeout when that is null). */
	curlExit: number | null;
	/** What the fake helper prints on stdout. */
	helperOut: string;
	/** Extra shell the fake helper runs before it exits. */
	helperScript: string;
}

interface Outcome {
	code: number;
	stdout: string;
	stderr: string;
	/** Arguments of each call of the fake helper, one line per call. */
	helperCalls: string[];
	/** Arguments of each call of the fake curl. */
	curlCalls: string[];
	state: string | null;
}

async function sync(overrides: Partial<Setup> = {}, env: Record<string, string | undefined> = {}): Promise<Outcome> {
	const setup: Setup = { health: `{"status":"ok","version":"0.7.0","build":{"id":"dev"},"schema":17,"vmon":"v0.4.1"}`, installed: "vmon 0.4.0", helperExit: 0, state: null, conf: `SERVER_URL=${URL}\nSERVER_PIN=${PIN}\n`, curlExit: null, helperOut: "", helperScript: "", ...overrides };
	await writeFile(path("node.env"), setup.conf);
	await rm(path("helper.log"), { force: true });
	await rm(path("curl.log"), { force: true });
	const curl = await script("curl", [`echo "$@" >> ${path("curl.log")}`, setup.curlExit !== null ? `exit ${setup.curlExit}` : setup.health === null ? "exit 28" : `cat ${path("health.json")}`].join("\n"));
	if (setup.health !== null) await writeFile(path("health.json"), setup.health);
	const helper = await script("helper", [`echo "$@" >> ${path("helper.log")}`, ...(setup.helperOut === "" ? [] : [`echo '${setup.helperOut}'`]), setup.helperScript, `exit ${setup.helperExit}`].filter(line => line !== "").join("\n"));
	const binary = setup.installed === null ? path("no-vmon") : await script("vmon", `[ "$1" = --version ] && echo '${setup.installed}'\nexit 0`);
	if (setup.state !== null) await writeFile(path("state"), setup.state);
	const proc = Bun.spawn(["bash", SCRIPT], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "", VMON_SYNC_CONF: path("node.env"), VMON_SYNC_HELPER: helper, VMON_SYNC_BINARY: binary, VMON_SYNC_CURL: curl, VMON_SYNC_STATE: path("state"), VMON_SYNC_LOCK: path("lock"), ...env },
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	const lines = async (name: string): Promise<string[]> => (await readFile(path(name), "utf8").catch(() => "")).split("\n").filter(line => line !== "");
	return { code, stdout, stderr, helperCalls: await lines("helper.log"), curlCalls: await lines("curl.log"), state: await readFile(path("state"), "utf8").catch(() => null) };
}

beforeEach(async () => {
	if (supported) dir = await mkdtemp(join(tmpdir(), "omp-cloud-vmon-sync-"));
});

afterEach(async () => {
	if (supported) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!supported)("infra/vmon-sync.sh", () => {
	test("a different vmon on the server runs the helper with the tag, and a success leaves no state", async () => {
		const result = await sync({ state: "v0.4.0 1\n" });

		expect(result.code).toBe(0);
		expect(result.helperCalls).toEqual(["v0.4.1"]);
		expect(result.stdout).toBe("vmon-sync: the server runs vibemon v0.4.1, this machine v0.4.0: installing v0.4.1\n");
		expect(result.state).toBeNull();
	});

	test("asks the server over pinned https with the url and pin of node.env", async () => {
		const result = await sync();

		expect(result.curlCalls).toEqual([`-q -sk --proto =https --pinnedpubkey ${PIN} --max-filesize 65536 --max-time 10 ${URL}/api/v1/health`]);
	});

	test("an installed vmon that equals the server's exits 0, installs nothing and deletes the failure state", async () => {
		const result = await sync({ installed: "vmon 0.4.1", state: "v0.4.1 1\n" });

		expect(result.code).toBe(0);
		expect(result.helperCalls).toEqual([]);
		expect(result.stdout).toBe("");
		expect(result.state).toBeNull();
	});

	test("only the first line of `vmon --version` is compared", async () => {
		const result = await sync({ installed: "vmon 0.4.1\nbuilt yesterday" });

		expect(result.helperCalls).toEqual([]);
	});

	test("a server that does not answer is no error and installs nothing", async () => {
		const result = await sync({ health: null, state: `v0.4.1 ${NOW()}\n` });

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("vmon-sync: the server did not answer\n");
		expect(result.helperCalls).toEqual([]);
		expect(result.state).not.toBeNull();
	});

	test("an empty answer counts as no answer", async () => {
		const result = await sync({ health: "" });

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("vmon-sync: the server did not answer\n");
	});

	test.each([
		["vmon is null", `{"status":"ok","version":"0.7.0","build":{"id":"dev"},"schema":17,"vmon":null}`],
		["there is no vmon field (an older server)", `{"status":"ok","version":"0.6.0","build":{"id":"dev"},"schema":16}`],
		["the vmon value is not a tag", `{"status":"ok","vmon":"v0.4.1; touch x"}`],
		["the body is not JSON", "<html>502 Bad Gateway</html>"],
	])("exits 0 and installs nothing when %s", async (_name, health) => {
		const result = await sync({ health });

		expect(result.code).toBe(0);
		expect(result.helperCalls).toEqual([]);
		expect(result.state).toBeNull();
	});

	test("a vmon that is not installed is a mismatch: the server's tag is installed", async () => {
		const result = await sync({ installed: null });

		expect(result.code).toBe(0);
		expect(result.helperCalls).toEqual(["v0.4.1"]);
		expect(result.stdout).toContain("this machine none: installing v0.4.1");
	});

	test("a failed tag is not retried within the hour", async () => {
		const state = `v0.4.1 ${NOW() - 600}\n`;
		const result = await sync({ state });

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("vmon-sync: v0.4.1 failed less than an hour ago; not retrying yet\n");
		expect(result.helperCalls).toEqual([]);
		expect(result.state).toBe(state);
	});

	test("a failed tag is retried after the hour", async () => {
		const result = await sync({ state: `v0.4.1 ${NOW() - 3601}\n` });

		expect(result.helperCalls).toEqual(["v0.4.1"]);
		expect(result.state).toBeNull();
	});

	test("a failure of another tag does not hold back this one", async () => {
		const result = await sync({ state: `v0.4.0 ${NOW()}\n` });

		expect(result.helperCalls).toEqual(["v0.4.1"]);
		expect(result.state).toBeNull();
	});

	test("a state file from the future or with garbage does not block the install", async () => {
		expect((await sync({ state: `v0.4.1 ${NOW() + 100000}\n` })).helperCalls).toEqual(["v0.4.1"]);
		expect((await sync({ state: "garbage\n" })).helperCalls).toEqual(["v0.4.1"]);
	});

	test("a helper that fails writes `<tag> <epoch>` and exits 1", async () => {
		const before = NOW();
		const result = await sync({ helperExit: 3 });
		const [tag, epoch, ...rest] = (result.state ?? "").trim().split(" ");

		expect(result.code).toBe(1);
		expect(result.helperCalls).toEqual(["v0.4.1"]);
		expect(tag).toBe("v0.4.1");
		expect(rest).toEqual([]);
		expect(Number(epoch)).toBeGreaterThanOrEqual(before);
		expect(Number(epoch)).toBeLessThanOrEqual(NOW());
		expect(result.stderr).toContain("installing v0.4.1 failed");
	});

	test("a failure that is recorded stops the next run for an hour", async () => {
		const first = await sync({ helperExit: 1 });
		const second = await sync({ helperExit: 1, state: first.state });

		expect(first.helperCalls).toEqual(["v0.4.1"]);
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("failed less than an hour ago");
		expect(second.helperCalls).toEqual([]);
	});

	describe("node.env is data, never a script", () => {
		test("a line that does not match its pattern is not used, and nothing in the file is executed", async () => {
			const marker = path("executed");
			const result = await sync({ conf: `SERVER_URL=$(touch ${marker})\nSERVER_PIN=${PIN}\n` });

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("no valid SERVER_URL");
			expect(result.curlCalls).toEqual([]);
			expect(await stat(marker).catch(() => null)).toBeNull();
		});

		test.each([
			["a malformed SERVER_PIN", `SERVER_URL=${URL}\nSERVER_PIN=sha256//short=\n`, "SERVER_PIN"],
			["a SERVER_PIN with a command", `SERVER_URL=${URL}\nSERVER_PIN=${PIN}$(touch MARK)\n`, "SERVER_PIN"],
			["a SERVER_URL with a host name", `SERVER_URL=https://server.example:8443\nSERVER_PIN=${PIN}\n`, "SERVER_URL"],
			["a SERVER_URL over http", `SERVER_URL=http://192.0.2.7:8443\nSERVER_PIN=${PIN}\n`, "SERVER_URL"],
			["a SERVER_URL with a path", `SERVER_URL=https://192.0.2.7:8443/x\nSERVER_PIN=${PIN}\n`, "SERVER_URL"],
			["a quoted SERVER_URL", `SERVER_URL="${URL}"\nSERVER_PIN=${PIN}\n`, "SERVER_URL"],
			["no keys at all", "# nothing\n", "SERVER_URL"],
		])("%s is refused before the server is asked", async (_name, conf, key) => {
			const result = await sync({ conf: conf.replace("MARK", path("executed")) });

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`no valid ${key}`);
			expect(result.curlCalls).toEqual([]);
			expect(result.helperCalls).toEqual([]);
			expect(await stat(path("executed")).catch(() => null)).toBeNull();
		});

		test("other lines, comments and a missing final newline are fine and nothing else is read", async () => {
			const marker = path("executed");
			const result = await sync({ conf: `# node.env\nOTHER=$(touch ${marker})\nexport SERVER_URL=https://evil:1\nSERVER_URL=${URL}\nSERVER_PIN=${PIN}` });

			expect(result.code).toBe(0);
			expect(result.curlCalls).toEqual([`-q -sk --proto =https --pinnedpubkey ${PIN} --max-filesize 65536 --max-time 10 ${URL}/api/v1/health`]);
			expect(await stat(marker).catch(() => null)).toBeNull();
		});

		test("a missing node.env says this machine is not a node", async () => {
			const result = await sync({}, { VMON_SYNC_CONF: path("absent.env") });

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("not set up as a node");
		});
	});

	describe("the pin", () => {
		test("a certificate that is not the pinned one (curl exit 90) is a failure that installs nothing and writes no state", async () => {
			const result = await sync({ health: null, curlExit: 90 });

			expect(result.code).toBe(1);
			expect(result.stderr).toBe("vmon-sync: the server's certificate is not the pinned one\n");
			expect(result.stdout).toBe("");
			expect(result.helperCalls).toEqual([]);
			expect(result.state).toBeNull();
		});

		test("any other curl failure is just no answer: exit 0", async () => {
			for (const curlExit of [6, 7, 28, 63]) {
				const result = await sync({ health: null, curlExit });

				expect(result.code).toBe(0);
				expect(result.stdout).toBe("vmon-sync: the server did not answer\n");
				expect(result.stderr).toBe("");
			}
		});

		test("curl ignores root's curlrc and a large body: -q comes first and the body is capped", async () => {
			const [first, ...rest] = (await sync()).curlCalls[0]?.split(" ") ?? [];

			expect(first).toBe("-q");
			expect(rest.join(" ")).toContain("--max-filesize 65536");
		});
	});

	describe("the helper's install lock", () => {
		/** Holds the lock file like a running vmon-install until killed. */
		async function holdLock(): Promise<() => void> {
			const holder = Bun.spawn(["bash", "-c", `exec 9>${path("lock")}; flock -n 9 && echo held && exec sleep 60`], { stdout: "pipe", stderr: "ignore" });
			const reader = holder.stdout.getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toBe("held\n");
			return () => holder.kill();
		}

		test("an install running now is no failure: nothing is announced, run or recorded, and the exit is 0", async () => {
			const release = await holdLock();
			try {
				const result = await sync();

				expect(result.code).toBe(0);
				expect(result.stdout).toBe("vmon-sync: another vmon install is running; trying again next time\n");
				expect(result.helperCalls).toEqual([]);
				expect(result.state).toBeNull();
			} finally {
				release();
			}
		});

		test("a free lock is not held while the helper runs: the helper can take it", async () => {
			const result = await sync({ helperScript: `exec 9>${path("lock")}; flock -n 9 || exit 7` });

			expect(result.code).toBe(0);
			expect(result.helperCalls).toEqual(["v0.4.1"]);
		});

		test("a helper that refuses for the lock (it took it after the probe) leaves no state either", async () => {
			const result = await sync({ helperExit: 1, helperOut: `{"ok": false, "error": "another vmon install is running"}` });

			expect(result.code).toBe(0);
			expect(result.stdout).toContain("another vmon install is running; trying again next time");
			expect(result.state).toBeNull();
		});

		test("another failure of the helper is still recorded", async () => {
			const result = await sync({ helperExit: 1, helperOut: `{"ok": false, "error": "downloading vmon-assets-x86_64.tar.gz of vibemon v0.4.1 failed"}` });

			expect(result.code).toBe(1);
			expect(result.state).not.toBeNull();
		});
	});

	test("without the overrides an unprivileged run is a bad invocation", async () => {
		const proc = Bun.spawn(["bash", SCRIPT], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

		expect(code).toBe(2);
		expect(stderr).toContain("must run as root");
	});

	test("an argument is a bad invocation", async () => {
		const proc = Bun.spawn(["bash", SCRIPT, "v0.4.1"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });

		expect(await proc.exited).toBe(2);
	});

	// Running the tests as root is not done (AGENTS.md): this one only runs where the suite already is root.
	test.skipIf(process.getuid?.() !== 0)("as root every override is refused", async () => {
		for (const name of ["VMON_SYNC_CONF", "VMON_SYNC_HELPER", "VMON_SYNC_BINARY", "VMON_SYNC_CURL", "VMON_SYNC_STATE", "VMON_SYNC_LOCK"]) {
			const proc = Bun.spawn(["bash", SCRIPT], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", [name]: "/tmp/x" } });
			const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
			expect(code).toBe(2);
			expect(stderr).toContain(`${name} is a test override and is refused as root`);
		}
	});
});
