import { describe, expect, test } from "bun:test";
import { compareViews, parseRecord, replay, type TspRecord } from "./tsp";

function frame(s: number, ops: unknown[]): TspRecord {
	return { t: s, dir: "out", verb: "f", body: { sf: "s:1", s, ops } };
}

const OPEN: TspRecord = { t: 0, dir: "out", verb: "o", body: { id: "s:1", mode: "inline", role: "omp.session" } };
const REGIONS = frame(1, [
	["add", "main", "s:1", null, { id: "main", k: "col" }],
	["add", "dock", "s:1", null, { id: "dock", k: "col" }],
]);

function text(id: string, role: string, value: string): unknown {
	return { id, k: "text", p: { role, spans: [{ t: value }] } };
}

/** A tile the way describeJobTile builds one: head (dot, title), then the notes. */
function tile(id: string, job: string, notes: unknown[]): unknown {
	return {
		id,
		k: "col",
		p: { role: "omp.job.tile" },
		c: [{ id: `${id}/head`, k: "row", p: { role: "omp.job.tile.head" }, c: [text(`${id}/head/0`, "omp.job.tile.dot", "●"), text(`${id}/head/1`, "omp.job.tile.title", job)] }, ...notes],
	};
}

/** The wait tool's card holding a tiles row, the way omp's wait view does. */
function waitCard(id: string, tiles: unknown[]): unknown {
	return { id, k: "tool", p: { role: "omp.tool.wait" }, c: [{ id: `${id}.tiles`, k: "row", p: { role: "omp.job.tiles" }, c: tiles }] };
}

describe("rows", () => {
	test("a rows node is reported with its ancestors and told apart as omp-cloud's by its text", () => {
		const result = replay([
			OPEN,
			REGIONS,
			frame(2, [
				["add", "m1", "main", null, { id: "m1", k: "col", p: { role: "omp.custom" }, c: [{ id: "m1/body", k: "rows", p: { cols: 80, lines: ["\x1b[1m☁ turn 3 done\x1b[0m", "", "ok"] } }] }],
				["add", "m2", "main", null, { id: "m2", k: "rows", p: { cols: 80, lines: ["some other component"] } }],
			]),
		]);
		const findings = [...result.rows.values()];
		expect(findings.map(f => [f.key, f.cloud])).toEqual([
			["s:1:m1/body", true],
			["s:1:m2", false],
		]);
		expect(findings[0]?.lines).toEqual(["☁ turn 3 done", "ok"]);
		expect(findings[0]?.path.map(step => step.id)).toEqual(["s:1", "main", "m1", "m1/body"]);
	});

	test("a replay with no fallback finds none", () => {
		expect(replay([OPEN, REGIONS, frame(2, [["add", "m", "main", null, text("m", "x", "hi")]])]).rows.size).toBe(0);
	});
});

