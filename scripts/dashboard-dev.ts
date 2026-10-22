/**
 * `mise run dashboard:dev`: the dashboard on realistic data, for working on the web client.
 *
 * A temp directory holds a database seeded through `Store` (threads in every phase over several repositories and
 * models, names on most threads, turns with usage, cost, requests, tools and context spread over the last 14 days,
 * thread contexts with known and unknown windows, two archived threads (no VM), a running turn with live activity,
 * an open question, results with diffstats and
 * pushed branches, two paired devices, a pairing offer and a request waiting for approval, settings with their
 * audit trail), a fake vmon (the sandbox list and per-sandbox metrics the VMs page reads, matching the seeded VM
 * records), a fake gateway (the model list) and the service itself on loopback ports with the runner off and no remote
 * listener. The script prints a sign-in link (valid 60 s, once; press Enter for another) and the location of the
 * owner token file (0600, never printed). Ctrl+C stops the service and deletes the directory.
 *
 * The service's own update (the header pill and the Settings card) can be scripted, for screenshots and for working on
 * them: `mise run dashboard:dev -- --update=<state>` (or `OMP_CLOUD_DASHBOARD_DEV_UPDATE=<state>`; plain `--update` starts
 * `ready`). The service here runs from a checkout and could only say `unsupported`, so a front listener answers
 * `/api/v1/update*` from a state machine (ready, downloading, applying with its steps, failed with a rollback, updated with
 * release notes, idle, checking, unsupported) and forwards the rest. Type a state name in the terminal, or
 * `POST /__dev/update?state=<name>`, to switch; the printed sign-in link is on the front's address. Without the flag
 * nothing is scripted.
 *
 * Nothing here touches the real service, its config, its data or vmon.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UpdateMode, UpdateStatus } from "../src/dashboard/client/api";
import { isRecord } from "../src/guards";
import { newDeviceToken, randomBase64Url, sha256Hex } from "../src/pairing/secrets";
import { tokenSha256 } from "../src/server/auth";
import { Store } from "../src/store";
import { deviceActor, type QuestionInput, type TurnResult, type Usage } from "../src/store/types";
import { SHOWCASE_AUTHOR, SHOWCASE_HOME, SHOWCASE_REPOS, SHOWCASE_THREADS } from "./showcase/profile";

const OWNER = "owner";
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.now();
const READY_TIMEOUT_MS = 90_000;
const REPO_ROOT = resolve(import.meta.dir, "..");
/** `--showcase` (or OMP_CLOUD_DASHBOARD_DEV_SHOWCASE=1) swaps in the README screenshots' data set, `scripts/showcase/profile.ts`, and runs the service through `scripts/showcase/service.ts` so the capture script can stage live events. */
const SHOWCASE = process.argv.includes("--showcase") || process.env.OMP_CLOUD_DASHBOARD_DEV_SHOWCASE === "1";
const AUTHOR = SHOWCASE_AUTHOR;
const SEED_HOME = SHOWCASE_HOME;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const GATEWAY_MODELS = [DEFAULT_MODEL, "anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5", "openai/gpt-5.1-codex"];

/** USD per million tokens. */
const RATES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"anthropic/claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"anthropic/claude-opus-5-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"anthropic/claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"openai/gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
};

/**
 * Context windows in tokens. A model missing here has an unknown window (0), as when the VM's omp has no catalog
 * entry for it, and so does a thread without a model.
 */
const WINDOWS: Record<string, number> = {
	"anthropic/claude-sonnet-4-6": 200_000,
	"anthropic/claude-opus-5-5": 1_000_000,
	"anthropic/claude-haiku-4-5": 200_000,
};
/** The window the story assumes for the growth and compaction of a context whose window is unknown. */
const UNKNOWN_WINDOW_BUDGET = 400_000;
/** The archive sweep's default: a thread idle this long loses its VM. */
const ARCHIVE_AFTER_MS = 7 * 24 * HOUR;

// ---- the seed data

export interface RepoSpec {
	name: string;
	remoteURL: string;
	baseRef: string;
	localBranch: string;
	workspace: string;
}

const REPOS = {
	orbit: SHOWCASE_REPOS.orbit,
	storefront: SHOWCASE_REPOS.storefront,
	infra: SHOWCASE_REPOS.infra,
	/** An scp-style remote, grouped like an https one. */
	mobile: {
		name: "mobile-app",
		remoteURL: "git@github.com:northwind/mobile-app.git",
		baseRef: "main",
		localBranch: "offline-sync",
		workspace: `${SHOWCASE_HOME}/dev/mobile-app`,
	},
	/** No remote: a scratch directory. */
	notes: { name: "scratch-notes", remoteURL: "", baseRef: "main", localBranch: "main", workspace: `${SHOWCASE_HOME}/scratch/notes` },
} satisfies Record<string, RepoSpec>;

export interface QuestionSpec {
	key: string;
	header: string;
	text: string;
	options: [label: string, description: string][];
	multi: boolean;
	recommended: number | null;
	/** The labels the owner picked; absent leaves the question open. */
	answer?: string[];
}

export interface TurnSpec {
	/** Hours before now that the message was queued. */
	agoH: number;
	/** Minutes the turn ran. */
	runMin: number;
	prompt: string;
	/** The running turn's latest assistant message, for a turn that has not finished. */
	note?: string;
	summary: string;
	/** The turn's reply when it is not the built one (the summary plus the diffstat). */
	reply?: string;
	size: "s" | "m" | "l";
	/** The result branch's diffstat and what became of the push. */
	result?: { files: number; insertions: number; deletions: number; push: "yes" | "no" | "rejected" };
	/** A failed turn's error. */
	error?: string;
	/** The owner stopped the turn. */
	stopped?: boolean;
	questions?: QuestionSpec[];
}

type OpenTurn = "queued" | "running" | "asking";

export interface ThreadSpec {
	/** The thread's short name; absent leaves it unnamed, and the UIs show its title. */
	name?: string;
	repo: RepoSpec;
	model: string;
	thinking: string;
	/** `!` marks a tool that failed. */
	tools: string[];
	/** The last turn is not finished: it waits in the queue, runs, or waits for an answer. */
	open?: OpenTurn;
	/** The thread failed during its last turn, this many minutes after it started. */
	failure?: { afterMin: number; error: string };
	/** The thread's sandbox: its size and state. */
	vm?: { state: "running" | "paused"; cpuCount: number; memoryMB: number };
	/** The archive sweep released the thread's VM a week after its last activity; the spec has no `vm`. */
	archived?: true;
	/** The first message came from the first paired device. */
	fromDevice?: boolean;
	secretEnv?: string[];
	secretFiles?: string[];
	policy?: { "spend.turnUSD"?: number; webSearch?: boolean };
	turns: TurnSpec[];
}

