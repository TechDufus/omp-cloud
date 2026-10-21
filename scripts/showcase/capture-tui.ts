/**
 * Captures the omp and Tern images of the README (`bun scripts/showcase/capture-tui.ts`), light and dark, into
 * `docs/assets/src/` (run `optimize.ts` after):
 *
 *   tui-cloud-tiles-<theme>.png     `/cloud list`: job tiles by repository, this repo first, and the jobs pill
 *   tui-question-card-<theme>.png   the launch of `/cloud <task>` and a question card, both native omp cards in the transcript
 *   tern-bell-tray-<theme>.png      Tern's bell badged, "Needs attention" open with a question and a finished turn
 *
 * Everything runs in isolation: the showcase harness (a temp service on loopback), a headless Tern (`tern serve` with
 * its own config directory, daemon socket and control socket), and an omp with a throwaway HOME, agent directory and
 * config home, the plugin linked from this checkout, a placeholder API key (no model call is made) and no display
 * variables, so nothing reaches the clipboard. Your own omp, Tern, `~/.config/omp-cloud` and live service are not touched.
 *
 * The tray shot needs two panes in the background: the question arrives after the first is answered somewhere else
 * (the dashboard's API), and a working turn ends, both while their omp panes are not the one on screen.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, startHarness, threads, type Harness } from "./harness";
import { SHOWCASE_FIRST_ANSWER, SHOWCASE_LOCAL_REPO, SHOWCASE_WAITING_NAME } from "./profile";

const ROOT = "/tmp/showcase";
const HOME = join(ROOT, "ada");
const REPO = join(HOME, "dev/orbit-api");
const AGENT = join(ROOT, "agent");
const OUT = join(REPO_ROOT, "docs/assets/src");
const SHOTS = join(ROOT, "shots");
const SOCKET = join(ROOT, "ctl.sock");
const OMP = process.env.OMP_BIN ?? join(process.env.HOME ?? "", ".local/share/tern/omp/bin/omp");
const NOISE = /MESA|pci id|dri2|DRI2|wgpu_hal|llvmpipe/;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const ternEnv: Record<string, string> = { ...(process.env as Record<string, string>), HOME, TERN_CONFIG_DIR: join(ROOT, "cfg"), TERN_DAEMON_SOCKET: join(ROOT, "daemon.sock") };
delete ternEnv.WAYLAND_DISPLAY;
delete ternEnv.DISPLAY;

async function ctl(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["tern", "ctl", "--control", SOCKET, ...args], { env: ternEnv, stdout: "pipe", stderr: "pipe", cwd: ROOT });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const text = (out + err)
		.split("\n")
		.filter(line => !NOISE.test(line))
		.join("\n")
		.trim();
	if (text.includes('"ok":false')) throw new Error(`tern ctl ${args.join(" ")}: ${text}`);
	return text;
}

const pause = (ms: number): Promise<void> => Bun.sleep(ms);
const quoted = (text: string): string => JSON.stringify(text);

/**
 * Types a `/cloud` command the way a person does: the command, a space and the rest, Enter to pick from the completion
 * list, Enter to run. `pick` false is one Enter for a command that needs no completion pick: `/cloud watch` of a thread
 * with a question opens omp's ask dialog, where a second Enter would take the recommended option.
 */
async function cloud(rest: string, pick = true): Promise<void> {
	await ctl("type", quoted("/cloud"));
	await pause(600);
	await ctl("type", quoted(` ${rest}`));
	await pause(600);
	await ctl("key", "enter");
	if (!pick) return;
	await pause(900);
	await ctl("key", "enter");
}

