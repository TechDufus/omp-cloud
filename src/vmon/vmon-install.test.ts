import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../guards";

/**
 * infra/vmon-install.sh, driven unprivileged in a temp directory: a static server stands in for GitHub's release downloads and
 * a fake `systemctl` for systemd. Nothing here touches /opt/vmon, a real unit or the network.
 */
const HELPER = join(import.meta.dir, "..", "..", "infra", "vmon-install.sh");
const TOOLS = ["bash", "curl", "flock", "tar", "sha256sum", "timeout"];
const supported = process.platform === "linux" && TOOLS.every(tool => Bun.which(tool) !== null);

const BIN_TAR = "vmon-x86_64-unknown-linux-musl.tar.gz";
const ASSETS_TAR = "vmon-assets-x86_64.tar.gz";
const UNIT = "vmon-test";

let dir: string;
let root: string;
let server: Bun.Server<undefined>;
/** Release files by URL path (`/releases/v0.4.1/<file>`). */
let files: Map<string, Uint8Array>;
let requests: string[];

const sha256 = (data: Uint8Array | string): string => new Bun.CryptoHasher("sha256").update(data).digest("hex");

async function run(argv: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(argv, { cwd, stdout: "ignore", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}: ${stderr}`);
}

/** A vmon stand-in that reports `vmon <version>`; `broken` makes the health server answer 500 while it is installed. */
function fakeVmonScript(version: string, broken = false): string {
	return `#!/bin/sh\n[ "$1" = --version ] && echo "vmon ${version}"\n${broken ? "# BROKEN\n" : ""}exit 0\n`;
}

/** Puts a release `tag` (x.y.z of its vmon) into the static server, with sidecars. `broken` builds a vmon that never gets healthy. */
async function publish(tag: string, options: { broken?: boolean } = {}): Promise<void> {
	const build = join(dir, `build-${tag}`);
	const vmonDir = join(build, "vmon-x86_64-unknown-linux-musl");
	const assetsDir = join(build, "vmon-assets-x86_64");
	await mkdir(vmonDir, { recursive: true });
	await mkdir(assetsDir, { recursive: true });
	await writeFile(join(vmonDir, "vmon"), fakeVmonScript(tag.slice(1), options.broken === true));
	await writeFile(join(assetsDir, "vmon-agent-x86_64"), "agent");
	await writeFile(join(assetsDir, "vmon-kernel-x86_64"), `kernel of ${tag}`);
	await run(["tar", "-czf", join(build, BIN_TAR), "vmon-x86_64-unknown-linux-musl"], build);
	await run(["tar", "-czf", join(build, ASSETS_TAR), "vmon-assets-x86_64"], build);
	for (const name of [BIN_TAR, ASSETS_TAR]) {
		const data = new Uint8Array(await Bun.file(join(build, name)).arrayBuffer());
		files.set(`/releases/${tag}/${name}`, data);
		files.set(`/releases/${tag}/${name}.sha256`, new TextEncoder().encode(`${sha256(data)}  ${name}\n`));
	}
}

async function installFakeVmon(version: string): Promise<void> {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "vmon"), fakeVmonScript(version));
	await chmod(join(root, "vmon"), 0o755);
}

async function installedVersion(): Promise<string> {
	const proc = Bun.spawn([join(root, "vmon"), "--version"], { stdout: "pipe" });
	return (await new Response(proc.stdout).text()).trim();
}

interface Outcome {
	code: number;
	stdout: string;
	stderr: string;
	verdict: Record<string, unknown>;
	systemctl: string[];
}

