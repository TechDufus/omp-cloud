import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../update/system";
import { rootArgs, runRootPart, selfCommand, sudoCommand, sudoReady } from "./root";
import { rootReport } from "./test-support";

const SELF = { argv: ["/home/u/.local/share/omp-cloud/app/bin/omp-cloud"], compiled: true, repoRoot: "/repo" };

function runner(result: Partial<CommandResult> | Error): { run: CommandRunner; calls: { argv: string[]; inherit: boolean | undefined; timeoutMs: number | undefined }[] } {
	const calls: { argv: string[]; inherit: boolean | undefined; timeoutMs: number | undefined }[] = [];
	const run: CommandRunner = async (argv, options) => {
		calls.push({ argv: [...argv], inherit: options?.inherit, timeoutMs: options?.timeoutMs });
		if (result instanceof Error) throw result;
		return { code: 0, stdout: "", stderr: "", ...result };
	};
	return { run, calls };
}

describe("selfCommand", () => {
	test("a compiled binary runs as itself", () => {
		expect(selfCommand("/home/u/.local/bin/omp-cloud", "/repo")).toEqual({ argv: ["/home/u/.local/bin/omp-cloud"], compiled: true, repoRoot: "/repo" });
	});

	test("under bun it runs bun on the repository's entry", () => {
		expect(selfCommand("/home/u/.bun/bin/bun", "/repo")).toEqual({ argv: ["/home/u/.bun/bin/bun", "/repo/src/bin.ts"], compiled: false, repoRoot: "/repo" });
		expect(selfCommand("/usr/bin/bun-profile", "/repo").compiled).toBe(false);
	});
});

describe("rootArgs and sudoCommand", () => {
	test("only validated flags, in a fixed order, and nothing else", () => {
		expect(rootArgs({ user: "tester", packages: [] })).toEqual(["--user", "tester"]);
		expect(rootArgs({ user: "tester", team: "acme", maxSandboxes: 3, packages: ["git", "iproute2"], mintKey: true, noLinger: true, migrateFrom: "old-team" })).toEqual([
			"--user",
			"tester",
			"--team",
			"acme",
			"--max-sandboxes",
			"3",
			"--packages",
			"git,iproute2",
			"--mint-key",
			"--no-linger",
			"--migrate-team",
			"old-team",
		]);
	});

	test("the sudo line is `sudo -- <self> setup system <args>`", () => {
		expect(sudoCommand(SELF, ["--user", "tester"])).toEqual(["sudo", "--", SELF.argv[0] ?? "", "setup", "system", "--user", "tester"]);
		expect(sudoCommand({ ...SELF, argv: ["/bun", "/repo/src/bin.ts"] }, ["--uninstall"]).slice(0, 5)).toEqual(["sudo", "--", "/bun", "/repo/src/bin.ts", "setup"]);
	});
});

describe("sudoReady", () => {
	test("is `sudo -n true` succeeding; a runner that cannot start sudo is not ready", async () => {
		expect(await sudoReady(runner({ code: 0 }).run)).toBe(true);
		expect(await sudoReady(runner({ code: 1 }).run)).toBe(false);
		expect(await sudoReady(runner(new Error("ENOENT")).run)).toBe(false);
	});
});

describe("runRootPart", () => {
	test("shares the terminal, waits long, and returns the report of the last stdout line", async () => {
		const report = rootReport();
		const { run, calls } = runner({ stdout: `progress noise\n${JSON.stringify(report)}\n` });
		const outcome = await runRootPart(run, SELF, ["--user", "tester"]);
		expect(outcome).toEqual({ ok: true, report });
		expect(calls[0]).toEqual({ argv: sudoCommand(SELF, ["--user", "tester"]), inherit: true, timeoutMs: 30 * 60_000 });
	});

	test("a long report line is read whole", async () => {
		const report = rootReport({ steps: Array.from({ length: 40 }, (_, i) => ({ id: `system.step${i}`, status: "ok" as const, detail: "x".repeat(40) })) });
		const outcome = await runRootPart(runner({ stdout: `${JSON.stringify(report)}\n` }).run, SELF, []);
		expect(outcome.ok).toBe(true);
	});

	test("a report that says ok: false comes back with its failed steps", async () => {
		const failed = rootReport({ ok: false, steps: [{ id: "system.vmon", status: "ok", detail: "fine" }, { id: "system.helper", status: "failed", detail: "no", fix: "do this" }] });
		const outcome = await runRootPart(runner({ code: 1, stdout: `${JSON.stringify(failed)}\n` }).run, SELF, []);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.report).toEqual(failed);
			expect(outcome.steps.map((step) => step.id)).toEqual(["system.helper"]);
		}
	});

	test("a report with ok but a non-zero exit is still a failure", async () => {
		const outcome = await runRootPart(runner({ code: 3, stdout: `${JSON.stringify(rootReport())}\n` }).run, SELF, []);
		expect(outcome.ok).toBe(false);
	});

	test("no report: the failure names the exit and the command to run by hand", async () => {
		const refused = await runRootPart(runner({ code: 1, stdout: "" }).run, SELF, ["--user", "tester"]);
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.report).toBeNull();
			expect(refused.steps[0]?.fix).toBe(`run it yourself to see why: ${sudoCommand(SELF, ["--user", "tester"]).join(" ")}`);
		}
		const odd = await runRootPart(runner({ code: 9, stdout: "garbage" }).run, SELF, []);
		expect(odd.ok === false && odd.steps[0]?.detail).toContain("exited 9 without a report");
	});

	test("sudo that cannot start is a failed step, not an exception", async () => {
		const outcome = await runRootPart(runner(new Error("spawn sudo ENOENT")).run, SELF, []);
		expect(outcome.ok === false && outcome.steps[0]?.detail).toContain("sudo could not start: spawn sudo ENOENT");
	});
});