/** A reply that uses every Markdown construct the thread page formats, including a wide table row and a long code line. */
const ACCOUNTS_REPLY = [
	"## Accounts list",
	"",
	"The list is now grouped by **plan** with a `status` filter; ~~the old flat list~~ is gone. See the [design notes](https://example.com/design/accounts) and the screenshot below.",
	"",
	"1. Group the rows",
	"   - by plan name, then by status",
	"   - collapsed groups remember their state",
	"2. Add the filter",
	"   - `all`, `active` and `suspended`",
	"3. Keep the sort order",
	"",
	"- [x] Grouping",
	"- [x] Status filter",
	"- [ ] Per-group totals",
	"",
	"| Plan | Accounts | Share | Note |",
	"| :--- | :---: | ---: | --- |",
	"| Free | 1204 | 71.3% | Most accounts never upgrade |",
	"| Team | 312 | 18.5% | Billed per seat, invoiced on the first of the month, with a prorated first month and a grace period on failed payments before access is limited |",
	"| Enterprise | 41 | 2.4% | Custom contract |",
	"",
	"```ts",
	`const grouped = Object.groupBy(accounts, account => account.plan); // a deliberately long line so the code block must scroll sideways instead of wrapping ${"x".repeat(80)}`,
	"```",
	"",
	"> Collapsed groups are stored per browser, not per account.",
	"",
	"---",
	"",
	"![Grouped Accounts list](https://example.com/screenshots/accounts-grouped.png)",
].join("\n");