async function git(...args: string[]): Promise<void> {
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Ada Chen", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada Chen", GIT_COMMITTER_EMAIL: "ada@example.com" };
	const proc = Bun.spawn(["git", ...args], { cwd: REPO, env, stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

/** The folders omp and Tern run in, and the repository whose upstream makes it "this repo" in the list. */
async function stage(h: Harness): Promise<void> {
	rmSync(ROOT, { recursive: true, force: true });
	for (const dir of [join(REPO, "src"), AGENT, join(ROOT, "cfg"), SHOTS, join(ROOT, "xdg-tray/omp-cloud"), join(ROOT, "xdg-cards/omp-cloud")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(REPO, "README.md"), "# orbit-api\n");
	writeFileSync(join(REPO, "src/index.ts"), "export const version = 1;\n");
	await git("init", "-q", "-b", "main");
	await git("remote", "add", "origin", SHOWCASE_LOCAL_REPO.remoteURL);
	await git("add", "-A");
	await git("commit", "-q", "-m", "Initial commit");
	await git("config", "branch.main.remote", "origin");
	await git("config", "branch.main.merge", "refs/heads/main");

	// No first-run setup, no "what's new": omp reads both from the agent directory.
	const version = (await new Response(Bun.spawn([OMP, "--version"], { stdout: "pipe" }).stdout).text()).match(/\d+\.\d+\.\d+/)?.[0] ?? "";
	writeFileSync(join(AGENT, "config.yml"), "setupVersion: 2\n");
	writeFileSync(join(AGENT, "last-changelog-version"), version);
	// The plugin's own config: the harness's service, and whether cards or the terminal tray take what the cloud says.
	for (const [dir, extra] of [["xdg-tray", ""], ["xdg-cards", "deliver: transcript\n"]] as const) {
		const file = join(ROOT, dir, "omp-cloud/config.yml");
		writeFileSync(file, `url: ${h.api}\ntoken: ${h.token}\n${extra}`, { mode: 0o600 });
	}
}

function ompCommand(xdg: string): string {
	const unset = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "PI_CONFIG_DIR", "OMP_CLOUD_URL", "OMP_CLOUD_TOKEN", "WAYLAND_DISPLAY", "DISPLAY"].map(name => `-u ${name}`).join(" ");
	const plugin = join(REPO_ROOT, "plugin/src/index.ts");
	return `clear; env ${unset} HOME=${HOME} PI_CODING_AGENT_DIR=${AGENT} XDG_CONFIG_HOME=${join(ROOT, xdg)} ANTHROPIC_API_KEY=sk-ant-demo-not-a-key ${OMP} --no-extensions --model anthropic/claude-sonnet-4-6 -e ${plugin}`;
}

async function startOmp(xdg: string): Promise<void> {
	await ctl("run", quoted(`cd ${REPO}`));
	await ctl("run", quoted(ompCommand(xdg)));
	await pause(9000);
}

async function exitOmp(): Promise<void> {
	await ctl("type", quoted("/exit"));
	await pause(500);
	await ctl("key", "enter");
	await pause(700);
	await ctl("key", "enter");
	await pause(2500);
}

/** Shoots the window in both themes into `docs/assets/src/<name>-<theme>.png`. */
async function shoot(name: string): Promise<void> {
	for (const theme of THEMES) {
		await ctl("appearance", theme);
		await pause(2500);
		const reply = await ctl("shot", `${name}-${theme}`);
		const png = /"png":"([^"]+)"/.exec(reply)?.[1];
		if (png === undefined) throw new Error(`no shot path in ${reply}`);
		copyFileSync(png, join(OUT, `${name}-${theme}.png`));
		console.log(`wrote ${name}-${theme}.png`);
	}
}

async function startTern(): Promise<Bun.Subprocess> {
	const proc = Bun.spawn(["tern", "serve", "--control", SOCKET, "--out", SHOTS], { env: ternEnv, cwd: ROOT, stdout: "ignore", stderr: "ignore" });
	for (let i = 0; i < 60; i++) {
		if (existsSync(SOCKET)) {
			try {
				await ctl("state");
				return proc;
			} catch {
				// not listening yet
			}
		}
		await pause(1000);
	}
	throw new Error("tern serve did not come up");
}

