/**
 * The showcase data set: six threads over three repositories, one story for every README image (the dashboard, the omp
 * job tiles and question card, Tern's tray). Invented names and repositories only. The dashboard harness reads it
 * under `--showcase` (`mise run dashboard:dev -- --showcase`); the capture scripts in this directory start that.
 *
 * Costs stay in the single-digit dollars per thread, models are ones the harness knows the window of (so every thread
 * has a context bar), and there is one thread in each of the phases the images show: working, waiting, idle, archived.
 */
import type { QuestionSpec, RepoSpec, ThreadSpec } from "../dashboard-dev";

export const SHOWCASE_AUTHOR = { name: "Ada Chen", email: "ada@example.com" };
export const SHOWCASE_HOME = "/home/ada";

const SONNET = "anthropic/claude-sonnet-4-6";
const OPUS = "anthropic/claude-opus-5-5";
const HAIKU = "anthropic/claude-haiku-4-5";

export const SHOWCASE_REPOS = {
	orbit: {
		name: "orbit-api",
		remoteURL: "https://github.com/northwind/orbit-api.git",
		baseRef: "main",
		localBranch: "main",
		workspace: `${SHOWCASE_HOME}/dev/orbit-api`,
	},
	storefront: {
		name: "storefront",
		remoteURL: "https://github.com/northwind/storefront.git",
		baseRef: "main",
		localBranch: "main",
		workspace: `${SHOWCASE_HOME}/dev/storefront`,
	},
	infra: {
		name: "platform-infra",
		remoteURL: "https://github.com/northwind/platform-infra.git",
		baseRef: "main",
		localBranch: "main",
		workspace: `${SHOWCASE_HOME}/dev/platform-infra`,
	},
} satisfies Record<string, RepoSpec>;

/** The repository omp runs in while staging: the tiles group this one first, as "this repo". */
export const SHOWCASE_LOCAL_REPO: RepoSpec = SHOWCASE_REPOS.orbit;

/** The thread that waits on two questions: the one a bell entry is staged on. */
export const SHOWCASE_WAITING_NAME = "Webhook retry backoff";
/** The thread whose running turn finishes while the omp pane is in the background. */
export const SHOWCASE_FINISHING_NAME = "Add rate limiting to the API";

