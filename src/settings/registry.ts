/**
 * The settings registry: every key an operator can change at run time, with its type, default, documentation and
 * validator. The store keeps only the values that differ from the default, so `service.json` stays bootstrap-only.
 */
import { DEFAULT_FEED, parseFeedSpec } from "../update/feed-spec";
import { OMP_UNITS } from "../update/omp-units";
import { isRecord } from "../guards";
import { THINKING_LEVELS } from "../store/types";

/** A rejected setting: unknown key or a value its validator refuses. The message names the key; the API serves it as a 400. */
export class SettingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingError";
	}
}

export type SettingType = "enum" | "string" | "string[]" | "number" | "bool" | "json";

export interface SettingDef<T> {
	/** Dotted path. No registered key is a path prefix of another, so a nested YAML file maps to keys unambiguously. */
	key: string;
	type: SettingType;
	default: T;
	doc: string;
	/** The allowed values of an `enum`. */
	choices?: readonly string[];
	/** The value `raw` (parsed JSON) stands for. Throws {@link SettingError} naming the key. */
	parse(raw: unknown): T;
	/** Present for a setting whose value may be a secret: the value as it is shown (the API, the audit, the export); the stored value is untouched. */
	redact?(value: T): T;
}

/** What the thread's pushed branch is named after. */
export const THREAD_PLACEHOLDER = "{thread}";

/** An id of the shape every thread id has: what a branch template is checked with. */
const SAMPLE_THREAD_ID = "aaaaaaaaaaaa";

/** Where a thread's result may be pushed to the remote. */
const PUSH_MODES = ["never", "ask", "auto"] as const;

/** Whether a thread's commits are re-signed by the service. */
const SIGN_MODES = ["off", "ssh"] as const;

/** Whether a push to GitHub opens a pull request, and in which state. */
const PR_MODES = ["off", "draft", "ready"] as const;

/** `Name <email>`: the committer of signed commits. */
const COMMITTER_PATTERN = /^[^<>\n]+ <[^<>\s]+@[^<>\s]+>$/;

/** How the service follows releases. */
const UPDATE_MODES = ["off", "notify", "auto"] as const;
const MAX_TOKEN_REFERENCE_CHARS = 500;

/** What a secret literal is shown as. */
export const REDACTED = "(set)";
/** The name of an environment variable (upper case, as such names are written): a reference, not a secret. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Whether an `update.token` value is the token itself: not empty, not a `!command` and not an environment variable's name. */
export function isSecretLiteral(value: string): boolean {
	return value !== "" && !value.startsWith("!") && !ENV_NAME_PATTERN.test(value);
}

const MAX_PROTECTED_PATTERNS = 100;

/** The packages the VM template carries unless `vm.packages` says otherwise. */
export const DEFAULT_VM_PACKAGES = ["build-essential", "python3", "python3-venv", "python3-pip", "nodejs", "npm", "unzip", "ripgrep"] as const;
const MAX_VM_PACKAGES = 200;
const VM_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const MAX_VM_SETUP_CHARS = 16384;

/** The most entries of any list or record setting. */
const MAX_ENTRIES = 100;

/** What the agent does with a tool call the policy names: run it, refuse it, or ask the owner first. */
export const APPROVALS = ["allow", "deny", "prompt"] as const;

export type Approval = (typeof APPROVALS)[number];

/** One `policy.bash.patterns` rule: `match` is a glob (`*` matches any run of characters) over the command text. */
export interface BashPattern {
	match: string;
	approval: Approval;
}

/** The most characters of a bash pattern's `match`. */
const MAX_MATCH_CHARS = 500;

/** The largest value of a spend cap, in USD. */
const MAX_SPEND_USD = 1e6;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}(/(3[0-2]|[12]?[0-9]))?$`);
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MODEL_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An allowed outbound destination: an IPv4 address or CIDR, or a domain optionally prefixed `*.`. Returns it lowercased, or null. */
function egressEntry(raw: string): string | null {
	const entry = raw.toLowerCase();
	if (IPV4.test(entry)) return entry;
	const name = entry.startsWith("*.") ? entry.slice(2) : entry;
	const labels = name.split(".");
	if (name.length > 253 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
	// A top-level label with no letter is a malformed address, not a name.
	return /[a-z]/.test(labels[labels.length - 1] ?? "") ? entry : null;
}

/**
 * Whether `model` (`provider/id`, optionally with a `:<thinking>` suffix) is named by `allowed`: an exact `provider/id`
 * (with or without the suffix) or a `provider/*` pattern. An empty list allows every model.
 */
