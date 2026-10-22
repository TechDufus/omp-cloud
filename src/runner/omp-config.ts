import { isRecord } from "../guards";
import { APPROVALS, type Approval, type BashPattern } from "../settings/registry";
import { VM_WORKSPACE } from "./vm-layout";

/**
 * The VM's `models.yml`: every provider the gateway serves routed to the gateway with the thread's client token (one
 * entry covers all of a provider's models: `baseUrl` the gateway, `auth: oauth`, `transport: pi-native`, the token as
 * `apiKey`), then the keyless `direct` providers as given. `gateway` must hold only providers the gateway
 * serves: it serves none without credentials in its vault and answers `Unknown model` for them, so a keyless provider
 * goes straight into the VM's file through `direct`.
 */
export function modelsYaml(input: {
	gatewayUrl: string;
	token: string;
	gateway: string[];
	direct: Record<string, Record<string, unknown>>;
}): string {
	const providers: Record<string, Record<string, unknown>> = {};
	for (const name of input.gateway) {
		providers[name] = { baseUrl: input.gatewayUrl, auth: "oauth", transport: "pi-native", apiKey: input.token };
	}
	Object.assign(providers, input.direct);
	return Bun.YAML.stringify({ providers }, null, 2);
}

/** One shipped config file as a mapping; empty when it is missing, unparseable or not a mapping. */
function parseConfig(configYaml: string | null): Record<string, unknown> {
	if (configYaml === null) return {};
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(configYaml);
	} catch {
		return {};
	}
	return isRecord(parsed) ? parsed : {};
}

/** The `modelRoles` of one shipped config file; empty when it is missing, unparseable or has none. */
function fileRoles(configYaml: string | null): Record<string, unknown> {
	const roles = parseConfig(configYaml).modelRoles;
	return isRecord(roles) ? roles : {};
}

/** The approval omp reads from `raw`: trimmed and lowercased, `undefined` for anything else (omp ignores those). */
function approvalOf(raw: unknown): Approval | undefined {
	const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return APPROVALS.find(choice => choice === value);
}

/** The usable `bash.patterns` rules of one shipped config file, in order: omp drops an entry without a match or a valid approval. */
function fileBashPatterns(configYaml: string | null): BashPattern[] {
	const bash = parseConfig(configYaml).bash;
	const patterns = isRecord(bash) && Array.isArray(bash.patterns) ? bash.patterns : [];
	const rules: BashPattern[] = [];
	for (const item of patterns) {
		if (!isRecord(item) || typeof item.match !== "string" || item.match === "") continue;
		const approval = approvalOf(item.approval);
		if (approval !== undefined) rules.push({ match: item.match, approval });
	}
	return rules;
}

/** The usable `tools.approval` entries of one shipped config file. */
function fileToolApproval(configYaml: string | null): Record<string, Approval> {
	const tools = parseConfig(configYaml).tools;
	const entries = isRecord(tools) && isRecord(tools.approval) ? Object.entries(tools.approval) : [];
	const approvals: Record<string, Approval> = {};
	for (const [tool, raw] of entries) {
		const approval = approvalOf(raw);
		if (approval !== undefined) approvals[tool] = approval;
	}
	return approvals;
}

/**
 * Bash commands no agent may run: the VM never pushes, never edits a remote and never opens a pull request, whatever the
 * owner's policy says (the service pushes, under the push policy). Globs see the literal command text with quotes
 * removed, so they are wide on purpose: they also match `echo git push`, which costs the agent one retry. Shell
 * variables dodge them, so they guard and the real boundaries are the missing git credentials and the egress policy. The
 * first rule that applies wins, so these come first.
 */
