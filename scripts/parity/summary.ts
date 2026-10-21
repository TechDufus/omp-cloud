/** The parity numbers of one replayed TSP record, and the table `mise run parity:capture` prints. */
import type { ChildrenFinding } from "./children";
import { compareViews, REQUIRED_CLOUD_ROLES, type Replay, type RowsFinding, stripAnsi, TILE_ROLES, type ViewComparison, WIDGET_ROLES } from "./tsp";

/** One ANSI capture's Subagents strip (omp's "Subagents · N running" list under the transcript). */
export interface StripFinding {
	step: string;
	/** The strip's entries, without the tree glyphs; empty when the capture shows no strip. */
	entries: string[];
	/** Whether the cloud job (by its job id) is among them. */
	cloudListed: boolean;
}

export interface Summary {
	rows: { total: number; cloud: number; other: number; findings: RowsFinding[] };
	frames: number;
	rejected: number;
	views: ViewComparison;
	/** omp's own per-frame `rows` count (`PI_TUI_NATIVE_STATS=1`): the frames it logged, the most rows in one and in the last, when its log was readable. */
	stats: { frames: number; maxRows: number; lastRows: number } | undefined;
	/** The Subagents strip of the ANSI wait view (and of the launch and `/jobs` captures taken while the cloud turn runs): the cloud agent must be in it. */
	strip?: StripFinding[];
	/** The cloud job's `/jobs` Output tail midway through the turn. */
	tail?: TailFinding;
	/** The cloud job's children in the `/jobs` list, native and ANSI, against a native subagent's. */
	children?: ChildrenFinding;
}

/** The cloud job's `/jobs` Output box midway through its turn. */
export interface TailFinding {
	/** The box's lines, oldest first. */
	lines: string[];
	/** What is wrong with it; empty when it is a tail: several lines, tool one-liners and assistant lines, the newest last. */
	problems: string[];
}

/** The scripted cloud turn's assistant lines (provider.ts `TAIL_NOTES`), in the order it says them. */
const TAIL_NOTE_PREFIXES = ["Tail step one", "Tail step two", "Tail step three"] as const;

interface DocNode {
	k: string;
	p?: { role?: unknown; text?: unknown; spans?: unknown };
	c?: DocNode[];
}

function spanText(node: DocNode): string {
	const spans = node.p?.spans;
	if (!Array.isArray(spans)) return "";
	return spans.map(span => (typeof span === "object" && span !== null && typeof (span as { t?: unknown }).t === "string" ? (span as { t: string }).t : "")).join("");
}

/** Reads `native/02b-jobs-tail-<row>.json` (one per sheet row): the Output box of the `/jobs` detail whose id line names a cloud job. */
export async function checkJobsTail(dir: string, cloudIds: readonly string[]): Promise<TailFinding> {
	const details: DocNode[] = [];
	const collect = (node: DocNode): void => {
		if (node.p?.role === "omp.jobs.detail") details.push(node);
		for (const child of node.c ?? []) collect(child);
	};
	for (let row = 1; row <= 12; row++) {
		const file = Bun.file(`${dir}/native/02b-jobs-tail-${row}.json`);
		if (!(await file.exists())) break;
		const doc = Object.values(JSON.parse(await file.text()) as Record<string, DocNode>)[0];
		if (doc !== undefined) collect(doc);
	}
	if (details.length === 0) return { lines: [], problems: ["no native/02b-jobs-tail-*.json capture"] };
	const find = (node: DocNode, role: string): DocNode | undefined => {
		if (node.p?.role === role) return node;
		for (const child of node.c ?? []) {
			const hit = find(child, role);
			if (hit !== undefined) return hit;
		}
		return undefined;
	};
	for (const detail of details) {
		const id = find(detail, "omp.jobs.id");
		if (id === undefined || !cloudIds.some(name => name !== "" && spanText(id).includes(name))) continue;
		const output = find(detail, "omp.jobs.output");
		const text = typeof output?.p?.text === "string" ? output.p.text : "";
		const lines = stripAnsi(text).split("\n").filter(line => line.trim() !== "");
		const problems: string[] = [];
		if (lines.length <= 1) problems.push(`the Output box holds ${lines.length} line(s), not a tail`);
		if (!lines.some(line => /\bbash:/.test(line))) problems.push("no tool one-liner (`bash: …`)");
		const at = TAIL_NOTE_PREFIXES.map(prefix => lines.findIndex(line => line.includes(prefix)));
		const seen = at.filter(index => index >= 0);
		if (seen.length === 0) problems.push("no assistant line");
		if (seen.some((index, i) => i > 0 && index < (seen[i - 1] ?? -1))) problems.push("assistant lines are not oldest first");
		const lastTool = lines.findLastIndex(line => /\bbash:/.test(line));
		const lastNote = Math.max(...at);
		if (lastNote >= 0 && lastTool >= 0 && lines.length > 0 && Math.max(lastNote, lastTool) !== lines.length - 1) problems.push("the newest line is not last");
		return { lines, problems };
	}
	return { lines: [], problems: ["no /jobs detail for the cloud job in the capture"] };
}