const DEFAULT_THREADS: ThreadSpec[] = [
	{
		repo: REPOS.orbit,
		name: "Migrate the admin UI to React 19",
		model: DEFAULT_MODEL,
		thinking: "high",
		tools: ["read src/admin/api.ts", "bash bun run typecheck", "edit src/admin/app/Shell.tsx", "bash bun test src/admin"],
		open: "running",
		vm: { state: "running", cpuCount: 2, memoryMB: 4096 },
		policy: { "spend.turnUSD": 8, webSearch: false },
		turns: [
			{
				agoH: 72,
				runMin: 14,
				size: "l",
				prompt: "Migrate the admin UI to React 19 on the shared component kit",
				summary: "Ported the shell, router and query layer to React 19; the Overview and Accounts pages render from the live API",
				result: { files: 18, insertions: 642, deletions: 210, push: "yes" },
			},
			{
				agoH: 30,
				runMin: 9,
				size: "m",
				prompt: ["Rework the Accounts list:", "", "- group it by **plan**", "- add a `status` filter", "- keep the current sort order"].join("\n"),
				summary: "Added plan grouping and a status filter to the Accounts list",
				reply: ACCOUNTS_REPLY,
				result: { files: 6, insertions: 188, deletions: 41, push: "no" },
			},
			{
				agoH: 0.07,
				runMin: 0,
				size: "m",
				prompt: "Skin the Invoices page after the shared Requests table and add per-account usage meters",
				summary: "",
				note: "Reading the Invoices table to match its column layout before restyling the usage meters",
			},
		],
	},
	{
		repo: REPOS.orbit,
		name: "API authentication docs",
		model: "anthropic/claude-opus-5-5",
		thinking: "xhigh",
		tools: ["read docs/architecture.md", "grep apiKey", "edit docs/authentication.md", "bash bunx tsc --noEmit"],
		vm: { state: "paused", cpuCount: 2, memoryMB: 2048 },
		turns: [
			{
				agoH: 144,
				runMin: 22,
				size: "l",
				prompt: "Document API authentication end to end for the SDK and the admin UI",
				summary: "Wrote docs/authentication.md: keys, scopes, rotation and revocation",
				result: { files: 3, insertions: 214, deletions: 12, push: "yes" },
			},
			{
				agoH: 120,
				runMin: 11,
				size: "m",
				prompt: "Add a threat model section: what a leaked key and a leaked refresh token can do",
				summary: "Added a threat model covering the key, the refresh token and the signing secret",
				result: { files: 1, insertions: 96, deletions: 4, push: "yes" },
			},
		],
	},
	{
		repo: REPOS.orbit,
		name: "Flaky billing webhook test",
		model: "anthropic/claude-haiku-4-5",
		thinking: "off",
		tools: ["read src/billing/webhook.test.ts", "bash bun test src/billing", "!bash bun test src/billing: 1 fail", "edit src/billing/webhook.ts"],
		vm: { state: "paused", cpuCount: 1, memoryMB: 2048 },
		turns: [
			{
				agoH: 150,
				runMin: 31,
				size: "m",
				prompt: "Find and fix the flaky billing webhook ordering test",
				summary: "",
				error: "the turn ran past runner.turnTimeoutSeconds (1800 s) and was aborted",
			},
			{
				agoH: 149,
				runMin: 6,
				size: "s",
				prompt: "Retry, but cap each wait at 5 s and print the event rows when it fails",
				summary: "Fixed the race: events now order by sequence number, not by timestamp",
				result: { files: 2, insertions: 31, deletions: 9, push: "rejected" },
			},
		],
	},
	{
		repo: REPOS.storefront,
		name: "Checkout address autocomplete",
		model: "anthropic/claude-opus-5-5",
		thinking: "high",
		tools: ["read src/checkout/AddressForm.tsx", "edit src/checkout/autocomplete.ts", "bash bun test checkout", "grep AddressSuggestion"],
		open: "asking",
		vm: { state: "running", cpuCount: 4, memoryMB: 4096 },
		secretEnv: ["GITHUB_TOKEN"],
		secretFiles: [".env.local"],
		turns: [
			{
				agoH: 0.9,
				runMin: 11,
				size: "l",
				prompt: "Add address autocomplete to the checkout form",
				summary: "Added an autocomplete field with debounced lookups to the checkout address form",
				result: { files: 9, insertions: 310, deletions: 47, push: "no" },
			},
			{
				agoH: 0.12,
				runMin: 0,
				size: "m",
				prompt: "Make autocomplete work for billing addresses too and remember the last choice",
				summary: "",
				questions: [
					{
						key: "scope",
						header: "Scope",
						text: "Should a billing address default to the shipping address once one is chosen?",
						options: [
							["Copy shipping", "Pre-fill billing with the chosen shipping address"],
							["Ask again", "Leave billing empty and let the customer pick"],
						],
						multi: false,
						recommended: 0,
					},
					{
						key: "persist",
						header: "Persistence",
						text: "What should be remembered between visits?",
						options: [
							["Last address", "The most recently used address"],
							["Address book", "Up to five saved addresses"],
							["Delivery notes", "The free-text note for the courier"],
						],
						multi: true,
						recommended: 0,
					},
				],
			},
		],
	},
	{
		repo: REPOS.storefront,
		name: "Cart badge flicker",
		model: DEFAULT_MODEL,
		thinking: "medium",
		tools: ["read src/cart/Badge.tsx", "edit src/cart/Badge.tsx", "bash bun test cart", "bash git rebase main"],
		vm: { state: "running", cpuCount: 2, memoryMB: 2048 },
		fromDevice: true,
		turns: [
			{
				agoH: 52,
				runMin: 17,
				size: "l",
				prompt: "Fix the cart badge flicker on slow connections",
				summary: "Kept the last known count while the cart refetches; the flicker is gone",
				result: { files: 4, insertions: 88, deletions: 52, push: "yes" },
			},
			{
				agoH: 28,
				runMin: 8,
				size: "m",
				prompt: "Add a regression test for the refetch path",
				summary: "Added a throttled-network test that fails without the fix",
				result: { files: 2, insertions: 74, deletions: 0, push: "yes" },
				questions: [
					{
						key: "browsers",
						header: "Coverage",
						text: "Which browsers should the test cover?",
						options: [
							["Chromium", "The default in CI"],
							["Firefox", "Gecko, different timer behavior"],
							["WebKit", "Safari's engine"],
						],
						multi: true,
						recommended: 0,
						answer: ["Chromium", "Firefox"],
					},
				],
			},
			{
				agoH: 0.4,
				runMin: 5,
				size: "s",
				prompt: "Rebase onto main and squash the fixup commits",
				summary: "Rebased onto main and squashed three fixups into two commits",
				result: { files: 4, insertions: 88, deletions: 52, push: "yes" },
			},
		],
	},
	{
		repo: REPOS.storefront,
		model: "openai/gpt-5.1-codex",
		thinking: "medium",
		tools: ["read src/main.tsx", "bash hyperfine 'bun run build'", "grep loadTheme"],
		vm: { state: "paused", cpuCount: 2, memoryMB: 2048 },
		turns: [
			{
				agoH: 120,
				runMin: 12,
				size: "m",
				prompt: "Profile the product page load and list the top five costs",
				summary: "First contentful paint is 1.4 s; image decoding and the theme loader account for 60% of it",
			},
			{
				agoH: 100,
				runMin: 10,
				size: "s",
				prompt: "Now make the theme loader lazy",
				summary: "",
				stopped: true,
			},
		],
	},
	{
		repo: REPOS.infra,
		name: "Terraform drift check",
		model: DEFAULT_MODEL,
		thinking: "medium",
		tools: ["read stacks/staging/main.tf", "edit Makefile", "bash terraform plan", "bash make verify-drift"],
		open: "running",
		failure: { afterMin: 25, error: "the VM is gone: vmon killed sandbox ixk3n8w0f2q9h5t1c7ae (out of memory, 4096 MB)" },
		turns: [
			{
				agoH: 9,
				runMin: 13,
				size: "m",
				prompt: "Add a make target that fails when a stack has drifted from its plan",
				summary: "Added the verify-drift target: it plans every stack and fails on any pending change",
				result: { files: 3, insertions: 77, deletions: 0, push: "no" },
			},
			{
				agoH: 8.2,
				runMin: 0,
				size: "l",
				prompt: "Run it against every stack and fix the ones that have drifted",
				summary: "",
			},
		],
	},
	{
		repo: REPOS.infra,
		archived: true,
		model: "",
		thinking: "",
		tools: ["glob stacks/**/*.tf", "grep module", "read modules/README.md"],
		turns: [
			{
				agoH: 216,
				runMin: 6,
				size: "s",
				prompt: "Summarize which Terraform modules no stack references any more",
				summary: "Eleven modules are unreferenced; four are networking modules the staging stack dropped in September",
			},
		],
	},
	{
		repo: REPOS.infra,
		name: "Postgres 16 upgrade plan",
		model: DEFAULT_MODEL,
		thinking: "high",
		tools: [],
		open: "queued",
		turns: [
			{
				agoH: 0.007,
				runMin: 0,
				size: "m",
				prompt: "Plan the Postgres 16 upgrade of the staging database: failover order, a snapshot and a rollback",
				summary: "",
			},
		],
	},
	{
		repo: REPOS.infra,
		name: "Database snapshots",
		archived: true,
		model: "anthropic/claude-opus-5-5",
		thinking: "high",
		tools: ["read modules/database/", "edit modules/database/snapshot.tf", "bash terraform validate", "edit docs/restore-runbook.md"],
		turns: [
			{
				agoH: 310,
				runMin: 26,
				size: "l",
				prompt: "Write the nightly snapshot job and a restore runbook",
				summary: "Added a nightly snapshot job with 14-day retention and a step-by-step restore runbook",
				result: { files: 5, insertions: 236, deletions: 3, push: "yes" },
			},
			{
				agoH: 300,
				runMin: 14,
				size: "m",
				prompt: "Add alerting rules for snapshot age and failed jobs",
				summary: "Added alert rules: a snapshot older than 26 h pages, a failed job warns",
				result: { files: 2, insertions: 58, deletions: 0, push: "yes" },
			},
		],
	},
	{
		repo: REPOS.notes,
		name: "Weekly sync checklist",
		model: "anthropic/claude-haiku-4-5",
		thinking: "off",
		tools: ["read inbox/2026-10-16-weekly-sync.md", "write checklists/weekly-sync.md"],
		turns: [
			{
				agoH: 96,
				runMin: 4,
				size: "s",
				prompt: "Turn these meeting notes into a checklist",
				summary: "Turned the weekly sync notes into a 14-item checklist grouped by owner",
				result: { files: 1, insertions: 38, deletions: 0, push: "no" },
			},
		],
	},
	{
		repo: REPOS.mobile,
		model: DEFAULT_MODEL,
		thinking: "medium",
		tools: ["read src/sync/queue.ts", "grep RetryPolicy", "edit src/sync/status.ts", "bash bun test src/sync"],
		vm: { state: "paused", cpuCount: 2, memoryMB: 2048 },
		turns: [
			{ agoH: 312, runMin: 15, size: "m", prompt: "Review the offline sync queue for unhandled errors", summary: "Found six unhandled rejections in the queue workers; none can lose data" },
			{
				agoH: 262,
				runMin: 12,
				size: "m",
				prompt: "Fix the unhandled rejections you found",
				summary: "Wrapped the six workers so a failed call becomes a retry entry",
				result: { files: 4, insertions: 96, deletions: 31, push: "no" },
			},
			{ agoH: 226, runMin: 20, size: "l", prompt: "Add tests for every worker's failure path", summary: "Added 23 tests covering failed calls, 401s and a server that is down", result: { files: 7, insertions: 412, deletions: 8, push: "no" } },
			{ agoH: 190, runMin: 9, size: "s", prompt: "Show the retry count of each queued item", summary: "The sync screen now shows each item's retry count and last error" },
			{ agoH: 160, runMin: 17, size: "l", prompt: "Show the pending conflict in the sync screen", summary: "Items waiting on a conflict now show the conflicting field", result: { files: 5, insertions: 164, deletions: 22, push: "no" } },
			{ agoH: 118, runMin: 13, size: "m", prompt: "Cache the account list for 30 seconds", summary: "Added a 30 s cache for the account list with a manual refresh" },
			{ agoH: 80, runMin: 10, size: "m", prompt: "Handle a server that is unreachable during a sync", summary: "Sync now backs off and keeps the last rows on screen", result: { files: 2, insertions: 58, deletions: 14, push: "no" } },
			{ agoH: 46, runMin: 8, size: "s", prompt: "Squash the review fixes into one commit and push", summary: "Squashed eleven commits into one and pushed the branch", result: { files: 12, insertions: 701, deletions: 94, push: "yes" } },
		],
	},
];

