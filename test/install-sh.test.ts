import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the real install.sh with `sh` against a local static server that plays the GitHub releases host, with a fake
// `omp-cloud` (a shell script) as the downloaded binary.

const SCRIPT = join(import.meta.dir, "..", "install.sh");
const ASSET = "omp-cloud-linux-x86_64";
const SH = Bun.which("sh") ?? "/bin/sh";

/** Answers `version`; records every `setup` call (arguments, its own path) in $FAKE_LOG; exits with $FAKE_SETUP_EXIT. */
const FAKE_BINARY = `#!/bin/sh
case "$1" in
version)
  echo ran >> "$FAKE_LOG/version-calls"
  echo "omp-cloud 9.9.9"
  ;;
setup)
  shift
  echo "$#" > "$FAKE_LOG/setup-argc"
  printf '%s\\n' "$@" > "$FAKE_LOG/setup-args"
  echo "$0" > "$FAKE_LOG/setup-path"
  exit "\${FAKE_SETUP_EXIT:-0}"
  ;;
*)
  echo "unexpected: $*" >&2
  exit 64
  ;;
esac
`;
const BROKEN_BINARY = `#!/bin/sh
echo "boom: error while loading shared libraries: libfoo.so" >&2
exit 3
`;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Served {
	binary: string;
	/** Text of the .sha256 sidecar; null answers 404. */
	sidecar: string | null;
	requests: string[];
}

const served: Served = { binary: FAKE_BINARY, sidecar: null, requests: [] };
const sidecarFor = (binary: string): string => `${sha256(binary)}  ${ASSET}\n`;

let server: Bun.Server<undefined>;
let baseUrl: string;
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const path = new URL(req.url).pathname;
			served.requests.push(path);
			// /redir/<rest> answers with an absolute http redirect to /releases/<rest>: what a CDN hop looks like.
			if (path.startsWith("/redir/")) {
				return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${server.port}/releases/${path.slice("/redir/".length)}` } });
			}
			if (!/^\/releases\/(latest\/download|download\/v[^/]+)\/omp-cloud-linux-x86_64(\.sha256)?$/.test(path)) {
				return new Response("not found", { status: 404 });
			}
			if (path.endsWith(".sha256")) {
				return served.sidecar === null ? new Response("not found", { status: 404 }) : new Response(served.sidecar);
			}
			return new Response(served.binary);
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}/releases`;
});
afterAll(() => {
	server.stop(true);
});

let dir: string;
let tmpRoot: string;
let cacheRoot: string;
let logDir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-cloud-install-test-"));
	tmpRoot = join(dir, "tmp");
	cacheRoot = join(dir, "cache");
	logDir = join(dir, "log");
	await mkdir(tmpRoot);
	await mkdir(logDir);
	// `cacheRoot` and ~/.cache are left for install.sh to create.
	served.binary = FAKE_BINARY;
	served.sidecar = sidecarFor(FAKE_BINARY);
	served.requests = [];
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

interface RunOptions {
	args?: string[];
	env?: Record<string, string>;
	/** PATH for the script; defaults to the test process's. */
	path?: string;
	/** Feed the script on stdin (`curl | sh -s -- args`) instead of running the file. */
	piped?: boolean;
	/** Which of TMPDIR, XDG_CACHE_HOME and HOME/.cache is the one expected to be used (the others unset). Default "tmpdir". */
	staging?: Staging;
}
interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Where install.sh stages for each mode: $TMPDIR when set, else $XDG_CACHE_HOME, else ~/.cache. */
type Staging = "tmpdir" | "xdg" | "home";