export function modelAllowed(allowed: readonly string[], model: string): boolean {
	if (allowed.length === 0) return true;
	const colon = model.lastIndexOf(":");
	const bare = colon >= 0 && (THINKING_LEVELS as readonly string[]).includes(model.slice(colon + 1)) ? model.slice(0, colon) : model;
	return allowed.some((pattern) => (pattern.endsWith("/*") ? model.startsWith(pattern.slice(0, -1)) : pattern === model || pattern === bare));
}

function stringList(key: string, raw: unknown): string[] {
	if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === "string")) {
		throw new SettingError(`${key} must be a list of strings`);
	}
	if (raw.length > MAX_ENTRIES) throw new SettingError(`${key} holds at most ${MAX_ENTRIES} entries`);
	return raw;
}

function toggle(key: string, raw: unknown): boolean {
	if (typeof raw !== "boolean") throw new SettingError(`${key} must be true or false`);
	return raw;
}

function spendCap(key: string, raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_SPEND_USD) {
		throw new SettingError(`${key} must be a number from 0 to ${MAX_SPEND_USD} (USD; 0 means no cap)`);
	}
	return raw;
}

/** The typed value of every registered key. */
export interface SettingValues {
	/** `never`: results stay in the service; `ask`: the owner approves each push; `auto`: push at the end of a turn. */
	"git.push": (typeof PUSH_MODES)[number];
	/** The pushed branch's name, `{thread}` standing for the thread id. */
	"git.branch": string;
	/** `off`: commits stay as the VM made them; `ssh`: the service re-signs each turn's commits with its SSH key. */
	"git.sign": (typeof SIGN_MODES)[number];
	/** `Name <email>` of the committer of signed commits; "" falls back to the GitHub App owner's noreply address. */
	"git.committer": string;
	/** `off`: no pull request; `draft` or `ready`: open one after a push to a github.com repository the App is installed on. */
	"git.pr": (typeof PR_MODES)[number];
	/** Globs (`*` matches any run of characters) of branches a push never writes to. */
	"git.protected": readonly string[];
	/** `policy.bash.patterns`: the order is the rules' order. The first rule that applies wins, so put the strictest first. */
	"policy.bash.patterns": readonly BashPattern[];
	/** Tool name to what the agent does when it calls the tool. */
	"policy.tools.approval": Readonly<Record<string, Approval>>;
	/** `false` turns off the agent's URL reading and the fetch tool. */
	"policy.fetch": boolean;
	/** `false` removes the agent's web search tool. */
	"policy.webSearch": boolean;
	/** `false` turns off the agent's browser. */
	"policy.browser": boolean;
	/** The destinations the VM may reach besides the service; empty leaves the network open. */
	"policy.egress": readonly string[];
	/** The most one turn may cost, in USD; 0 is no cap. */
	"policy.spend.turnUSD": number;
	/** The most all of a thread's turns may cost, in USD; 0 is no cap. */
	"policy.spend.threadUSD": number;
	/** The most the owner's turns may cost since 00:00 UTC, in USD; 0 is no cap. */
	"policy.spend.dayUSD": number;
	/** `provider/*` or `provider/id` patterns of the models a thread may use; empty allows any. */
	"policy.models.allowed": readonly string[];
	/** Days without activity before an idle thread's VM is released; 0 never archives. */
	"lifecycle.archiveAfterDays": number;
	/** `off`: never checks by itself; `notify`: checks and downloads, the owner installs; `auto`: also installs when that is safe. */
	"update.mode": (typeof UPDATE_MODES)[number];
	/** `github:<owner>/<repo>` or an http(s) base URL. */
	"update.feed": string;
	/** The feed credential: a `!command`, an environment variable name or the token; "" for none. */
	"update.token": string;
	/** The service's systemd user unit. */
	"update.unit": string;
	/** The units the update's omp step checks and restarts; empty skips the step. */
	"update.ompUnits": readonly string[];
	/** The Debian packages of the VM template besides the runner's own. */
	"vm.packages": readonly string[];
	/** Shell lines run as root when the VM template is built. */
	"vm.setup": readonly string[];
}

