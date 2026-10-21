import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../update/system";
import type { FakeRunner } from "./system-fakes";
import { fakeRunner } from "./system-fakes";
import { clusterSecretOf, ensureTeam, limitArgs, parseApiKey, parseCreateTeam, parseListTeams } from "./vmon-team";

const SECRET = "c0ffee".repeat(10);
const KEY = `e2b_${"ab12".repeat(10)}`;
const OTHER_KEY = `e2b_${"cd34".repeat(10)}`;
const COUNTS = "sandboxes=32 builds=4 vcpus=8 memory_mb=8192 disk_mb=20480 hours=24";
const TEAMS = `0b3c\tacme\tacme\t${COUNTS}\n9f1d\tomp-cloud\tomp-cloud\t${COUNTS}\tBLOCKED\n7a2e\tsystem\tsystem\t${COUNTS}\tSYSTEM\n`;
const CREATED = `team    omp-cloud (9f1d)\nslug    omp-cloud\napi key ${KEY}\n`;

describe("parsers", () => {
	test("list-teams: tab-separated team lines with the BLOCKED and SYSTEM flags", () => {
		expect(parseListTeams(TEAMS)).toEqual([
			{ id: "0b3c", slug: "acme", name: "acme", blocked: false, system: false },
			{ id: "9f1d", slug: "omp-cloud", name: "omp-cloud", blocked: true, system: false },
			{ id: "7a2e", slug: "system", name: "system", blocked: false, system: true },
		]);
		expect(parseListTeams("")).toEqual([]);
		expect(parseListTeams("vmon: error: noise\n")).toEqual([]);
	});

	test("create-team: slug and one-time key", () => {
		expect(parseCreateTeam(CREATED)).toEqual({ slug: "omp-cloud", key: KEY });
		expect(parseCreateTeam("team x (1)\nslug    x\n")).toBeNull();
		expect(parseCreateTeam(`slug x\napi key not-a-key\n`)).toBeNull();
	});

	test("create-api-key prints only the key", () => {
		expect(parseApiKey(`${KEY}\n`)).toBe(KEY);
		expect(parseApiKey("oops")).toBeNull();
	});

	test("the cluster secret comes from the env file", () => {
		expect(clusterSecretOf(`VMON_ADMIN_TOKEN=x\nVMON_CLUSTER_SECRET=${SECRET}\n`)).toBe(SECRET);
		expect(clusterSecretOf(`export VMON_CLUSTER_SECRET="${SECRET}"`)).toBe(SECRET);
		expect(clusterSecretOf("VMON_ADMIN_TOKEN=x\n")).toBeNull();
		expect(clusterSecretOf("VMON_CLUSTER_SECRET=\n")).toBeNull();
	});

	test("limits carry every flag", () => {
		expect(limitArgs(7)).toEqual([
			"--max-concurrent-sandboxes", "7", "--max-concurrent-builds", "4", "--max-vcpus", "8",
			"--max-memory-mb", "8192", "--max-disk-mb", "20480", "--max-length-hours", "24",
		]);
	});
});

function vmon(answers: { list?: Partial<CommandResult>[]; create?: Partial<CommandResult>; mint?: Partial<CommandResult>; limits?: Partial<CommandResult> }) {
	const lists = [...(answers.list ?? [{ stdout: TEAMS }])];
	return fakeRunner((argv) => {
		const verb = argv[4];
		if (verb === "list-teams") return lists.length > 1 ? lists.shift() : lists[0];
		if (verb === "create-team") return answers.create ?? { stdout: CREATED };
		if (verb === "create-api-key") return answers.mint ?? { stdout: `${OTHER_KEY}\n` };
		if (verb === "set-limits") return answers.limits ?? { stdout: "team line\n" };
		return undefined;
	});
}

const ensure = (runner: FakeRunner, overrides: { slug?: string; mintKey?: boolean } = {}) =>
	ensureTeam({ runner: runner.run, secret: SECRET, slug: overrides.slug ?? "omp-cloud", maxSandboxes: 12, mintKey: overrides.mintKey ?? false, sleep: async () => {} });