/** Runs install.sh and asserts, for every case, that it left nothing behind in its staging directory. */
async function run(opts: RunOptions = {}): Promise<RunResult> {
	const args = opts.args ?? [];
	const staging = opts.staging ?? "tmpdir";
	const home = join(dir, "home");
	const env: Record<string, string> = {
		PATH: opts.path ?? process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		FAKE_LOG: logDir,
		OMP_CLOUD_DOWNLOAD_URL: baseUrl,
	};
	if (staging === "tmpdir") env.TMPDIR = tmpRoot;
	if (staging === "xdg") env.XDG_CACHE_HOME = cacheRoot;
	Object.assign(env, opts.env);
	const piped = opts.piped === true;
	const proc = Bun.spawn(piped ? [SH, "-s", "--", ...args] : [SH, SCRIPT, ...args], {
		env,
		stdin: piped ? new Blob([readFileSync(SCRIPT)]) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	const stageRoot = { tmpdir: tmpRoot, xdg: cacheRoot, home: join(home, ".cache") }[staging];
	expect(readdirSync(stageRoot)).toEqual([]);
	return { code, stdout, stderr };
}

const logged = (name: string): string | null => {
	const file = join(logDir, name);
	return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const setupArgs = (): string[] => (logged("setup-args") ?? "").split("\n").filter((line) => line !== "");

/** A directory of symlinks to just the commands install.sh uses, so a test controls what is on PATH. */
async function toolsDir(skip: readonly string[] = []): Promise<string> {
	const bin = await mkdtemp(join(dir, "tools-"));
	for (const name of ["curl", "mktemp", "mkdir", "rm", "chmod", "cut", "tr", "uname", "sed", "sha256sum"]) {
		if (skip.includes(name)) continue;
		const real = Bun.which(name);
		if (real === null) throw new Error(`${name} is not installed`);
		await symlink(real, join(bin, name));
	}
	return bin;
}
async function shim(bin: string, name: string, body: string): Promise<void> {
	const file = join(bin, name);
	await writeFile(file, `#!/bin/sh\n${body}\n`);
	await chmod(file, 0o755);
}

describe("install.sh", () => {
	test("is valid POSIX sh syntax", async () => {
		const proc = Bun.spawn([SH, "-n", SCRIPT], { stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
	});

	test.skipIf(Bun.which("shellcheck") === null)("passes shellcheck -s sh", async () => {
		const proc = Bun.spawn(["shellcheck", "-s", "sh", SCRIPT], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		expect({ code: await proc.exited, out }).toEqual({ code: 0, out: "" });
	});

	test("--help prints the usage, downloads nothing and exits 0", async () => {
		const r = await run({ args: ["--help"] });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Usage:");
		expect(r.stdout).toContain("OMP_CLOUD_VERSION");
		expect(r.stdout).toContain("OMP_CLOUD_DOWNLOAD_URL");
		expect(served.requests).toEqual([]);
		expect(logged("setup-args")).toBeNull();
	});

	test("installs the latest release: downloads the binary and sidecar, runs setup and removes the temp binary", async () => {
		const r = await run();
		expect(r.code).toBe(0);
		expect(served.requests.toSorted()).toEqual([`/releases/latest/download/${ASSET}`, `/releases/latest/download/${ASSET}.sha256`]);
		expect(r.stdout).toContain("✓ sha256 verified");
		expect(r.stdout).toContain("✓ omp-cloud 9.9.9");
		expect(logged("version-calls")).toBe("ran\n");
		expect(logged("setup-argc")).toBe("0\n");
		// setup ran from a file under TMPDIR, which `run` has proved gone.
		expect(logged("setup-path")?.startsWith(`${tmpRoot}/`)).toBe(true);
	});

	test("OMP_CLOUD_VERSION pins the release, with or without the leading v", async () => {
		for (const version of ["1.2.3", "v1.2.3"]) {
			served.requests = [];
			const r = await run({ env: { OMP_CLOUD_VERSION: version } });
			expect(r.code).toBe(0);
			expect(served.requests.toSorted()).toEqual([`/releases/download/v1.2.3/${ASSET}`, `/releases/download/v1.2.3/${ASSET}.sha256`]);
		}
	});

	test("a trailing slash on OMP_CLOUD_DOWNLOAD_URL is ignored", async () => {
		const r = await run({ env: { OMP_CLOUD_DOWNLOAD_URL: `${baseUrl}/` } });
		expect(r.code).toBe(0);
		expect(served.requests).toContain(`/releases/latest/download/${ASSET}`);
	});

	test("refuses a malformed OMP_CLOUD_VERSION before downloading", async () => {
		const r = await run({ env: { OMP_CLOUD_VERSION: "1.0/../../x" } });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("OMP_CLOUD_VERSION");
		expect(served.requests).toEqual([]);
	});

	test("passes the arguments after -- to setup, from a file and from a pipe", async () => {
		const args = ["--yes", "--team", "my team", "--no-login"];
		for (const piped of [false, true]) {
			await rm(logDir, { recursive: true, force: true });
			await mkdir(logDir);
			const r = await run({ args, piped });
			expect(r.code).toBe(0);
			expect(setupArgs()).toEqual(args);
			expect(logged("setup-argc")).toBe("4\n");
		}
	});

	test("returns setup's exit code and says so", async () => {
		const r = await run({ env: { FAKE_SETUP_EXIT: "7" } });
		expect(r.code).toBe(7);
		expect(r.stderr).toContain("✗ omp-cloud setup exited with code 7");
		expect(logged("setup-args")).not.toBeNull();
	});

	test("a checksum mismatch is refused and nothing is run", async () => {
		served.sidecar = `${sha256("something else")}  ${ASSET}\n`;
		const r = await run({ args: ["--yes"] });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("sha256 mismatch");
		expect(r.stderr).toContain(sha256(FAKE_BINARY));
		expect(logged("version-calls")).toBeNull();
		expect(logged("setup-args")).toBeNull();
	});

	test("a sidecar that is not a sha256 digest is refused and nothing is run", async () => {
		served.sidecar = "<html>rate limited</html>\n";
		const r = await run();
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("does not hold a sha256 digest");
		expect(logged("version-calls")).toBeNull();
	});

	test("a failed download is reported with its URL and nothing is run", async () => {
		served.sidecar = null;
		const r = await run();
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(`download failed: ${baseUrl}/latest/download/${ASSET}.sha256`);
		expect(logged("version-calls")).toBeNull();
	});

	test("a binary that cannot start is reported with its output and setup is not run", async () => {
		served.binary = BROKEN_BINARY;
		served.sidecar = sidecarFor(BROKEN_BINARY);
		const r = await run({ args: ["--yes"] });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("downloaded but cannot start");
		expect(r.stderr).toContain("boom: error while loading shared libraries: libfoo.so");
		expect(logged("setup-args")).toBeNull();
	});

	test("refuses a machine that is not x86_64, naming the plugin-only route", async () => {
		for (const [os, arch] of [["Linux", "aarch64"], ["Darwin", "x86_64"]] as const) {
			const bin = await toolsDir();
			await rm(join(bin, "uname"));
			await shim(bin, "uname", `case "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac`);
			const r = await run({ path: bin });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(`${os} ${arch} is not supported`);
			expect(r.stderr).toContain("Linux x86_64 with KVM");
			expect(r.stderr).toContain("omp plugin marketplace add TechDufus/omp-cloud");
			expect(served.requests).toEqual([]);
			expect(logged("version-calls")).toBeNull();
		}
	});

	test("falls back to shasum -a 256 when sha256sum is missing", async () => {
		const bin = await toolsDir(["sha256sum"]);
		const real = Bun.which("sha256sum");
		if (real === null) throw new Error("sha256sum is not installed");
		await shim(bin, "shasum", `[ "$1" = "-a" ] && [ "$2" = "256" ] || exit 64\nshift 2\nexec ${real} "$@"`);
		const r = await run({ path: bin, args: ["--yes"] });
		expect(r.code).toBe(0);
		expect(setupArgs()).toEqual(["--yes"]);

		// A mismatch is still caught through the fallback.
		served.sidecar = `${sha256("other")}  ${ASSET}\n`;
		await rm(logDir, { recursive: true, force: true });
		await mkdir(logDir);
		const bad = await run({ path: bin });
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain("sha256 mismatch");
		expect(logged("setup-args")).toBeNull();
	});

	test("names the missing tool when neither sha256sum nor shasum exists", async () => {
		const bin = await toolsDir(["sha256sum"]);
		const r = await run({ path: bin });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("sha256sum or shasum is required");
		expect(served.requests).toEqual([]);
	});

	test("stages under $XDG_CACHE_HOME when TMPDIR is unset or empty, and removes the staging directory", async () => {
		const variants: Record<string, string>[] = [{}, { TMPDIR: "" }];
		for (const env of variants) {
			const r = await run({ staging: "xdg", env });
			expect(r.code).toBe(0);
			expect(logged("setup-path")?.startsWith(`${cacheRoot}/omp-cloud-install.`)).toBe(true);
			expect(existsSync(logged("setup-path")?.trim() ?? "")).toBe(false);
		}
	});

	test("stages under ~/.cache when neither TMPDIR nor XDG_CACHE_HOME is set, creating it", async () => {
		const r = await run({ staging: "home" });
		expect(r.code).toBe(0);
		expect(logged("setup-path")?.startsWith(`${join(dir, "home", ".cache")}/omp-cloud-install.`)).toBe(true);
	});

	test("stages in TMPDIR when the user set it", async () => {
		const r = await run();
		expect(r.code).toBe(0);
		expect(logged("setup-path")?.startsWith(`${tmpRoot}/omp-cloud-install.`)).toBe(true);
	});

	describe("redirects", () => {
		const HTTPS_BASE = "https://releases.test";

		/** PATH whose curl forwards to the real one with https://releases.test rewritten to the local http server, so an https base can be tested without TLS. */
		async function httpsAliasPath(): Promise<string> {
			const bin = await toolsDir();
			const real = Bun.which("curl");
			if (real === null) throw new Error("curl is not installed");
			await rm(join(bin, "curl"));
			await shim(
				bin,
				"curl",
				[
					"n=$#",
					'while [ "$n" -gt 0 ]; do',
					'  a=$1; shift',
					`  case "$a" in ${HTTPS_BASE}/*) a="http://127.0.0.1:${server.port}/\${a#${HTTPS_BASE}/}" ;; esac`,
					'  set -- "$@" "$a"; n=$((n - 1))',
					"done",
					`exec ${real} "$@"`,
				].join("\n"),
			);
			return bin;
		}

		test("an https base refuses a redirect to http", async () => {
			const r = await run({ path: await httpsAliasPath(), env: { OMP_CLOUD_DOWNLOAD_URL: `${HTTPS_BASE}/redir` } });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(`download failed: ${HTTPS_BASE}/redir/latest/download/${ASSET}.sha256`);
			// The redirect was answered, but curl never followed it.
			expect(served.requests).toEqual([`/redir/latest/download/${ASSET}.sha256`]);
			expect(logged("version-calls")).toBeNull();
		});

		test("an https base still downloads when there is no redirect", async () => {
			const r = await run({ path: await httpsAliasPath(), env: { OMP_CLOUD_DOWNLOAD_URL: `${HTTPS_BASE}/releases` } });
			expect(r.code).toBe(0);
			expect(served.requests).toContain(`/releases/latest/download/${ASSET}`);
		});

		test("an http base follows redirects", async () => {
			const r = await run({ env: { OMP_CLOUD_DOWNLOAD_URL: baseUrl.replace(/\/releases$/, "/redir") } });
			expect(r.code).toBe(0);
			expect(served.requests).toContain(`/redir/latest/download/${ASSET}`);
			expect(served.requests).toContain(`/releases/latest/download/${ASSET}`);
		});
	});
});
