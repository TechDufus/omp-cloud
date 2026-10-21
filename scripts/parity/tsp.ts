/**
 * Reads a TSP record (`PI_TUI_TSP_RECORD`, one JSON object per line: `{t, dir, verb, params, body}`), replays its frames
 * through omp's own reference applier and answers the parity questions:
 *
 * - {@link Replay.rows}: every `rows` node (omp's fallback for a component without `describe()`; Tern marks it `fallback`)
 *   with the surface, the frame, the ancestors it sits under and its text, classified as omp-cloud's or not;
 * - {@link Replay.views}: every job view omp draws, at its richest moment: a tile (`omp.job.tile`) or a widget
 *   (`omp.job.widget`), with the roles and node kinds under it, the job it shows (a cloud job's or a native one's) and
 *   where it sits (the wait card, the jobs pill's hovercard, the `/jobs` sheet, the cloud hub).
 */
import { TSP_KINDS, type TspFrame, type TspNode } from "@oh-my-pi/pi-wire";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { isRecord } from "../../src/guards";

export interface TspRecord {
	t: number;
	dir: "in" | "out";
	verb: string;
	body: unknown;
}

/** A node of a document or of a prop (a hovercard): wire nodes have an `id`, prop nodes do not. */
interface Node {
	id?: string;
	k: string;
	p?: object;
	c?: readonly Node[];
}

/** One step of the path from a surface's root to a node. */
export interface PathStep {
	id: string;
	kind: string;
	role: string | undefined;
}

export interface RowsFinding {
	/** `<surface>:<node id>`; a `rows` node inside a hovercard prop is `<owner id>#<prop>`. */
	key: string;
	surface: string;
	frame: number;
	path: PathStep[];
	/** The node's non-empty lines with their escapes removed. */
	lines: string[];
	/** Whether the node sits under an omp-cloud component (see {@link isCloudText}). */
	cloud: boolean;
}

export type ViewKind = "tile" | "widget";

/** Where a job view is drawn. */
export type Where = "wait card" | "jobs pill" | "jobs sheet" | "cloud hub or card" | "other";

export interface ViewFinding {
	key: string;
	kind: ViewKind;
	where: Where;
	surface: string;
	/** What names the job: a tile's id and title, a widget's title with the jobs sheet's id line. */
	job: string;
	/** Every `role` under the view with the number of nodes carrying it, at the view's richest moment. */
	roles: Record<string, number>;
	/** Every node kind under the view with its count. */
	kinds: Record<string, number>;
	/** Frame of that moment. */
	frame: number;
	cloud: boolean;
}

export interface ReplayOptions {
	/** Whether a job view is a cloud job's: `identity` is the text that names the job. Defaults to {@link isCloudText}. */
	isCloud?: (identity: string) => boolean;
}

const KINDS: ReadonlySet<string> = new Set(TSP_KINDS);
const VIEW_ROLES: Record<string, ViewKind> = { "omp.job.tile": "tile", "omp.job.widget": "widget" };
/** The roles omp's own tiles draw, in the order a complete tile has them. */
export const TILE_ROLES = [
	"omp.job.tile.head",
	"omp.job.tile.dot",
	"omp.job.tile.title",
	"omp.job.tile.id",
	"omp.job.tile.ring",
	"omp.job.tile.figure",
	"omp.job.tile.chart",
	"omp.job.tile.meter",
	"omp.job.tile.bars",
	"omp.job.tile.grid",
	"omp.job.tile.stats",
	"omp.job.tile.note",
	"omp.job.tile.stage",
	"omp.job.tile.lead",
] as const;
/** The roles of the widget the `/jobs` sheet draws above a job's output. */
export const WIDGET_ROLES = [
	"omp.job.widget.head",
	"omp.job.widget.title",
	"omp.job.widget.stage",
	"omp.job.widget.headline",
	"omp.job.widget.spark",
	"omp.job.widget.meter",
	"omp.job.widget.bars",
	"omp.job.widget.bar",
	"omp.job.widget.grid",
	"omp.job.widget.stat",
	"omp.job.widget.text",
] as const;

const TILE_REQUIRED = [["omp.job.tile.figure"], ["omp.job.tile.grid"], ["omp.job.tile.stats"], ["omp.job.tile.stage"]] as const;
const WIDGET_REQUIRED = [["omp.job.widget.meter", "omp.job.widget.bars"], ["omp.job.widget.grid"], ["omp.job.widget.stat"]] as const;
/**
 * What a cloud job's views must carry on the surfaces omp draws jobs on, as groups of which one role suffices. A tile draws
 * its first block as the picture (the step dots, `grid`), its headline as the figure, the stat line and the stage; the
 * `/jobs` widget draws every block (meter, bars, grid, stat).
 */