/** Runs the helper with `args`; the unit is `active` (a fake systemctl that answers is-active) unless told otherwise. */
async function helper(
	args: string[],
	options: { active?: boolean; restartFails?: boolean; env?: Record<string, string>; healthWait?: number; node?: boolean } = {},
): Promise<Outcome> {
	const systemctl = join(dir, "systemctl");
	const log = join(dir, "systemctl.log");
	await writeFile(
		systemctl,
		[
			"#!/bin/sh",
			'echo "$@" >> "$FAKE_LOG"',
			'case "$1" in',
			'  is-active) [ -e "$FAKE_ACTIVE" ] && { [ -z "$FAKE_ROOT" ] || ! grep -q BROKEN "$FAKE_ROOT/vmon" 2>/dev/null; } ;;',
			'  restart) [ ! -e "$FAKE_RESTART_FAIL" ] ;;',
			"esac",
			"",
		].join("\n"),
	);
	await chmod(systemctl, 0o755);
	const active = join(dir, "unit-active");
	const restartFail = join(dir, "restart-fails");
	await rm(active, { force: true });
	await rm(restartFail, { force: true });
	if (options.active !== false) await writeFile(active, "");
	if (options.restartFails === true) await writeFile(restartFail, "");
	await rm(log, { force: true });
	// A node's unit file says `--role node`; its vmon opens no listener, so health is the unit staying active. `sleep` is
	// replaced by a no-op so the 10 one-second checks take no time, and a "BROKEN" vmon in $FAKE_ROOT makes the unit inactive.
	const units = join(dir, "units");
	const bin = join(dir, "bin");
	await mkdir(units, { recursive: true });
	await mkdir(bin, { recursive: true });
	await writeFile(join(units, `${UNIT}.service`), `[Service]\nExecStart=/opt/vmon/vmon serve${options.node === true ? " --role node " : " "}--bind 0.0.0.0\n`);
	await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
	await chmod(join(bin, "sleep"), 0o755);
	const proc = Bun.spawn(["bash", HELPER, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: `${options.node === true ? `${bin}:` : ""}${process.env.PATH ?? ""}`,
			VMON_INSTALL_ROOT: root,
			VMON_INSTALL_UNIT: UNIT,
			VMON_INSTALL_BASE: `http://127.0.0.1:${server.port}/releases`,
			VMON_INSTALL_HEALTH_URL: `http://127.0.0.1:${server.port}/health`,
			VMON_INSTALL_HEALTH_WAIT: String(options.healthWait ?? 5),
			VMON_INSTALL_SYSTEMCTL: systemctl,
			VMON_INSTALL_UNIT_DIR: units,
			FAKE_ROOT: options.node === true ? root : "",
			FAKE_LOG: log,
			FAKE_ACTIVE: active,
			FAKE_RESTART_FAIL: restartFail,
			...options.env,
		},
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	const last = stdout.trim().split("\n").at(-1) ?? "";
	const verdict: unknown = JSON.parse(last);
	if (!isRecord(verdict)) throw new Error(`the last stdout line is not a JSON object: ${last}`);
	const logged = await readFile(log, "utf8").catch(() => "");
	return { code, stdout, stderr, verdict, systemctl: logged.split("\n").filter(line => line !== "") };
}

beforeAll(() => {
	if (!supported) return;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async req => {
			const { pathname } = new URL(req.url);
			requests.push(pathname);
			if (pathname === "/health") {
				const text = await Bun.file(join(root, "vmon")).text().catch(() => "");
				return new Response(null, { status: text.includes("BROKEN") ? 500 : 204 });
			}
			const body = files.get(pathname);
			return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
		},
	});
});

afterAll(async () => {
	await server?.stop(true);
});

beforeEach(async () => {
	if (!supported) return;
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-vmon-install-"));
	root = join(dir, "opt", "vmon");
	await mkdir(join(dir, "opt"), { recursive: true });
	files = new Map();
	requests = [];
});

