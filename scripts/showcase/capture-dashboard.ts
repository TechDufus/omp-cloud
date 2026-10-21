/**
 * Captures the dashboard pages of the README (`bun scripts/showcase/capture-dashboard.ts`): 1440x900 at device scale 2,
 * on the showcase data, into `docs/assets/src/dashboard-<page>-<theme>.png` (run `optimize.ts` after).
 *
 * Starts its own harness (`scripts/dashboard-dev.ts --showcase --update=idle`: a temp directory, a fake vmon and
 * gateway, the service on loopback ports; nothing of the real service) and drives the system Chromium through
 * puppeteer-core (omp's own dependency). Set `CHROMIUM` to another executable.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { mintLink, REPO_ROOT, startHarness, threads } from "./harness";
import { SHOWCASE_FINISHING_NAME } from "./profile";

const OUT = join(REPO_ROOT, "docs/assets/src");
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const SETTLE_MS = 2500;

type Theme = "dark" | "light";

interface Shot {
	name: string;
	hash: string | ((threadId: string) => string);
	themes: Theme[];
	/** Runs after navigation, before the shot. */
	prepare?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
	{ name: "overview", hash: "#/", themes: ["dark", "light"] },
	{ name: "threads", hash: "#/threads", themes: ["dark", "light"] },
	{ name: "thread", hash: id => `#/threads/${id}`, themes: ["dark", "light"] },
	{ name: "spend", hash: "#/spend", themes: ["dark", "light"] },
	{ name: "vms", hash: "#/vms", themes: ["dark", "light"] },
	{ name: "devices", hash: "#/devices", themes: ["dark", "light"] },
	{ name: "logins", hash: "#/logins", themes: ["dark", "light"] },
	{ name: "settings", hash: "#/settings", themes: ["dark", "light"] },
];

async function setTheme(page: Page, theme: Theme): Promise<void> {
	await page.evaluate(`localStorage.setItem("omp-cloud-theme", ${JSON.stringify(theme)})`);
	await page.reload({ waitUntil: "domcontentloaded" });
}

async function main(): Promise<void> {
	mkdirSync(OUT, { recursive: true });
	const harness = await startHarness({ update: "idle" });
	const browser = await puppeteer.launch({
		executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
		headless: true,
		args: ["--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"],
	});
	try {
		const rows = await threads(harness);
		const finishing = rows.find(t => t.name === SHOWCASE_FINISHING_NAME);
		if (finishing === undefined) throw new Error(`no thread named ${SHOWCASE_FINISHING_NAME}`);

		const page = await browser.newPage();
		await page.setViewport(VIEWPORT);
		await page.goto(await mintLink(harness.api, harness.token, harness.dashboardOrigin), { waitUntil: "domcontentloaded" });
		await Bun.sleep(SETTLE_MS);

		for (const shot of SHOTS) {
			for (const theme of shot.themes) {
				const hash = typeof shot.hash === "string" ? shot.hash : shot.hash(finishing.id);
				await setTheme(page, theme);
				await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
				await Bun.sleep(SETTLE_MS);
				await shot.prepare?.(page);
				// No caret, no hover, no focus ring from a previous click.
				await page.mouse.move(0, 0);
				const file = join(OUT, `dashboard-${shot.name}-${theme}.png`);
				await page.screenshot({ path: file, type: "png" });
				console.log(`wrote ${file}`);
			}
		}

		// The Settings page with an update waiting: the one place the scripted update shows.
		const ready = await fetch(new URL("/__dev/update?state=ready", harness.dashboardOrigin), { method: "POST" });
		if (!ready.ok) throw new Error(`scripting the update failed: ${ready.status}`);
		await setTheme(page, "dark");
		await page.evaluate(`location.hash = "#/settings"`);
		await Bun.sleep(SETTLE_MS * 2);
		const file = join(OUT, "dashboard-settings-update-dark.png");
		await page.screenshot({ path: file, type: "png" });
		console.log(`wrote ${file}`);
	} finally {
		await browser.close();
		await harness.stop();
	}
}

await main();