/** The ANSI pass's running-turn captures whose Subagents strip must list the cloud agent. */
const STRIP_STEPS = ["01-launch-card", "02-jobs-3", "03-wait-view"] as const;

/** Reads the strip out of each capture; `cloudIds` are what name the cloud job on screen (its job id first). */
export async function checkSubagentStrip(dir: string, cloudIds: readonly string[]): Promise<StripFinding[]> {
	const found: StripFinding[] = [];
	for (const step of STRIP_STEPS) {
		let lines: string[];
		try {
			lines = stripAnsi(await Bun.file(`${dir}/ansi/${step}.ansi`).text()).split("\n");
		} catch {
			continue;
		}
		const head = lines.findIndex(line => /Subagents\s·\s\d+\srunning/.test(line));
		const entries: string[] = [];
		if (head >= 0) {
			for (const line of lines.slice(head + 1)) {
				const entry = /^\s*[├└]─\s*(.*\S)\s*$/.exec(line);
				if (entry?.[1] === undefined) break;
				entries.push(entry[1]);
			}
		}
		found.push({ step, entries, cloudListed: entries.some(entry => cloudIds.some(id => id !== "" && entry.includes(id))) });
	}
	return found;
}

export function analyze(result: Replay, stats: Summary["stats"]): Summary {
	const findings = [...result.rows.values()];
	return {
		rows: { total: findings.length, cloud: findings.filter(f => f.cloud).length, other: findings.filter(f => !f.cloud).length, findings },
		frames: result.frames,
		rejected: result.rejected.length,
		views: compareViews(result.views.values()),
		stats,
	};
}

/** `PI_TUI_NATIVE_STATS=1` makes omp's debug log say `TSP frame` with the `rows` count of every frame it sends. */
export function parseStats(log: string): Summary["stats"] {
	let frames = 0;
	let maxRows = 0;
	let lastRows = 0;
	for (const line of log.split("\n")) {
		if (!line.includes("TSP frame")) continue;
		const rows = /"rows"\s*:\s*(\d+)|\brows[=:]\s*(\d+)/.exec(line);
		const value = Number(rows?.[1] ?? rows?.[2]);
		if (!Number.isFinite(value)) continue;
		frames++;
		maxRows = Math.max(maxRows, value);
		lastRows = value;
	}
	return frames === 0 ? undefined : { frames, maxRows, lastRows };
}

