import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkJobsChildren, sheetRows, type SheetNode } from "./children";

function item(id: string, label: string, glyph: string, icon: string, type: string, tone = "pending"): SheetNode {
	return {
		id: `s.split/master/jobs/${id}`,
		k: "item",
		p: {
			label: [...(glyph === "" ? [] : [{ t: glyph, s: "mono dim" }]), { t: label }],
			value: [{ t: "1m19s", s: "mono" }],
			icon,
			tone,
			title: `${label}\nRunning · ${type} · ${id}`,
		},
	};
}

function sheet(items: SheetNode[]): SheetNode {
	return { k: "col", p: {}, c: [{ k: "col", p: { role: "omp.jobs.master" }, c: [{ k: "list", c: items }] }] };
}

const NATIVE = [item("ParityAgent", "ParityAgent", "", "agent", "task"), item("bg_2", "for i in native-agent", "└─ ", "bash", "bash"), item("bg_1", "native-bash", "", "bash", "bash")];
const CLOUD = [
	item("PrintGreeting", "PrintGreeting", "", "agent", "task"),
	item("bg_3", "for i in $(seq 1 45); do echo \"cloud-bg step $i\"", "├─ ", "bash", "bash"),
	item("CloudHelper", "CloudHelper", "└─ ", "agent", "task"),
];

describe("sheetRows", () => {
	test("a glyph nests a row under the top-level row above it", () => {
		const rows = sheetRows(sheet([...NATIVE, ...CLOUD]));
		expect(rows.map(r => [r.id, r.depth, r.top, r.type])).toEqual([
			["ParityAgent", 0, "ParityAgent", "task"],
			["bg_2", 1, "ParityAgent", "bash"],
			["bg_1", 0, "bg_1", "bash"],
			["PrintGreeting", 0, "PrintGreeting", "task"],
			["bg_3", 1, "PrintGreeting", "bash"],
			["CloudHelper", 1, "PrintGreeting", "task"],
		]);
		expect(rows[1]?.label).toBe("for i in native-agent");
		expect(rows[1]?.clock).toBe(true);
	});
});

describe("checkJobsChildren", () => {
	async function run(items: SheetNode[], ansi?: string): Promise<{ problems: string[]; cloud: string[] }> {
		const dir = await mkdtemp(join(tmpdir(), "parity-children-"));
		try {
			await mkdir(join(dir, "native"));
			await mkdir(join(dir, "ansi"));
			await writeFile(join(dir, "native", "02b-jobs-tail-1.json"), JSON.stringify({ "s:1": sheet(items) }));
			if (ansi !== undefined) await writeFile(join(dir, "ansi", "02b-jobs-tail-1.txt"), ansi);
			const found = await checkJobsChildren(dir, ["PrintGreeting"], { bash: "cloud-bg", task: "CloudHelper" }, { native: true, ansi: ansi !== undefined });
			return found;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	const ANSI = [
		"│ ParityAgent [task] running (1m18s)                       │",
		"│ └─ bg_2 [bash] running (1m18s)                           │",
		"│      for i in native-agent                               │",
		"│ PrintGreeting [task] running (1m17s)                     │",
		"│ ├─ bg_3 [bash] running (1m10s)                           │",
		"│ │    for i in $(seq 1 45); do echo cloud-bg step         │",
		"│ └─ CloudHelper [task] running (1m10s)                    │",
	].join("\n");

	test("children nested like a native subagent's pass", async () => {
		const found = await run([...NATIVE, ...CLOUD], ANSI);
		expect(found.problems).toEqual([]);
		expect(found.cloud).toHaveLength(3);
	});

	test("a missing child, a flat cloud list and a different icon are each reported", async () => {
		const flat = await run([NATIVE[0] as SheetNode, NATIVE[1] as SheetNode, item("PrintGreeting", "PrintGreeting", "", "agent", "task")], "│ PrintGreeting [task] running │");
		expect(flat.problems).toEqual([
			"the cloud job has no nested bash row labelled with its command (cloud-bg)",
			"the cloud job has no nested task row for its subagent (CloudHelper)",
			"the ANSI /jobs list has no nested [bash] row under the cloud job with its command (cloud-bg)",
			"the ANSI /jobs list has no nested [task] row for the cloud job's subagent (CloudHelper)",
		]);
		const odd = await run([...NATIVE, CLOUD[0] as SheetNode, item("bg_3", "cloud-bg", "├─ ", "job", "bash"), CLOUD[2] as SheetNode]);
		expect(odd.problems.length).toBe(1);
		expect(odd.problems[0]).toContain("icon job");
	});
});
