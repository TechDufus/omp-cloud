import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeFrames, LOAD_FAILED_MARKER, probeOmp } from "./plugin-probe";

const commands = (...entries: Record<string, unknown>[]) => ({ type: "available_commands_update", commands: entries });
const builtin = { name: "help", source: "builtin", description: "Show help" };
const realCloud = { name: "cloud", source: "extension", description: "Hand work to a cloud agent and manage cloud threads (no arguments: the hub)", input: { hint: "arguments" } };
const reason = "Cannot find package '@oh-my-pi/pi-coding-agent' imported from /plugins/omp-cloud/src/cloud-jobs.ts";
/** The fallback `/cloud`: the fixed marker, then the first line of the load error. */
const markedCloud = { name: "cloud", source: "extension", description: `${LOAD_FAILED_MARKER} ${reason}`, input: { hint: "arguments" } };
const loadError = "☁ omp-cloud needs omp 18.12.3 or newer; cannot load it (Cannot find module '@oh-my-pi/pi-tui/tools/job-widget').";
const notify = (message: string, notifyType = "error") => ({ type: "extension_ui_request", id: "n1", method: "notify", message, notifyType });

describe("judgeFrames", () => {
	test("the literal is the one plugin/src/index.ts exports as LOAD_FAILED_MARKER", () => {
		const source = readFileSync(join(import.meta.dir, "..", "..", "plugin", "src", "index.ts"), "utf8");
		expect(source).toContain(`export const LOAD_FAILED_MARKER = ${JSON.stringify(LOAD_FAILED_MARKER)};`);
	});

	test("the real /cloud in the command list loads, at once", () => {
		expect(judgeFrames([{ type: "ready" }, commands(builtin, realCloud)], false)).toEqual({ state: "loads" });
	});

	test("the fallback /cloud is broken at once, whatever notify frames did or did not come, and its reason is the error after the marker", () => {
		const list = commands(builtin, markedCloud);
		expect(judgeFrames([list], false)).toEqual({ state: "broken", reason });
		expect(judgeFrames([list, notify("something else entirely")], false)).toEqual({ state: "broken", reason });
	});

	test("the old fallback text is no longer a fallback", () => {
		const old = { ...realCloud, description: "omp-cloud cannot run on this omp (it needs 18.12.3 or newer)" };
		expect(judgeFrames([commands(builtin, old)], false)).toEqual({ state: "loads" });
	});

	test("the marker is matched at the start only: a real description that merely mentions it still loads", () => {
		expect(judgeFrames([commands({ ...realCloud, description: `Hand work to a cloud agent (${LOAD_FAILED_MARKER} nothing)` })], false)).toEqual({ state: "loads" });
	});

	test("a notify error frame alone decides nothing: with a real /cloud listed it loads", () => {
		expect(judgeFrames([notify(loadError), commands(builtin, realCloud)], false)).toEqual({ state: "loads" });
		expect(judgeFrames([notify(loadError)], false)).toBeUndefined();
	});

	test("notices that are not errors, or are about something else, never change the verdict", () => {
		expect(judgeFrames([notify("☁ omp-cloud connected", "info"), notify("another extension failed", "error"), commands(builtin, realCloud)], false)).toEqual({ state: "loads" });
	});

	test("no /cloud in a list that will not change is broken, with the relayed error as text when there is one; before that it waits", () => {
		expect(judgeFrames([commands(builtin)], false)).toBeUndefined();
		expect(judgeFrames([commands(builtin)], true)).toEqual({ state: "broken", reason: "omp does not list /cloud, so it did not load the plugin" });
		expect(judgeFrames([notify(loadError), commands(builtin)], true)).toEqual({
			state: "broken",
			reason: "omp-cloud needs omp 18.12.3 or newer; cannot load it (Cannot find module '@oh-my-pi/pi-tui/tools/job-widget').",
		});
	});

	test("a /cloud that arrives in a later command update counts", () => {
		expect(judgeFrames([commands(builtin), commands(builtin, realCloud)], false)).toEqual({ state: "loads" });
	});

	test("no command list at all is unknown, never a failure", () => {
		expect(judgeFrames([{ type: "ready" }, "text"], false)).toBeUndefined();
		expect(judgeFrames([{ type: "ready" }], true)).toEqual({ state: "unknown", reason: "omp printed no command list" });
	});
});

