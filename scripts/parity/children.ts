/**
 * The `/jobs` sheet's job tree, read from the captures taken while the cloud agent's own background jobs run: the cloud job's
 * row must carry nested child rows (a `bash` job, a `task` subagent) drawn the way a native subagent's children are.
 *
 * Native pass (`native/02b-jobs-tail-1.json`): the sheet's `omp.jobs.master` list. A nested row is an `item` that follows its
 * parent with a tree glyph (`└─ `, `├─ `) leading its label, an icon for its type and its clock as the value.
 * ANSI pass (`ansi/02b-jobs-tail-1.txt`): `/jobs` is a text list; a nested row starts with the same glyphs and names its type
 * in brackets (`└─ bg_2 [bash] running (1m18s)`).
 */
import { stripAnsi } from "./tsp";

export interface SheetNode {
	id?: string;
	k: string;
	p?: Record<string, unknown>;
	c?: SheetNode[];
}

/** One row of the sheet's job list. */
export interface SheetRow {
	/** The job id (the part of the item's id after `/jobs/`). */
	id: string;
	/** 0 for a top-level job, 1 for a job nested under one, … */
	depth: number;
	/** The tree glyph leading the label (`└─ `), "" for a top-level row. */
	glyph: string;
	icon: string;
	tone: string;
	/** The label without its glyph. */
	label: string;
	/** `bash`, `task` or `eval` (from the item's title, `Running · bash · bg_2`). */
	type: string;
	/** Whether the row shows its clock. */
	clock: boolean;
	/** The id of the top-level row this one hangs under (its own id for a top-level row). */
	top: string;
}

function spans(value: unknown): { t: string; s: string }[] {
	if (!Array.isArray(value)) return [];
	return value.map(span => {
		const item = typeof span === "object" && span !== null ? (span as { t?: unknown; s?: unknown }) : {};
		return { t: typeof item.t === "string" ? item.t : "", s: typeof item.s === "string" ? item.s : "" };
	});
}