export function printSummary(summary: Summary | undefined, outDir: string): void {
	const out = (text: string): void => console.log(text);
	const count = (label: string, value: string | number, note = ""): void => out(`  ${label.padEnd(46)} ${String(value).padStart(5)}  ${note}`);
	out("\n═══ parity summary ═══");
	if (summary === undefined) {
		out("  (no native pass: no TSP numbers)");
		return;
	}
	out(`TSP record: ${summary.frames} frames replayed${summary.rejected > 0 ? `, ${summary.rejected} ops rejected by the reference applier` : ""}`);
	if (summary.stats !== undefined) out(`omp's own count (PI_TUI_NATIVE_STATS): ${summary.stats.frames} frames logged, most rows in one frame ${summary.stats.maxRows}, in the last ${summary.stats.lastRows}`);
	out("\n(a) fallback `rows` nodes");
	count("rows nodes, any component", summary.rows.total);
	count("rows nodes from omp-cloud surfaces", summary.rows.cloud, "goal: 0");
	count("rows nodes from other components", summary.rows.other);
	for (const finding of summary.rows.findings) {
		const where = finding.path.map(step => `${step.kind}${step.role !== undefined ? `[${step.role}]` : ""}`).join(" > ");
		out(`    ${finding.cloud ? "CLOUD" : "other"}  ${finding.surface} frame ${finding.frame}  ${where}\n          ${JSON.stringify(finding.lines.join(" ⏎ ").slice(0, 150))}`);
	}

	const { surfaces } = summary.views;
	out("\n(b) job views, cloud against native (a view is a tile or a /jobs widget; each at its richest moment)");
	out(`  ${"surface".padEnd(20)} native  cloud   cloud views lack (required)`);
	for (const surface of surfaces) {
		const lack = !surface.required ? "(not required)" : surface.cloud.length === 0 ? "NO CLOUD VIEW DRAWN" : surface.missingRequired.length === 0 ? "nothing" : surface.missingRequired.join("; ");
		out(`  ${surface.where.padEnd(20)} ${String(surface.native.length).padStart(5)}  ${String(surface.cloud.length).padStart(5)}   ${lack}`);
	}
	const cell = (native: boolean, cloud: boolean, required: boolean): string => `${native ? "y" : "-"}/${cloud ? "y" : "-"}${required ? "*" : " "}`;
	out(`\n  ${"role (native/cloud, * required)".padEnd(36)}${surfaces.map(s => s.where.slice(0, 11).padEnd(12)).join("")}`);
	for (const role of [...TILE_ROLES, ...WIDGET_ROLES]) {
		const cells = surfaces.map(s => {
			const required = (REQUIRED_CLOUD_ROLES[s.where] ?? []).some(group => group.includes(role));
			return cell(s.nativeRoles.includes(role), s.cloudRoles.includes(role), required).padEnd(12);
		});
		if (surfaces.every(s => !s.nativeRoles.includes(role) && !s.cloudRoles.includes(role)) && !surfaces.some(s => (REQUIRED_CLOUD_ROLES[s.where] ?? []).some(group => group.includes(role)))) continue;
		out(`  ${role.padEnd(36)}${cells.join("")}`);
	}
	for (const surface of surfaces) {
		if (surface.cloud.length === 0) continue;
		if (surface.missingRoles.length > 0) out(`  ${surface.where}: roles native views have and cloud views lack: ${surface.missingRoles.join(", ")}`);
		if (surface.missingKinds.length > 0) out(`  ${surface.where}: node kinds native views have and cloud views lack: ${surface.missingKinds.join(", ")}`);
	}
	out(`\n  every required surface drawn natively for the cloud job: ${summary.views.cloudComplete ? "yes" : "NO"}`);
	if (summary.strip !== undefined) {
		out("\n(c) Subagents strip (ANSI pass): the cloud agent must be listed");
		for (const item of summary.strip) out(`  ${item.step.padEnd(16)} ${item.cloudListed ? "listed" : "MISSING"}   strip: ${item.entries.length === 0 ? "(none shown)" : item.entries.map(entry => entry.slice(0, 50)).join(" | ")}`);
	}
	if (summary.tail !== undefined) {
		out(`\n(d) the cloud job's /jobs Output midway through its turn: ${summary.tail.problems.length === 0 ? "a tail" : `NOT A TAIL (${summary.tail.problems.join("; ")})`}`);
		for (const line of summary.tail.lines) out(`    | ${line.slice(0, 110)}`);
	}
	if (summary.children !== undefined) {
		const c = summary.children;
		out(`\n(e) the cloud agent's children in /jobs: ${c.problems.length === 0 ? "nested like a native subagent's" : `NOT NESTED LIKE A NATIVE SUBAGENT'S (${c.problems.join("; ")})`}`);
		for (const [title, rows] of [["native subagent", c.native], ["cloud job (TSP list)", c.cloud], ["cloud job (ANSI list)", c.ansi]] as const) {
			out(`    ${title}:`);
			for (const row of rows.length === 0 ? ["(none)"] : rows) out(`      ${row}`);
		}
		for (const note of c.notes) out(`    note: ${note}`);
	}
	const seen = new Set<string>();
	for (const surface of surfaces) {
		for (const view of [...surface.native, ...surface.cloud]) {
			const line = `    ${surface.where.padEnd(20)} ${view.kind.padEnd(6)} ${view.cloud ? "cloud " : "native"} ${view.job.slice(0, 48).padEnd(48)} ${Object.keys(view.kinds).sort().join(",")}`;
			if (seen.has(line)) continue;
			seen.add(line);
			out(line);
		}
	}
	out(`\nfiles: ${outDir}`);
}