describe("ensureTeam", () => {
	test("creates a missing team with its limits, takes the key from create-team, then applies the limits", async () => {
		const runner = vmon({ list: [{ stdout: `0b3c\tacme\tacme\t${COUNTS}\n` }] });
		const outcome = await ensure(runner);
		expect(outcome.team).toEqual({ slug: "omp-cloud", created: true });
		expect(outcome.key).toBe(KEY);
		expect(outcome.steps.map((step) => [step.id, step.status])).toEqual([["system.team", "changed"], ["system.team.key", "changed"], ["system.team.limits", "ok"]]);
		const verbs = runner.calls.map((call) => call.argv.slice(4, 6).join(" "));
		expect(verbs).toEqual(["list-teams", "create-team omp-cloud", "set-limits omp-cloud"]);
		expect(runner.calls[1]?.argv.slice(6)).toEqual(limitArgs(12));
		expect(runner.calls[2]?.argv.slice(6)).toEqual(limitArgs(12));
	});

	test("an existing team is not created twice; limits are re-applied and no key is minted", async () => {
		const runner = vmon({});
		const outcome = await ensure(runner);
		expect(outcome.team).toEqual({ slug: "omp-cloud", created: false });
		expect(outcome.key).toBeUndefined();
		expect(runner.calls.map((call) => call.argv[4])).toEqual(["list-teams", "set-limits"]);
		expect(outcome.steps.every((step) => step.status === "ok")).toBe(true);
	});

	test("an existing team gets a new key only when one is asked for", async () => {
		const runner = vmon({});
		const outcome = await ensure(runner, { mintKey: true });
		expect(outcome.key).toBe(OTHER_KEY);
		expect(outcome.team.created).toBe(false);
		expect(runner.calls.map((call) => call.argv.slice(4).join(" "))).toEqual(["list-teams", "create-api-key omp-cloud", `set-limits omp-cloud ${limitArgs(12).join(" ")}`]);
	});

	test("the cluster secret goes into the child's environment and never into argv", async () => {
		const runner = vmon({ list: [{ stdout: "" }] });
		await ensure(runner);
		for (const call of runner.calls) {
			expect(call.options.env).toEqual({ VMON_CLUSTER_SECRET: SECRET });
			expect(call.argv.join(" ")).not.toContain(SECRET);
			expect(call.argv.slice(0, 5)).toEqual(["/opt/vmon/vmon", "admin", "--cluster-url", "http://127.0.0.1:7947", call.argv[4] ?? ""]);
		}
	});

	test("no key appears in any step text", async () => {
		const outcome = await ensure(vmon({ list: [{ stdout: "" }] }), { mintKey: true });
		expect(JSON.stringify(outcome.steps)).not.toContain("e2b_");
	});

	test("list-teams is retried while vmon admin is not ready yet", async () => {
		const runner = vmon({ list: [{ code: 1, stderr: "vmon: error: no driver yet" }, { code: 1, stderr: "vmon: error: no driver yet" }, { stdout: TEAMS }] });
		const outcome = await ensure(runner);
		expect(outcome.steps.at(-1)?.status).toBe("ok");
		expect(runner.calls.filter((call) => call.argv[4] === "list-teams")).toHaveLength(3);
	});

	test("a list-teams that never works is a failed step with the reason", async () => {
		const outcome = await ensure(vmon({ list: [{ code: 1, stderr: "vmon: error: no cluster secret\n" }] }));
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]).toMatchObject({ id: "system.team", status: "failed" });
		expect(outcome.steps[0]?.detail).toContain("no cluster secret");
	});

	test("a failed create-team creates nothing and mints nothing", async () => {
		const runner = vmon({ list: [{ stdout: "" }], create: { code: 1, stderr: "vmon: error: boom" } });
		const outcome = await ensure(runner);
		expect(outcome.team.created).toBe(false);
		expect(outcome.key).toBeUndefined();
		expect(outcome.steps[0]?.status).toBe("failed");
		expect(runner.calls.some((call) => call.argv[4] === "set-limits")).toBe(false);
	});

	test("a team vmon named differently (slug collision) is a failure, and its key is still returned", async () => {
		const outcome = await ensure(vmon({ list: [{ stdout: "" }], create: { stdout: `team    omp-cloud (1)\nslug    omp-cloud-2\napi key ${KEY}\n` } }));
		expect(outcome.steps[0]).toMatchObject({ status: "failed" });
		expect(outcome.steps[0]?.detail).toContain("omp-cloud-2");
		expect(outcome.key).toBe(KEY);
	});

	test("a key that was minted survives a failing set-limits", async () => {
		const outcome = await ensure(vmon({ list: [{ stdout: "" }], limits: { code: 1, stderr: "vmon: error: bad limit" } }));
		expect(outcome.key).toBe(KEY);
		expect(outcome.steps.at(-1)).toMatchObject({ id: "system.team.limits", status: "failed" });
	});

	test("create-team that printed no key marks the team created but fails", async () => {
		const outcome = await ensure(vmon({ list: [{ stdout: "" }], create: { stdout: "slug    omp-cloud\n" } }));
		expect(outcome.team.created).toBe(true);
		expect(outcome.key).toBeUndefined();
		expect(outcome.steps[0]?.status).toBe("failed");
	});

	test("a failing create-api-key is a failed step", async () => {
		const outcome = await ensure(vmon({ mint: { code: 1, stderr: "vmon: error: no such team" } }), { mintKey: true });
		expect(outcome.key).toBeUndefined();
		expect(outcome.steps.at(-1)).toMatchObject({ id: "system.team.key", status: "failed" });
	});
});