const THREADS: ThreadSpec[] = SHOWCASE ? SHOWCASE_THREADS : DEFAULT_THREADS;

// ---- helpers

const randomState = { value: 20261020 };

/** A deterministic uniform number in [0, 1): the same data on every run. */
function rand(): number {
	randomState.value = (randomState.value + 0x6d2b79f5) | 0;
	let t = Math.imul(randomState.value ^ (randomState.value >>> 15), 1 | randomState.value);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function between(low: number, high: number): number {
	return low + rand() * (high - low);
}

const SIZES = {
	s: { input: [8_000, 40_000], output: [1_000, 6_000] },
	m: { input: [40_000, 180_000], output: [6_000, 20_000] },
	l: { input: [180_000, 700_000], output: [20_000, 60_000] },
} as const;

function usageFor(model: string, size: TurnSpec["size"]): Usage {
	const rates = RATES[model] ?? RATES[DEFAULT_MODEL];
	if (rates === undefined) throw new Error("no default rates");
	const { input, output } = SIZES[size];
	const inputTokens = Math.round(between(input[0], input[1]));
	const outputTokens = Math.round(between(output[0], output[1]));
	const cacheReadTokens = Math.round(inputTokens * between(3, 9));
	const cacheWriteTokens = Math.round(inputTokens * between(0.2, 0.6));
	const cost = (inputTokens * rates.input + outputTokens * rates.output + cacheReadTokens * rates.cacheRead + cacheWriteTokens * rates.cacheWrite) / 1e6;
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost: Math.round(cost * 10_000) / 10_000 };
}

/** What a turn did, by size: model requests, tool calls and how many tokens it adds to the context. */
const WORK = {
	s: { requests: [3, 9], tools: [2, 8], growth: [6_000, 20_000] },
	m: { requests: [8, 22], tools: [6, 20], growth: [20_000, 60_000] },
	l: { requests: [20, 48], tools: [16, 40], growth: [50_000, 110_000] },
} as const;

interface TurnMetrics {
	requests: number;
	tools: number;
	/** The context at the end of the turn. */
	context: number;
}

/** A turn's requests and tools, and the context it ends with: it grows each turn, and omp compacts it near the window. */
function metricsFor(size: TurnSpec["size"], contextBefore: number, windowTokens: number): TurnMetrics {
	const work = WORK[size];
	const budget = windowTokens > 0 ? windowTokens : UNKNOWN_WINDOW_BUDGET;
	let context = contextBefore + Math.round(between(work.growth[0], work.growth[1]));
	if (context > 0.9 * budget) context = Math.round(budget * between(0.25, 0.4));
	return {
		requests: Math.round(between(work.requests[0], work.requests[1])),
		tools: Math.round(between(work.tools[0], work.tools[1])),
		context,
	};
}

/** The sandbox the fake vmon lists for a seeded VM record. */
interface FakeSandbox {
	sandboxId: string;
	threadId: string;
	state: "running" | "paused";
	startedAt: string;
	cpuCount: number;
	memoryMB: number;
}

/** The pairing and device records the seed leaves, to describe in the harness's output. */
interface SeedSummary {
	threads: number;
	devices: number;
	sandboxes: FakeSandbox[];
}

// ---- seeding

function seed(dataDir: string): SeedSummary {
	// The store reads this clock: every row is stamped with the instant the story says it happened.
	const clock = { ms: NOW };
	const store = Store.open({ dataDir, now: () => new Date(clock.ms) });
	try {
		const devices = seedDevices(store, clock);
		seedSettings(store, clock, devices[0]?.id ?? "");
		const sandboxes: FakeSandbox[] = [];
		for (const spec of THREADS) {
			const sandbox = seedThread(store, clock, spec, devices[0]?.id ?? "", devices[1]?.id ?? "");
			if (sandbox !== null) sandboxes.push(sandbox);
		}
		clock.ms = NOW;
		return { threads: THREADS.length, devices: devices.length, sandboxes };
	} finally {
		store.close();
	}
}

/** Pairs two devices through the store's own offer flow, leaves one request waiting for approval and one offer open. */
function seedDevices(store: Store, clock: { ms: number }): { id: string; name: string }[] {
	const paired: { id: string; name: string }[] = [];
	const people = [
		{ name: "macbook-pro", platform: "darwin", address: "192.168.1.42", agoH: 216, seenAgoMin: 12 },
		{ name: "work-laptop", platform: "linux", address: "10.20.4.18", agoH: 70, seenAgoMin: 190 },
	];
	for (const person of people) {
		clock.ms = NOW - person.agoH * HOUR;
		const offerId = randomBase64Url(9);
		const secret = randomBase64Url(16);
		store.createOffer({ id: offerId, owner: OWNER, secretSha256: sha256Hex(secret), ttlMs: 5 * MIN, maxOpen: 3 });
		const requestId = randomBase64Url(9);
		const requestSecret = randomBase64Url(16);
		store.redeemOffer({
			offerId,
			secretSha256: sha256Hex(secret),
			requestId,
			requestSecretSha256: sha256Hex(requestSecret),
			name: person.name,
			platform: person.platform,
			address: person.address,
		});
		clock.ms += 40_000;
		if (store.decideOffer(offerId, "approve") !== "done") throw new Error("seed: the pairing offer was not approved");
		clock.ms += 2000;
		const claimed = store.claimOffer(requestId, sha256Hex(requestSecret), { id: randomBase64Url(9), tokenSha256: sha256Hex(newDeviceToken()) });
		if (claimed.kind !== "created") throw new Error("seed: the pairing request did not create a device");
		paired.push(claimed.device);
		clock.ms = NOW - person.seenAgoMin * MIN;
		store.touchDevice(claimed.device.id, person.address, 0);
	}

	clock.ms = NOW - 2 * MIN;
	const waitingId = randomBase64Url(9);
	const waitingSecret = randomBase64Url(16);
	store.createOffer({ id: waitingId, owner: OWNER, secretSha256: sha256Hex(waitingSecret), ttlMs: 30 * MIN, maxOpen: 3 });
	store.redeemOffer({
		offerId: waitingId,
		secretSha256: sha256Hex(waitingSecret),
		requestId: randomBase64Url(9),
		requestSecretSha256: sha256Hex(randomBase64Url(16)),
		name: "pixel-tablet",
		platform: "android",
		address: "192.168.1.77",
	});
	clock.ms = NOW - MIN;
	store.createOffer({ id: randomBase64Url(9), owner: OWNER, secretSha256: sha256Hex(randomBase64Url(16)), ttlMs: 30 * MIN, maxOpen: 3 });
	return paired;
}