export const GIT_GUARD_PATTERNS: readonly BashPattern[] = [
	{ match: "*git*push*", approval: "deny" },
	{ match: "*git*send-pack*", approval: "deny" },
	{ match: "*git*remote add*", approval: "deny" },
	{ match: "*git*remote set-url*", approval: "deny" },
	{ match: "*git*remote set-head*", approval: "deny" },
	{ match: "*git*remote rename*", approval: "deny" },
	{ match: "*git*remote remove*", approval: "deny" },
	{ match: "*git*remote rm *", approval: "deny" },
	{ match: "*git*config*remote.*", approval: "deny" },
	{ match: "*git*config*url.*", approval: "deny" },
	{ match: "*gh pr create*", approval: "deny" },
	{ match: "*gh pr merge*", approval: "deny" },
	{ match: "*gh repo sync*", approval: "deny" },
	{ match: "*gh repo create*", approval: "deny" },
	{ match: "*gh release create*", approval: "deny" },
];

/** What a thread's effective policy (the owner's policy settings, tightened by the thread's) makes of a VM's omp configuration. */
export interface OverlayPolicy {
	/** `policy.bash.patterns`. */
	bashPatterns: readonly BashPattern[];
	/** `policy.tools.approval`. */
	toolApproval: Readonly<Record<string, Approval>>;
	/** `policy.fetch`, `policy.webSearch` and `policy.browser`: false turns the capability off. */
	fetch: boolean;
	webSearch: boolean;
	browser: boolean;
}

/**
 * The `--config` overlay. omp deep-merges `--config` files after `~/.omp/agent/config.yml` and project settings, so this wins over the user's settings. `configYamls` are the shipped `config.yml` and then
 * the session's overlays, in load order: omp deep-merges them in that order, so a role of a later file wins. Roles
 * of that merge whose provider is routable are kept as they are; every other role, and `default`, is the thread's
 * model. `thinking` (when set) wins over the shipped thinking level. The rest disables what needs a person or a desktop,
 * then applies the owner's policy: omp replaces arrays on a merge, so `bash.patterns` is written whole, the
 * {@link GIT_GUARD_PATTERNS}, then `policy.bash.patterns`, then the shipped files' rules in load order, and a shipped rule
 * can never shadow the guard or the policy; `tools.approval` is the shipped entries overridden by the policy's; a
 * disabled `fetch`, `web_search` or `browser` is switched off. `maskSecrets` turns on omp's secret obfuscation, which reads
 * the VM's `secrets.yml`.
 */
export function overlayConfigYaml(input: {
	model: string;
	thinking: string;
	configYamls: (string | null)[];
	routable: string[];
	policy: OverlayPolicy;
	maskSecrets: boolean;
}): string {
	const merged: Record<string, unknown> = {};
	for (const configYaml of input.configYamls) Object.assign(merged, fileRoles(configYaml));
	const roles: Record<string, unknown> = {};
	for (const [role, value] of Object.entries(merged)) {
		const provider = typeof value === "string" && value.includes("/") ? value.slice(0, value.indexOf("/")) : null;
		roles[role] = provider !== null && input.routable.includes(provider) ? value : input.model;
	}
	roles.default = input.model;

	const toolApproval: Record<string, Approval> = {};
	for (const configYaml of input.configYamls) Object.assign(toolApproval, fileToolApproval(configYaml));
	Object.assign(toolApproval, input.policy.toolApproval);

	const overlay: Record<string, unknown> = { modelRoles: roles };
	if (input.thinking !== "") overlay.defaultThinkingLevel = input.thinking;
	overlay.ask = { timeout: 0 };
	// `bash.patterns` deny rules and `tools.approval` deny entries still block a call under yolo; a `prompt` entry still asks (the runner relays it).
	overlay.tools = Object.keys(toolApproval).length > 0 ? { approvalMode: "yolo", approval: toolApproval } : { approvalMode: "yolo" };
	// Under yolo omp returns a bash pattern's own `allow` before `tools.approval`, so a shipped allow rule would run
	// commands the policy gates; with bash set to prompt or deny the shipped allow rules are dropped.
	const bashGated = input.policy.toolApproval.bash === "prompt" || input.policy.toolApproval.bash === "deny";
	const shipped = input.configYamls.flatMap(fileBashPatterns).filter(rule => !(bashGated && rule.approval === "allow"));
	overlay.bash = { patterns: [...GIT_GUARD_PATTERNS, ...input.policy.bashPatterns, ...shipped] };
	if (!input.policy.fetch) overlay.fetch = { enabled: false };
	if (!input.policy.webSearch) overlay.web_search = { enabled: false };
	if (!input.policy.browser) overlay.browser = { enabled: false };
	overlay.computer = { enabled: false };
	if (input.maskSecrets) overlay.secrets = { enabled: true };
	overlay.collab = { autoStart: "off" };
	// Cloud agents carry no memory: nothing of the laptop's is shipped, and nothing a VM would learn comes back.
	overlay.memory = { backend: "off" };
	overlay.marketplace = { autoUpdate: "off" };
	// The first request after a long pause can fail with ECONNRESET on a stale keep-alive connection to the gateway: omp's own retry covers it.
	overlay.retry = { enabled: true };
	return Bun.YAML.stringify(overlay, null, 2);
}

