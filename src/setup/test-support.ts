/** Fakes for the tests of `setup`, `doctor` and `uninstall`: a host that answers every command, a vmon and a service that answer over HTTP, and a context in a temp directory. */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostOmp } from "../omp-version";
import { MIN_OMP_VERSION } from "./preflight";
import { renderNodeVmonUnit, SYSTEM_UNIT_DIR, VMON_UNIT } from "./system-units";
import type { CommandOptions, CommandResult, CommandRunner } from "../update/system";
import { setupPaths } from "./config";
import type { SetupContext, SetupParts } from "./context";
import type { HealthDeps } from "./health";
import type { PluginOptions } from "./plugin";
import type { SelfCommand } from "./root";
import { Reporter, type StepResult } from "./steps";
import { NODE_ENV_FILE, type SystemReport } from "./system";

export const TEST_VERSION = "0.5.1";
export const TEST_USER = "tester";
export const OMP = { path: "/opt/omp/bin/omp", version: MIN_OMP_VERSION };

/** A valid `node.env`: the server a node follows. */
export const NODE_ENV_TEXT = "SERVER_URL=https://192.168.1.20:8443\nSERVER_PIN=sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n";

export interface RecordedCall {
	argv: string[];
	options: CommandOptions | undefined;
}

/** The vibemon admin token the fake root part reports. */
export const ADMIN_TOKEN = "admin-token-from-etc-vmon-env";

/** What the root part prints, as the report line SetupSystem's `parseSystemReport` accepts. */
export function rootReport(over: Partial<SystemReport> = {}): SystemReport {
	return {
		ok: true,
		steps: [{ id: "system.vmon", status: "ok", detail: "vibemon is at the pin" }],
		team: { slug: "omp-cloud", created: true },
		key: "e2b_freshly_minted_key",
		adminToken: ADMIN_TOKEN,
		netPool: "172.20.0.0/16",
		linger: true,
		...over,
	};
}

export interface HostScript {
	/** The root part's answers, one per `sudo … setup system` call, in order; the last one repeats. */
	root: SystemReport[];
	/** Whether `sudo -n true` succeeds. */
	sudoCached: boolean;
	/** Exit code of `systemd-analyze` and the like is always 0; this is the one command that can fail on demand. */
	failing: string[];
	/** Answers that win over everything below (ssh, ip, curl, systemctl…): the first defined result is used; undefined falls through. */
	respond?: (argv: readonly string[]) => Partial<CommandResult> | undefined;
}

export interface FakeHost {
	run: CommandRunner;
	calls: RecordedCall[];
	script: HostScript;
	/** The calls' joined command lines. */
	lines(): string[];
}

/** A host that exits 0 with no output for everything but what is scripted. */
export function fakeHost(script: Partial<HostScript> = {}): FakeHost {
	const full: HostScript = { root: [rootReport()], sudoCached: true, failing: [], ...script };
	const calls: RecordedCall[] = [];
	let rootCalls = 0;
	const run: CommandRunner = async (argv, options) => {
		calls.push({ argv: [...argv], options });
		const line = argv.join(" ");
		const result: CommandResult = { code: 0, stdout: "", stderr: "" };
		const scripted = full.respond?.(argv);
		if (scripted !== undefined) return { ...result, ...scripted };
		if (full.failing.some((prefix) => line.startsWith(prefix))) return { ...result, code: 1, stderr: "failed on purpose" };
		if (line === "sudo -n true") return { ...result, code: full.sudoCached ? 0 : 1 };
		if (argv[0] === "sudo" && argv.includes("setup") && argv.includes("system")) {
			const report = full.root[Math.min(rootCalls, full.root.length - 1)] ?? rootReport();
			rootCalls++;
			return { ...result, code: report.ok ? 0 : 1, stdout: `${JSON.stringify(report)}\n` };
		}
		if (argv[1] === "version" && argv.length === 2) return { ...result, stdout: `omp-cloud ${TEST_VERSION} (test)\n` };
		return result;
	};
	return { run, calls, script: full, lines: () => calls.map((call) => call.argv.join(" ")) };
}

export interface FakeVmon {
	/** Status the team route answers for the key: 200 good, 401 stale. */
	keyStatus: number;
	sandboxes: { sandboxID: string }[];
	/** `METHOD url` of every request, for assertions. */
	requests: string[];
	health: HealthDeps;
}

/** vmon, the gateway, the broker and the service as they answer when everything is healthy. */
export function fakeHealth(version: string = TEST_VERSION): FakeVmon {
	const vmon: FakeVmon = {
		keyStatus: 200,
		sandboxes: [],
		requests: [],
		health: {
			fetch: async (url, init) => {
				const method = init?.method ?? "GET";
				vmon.requests.push(`${method} ${url}`);
				if (url.endsWith(":3000/health")) return new Response(null, { status: 204 });
				if (url.includes("/v2/sandboxes")) {
					if (vmon.keyStatus !== 200) return new Response("unauthorized", { status: vmon.keyStatus });
					return Response.json(vmon.sandboxes);
				}
				if (url.includes("/sandboxes/")) return new Response(null, { status: 204 });
				if (url.endsWith("/api/v1/health")) return Response.json({ status: "ok", version });
				return new Response("ok", { status: 200 });
			},
			sleep: async () => {},
			now: (() => {
				let time = 0;
				return () => (time += 1000);
			})(),
		},
	};
	return vmon;
}

