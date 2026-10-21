/**
 * `bun scripts/parity/render.ts [dir]`: turns the ANSI pass's captures (`<dir>/ansi/*.ansi`, default `/tmp/parity`) into PNGs
 * under `<dir>/png/` for side-by-side review: ANSI to HTML (a monospace page in a dark palette), then headless Chromium's
 * screenshot, one PNG per capture (`ansi-<step>.png`). The native pass's documents (`<dir>/native/<step>.json`) are drawn with a
 * schematic TSP renderer (not Tern: a stand-in that draws the node kinds job views and cards use, roles captioned) as
 * `tsp-*.png`, cloud beside native for the wait card, the jobs pill's hovercard, the `/jobs` sheet, the cards and the hub.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sheetRows } from "./children";
import { stripAnsi } from "./tsp";

const FG = "#cdd6f4";
const BG = "#1e1e2e";
const PALETTE = ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"];
const CHAR_W = 8.43;
const LINE_H = 18;
const PAD = 16;

function color256(n: number): string {
	if (n < 16) return PALETTE[n] ?? FG;
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `rgb(${v},${v},${v})`;
	}
	const i = n - 16;
	const level = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
	return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

interface Style {
	fg?: string;
	bg?: string;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	reverse: boolean;
}

function css(style: Style): string {
	let fg = style.fg;
	let bg = style.bg;
	if (style.reverse) [fg, bg] = [bg ?? BG, fg ?? FG];
	const parts: string[] = [];
	if (fg !== undefined) parts.push(`color:${fg}`);
	if (bg !== undefined) parts.push(`background:${bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** One line of SGR-coloured text as spans. */
export function ansiToHtml(input: string): string {
	let style: Style = { bold: false, dim: false, italic: false, underline: false, reverse: false };
	let out = "";
	let last = 0;
	const emit = (text: string): void => {
		if (text === "") return;
		const rule = css(style);
		out += rule === "" ? escapeHtml(text) : `<span style="${rule}">${escapeHtml(text)}</span>`;
	};
	for (const match of input.matchAll(/\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g)) {
		emit(input.slice(last, match.index));
		last = (match.index ?? 0) + match[0].length;
		if (match[1] === undefined) continue;
		const codes = match[1] === "" ? [0] : match[1].split(/[;:]/).map(Number);
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i] ?? 0;
			if (code === 0) style = { bold: false, dim: false, italic: false, underline: false, reverse: false };
			else if (code === 1) style = { ...style, bold: true };
			else if (code === 2) style = { ...style, dim: true };
			else if (code === 3) style = { ...style, italic: true };
			else if (code === 4) style = { ...style, underline: true };
			else if (code === 7) style = { ...style, reverse: true };
			else if (code === 22) style = { ...style, bold: false, dim: false };
			else if (code === 23) style = { ...style, italic: false };
			else if (code === 24) style = { ...style, underline: false };
			else if (code === 27) style = { ...style, reverse: false };
			else if (code >= 30 && code <= 37) style = { ...style, fg: PALETTE[code - 30] };
			else if (code >= 90 && code <= 97) style = { ...style, fg: PALETTE[code - 90 + 8] };
			else if (code >= 40 && code <= 47) style = { ...style, bg: PALETTE[code - 40] };
			else if (code >= 100 && code <= 107) style = { ...style, bg: PALETTE[code - 100 + 8] };
			else if (code === 39) style = { ...style, fg: undefined };
			else if (code === 49) style = { ...style, bg: undefined };
			else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
				const value = color256(codes[i + 2] ?? 0);
				style = code === 38 ? { ...style, fg: value } : { ...style, bg: value };
				i += 2;
			} else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
				const value = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
				style = code === 38 ? { ...style, fg: value } : { ...style, bg: value };
				i += 4;
			}
		}
	}
	emit(input.slice(last));
	return out;
}

/** The capture's lines without the blank tail tmux pads with. */
function trimmed(ansi: string): string[] {
	const lines = ansi.split("\n");
	while (lines.length > 0 && stripAnsi(lines.at(-1) ?? "").trim() === "") lines.pop();
	return lines;
}

