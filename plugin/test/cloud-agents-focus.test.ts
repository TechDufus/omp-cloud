/**
 * A cloud agent as the session omp's interactive mode focuses (the Agent Hub's Enter): omp's own `SessionFocusController`,
 * `EventController` and `UiHelpers` run against the agent's `CloudSession` with a minimal interactive-mode context, and
 * pi-tui's own `StatusLineComponent` renders from it. Only the context's widgets, the main session and the cloud client are fakes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Container } from "@oh-my-pi/pi-tui";
import { ServedModelTracker } from "@oh-my-pi/pi-tui/chat/served-model-marker";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import type { StatusLineHost, StatusLineSession } from "@oh-my-pi/pi-tui/status-line/host";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { CloudAgents, CloudSession, SHIM_MEMBERS } from "../src/cloud-agents";
import type { ThreadDetail } from "../src/types";
import { detail, metrics, turn } from "./builders";
import { cleanup, isolateOmp } from "./helpers";

const ID = "aaaaaak3x9fa";

const running = (over: Partial<ThreadDetail> = {}): ThreadDetail =>
	detail({ id: ID, name: "Fix greeting bug", phase: "working", model: "anthropic/claude-sonnet-5-5", turns: [turn(1, { state: "running", text: "fix the greeting bug", completedAt: "" })], ...over });

const finished = (over: Partial<ThreadDetail> = {}): ThreadDetail =>
	detail({ id: ID, name: "Fix greeting bug", phase: "idle", model: "anthropic/claude-sonnet-5-5", turns: [turn(1, { state: "done", text: "fix the greeting bug", reply: "All done." })], ...over });

/** The main agent's session, as far as omp reads it when the view returns to it. */
const main = { isStreaming: false, isRetrying: false, extensionRunner: undefined, agent: { getPendingToolResults: () => [] } };

interface Rig {
	agents: CloudAgents;
	registry: AgentRegistry;
	focus: SessionFocusController;
	chat: TranscriptContainer;
	/** Every event omp's event controller was handed while the agent was focused: its type, and when it was handled. */
	handled: { type: string; done: Promise<void> }[];
	agent: string;
}

const rigs: Rig[] = [];