describe("job views", () => {
	const richTile = ["omp.job.tile.figure", "omp.job.tile.grid", "omp.job.tile.stats", "omp.job.tile.stage"];
	const isCloud = (identity: string): boolean => identity.includes("swift-otter");

	test("views are compared per surface; a tile found again richer replaces the poorer one", () => {
		const result = replay(
			[
				OPEN,
				REGIONS,
				frame(2, [["add", "w1", "main", null, waitCard("w1", [tile("w1.tiles/n", "bg_1", [text("w1.tiles/n/stats", "omp.job.tile.stats", "lines 4")]), tile("w1.tiles/c", "swift-otter", [])])]]),
				// the cloud tile grows its notes in later frames
				...richTile.map((role, i) => frame(3 + i, [["add", `w1.tiles/c/${role}`, "w1.tiles/c", null, text(`w1.tiles/c/${role}`, role, "x")]])),
				frame(10, [
					[
						"add",
						"sheet",
						"dock",
						null,
						{
							id: "sheet",
							k: "overlay",
							p: { role: "omp.overlay.jobs" },
							c: [
								{
									id: "sheet/detail",
									k: "col",
									p: { role: "omp.jobs.detail" },
									c: [text("sheet/detail/id", "omp.jobs.id", "task · swift-otter"), { id: "sheet/detail/widget", k: "col", p: { role: "omp.job.widget" }, c: [text("sheet/detail/widget/title", "omp.job.widget.title", "swift-otter"), text("sheet/detail/widget/stat", "omp.job.widget.stat", "cost $0.1")] }],
								},
							],
						},
					],
				]),
			],
			{ isCloud },
		);
		const { surfaces, cloudComplete } = compareViews(result.views.values());
		const wait = surfaces.find(s => s.where === "wait card");
		expect(wait?.native.map(v => v.job)).toEqual(["bg_1"]);
		expect(wait?.cloud.map(v => v.job)).toEqual(["swift-otter"]);
		expect(wait?.cloudRoles).toEqual(["omp.job.tile", ...richTile, "omp.job.tile.dot", "omp.job.tile.head", "omp.job.tile.title"].sort());
		expect(wait?.missingRequired).toEqual([]);
		expect(wait?.missingRoles).toEqual([]);
		// the pill drew nothing: a required surface with no cloud view is a finding
		const pill = surfaces.find(s => s.where === "jobs pill");
		expect(pill?.cloud).toEqual([]);
		expect(pill?.missingRequired).toHaveLength(4);
		// the sheet's widget is the cloud job's through the sheet's id line; it lacks the meter and the grid
		const sheet = surfaces.find(s => s.where === "jobs sheet");
		expect(sheet?.cloud.map(v => v.job)).toEqual(["swift-otter task · swift-otter"]);
		expect(sheet?.missingRequired).toEqual(["omp.job.widget.meter | omp.job.widget.bars", "omp.job.widget.grid"]);
		expect(cloudComplete).toBe(false);
	});

	test("a tile inside the pill's hovercard prop is found, one per job, on the jobs pill", () => {
		const hovercard = {
			k: "col",
			c: [
				{
					k: "row",
					p: { role: "omp.job.tiles" },
					c: [
						{ k: "col", p: { role: "omp.job.tile" }, c: [{ k: "text", p: { role: "omp.job.tile.title", spans: [{ t: "bg_1" }] } }] },
						{ k: "col", p: { role: "omp.job.tile" }, c: [{ k: "text", p: { role: "omp.job.tile.title", spans: [{ t: "swift-otter" }] } }] },
					],
				},
			],
		};
		const pill = { id: "hud", k: "row", p: { role: "omp.hud" }, c: [{ id: "hud/seg", k: "row", p: { role: "omp.hud.seg", hovercard } }] };
		const result = replay([OPEN, REGIONS, frame(2, [["add", "hud", "dock", null, pill]])], { isCloud });
		expect([...result.views.values()].map(v => [v.where, v.kind, v.cloud, v.job]).sort()).toEqual([
			["jobs pill", "tile", false, "bg_1"],
			["jobs pill", "tile", true, "swift-otter"],
		]);
	});

	test("every required surface carrying every required role is complete", () => {
		const complete = compareViews([
			{ key: "a", kind: "tile", where: "wait card", surface: "s:1", job: "x", roles: Object.fromEntries(richTile.map(r => [r, 1])), kinds: {}, frame: 1, cloud: true },
			{ key: "b", kind: "tile", where: "jobs pill", surface: "s:1", job: "x", roles: Object.fromEntries(richTile.map(r => [r, 1])), kinds: {}, frame: 1, cloud: true },
			{ key: "c", kind: "widget", where: "jobs sheet", surface: "s:1", job: "x", roles: { "omp.job.widget.bars": 1, "omp.job.widget.grid": 1, "omp.job.widget.stat": 1 }, kinds: {}, frame: 1, cloud: true },
		]);
		expect(complete.cloudComplete).toBe(true);
	});
});

describe("parseRecord", () => {
	test("reads JSON lines and skips a half-written last one", () => {
		const line = `${JSON.stringify({ t: 1, dir: "out", verb: "o", body: {} })}\n{"t":2,"dir":"in","verb"`;
		expect(parseRecord(line).map(r => r.verb)).toEqual(["o"]);
	});
});