function panel(title: string, lines: string[]): string {
	return `<div class="panel"><div class="title">${escapeHtml(title)}</div><pre>${lines.map(ansiToHtml).join("\n")}</pre></div>`;
}

const PAGE = (body: string): string =>
	`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${BG}}body{display:flex;gap:12px;padding:${PAD}px;align-items:flex-start}pre{margin:0;font:14px/${LINE_H}px "DejaVu Sans Mono","Noto Sans Mono",monospace;color:${FG};background:${BG};white-space:pre}.title{font:bold 13px sans-serif;color:#f9e2af;margin-bottom:6px}.panel{border-left:2px solid #45475a;padding-left:10px}</style>${body}`;

/** Headless Chromium's screenshot of an HTML page at a fixed window size. */
async function shoot(html: string, file: string, width: number, height: number): Promise<void> {
	const page = `${file}.html`;
	await writeFile(page, html);
	const proc = Bun.spawn(["chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${Math.ceil(width)},${Math.ceil(height)}`, `--screenshot=${file}`, `file://${page}`], { stdout: "ignore", stderr: "pipe" });
	const [stderr, code] = await Promise.all([proc.stderr.text(), proc.exited]);
	await rm(page, { force: true });
	if (code !== 0) throw new Error(`chromium exited ${code}: ${stderr.slice(-300)}`);
}

async function screenshot(html: string, file: string, columns: number, rows: number, extraTitleRows = 0): Promise<void> {
	await shoot(html, file, columns * CHAR_W + PAD * 2 + 24, (rows + extraTitleRows) * LINE_H + PAD * 2 + 30);
}

// ─── A schematic render of TSP documents ────────────────────────────────────────────────────────────────────────────
// Not Tern: a review aid that draws the node kinds the job views and cards use (text, row/col, card, kv, meter, badge, elapsed,
// chart, code, md) from a recorded document, so cloud and native show side by side with the same stand-in. Every node's role is
// printed as a faint caption under `--roles` styling (hover-free), so a difference in roles is visible too.

type Wire = { id?: string; k: string; p?: Record<string, unknown>; c?: Wire[] };
const TONES: Record<string, string> = { success: "#a6e3a1", error: "#f38ba8", warning: "#f9e2af", accent: "#89b4fa", info: "#89dceb", pending: "#fab387", muted: "#7f849c", neutral: "#a6adc8", user: "#cba6f7" };
const GAPS: Record<string, number> = { none: 0, xs: 3, sm: 7, md: 12, lg: 18 };

function isWire(value: unknown): value is Wire {
	return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { k?: unknown }).k === "string";
}

function spansHtml(value: unknown): string {
	if (typeof value === "string") return escapeHtml(value);
	if (!Array.isArray(value)) return "";
	return value
		.map(span => {
			if (typeof span !== "object" || span === null) return "";
			const { t, s } = span as { t?: unknown; s?: unknown };
			const tokens = typeof s === "string" ? s.split(/\s+/) : [];
			const style: string[] = [];
			for (const token of tokens) {
				if (TONES[token] !== undefined) style.push(`color:${TONES[token]}`);
				if (token === "dim") style.push("opacity:.55");
				if (token === "muted") style.push("color:#7f849c");
				if (token === "strong") style.push("font-weight:bold");
				if (token === "mono") style.push("font-family:monospace");
			}
			return `<span style="${style.join(";")}">${escapeHtml(typeof t === "string" ? t : "")}</span>`;
		})
		.join("");
}

function textOf(node: Wire): string {
	const p = node.p ?? {};
	return typeof p.text === "string" ? escapeHtml(p.text) : spansHtml(p.spans ?? p.head);
}

function formatAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function tsp(node: Wire, showRoles: boolean): string {
	const p = node.p ?? {};
	const role = typeof p.role === "string" ? p.role : undefined;
	const tone = typeof p.tone === "string" ? TONES[p.tone] : undefined;
	const gap = GAPS[typeof p.gap === "string" ? p.gap : "none"] ?? 0;
	const kids = (node.c ?? []).map(child => tsp(child, showRoles)).join("");
	const caption = showRoles && role !== undefined ? `<div class="role">${escapeHtml(role)}</div>` : "";
	const grow = typeof p.grow === "number" ? `;flex:${p.grow}` : "";
	let body: string;
	switch (node.k) {
		case "col":
			body = `<div style="display:flex;flex-direction:column;gap:${gap}px${grow}">${kids}</div>`;
			break;
		case "row":
			body = `<div style="display:flex;flex-direction:row;gap:${gap}px;align-items:${p.align === "baseline" ? "baseline" : "center"};${p.wrap === true ? "flex-wrap:wrap;" : ""}${grow.slice(1)}">${kids}</div>`;
			break;
		case "spacer":
			body = `<div style="flex:1;min-height:${GAPS[typeof p.size === "string" ? p.size : "xs"] ?? 3}px"></div>`;
			break;
		case "text":
		case "md":
			body = `<div class="t" style="${typeof p.wrap === "string" && p.wrap === "none" ? "white-space:nowrap;overflow:hidden;text-overflow:ellipsis" : "white-space:pre-wrap"}${grow};${tone !== undefined && p.role === undefined ? `color:${tone}` : ""}">${textOf(node)}</div>`;
			break;
		case "code":
		case "ansi":
			body = `<pre class="code">${escapeHtml(typeof p.text === "string" ? stripAnsi(p.text) : "")}</pre>`;
			break;
		case "kv": {
			const items = Array.isArray(p.items) ? p.items : [];
			body = `<div class="kv">${items.map(item => `<span class="k">${spansHtml((item as { k?: unknown }).k)}</span><span>${spansHtml((item as { v?: unknown }).v)}</span>`).join("")}</div>`;
			break;
		}
		case "meter": {
			const value = typeof p.value === "number" ? Math.max(0, Math.min(1, p.value)) : 0;
			const color = TONES[typeof p.tone === "string" ? p.tone : "accent"] ?? TONES.accent;
			const label = typeof p.label === "string" ? escapeHtml(p.label) : "";
			body =
				p.style === "ring"
					? `<span class="ring" style="border-color:${color}">${label}</span>`
					: `<div class="meter" style="flex:1;min-width:60px"><div style="width:${Math.round(value * 100)}%;background:${color}"></div></div>${label !== "" ? `<span class="t" style="opacity:.7">${label}</span>` : ""}`;
			break;
		}
		case "badge":
			body = `<span class="badge" style="background:${TONES[typeof p.tone === "string" ? p.tone : "neutral"] ?? TONES.neutral}">${escapeHtml(typeof p.text === "string" ? p.text : "")}</span>`;
			break;
		case "elapsed":
			body = `<span class="t" style="opacity:.7">⏱ ${typeof p.age === "number" ? formatAge(p.age) : ""}</span>`;
			break;
		case "kbd":
			body = `<span class="kbd">${escapeHtml(Array.isArray(p.keys) ? p.keys.join("+") : "")}</span>`;
			break;
		case "icon":
			body = `<span class="t">◆ ${escapeHtml(typeof p.name === "string" ? p.name : "")}</span>`;
			break;
		case "spinner":
			body = `<span class="t">⠋</span>`;
			break;
		case "chart": {
			const series = Array.isArray(p.series) ? p.series : [];
			const values = series.map(item => (typeof item === "object" && item !== null && typeof (item as { value?: unknown }).value === "number" ? (item as { value: number }).value : 0));
			const max = Math.max(1, ...values);
			body = `<div class="chart">${values.map(v => `<i style="height:${Math.round((v / max) * 22) + 2}px"></i>`).join("")}</div>`;
			break;
		}
		case "card": {
			const status = typeof p.status === "string" ? `<span class="badge" style="background:${tone ?? TONES.neutral}">${escapeHtml(p.status)}</span>` : "";
			body = `<div class="card" style="border-left-color:${tone ?? "#45475a"}"><div class="head">${spansHtml(p.head)}${status}</div>${kids}</div>`;
			break;
		}
		case "tool":
		case "agent":
		case "overlay":
		case "section": {
			const heads = Object.entries(p)
				.filter(([key, value]) => ["name", "title", "head", "label", "task", "agent", "status", "summary", "text"].includes(key) && (typeof value === "string" || Array.isArray(value)))
				.map(([key, value]) => `<span class="t"><span style="opacity:.5">${key}</span> ${typeof value === "string" ? escapeHtml(value) : spansHtml(value)}</span>`)
				.join(" ");
			body = `<div class="card" style="border-left-color:${tone ?? "#585b70"}"><div class="head">${node.k}${heads !== "" ? ` · ${heads}` : ""}</div>${kids}</div>`;
			break;
		}
		case "item": {
			const itemTone = typeof p.tone === "string" ? TONES[p.tone] : undefined;
			const lead = typeof p.icon === "string" ? `<span class="badge" style="background:${itemTone ?? TONES.neutral};margin:0 6px 0 0">${escapeHtml(p.icon)}</span>` : "○ ";
			const value = p.value !== undefined ? ` <span style="opacity:.6;margin-left:14px">${spansHtml(p.value)}</span>` : "";
			body = `<div class="t">${lead}${p.label !== undefined ? spansHtml(p.label) : textOf(node)}${typeof p.description === "string" ? ` <span style="opacity:.55">— ${escapeHtml(p.description)}</span>` : ""}${value}</div>${kids}`;
			break;
		}
		case "list":
			body = `<div style="display:flex;flex-direction:column;gap:2px">${kids}</div>`;
			break;
		case "rule":
			body = `<hr>`;
			break;
		case "rows":
			body = `<pre class="code" style="border:1px dashed #f38ba8">${escapeHtml(stripAnsi(Array.isArray(p.lines) ? p.lines.join("\n") : ""))}\n(rows: fallback)</pre>`;
			break;
		default:
			body = `<div class="t" style="opacity:.6">[${node.k}] ${textOf(node)}</div>${kids}`;
	}
	const wrapStyle = tone !== undefined && ["col", "row"].includes(node.k) && role?.endsWith("tile") ? `border-left:3px solid ${tone};padding-left:6px;` : "";
	return `<div style="${wrapStyle}${node.k === "row" ? "" : ""}">${caption}${body}</div>`;
}

const TSP_STYLE = `body{align-items:flex-start;font:13px/1.35 "DejaVu Sans Mono",monospace;color:${FG}}.panel{width:560px}.t{font:13px/1.35 "DejaVu Sans Mono",monospace}.role{font:9px sans-serif;color:#6c7086;margin-top:2px}.card{border-left:3px solid #45475a;background:#262637;padding:6px 8px;display:flex;flex-direction:column;gap:4px}.head{font-weight:bold}.kv{display:grid;grid-template-columns:auto 1fr;gap:1px 12px}.k{color:#7f849c}.meter{height:7px;background:#313244;border-radius:4px;overflow:hidden}.meter div{height:100%}.badge{color:#1e1e2e;border-radius:9px;padding:0 6px;font-size:11px;margin-left:6px}.kbd{border:1px solid #585b70;border-radius:3px;padding:0 4px;font-size:11px}.ring{border:3px solid;border-radius:50%;font-size:9px;padding:2px}pre.code{margin:0;padding:4px 6px;background:#181825;font:12px/1.3 monospace;white-space:pre-wrap;max-height:240px;overflow:hidden}.chart{display:flex;align-items:flex-end;gap:2px;height:26px}.chart i{width:5px;background:#89b4fa}hr{border:0;border-top:1px solid #45475a;width:100%}`;

function findAll(node: Wire, test: (node: Wire) => boolean, into: Wire[] = []): Wire[] {
	if (test(node)) into.push(node);
	for (const child of node.c ?? []) findAll(child, test, into);
	return into;
}

/** The nodes a prop carries (a hovercard), as wire nodes. */
function propTrees(node: Wire): Wire[] {
	return Object.values(node.p ?? {}).filter(isWire);
}

async function tspPage(name: string, panels: [string, Wire[]][], height: number): Promise<void> {
	const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${BG}}body{display:flex;gap:16px;padding:${PAD}px}.title{font:bold 13px sans-serif;color:#f9e2af;margin-bottom:8px}.panel{border-left:2px solid #45475a;padding-left:10px}${TSP_STYLE}</style>${panels.map(([title, nodes]) => `<div class="panel"><div class="title">${escapeHtml(title)}</div>${nodes.map(n => tsp(n, true)).join("")}</div>`).join("")}`;
	await shoot(html, join(out, `${name}.png`), panels.length * 590 + PAD * 2, height);
	console.log(`wrote ${name}.png`);
}

async function loadDoc(step: string): Promise<Wire | undefined> {
	try {
		const docs = JSON.parse(await readFile(join(dir, "native", `${step}.json`), "utf8")) as Record<string, Wire>;
		return Object.values(docs)[0];
	} catch {
		return undefined;
	}
}

const dir = process.argv[2] ?? "/tmp/parity";
const out = join(dir, "png");
await mkdir(out, { recursive: true });
const names = (await readdir(join(dir, "ansi"))).filter(name => name.endsWith(".ansi")).sort();
const captures = new Map<string, string[]>();
for (const name of names) captures.set(name.replace(/\.ansi$/, ""), trimmed(await readFile(join(dir, "ansi", name), "utf8")));

// ANSI pass: omp's classic renderer, one PNG per capture.
for (const [name, lines] of captures) {
	const columns = Math.max(...lines.map(line => [...stripAnsi(line)].length), 20);
	await screenshot(PAGE(panel(`ansi · ${name}`, lines)), join(out, `ansi-${name}.png`), columns, lines.length, 1);
	console.log(`wrote ansi-${name}.png`);
}

// Native pass: the same surfaces as TSP documents, cloud beside native.
const wait = await loadDoc("03-wait-view");
if (wait !== undefined) {
	const tool = findAll(wait, n => n.p?.role === "omp.tool.wait").at(-1);
	if (tool !== undefined) {
		const tiles = findAll(tool, n => n.p?.role === "omp.job.tile");
		const cloud = tiles.filter(n => JSON.stringify(n).includes("PrintGreeting"));
		const native = tiles.filter(n => !cloud.includes(n));
		await tspPage("tsp-wait-card", [["native tiles (bash job, subagent)", native], ["cloud tile", cloud]], 420);
	}
	const segs = findAll(wait, n => n.p?.role === "omp.hud.seg");
	const tiles = segs.flatMap(seg => propTrees(seg)).flatMap(card => findAll(card, n => n.p?.role === "omp.job.tile"));
	if (tiles.length > 0) {
		const cloud = tiles.filter(n => JSON.stringify(n).includes("PrintGreeting"));
		await tspPage("tsp-jobs-pill-hovercard", [["native tiles in the pill's hovercard", tiles.filter(n => !cloud.includes(n))], ["cloud tile in the hovercard", cloud]], 420);
	}
}
const detailOf = (doc: Wire): Wire | undefined => findAll(doc, n => n.p?.role === "omp.jobs.detail")[0];
const sheets = await Promise.all([1, 2, 3].map(async i => ({ step: `02-jobs-${i}`, doc: await loadDoc(`02-jobs-${i}`) })));
const detail = (step: string): Wire | undefined => {
	const doc = sheets.find(s => s.step === step)?.doc;
	return doc === undefined ? undefined : detailOf(doc);
};
const subagent = detail("02-jobs-2");
const cloudJob = detail("02-jobs-3");
const bash = detail("02-jobs-1");
if (subagent !== undefined && cloudJob !== undefined) {
	await tspPage("tsp-jobs-sheet-native-subagent-vs-cloud", [["/jobs · native subagent (ParityAgent)", [subagent]], ["/jobs · cloud job", [cloudJob]]], 720);
}
if (bash !== undefined && cloudJob !== undefined) await tspPage("tsp-jobs-sheet-native-bash-vs-cloud", [["/jobs · native bash job (with a widget spec)", [bash]], ["/jobs · cloud job", [cloudJob]]], 720);

// The `/jobs` sheet midway through the cloud turn (one capture per sheet row): the cloud job's output tail beside the native bash job's.
const tailDetails: Wire[] = [];
for (let row = 1; row <= 12; row++) {
	const doc = await loadDoc(`02b-jobs-tail-${row}`);
	if (doc === undefined) break;
	const found = detailOf(doc);
	if (found !== undefined) tailDetails.push(found);
}
const idOf = (detail: Wire): string => JSON.stringify(findAll(detail, n => n.p?.role === "omp.jobs.id")[0]?.p ?? {});
const tailCloud = tailDetails.find(detail => idOf(detail).includes("PrintGreeting"));
const tailBash = tailDetails.find(detail => idOf(detail).includes("bg_1"));
if (tailCloud !== undefined) await tspPage("tsp-jobs-tail-cloud-vs-native", [["/jobs · native bash job, midway", tailBash === undefined ? [] : [tailBash]], ["/jobs · cloud job, midway through its turn", [tailCloud]]], 820);

// The cloud agent's own jobs nested under the cloud job in `/jobs`, beside the native subagent's nested bash child (the list as drawn,
// and the detail of each nested row).
const sheetDoc = await loadDoc("02b-jobs-tail-1");
if (sheetDoc !== undefined) {
	const rows = sheetRows(sheetDoc);
	const items = findAll(sheetDoc, n => n.k === "item" && typeof n.id === "string" && n.id.includes("/jobs/"));
	const subtree = (top: string): Wire[] => items.filter((_, i) => rows[i]?.top === top);
	const detailFor = (row: { id: string; type: string }): Wire | undefined => tailDetails.find(detail => idOf(detail).includes(`${row.type} · ${row.id}`));
	const cloudTop = rows.find(row => row.depth === 0 && row.id.startsWith("PrintGreeting"));
	const nativeTop = rows.find(row => row.depth === 0 && row.type === "task" && row.id !== cloudTop?.id && rows.some(other => other.top === row.id && other.depth > 0));
	const panelFor = (top: typeof cloudTop): Wire[] => {
		if (top === undefined) return [];
		const nested = rows.filter(row => row.top === top.id && row.depth > 0);
		const details = [...nested].reverse().map(detailFor).filter((d): d is Wire => d !== undefined);
		return [{ k: "list", c: subtree(top.id) }, ...details];
	};
	await tspPage("tsp-jobs-children-cloud-vs-native", [["/jobs · native subagent and its nested bash child", panelFor(nativeTop)], ["/jobs · cloud job and its children", panelFor(cloudTop)]], 1300);
}
const cardsOf = (doc: Wire): Wire[] => findAll(doc, n => n.p?.role === "omp.cloud.card");
const nativeTask = async (step: string): Promise<Wire[]> => {
	const doc = await loadDoc(step);
	return doc === undefined ? [] : findAll(doc, n => n.p?.role === "omp.tool.task").slice(0, 1);
};
const launch = await loadDoc("01-launch-card");
if (launch !== undefined) await tspPage("tsp-launch-card", [["native task tool card (the subagent start)", await nativeTask("01-launch-card")], ["cloud launch card", cardsOf(launch).slice(-1)]], 520);
const turn = await loadDoc("05-turn-card");
if (turn !== undefined) await tspPage("tsp-turn-card", [["native wait result tiles (finished jobs)", findAll(turn, n => n.p?.role === "omp.tool.wait").slice(-1)], ["cloud turn card", cardsOf(turn).slice(-1)]], 760);
const question = await loadDoc("06-question");
if (question !== undefined) {
	const dialog = await loadDoc("06b-ask-dialog");
	const ask = dialog === undefined ? [] : findAll(dialog, n => typeof n.p?.role === "string" && n.p.role.startsWith("omp.editor.ask")).slice(0, 1);
	await tspPage("tsp-question", [["omp's own ask dialog (`/cloud answer`)", ask], ["cloud question card", cardsOf(question).slice(-1)]], 560);
}
const answered = await loadDoc("07-turn-card-answered");
if (answered !== undefined) await tspPage("tsp-answered-cards", [["cloud question card, answered", cardsOf(answered).slice(-2, -1)], ["cloud turn 2 card", cardsOf(answered).slice(-1)]], 560);
const hub = await loadDoc("08-hub");
if (hub !== undefined) await tspPage("tsp-hub", [["/cloud hub overlay", findAll(hub, n => n.p?.role === "omp.overlay.cloud").slice(0, 1)]], 900);