/** Settings changed over the last five days by the owner and a device, with a reset and an import. */
function seedSettings(store: Store, clock: { ms: number }, deviceId: string): void {
	const change = (agoH: number, actor: string, action: "set" | "import", changes: { key: string; value: unknown }[]): void => {
		clock.ms = NOW - agoH * HOUR;
		store.applySettings(
			changes.map(({ key, value }) => ({ key, value: value === null ? null : JSON.stringify(value) })),
			actor,
			action,
		);
	};
	change(120, OWNER, "set", [{ key: "git.push", value: "ask" }, { key: "git.branch", value: "omp-cloud/{thread}" }]);
	change(96, OWNER, "set", [{ key: "git.protected", value: ["main", "master", "release/*", "prod/*"] }]);
	change(70, deviceActor(deviceId), "set", [{ key: "policy.spend.turnUSD", value: 5 }]);
	change(50, OWNER, "set", [
		{ key: "policy.spend.dayUSD", value: 25 },
		{ key: "policy.egress", value: ["github.com", "*.githubusercontent.com", "registry.npmjs.org", "crates.io"] },
	]);
	change(30, OWNER, "set", [{ key: "git.push", value: "auto" }]);
	change(26, OWNER, "import", [
		{ key: "policy.models.allowed", value: ["anthropic/*", "openai/gpt-5.1-codex"] },
		{ key: "policy.tools.approval", value: { bash: "prompt", write: "allow", browser: "deny" } },
		{ key: "policy.bash.patterns", value: [{ match: "rm -rf *", approval: "deny" }, { match: "git push *", approval: "prompt" }] },
	]);
	change(20, OWNER, "set", [{ key: "policy.webSearch", value: false }]);
	change(6, OWNER, "set", [{ key: "policy.webSearch", value: null }]);
}

/** One thread through its whole story. Returns its sandbox when it has one. */
function seedThread(store: Store, clock: { ms: number }, spec: ThreadSpec, firstDevice: string, secondDevice: string): FakeSandbox | null {
	const id = store.newThreadId();
	const sandboxId = `i${Bun.randomUUIDv7().replace(/-/g, "").slice(0, 19)}`;
	const pid = Math.round(between(2000, 9000));
	const contextWindow = WINDOWS[spec.model] ?? 0;
	let context = 0;
	let previousEnd = 0;
	let firstStartedAt = 0;
	let lastActivity = 0;

	for (const [index, turn] of spec.turns.entries()) {
		const turnId = index + 1;
		const last = index === spec.turns.length - 1;
		const open = last ? spec.open : undefined;
		const queuedAt = Math.max(NOW - turn.agoH * HOUR, previousEnd + MIN);
		clock.ms = queuedAt;
		if (index === 0) {
			store.createThread(id, {
				owner: OWNER,
				name: spec.name ?? "",
				title: turn.prompt.slice(0, 80),
				prompt: turn.prompt,
				model: spec.model,
				thinking: spec.thinking,
				repo: {
					name: spec.repo.name,
					remoteURL: spec.repo.remoteURL,
					baseRef: spec.repo.baseRef,
					baseCommit: sha256Hex(`${spec.repo.name}:base`).slice(0, 40),
					handoffCommit: sha256Hex(`${spec.repo.name}:${id}:handoff`).slice(0, 40),
					localBranch: spec.repo.localBranch,
				},
				paths: { home: SEED_HOME, workspace: spec.repo.workspace },
				author: AUTHOR,
				secretFiles: spec.secretFiles ?? [],
				secretEnv: spec.secretEnv ?? [],
				configOverlays: [],
				ompVersion: "18.12.2",
				policy: spec.policy ?? {},
				...(spec.fromDevice === true ? { sentBy: deviceActor(firstDevice) } : {}),
			});
		} else {
			store.enqueueTurn(id, turn.prompt, OWNER);
		}
		previousEnd = queuedAt;
		lastActivity = queuedAt;
		if (open === "queued") break;

		const startedAt = queuedAt + Math.round(between(8, 40)) * 1000;
		if (index === 0) firstStartedAt = startedAt;
		const finishesAt = open === undefined ? startedAt + turn.runMin * MIN : open === "running" && spec.failure !== undefined ? startedAt + spec.failure.afterMin * MIN : NOW;
		clock.ms = startedAt;
		store.startNextTurn(id);
		store.markPromptSent(id, turnId);

		const progress: { kind: string; text: string }[] = [];
		if (index === 0 && spec.vm !== undefined) {
			progress.push({ kind: "vm", text: `sandbox ${sandboxId} created` }, { kind: "vm", text: `omp started (pid ${pid})` });
		}
		for (let k = 0; k < Math.min(4, spec.tools.length); k++) {
			const tool = spec.tools[(index + k) % spec.tools.length] ?? "";
			progress.push(tool.startsWith("!") ? { kind: "tool_error", text: tool.slice(1) } : { kind: "tool", text: tool });
		}
		if (turn.summary !== "") progress.push({ kind: "assistant", text: turn.summary });
		else if (turn.note !== undefined) progress.push({ kind: "assistant", text: turn.note });
		const emitFrom = (from: number, to: number): void => {
			for (let n = from; n < to; n++) {
				clock.ms = Math.max(clock.ms, startedAt + ((n + 1) / (progress.length + 2)) * (finishesAt - startedAt));
				const event = progress[n];
				if (event !== undefined) store.appendEvent(id, event.kind, event.text, turnId);
			}
		};

		const questions = turn.questions ?? [];
		const middle = Math.ceil(progress.length / 2);
		emitFrom(0, middle);
		if (questions.length > 0) {
			clock.ms = startedAt + 0.5 * (finishesAt - startedAt);
			const inputs: QuestionInput[] = questions.map(q => ({
				key: q.key,
				text: q.text,
				header: q.header,
				options: q.options.map(([label, description]) => ({ label, description })),
				multi: q.multi,
				recommended: q.recommended,
				ompKey: q.key,
				ompLabels: q.options.map(([label]) => label),
			}));
			const { questions: asked } = store.askQuestions(id, turnId, inputs, `req-${id}-${turnId}`);
			for (const [q, asking] of questions.entries()) {
				const picked = asking.answer;
				const question = asked[q];
				if (picked === undefined || question === undefined) continue;
				clock.ms += Math.min(90_000, (finishesAt - clock.ms) / 2);
				store.answerQuestion(id, turnId, question.id, picked, "", index === 1 && spec.fromDevice === true ? deviceActor(secondDevice) : OWNER);
			}
		}
		emitFrom(middle, progress.length);

		if (turn.stopped === true) {
			clock.ms = Math.max(clock.ms, startedAt + 0.55 * (finishesAt - startedAt));
			store.stopThread(id, OWNER);
		}
		lastActivity = finishesAt;
		previousEnd = finishesAt;
		if (open === "running" || open === "asking") {
			// The runner stores omp's context on every poll, so a turn in flight has reported one.
			const flight = metricsFor("s", context, contextWindow);
			store.setThreadContext(id, { tokens: flight.context, window: contextWindow, at: new Date(Math.min(NOW, finishesAt) - 20_000).toISOString() });
			if (spec.failure !== undefined) {
				clock.ms = finishesAt;
				store.failThread(id, spec.failure.error);
			}
			break;
		}

		clock.ms = finishesAt;
		const metrics = metricsFor(turn.size, context, contextWindow);
		context = metrics.context;
		store.completeTurn(id, turnId, resultOf(id, spec.model, turn, metrics, contextWindow));
		// An omp that could not be reached (the turn errored) reported no context.
		if (turn.error === undefined) {
			store.setThreadContext(id, { tokens: context, window: contextWindow, at: new Date(finishesAt).toISOString() });
		}
		if (turn.result?.push === "yes") {
			clock.ms = finishesAt + 1000;
			store.appendEvent(id, "push", `pushed omp-cloud/${id}`, turnId);
		}
	}

	if (spec.archived === true) {
		const archivedAt = Math.min(NOW, lastActivity + ARCHIVE_AFTER_MS);
		clock.ms = archivedAt;
		store.appendEvent(id, "vm", "archived after 7 days idle; the next message restores it", null);
		store.markArchived(id, new Date(archivedAt).toISOString(), "");
	}

	if (spec.vm === undefined) return null;
	clock.ms = Math.min(NOW, lastActivity + (spec.vm.state === "paused" ? 10 * MIN : 0));
	store.putVm({ threadId: id, sandboxId, state: spec.vm.state, pid, sessionFile: `/home/user/.omp/agent/sessions/${id}.jsonl` });
	return {
		sandboxId,
		threadId: id,
		state: spec.vm.state,
		startedAt: new Date(firstStartedAt).toISOString(),
		cpuCount: spec.vm.cpuCount,
		memoryMB: spec.vm.memoryMB,
	};
}