afterEach(async () => {
	if (supported) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!supported)("infra/vmon-install.sh", () => {
	test("installs the release, keeps the previous directory, restarts the unit once and reports the tag", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1");

		const result = await helper(["v0.4.1"]);

		expect(result.verdict).toEqual({ ok: true, version: "v0.4.1" });
		expect(result.code).toBe(0);
		expect(await installedVersion()).toBe("vmon 0.4.1");
		expect(await readFile(join(`${root}.prev`, "vmon"), "utf8")).toContain("0.4.0");
		expect(await readFile(join(root, "vmon-kernel-x86_64"), "utf8")).toBe("kernel of v0.4.1");
		expect((await stat(join(root, "vmon"))).mode & 0o777).toBe(0o755);
		expect((await stat(join(root, "vmon-agent-x86_64"))).mode & 0o777).toBe(0o755);
		expect((await stat(join(root, "vmon-kernel-x86_64"))).mode & 0o777).toBe(0o644);
		expect(result.systemctl).toEqual([`is-active --quiet ${UNIT}`, `restart ${UNIT}`]);
		expect(requests.filter(path => path.startsWith("/releases/")).sort()).toEqual(
			[BIN_TAR, `${BIN_TAR}.sha256`, ASSETS_TAR, `${ASSETS_TAR}.sha256`].map(name => `/releases/v0.4.1/${name}`).sort(),
		);
		// No staging directory or half-installed tree is left beside the install.
		expect((await readdir(join(dir, "opt"))).filter(name => name.includes("install.") && !name.endsWith(".lock")).sort()).toEqual([]);
	});

	test("a second install replaces the first previous directory", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1");
		await publish("v0.4.2");
		await helper(["v0.4.1"]);

		const result = await helper(["v0.4.2"]);

		expect(result.verdict).toEqual({ ok: true, version: "v0.4.2" });
		expect(await readFile(join(`${root}.prev`, "vmon"), "utf8")).toContain("0.4.1");
		expect(await installedVersion()).toBe("vmon 0.4.2");
	});

	test("a first install (nothing at the install root) leaves no previous directory", async () => {
		await publish("v0.4.1");

		const result = await helper(["v0.4.1"]);

		expect(result.verdict).toEqual({ ok: true, version: "v0.4.1" });
		expect(await installedVersion()).toBe("vmon 0.4.1");
		expect(await Bun.file(join(`${root}.prev`, "vmon")).exists()).toBe(false);
	});

	test("a unit that is not running is not started: the files are installed and nothing restarts", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1");

		const result = await helper(["v0.4.1"], { active: false });

		expect(result.verdict).toEqual({ ok: true, version: "v0.4.1" });
		expect(await installedVersion()).toBe("vmon 0.4.1");
		expect(result.systemctl).toEqual([`is-active --quiet ${UNIT}`]);
	});

	test("the tag that is already installed downloads and restarts nothing", async () => {
		await installFakeVmon("0.4.1");

		const result = await helper(["v0.4.1"]);

		expect(result.verdict).toEqual({ ok: true, version: "v0.4.1" });
		expect(requests).toEqual([]);
		expect(result.systemctl).toEqual([]);
	});

	test("a tarball that does not match its sidecar is refused before anything changes", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1");
		files.set(`/releases/v0.4.1/${BIN_TAR}.sha256`, new TextEncoder().encode(`${"0".repeat(64)}  ${BIN_TAR}\n`));

		const result = await helper(["v0.4.1"]);

		expect(result.code).toBe(1);
		expect(result.verdict.ok).toBe(false);
		expect(String(result.verdict.error)).toContain("sha256");
		expect(await installedVersion()).toBe("vmon 0.4.0");
		expect(await Bun.file(join(`${root}.prev`, "vmon")).exists()).toBe(false);
		expect(result.systemctl).toEqual([]);
	});

	test("a sidecar that names another file is refused", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1");
		const data = files.get(`/releases/v0.4.1/${BIN_TAR}`) ?? new Uint8Array();
		files.set(`/releases/v0.4.1/${BIN_TAR}.sha256`, new TextEncoder().encode(`${sha256(data)}  something-else.tar.gz\n`));

		const result = await helper(["v0.4.1"]);

		expect(result.code).toBe(1);
		expect(String(result.verdict.error)).toContain("something-else.tar.gz");
		expect(await installedVersion()).toBe("vmon 0.4.0");
	});

	test("a release that is not there fails the download and changes nothing", async () => {
		await installFakeVmon("0.4.0");

		const result = await helper(["v9.9.9"]);

		expect(result.code).toBe(1);
		expect(String(result.verdict.error)).toContain("downloading");
		expect(await installedVersion()).toBe("vmon 0.4.0");
	});

	test("a vmon that reports another version than its tag is refused", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1");
		// The tarballs of v0.4.1 hold a vmon that says 0.4.7.
		await publish("v0.4.7");
		for (const name of [BIN_TAR, `${BIN_TAR}.sha256`, ASSETS_TAR, `${ASSETS_TAR}.sha256`]) {
			const body = files.get(`/releases/v0.4.7/${name}`);
			if (body !== undefined) files.set(`/releases/v0.4.1/${name}`, body);
		}

		const result = await helper(["v0.4.1"]);

		expect(result.code).toBe(1);
		expect(String(result.verdict.error)).toContain("vmon 0.4.7");
		expect(await installedVersion()).toBe("vmon 0.4.0");
	});

	test("a vmon that does not become healthy is rolled back, the unit restarted on the old one, and the failure reported", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1", { broken: true });

		const result = await helper(["v0.4.1"], { healthWait: 2 });

		expect(result.code).toBe(1);
		expect(result.verdict.ok).toBe(false);
		expect(String(result.verdict.error)).toContain("did not answer");
		expect(String(result.verdict.error)).toContain("rolled back to vmon 0.4.0");
		expect(await installedVersion()).toBe("vmon 0.4.0");
		expect(result.systemctl).toEqual([`is-active --quiet ${UNIT}`, `restart ${UNIT}`, `restart ${UNIT}`]);
		expect((await readdir(join(dir, "opt"))).filter(name => name.includes("install.") && !name.endsWith(".lock"))).toEqual([]);
	});

	test("a restart that fails is rolled back too", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1");

		const result = await helper(["v0.4.1"], { restartFails: true });

		expect(result.code).toBe(1);
		expect(String(result.verdict.error)).toContain(`restarting ${UNIT} failed`);
		expect(await installedVersion()).toBe("vmon 0.4.0");
	});

	test("without a previous vmon a failed health check says there is nothing to roll back to", async () => {
		await publish("v0.4.1", { broken: true });

		const result = await helper(["v0.4.1"], { healthWait: 1 });

		expect(result.code).toBe(1);
		expect(String(result.verdict.error)).toContain("no previous vmon to roll back to");
	});

	describe("node role (`--role node` in the unit file)", () => {
		/** A node-only vmon opens no listener: the health URL points at a closed port, so only the unit's state can decide. */
		const noListener = { VMON_INSTALL_HEALTH_URL: "http://127.0.0.1:9/health" };
		const activeCall = `is-active --quiet ${UNIT}`;

		test("passes once the unit has been active for 10 consecutive checks, without asking the health URL", async () => {
			await installFakeVmon("0.4.0");
			await publish("v0.4.1");

			const result = await helper(["v0.4.1"], { node: true, healthWait: 12, env: noListener });

			expect(result.verdict).toEqual({ ok: true, version: "v0.4.1" });
			expect(result.code).toBe(0);
			expect(await installedVersion()).toBe("vmon 0.4.1");
			// One check before the swap (was the unit running?) and the 10 of the wait.
			expect(result.systemctl.filter(call => call === activeCall)).toHaveLength(11);
			expect(result.systemctl.filter(call => call.startsWith("restart"))).toEqual([`restart ${UNIT}`]);
		});

		test("a unit that goes inactive is rolled back to the previous vmon", async () => {
			await installFakeVmon("0.4.0");
			await publish("v0.4.1", { broken: true });

			const result = await helper(["v0.4.1"], { node: true, healthWait: 12, env: noListener });

			expect(result.code).toBe(1);
			expect(String(result.verdict.error)).toContain("vmon v0.4.1 did not stay active for 10 s within 12 s");
			expect(String(result.verdict.error)).toContain("rolled back to vmon 0.4.0");
			expect(await installedVersion()).toBe("vmon 0.4.0");
			expect(result.systemctl.filter(call => call.startsWith("restart"))).toEqual([`restart ${UNIT}`, `restart ${UNIT}`]);
			// Before the swap 1, the failed wait 12 (a check per second of the window), the rolled-back wait 10.
			expect(result.systemctl.filter(call => call === activeCall)).toHaveLength(1 + 12 + 10);
		});

		test("a health wait shorter than the 10 s window cannot succeed", async () => {
			await publish("v0.4.1");

			const result = await helper(["v0.4.1"], { node: true, healthWait: 9, env: noListener });

			expect(result.code).toBe(1);
			expect(String(result.verdict.error)).toContain("did not stay active for 10 s within 9 s");
		});
	});

	test.each([[[]], [["v0.4"]], [["0.4.0"]], [["v0.4.0 "]], [["v0.4.0;touch"]], [["v1.2.3\n"]], [["v0.4.0", "v0.4.1"]], [["../v0.4.0"]]])(
		"%j is a bad invocation: exit 2, a JSON verdict, nothing downloaded or restarted",
		async args => {
			await installFakeVmon("0.4.0");

			const result = await helper(args);

			expect(result.code).toBe(2);
			expect(result.verdict.ok).toBe(false);
			expect(requests).toEqual([]);
			expect(result.systemctl).toEqual([]);
			expect(await installedVersion()).toBe("vmon 0.4.0");
		},
	);

	test("an error message with quotes and backslashes stays one valid JSON line", async () => {
		await installFakeVmon("0.4.0");
		await publish("v0.4.1");
		// The tarball is not gzip: tar's refusal is reported through the same JSON path.
		files.set(`/releases/v0.4.1/${BIN_TAR}`, new TextEncoder().encode("not a tarball"));
		files.set(`/releases/v0.4.1/${BIN_TAR}.sha256`, new TextEncoder().encode(`${sha256("not a tarball")}  ${BIN_TAR}\n`));

		const result = await helper(["v0.4.1"]);

		expect(result.code).toBe(1);
		expect(String(result.verdict.error)).toContain("not a readable tarball");
	});

	test("a downgrade is refused, naming both versions, before anything is downloaded", async () => {
		await installFakeVmon("0.4.1");
		await publish("v0.4.0");

		const result = await helper(["v0.4.0"]);

		expect(result.code).toBe(1);
		expect(result.verdict.ok).toBe(false);
		expect(String(result.verdict.error)).toContain("v0.4.1");
		expect(String(result.verdict.error)).toContain("v0.4.0");
		expect(String(result.verdict.error)).toContain("downgrade");
		expect(requests).toEqual([]);
		expect(result.systemctl).toEqual([]);
		expect(await installedVersion()).toBe("vmon 0.4.1");
	});

	test("versions compare numerically: v0.10.0 is an upgrade of v0.9.0, v0.9.0 a downgrade of v0.10.0", async () => {
		await installFakeVmon("0.9.0");
		await publish("v0.10.0");
		expect((await helper(["v0.10.0"])).verdict).toEqual({ ok: true, version: "v0.10.0" });

		await publish("v0.9.0");
		const result = await helper(["v0.9.0"]);
		expect(result.verdict.ok).toBe(false);
		expect(String(result.verdict.error)).toContain("downgrade");
		expect(await installedVersion()).toBe("vmon 0.10.0");
	});

	test("the same version is still a no-op and a newer one an upgrade", async () => {
		await installFakeVmon("0.4.1");
		await publish("v0.5.0");

		expect((await helper(["v0.4.1"])).verdict).toEqual({ ok: true, version: "v0.4.1" });
		expect(requests).toEqual([]);

		expect((await helper(["v0.5.0"])).verdict).toEqual({ ok: true, version: "v0.5.0" });
		expect(await installedVersion()).toBe("vmon 0.5.0");
	});

	describe("tarball members", () => {
		/** Replaces `file` of release v0.4.1 with a tarball `make` writes in a scratch directory, with its sidecar. */
		async function poison(file: string, make: (scratch: string) => Promise<string[]>): Promise<void> {
			const scratch = join(dir, "poison");
			await mkdir(scratch, { recursive: true });
			const args = await make(scratch);
			const archive = join(scratch, "poisoned.tar.gz");
			await run(["tar", "-P", "-czf", archive, ...args], scratch);
			const data = new Uint8Array(await Bun.file(archive).arrayBuffer());
			files.set(`/releases/v0.4.1/${file}`, data);
			files.set(`/releases/v0.4.1/${file}.sha256`, new TextEncoder().encode(`${sha256(data)}  ${file}\n`));
		}

		/** A tarball that also holds the real files, so only the bad member can be the reason for the refusal. */
		async function withRealFiles(scratch: string, extra: string[]): Promise<string[]> {
			await mkdir(join(scratch, "vmon-x86_64-unknown-linux-musl"), { recursive: true });
			await writeFile(join(scratch, "vmon-x86_64-unknown-linux-musl", "vmon"), fakeVmonScript("0.4.1"));
			return ["vmon-x86_64-unknown-linux-musl", ...extra];
		}

		async function refused(file: string, make: (scratch: string) => Promise<string[]>, reason: RegExp): Promise<void> {
			await installFakeVmon("0.4.0");
			await publish("v0.4.1");
			await poison(file, make);

			const result = await helper(["v0.4.1"]);

			expect(result.code).toBe(1);
			expect(result.verdict.ok).toBe(false);
			expect(String(result.verdict.error)).toMatch(reason);
			expect(await installedVersion()).toBe("vmon 0.4.0");
			expect(await Bun.file(join(`${root}.prev`, "vmon")).exists()).toBe(false);
			expect(result.systemctl).toEqual([]);
			expect(await Bun.file(join(dir, "escaped")).exists()).toBe(false);
		}

		test.each([BIN_TAR, ASSETS_TAR])("a symlink member of %s is refused with nothing installed", async file => {
			await refused(
				file,
				async scratch => {
					const args = await withRealFiles(scratch, []);
					await Bun.spawn(["ln", "-s", "/etc/passwd", join(scratch, "link")]).exited;
					return [...args, "link"];
				},
				/not a plain file or directory \(l\)/,
			);
		});

		test("a hardlink member is refused with nothing installed", async () => {
			await refused(
				BIN_TAR,
				async scratch => {
					const args = await withRealFiles(scratch, []);
					await writeFile(join(scratch, "first"), "x");
					await Bun.spawn(["ln", join(scratch, "first"), join(scratch, "second")]).exited;
					return [...args, "first", "second"];
				},
				/not a plain file or directory \(h\)/,
			);
		});

		test("a FIFO member is refused with nothing installed", async () => {
			await refused(
				BIN_TAR,
				async scratch => {
					const args = await withRealFiles(scratch, []);
					await Bun.spawn(["mkfifo", join(scratch, "pipe")]).exited;
					return [...args, "pipe"];
				},
				/not a plain file or directory \(p\)/,
			);
		});

		test("an absolute path member is refused with nothing installed", async () => {
			await refused(
				BIN_TAR,
				async scratch => {
					const args = await withRealFiles(scratch, []);
					await writeFile(join(scratch, "abs"), "x");
					return [...args, "--transform", `s,^abs$,${join(dir, "escaped")},`, "abs"];
				},
				/member path "\/.*escaped"/,
			);
		});

		test("a .. path member is refused with nothing installed", async () => {
			await refused(
				ASSETS_TAR,
				async scratch => {
					const args = await withRealFiles(scratch, []);
					await writeFile(join(scratch, "up"), "x");
					return [...args, "--transform", "s,^up$,../escaped,", "up"];
				},
				/member path "\.\.\/escaped"/,
			);
		});
	});

	test("without the test overrides it refuses to run unprivileged", async () => {
		const proc = Bun.spawn(["bash", HELPER, "v0.4.0"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(code).toBe(2);
		expect(stdout).toContain("must run as root");
	});

	test("downloads only from the vibemon release URL when no override is given", async () => {
		const text = await readFile(HELPER, "utf8");
		expect(text).toContain("RELEASE_BASE='https://github.com/stencil-hq/vibemon/releases/download'");
		expect(text).toContain("protocols='=https'");
	});
});