export const REQUIRED_CLOUD_ROLES: Partial<Record<Where, readonly (readonly string[])[]>> = {
	"wait card": TILE_REQUIRED,
	"jobs pill": TILE_REQUIRED,
	"jobs sheet": WIDGET_REQUIRED,
};
/** Roles that follow the kind of job, not how well it is drawn: a title that is the id shows no id, a tile with a picture has no lead. */
const JOB_TYPE_ROLES: ReadonlySet<string> = new Set(["omp.job.tile.id", "omp.job.tile.lead", "omp.job.tile.ring"]);

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/** Text that only an omp-cloud surface carries: its cloud glyph and its names. */
export function isCloudText(text: string): boolean {
	return /☁|omp-cloud|\bcloud\b|omp\.cloud/i.test(text);
}

export function parseRecord(text: string): TspRecord[] {
	const records: TspRecord[] = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isRecord(value) && typeof value.verb === "string" && (value.dir === "in" || value.dir === "out")) {
				records.push({ t: typeof value.t === "number" ? value.t : 0, dir: value.dir, verb: value.verb, body: value.body });
			}
		} catch {
			// a partly written last line
		}
	}
	return records;
}

function isNode(value: unknown): value is Node {
	return isRecord(value) && typeof value.k === "string" && KINDS.has(value.k);
}

function prop(node: Node, name: string): unknown {
	return isRecord(node.p) ? node.p[name] : undefined;
}

function roleOf(node: Node): string | undefined {
	const role = prop(node, "role");
	return typeof role === "string" ? role : undefined;
}

/** The nodes carried in a props object (a hovercard), by prop name. */
function propNodes(props: unknown): [string, Node][] {
	const found: [string, Node][] = [];
	if (!isRecord(props)) return found;
	for (const [name, value] of Object.entries(props)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (isNode(item)) found.push([name, item]);
		}
	}
	return found;
}

/** Visits `node`, its children and the nodes in its props; `owner` is the id of the nearest node with one, `viaProp` says the node sits in a prop. */
function walk(node: Node, owner: string, visit: (node: Node, owner: string, viaProp: boolean) => void, viaProp = false): void {
	const id = node.id ?? owner;
	visit(node, owner, viaProp);
	for (const child of node.c ?? []) walk(child, id, visit, viaProp);
	for (const [name, nested] of propNodes(node.p)) walk(nested, `${id}#${name}`, visit, true);
}

/** Plain text of a node: its `text` prop or its spans. */
function nodeText(node: Node): string {
	const value = prop(node, "text");
	if (typeof value === "string") return value;
	const spans = prop(node, "spans");
	if (!Array.isArray(spans)) return "";
	return spans.map(span => (isRecord(span) && typeof span.t === "string" ? span.t : "")).join("");
}

/** Every string in a node's subtree (text, spans, kv values, heads): what a screen search reads. */
export function flatten(node: Node): string {
	const parts: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string") parts.push(value);
		else if (Array.isArray(value)) for (const item of value) collect(item);
		else if (isRecord(value)) for (const item of Object.values(value)) collect(item);
	};
	collect(node.p);
	for (const child of node.c ?? []) parts.push(flatten(child));
	return parts.join(" ");
}

/** The nodes from the root to `id`, inclusive; undefined when it is not in the tree. */
function nodesTo(node: Node, id: string, trail: Node[] = []): Node[] | undefined {
	const here = [...trail, node];
	if (node.id === id) return here;
	for (const child of node.c ?? []) {
		const found = nodesTo(child, id, here);
		if (found !== undefined) return found;
	}
	return undefined;
}

function bump(into: Record<string, number>, key: string): void {
	into[key] = (into[key] ?? 0) + 1;
}