function resultOf(threadId: string, model: string, turn: TurnSpec, metrics: TurnMetrics, contextWindow: number): TurnResult {
	const failed = turn.error !== undefined || turn.stopped === true;
	const result = turn.result;
	const pushed = result?.push === "yes";
	const reply =
		turn.reply ??
		(result === undefined
			? turn.summary
			: `${turn.summary}\n\n- ${result.files} file${result.files === 1 ? "" : "s"} changed, +${result.insertions} -${result.deletions}\n- bun test and tsc --noEmit pass`);
	return {
		outcome: failed ? "failed" : "completed",
		error: turn.error ?? "",
		reply,
		usage: usageFor(model, turn.size),
		requests: metrics.requests,
		tools: metrics.tools,
		context: turn.error === undefined ? { tokens: metrics.context, window: contextWindow } : null,
		head: result === undefined ? "" : sha256Hex(`${threadId}:${turn.prompt}`).slice(0, 40),
		filesChanged: result?.files ?? 0,
		insertions: result?.insertions ?? 0,
		deletions: result?.deletions ?? 0,
		pushed,
		pushError: result?.push === "rejected" ? "remote: error: GH006: Protected branch update failed for refs/heads/omp-cloud" : "",
		pushRef: pushed ? `omp-cloud/${threadId}` : "",
	};
}

// ---- fake vmon and gateway

/** The slice of vmon's e2b-compatible API that `Vmon.list` and `Vmon.metrics` call: the sandbox list and per-sandbox metrics. */
function startFakeVmon(sandboxes: FakeSandbox[]): Bun.Server<undefined> {
	const notFound = (): Response => Response.json({ code: 404, message: "not found" }, { status: 404 });
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const { pathname } = new URL(req.url);
			if (req.method !== "GET") return notFound();
			if (pathname === "/v2/sandboxes") {
				return Response.json(
					sandboxes.map(sandbox => ({
						sandboxID: sandbox.sandboxId,
						templateID: "omp-agent",
						startedAt: sandbox.startedAt,
						endAt: new Date(NOW + HOUR).toISOString(),
						state: sandbox.state,
						cpuCount: sandbox.cpuCount,
						memoryMB: sandbox.memoryMB,
						envdVersion: "0.2.4",
						metadata: { app: "omp-cloud", thread: sandbox.threadId },
					})),
				);
			}
			const match = /^\/sandboxes\/([^/]+)\/metrics$/.exec(pathname);
			if (match === null) return notFound();
			const sandbox = sandboxes.find(candidate => candidate.sandboxId === match[1]);
			if (sandbox === undefined) return notFound();
			if (sandbox.state !== "running") return Response.json([]);
			const memTotal = sandbox.memoryMB * 1024 * 1024;
			const at = new Date();
			return Response.json([
				{
					timestamp: at.toISOString(),
					timestampUnix: Math.floor(at.getTime() / 1000),
					cpuUsedPct: Math.round(between(8, 72) * 10) / 10,
					cpuCount: sandbox.cpuCount,
					memUsed: Math.round(memTotal * between(0.28, 0.66)),
					memTotal,
					memCache: Math.round(memTotal * 0.1),
					diskUsed: Math.round(between(2.5, 6.5) * 1024 ** 3),
					diskTotal: 20 * 1024 ** 3,
				},
			]);
		},
	});
}

