#!/usr/bin/env bun
/**
 * Renders the composed graphics (README banners, hero, social preview, favicons) from the HTML templates in this
 * directory to PNG at exact pixel sizes, with headless Chromium, then shrinks each PNG into its byte budget.
 *
 *   bun scripts/showcase/compose/render.ts                      render everything
 *   bun scripts/showcase/compose/render.ts banner-dark hero      render some
 *   bun scripts/showcase/compose/render.ts --src /dir            screenshot sources from /dir (default docs/assets)
 *
 * Needs `chromium` (or CHROMIUM=/path) and ImageMagick's `magick`. The templates reference the screenshots by name
 * (the optimized docs/assets/{dashboard,tui,tern}-*.png, pixel-identical to the raw captures) and the brand SVGs in
 * docs/assets/brand/; the SVGs come from make-brand.py. A fresh clone has all of them; to use new captures run
 * capture-dashboard.ts and capture-tui.ts, then optimize.ts, first.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMPOSE = import.meta.dir;
const ROOT = resolve(COMPOSE, "..", "..", "..");
const ASSETS = join(ROOT, "docs", "assets");

interface Asset {
	name: string;
	template: string;
	theme: "dark" | "light";
	/** CSS size; the PNG is this times `scale`. */
	width: number;
	height: number;
	scale: number;
	out: string;
	/** Byte budget; the PNG is quantized only as far as needed to fit. */
	budget: number;
	transparent?: boolean;
	vars?: Record<string, string>;
}

const KB = 1024;
const assets: Asset[] = [
	{ name: "banner-dark", template: "banner.html", theme: "dark", width: 1200, height: 300, scale: 2, out: "banner-dark.png", budget: 400 * KB },
	{ name: "banner-light", template: "banner.html", theme: "light", width: 1200, height: 300, scale: 2, out: "banner-light.png", budget: 400 * KB },
	{ name: "hero", template: "hero.html", theme: "dark", width: 1440, height: 900, scale: 2, out: "hero.png", budget: 500 * KB },
	{ name: "social-preview", template: "social.html", theme: "dark", width: 1280, height: 640, scale: 1, out: "brand/social-preview.png", budget: 1024 * KB },
	{ name: "logo-mark", template: "mark.html", theme: "dark", width: 512, height: 512, scale: 1, out: "brand/logo-mark.png", budget: 60 * KB, transparent: true },
	{ name: "favicon-64", template: "mark.html", theme: "dark", width: 64, height: 64, scale: 1, out: "brand/favicon-64.png", budget: 8 * KB, transparent: true },
	{ name: "favicon-32", template: "mark.html", theme: "dark", width: 32, height: 32, scale: 1, out: "brand/favicon-32.png", budget: 4 * KB, transparent: true },
];

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

const srcDir = resolve(arg("--src") ?? ASSETS);
const wanted = process.argv.slice(2).filter((a, i, rest) => !a.startsWith("--") && rest[i - 1] !== "--src");
const selected = wanted.length === 0 ? assets : assets.filter(a => wanted.includes(a.name));
if (selected.length === 0) throw new Error(`no asset matches ${wanted.join(", ")}; known: ${assets.map(a => a.name).join(", ")}`);

const chromium = process.env.CHROMIUM ?? "chromium";
const work = mkdtempSync(join(tmpdir(), "omp-cloud-compose-"));

function sh(cmd: string[]): void {
	const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed (${r.exitCode}): ${r.stderr.toString().slice(-600)}`);
}

function renderHtml(a: Asset): string {
	const tokens: Record<string, string> = {
		THEME: a.theme,
		COMPOSE: pathToFileURL(COMPOSE).href,
		SRC: pathToFileURL(srcDir).href,
		BRAND: pathToFileURL(join(ASSETS, "brand")).href,
		SIZE: String(a.width),
	};
	let html = readFileSync(join(COMPOSE, a.template), "utf8");
	for (const [key, value] of Object.entries(tokens)) html = html.replaceAll(`{{${key}}}`, value);
	const page = join(work, `${a.name}.html`);
	writeFileSync(page, html);
	return page;
}

/** Strips and recompresses; if the PNG is still over budget, reduces it to a palette, trying the smoothest option that fits (error-diffusion dither first, then none, with fewer colors). */
function shrink(file: string, budget: number): string {
	const tmp = `${file}.opt.png`;
	const settings = ["-alpha", "off", "-strip", "-define", "png:compression-level=9"];
	sh(["magick", file, ...settings, `PNG24:${tmp}`]);
	let note = "lossless";
	const attempts: [string, number][] = [["Riemersma", 256], ["None", 256], ["None", 192], ["None", 128], ["None", 96], ["None", 64]];
	for (const [dither, colors] of attempts) {
		if (statSync(tmp).size <= budget) break;
		sh(["magick", file, ...settings, "-dither", dither, "-colors", String(colors), `PNG8:${tmp}`]);
		note = `${colors} colors, ${dither === "None" ? "no dither" : dither}`;
	}
	sh(["mv", tmp, file]);
	return note;
}

try {
	for (const a of selected) {
		const out = join(ASSETS, a.out);
		mkdirSync(dirname(out), { recursive: true });
		const page = renderHtml(a);
		sh([
			chromium,
			"--headless",
			"--no-sandbox",
			"--disable-gpu",
			"--hide-scrollbars",
			"--allow-file-access-from-files",
			`--user-data-dir=${join(work, "profile")}`,
			`--force-device-scale-factor=${a.scale}`,
			`--window-size=${a.width},${a.height}`,
			...(a.transparent ? ["--default-background-color=00000000"] : []),
			"--virtual-time-budget=4000",
			`--screenshot=${out}`,
			pathToFileURL(page).href,
		]);
		const note = a.transparent ? "" : shrink(out, a.budget);
		const px = Bun.spawnSync(["magick", "identify", "-format", "%wx%h", out]).stdout.toString();
		const size = statSync(out).size;
		const flag = size > a.budget ? "  OVER BUDGET" : "";
		console.log(`${a.out.padEnd(28)} ${px.padEnd(10)} ${(size / KB).toFixed(0).padStart(5)} KB  (budget ${(a.budget / KB).toFixed(0)}) ${note}${flag}`);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