async function api(h: Harness, path: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(`${h.api}${path}`, { ...init, headers: { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" } });
	if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
	return res;
}

async function control(h: Harness, action: "ask" | "finish"): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${h.controlPort}/${action}`, { method: "POST" });
	if (!res.ok) throw new Error(`${action}: ${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
	mkdirSync(OUT, { recursive: true });
	const h = await startHarness({ update: "idle" });
	let tern: Bun.Subprocess | undefined;
	try {
		await stage(h);
		tern = await startTern();
		await ctl("size", "950", "680");
		await ctl("ready");

		const scenes = new Set((process.env.SHOWCASE_SCENES ?? "tiles,cards,tray").split(","));

		// 1. The job tiles and the jobs pill.
		if (scenes.has("tiles")) {
			await startOmp("xdg-tray");
			await cloud("watch rate");
			await pause(5000);
			await cloud("list");
			await pause(6000);
			await shoot("tui-cloud-tiles");
			await exitOmp();
		}

		// 2. The launch card and a pending question card in the transcript. Watching the waiting thread opens omp's ask
		// dialog over the composer; Escape closes it (no answer), and the card keeps its option list and Other….
		if (scenes.has("cards")) {
			const seeded = new Set((await threads(h)).map(thread => thread.id));
			await ctl("resize", "950", "880");
			await startOmp("xdg-cards");
			await cloud("Add request IDs to the API logs");
			await pause(8000);
			await cloud("watch backoff", false);
			await pause(5000);
			await ctl("key", "escape");
			await pause(2500);
			await shoot("tui-question-card");
			await ctl("resize", "950", "680");
			await exitOmp();
			// The launch made a seventh thread; the other images show the six.
			for (const thread of await threads(h)) {
				if (!seeded.has(thread.id)) await api(h, `/api/v1/threads/${thread.id}`, { method: "DELETE" });
			}
		}

		// 3. The tray: two omp panes in the background, a shell in front.
		if (!scenes.has("tray")) return;
		const rows = await threads(h);
		const waiting = rows.find(t => t.name === SHOWCASE_WAITING_NAME);
		if (waiting === undefined) throw new Error("the waiting thread is missing");
		await startOmp("xdg-tray");
		await cloud("watch backoff", false);
		await pause(4000);
		await ctl("key", "escape");
		await pause(1000);
		await ctl("tab", "new");
		await pause(1500);
		await ctl("ready");
		await startOmp("xdg-tray");
		await cloud("watch rate");
		await pause(4000);
		await ctl("tab", "new");
		await pause(1500);
		await ctl("ready");
		await ctl("run", quoted(`cd ${REPO} && clear`));

		const detail: unknown = await (await api(h, `/api/v1/threads/${waiting.id}`)).json();
		const turns = typeof detail === "object" && detail !== null && "turns" in detail && Array.isArray(detail.turns) ? detail.turns : [];
		const turn = turns.at(-1)?.id;
		if (typeof turn !== "number") throw new Error("the waiting thread has no turn");
		await api(h, `/api/v1/threads/${waiting.id}/turns/${turn}/questions/1/answer`, { method: "POST", body: JSON.stringify({ selected: SHOWCASE_FIRST_ANSWER }) });
		await pause(2500);
		await control(h, "ask");
		await pause(2500);
		await control(h, "finish");
		await pause(4000);
		await ctl("resize", "780", "320");
		await pause(1500);
		for (const theme of THEMES) await trayShot(theme);
	} finally {
		if (tern !== undefined) {
			await ctl("quit").catch(() => undefined);
			tern.kill();
		}
		await h.stop();
		rmSync(ROOT, { recursive: true, force: true });
	}
}

async function trayShot(theme: Theme): Promise<void> {
	await ctl("appearance", theme);
	await pause(2000);
	await ctl("inbox");
	await pause(1500);
	const reply = await ctl("shot", `tern-bell-tray-${theme}`);
	const png = /"png":"([^"]+)"/.exec(reply)?.[1];
	if (png === undefined) throw new Error(`no shot path in ${reply}`);
	copyFileSync(png, join(OUT, `tern-bell-tray-${theme}.png`));
	console.log(`wrote tern-bell-tray-${theme}.png`);
	await ctl("inbox", "close");
}

await main();
