import { describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import ompCloud, { LOAD_FAILED_MARKER, loadFailure, ompCloudWith, ompTooOld } from "../src/index";
import * as main from "../src/main";
import { fakeHost } from "./fakes";

interface Registered {
	commands: { name: string; description?: string; handler: (args: string, ctx: unknown) => unknown }[];
	tools: string[];
	renderers: string[];
	events: { name: string; handler: (event: unknown, ctx: unknown) => unknown }[];
}

/** An omp API that records what the extension registers. */
function recorder(ompVersion?: string): { pi: ExtensionAPI; got: Registered } {
	const got: Registered = { commands: [], tools: [], renderers: [], events: [] };
	const pi = {
		zod: z,
		getAllTools: () => [],
		registerTool: (t: { name: string }) => void got.tools.push(t.name),
		registerMessageRenderer: (type: string) => void got.renderers.push(type),
		registerCommand: (name: string, o: { description?: string; handler: (args: string, ctx: unknown) => unknown }) => void got.commands.push({ name, ...o }),
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void got.events.push({ name, handler }),
		...(ompVersion === undefined ? {} : { pi: { VERSION: ompVersion } }),
	} as unknown as ExtensionAPI;
	return { pi, got };
}

const OLD = new Error("Cannot find package '@oh-my-pi/pi-natives' imported from /repo/node_modules/@oh-my-pi/pi-tui/src/utils.ts\n    at resolve");
const UNSERVED = new Error("Cannot find package '@oh-my-pi/pi-coding-agent' imported from /home/u/.omp/plugins/omp-cloud/src/cloud-jobs.ts\n    at resolve");

describe("the extension entry", () => {
	test("on an omp older than the minimum it says the omp is too old, and registers only the explaining command and a session_start notice", async () => {
		const { pi, got } = recorder("18.12.2");
		await ompCloudWith(pi, () => Promise.reject(OLD));

		expect(got.tools).toEqual([]);
		expect(got.renderers).toEqual([]);
		expect(got.commands.map(c => c.name)).toEqual(["cloud"]);
		expect(got.events.map(e => e.name)).toEqual(["session_start"]);
		expect(got.commands[0]?.description).toBe("omp-cloud could not load: Cannot find package '@oh-my-pi/pi-natives' imported from /repo/node_modules/@oh-my-pi/pi-tui/src/utils.ts");

		const message = `☁ omp-cloud needs omp 18.12.3 or newer; this omp is 18.12.2 (${process.execPath}) and cannot load it (Cannot find package '@oh-my-pi/pi-natives' imported from /repo/node_modules/@oh-my-pi/pi-tui/src/utils.ts). Run Tern's omp, or update this one.`;
		expect(loadFailure(OLD, "18.12.2").message).toBe(message);

		const shown = fakeHost();
		await got.commands[0]?.handler("list", shown.host);
		await got.events[0]?.handler({}, shown.host);
		expect(shown.notes).toEqual([
			[message, "error"],
			[message, "error"],
		]);
	});

	test("on a new enough omp the failure is the plugin's own: the error, what to do, and no claim that the omp is old", async () => {
		const { pi, got } = recorder("18.12.5");
		await ompCloudWith(pi, () => Promise.reject(UNSERVED));
		const message = "☁ omp-cloud could not load in omp 18.12.5 (Cannot find package '@oh-my-pi/pi-coding-agent' imported from /home/u/.omp/plugins/omp-cloud/src/cloud-jobs.ts). Update omp-cloud (omp plugin upgrade), or report this error.";
		const shown = fakeHost();
		await got.commands[0]?.handler("", shown.host);
		await got.events[0]?.handler({}, shown.host);
		expect(shown.notes).toEqual([
			[message, "error"],
			[message, "error"],
		]);
		expect(got.commands[0]?.description).toBe("omp-cloud could not load: Cannot find package '@oh-my-pi/pi-coding-agent' imported from /home/u/.omp/plugins/omp-cloud/src/cloud-jobs.ts");
		expect(got.commands[0]?.description?.startsWith(LOAD_FAILED_MARKER)).toBe(true);
		expect(message).not.toContain("needs");
	});

	test("a prerelease of the minimum, a newer omp, an unreadable version and no version are none of them too old", () => {
		expect(ompTooOld("18.12.3")).toBe(false);
		expect(ompTooOld("18.12.3-dev.4")).toBe(false);
		expect(ompTooOld("18.13.0")).toBe(false);
		expect(ompTooOld("19.0.0")).toBe(false);
		expect(ompTooOld("nightly")).toBe(false);
		expect(ompTooOld(undefined)).toBe(false);
		expect(ompTooOld("18.12.2")).toBe(true);
		expect(ompTooOld("18.11.9")).toBe(true);
		expect(ompTooOld("17.99.99")).toBe(true);
		expect(loadFailure(OLD, undefined).message).toBe("☁ omp-cloud could not load in this omp (Cannot find package '@oh-my-pi/pi-natives' imported from /repo/node_modules/@oh-my-pi/pi-tui/src/utils.ts). Update omp-cloud (omp plugin upgrade), or report this error.");
	});

	test("a failure that is not an Error is explained too", async () => {
		const { pi, got } = recorder();
		await ompCloudWith(pi, () => Promise.reject("nope"));
		const shown = fakeHost();
		await got.commands[0]?.handler("", shown.host);
		expect(shown.notes[0]?.[0]).toContain("(nope)");
	});

	test("when the plugin loads, everything registers and the fallback does not", async () => {
		const { pi, got } = recorder();
		await ompCloudWith(pi, async () => main);

		expect(got.commands.map(c => c.name)).toEqual(["cloud"]);
		expect(got.commands[0]?.description).toContain("Hand work to a cloud agent");
		expect(got.tools).toEqual(["cloud"]);
		expect(got.renderers).toEqual(["omp-cloud"]);
		expect(got.events.map(e => e.name)).toEqual(["session_before_switch", "session_before_branch", "session_branch", "session_shutdown", "session_switch", "session_start", "agent_end"]);
	});

	test("the default export loads the real plugin lazily", async () => {
		const { pi, got } = recorder();
		await ompCloud(pi);
		expect(got.tools).toEqual(["cloud"]);
	});
});