describe("probeOmp with a fake omp process", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "omp-cloud-probe-test-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** An executable that logs its argv and cwd, prints `frames` as JSON lines and then sleeps like a server that waits for commands. */
	async function fakeOmp(frames: unknown[], tail = "sleep 30"): Promise<string> {
		const path = join(dir, "omp");
		const lines = frames.map((frame) => `printf '%s\\n' '${JSON.stringify(frame).replaceAll("'", "'\\''")}'`);
		await writeFile(path, ["#!/bin/sh", `echo "$@" > ${join(dir, "argv")}`, `pwd > ${join(dir, "cwd")}`, `echo $$ > ${join(dir, "pid")}`, "echo 'banner, not a frame'", ...lines, tail, ""].join("\n"));
		await chmod(path, 0o755);
		return path;
	}

	test("the real plugin: loads, asked in RPC mode without a session from a neutral empty directory", async () => {
		const verdict = await probeOmp(await fakeOmp([commands(builtin, realCloud)]), { timeoutMs: 10_000 });
		expect(verdict).toEqual({ state: "loads" });
		expect((await readFile(join(dir, "argv"), "utf8")).trim()).toBe("--mode rpc --no-session");
		const cwd = (await readFile(join(dir, "cwd"), "utf8")).trim();
		expect(cwd).not.toBe(dir);
		expect(cwd.startsWith(tmpdir())).toBe(true);
		expect(existsSync(cwd)).toBe(false);
	});

	test("the fallback: broken at once, with the error its description carries; the notify frame decides nothing", async () => {
		const verdict = await probeOmp(await fakeOmp([commands(builtin, markedCloud)]), { timeoutMs: 10_000, graceMs: 60_000 });
		expect(verdict).toEqual({ state: "broken", reason: "Cannot find package '@oh-my-pi/pi-coding-agent' imported from /plugins/omp-cloud/src/cloud-jobs.ts" });
	});

	test("a missing /cloud is broken after the grace, with the relayed error as its reason", async () => {
		const verdict = await probeOmp(await fakeOmp([commands(builtin), notify(loadError)]), { timeoutMs: 10_000, graceMs: 50 });
		expect(verdict.state).toBe("broken");
		expect(verdict.state === "broken" && verdict.reason).toContain("Cannot find module '@oh-my-pi/pi-tui/tools/job-widget'");
	});

	test("the process is killed once the answer is known", async () => {
		await probeOmp(await fakeOmp([commands(builtin, realCloud)]), { timeoutMs: 10_000 });
		const pid = Number((await readFile(join(dir, "pid"), "utf8")).trim());
		let alive = true;
		for (let i = 0; i < 100 && alive; i++) {
			try {
				process.kill(pid, 0);
				await new Promise((resolve) => setImmediate(resolve));
			} catch {
				alive = false;
			}
		}
		expect(alive).toBe(false);
	});

	test("an omp that says nothing before the deadline is unknown", async () => {
		const verdict = await probeOmp(await fakeOmp([]), { timeoutMs: 200 });
		expect(verdict).toEqual({ state: "unknown", reason: "omp gave no answer within 0.2 s" });
	});

	test("an omp that exits at once with an error is unknown and carries its last line", async () => {
		const path = join(dir, "omp");
		await writeFile(path, "#!/bin/sh\necho 'error: unknown option --mode' >&2\nexit 2\n");
		await chmod(path, 0o755);
		expect(await probeOmp(path, { timeoutMs: 10_000 })).toEqual({ state: "unknown", reason: "omp exited: error: unknown option --mode" });
	});

	test("an omp that cannot be started is unknown", async () => {
		const verdict = await probeOmp(join(dir, "no-such-omp"), { timeoutMs: 10_000 });
		expect(verdict.state).toBe("unknown");
	});
});
