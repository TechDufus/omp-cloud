import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { cardRenderer, CARD_TYPE, loadTui, type TuiModule } from "./cards";
import { registerCloudTool } from "./tool";
import { Cloud } from "./verbs";

/** This extension's own directory (the package root), which is never shipped to the cloud. */
const OWN_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Registers everything the plugin adds to omp. Needs omp 18.12.3+ host modules: only `index.ts` imports this, lazily. */
export async function register(pi: ExtensionAPI): Promise<void> {
	const cloud = new Cloud(pi, OWN_ROOT);
	let tui: TuiModule | undefined;

	// Everything registers before the first await: omp reads registrations during load.
	pi.registerMessageRenderer(CARD_TYPE, cardRenderer(() => tui, cloud));

	// `/cloud` is the only user entry point; there is deliberately no input-prefix trigger.
	pi.registerCommand("cloud", {
		description: "Hand work to a cloud agent and manage cloud threads (no arguments: the hub)",
		getArgumentCompletions: prefix => cloud.complete(prefix),
		handler: (args, ctx) => cloud.handle(args, ctx),
	});

	registerCloudTool(pi, cloud);

	// switchSession replaces the session's context (and clears its timers); re-arm the watcher. omp cancels the session's
	// jobs on the way (a switch, a branch): the cloud turns they stand for keep running, and a turn still running is a job again.
	pi.on("session_before_switch", () => {
		cloud.beforeSwitch();
	});
	pi.on("session_before_branch", () => {
		cloud.beforeSwitch();
	});
	pi.on("session_branch", (_event, ctx) => {
		cloud.afterSwitch();
		cloud.rebind(ctx);
	});
	// The terminal keeps no record this plugin wrote once the session is over.
	pi.on("session_shutdown", () => {
		cloud.shutdown();
	});
	pi.on("session_switch", (_event, ctx) => {
		cloud.afterSwitch();
		cloud.rebind(ctx);
		void cloud.followSession(ctx);
	});

	// The job manager exists from session_start on: a turn that runs on a thread the session follows (it was running when
	// omp restarted) becomes a job.
	pi.on("session_start", (_event, ctx) => {
		void cloud.followSession(ctx);
		// The footer's `update ready`, the update card and the plugin-older notice need the service's word on it.
		cloud.probeUpdates(ctx);
	});

	// Cards held back while the agent was busy appear once it has ended.
	pi.on("agent_end", (_event, ctx) => {
		ctx.setTimeout(() => cloud.flushCards(ctx), 100);
	});

	// pi-tui is provided by the host. Without it the cards render as plain text and the hub
	// falls back to an inventory card.
	tui = await loadTui();
	cloud.setTui(tui);
}