/** Seconds as Go's `time.Duration` prints them with zero minute and second tails trimmed: `30m`, `1h`, `1h30m`, `45s`. */
export function formatDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	let text = `${seconds}s`;
	if (hours > 0) text = `${hours}h${minutes}m${seconds}s`;
	else if (minutes > 0) text = `${minutes}m${seconds}s`;
	if (text.endsWith("m0s")) text = text.slice(0, -2);
	if (text.endsWith("h0m")) text = text.slice(0, -2);
	return text;
}

/** The "Running in the cloud" section appended to omp's system prompt. */
export function cloudSystemPrompt(input: {
	repoName: string;
	branch: string;
	localBranch: string;
	questionTimeoutSeconds: number;
	secretFiles: string[];
	/** The names of the MCP servers the thread ships; none for an empty list. */
	mcpServers: string[];
	/** The IRC id of the thread's parent in the VM (`runner/irc.ts` `PARENT_AGENT_ID`). */
	parentId: string;
}): string {
	const based = input.localBranch === "" ? "" : `, based on ${input.localBranch}`;
	const wait =
		input.questionTimeoutSeconds > 0
			? `If nobody answers within ${formatDuration(input.questionTimeoutSeconds)} you get a note to proceed with your best judgment; `
			: "If nobody answers in time you get a note to proceed with your best judgment; ";
	const files = input.secretFiles.length > 0 ? input.secretFiles.join(", ") : "none";
	const lines = [
		"## Running in the cloud",
		`You continue this work as an omp cloud agent. The repository ${input.repoName} is checked out at ${VM_WORKSPACE} on branch ${input.branch}${based}.`,
		"- Work autonomously: nobody watches live. When a decision blocks the work, use the `ask` tool: the user may answer late, so settle everything the question does not block first. " +
			`${wait}say in your reply what you assumed. Do not ask about things you can decide yourself.`,
		"- Commit as you go with clear messages; anything uncommitted is committed for you when the turn ends. Never push and never add or change git remotes: those commands are blocked. " +
			`The service pushes ${input.branch} when the owner's policy allows it, and otherwise the user pulls the branch from the service.`,
		`- These files were shipped as secrets and must never be printed or committed: ${files}.`,
	];
	if (input.mcpServers.length > 0) {
		lines.push(`- MCP servers: ${input.mcpServers.join(", ")}; the http ones are reached through the service, never print their tokens.`);
	}
	lines.push(
		`- Your parent, the omp that started this thread, is the IRC peer \`${input.parentId}\`. Message it with \`write\` (\`path: "agent://${input.parentId}"\`) to report progress or to ask something that does not block you; it may answer later as an incoming IRC message. Other peers that message you appear under their own ids and are answered the same way. Questions a person must answer still go through \`ask\`.`,
	);
	return lines.join("\n");
}