/** `GET /v1/models`, the one call the service makes of the omp gateway at start. */
function startFakeGateway(): Bun.Server<undefined> {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			if (req.method === "GET" && new URL(req.url).pathname === "/v1/models") {
				return Response.json({ object: "list", data: GATEWAY_MODELS.map(id => ({ id, object: "model" })) });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
}
// ---- the scripted update

/** The states the harness can put the service's own update in, without a feed, a managed install or a restart. */
const UPDATE_STATES = ["idle", "checking", "downloading", "ready", "applying", "failed", "unsupported", "updated"] as const;
type ScriptedState = (typeof UPDATE_STATES)[number];

/** The steps an apply goes through, in the order the updater records them. */
const APPLY_STEPS = ["starting", "backup", "vmon", "omp", "swap", "health"] as const;
const STEP_MS = 2500;
const CHECK_MS = 1500;
const MODES: readonly UpdateMode[] = ["off", "notify", "auto"];
const CHECKOUT_MESSAGE = "this omp-cloud runs from a git checkout; update it with git pull and restart it";
// Shaped like the feed's notes.md: the CHANGELOG section, so the modals exercise bold titles, code, links and long bullets.
const RELEASE_NOTES = [
	"## 0.5.1",
	"",
	"- **Updates from the dashboard.** The dashboard and the omp plugin show when an update is ready and restart to it on one click; `update.mode` `auto` installs by itself when that needs no downtime. See [Updating](https://github.com/TechDufus/omp-cloud/blob/main/docs/updating.md).",
	"- **Short thread names.** Threads get short names and release their VM after a week idle; the next message restores them. Needs `git.push` `ask` or `auto`.",
	"- **vibemon is pinned per release.** This one needs v0.4.1 and the *root helper*; a line that wraps onto",
	"  a second source line stays one bullet.",
	"- A plain bullet without a title, with an unsafe [link](javascript:alert(1)) shown as text.",
].join("\n");
const FIRST_NOTES = "## 0.5.0\n\n- First release with a managed install.";

/**
 * A stand-in for `GET /api/v1/update` and its actions: a state machine the harness answers the dashboard from, since
 * the service here runs from a checkout (no managed install, no feed) and could only ever say `unsupported`. Typed
 * with the client's own `UpdateStatus`, so the dashboard sees the contract's shape.
 */
class UpdateScript {
	state: ScriptedState = "ready";
	mode: UpdateMode = "notify";
	/** The next apply fails at the health check and rolls back. */
	failApply = false;
	#step = 0;
	#startedAt = NOW;
	#checkedAt = NOW - 12 * MIN;
	#timer: Timer | undefined;

	status(): UpdateStatus {
		const updated = this.state === "updated";
		const failed = this.state === "failed";
		/** A release newer than the running one is known. */
		const newer = this.state === "ready" || this.state === "downloading" || this.state === "applying" || failed || this.state === "checking";
		const published = updated || newer;
		const vmonRunning = updated ? "v0.4.1" : "v0.4.0";
		return {
			mode: this.mode,
			managed: this.state !== "unsupported",
			state: this.state === "updated" ? "idle" : this.state,
			current: {
				version: updated ? "0.5.1" : "0.5.0",
				build: {
					id: updated ? "20261021-140000-7c1e9ab" : "20261021-100000-3f2a8d1",
					commit: updated ? "7c1e9ab" : "3f2a8d1",
					createdAt: new Date(NOW - (updated ? 3 : 26) * HOUR).toISOString(),
				},
			},
			latest: this.state === "unsupported" ? null : { version: published ? "0.5.1" : "0.5.0", notes: published ? RELEASE_NOTES : FIRST_NOTES, publishedAt: new Date(NOW - (published ? 3 : 26) * HOUR).toISOString() },
			staged: this.state === "ready" || this.state === "applying" || failed ? "0.5.1" : null,
			applying:
				this.state === "applying" ? { version: "0.5.1", step: APPLY_STEPS[this.#step] ?? "rollback", startedAt: new Date(this.#startedAt).toISOString() } : null,
			error: failed ? "health check failed: GET /api/v1/health did not report 0.5.1 within 60 s" : null,
			message: this.state === "unsupported" ? CHECKOUT_MESSAGE : null,
			checkedAt: new Date(this.#checkedAt).toISOString(),
			last: updated
				? { version: "0.5.1", notes: RELEASE_NOTES, at: new Date(NOW - 2 * MIN).toISOString(), result: "installed", message: "" }
				: failed
					? { version: "0.5.1", notes: RELEASE_NOTES, at: new Date(NOW - MIN).toISOString(), result: "failed", message: "rolled back to 0.5.0: health check failed" }
					: null,
			components: {
				vmon: { installed: vmonRunning, required: newer ? "v0.4.1" : vmonRunning, helper: true },
				// The gateway still runs the previous omp until an update restarts it.
				omp: { host: "18.12.4", broker: "18.12.4", gateway: updated || this.state === "idle" ? "18.12.4" : "18.12.3" },
			},
		};
	}

	/** The state a harness command or a click moves to; applying runs its own steps. */
	set(state: ScriptedState): void {
		clearTimeout(this.#timer);
		this.state = state;
		if (state === "applying") this.#startApply();
		else if (state === "checking") this.#timer = setTimeout(() => this.set("idle"), CHECK_MS);
		else if (state === "idle") this.#checkedAt = Date.now();
	}

	check(): void {
		if (this.state === "idle" || this.state === "failed") this.set("checking");
	}

	/** `POST /update/apply`: null when it starts, else the reason the service would refuse with (409). */
	apply(): string | null {
		if (this.state === "applying") return "an update is already being applied";
		if (this.state === "unsupported") return CHECKOUT_MESSAGE;
		if (this.state !== "ready" && this.state !== "failed") return "no update is ready";
		this.set("applying");
		return null;
	}

	#startApply(): void {
		this.#step = 0;
		this.#startedAt = Date.now();
		const advance = (): void => {
			this.#step++;
			if (this.#step < APPLY_STEPS.length) {
				this.#timer = setTimeout(advance, STEP_MS);
			} else if (this.failApply && this.#step === APPLY_STEPS.length) {
				// One more step: the rollback, then the failure.
				this.#timer = setTimeout(advance, STEP_MS);
			} else {
				this.state = this.failApply ? "failed" : "updated";
				this.failApply = false;
			}
		};
		this.#timer = setTimeout(advance, STEP_MS);
	}

	/** A console command: a state name, `fail` (the next apply fails), or a mode. Returns what to print, or null when it is none of these. */
	command(text: string): string | null {
		const state = UPDATE_STATES.find(candidate => candidate === text);
		if (state !== undefined) {
			this.set(state);
			return `update state: ${state}`;
		}
		if (text === "fail") {
			this.failApply = !this.failApply;
			return `the next apply ${this.failApply ? "fails at the health check and rolls back" : "succeeds"}`;
		}
		return null;
	}
}

/**
 * The address people open: forwards everything to the dashboard listener except the update routes, which `update`
 * answers, and `POST /__dev/update?state=<state>` (the harness's own switch, for scripts). The upstream sees its own
 * host and origin, which its guard requires.
 */
function startFront(backPort: number, update: UpdateScript): Bun.Server<undefined> {
	const backOrigin = `http://127.0.0.1:${backPort}`;
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/__dev/update" && req.method === "POST") {
				const message = update.command(url.searchParams.get("state") ?? url.searchParams.get("command") ?? "");
				return message === null ? Response.json({ error: `unknown state; use one of ${UPDATE_STATES.join(", ")} or fail` }, { status: 400 }) : Response.json({ message });
			}
			if (url.pathname === "/api/v1/update" && req.method === "GET") return Response.json(update.status());
			if (url.pathname === "/api/v1/update/check" && req.method === "POST") {
				update.check();
				return new Response(null, { status: 202 });
			}
			if (url.pathname === "/api/v1/update/apply" && req.method === "POST") {
				const refusal = update.apply();
				return refusal === null ? Response.json({ applying: { version: "0.5.1" } }, { status: 202 }) : Response.json({ error: refusal }, { status: 409 });
			}
			if (url.pathname === "/api/v1/settings" && req.method === "PUT") {
				const body: unknown = await req.clone().json().catch(() => null);
				const changes = isRecord(body) && isRecord(body.settings) ? body.settings : null;
				const mode = changes === null ? undefined : changes["update.mode"];
				const chosen = MODES.find(candidate => candidate === mode);
				if (changes !== null && Object.keys(changes).length === 1 && chosen !== undefined) {
					update.mode = chosen;
					return Response.json({ settings: [] });
				}
			}
			const target = new URL(`${url.pathname}${url.search}`, backOrigin);
			const headers = new Headers(req.headers);
			headers.delete("host");
			if (headers.has("origin")) headers.set("origin", backOrigin);
			const upstream = await fetch(target, { method: req.method, headers, body: req.body, redirect: "manual", signal: req.signal });
			const answer = new Headers(upstream.headers);
			// fetch already decoded the body: the encoding and length headers no longer describe it.
			answer.delete("content-encoding");
			answer.delete("content-length");
			return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: answer });
		},
	});
}

// ---- the service

/** A loopback port that was free a moment ago. */
function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const { port } = probe;
	void probe.stop(true);
	if (port === undefined) throw new Error("no free port");
	return port;
}

function portOf(server: Bun.Server<undefined>): number {
	if (server.port === undefined) throw new Error("a listener has no port");
	return server.port;
}