function rig(first: ThreadDetail): Rig {
	const registry = new AgentRegistry();
	registry.register({ id: "Main", displayName: "Main", kind: "main", session: main as unknown as AgentSession, status: "idle" });
	const agents = new CloudAgents({
		client: async () => {
			throw new Error("no cloud in this test");
		},
		follow: () => {},
		warn: () => {},
		cwd: () => "/work",
		entries: () => [],
		relayFailed: () => {},
		registry: () => registry,
		hydrate: false,
	});
	agents.observe(first);
	const handled: Rig["handled"] = [];
	const chat = new TranscriptContainer();
	const widgets: Record<string, unknown> = {
		collabGuest: false,
		session: main,
		unsubscribe: undefined,
		clearTransientSessionUi() {},
		statusLine: { setSession() {}, invalidate() {}, markActivityStart() {}, markActivityEnd() {} },
		showStatus() {},
		ui: { requestRender() {}, requestComponentRender() {}, terminal: { setProgress() {} } },
		updatePendingMessagesDisplay: () => helpers.updatePendingMessagesDisplay(),
		updateEditorBorderColor() {},
		reloadTodos: async () => {},
		renderInitialMessages: (options: unknown) => helpers.renderInitialMessages(options as never),
		addMessageToChat: (message: never, options: never) => helpers.addMessageToChat(message, options),
		renderSessionContext: (context: never, options: never) => helpers.renderSessionContext(context, options),
		renderSessionContextIncrementally: (context: never, options: never) => helpers.renderSessionContextIncrementally(context, options),
		composer: { setRunActive() {} },
		settings: Settings.isolated(),
		chatContainer: chat,
		pendingMessagesContainer: new Container(),
		pendingTools: new Map(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap(),
		servedModelTracker: new ServedModelTracker(),
		lastAssistantUsage: undefined,
		initialChatRendered: false,
		hideToolActivity: false,
		compactionQueuedMessages: [],
		isInitialized: true,
		editor: { getText: () => "" },
		clearPinnedError() {},
		ensureLoadingAnimation() {},
		flushPendingModelSwitch: async () => {},
		flushPendingCommandOutput() {},
		statusContainer: new Container(),
		loadingAnimation: undefined,
		shutdownRequested: false,
		todoPhases: [],
		keybindings: { getKeys: () => [] },
		sessionManager: { getSessionName: () => undefined },
		syncRetryHintRow() {},
		retryLoader: undefined,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		expandThinkingBlocks: false,
		assistantImagesVisible: true,
		tableChartsVisible: true,
		toolOutputExpanded: false,
		resolveAssistantMessageLinkHrefs: async () => new Map(),
	};
	// A member the real controllers read that this context does not provide is a loud failure, not an undefined.
	const ctx: Record<string, unknown> = new Proxy(widgets, {
		get(target, key) {
			if (typeof key === "string" && key in target) return target[key];
			if (key === "viewSession") return focus.target ?? main;
			if (key === "focusedAgentId") return focus.focusedAgentId;
			if (key === "eventController") return events;
			throw new Error(`the interactive-mode context member ${String(key)} is not provided by this test`);
		},
		set(target, key, value) {
			if (typeof key === "string") target[key] = value;
			return true;
		},
	});
	const events = new EventController(ctx as never);
	const helpers = new UiHelpers(ctx as never);
	const handle = events.handleEvent.bind(events);
	events.handleEvent = event => {
		const done = handle(event);
		handled.push({ type: event.type, done });
		return done;
	};
	const focus = new SessionFocusController(ctx as never, registry, () => ({ ensureLive: async (id: string) => registry.get(id)?.session }) as unknown as AgentLifecycleManager);
	const r: Rig = { agents, registry, focus, chat, handled, agent: agents.agentId(ID) ?? "" };
	rigs.push(r);
	return r;
}

beforeEach(async () => {
	await isolateOmp();
	// The settings omp's controllers read through its global `settings`; in memory, nothing on disk.
	await Settings.init({ inMemory: true });
	ensureThemeSync();
});

afterEach(async () => {
	for (const r of rigs.splice(0)) {
		r.focus.dispose();
		r.agents.dispose();
	}
	await cleanup();
});

describe("focusing a cloud agent, as the Agent Hub does", () => {
	test("attaches a running agent: omp's controllers read nothing the session lacks", async () => {
		const r = rig(running());
		await r.focus.focusAgent(r.agent);

		expect(r.focus.focusedAgentId).toBe(r.agent);
		expect(r.focus.target).toBeInstanceOf(CloudSession);
		// The replay drew the agent's prompt: the transcript is not empty.
		expect(r.chat.children.length).toBeGreaterThan(0);
	});

	test("attaches an idle agent that finished a turn", async () => {
		const r = rig(finished());
		await r.focus.focusAgent(r.agent);

		expect(r.focus.focusedAgentId).toBe(r.agent);
		expect(r.chat.children.length).toBeGreaterThan(0);
	});

	test("the agent's run state reaches omp's event controller while it is focused", async () => {
		const r = rig(finished());
		await r.focus.focusAgent(r.agent);

		r.agents.observe(running({ turns: [turn(1), turn(2, { state: "running", text: "again", completedAt: "" })] }));
		r.agents.observe(finished({ turns: [turn(1), turn(2, { state: "done", text: "again", reply: "Again." })] }));

		// A handler that read something the shim lacks rejects its promise.
		expect(r.handled.map(h => h.type)).toEqual(["agent_start", "agent_end"]);
		await Promise.all(r.handled.map(h => h.done));
	});
});

describe("the status line of a focused cloud agent", () => {
	const SETTINGS = {};
	const host: StatusLineHost = {
		getSettings: () => SETTINGS,
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: async () => null,
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	};

	test("renders from the shim, with the thread's cost", () => {
		const r = rig(running({ metrics: metrics({ usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1.07 } }) }));
		const shim = r.registry.get(r.agent)?.session;
		expect(shim).toBeInstanceOf(CloudSession);
		const line = new StatusLineComponent(shim as unknown as StatusLineSession, host);

		const text = line.renderBottomBar(200, "full");
		expect(text).toContain("sonnet");
		expect(text).toContain("1.07");
	});
});

describe("the members omp reads of the session it focuses", () => {
	/**
	 * Members of `viewSession` that a cloud agent cannot honor and the shim does not answer: a user's command in a focused view
	 * (the model picker, `/thinking`, `/export`). Their handlers report the failure; none is read by the attach, the replay,
	 * the status line or a timer.
	 */
	const COMMANDS = ["applyRoleModel", "exportToHtml", "setThinkingLevel"];
	const MODES = join(import.meta.dir, "..", "..", "node_modules", "@oh-my-pi", "pi-coding-agent", "src", "modes");

	/** Every member read as `viewSession.<member>` (or `viewSession.agent.<member>`) in the pinned omp's interactive mode. Reads through an alias (`const session = ctx.viewSession`) are the real controllers' job in the tests above. */
	async function readOfViewSession(): Promise<Set<string>> {
		const read = new Set<string>();
		for (const file of new Bun.Glob("**/*.ts").scanSync(MODES)) {
			const source = await Bun.file(join(MODES, file)).text();
			for (const match of source.matchAll(/\bviewSession\??\.((?:agent\.)?\w+)/g)) if (match[1] !== undefined) read.add(match[1]);
		}
		return read;
	}

	test("the shim answers each one the pinned omp reads, or it is a user command the shim says it cannot honor", async () => {
		const read = await readOfViewSession();
		const answered = new Set(SHIM_MEMBERS.map(m => m.path.split(".").slice(0, m.path.startsWith("agent.") ? 2 : 1).join(".")));
		expect([...read].filter(member => !answered.has(member) && !COMMANDS.includes(member)).sort()).toEqual([]);
		// The list of commands is not a place to park members: each is still read.
		expect(COMMANDS.filter(member => !read.has(member))).toEqual([]);
	});
});