/** The first node under `node` (itself included) holding `role`. */
function findRole(node: Node, role: string): Node | undefined {
	if (roleOf(node) === role) return node;
	for (const child of node.c ?? []) {
		const found = findRole(child, role);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** Where the ancestors of a view place it. */
function whereOf(ancestors: readonly Node[]): Where {
	const roles = ancestors.map(roleOf).filter((role): role is string => role !== undefined);
	if (roles.some(role => role.startsWith("omp.hud"))) return "jobs pill";
	if (roles.some(role => role === "omp.tool.wait")) return "wait card";
	if (roles.some(role => role.startsWith("omp.overlay.jobs") || role.startsWith("omp.jobs."))) return "jobs sheet";
	if (roles.some(role => role.startsWith("omp.overlay.cloud") || role.startsWith("omp.cloud."))) return "cloud hub or card";
	return "other";
}

/** The texts that name the job a view shows: a tile's id and title, a widget's title. */
function nodeIdentity(view: Node): string {
	const names: string[] = [];
	walk(view, "", inner => {
		const role = roleOf(inner);
		if (role === "omp.job.tile.id" || role === "omp.job.tile.title" || role === "omp.job.widget.title") names.push(nodeText(inner).trim());
	});
	return [...new Set(names.filter(name => name !== ""))].join(" | ");
}

/** Frames of the surfaces applied in order, with what the parity questions found on the way. */
export class Replay {
	readonly documents = new Map<string, TspDocument>();
	readonly rows = new Map<string, RowsFinding>();
	readonly views = new Map<string, ViewFinding>();
	frames = 0;
	/** Ops the reference applier rejected: a record it cannot replay is itself a finding. */
	readonly rejected: string[] = [];
	readonly #isCloud: (identity: string) => boolean;

	constructor(options: ReplayOptions = {}) {
		this.#isCloud = options.isCloud ?? isCloudText;
	}

	/** Feeds one record: opens, closes and frames sent by omp; every other record does nothing. */
	apply(record: TspRecord): void {
		if (record.dir !== "out" || !isRecord(record.body)) return;
		const body = record.body;
		if (record.verb === "o" && typeof body.id === "string") {
			this.documents.set(body.id, new TspDocument(body.id));
		} else if (record.verb === "x" && typeof body.id === "string") {
			if (body.keep === false) this.documents.delete(body.id);
			else this.documents.get(body.id)?.close();
		} else if (record.verb === "f" && typeof body.sf === "string" && typeof body.s === "number" && Array.isArray(body.ops)) {
			this.#frame({ sf: body.sf, s: body.s, ops: body.ops });
		}
	}

	#frame(frame: TspFrame): void {
		const doc = this.documents.get(frame.sf);
		if (doc === undefined) return;
		this.frames++;
		const added: [string, Node][] = [];
		const touched = new Set<string>();
		for (const op of frame.ops) {
			if (op[0] === "add" && isNode(op[4])) {
				added.push([op[1], op[4]]);
				touched.add(op[1]);
			} else if (op[0] === "set") {
				for (const [name, node] of propNodes(op[2])) added.push([`${op[1]}#${name}`, node]);
				touched.add(op[1]);
			} else if (op[0] === "text" || op[0] === "splice" || op[0] === "move" || op[0] === "del") touched.add(op[1]);
		}
		for (const error of doc.applyFrame(frame)) this.rejected.push(`${frame.sf} frame ${frame.s} op ${error.op}: ${error.msg}`);
		let root: Node | undefined;
		const current = (): Node => {
			root ??= doc.snapshot();
			return root;
		};
		for (const [at, node] of added) {
			walk(node, at, (found, owner, viaProp) => {
				if (found.k === "rows") this.#noteRows(frame, found, viaProp ? owner : (found.id ?? owner), current());
			});
		}
		this.#noteViews(frame, touched, added, current);
	}

	#noteRows(frame: TspFrame, node: Node, id: string, root: Node): void {
		const key = `${frame.sf}:${id}`;
		if (this.rows.has(key)) return;
		const path = (nodesTo(root, id.split("#")[0] ?? id) ?? []).map((step): PathStep => ({ id: step.id ?? "", kind: step.k, role: roleOf(step) }));
		const raw = prop(node, "lines");
		const lines = (Array.isArray(raw) ? raw : []).map(line => stripAnsi(typeof line === "string" ? line : JSON.stringify(line))).filter(line => line.trim() !== "");
		const cloud = isCloudText(lines.join("\n")) || path.some(step => isCloudText(`${step.id} ${step.role ?? ""}`));
		this.rows.set(key, { key, surface: frame.sf, frame: frame.s, path: path.slice(-6), lines: lines.slice(0, 8), cloud });
	}

	/** Records the job views this frame added, and the ones it changed, at their richest moment. */
	#noteViews(frame: TspFrame, touched: ReadonlySet<string>, added: [string, Node][], current: () => Node): void {
		const found: { key: string; node: Node; kind: ViewKind; where: Where; context: string }[] = [];
		/** `at` is the id of the node (or of the prop's owner) the view hangs from. */
		const consider = (node: Node, key: string, at: string): void => {
			const kind = VIEW_ROLES[roleOf(node) ?? ""];
			if (kind === undefined) return;
			const ancestors = nodesTo(current(), at.split("#")[0] ?? at) ?? [];
			// A widget inside a jobs sheet is named by the sheet's id line (`task · <id>`) of its detail pane.
			const detail = ancestors.findLast(step => roleOf(step) === "omp.jobs.detail");
			const line = detail === undefined ? undefined : findRole(detail, "omp.jobs.id");
			found.push({ key, node, kind, where: whereOf(ancestors), context: line === undefined ? "" : nodeText(line) });
		};
		for (const [at, node] of added) {
			walk(node, at, (inner, owner, viaProp) => {
				if (VIEW_ROLES[roleOf(inner) ?? ""] === undefined) return;
				if (viaProp || inner.id === undefined) consider(inner, `${frame.sf}:${owner}/${nodeIdentity(inner)}`, owner);
				else consider(inner, `${frame.sf}:${inner.id}`, inner.id);
			});
		}
		if (touched.size > 0 && this.views.size > 0) {
			const stack: Node[] = [current()];
			for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
				if (VIEW_ROLES[roleOf(node) ?? ""] === undefined || node.id === undefined) {
					stack.push(...(node.c ?? []));
					continue;
				}
				let hit = false;
				walk(node, "", inner => {
					if (inner.id !== undefined && touched.has(inner.id)) hit = true;
				});
				if (hit) consider(node, `${frame.sf}:${node.id}`, node.id);
			}
		}
		for (const { key, node, kind, where, context } of found) {
			const roles: Record<string, number> = {};
			const kinds: Record<string, number> = {};
			walk(node, "", inner => {
				const role = roleOf(inner);
				if (role !== undefined) bump(roles, role);
				bump(kinds, inner.k);
			});
			const before = this.views.get(key);
			if (before !== undefined && Object.keys(before.roles).length > Object.keys(roles).length) continue;
			const job = `${nodeIdentity(node)} ${context}`.trim();
			this.views.set(key, { key, kind, where, surface: frame.sf, job, roles, kinds, frame: frame.s, cloud: this.#isCloud(job) });
		}
	}

	/** Every string on the surfaces: what a screen search reads. */
	text(): string {
		return [...this.documents.values()].map(doc => flatten(doc.snapshot())).join("\n");
	}

	/** The surface documents as nodes, for a review file. */
	snapshots(): Record<string, TspNode> {
		return Object.fromEntries([...this.documents].map(([id, doc]) => [id, doc.snapshot()]));
	}
}

