/**
 * The extension entry. It imports nothing at runtime but `node:` built-ins: the rest of the plugin (`./main`) imports host
 * modules that only omp 18.12.3 and newer provide (job manager, job widgets, ...). On an older omp those imports resolve
 * into this repository's `node_modules`, which needs native packages only the omp binary carries, and the extension would
 * fail to load with an error that explains nothing. Loading `./main` lazily keeps this entry loadable on any omp, so it
 * can say what is wrong: that the omp is older than the minimum when it is, and otherwise the error itself, which is then
 * a bug of the plugin (a module this omp does not serve) and not something an older omp explains.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { register } from "./main";

/** The part of `./main` the entry uses. */
export interface MainModule {
	register: typeof register;
}

/** Loads `./main`; a test seam. */
export type MainLoader = () => Promise<MainModule>;

/** The oldest omp the plugin supports. */
export const MIN_OMP_VERSION = "18.12.3";

/** The first line of a failure, for one sentence. */
function firstLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.split("\n", 1)[0] ?? "";
}

/** `[major, minor, patch]` of a version such as `18.12.3` or `18.12.3-dev.4`; undefined for anything else. */
function release(version: string): [number, number, number] | undefined {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether `version` is a release older than {@link MIN_OMP_VERSION}; false when it is not a version (nothing then says the omp is old). */
export function ompTooOld(version: string | undefined): boolean {
	const have = release(version ?? "");
	const need = release(MIN_OMP_VERSION);
	if (!have || !need) return false;
	for (let i = 0; i < 3; i++) {
		const a = have[i] ?? 0;
		const b = need[i] ?? 0;
		if (a !== b) return a < b;
	}
	return false;
}

/** Opens the description of the fallback `/cloud` command, always: `omp-cloud doctor` recognises a plugin that failed to load by it. Never reword it. */
export const LOAD_FAILED_MARKER = "omp-cloud could not load:";

/** What the user is told when this omp cannot load the plugin: "needs a newer omp" only for an omp older than the minimum. */
export function loadFailure(error: unknown, ompVersion: string | undefined): { message: string; description: string } {
	const reason = firstLine(error);
	if (ompTooOld(ompVersion)) {
		return {
			message: `☁ omp-cloud needs omp ${MIN_OMP_VERSION} or newer; this omp is ${ompVersion} (${process.execPath}) and cannot load it (${reason}). Run Tern's omp, or update this one.`,
			description: `${LOAD_FAILED_MARKER} ${reason}`,
		};
	}
	const where = ompVersion ? `omp ${ompVersion}` : "this omp";
	return {
		message: `☁ omp-cloud could not load in ${where} (${reason}). Update omp-cloud (omp plugin upgrade), or report this error.`,
		description: `${LOAD_FAILED_MARKER} ${reason}`,
	};
}

/** Loads the plugin through `load`; when that fails, registers only a `/cloud` command and a one-time notice that say why. */
export async function ompCloudWith(pi: ExtensionAPI, load: MainLoader): Promise<void> {
	let main: MainModule;
	try {
		main = await load();
	} catch (error) {
		const { message, description } = loadFailure(error, typeof pi.pi?.VERSION === "string" ? pi.pi.VERSION : undefined);
		pi.registerCommand("cloud", {
			description,
			handler: async (_args, ctx) => {
				ctx.ui.notify(message, "error");
			},
		});
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(message, "error");
		});
		return;
	}
	await main.register(pi);
}

export default function ompCloud(pi: ExtensionAPI): Promise<void> {
	// A literal specifier on purpose: the lazy load is the point (see the module comment).
	return ompCloudWith(pi, () => import("./main"));
}