export const SHOWCASE_THREADS: ThreadSpec[] = [
	{
		repo: SHOWCASE_REPOS.orbit,
		name: SHOWCASE_FINISHING_NAME,
		model: SONNET,
		thinking: "high",
		tools: ["read src/middleware/limiter.ts", "edit src/middleware/limiter.ts", "bash bun test src/middleware", "grep RateLimit"],
		open: "running",
		vm: { state: "running", cpuCount: 2, memoryMB: 4096 },
		turns: [
			{ agoH: 180, runMin: 6, size: "s", prompt: "Survey the public endpoints and propose a limit for each", summary: "Listed 23 endpoints in four tiers and proposed per-key limits for each" },
			{
				agoH: 26,
				runMin: 12,
				size: "l",
				prompt: "Add per-key rate limiting to the public API",
				summary: "Added a sliding-window limiter middleware keyed by API key, with a 429 and Retry-After header",
				result: { files: 7, insertions: 264, deletions: 18, push: "yes" },
			},
			{
				agoH: 3,
				runMin: 8,
				size: "s",
				prompt: "Cover the limiter with tests, including the Retry-After header",
				summary: "Added eleven limiter tests; the window boundary case found an off-by-one, now fixed",
				result: { files: 3, insertions: 142, deletions: 6, push: "yes" },
			},
			{
				agoH: 0.1,
				runMin: 0,
				size: "m",
				prompt: "Move the counters to Redis so the limits hold across instances",
				summary: "",
				note: "Reading the limiter middleware before wiring the Redis sliding-window counter",
			},
		],
	},
	{
		repo: SHOWCASE_REPOS.orbit,
		name: SHOWCASE_WAITING_NAME,
		model: OPUS,
		thinking: "high",
		tools: ["read src/webhooks/dispatch.ts", "edit src/webhooks/retry.ts", "bash bun test src/webhooks", "grep maxAttempts"],
		open: "asking",
		vm: { state: "running", cpuCount: 4, memoryMB: 4096 },
		turns: [
			{ agoH: 150, runMin: 5, size: "s", prompt: "Map every code path that sends a webhook", summary: "Found three senders; only the dispatcher retries, the other two fire once" },
			{
				agoH: 5,
				runMin: 9,
				size: "m",
				prompt: "Audit how webhook deliveries are retried",
				summary: "Deliveries retry immediately three times, which hammers a struggling endpoint; the schedule lives in one place",
				result: { files: 1, insertions: 12, deletions: 3, push: "no" },
			},
			{
				agoH: 0.08,
				runMin: 0,
				size: "m",
				prompt: "Retry failed webhook deliveries with backoff, then give up cleanly",
				summary: "",
				questions: [
					{
						key: "schedule",
						header: "Backoff",
						text: "Which backoff schedule should webhook retries use?",
						options: [
							["Exponential with jitter", "1 s, 2 s, 4 s … capped at 5 min, each with up to 25% jitter"],
							["Fixed 30 s", "Simple and predictable; may pile up on a long outage"],
							["Linear", "30 s, 60 s, 90 s … capped at 5 min"],
						],
						multi: false,
						recommended: 0,
					},
				],
			},
		],
	},
	{
		repo: SHOWCASE_REPOS.orbit,
		name: "Paginate the audit log endpoint",
		model: HAIKU,
		thinking: "medium",
		tools: ["read src/routes/audit.ts", "edit src/routes/audit.ts", "bash bun test src/routes", "bash bun run typecheck"],
		vm: { state: "paused", cpuCount: 2, memoryMB: 2048 },
		turns: [
			{ agoH: 330, runMin: 11, size: "m", prompt: "Survey how the audit log is queried today", summary: "Four callers read it, all with an unbounded offset; the busiest scans 40k rows" },
			{
				agoH: 21,
				runMin: 7,
				size: "m",
				prompt: "Paginate GET /audit with a cursor and a limit parameter",
				summary: "Added cursor pagination with a 100-row cap; the response carries next_cursor",
				result: { files: 4, insertions: 156, deletions: 31, push: "yes" },
			},
		],
	},
	{
		repo: SHOWCASE_REPOS.orbit,
		name: "Upgrade the Postgres driver",
		model: SONNET,
		thinking: "medium",
		tools: ["read package.json", "bash bun update pg", "bash bun test", "edit src/db/pool.ts"],
		vm: { state: "paused", cpuCount: 2, memoryMB: 2048 },
		turns: [
			{ agoH: 500, runMin: 14, size: "m", prompt: "List every query that uses driver-specific APIs", summary: "Eleven queries use `pg` internals; nine are mechanical to port" },
			{
				agoH: 98,
				runMin: 15,
				size: "l",
				prompt: "Upgrade the Postgres driver to 9.x and fix what breaks",
				summary: "Upgraded the driver; the pool now takes `max` instead of `poolSize`, and two queries needed explicit casts",
				result: { files: 6, insertions: 87, deletions: 64, push: "yes" },
			},
		],
	},
	{
		repo: SHOWCASE_REPOS.storefront,
		name: "Fix the flaky checkout test",
		model: SONNET,
		thinking: "medium",
		tools: ["read tests/checkout.spec.ts", "bash bun test tests/checkout.spec.ts", "!bash bun test tests/checkout.spec.ts: 1 fail", "edit tests/checkout.spec.ts"],
		vm: { state: "paused", cpuCount: 2, memoryMB: 2048 },
		turns: [
			{ agoH: 410, runMin: 16, size: "m", prompt: "Reproduce the flaky checkout test locally and capture a failing trace", summary: "Reproduced it in one run of thirty; the failing trace points at the cart debounce" },
			{
				agoH: 58,
				runMin: 18,
				size: "m",
				prompt: "Find and fix the flaky checkout test",
				summary: "The test raced the cart's debounce; it now waits for the order summary instead of sleeping",
				result: { files: 2, insertions: 24, deletions: 9, push: "yes" },
			},
			{
				agoH: 56,
				runMin: 6,
				size: "s",
				prompt: "Run it fifty times in a loop to be sure",
				summary: "Fifty consecutive runs pass; no other test in the file shares the timing assumption",
			},
		],
	},
	{
		repo: SHOWCASE_REPOS.infra,
		name: "Rotate the staging certificates",
		model: HAIKU,
		thinking: "low",
		tools: ["read modules/tls/main.tf", "edit modules/tls/main.tf", "bash terraform validate", "bash terraform plan"],
		archived: true,
		turns: [
			{ agoH: 300, runMin: 8, size: "s", prompt: "Inventory the staging certificates and their expiry dates", summary: "Two certificates expire within a month; the wildcard is the one nearer expiry" },
			{
				agoH: 240,
				runMin: 13,
				size: "s",
				prompt: "Rotate the staging certificates and shorten their lifetime to 60 days",
				summary: "Rotated both staging certificates and set the lifetime to 60 days; the plan shows no other change",
				result: { files: 3, insertions: 21, deletions: 11, push: "yes" },
			},
		],
	},
];

/** The first question's answer, given from the dashboard while the omp pane is in the background. */
export const SHOWCASE_FIRST_ANSWER = ["Exponential with jitter"];

/** The question the agent asks next, after that answer: it becomes the tray's "blocked" entry. */
export const SHOWCASE_SECOND_QUESTION: QuestionSpec = {
	key: "final",
	header: "Final failure",
	text: "What should happen after the last retry fails?",
	options: [
		["Dead-letter queue", "Keep the payload for replay from the admin API"],
		["Drop and alert", "Discard it and page the on-call"],
		["Email the owner", "Send the endpoint's owner a summary of what failed"],
	],
	multi: false,
	recommended: 0,
};

/** How the rate-limiting thread's running turn ends: the tray's "done" entry. */
export const SHOWCASE_FINISH = {
	reply: "Moved the limiter counters to Redis behind one Lua script, so the sliding window is atomic across instances. The suite passes against a local Redis.",
	files: 5,
	insertions: 212,
	deletions: 37,
};