/** Prints each line of `stream` with `prefix` and hands it to `onLine`. */
async function forward(stream: ReadableStream<Uint8Array>, prefix: string, onLine: (line: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	for await (const chunk of stream) {
		pending += decoder.decode(chunk, { stream: true });
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			console.log(`${prefix}${line}`);
			onLine(line);
		}
	}
}

async function mintLink(apiUrl: string, token: string): Promise<{ url: string; expiresAt: string }> {
	const response = await fetch(`${apiUrl}/api/v1/dashboard/links`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
	if (response.status !== 201) throw new Error(`minting a sign-in link failed: status ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || typeof body.url !== "string" || typeof body.expiresAt !== "string") throw new Error("minting a sign-in link returned an unexpected body");
	return { url: body.url, expiresAt: body.expiresAt };
}

/**
 * The scripted update when asked for: `--update` (starting `ready`), `--update=<state>` or `OMP_CLOUD_DASHBOARD_DEV_UPDATE=<state>`.
 * Without either the harness is as it was and the dashboard shows whatever the service answers on `/api/v1/update`.
 */
function scriptedUpdate(): UpdateScript | null {
	const flag = process.argv.find(arg => arg === "--update" || arg.startsWith("--update="));
	const requested = flag === undefined ? process.env.OMP_CLOUD_DASHBOARD_DEV_UPDATE : flag === "--update" ? "ready" : flag.slice("--update=".length);
	if (requested === undefined || requested === "") return null;
	const state = UPDATE_STATES.find(candidate => candidate === requested);
	if (state === undefined) throw new Error(`--update: unknown state "${requested}"; use one of ${UPDATE_STATES.join(", ")}`);
	const script = new UpdateScript();
	script.set(state);
	return script;
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "omp-cloud-dashboard-dev-"));
	const cleanups: (() => void | Promise<void>)[] = [() => rmSync(root, { recursive: true, force: true })];
	let stopping: Promise<void> | undefined;
	const stop = (code: number): Promise<void> => {
		stopping ??= (async () => {
			for (const cleanup of cleanups.reverse()) {
				try {
					await cleanup();
				} catch (error) {
					console.error(`dashboard-dev: cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			process.exit(code);
		})();
		return stopping;
	};
	process.on("SIGINT", () => void stop(0));
	process.on("SIGTERM", () => void stop(0));

	try {
		const dataDir = join(root, "data");
		console.log("dashboard-dev: seeding the store");
		const summary = seed(dataDir);

		const vmon = startFakeVmon(summary.sandboxes);
		cleanups.push(() => vmon.stop(true));
		const gateway = startFakeGateway();
		cleanups.push(() => gateway.stop(true));

		const token = randomBase64Url(32);
		const tokenFile = join(root, "owner.token");
		writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
		const vmonKeyFile = join(root, "vmon.key");
		writeFileSync(vmonKeyFile, "dashboard-dev-key\n", { mode: 0o600 });

		const apiPort = freePort();
		const dashboardPort = freePort();
		const apiUrl = `http://127.0.0.1:${apiPort}`;
		const update = scriptedUpdate();
		const front = update === null ? null : startFront(dashboardPort, update);
		if (front !== null) cleanups.push(() => front.stop(true));
		const configFile = join(root, "service.json");
		writeFileSync(
			configFile,
			JSON.stringify({
				listen: `127.0.0.1:${apiPort}`,
				apiTokenSha256: tokenSha256(token),
				dataDir,
				vmon: { url: `http://127.0.0.1:${portOf(vmon)}`, keyFile: vmonKeyFile, template: "omp-agent" },
				gateway: { url: `http://127.0.0.1:${portOf(gateway)}`, clientsFile: join(root, "clients.json") },
				broker: { url: "http://127.0.0.1:9", tokenFile: join(root, "broker.token") },
				models: { default: DEFAULT_MODEL },
				runner: { enabled: false },
				dashboard: { listen: `127.0.0.1:${dashboardPort}` },
			}),
			{ mode: 0o600 },
		);

		const service = Bun.spawn([process.execPath, "run", SHOWCASE ? "scripts/showcase/service.ts" : "src/main.ts", "--config", configFile], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OMP_CLOUD_CONFIG: configFile },
		});
		cleanups.push(async () => {
			if (service.exitCode !== null) return;
			service.kill("SIGTERM");
			const exited = await Promise.race([service.exited, Bun.sleep(5000).then(() => null)]);
			if (exited === null) service.kill("SIGKILL");
		});

		let listening: () => void = () => {};
		const ready = new Promise<void>(resolveReady => {
			listening = resolveReady;
		});
		const onLine = (line: string): void => {
			if (line.startsWith("omp-cloud listening on")) listening();
		};
		void forward(service.stdout, "[service] ", onLine);
		void forward(service.stderr, "[service] ", onLine);
		void service.exited.then(code => {
			if (stopping !== undefined) return;
			console.error(`dashboard-dev: the service exited (${code})`);
			void stop(1);
		});

		let startTimer: Timer | undefined;
		const startTimeout = new Promise<never>((_, reject) => {
			startTimer = setTimeout(() => reject(new Error(`the service did not start within ${READY_TIMEOUT_MS / 1000} s`)), READY_TIMEOUT_MS);
		});
		await Promise.race([ready, startTimeout]);
		clearTimeout(startTimer);

		/** The sign-in link, on the front listener's address when the update is scripted. */
		const signInLink = async (): Promise<{ url: string; expiresAt: string }> => {
			const minted = await mintLink(apiUrl, token);
			if (front === null) return minted;
			const url = new URL(minted.url);
			url.port = String(portOf(front));
			return { url: url.href, expiresAt: minted.expiresAt };
		};
		const link = await signInLink();
		const updateNote =
			update === null || front === null
				? ""
				: `  update:      scripted, starting as "${update.state}": type ${UPDATE_STATES.join(" | ")} to switch, fail to make the next apply fail and roll back;
               or POST ${new URL("/__dev/update?state=ready", link.url).href}
`;
		console.log(`
omp-cloud dashboard dev harness
  seeded:      ${summary.threads} threads, ${summary.devices} paired devices, ${summary.sandboxes.length} VMs (${summary.sandboxes.filter(s => s.state === "running").length} running)
  sign-in:     ${link.url}
               valid until ${link.expiresAt}, once; press Enter for a new link
${updateNote}  API:         ${apiUrl}
  owner token: ${tokenFile} (mode 0600)
  data:        ${root} (removed on exit)

Ctrl+C stops the service and deletes everything.`);

		for await (const line of console) {
			const command = line.trim();
			const message = command === "" || update === null ? null : update.command(command);
			if (command !== "" && message === null) {
				console.log(update === null ? "  the update is not scripted; start with --update[=state]" : `  unknown command; use one of ${UPDATE_STATES.join(", ")}, fail, or Enter for a new link`);
			} else if (message !== null) {
				console.log(`  ${message}`);
			} else {
				const next = await signInLink();
				console.log(`  sign-in:     ${next.url}\n               valid until ${next.expiresAt}, once`);
			}
		}
	} catch (error) {
		console.error(`dashboard-dev: ${error instanceof Error ? error.message : String(error)}`);
		await stop(1);
	}
}

await main();