export type SettingKey = keyof SettingValues;

/**
 * Why `name` is not a valid branch name, or null. The rules of `git check-ref-format --branch`: no empty or dot-led or
 * `.lock`-ended component, no `..`, `@{`, control character, space or any of `~^:?*[\`, no leading `-`, no leading,
 * trailing or doubled `/`, no trailing `.`, and not `@` or `HEAD`.
 */
export function branchNameProblem(name: string): string | null {
	if (name === "" || name === "@" || name === "HEAD") return "is reserved or empty";
	if (name.startsWith("-")) return "starts with -";
	if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return "has a space, control or special character";
	if (name.includes("..") || name.includes("@{")) return "has .. or @{";
	if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return "has an empty path component";
	if (name.endsWith(".")) return "ends with .";
	for (const component of name.split("/")) {
		if (component.startsWith(".")) return "has a component starting with .";
		if (component.endsWith(".lock")) return "has a component ending with .lock";
	}
	return null;
}

type Registry = { [K in SettingKey]: SettingDef<SettingValues[K]> };

export const REGISTRY: Registry = {
	"git.push": {
		key: "git.push",
		type: "enum",
		default: "never",
		doc: "Whether a thread's result branch is pushed to its remote: never, only after the owner approves, or automatically.",
		choices: PUSH_MODES,
		parse(raw) {
			const mode = PUSH_MODES.find((choice) => choice === raw);
			if (mode === undefined) throw new SettingError(`git.push must be one of ${PUSH_MODES.join(", ")}`);
			return mode;
		},
	},
	"git.branch": {
		key: "git.branch",
		type: "string",
		default: `omp-cloud/${THREAD_PLACEHOLDER}`,
		doc: `The name of the pushed branch. ${THREAD_PLACEHOLDER} stands for the thread id and must appear; no other {…} is allowed.`,
		parse(raw) {
			if (typeof raw !== "string") throw new SettingError("git.branch must be a string");
			const parts = raw.split(THREAD_PLACEHOLDER);
			if (parts.length < 2) throw new SettingError(`git.branch must contain ${THREAD_PLACEHOLDER}`);
			if (parts.some((part) => part.includes("{") || part.includes("}"))) {
				throw new SettingError(`git.branch may only use the ${THREAD_PLACEHOLDER} placeholder`);
			}
			const problem = branchNameProblem(parts.join(SAMPLE_THREAD_ID));
			if (problem !== null) throw new SettingError(`git.branch ${JSON.stringify(raw)} is not a valid branch name: it ${problem}`);
			return raw;
		},
	},
	"git.protected": {
		key: "git.protected",
		type: "string[]",
		default: ["main", "master", "develop", "release/*"],
		doc: "Branches a push never writes to, as globs where * matches any run of characters.",
		parse(raw) {
			if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === "string")) {
				throw new SettingError("git.protected must be a list of strings");
			}
			if (raw.length > MAX_PROTECTED_PATTERNS) {
				throw new SettingError(`git.protected holds at most ${MAX_PROTECTED_PATTERNS} patterns`);
			}
			for (const pattern of raw) {
				if (pattern === "" || /[\s\u0000-\u001f\u007f]/.test(pattern)) {
					throw new SettingError(`git.protected patterns must be non-empty without whitespace: ${JSON.stringify(pattern)}`);
				}
			}
			return [...raw];
		},
	},
	"git.sign": {
		key: "git.sign",
		type: "enum",
		default: "off",
		doc: "Sign the commits a thread makes with the service's SSH signing key. Create it on the dashboard's GitHub page and add the public key to GitHub as a Signing Key.",
		choices: SIGN_MODES,
		parse(raw) {
			const mode = SIGN_MODES.find((choice) => choice === raw);
			if (mode === undefined) throw new SettingError(`git.sign must be one of ${SIGN_MODES.join(", ")}`);
			return mode;
		},
	},
	"git.committer": {
		key: "git.committer",
		type: "string",
		default: "",
		doc: "The committer of signed commits as Name <email>. GitHub shows Verified only when this email is verified on the account holding the key. Empty uses the GitHub App owner's noreply address, else each commit's committer.",
		parse(raw) {
			if (typeof raw !== "string" || (raw !== "" && !COMMITTER_PATTERN.test(raw))) {
				throw new SettingError('git.committer must be empty or "Name <email>"');
			}
			return raw;
		},
	},
	"git.pr": {
		key: "git.pr",
		type: "enum",
		default: "draft",
		doc: "After a push to a github.com repository the GitHub App is installed on, open a pull request into the thread's base branch and keep its omp-cloud section current; off opens none.",
		choices: PR_MODES,
		parse(raw) {
			const mode = PR_MODES.find((choice) => choice === raw);
			if (mode === undefined) throw new SettingError(`git.pr must be one of ${PR_MODES.join(", ")}`);
			return mode;
		},
	},
	"policy.bash.patterns": {
		key: "policy.bash.patterns",
		type: "json",
		default: [],
		doc: `Rules over the agent's bash commands: a list of {match, approval}, match a glob (* matches any run of characters, tried on the whole command and on each shell segment of it) and approval allow, deny or prompt (the owner is asked). The first rule that applies wins. Globs see the literal command text, so they guard and do not enclose. At most ${MAX_ENTRIES} rules.`,
		parse(raw) {
			if (!Array.isArray(raw)) throw new SettingError("policy.bash.patterns must be a list of {match, approval}");
			if (raw.length > MAX_ENTRIES) throw new SettingError(`policy.bash.patterns holds at most ${MAX_ENTRIES} rules`);
			return raw.map((item, index): BashPattern => {
				const at = `policy.bash.patterns[${index}]`;
				if (!isRecord(item) || Object.keys(item).some((name) => name !== "match" && name !== "approval")) {
					throw new SettingError(`${at} must be {match, approval}`);
				}
				const { match, approval } = item;
				if (typeof match !== "string" || match === "" || match.length > MAX_MATCH_CHARS || /[\u0000-\u001f\u007f]/.test(match)) {
					throw new SettingError(`${at}.match must be 1 to ${MAX_MATCH_CHARS} characters without control characters`);
				}
				const checked = APPROVALS.find((choice) => choice === approval);
				if (checked === undefined) throw new SettingError(`${at}.approval must be one of ${APPROVALS.join(", ")}`);
				return { match, approval: checked };
			});
		},
	},
	"policy.tools.approval": {
		key: "policy.tools.approval",
		type: "json",
		default: {},
		doc: `What the agent does when it calls a tool: a mapping of tool name to allow, deny or prompt (the owner is asked). The tool names are omp's, such as eval or write. At most ${MAX_ENTRIES} tools.`,
		parse(raw) {
			if (!isRecord(raw)) throw new SettingError("policy.tools.approval must be a mapping of tool name to allow, deny or prompt");
			const entries = Object.entries(raw);
			if (entries.length > MAX_ENTRIES) throw new SettingError(`policy.tools.approval holds at most ${MAX_ENTRIES} tools`);
			const tools: Record<string, Approval> = {};
			for (const [tool, approval] of entries) {
				if (!TOOL_NAME.test(tool)) {
					throw new SettingError(`policy.tools.approval tool names look like ${TOOL_NAME.source}: ${JSON.stringify(tool)}`);
				}
				const checked = APPROVALS.find((choice) => choice === approval);
				if (checked === undefined) throw new SettingError(`policy.tools.approval.${tool} must be one of ${APPROVALS.join(", ")}`);
				tools[tool] = checked;
			}
			return tools;
		},
	},
	"policy.fetch": {
		key: "policy.fetch",
		type: "bool",
		default: true,
		doc: "Whether the agent may read URLs and use the fetch tool. false turns both off; a shell command such as curl is limited by policy.egress only.",
		parse: (raw) => toggle("policy.fetch", raw),
	},
	"policy.webSearch": {
		key: "policy.webSearch",
		type: "bool",
		default: true,
		doc: "Whether the agent has the web search tool.",
		parse: (raw) => toggle("policy.webSearch", raw),
	},
	"policy.browser": {
		key: "policy.browser",
		type: "bool",
		default: true,
		doc: "Whether the agent may drive a browser from its eval tool.",
		parse: (raw) => toggle("policy.browser", raw),
	},
	"policy.egress": {
		key: "policy.egress",
		type: "string[]",
		default: [],
		doc: `The destinations a new VM may reach besides the service: IPv4 addresses or CIDRs, or domains optionally prefixed *. . Empty leaves the network open. Applies to VMs created after the change; a VM keeps its network for life. At most ${MAX_ENTRIES} entries.`,
		parse(raw) {
			return stringList("policy.egress", raw).map((item) => {
				const entry = egressEntry(item);
				if (entry === null) throw new SettingError(`policy.egress entries are IPv4 addresses, CIDRs or domains: ${JSON.stringify(item)}`);
				return entry;
			});
		},
	},
	"policy.spend.turnUSD": {
		key: "policy.spend.turnUSD",
		type: "number",
		default: 0,
		doc: "The most one turn may cost, in USD. A turn over it is aborted and fails. 0 is no cap.",
		parse: (raw) => spendCap("policy.spend.turnUSD", raw),
	},
	"policy.spend.threadUSD": {
		key: "policy.spend.threadUSD",
		type: "number",
		default: 0,
		doc: "The most all of a thread's turns may cost together, in USD. 0 is no cap.",
		parse: (raw) => spendCap("policy.spend.threadUSD", raw),
	},
	"policy.spend.dayUSD": {
		key: "policy.spend.dayUSD",
		type: "number",
		default: 0,
		doc: "The most the owner's turns may cost together since 00:00 UTC, in USD. 0 is no cap.",
		parse: (raw) => spendCap("policy.spend.dayUSD", raw),
	},
	"policy.models.allowed": {
		key: "policy.models.allowed",
		type: "string[]",
		default: [],
		doc: `The models a new thread may use, as provider/* or provider/id patterns. Empty allows any. At most ${MAX_ENTRIES} entries.`,
		parse(raw) {
			return stringList("policy.models.allowed", raw).map((item) => {
				const slash = item.indexOf("/");
				const id = item.slice(slash + 1);
				if (slash < 1 || !MODEL_PROVIDER.test(item.slice(0, slash)) || id === "" || (id.includes("*") && id !== "*") || /[\s\u0000-\u001f\u007f]/.test(id)) {
					throw new SettingError(`policy.models.allowed entries are provider/* or provider/id: ${JSON.stringify(item)}`);
				}
				return item;
			});
		},
	},
	"vm.packages": {
		key: "vm.packages",
		type: "string[]",
		default: [...DEFAULT_VM_PACKAGES],
		doc: `The Debian packages installed in the VM template, besides the ones the runner needs (ca-certificates, curl, git, jq, procps). Changing the list builds a new template on the next thread. Each entry is a package name; at most ${MAX_VM_PACKAGES} entries.`,
		parse(raw) {
			if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === "string")) {
				throw new SettingError("vm.packages must be a list of strings");
			}
			if (raw.length > MAX_VM_PACKAGES) throw new SettingError(`vm.packages holds at most ${MAX_VM_PACKAGES} entries`);
			for (const name of raw) {
				if (!VM_PACKAGE_PATTERN.test(name)) {
					throw new SettingError(`vm.packages entries are Debian package names (lower case letters, digits and + . -): ${JSON.stringify(name.slice(0, 50))}`);
				}
			}
			return raw;
		},
	},
	"vm.setup": {
		key: "vm.setup",
		type: "string[]",
		default: [],
		doc: `Shell lines run as root when the VM template is built, after the packages and omp are installed (for example usermod -aG docker user). The lines run under set -eux; changing them builds a new template on the next thread. At most ${MAX_VM_SETUP_CHARS} characters in all.`,
		parse(raw) {
			if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === "string")) {
				throw new SettingError("vm.setup must be a list of strings (shell lines)");
			}
			if (raw.reduce((sum, line) => sum + line.length + 1, 0) > MAX_VM_SETUP_CHARS) {
				throw new SettingError(`vm.setup holds at most ${MAX_VM_SETUP_CHARS} characters in all`);
			}
			return raw;
		},
	},
	"lifecycle.archiveAfterDays": {
		key: "lifecycle.archiveAfterDays",
		type: "number",
		default: 7,
		doc: "Days without activity before an idle thread's VM is released. Its conversation and work are kept, and the next message restores them. 0 never archives.",
		parse(raw) {
			if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
				throw new SettingError("lifecycle.archiveAfterDays must be a number of days, 0 or more (0 never archives)");
			}
			return raw;
		},
	},
	"update.mode": {
		key: "update.mode",
		type: "enum",
		default: "notify",
		doc: "How the service follows omp-cloud releases. off: never checks by itself. notify: checks hourly and downloads in the background, you install with one click. auto: also installs by itself, but only when that is safe with no downtime (no thread working for 10 minutes, the same vibemon and database schema); otherwise it waits for your click.",
		choices: UPDATE_MODES,
		parse(raw) {
			const mode = UPDATE_MODES.find((choice) => choice === raw);
			if (mode === undefined) throw new SettingError(`update.mode must be one of ${UPDATE_MODES.join(", ")}`);
			return mode;
		},
	},
	"update.feed": {
		key: "update.feed",
		type: "string",
		default: DEFAULT_FEED,
		doc: "Where releases come from: github:<owner>/<repo> (its latest GitHub release) or an http(s) base URL that serves release.json and the files (self-hosting, tests).",
		parse(raw) {
			if (typeof raw !== "string") throw new SettingError("update.feed must be a string");
			try {
				parseFeedSpec(raw);
			} catch (error) {
				throw new SettingError(error instanceof Error ? error.message : String(error));
			}
			return raw;
		},
	},
	"update.token": {
		key: "update.token",
		type: "string",
		default: "",
		doc: "The credential the feed is read with, needed for a private repository or fork: a !command whose output is the token (for example !/usr/bin/gh auth token), the name of an environment variable of the service, or the token itself (it is then stored in the clear in the database and read back as (set); prefer a !command). Empty reads the feed anonymously.",
		parse(raw) {
			if (typeof raw !== "string" || raw.length > MAX_TOKEN_REFERENCE_CHARS || /[\u0000-\u001f\u007f]/.test(raw)) {
				throw new SettingError(`update.token must be a string of at most ${MAX_TOKEN_REFERENCE_CHARS} characters without control characters`);
			}
			return raw.trim();
		},
		redact: (value) => (isSecretLiteral(value) ? REDACTED : value),
	},
	"update.unit": {
		key: "update.unit",
		type: "string",
		default: "omp-cloud",
		doc: "The name of the service's systemd user unit: what an update restarts.",
		parse(raw) {
			if (typeof raw !== "string" || !/^[A-Za-z0-9:_.@-]{1,100}$/.test(raw)) {
				throw new SettingError("update.unit must be a unit name of letters, digits and : _ . @ -");
			}
			return raw;
		},
	},
	"update.ompUnits": {
		key: "update.ompUnits",
		type: "string[]",
		default: [...OMP_UNITS],
		doc: "The systemd user units that run omp for the service (the auth broker and gateway): an update restarts the ones running another omp than the host's. An empty list skips that step. At most 100 units.",
		parse(raw) {
			return stringList("update.ompUnits", raw).map((unit) => {
				if (!/^[A-Za-z0-9:_.@-]{1,100}$/.test(unit)) throw new SettingError(`update.ompUnits entries are unit names of letters, digits and : _ . @ -: ${JSON.stringify(unit.slice(0, 50))}`);
				return unit;
			});
		},
	},
};

/** The definitions in registry order. */
export const SETTING_DEFS: readonly SettingDef<unknown>[] = Object.values(REGISTRY);

export function isSettingKey(key: string): key is SettingKey {
	return Object.hasOwn(REGISTRY, key);
}
