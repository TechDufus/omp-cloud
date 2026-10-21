import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Env } from "../src/config";
import type { Host, HostUi, NotifyType, PiHost } from "../src/types";
import { tmp } from "./helpers";

/**
 * An environment whose `XDG_CONFIG_HOME` is a fresh temp directory, so omp-cloud's personal file is
 * `<that>/omp-cloud/config.yml` and a developer's own never leaks into a test. `personal` is written there when given;
 * `extra` variables ride along.
 */
export async function cloudEnv(personal?: string, extra: Env = {}): Promise<Env> {
	const xdg = await tmp("omp-cloud-xdg-");
	if (personal !== undefined) {
		await mkdir(join(xdg, "omp-cloud"), { recursive: true });
		await writeFile(join(xdg, "omp-cloud", "config.yml"), personal);
	}
	return { XDG_CONFIG_HOME: xdg, ...extra };
}

export interface FakeHost {
	host: Host;
	notes: [string, NotifyType | undefined][];
	widgets: Parameters<HostUi["setWidget"]>[1][];
	status: (string | undefined)[];
	/** Callbacks scheduled with `setTimeout`. */
	timeouts: (() => void)[];
	idle: boolean;
}

/** The plain lines of the latest `setWidget` call; undefined when the widget was cleared, a component factory or never set. */
export function lastLines(f: FakeHost): string[] | undefined {
	const w = f.widgets.at(-1);
	return Array.isArray(w) ? w : undefined;
}

export interface FakeHostOptions {
	cwd?: string;
	mode?: string;
	sessionFile?: string;
	entries?: unknown[];
	/** `undefined` keeps the default model; `null` is a session without one. */
	model?: { provider: string; id: string } | null;
	/** What `ExtensionContext.modelRegistry` resolves models with; absent by default, so a handoff asks for no name. */
	modelRegistry?: Host["modelRegistry"];
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	input?: (title: string, placeholder?: string) => Promise<string | undefined>;
	custom?: HostUi["custom"];
	confirm?: boolean;
}

export function fakeHost(opts: FakeHostOptions = {}): FakeHost {
	const f: FakeHost = {
		notes: [],
		widgets: [],
		status: [],
		timeouts: [],
		idle: true,
		host: undefined as unknown as Host,
	};
	f.host = {
		cwd: opts.cwd ?? "/x",
		mode: opts.mode,
		model: opts.model === null ? undefined : (opts.model ?? { provider: "anthropic", id: "claude-sonnet-5-5" }),
		modelRegistry: opts.modelRegistry,
		sessionManager: {
			getSessionFile: () => opts.sessionFile,
			getSessionDir: () => "/s",
			getEntries: () => opts.entries ?? [],
		},
		isIdle: () => f.idle,
		ui: {
			notify: (m, t) => void f.notes.push([m, t]),
			setWidget: (_k, c) => void f.widgets.push(c),
			setStatus: (_k, t) => void f.status.push(t),
			confirm: async () => opts.confirm ?? true,
			select: opts.select,
			input: opts.input,
			custom: opts.custom,
		},
		setTimeout: callback => {
			f.timeouts.push(callback);
			return { id: "timeout" } as unknown as Timer;
		},
		clearTimer: () => {},
	};
	return f;
}

export interface SentMessage {
	message: { customType: string; content: string; display: boolean; details?: unknown; attribution?: "user" | "agent" };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

export interface FakePi {
	pi: PiHost;
	sent: SentMessage[];
}

export interface FakePiOptions {
	thinking?: string | undefined;
	version?: string;
	/** The session's `pi.pi.settings`: empty and in memory by default. */
	settings?: Settings;
}

export function fakePi(opts: FakePiOptions = {}): FakePi {
	const sent: SentMessage[] = [];
	return {
		sent,
		pi: {
			getThinkingLevel: () => ("thinking" in opts ? opts.thinking : "high"),
			sendMessage: (message, options) => void sent.push({ message, options }),
			pi: { VERSION: opts.version ?? "18.12.3", settings: opts.settings ?? Settings.isolated() },
		},
	};
}

export interface FakeSettingsOptions {
	/** The agent directory; its `config.yml` is the global layer. A fresh temp directory by default. */
	agentDir?: string;
	/** The session's working directory. A fresh temp directory by default. */
	cwd?: string;
	/** YAML written to `<agentDir>/config.yml`. */
	global?: string;
	/** `--config` overlay files, in load order; each must exist. */
	configFiles?: readonly string[];
}

/** omp's own `Settings`, loaded from temp files: the global and `--config` layers with real precedence and provenance. */
export async function fakeSettings(opts: FakeSettingsOptions = {}): Promise<Settings> {
	const agentDir = opts.agentDir ?? (await tmp("omp-cloud-agent-"));
	const cwd = opts.cwd ?? (await tmp("omp-cloud-cwd-"));
	if (opts.global !== undefined) await writeFile(join(agentDir, "config.yml"), opts.global);
	return Settings.loadIsolated({ cwd, agentDir, configFiles: [...(opts.configFiles ?? [])] });
}

/** Settings as omp's proxy behaves before it has initialized them: every access throws. */
export function uninitializedSettings(): Settings {
	return new Proxy(Settings.isolated(), {
		get() {
			throw new Error("settings are not initialized");
		},
	});
}

/** Waits until `cond` holds, polling the event loop; fails after `ms`. */
export async function until(cond: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await Bun.sleep(5);
	}
}
