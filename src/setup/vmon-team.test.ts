import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../update/system";
import type { FakeRunner } from "./system-fakes";
import { fakeRunner } from "./system-fakes";
import { deleteTeam, ensureTeam, envValueOf, limitArgs, parseApiKey, parseCreateTeam } from "./vmon-team";

const SECRET = "c0ffee".repeat(10);
const KEY = `e2b_${"ab12".repeat(10)}`;
const OTHER_KEY = `e2b_${"cd34".repeat(10)}`;
const CREATED = `team    omp-cloud (9f1d)\nslug    omp-cloud\napi key ${KEY}\n`;
const EXISTING = "team    omp-cloud (9f1d)\nslug    omp-cloud\n";
const DELETED = "deleted team acme (0b3c)\nkilled sandboxes=1 cancelled builds=0\nremoved templates=2 volumes=0 secrets=0 webhooks=0 api keys=1\n";

describe("parsers", () => {
	test("create-team: the slug, and the one-time key only when the team was created", () => {
		expect(parseCreateTeam(CREATED)).toEqual({ slug: "omp-cloud", key: KEY });
		expect(parseCreateTeam(EXISTING)).toEqual({ slug: "omp-cloud", key: null });
		expect(parseCreateTeam("team x (1)\n")).toBeNull();
		expect(parseCreateTeam(`slug x\napi key not-a-key\n`)).toBeNull();
	});

	test("create-api-key prints only the key", () => {
		expect(parseApiKey(`${KEY}\n`)).toBe(KEY);
		expect(parseApiKey("oops")).toBeNull();
	});

	test("a variable's value comes from the env file", () => {
		expect(envValueOf(`VMON_ADMIN_TOKEN=x\nVMON_CLUSTER_SECRET=${SECRET}\n`, "VMON_CLUSTER_SECRET")).toBe(SECRET);
		expect(envValueOf(`export VMON_CLUSTER_SECRET="${SECRET}"`, "VMON_CLUSTER_SECRET")).toBe(SECRET);
		expect(envValueOf("VMON_ADMIN_TOKEN=x\n", "VMON_CLUSTER_SECRET")).toBeNull();
		expect(envValueOf("VMON_CLUSTER_SECRET=\n", "VMON_CLUSTER_SECRET")).toBeNull();
		expect(envValueOf(`VMON_CLUSTER_SECRET=${SECRET}\nVMON_ADMIN_TOKEN='tok'\n`, "VMON_ADMIN_TOKEN")).toBe("tok");
		expect(envValueOf("XVMON_ADMIN_TOKEN=nope\n", "VMON_ADMIN_TOKEN")).toBeNull();
	});

	test("limits carry every flag", () => {
		expect(limitArgs(7)).toEqual([
			"--max-concurrent-sandboxes", "7", "--max-concurrent-builds", "4", "--max-vcpus", "8",
			"--max-memory-mb", "8192", "--max-disk-mb", "20480", "--max-length-hours", "24",
		]);
	});
});

function vmon(answers: { create?: Partial<CommandResult>[]; mint?: Partial<CommandResult>; limits?: Partial<CommandResult> } = {}) {
	const creates = [...(answers.create ?? [{ stdout: CREATED }])];
	return fakeRunner((argv) => {
		const verb = argv[4];
		if (verb === "create-team") return creates.length > 1 ? creates.shift() : creates[0];
		if (verb === "create-api-key") return answers.mint ?? { stdout: `${OTHER_KEY}\n` };
		if (verb === "set-limits") return answers.limits ?? { stdout: "team line\n" };
		return undefined;
	});
}

const ensure = (runner: FakeRunner, overrides: { slug?: string; mintKey?: boolean } = {}) =>
	ensureTeam({ runner: runner.run, secret: SECRET, slug: overrides.slug ?? "omp-cloud", maxSandboxes: 12, mintKey: overrides.mintKey ?? false, sleep: async () => {} });

