/** Typed factories for the API objects the tests feed the plugin: every field present, overridable. */

import type {
	Login,
	PendingQuestion,
	Question,
	ThreadDetail,
	ThreadEvent,
	ThreadMetrics,
	ThreadSummary,
	ThreadTurn,
	Whoami,
} from "../src/types";

export function whoami(over: Partial<Whoami> = {}): Whoami {
	return {
		user: "owner",
		maxUploadBytes: 1024 * 1024 * 1024,
		defaultModel: "anthropic/claude-sonnet-5-5",
		modelPatterns: ["anthropic/*"],
		ompVersion: "18.12.3",
		gitHosts: [],
		mcpProxy: false,
		mcpLogins: [],
		vms: { running: 0, paused: 0 },
		threads: { starting: 0, working: 0, waiting: 0, idle: 0, failed: 0 },
		device: null,
		remote: null,
		service: { version: "0.4.0", api: 2 },
		capabilities: [],
		limits: { maxMessageBytes: 32768, maxAnswerBytes: 4000, maxUploadBytes: 1024 * 1024 * 1024, listMax: 200, maxTurns: 200 },
		spend: null,
		models: [],
		update: null,
		...over,
	};
}

export function question(over: Partial<Question> = {}): Question {
	return {
		id: 1,
		ask: 1,
		key: "q1",
		text: "Which one?",
		header: "",
		options: [],
		multi: false,
		recommended: null,
		askedAt: "2026-01-01T00:00:00Z",
		kind: "ask",
		expiresAt: null,
		selected: [],
		answer: "",
		answeredBy: "",
		answeredAt: "",
		expired: false,
		...over,
	};
}

export function pending(over: Partial<PendingQuestion> = {}): PendingQuestion {
	return {
		turn: 1,
		id: 1,
		ask: 1,
		text: "Which one?",
		header: "",
		options: [],
		multi: false,
		recommended: null,
		askedAt: "2026-01-01T00:00:00Z",
		kind: "ask",
		expiresAt: null,
		remaining: 1,
		...over,
	};
}

export function turn(id: number, over: Partial<ThreadTurn> = {}): ThreadTurn {
	return {
		id,
		state: "done",
		text: "do it",
		by: "owner",
		queuedAt: "2026-01-01T00:00:00Z",
		startedAt: "2026-01-01T00:00:01Z",
		completedAt: "2026-01-01T00:01:00Z",
		reply: "",
		title: "",
		error: "",
		usage: null,
		head: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		pushed: false,
		pushError: "",
		pushRef: "",
		origin: "",
		ircFrom: "",
		ircId: "",
		ircReplyTo: "",
		requests: 0,
		tools: 0,
		context: null,
		questions: [],
		...over,
	};
}

/** A thread's metrics with nothing used yet; override what a test needs. */
export function metrics(over: Partial<ThreadMetrics> = {}): ThreadMetrics {
	return {
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
		requests: 0,
		tools: 0,
		workMs: 0,
		context: null,
		turns: [],
		...over,
	};
}

export function summary(over: Partial<ThreadSummary> = {}): ThreadSummary {
	return {
		id: "k3x9fa2m7q1z",
		name: "",
		title: "do it",
		owner: "owner",
		phase: "idle",
		error: "",
		turns: 1,
		queued: 0,
		model: "anthropic/claude-sonnet-5-5",
		thinking: "high",
		ompVersion: "18.12.3",
		latest: null,
		question: null,
		result: null,
		createdAt: "2026-01-01T00:00:00Z",
		lastActivityAt: "2026-01-01T00:01:00Z",
		archivedAt: null,
		metrics: null,
		activity: null,
		origin: "",
		ref: "",
		session: "",
		scratch: false,
		pr: null,
		warnings: [],
		repo: { name: "app", remoteURL: "", baseRef: "main", localBranch: "main" },
		workspace: "/home/ada/app",
		...over,
	};
}

export function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
	const { turns: _turns, warnings: _warnings, repo: _repo, workspace: _workspace, ...base } = summary();
	return {
		...base,
		repo: { name: "app", remoteURL: "", baseRef: "main", baseCommit: "", handoffCommit: "", localBranch: "main" },
		paths: { home: "/home/ada", workspace: "/home/ada/app" },
		configOverlays: [],
		readOnly: false,
		vm: null,
		turns: [turn(1)],
		...over,
	};
}

export function event(seq: number, over: Partial<ThreadEvent> = {}): ThreadEvent {
	return { seq, at: "2026-01-01T00:00:00Z", kind: "assistant", turn: 1, text: "", ...over };
}

export function login(over: Partial<Login> = {}): Login {
	return { id: "l1", provider: "openai-codex", state: "waiting", url: "https://auth.example/x", instructions: "", userCode: "", account: "", error: "", ...over };
}