function findNode(node: SheetNode, test: (node: SheetNode) => boolean): SheetNode | undefined {
	if (test(node)) return node;
	for (const child of node.c ?? []) {
		const hit = findNode(child, test);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

/** The rows of the first jobs sheet in a document, in sheet order. */
export function sheetRows(doc: SheetNode): SheetRow[] {
	const master = findNode(doc, node => node.p?.role === "omp.jobs.master");
	const list = master === undefined ? undefined : findNode(master, node => node.k === "list");
	const rows: SheetRow[] = [];
	let top = "";
	for (const item of list?.c ?? []) {
		if (item.k !== "item") continue;
		const parts = spans(item.p?.label);
		const first = parts[0]?.t ?? "";
		const glyph = /^[│ ]*[├└]─ $/.test(first) ? first : "";
		const label = parts.slice(glyph === "" ? 0 : 1).map(part => part.t).join("");
		const title = typeof item.p?.title === "string" ? item.p.title : "";
		const type = /·\s*(bash|task|eval)\s*·/.exec(title.split("\n")[1] ?? "")?.[1] ?? "";
		const id = (item.id ?? "").split("/jobs/")[1] ?? "";
		const depth = glyph === "" ? 0 : Math.max(1, glyph.length / 3);
		if (depth === 0) top = id;
		rows.push({
			id,
			depth,
			glyph,
			icon: typeof item.p?.icon === "string" ? item.p.icon : "",
			tone: typeof item.p?.tone === "string" ? item.p.tone : "",
			label,
			type,
			clock: spans(item.p?.value).some(part => part.t !== ""),
			top,
		});
	}
	return rows;
}

export interface ChildrenFinding {
	/** The cloud job's subtree, one line per row: `<depth> <type> <id> <label>`; empty when the capture was not taken. */
	cloud: string[];
	/** The native subagent's subtree, for comparison. */
	native: string[];
	/** The ANSI sheet's cloud subtree. */
	ansi: string[];
	/** What is wrong: a missing nested row, a shape unlike the native one. Empty when the children nest like a native subagent's. */
	problems: string[];
	/** Things worth knowing that do not fail the run (a capture that was not taken). */
	notes: string[];
}

/** What names the children the scripted cloud turn starts (provider.ts). */
export interface ChildLabels {
	bash: string;
	task: string;
}

const describe = (row: SheetRow): string => `${"  ".repeat(row.depth)}${row.type || "?"} ${row.id} ${row.label.slice(0, 70)}`;

/** The shape a row is drawn with, apart from what it says. */
const shape = (row: SheetRow): string => `icon ${row.icon || "-"}, tone ${row.tone || "-"}, depth ${row.depth}, ${row.clock ? "clock" : "no clock"}`;

async function readJson(file: string): Promise<SheetNode | undefined> {
	const handle = Bun.file(file);
	if (!(await handle.exists())) return undefined;
	return Object.values(JSON.parse(await handle.text()) as Record<string, SheetNode>)[0];
}

/** The nested rows of the ANSI sheet under the row of the job `name`: `<type> <id> <label line>`. */
function ansiChildren(text: string, name: string): string[] | undefined {
	const lines = stripAnsi(text)
		.split("\n")
		.map(line => line.replace(/^[│\s]?\s?/, "").replace(/\s*│\s*$/, "").trimEnd());
	const at = lines.findIndex(line => line.startsWith(name) && /\[(task|bash|eval)\]/.test(line));
	if (at < 0) return undefined;
	const found: string[] = [];
	for (let i = at + 1; i < lines.length; i++) {
		const row = /^(\s*(?:│\s+)*[├└]─ )(\S+) \[(task|bash|eval)\]/.exec(lines[i] ?? "");
		if (row?.[2] === undefined) {
			// the label line of a nested bash row: indented, and under a `├─` row led by the tree's bar (`│    command`), then the next row
			if (found.length > 0 && /^[│\s]*\s{3,}\S/.test(lines[i] ?? "") && !/\[(task|bash|eval)\]/.test(lines[i] ?? "")) {
				found[found.length - 1] += ` ${(lines[i] ?? "").replace(/^[│\s]+/, "").slice(0, 70)}`;
				continue;
			}
			break;
		}
		found.push(`${row[3]} ${row[2]}`);
	}
	return found;
}

/**
 * Checks the two `/jobs` captures taken while the cloud agent's children run. `cloudIds` name the cloud job (its job id first),
 * `labels` the children the scripted turn starts.
 */
export async function checkJobsChildren(dir: string, cloudIds: readonly string[], labels: ChildLabels, passes: { native: boolean; ansi: boolean }): Promise<ChildrenFinding> {
	const out: ChildrenFinding = { cloud: [], native: [], ansi: [], problems: [], notes: [] };
	const names = cloudIds.filter(name => name !== "");
	if (passes.native) {
		const doc = await readJson(`${dir}/native/02b-jobs-tail-1.json`);
		if (doc === undefined) out.problems.push("no native/02b-jobs-tail-1.json capture");
		else {
			const rows = sheetRows(doc);
			const cloudTop = rows.find(row => row.depth === 0 && names.some(name => row.id === name || row.id.startsWith(`${name}-`)));
			if (cloudTop === undefined) out.problems.push("the /jobs list has no row for the cloud job");
			else {
				const children = rows.filter(row => row.top === cloudTop.id && row.depth > 0);
				out.cloud = [cloudTop, ...children].map(describe);
				const bash = children.find(row => row.type === "bash" && row.label.includes(labels.bash));
				const task = children.find(row => row.type === "task" && (row.id.includes(labels.task) || row.label.includes(labels.task)));
				if (bash === undefined) out.problems.push(`the cloud job has no nested bash row labelled with its command (${labels.bash})`);
				if (task === undefined) out.problems.push(`the cloud job has no nested task row for its subagent (${labels.task})`);
				// A native subagent's child is the reference: its icon, tone, glyph and clock are what a cloud child must show.
				const nativeTop = rows.find(row => row.depth === 0 && row.type === "task" && row.id !== cloudTop.id && rows.some(other => other.top === row.id && other.depth > 0));
				const nativeChild = nativeTop === undefined ? undefined : rows.find(row => row.top === nativeTop.id && row.depth > 0 && row.type === "bash");
				if (nativeTop !== undefined) out.native = [nativeTop, ...rows.filter(row => row.top === nativeTop.id && row.depth > 0)].map(describe);
				if (nativeChild === undefined) out.notes.push("no native subagent child in the capture to compare the shape with");
				else {
					for (const [what, row] of [["bash", bash], ["task", task]] as const) {
						if (row === undefined) continue;
						const reference = what === "bash" ? nativeChild : undefined;
						if (reference !== undefined && shape(row) !== shape(reference)) out.problems.push(`the cloud ${what} child is drawn as [${shape(row)}], a native subagent's bash child as [${shape(reference)}]`);
						if (what === "task" && (row.icon !== "agent" || row.glyph === "" || !row.clock)) out.problems.push(`the cloud task child is drawn as [${shape(row)}], not as an agent row (icon agent, glyph, clock)`);
					}
				}
			}
		}
	} else out.notes.push("native pass not run: the sheet's list was not checked");
	if (passes.ansi) {
		const file = Bun.file(`${dir}/ansi/02b-jobs-tail-1.txt`);
		if (!(await file.exists())) out.problems.push("no ansi/02b-jobs-tail-1.txt capture");
		else {
			const text = await file.text();
			let children: string[] | undefined;
			for (const name of names) children = children ?? ansiChildren(text, name);
			if (children === undefined) out.problems.push("the ANSI /jobs list has no row for the cloud job");
			else {
				out.ansi = children;
				if (!children.some(row => row.startsWith("bash ") && row.includes(labels.bash))) out.problems.push(`the ANSI /jobs list has no nested [bash] row under the cloud job with its command (${labels.bash})`);
				if (!children.some(row => row.startsWith("task ") && row.includes(labels.task))) out.problems.push(`the ANSI /jobs list has no nested [task] row for the cloud job's subagent (${labels.task})`);
			}
		}
	} else out.notes.push("ANSI pass not run: the text list was not checked");
	return out;
}