describe("ensureTeam", () => {
	test("a missing team is created with its limits and the key of create-team, then the limits are applied", async () => {
		const runner = vmon();
		const outcome = await ensure(runner);
		expect(outcome.team).toEqual({ slug: "omp-cloud", created: true });
		expect(outcome.key).toBe(KEY);
		expect(outcome.steps.map((step) => [step.id, step.status])).toEqual([["system.team", "changed"], ["system.team.key", "changed"], ["system.team.limits", "ok"]]);
		expect(runner.calls.map((call) => call.argv.slice(4).join(" "))).toEqual([
			`create-team omp-cloud --if-missing ${limitArgs(12).join(" ")}`,
			`set-limits omp-cloud ${limitArgs(12).join(" ")}`,
		]);
	});

	test("an existing team is left alone: no key, and the limits are re-applied", async () => {
		const runner = vmon({ create: [{ stdout: EXISTING, stderr: "team omp-cloud already exists; left unchanged\n" }] });
		const outcome = await ensure(runner);
		expect(outcome.team).toEqual({ slug: "omp-cloud", created: false });
		expect(outcome.key).toBeUndefined();
		expect(runner.calls.map((call) => call.argv[4])).toEqual(["create-team", "set-limits"]);
		expect(outcome.steps.map((step) => [step.id, step.status])).toEqual([["system.team", "ok"], ["system.team.limits", "ok"]]);
	});

	test("an existing team gets a new key only when one is asked for", async () => {
		const runner = vmon({ create: [{ stdout: EXISTING }] });
		const outcome = await ensure(runner, { mintKey: true });
		expect(outcome.key).toBe(OTHER_KEY);
		expect(outcome.team.created).toBe(false);
		expect(runner.calls.map((call) => call.argv.slice(4).join(" "))).toEqual([
			`create-team omp-cloud --if-missing ${limitArgs(12).join(" ")}`,
			"create-api-key omp-cloud",
			`set-limits omp-cloud ${limitArgs(12).join(" ")}`,
		]);
	});

	test("the cluster secret goes into the child's environment and never into argv", async () => {
		const runner = vmon();
		await ensure(runner);
		for (const call of runner.calls) {
			expect(call.options.env).toEqual({ VMON_CLUSTER_SECRET: SECRET });
			expect(call.argv.join(" ")).not.toContain(SECRET);
			expect(call.argv.slice(0, 5)).toEqual(["/opt/vmon/vmon", "admin", "--cluster-url", "http://127.0.0.1:7947", call.argv[4] ?? ""]);
		}
	});

	test("no key appears in any step text", async () => {
		const outcome = await ensure(vmon(), { mintKey: true });
		expect(JSON.stringify(outcome.steps)).not.toContain("e2b_");
	});

	test("create-team is retried while vmon admin is not ready yet", async () => {
		const runner = vmon({ create: [{ code: 1, stderr: "vmon: error: no driver yet" }, { code: 1, stderr: "vmon: error: no driver yet" }, { stdout: CREATED }] });
		const outcome = await ensure(runner);
		expect(outcome.steps.every((step) => step.status !== "failed")).toBe(true);
		expect(outcome.key).toBe(KEY);
		expect(runner.calls.filter((call) => call.argv[4] === "create-team")).toHaveLength(3);
	});

	test("a create-team that never works is one failed step with the reason, and no limits are set", async () => {
		const runner = vmon({ create: [{ code: 1, stderr: "vmon: error: no cluster secret\n" }] });
		const outcome = await ensure(runner);
		expect(outcome.team.created).toBe(false);
		expect(outcome.key).toBeUndefined();
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]).toMatchObject({ id: "system.team", status: "failed" });
		expect(outcome.steps[0]?.detail).toContain("no cluster secret");
		expect(runner.calls.filter((call) => call.argv[4] === "create-team")).toHaveLength(5);
		expect(runner.calls.some((call) => call.argv[4] === "set-limits")).toBe(false);
	});

	test("a team vmon named differently is a failure", async () => {
		const runner = vmon({ create: [{ stdout: `team    omp-cloud (1)\nslug    omp-cloud-2\napi key ${KEY}\n` }] });
		const outcome = await ensure(runner);
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]).toMatchObject({ id: "system.team", status: "failed" });
		expect(outcome.steps[0]?.detail).toContain("omp-cloud-2");
		expect(runner.calls.some((call) => call.argv[4] === "set-limits")).toBe(false);
	});

	test("a key that was created survives a failing set-limits", async () => {
		const outcome = await ensure(vmon({ limits: { code: 1, stderr: "vmon: error: bad limit" } }));
		expect(outcome.key).toBe(KEY);
		expect(outcome.steps.at(-1)).toMatchObject({ id: "system.team.limits", status: "failed" });
	});

	test("an answer without a slug is a failure", async () => {
		const outcome = await ensure(vmon({ create: [{ stdout: "team    omp-cloud (1)\n" }] }));
		expect(outcome.team.created).toBe(false);
		expect(outcome.steps).toHaveLength(1);
		expect(outcome.steps[0]).toMatchObject({ id: "system.team", status: "failed" });
	});

	test("an api key line that is not a key marks the team created but fails", async () => {
		const outcome = await ensure(vmon({ create: [{ stdout: "slug    omp-cloud\napi key garbage\n" }] }));
		expect(outcome.team.created).toBe(true);
		expect(outcome.key).toBeUndefined();
		expect(outcome.steps[0]?.status).toBe("failed");
	});

	test("a failing create-api-key is a failed step", async () => {
		const outcome = await ensure(vmon({ create: [{ stdout: EXISTING }], mint: { code: 1, stderr: "vmon: error: no such team" } }), { mintKey: true });
		expect(outcome.key).toBeUndefined();
		expect(outcome.steps.at(-1)).toMatchObject({ id: "system.team.key", status: "failed" });
	});
});