export interface TestRig {
	ctx: SetupContext;
	host: FakeHost;
	vmon: FakeVmon;
	/** Lines the reporter printed on its two sinks. */
	out: string[];
	err: string[];
	/** What went to the `--json` stdout. */
	stdout: string[];
	/** The options `ensurePlugin` was called with. */
	pluginCalls: PluginOptions[];
	loginCalls: number;
	asked: string[];
	/** Where this rig's world lives. */
	dir: string;
}

export interface RigOptions {
	host?: Partial<HostScript>;
	/** A compiled release binary (default) or a checkout run by bun. */
	compiled?: boolean;
	uid?: number;
	stdinIsTty?: boolean;
	answer?: boolean;
	missingTools?: string[];
	omp?: typeof OMP | null;
	pluginSteps?: StepResult[];
	/** This machine is a vibemon node: `/etc/omp-cloud/node.env` exists and holds `nodeEnv`. */
	node?: boolean;
	nodeEnv?: string;
	/** The text of `/etc/systemd/system/vmon.service`: by default a node's unit with `--vmm-user` on a node rig, and no file on a server rig. */
	vmonUnit?: string;
}

/** A context whose home is `dir`: every file setup writes lands there, every command is `host`'s. */
export async function rig(dir: string, options: RigOptions = {}): Promise<TestRig> {
	const host = fakeHost(options.host);
	const vmon = fakeHealth();
	const out: string[] = [];
	const err: string[] = [];
	const stdout: string[] = [];
	const asked: string[] = [];
	const pluginCalls: PluginOptions[] = [];
	const state = { loginCalls: 0 };
	const paths = setupPaths({ HOME: dir }, TEST_USER);
	const compiled = options.compiled ?? true;
	const binary = join(dir, "downloads", "omp-cloud");
	await mkdir(join(dir, "downloads"), { recursive: true });
	await writeFile(binary, `#!/bin/sh\necho 'omp-cloud ${TEST_VERSION} (test)'\n`);
	await chmod(binary, 0o755);
	const self: SelfCommand = compiled
		? { argv: [binary], compiled: true, repoRoot: join(dir, "repo") }
		: { argv: [join(dir, "bin", "bun"), join(dir, "repo", "src", "bin.ts")], compiled: false, repoRoot: join(dir, "repo") };
	const missing = new Set(options.missingTools ?? []);
	const omp = options.omp === undefined ? OMP : options.omp;
	/** The omp the host has: none until omp's installer ran, when the test says there was none. */
	const currentOmp = async (): Promise<HostOmp> => {
		const current = omp ?? (host.calls.some((call) => call.argv[0] === "sh") ? OMP : null);
		if (current === null) throw new Error("omp is not installed on the service host (no Tern install, no omp on PATH)");
		return current;
	};
	const parts: SetupParts = {
		ensurePlugin: async (opts) => {
			pluginCalls.push(opts);
			return options.pluginSteps ?? [{ id: "plugin.install", status: "changed", detail: "plugin installed" }];
		},
		removePlugin: async () => [{ id: "plugin.remove", status: "changed", detail: "plugin removed" }],
		pluginChecks: async () => [{ id: "plugin.check", status: "ok", detail: "plugin is installed" }],
		loginStep: async () => {
			state.loginCalls++;
			return [{ id: "login", status: "ok", detail: "the cloud already runs a provider" }];
		},
		systemChecks: async () => [{ id: "system.check.vmon", status: "ok", detail: "vmon is healthy" }],
		templateProbe: async () => ({ name: async () => "omp-agent:18.12.3-abc", exists: async () => true }),
		clusterProbe: async () => ({ localId: "server", nodes: [], history: [] }),
	};
	const ctx: SetupContext = {
		run: host.run,
		env: { HOME: dir, PATH: "/usr/bin:/bin" },
		paths,
		self,
		version: TEST_VERSION,
		uid: options.uid ?? 1000,
		stdinIsTty: options.stdinIsTty ?? true,
		hostname: "build-host",
		preflight: {
			run: host.run,
			env: {},
			platform: "linux",
			arch: "x64",
			uid: options.uid ?? 1000,
			which: (name) => (missing.has(name) ? null : `/usr/bin/${name}`),
			exists: async (path) => path !== NODE_ENV_FILE || options.node === true,
			readText: async (path) => {
				if (path === "/proc/1/comm") return "systemd\n";
				if (path === NODE_ENV_FILE) return options.nodeEnv ?? NODE_ENV_TEXT;
				if (path === `${SYSTEM_UNIT_DIR}/${VMON_UNIT}`) {
					if (options.vmonUnit !== undefined) return options.vmonUnit;
					if (options.node === true) return renderNodeVmonUnit("172.20.0.0/16", "192.168.1.20", { uid: 961, gid: 990 });
					throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
				}
				return "MemTotal: 16777216 kB\n";
			},
			freeBytes: async () => 200 * 1024 ** 3,
			portInUse: async () => false,
			httpsStatus: async () => 200,
			hostOmp: currentOmp,
		},
		health: vmon.health,
		reporter: new Reporter({ out: (text) => void out.push(text), err: (text) => void err.push(text), color: false }),
		io: { print: () => {}, interactive: true, ask: async () => null },
		confirm: async (question) => {
			asked.push(question);
			return options.answer ?? true;
		},
		hostOmp: currentOmp,
		stdout: (text) => void stdout.push(text),
		parts,
	};
	return {
		ctx,
		host,
		vmon,
		out,
		err,
		stdout,
		pluginCalls,
		get loginCalls() {
			return state.loginCalls;
		},
		asked,
		dir,
	};
}