/** Replays a whole record. */
export function replay(records: TspRecord[], options: ReplayOptions = {}): Replay {
	const result = new Replay(options);
	for (const record of records) result.apply(record);
	return result;
}

/** Native views against cloud views on one surface: the roles and node kinds the native ones have and the cloud ones lack. */
export interface SurfaceComparison {
	where: Where;
	native: ViewFinding[];
	cloud: ViewFinding[];
	/** Every `omp.job.*` role of any native / cloud view here. */
	nativeRoles: string[];
	cloudRoles: string[];
	/** Roles native views carry and cloud views do not (job-type roles apart). */
	missingRoles: string[];
	nativeKinds: string[];
	cloudKinds: string[];
	missingKinds: string[];
	/** The {@link REQUIRED_CLOUD_ROLES} groups no cloud view here satisfies (every group when there is no cloud view). */
	missingRequired: string[];
	/** Whether {@link REQUIRED_CLOUD_ROLES} asks anything of this surface. */
	required: boolean;
}

export interface ViewComparison {
	surfaces: SurfaceComparison[];
	/** Whether every required surface has a cloud view carrying every required role. */
	cloudComplete: boolean;
}

const SURFACE_ORDER: readonly Where[] = ["wait card", "jobs pill", "jobs sheet", "cloud hub or card", "other"];

export function compareViews(views: Iterable<ViewFinding>): ViewComparison {
	const all = [...views];
	const roles = (list: ViewFinding[]): string[] => [...new Set(list.flatMap(view => Object.keys(view.roles).filter(role => role.startsWith("omp.job."))))].sort();
	const kinds = (list: ViewFinding[]): string[] => [...new Set(list.flatMap(view => Object.keys(view.kinds)))].sort();
	const surfaces: SurfaceComparison[] = [];
	for (const where of SURFACE_ORDER) {
		const required = REQUIRED_CLOUD_ROLES[where];
		const here = all.filter(view => view.where === where);
		// A required surface is reported even when nothing was drawn there: that is the finding.
		if (here.length === 0 && required === undefined) continue;
		const native = here.filter(view => !view.cloud);
		const cloud = here.filter(view => view.cloud);
		const nativeRoles = roles(native);
		const cloudRoles = roles(cloud);
		const nativeKinds = kinds(native);
		const cloudKinds = kinds(cloud);
		surfaces.push({
			where,
			native,
			cloud,
			nativeRoles,
			cloudRoles,
			missingRoles: nativeRoles.filter(role => !cloudRoles.includes(role) && !JOB_TYPE_ROLES.has(role)),
			nativeKinds,
			cloudKinds,
			missingKinds: nativeKinds.filter(k => !cloudKinds.includes(k)),
			missingRequired: (required ?? []).filter(group => !group.some(role => cloudRoles.includes(role))).map(group => group.join(" | ")),
			required: required !== undefined,
		});
	}
	return { surfaces, cloudComplete: surfaces.filter(s => s.required).every(s => s.cloud.length > 0 && s.missingRequired.length === 0) };
}