describe("deleteTeam", () => {
	const remove = (runner: FakeRunner, clusterUrl?: string) =>
		deleteTeam({ runner: runner.run, secret: SECRET, slug: "acme", ...(clusterUrl === undefined ? {} : { clusterUrl }) });

	test("a deleted team is a changed step that carries vmon's counts", async () => {
		const runner = fakeRunner(() => ({ stdout: DELETED }));
		const step = await remove(runner);
		expect(step).toEqual({
			id: "system.team.old",
			status: "changed",
			detail: "deleted the old vmon team acme (killed sandboxes=1 cancelled builds=0; removed templates=2 volumes=0 secrets=0 webhooks=0 api keys=1)",
		});
		expect(runner.calls.map((call) => call.argv)).toEqual([["/opt/vmon/vmon", "admin", "--cluster-url", "http://127.0.0.1:7947", "delete-team", "acme", "--force"]]);
	});

	test("the cluster secret is in the environment only, and the cluster url is the given one", async () => {
		const runner = fakeRunner(() => ({ stdout: DELETED }));
		await remove(runner, "http://192.168.1.5:7947");
		expect(runner.calls[0]?.options.env).toEqual({ VMON_CLUSTER_SECRET: SECRET });
		expect(runner.calls[0]?.argv.join(" ")).not.toContain(SECRET);
		expect(runner.calls[0]?.argv[3]).toBe("http://192.168.1.5:7947");
	});

	test("an unknown team is already gone", async () => {
		const step = await remove(fakeRunner(() => ({ code: 1, stderr: "vmon: error: team acme not found\n" })));
		expect(step).toMatchObject({ id: "system.team.old", status: "ok" });
		expect(step.detail).toContain("already gone");
	});

	test("any other failure is skipped with a fix that never holds the secret", async () => {
		const step = await remove(fakeRunner(() => ({ code: 1, stderr: "vmon: error: sandbox kill timed out\n" })), "http://192.168.1.5:7947");
		expect(step.status).toBe("skipped");
		expect(step.detail).toContain("kept the old vmon team acme");
		expect(step.detail).toContain("sandbox kill timed out");
		expect(step.fix).toContain("delete-team acme --force");
		expect(step.fix).toContain("http://192.168.1.5:7947");
		expect(`${step.detail}${step.fix}`).not.toContain(SECRET);
	});
});
